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

// 获取 Ozon 面单 PDF(返回 Blob);单包裹调用,packageIds 长度为 1;refresh=true 忽略缓存
// 后端缓存优先,未命中调 Ozon /v2/posting/fbs/package-label
export function fetchPackageLabel(packageIds, refresh = false) {
  return request.postBlob('/admin/api/order-process/package-label', { packageIds, refresh });
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

// ════════════════════════════════════════════════════════════════
// 妙手 ERP 订单数据(2026-09,独立新表)
// 数据来源:miaoshou-helper 插件从妙手历史订单页提取
// ════════════════════════════════════════════════════════════════

// 从妙手同步(插件提取后 POST 到此接口,批量 upsert 到 miaoshou_* 表)
export function syncFromMiaoshou(orders) {
  return request.post('/admin/api/order-process/sync-from-miaoshou', { orders });
}

// 妙手订单列表(分页,关联本地 op_package)
// params: { page, pageSize, shopNick, keyword, operateStatus, localLinked }
export function getMiaoshouList(params) {
  return request.get('/admin/api/order-process/miaoshou-list', params);
}

// 妙手订单状态 tab 计数(按 operate_status 分组,附本地关联数)
export function getMiaoshouTabs() {
  return request.get('/admin/api/order-process/miaoshou-tabs');
}

// 妙手订单详情(含采购单列表)
export function getMiaoshouDetail(id) {
  return request.get('/admin/api/order-process/miaoshou-detail/' + encodeURIComponent(id));
}
