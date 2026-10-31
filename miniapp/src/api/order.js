// 订单处理 API(与 web 端 erp-backend-lite/web/src/api/order-process.js 同构移植)
// 仅移植小程序一期(查看/采购/入库)所需接口;后端接口变更时两端同步维护
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

// 入库(前置 wait_ship + Ozon awaiting_packaging;已入库幂等返回 alreadyShipped)
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

// 未采购订单"最近采购参考"(2026-10-28):按包裹商品 SKU 匹配历史采购单,最多5条
export function getPurchaseHistory(packageId) {
  return request.get('/admin/api/order-process/purchase-history/' + encodeURIComponent(packageId));
}

// 订单商品跟卖快照(2026-10-27):按 sku + 下单时间查"下单后最近一次快照"
// body: [{ sku, after }];返回 { map: { sku: snapshot } }
export function getPriceWatchSnapshots(items) {
  return request.post('/admin/api/price-watch/order-snapshots', { items });
}

// 取消采购关联(冲回产品行金额)
export function unlinkPurchase(purchaseOrderId, packageId) {
  return request.post('/admin/api/order-process/unlink', { purchaseOrderId, packageId });
}

// ── 扫描打单(2026-10-13,自 web 端 order-process.js 移植)────────
// 提交发货重量(服务端权威状态校验,仅 wait_ship 落库)
export function scanShipSubmit(packageId, weightG) {
  return request.post('/admin/api/order-process/scan-ship/submit', { packageId, weightG });
}
// 更正重量(交运后人工修正发货重量)
export function correctShipWeight(packageId, weightG) {
  return request.post('/admin/api/order-process/scan-ship/correct-weight', { packageId, weightG });
}
// 发货记录(今日/昨日已交运包裹)
export function getScanShipRecords(params) {
  return request.get('/admin/api/order-process/scan-ship/records', params);
}
// 获取 Ozon 面单(返回 { url, expiresIn },url 为 10 分钟短时公开链接,可直接打开)
export function fetchPackageLabel(packageId) {
  return request.post('/admin/api/order-process/package-label', { packageIds: [packageId] });
}
// 标记已打印面单(流转交运)
export function markPrinted(packageId) {
  return request.post('/admin/api/order-process/print-label', { packageId });
}

// ── 发运管理(2026-10-31,自 web 端 order-process.js 移植)──
// 所有接口 body 需带 storeId(后端 requireCarriageStore 按 body.storeId 鉴权)。
// 响应 data 结构与 web 端一致,详见 erp-backend-lite/web/src/api/order-process.js。
export function getCarriageDeliveryMethods(storeId) {
  return request.post('/admin/api/order-process/carriage/delivery-methods', { storeId });
}
// 发运清单:按配送方式聚合,含可创建占位行(id=0)
// 返回 { cursor, has_next, methods: [{ delivery_method_id, delivery_method_name, departure_date,
//         carriages: [{ id, status, postings_count, quantum_count }] }] }
export function getCarriageList(storeId, params = {}) {
  return request.post('/admin/api/order-process/carriage/list', { storeId, ...params });
}
// 已完成发运历史(本地持久化;返回全店铺)
// 返回 { items: [{ id, store_id, store_name, status, delivery_method_name, departure_date,
//                 postings_count, archived_at, postings, contact, carriage, from_history }] }
export function getCarriageHistory(storeId) {
  return request.post('/admin/api/order-process/carriage/history/list', { storeId });
}
// 创建发运:该配送方式下所有"已准备发运"货件自动进入
// body: { deliveryMethodId?, departureDate?, allBlrTraceable? } → { carriage_id }
export function createCarriage(storeId, body = {}) {
  return request.post('/admin/api/order-process/carriage/create', { storeId, ...body });
}
// 发运详情 → { carriage_id, status, first_mile_type, integration_type, available_actions, ... }
export function getCarriage(storeId, carriageId) {
  return request.post('/admin/api/order-process/carriage/get', { storeId, carriageId });
}
// 发运货件列表 → { cursor, postings: [{ posting_number, assembly_code, can_print_label, products[] }] }
export function getCarriagePostings(storeId, carriageId, params = {}) {
  return request.post('/admin/api/order-process/carriage/posting-list', { storeId, carriageId, ...params });
}
// 确认发运 → { carriage_id }
export function approveCarriage(storeId, carriageId, containersCount) {
  return request.post('/admin/api/order-process/carriage/approve', { storeId, carriageId, containersCount });
}
// 覆盖发运货件(全量替换) → { carriage_id }
export function setCarriagePostings(storeId, carriageId, postingNumbers) {
  return request.post('/admin/api/order-process/carriage/set-postings', { storeId, carriageId, postingNumbers });
}
// 取消发运 → { carriage_status }
export function cancelCarriage(storeId, carriageId) {
  return request.post('/admin/api/order-process/carriage/cancel', { storeId, carriageId });
}
// 获取快递员联系方式 → { contact: [{ carriage_id, phone, wechat_nickname, comment, updated_at }] }
export function getCarriageCourierContact(storeId, carriageId) {
  return request.post('/admin/api/order-process/carriage/courier-contact/get', { storeId, carriageId });
}
// 设置快递员联系方式(仅 pickup + ozon_outsourced 适用;phone/comment 必填)
export function setCarriageCourierContact(storeId, carriageId, body = {}) {
  return request.post('/admin/api/order-process/carriage/courier-contact/set', { storeId, carriageId, ...body });
}
// 可加入发运的货件候选 → { postings: [...], count }
export function getAvailableCarriagePostings(storeId, carriageId, params = {}) {
  return request.post('/admin/api/order-process/carriage/available-postings', { storeId, carriageId, ...params });
}
// 快递员联系方式配置列表(全店铺通用) → { contacts: [{ id, phone, wechatNickname, comment, isDefault }] }
export function listCourierContactConfigs(storeId) {
  return request.post('/admin/api/order-process/carriage/courier-contact/config/list', { storeId });
}
// 保存快递员联系方式配置(全量覆盖) → { contacts }
export function saveCourierContactConfigs(storeId, contacts) {
  return request.post('/admin/api/order-process/carriage/courier-contact/config/save', { storeId, contacts });
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

// PDD 订单优惠明细(2026-09-28,采购页优惠勾选):列表单勾选后按需拉详情页逐项明细
export function getPddPromotions(orderSn, account) {
  const query = { orderSn };
  if (account) query.account = account;
  return request.get('/admin/api/platform-orders/pdd/promotions', query);
}

// 1688 订单优惠明细(2026-09-29,采购页优惠勾选):列表伪条目勾选后拉 buyerView 官方券/折扣明细
export function getAli1688Promotions(orderSn, account) {
  const query = { orderSn };
  if (account) query.account = account;
  return request.get('/admin/api/platform-orders/ali1688/promotions', query);
}

// 浏览器运行态 + 各平台×账号登录态探测(Step2 未登录警示)
export function getPlatformOrdersStatus() {
  return request.get('/admin/api/platform-orders/status');
}
