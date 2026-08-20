// 无头 cloakbrowser 浅度采集脚本
// 用 launchPersistentContext 启动 stealth 浏览器,导航到店铺页,
// 在店铺页上下文里逐页 fetch entrypoint-api(API 直取,复用 qx-ozon 插件浅采语义),
// 4 道过滤后写 ozon_shallow_collect_log(source='headless-api')。
//
// 与 backfill-store-stats.js 的差异:
//   - backfill:每店一次 fetch 取 stats(订单数/评论数/评分/开业时长)
//   - 本脚本:每店翻页拉取全部 SKU(价格/评论过滤 + 浅度日志)
//   - backfill 熔断即终止;本脚本熔断后等待 CIRCUIT_BREAKER_WAIT_MS 再断点续采
//
// 用法: node shallow-collect.js
// 可选环境变量(见 .env,命令行/env 优先于 .env):
//   STORE_LIMIT=1 DRY_RUN=1 node shallow-collect.js   # 单店干跑
//   STORE_LIMIT=1 LOG_SKU=1 node shallow-collect.js   # 单店落库 + SKU 逐条日志
//   STORE_LIMIT=10 node shallow-collect.js            # 小批量
//   node shallow-collect.js                           # 全量
// 登录态迁移(跨 Windows/Linux)见 state-transfer.js:
//   node state-transfer.js --export / --import
//
// 设计要点(2026-08 详细设计 v2):
//   - 翻页循环在 Node 侧,每页一次 page.evaluate(200-500ms),
//     进度实时可见、Ctrl+C 可中断、崩溃最多丢 1 页
//   - 熔断恢复:等待 → warmup → 重新导航店铺页 → 从 state.nextPagePath 断点续采
//     (seenSkus 保留,不重复写、不误判空页)
//   - 错误分类:404 = 永久错误直接跳过;403/429/5xx/网络错误 = 临时错误走熔断
//   - DRY_RUN=1 完全只读(不写日志、不写 progress)

import { launchPersistentContext } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 加载(不覆盖已有 process.env,命令行优先) ────────────
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    // 去除成对引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

// 环境变量 → 数值(空/非法 → null 表示不限)
function numOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── 配置 ─────────────────────────────────────────────────────
const cfg = {
  dbPath: process.env.DB_PATH || path.resolve(__dirname, '../erp-backend-lite/data/erp.db'),
  profileDir: path.join(__dirname, '.ozon-profile'),
  progressFile: path.join(__dirname, 'shallow-collect-progress.json'),
  lockFile: path.join(__dirname, '.shallow-collect.lock'),

  // 店铺过滤
  storeSellerIds: (process.env.STORE_SELLER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  storeOnlyMainlandChina: process.env.STORE_ONLY_MAINLAND_CHINA !== '0',
  storeLimit: Number(process.env.STORE_LIMIT) || 0, // 0=不限制
  storeSort: process.env.STORE_SORT || 'lastSeenAt',
  revisitDays: Number(process.env.REVISIT_DAYS) || 0, // 0=done 永久有效

  // 店铺数值过滤(范围,空=不限;数据来自 backfill 回填的统计列)
  storeOrdersMin: numOrNull(process.env.STORE_ORDERS_MIN),
  storeOrdersMax: numOrNull(process.env.STORE_ORDERS_MAX),
  storeReviewsMin: numOrNull(process.env.STORE_REVIEWS_MIN),
  storeReviewsMax: numOrNull(process.env.STORE_REVIEWS_MAX),
  storeRatingMin: numOrNull(process.env.STORE_RATING_MIN),
  storeRatingMax: numOrNull(process.env.STORE_RATING_MAX),
  storeOpenedMonthsMin: numOrNull(process.env.STORE_OPENED_MONTHS_MIN),
  storeOpenedMonthsMax: numOrNull(process.env.STORE_OPENED_MONTHS_MAX),

  // SKU 过滤(4 道过滤,对齐插件浅采)
  skuOnlyWithRating: process.env.SKU_ONLY_WITH_RATING !== '0',
  skuPriceMin: process.env.SKU_PRICE_MIN != null && process.env.SKU_PRICE_MIN !== '' ? Number(process.env.SKU_PRICE_MIN) : null,
  skuPriceMax: process.env.SKU_PRICE_MAX != null && process.env.SKU_PRICE_MAX !== '' ? Number(process.env.SKU_PRICE_MAX) : null,
  skuRatingMin: process.env.SKU_RATING_MIN != null && process.env.SKU_RATING_MIN !== '' ? Number(process.env.SKU_RATING_MIN) : null,
  skuRatingMax: process.env.SKU_RATING_MAX != null && process.env.SKU_RATING_MAX !== '' ? Number(process.env.SKU_RATING_MAX) : null,

  // 引擎
  headless: process.env.HEADLESS !== '0',
  pageIntervalMinMs: Number(process.env.PAGE_INTERVAL_MIN_MS) || 10000,
  pageIntervalMaxMs: Number(process.env.PAGE_INTERVAL_MAX_MS) || 15000,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS) || 15000,
  maxEmptyPages: Number(process.env.MAX_EMPTY_PAGES) || 3,
  maxErrors: Number(process.env.MAX_ERRORS) || 3,

  // 熔断恢复
  circuitBreakerWaitMs: Number(process.env.CIRCUIT_BREAKER_WAIT_MS) || 180000,
  circuitBreakerBackoff: Number(process.env.CIRCUIT_BREAKER_BACKOFF) || 1,
  maxCircuitBreaks: Number(process.env.MAX_CIRCUIT_BREAKS) || 0, // 0=永不放弃(404 永久错误不受此限)

  // 写入
  dryRun: process.env.DRY_RUN === '1',

  // SKU 逐条日志(1=每个 SKU 一行输出重要字段,便于终端/文件排查)
  logSku: process.env.LOG_SKU === '1',

  // 对齐插件链路(仅 passesFilter=1 的 SKU)
  // 写 ozon_dom_cache(card)+ ozon_cache_index 索引聚合(FTS 自动同步)
  writeDomCache: process.env.WRITE_DOM_CACHE !== '0', // 默认开启
  // 入队 collect_queue_tasks(pending,全部入队;由插件 SW 轮询 claim 消费)
  enqueueDepth: process.env.ENQUEUE_DEPTH !== '0', // 默认开启
};

