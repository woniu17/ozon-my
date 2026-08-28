// 无头 cloakbrowser 价格优势监控采集脚本(ERP API 数据通道版)
//
// 从 ERP 领取我的店铺 SKU 列表(派生自 product_data_cache,仅 saleable 商品),
// 逐个访问买家页 /product/<sku>,在页面上下文 fetch composer offers-modal
// 抓取该 SKU 的跟卖报价列表,批量上报 ERP 由服务端计算"我的价 vs 跟卖最低/中位价"。
// 前端 PriceWatch.vue 展示价格优势看板。
//
// 与深采/浅采的关系:共用 .ozon-profile(靠锁文件互斥)、共用 .env 的 ERP 连接配置;
// 数据通道全部走 ERP HTTP API(x-api-key 服务鉴权),不打开 erp.db。
// 跟卖抓取注入函数移植自 deep-collect.js FOLLOW_SELL_MODAL_FN(原 collect-tab.js L911-992)。
//
// 用法: node price-watch-collect.js
// 可选环境变量(见 .env;调优类变量加 PW_ 前缀,避免与深采同名变量互相覆盖):
//   分批采集:PW_TASK_LIMIT 总上限(0=不限) / PW_BATCH_SIZE 每批个数(≤500) /
//            PW_BATCH_INTERVAL_MIN/MAX_MS 批间随机等待;批内 SKU 间隔 PW_SKU_INTERVAL_*
// Linux/macOS(bash):
//   PW_TASK_LIMIT=10 DRY_RUN=1 node price-watch-collect.js   # 小批量干跑
//   PW_TASK_LIMIT=10 node price-watch-collect.js             # 小批量落库
// Windows(PowerShell;注意 $env: 会话内持久,常驻前先清残留):
//   $env:PW_TASK_LIMIT='10'; $env:DRY_RUN='1'; node price-watch-collect.js
//   Remove-Item Env:PW_TASK_LIMIT,Env:DRY_RUN -ErrorAction SilentlyContinue
// 前置:ERP 后端已启动且两侧 .env 配置了相同的 SERVICE_API_KEY / ERP_API_KEY;
//       profile(.ozon-profile)已访问过 ozon.ru 建立 cookie(无需 seller 登录态,
//       但与深采共用 profile 时保持登录无害)。

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

// 数值型 env 读取:未配置/非法值用默认;显式配置 0 保留为 0(如 PW_TASK_LIMIT=0 表示不限)
function numEnv(key, def) {
  const v = process.env[key];
  if (v == null || v === '' || !Number.isFinite(Number(v))) return def;
  return Number(v);
}

// ── 配置 ─────────────────────────────────────────────────────
const cfg = {
  erpBaseUrl: (process.env.ERP_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, ''),
  erpApiKey: process.env.ERP_API_KEY || '',
  erpTimeoutMs: Number(process.env.ERP_TIMEOUT_MS) || 15000,
  erpFailMax: Number(process.env.ERP_FAIL_MAX) || 5,

  profileDir: path.resolve(__dirname, process.env.PROFILE_DIR || '.ozon-profile'),
  lockFile: path.join(__dirname, '.price-watch.lock'),

  // 任务:总上限(0=不限,跑完整个待采集合);FORCE=1 忽略 24h 去重强制重采
  // PW_ 前缀:与深采 TASK_LIMIT 解耦(.env 同文件重复键后值覆盖前值,曾互相干扰)
  taskLimit: numEnv('PW_TASK_LIMIT', 100),
  // 分批:每批领取 SKU 数(≤500,后端钳制);批间随机等待,降低连续批量访问的指纹
  batchSize: numEnv('PW_BATCH_SIZE', 100),
  batchIntervalMinMs: numEnv('PW_BATCH_INTERVAL_MIN_MS', 120000),
  batchIntervalMaxMs: numEnv('PW_BATCH_INTERVAL_MAX_MS', 300000),
  force: process.env.FORCE === '1',
  storeFilter: process.env.STORE_FILTER || '', // 仅采指定 storeId(空=全部店铺)
  dryRun: process.env.DRY_RUN === '1',
  logSku: process.env.LOG_SKU === '1',

  // 节流(反爬拟人化,价格监控比深采轻,间隔可短些;PW_ 前缀与深采解耦)
  skuIntervalMinMs: Number(process.env.PW_SKU_INTERVAL_MIN_MS) || 3000,
  skuIntervalMaxMs: Number(process.env.PW_SKU_INTERVAL_MAX_MS) || 8000,

  // 熔断/恢复(PW_ 前缀与深采解耦)
  antibotWaitMs: Number(process.env.PW_ANTIBOT_WAIT_MS) || 600000,
  challengeWaitMs: Number(process.env.CHALLENGE_WAIT_MS) || 15000,
  // 连续 antibot 上限(价格监控非关键链路,达到即退出,下次再跑)
  antibotMax: Number(process.env.ANTIBOT_MAX) || 3,

  // 超时
  pageGotoTimeoutMs: Number(process.env.PAGE_GOTO_TIMEOUT_MS) || 30000,
  modalTimeoutMs: Number(process.env.MODAL_TIMEOUT_MS) || 15000,

  // 上报批量
  reportBatchSize: Number(process.env.REPORT_BATCH_SIZE) || 10,

  headless: process.env.HEADLESS !== '0',
};

