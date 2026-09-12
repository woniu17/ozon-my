// 1688 订单适配器(2026-09,平台订单获取 M2)
// 语义基准:miaoshou-helper/ali-1688-page-bridge.js fetch1688OrdersInPage / searchAliOrderInPage
//
// 接口语义(实测):
//  - h5api.m.1688.com mtop.1688.trading.dataline.service,serviceId=OrderListDataLineService.buyerOrderList
//  - sign = md5(token&t&appKey&data),token 取 _m_h5_tk cookie 下划线前段,appKey=12574478
//  - valueType=string:json.data.data.result 是字符串,内层 JSON 再解一层才是订单数组
//  - token 失败(FAIL_SYS_TOKEN_EMPTY/ILLEGAL_ACCESS)→ 服务器已轮换 _m_h5_tk →
//    重取 cookie 重签重试 ×1;两次都失败按登录态失效处理
//  - FAIL_SYS_USER_VALIDATE = baxia 风控 → RISK_VALIDATE(需人工过验证)
//
// 执行位置:必须先导航到 air.1688.com 订单页(与插件自动开的隐藏 tab 同款 URL),
// 页面上下文 fetch 自动带正确 referer/origin 过 baxia(SW 裸 fetch 会被拦);
// 签名在 Node 侧用 node:crypto(与页面注入 JS MD5 结果一致,免注入源码)

import { ApiError, ErrorCode } from '../../../utils/error-codes.js';
import { withPage } from '../browser-manager.js';
import { mtopSign, tokenFromCookies } from '../mtop-sign.js';
import { postFormInPage } from '../page-fetch.js';

const ALI_API = 'https://h5api.m.1688.com/h5/mtop.1688.trading.dataline.service/1.0/';
const ALI_APP_KEY = '12574478';
// 与插件自动打开的隐藏 tab 同款 URL;页面自身的订单 mtop 调用会刷新 _m_h5_tk token
const ALI_ENTRY = 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?page=1&pageSize=10';
const ALI_ORIGIN = 'https://air.1688.com';
const ALI_TRADE_STATUS = { all: '', unshipped: 'waitsellersend', unreceived: 'waitbuyerreceive' };
// 首次导航后等页面自身 mtop 调用轮换 token(插件隐藏 tab 等 8s,这里收敛为 1s + 重试兜底)
const ALI_SETTLE_MS = 1000;

function toYuan(fen) {
  return (Number(fen || 0) / 100).toFixed(2);
}

/** 瘦身为 ERP 前端需要的精简结构(与插件 normalize1688Order 逐字段一致,与 PDD 结构对齐) */
function normalize1688Order(o) {
  const entries = Array.isArray(o.orderEntries) ? o.orderEntries : [];
  const tracks = entries.map((e) => e.entryExtension && e.entryExtension.trackingNo).filter(Boolean);
  return {
    orderSn: o.idStr || o.id || '',
    status: o.status || '',
    statusPrompt: o.statusLabel || '',
    amount: toYuan(o.sumPayment),
    trackingNumber: tracks[0] || '',
    orderTime: o.gmtCreate || '',
    sellerName: (o.sellerInfo && (o.sellerInfo.loginId || o.sellerInfo.companyName)) || '',
    goods: entries.map((e) => ({
      goodsName: e.productName || '',
      spec: ((e.specInfo && e.specInfo.specItems) || []).map((i) => `${i.specName}:${i.specValue}`).join(' '),
      price: toYuan(e.price),
      number: Number((e.quantity && (e.quantity.realAmountStr || e.quantity.calAmount)) || 1),
      thumbUrl: (e.mainSummImageUrl || '').replace(/^http:/, 'https:'),
    })),
  };
}

/**
 * mtop 调用(含 token 轮换重试);返回订单原始数组
 * @param {boolean} searchMode 无数据时返回 null(搜索语义),非搜索模式抛错(对齐插件)
 */
