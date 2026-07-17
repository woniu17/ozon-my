// Bundle 缓存 DAO(SQLite 实现):扩展通用 DAO,新增空属性统计
// 关键:json_array_length(data, '$.attributes') 替代 $size:0
import { db } from '../../index.js';
import { createCacheDao } from './cache-daos.js';

const ATTRS_EMPTY_REVERIFY_MS = 6 * 60 * 60 * 1000; // 空属性 6h 重验

export const bundleDao = {
  ...createCacheDao('ozon_bundle_cache', {
    extraColumns: ['bundleId', 'attrsEmptyVerifiedAt'],
  }),

  /**
   * getBySku 重写:含空属性 6h 重验逻辑
   * 返回 { data, fetchedAt, bundleId, attrsEmptyVerifiedAt } 或 { data: null } 或 { data: null, stale: true }
   */
  async getBySku(sku) {
    const row = db.prepare(`SELECT * FROM ozon_bundle_cache WHERE _id = ?`).get(sku);
    if (!row || !row.data) return { data: null };

    const data = JSON.parse(row.data);
    const hasAttrs = Array.isArray(data?.attributes) && data.attributes.length > 0;
    if (!hasAttrs) {
      const verifiedAt = row.attrsEmptyVerifiedAt ? new Date(row.attrsEmptyVerifiedAt).getTime() : 0;
      if (!verifiedAt || Date.now() - verifiedAt >= ATTRS_EMPTY_REVERIFY_MS) {
        return { data: null, stale: true };
      }
    }
    return {
      data,
      fetchedAt: row.fetchedAt,
      bundleId: row.bundleId,
      attrsEmptyVerifiedAt: row.attrsEmptyVerifiedAt,
    };
  },

  /** upsert 重写:仅当 !hasAttrs(data) 时附加 attrsEmptyVerifiedAt */
  async upsert(sku, data, extraFields = {}) {
    const now = new Date().toISOString();
    const dataJson = JSON.stringify(data);
    const cols = ['_id', 'data', 'fetchedAt', 'bundleId'];
    const vals = [sku, dataJson, now, extraFields.bundleId ?? null];
    const hasAttrs = Array.isArray(data?.attributes) && data.attributes.length > 0;
    if (!hasAttrs) {
      cols.push('attrsEmptyVerifiedAt');
      vals.push(now);
    }
    const updateCols = cols.filter((c) => c !== '_id');
    const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    db.prepare(
      `INSERT INTO ozon_bundle_cache (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(_id) DO UPDATE SET ${setClause}`
    ).run(...vals);
  },

  /** 统计空属性文档数:json_array_length(data, '$.attributes') = 0 */
  async countEmptyAttrs() {
    return db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_bundle_cache WHERE json_array_length(data, '$.attributes') = 0`)
      .get().n;
  },

  /** 统计过期空属性文档数 */
  async countStaleEmptyAttrs() {
    const cutoff = new Date(Date.now() - ATTRS_EMPTY_REVERIFY_MS).toISOString();
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM ozon_bundle_cache
         WHERE json_array_length(data, '$.attributes') = 0
           AND (attrsEmptyVerifiedAt IS NULL OR attrsEmptyVerifiedAt < ?)`
      )
      .get(cutoff).n;
  },

  /** findPagedList 重写:含 bundle 专属字段 */
  async findPagedList(keyword, page, pageSize) {
    const skip = (page - 1) * pageSize;
    let where = '';
    const params = [];
    if (keyword) {
      where = 'WHERE _id LIKE ? COLLATE NOCASE';
      params.push(`%${keyword}%`);
    }
    const items = db
      .prepare(
        `SELECT _id, fetchedAt, attrsEmptyVerifiedAt, bundleId, data
         FROM ozon_bundle_cache ${where}
         ORDER BY fetchedAt DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ozon_bundle_cache ${where}`).get(...params).n;
    // 预计算 attrsEmpty / attrsStale,并解析 data.attributes
    const reshaped = items.map((r) => {
      const data = JSON.parse(r.data);
      const attrsEmpty = !Array.isArray(data?.attributes) || data.attributes.length === 0;
      const attrsStale =
        attrsEmpty &&
        (!r.attrsEmptyVerifiedAt ||
          Date.now() - new Date(r.attrsEmptyVerifiedAt).getTime() >= ATTRS_EMPTY_REVERIFY_MS);
      return {
        _id: r._id,
        sku: r._id,
        fetchedAt: r.fetchedAt,
        bundleId: r.bundleId,
        attrsEmptyVerifiedAt: r.attrsEmptyVerifiedAt,
        attrsEmpty,
        attrsStale,
        dataAttrs: data?.attributes,
      };
    });
    return { items: reshaped, total };
  },

  /** overview 用:含 bundle 专属字段 + data.attributes */
  async findOverviewList(keyword) {
    let where = '';
    const params = [];
    if (keyword) {
      where = 'WHERE _id LIKE ? COLLATE NOCASE';
      params.push(`%${keyword}%`);
    }
    const items = db
      .prepare(
        `SELECT _id, fetchedAt, attrsEmptyVerifiedAt, data
         FROM ozon_bundle_cache ${where}`
      )
      .all(...params);
    return items.map((r) => {
      const data = JSON.parse(r.data);
      const attrsEmpty = !Array.isArray(data?.attributes) || data.attributes.length === 0;
      const attrsStale =
        attrsEmpty &&
        (!r.attrsEmptyVerifiedAt ||
          Date.now() - new Date(r.attrsEmptyVerifiedAt).getTime() >= ATTRS_EMPTY_REVERIFY_MS);
      return {
        _id: r._id,
        sku: r._id,
        fetchedAt: r.fetchedAt,
        attrsEmptyVerifiedAt: r.attrsEmptyVerifiedAt,
        attrsEmpty,
        attrsStale,
        dataAttrs: data?.attributes,
      };
    });
  },
};
