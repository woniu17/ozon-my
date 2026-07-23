// 跟卖核心路由
// 对齐插件 service-worker.js:
//   - /ozon/products/prepare-bundle-items (viaPortal 6a,120s)
//   - /ozon/products/import (官方 API,120s)
//   - /ozon/products/import/status
//   - /ozon/products/import-by-sku/tasks
//   - /ozon/products/import-by-sku
//   - /ozon/products/import-info (调 OPI 查进度,持久化到 follow_sell_task_items)
//   - /ozon/products/listing-records/report (插件上报 viaPortal 结果)
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { storeGuard } from '../middleware/store.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { prepareBundleItems } from '../services/prepare-bundle.js';
import * as opi from '../services/ozon-opi.js';
import { indexDao } from '../db/dao/sqlite/index-dao.js';
import logger from '../middleware/log.js';
// P2-2:上架核心逻辑抽离到 services/listing-builder.js
// upsertTaskItems/summarizeTaskStatus/saveOpiResponse 从 listing-builder re-export 保持兼容
// executeListing 供 POST /import 和 batch-upload-poller 复用
import {
  upsertTaskItems,
  summarizeTaskStatus,
  saveOpiResponse,
  executeListing,
} from '../services/listing-builder.js';

// re-export 保持现有 import 路径不变(import-status-poller/stock-sync 等仍从 products.js 导入)
export { upsertTaskItems, summarizeTaskStatus, saveOpiResponse };

const router = Router();

// ⭐ POST /ozon/products/prepare-bundle-items (viaPortal=true 第 1 步)
router.post('/ozon/products/prepare-bundle-items', storeGuard, async (req, res, next) => {
  try {
    const message = req.body || {};
    const result = await prepareBundleItems(message, req.storeId, req.store);
    res.json({ result });
  } catch (e) {
    next(e);
  }
});

// POST /ozon/products/import (viaPortal=false,官方 API)
// P2-2:核心逻辑抽到 executeListing,本路由仅做参数传递 + 响应格式化
router.post('/ozon/products/import', storeGuard, async (req, res, next) => {
  try {
    const message = req.body || {};
    const result = await executeListing(message, req.storeId, req.store);
    if (result.error) {
      return res.json({ result: { task_id: null, localTaskId: result.localTaskId, error: result.error } });
    }
    res.json({ result: { task_id: result.ozonTaskId, local_task_id: result.localTaskId } });
  } catch (e) {
    next(e);
  }
});

// POST /ozon/products/import/status
router.post('/ozon/products/import/status', storeGuard, async (req, res, next) => {
  try {
    const { task_id } = req.body || {};
    if (!task_id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'task_id 必填'));

    const row = db
      .prepare(`SELECT * FROM follow_sell_tasks WHERE ozon_task_id=? OR local_task_id=?`)
      .get(String(task_id), String(task_id));
    if (!row) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '任务不存在'));

    // 若未完成,查 OPI 最新状态
    if (row.ozon_task_id && row.status !== 'SUCCESS' && row.status !== 'FAILED') {
      try {
        const info = await opi.productImportInfo(req.store, row.ozon_task_id);
        // 保存 OPI 响应(覆盖式),供「上架记录-详情」展示
        saveOpiResponse(row.local_task_id, row.store_id, info);
        const items = info?.result?.items || [];
        const processed = items.filter((x) => x.status === 'imported').length;
        const failed = items.filter((x) => x.errors?.length).length;
        const size = items.length;
        const done = processed + failed >= size && size > 0;
        if (done) {
          db.prepare(`UPDATE follow_sell_tasks SET status=?, completed_at=datetime('now') WHERE id=?`).run(
            failed > 0 && processed === 0 ? 'FAILED' : 'SUCCESS',
            row.id
          );
        }
        return res.json({
          status: done ? 'success' : 'processing',
          processed,
          failed,
          size,
          done,
          ozon_task_id: row.ozon_task_id,
        });
      } catch (e) {
        logger.warn({ task_id, err: e.message }, 'import/info failed');
      }
    }

    res.json({
      status: row.status.toLowerCase(),
      ozon_task_id: row.ozon_task_id,
      error: row.error_message,
    });
  } catch (e) {
    next(e);
  }
});

