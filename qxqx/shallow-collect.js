// 无头 cloakbrowser 浅度采集脚本
// 用 launchPersistentContext 启动 stealth 浏览器,导航到店铺页,
// 在店铺页上下文里逐页 fetch entrypoint-api(API 直取,复用 qx-ozon 插件浅采语义),
// 4 道过滤后写 ozon_shallow_collect_log(source='headless-api')。
//
// 与 backfill-store-stats.js 的差异:
//   - backfill:每店一次 fetch 取 stats(订单数/评论数/评分/开业时长)
//   - 本脚本:每店翻页拉取全部 SKU(价格/评论过滤 + 浅度日志)
//   - backfill 熔断即终止;本脚本熔断后等待 CIRCUIT_BREAKER_WAIT_MS 再断点续采
//
// 用法: node shallow-collect.js
// 可选环境变量(见 .env,命令行/env 优先于 .env):
//   STORE_LIMIT=1 DRY_RUN=1 node shallow-collect.js   # 单店干跑
//   STORE_LIMIT=1 LOG_SKU=1 node shallow-collect.js   # 单店落库 + SKU 逐条日志
//   STORE_LIMIT=10 node shallow-collect.js            # 小批量
//   node shallow-collect.js                           # 全量
//
// 设计要点(2026-08 详细设计 v2):
//   - 翻页循环在 Node 侧,每页一次 page.evaluate(200-500ms),
//     进度实时可见、Ctrl+C 可中断、崩溃最多丢 1 页
//   - 熔断恢复:等待 → warmup → 重新导航店铺页 → 从 state.nextPagePath 断点续采
//     (seenSkus 保留,不重复写、不误判空页)
//   - 错误分类:404 = 永久错误直接跳过;403/429/5xx/网络错误 = 临时错误走熔断
//   - DRY_RUN=1 完全只读(不写日志、不写 progress)

import { launchPersistentContext } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ── 配置 ─────────────────────────────────────────────────────
const cfg = {
  dbPath: process.env.DB_PATH || path.resolve(__dirname, '../erp-backend-lite/data/erp.db'),
  profileDir: path.join(__dirname, '.chrome-profile'),
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
};

