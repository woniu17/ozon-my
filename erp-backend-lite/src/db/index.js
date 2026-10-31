// SQLite 数据库初始化(使用 Node 22.5+ 内置的 node:sqlite,零原生依赖)
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { classifyDescriptionQuality } from '../utils/description-quality.js';
import { initCollectSchema } from './collect-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// ERP_DATA_DIR 给测试/多实例留出隔离目录的方式;不设时行为与原来完全一致
const DATA_DIR = process.env.ERP_DATA_DIR || join(__dirname, '..', '..', 'data');
const DB_PATH = join(DATA_DIR, 'erp.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

// 确保数据目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// allowUnknownNamedParameters:同一查询复用参数对象时(如 listPriceProducts 的 COUNT/SELECT 共用 args),
// 允许绑定 SQL 中未出现的命名参数键,避免 "Unknown named parameter" 报错
export const db = new DatabaseSync(DB_PATH, { allowUnknownNamedParameters: true });
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
// 2026-10-19: 设置 busy_timeout=5s。此前默认 0(立即抛 SQLITE_BUSY),
// 一旦有瞬时写锁冲突(如备份/其他连接),订单同步一轮 database is locked
// 就会卡死 syncing 互斥,导致后续所有定时轮被静默跳过数小时(生产事故)。
db.exec('PRAGMA busy_timeout = 5000;');

// getDb():webhook 迁入代码(event-dao/handlers)沿用的取库方式
// 与本文件顶部直接 const db = 同一实例;初始化顺序由模块加载保证(app 启动即 open)
export function getDb() {
  return db;
}

// 初始化 schema
export async function initSchema() {
  // 2026-09-14: op_purchase_order.sync_uuid 补列必须在 exec(schema.sql) 之前执行,
  // 因为 schema.sql 的 CREATE INDEX idx_op_po_syncuuid 引用该列,旧库需先 ALTER 才能创建索引。
  // sync_uuid 是跨机同步稳定标识:手工采购单(purchase_sn 为 NULL)没有自然判重键,
  // 导出/导入时靠它识别"同一条采购单";有单号的仍以 (platform, purchase_sn) 为准,此为兜底
  const _poSyncUuidPre = db.prepare(`PRAGMA table_info(op_purchase_order)`).all();
  if (_poSyncUuidPre.length > 0 && !_poSyncUuidPre.some((c) => c.name === 'sync_uuid')) {
    db.exec(`ALTER TABLE op_purchase_order ADD COLUMN sync_uuid TEXT`);
    // 一次性回填:存量行生成 UUID(标准 8-4-4-4-12 格式,variant 位不严格,仅保证唯一)
    db.exec(`
      UPDATE op_purchase_order
      SET sync_uuid = lower(
        hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' ||
        hex(randomblob(2)) || '-' || hex(randomblob(6))
      )
      WHERE sync_uuid IS NULL OR sync_uuid = ''
    `);
    const _filledUuid = db.prepare(`SELECT COUNT(*) AS n FROM op_purchase_order WHERE sync_uuid IS NOT NULL`).get().n;
    console.log(`[db] migration: added column op_purchase_order.sync_uuid, backfilled ${_filledUuid} rows`);
  }
  // 2026-09-20: op_ozon_order 飞书通知去重标记列族
  // feishu_notified_at(新订单)/pickup(揽收)/pickup_point(到达取货点)/received(签收)
  // (webhook 通知成功/API 兜底补发成功时打时间戳;NULL=未通知)
  // 必须在 exec(schema.sql) 之前执行,因为新装库 schema.sql 已含该列,旧库需先 ALTER
  const _feishuNotifyCols = [
    'feishu_notified_at',
    'feishu_pickup_notified_at',
    'feishu_pickup_point_notified_at',
    'feishu_received_notified_at',
    'feishu_stocking_notified_at',
    'feishu_cancel_notified_at',
  ];
  const _orderFeishuNotifiedPre = db.prepare(`PRAGMA table_info(op_ozon_order)`).all();
  for (const col of _feishuNotifyCols) {
    if (_orderFeishuNotifiedPre.length > 0 && !_orderFeishuNotifiedPre.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE op_ozon_order ADD COLUMN ${col} TEXT`);
      // 存量订单一律视为已通知(部署前的订单不回溯补发,防 mid/slow 轮通知风暴);
      // 真正漏通知的订单(如 webhook 停推期间状态推进的)由人工清标记触发 API 兜底补发
      db.exec(
        `UPDATE op_ozon_order SET ${col} = COALESCE(first_synced_at, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
      );
      console.log(`[db] migration: added column op_ozon_order.${col}, backfilled`);
    }
  }
  // 2026-10-01: ozon_push_events.claimed_at 补列。
  // poller 把事件置 processing 后如果进程崩溃,事件会永久停在 processing(claim 只捞 pending),
  // claimed_at 记录上锁时间,stale reclaim 才能分辨"正在处理"和"卡死"。
  // 存量 processing 行回填 received_at:它们都是历史孤儿,按接收时间判 stale 即可被回收。
  const _evCols = db.prepare(`PRAGMA table_info(ozon_push_events)`).all();
  if (_evCols.length > 0 && !_evCols.some((c) => c.name === 'claimed_at')) {
    db.exec(`ALTER TABLE ozon_push_events ADD COLUMN claimed_at TEXT`);
    db.exec(`UPDATE ozon_push_events SET claimed_at = received_at WHERE status = 'processing'`);
    const _n = db.prepare(`SELECT COUNT(*) AS n FROM ozon_push_events WHERE status = 'processing'`).get().n;
    console.log(`[db] migration: added column ozon_push_events.claimed_at, backfilled ${_n} processing rows`);
  }
  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);
  // 采集域独立库(collect.db)初始化:建表 + 采集迁移(跨库回填需要主库连接)
  await initCollectSchema(db);
  await ensureMigrations();
}

