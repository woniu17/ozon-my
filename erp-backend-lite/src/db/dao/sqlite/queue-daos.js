// 采集队列 DAO(SQLite 实现):collectQueueTasks + collectQueueOps
// 关键设计:
//   1. __snapshot__ 文档拆为独立单行表 collect_queue_snapshot
//   2. ObjectId → INTEGER AUTOINCREMENT,markProcessed 用 Number 校验
//   3. 'lastError.type' 嵌套字段用 json_extract(lastError, '$.type')
//   4. TTL 由 ttl-cleaner.js 定时任务实现(7 天清理 processed ops)
import { db } from '../../index.js';

function parseJsonCol(row, col) {
  if (!row || row[col] === null || row[col] === undefined) return null;
  try {
    return JSON.parse(row[col]);
  } catch {
    return null;
  }
}

// node:sqlite 不支持绑定 Date 对象,统一转 ISO 字符串
function toBind(v) {
  if (v instanceof Date) return v.toISOString();
  return v;
}

function reshapeTask(row) {
  if (!row) return null;
  return {
    _id: row._id,
    sku: row.sku,
    sellerSlug: row.sellerSlug,
    sellerId: row.sellerId,
    domInfo: parseJsonCol(row, 'domInfo'),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    nextRetryAt: row.nextRetryAt,
    lastError: parseJsonCol(row, 'lastError'),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    duration: row.duration ?? null,
    steps: parseJsonCol(row, 'steps'),
    result: parseJsonCol(row, 'result'),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const collectQueueTasksDao = {
  /** 聚合状态计数(SQLite 无需排除 __snapshot__,因为快照在独立表) */
  async aggregateStatusCounts() {
    const rows = db
      .prepare(
        `SELECT status AS _id, COUNT(*) AS count FROM collect_queue_tasks GROUP BY status`
      )
      .all();
    return rows;
  },

  async countTodayByStatus(status, since) {
    const sinceIso = new Date(since).toISOString();
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM collect_queue_tasks WHERE status = ? AND finishedAt >= ?`
      )
      .get(status, sinceIso).n;
  },

  /** 查最近 ANTIBOT_BLOCKED 任务:json_extract(lastError, '$.type') */
  async findLatestAntibotBlocked(since) {
    const sinceIso = new Date(since).toISOString();
    const row = db
      .prepare(
        `SELECT finishedAt, lastError FROM collect_queue_tasks
         WHERE status = 'failed_final'
           AND json_extract(lastError, '$.type') = 'ANTIBOT_BLOCKED'
           AND finishedAt >= ?
         ORDER BY finishedAt DESC LIMIT 1`
      )
      .get(sinceIso);
    if (!row) return null;
    return {
      finishedAt: row.finishedAt,
      lastError: parseJsonCol(row, 'lastError'),
    };
  },

  /** 读取快照(独立单行表) */
  async findSnapshot() {
    const row = db
      .prepare(
        `SELECT pending, running, success, failed, syncedAt, consumePaused, lastConsumeAt FROM collect_queue_snapshot WHERE id = 1`
      )
      .get();
    if (!row) return null;
    return {
      pending: row.pending,
      running: row.running,
      success: row.success,
      failed: row.failed,
      syncedAt: row.syncedAt,
      consumePaused: row.consumePaused === null ? null : !!row.consumePaused,
      lastConsumeAt: row.lastConsumeAt,
    };
  },

  /** 列表计数(SQLite 无需排除 __snapshot__) */
  async countList(filter = {}) {
    const whereParts = [];
    const params = [];
    if (filter.status) {
      whereParts.push('status = ?');
      params.push(filter.status);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    return db.prepare(`SELECT COUNT(*) AS n FROM collect_queue_tasks ${where}`).get(...params).n;
  },

  async findList(filter = {}, page, pageSize) {
    const whereParts = [];
    const params = [];
    if (filter.status) {
      whereParts.push('status = ?');
      params.push(filter.status);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const skip = (page - 1) * pageSize;
    const rows = db
      .prepare(
        `SELECT * FROM collect_queue_tasks ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, skip);
    return rows.map(reshapeTask);
  },

  async getBySku(sku) {
    const row = db.prepare(`SELECT * FROM collect_queue_tasks WHERE sku = ?`).get(sku);
    return reshapeTask(row);
  },

  async findBySkus(skus) {
    if (!skus.length) return [];
    const placeholders = skus.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT sku, status, result, updatedAt FROM collect_queue_tasks WHERE sku IN (${placeholders})`
      )
      .all(...skus);
    return rows.map((r) => ({
      sku: r.sku,
      status: r.status,
      result: parseJsonCol(r, 'result'),
      updatedAt: r.updatedAt,
    }));
  },

  async resetBySku(sku) {
    const now = new Date().toISOString();
    const r = db
      .prepare(
        `UPDATE collect_queue_tasks
         SET status = 'pending', attempts = 0, nextRetryAt = NULL, lastError = NULL, updatedAt = ?
         WHERE sku = ?`
      )
      .run(now, sku);
    return { matchedCount: r.changes, modifiedCount: r.changes };
  },

  async deleteBySku(sku) {
    const r = db.prepare(`DELETE FROM collect_queue_tasks WHERE sku = ?`).run(sku);
    return { deletedCount: r.changes };
  },

  async resetBySkus(skus) {
    if (!skus.length) return { matchedCount: 0, modifiedCount: 0 };
    const now = new Date().toISOString();
    const placeholders = skus.map(() => '?').join(', ');
    const r = db
      .prepare(
        `UPDATE collect_queue_tasks
         SET status = 'pending', attempts = 0, nextRetryAt = NULL, lastError = NULL, updatedAt = ?
         WHERE sku IN (${placeholders})`
      )
      .run(now, ...skus);
    return { matchedCount: r.changes, modifiedCount: r.changes };
  },

  /** 清空 pending 任务(SQLite 无需排除 __snapshot__) */
  async deletePendingAll() {
    const r = db.prepare(`DELETE FROM collect_queue_tasks WHERE status = 'pending'`).run();
    return { deletedCount: r.changes };
  },

  /** 写入快照(独立单行表,UPDATE 单行) */
  async upsertSnapshot(data) {
    const now = new Date().toISOString();
    const vals = [
      Number(data.pending) || 0,
      Number(data.running) || 0,
      Number(data.success) || 0,
      Number(data.failed) || 0,
      data.syncedAt || now,
      data.consumePaused === undefined ? null : data.consumePaused ? 1 : 0,
      data.lastConsumeAt ?? null,
    ];
    db.prepare(
      `UPDATE collect_queue_snapshot
       SET pending = ?, running = ?, success = ?, failed = ?,
           syncedAt = ?, consumePaused = ?, lastConsumeAt = ?
       WHERE id = 1`
    ).run(...vals.map(toBind));
    return { upsertedCount: 1 };
  },

  async updateResult(sku, update) {
    const now = new Date().toISOString();
    const cols = [];
    const vals = [];
    for (const [k, v] of Object.entries(update)) {
      if (v instanceof Date) {
        // Date 单独存 ISO 字符串,避免 JSON.stringify 加引号
        cols.push(`${k} = ?`);
        vals.push(v.toISOString());
      } else if (v !== null && typeof v === 'object') {
        cols.push(`${k} = ?`);
        vals.push(JSON.stringify(v));
      } else {
        cols.push(`${k} = ?`);
        vals.push(v);
      }
    }
    cols.push('updatedAt = ?');
    vals.push(now);
    vals.push(sku);
    const r = db
      .prepare(`UPDATE collect_queue_tasks SET ${cols.join(', ')} WHERE sku = ?`)
      .run(...vals);
    return { matchedCount: r.changes };
  },

  /** submit:upsert,firstSeenAt → 用 createdAt ON CONFLICT 不更新 */
  async submit(task) {
    const now = new Date().toISOString();
    // 预查 sku 是否已存在(ON CONFLICT 无法可靠区分 INSERT/UPDATE:lastInsertRowid 在 UPDATE 时保留上次值)
    const existed = !!db.prepare(`SELECT 1 FROM collect_queue_tasks WHERE sku = ?`).get(task.sku);
    const cols = [
      'sku', 'sellerSlug', 'sellerId', 'domInfo', 'status', 'attempts', 'maxAttempts',
      'nextRetryAt', 'lastError', 'startedAt', 'finishedAt', 'steps', 'createdAt', 'updatedAt',
    ];
    const vals = [
      task.sku,
      task.sellerSlug ?? null,
      task.sellerId ?? null,
      task.domInfo ? JSON.stringify(task.domInfo) : null,
      task.status,
      task.attempts ?? 0,
      task.maxAttempts ?? null,
      task.nextRetryAt ?? null,
      task.lastError ? JSON.stringify(task.lastError) : null,
      task.startedAt ?? null,
      task.finishedAt ?? null,
      task.steps ? JSON.stringify(task.steps) : null,
      now, // createdAt(仅首次写入)
      now,
    ];
    // ON CONFLICT(sku) DO UPDATE:不更新 createdAt 和 result
    const updateCols = cols.filter((c) => c !== 'sku' && c !== 'createdAt');
    const setClause = updateCols.map((c) => `${c} = excluded.${c}`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    db
      .prepare(
        `INSERT INTO collect_queue_tasks (${cols.join(', ')}) VALUES (${placeholders})
         ON CONFLICT(sku) DO UPDATE SET ${setClause}`
      )
      .run(...vals.map(toBind));
    return { upsertedCount: existed ? 0 : 1, created: !existed };
  },
};

export const collectQueueOpsDao = {
  async findDedup(op, sku) {
    const row = db
      .prepare(
        `SELECT * FROM collect_queue_ops WHERE op = ? AND sku = ? AND processed = 0 LIMIT 1`
      )
      .get(op, sku);
    if (!row) return null;
    return {
      _id: row._id,
      op: row.op,
      sku: row.sku,
      params: parseJsonCol(row, 'params') || {},
      ts: row.ts,
      processed: !!row.processed,
      processedAt: row.processedAt,
    };
  },

  async insertOp(op, sku, params = {}) {
    const now = new Date().toISOString();
    const r = db
      .prepare(
        `INSERT INTO collect_queue_ops (op, sku, params, ts, processed, processedAt)
         VALUES (?, ?, ?, ?, 0, NULL)`
      )
      .run(op, sku ?? null, JSON.stringify(params), now);
    return { insertedId: r.lastInsertRowid };
  },

  async insertManyOps(docs) {
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO collect_queue_ops (op, sku, params, ts, processed, processedAt)
       VALUES (?, ?, ?, ?, 0, NULL)`
    );
    let insertedCount = 0;
    // 用事务批量插入
    db.exec('BEGIN');
    try {
      for (const d of docs) {
        stmt.run(d.op, d.sku ?? null, JSON.stringify(d.params || {}), d.ts ? new Date(d.ts).toISOString() : now);
        insertedCount++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { insertedCount };
  },

  async findPendingOps(limit = 100) {
    const rows = db
      .prepare(
        `SELECT * FROM collect_queue_ops WHERE processed = 0 ORDER BY ts ASC LIMIT ?`
      )
      .all(limit);
    return rows.map((r) => ({
      _id: r._id,
      op: r.op,
      sku: r.sku,
      params: parseJsonCol(r, 'params') || {},
      ts: r.ts,
      processed: !!r.processed,
      processedAt: r.processedAt,
    }));
  },

  /** markProcessed:id 为 INTEGER,Number 校验替代 ObjectId.isValid */
  async markProcessed(id) {
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) return { matchedCount: 0, modifiedCount: 0 };
    const now = new Date().toISOString();
    const r = db
      .prepare(
        `UPDATE collect_queue_ops SET processed = 1, processedAt = ?
         WHERE _id = ? AND processed = 0`
      )
      .run(now, numId);
    return { matchedCount: r.changes, modifiedCount: r.changes };
  },
};
