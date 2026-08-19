// TYPE_STATE_CHANGED handler
// 更新 ozon_postings.status(推送模型状态)
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function stateChangedHandler(payload, ctx) {
  const postingNumber = payload.posting_number;
  if (!postingNumber) throw new Error('STATE_CHANGED 缺少 posting_number');

  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE ozon_postings SET status=?, last_received_at=? WHERE posting_number=?
  `).run(payload.new_state ?? null, now, postingNumber);

  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO ozon_postings
        (posting_number, seller_id, warehouse_id, status, first_received_at, last_received_at, raw_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      postingNumber,
      payload.seller_id ?? null,
      payload.warehouse_id ?? null,
      payload.new_state ?? null,
      now,
      now,
    );
  }

  logger.info({ postingNumber, newState: payload.new_state }, 'STATE_CHANGED 落库');
}