// 2026-09-22: op_ozon_order.pickup_point_at(首见到达取货点时刻)——
// 待取兜底通知的窗口时间源(到达取货点晚于揽收 1~3 天,用 delivering_date 判窗口必超窗);
// 不回填:NULL=从未同步到取货点状态,首次同步到时由 order-sync 写入
{
  const _cols = db.prepare(`PRAGMA table_info(op_ozon_order)`).all().map((c) => c.name);
  if (_cols.length > 0 && !_cols.includes('pickup_point_at')) {
    db.exec(`ALTER TABLE op_ozon_order ADD COLUMN pickup_point_at TEXT`);
    console.log('[db] migration: added column op_ozon_order.pickup_point_at');
  }
}

// 轻量迁移:为已存在的表补列(CREATE TABLE IF NOT EXISTS 不会更新旧表结构)
async function ensureMigrations() {
  // 2026-10: stock_refresh_tasks.warehouse_id 补列(库存更新任务可选指定目标仓库,
  // NULL=按店铺默认 warehouse_id;新库由 schema.sql 直接建好,此处幂等跳过)
  const _srtCols = db.prepare(`PRAGMA table_info(stock_refresh_tasks)`).all();
  if (_srtCols.length > 0 && !_srtCols.some((c) => c.name === 'warehouse_id')) {
    db.exec(`ALTER TABLE stock_refresh_tasks ADD COLUMN warehouse_id TEXT`);
    console.log('[db] migration: added column stock_refresh_tasks.warehouse_id');
  }
  // 2026-10-24: 上架素材机制 Phase 2 批量发布
  // batch_upload_items.material_id:素材发布时指向 listing_materials.id,
  // poller 检测到非空则走 buildListingMessageFromMaterial 而非 buildListingMessage
  const _buiCols = db.prepare(`PRAGMA table_info(batch_upload_items)`).all();
  if (_buiCols.length > 0 && !_buiCols.some((c) => c.name === 'material_id')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN material_id INTEGER`);
    console.log('[db] migration: added column batch_upload_items.material_id');
  }
  // listing_material_publishes.batch_item_id:批量发布时关联 batch_upload_items.id,
  // 便于 poller 在成功/失败时回写发布记录状态
  const _lmpCols = db.prepare(`PRAGMA table_info(listing_material_publishes)`).all();
  if (_lmpCols.length > 0 && !_lmpCols.some((c) => c.name === 'batch_item_id')) {
    db.exec(`ALTER TABLE listing_material_publishes ADD COLUMN batch_item_id INTEGER`);
    console.log('[db] migration: added column listing_material_publishes.batch_item_id');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bui_material ON batch_upload_items(material_id)`);
  // 2026-10-18: 安卓通知推送日志(push-hub 每次广播写入,供问题排查与安卓端推送序列表展示)
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      posting_number TEXT,
      store_name TEXT,
      amount REAL,
      item_count INTEGER DEFAULT 0,
      product_image_url TEXT,
      package_id TEXT,
      machine_name TEXT,
      occurred_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_log_created ON notification_log(created_at DESC);
  `);
  // 2026-10: 订单同步结果日志(持久化同步历史,每次同步每店一行,供"同步历史"面板回溯)
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_order_sync_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id     TEXT NOT NULL,
      store_name   TEXT,
      trigger      TEXT NOT NULL DEFAULT 'timer',
      level        TEXT NOT NULL DEFAULT 'fast',
      since        TEXT,
      "to"         TEXT,
      count        INTEGER DEFAULT 0,
      duration_ms  INTEGER DEFAULT 0,
      error        TEXT,
      stack        TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_op_order_sync_log_created ON op_order_sync_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_op_order_sync_log_store ON op_order_sync_log(store_id, id DESC);
  `);
  // product_data_cache.store_id(用于关联店铺,拉特征/描述时需用对应店铺凭据)
  const cols = db.prepare(`PRAGMA table_info(product_data_cache)`).all();
  if (!cols.some((c) => c.name === 'store_id')) {
    db.exec(`ALTER TABLE product_data_cache ADD COLUMN store_id TEXT`);
    console.log('[db] migration: added column product_data_cache.store_id');
  }
  // product_data_cache.custom_weight_g:本系统重量(克),用户在商品列表页面手动设置
  // 与 Ozon 后台重量(weight_g/json_extract attributes_data.weight)并存,供订单/采购分摊参考
  if (!cols.some((c) => c.name === 'custom_weight_g')) {
    db.exec(`ALTER TABLE product_data_cache ADD COLUMN custom_weight_g REAL`);
    console.log('[db] migration: added column product_data_cache.custom_weight_g');
  }
  // product_data_cache.custom_purchase_price:本系统采购价(CNY),价格管理页维护
  // 与订单实际采购金额相互独立,作为商品维度定价基准(2026-09-18,docs/价格管理-概要设计.md)
  if (!cols.some((c) => c.name === 'custom_purchase_price')) {
    db.exec(`ALTER TABLE product_data_cache ADD COLUMN custom_purchase_price REAL`);
    console.log('[db] migration: added column product_data_cache.custom_purchase_price');
  }
  if (!cols.some((c) => c.name === 'custom_purchase_price_at')) {
    db.exec(`ALTER TABLE product_data_cache ADD COLUMN custom_purchase_price_at TEXT`);
    console.log('[db] migration: added column product_data_cache.custom_purchase_price_at');
  }
  // product_data_cache.description_quality:描述质量分级,用于商品列表"描述状态"过滤
  // 0=空 1=占位 2=按钮污染 3=正常(同步时由 classifyDescriptionQuality 计算)
  let addedProductDescQuality = false;
  if (!cols.some((c) => c.name === 'description_quality')) {
    db.exec(`ALTER TABLE product_data_cache ADD COLUMN description_quality INTEGER DEFAULT 0`);
    console.log('[db] migration: added column product_data_cache.description_quality');
    addedProductDescQuality = true;
  }
  if (addedProductDescQuality) {
    backfillProductDescriptionQuality();
  }
  // listing_templates 内置默认模板(is_builtin=1,不可删不可改)
  const builtinCount = db.prepare(`SELECT COUNT(*) as n FROM listing_templates WHERE is_builtin = 1`).get().n;
  if (builtinCount === 0) {
    const defaultConfig = JSON.stringify({
      brand: 'no_brand',
      imageOrder: 'keep',
      currency: 'CNY',
      mergeEnabled: false,
      uploadMode: 'api',
      applyWatermark: false,
      watermarkTemplateId: '',
      applyPoster: false,
      posterPrimaryOnly: false,
      applyAiRewrite: false,
      defaultStock: 10,
      salePriceStrategy: { type: 'ratio', value: 1 },
      minPriceStrategy: null,
      oldPriceStrategy: { type: 'ratio', value: 2 },
    });
    db.prepare(`INSERT INTO listing_templates (name, config_json, is_builtin, is_default) VALUES (?, ?, 1, 1)`).run(
      '默认模板',
      defaultConfig
    );
    console.log('[db] seed: inserted builtin default listing template');
  }
  // collect_box_v2 表已废弃(改为以 cardCache 为基准的缓存视图),清理旧表
  dropLegacyCollectBoxV2(db);
  // 2026-09: 妙手订单表补列(商品信息 JSON / 采购平台名 / 采购链接 / 采购商品 JSON)
  const msPkgCols = db.prepare(`PRAGMA table_info(miaoshou_package)`).all();
  if (msPkgCols.length > 0 && !msPkgCols.some((c) => c.name === 'items_json')) {
    db.exec(`ALTER TABLE miaoshou_package ADD COLUMN items_json TEXT`);
    console.log('[db] migration: added column miaoshou_package.items_json');
  }
  // 2026-09: 妙手 tab 分组/平台状态(取消单归类修正:操作状态会分散在多个 tab)
  if (msPkgCols.length > 0) {
    if (!msPkgCols.some((c) => c.name === 'app_package_tab')) {
      db.exec(`ALTER TABLE miaoshou_package ADD COLUMN app_package_tab TEXT`);
      console.log('[db] migration: added column miaoshou_package.app_package_tab');
    }
    if (!msPkgCols.some((c) => c.name === 'platform_package_status')) {
      db.exec(`ALTER TABLE miaoshou_package ADD COLUMN platform_package_status TEXT`);
      console.log('[db] migration: added column miaoshou_package.platform_package_status');
    }
    if (!msPkgCols.some((c) => c.name === 'app_package_status_text')) {
      db.exec(`ALTER TABLE miaoshou_package ADD COLUMN app_package_status_text TEXT`);
      console.log('[db] migration: added column miaoshou_package.app_package_status_text');
    }
    if (!msPkgCols.some((c) => c.name === 'purchase_amount')) {
      db.exec(`ALTER TABLE miaoshou_package ADD COLUMN purchase_amount REAL`);
      console.log('[db] migration: added column miaoshou_package.purchase_amount');
    }
  }
  const msPurCols = db.prepare(`PRAGMA table_info(miaoshou_purchase)`).all();
  if (msPurCols.length > 0) {
    if (!msPurCols.some((c) => c.name === 'platform_name')) {
      db.exec(`ALTER TABLE miaoshou_purchase ADD COLUMN platform_name TEXT`);
      console.log('[db] migration: added column miaoshou_purchase.platform_name');
    }
    if (!msPurCols.some((c) => c.name === 'detail_url')) {
      db.exec(`ALTER TABLE miaoshou_purchase ADD COLUMN detail_url TEXT`);
      console.log('[db] migration: added column miaoshou_purchase.detail_url');
    }
    if (!msPurCols.some((c) => c.name === 'items_json')) {
      db.exec(`ALTER TABLE miaoshou_purchase ADD COLUMN items_json TEXT`);
      console.log('[db] migration: added column miaoshou_purchase.items_json');
    }
  }
  // 2026-09: 妙手包裹 ↔ 采购单 多对多关联中间表
  // 旧库可能没有此表(schema.sql 早于 ensureMigrations 执行,但旧库的 schema.sql 是旧版本),
  // 新库由 schema.sql 直接 CREATE。本块幂等:存在则跳过 CREATE,但回填每次都会执行(INSERT OR IGNORE 幂等)。
  db.exec(`
    CREATE TABLE IF NOT EXISTS miaoshou_package_purchase_map (
      package_id  INTEGER NOT NULL REFERENCES miaoshou_package(id) ON DELETE CASCADE,
      purchase_id INTEGER NOT NULL REFERENCES miaoshou_purchase(id) ON DELETE CASCADE,
      raw_json    TEXT,
      synced_at   TEXT NOT NULL,
      PRIMARY KEY (package_id, purchase_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ms_map_pur ON miaoshou_package_purchase_map(purchase_id);
  `);
  // 2026-09-04: 旧库补 raw_json 列(CREATE TABLE IF NOT EXISTS 不会更新已存在的表结构)
  const mapCols = db.prepare(`PRAGMA table_info(miaoshou_package_purchase_map)`).all();
  if (mapCols.length > 0 && !mapCols.some((c) => c.name === 'raw_json')) {
    db.exec(`ALTER TABLE miaoshou_package_purchase_map ADD COLUMN raw_json TEXT`);
    console.log('[db] migration: added column miaoshou_package_purchase_map.raw_json');
  }
  // 一次性回填:把 miaoshou_purchase 现存的 miaoshou_package_id(legacy 列)作为一条关联写入中间表。
  // 让历史包裹(原本被 ON CONFLICT 覆盖丢失)的"最后赢家"包裹保留关联;
  // 被覆盖丢失的关联需要重新从妙手同步一次才能补回(upsert 已改造为新逻辑)。
  // 幂等:已有相同 (package_id, purchase_id) 的行会被 INSERT OR IGNORE 跳过。
  const backfill = db
    .prepare(
      `INSERT OR IGNORE INTO miaoshou_package_purchase_map (package_id, purchase_id, synced_at)
       SELECT miaoshou_package_id, id, COALESCE(synced_at, datetime('now'))
       FROM miaoshou_purchase
       WHERE miaoshou_package_id IS NOT NULL`
    )
    .run();
  if (backfill.changes > 0) {
    console.log(
      `[db] migration: backfilled ${backfill.changes} rows into miaoshou_package_purchase_map from legacy column`
    );
  }
  // 2026-09-04: miaoshou_package.quantity 订单商品数量(从 items_json 提取,用于采购金额加权分摊)
  {
    const cols = db.prepare(`PRAGMA table_info(miaoshou_package)`).all();
    if (cols.length > 0 && !cols.some((c) => c.name === 'quantity')) {
      db.exec(`ALTER TABLE miaoshou_package ADD COLUMN quantity INTEGER DEFAULT 0`);
      console.log('[db] migration: added column miaoshou_package.quantity');
    }
    // 回填 quantity:从 items_json 提取 quantity 之和
    const qtyRows = db
      .prepare(`SELECT id, items_json FROM miaoshou_package WHERE items_json IS NOT NULL AND length(items_json) > 0 AND (quantity IS NULL OR quantity = 0)`)
      .all();
    for (const r of qtyRows) {
      try {
        const items = JSON.parse(r.items_json);
        if (Array.isArray(items)) {
          const qty = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
          if (qty > 0) {
            db.prepare(`UPDATE miaoshou_package SET quantity = ? WHERE id = ?`).run(qty, r.id);
          }
        }
      } catch {}
    }
    if (qtyRows.length > 0) {
      console.log(`[db] backfill: updated quantity for ${qtyRows.length} miaoshou_package rows`);
    }
  }
  // 2026-09-04: miaoshou_purchase.is_auto_rsync 是否自动同步采购金额(1=自动,0=用券需手动纠正)
  const msPurCols2 = db.prepare(`PRAGMA table_info(miaoshou_purchase)`).all();
  if (msPurCols2.length > 0 && !msPurCols2.some((c) => c.name === 'is_auto_rsync')) {
    db.exec(`ALTER TABLE miaoshou_purchase ADD COLUMN is_auto_rsync INTEGER DEFAULT 1`);
    console.log('[db] migration: added column miaoshou_purchase.is_auto_rsync');
    // 回填:从 raw_json 提取 isAutoRsyncPurchasePayment
    const autoRows = db
      .prepare(`SELECT id, raw_json FROM miaoshou_purchase WHERE raw_json IS NOT NULL AND length(raw_json) > 0`)
      .all();
    for (const r of autoRows) {
      try {
        const raw = JSON.parse(r.raw_json);
        const isAuto = raw.isAutoRsyncPurchasePayment;
        if (isAuto != null) {
          db.prepare(`UPDATE miaoshou_purchase SET is_auto_rsync = ? WHERE id = ?`).run(
            isAuto === '1' || isAuto === 1 ? 1 : 0, r.id
          );
        }
      } catch {}
    }
    if (autoRows.length > 0) {
      console.log(`[db] backfill: updated is_auto_rsync for ${autoRows.length} miaoshou_purchase rows`);
    }
  }
  // 2026-09: op_package 应计冗余列(应计合计/销售收入合计/最近拉取时间)
  // NULL 语义:accrual_total NULL=拉过但 Ozon 尚未生成应计(24h 重试窗口)
  const opPkgCols = db.prepare(`PRAGMA table_info(op_package)`).all();
  if (opPkgCols.length > 0) {
    if (!opPkgCols.some((c) => c.name === 'accrual_total')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN accrual_total REAL`);
      console.log('[db] migration: added column op_package.accrual_total');
    }
    if (!opPkgCols.some((c) => c.name === 'accrual_sale_total')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN accrual_sale_total REAL`);
      console.log('[db] migration: added column op_package.accrual_sale_total');
    }
    if (!opPkgCols.some((c) => c.name === 'accrual_synced_at')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN accrual_synced_at TEXT`);
      console.log('[db] migration: added column op_package.accrual_synced_at');
    }
    // 2026-09: 从妙手同步过来的重量/采购金额/同步时间(冗余列,与本地体系并存)
    if (!opPkgCols.some((c) => c.name === 'weight')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN weight REAL`);
      console.log('[db] migration: added column op_package.weight');
    }
    if (!opPkgCols.some((c) => c.name === 'ms_purchase_amount')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN ms_purchase_amount REAL`);
      console.log('[db] migration: added column op_package.ms_purchase_amount');
    }
    if (!opPkgCols.some((c) => c.name === 'ms_synced_at')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN ms_synced_at TEXT`);
      console.log('[db] migration: added column op_package.ms_synced_at');
    }
    // 2026-09-13: rFBS 退货标记(妥投后买家退货退款,来自 /v2/returns/rfbs/list)
    if (!opPkgCols.some((c) => c.name === 'is_returned')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN is_returned INTEGER DEFAULT 0`);
      console.log('[db] migration: added column op_package.is_returned');
    }
    if (!opPkgCols.some((c) => c.name === 'return_state')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN return_state TEXT`);
      console.log('[db] migration: added column op_package.return_state');
    }
    if (!opPkgCols.some((c) => c.name === 'return_state_name')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN return_state_name TEXT`);
      console.log('[db] migration: added column op_package.return_state_name');
    }
    if (!opPkgCols.some((c) => c.name === 'return_at')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN return_at TEXT`);
      console.log('[db] migration: added column op_package.return_at');
    }
    // 2026-11: 订单处理时间(入库时间/发运时间)。打单时间沿用 waybill_printed_at。
    // 历史数据:旧逻辑 waybill_printed_at 在打单/交运两条路径都写入,已进入交运链路的包裹该值实为交运时间,
    // 迁移时复制到 dispatched_at,新逻辑起 waybill_printed_at 仅记录打单时间。
    if (!opPkgCols.some((c) => c.name === 'stocked_at')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN stocked_at TEXT`);
      console.log('[db] migration: added column op_package.stocked_at');
    }
    if (!opPkgCols.some((c) => c.name === 'dispatched_at')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN dispatched_at TEXT`);
      console.log('[db] migration: added column op_package.dispatched_at');
      const backfilled = db
        .prepare(`UPDATE op_package SET dispatched_at = waybill_printed_at
                  WHERE dispatched_at IS NULL AND waybill_printed_at IS NOT NULL
                    AND operate_status NOT IN ('wait_process','wait_stock','wait_stick','wait_dispatch')`)
        .run();
      if (backfilled.changes > 0) {
        console.log(`[db] migration: backfilled op_package.dispatched_at from waybill_printed_at for ${backfilled.changes} rows`);
      }
    }
  }
  // 2026-09-13: rFBS 退货明细表(op_return,退货原始记录,包裹级标记 op_package.is_returned 由同步回写)
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_return (
      return_id    INTEGER PRIMARY KEY,
      store_id     TEXT NOT NULL,
      posting_number TEXT,
      order_number TEXT,
      return_number TEXT,
      sku          INTEGER,
      offer_id     TEXT,
      product_name TEXT,
      price        REAL,
      currency     TEXT,
      state        TEXT,
      state_name   TEXT,
      group_state  TEXT,
      money_return_state_name TEXT,
      created_at   TEXT,
      synced_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_op_return_posting ON op_return(posting_number);
  `);
  // 2026-09-04: op_purchase_link.alloc_mode 分摊模式(manual=手动填金额,auto=按数量自动分摊)
  {
    const plCols = db.prepare(`PRAGMA table_info(op_purchase_link)`).all();
    if (plCols.length > 0 && !plCols.some((c) => c.name === 'alloc_mode')) {
      db.exec(`ALTER TABLE op_purchase_link ADD COLUMN alloc_mode TEXT DEFAULT 'manual'`);
      console.log('[db] migration: added column op_purchase_link.alloc_mode');
    }
    // 回填 alloc_mode='manual'(旧数据都是手动模式)
    db.exec(`UPDATE op_purchase_link SET alloc_mode='manual' WHERE alloc_mode IS NULL`);
    // 回填 quantity(若空,从 op_ozon_order_item.quantity 取)
    const qtyRows = db.prepare(`
      SELECT pl.id, oi.quantity
      FROM op_purchase_link pl
      JOIN op_ozon_order_item oi ON oi.id = pl.ozon_order_item_id
      WHERE (pl.quantity IS NULL OR pl.quantity = 0) AND oi.quantity IS NOT NULL AND oi.quantity > 0
    `).all();
    for (const r of qtyRows) {
      db.prepare(`UPDATE op_purchase_link SET quantity = ? WHERE id = ?`).run(r.quantity, r.id);
    }
    if (qtyRows.length > 0) {
      console.log(`[db] backfill: updated quantity for ${qtyRows.length} op_purchase_link rows`);
    }
  }
  // 2026-09: op_purchase_order.items_json 采购单商品图/规格/数量(订单处理页"补全采购订单信息"写入)
  // 与妙手表分离:补全入口在订单处理页,数据应归属本地 op_purchase_order,而非妙手镜像
  {
    const poCols = db.prepare(`PRAGMA table_info(op_purchase_order)`).all();
    if (poCols.length > 0 && !poCols.some((c) => c.name === 'items_json')) {
      db.exec(`ALTER TABLE op_purchase_order ADD COLUMN items_json TEXT`);
      console.log('[db] migration: added column op_purchase_order.items_json');
      // 一次性回填:把已存在于 miaoshou_purchase.items_json 的商品数据按 (platform, purchase_sn) 复制过来
      // 仅回填 op_purchase_order.items_json 为空的行,避免覆盖后续新采集的数据
      db.exec(`
        UPDATE op_purchase_order
        SET items_json = (SELECT ms.items_json FROM miaoshou_purchase ms
                          WHERE ms.platform = op_purchase_order.platform
                            AND ms.purchase_sn = op_purchase_order.purchase_sn
                            AND ms.items_json IS NOT NULL AND length(ms.items_json) > 0)
        WHERE (items_json IS NULL OR length(items_json) = 0)
          AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
      `);
      console.log('[db] backfill: copied items_json from miaoshou_purchase to op_purchase_order');
    }
  }
  // 2026-09-16: op_purchase_order.trace_json 完整物流轨迹节点(1688买家版API定时拉取,采购物流补全轮询器写入)
  {
    const poColsT = db.prepare(`PRAGMA table_info(op_purchase_order)`).all();
    if (poColsT.length > 0 && !poColsT.some((c) => c.name === 'trace_json')) {
      db.exec(`ALTER TABLE op_purchase_order ADD COLUMN trace_json TEXT`);
      console.log('[db] migration: added column op_purchase_order.trace_json');
    }
  }
  // 2026-09-13: op_purchase_order.buyer_user_id 平台用户ID(导入平台订单自动附带)
  {
    const poCols2 = db.prepare(`PRAGMA table_info(op_purchase_order)`).all();
    if (poCols2.length > 0 && !poCols2.some((c) => c.name === 'buyer_user_id')) {
      db.exec(`ALTER TABLE op_purchase_order ADD COLUMN buyer_user_id TEXT`);
      console.log('[db] migration: added column op_purchase_order.buyer_user_id');
    }
  }
  // follow_sell_tasks:库存快照列(任务创建时存,模板修改不影响)
  const fstCols = db.prepare(`PRAGMA table_info(follow_sell_tasks)`).all();
  if (!fstCols.some((c) => c.name === 'stock_snapshot')) {
    db.exec(`ALTER TABLE follow_sell_tasks ADD COLUMN stock_snapshot INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_tasks.stock_snapshot');
  }
  if (!fstCols.some((c) => c.name === 'template_id')) {
    db.exec(`ALTER TABLE follow_sell_tasks ADD COLUMN template_id INTEGER`);
    console.log('[db] migration: added column follow_sell_tasks.template_id');
  }
  // 2026-07: OPI 提交时间(拿到 ozon_task_id 的时刻),用于 import-status-poller 精准判超时
  // 旧数据 opi_submitted_at=NULL,poller 回退到 created_at 计算(保持向后兼容)
  if (!fstCols.some((c) => c.name === 'opi_submitted_at')) {
    db.exec(`ALTER TABLE follow_sell_tasks ADD COLUMN opi_submitted_at TEXT`);
    console.log('[db] migration: added column follow_sell_tasks.opi_submitted_at');
  }
  // 2026-07:自动触发图片更新时回写的关联任务 ID(import-status-poller 检测到图片错误后创建)
  // 用于上架记录页展示"图片更新"状态徽章并跳转到详情
  if (!fstCols.some((c) => c.name === 'image_refresh_task_id')) {
    db.exec(`ALTER TABLE follow_sell_tasks ADD COLUMN image_refresh_task_id TEXT`);
    console.log('[db] migration: added column follow_sell_tasks.image_refresh_task_id');
  }
  // follow_sell_task_items:库存同步状态
  const fstiCols = db.prepare(`PRAGMA table_info(follow_sell_task_items)`).all();
  if (!fstiCols.some((c) => c.name === 'stock_set')) {
    db.exec(`ALTER TABLE follow_sell_task_items ADD COLUMN stock_set INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_task_items.stock_set');
  }
  if (!fstiCols.some((c) => c.name === 'stock_attempts')) {
    db.exec(`ALTER TABLE follow_sell_task_items ADD COLUMN stock_attempts INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_task_items.stock_attempts');
  }
  // has_error / has_warning:按 errors[].level 计算,用于 summarizeTaskStatus 判断
  // imported + has_error=1 视为审核拒绝(失败),has_warning=1 视为有警告但成功
  if (!fstiCols.some((c) => c.name === 'has_error')) {
    db.exec(`ALTER TABLE follow_sell_task_items ADD COLUMN has_error INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_task_items.has_error');
  }
  if (!fstiCols.some((c) => c.name === 'has_warning')) {
    db.exec(`ALTER TABLE follow_sell_task_items ADD COLUMN has_warning INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_task_items.has_warning');
  }
  // 采集域迁移已拆分到 collect-db.js / collect-migrations.js(collect.db 独立库)
  // P2-2: 批量均衡上架 — batch_upload_tasks / batch_upload_items 补列(多店铺分配 + 顺序执行 + 速度控制)
  migrateBatchUploadTables(db);
  // 2026-09-15: 妙手旗帜/标签/留言 + 订单处理本地标签备注 — 补列(见 migrateMiaoshouTagFields)
  migrateMiaoshouTagFields(db);
  // 2026-07: watermark_templates.name UNIQUE 索引(旧库 schema 没有 UNIQUE,需补建)
  // 若已存在重名行,迁移前先去重(保留最早 id),再建 UNIQUE 索引
  const wmCols = db.prepare(`PRAGMA table_info(watermark_templates)`).all();
  if (wmCols.length > 0) {
    const dupNames = db
      .prepare(`SELECT name, COUNT(*) as n FROM watermark_templates GROUP BY name HAVING n > 1`)
      .all();
    if (dupNames.length > 0) {
      // 重名行:保留最小 id,其余改为 "{name}_{id}" 避免冲突
      for (const d of dupNames) {
        const rows = db
          .prepare(`SELECT id, name FROM watermark_templates WHERE name=? ORDER BY id ASC`)
          .all(d.name);
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          db.prepare(`UPDATE watermark_templates SET name=? WHERE id=?`).run(`${r.name}_${r.id}`, r.id);
        }
      }
      console.log(`[db] migration: deduplicated ${dupNames.length} watermark_templates names`);
    }
    const idxExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='watermark_templates' AND name='idx_wm_name_unique'`)
      .get();
    if (!idxExists) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_name_unique ON watermark_templates(name)`);
      console.log('[db] migration: created UNIQUE index watermark_templates.name');
    }
  }
  // 采集域迁移(ozon_cache_index 列/回填/缓存重构/店铺分类补列)已拆分到 collect-db.js

  // 2026-09-10: op_purchase_link 去重 + 唯一索引修复
  // 问题:UNIQUE(purchase_order_id, package_id, ozon_order_item_id) 中 NULL 不参与查重,
  //      导致包裹级关联(ozon_order_item_id IS NULL)每次妙手同步都重复插入
  // 修复:1) 删除存量重复行(保留最小 id);2) 建基于 COALESCE 表达式的唯一索引
  {
    // 删除重复行:同一 (purchase_order_id, package_id, COALESCE(ozon_order_item_id, 0)) 只保留最小 id
    const dupCount = db.prepare(`
      SELECT COUNT(*) AS n FROM op_purchase_link
      WHERE id NOT IN (
        SELECT MIN(id) FROM op_purchase_link
        GROUP BY purchase_order_id, package_id, COALESCE(ozon_order_item_id, 0)
      )
    `).get();
    if (dupCount.n > 0) {
      db.exec(`
        DELETE FROM op_purchase_link
        WHERE id NOT IN (
          SELECT MIN(id) FROM op_purchase_link
          GROUP BY purchase_order_id, package_id, COALESCE(ozon_order_item_id, 0)
        )
      `);
      console.log(`[db] migration: removed ${dupCount.n} duplicate op_purchase_link rows`);
    }
    // 建唯一索引:COALESCE 让 NULL 变 0,参与唯一约束
    // DROP 旧的表级 UNIQUE 约束(如果有);SQLite 3.8+ 支持表达式索引
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_op_pl_unique ON op_purchase_link(purchase_order_id, package_id, COALESCE(ozon_order_item_id, 0))`);
    console.log('[db] migration: created UNIQUE index op_purchase_link(purchase_order_id, package_id, COALESCE(ozon_order_item_id, 0))');
  }
}

// 一次性回填 product_data_cache.description_quality
// v3 product/info/list 不返回 description,描述仅在 product_attributes_cache.description_data 中缓存
// (由「同步描述」或属性面板拉取 /v1/product/info/description 后写入)
// 回填从 product_attributes_cache.description_data 提取 description 并 classify
// 用 JS 正则精准分类(与 admin.js、index-dao.js syncSku 同口径),
// SQLite 无内建正则,故逐行读出 → classify → 批量 UPDATE(事务包裹)
function backfillProductDescriptionQuality() {
  const rows = db
    .prepare(
      `SELECT p.sku AS sku, json_extract(a.description_data, '$.result.description') AS desc
       FROM product_data_cache p
       JOIN product_attributes_cache a ON a.sku = p.sku
       WHERE a.description_data IS NOT NULL`
    )
    .all();
  if (!rows.length) return;
  const update = db.prepare(`UPDATE product_data_cache SET description_quality = ? WHERE sku = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      update.run(classifyDescriptionQuality(r.desc), r.sku);
    }
  });
  tx();
  console.log(`[db] migration: backfilled product_data_cache.description_quality for ${rows.length} products (from product_attributes_cache)`);
}

