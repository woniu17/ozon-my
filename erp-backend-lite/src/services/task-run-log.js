// 定时任务执行日志(2026-10-27):通用打点服务
// 每次定时任务执行写一行 task_run_logs,供前端「定时任务日志」页排查:
//   - 任务是否执行(有记录=执行了;无记录=没跑/没到周期)
//   - 执行是否成功(status + error + detail)
//   - 耗时/结果数据(data JSON)
// 高频轮询器(≤10s)启用节流:成功每 throttleMs 只落一条(默认由调用方传 5 分钟),
// 失败即时记录(失败节流 60s,防止连续失败刷屏)。
import { db } from '../db/index.js';
import logger from '../middleware/log.js';

// ── 任务注册表 ─────────────────────────────────────────────
// 集中维护所有定时任务的定义(前端 /tasks 接口与打点共用)。
// level: minute(分钟级,含秒级高频轮询器) / hour(小时级) / day(天级)
export const TASK_DEFS = {
  // ── 分钟级(含秒级高频轮询器,打点走节流) ──
  'order-sync-fast': {
    task: 'order-sync-fast',
    name: '订单同步 · fast',
    level: 'minute',
    intervalLabel: '每2分钟',
  },
  'import-status-poller': {
    task: 'import-status-poller',
    name: '上架结果轮询',
    level: 'minute',
    intervalLabel: '每5分钟',
  },
  'queue-cleanup-poller': {
    task: 'queue-cleanup-poller',
    name: '采集队列清理',
    level: 'minute',
    intervalLabel: '每5分钟',
  },
  'stock-sync': {
    task: 'stock-sync',
    name: '库存自动同步',
    level: 'minute',
    intervalLabel: '每5分钟',
  },
  'index-sync': {
    task: 'index-sync',
    name: '索引字段同步',
    level: 'minute',
    intervalLabel: '每5分钟',
  },
  'sku-group-sync': {
    task: 'sku-group-sync',
    name: '同款分组重建',
    level: 'minute',
    intervalLabel: '每30分钟',
  },
  'batch-image-poller': {
    task: 'batch-image-poller',
    name: '图片处理调度',
    level: 'minute',
    intervalLabel: '500ms',
  },
  'batch-upload-poller': {
    task: 'batch-upload-poller',
    name: '批量上架调度',
    level: 'minute',
    intervalLabel: '每2秒',
  },
  'image-refresh-poller': {
    task: 'image-refresh-poller',
    name: '图片更新调度',
    level: 'minute',
    intervalLabel: '每10秒',
  },
  'stock-refresh-poller': {
    task: 'stock-refresh-poller',
    name: '库存更新调度',
    level: 'minute',
    intervalLabel: '每5秒',
  },
  'product-update-poller': {
    task: 'product-update-poller',
    name: '商品信息更新调度',
    level: 'minute',
    intervalLabel: '每5秒',
  },
  'product-archive-poller': {
    task: 'product-archive-poller',
    name: '商品归档调度',
    level: 'minute',
    intervalLabel: '每5秒',
  },
  'webhook-event-poller': {
    task: 'webhook-event-poller',
    name: 'Webhook 事件消费',
    level: 'minute',
    intervalLabel: '每2秒',
  },
  // ── 小时级 ──
  'order-sync-mid': {
    task: 'order-sync-mid',
    name: '订单同步 · mid',
    level: 'hour',
    intervalLabel: '每8小时',
  },
  'product-sync-cron': {
    task: 'product-sync-cron',
    name: '商品定时同步',
    level: 'hour',
    intervalLabel: '0/8/16点',
  },
  'purchase-logistics-poller': {
    task: 'purchase-logistics-poller',
    name: '采购物流补全',
    level: 'hour',
    intervalLabel: '每12小时',
  },
  'ttl-cleaner': {
    task: 'ttl-cleaner',
    name: '队列 TTL 清理',
    level: 'hour',
    intervalLabel: '每小时',
  },
  // ── 天级 ──
  'order-sync-slow': {
    task: 'order-sync-slow',
    name: '订单同步 · slow',
    level: 'day',
    intervalLabel: '每24小时',
  },
  'accrual-byday-sync': {
    task: 'accrual-byday-sync',
    name: '应计 by-day 同步',
    level: 'day',
    intervalLabel: '每24小时',
  },
  'endpoint-metrics-retention': {
    task: 'endpoint-metrics-retention',
    name: '端点指标保留清理',
    level: 'day',
    intervalLabel: '每日',
  },
  'price-watch-retention': {
    task: 'price-watch-retention',
    name: '价格快照保留清理',
    level: 'day',
    intervalLabel: '每日',
  },
};

export function getTaskDef(taskKey) {
  return TASK_DEFS[taskKey] || null;
}

export function listTaskDefs() {
  return Object.values(TASK_DEFS);
}

// ── 节流状态 ──────────────────────────────────────────────
// 按 (task, status组) 记录最近一次写库时间,成功/失败互不影响,
// 这样"失败后立刻恢复成功"的成功记录不会被失败节流误杀。
const _lastWriteAt = new Map(); // `${task}:${'fail'|'ok'}` -> timestamp

const FAILURE_THROTTLE_MS = 60 * 1000; // 失败:每分钟最多一条(防连续失败刷屏)
const HIGH_FREQ_THROTTLE_MS = 5 * 60 * 1000; // 高频成功节流:每5分钟一条

