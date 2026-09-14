/**
 * 拼多多/1688/淘宝 订单代理(MV3 service worker)
 * 供个人 ERP 页面(经 erp-bridge.js 中继)拉取最近的采购订单列表。
 *
 * 拼多多:mobile.yangkeduo.com H5 订单接口 order_list_v4(2026-08 实测):
 *  - 仅依赖浏览器拼多多登录 Cookie(credentials include),无需 anti_content
 *  - 金额单位为分,返回前转元
 *  - pdduid 查询参数从 cookie pdd_user_uid 兜底获取,取不到则省略
 *
 * 1688:h5api.m.1688.com mtop 网关 mtop.1688.trading.dataline.service(2026-08 实测):
 *  - 订单列表 serviceId=OrderListDataLineService.buyerOrderList,
 *    param={page,pageSize,tradeStatus?};tradeStatus 可选 waitsellersend/waitbuyerreceive 等
 *  - 签名 sign=md5(token&t&appKey&data),token 取 cookie _m_h5_tk 下划线前段,appKey=12574478
 *  - 响应 data.data.result 为 JSON 字符串,二次解析后 .data.data 为订单数组
 *  - 签名/token 失败时服务器会轮换 _m_h5_tk cookie,重取 cookie 重签重试一次即可
 *  - 金额单位为分,返回前转元
 *
 * 淘宝:h5api.m.taobao.com mtop 网关 mtop.taobao.order.queryboughtlistV2(2026-08 实测):
 *  - 与 1688 同一套 mtop 签名(appKey 同为 12574478,cookie 同为 _m_h5_tk,域独立)
 *  - data={tabCode:all|waitSend|waitConfirm,page,OrderType:'OrderList',appName:'tborder',...}
 *  - query 必须带 ttid=1@tbwang_windows_1.0.0#pc 与 needLogin=true,缺 ttid 报服务内部故障
 *  - 响应为卡片化组件:shopInfo_{oid}(状态/卖家)/orderItemInfo_{oid}_{iid}(商品)/
 *    orderPayment_{oid}(实付款)/orderStatus_{oid}(物流单号),需按前缀聚合还原订单
 *  - 金额为"￥1.58"格式字符串
 */

'use strict';

// ── 拼多多 ─────────────────────────────────────────────
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

/**
 * 按订单号精确搜索拼多多订单(2026-09 实测 order_list_search_v4):
 *  - type:"search" + key_word + scene:"order_list_h5" 三件套必需
 *  - 不依赖 anti_content,仅靠浏览器登录 Cookie(credentials include)
 *  - 返回 orders[] 精确匹配 1 条,含 order_goods[].thumb_url(商品图) + goods_number(数量)
 *  - 用于补全妙手采购单缺失的商品图片/数量字段
 */
