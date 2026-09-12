// 淘宝订单适配器(2026-09,平台订单获取 M2)
// 语义基准:miaoshou-helper/background.js fetchTaobaoOrders / searchTaobaoOrder(逐字段对齐)
//
// 接口语义(实测):
//  - h5api.m.taobao.com mtop.taobao.order.queryboughtlistV2,appKey=12574478
//  - 与 1688 同一套 mtop 签名(token 为淘宝域 _m_h5_tk,与 1688 的独立)
//  - query 必须带 ttid=1@tbwang_windows_1.0.0#pc + needLogin=true(缺 ttid 报服务内部故障)
//  - 响应为卡片化组件(shopInfo_/orderItemInfo_/orderPayment_/orderStatus_ 前缀),需聚合还原
//  - token 失败(FAIL_SYS_TOKEN_EMPTY/ILLEGAL_ACCESS)→ 服务器轮换 _m_h5_tk → 重取重签重试 ×1
//  - 搜索:同 API,OrderType 改 OrderSearch + condition 加 wordType/wordTerm/showText/itemTitle
//
// 执行位置:页面直接以 mtop 网关 h5api.m.taobao.com 为 origin(同源 fetch 免 CORS,
// 登录 cookie 照常携带);插件 SW 裸 fetch 无 referer/origin 亦可行,说明网关不强校验 referer

import { ApiError, ErrorCode } from '../../../utils/error-codes.js';
import { withPage } from '../browser-manager.js';
import { mtopSign, tokenFromCookies } from '../mtop-sign.js';
import { postFormInPage } from '../page-fetch.js';

const TB_API = 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/';
const TB_APP_KEY = '12574478';
// 载体页用真实淘宝站点 m.taobao.com,桌面 UA 下会被 302 到 www.taobao.com(PC 站):
// 2026-09 实测以网关自身 h5api.m.taobao.com 作页面 origin 会报 FAIL_SYS_SESSION_EXPIRED
// (mtop session 校验不认网关 origin 的请求;插件 SW 无 Origin 头则可通过)
const TB_ENTRY = 'https://m.taobao.com/';
const TB_ORIGIN = 'https://www.taobao.com';
const TB_TAB_CODE = { all: 'all', unshipped: 'waitSend', unreceived: 'waitConfirm' };
// 必需:缺 ttid 网关报服务内部故障(实测踩坑)
const TB_TTID = '1@tbwang_windows_1.0.0#pc';

/** "￥1.58" → "1.58" */
function stripYuan(s) {
  return String(s || '').replace(/[^\d.]/g, '') || '0';
}

/** 卡片化组件聚合还原订单(与插件 normalizeTaobaoOrders 逐字段一致,与 PDD/1688 结构对齐) */
function normalizeTaobaoOrders(data) {
  const components = (data && data.data) || {};
  const orderIds = Object.keys(components)
    .filter((k) => k.indexOf('shopInfo_') === 0)
    .map((k) => k.substring(9)); // 'shopInfo_'.length === 9
  return orderIds.map((oid) => {
    const shop = (components[`shopInfo_${oid}`] || {}).fields || {};
    const pay = (components[`orderPayment_${oid}`] || {}).fields || {};
    const status = (components[`orderStatus_${oid}`] || {}).fields || {};
    const goods = Object.keys(components)
      .filter((k) => k.indexOf(`orderItemInfo_${oid}_`) === 0)
      .map((k) => (((components[k] || {}).fields || {}).item || {}))
      .map((f) => ({
        goodsName: f.title || '',
        spec: f.skuText || '',
        price: stripYuan(f.priceInfo && f.priceInfo.actualTotalFee),
        number: Number(f.quantity || 1),
        thumbUrl: (f.pic || '').replace(/^\/\//, 'https://'),
      }));
    return {
      orderSn: shop.orderId || oid,
      status: '',
      statusPrompt: shop.tradeTitle || '',
      amount: stripYuan(pay.actualFee && pay.actualFee.value),
      trackingNumber: status.mailNo || '',
      orderTime: shop.createTime || '',
      sellerName: shop.shopName || shop.sellerName || '',
      goods,
    };
  });
}

/** mtop 调用(含 token 轮换重试);返回成功响应的 json(调用方自行判断 data) */
async function callTaobaoMtop(page, data, customTag, searchMode = false) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = tokenFromCookies(await page.context().cookies('https://h5api.m.taobao.com/'));
    const t = String(Date.now());
    const sign = mtopSign(token, t, TB_APP_KEY, data);
    const body = new URLSearchParams({
      jsv: '2.7.2', appKey: TB_APP_KEY, t, sign, v: '1.0',
      ecode: '1', timeout: '8000', dataType: 'json', valueType: 'original',
      ttid: TB_TTID, needLogin: 'true',
      type: 'originaljson', isHttps: '1', needRetry: 'true',
      api: 'mtop.taobao.order.queryboughtlistV2',
      __customTag__: customTag,
      preventFallback: 'true', data,
    }).toString();
    const r = await postFormInPage(page, TB_API, body);
    const prefix = searchMode ? 'TB_SEARCH' : 'TB';
    if (r.status === 401 || r.status === 403) {
      throw new ApiError(ErrorCode.AUTH_REQUIRED, '淘宝登录态失效,请运行 qxqx 的 persistent 登录淘宝后重试');
    }
    if (!r.ok) {
      throw new ApiError('BROWSER_ERROR', `${prefix}_HTTP_${r.status}: 淘宝接口返回异常`, { status: 502 });
    }
    const json = r.json;
    if (!json || typeof json !== 'object') {
      throw new ApiError('BROWSER_ERROR', `${prefix}_BAD_RESPONSE: 接口返回异常(可能触发风控)`, { status: 502 });
    }
    const ret = (Array.isArray(json.ret) && json.ret[0]) || '';
    if (/^FAIL_SYS_SESSION_EXPIRED/.test(ret)) {
      // 2026-09 实测:profile 淘宝 session 过期时登录 cookie 仍残留在 jar(unb/cookie2 存在),
      // 接口即报此错;必须重新登录才恢复,不能靠重试
      throw new ApiError(ErrorCode.AUTH_REQUIRED, '淘宝登录已过期,请运行 qxqx 的 persistent(headed)重新登录淘宝后重试');
    }
    if (/^FAIL_SYS_TOKEN_EMPTY|^FAIL_SYS_ILLEGAL_ACCESS/.test(ret)) {
      // token 失败:服务器轮换 _m_h5_tk 后重取重签重试 1 次
      lastErr = new ApiError(ErrorCode.AUTH_REQUIRED, `淘宝 mtop token 失效(${ret}),请运行 qxqx 的 persistent 登录淘宝并刷新一次订单页后重试`);
      continue;
    }
    if (/^FAIL_SYS_USER_VALIDATE/.test(ret)) {
      throw new ApiError('RISK_VALIDATE', '淘宝风控拦截,请运行 qxqx 的 persistent 打开淘宝订单页人工过验证后重试', { status: 409 });
    }
    if (!/^SUCCESS/.test(ret)) {
      throw new ApiError('BROWSER_ERROR', `${prefix}_${ret || 'BAD_RESPONSE'}`, { status: 502 });
    }
    return json;
  }
  throw lastErr;
}

