import * as request from './request.js';

// 店铺列表(含凭据)
export function getStores() {
  return request.get('/admin/api/stores');
}

// 单个店铺(RESTful 约定)
export function getStore(id) {
  return request.get('/admin/api/stores/' + encodeURIComponent(id));
}

// 新增店铺
export function createStore(body) {
  return request.post('/admin/api/stores', body);
}

// 更新店铺(整体替换)
export function updateStore(id, body) {
  return request.put('/admin/api/stores/' + encodeURIComponent(id), body);
}

// 删除店铺
export function deleteStore(id) {
  return request.del('/admin/api/stores/' + encodeURIComponent(id));
}

// 用请求体凭据测试连通性(新增店铺时即时验证)
export function testConnection(body) {
  return request.post('/admin/api/test-connection', body);
}

// 测试已保存店铺的 OPI 凭据
export function testConnectionForStore(id) {
  return request.post('/admin/api/stores/' + encodeURIComponent(id) + '/test-connection');
}

// 实时拉取店铺的真实仓库列表
export function getStoreWarehouses(id) {
  return request.get('/admin/api/stores/' + encodeURIComponent(id) + '/warehouses');
}
