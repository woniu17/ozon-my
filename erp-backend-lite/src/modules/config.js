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

export default router;