async function searchPddOrder(orderSn) {
  if (!orderSn) throw new Error('PDD_SEARCH: orderSn required');
  const pdduid = await getPdduid();
  const url = pdduid
    ? `https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_search_v4?pdduid=${encodeURIComponent(pdduid)}`
    : 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_search_v4';
  const body = {
    type: 'search',
    key_word: String(orderSn),
    size: 10,
    page: 1,
    pay_channel_list: [],
    // MV3 service worker 里 navigator.userAgent 可能受限,用兜底字符串
    // 接口主验证靠 Cookie,UA 仅作占位
    userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'Mozilla/5.0',
    scene: 'order_list_h5',
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
    throw new Error(`PDD_SEARCH_NETWORK: ${err && err.message ? err.message : err}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('PDD_SEARCH_AUTH_REQUIRED: 拼多多登录态失效,请在浏览器中重新登录 mobile.yangkeduo.com');
  }
  if (!resp.ok) throw new Error(`PDD_SEARCH_HTTP_${resp.status}`);
  const data = await resp.json();
  const orders = (data && Array.isArray(data.orders)) ? data.orders : [];
  if (!orders.length) return null; // 没找到
  const o = orders[0];
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

// ── 1688 ───────────────────────────────────────────────
const ALI_API = 'https://h5api.m.1688.com/h5/mtop.1688.trading.dataline.service/1.0/';
const ALI_APP_KEY = '12574478';
const ALI_TRADE_STATUS = { all: '', unshipped: 'waitsellersend', unreceived: 'waitbuyerreceive' };

/* MD5(RFC 1321,Joseph Myers 实现;service worker 无原生 MD5,mtop 签名必需) */
var hex_chr = '0123456789abcdef';
function rhex(n) {
  var s = '', j = 0;
  for (; j < 4; j++)
    s += hex_chr.charAt((n >> (j * 8 + 4)) & 0x0f) + hex_chr.charAt((n >> (j * 8)) & 0x0f);
  return s;
}
function hex(x) {
  for (var i = 0; i < x.length; i++) x[i] = rhex(x[i]);
  return x.join('');
}
function add32(a, b) { return (a + b) & 0xffffffff; }
function cmn(q, a, b, x, s, t) {
  a = add32(add32(a, q), add32(x, t));
  return add32((a << s) | (a >>> (32 - s)), b);
}
function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
function md5cycle(x, k) {
  var a = x[0], b = x[1], c = x[2], d = x[3];
  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);
  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);
  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);
  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);
  x[0] = add32(a, x[0]);
  x[1] = add32(b, x[1]);
  x[2] = add32(c, x[2]);
  x[3] = add32(d, x[3]);
}
function md5blk(s) {
  var md5blks = [], i;
  for (i = 0; i < 64; i += 4) {
    md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
  }
  return md5blks;
}
function md51(s) {
  var n = s.length, state = [1732584193, -271733879, -1732584194, 271733878], i;
  for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
  s = s.substring(i - 64);
  var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}
/** UTF-8 感知的 MD5(中文商品名等需先转 UTF-8 字节再摘要) */
function md5(s) {
  return hex(md51(unescape(encodeURIComponent(s))));
}

/** 从 cookie 取 mtop token(_m_h5_tk 下划线前 32 位 hex) */
async function getAliToken() {
  try {
    const c = await chrome.cookies.get({ url: 'https://h5api.m.1688.com/', name: '_m_h5_tk' });
    return (c && c.value) ? c.value.split('_')[0] : '';
  } catch {
    return '';
  }
}

/** 瘦身为 ERP 前端需要的精简结构(与 PDD 结构对齐) */
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

async function fetch1688Orders({ tab = 'all', size = 30 } = {}) {
  // 通过 1688 页面的 content script 发请求(content script 的 fetch 自动带 referer/origin,
  // 避免 service worker 直接 fetch 因缺少 referer 被 baxia 风控拦截)
  // 1. 查找已打开的 1688 订单页
  const tabs = await chrome.tabs.query({ url: 'https://air.1688.com/app/ctf-page/trade-order-list/*' });
  let aliTab = tabs.find((t) => t.url && t.url.includes('buyer-order-list'));
  if (!aliTab) {
    // 没找到,自动打开一个隐藏标签页(不激活)
    aliTab = await chrome.tabs.create({
      url: 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?page=1&pageSize=10',
      active: false,
    });
    // 等待页面加载 + content script 注入
    await new Promise((r) => setTimeout(r, 8000));
  }
  // 2. 通过 chrome.tabs.sendMessage 转发到 content script
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(aliTab.id, {
      type: 'ALI_GET_ORDERS_IN_PAGE',
      payload: { tab, size },
    }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: `1688页面桥接失败:${chrome.runtime.lastError.message}。请手动打开 1688 订单页后重试` });
      } else {
        resolve(resp || { ok: false, error: '1688页面无响应' });
      }
    });
  });
}

/**
 * 按订单号精确搜索 1688 订单(补全商品图/数量)
 * 与 fetch1688Orders 同样通过 content script 在页面上下文发请求,
 * 消息类型 ALI_SEARCH_ORDER_IN_PAGE,返回结构对齐 searchPddOrder
 */
async function searchAliOrder(orderSn) {
  if (!orderSn) throw new Error('ALI_SEARCH: orderSn required');
  const tabs = await chrome.tabs.query({ url: 'https://air.1688.com/app/ctf-page/trade-order-list/*' });
  let aliTab = tabs.find((t) => t.url && t.url.includes('buyer-order-list'));
  if (!aliTab) {
    aliTab = await chrome.tabs.create({
      url: 'https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?page=1&pageSize=10',
      active: false,
    });
    await new Promise((r) => setTimeout(r, 8000));
  }
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(aliTab.id, {
      type: 'ALI_SEARCH_ORDER_IN_PAGE',
      payload: { orderSn },
    }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: `1688页面桥接失败:${chrome.runtime.lastError.message}。请手动打开 1688 订单页后重试` });
      } else {
        resolve(resp || { ok: false, error: '1688页面无响应' });
      }
    });
  });
}

// ── 淘宝 ───────────────────────────────────────────────
const TB_API = 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/';
const TB_APP_KEY = '12574478';
const TB_TAB_CODE = { all: 'all', unshipped: 'waitSend', unreceived: 'waitConfirm' };

/** 从 cookie 取淘宝 mtop token(_m_h5_tk 下划线前 32 位 hex,与 1688 的独立) */
async function getTbToken() {
  try {
    const c = await chrome.cookies.get({ url: 'https://h5api.m.taobao.com/', name: '_m_h5_tk' });
    return (c && c.value) ? c.value.split('_')[0] : '';
  } catch {
    return '';
  }
}

/** "￥1.58" → "1.58" */
function stripYuan(s) {
  return String(s || '').replace(/[^\d.]/g, '') || '0';
}

/** 卡片化组件聚合还原订单(与 PDD/1688 的精简结构对齐) */
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

async function fetchTaobaoOrders({ tab = 'all' } = {}) {
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
  let lastErr = null;
  // 与 1688 相同:token 失败时服务器轮换 _m_h5_tk cookie,重取后重签(最多 2 次)
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getTbToken();
    const t = String(Date.now());
    const sign = md5(`${token}&${t}&${TB_APP_KEY}&${data}`);
    const body = new URLSearchParams({
      jsv: '2.7.2', appKey: TB_APP_KEY, t, sign, v: '1.0',
      ecode: '1', timeout: '8000', dataType: 'json', valueType: 'original',
      ttid: '1@tbwang_windows_1.0.0#pc', needLogin: 'true',
      type: 'originaljson', isHttps: '1', needRetry: 'true',
      api: 'mtop.taobao.order.queryboughtlistV2',
      __customTag__: `boughtList_${tabCode}_OrderList`,
      preventFallback: 'true', data,
    }).toString();
    let resp;
    try {
      resp = await fetch(TB_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      throw new Error(`TB_NETWORK: ${err && err.message ? err.message : err}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('TB_AUTH_REQUIRED: 淘宝登录态失效,请在浏览器中重新登录淘宝');
    }
    if (!resp.ok) throw new Error(`TB_HTTP_${resp.status}`);
    const json = await resp.json().catch(() => null);
    if (!json) throw new Error('TB_BAD_RESPONSE: 接口返回异常(可能触发风控)');
    const ret = (Array.isArray(json.ret) && json.ret[0]) || '';
    if (/^FAIL_SYS_TOKEN_EMPTY|^FAIL_SYS_ILLEGAL_ACCESS/.test(ret)) {
      lastErr = new Error(`TB_${ret}: 请确认浏览器已登录淘宝并刷新一次订单页`);
      continue;
    }
    if (!/^SUCCESS/.test(ret)) throw new Error(`TB_${ret || 'BAD_RESPONSE'}`);
    if (!json.data || !json.data.data) throw new Error('TB_BAD_RESPONSE: 响应缺少订单数据');
    return normalizeTaobaoOrders(json.data);
  }
  throw lastErr || new Error('TB_BAD_RESPONSE');
}

