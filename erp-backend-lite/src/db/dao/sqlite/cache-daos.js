// SQLite 缓存 DAO 工厂:richMedia / marketStats / followSell 三类独立缓存共用,
// 其余 4 类(dom/attribute/index)结构特殊,各自有专属 DAO 文件。
// 日期统一用 new Date().toISOString() 写入(UTC, T 分隔,带 Z)
import { db } from '../../index.js';
import { indexDao } from './index-dao.js';

/**
 * 创建通用缓存 DAO(SQLite 实现)
 * @param {string} table - 表名(如 'ozon_rich_media_cache')
 * @param {object} [opts]
 * @param {string[]} [opts.extraColumns] - 额外列(如 ['bundleId', 'attrsEmptyVerifiedAt'])
 * @param {boolean} [opts.hasL2Synced] - 是否含 l2Synced 列(marketStats/followSell)
 */
export function createCacheDao(table, opts = {}) {
  const { extraColumns = [], hasL2Synced = false } = opts;

  return {
    /** 按 SKU 查询,返回 { data, fetchedAt, ...extra } 或 { data: null } */
    async getBySku(sku) {
      const row = db.prepare(`SELECT * FROM ${table} WHERE _id = ?`).get(sku);
      if (!row || !row.data) return { data: null };
      const result = {
        data: JSON.parse(row.data),
        fetchedAt: row.fetchedAt,
      };
      if (hasL2Synced) result.l2Synced = !!row.l2Synced;
      for (const col of extraColumns) {
        if (row[col] !== undefined && row[col] !== null) result[col] = row[col];
      }
      return result;
    },

    /** 全字段读取(admin detail/opi-preview 用) */
    async findById(sku) {
      const row = db.prepare(`SELECT * FROM ${table} WHERE _id = ?`).get(sku);
      if (!row) return null;
      const doc = { _id: row._id, sku: row._id, data: JSON.parse(row.data), fetchedAt: row.fetchedAt };
      if (hasL2Synced) doc.l2Synced = !!row.l2Synced;
      for (const col of extraColumns) {
        if (row[col] !== undefined && row[col] !== null) doc[col] = row[col];
      }
      return doc;
    },

    /** upsert,extraFields 为额外字段值 */
    async upsert(sku, data, extraFields = {}) {
      const now = new Date().toISOString();
      const dataJson = JSON.stringify(data);
      const cols = ['_id', 'data', 'fetchedAt'];
      const vals = [sku, dataJson, now];
      if (hasL2Synced) {
        cols.push('l2Synced');
        vals.push(1);
      }
      for (const col of extraColumns) {
        if (extraFields[col] !== undefined) {
          cols.push(col);
          vals.push(extraFields[col]);
        }
      }
      // ON CONFLICT(_id) DO UPDATE:更新除 _id 外的所有列
      const updateCols = cols.filter((c) => c !== '_id');
      const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      db.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
         ON CONFLICT(_id) DO UPDATE SET ${setClause}`
      ).run(...vals);
      // upsert 后同步索引表(与 domDao/attributeDao 行为一致),
      // 确保 followSell/richMedia/marketStats 写入后 ozon_cache_index 的 hit 位及时更新。
      // 不 await:避免阻塞调用方,失败不影响缓存写入本身。
      indexDao.syncSku(sku).catch((e) => {
        console.warn(`[cacheDao:${table}] index sync failed for ${sku}:`, e?.message || e);
      });
    },

    async deleteBySku(sku) {
      db.prepare(`DELETE FROM ${table} WHERE _id = ?`).run(sku);
    },

    /** 文档数(等价 estimatedDocumentCount) */
    async estimatedCount() {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    },

    async countByQuery(_query = {}) {
      // SQLite 通用查询不支持 MongoDB query 对象,按需在子类实现
      // 这里仅支持空 query(全表计数)
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    },

    /** 分页列表(单类型 list 路由用) */
    async findPagedList(keyword, page, pageSize) {
      const skip = (page - 1) * pageSize;
      const cols = ['_id', 'fetchedAt'];
      if (hasL2Synced) cols.push('l2Synced');
      for (const col of extraColumns) cols.push(col);

      let where = '';
      const params = [];
      if (keyword) {
        where = 'WHERE _id LIKE ? COLLATE NOCASE';
        params.push(`%${keyword}%`);
      }
      const [items, total] = await Promise.all([
        Promise.resolve(
          db.prepare(
            `SELECT ${cols.join(', ')} FROM ${table} ${where} ORDER BY fetchedAt DESC LIMIT ? OFFSET ?`
          ).all(...params, pageSize, skip)
        ),
        Promise.resolve(db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params).n),
      ]);
      // 重塑为与 mongo 一致的字段名(sku 而非 _id)
      const reshaped = items.map((r) => ({ ...r, sku: r._id }));
      return { items: reshaped, total };
    },

    /** overview 路由用:全量加载(仅必要字段) */
    async findOverviewList(keyword) {
      const cols = ['_id', 'fetchedAt'];
      if (hasL2Synced) cols.push('l2Synced');
      let where = '';
      const params = [];
      if (keyword) {
        where = 'WHERE _id LIKE ? COLLATE NOCASE';
        params.push(`%${keyword}%`);
      }
      const items = db
        .prepare(`SELECT ${cols.join(', ')} FROM ${table} ${where}`)
        .all(...params);
      return items.map((r) => ({ ...r, sku: r._id }));
    },

    /** $in 批量查询(storeSku by-store 路由用) */
    async findManyBySkuList(skus) {
      if (!skus.length) return [];
      const placeholders = skus.map(() => '?').join(', ');
      const rows = db
        .prepare(`SELECT * FROM ${table} WHERE _id IN (${placeholders})`)
        .all(...skus);
      return rows.map((r) => ({
        _id: r._id,
        sku: r._id,
        data: JSON.parse(r.data),
        fetchedAt: r.fetchedAt,
      }));
    },

    /** 清空表 */
    async clearAll() {
      const r = db.prepare(`DELETE FROM ${table}`).run();
      return { deletedCount: r.changes };
    },
  };
}
