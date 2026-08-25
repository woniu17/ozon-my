// 无头 cloakbrowser 深度采集脚本(ERP API 数据通道版)
//
// 消费 ERP collect_queue_tasks 深度采集队列,按插件 _doAutoCollect 语义编排:
//   Gate 0.5 中国店铺检查 → Step1 缓存查询(5 类 GET) → Step3 marketStats(门控A)
//   → Step4 search+bundle(门控B/C) → Step5 买家页(richMedia+followSell+detail)
//   → Step6 终态+日志
//
// 与插件 SW 的关系:同队列的两个消费者,claim 原子性(UPDATE...RETURNING)保证不重复消费。
// 数据通道:全部读写走 ERP HTTP API(x-api-key 服务鉴权),不打开 erp.db,可跨机部署。
// 索引聚合由 ERP DAO upsert 自动触发(indexDao.syncSku),脚本无任何索引维护代码。
//
// 语义基准:qx-ozon/collect/background/collect-tab.js `_doAutoCollect`
// 骨架基准:qxqx/shallow-collect.js(.env/锁/熔断/统计输出)
// 设计文档:docs/深度采集cloakbrowser化-详细设计.md v2.0
//
// 用法: node deep-collect.js
// 可选环境变量(见 .env):
// Linux/macOS(bash):
//   TASK_LIMIT=1 DRY_RUN=1 node deep-collect.js   # 单任务干跑
//   TASK_LIMIT=1 LOG_SKU=1 node deep-collect.js   # 单任务落库 + 逐条日志
//   TASK_LIMIT=10 node deep-collect.js            # 小批量
// Windows(PowerShell;注意 $env: 会话内持久,常驻前先清残留):
//   $env:TASK_LIMIT='1'; $env:DRY_RUN='1'; node deep-collect.js   # 单任务干跑
//   $env:TASK_LIMIT='1'; $env:LOG_SKU='1'; node deep-collect.js   # 单任务落库 + 逐条日志
//   $env:TASK_LIMIT='10'; node deep-collect.js                    # 小批量
//   Remove-Item Env:TASK_LIMIT,Env:DRY_RUN,Env:LOG_SKU -ErrorAction SilentlyContinue
//   node deep-collect.js                                          # 常驻消费(0=不限)
// 前置:ERP 后端已启动且两侧 .env 配置了相同的 SERVICE_API_KEY / ERP_API_KEY;
//       profile(.ozon-profile)已人工登录过 seller.ozon.ru(sc_company_id 持久化)。

import { launchPersistentContext } from 'cloakbrowser';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv(path.join(__dirname, '.env'));

// ── 配置 ─────────────────────────────────────────────────────
const cfg = {
  // ERP 连接与鉴权(与后端 SERVICE_API_KEY 同值)
  erpBaseUrl: (process.env.ERP_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, ''),
  erpApiKey: process.env.ERP_API_KEY || '',
  erpTimeoutMs: Number(process.env.ERP_TIMEOUT_MS) || 15000,
  erpFailMax: Number(process.env.ERP_FAIL_MAX) || 5,

  profileDir: path.resolve(__dirname, process.env.PROFILE_DIR || '.ozon-profile'),
  lockFile: path.join(__dirname, '.deep-collect.lock'),

  // 任务
  taskLimit: Number(process.env.TASK_LIMIT) || 0, // 0=不限制
  claimEmptyWaitMs: Number(process.env.CLAIM_EMPTY_WAIT_MS) || 60000,
  dryRun: process.env.DRY_RUN === '1',
  logSku: process.env.LOG_SKU === '1',
  logData: process.env.LOG_DATA !== '0', // 关键数据日志(每类采集数据输出核心指标,默认开)

  // 节流(反爬拟人化)
  skuIntervalMinMs: Number(process.env.SKU_INTERVAL_MIN_MS) || 8000,
  skuIntervalMaxMs: Number(process.env.SKU_INTERVAL_MAX_MS) || 15000,

  // 门控(默认对齐插件当前生效值)
  enableMarketStatsGate: process.env.ENABLE_MARKET_STATS_GATE !== '0',
  enableCategoryFilterGate: process.env.ENABLE_CATEGORY_FILTER_GATE !== '0',
  enableUltraLightGate: process.env.ENABLE_ULTRA_LIGHT_GATE !== '0',
  onlyMainlandChina: process.env.ONLY_MAINLAND_CHINA !== '0',

  // 熔断/恢复
  antibotWaitMs: Number(process.env.ANTIBOT_WAIT_MS) || 600000,
  challengeWaitMs: Number(process.env.CHALLENGE_WAIT_MS) || 15000,
  sellerAuthWaitMs: Number(process.env.SELLER_AUTH_WAIT_MS) || 600000,
  authRetryMax: Number(process.env.AUTH_RETRY_MAX) || 3,

  // 超时
  portalFetchTimeoutMs: Number(process.env.PORTAL_FETCH_TIMEOUT_MS) || 20000,
  pdpFetchTimeoutMs: Number(process.env.PDP_FETCH_TIMEOUT_MS) || 30000,
  pageGotoTimeoutMs: Number(process.env.PAGE_GOTO_TIMEOUT_MS) || 30000,

  headless: process.env.HEADLESS !== '0',
};

if (cfg.skuIntervalMinMs > cfg.skuIntervalMaxMs) {
  console.error(`[配置错误] SKU_INTERVAL_MIN_MS(${cfg.skuIntervalMinMs}) > MAX(${cfg.skuIntervalMaxMs})`);
  process.exit(1);
}
if (!cfg.erpApiKey) {
  console.error('[配置错误] ERP_API_KEY 未配置(与后端 SERVICE_API_KEY 同值,见 .env.example)');
  process.exit(1);
}

// ── 工具 ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.round(min + Math.random() * (max - min));

let interrupted = false;

// ── 单实例锁 + profile 跨脚本锁 ──────────────────────────────
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function acquireFileLock(file, label) {
  if (existsSync(file)) {
    let alive = false;
    try {
      const pid = Number(readFileSync(file, 'utf-8').trim());
      if (Number.isFinite(pid) && pid > 0) alive = isPidAlive(pid);
    } catch { /* 读取失败视为死锁 */ }
    if (alive) {
      console.error(`[退出] ${label} 已有实例运行(PID ${readFileSync(file, 'utf-8').trim()}),锁文件: ${file}`);
      process.exit(1);
    }
    console.log(`[锁] ${label} 残留锁文件(进程已死),覆盖: ${file}`);
  }
  writeFileSync(file, String(process.pid));
}
function releaseFileLock(file) {
  try { unlinkSync(file); } catch { /* 已删除 */ }
}

// ── ERP API Client ───────────────────────────────────────────
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
  // claim 返回 { task | null }(ERP DAO claimNextPending 原子抢占,attempts 已 +1)
  claimTask: async () => {
    const r = await erpFetch('POST', '/admin/api/collect-queue/claim', {});
    return r?.data?.task ?? null;
  },
  // partial 回队(upsert 语义,createdAt=now 塞队尾)
  submitTask: (body) => erpFetch('POST', '/admin/api/collect-queue', body),
  // 终态(success/skipped)
  submitResult: (sku, body) =>
    erpFetch('POST', `/admin/api/collect-queue/${encodeURIComponent(sku)}/result`, body),
  // 深度采集日志(每个 return 路径都写)
  insertAutoCollectLog: (body) => erpFetch('POST', '/admin/api/auto-collect/log', body),
  // 缓存读取(raw 响应,无 ok 包装)
  getDomCache: (sku) => erpFetch('GET', `/ozon/cache/dom/${encodeURIComponent(sku)}`),
  getAttributeCache: (sku) => erpFetch('GET', `/ozon/cache/attribute/${encodeURIComponent(sku)}`),
  getMarketStatsCache: (sku) => erpFetch('GET', `/ozon/cache/marketStats/${encodeURIComponent(sku)}`),
  getFollowSellCache: (sku) => erpFetch('GET', `/ozon/cache/followSell/${encodeURIComponent(sku)}`),
  getRichMediaCache: (sku) => erpFetch('GET', `/ozon/cache/richMedia/${encodeURIComponent(sku)}`),
  // 缓存写入
  setDomCache: (sku, type, data) =>
    erpFetch('POST', `/ozon/cache/dom/${encodeURIComponent(sku)}`, { type, data }),
  setAttributeCache: (sku, type, data, bundleId) =>
    erpFetch('POST', `/ozon/cache/attribute/${encodeURIComponent(sku)}`, {
      type, data, ...(bundleId != null ? { bundleId } : {}),
    }),
  setMarketStatsCache: (sku, data) =>
    erpFetch('POST', `/ozon/cache/marketStats/${encodeURIComponent(sku)}`, { data }),
  setRichMediaCache: (sku, data) =>
    erpFetch('POST', `/ozon/cache/richMedia/${encodeURIComponent(sku)}`, { data }),
  setFollowSellCache: (sku, data) =>
    erpFetch('POST', `/ozon/cache/followSell/${encodeURIComponent(sku)}`, { data }),
  // 店铺分类(404=未分类 → null;其余失败抛出由调用方 catch)
  getStoreClassification: async (sellerId) => {
    try {
      const r = await erpFetch('GET', `/admin/api/store-classification/${encodeURIComponent(sellerId)}`);
      return r?.data ?? null;
    } catch (e) {
      if (e instanceof ErpError && e.status === 404) return null;
      throw e;
    }
  },
  // 队列统计(启动探活用,轻量带鉴权 GET)
  getQueueStats: () => erpFetch('GET', '/admin/api/collect-queue/stats'),
  // 类目黑名单列表
  getFilteredCategories: () => erpFetch('GET', '/admin/api/filtered-categories'),
  // 类目/类型中文名批量查询(body: { descCatIds, typeIds })
  getCategoryNames: (body) => erpFetch('POST', '/admin/api/filtered-categories/category-names-batch', body),
};

// ── 纯函数(移植自插件,Node 侧执行) ──────────────────────────

// what_to_sell/data/v3 单条 item 字段归一(collect-tab.js L49-86)
function normalizeMarketItem(item) {
  if (!item || typeof item !== 'object') return item;
  const pick = (...keys) => {
    for (const k of keys) if (item[k] != null) return item[k];
    return undefined;
  };
  return {
    ...item,
    soldCount: pick('soldCount', 'SoldCount', 'sold_count', 'sales', 'Sales'),
    gmvSum: pick('gmvSum', 'GmvSum', 'gmv_sum', 'revenue', 'Revenue'),
    avgPrice: pick('avgPrice', 'AvgGmv', 'avgGmv', 'avg_price', 'price', 'Price'),
    salesDynamics: pick('salesDynamics', 'SalesDynamics', 'sales_dynamics'),
    drr: pick('drr', 'Drr', 'DRR'),
    avgOrdersOnAccDays: pick('avgOrdersOnAccDays', 'AvgOrdersOnAccDays', 'avg_orders_on_acc_days'),
    avgGmvOnAccDays: pick('avgGmvOnAccDays', 'AvgGmvOnAccDays', 'avg_gmv_on_acc_days'),
    daysInPromo: pick('daysInPromo', 'DaysInPromo', 'days_in_promo'),
    discount: pick('discount', 'Discount'),
    promoRevenueShare: pick('promoRevenueShare', 'PromoRevenueShare'),
    daysWithTrafarets: pick('daysWithTrafarets', 'DaysWithTrafarets'),
    qtyViewPdp: pick('qtyViewPdp', 'QtyViewPdp', 'qty_view_pdp'),
    sessionCount: pick('sessionCount', 'SessionCount', 'session_count'),
    sessionCountSearch: pick('sessionCountSearch', 'SessionCountSearch', 'session_count_search'),
    pdpToCartConversion: pick('pdpToCartConversion', 'PdpToCartConversion'),
    convToCartPdp: pick('convToCartPdp', 'ConvToCartPdp'),
    convToCartSearch: pick('convToCartSearch', 'ConvToCartSearch'),
    convViewToOrder: pick('convViewToOrder', 'ConvViewToOrder'),
    views: pick('views', 'Views'),
    stock: pick('stock', 'Stock', 'balance'),
    salesSchema: pick('salesSchema', 'SalesSchema', 'sales_schema'),
    nullableRedemptionRate: pick('nullableRedemptionRate', 'NullableRedemptionRate', 'redemptionRate'),
    nullableCreateDate: pick('nullableCreateDate', 'NullableCreateDate', 'createDate', 'CreateDate'),
  };
}

