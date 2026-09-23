// Ozon FBS 订单同步服务(2026-08,订单处理)
// 设计文档 §6:双接口增量同步,upsert by (store_id, posting_number)
//   1) /v4/posting/fbs/unfulfilled/list — 未妥投全集(含 delivering),cutoff 窗口
//   2) /v4/posting/fbs/list — 按下单时间窗口的全集(含 delivered/cancelled 终态,校准包裹状态)
// 新增手动单接口全量同步(2026-09):runSyncAllList 仅调 /v4/posting/fbs/list
//   - 支持快捷 sinceDays(今天/7天/30天/90天) 或自定义 since/to 时间段
//   - 用于历史回补/状态校准,覆盖所有状态含 delivered/cancelled 终态
// 状态联动:DAO applyOzonStatus(只前进;cancelled 任意时刻可进)
//
// 调度(2026-09-16 三级节奏,共用 syncing 互斥):
//   fast  每 2 分钟:未完成订单(unfulfilled cutoff 未来 14 天窗口) + 应计 + 退货
//   mid   每 8 小时:近 90 天订单全集(list,补终态) + 应计 + 退货
//   slow  每 24 小时:近 365 天订单全集(list,全年兜底) + 应计 + 退货
// (2026-09-17 webhook 整合:fast 提频到 2 分钟且 cutoff 窗口不再回看;
//  已过 cutoff 的在途单状态由 STATE_CHANGED 推送秒级联动 + mid 轮 8 小时兜底)
// slow 轮耗时长,期间 fast 触发会 skipped(未完成订单延迟一档,可接受)
// 手动触发 POST /admin/api/order-process/sync-run(body.level 可选 fast|mid|slow,默认 fast)
//          POST /admin/api/order-process/sync-all-list(全量,仅list)
// 进度查询 GET  /admin/api/order-process/sync-progress
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { postingFbsUnfulfilledList, postingFbsList, postingFbsGet, productInfoListV3, financeAccrualPostings, financeAccrualTypes, rfbsReturnsList } from './ozon-opi.js';
import { orderPackageDao, setStoreNameMap } from '../db/dao/sqlite/order-daos.js';
import { getAccrualTypes, findPendingAccrualPostings, findBackfillAccrualPostings, findAccrualPostingsByPackageIds, replaceAccruals } from '../db/dao/sqlite/accrual-dao.js';
import { db } from '../db/index.js';
import { notifyPostingEvent, notifyPostingPickedUp } from './webhook/feishu-notify.js';
import { apiToPush, pushRankOf } from './webhook/status-map.js';

// ── 三级同步节奏(2026-09-16)─────────────────────────────────
const FAST_INTERVAL_MIN = Math.max(1, Number(process.env.ORDER_SYNC_INTERVAL_MIN) || 2); // fast 轮间隔(分钟,2026-09-17 5→2)
const MID_INTERVAL_MS = 8 * 3600_000;   // mid 轮间隔(8 小时)
const SLOW_INTERVAL_MS = 24 * 3600_000; // slow 轮间隔(24 小时)
const FIRST_DELAY_MS = 10_000;
const MAX_PAGES = 50; // 单接口单店铺翻页上限(防失控)
// 各级窗口:unfulfilledDays=未完成订单 cutoff 向前回看天数(null=跳过该接口,0=从 now 起);listDays=list 下单窗口天数(0=跳过);listHours=fast 轮近效 list 小时窗口(签收兜底用)
const SYNC_LEVELS = {
  // fast 回看 7 天 + 近 3h list(2026-09-21):unfulfilled cutoff [now-7d, now+14d]
  //   回看 7 天覆盖已过 cutoff 但未完成的订单(状态联动遗漏的滞后单);
  //   delivered 会离开 unfulfilled 列表,签收兜底通知需 fast 轮可见签收状态(2 分钟级)
  fast: { unfulfilledDays: 7, listHours: 3, listDays: 0, label: '2分钟·未完成订单(回看7天)+近3小时状态校准' },
  mid: { unfulfilledDays: null, listDays: 90, label: '8小时·近90天订单' },
  slow: { unfulfilledDays: null, listDays: 365, label: '24小时·近365天订单' },
};

