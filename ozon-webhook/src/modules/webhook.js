// Webhook 接收端点:POST /webhook/ozon
// 5 秒内必须返回;只做"鉴权→落库→回 200",真正业务由 poller 异步处理
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

  // 落库(命中重复直接返回 200,避免 Ozon 重试计数)
  const fields = extractIndexFields(messageType, payload);
  const result = insertEvent({
    message_type: messageType,
    idempotency_key: idempotencyKey,
    seller_id: fields.seller_id,
    posting_number: fields.posting_number,
    product_id: fields.product_id,
    sku: fields.sku,
    raw_payload: JSON.stringify(payload),
  });

  if (!result.inserted) {
    logger.info({ messageType, idempotencyKey }, '重复推送,幂等返回');
  }

  // 立即返回 200,不等 poller 处理
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
