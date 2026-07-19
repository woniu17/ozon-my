// 索引表 DAO(SQLite):ozon_cache_index 的维护与查询
// 设计:5 张数据表(dom/attribute/richMedia/marketStats/followSell)upsert 时
//      调用 syncSku(sku) 同步索引表;listed/seller 由定时任务批量刷新
// 查询:from-cache / overview 只查这一张表,过滤/排序/分页全在 SQL 完成
// 全文搜索:走 ozon_cache_index_fts(FTS5 虚拟表),通过触发器自动同步
import { db } from '../../index.js';

function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// 从价格字符串中提取数字(去除货币符号/空格/小数点以外的字符)
// 例:"1 299 ₽" → 1299,"1299.00" → 1299.00,"" → null
function parsePriceValue(price) {
  if (price == null || price === '') return null;
  // 去除空格 + 常见货币符号,保留数字与小数点
  const cleaned = String(price).replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// FTS5 查询表达式转义:用户输入的 keyword 可能含 FTS5 特殊字符(" * ( ) - :)
// 策略:移除特殊字符,按空格分词,每词加前缀匹配 * 并用双引号包起来避免歧义
// 例:"apple phone" → "\"apple\"* \"phone\"*" → 匹配含"apple" AND "phone"前缀的文档(FTS5 默认 AND)
// 注:含 CJK 字符(中文/日文/韩文)的 keyword 走 LIKE 路径(返回空串触发 fallback)
//   FTS5 unicode61 不分词中文,MATCH "手机壳"* 只匹配以"手机壳"开头的文档,
//   原 LIKE '%手机壳%' 能匹配任何包含"手机壳"的文档(子串匹配),功能性回归。
//   且用户期望子串搜索语义,故对 CJK keyword 退化为 LIKE。
function fts5Escape(keyword) {
  const raw = String(keyword || '').trim();
  if (!raw) return '';
  // 检测 CJK 统一表意文字 + 日文假名 + 韩文谚文
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(raw)) return '';
  const cleaned = raw.replace(/["*()\-:]/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(' ');
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
    const attrData = parseJson(attr?.search_data);
    const bundleData = parseJson(attr?.bundle_data);
    const rmData = parseJson(rm?.data);
    const msData = parseJson(ms?.data);
    const fsData = parseJson(fs?.data);

    // name fallback 链(与 opi-preview 的合成逻辑对齐):
    //   1. bundle attr 4180(商品名,最权威)
    //   2. search attr 4180
    //   3. detail.title(DOM)
    //   4. card.name(DOM,搜索页/店铺页采集)
    // 注:之前只看 card.name + detail.title,DOM 解析失败时即使 bundle/search 有 4180 也显示未命名
    const sv = (attrData?.items && attrData.items[0]) || {};
    const bundleItem = bundleData || {};
    const bAttr4180 = bundleItem.attributes?.find((a) => String(a.attribute_id) === '4180');
    const sAttr4180 = sv.attributes?.find((a) => String(a.key) === '4180');
    const name =
      bAttr4180?.values?.[0]?.value ||
      sAttr4180?.value ||
      detailData?.title ||
      cardData?.name ||
      '';
    const price = detailData?.price || cardData?.price || '';
    // price_value:解析后的数字价格(供范围过滤用,走 idx_ci_price_value 索引)
    const priceValue = parsePriceValue(price);
    const primaryImage = cardData?.image || detailData?.images?.[0] || '';
    const url = cardData?.url || '';
    const ratingCount = Number.isFinite(Number(cardData?.ratingCount))
      ? Number(cardData?.ratingCount)
      : null;
    const hasVideo = rmData?.mp4 ? 1 : 0;
    // has_rich_content:richMedia.data.richContent(富内容 11254)有内容则 1
    // 不用 richContentHasText(语义过严),只要字符串非空就算"有富内容"
    const hasRichContent = rmData?.richContent && String(rmData.richContent).length > 0 ? 1 : 0;
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
        name, price, price_value, primary_image, url, rating_count,
        has_video, has_rich_content, market_price_p50, competitor_count,
        seller_slug, seller_name, listed, searchable_text, updated_at
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')
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
        name=excluded.name, price=excluded.price, price_value=excluded.price_value,
        primary_image=excluded.primary_image,
        url=excluded.url, rating_count=excluded.rating_count,
        has_video=excluded.has_video, has_rich_content=excluded.has_rich_content,
        market_price_p50=excluded.market_price_p50,
        competitor_count=excluded.competitor_count,
        -- seller_slug/seller_name/listed 不覆盖定时任务已写入的值
        -- 注:ozon_cache_index.xxx 是冲突行 DB 当前值,excluded.xxx 是本次 INSERT 想写入的值
        --   - listed:用 ozon_cache_index.listed 永远保留 DB 当前值(syncSku 从不主动改 listed)
        --   - seller_slug/seller_name:COALESCE 保留 DB 当前值,仅在 DB 为 NULL 时取 excluded(空串)
        seller_slug=COALESCE(ozon_cache_index.seller_slug, excluded.seller_slug),
        seller_name=COALESCE(ozon_cache_index.seller_name, excluded.seller_name),
        listed=ozon_cache_index.listed,
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
      priceValue,
      primaryImage,
      url,
      ratingCount,
      hasVideo,
      hasRichContent,
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
   * @param {boolean} [opts.hasRichContent] - 只看有富内容(richContent)
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
      hasRichContent,
      priceMin,
      priceMax,
      minCacheHits,
      page = 1,
      pageSize = 50,
    } = opts;
    const skip = (page - 1) * pageSize;

    const where = [];
    const params = [];
    // 关键词搜索:优先 FTS5(走倒排索引),fallback 到 LIKE(FTS5 表为空或查询失败时)
    if (keyword) {
      const ftsExpr = fts5Escape(keyword);
      if (ftsExpr) {
        where.push('sku IN (SELECT sku FROM ozon_cache_index_fts WHERE ozon_cache_index_fts MATCH ?)');
        params.push(ftsExpr);
      } else {
        // FTS5 转义后为空(纯特殊字符),退化为 LIKE
        where.push('searchable_text LIKE ? COLLATE NOCASE');
        params.push(`%${keyword}%`);
      }
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
    if (hasRichContent) {
      where.push('has_rich_content = 1');
    }
    // 价格范围:走 price_value(REAL 列,有 idx_ci_price_value 索引)
    //   原 CAST(price AS REAL) 无法用索引且对 "1 299 ₽" 这种字符串会截断为 1
    if (Number.isFinite(Number(priceMin))) {
      where.push('price_value IS NOT NULL AND price_value >= ?');
      params.push(Number(priceMin));
    }
    if (Number.isFinite(Number(priceMax))) {
      where.push('price_value IS NOT NULL AND price_value <= ?');
      params.push(Number(priceMax));
    }
    if (Number.isFinite(Number(minCacheHits)) && Number(minCacheHits) > 0) {
      // 数据完整 = 3 类合并缓存都有(dom + attribute + richMedia)
      //   dom_hit = card OR detail(任一有采集即可)
      //   attribute_hit = search AND bundle(都需要)
      //   rich_media_hit = richMedia
      // 合并命中数 = (card OR detail) + (search AND bundle) + richMedia ∈ [0, 3]
      where.push('((CASE WHEN card_hit=1 OR detail_hit=1 THEN 1 ELSE 0 END) + ' +
                  '(CASE WHEN search_hit=1 AND bundle_hit=1 THEN 1 ELSE 0 END) + ' +
                  '(CASE WHEN rich_media_hit=1 THEN 1 ELSE 0 END)) >= ?');
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
      const ftsExpr = fts5Escape(keyword);
      if (ftsExpr) {
        where.push('sku IN (SELECT sku FROM ozon_cache_index_fts WHERE ozon_cache_index_fts MATCH ?)');
        params.push(ftsExpr);
      } else {
        where.push('searchable_text LIKE ? COLLATE NOCASE');
        params.push(`%${keyword}%`);
      }
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

  /** 批量更新 seller 信息(由 index-sync 定时任务调用)
   *  改为单条 UPDATE FROM(避免 N+1 循环 UPDATE)
   *  SQLite 3.33+ 支持 UPDATE...FROM 语法
   */
  async refreshSellerInfo() {
    // total = 有 log 记录的 sku 数(用于统计)
    const totalRow = db
      .prepare(
        `SELECT COUNT(DISTINCT sku) AS n
         FROM ozon_auto_collect_log
         WHERE sellerSlug IS NOT NULL AND sellerSlug <> ''`
      )
      .get();
    const total = totalRow?.n || 0;
    const result = db
      .prepare(
        `WITH latest_sellers AS (
           SELECT l.sku, l.sellerSlug, sc.sellerName
           FROM (
             SELECT sku, sellerSlug,
                    ROW_NUMBER() OVER (PARTITION BY sku ORDER BY collectedAt DESC) AS rn
             FROM ozon_auto_collect_log
             WHERE sellerSlug IS NOT NULL AND sellerSlug <> ''
           ) l
           LEFT JOIN ozon_store_classification sc ON sc.sellerSlug = l.sellerSlug
           WHERE l.rn = 1
         )
         UPDATE ozon_cache_index
         SET seller_slug = ls.sellerSlug,
             seller_name = COALESCE(ls.sellerName, ''),
             searchable_text = COALESCE(name, '') || ' ' || sku || ' ' || COALESCE(ls.sellerName, ''),
             updated_at = datetime('now')
         FROM latest_sellers ls
         WHERE ozon_cache_index.sku = ls.sku`
      )
      .run();
    return { refreshed: result.changes, total };
  },

  /** 批量更新 listed 状态(由 index-sync 定时任务调用)
   *  只要 SKU 在 follow_sell_task_items 中存在任意记录,就标记为已跟卖(listed=1)
   *  不区分 item.status(pending/imported/failed/skipped 都算"已创建跟卖任务")
   *  两步 UPDATE 在事务中执行,避免中间状态
   */
  async refreshListedStatus() {
    // total = 有 task_items 记录的 sku 数
    const totalRow = db
      .prepare(
        `SELECT COUNT(DISTINCT SUBSTR(offer_id, 1, INSTR(offer_id, '-') - 1)) AS n
         FROM follow_sell_task_items
         WHERE offer_id LIKE '%-%'`
      )
      .get();
    const total = totalRow?.n || 0;

    // 提取 SKU 前缀的子查询(任意 status 都算已跟卖)
    const listedSkuExpr = `(
      SELECT DISTINCT SUBSTR(offer_id, 1, INSTR(offer_id, '-') - 1) AS sku
      FROM follow_sell_task_items
      WHERE offer_id LIKE '%-%'
    )`;

    let step1Changes = 0;
    let step2Changes = 0;
    const tx = db.transaction(() => {
      // Step 1: 有 task_items 记录 → listed=1(仅更新原值为 0 的行,减少无意义写入)
      const r1 = db
        .prepare(
          `UPDATE ozon_cache_index
           SET listed = 1, updated_at = datetime('now')
           WHERE listed = 0
             AND sku IN ${listedSkuExpr}`
        )
        .run();
      step1Changes = r1.changes;
      // Step 2: cache_index.listed=1 但 sku 不再属于有记录的集合 → listed=0
      //   (处理任务被删/所有 items 被清理的场景)
      const r2 = db
        .prepare(
          `UPDATE ozon_cache_index
           SET listed = 0, updated_at = datetime('now')
           WHERE listed = 1
             AND sku NOT IN ${listedSkuExpr}`
        )
        .run();
      step2Changes = r2.changes;
    });
    tx();
    // refreshed = 实际发生变更的行数(新增 listed=1 + 回退 listed=0)
    return { refreshed: step1Changes + step2Changes, total };
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