// ── 应计同步参数(实测验证)─────────────────────────────────────
const ACCRUAL_BATCH = 200;        // 应计接口单批货件数(实测 200 可行)
const ACCRUAL_THROTTLE_MS = 300; // 批间节流(接口秒级限流 429 code=8)
const ACCRUAL_MAX_RETRY = 3;     // 429/网络错退避重试上限
const ACCRUAL_LIMIT_PER_ROUND = 400; // 每店铺每轮待拉上限(防单轮过载)

let fastTimer = null;
let midTimer = null;
let slowTimer = null;
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

/** 手动触发应计同步(路由层调用,与订单同步互不阻塞)
 *  mode: 'pending'(增量待拉,默认) | 'backfill'(存量回补,sinceDays 窗口)
 *       | 'packages'(单包裹刷新,packageIds)
 */
export async function runAccrualSync({ mode = 'pending', sinceDays, packageIds, storeId } = {}) {
  const stores = config.loadStores() || [];
  const eligible = (storeId ? stores.filter((s) => s.id === storeId) : stores)
    .filter((s) => s?.sync_credentials?.clientId);
  if (eligible.length === 0) return { stores: [], totalPackages: 0, totalAccrualRows: 0 };
  const results = [];
  let totalPackages = 0;
  let totalAccrualRows = 0;
  for (const store of eligible) {
    try {
      const r = await syncAccruals(store, { mode, sinceDays, packageIds });
      results.push({ storeId: store.id, storeName: store.name, ok: true, ...r });
      totalPackages += r.packages;
      totalAccrualRows += r.accrualRows;
    } catch (e) {
      results.push({ storeId: store.id, storeName: store.name, ok: false, error: e?.message || String(e) });
      logger.warn({ storeId: store.id, err: e?.message }, '[accrual-sync] 店铺应计同步失败');
    }
  }
  return { stores: results, totalPackages, totalAccrualRows };
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

// ── 飞书通知 API 兜底(2026-09-20)─────────────────────────────
// 背景:Ozon 检测服务响应不及时会停推 webhook(如 11:02 停推后新订单无通知)。
// 兜底:API 轮询同步落库后,对「webhook 链路未覆盖(ozon_postings 无记录)且未打标」
//       的近 7 天订单补发通知,覆盖:新订单/揽收/到达取货点/签收。
// 去重:op_ozon_order.feishu_*_notified_at 原子 claim(与 webhook 链路共用同一标记);
//       webhook 正常时 ozon_postings 有记录 → 跳过兜底,通知仍由 webhook 负责。
// 状态判定:v4 substatus 直接返回推送模型状态名(posting_received 等),
//       缺失时用 status 映射(apiToPush);揽收=rank2-3 非取货点,签收=rank4。
// 限频:模块级 promise chain 串行发送,避免触发飞书机器人频率限制。
// 失败:释放标记,下轮 fast 同步(2 分钟)自动重试。
const FEISHU_BACKFILL_MAX_AGE_DAYS = 7;
let _feishuNotifyChain = Promise.resolve();

/** 签收兜底取包裹 delivered_at(applyOzonStatus 写入:同步时刻/承诺送达窗口终点/退货时间三者取最小,2026-09-23) */
function lookupDeliveredAt(storeId, postingNumber) {
  try {
    const r = db
      .prepare(
        `SELECT p.delivered_at FROM op_package p
         JOIN op_ozon_order o ON o.id = p.ozon_order_id
         WHERE o.store_id = ? AND o.posting_number = ?`
      )
      .get(storeId, String(postingNumber || ''));
    return r?.delivered_at ?? null;
  } catch {
    return null;
  }
}

/** 通用兜底发送入队:claim 成功后串行发送,失败释放标记下轮重试 */
function enqueueFeishuBackfill(store, postingNumber, stateKey, cutoff, label, sender) {
  if (!orderPackageDao.claimFeishuNotify(store.id, postingNumber, cutoff, stateKey)) return;
  _feishuNotifyChain = _feishuNotifyChain.then(async () => {
    try {
      const ok = await sender();
      if (ok === false) {
        orderPackageDao.releaseFeishuNotify(store.id, postingNumber, stateKey);
        logger.warn({ storeId: store.id, postingNumber, stateKey }, `[order-sync] 飞书兜底通知(${label})发送失败,下轮同步重试`);
      } else {
        logger.info({ storeId: store.id, postingNumber, stateKey }, `[order-sync] 飞书兜底通知(${label})已补发`);
      }
    } catch (e) {
      orderPackageDao.releaseFeishuNotify(store.id, postingNumber, stateKey);
      logger.warn({ storeId: store.id, postingNumber, stateKey, err: e?.message }, `[order-sync] 飞书兜底通知(${label})异常,下轮同步重试`);
    }
  });
}

function maybeBackfillFeishuNotify(store, posting) {
  const postingNumber = posting?.posting_number;
  if (!postingNumber || !store?.company_id) return;
  // 2026-09-22 修复1:不再按"ozon_postings 有该货件"短路(那只代表历史曾收到 webhook,如下单时;
  // webhook 停推期间该短路会导致状态通知两边都不发)。双链路统一走 claim/mark DB 去重:
  // webhook 活着会先发先标记 → 兜底 claim 失败自动跳过;webhook 停推 → 兜底全权负责。
  // 2026-09-22 修复2:补发加 6h 状态变化窗口——存量老单的历史通知多由 webhook 发出过
  //   (claim 机制 9/20 上线未回填其标记),无窗口会整段重发造成轰炸。正常滞后为分钟级
  //   (fast 轮 2 分钟),6h 足够覆盖。
  const BACKFILL_WINDOW_MS = 6 * 3600_000;
  const now = Date.now();
  const inWindow = (t) => {
    const ms = Date.parse(t || '');
    return !!ms && now - ms <= BACKFILL_WINDOW_MS;
  };
  const cutoff = iso(new Date(now - FEISHU_BACKFILL_MAX_AGE_DAYS * 86400_000));
  const sellerId = Number(store.company_id);

  // 1) 新订单(TYPE_NEW_POSTING):API 轮询 posting 与 webhook OPI 回拉同源,补 seller_id 即可复用通知逻辑
  if (inWindow(posting.in_process_at)) {
    enqueueFeishuBackfill(store, postingNumber, 'new_order', cutoff, '新订单', () =>
      notifyPostingEvent('TYPE_NEW_POSTING', { ...posting, seller_id: sellerId })
    );
  }

  // 2) 状态通知:substatus 优先(v4 直接返回推送模型状态名),否则 status 映射
  const pushState = posting.substatus || apiToPush(posting.status);
  if (!pushState) return;
  const rank = pushRankOf(pushState);
  const base = {
    posting_number: postingNumber,
    seller_id: sellerId,
    changed_state_date: posting.delivering_date ?? null,
  };
  // 揽收(rank2-3,取货点单发):对齐 webhook isPickupLevelPush 语义,跳级到快递员等也按揽收通知
  if (rank >= 2 && rank <= 3 && pushState !== 'posting_in_pickup_point' && inWindow(posting.delivering_date)) {
    enqueueFeishuBackfill(store, postingNumber, 'pickup', cutoff, '揽收', () =>
      notifyPostingPickedUp({ ...base, new_state: pushState, old_state: null })
    );
  }
  // 到达取货点(2026-09-22 修复:此前用 delivering_date 判窗口,而到达取货点晚于揽收 1~3 天,
  // 必超 6h 窗 → 该分支从未发出过通知(pp 标记全库为 0 的根因)。
  // 现改用 pickup_point_at(首见取货点状态时刻,首次同步到时写)作为窗口时间源)
  if (pushState === 'posting_in_pickup_point') {
    let firstSeenAt = null;
    try {
      firstSeenAt = db
        .prepare(`SELECT pickup_point_at FROM op_ozon_order WHERE store_id = ? AND posting_number = ?`)
        .get(store.id, postingNumber)?.pickup_point_at ?? null;
      if (!firstSeenAt) {
        firstSeenAt = new Date().toISOString();
        db.prepare(`UPDATE op_ozon_order SET pickup_point_at = ? WHERE store_id = ? AND posting_number = ?`)
          .run(firstSeenAt, store.id, postingNumber);
      }
    } catch { /* 字段缺失/写入失败按当前时刻处理,不影响通知 */
      firstSeenAt = new Date().toISOString();
    }
    if (inWindow(firstSeenAt)) {
      enqueueFeishuBackfill(store, postingNumber, 'pickup_point', cutoff, '到达取货点', () =>
        notifyPostingEvent('TYPE_STATE_CHANGED', { ...base, changed_state_date: firstSeenAt, new_state: pushState })
      );
    }
  }
  // 签收(rank4;签收时间用 op_package.delivered_at,API 无签收时间戳)
  if (rank === 4) {
    const deliveredAt = lookupDeliveredAt(store.id, postingNumber);
    if (inWindow(deliveredAt)) {
      enqueueFeishuBackfill(store, postingNumber, 'received', cutoff, '签收', () =>
        notifyPostingEvent('TYPE_STATE_CHANGED', {
          ...base,
          changed_state_date: deliveredAt,
          new_state: pushState,
        })
      );
    }
  }
  // 3) 取消(2026-09-22 补,rank9 吸收态):v4 cancellation 对象无时间戳,不加状态变化窗口——
  //    防历史轰炸靠部署迁移(feishu_cancel_notified_at 列新增时存量 cancelled 单一律回填为已通知),
  //    之后 claim 成功的都是新变为取消的单,claim/mark 去重保证只发一次。
  //    发现延迟:fast 轮 listHours=3 覆盖"下单3h内取消"(买家取消多数在此),其余 mid 轮 8h 兜底。
  //    (2026-09-22 排查实证:07971311-1166-1 由 API 轮询发现取消但无任何通知,webhook 推送丢失)
  if (pushState === 'posting_canceled' || pushState === 'posting_not_in_sort_center') {
    enqueueFeishuBackfill(store, postingNumber, 'cancel', cutoff, '取消', () =>
      notifyPostingEvent('TYPE_POSTING_CANCELLED', {
        ...base,
        changed_state_date: null,
        new_state: pushState,
        reason: posting.cancellation?.cancel_reason
          ? { message: posting.cancellation.cancel_reason }
          : null,
      })
    );
  }
}

/** syncPosting 包装:落库后按需补发飞书通知(webhook 停推兜底) */
function syncPostingWithNotify(store, p) {
  const r = orderPackageDao.syncPosting(store.id, p);
  try {
    maybeBackfillFeishuNotify(store, p);
  } catch (e) {
    logger.warn({ storeId: store.id, err: e?.message }, '[order-sync] 飞书兜底通知检查失败(不影响同步)');
  }
  return r;
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
        // 2026-09 不同步归档商品:is_archived=true 跳过写入(与商品同步 runStoreSync 同语义)
        // 归档商品(多为已售罄下架,offer 带 -sold 后缀)不回填缓存,订单页图片/标题走 LEFT JOIN 降级
        if (it.is_archived === true) continue;
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

async function syncStore(store, { unfulfilledDays = SYNC_LEVELS.fast.unfulfilledDays, listDays = 0, listHours = 0 } = {}) {
  // 三级节奏窗口(2026-09-16,2026-09-17 fast 调整,2026-09-20 fast 加近效 list,2026-09-21 fast 回看7天):
  //   fast(每2分钟): unfulfilled cutoff [now-7d, now+14d] + list [now-3h, now] —— 未完成订单(含过期cutoff)+ 签收兜底
  //   mid(每8小时):  list [now-90d, now] —— 近3个月订单全集(补 delivered/cancelled 终态)
  //   slow(每24小时): list [now-365d, now] —— 近1年订单全集(全年兜底)
  // list 按下单时间过滤且含所有状态,天然覆盖未完成订单;mid/slow 轮跳过 unfulfilled
  const now = new Date();
  let count = 0;

  // 1) 未完成订单全集(fast 轮;unfulfilledDays=null 跳过,0=从 now 起,>0=向前回看 N 天)
  if (unfulfilledDays != null) {
    const cutoffFrom = iso(new Date(now.getTime() - unfulfilledDays * 86400_000));
    const cutoffTo = iso(new Date(now.getTime() + 14 * 86400_000));
    count += await fetchAll(store, (cursor) =>
      postingFbsUnfulfilledList(store, { cutoffFrom, cutoffTo, cursor })
    , (p) => syncPostingWithNotify(store, p), 'unfulfilled');
  }

  // 2) 订单全集(mid/slow 轮补终态;fast 轮近效 list 用于签收兜底)
  //    delivered 离开 unfulfilled 列表,签收兜底通知需 fast 轮可见签收状态
  const listSinceMs = listDays > 0
    ? listDays * 86400_000
    : (listHours > 0 ? listHours * 3600_000 : 0);
  if (listSinceMs > 0) {
    const sinceList = iso(new Date(now.getTime() - listSinceMs));
    count += await fetchAll(store, (cursor) =>
      postingFbsList(store, { since: sinceList, to: iso(now), cursor })
    , (p) => syncPostingWithNotify(store, p), 'list');
  }

  // 3) 订单 SKU 未命中商品缓存的回源(图片/完整标题)
  if (progress.active) progress.currentPhase = 'cache-backfill';
  await backfillProductCache(store);

  // 4) 应计同步(已完成/已取消货件,失败不阻塞订单同步)
  if (progress.active) progress.currentPhase = 'accrual';
  try {
    // 全量同步场景:提高单轮上限到 2000(默认 400),避免老订单排不上
    await syncAccruals(store, { limit: 2000 });
  } catch (e) {
    logger.warn({ storeId: store.id, err: e?.message }, '[order-sync] 应计同步失败(不影响订单同步)');
  }

  // 5) rFBS 退货同步(2026-09-13,妥投后买家退货退款,标记 op_package.is_returned)
  if (progress.active) progress.currentPhase = 'returns';
  try {
    await syncReturns(store);
  } catch (e) {
    logger.warn({ storeId: store.id, err: e?.message }, '[order-sync] 退货同步失败(不影响订单同步)');
  }

  orderPackageDao.updateSyncCursor(store.id, { count });
  return count;
}

// ── rFBS 退货同步(阶段5)──────────────────────────────────────
// 全量拉取店铺退货列表(/v2/returns/rfbs/list,实测 filter 不生效)
// 退货量级小(数十条/半年),每轮全量 upsert;标记/重置逻辑见 order-daos.upsertRfbsReturns
const RETURNS_PAGE_LIMIT = 1000;
const RETURNS_MAX_PAGES = 20;

async function syncReturns(store) {
  let offset = 0;
  let all = [];
  for (let page = 0; page < RETURNS_MAX_PAGES; page++) {
    const resp = await rfbsReturnsList(store, { limit: RETURNS_PAGE_LIMIT, offset });
    const batch = resp?.returns || [];
    all = all.concat(batch);
    if (batch.length < RETURNS_PAGE_LIMIT) break;
    offset += RETURNS_PAGE_LIMIT;
  }
  const r = orderPackageDao.upsertRfbsReturns(store.id, all);
  if (r.returns > 0 || r.marked > 0 || r.reset > 0) {
    logger.info(
      { storeId: store.id, returns: r.returns, marked: r.marked, reset: r.reset },
      '[order-sync] rFBS 退货同步完成'
    );
  }
  return r;
}

// ── 应计同步(阶段4)───────────────────────────────────────────
// 拉取已完成/已取消货件的 Ozon 应计项目(/v1/finance/accrual/postings)
// 待拉条件见 accrual-dao.findPendingAccrualPostings:
//   从未拉过 | 拉过但空(24h 重试)| 下单 90 天内
// 429 限流:300ms 节流 + 指数退避(实测验证);单店铺失败仅记 failures 不阻塞
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callAccrualWithRetry(store, postingNumbers) {
  let lastErr = null;
  for (let attempt = 0; attempt <= ACCRUAL_MAX_RETRY; attempt++) {
    try {
      return await financeAccrualPostings(store, postingNumbers);
    } catch (e) {
      lastErr = e;
      // 429 限流 / 网络错 / 超时:退避后重试;其余(4xx 参数错)直接放弃
      const retryable = /429|rate limit|network|timeout|网络错/i.test(e?.message || '');
      if (!retryable || attempt === ACCRUAL_MAX_RETRY) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function syncAccruals(store, { mode = 'pending', sinceDays, packageIds, limit } = {}) {
  // 待拉清单:pending(增量,默认)/ backfill(存量回补)/ packages(单包裹刷新)
  let pending;
  if (mode === 'packages') {
    // 限定本店铺:防止用他店凭据拉同一包裹(返回空应计,覆盖清空已有数据)
    pending = findAccrualPostingsByPackageIds(store.id, packageIds || []);
  } else if (mode === 'backfill') {
    pending = findBackfillAccrualPostings(store.id, sinceDays, 2000);
  } else {
    pending = findPendingAccrualPostings(store.id, limit || ACCRUAL_LIMIT_PER_ROUND);
  }
  if (pending.length === 0) return { packages: 0, accrualRows: 0 };

  // 类型字典(缓存命中不调 OPI)
  const typeMap = await getAccrualTypes(() => financeAccrualTypes(store));

  const postingMap = new Map(pending.map((r) => [r.postingNumber, r.packageId]));
  let packages = 0;
  let accrualRows = 0;
  for (let i = 0; i < pending.length; i += ACCRUAL_BATCH) {
    const batch = pending.slice(i, i + ACCRUAL_BATCH).map((r) => r.postingNumber);
    const resp = await callAccrualWithRetry(store, batch);
    const r = replaceAccruals(store.id, resp?.posting_accruals || [], postingMap, typeMap);
    packages += r.packages;
    accrualRows += r.accrualRows;
    if (i + ACCRUAL_BATCH < pending.length) await sleep(ACCRUAL_THROTTLE_MS);
  }
  logger.info(
    { storeId: store.id, packages, accrualRows, mode, pending: pending.length },
    '[order-sync] 应计同步完成'
  );
  return { packages, accrualRows };
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
        (p) => syncPostingWithNotify(store, p), 'list'
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
  // 全量同步后追加应计同步(与 syncStore 第4阶段一致)
  // 注:runSyncAllList 原先只拉订单不拉应计,导致已完成订单的代理佣金/国际配送等缺失
  progress.currentPhase = 'accrual';
  progress.message = '应计项目同步中(已完成/已取消货件)...';
  for (const store of eligible) {
    try {
      // 全量同步场景:提高单轮上限到 2000(默认 400),避免老订单排不上
      const r = await syncAccruals(store, { limit: 2000 });
      logger.info({ storeId: store.id, ...r }, '[order-sync-all] 应计同步完成');
    } catch (e) {
      logger.warn({ storeId: store.id, err: e?.message }, '[order-sync-all] 应计同步失败(不影响订单同步)');
    }
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
// ── 单订单强制同步(用户点击"同步"按钮触发)─────────────────────
// 不受时间窗口限制:按单号直查 Ozon /v3/posting/fbs/get
// 同时强拉应计项目(走 findAccrualPostingsByPackageIds,无 24h 限制)
// 返回 { ok, postingNumber, storeId, orderSynced, accrualRows, statusBefore, statusAfter }
export async function syncSinglePackage(packageId) {
  if (!Number.isInteger(Number(packageId)) || Number(packageId) <= 0) {
    throw new Error('packageId 必须为正整数');
  }
  // 查 DB 拿 posting_number + store_id + 当前状态(供前后对比)
  const row = db
    .prepare(
      `SELECT p.id, o.posting_number AS postingNumber, o.store_id AS storeId,
              o.status AS ozonStatusBefore, p.operate_status AS operateStatusBefore
       FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id
       WHERE p.id = ?`
    )
    .get(Number(packageId));
  if (!row || !row.postingNumber || !row.storeId) {
    throw new Error(`未找到 packageId=${packageId} 对应的订单或店铺`);
  }

  const stores = config.loadStores() || [];
  const store = stores.find((s) => s.id === row.storeId);
  if (!store || !store?.sync_credentials?.clientId) {
    throw new Error(`店铺 ${row.storeId} 未配置 sync_credentials,无法直连 Ozon`);
  }

  // 1) 拉订单最新数据(/v3/posting/fbs/get 按 posting_number 单查,无时间窗口)
  //    响应结构:{ result: {...posting...} }(与 list 单 posting 一致)
  const resp = await postingFbsGet(store, row.postingNumber);
  const posting = resp?.result;
  let orderSynced = false;
  if (posting && posting.posting_number) {
    const r = syncPostingWithNotify(store, posting);
    orderSynced = true;
    logger.info(
      { packageId: row.id, postingNumber: row.postingNumber, orderId: r.orderId, packageId: r.packageId },
      '[order-sync] 单订单同步完成'
    );
  } else {
    logger.warn({ packageId: row.id, postingNumber: row.postingNumber, resp }, '[order-sync] Ozon 返回空 posting');
  }

  // 2) 强制拉应计项目(走 findAccrualPostingsByPackageIds,无 24h 限制)
  //    syncAccruals 内部含 429 限流退避,失败不阻塞流程
  let accrualRows = 0;
  let accrualErr = null;
  try {
    const r = await syncAccruals(store, { mode: 'packages', packageIds: [row.id] });
    accrualRows = r.accrualRows || 0;
  } catch (e) {
    accrualErr = e?.message || String(e);
    logger.warn({ packageId: row.id, err: accrualErr }, '[order-sync] 单订单应计同步失败(状态同步已成功)');
  }

  // 3) 刷新退货标记(/v2/returns/rfbs/list 无单号过滤,全量拉取,量级小;失败不阻塞)
  try {
    await syncReturns(store);
  } catch (e) {
    logger.warn({ packageId: row.id, err: e?.message }, '[order-sync] 单订单退货同步失败(状态同步已成功)');
  }

  // 查最新状态(供前后对比)
  const after = db
    .prepare(
      `SELECT o.status AS ozonStatusAfter, p.operate_status AS operateStatusAfter,
              p.accrual_total, p.accrual_synced_at
       FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id
       WHERE p.id = ?`
    )
    .get(row.id);

  return {
    ok: true,
    packageId: row.id,
    postingNumber: row.postingNumber,
    storeId: row.storeId,
    orderSynced,
    accrualRows,
    accrualError: accrualErr,
    statusBefore: { ozon: row.ozonStatusBefore, operate: row.operateStatusBefore },
    statusAfter: after
      ? { ozon: after.ozonStatusAfter, operate: after.operateStatusAfter,
          accrualTotal: after.accrual_total, accrualSyncedAt: after.accrual_synced_at }
      : null,
  };
}

export async function runOrderSyncNow({ level = 'fast' } = {}) {
  if (syncing) {
    return { skipped: true, reason: '同步已在进行中' };
  }
  const cfg = SYNC_LEVELS[level] || SYNC_LEVELS.fast;
  syncing = true;
  const started = Date.now();
  const stores = config.loadStores() || [];
  // 店铺名映射注入(DAO 列表展示用)
  setStoreNameMap(new Map(stores.map((s) => [s.id, s.name || s.id])));
  const eligible = stores.filter((s) => s?.sync_credentials?.clientId);
  resetProgress('incremental', eligible.length);
  progress.message = `准备同步 ${eligible.length} 个店铺(${cfg.label})`;
  const results = [];
  for (const store of eligible) {
    progress.currentStoreId = store.id;
    progress.currentStoreName = store.name || store.id;
    progress.message = `同步店铺 ${progress.currentStoreName} (${progress.doneStores + 1}/${eligible.length}, ${cfg.label})`;
    try {
      const n = await syncStore(store, cfg);
      results.push({ storeId: store.id, storeName: store.name, count: n, ok: true });
      logger.info({ level, storeId: store.id, count: n }, '[order-sync] 店铺同步完成');
    } catch (e) {
      orderPackageDao.updateSyncCursor(store.id, { error: e?.message || String(e) });
      results.push({ storeId: store.id, storeName: store.name, ok: false, error: e?.message || String(e) });
      progress.errorCount++;
      recordFailure(store, { error: e?.message || String(e), stack: e?.stack?.split('\n').slice(0, 3).join(' | ') });
      logger.warn({ level, storeId: store.id, err: e?.message, stack: e?.stack }, '[order-sync] 店铺同步失败');
    }
    progress.doneStores++;
  }
  // mid/slow 轮收尾:已取消货件对账(订单状态已 cancelled 但包裹 operate_status 未跟上的批量推进)
  // 漏网场景:搁置期间错过状态联动、fast 轮 cutoff 不回看的过期单长期无人触碰
  if (cfg.listDays > 0) {
    try {
      const fixed = orderPackageDao.reconcileCancelledPackages();
      if (fixed > 0) logger.info({ level, fixed }, '[order-sync] 已取消货件对账:批量推进到已取消');
    } catch (e) {
      logger.warn({ level, err: e?.message }, '[order-sync] 已取消货件对账失败');
    }
  }
  // 完成:保留进度数据,置 active=false + finishedAt,等用户手动关闭
  progress.active = false;
  progress.finishedAt = new Date().toISOString();
  const errPart = progress.errorCount > 0 ? `,失败 ${progress.errorCount} 店` : '';
  progress.message = `完成 ${eligible.length} 个店铺(${cfg.label}),共拉取 ${progress.postingsPulled} 个订单${errPart}`;
  syncing = false;
  const durationMs = Date.now() - started;
  return {
    skipped: false,
    level,
    durationMs,
    stores: results,
  };
}

export function startOrderSync() {
  if (fastTimer) return;
  // 首跑前注入店铺名映射(定时轮次会刷新)
  const stores = config.loadStores() || [];
  setStoreNameMap(new Map(stores.map((s) => [s.id, s.name || s.id])));
  setTimeout(() => {
    runOrderSyncNow({ level: 'fast' }).catch((e) => logger.error({ err: e?.message }, '[order-sync] 首次同步异常'));
  }, FIRST_DELAY_MS).unref();
  // 三级节奏:fast 每2分钟(未完成订单) / mid 每8小时(近90天) / slow 每24小时(近365天)
  fastTimer = setInterval(
    () => runOrderSyncNow({ level: 'fast' }).catch((e) => logger.error({ err: e?.message }, '[order-sync] fast 轮同步异常')),
    FAST_INTERVAL_MIN * 60_000
  );
  midTimer = setInterval(
    () => runOrderSyncNow({ level: 'mid' }).catch((e) => logger.error({ err: e?.message }, '[order-sync] mid 轮同步异常')),
    MID_INTERVAL_MS
  );
  slowTimer = setInterval(
    () => runOrderSyncNow({ level: 'slow' }).catch((e) => logger.error({ err: e?.message }, '[order-sync] slow 轮同步异常')),
    SLOW_INTERVAL_MS
  );
  logger.info(
    { fastMin: FAST_INTERVAL_MIN, midHours: MID_INTERVAL_MS / 3600_000, slowHours: SLOW_INTERVAL_MS / 3600_000 },
    '[order-sync] 订单同步调度已启动(三级节奏:fast/mid/slow)'
  );
}

export function stopOrderSync() {
  for (const t of [fastTimer, midTimer, slowTimer]) {
    if (t) clearInterval(t);
  }
  fastTimer = midTimer = slowTimer = null;
  logger.info('[order-sync] 订单同步调度已停止');
}
