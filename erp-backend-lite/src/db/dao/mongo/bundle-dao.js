// Bundle 缓存 DAO(MongoDB 实现):扩展通用 DAO,新增空属性统计方法
import { cols } from '../../mongo.js';
import { createCacheDao } from './cache-daos.js';

const ATTRS_EMPTY_REVERIFY_MS = 6 * 60 * 60 * 1000; // 空属性 6h 重验

export const bundleDao = {
  ...createCacheDao('bundleCache', 'ozon_bundle_cache', {
    extraSetFields: ['bundleId'],
  }),

  /**
   * getBySku 重写:含空属性 6h 重验逻辑
   * 返回 { data, fetchedAt, bundleId, attrsEmptyVerifiedAt } 或 { data: null } 或 { data: null, stale: true }
   */
  async getBySku(sku) {
    const col = await cols.bundleCache();
    const doc = await col.findOne({ _id: sku });
    if (!doc || !doc.data) return { data: null };

    const hasAttrs = Array.isArray(doc.data?.attributes) && doc.data.attributes.length > 0;
    if (!hasAttrs) {
      const verifiedAt = doc.attrsEmptyVerifiedAt ? new Date(doc.attrsEmptyVerifiedAt).getTime() : 0;
      if (!verifiedAt || Date.now() - verifiedAt >= ATTRS_EMPTY_REVERIFY_MS) {
        return { data: null, stale: true };
      }
    }
    return {
      data: doc.data,
      fetchedAt: doc.fetchedAt,
      bundleId: doc.bundleId,
      attrsEmptyVerifiedAt: doc.attrsEmptyVerifiedAt,
    };
  },

  /**
   * upsert 重写:仅当 !hasAttrs(data) 时附加 attrsEmptyVerifiedAt
   */
  async upsert(sku, data, extraFields = {}) {
    const col = await cols.bundleCache();
    const setDoc = { sku, data, fetchedAt: new Date() };
    if (extraFields.bundleId !== undefined) setDoc.bundleId = extraFields.bundleId;
    const hasAttrs = Array.isArray(data?.attributes) && data.attributes.length > 0;
    if (!hasAttrs) setDoc.attrsEmptyVerifiedAt = new Date();
    await col.updateOne({ _id: sku }, { $set: setDoc }, { upsert: true });
  },

  /** 统计空属性文档数:$size:0 */
  async countEmptyAttrs() {
    const col = await cols.bundleCache();
    return col.countDocuments({ 'data.attributes': { $size: 0 } });
  },

  /** 统计过期空属性文档数:$size:0 + attrsEmptyVerifiedAt < cutoff */
  async countStaleEmptyAttrs() {
    const col = await cols.bundleCache();
    const cutoff = new Date(Date.now() - ATTRS_EMPTY_REVERIFY_MS);
    return col.countDocuments({
      'data.attributes': { $size: 0 },
      attrsEmptyVerifiedAt: { $lt: cutoff },
    });
  },

  /**
   * findPagedList 重写:含 bundle 专属 projection
   */
  async findPagedList(keyword, page, pageSize) {
    const col = await cols.bundleCache();
    const query = keyword ? { sku: { $regex: keyword, $options: 'i' } } : {};
    const skip = (page - 1) * pageSize;
    const projection = {
      _id: 1,
      sku: 1,
      fetchedAt: 1,
      attrsEmptyVerifiedAt: 1,
      bundleId: 1,
      'data.attributes': 1,
    };
    const [items, total] = await Promise.all([
      col.find(query, { projection }).sort({ fetchedAt: -1 }).skip(skip).limit(pageSize).toArray(),
      col.countDocuments(query),
    ]);
    return { items, total };
  },

  /** overview 用:含 bundle 专属 projection */
  async findOverviewList(keyword) {
    const col = await cols.bundleCache();
    const query = keyword ? { sku: { $regex: keyword, $options: 'i' } } : {};
    const projection = {
      _id: 1,
      sku: 1,
      fetchedAt: 1,
      attrsEmptyVerifiedAt: 1,
      'data.attributes': 1,
    };
    return col.find(query, { projection }).toArray();
  },
};
