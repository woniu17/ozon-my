/**
 * 拼多多订单查询工具
 *
 * 基于 mobile.yangkeduo.com H5 order_list_v4 接口(2026-09 实测):
 *  - 仅依赖浏览器拼多多登录 Cookie(credentials include),无需 anti_content
 *  - 金额单位为分,返回前转元
 *  - pdduid 查询参数从 cookie pdd_user_uid 兜底获取,取不到则省略
 *  - 翻页:用上一页最后一条订单的 offset 字段作为下一页的 offset 参数
 *
 * 用法:
 *   import { fetchPddOrderList, findPddOrderBySn } from './pdd-order-query.mjs';
 *   // 翻页拉取全部订单
 *   const all = await fetchPddOrderList({ size: 50 });
 *   // 按订单号查单个订单(自动翻页直到找到)
 *   const order = await findPddOrderBySn('260830-555451748643751');
 */

'use strict';

const PDD_API = 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4';

/** 从 cookie 兜底取 pdduid(取不到返回空串,接口主要靠 Cookie 会话) */
async function getPdduid() {
  // 浏览器扩展环境有 chrome.cookies,Node 环境/Evaluate 环境用 document.cookie 兜底
  if (typeof chrome !== 'undefined' && chrome.cookies) {
    try {
      const c = await chrome.cookies.get({ url: 'https://mobile.yangkeduo.com/', name: 'pdd_user_uid' });
      if (c && c.value) return c.value;
      const all = await chrome.cookies.getAll({ domain: 'yangkeduo.com' });
      const hit = all.find((x) => /uid/i.test(x.name) && /^\d+$/.test(x.value));
      return hit ? hit.value : '';
    } catch { return ''; }
  }
  // 页面上下文(Evaluate / content script):从 document.cookie 读取
  if (typeof document !== 'undefined') {
    const m = document.cookie.match(/pdd_user_uid=(\d+)/);
    return m ? m[1] : '';
  }
  return '';
}

/** 分转元 */
function toYuan(fen) {
  return (Number(fen || 0) / 100).toFixed(2);
}

/**
 * 瘦身为 ERP 前端需要的精简结构
 * (与 background.js normalizeOrders 对齐,额外保留 offset 供翻页)
 */
function normalizeOrder(o) {
  return {
    orderSn: o.order_sn || '',
    parentOrderSn: o.parent_order_sn || '',
    statusPrompt: o.order_status_prompt || '',
    payStatus: o.pay_status ?? 0,
    shippingStatus: o.shipping_status ?? 0,
    amount: toYuan(o.order_amount),
    amountFen: Number(o.order_amount || 0), // 原始分,供精确计算
    trackingNumber: o.tracking_number || '',
    orderTime: o.order_time || 0,
    mallName: (o.mall && o.mall.mall_name) || '',
    offset: o.offset || '', // 翻页游标
    sortId: o.sort_id || 0,
    goods: (o.order_goods || []).map((g) => ({
      goodsName: g.goods_name || '',
      spec: g.spec || '',
      price: toYuan(g.goods_price),
      priceFen: Number(g.goods_price || 0),
      number: g.goods_number || 1, // 拼多多侧总购买数量(妙手 purchaseNum 可能不一致)
      thumbUrl: g.thumb_url || '',
    })),
  };
}

/**
 * 拉取一页拼多多订单列表
 *
 * @param {object} opts
 * @param {number} [opts.size=50] - 每页数量(最大50)
 * @param {string} [opts.offset=''] - 翻页游标(上一页最后一条的 offset)
 * @param {string} [opts.tab='all'] - 订单标签:all|unreceived
 * @returns {Promise<{orders: Array, nextOffset: string, hasMore: boolean}>}
 */
