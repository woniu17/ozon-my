// 采集队列终态任务清理器
// 周期性清理 collect_queue_tasks 表中的终态任务(success / failed_final / failed_partial),
// 保留最新 N 条(按 finishedAt 降序),避免表无限膨胀。
//
// 规则:
//   - 每 5 分钟扫描一次
//   - 仅清理终态任务,不影响 pending/running/failed_retry
//   - 保留最新 500 条终态任务(可配置)
//   - 单次扫描失败不阻塞下一次(只 warn)
import { getDaos } from '../db/adapter.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
const DEFAULT_KEEP_COUNT = 500;

const daos = await getDaos();

// 单次扫描:返回 { total, deletedCount }
async function scanOnce() {
  const r = await daos.collectQueueTasksDao.cleanupTerminalTasks(DEFAULT_KEEP_COUNT);
  if (r.deletedCount > 0) {
    logger.info(
      { total: r.total, deleted: r.deletedCount, kept: DEFAULT_KEEP_COUNT },
      'queue-cleanup-poller: 已清理终态任务'
    );
  }
  return r;
}

let timer = null;

export function startQueueCleanupPoller() {
  if (timer) return;
  // 启动后 60 秒做首次扫描(错开 import-status-poller 的 30s 启动,避免瞬间并发),之后每 5 分钟一次
  setTimeout(() => {
    scanOnce().catch((e) => logger.warn({ err: e.message }, 'queue-cleanup-poller 首次扫描异常'));
    timer = setInterval(() => {
      scanOnce().catch((e) => logger.warn({ err: e.message }, 'queue-cleanup-poller 扫描异常'));
    }, POLL_INTERVAL_MS);
    timer.unref();
  }, 60 * 1000).unref();
  logger.info(
    { intervalMin: POLL_INTERVAL_MS / 60000, keepCount: DEFAULT_KEEP_COUNT },
    'queue-cleanup-poller: 已启动(5分钟清理一次,保留最新500条终态任务)'
  );
}

export function stopQueueCleanupPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
