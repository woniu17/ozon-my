// MongoDB → SQLite 一次性迁移脚本
// 用法:node --experimental-sqlite scripts/migrate-mongo-to-sqlite.js [选项]
//   --limit=N          每个集合最多迁移 N 条(测试用,默认无限制)
//   --dry-run          仅读取并打印统计,不写入 SQLite
//   --only=coll1,coll2 只迁移指定集合(逗号分隔,集合名见下方 COLLECTIONS)
//   --clear-sqlite     迁移前先清空目标 SQLite 表(慎用,会删除已有数据)
//   --batch-size=N     批量读取/写入大小(默认 500)
//
// 集合映射(14 个):
//   9 类缓存:_id=sku(字符串),data=对象,fetchedAt=Date,部分含 l2Synced/bundleId/attrsEmptyVerifiedAt
//   ozon_auto_collect_log:_id=ObjectId → INTEGER AUTOINCREMENT
//   ozon_store_classification:_id=sellerSlug(字符串),isChinese=bool→0/1,companyInfo=对象
//   ozon_store_sku:_id=sku(字符串),lastCollectResults=数组
//   collect_queue_tasks:_id=ObjectId → INTEGER AUTOINCREMENT;__snapshot__ 文档单独写入 collect_queue_snapshot 表
//   collect_queue_ops:_id=ObjectId → INTEGER AUTOINCREMENT
//
// 字段类型转换:
//   Date → ISO 字符串(toISOString)
//   boolean → 0/1
//   对象/数组 → JSON 字符串
//   ObjectId → 丢弃(SQLite 自增)
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { db, initSchema } from '../src/db/index.js';

dotenv.config();

// ── 参数解析 ───────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([\w-]+)(?:=(.+))?$/);
    return m ? [m[1], m[2] ?? true] : [];
  }).filter(([k]) => k)
);
const LIMIT = args.limit ? Number(args.limit) : 0;
const DRY_RUN = !!args['dry-run'];
const ONLY = args.only ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
const CLEAR_SQLITE = !!args['clear-sqlite'];
const BATCH_SIZE = args['batch-size'] ? Number(args['batch-size']) : 500;

// ── MongoDB 连接 ──────────────────────────────────────────
const MONGO_URL =
  `mongodb://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}` +
  `@${process.env.MONGO_HOST}:${process.env.MONGO_PORT}/?authSource=${process.env.MONGO_AUTH_SOURCE}`;
const DB_NAME = 'ozon_erp';

// ── 通用辅助 ──────────────────────────────────────────────
// Date → ISO 字符串;其它原样返回(SQLite 绑定基本类型 OK)
function toBind(v) {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && v._bsontype === 'ObjectId') return String(v);
  return v;
}

// 对象/数组 → JSON 字符串;Date → ISO;基本类型原样
function toVal(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object') {
    // ObjectId 之类
    if (v._bsontype) return String(v);
    return JSON.stringify(v);
  }
  return v;
}

// 布尔 → 0/1,其它走 toVal
function toBoolInt(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
}

