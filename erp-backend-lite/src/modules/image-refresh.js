// 图片更新任务路由(2026-07)
// 基于已上架商品单独/批量重提图片(/v1/product/pictures/import)
// 场景:上架后图片有问题(审核拒绝/抓取失败/无效图),在「上架记录页」发起更新
// 轻量任务模型 image_refresh_tasks,不复用 batch_upload 框架
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import config from '../config/index.js';
import * as opi from '../services/ozon-opi.js';
import logger from '../middleware/log.js';

const router = Router();

// 从 JSON 字段安全解析数组
function safeParseArr(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// 批量模式:把上架记录展开为图片问题 items
// 纳入条件:has_error=1 且 errors 含图片关键词 OR 该记录 invalid_image 非空(所有 items)
function expandRecordsToItems(records) {
  const out = [];
  for (const rec of records) {
    if (!rec.sourceTaskId || !rec.storeId) continue;
    // 查该记录的图片问题 items(has_error + errors 含图片关键词)
    const problemRows = db
      .prepare(
        `SELECT offer_id, product_id FROM follow_sell_task_items
         WHERE local_task_id=? AND has_error=1
           AND (errors LIKE '%image%' OR errors LIKE '%photo%' OR errors LIKE '%picture%'
                OR errors LIKE '%图片%' OR errors LIKE '%照片%')`
      )
      .all(rec.sourceTaskId);
    let rows = problemRows;
    // invalid_image 非空:该记录被预检标记无效图,所有 items 都需更新图片
    const t = db.prepare(`SELECT invalid_image FROM follow_sell_tasks WHERE local_task_id=?`).get(rec.sourceTaskId);
    if (t?.invalid_image && t.invalid_image !== '[]' && t.invalid_image !== '') {
      const allRows = db
        .prepare(`SELECT offer_id, product_id FROM follow_sell_task_items WHERE local_task_id=?`)
        .all(rec.sourceTaskId);
      const seen = new Set(rows.map((r) => r.offer_id));
      for (const r of allRows) {
        if (!seen.has(r.offer_id)) {
          rows.push(r);
          seen.add(r.offer_id);
        }
      }
    }
    for (const r of rows) {
      if (r.product_id) {
        out.push({ sourceTaskId: rec.sourceTaskId, offerId: r.offer_id, productId: r.product_id, storeId: rec.storeId });
      }
    }
  }
  return out;
}

// products 模式:按 productId + storeId 创建 items(商品列表用,不限图片问题)
// productId = Ozon 的 data.id(数字,用于调 OPI 接口)
// offer_id = data.offer_id(卖家SKU,用于关联 follow_sell_task_items)
// 注意:product_data_cache.sku 字段存的是 FBS 变体 SKU(data.sku),不能用作 offer_id
function expandProductsToItems(products) {
  const out = [];
  for (const p of products) {
    if (!p.productId || !p.storeId) continue;
    // 通过 data.id 反查 product_data_cache,提取真正的 offer_id(卖家SKU)
    // json_extract 返回数字,productId 需转 Number 才能匹配
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

// 图片错误判定:errors 数组中含图片相关错误(code/field/message 命中关键词)
export function hasImageErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  const KW = ['image', 'photo', 'picture', 'pics', '图片', '照片'];
  return errors.some((e) => {
    const text = `${e.code || ''} ${e.field || ''} ${e.message || ''} ${e.description || ''}`.toLowerCase();
    return KW.some((k) => text.includes(k.toLowerCase()));
  });
}

// 公共函数:创建图片更新任务(供路由 + import-status-poller 自动触发调用)
// items: [{ productId, storeId, sourceTaskId?, offerId?, sourceImages? }]
// options: { templateId?, sourceType? }
export function createImageRefreshTask(items, options = {}) {
  if (!items || items.length === 0) return null;
  const templateId = options.templateId ? Number(options.templateId) || null : null;
  const localTaskId = `img-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const firstStoreId = items[0].storeId;
  const sourceType = options.sourceType || (items.length > 1 ? 'batch' : 'manual');

  db.prepare(
    `INSERT INTO image_refresh_tasks
      (local_task_id, store_id, status, total_count, template_id, source_type)
     VALUES (?, ?, 'PENDING', ?, ?, ?)`
  ).run(localTaskId, firstStoreId, items.length, templateId, sourceType);

  const stmt = db.prepare(
    `INSERT INTO image_refresh_items
      (task_id, source_task_id, source_item_offer_id, product_id, store_id, status, source_images)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`
  );
  for (const it of items) {
    const srcImgs = Array.isArray(it.sourceImages) && it.sourceImages.length > 0 ? it.sourceImages : null;
    stmt.run(
      localTaskId,
      it.sourceTaskId || null,
      it.offerId || null,
      String(it.productId),
      String(it.storeId),
      srcImgs ? JSON.stringify(srcImgs) : null
    );
  }
  logger.info({ localTaskId, count: items.length, templateId, sourceType }, 'image-refresh 任务已创建');
  return { localTaskId, totalCount: items.length };
}

// POST /admin/api/image-refresh —— 创建图片更新任务(单条/批量/商品列表)
// body 支持:
//   { items: [...], templateId? }              — 精确指定(单条/上架记录详情)
//   { records: [{sourceTaskId, storeId}], ... } — 按上架记录展开图片问题 items
//   { products: [{productId, storeId}], ... }   — 按商品列表(不限图片问题)
router.post('/admin/api/image-refresh', async (req, res, next) => {
  try {
    const body = req.body || {};
    let items = Array.isArray(body.items) ? body.items : [];
    if (Array.isArray(body.records) && body.records.length > 0) {
      items = expandRecordsToItems(body.records);
    } else if (Array.isArray(body.products) && body.products.length > 0) {
      items = expandProductsToItems(body.products);
    }
    if (items.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'items/records/products 必填且展开后非空'));
    }
    for (const it of items) {
      if (!it.productId || !it.storeId) {
        return next(new ApiError(ErrorCode.VALIDATION_ERROR, '每个 item 必须含 productId 和 storeId'));
      }
    }
    const result = createImageRefreshTask(items, { templateId: body.templateId });
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/image-refresh —— 任务列表(分页)
router.get('/admin/api/image-refresh', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;
    const where = [];
    const params = [];
    if (req.query.storeId) {
      // 跨店铺任务:items 表任一 item 属于该店铺即命中(task.store_id 只是首个店铺)
      where.push('EXISTS(SELECT 1 FROM image_refresh_items WHERE task_id=t.local_task_id AND store_id=?)');
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
           (SELECT GROUP_CONCAT(DISTINCT i.store_id) FROM image_refresh_items i WHERE i.task_id=t.local_task_id) AS store_ids_str
         FROM image_refresh_tasks t ${whereSql} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    const total = db.prepare(`SELECT COUNT(*) as n FROM image_refresh_tasks t ${whereSql}`).get(...params).n;
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
          templateId: r.template_id,
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

// GET /admin/api/image-refresh/:localTaskId —— 任务详情(含 items)
router.get('/admin/api/image-refresh/:localTaskId', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const task = db.prepare(`SELECT * FROM image_refresh_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '图片更新任务不存在: ' + localTaskId));
    }
    const itemRows = db
      .prepare(`SELECT * FROM image_refresh_items WHERE task_id=? ORDER BY id ASC`)
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
          templateId: task.template_id,
          sourceType: task.source_type,
          errorMessage: task.error_message,
          createdAt: task.created_at,
          completedAt: task.completed_at,
        },
        items: itemRows.map((r) => ({
          id: r.id,
          sourceTaskId: r.source_task_id,
          offerId: r.source_item_offer_id,
          productId: r.product_id,
          storeId: r.store_id,
          status: r.status,
          sourceImages: safeParseArr(r.source_images),
          processedImages: safeParseArr(r.processed_images),
          opiResult: r.opi_result ? safeParseArr(r.opi_result) : null,
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

// POST /admin/api/image-refresh/:localTaskId/items/:id/retry —— 重试单项
router.post('/admin/api/image-refresh/:localTaskId/items/:id/retry', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const itemId = Number(req.params.id);
    const task = db.prepare(`SELECT * FROM image_refresh_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '图片更新任务不存在: ' + localTaskId));
    }
    const item = db
      .prepare(`SELECT * FROM image_refresh_items WHERE id=? AND task_id=?`)
      .get(itemId, localTaskId);
    if (!item) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '任务项不存在'));
    }
    db.prepare(
      `UPDATE image_refresh_items SET status='PENDING', error_message=NULL, updated_at=datetime('now') WHERE id=?`
    ).run(itemId);
    // 任务状态回退到 RUNNING(重新调度)
    db.prepare(
      `UPDATE image_refresh_tasks SET status='RUNNING', error_message=NULL WHERE local_task_id=?`
    ).run(localTaskId);
    res.json(ok({ ok: true }));
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/products/:productId/pictures-info —— 实时查单个商品图片状态
// body: { storeId } —— 商品所属店铺(用其 OPI 凭据)
// 响应: { item: { primary_photo, photo, color_photo, photo_360, errors } }
router.post('/admin/api/products/:productId/pictures-info', async (req, res, next) => {
  try {
    const productId = String(req.params.productId);
    const storeId = req.body?.storeId || '';
    if (!storeId) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeId 必填'));
    }
    const store = config.loadStores().find((s) => s.id === storeId);
    if (!store) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '店铺不存在: ' + storeId));
    }
    const r = await opi.productPicturesInfo(store, [productId]);
    const items = r?.items || [];
    const found = items.find((it) => String(it.product_id) === productId);
    if (!found) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, 'OPI 未返回该商品的图片信息'));
    }
    res.json(
      ok({
        productId: found.product_id,
        primaryPhoto: found.primary_photo || [],
        photo: found.photo || [],
        colorPhoto: found.color_photo || [],
        photo360: found.photo_360 || [],
        errors: found.errors || [],
      })
    );
  } catch (e) {
    next(e);
  }
});

export default router;
