// TYPE_ORDER_STATE_CHANGED handler
// 更新 ozon_orders.status(订单级状态 order_ 前缀) + 推送飞书
import { getDb } from '../db/index.js';
import { notifyOrderEvent } from '../services/feishu-notify.js';
import logger from '../middleware/log.js';

export default async function orderStateChangedHandler(payload, ctx) {
  const orderNumber = payload.order_number;
  if (!orderNumber) throw new Error('ORDER_STATE_CHANGED 缺少 order_number');

  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE ozon_orders SET
      status=?,
      uuid=?,
      updated_at=?,
      last_received_at=?,
      raw_count=raw_count + 1
    WHERE order_number=?
  `).run(
    payload.new_state ?? null,
    payload.uuid ?? null,
    payload.updated_at ?? null,
    now,
    orderNumber,
  );

  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO ozon_orders
        (order_number, order_id, seller_id, status, uuid, updated_at, first_received_at, last_received_at, raw_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      orderNumber,
      payload.order_id ?? null,
      payload.seller_id ?? null,
      payload.new_state ?? null,
      payload.uuid ?? null,
      payload.updated_at ?? null,
      now,
      now,
    );
  }

  logger.info({ orderNumber, oldState: payload.old_state, newState: payload.new_state }, 'ORDER_STATE_CHANGED 落库');

  await notifyOrderEvent('TYPE_ORDER_STATE_CHANGED', payload).catch(err =>
    logger.warn({ err: err.message }, 'ORDER_STATE_CHANGED 飞书通知失败'),
  );
}
