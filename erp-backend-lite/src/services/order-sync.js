// Ozon FBS 订单同步服务(2026-08,订单处理)
// 设计文档 §6:双接口增量同步,upsert by (store_id, posting_number)
//   1) /v4/posting/fbs/unfulfilled/list — 未妥投全集(含 delivering),cutoff 窗口 [now-60d, now+14d]
//   2) /v4/posting/fbs/list — 近 30 天下单全集(含 delivered/cancelled 终态,校准包裹状态)
// 状态联动:DAO applyOzonStatus(只前进;cancelled 任意时刻可进)
//
// 调度:启动 10s 后首跑,此后每 ORDER_SYNC_INTERVAL_MIN(默认 5)分钟;
// 手动触发 POST /admin/api/order-process/sync-run(与定时互斥,同一时刻仅一个同步在跑)
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { postingFbsUnfulfilledList, postingFbsList } from './ozon-opi.js';
import { orderPackageDao, setStoreNameMap } from '../db/dao/sqlite/order-daos.js';

const INTERVAL_MIN = Math.max(1, Number(process.env.ORDER_SYNC_INTERVAL_MIN) || 5);
const FIRST_DELAY_MS = 10_000;
const MAX_PAGES = 50; // 单接口单店铺翻页上限(防失控)

let timer = null;
let syncing = false;

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

// 分页拉取一个接口,逐 posting 回调
async function fetchAll(store, fn, onPage) {
  let cursor;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await fn(cursor);
    const r = extractResult(resp);
    if (!r) break;
    for (const p of r.postings || []) {
      onPage(p);
      total++;
    }
    if (!r.has_next || !r.cursor) break;
    cursor = r.cursor;
  }
  return total;
}

async function syncStore(store) {
  const now = new Date();
  const since60 = iso(new Date(now.getTime() - 60 * 86400_000));
  const to14 = iso(new Date(now.getTime() + 14 * 86400_000));
  const since30 = iso(new Date(now.getTime() - 30 * 86400_000));

  let count = 0;

  // 1) 未妥投全集
  count += await fetchAll(store, (cursor) =>
    postingFbsUnfulfilledList(store, { cutoffFrom: since60, cutoffTo: to14, cursor })
  , (p) => orderPackageDao.syncPosting(store.id, p));

  // 2) 近 30 天下单全集(补终态:delivered/cancelled)
  count += await fetchAll(store, (cursor) =>
    postingFbsList(store, { since: since30, to: iso(now), cursor })
  , (p) => orderPackageDao.syncPosting(store.id, p));

  orderPackageDao.updateSyncCursor(store.id, { count });
  return count;
}

/** 立即执行一轮全店铺同步(手动触发/定时共用;并发保护) */
export async function runOrderSyncNow() {
  if (syncing) {
    return { skipped: true, reason: '同步已在进行中' };
  }
  syncing = true;
  const started = Date.now();
  const stores = config.loadStores() || [];
  // 店铺名映射注入(DAO 列表展示用)
  setStoreNameMap(new Map(stores.map((s) => [s.id, s.name || s.id])));
  const results = [];
  for (const store of stores) {
    if (!store?.sync_credentials?.clientId) continue;
    try {
      const n = await syncStore(store);
      results.push({ storeId: store.id, storeName: store.name, count: n, ok: true });
      logger.info({ storeId: store.id, count: n }, '[order-sync] 店铺同步完成');
    } catch (e) {
      orderPackageDao.updateSyncCursor(store.id, { error: e?.message || String(e) });
      results.push({ storeId: store.id, storeName: store.name, ok: false, error: e?.message || String(e) });
      logger.warn({ storeId: store.id, err: e?.message }, '[order-sync] 店铺同步失败');
    }
  }
  syncing = false;
  return {
    skipped: false,
    durationMs: Date.now() - started,
    stores: results,
  };
}

export function isSyncing() {
  return syncing;
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
