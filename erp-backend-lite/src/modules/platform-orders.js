// 平台订单获取路由(2026-09,平台订单获取 M1/M2;2026-09-13 多账号)
// 采购弹框三平台(1688/淘宝/拼多多)订单从插件协作迁 ERP 后端,经 cloakbrowser
// 页面上下文取数;M1 拼多多,M2 1688/淘宝(mtop 签名 + token 轮换重试)
// 多账号:平台→账号列表(.env PLATFORM_ACCOUNTS_*,第一个为主账号),
// 列表接口带 account 参数,搜索接口后端内跨账号(前端零感知)
//
// 路由(注意注册顺序:/status 与 /search 必须先于 /:platform,否则被路径参数吞掉):
//   GET /admin/api/platform-orders/status            全部账号浏览器运行态 + 各平台×账号登录态
//   GET /admin/api/platform-orders/:platform/search  按订单号精确搜索(跨该平台全部账号)
//   GET /admin/api/platform-orders/:platform         订单列表(pdd/ali1688/taobao,?account=linqx|chenlin)
//
// 错误码(ApiError → {code, message}):
//   AUTH_REQUIRED(403)  平台登录态失效 → 前端提示运行 persistent 登录
//   PROFILE_LOCKED(409) profile 被占用(persistent.js 窗口未关)
//   RISK_VALIDATE(409)  baxia/滑块风控(FAIL_SYS_USER_VALIDATE)
//   BROWSER_ERROR(502)  浏览器/网络/风控异常
//   TIMEOUT(408)        任务超时(浏览器已自动回收)
//
// 设计文档: docs/平台订单多账号profile-功能设计.md §3.3

import { Router } from 'express';
import config from '../config/index.js';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { status as browserStatus, getCookieState, applyPddCookies } from '../services/platform-orders/browser-manager.js';
import { savePddCookies, readPddCookies, readPddCookieMeta } from '../services/platform-orders/pdd-cookie-store.js';
import { listPddOrders, searchPddOrder } from '../services/platform-orders/adapters/pdd.js';
import {
  listAli1688Orders as listAliViaBrowser,
  searchAliInAccount as searchAliViaBrowser,
} from '../services/platform-orders/adapters/ali1688.js';
import {
  hasAliOpenApiToken,
  listAli1688OpenApiOrders,
  searchAliOpenApiInAccount,
} from '../services/platform-orders/adapters/ali1688-openapi.js';
import { listTaobaoOrders, searchTaobaoOrder } from '../services/platform-orders/adapters/taobao.js';

const router = Router();

// ── 1688 双适配器路由(2026-09-13)────────────────────────────
// 已配官方 API token 的账号走 openapi(无风控),未配的回落浏览器 mtop;
// 输出结构两版逐字段一致,前端零感知

/** 列表:按账号 token 有无分流 */
async function listAli1688Orders({ tab, size, account }) {
  if (hasAliOpenApiToken(account)) return listAli1688OpenApiOrders({ tab, size, account });
  return listAliViaBrowser({ tab, size, account });
}

/** 搜索:跨账号聚合(官方 API 账号优先,浏览器账号兜底);
 *  语义与浏览器版 searchAliOrder 一致:命中即返;登录失效/风控记录后试下一账号;
 *  全部账号登录态失败才抛 AUTH_REQUIRED */
async function searchAliOrder(orderSn, accounts = []) {
  const errs = [];
  for (const account of accounts) {
    let result;
    try {
      result = hasAliOpenApiToken(account)
        ? await searchAliOpenApiInAccount(orderSn, account)
        : await searchAliViaBrowser(orderSn, account);
    } catch (e) {
      // 该账号登录失效/风控:记录后继续下一账号(单号可能在别的账号)
      if (e instanceof ApiError && (e.code === ErrorCode.AUTH_REQUIRED || e.code === 'RISK_VALIDATE')) {
        errs.push(`[${account}${hasAliOpenApiToken(account) ? ':api' : ':browser'}] ${e.message}`);
        continue;
      }
      throw e; // 网络/系统级错误直接抛
    }
    if (result) return { result: { ...result, account } };
  }
  if (errs.length) {
    throw new ApiError(ErrorCode.AUTH_REQUIRED, `1688全部账号搜索失败:\n${errs.join('\n')}`);
  }
  return { result: null }; // 所有账号正常,单号不存在
}

const PLATFORMS = new Map([
  ['pdd', { list: listPddOrders, search: searchPddOrder }],
  ['ali1688', { list: listAli1688Orders, search: searchAliOrder }],
  ['taobao', { list: listTaobaoOrders, search: searchTaobaoOrder }],
]);

// 平台登录态探测表(浏览器运行中才探测;未运行返回 unknown 不触发冷启动)
// 2026-09-14 实测 PDD 已弃用 PDDAccessToken cookie,会话仅靠 pdd_user_id +
// 其余会话 cookie(api_uid/pdd_vds 等);任一命中即视为已登录
//  ali1688/taobao: _m_h5_tk(mtop token)+ 平台登录 cookie 任一命中即视为已登录
//  注意 'yes' 仅代表 cookie 存在,session 真实失效由请求时的 AUTH_REQUIRED 兜底
const LOGIN_PROBES = new Map([
  ['pdd', { url: 'https://mobile.yangkeduo.com/', cookies: ['pdd_user_uid', 'pdd_user_id'] }],
  ['ali1688', { url: 'https://air.1688.com/', cookies: ['_m_h5_tk', '__cn_logon__'] }],
  ['taobao', { url: 'https://h5api.m.taobao.com/', cookies: ['_m_h5_tk', 'tracknick'] }],
]);

