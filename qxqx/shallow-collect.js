// 无头 cloakbrowser 浅度采集脚本
// 用 launchPersistentContext 启动 stealth 浏览器,导航到店铺页,
// 在店铺页上下文里逐页 fetch entrypoint-api(API 直取,复用 qx-ozon 插件浅采语义),
// 4 道过滤后写浅度日志(POST /admin/api/shallow-collect/log,source='headless-api')。
//
// 2026-08 起改走 ERP API(对齐 deep-collect.js),不再直连 SQLite:
//   - 店铺列表:GET /admin/api/store-classification(分页拉全量+过滤+排序)
//   - 浅度日志:POST /admin/api/shallow-collect/log(逐条,小并发批次)
//   - dom card 缓存:POST /ozon/cache/dom/:sku(ERP domDao.upsertCard 自动触发 indexDao.syncSku
//     → 本脚本的 syncSkuLite 索引聚合已整体移除)
//   - 深度队列入队:POST /admin/api/collect-queue(skipIfTodaySuccess:false,对齐原
//     "全部入队不做 24h 成功去重"语义)
//   - 鉴权:x-api-key 头(与后端 SERVICE_API_KEY 同值,见 .env.example)
//
// 与 backfill-store-stats.js 的差异:
//   - backfill:每店一次 fetch 取 stats(订单数/评论数/评分/开业时长)
//   - 本脚本:每店翻页拉取全部 SKU(价格/评论过滤 + 浅度日志)
//   - backfill 熔断即终止;本脚本熔断后等待 CIRCUIT_BREAKER_WAIT_MS 再断点续采
//
// 用法: node shallow-collect.js
// 可选环境变量(见 .env,命令行/env 优先于 .env):
// Linux/macOS(bash):
//   STORE_LIMIT=1 DRY_RUN=1 node shallow-collect.js   # 单店干跑
//   STORE_LIMIT=1 LOG_SKU=1 node shallow-collect.js   # 单店落库 + SKU 逐条日志
//   STORE_LIMIT=10 node shallow-collect.js            # 小批量
//   node shallow-collect.js                           # 全量
// Windows(PowerShell;注意 $env: 会话内持久,全量前先清残留):
//   $env:STORE_LIMIT='1'; $env:DRY_RUN='1'; node shallow-collect.js   # 单店干跑
//   $env:STORE_LIMIT='1'; $env:LOG_SKU='1'; node shallow-collect.js   # 单店落库 + SKU 逐条日志
//   $env:STORE_LIMIT='10'; node shallow-collect.js                    # 小批量
//   Remove-Item Env:STORE_LIMIT,Env:DRY_RUN,Env:LOG_SKU -ErrorAction SilentlyContinue
//   node shallow-collect.js                                           # 全量
// 登录态迁移(跨 Windows/Linux)见 state-transfer.js:
//   node state-transfer.js --export / --import
//
// 设计要点(2026-08 详细设计 v2):
//   - 翻页循环在 Node 侧,每页一次 page.evaluate(200-500ms),
//     进度实时可见、Ctrl+C 可中断、崩溃最多丢 1 页
//   - 熔断恢复:等待 → warmup → 重新导航店铺页 → 从 state.nextPagePath 断点续采
//     (seenSkus 保留,不重复写、不误判空页)
//   - 错误分类:404 = 永久错误直接跳过;403/429/5xx/网络错误 = 临时错误走熔断
//   - DRY_RUN=1 完全只读(不写日志、不写 progress)
//   - ERP 写入失败:请求级重试(2s×1)+连续失败熔断(ERP_FAIL_MAX 后暂停探测 /health 恢复续采)

import { launchPersistentContext } from 'cloakbrowser';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initMetrics, addMetric, finalizeMetrics } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 加载(不覆盖已有 process.env,命令行优先) ────────────
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    // 去除成对引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

// 环境变量 → 数值(空/非法 → null 表示不限)
function numOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── 日志时间戳(console.log/warn/error 统一加 [YYYY-MM-DD HH:mm:ss] 前缀) ──
const fmtTs = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
// 当前时间 + 等待 ms 的预计时刻(用于"下一次执行时间"提示)
const fmtNext = (waitMs) => fmtTs(new Date(Date.now() + waitMs));
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(`[${fmtTs()}]`, ...args);
}

