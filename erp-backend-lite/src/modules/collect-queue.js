// 采集队列管理接口(ERP 镜像 + 操作指令)
// 路由挂载在 /admin/api/collect-queue,走全局 JWT 鉴权(authMiddleware)
import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { cols } from '../db/mongo.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';

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

function nowDate() {
  return new Date();
}

// ── 队列统计 ────────────────────────────────────────────────

// GET /admin/api/collect-queue/stats
// 返回各状态任务数 + 今日完成/失败 + 熔断状态(从最近 ANTIBOT_BLOCKED 错误推导)+ consumePaused(从 sync-snapshot 读取)
router.get('/admin/api/collect-queue/stats', async (req, res, next) => {
  try {
    const col = await cols.collectQueueTasks();
    const statusCounts = await col
      .aggregate([{ $match: { _id: { $ne: '__snapshot__' } } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
      .toArray();

    const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0]));
    for (const s of statusCounts) {
      if (s._id) byStatus[s._id] = s.count;
    }

    // 今日完成/失败统计(按 finishedAt 过滤)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [successToday, failedFinalToday] = await Promise.all([
      col.countDocuments({ status: 'success', finishedAt: { $gte: todayStart } }),
      col.countDocuments({ status: 'failed_final', finishedAt: { $gte: todayStart } }),
    ]);

    // 推导熔断:最近 10 分钟内有 ANTIBOT_BLOCKED 终态任务则认为熔断中
    const latestAntibot = await col.findOne(
      {
        status: 'failed_final',
        'lastError.type': 'ANTIBOT_BLOCKED',
        finishedAt: { $gte: new Date(Date.now() - CIRCUIT_BREAKER_MS) },
      },
      { sort: { finishedAt: -1 }, projection: { finishedAt: 1, lastError: 1 } }
    );

    const circuitBreaker = latestAntibot
      ? {
          active: true,
          triggeredAt: latestAntibot.finishedAt,
          remainingMs: Math.max(0, CIRCUIT_BREAKER_MS - (Date.now() - new Date(latestAntibot.finishedAt).getTime())),
        }
      : { active: false, triggeredAt: null, remainingMs: 0 };

    // 从 sync-snapshot 读取 consumePaused / lastConsumeAt(ERP 无法直接访问 chrome.storage,由 SW 上报)
    const snapshot = await col.findOne({ _id: '__snapshot__' }, { projection: { consumePaused: 1, lastConsumeAt: 1 } });

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

    const query = { _id: { $ne: '__snapshot__' } };
    if (status && isValidStatus(status)) query.status = status;

    const col = await cols.collectQueueTasks();
    const [total, items] = await Promise.all([
      col.countDocuments(query),
      col
        .find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
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

    const col = await cols.collectQueueTasks();
    const doc = await col.findOne({ sku });
    if (!doc) return res.status(404).json({ error: 'not found' });

    return res.json(ok(doc));
  } catch (e) {
    logger.warn({ err: e.message, sku: req.params.sku }, '[collect-queue] detail failed');
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

    const opsCol = await cols.collectQueueOps();
    // 去重:已有未处理的 retry op 则不重复插入
    const existing = await opsCol.findOne({ op: 'retry', sku, processed: false });
    let opId;
    if (existing) {
      opId = existing._id;
    } else {
      const r = await opsCol.insertOne({
        op: 'retry',
        sku,
        params: {},
        ts: nowDate(),
        processed: false,
        processedAt: null,
      });
      opId = r.insertedId;
    }

    // 直接重置 ERP 文档状态(管理页即时生效)
    const taskCol = await cols.collectQueueTasks();
    await taskCol.updateOne(
      { sku },
      { $set: { status: 'pending', attempts: 0, nextRetryAt: null, lastError: null, updatedAt: nowDate() } }
    );

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

    const opsCol = await cols.collectQueueOps();
    // 去重:已有未处理的 delete op 则不重复插入
    const existing = await opsCol.findOne({ op: 'delete', sku, processed: false });
    let opId;
    if (existing) {
      opId = existing._id;
    } else {
      const r = await opsCol.insertOne({
        op: 'delete',
        sku,
        params: {},
        ts: nowDate(),
        processed: false,
        processedAt: null,
      });
      opId = r.insertedId;
    }

    // 直接删除 ERP 文档(管理页即时生效)
    const taskCol = await cols.collectQueueTasks();
    await taskCol.deleteOne({ sku });

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

    const taskCol = await cols.collectQueueTasks();
    const r = await taskCol.deleteOne({ sku });

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

    const opsCol = await cols.collectQueueOps();
    const docs = skus.map((sku) => ({
      op: 'retry',
      sku,
      params: {},
      ts: nowDate(),
      processed: false,
      processedAt: null,
    }));
    const r = await opsCol.insertMany(docs);

    // 直接批量重置 ERP 文档状态(管理页即时生效)
    const taskCol = await cols.collectQueueTasks();
    await taskCol.updateMany(
      { sku: { $in: skus } },
      { $set: { status: 'pending', attempts: 0, nextRetryAt: null, lastError: null, updatedAt: nowDate() } }
    );

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
    const opsCol = await cols.collectQueueOps();
    const r = await opsCol.insertOne({
      op: 'clear',
      sku: null,
      params: {},
      ts: nowDate(),
      processed: false,
      processedAt: null,
    });

    // 直接删除所有 pending 文档(管理页即时生效)
    const taskCol = await cols.collectQueueTasks();
    const del = await taskCol.deleteMany({ status: 'pending', _id: { $ne: '__snapshot__' } });

    return res.json(ok({ insertedId: r.insertedId, op: 'clear', deletedCount: del.deletedCount }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] clear failed');
    next(e);
  }
});

// POST /admin/api/collect-queue/consume-pause
router.post('/admin/api/collect-queue/consume-pause', async (req, res, next) => {
  try {
    const opsCol = await cols.collectQueueOps();
    const r = await opsCol.insertOne({
      op: 'pause',
      sku: null,
      params: {},
      ts: nowDate(),
      processed: false,
      processedAt: null,
    });

    return res.json(ok({ insertedId: r.insertedId, op: 'pause' }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] consume-pause failed');
    next(e);
  }
});

// POST /admin/api/collect-queue/consume-resume
router.post('/admin/api/collect-queue/consume-resume', async (req, res, next) => {
  try {
    const opsCol = await cols.collectQueueOps();
    const r = await opsCol.insertOne({
      op: 'resume',
      sku: null,
      params: {},
      ts: nowDate(),
      processed: false,
      processedAt: null,
    });

    return res.json(ok({ insertedId: r.insertedId, op: 'resume' }));
  } catch (e) {
    logger.warn({ err: e.message }, '[collect-queue] consume-resume failed');
    next(e);
  }
});

// ── SW 上报队列快照(对账) ────────────────────────────────────────────────

// POST /admin/api/collect-queue/sync-snapshot
// body: { pending, running, success, failed, syncedAt, consumePaused?, lastConsumeAt? }
// 存入 collect_queue_tasks 中 _id='__snapshot__' 的文档(upsert)
router.post('/admin/api/collect-queue/sync-snapshot', async (req, res, next) => {
  try {
    const body = req.body || {};
    const col = await cols.collectQueueTasks();
    const now = nowDate();
    const r = await col.updateOne(
      { _id: '__snapshot__' },
      {
        $set: {
          _id: '__snapshot__',
          sku: '__snapshot__',
          pending: Number(body.pending) || 0,
          running: Number(body.running) || 0,
          success: Number(body.success) || 0,
          failed: Number(body.failed) || 0,
          syncedAt: body.syncedAt ? new Date(body.syncedAt) : now,
          consumePaused: body.consumePaused != null ? Boolean(body.consumePaused) : null,
          lastConsumeAt: body.lastConsumeAt ? new Date(body.lastConsumeAt) : null,
          updatedAt: now,
        },
      },
      { upsert: true }
    );

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
    const col = await cols.collectQueueOps();
    const items = await col.find({ processed: false }).sort({ ts: 1 }).limit(100).toArray();

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
    if (!id || !ObjectId.isValid(id)) return res.status(422).json({ error: 'invalid id' });

    const col = await cols.collectQueueOps();
    const r = await col.updateOne(
      { _id: new ObjectId(id), processed: false },
      { $set: { processed: true, processedAt: nowDate() } }
    );

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
    const update = {
      updatedAt: nowDate(),
    };

    if (status && isValidStatus(status)) update.status = status;
    if (body.result !== undefined) update.result = body.result;
    if (body.steps !== undefined) update.steps = body.steps;
    // 兼容 lastError / error 两种字段名(设计文档用 lastError)
    if (body.lastError !== undefined) update.lastError = body.lastError;
    else if (body.error !== undefined) update.lastError = body.error;
    if (body.duration !== undefined) update.duration = Number(body.duration) || 0;
    if (body.finishedAt) update.finishedAt = new Date(body.finishedAt);

    const col = await cols.collectQueueTasks();
    const r = await col.updateOne({ sku }, { $set: update });

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

    const now = nowDate();
    const status = String(body.status || '').trim() || 'pending';
    const col = await cols.collectQueueTasks();

    const set = {
      sku,
      sellerSlug: body.sellerSlug != null ? String(body.sellerSlug) : null,
      sellerId: body.sellerId != null ? String(body.sellerId) : null,
      domInfo: body.domInfo != null ? body.domInfo : null,
      status: isValidStatus(status) ? status : 'pending',
      attempts: body.attempts != null ? Number(body.attempts) || 0 : 0,
      maxAttempts: body.maxAttempts != null ? Number(body.maxAttempts) || 3 : 3,
      nextRetryAt: body.nextRetryAt != null ? (body.nextRetryAt ? new Date(body.nextRetryAt) : null) : null,
      lastError: body.lastError != null ? body.lastError : null,
      // startedAt / finishedAt / steps 为可变字段(SW 会上报),放在 $set 中
      startedAt: body.startedAt ? new Date(body.startedAt) : null,
      finishedAt: body.finishedAt ? new Date(body.finishedAt) : null,
      steps: body.steps != null ? body.steps : null,
      updatedAt: now,
    };

    // 仅首次创建时写入 createdAt / result,避免覆盖已有值
    const setOnInsert = {
      createdAt: now,
      result: null,
    };

    const r = await col.updateOne({ sku }, { $set: set, $setOnInsert: setOnInsert }, { upsert: true });

    return res.json(ok({ upserted: true, sku, created: r.upsertedCount === 1 }));
  } catch (e) {
    logger.warn({ err: e.message, sku: body?.sku }, '[collect-queue] submit failed');
    next(e);
  }
});

export default router;
