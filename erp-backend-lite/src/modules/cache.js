// Ozon search/bundle/card/composer/entrypoint/detail/marketStats/followSell 缓存路由
// 存储驱动通过 DAO 层(adapter.js)注入:DB_DRIVER=sqlite(默认)|mongo
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
import { getDaos } from '../db/adapter.js';
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

// DAO 单例(顶层 await:启动时即建立连接,失败立即可见)
const daos = await getDaos();

const router = Router();

const MARKET_STATS_STALE_MS = 24 * 60 * 60 * 1000; // marketStats stale 判定 24h
const FOLLOW_SELL_STALE_MS = 4 * 60 * 60 * 1000; // followSell stale 判定 4h

// ── search 缓存 ────────────────────────────────────────────

// GET /ozon/cache/search/:sku
router.get('/ozon/cache/search/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const r = await daos.searchDao.getBySku(sku);
    if (r.data) {
      return res.json({ data: r.data, fetchedAt: r.fetchedAt });
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
    await daos.searchDao.upsert(sku, data);
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
    await daos.searchDao.deleteBySku(sku);
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
    // DAO.getBySku 内置空属性 6h 重验逻辑
    const r = await daos.bundleDao.getBySku(sku);
    return res.json(r);
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
    // DAO.upsert 内置:空属性时自动打 attrsEmptyVerifiedAt 标记
    await daos.bundleDao.upsert(sku, data, { bundleId });
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
    await daos.bundleDao.deleteBySku(sku);
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
    const r = await daos.cardDao.getBySku(sku);
    if (r.data) {
      return res.json({ data: r.data, fetchedAt: r.fetchedAt });
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
    await daos.cardDao.upsert(sku, data);
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
    await daos.cardDao.deleteBySku(sku);
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
    const r = await daos.composerDao.getBySku(sku);
    if (r.data) {
      return res.json({ data: r.data, fetchedAt: r.fetchedAt });
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
    await daos.composerDao.upsert(sku, data);
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
    await daos.composerDao.deleteBySku(sku);
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
    const r = await daos.entrypointDao.getBySku(sku);
    if (r.data) {
      return res.json({ data: r.data, fetchedAt: r.fetchedAt });
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
    await daos.entrypointDao.upsert(sku, data);
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
    await daos.entrypointDao.deleteBySku(sku);
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
    const r = await daos.detailDao.getBySku(sku);
    if (r.data) {
      return res.json({ data: r.data, fetchedAt: r.fetchedAt });
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
    await daos.detailDao.upsert(sku, data);
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
    await daos.detailDao.deleteBySku(sku);
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
    const r = await daos.marketStatsDao.getBySku(sku);
    if (!r.data) return res.json({ data: null });
    // stale 预计算:fetchedAt 距今 > 24h
    const fetchedAtMs = r.fetchedAt ? new Date(r.fetchedAt).getTime() : 0;
    const stale = !fetchedAtMs || Date.now() - fetchedAtMs > MARKET_STATS_STALE_MS;
    return res.json({
      data: r.data,
      fetchedAt: r.fetchedAt,
      l2Synced: r.l2Synced === true,
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
    await daos.marketStatsDao.upsert(sku, data);
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
    await daos.marketStatsDao.deleteBySku(sku);
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
    const r = await daos.followSellDao.getBySku(sku);
    if (!r.data) return res.json({ data: null });
    // stale 预计算:fetchedAt 距今 > 4h
    const fetchedAtMs = r.fetchedAt ? new Date(r.fetchedAt).getTime() : 0;
    const stale = !fetchedAtMs || Date.now() - fetchedAtMs > FOLLOW_SELL_STALE_MS;
    return res.json({
      data: r.data,
      fetchedAt: r.fetchedAt,
      l2Synced: r.l2Synced === true,
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
    await daos.followSellDao.upsert(sku, data);
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
    await daos.followSellDao.deleteBySku(sku);
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] followSell delete failed');
    next(e);
  }
});

// ── richMedia 缓存(合并 entrypoint + composer,对齐 MY 富内容打分制) ─────────────────────────
// 缓存对象:{ mp4, richContent, richContentHasText, description, hashtags, gallery,
//           fields, widgetStates, hitEndpoints }
// 由 qx-ozon fetchPdpBundleViaBuyerTab 写入,合并原 entrypoint + composer 双缓存

// GET /ozon/cache/richMedia/:sku
router.get('/ozon/cache/richMedia/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const r = await daos.richMediaDao.getBySku(sku);
    if (r.data) {
      return res.json({ data: r.data, fetchedAt: r.fetchedAt });
    }
    return res.json({ data: null });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] richMedia get failed');
    next(e);
  }
});

// POST /ozon/cache/richMedia/:sku  body: { data }
router.post('/ozon/cache/richMedia/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    await daos.richMediaDao.upsert(sku, data);
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] richMedia set failed');
    next(e);
  }
});

