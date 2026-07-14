// Ozon search/bundle/card/composer/entrypoint/detail/marketStats/followSell 缓存路由(MongoDB 持久存储,按 sku 全局共享)
// - search:无 TTL(永久),forceRefresh 主动删除
// - bundle:无 TTL(永久),空属性 6h 重验,forceRefresh 主动删除
// - card:无 TTL(永久),商品卡 DOM 字段(sku/url/name/price/image),搜索页/店铺页采集
// - composer:无 TTL(永久),存 composer-api 返回的 19 个业务 widgetStates,缓存优先
// - entrypoint:无 TTL(永久),存 entrypoint-api 返回的 page-json(图册/富内容/描述/标签),缓存优先
// - detail:无 TTL(永久),详情页 DOM 全字段(原 pdp 静态 + dynamic 动态合并),DOM 解析失败时兜底
// - marketStats:无 TTL(永久),市场统计(销量/价格分布等),stale 判定 24h(86400000ms)
// - followSell:无 TTL(永久),跟卖信息,stale 判定 4h(14400000ms)
// 另含:ozon_auto_collect_log 采集日志端点 + ozon_store_classification 店铺分类端点
// 鉴权:JWT(authMiddleware),不走 storeGuard(缓存按 sku 全局共享,不区分店铺)
import { Router } from 'express';
import { cols } from '../db/mongo.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';
import { transformItemForPortal, extractCategoryIds } from '../services/prepare-bundle.js';
import { toOpiItem, descriptionCategoryAttributes } from '../services/ozon-opi.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORES_FILE = join(__dirname, '../config/stores.json');
function readStoresForPreview() {
  try {
    return JSON.parse(readFileSync(STORES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

const router = Router();

const ATTRS_EMPTY_REVERIFY_MS = 6 * 60 * 60 * 1000; // 空属性 6h 重验
const MARKET_STATS_STALE_MS = 24 * 60 * 60 * 1000; // marketStats stale 判定 24h
const FOLLOW_SELL_STALE_MS = 4 * 60 * 60 * 1000; // followSell stale 判定 4h

function hasAttrs(bundleItem) {
  return Array.isArray(bundleItem?.attributes) && bundleItem.attributes.length > 0;
}

// ── search 缓存 ────────────────────────────────────────────

// GET /ozon/cache/search/:sku
router.get('/ozon/cache/search/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.searchCache();
    const doc = await col.findOne({ _id: sku });
    if (doc && doc.data) {
      return res.json({ data: doc.data, fetchedAt: doc.fetchedAt });
    }
    return res.json({ data: null });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] search get failed');
    next(e);
  }
});

// POST /ozon/cache/search/:sku  body: { data }
router.post('/ozon/cache/search/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const col = await cols.searchCache();
    await col.updateOne({ _id: sku }, { $set: { sku, data, fetchedAt: new Date() } }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] search set failed');
    next(e);
  }
});

// DELETE /ozon/cache/search/:sku
router.delete('/ozon/cache/search/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.searchCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] search delete failed');
    next(e);
  }
});

// ── bundle 缓存 ────────────────────────────────────────────

// GET /ozon/cache/bundle/:sku
// 返回 { data, fetchedAt, stale }
// - stale=true 表示空属性超过 6h 需重验(调用方应真拉刷新)
router.get('/ozon/cache/bundle/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.bundleCache();
    const doc = await col.findOne({ _id: sku });
    if (!doc || !doc.data) return res.json({ data: null });

    // 空属性 6h 重验
    if (!hasAttrs(doc.data)) {
      const verifiedAt = doc.attrsEmptyVerifiedAt ? new Date(doc.attrsEmptyVerifiedAt).getTime() : 0;
      if (!verifiedAt || Date.now() - verifiedAt >= ATTRS_EMPTY_REVERIFY_MS) {
        // 超过 6h 未验证 → 视为 stale,调用方应真拉
        return res.json({ data: null, stale: true });
      }
    }
    return res.json({ data: doc.data, fetchedAt: doc.fetchedAt });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] bundle get failed');
    next(e);
  }
});

// POST /ozon/cache/bundle/:sku  body: { data, bundleId }
router.post('/ozon/cache/bundle/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const bundleId = req.body?.bundleId || null;
    const col = await cols.bundleCache();

    const update = {
      sku,
      data,
      bundleId,
      fetchedAt: new Date(),
    };
    // 空属性打 attrsEmptyVerifiedAt 标记(6h 内复用,过期重验)
    if (!hasAttrs(data)) {
      update.attrsEmptyVerifiedAt = new Date();
    }

    await col.updateOne({ _id: sku }, { $set: update }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] bundle set failed');
    next(e);
  }
});

// DELETE /ozon/cache/bundle/:sku
router.delete('/ozon/cache/bundle/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.bundleCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] bundle delete failed');
    next(e);
  }
});

// ── card 缓存(商品卡 DOM 字段:sku/url/name/price/image) ─────────────────────────

// GET /ozon/cache/card/:sku
router.get('/ozon/cache/card/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.cardCache();
    const doc = await col.findOne({ _id: sku });
    if (doc && doc.data) {
      return res.json({ data: doc.data, fetchedAt: doc.fetchedAt });
    }
    return res.json({ data: null });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] card get failed');
    next(e);
  }
});

