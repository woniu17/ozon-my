import * as request from './request.js';

// 全源采集列表(合并 collect_box_v2 + collect_box,用 sourceTable 区分)
export function getCollectBoxV2(params) {
  return request.get('/admin/api/collect-box-v2', params);
}

// 全源采集详情(sourceTable=collect_box 走老表分流)
export function getCollectBoxV2Detail(id, sourceTable) {
  const params = sourceTable ? { sourceTable } : undefined;
  return request.get('/admin/api/collect-box-v2/' + encodeURIComponent(id), params);
}

// 删除全源采集记录(sourceTable=collect_box 删老表)
export function deleteCollectBoxV2(id, sourceTable) {
  let path = '/admin/api/collect-box-v2/' + encodeURIComponent(id);
  if (sourceTable) path += '?sourceTable=' + encodeURIComponent(sourceTable);
  return request.del(path);
}
