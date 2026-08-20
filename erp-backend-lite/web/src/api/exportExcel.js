import * as request from './request.js';

const TOKEN_KEY = 'erp_admin_token';

// 创建导出任务(同步完成,创建即终态)
// body: { count, marketStatsRatio, name?, filters: {...采集箱筛选条件} }
export function createExportTask(body) {
  return request.post('/admin/api/export-excel', body);
}

// 导出预览(不创建任务,返回候选池统计与预计构成)
// body: { count?, marketStatsRatio?, filters: {...采集箱筛选条件} }
export function previewExportExcel(body) {
  return request.post('/admin/api/export-excel/preview', body);
}

// 导出任务列表(分页)
export function getExportTaskList(params) {
  return request.get('/admin/api/export-excel', params);
}

// 任务详情(含明细 items)
export function getExportTaskDetail(localTaskId) {
  return request.get('/admin/api/export-excel/' + encodeURIComponent(localTaskId));
}

// 下载 Excel(blob 流,触发浏览器保存;后端每次下载自动 +1 计数,可多次下载)
// 注:request.js 的统一封装会按 JSON 解析响应体,二进制下载需单独走 fetch
export async function downloadExportExcel(localTaskId) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch('/admin/api/export-excel/' + encodeURIComponent(localTaskId) + '/download', {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('erp_admin_user');
    window.dispatchEvent(new CustomEvent('auth:logout'));
    throw new Error('登录已过期,请重新登录');
  }
  if (!res.ok) {
    let msg = '下载失败 (' + res.status + ')';
    try {
      const data = await res.json();
      if (data?.message) msg = data.message;
    } catch (_) {
      /* 非 JSON 响应体 */
    }
    throw new Error(msg);
  }

  const blob = await res.blob();
  // 从 Content-Disposition 提取文件名(后端 filename*=UTF-8'' 编码)
  let filename = 'export-' + localTaskId + '.xlsx';
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  if (m) {
    try {
      filename = decodeURIComponent(m[1]);
    } catch (_) {
      /* 保留默认名 */
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
