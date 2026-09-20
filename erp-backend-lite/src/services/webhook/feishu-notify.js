// 飞书机器人通知(货件相关推送)
// 参考 get-shop-product/httpsrv/feishuHelper.js,改写为 ESM
// 仅用于 FBS/rFBS 货件级通知(TYPE_NEW_POSTING/POSTING_CANCELLED/STATE_CHANGED)
import config from '../../config/index.js';
import logger from '../../middleware/log.js';
import { getStoreBySellerId, listStores } from './store-map.js';
import { getDb } from '../../db/index.js';

/**
 * 任意时间值 → 北京时间 "YYYY-MM-DD HH:mm:ss"
 * UTC+8 固定数学偏移(与 getTodayUtcRange 同口径,不依赖服务器时区)
 * 非法/空值:返回 '-' 或原样返回
 */
function fmtShTime(v) {
  if (v == null || v === '') return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const t = new Date(d.getTime() + 8 * 3600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} `
    + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/**
 * 从 posting / payload 中提取销售金额(OPI 返回的金额本身就是 CNY)
 * 优先 financial_data.posting_totals.price.amount(订单总额)
 * 兜底 financial_data.products[].payout.amount × quantity 之和
 * 再兜底 products[].price × quantity 之和
 * 被 new-posting.js / unfulfilled-poller.js 落库时复用
 * (2026-09-18 修复:第二/三级兜底此前漏乘 quantity,多件订单金额只算了单件价)
 */
export function extractSaleAmountCny(posting) {
  if (!posting) return 0;
  const fd = posting.financial_data || {};
  const total = fd.posting_totals?.price?.amount;
  if (total != null) return Number(total) || 0;
  if (Array.isArray(fd.products)) {
    const sum = fd.products.reduce(
      (s, p) => s + (Number(p?.payout?.amount) || 0) * (Number(p?.quantity) || 1), 0);
    if (sum > 0) return sum;
  }
  if (Array.isArray(posting.products)) {
    const sum = posting.products.reduce((s, p) => {
      const price = p?.price;
      const v = typeof price === 'object' ? price?.amount : price;
      return s + (Number(v) || 0) * (Number(p?.quantity) || 1);
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
 * 数据源 op_ozon_order:webhook(NEW_POSTING 联动建单)与 API 轮询(fast/mid)双链路均落此表,
 * 比 ozon_postings(仅 webhook 落库)更全 —— webhook 停推期间轮询兜底发出的通知汇总也能算对
 * (2026-09-20 修复:此前查 ozon_postings,webhook 停推时兜底通知的汇总不含新订单导致统计不变)
 * @returns {{bySeller: Map<number, {storeName, sellerId, orderCount, saleCny}>, total: {orderCount, saleCny, validOrderCount, validSaleCny}, ready: boolean}}
 *   valid* :剔除取消类状态(API 模型,对应 PUSH_ABSORBING)后的单量/金额
 */
export function buildTodaySummaryFromDb() {
  const { start, end } = getTodayUtcRange();
  const db = getDb();
  // 按 store_id 聚合当日订单数和金额;valid_* 剔除取消类吸收态
  // op_ozon_order.status 为 Seller API 模型(cancelled/cancelled_from_split_pending/not_accepted)
  const API_CANCELED = ['cancelled', 'cancelled_from_split_pending', 'not_accepted'];
  const cancelPh = API_CANCELED.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT store_id,
      COUNT(*) AS order_count,
      COALESCE(SUM(order_amount), 0) AS sale_cny,
      SUM(CASE WHEN status IN (${cancelPh}) THEN 0 ELSE 1 END) AS valid_count,
      COALESCE(SUM(CASE WHEN status IN (${cancelPh}) THEN 0 ELSE order_amount END), 0) AS valid_cny
    FROM op_ozon_order
    WHERE in_process_at IS NOT NULL
      AND in_process_at >= ? AND in_process_at < ?
      AND currency = 'CNY'
    GROUP BY store_id
  `).all(...API_CANCELED, ...API_CANCELED, start, end);

  // 检查是否有任何金额>0 的记录
  const ready = rows.some(r => Number(r.sale_cny) > 0);

  const stores = listStores();
  const storeMap = new Map(stores.map(s => [s.id, s]));

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
    const store = storeMap.get(r.store_id);
    const sellerId = Number(store?.company_id ?? r.store_id);
    const storeName = store?.name ?? String(r.store_id);
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
 * 构造"当日到达指定状态"各店铺汇总文本块(签收/待取件/备货通知尾部,2026-09-18)
 * 参考当日销售汇总格式:按店铺 单量/销售金额 + 合计
 * 数据源:ozon_push_events 当日 STATE_CHANGED 且 new_state 命中(DISTINCT 货件去重,
 *        防同状态重复推送重复计数),金额取 ozon_postings.sale_amount_cny
 * 注:货件后续离开该状态(如取件点→签收)不影响"当日到达过"口径
 * @param {string[]} newStates 推送模型状态名(可多个,签收含 posting_delivered 同义)
 * @param {string} label 汇总标签(签收/待取件/备货)
 * @returns {string|null} 无命中返回 null
 */
