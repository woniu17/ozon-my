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
  -- OPI 提交完成(拿到 ozon_task_id)的时刻,用于 import-status-poller 精准计时 Ozon 侧处理时长
  -- 避免用 created_at 判超时把本地图片加工耗时误算进 Ozon 处理时长
  opi_submitted_at TEXT,
  bundle_ids    TEXT,
  error_message TEXT,
  strict_skipped TEXT,
  invalid_image  TEXT,
  -- 库存自动同步:任务创建时快照的 defaultStock + 模板 ID(模板修改不影响该任务)
  -- 定时任务 stock-sync.js 据此对 imported 的 items 调 OPI /v2/products/stocks
  stock_snapshot INTEGER DEFAULT 0,
  template_id    INTEGER,
  -- 2026-07:自动触发图片更新时回写的关联任务 ID(import-status-poller 检测到图片错误后创建)
  -- 用于上架记录页展示"图片更新"状态徽章并跳转到详情
  image_refresh_task_id TEXT,
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
  sku                 TEXT PRIMARY KEY,
  data                TEXT NOT NULL,
  store_id            TEXT,
  description_quality INTEGER DEFAULT 0,  -- 描述质量:0=空 1=占位 2=按钮污染 3=正常(同步时由 classifyDescriptionQuality 计算)
  custom_weight_g     REAL,               -- 自定义重量(克,本地覆盖采集值)
  custom_purchase_price REAL,             -- 自定义采购价(本地覆盖采集值)
  custom_purchase_price_at TEXT,           -- 自定义采购价更新时间
  fetched_at          TEXT DEFAULT (datetime('now'))
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

-- 水印模板(后端 sharp 渲染 + 插件 content script Canvas 渲染共用此配置)
-- config JSON schema 约定:
--   {
--     "type": "text|border|image",
--     "text":   { "content": "string", "fontSize": 32, "color": "#FFFFFF", "opacity": 0.6, "position": "bottom-right" },
--     "border": { "width": 10, "color": "#000000", "opacity": 0.5 },
--     "image":  { "url": "https://...", "scale": 0.2, "opacity": 0.5, "position": "bottom-right" }
--   }
--   - position 枚举: top-left | top-right | bottom-left | bottom-right | center
--   - opacity 范围 0-1
--   - type=text 时 text 必填; type=border 时 border 必填; type=image 时 image 必填
--   - 字段缺失时使用默认值(如 fontSize=32, opacity=0.6, position='bottom-right')
CREATE TABLE IF NOT EXISTS watermark_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,  -- 水印模板名称独一无二(2026-07: 上架模板用名称展示)
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
  status          TEXT DEFAULT 'PENDING', -- 状态机(2026-07 两阶段改造):
  --   PENDING → IMAGE_PENDING → IMAGE_DONE → RUNNING → SUCCESS/FAILED
  --   PENDING:初始 / IMAGE_PENDING:图片处理中(不限速) / IMAGE_DONE:图片已就绪待OPI / RUNNING:OPI调用中 / SUCCESS:OPI成功 / FAILED:失败 / SKIPPED:跳过
  -- 旧数据 status='PENDING' 由 batch-image-poller 当作 IMAGE_PENDING 处理(兼容)
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

-- ── 图片更新任务(2026-07) ──────────────────────────────────
-- 上架后图片出问题时,基于已上架商品单独/批量重提图片(/v1/product/pictures/import)
-- 轻量任务模型,不复用 batch_upload 框架(场景不同:基于已上架商品非新商品分配)
CREATE TABLE IF NOT EXISTS image_refresh_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,    -- img-{timestamp}-{rand}
  store_id       TEXT NOT NULL,            -- 目标店铺(图片所属店铺)
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/PARTIAL
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  template_id    INTEGER,                  -- 使用的上架模板(水印/图片顺序),NULL=不加工直接重提
  source_type    TEXT DEFAULT 'manual',   -- manual(单条) / batch(批量)
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_irt_status ON image_refresh_tasks(status, created_at DESC);

CREATE TABLE IF NOT EXISTS image_refresh_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL,          -- 关联 image_refresh_tasks.local_task_id
  source_task_id   TEXT,                   -- 来源上架记录 local_task_id(follow_sell_tasks)
  source_item_offer_id TEXT,              -- 来源上架记录的 offer_id(卖家 SKU)
  product_id       TEXT NOT NULL,          -- Ozon 商品 ID
  store_id         TEXT NOT NULL,
  status           TEXT DEFAULT 'PENDING',  -- PENDING/PROCESSING/SUCCESS/FAILED/SKIPPED
  source_images    TEXT,                   -- JSON: 源图 URL 数组(加工前)
  processed_images TEXT,                   -- JSON: 加工后 URL 数组(水印+图床,提交给 OPI 的)
  opi_result       TEXT,                   -- JSON: /v2/product/pictures/info 返回的图片状态 + errors
  error_message    TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_iri_task ON image_refresh_items(task_id);
CREATE INDEX IF NOT EXISTS idx_iri_status ON image_refresh_items(status);

