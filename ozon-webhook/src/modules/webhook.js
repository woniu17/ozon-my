// Webhook 接收端点:POST /webhook/ozon
// 5 秒内必须返回;只做"鉴权→回 200",raw_payload 落 ozon_push_events 表用 setImmediate 异步执行
// 真正业务(handler 更新 ozon_postings / OPI 回拉 / 推飞书)由 poller 异步消费
import Router from '@koa/router';
import config from '../config/index.js';
import { insertEvent } from '../db/dao/event-dao.js';
import { AppError } from '../middleware/error.js';
import logger from '../middleware/log.js';
import { genIdempotencyKey, extractIndexFields } from '../utils/idempotency.js';
import { getStoresMeta, loadStores } from '../services/store-loader.js';

const router = new Router();

router.post('/webhook/ozon', async (ctx) => {
  const payload = ctx.request.body ?? {};

  const messageType = payload.message_type;
  if (!messageType) {
    throw new AppError({
      status: 400,
      code: 'ERROR_PARAMETER_VALUE_MISSED',
      message: 'message_type 缺失',
    });
  }

  // TYPE_PING:不落库,直接返回 {version,name,time}
  if (messageType === 'TYPE_PING') {
    ctx.body = {
      version: config.appVersion,
      name: config.appName,
      time: new Date().toISOString(),
    };
    return;
  }

  // 生成幂等键
  const idempotencyKey = genIdempotencyKey(messageType, payload);
  if (idempotencyKey == null) {
    ctx.body = { result: true };
    return;
  }

  // 提取索引字段 + 序列化 raw_payload(避免异步执行时 payload 被后续中间件修改)
  const fields = extractIndexFields(messageType, payload);
  const rawPayload = JSON.stringify(payload);

  // 异步落库:不 await,失败仅记录日志,不影响 200 响应
  // 风险:服务进程在 setImmediate 触发前崩溃会导致事件丢失(Ozon 已收到 200 不会重试)
  setImmediate(() => {
    try {
      const result = insertEvent({
        message_type: messageType,
        idempotency_key: idempotencyKey,
        seller_id: fields.seller_id,
        posting_number: fields.posting_number,
        product_id: fields.product_id,
        sku: fields.sku,
        chat_id: fields.chat_id,
        order_number: fields.order_number,
        raw_payload: rawPayload,
      });
      if (!result.inserted) {
        logger.info({ messageType, idempotencyKey }, '重复推送,幂等返回(异步落库)');
      }
    } catch (err) {
      logger.error({ err, messageType, idempotencyKey }, '异步落库失败:事件可能丢失');
    }
  });

  // 立即返回 200,不等落库完成
  ctx.body = { result: true };
});

router.get('/health', async (ctx) => {
  ctx.body = {
    status: 'ok',
    name: config.appName,
    version: config.appVersion,
    stores: getStoresMeta(),
  };
});

// 重新加载店铺凭据(运行时 erp 的 stores.json 变更后调用)
// POST /admin/stores/reload
router.post('/admin/stores/reload', async (ctx) => {
  const result = loadStores();
  ctx.body = { ok: true, ...result };
});

export default router;