// 类目 ID 提取(collect-runner.js L470-507,与 index-dao.js syncSku 同源)
function extractCategoryIds(searchVariant, bundleData) {
  let typeId = 0;
  let descCatId = 0;
  if (searchVariant && typeof searchVariant === 'object') {
    // typeId:description_type_dict_value(字段名误用,实际是 type_id)
    const sTi = Number(searchVariant.description_type_dict_value);
    if (Number.isFinite(sTi) && sTi > 0) typeId = sTi;
    if (Array.isArray(searchVariant.categories)) {
      const level3 = searchVariant.categories.find((c) => Number(c.level) === 3);
      if (level3) descCatId = Number(level3.id) || 0;
      if (!descCatId) {
        let deepest = null;
        for (const c of searchVariant.categories) {
          if (!deepest || Number(c.level) > Number(deepest.level)) deepest = c;
        }
        if (deepest) descCatId = Number(deepest.id) || 0;
      }
    }
  }
  if ((!descCatId || !typeId) && bundleData && typeof bundleData === 'object') {
    if (!descCatId) {
      const bDci = Number(bundleData.description_category_id);
      if (Number.isFinite(bDci) && bDci > 0) descCatId = bDci;
    }
    if (!typeId) {
      const bTi = Number(bundleData.type_id);
      if (Number.isFinite(bTi) && bTi > 0) typeId = bTi;
    }
  }
  return { descCatId, typeId };
}

// 类目黑名单命中(collect-runner.js L455-462;typeId=0 条目=单维度过滤)
function isCategoryFiltered(descCatId, typeId, filterMap) {
  if (!filterMap || !descCatId) return false;
  const typeSet = filterMap.get(Number(descCatId));
  if (!typeSet) return false;
  const tid = Number(typeId) || 0;
  return typeSet.has(tid) || typeSet.has(0);
}

// 超轻小件判定(collect-runner.js L513-523;阈值与 index-dao.js buildFilterWhere 一致)
function isUltraLight(bundleData) {
  if (!bundleData || typeof bundleData !== 'object') return false;
  const weightG = Number(bundleData.weight);
  const depth = Number(bundleData.depth);
  const width = Number(bundleData.width);
  const height = Number(bundleData.height);
  if (![weightG, depth, width, height].every((v) => Number.isFinite(v) && v > 0)) return false;
  return weightG < 500 && depth + width + height < 900;
}

// bundle 缓存可用性(对齐插件 bundleUsable;直接用 ERP GET 返回的 stale 标记)
// attrR = GET /ozon/cache/attribute/:sku 响应:{ searchData, bundleData, bundleId, attrsEmptyVerifiedAt, stale }
function bundleUsable(attrR) {
  const data = attrR?.bundleData;
  if (!data) return false;
  if (Array.isArray(data.attributes) && data.attributes.length > 0) return true;
  return attrR?.stale === false; // 空属性但 ERP 判定 6h 内已验证
}

// ── 注入函数:sellerPage 门户三调用合一 ────────────────────────
// 铁律:自包含(无闭包引用),page.evaluate 序列化约束。
// needCompanyId:'header'(marketStats,x-o3-company-id 请求头)|'body'(search/bundle,company_id 放 body)|falsy(不用)
const PORTAL_FETCH_FN = async (p) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs || 30000);
  // 端点耗时埋点:t0 记在 fetch 之前(未发 fetch 的提前 return 不带 timing,Node 侧不上报)
  let __t0 = 0;
  const __timing = () =>
    __t0
      ? { startedAt: new Date(Date.now() - (performance.now() - __t0)).toISOString(), durationMs: Math.round(performance.now() - __t0) }
      : null;
  try {
    let companyId = '';
    if (p.needCompanyId) {
      const cookies = document.cookie.split(';').map((c) => c.trim());
      const sc = cookies.find((c) => c.startsWith('sc_company_id='));
      companyId = sc ? sc.split('=')[1] : '';
      if (!companyId) return { ok: false, reason: 'NO_COMPANY_ID' };
    }
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-o3-app-name': 'seller-ui',
      'x-o3-language': 'zh-Hans',
    };
    if (p.needCompanyId === 'header') headers['x-o3-company-id'] = companyId;
    let body = p.body || null;
    if (p.needCompanyId === 'body' && body) body = { ...body, company_id: companyId };
    __t0 = performance.now();
    const resp = await fetch(p.path, {
      method: p.method || 'POST',
      credentials: 'include',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, reason: 'HTTP_' + resp.status, status: resp.status, __timing: __timing() };
    // 重定向到登录页(会话过期):fetch 自动跟随,resp.redirected + url 判定
    if (resp.redirected && /\/(signin|login|auth|registration)/i.test(resp.url || '')) {
      return { ok: false, reason: 'AUTH_REQUIRED', status: resp.status, __timing: __timing() };
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      return { ok: false, reason: 'PARSE_FAIL', status: resp.status, __timing: __timing() };
    }
    return { ok: true, status: resp.status, data, __timing: __timing() };
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') return { ok: false, reason: 'TIMEOUT', __timing: __timing() };
    return { ok: false, reason: 'NET_' + String(e?.message || 'error').slice(0, 60), __timing: __timing() };
  }
};

