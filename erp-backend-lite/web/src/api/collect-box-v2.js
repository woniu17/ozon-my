import * as request from './request.js';

// 全源采集列表
export function getCollectBoxV2(params) {
  return request.get('/admin/api/collect-box-v2', params);
}

// 全源采集详情
export function getCollectBoxV2Detail(id) {
  return request.get('/admin/api/collect-box-v2/' + encodeURIComponent(id));
}

// 删除全源采集记录
export function deleteCollectBoxV2(id) {
  return request.del('/admin/api/collect-box-v2/' + encodeURIComponent(id));
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
