// SQLite 数据库初始化(使用 Node 22.5+ 内置的 node:sqlite,零原生依赖)
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_PATH = join(DATA_DIR, 'erp.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

// 确保数据目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// 初始化 schema
export async function initSchema() {
  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);
  await ensureMigrations();
}

// 轻量迁移:为已存在的表补列(CREATE TABLE IF NOT EXISTS 不会更新旧表结构)
async function ensureMigrations() {
  // product_data_cache.store_id(用于关联店铺,拉特征/描述时需用对应店铺凭据)
  const cols = db.prepare(`PRAGMA table_info(product_data_cache)`).all();
  if (!cols.some((c) => c.name === 'store_id')) {
    db.exec(`ALTER TABLE product_data_cache ADD COLUMN store_id TEXT`);
    console.log('[db] migration: added column product_data_cache.store_id');
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
  // collect_queue_tasks:增加 duration 列(SW result 接口上报任务耗时)
  const taskCols = db.prepare(`PRAGMA table_info(collect_queue_tasks)`).all();
  if (!taskCols.some((c) => c.name === 'duration')) {
    db.exec(`ALTER TABLE collect_queue_tasks ADD COLUMN duration INTEGER`);
    console.log('[db] migration: added column collect_queue_tasks.duration');
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
  // 2026-07: sellerSlug → sellerId 主键迁移
  // 1) ozon_cache_index 补 seller_id 列 + 索引,从 ozon_store_sku 反查回填
  // 2) ozon_auto_collect_log 补 sellerId 列 + 索引,从 ozon_store_sku 反查回填
  // 3) ozon_store_classification 重建表(_id = sellerId),旧表数据迁移到 legacy 表
  await migrateSellerIdPrimaryKey(db);
  // 2026-07: 清理 ozon_store_classification 中 _id 非 数字 的脏记录(slug 被当 sellerId 写入)
  await cleanupStoreClassificationDirtyRows(db);
  // 2026-07: 类目过滤功能 — ozon_cache_index 补类目列 + 索引 + 从 bundle_data 回填
  await migrateCategoryFields(db);
  // 2026-07: 跟卖状态即时标记 — ozon_cache_index 补 listed_store_id/listed_at/listed_task_id 列
  // 并从 follow_sell_task_items + follow_sell_tasks 一次性回填(取最近一条任务)
  await migrateListedFields(db);
  // P2-2: 批量均衡上架 — batch_upload_tasks / batch_upload_items 补列(多店铺分配 + 顺序执行 + 速度控制)
  migrateBatchUploadTables(db);
  // ozon_cache_index.has_rich_content:richMedia.data.richContent 非空则 1,用于采集箱"有富内容"筛选
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  let addedHasRichContent = false;
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'has_rich_content')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN has_rich_content INTEGER DEFAULT 0`);
    console.log('[db] migration: added column ozon_cache_index.has_rich_content');
    addedHasRichContent = true;
  }
  // 缓存表重构:直接 DROP 旧 7 表 + legacy 表,新版用 6 张表(1 索引 + 5 数据)
  // 不写迁移脚本,旧数据自然过期(SW 重新采集填充新表)
  dropLegacyCacheTables(db);
  // 索引表新增 price_value 列 + FTS5 虚拟表 + 触发器
  ensureCacheIndexFtsAndPriceValue(db);
  // 一次性回填:旧 syncSku 的 name fallback 只看 card.name + detail.title,
  // DOM 解析失败时即使 bundle/search 有 4180 也写入空 name。
  // 新 syncSku 扩展 fallback 链后,需主动重算历史空 name 行。
  // 注:动态 import 避免循环依赖(db 模块初始化时 index-dao 尚未加载)
  await backfillEmptyNames().catch((e) => {
    console.warn('[db] migration: backfillEmptyNames failed:', e?.message || e);
  });
  // 一次性回填:has_rich_content 列刚加上时,旧 syncSku 未计算此字段(默认 0)
  // 对 rich_media_hit=1 的 SKU 从 ozon_rich_media_cache 重算 has_rich_content
  if (addedHasRichContent) {
    backfillHasRichContent();
  }
}

// 一次性回填 ozon_cache_index.has_rich_content
// 旧 syncSku 不计算此字段,新增列后默认 0,需对 rich_media_hit=1 的 SKU 重算
// 逻辑与 index-dao.js syncSku 一致:richMedia.data.richContent 非空(字符串长度>0) → 1
function backfillHasRichContent() {
  const result = db
    .prepare(
      `UPDATE ozon_cache_index
       SET has_rich_content = COALESCE((
         SELECT CASE 
           WHEN json_extract(r.data, '$.richContent') IS NOT NULL
             AND LENGTH(CAST(json_extract(r.data, '$.richContent') AS TEXT)) > 0
           THEN 1 ELSE 0 END
         FROM ozon_rich_media_cache r 
         WHERE r._id = ozon_cache_index.sku
       ), 0)
       WHERE rich_media_hit = 1`
    )
    .run();
  console.log(
    `[db] migration: backfilled has_rich_content for ${result.changes} SKUs (rich_media_hit=1)`
  );
}

// 一次性回填 ozon_cache_index.name 为空但有缓存的 SKU
// 通过动态 import indexDao 调用 syncSku,沿用最新 fallback 链
async function backfillEmptyNames() {
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ozon_cache_index
       WHERE (name IS NULL OR name = '')
         AND (card_hit=1 OR detail_hit=1 OR search_hit=1 OR bundle_hit=1
              OR rich_media_hit=1 OR market_stats_hit=1 OR follow_sell_hit=1)`
    )
    .get();
  if (!stats.n) return;
  console.log(`[db] migration: backfilling name for ${stats.n} SKUs with empty name...`);
  // 预防性 rebuild FTS5:旧库 FTS5 索引可能对部分行损坏(报 "database disk image is malformed"),
  // rebuild 后这些行才能正常 upsert 触发器
  try {
    db.exec(`INSERT INTO ozon_cache_index_fts(ozon_cache_index_fts) VALUES('rebuild')`);
  } catch (e) {
    console.warn('[db] migration: FTS5 rebuild failed:', e?.message || e);
  }
  const { indexDao } = await import('./dao/sqlite/index-dao.js');
  const skus = db
    .prepare(
      `SELECT sku FROM ozon_cache_index
       WHERE (name IS NULL OR name = '')
         AND (card_hit=1 OR detail_hit=1 OR search_hit=1 OR bundle_hit=1
              OR rich_media_hit=1 OR market_stats_hit=1 OR follow_sell_hit=1)`
    )
    .all()
    .map((r) => r.sku);
  let fixed = 0;
  for (const sku of skus) {
    try {
      await indexDao.syncSku(sku);
      fixed++;
    } catch (e) {
      console.warn(`[db] migration: syncSku failed for ${sku}:`, e?.message || e);
    }
  }
  console.log(`[db] migration: backfilled name for ${fixed}/${skus.length} SKUs`);
}

