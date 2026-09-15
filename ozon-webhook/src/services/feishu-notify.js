// 飞书机器人通知(货件相关推送)
// 参考 get-shop-product/httpsrv/feishuHelper.js,改写为 ESM
// 仅用于 FBS/rFBS 货件级通知(TYPE_NEW_POSTING/POSTING_CANCELLED/STATE_CHANGED)
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { getStoreBySellerId, listStores } from './store-loader.js';
import { getDb } from '../db/index.js';
import { PUSH_ABSORBING } from './status-map.js';

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
 * @returns {{bySeller: Map<number, {storeName, sellerId, orderCount, saleCny}>, total: {orderCount, saleCny, validOrderCount, validSaleCny}, ready: boolean}}
 *   ready: DB 里是否已有 sale_amount_cny>0 的当日记录(兜底 poller 是否已回填)
 *   false 表示金额尚未回填,调用方应提示"汇总信息还未拉取"
 *   valid* :剔除取消类吸收态(PUSH_ABSORBING)后的单量/金额
 */
export function buildTodaySummaryFromDb() {
  const { start, end } = getTodayUtcRange();
  const db = getDb();
  // 按 seller_id 聚合当日订单数和金额;valid_* 剔除取消类吸收态
  const cancelPh = Array.from(PUSH_ABSORBING, () => '?').join(',');
  const rows = db.prepare(`
    SELECT seller_id,
      COUNT(*) AS order_count,
      COALESCE(SUM(sale_amount_cny), 0) AS sale_cny,
      SUM(CASE WHEN status IN (${cancelPh}) THEN 0 ELSE 1 END) AS valid_count,
      COALESCE(SUM(CASE WHEN status IN (${cancelPh}) THEN 0 ELSE sale_amount_cny END), 0) AS valid_cny
    FROM ozon_postings
    WHERE in_process_at IS NOT NULL
      AND in_process_at >= ? AND in_process_at < ?
    GROUP BY seller_id
    ORDER BY seller_id
  `).all(...PUSH_ABSORBING, ...PUSH_ABSORBING, start, end);

  // 检查是否有任何 sale_amount_cny>0 的记录(兜底 poller 是否已回填)
  const ready = rows.some(r => Number(r.sale_cny) > 0);

  const stores = listStores();
  const storeMap = new Map(stores.map(s => [Number(s.company_id), s]));

  const bySeller = new Map();
  let totalOrder = 0;
  let totalSale = 0;
  let totalValidOrder = 0;
  let totalValidSale = 0;

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
    totalValidOrder += Number(r.valid_count) || 0;
    totalValidSale += Number(r.valid_cny) || 0;
  }

  return {
    bySeller,
    total: {
      orderCount: totalOrder,
      saleCny: totalSale,
      validOrderCount: totalValidOrder,   // 剔除取消后的单量
      validSaleCny: totalValidSale,       // 剔除取消后的销售金额
    },
    ready,
  };
}

/**
 * 构造"当日各店铺销售汇总"文本块
 * 订单数前导空格对齐到 2 位,金额整数部分前导空格对齐到 4 位(小数固定 2 位)
 * 合计行带客单价(销售金额/订单数);末行"剔除取消"统计取消类吸收态之外的
 * 单量/销售金额/客单价(取消单在通知送达时可能尚未发生,两行差异随时点变化)
 * @param {Map<number, {storeName, sellerId, orderCount, saleCny}>} bySeller
 * @param {{orderCount, saleCny, validOrderCount, validSaleCny}} total
 * @returns {string}
 */
