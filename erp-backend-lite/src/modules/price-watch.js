// 价格优势监控(2026-08)
// qxqx/price-watch-collect.js 在买家页抓取我的 SKU 的跟卖列表(composer offers-modal),
// 与 product_data_cache 中我的价格对比,计算最低价/中位数/排名/价差,写入快照表
//
// 任务为派生视图(无队列表):
//   GET /tasks 实时从 product_data_cache 计算(saleable 商品),24h 内已成功的 SKU 跳过
//
// 路由:
//   GET  /admin/api/price-watch/tasks        脚本领取待采 SKU 列表(派生)
//   POST /admin/api/price-watch/report       脚本批量上报采集结果(服务端计算对比指标)
//   GET  /admin/api/price-watch/list         每 SKU 最新快照分页列表(前端看板)
//   GET  /admin/api/price-watch/detail/:sku  单 SKU 快照历史 + 最新跟卖明细
//   GET  /admin/api/price-watch/stats        看板汇总统计(优势分布/价格新鲜度/店铺同步时间)
//
// 保留期清理:startPriceWatchRetention()(app.js 启动时挂载,每日一次,默认 30 天)
import { Router } from 'express';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';

const router = Router();

const BATCH_LIMIT = 100;

// ── 价格文本解析:"1 990 ₽" → 1990 ─────────────────────────
// 跟卖 modal 存储的 price 为原始对象,已知两种形态:
//   {cardPrice:{price:"65,29 ¥"}} 常规卡片价;{originalPrice:"657,01 ¥",price:"657,01 ¥"} 无卡片价(顶层字符串)
// 兜底链中仅接受字符串/数字,防止嵌套对象被 String() 成 "[object Object]"
const _plain = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
export function parsePriceText(raw) {
  if (raw == null) return null;
  const text =
    _plain(raw) ??
    (typeof raw === 'object'
      ? _plain(raw?.cardPrice?.price) ??
        _plain(raw?.cardPrice?.text) ??
        _plain(raw?.cardPrice) ??
        _plain(raw?.text) ??
        _plain(raw?.price) ??
        _plain(raw?.originalPrice) ??
        ''
      : '');
  const m = text.replace(/\s|\u00A0/g, '').match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ── 我的现价:从 product_data_cache.data(OPI /v3/product/info 原始 JSON)提取 ──
// v3 返回 price 为字符串("1390.000000",见 docs/ozon-api/01-商品管理.md);
// 兼容对象形态(price.price / marketing_price.price)防御 OPI 版本差异
function extractMyPrice(data) {
  if (!data || typeof data !== 'object') return null;
  const p = data.price ?? data.marketing_price;
  if (p == null) return null;
  const raw = typeof p === 'object' ? p.price : p;
  if (raw == null) return null;
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ── 对比指标计算(全部报价参与,不剔除自店) ────────────────────
function computeMetrics(myPrice, sellers) {
  const prices = (Array.isArray(sellers) ? sellers : [])
    .map((s) => parsePriceText(s?.price))
    .filter((n) => n != null);
  const out = {
    sellerCount: Array.isArray(sellers) ? sellers.length : 0,
    minPrice: prices.length ? Math.min(...prices) : null,
    avgPrice: prices.length ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100 : null,
    medianPrice: null,
    myRank: null,
    isCheapest: null,
    gapAbs: null,
    gapPct: null,
    vsMedian: null,
  };
  if (prices.length) {
    const sorted = [...prices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out.medianPrice =
      sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
  }
  if (myPrice != null && prices.length) {
    // 排名:严格低于我的报价数 + 1(并列时取最好名次)
    out.myRank = prices.filter((p) => p < myPrice).length + 1;
    out.isCheapest = myPrice <= out.minPrice ? 1 : 0;
    out.gapAbs = Math.round((myPrice - out.minPrice) * 100) / 100;
    out.gapPct = out.minPrice > 0 ? Math.round((out.gapAbs / out.minPrice) * 1000) / 10 : null;
    if (out.medianPrice != null) {
      out.vsMedian = myPrice > out.medianPrice ? 'above' : myPrice < out.medianPrice ? 'below' : 'equal';
    }
  }
  return out;
}

// ── GET /admin/api/price-watch/tasks ────────────────────────
// query: ?limit=100&force=1&storeId=
//   仅取 saleable 商品(is_created=1 且 has_stock=1,买家页才有有效报价)
//   24h 内已有 status='ok'/'empty' 快照的 SKU 跳过(force=1 忽略去重)
//   按 product_data_cache.fetched_at 升序(价格缓存最旧的优先,多轮运行自然轮转)
router.get('/admin/api/price-watch/tasks', (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const force = req.query.force === '1' || req.query.force === 'true';
    const storeId = String(req.query.storeId || '').trim();

    const where = [
      "COALESCE(json_extract(data, '$.statuses.is_created'), 0) = 1",
      "COALESCE(json_extract(data, '$.stocks.has_stock'), 0) = 1",
    ];
    const params = [];
    if (storeId) {
      where.push('store_id = ?');
      params.push(storeId);
    }
    if (!force) {
      where.push(
        `sku NOT IN (SELECT sku FROM price_watch_snapshots
                     WHERE status IN ('ok', 'empty')
                       AND fetched_at > datetime('now', '-1 day'))`
      );
    }
    const rows = db
      .prepare(
        `SELECT sku, store_id, fetched_at, data FROM product_data_cache
         WHERE ${where.join(' AND ')}
         ORDER BY fetched_at ASC
         LIMIT ?`
      )
      .all(...params, limit);

    const items = rows.map((r) => {
      let data = null;
      try { data = JSON.parse(r.data); } catch { /* 容错:data 损坏时价格置空 */ }
      return {
        sku: r.sku,
        storeId: r.store_id || '',
        name: data?.name || '',
        myPrice: extractMyPrice(data),
        priceFetchedAt: r.fetched_at,
      };
    });
    // 各店铺最近同步时间(脚本侧打印提醒:缓存过旧会误判优势)
    const syncInfo = db
      .prepare(
        `SELECT store_id AS storeId, MAX(fetched_at) AS lastSyncAt, COUNT(*) AS skuCount
         FROM product_data_cache GROUP BY store_id`
      )
      .all();
    return res.json(ok({ items, syncInfo }));
  } catch (e) {
    logger.warn({ err: e.message }, '[price-watch] tasks failed');
    next(e);
  }
});

// ── POST /admin/api/price-watch/report ──────────────────────
// body: { items: [{ sku, fetchedAt, ok, errorReason?, followSellData?: { count, sellers, source } }] }
// 服务端写入时从 product_data_cache 实时读我的价格并计算对比指标(不信任脚本侧价格)
router.post('/admin/api/price-watch/report', (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, BATCH_LIMIT) : [];
    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items 不能为空' });
    }
    const insertStmt = db.prepare(
      `INSERT INTO price_watch_snapshots
        (sku, store_id, my_price, seller_count, min_price, median_price, avg_price,
         my_rank, is_cheapest, gap_abs, gap_pct, vs_median, sellers,
         status, error_reason, price_fetched_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // 我的价格批量读取(单批 ≤100,两次查询够了)
    const skus = [...new Set(items.map((i) => String(i?.sku || '').trim()).filter(Boolean))];
    const cacheRows = skus.length
      ? db
          .prepare(
            `SELECT sku, store_id, fetched_at, data FROM product_data_cache
             WHERE sku IN (${skus.map(() => '?').join(',')})`
          )
          .all(...skus)
      : [];
    const cacheMap = new Map(cacheRows.map((r) => [r.sku, r]));

    let inserted = 0;
    let skipped = 0;
    db.exec('BEGIN');
    try {
      for (const raw of items) {
        const sku = String(raw?.sku || '').trim();
        if (!/^\d+$/.test(sku)) {
          skipped++;
          continue;
        }
        const fetchedAt = /^\d{4}-\d{2}-\d{2}T/.test(String(raw?.fetchedAt || ''))
          ? String(raw.fetchedAt)
          : new Date().toISOString();
        const cache = cacheMap.get(sku);
        let myPrice = null;
        if (cache) {
          try { myPrice = extractMyPrice(JSON.parse(cache.data)); } catch { /* data 损坏置空 */ }
        }
        const sellers = Array.isArray(raw?.followSellData?.sellers) ? raw.followSellData.sellers : [];
        if (raw?.ok) {
          const m = computeMetrics(myPrice, sellers);
          insertStmt.run(
            sku, cache?.store_id || null, myPrice, m.sellerCount, m.minPrice, m.medianPrice, m.avgPrice,
            m.myRank, m.isCheapest, m.gapAbs, m.gapPct, m.vsMedian,
            JSON.stringify(sellers),
            m.sellerCount > 0 ? 'ok' : 'empty', m.sellerCount > 0 ? null : String(raw.followSellData?.source || 'no-sellers'),
            cache?.fetched_at || null, fetchedAt
          );
        } else {
          insertStmt.run(
            sku, cache?.store_id || null, myPrice, 0, null, null, null,
            null, null, null, null, null, null,
            'error', String(raw?.errorReason || 'unknown').slice(0, 120),
            cache?.fetched_at || null, fetchedAt
          );
        }
        inserted++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return res.json(ok({ inserted, skipped }));
  } catch (e) {
    logger.warn({ err: e.message }, '[price-watch] report failed');
    next(e);
  }
});

// ── GET /admin/api/price-watch/list ─────────────────────────
// 每 SKU 最新一条快照(MAX(id) 代理最新,自增 id 与时间单调一致)
// query: ?currentPage=1&pageSize=20&storeId=&position=&keyword=&gapPctMin=&gapPctMax=
//   position: 'cheapest'(有优势) | 'behind'(无优势) | 'no-follow'(无跟卖)
router.get('/admin/api/price-watch/list', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const where = [];
    const params = [];
    if (req.query.storeId) {
      where.push('s.store_id = ?');
      params.push(String(req.query.storeId));
    }
    if (req.query.keyword) {
      where.push('(s.sku LIKE ? OR s.sellers LIKE ?)');
      const kw = '%' + String(req.query.keyword) + '%';
      params.push(kw, kw);
    }
    if (req.query.position === 'cheapest') {
      where.push("s.is_cheapest = 1");
    } else if (req.query.position === 'behind') {
      where.push("s.status = 'ok' AND s.min_price IS NOT NULL AND COALESCE(s.is_cheapest, 0) = 0");
    } else if (req.query.position === 'no-follow') {
      where.push("(s.status = 'empty' OR COALESCE(s.seller_count, 0) = 0)");
    }
    if (req.query.gapPctMin != null && req.query.gapPctMin !== '') {
      where.push('s.gap_pct >= ?');
      params.push(Number(req.query.gapPctMin));
    }
    if (req.query.gapPctMax != null && req.query.gapPctMax !== '') {
      where.push('s.gap_pct <= ?');
      params.push(Number(req.query.gapPctMax));
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = db
      .prepare(
        `SELECT COUNT(*) AS n FROM price_watch_snapshots s
         JOIN (SELECT sku, MAX(id) AS mid FROM price_watch_snapshots GROUP BY sku) t ON s.id = t.mid
         ${whereSql}`
      )
      .get(...params).n;
    const rows = db
      .prepare(
        `SELECT s.id, s.sku, s.store_id, s.my_price, s.seller_count, s.min_price, s.median_price,
                s.avg_price, s.my_rank, s.is_cheapest, s.gap_abs, s.gap_pct, s.vs_median,
                s.status, s.error_reason, s.price_fetched_at, s.fetched_at,
                json_extract(p.data, '$.offer_id') AS offer_id
         FROM price_watch_snapshots s
         JOIN (SELECT sku, MAX(id) AS mid FROM price_watch_snapshots GROUP BY sku) t ON s.id = t.mid
         LEFT JOIN product_data_cache p ON p.sku = s.sku
         ${whereSql}
         ORDER BY s.fetched_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (current - 1) * pageSize);

    return res.json(ok({ items: rows, total, currentPage: current, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[price-watch] list failed');
    next(e);
  }
});

// ── GET /admin/api/price-watch/detail/:sku ──────────────────
// 返回最新快照(含 sellers 明细)+ 近 N 天历史(不含 sellers,列表轻量化)
router.get('/admin/api/price-watch/detail/:sku', (req, res, next) => {
  try {
    const sku = String(req.params.sku || '').trim();
    if (!/^\d+$/.test(sku)) {
      return res.status(400).json({ ok: false, error: 'sku 非法' });
    }
    const latest = db
      .prepare(
        `SELECT * FROM price_watch_snapshots WHERE sku = ? ORDER BY id DESC LIMIT 1`
      )
      .get(sku);
    if (latest && latest.sellers) {
      try { latest.sellers = JSON.parse(latest.sellers); } catch { latest.sellers = []; }
    }
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const history = db
      .prepare(
        `SELECT id, my_price, seller_count, min_price, median_price, my_rank, is_cheapest,
                gap_abs, gap_pct, vs_median, status, fetched_at
         FROM price_watch_snapshots WHERE sku = ? AND fetched_at >= ? ORDER BY id DESC LIMIT 200`
      )
      .all(sku, since);
    return res.json(ok({ latest: latest || null, history }));
  } catch (e) {
    logger.warn({ err: e.message }, '[price-watch] detail failed');
    next(e);
  }
});

// ── GET /admin/api/price-watch/stats ────────────────────────
// 看板汇总:优势分布 + 我的价格滞后提示(>48h)+ 各店铺缓存同步时间
router.get('/admin/api/price-watch/stats', (req, res, next) => {
  try {
    const dist = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN is_cheapest = 1 THEN 1 ELSE 0 END) AS cheapest,
           SUM(CASE WHEN status = 'ok' AND min_price IS NOT NULL AND COALESCE(is_cheapest, 0) = 0 THEN 1 ELSE 0 END) AS behind,
           SUM(CASE WHEN status = 'empty' OR COALESCE(seller_count, 0) = 0 THEN 1 ELSE 0 END) AS noFollow,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
           SUM(CASE WHEN price_fetched_at IS NOT NULL AND price_fetched_at < datetime('now', '-2 days') THEN 1 ELSE 0 END) AS stalePrice
         FROM price_watch_snapshots s
         JOIN (SELECT sku, MAX(id) AS mid FROM price_watch_snapshots GROUP BY sku) t ON s.id = t.mid`
      )
      .get();
    const syncInfo = db
      .prepare(
        `SELECT store_id AS storeId, MAX(fetched_at) AS lastSyncAt, COUNT(*) AS skuCount
         FROM product_data_cache GROUP BY store_id`
      )
      .all();
    return res.json(ok({ dist, syncInfo }));
  } catch (e) {
    logger.warn({ err: e.message }, '[price-watch] stats failed');
    next(e);
  }
});

// ── 保留期清理(每日一次,默认 30 天) ────────────────────────
let retentionTimer = null;

export function startPriceWatchRetention() {
  if (retentionTimer) return;
  const run = () => {
    try {
      const days = Math.max(1, Number(process.env.PRICE_WATCH_RETENTION_DAYS) || 30);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const r = db.prepare(`DELETE FROM price_watch_snapshots WHERE fetched_at < ?`).run(cutoff);
      if (r.changes > 0) {
        logger.info({ deleted: r.changes, cutoff }, '[price-watch] 保留期清理完成');
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[price-watch] 保留期清理失败');
    }
  };
  // 启动 10 分钟后首次执行(错开启动高峰),此后每日一次
  retentionTimer = setTimeout(() => {
    run();
    retentionTimer = setInterval(run, 24 * 60 * 60 * 1000);
    retentionTimer.unref?.();
  }, 10 * 60 * 1000);
  retentionTimer.unref?.();
}

export function stopPriceWatchRetention() {
  if (retentionTimer) {
    clearTimeout(retentionTimer);
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}

export default router;
