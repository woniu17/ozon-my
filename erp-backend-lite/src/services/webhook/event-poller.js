// Event Poller:异步消费 ozon_push_events
// 仿 erp-backend-lite batch-upload-poller.js 模式
import config from '../../config/index.js';
import {
  claimPendingEvents,
  markSuccess,
  markFailed,
  markDead,
  reclaimAllProcessing,
  reclaimStaleProcessing,
} from '../../db/dao/sqlite/event-dao.js';
import handlers from './handlers/index.js';
import logger from '../../middleware/log.js';

let timer = null;
let sweepTimer = null;
let running = false;

// 卡死扫描节奏:窗口本身由 POLLER_STALE_RECLAIM_MS 决定(默认 10min),扫得比它勤即可
const SWEEP_INTERVAL_MS = 60 * 1000;

async function tick() {
  if (running) return;
  running = true;
  try {
    const events = claimPendingEvents(config.webhook.poller.concurrency, config.webhook.poller.maxRetry);
    for (const ev of events) {
      try {
        const handler = handlers[ev.message_type];
        if (!handler) {
          // 未知类型:不可恢复,立即 dead,不重试
          markDead(ev.id, `unsupported message_type: ${ev.message_type}`);
          logger.warn({ id: ev.id, type: ev.message_type, newStatus: 'dead' }, '未知类型,直接 dead');
          continue;
        }
        const payload = JSON.parse(ev.raw_payload);
        await handler(payload, { eventId: ev.id });
        markSuccess(ev.id);
        logger.info({ id: ev.id, type: ev.message_type }, 'event 处理成功');
      } catch (err) {
        const newStatus = markFailed(ev.id, ev.retry_count, config.webhook.poller.maxRetry, err.message);
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
  // 启动先收残留 processing:进程刚起来,本进程不可能有在途 handler,
  // 这些一定是上次崩溃/被 kill 时丢在空气中的孤儿,不收就永久卡在 processing
  const orphan = reclaimAllProcessing();
  if (orphan > 0) {
    logger.warn({ orphan }, '启动回收:processing 孤儿事件已放回 pending');
  }
  logger.info(
    { intervalMs: config.webhook.poller.intervalMs, concurrency: config.webhook.poller.concurrency, staleReclaimMs: config.webhook.poller.staleReclaimMs },
    '启动 Event Poller',
  );
  // 启动后立即跑一次,再进入定时
  tick().catch(err => logger.error({ err }, '首次 tick 失败'));
  timer = setInterval(() => { tick().catch(err => logger.error({ err }, 'tick 失败')); }, config.webhook.poller.intervalMs);
  // 运行期扫描:进程没重启但 handler 挂死超过窗口的,放回 pending 重投。
  // 代价是极慢 handler(>窗口)会被重复处理一次;10min 窗口对秒级完成的
  // Ozon API 调用足够宽,而漏掉一个订单状态变更的代价更大。
  sweepTimer = setInterval(() => {
    try {
      const n = reclaimStaleProcessing(config.webhook.poller.staleReclaimMs);
      if (n > 0) logger.warn({ n, staleMs: config.webhook.poller.staleReclaimMs }, '卡死 processing 事件已放回 pending');
    } catch (err) {
      logger.error({ err }, 'stale reclaim 异常');
    }
  }, SWEEP_INTERVAL_MS);
}

export function stopEventPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  logger.info('Event Poller 已停止');
}
