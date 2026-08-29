import * as request from './request.js';

// 订单处理(个人自发货模式):采购订单 ↔ Ozon FBS 订单关联

// Tab 计数
export function getOrderTabs() {
  return request.get('/admin/api/order-process/tabs');
}

// 包裹分页列表
// params: { tab, keyword, storeId, purchaseStatus, arrived, page, pageSize }
export function getOrderList(params) {
  return request.get('/admin/api/order-process/list', params);
}

// 包裹详情(产品行+采购关联+轨迹)
export function getOrderDetail(packageId) {
  return request.get('/admin/api/order-process/detail/' + encodeURIComponent(packageId));
}

// 提交采购信息(模式B:金额+国内快递单号;提交即流转待打单发货)
export function submitPurchase(body) {
  return request.post('/admin/api/order-process/purchase', body);
}

// 取消采购关联(冲回产品行金额)
export function unlinkPurchase(purchaseOrderId, packageId) {
  return request.post('/admin/api/order-process/unlink', { purchaseOrderId, packageId });
}

// 搁置/恢复包裹
export function ignorePackage(packageId, ignored) {
  return request.post('/admin/api/order-process/ignore', { packageId, ignored });
}

// 标记已打印面单(流转交运)
export function markPrinted(packageId) {
  return request.post('/admin/api/order-process/print-label', { packageId });
}

// 手动触发 Ozon 订单同步(异步,立即返回)
export function runSync() {
  return request.post('/admin/api/order-process/sync-run');
}

// 各店铺最近同步状态
export function getSyncStatus() {
  return request.get('/admin/api/order-process/sync-status');
}
