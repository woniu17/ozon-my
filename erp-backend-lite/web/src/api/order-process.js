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

// Tab 聚合统计(当前 Tab+筛选全集不分页,分两组:已结算/已采购未结算)
// params 同 getOrderList(除不接 page/pageSize)
export function getOrderSummary(params) {
  return request.get('/admin/api/order-process/summary', params);
}

// 包裹详情(产品行+采购关联+轨迹)
export function getOrderDetail(packageId) {
  return request.get('/admin/api/order-process/detail/' + encodeURIComponent(packageId));
}

// 提交采购信息(模式B:金额+国内快递单号;提交即流转待打单发货)
export function submitPurchase(body) {
  return request.post('/admin/api/order-process/purchase', body);
}

// 查询采购单是否已存在 + 已关联包裹(拼单提交前提示)
export function lookupPurchase(platform, purchaseSn) {
  return request.get('/admin/api/order-process/purchase/lookup', { platform, purchaseSn });
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
// Ozon 应计项目(2026-09,已完成/已取消货件的财务应计)
// ════════════════════════════════════════════════════════════════

// 手动触发应计同步
// body:
//   {}                                     增量待拉(与定时同步同一清单)
//   { mode: 'backfill', sinceDays: 210 }  存量回补
//   { mode: 'packages', packageIds: [1] }  单包裹刷新(详情弹窗"刷新应计")
export function runAccrualSync(body = {}) {
  return request.post('/admin/api/order-process/accrual-sync', body);
}

// 单订单强制同步(列表行"同步"按钮)
// 流程:Ozon /v3/posting/fbs/get 拉最新订单状态 + 强拉应计项目(均无时间窗口限制)
// body: { packageId: number }
// 返回 { postingNumber, orderSynced, accrualRows, statusBefore, statusAfter }
export function syncPackage(packageId) {
  return request.post('/admin/api/order-process/sync-package', { packageId });
}

// 读取 RUB→CNY 汇率(null=未配置)
export function getRubRate() {
  return request.get('/admin/api/order-process/rub-rate');
}

// 更新 RUB→CNY 汇率
export function setRubRate(rate) {
  return request.post('/admin/api/order-process/rub-rate', { rate });
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

// 从妙手同步到本地订单(重量/备注/妙手口径采购金额/采购订单详情)
// body: { packageIds?: number[] }  不传 = 同步当前筛选全部(logistics_no 非空的)
export function syncMsToLocal(packageIds) {
  const body = Array.isArray(packageIds) && packageIds.length > 0 ? { packageIds } : {};
  return request.post('/admin/api/order-process/sync-ms-to-local', body);
}

// 补全采购订单商品信息(目前仅支持拼多多)
// body: { items: [{ purchaseSn, platform, goods: [{goodsName, spec, price, number, thumbUrl}] }] }
export function enrichPurchaseItems(items) {
  return request.post('/admin/api/order-process/enrich-purchase-items', { items });
}

// 待补全采购订单列表(items_json 为空的所有采购单,不限当前页)
// query: ?platform=yangkeduo(可选,按平台过滤)
export function listPendingPurchases(platform) {
  return request.get('/admin/api/order-process/pending-purchases', platform ? { platform } : {});
}

// ════════════════════════════════════════════════════════════════
// 平台订单获取(2026-09,后端 cloakbrowser 直取,替代 miaoshou-helper 扩展桥)
// 2026-09-13 多账号:后端按平台配置多买手账号 profile,列表接口带 account 指定,
// 搜索接口后端跨账号(前端无感知)
// ════════════════════════════════════════════════════════════════

// 平台订单列表
// platform: 'pdd' | 'ali1688' | 'taobao'
// params: { tab: 'all'|'unshipped'|'unreceived', size, account }
//   account: 账号别名(如 linqx/chenlin),不传=主账号;订单行带 account 来源标注
// 返回 { orders } 字段与插件 GET_ORDERS 一致(orderSn/amount/goods[].thumbUrl 等)
export function getPlatformOrders(platform, params) {
  return request.get('/admin/api/platform-orders/' + encodeURIComponent(platform), params);
}

// 按采购单号精确搜索(补全商品图/数量);未找到返回 { result: null }
export function searchPlatformOrder(platform, orderSn) {
  return request.get('/admin/api/platform-orders/' + encodeURIComponent(platform) + '/search', { orderSn });
}

// 浏览器运行态 + 各平台×账号登录态探测(替代原扩展 PING/PONG)
// 返回 { state, browsers: { <账号>: {state,pid,profileDir} },
//        platforms: { pdd/ali1688/taobao: { accounts: { <账号>: { login, cookieNames? } } } } }
export function getPlatformOrdersStatus() {
  return request.get('/admin/api/platform-orders/status');
}
