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

-- 批量上架任务(P2-1)
CREATE TABLE IF NOT EXISTS batch_upload_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,
  store_id       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/PARTIAL
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  config         TEXT,  -- JSON: 水印/AI/库存等配置快照
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_but_store_created ON batch_upload_tasks(store_id, created_at DESC);

-- 批量上架任务明细(每个商品一行)
CREATE TABLE IF NOT EXISTS batch_upload_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_task_id   TEXT NOT NULL,
  source_sku      TEXT,
  source_url      TEXT,
  follow_task_id  TEXT, -- 关联 follow_sell_tasks.local_task_id
  status          TEXT DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED
  error_message   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bui_batch ON batch_upload_items(batch_task_id);

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
-- 记录转换前(插件原始 message.items)和转换后(transformItemForPortal 输出的 OPI v3 格式)
CREATE TABLE IF NOT EXISTS follow_sell_task_payloads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT NOT NULL,
  store_id       TEXT,
  stage          TEXT NOT NULL,    -- raw(插件原始) / transformed(转换后) / opi_request(最终提交OPI)
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

-- ── 9 类缓存表(_id=sku, data=JSON, fetchedAt=ISO8601) ───────
CREATE TABLE IF NOT EXISTS ozon_search_cache (
  _id        TEXT PRIMARY KEY,        -- = sku
  data       TEXT NOT NULL,           -- JSON
  fetchedAt  TEXT NOT NULL            -- ISO8601
);

CREATE TABLE IF NOT EXISTS ozon_bundle_cache (
  _id                   TEXT PRIMARY KEY,
  data                  TEXT NOT NULL,
  bundleId              TEXT,
  attrsEmptyVerifiedAt  TEXT,         -- 空属性 6h 重验
  fetchedAt             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ozon_card_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetchedAt  TEXT NOT NULL
);

-- legacy(已被 richMedia 合并,保留供老数据补写 L2)
CREATE TABLE IF NOT EXISTS ozon_composer_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetchedAt  TEXT NOT NULL
);

-- legacy(已被 richMedia 合并,保留供老数据补写 L2)
CREATE TABLE IF NOT EXISTS ozon_entrypoint_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetchedAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ozon_rich_media_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,           -- { mp4, richContent, description, hashtags, gallery, fields, widgetStates, hitEndpoints, ... }
  fetchedAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ozon_detail_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetchedAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ozon_market_stats_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetchedAt  TEXT NOT NULL,
  l2Synced   INTEGER DEFAULT 0       -- 0/1
);

CREATE TABLE IF NOT EXISTS ozon_follow_sell_cache (
  _id        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetchedAt  TEXT NOT NULL,
  l2Synced   INTEGER DEFAULT 0
);

-- ── 采集日志(原 ozon_auto_collect_log) ───────────────────────
CREATE TABLE IF NOT EXISTS ozon_auto_collect_log (
  _id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sku              TEXT NOT NULL,
  source           TEXT,             -- 'shop-page' | 'pdp' | NULL
  sellerSlug       TEXT,
  storeClassified  TEXT,             -- 'chinese' | 'non-chinese' | 'unclassified'
  depth            INTEGER,
  status           TEXT NOT NULL,   -- 'success' | 'partial' | 'failed' | 'skipped' | 'antibot'
  results          TEXT NOT NULL,   -- JSON 数组:[{type,hit,error?}]
  totalDuration    INTEGER,
  collectedAt      TEXT NOT NULL    -- ISO8601
);
CREATE INDEX IF NOT EXISTS idx_log_sku_time    ON ozon_auto_collect_log(sku, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_log_status_time ON ozon_auto_collect_log(status, collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_log_time        ON ozon_auto_collect_log(collectedAt DESC);
CREATE INDEX IF NOT EXISTS idx_log_seller_time ON ozon_auto_collect_log(sellerSlug, collectedAt DESC);

-- ── 店铺分类 ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ozon_store_classification (
  _id           TEXT PRIMARY KEY,    -- = sellerSlug
  sellerSlug    TEXT NOT NULL,
  sellerId      TEXT,                -- 可为空/空串
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
-- partialFilterExpression 唯一索引:仅对非空 sellerId 建唯一约束
CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_sellerId_unique
  ON ozon_store_classification(sellerId)
  WHERE sellerId IS NOT NULL AND sellerId != '';

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
  status         TEXT NOT NULL,      -- 'pending'|'running'|'failed_retry'|'failed_final'|'failed_partial'|'success'
  attempts       INTEGER DEFAULT 0,
  maxAttempts    INTEGER,
  nextRetryAt    TEXT,
  lastError      TEXT,                -- JSON:{type,...}
  startedAt      TEXT,
  finishedAt     TEXT,
  duration       INTEGER,             -- 任务耗时(ms),SW result 接口上报
  steps          TEXT,                -- JSON
  result         TEXT,                -- JSON
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_status_retry ON collect_queue_tasks(status, nextRetryAt);
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
