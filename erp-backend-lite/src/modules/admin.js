// 管理后台路由:店铺 CRUD + 仓库实时拉取 + OPI 凭据连通性测试 + 上架记录查看
// 所有 /admin/api/* 走 JWT 鉴权(由全局 authMiddleware 拦截)
import { Router } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import NodeCache from 'node-cache';
import { db } from '../db/index.js';
import config from '../config/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { ok } from '../utils/response.js';
import * as opi from '../services/ozon-opi.js';
import logger from '../middleware/log.js';

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));
const STORES_FILE = join(__dirname, '../config/stores.json');

// ── 内部工具 ────────────────────────────────────────────────
function readStores() {
  try {
    return JSON.parse(readFileSync(STORES_FILE, 'utf-8'));
  } catch (e) {
    logger.warn({ err: e.message }, 'stores.json 读取失败,回退为空数组');
    return [];
  }
}

function writeStores(stores) {
  writeFileSync(STORES_FILE, JSON.stringify(stores, null, 2) + '\n', 'utf-8');
}

// 由名称生成 slug,用作 id 的一部分
function slugify(name) {
  return (
    String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'store'
  );
}

// 校验并规范化店铺对象
function normalizeStore(input) {
  const body = input || {};
  const name = String(body.name || '').trim();
  if (!name) throw new ApiError(ErrorCode.VALIDATION_ERROR, '店铺名称 name 必填');

  const creds = body.sync_credentials || {};
  const clientId = String(creds.clientId || '').trim();
  const apiKey = String(creds.apiKey || '').trim();

  // 货币代码:Ozon 店铺合同货币(RUB/KZT/USD/EUR/...),默认 RUB
  // 必须与店铺在 Ozon 后台合同约定的货币一致,否则 /v3/product/import 会报:
  //   "Неверно указана валюта..." (货币不正确)
  const currencyCode = String(body.currency_code || 'RUB')
    .trim()
    .toUpperCase();

  return {
    name,
    company_id: String(body.company_id || '').trim(),
    warehouse_id: String(body.warehouse_id || '').trim(),
    currency_code: currencyCode,
    sync_credentials: { clientId, apiKey },
  };
}

// 用凭据调用 OPI 仓库列表,返回 { success, warehouses, error }
async function testOpiCredentials(clientId, apiKey) {
  if (!clientId || !apiKey) {
    return { success: false, warehouses: [], error: 'clientId / apiKey 不能为空' };
  }
  const fakeStore = {
    id: '__test__',
    sync_credentials: { clientId, apiKey },
  };
  try {
    const r = await opi.warehouseList(fakeStore);
    // OPI /v2/warehouse/list 顶层字段是 warehouses(非 result),并带 has_next/cursor
    const items = Array.isArray(r?.warehouses) ? r.warehouses : [];
    return { success: true, warehouses: items, error: null };
  } catch (e) {
    return { success: false, warehouses: [], error: e?.message || String(e) };
  }
}

// ── 路由 ────────────────────────────────────────────────────

// GET /admin/api/stores —— 列出全部店铺(含凭据,个人版明文展示)
router.get('/admin/api/stores', (_req, res, next) => {
  try {
    const stores = readStores();
    res.json(ok(stores));
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/stores —— 新增店铺
router.post('/admin/api/stores', (req, res, next) => {
  try {
    const stores = readStores();
    const partial = normalizeStore(req.body);
    // id 唯一:slug + 短 uuid,冲突时再追加
    let id = `store-${slugify(partial.name)}-${randomUUID().slice(0, 6)}`;
    while (stores.some((s) => s.id === id)) {
      id = `store-${slugify(partial.name)}-${randomUUID().slice(0, 6)}`;
    }
    const store = { id, ...partial };
    stores.push(store);
    writeStores(stores);
    res.status(201).json(ok(store));
  } catch (e) {
    next(e);
  }
});

// PUT /admin/api/stores/:id —— 更新店铺(整体替换,凭据空值表示不变更由前端处理)
router.put('/admin/api/stores/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    const stores = readStores();
    const idx = stores.findIndex((s) => s.id === id);
    if (idx < 0) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `店铺不存在: ${id}`));
    }
    const partial = normalizeStore(req.body);
    stores[idx] = { id, ...partial };
    writeStores(stores);
    res.json(ok(stores[idx]));
  } catch (e) {
    next(e);
  }
});

