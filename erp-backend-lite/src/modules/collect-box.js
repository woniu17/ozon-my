// 采集箱 v2 / 收藏路由
import { Router } from 'express';
import { db } from '../db/index.js';
import { storeGuard } from '../middleware/store.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';

const router = Router();

// POST /ozon/collect-box/v2 —— 全数据源采集推送(字段级来源标记)
// body: { anchorSku, sourcePageUrl, collectSource, variants[], rawBySource, collectedAt }
// 注:synthesizedItems 已改为前端查询时从 variants 现合成,不再预存
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

    // 拆分多变体:每个变体一条记录,以 (store_id, sku) 为 key upsert
    const variants = body.variants;
    const collectedAt = Number(body.collectedAt) || Date.now();
    const storeId = req.storeId;
    const anchorSku = String(body.anchorSku);
    const sourcePageUrl = String(body.sourcePageUrl || '');
    const collectSource = String(body.collectSource || '');

    const selectExisting = db.prepare(
      `SELECT id FROM collect_box_v2 WHERE COALESCE(store_id, '') = COALESCE(?, '') AND sku = ?`
    );
    const updateStmt = db.prepare(
      `UPDATE collect_box_v2 SET
         anchor_sku = ?, source_page_url = ?, collect_source = ?, variants_json = ?,
         raw_by_source_json = ?,
         collected_at = ?, updated_at = datetime('now')
       WHERE id = ?`
    );
    const insertStmt = db.prepare(
      `INSERT INTO collect_box_v2
        (store_id, sku, anchor_sku, source_page_url, collect_source,
         variants_json, raw_by_source_json, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const results = [];
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const sku = String(v?.sku?.value || v?.sku || anchorSku);
      const variantsJson = JSON.stringify([v]); // 单条变体包装成数组(保持 variants_json 结构一致)

      const existing = selectExisting.get(storeId, sku);
      let id;
      let action;
      if (existing) {
        updateStmt.run(
          anchorSku,
          sourcePageUrl,
          collectSource,
          variantsJson,
          rawBySourceJson,
          collectedAt,
          existing.id
        );
        id = existing.id;
        action = 'updated';
      } else {
        const info = insertStmt.run(
          storeId,
          sku,
          anchorSku,
          sourcePageUrl,
          collectSource,
          variantsJson,
          rawBySourceJson,
          collectedAt
        );
        id = info.lastInsertRowid;
        action = 'created';
      }
      results.push({ id, sku, action });
    }

    res.json({
      anchorSku,
      variantCount: variants.length,
      results,
    });
  } catch (e) {
    next(e);
  }
});

// POST /sources/:sourceId/collect —— 多源统一采集(单条 upsert)
// agent collectSource 调用,body: { raw, storeId?, resetDraft? }
// raw 是平台原始采集 payload(含 sku 字段),按 store_id + sku upsert 到 collect_box_v2。
// 返回 { id, action: 'created'|'updated', source } — 上层(agent)用 id 跳转采集箱。
router.post('/sources/:sourceId/collect', storeGuard, (req, res, next) => {
  try {
    const sourceId = req.params.sourceId || 'ozon';
    const raw = req.body?.raw;
    if (!raw) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'raw 必填'));
    const sku = String(raw.sku || raw.id || '');
    if (!sku) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'raw.sku 必填'));

    const storeId = req.storeId;
    const now = Date.now();
    const variantsJson = JSON.stringify([{ sku, ...raw }]);
    const rawBySourceJson = JSON.stringify({ agent: { raw, sourceId } });
    const collectSource = sourceId;

    const existing = db
      .prepare(`SELECT id FROM collect_box_v2 WHERE COALESCE(store_id, '') = COALESCE(?, '') AND sku = ?`)
      .get(storeId, sku);

    let id;
    let action;
    if (existing) {
      db.prepare(
        `UPDATE collect_box_v2 SET
           anchor_sku = ?, source_page_url = ?, collect_source = ?, variants_json = ?,
           raw_by_source_json = ?,
           collected_at = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(sku, raw.url || '', collectSource, variantsJson, rawBySourceJson, now, existing.id);
      id = existing.id;
      action = 'updated';
    } else {
      const info = db
        .prepare(
          `INSERT INTO collect_box_v2
            (store_id, sku, anchor_sku, source_page_url, collect_source,
             variants_json, raw_by_source_json, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(storeId, sku, sku, raw.url || '', collectSource, variantsJson, rawBySourceJson, now);
      id = info.lastInsertRowid;
      action = 'created';
    }
    res.json({ id, action, source: sourceId });
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
    const rows = db.prepare(`SELECT * FROM favorites ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(pageSize, offset);
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