// 旧表迁移:为 ozon_cache_index 补 price_value 列 + 一次性 rebuild FTS5 索引
// 注:price_value/FTS5 在 schema.sql 中已对全新库创建,本函数只为旧库补列 + 重建索引
function ensureCacheIndexFtsAndPriceValue(db) {
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)
  if (!ciCols.some((c) => c.name === 'price_value')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN price_value REAL`);
    console.log('[db] migration: added column ozon_cache_index.price_value');
    // 回填:从 price 字段解析数字写入 price_value
    // 与 index-dao.js 的 parsePriceValue 保持一致:去掉所有非数字非小数点字符
    //   "1 299 ₽" → 1299,"1,299.50" → 1299.50,"1299.00" → 1299.00
    // 注:用嵌套 REPLACE 去除常见符号 + 逗号(避免 SQLite CAST 对 "1,299" 截断为 1)
    db.exec(`
      UPDATE ozon_cache_index
      SET price_value = CAST(
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
          price, ' ', ''), ',', ''), '₽', ''), '€', ''), '$', ''), '￥', ''
        ) AS REAL
      )
      WHERE price IS NOT NULL AND price <> ''
    `);
    console.log('[db] migration: backfilled price_value from price');
  }
  // idx_ci_price_value 索引:在 schema.sql 中已移除,统一在此创建
  // (旧库需先 ALTER TABLE 补列再建索引,新库 ALTER 跳过,索引直接创建)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_price_value ON ozon_cache_index(price_value)`);
  // 删除旧的 idx_ci_fts(普通 B-tree,对 LIKE '%keyword%' 无效,被 FTS5 虚拟表替代)
  db.exec(`DROP INDEX IF EXISTS idx_ci_fts`);
  // 确保 FTS5 虚拟表与触发器存在(schema.sql 已创建,但旧库需补)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ozon_cache_index_fts USING fts5(
      sku, name, seller_name,
      content='ozon_cache_index', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  db.exec(`
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
  `);
  // 一次性 rebuild FTS5 索引(若 FTS5 表为空但 ozon_cache_index 非空,说明是旧库首次升级)
  const ftsCount = db.prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index_fts`).get().n;
  const ciCount = db.prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index`).get().n;
  if (ciCount > 0 && ftsCount === 0) {
    db.exec(`
      INSERT INTO ozon_cache_index_fts(rowid, sku, name, seller_name)
      SELECT rowid, sku, name, seller_name FROM ozon_cache_index
    `);
    console.log(`[db] migration: rebuilt FTS5 index with ${ciCount} rows`);
  }
}

