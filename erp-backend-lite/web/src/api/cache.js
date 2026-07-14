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

// 全览列表(聚合 6 类缓存的 SKU 状态矩阵)
export function getCacheOverview(params) {
  return request.get('/admin/api/cache/overview', params);
}

// OPI 预览(从 MongoDB 缓存合成 OPI v3)
export function getOpiPreview(sku, storeId) {
  const qs = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
  return request.get(`/admin/api/cache/opi-preview/${encodeURIComponent(sku)}${qs}`);
}

// ── 自动采集 ───────────────────────────────────────────────
// 自动采集统计
export function getAutoCollectStats() {
  return request.get('/admin/api/auto-collect/stats');
}

// 自动采集日志列表
export function getAutoCollectLogs(params) {
  return request.get('/admin/api/auto-collect/logs', params);
}

// 单 SKU 采集历史
export function getAutoCollectLogsBySku(sku) {
  return request.get(`/admin/api/auto-collect/logs/${encodeURIComponent(sku)}`);
}

// ── 缓存查询(调试用) ─────────────────────────────────────
export function getMarketStatsCache(sku) {
  return request.get(`/ozon/cache/marketStats/${encodeURIComponent(sku)}`);
}

export function getFollowSellCache(sku) {
  return request.get(`/ozon/cache/followSell/${encodeURIComponent(sku)}`);
}

// ── 店铺分类 ───────────────────────────────────────────────
export function getStoreClassificationList(params) {
  return request.get('/admin/api/store-classification', params);
}

export function getStoreClassification(slug) {
  return request.get(`/admin/api/store-classification/${encodeURIComponent(slug)}`);
}

export function updateStoreClassification(slug, data) {
  return request.post(`/admin/api/store-classification/${encodeURIComponent(slug)}`, data);
}

export function deleteStoreClassification(slug) {
  return request.del(`/admin/api/store-classification/${encodeURIComponent(slug)}`);
}
