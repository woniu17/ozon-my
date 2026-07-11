// Ozon search/bundle/pdp/composer/entrypoint/dynamic 缓存路由(MongoDB 持久存储,按 sku 全局共享)
// - search:无 TTL(永久),forceRefresh 主动删除
// - bundle:无 TTL(永久),空属性 6h 重验,forceRefresh 主动删除
// - pdp:无 TTL(永久),仅存 DOM 解析的静态字段(title/images/brand 等),DOM 解析失败时兜底
// - composer:无 TTL(永久),存 composer-api 返回的 19 个业务 widgetStates,缓存优先
// - entrypoint:无 TTL(永久),存 entrypoint-api 返回的 page-json(图册/富内容/描述/标签),缓存优先
// - dynamic:1h TTL,存 DOM 动态字段(price/seller/statistics 等),DOM 解析失败时兜底
// 鉴权:JWT(authMiddleware),不走 storeGuard(缓存按 sku 全局共享,不区分店铺)
import { Router } from 'express';
import { cols } from '../db/mongo.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';

const router = Router();

const ATTRS_EMPTY_REVERIFY_MS = 6 * 60 * 60 * 1000; // 空属性 6h 重验
const DYNAMIC_TTL_MS = 60 * 60 * 1000; // 动态数据 1h TTL

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
    await col.updateOne(
      { _id: sku },
      { $set: { sku, data, fetchedAt: new Date() } },
      { upsert: true }
    );
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

// ── pdp 缓存(DOM 解析静态字段兜底) ─────────────────────────

// GET /ozon/cache/pdp/:sku
router.get('/ozon/cache/pdp/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.pdpCache();
    const doc = await col.findOne({ _id: sku });
    if (doc && doc.data) {
      return res.json({ data: doc.data, fetchedAt: doc.fetchedAt });
    }
    return res.json({ data: null });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] pdp get failed');
    next(e);
  }
});

// POST /ozon/cache/pdp/:sku  body: { data }
router.post('/ozon/cache/pdp/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const col = await cols.pdpCache();
    await col.updateOne(
      { _id: sku },
      { $set: { sku, data, fetchedAt: new Date() } },
      { upsert: true }
    );
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] pdp set failed');
    next(e);
  }
});

// DELETE /ozon/cache/pdp/:sku
router.delete('/ozon/cache/pdp/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.pdpCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] pdp delete failed');
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
    await col.updateOne(
      { _id: sku },
      { $set: { sku, data, fetchedAt: new Date() } },
      { upsert: true }
    );
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
    await col.updateOne(
      { _id: sku },
      { $set: { sku, data, fetchedAt: new Date() } },
      { upsert: true }
    );
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

// ── dynamic 缓存(DOM 动态字段,1h TTL,失败兜底) ─────────────────────────

// GET /ozon/cache/dynamic/:sku
router.get('/ozon/cache/dynamic/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.dynamicCache();
    const doc = await col.findOne({ _id: sku });
    // 1h TTL 检查:超时返回 null(让调用方走 L3 真调)
    if (doc && doc.data && doc.fetchedAt) {
      const age = Date.now() - new Date(doc.fetchedAt).getTime();
      if (age < DYNAMIC_TTL_MS) {
        return res.json({ data: doc.data, fetchedAt: doc.fetchedAt });
      }
    }
    return res.json({ data: null });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] dynamic get failed');
    next(e);
  }
});

// POST /ozon/cache/dynamic/:sku  body: { data }
router.post('/ozon/cache/dynamic/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const data = req.body?.data;
    if (!data) return res.status(422).json({ error: 'missing data' });
    const col = await cols.dynamicCache();
    await col.updateOne(
      { _id: sku },
      { $set: { sku, data, fetchedAt: new Date() } },
      { upsert: true }
    );
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] dynamic set failed');
    next(e);
  }
});

// DELETE /ozon/cache/dynamic/:sku
router.delete('/ozon/cache/dynamic/:sku', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const col = await cols.dynamicCache();
    await col.deleteOne({ _id: sku });
    return res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] dynamic delete failed');
    next(e);
  }
});