// ── 注入函数:买家页 PDP 媒体采集(移植 collect-tab.js fetchPdpMedia L487-905) ──
// 差异:fields 提取 + usefulPrefixes 过滤 widgetStates 在页内完成(插件在 SW 侧做,
//       此处提前以减小 evaluate 返回载荷),返回结构对齐 richMedia 缓存写入格式。
const PDP_MEDIA_FN = async ({ relPath, timeoutMs }) => {
  const parseMaybeJson = (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  };
  const normalizeOzonProductInnerPath = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, 'https://www.ozon.ru');
      return (url.pathname || '') + (url.search || '');
    } catch {
      const noHash = raw.split('#')[0];
      return noHash.startsWith('/') ? noHash : '/' + noHash;
    }
  };
  const ozonProductPathKey = (value) => normalizeOzonProductInnerPath(value).split('?')[0].replace(/\/+$/, '');
  const ozonProductId = (value) => {
    const pathKey = ozonProductPathKey(value);
    const match = pathKey.match(/\/product\/(?:[^/?#]*-)?(\d+)$/i);
    return match ? match[1] : '';
  };
  const endpointQueue = [];
  const seenEndpoints = new Set();
  const enqueuePath = (innerPath) => {
    const normalized = normalizeOzonProductInnerPath(innerPath);
    if (!normalized) return;
    const urls = [
      `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(normalized)}`,
      `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(normalized)}`,
    ];
    for (const url of urls) {
      if (seenEndpoints.has(url)) continue;
      seenEndpoints.add(url);
      endpointQueue.push(url);
    }
  };
  enqueuePath(relPath);
  const isRichDoc = (o) =>
    o &&
    typeof o === 'object' &&
    Array.isArray(o.content) &&
    o.content.length > 0 &&
    o.content.some((b) => b && typeof b === 'object' && typeof b.widgetName === 'string');
  const collectRichStats = (doc) => {
    const stats = {
      widgetCount: 0,
      textWidgetCount: 0,
      layoutWidgetCount: 0,
      chessWidgetCount: 0,
      imageCount: 0,
      textNodeCount: 0,
      textChars: 0,
      hasRealText: false,
    };
    const skipTextKeys = new Set([
      'widgetName', 'align', 'size', 'color', 'type', 'src', 'srcMobile', 'url', 'link',
      'imgLink', 'richAnnotationJson', 'class', 'className', 'style', 'trackingInfo',
      'layoutTrackingInfo', 'gifUrl', 'videoUrl', 'previewUrl', 'backgroundColor', 'theme',
      'padding', 'margin', 'id', 'reff', 'fontColor', 'borderColor', 'position', 'positionMobile',
    ]);
    const looksLikeImageUrl = (text) => /^https?:\/\/.+\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#].*)?$/i.test(text);
    const pushText = (value, key) => {
      if (key && skipTextKeys.has(key)) return;
      const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
      if (text.length < 2 || /^https?:\/\//i.test(text) || looksLikeImageUrl(text)) return;
      if (!/[A-Za-zА-Яа-яЁё]/.test(text)) return;
      stats.textNodeCount += 1;
      stats.textChars += text.length;
    };
    const walk = (node, key, depth) => {
      if (node == null || depth > 24) return;
      if (typeof node === 'string') {
        pushText(node, key);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item, key, depth + 1);
        return;
      }
      if (typeof node !== 'object') return;
      const widgetName = String(node.widgetName || '');
      const type = String(node.type || '');
      if (widgetName) {
        stats.widgetCount += 1;
        if (/text|description|annotation/i.test(widgetName)) stats.textWidgetCount += 1;
        if (/chess/i.test(widgetName) || /chess/i.test(type)) stats.chessWidgetCount += 1;
      }
      if (/showcase|billboard|roll|tile|media|chess/i.test(widgetName) || /billboard|roll|chess|tile/i.test(type)) {
        stats.layoutWidgetCount += 1;
      }
      if (node.img && typeof node.img === 'object') stats.imageCount += 1;
      for (const imageKey of ['src', 'srcMobile', 'url', 'image', 'imageUrl', 'coverImage']) {
        const raw = node[imageKey];
        if (typeof raw === 'string' && /^https?:\/\//i.test(raw) && looksLikeImageUrl(raw)) {
          stats.imageCount += 1;
        }
      }
      for (const childKey of Object.keys(node)) {
        if (skipTextKeys.has(childKey) && childKey !== 'text' && childKey !== 'title') continue;
        walk(node[childKey], childKey, depth + 1);
      }
    };
    walk(doc?.content, 'content', 0);
    stats.hasRealText = stats.textChars >= 12 || stats.textNodeCount >= 2 || stats.textWidgetCount > 0;
    return stats;
  };
  const extractRich = (states) => {
    const candidates = [];
    const seenJson = new Set();
    const seenObjects = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    const addCandidate = (doc, rawJson) => {
      if (!isRichDoc(doc)) return;
      const json =
        typeof rawJson === 'string' && rawJson.trim()
          ? rawJson.trim()
          : JSON.stringify({ content: doc.content, version: doc.version || 0.3 });
      if (seenJson.has(json)) return;
      seenJson.add(json);
      const stats = collectRichStats(doc);
      candidates.push({
        json,
        score:
          (stats.hasRealText ? 100000 : 0) +
          stats.chessWidgetCount * 20000 +
          stats.textWidgetCount * 12000 +
          stats.layoutWidgetCount * 600 +
          stats.textChars * 40 +
          stats.textNodeCount * 500 +
          stats.widgetCount * 80 +
          stats.imageCount * 20 +
          Math.min(json.length, 20000) / 20000 -
          candidates.length / 1000,
      });
    };
    const walk = (node, depth) => {
      if (node == null || depth > 24) return;
      const parsed = parseMaybeJson(node);
      if (!parsed || typeof parsed !== 'object') return;
      if (seenObjects) {
        if (seenObjects.has(parsed)) return;
        seenObjects.add(parsed);
      }
      if (typeof parsed.richAnnotationJson === 'string' && parsed.richAnnotationJson.trim()) {
        addCandidate(parseMaybeJson(parsed.richAnnotationJson), parsed.richAnnotationJson);
      }
      if (isRichDoc(parsed)) addCandidate(parsed, null);
      if (Array.isArray(parsed)) {
        for (const item of parsed) walk(item, depth + 1);
        return;
      }
      for (const key of Object.keys(parsed)) walk(parsed[key], depth + 1);
    };
    walk(states, 0);
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.json || '';
  };
  const hasRichContentText = (raw) => {
    const doc = parseMaybeJson(raw);
    return isRichDoc(doc) && collectRichStats(doc).hasRealText;
  };
  const collectOzonRichContentPagePaths = (states, currentPath) => {
    const out = [];
    const seenPaths = new Set();
    const seenObjects = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    const currentProductKey = ozonProductPathKey(currentPath);
    const currentProductId = ozonProductId(currentPath);
    const push = (candidate) => {
      const pagePath = normalizeOzonProductInnerPath(candidate);
      if (!pagePath || !/[?&]layout_container=pdpPage2column(?:&|$)/.test(pagePath)) return;
      const productKey = ozonProductPathKey(pagePath);
      const productId = ozonProductId(pagePath);
      if (currentProductId && productId && currentProductId !== productId) return;
      if ((!currentProductId || !productId) && currentProductKey && productKey && productKey !== currentProductKey) return;
      if (seenPaths.has(pagePath)) return;
      seenPaths.add(pagePath);
      out.push(pagePath);
    };
    const walk = (node, depth) => {
      if (node == null || depth > 18) return;
      const parsed = parseMaybeJson(node);
      if (!parsed || typeof parsed !== 'object') return;
      if (seenObjects) {
        if (seenObjects.has(parsed)) return;
        seenObjects.add(parsed);
      }
      if (typeof parsed.nextPage === 'string') push(parsed.nextPage);
      if (Array.isArray(parsed)) {
        for (const item of parsed) walk(item, depth + 1);
        return;
      }
      for (const key of Object.keys(parsed)) walk(parsed[key], depth + 1);
    };
    walk(states, 0);
    return out;
  };
  const extractMp4 = (states) => {
    const helper = globalThis.JZOzonVideoExtract;
    if (helper && typeof helper.extractOzonMp4FromSources === 'function') {
      const found = helper.extractOzonMp4FromSources(Object.values(states || {}));
      if (found) return found;
    }
    for (const k of Object.keys(states || {})) {
      if (!/gallery/i.test(k)) continue;
      let v = states[k];
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          continue;
        }
      }
      const vids = v && Array.isArray(v.videos) ? v.videos : [];
      for (const it of vids) {
        const raw = typeof it === 'string' ? it : (it && (it.url || it.src)) || '';
        if (raw && /\.mp4(\?|#|$)/i.test(raw)) return raw;
      }
    }
    return null;
  };
  // 源描述(4191):复用注入的 JZFollowSellContentCopy.extractDescriptionText
  const extractDescription = (states) => {
    const helper = globalThis.JZFollowSellContentCopy;
    if (!helper || typeof helper.extractDescriptionText !== 'function') return { text: '', sourceKey: '' };
    const keys = Object.keys(states || {});
    const descKeys = keys.filter((k) => /description/i.test(k));
    for (const k of descKeys) {
      let v = states[k];
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          /* 当字符串直接抽 */
        }
      }
      const text = helper.extractDescriptionText(v, 4096);
      if (text) return { text, sourceKey: k };
    }
    return { text: '', sourceKey: '' };
  };
  // 源主题标签(23171):递归捞 # 前缀串,去重 + 上限 30
  const extractHashtags = (states) => {
    const out = [];
    const seen = new Set();
    const push = (s) => {
      const t = String(s == null ? '' : s).trim();
      if (!t || t.length < 2 || !t.startsWith('#')) return;
      const key = t.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      if (out.length < 30) out.push(t);
    };
    const walk = (node, depth) => {
      if (out.length >= 30 || depth > 32 || node == null) return;
      if (typeof node === 'string') {
        push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const it of node) walk(it, depth + 1);
        return;
      }
      if (typeof node === 'object') {
        for (const k of Object.keys(node)) walk(node[k], depth + 1);
      }
    };
    for (const k of Object.keys(states || {})) {
      if (!/hashtag|taglist/i.test(k)) continue;
      let v = states[k];
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          continue;
        }
      }
      walk(v, 0);
    }
    return out;
  };
  let anyOk = false;
  let hitEndpoint = null;
  let richContent = '';
  let richContentHasText = false;
  let mp4 = null;
  let description = '';
  let descriptionSource = '';
  let hashtags = [];
  const composerWidgetStates = {};
  const failReasons = [];
  const hitEndpoints = [];
  // 端点耗时埋点:每个 endpoint fetch 单独计时(epName → Node 侧 code 映射上报)
  const __timings = [];
  for (let endpointIndex = 0; endpointIndex < endpointQueue.length; endpointIndex += 1) {
    const url = endpointQueue[endpointIndex];
    const epName = url.includes('entrypoint-api') ? 'entrypoint' : 'composer';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const __t0 = performance.now();
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      __timings.push({
        epName,
        startedAt: new Date(Date.now() - (performance.now() - __t0)).toISOString(),
        durationMs: Math.round(performance.now() - __t0),
        status: resp.status,
        ok: resp.ok,
      });
      if (!resp.ok) {
        failReasons.push(`${epName}:HTTP_${resp.status}`);
        continue;
      }
      anyOk = true;
      const epFullName = url.includes('entrypoint-api') ? 'entrypoint-api' : 'composer-api';
      if (!hitEndpoints.includes(epFullName)) hitEndpoints.push(epFullName);
      if (!hitEndpoint) hitEndpoint = epFullName;
      const data = await resp.json();
      const states = data && data.widgetStates ? data.widgetStates : {};
      for (const nextPage of collectOzonRichContentPagePaths(states, relPath)) enqueuePath(nextPage);
      const candidateRichContent = extractRich(states);
      if (candidateRichContent) {
        const candidateHasText = hasRichContentText(candidateRichContent);
        if (!richContent || (!richContentHasText && candidateHasText)) {
          richContent = candidateRichContent;
          richContentHasText = candidateHasText;
        }
      }
      if (!mp4) mp4 = extractMp4(states);
      if (!description) {
        const descResult = extractDescription(states);
        if (descResult.text) {
          description = descResult.text;
          descriptionSource = `page-json:${descResult.sourceKey}`;
        }
      }
      if (!hashtags.length) hashtags = extractHashtags(states);
      for (const k of Object.keys(states)) composerWidgetStates[k] = states[k];
      if (mp4 && richContent && (richContentHasText || endpointIndex + 1 >= endpointQueue.length)) break;
    } catch (e) {
      clearTimeout(timer);
      __timings.push({
        epName,
        startedAt: new Date(Date.now() - (performance.now() - __t0)).toISOString(),
        durationMs: Math.round(performance.now() - __t0),
        status: null,
        ok: false,
        reason: e?.name === 'AbortError' ? 'TIMEOUT' : 'NET_' + String(e?.message || 'error').slice(0, 40),
      });
      const reason =
        e?.name === 'AbortError' ? `${epName}:TIMEOUT` : `${epName}:NET_${(e?.message || 'error').slice(0, 60)}`;
      failReasons.push(reason);
    }
  }

  // ── fields 提取 + widgetStates 过滤(插件 SW 侧逻辑提前到页内,减小返回载荷) ──
  let fields = null;
  let filteredStates = {};
  if (anyOk && composerWidgetStates) {
    const ws = composerWidgetStates;
    const keys = Object.keys(ws);
    const find = (prefix) => keys.find((k) => k.startsWith(prefix));
    const parse = (key) => {
      if (!key) return null;
      const raw = ws[key];
      if (typeof raw === 'object' && raw !== null) return raw;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    const gallery = parse(find('webGallery'));
    const heading = parse(find('webProductHeading'));
    const aspects = parse(find('webAspects'));
    const price = parse(find('webPrice'));
    const seller = parse(find('webCurrentSeller'));
    const shortChars = parse(find('webShortCharacteristics'));
    const detailSku = parse(find('webDetailSKU'));
    const brand = parse(find('webBrand'));
    const images = Array.isArray(gallery?.images)
      ? gallery.images
        .map((it) => (typeof it === 'string' ? it : it?.url || it?.link || it?.src))
        .filter(Boolean)
      : [];
    const coverImage =
      typeof gallery?.coverImage === 'string'
        ? gallery.coverImage
        : gallery?.coverImage?.url || gallery?.coverImage?.link || images[0] || '';
    let sellerName = '';
    let sellerLink = '';
    try {
      sellerName =
        seller?.header?.title?.text ||
        seller?.sellerCell?.centerBlock?.title?.text ||
        seller?.sellerCell?.name ||
        seller?.name ||
        '';
      sellerLink =
        seller?.header?.title?.link ||
        seller?.sellerCell?.centerBlock?.title?.link ||
        seller?.sellerCell?.link ||
        seller?.link ||
        '';
    } catch { /* seller 解析失败置空 */ }
    fields = {
      title: heading?.title || '',
      sku: '',
      productId: String(gallery?.sku || detailSku?.sku || detailSku?.itemId || ''),
      price: price?.cardPrice || price?.price || price?.originalPrice || '',
      images,
      coverImage,
      aspects: Array.isArray(aspects?.aspects) ? aspects.aspects : [],
      seller: { name: sellerName, link: sellerLink },
      brand: brand?.title || brand?.name || '',
      shortCharacteristicsRaw: shortChars || null,
    };
    const usefulPrefixes = [
      'webGallery', 'webProductHeading', 'webAspects', 'webPrice', 'webAddToCart',
      'webCurrentSeller', 'webBrand', 'webDetailSKU', 'webShortCharacteristics',
      'webCharacteristics', 'webDescription', 'webMarketingLabels', 'webSale',
      'webReviewProductScore', 'webSingleProductScore', 'webModelParams', 'webHashtags',
      'webBestSeller', 'webProductMainWidget',
    ];
    for (const k of keys) {
      if (usefulPrefixes.some((p) => k.startsWith(p))) filteredStates[k] = ws[k];
    }
  }

  return anyOk
    ? {
        ok: true,
        anyOk: true,
        mp4,
        richContent,
        richContentHasText,
        description,
        descriptionSource,
        hashtags,
        endpoint: hitEndpoint,
        hitEndpoints,
        fields,
        filteredStates,
        __timings,
      }
    : {
        ok: false,
        anyOk: false,
        error: 'all endpoints failed',
        failReasons: failReasons.length ? failReasons.join('|') : 'NO_REQUEST_ATTEMPTED',
        __timings,
      };
};