export async function fetchPddOrderPage({ size = 50, offset = '', tab = 'all' } = {}) {
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
    size: Math.min(Number(size) || 50, 50),
    offset,
  };

  const resp = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('PDD_AUTH_REQUIRED: 拼多多登录态失效,请在浏览器中重新登录 mobile.yangkeduo.com');
  }
  if (!resp.ok) throw new Error(`PDD_HTTP_${resp.status}`);

  const data = await resp.json();
  if (!data || !Array.isArray(data.orders)) {
    throw new Error('PDD_BAD_RESPONSE: 接口返回异常(可能触发风控)');
  }

  const orders = data.orders.map(normalizeOrder);
  const lastOrder = data.orders[data.orders.length - 1];
  const nextOffset = lastOrder?.offset || '';
  // 如果返回数量 < size,说明没有更多了
  const hasMore = data.orders.length >= (Number(size) || 50) && !!nextOffset;

  return { orders, nextOffset, hasMore };
}

/**
 * 翻页拉取拼多多订单列表(自动翻页直到拉完或达到 maxPages)
 *
 * @param {object} opts
 * @param {number} [opts.size=50] - 每页数量
 * @param {number} [opts.maxPages=10] - 最大翻页数(防失控)
 * @param {string} [opts.tab='all'] - 订单标签
 * @param {function} [opts.onPage] - 每页回调 ({batch, orders, total}) 可用于流式处理
 * @returns {Promise<Array>} 所有订单(精简结构)
 */
export async function fetchPddOrderList({ size = 50, maxPages = 10, tab = 'all', onPage } = {}) {
  const all = [];
  let offset = '';
  for (let i = 0; i < maxPages; i++) {
    const { orders, nextOffset, hasMore } = await fetchPddOrderPage({ size, offset, tab });
    all.push(...orders);
    if (onPage) onPage({ batch: i, orders, total: all.length });
    if (!hasMore) break;
    offset = nextOffset;
  }
  return all;
}

/**
 * 按订单号查询单个订单(自动翻页直到找到或拉完)
 *
 * 翻页策略:拼多多 order_list_v4 不支持按订单号直接搜索,
 * 只能翻页遍历,用 order_sn 匹配。订单按时间倒序排列,
 * 8月30日的订单可能需要翻2-3页(每页50条)。
 *
 * @param {string} orderSn - 拼多多订单号(如 260830-555451748643751)
 * @param {object} [opts]
 * @param {number} [opts.maxPages=10] - 最大翻页数
 * @param {number} [opts.size=50] - 每页数量
 * @returns {Promise<object|null>} 订单精简结构,未找到返回 null
 */
export async function findPddOrderBySn(orderSn, { maxPages = 10, size = 50 } = {}) {
  if (!orderSn) return null;
  let offset = '';
  for (let i = 0; i < maxPages; i++) {
    const { orders, nextOffset, hasMore } = await fetchPddOrderPage({ size, offset });
    const hit = orders.find((o) => o.orderSn === orderSn);
    if (hit) return hit;
    if (!hasMore) break;
    offset = nextOffset;
  }
  return null;
}

/**
 * 批量按订单号查询(一次翻页,同时匹配多个订单号)
 * 比逐个调用 findPddOrderBySn 高效(共享翻页请求)
 *
 * @param {string[]} orderSns - 拼多多订单号数组
 * @param {object} [opts]
 * @param {number} [opts.maxPages=10] - 最大翻页数
 * @param {number} [opts.size=50] - 每页数量
 * @returns {Promise<Object<string, object|null>>} { orderSn: order|null }
 */
export async function findPddOrdersBySns(orderSns, { maxPages = 10, size = 50 } = {}) {
  const remaining = new Set(orderSns.filter(Boolean));
  const result = {};
  for (const sn of remaining) result[sn] = null;

  let offset = '';
  for (let i = 0; i < maxPages && remaining.size > 0; i++) {
    const { orders, nextOffset, hasMore } = await fetchPddOrderPage({ size, offset });
    for (const o of orders) {
      if (remaining.has(o.orderSn)) {
        result[o.orderSn] = o;
        remaining.delete(o.orderSn);
      }
    }
    if (!hasMore) break;
    offset = nextOffset;
  }
  return result;
}

export { toYuan, normalizeOrder };
