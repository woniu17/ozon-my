// 店铺分类 + 店铺 SKU DAO(MongoDB 实现)
// 2026-07 重构:主键改为 sellerId(稳定),sellerSlug 作为普通字段 + 索引(反查用)
// 主查询入口 getBySellerId / findBySellerId 用 sellerId,_id = sellerId
// 注:Mongo 模式未实际启用,SQLite 是主路径;此实现仅供接口一致性
import { cols } from '../../mongo.js';

export const storeClassificationDao = {
  /** 按 sellerId 查询(新主键,_id = sellerId) */
  async getBySellerId(sellerId) {
    if (!sellerId) return null;
    const col = await cols.storeClassification();
    return col.findOne({ _id: String(sellerId) });
  },

  /** 按 sellerSlug 查询(兼容方法,走 idx_sc_slug 索引)
   *  用途:扩展端首次访问时 sellerId 可能未取到,只有 sellerSlug
   *  注意:sellerSlug 可变(店铺改名),此方法返回的记录可能滞后,生产环境优先用 getBySellerId
   */
  async getBySlug(slug) {
    if (!slug) return null;
    const col = await cols.storeClassification();
    return col.findOne({ sellerSlug: String(slug) });
  },

  /** upsert by sellerId(新主键)
   *  update 字段可含 sellerSlug / sellerName / isMainlandChina / classifiedBy / companyInfo / logoImageUrl / lastSeenUrl
   *  sellerId 必填(主键),sellerSlug 可选(店铺改名时变化)
   */
  async upsertBySellerId(sellerId, update) {
    if (!sellerId) throw new Error('upsertBySellerId: sellerId is required');
    const col = await cols.storeClassification();
    const id = String(sellerId);
    const setDoc = { _id: id, sellerId: id };
    for (const [k, v] of Object.entries(update || {})) {
      if (k === 'sellerId') continue; // 已作为主键
      setDoc[k] = v;
    }
    if (!setDoc.classifiedAt) setDoc.classifiedAt = new Date();
    if (!setDoc.lastSeenAt) setDoc.lastSeenAt = new Date();
    await col.updateOne({ _id: id }, { $set: setDoc }, { upsert: true });
  },

  /** upsert by slug(旧接口,兼容期保留)
   *  内部先按 slug 查找已有记录的 sellerId,有则用 upsertBySellerId 更新;
   *  无则用 slug 作为 _id 临时占位(等扩展端上报 sellerId 后再迁移)。
   *  注意:此方法不应在新代码中使用,仅供过渡期兼容。
   */
  async upsertBySlug(slug, update) {
    const col = await cols.storeClassification();
    const existing = await this.getBySlug(slug);
    const sellerId = (update && update.sellerId) || existing?.sellerId;
    if (sellerId) {
      const merged = { ...update };
      if (!merged.sellerSlug && existing?.sellerSlug) merged.sellerSlug = existing.sellerSlug;
      return this.upsertBySellerId(sellerId, merged);
    }
    // sellerId 仍为空:用 slug 作为 _id 占位(过渡期)
    const setDoc = { _id: String(slug), sellerSlug: String(slug) };
    for (const [k, v] of Object.entries(update || {})) {
      if (k === 'sellerId') continue;
      setDoc[k] = v;
    }
    if (!setDoc.classifiedAt) setDoc.classifiedAt = new Date();
    if (!setDoc.lastSeenAt) setDoc.lastSeenAt = new Date();
    await col.updateOne({ _id: String(slug) }, { $set: setDoc }, { upsert: true });
  },

  async deleteBySellerId(sellerId) {
    if (!sellerId) return { deletedCount: 0 };
    const col = await cols.storeClassification();
    const r = await col.deleteOne({ _id: String(sellerId) });
    return { deletedCount: r.deletedCount };
  },

  /** 删除 by slug(兼容方法,按 sellerSlug 字段删除) */
  async deleteBySlug(slug) {
    if (!slug) return { deletedCount: 0 };
    const col = await cols.storeClassification();
    const r = await col.deleteOne({ sellerSlug: String(slug) });
    return { deletedCount: r.deletedCount };
  },

  /** 分页列表:$or + $regex 三字段模糊(sellerId / sellerName / sellerSlug) */
  async findPagedList(filter, page, pageSize) {
    const col = await cols.storeClassification();
    const query = {};
    if (filter.isMainlandChina === true || filter.isMainlandChina === false) {
      query.isMainlandChina = filter.isMainlandChina;
    }
    if (filter.keyword) {
      const re = { $regex: filter.keyword, $options: 'i' };
      query.$or = [{ sellerName: re }, { sellerSlug: re }, { sellerId: re }];
    }
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      col.find(query, { projection: { _id: 0 } }).sort({ lastSeenAt: -1 }).skip(skip).limit(pageSize).toArray(),
      col.countDocuments(query),
    ]);
    return { items, total };
  },
};

