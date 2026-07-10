// 辅助路由:仓库 / 类目 / 健康检查 / 采集箱计数 / 扩展版本
import { Router } from 'express';
import { db } from '../db/index.js';
import { storeGuard } from '../middleware/store.js';
import * as opi from '../services/ozon-opi.js';
import logger from '../middleware/log.js';

const router = Router();

// GET /health(无需鉴权)
router.get('/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0', uptime: process.uptime() });
});

// GET /ozon/warehouses(需 store)
router.get('/ozon/warehouses', storeGuard, async (req, res, next) => {
  try {
    // 先尝试从 OPI 实时拉
    try {
      const r = await opi.warehouseList(req.store);
      // OPI /v2/warehouse/list 顶层字段是 warehouses(非 result)
      const items = Array.isArray(r?.warehouses) ? r.warehouses : [];
      if (items.length > 0) {
        return res.json(items);
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'warehouseList OPI failed, fallback to config');
    }
    // 兜底:从 stores.json 派生
    const fallback = [
      {
        id: req.store.warehouse_id,
        store_id: req.store.id,
        name: `${req.store.name} 默认仓`,
      },
    ];
    res.json(fallback);
  } catch (e) {
    next(e);
  }
});

// GET /ozon/categories/tree
router.get('/ozon/categories/tree', storeGuard, async (req, res, next) => {
  try {
    const lang = req.query.language || 'DEFAULT';
    try {
      const r = await opi.categoryTree(req.store, lang);
      return res.json(r?.result || r || []);
    } catch (e) {
      logger.warn({ err: e.message }, 'categoryTree OPI failed');
      return res.json([]);
    }
  } catch (e) {
    next(e);
  }
});

// GET /ozon/description-category/:typeId/attributes
router.get('/ozon/description-category/:typeId/attributes', storeGuard, async (req, res, next) => {
  try {
    // 个人版:透传 OPI /v3/category/attributes(需 OPI 支持)
    // 此处简化为返回空数组,插件会按需处理
    res.json([]);
  } catch (e) {
    next(e);
  }
});

// GET /ozon/collect-box-v2/status-counts(popup 状态计数)
router.get('/ozon/collect-box-v2/status-counts', storeGuard, (req, res, next) => {
  try {
    const total = db
      .prepare(`SELECT COUNT(*) as n FROM collect_box_v2 WHERE COALESCE(store_id, '') = COALESCE(?, '')`)
      .get(req.storeId).n;
    res.json({ total });
  } catch (e) {
    next(e);
  }
});

// GET /ozon/products/cache(占位,插件推荐位)
router.get('/ozon/products/cache', storeGuard, (req, res) => {
  res.json({ data: [] });
});

// GET /ozon/products/cache/status-counts(占位)
router.get('/ozon/products/cache/status-counts', storeGuard, (req, res) => {
  res.json({});
});

// GET /extension/latest(占位,个人版手动更新)
router.get('/extension/latest', (req, res) => {
  res.json({ version: '0.0.0', downloadUrl: '', sha256: '' });
});

// POST /usage/track(静默 204)
router.post('/usage/track', (req, res) => {
  res.status(204).end();
});

// POST /extension/l1-samples(静默 204)
router.post('/extension/l1-samples', (req, res) => {
  res.status(204).end();
});

export default router;
