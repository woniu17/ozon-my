// SQLite TTL 定时清理器:替代 MongoDB TTL 索引
// 清理 collect_queue_ops 表中 processedAt 非 NULL 且超过 7 天的记录
import { db } from '../../index.js';

const TTL_INTERVAL_MS = 60 * 60 * 1000; // 每小时清理一次
const TTL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 保留 7 天

let timer = null;

/** 启动 TTL 清理定时器 */
export function startTtlCleaner() {
  if (timer) return timer;
  const clean = () => {
    try {
      const cutoff = new Date(Date.now() - TTL_RETENTION_MS).toISOString();
      const r = db
        .prepare(`DELETE FROM collect_queue_ops WHERE processedAt IS NOT NULL AND processedAt < ?`)
        .run(cutoff);
      if (r.changes > 0) {
        console.log(`[ttl] cleaned ${r.changes} ops older than 7d`);
      }
    } catch (e) {
      console.warn('[ttl] clean failed:', e.message);
    }
  };
  clean(); // 启动时执行一次
  timer = setInterval(clean, TTL_INTERVAL_MS);
  // setInterval 在 Node 中不会被 process.exit 自动清除,但允许 unref 让进程退出
  if (timer.unref) timer.unref();
  return timer;
}

/** 停止 TTL 清理定时器(测试用) */
export function stopTtlCleaner() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
