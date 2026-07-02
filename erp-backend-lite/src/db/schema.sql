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

-- 采集箱
CREATE TABLE IF NOT EXISTS collect_box (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    TEXT,
  product     TEXT NOT NULL,
  source      TEXT DEFAULT 'ozon',
  ai_draft    TEXT,
  published   INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cb_created ON collect_box(created_at DESC);

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
  fetched_at TEXT DEFAULT (datetime('now'))
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
