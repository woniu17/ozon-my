// 采集箱按筛选导出 Excel(2026-08)
// 流程:筛选条件 → findListForExport(强制排除已导出)→ 按市场统计占比分两组
//   → 每组内 autoPickBySeller 均衡选取(尽可能多地覆盖源店铺)→ 落库 export_tasks/items
//   → markExported 标记 SKU 已导出(再次导出强制跳过)
// Excel:跟卖价格/跟卖最低价格/组合列用公式写入(改"原价格"列可联动重算),
//   同时附 result 缓存值(打开即显示)。下载接口按明细重新生成 xlsx,可多次下载。
import { Router } from 'express';
import ExcelJS from 'exceljs';
import { db } from '../db/index.js';
import { getDaos } from '../db/adapter.js';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { autoPickBySeller } from '../services/batch-distributor.js';
import logger from '../middleware/log.js';

const router = Router();
const daos = await getDaos();

// 清洗筛选条件:剔除 '', null, undefined 值(JSON body 传空串与 query 缺省统一口径,
// 避免 buildFilterWhere 把空串数字参数误解析为 0,如 maxCacheHits='' → 命中数<=0)
function sanitizeFilters(filters) {
  const out = {};
  for (const [k, v] of Object.entries(filters || {})) {
    if (v === '' || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// 数字转展示字符串(与 Excel TEXT(x,"0.##") 同口径):18.99→"18.99",19→"19",1299.5→"1299.5"
function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '';
  return String(Math.round(n * 100) / 100);
}

// 跟卖价格规则(与 Excel 公式 IF(C<=15,19,C) 同口径):原价格<=15 → 19,否则 = 原价格
function computeSalePrice(priceValue) {
  if (priceValue == null || !Number.isFinite(priceValue)) return null;
  return priceValue <= 15 ? 19 : priceValue;
}

// 生成 xlsx 工作簿(下载接口按 export_task_items 明细重建,每次下载内容一致)
// 列:A=SKU B=评论数 C=原价格 D=跟卖价格(公式) E=跟卖最低价格(公式) F=组合列(公式)
function buildWorkbook(task, items) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('导出列表', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'SKU', key: 'sku', width: 24 },
    { header: '评论数', key: 'ratingCount', width: 10 },
    { header: '原价格', key: 'price', width: 12 },
    { header: '跟卖价格', key: 'salePrice', width: 12 },
    { header: '跟卖最低价格', key: 'minPrice', width: 14 },
    { header: 'SKU, 跟卖价格, 跟卖最低价格', key: 'combined', width: 42 },
  ];
  ws.getRow(1).font = { bold: true };

  items.forEach((it, idx) => {
    const row = idx + 2;
    const priceValue =
      it.price_value != null && Number.isFinite(Number(it.price_value)) ? Number(it.price_value) : null;
    ws.getCell(`A${row}`).value = it.sku;
    ws.getCell(`B${row}`).value =
      it.rating_count != null && Number.isFinite(Number(it.rating_count)) ? Number(it.rating_count) : null;

    const c = ws.getCell(`C${row}`);
    c.value = priceValue;
    c.numFmt = '0.##';

    // 跟卖价格 = IF(C<=15, 19, C)
    const salePrice = computeSalePrice(priceValue);
    const d = ws.getCell(`D${row}`);
    d.value = { formula: `IF(C${row}<=15,19,C${row})`, result: salePrice };
    d.numFmt = '0.##';

    // 跟卖最低价格 = D - 0.01
    const minPrice = salePrice == null ? null : Math.round((salePrice - 0.01) * 100) / 100;
    const e = ws.getCell(`E${row}`);
    e.value = { formula: `D${row}-0.01`, result: minPrice };
    e.numFmt = '0.##';

    // 组合列 = "${SKU}, ${跟卖价格}, ${跟卖最低价格}"
    const combined = `${it.sku}, ${fmtNum(salePrice)}, ${fmtNum(minPrice)}`;
    const f = ws.getCell(`F${row}`);
    f.value = {
      formula: `A${row}&", "&TEXT(D${row},"0.##")&", "&TEXT(E${row},"0.##")`,
      result: combined,
    };
  });

  // 信息行:任务元数据写在数据区下方空两行,便于追溯但不干扰数据复制
  const metaRow = items.length + 4;
  ws.getCell(`A${metaRow}`).value = `任务ID: ${task.local_task_id}`;
  ws.getCell(`A${metaRow + 1}`).value = `导出时间: ${task.created_at}`;
  ws.getCell(`A${metaRow + 2}`).value =
    `导出 ${task.total_count} 条(请求 ${task.requested_count}),有市场统计 ${task.market_stats_count} 条,来源卖家 ${task.seller_count} 家`;
  return wb;
}

