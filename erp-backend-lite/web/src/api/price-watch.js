import * as request from './request.js';

// 价格优势监控
// 任务/上报由 qxqx 脚本调用,前端仅消费看板数据

// 看板汇总统计(优势分布 + 价格新鲜度 + 店铺同步时间)
export function getPriceWatchStats() {
  return request.get('/admin/api/price-watch/stats');
}

// 每 SKU 最新快照列表
// params: { currentPage, pageSize, storeId, position, keyword, gapPctMin, gapPctMax }
export function getPriceWatchList(params) {
  return request.get('/admin/api/price-watch/list', params);
}

// 单 SKU 快照历史 + 最新跟卖明细
export function getPriceWatchDetail(sku, days) {
  return request.get('/admin/api/price-watch/detail/' + encodeURIComponent(sku), { days });
}
