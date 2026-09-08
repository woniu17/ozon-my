// 飞书机器人通知(货件相关推送)
// 参考 get-shop-product/httpsrv/feishuHelper.js,改写为 ESM
// 仅用于 FBS/rFBS 货件级通知(TYPE_NEW_POSTING/POSTING_CANCELLED/STATE_CHANGED)
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { getStoreBySellerId } from './store-loader.js';

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
  const postingNumber = payload.posting_number ?? '-';
  const sellerId = payload.seller_id ?? '-';

  let title;
  let timeField;
  let extra = '';
  switch (messageType) {
    case 'TYPE_NEW_POSTING': {
      // 02131/024785 开头的货件号为质检单,其余为新订单
      const store = getStoreBySellerId(sellerId);
      const sellerName = store ? store.name : String(sellerId);
      const isQc = typeof postingNumber === 'string'
        && (postingNumber.startsWith('02131') || postingNumber.startsWith('024785'));
      title = `[${isQc ? '新质检单' : '新订单'}] [${sellerName}] [${postingNumber}]`;
      timeField = ['处理时间', payload.in_process_at ?? '-'];
      const products = Array.isArray(payload.products) ? payload.products : [];
      const totalQty = products.reduce((sum, p) => sum + (p.quantity ?? 0), 0);
      extra = `\n商品SKU数: ${products.length}\n商品总件数: ${totalQty}`;
      // 商品链接去重后逐行列出
      const links = [...new Set(
        products
          .filter((p) => p.sku != null)
          .map((p) => `https://www.ozon.ru/product/${p.sku}`),
      )];
      if (links.length) extra += `\n商品链接:\n${links.join('\n')}`;
      if (payload.tracking_number) extra += `\n跟踪号: ${payload.tracking_number}`;
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
  ].filter(Boolean).join('\n');

  // 按消息类型路由到不同飞书机器人:
  // TYPE_POSTING_CANCELLED → 货件取消机器人
  // TYPE_NEW_POSTING / TYPE_STATE_CHANGED → 新订单/货件机器人
  const url = messageType === 'TYPE_POSTING_CANCELLED'
    ? config.feishu.webhookUrlCancel
    : config.feishu.webhookUrlNew;

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
    links.length ? `商品链接:\n${links.join('\n')}` : null,
    posting.tracking_number ? `跟踪号: ${posting.tracking_number}` : null,
    '', // 空行分隔
    todaySummaryLines,
    '(兜底通知)', // 末行标注,与 Ozon 实时推送区分
  ].filter((v) => v !== null).join('\n');

  // 新订单/货件机器人
  await sendFeishuText(text, config.feishu.webhookUrlNew);
}
