// PDD 登录态 cookie 同步存储(2026-09-14,PDD 登录同步)
// 设计文档: docs/PDD登录同步-概要设计.md
//
// 职责(纯存储+映射,无浏览器依赖,避免与 browser-manager 循环引用):
//   - chrome.cookies 结构 → playwright addCookies 结构映射
//   - app_config 持久化(key=pdd_cookies_<account>)
//
// 背景:拼多多单点登录,登录权威源=用户日常浏览器;
//   妙手助手插件 popup 采集 cookie 经 ERP 页面桥 POST 到后端,存此模块,
//   browser-manager 启动后/运行中注入 cloakbrowser(ERP 侧永不登录 PDD)

import { db } from '../../db/index.js';
import { ApiError, ErrorCode } from '../../utils/error-codes.js';

// 必需 cookie(PDD 会话核心;缺任一=未登录)
// 2026-09-14 实测 PDD 已弃用 PDDAccessToken,会话仅靠 pdd_user_id + 其余会话 cookie
const REQUIRED_COOKIES = ['pdd_user_id'];

// app_config 读 JSON
function readConfigJson(key) {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// app_config 写 JSON(upsert)
function writeConfigJson(key, value, description) {
  db.prepare(
    `INSERT INTO app_config (key, value, scope, description, updated_at)
     VALUES (?, ?, 'erp', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       description = COALESCE(excluded.description, app_config.description),
       updated_at = datetime('now')`
  ).run(key, JSON.stringify(value), description || null);
}

// ── chrome.cookies → playwright cookie 映射 ────────────────
// chrome.cookies.Cookie: https://developer.chrome.com/docs/extensions/reference/api/cookies#type-Cookie
// playwright addCookies:  https://playwright.dev/docs/api/class-browsercontext#browser-context-add-cookies
const SAME_SITE_MAP = {
  no_restriction: 'None',   // Chrome 允许跨站(要求 secure)
  lax: 'Lax',
  strict: 'Strict',
};
// playwright 仅接受 Strict|Lax|None,其它值(如 unspecified)须整个省略字段(浏览器默认 Lax)
const PLAYWRIGHT_SAME_SITES = new Set(['Strict', 'Lax', 'None']);

/** 修复已映射 cookie 的 playwright 兼容性问题(读取时自愈存量数据)
 *  2026-09-14 实测坑:addCookies 传 sameSite:'Unspecified' 抛
 *  "expected one of (Strict|Lax|None)" 且整批原子失败(一条非法全部拒收),
 *  导致冷启动注入静默失败(仅日志 level 40,拉单 502 后才暴露) */
function fixPlaywrightCookie(c) {
  const out = { ...c };
  if (!PLAYWRIGHT_SAME_SITES.has(out.sameSite)) delete out.sameSite;
  else if (out.sameSite === 'None' && !out.secure) delete out.sameSite; // None 必须 secure,否则拒收
  return out;
}

/** 单条映射(校验失败抛错,整批原子性由调用方保证) */
function mapCookie(c) {
  if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') {
    throw new Error(`cookie 结构非法: ${JSON.stringify(c).slice(0, 120)}`);
  }
  const sameSite = SAME_SITE_MAP[c.sameSite]; // unspecified/未知 → 不传(浏览器默认)
  return {
    name: c.name,
    value: c.value,
    // hostOnly cookie 的 domain 无前导点,playwright 保持原样即可匹配
    domain: c.domain,
    path: c.path || '/',
    // 无 expirationDate = session cookie → -1;chrome 用秒,playwright 用秒(epoch)
    expires: typeof c.expirationDate === 'number' && c.expirationDate > 0 ? c.expirationDate : -1,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    ...(sameSite ? { sameSite } : {}),
  };
}

/**
 * 保存插件同步的 PDD cookies
 * @param {string} account 账号别名(linqx/chenlin)
 * @param {{uid?: string, cookies: object[]}} payload 插件上报(chrome.cookies 原始结构)
 * @returns {{account, uid, cookieCount, syncedAt}}
 * @throws VALIDATION_ERROR 必需 cookie 缺失(浏览器未登录 PDD)
 */
export function savePddCookies(account, payload) {
  const raw = Array.isArray(payload?.cookies) ? payload.cookies : [];
  const names = new Set(raw.map((c) => c && c.name));
  const missing = REQUIRED_COOKIES.filter((n) => !names.has(n));
  if (missing.length) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, `拼多多未登录或 cookie 不完整(缺 ${missing.join(', ')}),请先在浏览器登录 mobile.yangkeduo.com`);
  }
  const mapped = raw.map(mapCookie);
  const value = {
    uid: String(payload?.uid || ''),
    syncedAt: new Date().toISOString(),
    cookies: mapped,
  };
  writeConfigJson(`pdd_cookies_${account}`, value, '插件同步的拼多多登录 cookie(cloakbrowser 注入用)');
  return { account, uid: value.uid, cookieCount: mapped.length, syncedAt: value.syncedAt };
}

/** 读某账号已同步的 PDD cookies(未同步返回 null)
 *  读取时经 fixPlaywrightCookie 自愈:存量数据可能含 playwright 拒收的
 *  sameSite:'Unspecified'(2026-09-14 修复前保存的),冷启动/运行中注入都走这里 */
export function readPddCookies(account) {
  const v = readConfigJson(`pdd_cookies_${account}`);
  if (!v) return null;
  return { ...v, cookies: (v.cookies || []).map(fixPlaywrightCookie) };
}

/** 读某账号同步元信息(不含 cookie 明文;status 展示用) */
export function readPddCookieMeta(account) {
  const v = readPddCookies(account);
  if (!v) return null;
  return { uid: v.uid || '', syncedAt: v.syncedAt || null, cookieCount: (v.cookies || []).length };
}
