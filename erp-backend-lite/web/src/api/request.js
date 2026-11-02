// 统一 fetch 封装:envelope 解包、401 自动登出、X-Refreshed-Token 续期
const TOKEN_KEY = 'erp_admin_token';
const USER_KEY = 'erp_admin_user';

// 把 params 对象拼成 query string,跳过 null/undefined/空串
function buildQuery(params) {
  if (!params || typeof params !== 'object') return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, v);
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

export async function request(path, options = {}) {
  const { method: m, headers: extraHeaders, body: rawBody, ...rest } = options;
  const method = (m || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };

  // 注入 Authorization
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers['Authorization'] = 'Bearer ' + token;

  // 对象 body 自动 JSON.stringify
  let body = rawBody;
  if (body !== undefined && body !== null && typeof body === 'object') {
    body = JSON.stringify(body);
  }

  const res = await fetch(path, { method, headers, body, ...rest });

  // 续期:响应头 X-Refreshed-Token 下发新 token
  const refreshed = res.headers.get('X-Refreshed-Token');
  if (refreshed) localStorage.setItem(TOKEN_KEY, refreshed);

  // 401:仅当请求确实携带了 token 时才判定"登录过期"并清登录态;
  // 未带 token 的 401(后台残留标签/未登录请求)不触发全局登出,避免误删其他同源标签页的共享登录态
  if (res.status === 401) {
    if (token) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.dispatchEvent(new CustomEvent('auth:logout'));
    }
    throw new Error(token ? '登录已过期,请重新登录' : '登录状态无效,请重新登录');
  }

  // 解析响应体(容错:非 JSON 时 data 为 null)
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* 非 JSON 响应体 */
  }

  // HTTP 非 2xx(非 401):抛 message
  if (!res.ok) {
    throw new Error(data?.message || data?.error || '请求失败 (' + res.status + ')');
  }

  // envelope 解包
  if (data && data.ok === true) return data.data;
  if (data && data.ok === false) {
    throw new Error(data?.message || data?.error || 'Unknown error');
  }
  // 非 envelope 响应(如 /auth/login-password 原样返回 { accessToken, user })
  return data;
}

export function get(path, params) {
  return request(path + buildQuery(params), { method: 'GET' });
}

export function post(path, body) {
  return request(path, { method: 'POST', body });
}

export function put(path, body) {
  return request(path, { method: 'PUT', body });
}

export function del(path) {
  return request(path, { method: 'DELETE' });
}

// 二进制响应版 POST:成功返回 Blob(如 PDF 面单);失败解析 JSON envelope 抛 message
// 复用 token 注入 / 续期 / 401 登出逻辑
export async function postBlob(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });

  const refreshed = res.headers.get('X-Refreshed-Token');
  if (refreshed) localStorage.setItem(TOKEN_KEY, refreshed);

  if (res.status === 401) {
    // 与统一封装一致:仅请求确实携带 token 时才清登录态,避免后台无 token 请求误删共享登录态
    if (token) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.dispatchEvent(new CustomEvent('auth:logout'));
    }
    throw new Error(token ? '登录已过期,请重新登录' : '登录状态无效,请重新登录');
  }

  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* 非 JSON 响应体 */
    }
    throw new Error(data?.message || data?.error || '请求失败 (' + res.status + ')');
  }
  return res.blob();
}
