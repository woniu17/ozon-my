// 页面上下文表单 POST(2026-09,平台订单获取 M2)
// mtop/平台接口统一经 page.evaluate 单参数对象执行(踩坑:cloakbrowser evaluate
// 仅支持单参数,多参数静默失败);credentials:'include' 自动携带平台登录 cookie
// 2026-09-13:加 25s AbortController 超时——baxia 挂起式风控会让 fetch 永不返回,
// 原先只能等 60s 任务超时并整浏览器回收;现在快速失败为 BROWSER_ERROR(带风控提示)
import { ApiError } from '../../utils/error-codes.js';

const FETCH_TIMEOUT_MS = 25 * 1000;

/**
 * 在页面上下文 POST application/x-www-form-urlencoded 请求
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{status: number, ok: boolean, json: object|null}>}
 * @throws {ApiError} BROWSER_ERROR(页面 fetch 网络错误/超时挂起,如 baxia 风控)
 */
export async function postFormInPage(page, url, bodyString) {
  const r = await page.evaluate(async (arg) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), arg.timeoutMs);
    try {
      const resp = await fetch(arg.url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: arg.body,
        signal: ctrl.signal,
      });
      let json = null;
      try { json = await resp.json(); } catch { /* 非 JSON 响应 */ }
      return { status: resp.status, ok: resp.ok, json };
    } catch (e) {
      return { networkError: String((e && e.message) || e), aborted: e && e.name === 'AbortError' };
    } finally {
      clearTimeout(timer);
    }
  }, { url, body: bodyString, timeoutMs: FETCH_TIMEOUT_MS });
  if (r && r.networkError) {
    if (r.aborted) {
      // 挂起式拦截:mtop 请求被 baxia 扣住不返回(实测 chenlin 账号 60s 任务超时的根因)
      throw new ApiError('BROWSER_ERROR', `页面请求 ${FETCH_TIMEOUT_MS}ms 无响应(疑似平台风控挂起),请运行 qxqx 的 persistent 打开平台订单页人工过验证后重试`, { status: 502 });
    }
    throw new ApiError('BROWSER_ERROR', `页面 fetch 网络错误: ${r.networkError}`, { status: 502 });
  }
  return r || {};
}
