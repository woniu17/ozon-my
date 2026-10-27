// 定时任务执行日志查询 API(2026-10-27)
// 供前端「定时任务日志」页按 分钟级/小时级/天级 三个 Tab 排查任务执行情况。
//
// 路由:
//   GET /admin/api/task-logs/tasks   任务定义列表(名称/级别/频率)
//   GET /admin/api/task-logs/latest  每个任务最近一次执行(概览卡)
//   GET /admin/api/task-logs         分页查询日志
//
// 打点写入在 src/services/task-run-log.js,各定时任务启动时调用。
// 保留期清理:startTaskLogRetention()(app.js 启动时挂载,每日一次,默认 30 天)
import { Router } from 'express';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';
import { listTaskDefs } from '../services/task-run-log.js';

const router = Router();

const VALID_LEVELS = new Set(['minute', 'hour', 'day']);
const VALID_STATUS = new Set(['success', 'failed', 'skipped', 'running']);

// GET /admin/api/task-logs/tasks
router.get('/admin/api/task-logs/tasks', (_req, res, next) => {
  try {
    res.json(ok(listTaskDefs()));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/task-logs/latest?level=minute
// 每个任务最近一条执行记录(按任务去重),供概览卡展示最近状态/时间。
router.get('/admin/api/task-logs/latest', (req, res, next) => {
  try {
    const level = String(req.query.level || '').trim();
    if (level && !VALID_LEVELS.has(level)) {
      return res.status(400).json({ ok: false, error: `level 必须是 minute/hour/day 之一` });
    }
    let rows;
    if (level) {
      rows = db
        .prepare(
          `SELECT * FROM task_run_logs t
           WHERE t.level = ? AND t.id = (SELECT MAX(id) FROM task_run_logs WHERE task = t.task)`
        )
        .all(level);
    } else {
      rows = db
        .prepare(
          `SELECT * FROM task_run_logs t
           WHERE t.id = (SELECT MAX(id) FROM task_run_logs WHERE task = t.task)`
        )
        .all();
    }
    res.json(ok(rows));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/task-logs?level=&task=&status=&from=&to=&keyword=&page=&pageSize=
// from/to 为 UTC ISO 字符串(按 started_at 过滤)
router.get('/admin/api/task-logs', (req, res, next) => {
  try {
    const level = String(req.query.level || '').trim();
    const task = String(req.query.task || '').trim();
    const status = String(req.query.status || '').trim();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 200);

    if (level && !VALID_LEVELS.has(level)) {
      return res.status(400).json({ ok: false, error: `level 必须是 minute/hour/day 之一` });
    }
    if (status && !VALID_STATUS.has(status)) {
      return res.status(400).json({ ok: false, error: `status 必须是 success/failed/skipped/running 之一` });
    }

    const conds = [];
    const params = [];
    if (level) {
      conds.push('level = ?');
      params.push(level);
    }
    if (task) {
      conds.push('task = ?');
      params.push(task);
    }
    if (status) {
      conds.push('status = ?');
      params.push(status);
    }
    if (from) {
      conds.push('started_at >= ?');
      params.push(from);
    }
    if (to) {
      conds.push('started_at <= ?');
      params.push(to);
    }
    if (keyword) {
      conds.push('(name LIKE ? OR detail LIKE ? OR error LIKE ?)');
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
    }
    const whereSql = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS n FROM task_run_logs${whereSql}`).get(...params).n;
    const list = db
      .prepare(`SELECT * FROM task_run_logs${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);
    // 筛选窗口内状态分布(不分页),供前端展示成功率
    const stats = { success: 0, failed: 0, skipped: 0, running: 0 };
    for (const row of db.prepare(`SELECT status, COUNT(*) AS n FROM task_run_logs${whereSql} GROUP BY status`).all(...params)) {
      if (row.status in stats) stats[row.status] = row.n;
    }

    res.json(ok({ list, total, page, pageSize, stats }));
  } catch (e) {
    next(e);
  }
});

// ── 保留期清理(每日一次,默认 30 天) ────────────────────────
let retentionTimer = null;

export function startTaskLogRetention() {
  if (retentionTimer) return;
  const run = () => {
    try {
      const days = Math.max(3, Number(process.env.TASK_LOG_RETENTION_DAYS) || 30);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const r = db.prepare(`DELETE FROM task_run_logs WHERE created_at < ?`).run(cutoff);
      if (r.changes > 0) {
        logger.info({ deleted: r.changes, cutoff }, '[task-logs] 保留期清理完成');
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[task-logs] 保留期清理失败');
    }
  };
  // 启动 10 分钟后首次执行(错开启动高峰),此后每日一次
  retentionTimer = setTimeout(() => {
    run();
    retentionTimer = setInterval(run, 24 * 60 * 60 * 1000);
    retentionTimer.unref?.();
  }, 10 * 60 * 1000);
  retentionTimer.unref?.();
}

export function stopTaskLogRetention() {
  if (retentionTimer) {
    clearTimeout(retentionTimer);
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}

export default router;