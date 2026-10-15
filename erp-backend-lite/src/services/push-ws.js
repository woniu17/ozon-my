// WebSocket 推送端点（2026-10 第二版）
//
// 与长轮询共用 push-hub 广播：同一事件流同时推给 WebSocket 客户端和长轮询等待者。
// - 路径：/admin/api/push/ws（JWT 认证，Authorization: Bearer <token>）
// - 认证在 upgrade 阶段完成（noServer 模式）：token 无效直接返回 HTTP 401，
//   Android 端可像长轮询一样识别 401 并登出。
// - 心跳：每 30s ping 一次，连续一个周期无 pong 的死连接被清理
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { addWsClient, removeWsClient, heartbeatWsClients } from './push-hub.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_PATH = '/admin/api/push/ws';

/**
 * 在已有 HTTP server 上挂载 WebSocket 推送端点。
 * @param {import('node:http').Server} server
 */
export function setupPushWs(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    // JWT 认证：与 HTTP 接口一致，从 Authorization 头取 Bearer token
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      jwt.verify(token, config.jwtSecret);
    } catch (_) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    addWsClient(ws);
    ws.on('close', () => removeWsClient(ws));
    ws.on('error', () => removeWsClient(ws));
  });

  // 心跳巡检（unref：不阻止进程退出）
  const heartbeat = setInterval(() => heartbeatWsClients(), HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  logger.info('🚀 WebSocket 推送端点已启动: /admin/api/push/ws');
  return wss;
}