// TYPE_FBO_STOCKS_CHANGED handler
// FBO 仓库库存变化:单个 SKU + stocks 对象(含新旧值)
// 复用 ozon_stocks_snapshot,写入 new_present/new_reserved;warehouse_id 为空(FBO 通知不含)
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function fboStocksChangedHandler(payload, ctx) {
  const sku = payload.sku;
  if (sku == null) throw new Error('FBO_STOCKS_CHANGED 缺少 sku');

  const db = getDb();
  const now = new Date().toISOString();
  const stocks = payload.stocks ?? {};

  db.prepare(`
    INSERT INTO ozon_stocks_snapshot
      (seller_id, product_id, sku, warehouse_id, present, reserved, updated_at, received_at)
    VALUES (?, NULL, ?, NULL, ?, ?, ?, ?)
  `).run(
    payload.seller_id ?? null,
    sku,
    stocks.new_present ?? 0,
    stocks.new_reserved ?? 0,
    payload.updated_at ?? null,
    now,
  );

  logger.info({ sku, sellerId: payload.seller_id, newPresent: stocks.new_present }, 'FBO_STOCKS_CHANGED 落库');
}
