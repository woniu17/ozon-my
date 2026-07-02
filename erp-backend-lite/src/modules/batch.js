// 批量上架任务路由(P2-1)
// - batch_upload_tasks: 批量任务汇总(进度/状态)
// - batch_upload_items: 每个商品明细(关联 follow_sell_tasks.local_task_id)
//
// P2-1 仅提供 CRUD 骨架;实际逐条上架执行逻辑由 P2-2(batch-upload 接入 ERP)完善
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { ok } from '../utils/response.js';

const router = Router();

function parseJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rowToTask(r) {
  if (!r) return null;
  return {
    id: r.id,
    localTaskId: r.local_task_id,
    storeId: r.store_id,
    status: r.status,
    totalCount: r.total_count,
    successCount: r.success_count,
    failedCount: r.failed_count,
    config: parseJson(r.config),
    errorMessage: r.error_message,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

function rowToItem(r) {
  if (!r) return null;
  return {
    id: r.id,
    batchTaskId: r.batch_task_id,
    sourceSku: r.source_sku,
    sourceUrl: r.source_url,
    followTaskId: r.follow_task_id,
    status: r.status,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── 创建批量上架任务 ────────────────────────────────────────
// body: { storeId, items: [{ sourceSku, sourceUrl }], config? }
router.post('/ozon/products/batch-import', (req, res, next) => {
  try {
    const { storeId, items, config } = req.body || {};
    if (!storeId) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeId 必填'));
    if (!Array.isArray(items) || items.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'items 必填且非空'));
    }
    const localTaskId = 'batch-' + randomUUID().slice(0, 8);
    const configJson = config != null ? JSON.stringify(config) : null;
    db.prepare(
      `INSERT INTO batch_upload_tasks (local_task_id, store_id, status, total_count, config)
       VALUES (?, ?, 'PENDING', ?, ?)`
    ).run(localTaskId, storeId, items.length, configJson);

    const stmtItem = db.prepare(
      `INSERT INTO batch_upload_items (batch_task_id, source_sku, source_url, status)
       VALUES (?, ?, ?, 'PENDING')`
    );
    for (const it of items) {
      stmtItem.run(localTaskId, it.sourceSku || null, it.sourceUrl || null);
    }

    const row = db.prepare(`SELECT * FROM batch_upload_tasks WHERE local_task_id=?`).get(localTaskId);
    res.status(201).json(ok(rowToTask(row)));
  } catch (e) {
    next(e);
  }
});

// ── 批量任务列表(分页) ─────────────────────────────────────
router.get('/ozon/products/batch-import', (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.currentPage, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * size;
    const where = [];
    const params = [];
    if (req.query.storeId) {
      where.push('store_id = ?');
      params.push(req.query.storeId);
    }
    if (req.query.status) {
      where.push('status = ?');
      params.push(req.query.status);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM batch_upload_tasks ${whereSql}`).get(...params).n;
    const rows = db
      .prepare(`SELECT * FROM batch_upload_tasks ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, size, offset);
    res.json(ok({ items: rows.map(rowToTask), total, currentPage: page, pageSize: size }));
  } catch (e) {
    next(e);
  }
});

// ── 批量任务详情(含明细) ───────────────────────────────────
router.get('/ozon/products/batch-import/:localTaskId', (req, res, next) => {
  try {
    const task = db.prepare(`SELECT * FROM batch_upload_tasks WHERE local_task_id=?`).get(req.params.localTaskId);
    if (!task) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '批量任务不存在'));
    const items = db
      .prepare(`SELECT * FROM batch_upload_items WHERE batch_task_id=? ORDER BY id ASC`)
      .all(req.params.localTaskId);
    res.json(ok({ ...rowToTask(task), items: items.map(rowToItem) }));
  } catch (e) {
    next(e);
  }
});

// ── 删除批量任务(含明细) ───────────────────────────────────
router.delete('/ozon/products/batch-import/:localTaskId', (req, res, next) => {
  try {
    const task = db.prepare(`SELECT * FROM batch_upload_tasks WHERE local_task_id=?`).get(req.params.localTaskId);
    if (!task) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '批量任务不存在'));
    db.prepare(`DELETE FROM batch_upload_items WHERE batch_task_id=?`).run(req.params.localTaskId);
    db.prepare(`DELETE FROM batch_upload_tasks WHERE local_task_id=?`).run(req.params.localTaskId);
    res.json(ok({ deleted: 1 }));
  } catch (e) {
    next(e);
  }
});

// ── 重试失败项 ─────────────────────────────────────────────
router.post('/ozon/products/batch-import/:localTaskId/retry', (req, res, next) => {
  try {
    const task = db.prepare(`SELECT * FROM batch_upload_tasks WHERE local_task_id=?`).get(req.params.localTaskId);
    if (!task) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '批量任务不存在'));
    const result = db
      .prepare(
        `UPDATE batch_upload_items SET status='PENDING', error_message=NULL, updated_at=datetime('now')
         WHERE batch_task_id=? AND status='FAILED'`
      )
      .run(req.params.localTaskId);
    // 任务回到 RUNNING(等待 P2-2 执行器重新处理)
    if (result.changes > 0) {
      db.prepare(
        `UPDATE batch_upload_tasks SET status='RUNNING', error_message=NULL WHERE local_task_id=? AND status IN ('FAILED','PARTIAL')`
      ).run(req.params.localTaskId);
    }
    res.json(ok({ resetCount: result.changes }));
  } catch (e) {
    next(e);
  }
});

// ── admin 用:批量任务列表(同 /ozon/products/batch-import,便于 admin 前端语义) ──
router.get('/admin/api/batch-tasks', (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.currentPage, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * size;
    const where = [];
    const params = [];
    if (req.query.storeId) {
      where.push('store_id = ?');
      params.push(req.query.storeId);
    }
    if (req.query.status) {
      where.push('status = ?');
      params.push(req.query.status);
    }
    if (req.query.keyword) {
      where.push('local_task_id LIKE ?');
      params.push('%' + req.query.keyword + '%');
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM batch_upload_tasks ${whereSql}`).get(...params).n;
    const rows = db
      .prepare(`SELECT * FROM batch_upload_tasks ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, size, offset);
    res.json(ok({ items: rows.map(rowToTask), total, currentPage: page, pageSize: size }));
  } catch (e) {
    next(e);
  }
});

export default router;
