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
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(local_task_id, offer_id)
);
CREATE INDEX IF NOT EXISTS idx_fsti_task ON follow_sell_task_items(local_task_id);
CREATE INDEX IF NOT EXISTS idx_fsti_status ON follow_sell_task_items(status);

-- 采集箱 v2(全数据源采集,字段级来源标记)
-- 每条记录 = 一个 SKU(变体),多变体采集时拆成多条记录。以 (store_id, sku) 为 key 去重 upsert
CREATE TABLE IF NOT EXISTS collect_box_v2 (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id               TEXT,
  sku                    TEXT NOT NULL,            -- 本记录对应的 SKU(变体 SKU)
  anchor_sku             TEXT NOT NULL,            -- 母体 SKU(同组变体共享,用于关联查询)
  source_page_url        TEXT,                     -- 采集源 PDP URL
  variants_json          TEXT NOT NULL,            -- JSON: 单条 CollectedVariant(本记录对应的变体)
  raw_by_source_json     TEXT,                     -- JSON: 本变体的数据源原始响应(dom/sellerPortal[sku]/pageJson[sku]/...)
  synthesized_items_json TEXT,                     -- JSON: 单条 synthesized item(本变体的合成跟卖预览)
  collected_at           INTEGER,                  -- 采集时间戳(ms)
  created_at             TEXT DEFAULT (datetime('now')),
  updated_at             TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cbv2_store_created ON collect_box_v2(store_id, created_at DESC);
-- 唯一约束:同店铺同 SKU 只保留一条,重复采集走 upsert 覆盖(store_id 为空时用 '' 兜底)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cbv2_store_sku ON collect_box_v2(COALESCE(store_id, ''), sku);
CREATE INDEX IF NOT EXISTS idx_cbv2_anchor_sku ON collect_box_v2(anchor_sku);
CREATE INDEX IF NOT EXISTS idx_cbv2_collected ON collect_box_v2(collected_at DESC);

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