// POST /admin/api/export-excel/preview —— 导出预览(不创建任务,返回候选池统计)
// body: { count?: number, marketStatsRatio?: 0-100, filters: {...采集箱筛选条件} }
// 前端导出弹窗打开时调用,让用户确认导出前先看到候选规模与预计构成
router.post('/admin/api/export-excel/preview', async (req, res, next) => {
  try {
    const body = req.body || {};
    const filters = sanitizeFilters(body.filters);
    const count = Math.max(0, Math.floor(Number(body.count) || 0));
    const ratio = Math.max(0, Math.min(100, Math.round(Number(body.marketStatsRatio) || 0)));

    // 候选池与创建导出完全同口径:符合筛选 + 未导出;有价格才能进导出池
    const candidates = await daos.indexDao.findListForExport(filters);
    const pool = candidates.filter(
      (c) => c.priceValue != null && Number.isFinite(Number(c.priceValue)) && c.priceValue > 0
    );
    const withStats = pool.filter((c) => c.marketStats);
    const withoutStats = pool.filter((c) => !c.marketStats);
    const sellerCount = new Set(pool.map((c) => c.sellerId)).size;
    // 符合筛选但已导出过的 SKU 数(导出时强制跳过)
    const skippedExported = await daos.indexDao.countByFilter({ ...filters, exported: 'exported' });

    // 按占比 + 互补规则估算构成(与创建导出同口径)
    let statsTarget = Math.round((count * ratio) / 100);
    let noStatsTarget = count - statsTarget;
    if (withStats.length < statsTarget) {
      noStatsTarget += statsTarget - withStats.length;
      statsTarget = withStats.length;
    }
    if (withoutStats.length < noStatsTarget) {
      statsTarget += noStatsTarget - withoutStats.length;
      noStatsTarget = withoutStats.length;
    }

    return res.json(
      ok({
        matchedTotal: candidates.length, // 符合筛选的未导出总数(含无价格)
        poolTotal: pool.length, // 可导出候选(有有效价格)
        noPrice: candidates.length - pool.length, // 符合筛选但无有效价格(导出时排除)
        withStats: withStats.length,
        withoutStats: withoutStats.length,
        sellerCount,
        skippedExported,
        estimatedExport: Math.min(count, pool.length), // count>0 时 = min(count, poolTotal)
        statsTarget, // 预计有市场统计条数(互补后)
        noStatsTarget, // 预计无市场统计条数(互补后)
        insufficient: count > 0 && pool.length < count,
      })
    );
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/export-excel —— 创建导出任务(同步完成,创建即终态 SUCCESS)
// body: { count: number, marketStatsRatio: 0-100, name?: string, filters: {...采集箱筛选条件} }
router.post('/admin/api/export-excel', async (req, res, next) => {
  try {
    const body = req.body || {};
    const countRaw = Math.floor(Number(body.count));
    if (!Number.isFinite(countRaw) || countRaw < 1) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'count 必须为正整数'));
    }
    if (countRaw > 10000) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'count 上限 10000'));
    }
    const ratio = Math.max(0, Math.min(100, Math.round(Number(body.marketStatsRatio) || 0)));
    const filters = sanitizeFilters(body.filters);

    // 1. 取候选:符合筛选 + 未导出 + 有价格(跟卖价格公式依赖原价格列)
    const candidates = await daos.indexDao.findListForExport(filters);
    const pool = candidates.filter(
      (c) => c.priceValue != null && Number.isFinite(Number(c.priceValue)) && c.priceValue > 0
    );
    if (pool.length === 0) {
      return next(
        new ApiError(ErrorCode.VALIDATION_ERROR, '没有符合条件的未导出 SKU(或均无有效价格)')
      );
    }

    // 2. 按"有市场统计占比"分组,目标数不足时互相补足
    const withStats = pool.filter((c) => c.marketStats);
    const withoutStats = pool.filter((c) => !c.marketStats);
    let statsTarget = Math.round((countRaw * ratio) / 100);
    let noStatsTarget = countRaw - statsTarget;
    if (withStats.length < statsTarget) {
      noStatsTarget += statsTarget - withStats.length;
      statsTarget = withStats.length;
    }
    if (withoutStats.length < noStatsTarget) {
      statsTarget += noStatsTarget - withoutStats.length;
      noStatsTarget = withoutStats.length;
    }

    // 3. 每组内按源卖家均衡选取(尽可能多地覆盖源店铺)
    const pickedStats = autoPickBySeller(withStats, statsTarget).picked;
    const pickedNoStats = autoPickBySeller(withoutStats, noStatsTarget).picked;
    const candBySku = new Map(pool.map((c) => [c.sku, c]));
    const picked = [...pickedStats, ...pickedNoStats]
      .map((p) => candBySku.get(p.sku))
      .filter(Boolean);

    // 4. 统计 + 落库(任务 + 明细,事务)
    const localTaskId = `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = String(body.name || '').trim() || `导出 ${picked.length} 条`;
    const marketStatsCount = picked.filter((p) => p.marketStats).length;
    const sellerCount = new Set(picked.map((p) => p.sellerId)).size;
    // 跳过数 = 符合筛选的已导出 SKU 数(导出数据源强制排除)
    const totalMatched = await daos.indexDao.countByFilter({ ...filters, exported: 'exported' });

    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO export_tasks (
           local_task_id, name, status, requested_count, total_count,
           market_stats_count, market_stats_ratio, seller_count, skipped_count, filters
         ) VALUES (?, ?, 'SUCCESS', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        localTaskId,
        name,
        countRaw,
        picked.length,
        marketStatsCount,
        ratio,
        sellerCount,
        totalMatched,
        JSON.stringify(filters)
      );
      const insertItem = db.prepare(
        `INSERT INTO export_task_items (
           task_id, seq, sku, seller_id, name, price, price_value, rating_count, market_stats
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      picked.forEach((p, i) => {
        insertItem.run(
          localTaskId,
          i,
          p.sku,
          p.sellerId || null,
          p.name || null,
          p.price ?? null,
          p.priceValue,
          p.ratingCount ?? null,
          p.marketStats ? 1 : 0
        );
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // 5. 标记已导出(事务失败仅记日志:任务明细已落库可追溯,不影响导出结果)
    try {
      await daos.indexDao.markExported(
        picked.map((p) => p.sku),
        localTaskId
      );
    } catch (e) {
      logger.error({ err: e.message, task: localTaskId }, '[export-excel] markExported failed');
    }

    return res.json(
      ok({
        localTaskId,
        name,
        status: 'SUCCESS',
        requestedCount: countRaw,
        totalCount: picked.length,
        marketStatsCount,
        marketStatsRatio: ratio,
        sellerCount,
        skippedCount: totalMatched,
        insufficient: picked.length < countRaw,
      })
    );
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/export-excel —— 导出任务列表(分页)
router.get('/admin/api/export-excel', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;
    const rows = db
      .prepare(`SELECT * FROM export_tasks ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(pageSize, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM export_tasks`).get().n;
    return res.json(
      ok({
        items: rows.map((r) => ({
          localTaskId: r.local_task_id,
          name: r.name,
          status: r.status,
          requestedCount: r.requested_count,
          totalCount: r.total_count,
          marketStatsCount: r.market_stats_count,
          marketStatsRatio: r.market_stats_ratio,
          sellerCount: r.seller_count,
          skippedCount: r.skipped_count,
          downloadCount: r.download_count,
          createdAt: r.created_at,
        })),
        total,
        current,
        pageSize,
      })
    );
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/export-excel/:localTaskId —— 任务详情(含明细)
router.get('/admin/api/export-excel/:localTaskId', (req, res, next) => {
  try {
    const task = db
      .prepare(`SELECT * FROM export_tasks WHERE local_task_id = ?`)
      .get(String(req.params.localTaskId));
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '导出任务不存在'));
    }
    const items = db
      .prepare(`SELECT * FROM export_task_items WHERE task_id = ? ORDER BY seq ASC`)
      .all(task.local_task_id);
    return res.json(
      ok({
        localTaskId: task.local_task_id,
        name: task.name,
        status: task.status,
        requestedCount: task.requested_count,
        totalCount: task.total_count,
        marketStatsCount: task.market_stats_count,
        marketStatsRatio: task.market_stats_ratio,
        sellerCount: task.seller_count,
        skippedCount: task.skipped_count,
        filters: (() => {
          try {
            return JSON.parse(task.filters || '{}');
          } catch {
            return {};
          }
        })(),
        downloadCount: task.download_count,
        createdAt: task.created_at,
        items: items.map((it) => ({
          seq: it.seq,
          sku: it.sku,
          sellerId: it.seller_id || '',
          name: it.name || '',
          price: it.price ?? '',
          priceValue: it.price_value,
          ratingCount: it.rating_count ?? null,
          marketStats: !!it.market_stats,
          // 跟卖价格/最低价格快照(与 Excel 公式同口径)
          salePrice: computeSalePrice(it.price_value),
        })),
      })
    );
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/export-excel/:localTaskId/download —— 下载 Excel(可多次下载,每次 +1 计数)
router.get('/admin/api/export-excel/:localTaskId/download', async (req, res, next) => {
  try {
    const task = db
      .prepare(`SELECT * FROM export_tasks WHERE local_task_id = ?`)
      .get(String(req.params.localTaskId));
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '导出任务不存在'));
    }
    const items = db
      .prepare(`SELECT * FROM export_task_items WHERE task_id = ? ORDER BY seq ASC`)
      .all(task.local_task_id);
    const wb = buildWorkbook(task, items);

    const filename = `导出_${task.local_task_id}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="export-${task.local_task_id}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    await wb.xlsx.write(res);
    res.end();
    db.prepare(`UPDATE export_tasks SET download_count = download_count + 1 WHERE local_task_id = ?`).run(
      task.local_task_id
    );
  } catch (e) {
    next(e);
  }
});

export default router;
