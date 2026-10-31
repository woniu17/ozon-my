// 店铺健康-错误指数(2026-11-03)
// 基于 Ozon 卖家评级接口(/v1/rating/index/fbs/info、/v1/rating/index/fbs/posting/list)
// 设计文档: docs/店铺健康页面-功能设计.md
//
// 路由:
//   GET  /admin/api/rating/health/summary      概览汇总(每店指数/趋势 + 跨店影响货件统计)
//   GET  /admin/api/rating/health/errors        影响错误指数的货件分页明细
//   POST /admin/api/rating/health/sync          手动触发同步(拉 Ozon 落库)
//   GET  /admin/api/rating/health/sync-status   同步任务状态
import { Router } from 'express';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';
import config from '../config/index.js';
import {
  getRatingDailyByStore,
  getRatingSnapshots,
  getRatingErrorTotals,
  getRatingErrors,
} from '../db/dao/sqlite/rating-dao.js';
import { runRatingHealthSync, getRatingSyncStatus } from '../services/rating-health-sync.js';

const router = Router();

function parseStoreIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function validateDateRange(from, to) {
  const f = String(from || '');
  const t = String(to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return null;
  }
  if (f > t) return null;
  return { from: f, to: t };
}

function storeNameMap() {
  const map = new Map();
  for (const s of config.loadStores() || []) {
    if (s?.id) map.set(String(s.id), s.name || s.id);
  }
  return map;
}

// ── 概览汇总 ──
// 参数: storeIds(逗号分隔,空=全部), from, to(YYYY-MM-DD,必填)
// 响应: { stores: [{ storeId, storeName, index, processingCostsSum, currencyCode,
//         periodFrom, periodTo, syncedAt, defects: [{date,indexByDate,processingCostsSumByDate}] }],
//         totals: { errorPostingCount, sellerCancellationCount, sellerDelayCount,
//                   graceCount, chargeSum, chargeCurrencyCode },
//         sync: { running, lastResult } }
router.get('/admin/api/rating/health/summary', async (req, res, next) => {
  try {
    const range = validateDateRange(req.query.from, req.query.to);
    if (!range) {
      return res.status(400).json({ ok: false, message: 'from/to 必须为 YYYY-MM-DD 且 from <= to' });
    }
    const storeIds = parseStoreIds(req.query.storeIds);
    const names = storeNameMap();

    const [snapshots, dailyRows, totals] = await Promise.all([
      getRatingSnapshots(storeIds),
      getRatingDailyByStore(storeIds, range.from, range.to),
      getRatingErrorTotals(storeIds, range.from, range.to),
    ]);

    const defectsByStore = new Map();
    for (const r of dailyRows) {
      if (!defectsByStore.has(r.storeId)) defectsByStore.set(r.storeId, []);
      defectsByStore.get(r.storeId).push({
        date: r.date,
        indexByDate: r.indexByDate,
        processingCostsSumByDate: r.processingCostsSumByDate,
      });
    }

    const stores = snapshots.map((s) => ({
      storeId: s.storeId,
      storeName: names.get(s.storeId) || s.storeId,
      index: s.index,
      processingCostsSum: s.processingCostsSum,
      currencyCode: s.currencyCode,
      periodFrom: s.periodFrom,
      periodTo: s.periodTo,
      syncedAt: s.syncedAt,
      defects: defectsByStore.get(s.storeId) || [],
    }));

    res.json(ok({
      stores,
      totals,
      sync: getRatingSyncStatus(),
    }));
  } catch (e) {
    next(e);
  }
});

// ── 影响错误指数的货件明细(分页) ──
// 参数: storeIds, from, to, offset, limit(默认50,最大200)
// 响应: { items: [{ storeId, storeName, postingNumber, postingErrorType, deliverySchema,
//         errorAt, index, hasGraceStatus, chargePercent, chargePrice, chargeCurrencyCode,
//         productPrice, productCurrencyCode, orderStatus }], total }
router.get('/admin/api/rating/health/errors', async (req, res, next) => {
  try {
    const range = validateDateRange(req.query.from, req.query.to);
    if (!range) {
      return res.status(400).json({ ok: false, message: 'from/to 必须为 YYYY-MM-DD 且 from <= to' });
    }
    const storeIds = parseStoreIds(req.query.storeIds);
    const names = storeNameMap();
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;

    const { items, total } = getRatingErrors(storeIds, range.from, range.to, { limit, offset });
    res.json(ok({
      items: items.map((it) => ({ ...it, storeName: names.get(it.storeId) || it.storeId })),
      total,
    }));
  } catch (e) {
    next(e);
  }
});

// ── 手动触发同步 ──
// body: { storeIds?: string[], from?, to? } 缺省=全店铺近35天
// 响应: { skipped?, stores, from, to, dailyRows, postingRows, errors, durationMs }
router.post('/admin/api/rating/health/sync', async (req, res, next) => {
  try {
    const body = req.body || {};
    let storeIds = Array.isArray(body.storeIds) ? body.storeIds.map(String).filter(Boolean) : [];
    if (storeIds.length === 0 && typeof body.storeIds === 'string' && body.storeIds.trim()) {
      storeIds = body.storeIds.split(',').map((s) => s.trim()).filter(Boolean);
    }
    let from;
    let to;
    if (body.from || body.to) {
      const range = validateDateRange(body.from, body.to);
      if (!range) return res.status(400).json({ ok: false, message: 'from/to 必须为 YYYY-MM-DD 且 from <= to' });
      from = range.from;
      to = range.to;
    }
    const r = await runRatingHealthSync({ storeIds, from, to });
    res.json(ok(r));
  } catch (e) {
    logger.warn({ err: e?.message }, '[store-health] 手动同步异常');
    next(e);
  }
});

// ── 同步状态 ──
router.get('/admin/api/rating/health/sync-status', (_req, res) => {
  res.json(ok(getRatingSyncStatus()));
});

export default router;