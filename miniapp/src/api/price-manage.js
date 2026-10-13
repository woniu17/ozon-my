// 价格管理 API(与 web 端 erp-backend-lite/web/src/api/price-manage.js 同构移植)
// 采购页利润预估与一键调价所需的最小接口集
import { request } from './request.js';

// 商品列表(价格管理页,keyword 支持 sku/offer_id/product_id/标题)
export function getPriceList(params) {
  return request('/admin/api/price-manage/list', { method: 'GET', body: params });
}

// 手动同步 Ozon 价格(v5 prices + v3 反查 sku)
export function syncPrices(storeId) {
  return request('/admin/api/price-manage/prices/sync', { method: 'POST', body: { storeId } });
}

// 批量 SKU 定价信息(利润预估 + 一键调价)
// skus: number[]/string[] → [{ sku, inCache, price, oldPrice, minPrice, storeId, hasProductId, weightG, customPurchasePrice }]
export function getSkusInfo(skus) {
  return request('/admin/api/price-manage/skus-info' + (skus.length ? '?skus=' + encodeURIComponent(skus.join(',')) : ''));
}

// 维护 SKU 成本基准(采购价/重量,写 product_data_cache 自定义列)
export function setSkuCustoms(sku, body) {
  return request(`/admin/api/price-manage/sku/${encodeURIComponent(sku)}`, { method: 'PUT', body });
}

// 单品改价(body: { sku, newPrice, targetRate? };限频/日志/30s 回读复用价格管理链路)
export function updatePrice(body) {
  return request('/admin/api/price-manage/price-update', { method: 'POST', body });
}
