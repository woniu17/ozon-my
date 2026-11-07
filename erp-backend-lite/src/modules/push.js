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

// 查询某货件是否已推送过新订单通知（2026-11-07 新增）
// 供安卓端差集兜底二次去重：差集识别出"新增"订单时先查服务端权威记录，
// 已推送过则只更新基线不重复弹通知，避免待处理列表排名波动导致重复推送。
// GET /admin/api/push/notified?postingNumber=0259566705-0021-1
//   → { notified: true, notifiedAt: '2026-11-07 00:06:35' }
router.get('/admin/api/push/notified', (req, res) => {
  const postingNumber = String(req.query.postingNumber || '').trim();
  if (!postingNumber) {
    return res.status(400).json({ error: 'postingNumber 必填' });
  }
  const row = getDb()
    .prepare(
      `SELECT created_at
       FROM notification_log
       WHERE type = 'NEW_ORDER' AND posting_number = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(postingNumber);
  res.json({
    notified: !!row,
    notifiedAt: row ? row.created_at : null,
  });
});

export default router;