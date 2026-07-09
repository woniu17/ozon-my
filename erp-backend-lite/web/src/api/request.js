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

  // 401:清登录态 + 全局登出事件
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.dispatchEvent(new CustomEvent('auth:logout'));
    throw new Error('登录已过期,请重新登录');
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
    throw new Error(data?.message || '请求失败 (' + res.status + ')');
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
