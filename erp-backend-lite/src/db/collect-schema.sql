-- 采集数据库 schema(2026-10-13 从主库 schema.sql 拆分)
-- 浅度采集 / 深度采集 / 店铺分类 / 采集队列 等采集域数据独立存储到 collect.db
-- 由 src/db/collect-db.js 的 initCollectSchema() 执行初始化与迁移
-- 主库 schema.sql 仅保留订单/采购/商品/上架等业务表,不再包含以下表

-- ── 索引表:列表查询唯一入口(1 行/SKU) ───────────────────────
-- 冗余字段 + 7 类命中位 + hit_count + listed + seller
-- 由 5 张数据表的 DAO upsert 时同步更新(listed* 在 upsertTaskItems 时即时写入)
CREATE TABLE IF NOT EXISTS ozon_cache_index (
  sku                TEXT PRIMARY KEY,

  -- 7 类缓存命中位 + fetchedAt
  card_hit           INTEGER DEFAULT 0,  card_fetched_at     TEXT,
  detail_hit         INTEGER DEFAULT 0,  detail_fetched_at   TEXT,
  search_hit         INTEGER DEFAULT 0,  search_fetched_at   TEXT,
  bundle_hit           INTEGER DEFAULT 0,  bundle_fetched_at   TEXT,
  rich_media_hit     INTEGER DEFAULT 0,  rich_media_fetched_at TEXT,
  market_stats_hit   INTEGER DEFAULT 0,  market_stats_fetched_at TEXT,
  market_stats_empty INTEGER DEFAULT 0,  -- marketStats: __empty 标记(采集成功但 Ozon 无数据),用于"有/无市场统计"筛选
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
  description_quality INTEGER DEFAULT 0,  -- 描述质量:0=空 1=占位(Не удалось загрузить…) 2=按钮污染(粘Читать далее) 3=正常
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

  -- 超轻小件(Extra Small)筛选冗余字段(2026-08 新增,从 bundle_data 顶层物理字段提取)
  -- 单位:weight_g = 克(g),dim_sum_mm = 长+宽+高(毫米 mm)
  -- 超轻小件阈值:weight_g < 500 AND dim_sum_mm < 900(即 90cm,Ozon Extra Small 官方标准)
  weight_g           REAL,                -- 重量(克),bundle_data.weight
  dim_sum_mm         REAL,                -- 三边之和(毫米),bundle_data.depth + width + height

  -- 跟卖状态(0=未跟卖, 1=已跟卖) + 跟卖目标店铺信息(由 upsertTaskItems 即时写入)
  listed             INTEGER DEFAULT 0,
  listed_store_id    TEXT,                -- 跟卖到的店铺 ID(follow_sell_tasks.store_id)
  listed_at          TEXT,                -- 最近一次标记跟卖的时间
  listed_task_id     TEXT,                -- 关联的 local_task_id(便于追溯)

  -- 导出状态(0=未导出, 1=已导出)+ 导出任务信息(由导出任务创建时即时写入,syncSku 不维护)
  exported           INTEGER DEFAULT 0,
  exported_at        TEXT,                -- 最近一次导出的时间
  export_task_id     TEXT,                -- 关联的导出任务 local_task_id(便于追溯)

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
CREATE INDEX IF NOT EXISTS idx_ci_desc_cat_id  ON ozon_cache_index(description_category_id);
CREATE INDEX IF NOT EXISTS idx_ci_type_id       ON ozon_cache_index(type_id);
-- 注:idx_ci_seller_id 由 collect-migrations.js 的 migrateSellerIdPrimaryKey 负责创建,
-- 因为旧库 ozon_cache_index 表已存在(CREATE TABLE IF NOT EXISTS 不会添加 seller_id 列),
-- 需先 ALTER TABLE 补列再建索引,否则会报 "no such column: seller_id"
-- 注:idx_ci_price_value 同理,在 ensureCacheIndexFtsAndPriceValue 中创建

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
  storeClassified  TEXT,             -- 'mainland-china' | 'non-mainland-china' | 'unclassified'
  depth            INTEGER,
  status           TEXT NOT NULL,   -- 'success' | 'partial' | 'failed' | 'skipped' | 'antibot'
  reason           TEXT,            -- 跳过原因(仅 status='skipped' 时有值):'no-market-stats'|'no-search-data'|'filtered-category'|'non-ultra-light'|'non-mainland-china-store'|...
  results          TEXT NOT NULL,   -- JSON 数组:[{type,hit,error?}]
  totalDuration    INTEGER,
  collectedAt      TEXT NOT NULL    -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_log_sku_time        ON ozon_auto_collect_log(sku, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_log_status_time     ON ozon_auto_collect_log(status, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_log_time            ON ozon_auto_collect_log(collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_log_seller_time     ON ozon_auto_collect_log(sellerSlug, collectedAt DESC);
-- 注:idx_log_sellerId_time 由 collect-migrations.js 的 migrateSellerIdPrimaryKey 负责创建
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
  currency       TEXT,              -- 货币符号('₽'|'¥'|'₸'|'$'|'€'|'Br'),可空
  ratingCount    INTEGER,           -- 可空
  imageUrl       TEXT,
  passesFilter   INTEGER NOT NULL,  -- 0=过滤不通过(略过) | 1=通过(已写 card 缓存并入队)
  skipReason     TEXT,              -- 'no-rating'|'price-below-min'|'price-above-max'|'price-invalid'|'rating-below-min'|'rating-above-max'|NULL
  source         TEXT,              -- 'api-scroller' | 'dom-scroller' | 'shop-page' | 'pdp' | 'headless-api'
  collectedAt    TEXT NOT NULL      -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_shallow_log_sku_time        ON ozon_shallow_collect_log(sku, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_shallow_log_passes_time     ON ozon_shallow_collect_log(passesFilter, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_shallow_log_time            ON ozon_shallow_collect_log(collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_shallow_log_seller_time     ON ozon_shallow_collect_log(sellerSlug, collectedAt DESC);
-- 注:idx_shallow_log_sellerId_time 由 collect-migrations.js 的 migrateSellerIdPrimaryKey 负责创建
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
  isMainlandChina INTEGER,             -- NULL/0/1(中国大陆店铺判定)
  classifiedBy  TEXT,
  classifiedAt  TEXT,
  companyInfo   TEXT,                -- JSON,内嵌 { companyName, legalAddress, country, stats? }
  logoImageUrl  TEXT,                -- 店铺 logo URL(从跟卖列表 seller.logoImageUrl 抽取)
  lastSeenAt    TEXT,
  lastSeenUrl   TEXT,
  -- 店铺统计指标(从 companyInfo.stats 提取到顶层列,便于 SQL 排序/筛选)
  -- 数据稀疏:仅店铺页方案B(entrypoint-api)能取到,PDP/方案A 为 NULL
  orders_count  INTEGER,             -- 订单数量(如 455)
  reviews_count INTEGER,             -- 评论数量(如 126)
  rating        REAL,                 -- 产品质量分(如 4.5,原值 "4,5 из 5")
  opened_months INTEGER              -- 店铺开业时长(月数,如 9,原值 "9 месяцев")
);
CREATE INDEX IF NOT EXISTS idx_sc_mainland_china ON ozon_store_classification(isMainlandChina);
CREATE INDEX IF NOT EXISTS idx_sc_name    ON ozon_store_classification(sellerName);
CREATE INDEX IF NOT EXISTS idx_sc_seen    ON ozon_store_classification(lastSeenAt DESC);
CREATE INDEX IF NOT EXISTS idx_sc_slug    ON ozon_store_classification(sellerSlug);
-- 注:idx_sc_orders / idx_sc_rating 索引在 collect-migrations.js 中 ALTER TABLE 补列后创建
-- (旧库 CREATE TABLE IF NOT EXISTS 不更新表结构,若在此处建索引会因列不存在而报错)

-- 旧表 _id = sellerSlug 的历史数据迁移到这里(sellerId 为空无法迁移到新表)
-- 业务上不查询此表,仅保留备查
CREATE TABLE IF NOT EXISTS ozon_store_classification_legacy (
  _id           TEXT PRIMARY KEY,    -- = sellerSlug(旧主键)
  sellerSlug    TEXT NOT NULL,
  sellerId      TEXT,                -- 可为空/空串
  sellerName    TEXT,
  isMainlandChina INTEGER,
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
  forceRefresh   INTEGER DEFAULT 0,  -- 1=强制重新采集(忽略已有缓存,SW _doAutoCollect 传 forceRefresh=true)
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