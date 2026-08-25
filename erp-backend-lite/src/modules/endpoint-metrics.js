// Ozon 端点访问耗时监控(2026-08)
// qxqx 三脚本对 8 个 Ozon 内部端点的 fetch 耗时埋点收集 + 查询
// 设计文档:docs/ozon端点耗时监控-概要设计.md
//
// 路由:
//   POST /admin/api/endpoint-metrics/batch   脚本批量上报(单批 ≤200 条)
//   GET  /admin/api/endpoint-metrics/query   时间轴聚合查询(p50/p95/avg/错误率)
//   GET  /admin/api/endpoint-metrics/dims    各维度可用值(供筛选下拉)
//
// 保留期清理:startEndpointMetricsRetention()(app.js 启动时挂载,每日一次)
import { Router } from 'express';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';

const router = Router();

// 端点枚举白名单(与 schema.sql 注释、前端展示一致)
const ENDPOINT_CODES = new Set([
  'www.entrypoint.product',
  'www.composer.product',
  'www.composer.offers-modal',
  'seller.analytics.v3',
  'seller.search',
  'seller.create-bundle',
  'www.entrypoint.seller-list',
  'www.entrypoint.shop-info',
]);
const SCRIPT_CODES = new Set(['deep', 'shallow', 'backfill']);
const BATCH_LIMIT = 200;

// ── 单条 metric 白名单校验 + 归一 ─────────────────────────────
function normalizeMetric(raw, idx) {
  if (!raw || typeof raw !== 'object') return { err: `items[${idx}] 非对象` };
  const endpoint = String(raw.endpoint || '').trim();
  if (!ENDPOINT_CODES.has(endpoint)) return { err: `items[${idx}].endpoint 非法: ${endpoint}` };
  const script = String(raw.script || '').trim();
  if (!SCRIPT_CODES.has(script)) return { err: `items[${idx}].script 非法: ${script}` };
  const ts = String(raw.ts || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(ts)) return { err: `items[${idx}].ts 非法: ${ts}` };
  const durationMs = Math.max(0, Math.min(600000, Number(raw.durationMs) | 0)); // 0-10min 截断
  if (!Number.isFinite(Number(raw.durationMs))) return { err: `items[${idx}].durationMs 非法` };
  const statusCode = Number.isFinite(Number(raw.statusCode)) ? Number(raw.statusCode) | 0 : null;
  const okFlag = raw.ok === false || raw.ok === 0 ? 0 : 1;
  return {
    val: {
      endpoint,
      domain: endpoint.startsWith('seller.') ? 'seller' : 'www',
      method: String(raw.method || 'GET').slice(0, 8),
      script,
      ts,
      sku: raw.sku ? String(raw.sku).slice(0, 32) : null,
      sellerId: raw.sellerId ? String(raw.sellerId).slice(0, 64) : null,
      statusCode,
      durationMs,
      ok: okFlag,
      errorKind: raw.errorKind ? String(raw.errorKind).slice(0, 40) : null,
      machineId: String(raw.machineId || 'unknown').slice(0, 64),
      clientIp: raw.clientIp ? String(raw.clientIp).slice(0, 64) : null,
      profileId: raw.profileId ? String(raw.profileId).slice(0, 64) : null,
    },
  };
}

// POST /admin/api/endpoint-metrics/batch
// body: { items: [{endpoint, script, ts, durationMs, statusCode?, ok?, errorKind?,
//                  sku?, sellerId?, method?, machineId, clientIp?, profileId?}] }
// 单条校验失败仅跳过该条(不整批拒绝,监控数据尽力而为)
router.post('/admin/api/endpoint-metrics/batch', (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, BATCH_LIMIT) : [];
    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items 不能为空' });
    }
    const stmt = db.prepare(
      `INSERT INTO ozon_endpoint_metrics
        (ts, endpoint, domain, method, script, sku, seller_id, status_code,
         duration_ms, ok, error_kind, machine_id, client_ip, profile_id)
       VALUES (@ts, @endpoint, @domain, @method, @script, @sku, @sellerId, @statusCode,
               @durationMs, @ok, @errorKind, @machineId, @clientIp, @profileId)`
    );
    const rows = [];
    let skipped = 0;
    for (let i = 0; i < items.length; i++) {
      const { err, val } = normalizeMetric(items[i], i);
      if (err) {
        skipped++;
        continue;
      }
      rows.push(val);
    }
    if (rows.length > 0) {
      // node:sqlite 无 db.transaction()(better-sqlite3 API),显式事务替代
      db.exec('BEGIN');
      try {
        for (const r of rows) stmt.run(r);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    return res.json(ok({ inserted: rows.length, skipped }));
  } catch (e) {
    logger.warn({ err: e.message }, '[endpoint-metrics] batch failed');
    next(e);
  }
});

