import * as request from './request.js';

// 创建商品信息更新任务
// body: { storeId, items: [{ productId, offerId, updateFields:[...], newValues:{...} }] }
export function createProductUpdate(body) {
  return request.post('/admin/api/product-update', body);
}

// 任务列表(分页)
export function getProductUpdateList(params) {
  return request.get('/admin/api/product-update', params);
}

// 任务详情(含 items)
export function getProductUpdateDetail(localTaskId) {
  return request.get('/admin/api/product-update/' + encodeURIComponent(localTaskId));
}

// 取消未处理 items
export function cancelProductUpdate(localTaskId) {
  return request.post('/admin/api/product-update/' + encodeURIComponent(localTaskId) + '/cancel');
}

// 重试单个失败 item
export function retryProductUpdateItem(localTaskId, itemId) {
  return request.post(
    '/admin/api/product-update/' + encodeURIComponent(localTaskId) + '/items/' + itemId + '/retry'
  );
}

// 预览:根据 offer_id 拉当前商品信息
// body: { storeId, offerId }
export function previewProductUpdate(body) {
  return request.post('/admin/api/product-update/preview', body);
}

// 查询当前支持更新的字段列表
export function getSupportedFields() {
  return request.get('/admin/api/product-update/supported-fields');
}
