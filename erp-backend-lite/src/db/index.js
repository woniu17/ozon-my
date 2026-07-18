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
export function initSchema() {
  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);
  ensureMigrations();
}

// 轻量迁移:为已存在的表补列(CREATE TABLE IF NOT EXISTS 不会更新旧表结构)
function ensureMigrations() {
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
  // 缓存表重构:直接 DROP 旧 7 表 + legacy 表,新版用 6 张表(1 索引 + 5 数据)
  // 不写迁移脚本,旧数据自然过期(SW 重新采集填充新表)
  dropLegacyCacheTables(db);
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
  initSchema();
  console.log('[db] schema initialized at', DB_PATH);
  db.close();
  process.exit(0);
}
