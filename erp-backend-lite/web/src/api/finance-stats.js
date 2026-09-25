// 财务统计(2026-09-25,订单维度:采购成本/应计项目/利润)
import * as request from './request.js';

// 三组聚合:已成功订单 / 已采购未结算(按下单时间过滤)+ 非订单应计项目(按应计日期过滤)
// params: { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD', storeIds?: 'a,b,c', tz?: 'Asia/Shanghai'|'Europe/Moscow' }
// from/to 都不传 = 全部时间;to 为排他日界(含 from 当日,不含 to 当日)
// 返回 { allTime, settled, pending, nonOrder, rubRate }
export function getFinanceSummary(params) {
  return request.get('/admin/api/finance-stats/summary', params);
}

// 订单详情列表(分页)
// params: { group: 'settled'|'pending', from?, to?, storeIds?, tz?, page?, pageSize?, keyword?,
//           category?, typeId? }
// 秒取消订单与质检单(02131/024785)已移出统计范围,列表与汇总口径一致
// 返回 { group, total, page, pageSize, orders(含 items 产品行), rubRate }
export function getFinanceOrders(params) {
  return request.get('/admin/api/finance-stats/orders', params);
}

// 非订单应计明细(package_id IS NULL,分页)
// params: { from?, to?, storeIds?, page?, pageSize? }
// 返回 { total, page, pageSize, items, rubRate }
export function getNonOrderAccruals(params) {
  return request.get('/admin/api/finance-stats/non-order-accruals', params);
}

// 有订单的自然月列表(YYYY-MM 降序;tz 影响月界换算)
// params: { tz?: 'Asia/Shanghai'|'Europe/Moscow' }
// 返回 { months: ['2026-09', '2026-08', ...] }
export function getOrderMonths(params) {
  return request.get('/admin/api/finance-stats/order-months', params);
}

// 可见店铺列表(筛选下拉,与订单统计页同源)
export function getFinanceStores() {
  return request.get('/admin/api/order-stats/stores');
}
