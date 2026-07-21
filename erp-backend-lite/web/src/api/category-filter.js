import * as request from './request.js';

// 列出全部过滤类目
// 返回 { items: [{ descriptionCategoryId, typeId, categoryName, typeName, createdAt }] }
export function getFilteredCategories() {
  return request.get('/admin/api/filtered-categories');
}

// 从已采集商品中提取可用类目列表(供管理页"从已采集商品中选"用)
// 返回 { items: [{ descriptionCategoryId, typeId, categoryName, typeName, skuCount }] }
export function getAvailableCategories() {
  return request.get('/admin/api/filtered-categories/available');
}

// 检查某类目是否在黑名单
// 返回 { filtered: boolean }
// 注:typeId 可省略/为 0(数据缺失时占位),后端按 descCatId+0 查询
export function checkFiltered(descriptionCategoryId, typeId) {
  const ti = Number(typeId) || 0;
  return request.get(
    `/admin/api/filtered-categories/check/${encodeURIComponent(descriptionCategoryId)}/${encodeURIComponent(ti)}`
  );
}

// 按 SKU 查询其类目是否在黑名单(供上架预览用,与采集箱同源)
// 返回 { filtered: boolean, descriptionCategoryId, typeId, categoryName }
// 注:用 SKU 查 ozon_cache_index 取类目 ID,避免 portalItem 的 OPI 合成路径
//     (优先 search_data level_3)与采集箱(bundle_data)数据源不一致导致过滤失效
export function checkFilteredBySku(sku) {
  return request.get(
    `/admin/api/filtered-categories/check-by-sku/${encodeURIComponent(sku)}`
  );
}

// 批量按 descriptionCategoryId / typeId 查询中文类目名 + 类型名
// 参数:{ descCatIds: [1,2,3], typeIds?: [1,2,3] }
// 返回 { items: [{ descriptionCategoryId, categoryName }], typeItems: [{ typeId, typeName }] }
// 注:OPI 失败时 categoryName/typeName 为空字符串,前端回退显示 ID
export function getCategoryNamesBatch(descCatIds, typeIds) {
  const body = { descCatIds };
  if (Array.isArray(typeIds) && typeIds.length > 0) body.typeIds = typeIds;
  return request.post('/admin/api/filtered-categories/category-names-batch', body);
}

// 添加过滤类目
// body: { descriptionCategoryId, typeId?, categoryName?, typeName? }
export function addFilteredCategory(body) {
  return request.post('/admin/api/filtered-categories', body);
}

// 移出过滤类目
// 注:typeId 可省略/为 0
export function deleteFilteredCategory(descriptionCategoryId, typeId) {
  const ti = Number(typeId) || 0;
  return request.del(
    `/admin/api/filtered-categories/${encodeURIComponent(descriptionCategoryId)}/${encodeURIComponent(ti)}`
  );
}