/**
 * 按订单号精确搜索淘宝订单(补全商品图/数量)
 * 与列表接口同一个 mtop API,仅 data 字段差异:
 *   OrderType: 'OrderSearch'(列表为 'OrderList')
 *   condition: 加 wordType='3' + wordTerm/showText/itemTitle=订单号
 * 返回结构对齐 searchPddOrder/searchAliOrder: { orderSn, goods, ... }
 */
async function searchTaobaoOrder(orderSn) {
  if (!orderSn) throw new Error('TB_SEARCH: orderSn required');
  const sn = String(orderSn);
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
  let lastErr = null;
  // token 失败时服务器轮换 _m_h5_tk cookie,重取后重签(最多 2 次)
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getTbToken();
    const t = String(Date.now());
    const sign = md5(`${token}&${t}&${TB_APP_KEY}&${data}`);
    const body = new URLSearchParams({
      jsv: '2.7.2', appKey: TB_APP_KEY, t, sign, v: '1.0',
      ecode: '1', timeout: '8000', dataType: 'json', valueType: 'original',
      ttid: '1@tbwang_windows_1.0.0#pc', needLogin: 'true',
      type: 'originaljson', isHttps: '1', needRetry: 'true',
      api: 'mtop.taobao.order.queryboughtlistV2',
      __customTag__: 'boughtList_all_OrderSearch',
      preventFallback: 'true', data,
    }).toString();
    let resp;
    try {
      resp = await fetch(TB_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      throw new Error(`TB_SEARCH_NETWORK: ${err && err.message ? err.message : err}`);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('TB_AUTH_REQUIRED: 淘宝登录态失效,请在浏览器中重新登录淘宝');
    }
    if (!resp.ok) throw new Error(`TB_SEARCH_HTTP_${resp.status}`);
    const json = await resp.json().catch(() => null);
    if (!json) throw new Error('TB_SEARCH_BAD_RESPONSE: 接口返回异常(可能触发风控)');
    const ret = (Array.isArray(json.ret) && json.ret[0]) || '';
    if (/^FAIL_SYS_TOKEN_EMPTY|^FAIL_SYS_ILLEGAL_ACCESS/.test(ret)) {
      lastErr = new Error(`TB_${ret}: 请确认浏览器已登录淘宝并刷新一次订单页`);
      continue;
    }
    if (/^FAIL_SYS_USER_VALIDATE/.test(ret)) {
      throw new Error('TB_VALIDATE: 淘宝风控拦截,请打开淘宝订单页过验证后重试');
    }
    if (!/^SUCCESS/.test(ret)) throw new Error(`TB_SEARCH_${ret || 'BAD_RESPONSE'}`);
    if (!json.data || !json.data.data) return null; // 无数据
    const orders = normalizeTaobaoOrders(json.data);
    if (!orders.length) return null; // 没找到
    const o = orders[0];
    // 对齐 searchPddOrder/searchAliOrder 返回结构
    return {
      orderSn: o.orderSn,
      orderAmount: o.amount,
      orderTime: o.orderTime,
      statusPrompt: o.statusPrompt,
      trackingNumber: o.trackingNumber,
      goods: o.goods,
    };
  }
  throw lastErr || new Error('TB_SEARCH_BAD_RESPONSE');
}

