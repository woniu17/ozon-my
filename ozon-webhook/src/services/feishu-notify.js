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
 * @returns {Promise<boolean>} 是否发送成功
 */
export async function sendFeishuText(text) {
  const url = config.feishu.webhookUrl;
  if (!url) {
    logger.warn('feishu-notify: 未配置 FEISHU_WEBHOOK_URL,跳过推送');
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

  await sendFeishuText(text);
}
