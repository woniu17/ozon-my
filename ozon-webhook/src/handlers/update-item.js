// TYPE_UPDATE_ITEM handler(已废弃,2023-07-15 停止发送)
// 仅记录日志,不做业务处理(避免与 TYPE_CREATE_OR_UPDATE_ITEM 重复)
// 仍落库到 ozon_push_events,以保留推送历史
import logger from '../middleware/log.js';

export default async function updateItemHandler(payload, ctx) {
  const productId = payload.product_id;
  logger.warn(
    { productId, sellerId: payload.seller_id, isError: payload.is_error, changedAt: payload.changed_at },
    'TYPE_UPDATE_ITEM 已废弃,仅记录,不做业务处理',
  );
  // 不写任何业务表,直接成功
}
