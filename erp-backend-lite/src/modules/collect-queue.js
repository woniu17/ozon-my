// 采集队列管理接口(ERP 镜像 + 操作指令)
// 路由挂载在 /admin/api/collect-queue,走全局 JWT 鉴权(authMiddleware)
import { Router } from 'express';
import { getDaos } from '../db/adapter.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';

const daos = await getDaos();

const router = Router();

// 任务合法状态
const TASK_STATUSES = ['pending', 'running', 'failed_retry', 'failed_final', 'failed_partial', 'success'];

// 熔断窗口(ms),与 SW 侧保持一致(10 分钟)
const CIRCUIT_BREAKER_MS = 10 * 60 * 1000;

// ── 内部工具 ────────────────────────────────────────────────

function normalizeSku(sku) {
  return String(sku || '').trim();
}

function isValidStatus(status) {
  return TASK_STATUSES.includes(status);
}

// ── 队列统计 ────────────────────────────────────────────────

// GET /admin/api/collect-queue/stats
// 返回各状态任务数 + 今日完成/失败 + 熔断状态(从最近 ANTIBOT_BLOCKED 错误推导)+ consumePaused(从 sync-snapshot 读取)
router.get('/admin/api/collect-queue/stats', async (req, res, next) => {
  try {
    const statusCounts = await daos.collectQueueTasksDao.aggregateStatusCounts();

    const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
    for (const s of statusCounts) {
      if (s._id) byStatus[s._id] = s.count;
    }

    // 今日完成/失败统计(按 finishedAt 过滤)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [successToday, failedFinalToday] = await Promise.all([
      daos.collectQueueTasksDao.countTodayByStatus('success', todayStart),
      daos.collectQueueTasksDao.countTodayByStatus('failed_final', todayStart),
    ]);

    // 推导熔断:最近 10 分钟内有 ANTIBOT_BLOCKED 终态任务则认为熔断中
    const latestAntibot = await daos.collectQueueTasksDao.findLatestAntibotBlocked(
      new Date(Date.now() - CIRCUIT_BREAKER_MS)
    );

    const circuitBreaker = latestAntibot
      ? {
          active: true,
          triggeredAt: latestAntibot.finishedAt,
          remainingMs: Math.max(0, CIRCUIT_BREAKER_MS - (Date.now() - new Date(latestAntibot.finishedAt).getTime())),
        }
      : { active: false, triggeredAt: null, remainingMs: 0 };

    // 从 sync-snapshot 读取 consumePaused / lastConsumeAt(ERP 无法直接访问 chrome.storage,由 SW 上报)
    const snapshot = await daos.collectQueueTasksDao.findSnapshot();

    return res.json(
      ok({
        byStatus,
        successToday,
        failedFinalToday,
        circuitBreaker,
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        consumePaused: snapshot?.consumePaused ?? null,
        lastConsumeAt: snapshot?.lastConsumeAt ?? null,
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] stats failed');
    next(e);
  }
});

// ── 任务列表 ────────────────────────────────────────────────

// GET /admin/api/collect-queue/list?status=&page=&pageSize=
router.get('/admin/api/collect-queue/list', async (req, res, next) => {
  try {
    const status = String(req.query.status || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));

    const filter = {};
    if (status && isValidStatus(status)) filter.status = status;

    const [total, items] = await Promise.all([
      daos.collectQueueTasksDao.countList(filter),
      daos.collectQueueTasksDao.findList(filter, page, pageSize),
    ]);

    return res.json(ok({ items, total, page, pageSize }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] list failed');
    next(e);
  }
});

// ── 单任务详情 ────────────────────────────────────────────────

// GET /admin/api/collect-queue/:sku
router.get('/admin/api/collect-queue/:sku', async (req, res, next) => {
  try {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return res.status(422).json({ error: 'missing sku' });

    const doc = await daos.collectQueueTasksDao.getBySku(sku);
    if (!doc) return res.status(404).json({ error: 'not found' });

    return res.json(ok(doc));
  } catch (e) {
    logger.warn({ err: e.message, sku: req.params.sku }, '[collect-queue] detail failed');
    next(e);
  }
});