export const storeSkuDao = {
  async getBySku(sku) {
    const col = await cols.storeSku();
    return col.findOne({ _id: sku });
  },

  /**
   * upsert:$set + $setOnInsert(firstSeenAt 仅首次写入)
   * @param {string} sku
   * @param {object} setFields - { sellerId, sellerSlug?, sellerName?, lastCollectAt?, ... }
   */
  async upsertBySku(sku, setFields) {
    const col = await cols.storeSku();
    const setDoc = { ...setFields };
    // sellerName 仅在非空时更新(避免 SW 上报 null 覆盖 panel 已写值)
    if (setDoc.sellerName === null || setDoc.sellerName === undefined || setDoc.sellerName === '') {
      delete setDoc.sellerName;
    }
    const now = new Date().toISOString();
    await col.updateOne(
      { _id: sku },
      { $set: { ...setDoc, lastSeenAt: now }, $setOnInsert: { firstSeenAt: now } },
      { upsert: true }
    );
  },

  async deleteBySku(sku) {
    const col = await cols.storeSku();
    const r = await col.deleteOne({ _id: sku });
    return { deletedCount: r.deletedCount };
  },

  /** 按 sellerId 查全量(走 sellerId 索引,稳定主键) */
  async findBySellerId(sellerId) {
    if (!sellerId) return [];
    const col = await cols.storeSku();
    return col.find({ sellerId: String(sellerId) }).sort({ lastSeenAt: -1 }).toArray();
  },

  /** 批量统计每个 sellerId 的 SKU 数
   *  @param {string[]} sellerIds
   *  @returns {Object<string, number>} { sellerId: count }
   */
  async countBySellerIds(sellerIds) {
    if (!Array.isArray(sellerIds) || sellerIds.length === 0) return {};
    const col = await cols.storeSku();
    const rows = await col
      .aggregate([
        { $match: { sellerId: { $in: sellerIds.map(String) } } },
        { $group: { _id: '$sellerId', n: { $sum: 1 } } },
      ])
      .toArray();
    const map = {};
    for (const r of rows) map[r._id] = r.n;
    return map;
  },

  /** 按 sellerSlug 查全量(兼容方法,可变字段)
   *  仅用于扩展端首次访问时 sellerId 未取到的场景
   */
  async findBySellerSlug(slug) {
    if (!slug) return [];
    const col = await cols.storeSku();
    return col.find({ sellerSlug: String(slug) }).sort({ lastSeenAt: -1 }).toArray();
  },

  /** 分页列表:$or + $regex 四字段模糊(含 _id 即 SKU) */
  async findPagedList(keyword, page, pageSize) {
    const col = await cols.storeSku();
    const query = {};
    if (keyword) {
      const re = { $regex: keyword, $options: 'i' };
      query.$or = [{ _id: re }, { sellerSlug: re }, { sellerName: re }, { sellerId: re }];
    }
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      col.find(query).sort({ lastSeenAt: -1 }).skip(skip).limit(pageSize).toArray(),
      col.countDocuments(query),
    ]);
    // 后置补 sku = _id
    for (const it of items) it.sku = it._id;
    return { items, total };
  },
};