// 清理旧缓存表(card/detail/search/bundle/composer/entrypoint 已合并为 dom/attribute)
function dropLegacyCacheTables(db) {
  const legacyTables = [
    'ozon_card_cache',
    'ozon_detail_cache',
    'ozon_search_cache',
    'ozon_bundle_cache',
    'ozon_composer_cache',
    'ozon_entrypoint_cache',
  ];
  for (const name of legacyTables) {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name);
    if (exists) {
      db.exec(`DROP TABLE IF EXISTS ${name}`);
      console.log(`[db] migration: dropped legacy table ${name} (已合并到 dom/attribute)`);
    }
  }
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

// 2026-07: 清理 ozon_store_classification 中 _id 非数字的脏记录
// 根因:SW _erpStoreClassSet 曾在 sellerId 为空时 fallback 用 slug 作为 _id 写入主表,
// 产生 _id='xizixiaopu' 之类脏数据(同一 slug 后续拿到真实 sellerId 后会再写一条 _id=数字 的正确记录)。
// 清理策略:
//   - _id 非数字 + 同一 slug 已有数字 ID 记录 → 直接删除脏记录(信息已由正确记录保留)
//   - _id 非数字 + 同一 slug 无数字 ID 记录 → 迁移到 legacy 表后删除(保留历史分类信息)
// 幂等:无脏记录时直接跳过。
async function cleanupStoreClassificationDirtyRows(db) {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ozon_store_classification'`)
    .get();
  if (!tableExists) return;

  const dirtyRows = db
    .prepare(`SELECT _id, sellerSlug, sellerId, sellerName, isChinese, classifiedBy, companyInfo, classifiedAt, lastSeenAt, lastSeenUrl FROM ozon_store_classification WHERE _id NOT GLOB '[0-9]*'`)
    .all();
  if (dirtyRows.length === 0) return;

  let deleted = 0;
  let migrated = 0;
  for (const d of dirtyRows) {
    const slug = d.sellerSlug || '';
    // 查同一 slug 是否已有数字 ID 的正确记录
    const correct = slug
      ? db
          .prepare(`SELECT _id FROM ozon_store_classification WHERE sellerSlug = ? AND _id GLOB '[0-9]*'`)
          .get(slug)
      : null;
    if (correct) {
      // 已有正确记录,直接删除脏记录
      db.prepare(`DELETE FROM ozon_store_classification WHERE _id = ?`).run(d._id);
      deleted++;
    } else {
      // 无正确记录,迁移到 legacy 表后删除
      db.prepare(
        `INSERT OR REPLACE INTO ozon_store_classification_legacy (_id, sellerSlug, sellerId, sellerName, isChinese, classifiedBy, companyInfo, classifiedAt, lastSeenAt, lastSeenUrl, migratedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        d._id, slug, d.sellerId || '', d.sellerName || '', d.isChinese, d.classifiedBy || '',
        d.companyInfo || null, d.classifiedAt, d.lastSeenAt, d.lastSeenUrl || '', new Date().toISOString()
      );
      db.prepare(`DELETE FROM ozon_store_classification WHERE _id = ?`).run(d._id);
      migrated++;
    }
  }
  console.log(`[db] migration: cleanupStoreClassificationDirtyRows 删除 ${deleted} 条,迁移到 legacy ${migrated} 条`);
}

// 2026-07: sellerSlug → sellerId 主键迁移
// 三件事:
//  1) ozon_cache_index 补 seller_id 列 + 索引,从 ozon_store_sku 反查回填
//  2) ozon_auto_collect_log 补 sellerId 列 + 索引,从 ozon_store_sku 反查回填
//  3) ozon_store_classification 重建表(_id = sellerId),旧表数据迁移到 legacy 表
// 幂等:已迁移过的库(新表结构)直接跳过。
async function migrateSellerIdPrimaryKey(db) {
  // ── Step 1: ozon_cache_index 补 seller_id 列 + 索引 ──
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'seller_id')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN seller_id TEXT`);
    console.log('[db] migration: added column ozon_cache_index.seller_id');
    // 从 ozon_store_sku 反查回填(优先 sellerId 非空的记录)
    // 多条 store_sku 记录同一 sku 时取最近一条(lastSeenAt DESC)
    db.exec(`
      UPDATE ozon_cache_index
      SET seller_id = (
        SELECT s.sellerId FROM ozon_store_sku s
        WHERE s._id = ozon_cache_index.sku
          AND s.sellerId IS NOT NULL AND s.sellerId != ''
        ORDER BY s.lastSeenAt DESC LIMIT 1
      )
      WHERE seller_id IS NULL
    `);
    const filled = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index WHERE seller_id IS NOT NULL AND seller_id != ''`)
      .get().n;
    console.log(`[db] migration: backfilled ozon_cache_index.seller_id for ${filled} rows`);
  }
  // 索引(schema.sql 已声明,IF NOT EXISTS 幂等)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_seller_id ON ozon_cache_index(seller_id)`);

  // ── Step 2: ozon_auto_collect_log 补 sellerId 列 + 索引 ──
  const logCols = db.prepare(`PRAGMA table_info(ozon_auto_collect_log)`).all();
  if (logCols.length > 0 && !logCols.some((c) => c.name === 'sellerId')) {
    db.exec(`ALTER TABLE ozon_auto_collect_log ADD COLUMN sellerId TEXT`);
    console.log('[db] migration: added column ozon_auto_collect_log.sellerId');
    // 从 ozon_store_sku 反查回填(按 sellerSlug 关联)
    // 一条 log 的 sellerSlug 可能对应多条 store_sku,取最近一条的 sellerId
    db.exec(`
      UPDATE ozon_auto_collect_log
      SET sellerId = (
        SELECT s.sellerId FROM ozon_store_sku s
        WHERE s.sellerSlug = ozon_auto_collect_log.sellerSlug
          AND s.sellerId IS NOT NULL AND s.sellerId != ''
        ORDER BY s.lastSeenAt DESC LIMIT 1
      )
      WHERE sellerId IS NULL
        AND sellerSlug IS NOT NULL AND sellerSlug != ''
    `);
    const filled = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_auto_collect_log WHERE sellerId IS NOT NULL AND sellerId != ''`)
      .get().n;
    console.log(`[db] migration: backfilled ozon_auto_collect_log.sellerId for ${filled} rows`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_log_sellerId_time ON ozon_auto_collect_log(sellerId, collectedAt DESC)`
  );

  // ── Step 3: ozon_store_classification 重建表(_id = sellerId) ──
  // 检测旧表结构:_id = sellerSlug(旧)vs _id = sellerId(新)
  // 旧表 sellerSlug NOT NULL + sellerId 可空;新表 sellerId NOT NULL + sellerSlug 可空
  const scCols = db.prepare(`PRAGMA table_info(ozon_store_classification)`).all();
  if (scCols.length > 0) {
    const sellerIdCol = scCols.find((c) => c.name === 'sellerId');
    const isOldSchema = sellerIdCol && (sellerIdCol.notnull === 0 || sellerIdCol.dflt_value === null);
    // 旧表特征:sellerId 可为空(NOT NULL = 0);新表特征:sellerId NOT NULL
    if (isOldSchema && sellerIdCol.notnull === 0) {
      console.log('[db] migration: rebuilding ozon_store_classification (_id = sellerId)');

      // 确保新表 + legacy 表已创建(schema.sql 已声明,但旧库可能没有)
      db.exec(`
        CREATE TABLE IF NOT EXISTS ozon_store_classification_new (
          _id           TEXT PRIMARY KEY,
          sellerId      TEXT NOT NULL,
          sellerSlug    TEXT,
          sellerName    TEXT,
          isChinese     INTEGER,
          classifiedBy  TEXT,
          classifiedAt  TEXT,
          companyInfo   TEXT,
          lastSeenAt    TEXT,
          lastSeenUrl   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sc_new_chinese ON ozon_store_classification_new(isChinese);
        CREATE INDEX IF NOT EXISTS idx_sc_new_name    ON ozon_store_classification_new(sellerName);
        CREATE INDEX IF NOT EXISTS idx_sc_new_seen    ON ozon_store_classification_new(lastSeenAt DESC);
        CREATE INDEX IF NOT EXISTS idx_sc_new_slug    ON ozon_store_classification_new(sellerSlug);

        CREATE TABLE IF NOT EXISTS ozon_store_classification_legacy (
          _id           TEXT PRIMARY KEY,
          sellerSlug    TEXT NOT NULL,
          sellerId      TEXT,
          sellerName    TEXT,
          isChinese     INTEGER,
          classifiedBy  TEXT,
          classifiedAt  TEXT,
          companyInfo   TEXT,
          lastSeenAt    TEXT,
          lastSeenUrl   TEXT,
          migratedAt    TEXT NOT NULL
        );
      `);

      // 1) sellerId 非空的记录迁移到新表(_id = sellerId)
      const migrated = db
        .prepare(
          `INSERT OR REPLACE INTO ozon_store_classification_new
           (_id, sellerId, sellerSlug, sellerName, isChinese, classifiedBy, classifiedAt,
            companyInfo, lastSeenAt, lastSeenUrl)
           SELECT sellerId, sellerId, sellerSlug, sellerName, isChinese, classifiedBy, classifiedAt,
                  companyInfo, lastSeenAt, lastSeenUrl
           FROM ozon_store_classification
           WHERE sellerId IS NOT NULL AND sellerId != ''`
        )
        .run();
      console.log(
        `[db] migration: migrated ${migrated.changes} rows to ozon_store_classification_new (_id = sellerId)`
      );

      // 2) sellerId 为空的记录迁移到 legacy 表
      const legacyCount = db
        .prepare(
          `INSERT OR REPLACE INTO ozon_store_classification_legacy
           (_id, sellerSlug, sellerId, sellerName, isChinese, classifiedBy, classifiedAt,
            companyInfo, lastSeenAt, lastSeenUrl, migratedAt)
           SELECT _id, sellerSlug, sellerId, sellerName, isChinese, classifiedBy, classifiedAt,
                  companyInfo, lastSeenAt, lastSeenUrl, datetime('now')
           FROM ozon_store_classification
           WHERE sellerId IS NULL OR sellerId = ''`
        )
        .run();
      console.log(
        `[db] migration: moved ${legacyCount.changes} rows to ozon_store_classification_legacy (sellerId 为空)`
      );

      // 3) 替换旧表
      db.exec(`
        DROP TABLE ozon_store_classification;
        ALTER TABLE ozon_store_classification_new RENAME TO ozon_store_classification;
      `);
      // 索引名规范化(去掉 _new 后缀)
      db.exec(`
        DROP INDEX IF EXISTS idx_sc_new_chinese;
        DROP INDEX IF EXISTS idx_sc_new_name;
        DROP INDEX IF EXISTS idx_sc_new_seen;
        DROP INDEX IF EXISTS idx_sc_new_slug;
        CREATE INDEX IF NOT EXISTS idx_sc_chinese ON ozon_store_classification(isChinese);
        CREATE INDEX IF NOT EXISTS idx_sc_name    ON ozon_store_classification(sellerName);
        CREATE INDEX IF NOT EXISTS idx_sc_seen    ON ozon_store_classification(lastSeenAt DESC);
        CREATE INDEX IF NOT EXISTS idx_sc_slug    ON ozon_store_classification(sellerSlug);
      `);
      console.log('[db] migration: ozon_store_classification rebuild complete');
    }
  }

  // ── Step 4: 浅度采集日志补 sellerId 索引(字段已在 schema.sql 中,索引补建) ──
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_shallow_log_sellerId_time ON ozon_shallow_collect_log(sellerId, collectedAt DESC)`
  );
}

// 2026-07: 类目过滤功能 — ozon_cache_index 补类目列 + 索引 + 从 bundle_data 回填
// 三件事:
//  1) 补 description_category_id / type_id / category_name 三列(旧库 ALTER TABLE)
//  2) 创建 idx_ci_desc_cat_id / idx_ci_type_id 索引
//  3) 从 ozon_attribute_cache.bundle_data(JSON)回填类目字段到索引表
// 幂等:已迁移过的库(新表结构)直接跳过。
async function migrateCategoryFields(db) {
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)

  // Step 1: 补列
  let addedDescCatId = false;
  let addedTypeId = false;
  let addedCategoryName = false;
  if (!ciCols.some((c) => c.name === 'description_category_id')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN description_category_id INTEGER`);
    console.log('[db] migration: added column ozon_cache_index.description_category_id');
    addedDescCatId = true;
  }
  if (!ciCols.some((c) => c.name === 'type_id')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN type_id INTEGER`);
    console.log('[db] migration: added column ozon_cache_index.type_id');
    addedTypeId = true;
  }
  if (!ciCols.some((c) => c.name === 'category_name')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN category_name TEXT`);
    console.log('[db] migration: added column ozon_cache_index.category_name');
    addedCategoryName = true;
  }

  // Step 2: 索引(IF NOT EXISTS 幂等)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_desc_cat_id ON ozon_cache_index(description_category_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_type_id ON ozon_cache_index(type_id)`);

  // Step 3: 从 bundle_data + search_data 回填类目字段(幂等:每次启动都执行,COALESCE 保留已有值)
  // 与 syncSku / prepare-bundle.js extractCategoryIds 同源:
  //   - type_id:优先 search_data.items[0].description_type_dict_value(注意:字段名误用,实际是 type_id)
  //              fallback bundle_data.type_id(bundle 接口通常不返此字段)
  //   - description_category_id:优先 search_data.categories 中 level=3 的类目(OPI 字典要求 level_3_id)
  //              fallback bundle_data.description_category_id(该值通常是 level_4,不保证正确)
  //   - category_name:detail_data.category(DOM 面包屑)
  // 注:SQLite UPDATE...FROM 在 JOIN ON/WHERE 中引用 target table 列时报错,改用相关子查询
  //     (与 backfillHasRichContent 的写法一致)
  if (addedDescCatId || addedTypeId || addedCategoryName) {
    console.log('[db] migration: backfilling category fields from bundle_data + search_data...');
  }
  const result = db
    .prepare(
      `UPDATE ozon_cache_index
       SET description_category_id = COALESCE(
             -- 优先 search_data.categories level=3
             (SELECT CASE
                       WHEN EXISTS (
                         SELECT 1 FROM json_each(
                           json_extract(a.search_data, '$.items[0].categories')
                         ) e
                         WHERE json_extract(e.value, '$.level') = '3'
                          OR json_extract(e.value, '$.level') = 3
                       )
                       THEN (
                         SELECT CAST(json_extract(e.value, '$.id') AS INTEGER)
                         FROM json_each(
                           json_extract(a.search_data, '$.items[0].categories')
                         ) e
                         WHERE json_extract(e.value, '$.level') = '3'
                            OR json_extract(e.value, '$.level') = 3
                         LIMIT 1
                       )
                       ELSE NULL
                     END
              FROM ozon_attribute_cache a
              WHERE a._id = ozon_cache_index.sku AND a.search_data IS NOT NULL),
             -- fallback bundle_data.description_category_id
             (SELECT CAST(json_extract(a.bundle_data, '$.description_category_id') AS INTEGER)
              FROM ozon_attribute_cache a
              WHERE a._id = ozon_cache_index.sku AND a.bundle_data IS NOT NULL
                AND json_extract(a.bundle_data, '$.description_category_id') IS NOT NULL),
             description_category_id),
           type_id = COALESCE(
             -- 优先 search_data.description_type_dict_value(实际是 type_id)
             (SELECT CAST(json_extract(a.search_data, '$.items[0].description_type_dict_value') AS INTEGER)
              FROM ozon_attribute_cache a
              WHERE a._id = ozon_cache_index.sku AND a.search_data IS NOT NULL
                AND json_extract(a.search_data, '$.items[0].description_type_dict_value') IS NOT NULL),
             -- fallback bundle_data.type_id
             (SELECT CAST(json_extract(a.bundle_data, '$.type_id') AS INTEGER)
              FROM ozon_attribute_cache a
              WHERE a._id = ozon_cache_index.sku AND a.bundle_data IS NOT NULL
                AND json_extract(a.bundle_data, '$.type_id') IS NOT NULL),
             type_id),
           category_name = COALESCE(
             (SELECT json_extract(d.detail_data, '$.category')
              FROM ozon_dom_cache d WHERE d._id = ozon_cache_index.sku),
             category_name)
       WHERE EXISTS (
         SELECT 1 FROM ozon_attribute_cache a
         WHERE a._id = ozon_cache_index.sku
           AND (a.bundle_data IS NOT NULL OR a.search_data IS NOT NULL)
       )`
    )
    .run();
  if (result.changes > 0) {
    console.log(
      `[db] migration: backfilled category fields for ${result.changes} SKUs`
    );
  }
}