// ── 配置 ─────────────────────────────────────────────────────
const cfg = {
  // ERP 连接与鉴权(与后端 SERVICE_API_KEY 同值)
  erpBaseUrl: (process.env.ERP_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, ''),
  erpApiKey: process.env.ERP_API_KEY || '',
  erpTimeoutMs: Number(process.env.ERP_TIMEOUT_MS) || 15000,
  erpFailMax: Number(process.env.ERP_FAIL_MAX) || 5,

  profileDir: path.join(__dirname, '.ozon-profile'),
  progressFile: path.join(__dirname, 'shallow-collect-progress.json'),
  lockFile: path.join(__dirname, '.shallow-collect.lock'),

  // 店铺过滤
  storeSellerIds: (process.env.STORE_SELLER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  storeOnlyMainlandChina: process.env.STORE_ONLY_MAINLAND_CHINA !== '0',
  storeLimit: Number(process.env.STORE_LIMIT) || 0, // 0=不限制
  storeSort: process.env.STORE_SORT || 'lastSeenAt',
  revisitDays: Number(process.env.REVISIT_DAYS) || 0, // 0=done 永久有效

  // 店铺数值过滤(范围,空=不限;数据来自 backfill 回填的统计列)
  storeOrdersMin: numOrNull(process.env.STORE_ORDERS_MIN),
  storeOrdersMax: numOrNull(process.env.STORE_ORDERS_MAX),
  storeReviewsMin: numOrNull(process.env.STORE_REVIEWS_MIN),
  storeReviewsMax: numOrNull(process.env.STORE_REVIEWS_MAX),
  storeRatingMin: numOrNull(process.env.STORE_RATING_MIN),
  storeRatingMax: numOrNull(process.env.STORE_RATING_MAX),
  storeOpenedMonthsMin: numOrNull(process.env.STORE_OPENED_MONTHS_MIN),
  storeOpenedMonthsMax: numOrNull(process.env.STORE_OPENED_MONTHS_MAX),

  // SKU 过滤(4 道过滤,对齐插件浅采)
  skuOnlyWithRating: process.env.SKU_ONLY_WITH_RATING !== '0',
  skuPriceMin: process.env.SKU_PRICE_MIN != null && process.env.SKU_PRICE_MIN !== '' ? Number(process.env.SKU_PRICE_MIN) : null,
  skuPriceMax: process.env.SKU_PRICE_MAX != null && process.env.SKU_PRICE_MAX !== '' ? Number(process.env.SKU_PRICE_MAX) : null,
  skuRatingMin: process.env.SKU_RATING_MIN != null && process.env.SKU_RATING_MIN !== '' ? Number(process.env.SKU_RATING_MIN) : null,
  skuRatingMax: process.env.SKU_RATING_MAX != null && process.env.SKU_RATING_MAX !== '' ? Number(process.env.SKU_RATING_MAX) : null,

  // 引擎
  headless: process.env.HEADLESS !== '0',
  pageIntervalMinMs: Number(process.env.PAGE_INTERVAL_MIN_MS) || 10000,
  pageIntervalMaxMs: Number(process.env.PAGE_INTERVAL_MAX_MS) || 15000,
  // 店铺间隔(独立于页间隔;未配置时回退页间隔值,保持旧行为)
  storeIntervalMinMs: numOrNull(process.env.STORE_INTERVAL_MIN_MS) ?? (Number(process.env.PAGE_INTERVAL_MIN_MS) || 10000),
  storeIntervalMaxMs: numOrNull(process.env.STORE_INTERVAL_MAX_MS) ?? (Number(process.env.PAGE_INTERVAL_MAX_MS) || 15000),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS) || 15000,
  maxEmptyPages: Number(process.env.MAX_EMPTY_PAGES) || 3,
  maxErrors: Number(process.env.MAX_ERRORS) || 3,

  // 熔断恢复
  circuitBreakerWaitMs: Number(process.env.CIRCUIT_BREAKER_WAIT_MS) || 180000,
  circuitBreakerBackoff: Number(process.env.CIRCUIT_BREAKER_BACKOFF) || 1,
  maxCircuitBreaks: Number(process.env.MAX_CIRCUIT_BREAKS) || 0, // 0=永不放弃(404 永久错误不受此限)

  // 写入
  dryRun: process.env.DRY_RUN === '1',

  // SKU 逐条日志(1=每个 SKU 一行输出重要字段,便于终端/文件排查)
  logSku: process.env.LOG_SKU === '1',

  // 对齐插件链路(仅 passesFilter=1 的 SKU)
  // 写 ozon_dom_cache(card)+ ozon_cache_index 索引聚合(FTS 自动同步)
  writeDomCache: process.env.WRITE_DOM_CACHE !== '0', // 默认开启
  // 入队 collect_queue_tasks(pending,全部入队;由插件 SW 轮询 claim 消费)
  enqueueDepth: process.env.ENQUEUE_DEPTH !== '0', // 默认开启
};

// 配置校验
if (cfg.pageIntervalMinMs > cfg.pageIntervalMaxMs) {
  console.error(`[配置错误] PAGE_INTERVAL_MIN_MS(${cfg.pageIntervalMinMs}) > MAX(${cfg.pageIntervalMaxMs})`);
  process.exit(1);
}
if (cfg.storeIntervalMinMs > cfg.storeIntervalMaxMs) {
  console.error(`[配置错误] STORE_INTERVAL_MIN_MS(${cfg.storeIntervalMinMs}) > MAX(${cfg.storeIntervalMaxMs})`);
  process.exit(1);
}
if (!cfg.erpApiKey) {
  console.error('[配置错误] ERP_API_KEY 未配置(与后端 SERVICE_API_KEY 同值,见 .env.example)');
  process.exit(1);
}
// 排序键(与 ERP store-classification DAO sortColMap 一致;lastSeenAt 为服务端默认)
const SORT_COLUMNS = ['lastSeenAt', 'ordersCount', 'reviewsCount', 'rating', 'openedMonths'];
if (!SORT_COLUMNS.includes(cfg.storeSort)) {
  console.error(`[配置错误] STORE_SORT 无效: ${cfg.storeSort}(可选: ${SORT_COLUMNS.join('/')})`);
  process.exit(1);
}

// ── 工具 ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.round(rand(min, max));

// LOG_SKU 定宽输出:名称截断(按 Unicode 码点,最多 n 字符,压平换行)
const truncName = (v, n = 10) => {
  const t = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > n ? chars.slice(0, n).join('') : t;
};
// LOG_SKU 定宽输出:数值右对齐定宽(空值显示 -)
const fmtNum = (v, n) => String(v ?? '-').padStart(n);

// ── 单实例锁(防双开导致 progress 互相覆盖) ──────────────────
function acquireLock() {
  if (existsSync(cfg.lockFile)) {
    let alive = false;
    try {
      const pid = Number(readFileSync(cfg.lockFile, 'utf-8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        // Windows: process.kill(pid, 0) 活着会成功,死了抛 ESRCH
        try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      }
    } catch { /* 读取失败视为死锁 */ }
    if (alive) {
      console.error(`[退出] 已有实例运行(PID ${readFileSync(cfg.lockFile, 'utf-8').trim()}),锁文件: ${cfg.lockFile}`);
      process.exit(1);
    }
    console.log('[锁] 发现残留锁文件(进程已死),覆盖');
  }
  writeFileSync(cfg.lockFile, String(process.pid));
}
function releaseLock() {
  try { unlinkSync(cfg.lockFile); } catch { /* 已删除 */ }
}

// ── ERP API Client(移植自 deep-collect.js) ─────────────────
// 统一出口:x-api-key 头 + 超时(AbortController) + 请求级重试 + 连续失败熔断
// 错误分类(kind):ERP_NET / ERP_HTTP_5xx / ERP_AUTH(401,快速失败) / ERP_4xx(请求构造 bug)
class ErpError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'ErpError';
    this.kind = kind;
    this.status = status;
  }
}

