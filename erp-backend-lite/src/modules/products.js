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

const router = Router();

// ── 内部工具:写入/更新上架记录明细 ───────────────────────
// upsert:已存在则更新 status/product_id/errors,不存在则插入
export function upsertTaskItems(localTaskId, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO follow_sell_task_items (local_task_id, offer_id, name, price, product_id, status, errors)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_task_id, offer_id) DO UPDATE SET
      product_id = excluded.product_id,
      status = excluded.status,
      errors = excluded.errors,
      updated_at = datetime('now')
  `);
  for (const it of items) {
    const offerId = String(it.offer_id || '');
    if (!offerId) continue;
    stmt.run(
      localTaskId,
      offerId,
      it.name || null,
      it.price || null,
      it.product_id ? String(it.product_id) : null,
      it.status || 'pending',
      Array.isArray(it.errors) && it.errors.length > 0 ? JSON.stringify(it.errors) : null
    );
  }
  // fire-and-forget:刷新 ozon_cache_index.listed 字段
  // 让数据管理页"已跟卖"列即时更新(避免等 5 分钟定时任务)
  indexDao.refreshListedStatus().catch((e) => {
    logger.warn({ err: e.message }, 'refreshListedStatus after upsertTaskItems failed');
  });
}

// 按 items 状态汇总任务状态
export function summarizeTaskStatus(localTaskId) {
  const rows = db.prepare(`SELECT status FROM follow_sell_task_items WHERE local_task_id=?`).all(localTaskId);
  if (rows.length === 0) return null;
  const imported = rows.filter((r) => r.status === 'imported').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const pending = rows.filter((r) => r.status === 'pending' || r.status === 'skipped').length;
  let status;
  if (pending > 0) status = 'PROCESSING';
  else if (imported === 0 && failed > 0) status = 'FAILED';
  else if (failed > 0)
    status = 'SUCCESS'; // 部分成功
  else status = 'SUCCESS';
  db.prepare(
    `UPDATE follow_sell_tasks SET status=?, completed_at=datetime('now') WHERE local_task_id=? AND status NOT IN ('SUCCESS','FAILED')`
  ).run(status, localTaskId);
  return { status, imported, failed, pending, total: rows.length };
}

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
router.post('/ozon/products/import', storeGuard, async (req, res, next) => {
  try {
    const message = req.body || {};
    const items = Array.isArray(message.items) ? message.items : [];
    const localTaskId = `local-${Date.now()}-${randomUUID().slice(0, 8)}`;

    // 库存快照:任务创建时记录模板 defaultStock + templateId
    // 后续模板修改不影响本任务(stock-sync.js 据此设库存)
    const stockSnapshot = Math.max(0, Math.min(100000, Number(message.defaultStock) || 0));
    const templateId = Number(message.templateId) || null;

    // 备份插件原始请求体(raw),便于排查
    try {
      db.prepare(
        `INSERT INTO follow_sell_task_payloads (local_task_id, store_id, stage, payload) VALUES (?, ?, 'raw', ?)`
      ).run(localTaskId, req.storeId, JSON.stringify(items));
    } catch (e) {
      logger.warn({ localTaskId, err: e.message }, 'backup raw payload failed');
    }

    // 入库 PENDING(含库存快照,供 stock-sync.js 定时任务读取)
    db.prepare(
      `INSERT INTO follow_sell_tasks
        (local_task_id, via_portal, store_id, status, items_count, items_preview, stock_snapshot, template_id)
       VALUES (?, 0, ?, 'PENDING', ?, ?, ?, ?)`
    ).run(localTaskId, req.storeId, items.length, JSON.stringify(items.slice(0, 5)), stockSnapshot, templateId);

    // 写入上架记录明细(pending 状态,待 import-info 查询后更新)
    upsertTaskItems(
      localTaskId,
      items.map((it) => ({
        offer_id: it.offer_id,
        name: it.name,
        price: it.price,
        status: 'pending',
      }))
    );

    // 调 OPI /v3/product/import
    // ⚠️ 关键:先走 prepareBundleItems 做完整转换(含 dictionary_value_id、complex_attributes、
    // 描述 4191 注入等),再把转换好的 OPI v3 格式 items 提交给 Ozon。
    // 之前直接透传 message.items 会导致品牌(85)丢 dictionary_value_id、描述(4191)放顶层
    // (OPI 不识别)、complex_attributes 恒空等问题。
    let ozonTaskId = null;
    let errorMessage = null;
    try {
      const bundleResult = await prepareBundleItems(message, req.storeId, req.store);
      // 把所有 bundle 的 items 合并成扁平数组(transformItemForPortal 已转为 OPI v3 格式)
      const transformedItems = (bundleResult.bundles || []).flatMap((b) => b.items || []);
      if (transformedItems.length === 0) {
        throw new Error('prepareBundleItems 转换后无有效 items(可能全部被严格模式/无效图片过滤)');
      }
      // 备份转换后的请求体(transformed),便于排查
      try {
        db.prepare(
          `INSERT INTO follow_sell_task_payloads (local_task_id, store_id, stage, payload) VALUES (?, ?, 'transformed', ?)`
        ).run(localTaskId, req.storeId, JSON.stringify(transformedItems));
      } catch (e) {
        logger.warn({ localTaskId, err: e.message }, 'backup transformed payload failed');
      }
      const r = await opi.productImport(req.store, transformedItems);
      ozonTaskId = r?.result?.task_id ? String(r.result.task_id) : null;
    } catch (e) {
      errorMessage = e.message;
      db.prepare(
        `UPDATE follow_sell_tasks SET status='FAILED', error_message=?, completed_at=datetime('now') WHERE local_task_id=?`
      ).run(errorMessage, localTaskId);
      // 失败:更新 items 为 failed
      upsertTaskItems(
        localTaskId,
        items.map((it) => ({
          offer_id: it.offer_id,
          name: it.name,
          price: it.price,
          status: 'failed',
          errors: [{ code: 'IMPORT_ERROR', message: errorMessage }],
        }))
      );
      logger.warn({ localTaskId, err: errorMessage }, 'import failed');
      return res.json({ result: { task_id: null, localTaskId, error: errorMessage } });
    }

    db.prepare(`UPDATE follow_sell_tasks SET status='PROCESSING', ozon_task_id=? WHERE local_task_id=?`).run(
      ozonTaskId,
      localTaskId
    );

    res.json({ result: { task_id: ozonTaskId, local_task_id: localTaskId } });
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
        upsertTaskItems(local_task_id, items);
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

    // 写入/更新 items
    upsertTaskItems(localTaskId, items);
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