// 配置校验
if (cfg.pageIntervalMinMs > cfg.pageIntervalMaxMs) {
  console.error(`[配置错误] PAGE_INTERVAL_MIN_MS(${cfg.pageIntervalMinMs}) > MAX(${cfg.pageIntervalMaxMs})`);
  process.exit(1);
}
const SORT_COLUMNS = {
  lastSeenAt: 'lastSeenAt',
  ordersCount: 'orders_count',
  reviewsCount: 'reviews_count',
  rating: 'rating',
  openedMonths: 'opened_months',
};
if (!SORT_COLUMNS[cfg.storeSort]) {
  console.error(`[配置错误] STORE_SORT 无效: ${cfg.storeSort}(可选: ${Object.keys(SORT_COLUMNS).join('/')})`);
  process.exit(1);
}

// ── 工具 ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.round(rand(min, max));

// LOG_SKU 定宽输出:名称截断(按 Unicode 码点,最多 n 字符,压平换行)
const truncName = (v, n = 10) => {
  const t = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > n ? chars.slice(0, n).join('') : t;
};
// LOG_SKU 定宽输出:数值右对齐定宽(空值显示 -)
const fmtNum = (v, n) => String(v ?? '-').padStart(n);

// ── 单实例锁(防双开导致 progress 互相覆盖) ──────────────────
function acquireLock() {
  if (existsSync(cfg.lockFile)) {
    let alive = false;
    try {
      const pid = Number(readFileSync(cfg.lockFile, 'utf-8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        // Windows: process.kill(pid, 0) 活着会成功,死了抛 ESRCH
        try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      }
    } catch { /* 读取失败视为死锁 */ }
    if (alive) {
      console.error(`[退出] 已有实例运行(PID ${readFileSync(cfg.lockFile, 'utf-8').trim()}),锁文件: ${cfg.lockFile}`);
      process.exit(1);
    }
    console.log('[锁] 发现残留锁文件(进程已死),覆盖');
  }
  writeFileSync(cfg.lockFile, String(process.pid));
}
function releaseLock() {
  try { unlinkSync(cfg.lockFile); } catch { /* 已删除 */ }
}

// ── SQLite ───────────────────────────────────────────────────
const db = new DatabaseSync(cfg.dbPath);
db.exec('PRAGMA journal_mode = WAL');
// 等待锁最多 5s,避免与后端服务并发写时立即报 database is locked
db.exec('PRAGMA busy_timeout = 5000');

function loadStores(progress) {
  const whereParts = [];
  const params = [];
  if (cfg.storeSellerIds.length > 0) {
    whereParts.push(`sellerId IN (${cfg.storeSellerIds.map(() => '?').join(',')})`);
    params.push(...cfg.storeSellerIds);
  } else {
    if (cfg.storeOnlyMainlandChina) {
      whereParts.push('isMainlandChina = 1');
    }
  }

  // 数值范围过滤(orders_count/reviews_count/rating/opened_months;NULL 值被范围条件排除)
  const applyRange = (col, min, max) => {
    if (min != null) { whereParts.push(`${col} >= ?`); params.push(min); }
    if (max != null) { whereParts.push(`${col} <= ?`); params.push(max); }
  };
  applyRange('orders_count', cfg.storeOrdersMin, cfg.storeOrdersMax);
  applyRange('reviews_count', cfg.storeReviewsMin, cfg.storeReviewsMax);
  applyRange('rating', cfg.storeRatingMin, cfg.storeRatingMax);
  applyRange('opened_months', cfg.storeOpenedMonthsMin, cfg.storeOpenedMonthsMax);

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const sql = `
    SELECT sellerId, sellerSlug
    FROM ozon_store_classification
    ${where}
    ORDER BY ${SORT_COLUMNS[cfg.storeSort]} DESC
  `;
  let rows = db.prepare(sql).all(...params);
  rows = rows.filter((r) => r.sellerId && /^\d+$/.test(String(r.sellerId)));

  // 断点续传:排除已完成(REVISIT_DAYS=0 永久有效;>0 时 N 天后重采)
  const now = Date.now();
  const pending = rows.filter((r) => {
    const d = progress.done?.[String(r.sellerId)];
    if (!d) return true;
    if (cfg.revisitDays <= 0) return false;
    return now - new Date(d.at).getTime() > cfg.revisitDays * 24 * 3600 * 1000;
  });
  if (cfg.storeLimit > 0) return pending.slice(0, cfg.storeLimit);
  return pending;
}

// 每页 flush:三链路写入(对齐插件 ozon-data-panel.js onCardExtracted)
//   ① 浅度日志(全部 SKU,含过滤不通过) → ozon_shallow_collect_log
//   ② dom card 缓存(仅通过) → ozon_dom_cache(只动 card,不碰 detail;同 domDao.upsertCard)
//   ③ 深度采集队列入队(仅通过) → collect_queue_tasks(pending;同 queueDao.submit,全部入队)
//   ④ 索引聚合(仅通过) → ozon_cache_index(轻量版 syncSku;FTS 由触发器自动同步)
// 全程单事务:崩溃时要么全写要么全不写
const insertLogStmt = db.prepare(
  `INSERT INTO ozon_shallow_collect_log
   (sku, sellerSlug, sellerId, name, price, ratingCount, imageUrl,
    passesFilter, skipReason, source, collectedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const upsertDomCardStmt = db.prepare(
  `INSERT INTO ozon_dom_cache (_id, card_data, card_fetched_at, updated_at)
   VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT(_id) DO UPDATE SET
     card_data = excluded.card_data,
     card_fetched_at = excluded.card_fetched_at,
     updated_at = datetime('now')`
);
const enqueueTaskStmt = db.prepare(
  `INSERT INTO collect_queue_tasks
   (sku, sellerSlug, sellerId, domInfo, status, attempts, lastError,
    startedAt, finishedAt, steps, forceRefresh, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, 0, ?, ?)
   ON CONFLICT(sku) DO UPDATE SET
     sellerSlug = excluded.sellerSlug,
     sellerId = excluded.sellerId,
     domInfo = excluded.domInfo,
     status = excluded.status,
     attempts = excluded.attempts,
     updatedAt = excluded.updatedAt`
);
const upsertIndexStmt = db.prepare(
  `INSERT INTO ozon_cache_index (
     sku, card_hit, card_fetched_at, detail_hit, detail_fetched_at,
     search_hit, search_fetched_at, bundle_hit, bundle_fetched_at,
     rich_media_hit, rich_media_fetched_at,
     market_stats_hit, market_stats_fetched_at, market_stats_empty,
     follow_sell_hit, follow_sell_fetched_at,
     hit_count, last_fetched_at,
     name, price, price_value, primary_image, url, rating_count,
     has_video, has_rich_content, market_price_p50, competitor_count,
     seller_slug, seller_id, seller_name,
     description_category_id, type_id, category_name,
     weight_g, dim_sum_mm,
     description_quality,
     listed, searchable_text, updated_at
   ) VALUES (
     ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')
   )
   ON CONFLICT(sku) DO UPDATE SET
     card_hit=excluded.card_hit, card_fetched_at=excluded.card_fetched_at,
     detail_hit=excluded.detail_hit, detail_fetched_at=excluded.detail_fetched_at,
     search_hit=excluded.search_hit, search_fetched_at=excluded.search_fetched_at,
     bundle_hit=excluded.bundle_hit, bundle_fetched_at=excluded.bundle_fetched_at,
     rich_media_hit=excluded.rich_media_hit, rich_media_fetched_at=excluded.rich_media_fetched_at,
     market_stats_hit=excluded.market_stats_hit, market_stats_fetched_at=excluded.market_stats_fetched_at,
     market_stats_empty=excluded.market_stats_empty,
     follow_sell_hit=excluded.follow_sell_hit, follow_sell_fetched_at=excluded.follow_sell_fetched_at,
     hit_count=excluded.hit_count, last_fetched_at=excluded.last_fetched_at,
     name=excluded.name, price=excluded.price, price_value=excluded.price_value,
     primary_image=excluded.primary_image,
     url=excluded.url, rating_count=excluded.rating_count,
     has_video=excluded.has_video, has_rich_content=excluded.has_rich_content,
     market_price_p50=excluded.market_price_p50,
     competitor_count=excluded.competitor_count,
     description_quality=excluded.description_quality,
     seller_slug=COALESCE(ozon_cache_index.seller_slug, excluded.seller_slug),
     seller_id=COALESCE(ozon_cache_index.seller_id, excluded.seller_id),
     seller_name=COALESCE(ozon_cache_index.seller_name, excluded.seller_name),
     description_category_id=COALESCE(excluded.description_category_id, ozon_cache_index.description_category_id),
     type_id=COALESCE(excluded.type_id, ozon_cache_index.type_id),
     category_name=COALESCE(excluded.category_name, ozon_cache_index.category_name),
     weight_g=excluded.weight_g, dim_sum_mm=excluded.dim_sum_mm,
     listed=ozon_cache_index.listed,
     searchable_text=excluded.searchable_text,
     updated_at=datetime('now')`
);
// syncSkuLite 用预编译查询(7 表主键查,均走索引)
const qDom = db.prepare(
  `SELECT card_data, card_fetched_at, detail_data, detail_fetched_at FROM ozon_dom_cache WHERE _id=?`
);
const qAttr = db.prepare(
  `SELECT search_data, search_fetched_at, bundle_data, bundle_fetched_at FROM ozon_attribute_cache WHERE _id=?`
);
const qRm = db.prepare(`SELECT data, fetchedAt FROM ozon_rich_media_cache WHERE _id=?`);
const qMs = db.prepare(`SELECT data, fetchedAt FROM ozon_market_stats_cache WHERE _id=?`);
const qFs = db.prepare(`SELECT data, fetchedAt FROM ozon_follow_sell_cache WHERE _id=?`);
const qIdxExisting = db.prepare(
  `SELECT seller_slug, seller_id, seller_name, listed FROM ozon_cache_index WHERE sku=?`
);

// JSON 解析(对齐 index-dao.js parseJson)
function parseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// 描述质量分级(对齐 erp-backend-lite/src/utils/description-quality.js 同口径)
const DESC_UI_CHROME_RE = /(читать далее|показать полностью|свернуть описание|развернуть описание)/gi;
const DESC_LOAD_FAIL_RE = /(не удалось загрузить|ошибка загрузки|попробуйте (обновить|позже)|failed to load)/i;
function classifyDescriptionQuality(descRaw) {
  if (!descRaw) return 0;
  const cleaned = String(descRaw).replace(DESC_UI_CHROME_RE, ' ').trim();
  if (!cleaned || DESC_LOAD_FAIL_RE.test(cleaned)) return 1;
  if (DESC_UI_CHROME_RE.test(String(descRaw))) return 2;
  return 3;
}

// 价格字符串 → 数字(对齐 index-dao.js parsePriceValue)
function parsePriceValue(price) {
  if (price == null || price === '') return null;
  const cleaned = String(price).replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 索引聚合轻量版(对齐 index-dao.js syncSku 的必要部分):
// 读 7 张缓存表 → 计算命中位/冗余字段 → upsert ozon_cache_index
// 差异(有意简化,不影响正确性):
//   - sv shape 合成省略:直接在 search/bundle 的 attributes 里找 attr 4180(商品名)
//   - listed/exported 系列不碰(由跟卖/导出任务维护)
//   - seller_name 由后端 index-sync 定时任务(5 分钟)补齐
function syncSkuLite(sku) {
  const [dom, attr, rm, ms, fs] = [qDom.get(sku), qAttr.get(sku), qRm.get(sku), qMs.get(sku), qFs.get(sku)];

  const cardHit = dom?.card_data ? 1 : 0;
  const detailHit = dom?.detail_data ? 1 : 0;
  const searchHit = attr?.search_data ? 1 : 0;
  const bundleHit = attr?.bundle_data ? 1 : 0;
  const rmHit = rm?.data ? 1 : 0;
  const msHit = ms?.data ? 1 : 0;
  const fsHit = fs?.data ? 1 : 0;
  const hitCount = cardHit + detailHit + searchHit + bundleHit + rmHit + msHit + fsHit;

  const cardData = parseJson(dom?.card_data);
  const detailData = parseJson(dom?.detail_data);
  const attrData = parseJson(attr?.search_data);
  const bundleData = parseJson(attr?.bundle_data);
  const rmData = parseJson(rm?.data);
  const msData = parseJson(ms?.data);
  const msEmpty = msHit && msData?.__empty ? 1 : 0;
  const fsData = parseJson(fs?.data);

  // name fallback 链: bundle attr4180 → search attr4180 → detail.title → card.name
  const searchItem =
    attrData && Array.isArray(attrData.items) && attrData.items.length > 0 ? attrData.items[0] : null;
  const bAttr4180 = bundleData?.attributes?.find((a) => String(a.attribute_id) === '4180');
  const sAttr4180 = searchItem?.attributes?.find((a) => String(a.attribute_id) === '4180');
  const name =
    bAttr4180?.values?.[0]?.value ||
    sAttr4180?.values?.[0]?.value ||
    detailData?.title ||
    cardData?.name ||
    '';

  const price = detailData?.price || cardData?.price || '';
  const priceValue = parsePriceValue(price);
  const primaryImage = cardData?.image || detailData?.images?.[0] || '';
  const url = cardData?.url || '';
  const ratingCount = Number.isFinite(Number(cardData?.ratingCount))
    ? Number(cardData?.ratingCount)
    : Number.isFinite(Number(detailData?.reviewCount))
      ? Number(detailData?.reviewCount)
      : null;
  const hasVideo = rmData?.mp4 ? 1 : 0;
  const hasRichContent = rmData?.richContent && String(rmData.richContent).length > 0 ? 1 : 0;
  const descriptionQuality = classifyDescriptionQuality(rmData?.description || '');
  const marketPriceP50 = msData?.priceP50 ?? msData?.p50 ?? null;
  const competitorCount =
    Array.isArray(fsData?.sellers)
      ? fsData.sellers.length
      : Array.isArray(fsData?.competitors)
        ? fsData.competitors.length
        : null;

  // 类目信息:search_data(优先) → bundle_data(fallback)
  let descriptionCategoryId = null;
  let typeId = null;
  if (searchItem) {
    const sTi = Number(searchItem.description_type_dict_value);
    if (Number.isFinite(sTi) && sTi > 0) typeId = sTi;
    if (Array.isArray(searchItem.categories)) {
      const lvl3 = searchItem.categories.find((c) => c && Number(c.level) === 3);
      if (lvl3 && Number.isFinite(Number(lvl3.id)) && Number(lvl3.id) > 0) {
        descriptionCategoryId = Number(lvl3.id);
      } else {
        const sorted = [...searchItem.categories]
          .filter((c) => c && Number.isFinite(Number(c.id)))
          .sort((a, b) => Number(b.level || 0) - Number(a.level || 0));
        if (sorted.length > 0 && Number(sorted[0].id) > 0) descriptionCategoryId = Number(sorted[0].id);
      }
    }
  }
  if ((descriptionCategoryId === null || typeId === null) && bundleData && typeof bundleData === 'object') {
    if (descriptionCategoryId === null) {
      const bDci = Number(bundleData.description_category_id);
      if (Number.isFinite(bDci) && bDci > 0) descriptionCategoryId = bDci;
    }
    if (typeId === null) {
      const bTi = Number(bundleData.type_id);
      if (Number.isFinite(bTi) && bTi > 0) typeId = bTi;
    }
  }
  const categoryName = detailData?.category || null;

  // 超轻小件冗余字段(bundle 顶层物理字段)
  const rawWeight = Number(bundleData?.weight);
  const weightG = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : null;
  const rawDepth = Number(bundleData?.depth);
  const rawWidth = Number(bundleData?.width);
  const rawHeight = Number(bundleData?.height);
  const dimSumMm =
    Number.isFinite(rawDepth) && rawDepth > 0 &&
      Number.isFinite(rawWidth) && rawWidth > 0 &&
      Number.isFinite(rawHeight) && rawHeight > 0
      ? rawDepth + rawWidth + rawHeight
      : null;

  // 全文搜索字段(seller_name 先读现有值,后端定时任务负责补齐)
  const existing = qIdxExisting.get(sku);
  const sellerSlug = existing?.seller_slug || '';
  const sellerId = existing?.seller_id || '';
  const sellerName = existing?.seller_name || '';
  const listed = existing?.listed || 0;
  const searchableText = [name, sku, sellerName].filter(Boolean).join(' ');

  // last_fetched_at:7 类 fetchedAt 的最大值
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

  upsertIndexStmt.run(
    sku,
    cardHit, dom?.card_fetched_at || null,
    detailHit, dom?.detail_fetched_at || null,
    searchHit, attr?.search_fetched_at || null,
    bundleHit, attr?.bundle_fetched_at || null,
    rmHit, rm?.fetchedAt || null,
    msHit, ms?.fetchedAt || null,
    msEmpty,
    fsHit, fs?.fetchedAt || null,
    hitCount,
    lastFetchedAt,
    name, price, priceValue, primaryImage, url, ratingCount,
    hasVideo, hasRichContent, marketPriceP50, competitorCount,
    sellerSlug, sellerId, sellerName,
    descriptionCategoryId, typeId, categoryName,
    weightG, dimSumMm,
    descriptionQuality,
    listed,
    searchableText
  );
}

// 每页 flush 主入口
// 注:node:sqlite 的 DatabaseSync 无 transaction() 方法(better-sqlite3 才有),
//     手动 BEGIN IMMEDIATE / COMMIT / ROLLBACK 实现
function flushLogs(logs, store) {
  if (logs.length === 0) return;
  if (cfg.dryRun) {
    console.log(`    [DRY_RUN] 跳过写入 ${logs.length} 条`);
    return;
  }
  const now = new Date().toISOString();
  const passed = logs.filter((s) => s.passesFilter);

  const writeAll = () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      // ① 浅度日志(全部)
      for (const s of logs) {
        insertLogStmt.run(
          s.sku, store.sellerSlug ?? null, String(store.sellerId),
          s.name ?? null,
          s.price != null ? Number(s.price) : null,
          s.ratingCount != null ? Number(s.ratingCount) : null,
          s.imageUrl ?? null,
          s.passesFilter ? 1 : 0,
          s.skipReason ?? null,
          'headless-api',
          now
        );
      }
      // ②③④ dom 缓存 + 深度队列入队 + 索引聚合(仅通过过滤的)
      for (const s of passed) {
        if (cfg.writeDomCache) {
          upsertDomCardStmt.run(
            s.sku,
            JSON.stringify({
              sku: s.sku,
              url: s.url || '',
              name: s.name || '',
              price: s.price != null ? Number(s.price) : null,
              image: s.imageUrl || '',
              ratingCount: s.ratingCount ?? null,
              source: 'api',
            }),
            now
          );
        }
        if (cfg.enqueueDepth) {
          enqueueTaskStmt.run(
            s.sku,
            store.sellerSlug ?? null,
            String(store.sellerId),
            JSON.stringify({
              title: s.name || '',
              price: s.price != null ? Number(s.price) : null,
              imageUrl: s.imageUrl || '',
              ratingCount: s.ratingCount ?? null,
            }),
            now, now
          );
        }
        if (cfg.writeDomCache) {
          syncSkuLite(s.sku); // 索引聚合依赖 dom card,仅开缓存时执行
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw e;
    }
  };
  // 写入带 1 次重试(与 backfill updateStats 一致)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeAll();
      break;
    } catch (e) {
      if (e.code === 'ERR_SQLITE_ERROR' && attempt === 0) {
        const start = Date.now();
        while (Date.now() - start < 200) { } // 忙等 200ms 后重试一次
        continue;
      }
      throw e;
    }
  }
}

// ── 断点续传 progress(带时间戳对象结构,支持 REVISIT_DAYS 重采) ──
function loadProgress() {
  if (!existsSync(cfg.progressFile)) return { done: {}, failed: {}, lastRunAt: null };
  try {
    const p = JSON.parse(readFileSync(cfg.progressFile, 'utf-8'));
    // 兼容 backfill 风格的数组 done(误用时转为空)
    if (Array.isArray(p.done)) return { done: {}, failed: {}, lastRunAt: p.lastRunAt ?? null };
    return { done: p.done || {}, failed: p.failed || {}, lastRunAt: p.lastRunAt ?? null };
  } catch {
    return { done: {}, failed: {}, lastRunAt: null };
  }
}
function saveProgress(progress) {
  progress.lastRunAt = new Date().toISOString();
  if (cfg.dryRun) return; // 干跑不落盘
  writeFileSync(cfg.progressFile, JSON.stringify(progress, null, 2));
}

// ── 4 道过滤(Node 侧,对齐 ozon-data-panel.js API 直取模式) ──
function applyFilter(card) {
  // 1. "仅抓有评论":开启时跳过 ratingCount=0/null
  const passesOnlyWithRating = !cfg.skuOnlyWithRating || !!card.ratingCount;

  // 2+3. 价格范围 + 评论数范围
  let passesRange = true;
  let skipReason = null;
  if (!passesOnlyWithRating) {
    skipReason = 'no-rating';
  } else {
    const p = Number(card.price);
    const r = Number(card.ratingCount);
    if (Number.isFinite(p)) {
      if (cfg.skuPriceMin != null && p < cfg.skuPriceMin) { passesRange = false; skipReason = 'price-below-min'; }
      else if (cfg.skuPriceMax != null && p > cfg.skuPriceMax) { passesRange = false; skipReason = 'price-above-max'; }
    } else if (cfg.skuPriceMin != null || cfg.skuPriceMax != null) {
      passesRange = false; skipReason = 'price-invalid';
    }
    if (passesRange && Number.isFinite(r)) {
      if (cfg.skuRatingMin != null && r < cfg.skuRatingMin) { passesRange = false; skipReason = 'rating-below-min'; }
      else if (cfg.skuRatingMax != null && r > cfg.skuRatingMax) { passesRange = false; skipReason = 'rating-above-max'; }
    }
  }
  return { passesFilter: passesOnlyWithRating && passesRange, skipReason };
}

// ── 注入函数:单页 fetch + 解析(独立无闭包,每次 evaluate 200-500ms) ──
// 逻辑对齐 qx-ozon/collect/content/api-scroller.js(_extractCardFromItem/_parseEntryResponse/_rewritePath/_fetchEntryPage)
const FETCH_PAGE_FN = async ({ path, timeoutMs }) => {
  const BASE = 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=';

  // 从 tileGridDesktop item 提取 card 字段(对齐 api-scroller _extractCardFromItem)
  const extractCardFromItem = (item) => {
    let name = '';
    let price = null;
    let originalPrice = null;
    let rating = null;
    let ratingCount = null;

    for (const st of item.mainState || []) {
      // 商品名: textDS + automatizationId='tile-name'
      if (st.type === 'textDS' && st.textDS?.testInfo?.automatizationId === 'tile-name') {
        name = st.textDS.text || '';
      }
      // 价格: priceV2.price 数组,PRICE=售价,ORIGINAL_PRICE=划线价
      if (st.type === 'priceV2' && Array.isArray(st.priceV2?.price)) {
        for (const p of st.priceV2.price) {
          const m = String(p.text || '').match(/([\d.,]+)/);
          if (!m) continue;
          const n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
          if (!isFinite(n)) continue;
          if (p.textStyle === 'PRICE') price = n;
          else if (p.textStyle === 'ORIGINAL_PRICE') originalPrice = n;
        }
      }
      // 评分 + 评论数: labelListV2.items 中找特定 icon
      if (st.type === 'labelListV2' && Array.isArray(st.labelListV2?.items)) {
        const labelItems = st.labelListV2.items;
        for (let i = 0; i < labelItems.length; i++) {
          const it = labelItems[i];
          if (it.type === 'icon' && it.icon?.icon?.icon === 'ic_s_star_filled_compact') {
            const next = labelItems[i + 1];
            if (next?.type === 'text') rating = next.text.text || null;
          }
          if (it.type === 'icon' && it.icon?.icon?.icon === 'ic_s_dialog_filled_compact') {
            const next = labelItems[i + 1];
            if (next?.type === 'text') {
              const m = String(next.text.text || '').match(/(\d+)/);
              if (m) ratingCount = parseInt(m[1], 10);
            }
          }
        }
      }
    }

    // 图片: tileImage.items[0].image.link
    let imageUrl = '';
    const imgItems = item.tileImage?.items || [];
    if (imgItems.length > 0 && imgItems[0].image?.link) {
      imageUrl = imgItems[0].image.link;
    }

    return {
      sku: String(item.sku || ''),
      name,
      price,
      originalPrice,
      rating,
      ratingCount,
      imageUrl,
      url: item.action?.link || '',
    };
  };

  // 从 entrypoint-api 响应提取 items + nextPage + sellerId
  const parseEntryResponse = (data) => {
    if (!data || !data.widgetStates) {
      return { items: [], nextPage: null, sellerId: null };
    }
    const tileGridKey = Object.keys(data.widgetStates).find((k) => k.startsWith('tileGridDesktop'));
    let items = [];
    if (tileGridKey) {
      try {
        const state = JSON.parse(data.widgetStates[tileGridKey]);
        items = Array.isArray(state.items) ? state.items : [];
      } catch { /* 解析失败按空页处理 */ }
    }
    let nextPage = data.nextPage || null;
    const pagKey = Object.keys(data.widgetStates).find((k) => k.startsWith('infiniteVirtualPaginator'));
    if (pagKey) {
      try {
        const pag = JSON.parse(data.widgetStates[pagKey]);
        if (pag.nextPage) nextPage = pag.nextPage;
      } catch { /* 忽略 */ }
    }
    const sellerId = data.pageInfo?.analyticsInfo?.sellerId || null;
    return { items, nextPage, sellerId };
  };

  // 重写 path 的 query 参数:去 sorting 加 sorting=discount、去 __rr
  // (path 来自 Ozon 返回的 nextPage,作为字面量拼进顶层 URL,不 encodeURIComponent)
  const rewritePath = (p) => {
    if (!p) return p;
    const qIdx = p.indexOf('?');
    if (qIdx < 0) return p + '?sorting=discount';
    const pathname = p.slice(0, qIdx);
    let search = p.slice(qIdx + 1);
    search = search.replace(/(^|&)sorting=[^&]*/g, '').replace(/^&/, '');
    search = search.replace(/(^|&)__rr=[^&]*/g, '').replace(/^&/, '');
    search = search ? 'sorting=discount&' + search : 'sorting=discount';
    return pathname + '?' + search;
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
    let resp;
    try {
      resp = await fetch(BASE + rewritePath(path), {
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return { error: `HTTP ${resp.status}`, status: resp.status };
    const data = await resp.json();
    const { items, nextPage, sellerId } = parseEntryResponse(data);
    const cards = [];
    for (const item of items) {
      const card = extractCardFromItem(item);
      if (card.sku) cards.push(card);
    }
    return {
      cards,
      nextPage: nextPage || null,
      sellerId: sellerId ? String(sellerId) : null,
      error: null,
    };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
};

// ── 错误分类:404=永久(跳过该店),其余=临时(熔断重试) ──────────
function isPermanentError(r) {
  return r?.status === 404 || /HTTP 404/.test(String(r?.error || ''));
}

// ── 浏览器 ───────────────────────────────────────────────────
let browser = null;
let interrupted = false;

async function launchBrowser() {
  browser = await launchPersistentContext({
    userDataDir: cfg.profileDir,
    headless: cfg.headless,
  });
  return browser;
}

// 访问 ozon.ru 首页:过反爬挑战 + 建立/刷新 cookie(带健康探测)
async function warmup(page) {
  await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000); // 给 cloakbrowser stealth 时间通过反爬挑战
  const title = await page.title();
  console.log(`    warmup: 首页标题 "${(title || '').slice(0, 50)}"`);
  return title;
}

// ── Node 侧单店翻页循环(state 跨熔断持久) ───────────────────
async function collectStore(page, store, state) {
  while (state.nextPagePath && !interrupted) {
    const r = await page.evaluate(FETCH_PAGE_FN, {
      path: state.nextPagePath,
      timeoutMs: cfg.requestTimeoutMs,
    });

    // 错误分类与熔断判定
    if (r.error) {
      if (isPermanentError(r)) {
        return { outcome: 'skip', reason: r.error };
      }
      state.consecutiveErrors++;
      if (state.consecutiveErrors >= cfg.maxErrors) {
        return { outcome: 'circuit-break', error: r.error };
      }
      console.log(`    页失败(${state.consecutiveErrors}/${cfg.maxErrors}): ${r.error},退避重试`);
      await sleep(Math.min(5000, 1000 * state.consecutiveErrors));
      continue;
    }
    state.consecutiveErrors = 0;
    state.pages++;

    // 过滤 + 去重(Node 侧)
    let newCount = 0;
    let passedCount = 0;
    const logs = [];
    for (const card of r.cards) {
      const skuStr = String(card.sku);
      if (state.seenSkus.has(skuStr)) continue;
      state.seenSkus.add(skuStr);
      newCount++;
      const { passesFilter, skipReason } = applyFilter(card);
      if (passesFilter) passedCount++;

      // LOG_SKU=1:每个 SKU 一行,定宽对齐(名称最多 10 字符,数值右对齐)
      if (cfg.logSku) {
        const name = truncName(card.name, 10) || '-';
        console.log(
          `      ${skuStr.padEnd(10)} | ${name.padEnd(10)} | ${fmtNum(card.price, 8)} | ${fmtNum(card.rating, 6)} | ${fmtNum(card.ratingCount, 7)} | ${passesFilter ? 'PASS' : `SKIP(${skipReason})`}`
        );
      }

      logs.push({
        sku: skuStr,
        name: card.name,
        price: card.price,
        ratingCount: card.ratingCount,
        imageUrl: card.imageUrl,
        url: card.url,
        passesFilter,
        skipReason,
      });
    }
    flushLogs(logs, store);

    // 终止判定
    state.nextPagePath = r.nextPage;
    state.consecutiveEmptyPages = newCount === 0 ? state.consecutiveEmptyPages + 1 : 0;

    console.log(
      `    第${state.pages}页: ${r.cards.length} SKU(新 ${newCount},过 ${passedCount}),累计 ${state.seenSkus.size}` +
      (r.nextPage ? '' : ',已到最后一页') +
      (newCount === 0 ? `,空页(${state.consecutiveEmptyPages}/${cfg.maxEmptyPages})` : '')
    );

    if (!r.nextPage || state.consecutiveEmptyPages >= cfg.maxEmptyPages) {
      return { outcome: 'done', skuCount: state.seenSkus.size, passedCount, pages: state.pages };
    }

    // ★ 页间节流:10-15s 随机(反爬拟人化)
    await sleep(randInt(cfg.pageIntervalMinMs, cfg.pageIntervalMaxMs));
  }
  // interrupted:不标记 done(已写页已落库,重跑时该店重新采集会重复写日志,
  // 但浅度日志按 SKU+时间追加是正常语义,可接受)
  return { outcome: 'interrupted', skuCount: state.seenSkus.size, pages: state.pages };
}

// ── main ─────────────────────────────────────────────────────
async function main() {
  console.log('=== 无头浅度采集(API 直取) ===');
  console.log(`DB:        ${cfg.dbPath}`);
  console.log(`Profile:   ${cfg.profileDir}`);
  console.log(`无头:      ${cfg.headless}  干跑: ${cfg.dryRun}`);
  console.log(`页间隔:    ${cfg.pageIntervalMinMs}-${cfg.pageIntervalMaxMs}ms 随机`);
  console.log(`熔断等待:  ${cfg.circuitBreakerWaitMs}ms(退避系数 ${cfg.circuitBreakerBackoff})`);
  console.log(`SKU过滤:   仅有评论=${cfg.skuOnlyWithRating}, 价格=[${cfg.skuPriceMin ?? '-'},${cfg.skuPriceMax ?? '-'}], 评论数=[${cfg.skuRatingMin ?? '-'},${cfg.skuRatingMax ?? '-'}]`);
  console.log(`SKU逐条日志: ${cfg.logSku ? '开启(LOG_SKU=1)' : '关闭'}`);
  // 店铺数值过滤(仅显示已配置的)
  const storeRanges = [
    ['订单数', cfg.storeOrdersMin, cfg.storeOrdersMax],
    ['评论数', cfg.storeReviewsMin, cfg.storeReviewsMax],
    ['评分', cfg.storeRatingMin, cfg.storeRatingMax],
    ['开业月数', cfg.storeOpenedMonthsMin, cfg.storeOpenedMonthsMax],
  ].filter(([, min, max]) => min != null || max != null)
    .map(([label, min, max]) => `${label}=[${min ?? '-'},${max ?? '-'}]`);
  console.log(`店铺过滤:   仅大陆=${cfg.storeOnlyMainlandChina}${storeRanges.length ? ', ' + storeRanges.join(', ') : ''}`);
  console.log(`链路对齐:   dom缓存=${cfg.writeDomCache ? '开' : '关'}, 深度入队=${cfg.enqueueDepth ? '开' : '关'}`);

  acquireLock();

  const progress = loadProgress();

  // Ctrl+C 优雅退出:保存进度 + 关浏览器(最多丢当前页)
  process.on('SIGINT', () => {
    if (interrupted) process.exit(1); // 二次 Ctrl+C 强制退出
    interrupted = true;
    console.log('\n[中断] 收到 SIGINT,正在保存进度并退出...');
    try { saveProgress(progress); } catch { /* 忽略 */ }
    releaseLock();
    browser?.close?.().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });

  // 1. 启动浏览器
  console.log('\n[1/4] 启动 stealth 浏览器...');
  await launchBrowser();
  const page = await browser.newPage();
  await warmup(page);

  // 2. 查询待采店铺
  console.log('\n[2/4] 查询待采店铺...');
  const stores = loadStores(progress);
  const doneCount = Object.keys(progress.done).length;
  console.log(`[2/4] 累计已完成 ${doneCount} 个,本批待处理 ${stores.length} 个`);
  if (stores.length === 0) {
    console.log('\n全部完成,无需处理。');
    await browser.close();
    releaseLock();
    return;
  }

  // 3. 逐店采集
  console.log(`\n[3/4] 开始采集...`);
  let success = 0, skipped = 0, failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < stores.length && !interrupted; i++) {
    const store = stores[i];
    const idx = i + 1;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[${idx}/${stores.length}] sellerId=${store.sellerId} (${elapsed}s) ...`);

    // 导航店铺页(在店铺页上下文 fetch 才是真实用户行为 — 项目铁律)
    let navResp = null;
    try {
      navResp = await page.goto(`https://www.ozon.ru/seller/${store.sellerId}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
      await page.waitForTimeout(3000); // 反爬挑战 + __NUXT__ 挂载
    } catch (e) {
      console.log(`    导航失败: ${e.message}`);
    }

    // 导航 404 = 店铺已注销,永久跳过
    if (navResp?.status() === 404) {
      console.log('    404 店铺不存在,跳过');
      progress.failed[String(store.sellerId)] = { error: 'store-not-found', at: new Date().toISOString() };
      saveProgress(progress);
      skipped++;
      continue;
    }

    const state = {
      nextPagePath: `/seller/${store.sellerId}/`,
      seenSkus: new Set(),
      consecutiveErrors: 0,
      consecutiveEmptyPages: 0,
      pages: 0,
    };
    let breakCount = 0;

    // SKU 逐条日志:输出列表头(与每行字段定宽一致)
    if (cfg.logSku) {
      console.log(`      ${'sku'.padEnd(10)} | ${'name'.padEnd(10)} | ${'price'.padStart(8)} | ${'rating'.padStart(6)} | ${'reviews'.padStart(7)} | result`);
    }

    // 单店循环(含熔断恢复)
    while (!interrupted) {
      const result = await collectStore(page, store, state);

      if (result.outcome === 'interrupted') {
        console.log(`    被中断(已采 ${result.skuCount} SKU / ${result.pages} 页,不标记完成)`);
        break;
      }
      if (result.outcome === 'done') {
        progress.done[String(store.sellerId)] = {
          at: new Date().toISOString(),
          skuCount: result.skuCount,
          pages: result.pages,
        };
        delete progress.failed[String(store.sellerId)];
        saveProgress(progress);
        success++;
        console.log(`    OK  共 ${result.skuCount} SKU / ${result.pages} 页`);
        break;
      }
      if (result.outcome === 'skip') {
        console.log(`    跳过(永久错误): ${result.reason}`);
        progress.failed[String(store.sellerId)] = { error: result.reason, at: new Date().toISOString() };
        saveProgress(progress);
        skipped++;
        break;
      }

      // outcome === 'circuit-break':熔断 ≠ 失败,等待后断点续采
      breakCount++;
      if (cfg.maxCircuitBreaks > 0 && breakCount >= cfg.maxCircuitBreaks) {
        console.log(`    连续熔断 ${breakCount} 次(达上限),放弃此店: ${result.error}`);
        progress.failed[String(store.sellerId)] = { error: `circuit-break x${breakCount}: ${result.error}`, at: new Date().toISOString() };
        saveProgress(progress);
        failed++;
        break;
      }
      const waitMs = Math.round(cfg.circuitBreakerWaitMs * (cfg.circuitBreakerBackoff ** (breakCount - 1)));
      console.log(`    熔断(#${breakCount}): ${result.error}`);
      console.log(`    等待 ${Math.round(waitMs / 1000)}s 后断点续采(已采 ${state.seenSkus.size} SKU / ${state.pages} 页)...`);
      const waitStart = Date.now();
      while (Date.now() - waitStart < waitMs && !interrupted) {
        await sleep(1000);
      }
      if (interrupted) break;

      // 恢复:重新 warmup 刷 cookie → 重新导航店铺页 → 从断点续采
      try {
        await warmup(page);
        await page.goto(`https://www.ozon.ru/seller/${store.sellerId}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 25000,
        });
        await page.waitForTimeout(3000);
      } catch (e) {
        console.log(`    恢复导航失败: ${e.message}`);
      }
      state.consecutiveErrors = 0;
      state.consecutiveEmptyPages = 0;
      // state.nextPagePath / seenSkus 保留 → 断点续采,不重复不漏采
    }

    // 店铺间隔(与页间隔同款随机,更拟人)
    if (i < stores.length - 1 && !interrupted) {
      await sleep(randInt(cfg.pageIntervalMinMs, cfg.pageIntervalMaxMs));
    }
  }

  // 4. 汇总
  console.log('\n[4/4] 汇总');
  console.log(`  成功: ${success}`);
  console.log(`  跳过: ${skipped}`);
  console.log(`  失败: ${failed}`);
  console.log(`  耗时: ${Math.round((Date.now() - startTime) / 1000)}s`);
  if (interrupted) console.log('  (被中断,进度已保存,重跑即续传)');
  else if (failed > 0 || skipped > 0) console.log('  失败/跳过明细见 shallow-collect-progress.json');

  saveProgress(progress);
  await browser.close();
  db.close();
  releaseLock();
}

main().catch((e) => {
  console.error('\n致命错误:', e);
  releaseLock();
  process.exit(1);
});
