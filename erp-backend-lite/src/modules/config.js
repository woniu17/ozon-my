// 配置中心 + 水印模板路由
// - app_config 表存放 key-value 配置(替代插件端硬编码默认值)
// - watermark_templates 表存放水印模板配置(插件 content script 用 Canvas 渲染)
//
// 所有 /app-config 与 /watermark-templates 路由走 JWT 鉴权(全局 authMiddleware)
// 注意:配置查询接口允许未登录访问是不安全的,这里依赖全局中间件
import { Router } from 'express';
import { db } from '../db/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { ok } from '../utils/response.js';

const router = Router();

// ── 内部工具 ────────────────────────────────────────────────
function parseJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function rowToConfig(r) {
  if (!r) return null;
  return {
    key: r.key,
    value: parseJson(r.value),
    scope: r.scope,
    description: r.description,
    updatedAt: r.updated_at,
  };
}

// ── 应用配置 ────────────────────────────────────────────────

// GET /app-config —— 获取配置
// query: ?scope=extension|pricing|watermark  (可选,不传则返回全部)
// 返回:扁平数组 { items: [{key, value, scope, description, updatedAt}] }
// 或扁平对象 { data: { key1: value1, key2: value2 } }(便于插件直接消费)
router.get('/app-config', (req, res, next) => {
  try {
    const scope = req.query.scope;
    const rows = scope
      ? db.prepare(`SELECT * FROM app_config WHERE scope=? ORDER BY key`).all(String(scope))
      : db.prepare(`SELECT * FROM app_config ORDER BY key`).all();

    // 返回扁平对象(key → value),插件读取更直观
    const data = {};
    for (const r of rows) {
      data[r.key] = parseJson(r.value);
    }
    res.json(ok({ data, items: rows.map(rowToConfig) }));
  } catch (e) {
    next(e);
  }
});

// PUT /app-config —— 批量更新配置
// body: { items: [{ key, value, scope?, description? }] }  或  { key, value, scope?, description? }(单条)
router.put('/app-config', (req, res, next) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : body.key ? [body] : [];
    if (items.length === 0) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'items 或 (key, value) 必填'));
    }

    const stmt = db.prepare(`
      INSERT INTO app_config (key, value, scope, description, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        scope = excluded.scope,
        description = COALESCE(excluded.description, app_config.description),
        updated_at = datetime('now')
    `);

    db.exec('BEGIN');
    try {
      for (const it of items) {
        const key = String(it.key || '').trim();
        if (!key) {
          throw new ApiError(ErrorCode.VALIDATION_ERROR, '配置项 key 不能为空');
        }
        const value = JSON.stringify(it.value);
        // scope 不传时保留原值:先查再决定,简化为默认 extension
        const scope = String(it.scope || 'extension').trim();
        const description = it.description != null ? String(it.description) : null;
        stmt.run(key, value, scope, description);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    res.json(ok({ updated: items.length }));
  } catch (e) {
    next(e);
  }
});

// ── 水印模板 ────────────────────────────────────────────────

// GET /watermark-templates —— 水印模板列表
router.get('/watermark-templates', (req, res, next) => {
  try {
    const rows = db.prepare(`SELECT * FROM watermark_templates ORDER BY is_default DESC, id ASC`).all();
    res.json(
      ok(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          config: parseJson(r.config),
          isDefault: !!r.is_default,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }))
      )
    );
  } catch (e) {
    next(e);
  }
});

// POST /watermark-templates —— 新建水印模板
router.post('/watermark-templates', (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'name 必填'));
    const config = body.config || {};
    const isDefault = body.isDefault ? 1 : 0;

    // 若设为默认,先取消其他默认
    if (isDefault) {
      db.prepare(`UPDATE watermark_templates SET is_default=0`).run();
    }

    const info = db
      .prepare(`INSERT INTO watermark_templates (name, config, is_default) VALUES (?, ?, ?)`)
      .run(name, JSON.stringify(config), isDefault);

    res.json(
      ok({
        id: info.lastInsertRowid,
        name,
        config,
        isDefault: !!isDefault,
      })
    );
  } catch (e) {
    next(e);
  }
});

// PUT /watermark-templates/:id —— 更新水印模板
router.put('/watermark-templates/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'id 无效'));
    const row = db.prepare(`SELECT * FROM watermark_templates WHERE id=?`).get(id);
    if (!row) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '水印模板不存在: ' + id));

    const body = req.body || {};
    const name = body.name != null ? String(body.name).trim() : row.name;
    if (!name) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'name 不能为空'));
    const config = body.config != null ? JSON.stringify(body.config) : row.config;

    // 切换默认:若本次设为默认,取消其他默认
    if (body.isDefault && !row.is_default) {
      db.prepare(`UPDATE watermark_templates SET is_default=0`).run();
    }
    const isDefault = body.isDefault != null ? (body.isDefault ? 1 : 0) : row.is_default;

    db.prepare(
      `UPDATE watermark_templates SET name=?, config=?, is_default=?, updated_at=datetime('now') WHERE id=?`
    ).run(name, config, isDefault, id);

    res.json(
      ok({
        id,
        name,
        config: JSON.parse(config),
        isDefault: !!isDefault,
      })
    );
  } catch (e) {
    next(e);
  }
});

// DELETE /watermark-templates/:id —— 删除水印模板
router.delete('/watermark-templates/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'id 无效'));
    const info = db.prepare(`DELETE FROM watermark_templates WHERE id=?`).run(id);
    if (info.changes === 0) {
      return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '水印模板不存在: ' + id));
    }
    res.json(ok({ deleted: true, id }));
  } catch (e) {
    next(e);
  }
});

