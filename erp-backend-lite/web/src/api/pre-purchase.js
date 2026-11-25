// 预采购 API(2026-11-16):提前采购、暂不绑定 Ozon 订单;到货后扫描快递单号签收。
import * as request from './request.js';

/** 预采购列表 tab=all|pending|received */
export function listPrePurchases(params) {
  return request.get('/admin/api/pre-purchase/list', params);
}

/** 新增预采购(仅选平台订单) */
export function createPrePurchase(body) {
  return request.post('/admin/api/pre-purchase/create', body);
}

/** 修改预采购(快递单号/备注等) */
export function updatePrePurchase(id, body) {
  return request.put('/admin/api/pre-purchase/update/' + encodeURIComponent(id), body);
}

/** 删除预采购 */
export function deletePrePurchase(id) {
  return request.del('/admin/api/pre-purchase/delete/' + encodeURIComponent(id));
}

/** 签收(ids 或 logisticsNo) */
export function receivePrePurchase(body) {
  return request.post('/admin/api/pre-purchase/receive', body);
}

/** 扫描签收用:按快递单号查 pending 预采购(不签收) */
export function receiveByCode(logisticsNo) {
  return request.post('/admin/api/pre-purchase/receive-by-code', { logisticsNo });
}

/** 批量检查平台订单是否已关联 Ozon 包裹 items=[{platform,purchaseSn}] */
export function checkLinked(items) {
  return request.post('/admin/api/pre-purchase/check-linked', { items });
}

/** 手动触发物流轨迹同步 */
export function syncTrace() {
  return request.post('/admin/api/pre-purchase/sync-trace', {});
}

/** 单行更新物流(列表"更新物流"按钮) */
export function syncTraceRow(id) {
  return request.post('/admin/api/pre-purchase/sync-trace-row/' + encodeURIComponent(id), {});
}

/** 物流轨迹同步状态 */
export function syncTraceStatus() {
  return request.get('/admin/api/pre-purchase/sync-trace-status');
}
