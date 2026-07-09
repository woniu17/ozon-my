import * as request from './request.js';

// 批量上架任务列表(admin 语义端点,支持 storeId/status/keyword 筛选 + 分页)
export function getBatchTasks(params) {
  return request.get('/admin/api/batch-tasks', params);
}

// 批量任务详情(含每个商品明细)
export function getBatchTaskDetail(id) {
  return request.get('/ozon/products/batch-import/' + encodeURIComponent(id));
}