export function buildTodaySummaryLines(bySeller, total) {
  const padOrder = (n) => String(n).padStart(2, ' ');
  const padAmount = (cny) => {
    const fixed = Number(cny).toFixed(2);
    const [intPart, decPart] = fixed.split('.');
    return `${intPart.padStart(4, ' ')}.${decPart}`;
  };
  // 客单价:单量 0 时无意义,显示 —
  const fmtAov = (count, cny) => (count > 0 ? padAmount(cny / count) : '—');
  const lines = [];
  lines.push('—— 当日各店铺销售汇总(Asia/Shanghai)——');
  const sorted = Array.from(bySeller.values()).sort((a, b) => a.sellerId - b.sellerId);
  for (const it of sorted) {
    lines.push(`• ${it.storeName}: 订单 ${padOrder(it.orderCount)} 单 / 销售金额 ${padAmount(it.saleCny)} CNY`);
  }
  lines.push(`合计:订单 ${padOrder(total.orderCount)} 单 / 销售金额 ${padAmount(total.saleCny)} CNY / 客单价 ${fmtAov(total.orderCount, total.saleCny)} CNY`);
  lines.push(`剔除取消:订单 ${padOrder(total.validOrderCount)} 单 / 销售金额 ${padAmount(total.validSaleCny)} CNY / 客单价 ${fmtAov(total.validOrderCount, total.validSaleCny)} CNY`);
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
 * 揽收路由说明(2026-09-13 调整):STATE_CHANGED 的揽收判定不再由本函数内嵌
 * (原:精确匹配 new_state=posting_on_way_to_city 转 notifyPostingPickedUp),
 * 改由 state-changed.js handler 按"首次达到揽收级 + pickup_at 去重"决策后定向调用
 * notifyPostingPickedUp / notifyPostingEvent(设计决策 D1,避免重复推送与漏报窗口)
 * @param {string} messageType TYPE_NEW_POSTING / TYPE_POSTING_CANCELLED / TYPE_STATE_CHANGED
 * @param {object} payload Ozon 推送原始 payload
 */
export async function notifyPostingEvent(messageType, payload) {
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
      extra = `\n旧状态: ${payload.old_state ?? '-'}\n取消原因: ${formatCancelReason(payload.reason?.message) ?? '-'}`;
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
  const title = `${isQc ? '[质检]' : ''} [${sellerName}] [${postingNumber}]`;
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
 * 从 DB 查询当日各店铺揽收统计
 * 口径(2026-09-13 修正):按 pickup_at 当日计数——pickup_at 是首次达到揽收级的时间,
 * 由 webhook handler(实时推送)与 unfulfilled-poller(兜底)共同维护,
 * 不受后续状态变更覆盖影响;旧口径(status=posting_on_way_to_city)会被后续状态覆盖导致漏计
 * @returns {{bySeller: Map<number, {storeName, sellerId, pickupCount}>, total: number}}
 */
export function buildTodayPickupSummaryFromDb() {
  const { start, end } = getTodayUtcRange();
  const db = getDb();
  const rows = db.prepare(`
    SELECT seller_id, COUNT(*) AS pickup_count
    FROM ozon_postings
    WHERE pickup_at IS NOT NULL
      AND pickup_at >= ? AND pickup_at < ?
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

/**
 * 取消发起方翻译(取消兜底通知用)
 * API 实测返回俄语(Клиент),swagger 枚举为英语(Client),统一映射中文,未知原样返回
 */
const INITIATOR_CN = {
  'Клиент': '买家', 'Client': '买家', 'Customer': '买家',
  'Продавец': '卖家', 'Seller': '卖家',
  'Ozon': 'Ozon',
  'Система': '系统', 'System': '系统',
  'Доставка': '物流', 'Delivery': '物流',
};

function formatInitiator(initiator) {
  if (initiator == null) return '-';
  return INITIATOR_CN[String(initiator)] ?? String(initiator);
}

/**
 * 取消原因俄语→中文翻译(实时取消推送 + cancel-scanner 兜底通知共用)
 * Ozon 返回俄语文本(如 "Покупатель отменил заказ"),常见原因映射中文;未收录原样返回,不丢失信息
 * 归一化:ё→е(Ozon 部分原因返回 е 变体)
 */
const CANCEL_REASON_CN = {
  'Покупатель отменил заказ': '买家取消了订单',
  'Покупатель попросил отменить заказ': '买家要求取消订单',
  'Покупатель отменил заказ из-за долгой доставки': '买家因配送太慢取消订单',
  'Не успели передать в службу доставки': '未及时移交物流',
  'Истек срок резервирования товара': '商品预留期已过',
  'Ошибка при резервировании товара': '商品预留出错',
  'Товар потерялся на складе': '商品在仓库丢失',
  'Отправление не принято службой доставки': '物流未接收货件',
  'Отправление не вручено в срок': '货件未按时投递',
  'Отправление утеряно службой доставки': '货件被物流丢失',
  'Покупатель не забрал отправление в срок': '买家未按时取货',
  'Не удалось связаться с получателем': '无法联系收件人',
  'Получатель отказался от отправления': '收件人拒收货件',
  'Отправление повреждено': '货件破损',
  'Отменено продавцом': '卖家取消',
  'Не соответствует требованиям перевозчика': '不符合承运商要求',
  'Отправление не прошло таможенное оформление': '货件未通过海关清关',
  // 以下为 ERP 库实际出现过的补充(2026-09-15,按真实订单 cancellation_json 提取)
  'Не удалось доставить заказ': '无法配送订单',
  'Покупатель не забрал заказ': '买家未取货',
  'Вы не отгрузили заказ вовремя': '您未按时发货',
  'Вы отменили заказ': '您取消了订单',
  'Проверка товара на соответствие описанию в карточке': 'Ozon质检：核对商品与描述是否相符',
};

// "Покупатель отказался при вручении: <子原因>" 拒收前缀系列
const REFUSAL_PREFIX_RE = /^Покупатель отказался при вручении:?\s*(.*)$/;
const REFUSAL_REASON_CN = {
  'недоволен качеством товара': '对商品质量不满意',
  'передумал': '改变主意',
  'не устраивает цена': '对价格不满意',
  'нашел аналогичный товар дешевле': '找到更便宜的同类商品',
  'товар не подошел': '商品不合适',
  'не соответствует описанию': '与描述不符',
  'не заказывал данный товар': '未订购该商品',
  'не подходит размер / фасон / габариты': '尺寸/款式/大小不合适',
  'цвет / фасон / комплектация не соответствует описанию': '颜色/款式/配置与描述不符',
  'не соответствует заказанному товару': '与所订商品不符',
  // ERP 库实际出现过的补充(2026-09-15)
  'неполная комплектация': '商品配件不全',
  'в заказе не тот товар': '订单中的商品不对',
};

// "Покупатель отменил заказ: <子原因>" 买家取消前缀系列
const BUYER_CANCEL_PREFIX_RE = /^Покупатель отменил заказ:?\s*(.*)$/;
const BUYER_CANCEL_REASON_CN = {
  'не устроил срок доставки': '配送时效不满意',
  'нашел дешевле': '找到更便宜的',
};

export function formatCancelReason(reason) {
  if (reason == null) return null;
  const norm = String(reason).replace(/ё/g, 'е').trim();
  if (CANCEL_REASON_CN[norm]) return CANCEL_REASON_CN[norm];
  const m = norm.match(REFUSAL_PREFIX_RE);
  if (m) {
    const sub = m[1].trim();
    return `买家拒收${sub ? `：${REFUSAL_REASON_CN[sub] ?? sub}` : ''}`;
  }
  const c = norm.match(BUYER_CANCEL_PREFIX_RE);
  if (c) {
    const sub = c[1].trim();
    return `买家取消订单${sub ? `：${BUYER_CANCEL_REASON_CN[sub] ?? sub}` : ''}`;
  }
  return String(reason); // 未收录的俄语/英语原因原样返回
}

/**
 * 推送"unfulfilled-poller 发现的揽收"兜底通知到飞书
 * 格式与 notifyPostingPickedUp(实时揽收推送)一致,末行标注"(兜底通知)"
 * @param {object} store   店铺对象
 * @param {object} posting OPI /v4/posting/fbs/unfulfilled/list 返回的单条 posting
 * @param {string} mappedState 映射后的推送模型状态(如 posting_on_way_to_city)
 * @param {string|null} oldStatus 更新前的 DB 状态(新发现货件为 null)
 * @param {string|null} pickupLines 当日揽收统计文本块(由 unfulfilled-poller 构造)
 */
export async function notifyPickupDiscovered(store, posting, mappedState, oldStatus, pickupLines) {
  const postingNumber = posting.posting_number ?? '-';
  const sellerId = Number(store.company_id);
  const sellerName = store.name ?? String(sellerId);

  const title = `[揽收] [${sellerName}] [${postingNumber}]`;
  const text = [
    title,
    `货件号: ${postingNumber}`,
    `卖家: ${formatSeller(sellerId)}`,
    `变更时间: ${new Date().toISOString()}`,
    `新状态: ${mappedState ?? '-'}`,
    oldStatus ? `旧状态: ${oldStatus}` : null,
    pickupLines ? '' : null,
    pickupLines,
    '(兜底通知)', // 末行标注,与 Ozon 实时推送区分
  ].filter((v) => v !== null).join('\n');

  await sendFeishuText(text, config.feishu.webhookUrlPickup);
}

/**
 * 推送"cancel-scanner 发现的货件取消"兜底通知到飞书
 * 格式与实时取消通知(TYPE_POSTING_CANCELLED)一致,末行标注"(兜底通知)";
 * 额外携带取消发起方(实时推送无此字段)
 * @param {object} store   店铺对象
 * @param {object} posting OPI /v4/posting/fbs/list 返回的单条 posting(status=cancelled/not_accepted)
 * @param {string|null} oldStatus 更新前的 DB 状态(新发现货件为 null)
 */
export async function notifyCancelDiscovered(store, posting, oldStatus) {
  const postingNumber = posting.posting_number ?? '-';
  const sellerId = Number(store.company_id);
  const cancel = posting.cancellation ?? {};

  const text = [
    '[货件取消]',
    `货件号: ${postingNumber}`,
    `卖家: ${formatSeller(sellerId)}`,
    `取消时间: ${new Date().toISOString()}`,
    oldStatus ? `旧状态: ${oldStatus}` : null,
    cancel.cancel_reason ? `取消原因: ${formatCancelReason(cancel.cancel_reason)}` : null,
    cancel.cancellation_initiator ? `取消发起方: ${formatInitiator(cancel.cancellation_initiator)}` : null,
    '(兜底通知)', // 末行标注,与 Ozon 实时推送区分
  ].filter((v) => v !== null).join('\n');

  await sendFeishuText(text, config.feishu.webhookUrlCancel);
}