// ── 注入函数:跟卖 modal 抓取(移植 collect-tab.js fetchFollowSellModal L911-992) ──
const FOLLOW_SELL_MODAL_FN = async (p) => {
  // 注:cloakbrowser evaluate 仅支持单参数,sku/timeout 合并对象传递
  const fsSku = p?.sku;
  const timeout = p?.timeout || 15000;
  if (!fsSku) {
    return { ok: false, followSellData: null, errorReason: 'NO_SKU' };
  }
  const fsController = new AbortController();
  const fsTimer = setTimeout(() => fsController.abort(), timeout);
  // 端点耗时埋点(www.composer.offers-modal)
  const fsT0 = performance.now();
  const fsTiming = () => ({
    startedAt: new Date(Date.now() - (performance.now() - fsT0)).toISOString(),
    durationMs: Math.round(performance.now() - fsT0),
  });
  try {
    const inner = `/modal/otherOffersFromSellers?product_id=${fsSku}`;
    const fsUrl = `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(inner)}`;
    const fsResp = await fetch(fsUrl, {
      credentials: 'include',
      headers: {
        'x-o3-app-name': 'dweb_client',
        'x-o3-language': 'ru',
        accept: 'application/json',
      },
      signal: fsController.signal,
    });
    clearTimeout(fsTimer);
    if (!fsResp.ok) {
      return { ok: false, followSellData: null, errorReason: 'HTTP_' + fsResp.status, status: fsResp.status, __timing: fsTiming() };
    }
    const fsData = await fsResp.json();
    const fsStates = fsData && fsData.widgetStates ? fsData.widgetStates : {};
    const wslKey = Object.keys(fsStates).find((k) => k.startsWith('webSellerList'));
    if (!wslKey) {
      return { ok: true, followSellData: { count: 0, sellers: [], source: 'no-sellers' }, status: fsResp.status, __timing: fsTiming() };
    }
    let wsl = fsStates[wslKey];
    if (typeof wsl === 'string') {
      try {
        wsl = JSON.parse(wsl);
      } catch {
        return { ok: true, followSellData: { count: 0, sellers: [], source: 'parse-fail' }, status: fsResp.status, __timing: fsTiming() };
      }
    }
    const rawSellers = Array.isArray(wsl?.sellers) ? wsl.sellers : [];
    const normSeller = (item) => {
      if (!item || typeof item !== 'object') return null;
      const txt = (v) =>
        typeof v === 'string' ? v.trim() : v && typeof v === 'object' && v.text ? String(v.text).trim() : '';
      const str = (v) => (typeof v === 'string' ? v : '');
      const name = txt(item.name) || txt(item.sellerName) || txt(item.seller?.name) || txt(item.title) || '';
      const priceRaw = item.price?.cardPrice?.price ?? item.price?.cardPrice ?? item.price ?? item.finalPrice ?? '';
      const price = txt(priceRaw);
      if (!name && !price) return null;
      return {
        sku: txt(item.sku) || txt(item.skuId) || '',
        id: txt(item.id) || txt(item.sellerId) || '',
        name,
        link: str(item.link),
        credentials: Array.isArray(item.credentials) ? item.credentials.map(String) : [],
        logoImageUrl: str(item.logoImageUrl) || (item.logo?.url ? str(item.logo.url) : ''),
        advantages: Array.isArray(item.advantages) ? item.advantages : [],
        subtitle: txt(item.subtitle),
        price: item.price || null,
        coverImage: str(item.coverImage),
        productLink: str(item.productLink),
      };
    };
    const sellers = rawSellers.map(normSeller).filter(Boolean);
    return { ok: true, followSellData: { count: rawSellers.length, sellers, source: 'modal' }, status: fsResp.status, __timing: fsTiming() };
  } catch (e) {
    clearTimeout(fsTimer);
    const reason = e?.name === 'AbortError' ? 'TIMEOUT' : 'NET_' + (e?.message || 'error').slice(0, 60);
    return { ok: false, followSellData: null, errorReason: reason, __timing: fsTiming() };
  }
};

// ── 注入函数:jsonLd 提取(detail 兜底数据源) ──────────────────
const JSONLD_EXTRACT_FN = () => {
  try {
    const nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (const n of nodes) {
      let data;
      try {
        data = JSON.parse(n.textContent);
      } catch {
        continue;
      }
      const arr = Array.isArray(data) ? data : [data];
      for (const item of arr) {
        if (item && item['@type'] === 'Product') return { ok: true, data: item };
      }
    }
    return { ok: false, data: null };
  } catch {
    return { ok: false, data: null };
  }
};

