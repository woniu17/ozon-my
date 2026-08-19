// TYPE_CREATE_OR_UPDATE_ITEM handler
// 写入 ozon_products_pending_refresh,供后续 erp 消费(首批仅落库)
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function createOrUpdateItemHandler(payload, ctx) {
  const productId = payload.product_id;
  if (!productId) throw new Error('CREATE_OR_UPDATE_ITEM 缺少 product_id');

  const db = getDb();
  const now = new Date().toISOString();

  // ON CONFLICT(product_id) → 用最新 changed_at 覆盖(同商品多次更新取最新)
  db.prepare(`
    INSERT INTO ozon_products_pending_refresh
      (product_id, seller_id, offer_id, is_error, changed_at, received_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(product_id) DO UPDATE SET
      seller_id=excluded.seller_id,
      offer_id=excluded.offer_id,
      is_error=excluded.is_error,
      changed_at=excluded.changed_at,
      received_at=excluded.received_at,
      consumed_at=NULL
  `).run(
    productId,
    payload.seller_id ?? null,
    payload.offer_id ?? null,
    payload.is_error ? 1 : 0,
    payload.changed_at ?? null,
    now,
  );

  logger.info({ productId, isError: payload.is_error }, 'CREATE_OR_UPDATE_ITEM 落库');
}
