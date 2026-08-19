// 幂等键生成器:每种 message_type 用不同字段组合
// 设计原则:同一业务事件多次推送产生相同 key,命中 UNIQUE 即视为重复

import { AppError } from '../middleware/error.js';

/**
 * 生成幂等键
 * @param {string} messageType
 * @param {object} payload Ozon 推送的原始 JSON
 * @returns {string|null} 幂等键;PING 返回 null(不落库)
 */
export function genIdempotencyKey(messageType, payload) {
  switch (messageType) {
    case 'TYPE_PING':
      return null; // 不落库
    case 'TYPE_NEW_POSTING':
      return `TYPE_NEW_POSTING:${payload.posting_number}`;
    case 'TYPE_POSTING_CANCELLED':
      return `TYPE_POSTING_CANCELLED:${payload.posting_number}:${payload.changed_state_date}`;
    case 'TYPE_STATE_CHANGED':
      return `TYPE_STATE_CHANGED:${payload.posting_number}:${payload.new_state}:${payload.changed_state_date}`;
    case 'TYPE_CUTOFF_DATE_CHANGED':
      return `TYPE_CUTOFF_DATE_CHANGED:${payload.posting_number}:${payload.new_cutoff_date}`;
    case 'TYPE_DELIVERY_DATE_CHANGED':
      return `TYPE_DELIVERY_DATE_CHANGED:${payload.posting_number}:${payload.new_delivery_date_begin}`;
    case 'TYPE_CREATE_OR_UPDATE_ITEM':
      return `TYPE_CREATE_OR_UPDATE_ITEM:${payload.product_id}:${payload.changed_at}`;
    case 'TYPE_STOCKS_CHANGED': {
      // STOCKS_CHANGED 是批量消息,items[] 内每个 item 一个 key
      // 但事件本身是整条,这里用整条首 item 的 sku+updated_at 作为事件级 key
      // 单个 item 级去重在 handler 写 ozon_stocks_snapshot 时用 UNIQUE 处理(后续可加约束)
      const first = payload.items?.[0];
      if (!first) {
        throw new AppError({ status: 400, code: 'ERROR_PARAMETER_VALUE_MISSED', message: 'STOCKS_CHANGED 缺少 items' });
      }
      return `TYPE_STOCKS_CHANGED:${first.sku}:${first.updated_at}:${first.stocks?.[0]?.warehouse_id ?? 'na'}`;
    }
    default:
      // 未知类型也落库,handler 分发表会拒绝并标 dead
      return `UNKNOWN:${messageType}:${Date.now()}`;
  }
}

/**
 * 提取冗余字段(便于按 posting_number/sku/product_id 查询)
 */
export function extractIndexFields(messageType, payload) {
  const fields = {
    seller_id: typeof payload.seller_id === 'number' ? payload.seller_id : null,
    posting_number: payload.posting_number ?? null,
    product_id: payload.product_id ?? null,
    sku: null,
  };
  if (messageType === 'TYPE_STOCKS_CHANGED') {
    const first = payload.items?.[0];
    if (first) fields.sku = first.sku ?? null;
  }
  return fields;
}
