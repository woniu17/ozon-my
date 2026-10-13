#!/usr/bin/env node
// 一次性数据迁移:主库 erp.db 采集域表 → 独立采集库 collect.db(2026-10-13)
//
// 背景:
//   采集库拆分后,主库 schema.sql 不再包含采集表,但存量 erp.db 中仍有历史采集数据。
//   本脚本在部署时执行一次:把主库旧采集表数据复制到 collect.db,随后服务启动时
//   initCollectSchema 会自动完成剩余列迁移/回填(幂等)。
//
// 用法:
//   node scripts/migrate-collect-db.mjs
//   node scripts/migrate-collect-db.mjs --data-dir /path/to/data   # 指定数据目录
//
// 行为:
//   1) VACUUM INTO 备份主库到 <data-dir>/backup/erp-pre-collect-split-<ts>.db
//   2) 在 collect.db 执行 src/db/collect-schema.sql 建表
//   3) ATTACH collect.db,逐表动态列交集 INSERT OR IGNORE SELECT
//      (兼容旧列名 isChinese → isMainlandChina)
//   4) 行数对比校验,任一表迁移后行数少于主库则退出码 1
//
// 注意:
//   - ozon_cache_index_fts 是 FTS5 虚拟表,不直接复制;ozon_cache_index 插入时触发器自动同步
//   - collect_queue_snapshot 用 INSERT OR REPLACE(单行表,需要覆盖旧快照值)
//   - ozon_store_classification 若主库仍是旧结构(_id=sellerSlug),按 sellerId 重建 _id,
//     sellerId 为空的行迁入 legacy 表
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const argIdx = process.argv.indexOf('--data-dir');
const DATA_DIR =
  (argIdx >= 0 && process.argv[argIdx + 1]) ||
  process.env.ERP_DATA_DIR ||
  join(REPO_ROOT, 'data');
const MAIN_DB_PATH = join(DATA_DIR, 'erp.db');
const COLLECT_DB_PATH = join(DATA_DIR, 'collect.db');
const COLLECT_SCHEMA_PATH = join(REPO_ROOT, 'src', 'db', 'collect-schema.sql');

// 需要迁移的采集域表(FTS5 虚拟表除外)
const TABLES = [
  'ozon_cache_index',
  'ozon_dom_cache',
  'ozon_attribute_cache',
  'ozon_rich_media_cache',
  'ozon_market_stats_cache',
  'ozon_follow_sell_cache',
  'ozon_auto_collect_log',
  'ozon_shallow_collect_log',
  'ozon_store_classification_legacy',
  'ozon_store_sku',
  'collect_queue_tasks',
  'collect_queue_snapshot',
  'collect_queue_ops',
  'ozon_filtered_categories',
];

// 旧主库列名 → collect.db 新列名(collect-schema.sql 已用新名)
const COLUMN_ALIASES = { isChinese: 'isMainlandChina' };

if (!existsSync(MAIN_DB_PATH)) {
  console.error(`[migrate-collect] 主库不存在: ${MAIN_DB_PATH}`);
  process.exit(1);
}

mkdirSync(join(DATA_DIR, 'backup'), { recursive: true });

const mainDb = new DatabaseSync(MAIN_DB_PATH, { allowUnknownNamedParameters: true });
const collectDb = new DatabaseSync(COLLECT_DB_PATH, { allowUnknownNamedParameters: true });
collectDb.exec('PRAGMA journal_mode = WAL;');
collectDb.exec('PRAGMA foreign_keys = ON;');

let mismatch = false;
let totalCopied = 0;

// ── 1) 备份主库(VACUUM INTO 生成一致性快照,含 WAL 已提交数据) ──
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = join(DATA_DIR, 'backup', `erp-pre-collect-split-${ts}.db`);
mainDb.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
console.log(`[migrate-collect] 已备份主库 → ${backupPath}`);

// ── 2) 初始化 collect.db schema ──
collectDb.exec(readFileSync(COLLECT_SCHEMA_PATH, 'utf-8'));
console.log(`[migrate-collect] collect.db schema 就绪: ${COLLECT_DB_PATH}`);

// ── 3) ATTACH collect.db 到主库连接,单条 SQL 跨库复制 ──
mainDb.exec(`ATTACH DATABASE '${COLLECT_DB_PATH.replace(/'/g, "''")}' AS collect`);

function tableExists(conn, name) {
  return !!conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function genericCopy(table) {
  const srcExists = tableExists(mainDb, table);
  if (!srcExists) {
    console.log(`[migrate-collect] 主库无 ${table},跳过`);
    return;
  }
  const srcCount = mainDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  if (srcCount === 0) {
    console.log(`[migrate-collect] ${table}: 主库 0 行,跳过`);
    return;
  }
  const srcCols = mainDb.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  const dstColSet = new Set(collectDb.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));

  const selParts = [];
  const dstCols = [];
  for (const col of srcCols) {
    const mapped = COLUMN_ALIASES[col] || col;
    if (dstColSet.has(mapped)) {
      selParts.push(col === mapped ? `"${col}"` : `"${col}" AS "${mapped}"`);
      dstCols.push(`"${mapped}"`);
    }
  }
  if (dstCols.length === 0) {
    console.warn(`[migrate-collect] ${table}: 主库与 collect.db 无交集列,跳过`);
    return;
  }

  const verb = table === 'collect_queue_snapshot' ? 'REPLACE' : 'IGNORE';
  const sql = `INSERT OR ${verb} INTO collect."${table}" (${dstCols.join(',')})
               SELECT ${selParts.join(',')} FROM "${table}"`;
  const result = mainDb.prepare(sql).run();
  totalCopied += Number(result.changes);

  const dstCount = collectDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  const ok = dstCount >= srcCount;
  console.log(
    `[migrate-collect] ${table}: 主库 ${srcCount} → collect.db ${dstCount} ${ok ? '✓' : '✗ 行数不足!'}`
  );
  if (!ok) mismatch = true;
}

