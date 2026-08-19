// TYPE_FBO_POSTING_CANCELLED handler
// 更新 ozon_postings 状态为 posting_canceled,记录取消原因与 cancel_date
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function fboPostingCancelledHandler(payload, ctx) {
  const postingNumber = payload.posting_number;
  if (!postingNumber) throw new Error('FBO_POSTING_CANCELLED 缺少 posting_number');

  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE ozon_postings SET
      status=?,
      order_number=?,
      uuid=?,
      posting_type='fbo',
      cancel_reason_id=?,
      cancel_reason_message=?,
      cancel_date=?,
      last_received_at=?
    WHERE posting_number=?
  `).run(
    payload.new_state ?? 'posting_canceled',
    payload.order_number ?? null,
    payload.uuid ?? null,
    payload.reason?.id ?? null,
    payload.reason?.message ?? null,
    payload.cancel_date ?? null,
    now,
    postingNumber,
  );

  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO ozon_postings
        (posting_number, seller_id, warehouse_id, status, order_number, uuid, posting_type,
         cancel_reason_id, cancel_reason_message, cancel_date, first_received_at, last_received_at, raw_count)
      VALUES (?, ?, ?, ?, ?, ?, 'fbo', ?, ?, ?, ?, ?, 1)
    `).run(
      postingNumber,
      payload.seller_id ?? null,
      payload.warehouse_id ?? null,
      payload.new_state ?? 'posting_canceled',
      payload.order_number ?? null,
      payload.uuid ?? null,
      payload.reason?.id ?? null,
      payload.reason?.message ?? null,
      payload.cancel_date ?? null,
      now,
      now,
    );
  }

  logger.info({ postingNumber, newState: payload.new_state }, 'FBO_POSTING_CANCELLED 落库');
}
