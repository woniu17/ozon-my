// 数据库初始化(node:sqlite 内置驱动)
// 启动时自动创建 data/ 目录、打开 DB、执行 schema.sql
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config/index.js';
import logger from '../middleware/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

let db = null;

export async function initSchema() {
  // 确保 data 目录存在
  const dbPath = config.sqlitePath;
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);

  logger.info({ path: dbPath }, 'SQLite 初始化完成');
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB 未初始化,请先调用 initSchema()');
  return db;
}

// 直接运行 src/db/index.js 时执行 schema 初始化
// 用法:node --experimental-sqlite src/db/index.js
if (import.meta.url === `file://${process.argv[1]}`) {
  await initSchema();
  logger.info('schema 初始化完成,退出');
  process.exit(0);
}