// ── 4) 特殊迁移:ozon_store_classification ──
function migrateStoreClassification() {
  const table = 'ozon_store_classification';
  if (!tableExists(mainDb, table)) {
    console.log(`[migrate-collect] 主库无 ${table},跳过`);
    return;
  }
  const srcCount = mainDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  if (srcCount === 0) {
    console.log(`[migrate-collect] ${table}: 主库 0 行,跳过`);
    return;
  }
  const srcCols = mainDb.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  const dstColSet = new Set(collectDb.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name));
  if (!srcCols.includes('sellerId')) {
    console.warn(`[migrate-collect] ${table}: 主库无 sellerId 列,跳过`);
    return;
  }

  // 判断主库表结构:若存在 _id != sellerId 的行,说明仍是旧结构(_id = sellerSlug)
  const legacyStyleCount = mainDb
    .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE _id IS NOT sellerId`)
    .get().n;

  if (legacyStyleCount > 0) {
    // 旧结构:按 sellerId 重建 _id,sellerId 为空的行迁 legacy
    console.log(`[migrate-collect] ${table}: 检测到旧结构(_id=sellerSlug),按 sellerId 重建`);
    const commonCols = srcCols.filter((c) => {
      const mapped = COLUMN_ALIASES[c] || c;
      return c !== '_id' && dstColSet.has(mapped);
    });
    const selParts = commonCols.map((c) => {
      const mapped = COLUMN_ALIASES[c] || c;
      return c === mapped ? `"${c}"` : `"${c}" AS "${mapped}"`;
    });
    const insCols = commonCols.map((c) => `"${COLUMN_ALIASES[c] || c}"`);
    const sql = `INSERT OR IGNORE INTO collect."${table}" ("_id", ${insCols.join(',')})
                 SELECT sellerId AS "_id", ${selParts.join(',')}
                 FROM "${table}"
                 WHERE sellerId IS NOT NULL AND sellerId != ''`;
    const result = mainDb.prepare(sql).run();
    totalCopied += Number(result.changes);
    console.log(`[migrate-collect] ${table}: 按 sellerId 重建复制 ${result.changes} 行`);

    // sellerId 为空的行 → legacy 表(补 migratedAt,兼容旧列名)
    migrateLegacyFromOldStoreClassification(srcCols);

    // 校验:新表应包含主库中 sellerId 非空的行;无 sellerId 的行已迁 legacy,不算缺失
    const expectedNew = mainDb
      .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE sellerId IS NOT NULL AND sellerId != ''`)
      .get().n;
    const dstCount = collectDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    const ok = dstCount >= expectedNew;
    console.log(
      `[migrate-collect] ${table}: 主库可迁移 ${expectedNew} 行(另 ${srcCount - expectedNew} 行无 sellerId 迁 legacy) → collect.db ${dstCount} ${ok ? '✓' : '✗ 行数不足!'}`
    );
    if (!ok) mismatch = true;
  } else {
    // 新结构(_id = sellerId):走通用复制
    genericCopy(table);
  }
}

function migrateLegacyFromOldStoreClassification(srcCols) {
  const legacyTable = 'ozon_store_classification_legacy';
  if (!tableExists(collectDb, legacyTable)) {
    console.warn(`[migrate-collect] ${legacyTable}: collect.db 无此表,跳过`);
    return;
  }
  const dstColSet = new Set(collectDb.prepare(`PRAGMA table_info("${legacyTable}")`).all().map((c) => c.name));
  const wantCols = ['_id', 'sellerSlug', 'sellerId', 'sellerName', 'isChinese', 'classifiedBy', 'classifiedAt', 'companyInfo', 'lastSeenAt', 'lastSeenUrl'];
  const selParts = [];
  const insCols = [];
  for (const col of wantCols) {
    if (!srcCols.includes(col)) continue;
    const mapped = COLUMN_ALIASES[col] || col;
    if (dstColSet.has(mapped)) {
      selParts.push(col === mapped ? `"${col}"` : `"${col}" AS "${mapped}"`);
      insCols.push(`"${mapped}"`);
    }
  }
  if (!dstColSet.has('migratedAt')) {
    console.warn(`[migrate-collect] ${legacyTable}: 目标表无 migratedAt 列,跳过`);
    return;
  }
  insCols.push('"migratedAt"');
  selParts.push(`datetime('now') AS "migratedAt"`);

  const sql = `INSERT OR IGNORE INTO collect."${legacyTable}" (${insCols.join(',')})
               SELECT ${selParts.join(',')}
               FROM ozon_store_classification
               WHERE sellerId IS NULL OR sellerId = ''`;
  const result = mainDb.prepare(sql).run();
  totalCopied += Number(result.changes);
  console.log(`[migrate-collect] ${legacyTable}: 从旧 ozon_store_classification 迁移 ${result.changes} 行`);
}

// ── 5) 执行迁移 ──
console.log(`[migrate-collect] 主库: ${MAIN_DB_PATH}`);
console.log(`[migrate-collect] 采集库: ${COLLECT_DB_PATH}`);
console.log(`[migrate-collect] 开始逐表迁移...`);

for (const table of TABLES) {
  genericCopy(table);
}
migrateStoreClassification();

// ── 6) 汇总校验 ──
console.log(`[migrate-collect] 迁移完成: 共复制 ${totalCopied} 行`);
if (mismatch) {
  console.error('[migrate-collect] 存在行数不一致,请检查上方 ✗ 项!');
  process.exit(1);
}
console.log('[migrate-collect] 所有表行数校验通过 ✓');

mainDb.close();
collectDb.close();