function getAdapter(platform) {
  const adapter = PLATFORMS.get(platform);
  if (!adapter) {
    throw new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `不支持的平台: ${platform}(仅 pdd/ali1688/taobao)`);
  }
  return adapter;
}

/** 解析 account 参数:不传=主账号(平台账号列表第一个);非白名单值 400 */
function resolveAccount(platform, accountParam) {
  const accounts = config.platformAccounts[platform] || [];
  if (!accounts.length) {
    throw new ApiError('BROWSER_ERROR', `平台 ${platform} 未配置任何账号(检查 .env PLATFORM_ACCOUNTS_*)`, { status: 500 });
  }
  const account = String(accountParam || '').trim();
  if (!account) return accounts[0];
  if (!accounts.includes(account)) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, `平台 ${platform} 不存在账号 "${account}",可用: ${accounts.join(', ')}`);
  }
  return account;
}

// ── POST /pdd-sync-cookies:插件同步 PDD 登录 cookie(2026-09-14)──
// 链路:插件 popup → background(tabs.sendMessage)→ erp-bridge → ERP 前端(JWT)→ 本路由
// 职责:app_config 持久化 + 运行中浏览器即时注入(未启动则下次冷启动自动注入)
// 设计文档: docs/PDD登录同步-概要设计.md §4.5
router.post('/admin/api/platform-orders/pdd-sync-cookies', async (req, res, next) => {
  try {
    const account = resolveAccount('pdd', req.body?.account);
    const saved = savePddCookies(account, req.body);
    // 注入运行中浏览器(未运行返回 false,下次冷启动 doLaunch 自动注入)
    let injected = false;
    try {
      const stored = readPddCookies(account);
      injected = await applyPddCookies(account, stored?.cookies || []);
    } catch (e) {
      // 注入失败(如 addCookies 参数异常)不影响持久化,返回 injected:false 由前端提示
      injected = false;
    }
    res.json(ok({ ...saved, injected }));
  } catch (e) { next(e); }
});

// ── GET /status:全部账号浏览器运行态 + 各平台×账号登录态 ─
router.get('/admin/api/platform-orders/status', async (_req, res, next) => {
  try {
    const bs = browserStatus(); // { state, browsers: { <账号>: {...} } }
    const platforms = {};
    for (const [name, probe] of LOGIN_PROBES) {
      const accounts = {};
      for (const account of config.platformAccounts[name] || []) {
        // 1688 官方 API 账号:token 即登录态,免浏览器探测(不触发冷启动)
        if (name === 'ali1688' && hasAliOpenApiToken(account)) {
          accounts[account] = { login: 'yes', source: 'openapi' };
          continue;
        }
        const cookies = await getCookieState(account, probe.url);
        if (cookies === null) {
          // PDD:浏览器未运行时报告插件同步状态(有同步记录=可拉单,冷启动自动注入)
          const pddMeta = name === 'pdd' ? readPddCookieMeta(account) : null;
          accounts[account] = pddMeta
            ? { login: 'yes', source: 'plugin-synced', cookieSyncedAt: pddMeta.syncedAt, uid: pddMeta.uid }
            : { login: 'unknown', hint: '浏览器未运行,首次订单请求会冷启动' };
          continue;
        }
        accounts[account] = {
          // cookieNames 仅名称不含值,用于登录标记诊断(探测 cookie 名与真实会话可能不一致)
          login: cookies.some((c) => probe.cookies.includes(c.name)) ? 'yes' : 'no',
          cookieNames: cookies.map((c) => c.name),
        };
      }
      platforms[name] = { accounts };
    }
    res.json(ok({ ...bs, platforms }));
  } catch (e) { next(e); }
});

// ── GET /:platform/search:按订单号精确搜索(跨该平台全部账号) ──
router.get('/admin/api/platform-orders/:platform/search', async (req, res, next) => {
  try {
    const orderSn = String(req.query.orderSn || '').trim();
    if (!orderSn) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, '缺少 orderSn 查询参数');
    }
    const platform = String(req.params.platform);
    getAdapter(platform);
    const accounts = config.platformAccounts[platform] || [];
    if (!accounts.length) {
      throw new ApiError('BROWSER_ERROR', `平台 ${platform} 未配置任何账号(检查 .env PLATFORM_ACCOUNTS_*)`, { status: 500 });
    }
    const result = await getAdapter(platform).search(orderSn, accounts);
    res.json(ok(result));
  } catch (e) { next(e); }
});

// ── GET /:platform:订单列表(单账号,?account 指定)────────
router.get('/admin/api/platform-orders/:platform', async (req, res, next) => {
  try {
    const platform = String(req.params.platform);
    getAdapter(platform);
    // tab 白名单透传:pdd 内部把 unshipped 折叠为 all;ali1688/taobao 原生支持
    const tab = ['all', 'unshipped', 'unreceived'].includes(String(req.query.tab)) ? String(req.query.tab) : 'all';
    const sizeRaw = Number(req.query.size);
    const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, 50) : 30;
    const account = resolveAccount(platform, req.query.account);
    const result = await getAdapter(platform).list({ tab, size, account });
    res.json(ok(result));
  } catch (e) { next(e); }
});

export default router;
