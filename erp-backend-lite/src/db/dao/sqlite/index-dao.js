// 索引表 DAO(SQLite):ozon_cache_index 的维护与查询
// 设计:5 张数据表(dom/attribute/richMedia/marketStats/followSell)upsert 时
//      调用 syncSku(sku) 同步索引表;listed/seller 由定时任务批量刷新
// 查询:from-cache / overview 只查这一张表,过滤/排序/分页全在 SQL 完成
import { db } from '../../index.js';

function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export const indexDao = {
  /**
   * 同步单个 SKU 的索引行(从 5 张数据表聚合最新状态)
   * 触发时机:数据表 upsert 后 fire-and-forget 调用
   * 注意:listed/seller_slug/seller_name 不在此处更新(由 index-sync 定时任务批量刷新)
   */
  async syncSku(sku) {
    const [dom, attr, rm, ms, fs] = await Promise.all([
      db
        .prepare(
          `SELECT card_data, card_fetched_at, detail_data, detail_fetched_at FROM ozon_dom_cache WHERE _id=?`
        )
        .get(sku),
      db
        .prepare(
          `SELECT search_data, search_fetched_at, bundle_data, bundle_fetched_at
           FROM ozon_attribute_cache WHERE _id=?`
        )
        .get(sku),
      db.prepare(`SELECT data, fetchedAt FROM ozon_rich_media_cache WHERE _id=?`).get(sku),
      db.prepare(`SELECT data, fetchedAt FROM ozon_market_stats_cache WHERE _id=?`).get(sku),
      db.prepare(`SELECT data, fetchedAt FROM ozon_follow_sell_cache WHERE _id=?`).get(sku),
    ]);

    // 命中位
    const cardHit = dom?.card_data ? 1 : 0;
    const detailHit = dom?.detail_data ? 1 : 0;
    const searchHit = attr?.search_data ? 1 : 0;
    const bundleHit = attr?.bundle_data ? 1 : 0;
    const rmHit = rm?.data ? 1 : 0;
    const msHit = ms?.data ? 1 : 0;
    const fsHit = fs?.data ? 1 : 0;
    const hitCount = cardHit + detailHit + searchHit + bundleHit + rmHit + msHit + fsHit;

    // 提取冗余展示字段
    const cardData = parseJson(dom?.card_data);
    const detailData = parseJson(dom?.detail_data);
    const rmData = parseJson(rm?.data);
    const msData = parseJson(ms?.data);
    const fsData = parseJson(fs?.data);

    const name = cardData?.name || detailData?.title || '';
    const price = detailData?.price || cardData?.price || '';
    const primaryImage = cardData?.image || detailData?.images?.[0] || '';
    const url = cardData?.url || '';
    const ratingCount = Number.isFinite(Number(cardData?.ratingCount))
      ? Number(cardData?.ratingCount)
      : null;
    const hasVideo = rmData?.mp4 ? 1 : 0;
    const marketPriceP50 = msData?.priceP50 ?? msData?.p50 ?? null;
    const competitorCount =
      Array.isArray(fsData?.sellers)
        ? fsData.sellers.length
        : Array.isArray(fsData?.competitors)
          ? fsData.competitors.length
          : null;

    // last_fetched_at:7 类最新
    const fetchedAts = [
      dom?.card_fetched_at,
      dom?.detail_fetched_at,
      attr?.search_fetched_at,
      attr?.bundle_fetched_at,
      rm?.fetchedAt,
      ms?.fetchedAt,
      fs?.fetchedAt,
    ].filter(Boolean);
    fetchedAts.sort();
    const lastFetchedAt = fetchedAts.pop() || null;

    // 全文搜索字段(name + sku + seller_name 会在定时任务里补 seller)
    // 这里先用现有 seller_name(可能为空)
    const existing = db
      .prepare(`SELECT seller_slug, seller_name, listed FROM ozon_cache_index WHERE sku=?`)
      .get(sku);
    const sellerSlug = existing?.seller_slug || '';
    const sellerName = existing?.seller_name || '';
    const listed = existing?.listed || 0;
    const searchableText = [name, sku, sellerName].filter(Boolean).join(' ');

    db.prepare(
      `INSERT INTO ozon_cache_index (
        sku, card_hit, card_fetched_at, detail_hit, detail_fetched_at,
        search_hit, search_fetched_at, bundle_hit, bundle_fetched_at,
        rich_media_hit, rich_media_fetched_at,
        market_stats_hit, market_stats_fetched_at,
        follow_sell_hit, follow_sell_fetched_at,
        hit_count, last_fetched_at,
        name, price, primary_image, url, rating_count,
        has_video, market_price_p50, competitor_count,
        seller_slug, seller_name, listed, searchable_text, updated_at
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')
      )
      ON CONFLICT(sku) DO UPDATE SET
        card_hit=excluded.card_hit, card_fetched_at=excluded.card_fetched_at,
        detail_hit=excluded.detail_hit, detail_fetched_at=excluded.detail_fetched_at,
        search_hit=excluded.search_hit, search_fetched_at=excluded.search_fetched_at,
        bundle_hit=excluded.bundle_hit, bundle_fetched_at=excluded.bundle_fetched_at,
        rich_media_hit=excluded.rich_media_hit, rich_media_fetched_at=excluded.rich_media_fetched_at,
        market_stats_hit=excluded.market_stats_hit, market_stats_fetched_at=excluded.market_stats_fetched_at,
        follow_sell_hit=excluded.follow_sell_hit, follow_sell_fetched_at=excluded.follow_sell_fetched_at,
        hit_count=excluded.hit_count, last_fetched_at=excluded.last_fetched_at,
        name=excluded.name, price=excluded.price, primary_image=excluded.primary_image,
        url=excluded.url, rating_count=excluded.rating_count,
        has_video=excluded.has_video, market_price_p50=excluded.market_price_p50,
        competitor_count=excluded.competitor_count,
        searchable_text=excluded.searchable_text,
        updated_at=datetime('now')`
    ).run(
      sku,
      cardHit,
      dom?.card_fetched_at || null,
      detailHit,
      dom?.detail_fetched_at || null,
      searchHit,
      attr?.search_fetched_at || null,
      bundleHit,
      attr?.bundle_fetched_at || null,
      rmHit,
      rm?.fetchedAt || null,
      msHit,
      ms?.fetchedAt || null,
      fsHit,
      fs?.fetchedAt || null,
      hitCount,
      lastFetchedAt,
      name,
      price,
      primaryImage,
      url,
      ratingCount,
      hasVideo,
      marketPriceP50,
      competitorCount,
      sellerSlug,
      sellerName,
      listed,
      searchableText
    );
  },

  /** 删除 SKU 索引行 */
  async deleteSku(sku) {
    db.prepare(`DELETE FROM ozon_cache_index WHERE sku = ?`).run(sku);
  },

  /**
   * 列表查询(from-cache 主入口):单表 SQL 过滤 + 分页
   * @param {object} opts
   * @param {string} [opts.keyword] - 关键词(匹配 searchable_text)
   * @param {string} [opts.sellerSlug] - 卖家筛选
   * @param {boolean} [opts.unlisted] - 只看未跟卖
   * @param {boolean} [opts.hasComments] - 只看有评论
   * @param {boolean} [opts.hasVideo] - 只看有视频
   * @param {number} [opts.priceMin] - 价格下限
   * @param {number} [opts.priceMax] - 价格上限
   * @param {number} [opts.minCacheHits] - 最小命中数
   * @param {number} [opts.page=1]
   * @param {number} [opts.pageSize=50]
   * @returns {Promise<{items: Array, total: number}>}
   */
  async findList(opts = {}) {
    const {
      keyword,
      sellerSlug,
      unlisted,
      hasComments,
      hasVideo,
      priceMin,
      priceMax,
      minCacheHits,
      page = 1,
      pageSize = 50,
    } = opts;
    const skip = (page - 1) * pageSize;

    const where = [];
    const params = [];
    if (keyword) {
      where.push('searchable_text LIKE ? COLLATE NOCASE');
      params.push(`%${keyword}%`);
    }
    if (sellerSlug) {
      where.push('seller_slug = ?');
      params.push(sellerSlug);
    }
    if (unlisted) {
      where.push('listed = 0');
    }
    if (hasComments) {
      where.push('rating_count > 0');
    }
    if (hasVideo) {
      where.push('has_video = 1');
    }
    // 价格范围:price 为 TEXT 列(可能为空串/数字字符串/NULL)
    //   CAST(price AS REAL) 对空串/NULL 返回 0,需额外排除 price 为空/NULL 的情况
    if (Number.isFinite(Number(priceMin))) {
      where.push('price IS NOT NULL AND price <> "" AND CAST(price AS REAL) >= ?');
      params.push(Number(priceMin));
    }
    if (Number.isFinite(Number(priceMax))) {
      where.push('price IS NOT NULL AND price <> "" AND CAST(price AS REAL) <= ?');
      params.push(Number(priceMax));
    }
    if (Number.isFinite(Number(minCacheHits)) && Number(minCacheHits) > 0) {
      where.push('hit_count >= ?');
      params.push(Number(minCacheHits));
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const items = db
      .prepare(
        `SELECT * FROM ozon_cache_index ${whereClause}
         ORDER BY last_fetched_at DESC NULLS LAST
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index ${whereClause}`)
      .get(...params).n;
    return { items, total };
  },

  /** overview 全览(轻量,只取命中位 + 时间) */
  async findOverviewList(keyword, page = 1, pageSize = 50) {
    const skip = (page - 1) * pageSize;
    const where = [];
    const params = [];
    if (keyword) {
      where.push('searchable_text LIKE ? COLLATE NOCASE');
      params.push(`%${keyword}%`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const items = db
      .prepare(
        `SELECT sku, card_hit, card_fetched_at, detail_hit, detail_fetched_at,
                search_hit, search_fetched_at, bundle_hit, bundle_fetched_at,
                rich_media_hit, rich_media_fetched_at,
                market_stats_hit, market_stats_fetched_at,
                follow_sell_hit, follow_sell_fetched_at,
                hit_count, last_fetched_at, listed
         FROM ozon_cache_index ${whereClause}
         ORDER BY last_fetched_at DESC NULLS LAST
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    const total = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index ${whereClause}`)
      .get(...params).n;
    return { items, total };
  },

  /** 批量更新 seller 信息(由 index-sync 定时任务调用) */
  async refreshSellerInfo() {
    // 从 ozon_auto_collect_log 拿每个 SKU 最新一条 sellerSlug
    const rows = db
      .prepare(
        `SELECT l.sku, l.sellerSlug, sc.sellerName
         FROM (
           SELECT sku, sellerSlug,
                  ROW_NUMBER() OVER (PARTITION BY sku ORDER BY collectedAt DESC) AS rn
           FROM ozon_auto_collect_log
           WHERE sellerSlug IS NOT NULL AND sellerSlug <> ''
         ) l
         LEFT JOIN ozon_store_classification sc ON sc.sellerSlug = l.sellerSlug
         WHERE l.rn = 1`
      )
      .all();
    let updated = 0;
    for (const r of rows) {
      const sellerName = r.sellerName || '';
      const result = db
        .prepare(
          `UPDATE ozon_cache_index
           SET seller_slug = ?, seller_name = ?,
               searchable_text = COALESCE(name, '') || ' ' || sku || ' ' || ?,
               updated_at = datetime('now')
           WHERE sku = ?`
        )
        .run(r.sellerSlug, sellerName, sellerName, r.sku);
      if (result.changes > 0) updated++;
    }
    return { refreshed: updated, total: rows.length };
  },

  /** 批量更新 listed 状态(由 index-sync 定时任务调用) */
  async refreshListedStatus() {
    // 已跟卖 = follow_sell_task_items 有记录(offer_id 格式 {SKU}-{mmdd}-qx)
    // 用 LIKE 通配符匹配 SKU 前缀
    const rows = db
      .prepare(
        `SELECT DISTINCT
           ci.sku,
           CASE WHEN fti.offer_id IS NOT NULL THEN 1 ELSE 0 END AS listed
         FROM ozon_cache_index ci
         LEFT JOIN follow_sell_task_items fti
           ON fti.offer_id LIKE ci.sku || '-%'
         GROUP BY ci.sku`
      )
      .all();
    let updated = 0;
    for (const r of rows) {
      const result = db
        .prepare(`UPDATE ozon_cache_index SET listed = ?, updated_at = datetime('now') WHERE sku = ?`)
        .run(r.listed, r.sku);
      if (result.changes > 0) updated++;
    }
    return { refreshed: updated, total: rows.length };
  },

  /** 统计各类缓存文档数(供 dashboard 用) */
  async getCacheCounts() {
    const [dom, attr, rm, ms, fs] = await Promise.all([
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ozon_dom_cache WHERE card_data IS NOT NULL OR detail_data IS NOT NULL`
        )
        .get().n,
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ozon_attribute_cache WHERE search_data IS NOT NULL OR bundle_data IS NOT NULL`
        )
        .get().n,
      db.prepare(`SELECT COUNT(*) AS n FROM ozon_rich_media_cache`).get().n,
      db.prepare(`SELECT COUNT(*) AS n FROM ozon_market_stats_cache`).get().n,
      db.prepare(`SELECT COUNT(*) AS n FROM ozon_follow_sell_cache`).get().n,
    ]);
    return { dom, attribute: attr, richMedia: rm, marketStats: ms, followSell: fs };
  },

  async estimatedCount() {
    return db.prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index`).get().n;
  },

  async clearAll() {
    const r = db.prepare(`DELETE FROM ozon_cache_index`).run();
    return { deletedCount: r.changes };
  },
};
