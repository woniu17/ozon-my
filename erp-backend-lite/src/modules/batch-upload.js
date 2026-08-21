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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { db } from '../db/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { ok } from '../utils/response.js';
import { distributeSkus, distributeSkusByStore, distributeSkusByStoreWithQuota, summarizeDistribution, autoPickBySeller } from '../services/batch-distributor.js';
import { getDaos } from '../db/adapter.js';
import * as opi from '../services/ozon-opi.js';
import logger from '../middleware/log.js';

const router = Router();

// DAO 单例(顶层 await:启动时即建立连接,失败立即可见)
const daos = await getDaos();

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORES_FILE = join(__dirname, '../config/stores.json');

// 读取 stores.json(与 admin.js 一致的热加载方式,每次读最新)
function readStores() {
  try {
    return JSON.parse(readFileSync(STORES_FILE, 'utf-8'));
  } catch (e) {
    logger.warn({ err: e.message }, 'stores.json 读取失败,回退为空数组');
    return [];
  }
}

// ── 配额实时查询 ───────────────────────────────────────────
// 实时拉取单店铺的配额剩余(无缓存,每次调用都打 OPI)
// 跟卖只消耗 daily_create 和 total 两类配额
// total.usage 含归档商品,需扣减归档数(查 ARCHIVED 一次即可,子类明细仅展示用)
// 返回:
//   { storeId, storeName, total: {usage, limit, remaining}, daily: {usage, limit, remaining},
//     archived, effectiveRemaining, error? }
//   - effectiveRemaining = min(total.remaining, daily.remaining),跟卖可分配硬上限
//   - limit=-1 表示无限制,remaining 记为 Number.MAX_SAFE_INTEGER
//   - error 非空时其他字段为 null(单店铺失败隔离)
async function fetchStoreQuotaRemaining(store) {
  const out = {
    storeId: store.id,
    storeName: store.name,
    total: { usage: null, limit: null, remaining: null },
    daily: { usage: null, limit: null, remaining: null },
    archived: null,
    effectiveRemaining: null,
    error: null,
  };
  try {
    // 并发:/v4 配额 + /v3 ARCHIVED 归档数
    const [quota, archivedCount] = await Promise.all([
      opi.productInfoLimit(store),
      opi.productListTotalByVisibility(store, 'ARCHIVED'),
    ]);
    const t = quota?.total || {};
    const dc = quota?.daily_create || {};
    const tUsage = typeof t.usage === 'number' ? t.usage : 0;
    const tLimit = typeof t.limit === 'number' ? t.limit : 0;
    const archived = typeof archivedCount === 'number' ? archivedCount : 0;
    // 账号总数剩余 = limit - (usage - archived),扣减归档商品
    const tRemaining = tLimit === -1 ? Number.MAX_SAFE_INTEGER : Math.max(0, tLimit - (tUsage - archived));
    const dcUsage = typeof dc.usage === 'number' ? dc.usage : 0;
    const dcLimit = typeof dc.limit === 'number' ? dc.limit : 0;
    const dcRemaining = dcLimit === -1 ? Number.MAX_SAFE_INTEGER : Math.max(0, dcLimit - dcUsage);
    out.total = { usage: tUsage, limit: tLimit, remaining: tRemaining };
    out.daily = { usage: dcUsage, limit: dcLimit, remaining: dcRemaining };
    out.archived = archived;
    out.effectiveRemaining = Math.min(tRemaining, dcRemaining);
  } catch (e) {
    out.error = e?.message || String(e);
    logger.warn({ storeId: store.id, err: out.error }, '配额查询失败');
  }
  return out;
}

// 批量并发查询多店铺配额(单店铺失败隔离,不影响其他店铺)
async function fetchStoresQuotaRemaining(stores) {
  return Promise.all(stores.map(fetchStoreQuotaRemaining));
}

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

