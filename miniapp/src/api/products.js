// 商品/采集箱 API(H5 只读)
// 对应 web 端 Products.vue + CollectBoxV2.vue 的只读查询
import { get } from './request.js';

// 商品数据缓存列表(OPI 商品,支持 keyword + 分页)
// params: { keyword, storeId, currentPage, pageSize, productStatus, ... }
export function getProducts(params) {
  return get('/admin/api/products', params);
}

// 采集箱·缓存视图(以 cardCache 为基准聚合 7 类缓存命中状态)
// params: { keyword, currentPage, pageSize, ... }
export function getCollectBoxList(params) {
  return get('/admin/api/collect-box-v2/from-cache', params);
}

// 采集源卖家列表(供筛选;H5 暂不强制使用)
export function getCollectBoxSellers() {
  return get('/admin/api/collect-box-v2/sellers');
}