-- ── 库存更新任务(2026-07) ──────────────────────────────────
-- 基于已上架商品单独/批量更新库存(/v2/products/stocks)
-- 复用图片更新的轻量任务模型,不复用 batch_upload 框架
-- OPI 限制:单请求 ≤100 组(商品-仓库),每分钟 ≤80 请求,每 30 秒同组只能更新一次
CREATE TABLE IF NOT EXISTS stock_refresh_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,    -- stk-{timestamp}-{rand}
  store_id       TEXT NOT NULL,            -- 目标店铺(库存所属店铺)
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/PARTIAL
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  stock_value    INTEGER NOT NULL,         -- 本次任务设置的统一库存值
  source_type    TEXT DEFAULT 'manual',   -- manual(单条) / batch(批量)
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_srt_status ON stock_refresh_tasks(status, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_refresh_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL,          -- 关联 stock_refresh_tasks.local_task_id
  product_id       TEXT NOT NULL,          -- Ozon 商品 ID
  store_id         TEXT NOT NULL,
  offer_id         TEXT,                   -- 卖家 SKU(可空,仅展示用)
  status           TEXT DEFAULT 'PENDING',  -- PENDING/PROCESSING/SUCCESS/FAILED
  stock_value      INTEGER NOT NULL,       -- 该 item 的库存值(从任务级 stock_value 复制)
  opi_result       TEXT,                   -- JSON: /v2/products/stocks 返回的 result 项
  error_message    TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sri_task ON stock_refresh_items(task_id);
CREATE INDEX IF NOT EXISTS idx_sri_status ON stock_refresh_items(status);

-- ── 类目元数据持久化(2026-07) ─────────────────────────────
-- OPI description-category 系列响应的持久化缓存,跨店铺共享(平台级数据)
-- 设计:每个查询维度一行,完整 JSON 存 payload,避免拆字段(响应结构偶变)
-- 失效策略:永久缓存,仅管理员手动 POST /admin/api/meta/refresh 触发清空
-- 层级:L1 进程内 Map(5min) → L2 SQLite(永久) → L3 OPI

-- 类目树(/v1/description-category/tree):1 个 language 1 行
CREATE TABLE IF NOT EXISTS ozon_meta_category_tree (
  language   TEXT NOT NULL,                    -- ZH_HANS / RU / EN / DEFAULT
  payload    TEXT NOT NULL,                    -- JSON: OPI result 数组(含 children 嵌套)
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (language)
);

-- 类目+类型下属性(/v1/description-category/attribute)
CREATE TABLE IF NOT EXISTS ozon_meta_category_attributes (
  description_category_id INTEGER NOT NULL,
  type_id                 INTEGER NOT NULL,
  language                TEXT NOT NULL,
  payload                 TEXT NOT NULL,       -- JSON: 属性描述数组
  fetched_at              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (description_category_id, type_id, language)
);

-- 字典属性可选值(/v1/description-category/attribute/values)
CREATE TABLE IF NOT EXISTS ozon_meta_attribute_values (
  description_category_id INTEGER NOT NULL,
  type_id                 INTEGER NOT NULL,
  attribute_id            INTEGER NOT NULL,
  language                TEXT NOT NULL,
  payload                 TEXT NOT NULL,       -- JSON: 字典值数组
  fetched_at              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (description_category_id, type_id, attribute_id, language)
);

-- ── 商品信息更新任务(2026-07) ──────────────────────────────
-- 通用商品信息更新:基于已上架商品单独/批量更新标题/描述/价格等字段
-- 统一走 /v3/product/import 全量重传(数据源=Ozon 实时数据,只替换用户指定字段)
-- 可拓展:每个可更新字段对应一个 FieldUpdater,新增字段不改表结构(new_values JSON 存所有字段新值)
CREATE TABLE IF NOT EXISTS product_update_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,    -- pu-{timestamp}-{rand}
  store_id       TEXT NOT NULL,            -- 目标店铺
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/PARTIAL
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  update_fields  TEXT NOT NULL,           -- JSON: 任务级字段清单 ["name","description"](所有 item 的并集)
  source_type    TEXT DEFAULT 'manual',   -- manual(单条) / batch(批量)
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_put_status ON product_update_tasks(status, created_at DESC);

CREATE TABLE IF NOT EXISTS product_update_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL,          -- 关联 product_update_tasks.local_task_id
  product_id       TEXT NOT NULL,          -- Ozon 商品 ID
  offer_id         TEXT NOT NULL,          -- 卖家 SKU(必填,API 用)
  store_id         TEXT NOT NULL,
  status           TEXT DEFAULT 'PENDING', -- PENDING/PROCESSING/SUCCESS/FAILED
  update_fields    TEXT NOT NULL,          -- JSON: 该 item 实际更新哪些字段 ["name","description"]
  new_values       TEXT NOT NULL,          -- JSON: { "name": "新标题", "description": "新描述" }(只含 update_fields 对应的键)
  opi_task_id      TEXT,                   -- Ozon 返回的 task_id
  opi_result       TEXT,                   -- JSON: /v1/product/import/info 查询结果
  error_message    TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pui_task ON product_update_items(task_id);
CREATE INDEX IF NOT EXISTS idx_pui_status ON product_update_items(status);

-- ── 商品归档任务(2026-08) ──────────────────────────────────
-- 基于已上架商品单独/批量归档(/v1/product/archive)
-- 复用轻量任务模型,不复用 batch_upload 框架
-- OPI 限制:单请求 ≤100 个 product_id,响应仅返回整体布尔 { result: bool }
--          无 item 级状态:整批成功→所有 item SUCCESS;整批失败→所有 item FAILED
CREATE TABLE IF NOT EXISTS product_archive_tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id  TEXT UNIQUE NOT NULL,    -- arc-{timestamp}-{rand}
  store_id       TEXT NOT NULL,            -- 目标店铺(商品所属店铺)
  status         TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/RUNNING/SUCCESS/FAILED/PARTIAL
  total_count    INTEGER DEFAULT 0,
  success_count  INTEGER DEFAULT 0,
  failed_count   INTEGER DEFAULT 0,
  source_type    TEXT DEFAULT 'manual',   -- manual(单条) / batch(批量勾选) / filter(按筛选)
  error_message  TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_pat_status ON product_archive_tasks(status, created_at DESC);

CREATE TABLE IF NOT EXISTS product_archive_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          TEXT NOT NULL,          -- 关联 product_archive_tasks.local_task_id
  product_id       TEXT NOT NULL,          -- Ozon 商品 ID
  store_id         TEXT NOT NULL,
  offer_id         TEXT,                   -- 卖家 SKU(展示用,反查 product_data_cache)
  status           TEXT DEFAULT 'PENDING', -- PENDING/PROCESSING/SUCCESS/FAILED
  opi_result       TEXT,                   -- JSON: 整批响应快照 { result: bool, ... }
  error_message    TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pai_task ON product_archive_items(task_id);
CREATE INDEX IF NOT EXISTS idx_pai_status ON product_archive_items(status);

-- ── 导出任务(2026-08:采集箱按筛选导出 Excel) ───────────────
-- 导出是同步完成的轻量任务(创建即终态 SUCCESS),记录导出配置与结果统计
-- 明细存 export_task_items,下载时按明细重新生成 xlsx(可多次下载,无需落盘文件)
CREATE TABLE IF NOT EXISTS export_tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  local_task_id       TEXT UNIQUE NOT NULL,    -- exp-{timestamp}-{rand}
  name                TEXT,                    -- 任务名称(可选)
  status              TEXT NOT NULL DEFAULT 'SUCCESS',
  requested_count     INTEGER DEFAULT 0,       -- 请求导出数 N
  total_count         INTEGER DEFAULT 0,       -- 实际导出数
  market_stats_count  INTEGER DEFAULT 0,       -- 有市场统计数据的条数
  market_stats_ratio  INTEGER DEFAULT 0,       -- 有市场统计占比设置(0-100)
  seller_count        INTEGER DEFAULT 0,       -- 来源卖家数
  skipped_count       INTEGER DEFAULT 0,       -- 跳过数(已导出)
  filters             TEXT,                    -- JSON:导出时的筛选条件快照
  download_count      INTEGER DEFAULT 0,       -- 下载次数(可多次下载)
  created_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_et_created ON export_tasks(created_at DESC);

-- 导出任务明细(每行一个 SKU,字段为导出时刻的快照)
-- Excel 列:SKU / 评论数 / 原价格 / 跟卖价格(公式) / 跟卖最低价格(公式) / 组合列(公式)
-- 跟卖价格规则:原价格<=15 → 19,否则 = 原价格 × 1.06;最低价格 = 跟卖价格 - 0.01(公式写在 xlsx 内)
CREATE TABLE IF NOT EXISTS export_task_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL,          -- 关联 export_tasks.local_task_id
  seq            INTEGER DEFAULT 0,      -- 行序(0 起,与 Excel 行序一致)
  sku            TEXT NOT NULL,
  seller_id      TEXT,                   -- 来源卖家(审计用)
  name           TEXT,                   -- 商品名(快照)
  price          TEXT,                   -- 原始价格字符串(快照)
  price_value    REAL,                   -- 数字价格(快照,Excel"原价格"列)
  rating_count   INTEGER,                -- 评论数(快照,可空)
  market_stats   INTEGER DEFAULT 0,      -- 是否有市场统计(0/1)
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eti_task ON export_task_items(task_id, seq);
-- 注:idx_ci_exported(ozon_cache_index.exported)由 db/index.js 的 migrateExportFields 创建
-- (旧库 CREATE TABLE IF NOT EXISTS 不更新表结构,需先 ALTER TABLE 补列再建索引)

-- ── Ozon 端点访问耗时监控(2026-08) ──────────────────────────
-- qxqx 三脚本(deep/shallow/backfill)对 8 个 Ozon 内部端点的每次 fetch 耗时埋点
-- 维度:客户端出口 IP(client_ip)+ 脚本运行机器(machine_id)+ 浏览器 profile(profile_id)
-- 通道:脚本缓冲后批量 POST /admin/api/endpoint-metrics/batch(x-api-key 鉴权)
-- 保留:每日定时清理,默认 30 天(env METRICS_RETENTION_DAYS)
-- 端点 code 为稳定枚举(与 URL 解耦,Ozon 改 URL 不影响历史数据):
--   www.entrypoint.product / www.composer.product / www.composer.offers-modal
--   seller.analytics.v3 / seller.search / seller.create-bundle
--   www.entrypoint.seller-list / www.entrypoint.shop-info
CREATE TABLE IF NOT EXISTS ozon_endpoint_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,             -- ISO8601 请求发起时间(浏览器侧计时起点)
  endpoint     TEXT NOT NULL,             -- 稳定枚举 code
  domain       TEXT NOT NULL DEFAULT 'www', -- 'www' | 'seller'
  method       TEXT DEFAULT 'GET',
  script       TEXT NOT NULL,             -- 'deep' | 'shallow' | 'backfill'
  sku          TEXT,                      -- deep 部分端点有
  seller_id    TEXT,                      -- shallow/backfill 有
  status_code  INTEGER,                   -- HTTP 状态码(网络失败为 NULL)
  duration_ms  INTEGER NOT NULL,
  ok           INTEGER NOT NULL DEFAULT 1, -- 业务成功(2xx 且解析出数据)
  error_kind   TEXT,                      -- 'HTTP_403'|'HTTP_429'|'TIMEOUT'|'NET_*'|'PARSE_FAIL'|'ANTIBOT'
  machine_id   TEXT NOT NULL,
  client_ip    TEXT,
  profile_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_epm_ts          ON ozon_endpoint_metrics(ts);
CREATE INDEX IF NOT EXISTS idx_epm_endpoint_ts ON ozon_endpoint_metrics(endpoint, ts);
CREATE INDEX IF NOT EXISTS idx_epm_machine_ts  ON ozon_endpoint_metrics(machine_id, ts);

-- ── 价格优势监控(2026-08) ──────────────────────────────────
-- qxqx/price-watch-collect.js 在买家页抓取我的 SKU 的跟卖列表(otherOffersFromSellers),
-- 与 product_data_cache 中我的价格对比,判断是否有价格优势
-- 任务为派生视图(无队列表):GET tasks 实时从 product_data_cache 计算,24h 成功去重
-- 保留:每日定时清理,默认 30 天(env PRICE_WATCH_RETENTION_DAYS)
CREATE TABLE IF NOT EXISTS price_watch_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sku              TEXT NOT NULL,
  store_id         TEXT,                -- 归属店铺(product_data_cache.store_id)
  my_price         REAL,                -- 我的现价(上报时从缓存读取)
  seller_count     INTEGER,             -- 跟卖卖家数(全部报价,不剔除自店)
  min_price        REAL,                -- 跟卖最低价(数字解析后)
  median_price     REAL,                -- 跟卖报价中位数(偶数个取中间两值均值)
  avg_price        REAL,                -- 跟卖均价
  my_rank          INTEGER,             -- 我的价格在全部报价(含自店)中的排名(1=最低)
  is_cheapest      INTEGER,             -- 1=我的价 <= 全场最低价
  gap_abs          REAL,                -- 我的价 - 跟卖最低价
  gap_pct          REAL,                -- 差值百分比(相对跟卖最低价)
  vs_median        TEXT,                -- 'above' | 'below' | 'equal'
  sellers          TEXT,                -- 完整 sellers JSON(前端展开明细)
  status           TEXT NOT NULL,       -- 'ok' | 'empty' | 'error'
  error_reason     TEXT,
  price_fetched_at TEXT,                -- 我的价格对应的 product_data_cache.fetched_at(滞后提示用)
  fetched_at       TEXT NOT NULL        -- 快照采集时间(ISO8601)
);
CREATE INDEX IF NOT EXISTS idx_pws_sku_time ON price_watch_snapshots(sku, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_pws_time     ON price_watch_snapshots(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_pws_store    ON price_watch_snapshots(store_id, fetched_at DESC);

-- 多实例任务领取锁:一个 SKU 同一时刻只能被一个实例持有(主键原子抢占);
-- report 成功/实例 release 释放;实例崩溃未释放的靠 expires_at 过期自动回池
CREATE TABLE IF NOT EXISTS price_watch_claims (
  sku          TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL,        -- 领取实例(pw-<host>-<pid>-<rand>)
  claimed_at   TEXT NOT NULL,        -- 领取时间(ISO8601)
  expires_at   TEXT NOT NULL         -- 过期时间(默认领取+120min;过期可被重新领取)
);
CREATE INDEX IF NOT EXISTS idx_pwc_instance ON price_watch_claims(instance_id);

-- ── 订单处理:采购订单与Ozon FBS订单关联(2026-08,个人自发货模式) ──
-- 设计文档: docs/采购订单-Ozon订单关联管理-功能设计.md
-- 个人模式:上家收货人=卖家本人,无货代;提交采购信息即流转待打单发货

-- Ozon 平台订单(posting 同步落地;一个 posting = 一个包裹)
CREATE TABLE IF NOT EXISTS op_ozon_order (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id              TEXT NOT NULL,           -- 店铺 id(对应 stores.json)
  posting_number        TEXT NOT NULL,           -- Ozon posting_number ★同步主键(拆单后 -N 序号)
  order_id              INTEGER,                 -- Ozon order_id
  order_number          TEXT,
  parent_posting_number TEXT,                    -- 母件号(拆单:子件指向母件,空=母件/未拆)
  status                TEXT,                    -- awaiting_packaging / awaiting_deliver / delivering / delivered / cancelled ...
  substatus             TEXT,
  in_process_at         TEXT,                    -- 下单时间
  shipment_date         TEXT,                    -- cutoff 最晚发货时间(倒计时源)
  delivering_date       TEXT,                    -- 交物流时间
  currency              TEXT DEFAULT 'CNY',
  order_amount          REAL DEFAULT 0,          -- 订单金额(products[].price.amount×qty 求和,店铺币种)
  buyer_id              TEXT,
  buyer_name            TEXT,
  buyer_city            TEXT,
  delivery_method_name  TEXT,                    -- ABT Economy Extra Small ...
  warehouse_name        TEXT,                    -- 厦门006
  tpl_integration_type  TEXT,
  is_express            INTEGER DEFAULT 0,
  cancellation_json     TEXT,                    -- 取消原因快照
  raw_json              TEXT,                    -- API 原始响应(审计/补字段)
  feishu_notified_at    TEXT,                    -- 新订单飞书通知去重标记(webhook/API 兜底补发成功时打时间戳,NULL=未通知)
  feishu_pickup_notified_at        TEXT,         -- 揽收通知去重标记(同上模式)
  feishu_pickup_point_notified_at  TEXT,         -- 到达取货点通知去重标记
  feishu_received_notified_at      TEXT,         -- 签收通知去重标记
  feishu_stocking_notified_at      TEXT,         -- 备货通知去重标记(2026-09-22:备货动作本地发+webhook 双链路)
  feishu_cancel_notified_at        TEXT,         -- 取消通知去重标记(2026-09-22:webhook+API 兜底双链路)
  pickup_point_at                  TEXT,         -- 首见到达取货点时刻(substatus=posting_in_pickup_point 首次同步到时写,2026-09-22)
  first_synced_at       TEXT,
  last_synced_at        TEXT,
  gmt_create            TEXT,
  gmt_modified          TEXT,
  UNIQUE(store_id, posting_number)
);
CREATE INDEX IF NOT EXISTS idx_opoo_status ON op_ozon_order(status);
CREATE INDEX IF NOT EXISTS idx_opoo_store_time ON op_ozon_order(store_id, in_process_at DESC);
-- 拆单子件反查母件(拆单采购迁移 reconcile 的触发检查,2026-09-18)
CREATE INDEX IF NOT EXISTS idx_opoo_parent ON op_ozon_order(store_id, parent_posting_number);
-- 揽收时间索引(订单统计页按 delivering_date 范围查询,2026-09-21)
CREATE INDEX IF NOT EXISTS idx_opoo_delivering ON op_ozon_order(store_id, delivering_date DESC);

-- Ozon 订单产品行
CREATE TABLE IF NOT EXISTS op_ozon_order_item (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ozon_order_id   INTEGER NOT NULL REFERENCES op_ozon_order(id),
  sku             INTEGER,                      -- products[].sku
  offer_id        TEXT,                         -- products[].offer_id ★采购匹配键
  title           TEXT,
  quantity        INTEGER NOT NULL DEFAULT 1,
  price           REAL,                         -- 单价(products[].price.amount,CNY)
  currency_code   TEXT,
  purchase_amount REAL DEFAULT 0,               -- 采购金额回写(分摊后)
  purchase_num    INTEGER DEFAULT 0,            -- 已采数量
  gmt_create      TEXT,
  gmt_modified    TEXT,
  UNIQUE(ozon_order_id, sku, offer_id)
);
CREATE INDEX IF NOT EXISTS idx_opoi_offer ON op_ozon_order_item(offer_id);

-- 包裹(采购/收货/发货操作单元,妙手 opOrderPackage 等价物)
CREATE TABLE IF NOT EXISTS op_package (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  package_no              TEXT NOT NULL UNIQUE, -- MS+yyMMddHHmmss+rand 自生成
  ozon_order_id           INTEGER NOT NULL REFERENCES op_ozon_order(id),
  store_id                TEXT NOT NULL,
  operate_status          TEXT NOT NULL DEFAULT 'wait_process', -- wait_process/wait_ship/ship_success/wait_receiver_confirm/cancelled
  purchase_status         TEXT NOT NULL DEFAULT 'none',         -- none/partial/complete
  is_shipped              INTEGER DEFAULT 0,
  -- Ozon 国际段物流(我发货后)
  logistics_no            TEXT,                 -- Ozon 跟踪号(=posting_number)
  logistics_company       TEXT,
  waybill_printed_at      TEXT,
  -- 国内物流(上家→我,到货判断依据)
  head_logistics_no       TEXT,
  head_logistics_company  TEXT,
  head_shipped_at         TEXT,
  arrived_at              TEXT,                 -- 到货时间(采购单全部签收时回填,仅提示不阻塞打单)
  -- 聚合
  total_purchase_amount   REAL DEFAULT 0,       -- 关联采购金额合计(冗余加速列表)
  last_delivery_at        TEXT,                 -- 最晚发货(冗余自 shipment_date)
  shipped_at              TEXT,
  delivered_at            TEXT,
  is_ignored              INTEGER DEFAULT 0,    -- 搁置
  note                    TEXT,                 -- 本地备注(妙手同步 COALESCE 覆盖,也可本地编辑)
  tags                    TEXT,                 -- 本地标签(逗号分隔,本地编辑,妙手不覆盖)
  ms_flag_remarks         TEXT,                 -- 妙手旗帜备注(从 miaoshou_package.flag_remarks 同步,只读展示)
  weight                  REAL,                 -- 称重(kg,扫描发货称重录入)
  ms_purchase_amount      REAL,                 -- 妙手侧采购金额(妙手同步口径)
  ms_synced_at            TEXT,                 -- 妙手同步时间
  accrual_total           REAL,                 -- 结算金额(妙手 accrual 同步)
  accrual_sale_total      REAL,
  accrual_synced_at       TEXT,
  is_returned             INTEGER DEFAULT 0,    -- 退货(Ozon 退货同步回写)
  return_state            TEXT,
  return_state_name       TEXT,
  return_at               TEXT,                 -- 退货时间(订单统计页按此范围查询)
  gmt_create              TEXT,
  gmt_modified            TEXT
);
CREATE INDEX IF NOT EXISTS idx_op_pkg_operate ON op_package(operate_status);
CREATE INDEX IF NOT EXISTS idx_op_pkg_order ON op_package(ozon_order_id);
CREATE INDEX IF NOT EXISTS idx_op_pkg_purchase ON op_package(purchase_status);
-- 签收/退货时间索引(订单统计页按 delivered_at/return_at 范围查询,2026-09-21)
CREATE INDEX IF NOT EXISTS idx_op_pkg_delivered ON op_package(store_id, delivered_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_pkg_return   ON op_package(store_id, return_at DESC);

-- 采购订单(1688/拼多多/淘宝)
CREATE TABLE IF NOT EXISTS op_purchase_order (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_sn       TEXT,                       -- 上家采购单号(1688:512766... / 拼多多:260829-...;模式B无单号为 NULL)
  platform          TEXT NOT NULL DEFAULT 'other', -- 1688 / yangkeduo / taobao / other
  purchase_channel  TEXT DEFAULT 'manual',      -- manual(模式B手填) / platform_order(模式A单号补全)
  buyer_account     TEXT,                       -- 我的采购账号(平台用户名:清祥17/atenlin3;导入平台订单时自动回填,可手改)
  buyer_user_id     TEXT,                       -- 平台用户ID(1688/淘宝:unb 同一阿里系ID;拼多多:pdd_user_id;导入订单时自动附带)
  seller_name       TEXT,                       -- 上家
  currency          TEXT DEFAULT 'CNY',
  payment_amount    REAL DEFAULT 0,             -- 实付(商品+运费)
  goods_amount      REAL DEFAULT 0,
  shipping_amount   REAL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'wait_send', -- wait_pay/wait_send/shipped/part_shipped/signed/finished/closed
  pay_at            TEXT,
  send_at           TEXT,                       -- 上家发货时间
  signed_at         TEXT,                       -- 我签收时间
  link_status       TEXT NOT NULL DEFAULT 'linked',   -- linked/unlinked(取消关联)
  sync_uuid         TEXT,                       -- 跨机同步稳定标识(purchase_sn 为空的手工单判重键;录入时生成,导入时复用)
  auto_sync_amount  INTEGER DEFAULT 1,
  logistics_company TEXT,
  logistics_no      TEXT,
  last_trace_at     TEXT,
  last_trace_desc   TEXT,
  trace_json        TEXT,                       -- 完整物流轨迹节点(1688买家版API/妙手,[{acceptTime,remark}] 最新在前)
  items_json        TEXT,                       -- 采购商品行(平台订单导入/搜索补全,[{goodsName,spec,price,number,thumbUrl}])
  note              TEXT,
  gmt_create        TEXT,
  gmt_modified      TEXT,
  UNIQUE(platform, purchase_sn)
);
CREATE INDEX IF NOT EXISTS idx_op_po_status ON op_purchase_order(status);
CREATE INDEX IF NOT EXISTS idx_op_po_logno ON op_purchase_order(logistics_no);
CREATE INDEX IF NOT EXISTS idx_op_po_syncuuid ON op_purchase_order(sync_uuid);

-- 采购单↔包裹↔产品行 关联(多对多桥表,一单多关联分摊落点)
CREATE TABLE IF NOT EXISTS op_purchase_link (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES op_purchase_order(id),
  package_id        INTEGER NOT NULL REFERENCES op_package(id),
  ozon_order_item_id INTEGER REFERENCES op_ozon_order_item(id), -- 可空=包裹级关联
  allocated_amount  REAL DEFAULT 0,             -- 分摊采购金额
  quantity          INTEGER DEFAULT 0,
  alloc_mode        TEXT DEFAULT 'manual',     -- 分摊模式:manual=手动填金额,auto=按数量自动分摊
  gmt_create        TEXT
);
-- 唯一约束:COALESCE 让 NULL(包裹级关联)变 0,参与唯一约束,防止重复插入
CREATE UNIQUE INDEX IF NOT EXISTS idx_op_pl_unique ON op_purchase_link(purchase_order_id, package_id, COALESCE(ozon_order_item_id, 0));
CREATE INDEX IF NOT EXISTS idx_op_pl_pkg ON op_purchase_link(package_id);
CREATE INDEX IF NOT EXISTS idx_op_pl_item ON op_purchase_link(ozon_order_item_id);

-- 货源映射(模式A保存时1688订单详情自动积累)
CREATE TABLE IF NOT EXISTS op_supplier_product (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL,
  offer_id        TEXT,                         -- Ozon offer_id(可空=按SKU)
  ozon_sku        INTEGER,
  platform        TEXT NOT NULL DEFAULT '1688',
  source_url      TEXT,
  source_item_id  TEXT,                         -- 1688 商品ID(采购补全自动写入)
  title           TEXT,
  spec_mapping    TEXT,                         -- 规格映射 JSON
  enabled         INTEGER DEFAULT 1,
  gmt_create      TEXT,
  gmt_modified    TEXT
);
-- 表级 UNIQUE 不允许表达式,用表达式唯一索引(offer_id 空串归一)
CREATE UNIQUE INDEX IF NOT EXISTS idx_op_sp_offer_source
  ON op_supplier_product(store_id, COALESCE(offer_id, ''), source_item_id);

-- 国内物流轨迹(上家→我)
CREATE TABLE IF NOT EXISTS op_logistics_trace (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER REFERENCES op_purchase_order(id),
  logistics_no      TEXT NOT NULL,
  company           TEXT,
  trace_at          TEXT,
  description       TEXT,
  raw_json          TEXT,
  gmt_create        TEXT,
  UNIQUE(logistics_no, trace_at, description)
);

-- 订单同步游标/状态(每店铺一行,记录最近同步结果)
CREATE TABLE IF NOT EXISTS op_sync_cursor (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    TEXT NOT NULL,
  sync_type   TEXT NOT NULL,                    -- orders
  last_run_at TEXT,
  last_count  INTEGER DEFAULT 0,
  last_error  TEXT,
  UNIQUE(store_id, sync_type)
);

-- ════════════════════════════════════════════════════════════════
-- Ozon 应计项目(2026-09,财务应计明细)
-- 来源:POST /v1/finance/accrual/postings(已完成/已取消货件)
-- 设计文档: docs/Ozon应计项目同步-功能设计.md
-- op_package 冗余列 accrual_total/accrual_sale_total/accrual_synced_at
-- 由 ensureMigrations 轻量迁移补充
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS op_accrual (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL,
  posting_number  TEXT NOT NULL,
  package_id      INTEGER REFERENCES op_package(id),
  type_id         INTEGER NOT NULL,              -- Ozon 应计类型 ID(66/67/69...)
  type_name       TEXT,                         -- 字典翻译冗余(RfbsGlobalAgentFee...)
  amount          REAL DEFAULT 0,               -- 应计金额(负数=扣款,RUB)
  currency        TEXT DEFAULT 'RUB',
  seller_price     REAL,                        -- 单价(销售佣金行携带,其余 NULL)
  sku             INTEGER,
  quantity        INTEGER,
  accrual_date    TEXT,                         -- 应计日期(YYYY-MM-DD)
  synced_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_op_acc_pkg ON op_accrual(package_id);
CREATE INDEX IF NOT EXISTS idx_op_acc_posting ON op_accrual(posting_number);

-- 应计收入侧明细(2026-09-24,数据源 /v1/finance/accrual/by-day POSTING 类别)
-- postings 接口只返回费用侧(op_accrual);by-day 的 POSTING.commission 携带
-- 销售收款明细(售价/结算/佣金/共同投资/奖金),是完整利润核算的收入侧数据
-- 幂等:按 posting_number 先删后插;费用侧(acquiring 等)仍写 op_accrual
CREATE TABLE IF NOT EXISTS op_accrual_income (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL,
  posting_number  TEXT NOT NULL,
  package_id      INTEGER REFERENCES op_package(id),
  accrual_date    TEXT,                         -- 应计发生日(YYYY-MM-DD,与 by-day.date 一致)
  accrual_id      INTEGER,                      -- Ozon 应计条目全局唯一 ID
  sku             INTEGER,
  quantity        INTEGER,
  seller_price    REAL,                         -- 卖家售价
  sale_price      REAL,                         -- 销售价
  sale_amount     REAL,                         -- 实际结算额
  sale_commission REAL,                         -- 销售佣金(对应费用侧 type 69)
  commission      REAL,                         -- 全口径佣金
  coinvestment    REAL,                         -- 共同投资(平台补贴)
  bonus           REAL,                         -- 奖金
  detail_json     TEXT,                         -- 原始 commission 对象(含 ratio 等)
  synced_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_op_acc_inc_pkg ON op_accrual_income(package_id);
CREATE INDEX IF NOT EXISTS idx_op_acc_inc_posting ON op_accrual_income(posting_number);
CREATE INDEX IF NOT EXISTS idx_op_acc_inc_date ON op_accrual_income(accrual_date);

-- ════════════════════════════════════════════════════════════════
-- 价格管理(2026-09,设计文档: docs/价格管理-概要设计.md)
-- ════════════════════════════════════════════════════════════════

-- Ozon 价格缓存(手动同步 /v5/product/info/prices + /v3/product/info/list 反查 sku)
CREATE TABLE IF NOT EXISTS op_product_price_cache (
  sku                    TEXT PRIMARY KEY,    -- Ozon SKU(全局唯一,不可变,用户确认)
  store_id               TEXT NOT NULL,
  product_id             INTEGER,             -- 改价 API 用 product_id(稳定标识)
  offer_id               TEXT,                -- 仅存档参考,不作关联键(可被修改)
  price                  REAL,                -- 现售价(CNY,实测结算币种)
  old_price              REAL,                -- 划线价(CNY)
  min_price              REAL,                -- 促销最低价(CNY)
  currency_code          TEXT DEFAULT 'CNY',
  sales_percent_fbs      REAL,                -- v5 commissions 实际 FBS 佣金率(%,参考展示)
  market_min_price_rub   REAL,                -- v5 price_indexes 市场最低价(RUB,参考展示)
  price_index_color      TEXT,                -- 'RED'/'GREEN'/...(价格竞争力指示)
  name                   TEXT,                -- v3 商品名(冗余,列表直显)
  image                  TEXT,                -- v3 首图(列表直显)
  raw_json               TEXT,                -- v5 原始 item
  synced_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_op_ppc_store ON op_product_price_cache(store_id);

-- 价格变更日志(审计 + Ozon 每商品每小时改价≤10次的限频依据)
CREATE TABLE IF NOT EXISTS op_price_change_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id      TEXT NOT NULL,
  sku           TEXT NOT NULL,
  product_id    INTEGER,
  old_price     REAL,                         -- 改前售价
  new_price     REAL,                         -- 改后售价
  old_old_price REAL,                         -- 改前划线价
  currency_code TEXT DEFAULT 'CNY',
  target_rate   REAL,                         -- 目标成本利润率(%),手动改价为 NULL
  source        TEXT,                         -- 'target' 目标定价 | 'manual' 手动
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_change_sku ON op_price_change_log(sku, created_at);

-- ════════════════════════════════════════════════════════════════
-- 妙手 ERP 订单数据(2026-09,独立新表,与 op_* 分离)
-- 通过 miaoshou-helper 插件从妙手历史订单页提取,保留妙手原始快照
-- 设计文档: docs/妙手订单数据提取-功能设计.md
-- ════════════════════════════════════════════════════════════════

-- 妙手订单包裹(主表,一行一包裹)
CREATE TABLE IF NOT EXISTS miaoshou_package (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  op_order_package_id TEXT UNIQUE NOT NULL,  -- 妙手包裹内部 ID(同步主键)
  app_package_no      TEXT,                   -- MS20260827... 妙手包裹号
  posting_number      TEXT,                   -- Ozon posting_number
  shop_id             TEXT,                   -- 妙手店铺 ID
  shop_nick           TEXT,                   -- 店铺名 YQL001
  platform            TEXT DEFAULT 'ozon',
  platform_order_sn   TEXT,                   -- Ozon 订单号
  order_amount        REAL,                   -- 订单金额
  currency            TEXT DEFAULT 'CNY',
  buyer_name          TEXT,                   -- 买家姓名
  buyer_country       TEXT,
  gmt_order_start     TEXT,                   -- 下单时间
  weighing_weight     REAL,                   -- 称重重量(g)
  note                TEXT,                   -- 本地备注(appNote)
  flag_remarks        TEXT,                   -- 妙手旗帜备注(操作员标记,如 "linrh-1688" 采购归属)
  flags_json          TEXT,                   -- 妙手旗帜 ID 数组 JSON
  tag_map_json        TEXT,                   -- 妙手系统标签 JSON(如 fulfillmentType)
  buyer_message       TEXT,                   -- 买家留言
  seller_note         TEXT,                   -- 卖家备注
  operate_status      TEXT,                   -- 妙手操作状态(原值)
  app_package_tab     TEXT,                   -- 妙手 tab 分组(waitProcess/waitShip/submitPlatform/waitReceiverConfirm/closed/isolation)
  platform_package_status TEXT,               -- 平台包裹状态(cancelled/...)
  app_package_status_text TEXT,               -- 妙手状态文案(已退款/...)
  purchase_amount     REAL,                   -- 妙手算好的采购金额 CNY(orderPackageAmountDetail.CNYPurchasePrice)
  purchase_status     TEXT,                   -- 妙手采购状态(原值)
  logistics_no        TEXT,                   -- Ozon 跟踪号
  logistics_company   TEXT,
  gmt_create          TEXT,                   -- 妙手创建时间
  gmt_modified        TEXT,                   -- 妙手修改时间
  gmt_delivery          TEXT,                   -- 发货时间
  items_json            TEXT,                   -- 商品信息 JSON(图/标题/SKU/数量/单价,对齐订单处理页展示)
  quantity              INTEGER DEFAULT 0,     -- 订单商品数量(从 items_json 提取,用于采购金额加权分摊)
  raw_json            TEXT,                   -- 主列表 API 原始响应(审计/补字段)
  synced_at           TEXT NOT NULL,          -- 本次同步时间
  updated_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ms_pkg_posting ON miaoshou_package(posting_number);
CREATE INDEX IF NOT EXISTS idx_ms_pkg_shop    ON miaoshou_package(shop_nick);
CREATE INDEX IF NOT EXISTS idx_ms_pkg_synced  ON miaoshou_package(synced_at DESC);

-- 妙手采购订单(子表,一行一采购单,关联主表)
CREATE TABLE IF NOT EXISTS miaoshou_purchase (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  miaoshou_package_id   INTEGER NOT NULL REFERENCES miaoshou_package(id),
  purchase_order_id     TEXT,                   -- 妙手采购单内部 ID
  purchase_sn           TEXT,                   -- 采购单号(1688/拼多多)
  platform              TEXT NOT NULL,          -- 1688/yangkeduo/taobao
  platform_name         TEXT,                   -- 平台中文名(拼多多/1688/淘宝)
  detail_url            TEXT,                   -- 采购平台订单详情链接
  buyer_account         TEXT,                   -- 采购账号 清祥17/PCC01
  seller_name           TEXT,                   -- 上家卖家
  payment_amount        REAL DEFAULT 0,          -- 采购金额
  currency              TEXT DEFAULT 'CNY',
  items_json            TEXT,                   -- 采购商品 JSON(标题/单价/数量)
  status                TEXT,                    -- has_send/has_sign(原值)
  purchase_start_time   TEXT,                    -- 采购时间
  send_at               TEXT,                    -- 上家发货时间
  logistics_company     TEXT,                    -- 国内物流商
  logistics_no          TEXT,                    -- 国内物流单号
  last_trace            TEXT,                    -- 最新物流轨迹
  raw_json              TEXT,
  is_auto_rsync        INTEGER DEFAULT 1,     -- 是否自动同步采购金额(1=自动,0=用券需手动纠正,影响分摊取值)
  synced_at             TEXT NOT NULL,
  updated_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, purchase_sn)                 -- 防重复
);
CREATE INDEX IF NOT EXISTS idx_ms_pur_pkg ON miaoshou_purchase(miaoshou_package_id);
CREATE INDEX IF NOT EXISTS idx_ms_pur_sn ON miaoshou_purchase(purchase_sn);

-- 妙手包裹 ↔ 采购单 多对多关联表(2026-09)
-- 根因修复:一个拼多多/1688 采购单可能拆分对应多个妙手包裹(拼单场景),
-- 原设计在 miaoshou_purchase.miaoshou_package_id 上加 UNIQUE(platform, purchase_sn)
-- + ON CONFLICT DO UPDATE SET miaoshou_package_id 会导致后入库包裹覆盖前者的关联。
-- 此中间表表达多对多关系;miaoshou_purchase.miaoshou_package_id 列保留但不再依赖。
-- raw_json 存该包裹采集此采购单时的原始 JSON(每个包裹视角不同,如 platformOrderSn/opOrderPackageId)
CREATE TABLE IF NOT EXISTS miaoshou_package_purchase_map (
  package_id  INTEGER NOT NULL REFERENCES miaoshou_package(id) ON DELETE CASCADE,
  purchase_id INTEGER NOT NULL REFERENCES miaoshou_purchase(id) ON DELETE CASCADE,
  raw_json    TEXT,
  synced_at   TEXT NOT NULL,
  PRIMARY KEY (package_id, purchase_id)
);
CREATE INDEX IF NOT EXISTS idx_ms_map_pur ON miaoshou_package_purchase_map(purchase_id);

-- ══════════════════════════════════════════════════════════════
-- Ozon Webhook 推送表(2026-09-17 自 ozon-webhook 服务并入,7 张)
-- 原服务 data/ozon-webhook.db 历史数据经 scripts/migrate-webhook-data.mjs 导入
-- ══════════════════════════════════════════════════════════════

-- ① 原始事件表(核心:接收路由写入,event-poller 消费)
CREATE TABLE IF NOT EXISTS ozon_push_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  seller_id INTEGER,
  posting_number TEXT,
  product_id INTEGER,
  sku INTEGER,
  chat_id TEXT,                               -- 聊天类冗余字段
  order_number TEXT,                          -- 订单类(ORDER_*)与 FBO 货件冗余字段
  raw_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',     -- pending/processing/success/failed/dead
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TEXT NOT NULL,
  claimed_at TEXT,                            -- 进入 processing 的时刻,poller 据此回收卡死事件
  processed_at TEXT,
  UNIQUE(idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_events_status ON ozon_push_events(status, received_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON ozon_push_events(message_type);
CREATE INDEX IF NOT EXISTS idx_events_posting ON ozon_push_events(posting_number);
CREATE INDEX IF NOT EXISTS idx_events_chat ON ozon_push_events(chat_id);
CREATE INDEX IF NOT EXISTS idx_events_order ON ozon_push_events(order_number);

-- ② 货件主表(FBS/rFBS 的 NEW_POSTING/STATE_CHANGED/CANCELLED/日期变更 + FBO 货件)
CREATE TABLE IF NOT EXISTS ozon_postings (
  posting_number TEXT PRIMARY KEY,
  seller_id INTEGER,
  warehouse_id INTEGER,
  status TEXT,                                -- 推送模型状态(posting_on_way_to_city 等)
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
  order_number TEXT,                          -- FBO 货件关联的订单号(FBS 货件为空)
  uuid TEXT,                                  -- FBO 货件事件唯一标识
  posting_type TEXT NOT NULL DEFAULT 'fbs',   -- fbs / fbo
  creation_date TEXT,                         -- FBO 货件创建时间(FBS 用 in_process_at)
  cancel_date TEXT,                           -- FBO 货件取消时间
  raw_count INTEGER DEFAULT 1,
  first_received_at TEXT,
  last_received_at TEXT,
  sale_amount_cny REAL DEFAULT 0,             -- 销售金额(OPI 返回的金额本身就是 CNY)
  pickup_at TEXT,                             -- 首次达到揽收级的时间(揽收通知去重标记+当日揽收统计基准)
  cancel_initiator TEXT                       -- 取消发起方(从 cancellation 对象提取)
);
CREATE INDEX IF NOT EXISTS idx_postings_status ON ozon_postings(status);
CREATE INDEX IF NOT EXISTS idx_postings_seller ON ozon_postings(seller_id);
CREATE INDEX IF NOT EXISTS idx_postings_order ON ozon_postings(order_number);
CREATE INDEX IF NOT EXISTS idx_postings_type ON ozon_postings(posting_type);

-- ② b 订单主表(TYPE_ORDER_NEW/CANCELLED/STATE_CHANGED 写这里)
-- 一个订单可包含多个货件(posting),订单级状态使用 order_ 前缀
CREATE TABLE IF NOT EXISTS ozon_orders (
  order_number TEXT PRIMARY KEY,
  order_id INTEGER,
  seller_id INTEGER,
  status TEXT,                                -- 订单状态(order_in_delivery / order_done 等)
  uuid TEXT,                                  -- 最近一次事件 uuid
  created_at TEXT,                            -- 订单创建时间
  cancelled_at TEXT,                           -- 订单取消时间
  updated_at TEXT,                            -- 订单状态变更时间
  first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  raw_count INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON ozon_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON ozon_orders(seller_id);

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

-- ④ 商品待刷新标记(CREATE_OR_UPDATE_ITEM 写入,待消费)
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

-- ⑥ 类目树刷新标记(待消费)
CREATE TABLE IF NOT EXISTS ozon_category_tree_refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  consumed_at TEXT,
  UNIQUE(changed_at)
);
CREATE INDEX IF NOT EXISTS idx_category_tree_consumed ON ozon_category_tree_refresh_log(consumed_at);

