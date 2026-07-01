// 跟卖核心路由
// 对齐插件 service-worker.js:
//   - /ozon/products/prepare-bundle-items (viaPortal 6a,120s)
//   - /ozon/products/import (官方 API,120s)
//   - /ozon/products/import/status
//   - /ozon/products/import-by-sku/tasks
//   - /ozon/products/import-by-sku
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { storeGuard } from '../middleware/store.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { prepareBundleItems } from '../services/prepare-bundle.js';
import * as opi from '../services/ozon-opi.js';
import logger from '../middleware/log.js';

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
router.post('/ozon/products/import', storeGuard, async (req, res, next) => {
  try {
    const message = req.body || {};
    const items = Array.isArray(message.items) ? message.items : [];
    const localTaskId = `local-${Date.now()}-${randomUUID().slice(0, 8)}`;

    // 入库 PENDING
    db.prepare(
      `INSERT INTO follow_sell_tasks
        (local_task_id, via_portal, store_id, status, items_count, items_preview)
       VALUES (?, 0, ?, 'PENDING', ?, ?)`
    ).run(
      localTaskId,
      req.storeId,
      items.length,
      JSON.stringify(items.slice(0, 5))
    );

    // 调 OPI /v3/product/import
    let ozonTaskId = null;
    let errorMessage = null;
    try {
      const r = await opi.productImport(req.store, items);
      ozonTaskId = r?.result?.task_id ? String(r.result.task_id) : null;
    } catch (e) {
      errorMessage = e.message;
      db.prepare(
        `UPDATE follow_sell_tasks SET status='FAILED', error_message=?, completed_at=datetime('now') WHERE local_task_id=?`
      ).run(errorMessage, localTaskId);
      logger.warn({ localTaskId, err: errorMessage }, 'import failed');
      return res.json({ result: { task_id: null, localTaskId, error: errorMessage } });
    }

    db.prepare(
      `UPDATE follow_sell_tasks SET status='PROCESSING', ozon_task_id=? WHERE local_task_id=?`
    ).run(ozonTaskId, localTaskId);

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
          db.prepare(
            `UPDATE follow_sell_tasks SET status=?, completed_at=datetime('now') WHERE id=?`
          ).run(failed > 0 && processed === 0 ? 'FAILED' : 'SUCCESS', row.id);
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
      db.prepare(
        `UPDATE follow_sell_tasks SET status='PROCESSING', ozon_task_id=? WHERE local_task_id=?`
      ).run(ozonTaskId, localTaskId);
    } catch (e) {
      db.prepare(
        `UPDATE follow_sell_tasks SET status='FAILED', error_message=?, completed_at=datetime('now') WHERE local_task_id=?`
      ).run(e.message, localTaskId);
    }

    const row = db
      .prepare(`SELECT * FROM follow_sell_tasks WHERE local_task_id=?`)
      .get(localTaskId);
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

export default router;
