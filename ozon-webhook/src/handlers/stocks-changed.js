// TYPE_STOCKS_CHANGED handler
// 批量写入 ozon_stocks_snapshot(追加式,保留历史)
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function stocksChangedHandler(payload, ctx) {
  const items = payload.items ?? [];
  if (items.length === 0) throw new Error('STOCKS_CHANGED 缺少 items');

  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO ozon_stocks_snapshot
      (seller_id, product_id, sku, warehouse_id, present, reserved, updated_at, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.exec('BEGIN');
  try {
    for (const item of items) {
      for (const stock of item.stocks ?? []) {
        stmt.run(
          payload.seller_id ?? null,
          item.product_id ?? null,
          item.sku ?? null,
          stock.warehouse_id ?? null,
          stock.present ?? 0,
          stock.reserved ?? 0,
          item.updated_at ?? null,
          now,
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  logger.info({ sellerId: payload.seller_id, itemCount: items.length }, 'STOCKS_CHANGED 落库');
}
