import * as request from './request.js';

// 首页统计(今日上架/采集待发布/商品数/店铺数/近7天趋势)
export function getDashboard() {
  return request.get('/admin/api/dashboard-stats');
}
