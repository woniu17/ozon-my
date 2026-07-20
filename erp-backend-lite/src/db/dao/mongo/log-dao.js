// 采集日志 DAO(MongoDB 实现):含 aggregateLogStats 的 $facet+$unwind+$group
import { cols } from '../../mongo.js';

const LOG_TYPES = ['card', 'detail', 'pdp', 'search', 'bundle', 'marketStats', 'followSell'];
const LOG_SOURCES = ['shop-page', 'pdp'];
const LOG_STORE_CLASSES = ['chinese', 'non-chinese', 'unclassified'];
const LOG_STATUS_KEYS = ['success', 'partial', 'failed', 'skipped', 'antibot'];

export const autoCollectLogDao = {
  /**
   * 聚合统计:$facet 5 子管道一次查询
   * @param {object} [filter] - { collectedAtGte?: Date|string, collectedAtLte?: Date|string }
   * @returns {Promise<{statusCounts, typeCounts, sourceCounts, storeClassCounts, total}>}
   */
  async aggregateStats(filter = {}) {
    const col = await cols.autoCollectLog();
    const matchCond = {};
    if (filter.collectedAtGte) matchCond.collectedAt = { ...matchCond.collectedAt, $gte: new Date(filter.collectedAtGte) };
    if (filter.collectedAtLte) matchCond.collectedAt = { ...matchCond.collectedAt, $lte: new Date(filter.collectedAtLte) };
    const matchStage = { $match: matchCond };
    const [result] = await col.aggregate([
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
    ]);

    const statusCounts = Object.fromEntries(LOG_STATUS_KEYS.map((k) => [k, 0]));
    const typeCounts = Object.fromEntries(LOG_TYPES.map((k) => [k, 0]));
    const sourceCounts = Object.fromEntries(LOG_SOURCES.map((k) => [k, 0]));
    const storeClassCounts = Object.fromEntries(LOG_STORE_CLASSES.map((k) => [k, 0]));

    for (const r of result?.statusCounts || []) if (r._id) statusCounts[r._id] = r.count;
    for (const r of result?.typeCounts || []) if (r._id) typeCounts[r._id] = r.count;
    for (const r of result?.sourceCounts || []) if (r._id) sourceCounts[r._id] = r.count;
    for (const r of result?.storeClassCounts || []) if (r._id) storeClassCounts[r._id] = r.count;

    return {
      statusCounts,
      typeCounts,
      sourceCounts,
      storeClassCounts,
      total: result?.total?.[0]?.count || 0,
    };
  },

  /**
   * 分页列表
   * @param {object} filter - { sku?, status?(string|string[]), source?, sellerId?, sellerSlug?, startTime?, endTime? }
   */
  async findPagedList(filter, page, pageSize) {
    const col = await cols.autoCollectLog();
    const query = {};
    if (filter.sku) query.sku = filter.sku;
    if (filter.status) {
      query.status = Array.isArray(filter.status) ? { $in: filter.status } : filter.status;
    }
    if (filter.source) query.source = filter.source;
    // sellerId 优先(稳定主键),sellerSlug 兼容
    if (filter.sellerId) query.sellerId = filter.sellerId;
    else if (filter.sellerSlug) query.sellerSlug = filter.sellerSlug;
    if (filter.startTime || filter.endTime) {
      query.collectedAt = {};
      if (filter.startTime) query.collectedAt.$gte = new Date(filter.startTime);
      if (filter.endTime) query.collectedAt.$lte = new Date(filter.endTime);
    }
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      col.find(query, { projection: { _id: 0 } }).sort({ collectedAt: -1 }).skip(skip).limit(pageSize).toArray(),
      col.countDocuments(query),
    ]);
    return { items, total };
  },

  /** 按 SKU 查全量历史 */
  async findBySku(sku) {
    const col = await cols.autoCollectLog();
    return col.find({ sku }, { projection: { _id: 0 } }).sort({ collectedAt: -1 }).toArray();
  },

  /** 插入一条日志 */
  async insert(doc) {
    const col = await cols.autoCollectLog();
    const fullDoc = {
      sku: doc.sku,
      source: doc.source ?? null,
      sellerSlug: doc.sellerSlug ?? null,
      sellerId: doc.sellerId ?? null,
      storeClassified: doc.storeClassified || 'unclassified',
      depth: doc.depth ?? 0,
      status: doc.status,
      results: doc.results || [],
      totalDuration: doc.totalDuration ?? 0,
      collectedAt: doc.collectedAt || new Date(),
    };
    const r = await col.insertOne(fullDoc);
    return { insertedId: r.insertedId };
  },
};
