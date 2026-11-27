// 补齐采购单缺失货源商品ID(2026-11-27)
// 背景:妙手插件补全链路写入的 items_json 只有 `goodsId:""`(空值),无法积累货源。
// 本任务按平台重拉订单详情商品行,写回 items_json 并自动积累货源;结束后统一跑一次货源回填。
//   - 拼多多:分页拉取全部订单(offset 游标),一次覆盖全部缺失单号,避免逐单搜索(逐单需开详情页取优惠,慢)
//   - 1688:按单号搜索(官方 OpenAPI buyerView,约 1.5s/单,限速)
//   - 淘宝:按单号搜索(浏览器 mtop,约 2s/单,限速)
//   - 闲鱼:按单号搜索(浏览器列表翻页比对,约 2s/单,限速)
// 任务在进程内后台执行,状态通过 /sync-missing-goods-status 轮询;同一时间只允许一个任务。
import { db } from '../db/index.js';
import { enrichPurchaseItems } from '../db/dao/sqlite/order-daos.js';
import { accumulateFromPurchaseOrder, backfillFromHistory } from './supplier-products.js';
import { fetchPddOrdersPaged } from './platform-orders/adapters/pdd.js';
import { searchTaobaoOrder } from './platform-orders/adapters/taobao.js';
import { searchXianyuOrder } from './platform-orders/adapters/xianyu.js';
import { searchAliOrder } from '../modules/platform-orders.js';
import config from '../config/index.js';
import logger from '../middleware/log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PDD_PAGE_INTERVAL_MS = 2000;
const ALI_INTERVAL_MS = 1500;

const INITIAL = {
  running: false,
  phase: '',
  startedAt: null,
  finishedAt: null,
  total: 0,          // 待补齐采购单总数
  done: 0,           // 已处理
  updated: 0,        // 成功写回商品行
  notFound: 0,       // 平台订单未找到/无商品行
  failed: 0,         // 请求失败
  lastError: '',
  page: 0,           // 拼多多分页进度:已翻页数
  scanned: 0,        // 拼多多分页进度:已扫订单数
  found: 0,          // 拼多多分页进度:命中缺失单数
  lastResult: null,  // 结束后的货源回填结果
  platforms: [],
};
let state = { ...INITIAL };

export function getMissingSyncState() {
  return { ...state };
}

/** 缺失非空 goodsId 的采购单(按平台) */
function listMissing(platform) {
  return db
    .prepare(
      `SELECT po.id, po.purchase_sn
       FROM op_purchase_order po
       WHERE po.platform = ?
         AND po.purchase_sn IS NOT NULL AND length(po.purchase_sn) > 0
         AND NOT EXISTS (
           SELECT 1 FROM json_each(po.items_json) j
           WHERE COALESCE(json_extract(j.value, '$.goodsId'), '') <> ''
         )
       ORDER BY po.id DESC`
    )
    .all(platform);
}

/** 写回商品行 + 尝试自动积累货源 */
function writeGoods(poId, platform, purchaseSn, sellerName, goods) {
  if (!Array.isArray(goods) || !goods.length) return false;
  let changed = false;
  try {
    const r = enrichPurchaseItems([{ platform, purchaseSn, sellerName: sellerName || null, goods }]);
    changed = r.updated > 0;
  } catch (e) {
    logger.warn({ platform, purchaseSn, err: e?.message }, '[supplier-sync] 写回商品行失败');
  }
  // 不论是否 changed,都尝试积累(统计按历史聚合,幂等)
  try {
    accumulateFromPurchaseOrder(poId);
  } catch { /* 单条积累失败忽略 */ }
  return changed;
}

/** 拼多多:分块分页拉取全部订单(每块 ≤10 页,块间续传 offset,避免 withPage 60s 超时) */
async function syncPdd() {
  const rows = listMissing('yangkeduo');
  state.total += rows.length;
  if (!rows.length) return;
  const accounts = config.platformAccounts.pdd || [];
  if (!accounts.length) {
    state.failed += rows.length;
    state.lastError = '未配置拼多多账号';
    return;
  }
  const bySn = new Map(rows.map((r) => [r.purchase_sn, r]));
  const foundMap = new Map();
  let offset = '';
  let exhausted = false;
  let pagesTotal = 0;
  let scannedTotal = 0;
  const MAX_CHUNKS = 80; // 兜底:最多 800 页
  for (let chunk = 0; chunk < MAX_CHUNKS && !exhausted && foundMap.size < bySn.size; chunk += 1) {
    let res;
    try {
      res = await fetchPddOrdersPaged({
        account: accounts[0],
        orderSns: [...bySn.keys()],
        startOffset: offset,
        intervalMs: PDD_PAGE_INTERVAL_MS,
        onPage: (p) => {
          state.page = pagesTotal + p.pages;
          state.scanned = scannedTotal + p.scanned;
          state.found = foundMap.size + p.found;
        },
      });
    } catch (e) {
      state.lastError = `拼多多: ${e?.message || String(e)}`;
      logger.warn({ err: state.lastError, chunk }, '[supplier-sync] 拼多多分块分页失败');
      break;
    }
    for (const o of res.orders || []) foundMap.set(o.orderSn, o);
    pagesTotal += res.pages || 0;
    scannedTotal += res.scanned || 0;
    state.page = pagesTotal;
    state.scanned = scannedTotal;
    state.found = foundMap.size;
    offset = res.nextOffset || '';
    exhausted = !!res.exhausted || !offset;
    if (!res.pages) exhausted = true;
  }
  if (!foundMap.size) {
    state.failed += rows.length;
    if (!state.lastError) state.lastError = '拼多多未匹配到任何缺失订单(分页可能未覆盖)';
    return;
  }
  for (const [sn, r] of bySn) {
    const order = foundMap.get(sn);
    if (!order || !order.goods || !order.goods.length) {
      // 完整扫描仍未命中 → 平台无此单/无商品行;未扫完 → 计入失败(未覆盖)
      if (exhausted) state.notFound += 1;
      else state.failed += 1;
      state.done += 1;
      continue;
    }
    try {
      if (writeGoods(r.id, 'yangkeduo', sn, order.mallName, order.goods)) state.updated += 1;
      else state.notFound += 1;
    } catch (e) {
      state.failed += 1;
      state.lastError = e?.message || String(e);
    }
    state.done += 1;
  }
  logger.info(
    { pages: pagesTotal, scanned: scannedTotal, matched: foundMap.size, wanted: rows.length, exhausted },
    '[supplier-sync] 拼多多分页同步完成'
  );
}

