// 采集箱 / 收藏路由
import { Router } from 'express';
import { db } from '../db/index.js';
import { storeGuard } from '../middleware/store.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';

const router = Router();

// POST /ozon/collect-box
router.post('/ozon/collect-box', storeGuard, (req, res, next) => {
  try {
    const product = req.body?.product || req.body;
    if (!product) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'product 必填'));
    const info = db
      .prepare(
        `INSERT INTO collect_box (store_id, product, source) VALUES (?, ?, 'ozon')`
      )
      .run(req.storeId, JSON.stringify(product));
    res.json({ id: info.lastInsertRowid, product, source: 'ozon' });
  } catch (e) {
    next(e);
  }
});

// PATCH /ozon/collect-box/:id
router.patch('/ozon/collect-box/:id', storeGuard, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare(`SELECT * FROM collect_box WHERE id=?`).get(id);
    if (!row) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '条目不存在'));

    const body = req.body || {};
    if (body.product) {
      db.prepare(`UPDATE collect_box SET product=?, updated_at=datetime('now') WHERE id=?`).run(
        JSON.stringify(body.product),
        id
      );
    }
    if (body.ai_draft) {
      db.prepare(`UPDATE collect_box SET ai_draft=?, updated_at=datetime('now') WHERE id=?`).run(
        JSON.stringify(body.ai_draft),
        id
      );
    }
    if (typeof body.published === 'boolean') {
      db.prepare(`UPDATE collect_box SET published=?, updated_at=datetime('now') WHERE id=?`).run(
        body.published ? 1 : 0,
        id
      );
    }
    const updated = db.prepare(`SELECT * FROM collect_box WHERE id=?`).get(id);
    res.json({
      id: updated.id,
      product: JSON.parse(updated.product),
      ai_draft: updated.ai_draft ? JSON.parse(updated.ai_draft) : null,
      published: !!updated.published,
    });
  } catch (e) {
    next(e);
  }
});

// GET /ozon/collect-box
router.get('/ozon/collect-box', storeGuard, (req, res, next) => {
  try {
    const current = Number(req.query.currentPage) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const offset = (current - 1) * pageSize;
    const rows = db
      .prepare(
        `SELECT * FROM collect_box WHERE store_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(req.storeId, pageSize, offset);
    const total = db
      .prepare(`SELECT COUNT(*) as n FROM collect_box WHERE store_id=?`)
      .get(req.storeId).n;
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        product: JSON.parse(r.product),
        source: r.source,
        ai_draft: r.ai_draft ? JSON.parse(r.ai_draft) : null,
        published: !!r.published,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      total,
      currentPage: current,
      pageSize,
    });
  } catch (e) {
    next(e);
  }
});

// POST /ozon/collect-box/batch
router.post('/ozon/collect-box/batch', storeGuard, (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const mode = req.body?.mode || 'update';
    let created = 0;
    let updated = 0;
    let skipped = 0;
    // 手动事务(node:sqlite 无 db.transaction 帮助函数)
    db.exec('BEGIN');
    try {
      for (const it of items) {
        const product = it.product || it;
        const sku = product?.sku || product?.id;
        const existing = sku
          ? db
              .prepare(
                `SELECT id FROM collect_box WHERE store_id=? AND json_extract(product, '$.sku')=?`
              )
              .get(req.storeId, String(sku))
          : null;
        if (existing) {
          if (mode === 'skip') {
            skipped++;
          } else {
            db.prepare(
              `UPDATE collect_box SET product=?, updated_at=datetime('now') WHERE id=?`
            ).run(JSON.stringify(product), existing.id);
            updated++;
          }
        } else {
          db.prepare(
            `INSERT INTO collect_box (store_id, product, source) VALUES (?, ?, 'ozon')`
          ).run(req.storeId, JSON.stringify(product));
          created++;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ created, updated, skipped });
  } catch (e) {
    next(e);
  }
});

// POST /ozon/favorites
router.post('/ozon/favorites', storeGuard, (req, res, next) => {
  try {
    const product = req.body?.product || req.body;
    if (!product) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'product 必填'));
    const sku = product.sku || product.id || '';
    try {
      const info = db
        .prepare(`INSERT INTO favorites (product, sku) VALUES (?, ?)`)
        .run(JSON.stringify(product), String(sku));
      res.json({ id: info.lastInsertRowid, product, sku });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return next(new ApiError(ErrorCode.VALIDATION_ERROR, '已收藏过此商品'));
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

// GET /ozon/favorites?currentPage=1&pageSize=1 (popup 红点用)
router.get('/ozon/favorites', storeGuard, (req, res, next) => {
  try {
    const current = Number(req.query.currentPage) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const offset = (current - 1) * pageSize;
    const rows = db
      .prepare(`SELECT * FROM favorites ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(pageSize, offset);
    const total = db.prepare(`SELECT COUNT(*) as n FROM favorites`).get().n;
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        product: JSON.parse(r.product),
        sku: r.sku,
        createdAt: r.created_at,
      })),
      total,
      currentPage: current,
      pageSize,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
