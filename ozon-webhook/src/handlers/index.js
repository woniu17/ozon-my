// Handler 分发表:message_type → async (payload, ctx) => {}
// 每个 handler 抛错会被 poller 捕获,自动重试或标记 dead
import newPostingHandler from './new-posting.js';
import postingCancelledHandler from './posting-cancelled.js';
import stateChangedHandler from './state-changed.js';
import cutoffDateChangedHandler from './cutoff-date-changed.js';
import deliveryDateChangedHandler from './delivery-date-changed.js';
import createOrUpdateItemHandler from './create-or-update-item.js';
import stocksChangedHandler from './stocks-changed.js';

const handlers = {
  TYPE_NEW_POSTING: newPostingHandler,
  TYPE_POSTING_CANCELLED: postingCancelledHandler,
  TYPE_STATE_CHANGED: stateChangedHandler,
  TYPE_CUTOFF_DATE_CHANGED: cutoffDateChangedHandler,
  TYPE_DELIVERY_DATE_CHANGED: deliveryDateChangedHandler,
  TYPE_CREATE_OR_UPDATE_ITEM: createOrUpdateItemHandler,
  TYPE_STOCKS_CHANGED: stocksChangedHandler,
};

export default handlers;
