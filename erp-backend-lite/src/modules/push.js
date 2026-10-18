// 推送接收端点（长轮询，2026-10 新增）
//
// GET /admin/api/push/events?timeout=25000
//   - 有事件立即返回 { events: [event] }
//   - 超时返回 { events: [] }
// GET /admin/api/push/logs?limit=100
//   - 返回安卓通知推送日志（通知序列表用），按 id 倒序
// 走 authMiddleware（JWT 保护），与其它 /admin/api 路由一致。
import { Router } from 'express';
import { subscribe } from '../services/push-hub.js';
import { getDb } from '../db/index.js';

const router = Router();

router.get('/admin/api/push/events', (req, res) => {
  const timeout = Number(req.query.timeout) || 25_000;
  subscribe(req, res, timeout);
});

// 通知推送日志（2026-10-18 用户要求：问题排查 + 安卓端消息推送序列表）
router.get('/admin/api/push/logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = getDb()
    .prepare(
      `SELECT id, type, posting_number, store_name, amount, item_count,
              product_image_url, package_id, machine_name, occurred_at, created_at
       FROM notification_log
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit);
  res.json({ logs: rows });
});

export default router;