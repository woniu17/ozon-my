// 代采端点契约(feature-flag: proxy_collect)
// 对齐 0.13 browser-agents 接口契约
// 单机版:只补端点契约,不做真实跨设备派单(自派自领无意义)
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import logger from '../middleware/log.js';

const router = Router();

// POST /browser-agents/collection-jobs — 派单
// 单机版:直接返回 PENDING,无跨设备派单
router.post('/browser-agents/collection-jobs', authMiddleware, async (req, res) => {
  const { skus, storeId } = req.body || {};
  logger.info(
    { skusCount: Array.isArray(skus) ? skus.length : 0, storeId },
    'collection-jobs 派单(单机版直接返回 PENDING)'
  );
  res.json({
    jobId: `local-${Date.now()}`,
    status: 'PENDING',
    message: '单机版不支持跨设备代采,请在当前浏览器手动采集',
  });
});

// GET /browser-agents/collection-jobs/:id — 查询代采任务状态
router.get('/browser-agents/collection-jobs/:id', authMiddleware, (req, res) => {
  res.json({
    jobId: req.params.id,
    status: 'NOT_FOUND',
    message: '单机版无代采任务',
  });
});

// POST /browser-agents/collection-jobs/:id/report — 上报代采结果
router.post('/browser-agents/collection-jobs/:id/report', authMiddleware, (req, res) => {
  logger.info({ jobId: req.params.id, bodyKeys: Object.keys(req.body || {}) }, '代采上报已接收(单机版不做处理)');
  res.json({ ok: true, message: '单机版代采上报已接收(不做处理)' });
});

export default router;
