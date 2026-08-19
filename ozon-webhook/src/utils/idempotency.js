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
    // ── 订单类(5 种)──
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
    // ── 商品类(3 种)──
    case 'TYPE_CREATE_OR_UPDATE_ITEM':
      return `TYPE_CREATE_OR_UPDATE_ITEM:${payload.product_id}:${payload.changed_at}`;
    case 'TYPE_CREATE_ITEM':
      // 已废弃(2023-07-15),但仍可能收到,幂等键结构与 CREATE_OR_UPDATE_ITEM 一致
      return `TYPE_CREATE_ITEM:${payload.product_id}:${payload.changed_at}`;
    case 'TYPE_UPDATE_ITEM':
      // 已废弃(2023-07-15),同上
      return `TYPE_UPDATE_ITEM:${payload.product_id}:${payload.changed_at}`;
    // ── 库存类 ──
    case 'TYPE_STOCKS_CHANGED': {
      // STOCKS_CHANGED 是批量消息,items[] 内每个 item 一个 key
      // 但事件本身是整条,这里用整条首 item 的 sku+updated_at 作为事件级 key
      const first = payload.items?.[0];
      if (!first) {
        throw new AppError({ status: 400, code: 'ERROR_PARAMETER_VALUE_MISSED', message: 'STOCKS_CHANGED 缺少 items' });
      }
      return `TYPE_STOCKS_CHANGED:${first.sku}:${first.updated_at}:${first.stocks?.[0]?.warehouse_id ?? 'na'}`;
    }
    // ── 聊天类(4 种)──
    case 'TYPE_NEW_MESSAGE':
      return `TYPE_NEW_MESSAGE:${payload.chat_id}:${payload.message_id}`;
    case 'TYPE_UPDATE_MESSAGE':
      return `TYPE_UPDATE_MESSAGE:${payload.chat_id}:${payload.message_id}:${payload.updated_at}`;
    case 'TYPE_MESSAGE_READ':
      return `TYPE_MESSAGE_READ:${payload.chat_id}:${payload.last_read_message_id}`;
    case 'TYPE_CHAT_CLOSED':
      return `TYPE_CHAT_CLOSED:${payload.chat_id}`;
    // ── 类目树 ──
    case 'TYPE_DESCRIPTION_CATEGORY_TREE_CHANGED':
      return `TYPE_DESCRIPTION_CATEGORY_TREE_CHANGED:${payload.changed_at}`;
    // ── ORDER 级(3 种)──
    case 'TYPE_ORDER_NEW':
      return `TYPE_ORDER_NEW:${payload.order_number}`;
    case 'TYPE_ORDER_CANCELLED':
      return `TYPE_ORDER_CANCELLED:${payload.order_number}:${payload.uuid}`;
    case 'TYPE_ORDER_STATE_CHANGED':
      return `TYPE_ORDER_STATE_CHANGED:${payload.order_number}:${payload.new_state}:${payload.uuid}`;
    // ── FBO 货件(4 种)──
    case 'TYPE_FBO_POSTING_NEW':
      return `TYPE_FBO_POSTING_NEW:${payload.posting_number}:${payload.uuid}`;
    case 'TYPE_FBO_POSTING_CANCELLED':
      return `TYPE_FBO_POSTING_CANCELLED:${payload.posting_number}:${payload.uuid}`;
    case 'TYPE_FBO_POSTING_STATE_CHANGED':
      return `TYPE_FBO_POSTING_STATE_CHANGED:${payload.posting_number}:${payload.new_state}:${payload.uuid}`;
    case 'TYPE_FBO_POSTING_DELIVERY_DATE_CHANGED':
      return `TYPE_FBO_POSTING_DELIVERY_DATE_CHANGED:${payload.posting_number}:${payload.new_delivery_date_begin}:${payload.uuid}`;
    // ── FBO 库存 ──
    case 'TYPE_FBO_STOCKS_CHANGED':
      return `TYPE_FBO_STOCKS_CHANGED:${payload.sku}:${payload.updated_at}`;
    default:
      // 未知类型也落库,handler 分发表会拒绝并标 dead
      return `UNKNOWN:${messageType}:${Date.now()}`;
  }
}

/**
 * 提取冗余字段(便于按 posting_number/sku/product_id/chat_id 查询)
 */
export function extractIndexFields(messageType, payload) {
  const fields = {
    seller_id: typeof payload.seller_id === 'number' ? payload.seller_id : null,
    posting_number: payload.posting_number ?? null,
    product_id: payload.product_id ?? null,
    sku: null,
    chat_id: payload.chat_id ?? null,
    order_number: payload.order_number ?? null,
  };
  if (messageType === 'TYPE_STOCKS_CHANGED') {
    const first = payload.items?.[0];
    if (first) fields.sku = first.sku ?? null;
  }
  // FBO 货件含 order_number + posting_number,两者都提取
  if (messageType.startsWith('TYPE_FBO_POSTING')) {
    fields.order_number = payload.order_number ?? null;
  }
  return fields;
}
