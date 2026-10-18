// 服务端推送 Hub（2026-10 新增，长轮询第一版 / WebSocket 第二版）
//
// 设计：
// - 传输层解耦：业务 handler 只调 publishPostingEvent()，不关心 Android 用什么方式接收。
// - 长轮询：GET /admin/api/push/events 挂起默认 25s，有事件立即返回 {events:[...]}，超时返回 {events:[]}。
// - WebSocket：/admin/api/push/ws（JWT 认证），连接建立后实时推送同一事件流。
// - 内存单进程实现（pm2 单实例）；重启丢失连接是正常现象，客户端重连即恢复。
import { getStoreBySellerId } from './webhook/store-map.js';
import { resolveSaleAmountCny } from './webhook/feishu-notify.js';
import { orderPackageDao } from '../db/dao/sqlite/order-daos.js';
import { getDb } from '../db/index.js';
import logger from '../middleware/log.js';
import config from '../config/index.js';
import { imageCacheUrlFor } from './order-image-cache.js';

/** 等待中的长轮询连接 */
const waiters = new Set();

/** 已连接的 WebSocket 客户端（值：ws 实例） */
const wsClients = new Set();

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_TIMEOUT_MS = 30_000;

/**
 * 按货件号查包裹 id（2026-10-17 安卓通知点击跳转订单详情用）。
 * op_package 与 op_ozon_order 通过 ozon_order_id 关联,posting_number 即货件号。
 */
function resolvePackageId(postingNumber) {
  try {
    const row = getDb()
      .prepare(
        `SELECT p.id AS package_id
         FROM op_package p
         JOIN op_ozon_order o ON o.id = p.ozon_order_id
         WHERE o.posting_number = ?`
      )
      .get(postingNumber);
    return row ? String(row.package_id) : '';
  } catch (_) {
    return '';
  }
}

/**
 * 查货件商品总数量（2026-10-18 安卓通知第二行 xN 用）。
 * 优先 payload 的 products[].quantity 求和（新订单 OPI 回拉含商品明细），
 * 兜底 op_ozon_order_item SUM(quantity)（取消/状态/揽收推送无商品明细）。
 */
function resolveItemCount(postingNumber, payload) {
  if (payload && Array.isArray(payload.products)) {
    const sum = payload.products.reduce((s, p) => s + (Number(p?.quantity) || 0), 0);
    if (sum > 0) return sum;
  }
  try {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(oi.quantity), 0) AS cnt
         FROM op_ozon_order_item oi
         JOIN op_ozon_order o ON o.id = oi.ozon_order_id
         WHERE o.posting_number = ?`
      )
      .get(String(postingNumber));
    return row ? Number(row.cnt) || 0 : 0;
  } catch (_) {
    return 0;
  }
}

/**
 * 查货件商品首图直链（2026-10-16 安卓通知大图用）。
 * 与 records 接口同源：op_ozon_order_item JOIN product_data_cache，
 * primary_image[0] 优先、images[0] 兜底（ir-20.ozonstatic.cn 直链）。
 *
 * 2026-10-18 改为返回相对路径：推送事件无请求上下文，图床 base 固定取配置的公网域名，
 * 而安卓 App 在内网模式下 API 走 192.168.1.212:3001（列表图片按 Host 返回内网地址可正常加载，
 * 通知图片却走公网域名导致加载失败）。改为相对路径后安卓端用自身 Api.BASE_URL 拼接，
 * 内网/公网自动适配，根治"通知无图"。
 */
function resolveProductImageUrl(postingNumber) {
  try {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(
                  json_extract(p.data, '$.primary_image[0]'),
                  json_extract(p.data, '$.images[0]')
                ) AS pic_url
         FROM op_ozon_order_item oi
         JOIN op_ozon_order o ON o.id = oi.ozon_order_id
         LEFT JOIN product_data_cache p ON p.sku = CAST(oi.sku AS TEXT)
         WHERE o.posting_number = ?
         ORDER BY oi.id
         LIMIT 1`
      )
      .get(String(postingNumber));
    // 输出层重写为本地图床 URL(2026-10 图片本地化),未配置图床时透传原 URL
    return toRelativeImageUrl(imageCacheUrlFor(row?.pic_url));
  } catch (err) {
    logger.warn({ err: err.message, postingNumber }, 'push-hub: 查询商品首图失败');
    return null;
  }
}

/**
 * 图片绝对 URL → 相对路径（2026-10-18 推送事件用）。
 * 仅本地图床 URL（含 /images/cache/）转为 path+query；非图床 URL 原样返回，
 * 避免 Ozon 原图直链被错误相对化。
 */
function toRelativeImageUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!/^https?:\/\//i.test(s)) return s;
  if (!s.includes('/images/cache/')) return s;
  try {
    const u = new URL(s);
    return u.pathname + u.search;
  } catch {
    return s;
  }
}

/**
 * 记录安卓通知推送日志（2026-10-18 用户要求，便于问题排查 + 安卓端推送序列表）。
 * 每次 publishPostingEvent 广播前写入；写库失败只告警，不阻塞推送主流程。
 */
