// 应计 by-day 定时同步(2026-09-24,/v1/finance/accrual/by-day 主数据源)
//
// 背景:postings 接口只返回费用侧且缺 Acquiring 等 8 种类型;by-day 费用类型 ⊇ postings
// 且 POSTING.commission 携带收入侧明细(售价/结算/佣金/共同投资/奖金)。
// 定时轮(fast/mid/slow)已移除 postings 应计阶段,本任务接管定时获取;
// postings 保留给手动链路(单订单同步按钮 / accrual-sync 手动路由)。
//
// 节奏:
//   - 启动后延迟 10 分钟首跑,之后每 24h 一轮
//   - 每轮扫 [now-35d, now-1d] × 全店铺(覆盖应计滞后 2-3 周 + 退货负冲)
//   - 串行 + 进程内全局节流 1.1s(finance 接口秒级限流 429 code=8)
//   - 幂等:replaceAccrualsByDay 按 posting_number 先删后插
//
// 落库:费用行 → op_accrual(结算判定/利润口径/明细弹窗等现有读取方自动兼容)
//       收入行 → op_accrual_income(新表,postings 完全没有的收入侧)
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { financeAccrualByDay, financeAccrualTypes } from './ozon-opi.js';
import { getAccrualTypes, replaceAccrualsByDay } from '../db/dao/sqlite/accrual-dao.js';

const FIRST_DELAY_MS = 10 * 60 * 1000; // 启动后 10 分钟首跑(避开启动高峰)
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每 24h 一轮
const ROLLING_DAYS = 35; // 滚动窗口(天):应计滞后 2-3 周 + 退货负冲余量
const THROTTLE_MS = 1100; // 进程内全局节流:相邻两次调用开始时刻最小间隔
const MAX_RETRY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 进程内全局节流(同 order-sync.js accrual 槽位思路,但独立计数:
//    by-day 与 postings 是不同接口,限额独立核算)──────────────────
let _lastSlotAt = 0;
function reserveSlot() {
  const now = Date.now();
  const slot = Math.max(now, _lastSlotAt + THROTTLE_MS);
  _lastSlotAt = slot;
  return slot;
}

async function callByDayWithRetry(store, date, lastId) {
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      const wait = reserveSlot() - Date.now();
      if (wait > 0) await sleep(wait);
      return await financeAccrualByDay(store, { date, lastId });
    } catch (e) {
      lastErr = e;
      // 429 限流 / 网络错 / 超时:退避后重试;其余(4xx 参数错)直接放弃
      const retryable = /429|rate limit|network|timeout|网络错/i.test(e?.message || '');
      if (!retryable || attempt === MAX_RETRY) throw e;
      // 随机抖动:双实例共用同一 Ozon 凭据时,固定退避节奏会反复同时碰撞
      await sleep(2000 * (attempt + 1) + Math.floor(Math.random() * 1000));
    }
  }
  throw lastErr;
}

/** 同步单店铺单日(含 last_id 分页),返回 { units, feeRows, incomeRows, packages } */
async function syncDay(store, date, typeMap) {
  let lastId = '';
  let agg = { units: 0, feeRows: 0, incomeRows: 0, packages: 0 };
  let pages = 0;
  do {
    const resp = await callByDayWithRetry(store, date, lastId);
    const accruals = resp?.accruals || [];
    if (accruals.length > 0) {
      const r = replaceAccrualsByDay(store.id, date, accruals, typeMap);
      agg = {
        units: agg.units + r.units,
        feeRows: agg.feeRows + r.feeRows,
        incomeRows: agg.incomeRows + r.incomeRows,
        packages: agg.packages + r.packages,
      };
    }
    lastId = resp?.last_id || '';
    pages++;
  } while (lastId && pages < 100);
  return agg;
}

let _running = false;

/** 一轮完整扫描:[now-days, now-1d] × 全店铺,返回汇总 */
export async function runAccrualByDaySync({ days = ROLLING_DAYS } = {}) {
  if (_running) return { skipped: true, reason: 'by-day 应计同步已在进行中' };
  _running = true;
  const started = Date.now();
  try {
    const stores = (config.loadStores() || []).filter((s) => s?.sync_credentials?.clientId);
    if (stores.length === 0) return { skipped: true, reason: '无可用店铺凭据' };
    const typeMap = await getAccrualTypes(() => financeAccrualTypes(stores[0]));

    const dates = [];
    const today = new Date();
    for (let i = days; i >= 1; i--) {
      dates.push(new Date(today.getTime() - i * 86400_000).toISOString().slice(0, 10));
    }

    const agg = { days: dates.length, stores: stores.length, units: 0, feeRows: 0, incomeRows: 0, packages: 0, errors: [] };
    for (const date of dates) {
      for (const store of stores) {
        try {
          const r = await syncDay(store, date, typeMap);
          agg.units += r.units;
          agg.feeRows += r.feeRows;
          agg.incomeRows += r.incomeRows;
          agg.packages += r.packages;
        } catch (e) {
          agg.errors.push(`${store.id}|${date}: ${e?.message || e}`);
          logger.warn({ storeId: store.id, date, err: e?.message }, '[accrual-byday] 单日同步失败');
        }
      }
    }
    agg.durationMs = Date.now() - started;
    logger.info(
      { ...agg, errors: agg.errors.length },
      '[accrual-byday] 一轮完成:费用/收入明细已落库'
    );
    return agg;
  } finally {
    _running = false;
  }
}

let _timer = null;

export function startAccrualByDaySync() {
  if (_timer) return;
  setTimeout(() => {
    runAccrualByDaySync().catch((e) => logger.error({ err: e?.message }, '[accrual-byday] 首轮同步异常'));
  }, FIRST_DELAY_MS).unref();
  _timer = setInterval(
    () => runAccrualByDaySync().catch((e) => logger.error({ err: e?.message }, '[accrual-byday] 定时同步异常')),
    DAILY_INTERVAL_MS
  );
  logger.info({ rollingDays: ROLLING_DAYS, intervalHours: 24 }, '[accrual-byday] 定时任务已启动');
}

export function stopAccrualByDaySync() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    logger.info('[accrual-byday] 定时任务已停止');
  }
}