// POST /ozon/cache/card/:sku  body: { data }
router.post('/ozon/cache/card/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const col = await cols.cardCache();
    await col.updateOne({ _id: sku }, { $set: { sku, data, fetchedAt: new Date() } }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] card set failed');
    next(e);
  }
});

// DELETE /ozon/cache/card/:sku
router.delete('/ozon/cache/card/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.cardCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] card delete failed');
    next(e);
  }
});

// ── composer 缓存(composer-api widgetStates,缓存优先) ─────────────────────────

// GET /ozon/cache/composer/:sku
router.get('/ozon/cache/composer/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.composerCache();
    const doc = await col.findOne({ _id: sku });
    if (doc && doc.data) {
      return res.json({ data: doc.data, fetchedAt: doc.fetchedAt });
    }
    return res.json({ data: null });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] composer get failed');
    next(e);
  }
});

// POST /ozon/cache/composer/:sku  body: { data }
router.post('/ozon/cache/composer/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const col = await cols.composerCache();
    await col.updateOne({ _id: sku }, { $set: { sku, data, fetchedAt: new Date() } }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] composer set failed');
    next(e);
  }
});

// DELETE /ozon/cache/composer/:sku
router.delete('/ozon/cache/composer/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.composerCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] composer delete failed');
    next(e);
  }
});

// ── entrypoint 缓存(entrypoint-api page-json,缓存优先) ─────────────────────────

// GET /ozon/cache/entrypoint/:sku
router.get('/ozon/cache/entrypoint/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.entrypointCache();
    const doc = await col.findOne({ _id: sku });
    if (doc && doc.data) {
      return res.json({ data: doc.data, fetchedAt: doc.fetchedAt });
    }
    return res.json({ data: null });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] entrypoint get failed');
    next(e);
  }
});

// POST /ozon/cache/entrypoint/:sku  body: { data }
router.post('/ozon/cache/entrypoint/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const col = await cols.entrypointCache();
    await col.updateOne({ _id: sku }, { $set: { sku, data, fetchedAt: new Date() } }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] entrypoint set failed');
    next(e);
  }
});

// DELETE /ozon/cache/entrypoint/:sku
router.delete('/ozon/cache/entrypoint/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.entrypointCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] entrypoint delete failed');
    next(e);
  }
});

// ── detail 缓存(详情页 DOM 全字段:原 pdp 静态 + dynamic 动态合并,永久存储) ─────────────────────────

// GET /ozon/cache/detail/:sku
router.get('/ozon/cache/detail/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.detailCache();
    const doc = await col.findOne({ _id: sku });
    if (doc && doc.data) {
      return res.json({ data: doc.data, fetchedAt: doc.fetchedAt });
    }
    return res.json({ data: null });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] detail get failed');
    next(e);
  }
});

// POST /ozon/cache/detail/:sku  body: { data }
router.post('/ozon/cache/detail/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const col = await cols.detailCache();
    await col.updateOne({ _id: sku }, { $set: { sku, data, fetchedAt: new Date() } }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] detail set failed');
    next(e);
  }
});

// DELETE /ozon/cache/detail/:sku
router.delete('/ozon/cache/detail/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.detailCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] detail delete failed');
    next(e);
  }
});

// ── marketStats 缓存(市场统计:销量/价格分布等,stale 判定 24h) ─────────────────────────

// GET /ozon/cache/marketStats/:sku
router.get('/ozon/cache/marketStats/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.marketStatsCache();
    const doc = await col.findOne({ _id: sku }, { projection: { _id: 1, sku: 1, data: 1, fetchedAt: 1, l2Synced: 1 } });
    if (!doc || !doc.data) return res.json({ data: null });
    // stale 预计算:fetchedAt 距今 > 24h
    const fetchedAtMs = doc.fetchedAt ? new Date(doc.fetchedAt).getTime() : 0;
    const stale = !fetchedAtMs || Date.now() - fetchedAtMs > MARKET_STATS_STALE_MS;
    return res.json({
      data: doc.data,
      fetchedAt: doc.fetchedAt,
      l2Synced: doc.l2Synced === true,
      stale,
    });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] marketStats get failed');
    next(e);
  }
});

// POST /ozon/cache/marketStats/:sku  body: { data }
router.post('/ozon/cache/marketStats/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const col = await cols.marketStatsCache();
    await col.updateOne({ _id: sku }, { $set: { sku, data, fetchedAt: new Date(), l2Synced: true } }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] marketStats set failed');
    next(e);
  }
});

// DELETE /ozon/cache/marketStats/:sku
router.delete('/ozon/cache/marketStats/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.marketStatsCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] marketStats delete failed');
    next(e);
  }
});

// ── followSell 缓存(跟卖信息,stale 判定 4h) ─────────────────────────

// GET /ozon/cache/followSell/:sku
router.get('/ozon/cache/followSell/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.followSellCache();
    const doc = await col.findOne({ _id: sku }, { projection: { _id: 1, sku: 1, data: 1, fetchedAt: 1, l2Synced: 1 } });
    if (!doc || !doc.data) return res.json({ data: null });
    // stale 预计算:fetchedAt 距今 > 4h
    const fetchedAtMs = doc.fetchedAt ? new Date(doc.fetchedAt).getTime() : 0;
    const stale = !fetchedAtMs || Date.now() - fetchedAtMs > FOLLOW_SELL_STALE_MS;
    return res.json({
      data: doc.data,
      fetchedAt: doc.fetchedAt,
      l2Synced: doc.l2Synced === true,
      stale,
    });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] followSell get failed');
    next(e);
  }
});