// 批量事务写入:stmt 需预先 prepare,vals 数组的数组
function batchInsertInTxn(stmt, batchRows) {
  db.exec('BEGIN');
  try {
    for (const row of batchRows) stmt.run(...row);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── 迁移统计 ──────────────────────────────────────────────
const stats = [];
function pushStat(collection, table, total, migrated, skipped, failed, note = '') {
  stats.push({ collection, table, total, migrated, skipped, failed, note });
}

// ── 迁移器 ────────────────────────────────────────────────

/**
 * 通用缓存迁移(9 类缓存共用)
 * MongoDB 文档结构:{ _id: sku, data, fetchedAt, [bundleId, attrsEmptyVerifiedAt, l2Synced] }
 * SQLite 表结构:  { _id TEXT, data TEXT, fetchedAt TEXT, [bundleId, attrsEmptyVerifiedAt, l2Synced INTEGER] }
 */
async function migrateCacheCollection(mongoDb, collection, table, opts = {}) {
  const { extraCols = [], hasL2Synced = false } = opts;
  const col = mongoDb.collection(collection);
  const total = await col.estimatedDocumentCount();
  console.log(`[${collection}] start: estimated ${total} docs`);

  if (CLEAR_SQLITE && !DRY_RUN) {
    db.prepare(`DELETE FROM ${table}`).run();
    console.log(`[${collection}] cleared sqlite table ${table}`);
  }

  // 构造 INSERT 语句
  const insertCols = ['_id', 'data', 'fetchedAt'];
  if (hasL2Synced) insertCols.push('l2Synced');
  for (const c of extraCols) insertCols.push(c);
  const placeholders = insertCols.map(() => '?').join(', ');
  const updateCols = insertCols.filter((c) => c !== '_id');
  const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(_id) DO UPDATE SET ${setClause}`;
  const stmt = DRY_RUN ? null : db.prepare(sql);

  const cursor = col.find({}, { batchSize: BATCH_SIZE });
  let migrated = 0, skipped = 0, failed = 0;
  let batchRows = [];

  for await (const doc of cursor) {
    if (LIMIT && migrated + skipped >= LIMIT) break;
    try {
      if (!doc._id) { skipped++; continue; }
      const row = [
        String(doc._id),
        doc.data ? JSON.stringify(doc.data) : null,
        doc.fetchedAt ? toBind(doc.fetchedAt) : null,
      ];
      if (hasL2Synced) row.push(doc.l2Synced ? 1 : 0);
      for (const c of extraCols) {
        if (c === 'l2Synced') continue;
        const v = doc[c];
        if (c === 'attrsEmptyVerifiedAt' || v instanceof Date) row.push(v ? toBind(v) : null);
        else row.push(v !== undefined && v !== null ? v : null);
      }
      batchRows.push(row);
      migrated++;
      if (batchRows.length >= BATCH_SIZE) {
        if (!DRY_RUN) batchInsertInTxn(stmt, batchRows);
        batchRows = [];
        if (migrated % (BATCH_SIZE * 10) === 0) console.log(`[${collection}] progress: ${migrated}/${total}`);
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[${collection}] convert error:`, e.message);
    }
  }
  if (batchRows.length && !DRY_RUN) batchInsertInTxn(stmt, batchRows);

  pushStat(collection, table, total, migrated, skipped, failed);
  console.log(`[${collection}] done: migrated=${migrated} skipped=${skipped} failed=${failed}`);
}

/**
 * ozon_auto_collect_log 迁移
 * MongoDB:{ _id: ObjectId, sku, source, sellerSlug, storeClassified, depth, status, results: [], totalDuration, collectedAt }
 * SQLite:  字段同名,results → JSON 字符串,collectedAt → ISO,_id 丢弃(自增)
 */
async function migrateAutoCollectLog(mongoDb) {
  const collection = 'ozon_auto_collect_log';
  const table = 'ozon_auto_collect_log';
  const col = mongoDb.collection(collection);
  const total = await col.estimatedDocumentCount();
  console.log(`[${collection}] start: estimated ${total} docs`);

  if (CLEAR_SQLITE && !DRY_RUN) {
    db.prepare(`DELETE FROM ${table}`).run();
    console.log(`[${collection}] cleared sqlite table ${table}`);
  }

  const sql = `INSERT INTO ${table}
    (sku, source, sellerSlug, storeClassified, depth, status, results, totalDuration, collectedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const stmt = DRY_RUN ? null : db.prepare(sql);

  const cursor = col.find({}, { batchSize: BATCH_SIZE });
  let migrated = 0, skipped = 0, failed = 0;
  let batchRows = [];

  for await (const doc of cursor) {
    if (LIMIT && migrated + skipped >= LIMIT) break;
    try {
      if (!doc.sku) { skipped++; continue; }
      batchRows.push([
        String(doc.sku),
        doc.source ?? null,
        doc.sellerSlug ?? null,
        doc.storeClassified || 'unclassified',
        doc.depth ?? 0,
        doc.status,
        JSON.stringify(doc.results || []),
        doc.totalDuration ?? 0,
        doc.collectedAt ? toBind(doc.collectedAt) : new Date().toISOString(),
      ]);
      migrated++;
      if (batchRows.length >= BATCH_SIZE) {
        if (!DRY_RUN) batchInsertInTxn(stmt, batchRows);
        batchRows = [];
        if (migrated % (BATCH_SIZE * 10) === 0) console.log(`[${collection}] progress: ${migrated}/${total}`);
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[${collection}] convert error:`, e.message);
    }
  }
  if (batchRows.length && !DRY_RUN) batchInsertInTxn(stmt, batchRows);

  pushStat(collection, table, total, migrated, skipped, failed);
  console.log(`[${collection}] done: migrated=${migrated} skipped=${skipped} failed=${failed}`);
}