let interrupted = false;
let erpFailStreak = 0;
let erpBreakerNotified = false;

async function erpRawRequest(method, reqPath, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(cfg.erpBaseUrl + reqPath, {
      method,
      headers: {
        'x-api-key': cfg.erpApiKey,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (resp.status === 401) {
      throw new ErpError('ERP_AUTH', 'x-api-key 无效或后端未配置 SERVICE_API_KEY(检查两侧 .env)', 401);
    }
    if (resp.status >= 500) {
      throw new ErpError('ERP_HTTP_5xx', `HTTP ${resp.status}`, resp.status);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ErpError('ERP_4xx', `HTTP ${resp.status} ${text.slice(0, 200)}`, resp.status);
    }
    return await resp.json().catch(() => ({}));
  } catch (e) {
    if (e instanceof ErpError) throw e;
    if (e?.name === 'AbortError') throw new ErpError('ERP_NET', `timeout ${timeoutMs}ms`);
    throw new ErpError('ERP_NET', String(e?.message || e));
  } finally {
    clearTimeout(timer);
  }
}

// ERP 恢复探测:/health 为 public 路径;每 30s 一次直到恢复
async function waitForErpRecovery() {
  console.warn(`[ERP] 连续失败 ${erpFailStreak} 次,暂停采集,每 30s 探测 /health...`);
  while (!interrupted) {
    try {
      await erpRawRequest('GET', '/health', undefined, 10000);
      erpFailStreak = 0;
      erpBreakerNotified = false;
      console.log('[ERP] /health 探测恢复,清零续采');
      return;
    } catch {
      await sleep(30000);
    }
  }
  throw new ErpError('ERP_NET', '中断于 ERP 恢复等待');
}

async function erpFetch(method, reqPath, body) {
  if (erpFailStreak >= cfg.erpFailMax) await waitForErpRecovery();
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await erpRawRequest(method, reqPath, body, cfg.erpTimeoutMs);
      erpFailStreak = 0;
      erpBreakerNotified = false;
      return r;
    } catch (e) {
      if (e instanceof ErpError && e.kind === 'ERP_AUTH') throw e; // 配置类错误不重试
      lastErr = e;
      const retryable = e instanceof ErpError && (e.kind === 'ERP_NET' || e.kind === 'ERP_HTTP_5xx');
      if (attempt === 0 && retryable) {
        await sleep(2000); // 对齐插件 _erpQueueUpdate:2s 后重试 1 次
        continue;
      }
      if (!retryable) throw e;
    }
  }
  erpFailStreak++;
  if (erpFailStreak >= cfg.erpFailMax && !erpBreakerNotified) {
    erpBreakerNotified = true;
  }
  throw lastErr;
}

const erp = {
  // 店铺分类列表(分页;filter/sortBy 由查询串传递)
  getStoresPage: async (query) => {
    const r = await erpFetch('GET', `/admin/api/store-classification?${query}`);
    return r?.data ?? { items: [], total: 0 };
  },
  // 浅度日志(单条)
  insertShallowLog: (body) => erpFetch('POST', '/admin/api/shallow-collect/log', body),
  // dom 缓存写入(ERP domDao.upsertCard 自动触发 indexDao.syncSku 索引聚合)
  setDomCache: (sku, type, data) =>
    erpFetch('POST', `/ozon/cache/dom/${encodeURIComponent(sku)}`, { type, data }),
  // 深度队列入队
  submitTask: (body) => erpFetch('POST', '/admin/api/collect-queue', body),
  // 启动探活(带鉴权的轻量 GET)
  getQueueStats: async () => {
    const r = await erpFetch('GET', '/admin/api/collect-queue/stats');
    return r?.data ?? null;
  },
};

// 查询待采店铺(GET /admin/api/store-classification 分页拉全量)
// 过滤条件尽量下推 ERP(isMainlandChina/数值范围/排序);
// sellerIds 白名单(ERP 不支持)与 sellerId 纯数字校验在客户端过滤
async function loadStores(progress) {
  const q = new URLSearchParams();
  if (cfg.storeSellerIds.length === 0 && cfg.storeOnlyMainlandChina) {
    q.set('isMainlandChina', 'true');
  }
  // 数值范围过滤(ERP 参数名与浅采语义一一对应;NULL 值被范围条件排除)
  const ranges = [
    ['ordersCount', cfg.storeOrdersMin, cfg.storeOrdersMax],
    ['reviewsCount', cfg.storeReviewsMin, cfg.storeReviewsMax],
    ['rating', cfg.storeRatingMin, cfg.storeRatingMax],
    ['openedMonths', cfg.storeOpenedMonthsMin, cfg.storeOpenedMonthsMax],
  ];
  for (const [key, min, max] of ranges) {
    if (min != null) q.set(`${key}Min`, String(min));
    if (max != null) q.set(`${key}Max`, String(max));
  }
  q.set('sortBy', cfg.storeSort); // lastSeenAt 为服务端默认,显式传递保持一致
  q.set('pageSize', '200'); // ERP 上限 200

  // 白名单模式(不传 isMainlandChina,客户端按 sellerId 集合过滤)
  const sellerIdSet = new Set(cfg.storeSellerIds);

  const rows = [];
  for (let page = 1; ; page++) {
    q.set('currentPage', String(page));
    const r = await erp.getStoresPage(q.toString());
    const items = Array.isArray(r.items) ? r.items : [];
    for (const it of items) {
      const sellerId = String(it.sellerId || it._id || '');
      if (!/^\d+$/.test(sellerId)) continue; // 对齐原 SQL 结果的纯数字校验
      if (sellerIdSet.size > 0 && !sellerIdSet.has(sellerId)) continue;
      rows.push({ sellerId, sellerSlug: it.sellerSlug ?? null });
    }
    const total = Number(r.total) || 0;
    if (items.length === 0 || rows.length >= total) break;
  }

  // 断点续传:排除已完成(REVISIT_DAYS=0 永久有效;>0 时 N 天后重采)
  const now = Date.now();
  const pending = rows.filter((r) => {
    const d = progress.done?.[String(r.sellerId)];
    if (!d) return true;
    if (cfg.revisitDays <= 0) return false;
    return now - new Date(d.at).getTime() > cfg.revisitDays * 24 * 3600 * 1000;
  });
  if (cfg.storeLimit > 0) return pending.slice(0, cfg.storeLimit);
  return pending;
}

