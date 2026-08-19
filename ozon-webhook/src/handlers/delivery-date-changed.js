// TYPE_DELIVERY_DATE_CHANGED handler
// 更新 ozon_postings.delivery_date_begin/end
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function deliveryDateChangedHandler(payload, ctx) {
  const postingNumber = payload.posting_number;
  if (!postingNumber) throw new Error('DELIVERY_DATE_CHANGED 缺少 posting_number');

  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE ozon_postings SET
      delivery_date_begin=?,
      delivery_date_end=?,
      last_received_at=?
    WHERE posting_number=?
  `).run(
    payload.new_delivery_date_begin ?? null,
    payload.new_delivery_date_end ?? null,
    now,
    postingNumber,
  );

  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO ozon_postings
        (posting_number, seller_id, warehouse_id, delivery_date_begin, delivery_date_end,
         first_received_at, last_received_at, raw_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      postingNumber,
      payload.seller_id ?? null,
      payload.warehouse_id ?? null,
      payload.new_delivery_date_begin ?? null,
      payload.new_delivery_date_end ?? null,
      now,
      now,
    );
  }

  logger.info({ postingNumber, newBegin: payload.new_delivery_date_begin }, 'DELIVERY_DATE_CHANGED 落库');
}
