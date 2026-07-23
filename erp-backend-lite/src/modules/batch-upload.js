// 批量均衡上架 API(P2-2)
// 路由:
//   POST /admin/api/batch-upload/preview  — 预览分配(不落库)
//   POST /admin/api/batch-upload          — 创建批次(立即执行)
//   GET  /admin/api/batch-upload          — 批次列表
//   GET  /admin/api/batch-upload/:batchNo  — 批次详情(含子任务)
//   POST /admin/api/batch-upload/:batchNo/pause   — 暂停
//   POST /admin/api/batch-upload/:batchNo/resume  — 继续
//   POST /admin/api/batch-upload/:batchNo/cancel   — 取消(软取消,PENDING→SKIPPED)
//   POST /admin/api/batch-upload/:batchNo/items/:id/reassign — 手动调整子任务目标店铺
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { ok } from '../utils/response.js';
import { distributeSkus, summarizeDistribution } from '../services/batch-distributor.js';

const router = Router();

function parseJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rowToBatch(r) {
  if (!r) return null;
  return {
    id: r.id,
    localTaskId: r.local_task_id,
    batchNo: r.batch_no,
    name: r.name,
    storeId: r.store_id,
    storeIds: parseJson(r.store_ids) || [r.store_id].filter(Boolean),
    status: r.status,
    totalCount: r.total_count,
    successCount: r.success_count,
    failedCount: r.failed_count,
    skippedCount: r.skipped_count,
    config: parseJson(r.config),
    speedConfig: parseJson(r.speed_config),
    errorMessage: r.error_message,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

function rowToItem(r) {
  if (!r) return null;
  return {
    id: r.id,
    batchTaskId: r.batch_task_id,
    seq: r.seq,
    sourceSku: r.source_sku,
    sellerId: r.seller_id,
    targetStoreId: r.target_store_id,
    followTaskId: r.follow_task_id,
    status: r.status,
    skipReason: r.skip_reason,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/**
 * 查询 SKU 的缓存信息(门槛校验 + sellerId 提取)
 * 返回 Map<sku, {sellerId, listed, cacheHits}>
 */
function fetchSkuInfo(skus) {
  if (!skus.length) return new Map();
  const placeholders = skus.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT sku, seller_id, listed,
              card_hit, detail_hit, search_hit, bundle_hit, rich_media_hit, market_stats_hit, follow_sell_hit
       FROM ozon_cache_index WHERE sku IN (${placeholders})`
    )
    .all(...skus);
  const map = new Map();
  for (const r of rows) {
    const cacheHits = {
      dom: !!(r.card_hit || r.detail_hit),
      attribute: !!(r.search_hit && r.bundle_hit),
      richMedia: !!r.rich_media_hit,
      marketStats: !!r.market_stats_hit,
      followSell: !!r.follow_sell_hit,
    };
    map.set(r.sku, {
      sellerId: r.seller_id || '',
      listed: !!r.listed,
      cacheHits,
    });
  }
  return map;
}

// ── 预览分配(不落库) ───────────────────────────────────────
// body: { skus: string[], storeIds: string[], config?: {templateId, defaultStock, ...}, speedConfig?: {intervalSec, onFailure} }
// 返回: { assignments, summary, skipped }
router.post('/admin/api/batch-upload/preview', (req, res, next) => {
  try {
    const { skus, storeIds, config = {}, speedConfig = {} } = req.body || {};
    if (!Array.isArray(skus) || skus.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'skus 必填且非空'));
    }
    if (!Array.isArray(storeIds) || storeIds.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeIds 必填且非空'));
    }

    const skuInfoMap = fetchSkuInfo(skus);
    const validSkus = [];
    const skipped = [];

    for (const sku of skus) {
      const info = skuInfoMap.get(sku);
      if (!info) {
        skipped.push({ sku, reason: 'NOT_FOUND', message: 'SKU 不在采集箱缓存中' });
        continue;
      }
      if (info.listed) {
        skipped.push({ sku, reason: 'LISTED', message: '已跟卖,自动跳过' });
        continue;
      }
      // 门槛校验:dom + attribute + richMedia 三类命中
      if (!info.cacheHits.dom || !info.cacheHits.attribute || !info.cacheHits.richMedia) {
        skipped.push({
          sku,
          reason: 'INSUFFICIENT_DATA',
          message: `数据不完整(dom=${info.cacheHits.dom}, attribute=${info.cacheHits.attribute}, richMedia=${info.cacheHits.richMedia})`,
        });
        continue;
      }
      validSkus.push({ sku, sellerId: info.sellerId });
    }

    const assignments = distributeSkus(validSkus, storeIds);
    const summary = summarizeDistribution(assignments, storeIds);

    res.json(
      ok({
        assignments: assignments.map((a) => ({
          sku: a.sku,
          sellerId: a.sellerId,
          targetStoreId: a.targetStoreId,
          seq: a.seq,
        })),
        summary,
        skipped,
        config,
        speedConfig,
      })
    );
  } catch (e) {
    next(e);
  }
});

// ── 创建批次(立即执行) ─────────────────────────────────────
// body: { skus, storeIds, name?, config?, speedConfig?, assignments? }
//   assignments 可选:前端手动调整后的分配结果(不传则后端自动分配)
router.post('/admin/api/batch-upload', (req, res, next) => {
  try {
    const {
      skus,
      storeIds,
      name,
      config = {},
      speedConfig = { intervalSec: 10, onFailure: 'continue' },
      assignments: customAssignments,
    } = req.body || {};

    if (!Array.isArray(skus) || skus.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'skus 必填且非空'));
    }
    if (!Array.isArray(storeIds) || storeIds.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeIds 必填且非空'));
    }

    const batchNo = `bat-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const localTaskId = `batch-${randomUUID().slice(0, 8)}`;

    // 门槛校验 + 跳过
    const skuInfoMap = fetchSkuInfo(skus);
    const validSkus = [];
    const skippedItems = [];

    for (const sku of skus) {
      const info = skuInfoMap.get(sku);
      if (!info) {
        skippedItems.push({ sku, reason: 'NOT_FOUND' });
        continue;
      }
      if (info.listed) {
        skippedItems.push({ sku, reason: 'LISTED', sellerId: info.sellerId });
        continue;
      }
      if (!info.cacheHits.dom || !info.cacheHits.attribute || !info.cacheHits.richMedia) {
        skippedItems.push({ sku, reason: 'INSUFFICIENT_DATA', sellerId: info.sellerId });
        continue;
      }
      validSkus.push({ sku, sellerId: info.sellerId });
    }

    // 分配:使用前端传入的 customAssignments 或自动分配
    let assignments;
    if (Array.isArray(customAssignments) && customAssignments.length > 0) {
      // 校验 customAssignments 的 targetStoreId 都在 storeIds 中
      const storeIdSet = new Set(storeIds);
      assignments = customAssignments.filter((a) => storeIdSet.has(a.targetStoreId));
      // 重新编号 seq
      assignments.forEach((a, i) => (a.seq = i));
    } else {
      assignments = distributeSkus(validSkus, storeIds);
    }

    // 入库批次(RUNNING = 立即执行)
    db.prepare(
      `INSERT INTO batch_upload_tasks
        (local_task_id, batch_no, name, store_id, store_ids, status, total_count, skipped_count, config, speed_config)
       VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?)`
    ).run(
      localTaskId,
      batchNo,
      name || null,
      storeIds[0],
      JSON.stringify(storeIds),
      assignments.length,
      skippedItems.length,
      JSON.stringify(config),
      JSON.stringify(speedConfig)
    );

    // 入库子任务
    const stmtItem = db.prepare(
      `INSERT INTO batch_upload_items
        (batch_task_id, seq, source_sku, seller_id, target_store_id, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`
    );
    for (const a of assignments) {
      stmtItem.run(localTaskId, a.seq, a.sku, a.sellerId || null, a.targetStoreId);
    }
    // 跳过的 SKU 也入库(SKIPPED 状态,便于审计)
    const stmtSkipped = db.prepare(
      `INSERT INTO batch_upload_items
        (batch_task_id, seq, source_sku, seller_id, target_store_id, status, skip_reason, finished_at)
       VALUES (?, ?, ?, ?, ?, 'SKIPPED', ?, datetime('now'))`
    );
    let skipSeq = assignments.length;
    for (const s of skippedItems) {
      stmtSkipped.run(localTaskId, skipSeq++, s.sku, s.sellerId || null, null, s.reason);
    }

    const row = db.prepare(`SELECT * FROM batch_upload_tasks WHERE local_task_id=?`).get(localTaskId);
    res.status(201).json(ok(rowToBatch(row)));
  } catch (e) {
    next(e);
  }
});

// ── 批次列表(分页) ─────────────────────────────────────────
router.get('/admin/api/batch-upload', (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.currentPage, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * size;
    const where = [];
    const params = [];
    if (req.query.status) {
      where.push('status = ?');
      params.push(req.query.status);
    }
    if (req.query.keyword) {
      where.push('(batch_no LIKE ? OR name LIKE ?)');
      params.push('%' + req.query.keyword + '%', '%' + req.query.keyword + '%');
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM batch_upload_tasks ${whereSql}`).get(...params).n;
    const rows = db
      .prepare(`SELECT * FROM batch_upload_tasks ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, size, offset);
    res.json(ok({ items: rows.map(rowToBatch), total, currentPage: page, pageSize: size }));
  } catch (e) {
    next(e);
  }
});

// ── 批次详情(含子任务) ─────────────────────────────────────
router.get('/admin/api/batch-upload/:batchNo', (req, res, next) => {
  try {
    const batch = db.prepare(`SELECT * FROM batch_upload_tasks WHERE batch_no=?`).get(req.params.batchNo);
    if (!batch) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '批次不存在'));
    const items = db
      .prepare(`SELECT * FROM batch_upload_items WHERE batch_task_id=? ORDER BY seq ASC`)
      .all(batch.local_task_id);
    res.json(ok({ ...rowToBatch(batch), items: items.map(rowToItem) }));
  } catch (e) {
    next(e);
  }
});

