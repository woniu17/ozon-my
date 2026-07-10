import * as request from './request.js';

// 全源采集列表
export function getCollectBoxV2(params) {
  return request.get('/admin/api/collect-box-v2', params);
}

// 全源采集详情
export function getCollectBoxV2Detail(id) {
  return request.get('/admin/api/collect-box-v2/' + encodeURIComponent(id));
}

// 删除全源采集记录
export function deleteCollectBoxV2(id) {
  return request.del('/admin/api/collect-box-v2/' + encodeURIComponent(id));
}
