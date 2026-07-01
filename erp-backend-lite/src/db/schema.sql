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
