// 商品信息更新任务路由(2026-07)
// 通用商品信息更新:基于已上架商品单独/批量更新标题/描述/价格等字段
// 统一走 /v3/product/import 全量重传(数据源=Ozon 实时数据,只替换用户指定字段)
// 可拓展:每个可更新字段对应一个 FieldUpdater,新增字段不改表结构
// 对齐 image-refresh / stock-refresh 轻量任务模型
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import config from '../config/index.js';
import * as opi from '../services/ozon-opi.js';
import { applyFieldUpdaters, getSupportedFields } from '../services/field-updaters/index.js';
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

// 校验 updateFields + newValues 一致性
function validateItemFields(item) {
  const fields = Array.isArray(item.updateFields) ? item.updateFields : [];
  if (fields.length === 0) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, 'updateFields 不能为空');
  }
  const supported = new Set(getSupportedFields());
  for (const f of fields) {
    if (!supported.has(f)) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, `不支持的更新字段: ${f}`);
    }
  }
  const newValues = item.newValues || {};
  for (const f of fields) {
    if (newValues[f] === undefined) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, `newValues 缺少字段: ${f}`);
    }
  }
  return { fields, newValues };
}

// POST /admin/api/product-update —— 创建任务(单条或批量)
// body: { storeId, items: [{ productId, offerId, updateFields:[...], newValues:{...} }] }
router.post('/admin/api/product-update', (req, res, next) => {
  try {
    const body = req.body || {};
    const storeId = String(body.storeId || '');
    if (!storeId) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeId 必填'));
    }
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'items 必填且非空'));
    }

    // 校验所有 item + 汇总任务级 update_fields(并集)
    const taskFieldsSet = new Set();
    for (const it of items) {
      if (!it.productId || !it.offerId) {
        return next(new ApiError(ErrorCode.VALIDATION_ERROR, '每个 item 必须含 productId 和 offerId'));
      }
      const { fields } = validateItemFields(it);
      for (const f of fields) taskFieldsSet.add(f);
    }

    const localTaskId = `pu-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const taskFields = Array.from(taskFieldsSet);
    const sourceType = items.length > 1 ? 'batch' : 'manual';

    db.prepare(
      `INSERT INTO product_update_tasks
        (local_task_id, store_id, status, total_count, update_fields, source_type)
       VALUES (?, ?, 'PENDING', ?, ?, ?)`
    ).run(localTaskId, storeId, items.length, JSON.stringify(taskFields), sourceType);

    const stmt = db.prepare(
      `INSERT INTO product_update_items
        (task_id, product_id, offer_id, store_id, status, update_fields, new_values)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`
    );
    for (const it of items) {
      stmt.run(
        localTaskId,
        String(it.productId),
        String(it.offerId),
        String(it.storeId || storeId),
        JSON.stringify(it.updateFields),
        JSON.stringify(it.newValues)
      );
    }
    logger.info({ localTaskId, storeId, count: items.length, fields: taskFields, sourceType }, 'product-update 任务已创建');
    res.json(ok({ localTaskId, totalCount: items.length, updateFields: taskFields }));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/product-update —— 任务列表(分页)
router.get('/admin/api/product-update', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;
    const where = [];
    const params = [];
    if (req.query.storeId) {
      where.push('store_id = ?');
      params.push(String(req.query.storeId));
    }
    if (req.query.status) {
      where.push('status = ?');
      params.push(String(req.query.status));
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db
      .prepare(`SELECT * FROM product_update_tasks ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);
    const total = db.prepare(`SELECT COUNT(*) as n FROM product_update_tasks ${whereSql}`).get(...params).n;
    res.json(
      ok({
        items: rows.map((r) => ({
          localTaskId: r.local_task_id,
          storeId: r.store_id,
          status: r.status,
          totalCount: r.total_count,
          successCount: r.success_count,
          failedCount: r.failed_count,
          updateFields: safeParse(r.update_fields, []),
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

// GET /admin/api/product-update/supported-fields —— 查询当前支持更新的字段列表
router.get('/admin/api/product-update/supported-fields', (_req, res) => {
  res.json(ok({ fields: getSupportedFields() }));
});

// GET /admin/api/product-update/:localTaskId —— 任务详情(含 items,分页)
// query: page=1&pageSize=50(默认 50,最大 200);不传则默认 page=1&pageSize=50
// 返回 { task, items, total, page, pageSize }
router.get('/admin/api/product-update/:localTaskId', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const task = db.prepare(`SELECT * FROM product_update_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '商品信息更新任务不存在: ' + localTaskId));
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM product_update_items WHERE task_id=?`)
      .get(localTaskId).n;
    const itemRows = db
      .prepare(`SELECT * FROM product_update_items WHERE task_id=? ORDER BY id ASC LIMIT ? OFFSET ?`)
      .all(localTaskId, pageSize, offset);
    res.json(
      ok({
        task: {
          localTaskId: task.local_task_id,
          storeId: task.store_id,
          status: task.status,
          totalCount: task.total_count,
          successCount: task.success_count,
          failedCount: task.failed_count,
          updateFields: safeParse(task.update_fields, []),
          sourceType: task.source_type,
          errorMessage: task.error_message,
          createdAt: task.created_at,
          completedAt: task.completed_at,
        },
        items: itemRows.map((r) => ({
          id: r.id,
          productId: r.product_id,
          offerId: r.offer_id,
          storeId: r.store_id,
          status: r.status,
          updateFields: safeParse(r.update_fields, []),
          newValues: safeParse(r.new_values, {}),
          opiTaskId: r.opi_task_id,
          opiResult: r.opi_result ? safeParse(r.opi_result, null) : null,
          errorMessage: r.error_message,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
        total,
        page,
        pageSize,
      })
    );
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/product-update/:localTaskId/cancel —— 取消未处理 items
router.post('/admin/api/product-update/:localTaskId/cancel', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const task = db.prepare(`SELECT * FROM product_update_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '商品信息更新任务不存在: ' + localTaskId));
    }
    if (task.status === 'SUCCESS' || task.status === 'FAILED' || task.status === 'PARTIAL') {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, `任务已终态(${task.status}),不可取消`));
    }
    // 把所有 PENDING items 标记为 FAILED(取消)
    const result = db
      .prepare(
        `UPDATE product_update_items SET status='FAILED', error_message='用户取消', updated_at=datetime('now')
         WHERE task_id=? AND status='PENDING'`
      )
      .run(localTaskId);
    // 重算任务状态
    const stats = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) as s,
           SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) as f,
           COUNT(*) as t
         FROM product_update_items WHERE task_id=?`
      )
      .get(localTaskId);
    const newStatus = stats.s === 0 ? 'FAILED' : stats.f === 0 ? 'SUCCESS' : 'PARTIAL';
    db.prepare(
      `UPDATE product_update_tasks SET status=?, success_count=?, failed_count=?, completed_at=datetime('now') WHERE local_task_id=?`
    ).run(newStatus, stats.s || 0, stats.f || 0, localTaskId);
    logger.info({ localTaskId, cancelled: result.changes, newStatus }, 'product-update 任务已取消');
    res.json(ok({ cancelled: result.changes, status: newStatus }));
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/product-update/:localTaskId/items/:id/retry —— 重试单个失败 item
router.post('/admin/api/product-update/:localTaskId/items/:id/retry', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const itemId = Number(req.params.id);
    const task = db.prepare(`SELECT * FROM product_update_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '商品信息更新任务不存在: ' + localTaskId));
    }
    const item = db.prepare(`SELECT * FROM product_update_items WHERE id=? AND task_id=?`).get(itemId, localTaskId);
    if (!item) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '任务项不存在'));
    }
    db.prepare(
      `UPDATE product_update_items SET status='PENDING', error_message=NULL, opi_task_id=NULL, opi_result=NULL, updated_at=datetime('now') WHERE id=?`
    ).run(itemId);
    // 任务状态回退到 RUNNING(重新调度)
    db.prepare(`UPDATE product_update_tasks SET status='RUNNING', error_message=NULL WHERE local_task_id=?`).run(
      localTaskId
    );
    res.json(ok({ ok: true }));
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/product-update/preview —— 预览:根据 offer_id 拉当前商品信息
// body: { storeId, offerId }
// 响应: { item: { productId, offerId, name, description, price, oldPrice, minPrice, ... } }
router.post('/admin/api/product-update/preview', async (req, res, next) => {
  try {
    const body = req.body || {};
    const storeId = String(body.storeId || '');
    const offerId = String(body.offerId || '');
    if (!storeId || !offerId) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeId 和 offerId 必填'));
    }
    const store = config.loadStores().find((s) => s.id === storeId);
    if (!store) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '店铺不存在: ' + storeId));
    }

    // 拉顶层信息(含 name/price)
    const pInfoResp = await opi.productInfoList(store, [offerId]);
    const pInfo = pInfoResp?.items?.[0];
    if (!pInfo) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `Ozon 未查到商品 offer_id=${offerId}`));
    }
    const productId = Number(pInfo.id);

    // 拉属性(含描述 4191)
    let description = '';
    if (productId) {
      const pAttrsResp = await opi.productInfoAttributes(store, { product_id: [productId] });
      const pAttrs = pAttrsResp?.result?.[0];
      const descAttr = (pAttrs?.attributes || []).find((a) => Number(a.id) === 4191);
      description = descAttr?.values?.map((v) => v.value).join('\n') || '';
    }

    res.json(
      ok({
        productId: String(productId || ''),
        offerId: String(pInfo.offer_id || offerId),
        name: String(pInfo.name || ''),
        description,
        price: pInfo.price ? String(pInfo.price) : '',
        oldPrice: pInfo.old_price ? String(pInfo.old_price) : '',
        minPrice: pInfo.min_price ? String(pInfo.min_price) : '',
        currencyCode: pInfo.currency_code || 'RUB',
      })
    );
  } catch (e) {
    next(e);
  }
});

export default router;
