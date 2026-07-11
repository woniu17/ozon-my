// Ozon search/bundle/pdp 缓存路由(MongoDB 持久存储,按 sku 全局共享)
// - search:无 TTL(永久),forceRefresh 主动删除
// - bundle:无 TTL(永久),空属性 6h 重验,forceRefresh 主动删除
// - pdp:无 TTL(永久),仅存 DOM 解析的静态字段(title/images/brand 等),DOM 解析失败时兜底
// 鉴权:JWT(authMiddleware),不走 storeGuard(缓存按 sku 全局共享,不区分店铺)
import { Router } from 'express';
import { cols } from '../db/mongo.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';

const router = Router();

const ATTRS_EMPTY_REVERIFY_MS = 6 * 60 * 60 * 1000; // 空属性 6h 重验

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

// ── 管理后台 API(/admin/api/cache/*) ───────────────────────
// 列表/统计/详情/清空,供前端缓存管理页面使用

// GET /admin/api/cache/stats — 缓存统计(各集合文档数 + 空属性数 + 总体积)
router.get('/admin/api/cache/stats', async (req, res, next) => {
  try {
    const [sCol, bCol, pCol] = await Promise.all([cols.searchCache(), cols.bundleCache(), cols.pdpCache()]);
    const [searchCount, bundleCount, bundleEmptyAttrs, bundleStale, pdpCount] = await Promise.all([
      sCol.estimatedDocumentCount(),
      bCol.estimatedDocumentCount(),
      bCol.countDocuments({ 'data.attributes': { $size: 0 } }),
      bCol.countDocuments({
        'data.attributes': { $size: 0 },
        attrsEmptyVerifiedAt: { $lt: new Date(Date.now() - ATTRS_EMPTY_REVERIFY_MS) },
      }),
      pCol.estimatedDocumentCount(),
    ]);
    return res.json(
      ok({
        search: { count: searchCount },
        bundle: { count: bundleCount, emptyAttrs: bundleEmptyAttrs, stale: bundleStale },
        pdp: { count: pdpCount },
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] stats failed');
    next(e);
  }
});

// GET /admin/api/cache/list — 缓存列表(支持 type/search/分页)
// query: type=search|bundle|pdp, keyword, page, pageSize
router.get('/admin/api/cache/list', async (req, res, next) => {
  try {
    const type = ['search', 'bundle', 'pdp'].includes(req.query.type) ? req.query.type : 'bundle';
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const col = await (type === 'search' ? cols.searchCache() : type === 'pdp' ? cols.pdpCache() : cols.bundleCache());
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
    const type = ['search', 'bundle', 'pdp'].includes(req.params.type) ? req.params.type : 'bundle';
    const sku = String(req.params.sku);
    const col = await (type === 'search' ? cols.searchCache() : type === 'pdp' ? cols.pdpCache() : cols.bundleCache());
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
    const type = ['search', 'bundle', 'pdp'].includes(req.params.type) ? req.params.type : 'bundle';
    const sku = String(req.params.sku);
    const col = await (type === 'search' ? cols.searchCache() : type === 'pdp' ? cols.pdpCache() : cols.bundleCache());
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
    const type = ['search', 'bundle', 'pdp'].includes(req.params.type) ? req.params.type : 'bundle';
    const col = await (type === 'search' ? cols.searchCache() : type === 'pdp' ? cols.pdpCache() : cols.bundleCache());
    const r = await col.deleteMany({});
    return res.json(ok({ deletedCount: r.deletedCount }));
  } catch (e) {
    logger.warn({ err: e.message }, '[cache] clear all failed');
    next(e);
  }
});

export default router;
