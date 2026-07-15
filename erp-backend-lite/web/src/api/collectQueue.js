import * as request from './request.js';

// 队列统计
export function getCollectQueueStats() {
  return request.get('/admin/api/collect-queue/stats');
}

// 任务列表
export function getCollectQueueList(params) {
  return request.get('/admin/api/collect-queue/list', params);
}

// 单任务详情
export function getCollectQueueTask(sku) {
  return request.get(`/admin/api/collect-queue/${encodeURIComponent(sku)}`);
}

// 手动重试
export function retryCollectQueueTask(sku) {
  return request.post(`/admin/api/collect-queue/${encodeURIComponent(sku)}/retry`);
}

// 删除任务
export function deleteCollectQueueTask(sku) {
  return request.del(`/admin/api/collect-queue/${encodeURIComponent(sku)}`);
}

// 批量重试(按 sku)
export function batchRetryCollectQueueTasks(skus) {
  return request.post('/admin/api/collect-queue/batch-retry', { skus });
}

// 批量重试所有失败终态任务(按状态)
export function batchRetryAllFailed() {
  return request.post('/admin/api/collect-queue/batch-retry', { status: 'failed_final' });
}

// 清空 pending
export function clearCollectQueue() {
  return request.post('/admin/api/collect-queue/clear');
}

// 暂停消费
export function pauseCollectQueueConsume() {
  return request.post('/admin/api/collect-queue/consume-pause');
}

// 恢复消费
export function resumeCollectQueueConsume() {
  return request.post('/admin/api/collect-queue/consume-resume');
}
