// 飞书机器人通知(订单相关推送)
// 参考 get-shop-product/httpsrv/feishuHelper.js,改写为 ESM
// 仅用于 ORDER 级通知(TYPE_ORDER_NEW/CANCELLED/STATE_CHANGED)
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
 * 推送订单级通知到飞书
 * @param {string} messageType TYPE_ORDER_NEW / TYPE_ORDER_CANCELLED / TYPE_ORDER_STATE_CHANGED
 * @param {object} payload Ozon 推送原始 payload
 */
export async function notifyOrderEvent(messageType, payload) {
  const orderNumber = payload.order_number ?? '-';
  const orderId = payload.order_id ?? '-';
  const sellerId = payload.seller_id ?? '-';
  const uuid = payload.uuid ?? '-';

  let title;
  let timeField;
  let extra = '';
  switch (messageType) {
    case 'TYPE_ORDER_NEW':
      title = '[新订单] Ozon 推送';
      timeField = ['创建时间', payload.created_at ?? '-'];
      break;
    case 'TYPE_ORDER_CANCELLED':
      title = '[订单取消] Ozon 推送';
      timeField = ['取消时间', payload.cancelled_at ?? '-'];
      break;
    case 'TYPE_ORDER_STATE_CHANGED':
      title = '[订单状态变更] Ozon 推送';
      timeField = ['变更时间', payload.updated_at ?? '-'];
      extra = `\n旧状态: ${payload.old_state ?? '-'}\n新状态: ${payload.new_state ?? '-'}`;
      break;
    default:
      title = `[${messageType}] Ozon 推送`;
      timeField = ['时间', new Date().toISOString()];
  }

  const text = [
    title,
    `订单号: ${orderNumber}`,
    `订单ID: ${orderId}`,
    `卖家: ${formatSeller(sellerId)}`,
    `${timeField[0]}: ${timeField[1]}`,
    extra,
  ].filter(Boolean).join('\n');

  await sendFeishuText(text);
}
