// 数据查看 API(H5 只读)
// 对应 web 端 Cache.vue:SKU 数据全览 / 店铺数据 / 店铺 SKU 关联
import { get } from './request.js';

// SKU 数据全览(5 类缓存命中矩阵)
// params: { keyword, page, pageSize }
export function getCacheOverview(params) {
  return get('/admin/api/cache/overview', params);
}

// 店铺数据列表
// params: { keyword, currentPage, pageSize, isMainlandChina, sortBy, ... }
export function getStoreClassificationList(params) {
  return get('/admin/api/store-classification', params);
}

// 店铺 SKU 关联列表
// params: { keyword, currentPage, pageSize }
export function getStoreSkuList(params) {
  return get('/admin/api/store-sku', params);
}