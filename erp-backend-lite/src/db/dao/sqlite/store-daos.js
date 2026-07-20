// 店铺分类 + 店铺 SKU DAO(SQLite 实现)
// 2026-07 重构:主键改为 sellerId(稳定),sellerSlug 作为普通字段 + 索引(反查用)
// 主查询入口 getBySellerId / findBySellerId 用 sellerId(走主键/索引),getBySlug 保留作为兼容方法(走 idx_sc_slug)
// 关键:LIKE ? COLLATE NOCASE 替代 $regex+$options:'i'
import { db } from '../../index.js';

export const storeClassificationDao = {
  /** 按 sellerId 查询(新主键,_id = sellerId) */
  async getBySellerId(sellerId) {
    if (!sellerId) return null;
    const row = db
      .prepare(`SELECT * FROM ozon_store_classification WHERE _id = ?`)
      .get(String(sellerId));
    if (!row) return null;
    return {
      _id: row._id,
      sellerId: row.sellerId,
      sellerSlug: row.sellerSlug,
      sellerName: row.sellerName,
      isChinese: row.isChinese === null ? null : !!row.isChinese,
      classifiedBy: row.classifiedBy,
      classifiedAt: row.classifiedAt,
      companyInfo: row.companyInfo ? JSON.parse(row.companyInfo) : null,
      lastSeenAt: row.lastSeenAt,
      lastSeenUrl: row.lastSeenUrl,
    };
  },

  /** 按 sellerSlug 查询(兼容方法,走 idx_sc_slug 索引)
   *  用途:扩展端首次访问时 sellerId 可能未取到,只有 sellerSlug;以及反查场景
   *  注意:sellerSlug 可变(店铺改名),此方法返回的记录可能滞后,生产环境优先用 getBySellerId
   */
  async getBySlug(slug) {
    if (!slug) return null;
    const row = db
      .prepare(`SELECT * FROM ozon_store_classification WHERE sellerSlug = ? LIMIT 1`)
      .get(String(slug));
    if (!row) return null;
    return {
      _id: row._id,
      sellerId: row.sellerId,
      sellerSlug: row.sellerSlug,
      sellerName: row.sellerName,
      isChinese: row.isChinese === null ? null : !!row.isChinese,
      classifiedBy: row.classifiedBy,
      classifiedAt: row.classifiedAt,
      companyInfo: row.companyInfo ? JSON.parse(row.companyInfo) : null,
      lastSeenAt: row.lastSeenAt,
      lastSeenUrl: row.lastSeenUrl,
    };
  },

  /** upsert by sellerId(新主键)
   *  update 字段可含 sellerSlug / sellerName / isChinese / classifiedBy / companyInfo / lastSeenUrl
   *  sellerId 必填(主键),sellerSlug 可选(店铺改名时变化)
   */
  async upsertBySellerId(sellerId, update) {
    const id = String(sellerId);
    const now = new Date().toISOString();
    const cols = ['_id', 'sellerId'];
    const vals = [id, id];
    for (const [k, v] of Object.entries(update || {})) {
      if (k === 'sellerId') continue; // 已作为主键
      if (k === 'companyInfo' && v && typeof v === 'object') {
        cols.push(k);
        vals.push(JSON.stringify(v));
      } else if (k === 'isChinese') {
        cols.push(k);
        vals.push(v === null ? null : v ? 1 : 0);
      } else if (v instanceof Date) {
        // better-sqlite3 不支持 Date 对象绑定,转 ISO 字符串
        cols.push(k);
        vals.push(v.toISOString());
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

  /** upsert by slug(旧接口,兼容期保留)
   *  内部先按 slug 查找已有记录的 sellerId,有则用 upsertBySellerId 更新;
   *  无则用 slug 作为 _id 临时占位(等扩展端上报 sellerId 后再迁移)。
   *  注意:此方法不应在新代码中使用,仅供过渡期兼容。
   */
  async upsertBySlug(slug, update) {
    const existing = await this.getBySlug(slug);
    const sellerId = (update && update.sellerId) || existing?.sellerId;
    if (sellerId) {
      // 合并已有 sellerSlug(避免被 update 覆盖为空)
      const merged = { ...update };
      if (!merged.sellerSlug && existing?.sellerSlug) merged.sellerSlug = existing.sellerSlug;
      return this.upsertBySellerId(sellerId, merged);
    }
    // sellerId 仍为空:写入 legacy 表(避免污染新表)
    const now = new Date().toISOString();
    const cols = ['_id', 'sellerSlug', 'migratedAt'];
    const vals = [String(slug), String(slug), now];
    for (const [k, v] of Object.entries(update || {})) {
      if (k === 'sellerId') continue;
      if (k === 'companyInfo' && v && typeof v === 'object') {
        cols.push(k);
        vals.push(JSON.stringify(v));
      } else if (k === 'isChinese') {
        cols.push(k);
        vals.push(v === null ? null : v ? 1 : 0);
      } else if (v instanceof Date) {
        cols.push(k);
        vals.push(v.toISOString());
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
      `INSERT INTO ozon_store_classification_legacy (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(_id) DO UPDATE SET ${setClause}`
    ).run(...vals);
  },

  async deleteBySellerId(sellerId) {
    const r = db
      .prepare(`DELETE FROM ozon_store_classification WHERE _id = ?`)
      .run(String(sellerId));
    return { deletedCount: r.changes };
  },

  /** 删除 by slug(兼容方法,会同时清理新表 + legacy 表) */
  async deleteBySlug(slug) {
    const r1 = db
      .prepare(`DELETE FROM ozon_store_classification WHERE sellerSlug = ?`)
      .run(String(slug));
    const r2 = db
      .prepare(`DELETE FROM ozon_store_classification_legacy WHERE sellerSlug = ?`)
      .run(String(slug));
    return { deletedCount: r1.changes + r2.changes };
  },

  /** 分页列表:LIKE 三字段模糊(sellerId / sellerName / sellerSlug) */
  async findPagedList(filter, page, pageSize) {
    const whereParts = [];
    const params = [];
    if (filter.isChinese === true || filter.isChinese === false) {
      whereParts.push('isChinese = ?');
      params.push(filter.isChinese ? 1 : 0);
    }
    if (filter.keyword) {
      const kw = `%${filter.keyword}%`;
      whereParts.push(
        '(sellerName LIKE ? COLLATE NOCASE OR sellerSlug LIKE ? COLLATE NOCASE OR sellerId LIKE ? COLLATE NOCASE)'
      );
      params.push(kw, kw, kw);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const skip = (page - 1) * pageSize;

    const items = db
      .prepare(
        `SELECT sellerId, sellerSlug, sellerName, isChinese, classifiedBy, classifiedAt, companyInfo, lastSeenAt, lastSeenUrl
         FROM ozon_store_classification ${where}
         ORDER BY lastSeenAt DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_store_classification ${where}`)
      .get(...params).n;
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

  /** 按 sellerId 查全量(走 idx_ss_seller_seen 索引) */
  async findBySellerId(sellerId) {
    if (!sellerId) return [];
    const rows = db
      .prepare(
        `SELECT * FROM ozon_store_sku WHERE sellerId = ? ORDER BY lastSeenAt DESC`
      )
      .all(String(sellerId));
    return rows.map((r) => ({
      ...r,
      sku: r._id,
      lastCollectResults: r.lastCollectResults ? JSON.parse(r.lastCollectResults) : null,
    }));
  },

  /** 按 sellerSlug 查全量(兼容方法,无索引全表扫描)
   *  仅用于扩展端首次访问时 sellerId 未取到的场景,生产环境优先用 findBySellerId
   */
  async findBySellerSlug(slug) {
    if (!slug) return [];
    const rows = db
      .prepare(
        `SELECT * FROM ozon_store_sku WHERE sellerSlug = ? ORDER BY lastSeenAt DESC`
      )
      .all(String(slug));
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
