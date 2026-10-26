// 价格管理「跟卖列表」异步采集队列(2026-10-26)
// 交互升级:用户点击"刷新"后不再同步等待 10~40s(连续点击还会因浏览器 profile
// 单实例互斥而失败),改为把 SKU 加入任务表,立即返回;进程内单例 worker 串行采集:
//   - profile 被 platform-orders/登录窗口占用 → 保持 pending,5s 后自动重试
//   - Ozon 反爬/其他错误 → 标记 failed,前端显示原因,用户可稍后手动重试
// 前端轮询 GET /price-watch/tasks 获取任务状态,完成后自动刷新列表摘要。
import { db } from '../db/index.js';
import logger from '../middleware/log.js';
import { fetchFollowSellForSku } from './price-watch-fetch.js';

const RETRY_PROFILE_LOCKED_MS = 5_000;
const MAX_PROFILE_LOCKED_WAIT_MS = 20 * 60 * 1000; // profile 占用超过 20 分钟仍标记失败,避免无限排队

db.exec(`CREATE TABLE IF NOT EXISTS price_watch_tasks (
  sku TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/running/ok/failed
  error_reason TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
)`);

let workerRunning = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 入队 ────────────────────────────────────────────
// 已存在且 pending/running → 直接返回当前状态;已 ok/failed → 重置为 pending 重新采集
export function enqueuePriceWatch(sku, { profileDir }) {
  const skuStr = String(sku || '').trim();
  if (!/^\d+$/.test(skuStr)) return { status: 'error', error: 'sku 非法' };
  const now = new Date().toISOString();

  const existing = db.prepare(`SELECT status FROM price_watch_tasks WHERE sku = ?`).get(skuStr);
  if (existing) {
    if (existing.status === 'pending' || existing.status === 'running') {
      return { status: existing.status, sku: skuStr };
    }
    // ok/failed → 重新采集
    db.prepare(
      `UPDATE price_watch_tasks SET status='pending', error_reason=NULL, created_at=?, started_at=NULL, finished_at=NULL WHERE sku = ?`
    ).run(now, skuStr);
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO price_watch_tasks (sku, status, created_at) VALUES (?, 'pending', ?)`
    ).run(skuStr, now);
  }

  ensureWorker({ profileDir });
  return { status: 'pending', sku: skuStr };
}

// ── worker 单例循环 ───────────────────────────────────
export function ensureWorker({ profileDir }) {
  if (workerRunning) return;
  workerRunning = true;
  runWorkerLoop({ profileDir }).catch((err) => {
    logger.warn({ err: err?.message }, '[price-watch-queue] worker loop crashed');
  }).finally(() => {
    workerRunning = false;
  });
}

async function runWorkerLoop({ profileDir }) {
  logger.info('[price-watch-queue] worker started');
  try {
    for (;;) {
      const task = db
        .prepare(`SELECT * FROM price_watch_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`)
        .get();
      if (!task) break;

      // 标记 running
      db.prepare(
        `UPDATE price_watch_tasks SET status='running', started_at=?, error_reason=NULL WHERE sku = ?`
      ).run(new Date().toISOString(), task.sku);

      let r;
      try {
        r = await fetchFollowSellForSku(task.sku, { profileDir });
      } catch (err) {
        // 兜底:采集过程未捕获异常不应让任务卡在 running
        logger.warn({ err: err?.message, sku: task.sku }, '[price-watch-queue] fetch threw');
        db.prepare(
          `UPDATE price_watch_tasks SET status='failed', error_reason=?, finished_at=? WHERE sku = ?`
        ).run(`采集内部错误: ${err?.message || 'unknown'}`, new Date().toISOString(), task.sku);
        continue;
      }

      if (r.status === 'ok') {
        // 快照已落库(快照 status 可能为 ok/empty)
        db.prepare(
          `UPDATE price_watch_tasks SET status='ok', error_reason=NULL, finished_at=? WHERE sku = ?`
        ).run(new Date().toISOString(), task.sku);
      } else if (r.status === 'profile_locked') {
        // 浏览器 profile 被占用:不标记失败,保持 pending 稍后重试
        const lockedSince = db.prepare(`SELECT started_at FROM price_watch_tasks WHERE sku = ?`).get(task.sku)?.started_at;
        const lockedMs = Date.now() - new Date(lockedSince || task.created_at).getTime();
        if (lockedMs >= MAX_PROFILE_LOCKED_WAIT_MS) {
          db.prepare(
            `UPDATE price_watch_tasks SET status='failed', error_reason=?, finished_at=? WHERE sku = ?`
          ).run(r.error || 'profile 长时间被占用', new Date().toISOString(), task.sku);
        } else {
          db.prepare(
            `UPDATE price_watch_tasks SET status='pending', error_reason=? WHERE sku = ?`
          ).run(r.error || 'profile 被占用', task.sku);
          await sleep(RETRY_PROFILE_LOCKED_MS);
        }
      } else if (r.status === 'claimed') {
        // 该 SKU 的 claim 被其他实例持有;若已过期(进程崩溃残留)则清理后重试
        const claim = db.prepare(`SELECT expires_at FROM price_watch_claims WHERE sku = ?`).get(task.sku);
        const claimExpired = claim && new Date(claim.expires_at).getTime() < Date.now();
        if (claimExpired) {
          db.prepare(`DELETE FROM price_watch_claims WHERE sku = ?`).run(task.sku);
          db.prepare(
            `UPDATE price_watch_tasks SET status='pending', error_reason=NULL, started_at=NULL WHERE sku = ?`
          ).run(task.sku);
          continue; // 重新处理该 SKU
        }
        db.prepare(
          `UPDATE price_watch_tasks SET status='failed', error_reason='该 SKU 正在被其他任务采集(定时脚本/其他实例)', finished_at=? WHERE sku = ?`
        ).run(new Date().toISOString(), task.sku);
      } else {
        // antibot / error
        db.prepare(
          `UPDATE price_watch_tasks SET status='failed', error_reason=?, finished_at=? WHERE sku = ?`
        ).run(r.error || r.status, new Date().toISOString(), task.sku);
      }
    }
  } finally {
    logger.info('[price-watch-queue] worker idle');
  }
}

// ── 任务状态查询(前端轮询) ────────────────────────────
export function listPriceWatchTasks(limit = 50) {
  return db
    .prepare(`SELECT sku, status, error_reason, created_at, started_at, finished_at
            FROM price_watch_tasks ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
}