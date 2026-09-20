// 闲鱼订单适配器(2026-09-20,平台订单接入第四平台)
// 语义基准:docs/闲鱼采购订单API-调研文档.md(2026-09-20 在已登录页面实测)
//
// 接口语义(实测):
//  - h5api.m.goofish.com mtop.idle.web.trade.bought.list,appKey=34839810,accountSite=xianyu
//  - 与淘宝/1688 同一套 mtop 签名(token 为 goofish.com 域 _m_h5_tk)
//  - data={"pageNumber":N,"orderStatus":"ALL"};每页固定 10 条,翻页看 nextPage
//    (orderStatus 其它值被服务端忽略,一律返回全量,故 tab 全部折叠为 all,与 pdd 一致)
//  - valueType=string:数值字段以字符串返回,规避 orderId 超 JS 安全整数精度丢失
//    (仍优先取 commonData.orderIdStr,双保险)
//  - 响应为动态卡片(commonData/head/content/tail 四段),聚合还原
//  - token 失败(FAIL_SYS_TOKEN_EMPTY/ILLEGAL_ACCESS)→ 服务器轮换 _m_h5_tk → 重取重签重试 ×1
//
// 执行位置:页面以 www.goofish.com 为 origin(站点自身即从该 origin 跨域调网关,
// CORS 放行 credentials);载体页用 goofish.com 首页(参照淘宝:不能用网关自身当 origin)

import { ApiError, ErrorCode } from '../../../utils/error-codes.js';
import { withPage, readBuyerIdentity } from '../browser-manager.js';
import { mtopSign, tokenFromCookies } from '../mtop-sign.js';
import { postFormInPage } from '../page-fetch.js';

const XY_API = 'https://h5api.m.goofish.com/h5/mtop.idle.web.trade.bought.list/1.0/';
const XY_APP_KEY = '34839810';
const XY_ENTRY = 'https://www.goofish.com/';
const XY_ORIGIN = 'https://www.goofish.com';
// 列表每页固定 10 条(实测);搜索最多翻 10 页(100 单),更早的单号搜不到属预期
const XY_PAGE_SIZE = 10;
const XY_SEARCH_MAX_PAGES = 10;

/** "￥1.58"/"16.80"(字符串数值) → "1.58" */
function stripYuan(s) {
  return String(s ?? '').replace(/[^\d.]/g, '') || '0';
}

/** 商品图 URL 归一化(与淘宝 adapter 同款:协议相对补 https:、缺 // 的畸形修复) */
function normalizePic(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (/^https?:[^/]/.test(s)) return s.replace(/^(https?):/, '$1://');
  return s.replace(/^http:\/\//, 'https://');
}

/** 动态卡片聚合还原订单(与 PDD/1688/淘宝 normalize 输出结构对齐)
 *  注意:amount 取 priceInfo.price(页面标注"实付款",单件订单实测为订单总额;
 *  多件订单的口径未实测,若发现按单价计需改为 price×buyAmount) */
function normalizeXianyuOrders(d) {
  const items = (d && Array.isArray(d.items)) ? d.items : [];
  return items.map((it) => {
    const c = (it && it.commonData) || {};
    const head = ((it.head || {}).data) || {};
    const content = ((it.content || {}).data) || {};
    const detail = content.detailInfo || {};
    const priceInfo = content.priceInfo || {};
    const seller = head.userInfo || {};
    const qty = Number(priceInfo.buyAmount) || 1;
    const price = stripYuan(priceInfo.price);
    return {
      // ⚠️ orderId 为 JS number 会丢精度,必须用 orderIdStr(valueType=string 下有双保险)
      orderSn: String(c.orderIdStr ?? c.orderId ?? ''),
      status: c.tradeStatusEnum || '',
      statusPrompt: head.statusViewMsg || '',
      amount: price,
      trackingNumber: '', // 列表接口不含物流单号(仅"物流记录"跳转按钮)
      orderTime: head.createTime || '',
      sellerName: seller.userNick || '',
      goods: [{
        goodsName: detail.auctionTitle || '',
        goodsId: String(c.itemId ?? detail.itemId ?? ''),
        spec: '',
        price,
        number: qty,
        thumbUrl: normalizePic(detail.auctionPic),
      }],
    };
  }).filter((o) => o.orderSn);
}

/** mtop 调用(含 token 轮换重试);返回成功响应的 json(调用方自行取 data) */
async function callXianyuMtop(page, data) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = tokenFromCookies(await page.context().cookies('https://h5api.m.goofish.com/'));
    const t = String(Date.now());
    const sign = mtopSign(token, t, XY_APP_KEY, data);
    const body = new URLSearchParams({
      jsv: '2.7.2', appKey: XY_APP_KEY, t, sign, v: '1.0',
      type: 'json', accountSite: 'xianyu', dataType: 'json', timeout: '20000',
      api: 'mtop.idle.web.trade.bought.list', valueType: 'string',
      sessionOption: 'AutoLoginOnly', data,
    }).toString();
    const r = await postFormInPage(page, XY_API, body);
    if (r.status === 401 || r.status === 403) {
      throw new ApiError(ErrorCode.AUTH_REQUIRED, '闲鱼登录态失效,请在 qxqx 的 persistent 中登录 goofish.com 后重试');
    }
    if (!r.ok) {
      throw new ApiError('BROWSER_ERROR', `XY_HTTP_${r.status}: 闲鱼接口返回异常`, { status: 502 });
    }
    const json = r.json;
    if (!json || typeof json !== 'object') {
      throw new ApiError('BROWSER_ERROR', 'XY_BAD_RESPONSE: 接口返回异常(可能触发风控)', { status: 502 });
    }
    const ret = (Array.isArray(json.ret) && json.ret[0]) || '';
    if (/^FAIL_SYS_SESSION_EXPIRED|^FAIL_SYS_USER_NOT_LOGIN|^SESSION_EXPIRED/.test(ret)) {
      throw new ApiError(ErrorCode.AUTH_REQUIRED, '闲鱼登录已过期,请运行 qxqx 的 persistent(headed)登录 goofish.com 后重试');
    }
    if (/^FAIL_SYS_TOKEN_EMPTY|^FAIL_SYS_ILLEGAL_ACCESS|^FAIL_SYS_TOKEN_EXOIRED/.test(ret)) {
      // token 失败/过期:服务器轮换 _m_h5_tk 后重取重签重试 1 次
      lastErr = new ApiError(ErrorCode.AUTH_REQUIRED, `闲鱼 mtop token 失效(${ret}),重试仍失败请运行 qxqx 的 persistent 打开闲鱼订单页一次后重试`);
      continue;
    }
    if (/^FAIL_SYS_USER_VALIDATE|^RGV587_ERROR/.test(ret)) {
      throw new ApiError('RISK_VALIDATE', '闲鱼风控拦截,请运行 qxqx 的 persistent 打开闲鱼订单页人工过验证后重试', { status: 409 });
    }
    if (!/^SUCCESS/.test(ret)) {
      throw new ApiError('BROWSER_ERROR', `XY_${ret || 'BAD_RESPONSE'}`, { status: 502 });
    }
    return json;
  }
  throw lastErr;
}