// DELETE /admin/api/stores/:id —— 删除店铺
router.delete('/admin/api/stores/:id', (req, res, next) => {
  try {
    const id = req.params.id;
    const stores = readStores();
    const idx = stores.findIndex((s) => s.id === id);
    if (idx < 0) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `店铺不存在: ${id}`));
    }
    const [removed] = stores.splice(idx, 1);
    writeStores(stores);
    res.json(ok(removed));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/stores/:id/warehouses —— 实时拉取该店铺的真实仓库列表
router.get('/admin/api/stores/:id/warehouses', async (req, res, next) => {
  try {
    const id = req.params.id;
    const stores = readStores();
    const store = stores.find((s) => s.id === id);
    if (!store) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `店铺不存在: ${id}`));
    }
    const result = await testOpiCredentials(store.sync_credentials?.clientId, store.sync_credentials?.apiKey);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/stores/:id/test-connection —— 测试已保存店铺的 OPI 凭据
router.post('/admin/api/stores/:id/test-connection', async (req, res, next) => {
  try {
    const id = req.params.id;
    const stores = readStores();
    const store = stores.find((s) => s.id === id);
    if (!store) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `店铺不存在: ${id}`));
    }
    const result = await testOpiCredentials(store.sync_credentials?.clientId, store.sync_credentials?.apiKey);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/test-connection —— 用请求体凭据测试(无需先保存,便于新增时即时验证)
