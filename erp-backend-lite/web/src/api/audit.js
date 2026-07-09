import * as request from './request.js';

// 操作日志列表(支持 action/storeId/operator/startDate/endDate 筛选 + 分页)
export function getAuditLogs(params) {
  return request.get('/admin/api/audit-logs', params);
}
