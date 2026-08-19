// TYPE_FBO_POSTING_NEW handler
// FBO 货件(Fulfillment by Ozon):复用 ozon_postings 表,posting_type='fbo'
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function fboPostingNewHandler(payload, ctx) {
  const postingNumber = payload.posting_number;
  if (!postingNumber) throw new Error('FBO_POSTING_NEW 缺少 posting_number');

  const db = getDb();
  const now = new Date().toISOString();
  const productsJson = JSON.stringify(payload.products ?? []);

  db.prepare(`
    INSERT INTO ozon_postings
      (posting_number, seller_id, warehouse_id, status, products_json, order_number, uuid,
       posting_type, creation_date, first_received_at, last_received_at, raw_count)
    VALUES (?, ?, ?, 'posting_created', ?, ?, ?, 'fbo', ?, ?, ?, 1)
    ON CONFLICT(posting_number) DO UPDATE SET
      seller_id=excluded.seller_id,
      warehouse_id=excluded.warehouse_id,
      products_json=excluded.products_json,
      order_number=excluded.order_number,
      uuid=excluded.uuid,
      posting_type='fbo',
      creation_date=COALESCE(excluded.creation_date, ozon_postings.creation_date),
      last_received_at=excluded.last_received_at,
      raw_count=ozon_postings.raw_count + 1
  `).run(
    postingNumber,
    payload.seller_id ?? null,
    payload.warehouse_id ?? null,
    productsJson,
    payload.order_number ?? null,
    payload.uuid ?? null,
    payload.creation_date ?? null,
    now,
    now,
  );

  logger.info({ postingNumber, orderNumber: payload.order_number }, 'FBO_POSTING_NEW 落库');
}
