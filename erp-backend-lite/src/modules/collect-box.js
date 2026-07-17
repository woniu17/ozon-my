// 采集箱 v2 / 收藏路由
// 注意:collect_box_v2 表已废弃,改为以 cardCache 为基准的缓存视图(/admin/api/collect-box-v2/from-cache)
// 此处仅保留插件兼容性入口(返回静默成功,不再写库) + 收藏功能
import { Router } from 'express';
import { db } from '../db/index.js';
import { storeGuard } from '../middleware/store.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import logger from '../middleware/log.js';

const router = Router();

// POST /ozon/collect-box/v2 —— 已废弃(插件仍会调用,返回静默成功避免报错)
// 数据已改为由 SW 直接写入 7 类缓存表,本接口不再持久化
router.post('/ozon/collect-box/v2', storeGuard, (req, res) => {
  const body = req.body || {};
  const variants = Array.isArray(body.variants) ? body.variants : [];
  logger.debug(
    { anchorSku: body.anchorSku, variantCount: variants.length, storeId: req.storeId },
    'collect-box/v2 已废弃(静默成功,不再写库)'
  );
  res.json({
    anchorSku: body.anchorSku || '',
    variantCount: variants.length,
    results: variants.map((v) => ({
      id: 0,
      sku: String(v?.sku?.value || v?.sku || body.anchorSku || ''),
      action: 'ignored',
    })),
    deprecated: true,
  });
});

// POST /sources/:sourceId/collect —— 已废弃(agent 仍会调用,返回静默成功避免报错)
router.post('/sources/:sourceId/collect', storeGuard, (req, res) => {
  const raw = req.body?.raw;
  const sku = String(raw?.sku || raw?.id || '');
  logger.debug(
    { sourceId: req.params.sourceId, sku, storeId: req.storeId },
    'sources/:id/collect 已废弃(静默成功,不再写库)'
  );
  res.json({ id: 0, action: 'ignored', source: req.params.sourceId || 'ozon', deprecated: true });
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