// ── 按筛选条件自动选取 + 预览分配(不落库) ───────────────────
// body: {
//   filters: { keyword, sellerId, unlisted, hasComments, hasVideo, hasRichContent,
//              priceMin, priceMax, minCacheHits, excludeFilteredCategories },
//   perStoreCount: number, — 每家目标店铺上架数量 M(总选取数 N = M × storeIds.length)
//   storeIds: string[],    — 目标上架店铺
//   config?: { templateId, defaultStock, ... },
//   speedConfig?: { intervalSec, onFailure }
// }
// 返回: { assignments, summary, skipped, pickInfo, config, speedConfig }
//   assignments: [{sku, sellerId, targetStoreId, seq, price, ratingCount, name, primaryImage}]
//   pickInfo: { perStoreCount, requestedCount, actualPicked, totalAvailable, totalSellers,
//               insufficient, bySellerCount, eligibleCount, skippedCount }
// ── 配额预检(轻量,查所有店铺) ─────────────────────────────
// 无请求体参数,自动查询 stores.json 中所有店铺
// 返回: { items: [{ storeId, storeName, total, daily, archived, effectiveRemaining, error? }] }
// 用途: 打开自动上架面板时自动加载,在店铺列表旁展示配额剩余
router.post('/admin/api/batch-upload/quota-check', async (_req, res, next) => {
  try {
    const allStores = readStores();
    if (allStores.length === 0) {
      return res.json(ok({ items: [] }));
    }
    const items = await fetchStoresQuotaRemaining(allStores);
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post('/admin/api/batch-upload/auto-pick', async (req, res, next) => {
  try {
    const { filters = {}, perStoreCount, storeIds, config = {}, speedConfig = {} } = req.body || {};
    const M = Math.max(0, Math.floor(Number(perStoreCount) || 0));
    if (M <= 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'perStoreCount 必填且为正整数'));
    }
    if (!Array.isArray(storeIds) || storeIds.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeIds 必填且非空'));
    }

    // ── 配额预检:实时拉取每个店铺的剩余配额 ──────────────────────
    // 跟卖消耗 daily_create 和 total 两类配额,有效剩余 = min(总数剩余, 日建剩余)
    // total.usage 含归档商品,需扣减归档数(查 ARCHIVED 一次)
    const allStores = readStores();
    const targetStores = storeIds
      .map((sid) => allStores.find((s) => s.id === sid))
      .filter(Boolean);
    if (targetStores.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeIds 中无有效店铺'));
    }
    const quotaResults = await fetchStoresQuotaRemaining(targetStores);
    // 每店铺实际可分配数 = min(用户请求 M, 该店有效剩余)
    // 配额查询失败的店铺,视为 0(保守策略,不分配)
    const perStoreQuota = {};
    const quotaInfo = [];
    for (const q of quotaResults) {
      const eff = q.error ? 0 : (q.effectiveRemaining ?? 0);
      const granted = Math.max(0, Math.min(M, eff));
      perStoreQuota[q.storeId] = granted;
      quotaInfo.push({
        storeId: q.storeId,
        storeName: q.storeName,
        requested: M,
        granted,
        // 原始剩余(供前端展示)
        totalRemaining: q.total?.remaining ?? null,
        totalLimit: q.total?.limit ?? null,
        totalUsage: q.total?.usage ?? null,
        dailyRemaining: q.daily?.remaining ?? null,
        dailyLimit: q.daily?.limit ?? null,
        dailyUsage: q.daily?.usage ?? null,
        archived: q.archived,
        effectiveRemaining: q.effectiveRemaining ?? null,
        error: q.error,
        // 是否被配额截断(granted < requested)
        truncated: granted < M,
        // 配额状态:ok=充足, warn=部分截断, exhausted=耗尽, error=查询失败
        status: q.error ? 'error' : granted === 0 ? 'exhausted' : granted < M ? 'warn' : 'ok',
      });
    }

    // 总选取数 = Σ 各店铺实际可分配数(而非 M × storeIds.length)
    const N = quotaInfo.reduce((sum, q) => sum + q.granted, 0);

    // 全部店铺配额耗尽或查询失败:直接返回(无需查候选 SKU)
    if (N === 0) {
      return res.json(
        ok({
          assignments: [],
          summary: { byStore: {}, total: 0 },
          skipped: [],
          pickInfo: {
            perStoreCount: M,
            storeCount: storeIds.length,
            requestedCount: 0,
            actualPicked: 0,
            totalAvailable: 0,
            totalSellers: 0,
            insufficient: true,
            insufficientReason: 'QUOTA_EXHAUSTED',
            bySellerCount: {},
            eligibleCount: 0,
            skippedCount: 0,
          },
          quotaInfo,
          config,
          speedConfig,
        })
      );
    }

    // 解析筛选条件(与 collect-box-v2/from-cache 路由一致)
    const filterOpts = {
      keyword: String(filters.keyword || '').trim(),
      sellerId: String(filters.sellerId || '').trim(),
      sellerSlug: String(filters.sellerSlug || '').trim(),
      unlisted: filters.unlisted === '1' || filters.unlisted === 'true',
      hasComments: filters.hasComments === '1' || filters.hasComments === 'true',
      hasVideo: filters.hasVideo === '1' || filters.hasVideo === 'true',
      hasRichContent: filters.hasRichContent === '1' || filters.hasRichContent === 'true',
      priceMin: Number(filters.priceMin),
      priceMax: Number(filters.priceMax),
      // 注意:空字符串 '' 会被 Number('') 转成 0(而非 NaN),需先排除空串
      // 否则用户未勾"数据不完整"时 maxCacheHits 会被误设为 0,触发"命中数<=0"条件导致候选为 0
      minCacheHits:
        filters.minCacheHits !== '' && Number.isFinite(Number(filters.minCacheHits))
          ? Math.max(0, Math.min(3, Number(filters.minCacheHits)))
          : 0,
      maxCacheHits:
        filters.maxCacheHits !== '' && Number.isFinite(Number(filters.maxCacheHits))
          ? Math.max(0, Math.min(3, Number(filters.maxCacheHits)))
          : undefined,
      excludeFilteredCategories:
        filters.excludeFilteredCategories === '1' || filters.excludeFilteredCategories === 'true',
      // 超轻小件筛选:'1'=只看超轻小件,'0'=只看非超轻小件,空=不限
      ultraLight: String(filters.ultraLight || '').trim(),
      // 描述质量过滤(0=空/1=占位/2=按钮污染/3=正常),支持单值或多值"1,2"
      descriptionQuality: /^[0-9]+(,[0-9]+)*$/.test(String(filters.descriptionQuality || '').trim())
        ? String(filters.descriptionQuality).trim()
        : '',
      // 市场统计筛选 'has'=有真实数据,'none'=无真实数据(未采集+__empty)
      marketStats: String(filters.marketStats || '').trim(),
      // 采集时间范围('YYYY-MM-DD',闭区间含当日全天;过滤 last_fetched_at)
      fetchedFrom: String(filters.fetchedFrom || '').trim(),
      fetchedTo: String(filters.fetchedTo || '').trim(),
    };

    // 拉取所有候选 SKU(按筛选条件,已按 last_fetched_at DESC 排序)
    const candidates = await daos.indexDao.findListForAutoPick(filterOpts);

    // 门槛校验:过滤掉 LISTED 和 INSUFFICIENT_DATA(无法上架)
    // 注:即使筛选条件没勾 unlisted/fullData,auto-pick 也强制排除(无法上架的 SKU)
    const eligible = [];
    const skipped = [];
    for (const c of candidates) {
      if (c.listed) {
        skipped.push({ sku: c.sku, reason: 'LISTED', message: '已跟卖,自动跳过' });
        continue;
      }
      if (!c.cacheHits.dom || !c.cacheHits.attribute || !c.cacheHits.richMedia) {
        skipped.push({
          sku: c.sku,
          reason: 'INSUFFICIENT_DATA',
          message: `数据不完整(dom=${c.cacheHits.dom}, attribute=${c.cacheHits.attribute}, richMedia=${c.cacheHits.richMedia})`,
        });
        continue;
      }
      eligible.push(c);
    }

    // 按来源卖家均衡选取 N 个(差额均摊给有富余的卖家)
    const pickResult = autoPickBySeller(eligible, N);

    // 把选出的 SKU 按各店铺配额分配(每店独立上限,同源 SKU 尽量散到不同店铺)
    // 注:用 distributeSkusByStoreWithQuota 而非 distributeSkusByStore,
    //   因为各店铺配额可能不同(部分被截断),不能用固定 M
    const assignments = distributeSkusByStoreWithQuota(
      pickResult.picked.map((p) => ({ sku: p.sku, sellerId: p.sellerId })),
      storeIds,
      perStoreQuota
    );

    // 把 price/ratingCount/name 等展示字段合并到 assignments(便于前端预览)
    const pickedMap = new Map(pickResult.picked.map((p) => [p.sku, p]));
    const assignmentsWithInfo = assignments.map((a) => {
      const info = pickedMap.get(a.sku) || {};
      return {
        sku: a.sku,
        sellerId: a.sellerId,
        targetStoreId: a.targetStoreId,
        seq: a.seq,
        price: info.price ?? '',
        ratingCount: info.ratingCount ?? null,
        name: info.name || '',
        primaryImage: info.primaryImage || '',
      };
    });

    const summary = summarizeDistribution(assignments, storeIds);

    res.json(
      ok({
        assignments: assignmentsWithInfo,
        summary,
        skipped,
        pickInfo: {
          perStoreCount: M,
          storeCount: storeIds.length,
          requestedCount: pickResult.requestedCount,
          actualPicked: pickResult.actualPicked,
          totalAvailable: pickResult.totalAvailable,
          totalSellers: pickResult.totalSellers,
          insufficient: pickResult.insufficient,
          bySellerCount: pickResult.bySellerCount,
          eligibleCount: eligible.length,
          skippedCount: skipped.length,
        },
        quotaInfo,
        config,
        speedConfig,
      })
    );
  } catch (e) {
    next(e);
  }
});

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

// ── 取消批次(软取消:PENDING/IMAGE_PENDING/IMAGE_DONE→SKIPPED,RUNNING 等完成) ───────
router.post('/admin/api/batch-upload/:batchNo/cancel', (req, res, next) => {
  try {
    const batch = db.prepare(`SELECT * FROM batch_upload_tasks WHERE batch_no=?`).get(req.params.batchNo);
    if (!batch) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '批次不存在'));
    if (['SUCCESS', 'FAILED', 'PARTIAL'].includes(batch.status)) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, `批次已终态(${batch.status}),不可取消`));
    }
    // 未执行的子任务(PENDING/IMAGE_PENDING/IMAGE_DONE)标 SKIPPED(正在 RUNNING 的等其完成)
    // 两阶段改造:IMAGE_PENDING/IMAGE_DONE 也属于未完成 OPI 的状态,取消时一并跳过
    const result = db
      .prepare(
        `UPDATE batch_upload_items
         SET status='SKIPPED', skip_reason='CANCELLED', finished_at=datetime('now'), updated_at=datetime('now')
         WHERE batch_task_id=? AND status IN ('PENDING','IMAGE_PENDING','IMAGE_DONE')`
      )
      .run(batch.local_task_id);
    // 若无 RUNNING 子任务,直接标终态;否则等 poller 检测到无待处理后自动 completeBatch
    const runningCount = db
      .prepare(`SELECT COUNT(*) AS n FROM batch_upload_items WHERE batch_task_id=? AND status='RUNNING'`)
      .get(batch.local_task_id).n;
    if (runningCount === 0) {
      db.prepare(`UPDATE batch_upload_tasks SET status='CANCELLED', completed_at=datetime('now') WHERE local_task_id=?`).run(
        batch.local_task_id
      );
    } else {
      // 直接标 CANCELLED,允许 RUNNING 子任务完成后 poller 不再处理此批次
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