router.post('/admin/api/test-connection', async (req, res, next) => {
  try {
    const creds = req.body?.sync_credentials || req.body || {};
    const result = await testOpiCredentials(creds.clientId, creds.apiKey);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// ── 上架记录 ───────────────────────────────────────────────

// 解析 items_preview JSON(容错)
function safeParseItems(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// 解析 errors JSON(容错)
function safeParseErrors(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// 解析任意 JSON(容错:解析失败返回 null)
function safeParseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// GET /admin/api/listing-records —— 上架记录列表(跨店铺,支持筛选 + 分页)
// query: ?currentPage=1&pageSize=20&storeId=&status=&viaPortal=&keyword=
router.get('/admin/api/listing-records', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;

    const where = [];
    const params = [];
    if (req.query.storeId) {
      where.push('store_id = ?');
      params.push(String(req.query.storeId));
    }
    if (req.query.status) {
      where.push('status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.viaPortal === '1' || req.query.viaPortal === 'true') {
      where.push('via_portal = 1');
    } else if (req.query.viaPortal === '0' || req.query.viaPortal === 'false') {
      where.push('via_portal = 0');
    }
    if (req.query.keyword) {
      where.push('(local_task_id LIKE ? OR ozon_task_id LIKE ? OR items_preview LIKE ?)');
      const kw = '%' + String(req.query.keyword) + '%';
      params.push(kw, kw, kw);
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db
      .prepare(`SELECT * FROM follow_sell_tasks ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);

    // 按 local_task_id 批量汇总 items 状态计数
    const localIds = rows.map((r) => r.local_task_id);
    let countMap = {};
    if (localIds.length > 0) {
      const placeholders = localIds.map(() => '?').join(',');
      const cntRows = db
        .prepare(
          `SELECT local_task_id, status, COUNT(*) as n FROM follow_sell_task_items
           WHERE local_task_id IN (${placeholders}) GROUP BY local_task_id, status`
        )
        .all(...localIds);
      for (const r of cntRows) {
        if (!countMap[r.local_task_id]) {
          countMap[r.local_task_id] = { imported: 0, failed: 0, pending: 0, skipped: 0 };
        }
        const bucket = countMap[r.local_task_id];
        if (r.status === 'imported') bucket.imported = r.n;
        else if (r.status === 'failed') bucket.failed = r.n;
        else if (r.status === 'skipped') bucket.skipped = r.n;
        else bucket.pending = r.n;
      }
    }

    const total = db.prepare(`SELECT COUNT(*) as n FROM follow_sell_tasks ${whereSql}`).get(...params).n;

    res.json(
      ok({
        items: rows.map((r) => ({
          localTaskId: r.local_task_id,
          viaPortal: !!r.via_portal,
          storeId: r.store_id,
          status: r.status,
          itemsCount: r.items_count,
          itemsPreview: safeParseItems(r.items_preview),
          ozonTaskId: r.ozon_task_id,
          bundleIds: r.bundle_ids ? safeParseErrors(r.bundle_ids) : null,
          errorMessage: r.error_message,
          createdAt: r.created_at,
          completedAt: r.completed_at,
          summary: countMap[r.local_task_id] || null,
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

// GET /admin/api/listing-records/:localTaskId —— 单任务详情(含每个 offer_id 明细)
router.get('/admin/api/listing-records/:localTaskId', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const task = db.prepare(`SELECT * FROM follow_sell_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '上架记录不存在: ' + localTaskId));
    }
    const itemRows = db
      .prepare(`SELECT * FROM follow_sell_task_items WHERE local_task_id=? ORDER BY id ASC`)
      .all(localTaskId);

    res.json(
      ok({
        task: {
          localTaskId: task.local_task_id,
          viaPortal: !!task.via_portal,
          storeId: task.store_id,
          status: task.status,
          itemsCount: task.items_count,
          itemsPreview: safeParseItems(task.items_preview),
          ozonTaskId: task.ozon_task_id,
          bundleIds: task.bundle_ids ? safeParseErrors(task.bundle_ids) : null,
          errorMessage: task.error_message,
          strictSkipped: task.strict_skipped ? safeParseErrors(task.strict_skipped) : [],
          invalidImage: task.invalid_image ? safeParseErrors(task.invalid_image) : [],
          createdAt: task.created_at,
          completedAt: task.completed_at,
        },
        items: itemRows.map((r) => ({
          offerId: r.offer_id,
          name: r.name,
          price: r.price,
          productId: r.product_id,
          status: r.status,
          errors: safeParseErrors(r.errors),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      })
    );
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/listing-records/:localTaskId/payloads —— 查询某次上架请求体备份
// 返回 raw(插件原始 items) + transformed(prepareBundleItems 转换后提交给 OPI 的 items)
// 仅 API 上架(via_portal=0)会写 payload 备份;模拟手动 (viaPortal) 无此数据。
router.get('/admin/api/listing-records/:localTaskId/payloads', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const task = db.prepare(`SELECT local_task_id FROM follow_sell_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '上架记录不存在: ' + localTaskId));
    }
    const rows = db
      .prepare(
        `SELECT stage, payload, created_at FROM follow_sell_task_payloads
         WHERE local_task_id=? ORDER BY id ASC`
      )
      .all(localTaskId);
    res.json(
      ok({
        localTaskId,
        stages: rows.map((r) => ({
          stage: r.stage,
          createdAt: r.created_at,
          payload: r.payload ? JSON.parse(r.payload) : null,
        })),
      })
    );
  } catch (e) {
    next(e);
  }
});

// DELETE /admin/api/listing-records/:localTaskId —— 删除单条上架记录(含明细)
router.delete('/admin/api/listing-records/:localTaskId', (req, res, next) => {
  try {
    const localTaskId = String(req.params.localTaskId);
    const task = db.prepare(`SELECT id FROM follow_sell_tasks WHERE local_task_id=?`).get(localTaskId);
    if (!task) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '上架记录不存在: ' + localTaskId));
    }
    db.exec('BEGIN');
    try {
      db.prepare(`DELETE FROM follow_sell_task_items WHERE local_task_id=?`).run(localTaskId);
      db.prepare(`DELETE FROM follow_sell_tasks WHERE local_task_id=?`).run(localTaskId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.json(ok({ deleted: true, localTaskId }));
  } catch (e) {
    next(e);
  }
});

// ── 采集箱(跨店铺,admin 用,不带 storeGuard) ───────────────

// GET /admin/api/collect-box —— 采集箱列表(支持 storeId/published/keyword 筛选 + 分页)
// query: ?currentPage=1&pageSize=20&storeId=&published=0|1&keyword=
router.get('/admin/api/collect-box', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;

    const where = [];
    const params = [];
    if (req.query.storeId) {
      where.push('store_id = ?');
      params.push(String(req.query.storeId));
    }
    if (req.query.published === '1' || req.query.published === 'true') {
      where.push('published = 1');
    } else if (req.query.published === '0' || req.query.published === 'false') {
      where.push('published = 0');
    }
    if (req.query.keyword) {
      where.push('product LIKE ?');
      params.push('%' + String(req.query.keyword) + '%');
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db
      .prepare(`SELECT * FROM collect_box ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset);
    const total = db.prepare(`SELECT COUNT(*) as n FROM collect_box ${whereSql}`).get(...params).n;

    res.json(
      ok({
        items: rows.map((r) => ({
          id: r.id,
          storeId: r.store_id,
          product: safeParseJson(r.product),
          aiDraft: r.ai_draft ? safeParseJson(r.ai_draft) : null,
          published: !!r.published,
          source: r.source,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
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

// DELETE /admin/api/collect-box/:id —— 删除单条采集箱条目
router.delete('/admin/api/collect-box/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'id 无效'));
    const info = db.prepare(`DELETE FROM collect_box WHERE id=?`).run(id);
    if (info.changes === 0) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '采集箱条目不存在: ' + id));
    }
    res.json(ok({ deleted: true, id }));
  } catch (e) {
    next(e);
  }
});

// PATCH /admin/api/collect-box/:id —— 更新 published 状态(admin 用,仅切发布标记)
router.patch('/admin/api/collect-box/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'id 无效'));
    const row = db.prepare(`SELECT * FROM collect_box WHERE id=?`).get(id);
    if (!row) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '采集箱条目不存在: ' + id));
    const body = req.body || {};
    if (typeof body.published === 'boolean') {
      db.prepare(`UPDATE collect_box SET published=?, updated_at=datetime('now') WHERE id=?`).run(
        body.published ? 1 : 0,
        id
      );
    }
    const updated = db.prepare(`SELECT * FROM collect_box WHERE id=?`).get(id);
    res.json(
      ok({
        id: updated.id,
        published: !!updated.published,
        updatedAt: updated.updated_at,
      })
    );
  } catch (e) {
    next(e);
  }
});

// ── 采集箱 v2(全数据源采集,字段级来源标记) ───────────────

// GET /admin/api/collect-box-v2 —— 全源采集列表(筛选 + 分页,返摘要+主图+名称+价格)
// query: ?currentPage=1&pageSize=20&storeId=&keyword=&hasVideo=&minVariants=
// 仅展示 collect_box_v2(全源新表);老表 collect_box 在「采集箱」tab 单独展示。
// 摘要从 variants_json 第一变体提取主图/名称/价格,避免列表加载全量 raw_by_source。
router.get('/admin/api/collect-box-v2', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;

    const where = [];
    const params = [];
    if (req.query.storeId) {
      where.push('store_id = ?');
      params.push(String(req.query.storeId));
    }
    if (req.query.keyword) {
      where.push('(anchor_sku LIKE ? OR variants_json LIKE ?)');
      params.push('%' + String(req.query.keyword) + '%', '%' + String(req.query.keyword) + '%');
    }
    if (req.query.minVariants) {
      const min = Number(req.query.minVariants);
      if (Number.isFinite(min) && min > 0) {
        where.push('variant_count >= ?');
        params.push(min);
      }
    }
    // hasVideo=1:raw_by_source_json 含 transferredVideoUrl(SQLite JSON 查询弱,用 LIKE 兜底)
    if (req.query.hasVideo === '1' || req.query.hasVideo === 'true') {
      where.push("raw_by_source_json LIKE '%transferredVideoUrl%'");
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db
      .prepare(
        `SELECT id, store_id, anchor_sku, source_page_url,
                variant_count, collected_at, created_at, variants_json
         FROM collect_box_v2 ${whereSql}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);

    const total = db
      .prepare(`SELECT COUNT(*) as n FROM collect_box_v2 ${whereSql}`)
      .get(...params).n;

    res.json(
      ok({
        items: rows.map((r) => {
          // 从 variants_json 第一变体提取主图/名称/价格(SourcedField 结构: {value, source,...})
          const variants = safeParseJson(r.variants_json) || [];
          const v0 = variants[0] || {};
          const imgVal = v0.images?.value;
          const primaryImage = Array.isArray(imgVal) ? imgVal[0] || '' : '';
          const name = v0.name?.value || '';
          const price = v0.price?.value ?? '';
          const oldPrice = v0.oldPrice?.value ?? '';
          return {
            id: r.id,
            sourceTable: 'collect_box_v2',
            storeId: r.store_id,
            anchorSku: r.anchor_sku,
            sourcePageUrl: r.source_page_url,
            variantCount: r.variant_count,
            collectedAt: r.collected_at,
            createdAt: r.created_at,
            primaryImage,
            name,
            price,
            oldPrice,
          };
        }),
        total,
        current,
        pageSize,
      })
    );
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/collect-box-v2/:id —— 全源采集详情(返全量 JSON)
// query: ?sourceTable=collect_box — 老表分流,把 product JSON 映射成 v2 兼容结构
router.get('/admin/api/collect-box-v2/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'id 无效'));
    const sourceTable = req.query.sourceTable === 'collect_box' ? 'collect_box' : 'collect_box_v2';

    if (sourceTable === 'collect_box') {
      // 老表:product JSON 映射成 v2 兼容结构(单变体,字段 source 统一标 'legacy')
      const row = db.prepare(`SELECT * FROM collect_box WHERE id=?`).get(id);
      if (!row) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '记录不存在: ' + id));
      const p = safeParseJson(row.product) || {};
      const now = Date.now();
      const sf = (value) => ({ value, source: 'legacy', collectedAt: now });
      const variant = {
        sequence: 1,
        sku: sf(p.sku),
        title: sf(p.name),
        price: sf(p.price),
        currency: sf(p.priceCurrency),
        image: sf(p.image),
        images: sf(Array.isArray(p.images) ? p.images : []),
        videoUrl: sf(p.videoUrl || null),
        videoCover: sf(p.videoCover || null),
        url: sf(p.url),
        sellerName: sf(p.sellerName || null),
        sellerLink: sf(p.sellerLink || null),
      };
      res.json(
        ok({
          id: row.id,
          sourceTable: 'collect_box',
          storeId: row.store_id,
          anchorSku: String(p.sku || ''),
          sourcePageUrl: p.url || '',
          variantCount: 1,
          variants: [variant],
          rawBySource: {
            legacy: { product: p, note: '老表采集记录,无字段级 source 标记' },
          },
          synthesizedItems: [],
          collectedAt: new Date(row.created_at + 'Z').getTime() || null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      );
      return;
    }

    // v2 新表:原样返回
    const row = db.prepare(`SELECT * FROM collect_box_v2 WHERE id=?`).get(id);
    if (!row) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '记录不存在: ' + id));

    res.json(
      ok({
        id: row.id,
        sourceTable: 'collect_box_v2',
        storeId: row.store_id,
        anchorSku: row.anchor_sku,
        sourcePageUrl: row.source_page_url,
        variantCount: row.variant_count,
        variants: safeParseJson(row.variants_json) || [],
        rawBySource: safeParseJson(row.raw_by_source_json) || {},
        synthesizedItems: safeParseJson(row.synthesized_items_json) || [],
        collectedAt: row.collected_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
    );
  } catch (e) {
    next(e);
  }
});

// DELETE /admin/api/collect-box-v2/:id —— 删除全源采集记录
// query: ?sourceTable=collect_box — 删老表
router.delete('/admin/api/collect-box-v2/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'id 无效'));
    const sourceTable = req.query.sourceTable === 'collect_box' ? 'collect_box' : 'collect_box_v2';
    const table = sourceTable === 'collect_box' ? 'collect_box' : 'collect_box_v2';
    const info = db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    if (info.changes === 0) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '记录不存在: ' + id));
    }
    res.json(ok({ deleted: true, id }));
  } catch (e) {
    next(e);
  }
});

// ── 商品列表(查 product_data_cache,跨店铺) ───────────────

// GET /admin/api/products —— 商品数据缓存列表(支持 keyword 模糊搜 sku / data)
// query: ?currentPage=1&pageSize=20&keyword=
router.get('/admin/api/products', (req, res, next) => {
  try {
    const current = Math.max(1, Number(req.query.currentPage) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (current - 1) * pageSize;

    const where = [];
    const params = [];
    if (req.query.keyword) {
      where.push('(sku LIKE ? OR data LIKE ?)');
      const kw = '%' + String(req.query.keyword) + '%';
      params.push(kw, kw);
    }
    if (req.query.storeId) {
      where.push('store_id = ?');
      params.push(String(req.query.storeId));
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db
      .prepare(
        `SELECT sku, data, store_id, fetched_at FROM product_data_cache ${whereSql} ORDER BY fetched_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    const total = db.prepare(`SELECT COUNT(*) as n FROM product_data_cache ${whereSql}`).get(...params).n;

    res.json(
      ok({
        items: rows.map((r) => {
          const data = safeParseJson(r.data) || {};
          return {
            sku: r.sku,
            storeId: r.store_id || '',
            fetchedAt: r.fetched_at,
            // 提取常用展示字段(容错:不同 OPI 版本字段名可能不同)
            name: data.name || data.title || '',
            productId: data.product_id || data.id || '',
            offerId: data.offer_id || data.sku || r.sku,
            price: data.price || data.marketing_price || '',
            currency: data.currency || data.marketing_currency || '',
            image: data.primary_image || data.image || (Array.isArray(data.images) ? data.images[0] : '') || '',
            _raw: data,
          };
        }),
        total,
        current,
        pageSize,
      })
    );
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/products/sync —— 从 Ozon 拉取店铺全部商品并写入 product_data_cache
// query: ?storeId=xxx(必填,OPI 凭据所属店铺)
// 响应: { synced, total, durationMs }
router.post('/admin/api/products/sync', async (req, res) => {
  try {
    const storeId = req.query.storeId ? String(req.query.storeId) : '';
    if (!storeId) {
      return res.status(400).json({ code: 1, message: '需要 storeId 参数' });
    }
    const stores = readStores();
    const store = stores.find((s) => s.id === storeId);
    if (!store) {
      return res.status(404).json({ code: 1, message: `店铺不存在: ${storeId}` });
    }

    const startedAt = Date.now();
    let lastId = '';
    let total = 0;
    let synced = 0;
    const limit = 1000;

    // 循环拉取商品列表(游标分页),批量拉详情后写入 product_data_cache
    while (true) {
      const listResp = await opi.productList(store, { lastId, limit });
      const items = listResp?.result?.items || listResp?.items || [];
      total = listResp?.result?.total || listResp?.total || total;
      if (items.length === 0) break;

      const productIds = items.map((it) => it.product_id).filter(Boolean);
      if (productIds.length > 0) {
        const infoResp = await opi.productInfoListV3(store, { productIds });
        const infoItems = infoResp?.result?.items || infoResp?.items || [];
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO product_data_cache (sku, data, store_id, fetched_at) VALUES (?, ?, ?, datetime('now'))`
        );
        for (const item of infoItems) {
          const sku = String(item.sku || item.id || '');
          if (!sku) continue;
          stmt.run(sku, JSON.stringify(item), storeId);
          synced++;
        }
      }

      lastId = listResp?.result?.last_id || listResp?.last_id || '';
      if (items.length < limit) break; // 最后一页
    }

    const durationMs = Date.now() - startedAt;
    res.json(ok({ synced, total, durationMs }));
  } catch (err) {
    res.status(500).json({ code: 1, message: err.message });
  }
});

// GET /admin/api/products/:sku —— 单条商品完整数据(JSON)
router.get('/admin/api/products/:sku', (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const row = db.prepare(`SELECT sku, data, store_id, fetched_at FROM product_data_cache WHERE sku=?`).get(sku);
    if (!row) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '商品不存在: ' + sku));
    res.json(
      ok({
        sku: row.sku,
        storeId: row.store_id || '',
        fetchedAt: row.fetched_at,
        data: safeParseJson(row.data) || {},
      })
    );
  } catch (e) {
    next(e);
  }
});

// ── 商品特征描述 & 详情(三级缓存:内存 + DB + OPI 实时) ─────

// L1 内存缓存:1 小时(与 DB 缓存互补,key 为 attr_${sku})
const attrMemCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// GET /admin/api/products/:sku/attributes —— 拉取商品特征描述 + 详情(三级缓存)
// query: ?storeId=xxx(必填,OPI 凭据所属店铺)
// 响应: { attributes, description, fetchedAt, source }
//   source: 'mem' / 'db' / 'opi' / 'db-stale'(OPI 失败时降级返回过期 DB 缓存)
router.get('/admin/api/products/:sku/attributes', async (req, res, next) => {
  try {
    const sku = String(req.params.sku);
    const storeId = req.query.storeId ? String(req.query.storeId) : '';
    if (!storeId) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, '需要 storeId 参数'));
    }

    const memKey = `attr_${sku}`;

    // L1: 内存缓存
    const memCached = attrMemCache.get(memKey);
    if (memCached) {
      return res.json(
        ok({
          attributes: memCached.attributes,
          description: memCached.description,
          fetchedAt: memCached.fetchedAt,
          source: 'mem',
        })
      );
    }

    // L2: DB 缓存
    const row = db
      .prepare(`SELECT attributes_data, description_data, fetched_at FROM product_attributes_cache WHERE sku=?`)
      .get(sku);
    if (row) {
      const age = Date.now() - new Date(row.fetched_at).getTime();
      if (age < config.productDataCacheTtlMs) {
        const attributes = safeParseJson(row.attributes_data) || {};
        const description = safeParseJson(row.description_data) || {};
        const payload = { attributes, description, fetchedAt: row.fetched_at };
        attrMemCache.set(memKey, payload);
        return res.json(ok({ ...payload, source: 'db' }));
      }
    }

    // L3: OPI 实时拉取
    const stores = readStores();

    // 从 product_data_cache 取 offer_id / product_id 作为 OPI filter,同时取 store_id
    const baseRow = db.prepare(`SELECT data, store_id FROM product_data_cache WHERE sku=?`).get(sku);
    const baseData = baseRow ? safeParseJson(baseRow.data) : null;
    // storeId 优先级:query 参数 > DB 中商品的 store_id > storesCache[0]
    const effectiveStoreId = storeId || baseRow?.store_id || '';
    const store = stores.find((s) => s.id === effectiveStoreId);
    if (!store) {
      return next(
        new ApiError(
          ErrorCode.RESOURCE_NOT_FOUND,
          `店铺不存在: ${effectiveStoreId || '(空)'},请先同步商品或指定 storeId`
        )
      );
    }

    let filter;
    let descBody;
    // /v3/product/info/list 返回字段:id(Ozon product_id)、sku(变体 SKU)、offer_id(货号)
    // /v4/product/info/attributes filter 接受 offer_id / product_id / sku(三选一)
    // /v1/product/info/description 接受 offer_id 或 product_id(不支持 sku)
    // 实测:部分商品用 sku 过滤 attributes 会 404 "item not found",
    //   用父级 product_id 最可靠(attributes 和 description 均支持)
    const pid = baseData?.product_id || baseData?.id;
    if (pid != null && Number(pid) > 0) {
      const pidNum = Number(pid);
      // attributes filter.product_id 类型为 array<string,int64>;description.product_id 类型为 integer
      filter = { product_id: [String(pidNum)] };
      descBody = { product_id: pidNum };
    } else {
      // 兜底:无 product_id 时用 offer_id
      const offerId = String(baseData?.offer_id || '');
      filter = { offer_id: [offerId] };
      descBody = { offer_id: offerId };
    }

    try {
      const [attributesRes, descriptionRes] = await Promise.all([
        opi.productInfoAttributes(store, filter),
        opi.productInfoDescription(store, descBody),
      ]);

      const fetchedAt = new Date().toISOString();
      db.prepare(
        `INSERT OR REPLACE INTO product_attributes_cache (sku, attributes_data, description_data, fetched_at) VALUES (?, ?, ?, ?)`
      ).run(sku, JSON.stringify(attributesRes || {}), JSON.stringify(descriptionRes || {}), fetchedAt);

      const payload = {
        attributes: attributesRes || {},
        description: descriptionRes || {},
        fetchedAt,
      };
      attrMemCache.set(memKey, payload);
      return res.json(ok({ ...payload, source: 'opi' }));
    } catch (e) {
      logger.warn({ sku, storeId, err: e.message }, 'productInfoAttributes/Description failed');
      // 降级:若 DB 有过期缓存,返回过期缓存
      if (row) {
        const attributes = safeParseJson(row.attributes_data) || {};
        const description = safeParseJson(row.description_data) || {};
        return res.json(ok({ attributes, description, fetchedAt: row.fetched_at, source: 'db-stale' }));
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

// ────────────────────────────────────────────────────────────
// 首页统计(P1-3:聚合现有表,无需新表)
// ────────────────────────────────────────────────────────────
router.get('/admin/api/dashboard-stats', (_req, res, next) => {
  try {
    // 今日上架任务按 status 分组
    const todayRows = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM follow_sell_tasks
         WHERE date(created_at) = date('now') GROUP BY status`
      )
      .all();
    let todayTotal = 0;
    let todaySuccess = 0;
    let todayFailed = 0;
    for (const r of todayRows) {
      todayTotal += r.n;
      if (r.status === 'SUCCESS') todaySuccess += r.n;
      else if (r.status === 'FAILED') todayFailed += r.n;
    }
    const todayRate = todayTotal > 0 ? Math.round((todaySuccess / todayTotal) * 1000) / 10 : 0;

    // 采集箱待发布数
    const collectPending = db.prepare(`SELECT COUNT(*) AS n FROM collect_box WHERE published = 0`).get().n;

    // 商品缓存数
    const productCount = db.prepare(`SELECT COUNT(*) AS n FROM product_data_cache`).get().n;

    // 店铺数(店铺数据存在 stores.json,不在数据库里)
    const storeCount = readStores().length;

    // 近 7 天上架趋势(按天聚合)
    const trend = db
      .prepare(
        `SELECT date(created_at) AS d, COUNT(*) AS n, SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) AS ok
         FROM follow_sell_tasks
         WHERE created_at > datetime('now', '-7 days')
         GROUP BY d ORDER BY d ASC`
      )
      .all();

    res.json(
      ok({
        today: { total: todayTotal, success: todaySuccess, failed: todayFailed, successRate: todayRate },
        collectPending,
        productCount,
        storeCount,
        trend: trend.map((t) => ({ date: t.d, total: t.n, success: t.ok || 0 })),
      })
    );
  } catch (e) {
    next(e);
  }
});

// ────────────────────────────────────────────────────────────
// 操作日志(P2-3:audit_logs 列表查询)
// ────────────────────────────────────────────────────────────
router.get('/admin/api/audit-logs', (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.currentPage, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * size;
    const where = [];
    const params = [];
    if (req.query.action) {
      where.push('action = ?');
      params.push(req.query.action);
    }
    if (req.query.storeId) {
      where.push('store_id = ?');
      params.push(req.query.storeId);
    }
    if (req.query.operator) {
      where.push('operator LIKE ?');
      params.push('%' + req.query.operator + '%');
    }
    if (req.query.startDate) {
      where.push('created_at >= ?');
      params.push(req.query.startDate);
    }
    if (req.query.endDate) {
      where.push('created_at <= ?');
      params.push(req.query.endDate + ' 23:59:59');
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${whereSql}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT id, action, target, store_id, operator, detail, ip, created_at
         FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, size, offset);
    res.json(
      ok({
        items: rows.map((r) => ({
          id: r.id,
          action: r.action,
          target: r.target,
          storeId: r.store_id,
          operator: r.operator,
          detail: safeParseJson(r.detail),
          ip: r.ip,
          createdAt: r.created_at,
        })),
        total,
        currentPage: page,
        pageSize: size,
      })
    );
  } catch (e) {
    next(e);
  }
});

export default router;
