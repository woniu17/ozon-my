import * as request from './request.js';

// 创建库存更新任务
// 单条: { items: [{ productId, storeId, offerId? }], stockValue }
// 批量: { products: [{ productId, storeId }], stockValue }
export function createStockRefresh(body) {
  return request.post('/admin/api/stock-refresh', body);
}

// 任务列表(分页)
export function getStockRefreshList(params) {
  return request.get('/admin/api/stock-refresh', params);
}

// 任务详情(含 items)
export function getStockRefreshDetail(localTaskId) {
  return request.get('/admin/api/stock-refresh/' + encodeURIComponent(localTaskId));
}

// 重试单项
export function retryStockRefreshItem(localTaskId, itemId) {
  return request.post(
    '/admin/api/stock-refresh/' + encodeURIComponent(localTaskId) + '/items/' + itemId + '/retry'
  );
}