// ── 妙手 ERP 订单提取 ─────────────────────────────────────
// 在妙手历史订单页 content script(ms-orders-extract.js)中翻页提取
// 设计文档: docs/妙手订单数据提取-功能设计.md
async function fetchMiaoshouOrders({ maxPages } = {}) {
  // 查找已打开的妙手历史订单页
  const tabs = await chrome.tabs.query({ url: 'https://erp.91miaoshou.com/order/package/all*' });
  let msTab = tabs[0];
  if (!msTab) {
    // 没找到,自动打开一个隐藏标签页(不激活)
    msTab = await chrome.tabs.create({
      url: 'https://erp.91miaoshou.com/order/package/all?appPackageTab=all',
      active: false,
    });
    // 等待页面加载 + content script 注入
    await new Promise((r) => setTimeout(r, 8000));
  }
  // 通过 chrome.tabs.sendMessage 转发到 content script
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      msTab.id,
      { type: 'MS_EXTRACT_ORDERS', payload: { maxPages } },
      (resp) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: `妙手页面桥接失败:${chrome.runtime.lastError.message}。请手动打开妙手历史订单页后重试`,
          });
        } else {
          resolve(resp || { ok: false, error: '妙手页面无响应' });
        }
      }
    );
  });
}

// ── ERP 页面 tab 登记(妙手提取事件转发目标)──────────────
// content script 收不到 chrome.runtime.sendMessage 广播(只达扩展自身页面),
// 必须用 chrome.tabs.sendMessage 触达。erp-bridge 发 MS_GET_ORDERS 时登记
// 其所在 tab,MS_PROGRESS/BATCH/DONE/ERROR 事件按登记列表转发。
// 存 chrome.storage.session,防 MV3 service worker 空闲重启后丢失。
async function getErpTabIds() {
  try {
    const v = await chrome.storage.session.get('msErpTabIds');
    return v.msErpTabIds || [];
  } catch { return []; }
}
async function addErpTabId(tabId) {
  try {
    const ids = await getErpTabIds();
    if (!ids.includes(tabId)) {
      ids.push(tabId);
      await chrome.storage.session.set({ msErpTabIds: ids });
    }
  } catch { /* ignore */ }
}
async function forwardMsEventToErpTabs(msg) {
  const ids = await getErpTabIds();
  for (const id of ids) {
    try {
      await chrome.tabs.sendMessage(id, msg);
    } catch {
      // tab 已关闭或未注入 erp-bridge,清理失效登记
      try {
        const rest = (await getErpTabIds()).filter((i) => i !== id);
        await chrome.storage.session.set({ msErpTabIds: rest });
      } catch { /* ignore */ }
    }
  }
}

// ── PDD 登录同步(2026-09-14,登录权威源=用户日常浏览器)──────
// 拼多多单点登录:cloakbrowser 登录会被用户浏览器登录互踢。
// 方案:用户只在日常浏览器登录 PDD,本扩展把 cookie 同步给 ERP 后台,
//       后端注入 cloakbrowser(ERP 侧永不登录)。
// 链路:popup → PDD_POPUP_SYNC → 采 cookie → tabs.sendMessage(ERP_BRIDGE_REQUEST)
//       → erp-bridge(content script)→ ERP 页面 → POST /platform-orders/pdd-sync-cookies(JWT)
//       → 结果经 ERP_BRIDGE_RESPONSE 回传 → sendResponse 回 popup
// 设计文档: docs/PDD登录同步-概要设计.md §4.2