// ── query:时间范围 + 维度筛选解析 ───────────────────────────
function parseQueryFilters(req) {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const spanErr =
    !from || !to ? 'from/to 必填' : null;
  const list = (v) =>
    String(v || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    from,
    to,
    spanErr,
    endpoints: list(req.query.endpoints),
    machines: list(req.query.machines),
    profiles: list(req.query.profiles),
    ips: list(req.query.ips),
    scripts: list(req.query.scripts),
    bucket: ['1m', '5m', '1h'].includes(req.query.bucket) ? req.query.bucket : '5m',
  };
}

function buildWhere(f) {
  // 注意:占位符必须全部用 ?(位置参数),node:sqlite 不允许命名/位置混用
  const where = ["ts >= ?", "ts <= ?"];
  if (f.endpoints.length) where.push(`endpoint IN (${f.endpoints.map(() => '?').join(',')})`);
  if (f.machines.length) where.push(`machine_id IN (${f.machines.map(() => '?').join(',')})`);
  if (f.profiles.length) where.push(`profile_id IN (${f.profiles.map(() => '?').join(',')})`);
  if (f.ips.length) where.push(`client_ip IN (${f.ips.map(() => '?').join(',')})`);
  if (f.scripts.length) where.push(`script IN (${f.scripts.map(() => '?').join(',')})`);
  const flat = [f.from, f.to, ...f.endpoints, ...f.machines, ...f.profiles, ...f.ips, ...f.scripts];
  return { whereSql: where.join(' AND '), params: flat };
}

