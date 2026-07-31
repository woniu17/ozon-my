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
import * as metaDao from '../db/dao/sqlite/meta-dao.js';
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

  // 货币代码:Ozon 店铺合同货币(RUB/KZT/USD/EUR/...),默认 CNY(跨境店铺常用)
  // 必须与店铺在 Ozon 后台合同约定的货币一致,否则 /v3/product/import 会报:
  //   "Неверно указана валюта..." (货币不正确)
  const currencyCode = String(body.currency_code || 'CNY')
    .trim()
    .toUpperCase();

  // 店铺链接:可选,通常为 Ozon 卖家后台或店铺前台 URL,卡片展示为可点击链接
  const link = String(body.link || '').trim();

  return {
    name,
    // Ozon 个人版 company_id 与 Client-Id 同值(同义字段),为兼容 prepare-bundle 的
    // 公司一致性护栏(store_company_id)而保留,值直接取 clientId
    company_id: clientId,
    warehouse_id: String(body.warehouse_id || '').trim(),
    currency_code: currencyCode,
    link,
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

// GET /admin/api/stores —— 列出全部店铺(含凭据,个人版明文展示)+ 每家店铺采集 SKU 数
// 采集 SKU 数:ozon_cache_index 中 listed_store_id = store.id 的行数(已跟卖到该店铺的 SKU)
router.get('/admin/api/stores', (_req, res, next) => {
  try {
    const stores = readStores();
    // 一次性按 listed_store_id 分组聚合,避免 N+1 查询
    const countRows = db
      .prepare(
        `SELECT listed_store_id AS sid, COUNT(*) AS n
         FROM ozon_cache_index
         WHERE listed_store_id IS NOT NULL AND listed_store_id != ''
         GROUP BY listed_store_id`
      )
      .all();
    const countMap = {};
    for (const r of countRows) countMap[r.sid] = r.n;
    const result = stores.map((s) => ({
      ...s,
      collected_sku_count: countMap[s.id] || 0,
    }));
    res.json(ok(result));
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
    // credentials_verified 默认 false,需通过 /test-connection 验证后才会置 true
    const store = { id, ...partial, credentials_verified: false };
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
    // 凭据变化时重置 verified=false(下次需重新测试);凭据未变则保留原 verified 状态
    const prev = stores[idx] || {};
    const prevCreds = prev.sync_credentials || {};
    const newCreds = partial.sync_credentials || {};
    const credsChanged =
      prevCreds.clientId !== newCreds.clientId || prevCreds.apiKey !== newCreds.apiKey;
    stores[idx] = {
      id,
      ...partial,
      credentials_verified: credsChanged ? false : !!prev.credentials_verified,
    };
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
// 成功时把 credentials_verified 持久化为 true,失败时置 false
router.post('/admin/api/stores/:id/test-connection', async (req, res, next) => {
  try {
    const id = req.params.id;
    const stores = readStores();
    const idx = stores.findIndex((s) => s.id === id);
    if (idx < 0) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `店铺不存在: ${id}`));
    }
    const store = stores[idx];
    const result = await testOpiCredentials(store.sync_credentials?.clientId, store.sync_credentials?.apiKey);
    // 同步 verified 状态到 stores.json,前端刷新后凭据 badge 会更新
    stores[idx] = { ...store, credentials_verified: result.success };
    writeStores(stores);
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
      where.push('f.store_id = ?');
      params.push(String(req.query.storeId));
    }
    if (req.query.status) {
      where.push('f.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.imageIssue === '1' || req.query.imageIssue === 'true') {
      // 图片问题筛选:invalid_image 非空 OR items 有图片相关错误
      // 快速预筛(基于上架时已存的 OPI 响应),详情页提供「检查图片状态」按钮实时查 Ozon 最新状态
      where.push(
        `((f.invalid_image IS NOT NULL AND f.invalid_image != '' AND f.invalid_image != '[]')
          OR EXISTS (SELECT 1 FROM follow_sell_task_items i
                     WHERE i.local_task_id = f.local_task_id
                       AND i.has_error = 1
                       AND (i.errors LIKE '%image%' OR i.errors LIKE '%photo%'
                            OR i.errors LIKE '%picture%' OR i.errors LIKE '%图片%' OR i.errors LIKE '%照片%')))`
      );
    }
    if (req.query.viaPortal === '1' || req.query.viaPortal === 'true') {
      where.push('f.via_portal = 1');
    } else if (req.query.viaPortal === '0' || req.query.viaPortal === 'false') {
      where.push('f.via_portal = 0');
    }
    if (req.query.keyword) {
      // keyword 同时匹配:任务ID / Ozon Task ID / items_preview / items 表的 offer_id(跟卖SKU)
      // offer_id 走子查询 EXISTS,避免同一任务因多个匹配项重复出现
      where.push(
        `(f.local_task_id LIKE ? OR f.ozon_task_id LIKE ? OR f.items_preview LIKE ?
          OR EXISTS (SELECT 1 FROM follow_sell_task_items i
                     WHERE i.local_task_id = f.local_task_id
                       AND i.offer_id LIKE ?))`
      );
      const kw = '%' + String(req.query.keyword) + '%';
      params.push(kw, kw, kw, kw);
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const rows = db
      .prepare(
        `SELECT f.*, irt.status AS image_refresh_status
         FROM follow_sell_tasks f
         LEFT JOIN image_refresh_tasks irt ON irt.local_task_id = f.image_refresh_task_id
         ${whereSql} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);

    // 按 local_task_id 批量汇总 items 状态计数
    const localIds = rows.map((r) => r.local_task_id);
    let countMap = {};
    if (localIds.length > 0) {
      const placeholders = localIds.map(() => '?').join(',');
      // 按 (local_task_id, effective_status) 汇总:
      //   imported + has_error=1 → 视为 failed(审核拒绝)
      //   imported + has_error=0 → imported
      //   其余按原 status
      const cntRows = db
        .prepare(
          `SELECT local_task_id,
             CASE
               WHEN status='imported' AND has_error=1 THEN 'failed'
               ELSE status
             END AS eff_status,
             CASE
               WHEN status='imported' AND has_error=0 AND has_warning=1 THEN 1
               ELSE 0
             END AS is_warning,
             COUNT(*) as n
           FROM follow_sell_task_items
           WHERE local_task_id IN (${placeholders})
           GROUP BY local_task_id, eff_status, is_warning`
        )
        .all(...localIds);
      for (const r of cntRows) {
        if (!countMap[r.local_task_id]) {
          countMap[r.local_task_id] = { imported: 0, failed: 0, pending: 0, skipped: 0, warning: 0 };
        }
        const bucket = countMap[r.local_task_id];
        // eff_status='imported' 且 is_warning=1 → 警告桶(从 imported 中拆出)
        if (r.eff_status === 'imported' && r.is_warning === 1) bucket.warning += r.n;
        else if (r.eff_status === 'imported') bucket.imported = r.n;
        else if (r.eff_status === 'failed') bucket.failed = r.n;
        else if (r.eff_status === 'skipped') bucket.skipped = r.n;
        else bucket.pending = r.n;
      }
    }

    const total = db
      .prepare(`SELECT COUNT(*) as n FROM follow_sell_tasks f ${whereSql}`)
      .get(...params).n;

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
          imageRefreshTaskId: r.image_refresh_task_id || null,
          imageRefreshStatus: r.image_refresh_status || null,
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
          hasError: !!r.has_error,
          hasWarning: !!r.has_warning,
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

// ── 采集箱 v2 属性字典/类目名/字典值查询(把数字 ID 翻译成可读名称)──
// 注意:collect_box_v2 表已废弃,采集箱前端只用缓存视图(/from-cache);
//       这三个属性字典接口保留供预览页等场景使用。

// GET /admin/api/collect-box-v2/attribute-dictionary
// query: ?storeId=&categoryId=&typeId=
// 返回该类目+类型下所有属性描述:[{id, name, description, type, is_required, dictionary_id, ...}]
router.get('/admin/api/collect-box-v2/attribute-dictionary', async (req, res, next) => {
  try {
    const storeId = String(req.query.storeId || '');
    const categoryId = Number(req.query.categoryId) || 0;
    const typeId = Number(req.query.typeId) || 0;
    if (!storeId || !categoryId || !typeId) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeId/categoryId/typeId 必填'));
    }
    const store = readStores().find((s) => s.id === storeId);
    if (!store) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '店铺不存在: ' + storeId));
    const attrs = await opi.descriptionCategoryAttributes(store, {
      description_category_id: categoryId,
      type_id: typeId,
    });
    res.json(ok(attrs));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/collect-box-v2/category-names
// query: ?storeId=&typeId=
// 返回 {descriptionCategoryId, categoryName, typeName} —— 按 typeId 在类目树中 DFS 查找,
// 返回该 type 所属的 description_category_id(父节点) + 类目名 + 类型名
router.get('/admin/api/collect-box-v2/category-names', async (req, res, next) => {
  try {
    const storeId = String(req.query.storeId || '');
    const typeId = Number(req.query.typeId) || 0;
    if (!storeId || !typeId) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeId/typeId 必填'));
    }
    const store = readStores().find((s) => s.id === storeId);
    if (!store) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '店铺不存在: ' + storeId));
    const tree = await opi.descriptionCategoryTree(store);
    // DFS:在类目树中找 type_id === typeId 的节点(叶子层),取其 type_name,
    // 并从父节点取 description_category_id + category_name
    let descriptionCategoryId = 0;
    let categoryName = '';
    let typeName = '';
    function dfs(node, parent) {
      if (Number(node.type_id) === typeId) {
        typeName = node.type_name || '';
        if (parent) {
          descriptionCategoryId = Number(parent.description_category_id) || 0;
          categoryName = parent.category_name || '';
        }
        return true;
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          if (dfs(child, node)) return true;
        }
      }
      return false;
    }
    for (const root of tree) {
      if (dfs(root, null)) break;
    }
    res.json(ok({ descriptionCategoryId, categoryName, typeName }));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/collect-box-v2/attribute-values
// query: ?storeId=&categoryId=&typeId=&attributeId=
// 返回字典属性的可选值:[{id, value, info, picture}]
router.get('/admin/api/collect-box-v2/attribute-values', async (req, res, next) => {
  try {
    const storeId = String(req.query.storeId || '');
    const categoryId = Number(req.query.categoryId) || 0;
    const typeId = Number(req.query.typeId) || 0;
    const attributeId = Number(req.query.attributeId) || 0;
    if (!storeId || !categoryId || !typeId || !attributeId) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'storeId/categoryId/typeId/attributeId 必填'));
    }
    const store = readStores().find((s) => s.id === storeId);
    if (!store) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '店铺不存在: ' + storeId));
    const values = await opi.descriptionCategoryAttributeValues(store, {
      attribute_id: attributeId,
      description_category_id: categoryId,
      type_id: typeId,
    });
    res.json(ok(values));
  } catch (e) {
    next(e);
  }
});

// ── 商品列表(查 product_data_cache,跨店铺) ───────────────

// 简化商品状态:基于 OPI /v3/product/info/list 的 4 维原始字段计算 5 类用户可理解的状态
// 输入:product_data_cache.data 解析后的对象
// 优先级:pending_creation > rejected > saleable/created_no_stock > other
//   - pending_creation(待创建):is_created=false
//     (商品尚未创建,无论审核状态如何,与 Ozon 后台"未创建(Не создан)"显示一致)
//   - saleable(出售中):is_created=true AND has_stock=true (98.7% 商品)
//   - created_no_stock(准备出售):is_created=true AND has_stock=false
//   - rejected(审核拒绝):is_created=true AND (moderate_status=declined OR validation_status=fail OR status=unmatched)
//   - other(其它):is_created=true 且非拒绝/非 saleable/非 created_no_stock
//     (含原 in_review 审核中、unknown 数据异常,2026-07 合并以简化前端展示)
// 2026-07:is_created=0 优先于 rejected 判定
//   Ozon 后台对 is_created=0 的商品统一显示"未创建",无论 moderate_status 是否 declined
//   原 declined 优先逻辑会把"未创建+审核被拒"误判为 rejected,与后台显示不一致
function computeProductStatus(data) {
  const st = data?.statuses || {};
  const mod = st.moderate_status ?? '';
  const val = st.validation_status ?? '';
  const status = st.status ?? '';
  const isCreated = st.is_created === true || st.is_created === 1;
  const hasStock = data?.stocks?.has_stock === true || data?.stocks?.has_stock === 1;

  // is_created=0 优先:统一判为待创建,与 Ozon 后台"未创建"显示一致
  // 覆盖未创建+审核被拒/未创建+校验未通过/未创建+审核中等所有情况
  if (!isCreated) return 'pending_creation';
  // 以下均针对 is_created=true 的商品
  if (mod === 'declined' || val === 'fail' || status === 'unmatched') return 'rejected';
  if (isCreated && hasStock) return 'saleable';
  if (isCreated && !hasStock) return 'created_no_stock';
  // 其余情况(原 in_review 审核中 / unknown 数据异常)统一合并为 other
  return 'other';
}

// OPI errors[].code → 中文映射表(2026-07)
// 用于商品列表状态列下方的错误提示展示
// 未命中的 code 原样透传,不阻塞展示
const ERROR_CODE_CN_MAP = {
  // 校验类(待创建)
  error_attribute_values_empty: '必填属性为空',
  error_attribute_value_invalid: '属性值无效',
  error_attribute_value_too_long: '属性值过长',
  error_attribute_value_too_short: '属性值过短',
  error_attribute_unknown: '未知属性',
  error_attribute_required: '缺少必填属性',
  BR_ASSORTMENT: '禁止 assortment 销售',
  BR_NOT_IN_ASSORTMENT: '不在 assortment 中',
  // 审核类(待创建/审核拒绝)
  DESCRIPTION_DECLINE: '描述/图片审核被拒',
  IMAGE_DECLINE: '图片审核被拒',
  NAME_DECLINE: '名称审核被拒',
  // 图片加载类(各状态均可能)
  primary_image_load_failed: '主图加载失败',
  pics_http_error: '图片 HTTP 错误',
  some_image_failed: '部分图片失败',
  all_image_failed: '全部图片失败',
  warning_all_image_failed: '全部图片失败(警告)',
  // 其他常见
  PRODUCT_IS_NOT_CREATED: '商品未创建',
  PRODUCT_NOT_FOUND: '商品不存在',
  forbidden: '无权限',
  not_found: '未找到',
  bad_request: '请求参数错误',
  internal_error: '服务器内部错误',
};

// 抽取并简化 errors[] 为前端友好的结构
// 输入:product_data_cache.data 解析后的对象
// 输出:{ count, items }
//   items: [{ code, codeCn, attributeName, description, level }]
//   去重:相同 code+attribute_id 的错误只保留一条(如 BR_ASSORTMENT 出现 3 次)
function extractStatusErrors(data) {
  const errs = Array.isArray(data?.errors) ? data.errors : [];
  if (errs.length === 0) return { count: 0, items: [] };
  const seen = new Set();
  const items = [];
  for (const e of errs) {
    const code = String(e?.code || '');
    const attrId = e?.attribute_id ?? '';
    // 去重 key:code + attribute_id(同一属性同一错误码视为重复)
    const key = `${code}#${attrId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const texts = e?.texts || {};
    items.push({
      code,
      codeCn: ERROR_CODE_CN_MAP[code] || code,
      attributeName: texts.attribute_name || '',
      description: texts.description || texts.message || '',
      level: e?.level === 'ERROR_LEVEL_WARNING' ? 'warning' : 'error',
    });
  }
  return { count: items.length, items };
}

// GET /admin/api/products —— 商品数据缓存列表(支持 keyword 模糊搜 sku / data)
// query: ?currentPage=1&pageSize=20&keyword=&idsOnly=1
//   idsOnly=1 时跳过分页,返回全量精简列表(仅 productId/storeId/offerId),供"按筛选批量更新"使用
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
    // hasStock 筛选:基于 data.stocks.has_stock(布尔)
    //   hasStock=1 -> 有库存(有变体可下单)
    //   hasStock=0 -> 无库存(price_sent 准备出售但缺货,或下架)
    // SQLite json_extract 把 true/false 解析为 1/0,用 COALESCE 兜底空值
    if (req.query.hasStock === '1' || req.query.hasStock === '0') {
      const v = Number(req.query.hasStock);
      where.push("COALESCE(json_extract(data, '$.stocks.has_stock'), 0) = ?");
      params.push(v);
    }
    // 状态筛选:OPI /v3/product/info/list 的状态嵌套在 statuses.status 字段
    if (req.query.status) {
      where.push("json_extract(data, '$.statuses.status') = ?");
      params.push(String(req.query.status));
    }
    // 简化状态筛选(2026-07):基于 is_created + moderate + validation + has_stock 计算 5 类
    //   saleable / created_no_stock / pending_creation / rejected / other
    // 优先级:pending_creation > rejected > saleable/created_no_stock > other
    // (is_created=0 优先,与 Ozon 后台"未创建"显示一致;rejected 仅针对已创建被拒的商品)
    // 2026-07:合并 in_review/unknown → other(方案 B 彻底合并)
    // 注意:productStatus 筛选单独维护,不 push 到 where 数组
    //   where 数组仅含基础筛选(keyword/storeId/hasStock/status/imageIssue),
    //   用于 statusCounts 查询(口径 A:统计各状态数量时排除 productStatus 筛选)
    let productStatusWhere = '';
    if (req.query.productStatus) {
      const ps = String(req.query.productStatus);
      // SQL CASE 表达式:与后端 computeProductStatus 保持一致
      productStatusWhere =
        ` AND (CASE
            WHEN json_extract(data, '$.statuses.is_created') = 0
              THEN 'pending_creation'
            WHEN COALESCE(json_extract(data, '$.statuses.moderate_status'), '') = 'declined'
                 OR json_extract(data, '$.statuses.validation_status') = 'fail'
                 OR json_extract(data, '$.statuses.status') = 'unmatched'
              THEN 'rejected'
            WHEN json_extract(data, '$.statuses.is_created') = 1
                 AND COALESCE(json_extract(data, '$.stocks.has_stock'), 0) = 1
              THEN 'saleable'
            WHEN json_extract(data, '$.statuses.is_created') = 1
                 AND COALESCE(json_extract(data, '$.stocks.has_stock'), 0) = 0
              THEN 'created_no_stock'
            ELSE 'other'
           END) = ?`;
      params.push(ps);
    }
    // 图片问题筛选:基于 data.errors 数组中的图片错误码
    //   OPI 返回的 errors[].code 命中以下任一即视为图片有问题
    if (req.query.imageIssue === '1' || req.query.imageIssue === 'true') {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(data, '$.errors')
                 WHERE json_each.value->>'$.code' IN
                   ('primary_image_load_failed','pics_http_error',
                    'some_image_failed','all_image_failed','warning_all_image_failed'))`
      );
    }
    const baseWhereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    // 拼接 productStatus 筛选(列表/total/idsOnly 查询用)
    // productStatusWhere 以 ' AND ' 开头,baseWhereSql 为空时需补 'WHERE 1=1'
    const fullWhereSql = baseWhereSql
      ? baseWhereSql + productStatusWhere
      : (productStatusWhere ? 'WHERE 1=1' + productStatusWhere : '');

    // idsOnly 模式:跳过分页,只返回 productId/storeId/offerId 精简列表
    // 用于"按当前筛选批量更新图片/库存"场景,避免拉取完整 data JSON
    if (req.query.idsOnly === '1' || req.query.idsOnly === 'true') {
      const idRows = db
        .prepare(
          `SELECT
             COALESCE(json_extract(data, '$.product_id'), json_extract(data, '$.id')) AS productId,
             store_id AS storeId,
             COALESCE(json_extract(data, '$.offer_id'), json_extract(data, '$.sku'), sku) AS offerId
           FROM product_data_cache ${fullWhereSql}
           ORDER BY fetched_at DESC`
        )
        .all(...params);
      const items = idRows
        .filter((r) => r.productId)
        .map((r) => ({ productId: String(r.productId), storeId: r.storeId || '', offerId: r.offerId || '' }));
      return res.json(ok({ items, total: items.length }));
    }

    const rows = db
      .prepare(
        `SELECT sku, data, store_id, fetched_at FROM product_data_cache ${fullWhereSql} ORDER BY fetched_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, offset);
    const total = db.prepare(`SELECT COUNT(*) as n FROM product_data_cache ${fullWhereSql}`).get(...params).n;

    // statusCounts:各状态数量统计(口径 A:排除 productStatus 筛选,保留其他基础筛选)
    // 用 baseWhereSql(不含 productStatus),一条 GROUP BY SQL 查询全部 5 类状态计数
    // 前端 Tab 展示"全部(N) 出售中(N) 准备出售(N) 待创建(N) 审核拒绝(N) 其它(N)"
    const countRows = db
      .prepare(
        `SELECT (CASE
            WHEN json_extract(data, '$.statuses.is_created') = 0
              THEN 'pending_creation'
            WHEN COALESCE(json_extract(data, '$.statuses.moderate_status'), '') = 'declined'
                 OR json_extract(data, '$.statuses.validation_status') = 'fail'
                 OR json_extract(data, '$.statuses.status') = 'unmatched'
              THEN 'rejected'
            WHEN json_extract(data, '$.statuses.is_created') = 1
                 AND COALESCE(json_extract(data, '$.stocks.has_stock'), 0) = 1
              THEN 'saleable'
            WHEN json_extract(data, '$.statuses.is_created') = 1
                 AND COALESCE(json_extract(data, '$.stocks.has_stock'), 0) = 0
              THEN 'created_no_stock'
            ELSE 'other'
           END) AS ps, COUNT(*) AS n
         FROM product_data_cache ${baseWhereSql}
         GROUP BY ps`
      )
      .all(...params.slice(0, params.length - (req.query.productStatus ? 1 : 0)));
    // statusCounts params:baseWhereSql 对应基础筛选参数
    // params 末尾可能是 productStatus 的 ps(如果有 productStatus 筛选),需排除
    const statusCounts = { saleable: 0, created_no_stock: 0, pending_creation: 0, rejected: 0, other: 0 };
    for (const r of countRows) {
      if (statusCounts[r.ps] !== undefined) statusCounts[r.ps] = r.n;
    }
    // 「全部」= 各状态数量之和(基础筛选下的总数,不含 productStatus 筛选)
    statusCounts.all =
      statusCounts.saleable + statusCounts.created_no_stock + statusCounts.pending_creation +
      statusCounts.rejected + statusCounts.other;

    res.json(
      ok({
        items: rows.map((r) => {
          const data = safeParseJson(r.data) || {};
          return {
            sku: r.sku,
            storeId: r.store_id || '',
            fetchedAt: r.fetched_at,
            // 简化商品状态(2026-07):6 类用户可理解状态,前端展示与筛选主用此字段
            // 原始 statuses.* 仍保留在 _raw 中供详情页查看
            productStatus: computeProductStatus(data),
            // 状态错误信息(2026-07):抽取 errors[] 并翻译为中文,前端状态列下方展示
            //   statusErrorCount: 去重后的错误条数(0 表示无错误)
            //   statusErrors: [{ code, codeCn, attributeName, description, level }]
            statusErrors: extractStatusErrors(data),
            // 提取常用展示字段(容错:不同 OPI 版本字段名可能不同)
            name: data.name || data.title || '',
            productId: data.product_id || data.id || '',
            offerId: data.offer_id || data.sku || r.sku,
            price: data.price || data.marketing_price || '',
            currency: data.currency || data.marketing_currency || '',
            image: data.primary_image || data.image || (Array.isArray(data.images) ? data.images[0] : '') || '',
            // 库存:OPI /v3/product/info/list 的 stocks.has_stock(布尔)
            //   true=有库存可售;false=无库存(price_sent 准备出售但缺货)
            hasStock: data.stocks?.has_stock === true,
            // 库存数量:汇总 stocks.stocks[].present(FBS/FBO 各仓库可用库存之和)
            stockPresent: Array.isArray(data.stocks?.stocks)
              ? data.stocks.stocks.reduce((sum, s) => sum + (Number(s?.present) || 0), 0)
              : 0,
            // 图片状态:OPI errors[] 中出现任一图片错误码即视为有问题
            //   primary_image_load_failed / pics_http_error / some_image_failed / all_image_failed
            //   (简化判断:不区分 WARNING/ERROR 级别,出现即标红)
            hasImageError: Array.isArray(data.errors)
              ? data.errors.some(
                (e) =>
                  e.code === 'primary_image_load_failed' ||
                  e.code === 'pics_http_error' ||
                  e.code === 'some_image_failed' ||
                  e.code === 'all_image_failed' ||
                  e.code === 'warning_all_image_failed'
              )
              : false,
            _raw: data,
          };
        }),
        total,
        current,
        pageSize,
        // 各状态数量(口径 A:排除 productStatus 筛选,前端 Tab 展示数量用)
        // { all, saleable, created_no_stock, pending_creation, rejected, other }
        statusCounts,
      })
    );
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/products/sync —— 从 Ozon 拉取店铺全部商品并写入 product_data_cache
// query: ?storeId=xxx(必填,OPI 凭据所属店铺)
// 全量替换语义:同步完成后删除该店铺本次未刷新的旧记录(Ozon 端已不存在的商品)
// 同步过程中若异常,已写入的新数据保留,旧数据不删除(失败安全)
// 响应: { synced, total, removed, durationMs }
// 进度:执行过程实时更新 syncProgressMap,前端可通过 GET /sync-progress 轮询

// 内存进度状态(进程级,重启丢失):storeId → 进度对象
// 同步进行中实时更新;完成后保留 60s 供前端最后查询,之后自动清理
const syncProgressMap = new Map();
const PROGRESS_RETAIN_MS = 60_000; // 完成后保留时长

function setProgress(storeId, patch) {
  const now = Date.now();
  const cur = syncProgressMap.get(storeId) || { storeId, startedAt: now };
  const next = { ...cur, ...patch, elapsedMs: now - (cur.startedAt || now) };
  syncProgressMap.set(storeId, next);
}

function finalizeProgress(storeId, status, extra = {}) {
  const cur = syncProgressMap.get(storeId) || { storeId, startedAt: Date.now() };
  const now = Date.now();
  syncProgressMap.set(storeId, {
    ...cur,
    ...extra,
    status,
    elapsedMs: now - (cur.startedAt || now),
    finishedAt: now,
  });
  // 60s 后清理,避免内存泄漏
  setTimeout(() => syncProgressMap.delete(storeId), PROGRESS_RETAIN_MS);
}

// GET /admin/api/products/sync-progress —— 查询所有店铺的同步进度
// 返回 { items: [{ storeId, storeName, status, phase, page, total, synced, failedBatches, elapsedMs, message }] }
router.get('/admin/api/products/sync-progress', (req, res, next) => {
  try {
    const stores = readStores();
    const nameMap = new Map(stores.map((s) => [s.id, s.name || s.id]));
    const items = Array.from(syncProgressMap.values()).map((p) => ({
      ...p,
      storeName: nameMap.get(p.storeId) || p.storeId,
    }));
    res.json(ok({ items }));
  } catch (e) {
    next(e);
  }
});

router.post('/admin/api/products/sync', async (req, res) => {
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
  setProgress(storeId, { status: 'running', phase: 'init', page: 0, total: 0, synced: 0, failedBatches: 0, startedAt, message: '初始化' });
  try {
    // 同步起点时间戳:本次同步所有写入记录的 fetched_at 都会 >= 此值
    // 用 datetime('now') 而非 JS Date,确保与 SQLite 服务器时钟一致
    const syncStartedAt = db.prepare(`SELECT datetime('now') as t`).get().t;
    let lastId = '';
    let total = 0;
    let synced = 0;
    const limit = 1000;
    // 耗时拆分(用于定位同步瓶颈:list/info/db/delete)
    let listMs = 0, infoMs = 0, dbMs = 0, pages = 0;
    let failedBatches = 0; // info 接口批次失败数(504 等),记录后跳过不中断同步

    // 循环拉取商品列表(游标分页),批量拉详情后写入 product_data_cache
    while (true) {
      setProgress(storeId, { phase: 'list', page: pages, total, synced, failedBatches, message: `拉取列表第 ${pages + 1} 页` });
      const __tl = Date.now();
      const listResp = await opi.productList(store, { lastId, limit });
      listMs += Date.now() - __tl;
      const items = listResp?.result?.items || listResp?.items || [];
      total = listResp?.result?.total || listResp?.total || total;
      if (items.length === 0) break;
      pages++;

      const productIds = items.map((it) => it.product_id).filter(Boolean);
      if (productIds.length > 0) {
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO product_data_cache (sku, data, store_id, fetched_at) VALUES (?, ?, ?, datetime('now'))`
        );
        // 分批拉详情:OPI /v3/product/info/list
        // 2026-07:改回 1000/批(单批越多总请求数越少,大店铺更快)
        const INFO_BATCH_SIZE = 1000;
        const totalBatches = Math.ceil(productIds.length / INFO_BATCH_SIZE);
        for (let i = 0; i < productIds.length; i += INFO_BATCH_SIZE) {
          const batch = productIds.slice(i, i + INFO_BATCH_SIZE);
          const batchNo = Math.floor(i / INFO_BATCH_SIZE) + 1;
          setProgress(storeId, {
            phase: 'info',
            page: pages,
            total,
            synced,
            failedBatches,
            message: `拉取详情 第${pages}页 批次${batchNo}/${totalBatches} (${synced}/${total})`,
          });
          const __ti = Date.now();
          let infoResp;
          try {
            infoResp = await opi.productInfoListV3(store, { productIds: batch });
          } catch (e) {
            // 记录详情供分析(504 网关超时 / 其他 HTTP 错误 / 网络异常)
            // 不中断整店同步,跳过本批继续下一批(部分数据缺失比整店失败好)
            const httpStatus = e?.details?.httpStatus;
            logger.warn(
              {
                storeId,
                page: pages,
                batchNo,
                batchStart: i,
                batchEnd: i + batch.length,
                batchSize: batch.length,
                productIds: batch,
                httpStatus: httpStatus ?? null,
                errCode: e?.code ?? null,
                errMessage: e?.message ?? String(e),
              },
              '[sync] productInfoListV3 批次失败,跳过'
            );
            failedBatches++;
            setProgress(storeId, { failedBatches });
            continue;
          }
          infoMs += Date.now() - __ti;
          const infoItems = infoResp?.result?.items || infoResp?.items || [];
          const __td = Date.now();
          for (const item of infoItems) {
            const sku = String(item.sku || item.id || '');
            if (!sku) continue;
            stmt.run(sku, JSON.stringify(item), storeId);
            synced++;
          }
          dbMs += Date.now() - __td;
          setProgress(storeId, { synced });
        }
      }

      lastId = listResp?.result?.last_id || listResp?.last_id || '';
      if (items.length < limit) break; // 最后一页
    }

    // 全量替换:删除该店铺本次同步未刷新的旧记录(Ozon 端已不存在的商品)
    // 同步成功到达此处才执行删除,中途异常不删旧数据(失败安全)
    setProgress(storeId, { phase: 'delete', message: `清理旧记录` });
    const __tdel = Date.now();
    const removed = db
      .prepare(`DELETE FROM product_data_cache WHERE store_id = ? AND fetched_at < ?`)
      .run(storeId, syncStartedAt).changes;
    const delMs = Date.now() - __tdel;

    const durationMs = Date.now() - startedAt;
    logger.info(
      { storeId, total, synced, removed, pages, failedBatches, listMs, infoMs, dbMs, delMs, totalMs: durationMs },
      '[sync-profile] 同步耗时拆分'
    );
    finalizeProgress(storeId, 'done', { phase: 'done', page: pages, total, synced, removed, failedBatches, durationMs, message: `完成:写入${synced}/${total},清理${removed}` });
    res.json(ok({ synced, total, removed, failedBatches, durationMs }));
  } catch (err) {
    finalizeProgress(storeId, 'error', { phase: 'error', message: err.message });
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

    // 采集箱缓存数(collect_box_v2 与旧 ozon_card_cache 表均已废弃,改查 ozon_cache_index.card_hit=1,对齐 misc.js#status-counts)
    const collectPending = db.prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index WHERE card_hit = 1`).get().n;

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

// ── 类目元数据缓存管理(2026-07) ──────────────────────────
// 类目树/属性/字典值的 L2(SQLite)持久化缓存,跨店铺共享,永久有效
// 仅通过本路由手动清空,下次访问自动从 OPI 重新拉取并落库

// POST /admin/api/meta/refresh
// body: { type: 'tree'|'attrs'|'values', language?: 'ZH_HANS', categoryId?, typeId?, attributeId? }
//   - type=tree:必传 language,清空整棵树(按 language)
//   - type=attrs:可选 categoryId+typeId,传了删单条,不传删该 language 全部
//   - type=values:可选 categoryId+typeId+attributeId,逐级精确删除
// 仅清空 L2 + L1,不在此调 OPI(下次访问触发拉取)
router.post('/admin/api/meta/refresh', (req, res, next) => {
  try {
    const type = String(req.body?.type || '');
    const language = String(req.body?.language || 'ZH_HANS');
    const categoryId = req.body?.categoryId != null ? Number(req.body.categoryId) : null;
    const typeId = req.body?.typeId != null ? Number(req.body.typeId) : null;
    const attributeId = req.body?.attributeId != null ? Number(req.body.attributeId) : null;

    if (!['tree', 'attrs', 'values'].includes(type)) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'type 必须为 tree|attrs|values'));
    }

    if (type === 'tree') {
      metaDao.deleteCategoryTree(language);
    } else if (type === 'attrs') {
      metaDao.deleteCategoryAttributes(language, categoryId, typeId);
    } else {
      metaDao.deleteAttributeValues(language, categoryId, typeId, attributeId);
    }

    opi.invalidateMetaCache(); // 清 L1 内存

    logger.info({ type, language, categoryId, typeId, attributeId }, 'meta cache refreshed');
    res.json(ok({ cleared: true }));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/meta/status —— 查看缓存状态(行数 + 最近 fetched_at)
router.get('/admin/api/meta/status', (req, res, next) => {
  try {
    const tree = db
      .prepare('SELECT COUNT(*) as n, MAX(fetched_at) as last FROM ozon_meta_category_tree')
      .get();
    const attrs = db
      .prepare('SELECT COUNT(*) as n, MAX(fetched_at) as last FROM ozon_meta_category_attributes')
      .get();
    const values = db
      .prepare('SELECT COUNT(*) as n, MAX(fetched_at) as last FROM ozon_meta_attribute_values')
      .get();
    res.json(
      ok({
        tree: { rows: tree.n, lastFetchedAt: tree.last },
        attrs: { rows: attrs.n, lastFetchedAt: attrs.last },
        values: { rows: values.n, lastFetchedAt: values.last },
      })
    );
  } catch (e) {
    next(e);
  }
});

export default router;
