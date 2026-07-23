-- 跟卖任务(对齐 /ozon/products/import 与 import-by-sku)
CREATE TABLE IF NOT EXISTS follow_sell_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id TEXT UNIQUE NOT NULL,
  via_portal    INTEGER DEFAULT 0,
  store_id      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  items_count   INTEGER DEFAULT 0,
  items_preview TEXT,
  ozon_task_id  TEXT,
  bundle_ids    TEXT,
  error_message TEXT,
  strict_skipped TEXT,
  invalid_image  TEXT,
  -- 库存自动同步:任务创建时快照的 defaultStock + 模板 ID(模板修改不影响该任务)
  -- 定时任务 stock-sync.js 据此对 imported 的 items 调 OPI /v2/products/stocks
  stock_snapshot INTEGER DEFAULT 0,
  template_id    INTEGER,
  created_at    TEXT DEFAULT (datetime('now')),
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_fst_status_created ON follow_sell_tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fst_store_created ON follow_sell_tasks(store_id, created_at DESC);

-- 上架记录明细:每个 offer_id 的创建结果(imported/failed/pending/skipped)
-- 由 import/import-info/report 三处写入,供 admin 后台「上架记录」页查看
CREATE TABLE IF NOT EXISTS follow_sell_task_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT NOT NULL,
  offer_id       TEXT NOT NULL,
  name           TEXT,
  price          TEXT,
  product_id     TEXT,
  status         TEXT DEFAULT 'pending', -- pending/imported/failed/skipped
  errors         TEXT,                  -- JSON 数组
  -- 按 errors[].level 计算:有 error 视为审核拒绝(失败),有 warning 视为有警告但成功
  -- 用于 summarizeTaskStatus:imported + has_error=1 计入失败数
  has_error      INTEGER DEFAULT 0,
  has_warning    INTEGER DEFAULT 0,
  -- 库存同步状态:0=未设/待处理, 1=已成功设置, 2=失败/放弃
  -- stock_attempts:OPI /v2/products/stocks 失败重试次数,≥5 不再重试
  stock_set      INTEGER DEFAULT 0,
  stock_attempts INTEGER DEFAULT 0,
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(local_task_id, offer_id)
);
CREATE INDEX IF NOT EXISTS idx_fsti_task ON follow_sell_task_items(local_task_id);
CREATE INDEX IF NOT EXISTS idx_fsti_status ON follow_sell_task_items(status);

-- 收藏
CREATE TABLE IF NOT EXISTS favorites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product    TEXT NOT NULL,
  sku        TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(sku)
);

-- 商品数据缓存
CREATE TABLE IF NOT EXISTS product_data_cache (
  sku        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  store_id   TEXT,
  fetched_at TEXT DEFAULT (datetime('now'))
);

-- 商品属性缓存(/v4/product/info/attributes 与 /v1/product/info/description 原始 JSON)
CREATE TABLE IF NOT EXISTS product_attributes_cache (
  sku              TEXT PRIMARY KEY,
  attributes_data  TEXT NOT NULL,   -- /v4/product/info/attributes 返回的原始 JSON
  description_data TEXT,            -- /v1/product/info/description 返回的原始 JSON
  fetched_at       TEXT DEFAULT (datetime('now'))
);

