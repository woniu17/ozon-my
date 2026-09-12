// 拼多多订单适配器(2026-09,平台订单获取 M1)
// 语义基准:miaoshou-helper/background.js fetchPddOrders / searchPddOrder(逐字段对齐)
//
// 接口(2026-09 实测语义):
//  - mobile.yangkeduo.com H5 order_list_v4(列表) / order_list_search_v4(按订单号搜索)
//  - 仅依赖浏览器拼多多登录 Cookie(credentials include),无需 anti_content
//  - 金额单位为分,返回前转元;pdduid 查询参数从 cookie pdd_user_uid 兜底,取不到则省略
//  - 搜索:type:"search" + key_word + scene:"order_list_h5" 三件套必需
//
// 执行位置:页面先导航到 mobile.yangkeduo.com(同源 fetch 才带凭证 cookie + referer),
// 再 page.evaluate 单参数对象执行 fetch(与插件 SW 裸 fetch 相比是能力超集)

import { ApiError, ErrorCode } from '../../../utils/error-codes.js';
import { withPage } from '../browser-manager.js';

const PDD_API = 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4';
const PDD_SEARCH_API = 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_search_v4';
const PDD_ENTRY = 'https://mobile.yangkeduo.com/';
const PDD_ORIGIN = 'https://mobile.yangkeduo.com';

function toYuan(fen) {
  return (Number(fen || 0) / 100).toFixed(2);
}

/** 瘦身为 ERP 前端需要的精简结构(与插件 background.js normalizeOrders 逐字段一致) */
function normalizeOrders(data) {
  const orders = (data && Array.isArray(data.orders)) ? data.orders : [];
  return orders.map((o) => ({
    orderSn: o.order_sn || '',
    parentOrderSn: o.parent_order_sn || '',
    statusPrompt: o.order_status_prompt || '',
    payStatus: o.pay_status ?? 0,           // 0=未付 2=已付
    shippingStatus: o.shipping_status ?? 0, // 0=未发 1=已发
    amount: toYuan(o.order_amount),
    trackingNumber: o.tracking_number || '',
    orderTime: o.order_time || 0,
    mallName: (o.mall && o.mall.mall_name) || '',
    goods: (o.order_goods || []).map((g) => ({
      goodsName: g.goods_name || '',
      spec: g.spec || '',
      price: toYuan(g.goods_price),
      number: g.goods_number || 1,
      thumbUrl: g.thumb_url || '',
    })),
  }));
}

/** 搜索结果结构对齐插件 searchPddOrder 返回 */
function normalizeSearchOrder(o) {
  return {
    orderSn: o.order_sn || '',
    orderAmount: toYuan(o.order_amount),
    orderTime: o.order_time || 0,
    statusPrompt: o.order_status_prompt || '',
    trackingNumber: o.tracking_number || '',
    goods: (o.order_goods || []).map((g) => ({
      goodsName: g.goods_name || '',
      spec: g.spec || '',
      price: toYuan(g.goods_price),
      number: g.goods_number || 1,
      thumbUrl: g.thumb_url || '',
    })),
  };
}

/** 页面上下文 fetch(单参数对象;credentials include 自动带登录 cookie + referer) */
async function fetchInPage(page, url, body) {
  const r = await page.evaluate(async (arg) => {
    try {
      const resp = await fetch(arg.url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(arg.body),
      });
      let json = null;
      try { json = await resp.json(); } catch { /* 非 JSON 响应 */ }
      return { status: resp.status, httpOk: resp.ok, json };
    } catch (e) {
      return { networkError: String((e && e.message) || e) };
    }
  }, { url, body });
  if (r && r.networkError) {
    throw new ApiError('BROWSER_ERROR', `页面 fetch 网络错误: ${r.networkError}`, { status: 502 });
  }
  return r || {};
}

/** 从平台域 cookie 兜底取 pdduid(取不到返回空串,接口主要靠 Cookie 会话)
 *  2026-09 实测 .linqx-profile 上 uid cookie 名为 pdd_user_id(插件侧文档写的
 *  pdd_user_uid 未出现),两个候选都匹配 */
async function getPdduid(page) {
  try {
    const cookies = await page.context().cookies(`${PDD_ORIGIN}/`);
    const hit = cookies.find((c) =>
      (c.name === 'pdd_user_uid' || c.name === 'pdd_user_id') && /^\d+$/.test(c.value || ''));
    return hit ? hit.value : '';
  } catch { return ''; }
}

/** 统一错误映射(与插件错误文案语义对齐) */
function mapResponse(r, prefix) {
  if (r.status === 401 || r.status === 403) {
    throw new ApiError(ErrorCode.AUTH_REQUIRED, '拼多多登录态失效,请运行 qxqx 的 persistent 登录 mobile.yangkeduo.com 后重试');
  }
  if (!r.httpOk) {
    throw new ApiError('BROWSER_ERROR', `${prefix}_HTTP_${r.status}: 拼多多接口返回异常`, { status: 502 });
  }
  if (!r.json || typeof r.json !== 'object') {
    throw new ApiError('BROWSER_ERROR', `${prefix}_BAD_RESPONSE: 接口返回异常(可能触发风控)`, { status: 502 });
  }
  return r.json;
}

/** 订单列表;返回 { orders }(精简结构,字段与插件一致) */
async function listPddOrders({ tab = 'all', size = 30 } = {}) {
  return withPage('pdd', PDD_ENTRY, PDD_ORIGIN, async (page) => {
    const pdduid = await getPdduid(page);
    const url = pdduid ? `${PDD_API}?pdduid=${encodeURIComponent(pdduid)}` : PDD_API;
    const body = {
      type: tab === 'unreceived' ? 'unreceived' : 'all',
      page: 1,
      origin_host_name: 'mobile.yangkeduo.com',
      scene: 'order_list_h5',
      page_from: 0,
      front_env: 1,
      pay_front_supports: [],
      size: Math.min(Number(size) || 30, 50),
      offset: '',
    };
    const r = await fetchInPage(page, url, body);
    const data = mapResponse(r, 'PDD');
    if (!Array.isArray(data.orders)) {
      throw new ApiError('BROWSER_ERROR', 'PDD_BAD_RESPONSE: 接口返回异常(可能触发风控)', { status: 502 });
    }
    return { orders: normalizeOrders(data) };
  });
}

/** 按订单号精确搜索(补全商品图/数量);未找到返回 { result: null } */
async function searchPddOrder(orderSn) {
  return withPage('pdd', PDD_ENTRY, PDD_ORIGIN, async (page) => {
    const pdduid = await getPdduid(page);
    const url = pdduid
      ? `${PDD_SEARCH_API}?pdduid=${encodeURIComponent(pdduid)}`
      : PDD_SEARCH_API;
    const body = {
      type: 'search',
      key_word: String(orderSn),
      size: 10,
      page: 1,
      pay_channel_list: [],
      // 接口主验证靠 Cookie,UA 仅作占位(对齐插件注释)
      userAgent: 'Mozilla/5.0',
      scene: 'order_list_h5',
    };
    const r = await fetchInPage(page, url, body);
    const data = mapResponse(r, 'PDD_SEARCH');
    const orders = (data && Array.isArray(data.orders)) ? data.orders : [];
    if (!orders.length) return { result: null };
    return { result: normalizeSearchOrder(orders[0]) };
  });
}

export { listPddOrders, searchPddOrder };