// POST /admin/api/collect-queue/batch body: { skus: [] }
// 批量查询任务详情。返回 { [sku]: doc | null },不存在的 SKU 值为 null。
// 上限 200 个 SKU,避免一次性查太多。
router.post('/admin/api/collect-queue/batch', async (req, res, next) => {
  try {
    const rawSkus = Array.isArray(req.body?.skus) ? req.body.skus : [];
    const skus = rawSkus.map(normalizeSku).filter(Boolean).slice(0, 200);
    if (!skus.length) return res.status(422).json({ error: 'missing skus' });

    const docs = await daos.collectQueueTasksDao.findBySkus(skus);

    const map = {};
    for (const sku of skus) map[sku] = null;
    for (const doc of docs) map[doc.sku] = doc;

    return res.json(ok(map));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] batch failed');
    next(e);
  }
});

// ── 操作指令:retry / delete ────────────────────────────────────────────────

// POST /admin/api/collect-queue/:sku/retry
// 写 op(去重)+ 直接重置任务状态(让 ERP 管理页即时生效)
router.post('/admin/api/collect-queue/:sku/retry', async (req, res, next) => {
  try {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return res.status(422).json({ error: 'missing sku' });

    // 去重:已有未处理的 retry op 则不重复插入
    const existing = await daos.collectQueueOpsDao.findDedup('retry', sku);
    let opId;
    if (existing) {
      opId = existing._id;
    } else {
      const r = await daos.collectQueueOpsDao.insertOp('retry', sku, {});
      opId = r.insertedId;
    }

    // 直接重置 ERP 文档状态(管理页即时生效)
    await daos.collectQueueTasksDao.resetBySku(sku);

    return res.json(ok({ insertedId: opId, op: 'retry', sku, deduped: existing != null }));
  } catch (e) {
    logger.warn({ err: e.message, sku: req.params.sku }, '[collect-queue] retry failed');
    next(e);
  }
});

// DELETE /admin/api/collect-queue/:sku
// 写 op(去重)+ 直接从 collect_queue_tasks 删除该文档(管理页即时生效)
router.delete('/admin/api/collect-queue/:sku', async (req, res, next) => {
  try {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return res.status(422).json({ error: 'missing sku' });

    // 去重:已有未处理的 delete op 则不重复插入
    const existing = await daos.collectQueueOpsDao.findDedup('delete', sku);
    let opId;
    if (existing) {
      opId = existing._id;
    } else {
      const r = await daos.collectQueueOpsDao.insertOp('delete', sku, {});
      opId = r.insertedId;
    }

    // 直接删除 ERP 文档(管理页即时生效)
    await daos.collectQueueTasksDao.deleteBySku(sku);

    return res.json(ok({ insertedId: opId, op: 'delete', sku, deduped: existing != null }));
  } catch (e) {
    logger.warn({ err: e.message, sku: req.params.sku }, '[collect-queue] delete op failed');
    next(e);
  }
});

// DELETE /admin/api/collect-queue/:sku/confirm
// 物理删除(供 SW 清理已完成任务时调用),不写 op
router.delete('/admin/api/collect-queue/:sku/confirm', async (req, res, next) => {
  try {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return res.status(422).json({ error: 'missing sku' });

    const r = await daos.collectQueueTasksDao.deleteBySku(sku);

    return res.json(ok({ deletedCount: r.deletedCount, sku }));
  } catch (e) {
    logger.warn({ err: e.message, sku: req.params.sku }, '[collect-queue] confirm delete failed');
    next(e);
  }
});

// ── 批量重试 ────────────────────────────────────────────────

