// 1688 官方开放平台 API 适配器(2026-09-13,替换 cloakbrowser mtop 链路)
//
// 背景:mtop 页面链路双账号均被 baxia 风控(RISK_VALIDATE/滑块/session 被踢),
// 官方 API 无风控、结构化 JSON、支持增量与精确查;本适配器与浏览器版
// (ali1688.js)输出结构逐字段一致,前端零改动。
//
// 凭据(.env):ALI1688_APP_KEY / ALI1688_APP_SECRET + 每账号
// ALI1688_TOKEN_LINQX / ALI1688_TOKEN_CHENLIN(OAuth 授权 access_token);
// 已配 token 的账号走本适配器,未配的回落浏览器适配器(platform-orders.js 路由)
//
// 接口(均实测):
//   1/com.alibaba.trade/alibaba.trade.getBuyerOrderList     订单列表(不含物流)
//   1/com.alibaba.trade/alibaba.trade.get.buyerView         订单详情(单号精确查)
//   1/com.alibaba.logistics/alibaba.trade.getLogisticsInfos.buyerView  物流单号+公司名
//
// 实测坑(重要):
//   - 绝不传 bizTypes:trade_general,trade_assure 只覆盖老订单类型,新类型
//     订单会被过滤成 0(2026-09-13 实测近 3 月 635 单被过滤成 0)
//   - 19 位订单号 JSON.parse 丢精度,必须 safeParse 预处理;baseInfo.idOfStr
//     是原生字符串单号,优先取它
//   - isHis 必须 'true'/'false' 字符串(布尔 false 会被当空值丢弃)
//   - orderIds 参数过滤无效(返回全量第一页),精确查用 buyerView
//   - token 失效 = HTTP 401 + error_code "401"(Request need user authorized)
//   - 时间 "yyyyMMddHHmmssSSS+0800" → 转北京时间字符串展示(不过 parseUtcDate)
//   - 金额 totalAmount 单位是元(对比 mtop sumPayment 是分)
//
// token 生命周期:access_token 有效期有限(约 15 天),当前无 refresh_token,
// 过期后需重新 OAuth 授权并更新 .env;401 时返回 AUTH_REQUIRED 提示

import crypto from 'node:crypto';
import config from '../../../config/index.js';
import { ApiError, ErrorCode } from '../../../utils/error-codes.js';

const GW = 'https://gw.open.1688.com/openapi';
const API_ORDER_LIST = '1/com.alibaba.trade/alibaba.trade.getBuyerOrderList';
const API_ORDER_DETAIL = '1/com.alibaba.trade/alibaba.trade.get.buyerView';
const API_LOGISTICS = '1/com.alibaba.logistics/alibaba.trade.getLogisticsInfos.buyerView';

// tab → orderStatus(与浏览器版 ALI_TRADE_STATUS 一致)
const TAB_STATUS = { all: '', unshipped: 'waitsellersend', unreceived: 'waitbuyerreceive' };

// 状态 → 中文(前端按 /取消|关闭/ 判定已取消,terminated 必须含"取消")
const STATUS_PROMPTS = {
  waitbuyerpay: '等待付款',
  waitsellersend: '待发货',
  waitbuyerreceive: '已发货',
  confirm_goods: '已收货',
  success: '交易成功',
  cancel: '已取消',
  terminated: '已取消(终止)',
};

const REQUEST_TIMEOUT_MS = 20000;

/** 账号是否有官方 API token(决定路由到本适配器还是浏览器适配器) */
function hasAliOpenApiToken(account) {
  return Boolean(config.ali1688OpenApi.tokens[account]);
}

/** HMAC-SHA1 签名(复刻 buyer-sdk base.py,与 SDK 逐字节一致) */
function aopSign(urlPath, params, secret) {
  const joined = Object.entries(params)
    .map(([k, v]) => String(k) + String(v))
    .sort()
    .join('');
  return crypto.createHmac('sha1', secret)
    .update(urlPath + joined, 'utf8')
    .digest('hex')
    .toUpperCase();
}

/** 16 位以上长整型转字符串防 JSON.parse 丢精度(订单号/skuID 等) */
function safeParse(raw) {
  return JSON.parse(String(raw).replace(/"(\w+)":\s*(\d{16,})([,\}])/g, '"$1":"$2"$3'));
}

