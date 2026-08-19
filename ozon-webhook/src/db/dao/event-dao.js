// 事件 DAO:raw_events 表的增删改查
import { getDb } from '../index.js';

/**
 * 插入事件;命中 UNIQUE 冲突视为重复,返回 inserted=false
 * @returns {{inserted:boolean, id?:number}}
 */
export function insertEvent({ message_type, idempotency_key, seller_id, posting_number, product_id, sku, chat_id, order_number, raw_payload }) {
  const db = getDb();
  const received_at = new Date().toISOString();
  try {
    const stmt = db.prepare(`
      INSERT INTO ozon_push_events
        (message_type, idempotency_key, seller_id, posting_number, product_id, sku, chat_id, order_number, raw_payload, status, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);
    stmt.run(message_type, idempotency_key, seller_id, posting_number, product_id, sku, chat_id, order_number, raw_payload, received_at);
    return { inserted: true, id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
  } catch (err) {
    // UNIQUE 冲突(SQLITE_CONSTRAINT)
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/i.test(err.message)) {
      return { inserted: false };
    }
    throw err;
  }
}

/**
 * Poller 拉取 pending 事件并原子标记为 processing
 * @param {number} limit
 * @param {number} maxRetry 超过此重试次数的事件不再被 claim(直接由 dead 处理)
 * @returns {Array} 事件列表
 */
export function claimPendingEvents(limit, maxRetry) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const rows = db.prepare(`
      SELECT * FROM ozon_push_events
      WHERE status = 'pending' AND retry_count < ?
      ORDER BY received_at ASC
      LIMIT ?
    `).all(maxRetry, limit);

    if (rows.length === 0) {
      db.exec('COMMIT');
      return [];
    }
    const ids = rows.map(r => r.id).join(',');
    db.exec(`UPDATE ozon_push_events SET status='processing' WHERE id IN (${ids})`);
    db.exec('COMMIT');
    return rows;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 标记事件成功
 */
export function markSuccess(id) {
  const db = getDb();
  db.prepare(`UPDATE ozon_push_events SET status='success', processed_at=? WHERE id=?`)
    .run(new Date().toISOString(), id);
}

/**
 * 标记事件失败,根据 retry_count 决定回到 pending 还是 dead
 */
export function markFailed(id, retryCount, maxRetry, errMsg) {
  const db = getDb();
  const newRetry = retryCount + 1;
  const newStatus = newRetry >= maxRetry ? 'dead' : 'pending';
  db.prepare(`
    UPDATE ozon_push_events
    SET status=?, retry_count=?, last_error=?
    WHERE id=?
  `).run(newStatus, newRetry, errMsg, id);
  return newStatus;
}

/**
 * 立即标记为 dead(不重试)
 * 用于不可恢复的错误,如未知的 message_type
 */
export function markDead(id, errMsg) {
  const db = getDb();
  db.prepare(`
    UPDATE ozon_push_events
    SET status='dead', last_error=?
    WHERE id=?
  `).run(errMsg, id);
  return 'dead';
}
