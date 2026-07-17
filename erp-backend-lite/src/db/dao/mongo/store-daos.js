// 店铺分类 + 店铺 SKU DAO(MongoDB 实现)
import { cols } from '../../mongo.js';

export const storeClassificationDao = {
  /** 按 slug 查询(_id = sellerSlug) */
  async getBySlug(slug) {
    const col = await cols.storeClassification();
    return col.findOne({ _id: slug });
  },

  /** upsert:sellerId 仅在非空时写入 $set,避免违反 partialFilterExpression 唯一索引 */
  async upsertBySlug(slug, update) {
    const col = await cols.storeClassification();
    const setDoc = { _id: slug, sellerSlug: slug };
    for (const [k, v] of Object.entries(update)) {
      // sellerId 为空字符串时不写入(避免违反 sparse unique index)
      if (k === 'sellerId' && !v) continue;
      setDoc[k] = v;
    }
    if (!setDoc.classifiedAt) setDoc.classifiedAt = new Date();
    if (!setDoc.lastSeenAt) setDoc.lastSeenAt = new Date();
    await col.updateOne({ _id: slug }, { $set: setDoc }, { upsert: true });
  },

  async deleteBySlug(slug) {
    const col = await cols.storeClassification();
    const r = await col.deleteOne({ _id: slug });
    return { deletedCount: r.deletedCount };
  },

  /** 分页列表:$or + $regex 三字段模糊 */
  async findPagedList(filter, page, pageSize) {
    const col = await cols.storeClassification();
    const query = {};
    if (filter.isChinese === true || filter.isChinese === false) {
      query.isChinese = filter.isChinese;
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

  /** 按 sellerSlug 查全量(无分页) */
  async findBySellerSlug(slug) {
    const col = await cols.storeSku();
    return col.find({ sellerSlug: slug }).sort({ lastSeenAt: -1 }).toArray();
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