// ── 暂停批次 ───────────────────────────────────────────────
router.post('/admin/api/batch-upload/:batchNo/pause', (req, res, next) => {
  try {
    const batch = db.prepare(`SELECT * FROM batch_upload_tasks WHERE batch_no=?`).get(req.params.batchNo);
    if (!batch) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '批次不存在'));
    if (batch.status !== 'RUNNING') {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, `当前状态 ${batch.status} 不可暂停`));
    }
    db.prepare(`UPDATE batch_upload_tasks SET status='PAUSED' WHERE local_task_id=?`).run(batch.local_task_id);
    res.json(ok({ status: 'PAUSED' }));
  } catch (e) {
    next(e);
  }
});

// ── 继续批次 ───────────────────────────────────────────────
router.post('/admin/api/batch-upload/:batchNo/resume', (req, res, next) => {
  try {
    const batch = db.prepare(`SELECT * FROM batch_upload_tasks WHERE batch_no=?`).get(req.params.batchNo);
    if (!batch) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '批次不存在'));
    if (batch.status !== 'PAUSED') {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, `当前状态 ${batch.status} 不可继续`));
    }
    db.prepare(`UPDATE batch_upload_tasks SET status='RUNNING', error_message=NULL WHERE local_task_id=?`).run(
      batch.local_task_id
    );
    res.json(ok({ status: 'RUNNING' }));
  } catch (e) {
    next(e);
  }
});