if (cfg.skuIntervalMinMs > cfg.skuIntervalMaxMs) {
  console.error(`[配置错误] PW_SKU_INTERVAL_MIN_MS(${cfg.skuIntervalMinMs}) > MAX(${cfg.skuIntervalMaxMs})`);
  process.exit(1);
}
if (!cfg.erpApiKey) {
  console.error('[配置错误] ERP_API_KEY 未配置(与后端 SERVICE_API_KEY 同值,见 .env.example)');
  process.exit(1);
}

// ── 工具 ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.round(min + Math.random() * (max - min));

// 日志时间戳(console.log/warn/error 统一加 [YYYY-MM-DD HH:mm:ss] 前缀,与浅采同款)
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

// ── ERP API Client(骨架基准 deep-collect.js erpFetch) ───────
// 统一出口:x-api-key 头 + 超时(AbortController) + 请求级重试 + 连续失败熔断
class ErpError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'ErpError';
    this.kind = kind;
    this.status = status;
  }
}

let erpFailStreak = 0;

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
      await erpRawRequest('GET', '/health', undefined, 8000);
      erpFailStreak = 0;
      console.log('[ERP] 恢复,续采');
      return;
    } catch {
      await sleep(30000);
    }
  }
}

async function erpFetch(method, reqPath, body) {
  for (let attempt = 1; ; attempt++) {
    if (interrupted && attempt > 1) throw new ErpError('ERP_NET', 'interrupted');
    try {
      const r = await erpRawRequest(method, reqPath, body, cfg.erpTimeoutMs);
      erpFailStreak = 0;
      return r?.data !== undefined ? r.data : r;
    } catch (e) {
      if (e instanceof ErpError && e.kind === 'ERP_AUTH') throw e;
      erpFailStreak++;
      if (erpFailStreak >= cfg.erpFailMax) {
        await waitForErpRecovery();
        continue; // 恢复后重试本次请求
      }
      // 5xx/网络错误退避重试;4xx(请求构造 bug)快速失败
      if (e instanceof ErpError && e.kind === 'ERP_4xx') throw e;
      if (attempt >= 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}

// ── 注入函数:跟卖 modal 抓取(移植 deep-collect.js FOLLOW_SELL_MODAL_FN) ──
// 注:cloakbrowser evaluate 仅支持单参数,sku/timeout 合并对象传递;函数须自包含无闭包引用
const FOLLOW_SELL_MODAL_FN = async (p) => {
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

// ── 浏览器 ───────────────────────────────────────────────────
let browser = null;
let buyerPage = null;

// challenge 页标题识别(移植 deep-collect.js)
function isChallengeTitle(title) {
  const t = String(title || '').toLowerCase();
  return /доступ|antibot|challenge|verify|just a moment|attention/.test(t);
}

async function launchBrowser() {
  browser = await launchPersistentContext({
    userDataDir: cfg.profileDir,
    headless: cfg.headless,
  });
  // 标签页清理:关闭会话恢复的残留页,保留第 1 个复用(全部关闭会导致上下文退出)
  const restored = (() => {
    try { return browser.pages(); } catch { return []; }
  })();
  for (const p of restored.slice(1)) await p.close().catch(() => {});
  buyerPage = restored[0] || (await browser.newPage());
  if (restored.length > 1) {
    console.log(`[启动] 已关闭 ${restored.length - 1} 个残留标签页`);
  }
}

// buyer 域登录态探测:ozon.ru cookie 中含 session/auth/sc_/user 类凭证即视为已登录
// httpOnly cookie 页面内 document.cookie 读不到,须用 ctx.cookies();
// 价格监控只需"访问过"的 cookie 降低 403 概率,无登录态仅警告不退出
async function probeBuyerAuth() {
  try {
    const cookies = await browser.cookies();
    const authCookies = (cookies || []).filter(
      (c) => /ozon\.ru$/.test(String(c.domain || '').replace(/^\./, '')) && /session|auth|token|sc_|user/i.test(c.name)
    );
    if (authCookies.length > 0) {
      console.log(`[warmup] buyer 登录态正常(凭证 cookie ${authCookies.length} 个: ${authCookies.map((c) => c.name).slice(0, 5).join(', ')})`);
    } else {
      console.warn('[warmup] buyer 无登录态 cookie(仅有访客 cookie)——采集可用,但 403 概率升高;如频繁被拦可人工登录 www.ozon.ru 到 profile');
    }
  } catch (e) {
    console.warn(`[warmup] 登录态探测失败(不影响采集): ${e?.message || e}`);
  }
}

// warmup:过反爬挑战 + 刷新 cookie(价格监控无需 seller 登录态)
async function warmup() {
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
  await probeBuyerAuth();
}

// ── 单 SKU 采集 ──────────────────────────────────────────────
// 返回 { status: 'ok'|'error', item:上报条目, signal?: 'ANTIBOT' }
async function collectOne(task) {
  const sku = String(task.sku);
  const fetchedAt = new Date().toISOString();

  // 导航用 /product/<sku> 直连格式(无尾斜杠;card.url 的跟踪参数会触发反爬)
  let navStatus = 0;
  try {
    const navResp = await buyerPage.goto(`https://www.ozon.ru/product/${sku}`, {
      waitUntil: 'domcontentloaded',
      timeout: cfg.pageGotoTimeoutMs,
    });
    navStatus = navResp?.status() || 0;
    await buyerPage.waitForTimeout(3000);
  } catch (e) {
    return {
      status: 'error',
      item: { sku, fetchedAt, ok: false, errorReason: 'NAV:' + String(e?.message || e).slice(0, 60) },
    };
  }
  if (navStatus === 403 || navStatus === 429) {
    return { status: 'error', item: { sku, fetchedAt, ok: false, errorReason: 'ANTIBOT_HTTP_' + navStatus }, signal: 'ANTIBOT' };
  }
  if (navStatus === 404) {
    return { status: 'error', item: { sku, fetchedAt, ok: false, errorReason: 'HTTP_404' } };
  }
  // 重定向检测:最终 URL 偏离 /product/ 说明页面未真正加载,继续采集只会写垃圾数据
  {
    const finalUrl = buyerPage.url();
    if (!/\/product\//.test(finalUrl)) {
      const reason = 'REDIRECT:' + String(finalUrl).slice(0, 80);
      if (/challenge|access|denied/i.test(finalUrl)) {
        return { status: 'error', item: { sku, fetchedAt, ok: false, errorReason: reason }, signal: 'ANTIBOT' };
      }
      return { status: 'error', item: { sku, fetchedAt, ok: false, errorReason: reason } };
    }
  }

  // 跟卖 modal 抓取(单参数对象传递)
  let fsRes = null;
  try {
    fsRes = await buyerPage.evaluate(FOLLOW_SELL_MODAL_FN, { sku, timeout: cfg.modalTimeoutMs });
  } catch (e) {
    return {
      status: 'error',
      item: { sku, fetchedAt, ok: false, errorReason: 'EVAL_EXC:' + String(e?.message || e).slice(0, 60) },
    };
  }

  // 端点耗时上报
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

  if (!fsRes?.ok) {
    const reason = String(fsRes?.errorReason || 'unknown');
    if (/HTTP_403|HTTP_429|ANTIBOT/.test(reason)) {
      return { status: 'error', item: { sku, fetchedAt, ok: false, errorReason: reason }, signal: 'ANTIBOT' };
    }
    return { status: 'error', item: { sku, fetchedAt, ok: false, errorReason: reason } };
  }
  return {
    status: 'ok',
    item: { sku, fetchedAt, ok: true, followSellData: fsRes.followSellData },
  };
}

// ── 批量上报 ─────────────────────────────────────────────────
async function reportBatch(items) {
  if (!items.length) return;
  if (cfg.dryRun) {
    console.log(`[干跑] 跳过上报 ${items.length} 条`);
    return;
  }
  const r = await erpFetch('POST', '/admin/api/price-watch/report', { items });
  console.log(`[上报] ${items.length} 条 → inserted=${r?.inserted} skipped=${r?.skipped}`);
}

// ── main ─────────────────────────────────────────────────────
async function main() {
  console.log('=== 价格优势监控采集(ERP API 数据通道) ===');
  console.log(`ERP:       ${cfg.erpBaseUrl}`);
  console.log(`Profile:   ${cfg.profileDir}`);
  console.log(`无头:      ${cfg.headless}  干跑: ${cfg.dryRun}  任务上限: ${cfg.taskLimit === 0 ? '不限' : cfg.taskLimit}`);
  console.log(`批次:      每批 ${cfg.batchSize} 个,批间 ${Math.round(cfg.batchIntervalMinMs / 1000)}-${Math.round(cfg.batchIntervalMaxMs / 1000)}s 随机`);
  console.log(`SKU间隔:   ${cfg.skuIntervalMinMs}-${cfg.skuIntervalMaxMs}ms 随机  强制重采: ${cfg.force}`);

  acquireFileLock(cfg.lockFile, 'price-watch');
  // profile 跨脚本锁(与浅采/深采共用 profile 时互斥)
  mkdirSync(cfg.profileDir, { recursive: true });
  const profileLock = path.join(cfg.profileDir, 'browser.lock');
  acquireFileLock(profileLock, 'profile(另一采集进程)');

  process.on('SIGINT', () => {
    if (interrupted) process.exit(1); // 二次 Ctrl+C 强制退出
    interrupted = true;
    console.log('\n[中断] 收到 SIGINT,等待当前 SKU 收尾(已完成结果批量上报)后退出...');
  });

  const stats = { processed: 0, ok: 0, empty: 0, error: 0, antibot: 0 };
  const startTime = Date.now();

  try {
    // 1. ERP 连通性探测
    console.log('\n[1/4] ERP 连通性探测...');
    try {
      await erpRawRequest('GET', '/health', undefined, 8000);
    } catch (e) {
      console.error(`[退出] ERP 服务不可达(${cfg.erpBaseUrl}/health): ${e?.message || e}`);
      process.exit(1);
    }
    try {
      await erpFetch('GET', '/admin/api/price-watch/stats');
    } catch (e) {
      if (e instanceof ErpError && e.kind === 'ERP_AUTH') {
        console.error(`[退出] ${e.message}`);
        process.exit(2);
      }
      throw e;
    }
    console.log('[1/4] ERP 连通正常,x-api-key 校验通过');

    // 端点耗时监控初始化(script 码 price-watch,白名单已注册)
    initMetrics({ script: 'price-watch', erpBaseUrl: cfg.erpBaseUrl, erpApiKey: cfg.erpApiKey, profileDir: cfg.profileDir });

    // 2. 启动浏览器 + warmup
    console.log('\n[2/4] 启动 stealth 浏览器...');
    await launchBrowser();
    await warmup();
    console.log('[2/4] warmup 完成,买家页 cookie 就绪');

    // 3. 分批领取 + 采集(每批 PW_BATCH_SIZE 个,批间随机间隔;
    //    后端 24h 成功去重保证下一批领到的是未采 SKU,天然续传)
    console.log('\n[3/4] 开始采集...');
    const pending = [];
    let fetchedTotal = 0;
    let stopAll = false; // ANTIBOT 连续超限等致命情形,跳出全部批次
    let batchNo = 0;

    while (!interrupted && !stopAll) {
      // 本批领取数:批次大小 ∩ 总上限余量
      const remaining = cfg.taskLimit === 0
        ? cfg.batchSize
        : Math.min(cfg.batchSize, cfg.taskLimit - fetchedTotal);
      if (remaining <= 0) break;

      const taskQ = new URLSearchParams({ limit: String(remaining) });
      if (cfg.force) taskQ.set('force', '1');
      if (cfg.storeFilter) taskQ.set('storeId', cfg.storeFilter);
      const tasksResp = await erpFetch('GET', '/admin/api/price-watch/tasks?' + taskQ.toString());
      const tasks = tasksResp?.items || [];
      batchNo++;
      if (!tasks.length) {
        console.log(`\n[批次${batchNo}] 无待采 SKU(全部已采或缓存为空;FORCE=1 可强制重采)`);
        break;
      }
      fetchedTotal += tasks.length;
      console.log(`\n[批次${batchNo}] 领取 ${tasks.length} 个(累计 ${fetchedTotal}${cfg.taskLimit > 0 ? '/' + cfg.taskLimit : ',不限'})`);

      // 各店铺价格缓存新鲜度提醒(过旧会误判优势;每批都提示,提醒同步)
      for (const s of tasksResp?.syncInfo || []) {
        const ageH = s.lastSyncAt ? Math.round((Date.now() - Date.parse(s.lastSyncAt)) / 3600000) : null;
        const flag = ageH != null && ageH > 48 ? ' ⚠ 价格缓存超过48h,建议先同步商品' : '';
        console.log(`    ${s.storeId || '(未归属)'}: ${s.skuCount} SKU,缓存 ${s.lastSyncAt || '无'}${flag}`);
      }

      // 本批满额且未达总上限 → 大概率还有后续批次(影响 ANTIBOT 等待与批间节流)
      const expectMore = tasks.length === remaining
        && (cfg.taskLimit === 0 || fetchedTotal < cfg.taskLimit);

      for (const [idx, task] of tasks.entries()) {
        if (interrupted) break;

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`\n[#${stats.processed + 1}] sku=${task.sku} myPrice=${task.myPrice ?? '-'} (${elapsed}s)`);

        const r = await collectOne(task);
        stats.processed++;
        if (r.status === 'ok') {
          const cnt = r.item.followSellData?.count ?? 0;
          if (cnt > 0) stats.ok++;
          else stats.empty++;
          if (cfg.logSku) {
            const sellers = r.item.followSellData?.sellers || [];
            const prices = sellers.map((s) => s?.price?.cardPrice?.price ?? '').filter(Boolean).slice(0, 5);
            console.log(`      跟卖 ${cnt} 家  价样: ${prices.join(' | ') || '—'}`);
          }
        } else {
          stats.error++;
          console.log(`    失败: ${r.item.errorReason}`);
        }
        pending.push(r.item);

        // 批量上报
        if (pending.length >= cfg.reportBatchSize) {
          await reportBatch(pending.splice(0));
        }

        // ANTIBOT 信号处理:等待熔断窗口后 warmup;连续超限退出(价格监控可下次再跑)
        // 本批最后一个 SKU 但后续还有批次时,同样需要熔断等待
        const hasMore = idx < tasks.length - 1 || expectMore;
        if (r.signal === 'ANTIBOT' && !interrupted && hasMore) {
          stats.antibot++;
          if (stats.antibot >= cfg.antibotMax) {
            console.error(`[ANTIBOT] 已触发 ${stats.antibot} 次,退出(剩余 SKU 下次运行继续)`);
            stopAll = true;
            break;
          }
          console.warn(`[ANTIBOT] 触发反爬,熔断 ${Math.round(cfg.antibotWaitMs / 1000)}s,预计恢复 ${fmtNext(cfg.antibotWaitMs)}`);
          const deadline = Date.now() + cfg.antibotWaitMs;
          while (Date.now() < deadline && !interrupted) await sleep(1000);
          if (interrupted) break;
          try {
            await warmup();
          } catch (e) {
            console.warn('[ANTIBOT] 恢复 warmup 失败:', e?.message || e);
          }
        }

        // SKU 间隔节流(输出下一次采集时间;批内最后一个 SKU 交给批间间隔,不重复等)
        if (!interrupted && idx < tasks.length - 1) {
          const waitMs = randInt(cfg.skuIntervalMinMs, cfg.skuIntervalMaxMs);
          console.log(`    下一SKU预计 ${fmtNext(waitMs)}(等待 ${Math.round(waitMs / 1000)}s)`);
          await sleep(waitMs);
        }
      }

      // 批间随机间隔(仅当大概率还有下一批且未中断/未熔断退出)
      if (expectMore && !interrupted && !stopAll) {
        const waitMs = randInt(cfg.batchIntervalMinMs, cfg.batchIntervalMaxMs);
        console.log(`\n[批次间隔] 批次${batchNo} 完成,等待 ${Math.round(waitMs / 1000)}s,批次${batchNo + 1} 预计 ${fmtNext(waitMs)}`);
        await sleep(waitMs);
      }
    }

    // 尾批上报
    await reportBatch(pending.splice(0));
  } finally {
    console.log('\n[汇总]');
    console.log(`  处理: ${stats.processed}`);
    console.log(`  有跟卖: ${stats.ok}  无跟卖: ${stats.empty}  失败: ${stats.error}`);
    console.log(`  反爬触发: ${stats.antibot}`);
    console.log(`  耗时: ${Math.round((Date.now() - startTime) / 1000)}s`);
    if (interrupted) console.log('  (被中断;已采 SKU 已上报,未采 SKU 下次运行自动续上)');

    try { await browser?.close(); } catch { /* 忽略 */ }
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