// POST /admin/api/collect-queue/batch-retry body: { skus: [] }
// 写 ops + 直接批量重置任务状态(管理页即时生效)
router.post('/admin/api/collect-queue/batch-retry', async (req, res, next) => {
  try {
    const skus = Array.isArray(req.body?.skus) ? req.body.skus.map(normalizeSku).filter(Boolean) : [];
    if (!skus.length) return res.status(422).json({ error: 'missing skus' });

    const docs = skus.map((sku) => ({ op: 'retry', sku, params: {} }));
    const r = await daos.collectQueueOpsDao.insertManyOps(docs);

    // 直接批量重置 ERP 文档状态(管理页即时生效)
    await daos.collectQueueTasksDao.resetBySkus(skus);

    return res.json(ok({ insertedCount: r.insertedCount, skus }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] batch-retry failed');
    next(e);
  }
});

// ── 队列级操作 ────────────────────────────────────────────────

// POST /admin/api/collect-queue/clear
// 写 op + 直接删除所有 status=pending 的文档(管理页即时生效)
router.post('/admin/api/collect-queue/clear', async (req, res, next) => {
  try {
    const r = await daos.collectQueueOpsDao.insertOp('clear', null, {});

    // 直接删除所有 pending 文档(管理页即时生效)
    const del = await daos.collectQueueTasksDao.deletePendingAll();

    return res.json(ok({ insertedId: r.insertedId, op: 'clear', deletedCount: del.deletedCount }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] clear failed');
    next(e);
  }
});

// POST /admin/api/collect-queue/consume-pause
router.post('/admin/api/collect-queue/consume-pause', async (req, res, next) => {
  try {
    const r = await daos.collectQueueOpsDao.insertOp('pause', null, {});

    return res.json(ok({ insertedId: r.insertedId, op: 'pause' }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] consume-pause failed');
    next(e);
  }
});

// POST /admin/api/collect-queue/consume-resume
router.post('/admin/api/collect-queue/consume-resume', async (req, res, next) => {
  try {
    const r = await daos.collectQueueOpsDao.insertOp('resume', null, {});

    return res.json(ok({ insertedId: r.insertedId, op: 'resume' }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] consume-resume failed');
    next(e);
  }
});

// POST /admin/api/collect-queue/rescan
// 创建 rescan op,SW 轮询到后清空 SW 状态 + 广播让 content script 重新提交所有可见 SKU。
// 用于不刷新页面的场景(避免触发 Ozon 反爬)。
router.post('/admin/api/collect-queue/rescan', async (req, res, next) => {
  try {
    const r = await daos.collectQueueOpsDao.insertOp('rescan', null, {});

    return res.json(ok({ insertedId: r.insertedId, op: 'rescan' }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] rescan failed');
    next(e);
  }
});

// ── SW 上报队列快照(对账) ────────────────────────────────────────────────

// POST /admin/api/collect-queue/sync-snapshot
// body: { pending, running, success, failed, syncedAt, consumePaused?, lastConsumeAt? }
// 存入 __snapshot__ 文档(upsert,具体存储方式由 DAO 决定:Mongo 单文档 / SQLite 独立单行表)
router.post('/admin/api/collect-queue/sync-snapshot', async (req, res, next) => {
  try {
    const body = req.body || {};
    const r = await daos.collectQueueTasksDao.upsertSnapshot({
      pending: Number(body.pending) || 0,
      running: Number(body.running) || 0,
      success: Number(body.success) || 0,
      failed: Number(body.failed) || 0,
      syncedAt: body.syncedAt ? new Date(body.syncedAt) : null,
      consumePaused: body.consumePaused != null ? Boolean(body.consumePaused) : null,
      lastConsumeAt: body.lastConsumeAt ? new Date(body.lastConsumeAt) : null,
    });

    return res.json(ok({ ok: true, upserted: r.upsertedCount === 1, syncedAt: body.syncedAt }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] sync-snapshot failed');
    next(e);
  }
});

// ── SW 轮询操作指令 ────────────────────────────────────────────────

// GET /admin/api/collect-queue/ops/pending
router.get('/admin/api/collect-queue/ops/pending', async (req, res, next) => {
  try {
    const items = await daos.collectQueueOpsDao.findPendingOps(100);

    return res.json(ok({ items, count: items.length }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] ops pending failed');
    next(e);
  }
});

// POST /admin/api/collect-queue/ops/:id/processed
router.post('/admin/api/collect-queue/ops/:id/processed', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(422).json({ error: 'invalid id' });

    const r = await daos.collectQueueOpsDao.markProcessed(id);

    return res.json(ok({ matchedCount: r.matchedCount, modifiedCount: r.modifiedCount }));
  } catch (e) {
    logger.warn({ err: e.message, id: req.params.id }, '[collect-queue] mark processed failed');
    next(e);
  }
});

// ── 任务结果回写(SW 调用) ────────────────────────────────────────────────

// POST /admin/api/collect-queue/:sku/result
// body: { result, steps, status, finishedAt, duration, lastError | error }
router.post('/admin/api/collect-queue/:sku/result', async (req, res, next) => {
  try {
    const sku = normalizeSku(req.params.sku);
    if (!sku) return res.status(422).json({ error: 'missing sku' });

    const body = req.body || {};
    const status = String(body.status || '').trim();
    const update = {};

    if (status && isValidStatus(status)) update.status = status;
    if (body.result !== undefined) update.result = body.result;
    if (body.steps !== undefined) update.steps = body.steps;
    // 兼容 lastError / error 两种字段名(设计文档用 lastError)
    if (body.lastError !== undefined) update.lastError = body.lastError;
    else if (body.error !== undefined) update.lastError = body.error;
    if (body.duration !== undefined) update.duration = Number(body.duration) || 0;
    if (body.finishedAt) update.finishedAt = new Date(body.finishedAt);

    const r = await daos.collectQueueTasksDao.updateResult(sku, update);

    return res.json(ok({ updated: r.matchedCount > 0, sku, matchedCount: r.matchedCount }));
  } catch (e) {
    logger.warn({ err: e.message, sku: req.params.sku }, '[collect-queue] result update failed');
    next(e);
  }
});

// ── 任务初始提交(SW 调用) ────────────────────────────────────────────────

// POST /admin/api/collect-queue
// body: { sku, sellerSlug, sellerId, domInfo, status, attempts, maxAttempts, nextRetryAt, lastError, steps, startedAt, finishedAt }
// SW 的 _erpQueueUpdate 调用此接口 upsert 整个 task 对象
router.post('/admin/api/collect-queue', async (req, res, next) => {
  try {
    const body = req.body || {};
    const sku = normalizeSku(body.sku);
    if (!sku) return res.status(422).json({ error: 'missing sku' });

    const status = String(body.status || '').trim() || 'pending';
    const task = {
      sku,
      sellerSlug: body.sellerSlug != null ? String(body.sellerSlug) : null,
      sellerId: body.sellerId != null ? String(body.sellerId) : null,
      domInfo: body.domInfo != null ? body.domInfo : null,
      status: isValidStatus(status) ? status : 'pending',
      attempts: body.attempts != null ? Number(body.attempts) || 0 : 0,
      maxAttempts: body.maxAttempts != null ? Number(body.maxAttempts) || 3 : 3,
      nextRetryAt: body.nextRetryAt != null ? (body.nextRetryAt ? new Date(body.nextRetryAt) : null) : null,
      lastError: body.lastError != null ? body.lastError : null,
      // startedAt / finishedAt / steps 为可变字段(SW 会上报)
      startedAt: body.startedAt ? new Date(body.startedAt) : null,
      finishedAt: body.finishedAt ? new Date(body.finishedAt) : null,
      steps: body.steps != null ? body.steps : null,
    };

    const r = await daos.collectQueueTasksDao.submit(task);

    return res.json(ok({ upserted: true, sku, created: r.created }));
  } catch (e) {
    logger.warn({ err: e.message, sku: body?.sku }, '[collect-queue] submit failed');
    next(e);
  }
});

export default router;