-- 异步任务状态
CREATE TABLE IF NOT EXISTS async_jobs (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  payload    TEXT,
  result     TEXT,
  error      TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 应用配置(key-value,替代插件端硬编码默认值)
-- scope: extension(价格/库存/开关等) / pricing(汇率/佣金/物流) / watermark(水印模板配置)
CREATE TABLE IF NOT EXISTS app_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,     -- JSON 值(数字/布尔/对象/数组都用 JSON 编码)
  scope       TEXT DEFAULT 'extension',
  description TEXT,
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_config_scope ON app_config(scope);

-- 水印模板(插件 content script 用 Canvas 渲染,后端只存配置)
CREATE TABLE IF NOT EXISTS watermark_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL,  -- JSON: 文字/位置/透明度/字体/颜色等
  is_default  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wm_default ON watermark_templates(is_default);

-- 批量上架任务(P2-1 CRUD + P2-2 均衡分配调度)
-- P2-2 扩展:多店铺均衡分配 + 顺序执行 + 速度控制
--   store_ids:多店铺 JSON 数组(新增);store_id 保留兼容(取 store_ids[0] 或首个目标店铺)
--   speed_config:速度配置 JSON {intervalSec, onFailure}
--   batch_no:业务编号(便于前端展示),name:批次名称
CREATE TABLE IF NOT EXISTS batch_upload_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,
  batch_no       TEXT,                 -- P2-2:业务编号 bat-{timestamp}-{rand}
  name           TEXT,                 -- P2-2:批次名称
  store_id       TEXT NOT NULL,        -- 兼容:首个目标店铺(多店铺场景取 store_ids[0])
  store_ids      TEXT,                 -- P2-2:多店铺 JSON 数组 ["store-yql01-..","store-yql02-.."]
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/PAUSED/SUCCESS/FAILED/PARTIAL
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  skipped_count  INTEGER DEFAULT 0,    -- P2-2:跳过数(已listed/数据不完整)
  config         TEXT,  -- JSON: 模板/库存/水印等配置快照
  speed_config   TEXT,  -- P2-2:JSON {intervalSec:10, onFailure:'continue'|'pause'}
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  started_at     TEXT,                 -- P2-2:首次执行时间
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_but_store_created ON batch_upload_tasks(store_id, created_at DESC);
-- 注:idx_but_status 由 db/index.js 的 migrateBatchUploadTables 负责创建
-- (旧库 batch_upload_tasks 表已存在,CREATE TABLE IF NOT EXISTS 不会补 status 索引相关的已存在列,
--  但 idx_but_status 是新索引可直接 IF NOT EXISTS 创建 — 实际无依赖新列,可在此创建)
CREATE INDEX IF NOT EXISTS idx_but_status ON batch_upload_tasks(status, created_at DESC);

-- 批量上架任务明细(每个商品一行)
-- P2-2 扩展:seq 执行顺序 + seller_id 来源卖家 + target_store_id 分配目标 + skip_reason 跳过原因
CREATE TABLE IF NOT EXISTS batch_upload_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_task_id   TEXT NOT NULL,
  seq             INTEGER DEFAULT 0,   -- P2-2:执行顺序(0起)
  source_sku      TEXT,
  source_url      TEXT,
  seller_id       TEXT,                -- P2-2:来源卖家(ozon_cache_index.seller_id,审计用)
  target_store_id TEXT,                -- P2-2:分配到的目标店铺(stores.json 的 id)
  follow_task_id  TEXT, -- 关联 follow_sell_tasks.local_task_id
  status          TEXT DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/SKIPPED/CANCELLED
  skip_reason     TEXT,                -- P2-2:跳过原因 INSUFFICIENT_DATA/LISTED/CANCELLED
  error_message   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  started_at      TEXT,                -- P2-2:开始执行时间
  finished_at     TEXT,                -- P2-2:完成时间(成功/失败/跳过)
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bui_batch ON batch_upload_items(batch_task_id);
-- 注:idx_bui_batch_seq / idx_bui_status 由 db/index.js 的 migrateBatchUploadTables 负责创建
-- (旧库 batch_upload_items 表已存在且无 seq 列,需先 ALTER TABLE 补列再建索引)

-- 操作日志(P2-3:审计)
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,    -- store.create/store.delete/listing.import/...
  target     TEXT,             -- 操作对象 ID
  store_id   TEXT,
  operator   TEXT,             -- 用户标识(个人版固定)
  detail     TEXT,             -- JSON 详情
  ip         TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

-- 上架请求体备份:用于排查 OPI /v3/product/import 提交的完整数据
-- 记录转换前(插件原始 message.items)、转换后(transformItemForPortal 输出)、
-- 最终发给 OPI 的请求体(toOpiItem 输出)、OPI 查询响应(/v1/product/import/info 返回)
CREATE TABLE IF NOT EXISTS follow_sell_task_payloads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT NOT NULL,
  store_id       TEXT,
  stage          TEXT NOT NULL,    -- raw(插件原始) / transformed(转换后) / opi_request(最终提交OPI) / opi_response(OPI查询响应,覆盖式)
  payload        TEXT NOT NULL,    -- JSON 字符串
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fstp_task ON follow_sell_task_payloads(local_task_id DESC);
CREATE INDEX IF NOT EXISTS idx_fstp_created ON follow_sell_task_payloads(created_at DESC);

-- ════════════════════════════════════════════════════════════════
-- 以下表用于缓存/采集日志/店铺分类/采集队列(可选 MongoDB 替代)
-- 启用条件:DB_DRIVER=sqlite(默认)
-- 启用后由 src/db/adapter.js → src/db/dao/sqlite/* 使用
-- ════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════
-- 缓存表设计(6 张表:1 索引 + 5 数据)
--   ozon_cache_index        — 索引表,列表查询唯一入口
--   ozon_dom_cache          — card + detail 合并,互相备份
--   ozon_attribute_cache    — search + bundle 合并,各自独立
--   ozon_rich_media_cache   — PDP 富内容(独立,不与 detail 互备)
--   ozon_market_stats_cache — 市场统计
--   ozon_follow_sell_cache  — 跟卖竞争
-- ════════════════════════════════════════════════════════════════

-- ── 索引表:列表查询唯一入口(1 行/SKU) ───────────────────────
-- 冗余字段 + 7 类命中位 + hit_count + listed + seller
-- 由 5 张数据表的 DAO upsert 时同步更新(listed* 在 upsertTaskItems 时即时写入)
CREATE TABLE IF NOT EXISTS ozon_cache_index (
  sku                TEXT PRIMARY KEY,

  -- 7 类缓存命中位 + fetchedAt
  card_hit           INTEGER DEFAULT 0,  card_fetched_at     TEXT,
  detail_hit         INTEGER DEFAULT 0,  detail_fetched_at   TEXT,
  search_hit         INTEGER DEFAULT 0,  search_fetched_at   TEXT,
  bundle_hit         INTEGER DEFAULT 0,  bundle_fetched_at   TEXT,
  rich_media_hit     INTEGER DEFAULT 0,  rich_media_fetched_at TEXT,
  market_stats_hit   INTEGER DEFAULT 0,  market_stats_fetched_at TEXT,
  follow_sell_hit    INTEGER DEFAULT 0,  follow_sell_fetched_at TEXT,

  -- 冗余计算字段
  hit_count          INTEGER DEFAULT 0,  -- 7 类命中数(0-7)
  last_fetched_at    TEXT,                -- 7 类最新 fetchedAt,排序用

  -- 冗余展示字段(从 dom/attribute/marketStats/followSell 提取)
  name               TEXT,                -- dom: card.name || detail.title
  price              TEXT,                -- dom: detail.price || card.price(原始字符串,可能含货币符号)
  price_value        REAL,                -- 解析后的数字价格(供范围过滤用,走索引)
  primary_image      TEXT,                -- dom: card.image || detail.images[0]
  url                TEXT,                -- dom: card.url
  rating_count       INTEGER,             -- dom: card.ratingCount
  has_video          INTEGER DEFAULT 0,   -- richMedia: !!mp4
  has_rich_content   INTEGER DEFAULT 0,   -- richMedia: !!richContent(富内容 11254 是否有内容)
  market_price_p50   TEXT,                -- marketStats: priceP50
  competitor_count   INTEGER,             -- followSell: sellers.length

  -- 采集源
  seller_slug        TEXT,
  seller_id          TEXT,                -- 稳定主键(2026-07 新增,seller_slug 可变,主查询用 seller_id)
  seller_name        TEXT,

  -- 类目信息(2026-07 新增,从 bundle_data 提取冗余,供类目过滤功能使用)
  description_category_id INTEGER,        -- Ozon 描述类目 ID(如 服装/鞋类)
  type_id            INTEGER,             -- Ozon 商品类型 ID(如 运动鞋)
  category_name      TEXT,                -- 类目名称(从 detail.category 面包屑提取,显示用)

  -- 跟卖状态(0=未跟卖, 1=已跟卖) + 跟卖目标店铺信息(由 upsertTaskItems 即时写入)
  listed             INTEGER DEFAULT 0,
  listed_store_id    TEXT,                -- 跟卖到的店铺 ID(follow_sell_tasks.store_id)
  listed_at          TEXT,                -- 最近一次标记跟卖的时间
  listed_task_id     TEXT,                -- 关联的 local_task_id(便于追溯)

  -- 全文搜索(name + sku + seller_name 拼接,仅作 fallback)
  -- 实际搜索走 ozon_cache_index_fts(FTS5 虚拟表,见下)
  searchable_text    TEXT,

  updated_at         TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ci_hit_count    ON ozon_cache_index(hit_count);
CREATE INDEX IF NOT EXISTS idx_ci_listed       ON ozon_cache_index(listed);
CREATE INDEX IF NOT EXISTS idx_ci_seller       ON ozon_cache_index(seller_slug);
CREATE INDEX IF NOT EXISTS idx_ci_rating       ON ozon_cache_index(rating_count);
CREATE INDEX IF NOT EXISTS idx_ci_last_fetched ON ozon_cache_index(last_fetched_at DESC);
-- 注:idx_ci_seller_id 由 db/index.js 的 migrateSellerIdPrimaryKey 负责创建,
-- 因为旧库 ozon_cache_index 表已存在(CREATE TABLE IF NOT EXISTS 不会添加 seller_id 列),
-- 需先 ALTER TABLE 补列再建索引,否则会报 "no such column: seller_id"
-- 注:idx_ci_price_value 同理,在 ensureCacheIndexFtsAndPriceValue 中创建
-- 注:idx_ci_desc_cat_id / idx_ci_type_id 由 db/index.js 的 migrateCategoryFields 负责创建
-- (旧库需先 ALTER TABLE 补列再建索引,同理)

-- ── FTS5 全文搜索虚拟表(外部内容表,与 ozon_cache_index 同步) ──────────────
-- 替代原 idx_ci_fts(普通 B-tree 索引对 LIKE '%keyword%' 无效)
-- 通过触发器自动同步,DAO 查询用 MATCH 操作符走 FTS5 倒排索引
CREATE VIRTUAL TABLE IF NOT EXISTS ozon_cache_index_fts USING fts5(
  sku,
  name,
  seller_name,
  content='ozon_cache_index',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS ozon_cache_index_fts_ai AFTER INSERT ON ozon_cache_index BEGIN
  INSERT INTO ozon_cache_index_fts(rowid, sku, name, seller_name)
  VALUES (new.rowid, new.sku, new.name, new.seller_name);
END;
CREATE TRIGGER IF NOT EXISTS ozon_cache_index_fts_ad AFTER DELETE ON ozon_cache_index BEGIN
  INSERT INTO ozon_cache_index_fts(ozon_cache_index_fts, rowid, sku, name, seller_name)
  VALUES ('delete', old.rowid, old.sku, old.name, old.seller_name);
END;
CREATE TRIGGER IF NOT EXISTS ozon_cache_index_fts_au AFTER UPDATE ON ozon_cache_index BEGIN
  INSERT INTO ozon_cache_index_fts(ozon_cache_index_fts, rowid, sku, name, seller_name)
  VALUES ('delete', old.rowid, old.sku, old.name, old.seller_name);
  INSERT INTO ozon_cache_index_fts(rowid, sku, name, seller_name)
  VALUES (new.rowid, new.sku, new.name, new.seller_name);
END;

-- ── dom 缓存(card + detail 合并,互相备份) ──────────────────
-- card 部分:商品卡 DOM 轻量字段(name/price/image/url/ratingCount)
-- detail 部分:PDP DOM 解析精简 19 字段(详见 ozon-product.js detailCacheSet)
-- 读取时:任一非空即进列表,字段优先级 card 优先,detail 兜底
CREATE TABLE IF NOT EXISTS ozon_dom_cache (
  _id                TEXT PRIMARY KEY,    -- = sku
  card_data          TEXT,                -- JSON: {name, price, image, url, ratingCount}
  card_fetched_at    TEXT,
  detail_data        TEXT,                -- JSON: {title, images, videos, sku, productId,
                                          --        brand, category, characteristics, price,
                                          --        walletPrice, originalPrice, seller,
                                          --        statistics, freeRest, followSellCount,
                                          --        followSellMinPrice, deliveryMode,
                                          --        rating, reviewCount}
  detail_fetched_at  TEXT,
  updated_at         TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dom_name            ON ozon_dom_cache(card_data);
CREATE INDEX IF NOT EXISTS idx_dom_card_fetched    ON ozon_dom_cache(card_fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_dom_detail_fetched  ON ozon_dom_cache(detail_fetched_at DESC);

-- ── attribute 缓存(search + bundle 合并,各自独立) ──────────
-- search 部分:seller portal /api/v1/search 结果(items 数组)
-- bundle 部分:seller portal create-bundle-by-variant-id(顶层物理字段 + attrs)
-- 读取时:attributes 优先 bundle(含物理 attrs merge),空则 search
CREATE TABLE IF NOT EXISTS ozon_attribute_cache (
  _id                       TEXT PRIMARY KEY,    -- = sku
  search_data               TEXT,                -- JSON: {items:[{attributes, price, ...}], _searchMeta}
  search_fetched_at         TEXT,
  bundle_data               TEXT,                -- JSON: bundle 原始(顶层物理字段 + attributes)
  bundle_id                 TEXT,
  bundle_fetched_at         TEXT,
  attrs_empty_verified_at   TEXT,                -- 空属性 6h 重验
  updated_at                TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attr_search_fetched ON ozon_attribute_cache(search_fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_attr_bundle_fetched ON ozon_attribute_cache(bundle_fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_attr_bundle_id      ON ozon_attribute_cache(bundle_id);

-- ── richMedia 缓存(PDP 富内容,独立) ────────────────────────
CREATE TABLE IF NOT EXISTS ozon_rich_media_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,           -- { mp4, richContent, description, hashtags, gallery, fields, widgetStates, hitEndpoints, ... }
  fetchedAt  TEXT NOT NULL
);

-- ── marketStats 缓存(市场统计) ─────────────────────────────
CREATE TABLE IF NOT EXISTS ozon_market_stats_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetchedAt  TEXT NOT NULL,
  l2Synced   INTEGER DEFAULT 0       -- 0/1
);

-- ── followSell 缓存(跟卖竞争) ──────────────────────────────
CREATE TABLE IF NOT EXISTS ozon_follow_sell_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetchedAt  TEXT NOT NULL,
  l2Synced   INTEGER DEFAULT 0
);

-- ── 深度采集日志(原 ozon_auto_collect_log,2026-07 改名) ───────────────────────
CREATE TABLE IF NOT EXISTS ozon_auto_collect_log (
  _id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sku              TEXT NOT NULL,
  source           TEXT,             -- 'shop-page' | 'pdp' | NULL
  sellerSlug       TEXT,
  sellerId         TEXT,             -- 稳定主键(2026-07 新增,sellerSlug 可变,主查询用 sellerId)
  storeClassified  TEXT,             -- 'chinese' | 'non-chinese' | 'unclassified'
  depth            INTEGER,
  status           TEXT NOT NULL,   -- 'success' | 'partial' | 'failed' | 'skipped' | 'antibot'
  results          TEXT NOT NULL,   -- JSON 数组:[{type,hit,error?}]
  totalDuration    INTEGER,
  collectedAt      TEXT NOT NULL    -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_log_sku_time        ON ozon_auto_collect_log(sku, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_log_status_time     ON ozon_auto_collect_log(status, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_log_time            ON ozon_auto_collect_log(collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_log_seller_time     ON ozon_auto_collect_log(sellerSlug, collectedAt DESC);
-- 注:idx_log_sellerId_time 由 db/index.js 的 migrateSellerIdPrimaryKey 负责创建
-- (旧库需先 ALTER TABLE 补 sellerId 列再建索引,否则会报 "no such column: sellerId")

-- ── 浅度采集日志(2026-07 新增:店铺页扫描发现的每个 SKU 一条) ─────────────────
-- 与深度采集日志的区别:
--   深度采集日志:SW 入队后实际执行采集流程(card/detail/pdp/search/bundle/marketStats/followSell)的完整记录
--   浅度采集日志:仅记录"在店铺页扫描时发现了某 SKU + 是否通过过滤"的轻量记录
-- 用途:用户排查过滤效果(为什么有些 SKU 被略过)+ 浅度采集统计
CREATE TABLE IF NOT EXISTS ozon_shallow_collect_log (
  _id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku            TEXT NOT NULL,
  sellerSlug     TEXT,
  sellerId       TEXT,
  name           TEXT,
  price          REAL,              -- 可空(卡片未提取到价格)
  ratingCount    INTEGER,           -- 可空
  imageUrl       TEXT,
  passesFilter   INTEGER NOT NULL,  -- 0=过滤不通过(略过) | 1=通过(已写 card 缓存并入队)
  skipReason     TEXT,              -- 'no-rating'|'price-below-min'|'price-above-max'|'price-invalid'|'rating-below-min'|'rating-above-max'|NULL
  source         TEXT,              -- 'api-scroller' | 'dom-scroller' | 'shop-page' | 'pdp'
  collectedAt    TEXT NOT NULL      -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_shallow_log_sku_time        ON ozon_shallow_collect_log(sku, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_shallow_log_passes_time     ON ozon_shallow_collect_log(passesFilter, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_shallow_log_time            ON ozon_shallow_collect_log(collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_shallow_log_seller_time     ON ozon_shallow_collect_log(sellerSlug, collectedAt DESC);
-- 注:idx_shallow_log_sellerId_time 由 db/index.js 的 migrateSellerIdPrimaryKey 负责创建
-- (旧库需先 ALTER TABLE 补 sellerId 列再建索引,否则会报 "no such column: sellerId")

-- ── 店铺分类(2026-07 重构:_id 改为 sellerId,sellerSlug 降级为普通字段) ─────
-- 旧表 _id = sellerSlug,但 sellerSlug 可变(店铺改名时变),导致历史记录无法关联。
-- 新表 _id = sellerId(稳定主键),sellerSlug 作为普通字段 + 索引(按 slug 反查仍可用)。
-- 历史数据中 sellerId 为空的记录迁移到 ozon_store_classification_legacy 保留备查。
CREATE TABLE IF NOT EXISTS ozon_store_classification (
  _id           TEXT PRIMARY KEY,    -- = sellerId(稳定主键,从 __NUXT__ 获取)
  sellerId      TEXT NOT NULL,       -- 冗余字段,便于 ORM/查询(= _id)
  sellerSlug    TEXT,                -- 可变(店铺改名时变),仅用于反查/展示
  sellerName    TEXT,
  isChinese     INTEGER,             -- NULL/0/1
  classifiedBy  TEXT,
  classifiedAt  TEXT,
  companyInfo   TEXT,                -- JSON
  lastSeenAt    TEXT,
  lastSeenUrl   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sc_chinese ON ozon_store_classification(isChinese);
CREATE INDEX IF NOT EXISTS idx_sc_name    ON ozon_store_classification(sellerName);
CREATE INDEX IF NOT EXISTS idx_sc_seen    ON ozon_store_classification(lastSeenAt DESC);
CREATE INDEX IF NOT EXISTS idx_sc_slug    ON ozon_store_classification(sellerSlug);

-- 旧表 _id = sellerSlug 的历史数据迁移到这里(sellerId 为空无法迁移到新表)
-- 业务上不查询此表,仅保留备查
CREATE TABLE IF NOT EXISTS ozon_store_classification_legacy (
  _id           TEXT PRIMARY KEY,    -- = sellerSlug(旧主键)
  sellerSlug    TEXT NOT NULL,
  sellerId      TEXT,                -- 可为空/空串
  sellerName    TEXT,
  isChinese     INTEGER,
  classifiedBy  TEXT,
  classifiedAt  TEXT,
  companyInfo   TEXT,
  lastSeenAt    TEXT,
  lastSeenUrl   TEXT,
  migratedAt    TEXT NOT NULL        -- 迁移到 legacy 的时间
);

-- ── 店铺 SKU 关联 ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ozon_store_sku (
  _id                 TEXT PRIMARY KEY,    -- = sku
  sellerId            TEXT,
  sellerSlug          TEXT,
  sellerName          TEXT,
  firstSeenAt         TEXT,                -- 仅首次插入
  lastSeenAt          TEXT,
  lastCollectAt       TEXT,
  lastCollectStatus   TEXT,
  lastCollectResults  TEXT                 -- JSON 数组
);
CREATE INDEX IF NOT EXISTS idx_ss_seller_seen    ON ozon_store_sku(sellerId, lastSeenAt DESC);
CREATE INDEX IF NOT EXISTS idx_ss_seller_collect ON ozon_store_sku(sellerId, lastCollectAt DESC);
CREATE INDEX IF NOT EXISTS idx_ss_collect        ON ozon_store_sku(lastCollectAt DESC);

-- ── 采集队列任务 ─────────────────────────────────────────────
-- 设计:快照文档单独建表,避免 _id='__snapshot__' 与 sku unique 约束冲突
CREATE TABLE IF NOT EXISTS collect_queue_tasks (
  _id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku            TEXT NOT NULL UNIQUE,
  sellerSlug     TEXT,
  sellerId       TEXT,
  domInfo        TEXT,                -- JSON
  status         TEXT NOT NULL,      -- 'pending'|'running'|'partial'|'success'|'skipped'(终态:success/skipped)
  attempts       INTEGER DEFAULT 0,
  lastError      TEXT,                -- JSON:{type,...}
  startedAt      TEXT,
  finishedAt     TEXT,
  duration       INTEGER,             -- 任务耗时(ms),SW result 接口上报
  steps          TEXT,                -- JSON
  result         TEXT,                -- JSON
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_status      ON collect_queue_tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_created      ON collect_queue_tasks(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_task_updated      ON collect_queue_tasks(updatedAt DESC);

-- 队列快照(替代原 _id='__snapshot__' 特殊文档,单行表)
CREATE TABLE IF NOT EXISTS collect_queue_snapshot (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  pending        INTEGER DEFAULT 0,
  running        INTEGER DEFAULT 0,
  success        INTEGER DEFAULT 0,
  failed         INTEGER DEFAULT 0,
  syncedAt       TEXT,
  consumePaused  INTEGER,             -- NULL/0/1
  lastConsumeAt  TEXT
);
INSERT OR IGNORE INTO collect_queue_snapshot (id) VALUES (1);

-- ── 采集队列操作指令 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collect_queue_ops (
  _id          INTEGER PRIMARY KEY AUTOINCREMENT,
  op           TEXT NOT NULL,         -- 'retry'|'delete'|'clear'|'pause'|'resume'|'rescan'
  sku          TEXT,                  -- 可为 NULL(clear/pause/resume/rescan)
  params       TEXT,                  -- JSON
  ts           TEXT NOT NULL,
  processed    INTEGER DEFAULT 0,     -- 0/1
  processedAt  TEXT                   -- 非 NULL 时由 TTL 定时任务清理(7 天)
);
CREATE INDEX IF NOT EXISTS idx_ops_pending_ts   ON collect_queue_ops(processed, ts);
CREATE INDEX IF NOT EXISTS idx_ops_ts           ON collect_queue_ops(ts DESC);
CREATE INDEX IF NOT EXISTS idx_ops_dedup        ON collect_queue_ops(op, sku, processed);
CREATE INDEX IF NOT EXISTS idx_ops_processedAt  ON collect_queue_ops(processedAt);


-- 上架模板(跟卖面板人工输入值的预设方案)
-- 字段对齐 mv-listing-config(chrome.storage.local 持久化的那套)
-- config_json 结构: {brand, imageOrder, currency, mergeEnabled, uploadMode,
--   applyWatermark, watermarkTemplateId, applyPoster, posterPrimaryOnly, applyAiRewrite,
--   defaultStock, salePriceStrategy, minPriceStrategy, oldPriceStrategy}
-- 内置默认模板 is_builtin=1,不可删除不可编辑
CREATE TABLE IF NOT EXISTS listing_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_builtin  INTEGER DEFAULT 0,
  is_default  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lt_default ON listing_templates(is_default);
CREATE INDEX IF NOT EXISTS idx_lt_builtin ON listing_templates(is_builtin);

-- ── 类目过滤黑名单(2026-07 新增) ─────────────────────────────
-- 用户维护的"过滤类目类型"列表,采集箱商品若属于此类目则:
--   1. 采集箱中显示"已过滤"标签(可一键加入/移出)
--   2. 上架预览中"一键提交"按钮置灰
-- 主键 = (description_category_id, type_id) 组合,两者一起唯一确定一个类目节点
CREATE TABLE IF NOT EXISTS ozon_filtered_categories (
  description_category_id INTEGER NOT NULL,  -- Ozon 描述类目 ID
  type_id                 INTEGER NOT NULL,  -- Ozon 商品类型 ID
  category_name           TEXT,              -- 显示用(从采集数据冗余,可能为空)
  type_name               TEXT,              -- 显示用(同上)
  created_at              TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (description_category_id, type_id)
);
