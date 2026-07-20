// 浅度采集日志 DAO(SQLite 实现)
// 与 autoCollectLogDao 的区别:
//   autoCollectLogDao(深度):记录 SW 实际执行采集流程后的结果(success/partial/failed/...+ results 数组)
//   shallowCollectLogDao(浅度):记录店铺页扫描发现的每个 SKU + 是否通过过滤(无 results,无 status)
// 用途:排查过滤效果(略过原因分布)+ 浅度采集统计
import { db } from '../../index.js';

const SHALLOW_SOURCES = ['api-scroller', 'dom-scroller', 'shop-page', 'pdp'];
const SHALLOW_SKIP_REASONS = [
  'no-rating',
  'price-below-min',
  'price-above-max',
  'price-invalid',
  'rating-below-min',
  'rating-above-max',
];

export const shallowCollectLogDao = {
  /**
   * 聚合统计:总扫描数 / 通过数 / 略过数 + 按 skipReason 分布 + 按 source 分布
   * @param {object} filter - { collectedAtGte?, collectedAtLte?, sellerId?, sellerSlug? }
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
    // sellerId 优先(稳定主键),sellerSlug 兼容
    if (filter.sellerId) {
      whereParts.push('sellerId = ?');
      params.push(filter.sellerId);
    } else if (filter.sellerSlug) {
      whereParts.push('sellerSlug = ?');
      params.push(filter.sellerSlug);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const [totalRow, passRow, skipReasonRows, sourceRows, sellerRows] = await Promise.all([
      Promise.resolve(
        db.prepare(`SELECT COUNT(*) AS count FROM ozon_shallow_collect_log ${where}`).get(...params)
      ),
      Promise.resolve(
        db
          .prepare(
            `SELECT passesFilter, COUNT(*) AS count FROM ozon_shallow_collect_log ${where} GROUP BY passesFilter`
          )
          .all(...params)
      ),
      Promise.resolve(
        db
          .prepare(
            `SELECT skipReason AS _id, COUNT(*) AS count FROM ozon_shallow_collect_log ${where} GROUP BY skipReason`
          )
          .all(...params)
      ),
      Promise.resolve(
        db
          .prepare(
            `SELECT source AS _id, COUNT(*) AS count FROM ozon_shallow_collect_log ${where} GROUP BY source`
          )
          .all(...params)
      ),
      Promise.resolve(
        db
          .prepare(
            `SELECT sellerId AS _id, MAX(sellerSlug) AS sellerSlug, COUNT(*) AS count
             FROM ozon_shallow_collect_log ${where}
             GROUP BY sellerId ORDER BY count DESC LIMIT 20`
          )
          .all(...params)
      ),
    ]);

    let passed = 0;
    let skipped = 0;
    for (const r of passRow) {
      if (r.passesFilter === 1) passed = r.count;
      else skipped = r.count;
    }

    const skipReasonCounts = Object.fromEntries(SHALLOW_SKIP_REASONS.map((k) => [k, 0]));
    let skipReasonNull = 0;
    for (const r of skipReasonRows) {
      if (r._id && skipReasonCounts[r._id] != null) skipReasonCounts[r._id] = r.count;
      else if (r._id == null) skipReasonNull = r.count;
    }

    const sourceCounts = Object.fromEntries(SHALLOW_SOURCES.map((k) => [k, 0]));
    for (const r of sourceRows) if (r._id && sourceCounts[r._id] != null) sourceCounts[r._id] = r.count;

    return {
      total: totalRow.count,
      passed,
      skipped,
      skipReasonCounts,
      skipReasonNull,
      sourceCounts,
      topSellers: sellerRows.map((r) => ({
        sellerId: r._id || '',
        sellerSlug: r.sellerSlug || '',
        count: r.count,
      })),
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
    if (filter.passesFilter != null) {
      whereParts.push('passesFilter = ?');
      params.push(filter.passesFilter ? 1 : 0);
    }
    if (filter.skipReason) {
      whereParts.push('skipReason = ?');
      params.push(filter.skipReason);
    }
    if (filter.source) {
      whereParts.push('source = ?');
      params.push(filter.source);
    }
    // sellerId 优先(稳定主键),sellerSlug 兼容
    if (filter.sellerId) {
      whereParts.push('sellerId = ?');
      params.push(filter.sellerId);
    } else if (filter.sellerSlug) {
      whereParts.push('sellerSlug = ?');
      params.push(filter.sellerSlug);
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
        `SELECT sku, sellerSlug, sellerId, name, price, ratingCount, imageUrl,
                passesFilter, skipReason, source, collectedAt
         FROM ozon_shallow_collect_log ${where}
         ORDER BY collectedAt DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_shallow_collect_log ${where}`)
      .get(...params).n;
    // passesFilter 转 boolean 便于前端消费
    const reshaped = items.map((r) => ({
      ...r,
      passesFilter: !!r.passesFilter,
    }));
    return { items: reshaped, total };
  },

  /** 按 SKU 查全量历史 */
  async findBySku(sku) {
    const items = db
      .prepare(
        `SELECT sku, sellerSlug, sellerId, name, price, ratingCount, imageUrl,
                passesFilter, skipReason, source, collectedAt
         FROM ozon_shallow_collect_log WHERE sku = ?
         ORDER BY collectedAt DESC`
      )
      .all(sku);
    return items.map((r) => ({ ...r, passesFilter: !!r.passesFilter }));
  },

  /** 插入一条日志 */
  async insert(doc) {
    const now = (doc.collectedAt || new Date()).toISOString();
    const r = db
      .prepare(
        `INSERT INTO ozon_shallow_collect_log
         (sku, sellerSlug, sellerId, name, price, ratingCount, imageUrl,
          passesFilter, skipReason, source, collectedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(doc.sku),
        doc.sellerSlug ?? null,
        doc.sellerId ?? null,
        doc.name ?? null,
        doc.price != null ? Number(doc.price) : null,
        doc.ratingCount != null ? Number(doc.ratingCount) : null,
        doc.imageUrl ?? null,
        doc.passesFilter ? 1 : 0,
        doc.skipReason ?? null,
        doc.source ?? null,
        now
      );
    return { insertedId: r.lastInsertRowid };
  },
};
