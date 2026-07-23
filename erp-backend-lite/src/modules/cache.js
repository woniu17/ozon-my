// Ozon dom/attribute/richMedia/marketStats/followSell 缓存路由(5 类合并表)
// 存储驱动通过 DAO 层(adapter.js)注入:DB_DRIVER=sqlite(默认)|mongo
// - dom:无 TTL(永久),card + detail 合并表,字段独立,互相备份
//       card=商品卡 DOM 字段(sku/url/name/price/image),搜索页/店铺页采集
//       detail=详情页 DOM 全字段(原 pdp 静态 + dynamic 动态合并),DOM 解析失败时兜底
// - attribute:无 TTL(永久),search + bundle 合并表,字段独立,各自保留
//       bundle 空属性 6h 重验;forceRefresh 主动删除
// - richMedia:无 TTL(永久),PDP 富内容(原 entrypoint + composer 合并)
// - marketStats:无 TTL(永久),市场统计(销量/价格分布等),stale 判定 24h(86400000ms)
// - followSell:无 TTL(永久),跟卖信息,stale 判定 4h(14400000ms)
// 列表查询走 ozon_cache_index 索引表(由 indexDao 维护),过滤/排序/分页全在 SQL 完成
// 另含:ozon_auto_collect_log 采集日志端点 + ozon_store_classification 店铺分类端点
// 鉴权:JWT(authMiddleware),不走 storeGuard(缓存按 sku 全局共享,不区分店铺)
import { Router } from 'express';
import { getDaos } from '../db/adapter.js';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';
import { composeSvShape } from '../services/compose-sv-shape.js';
import {
  resolveAttrWhitelist,
  injectRichContentAttr,
  buildOpiItem,
} from '../services/opi-item-builder.js';
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

// ── dom 缓存(card + detail 合并表,字段独立,互相备份) ─────────────────────────

// GET /ozon/cache/dom/:sku
// 返回 { card, detail, cardFetchedAt, detailFetchedAt }
router.get('/ozon/cache/dom/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const r = await daos.domDao.getBySku(sku);
    return res.json(r);
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] dom get failed');
    next(e);
  }
});

// POST /ozon/cache/dom/:sku  body: { type: 'card'|'detail', data }
// type=card 写入 card_data;type=detail 写入 detail_data(互不影响)
router.post('/ozon/cache/dom/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const type = req.body?.type === 'detail' ? 'detail' : 'card';
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    if (type === 'detail') {
      await daos.domDao.upsertDetail(sku, data);
    } else {
      await daos.domDao.upsertCard(sku, data);
    }
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] dom set failed');
    next(e);
  }
});

// DELETE /ozon/cache/dom/:sku
router.delete('/ozon/cache/dom/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    await daos.domDao.deleteBySku(sku);
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] dom delete failed');
    next(e);
  }
});

// ── attribute 缓存(search + bundle 合并表,字段独立) ─────────────────────────

// GET /ozon/cache/attribute/:sku
// 返回 { searchData, bundleData, searchFetchedAt, bundleFetchedAt, bundleId, attrsEmptyVerifiedAt, stale }
// - stale=true 表示空属性超过 6h 需重验(调用方应真拉刷新)
router.get('/ozon/cache/attribute/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const r = await daos.attributeDao.getBySku(sku);
    return res.json(r);
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] attribute get failed');
    next(e);
  }
});

// POST /ozon/cache/attribute/:sku  body: { type: 'search'|'bundle', data, bundleId? }
// type=search 写入 search_data;type=bundle 写入 bundle_data + bundle_id(空属性时附 attrs_empty_verified_at)
router.post('/ozon/cache/attribute/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const type = req.body?.type === 'search' ? 'search' : 'bundle';
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    if (type === 'search') {
      await daos.attributeDao.upsertSearch(sku, data);
    } else {
      const bundleId = req.body?.bundleId || null;
      await daos.attributeDao.upsertBundle(sku, data, { bundleId });
    }
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] attribute set failed');
    next(e);
  }
});

// DELETE /ozon/cache/attribute/:sku
router.delete('/ozon/cache/attribute/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    await daos.attributeDao.deleteBySku(sku);
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] attribute delete failed');
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
// data 结构: { count, sellers:[14字段], source }
// 副作用:从 sellers 抽取店铺数据 upsert 到 ozon_store_classification(失败不阻塞主流程)
router.post('/ozon/cache/followSell/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    await daos.followSellDao.upsert(sku, data);
    // 店铺抽取:从 sellers 数组提取每个卖家信息,upsert 到 store_classification
    // 失败仅 warn 日志,不影响主缓存写入;isMainlandChina/classifiedBy 不动(保留原值)
    await extractSellersToStoreClassification(data).catch((e) => {
      logger.warn({ err: e.message, sku }, '[cache] followSell store extract failed');
    });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] followSell set failed');
    next(e);
  }
});

