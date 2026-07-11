import * as request from './request.js';

// 缓存统计
export function getCacheStats() {
  return request.get('/admin/api/cache/stats');
}

// 缓存列表
export function getCacheList(params) {
  return request.get('/admin/api/cache/list', params);
}

// 缓存详情
export function getCacheDetail(type, sku) {
  return request.get(`/admin/api/cache/${type}/${encodeURIComponent(sku)}`);
}

// 删除单条
export function deleteCache(type, sku) {
  return request.del(`/admin/api/cache/${type}/${encodeURIComponent(sku)}`);
}

// 清空整个集合
export function clearCache(type) {
  return request.del(`/admin/api/cache/${type}`);
}
