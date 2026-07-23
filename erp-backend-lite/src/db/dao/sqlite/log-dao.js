// 采集日志 DAO(SQLite 实现):$facet 拆为 5 个独立 SELECT 并行执行
// 关键:json_each(results) 展开 results 数组替代 $unwind
import { db } from '../../index.js';

const LOG_TYPES = ['card', 'detail', 'pdp', 'search', 'bundle', 'marketStats', 'followSell'];
const LOG_SOURCES = ['shop-page', 'pdp'];
const LOG_STORE_CLASSES = ['mainland-china', 'non-mainland-china', 'unclassified'];
const LOG_STATUS_KEYS = ['success', 'partial', 'failed', 'skipped', 'antibot'];

export const autoCollectLogDao = {
  /**
   * 聚合统计:5 个独立 SELECT 并行执行(替代 $facet)
   * @param {object} filter - { collectedAtGte?: Date|string, collectedAtLte?: Date|string }
   */
  async aggregateStats(filter = {}) {
    const whereParts = [];
    const params = [];
    if (filter.collectedAtGte) {
      whereParts.push('collectedAt >= ?');
      params.push(new Date(filter.collectedAtGte).toISOString());
    }
    if (filter.collectedAtLte) {
      whereParts.push('collectedAt <= ?');
      params.push(new Date(filter.collectedAtLte).toISOString());
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const [statusRows, typeRows, sourceRows, storeClassRows, totalRow] = await Promise.all([
      Promise.resolve(
        db.prepare(
          `SELECT status AS _id, COUNT(*) AS count FROM ozon_auto_collect_log ${where} GROUP BY status`
        ).all(...params)
      ),
      Promise.resolve(
        db.prepare(
          `SELECT json_extract(r.value, '$.type') AS _id, COUNT(*) AS count
           FROM ozon_auto_collect_log, json_each(results) AS r
           ${where} GROUP BY json_extract(r.value, '$.type')`
        ).all(...params)
      ),
      Promise.resolve(
        db.prepare(
          `SELECT source AS _id, COUNT(*) AS count FROM ozon_auto_collect_log ${where} GROUP BY source`
        ).all(...params)
      ),
      Promise.resolve(
        db.prepare(
          `SELECT storeClassified AS _id, COUNT(*) AS count FROM ozon_auto_collect_log ${where} GROUP BY storeClassified`
        ).all(...params)
      ),
      Promise.resolve(
        db.prepare(`SELECT COUNT(*) AS count FROM ozon_auto_collect_log ${where}`).get(...params)
      ),
    ]);

    const statusCounts = Object.fromEntries(LOG_STATUS_KEYS.map((k) => [k, 0]));
    const typeCounts = Object.fromEntries(LOG_TYPES.map((k) => [k, 0]));
    const sourceCounts = Object.fromEntries(LOG_SOURCES.map((k) => [k, 0]));
    const storeClassCounts = Object.fromEntries(LOG_STORE_CLASSES.map((k) => [k, 0]));

    for (const r of statusRows) if (r._id) statusCounts[r._id] = r.count;
    for (const r of typeRows) if (r._id) typeCounts[r._id] = r.count;
    for (const r of sourceRows) if (r._id) sourceCounts[r._id] = r.count;
    for (const r of storeClassRows) if (r._id) storeClassCounts[r._id] = r.count;

    return {
      statusCounts,
      typeCounts,
      sourceCounts,
      storeClassCounts,
      total: totalRow.count,
    };
  },

  /** 分页列表 */
  async findPagedList(filter, page, pageSize) {
    const whereParts = [];
    const params = [];
    if (filter.sku) {
      whereParts.push('sku = ?');
      params.push(filter.sku);
    }
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        const placeholders = filter.status.map(() => '?').join(', ');
        whereParts.push(`status IN (${placeholders})`);
        params.push(...filter.status);
      } else {
        whereParts.push('status = ?');
        params.push(filter.status);
      }
    }
    if (filter.source) {
      whereParts.push('source = ?');
      params.push(filter.source);
    }
    if (filter.sellerSlug) {
      whereParts.push('sellerSlug = ?');
      params.push(filter.sellerSlug);
    }
    if (filter.sellerId) {
      whereParts.push('sellerId = ?');
      params.push(filter.sellerId);
    }
    if (filter.startTime) {
      whereParts.push('collectedAt >= ?');
      params.push(new Date(filter.startTime).toISOString());
    }
    if (filter.endTime) {
      whereParts.push('collectedAt <= ?');
      params.push(new Date(filter.endTime).toISOString());
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const skip = (page - 1) * pageSize;

    const items = db
      .prepare(
        `SELECT sku, source, sellerSlug, sellerId, storeClassified, depth, status, results, totalDuration, collectedAt
         FROM ozon_auto_collect_log ${where}
         ORDER BY collectedAt DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ozon_auto_collect_log ${where}`).get(...params).n;
    // results 字段反序列化
    const reshaped = items.map((r) => ({
      ...r,
      results: r.results ? JSON.parse(r.results) : [],
    }));
    return { items: reshaped, total };
  },

  /** 按 SKU 查全量历史 */
  async findBySku(sku) {
    const items = db
      .prepare(
        `SELECT sku, source, sellerSlug, sellerId, storeClassified, depth, status, results, totalDuration, collectedAt
         FROM ozon_auto_collect_log WHERE sku = ?
         ORDER BY collectedAt DESC`
      )
      .all(sku);
    return items.map((r) => ({
      ...r,
      results: r.results ? JSON.parse(r.results) : [],
    }));
  },

  /** 插入一条日志 */
  async insert(doc) {
    const now = (doc.collectedAt || new Date()).toISOString();
    const r = db
      .prepare(
        `INSERT INTO ozon_auto_collect_log
         (sku, source, sellerSlug, sellerId, storeClassified, depth, status, results, totalDuration, collectedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        doc.sku,
        doc.source ?? null,
        doc.sellerSlug ?? null,
        doc.sellerId ?? null,
        doc.storeClassified || 'unclassified',
        doc.depth ?? 0,
        doc.status,
        JSON.stringify(doc.results || []),
        doc.totalDuration ?? 0,
        now
      );
    return { insertedId: r.lastInsertRowid };
  },
};
