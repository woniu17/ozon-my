// 平台订单获取路由(2026-09,平台订单获取 M1/M2)
// 采购弹框三平台(1688/淘宝/拼多多)订单从插件协作迁 ERP 后端,经 cloakbrowser
// (.linqx-profile)页面上下文取数;M1 拼多多,M2 1688/淘宝(mtop 签名 + token 轮换重试)
//
// 路由(注意注册顺序:/status 与 /search 必须先于 /:platform,否则被路径参数吞掉):
//   GET /admin/api/platform-orders/status            浏览器运行态 + 各平台登录态探测
//   GET /admin/api/platform-orders/:platform/search  按订单号精确搜索(补全商品图/数量)
//   GET /admin/api/platform-orders/:platform         订单列表(pdd/ali1688/taobao,tab=all|unreceived)
//
// 错误码(ApiError → {code, message}):
//   AUTH_REQUIRED(403)  平台登录态失效 → 前端提示运行 persistent 登录
//   PROFILE_LOCKED(409) .linqx-profile 被占用(persistent.js 窗口未关)
//   RISK_VALIDATE(409)  baxia/滑块风控(FAIL_SYS_USER_VALIDATE)
//   BROWSER_ERROR(502)  浏览器/网络/风控异常
//   TIMEOUT(408)        任务超时(浏览器已自动回收)
//
// 设计文档: docs/平台订单获取后端化-概要设计.md §5

import { Router } from 'express';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { status as browserStatus, getCookieState } from '../services/platform-orders/browser-manager.js';
import { listPddOrders, searchPddOrder } from '../services/platform-orders/adapters/pdd.js';
import { listAli1688Orders, searchAliOrder } from '../services/platform-orders/adapters/ali1688.js';
import { listTaobaoOrders, searchTaobaoOrder } from '../services/platform-orders/adapters/taobao.js';

const router = Router();

const PLATFORMS = new Map([
  ['pdd', { list: listPddOrders, search: searchPddOrder }],
  ['ali1688', { list: listAli1688Orders, search: searchAliOrder }],
  ['taobao', { list: listTaobaoOrders, search: searchTaobaoOrder }],
]);

// 平台登录态探测表(浏览器运行中才探测;未运行返回 unknown 不触发冷启动)
// 2026-09 实测 .linqx-profile 的真实登录标记(与插件侧文档注释有出入):
//  pdd: PDDAccessToken/pdd_user_id(实际无 pdd_user_uid cookie,会话照样有效)
//  ali1688/taobao: _m_h5_tk(mtop token)+ 平台登录 cookie 任一命中即视为已登录
const LOGIN_PROBES = new Map([
  ['pdd', { url: 'https://mobile.yangkeduo.com/', cookies: ['PDDAccessToken', 'pdd_user_uid', 'pdd_user_id'] }],
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

// ── GET /status:浏览器运行态 + 各平台登录态 ──────────────
router.get('/admin/api/platform-orders/status', async (_req, res, next) => {
  try {
    const bs = browserStatus();
    const platforms = {};
    for (const [name, probe] of LOGIN_PROBES) {
      const cookies = await getCookieState(probe.url);
      if (cookies === null) {
        platforms[name] = { login: 'unknown', hint: '浏览器未运行,首次订单请求会冷启动' };
      } else {
        // cookieNames 仅名称不含值,用于登录标记诊断(探测 cookie 名与真实会话可能不一致)
        platforms[name] = {
          login: cookies.some((c) => probe.cookies.includes(c.name)) ? 'yes' : 'no',
          cookieNames: cookies.map((c) => c.name),
        };
      }
    }
    res.json(ok({ ...bs, platforms }));
  } catch (e) { next(e); }
});

// ── GET /:platform/search:按订单号精确搜索 ──────────────
router.get('/admin/api/platform-orders/:platform/search', async (req, res, next) => {
  try {
    const orderSn = String(req.query.orderSn || '').trim();
    if (!orderSn) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, '缺少 orderSn 查询参数');
    }
    const adapter = getAdapter(String(req.params.platform));
    const result = await adapter.search(orderSn);
    res.json(ok(result));
  } catch (e) { next(e); }
});

// ── GET /:platform:订单列表 ─────────────────────────────
router.get('/admin/api/platform-orders/:platform', async (req, res, next) => {
  try {
    const tab = req.query.tab === 'unreceived' ? 'unreceived' : 'all';
    const sizeRaw = Number(req.query.size);
    const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, 50) : 30;
    const adapter = getAdapter(String(req.params.platform));
    const result = await adapter.list({ tab, size });
    res.json(ok(result));
  } catch (e) { next(e); }
});

export default router;