// GET /ozon/products/import-by-sku/tasks
router.get('/ozon/products/import-by-sku/tasks', storeGuard, (req, res, next) => {
  try {
    const current = Number(req.query.current) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const offset = (current - 1) * pageSize;

    const rows = db
      .prepare(
        `SELECT local_task_id, status, created_at, error_message, items_preview, via_portal, ozon_task_id
         FROM follow_sell_tasks
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(pageSize, offset);

    const total = db.prepare(`SELECT COUNT(*) as n FROM follow_sell_tasks`).get().n;

    res.json({
      items: rows.map((r) => ({
        localTaskId: r.local_task_id,
        status: r.status,
        createdAt: r.created_at,
        errorMessage: r.error_message,
        itemsPreview: r.items_preview ? JSON.parse(r.items_preview) : [],
        viaPortal: !!r.via_portal,
        ozonTaskId: r.ozon_task_id,
      })),
      total,
      current,
      pageSize,
    });
  } catch (e) {
    next(e);
  }
});

// POST /ozon/products/import-by-sku (简化跟卖)
router.post('/ozon/products/import-by-sku', storeGuard, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'items 不能为空'));
    }
    const localTaskId = `sku-${Date.now()}-${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO follow_sell_tasks
        (local_task_id, via_portal, store_id, status, items_count, items_preview)
       VALUES (?, 0, ?, 'PENDING', ?, ?)`
    ).run(localTaskId, req.storeId, items.length, JSON.stringify(items.slice(0, 5)));

    // 写入上架记录明细(pending 状态)并即时标记 listed
    upsertTaskItems(
      localTaskId,
      items.map((it) => ({
        offer_id: it.offer_id,
        name: it.offer_id,
        price: it.price,
        status: 'pending',
      })),
      req.storeId
    );

    let ozonTaskId = null;
    try {
      const r = await opi.productImport(
        req.store,
        items.map((it) => ({
          name: it.offer_id,
          offer_id: it.offer_id,
          price: it.price,
          vat: it.vat || '0',
          currency_code: it.currency_code || 'RUB',
        }))
      );
      ozonTaskId = r?.result?.task_id ? String(r.result.task_id) : null;
      db.prepare(`UPDATE follow_sell_tasks SET status='PROCESSING', ozon_task_id=? WHERE local_task_id=?`).run(
        ozonTaskId,
        localTaskId
      );
    } catch (e) {
      db.prepare(
        `UPDATE follow_sell_tasks SET status='FAILED', error_message=?, completed_at=datetime('now') WHERE local_task_id=?`
      ).run(e.message, localTaskId);
      // 失败:更新 items 为 failed(listed 已标记,不回退)
      upsertTaskItems(
        localTaskId,
        items.map((it) => ({
          offer_id: it.offer_id,
          name: it.offer_id,
          price: it.price,
          status: 'failed',
          errors: [{ code: 'IMPORT_ERROR', message: e.message }],
        })),
        req.storeId
      );
    }

    const row = db.prepare(`SELECT * FROM follow_sell_tasks WHERE local_task_id=?`).get(localTaskId);
    res.json({
      localTaskId,
      status: row.status,
      ozonTaskId: row.ozon_task_id,
      errorMessage: row.error_message,
    });
  } catch (e) {
    next(e);
  }
});

// POST /ozon/products/info —— 按 offer_id 查询商品最终状态(创建/审核/可售)
// 用于上架后确认商品是否真正创建成功
// 请求体: { offer_ids: ["SKU123", "SKU456"] }
// 响应: { items: [{offer_id, product_id, name, is_created, status, moderate_status,
//                  validation_status, errors[], availabilities[]}] }
router.post('/ozon/products/info', storeGuard, async (req, res, next) => {
  try {
    const offerIds = Array.isArray(req.body?.offer_ids) ? req.body.offer_ids : [];
    if (offerIds.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'offer_ids 必填(数组)'));
    }

    const r = await opi.productInfoList(req.store, offerIds);
    const items = (r?.result?.items || []).map((it) => ({
      offer_id: it.offer_id,
      product_id: it.id,
      name: it.name,
      sku: it.sku,
      is_created: it.statuses?.is_created === true,
      status: it.statuses?.status,
      status_name: it.statuses?.status_name,
      moderate_status: it.statuses?.moderate_status,
      validation_status: it.statuses?.validation_status,
      errors: (it.errors || []).map((e) => ({
        code: e.code,
        message: e.texts?.message || e.message,
        description: e.texts?.description,
        field: e.field,
        attribute_name: e.texts?.attribute_name,
        level: e.level,
      })),
      availabilities: (it.availabilities || []).map((a) => ({
        availability: a.availability,
        reasons: a.reasons || [],
      })),
      price: it.price,
      old_price: it.old_price,
      currency_code: it.currency_code,
      created_at: it.created_at,
      updated_at: it.updated_at,
    }));

    res.json({ items, total: items.length });
  } catch (e) {
    logger.warn({ err: e.message }, 'productInfoList failed');
    next(e);
  }
});

// POST /ozon/products/import-info —— 直接调 OPI /v1/product/import/info 查询任务进度
// 调 OPI 后持久化 items 状态到 follow_sell_task_items(若本地任务存在)
// 请求体: { task_id: 4969404493, local_task_id?: "local-xxx" }
// 响应: { items: [{offer_id, product_id, status, errors[]}], total }
router.post('/ozon/products/import-info', storeGuard, async (req, res, next) => {
  try {
    const { task_id, local_task_id } = req.body || {};
    if (!task_id) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'task_id 必填'));
    }
    const r = await opi.productImportInfo(req.store, task_id);
    // 保存 OPI 响应(覆盖式),供「上架记录-详情」展示
    if (local_task_id) saveOpiResponse(local_task_id, req.storeId, r);
    const items = (r?.result?.items || []).map((it) => ({
      offer_id: it.offer_id,
      product_id: it.product_id,
      status: it.status, // pending / imported / failed / skipped
      errors: (it.errors || []).map((e) => ({
        code: e.code,
        message: e.message,
        field: e.field,
        level: e.level,
        description: e.description,
        attribute_id: e.attribute_id,
        attribute_name: e.attribute_name,
      })),
    }));

    // 持久化:若传入 local_task_id 则 upsert items 并汇总任务状态
    // (viaPortal=false 路径在 import 时已创建 local_task_id;viaPortal 路径由 report 接口写入)
    if (local_task_id) {
      try {
        upsertTaskItems(local_task_id, items, req.storeId);
        summarizeTaskStatus(local_task_id);
      } catch (e) {
        logger.warn({ local_task_id, err: e.message }, 'persist task items failed');
      }
    }

    res.json({ items, total: items.length, task_id: Number(task_id) });
  } catch (e) {
    logger.warn({ err: e.message, task_id: req.body?.task_id }, 'productImportInfo failed');
    next(e);
  }
});

// POST /ozon/products/listing-records/report —— 插件上报上架结果(主要用于 viaPortal=true)
// viaPortal 路径的 6b-6d 由插件直连 seller.ozon.ru 完成,ERP 后端不知结果;
// 插件在上架完成后调此接口上报,使 admin 后台「上架记录」能展示完整数据。
// 请求体:
//   { localTaskId?, viaPortal, storeId, ozonTaskId?, bundleIds?,
//     status: 'SUCCESS'|'FAILED'|'PROCESSING',
//     errorMessage?, items: [{offer_id, name?, price?, product_id?, status, errors?}] }
// 响应: { localTaskId, itemsCount }
router.post('/ozon/products/listing-records/report', storeGuard, async (req, res, next) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'items 不能为空'));
    }

    // 复用已有 localTaskId 或新建
    let localTaskId = body.localTaskId || `report-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const existing = db.prepare(`SELECT id FROM follow_sell_tasks WHERE local_task_id=?`).get(localTaskId);

    if (existing) {
      // 更新已有任务
      db.prepare(
        `UPDATE follow_sell_tasks SET status=?, ozon_task_id=COALESCE(?, ozon_task_id),
         bundle_ids=COALESCE(?, bundle_ids), error_message=?, completed_at=datetime('now')
         WHERE local_task_id=?`
      ).run(
        body.status || 'SUCCESS',
        body.ozonTaskId || null,
        body.bundleIds ? JSON.stringify(body.bundleIds) : null,
        body.errorMessage || null,
        localTaskId
      );
    } else {
      // 新建任务
      db.prepare(
        `INSERT INTO follow_sell_tasks
          (local_task_id, via_portal, store_id, status, items_count, items_preview,
           ozon_task_id, bundle_ids, error_message, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        localTaskId,
        body.viaPortal ? 1 : 0,
        req.storeId,
        body.status || 'SUCCESS',
        items.length,
        JSON.stringify(items.slice(0, 5)),
        body.ozonTaskId || null,
        body.bundleIds ? JSON.stringify(body.bundleIds) : null,
        body.errorMessage || null
      );
    }

    // 写入/更新 items 并即时标记 listed
    upsertTaskItems(localTaskId, items, req.storeId);
    const summary = summarizeTaskStatus(localTaskId);

    logger.info(
      { localTaskId, viaPortal: body.viaPortal, itemsCount: items.length, summary },
      'listing-records reported'
    );
    res.json({ localTaskId, itemsCount: items.length, summary });
  } catch (e) {
    next(e);
  }
});

// GET /ozon/products/payloads/:localTaskId —— 查询某次上架请求的 payload 备份(raw/transformed)
// 用于排查 OPI /v3/product/import 提交的完整数据
router.get('/ozon/products/payloads/:localTaskId', storeGuard, (req, res, next) => {
  try {
    const rows = db
      .prepare(
        `SELECT stage, payload, created_at FROM follow_sell_task_payloads
         WHERE local_task_id=? ORDER BY id ASC`
      )
      .all(req.params.localTaskId);
    res.json({
      localTaskId: req.params.localTaskId,
      stages: rows.map((r) => ({
        stage: r.stage,
        createdAt: r.created_at,
        payload: r.payload ? JSON.parse(r.payload) : null,
      })),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
