// TYPE_ORDER_CANCELLED handler
// 更新 ozon_orders 状态为取消
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';

export default async function orderCancelledHandler(payload, ctx) {
  const orderNumber = payload.order_number;
  if (!orderNumber) throw new Error('ORDER_CANCELLED 缺少 order_number');

  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE ozon_orders SET
      status='order_cancelled',
      uuid=?,
      cancelled_at=?,
      last_received_at=?,
      raw_count=raw_count + 1
    WHERE order_number=?
  `).run(
    payload.uuid ?? null,
    payload.cancelled_at ?? null,
    now,
    orderNumber,
  );

  // 若订单不存在(NEW 推送丢失),插入一条最小记录
  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO ozon_orders
        (order_number, order_id, seller_id, status, uuid, cancelled_at, first_received_at, last_received_at, raw_count)
      VALUES (?, ?, ?, 'order_cancelled', ?, ?, ?, ?, 1)
    `).run(
      orderNumber,
      payload.order_id ?? null,
      payload.seller_id ?? null,
      payload.uuid ?? null,
      payload.cancelled_at ?? null,
      now,
      now,
    );
  }

  logger.info({ orderNumber }, 'ORDER_CANCELLED 落库');
}