// 每页 flush:三链路写入(对齐插件 ozon-data-panel.js onCardExtracted),走 ERP API
//   ① 浅度日志(全部 SKU,含过滤不通过) → POST /admin/api/shallow-collect/log
//   ② dom card 缓存(仅通过) → POST /ozon/cache/dom/:sku
//      (ERP domDao.upsertCard 自动触发 indexDao.syncSku 索引聚合,
//       原 syncSkuLite 轻量版已整体移除)
//   ③ 深度采集队列入队(仅通过) → POST /admin/api/collect-queue
//      (skipIfTodaySuccess:false,对齐原"全部入队不做 24h 成功去重"语义)
// 注:原单事务原子性不再保留 — ERP 逐请求写入;页面级失败由 erpFetch 重试+熔断兜底,
//     熔断恢复后整页重写(浅度日志按 SKU+时间追加,重复写可接受)
const ERP_WRITE_CONCURRENCY = 4; // 小并发批次,每页几十条请求不打满本地 ERP

async function flushLogs(logs, store) {
  if (logs.length === 0) return;
  if (cfg.dryRun) {
    console.log(`    [DRY_RUN] 跳过写入 ${logs.length} 条`);
    return;
  }
  const now = new Date().toISOString();
  const passed = logs.filter((s) => s.passesFilter);

  const runBatch = async (thunks) => {
    for (let i = 0; i < thunks.length; i += ERP_WRITE_CONCURRENCY) {
      await Promise.all(thunks.slice(i, i + ERP_WRITE_CONCURRENCY).map((f) => f()));
    }
  };

  // ① 浅度日志(全部 SKU,含过滤不通过)
  await runBatch(
    logs.map((s) => () =>
      erp.insertShallowLog({
        sku: s.sku,
        sellerSlug: store.sellerSlug ?? null,
        sellerId: String(store.sellerId),
        name: s.name ?? null,
        price: s.price != null ? Number(s.price) : null,
        ratingCount: s.ratingCount != null ? Number(s.ratingCount) : null,
        imageUrl: s.imageUrl ?? null,
        passesFilter: s.passesFilter,
        skipReason: s.skipReason ?? null,
        source: 'headless-api',
        collectedAt: now,
      })
    )
  );

  // ②③ dom card 缓存 + 深度入队(仅通过过滤的;thunk 延迟执行避免请求提前发出)
  const writes = [];
  for (const s of passed) {
    if (cfg.writeDomCache) {
      writes.push(() =>
        erp.setDomCache(s.sku, 'card', {
          sku: s.sku,
          url: s.url || '',
          name: s.name || '',
          price: s.price != null ? Number(s.price) : null,
          image: s.imageUrl || '',
          ratingCount: s.ratingCount ?? null,
          source: 'api',
        })
      );
    }
    if (cfg.enqueueDepth) {
      writes.push(() =>
        erp.submitTask({
          sku: s.sku,
          sellerSlug: store.sellerSlug ?? null,
          sellerId: String(store.sellerId),
          domInfo: {
            title: s.name || '',
            price: s.price != null ? Number(s.price) : null,
            imageUrl: s.imageUrl || '',
            ratingCount: s.ratingCount ?? null,
          },
          skipIfTodaySuccess: false, // 全部入队,不做 24h 成功去重(对齐原 SQL 语义)
        })
      );
    }
  }
  await runBatch(writes);
}

// ── 断点续传 progress(带时间戳对象结构,支持 REVISIT_DAYS 重采) ──
function loadProgress() {
  if (!existsSync(cfg.progressFile)) return { done: {}, failed: {}, lastRunAt: null };
  try {
    const p = JSON.parse(readFileSync(cfg.progressFile, 'utf-8'));
    // 兼容 backfill 风格的数组 done(误用时转为空)
    if (Array.isArray(p.done)) return { done: {}, failed: {}, lastRunAt: p.lastRunAt ?? null };
    return { done: p.done || {}, failed: p.failed || {}, lastRunAt: p.lastRunAt ?? null };
  } catch {
    return { done: {}, failed: {}, lastRunAt: null };
  }
}
function saveProgress(progress) {
  progress.lastRunAt = new Date().toISOString();
  if (cfg.dryRun) return; // 干跑不落盘
  writeFileSync(cfg.progressFile, JSON.stringify(progress, null, 2));
}

