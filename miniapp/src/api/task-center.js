// 任务中心 API(H5 只读)
// 对应 web 端:imageRefresh / stockRefresh / productUpdate / productArchive / exportExcel
import { get } from './request.js';

const TOKEN_KEY = 'erp_mini_token';

// ── 图片更新任务 ──────────────────────────────────────────
export function getImageRefreshList(params) {
  return get('/admin/api/image-refresh', params);
}

// ── 库存更新任务 ──────────────────────────────────────────
export function getStockRefreshList(params) {
  return get('/admin/api/stock-refresh', params);
}

// ── 商品信息更新任务 ─────────────────────────────────────
export function getProductUpdateList(params) {
  return get('/admin/api/product-update', params);
}

// ── 商品归档任务 ──────────────────────────────────────
export function getProductArchiveList(params) {
  return get('/admin/api/product-archive', params);
}

// ── 导出任务 ─────────────────────────────────────────────
export function getExportTaskList(params) {
  return get('/admin/api/export-excel', params);
}

// ── 店铺列表(id -> name 映射用) ─────────────────────────
export function getStores() {
  return get('/admin/api/stores');
}

// 导出任务下载(H5 浏览器环境:带 token 的 fetch blob,触发浏览器保存)
// 注:request.js 统一按 JSON 解包,二进制下载需单独走 fetch(H5 同源,URL 直接拼)
export async function downloadExportExcel(localTaskId) {
  const token = uni.getStorageSync(TOKEN_KEY) || '';
  const url = '/admin/api/export-excel/' + encodeURIComponent(localTaskId) + '/download';
  const res = await fetch(url, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });

  if (res.status === 401) {
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

  const urlObj = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = urlObj;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(urlObj);
}