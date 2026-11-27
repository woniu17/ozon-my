// 货源管理 API(2026-11-27)
import * as request from './request.js';

/** 货源列表 */
export function listSupplierProducts(params) {
  return request.get('/admin/api/supplier-products/list', params);
}

/** 待确认候选(SKU 分组) */
export function listSupplierCandidates(params) {
  return request.get('/admin/api/supplier-products/candidates', params);
}

/** 单 SKU 货源 + 候选 */
export function getSupplierBySku(sku) {
  return request.get('/admin/api/supplier-products/by-sku/' + encodeURIComponent(sku));
}

/** 新增货源(可传 1688 链接/ID) */
export function createSupplierProduct(body) {
  return request.post('/admin/api/supplier-products/create', body);
}

/** 编辑货源 */
export function updateSupplierProduct(id, body) {
  return request.put('/admin/api/supplier-products/update/' + encodeURIComponent(id), body);
}

/** 删除货源 */
export function deleteSupplierProduct(id) {
  return request.del('/admin/api/supplier-products/delete/' + encodeURIComponent(id));
}

/** 设为常用 */
export function setSupplierPrimary(id) {
  return request.post('/admin/api/supplier-products/set-primary/' + encodeURIComponent(id), {});
}

/** 批量确认候选 */
export function confirmSupplierCandidates(items) {
  return request.post('/admin/api/supplier-products/confirm', { items });
}

/** 历史采购回填(仅无歧义单) */
export function backfillSupplierProducts() {
  return request.post('/admin/api/supplier-products/backfill', {});
}

/** 补齐缺失货源商品ID(后台任务) */
export function syncMissingGoods(platforms) {
  return request.post('/admin/api/supplier-products/sync-missing-goods', platforms ? { platforms } : {});
}

/** 补齐任务进度 */
export function getMissingGoodsSyncStatus() {
  return request.get('/admin/api/supplier-products/sync-missing-goods-status');
}
