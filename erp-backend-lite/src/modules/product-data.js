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
    res.json({ data: result });
  } catch (e) {
    next(e);
  }
});

// GET /ozon/product-data/:sku
router.get('/ozon/product-data/:sku', storeGuard, async (req, res, next) => {
  try {
    const result = {};
    res.json({ data: result });
  } catch (e) {
    next(e);
  }
});

export default router;
