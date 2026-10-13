#!/usr/bin/env node
// SQLite 数据库一致性备份(VACUUM INTO)
// WAL 模式下直接 cp 主文件会漏掉 WAL 中未 checkpoint 的数据;
// VACUUM INTO 生成一致性快照,服务运行期间也可安全备份。
// 用法:
//   node scripts/backup-sqlite.mjs <源db路径> <目标db路径>
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error('用法: node scripts/backup-sqlite.mjs <源db路径> <目标db路径>');
  process.exit(1);
}
if (!existsSync(src)) {
  console.error(`[backup-sqlite] 源 db 不存在: ${src}`);
  process.exit(1);
}

const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
db.close();
console.log(`[backup-sqlite] ${src} → ${dst}`);