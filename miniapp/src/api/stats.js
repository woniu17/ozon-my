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
// params: { group:'settled'|'pending', from?, to?, storeIds?, tz?, page?, pageSize?, keyword? }
// 返回 { group, total, page, pageSize, orders, rubRate }
export function getFinanceOrders(params) {
  return request('/admin/api/finance-stats/orders', { method: 'GET', body: params });
}