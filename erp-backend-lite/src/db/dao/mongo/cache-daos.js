// MongoDB DAO 实现:9 类缓存共用工厂生成,差异通过 options 配置
// 工厂参数:collection 名 + 可选的 extraColumns(如 bundle 的 bundleId/attrsEmptyVerifiedAt)
import { cols } from '../../mongo.js';

/**
 * 创建通用缓存 DAO(MongoDB 实现)
 * @param {string} colKey - cols 上的 key(如 'searchCache')
 * @param {string} colName - collection 名(仅用于日志,实际由 cols 返回)
 * @param {object} [opts]
 * @param {string[]} [opts.extraSetFields] - upsert 时额外的 $set 字段(如 ['bundleId'])
 * @param {boolean} [opts.hasL2Synced] - 是否含 l2Synced 字段(marketStats/followSell)
 */
export function createCacheDao(colKey, colName, opts = {}) {
  const { extraSetFields = [], hasL2Synced = false } = opts;

  return {
    /** 按 SKU 查询,返回 { data, fetchedAt, ...extra } 或 { data: null } */
    async getBySku(sku) {
      const col = await cols[colKey]();
      const doc = await col.findOne({ _id: sku });
      if (!doc || !doc.data) return { data: null };
      const result = { data: doc.data, fetchedAt: doc.fetchedAt };
      if (hasL2Synced) result.l2Synced = !!doc.l2Synced;
      for (const f of extraSetFields) {
        if (doc[f] !== undefined) result[f] = doc[f];
      }
      return result;
    },

    /** 全字段读取(无 projection,admin detail/opi-preview 用) */
    async findById(sku) {
      const col = await cols[colKey]();
      return col.findOne({ _id: sku });
    },

    /** upsert,extraFields 为额外字段(如 { bundleId, attrsEmptyVerifiedAt }) */
    async upsert(sku, data, extraFields = {}) {
      const col = await cols[colKey]();
      const setDoc = { sku, data, fetchedAt: new Date() };
      if (hasL2Synced) setDoc.l2Synced = true;
      for (const f of extraSetFields) {
        if (extraFields[f] !== undefined) setDoc[f] = extraFields[f];
      }
      // 允许传入非 extraSetFields 的额外字段(如 bundle 的 attrsEmptyVerifiedAt)
      for (const [k, v] of Object.entries(extraFields)) {
        if (setDoc[k] === undefined) setDoc[k] = v;
      }
      await col.updateOne({ _id: sku }, { $set: setDoc }, { upsert: true });
    },

    async deleteBySku(sku) {
      const col = await cols[colKey]();
      await col.deleteOne({ _id: sku });
    },

    /** 估算文档数(admin stats 用,等价 estimatedDocumentCount) */
    async estimatedCount() {
      const col = await cols[colKey]();
      return col.estimatedDocumentCount();
    },

    /** countDocuments(query) */
    async countByQuery(query = {}) {
      const col = await cols[colKey]();
      return col.countDocuments(query);
    },

    /**
     * 分页列表(用于单类型 list 路由)
     * @param {string} keyword - SKU 模糊搜索(空字符串则无过滤)
     * @param {number} page - 1-based
     * @param {number} pageSize
     * @param {object} [projection] - MongoDB projection
     */
    async findPagedList(keyword, page, pageSize, projection) {
      const col = await cols[colKey]();
      const query = keyword ? { sku: { $regex: keyword, $options: 'i' } } : {};
      const skip = (page - 1) * pageSize;
      const proj = projection || { _id: 1, sku: 1, fetchedAt: 1 };
      if (hasL2Synced) proj.l2Synced = 1;
      for (const f of extraSetFields) proj[f] = 1;
      const [items, total] = await Promise.all([
        col.find(query, { projection: proj }).sort({ fetchedAt: -1 }).skip(skip).limit(pageSize).toArray(),
        col.countDocuments(query),
      ]);
      return { items, total };
    },

    /** overview 路由用:全量加载(仅 projection 必要字段) */
    async findOverviewList(keyword, projection) {
      const col = await cols[colKey]();
      const query = keyword ? { sku: { $regex: keyword, $options: 'i' } } : {};
      const proj = projection || { _id: 1, sku: 1, fetchedAt: 1 };
      return col.find(query, { projection: proj }).toArray();
    },

    /** $in 批量查询(storeSku by-store 路由用) */
    async findManyBySkuList(skus, projection) {
      const col = await cols[colKey]();
      return col.find({ _id: { $in: skus } }, projection ? { projection } : undefined).toArray();
    },

    /** 清空集合 */
    async clearAll() {
      const col = await cols[colKey]();
      const r = await col.deleteMany({});
      return { deletedCount: r.deletedCount };
    },
  };
}
