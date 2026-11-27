// 统一 fetch 封装:envelope 解包、401 自动登出、X-Refreshed-Token 续期
const TOKEN_KEY = 'erp_admin_token';
const USER_KEY = 'erp_admin_user';

// 临时诊断(2026-11-27):发运页出现"刚登录 4 秒 token 就被判无效",需要确认
// 401 时请求所用 token 与当前 localStorage 是否一致。定位后移除。
function tokenHead(t) {
  return t ? String(t).slice(0, 12) + '…' : '(none)';
}
function tokenMeta(t) {
  try {
    const json = atob(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
    const p = JSON.parse(json);
    return { id: p.id, iat: p.iat ? new Date(p.iat * 1000).toLocaleString() : null, exp: p.exp ? new Date(p.exp * 1000).toLocaleString() : null };
  } catch {
    return null;
  }
}

/**
 * 统一 401 处理:返回给调用方的错误文案。
 * 仅当"本次请求所用 token"仍是当前 localStorage 里的 token 时才清登录态——
 * 否则可能是别的标签页刚续期/重新登录写入了新 token,不能连带删除。
 */
function handle401(token, path) {
  const current = localStorage.getItem(TOKEN_KEY);
  console.warn('[auth-diag] 401', {
    path,
    used: tokenHead(token),
    current: tokenHead(current),
    sameToken: current === token,
    usedMeta: tokenMeta(token),
    currentMeta: tokenMeta(current),
  });
  if (token && current === token) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.dispatchEvent(new CustomEvent('auth:logout'));
  }
  return token ? '登录已过期,请重新登录' : '登录状态无效,请重新登录';
}

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

  // 401:仅当请求确实携带了 token、且该 token 仍是当前登录态时才清登录态并全局登出;
  // 未带 token 的 401(后台残留标签/未登录请求)或已被其他标签页替换的旧 token 不触发登出,
  // 避免误删其他同源标签页刚续期/新登录的共享登录态
  if (res.status === 401) {
    throw new Error(handle401(token, path));
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
    // 与统一封装一致:仅请求确实携带 token、且未被其他标签页替换时才清登录态
    throw new Error(handle401(token, path));
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