// 配置校验
if (cfg.pageIntervalMinMs > cfg.pageIntervalMaxMs) {
  console.error(`[配置错误] PAGE_INTERVAL_MIN_MS(${cfg.pageIntervalMinMs}) > MAX(${cfg.pageIntervalMaxMs})`);
  process.exit(1);
}
const SORT_COLUMNS = {
  lastSeenAt: 'lastSeenAt',
  ordersCount: 'orders_count',
  reviewsCount: 'reviews_count',
  rating: 'rating',
  openedMonths: 'opened_months',
};
if (!SORT_COLUMNS[cfg.storeSort]) {
  console.error(`[配置错误] STORE_SORT 无效: ${cfg.storeSort}(可选: ${Object.keys(SORT_COLUMNS).join('/')})`);
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

// ── SQLite ───────────────────────────────────────────────────
const db = new DatabaseSync(cfg.dbPath);
db.exec('PRAGMA journal_mode = WAL');
// 等待锁最多 5s,避免与后端服务并发写时立即报 database is locked
db.exec('PRAGMA busy_timeout = 5000');

function loadStores(progress) {
  const whereParts = [];
  const params = [];
  if (cfg.storeSellerIds.length > 0) {
    whereParts.push(`sellerId IN (${cfg.storeSellerIds.map(() => '?').join(',')})`);
    params.push(...cfg.storeSellerIds);
  } else {
    if (cfg.storeOnlyMainlandChina) {
      whereParts.push('isMainlandChina = 1');
    }
  }

  // 数值范围过滤(orders_count/reviews_count/rating/opened_months;NULL 值被范围条件排除)
  const applyRange = (col, min, max) => {
    if (min != null) { whereParts.push(`${col} >= ?`); params.push(min); }
    if (max != null) { whereParts.push(`${col} <= ?`); params.push(max); }
  };
  applyRange('orders_count', cfg.storeOrdersMin, cfg.storeOrdersMax);
  applyRange('reviews_count', cfg.storeReviewsMin, cfg.storeReviewsMax);
  applyRange('rating', cfg.storeRatingMin, cfg.storeRatingMax);
  applyRange('opened_months', cfg.storeOpenedMonthsMin, cfg.storeOpenedMonthsMax);

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  const sql = `
    SELECT sellerId, sellerSlug
    FROM ozon_store_classification
    ${where}
    ORDER BY ${SORT_COLUMNS[cfg.storeSort]} DESC
  `;
  let rows = db.prepare(sql).all(...params);
  rows = rows.filter((r) => r.sellerId && /^\d+$/.test(String(r.sellerId)));

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

// 每页 flush:逐条 INSERT,带 1 次重试(与 backfill updateStats 一致)
const insertLogStmt = db.prepare(
  `INSERT INTO ozon_shallow_collect_log
   (sku, sellerSlug, sellerId, name, price, ratingCount, imageUrl,
    passesFilter, skipReason, source, collectedAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
function flushLogs(logs, store) {
  if (logs.length === 0) return;
  if (cfg.dryRun) {
    console.log(`    [DRY_RUN] 跳过写入 ${logs.length} 条`);
    return;
  }
  const now = new Date().toISOString();
  for (const s of logs) {
    const args = [
      s.sku, store.sellerSlug ?? null, String(store.sellerId),
      s.name ?? null,
      s.price != null ? Number(s.price) : null,
      s.ratingCount != null ? Number(s.ratingCount) : null,
      s.imageUrl ?? null,
      s.passesFilter ? 1 : 0,
      s.skipReason ?? null,
      'headless-api',
      now,
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        insertLogStmt.run(...args);
        break;
      } catch (e) {
        if (e.code === 'ERR_SQLITE_ERROR' && attempt === 0) {
          const start = Date.now();
          while (Date.now() - start < 200) {} // 忙等 200ms 后重试一次
          continue;
        }
        throw e;
      }
    }
  }
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
    if (!resp.ok) return { error: `HTTP ${resp.status}`, status: resp.status };
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
    };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
};

// ── 错误分类:404=永久(跳过该店),其余=临时(熔断重试) ──────────
function isPermanentError(r) {
  return r?.status === 404 || /HTTP 404/.test(String(r?.error || ''));
}

// ── 浏览器 ───────────────────────────────────────────────────
let browser = null;
let interrupted = false;

async function launchBrowser() {
  browser = await launchPersistentContext({
    userDataDir: cfg.profileDir,
    headless: cfg.headless,
  });
  return browser;
}

// 访问 ozon.ru 首页:过反爬挑战 + 建立/刷新 cookie(带健康探测)
async function warmup(page) {
  await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000); // 给 cloakbrowser stealth 时间通过反爬挑战
  const title = await page.title();
  console.log(`    warmup: 首页标题 "${(title || '').slice(0, 50)}"`);
  return title;
}

// ── Node 侧单店翻页循环(state 跨熔断持久) ───────────────────
async function collectStore(page, store, state) {
  while (state.nextPagePath && !interrupted) {
    const r = await page.evaluate(FETCH_PAGE_FN, {
      path: state.nextPagePath,
      timeoutMs: cfg.requestTimeoutMs,
    });

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
        passesFilter,
        skipReason,
      });
    }
    flushLogs(logs, store);

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

    // ★ 页间节流:10-15s 随机(反爬拟人化)
    await sleep(randInt(cfg.pageIntervalMinMs, cfg.pageIntervalMaxMs));
  }
  // interrupted:不标记 done(已写页已落库,重跑时该店重新采集会重复写日志,
  // 但浅度日志按 SKU+时间追加是正常语义,可接受)
  return { outcome: 'interrupted', skuCount: state.seenSkus.size, pages: state.pages };
}

// ── main ─────────────────────────────────────────────────────
async function main() {
  console.log('=== 无头浅度采集(API 直取) ===');
  console.log(`DB:        ${cfg.dbPath}`);
  console.log(`Profile:   ${cfg.profileDir}`);
  console.log(`无头:      ${cfg.headless}  干跑: ${cfg.dryRun}`);
  console.log(`页间隔:    ${cfg.pageIntervalMinMs}-${cfg.pageIntervalMaxMs}ms 随机`);
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

  acquireLock();

  const progress = loadProgress();

  // Ctrl+C 优雅退出:保存进度 + 关浏览器(最多丢当前页)
  process.on('SIGINT', () => {
    if (interrupted) process.exit(1); // 二次 Ctrl+C 强制退出
    interrupted = true;
    console.log('\n[中断] 收到 SIGINT,正在保存进度并退出...');
    try { saveProgress(progress); } catch { /* 忽略 */ }
    releaseLock();
    browser?.close?.().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });

  // 1. 启动浏览器
  console.log('\n[1/4] 启动 stealth 浏览器...');
  await launchBrowser();
  const page = await browser.newPage();
  await warmup(page);

  // 2. 查询待采店铺
  console.log('\n[2/4] 查询待采店铺...');
  const stores = loadStores(progress);
  const doneCount = Object.keys(progress.done).length;
  console.log(`[2/4] 累计已完成 ${doneCount} 个,本批待处理 ${stores.length} 个`);
  if (stores.length === 0) {
    console.log('\n全部完成,无需处理。');
    await browser.close();
    releaseLock();
    return;
  }

  // 3. 逐店采集
  console.log(`\n[3/4] 开始采集...`);
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
      navResp = await page.goto(`https://www.ozon.ru/seller/${store.sellerId}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
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
      console.log(`    等待 ${Math.round(waitMs / 1000)}s 后断点续采(已采 ${state.seenSkus.size} SKU / ${state.pages} 页)...`);
      const waitStart = Date.now();
      while (Date.now() - waitStart < waitMs && !interrupted) {
        await sleep(1000);
      }
      if (interrupted) break;

      // 恢复:重新 warmup 刷 cookie → 重新导航店铺页 → 从断点续采
      try {
        await warmup(page);
        await page.goto(`https://www.ozon.ru/seller/${store.sellerId}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 25000,
        });
        await page.waitForTimeout(3000);
      } catch (e) {
        console.log(`    恢复导航失败: ${e.message}`);
      }
      state.consecutiveErrors = 0;
      state.consecutiveEmptyPages = 0;
      // state.nextPagePath / seenSkus 保留 → 断点续采,不重复不漏采
    }

    // 店铺间隔(与页间隔同款随机,更拟人)
    if (i < stores.length - 1 && !interrupted) {
      await sleep(randInt(cfg.pageIntervalMinMs, cfg.pageIntervalMaxMs));
    }
  }

  // 4. 汇总
  console.log('\n[4/4] 汇总');
  console.log(`  成功: ${success}`);
  console.log(`  跳过: ${skipped}`);
  console.log(`  失败: ${failed}`);
  console.log(`  耗时: ${Math.round((Date.now() - startTime) / 1000)}s`);
  if (interrupted) console.log('  (被中断,进度已保存,重跑即续传)');
  else if (failed > 0 || skipped > 0) console.log('  失败/跳过明细见 shallow-collect-progress.json');

  saveProgress(progress);
  await browser.close();
  db.close();
  releaseLock();
}

main().catch((e) => {
  console.error('\n致命错误:', e);
  releaseLock();
  process.exit(1);
});
