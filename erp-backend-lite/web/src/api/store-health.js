// 店铺健康-错误指数(2026-11-03)
// 数据源:Ozon /v1/rating/index/fbs/info + /v1/rating/index/fbs/posting/list(后端落库)
import * as request from './request.js';

// 概览汇总
// params: { from, to, storeIds?: 'a,b,c' }
// 返回 { stores: [{ storeId, storeName, index, processingCostsSum, currencyCode,
//         periodFrom, periodTo, syncedAt, defects: [{date,indexByDate,processingCostsSumByDate}] }],
//         totals: { errorPostingCount, sellerCancellationCount, sellerDelayCount,
//                   graceCount, chargeSum, chargeCurrencyCode, schemaCounts },
//         sync: { running, lastResult } }
export function getRatingSummary(params) {
  return request.get('/admin/api/rating/health/summary', params);
}

// 影响错误指数的货件明细(分页)
// params: { from, to, storeIds?, offset?, limit? }
// 返回 { items: [...], total }
export function getRatingErrors(params) {
  return request.get('/admin/api/rating/health/errors', params);
}

// 手动触发同步
// body: { storeIds?: string[], from?, to? }
// 返回 { skipped?, stores, from, to, dailyRows, postingRows, errors, durationMs }
export function triggerRatingSync(body) {
  return request.post('/admin/api/rating/health/sync', body);
}

// 同步状态
export function getRatingSyncStatus() {
  return request.get('/admin/api/rating/health/sync-status');
}