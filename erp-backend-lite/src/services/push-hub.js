// 服务端推送 Hub（2026-10 新增，长轮询第一版 / WebSocket 第二版）
//
// 设计：
// - 传输层解耦：业务 handler 只调 publishPostingEvent()，不关心 Android 用什么方式接收。
// - 长轮询：GET /admin/api/push/events 挂起默认 25s，有事件立即返回 {events:[...]}，超时返回 {events:[]}。
// - WebSocket：/admin/api/push/ws（JWT 认证），连接建立后实时推送同一事件流。
// - 内存单进程实现（pm2 单实例）；重启丢失连接是正常现象，客户端重连即恢复。
import { getStoreBySellerId } from './webhook/store-map.js';
import { extractSaleAmountCny } from './webhook/feishu-notify.js';
import { orderPackageDao } from '../db/dao/sqlite/order-daos.js';
import logger from '../middleware/log.js';

/** 等待中的长轮询连接 */
const waiters = new Set();

/** 已连接的 WebSocket 客户端（值：ws 实例） */
const wsClients = new Set();

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_TIMEOUT_MS = 30_000;

/** 移除等待者：清定时器 + 置 done 防重复写响应 */
function removeWaiter(waiter) {
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.done = true;
  waiters.delete(waiter);
}

/** 向单个等待者返回事件（空数组 = 超时） */
function flush(waiter, events) {
  if (waiter.done) return;
  removeWaiter(waiter);
  try {
    if (!waiter.req.destroyed && !waiter.res.headersSent) {
      waiter.res.json({ events });
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'push-hub: 响应写入失败');
  }
}

/**
 * 注册一个长轮询等待者。
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} [timeoutMs] 挂起时长（默认 25s，上限 30s，需小于 nginx proxy_read_timeout）
 */
export function subscribe(req, res, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const t = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const waiter = { req, res, timer: null, done: false };
  waiters.add(waiter);
  waiter.timer = setTimeout(() => flush(waiter, []), t);
  // 客户端断开/响应完成时清理，防止写已关闭的连接
  req.on('close', () => removeWaiter(waiter));
}

/**
 * 注册一个已通过认证的 WebSocket 客户端（push-ws 握手后调用）。
 * @param {import('ws').WebSocket} ws
 */
export function addWsClient(ws) {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  wsClients.add(ws);
  logger.info({ online: wsClients.size }, 'push-hub: WebSocket 客户端已连接');
}

/** 移除 WebSocket 客户端（连接关闭/异常时调用）。 */
export function removeWsClient(ws) {
  wsClients.delete(ws);
  logger.info({ online: wsClients.size }, 'push-hub: WebSocket 客户端已断开');
}

/** WebSocket 心跳巡检：清除超过一个心跳周期未响应 pong 的死连接。 */
export function heartbeatWsClients() {
  for (const ws of [...wsClients]) {
    if (!ws.isAlive) {
      removeWsClient(ws);
      try {
        ws.terminate();
      } catch (_) {
        // 已关闭则忽略
      }
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      removeWsClient(ws);
    }
  }
}

/**
 * 向所有在线客户端广播事件（长轮询 + WebSocket 双通道）。
 * @param {object} event 事件对象（将被 JSON 序列化）
 */
export function publish(event) {
  const events = [event];
  const text = JSON.stringify({ events });

  if (waiters.size > 0) {
    for (const waiter of [...waiters]) flush(waiter, events);
  }

  if (wsClients.size > 0) {
    for (const ws of [...wsClients]) {
      if (ws.readyState !== 1 /* WebSocket.OPEN */) continue;
      try {
        ws.send(text);
      } catch (err) {
        logger.warn({ err: err.message }, 'push-hub: WebSocket 发送失败');
        removeWsClient(ws);
      }
    }
  }

  const online = waiters.size + wsClients.size;
  if (online > 0) {
    logger.info(
      { type: event.type, postingNumber: event.postingNumber, online },
      'push-hub: 事件已广播'
    );
  }
}

/**
 * 把 Ozon 货件推送转换为 Android 新订单事件并广播。
 * 第一版只处理 TYPE_NEW_POSTING（新订单）；取消/状态变更后续按需扩展。
 * @param {string} messageType Ozon 推送类型（TYPE_NEW_POSTING / ...）
 * @param {object} payload Ozon 推送原始 payload（可能经 OPI 回拉补全）
 */
export function publishPostingEvent(messageType, payload) {
  if (messageType !== 'TYPE_NEW_POSTING') return;
  const postingNumber = payload?.posting_number;
  if (!postingNumber) return;

  const sellerId = payload.seller_id;
  const storeName =
    sellerId != null ? (getStoreBySellerId(sellerId)?.name ?? String(sellerId)) : '';
  const amount = extractSaleAmountCny(payload);

  let waitProcessCount = 0;
  try {
    waitProcessCount = orderPackageDao.tabCounts().waitProcess || 0;
  } catch (err) {
    logger.warn({ err: err.message }, 'push-hub: 查询 waitProcess 计数失败，按 0 处理');
  }

  publish({
    type: 'NEW_ORDER',
    postingNumber,
    storeName,
    amount,
    waitProcessCount,
    occurredAt: new Date().toISOString(),
  });
}