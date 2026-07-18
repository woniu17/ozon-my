// DOM 缓存 DAO(SQLite):card + detail 合并表,字段独立,互相备份
// 写入:upsertCard / upsertDetail 各自只更新对应字段
// 读取:getBySku 返回 { card, detail, cardFetchedAt, detailFetchedAt }
//      findById 同上,但字段名带 _id/sku
// 索引表同步:每次 upsert 后调用 indexDao.syncSku(sku) 维护 ozon_cache_index
import { db } from '../../index.js';
import { indexDao } from './index-dao.js';

function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const domDao = {
  /** 按 SKU 查询:返回 { card, detail, cardFetchedAt, detailFetchedAt } 或 null */
  async getBySku(sku) {
    const row = db
      .prepare(
        `SELECT card_data, card_fetched_at, detail_data, detail_fetched_at
         FROM ozon_dom_cache WHERE _id = ?`
      )
      .get(sku);
    if (!row) {
      return { card: null, detail: null, cardFetchedAt: null, detailFetchedAt: null };
    }
    return {
      card: parseJson(row.card_data),
      detail: parseJson(row.detail_data),
      cardFetchedAt: row.card_fetched_at,
      detailFetchedAt: row.detail_fetched_at,
    };
  },

  /** 全字段读取(buildSynthesizedFromCache 用):返回 { _id, sku, card, detail, cardFetchedAt, detailFetchedAt } */
  async findById(sku) {
    const row = db
      .prepare(
        `SELECT _id, card_data, card_fetched_at, detail_data, detail_fetched_at
         FROM ozon_dom_cache WHERE _id = ?`
      )
      .get(sku);
    if (!row) return null;
    return {
      _id: row._id,
      sku: row._id,
      card: parseJson(row.card_data),
      cardFetchedAt: row.card_fetched_at,
      detail: parseJson(row.detail_data),
      detailFetchedAt: row.detail_fetched_at,
    };
  },

  /** 只写 card 部分(不影响 detail) */
  async upsertCard(sku, cardData) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ozon_dom_cache (_id, card_data, card_fetched_at, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(_id) DO UPDATE SET
         card_data = excluded.card_data,
         card_fetched_at = excluded.card_fetched_at,
         updated_at = datetime('now')`
    ).run(sku, JSON.stringify(cardData), now);
    // 异步同步索引表(fire-and-forget,失败不影响主流程)
    indexDao.syncSku(sku).catch((e) => {
      console.warn(`[domDao] index sync failed for ${sku}:`, e?.message || e);
    });
  },

  /** 只写 detail 部分(不影响 card) */
  async upsertDetail(sku, detailData) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ozon_dom_cache (_id, detail_data, detail_fetched_at, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(_id) DO UPDATE SET
         detail_data = excluded.detail_data,
         detail_fetched_at = excluded.detail_fetched_at,
         updated_at = datetime('now')`
    ).run(sku, JSON.stringify(detailData), now);
    indexDao.syncSku(sku).catch((e) => {
      console.warn(`[domDao] index sync failed for ${sku}:`, e?.message || e);
    });
  },

  /** 兼容旧 API:upsert(sku, data) 默认当 card 写入(向后兼容 cardDao.upsert) */
  async upsert(sku, data) {
    return this.upsertCard(sku, data);
  },

  async deleteBySku(sku) {
    db.prepare(`DELETE FROM ozon_dom_cache WHERE _id = ?`).run(sku);
    indexDao.deleteSku(sku).catch(() => {});
  },

  /** 文档数(以 _id 存在为准,card_data 或 detail_data 任一非空) */
  async estimatedCount() {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM ozon_dom_cache
         WHERE card_data IS NOT NULL OR detail_data IS NOT NULL`
      )
      .get().n;
  },

  /** 分页列表(单类型 list 路由用) */
  async findPagedList(keyword, page, pageSize) {
    const skip = (page - 1) * pageSize;
    let where = 'WHERE card_data IS NOT NULL OR detail_data IS NOT NULL';
    const params = [];
    if (keyword) {
      where += ' AND _id LIKE ? COLLATE NOCASE';
      params.push(`%${keyword}%`);
    }
    const items = db
      .prepare(
        `SELECT _id, card_fetched_at, detail_fetched_at
         FROM ozon_dom_cache ${where}
         ORDER BY COALESCE(card_fetched_at, detail_fetched_at) DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_dom_cache ${where}`)
      .get(...params).n;
    return {
      items: items.map((r) => ({
        _id: r._id,
        sku: r._id,
        cardFetchedAt: r.card_fetched_at,
        detailFetchedAt: r.detail_fetched_at,
      })),
      total,
    };
  },

  /** overview 用:全量加载(仅必要字段) */
  async findOverviewList(keyword) {
    let where = 'WHERE card_data IS NOT NULL OR detail_data IS NOT NULL';
    const params = [];
    if (keyword) {
      where += ' AND _id LIKE ? COLLATE NOCASE';
      params.push(`%${keyword}%`);
    }
    const items = db
      .prepare(`SELECT _id, card_fetched_at, detail_fetched_at FROM ozon_dom_cache ${where}`)
      .all(...params);
    return items.map((r) => ({
      _id: r._id,
      sku: r._id,
      cardFetchedAt: r.card_fetched_at,
      detailFetchedAt: r.detail_fetched_at,
    }));
  },

  /** $in 批量查询(from-cache 用) */
  async findManyBySkuList(skus) {
    if (!skus.length) return [];
    const placeholders = skus.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT _id, card_data, card_fetched_at, detail_data, detail_fetched_at
         FROM ozon_dom_cache WHERE _id IN (${placeholders})`
      )
      .all(...skus);
    return rows.map((r) => ({
      _id: r._id,
      sku: r._id,
      card: parseJson(r.card_data),
      cardFetchedAt: r.card_fetched_at,
      detail: parseJson(r.detail_data),
      detailFetchedAt: r.detail_fetched_at,
    }));
  },

  async clearAll() {
    const r = db.prepare(`DELETE FROM ozon_dom_cache`).run();
    return { deletedCount: r.changes };
  },
};
