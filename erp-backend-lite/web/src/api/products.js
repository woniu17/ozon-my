import * as request from './request.js';

// 商品数据缓存列表(支持 keyword/storeId 筛选 + 分页)
export function getProducts(params) {
  return request.get('/admin/api/products', params);
}

// 单条商品完整数据(按 sku)
export function getProductDetail(id) {
  return request.get('/admin/api/products/' + encodeURIComponent(id));
}

// 从 Ozon 拉取店铺全部商品并写入 product_data_cache(阻塞返回)
export function syncProducts(storeId) {
  return request.post('/admin/api/products/sync?storeId=' + encodeURIComponent(storeId));
}

// 批量拉取商品描述(/v1/product/info/description)并计算描述质量标记
// force=1 时强制重新拉取已缓存的描述,默认增量(仅拉未缓存的)
export function syncProductDescriptions(storeId, force = false) {
  const q = 'storeId=' + encodeURIComponent(storeId) + (force ? '&force=1' : '');
  return request.post('/admin/api/products/sync-descriptions?' + q);
}

// 查询所有店铺的同步进度(轮询用)
export function getSyncProgress() {
  return request.get('/admin/api/products/sync-progress');
}

// 删除单条商品缓存(仅删除 ERP 本地缓存,不影响 Ozon 后台商品)
export function deleteProduct(sku) {
  return request.del('/admin/api/products/' + encodeURIComponent(sku));
}

// 批量删除商品缓存
// body: { skus: ['sku1','sku2',...] }  响应: { deleted, notFound }
export function deleteProductsBatch(skus) {
  return request.post('/admin/api/products/delete-batch', { skus });
}