// GET /admin/api/endpoint-metrics/query
// 返回 { series: [{endpoint, bucketTs, count, p50, p95, avg, errCount}], stats: [...] }
// 分位数在 Node 侧计算(拉原始 duration 分桶,7 天窗口内单端点数据量可控)
router.get('/admin/api/endpoint-metrics/query', (req, res, next) => {
  try {
    const f = parseQueryFilters(req);
    if (f.spanErr) {
      return res.status(400).json({ ok: false, error: f.spanErr });
    }
    const { whereSql, params } = buildWhere(f);
    const rows = db
      .prepare(
        `SELECT endpoint, ts, duration_ms, ok FROM ozon_endpoint_metrics
         WHERE ${whereSql}
         ORDER BY ts ASC
         LIMIT 200000`
      )
      .all(...params);

    // 桶大小(秒)
    const bucketSec = f.bucket === '1m' ? 60 : f.bucket === '1h' ? 3600 : 300;
    // 按 endpoint+bucket 聚合
    const buckets = new Map(); // `${endpoint}|${bucketTs}` -> { endpoint, bucketTs, durs: [], errs: 0 }
    for (const r of rows) {
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t)) continue;
      const bTs = Math.floor(t / 1000 / bucketSec) * bucketSec * 1000;
      const key = `${r.endpoint}|${bTs}`;
      let b = buckets.get(key);
      if (!b) {
        b = { endpoint: r.endpoint, bucketTs: new Date(bTs).toISOString(), durs: [], errs: 0 };
        buckets.set(key, b);
      }
      b.durs.push(r.duration_ms);
      if (!r.ok) b.errs++;
    }
    const quantile = (sorted, q) => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
      return sorted[idx];
    };
    const series = [...buckets.values()]
      .map((b) => {
        const sorted = [...b.durs].sort((a, c) => a - c);
        const sum = b.durs.reduce((s, v) => s + v, 0);
        return {
          endpoint: b.endpoint,
          bucketTs: b.bucketTs,
          count: b.durs.length,
          p50: quantile(sorted, 0.5),
          p95: quantile(sorted, 0.95),
          avg: Math.round(sum / b.durs.length),
          errCount: b.errs,
        };
      })
      .sort((a, b) => (a.bucketTs < b.bucketTs ? -1 : a.bucketTs > b.bucketTs ? 1 : a.endpoint.localeCompare(b.endpoint)));

    // 全窗口分端点统计
    const byEndpoint = new Map();
    for (const r of rows) {
      let s = byEndpoint.get(r.endpoint);
      if (!s) {
        s = { endpoint: r.endpoint, durs: [], errs: 0 };
        byEndpoint.set(r.endpoint, s);
      }
      s.durs.push(r.duration_ms);
      if (!r.ok) s.errs++;
    }
    const stats = [...byEndpoint.values()]
      .map((s) => {
        const sorted = [...s.durs].sort((a, c) => a - c);
        const sum = s.durs.reduce((x, v) => x + v, 0);
        return {
          endpoint: s.endpoint,
          total: s.durs.length,
          p50: quantile(sorted, 0.5),
          p95: quantile(sorted, 0.95),
          avg: Math.round(sum / s.durs.length),
          errRate: s.durs.length ? Math.round((s.errs / s.durs.length) * 1000) / 1000 : 0,
        };
      })
      .sort((a, b) => b.total - a.total);

    return res.json(ok({ series, stats, bucket: f.bucket, count: rows.length }));
  } catch (e) {
    logger.warn({ err: e.message }, '[endpoint-metrics] query failed');
    next(e);
  }
});

// GET /admin/api/endpoint-metrics/dims
// 返回各维度可用值(近 N 天去重,供筛选下拉)
router.get('/admin/api/endpoint-metrics/dims', (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(30, Number(req.query.days) || 7));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const q = (col) =>
      db
        .prepare(
          `SELECT DISTINCT ${col} AS v FROM ozon_endpoint_metrics
           WHERE ts >= ? AND ${col} IS NOT NULL ORDER BY v LIMIT 200`
        )
        .all(since)
        .map((r) => r.v);
    return res.json(
      ok({
        endpoints: db.prepare(`SELECT DISTINCT endpoint AS v FROM ozon_endpoint_metrics ORDER BY v LIMIT 100`).all().map((r) => r.v),
        machines: q('machine_id'),
        profiles: q('profile_id'),
        ips: q('client_ip'),
        scripts: q('script'),
      })
    );
  } catch (e) {
    logger.warn({ err: e.message }, '[endpoint-metrics] dims failed');
    next(e);
  }
});

// ── 保留期清理(每日一次) ────────────────────────────────────
let retentionTimer = null;

export function startEndpointMetricsRetention() {
  if (retentionTimer) return;
  const run = () => {
    try {
      const days = Math.max(1, Number(process.env.METRICS_RETENTION_DAYS) || 30);
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const r = db.prepare(`DELETE FROM ozon_endpoint_metrics WHERE ts < ?`).run(cutoff);
      if (r.changes > 0) {
        logger.info({ deleted: r.changes, cutoff }, '[endpoint-metrics] 保留期清理完成');
      }
    } catch (e) {
      logger.warn({ err: e.message }, '[endpoint-metrics] 保留期清理失败');
    }
  };
  // 启动 10 分钟后首次执行(错开启动高峰),此后每日一次
  retentionTimer = setTimeout(() => {
    run();
    retentionTimer = setInterval(run, 24 * 60 * 60 * 1000);
    retentionTimer.unref?.();
  }, 10 * 60 * 1000);
  retentionTimer.unref?.();
}

export function stopEndpointMetricsRetention() {
  if (retentionTimer) {
    clearTimeout(retentionTimer);
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}

export default router;
