// TYPE_ORDER_NEW handler
// 订单级通知:一个订单可包含多个货件(posting)
// 落库 ozon_orders + 推送飞书机器人
import { getDb } from '../db/index.js';
import { notifyOrderEvent } from '../services/feishu-notify.js';
import logger from '../middleware/log.js';

export default async function orderNewHandler(payload, ctx) {
  const orderNumber = payload.order_number;
  if (!orderNumber) throw new Error('ORDER_NEW 缺少 order_number');

  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO ozon_orders
      (order_number, order_id, seller_id, status, uuid, created_at, first_received_at, last_received_at, raw_count)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 1)
    ON CONFLICT(order_number) DO UPDATE SET
      order_id=excluded.order_id,
      seller_id=excluded.seller_id,
      uuid=excluded.uuid,
      created_at=COALESCE(excluded.created_at, ozon_orders.created_at),
      last_received_at=excluded.last_received_at,
      raw_count=ozon_orders.raw_count + 1
  `).run(
    orderNumber,
    payload.order_id ?? null,
    payload.seller_id ?? null,
    payload.uuid ?? null,
    payload.created_at ?? null,
    now,
    now,
  );

  logger.info({ orderNumber, orderId: payload.order_id, sellerId: payload.seller_id }, 'ORDER_NEW 落库');

  // 推送飞书(失败不影响落库结果)
  await notifyOrderEvent('TYPE_ORDER_NEW', payload).catch(err =>
    logger.warn({ err: err.message }, 'ORDER_NEW 飞书通知失败'),
  );
}
