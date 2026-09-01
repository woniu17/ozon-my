// Ozon FBS 订单同步服务(2026-08,订单处理)
// 设计文档 §6:双接口增量同步,upsert by (store_id, posting_number)
//   1) /v4/posting/fbs/unfulfilled/list — 未妥投全集(含 delivering),cutoff 窗口 [now-14d, now+14d]
//   2) /v4/posting/fbs/list — 近 60 天下单全集(含 delivered/cancelled 终态,校准包裹状态)
// 新增手动单接口全量同步(2026-09):runSyncAllList 仅调 /v4/posting/fbs/list
//   - 支持快捷 sinceDays(今天/7天/30天/90天) 或自定义 since/to 时间段
//   - 用于历史回补/状态校准,覆盖所有状态含 delivered/cancelled 终态
// 状态联动:DAO applyOzonStatus(只前进;cancelled 任意时刻可进)
//
// 调度:启动 10s 后首跑,此后每 ORDER_SYNC_INTERVAL_MIN(默认 5)分钟;
// 手动触发 POST /admin/api/order-process/sync-run(增量,与定时互斥)
//          POST /admin/api/order-process/sync-all-list(全量,仅list)
// 进度查询 GET  /admin/api/order-process/sync-progress
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { postingFbsUnfulfilledList, postingFbsList, productInfoListV3 } from './ozon-opi.js';
import { orderPackageDao, setStoreNameMap } from '../db/dao/sqlite/order-daos.js';
import { db } from '../db/index.js';

const INTERVAL_MIN = Math.max(1, Number(process.env.ORDER_SYNC_INTERVAL_MIN) || 5);
const FIRST_DELAY_MS = 10_000;
const MAX_PAGES = 50; // 单接口单店铺翻页上限(防失控)

let timer = null;
let syncing = false;

// ── 进度机制(模块级状态,前端轮询 GET /sync-progress 读取)─────
// active=true 同步进行中;active=false 但 finishedAt 有值=已结束待用户关闭
// 前端检测 finishedAt 决定是否显示"已完成"进度条 + 关闭按钮
// failures[] 记录每个失败店铺的详情(便于前端展开查看错误原因)
const progress = {
  active: false,
  type: '',               // 'incremental' | 'all-list'
  totalStores: 0,         // 待处理店铺总数
  doneStores: 0,           // 已完成店铺数
  currentStoreId: '',
  currentStoreName: '',
  currentPhase: '',        // 'unfulfilled' | 'list' | 'cache-backfill'(增量模式阶段)
  currentPage: 0,          // 当前店铺当前接口的页码(从0计)
  postingsPulled: 0,       // 累计已拉取订单数
  startedAt: null,        // ISOString
  elapsedMs: 0,           // 已用毫秒(实时刷新)
  message: '',            // 人类可读文案
  finishedAt: null,        // ISOString 完成时间(null=未结束)
  errorCount: 0,           // 失败店铺数(便于前端提示)
  failures: [],            // [{ storeId, storeName, phase, page, error, status, body }] 失败详情
};

function resetProgress(type, totalStores) {
  progress.active = true;
  progress.type = type;
  progress.totalStores = totalStores;
  progress.doneStores = 0;
  progress.currentStoreId = '';
  progress.currentStoreName = '';
  progress.currentPhase = '';
  progress.currentPage = 0;
  progress.postingsPulled = 0;
  progress.startedAt = new Date().toISOString();
  progress.elapsedMs = 0;
  progress.finishedAt = null;
  progress.errorCount = 0;
  progress.failures = [];
  progress.message = totalStores > 0 ? `准备同步 ${totalStores} 个店铺` : '初始化中';
}

// 记录失败店铺详情到 progress.failures(便于前端展示错误原因)
function recordFailure(store, errInfo) {
  progress.failures.push({
    storeId: store?.id || '',
    storeName: store?.name || store?.id || '',
    phase: progress.currentPhase || '',
    page: progress.currentPage || 0,
    ...errInfo,
  });
}

function tickElapsed() {
  if (progress.active && progress.startedAt) {
    progress.elapsedMs = Date.now() - new Date(progress.startedAt).getTime();
  }
}

export function getSyncProgress() {
  tickElapsed();
  return { ...progress, syncing };
}

// 前端用户点击"关闭"按钮调用,清空已完成进度数据
// 仅在 active=false 时可清空(同步进行中不允许清空)
export function clearSyncProgress() {
  if (progress.active) return { cleared: false, reason: '同步进行中,无法清空' };
  progress.type = '';
  progress.totalStores = 0;
  progress.doneStores = 0;
  progress.currentStoreId = '';
  progress.currentStoreName = '';
  progress.currentPhase = '';
  progress.currentPage = 0;
  progress.postingsPulled = 0;
  progress.startedAt = null;
  progress.elapsedMs = 0;
  progress.finishedAt = null;
  progress.errorCount = 0;
  progress.failures = [];
  progress.message = '';
  return { cleared: true };
}

export function isSyncing() {
  return syncing;
}

