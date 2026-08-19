// Event Poller:异步消费 ozon_push_events
// 仿 erp-backend-lite batch-upload-poller.js 模式
import config from '../config/index.js';
import { claimPendingEvents, markSuccess, markFailed } from '../db/dao/event-dao.js';
import handlers from '../handlers/index.js';
import logger from '../middleware/log.js';

let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const events = claimPendingEvents(config.poller.concurrency, config.poller.maxRetry);
    for (const ev of events) {
      try {
        const handler = handlers[ev.message_type];
        if (!handler) {
          throw new Error(`unsupported message_type: ${ev.message_type}`);
        }
        const payload = JSON.parse(ev.raw_payload);
        await handler(payload, { eventId: ev.id });
        markSuccess(ev.id);
        logger.info({ id: ev.id, type: ev.message_type }, 'event 处理成功');
      } catch (err) {
        const newStatus = markFailed(ev.id, ev.retry_count, config.poller.maxRetry, err.message);
        logger.warn({ id: ev.id, type: ev.message_type, err: err.message, newStatus }, 'event 处理失败');
      }
    }
  } catch (err) {
    logger.error({ err }, 'poller tick 异常');
  } finally {
    running = false;
  }
}

export function startEventPoller() {
  if (timer) return;
  logger.info({ intervalMs: config.poller.intervalMs, concurrency: config.poller.concurrency }, '启动 Event Poller');
  // 启动后立即跑一次,再进入定时
  tick().catch(err => logger.error({ err }, '首次 tick 失败'));
  timer = setInterval(() => { tick().catch(err => logger.error({ err }, 'tick 失败')); }, config.poller.intervalMs);
}

export function stopEventPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Event Poller 已停止');
  }
}
