import * as request from './request.js';

// 采集箱·缓存视图(以 cardCache 为基准聚合 7 类缓存命中状态)
// params: { page, pageSize, keyword, hasVideo, minCacheHits }
export function getCollectBoxV2FromCache(params) {
  return request.get('/admin/api/collect-box-v2/from-cache', params);
}

// 上架预览·SKU 全息画像(聚合 7 类缓存,返回 original + 合成 OPI item)
// storeId 可选,传入则按类目字典过滤属性
export function getSkuProfile(sku, storeId) {
  const params = storeId ? { storeId } : {};
  return request.get('/admin/api/preview/sku/' + encodeURIComponent(sku) + '/profile', params);
}

// 上架预览·一键提交(走 /ozon/products/import,需 x-ozon-store-id header)
// items: 合成 OPI 输入 item 数组(从 profile 接口拿到 item 后可改 price)
export function submitPreviewImport(items, storeId) {
  return request.request('/ozon/products/import', {
    method: 'POST',
    headers: { 'x-ozon-store-id': storeId },
    body: { items },
  });
}

// 属性字典:查类目+类型下所有属性描述(名/描述/类型/字典)
export function getAttributeDictionary(storeId, categoryId, typeId) {
  return request.get('/admin/api/collect-box-v2/attribute-dictionary', { storeId, categoryId, typeId });
}

// 类目名 + 类型名 + descriptionCategoryId(按 typeId 在类目树 DFS 查找)
export function getCategoryNames(storeId, typeId) {
  return request.get('/admin/api/collect-box-v2/category-names', { storeId, typeId });
}

// 字典属性可选值
export function getAttributeValues(storeId, categoryId, typeId, attributeId) {
  return request.get('/admin/api/collect-box-v2/attribute-values', {
    storeId,
    categoryId,
    typeId,
    attributeId,
  });
}