/**
 * ozon_store_classification 迁移
 * MongoDB:{ _id: sellerSlug, sellerSlug, sellerId, sellerName, isChinese(bool/null),
 *           classifiedBy, classifiedAt, companyInfo(obj), lastSeenAt, lastSeenUrl }
 * SQLite:  _id=sellerSlug(字符串),isChinese→0/1/null,companyInfo→JSON
 */
async function migrateStoreClassification(mongoDb) {
  const collection = 'ozon_store_classification';
  const table = 'ozon_store_classification';
  const col = mongoDb.collection(collection);
  const total = await col.estimatedDocumentCount();
  console.log(`[${collection}] start: estimated ${total} docs`);

  if (CLEAR_SQLITE && !DRY_RUN) {
    db.prepare(`DELETE FROM ${table}`).run();
    console.log(`[${collection}] cleared sqlite table ${table}`);
  }

  const sql = `INSERT INTO ${table}
    (_id, sellerSlug, sellerId, sellerName, isChinese, classifiedBy, classifiedAt,
     companyInfo, lastSeenAt, lastSeenUrl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(_id) DO UPDATE SET
      sellerSlug = excluded.sellerSlug, sellerId = excluded.sellerId,
      sellerName = excluded.sellerName, isChinese = excluded.isChinese,
      classifiedBy = excluded.classifiedBy, classifiedAt = excluded.classifiedAt,
      companyInfo = excluded.companyInfo, lastSeenAt = excluded.lastSeenAt,
      lastSeenUrl = excluded.lastSeenUrl`;
  const stmt = DRY_RUN ? null : db.prepare(sql);

  const cursor = col.find({}, { batchSize: BATCH_SIZE });
  let migrated = 0, skipped = 0, failed = 0;
  let batchRows = [];

  for await (const doc of cursor) {
    if (LIMIT && migrated + skipped >= LIMIT) break;
    try {
      const slug = doc._id || doc.sellerSlug;
      if (!slug) { skipped++; continue; }
      batchRows.push([
        String(slug),
        doc.sellerSlug ?? String(slug),
        doc.sellerId ?? null,
        doc.sellerName ?? null,
        doc.isChinese === null || doc.isChinese === undefined ? null : (doc.isChinese ? 1 : 0),
        doc.classifiedBy ?? null,
        doc.classifiedAt ? toBind(doc.classifiedAt) : null,
        doc.companyInfo ? JSON.stringify(doc.companyInfo) : null,
        doc.lastSeenAt ? toBind(doc.lastSeenAt) : null,
        doc.lastSeenUrl ?? null,
      ]);
      migrated++;
      if (batchRows.length >= BATCH_SIZE) {
        if (!DRY_RUN) batchInsertInTxn(stmt, batchRows);
        batchRows = [];
        if (migrated % (BATCH_SIZE * 10) === 0) console.log(`[${collection}] progress: ${migrated}/${total}`);
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[${collection}] convert error:`, e.message);
    }
  }
  if (batchRows.length && !DRY_RUN) batchInsertInTxn(stmt, batchRows);

  pushStat(collection, table, total, migrated, skipped, failed);
  console.log(`[${collection}] done: migrated=${migrated} skipped=${skipped} failed=${failed}`);
}

/**
 * ozon_store_sku 迁移
 * MongoDB:{ _id: sku, sellerId, sellerSlug, sellerName, firstSeenAt, lastSeenAt,
 *           lastCollectAt, lastCollectStatus, lastCollectResults: [] }
 * SQLite:  _id=sku(字符串),lastCollectResults → JSON
 */
async function migrateStoreSku(mongoDb) {
  const collection = 'ozon_store_sku';
  const table = 'ozon_store_sku';
  const col = mongoDb.collection(collection);
  const total = await col.estimatedDocumentCount();
  console.log(`[${collection}] start: estimated ${total} docs`);

  if (CLEAR_SQLITE && !DRY_RUN) {
    db.prepare(`DELETE FROM ${table}`).run();
    console.log(`[${collection}] cleared sqlite table ${table}`);
  }

  const sql = `INSERT INTO ${table}
    (_id, sellerId, sellerSlug, sellerName, firstSeenAt, lastSeenAt,
     lastCollectAt, lastCollectStatus, lastCollectResults)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(_id) DO UPDATE SET
      sellerId = excluded.sellerId, sellerSlug = excluded.sellerSlug,
      sellerName = excluded.sellerName, lastSeenAt = excluded.lastSeenAt,
      lastCollectAt = excluded.lastCollectAt, lastCollectStatus = excluded.lastCollectStatus,
      lastCollectResults = excluded.lastCollectResults`;
  const stmt = DRY_RUN ? null : db.prepare(sql);

  const cursor = col.find({}, { batchSize: BATCH_SIZE });
  let migrated = 0, skipped = 0, failed = 0;
  let batchRows = [];

  for await (const doc of cursor) {
    if (LIMIT && migrated + skipped >= LIMIT) break;
    try {
      const sku = doc._id;
      if (!sku) { skipped++; continue; }
      batchRows.push([
        String(sku),
        doc.sellerId ?? null,
        doc.sellerSlug ?? null,
        doc.sellerName ?? null,
        doc.firstSeenAt ? toBind(doc.firstSeenAt) : null,
        doc.lastSeenAt ? toBind(doc.lastSeenAt) : null,
        doc.lastCollectAt ? toBind(doc.lastCollectAt) : null,
        doc.lastCollectStatus ?? null,
        doc.lastCollectResults ? JSON.stringify(doc.lastCollectResults) : null,
      ]);
      migrated++;
      if (batchRows.length >= BATCH_SIZE) {
        if (!DRY_RUN) batchInsertInTxn(stmt, batchRows);
        batchRows = [];
        if (migrated % (BATCH_SIZE * 10) === 0) console.log(`[${collection}] progress: ${migrated}/${total}`);
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[${collection}] convert error:`, e.message);
    }
  }
  if (batchRows.length && !DRY_RUN) batchInsertInTxn(stmt, batchRows);

  pushStat(collection, table, total, migrated, skipped, failed);
  console.log(`[${collection}] done: migrated=${migrated} skipped=${skipped} failed=${failed}`);
}

