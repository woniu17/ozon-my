// TYPE_CUTOFF_DATE_CHANGED handler
// 更新 ozon_postings.cutoff_date
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function cutoffDateChangedHandler(payload, ctx) {
  const postingNumber = payload.posting_number;
  if (!postingNumber) throw new Error('CUTOFF_DATE_CHANGED 缺少 posting_number');

  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE ozon_postings SET cutoff_date=?, last_received_at=? WHERE posting_number=?
  `).run(payload.new_cutoff_date ?? null, now, postingNumber);

  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO ozon_postings
        (posting_number, seller_id, warehouse_id, cutoff_date, first_received_at, last_received_at, raw_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      postingNumber,
      payload.seller_id ?? null,
      payload.warehouse_id ?? null,
      payload.new_cutoff_date ?? null,
      now,
      now,
    );
  }

  logger.info({ postingNumber, newCutoff: payload.new_cutoff_date }, 'CUTOFF_DATE_CHANGED 落库');
}
