// 商品归档任务路由(2026-08)
// 基于已上架商品单独/批量归档(/v1/product/archive)
// 场景:商品列表页对单个/多个/按筛选条件的商品发起归档(高危操作)
// 轻量任务模型 product_archive_tasks,不复用 batch_upload 框架
// OPI /v1/product/archive 响应只返回整体布尔,无 item 级状态:
//   整批成功 → 所有 item SUCCESS;整批失败 → 所有 item FAILED(可逐个重试)
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import logger from '../middleware/log.js';

const router = Router();

// 从 JSON 字段安全解析
function safeParse(s, fallback) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// products 模式:按 productId + storeId 创建 items(商品列表用)
// 通过 data.id 反查 product_data_cache 提取真正的 offer_id(卖家SKU)
function expandProductsToItems(products) {
  const out = [];
  for (const p of products) {
    if (!p.productId || !p.storeId) continue;
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

// filters 模式:后端直接根据筛选条件展开为 items 列表
// 复用 admin.js GET /admin/api/products 的筛选 SQL 逻辑(简化版,无 idsOnly 二次请求)
// 支持的筛选条件与商品列表页一致:storeId/keyword/productStatus/hasStock/imageIssue/descriptionQuality
function expandFiltersToItems(filters) {
  const f = filters || {};
  const where = [];
  const params = [];

  if (f.keyword) {
    where.push('(sku LIKE ? OR data LIKE ?)');
    const kw = '%' + String(f.keyword) + '%';
    params.push(kw, kw);
  }
  if (f.storeId) {
    where.push('store_id = ?');
    params.push(String(f.storeId));
  }
  if (f.hasStock === '1' || f.hasStock === '0') {
    const v = Number(f.hasStock);
    where.push("COALESCE(json_extract(data, '$.stocks.has_stock'), 0) = ?");
    params.push(v);
  }
  if (f.status) {
    where.push("json_extract(data, '$.statuses.status') = ?");
    params.push(String(f.status));
  }

  // productStatus 筛选(简化状态 5 类)
  let productStatusWhere = '';
  if (f.productStatus) {
    const ps = String(f.productStatus);
    productStatusWhere =
      ` AND (CASE
          WHEN json_extract(data, '$.statuses.is_created') = 0
            THEN 'pending_creation'
          WHEN COALESCE(json_extract(data, '$.statuses.moderate_status'), '') = 'declined'
               OR json_extract(data, '$.statuses.validation_status') = 'fail'
               OR json_extract(data, '$.statuses.status') = 'unmatched'
            THEN 'rejected'
          WHEN json_extract(data, '$.statuses.is_created') = 1
               AND COALESCE(json_extract(data, '$.stocks.has_stock'), 0) = 1
            THEN 'saleable'
          WHEN json_extract(data, '$.statuses.is_created') = 1
               AND COALESCE(json_extract(data, '$.stocks.has_stock'), 0) = 0
            THEN 'created_no_stock'
          ELSE 'other'
         END) = ?`;
    params.push(ps);
  }

  // 图片问题筛选
  if (f.imageIssue === '1' || f.imageIssue === 'true') {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(data, '$.errors')
               WHERE json_each.value->>'$.code' IN
                 ('primary_image_load_failed','pics_http_error',
                  'some_image_failed','all_image_failed','warning_all_image_failed'))`
    );
  }

  // 描述质量筛选
  const descriptionQualityRaw = String(f.descriptionQuality || '').trim();
  const descriptionQuality = /^[0-9]+(,[0-9]+)*$/.test(descriptionQualityRaw)
    ? descriptionQualityRaw
    : '';
  if (descriptionQuality) {
    if (descriptionQuality.includes(',')) {
      const vals = descriptionQuality
        .split(',')
        .map((v) => parseInt(v, 10))
        .filter((v) => Number.isInteger(v) && v >= 0 && v <= 3);
      if (vals.length) {
        where.push(`description_quality IN (${vals.map(() => '?').join(',')})`);
        params.push(...vals);
      }
    } else {
      const v = parseInt(descriptionQuality, 10);
      if (Number.isInteger(v) && v >= 0 && v <= 3) {
        where.push('description_quality = ?');
        params.push(v);
      }
    }
  }

  const baseWhereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const fullWhereSql = baseWhereSql
    ? baseWhereSql + productStatusWhere
    : (productStatusWhere ? 'WHERE 1=1' + productStatusWhere : '');

  const rows = db
    .prepare(
      `SELECT
         COALESCE(json_extract(data, '$.product_id'), json_extract(data, '$.id')) AS productId,
         store_id AS storeId,
         COALESCE(json_extract(data, '$.offer_id'), json_extract(data, '$.sku'), sku) AS offerId
       FROM product_data_cache ${fullWhereSql}
       ORDER BY fetched_at DESC`
    )
    .all(...params);

  // 仅保留有 productId 的记录(无 productId 的商品无法归档)
  return rows
    .filter((r) => r.productId)
    .map((r) => ({
      productId: String(r.productId),
      storeId: r.storeId || '',
      offerId: r.offerId || '',
    }));
}

// 公共函数:创建归档任务(供路由调用)
// items: [{ productId, storeId, offerId? }]
// options: { sourceType? }
export function createProductArchiveTask(items, options = {}) {
  if (!items || items.length === 0) return null;
  const localTaskId = `arc-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const firstStoreId = items[0].storeId;
  const sourceType = options.sourceType || (items.length > 1 ? 'batch' : 'manual');

  db.prepare(
    `INSERT INTO product_archive_tasks
      (local_task_id, store_id, status, total_count, source_type)
     VALUES (?, ?, 'PENDING', ?, ?)`
  ).run(localTaskId, firstStoreId, items.length, sourceType);

  const stmt = db.prepare(
    `INSERT INTO product_archive_items
      (task_id, product_id, store_id, offer_id, status)
     VALUES (?, ?, ?, ?, 'PENDING')`
  );
  for (const it of items) {
    stmt.run(localTaskId, String(it.productId), String(it.storeId), it.offerId || null);
  }
  logger.info({ localTaskId, count: items.length, sourceType }, 'product-archive 任务已创建');
  return { localTaskId, totalCount: items.length };
}

// POST /admin/api/product-archive —— 创建归档任务(单条/批量/按筛选)
// body 支持:
//   { items: [{ productId, storeId, offerId? }] }                       — 精确指定(单条)
//   { products: [{ productId, storeId }] }                              — 按商品列表(批量勾选)
//   { filters: { storeId, keyword, productStatus, hasStock, ... } }     — 按筛选条件展开
router.post('/admin/api/product-archive', (req, res, next) => {
  try {
    const body = req.body || {};
    let items = Array.isArray(body.items) ? body.items : [];
    let sourceType = null;

    if (Array.isArray(body.products) && body.products.length > 0) {
      items = expandProductsToItems(body.products);
      sourceType = 'batch';
    } else if (body.filters && typeof body.filters === 'object') {
      items = expandFiltersToItems(body.filters);
      sourceType = 'filter';
    }

    if (items.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'items/products/filters 必填且展开后非空'));
    }
    for (const it of items) {
      if (!it.productId || !it.storeId) {
        return next(new ApiError(ErrorCode.VALIDATION_ERROR, '每个 item 必须含 productId 和 storeId'));
      }
    }
    const result = createProductArchiveTask(items, { sourceType });
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/product-archive —— 任务列表(分页)
router.get('/admin/api/product-archive', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;
    const where = [];
    const params = [];
    if (req.query.storeId) {
      // 跨店铺任务:items 表任一 item 属于该店铺即命中(task.store_id 只是首个店铺)
      where.push('EXISTS(SELECT 1 FROM product_archive_items WHERE task_id=t.local_task_id AND store_id=?)');
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
           (SELECT GROUP_CONCAT(DISTINCT i.store_id) FROM product_archive_items i WHERE i.task_id=t.local_task_id) AS store_ids_str
         FROM product_archive_tasks t ${whereSql} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    const total = db.prepare(`SELECT COUNT(*) as n FROM product_archive_tasks t ${whereSql}`).get(...params).n;
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

// GET /admin/api/product-archive/:localTaskId —— 任务详情(含 items)
router.get('/admin/api/product-archive/:localTaskId', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const task = db.prepare(`SELECT * FROM product_archive_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '商品归档任务不存在: ' + localTaskId));
    }
    const itemRows = db
      .prepare(`SELECT * FROM product_archive_items WHERE task_id=? ORDER BY id ASC`)
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
          opiResult: safeParse(r.opi_result, null),
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

// POST /admin/api/product-archive/:localTaskId/items/:id/retry —— 重试单项
router.post('/admin/api/product-archive/:localTaskId/items/:id/retry', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const itemId = Number(req.params.id);
    const task = db.prepare(`SELECT * FROM product_archive_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '商品归档任务不存在: ' + localTaskId));
    }
    const item = db.prepare(`SELECT * FROM product_archive_items WHERE id=? AND task_id=?`).get(itemId, localTaskId);
    if (!item) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '任务项不存在'));
    }
    db.prepare(
      `UPDATE product_archive_items SET status='PENDING', error_message=NULL, opi_result=NULL, updated_at=datetime('now') WHERE id=?`
    ).run(itemId);
    // 任务状态回退到 RUNNING(重新调度)
    db.prepare(
      `UPDATE product_archive_tasks SET status='RUNNING', error_message=NULL WHERE local_task_id=?`
    ).run(localTaskId);
    res.json(ok({ ok: true }));
  } catch (e) {
    next(e);
  }
});

export default router;
