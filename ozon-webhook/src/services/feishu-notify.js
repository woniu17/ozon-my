// 飞书机器人通知(货件相关推送)
// 参考 get-shop-product/httpsrv/feishuHelper.js,改写为 ESM
// 仅用于 FBS/rFBS 货件级通知(TYPE_NEW_POSTING/POSTING_CANCELLED/STATE_CHANGED)
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { getStoreBySellerId, listStores } from './store-loader.js';
import { getDb } from '../db/index.js';

/**
 * 从 posting / payload 中提取销售金额(OPI 返回的金额本身就是 CNY)
 * 优先 financial_data.posting_totals.price.amount
 * 兜底 financial_data.products[].payout.amount 之和
 * 再兜底 products[].price.amount 之和
 * 被 new-posting.js / unfulfilled-poller.js 落库时复用
 */
export function extractSaleAmountCny(posting) {
  if (!posting) return 0;
  const fd = posting.financial_data || {};
  const total = fd.posting_totals?.price?.amount;
  if (total != null) return Number(total) || 0;
  if (Array.isArray(fd.products)) {
    const sum = fd.products.reduce((s, p) => s + (Number(p?.payout?.amount) || 0), 0);
    if (sum > 0) return sum;
  }
  if (Array.isArray(posting.products)) {
    const sum = posting.products.reduce((s, p) => {
      const price = p?.price;
      const v = typeof price === 'object' ? price?.amount : price;
      return s + (Number(v) || 0);
    }, 0);
    if (sum > 0) return sum;
  }
  return 0;
}

/**
 * 计算"今日(Asia/Shanghai)"对应的 UTC ISO 范围 [start, end)
 * 用于从 DB 按当日过滤订单(in_process_at 是 UTC ISO)
 */
function getTodayUtcRange() {
  const now = new Date();
  // 今日北京 00:00 对应的 UTC
  const shOffset = 8 * 3600_000; // Asia/Shanghai = UTC+8
  // 计算"北京今日 00:00"的 UTC 时间戳
  const nowShTs = now.getTime() + shOffset;
  const startOfDayShTs = Math.floor(nowShTs / 86400_000) * 86400_000;
  const startUtcTs = startOfDayShTs - shOffset;
  const endUtcTs = startUtcTs + 86400_000;
  return {
    start: new Date(startUtcTs).toISOString(),
    end: new Date(endUtcTs).toISOString(),
  };
}

/**
 * 从 DB 查询当日各店铺销售汇总(订单数 + 销售金额 CNY)
 * 用于飞书通知,避免每次都调 OPI 聚合
 * @returns {{bySeller: Map<number, {storeName, sellerId, orderCount, saleCny}>, total: {orderCount, saleCny}, ready: boolean}}
 *   ready: DB 里是否已有 sale_amount_cny>0 的当日记录(兜底 poller 是否已回填)
 *   false 表示金额尚未回填,调用方应提示"汇总信息还未拉取"
 */
export function buildTodaySummaryFromDb() {
  const { start, end } = getTodayUtcRange();
  const db = getDb();
  // 按 seller_id 聚合当日订单数和金额
  const rows = db.prepare(`
    SELECT seller_id, COUNT(*) AS order_count, COALESCE(SUM(sale_amount_cny), 0) AS sale_cny
    FROM ozon_postings
    WHERE in_process_at IS NOT NULL
      AND in_process_at >= ? AND in_process_at < ?
    GROUP BY seller_id
    ORDER BY seller_id
  `).all(start, end);

  // 检查是否有任何 sale_amount_cny>0 的记录(兜底 poller 是否已回填)
  const ready = rows.some(r => Number(r.sale_cny) > 0);

  const stores = listStores();
  const storeMap = new Map(stores.map(s => [Number(s.company_id), s]));

  const bySeller = new Map();
  let totalOrder = 0;
  let totalSale = 0;

  // 确保所有店铺都出现(即使 0 单,保持汇总对齐)
  for (const s of stores) {
    const sellerId = Number(s.company_id);
    bySeller.set(sellerId, { storeName: s.name, sellerId, orderCount: 0, saleCny: 0 });
  }
  for (const r of rows) {
    const sellerId = Number(r.seller_id);
    const store = storeMap.get(sellerId);
    const storeName = store?.name ?? String(sellerId);
    bySeller.set(sellerId, {
      storeName,
      sellerId,
      orderCount: r.order_count,
      saleCny: Number(r.sale_cny) || 0,
    });
    totalOrder += r.order_count;
    totalSale += Number(r.sale_cny) || 0;
  }

  return {
    bySeller,
    total: { orderCount: totalOrder, saleCny: totalSale },
    ready,
  };
}