// 2026-07: 跟卖状态即时标记 — 给 ozon_cache_index 补 listed_store_id/listed_at/listed_task_id 列
// 并从 follow_sell_task_items + follow_sell_tasks 一次性回填(取最近一条任务)
// 迁移后 listed 字段不再由 index-sync 定时任务刷新,改由 upsertTaskItems 即时写入
// 幂等:已迁移过的库(新表结构)直接跳过 ALTER,回填用 COALESCE 保留已有值
async function migrateListedFields(db) {
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)

  let addedListedStoreId = false;
  if (!ciCols.some((c) => c.name === 'listed_store_id')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN listed_store_id TEXT`);
    console.log('[db] migration: added column ozon_cache_index.listed_store_id');
    addedListedStoreId = true;
  }
  if (!ciCols.some((c) => c.name === 'listed_at')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN listed_at TEXT`);
    console.log('[db] migration: added column ozon_cache_index.listed_at');
  }
  if (!ciCols.some((c) => c.name === 'listed_task_id')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN listed_task_id TEXT`);
    console.log('[db] migration: added column ozon_cache_index.listed_task_id');
  }

  // 仅在首次新增 listed_store_id 列时执行回填(其他列一同被回填)
  // 后续启动时 listed 字段由 upsertTaskItems 维护,不再批量回填
  if (!addedListedStoreId) return;

  // 子查询:对每个 SKU 取最近一条 task_items 关联的 task(按 i.id DESC)
  // offer_id 格式:sku-variantId,用 SUBSTR(offer_id, 1, INSTR(offer_id, '-') - 1) 提取 SKU 前缀
  const result = db
    .prepare(
      `UPDATE ozon_cache_index
       SET listed = 1,
           listed_store_id = COALESCE(
             (SELECT t.store_id
              FROM follow_sell_task_items i
              JOIN follow_sell_tasks t ON t.local_task_id = i.local_task_id
              WHERE SUBSTR(i.offer_id, 1, INSTR(i.offer_id, '-') - 1) = ozon_cache_index.sku
                AND i.offer_id LIKE '%-%'
                AND t.store_id IS NOT NULL AND t.store_id != ''
              ORDER BY i.id DESC LIMIT 1),
             listed_store_id),
           listed_at = COALESCE(
             (SELECT t.created_at
              FROM follow_sell_task_items i
              JOIN follow_sell_tasks t ON t.local_task_id = i.local_task_id
              WHERE SUBSTR(i.offer_id, 1, INSTR(i.offer_id, '-') - 1) = ozon_cache_index.sku
                AND i.offer_id LIKE '%-%'
              ORDER BY i.id DESC LIMIT 1),
             listed_at),
           listed_task_id = COALESCE(
             (SELECT i.local_task_id
              FROM follow_sell_task_items i
              WHERE SUBSTR(i.offer_id, 1, INSTR(i.offer_id, '-') - 1) = ozon_cache_index.sku
                AND i.offer_id LIKE '%-%'
              ORDER BY i.id DESC LIMIT 1),
             listed_task_id)
       WHERE listed = 0
         AND sku IN (
           SELECT DISTINCT SUBSTR(offer_id, 1, INSTR(offer_id, '-') - 1)
           FROM follow_sell_task_items
           WHERE offer_id LIKE '%-%'
         )`
    )
    .run();
  console.log(
    `[db] migration: backfill listed fields for ${result.changes} SKUs`
  );
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

// 直接运行时初始化(node src/db/index.js)
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('db/index.js');
if (isMain) {
  initSchema()
    .then(() => {
      console.log('[db] schema initialized at', DB_PATH);
      db.close();
      process.exit(0);
    })
    .catch((e) => {
      console.error('[db] schema init failed:', e);
      process.exit(1);
    });
}