// POST /ozon/cache/followSell/:sku  body: { data }
router.post('/ozon/cache/followSell/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const col = await cols.followSellCache();
    await col.updateOne({ _id: sku }, { $set: { sku, data, fetchedAt: new Date(), l2Synced: true } }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] followSell set failed');
    next(e);
  }
});

// DELETE /ozon/cache/followSell/:sku
router.delete('/ozon/cache/followSell/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.followSellCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] followSell delete failed');
    next(e);
  }
});

// ── 管理后台 API(/admin/api/cache/*) ───────────────────────
// 列表/统计/详情/清空,供前端缓存管理页面使用

// GET /admin/api/cache/stats — 缓存统计(8 类集合文档数 + 空属性数 + 总体积)
router.get('/admin/api/cache/stats', async (req, res, next) => {
  try {
    const [sCol, bCol, cCol, coCol, eCol, dCol, mCol, fCol] = await Promise.all([
      cols.searchCache(),
      cols.bundleCache(),
      cols.cardCache(),
      cols.composerCache(),
      cols.entrypointCache(),
      cols.detailCache(),
      cols.marketStatsCache(),
      cols.followSellCache(),
    ]);
    const [
      searchCount,
      bundleCount,
      bundleEmptyAttrs,
      bundleStale,
      cardCount,
      composerCount,
      entrypointCount,
      detailCount,
      marketStatsCount,
      followSellCount,
    ] = await Promise.all([
      sCol.estimatedDocumentCount(),
      bCol.estimatedDocumentCount(),
      bCol.countDocuments({ 'data.attributes': { $size: 0 } }),
      bCol.countDocuments({
        'data.attributes': { $size: 0 },
        attrsEmptyVerifiedAt: { $lt: new Date(Date.now() - ATTRS_EMPTY_REVERIFY_MS) },
      }),
      cCol.estimatedDocumentCount(),
      coCol.estimatedDocumentCount(),
      eCol.estimatedDocumentCount(),
      dCol.estimatedDocumentCount(),
      mCol.estimatedDocumentCount(),
      fCol.estimatedDocumentCount(),
    ]);
    return res.json(
      ok({
        search: { count: searchCount },
        bundle: { count: bundleCount, emptyAttrs: bundleEmptyAttrs, stale: bundleStale },
        card: { count: cardCount },
        composer: { count: composerCount },
        entrypoint: { count: entrypointCount },
        detail: { count: detailCount },
        marketStats: { count: marketStatsCount },
        followSell: { count: followSellCount },
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] stats failed');
    next(e);
  }
});

// 类型 → 集合 映射(管理接口统一入口)
const CACHE_TYPES = ['search', 'bundle', 'card', 'composer', 'entrypoint', 'detail', 'marketStats', 'followSell'];
const getColByType = (type) => {
  switch (type) {
    case 'search':
      return cols.searchCache();
    case 'bundle':
      return cols.bundleCache();
    case 'card':
      return cols.cardCache();
    case 'composer':
      return cols.composerCache();
    case 'entrypoint':
      return cols.entrypointCache();
    case 'detail':
      return cols.detailCache();
    case 'marketStats':
      return cols.marketStatsCache();
    case 'followSell':
      return cols.followSellCache();
    default:
      return cols.bundleCache();
  }
};

// GET /admin/api/cache/list — 缓存列表(支持 type/search/分页)
// query: type=search|bundle|card|composer|entrypoint|detail|marketStats|followSell, keyword, page, pageSize
router.get('/admin/api/cache/list', async (req, res, next) => {
  try {
    const type = CACHE_TYPES.includes(req.query.type) ? req.query.type : 'bundle';
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const col = await getColByType(type);
    const query = keyword ? { sku: { $regex: keyword, $options: 'i' } } : {};
    // projection 按类型差异化:bundle 取属性/attrsEmptyVerifiedAt/bundleId,marketStats/followSell 取 l2Synced
    const projection =
      type === 'bundle'
        ? { _id: 1, sku: 1, fetchedAt: 1, attrsEmptyVerifiedAt: 1, bundleId: 1, 'data.attributes': 1 }
        : type === 'marketStats' || type === 'followSell'
          ? { _id: 1, sku: 1, fetchedAt: 1, l2Synced: 1 }
          : { _id: 1, sku: 1, fetchedAt: 1 };
    const [total, docs] = await Promise.all([
      col.countDocuments(query),
      col
        .find(query, { projection })
        .sort({ fetchedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
    ]);

    const items = docs.map((d) => {
      const sku = d.sku || d._id;
      // bundle 类型才需要预计算空属性 + 待重验状态
      if (type !== 'bundle') {
        // marketStats / followSell 预计算 stale + l2Synced
        if (type === 'marketStats' || type === 'followSell') {
          const staleMs = type === 'marketStats' ? MARKET_STATS_STALE_MS : FOLLOW_SELL_STALE_MS;
          const fetchedAtMs = d.fetchedAt ? new Date(d.fetchedAt).getTime() : 0;
          const stale = !fetchedAtMs || Date.now() - fetchedAtMs > staleMs;
          return { sku, fetchedAt: d.fetchedAt, l2Synced: d.l2Synced === true, stale };
        }
        return { sku, fetchedAt: d.fetchedAt };
      }
      const attrsEmpty = !hasAttrs(d.data);
      let attrsStale = false;
      if (attrsEmpty) {
        const verifiedAt = d.attrsEmptyVerifiedAt ? new Date(d.attrsEmptyVerifiedAt).getTime() : 0;
        attrsStale = !verifiedAt || Date.now() - verifiedAt >= ATTRS_EMPTY_REVERIFY_MS;
      }
      return {
        sku,
        fetchedAt: d.fetchedAt,
        attrsEmptyVerifiedAt: d.attrsEmptyVerifiedAt || null,
        attrsEmpty,
        attrsStale,
        bundleId: d.bundleId || null,
      };
    });

    return res.json(ok({ items, total, page, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] list failed');
    next(e);
  }
});

// GET /admin/api/cache/:type/:sku — 缓存详情(完整 data)
router.get('/admin/api/cache/:type/:sku', async (req, res, next) => {
  try {
    // overview / opi-preview 走专属路由,这里跳过(避免被 :type 参数捕获)
    if (req.params.type === 'overview' || req.params.type === 'opi-preview') return next('route');
    const type = CACHE_TYPES.includes(req.params.type) ? req.params.type : 'bundle';
    const sku = String(req.params.sku);
    const col = await getColByType(type);
    const doc = await col.findOne({ _id: sku });
    if (!doc) return res.json(ok(null));
    // marketStats / followSell 额外返回 l2Synced + stale 预计算
    if (type === 'marketStats' || type === 'followSell') {
      const staleMs = type === 'marketStats' ? MARKET_STATS_STALE_MS : FOLLOW_SELL_STALE_MS;
      const fetchedAtMs = doc.fetchedAt ? new Date(doc.fetchedAt).getTime() : 0;
      const stale = !fetchedAtMs || Date.now() - fetchedAtMs > staleMs;
      return res.json(
        ok({
          sku: doc.sku || doc._id,
          data: doc.data,
          fetchedAt: doc.fetchedAt,
          l2Synced: doc.l2Synced === true,
          stale,
        })
      );
    }
    return res.json(
      ok({
        sku: doc.sku || doc._id,
        data: doc.data,
        fetchedAt: doc.fetchedAt,
        attrsEmptyVerifiedAt: doc.attrsEmptyVerifiedAt || null,
        bundleId: doc.bundleId || null,
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] detail failed');
    next(e);
  }
});

// DELETE /admin/api/cache/:type/:sku — 删除单条
router.delete('/admin/api/cache/:type/:sku', async (req, res, next) => {
  try {
    const type = CACHE_TYPES.includes(req.params.type) ? req.params.type : 'bundle';
    const sku = String(req.params.sku);
    const col = await getColByType(type);
    await col.deleteOne({ _id: sku });
    return res.json(ok({ deleted: true }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] admin delete failed');
    next(e);
  }
});

// DELETE /admin/api/cache/:type — 清空整个集合
router.delete('/admin/api/cache/:type', async (req, res, next) => {
  try {
    const type = CACHE_TYPES.includes(req.params.type) ? req.params.type : 'bundle';
    const col = await getColByType(type);
    const r = await col.deleteMany({});
    return res.json(ok({ deletedCount: r.deletedCount }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] clear all failed');
    next(e);
  }
});

// ── 全览接口:聚合 8 类缓存,展示每 SKU 的缓存状态矩阵 ─────────────────────────

// GET /admin/api/cache/overview — 全览列表(聚合 8 类缓存的 SKU)
// query: keyword, page, pageSize
// 返回: { items: [{ sku, search:{fetchedAt}, bundle:{fetchedAt,attrsEmpty}, card:{fetchedAt},
//                  composer:{fetchedAt}, entrypoint:{fetchedAt}, detail:{fetchedAt},
//                  marketStats:{fetchedAt,stale}, followSell:{fetchedAt,stale} }], total }
router.get('/admin/api/cache/overview', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));

    // 8 类缓存并行查询所有 SKU(仅取 _id/sku/fetchedAt/关键字段)
    const [sCol, bCol, cCol, coCol, eCol, dCol, mCol, fCol] = await Promise.all([
      cols.searchCache(),
      cols.bundleCache(),
      cols.cardCache(),
      cols.composerCache(),
      cols.entrypointCache(),
      cols.detailCache(),
      cols.marketStatsCache(),
      cols.followSellCache(),
    ]);

    const skuFilter = keyword ? { sku: { $regex: keyword, $options: 'i' } } : {};

    const [sDocs, bDocs, cDocs, coDocs, eDocs, dDocs, mDocs, fDocs] = await Promise.all([
      sCol.find(skuFilter, { projection: { _id: 1, sku: 1, fetchedAt: 1 } }).toArray(),
      bCol
        .find(skuFilter, {
          projection: { _id: 1, sku: 1, fetchedAt: 1, attrsEmptyVerifiedAt: 1, 'data.attributes': 1 },
        })
        .toArray(),
      cCol.find(skuFilter, { projection: { _id: 1, sku: 1, fetchedAt: 1 } }).toArray(),
      coCol.find(skuFilter, { projection: { _id: 1, sku: 1, fetchedAt: 1 } }).toArray(),
      eCol.find(skuFilter, { projection: { _id: 1, sku: 1, fetchedAt: 1 } }).toArray(),
      dCol.find(skuFilter, { projection: { _id: 1, sku: 1, fetchedAt: 1 } }).toArray(),
      mCol.find(skuFilter, { projection: { _id: 1, sku: 1, fetchedAt: 1 } }).toArray(),
      fCol.find(skuFilter, { projection: { _id: 1, sku: 1, fetchedAt: 1 } }).toArray(),
    ]);

    // 聚合所有 SKU
    const skuMap = new Map();
    const ensure = (sku) => {
      if (!skuMap.has(sku)) {
        skuMap.set(sku, {
          sku,
          search: null,
          bundle: null,
          card: null,
          composer: null,
          entrypoint: null,
          detail: null,
          marketStats: null,
          followSell: null,
        });
      }
      return skuMap.get(sku);
    };

    for (const d of sDocs) {
      const sku = d.sku || d._id;
      ensure(sku).search = { fetchedAt: d.fetchedAt };
    }
    for (const d of bDocs) {
      const sku = d.sku || d._id;
      const item = ensure(sku);
      const attrsEmpty = !hasAttrs(d.data);
      let attrsStale = false;
      if (attrsEmpty) {
        const verifiedAt = d.attrsEmptyVerifiedAt ? new Date(d.attrsEmptyVerifiedAt).getTime() : 0;
        attrsStale = !verifiedAt || Date.now() - verifiedAt >= ATTRS_EMPTY_REVERIFY_MS;
      }
      item.bundle = { fetchedAt: d.fetchedAt, attrsEmpty, attrsStale };
    }
    for (const d of cDocs) {
      const sku = d.sku || d._id;
      ensure(sku).card = { fetchedAt: d.fetchedAt };
    }
    for (const d of coDocs) {
      const sku = d.sku || d._id;
      ensure(sku).composer = { fetchedAt: d.fetchedAt };
    }
    for (const d of eDocs) {
      const sku = d.sku || d._id;
      ensure(sku).entrypoint = { fetchedAt: d.fetchedAt };
    }
    for (const d of dDocs) {
      const sku = d.sku || d._id;
      ensure(sku).detail = { fetchedAt: d.fetchedAt };
    }
    for (const d of mDocs) {
      const sku = d.sku || d._id;
      const fetchedAtMs = d.fetchedAt ? new Date(d.fetchedAt).getTime() : 0;
      const stale = !fetchedAtMs || Date.now() - fetchedAtMs > MARKET_STATS_STALE_MS;
      ensure(sku).marketStats = { fetchedAt: d.fetchedAt, stale };
    }
    for (const d of fDocs) {
      const sku = d.sku || d._id;
      const fetchedAtMs = d.fetchedAt ? new Date(d.fetchedAt).getTime() : 0;
      const stale = !fetchedAtMs || Date.now() - fetchedAtMs > FOLLOW_SELL_STALE_MS;
      ensure(sku).followSell = { fetchedAt: d.fetchedAt, stale };
    }

    // 排序:按最新 fetchedAt 降序(8 类取最大值)
    let items = Array.from(skuMap.values());
    items.sort((a, b) => {
      const aMax = Math.max(
        new Date(a.search?.fetchedAt || 0).getTime(),
        new Date(a.bundle?.fetchedAt || 0).getTime(),
        new Date(a.card?.fetchedAt || 0).getTime(),
        new Date(a.composer?.fetchedAt || 0).getTime(),
        new Date(a.entrypoint?.fetchedAt || 0).getTime(),
        new Date(a.detail?.fetchedAt || 0).getTime(),
        new Date(a.marketStats?.fetchedAt || 0).getTime(),
        new Date(a.followSell?.fetchedAt || 0).getTime()
      );
      const bMax = Math.max(
        new Date(b.search?.fetchedAt || 0).getTime(),
        new Date(b.bundle?.fetchedAt || 0).getTime(),
        new Date(b.card?.fetchedAt || 0).getTime(),
        new Date(b.composer?.fetchedAt || 0).getTime(),
        new Date(b.entrypoint?.fetchedAt || 0).getTime(),
        new Date(b.detail?.fetchedAt || 0).getTime(),
        new Date(b.marketStats?.fetchedAt || 0).getTime(),
        new Date(b.followSell?.fetchedAt || 0).getTime()
      );
      return bMax - aMax;
    });

    const total = items.length;
    const pagedItems = items.slice((page - 1) * pageSize, page * pageSize);
    return res.json(ok({ items: pagedItems, total, page, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] overview failed');
    next(e);
  }
});

// GET /admin/api/cache/opi-preview/:sku — 从 MongoDB 缓存合成 OPI v3 预览
// query: storeId(可选,用于字典白名单过滤)
// 返回: { item: opiItem, sources: {...} }
router.get('/admin/api/cache/opi-preview/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const storeId = String(req.query.storeId || '');

    // 并行读取 6 类缓存(cols.xxxCache() 返回 Promise<Collection>,需先 await)
    const [sCol, bCol, cCol, coCol, eCol, dCol] = await Promise.all([
      cols.searchCache(),
      cols.bundleCache(),
      cols.cardCache(),
      cols.composerCache(),
      cols.entrypointCache(),
      cols.detailCache(),
    ]);
    const [sDoc, bDoc, cDoc, coDoc, eDoc, dDoc] = await Promise.all([
      sCol.findOne({ _id: sku }),
      bCol.findOne({ _id: sku }),
      cCol.findOne({ _id: sku }),
      coCol.findOne({ _id: sku }),
      eCol.findOne({ _id: sku }),
      dCol.findOne({ _id: sku }),
    ]);

    const sources = {
      search: !!sDoc,
      bundle: !!bDoc,
      card: !!cDoc,
      composer: !!coDoc,
      entrypoint: !!eDoc,
      detail: !!dDoc,
    };

    if (!bDoc && !sDoc) {
      return res.json(ok({ item: null, sources, error: '缺少 bundle 和 search 缓存,无法合成 OPI' }));
    }

    const bundleData = bDoc?.data || null;
    const searchData = sDoc?.data || null;
    const cardData = cDoc?.data || null;
    const entrypointData = eDoc?.data || null;
    const detailData = dDoc?.data || null;

    // 从 search 缓存提取 sv(归一化后的 sourceVariant)
    const sv = (searchData?.items && searchData.items[0]) || {};
    // 从 bundle 缓存提取 bundleItem
    const bundleItem = bundleData || {};

    // 构造 item(对齐 transformItemForPortal 输入格式)
    // bundle 的 complex attributes 从 bundle.attributes 拆出
    const bundleComplexAttrs = Array.isArray(bundleItem.attributes)
      ? bundleItem.attributes.filter((a) => Number(a.complex_id) > 0)
      : [];

    // images:优先 bundle.primary_image + bundle.images,兜底 entrypoint.gallery / detail.images / card.image
    let primaryImage = bundleItem.primary_image || '';
    let images = Array.isArray(bundleItem.images) ? [...bundleItem.images] : [];
    if (!primaryImage && entrypointData?.gallery?.length) primaryImage = entrypointData.gallery[0];
    if (!images.length && entrypointData?.gallery?.length) images = entrypointData.gallery.slice(1);
    if (!images.length && detailData?.images?.length) images = [...detailData.images];
    if (!primaryImage && detailData?.images?.length) primaryImage = detailData.images[0];
    if (!primaryImage && cardData?.image) primaryImage = cardData.image;

    // name:优先 bundle attr 4180,兜底 search attr 4180 / detail.title / card.name
    let name = '';
    const bAttr4180 = bundleItem.attributes?.find((a) => String(a.attribute_id) === '4180');
    if (bAttr4180?.values?.[0]?.value) name = bAttr4180.values[0].value;
    if (!name) {
      const sAttr4180 = sv.attributes?.find((a) => String(a.key) === '4180');
      if (sAttr4180?.value) name = sAttr4180.value;
    }
    if (!name) name = detailData?.title || '';
    if (!name) name = cardData?.name || '';

    // description:优先 bundle attr 4191,兜底 entrypoint.description
    let description = '';
    const bAttr4191 = bundleItem.attributes?.find((a) => String(a.attribute_id) === '4191');
    if (bAttr4191?.values?.[0]?.value) description = bAttr4191.values[0].value;
    if (!description) description = entrypointData?.description || '';

    // price:detail.price(原 dynamic),兜底 card.price
    const price = detailData?.price || cardData?.price || '';

    // barcode:search._searchMeta.barcodes[0] / bundle.barcode
    const barcode = sv._searchMeta?.barcodes?.[0] || bundleItem.barcode || '';

    // 构造 item
    const item = {
      _sourceVariant: {
        ...sv,
        _bundleItem: bundleItem,
        _bundleComplexAttrs: bundleComplexAttrs,
      },
      images: [
        ...(primaryImage ? [{ file_name: primaryImage, default: true }] : []),
        ...images.map((u) => ({ file_name: u, default: false })),
      ],
      name,
      price,
      old_price: detailData?.originalPrice || '',
      offer_id: 'SKU' + sku,
      weight: bundleItem.weight || '',
      depth: bundleItem.depth || '',
      width: bundleItem.width || '',
      height: bundleItem.height || '',
      scraped_description: description,
      barcode,
      videoUrl: entrypointData?.mp4 || '',
      videoCover: '',
    };

    // 字典白名单(可选)
    const store = storeId ? readStoresForPreview().find((s) => s.id === storeId) : null;
    let allowedAttrIds = null;
    if (store) {
      try {
        const { typeId, descriptionCategoryId } = extractCategoryIds(item);
        if (typeId && descriptionCategoryId) {
          const attrs = await descriptionCategoryAttributes(store, {
            description_category_id: descriptionCategoryId,
            type_id: typeId,
          });
          if (Array.isArray(attrs) && attrs.length > 0) {
            allowedAttrIds = new Set(attrs.map((a) => String(a.id)));
          }
        }
      } catch {
        // 字典查询失败,降级为不过滤
      }
    }

    const portalItem = transformItemForPortal(item, { allowedAttrIds });
    const opiItem = toOpiItem(portalItem);

    return res.json(ok({ item: opiItem, sources, portalItem }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] opi-preview failed');
    next(e);
  }
});

// ── 采集日志(/admin/api/auto-collect/*) ────────────────────
// ozon_auto_collect_log 集合的统计/列表/详情/写入端点
// 鉴权:全局 JWT(authMiddleware);POST /log 由 SW 持 token 调用

const LOG_TYPES = ['card', 'detail', 'composer', 'entrypoint', 'search', 'bundle', 'marketStats', 'followSell'];
const LOG_SOURCES = ['shop-page', 'pdp'];
const LOG_STORE_CLASSES = ['chinese', 'non-chinese', 'unclassified'];
const LOG_STATUS_KEYS = ['success', 'partial', 'failed', 'skipped', 'antibot'];

function emptyLogStats() {
  return {
    total: 0,
    success: 0,
    partial: 0,
    failed: 0,
    skipped: 0,
    antibot: 0,
    byType: Object.fromEntries(LOG_TYPES.map((t) => [t, 0])),
    bySource: Object.fromEntries(LOG_SOURCES.map((s) => [s, 0])),
    byStoreClass: Object.fromEntries(LOG_STORE_CLASSES.map((s) => [s, 0])),
  };
}

// 聚合指定时间范围内的采集日志统计
async function aggregateLogStats(matchStage) {
  const col = await cols.autoCollectLog();
  const [result] = await col
    .aggregate([
      matchStage,
      {
        $facet: {
          statusCounts: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          typeCounts: [{ $unwind: '$results' }, { $group: { _id: '$results.type', count: { $sum: 1 } } }],
          sourceCounts: [{ $group: { _id: '$source', count: { $sum: 1 } } }],
          storeClassCounts: [{ $group: { _id: '$storeClassified', count: { $sum: 1 } } }],
          total: [{ $count: 'count' }],
        },
      },
    ])
    .toArray();

  const stats = emptyLogStats();
  stats.total = result.total?.[0]?.count || 0;
  for (const s of result.statusCounts || []) {
    if (LOG_STATUS_KEYS.includes(s._id)) stats[s._id] = s.count;
  }
  for (const t of result.typeCounts || []) {
    if (t._id != null) stats.byType[t._id] = (stats.byType[t._id] || 0) + t.count;
  }
  for (const s of result.sourceCounts || []) {
    if (s._id != null) stats.bySource[s._id] = (stats.bySource[s._id] || 0) + s.count;
  }
  for (const s of result.storeClassCounts || []) {
    if (s._id != null) stats.byStoreClass[s._id] = (stats.byStoreClass[s._id] || 0) + s.count;
  }
  return stats;
}

// 计算今日 00:00(本地时区)
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// 计算本周一 00:00(本地时区,ISO 周一起)
function startOfWeek() {
  const d = startOfToday();
  const day = d.getDay(); // 0=Sunday, 1=Monday, ...
  const diff = day === 0 ? -6 : 1 - day; // 回退到周一
  d.setDate(d.getDate() + diff);
  return d;
}

// GET /admin/api/auto-collect/stats — 采集日志统计(今日 + 本周)
router.get('/admin/api/auto-collect/stats', async (req, res, next) => {
  try {
    const todayStart = startOfToday();
    const weekStart = startOfWeek();
    const [today, week] = await Promise.all([
      aggregateLogStats({ $match: { collectedAt: { $gte: todayStart } } }),
      aggregateLogStats({ $match: { collectedAt: { $gte: weekStart } } }),
    ]);
    return res.json(ok({ today, week }));
  } catch (e) {
    logger.warn({ err: e.message }, '[auto-collect] stats failed');
    next(e);
  }
});

// GET /admin/api/auto-collect/logs — 采集日志列表(分页 + 过滤)
// query: sku/status(逗号分隔多值)/source/sellerSlug/currentPage/pageSize/startTime/endTime
router.get('/admin/api/auto-collect/logs', async (req, res, next) => {
  try {
    const sku = String(req.query.sku || '').trim();
    const statusRaw = String(req.query.status || '').trim();
    const source = String(req.query.source || '').trim();
    const sellerSlug = String(req.query.sellerSlug || '').trim();
    const currentPage = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
    const startTime = req.query.startTime ? new Date(Number(req.query.startTime) || req.query.startTime) : null;
    const endTime = req.query.endTime ? new Date(Number(req.query.endTime) || req.query.endTime) : null;

    const query = {};
    if (sku) query.sku = sku;
    if (statusRaw) {
      const statuses = statusRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      query.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }
    if (source) query.source = source;
    if (sellerSlug) query.sellerSlug = sellerSlug;
    if (startTime || endTime) {
      query.collectedAt = {};
      if (startTime) query.collectedAt.$gte = startTime;
      if (endTime) query.collectedAt.$lte = endTime;
    }

    const col = await cols.autoCollectLog();
    const [total, items] = await Promise.all([
      col.countDocuments(query),
      col
        .find(query, { projection: { _id: 0 } })
        .sort({ collectedAt: -1 })
        .skip((currentPage - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
    ]);

    return res.json(ok({ items, total, current: currentPage, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[auto-collect] logs list failed');
    next(e);
  }
});

// GET /admin/api/auto-collect/logs/:sku — 单 SKU 采集历史(按 collectedAt DESC)
router.get('/admin/api/auto-collect/logs/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.autoCollectLog();
    const items = await col
      .find({ sku }, { projection: { _id: 0 } })
      .sort({ collectedAt: -1 })
      .toArray();
    return res.json(ok({ items }));
  } catch (e) {
    logger.warn({ err: e.message }, '[auto-collect] logs by sku failed');
    next(e);
  }
});

// POST /admin/api/auto-collect/log — 写入一条采集日志(SW 调用,JWT 鉴权)
// body: { sku, source, sellerSlug, storeClassified, depth, status, results, totalDuration, collectedAt }
// results: 数组,每项 { type, hit, error? }
router.post('/admin/api/auto-collect/log', async (req, res, next) => {
  try {
    const body = req.body || {};
    const sku = String(body.sku || '').trim();
    if (!sku) return res.status(422).json({ error: 'missing sku' });
    const status = String(body.status || '').trim();
    if (!status) return res.status(422).json({ error: 'missing status' });

    const doc = {
      sku,
      source: body.source != null ? String(body.source) : null,
      sellerSlug: body.sellerSlug != null ? String(body.sellerSlug) : null,
      storeClassified: body.storeClassified != null ? String(body.storeClassified) : 'unclassified',
      depth: body.depth != null ? Number(body.depth) || 0 : 0,
      status,
      results: Array.isArray(body.results) ? body.results : [],
      totalDuration: body.totalDuration != null ? Number(body.totalDuration) || 0 : 0,
      collectedAt: body.collectedAt ? new Date(body.collectedAt) : new Date(),
    };

    const col = await cols.autoCollectLog();
    const r = await col.insertOne(doc);
    return res.json(ok({ insertedId: r.insertedId }));
  } catch (e) {
    logger.warn({ err: e.message }, '[auto-collect] log insert failed');
    next(e);
  }
});

// ── 店铺分类(/admin/api/store-classification) ───────────────────
// ozon_store_classification 集合的 CRUD 端点
// 鉴权:全局 JWT;不走 storeGuard(全局共享,按 slug 查询)
// _id = sellerSlug(便于 upsert)

// GET /admin/api/store-classification/:slug — 查询单条分类记录
router.get('/admin/api/store-classification/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const col = await cols.storeClassification();
    const doc = await col.findOne({ _id: slug });
    if (!doc) return res.status(404).json({ error: 'not found' });
    return res.json(
      ok({
        sellerSlug: doc.sellerSlug || doc._id,
        sellerName: doc.sellerName || '',
        isChinese: doc.isChinese === true,
        classifiedBy: doc.classifiedBy || '',
        companyInfo: doc.companyInfo || null,
        lastSeenAt: doc.lastSeenAt || null,
        lastSeenUrl: doc.lastSeenUrl || '',
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[store-classification] get failed');
    next(e);
  }
});

// POST /admin/api/store-classification/:slug — upsert 分类记录
// body: { sellerName, isChinese, classifiedBy, companyInfo, lastSeenAt, lastSeenUrl }
// 已存在时更新 isChinese/classifiedBy/classifiedAt 并刷新 lastSeenAt
router.post('/admin/api/store-classification/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const body = req.body || {};
    const now = new Date();
    const lastSeenAt = body.lastSeenAt ? new Date(body.lastSeenAt) : now;

    const update = {
      sellerSlug: slug,
      sellerName: body.sellerName != null ? String(body.sellerName) : '',
      isChinese: body.isChinese === true,
      classifiedBy: body.classifiedBy != null ? String(body.classifiedBy) : '',
      classifiedAt: body.classifiedAt ? new Date(body.classifiedAt) : now,
      companyInfo: body.companyInfo != null ? body.companyInfo : null,
      lastSeenAt,
      lastSeenUrl: body.lastSeenUrl != null ? String(body.lastSeenUrl) : '',
    };

    const col = await cols.storeClassification();
    await col.updateOne({ _id: slug }, { $set: update }, { upsert: true });
    return res.json(ok({ upserted: true, sellerSlug: slug }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-classification] upsert failed');
    next(e);
  }
});

// DELETE /admin/api/store-classification/:slug — 删除单条
router.delete('/admin/api/store-classification/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const col = await cols.storeClassification();
    const r = await col.deleteOne({ _id: slug });
    return res.json(ok({ deletedCount: r.deletedCount }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-classification] delete failed');
    next(e);
  }
});

// GET /admin/api/store-classification — 列表查询(分页 + 过滤)
// query: isChinese(true/false/null 不传则不过滤)/keyword(匹配 sellerName/sellerSlug)/currentPage/pageSize
router.get('/admin/api/store-classification', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const currentPage = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));

    const query = {};
    // isChinese: 'true' → true, 'false' → false, 其他(包括不传/null) → 不过滤
    if (req.query.isChinese === 'true') query.isChinese = true;
    else if (req.query.isChinese === 'false') query.isChinese = false;

    if (keyword) {
      query.$or = [
        { sellerName: { $regex: keyword, $options: 'i' } },
        { sellerSlug: { $regex: keyword, $options: 'i' } },
      ];
    }

    const col = await cols.storeClassification();
    const [total, items] = await Promise.all([
      col.countDocuments(query),
      col
        .find(query, { projection: { _id: 0 } })
        .sort({ lastSeenAt: -1 })
        .skip((currentPage - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
    ]);

    return res.json(ok({ items, total, current: currentPage, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-classification] list failed');
    next(e);
  }
});

export default router;
