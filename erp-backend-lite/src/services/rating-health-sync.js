// 店铺健康-错误指数同步(2026-11-03)
// 数据源:
//   - /v1/rating/index/fbs/info            周期汇总 + 按天明细
//   - /v1/rating/index/fbs/posting/list     影响错误指数的货件(分页)
// 节奏:
//   - 启动后延迟 10 分钟首跑,之后每 24h 一轮(每天 03:00 由 app.js 启动定时)
//   - 每轮扫 [today-34d, today] × 全店铺(覆盖 Ozon 滚动周期)
//   - 串行 + 进程内全局节流 500ms(避免限流)
//   - 幂等:先删区间再插入(每日/货件均 upsert)
// 落库:op_rating_snapshot(周期汇总) / op_rating_daily(趋势) / op_rating_error_posting(明细)
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { ratingIndexFbsInfo, ratingIndexFbsPostingList } from './ozon-opi.js';
import {
  replaceRatingSnapshot,
  replaceRatingDaily,
  clearRatingDaily,
  clearRatingErrors,
  replaceRatingErrorPosting,
} from '../db/dao/sqlite/rating-dao.js';
import { runWithLog } from './task-run-log.js';

const FIRST_DELAY_MS = 10 * 60 * 1000; // 启动后 10 分钟首跑
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每 24h
const ROLLING_DAYS = 35; // 滚动窗口(天)
const THROTTLE_MS = 500; // 相邻 Ozon 调用最小间隔
const POSTING_PAGE_LIMIT = 100; // posting/list 单页条数(保守,分页拉全)
const MAX_POSTING_PAGES = 20; // 单店单区间最大页数(防御异常)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 进程内全局节流 ──
let _lastSlotAt = 0;
function reserveSlot() {
  const now = Date.now();
  const slot = Math.max(now, _lastSlotAt + THROTTLE_MS);
  _lastSlotAt = slot;
  return slot;
}

async function callThrottled(fn) {
  const wait = reserveSlot() - Date.now();
  if (wait > 0) await sleep(wait);
  return fn();
}

/** 把 YYYY-MM-DD 偏移 days 天 */
function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 同步单店铺:info 汇总 + posting/list 全量明细,先删后插 */
async function syncStore(store, from, to) {
  let infoResp = null;
  try {
    infoResp = await callThrottled(() => ratingIndexFbsInfo(store));
  } catch (e) {
    logger.warn({ storeId: store.id, err: e?.message }, '[rating-health] info 拉取失败');
    infoResp = null;
  }

  // 1) 周期汇总快照(info 返回当前周期,与请求区间无关)
  if (infoResp) {
    replaceRatingSnapshot(store.id, {
      index: infoResp.index,
      processingCostsSum: infoResp.processing_costs_sum,
      currencyCode: infoResp.currency_code,
      periodFrom: infoResp.period_from,
      periodTo: infoResp.period_to,
    });
  }

  // 2) 每日趋势(先删区间再插:info.defects 是周期内完整按天序列)
  clearRatingDaily([store.id], from, to);
  const defects = infoResp?.defects || [];
  let dailyRows = 0;
  for (const d of defects) {
    if (!d?.date) continue;
    replaceRatingDaily(
      store.id,
      d.date,
      d.index_by_date,
      d.processing_costs_sum_by_date,
      infoResp.period_from || null,
      infoResp.period_to || null
    );
    dailyRows++;
  }

  // 3) 影响货件明细(分页拉全,先删区间再插)
  clearRatingErrors([store.id], from, to);
  let cursor = '';
  let postingRows = 0;
  let pages = 0;
  do {
    const body = { dateFrom: from, dateTo: to, limit: POSTING_PAGE_LIMIT };
    if (cursor) body.cursor = cursor;
    const resp = await callThrottled(() => ratingIndexFbsPostingList(store, body));
    const errors = resp?.errors || [];
    for (const e of errors) {
      if (!e?.posting_number) continue;
      replaceRatingErrorPosting(store.id, e);
      postingRows++;
    }
    cursor = resp?.has_next ? resp?.cursor || '' : '';
    pages++;
  } while (cursor && pages < MAX_POSTING_PAGES);

  return { dailyRows, postingRows };
}

let _running = false;
let _lastResult = null; // 最近一轮同步结果(供 sync-status 查询)

export function getRatingSyncStatus() {
  return {
    running: _running,
    lastResult: _lastResult,
  };
}

/** 一轮完整同步:指定店铺或全店铺 × [from,to],返回汇总 */
export async function runRatingHealthSync({ storeIds, from, to } = {}) {
  if (_running) return { skipped: true, reason: '错误指数同步已在进行中' };
  _running = true;
  const started = Date.now();
  try {
    const allStores = (config.loadStores() || []).filter((s) => s?.sync_credentials?.clientId);
    const ids = new Set((Array.isArray(storeIds) ? storeIds : []).filter(Boolean));
    const stores = ids.size ? allStores.filter((s) => ids.has(s.id)) : allStores;
    if (stores.length === 0) return { skipped: true, reason: '无可用店铺凭据' };

    const today = new Date().toISOString().slice(0, 10);
    const dateFrom = from || shiftDate(today, -(ROLLING_DAYS - 1));
    const dateTo = to || today;

    const agg = {
      stores: stores.length,
      from: dateFrom,
      to: dateTo,
      dailyRows: 0,
      postingRows: 0,
      errors: [],
      durationMs: 0,
    };
    for (const store of stores) {
      try {
        const r = await syncStore(store, dateFrom, dateTo);
        agg.dailyRows += r.dailyRows;
        agg.postingRows += r.postingRows;
      } catch (e) {
        agg.errors.push(`${store.id}: ${e?.message || e}`);
        logger.warn({ storeId: store.id, err: e?.message }, '[rating-health] 店铺同步失败');
      }
    }
    agg.durationMs = Date.now() - started;
    _lastResult = agg;
    logger.info(
      { ...agg, errors: agg.errors.length },
      '[rating-health] 一轮同步完成:错误指数已落库'
    );
    return agg;
  } finally {
    _running = false;
  }
}

let _timer = null;

export function startRatingHealthSync() {
  if (_timer) return;
  const runLogged = () =>
    runWithLog('rating-health-sync', runRatingHealthSync, {
      formatDetail: (r) => {
        if (r?.skipped) return `跳过:${r.reason || ''}`;
        return `扫描 ${r.stores} 店 [${r.from}, ${r.to}],趋势 ${r.dailyRows} 行,影响货件 ${r.postingRows} 行,错误 ${r.errors?.length || 0} 处`;
      },
    });
  setTimeout(() => {
    runLogged().catch((e) => logger.error({ err: e?.message }, '[rating-health] 首轮同步异常'));
  }, FIRST_DELAY_MS).unref();
  _timer = setInterval(
    () => runLogged().catch((e) => logger.error({ err: e?.message }, '[rating-health] 定时同步异常')),
    DAILY_INTERVAL_MS
  );
  logger.info({ rollingDays: ROLLING_DAYS, intervalHours: 24 }, '[rating-health] 定时任务已启动');
}

export function stopRatingHealthSync() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('[rating-health] 定时任务已停止');
  }
}