// v4 响应兼容:{ result: { postings, cursor, has_next } } 或顶层直接返回
function extractResult(resp) {
  if (!resp) return null;
  if (Array.isArray(resp?.result?.postings)) return resp.result;
  if (Array.isArray(resp?.postings)) return resp;
  return null;
}

function iso(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// 分页拉取一个接口,逐 posting 回调;实时更新 progress.currentPage/postingsPulled
// phase: 'unfulfilled' | 'list'(用于进度展示当前阶段)
async function fetchAll(store, fn, onPage, phase) {
  let cursor;
  let total = 0;
  if (progress.active) {
    progress.currentPhase = phase || '';
    progress.currentPage = 0;
  }
  for (let page = 0; page < MAX_PAGES; page++) {
    if (progress.active) progress.currentPage = page;
    const resp = await fn(cursor);
    const r = extractResult(resp);
    if (!r) break;
    for (const p of r.postings || []) {
      onPage(p);
      total++;
    }
    if (progress.active) progress.postingsPulled += (r.postings || []).length;
    if (!r.has_next || !r.cursor) break;
    cursor = r.cursor;
  }
  return total;
}

// 回源未命中商品缓存的订单 SKU(图片/标题来自 product_data_cache,MISS 时按需拉取)
// 复用 admin.js 商品同步的 upsert 语义(ON CONFLICT 保留 description_quality)
const INFO_BATCH = 300;

async function backfillProductCache(store) {
  const skus = orderPackageDao.findUncachedSkus(store.id);
  if (!skus.length) return 0;
  const upsert = db.prepare(
    `INSERT INTO product_data_cache (sku, data, store_id, fetched_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(sku) DO UPDATE SET data=excluded.data, store_id=excluded.store_id, fetched_at=excluded.fetched_at`
  );
  let filled = 0;
  for (let i = 0; i < skus.length; i += INFO_BATCH) {
    const batch = skus.slice(i, i + INFO_BATCH);
    try {
      const resp = await productInfoListV3(store, { skus: batch });
      const items = resp?.result?.items || resp?.items || [];
      for (const it of items) {
        if (!it?.sku) continue;
        upsert.run(String(it.sku), JSON.stringify(it), store.id);
        filled++;
      }
    } catch (e) {
      logger.warn({ storeId: store.id, err: e?.message }, '[order-sync] 商品缓存回源批次失败,跳过');
    }
  }
  if (filled > 0) {
    logger.info({ storeId: store.id, filled, missed: skus.length }, '[order-sync] 商品缓存回源完成');
  }
  return filled;
}

async function syncStore(store) {
  // 增量同步窗口(2026-09 调整):
  //   unfulfilled cutoff [now-14d, now+14d] —— 未妥投全集聚焦近14天备货
  //   list since/to  [now-60d, now]         —— 近60天下单全集(补 delivered/cancelled 终态)
  const now = new Date();
  const since14 = iso(new Date(now.getTime() - 14 * 86400_000));
  const to14 = iso(new Date(now.getTime() + 14 * 86400_000));
  const since60 = iso(new Date(now.getTime() - 60 * 86400_000));

  let count = 0;

  // 1) 未妥投全集
  count += await fetchAll(store, (cursor) =>
    postingFbsUnfulfilledList(store, { cutoffFrom: since14, cutoffTo: to14, cursor })
  , (p) => orderPackageDao.syncPosting(store.id, p), 'unfulfilled');

  // 2) 近 60 天下单全集(补终态:delivered/cancelled)
  count += await fetchAll(store, (cursor) =>
    postingFbsList(store, { since: since60, to: iso(now), cursor })
  , (p) => orderPackageDao.syncPosting(store.id, p), 'list');

  // 3) 订单 SKU 未命中商品缓存的回源(图片/完整标题)
  if (progress.active) progress.currentPhase = 'cache-backfill';
  await backfillProductCache(store);

  orderPackageDao.updateSyncCursor(store.id, { count });
  return count;
}

// 单接口全量同步(/v4/posting/fbs/list)——历史回补/状态校准
// options:
//   - sinceDays: number  快捷天数(1/7/30/90/365),后端据此计算 since
//   - since/to: ISOString  自定义起止时间(优先级高于 sinceDays)
// 注:仅调 list 接口,覆盖所有状态含 delivered/cancelled 终态
export async function runSyncAllList({ sinceDays, since, to } = {}) {
  if (syncing) return { skipped: true, reason: '同步已在进行中' };
  syncing = true;
  const started = Date.now();
  const now = new Date();

  // 解析时间窗口:since/to 优先,否则按 sinceDays 计算
  let sinceIso, toIso;
  if (since && to) {
    sinceIso = since;
    toIso = to;
  } else {
    const days = Math.min(Math.max(Number(sinceDays) || 30, 1), 365);
    sinceIso = iso(new Date(now.getTime() - days * 86400_000));
    toIso = iso(now);
  }

  const stores = config.loadStores() || [];
  setStoreNameMap(new Map(stores.map((s) => [s.id, s.name || s.id])));
  const eligible = stores.filter((s) => s?.sync_credentials?.clientId);
  resetProgress('all-list', eligible.length);
  progress.message = `准备同步 ${eligible.length} 个店铺(范围 ${sinceIso} ~ ${toIso})`;

  const results = [];
  for (const store of eligible) {
    progress.currentStoreId = store.id;
    progress.currentStoreName = store.name || store.id;
    progress.currentPhase = 'list';
    progress.message = `同步店铺 ${progress.currentStoreName} (${progress.doneStores + 1}/${eligible.length})`;
    try {
      const n = await fetchAll(store,
        (cursor) => postingFbsList(store, { since: sinceIso, to: toIso, cursor }),
        (p) => orderPackageDao.syncPosting(store.id, p), 'list'
      );
      results.push({ storeId: store.id, storeName: store.name, count: n, ok: true });
      logger.info({ storeId: store.id, count: n, since: sinceIso, to: toIso }, '[order-sync-all] 店铺同步完成');
      orderPackageDao.updateSyncCursor(store.id, { count: n });
    } catch (e) {
      orderPackageDao.updateSyncCursor(store.id, { error: e?.message || String(e) });
      results.push({ storeId: store.id, storeName: store.name, ok: false, error: e?.message || String(e) });
      progress.errorCount++;
      recordFailure(store, { error: e?.message || String(e), stack: e?.stack?.split('\n').slice(0, 3).join(' | ') });
      logger.warn({ storeId: store.id, err: e?.message, stack: e?.stack }, '[order-sync-all] 店铺同步失败');
    }
    progress.doneStores++;
  }
  // 完成:保留进度数据,置 active=false + finishedAt,等用户手动关闭
  progress.active = false;
  progress.finishedAt = new Date().toISOString();
  const errPart = progress.errorCount > 0 ? `,失败 ${progress.errorCount} 店` : '';
  progress.message = `完成 ${eligible.length} 个店铺,共拉取 ${progress.postingsPulled} 个订单${errPart}`;
  syncing = false;
  const durationMs = Date.now() - started;
  return { skipped: false, durationMs, stores: results, since: sinceIso, to: toIso };
}

/** 立即执行一轮全店铺增量同步(手动触发/定时共用;并发保护) */
export async function runOrderSyncNow() {
  if (syncing) {
    return { skipped: true, reason: '同步已在进行中' };
  }
  syncing = true;
  const started = Date.now();
  const stores = config.loadStores() || [];
  // 店铺名映射注入(DAO 列表展示用)
  setStoreNameMap(new Map(stores.map((s) => [s.id, s.name || s.id])));
  const eligible = stores.filter((s) => s?.sync_credentials?.clientId);
  resetProgress('incremental', eligible.length);
  progress.message = `准备增量同步 ${eligible.length} 个店铺`;
  const results = [];
  for (const store of eligible) {
    progress.currentStoreId = store.id;
    progress.currentStoreName = store.name || store.id;
    progress.message = `增量同步店铺 ${progress.currentStoreName} (${progress.doneStores + 1}/${eligible.length})`;
    try {
      const n = await syncStore(store);
      results.push({ storeId: store.id, storeName: store.name, count: n, ok: true });
      logger.info({ storeId: store.id, count: n }, '[order-sync] 店铺同步完成');
    } catch (e) {
      orderPackageDao.updateSyncCursor(store.id, { error: e?.message || String(e) });
      results.push({ storeId: store.id, storeName: store.name, ok: false, error: e?.message || String(e) });
      progress.errorCount++;
      recordFailure(store, { error: e?.message || String(e), stack: e?.stack?.split('\n').slice(0, 3).join(' | ') });
      logger.warn({ storeId: store.id, err: e?.message, stack: e?.stack }, '[order-sync] 店铺同步失败');
    }
    progress.doneStores++;
  }
  // 完成:保留进度数据,置 active=false + finishedAt,等用户手动关闭
  progress.active = false;
  progress.finishedAt = new Date().toISOString();
  const errPart = progress.errorCount > 0 ? `,失败 ${progress.errorCount} 店` : '';
  progress.message = `完成 ${eligible.length} 个店铺,共拉取 ${progress.postingsPulled} 个订单${errPart}`;
  syncing = false;
  const durationMs = Date.now() - started;
  return {
    skipped: false,
    durationMs,
    stores: results,
  };
}

export function startOrderSync() {
  if (timer) return;
  // 首跑前注入店铺名映射(定时轮次会刷新)
  const stores = config.loadStores() || [];
  setStoreNameMap(new Map(stores.map((s) => [s.id, s.name || s.id])));
  setTimeout(() => {
    runOrderSyncNow().catch((e) => logger.error({ err: e?.message }, '[order-sync] 首次同步异常'));
  }, FIRST_DELAY_MS).unref();
  timer = setInterval(
    () => runOrderSyncNow().catch((e) => logger.error({ err: e?.message }, '[order-sync] 定时同步异常')),
    INTERVAL_MIN * 60_000
  );
  logger.info({ intervalMin: INTERVAL_MIN }, '[order-sync] 订单同步调度已启动');
}

export function stopOrderSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[order-sync] 订单同步调度已停止');
  }
}
