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

// POST /ozon/collect-box/v2 —— 全数据源采集推送(字段级来源标记)
// body: { anchorSku, sourcePageUrl, variants[], rawBySource, synthesizedItems, collectedAt }
router.post('/ozon/collect-box/v2', storeGuard, (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.anchorSku) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'anchorSku 必填'));
    }
    if (!Array.isArray(body.variants) || body.variants.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'variants 必填且非空'));
    }

    // 大体积保护:raw_by_source 超 5MB 只存 metadata,避免 SQLite 单行过大
    let rawBySourceJson;
    const rawStr = JSON.stringify(body.rawBySource || {});
    if (rawStr.length > 5 * 1024 * 1024) {
      const meta = {
        _truncated: true,
        _originalSize: rawStr.length,
        _reason: 'raw_by_source 超 5MB,只存 metadata',
        sources: Object.keys(body.rawBySource || {}),
      };
      rawBySourceJson = JSON.stringify(meta);
    } else {
      rawBySourceJson = rawStr;
    }

    const info = db
      .prepare(
        `INSERT INTO collect_box_v2
          (store_id, anchor_sku, source_page_url, variant_count,
           variants_json, raw_by_source_json, synthesized_items_json, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.storeId,
        String(body.anchorSku),
        String(body.sourcePageUrl || ''),
        body.variants.length,
        JSON.stringify(body.variants),
        rawBySourceJson,
        JSON.stringify(body.synthesizedItems || []),
        Number(body.collectedAt) || Date.now()
      );

    res.json({
      id: info.lastInsertRowid,
      anchorSku: body.anchorSku,
      variantCount: body.variants.length,
    });
  } catch (e) {
    next(e);
  }
});

// POST /sources/:sourceId/collect —— 多源统一采集(单条 upsert)
// 插件 pushSourceCollect 调用,body: { raw, storeId?, resetDraft? }
// raw 是平台原始采集 payload(含 sku 字段),按 store_id + sku upsert 到 collect_box。
// 返回 { id, action: 'created'|'updated', source } — 上层(content script)用 id 跳转采集箱。
router.post('/sources/:sourceId/collect', storeGuard, (req, res, next) => {
  try {
    const sourceId = req.params.sourceId || 'ozon';
    const raw = req.body?.raw;
    if (!raw) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'raw 必填'));
    const sku = String(raw.sku || raw.id || '');
    if (!sku) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'raw.sku 必填'));

    const product = { ...raw, sourceId };
    const existing = db
      .prepare(
        `SELECT id FROM collect_box WHERE store_id=? AND json_extract(product, '$.sku')=?`
      )
      .get(req.storeId, sku);

    let id;
    let action;
    if (existing) {
      db.prepare(`UPDATE collect_box SET product=?, updated_at=datetime('now') WHERE id=?`).run(
        JSON.stringify(product),
        existing.id
      );
      id = existing.id;
      action = 'updated';
    } else {
      const info = db
        .prepare(`INSERT INTO collect_box (store_id, product, source) VALUES (?, ?, ?)`)
        .run(req.storeId, JSON.stringify(product), sourceId);
      id = info.lastInsertRowid;
      action = 'created';
    }
    res.json({ id, action, source: sourceId });
  } catch (e) {
    next(e);
  }
});

// POST /sources/:sourceId/collect/batch —— 多源统一采集(批量 upsert)
// 插件 pushSourceCollectBatch 调用,body: { items: [{ raw }] }
// 返回 { results: [{ index, id, action }], errors: [{ index, reason }] }
router.post('/sources/:sourceId/collect/batch', storeGuard, (req, res, next) => {
  try {
    const sourceId = req.params.sourceId || 'ozon';
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const results = [];
    const errors = [];

    db.exec('BEGIN');
    try {
      items.forEach((it, idx) => {
        const raw = it?.raw || it;
        if (!raw) {
          errors.push({ index: idx, reason: 'raw 必填' });
          return;
        }
        const sku = String(raw.sku || raw.id || '');
        if (!sku) {
          errors.push({ index: idx, reason: 'raw.sku 必填' });
          return;
        }
        const product = { ...raw, sourceId };
        const existing = db
          .prepare(
            `SELECT id FROM collect_box WHERE store_id=? AND json_extract(product, '$.sku')=?`
          )
          .get(req.storeId, sku);
        if (existing) {
          db.prepare(`UPDATE collect_box SET product=?, updated_at=datetime('now') WHERE id=?`).run(
            JSON.stringify(product),
            existing.id
          );
          results.push({ index: idx, id: existing.id, action: 'updated' });
        } else {
          const info = db
            .prepare(`INSERT INTO collect_box (store_id, product, source) VALUES (?, ?, ?)`)
            .run(req.storeId, JSON.stringify(product), sourceId);
          results.push({ index: idx, id: info.lastInsertRowid, action: 'created' });
        }
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json({ results, errors });
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
