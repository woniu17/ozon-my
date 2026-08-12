// 库存更新任务路由(2026-07)
// 基于已上架商品单独/批量更新库存(/v2/products/stocks)
// 场景:商品列表页对单个/多个商品设置库存
// 轻量任务模型 stock_refresh_tasks,不复用 batch_upload 框架
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import logger from '../middleware/log.js';

const router = Router();

// 从 JSON 字段安全解析(容错)
function safeParse(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// products 模式:按 productId + storeId 创建 items(商品列表用)
// productId = Ozon 的 data.id(数字,用于调 OPI 接口)
// offer_id = data.offer_id(卖家SKU,仅展示用,反查 product_data_cache 提取)
function expandProductsToItems(products) {
  const out = [];
  for (const p of products) {
    if (!p.productId || !p.storeId) continue;
    // 通过 data.id 反查 product_data_cache,提取真正的 offer_id(卖家SKU)
    const cache = db
      .prepare(
        `SELECT json_extract(data, '$.offer_id') as offer_id
         FROM product_data_cache
         WHERE store_id=? AND json_extract(data, '$.id')=?`
      )
      .get(String(p.storeId), Number(p.productId));
    const offerId = cache?.offer_id || null;
    out.push({ productId: p.productId, storeId: p.storeId, offerId });
  }
  return out;
}

// 公共函数:创建库存更新任务(供路由调用)
// items: [{ productId, storeId, offerId? }]
// options: { stockValue, sourceType? }
export function createStockRefreshTask(items, options = {}) {
  if (!items || items.length === 0) return null;
  const stockValue = Number(options.stockValue);
  if (!Number.isInteger(stockValue) || stockValue < 0) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, 'stockValue 必须为非负整数');
  }
  const localTaskId = `stk-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const firstStoreId = items[0].storeId;
  const sourceType = options.sourceType || (items.length > 1 ? 'batch' : 'manual');

  db.prepare(
    `INSERT INTO stock_refresh_tasks
      (local_task_id, store_id, status, total_count, stock_value, source_type)
     VALUES (?, ?, 'PENDING', ?, ?, ?)`
  ).run(localTaskId, firstStoreId, items.length, stockValue, sourceType);

  const stmt = db.prepare(
    `INSERT INTO stock_refresh_items
      (task_id, product_id, store_id, offer_id, status, stock_value)
     VALUES (?, ?, ?, ?, 'PENDING', ?)`
  );
  for (const it of items) {
    stmt.run(localTaskId, String(it.productId), String(it.storeId), it.offerId || null, stockValue);
  }
  logger.info({ localTaskId, count: items.length, stockValue, sourceType }, 'stock-refresh 任务已创建');
  return { localTaskId, totalCount: items.length };
}

// POST /admin/api/stock-refresh —— 创建库存更新任务(单条/批量/商品列表)
// body 支持:
//   { items: [{ productId, storeId, offerId? }], stockValue }  — 精确指定(单条)
//   { products: [{ productId, storeId }], stockValue }          — 按商品列表(批量)
router.post('/admin/api/stock-refresh', async (req, res, next) => {
  try {
    const body = req.body || {};
    const stockValue = Number(body.stockValue);
    if (!Number.isInteger(stockValue) || stockValue < 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'stockValue 必须为非负整数'));
    }
    let items = Array.isArray(body.items) ? body.items : [];
    if (Array.isArray(body.products) && body.products.length > 0) {
      items = expandProductsToItems(body.products);
    }
    if (items.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'items/products 必填且展开后非空'));
    }
    for (const it of items) {
      if (!it.productId || !it.storeId) {
        return next(new ApiError(ErrorCode.VALIDATION_ERROR, '每个 item 必须含 productId 和 storeId'));
      }
    }
    const result = createStockRefreshTask(items, { stockValue });
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/stock-refresh —— 任务列表(分页)
router.get('/admin/api/stock-refresh', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;
    const where = [];
    const params = [];
    if (req.query.storeId) {
      // 跨店铺任务:items 表任一 item 属于该店铺即命中(task.store_id 只是首个店铺)
      where.push('EXISTS(SELECT 1 FROM stock_refresh_items WHERE task_id=t.local_task_id AND store_id=?)');
      params.push(String(req.query.storeId));
    }
    if (req.query.status) {
      where.push('status = ?');
      params.push(String(req.query.status));
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db
      .prepare(
        `SELECT t.*,
           (SELECT GROUP_CONCAT(DISTINCT i.store_id) FROM stock_refresh_items i WHERE i.task_id=t.local_task_id) AS store_ids_str
         FROM stock_refresh_tasks t ${whereSql} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    const total = db.prepare(`SELECT COUNT(*) as n FROM stock_refresh_tasks t ${whereSql}`).get(...params).n;
    res.json(
      ok({
        items: rows.map((r) => ({
          localTaskId: r.local_task_id,
          storeId: r.store_id,
          storeIds: r.store_ids_str ? r.store_ids_str.split(',') : [r.store_id],
          status: r.status,
          totalCount: r.total_count,
          successCount: r.success_count,
          failedCount: r.failed_count,
          stockValue: r.stock_value,
          sourceType: r.source_type,
          errorMessage: r.error_message,
          createdAt: r.created_at,
          completedAt: r.completed_at,
        })),
        total,
        current,
        pageSize,
      })
    );
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/stock-refresh/:localTaskId —— 任务详情(含 items)
router.get('/admin/api/stock-refresh/:localTaskId', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const task = db.prepare(`SELECT * FROM stock_refresh_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '库存更新任务不存在: ' + localTaskId));
    }
    const itemRows = db
      .prepare(`SELECT * FROM stock_refresh_items WHERE task_id=? ORDER BY id ASC`)
      .all(localTaskId);
    res.json(
      ok({
        task: {
          localTaskId: task.local_task_id,
          storeId: task.store_id,
          status: task.status,
          totalCount: task.total_count,
          successCount: task.success_count,
          failedCount: task.failed_count,
          stockValue: task.stock_value,
          sourceType: task.source_type,
          errorMessage: task.error_message,
          createdAt: task.created_at,
          completedAt: task.completed_at,
        },
        items: itemRows.map((r) => ({
          id: r.id,
          productId: r.product_id,
          storeId: r.store_id,
          offerId: r.offer_id,
          status: r.status,
          stockValue: r.stock_value,
          opiResult: safeParse(r.opi_result),
          errorMessage: r.error_message,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      })
    );
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/stock-refresh/:localTaskId/items/:id/retry —— 重试单项
router.post('/admin/api/stock-refresh/:localTaskId/items/:id/retry', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const itemId = Number(req.params.id);
    const task = db.prepare(`SELECT * FROM stock_refresh_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '库存更新任务不存在: ' + localTaskId));
    }
    const item = db
      .prepare(`SELECT * FROM stock_refresh_items WHERE id=? AND task_id=?`)
      .get(itemId, localTaskId);
    if (!item) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '任务项不存在'));
    }
    db.prepare(
      `UPDATE stock_refresh_items SET status='PENDING', error_message=NULL, updated_at=datetime('now') WHERE id=?`
    ).run(itemId);
    // 任务状态回退到 RUNNING(重新调度)
    db.prepare(
      `UPDATE stock_refresh_tasks SET status='RUNNING', error_message=NULL WHERE local_task_id=?`
    ).run(localTaskId);
    res.json(ok({ ok: true }));
  } catch (e) {
    next(e);
  }
});

export default router;
