// 统计 API(2026-10-13,自 web 端 order-stats.js / finance-stats.js 移植精简版)
import { request } from './request.js';

// 订单统计概览:新订单/揽收/签收/退货 的单数与金额(按事件发生时间,不去重)
// params: { from:'YYYY-MM-DD', to:'YYYY-MM-DD'(排他), storeIds?, tz?:'Asia/Shanghai'|'Europe/Moscow' }
// 返回 { from, to, tz, storeIds, totals: { new:{count,amount,validAmount}, pickup:{...}, delivered:{...}, returned:{...} }, byStore:[...] }
export function getOrderStatsSummary(params) {
  return request('/admin/api/order-stats/summary', { method: 'GET', body: params });
}

// 财务统计汇总:已成功(结算)/已采购未结算(在途)/非订单应计 三组
// params: { from?, to?, storeIds?, tz? }  from/to 都不传=全部时间
// 返回 { allTime, settled:{ orderCount, totalProfit, ... }, pending:{ orderCount, totalProfit, estimated, ... },
//         nonOrder:{ totalCny }, rubRate }
export function getFinanceSummary(params) {
  return request('/admin/api/finance-stats/summary', { method: 'GET', body: params });
}

// 财务订单列表(分页)
// params: { group:'settled'|'pending', from?, to?, storeIds?, tz?, page?, pageSize?, keyword?, category?, typeId? }
// 返回 { group, total, page, pageSize, orders, rubRate }
export function getFinanceOrders(params) {
  return request('/admin/api/finance-stats/orders', { method: 'GET', body: params });
}

// 非订单应计明细(package_id IS NULL,分页)
// params: { from?, to?, storeIds?, page?, pageSize? }
// 返回 { total, page, pageSize, items, rubRate }
export function getNonOrderAccruals(params) {
  return request('/admin/api/finance-stats/non-order-accruals', { method: 'GET', body: params });
}

// 有订单的自然月列表(YYYY-MM 降序;tz 影响月界换算)
// params: { tz?: 'Asia/Shanghai'|'Europe/Moscow' }
// 返回 { months: ['2026-09', '2026-08', ...] }
export function getOrderMonths(params) {
  return request('/admin/api/finance-stats/order-months', { method: 'GET', body: params });
}

// 可见店铺列表(财务统计店铺筛选,与订单统计同源)
export function getFinanceStores() {
  return request('/admin/api/order-stats/stores', { method: 'GET' });
}