// Handler 分发表:message_type → async (payload, ctx) => {}
// 每个 handler 抛错会被 poller 捕获,自动重试或标记 dead

// 订单类(5 种)
import newPostingHandler from './new-posting.js';
import postingCancelledHandler from './posting-cancelled.js';
import stateChangedHandler from './state-changed.js';
import cutoffDateChangedHandler from './cutoff-date-changed.js';
import deliveryDateChangedHandler from './delivery-date-changed.js';

// 商品类(3 种,含 2 种已废弃)
import createOrUpdateItemHandler from './create-or-update-item.js';
import createItemHandler from './create-item.js';
import updateItemHandler from './update-item.js';

// 库存类
import stocksChangedHandler from './stocks-changed.js';

// 聊天类(4 种)
import newMessageHandler from './new-message.js';
import updateMessageHandler from './update-message.js';
import messageReadHandler from './message-read.js';
import chatClosedHandler from './chat-closed.js';

// 类目树
import descriptionCategoryTreeChangedHandler from './description-category-tree-changed.js';

const handlers = {
  // 订单类
  TYPE_NEW_POSTING: newPostingHandler,
  TYPE_POSTING_CANCELLED: postingCancelledHandler,
  TYPE_STATE_CHANGED: stateChangedHandler,
  TYPE_CUTOFF_DATE_CHANGED: cutoffDateChangedHandler,
  TYPE_DELIVERY_DATE_CHANGED: deliveryDateChangedHandler,
  // 商品类
  TYPE_CREATE_OR_UPDATE_ITEM: createOrUpdateItemHandler,
  TYPE_CREATE_ITEM: createItemHandler,           // 已废弃,仅记录
  TYPE_UPDATE_ITEM: updateItemHandler,           // 已废弃,仅记录
  // 库存类
  TYPE_STOCKS_CHANGED: stocksChangedHandler,
  // 聊天类
  TYPE_NEW_MESSAGE: newMessageHandler,
  TYPE_UPDATE_MESSAGE: updateMessageHandler,
  TYPE_MESSAGE_READ: messageReadHandler,
  TYPE_CHAT_CLOSED: chatClosedHandler,
  // 类目树
  TYPE_DESCRIPTION_CATEGORY_TREE_CHANGED: descriptionCategoryTreeChangedHandler,
};

export default handlers;
