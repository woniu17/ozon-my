// 页面上下文表单 POST(2026-09,平台订单获取 M2)
// mtop/平台接口统一经 page.evaluate 单参数对象执行(踩坑:cloakbrowser evaluate
// 仅支持单参数,多参数静默失败);credentials:'include' 自动携带平台登录 cookie
import { ApiError } from '../../utils/error-codes.js';

/**
 * 在页面上下文 POST application/x-www-form-urlencoded 请求
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{status: number, ok: boolean, json: object|null}>}
 * @throws {ApiError} BROWSER_ERROR(页面 fetch 网络错误,如 CORS/断网)
 */
export async function postFormInPage(page, url, bodyString) {
  const r = await page.evaluate(async (arg) => {
    try {
      const resp = await fetch(arg.url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: arg.body,
      });
      let json = null;
      try { json = await resp.json(); } catch { /* 非 JSON 响应 */ }
      return { status: resp.status, ok: resp.ok, json };
    } catch (e) {
      return { networkError: String((e && e.message) || e) };
    }
  }, { url, body: bodyString });
  if (r && r.networkError) {
    throw new ApiError('BROWSER_ERROR', `页面 fetch 网络错误: ${r.networkError}`, { status: 502 });
  }
  return r || {};
}
