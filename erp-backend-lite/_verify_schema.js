// 临时验证脚本:检查 schema.sql 建表是否正确
import { initSchema, db } from './src/db/index.js';
initSchema();
console.log('schema init OK');
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'ozon_%' OR name LIKE 'collect_queue_%') ORDER BY name"
  )
  .all();
console.log('new tables:', tables.map((t) => t.name).join(', '));

// 检查索引
const indexes = db
  .prepare(
    "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND (tbl_name LIKE 'ozon_%' OR tbl_name LIKE 'collect_queue_%') AND sql IS NOT NULL ORDER BY tbl_name, name"
  )
  .all();
console.log('indexes:', indexes.map((i) => `${i.tbl_name}.${i.name}`).join(', '));

// 检查 snapshot 单行表
const snapshot = db.prepare('SELECT * FROM collect_queue_snapshot').get();
console.log('snapshot row:', snapshot);

db.close();
process.exit(0);