/**
 * 写一条任务执行日志。
 * @param {object} opts
 *   task       任务 key(必填,注册表里有 name/level)
 *   status     success | failed | skipped | running
 *   startedAt  Date
 *   finishedAt Date
 *   durationMs 耗时(毫秒)
 *   detail     结果摘要(一行文本,如 "扫描 3 项,更新 2 项")
 *   error      失败原因
 *   data       详细结果对象(JSON 序列化后存 data 列)
 *   throttleMs 成功节流窗口(0=不节流;默认 0;高频调用方传 HIGH_FREQ_THROTTLE_MS)
 *   返回是否实际写库(节流被吞返回 false)
 */
export function recordTaskRun({
  task,
  status = 'success',
  startedAt = new Date(),
  finishedAt = new Date(),
  durationMs,
  detail,
  error,
  data,
  throttleMs = 0,
}) {
  const def = getTaskDef(task);
  const name = def?.name || task;
  const level = def?.level || 'minute';
  const now = Date.now();

  // 节流判定:失败走固定 60s 防刷屏;成功/跳过/运行中走 throttleMs(高频任务 5 分钟)
  const group = status === 'failed' ? 'fail' : 'ok';
  const lastWrite = _lastWriteAt.get(`${task}:${group}`);
  const windowMs = status === 'failed' ? FAILURE_THROTTLE_MS : throttleMs;
  if (lastWrite && windowMs > 0 && now - lastWrite < windowMs) {
    return false;
  }
  _lastWriteAt.set(`${task}:${group}`, now);

  const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
  let dataJson = null;
  if (data !== undefined && data !== null) {
    try {
      dataJson = typeof data === 'string' ? data : JSON.stringify(data);
    } catch {
      dataJson = null; // 序列化失败不阻塞打点
    }
  }
  try {
    db.prepare(
      `INSERT INTO task_run_logs
         (task, name, level, status, started_at, finished_at, duration_ms, detail, error, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task,
      name,
      level,
      status,
      iso(startedAt),
      iso(finishedAt),
      durationMs ?? Math.max(0, Date.now() - new Date(startedAt).getTime()),
      detail || null,
      error || null,
      dataJson,
      iso(new Date())
    );
    return true;
  } catch (e) {
    // 打点失败不影响任务本身执行
    logger.warn({ err: e?.message, task }, '[task-run-log] 写入失败');
    return false;
  }
}

/**
 * 包装一个定时任务执行体:计时 + 自动记录成功/失败。
 * @param {string} taskKey 注册表任务 key
 * @param {Function} fn    异步执行体,返回值用于生成 detail/data
 * @param {object} opts
 *   throttleMs   成功节流窗口(高频轮询器传 HIGH_FREQ_THROTTLE_MS)
 *   formatDetail (result)=>string 可选,从返回值生成结果摘要
 *   detail       string 固定摘要(与 formatDetail 二选一)
 *   data         (result)=>object 可选,从返回值生成详情数据
 *   执行体抛错时仍会向上抛,不改变原控制流。
 */
export async function runWithLog(taskKey, fn, opts = {}) {
  const { throttleMs = 0, formatDetail, detail, data } = opts;
  const startedAt = new Date();
  const startedMs = Date.now();
  try {
    const result = await fn();
    // 契约:执行体内部已捕获异常时,返回 { error: '原因' } 表示"已处理的失败"。
    // runWithLog 据此记 failed,但不向上抛(保持执行体原有控制流)。
    if (result && typeof result === 'object' && result.error) {
      recordTaskRun({
        task: taskKey,
        status: 'failed',
        startedAt,
        finishedAt: new Date(),
        durationMs: Date.now() - startedMs,
        error: String(result.error),
        data: result,
        throttleMs,
      });
      return result;
    }
    // 执行体因互斥/无数据等原因主动跳过时,返回 { skipped: true } → 记 skipped
    if (result && typeof result === 'object' && result.skipped) {
      recordTaskRun({
        task: taskKey,
        status: 'skipped',
        startedAt,
        finishedAt: new Date(),
        durationMs: Date.now() - startedMs,
        detail: typeof result.reason === 'string' ? result.reason : '本轮跳过',
        data: result,
        throttleMs,
      });
      return result;
    }
    let detailText = null;
    if (typeof detail === 'string') detailText = detail;
    else if (typeof formatDetail === 'function') {
      try {
        detailText = formatDetail(result);
      } catch {
        detailText = null;
      }
    } else if (result && typeof result === 'object' && typeof result.detail === 'string') {
      detailText = result.detail;
    }
    let dataVal = undefined;
    if (typeof data === 'function') {
      try {
        dataVal = data(result);
      } catch {
        dataVal = undefined;
      }
    }
    recordTaskRun({
      task: taskKey,
      status: 'success',
      startedAt,
      finishedAt: new Date(),
      durationMs: Date.now() - startedMs,
      detail: detailText,
      data: dataVal,
      throttleMs,
    });
    return result;
  } catch (err) {
    recordTaskRun({
      task: taskKey,
      status: 'failed',
      startedAt,
      finishedAt: new Date(),
      durationMs: Date.now() - startedMs,
      error: err?.message || String(err),
      data: err?.stack ? { error: err?.message || String(err), stack: err.stack } : undefined,
      throttleMs,
    });
    throw err;
  }
}

export { HIGH_FREQ_THROTTLE_MS };