// ── detail 构建(Node 侧,widgetStates 为主 + jsonLd 兜底) ─────
// 设计 §4.2:19 字段;widgetStates 即 Step5 richMedia 已获取响应(零增量请求)
function parsePriceNum(p) {
  if (p == null) return null;
  const tryStr = (s) => {
    if (typeof s !== 'string') return null;
    const m = s.replace(/\s/g, '').replace(',', '.').match(/[\d.]+/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  if (typeof p === 'number') return Number.isFinite(p) ? p : null;
  if (typeof p === 'string') return tryStr(p);
  if (typeof p === 'object') {
    // price 对象常见形态:{ cardPrice: { price: '1 234 ₽' } } / { text: '...' } / { price: '...' }
    for (const c of [p.cardPrice?.price ?? p.cardPrice, p.price, p.finalPrice, p.text, p]) {
      if (typeof c === 'number' && Number.isFinite(c)) return c;
      if (typeof c === 'string') {
        const n = tryStr(c);
        if (n != null) return n;
      }
      if (c && typeof c === 'object' && typeof c.text === 'string') {
        const n = tryStr(c.text);
        if (n != null) return n;
      }
    }
  }
  return null;
}

function buildDetailData(filteredStates, jsonLd, fsData, mp4, sku, description = '', descriptionSource = '') {
  const ws = filteredStates && typeof filteredStates === 'object' ? filteredStates : {};
  const keys = Object.keys(ws);
  const find = (prefix) => keys.find((k) => k.startsWith(prefix));
  const parse = (key) => {
    if (!key) return null;
    const raw = ws[key];
    if (typeof raw === 'object' && raw !== null) return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const gallery = parse(find('webGallery'));
  const heading = parse(find('webProductHeading'));
  const price = parse(find('webPrice'));
  const seller = parse(find('webCurrentSeller'));
  const brand = parse(find('webBrand'));
  const chars = parse(find('webCharacteristics')) || parse(find('webShortCharacteristics'));
  const reviewScore = parse(find('webReviewProductScore'));
  const detailSku = parse(find('webDetailSKU'));
  const ld = jsonLd && typeof jsonLd === 'object' ? jsonLd : {};

  let sellerName = '';
  let sellerLink = '';
  try {
    sellerName =
      seller?.header?.title?.text ||
      seller?.sellerCell?.centerBlock?.title?.text ||
      seller?.sellerCell?.name ||
      seller?.name ||
      '';
    sellerLink =
      seller?.header?.title?.link ||
      seller?.sellerCell?.centerBlock?.title?.link ||
      seller?.sellerCell?.link ||
      seller?.link ||
      '';
  } catch { /* 置空 */ }

  const images = Array.isArray(gallery?.images)
    ? gallery.images.map((it) => (typeof it === 'string' ? it : it?.url || it?.link || it?.src)).filter(Boolean)
    : Array.isArray(ld.image) ? ld.image.filter(Boolean) : [];

  let followSellMinPrice = null;
  if (Array.isArray(fsData?.sellers) && fsData.sellers.length) {
    const nums = fsData.sellers.map((s) => parsePriceNum(s?.price)).filter((v) => v != null);
    if (nums.length) followSellMinPrice = Math.min(...nums);
  }

  return {
    title: heading?.title || ld.name || '',
    images,
    videos: mp4 ? [mp4] : [],
    sku: String(sku),
    productId: String(gallery?.sku || detailSku?.sku || detailSku?.itemId || sku || ''),
    brand: brand?.title || brand?.name || ld.brand?.name || '',
    category: ld.category || '',
    characteristics: chars || null,
    price: price?.cardPrice || price?.price || ld.offers?.price || '',
    walletPrice: price?.ozonCardPrice ?? price?.walletPrice ?? null,
    originalPrice: price?.originalPrice ?? null,
    seller: { name: sellerName, link: sellerLink },
    statistics: reviewScore || (ld.aggregateRating ? { aggregateRating: ld.aggregateRating } : null),
    freeRest: null,
    followSellCount: fsData?.count ?? null,
    followSellMinPrice,
    deliveryMode: '',
    rating: reviewScore?.score ?? ld.aggregateRating?.ratingValue ?? null,
    reviewCount: reviewScore?.reviewCount ?? ld.aggregateRating?.reviewCount ?? null,
    // 描述(对齐插件 detail 字段):page-json 提取优先,jsonLd 纯文本兜底;
    // ERP 合成时 detailData.description 是 bundle attr 4191 之后的兜底来源
    description: description || (typeof ld.description === 'string' ? ld.description : ''),
    descriptionSource: descriptionSource || (description ? '' : typeof ld.description === 'string' ? 'json-ld' : ''),
  };
}

// ── 关键数据日志(LOG_DATA=0 关闭;每类采集数据一行核心指标) ──
// 输出形如:      ├─ marketStats(真采): 销量=1.2w GMV=340w 均价=289 库存=8901 ...
function fmtNum(v) {
  if (v == null || v === '') return '-';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + 'w';
  return String(Math.round(n * 100) / 100);
}
function fmtStr(s, max) {
  const t = String(s ?? '').trim();
  if (!t) return '-';
  return t.length > max ? t.slice(0, max) + '…' : t;
}
function logDataLine(tag, summary) {
  if (cfg.logData) console.log(`      ├─ ${tag}: ${summary}`);
}
// marketStats:销量/GMV/均价/库存/浏览/转化/DRR(市场规模判断核心)
function summarizeMarketStats(d) {
  if (!d) return '无数据';
  if (d.__empty) return '__empty(接口无销量数据)';
  const pct = (v) => (v == null ? '-' : `${v}%`);
  return (
    `销量=${fmtNum(d.soldCount)} GMV=${fmtNum(d.gmvSum)} 均价=${fmtNum(d.avgPrice)} 库存=${fmtNum(d.stock)}` +
    ` 浏览=${fmtNum(d.views)} 加购率=${pct(d.convToCartPdp ?? d.pdpToCartConversion)} DRR=${pct(d.drr)}`
  );
}
// ── 类目/类型中文名(ERP 类目树批量查询,进程内缓存;失败/未命中降级显示 ID) ──
const catNameById = new Map(); // descriptionCategoryId -> 中文名('' = 已查无)
const typeNameById = new Map(); // typeId -> 中文名('' = 已查无)
async function ensureCategoryNames(descCatIds = [], typeIds = []) {
  const dc = [...new Set(descCatIds.map(Number).filter((v) => Number.isFinite(v) && v > 0 && !catNameById.has(v)))];
  const ti = [...new Set(typeIds.map(Number).filter((v) => Number.isFinite(v) && v > 0 && !typeNameById.has(v)))];
  if (dc.length === 0 && ti.length === 0) return;
  try {
    const r = await erp.getCategoryNames({ descCatIds: dc, typeIds: ti });
    for (const it of r?.data?.items || []) catNameById.set(Number(it.descriptionCategoryId), it.categoryName || '');
    for (const it of r?.data?.typeItems || []) typeNameById.set(Number(it.typeId), it.typeName || '');
    // 未命中的标记为 ''(进程内不再重复查询)
    for (const id of dc) if (!catNameById.has(id)) catNameById.set(id, '');
    for (const id of ti) if (!typeNameById.has(id)) typeNameById.set(id, '');
  } catch { /* ERP 异常:降级显示 ID,下次再查 */ }
}
// 名(ID) 标签;无名只显示 ID
function labelWithId(name, id) {
  const n = String(name || '').trim();
  return n ? `${fmtStr(n, 24)}(${id})` : String(id);
}
// search/bundle 摘要所需的类目/类型 ID 集合(用于批量查中文名)
function displayCatIds(searchVariant, bundleData) {
  const descCatIds = [];
  const typeIds = [];
  const cat =
    searchVariant && Array.isArray(searchVariant.categories)
      ? searchVariant.categories.find((c) => Number(c.level) === 3)
      : null;
  if (cat) descCatIds.push(Number(cat.id));
  const ti = Number(searchVariant?.description_type_dict_value);
  if (Number.isFinite(ti) && ti > 0) typeIds.push(ti);
  const bDci = Number(bundleData?.description_category_id);
  if (Number.isFinite(bDci) && bDci > 0) descCatIds.push(bDci);
  return { descCatIds, typeIds };
}

// search:三级类目名/ID + 类型名/ID(类目过滤与变体定位核心)
function summarizeSearch(v) {
  if (!v) return '无数据';
  const cat = Array.isArray(v.categories) ? v.categories.find((c) => Number(c.level) === 3) : null;
  const catLabel = cat ? labelWithId(catNameById.get(Number(cat.id)) || cat.name, cat.id) : '-';
  const ti = Number(v.description_type_dict_value);
  const typeLabel =
    Number.isFinite(ti) && ti > 0 ? labelWithId(v.description_type_name || typeNameById.get(ti), ti) : '-';
  return `类目=${catLabel} 类型=${typeLabel}`;
}
// bundle:属性数/重量/尺寸/类目/类型(超轻小件判定与上架属性核心)
// 类型取自 search variant(bundle 接口不返回 type_id);类目用 bundle 自身 description_category_id
function summarizeBundle(b, sv) {
  if (!b) return '无数据';
  const attrs = Array.isArray(b.attributes) ? b.attributes.length : 0;
  const dim = [b.depth, b.width, b.height].map((x) => fmtNum(x)).join('×');
  const cat = labelWithId(catNameById.get(Number(b.description_category_id)), b.description_category_id);
  const ti = Number(sv?.description_type_dict_value);
  const type = Number.isFinite(ti) && ti > 0 ? labelWithId(sv.description_type_name || typeNameById.get(ti), ti) : '-';
  return `属性=${attrs}个 重量=${fmtNum(b.weight)}g 尺寸=${dim}mm 类目=${cat} 类型=${type}`;
}
// richMedia:视频/富文本/描述/标签/图片(跟卖素材核心)
function summarizeRichMedia(d) {
  if (!d) return '无数据';
  return (
    `视频=${d.mp4 ? '✓' : '✗'} 富文本=${d.richContentHasText ? '有' : '无'}(${(d.richContent || '').length}字)` +
    ` 描述=${fmtStr(d.descriptionSource || '-', 18)}:${(d.description || '').length}字` +
    ` 标签=${Array.isArray(d.hashtags) ? d.hashtags.length : 0} 图=${Array.isArray(d.gallery) ? d.gallery.length : 0}张`
  );
}
// followSell:跟卖卖家数/最低价(竞争强度核心)
function summarizeFollowSell(d) {
  if (!d) return '无数据';
  const sellers = Array.isArray(d.sellers) ? d.sellers : [];
  const nums = sellers.map((s) => parsePriceNum(s?.price)).filter((v) => v != null);
  const min = nums.length ? Math.min(...nums) : null;
  return `卖家数=${d.count ?? sellers.length}家 最低价=${min != null ? fmtNum(min) : '-'}`;
}
// detail:标题/品牌/价格/评分/图片/描述(商品身份核心)
function summarizeDetail(d) {
  if (!d) return '无数据';
  return (
    `标题=${fmtStr(d.title, 40)} 品牌=${fmtStr(d.brand, 15)}` +
    ` 价格=${fmtStr(d.price, 14)} 评分=${d.rating ?? '-'}(${fmtNum(d.reviewCount)}评)` +
    ` 图=${Array.isArray(d.images) ? d.images.length : 0}张 跟卖最低=${fmtNum(d.followSellMinPrice)}` +
    ` 描述=${fmtStr(d.descriptionSource || '-', 18)}:${(d.description || '').length}字`
  );
}
// card:浅采写入的 dom 卡片(标题/价格/评分)
function summarizeCard(c) {
  if (!c) return '无数据';
  return `标题=${fmtStr(c.name || c.title, 40)} 价格=${fmtNum(c.price)} 评分=${fmtStr(c.rating, 6)}(${fmtNum(c.ratingCount)}评)`;
}

// ── 浏览器管理 ───────────────────────────────────────────────
let browser = null;
let sellerPage = null;
let buyerPage = null;

function isChallengeTitle(title) {
  return /just a moment|attention required|are you a robot|enable javascript|captcha|доступ ограничен/i.test(
    String(title || '')
  );
}

async function launchBrowser() {
  browser = await launchPersistentContext({
    userDataDir: cfg.profileDir,
    headless: cfg.headless,
  });
  // 标签页清理:关闭会话恢复的多余残留页(后台加载占内存且可能触发反爬),
  // 但保留第 1 个复用为 sellerPage(全部关闭会导致上下文退出,后续 newPage 报
  // Protocol error (Target.createTarget): Failed to open a new tab)
  const restored = (() => {
    try { return browser.pages(); } catch { return []; }
  })();
  for (const p of restored.slice(1)) await p.close().catch(() => {});
  if (restored.length > 1) {
    console.log(`[启动] 已关闭 ${restored.length - 1} 个残留标签页,复用第 1 个为 sellerPage`);
  }
  sellerPage = restored[0] || (await browser.newPage());
  buyerPage = await browser.newPage();
}

// warmup(启动 + 熔断/鉴权恢复共用):双页就绪 + 登录态探测
async function warmup() {
  // 1. buyerPage:过反爬挑战 + 建立/刷新 cookie
  await buyerPage.goto('https://www.ozon.ru/', {
    waitUntil: 'domcontentloaded',
    timeout: cfg.pageGotoTimeoutMs,
  });
  await buyerPage.waitForTimeout(3000);
  let title = await buyerPage.title().catch(() => '');
  if (isChallengeTitle(title)) {
    console.warn(`[warmup] 买家页命中挑战("${String(title).slice(0, 40)}"),等 ${cfg.challengeWaitMs}ms 重试`);
    await sleep(cfg.challengeWaitMs);
    await buyerPage.goto('https://www.ozon.ru/', {
      waitUntil: 'domcontentloaded',
      timeout: cfg.pageGotoTimeoutMs,
    });
    await buyerPage.waitForTimeout(3000);
    title = await buyerPage.title().catch(() => '');
    if (isChallengeTitle(title)) throw new Error('ANTIBOT: challenge persists');
  }
  // 2. sellerPage:确认登录态(sc_company_id)
  await sellerPage.goto('https://seller.ozon.ru/app/', {
    waitUntil: 'domcontentloaded',
    timeout: cfg.pageGotoTimeoutMs,
  });
  const companyId = await sellerPage.evaluate(() => {
    const m = document.cookie.match(/(?:^|;\s*)sc_company_id=([^;]+)/);
    return m ? m[1] : '';
  });
  if (!companyId) throw new Error('AUTH_REQUIRED: no sc_company_id');
  return companyId;
}

// sellerPage 保活:门户调用前确认页面仍在 seller 域(崩溃/被导航走时重开)
async function ensureSellerPage() {
  const url = sellerPage.url();
  if (!url.startsWith('https://seller.ozon.ru')) {
    console.warn(`[sellerPage] 页面异常(${url}),重新导航`);
    await sellerPage
      .goto('https://seller.ozon.ru/app/', { waitUntil: 'domcontentloaded', timeout: cfg.pageGotoTimeoutMs })
      .catch(() => { /* 导航失败由后续 PORTAL_FETCH 的 NO_COMPANY_ID/NET 兜底 */ });
  }
}

// ── 门户调用(Node 侧包装:请求构造 + 错误分类) ────────────────
// 返回 { ok, data } | { auth: true } | { antibot: true } | { transient: true, reason }
async function portalFetch(kind, sku, variantId) {
  let p;
  if (kind === 'marketStats') {
    p = {
      path: '/api/site/seller-analytics/what_to_sell/data/v3',
      method: 'POST',
      body: {
        filter: { stock: 'any_stock', period: 'monthly', sku: String(sku) },
        sort: { key: 'sum_gmv_desc' },
        limit: '1',
        offset: '0',
      },
      needCompanyId: 'header',
      timeoutMs: cfg.portalFetchTimeoutMs,
    };
  } else if (kind === 'search') {
    p = {
      path: '/api/v1/search',
      method: 'POST',
      body: {
        need_total: true,
        filter: {
          children_nodes: {
            children_nodes: [{ input_leaf: { sku: { values: [String(sku)] } } }],
            operator: 'AND',
          },
        },
        pagination: { limit: '50' },
        is_copy_allowed: false,
      },
      needCompanyId: 'body',
      timeoutMs: 30000,
    };
  } else {
    p = {
      path: '/api/site/seller-prototype/create-bundle-by-variant-id',
      method: 'POST',
      body: {
        variant_id: String(variantId),
        source: 'SOURCE_UI_COPY_APPAREL',
      },
      needCompanyId: 'body',
      timeoutMs: 30000,
    };
  }
  let r;
  try {
    r = await sellerPage.evaluate(PORTAL_FETCH_FN, p);
  } catch (e) {
    return { transient: true, reason: 'EVAL_EXC:' + String(e?.message || e).slice(0, 60) };
  }
  // 端点耗时上报(kind → code:marketStats=seller.analytics.v3 / search=seller.search / bundle=seller.create-bundle)
  const kindCode = { marketStats: 'seller.analytics.v3', search: 'seller.search', bundle: 'seller.create-bundle' }[kind];
  if (kindCode && r?.__timing) {
    addMetric({
      endpoint: kindCode,
      method: 'POST',
      sku,
      durationMs: r.__timing.durationMs,
      ts: r.__timing.startedAt,
      statusCode: r.status ?? null,
      ok: r.ok === true,
      errorKind: r.ok === true ? null : String(r.reason || '').slice(0, 40),
    });
  }
  if (r?.ok) return { ok: true, data: r.data };
  const reason = String(r?.reason || 'UNKNOWN');
  if (reason === 'NO_COMPANY_ID' || reason === 'AUTH_REQUIRED' || reason === 'HTTP_401') {
    return { auth: true, reason: 'AUTH_REQUIRED' };
  }
  if (reason === 'HTTP_403' || reason === 'HTTP_429') return { antibot: true, reason };
  return { transient: true, reason };
}

// ── 编排:doAutoCollect(对齐插件 _doAutoCollect 七类结果) ─────
// 返回:{ status: 'success'|'partial'|'skipped', reason?, error?, signal?, results, totalDuration }
function emptyResults() {
  return [
    { type: 'card', hit: false },
    { type: 'detail', hit: false },
    { type: 'richMedia', hit: false },
    { type: 'search', hit: false },
    { type: 'bundle', hit: false },
    { type: 'marketStats', hit: false },
    { type: 'followSell', hit: false },
  ];
}

async function doAutoCollect(task, filterMap) {
  const t0 = Date.now();
  const sku = String(task.sku);
  const forceRefresh = !!task.forceRefresh;
  const results = emptyResults();
  const byType = Object.fromEntries(results.map((r) => [r.type, r]));

  const partial = (reason, error, signal) => ({
    status: 'partial', reason, ...(error ? { error } : {}), ...(signal ? { signal } : {}),
    results, totalDuration: Date.now() - t0,
  });
  const skipped = (reason) => ({ status: 'skipped', reason, results, totalDuration: Date.now() - t0 });

  try {
    // ── Step 1:缓存查询(5 类并行;单类失败视为未命中,对齐插件 warn+continue) ──
    const [domR, attrR, richR, msR, fsR] = await Promise.all([
      erp.getDomCache(sku).catch(() => null),
      erp.getAttributeCache(sku).catch(() => null),
      erp.getRichMediaCache(sku).catch(() => null),
      erp.getMarketStatsCache(sku).catch(() => null),
      erp.getFollowSellCache(sku).catch(() => null),
    ]);
    // 缓存存在即命中(HTTP 200 即写,包括空内容;插件口径:marketStats/followSell/richMedia 永久不 stale)
    byType.card.hit = !!domR?.card && !forceRefresh;
    byType.detail.hit = !!domR?.detail && !forceRefresh;
    byType.richMedia.hit = !!richR?.data && !forceRefresh;
    byType.marketStats.hit = !!msR?.data && !forceRefresh;
    byType.followSell.hit = !!fsR?.data && !forceRefresh;
    const searchItems = Array.isArray(attrR?.searchData?.items) ? attrR.searchData.items : [];
    byType.search.hit = searchItems.length > 0 && !forceRefresh;
    byType.bundle.hit = !forceRefresh && bundleUsable(attrR);

    // 关键数据日志:缓存命中的部分(真采部分在各自采集点输出)
    if (cfg.logData) {
      // search/bundle 摘要需显示类目/类型中文名:先批量查 ERP 类目树(命中缓存则零请求)
      if (byType.search.hit || byType.bundle.hit) {
        const ids = displayCatIds(byType.search.hit ? searchItems[0] : null, byType.bundle.hit ? attrR?.bundleData : null);
        await ensureCategoryNames(ids.descCatIds, ids.typeIds);
      }
      if (domR?.card) logDataLine('card(缓存)', summarizeCard(domR.card));
      if (domR?.detail) logDataLine('detail(缓存)', summarizeDetail(domR.detail));
      if (richR?.data) logDataLine('richMedia(缓存)', summarizeRichMedia(richR.data));
      if (msR?.data && byType.marketStats.hit) logDataLine('marketStats(缓存)', summarizeMarketStats(msR.data));
      if (fsR?.data) logDataLine('followSell(缓存)', summarizeFollowSell(fsR.data));
      if (byType.search.hit) logDataLine(`search(缓存,${searchItems.length}变体)`, summarizeSearch(searchItems[0]));
      if (byType.bundle.hit) logDataLine('bundle(缓存)', summarizeBundle(attrR?.bundleData, byType.search.hit ? searchItems[0] : null));
    }

    // ── Step 3:marketStats 真调(门控A前置) ──
    let marketStatsData = byType.marketStats.hit ? msR.data : null;
    if (!byType.marketStats.hit) {
      await ensureSellerPage();
      const ms = await portalFetch('marketStats', sku);
      if (ms.auth) return partial('market-stats-failed', 'AUTH_REQUIRED', 'AUTH_REQUIRED');
      if (ms.antibot) return partial('market-stats-failed', 'ANTIBOT', 'ANTIBOT');
      if (ms.transient) {
        byType.marketStats.error = ms.reason;
      } else {
        // HTTP 200 即写缓存:有数据 → 归一化;无数据 → __empty 空标记(避免重复真调)
        const raw = ms.data?.items?.[0] || ms.data?.data?.[0] || null;
        marketStatsData = raw ? normalizeMarketItem(raw) : { __empty: true };
        if (!cfg.dryRun) await erp.setMarketStatsCache(sku, marketStatsData);
        byType.marketStats.hit = true;
        logDataLine('marketStats(真采)', summarizeMarketStats(marketStatsData));
      }
    }

    // 门控A:失败 → partial 回 pending 重试;无数据(__empty) → skipped 终态
    if (cfg.enableMarketStatsGate) {
      if (byType.marketStats.error) return partial('market-stats-failed', byType.marketStats.error);
      if (!marketStatsData || marketStatsData.__empty) return skipped('no-market-stats');
    }

    // ── Step 4:search + bundle(门控B/C前置) ──
    let searchVariant = byType.search.hit ? searchItems[0] : null;
    let bundleDataRef = byType.bundle.hit ? attrR?.bundleData : null;

    if (!byType.search.hit) {
      const se = await portalFetch('search', sku);
      if (se.auth) return partial('search-failed', 'AUTH_REQUIRED', 'AUTH_REQUIRED');
      if (se.antibot) return partial('search-failed', 'ANTIBOT', 'ANTIBOT');
      if (se.transient) {
        byType.search.error = se.reason;
      } else {
        const rawVariants = Array.isArray(se.data?.variants)
          ? se.data.variants
          : Array.isArray(se.data?.items)
            ? se.data.items
            : Array.isArray(se.data?.products)
              ? se.data.products
              : [];
        if (rawVariants.length > 0) {
          // 方案B:search 缓存只存原始 variants 数组,读取端按需合成 sv shape
          if (!cfg.dryRun) await erp.setAttributeCache(sku, 'search', { items: rawVariants });
          searchVariant = rawVariants[0];
          byType.search.hit = true;
          const ids = displayCatIds(searchVariant, null);
          await ensureCategoryNames(ids.descCatIds, ids.typeIds);
          logDataLine(`search(真采,${rawVariants.length}变体)`, summarizeSearch(searchVariant));
        }
        // HTTP 200 但无 variants(永久性):不标 error → 门控B no-search-data
      }
    }

    // bundle 补采:search 已获取(hit 或缓存)但 bundle 未获取/不可用 → 单独真调
    // (保证 partial 重试时能只补 bundle,无需重采 search)
    if (byType.search.hit && !byType.bundle.hit) {
      const variantId = searchVariant?.variant_id;
      if (variantId) {
        const bu = await portalFetch('bundle', sku, variantId);
        if (bu.auth) return partial('bundle-failed', 'AUTH_REQUIRED', 'AUTH_REQUIRED');
        if (bu.antibot) return partial('bundle-failed', 'ANTIBOT', 'ANTIBOT');
        if (bu.transient) {
          byType.bundle.error = bu.reason;
        } else {
          const item = bu.data?.item || null;
          if (item) {
            // 空属性时 ERP DAO 附 attrs_empty_verified_at(6h 重验语义)
            if (!cfg.dryRun) await erp.setAttributeCache(sku, 'bundle', item, bu.data?.bundle_id || null);
            bundleDataRef = item;
            byType.bundle.hit = true;
            const ids = displayCatIds(searchVariant, item);
            await ensureCategoryNames(ids.descCatIds, ids.typeIds);
            logDataLine('bundle(真采)', summarizeBundle(bundleDataRef, searchVariant));
          }
          // item 为 null(HTTP 200 无数据,永久性):不标 error → 门控C non-ultra-light
        }
      }
      // 无 variant_id(数据异常,重试无益):不标 error → 门控C non-ultra-light
    }

    // 门控B:类目过滤
    if (cfg.enableCategoryFilterGate) {
      if (byType.search.error) return partial('search-failed', byType.search.error);
      if (!byType.search.hit) return skipped('no-search-data');
      const { descCatId, typeId } = extractCategoryIds(searchVariant, bundleDataRef);
      if (isCategoryFiltered(descCatId, typeId, filterMap)) return skipped('filtered-category');
    }

    // 门控C:超轻小件
    if (cfg.enableUltraLightGate) {
      if (byType.bundle.error) return partial('bundle-failed', byType.bundle.error);
      if (byType.search.error) return partial('search-failed', byType.search.error); // 仅门控B关闭时可达
      if (!isUltraLight(bundleDataRef)) return skipped('non-ultra-light');
    }

    // ── Step 5:买家页(richMedia + followSell + detail) ──
    if (!byType.richMedia.hit || !byType.detail.hit || !byType.followSell.hit) {
      const productUrl = domR?.card?.url || `https://www.ozon.ru/product/-${sku}/`;
      let relPath = `/product/-${sku}/`; // entrypoint-api fetch 用(card.url 完整 path+search)
      let urlSku = sku;
      try {
        const u = new URL(productUrl, 'https://www.ozon.ru');
        relPath = u.pathname + u.search;
        // sku 提取兼容两种格式:带 slug(/product/xxx-123)与直连(/product/123)
        urlSku = (u.pathname.match(/\/product\/(?:[^/?#]*-)?(\d+)\/?$/) || [])[1] || sku;
      } catch { /* fallback 已就绪 */ }

      // 导航用 /product/<sku> 直连格式(对齐插件 ensureBuyerTab 的
      // OZON_WWW_ORIGIN + '/product/' + sku):
      //   - card.url 带 _bctx/at/hs 搜索跟踪参数,直接 goto 触发反爬导致详情页加载失败
      //   - 必须无尾部斜杠:/product/<sku>/ 带斜杠不被 ozon 路由识别,302 兜底跳首页
      //   - /product/<sku> 由 ozon 302 到规范 slug 页(带斜杠),必能加载
      let navStatus = 0;
      try {
        const navResp = await buyerPage.goto(`https://www.ozon.ru/product/${urlSku}`, {
          waitUntil: 'domcontentloaded',
          timeout: cfg.pageGotoTimeoutMs,
        });
        navStatus = navResp?.status() || 0;
        await buyerPage.waitForTimeout(3000);
      } catch (e) {
        return partial('buyer-page-failed', 'NAV:' + String(e?.message || e).slice(0, 60));
      }
      if (navStatus === 403 || navStatus === 429) {
        return partial('buyer-page-failed', 'ANTIBOT', 'ANTIBOT');
      }
      if (navStatus === 404) {
        return partial('buyer-page-failed', 'HTTP_404'); // 商品下架/不存在,回 pending 重试
      }
      // 重定向检测:最终 URL 偏离 /product/(challenge 页/首页兜底)说明页面未真正加载,
      // 继续采集只会写入垃圾缓存 → partial 回队重试
      {
        const finalUrl = buyerPage.url();
        if (!/\/product\//.test(finalUrl)) {
          return partial('buyer-page-failed', 'REDIRECT:' + String(finalUrl).slice(0, 80));
        }
      }

      // helpers 预注入(mp4 提取 + 描述提取;失败降级,对齐插件 warn 继续)
      // 注:ozon.ru CSP 禁 inline script,addScriptTag 会被拦;lib 均为 IIFE 全局挂载,
      // page.evaluate(源码) 走 Runtime.evaluate 不创建 script 元素,不受 CSP 限制
      for (const lib of ['ozon-video-extract.js', 'follow-sell-content-copy.js']) {
        try {
          const src = readFileSync(path.resolve(__dirname, '../qx-ozon/lib', lib), 'utf-8');
          await buyerPage.evaluate(src);
        } catch (e) {
          console.warn(`[Step5] helper 注入失败(${lib}):`, e?.message || e);
        }
      }

      // 三路并行:媒体 + 跟卖 modal + jsonLd
      const [mediaSettled, fsSettled, jsonldSettled] = await Promise.allSettled([
        buyerPage.evaluate(PDP_MEDIA_FN, { relPath, timeoutMs: cfg.pdpFetchTimeoutMs }),
        buyerPage.evaluate(FOLLOW_SELL_MODAL_FN, { sku: String(urlSku), timeout: 15000 }),
        buyerPage.evaluate(JSONLD_EXTRACT_FN),
      ]);
      const mediaRes = mediaSettled.status === 'fulfilled' ? mediaSettled.value : null;
      const fsRes = fsSettled.status === 'fulfilled' ? fsSettled.value : null;
      const jsonldRes = jsonldSettled.status === 'fulfilled' ? jsonldSettled.value : { ok: false, data: null };

      // 端点耗时上报:richMedia 端点队列(epName → code)+ followSell modal
      if (Array.isArray(mediaRes?.__timings)) {
        for (const tm of mediaRes.__timings) {
          addMetric({
            endpoint: tm.epName === 'entrypoint' ? 'www.entrypoint.product' : 'www.composer.product',
            sku,
            durationMs: tm.durationMs,
            ts: tm.startedAt,
            statusCode: tm.status ?? null,
            ok: tm.ok === true,
            errorKind: tm.ok === true ? null : tm.reason || 'HTTP_' + tm.status,
          });
        }
      }
      if (fsRes?.__timing) {
        addMetric({
          endpoint: 'www.composer.offers-modal',
          sku,
          durationMs: fsRes.__timing.durationMs,
          ts: fsRes.__timing.startedAt,
          statusCode: fsRes.status ?? null,
          ok: fsRes.ok === true,
          errorKind: fsRes.ok === true ? null : String(fsRes.errorReason || '').slice(0, 40),
        });
      }

      // evaluate 异常 → 临时失败(设计 §7.1);HTTP 403/429 全失败 → ANTIBOT 熔断
      if (!mediaRes) return partial('buyer-page-failed', 'MEDIA_EVAL_EXC');
      if (!mediaRes.ok && /HTTP_403|HTTP_429/.test(String(mediaRes.failReasons || ''))) {
        return partial('buyer-page-failed', 'ANTIBOT', 'ANTIBOT');
      }

      // richMedia 写入:anyOk(HTTP 200)即写(包括空内容——商品本身数据特征)
      if (mediaRes.anyOk && !cfg.dryRun) {
        const fields = mediaRes.fields ? { ...mediaRes.fields, sku: String(urlSku) } : null;
        await erp.setRichMediaCache(sku, {
          mp4: mediaRes.mp4 || null,
          richContent: mediaRes.richContent || '',
          richContentHasText: !!mediaRes.richContentHasText,
          description: mediaRes.description || '',
          descriptionSource: mediaRes.descriptionSource || '',
          hashtags: Array.isArray(mediaRes.hashtags) ? mediaRes.hashtags : [],
          gallery: fields?.images || [],
          fields,
          widgetStates: mediaRes.filteredStates || {},
          hitEndpoints: Array.isArray(mediaRes.hitEndpoints) ? mediaRes.hitEndpoints : [],
        });
        byType.richMedia.hit = true;
      }
      // 日志与写缓存解耦:dryRun 也输出(纯展示,不落库)
      if (mediaRes.anyOk) {
        logDataLine('richMedia(真采)', summarizeRichMedia({
          mp4: mediaRes.mp4,
          richContent: mediaRes.richContent,
          richContentHasText: mediaRes.richContentHasText,
          description: mediaRes.description,
          descriptionSource: mediaRes.descriptionSource,
          hashtags: mediaRes.hashtags,
          gallery: mediaRes.fields?.images || [],
        }));
      }

      // followSell 写入:仅 HTTP 200(fsRes.ok)写(非 200 允许重试,但按设计 best-effort 不阻断)
      const fsData = fsRes?.ok ? fsRes.followSellData || null : null;
      if (!fsData && !byType.followSell.hit) {
        const why = fsSettled.status === 'rejected'
          ? 'EVAL_REJECT:' + String(fsSettled.reason?.message || fsSettled.reason).slice(0, 80)
          : fsRes?.errorReason || (fsRes?.ok ? 'ok-but-null-data' : 'unknown');
        console.warn(`[Step5] followSell 未获取(${why}),本任务按 best-effort 继续`);
      }
      if (fsData && !cfg.dryRun) {
        await erp.setFollowSellCache(sku, fsData);
        byType.followSell.hit = true;
      }
      if (fsData) logDataLine('followSell(真采)', summarizeFollowSell(fsData));

      // detail 写入:widgetStates(主)+ jsonLd(兜底);提取空不视为 partial(best-effort)
      if (mediaRes.anyOk || jsonldRes.ok) {
        const detail = buildDetailData(
          mediaRes.filteredStates || {},
          jsonldRes.ok ? jsonldRes.data : null,
          fsData,
          mediaRes.mp4 || null,
          sku,
          mediaRes.description || '',
          mediaRes.descriptionSource || ''
        );
        if (detail && (detail.title || detail.productId || detail.images.length)) {
          logDataLine('detail(真采)', summarizeDetail(detail));
          if (!cfg.dryRun) {
            await erp.setDomCache(sku, 'detail', detail);
            byType.detail.hit = true;
          }
        }
      }
      // Step5 各子项 best-effort 降级:失败不标 error、不阻断 → 照常 success(设计 §7.1)
    }

    // ── Step 6/7:完成(缓存已逐条写入;索引聚合由 ERP DAO 自动触发) ──
    const hasError = results.some((r) => !r.hit && r.error);
    const status = hasError ? 'partial' : 'success';
    return { status, ...(hasError ? { reason: 'step-error' } : {}), results, totalDuration: Date.now() - t0 };
  } catch (e) {
    // 异常兜底(对齐插件外层 catch → partial)
    return {
      status: 'partial',
      reason: 'exception',
      error: String(e?.message || e).slice(0, 120),
      results,
      totalDuration: Date.now() - t0,
    };
  }
}

// ── finalize:任务状态 + 日志(全部经 ERP API) ─────────────────
async function finalize(task, result, storeClassified) {
  const sku = String(task.sku);
  const reason = result.reason || null;
  // reason + error 合并(可观测性:buyer-page-failed :: NAV:Timeout 10000ms ...)
  const reasonDetail = reason ? (result.error ? `${reason} :: ${result.error}` : reason) : result.error || null;
  const nowIso = new Date().toISOString();

  if (cfg.dryRun) {
    // 干跑:零数据写入,仅任务回 pending(保证可重复测试)
    try {
      await erp.submitTask({
        sku,
        sellerSlug: task.sellerSlug || '',
        sellerId: task.sellerId || '',
        domInfo: task.domInfo || null,
        status: 'pending',
        attempts: task.attempts || 0,
        lastError: { type: 'dry-run', message: reason || 'dry-run', ts: Date.now() },
        steps: result.results,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        skipIfTodaySuccess: false,
      });
    } catch (e) {
      console.warn(`[DRY_RUN] 任务回队失败(任务停留 running,由 stale-reset 兜底): ${sku}`, e?.message || e);
    }
    return;
  }

  // 任务状态
  try {
    if (result.status === 'partial') {
      // partial 回队:attempts 保留(claim 时已 +1),createdAt=now 塞队尾
      await erp.submitTask({
        sku,
        sellerSlug: task.sellerSlug || '',
        sellerId: task.sellerId || '',
        domInfo: task.domInfo || null,
        status: 'pending',
        attempts: task.attempts || 0,
        lastError: {
          type: 'partial',
          message: reasonDetail || 'partial',
          ts: Date.now(),
        },
        steps: result.results,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        skipIfTodaySuccess: false, // 回队不能被 24h 成功去重吞掉
      });
    } else {
      await erp.submitResult(sku, {
        status: result.status,
        result: {
          source: 'headless-deep',
          results: result.results,
          ...(reasonDetail ? { reason: reasonDetail } : {}),
          ...(result.error ? { error: result.error } : {}),
          totalDuration: result.totalDuration || 0,
        },
        lastError:
          result.status === 'skipped' ? { type: 'skipped', message: reasonDetail || 'skipped', ts: Date.now() } : null,
        steps: result.results,
        duration: result.totalDuration || 0,
        finishedAt: nowIso,
      });
    }
  } catch (e) {
    console.warn(`[finalize] 任务状态写入失败(任务停留 running,由 stale-reset 兜底): ${sku}`, e?.message || e);
  }

  // 深度采集日志(每个 return 路径都写,含 all-cached/skipped/partial)
  try {
    await erp.insertAutoCollectLog({
      sku,
      source: 'headless-deep',
      sellerSlug: task.sellerSlug || '',
      sellerId: task.sellerId != null ? String(task.sellerId) : '',
      storeClassified,
      depth: 1,
      status: result.status,
      ...(reasonDetail ? { reason: reasonDetail } : {}),
      results: result.results,
      totalDuration: result.totalDuration || 0,
      collectedAt: nowIso,
    });
  } catch (e) {
    console.warn(`[finalize] 日志写入失败: ${sku}`, e?.message || e);
  }
}

// ── 信号处理(finalize 后触发) ────────────────────────────────
async function handleAuthWait() {
  for (let round = 1; round <= cfg.authRetryMax && !interrupted; round++) {
    console.warn(
      `[AUTH] seller 登录态失效,第 ${round}/${cfg.authRetryMax} 轮等待人工处理(每 60s 探测,单轮 ${Math.round(cfg.sellerAuthWaitMs / 1000)}s)...`
    );
    const deadline = Date.now() + cfg.sellerAuthWaitMs;
    while (Date.now() < deadline && !interrupted) {
      await sleep(Math.min(60000, Math.max(1, deadline - Date.now())));
      if (interrupted) break;
      try {
        await warmup();
        console.log('[AUTH] 登录态恢复,续采');
        return true;
      } catch { /* 未恢复,继续等 */ }
    }
  }
  console.error(
    `[AUTH] 连续 ${cfg.authRetryMax} 轮未恢复,退出。请在 profile(${cfg.profileDir})人工登录 seller.ozon.ru 后重跑。`
  );
  return false;
}

async function handleAntibotPause() {
  console.warn(`[ANTIBOT] 触发反爬,熔断 ${Math.round(cfg.antibotWaitMs / 1000)}s...`);
  const deadline = Date.now() + cfg.antibotWaitMs;
  while (Date.now() < deadline && !interrupted) await sleep(1000);
  if (interrupted) return;
  try {
    await warmup();
  } catch (e) {
    console.warn('[ANTIBOT] 恢复 warmup 失败(下次任务会再触发 AUTH 处理):', e?.message || e);
  }
}

// ── 类目黑名单(启动加载一次,内存 Map) ────────────────────────
async function loadFilterMap() {
  try {
    const r = await erp.getFilteredCategories();
    const items = r?.data?.items || [];
    const map = new Map();
    for (const it of items) {
      const descCatId = Number(it.descriptionCategoryId);
      const typeId = Number(it.typeId) || 0;
      if (!Number.isFinite(descCatId) || descCatId <= 0) continue;
      if (!map.has(descCatId)) map.set(descCatId, new Set());
      map.get(descCatId).add(typeId);
    }
    if (map.size === 0) {
      // 空名单大概率异常(响应结构变化/后端数据丢失),warn 提示避免门控B静默失效
      console.warn('[启动] 类目黑名单加载成功但为 0 条(检查后端 /admin/api/filtered-categories 返回结构)');
    } else {
      console.log(`[启动] 类目黑名单加载成功:${map.size} 个类目`);
    }
    return map;
  } catch (e) {
    // 加载失败 → 空 Map(不阻断采集,等同门控B关闭;对齐插件降级语义)
    console.warn('[启动] 类目黑名单加载失败(门控B本次降级为不过滤):', e?.message || e);
    return new Map();
  }
}

// ── main ─────────────────────────────────────────────────────
async function main() {
  console.log('=== 无头深度采集(ERP API 数据通道) ===');
  console.log(`ERP:       ${cfg.erpBaseUrl}`);
  console.log(`Profile:   ${cfg.profileDir}`);
  console.log(`无头:      ${cfg.headless}  干跑: ${cfg.dryRun}  任务上限: ${cfg.taskLimit || '不限'}`);
  console.log(`SKU间隔:   ${cfg.skuIntervalMinMs}-${cfg.skuIntervalMaxMs}ms 随机`);
  console.log(
    `门控:      A(市场统计)=${cfg.enableMarketStatsGate ? '开' : '关'}, B(类目)=${cfg.enableCategoryFilterGate ? '开' : '关'}, C(超轻)=${cfg.enableUltraLightGate ? '开' : '关'}, Gate0.5(仅大陆)=${cfg.onlyMainlandChina ? '开' : '关'}`
  );
  console.log(`SKU逐条日志: ${cfg.logSku ? '开启(LOG_SKU=1)' : '关闭'}`);
  console.log(`关键数据日志: ${cfg.logData ? '开启(LOG_DATA=0 可关)' : '关闭'}`);

  acquireFileLock(cfg.lockFile, 'deep-collect');
  // profile 跨脚本锁(浅采/深采共用 profile 时互斥;cloakbrowser 同 userDataDir 本就不允许双开,此处提前给明确报错)
  mkdirSync(cfg.profileDir, { recursive: true });
  const profileLock = path.join(cfg.profileDir, 'browser.lock');
  acquireFileLock(profileLock, 'profile(另一采集进程)');

  process.on('SIGINT', () => {
    if (interrupted) process.exit(1); // 二次 Ctrl+C 强制退出
    interrupted = true;
    console.log('\n[中断] 收到 SIGINT,等待当前步骤收尾(当前任务回 pending)后退出...');
  });

  const stats = { success: 0, partial: 0, skipped: 0, processed: 0 };
  const startTime = Date.now();
  let filterMap = new Map();
  let currentTask = null; // SIGINT 兜底用(正常路径 finalize 已处理)

  try {
    // 1. ERP 连通性探测:/health(服务可达) + stats(带鉴权轻量 GET,key 校验)
    console.log('\n[1/4] ERP 连通性探测...');
    try {
      await erpFetch('GET', '/health');
    } catch (e) {
      console.error(`[退出] ERP 服务不可达(${cfg.erpBaseUrl}/health): ${e?.message || e}`);
      process.exit(1);
    }
    try {
      await erp.getQueueStats();
    } catch (e) {
      if (e instanceof ErpError && e.kind === 'ERP_AUTH') {
        console.error(`[退出] ${e.message}`);
        console.error('       生成 key: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
        process.exit(2);
      }
      throw e;
    }
    console.log('[1/4] ERP 连通正常,x-api-key 校验通过');

    // 1.5 端点耗时监控初始化(缓冲 + 30s 定时上报 + 出口 IP 探测;失败自动禁用不阻断)
    initMetrics({ script: 'deep', erpBaseUrl: cfg.erpBaseUrl, erpApiKey: cfg.erpApiKey, profileDir: cfg.profileDir });

    // 2. 类目黑名单预加载
    filterMap = await loadFilterMap();

    // 3. 启动浏览器 + warmup
    console.log('\n[2/4] 启动 stealth 浏览器(双页模型)...');
    await launchBrowser();
    try {
      const companyId = await warmup();
      console.log(`[2/4] warmup 完成,seller 登录态正常(companyId=${companyId.slice(0, 4)}***)`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.startsWith('AUTH_REQUIRED')) {
        console.error(`[退出] seller 登录态缺失(sc_company_id):请在 profile(${cfg.profileDir})人工登录 seller.ozon.ru 后重跑`);
        process.exit(2);
      }
      throw e;
    }

    // 4. 主循环
    console.log('\n[3/4] 开始消费深度采集队列...');
    let firstEmptyAt = null;

    while (!interrupted) {
      if (cfg.taskLimit > 0 && stats.processed >= cfg.taskLimit) {
        console.log(`已达任务上限(${cfg.taskLimit}),退出`);
        break;
      }

      let task;
      try {
        task = await erp.claimTask();
      } catch (e) {
        if (e instanceof ErpError && e.kind === 'ERP_AUTH') {
          console.error(`[退出] ${e.message}`);
          process.exit(2);
        }
        // 网络错误已由 erpFetch 重试+熔断处理;此处兜底退避
        console.warn('[claim] 失败,5s 后重试:', e?.message || e);
        await sleep(5000);
        continue;
      }

      if (!task) {
        if (firstEmptyAt == null) firstEmptyAt = Date.now();
        if (Date.now() - firstEmptyAt > cfg.claimEmptyWaitMs) {
          console.log(`[3/4] 队列持续 ${Math.round(cfg.claimEmptyWaitMs / 1000)}s 无可消费任务(排空/被其他消费者持有),退出`);
          break;
        }
        await sleep(5000);
        continue;
      }
      firstEmptyAt = null;
      stats.processed++;
      currentTask = task;

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n[#${stats.processed}] sku=${task.sku} sellerId=${task.sellerId || '-'} (${elapsed}s)`);

      // ── Gate 0.5:中国店铺检查 ──
      let storeClassified = 'unclassified';
      let gateSkip = null;
      try {
        const cls = task.sellerId ? await erp.getStoreClassification(String(task.sellerId)) : null;
        if (cls) {
          storeClassified =
            cls.isMainlandChina === true
              ? 'mainland-china'
              : cls.isMainlandChina === false
                ? 'non-mainland-china'
                : 'unclassified';
        }
        if (cfg.onlyMainlandChina && cls?.isMainlandChina !== true) {
          gateSkip = cls?.isMainlandChina === false ? 'non-mainland-china-store' : 'unclassified-store';
        }
      } catch (e) {
        console.warn('[Gate0.5] 店铺分类查询失败(视为未分类):', e?.message || e);
      }
      if (gateSkip) {
        console.log(`    Gate0.5 跳过: ${gateSkip}`);
        await finalize(task, { status: 'skipped', reason: gateSkip, results: emptyResults(), totalDuration: 0 }, storeClassified);
        stats.skipped++;
        currentTask = null;
        if (cfg.logSku) {
          console.log(`      ${String(task.sku).padEnd(12)} | ${gateSkip}`);
        }
        continue;
      }

      // ── 采集 + finalize ──
      const result = await doAutoCollect(task, filterMap);
      await finalize(task, result, storeClassified);
      stats[result.status] = (stats[result.status] || 0) + 1;
      currentTask = null;

      if (cfg.logSku) {
        const hits = result.results.map((r) => `${r.type.slice(0, 5)}:${r.hit ? '✓' : '✗'}`).join(' ');
        const hitCount = result.results.filter((r) => r.hit).length;
        console.log(
          `      ${String(task.sku).padEnd(12)} | ${hits} (${hitCount}/7) | ${result.status} | ${((result.totalDuration || 0) / 1000).toFixed(1)}s${result.reason ? ' | ' + result.reason : ''}`
        );
      } else {
        console.log(
          `    ${result.status}${result.reason ? '(' + result.reason + ')' : ''} dur=${((result.totalDuration || 0) / 1000).toFixed(1)}s`
        );
      }

      // ── 信号处理(finalize 已回队,此处只管停/等) ──
      if (result.signal === 'AUTH_REQUIRED') {
        const recovered = await handleAuthWait();
        if (!recovered) break;
      } else if (result.signal === 'ANTIBOT') {
        await handleAntibotPause();
      }

      // ── SKU 间隔节流 ──
      if (!interrupted) await sleep(randInt(cfg.skuIntervalMinMs, cfg.skuIntervalMaxMs));
    }

    // SIGINT 落在 finalize 之前/doAutoCollect 中途的兜底:任务已由 partial(interrupted 由各步检查)回队
    if (interrupted && currentTask) {
      console.warn(`[中断] sku=${currentTask.sku} 停留 running,由 ERP stale-reset(5min)兜底回收`);
    }
  } finally {
    // 4. 汇总
    console.log('\n[4/4] 汇总');
    console.log(`  处理: ${stats.processed}`);
    console.log(`  成功: ${stats.success}`);
    console.log(`  partial(回队): ${stats.partial}`);
    console.log(`  跳过: ${stats.skipped}`);
    console.log(`  耗时: ${Math.round((Date.now() - startTime) / 1000)}s`);
    if (interrupted) console.log('  (被中断;partial 任务已在队尾,重跑即续采)');

    try { await browser?.close(); } catch { /* 忽略 */ }
    // 端点耗时监控:退出前 flush 尽力而为(2s 内)
    try { await finalizeMetrics(); } catch { /* 忽略 */ }
    releaseFileLock(profileLock);
    releaseFileLock(cfg.lockFile);
  }
}

main().catch((e) => {
  console.error('\n致命错误:', e);
  try { browser?.close?.(); } catch { /* 忽略 */ }
  try { releaseFileLock(path.join(cfg.profileDir, 'browser.lock')); } catch { /* 忽略 */ }
  try { releaseFileLock(cfg.lockFile); } catch { /* 忽略 */ }
  process.exit(1);
});
