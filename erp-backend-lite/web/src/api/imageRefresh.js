import * as request from './request.js';

// 创建图片更新任务
// 单条: { items: [{sourceTaskId, offerId, productId, storeId, sourceImages?}], templateId? }
// 批量: { records: [{sourceTaskId, storeId}], templateId? } —— 后端按记录展开图片问题 items
export function createImageRefresh(body) {
  return request.post('/admin/api/image-refresh', body);
}

// 任务列表(分页)
export function getImageRefreshList(params) {
  return request.get('/admin/api/image-refresh', params);
}

// 任务详情(含 items)
export function getImageRefreshDetail(localTaskId) {
  return request.get('/admin/api/image-refresh/' + encodeURIComponent(localTaskId));
}

// 重试单项
export function retryImageRefreshItem(localTaskId, itemId) {
  return request.post(
    '/admin/api/image-refresh/' + encodeURIComponent(localTaskId) + '/items/' + itemId + '/retry'
  );
}

// 实时查单个商品图片状态(详情页「检查图片状态」按钮用)
export function getProductPicturesInfo(productId, storeId) {
  return request.post('/admin/api/products/' + encodeURIComponent(productId) + '/pictures-info', { storeId });
}
