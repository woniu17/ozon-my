// Webhook 接收端点(2026-09-17 自 ozon-webhook 迁入,Express 化)
// POST /webhook/ozon:鉴权(IP 白名单)→ 同步落库 → 返回 200
// 落库改同步执行(node:sqlite prepare 为同步 API,毫秒级),
// 修掉原 setImmediate 异步落库在进程崩溃时丢事件的缺陷
// 真正业务(handler 更新 ozon_postings / OPI 回拉 / 推飞书)由 event-poller 异步消费
// GET /webhook/health:探活(nginx/监控用,不受 IP 白名单限制)
import { Router } from 'express';
import config from '../config/index.js';
import { insertEvent } from '../db/dao/sqlite/event-dao.js';
import { ipWhitelist } from '../middleware/ip-whitelist.js';
import logger from '../middleware/log.js';
import { genIdempotencyKey, extractIndexFields } from '../services/webhook/idempotency.js';
import { getStoresMeta } from '../services/webhook/store-map.js';

const router = Router();

router.post('/webhook/ozon', ipWhitelist, (req, res) => {
  const payload = req.body ?? {};

  const messageType = payload.message_type;
  if (!messageType) {
    // Ozon 错误模板:{ error: { code, message, details } }
    return res.status(400).json({
      error: { code: 'ERROR_PARAMETER_VALUE_MISSED', message: 'message_type 缺失', details: null },
    });
  }

  // TYPE_PING:不落库,直接返回 {version,name,time}
  if (messageType === 'TYPE_PING') {
    return res.json({
      version: config.appVersion,
      name: config.appName,
      time: new Date().toISOString(),
    });
  }

  // 生成幂等键
  const idempotencyKey = genIdempotencyKey(messageType, payload);
  if (idempotencyKey == null) {
    return res.json({ result: true });
  }

  // 提取索引字段 + 序列化 raw_payload
  const fields = extractIndexFields(messageType, payload);

  // 同步落库:命中 UNIQUE 幂等返回;失败仅记日志,仍回 200
  // (Ozon 对 5xx 会重试,但接收路径自身异常不应拖垮整个服务)
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
      raw_payload: JSON.stringify(payload),
    });
    if (!result.inserted) {
      logger.info({ messageType, idempotencyKey }, '重复推送,幂等返回');
    }
  } catch (err) {
    logger.error({ err, messageType, idempotencyKey }, '落库失败:事件可能丢失');
  }

  res.json({ result: true });
});

// 探活(原 /health 换路径,避免与 erp 既有 /health 冲突;带 stores 元信息)
router.get('/webhook/health', (_req, res) => {
  res.json({
    status: 'ok',
    name: config.appName,
    version: config.appVersion,
    stores: getStoresMeta(),
  });
});

export default router;
