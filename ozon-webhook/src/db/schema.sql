-- Ozon Webhook 服务 schema
-- 包含:原始事件表 + 5 张业务表(订单/库存/商品待刷新/聊天消息/类目树刷新)

-- ① 原始事件表(核心)
CREATE TABLE IF NOT EXISTS ozon_push_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  seller_id INTEGER,
  posting_number TEXT,
  product_id INTEGER,
  sku INTEGER,
  chat_id TEXT,                               -- 聊天类冗余字段
  raw_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending/processing/success/failed/dead
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_events_status ON ozon_push_events(status, received_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON ozon_push_events(message_type);
CREATE INDEX IF NOT EXISTS idx_events_posting ON ozon_push_events(posting_number);
-- idx_events_chat 在 db/index.js 的 runMigrations 中补列后创建,避免旧库无 chat_id 列时报错

-- ② 订单主表(NEW_POSTING/STATE_CHANGED/CANCELLED/日期变更 都写这里)
CREATE TABLE IF NOT EXISTS ozon_postings (
  posting_number TEXT PRIMARY KEY,
  seller_id INTEGER,
  warehouse_id INTEGER,
  status TEXT,
  products_json TEXT,
  in_process_at TEXT,
  shipment_date TEXT,
  cutoff_date TEXT,
  delivery_date_begin TEXT,
  delivery_date_end TEXT,
  tracking_number TEXT,
  is_express INTEGER,
  tpl_integration_type TEXT,
  cancel_reason_id INTEGER,
  cancel_reason_message TEXT,
  raw_count INTEGER DEFAULT 1,
  first_received_at TEXT,
  last_received_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_postings_status ON ozon_postings(status);
CREATE INDEX IF NOT EXISTS idx_postings_seller ON ozon_postings(seller_id);

-- ③ 库存快照(STOCKS_CHANGED 写入,追加式)
CREATE TABLE IF NOT EXISTS ozon_stocks_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER,
  product_id INTEGER,
  sku INTEGER,
  warehouse_id INTEGER,
  present INTEGER,
  reserved INTEGER,
  updated_at TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stocks_sku ON ozon_stocks_snapshot(sku, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stocks_received ON ozon_stocks_snapshot(received_at);

-- ④ 商品待刷新标记(CREATE_OR_UPDATE_ITEM 写入,erp 可扫描消费)
CREATE TABLE IF NOT EXISTS ozon_products_pending_refresh (
  product_id INTEGER PRIMARY KEY,
  seller_id INTEGER,
  offer_id TEXT,
  is_error INTEGER,
  changed_at TEXT,
  received_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_pending ON ozon_products_pending_refresh(consumed_at);

-- ⑤ 聊天消息表(NEW_MESSAGE / UPDATE_MESSAGE / MESSAGE_READ / CHAT_CLOSED 共用)
-- 同 chat_id + message_id + event_type 去重
CREATE TABLE IF NOT EXISTS ozon_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  message_id TEXT,
  chat_type TEXT,
  seller_id INTEGER,
  user_id TEXT,
  user_type TEXT,
  event_type TEXT NOT NULL,                  -- new_message/update_message/message_read/chat_closed
  data_json TEXT,                             -- 消息内容数组(NEW/UPDATE_MESSAGE 用)
  created_at TEXT,                            -- 消息创建时间(推送字段)
  updated_at TEXT,                            -- UPDATE_MESSAGE 的更新时间
  last_read_message_id TEXT,                  -- MESSAGE_READ 用
  received_at TEXT NOT NULL,
  UNIQUE(chat_id, message_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_chat_chat_id ON ozon_chat_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_seller ON ozon_chat_messages(seller_id);
CREATE INDEX IF NOT EXISTS idx_chat_received ON ozon_chat_messages(received_at);

-- ⑥ 类目树刷新标记(erp 可扫描消费)
CREATE TABLE IF NOT EXISTS ozon_category_tree_refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE(changed_at)
);

CREATE INDEX IF NOT EXISTS idx_category_tree_consumed ON ozon_category_tree_refresh_log(consumed_at);
