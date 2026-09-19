// 统一请求封装(与 web 端 erp-backend-lite/web/src/api/request.js 同构,底层换 uni.request)
// 职责:token 注入 / 401 清登录态跳登录页 / X-Refreshed-Token 滑动续期 / 错误 toast / 超时
import { BASE_URL } from '../config.js';

const TOKEN_KEY = 'erp_mini_token';
const USER_KEY = 'erp_mini_user';

// ── 登录态存取 ──────────────────────────────────────────────
export function getToken() {
  return uni.getStorageSync(TOKEN_KEY) || '';
}

export function getStoredUser() {
  return uni.getStorageSync(USER_KEY) || null;
}

export function setAuth(token, user) {
  uni.setStorageSync(TOKEN_KEY, token);
  uni.setStorageSync(USER_KEY, user || null);
}

export function clearAuth() {
  uni.removeStorageSync(TOKEN_KEY);
  uni.removeStorageSync(USER_KEY);
}

// ── 工具 ────────────────────────────────────────────────────
// 把 params 对象拼成 query string,跳过 null/undefined/空串(与 web 端一致)
function buildQuery(params) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  const s = parts.join('&');
  return s ? '?' + s : '';
}

function toastError(msg) {
  uni.showToast({ title: msg || '请求失败', icon: 'none', duration: 2500 });
}

// ── 核心请求 ────────────────────────────────────────────────
// options: { method, header, body, silent }
//   silent=true 时不弹错误 toast(程序化调用场景),仍会 reject
export function request(path, options = {}) {
  const { method: m, header: extraHeader, body: rawBody, silent = false } = options;
  const method = (m || 'GET').toUpperCase();
  const header = { 'Content-Type': 'application/json', ...(extraHeader || {}) };

  // 注入 Authorization
  const token = getToken();
  if (token) header['Authorization'] = 'Bearer ' + token;

  return new Promise((resolve, reject) => {
    uni.request({
      url: BASE_URL + path,
      method,
      header,
      // 对象 body 由 uni.request 自动 JSON 序列化(Content-Type 已是 application/json)
      data: rawBody !== undefined && rawBody !== null ? rawBody : undefined,
      timeout: 30000,
      success: (res) => {
        // 滑动续期:后端剩余有效期 < 50% 时通过响应头下发新 token
        // (小程序端 header key 大小写不固定,双查)
        const h = res.header || {};
        const refreshed = h['X-Refreshed-Token'] || h['x-refreshed-token'];
        if (refreshed) uni.setStorageSync(TOKEN_KEY, refreshed);

        const statusCode = res.statusCode;
        const data = res.data;

        // 401:token 过期/缺失 → 清登录态回登录页
        if (statusCode === 401) {
          clearAuth();
          if (!silent) toastError('登录已过期,请重新登录');
          uni.reLaunch({ url: '/pages/login/index' });
          reject(new Error('登录已过期,请重新登录'));
          return;
        }

        // envelope 解包(与 web 端一致:{ ok: true, data } / { ok: false, message })
        if (data && typeof data === 'object' && data.ok === true) {
          resolve(data.data);
          return;
        }
        const errMsg =
          data && typeof data === 'object' ? data.message || data.error || '' : '';
        if (data && typeof data === 'object' && data.ok === false) {
          if (!silent) toastError(errMsg);
          reject(new Error(errMsg || 'Unknown error'));
          return;
        }
        // 2xx 非 envelope(如 /auth/login-password 原样返回 { accessToken, user })
        if (statusCode >= 200 && statusCode < 300) {
          resolve(data);
          return;
        }
        // 非 2xx 非 envelope(如登录失败的 { code, message })
        const msg = errMsg || '请求失败 (' + statusCode + ')';
        if (!silent) toastError(msg);
        reject(new Error(msg));
      },
      fail: (err) => {
        const isTimeout = err && err.errMsg && err.errMsg.indexOf('timeout') >= 0;
        const msg = isTimeout ? '请求超时,请重试' : '网络请求失败,请检查网络';
        if (!silent) toastError(msg);
        reject(new Error(msg));
      },
    });
  });
}

export function get(path, params) {
  return request(path + buildQuery(params), { method: 'GET' });
}

export function post(path, body) {
  return request(path, { method: 'POST', body });
}
