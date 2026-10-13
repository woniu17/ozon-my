// 采集数据库初始化(2026-10-13)
// 浅度采集/深度采集/店铺分类/采集队列等采集域数据独立存储到 data/collect.db,
// 主库 data/erp.db 只保留订单/采购/商品/上架等业务数据。
// 采集脚本(qxqx)与前端都走 HTTP API,不感知此拆分。
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { ensureCollectMigrations } from './collect-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 与主库同目录(ERP_DATA_DIR 给测试/多实例留出隔离目录)
const DATA_DIR = process.env.ERP_DATA_DIR || join(__dirname, '..', '..', 'data');
const COLLECT_DB_PATH = join(DATA_DIR, 'collect.db');
const COLLECT_SCHEMA_PATH = join(__dirname, 'collect-schema.sql');

// 确保数据目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// 第二个 SQLite 连接:采集库
export const collectDb = new DatabaseSync(COLLECT_DB_PATH, { allowUnknownNamedParameters: true });
collectDb.exec('PRAGMA journal_mode = WAL;');
collectDb.exec('PRAGMA foreign_keys = ON;');

export function getCollectDb() {
  return collectDb;
}

// 初始化采集库 schema + 迁移
// mainDb:主库连接,仅 ensureCollectMigrations 中 migrateListedFields 跨库回填使用
export async function initCollectSchema(mainDb) {
  // 旧采集库列重命名(与主库同口径;新库直接建出 isMainlandChina,此块幂等跳过)
  const scCols = collectDb.prepare(`PRAGMA table_info(ozon_store_classification)`).all();
  if (scCols.length > 0 && scCols.some((c) => c.name === 'isChinese')) {
    collectDb.exec(`ALTER TABLE ozon_store_classification RENAME COLUMN isChinese TO isMainlandChina`);
    collectDb.exec(`DROP INDEX IF EXISTS idx_sc_chinese`);
    console.log('[collect-db] migration: renamed column ozon_store_classification.isChinese → isMainlandChina');
  }
  const legacyCols = collectDb.prepare(`PRAGMA table_info(ozon_store_classification_legacy)`).all();
  if (legacyCols.length > 0 && legacyCols.some((c) => c.name === 'isChinese')) {
    collectDb.exec(`ALTER TABLE ozon_store_classification_legacy RENAME COLUMN isChinese TO isMainlandChina`);
    console.log('[collect-db] migration: renamed column ozon_store_classification_legacy.isChinese → isMainlandChina');
  }

  collectDb.exec(readFileSync(COLLECT_SCHEMA_PATH, 'utf-8'));
  await ensureCollectMigrations(mainDb, collectDb);
  console.log('[collect-db] schema initialized at', COLLECT_DB_PATH);
}