async function call1688Mtop(page, param, searchMode = false) {
  const data = JSON.stringify({
    serviceId: 'OrderListDataLineService.buyerOrderList',
    param: JSON.stringify(param),
  });
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = tokenFromCookies(await page.context().cookies('https://h5api.m.1688.com/'));
    const t = String(Date.now());
    const sign = mtopSign(token, t, ALI_APP_KEY, data);
    const body = new URLSearchParams({
      jsv: '2.7.4', appKey: ALI_APP_KEY, t, sign,
      ecode: '1', type: 'json', valueType: 'string',
      api: 'mtop.1688.trading.dataline.service', v: '1.0',
      dataType: 'json', timeout: '20000', data,
    }).toString();
    const r = await postFormInPage(page, ALI_API, body);
    const prefix = searchMode ? 'ALI_SEARCH' : 'ALI';
    if (r.status === 401 || r.status === 403) {
      throw new ApiError(ErrorCode.AUTH_REQUIRED, '1688登录态失效,请运行 qxqx 的 persistent 登录 1688 后重试');
    }
    if (!r.ok) {
      throw new ApiError('BROWSER_ERROR', `${prefix}_HTTP_${r.status}: 1688接口返回异常`, { status: 502 });
    }
    const json = r.json;
    if (!json || typeof json !== 'object') {
      throw new ApiError('BROWSER_ERROR', `${prefix}_BAD_RESPONSE: 接口返回异常(可能触发风控)`, { status: 502 });
    }
    const ret = (Array.isArray(json.ret) && json.ret[0]) || '';
    if (/^FAIL_SYS_TOKEN_EMPTY|^FAIL_SYS_ILLEGAL_ACCESS/.test(ret)) {
      // token 失败:服务器轮换 _m_h5_tk 后重取重签重试 1 次
      lastErr = new ApiError(ErrorCode.AUTH_REQUIRED, `1688 mtop token 失效(${ret}),请运行 qxqx 的 persistent 登录 1688 并刷新一次订单页后重试`);
      continue;
    }
    if (/^FAIL_SYS_USER_VALIDATE/.test(ret)) {
      throw new ApiError('RISK_VALIDATE', '1688风控拦截(baxia),请运行 qxqx 的 persistent 打开 1688 订单页人工过验证后重试', { status: 409 });
    }
    if (!/^SUCCESS/.test(ret)) {
      throw new ApiError('BROWSER_ERROR', `${prefix}_${ret || 'BAD_RESPONSE'}`, { status: 502 });
    }
    const resultStr = json.data && json.data.data && json.data.data.result;
    if (typeof resultStr !== 'string') {
      if (searchMode) return null; // 无数据
      throw new ApiError('BROWSER_ERROR', `${prefix}_BAD_RESPONSE: 响应缺少订单数据`, { status: 502 });
    }
    let inner;
    try { inner = JSON.parse(resultStr); } catch {
      throw new ApiError('BROWSER_ERROR', `${prefix}_BAD_RESPONSE: 订单数据解析失败`, { status: 502 });
    }
    return (inner.data && Array.isArray(inner.data.data)) ? inner.data.data : [];
  }
  throw lastErr;
}

/** 订单列表;返回 { orders }(精简结构,字段与插件一致;订单行带 account 标注) */
async function listAli1688Orders({ tab = 'all', size = 30, account } = {}) {
  return withPage(account, 'ali1688', ALI_ENTRY, ALI_ORIGIN, async (page) => {
    const param = { page: 1, pageSize: Math.min(Number(size) || 30, 50) };
    const st = ALI_TRADE_STATUS[tab];
    if (st) param.tradeStatus = st;
    const orders = await call1688Mtop(page, param);
    return { orders: orders.map((o) => ({ ...normalize1688Order(o), account })) };
  }, { settleMs: ALI_SETTLE_MS });
}

/** 单账号搜索实现;无命中返回 null(不抛错) */
async function searchAliInAccount(orderSn, account) {
  return withPage(account, 'ali1688', ALI_ENTRY, ALI_ORIGIN, async (page) => {
    const param = { page: 1, pageSize: 20, word: String(orderSn || '') };
    const orders = await call1688Mtop(page, param, true);
    if (!orders || !orders.length) return null;
    const n = normalize1688Order(orders[0]);
    // 对齐插件 searchAliOrder 返回结构(与 searchPddOrder 一致)
    return {
      orderSn: n.orderSn,
      orderAmount: n.amount,
      orderTime: n.orderTime,
      statusPrompt: n.statusPrompt,
      trackingNumber: n.trackingNumber,
      goods: n.goods,
    };
  }, { settleMs: ALI_SETTLE_MS });
}

/** 按订单号精确搜索(补全商品图/数量);未找到返回 { result: null }
 *  多账号(2026-09-13):逐账号尝试,命中即返回;登录失效/风控不中断(记录后试下一账号),
 *  全部账号登录态失败才抛 AUTH_REQUIRED;账号正常但无命中 → { result: null } */
async function searchAliOrder(orderSn, accounts = []) {
  const errs = [];
  for (const account of accounts) {
    let result;
    try {
      result = await searchAliInAccount(orderSn, account);
    } catch (e) {
      // 该账号登录失效/风控:记录后继续下一账号(单号可能在别的账号)
      if (e instanceof ApiError && (e.code === ErrorCode.AUTH_REQUIRED || e.code === 'RISK_VALIDATE')) {
        errs.push(`[${account}] ${e.message}`);
        continue;
      }
      throw e; // 浏览器/网络级错误直接抛
    }
    if (result) return { result: { ...result, account } };
  }
  if (errs.length) {
    throw new ApiError(ErrorCode.AUTH_REQUIRED, `1688全部账号搜索失败:\n${errs.join('\n')}`);
  }
  return { result: null }; // 所有账号正常,单号不存在
}

export { listAli1688Orders, searchAliOrder };
