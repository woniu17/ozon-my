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
