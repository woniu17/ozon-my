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

  /** 查最近 antibot 任务:json_extract(lastError, '$.type') = 'antibot'
   *  antibot 不再是终态,SW 会把 antibot 任务回 pending 重试(走 _handlePartialTask, errorType='antibot')
   *  此处查询用于推导熔断状态:最近 10 分钟内有 antibot 任务则认为熔断中
   */
  async findLatestAntibotBlocked(since) {
    const sinceIso = new Date(since).toISOString();
    const row = db
      .prepare(
        `SELECT finishedAt, lastError FROM collect_queue_tasks
         WHERE json_extract(lastError, '$.type') = 'antibot'
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

  async findList(filter = {}, page, pageSize, sort) {
    const whereParts = [];
    const params = [];
    if (filter.status) {
      whereParts.push('status = ?');
      params.push(filter.status);
    }
    const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const skip = (page - 1) * pageSize;
    // 排序:默认 createdAt DESC。sort 参数格式 { col: 'ASC'|'DESC' }
    // 白名单列名防 SQL 注入
    const SORT_ALLOWED = ['createdAt', 'updatedAt', 'finishedAt', 'startedAt', 'status', 'sku', 'attempts'];
    let orderBy = 'ORDER BY createdAt DESC';
    if (sort && typeof sort === 'object') {
      const parts = Object.entries(sort)
        .filter(([col]) => SORT_ALLOWED.includes(col))
        .map(([col, dir]) => `${col} ${String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`);
      if (parts.length) orderBy = `ORDER BY ${parts.join(', ')}`;
    }
    const rows = db
      .prepare(
        `SELECT * FROM collect_queue_tasks ${where} ${orderBy} LIMIT ? OFFSET ?`
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
         SET status = 'pending', attempts = 0, lastError = NULL, updatedAt = ?
         WHERE sku = ?`
      )
      .run(now, sku);
    return { matchedCount: r.changes, modifiedCount: r.changes };
  },

  /**
   * 原子抢占下一个可消费任务(SQLite UPDATE...RETURNING)
   * 条件:status='pending'(已移除 failed_retry 退避机制,失败任务直接回 pending)
   * 副作用:status→'running', startedAt→now, attempts+1, updatedAt→now
   * 多 SW 实例并发安全:UPDATE...RETURNING 在 SQLite 中是原子的
   */
  async claimNextPending(now = new Date()) {
    const nowIso = now.toISOString();
    const row = db
      .prepare(
        `UPDATE collect_queue_tasks
         SET status = 'running',
             startedAt = ?,
             attempts = attempts + 1,
             updatedAt = ?
         WHERE _id = (
           SELECT _id FROM collect_queue_tasks
           WHERE status = 'pending'
           ORDER BY createdAt ASC
           LIMIT 1
         )
         RETURNING *`
      )
      .get(nowIso, nowIso);
    return row ? reshapeTask(row) : null;
  },

  /**
   * 重置超时 running 任务为 pending(僵尸任务恢复)
   * 条件:status='running' 且 startedAt < cutoff
   * 副作用:status→'pending', lastError→STALE, updatedAt→now
   * 注:已移除 nextRetryAt 退避,直接回 pending 等待下次 claim
   */
  async resetStaleRunning(staleMs = 5 * 60 * 1000, now = new Date()) {
    const cutoffIso = new Date(now.getTime() - staleMs).toISOString();
    const nowIso = now.toISOString();
    const lastError = JSON.stringify({ type: 'STALE', message: 'running timeout, reset by stale-reset' });
    const r = db
      .prepare(
        `UPDATE collect_queue_tasks
         SET status = 'pending',
             lastError = ?,
             updatedAt = ?
         WHERE status = 'running' AND startedAt < ?`
      )
      .run(lastError, nowIso, cutoffIso);
    return { resetCount: r.changes };
  },

  /**
   * 清理终态任务,保留最新 N 条(按 finishedAt 降序)
   * 终态:success / skipped
   */
  async cleanupTerminalTasks(keepCount = 500) {
    const cnt = db
      .prepare(
        `SELECT COUNT(*) AS n FROM collect_queue_tasks
         WHERE status IN ('success', 'skipped')`
      )
      .get().n;
    if (cnt <= keepCount) return { deletedCount: 0, total: cnt };

    const toDelete = cnt - keepCount;
    const r = db
      .prepare(
        `DELETE FROM collect_queue_tasks
         WHERE _id IN (
           SELECT _id FROM collect_queue_tasks
           WHERE status IN ('success', 'skipped')
           ORDER BY finishedAt ASC
           LIMIT ?
         )`
      )
      .run(toDelete);
    return { deletedCount: r.changes, total: cnt };
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
         SET status = 'pending', attempts = 0, lastError = NULL, updatedAt = ?
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

  /**
   * submit:upsert,firstSeenAt → 用 createdAt ON CONFLICT 不更新
   * options.skipIfTodaySuccess(true 默认):若该 SKU 今日(最近 24h)已有 success 任务,跳过入队
   *   场景:SW 多次扫描同一商品时,避免重复入队已成功采集的 SKU
   *   返回 { upsertedCount, created, skipped: true } 表示因今日已成功而跳过
   */
  async submit(task, options = {}) {
    const { skipIfTodaySuccess = true } = options;
    const now = new Date();
    const nowIso = now.toISOString();

    // 今日去重:24h 内有 success 任务则跳过(不更新已有任务,不新建)
    if (skipIfTodaySuccess) {
      const sinceIso = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
      const todaySuccess = db
        .prepare(
          `SELECT 1 FROM collect_queue_tasks
           WHERE sku = ? AND status = 'success' AND finishedAt >= ?`
        )
        .get(task.sku, sinceIso);
      if (todaySuccess) {
        return { upsertedCount: 0, created: false, skipped: true };
      }
    }

    // 预查 sku 是否已存在(ON CONFLICT 无法可靠区分 INSERT/UPDATE:lastInsertRowid 在 UPDATE 时保留上次值)
    const existed = !!db.prepare(`SELECT 1 FROM collect_queue_tasks WHERE sku = ?`).get(task.sku);
    const cols = [
      'sku', 'sellerSlug', 'sellerId', 'domInfo', 'status', 'attempts',
      'lastError', 'startedAt', 'finishedAt', 'steps', 'createdAt', 'updatedAt',
    ];
    const vals = [
      task.sku,
      task.sellerSlug ?? null,
      task.sellerId ?? null,
      task.domInfo ? JSON.stringify(task.domInfo) : null,
      task.status,
      task.attempts ?? 0,
      task.lastError ? JSON.stringify(task.lastError) : null,
      task.startedAt ?? null,
      task.finishedAt ?? null,
      task.steps ? JSON.stringify(task.steps) : null,
      // createdAt:SW _handlePartialTask 传则刷新(失败排到队尾);首次入队用 now
      task.createdAt ?? now,
      now,
    ];
    // ON CONFLICT(sku) DO UPDATE:不更新 sku 和 result(createdAt 在传入时更新)
    const updateCols = cols.filter((c) => c !== 'sku');
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