// ── 4 道过滤(Node 侧,对齐 ozon-data-panel.js API 直取模式) ──
function applyFilter(card) {
  // 1. "仅抓有评论":开启时跳过 ratingCount=0/null
  const passesOnlyWithRating = !cfg.skuOnlyWithRating || !!card.ratingCount;

  // 2+3. 价格范围 + 评论数范围
  let passesRange = true;
  let skipReason = null;
  if (!passesOnlyWithRating) {
    skipReason = 'no-rating';
  } else {
    const p = Number(card.price);
    const r = Number(card.ratingCount);
    if (Number.isFinite(p)) {
      if (cfg.skuPriceMin != null && p < cfg.skuPriceMin) { passesRange = false; skipReason = 'price-below-min'; }
      else if (cfg.skuPriceMax != null && p > cfg.skuPriceMax) { passesRange = false; skipReason = 'price-above-max'; }
    } else if (cfg.skuPriceMin != null || cfg.skuPriceMax != null) {
      passesRange = false; skipReason = 'price-invalid';
    }
    if (passesRange && Number.isFinite(r)) {
      if (cfg.skuRatingMin != null && r < cfg.skuRatingMin) { passesRange = false; skipReason = 'rating-below-min'; }
      else if (cfg.skuRatingMax != null && r > cfg.skuRatingMax) { passesRange = false; skipReason = 'rating-above-max'; }
    }
  }
  return { passesFilter: passesOnlyWithRating && passesRange, skipReason };
}

