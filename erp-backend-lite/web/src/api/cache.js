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

// 按类型查缓存原始数据(GET /ozon/cache/{type}/:sku)
// type: 'dom' | 'attribute' | 'richMedia' | 'marketStats' | 'followSell'
// 返回结构因 type 而异:
//   dom: { card, detail, cardFetchedAt, detailFetchedAt }
//   attribute: { searchData, bundleData, searchFetchedAt, bundleFetchedAt, bundleId, attrsEmptyVerifiedAt, stale }
//   richMedia: { data, fetchedAt }
//   marketStats: { data, fetchedAt, l2Synced, stale }
//   followSell: { data, fetchedAt, l2Synced, stale }
export function getCacheByType(type, sku) {
  return request.get(`/ozon/cache/${type}/${encodeURIComponent(sku)}`);
}

// 按 SKU 查跟卖记录(GET /admin/api/cache/listed/:sku)
// 返回 { items: [{ localTaskId, offerId, name, price, productId, status, errors,
//                  stockSet, stockAttempts, itemCreatedAt, itemUpdatedAt,
//                  storeId, taskStatus, taskCreatedAt, taskCompletedAt }] }
export function getListedRecords(sku) {
  return request.get(`/admin/api/cache/listed/${encodeURIComponent(sku)}`);
}

// 删除单条
export function deleteCache(type, sku) {
  return request.del(`/admin/api/cache/${type}/${encodeURIComponent(sku)}`);
}

// 清空整个集合
export function clearCache(type) {
  return request.del(`/admin/api/cache/${type}`);
}

// 删除单个 SKU 的全部缓存(5 类数据表 + 索引行)
// 用于"SKU 数据管理"页单个删除
export function deleteSkuAll(sku) {
  return request.del(`/admin/api/cache/sku/${encodeURIComponent(sku)}`);
}

// 批量删除 SKU 的全部缓存
// params: { skus?: string[], filter?: { keyword?: string } }
//   - skus 非空:按显式 SKU 数组删除(选中删除)
//   - skus 为空且 filter 提供:按筛选条件删除(当前条件筛选删除)
// 返回: { deletedCount, failed, total }
export function batchDeleteSkus(params) {
  return request.post('/admin/api/cache/skus/delete', params);
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

// ── 自动采集(深度采集) ───────────────────────────────────
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

// ── 浅度采集 ───────────────────────────────────────────────
// 浅度采集统计
export function getShallowCollectStats() {
  return request.get('/admin/api/shallow-collect/stats');
}

// 浅度采集日志列表
export function getShallowCollectLogs(params) {
  return request.get('/admin/api/shallow-collect/logs', params);
}

// 单 SKU 浅度采集历史
export function getShallowCollectLogsBySku(sku) {
  return request.get(`/admin/api/shallow-collect/logs/${encodeURIComponent(sku)}`);
}

// ── 缓存查询(调试用) ─────────────────────────────────────
export function getMarketStatsCache(sku) {
  return request.get(`/ozon/cache/marketStats/${encodeURIComponent(sku)}`);
}

export function getFollowSellCache(sku) {
  return request.get(`/ozon/cache/followSell/${encodeURIComponent(sku)}`);
}

// ── 店铺分类 ───────────────────────────────────────────────
// 2026-07:主键改为 sellerId(稳定),_id = sellerId;sellerSlug 作为普通字段 + 索引(反查用)
// path 参数语义:标识符(优先按 sellerId 查,后端 fallback 到 slug 反查)
export function getStoreClassificationList(params) {
  return request.get('/admin/api/store-classification', params);
}

export function getStoreClassification(sellerId) {
  return request.get(`/admin/api/store-classification/${encodeURIComponent(sellerId)}`);
}

export function updateStoreClassification(sellerId, data) {
  return request.post(`/admin/api/store-classification/${encodeURIComponent(sellerId)}`, data);
}

export function deleteStoreClassification(sellerId) {
  return request.del(`/admin/api/store-classification/${encodeURIComponent(sellerId)}`);
}

// ── 店铺 SKU 关联 ─────────────────────────────────────────
export function getStoreSkuList(params) {
  return request.get('/admin/api/store-sku', params);
}

export function getStoreSku(sku) {
  return request.get(`/admin/api/store-sku/${encodeURIComponent(sku)}`);
}

export function deleteStoreSku(sku) {
  return request.del(`/admin/api/store-sku/${encodeURIComponent(sku)}`);
}
