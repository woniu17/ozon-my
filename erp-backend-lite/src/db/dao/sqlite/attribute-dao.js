// Attribute 缓存 DAO(SQLite):search + bundle 合并表,字段独立,各自保留
// 写入:upsertSearch / upsertBundle 各自只更新对应字段
// 读取:bundleData 优先(含物理 attrs),searchData 兜底
// 索引表同步:每次 upsert 后调用 indexDao.syncSku(sku)
// 空属性 6h 重验:沿袭自 bundleDao,仅对 bundle_data 为空属性时记录 attrs_empty_verified_at
import { db } from '../../index.js';
import { indexDao } from './index-dao.js';

const ATTRS_EMPTY_REVERIFY_MS = 6 * 60 * 60 * 1000;

function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const attributeDao = {
  /** 按 SKU 查询:返回 { searchData, bundleData, searchFetchedAt, bundleFetchedAt, bundleId, attrsEmptyVerifiedAt } */
  async getBySku(sku) {
    const row = db
      .prepare(
        `SELECT search_data, search_fetched_at, bundle_data, bundle_fetched_at,
                bundle_id, attrs_empty_verified_at
         FROM ozon_attribute_cache WHERE _id = ?`
      )
      .get(sku);

    if (!row) {
      return {
        searchData: null,
        bundleData: null,
        searchFetchedAt: null,
        bundleFetchedAt: null,
        bundleId: null,
        attrsEmptyVerifiedAt: null,
      };
    }

    const bundleData = parseJson(row.bundle_data);
    const hasAttrs = Array.isArray(bundleData?.attributes) && bundleData.attributes.length > 0;
    // 空属性 6h 重验:返回 stale=true 让调用方重新采集
    let bundleStale = false;
    if (bundleData && !hasAttrs) {
      const verifiedAt = row.attrs_empty_verified_at
        ? new Date(row.attrs_empty_verified_at).getTime()
        : 0;
      if (!verifiedAt || Date.now() - verifiedAt >= ATTRS_EMPTY_REVERIFY_MS) {
        bundleStale = true;
      }
    }

    return {
      searchData: parseJson(row.search_data),
      bundleData: bundleStale ? null : bundleData,
      searchFetchedAt: row.search_fetched_at,
      bundleFetchedAt: row.bundle_fetched_at,
      bundleId: row.bundle_id,
      attrsEmptyVerifiedAt: row.attrs_empty_verified_at,
      // 兼容字段(供老代码读 .data / .stale):
      data: bundleStale ? null : bundleData,
      stale: bundleStale,
      fetchedAt: row.bundle_fetched_at || row.search_fetched_at,
    };
  },

  /** 全字段读取(buildSynthesizedFromCache 用) */
  async findById(sku) {
    const row = db
      .prepare(
        `SELECT _id, search_data, search_fetched_at, bundle_data, bundle_fetched_at,
                bundle_id, attrs_empty_verified_at
         FROM ozon_attribute_cache WHERE _id = ?`
      )
      .get(sku);
    if (!row) return null;
    return {
      _id: row._id,
      sku: row._id,
      searchData: parseJson(row.search_data),
      searchFetchedAt: row.search_fetched_at,
      bundleData: parseJson(row.bundle_data),
      bundleFetchedAt: row.bundle_fetched_at,
      bundleId: row.bundle_id,
      attrsEmptyVerifiedAt: row.attrs_empty_verified_at,
      // 兼容字段:
      data: parseJson(row.bundle_data),
      fetchedAt: row.bundle_fetched_at || row.search_fetched_at,
    };
  },

  /** 只写 search 部分(不影响 bundle) */
  async upsertSearch(sku, searchData) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ozon_attribute_cache (_id, search_data, search_fetched_at, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(_id) DO UPDATE SET
         search_data = excluded.search_data,
         search_fetched_at = excluded.search_fetched_at,
         updated_at = datetime('now')`
    ).run(sku, JSON.stringify(searchData), now);
    indexDao.syncSku(sku).catch((e) => {
      console.warn(`[attributeDao] index sync failed for ${sku}:`, e?.message || e);
    });
  },

  /** 只写 bundle 部分(不影响 search) */
  async upsertBundle(sku, bundleData, extraFields = {}) {
    const now = new Date().toISOString();
    const hasAttrs = Array.isArray(bundleData?.attributes) && bundleData.attributes.length > 0;
    const cols = ['_id', 'bundle_data', 'bundle_fetched_at', 'bundle_id'];
    const vals = [sku, JSON.stringify(bundleData), now, extraFields.bundleId ?? null];
    if (!hasAttrs) {
      cols.push('attrs_empty_verified_at');
      vals.push(now);
    }
    const updateCols = cols.filter((c) => c !== '_id');
    const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    db.prepare(
      `INSERT INTO ozon_attribute_cache (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(_id) DO UPDATE SET ${setClause}, updated_at = datetime('now')`
    ).run(...vals);
    indexDao.syncSku(sku).catch((e) => {
      console.warn(`[attributeDao] index sync failed for ${sku}:`, e?.message || e);
    });
  },

  /** 兼容旧 API:upsert(sku, data, extraFields) 默认当 bundle 写入 */
  async upsert(sku, data, extraFields = {}) {
    return this.upsertBundle(sku, data, extraFields);
  },

  async deleteBySku(sku) {
    db.prepare(`DELETE FROM ozon_attribute_cache WHERE _id = ?`).run(sku);
    indexDao.deleteSku(sku).catch(() => {});
  },

  async estimatedCount() {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM ozon_attribute_cache
         WHERE search_data IS NOT NULL OR bundle_data IS NOT NULL`
      )
      .get().n;
  },

  /** 统计空属性文档数(bundle_data.attributes 为空) */
  async countEmptyAttrs() {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM ozon_attribute_cache
         WHERE json_array_length(bundle_data, '$.attributes') = 0`
      )
      .get().n;
  },

  /** 统计过期空属性文档数 */
  async countStaleEmptyAttrs() {
    const cutoff = new Date(Date.now() - ATTRS_EMPTY_REVERIFY_MS).toISOString();
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM ozon_attribute_cache
         WHERE json_array_length(bundle_data, '$.attributes') = 0
           AND (attrs_empty_verified_at IS NULL OR attrs_empty_verified_at < ?)`
      )
      .get(cutoff).n;
  },

  /** 分页列表(单类型 list 路由用) */
  async findPagedList(keyword, page, pageSize) {
    const skip = (page - 1) * pageSize;
    let where = 'WHERE search_data IS NOT NULL OR bundle_data IS NOT NULL';
    const params = [];
    if (keyword) {
      where += ' AND _id LIKE ? COLLATE NOCASE';
      params.push(`%${keyword}%`);
    }
    const items = db
      .prepare(
        `SELECT _id, search_fetched_at, bundle_fetched_at, bundle_id, attrs_empty_verified_at, bundle_data
         FROM ozon_attribute_cache ${where}
         ORDER BY COALESCE(bundle_fetched_at, search_fetched_at) DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_attribute_cache ${where}`)
      .get(...params).n;
    const reshaped = items.map((r) => {
      const bundleData = parseJson(r.bundle_data);
      const attrsEmpty = !Array.isArray(bundleData?.attributes) || bundleData.attributes.length === 0;
      const attrsStale =
        attrsEmpty &&
        (!r.attrs_empty_verified_at ||
          Date.now() - new Date(r.attrs_empty_verified_at).getTime() >= ATTRS_EMPTY_REVERIFY_MS);
      return {
        _id: r._id,
        sku: r._id,
        searchFetchedAt: r.search_fetched_at,
        bundleFetchedAt: r.bundle_fetched_at,
        bundleId: r.bundle_id,
        attrsEmptyVerifiedAt: r.attrs_empty_verified_at,
        attrsEmpty,
        attrsStale,
        dataAttrs: bundleData?.attributes,
      };
    });
    return { items: reshaped, total };
  },

  /** overview 用 */
  async findOverviewList(keyword) {
    let where = 'WHERE search_data IS NOT NULL OR bundle_data IS NOT NULL';
    const params = [];
    if (keyword) {
      where += ' AND _id LIKE ? COLLATE NOCASE';
      params.push(`%${keyword}%`);
    }
    const items = db
      .prepare(
        `SELECT _id, search_fetched_at, bundle_fetched_at, bundle_id, attrs_empty_verified_at, bundle_data
         FROM ozon_attribute_cache ${where}`
      )
      .all(...params);
    return items.map((r) => {
      const bundleData = parseJson(r.bundle_data);
      const attrsEmpty = !Array.isArray(bundleData?.attributes) || bundleData.attributes.length === 0;
      const attrsStale =
        attrsEmpty &&
        (!r.attrs_empty_verified_at ||
          Date.now() - new Date(r.attrs_empty_verified_at).getTime() >= ATTRS_EMPTY_REVERIFY_MS);
      return {
        _id: r._id,
        sku: r._id,
        searchFetchedAt: r.search_fetched_at,
        bundleFetchedAt: r.bundle_fetched_at,
        bundleId: r.bundle_id,
        attrsEmptyVerifiedAt: r.attrs_empty_verified_at,
        attrsEmpty,
        attrsStale,
        dataAttrs: bundleData?.attributes,
      };
    });
  },

  /** $in 批量查询(from-cache 用) */
  async findManyBySkuList(skus) {
    if (!skus.length) return [];
    const placeholders = skus.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT _id, search_data, search_fetched_at, bundle_data, bundle_fetched_at,
                bundle_id, attrs_empty_verified_at
         FROM ozon_attribute_cache WHERE _id IN (${placeholders})`
      )
      .all(...skus);
    return rows.map((r) => ({
      _id: r._id,
      sku: r._id,
      searchData: parseJson(r.search_data),
      searchFetchedAt: r.search_fetched_at,
      bundleData: parseJson(r.bundle_data),
      bundleFetchedAt: r.bundle_fetched_at,
      bundleId: r.bundle_id,
      attrsEmptyVerifiedAt: r.attrs_empty_verified_at,
      // 兼容字段:
      data: parseJson(r.bundle_data),
      fetchedAt: r.bundle_fetched_at || r.search_fetched_at,
    }));
  },

  async clearAll() {
    const r = db.prepare(`DELETE FROM ozon_attribute_cache`).run();
    return { deletedCount: r.changes };
  },
};