function buildTodayStateSummaryLines(newStates, label) {
  const { start, end } = getTodayUtcRange();
  const likePh = newStates.map(() => 'raw_payload LIKE ?').join(' OR ');
  const patterns = newStates.map((s) => `%"new_state":"${s}"%`);
  const rows = getDb().prepare(`
    SELECT p.seller_id, COUNT(*) AS n,
      COALESCE(SUM(CASE
        WHEN p.sale_amount_cny > 0 THEN p.sale_amount_cny
        ELSE COALESCE((SELECT o.order_amount FROM op_ozon_order o
                       WHERE o.posting_number = p.posting_number AND o.currency = 'CNY'
                       ORDER BY o.order_amount DESC LIMIT 1), 0)
      END), 0) AS amount
    FROM ozon_postings p
    WHERE p.posting_number IN (
      SELECT DISTINCT e.posting_number FROM ozon_push_events e
      WHERE e.message_type = 'TYPE_STATE_CHANGED'
        AND e.received_at >= ? AND e.received_at < ?
        AND e.posting_number IS NOT NULL
        AND (${likePh})
    )
    GROUP BY p.seller_id
    ORDER BY p.seller_id
  `).all(start, end, ...patterns);
  if (rows.length === 0) return null;
  const stores = listStores();
  const storeMap = new Map(stores.map((s) => [Number(s.company_id), s]));
  const padOrder = (n) => String(n).padStart(2, ' ');
  const padAmount = (cny) => {
    const fixed = Number(cny).toFixed(2);
    const [i, d] = fixed.split('.');
    return `${i.padStart(4, ' ')}.${d}`;
  };
  const lines = [`—— 当日各店铺${label}汇总(Asia/Shanghai)——`];
  let tn = 0;
  let ta = 0;
  for (const r of rows) {
    const name = storeMap.get(Number(r.seller_id))?.name ?? String(r.seller_id);
    lines.push(`• ${name}: ${padOrder(r.n)} 单 / 销售金额 ${padAmount(r.amount)} CNY`);
    tn += r.n;
    ta += Number(r.amount) || 0;
  }
  lines.push(`合计:${padOrder(tn)} 单 / 销售金额 ${padAmount(ta)} CNY`);
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

// ── 商品明细块(2026-09-18:通知增加 SKU/OfferID/单价/重量/商品链接)────
// products 来源:①NEW_POSTING 推送(含 OPI 回拉补全,自带 dimensions.weight/CNY 单价)
//              ②CANCELLED/STATE_CHANGED/揽收推送无商品 → 查 ozon_postings.products_json
// 链接统一 /context/detail/id/{sku} 口径(与价格管理页/订单处理页一致)

/** 解析单价:兼容字符串("19.0000")/数字/对象({amount}) */
function parseProductPrice(p) {
  if (p == null) return null;
  const raw = typeof p.price === 'object' ? p.price?.amount : p.price;
  const v = raw != null ? Number(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 从本地库批量查商品重量(g):custom_weight_g 优先,attributes_cache.weight 兜底(价格管理页同口径) */
function lookupLocalWeights(skus) {
  const db = getDb();
  const ph = skus.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT CAST(pdc.sku AS TEXT) AS sku,
           COALESCE(pdc.custom_weight_g, json_extract(pac.attributes_data, '$.weight')) AS weight_g
    FROM product_data_cache pdc
    LEFT JOIN product_attributes_cache pac ON pac.sku = pdc.sku
    WHERE pdc.sku IN (${ph})
  `).all(...skus.map(String));
  const m = new Map();
  for (const r of rows) {
    const g = r.weight_g != null ? Number(r.weight_g) : NaN;
    if (Number.isFinite(g) && g > 0) m.set(r.sku, g);
  }
  return m;
}

/**
 * 构造商品明细文本块(每 SKU 一条:SKU/OfferID/数量/单价/重量/链接)
 * 重量优先级:推送 dimensions.weight(OPI 商品档案) > 本地维护/同步重量 > —
 * @param {Array} products 推送 products[](可能为空,返回 null)
 * @returns {string|null}
 */
function buildProductLines(products) {
  if (!Array.isArray(products) || products.length === 0) return null;
  const parsed = products
    .filter((p) => p?.sku != null)
    .map((p) => {
      const dimWeight = Number(p.dimensions?.weight);
      return {
        sku: String(p.sku),
        offerId: p.offer_id ?? null,
        qty: p.quantity ?? 1,
        price: parseProductPrice(p),
        ccy: p.currency_code || 'CNY',
        weightG: Number.isFinite(dimWeight) && dimWeight > 0 ? dimWeight : null,
      };
    });
  if (parsed.length === 0) return null;
  // 推送缺重量的 SKU 批量查本地兜底
  const needLocal = parsed.filter((x) => x.weightG == null).map((x) => x.sku);
  let localW = new Map();
  if (needLocal.length) {
    try { localW = lookupLocalWeights(needLocal); } catch { /* 查询失败省略重量 */ }
  }
  const lines = ['商品明细:'];
  for (const x of parsed) {
    const weightG = x.weightG ?? localW.get(x.sku) ?? null;
    lines.push(`• SKU: ${x.sku}${x.offerId ? ` | OfferID: ${x.offerId}` : ''} | 数量: ${x.qty}`);
    lines.push(`  单价: ${x.price != null ? x.price.toFixed(2) : '—'} ${x.ccy} | 重量: ${weightG != null ? `${Math.round(weightG)}g` : '—'}`);
    lines.push(`  https://ozon.ru/context/detail/id/${x.sku}`);
  }
  return lines.join('\n');
}

/** 从 ozon_postings.products_json 取商品明细(取消/状态变化/揽收推送无商品字段) */
function loadProductsFromDb(postingNumber) {
  try {
    const row = getDb()
      .prepare('SELECT products_json FROM ozon_postings WHERE posting_number = ?')
      .get(postingNumber);
    if (!row?.products_json) return null;
    const arr = JSON.parse(row.products_json);
    if (!Array.isArray(arr) || !arr.length) return null;
    // 单价兜底(2026-09-19):NEW_POSTING 时 OPI 回拉失败会落「无 price」的原始推送形态,
    // 从 erp 订单表(op_ozon_order_item,CNY 单价)回填,避免通知明细单价显示 —
    const hasMissingPrice = arr.some((p) => !(typeof p?.price === 'object' ? p?.price?.amount : p?.price));
    if (hasMissingPrice) {
      const items = getDb().prepare(
        `SELECT oi.sku, oi.price FROM op_ozon_order o
         JOIN op_ozon_order_item oi ON oi.ozon_order_id = o.id
         WHERE o.posting_number = ? AND o.currency = 'CNY' AND oi.price IS NOT NULL`
      ).all(postingNumber);
      const priceMap = new Map(items.map((it) => [String(it.sku), it.price]));
      for (const p of arr) {
        const cur = typeof p?.price === 'object' ? p?.price?.amount : p?.price;
        if (!cur && priceMap.has(String(p.sku))) {
          p.price = { amount: priceMap.get(String(p.sku)), currency_code: 'CNY' };
        }
      }
    }
    return arr;
  } catch {
    return null;
  }
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
      timeField = ['处理时间', fmtShTime(payload.in_process_at)];
      const products = Array.isArray(payload.products) ? payload.products : [];
      const totalQty = products.reduce((sum, p) => sum + (p.quantity ?? 0), 0);
      const saleCny = extractSaleAmountCny(payload);
      extra = `\n商品SKU数: ${products.length}\n商品总件数: ${totalQty}\n销售金额: ${saleCny.toFixed(2)} CNY`;
      // 商品明细块:SKU/OfferID/数量/单价/重量/链接(推送 products,OPI 回拉后自带完整字段)
      const productLines = buildProductLines(products);
      if (productLines) extra += `\n${productLines}`;
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
    case 'TYPE_POSTING_CANCELLED': {
      title = '[货件取消] Ozon 推送';
      timeField = ['取消时间', fmtShTime(payload.changed_state_date)];
      extra = `\n旧状态: ${payload.old_state ?? '-'}\n取消原因: ${formatCancelReason(payload.reason?.message) ?? '-'}`;
      // 取消推送无商品字段 → 查 ozon_postings.products_json(NEW_POSTING 落库时已存)
      const cancelProducts = loadProductsFromDb(postingNumber);
      const cancelLines = buildProductLines(cancelProducts);
      if (cancelLines) extra += `\n${cancelLines}`;
      break;
    }
    case 'TYPE_STATE_CHANGED': {
      const ns = payload.new_state ?? '';
      // 按状态细分标题(2026-09-18 分机器人路由:签收/待取件/备货)
      title = ns === 'posting_received' ? '[货件签收] Ozon 推送'
        : ns === 'posting_in_pickup_point' ? '[货件待取件] Ozon 推送'
        : (ns === 'posting_awaiting_registration' || ns === 'awaiting_deliver') ? '[货件备货] Ozon 推送'
        : '[货件状态变更] Ozon 推送';
      timeField = ['变更时间', fmtShTime(payload.changed_state_date)];
      extra = `\n新状态: ${ns || '-'}`;
      // 状态变化推送无商品字段 → 查 ozon_postings.products_json
      const changedProducts = loadProductsFromDb(postingNumber);
      const changedLines = buildProductLines(changedProducts);
      if (changedLines) extra += `\n${changedLines}`;
      // 当日状态汇总(签收/待取件/备货,参考新订单当日销售汇总格式)
      if (ns === 'posting_received') {
        summaryLines = buildTodayStateSummaryLines(['posting_received', 'posting_delivered'], '签收');
      } else if (ns === 'posting_in_pickup_point') {
        summaryLines = buildTodayStateSummaryLines(['posting_in_pickup_point'], '待取件');
      } else if (ns === 'posting_awaiting_registration' || ns === 'awaiting_deliver') {
        summaryLines = buildTodayStateSummaryLines(['posting_awaiting_registration', 'awaiting_deliver'], '备货');
      }
      break;
    }
    default:
      title = `[${messageType}] Ozon 推送`;
      timeField = ['时间', fmtShTime(new Date().toISOString())];
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
  // TYPE_NEW_POSTING → 新订单机器人
  // TYPE_STATE_CHANGED → 按状态分路由(2026-09-18):
  //   posting_received 签收 / posting_in_pickup_point 待取件 /
  //   posting_awaiting_registration|awaiting_deliver 备货 / 其它 状态变更默认机器人;
  //   posting_transferring_to_delivery 不通知(转运在途无运营动作)
  let url;
  if (messageType === 'TYPE_POSTING_CANCELLED') {
    url = config.feishu.webhookUrlCancel;
  } else if (messageType === 'TYPE_NEW_POSTING') {
    url = config.feishu.webhookUrlNew;
  } else if (messageType === 'TYPE_STATE_CHANGED') {
    const ns = payload.new_state ?? '';
    if (ns === 'posting_transferring_to_delivery') {
      logger.info({ postingNumber, newState: ns }, 'feishu-notify: transferring_to_delivery 跳过通知');
      return false;
    }
    url = ns === 'posting_received' ? config.feishu.webhookUrlReceived
      : ns === 'posting_in_pickup_point' ? config.feishu.webhookUrlPickupPoint
        : (ns === 'posting_awaiting_registration' || ns === 'awaiting_deliver') ? config.feishu.webhookUrlStocking
          : config.feishu.webhookUrlDefault;
  } else {
    url = config.feishu.webhookUrlDefault;
  }

  // 返回发送结果(boolean):调用方(webhook 打标 / API 兜底释放标记)依赖此返回值
  return await sendFeishuText(text, url);
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
    `变更时间: ${fmtShTime(payload.changed_state_date)}`,
    `新状态: ${payload.new_state ?? '-'}`,
    payload.old_state ? `旧状态: ${payload.old_state}` : null,
    // 揽收推送无商品字段 → 查 ozon_postings.products_json
    buildProductLines(loadProductsFromDb(postingNumber)),
    pickupLines ? '' : null,
    pickupLines,
  ].filter((v) => v !== null).join('\n');

  // 返回发送结果(boolean):调用方(webhook 打标 / API 兜底释放标记)依赖此返回值
  return await sendFeishuText(text, config.feishu.webhookUrlPickup);
}

/**
 * 取消原因俄语→中文翻译(实时取消推送用)
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