/** "20260913132224000+0800" → "2026-09-13 13:22:24"(北京时间字符串,前端直接展示) */
function fmtTime(t) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(String(t || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(t || '');
}

/**
 * 调用 1688 开放平台 API(POST form-urlencoded)
 * @throws ApiError AUTH_REQUIRED(token 失效/缺失) / RATE_LIMITED(限流) / BROWSER_ERROR(其它)
 */
async function callOpenApi(apiUri, account, extraParams = {}) {
  const { appKey, appSecret, tokens } = config.ali1688OpenApi;
  if (!appKey || !appSecret) {
    throw new ApiError('BROWSER_ERROR', '1688官方API未配置(检查 .env ALI1688_APP_KEY/APP_SECRET)', { status: 500 });
  }
  const token = tokens[account];
  if (!token) {
    throw new ApiError(ErrorCode.AUTH_REQUIRED, `账号 ${account} 未配置 1688 官方API token(.env ALI1688_TOKEN_${String(account).toUpperCase()})`);
  }
  const urlPath = `param2/${apiUri}/${appKey}`;
  const params = { access_token: token, ...extraParams };
  params._aop_signature = aopSign(urlPath, params, appSecret);

  let resp;
  try {
    resp = await fetch(`${GW}/${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new ApiError(ErrorCode.TIMEOUT, `1688官方API请求超时(${apiUri})`);
    }
    throw new ApiError('BROWSER_ERROR', `1688官方API网络异常: ${e.message}`, { status: 502 });
  }

  const raw = await resp.text();
  let json;
  try { json = safeParse(raw); } catch {
    throw new ApiError('BROWSER_ERROR', `1688官方API响应异常(${resp.status}): ${raw.slice(0, 200)}`, { status: 502 });
  }
  if (resp.status === 401 || json.error_code === '401') {
    throw new ApiError(
      ErrorCode.AUTH_REQUIRED,
      `1688官方API token 失效(账号 ${account}),请重新 OAuth 授权并更新 .env ALI1688_TOKEN_${String(account).toUpperCase()} 后 pm2 restart erp`
    );
  }
  if (!resp.ok) {
    // 429/限流等按 RATE_LIMITED,其余归 BROWSER_ERROR(对齐浏览器版错误族)
    const code = json.error_code || String(resp.status);
    const msg = json.error_message || json.exception || raw.slice(0, 200);
    if (resp.status === 429 || /rate|limit|流量/i.test(String(msg))) {
      throw new ApiError(ErrorCode.RATE_LIMITED, `1688官方API限流(${code}): ${msg}`);
    }
    throw new ApiError('BROWSER_ERROR', `1688官方API错误(${code}): ${msg}`, { status: 502 });
  }
  return json;
}

/** 官方订单 → ERP 精简结构(与浏览器版 normalize1688Order 逐字段对齐)
 *  trackingNumber/logisticsCompany 恒空串(2026-09-17 限流治理:列表/搜索不再逐单查物流,
 *  保存为采购订单后由 syncPurchaseLogisticsForPackage 统一补查回填) */
function normalizeOpenApiOrder(o, account) {
  const b = o.baseInfo || {};
  const entries = Array.isArray(o.productItems) ? o.productItems : [];
  return {
    orderSn: b.idOfStr || String(b.id || ''),
    status: b.status || '',
    statusPrompt: STATUS_PROMPTS[b.status] || b.status || '',
    amount: Number(b.totalAmount || 0).toFixed(2), // 单位:元
    trackingNumber: '',
    logisticsCompany: '', // 物流公司名(采购订单保存后统一补查回填,优先于前端按单号前缀推断)
    orderTime: fmtTime(b.createTime),
    sellerName: b.sellerLoginId || (b.sellerContact && b.sellerContact.companyName) || '',
    buyerUserId: b.buyerUserId ? String(b.buyerUserId) : '',
    buyerUsername: b.buyerLoginId || '',
    account,
    goods: entries.map((e) => ({
      goodsName: e.name || '',
      goodsId: String(e.productID || e.offerId || ''), // 商品ID(=offerId),拼详情页 detail.1688.com/offer/{id}.html
      spec: (Array.isArray(e.skuInfos) ? e.skuInfos : []).map((s) => `${s.name}:${s.value}`).join(' '),
      price: Number(e.price || 0).toFixed(2),
      number: Number(e.quantity || 1),
      thumbUrl: String((e.productImgUrl || [])[0] || '').replace(/^http:/, 'https:'),
    })),
  };
}

/** 物流包数组 → 公司名(取第一个包;"中通快递(ZTO)"去英文括号后缀 → "中通快递",
 *  与前端 inferCourier 口径一致;2026-09-16 实测 getLogisticsInfos 返回 logisticsCompanyName) */
function pickLogisticsCompany(packs) {
  const name = String((packs[0] && packs[0].logisticsCompanyName) || '');
  return name.replace(/\s*[（(][A-Za-z]+[)）]\s*$/, '').trim();
}

/** 订单列表;返回 { orders }(结构/字段与浏览器版一致,前端零改动)
 *  不传时间窗口:isHis=false 即最近 3 个月,首页 30 条(前端只用第一页)
 *  2026-09-17 不再逐单补物流单号(8并发×30单曾打爆 gw.QosAppFrequencyLimit 限流);
 *  物流单号改由采购订单保存后 syncPurchaseLogisticsForPackage 统一补查 */
async function listAli1688OpenApiOrders({ tab = 'all', size = 30, account } = {}) {
  const params = { isHis: 'false', page: '1', pageSize: String(Math.min(Number(size) || 30, 50)) };
  const st = TAB_STATUS[tab];
  if (st) params.orderStatus = st; // all 不传 orderStatus = 全部状态(含已取消)
  const json = await callOpenApi(API_ORDER_LIST, account, params);
  const raw = Array.isArray(json.result) ? json.result : [];
  const orders = raw.map((o) => normalizeOpenApiOrder(o, account));
  return { orders };
}

/** 单账号按订单号精确搜索(buyerView);未找到/业务错误返回 null,token 失效抛 AUTH_REQUIRED */
async function searchAliOpenApiInAccount(orderSn, account) {
  let json;
  try {
    json = await callOpenApi(API_ORDER_DETAIL, account, {
      webSite: '1688',
      orderId: String(orderSn || ''),
      includeFields: 'baseInfo,productItems',
    });
  } catch (e) {
    if (e instanceof ApiError && e.code === ErrorCode.AUTH_REQUIRED) throw e;
    // 订单不存在/不属于该账号等业务错误 → 视为无命中(对齐浏览器版 searchMode 语义)
    console.warn(`[ali1688-openapi] 搜索 ${orderSn}(账号 ${account})无结果: ${e.message}`);
    return null;
  }
  const detail = json && json.result;
  if (!detail || !detail.baseInfo) return null;
  const n = normalizeOpenApiOrder(detail, account);
  // 对齐浏览器版 searchAliOrder 返回结构
  // (物流单号不再随查:2026-09-17 限流治理,保存为采购订单后统一补查)
  const result = {
    orderSn: n.orderSn,
    orderAmount: n.amount,
    orderTime: n.orderTime,
    statusPrompt: n.statusPrompt,
    trackingNumber: '',
    goods: n.goods,
  };
  return result;
}

/** 买家版物流轨迹 API(2026-09-16 实测可用:返回 logisticsSteps[] 节点=acceptTime+remark;
 *  已签收较久的单可能返回 errorMessage"该订单没有物流跟踪信息" → 视为无轨迹) */
const API_TRACE = '1/com.alibaba.logistics/alibaba.trade.getLogisticsTraceInfo.buyerView';

/** 单笔查物流单号+公司(采购物流补全轮询用)
 *  未发货单实测返回 HTTP 200 + success:false(错误码 500_2"订单尚未发货",无 result)→ logisticsNo 为空,调用方跳过 */
async function getLogisticsForOrder(orderSn, account) {
  const r = await callOpenApi(API_LOGISTICS, account, {
    orderId: String(orderSn), fields: 'company,logisticsBillNo', webSite: '1688',
  });
  const packs = Array.isArray(r.result) ? r.result : [];
  return {
    logisticsNo: String((packs[0] && packs[0].logisticsBillNo) || ''),
    logisticsCompany: pickLogisticsCompany(packs),
    logisticsStatus: String((packs[0] && packs[0].status) || ''),
  };
}

/** 单笔查物流轨迹(完整节点,多物流包 steps 合并,按时间倒序=最新在前)
 *  @returns {{ steps: Array<{acceptTime, remark}>, raw: Array }} */
async function getTraceForOrder(orderSn, account) {
  const r = await callOpenApi(API_TRACE, account, { orderId: String(orderSn), webSite: '1688' });
  const traces = Array.isArray(r.logisticsTrace) ? r.logisticsTrace : [];
  const steps = traces.flatMap((t) => (Array.isArray(t.logisticsSteps) ? t.logisticsSteps : []));
  steps.sort((a, b) => String(b.acceptTime || '').localeCompare(String(a.acceptTime || '')));
  return { steps, raw: traces };
}

export { hasAliOpenApiToken, listAli1688OpenApiOrders, searchAliOpenApiInAccount, getLogisticsForOrder, getTraceForOrder };