// 2026-09-14 实测 PDD 已弃用 PDDAccessToken cookie,会话仅靠 pdd_user_id + 其余
// 会话 cookie(api_uid/pdd_vds 等),Apollo API 亦仅需 Cookie 会话,无需 AccessToken 头
const PDD_REQUIRED_COOKIES = ['pdd_user_id'];
// ERP 页面 origin(erp-bridge content script 所在;tabs.query url 匹配需 host 权限)
const ERP_TAB_URL_PATTERNS = [
  'http://localhost:3001/admin*',
  'http://localhost:5173/admin*',
  'https://yochylin.com/admin*',
  'https://yochylin.com:17443/admin*',
  'https://2.tencent.yochylin.com:17443/admin*',
];

// ── ERP 后端选择(2026-09-15,参考 qx-ozon ERP_BACKEND_CANDIDATES)──
// 妙手助手经"ERP 页面桥"与后端通信(页面持 JWT),选中后端 = 只向该 origin
// 的 erp-bridge 页面发桥请求;'auto' 保持广播全部已打开 ERP 页面(旧行为)。
// 选择持久化在 chrome.storage.local[ERP_BACKEND_STORAGE_KEY]。
const ERP_BACKEND_CANDIDATES = [
  { label: '自动（第一个应答的已打开 ERP 页面）', url: 'auto' },
  { label: '本地 (localhost:3001)', url: 'http://localhost:3001' },
  { label: '本地 dev (localhost:5173)', url: 'http://localhost:5173' },
  { label: '远程 (2.tencent.yochylin.com)', url: 'https://2.tencent.yochylin.com:17443' },
  { label: '远程 (yochylin.com)', url: 'https://yochylin.com:17443' },
  { label: '远程 (yochylin.com 443)', url: 'https://yochylin.com' },
];
const ERP_BACKEND_STORAGE_KEY = 'erpBackendChoice';

/** 读当前 ERP 后端选择('auto'=未选/自动) */
async function getErpBackendChoice() {
  const v = await chrome.storage.local.get(ERP_BACKEND_STORAGE_KEY).catch(() => ({}));
  const choice = v && v[ERP_BACKEND_STORAGE_KEY];
  return choice && ERP_BACKEND_CANDIDATES.some((c) => c.url === choice) ? choice : 'auto';
}

/** 本次桥请求要查询的 tab 模式列表(选中具体后端时只查该 origin) */
async function getErpTabPatterns() {
  const choice = await getErpBackendChoice();
  if (choice !== 'auto') return [choice + '/admin*'];
  return ERP_TAB_URL_PATTERNS;
}

/** PDD 域判定(yangkeduo.com / pinduoduo.com 及子域) */
function isPddDomain(domain) {
  return /(^|\.)(yangkeduo\.com|pinduoduo\.com)$/i.test((domain || '').replace(/^\./, ''));
}

/** PDD 关键会话 cookie 名(逐名 get 兜底用,与页面 document.cookie 实测清单对齐) */
const PDD_SESSION_COOKIE_NAMES = [
  'pdd_user_id', 'pdd_user_uin', 'pdd_vds', 'api_uid', '_nano_fp',
  'njrpl', 'dilx', 'webp', 'avif', 'jrpl', 'PDDAccessToken',
];

/** 采集 PDD 会话 cookie(三路查询合并 + 逐名 get 兜底)
 *  2026-09-14 Edge 153 实测:getAll 的 url/domain 过滤只返回旧登录遗留的
 *  jrpl/PDDAccessToken 两条,当前登录的 9 条(pdd_user_id/pdd_vds 等)全部
 *  漏掉;而 cookies.get({url,name}) 逐名查询能拿到。故四路合并:
 *  1) domain 过滤(域前导点 cookie)
 *  2) url 过滤(host-only cookie)
 *  3) getAll({}) 全量 + 本地 PDD 域过滤(绕过过滤实现怪癖)
 *  4) 关键名逐名 get 补漏(实测唯一稳定拿到当前会话的途径)
 *  同键(name|domain|path)后写入者覆盖先写入者 → 逐名 get 的活会话值优先 */
