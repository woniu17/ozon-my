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

// ── 消息路由(erp-bridge.js 中继转发)────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'PDD_GET_ORDERS') {
    fetchPddOrders(msg.payload || {})
      .then((orders) => sendResponse({ ok: true, orders }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  }
  if (msg.type === 'ALI_GET_ORDERS') {
    fetch1688Orders(msg.payload || {})
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
