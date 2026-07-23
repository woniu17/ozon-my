import * as request from './request.js';

// 批量均衡上架 API 封装
// 后端路由前缀:/admin/api/batch-upload
// 注:request.js 已自动解包 envelope,这些函数的返回值即 envelope.data

// 预览分配(不落库)
// data: { skus, storeIds, config?, speedConfig? }
// 返回:{ assignments:[{sku,sellerId,targetStoreId,seq}], summary, skipped, config, speedConfig }
export function previewBatchUpload(data) {
  return request.post('/admin/api/batch-upload/preview', data);
}

// 创建批次(立即执行)
// data: { skus, storeIds, name?, config?, speedConfig?, assignments? }
// 返回:批次对象(rowToBatch)
export function createBatchUpload(data) {
  return request.post('/admin/api/batch-upload', data);
}

// 批次列表(分页)
// params: { currentPage, pageSize, status?, keyword? }
// 返回:{ items, total, currentPage, pageSize }
export function getBatchUploadList(params) {
  return request.get('/admin/api/batch-upload', params);
}

// 批次详情(含子任务列表)
// 返回:批次对象 + items:[...]
export function getBatchUploadDetail(batchNo) {
  return request.get('/admin/api/batch-upload/' + encodeURIComponent(batchNo));
}

// 暂停批次(status=RUNNING → PAUSED)
// 返回:{ status:'PAUSED' }
export function pauseBatchUpload(batchNo) {
  return request.post('/admin/api/batch-upload/' + encodeURIComponent(batchNo) + '/pause');
}

// 继续批次(status=PAUSED → RUNNING)
// 返回:{ status:'RUNNING' }
export function resumeBatchUpload(batchNo) {
  return request.post('/admin/api/batch-upload/' + encodeURIComponent(batchNo) + '/resume');
}

// 取消批次(软取消:PENDING→SKIPPED)
// 返回:{ cancelledPending, runningCount }
export function cancelBatchUpload(batchNo) {
  return request.post('/admin/api/batch-upload/' + encodeURIComponent(batchNo) + '/cancel');
}

// 手动调整子任务目标店铺(仅 status=PENDING 时可调整)
// 返回:{ id, targetStoreId }
export function reassignBatchItem(batchNo, itemId, targetStoreId) {
  return request.post(
    '/admin/api/batch-upload/' + encodeURIComponent(batchNo) + '/items/' + encodeURIComponent(itemId) + '/reassign',
    { targetStoreId }
  );
}