async function getPddCookies() {
  const [byDomain, byUrl, allAll] = await Promise.all([
    chrome.cookies.getAll({ domain: 'yangkeduo.com' }),
    chrome.cookies.getAll({ url: 'https://mobile.yangkeduo.com/' }),
    chrome.cookies.getAll({}).catch(() => []),
  ]);
  const byName = [];
  for (const n of PDD_SESSION_COOKIE_NAMES) {
    try {
      const c = await chrome.cookies.get({ url: 'https://mobile.yangkeduo.com/', name: n });
      if (c) byName.push(c);
    } catch { /* ignore */ }
  }
  const merged = [
    ...byDomain,
    ...byUrl,
    ...(allAll || []).filter((c) => c && isPddDomain(c.domain)),
    ...byName,
  ];
  const map = new Map(); // name|domain|path → cookie
  for (const c of merged) {
    if (!c) continue;
    map.set(`${c.name}|${c.domain}|${c.path}`, c);
  }
  return [...map.values()];
}

/** 读浏览器 PDD 登录态(必需 cookie 存在性 + 昵称探测;探测失败不阻塞)
 *  2026-09-14 PDD 已弃用 PDDAccessToken,会话仅靠 Cookie;Apollo user/me
 *  仅需 Cookie 会话(credentials:include),无需 AccessToken 头 */
async function getPddLoginState() {
  const all = await getPddCookies();
  const get = (n) => (all.find((c) => c.name === n) || {}).value || '';
  const uid = get('pdd_user_id');
  if (!uid) return { loggedIn: false };
  // 昵称:apollo user/me(妙手插件同款;失败留空)
  let nickname = '';
  try {
    const resp = await fetch(
      `https://mobile.yangkeduo.com/proxy/api/api/apollo/v3/user/me?pdduid=${encodeURIComponent(uid)}`,
      { credentials: 'include' }
    );
    if (resp.ok) {
      const j = await resp.json().catch(() => null);
      nickname = (j && (j.nickname || (j.user_info && j.user_info.nickname))) || '';
    }
  } catch { /* ignore */ }
  return { loggedIn: true, uid, nickname };
}

/** 页面桥请求(reqId 关联应答;挂起回调放模块级 Map,SW 存活期内有效) */
const pendingBridgeRequests = new Map(); // reqId → resolve
let bridgeSeq = 1;

/** 向 ERP 页面(erq-bridge 所在 tab)发桥请求,等应答 */
async function requestErpPage(requestType, payload, timeoutMs = 20 * 1000) {
  const patterns = await getErpTabPatterns();
  const tabs = await chrome.tabs.query({ url: patterns });
  if (!tabs.length) {
    // 指定了后端时明确提示,避免误以为要开别的 ERP
    const where = patterns.length === 1 ? `(${patterns[0].replace('/admin*', '')})` : '';
    return {
      ok: false,
      error: where
        ? `未打开所选后端的 ERP 页面${where},请先打开其订单处理页或切回"自动"`
        : '未找到打开的 ERP 页面,请先打开 ERP 订单处理页',
    };
  }
  const reqId = `pddsync-${Date.now()}-${bridgeSeq++}`;
  const promise = new Promise((resolve) => {
    pendingBridgeRequests.set(reqId, resolve);
    setTimeout(() => {
      if (pendingBridgeRequests.has(reqId)) {
        pendingBridgeRequests.delete(reqId);
        resolve({ ok: false, error: 'ERP 页面响应超时' });
      }
    }, timeoutMs).unref?.();
  });
  // 逐 tab 广播(多开时第一个应答者胜出)
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, { type: 'ERP_BRIDGE_REQUEST', reqId, requestType, payload });
    } catch { /* 该 tab 无 erp-bridge(如刚加载),试下一个 */ }
  }
  return promise;
}

/** ERP 账号列表(供 popup 下拉;页面桥获取 + storage.local 缓存兜底,按后端隔离缓存) */
async function getErpAccounts() {
  const scope = await getErpBackendChoice();
  const cacheKey = `pddErpAccounts:${scope}`;
  const r = await requestErpPage('PDD_GET_ACCOUNTS', null, 10 * 1000);
  if (r?.ok && Array.isArray(r.accounts) && r.accounts.length) {
    await chrome.storage.local.set({ [cacheKey]: r.accounts }).catch(() => {});
    return { accounts: r.accounts };
  }
  // ERP 页面未开:用上次缓存
  const v = await chrome.storage.local.get(cacheKey).catch(() => ({}));
  const cached = v[cacheKey] || [];
  if (cached.length) return { accounts: cached, cached: true };
  return { accounts: [], error: r?.error || '请先打开 ERP 页面(账号列表来自 ERP)' };
}