/**
 * 构造"当日各店铺销售汇总"文本块
 * 订单数前导空格对齐到 2 位,金额整数部分前导空格对齐到 4 位(小数固定 2 位)
 * @param {Map<number, {storeName, sellerId, orderCount, saleCny}>} bySeller
 * @param {{orderCount, saleCny}} total
 * @returns {string}
 */
export function buildTodaySummaryLines(bySeller, total) {
  const padOrder = (n) => String(n).padStart(2, ' ');
  const padAmount = (cny) => {
    const fixed = Number(cny).toFixed(2);
    const [intPart, decPart] = fixed.split('.');
    return `${intPart.padStart(4, ' ')}.${decPart}`;
  };
  const lines = [];
  lines.push('—— 当日各店铺销售汇总(Asia/Shanghai)——');
  const sorted = Array.from(bySeller.values()).sort((a, b) => a.sellerId - b.sellerId);
  for (const it of sorted) {
    lines.push(`• ${it.storeName}: 订单 ${padOrder(it.orderCount)} 单 / 销售金额 ${padAmount(it.saleCny)} CNY`);
  }
  lines.push(`合计:订单 ${padOrder(total.orderCount)} 单 / 销售金额 ${padAmount(total.saleCny)} CNY`);
  return lines.join('\n');
}

/**
 * 将 seller_id 反查为可读格式:昵称(ID),如 YQL01(3891653)
 * 未匹配时退化为纯 ID
 */
function formatSeller(sellerId) {
  if (sellerId == null) return '-';
  const store = getStoreBySellerId(sellerId);
  if (!store) return String(sellerId);
  return `${store.name}(${store.company_id})`;
}

/**
 * 发送飞书文本消息(自动追加来源标识)
 * @param {string} text 消息内容
 * @param {string} url 飞书机器人 webhook URL,留空则跳过
 * @returns {Promise<boolean>} 是否发送成功
 */