// 清理旧 collect_box_v2 表(及其索引)
// 数据已迁移到 7 类缓存表(cardCache 为基准 + 6 类辅助),采集箱前端只用缓存视图
function dropLegacyCollectBoxV2(db) {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='collect_box_v2'`)
    .get();
  if (exists) {
    db.exec(`DROP TABLE IF EXISTS collect_box_v2`);
    console.log('[db] migration: dropped legacy table collect_box_v2 (已用缓存视图替代)');
  }
}

// 2026-09-15: 妙手旗帜/标签/留言 + 订单处理本地标签备注 — 三表补列
// 1) miaoshou_package: flag_remarks/flags_json/tag_map_json/buyer_message/seller_note(插件新提取字段)
// 2) op_package: tags(本地标签,逗号分隔)/ms_flag_remarks(妙手旗帜备注同步展示)
// 新库由 schema.sql CREATE TABLE IF NOT EXISTS 直接建好,此函数幂等跳过
function migrateMiaoshouTagFields(db) {
  const msCols = db.prepare(`PRAGMA table_info(miaoshou_package)`).all();
  if (msCols.length > 0) {
    for (const [col, ddl] of [
      ['flag_remarks', `ALTER TABLE miaoshou_package ADD COLUMN flag_remarks TEXT`],
      ['flags_json', `ALTER TABLE miaoshou_package ADD COLUMN flags_json TEXT`],
      ['tag_map_json', `ALTER TABLE miaoshou_package ADD COLUMN tag_map_json TEXT`],
      ['buyer_message', `ALTER TABLE miaoshou_package ADD COLUMN buyer_message TEXT`],
      ['seller_note', `ALTER TABLE miaoshou_package ADD COLUMN seller_note TEXT`],
    ]) {
      if (!msCols.some((c) => c.name === col)) {
        db.exec(ddl);
        console.log(`[db] migration: added column miaoshou_package.${col}`);
      }
    }
  }
  const pkgCols = db.prepare(`PRAGMA table_info(op_package)`).all();
  if (pkgCols.length > 0) {
    if (!pkgCols.some((c) => c.name === 'tags')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN tags TEXT`);
      console.log('[db] migration: added column op_package.tags');
    }
    if (!pkgCols.some((c) => c.name === 'ms_flag_remarks')) {
      db.exec(`ALTER TABLE op_package ADD COLUMN ms_flag_remarks TEXT`);
      console.log('[db] migration: added column op_package.ms_flag_remarks');
    }
    // 2026-09-15 v4: 标签全局顺序表(筛选下拉/选择面板/订单 chip 三处共用同一顺序)
    db.exec(`CREATE TABLE IF NOT EXISTS op_tag_order (
      tag_name   TEXT PRIMARY KEY,
      sort_no    INTEGER NOT NULL,
      gmt_create TEXT
    )`);
    // 2026-09-15 v3: 存量妙手旗帜(ms_flag_remarks)并入本地标签(tags),统一筛选/编辑
    // 一次性迁移(标记表防重复):用户手动删除同步标签后,重启不得复活;
    // 之后主动"从妙手同步"时由 syncFromMiaoshou 的幂等合并负责以妙手为准
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migration_flags (key TEXT PRIMARY KEY, done_at TEXT NOT NULL)`);
    const MIGRATION_KEY = 'ms_flags_merged_into_tags_20260915';
    if (!db.prepare(`SELECT 1 FROM schema_migration_flags WHERE key = ?`).get(MIGRATION_KEY)) {
      const rows = db
        .prepare(`SELECT id, tags, ms_flag_remarks FROM op_package WHERE ms_flag_remarks IS NOT NULL AND ms_flag_remarks != ''`)
        .all();
      if (rows.length > 0) {
        const upd = db.prepare(`UPDATE op_package SET tags = ? WHERE id = ?`);
        let merged = 0;
        for (const r of rows) {
          const flag = String(r.ms_flag_remarks).trim();
          const existing = String(r.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
          if (flag && !existing.includes(flag)) {
            upd.run([...existing, flag].join(','), r.id);
            merged++;
          }
        }
        if (merged > 0) console.log(`[db] migration: merged ${merged} ms flag remarks into op_package.tags`);
      }
      db.prepare(`INSERT INTO schema_migration_flags (key, done_at) VALUES (?, ?)`).run(MIGRATION_KEY, new Date().toISOString());
    }
  }
}

// P2-2: 批量均衡上架 — batch_upload_tasks / batch_upload_items 补列
// 旧库(P2-1 阶段建的表)缺 P2-2 新增列,需 ALTER TABLE 补列 + 建索引
// 新库由 schema.sql CREATE TABLE IF NOT EXISTS 直接建好,此函数幂等跳过
function migrateBatchUploadTables(db) {
  // ── batch_upload_tasks 补列 ──
  const butCols = db.prepare(`PRAGMA table_info(batch_upload_tasks)`).all();
  if (butCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)
  if (!butCols.some((c) => c.name === 'batch_no')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN batch_no TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.batch_no');
  }
  if (!butCols.some((c) => c.name === 'name')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN name TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.name');
  }
  if (!butCols.some((c) => c.name === 'store_ids')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN store_ids TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.store_ids');
  }
  if (!butCols.some((c) => c.name === 'skipped_count')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN skipped_count INTEGER DEFAULT 0`);
    console.log('[db] migration: added column batch_upload_tasks.skipped_count');
  }
  if (!butCols.some((c) => c.name === 'speed_config')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN speed_config TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.speed_config');
  }
  if (!butCols.some((c) => c.name === 'started_at')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN started_at TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.started_at');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_but_status ON batch_upload_tasks(status, created_at DESC)`);

  // ── batch_upload_items 补列 ──
  const buiCols = db.prepare(`PRAGMA table_info(batch_upload_items)`).all();
  if (buiCols.length === 0) return;
  if (!buiCols.some((c) => c.name === 'seq')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN seq INTEGER DEFAULT 0`);
    console.log('[db] migration: added column batch_upload_items.seq');
  }
  if (!buiCols.some((c) => c.name === 'seller_id')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN seller_id TEXT`);
    console.log('[db] migration: added column batch_upload_items.seller_id');
  }
  if (!buiCols.some((c) => c.name === 'target_store_id')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN target_store_id TEXT`);
    console.log('[db] migration: added column batch_upload_items.target_store_id');
  }
  if (!buiCols.some((c) => c.name === 'skip_reason')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN skip_reason TEXT`);
    console.log('[db] migration: added column batch_upload_items.skip_reason');
  }
  if (!buiCols.some((c) => c.name === 'started_at')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN started_at TEXT`);
    console.log('[db] migration: added column batch_upload_items.started_at');
  }
  if (!buiCols.some((c) => c.name === 'finished_at')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN finished_at TEXT`);
    console.log('[db] migration: added column batch_upload_items.finished_at');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bui_batch_seq ON batch_upload_items(batch_task_id, seq)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bui_status ON batch_upload_items(status)`);
}

// 模块加载时自动建表(2026-09-23 修复:新库直接 npm run dev 必崩——ESM 静态 import 链中
// audit.js 等模块的顶层 db.prepare 先于 app.js 主体的 await initSchema() 执行,空库无表直接炸;
// 此处顶层 await 保证任何 import db 的入口(服务/脚本)都在表结构就绪后才继续。initSchema 幂等,老库重复执行无副作用)
await initSchema();

// 直接运行时初始化(node src/db/index.js,即 npm run init-db;建表已在上方完成,仅打印确认)
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('db/index.js');
if (isMain) {
  console.log('[db] schema initialized at', DB_PATH);
  db.close();
  process.exit(0);
}