// ── 上架模板(listing_templates)── 跟卖面板人工输入值的预设方案 ──

// GET /admin/api/listing-templates —— 列表
router.get('/admin/api/listing-templates', (req, res, next) => {
  try {
    const rows = db
      .prepare(
        `SELECT id, name, config_json, is_builtin, is_default, created_at, updated_at
         FROM listing_templates ORDER BY is_builtin DESC, is_default DESC, updated_at DESC`
      )
      .all();
    res.json(
      ok(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          config: JSON.parse(r.config_json),
          isBuiltin: !!r.is_builtin,
          isDefault: !!r.is_default,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }))
      )
    );
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/listing-templates/:id —— 详情
router.get('/admin/api/listing-templates/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'id 无效'));
    const r = db
      .prepare(
        `SELECT id, name, config_json, is_builtin, is_default, created_at, updated_at
         FROM listing_templates WHERE id=?`
      )
      .get(id);
    if (!r) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '模板不存在: ' + id));
    res.json(
      ok({
        id: r.id,
        name: r.name,
        config: JSON.parse(r.config_json),
        isBuiltin: !!r.is_builtin,
        isDefault: !!r.is_default,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })
    );
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/listing-templates —— 创建
router.post('/admin/api/listing-templates', (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const config = req.body?.config || {};
    if (!name) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'name 必填'));
    const configJson = JSON.stringify(config);
    const isDefault = req.body?.isDefault ? 1 : 0;
    // 设为默认:先取消其他默认
    if (isDefault) {
      db.prepare(`UPDATE listing_templates SET is_default=0`).run();
    }
    const info = db
      .prepare(`INSERT INTO listing_templates (name, config_json, is_default) VALUES (?, ?, ?)`)
      .run(name, configJson, isDefault);
    res.json(ok({ id: info.lastInsertRowid, name, config, isBuiltin: false, isDefault: !!isDefault }));
  } catch (e) {
    next(e);
  }
});

// PUT /admin/api/listing-templates/:id —— 更新
// 内置模板:禁止改 name/config,但允许切换 is_default(否则被取消默认后无法恢复)
router.put('/admin/api/listing-templates/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'id 无效'));
    const existing = db.prepare(`SELECT is_builtin FROM listing_templates WHERE id=?`).get(id);
    if (!existing) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '模板不存在: ' + id));
    const isBuiltin = !!existing.is_builtin;
    const name = String(req.body?.name || '').trim();
    const config = req.body?.config;
    const setDefault = req.body?.isDefault;
    // 内置模板:仅允许切换默认,不允许改 name/config
    if (isBuiltin && (name || config != null)) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, '内置模板不可编辑(仅可切换默认)'));
    }
    // 非内置模板:更新 name/config
    if (!isBuiltin && config != null) {
      if (name) {
        db.prepare(`UPDATE listing_templates SET name=?, config_json=?, updated_at=datetime('now') WHERE id=?`).run(
          name,
          JSON.stringify(config),
          id
        );
      } else {
        db.prepare(`UPDATE listing_templates SET config_json=?, updated_at=datetime('now') WHERE id=?`).run(
          JSON.stringify(config),
          id
        );
      }
    }
    // 切换默认:取消其他默认,再设当前(所有模板均可)
    if (setDefault) {
      db.prepare(`UPDATE listing_templates SET is_default=0 WHERE id != ?`).run(id);
      db.prepare(`UPDATE listing_templates SET is_default=1 WHERE id=?`).run(id);
    }
    res.json(ok({ updated: true, id }));
  } catch (e) {
    next(e);
  }
});

// DELETE /admin/api/listing-templates/:id —— 删除(内置模板不可删)
router.delete('/admin/api/listing-templates/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'id 无效'));
    const existing = db.prepare(`SELECT is_builtin FROM listing_templates WHERE id=?`).get(id);
    if (!existing) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '模板不存在: ' + id));
    if (existing.is_builtin) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, '内置模板不可删除'));
    }
    db.prepare(`DELETE FROM listing_templates WHERE id=?`).run(id);
    res.json(ok({ deleted: true, id }));
  } catch (e) {
    next(e);
  }
});

// ── 预览接口:把 items 转换为 OPI v3 schema(不实际发送到 Ozon) ──
import { resolveAttrWhitelist, buildOpiItem } from '../services/opi-item-builder.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORES_FILE = join(__dirname, '../config/stores.json');
function readStoresForPreview() {
  try {
    return JSON.parse(readFileSync(STORES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// POST /admin/api/preview-opi —— 预览 OPI v3 请求体
// body: { items: [...], storeId? } (storeId 可选,传入则按类目字典过滤查不到含义的属性)
// 返回: { items: [opiItem, ...] } (OPI v3 schema,不发送)
router.post('/admin/api/preview-opi', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.json(ok({ items: [], message: '无 items' }));
    }
    // 字典白名单:按 (descriptionCategoryId, typeId) 预查,同类目只查一次
    // storeId 未传或查询失败时 allowedAttrIds=null,降级为不过滤
    // 统一走 opi-item-builder.resolveAttrWhitelist + buildOpiItem
    const storeId = String(req.body?.storeId || '');
    const store = storeId ? readStoresForPreview().find((s) => s.id === storeId) : null;
    const opiItems = [];
    for (const it of items) {
      const { allowedAttrIds } = await resolveAttrWhitelist(store, it, { enableWhitelist: true });
      opiItems.push(buildOpiItem(it, { allowedAttrIds }).opiItem);
    }
    res.json(ok({ items: opiItems }));
  } catch (e) {
    next(e);
  }
});

export default router;
