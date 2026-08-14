import * as request from './request.js';

// 创建商品归档任务
// 单条: { items: [{ productId, storeId, offerId? }] }
// 批量: { products: [{ productId, storeId }] }
// 按筛选: { filters: { storeId, keyword, productStatus, hasStock, imageIssue, descriptionQuality } }
export function createProductArchive(body) {
  return request.post('/admin/api/product-archive', body);
}

// 任务列表(分页)
export function getProductArchiveList(params) {
  return request.get('/admin/api/product-archive', params);
}

// 任务详情(含 items)
export function getProductArchiveDetail(localTaskId) {
  return request.get('/admin/api/product-archive/' + encodeURIComponent(localTaskId));
}

// 重试单项
export function retryProductArchiveItem(localTaskId, itemId) {
  return request.post(
    '/admin/api/product-archive/' + encodeURIComponent(localTaskId) + '/items/' + itemId + '/retry'
  );
}
