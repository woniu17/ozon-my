// 管理后台路由:店铺 CRUD + 仓库实时拉取 + OPI 凭据连通性测试
// 所有 /admin/api/* 走 JWT 鉴权(由全局 authMiddleware 拦截)
import { Router } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'store';
}

// 校验并规范化店铺对象
function normalizeStore(input) {
  const body = input || {};
  const name = String(body.name || '').trim();
  if (!name) throw new ApiError(ErrorCode.VALIDATION_ERROR, '店铺名称 name 必填');

  const creds = body.sync_credentials || {};
  const clientId = String(creds.clientId || '').trim();
  const apiKey = String(creds.apiKey || '').trim();

  return {
    name,
    company_id: String(body.company_id || '').trim(),
    warehouse_id: String(body.warehouse_id || '').trim(),
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
    const result = await testOpiCredentials(
      store.sync_credentials?.clientId,
      store.sync_credentials?.apiKey
    );
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
    const result = await testOpiCredentials(
      store.sync_credentials?.clientId,
      store.sync_credentials?.apiKey
    );
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

export default router;
