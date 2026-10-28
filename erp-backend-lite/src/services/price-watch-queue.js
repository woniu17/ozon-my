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

// ── 订单触发节流入队(2026-10-27) ──────────────────────
// 新订单同步入库时调用:同一 SKU 近期已有成功快照/任务在跑则跳过,避免每 2 分钟
// 同步轮询反复重置任务、频繁占用 linqx-profile 采集浏览器。
const ORDER_SKU_RECENT_OK_MS = 6 * 3600_000;   // 6h 内已有成功快照/任务 → 不再采集
const ORDER_SKU_RECENT_FAIL_MS = 30 * 60_000;  // 30 分钟内失败过 → 不立即重试
const STALE_RUNNING_MS = 10 * 60_000;          // running 超过 10 分钟视为卡死(进程重启残留),手动获取时重置(2026-10-28)
// force=true(订单处理页"获取跟卖/刷新"按钮):跳过近期成功/失败节流,强制重新入队采集。
export function enqueuePriceWatchForOrderSku(sku, { profileDir, force = false }) {
  const skuStr = String(sku || '').trim();
  if (!/^\d+$/.test(skuStr)) return { status: 'error', error: 'sku 非法' };

  const task = db.prepare(`SELECT status, started_at, finished_at FROM price_watch_tasks WHERE sku = ?`).get(skuStr);
  if (task) {
    if (task.status === 'pending' || task.status === 'running') {
      // 手动"获取跟卖":若任务卡在 running 超过阈值(进程重启残留),删除残留锁并重置为 pending 重新采集(2026-10-28)
      if (force && task.status === 'running' && task.started_at &&
          Date.now() - new Date(task.started_at).getTime() >= STALE_RUNNING_MS) {
        db.prepare(`DELETE FROM price_watch_claims WHERE sku = ?`).run(skuStr);
        db.prepare(
          `UPDATE price_watch_tasks SET status='pending', error_reason=NULL, started_at=NULL, finished_at=NULL WHERE sku = ?`
        ).run(skuStr);
        ensureWorker({ profileDir });
        return { status: 'pending', sku: skuStr };
      }
      return { status: task.status, sku: skuStr };
    }
    const age = task.finished_at ? Date.now() - new Date(task.finished_at).getTime() : Infinity;
    if (!force && task.status === 'ok' && age < ORDER_SKU_RECENT_OK_MS) {
      return { status: 'recent_ok', sku: skuStr };
    }
    if (!force && task.status === 'failed' && age < ORDER_SKU_RECENT_FAIL_MS) {
      return { status: 'recent_failed', sku: skuStr };
    }
  }

  // 快照表兜底:6h 内已采集过(含无跟卖 empty)则跳过(手动刷新时忽略)
  const snap = db
    .prepare(`SELECT fetched_at FROM price_watch_snapshots WHERE sku = ? ORDER BY id DESC LIMIT 1`)
    .get(skuStr);
  if (!force && snap?.fetched_at && Date.now() - new Date(snap.fetched_at).getTime() < ORDER_SKU_RECENT_OK_MS) {
    return { status: 'recent_snapshot', sku: skuStr };
  }

  return enqueuePriceWatch(skuStr, { profileDir });
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
    // 进程重启后可能残留 running 任务(worker 中断,状态未落盘):先全部重置为 pending 重新处理(2026-10-28)
    const stale = db.prepare(`UPDATE price_watch_tasks SET status='pending', error_reason=NULL, started_at=NULL WHERE status='running'`).run();
    if (stale.changes > 0) {
      logger.info({ n: stale.changes }, '[price-watch-queue] reset stale running tasks to pending');
    }
    // 同时清理本进程(pm-% 前缀)残留的采集锁:进程退出时 release 无法执行,残留锁会让
    // SKU 被误判为"其他实例正在采集"直到 TTL 过期(2026-10-28)。定时脚本的锁为 pw- 前缀,不受影响。
    const staleClaims = db.prepare(`DELETE FROM price_watch_claims WHERE instance_id LIKE 'pm-%'`).run();
    if (staleClaims.changes > 0) {
      logger.info({ n: staleClaims.changes }, '[price-watch-queue] released stale pm claims');
    }
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