/**
 * collect_queue_tasks 迁移(含 __snapshot__ 特殊文档处理)
 * MongoDB 任务文档:{ _id: ObjectId, sku, sellerSlug, sellerId, domInfo, status, attempts,
 *   maxAttempts, nextRetryAt, lastError, startedAt, finishedAt, duration, steps, result,
 *   createdAt, updatedAt }
 * MongoDB 快照文档:{ _id: '__snapshot__', pending, running, success, failed, syncedAt,
 *   consumePaused, lastConsumeAt }
 * SQLite:任务表 _id 丢弃(自增);快照表 collect_queue_snapshot 单行 UPDATE
 */
async function migrateCollectQueueTasks(mongoDb) {
  const collection = 'collect_queue_tasks';
  const taskTable = 'collect_queue_tasks';
  const snapshotTable = 'collect_queue_snapshot';
  const col = mongoDb.collection(collection);
  const total = await col.estimatedDocumentCount();
  console.log(`[${collection}] start: estimated ${total} docs (含 __snapshot__)`);

  if (CLEAR_SQLITE && !DRY_RUN) {
    db.prepare(`DELETE FROM ${taskTable}`).run();
    // 快照表保留默认行(id=1),仅重置字段
    db.prepare(`UPDATE ${snapshotTable} SET pending=0, running=0, success=0, failed=0, syncedAt=NULL, consumePaused=NULL, lastConsumeAt=NULL WHERE id=1`).run();
    console.log(`[${collection}] cleared sqlite tables ${taskTable} + reset ${snapshotTable}`);
  }

  // 任务表 INSERT(_id 丢弃,用自增;sku 上有 unique 约束,用 ON CONFLICT 兜底)
  const taskCols = [
    'sku', 'sellerSlug', 'sellerId', 'domInfo', 'status', 'attempts', 'maxAttempts',
    'nextRetryAt', 'lastError', 'startedAt', 'finishedAt', 'duration', 'steps', 'result',
    'createdAt', 'updatedAt',
  ];
  const placeholders = taskCols.map(() => '?').join(', ');
  const updateCols = taskCols.filter((c) => c !== 'sku' && c !== 'createdAt');
  const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
  const taskSql = `INSERT INTO ${taskTable} (${taskCols.join(', ')}) VALUES (${placeholders})
                   ON CONFLICT(sku) DO UPDATE SET ${setClause}`;
  const taskStmt = DRY_RUN ? null : db.prepare(taskSql);

  // 快照表 UPDATE(单行)
  const snapshotSql = `UPDATE ${snapshotTable}
    SET pending = ?, running = ?, success = ?, failed = ?,
        syncedAt = ?, consumePaused = ?, lastConsumeAt = ?
    WHERE id = 1`;
  const snapshotStmt = DRY_RUN ? null : db.prepare(snapshotSql);

  const cursor = col.find({}, { batchSize: BATCH_SIZE });
  let migrated = 0, skipped = 0, failed = 0, snapshotCount = 0;
  let batchRows = [];

  for await (const doc of cursor) {
    try {
      // 特殊处理 __snapshot__ 文档
      if (doc._id === '__snapshot__') {
        if (!DRY_RUN) {
          snapshotStmt.run(
            Number(doc.pending) || 0,
            Number(doc.running) || 0,
            Number(doc.success) || 0,
            Number(doc.failed) || 0,
            doc.syncedAt ? toBind(doc.syncedAt) : null,
            doc.consumePaused === undefined ? null : (doc.consumePaused ? 1 : 0),
            doc.lastConsumeAt ? toBind(doc.lastConsumeAt) : null
          );
        }
        snapshotCount++;
        continue;
      }
      if (LIMIT && migrated >= LIMIT) continue;
      if (!doc.sku) { skipped++; continue; }

      batchRows.push([
        String(doc.sku),
        doc.sellerSlug ?? null,
        doc.sellerId ?? null,
        doc.domInfo ? JSON.stringify(doc.domInfo) : null,
        doc.status || 'pending',
        doc.attempts ?? 0,
        doc.maxAttempts ?? null,
        doc.nextRetryAt ? toBind(doc.nextRetryAt) : null,
        doc.lastError ? JSON.stringify(doc.lastError) : null,
        doc.startedAt ? toBind(doc.startedAt) : null,
        doc.finishedAt ? toBind(doc.finishedAt) : null,
        doc.duration ?? null,
        doc.steps ? JSON.stringify(doc.steps) : null,
        doc.result ? JSON.stringify(doc.result) : null,
        doc.createdAt ? toBind(doc.createdAt) : new Date().toISOString(),
        doc.updatedAt ? toBind(doc.updatedAt) : new Date().toISOString(),
      ]);
      migrated++;
      if (batchRows.length >= BATCH_SIZE) {
        if (!DRY_RUN) batchInsertInTxn(taskStmt, batchRows);
        batchRows = [];
        if (migrated % (BATCH_SIZE * 10) === 0) console.log(`[${collection}] progress: ${migrated}/${total}`);
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[${collection}] convert error:`, e.message);
    }
  }
  if (batchRows.length && !DRY_RUN) batchInsertInTxn(taskStmt, batchRows);

  pushStat(collection, `${taskTable} + ${snapshotTable}`, total, migrated, skipped, failed, `snapshot=${snapshotCount}`);
  console.log(`[${collection}] done: tasks=${migrated} snapshot=${snapshotCount} skipped=${skipped} failed=${failed}`);
}

/**
 * collect_queue_ops 迁移
 * MongoDB:{ _id: ObjectId, op, sku, params, ts, processed(bool), processedAt }
 * SQLite:  _id 丢弃(自增),params → JSON,processed → 0/1
 */
async function migrateCollectQueueOps(mongoDb) {
  const collection = 'collect_queue_ops';
  const table = 'collect_queue_ops';
  const col = mongoDb.collection(collection);
  const total = await col.estimatedDocumentCount();
  console.log(`[${collection}] start: estimated ${total} docs`);

  if (CLEAR_SQLITE && !DRY_RUN) {
    db.prepare(`DELETE FROM ${table}`).run();
    console.log(`[${collection}] cleared sqlite table ${table}`);
  }

  const sql = `INSERT INTO ${table}
    (op, sku, params, ts, processed, processedAt)
    VALUES (?, ?, ?, ?, ?, ?)`;
  const stmt = DRY_RUN ? null : db.prepare(sql);

  const cursor = col.find({}, { batchSize: BATCH_SIZE });
  let migrated = 0, skipped = 0, failed = 0;
  let batchRows = [];

  for await (const doc of cursor) {
    if (LIMIT && migrated + skipped >= LIMIT) break;
    try {
      if (!doc.op) { skipped++; continue; }
      batchRows.push([
        doc.op,
        doc.sku ?? null,
        doc.params ? JSON.stringify(doc.params) : '{}',
        doc.ts ? toBind(doc.ts) : new Date().toISOString(),
        doc.processed ? 1 : 0,
        doc.processedAt ? toBind(doc.processedAt) : null,
      ]);
      migrated++;
      if (batchRows.length >= BATCH_SIZE) {
        if (!DRY_RUN) batchInsertInTxn(stmt, batchRows);
        batchRows = [];
        if (migrated % (BATCH_SIZE * 10) === 0) console.log(`[${collection}] progress: ${migrated}/${total}`);
      }
    } catch (e) {
      failed++;
      if (failed <= 5) console.warn(`[${collection}] convert error:`, e.message);
    }
  }
  if (batchRows.length && !DRY_RUN) batchInsertInTxn(stmt, batchRows);

  pushStat(collection, table, total, migrated, skipped, failed);
  console.log(`[${collection}] done: migrated=${migrated} skipped=${skipped} failed=${failed}`);
}

// ── 迁移编排 ──────────────────────────────────────────────
const ALL_JOBS = [
  { name: 'ozon_search_cache', fn: (mdb) => migrateCacheCollection(mdb, 'ozon_search_cache', 'ozon_search_cache') },
  { name: 'ozon_bundle_cache', fn: (mdb) => migrateCacheCollection(mdb, 'ozon_bundle_cache', 'ozon_bundle_cache', { extraCols: ['bundleId', 'attrsEmptyVerifiedAt'] }) },
  { name: 'ozon_card_cache', fn: (mdb) => migrateCacheCollection(mdb, 'ozon_card_cache', 'ozon_card_cache') },
  { name: 'ozon_composer_cache', fn: (mdb) => migrateCacheCollection(mdb, 'ozon_composer_cache', 'ozon_composer_cache') },
  { name: 'ozon_entrypoint_cache', fn: (mdb) => migrateCacheCollection(mdb, 'ozon_entrypoint_cache', 'ozon_entrypoint_cache') },
  { name: 'ozon_rich_media_cache', fn: (mdb) => migrateCacheCollection(mdb, 'ozon_rich_media_cache', 'ozon_rich_media_cache') },
  { name: 'ozon_detail_cache', fn: (mdb) => migrateCacheCollection(mdb, 'ozon_detail_cache', 'ozon_detail_cache') },
  { name: 'ozon_market_stats_cache', fn: (mdb) => migrateCacheCollection(mdb, 'ozon_market_stats_cache', 'ozon_market_stats_cache', { hasL2Synced: true }) },
  { name: 'ozon_follow_sell_cache', fn: (mdb) => migrateCacheCollection(mdb, 'ozon_follow_sell_cache', 'ozon_follow_sell_cache', { hasL2Synced: true }) },
  { name: 'ozon_auto_collect_log', fn: migrateAutoCollectLog },
  { name: 'ozon_store_classification', fn: migrateStoreClassification },
  { name: 'ozon_store_sku', fn: migrateStoreSku },
  { name: 'collect_queue_tasks', fn: migrateCollectQueueTasks },
  { name: 'collect_queue_ops', fn: migrateCollectQueueOps },
];

function shouldRun(name) {
  if (!ONLY) return true;
  return ONLY.includes(name);
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  console.log('=== mongo → sqlite migration ===');
  console.log(`config: limit=${LIMIT || '∞'} dry-run=${DRY_RUN} only=${ONLY ? ONLY.join(',') : 'ALL'} clear-sqlite=${CLEAR_SQLITE} batch-size=${BATCH_SIZE}`);

  // 1) 初始化 SQLite schema
  if (!DRY_RUN) {
    initSchema();
    console.log('[sqlite] schema initialized');
  } else {
    console.log('[sqlite] dry-run, skip schema init');
  }

  // 2) 连接 MongoDB
  console.log('[mongo] connecting to', process.env.MONGO_HOST);
  const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const mongoDb = client.db(DB_NAME);
  console.log('[mongo] connected');

  // 3) 逐个集合迁移
  const startedAt = Date.now();
  try {
    for (const job of ALL_JOBS) {
      if (!shouldRun(job.name)) {
        console.log(`[${job.name}] skipped (filtered by --only)`);
        continue;
      }
      try {
        await job.fn(mongoDb);
      } catch (e) {
        console.error(`[${job.name}] FAILED:`, e.message);
        pushStat(job.name, '(failed)', 0, 0, 0, 0, e.message);
      }
    }
  } finally {
    await client.close();
    console.log('[mongo] disconnected');
  }

  // 4) 输出统计表
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n=== migration summary ===');
  console.log(`elapsed: ${elapsed}s\n`);
  const header = ['collection', 'table', 'total', 'migrated', 'skipped', 'failed', 'note'];
  const rows = stats.map((s) => [s.collection, s.table, String(s.total), String(s.migrated), String(s.skipped), String(s.failed), s.note]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (arr) => arr.map((s, i) => String(s).padEnd(widths[i])).join(' | ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const r of rows) console.log(fmt(r));

  const totals = stats.reduce((acc, s) => ({
    total: acc.total + s.total, migrated: acc.migrated + s.migrated,
    skipped: acc.skipped + s.skipped, failed: acc.failed + s.failed,
  }), { total: 0, migrated: 0, skipped: 0, failed: 0 });
  console.log('\n' + fmt(['TOTAL', '', String(totals.total), String(totals.migrated), String(totals.skipped), String(totals.failed), '']));

  if (!DRY_RUN) {
    db.close();
    console.log('\n[sqlite] closed. migration complete.');
  } else {
    console.log('\n[sqlite] dry-run complete, no writes performed.');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('migration aborted:', e);
  process.exit(1);
});
