import * as request from './request.js';

// 订单处理(个人自发货模式):采购订单 ↔ Ozon FBS 订单关联

// Tab 计数
export function getOrderTabs() {
  return request.get('/admin/api/order-process/tabs');
}

// 包裹分页列表
// params: { tab, keyword, storeId, purchaseStatus, arrived, cancelInitiator, page, pageSize,
//           globalKeyword, globalMode }  globalMode: 'ss'模糊 | 'eq'精确
// cancelInitiator: 'client' | 'ozon' | 'seller'(仅 cancelled tab 用,按取消发起者筛选)
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

// 退回待处理(取消全部采购关联,回流未采购)
export function revertPackage(packageId) {
  return request.post('/admin/api/order-process/revert', { packageId });
}

// 搁置/恢复包裹
export function ignorePackage(packageId, ignored) {
  return request.post('/admin/api/order-process/ignore', { packageId, ignored });
}

// 标记已打印面单(流转交运)
export function markPrinted(packageId) {
  return request.post('/admin/api/order-process/print-label', { packageId });
}

// 手动触发 Ozon 订单增量同步(双接口:unfulfilled + list;异步立即返回)
export function runSync() {
  return request.post('/admin/api/order-process/sync-run');
}

// 手动触发全量同步(仅 /v4/posting/fbs/list;覆盖所有状态含 delivered/cancelled)
// opts:
//   { sinceDays: 1|7|30|90 }            快捷天数
//   { since: ISO, to: ISO }             自定义起止时间(优先级高于 sinceDays)
export function runSyncAllList(opts = {}) {
  return request.post('/admin/api/order-process/sync-all-list', opts);
}

// 各店铺最近同步状态(轻量:布尔 + cursors)
export function getSyncStatus() {
  return request.get('/admin/api/order-process/sync-status');
}

// 实时同步进度(详细:店铺数/当前店/页/已拉订单数/耗时)
export function getSyncProgress() {
  return request.get('/admin/api/order-process/sync-progress');
}

// 关闭已完成进度(用户点关闭按钮触发;同步进行中调用返回 cleared=false)
export function dismissSyncProgress() {
  return request.post('/admin/api/order-process/sync-progress/dismiss');
}
