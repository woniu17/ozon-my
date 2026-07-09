import * as request from './request.js';

// 上架记录列表(跨店铺,支持筛选 + 分页)
// params: currentPage/pageSize/storeId/keyword/status/viaPortal
export function getListings(params) {
  return request.get('/admin/api/listing-records', params);
}