/** 订单列表;返回 { orders }(精简结构,字段与插件一致;订单行带 account 标注) */
async function listTaobaoOrders({ tab = 'all', account } = {}) {
  return withPage(account, 'taobao', TB_ENTRY, TB_ORIGIN, async (page) => {
    const tabCode = TB_TAB_CODE[tab] || 'all';
    const data = JSON.stringify({
      tabCode,
      page: 1,
      OrderType: 'OrderList',
      appName: 'tborder',
      appVersion: '3.0',
      condition: JSON.stringify({ directRouteToTm2Scene: '1' }),
      __needlessClearProtocol__: false,
    });
    const json = await callTaobaoMtop(page, data, `boughtList_${tabCode}_OrderList`);
    if (!json.data || !json.data.data) {
      throw new ApiError('BROWSER_ERROR', 'TB_BAD_RESPONSE: 响应缺少订单数据', { status: 502 });
    }
    return { orders: normalizeTaobaoOrders(json.data).map((o) => ({ ...o, account })) };
  });
}

/** 单账号搜索实现;无命中返回 null(不抛错) */
async function searchTaobaoInAccount(orderSn, account) {
  return withPage(account, 'taobao', TB_ENTRY, TB_ORIGIN, async (page) => {
    const sn = String(orderSn || '');
    const data = JSON.stringify({
      tabCode: 'all',
      page: 1,
      OrderType: 'OrderSearch',
      appName: 'tborder',
      appVersion: '3.0',
      condition: JSON.stringify({
        directRouteToTm2Scene: '1',
        wordType: '3',
        wordTerm: sn,
        showText: sn,
        itemTitle: sn,
        orderFilterExtParam: '{}',
      }),
      __needlessClearProtocol__: true,
    });
    const json = await callTaobaoMtop(page, data, 'boughtList_all_OrderSearch', true);
    if (!json.data || !json.data.data) return null; // 无数据
    const orders = normalizeTaobaoOrders(json.data);
    if (!orders.length) return null; // 没找到
    const o = orders[0];
    // 对齐插件 searchTaobaoOrder 返回结构(与 searchPddOrder/searchAliOrder 一致)
    return {
      orderSn: o.orderSn,
      orderAmount: o.amount,
      orderTime: o.orderTime,
      statusPrompt: o.statusPrompt,
      trackingNumber: o.trackingNumber,
      goods: o.goods,
    };
  });
}

/** 按订单号精确搜索(补全商品图/数量);未找到返回 { result: null }
 *  多账号(2026-09-13):逐账号尝试,命中即返回;登录失效/风控不中断(记录后试下一账号),
 *  全部账号登录态失败才抛 AUTH_REQUIRED;账号正常但无命中 → { result: null } */
async function searchTaobaoOrder(orderSn, accounts = []) {
  const errs = [];
  for (const account of accounts) {
    let result;
    try {
      result = await searchTaobaoInAccount(orderSn, account);
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
    throw new ApiError(ErrorCode.AUTH_REQUIRED, `淘宝全部账号搜索失败:\n${errs.join('\n')}`);
  }
  return { result: null }; // 所有账号正常,单号不存在
}

export { listTaobaoOrders, searchTaobaoOrder };
