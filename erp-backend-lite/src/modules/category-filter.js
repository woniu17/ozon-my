// 类目过滤黑名单管理(2026-07 新增)
// 维护 ozon_filtered_categories 表,采集箱 + 上架预览共用此配置
//
// 路由:
//   GET    /admin/api/filtered-categories                        列出全部过滤类目
//   GET    /admin/api/filtered-categories/available              从已采集商品中提取可用类目列表(供管理页"从已采集商品中选"用)
//   GET    /admin/api/filtered-categories/check/:descCatId/:typeId   检查某类目是否在黑名单
//   GET    /admin/api/filtered-categories/check-by-sku/:sku      按 SKU 查询其类目是否在黑名单
//   POST   /admin/api/filtered-categories/category-names-batch   批量按 descriptionCategoryId 查询中文类目名
//   POST   /admin/api/filtered-categories                        添加过滤类目
//   DELETE /admin/api/filtered-categories/:descCatId/:typeId     移出过滤类目
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';
import * as opi from '../services/ozon-opi.js';

const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORES_FILE = join(__dirname, '../config/stores.json');

function readStores() {
  try {
    return JSON.parse(readFileSync(STORES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// 中文类目名映射缓存(进程内):
//   categoryNameMap: descriptionCategoryId -> categoryName(中文)
//   typeNameMap: typeId -> typeName(中文,来自类目树叶子节点 type_id/type_name)
// OPI 类目树有 5 分钟内存缓存(ozon-opi.js 内),这里再做一层结果缓存避免重复 DFS
let _categoryNamesCache = null; // { storeId, categoryNameMap, typeNameMap, expiresAt }
const CATEGORY_NAMES_CACHE_TTL = 5 * 60 * 1000;

// 取第一个 store 的类目树,DFS 构建 descriptionCategoryId -> categoryName + typeId -> typeName 映射
// OPI 类目树叶子节点(倒数第二层 children)含 type_id + type_name,即"商品类型"
// 失败时返回空 Map(不阻断主流程,前端会回退显示 ID)
async function getCategoryNameMaps() {
  const hit = _categoryNamesCache;
  if (hit && hit.expiresAt > Date.now()) {
    return { categoryNameMap: hit.categoryNameMap, typeNameMap: hit.typeNameMap };
  }

  const stores = readStores();
  const store = stores[0];
  if (!store) return { categoryNameMap: new Map(), typeNameMap: new Map() };

  try {
    const tree = await opi.descriptionCategoryTree(store, 'ZH_HANS');
    const categoryNameMap = new Map();
    const typeNameMap = new Map();
    function dfs(node) {
      if (!node) return;
      // 类目层节点:description_category_id + category_name
      const catId = Number(node.description_category_id);
      if (catId && node.category_name) {
        categoryNameMap.set(catId, node.category_name);
      }
      // 类型层节点(叶子):type_id + type_name
      const typeId = Number(node.type_id);
      if (typeId && node.type_name) {
        typeNameMap.set(typeId, node.type_name);
      }
      if (Array.isArray(node.children)) {
        for (const c of node.children) dfs(c);
      }
    }
    if (Array.isArray(tree)) {
      for (const root of tree) dfs(root);
    }
    _categoryNamesCache = {
      storeId: store.id,
      categoryNameMap,
      typeNameMap,
      expiresAt: Date.now() + CATEGORY_NAMES_CACHE_TTL,
    };
    return { categoryNameMap, typeNameMap };
  } catch (e) {
    logger.warn({ err: e.message }, '[category-filter] getCategoryNameMaps failed');
    return { categoryNameMap: new Map(), typeNameMap: new Map() };
  }
}

// GET /admin/api/filtered-categories
// 返回 { items: [{ descriptionCategoryId, typeId, categoryName, typeName, createdAt }] }
router.get('/admin/api/filtered-categories', (req, res, next) => {
  try {
    const rows = db
      .prepare(
        `SELECT description_category_id, type_id, category_name, type_name, created_at
         FROM ozon_filtered_categories
         ORDER BY created_at DESC`
      )
      .all();
    const items = rows.map((r) => ({
      descriptionCategoryId: r.description_category_id,
      typeId: r.type_id,
      categoryName: r.category_name || '',
      typeName: r.type_name || '',
      createdAt: r.created_at,
    }));
    return res.json(ok({ items }));
  } catch (e) {
    logger.warn({ err: e.message }, '[category-filter] list failed');
    next(e);
  }
});

// GET /admin/api/filtered-categories/available
// 从已采集商品中提取所有不同的类目组合(供管理页"从已采集商品中选"用)
// 注:当前数据 type_id 大部分为 NULL(bundle_data 不含此字段),允许 NULL 进列表
// 返回 { items: [{ descriptionCategoryId, typeId, categoryName, typeName, skuCount }] }
router.get('/admin/api/filtered-categories/available', (req, res, next) => {
  try {
    const rows = db
      .prepare(
        `SELECT description_category_id,
                COALESCE(type_id, 0) AS type_id,
                MAX(category_name) AS category_name,
                COUNT(*) AS sku_count
         FROM ozon_cache_index
         WHERE description_category_id IS NOT NULL
         GROUP BY description_category_id, type_id
         ORDER BY sku_count DESC`
      )
      .all();
    const items = rows.map((r) => ({
      descriptionCategoryId: r.description_category_id,
      typeId: r.type_id || 0,
      categoryName: r.category_name || '',
      typeName: '',
      skuCount: r.sku_count,
    }));
    return res.json(ok({ items }));
  } catch (e) {
    logger.warn({ err: e.message }, '[category-filter] available failed');
    next(e);
  }
});

// GET /admin/api/filtered-categories/check/:descCatId/:typeId
// 检查某类目是否在黑名单。返回 { filtered: boolean }
// 注:typeId 可为 0(数据缺失时的占位值),与 NULL 等价
router.get('/admin/api/filtered-categories/check/:descCatId/:typeId', (req, res, next) => {
  try {
    const descCatId = Number(req.params.descCatId);
    const typeId = Number(req.params.typeId) || 0;
    if (!Number.isFinite(descCatId) || descCatId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid descCatId' });
    }
    const row = db
      .prepare(
        `SELECT 1 FROM ozon_filtered_categories
         WHERE description_category_id = ? AND type_id = ?`
      )
      .get(descCatId, typeId);
    return res.json(ok({ filtered: !!row }));
  } catch (e) {
    logger.warn({ err: e.message }, '[category-filter] check failed');
    next(e);
  }
});

// GET /admin/api/filtered-categories/check-by-sku/:sku
// 按 SKU 查询其类目是否在黑名单。
// 内部用 SKU 查 ozon_cache_index 取 description_category_id + type_id(与采集箱同源),
// 避免与 portalItem 的 OPI 合成路径(优先 search_data level_3)数据源不一致导致过滤失效。
// 返回 { filtered: boolean, descriptionCategoryId, typeId, categoryName }
router.get('/admin/api/filtered-categories/check-by-sku/:sku', (req, res, next) => {
  try {
    const sku = String(req.params.sku || '').trim();
    if (!sku) {
      return res.status(400).json({ ok: false, error: 'invalid sku' });
    }
    const ci = db
      .prepare(
        `SELECT description_category_id, COALESCE(type_id, 0) AS type_id, category_name
         FROM ozon_cache_index WHERE sku = ?`
      )
      .get(sku);
    if (!ci || !ci.description_category_id) {
      return res.json(
        ok({ filtered: false, descriptionCategoryId: null, typeId: 0, categoryName: '' })
      );
    }
    const descCatId = Number(ci.description_category_id);
    const typeId = Number(ci.type_id) || 0;
    const row = db
      .prepare(
        `SELECT 1 FROM ozon_filtered_categories
         WHERE description_category_id = ? AND type_id = ?`
      )
      .get(descCatId, typeId);
    return res.json(
      ok({
        filtered: !!row,
        descriptionCategoryId: descCatId,
        typeId,
        categoryName: ci.category_name || '',
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[category-filter] check-by-sku failed');
    next(e);
  }
});

// POST /admin/api/filtered-categories/category-names-batch
// 批量按 descriptionCategoryId / typeId 查询中文类目名 + 类型名(供采集箱/类目过滤管理页显示中文用)
// body: { descCatIds: [1,2,3,...], typeIds?: [1,2,3,...] }
// 返回: { items: [{ descriptionCategoryId, categoryName }], typeItems: [{ typeId, typeName }] }
// 注:OPI 失败时 categoryName/typeName 为空字符串,前端回退显示 ID
router.post('/admin/api/filtered-categories/category-names-batch', async (req, res, next) => {
  try {
    const descCatIds = Array.isArray(req.body?.descCatIds) ? req.body.descCatIds : [];
    const typeIds = Array.isArray(req.body?.typeIds) ? req.body.typeIds : [];
    const uniqDescCatIds = [
      ...new Set(descCatIds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)),
    ];
    const uniqTypeIds = [
      ...new Set(typeIds.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)),
    ];
    if (uniqDescCatIds.length === 0 && uniqTypeIds.length === 0) {
      return res.json(ok({ items: [], typeItems: [] }));
    }
    const { categoryNameMap, typeNameMap } = await getCategoryNameMaps();
    const items = uniqDescCatIds.map((id) => ({
      descriptionCategoryId: id,
      categoryName: categoryNameMap.get(id) || '',
    }));
    const typeItems = uniqTypeIds.map((id) => ({
      typeId: id,
      typeName: typeNameMap.get(id) || '',
    }));
    return res.json(ok({ items, typeItems }));
  } catch (e) {
    logger.warn({ err: e.message }, '[category-filter] category-names-batch failed');
    next(e);
  }
});

// POST /admin/api/filtered-categories
// body: { descriptionCategoryId, typeId?, categoryName?, typeName? }
// 添加过滤类目(已存在则忽略,返回最新记录)
// 注:typeId 可省略/为 0(数据缺失时占位),此时按 descCatId 单维度过滤
router.post('/admin/api/filtered-categories', (req, res, next) => {
  try {
    const descriptionCategoryId = Number(req.body?.descriptionCategoryId);
    const typeIdRaw = Number(req.body?.typeId);
    const typeId = Number.isFinite(typeIdRaw) && typeIdRaw > 0 ? typeIdRaw : 0;
    const categoryName = String(req.body?.categoryName || '').slice(0, 500);
    const typeName = String(req.body?.typeName || '').slice(0, 500);
    if (!Number.isFinite(descriptionCategoryId) || descriptionCategoryId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid descriptionCategoryId' });
    }
    db.prepare(
      `INSERT INTO ozon_filtered_categories
         (description_category_id, type_id, category_name, type_name, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(description_category_id, type_id) DO UPDATE SET
         category_name = excluded.category_name,
         type_name = excluded.type_name`
    ).run(descriptionCategoryId, typeId, categoryName || null, typeName || null);
    return res.json(
      ok({
        descriptionCategoryId,
        typeId,
        categoryName,
        typeName,
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[category-filter] add failed');
    next(e);
  }
});

// DELETE /admin/api/filtered-categories/:descCatId/:typeId
// 移出过滤类目
router.delete('/admin/api/filtered-categories/:descCatId/:typeId', (req, res, next) => {
  try {
    const descCatId = Number(req.params.descCatId);
    const typeId = Number(req.params.typeId) || 0;
    if (!Number.isFinite(descCatId) || descCatId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid descCatId' });
    }
    const r = db
      .prepare(
        `DELETE FROM ozon_filtered_categories
         WHERE description_category_id = ? AND type_id = ?`
      )
      .run(descCatId, typeId);
    return res.json(ok({ deleted: r.changes > 0, changes: r.changes }));
  } catch (e) {
    logger.warn({ err: e.message }, '[category-filter] delete failed');
    next(e);
  }
});

export default router;