// 从跟卖 sellers 数组抽取店铺数据 upsert 到 ozon_store_classification
// seller.id 必须是纯数字(与 __NUXT__ sellerId 体系一致),否则跳过
// companyInfo 存结构化对象 { companyName, legalAddress, country }
// isMainlandChina 判定:仅 credentials[2] 国家代码 === 'CN' 时为 true(中国大陆卖家),
//   HK(香港)/其他/无法识别 → false,与现有 collect-runner.js Rule 3/4 对齐
// classifiedBy='rule:follow-sell-credentials',标识来源为跟卖列表抽取
async function extractSellersToStoreClassification(data) {
  const sellers = Array.isArray(data?.sellers) ? data.sellers : [];
  if (!sellers.length) return;
  const now = new Date().toISOString();
  for (const s of sellers) {
    if (!s?.id) continue;
    const sellerId = String(s.id);
    if (!/^\d+$/.test(sellerId)) continue; // 防止 slug 被当 sellerId
    // 从 link "/seller/3308213/" 提取 slug,失败则用 id
    const slugMatch = (s.link || '').match(/\/seller\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : sellerId;
    // 从 credentials[2] "<国家代码>, <地区>" 提取国家代码
    const creds = Array.isArray(s.credentials) ? s.credentials : [];
    const locField = creds[2] || '';
    const countryMatch = String(locField).match(/^([A-Z]{2})\b/);
    const country = countryMatch ? countryMatch[1] : null;
    const isMainlandChina = country === 'CN'; // 仅中国大陆,HK/其他均为 false
    // 构造结构化 companyInfo(与 seller-info-main.js 格式对齐,供规则引擎复用)
    const companyInfo = {
      companyName: creds[0] || null,
      legalAddress: creds[1] || null,
      country: country,
    };
    try {
      await daos.storeClassificationDao.upsertBySellerId(sellerId, {
        sellerSlug: slug,
        sellerName: s.name || null,
        companyInfo,
        logoImageUrl: s.logoImageUrl || null,
        isMainlandChina,
        classifiedBy: 'rule:follow-sell-credentials',
        lastSeenAt: now,
        lastSeenUrl: s.link || null,
      });
    } catch (e) {
      // 单条失败不中断,继续处理其他 seller
      logger.warn({ err: e.message, sellerId }, '[cache] store upsert single failed');
    }
  }
}

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

// POST /ozon/cache/status-batch — 批量查询多 SKU × 5 类缓存的命中位矩阵
// 入参: { skus: string[] } 最多 200 个 SKU
// 出参: { [sku]: { dom, attribute, richMedia, marketStats, followSell } }(全 boolean)
// 用途:SW 端 queryCacheStatusBatch 用 1 次 HTTP 替代原来对每个 SKU 调
//       _queryCacheStatusOne 的 7N 次 HTTP(其中 dom card/detail 和 attribute
//       search/bundle 是同一接口的重复请求)。
// 命中规则(对齐 _queryCacheStatusOne):
//   dom = card_data OR detail_data 非空
//   attribute = search_data AND bundle_data 都非空
//   richMedia / marketStats / followSell = data 字段非空
router.post('/ozon/cache/status-batch', async (req, res, next) => {
  try {
    const rawSkus = Array.isArray(req.body?.skus) ? req.body.skus : [];
    const skus = rawSkus.map(String).filter(Boolean).slice(0, 200);
    if (!skus.length) return res.json(ok({}));

    const result = {};
    for (const sku of skus) {
      result[sku] = {
        dom: false,
        attribute: false,
        richMedia: false,
        marketStats: false,
        followSell: false,
      };
    }
    const placeholders = skus.map(() => '?').join(', ');

    // 5 类缓存各一次 SQL,IN 子句批量查
    const domRows = db
      .prepare(
        `SELECT _id,
                (card_data IS NOT NULL AND card_data != '') AS card_hit,
                (detail_data IS NOT NULL AND detail_data != '') AS detail_hit
         FROM ozon_dom_cache WHERE _id IN (${placeholders})`
      )
      .all(...skus);
    for (const r of domRows) {
      if (result[r._id]) result[r._id].dom = !!(r.card_hit || r.detail_hit);
    }

    const attrRows = db
      .prepare(
        `SELECT _id,
                (search_data IS NOT NULL AND search_data != '') AS search_hit,
                (bundle_data IS NOT NULL AND bundle_data != '') AS bundle_hit
         FROM ozon_attribute_cache WHERE _id IN (${placeholders})`
      )
      .all(...skus);
    for (const r of attrRows) {
      if (result[r._id]) result[r._id].attribute = !!(r.search_hit && r.bundle_hit);
    }

    const richRows = db
      .prepare(
        `SELECT _id FROM ozon_rich_media_cache
         WHERE _id IN (${placeholders}) AND data IS NOT NULL AND data != ''`
      )
      .all(...skus);
    for (const r of richRows) result[r._id].richMedia = true;

    const marketRows = db
      .prepare(
        `SELECT _id FROM ozon_market_stats_cache
         WHERE _id IN (${placeholders}) AND data IS NOT NULL AND data != ''`
      )
      .all(...skus);
    for (const r of marketRows) result[r._id].marketStats = true;

    const followRows = db
      .prepare(
        `SELECT _id FROM ozon_follow_sell_cache
         WHERE _id IN (${placeholders}) AND data IS NOT NULL AND data != ''`
      )
      .all(...skus);
    for (const r of followRows) result[r._id].followSell = true;

    return res.json(ok(result));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] status-batch failed');
    next(e);
  }
});

// ── 管理后台 API(/admin/api/cache/*) ───────────────────────
// 列表/统计/详情/清空,供前端缓存管理页面使用