// ── 管理后台 API(/admin/api/cache/*) ───────────────────────
// 列表/统计/详情/清空,供前端缓存管理页面使用

// GET /admin/api/cache/stats — 缓存统计(各集合文档数 + 空属性数 + 总体积)
router.get('/admin/api/cache/stats', async (req, res, next) => {
  try {
    const [sCol, bCol, pCol, cCol, eCol, dCol] = await Promise.all([
      cols.searchCache(),
      cols.bundleCache(),
      cols.pdpCache(),
      cols.composerCache(),
      cols.entrypointCache(),
      cols.dynamicCache(),
    ]);
    const [searchCount, bundleCount, bundleEmptyAttrs, bundleStale, pdpCount, composerCount, entrypointCount, dynamicCount] =
      await Promise.all([
        sCol.estimatedDocumentCount(),
        bCol.estimatedDocumentCount(),
        bCol.countDocuments({ 'data.attributes': { $size: 0 } }),
        bCol.countDocuments({
          'data.attributes': { $size: 0 },
          attrsEmptyVerifiedAt: { $lt: new Date(Date.now() - ATTRS_EMPTY_REVERIFY_MS) },
        }),
        pCol.estimatedDocumentCount(),
        cCol.estimatedDocumentCount(),
        eCol.estimatedDocumentCount(),
        dCol.estimatedDocumentCount(),
      ]);
    return res.json(
      ok({
        search: { count: searchCount },
        bundle: { count: bundleCount, emptyAttrs: bundleEmptyAttrs, stale: bundleStale },
        pdp: { count: pdpCount },
        composer: { count: composerCount },
        entrypoint: { count: entrypointCount },
        dynamic: { count: dynamicCount },
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] stats failed');
    next(e);
  }
});

// 类型 → 集合 映射(管理接口统一入口)
const CACHE_TYPES = ['search', 'bundle', 'pdp', 'composer', 'entrypoint', 'dynamic'];
const getColByType = (type) => {
  switch (type) {
    case 'search':
      return cols.searchCache();
    case 'bundle':
      return cols.bundleCache();
    case 'pdp':
      return cols.pdpCache();
    case 'composer':
      return cols.composerCache();
    case 'entrypoint':
      return cols.entrypointCache();
    case 'dynamic':
      return cols.dynamicCache();
    default:
      return cols.bundleCache();
  }
};

// GET /admin/api/cache/list — 缓存列表(支持 type/search/分页)
// query: type=search|bundle|pdp|composer|dynamic, keyword, page, pageSize
router.get('/admin/api/cache/list', async (req, res, next) => {
  try {
    const type = CACHE_TYPES.includes(req.query.type) ? req.query.type : 'bundle';
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const col = await getColByType(type);
    const query = keyword ? { sku: { $regex: keyword, $options: 'i' } } : {};
    const [total, docs] = await Promise.all([
      col.countDocuments(query),
      col
        .find(query, {
          projection: { _id: 1, sku: 1, fetchedAt: 1, attrsEmptyVerifiedAt: 1, bundleId: 1, 'data.attributes': 1 },
        })
        .sort({ fetchedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
    ]);

    const items = docs.map((d) => {
      // bundle 类型才需要预计算空属性 + 待重验状态
      if (type !== 'bundle') {
        return {
          sku: d.sku || d._id,
          fetchedAt: d.fetchedAt,
        };
      }
      const attrsEmpty = !hasAttrs(d.data);
      let attrsStale = false;
      if (attrsEmpty) {
        const verifiedAt = d.attrsEmptyVerifiedAt ? new Date(d.attrsEmptyVerifiedAt).getTime() : 0;
        attrsStale = !verifiedAt || Date.now() - verifiedAt >= ATTRS_EMPTY_REVERIFY_MS;
      }
      return {
        sku: d.sku || d._id,
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
    const type = CACHE_TYPES.includes(req.params.type) ? req.params.type : 'bundle';
    const sku = String(req.params.sku);
    const col = await getColByType(type);
    const doc = await col.findOne({ _id: sku });
    if (!doc) return res.json(ok(null));
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

export default router;
