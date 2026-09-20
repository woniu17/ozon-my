// 订单处理 API(与 web 端 erp-backend-lite/web/src/api/order-process.js 同构移植)
// 仅移植小程序一期(查看/采购/备货)所需接口;后端接口变更时两端同步维护
import * as request from './request.js';

// ── 订单(包裹)────────────────────────────────────────────
// Tab 计数(键为 camelCase:all/waitProcess/.../ignored)
export function getOrderTabs() {
  return request.get('/admin/api/order-process/tabs');
}

// 包裹分页列表
// params: { tab, keyword, purchaseStatus, arrived, cancelInitiator, page, pageSize,
//           globalKeyword, globalMode }  globalMode: 'ss'模糊 | 'eq'精确
// 返回 { packages, total, rubRate }
export function getOrderList(params) {
  return request.get('/admin/api/order-process/list', params);
}

// 包裹详情(产品行+采购关联+轨迹)
export function getOrderDetail(packageId) {
  return request.get('/admin/api/order-process/detail/' + encodeURIComponent(packageId));
}

// 单包裹强制同步订单 + 应计(详情页"同步订单"按钮)
export function syncPackage(packageId) {
  return request.post('/admin/api/order-process/sync-package', { packageId });
}

// 备货(前置 wait_ship + Ozon awaiting_packaging;已备货幂等返回 alreadyShipped)
export function shipPackage(packageId) {
  return request.post('/admin/api/order-process/ship', { packageId });
}

// 单包裹同步采购物流(强制刷新,不受1小时窗口限制;有 purchaseLinks 的行显示)
export function syncPackagePurchaseLogistics(packageId) {
  return request.post('/admin/api/order-process/sync-package-purchase-logistics', { packageId });
}

// ── 采购(语义与 web 端 5893fbf 对齐)──────────────────────
// 提交采购(auto=平台金额按数量加权分摊;提交即流转待打单发货)
export function submitPurchase(body) {
  return request.post('/admin/api/order-process/purchase', body);
}

// 修改已有采购的分摊金额(不新增采购单,只更新已有 link 分摊)
// body: { packageId, items: [{ itemId, amount }] }
export function updatePurchaseAlloc(body) {
  return request.post('/admin/api/order-process/purchase-alloc', body);
}

// 手动录入/修改采购单国内物流单号(闲鱼等无物流接口平台)
// body: { purchaseOrderId, logisticsNo, logisticsCompany? };状态联动 wait_send→shipped
export function updatePurchaseLogistics(body) {
  return request.post('/admin/api/order-process/purchase-logistics', body);
}

// 清空采购信息(冲回全部关联;不回退状态)
export function clearPurchaseInfo(packageId) {
  return request.post('/admin/api/order-process/purchase/clear', { packageId });
}

// 查询采购单是否已存在 + 已关联包裹(拼单提交前提示)
export function lookupPurchase(platform, purchaseSn) {
  return request.get('/admin/api/order-process/purchase/lookup', { platform, purchaseSn });
}

// 取消采购关联(冲回产品行金额)
export function unlinkPurchase(purchaseOrderId, packageId) {
  return request.post('/admin/api/order-process/unlink', { purchaseOrderId, packageId });
}

// ── 平台订单获取(cloakbrowser 直取)───────────────────────
// platform: 'pdd' | 'ali1688' | 'taobao'
// params: { tab: 'all'|'unshipped'|'unreceived', size, account }
export function getPlatformOrders(platform, params) {
  return request.get('/admin/api/platform-orders/' + encodeURIComponent(platform), params);
}

// 按采购单号精确搜索(account 可选,不传=跨账号)
export function searchPlatformOrder(platform, orderSn, account) {
  const query = { orderSn };
  if (account) query.account = account;
  return request.get('/admin/api/platform-orders/' + encodeURIComponent(platform) + '/search', query);
}

// 浏览器运行态 + 各平台×账号登录态探测(Step2 未登录警示)
export function getPlatformOrdersStatus() {
  return request.get('/admin/api/platform-orders/status');
}