export async function sendFeishuText(text, url) {
  if (!url) {
    logger.warn('feishu-notify: 未配置 webhook URL,跳过推送');
    return false;
  }
  try {
    const fullText = `${text}\n—— 来自 ${config.appName}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: fullText } }),
    });
    if (resp.ok) {
      logger.info('feishu-notify: 飞书消息发送成功');
      return true;
    }
    const errText = await resp.text().catch(() => '');
    logger.warn({ status: resp.status, errText: errText.slice(0, 200) }, 'feishu-notify: 发送失败');
    return false;
  } catch (err) {
    logger.warn({ err: err.message }, 'feishu-notify: 发送异常');
    return false;
  }
}

/**
 * 推送货件级通知到飞书
 * @param {string} messageType TYPE_NEW_POSTING / TYPE_POSTING_CANCELLED / TYPE_STATE_CHANGED
 * @param {object} payload Ozon 推送原始 payload
 */
export async function notifyPostingEvent(messageType, payload) {
  // 揽收(STATE_CHANGED + new_state=posting_on_way_to_city)走独立机器人 + 带当日揽收统计
  if (messageType === 'TYPE_STATE_CHANGED' && payload.new_state === 'posting_on_way_to_city') {
    return notifyPostingPickedUp(payload);
  }

  const postingNumber = payload.posting_number ?? '-';
  const sellerId = payload.seller_id ?? '-';

  let title;
  let timeField;
  let extra = '';
  let summaryLines = null;
  switch (messageType) {
    case 'TYPE_NEW_POSTING': {
      // 02131/024785 开头的货件号为质检单,其余为新订单
      const store = getStoreBySellerId(sellerId);
      const sellerName = store ? store.name : String(sellerId);
      const isQc = typeof postingNumber === 'string'
        && (postingNumber.startsWith('02131') || postingNumber.startsWith('024785'));
      title = `${isQc ? '[质检]' : ''} [${sellerName}] [${postingNumber}]`;
      timeField = ['处理时间', payload.in_process_at ?? '-'];
      const products = Array.isArray(payload.products) ? payload.products : [];
      const totalQty = products.reduce((sum, p) => sum + (p.quantity ?? 0), 0);
      const saleCny = extractSaleAmountCny(payload);
      extra = `\n商品SKU数: ${products.length}\n商品总件数: ${totalQty}\n销售金额: ${saleCny.toFixed(2)} CNY`;
      // 商品链接去重后逐行列出
      const links = [...new Set(
        products
          .filter((p) => p.sku != null)
          .map((p) => `https://www.ozon.ru/product/${p.sku}`),
      )];
      if (links.length) extra += `\n商品链接:\n${links.join('\n')}`;
      if (payload.tracking_number) extra += `\n跟踪号: ${payload.tracking_number}`;
      // 落库已完成,从 DB 查当日各店铺汇总(含本条新货件)
      // ready=false 表示兜底 poller 还没回填金额,提示"汇总信息还未拉取"
      try {
        const { bySeller, total, ready } = buildTodaySummaryFromDb();
        if (ready) {
          summaryLines = buildTodaySummaryLines(bySeller, total);
        } else {
          summaryLines = '(汇总信息还未拉取,稍后由兜底通知补全)';
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'feishu-notify: 查询当日汇总失败,跳过汇总');
      }
      break;
    }
    case 'TYPE_POSTING_CANCELLED':
      title = '[货件取消] Ozon 推送';
      timeField = ['取消时间', payload.changed_state_date ?? '-'];
      extra = `\n旧状态: ${payload.old_state ?? '-'}\n取消原因: ${payload.reason?.message ?? '-'}`;
      break;
    case 'TYPE_STATE_CHANGED':
      title = '[货件状态变更] Ozon 推送';
      timeField = ['变更时间', payload.changed_state_date ?? '-'];
      extra = `\n新状态: ${payload.new_state ?? '-'}`;
      break;
    default:
      title = `[${messageType}] Ozon 推送`;
      timeField = ['时间', new Date().toISOString()];
  }

  const text = [
    title,
    `货件号: ${postingNumber}`,
    `卖家: ${formatSeller(sellerId)}`,
    `${timeField[0]}: ${timeField[1]}`,
    extra,
    summaryLines ? '' : null, // 空行分隔
    summaryLines,
  ].filter((v) => v !== null).join('\n');

  // 按消息类型路由到不同飞书机器人:
  // TYPE_POSTING_CANCELLED → 货件取消机器人
  // TYPE_NEW_POSTING / TYPE_STATE_CHANGED → 新订单/货件机器人
  const url = messageType === 'TYPE_POSTING_CANCELLED'
    ? config.feishu.webhookUrlCancel
    : messageType === 'TYPE_NEW_POSTING'
      ? config.feishu.webhookUrlNew
      : config.feishu.webhookUrlDefault;

  await sendFeishuText(text, url);
}

/**
 * 推送"unfulfilled-poller 发现的新货件"通知到飞书
 * 格式与 notifyPostingEvent 的 TYPE_NEW_POSTING 完全一致,仅在末尾标注"(兜底通知)"
 * @param {object} store  店铺对象
 * @param {object} posting OPI /v4/posting/fbs/unfulfilled/list 返回的单条 posting
 * @param {string} todaySummaryLines 当日销售汇总文本块(由 unfulfilled-poller 构造)
 */
export async function notifyNewPostingDiscovered(store, posting, todaySummaryLines) {
  const postingNumber = posting.posting_number ?? '-';
  const sellerId = Number(store.company_id);
  const sellerName = store.name ?? String(sellerId);
  const isQc = typeof postingNumber === 'string'
    && (postingNumber.startsWith('02131') || postingNumber.startsWith('024785'));

  // 02131/024785 开头的货件号为质检单,其余为新订单
  // 标题与 notifyPostingEvent TYPE_NEW_POSTING 完全一致,便于运营统一识别
  const title = `[${isQc ? '新质检单' : '新订单'}] [${sellerName}] [${postingNumber}]`;
  const products = Array.isArray(posting.products) ? posting.products : [];
  const totalQty = products.reduce((sum, p) => sum + (p.quantity ?? 0), 0);
  const saleCny = extractSaleAmountCny(posting);

  const links = [...new Set(
    products
      .filter((p) => p.sku != null)
      .map((p) => `https://www.ozon.ru/product/${p.sku}`),
  )];

  const text = [
    title,
    `货件号: ${postingNumber}`,
    `卖家: ${formatSeller(sellerId)}`,
    `处理时间: ${posting.in_process_at ?? '-'}`,
    `商品SKU数: ${products.length}`,
    `商品总件数: ${totalQty}`,
    `销售金额: ${saleCny.toFixed(2)} CNY`,
    links.length ? `商品链接:\n${links.join('\n')}` : null,
    posting.tracking_number ? `跟踪号: ${posting.tracking_number}` : null,
    '', // 空行分隔
    todaySummaryLines,
    '(兜底通知)', // 末行标注,与 Ozon 实时推送区分
  ].filter((v) => v !== null).join('\n');

  // 新订单/货件机器人
  await sendFeishuText(text, config.feishu.webhookUrlNew);
}

