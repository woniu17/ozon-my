// 订单统计(2026-09,跨店铺跨时间窗口的订单量级与金额概览)
import * as request from './request.js';

// 概览:按事件发生时间计数(不去重),返回各店铺的新订单/揽收/签收/退货 单数与金额
// params: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', storeIds?: 'a,b,c', tz?: 'Asia/Shanghai'|'Europe/Moscow' }
// tz 为统计时区(日界按该时区 00:00 划分),默认 Asia/Shanghai
// 返回 { from, to, tz, storeIds, totals, byStore }
export function getOrderStatsSummary(params) {
  return request.get('/admin/api/order-stats/summary', params);
}

// 可见店铺列表(供筛选下拉用)
// 返回 { stores: [{ id, name, companyId }] }
export function getOrderStatsStores() {
  return request.get('/admin/api/order-stats/stores');
}
