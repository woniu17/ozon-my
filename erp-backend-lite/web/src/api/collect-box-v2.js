import * as request from './request.js';

// 采集箱·缓存视图(以 cardCache 为基准聚合 7 类缓存命中状态)
// params: { currentPage, pageSize, keyword, hasVideo, minCacheHits, sellerId, unlisted }
// 2026-07:sellerId 优先(稳定主键);sellerSlug 兼容保留(可变,店铺改名时变)
export function getCollectBoxV2FromCache(params) {
  return request.get('/admin/api/collect-box-v2/from-cache', params);
}

// 采集源卖家列表(供下拉框)— 从 ozon_store_sku 按 sellerId 分组
// 返回 [{ sellerId, sellerSlug, sellerName, skuCount }]
export function getCollectBoxV2Sellers() {
  return request.get('/admin/api/collect-box-v2/sellers');
}

// 上架预览·SKU 全息画像(聚合 7 类缓存,返回 original + 合成 OPI item)
// storeId 可选,传入则按类目字典过滤属性
export function getSkuProfile(sku, storeId) {
  const params = storeId ? { storeId } : {};
  return request.get('/admin/api/preview/sku/' + encodeURIComponent(sku) + '/profile', params);
}

// 批量查询 SKU 缓存画像(精简版,仅 name/description/sources)
// skus: string[](最多 200),storeId 可选
// 返回 { items: [{ sku, name, description, sources }] }
// 用途:批量更新信息时一次性拉取所有商品的缓存标题/描述
export function getSkuProfileBatch(skus, storeId) {
  const body = { skus };
  if (storeId) body.storeId = storeId;
  return request.post('/admin/api/preview/sku/profile/batch', body);
}

// 上架预览·一键提交(走 /ozon/products/import,需 x-ozon-store-id header)
// items: 合成 OPI 输入 item 数组(从 profile 接口拿到 item 后可改 price)
// options.templateId / options.defaultStock: 任务创建时存快照,stock-sync 定时任务据此设库存
// options.applyWatermark / options.watermarkTemplateId: 水印加工链控制(显式传入优先于模板反查)
export function submitPreviewImport(items, storeId, options = {}) {
  const body = { items };
  if (options.templateId != null) body.templateId = options.templateId;
  if (options.defaultStock != null) body.defaultStock = options.defaultStock;
  if (options.applyWatermark != null) body.applyWatermark = options.applyWatermark;
  if (options.watermarkTemplateId != null) body.watermarkTemplateId = options.watermarkTemplateId;
  return request.request('/ozon/products/import', {
    method: 'POST',
    headers: { 'x-ozon-store-id': storeId },
    body,
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