// ── 注入函数:单页 fetch + 解析(独立无闭包,每次 evaluate 200-500ms) ──
// 逻辑对齐 qx-ozon/collect/content/api-scroller.js(_extractCardFromItem/_parseEntryResponse/_rewritePath/_fetchEntryPage)
const FETCH_PAGE_FN = async ({ path, timeoutMs }) => {
  const BASE = 'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=';

  // 从 tileGridDesktop item 提取 card 字段(对齐 api-scroller _extractCardFromItem)
  const extractCardFromItem = (item) => {
    let name = '';
    let price = null;
    let originalPrice = null;
    let rating = null;
    let ratingCount = null;

    for (const st of item.mainState || []) {
      // 商品名: textDS + automatizationId='tile-name'
      if (st.type === 'textDS' && st.textDS?.testInfo?.automatizationId === 'tile-name') {
        name = st.textDS.text || '';
      }
      // 价格: priceV2.price 数组,PRICE=售价,ORIGINAL_PRICE=划线价
      if (st.type === 'priceV2' && Array.isArray(st.priceV2?.price)) {
        for (const p of st.priceV2.price) {
          const m = String(p.text || '').match(/([\d.,]+)/);
          if (!m) continue;
          const n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
          if (!isFinite(n)) continue;
          if (p.textStyle === 'PRICE') price = n;
          else if (p.textStyle === 'ORIGINAL_PRICE') originalPrice = n;
        }
      }
      // 评分 + 评论数: labelListV2.items 中找特定 icon
      if (st.type === 'labelListV2' && Array.isArray(st.labelListV2?.items)) {
        const labelItems = st.labelListV2.items;
        for (let i = 0; i < labelItems.length; i++) {
          const it = labelItems[i];
          if (it.type === 'icon' && it.icon?.icon?.icon === 'ic_s_star_filled_compact') {
            const next = labelItems[i + 1];
            if (next?.type === 'text') rating = next.text.text || null;
          }
          if (it.type === 'icon' && it.icon?.icon?.icon === 'ic_s_dialog_filled_compact') {
            const next = labelItems[i + 1];
            if (next?.type === 'text') {
              const m = String(next.text.text || '').match(/(\d+)/);
              if (m) ratingCount = parseInt(m[1], 10);
            }
          }
        }
      }
    }

    // 图片: tileImage.items[0].image.link
    let imageUrl = '';
    const imgItems = item.tileImage?.items || [];
    if (imgItems.length > 0 && imgItems[0].image?.link) {
      imageUrl = imgItems[0].image.link;
    }

    return {
      sku: String(item.sku || ''),
      name,
      price,
      originalPrice,
      rating,
      ratingCount,
      imageUrl,
      url: item.action?.link || '',
    };
  };

  // 从 entrypoint-api 响应提取 items + nextPage + sellerId
  const parseEntryResponse = (data) => {
    if (!data || !data.widgetStates) {
      return { items: [], nextPage: null, sellerId: null };
    }
    const tileGridKey = Object.keys(data.widgetStates).find((k) => k.startsWith('tileGridDesktop'));
    let items = [];
    if (tileGridKey) {
      try {
        const state = JSON.parse(data.widgetStates[tileGridKey]);
        items = Array.isArray(state.items) ? state.items : [];
      } catch { /* 解析失败按空页处理 */ }
    }
    let nextPage = data.nextPage || null;
    const pagKey = Object.keys(data.widgetStates).find((k) => k.startsWith('infiniteVirtualPaginator'));
    if (pagKey) {
      try {
        const pag = JSON.parse(data.widgetStates[pagKey]);
        if (pag.nextPage) nextPage = pag.nextPage;
      } catch { /* 忽略 */ }
    }
    const sellerId = data.pageInfo?.analyticsInfo?.sellerId || null;
    return { items, nextPage, sellerId };
  };

  // 重写 path 的 query 参数:去 sorting 加 sorting=discount、去 __rr
  // (path 来自 Ozon 返回的 nextPage,作为字面量拼进顶层 URL,不 encodeURIComponent)
  const rewritePath = (p) => {
    if (!p) return p;
    const qIdx = p.indexOf('?');
    if (qIdx < 0) return p + '?sorting=discount';
    const pathname = p.slice(0, qIdx);
    let search = p.slice(qIdx + 1);
    search = search.replace(/(^|&)sorting=[^&]*/g, '').replace(/^&/, '');
    search = search.replace(/(^|&)__rr=[^&]*/g, '').replace(/^&/, '');
    search = search ? 'sorting=discount&' + search : 'sorting=discount';
    return pathname + '?' + search;
  };

  // 端点耗时埋点(www.entrypoint.seller-list):声明在 try 外,catch 亦可上报
  const __t0 = performance.now();
  const __timing = () => ({
    startedAt: new Date(Date.now() - (performance.now() - __t0)).toISOString(),
    durationMs: Math.round(performance.now() - __t0),
  });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
    let resp;
    try {
      resp = await fetch(BASE + rewritePath(path), {
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return { error: `HTTP ${resp.status}`, status: resp.status, __timing: __timing() };
    const data = await resp.json();
    const { items, nextPage, sellerId } = parseEntryResponse(data);
    const cards = [];
    for (const item of items) {
      const card = extractCardFromItem(item);
      if (card.sku) cards.push(card);
    }
    return {
      cards,
      nextPage: nextPage || null,
      sellerId: sellerId ? String(sellerId) : null,
      error: null,
      status: resp.status,
      __timing: __timing(),
    };
  } catch (e) {
    return {
      error: e?.name === 'AbortError' ? 'AbortError: timeout' : String(e?.message || e),
      __timing: __timing(),
      __errorKind: e?.name === 'AbortError' ? 'TIMEOUT' : 'NET_' + String(e?.message || 'e').slice(0, 36),
    };
  }
};

// ── 错误分类:404=永久(跳过该店),其余=临时(熔断重试) ──────────
function isPermanentError(r) {
  return r?.status === 404 || /HTTP 404/.test(String(r?.error || ''));
}

// ── 浏览器 ───────────────────────────────────────────────────
let browser = null;

// 返回工作页:复用会话恢复的第一个标签页(全部关闭会导致上下文退出,后续 newPage 报
// Protocol error (Target.createTarget): Failed to open a new tab),
// 其余残留页关闭(后台加载占内存且可能触发反爬);无恢复页时新建
async function launchBrowser() {
  browser = await launchPersistentContext({
    userDataDir: cfg.profileDir,
    headless: cfg.headless,
  });
  const restored = (() => {
    try { return browser.pages(); } catch { return []; }
  })();
  for (const p of restored.slice(1)) await p.close().catch(() => {});
  if (restored.length > 1) {
    console.log(`    已关闭 ${restored.length - 1} 个残留标签页,复用第 1 个为工作页`);
  }
  return restored[0] || (await browser.newPage());
}

// 访问 ozon.ru 首页:过反爬挑战 + 建立/刷新 cookie(带健康探测)
async function warmup(page) {
  await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000); // 给 cloakbrowser stealth 时间通过反爬挑战
  const title = await page.title();
  console.log(`    warmup: 首页标题 "${(title || '').slice(0, 50)}"`);
  return title;
}

// ── 店铺页导航 + 耗时埋点(纯 goto 耗时,不含后续 3s 反爬等待) ──
async function gotoSellerPage(page, sellerId) {
  const ts = new Date().toISOString();
  const t0 = Date.now();
  try {
    const resp = await page.goto(`https://www.ozon.ru/seller/${sellerId}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    addMetric({
      endpoint: 'www.page.seller-nav',
      sellerId: String(sellerId),
      ts,
      durationMs: Date.now() - t0,
      statusCode: resp?.status() ?? null,
      ok: (resp?.status() ?? 200) < 400,
    });
    return resp;
  } catch (e) {
    addMetric({
      endpoint: 'www.page.seller-nav',
      sellerId: String(sellerId),
      ts,
      durationMs: Date.now() - t0,
      statusCode: null,
      ok: false,
      errorKind: 'NAV_FAILED',
    });
    throw e;
  }
}

// ── Node 侧单店翻页循环(state 跨熔断持久) ───────────────────
async function collectStore(page, store, state) {
  while (state.nextPagePath && !interrupted) {
    const r = await page.evaluate(FETCH_PAGE_FN, {
      path: state.nextPagePath,
      timeoutMs: cfg.requestTimeoutMs,
    });

    // 端点耗时上报(www.entrypoint.seller-list;sellerId 优先取页面响应内的,兜底 store 配置)
    if (r?.__timing) {
      addMetric({
        endpoint: 'www.entrypoint.seller-list',
        sellerId: r.sellerId || String(store?.sellerId || ''),
        durationMs: r.__timing.durationMs,
        ts: r.__timing.startedAt,
        statusCode: r.status ?? null,
        ok: !r.error,
        errorKind: r.error ? r.__errorKind || 'HTTP_' + r.status : null,
      });
    }

    // 错误分类与熔断判定
    if (r.error) {
      if (isPermanentError(r)) {
        return { outcome: 'skip', reason: r.error };
      }
      state.consecutiveErrors++;
      if (state.consecutiveErrors >= cfg.maxErrors) {
        return { outcome: 'circuit-break', error: r.error };
      }
      console.log(`    页失败(${state.consecutiveErrors}/${cfg.maxErrors}): ${r.error},退避重试`);
      await sleep(Math.min(5000, 1000 * state.consecutiveErrors));
      continue;
    }
    state.consecutiveErrors = 0;
    state.pages++;

    // 过滤 + 去重(Node 侧)
    let newCount = 0;
    let passedCount = 0;
    const logs = [];
    for (const card of r.cards) {
      const skuStr = String(card.sku);
      if (state.seenSkus.has(skuStr)) continue;
      state.seenSkus.add(skuStr);
      newCount++;
      const { passesFilter, skipReason } = applyFilter(card);
      if (passesFilter) passedCount++;

      // LOG_SKU=1:每个 SKU 一行,定宽对齐(名称最多 10 字符,数值右对齐)
      if (cfg.logSku) {
        const name = truncName(card.name, 10) || '-';
        console.log(
          `      ${skuStr.padEnd(10)} | ${name.padEnd(10)} | ${fmtNum(card.price, 8)} | ${fmtNum(card.rating, 6)} | ${fmtNum(card.ratingCount, 7)} | ${passesFilter ? 'PASS' : `SKIP(${skipReason})`}`
        );
      }

      logs.push({
        sku: skuStr,
        name: card.name,
        price: card.price,
        ratingCount: card.ratingCount,
        imageUrl: card.imageUrl,
        url: card.url,
        passesFilter,
        skipReason,
      });
    }
    // ERP 写入失败(重试+熔断后仍失败)直接抛给 main,避免静默丢页
    await flushLogs(logs, store);

    // 终止判定
    state.nextPagePath = r.nextPage;
    state.consecutiveEmptyPages = newCount === 0 ? state.consecutiveEmptyPages + 1 : 0;

    console.log(
      `    第${state.pages}页: ${r.cards.length} SKU(新 ${newCount},过 ${passedCount}),累计 ${state.seenSkus.size}` +
      (r.nextPage ? '' : ',已到最后一页') +
      (newCount === 0 ? `,空页(${state.consecutiveEmptyPages}/${cfg.maxEmptyPages})` : '')
    );

    if (!r.nextPage || state.consecutiveEmptyPages >= cfg.maxEmptyPages) {
      return { outcome: 'done', skuCount: state.seenSkus.size, passedCount, pages: state.pages };
    }

    // ★ 页间节流:10-15s 随机(反爬拟人化;输出下一次执行时间)
    const pageWaitMs = randInt(cfg.pageIntervalMinMs, cfg.pageIntervalMaxMs);
    console.log(`    下一页预计 ${fmtNext(pageWaitMs)}(等待 ${Math.round(pageWaitMs / 1000)}s)`);
    await sleep(pageWaitMs);
  }
  // interrupted:不标记 done(已写页已落库,重跑时该店重新采集会重复写日志,
  // 但浅度日志按 SKU+时间追加是正常语义,可接受)
  return { outcome: 'interrupted', skuCount: state.seenSkus.size, pages: state.pages };
}

// ── main ─────────────────────────────────────────────────────
async function main() {
  console.log('=== 无头浅度采集(API 直取,走 ERP API) ===');
  console.log(`ERP:       ${cfg.erpBaseUrl}`);
  console.log(`Profile:   ${cfg.profileDir}`);
  console.log(`无头:      ${cfg.headless}  干跑: ${cfg.dryRun}`);
  console.log(`页间隔:    ${cfg.pageIntervalMinMs}-${cfg.pageIntervalMaxMs}ms 随机`);
  console.log(`店铺间隔:  ${cfg.storeIntervalMinMs}-${cfg.storeIntervalMaxMs}ms 随机${process.env.STORE_INTERVAL_MIN_MS == null && process.env.STORE_INTERVAL_MAX_MS == null ? '(未配置,回退页间隔)' : ''}`);
  console.log(`熔断等待:  ${cfg.circuitBreakerWaitMs}ms(退避系数 ${cfg.circuitBreakerBackoff})`);
  console.log(`SKU过滤:   仅有评论=${cfg.skuOnlyWithRating}, 价格=[${cfg.skuPriceMin ?? '-'},${cfg.skuPriceMax ?? '-'}], 评论数=[${cfg.skuRatingMin ?? '-'},${cfg.skuRatingMax ?? '-'}]`);
  console.log(`SKU逐条日志: ${cfg.logSku ? '开启(LOG_SKU=1)' : '关闭'}`);
  // 店铺数值过滤(仅显示已配置的)
  const storeRanges = [
    ['订单数', cfg.storeOrdersMin, cfg.storeOrdersMax],
    ['评论数', cfg.storeReviewsMin, cfg.storeReviewsMax],
    ['评分', cfg.storeRatingMin, cfg.storeRatingMax],
    ['开业月数', cfg.storeOpenedMonthsMin, cfg.storeOpenedMonthsMax],
  ].filter(([, min, max]) => min != null || max != null)
    .map(([label, min, max]) => `${label}=[${min ?? '-'},${max ?? '-'}]`);
  console.log(`店铺过滤:   仅大陆=${cfg.storeOnlyMainlandChina}${storeRanges.length ? ', ' + storeRanges.join(', ') : ''}`);
  console.log(`链路对齐:   dom缓存=${cfg.writeDomCache ? '开' : '关'}, 深度入队=${cfg.enqueueDepth ? '开' : '关'}`);

  acquireLock();

  const progress = loadProgress();

  // Ctrl+C 优雅退出:保存进度 + 关浏览器(最多丢当前页)
  process.on('SIGINT', () => {
    if (interrupted) process.exit(1); // 二次 Ctrl+C 强制退出
    interrupted = true;
    console.log('\n[中断] 收到 SIGINT,正在保存进度并退出...');
    try { saveProgress(progress); } catch { /* 忽略 */ }
    releaseLock();
    finalizeMetrics().catch(() => {}); // 非阻塞 flush,尽力而为
    browser?.close?.().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });

  // 1. ERP 连通性探测(带鉴权轻量 GET;失败快速退出)
  console.log('\n[1/5] 探测 ERP 连通性...');
  try {
    const stats = await erp.getQueueStats();
    console.log(`[1/5] ERP 连通正常,x-api-key 校验通过(队列 total=${stats?.total ?? '?'})`);
  } catch (e) {
    console.error(`[1/5] ERP 探测失败: ${e?.message || e}`);
    releaseLock();
    process.exit(1);
  }

  // 1.5 端点耗时监控初始化(缓冲 + 30s 定时上报 + 出口 IP 探测;失败自动禁用不阻断)
  initMetrics({ script: 'shallow', erpBaseUrl: cfg.erpBaseUrl, erpApiKey: cfg.erpApiKey, profileDir: cfg.profileDir });

  // 2. 启动浏览器(launchBrowser 返回工作页:复用会话恢复的第 1 个标签页)
  console.log('\n[2/5] 启动 stealth 浏览器...');
  const page = await launchBrowser();
  await warmup(page);

  // 3. 查询待采店铺
  console.log('\n[3/5] 查询待采店铺...');
  const stores = await loadStores(progress);
  const doneCount = Object.keys(progress.done).length;
  console.log(`[3/5] 累计已完成 ${doneCount} 个,本批待处理 ${stores.length} 个`);
  if (stores.length === 0) {
    console.log('\n全部完成,无需处理。');
    await browser.close();
    releaseLock();
    return;
  }

  // 4. 逐店采集
  console.log(`\n[4/5] 开始采集...`);
  let success = 0, skipped = 0, failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < stores.length && !interrupted; i++) {
    const store = stores[i];
    const idx = i + 1;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[${idx}/${stores.length}] sellerId=${store.sellerId} (${elapsed}s) ...`);

    // 导航店铺页(在店铺页上下文 fetch 才是真实用户行为 — 项目铁律)
    let navResp = null;
    try {
      navResp = await gotoSellerPage(page, store.sellerId);
      await page.waitForTimeout(3000); // 反爬挑战 + __NUXT__ 挂载
    } catch (e) {
      console.log(`    导航失败: ${e.message}`);
    }

    // 导航 404 = 店铺已注销,永久跳过
    if (navResp?.status() === 404) {
      console.log('    404 店铺不存在,跳过');
      progress.failed[String(store.sellerId)] = { error: 'store-not-found', at: new Date().toISOString() };
      saveProgress(progress);
      skipped++;
      continue;
    }

    const state = {
      nextPagePath: `/seller/${store.sellerId}/`,
      seenSkus: new Set(),
      consecutiveErrors: 0,
      consecutiveEmptyPages: 0,
      pages: 0,
    };
    let breakCount = 0;

    // SKU 逐条日志:输出列表头(与每行字段定宽一致)
    if (cfg.logSku) {
      console.log(`      ${'sku'.padEnd(10)} | ${'name'.padEnd(10)} | ${'price'.padStart(8)} | ${'rating'.padStart(6)} | ${'reviews'.padStart(7)} | result`);
    }

    // 单店循环(含熔断恢复)
    while (!interrupted) {
      const result = await collectStore(page, store, state);

      if (result.outcome === 'interrupted') {
        console.log(`    被中断(已采 ${result.skuCount} SKU / ${result.pages} 页,不标记完成)`);
        break;
      }
      if (result.outcome === 'done') {
        progress.done[String(store.sellerId)] = {
          at: new Date().toISOString(),
          skuCount: result.skuCount,
          pages: result.pages,
        };
        delete progress.failed[String(store.sellerId)];
        saveProgress(progress);
        success++;
        console.log(`    OK  共 ${result.skuCount} SKU / ${result.pages} 页`);
        break;
      }
      if (result.outcome === 'skip') {
        console.log(`    跳过(永久错误): ${result.reason}`);
        progress.failed[String(store.sellerId)] = { error: result.reason, at: new Date().toISOString() };
        saveProgress(progress);
        skipped++;
        break;
      }

      // outcome === 'circuit-break':熔断 ≠ 失败,等待后断点续采
      breakCount++;
      if (cfg.maxCircuitBreaks > 0 && breakCount >= cfg.maxCircuitBreaks) {
        console.log(`    连续熔断 ${breakCount} 次(达上限),放弃此店: ${result.error}`);
        progress.failed[String(store.sellerId)] = { error: `circuit-break x${breakCount}: ${result.error}`, at: new Date().toISOString() };
        saveProgress(progress);
        failed++;
        break;
      }
      const waitMs = Math.round(cfg.circuitBreakerWaitMs * (cfg.circuitBreakerBackoff ** (breakCount - 1)));
      console.log(`    熔断(#${breakCount}): ${result.error}`);
      console.log(`    等待 ${Math.round(waitMs / 1000)}s 后断点续采,预计 ${fmtNext(waitMs)}(已采 ${state.seenSkus.size} SKU / ${state.pages} 页)...`);
      const waitStart = Date.now();
      while (Date.now() - waitStart < waitMs && !interrupted) {
        await sleep(1000);
      }
      if (interrupted) break;

      // 恢复:重新 warmup 刷 cookie → 重新导航店铺页 → 从断点续采
      try {
        await warmup(page);
        await gotoSellerPage(page, store.sellerId);
        await page.waitForTimeout(3000);
      } catch (e) {
        console.log(`    恢复导航失败: ${e.message}`);
      }
      state.consecutiveErrors = 0;
      state.consecutiveEmptyPages = 0;
      // state.nextPagePath / seenSkus 保留 → 断点续采,不重复不漏采
    }

    // 店铺间隔(独立配置,未配置时与页间隔同款随机;输出下一次执行时间)
    if (i < stores.length - 1 && !interrupted) {
      const storeWaitMs = randInt(cfg.storeIntervalMinMs, cfg.storeIntervalMaxMs);
      console.log(`  下一店预计 ${fmtNext(storeWaitMs)}(等待 ${Math.round(storeWaitMs / 1000)}s)`);
      await sleep(storeWaitMs);
    }
  }

  // 5. 汇总
  console.log('\n[5/5] 汇总');
  console.log(`  成功: ${success}`);
  console.log(`  跳过: ${skipped}`);
  console.log(`  失败: ${failed}`);
  console.log(`  耗时: ${Math.round((Date.now() - startTime) / 1000)}s`);
  if (interrupted) console.log('  (被中断,进度已保存,重跑即续传)');
  else if (failed > 0 || skipped > 0) console.log('  失败/跳过明细见 shallow-collect-progress.json');

  saveProgress(progress);
  await browser.close();
  // 端点耗时监控:退出前 flush 尽力而为
  try { await finalizeMetrics(); } catch { /* 忽略 */ }
  releaseLock();
}

main().catch((e) => {
  console.error('\n致命错误:', e);
  releaseLock();
  process.exit(1);
});