/** 取一页订单;返回 { orders, nextPage } */
async function fetchXianyuPage(page, pageNumber) {
  const data = JSON.stringify({ pageNumber, orderStatus: 'ALL' });
  const json = await callXianyuMtop(page, data);
  let d = json.data;
  if (typeof d === 'string') { // valueType=string 下个别网关版本会二次序列化,防御性解析
    try { d = JSON.parse(d); } catch { d = null; }
  }
  const orders = normalizeXianyuOrders(d);
  // nextPage 可能是 "true"/"false" 字符串;无下一页或空页即停
  const hasNext = !!d && String(d.nextPage) === 'true' && orders.length > 0;
  return { orders, hasNext };
}

/** 订单列表;返回 { orders }(tab 统一折叠为 all);订单行带 account 标注 */
async function listXianyuOrders({ tab = 'all', size = 30, account } = {}) {
  return withPage(account, 'xianyu', XY_ENTRY, XY_ORIGIN, async (page) => {
    const orders = [];
    const maxPages = Math.max(1, Math.ceil(Math.min(size, 50) / XY_PAGE_SIZE) + 1); // 多拉一页防尾页边界
    for (let pn = 1; pn <= maxPages; pn++) {
      const { orders: pageOrders, hasNext } = await fetchXianyuPage(page, pn);
      orders.push(...pageOrders);
      if (!hasNext || orders.length >= size) break;
    }
    const id = await readBuyerIdentity(page, XY_ORIGIN + '/');
    return {
      orders: orders.slice(0, size).map((o) => ({
        ...o,
        buyerUserId: id.userId,
        buyerUsername: id.username,
        account,
      })),
    };
  });
}

/** 单账号搜索实现(列表无服务端搜索参数,翻页比对 orderIdStr);无命中返回 null */
async function searchXianyuInAccount(orderSn, account) {
  return withPage(account, 'xianyu', XY_ENTRY, XY_ORIGIN, async (page) => {
    const sn = String(orderSn || '').trim();
    for (let pn = 1; pn <= XY_SEARCH_MAX_PAGES; pn++) {
      const { orders, hasNext } = await fetchXianyuPage(page, pn);
      const hit = orders.find((o) => o.orderSn === sn);
      if (hit) {
        // 对齐 searchPddOrder/searchAliOrder 返回结构
        return {
          orderSn: hit.orderSn,
          orderAmount: hit.amount,
          orderTime: hit.orderTime,
          statusPrompt: hit.statusPrompt,
          trackingNumber: hit.trackingNumber,
          goods: hit.goods,
        };
      }
      if (!hasNext) return null;
    }
    return null; // 超出翻页上限(100 单),视为未找到
  });
}

/** 按订单号精确搜索(跨账号;命中即返回,登录失效/风控记录后试下一账号) */
async function searchXianyuOrder(orderSn, accounts = []) {
  const errs = [];
  for (const account of accounts) {
    let result;
    try {
      result = await searchXianyuInAccount(orderSn, account);
    } catch (e) {
      if (e instanceof ApiError && (e.code === ErrorCode.AUTH_REQUIRED || e.code === 'RISK_VALIDATE')) {
        errs.push(`[${account}] ${e.message}`);
        continue;
      }
      throw e;
    }
    if (result) return { result: { ...result, account } };
  }
  if (errs.length) {
    throw new ApiError(ErrorCode.AUTH_REQUIRED, `闲鱼全部账号搜索失败:\n${errs.join('\n')}`);
  }
  return { result: null };
}

export { listXianyuOrders, searchXianyuOrder };