// ── 取消批次(软取消:PENDING→SKIPPED,RUNNING 等完成) ───────
router.post('/admin/api/batch-upload/:batchNo/cancel', (req, res, next) => {
  try {
    const batch = db.prepare(`SELECT * FROM batch_upload_tasks WHERE batch_no=?`).get(req.params.batchNo);
    if (!batch) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '批次不存在'));
    if (['SUCCESS', 'FAILED', 'PARTIAL'].includes(batch.status)) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, `批次已终态(${batch.status}),不可取消`));
    }
    // PENDING 子任务标 SKIPPED(正在 RUNNING 的等其完成)
    const result = db
      .prepare(
        `UPDATE batch_upload_items
         SET status='SKIPPED', skip_reason='CANCELLED', finished_at=datetime('now'), updated_at=datetime('now')
         WHERE batch_task_id=? AND status='PENDING'`
      )
      .run(batch.local_task_id);
    // 若无 RUNNING 子任务,直接标终态;否则等 poller 检测到无 PENDING 后自动 completeBatch
    const runningCount = db
      .prepare(`SELECT COUNT(*) AS n FROM batch_upload_items WHERE batch_task_id=? AND status='RUNNING'`)
      .get(batch.local_task_id).n;
    if (runningCount === 0) {
      db.prepare(`UPDATE batch_upload_tasks SET status='CANCELLED', completed_at=datetime('now') WHERE local_task_id=?`).run(
        batch.local_task_id
      );
    } else {
      // 标记 PAUSED,poller 不会取 RUNNING 批次的 PENDING(已无 PENDING),等 RUNNING 完成后 completeBatch 会标 CANCELLED
      // 但 completeBatch 标的是 SUCCESS/FAILED/PARTIAL,需特殊处理:批次被取消时标 CANCELLED
      // 简化:直接标 CANCELLED,允许 RUNNING 子任务完成后 poller 不再处理此批次
      db.prepare(`UPDATE batch_upload_tasks SET status='CANCELLED' WHERE local_task_id=?`).run(batch.local_task_id);
    }
    res.json(ok({ cancelledPending: result.changes, runningCount }));
  } catch (e) {
    next(e);
  }
});

// ── 手动调整子任务目标店铺 ─────────────────────────────────
router.post('/admin/api/batch-upload/:batchNo/items/:id/reassign', (req, res, next) => {
  try {
    const { targetStoreId } = req.body || {};
    if (!targetStoreId) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'targetStoreId 必填'));
    const batch = db.prepare(`SELECT * FROM batch_upload_tasks WHERE batch_no=?`).get(req.params.batchNo);
    if (!batch) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '批次不存在'));
    const item = db
      .prepare(`SELECT * FROM batch_upload_items WHERE id=? AND batch_task_id=?`)
      .get(req.params.id, batch.local_task_id);
    if (!item) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '子任务不存在'));
    if (item.status !== 'PENDING') {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, `子任务状态 ${item.status} 不可调整`));
    }
    db.prepare(`UPDATE batch_upload_items SET target_store_id=?, updated_at=datetime('now') WHERE id=?`).run(
      targetStoreId,
      item.id
    );
    res.json(ok({ id: item.id, targetStoreId }));
  } catch (e) {
    next(e);
  }
});

export default router;
