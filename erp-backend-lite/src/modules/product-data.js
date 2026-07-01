// 商品数据查询路由
import { Router } from 'express';
import NodeCache from 'node-cache';
import { db } from '../db/index.js';
import { storeGuard } from '../middleware/store.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import config from '../config/index.js';
import * as opi from '../services/ozon-opi.js';
import logger from '../middleware/log.js';

const router = Router();

// 内存缓存 1 小时(与 DB 缓存互补)
const memCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

function parseRow(r) {
  if (!r) return null;
  try {
    return JSON.parse(r.data);
  } catch {
    return null;
  }
}

// POST /ozon/product-data/batch
router.post('/ozon/product-data/batch', storeGuard, async (req, res, next) => {
  try {
    const skus = Array.isArray(req.body?.skus) ? req.body.skus : [];
    if (skus.length === 0) {
      return res.json({ data: {} });
    }

    const result = {};
    const missing = [];

    // 1. 命中内存缓存
    for (const sku of skus) {
      const cached = memCache.get(String(sku));
      if (cached) {
        result[sku] = cached;
        continue;
      }
      // 2. 命中 DB 缓存
      const row = db
        .prepare(`SELECT data, fetched_at FROM product_data_cache WHERE sku=?`)
        .get(String(sku));
      if (row) {
        const age = Date.now() - new Date(row.fetched_at).getTime();
        if (age < config.productDataCacheTtlMs) {
          const parsed = parseRow(row);
          if (parsed) {
            result[sku] = parsed;
            memCache.set(String(sku), parsed);
            continue;
          }
        }
      }
      missing.push(sku);
    }

    // 3. 未命中 → 调 OPI /v2/product/info/list
    if (missing.length > 0) {
      try {
        const r = await opi.productInfoList(req.store, missing);
        const items = r?.result?.items || [];
        const insertStmt = db.prepare(
          `INSERT OR REPLACE INTO product_data_cache (sku, data, fetched_at) VALUES (?, ?, datetime('now'))`
        );
        for (const item of items) {
          const sku = String(item.sku || item.offer_id);
          result[sku] = item;
          memCache.set(sku, item);
          insertStmt.run(sku, JSON.stringify(item));
        }
        // OPI 未返回的 SKU 标记 null
        for (const sku of missing) {
          if (!(sku in result)) result[sku] = null;
        }
      } catch (e) {
        logger.warn({ err: e.message, count: missing.length }, 'productInfoList failed');
        for (const sku of missing) {
          if (!(sku in result)) result[sku] = null;
        }
      }
    }

    res.json({ data: result });
  } catch (e) {
    next(e);
  }
});

// GET /ozon/product-data/:sku
router.get('/ozon/product-data/:sku', storeGuard, async (req, res, next) => {
  try {
    const sku = String(req.params.sku);

    // 1. 内存缓存
    const cached = memCache.get(sku);
    if (cached) return res.json({ data: cached });

    // 2. DB 缓存
    const row = db
      .prepare(`SELECT data, fetched_at FROM product_data_cache WHERE sku=?`)
      .get(sku);
    if (row) {
      const age = Date.now() - new Date(row.fetched_at).getTime();
      if (age < config.productDataCacheTtlMs) {
        const parsed = parseRow(row);
        if (parsed) {
          memCache.set(sku, parsed);
          return res.json({ data: parsed });
        }
      }
    }

    // 3. OPI /v2/product/info
    try {
      const r = await opi.productInfo(req.store, sku);
      const data = r?.result || r || null;
      if (data) {
        memCache.set(sku, data);
        db.prepare(
          `INSERT OR REPLACE INTO product_data_cache (sku, data, fetched_at) VALUES (?, ?, datetime('now'))`
        ).run(sku, JSON.stringify(data));
      }
      res.json({ data });
    } catch (e) {
      logger.warn({ sku, err: e.message }, 'productInfo failed');
      next(new ApiError(ErrorCode.NETWORK_ERROR, `查询商品数据失败: ${e.message}`));
    }
  } catch (e) {
    next(e);
  }
});

export default router;