// DELETE /ozon/cache/richMedia/:sku
router.delete('/ozon/cache/richMedia/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    await daos.richMediaDao.deleteBySku(sku);
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] richMedia delete failed');
    next(e);
  }
});

// ── 管理后台 API(/admin/api/cache/*) ───────────────────────
// 列表/统计/详情/清空,供前端缓存管理页面使用

// GET /admin/api/cache/stats — 缓存统计(7 类集合文档数 + 空属性数 + 总体积)
// 注:composer/entrypoint 已合并为 richMedia,旧 collection 保留但不展示
router.get('/admin/api/cache/stats', async (req, res, next) => {
  try {
    const [
      searchCount,
      bundleCount,
      bundleEmptyAttrs,
      bundleStale,
      cardCount,
      richMediaCount,
      detailCount,
      marketStatsCount,
      followSellCount,
    ] = await Promise.all([
      daos.searchDao.estimatedCount(),
      daos.bundleDao.estimatedCount(),
      daos.bundleDao.countEmptyAttrs(),
      daos.bundleDao.countStaleEmptyAttrs(),
      daos.cardDao.estimatedCount(),
      daos.richMediaDao.estimatedCount(),
      daos.detailDao.estimatedCount(),
      daos.marketStatsDao.estimatedCount(),
      daos.followSellDao.estimatedCount(),
    ]);
    return res.json(
      ok({
        search: { count: searchCount },
        bundle: { count: bundleCount, emptyAttrs: bundleEmptyAttrs, stale: bundleStale },
        card: { count: cardCount },
        richMedia: { count: richMediaCount },
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

// 类型 → DAO 映射(管理接口统一入口)
// 注:composer/entrypoint 已合并为 richMedia,旧 SW-facing 路由保留(sycL2Batch 老数据补写)
const CACHE_TYPES = ['search', 'bundle', 'card', 'richMedia', 'detail', 'marketStats', 'followSell'];
const getDaoByType = (type) => {
  switch (type) {
    case 'search':
      return daos.searchDao;
    case 'bundle':
      return daos.bundleDao;
    case 'card':
      return daos.cardDao;
    case 'richMedia':
      return daos.richMediaDao;
    case 'detail':
      return daos.detailDao;
    case 'marketStats':
      return daos.marketStatsDao;
    case 'followSell':
      return daos.followSellDao;
    default:
      return daos.bundleDao;
  }
};

// GET /admin/api/cache/list — 缓存列表(支持 type/search/分页)
// query: type=search|bundle|card|richMedia|detail|marketStats|followSell, keyword, page, pageSize
router.get('/admin/api/cache/list', async (req, res, next) => {
  try {
    const type = CACHE_TYPES.includes(req.query.type) ? req.query.type : 'bundle';
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const { items, total } = await getDaoByType(type).findPagedList(keyword, page, pageSize);

    // 按类型差异化重塑(bundle 已由 DAO 预计算 attrsEmpty/attrsStale)
    const reshaped = items.map((d) => {
      const sku = d.sku || d._id;
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
      // bundle:DAO 已返回 attrsEmpty/attrsStale/bundleId/attrsEmptyVerifiedAt
      return {
        sku,
        fetchedAt: d.fetchedAt,
        attrsEmptyVerifiedAt: d.attrsEmptyVerifiedAt || null,
        attrsEmpty: d.attrsEmpty,
        attrsStale: d.attrsStale,
        bundleId: d.bundleId || null,
      };
    });

    return res.json(ok({ items: reshaped, total, page, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] list failed');
    next(e);
  }
});

// ── 采集箱·缓存视图:以 cardCache 为基准,聚合 7 类缓存命中状态 ──
// 用于前端"采集箱"页面切换数据源:从 collect_box_v2 表 → 缓存聚合视图
// 设计:cardCache 含 sku/url/name/price/image,最适合做列表基准
//      其他 6 类缓存仅取 _id + fetchedAt 用于命中位图 + 排序
router.get('/admin/api/collect-box-v2/from-cache', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    // hasVideo=1:richMedia 缓存含 mp4(需后置过滤,因 cardCache 无视频信息)
    const filterHasVideo = req.query.hasVideo === '1' || req.query.hasVideo === 'true';
    // minCacheHits=N:7 类缓存命中数 ≥ N(后置过滤)
    const minCacheHits = Math.max(0, Math.min(7, Number(req.query.minCacheHits) || 0));

    // 1) cardCache 分页(基准,findPagedList 不返回 data,仅用于拿 SKU 列表 + total)
    const { items: cardPage, total } = await daos.cardDao.findPagedList(keyword, page, pageSize);
    if (!cardPage.length) {
      return res.json(ok({ items: [], total, current: page, pageSize }));
    }

    // 2) 并行批量查询:本页 cardCache 的完整 data + 其他 6 类缓存命中状态
    const skus = cardPage.map((c) => c.sku);
    const [cardDocs, bDocs, rmDocs, dDocs, mDocs, fDocs, sDocs] = await Promise.all([
      daos.cardDao.findManyBySkuList(skus), // 取本页 cardCache 的 data(含 name/price/image)
      daos.bundleDao.findManyBySkuList(skus),
      daos.richMediaDao.findManyBySkuList(skus),
      daos.detailDao.findManyBySkuList(skus),
      daos.marketStatsDao.findManyBySkuList(skus),
      daos.followSellDao.findManyBySkuList(skus),
      daos.searchDao.findManyBySkuList(skus),
    ]);

    // 3) 建立 sku → 缓存命中位图
    const cardMap = new Map(cardDocs.map((d) => [d.sku, d]));
    const bundleMap = new Map(bDocs.map((d) => [d.sku, d]));
    const richMediaMap = new Map(rmDocs.map((d) => [d.sku, d]));
    const detailMap = new Map(dDocs.map((d) => [d.sku, d]));
    const marketStatsMap = new Map(mDocs.map((d) => [d.sku, d]));
    const followSellMap = new Map(fDocs.map((d) => [d.sku, d]));
    const searchMap = new Map(sDocs.map((d) => [d.sku, d]));

    // 4) 组装返回 items
    let items = cardPage.map((c) => {
      // cardCache.data 结构:{ sku, url, name, price, image, ... }(从 findManyBySkuList 取)
      const cardDoc = cardMap.get(c.sku);
      const cardData = cardDoc?.data || {};
      const b = bundleMap.get(c.sku);
      const rm = richMediaMap.get(c.sku);
      const d = detailMap.get(c.sku);
      const m = marketStatsMap.get(c.sku);
      const f = followSellMap.get(c.sku);
      const s = searchMap.get(c.sku);

      const cacheHits = {
        search: !!s,
        bundle: !!b,
        card: true, // 基准,恒为 true
        richMedia: !!rm,
        detail: !!d,
        marketStats: !!m,
        followSell: !!f,
      };
      const hitCount = Object.values(cacheHits).filter(Boolean).length;

      // 7 类 fetchedAt 取最大值作为"最近采集时间"
      const fetchedAts = [
        c.fetchedAt, b?.fetchedAt, rm?.fetchedAt, d?.fetchedAt,
        m?.fetchedAt, f?.fetchedAt, s?.fetchedAt,
      ].filter(Boolean);
      const lastCollectedAt = fetchedAts.sort().pop() || c.fetchedAt;

      // marketStats 关键字段(P50 价格,如有)
      let marketPriceP50 = null;
      if (m?.data) {
        marketPriceP50 = m.data.priceP50 ?? m.data.priceP50 ?? m.data.p50 ?? null;
      }

      // followSell 竞争度(跟卖商家数,如有)
      let competitorCount = null;
      if (f?.data) {
        const sellers = f.data.sellers || f.data.competitors || [];
        competitorCount = Array.isArray(sellers) ? sellers.length : null;
      }

      // richMedia 视频标志
      const hasVideo = !!(rm?.data?.mp4);

      return {
        sku: c.sku,
        name: cardData.name || '',
        price: cardData.price ?? '',
        primaryImage: cardData.image || '',
        url: cardData.url || '',
        cacheHits,
        hitCount,
        hasVideo,
        marketPriceP50,
        competitorCount,
        lastCollectedAt,
        // 兼容旧卡片字段(避免前端报错)
        storeId: '',
        anchorSku: c.sku,
        collectSource: 'cache',
        collectedAt: null,
        createdAt: c.fetchedAt,
      };
    });

    // 5) 后置过滤(hasVideo / minCacheHits)
    if (filterHasVideo) {
      items = items.filter((it) => it.hasVideo);
    }
    if (minCacheHits > 0) {
      items = items.filter((it) => it.hitCount >= minCacheHits);
    }

    return res.json(ok({ items, total, current: page, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] collect-box-v2/from-cache failed');
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
    const doc = await getDaoByType(type).findById(sku);
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
    await getDaoByType(type).deleteBySku(sku);
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
    const r = await getDaoByType(type).clearAll();
    return res.json(ok({ deletedCount: r.deletedCount }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] clear all failed');
    next(e);
  }
});

// ── 全览接口:聚合 7 类缓存,展示每 SKU 的缓存状态矩阵 ─────────────────────────

// GET /admin/api/cache/overview — 全览列表(聚合 7 类缓存的 SKU)
// query: keyword, page, pageSize
// 返回: { items: [{ sku, search:{fetchedAt}, bundle:{fetchedAt,attrsEmpty}, card:{fetchedAt},
//                  richMedia:{fetchedAt}, detail:{fetchedAt},
//                  marketStats:{fetchedAt,stale}, followSell:{fetchedAt,stale} }], total }
router.get('/admin/api/cache/overview', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));

    // 7 类缓存并行查询所有 SKU(仅取 _id/sku/fetchedAt/关键字段)
    const [sDocs, bDocs, cDocs, rmDocs, dDocs, mDocs, fDocs] = await Promise.all([
      daos.searchDao.findOverviewList(keyword),
      daos.bundleDao.findOverviewList(keyword),
      daos.cardDao.findOverviewList(keyword),
      daos.richMediaDao.findOverviewList(keyword),
      daos.detailDao.findOverviewList(keyword),
      daos.marketStatsDao.findOverviewList(keyword),
      daos.followSellDao.findOverviewList(keyword),
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
          richMedia: null,
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
      // bundle DAO 已预计算 attrsEmpty / attrsStale
      ensure(sku).bundle = { fetchedAt: d.fetchedAt, attrsEmpty: d.attrsEmpty, attrsStale: d.attrsStale };
    }
    for (const d of cDocs) {
      const sku = d.sku || d._id;
      ensure(sku).card = { fetchedAt: d.fetchedAt };
    }
    for (const d of rmDocs) {
      const sku = d.sku || d._id;
      ensure(sku).richMedia = { fetchedAt: d.fetchedAt };
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

    // 排序:按最新 fetchedAt 降序(7 类取最大值)
    let items = Array.from(skuMap.values());
    items.sort((a, b) => {
      const aMax = Math.max(
        new Date(a.search?.fetchedAt || 0).getTime(),
        new Date(a.bundle?.fetchedAt || 0).getTime(),
        new Date(a.card?.fetchedAt || 0).getTime(),
        new Date(a.richMedia?.fetchedAt || 0).getTime(),
        new Date(a.detail?.fetchedAt || 0).getTime(),
        new Date(a.marketStats?.fetchedAt || 0).getTime(),
        new Date(a.followSell?.fetchedAt || 0).getTime()
      );
      const bMax = Math.max(
        new Date(b.search?.fetchedAt || 0).getTime(),
        new Date(b.bundle?.fetchedAt || 0).getTime(),
        new Date(b.card?.fetchedAt || 0).getTime(),
        new Date(b.richMedia?.fetchedAt || 0).getTime(),
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

// ── 缓存合成 helper(opi-preview + preview/profile 共用) ───
// 从 5 类缓存(search/bundle/card/richMedia/detail)合成 OPI 输入 item
// 返回 { sources, item, portalItem, opiItem, raw } 或 { sources, error }
async function buildSynthesizedFromCache(sku, storeId) {
  const [sDoc, bDoc, cDoc, rmDoc, dDoc] = await Promise.all([
    daos.searchDao.findById(sku),
    daos.bundleDao.findById(sku),
    daos.cardDao.findById(sku),
    daos.richMediaDao.findById(sku),
    daos.detailDao.findById(sku),
  ]);

  const sources = {
    search: !!sDoc,
    bundle: !!bDoc,
    card: !!cDoc,
    richMedia: !!rmDoc,
    detail: !!dDoc,
  };

  if (!bDoc && !sDoc) {
    return { sources, error: '缺少 bundle 和 search 缓存,无法合成 OPI' };
  }

  const bundleData = bDoc?.data || null;
  const searchData = sDoc?.data || null;
  const cardData = cDoc?.data || null;
  const richMediaData = rmDoc?.data || null;
  const detailData = dDoc?.data || null;

  const sv = (searchData?.items && searchData.items[0]) || {};
  const bundleItem = bundleData || {};
  const bundleComplexAttrs = Array.isArray(bundleItem.attributes)
    ? bundleItem.attributes.filter((a) => Number(a.complex_id) > 0)
    : [];

  // images:优先 bundle,兜底 richMedia.gallery / richMedia.fields.images / detail.images / card.image
  const rmGallery = richMediaData?.gallery?.length
    ? richMediaData.gallery
    : richMediaData?.fields?.images || [];
  let primaryImage = bundleItem.primary_image || '';
  let images = Array.isArray(bundleItem.images) ? [...bundleItem.images] : [];
  if (!primaryImage && rmGallery.length) primaryImage = rmGallery[0];
  if (!images.length && rmGallery.length) images = rmGallery.slice(1);
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

  // description:优先 bundle attr 4191,兜底 richMedia.description
  let description = '';
  const bAttr4191 = bundleItem.attributes?.find((a) => String(a.attribute_id) === '4191');
  if (bAttr4191?.values?.[0]?.value) description = bAttr4191.values[0].value;
  if (!description) description = richMediaData?.description || '';

  const price = detailData?.price || cardData?.price || '';
  const barcode = sv._searchMeta?.barcodes?.[0] || bundleItem.barcode || '';

  const item = {
    _sourceVariant: { ...sv, _bundleItem: bundleItem, _bundleComplexAttrs: bundleComplexAttrs },
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
    videoUrl: richMediaData?.mp4 || '',
    videoCover: '',
  };

  // 字典白名单(可选)+ 完整属性字典(供前端展示可读属性名)
  // 字典查询需要任一 store 的认证;storeId 未传时退而取第一个 store(仅为字典展示用,不影响白名单)
  const stores = readStoresForPreview();
  const store = storeId
    ? stores.find((s) => s.id === storeId)
    : stores[0] || null;
  let allowedAttrIds = null;
  let attrDict = {}; // id(字符串) -> { id, name, description, type, dictionary_id }
  if (store) {
    try {
      const { typeId, descriptionCategoryId } = extractCategoryIds(item);
      if (typeId && descriptionCategoryId) {
        const attrs = await descriptionCategoryAttributes(store, {
          description_category_id: descriptionCategoryId,
          type_id: typeId,
        });
        if (Array.isArray(attrs) && attrs.length > 0) {
          // 白名单仅在用户选中具体 store 时启用(不同 store 可能有不同类目过滤策略)
          if (storeId) {
            allowedAttrIds = new Set(attrs.map((a) => String(a.id)));
          }
          // 构建字典: id -> { id, name, description, type, dictionary_id }
          for (const a of attrs) {
            attrDict[String(a.id)] = {
              id: a.id,
              name: a.name || '',
              description: a.description || '',
              type: a.type || '',
              dictionary_id: a.dictionary_id || 0,
            };
          }
        }
      }
    } catch {
      // 字典查询失败,降级为不过滤
    }
  }

  const portalItem = transformItemForPortal(item, { allowedAttrIds });
  const opiItem = toOpiItem(portalItem);

  return {
    sources,
    item,
    portalItem,
    opiItem,
    attrDict,
    raw: { bundleData, searchData, cardData, richMediaData, detailData },
  };
}

// GET /admin/api/cache/opi-preview/:sku — 从缓存合成 OPI v3 预览
// query: storeId(可选,用于字典白名单过滤)
// 返回: { item: opiItem, sources: {...} }
router.get('/admin/api/cache/opi-preview/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const storeId = String(req.query.storeId || '');
    const r = await buildSynthesizedFromCache(sku, storeId);
    if (r.error) {
      return res.json(ok({ item: null, sources: r.sources, error: r.error }));
    }
    return res.json(ok({ item: r.opiItem, sources: r.sources, portalItem: r.portalItem }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] opi-preview failed');
    next(e);
  }
});

// ── 上架预览工作台:SKU 全息画像 ────────────────────────────
// 聚合 7 类缓存,返回原始字段 + 合成 OPI item,供前端预览页渲染
// query: storeId(可选,用于字典白名单过滤)
router.get('/admin/api/preview/sku/:sku/profile', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const storeId = String(req.query.storeId || '');

    // 1) 合成 OPI(复用 opi-preview 逻辑)+ 额外读 marketStats/followSell
    const [synth, mDoc, fDoc] = await Promise.all([
      buildSynthesizedFromCache(sku, storeId),
      daos.marketStatsDao.findById(sku),
      daos.followSellDao.findById(sku),
    ]);

    const sources = {
      ...synth.sources,
      marketStats: !!mDoc,
      followSell: !!fDoc,
    };

    if (synth.error) {
      return res.json(ok({ sources, original: null, error: synth.error }));
    }

    const { raw, item, portalItem, opiItem, attrDict } = synth;
    const marketStatsData = mDoc?.data || null;
    const followSellData = fDoc?.data || null;

    // 2) 组装 original(前端预览页左栏 + 对比卡用)
    const original = {
      sku,
      name: item.name,
      price: item.price,
      oldPrice: item.old_price,
      primaryImage: item.images.find((i) => i.default)?.file_name || item.images[0]?.file_name || '',
      images: item.images.map((i) => i.file_name).filter(Boolean),
      url: raw.cardData?.url || `https://www.ozon.ru/product/${sku}/`,
      description: item.scraped_description,
      attributes: portalItem.attributes || [],
      complexAttributes: portalItem.complex_attributes || [],
      weight: item.weight,
      dimensions: { depth: item.depth, width: item.width, height: item.height },
      videoUrl: item.videoUrl,
      barcode: item.barcode,
      offerId: item.offer_id,
      // 市场统计(marketStats 缓存,用于价格对比卡的 P50 参考)
      marketStats: marketStatsData
        ? {
            priceP50: marketStatsData.priceP50 ?? marketStatsData.p50 ?? null,
            priceP25: marketStatsData.priceP25 ?? marketStatsData.p25 ?? null,
            priceP75: marketStatsData.priceP75 ?? marketStatsData.p75 ?? null,
            salesTrend: marketStatsData.salesTrend || null,
          }
        : null,
      // 跟卖竞争度(followSell 缓存)
      competitorCount: followSellData
        ? (followSellData.sellers || followSellData.competitors || []).length
        : null,
    };

    // 3) portalItem 关键字段预览(前端右栏对比用)
    const portalPreview = {
      name: portalItem.name,
      price: portalItem.price,
      oldPrice: portalItem.old_price,
      primaryImage: portalItem.primary_image || '',
      images: portalItem.images || [],
      weight: portalItem.weight,
      dimensions: {
        depth: portalItem.depth,
        width: portalItem.width,
        height: portalItem.height,
      },
      attributes: portalItem.attributes || [],
      complexAttributes: portalItem.complex_attributes || [],
      descriptionCategoryId: portalItem.new_description_category_id || null,
      typeId: portalItem.type_id || null,
      videoUrl: portalItem.video_url || '',
    };

    return res.json(
      ok({
        sources,
        original,
        item, // 合成的 OPI 输入 item(提交时传给 /ozon/products/import)
        portalItem: portalPreview,
        opiItem,
        attrDict, // 属性 ID -> {id, name, description, type, dictionary_id}(供前端显示可读属性名)
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] preview/sku/profile failed');
    next(e);
  }
});

// ── 采集日志(/admin/api/auto-collect/*) ────────────────────
// ozon_auto_collect_log 集合的统计/列表/详情/写入端点
// 鉴权:全局 JWT(authMiddleware);POST /log 由 SW 持 token 调用

const LOG_TYPES = ['card', 'detail', 'pdp', 'search', 'bundle', 'marketStats', 'followSell'];
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

// 将 DAO aggregateStats 返回值转换为前端期望的 legacy 形状
function toLegacyLogStats(daoResult) {
  const stats = emptyLogStats();
  stats.total = daoResult.total || 0;
  for (const k of LOG_STATUS_KEYS) stats[k] = daoResult.statusCounts?.[k] || 0;
  stats.byType = { ...stats.byType, ...(daoResult.typeCounts || {}) };
  stats.bySource = { ...stats.bySource, ...(daoResult.sourceCounts || {}) };
  stats.byStoreClass = { ...stats.byStoreClass, ...(daoResult.storeClassCounts || {}) };
  return stats;
}

// 聚合指定时间范围内的采集日志统计
async function aggregateLogStats(filter) {
  const daoResult = await daos.autoCollectLogDao.aggregateStats(filter);
  return toLegacyLogStats(daoResult);
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
      aggregateLogStats({ collectedAtGte: todayStart }),
      aggregateLogStats({ collectedAtGte: weekStart }),
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

    const filter = {};
    if (sku) filter.sku = sku;
    if (statusRaw) {
      const statuses = statusRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      filter.status = statuses.length === 1 ? statuses[0] : statuses;
    }
    if (source) filter.source = source;
    if (sellerSlug) filter.sellerSlug = sellerSlug;
    if (startTime) filter.startTime = startTime;
    if (endTime) filter.endTime = endTime;

    const { items, total } = await daos.autoCollectLogDao.findPagedList(filter, currentPage, pageSize);

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
    const items = await daos.autoCollectLogDao.findBySku(sku);
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

    const r = await daos.autoCollectLogDao.insert(doc);
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
    const doc = await daos.storeClassificationDao.getBySlug(slug);
    if (!doc) return res.status(404).json({ error: 'not found' });
    return res.json(
      ok({
        sellerSlug: doc.sellerSlug || doc._id,
        sellerId: doc.sellerId || '',
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
// body: { sellerId, sellerName, isChinese, classifiedBy, companyInfo, lastSeenAt, lastSeenUrl }
// 已存在时更新 isChinese/classifiedBy/classifiedAt 并刷新 lastSeenAt
// sellerId 用于后续以 ID 为主键查询(sparse unique index 避免历史空值冲突)
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
    // sellerId 仅在非空时设置,避免空字符串违反 partialFilterExpression 唯一索引
    if (body.sellerId != null && String(body.sellerId) !== '') {
      update.sellerId = String(body.sellerId);
    }

    await daos.storeClassificationDao.upsertBySlug(slug, update);
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
    const r = await daos.storeClassificationDao.deleteBySlug(slug);
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

    const filter = {};
    // isChinese: 'true' → true, 'false' → false, 其他(包括不传/null) → 不过滤
    if (req.query.isChinese === 'true') filter.isChinese = true;
    else if (req.query.isChinese === 'false') filter.isChinese = false;
    if (keyword) filter.keyword = keyword;

    const { items, total } = await daos.storeClassificationDao.findPagedList(filter, currentPage, pageSize);

    return res.json(ok({ items, total, current: currentPage, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-classification] list failed');
    next(e);
  }
});

// ── 店铺 SKU 关联(/admin/api/store-sku) ───────────────────────
// ozon_store_sku 集合的 CRUD 端点
// 鉴权:全局 JWT;不走 storeGuard(全局共享)
// _id = SKU(一一对应:一个 SKU 只属于一家店铺)
// sellerId 为稳定主键(从 __NUXT__ 获取);sellerSlug 可变(店铺改名时会变)

// GET /admin/api/store-sku/:sku — 查询单条 SKU 关联
router.get('/admin/api/store-sku/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const doc = await daos.storeSkuDao.getBySku(sku);
    if (!doc) return res.status(404).json({ error: 'not found' });
    return res.json(ok(doc));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-sku] get failed');
    next(e);
  }
});

// POST /admin/api/store-sku — upsert SKU 关联
// body: { sku, sellerId, sellerSlug, sellerName, lastCollectAt, lastCollectStatus, lastCollectResults }
// 不传 lastCollect* 时只更新 firstSeenAt/lastSeenAt(发现上报);传时同时更新采集信息
router.post('/admin/api/store-sku', async (req, res, next) => {
  const body = req.body || {};
  const sku = String(body.sku || '');
  try {
    if (!sku) return res.status(400).json({ error: 'missing sku' });
    if (!body.sellerId) return res.status(400).json({ error: 'missing sellerId' });

    const setFields = {
      sellerId: String(body.sellerId),
      sellerSlug: body.sellerSlug != null ? String(body.sellerSlug) : '',
    };
    // sellerName 只在非空时更新,避免 SW 采集上报(sellerName=null)覆盖 panel 已写入的店铺名
    if (body.sellerName != null && String(body.sellerName) !== '') {
      setFields.sellerName = String(body.sellerName);
    }
    if (body.lastCollectAt) {
      setFields.lastCollectAt = new Date(body.lastCollectAt).toISOString();
      setFields.lastCollectStatus = body.lastCollectStatus != null ? String(body.lastCollectStatus) : '';
      setFields.lastCollectResults = Array.isArray(body.lastCollectResults) ? body.lastCollectResults : [];
    }

    await daos.storeSkuDao.upsertBySku(sku, setFields);
    return res.json(ok({ upserted: true, sku }));
  } catch (e) {
    logger.error({ err: e, sku: body?.sku, sellerId: body?.sellerId, body }, '[store-sku] upsert failed');
    next(e);
  }
});

// DELETE /admin/api/store-sku/:sku — 删除单条
router.delete('/admin/api/store-sku/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const r = await daos.storeSkuDao.deleteBySku(sku);
    return res.json(ok({ deletedCount: r.deletedCount }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-sku] delete failed');
    next(e);
  }
});

// GET /admin/api/store-sku/by-store/:slug — 按店铺 slug 查询所有 SKU 并 join card 缓存
// 返回 { items: [{ sku, sellerId, sellerSlug, sellerName, card: { name, price, image, ratingCount } }] }
// 供深度采集管理页面使用:一次请求拿到店铺全部 SKU + 商品卡信息(图片/评论数/价格)
router.get('/admin/api/store-sku/by-store/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '');
    if (!slug) return res.status(400).json({ error: 'missing slug' });

    // 查该店铺所有 SKU 关联记录
    const skuDocs = await daos.storeSkuDao.findBySellerSlug(slug);
    if (!skuDocs.length) return res.json(ok({ items: [], total: 0 }));

    // 批量查 card 缓存(DAO findManyBySkuList)
    const skus = skuDocs.map((d) => d.sku || d._id);
    const cardDocs = await daos.cardDao.findManyBySkuList(skus);
    const cardMap = new Map(cardDocs.map((d) => [d.sku || d._id, d.data || null]));

    const items = skuDocs.map((d) => ({
      sku: d.sku || d._id,
      sellerId: d.sellerId || '',
      sellerSlug: d.sellerSlug || '',
      sellerName: d.sellerName || '',
      card: cardMap.get(d.sku || d._id) || null,
    }));

    return res.json(ok({ items, total: items.length }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-sku] by-store failed');
    next(e);
  }
});

// GET /admin/api/store-sku — 列表查询(分页 + 关键字过滤)
// query: keyword(匹配 sellerSlug/sellerName/sellerId/sku)/currentPage/pageSize
router.get('/admin/api/store-sku', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const currentPage = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));

    const { items, total } = await daos.storeSkuDao.findPagedList(keyword, currentPage, pageSize);

    // _id 即 SKU,补到 sku 字段方便前端展示(DAO 已补 sku,这里兜底)
    for (const it of items) {
      it.sku = it.sku || it._id;
    }

    return res.json(ok({ items, total, current: currentPage, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-sku] list failed');
    next(e);
  }
});

export default router;
