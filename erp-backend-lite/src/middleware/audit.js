// 审计日志中间件(P2-3)
// 在关键写操作(POST/PUT/DELETE)成功后自动写入 audit_logs 表
// 记录点:店铺增删改、上架提交、采集箱增删改、配置变更、批量上架创建/删除
import { db } from '../db/index.js';
import logger from './log.js';

const stmtInsert = db.prepare(
  `INSERT INTO audit_logs (action, target, store_id, operator, detail, ip) VALUES (?, ?, ?, ?, ?, ?)`
);

// 路径 → action 映射(仅记录写操作);返回 { action, targetFromPath? }
function resolveAction(method, path) {
  // 店铺
  if (path === '/admin/api/stores' && method === 'POST') return { action: 'store.create' };
  let m = /^\/admin\/api\/stores\/([^/]+)$/.exec(path);
  if (m && method === 'PUT') return { action: 'store.update', target: m[1] };
  if (m && method === 'DELETE') return { action: 'store.delete', target: m[1] };
  // 上架提交
  if (path === '/ozon/products/import' && method === 'POST') return { action: 'listing.import' };
  if (path === '/ozon/products/import-report' && method === 'POST') return { action: 'listing.importReport' };
  // 采集箱
  if (path === '/ozon/collect-box' && method === 'POST') return { action: 'collect.create' };
  if (path === '/ozon/collect-box/batch' && method === 'POST') return { action: 'collect.batchCreate' };
  m = /^\/admin\/api\/collect-box\/([^/]+)$/.exec(path);
  if (m && method === 'DELETE') return { action: 'collect.delete', target: m[1] };
  if (m && method === 'PATCH') return { action: 'collect.update', target: m[1] };
  // 配置变更
  if (path === '/app-config' && method === 'PUT') return { action: 'config.update' };
  if (path === '/watermark-templates' && method === 'POST') return { action: 'watermark.create' };
  m = /^\/watermark-templates\/([^/]+)$/.exec(path);
  if (m && (method === 'PUT' || method === 'DELETE')) return { action: 'watermark.update', target: m[1] };
  // 批量上架
  if (path === '/ozon/products/batch-import' && method === 'POST') return { action: 'batch.create' };
  m = /^\/ozon\/products\/batch-import\/([^/]+)$/.exec(path);
  if (m && method === 'DELETE') return { action: 'batch.delete', target: m[1] };
  m = /^\/ozon\/products\/batch-import\/([^/]+)\/retry$/.exec(path);
  if (m && method === 'POST') return { action: 'batch.retry', target: m[1] };
  return null;
}

function safePick(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  return obj[key] != null ? String(obj[key]) : null;
}

// express 中间件:在 res.end 后记录(仅成功响应 2xx)
export function auditLog(req, res, next) {
  const writeLog = () => {
    // 避免重复写入(一次请求只记录一次)
    if (res._auditLogged) return;
    res._auditLogged = true;

    const matched = resolveAction(req.method, req.path);
    if (!matched) return;
    if (res.statusCode >= 400) return; // 仅记录成功操作

    try {
      const target = matched.target || safePick(req.body, 'id') || safePick(req.body, 'localTaskId') || null;
      const storeId = safePick(req.body, 'storeId') || safePick(req.body, 'store_id') || null;
      const operator = req.user?.phone || 'system';
      const detail = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body).slice(0, 2000) : null;
      const ip = req.ip || req.socket?.remoteAddress || null;
      stmtInsert.run(matched.action, target, storeId, operator, detail, ip);
    } catch (e) {
      logger.warn({ err: e?.message }, '[audit] 写入审计日志失败');
    }
  };

  // 在响应结束时记录
  res.on('finish', writeLog);
  next();
}

export default auditLog;
