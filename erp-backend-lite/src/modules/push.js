// 推送接收端点（长轮询，2026-10 新增）
//
// GET /admin/api/push/events?timeout=25000
//   - 有事件立即返回 { events: [event] }
//   - 超时返回 { events: [] }
// 走 authMiddleware（JWT 保护），与其它 /admin/api 路由一致。
import { Router } from 'express';
import { subscribe } from '../services/push-hub.js';

const router = Router();

router.get('/admin/api/push/events', (req, res) => {
  const timeout = Number(req.query.timeout) || 25_000;
  subscribe(req, res, timeout);
});

export default router;