// GET /admin/api/cache/stats — 缓存统计(5 类合并表文档数 + 空属性数)
router.get('/admin/api/cache/stats', async (req, res, next) => {
  try {
    const [counts, emptyAttrs, stale] = await Promise.all([
      daos.indexDao.getCacheCounts(),
      daos.attributeDao.countEmptyAttrs(),
      daos.attributeDao.countStaleEmptyAttrs(),
    ]);
    return res.json(
      ok({
        dom: { count: counts.dom },
        attribute: { count: counts.attribute, emptyAttrs, stale },
        richMedia: { count: counts.richMedia },
        marketStats: { count: counts.marketStats },
        followSell: { count: counts.followSell },
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] stats failed');
    next(e);
  }
});

// 类型 → DAO 映射(管理接口统一入口)
const CACHE_TYPES = ['dom', 'attribute', 'richMedia', 'marketStats', 'followSell'];
const getDaoByType = (type) => {
  switch (type) {
    case 'dom':
      return daos.domDao;
    case 'attribute':
      return daos.attributeDao;
    case 'richMedia':
      return daos.richMediaDao;
    case 'marketStats':
      return daos.marketStatsDao;
    case 'followSell':
      return daos.followSellDao;
    default:
      return daos.attributeDao;
  }
};

// GET /admin/api/cache/list — 缓存列表(支持 type/search/分页)
// query: type=dom|attribute|richMedia|marketStats|followSell, keyword, page, pageSize
router.get('/admin/api/cache/list', async (req, res, next) => {
  try {
    const type = CACHE_TYPES.includes(req.query.type) ? req.query.type : 'attribute';
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const { items, total } = await getDaoByType(type).findPagedList(keyword, page, pageSize);

    // 按类型差异化重塑
    const reshaped = items.map((d) => {
      const sku = d.sku || d._id;
      if (type === 'marketStats' || type === 'followSell') {
        const staleMs = type === 'marketStats' ? MARKET_STATS_STALE_MS : FOLLOW_SELL_STALE_MS;
        const fetchedAtMs = d.fetchedAt ? new Date(d.fetchedAt).getTime() : 0;
        const stale = !fetchedAtMs || Date.now() - fetchedAtMs > staleMs;
        return { sku, fetchedAt: d.fetchedAt, l2Synced: d.l2Synced === true, stale };
      }
      if (type === 'dom') {
        return {
          sku,
          cardFetchedAt: d.cardFetchedAt,
          detailFetchedAt: d.detailFetchedAt,
        };
      }
      if (type === 'attribute') {
        // DAO 已预计算 attrsEmpty/attrsStale
        return {
          sku,
          searchFetchedAt: d.searchFetchedAt,
          bundleFetchedAt: d.bundleFetchedAt,
          bundleId: d.bundleId || null,
          attrsEmptyVerifiedAt: d.attrsEmptyVerifiedAt || null,
          attrsEmpty: d.attrsEmpty,
          attrsStale: d.attrsStale,
        };
      }
      // richMedia
      return { sku, fetchedAt: d.fetchedAt };
    });

    return res.json(ok({ items: reshaped, total, page, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] list failed');
    next(e);
  }
});

// ── 采集箱·缓存视图:走 ozon_cache_index 单表查询 ──
// 用于前端"采集箱"页面:从 indexDao 单表查询,过滤/排序/分页全在 SQL 完成
// 冗余字段(name/price/primary_image/url/rating_count/has_video/market_price_p50/competitor_count)
// 由 indexDao.syncSku 在数据表 upsert 时同步,listed/seller_slug/seller_name 由定时任务批量刷新
router.get('/admin/api/collect-box-v2/from-cache', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    // hasVideo=1:richMedia 缓存含 mp4(indexDao 已冗余 has_video,SQL 直接过滤)
    const filterHasVideo = req.query.hasVideo === '1' || req.query.hasVideo === 'true';
    // hasRichContent=1:richMedia 缓存含富内容(richContent 字段非空,11254 属性)
    const filterHasRichContent = req.query.hasRichContent === '1' || req.query.hasRichContent === 'true';
    // minCacheHits=N:3 类合并缓存命中数 ≥ N(dom + attribute + richMedia)
    //   dom_hit = card OR detail(任一有采集)
    //   attribute_hit = search AND bundle(都需要)
    //   rich_media_hit = richMedia
    const minCacheHits = Math.max(0, Math.min(3, Number(req.query.minCacheHits) || 0));
    // hasComments=1:rating_count > 0(索引表已冗余 rating_count)
    const filterHasComments = req.query.hasComments === '1' || req.query.hasComments === 'true';
    // 价格范围:priceMin/priceMax(闭区间,基于索引表冗余 price 字段)
    //   注意:price 可能为空字符串,CAST(price AS REAL) 对空串返回 0,需额外排除空值
    const priceMin = Number(req.query.priceMin);
    const priceMax = Number(req.query.priceMax);

    // ⚠️ "店铺筛选"语义:采集到的 SKU 所属源卖家(ozon_auto_collect_log.sellerId)
    //   与"用户自己的店铺"(stores.json,用于上架)是两个正交概念
    // - sellerId:源 SKU 所属卖家 ID(可选,稳定主键)。索引表冗余 seller_id,SQL 直接过滤
    // - sellerSlug:兼容字段(可变,店铺改名时变化)。sellerId 优先
    // - unlisted=1:只返回未跟卖的(索引表冗余 listed,SQL 直接过滤)
    const sellerId = String(req.query.sellerId || '').trim();
    const sellerSlug = String(req.query.sellerSlug || '').trim();
    const filterUnlisted = req.query.unlisted === '1' || req.query.unlisted === 'true';
    // excludeFilteredCategories=1:排除已在类目过滤黑名单(ozon_filtered_categories)中的商品
    // 前端采集箱"排除类型过滤"勾选项,与 toggleFilter 写入的 ozon_filtered_categories 表联动
    const excludeFilteredCategories =
      req.query.excludeFilteredCategories === '1' || req.query.excludeFilteredCategories === 'true';

    // indexDao 单表查询:过滤 + 排序 + 分页全在 SQL 完成
    const { items, total } = await daos.indexDao.findList({
      keyword,
      sellerId,
      sellerSlug,
      unlisted: filterUnlisted,
      hasComments: filterHasComments,
      hasVideo: filterHasVideo,
      hasRichContent: filterHasRichContent,
      priceMin: Number.isFinite(priceMin) ? priceMin : undefined,
      priceMax: Number.isFinite(priceMax) ? priceMax : undefined,
      minCacheHits,
      excludeFilteredCategories,
      page,
      pageSize,
    });

    // 重塑为前端期望的字段格式(索引表字段为 snake_case,需转 camelCase)
    const reshaped = items.map((r) => ({
      sku: r.sku,
      name: r.name || '',
      price: r.price ?? '',
      primaryImage: r.primary_image || '',
      url: r.url || '',
      cacheHits: {
        // 5 类合并命中位(采集状态:dom + attribute + richMedia + marketStats + followSell)
        //   dom = card OR detail(任一有采集)
        //   attribute = search AND bundle(都需要)
        //   richMedia / marketStats / followSell 各自独立
        dom: !!(r.card_hit || r.detail_hit),
        attribute: !!(r.search_hit && r.bundle_hit),
        richMedia: !!r.rich_media_hit,
        marketStats: !!r.market_stats_hit,
        followSell: !!r.follow_sell_hit,
      },
      // hitCount = 5 类合并命中数(0-5)
      // 注:"数据完整"筛选(minCacheHits=3)只看 dom + attribute + richMedia 三类
      hitCount:
        (r.card_hit || r.detail_hit ? 1 : 0) +
        (r.search_hit && r.bundle_hit ? 1 : 0) +
        (r.rich_media_hit ? 1 : 0) +
        (r.market_stats_hit ? 1 : 0) +
        (r.follow_sell_hit ? 1 : 0),
      hasVideo: !!r.has_video,
      hasRichContent: !!r.has_rich_content,
      marketPriceP50: r.market_price_p50 ?? null,
      competitorCount: r.competitor_count ?? null,
      // 评论数:索引表冗余 rating_count(数字,采集自 card DOM)。可能为 null
      ratingCount: Number.isFinite(Number(r.rating_count)) ? Number(r.rating_count) : null,
      lastCollectedAt: r.last_fetched_at,
      // 采集源卖家(由 index-sync 定时任务批量刷新)
      sellerId: r.seller_id || '',
      sellerSlug: r.seller_slug || '',
      sellerName: r.seller_name || '',
      // 类目信息(2026-07 新增,供类目过滤功能使用)
      descriptionCategoryId:
        Number.isFinite(Number(r.description_category_id)) ? Number(r.description_category_id) : null,
      typeId: Number.isFinite(Number(r.type_id)) ? Number(r.type_id) : null,
      categoryName: r.category_name || '',
      // 上架状态(由 index-sync 定时任务批量刷新)
      listed: !!r.listed,
      // 兼容旧卡片字段(避免前端报错)
      storeId: '',
      anchorSku: r.sku,
      collectSource: 'cache',
      collectedAt: null,
      createdAt: r.last_fetched_at,
    }));

    return res.json(ok({ items: reshaped, total, current: page, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] collect-box-v2/from-cache failed');
    next(e);
  }
});

// GET /admin/api/collect-box-v2/sellers — 采集源卖家列表(供下拉框)
// 返回 [{ sellerId, sellerSlug, sellerName, skuCount }] — 按 skuCount 降序
// 2026-07:改用 sellerId 分组(稳定主键),sellerSlug/sellerName 取任一非空值
router.get('/admin/api/collect-box-v2/sellers', async (_req, res, next) => {
  try {
    // 数据源:ozon_store_sku(店铺-SKU 关联表,记录每个 SKU 采集自哪个卖家)
    const rows = db
      .prepare(
        `SELECT sellerId,
                MAX(sellerSlug) AS sellerSlug,    -- 同一 sellerId 取任一非空 slug
                MAX(sellerName) AS sellerName,   -- 同一 sellerId 取任一非空名
                COUNT(*) AS skuCount
         FROM ozon_store_sku
         WHERE sellerId IS NOT NULL AND sellerId <> ''
         GROUP BY sellerId
         ORDER BY skuCount DESC`
      )
      .all();
    const sellers = rows.map((r) => ({
      sellerId: r.sellerId,
      sellerSlug: r.sellerSlug || '',
      sellerName: r.sellerName || '',
      skuCount: r.skuCount,
    }));
    return res.json(ok(sellers));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] collect-box-v2/sellers failed');
    next(e);
  }
});

// GET /admin/api/cache/:type/:sku — 缓存详情(完整 data)
router.get('/admin/api/cache/:type/:sku', async (req, res, next) => {
  try {
    // overview / opi-preview / listed 走专属路由,这里跳过(避免被 :type 参数捕获)
    if (['overview', 'opi-preview', 'listed'].includes(req.params.type)) return next('route');
    const type = CACHE_TYPES.includes(req.params.type) ? req.params.type : 'attribute';
    const sku = String(req.params.sku);
    const doc = await getDaoByType(type).findById(sku);
    if (!doc) return res.json(ok(null));

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
    if (type === 'dom') {
      return res.json(
        ok({
          sku: doc.sku || doc._id,
          card: doc.card,
          cardFetchedAt: doc.cardFetchedAt,
          detail: doc.detail,
          detailFetchedAt: doc.detailFetchedAt,
        })
      );
    }
    if (type === 'attribute') {
      return res.json(
        ok({
          sku: doc.sku || doc._id,
          searchData: doc.searchData,
          searchFetchedAt: doc.searchFetchedAt,
          bundleData: doc.bundleData,
          bundleFetchedAt: doc.bundleFetchedAt,
          bundleId: doc.bundleId,
          attrsEmptyVerifiedAt: doc.attrsEmptyVerifiedAt,
        })
      );
    }
    // richMedia
    return res.json(
      ok({
        sku: doc.sku || doc._id,
        data: doc.data,
        fetchedAt: doc.fetchedAt,
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] detail failed');
    next(e);
  }
});

// DELETE /admin/api/cache/sku/:sku — 删除单个 SKU 的全部缓存(5 类数据表 + 索引行)
// 用于"SKU 数据管理"页单个删除:一次清掉该 SKU 在 dom/attribute/richMedia/marketStats/followSell
// 5 张表的所有记录 + ozon_cache_index 索引行
// 注:此路由必须注册在 /admin/api/cache/:type/:sku 之前,否则 :type 会匹配到 "sku"
router.delete('/admin/api/cache/sku/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    if (!sku) return res.status(400).json({ error: 'sku required' });
    let deletedTables = 0;
    for (const type of CACHE_TYPES) {
      try {
        await getDaoByType(type).deleteBySku(sku);
        deletedTables++;
      } catch (e) {
        logger.warn({ err: e.message, type, sku }, '[cache] deleteSkuAll: table delete failed');
      }
    }
    try {
      await daos.indexDao.deleteSku(sku);
    } catch (e) {
      logger.warn({ err: e.message, sku }, '[cache] deleteSkuAll: index delete failed');
    }
    return res.json(ok({ sku, deletedTables }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] deleteSkuAll failed');
    next(e);
  }
});

// POST /admin/api/cache/skus/delete — 批量删除 SKU 的全部缓存
// body: { skus?: string[], filter?: { keyword?: string } }
//   - skus 非空:按显式 SKU 数组删除(选中删除)
//   - skus 为空且 filter 提供:按筛选条件删除(当前条件筛选删除,目前只支持 keyword)
// 返回: { deletedCount, failed: [{sku, error}] }
router.post('/admin/api/cache/skus/delete', async (req, res, next) => {
  try {
    const skus = Array.isArray(req.body?.skus)
      ? req.body.skus.map((s) => String(s)).filter(Boolean)
      : [];
    const filter = req.body?.filter && typeof req.body.filter === 'object' ? req.body.filter : null;

    // 按筛选条件解析目标 SKU 列表(目前 overview 只支持 keyword 过滤)
    let targetSkus = skus;
    if (targetSkus.length === 0 && filter) {
      const keyword = String(filter.keyword || '').trim();
      // 直接查 ozon_cache_index,与 overview 列表筛选条件保持一致
      // 注:此处不复用 findOverviewList 的分页,直接拿全部匹配 SKU
      // FTS5 + LIKE 双路径:与 findList 一致,避免纯 CJK keyword 走 FTS5 漏匹配
      let rows;
      if (keyword) {
        // 检测 CJK:含 CJK 的 keyword 走 LIKE 路径(FTS5 unicode61 不分词中文)
        const hasCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(keyword);
        if (hasCjk) {
          rows = db
            .prepare(`SELECT sku FROM ozon_cache_index WHERE searchable_text LIKE ? COLLATE NOCASE`)
            .all(`%${keyword}%`)
            .map((r) => r.sku);
        } else {
          // FTS5 转义(与 index-dao.js fts5Escape 一致):移除特殊字符 + 每词加前缀 *
          const cleaned = keyword.replace(/["*()\-:]/g, ' ').trim();
          const ftsExpr = cleaned
            .split(/\s+/)
            .filter(Boolean)
            .map((w) => `"${w}"*`)
            .join(' ');
          if (ftsExpr) {
            rows = db
              .prepare(
                `SELECT DISTINCT sku FROM ozon_cache_index
                 WHERE sku IN (SELECT sku FROM ozon_cache_index_fts WHERE ozon_cache_index_fts MATCH ?)`
              )
              .all(ftsExpr)
              .map((r) => r.sku);
          } else {
            rows = db
              .prepare(`SELECT sku FROM ozon_cache_index WHERE searchable_text LIKE ? COLLATE NOCASE`)
              .all(`%${keyword}%`)
              .map((r) => r.sku);
          }
        }
      } else {
        // 无 keyword:删除全部
        rows = db.prepare(`SELECT sku FROM ozon_cache_index`).all().map((r) => r.sku);
      }
      targetSkus = rows.filter(Boolean);
    }

    if (targetSkus.length === 0) {
      return res.json(ok({ deletedCount: 0, failed: [], total: 0 }));
    }

    let deletedCount = 0;
    const failed = [];
    for (const sku of targetSkus) {
      try {
        for (const type of CACHE_TYPES) {
          try {
            await getDaoByType(type).deleteBySku(sku);
          } catch (e) {
            // 单表失败不阻断,记录日志继续
            logger.warn({ err: e.message, type, sku }, '[cache] batch delete: table delete failed');
          }
        }
        try {
          await daos.indexDao.deleteSku(sku);
        } catch (e) {
          logger.warn({ err: e.message, sku }, '[cache] batch delete: index delete failed');
        }
        deletedCount++;
      } catch (e) {
        failed.push({ sku, error: e.message || String(e) });
      }
    }
    return res.json(ok({ deletedCount, failed, total: targetSkus.length }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] batch delete failed');
    next(e);
  }
});

// DELETE /admin/api/cache/:type/:sku — 删除单条
router.delete('/admin/api/cache/:type/:sku', async (req, res, next) => {
  try {
    const type = CACHE_TYPES.includes(req.params.type) ? req.params.type : 'attribute';
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
    const type = CACHE_TYPES.includes(req.params.type) ? req.params.type : 'attribute';
    const r = await getDaoByType(type).clearAll();
    return res.json(ok({ deletedCount: r.deletedCount }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] clear all failed');
    next(e);
  }
});

// ── 全览接口:走 ozon_cache_index 单表查询 ─────────────────────────

// GET /admin/api/cache/overview — 全览列表(索引表命中位矩阵)
// query: keyword, page, pageSize
// 返回: { items: [{ sku, card:{fetchedAt}, detail:{fetchedAt}, search:{fetchedAt},
//                  bundle:{fetchedAt}, richMedia:{fetchedAt},
//                  marketStats:{fetchedAt,stale}, followSell:{fetchedAt,stale},
//                  hitCount, lastFetchedAt, listed }], total }
router.get('/admin/api/cache/overview', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));

    const { items, total } = await daos.indexDao.findOverviewList(keyword, page, pageSize);

    const reshaped = items.map((r) => {
      const mkStale = (fetchedAt, staleMs) => {
        const fetchedAtMs = fetchedAt ? new Date(fetchedAt).getTime() : 0;
        return !fetchedAtMs || Date.now() - fetchedAtMs > staleMs;
      };
      return {
        sku: r.sku,
        card: r.card_hit ? { fetchedAt: r.card_fetched_at } : null,
        detail: r.detail_hit ? { fetchedAt: r.detail_fetched_at } : null,
        search: r.search_hit ? { fetchedAt: r.search_fetched_at } : null,
        bundle: r.bundle_hit ? { fetchedAt: r.bundle_fetched_at } : null,
        richMedia: r.rich_media_hit ? { fetchedAt: r.rich_media_fetched_at } : null,
        marketStats: r.market_stats_hit
          ? {
              fetchedAt: r.market_stats_fetched_at,
              stale: mkStale(r.market_stats_fetched_at, MARKET_STATS_STALE_MS),
            }
          : null,
        followSell: r.follow_sell_hit
          ? {
              fetchedAt: r.follow_sell_fetched_at,
              stale: mkStale(r.follow_sell_fetched_at, FOLLOW_SELL_STALE_MS),
            }
          : null,
        hitCount: r.hit_count || 0,
        lastFetchedAt: r.last_fetched_at,
        listed: !!r.listed,
      };
    });

    return res.json(ok({ items: reshaped, total, page, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] overview failed');
    next(e);
  }
});

// GET /admin/api/cache/listed/:sku — 按 SKU 查跟卖记录
// 返回该 SKU 关联的所有 follow_sell_task_items 记录(JOIN follow_sell_tasks 取店铺/任务时间)
// offer_id 格式 {SKU}-{mmdd}-qx,用 LIKE 通配符匹配
router.get('/admin/api/cache/listed/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    if (!sku) return res.json(ok({ items: [] }));
    const rows = db
      .prepare(
        `SELECT
           ti.id, ti.local_task_id, ti.offer_id, ti.name, ti.price,
           ti.product_id, ti.status, ti.errors,
           ti.stock_set, ti.stock_attempts,
           ti.created_at AS item_created_at,
           ti.updated_at AS item_updated_at,
           t.store_id, t.status AS task_status, t.created_at AS task_created_at,
           t.completed_at AS task_completed_at
         FROM follow_sell_task_items ti
         JOIN follow_sell_tasks t ON t.local_task_id = ti.local_task_id
         WHERE ti.offer_id LIKE ? || '-%'
         ORDER BY ti.created_at DESC`
      )
      .all(sku);
    const items = rows.map((r) => ({
      id: r.id,
      localTaskId: r.local_task_id,
      offerId: r.offer_id,
      name: r.name,
      price: r.price,
      productId: r.product_id,
      status: r.status,
      errors: r.errors ? safeJsonParse(r.errors) : null,
      stockSet: r.stock_set,
      stockAttempts: r.stock_attempts,
      itemCreatedAt: r.item_created_at,
      itemUpdatedAt: r.item_updated_at,
      storeId: r.store_id,
      taskStatus: r.task_status,
      taskCreatedAt: r.task_created_at,
      taskCompletedAt: r.task_completed_at,
    }));
    return res.json(ok({ items }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] listed failed');
    next(e);
  }
});

// 安全 JSON 解析(失败返回原字符串)
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ── 缓存合成 helper(opi-preview + preview/profile 共用) ───
// 从 3 类合并表(dom/attribute/richMedia)合成 OPI 输入 item
// 返回 { sources, item, portalItem, opiItem, raw } 或 { sources, error }
export async function buildSynthesizedFromCache(sku, storeId) {
  const [domDoc, attrDoc, rmDoc] = await Promise.all([
    daos.domDao.findById(sku),
    daos.attributeDao.findById(sku),
    daos.richMediaDao.findById(sku),
  ]);

  // sources 同时返回新合并表维度 + 兼容旧拆解维度(供前端 sources 标签展示)
  const sources = {
    dom: !!domDoc,
    attribute: !!attrDoc,
    richMedia: !!rmDoc,
    // 兼容字段(旧前端 sources.search/bundle/card/detail 标签)
    card: !!(domDoc?.card),
    detail: !!(domDoc?.detail),
    search: !!(attrDoc?.searchData),
    bundle: !!(attrDoc?.bundleData),
  };

  if (!attrDoc) {
    return { sources, error: '缺少 attribute 缓存,无法合成 OPI' };
  }

  const cardData = domDoc?.card || null;
  const detailData = domDoc?.detail || null;
  const searchData = attrDoc?.searchData || null;
  const bundleData = attrDoc?.bundleData || null;
  const richMediaData = rmDoc?.data || null;

  // 方案B:search cache 存原始 variants,bundle cache 存原始 bundle item,
  // 通过 composeSvShape 在读取时合成 sv shape(含 bundle merge 后的物理属性 / complex属性)
  const searchRaw =
    searchData && Array.isArray(searchData.items) && searchData.items.length > 0
      ? searchData.items[0]
      : null;
  const bundleItem = bundleData || {};
  const composedSv = composeSvShape(searchRaw, bundleItem) || {};
  const sv = composedSv;
  const bundleComplexAttrs = Array.isArray(composedSv._bundleComplexAttrs)
    ? composedSv._bundleComplexAttrs
    : Array.isArray(bundleItem.attributes)
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

  // 11254 富内容注入:统一走 opi-item-builder
  // search/bundle 接口都不返回 11254,只有 richMedia 缓存中有,需显式注入
  injectRichContentAttr(item, richMediaData?.richContent || '');

  // 字典白名单 + 属性字典(供前端展示可读属性名)
  // 字典查询需要任一 store 的认证;storeId 未传时退而取第一个 store(仅为字典展示用,不影响白名单)
  // 白名单仅在用户选中具体 store 时启用(不同 store 可能有不同类目过滤策略)
  const stores = readStoresForPreview();
  const store = storeId
    ? stores.find((s) => s.id === storeId)
    : stores[0] || null;
  const { allowedAttrIds, attrDict: attrDictOrNull } = await resolveAttrWhitelist(store, item, {
    returnAttrDict: true,
    enableWhitelist: !!storeId,
  });
  const attrDict = attrDictOrNull || {};

  const { portalItem, opiItem } = buildOpiItem(item, { allowedAttrIds });

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
// 聚合 3 类合并表(dom/attribute/richMedia) + marketStats/followSell,返回原始字段 + 合成 OPI item
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
      descriptionCategoryId: portalItem.description_category_id || null,
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
const LOG_STORE_CLASSES = ['mainland-china', 'non-mainland-china', 'unclassified'];
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
// query: sku/status(逗号分隔多值)/source/sellerId/sellerSlug/currentPage/pageSize/startTime/endTime
// 2026-07:sellerId 优先(稳定主键),sellerSlug 兼容
router.get('/admin/api/auto-collect/logs', async (req, res, next) => {
  try {
    const sku = String(req.query.sku || '').trim();
    const statusRaw = String(req.query.status || '').trim();
    const source = String(req.query.source || '').trim();
    const sellerId = String(req.query.sellerId || '').trim();
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
    if (sellerId) filter.sellerId = sellerId;
    else if (sellerSlug) filter.sellerSlug = sellerSlug;
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
// body: { sku, source, sellerSlug, sellerId, storeClassified, depth, status, results, totalDuration, collectedAt }
// results: 数组,每项 { type, hit, error? }
// 2026-07:sellerId 推荐传入(稳定主键),sellerSlug 兼容
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
      sellerId: body.sellerId != null ? String(body.sellerId) : null,
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

// ── 浅度采集日志(/admin/api/shallow-collect) ───────────────────
// 与 auto-collect(深度)日志的区别:
//   深度:SW 实际执行采集流程后的完整记录(success/partial/failed/...+ results 数组)
//   浅度:店铺页扫描发现的每个 SKU 一条(仅记录 card 字段 + passesFilter + skipReason)
// 用途:排查过滤效果(略过原因分布)+ 浅度采集统计

// GET /admin/api/shallow-collect/stats — 浅度采集日志统计(今日 + 本周)
router.get('/admin/api/shallow-collect/stats', async (req, res, next) => {
  try {
    const todayStart = startOfToday();
    const weekStart = startOfWeek();
    const [today, week] = await Promise.all([
      daos.shallowCollectLogDao.aggregateStats({ collectedAtGte: todayStart }),
      daos.shallowCollectLogDao.aggregateStats({ collectedAtGte: weekStart }),
    ]);
    return res.json(ok({ today, week }));
  } catch (e) {
    logger.warn({ err: e.message }, '[shallow-collect] stats failed');
    next(e);
  }
});

// GET /admin/api/shallow-collect/logs — 浅度采集日志列表(分页 + 过滤)
// query: sku/passesFilter(0|1)/skipReason/source/sellerId/sellerSlug/currentPage/pageSize/startTime/endTime
// 2026-07:sellerId 优先(稳定主键),sellerSlug 兼容
router.get('/admin/api/shallow-collect/logs', async (req, res, next) => {
  try {
    const sku = String(req.query.sku || '').trim();
    const passesFilterRaw = String(req.query.passesFilter || '').trim();
    const skipReason = String(req.query.skipReason || '').trim();
    const source = String(req.query.source || '').trim();
    const sellerId = String(req.query.sellerId || '').trim();
    const sellerSlug = String(req.query.sellerSlug || '').trim();
    const currentPage = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
    const startTime = req.query.startTime ? new Date(Number(req.query.startTime) || req.query.startTime) : null;
    const endTime = req.query.endTime ? new Date(Number(req.query.endTime) || req.query.endTime) : null;

    const filter = {};
    if (sku) filter.sku = sku;
    if (passesFilterRaw === '0') filter.passesFilter = false;
    else if (passesFilterRaw === '1') filter.passesFilter = true;
    if (skipReason) filter.skipReason = skipReason;
    if (source) filter.source = source;
    if (sellerId) filter.sellerId = sellerId;
    else if (sellerSlug) filter.sellerSlug = sellerSlug;
    if (startTime) filter.startTime = startTime;
    if (endTime) filter.endTime = endTime;

    const { items, total } = await daos.shallowCollectLogDao.findPagedList(filter, currentPage, pageSize);
    return res.json(ok({ items, total, current: currentPage, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[shallow-collect] logs list failed');
    next(e);
  }
});

// GET /admin/api/shallow-collect/logs/:sku — 单 SKU 浅度采集历史
router.get('/admin/api/shallow-collect/logs/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const items = await daos.shallowCollectLogDao.findBySku(sku);
    return res.json(ok({ items }));
  } catch (e) {
    logger.warn({ err: e.message }, '[shallow-collect] logs by sku failed');
    next(e);
  }
});

// POST /admin/api/shallow-collect/log — 写入一条浅度采集日志(SW 调用,JWT 鉴权)
// body: { sku, sellerSlug, sellerId, name, price, ratingCount, imageUrl,
//         passesFilter, skipReason, source, collectedAt }
router.post('/admin/api/shallow-collect/log', async (req, res, next) => {
  try {
    const body = req.body || {};
    const sku = String(body.sku || '').trim();
    if (!sku) return res.status(422).json({ error: 'missing sku' });

    const doc = {
      sku,
      sellerSlug: body.sellerSlug != null ? String(body.sellerSlug) : null,
      sellerId: body.sellerId != null ? String(body.sellerId) : null,
      name: body.name != null ? String(body.name) : null,
      price: body.price != null ? Number(body.price) : null,
      ratingCount: body.ratingCount != null ? Number(body.ratingCount) : null,
      imageUrl: body.imageUrl != null ? String(body.imageUrl) : null,
      passesFilter: !!body.passesFilter,
      skipReason: body.skipReason != null ? String(body.skipReason) : null,
      source: body.source != null ? String(body.source) : null,
      collectedAt: body.collectedAt ? new Date(body.collectedAt) : new Date(),
    };

    const r = await daos.shallowCollectLogDao.insert(doc);
    return res.json(ok({ insertedId: r.insertedId }));
  } catch (e) {
    logger.warn({ err: e.message }, '[shallow-collect] log insert failed');
    next(e);
  }
});

// ── 店铺分类(/admin/api/store-classification) ───────────────────
// ozon_store_classification 集合的 CRUD 端点
// 鉴权:全局 JWT;不走 storeGuard(全局共享)
// 2026-07:主键改为 sellerId(稳定),_id = sellerId;sellerSlug 作为普通字段 + 索引(反查用)

// GET /admin/api/store-classification/:sellerId — 查询单条分类记录
// 优先按 sellerId 查(主键);若查不到且标识符不像数字 ID,尝试 slug 反查(兼容历史数据)
router.get('/admin/api/store-classification/:sellerId', async (req, res, next) => {
  try {
    const sellerId = String(req.params.sellerId);
    let doc = await daos.storeClassificationDao.getBySellerId(sellerId);
    // 兼容:sellerId 查不到时,尝试按 slug 反查(仅当 slug 形式)
    if (!doc) doc = await daos.storeClassificationDao.getBySlug(sellerId);
    if (!doc) return res.status(404).json({ error: 'not found' });
    return res.json(
      ok({
        _id: doc._id || doc.sellerId || '',
        sellerSlug: doc.sellerSlug || '',
        sellerId: doc.sellerId || doc._id || '',
        sellerName: doc.sellerName || '',
        isMainlandChina: doc.isMainlandChina === true,
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

// POST /admin/api/store-classification/:sellerId — upsert 分类记录
// body: { sellerSlug?, sellerName, isMainlandChina, classifiedBy, companyInfo, lastSeenAt, lastSeenUrl }
// sellerId 从 path 取(主键);sellerSlug 可选(店铺改名时变化)
router.post('/admin/api/store-classification/:sellerId', async (req, res, next) => {
  try {
    const sellerId = String(req.params.sellerId);
    const body = req.body || {};
    if (!sellerId) return res.status(400).json({ error: 'missing sellerId' });

    const now = new Date();
    const lastSeenAt = body.lastSeenAt ? new Date(body.lastSeenAt) : now;

    const update = {
      sellerName: body.sellerName != null ? String(body.sellerName) : '',
      isMainlandChina: body.isMainlandChina === true,
      classifiedBy: body.classifiedBy != null ? String(body.classifiedBy) : '',
      classifiedAt: body.classifiedAt ? new Date(body.classifiedAt) : now,
      companyInfo: body.companyInfo != null ? body.companyInfo : null,
      lastSeenAt,
      lastSeenUrl: body.lastSeenUrl != null ? String(body.lastSeenUrl) : '',
    };
    // sellerSlug 可选(店铺改名时变化,允许通过 body 更新)
    if (body.sellerSlug != null && String(body.sellerSlug) !== '') {
      update.sellerSlug = String(body.sellerSlug);
    }

    await daos.storeClassificationDao.upsertBySellerId(sellerId, update);
    return res.json(ok({ upserted: true, sellerId }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-classification] upsert failed');
    next(e);
  }
});

// DELETE /admin/api/store-classification/:sellerId — 删除单条
router.delete('/admin/api/store-classification/:sellerId', async (req, res, next) => {
  try {
    const sellerId = String(req.params.sellerId);
    const r = await daos.storeClassificationDao.deleteBySellerId(sellerId);
    return res.json(ok({ deletedCount: r.deletedCount }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-classification] delete failed');
    next(e);
  }
});

// GET /admin/api/store-classification — 列表查询(分页 + 过滤 + 排序)
// query: isMainlandChina(true/false/null 不传则不过滤)/keyword(匹配 sellerName/sellerSlug/sellerId)
//       currentPage/pageSize/sortBy('skuCount' → 按采集 SKU 数降序,默认按 lastSeenAt DESC)
// 返回 items 每条附加 skuCount(该店铺采集到的 SKU 数,来自 ozon_store_sku 按 sellerId 聚合)
router.get('/admin/api/store-classification', async (req, res, next) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const currentPage = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
    const sortBy = String(req.query.sortBy || '').trim();

    const filter = {};
    // isMainlandChina: 'true' → true, 'false' → false, 其他(包括不传/null) → 不过滤
    if (req.query.isMainlandChina === 'true') filter.isMainlandChina = true;
    else if (req.query.isMainlandChina === 'false') filter.isMainlandChina = false;
    if (keyword) filter.keyword = keyword;

    const { items, total } = await daos.storeClassificationDao.findPagedList(filter, currentPage, pageSize, sortBy);

    // sortBy=skuCount 时 DAO 已通过 LEFT JOIN 注入 skuCount,无需再批量查询
    if (sortBy !== 'skuCount' && Array.isArray(items) && items.length > 0) {
      const sellerIds = items.map((it) => it.sellerId || it._id).filter(Boolean);
      const countMap = await daos.storeSkuDao.countBySellerIds(sellerIds);
      for (const it of items) {
        it.skuCount = countMap[it.sellerId || it._id] || 0;
      }
    }

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

// GET /admin/api/store-sku/by-seller/:sellerId — 按卖家 ID 查询所有 SKU 并 join dom 缓存的 card 部分
// 返回 { items: [{ sku, sellerId, sellerSlug, sellerName, card: { name, price, image, ratingCount } }] }
// 供深度采集管理页面使用:一次请求拿到店铺全部 SKU + 商品卡信息(图片/评论数/价格)
// 2026-07:改用 sellerId(稳定主键,走 idx_ss_seller_seen 索引)
router.get('/admin/api/store-sku/by-seller/:sellerId', async (req, res, next) => {
  try {
    const sellerId = String(req.params.sellerId || '');
    if (!sellerId) return res.status(400).json({ error: 'missing sellerId' });

    // 查该店铺所有 SKU 关联记录(走 idx_ss_seller_seen 索引)
    const skuDocs = await daos.storeSkuDao.findBySellerId(sellerId);
    if (!skuDocs.length) return res.json(ok({ items: [], total: 0 }));

    // 批量查 dom 缓存(取 card 部分)
    const skus = skuDocs.map((d) => d.sku || d._id);
    const domDocs = await daos.domDao.findManyBySkuList(skus);
    const cardMap = new Map(domDocs.map((d) => [d.sku || d._id, d.card || null]));

    const items = skuDocs.map((d) => ({
      sku: d.sku || d._id,
      sellerId: d.sellerId || '',
      sellerSlug: d.sellerSlug || '',
      sellerName: d.sellerName || '',
      card: cardMap.get(d.sku || d._id) || null,
    }));

    return res.json(ok({ items, total: items.length }));
  } catch (e) {
    logger.warn({ err: e.message }, '[store-sku] by-seller failed');
    next(e);
  }
});

// GET /admin/api/store-sku/by-store/:slug — 兼容旧路径(按 slug 查询 SKU)
// 推荐使用 /by-seller/:sellerId;此路由仅作过渡期兼容
router.get('/admin/api/store-sku/by-store/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '');
    if (!slug) return res.status(400).json({ error: 'missing slug' });

    const skuDocs = await daos.storeSkuDao.findBySellerSlug(slug);
    if (!skuDocs.length) return res.json(ok({ items: [], total: 0 }));

    const skus = skuDocs.map((d) => d.sku || d._id);
    const domDocs = await daos.domDao.findManyBySkuList(skus);
    const cardMap = new Map(domDocs.map((d) => [d.sku || d._id, d.card || null]));

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
