// 价格管理(2026-09):商品维度定价基准,docs/价格管理-概要设计.md
import { request } from './request.js';

// 手动同步 Ozon 价格(v5 prices + v3 反查 sku)
export function syncPrices(storeId) {
  return request('/admin/api/price-manage/prices/sync', { method: 'POST', body: { storeId } });
}

// 缓存内店铺分布(页面店铺 tab)
export function getPriceStores() {
  return request('/admin/api/price-manage/stores');
}

// 商品列表(筛选/排序/分页)
export function getPriceList(params) {
  return request('/admin/api/price-manage/list' + buildQueryStr(params));
}

// 顶部统计条
export function getPriceSummary() {
  return request('/admin/api/price-manage/summary');
}

// 维护采购价/重量
export function setSkuCustoms(sku, body) {
  return request(`/admin/api/price-manage/sku/${encodeURIComponent(sku)}`, { method: 'PUT', body });
}

// SKU 历史订单(展开行)
export function getSkuOrders(sku, limit = 20) {
  return request(`/admin/api/price-manage/sku/${encodeURIComponent(sku)}/orders?limit=${limit}`);
}

// 单品改价(body: { sku, newPrice, targetRate? })
export function updatePrice(body) {
  return request('/admin/api/price-manage/price-update', { method: 'POST', body });
}

// 批量 SKU 定价信息(订单处理页采购弹窗:利润预估 + 一键调价)
// skus: number[]/string[] → [{ sku, inCache, price, oldPrice, minPrice, storeId, hasProductId, weightG, customPurchasePrice }]
export function getSkusInfo(skus) {
  return request('/admin/api/price-manage/skus-info' + buildQueryStr({ skus: skus.join(',') }));
}

// query string(跳过空值,与 request.js buildQuery 同规则)
function buildQueryStr(params) {
  if (!params || typeof params !== 'object') return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, v);
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}
