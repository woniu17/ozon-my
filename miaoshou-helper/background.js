/**
 * 拼多多订单代理(MV3 service worker)
 * 供个人 ERP 页面(经 erp-bridge.js 中继)拉取拼多多最近的订单列表。
 *
 * 数据源:mobile.yangkeduo.com H5 订单接口 order_list_v4(2026-08 实测):
 *  - 仅依赖浏览器拼多多登录 Cookie(credentials include),无需 anti_content
 *  - 金额单位为分,返回前转元
 *  - pdduid 查询参数从 cookie pdd_user_uid 兜底获取,取不到则省略
 */

'use strict';

const PDD_API = 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4';

/** 从 cookie 兜底取 pdduid(取不到返回空串,接口主要靠 Cookie 会话) */
async function getPdduid() {
  try {
    const c = await chrome.cookies.get({ url: 'https://mobile.yangkeduo.com/', name: 'pdd_user_uid' });
    if (c && c.value) return c.value;
    const all = await chrome.cookies.getAll({ domain: 'yangkeduo.com' });
    const hit = all.find((x) => /uid/i.test(x.name) && /^\d+$/.test(x.value));
    return hit ? hit.value : '';
  } catch {
    return '';
  }
}

function toYuan(fen) {
  return (Number(fen || 0) / 100).toFixed(2);
}

/** 瘦身为 ERP 前端需要的精简结构 */
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

async function fetchPddOrders({ tab = 'all', size = 30 } = {}) {
  const pdduid = await getPdduid();
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
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`PDD_NETWORK: ${err && err.message ? err.message : err}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('PDD_AUTH_REQUIRED: 拼多多登录态失效,请在浏览器中重新登录 mobile.yangkeduo.com');
  }
  if (!resp.ok) throw new Error(`PDD_HTTP_${resp.status}`);
  const data = await resp.json();
  if (!data || !Array.isArray(data.orders)) {
    throw new Error('PDD_BAD_RESPONSE: 接口返回异常(可能触发风控)');
  }
  return normalizeOrders(data);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'PDD_GET_ORDERS') return false;
  fetchPddOrders(msg.payload || {})
    .then((orders) => sendResponse({ ok: true, orders }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // 异步 sendResponse
});