/** 执行 PDD cookie 同步(采 cookie → ERP 页面桥 → 后端) */
async function syncPddCookiesToErp(account) {
  if (!account) return { ok: false, error: '请选择要同步的 ERP 账号' };
  const all = await getPddCookies();
  const names = new Set(all.map((c) => c && c.name));
  const missing = PDD_REQUIRED_COOKIES.filter((n) => !names.has(n));
  if (missing.length) {
    return { ok: false, error: `拼多多未登录(缺 ${missing.join(', ')}),请先在本浏览器登录 mobile.yangkeduo.com` };
  }
  const uid = (all.find((c) => c.name === 'pdd_user_id') || {}).value || '';
  return requestErpPage('PDD_SYNC_COOKIES', { account, uid, cookies: all });
}

// ── 消息路由(erp-bridge.js 中继转发)────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'PDD_DEBUG') {
    // 调试:返回 cookie 查询与权限的完整诊断(排查"未登录"误报)
    (async () => {
      const diag = { sw: 'alive', ua: navigator.userAgent };
      try {
        diag.permHost = await chrome.permissions.contains({ origins: ['https://*.yangkeduo.com/*'] });
      } catch (e) { diag.permHost = 'ERR:' + e.message; }
      try {
        const byDomain = await chrome.cookies.getAll({ domain: 'yangkeduo.com' });
        diag.byDomain = { count: byDomain.length, names: byDomain.map((c) => c.name) };
      } catch (e) { diag.byDomain = 'ERR:' + e.message; }
      try {
        const byUrl = await chrome.cookies.getAll({ url: 'https://mobile.yangkeduo.com/' });
        diag.byUrl = { count: byUrl.length, names: byUrl.map((c) => c.name), detail: byUrl.map((c) => ({ name: c.name, domain: c.domain })) };
      } catch (e) { diag.byUrl = 'ERR:' + e.message; }
      // 分区 cookie(CHIPS)假设验证:带 partitionKey 的查询
      try {
        const part = await chrome.cookies.getAll({ url: 'https://mobile.yangkeduo.com/', partitionKey: { topLevelSite: 'https://mobile.yangkeduo.com' } });
        diag.byUrlPartitioned = { count: part.length, names: part.map((c) => c.name) };
      } catch (e) { diag.byUrlPartitioned = 'ERR:' + e.message; }
      try {
        const partAny = await chrome.cookies.getAll({ url: 'https://mobile.yangkeduo.com/', partitionKey: {} });
        diag.byUrlPartitionAny = { count: partAny.length, names: partAny.map((c) => c.name) };
      } catch (e) { diag.byUrlPartitionAny = 'ERR:' + e.message; }
      try {
        const g = await chrome.cookies.get({ url: 'https://mobile.yangkeduo.com/', name: 'pdd_user_id' });
        diag.getPddUserIdPlain = g ? { domain: g.domain, partitionKey: g.partitionKey || null } : null;
      } catch (e) { diag.getPddUserIdPlain = 'ERR:' + e.message; }
      try {
        const gp = await chrome.cookies.get({ url: 'https://mobile.yangkeduo.com/', name: 'pdd_user_id', partitionKey: { topLevelSite: 'https://mobile.yangkeduo.com' } });
        diag.getPddUserIdPartitioned = gp ? { domain: gp.domain, value: gp.value } : null;
      } catch (e) { diag.getPddUserIdPartitioned = 'ERR:' + e.message; }
      try {
        diag.loginState = await getPddLoginState();
      } catch (e) { diag.loginState = 'ERR:' + e.message; }
      // 诊断增强(2026-09-14):getAll url 过滤漏 cookie 根因排查
      // A. 全量 getAll({}) 本地过滤 yangkeduo/pinduoduo(绕过 url/domain 过滤)
      try {
        const allAll = await chrome.cookies.getAll({});
        diag.allTotal = allAll.length;
        diag.allYkd = allAll
          .filter((c) => /yangkeduo|pinduoduo/.test(c.domain || ''))
          .map((c) => ({ name: c.name, domain: c.domain, path: c.path, hostOnly: !!c.hostOnly, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite, session: !!c.session, exp: c.expirationDate || null, pk: c.partitionKey || null }));
      } catch (e) { diag.allYkd = 'ERR:' + e.message; }
      // B. 逐名 get 完整属性(对照 A,验证 get 与 getAll 行为差异)
      try {
        const names = ['api_uid', '_nano_fp', 'njrpl', 'dilx', 'webp', 'avif', 'pdd_user_id', 'pdd_user_uin', 'pdd_vds', 'jrpl', 'PDDAccessToken'];
        diag.getByNames = {};
        for (const n of names) {
          const c = await chrome.cookies.get({ url: 'https://mobile.yangkeduo.com/', name: n });
          diag.getByNames[n] = c
            ? { domain: c.domain, path: c.path, hostOnly: !!c.hostOnly, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite, session: !!c.session, exp: c.expirationDate || null, pk: c.partitionKey || null, vlen: (c.value || '').length }
            : null;
        }
      } catch (e) { diag.getByNames = 'ERR:' + e.message; }
      sendResponse(diag);
    })();
    return true;
  }
  if (msg.type === 'GET_ERP_BACKENDS') {
    // popup 渲染后端下拉:候选列表 + 当前选择
    (async () => {
      const selected = await getErpBackendChoice();
      sendResponse({ ok: true, candidates: ERP_BACKEND_CANDIDATES, selected });
    })();
    return true;
  }
  if (msg.type === 'SET_ERP_BACKEND') {
    // popup 切换后端:校验候选 + 持久化(桥请求/账号缓存即刻按新选择走)
    (async () => {
      const url = msg.url;
      if (!ERP_BACKEND_CANDIDATES.some((c) => c.url === url)) {
        sendResponse({ ok: false, error: '无效的 ERP 后端地址' });
        return;
      }
      await chrome.storage.local.set({ [ERP_BACKEND_STORAGE_KEY]: url }).catch(() => {});
      sendResponse({ ok: true, selected: url });
    })();
    return true;
  }
  if (msg.type === 'PDD_LOGIN_STATE') {
    // popup 打开时探测浏览器 PDD 登录态
    getPddLoginState()
      .then((st) => sendResponse(st))
      .catch((err) => sendResponse({ loggedIn: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  }
  if (msg.type === 'PDD_GET_ACCOUNTS') {
    // popup 账号下拉数据(ERP 页面桥 + 缓存兜底)
    getErpAccounts()
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ accounts: [], error: String(err && err.message ? err.message : err) }));
    return true;
  }
  if (msg.type === 'PDD_POPUP_SYNC') {
    // 同步浏览器 PDD cookie 到 ERP 后台(经 ERP 页面桥)
    syncPddCookiesToErp(msg.payload && msg.payload.account)
      .then((r) => sendResponse(r || { ok: false, error: '同步无响应' }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }
  if (msg.type === 'ERP_BRIDGE_RESPONSE') {
    // erp-bridge 转发的页面应答(关联挂起的桥请求)
    const resolve = pendingBridgeRequests.get(msg.reqId);
    if (resolve) {
      pendingBridgeRequests.delete(msg.reqId);
      resolve(msg.data || { ok: false, error: '页面无应答数据' });
    }
    return false;
  }
  if (msg.type === 'PDD_GET_ORDERS') {
    fetchPddOrders(msg.payload || {})
      .then((orders) => sendResponse({ ok: true, orders }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  }
  if (msg.type === 'PDD_SEARCH_ORDER') {
    // 按采购单号精确搜索,补全商品图/数量字段
    searchPddOrder(msg.payload && msg.payload.orderSn)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  }
  if (msg.type === 'ALI_GET_ORDERS') {
    fetch1688Orders(msg.payload || {})
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  }
  if (msg.type === 'ALI_SEARCH_ORDER') {
    // 按采购单号精确搜索,补全商品图/数量字段
    searchAliOrder(msg.payload && msg.payload.orderSn)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  }
  if (msg.type === 'TB_GET_ORDERS') {
    fetchTaobaoOrders(msg.payload || {})
      .then((orders) => sendResponse({ ok: true, orders }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  }
  if (msg.type === 'TB_SEARCH_ORDER') {
    // 按采购单号精确搜索,补全商品图/数量字段
    searchTaobaoOrder(msg.payload && msg.payload.orderSn)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  }
  if (msg.type === 'MS_GET_ORDERS') {
    // 登记 ERP 页面 tab(content script 只能经 tabs.sendMessage 触达,
    // 后续 MS_PROGRESS/MS_BATCH/MS_DONE/MS_ERROR 事件转发到此 tab)
    if (_sender.tab?.id != null) addErpTabId(_sender.tab.id);
    fetchMiaoshouOrders(msg.payload || {})
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  }
  // 妙手提取进度/批次上报(content script → background → 转发给 erp-bridge 所在 tab)
  // 注意:runtime.sendMessage 广播到不了 content script,必须 tabs.sendMessage
  // MS_BATCH: 每页一批订单;MS_DONE/MS_ERROR: 结束/失败;MS_PROGRESS: 翻页进度
  if (msg.type === 'MS_PROGRESS' || msg.type === 'MS_BATCH' || msg.type === 'MS_DONE' || msg.type === 'MS_ERROR') {
    forwardMsEventToErpTabs(msg);
    return false;
  }
  return false;
});
