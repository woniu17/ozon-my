/**
 * 1688 页面桥接(content script,隔离世界)
 * 注入到 air.1688.com 订单页,在页面域名的上下文中发 fetch 请求。
 *
 * 为什么需要这个:service worker 的 fetch 不带 referer/origin 头,
 * 1688 的 baxia 风控会返回 FAIL_SYS_USER_VALIDATE。
 * content script 运行在页面域名的上下文,fetch 自动带正确的
 * referer(https://air.1688.com/...)和 origin(https://air.1688.com)。
 *
 * 协议:background.js 通过 chrome.tabs.sendMessage 发 ALI_GET_ORDERS_IN_PAGE →
 *       本脚本在页面上下文 fetch mtop API → 返回结果给 background。
 */
(() => {
  'use strict';

  const ALI_API = 'https://h5api.m.1688.com/h5/mtop.1688.trading.dataline.service/1.0/';
  const ALI_APP_KEY = '12574478';
  const ALI_TRADE_STATUS = { all: '', unshipped: 'waitsellersend', unreceived: 'waitbuyerreceive' };

  /* MD5(RFC 1321,Joseph Myers 实现;mtop 签名必需) */
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
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586); c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426); c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417); c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101); c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632); c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083); c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690); c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784); c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463); c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353); c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222); c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835); c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415); c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606); c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744); c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379); c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  function md5blk(s) {
    var b = [], i;
    for (i = 0; i < 64; i += 4)
      b[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    return b;
  }
  function md51(s) {
    var n = s.length, state = [1732584193, -271733879, -1732584194, 271733878], i;
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
    s = s.substring(i - 64);
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
    tail[14] = n * 8; md5cycle(state, tail);
    return state;
  }
  function md5(s) { return hex(md51(unescape(encodeURIComponent(s)))); }

  function toYuan(fen) { return (Number(fen || 0) / 100).toFixed(2); }

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

  function getAliToken() {
    const m = document.cookie.match(/_m_h5_tk=([^;]+)/);
    return m ? m[1].split('_')[0] : '';
  }

  /**
   * 在页面上下文发 fetch(content script 的 fetch 自动带正确的 referer/origin)
   */
  async function fetch1688OrdersInPage({ tab = 'all', size = 30 } = {}) {
    const param = { page: 1, pageSize: Math.min(Number(size) || 30, 50) };
    const st = ALI_TRADE_STATUS[tab];
    if (st) param.tradeStatus = st;
    const data = JSON.stringify({
      serviceId: 'OrderListDataLineService.buyerOrderList',
      param: JSON.stringify(param),
    });
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = getAliToken();
      const t = String(Date.now());
      const sign = md5(`${token}&${t}&${ALI_APP_KEY}&${data}`);
      const body = new URLSearchParams({
        jsv: '2.7.4', appKey: ALI_APP_KEY, t, sign,
        ecode: '1', type: 'json', valueType: 'string',
        api: 'mtop.1688.trading.dataline.service', v: '1.0',
        dataType: 'json', timeout: '20000', data,
      }).toString();
      let resp;
      try {
        resp = await fetch(ALI_API, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
      } catch (err) {
        throw new Error(`ALI_NETWORK: ${err && err.message ? err.message : err}`);
      }
      if (resp.status === 401 || resp.status === 403)
        throw new Error('ALI_AUTH_REQUIRED: 1688登录态失效,请在浏览器中重新登录 1688');
      if (!resp.ok) throw new Error(`ALI_HTTP_${resp.status}`);
      const json = await resp.json().catch(() => null);
      if (!json) throw new Error('ALI_BAD_RESPONSE: 接口返回异常(可能触发风控)');
      const ret = (Array.isArray(json.ret) && json.ret[0]) || '';
      if (/^FAIL_SYS_TOKEN_EMPTY|^FAIL_SYS_ILLEGAL_ACCESS/.test(ret)) {
        lastErr = new Error(`ALI_${ret}: 请确认浏览器已登录 1688 并刷新一次订单页`);
        continue;
      }
      if (/^FAIL_SYS_USER_VALIDATE/.test(ret))
        throw new Error('ALI_VALIDATE: 1688风控拦截,请打开 1688 订单页过验证后重试');
      if (!/^SUCCESS/.test(ret)) throw new Error(`ALI_${ret || 'BAD_RESPONSE'}`);
      const resultStr = json.data && json.data.data && json.data.data.result;
      if (typeof resultStr !== 'string') throw new Error('ALI_BAD_RESPONSE: 响应缺少订单数据');
      let inner;
      try { inner = JSON.parse(resultStr); } catch { throw new Error('ALI_BAD_RESPONSE: 订单数据解析失败'); }
      const orders = (inner.data && Array.isArray(inner.data.data)) ? inner.data.data : [];
      return orders.map(normalize1688Order);
    }
    throw lastErr || new Error('ALI_BAD_RESPONSE');
  }

  // 监听来自 background.js 的消息
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'ALI_GET_ORDERS_IN_PAGE') return false;
    fetch1688OrdersInPage(msg.payload || {})
      .then((orders) => sendResponse({ ok: true, orders }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // 异步 sendResponse
  });
})();
