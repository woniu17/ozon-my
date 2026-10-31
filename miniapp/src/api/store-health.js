// 店铺健康-错误指数 API(2026-11-03,自 web 端 store-health.js 移植精简版)
import { get, post } from './request.js';

// 概览汇总
// params: { from, to, storeIds?: 'a,b,c' }
// 返回 { stores:[...], totals:{...}, sync:{running,lastResult} }
export function getRatingSummary(params) {
  return get('/admin/api/rating/health/summary', params);
}

// 影响错误指数的货件明细(分页)
// params: { from, to, storeIds?, offset?, limit? }
// 返回 { items:[...], total }
export function getRatingErrors(params) {
  return get('/admin/api/rating/health/errors', params);
}

// 手动触发同步
// body: { storeIds?: string[], from?, to? }
export function triggerRatingSync(body) {
  return post('/admin/api/rating/health/sync', body);
}

// 同步状态
export function getRatingSyncStatus() {
  return get('/admin/api/rating/health/sync-status');
}

// 可见店铺列表(与订单统计同源)
export function getStores() {
  return get('/admin/api/order-stats/stores');
}