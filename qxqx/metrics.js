// Ozon 端点访问耗时监控 — 公共模块(2026-08)
// 三脚本(deep/shallow/backfill)共用:缓冲 + 定时上报 + 出口 IP 探测
// 设计文档:docs/ozon端点耗时监控-概要设计.md
//
// 铁律:监控链路任何失败不得影响采集主流程(静默丢弃 + console.warn 计数)
//
// 用法:
//   import { initMetrics, addMetric, finalizeMetrics } from './metrics.js';
//   initMetrics({ script: 'deep', erpBaseUrl, erpApiKey, profileDir });
//   addMetric({ endpoint: 'seller.search', sku, durationMs: 812, statusCode: 200, ok: true });
//   // 退出前:await finalizeMetrics();
//
// 上报通道:独立轻量 fetch(不复用脚本 erpFetch,避免监控数据触发 ERP 熔断/恢复等待)
import { hostname } from 'node:os';
import path from 'node:path';

const FLUSH_SIZE = 5;        // 满 5 条触发上报
const FLUSH_INTERVAL_MS = 30_000; // 定时上报
const IP_PROBE_INTERVAL_MS = 30 * 60_000; // 出口 IP 刷新
const BATCH_LIMIT = 200;     // 与后端 batch 接口单批上限一致

let state = null; // { script, erpBaseUrl, erpApiKey, machineId, profileId, buf, timer, ipTimer, clientIp, dropped, flushBusy }

// ── 出口 IP 探测(env IP_PROBE_URL 可切;失败保留上次值) ──────
async function probeIpOnce(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(baseUrl, { signal: controller.signal });
    if (!resp.ok) return null;
    const text = (await resp.text()).trim();
    // 期望纯 IP(v4/v6);部分服务返回 JSON,取其中的 ip 字段
    if (/^[\d.:a-fA-F]+$/.test(text) && text.length <= 45) return text;
    try {
      const j = JSON.parse(text);
      const ip = String(j?.ip || '').trim();
      if (/^[\d.:a-fA-F]+$/.test(ip)) return ip;
    } catch { /* 非 JSON 忽略 */ }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function startIpProbe(baseUrl) {
  const run = async () => {
    const ip = await probeIpOnce(baseUrl);
    if (ip) state.clientIp = ip;
    // 失败静默:保留上次值;从未成功则 clientIp 保持 null(上报后端存 NULL)
  };
  run();
  state.ipTimer = setInterval(run, IP_PROBE_INTERVAL_MS);
  state.ipTimer.unref?.();
}

// ── 上报(失败静默丢弃) ─────────────────────────────────────
async function flushOnce() {
  if (!state || state.flushBusy || state.buf.length === 0) return;
  state.flushBusy = true;
  const items = state.buf.splice(0, BATCH_LIMIT).map((m) => ({
    ...m,
    clientIp: state.clientIp,
    machineId: state.machineId,
    profileId: state.profileId,
    script: state.script,
  }));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const resp = await fetch(`${state.erpBaseUrl}/admin/api/endpoint-metrics/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': state.erpApiKey },
        body: JSON.stringify({ items }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        state.dropped += items.length;
        console.warn(`[metrics] 上报 HTTP ${resp.status},丢弃 ${items.length} 条(累计 ${state.dropped})`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    state.dropped += items.length;
    // 网络失败静默(ERP 不可达时不刷屏:仅在每 100 条丢一次汇总)
    if (state.dropped % 100 < items.length) {
      console.warn(`[metrics] 上报失败,累计丢弃 ${state.dropped} 条`);
    }
  } finally {
    state.flushBusy = false;
    // 缓冲仍有积压(单批超限)时立即继续
    if (state.buf.length >= BATCH_LIMIT) flushOnce();
  }
}

// ── 对外 API ─────────────────────────────────────────────────

/** 初始化(幂等;erpApiKey 为空则整体禁用,addMetric 变 no-op) */
export function initMetrics({ script, erpBaseUrl, erpApiKey, profileDir, profileId }) {
  if (state) return;
  state = {
    script,
    erpBaseUrl: String(erpBaseUrl || '').replace(/\/$/, ''),
    erpApiKey: erpApiKey || '',
    machineId: process.env.MACHINE_ID || hostname(),
    profileId: profileId || path.basename(String(profileDir || '')) || null,
    buf: [],
    timer: null,
    ipTimer: null,
    clientIp: null,
    dropped: 0,
    flushBusy: false,
  };
  if (!state.erpBaseUrl || !state.erpApiKey) {
    console.warn('[metrics] ERP_BASE_URL/ERP_API_KEY 未配置,端点耗时监控禁用(采集不受影响)');
    state = { ...state, disabled: true };
    return;
  }
  const probeUrl = process.env.IP_PROBE_URL || 'https://api.ip.sb/ip';
  startIpProbe(probeUrl);
  state.timer = setInterval(() => flushOnce(), FLUSH_INTERVAL_MS);
  state.timer.unref?.();
}

/**
 * 记录一次端点访问。durationMs 为必填;ts 不传默认当前时间
 * (浏览器侧埋点应传注入函数返回的 startedAt,更精确)
 */
export function addMetric(m) {
  if (!state || state.disabled) return;
  if (!m || !m.endpoint || !Number.isFinite(Number(m.durationMs))) return;
  state.buf.push({
    endpoint: m.endpoint,
    method: m.method || 'GET',
    ts: m.ts || new Date().toISOString(),
    durationMs: Math.max(0, Math.round(Number(m.durationMs))),
    statusCode: Number.isFinite(Number(m.statusCode)) ? Number(m.statusCode) : null,
    ok: m.ok === false ? 0 : 1,
    errorKind: m.errorKind || null,
    sku: m.sku || null,
    sellerId: m.sellerId || null,
  });
  if (state.buf.length >= FLUSH_SIZE) flushOnce();
}

/** 退出前 flush(尽力而为,2s 内完成;脚本 finalize 时调用) */
export async function finalizeMetrics() {
  if (!state || state.disabled) return;
  if (state.timer) clearInterval(state.timer);
  if (state.ipTimer) clearInterval(state.ipTimer);
  await flushOnce();
}