/**
 * 从 DB 查询当日各店铺揽收统计(按 last_received_at 当日 + status=posting_on_way_to_city 近似)
 * 揽收时间用 ozon_postings.last_received_at 近似(STATE_CHANGED 落库时间)
 * 注意:同一货件后续状态变更会覆盖 last_received_at,可能导致漏统计;
 * 但揽收通常是一日内的终态之一,且本函数专为"刚收到揽收推送"场景设计,容差可接受
 * @returns {{bySeller: Map<number, {storeName, sellerId, pickupCount}>, total: number}}
 */
export function buildTodayPickupSummaryFromDb() {
  const { start, end } = getTodayUtcRange();
  const db = getDb();
  // 当日 last_received_at 且当前状态为揽收的货件数
  const rows = db.prepare(`
    SELECT seller_id, COUNT(*) AS pickup_count
    FROM ozon_postings
    WHERE status = 'posting_on_way_to_city'
      AND last_received_at IS NOT NULL
      AND last_received_at >= ? AND last_received_at < ?
    GROUP BY seller_id
    ORDER BY seller_id
  `).all(start, end);

  const stores = listStores();
  const bySeller = new Map();
  let total = 0;

  // 确保所有店铺都出现(即使 0 单)
  for (const s of stores) {
    const sellerId = Number(s.company_id);
    bySeller.set(sellerId, { storeName: s.name, sellerId, pickupCount: 0 });
  }
  for (const r of rows) {
    const sellerId = Number(r.seller_id);
    const store = stores.find(s => Number(s.company_id) === sellerId);
    const storeName = store?.name ?? String(sellerId);
    bySeller.set(sellerId, {
      storeName,
      sellerId,
      pickupCount: r.pickup_count,
    });
    total += r.pickup_count;
  }

  return { bySeller, total };
}

/**
 * 构造"当日各店铺揽收统计"文本块
 * 揽收数前导空格对齐到 2 位
 * @param {Map<number, {storeName, sellerId, pickupCount}>} bySeller
 * @param {number} total
 * @returns {string}
 */
export function buildTodayPickupSummaryLines(bySeller, total) {
  const padCount = (n) => String(n).padStart(2, ' ');
  const lines = [];
  lines.push('—— 当日各店铺揽收统计(Asia/Shanghai)——');
  const sorted = Array.from(bySeller.values()).sort((a, b) => a.sellerId - b.sellerId);
  for (const it of sorted) {
    lines.push(`• ${it.storeName}: 揽收 ${padCount(it.pickupCount)} 单`);
  }
  lines.push(`合计:揽收 ${padCount(total)} 单`);
  return lines.join('\n');
}

/**
 * 推送"揽收通知"(STATE_CHANGED + new_state=posting_on_way_to_city)到飞书
 * 走独立机器人,带当日各店铺揽收统计(从 DB 查询,含本条新揽收)
 * @param {object} payload Ozon 推送原始 payload
 */
export async function notifyPostingPickedUp(payload) {
  const postingNumber = payload.posting_number ?? '-';
  const sellerId = payload.seller_id ?? '-';
  const store = getStoreBySellerId(sellerId);
  const sellerName = store ? store.name : String(sellerId);

  const title = `[揽收] [${sellerName}] [${postingNumber}]`;
  let pickupLines = null;
  try {
    const { bySeller, total } = buildTodayPickupSummaryFromDb();
    pickupLines = buildTodayPickupSummaryLines(bySeller, total);
  } catch (err) {
    logger.warn({ err: err.message }, 'feishu-notify: 查询当日揽收统计失败,跳过统计');
  }

  const text = [
    title,
    `货件号: ${postingNumber}`,
    `卖家: ${formatSeller(sellerId)}`,
    `变更时间: ${payload.changed_state_date ?? '-'}`,
    `新状态: ${payload.new_state ?? '-'}`,
    payload.old_state ? `旧状态: ${payload.old_state}` : null,
    pickupLines ? '' : null,
    pickupLines,
  ].filter((v) => v !== null).join('\n');

  await sendFeishuText(text, config.feishu.webhookUrlPickup);
}