function logNotification(event) {
  try {
    const now = new Date();
    // 北京时间 yyyy-MM-dd HH:mm:ss（与安卓端展示一致）
    const createdAt = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    getDb()
      .prepare(
        `INSERT INTO notification_log
          (type, posting_number, store_name, amount, item_count, product_image_url,
           package_id, machine_name, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.type || '',
        event.postingNumber || null,
        event.storeName || null,
        event.amount || 0,
        event.itemCount || 0,
        event.productImageUrl || null,
        event.packageId || null,
        event.machineName || null,
        event.occurredAt || null,
        createdAt
      );
  } catch (err) {
    logger.warn({ err: err.message, type: event?.type, postingNumber: event?.postingNumber }, 'push-hub: 写入通知日志失败');
  }
}

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
 * 把 Ozon 货件推送转换为 Android 事件并广播（2026-10 扩展：对齐飞书通知全部类型）。
 * 与飞书通知共用调用入口（feishu-notify.notifyPostingEvent/notifyPostingPickedUp），
 * 因此也复用飞书的 feishu_*_notified_at claim 去重——claim 成功才会进入广播，
 * 双链路（webhook/轮询兜底）不会重复推送。Android 端另有本地去重，双保险。
 *
 * 事件类型：
 * - TYPE_NEW_POSTING      → NEW_ORDER       （新订单）
 * - TYPE_POSTING_CANCELLED→ ORDER_CANCELLED （取消，带 cancelReason）
 * - TYPE_STATE_CHANGED    → STATE_CHANGED   （状态变更，带 newState/subState：received/pickup_point/stocking/other）
 * - PICKUP                → PICKED_UP       （揽收，带 newState）
 *
 * @param {string} messageType Ozon 推送类型（TYPE_NEW_POSTING / TYPE_POSTING_CANCELLED / TYPE_STATE_CHANGED / PICKUP）
 * @param {object} payload Ozon 推送原始 payload（可能经 OPI 回拉补全）
 */
export function publishPostingEvent(messageType, payload) {
  const postingNumber = payload?.posting_number;
  if (!postingNumber) return;

  const sellerId = payload.seller_id;
  const storeName =
    sellerId != null ? (getStoreBySellerId(sellerId)?.name ?? String(sellerId)) : '';
  const amount = resolveSaleAmountCny(payload);

  let waitProcessCount = 0;
  try {
    waitProcessCount = orderPackageDao.tabCounts().waitProcess || 0;
  } catch (err) {
    logger.warn({ err: err.message }, 'push-hub: 查询 waitProcess 计数失败，按 0 处理');
  }

  const base = {
    postingNumber,
    storeName,
    amount,
    waitProcessCount,
    // 机器名(2026-10-16 多机部署区分):安卓通知标题/摘要尾部展示来源
    machineName: config.machineName,
    // 商品首图直链(2026-10-16 通知大图用,可能为 null,安卓端失败降级为纯文本通知)
    productImageUrl: resolveProductImageUrl(postingNumber),
    // 商品总数量(2026-10-18 通知第二行 xN 用,0 表示未知,安卓端隐藏数量)
    itemCount: resolveItemCount(postingNumber, payload),
    // 包裹 id(2026-10-17 通知点击跳转订单详情用,空则安卓端退化为打开订单列表)
    packageId: resolvePackageId(postingNumber),
    occurredAt: new Date().toISOString(),
  };

  switch (messageType) {
    case 'TYPE_NEW_POSTING': {
      const event = { type: 'NEW_ORDER', ...base };
      logNotification(event);
      publish(event);
      break;
    }
    case 'TYPE_POSTING_CANCELLED': {
      const event = {
        type: 'ORDER_CANCELLED',
        ...base,
        cancelReason: payload.reason?.message ?? null,
        changedStateDate: payload.changed_state_date ?? null,
      };
      logNotification(event);
      publish(event);
      break;
    }
    case 'TYPE_STATE_CHANGED': {
      const ns = payload.new_state ?? '';
      if (ns === 'posting_transferring_to_delivery') {
        // 与飞书一致：转运在途无运营动作，不推送
        return;
      }
      let subState = 'other';
      if (ns === 'posting_received') subState = 'received';
      else if (ns === 'posting_in_pickup_point') subState = 'pickup_point';
      else if (ns === 'posting_awaiting_registration' || ns === 'awaiting_deliver') subState = 'stocking';
      // 精确中文状态(2026-10-18 修正"待备货"歧义:awaiting_deliver 已是备货完成等待发运)
      // 2026-10-18 通知文案精简:等待登记→备货, 等待发运→揽收, 已签收→签收, 到达取货点→待取
      const stateLabel =
        ns === 'posting_awaiting_registration'
          ? '备货'
          : ns === 'awaiting_deliver'
            ? '揽收'
            : ns === 'posting_received' || ns === 'posting_delivered'
              ? '签收'
              : ns === 'posting_in_pickup_point'
                ? '待取'
                : ns || '';
      const event = {
        type: 'STATE_CHANGED',
        ...base,
        newState: ns,
        subState,
        stateLabel,
        changedStateDate: payload.changed_state_date ?? null,
      };
      logNotification(event);
      publish(event);
      break;
    }
    case 'PICKUP': {
      const event = {
        type: 'PICKED_UP',
        ...base,
        newState: payload.new_state ?? null,
        changedStateDate: payload.changed_state_date ?? null,
      };
      logNotification(event);
      publish(event);
      break;
    }
    default:
      // 未知类型不推送
      break;
  }
}