/** 按单号逐单搜索补齐(1688 OpenAPI / 淘宝浏览器),限速 */
async function syncByOrderSearch({ platform, label, accounts, searchFn, intervalMs = ALI_INTERVAL_MS }) {
  const rows = listMissing(platform);
  state.total += rows.length;
  if (!rows.length) return;
  if (!accounts.length) {
    state.failed += rows.length;
    state.lastError = `未配置${label}账号`;
    return;
  }
  let authFailures = 0;
  for (const r of rows) {
    try {
      const { result } = await searchFn(r.purchase_sn, accounts);
      if (result && Array.isArray(result.goods) && result.goods.length) {
        if (writeGoods(r.id, platform, r.purchase_sn, result.sellerName, result.goods)) state.updated += 1;
        else state.notFound += 1;
      } else {
        state.notFound += 1;
      }
      authFailures = 0;
    } catch (e) {
      state.failed += 1;
      state.lastError = e?.message || String(e);
      if (/AUTH_REQUIRED|登录|授权|token/i.test(state.lastError)) {
        authFailures += 1;
        if (authFailures >= 3) {
          state.lastError = `${label} 账号登录失效,任务中止:${state.lastError}`;
          logger.warn({ err: state.lastError }, `[supplier-sync] ${label} 中止`);
          break;
        }
      }
    }
    state.done += 1;
    await sleep(intervalMs);
  }
}

function syncAli1688() {
  return syncByOrderSearch({
    platform: '1688',
    label: '1688',
    accounts: config.platformAccounts.ali1688 || [],
    searchFn: searchAliOrder,
  });
}

function syncTaobao() {
  return syncByOrderSearch({
    platform: 'taobao',
    label: '淘宝',
    accounts: config.platformAccounts.taobao || [],
    searchFn: searchTaobaoOrder,
    intervalMs: 2000, // 浏览器 mtop,留足间隔防风控
  });
}

function syncXianyu() {
  return syncByOrderSearch({
    platform: 'xianyu',
    label: '闲鱼',
    accounts: config.platformAccounts.xianyu || [],
    searchFn: searchXianyuOrder,
    intervalMs: 2000, // 列表翻页比对单号,直接走浏览器
  });
}

/**
 * 启动补齐任务(后台执行,立即返回)
 * @param {{platforms?: string[]}} [opts] 默认先拼多多后 1688
 */
export function startMissingGoodsSync({ platforms = ['yangkeduo', '1688', 'taobao', 'xianyu'] } = {}) {
  if (state.running) return { started: false, running: true, state: getMissingSyncState() };
  const list = Array.isArray(platforms) && platforms.length ? platforms : ['yangkeduo', '1688', 'taobao', 'xianyu'];
  state = { ...INITIAL, running: true, startedAt: new Date().toISOString(), platforms: list };
  (async () => {
    try {
      if (list.includes('yangkeduo')) {
        state.phase = 'pdd';
        await syncPdd();
      }
      if (list.includes('1688')) {
        state.phase = '1688';
        await syncAli1688();
      }
      if (list.includes('taobao')) {
        state.phase = 'taobao';
        await syncTaobao();
      }
      if (list.includes('xianyu')) {
        state.phase = 'xianyu';
        await syncXianyu();
      }
      state.phase = 'backfill';
      state.lastResult = backfillFromHistory();
      logger.info({ ...getMissingSyncState() }, '[supplier-sync] 缺失商品ID补齐完成');
    } catch (e) {
      state.lastError = e?.message || String(e);
      logger.warn({ err: state.lastError }, '[supplier-sync] 任务异常');
    } finally {
      state.running = false;
      state.phase = 'done';
      state.finishedAt = new Date().toISOString();
    }
  })();
  return { started: true, state: getMissingSyncState() };
}
