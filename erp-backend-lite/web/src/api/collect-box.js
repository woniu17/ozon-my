import * as request from './request.js';

// 采集箱列表(支持 storeId/published/keyword 筛选 + 分页)
export function getCollectBox(params) {
  return request.get('/admin/api/collect-box', params);
}

// 删除单条采集箱条目
export function deleteCollectBox(id) {
  return request.del('/admin/api/collect-box/' + encodeURIComponent(id));
}
