// 店铺分类 + 店铺 SKU DAO(SQLite 实现)
// 关键:LIKE ? COLLATE NOCASE 替代 $regex+$options:'i';partialFilterExpression 唯一索引已在 schema.sql 建好
import { db } from '../../index.js';

export const storeClassificationDao = {
  async getBySlug(slug) {
    const row = db.prepare(`SELECT * FROM ozon_store_classification WHERE _id = ?`).get(slug);
    if (!row) return null;
    return {
      _id: row._id,
      sellerSlug: row.sellerSlug,
      sellerId: row.sellerId,
      sellerName: row.sellerName,
      isChinese: row.isChinese === null ? null : !!row.isChinese,
      classifiedBy: row.classifiedBy,
      classifiedAt: row.classifiedAt,
      companyInfo: row.companyInfo ? JSON.parse(row.companyInfo) : null,
      lastSeenAt: row.lastSeenAt,
      lastSeenUrl: row.lastSeenUrl,
    };
  },

  /** upsert:sellerId 仅在非空时写入(避免违反 partial unique index) */
  async upsertBySlug(slug, update) {
    const now = new Date().toISOString();
    const cols = ['_id', 'sellerSlug'];
    const vals = [slug, slug];
    for (const [k, v] of Object.entries(update)) {
      if (k === 'sellerId' && !v) continue; // 空字符串不写入
      if (k === 'companyInfo' && v && typeof v === 'object') {
        cols.push(k);
        vals.push(JSON.stringify(v));
      } else if (k === 'isChinese') {
        cols.push(k);
        vals.push(v === null ? null : v ? 1 : 0);
      } else {
        cols.push(k);
        vals.push(v);
      }
    }
    if (!cols.includes('classifiedAt')) {
      cols.push('classifiedAt');
      vals.push(now);
    }
    if (!cols.includes('lastSeenAt')) {
      cols.push('lastSeenAt');
      vals.push(now);
    }
    const updateCols = cols.filter((c) => c !== '_id');
    const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    db.prepare(
      `INSERT INTO ozon_store_classification (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(_id) DO UPDATE SET ${setClause}`
    ).run(...vals);
  },

  async deleteBySlug(slug) {
    const r = db.prepare(`DELETE FROM ozon_store_classification WHERE _id = ?`).run(slug);
    return { deletedCount: r.changes };
  },

  /** 分页列表:LIKE 三字段模糊 */
  async findPagedList(filter, page, pageSize) {
    const whereParts = [];
    const params = [];
    if (filter.isChinese === true || filter.isChinese === false) {
      whereParts.push('isChinese = ?');
      params.push(filter.isChinese ? 1 : 0);
    }
    if (filter.keyword) {
      const kw = `%${filter.keyword}%`;
      whereParts.push('(sellerName LIKE ? COLLATE NOCASE OR sellerSlug LIKE ? COLLATE NOCASE OR sellerId LIKE ? COLLATE NOCASE)');
      params.push(kw, kw, kw);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const skip = (page - 1) * pageSize;

    const items = db
      .prepare(
        `SELECT sellerSlug, sellerId, sellerName, isChinese, classifiedBy, classifiedAt, companyInfo, lastSeenAt, lastSeenUrl
         FROM ozon_store_classification ${where}
         ORDER BY lastSeenAt DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ozon_store_classification ${where}`).get(...params).n;
    const reshaped = items.map((r) => ({
      ...r,
      isChinese: r.isChinese === null ? null : !!r.isChinese,
      companyInfo: r.companyInfo ? JSON.parse(r.companyInfo) : null,
    }));
    return { items: reshaped, total };
  },
};

export const storeSkuDao = {
  async getBySku(sku) {
    const row = db.prepare(`SELECT * FROM ozon_store_sku WHERE _id = ?`).get(sku);
    if (!row) return null;
    return {
      ...row,
      lastCollectResults: row.lastCollectResults ? JSON.parse(row.lastCollectResults) : null,
    };
  },

  /** upsert:$setOnInsert(firstSeenAt) 仅首次写入 */
  async upsertBySku(sku, setFields) {
    const now = new Date().toISOString();
    const cols = [];
    const vals = [];
    for (const [k, v] of Object.entries(setFields)) {
      // sellerName 仅在非空时更新
      if (k === 'sellerName' && (v === null || v === undefined || v === '')) continue;
      if (k === 'lastCollectResults' && v && typeof v === 'object') {
        cols.push(k);
        vals.push(JSON.stringify(v));
      } else {
        cols.push(k);
        vals.push(v);
      }
    }
    cols.push('lastSeenAt');
    vals.push(now);
    // firstSeenAt 仅 ON CONFLICT 时不动(用 INSERT ... ON CONFLICT DO UPDATE 不更新该列实现)
    cols.push('firstSeenAt');
    vals.push(now);

    const updateCols = cols.filter((c) => c !== '_id' && c !== 'firstSeenAt');
    const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    db.prepare(
      `INSERT INTO ozon_store_sku (_id, ${cols.join(', ')}) VALUES (?, ${placeholders})
       ON CONFLICT(_id) DO UPDATE SET ${setClause}`
    ).run(sku, ...vals);
  },

  async deleteBySku(sku) {
    const r = db.prepare(`DELETE FROM ozon_store_sku WHERE _id = ?`).run(sku);
    return { deletedCount: r.changes };
  },

  /** 按 sellerSlug 查全量 */
  async findBySellerSlug(slug) {
    const rows = db
      .prepare(
        `SELECT * FROM ozon_store_sku WHERE sellerSlug = ? ORDER BY lastSeenAt DESC`
      )
      .all(slug);
    return rows.map((r) => ({
      ...r,
      sku: r._id,
      lastCollectResults: r.lastCollectResults ? JSON.parse(r.lastCollectResults) : null,
    }));
  },

  /** 分页列表:LIKE 四字段模糊(含 _id 即 SKU) */
  async findPagedList(keyword, page, pageSize) {
    let where = '';
    const params = [];
    if (keyword) {
      const kw = `%${keyword}%`;
      where =
        'WHERE (_id LIKE ? COLLATE NOCASE OR sellerSlug LIKE ? COLLATE NOCASE OR sellerName LIKE ? COLLATE NOCASE OR sellerId LIKE ? COLLATE NOCASE)';
      params.push(kw, kw, kw, kw);
    }
    const skip = (page - 1) * pageSize;
    const items = db
      .prepare(
        `SELECT * FROM ozon_store_sku ${where} ORDER BY lastSeenAt DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ozon_store_sku ${where}`).get(...params).n;
    const reshaped = items.map((r) => ({
      ...r,
      sku: r._id,
      lastCollectResults: r.lastCollectResults ? JSON.parse(r.lastCollectResults) : null,
    }));
    return { items: reshaped, total };
  },
};
