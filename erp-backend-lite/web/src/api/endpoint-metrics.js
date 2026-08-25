import * as request from './request.js';

// 时间轴聚合查询
// 参数:{ from, to, endpoints?, machines?, profiles?, ips?, scripts?, bucket? }
// 返回:{ series: [{endpoint,bucketTs,count,p50,p95,avg,errCount}], stats: [{endpoint,total,p50,p95,avg,errRate}], bucket, count }
export function queryEndpointMetrics(params) {
  return request.get('/admin/api/endpoint-metrics/query', params);
}

// 各维度可用值(供筛选下拉)
// 返回:{ endpoints, machines, profiles, ips, scripts }
export function getEndpointMetricsDims(days = 7) {
  return request.get('/admin/api/endpoint-metrics/dims', { days });
}
