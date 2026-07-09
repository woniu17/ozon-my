import * as request from './request.js';

// 商品数据缓存列表(支持 keyword/storeId 筛选 + 分页)
export function getProducts(params) {
  return request.get('/admin/api/products', params);
}

// 单条商品完整数据(按 sku)
export function getProductDetail(id) {
  return request.get('/admin/api/products/' + encodeURIComponent(id));
}
