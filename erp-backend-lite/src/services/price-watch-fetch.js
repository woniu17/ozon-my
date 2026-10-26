// 价格管理页「跟卖列表」按需采集服务(2026-10-26)
// 复用 qxqx/price-watch-collect.js 的跟卖抓取链路:
//   cloakbrowser 打开 cloakbrowser/linqx-profile(含 Ozon 访问 cookie),
//   导航到买家页 /product/<sku>,页面内 fetch composer offers-modal
//   (otherOffersFromSellers) 抓取跟卖报价列表,计算对比指标后写入
//   price_watch_snapshots —— 与定时采集脚本同表同口径,前端价格管理页直接展示。
//
// profile 说明:linqx-profile 同时被 platform-orders(淘宝/1688/拼多多)使用,
//   Chromium 单实例互斥,若被平台订单浏览器/登录窗口占用,启动会失败 → profile_locked。
//   采集为低频手动操作,冲突时前端提示稍后重试即可。
//
// 并发:先 INSERT OR IGNORE price_watch_claims 原子抢占该 SKU(与定时脚本共用锁表),
//   已占用返回 claimed;无论成败 finally 释放,保证用户可立即重试。
import { launchPersistentContext } from 'cloakbrowser';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import logger from '../middleware/log.js';
import { parsePriceText, extractMyPrice, computeMetrics } from '../modules/price-watch.js';

const PAGE_GOTO_TIMEOUT_MS = 30_000;
const MODAL_TIMEOUT_MS = 15_000;
const WARMUP_MS = 3_000;
const CLAIM_TTL_MIN = 120; // 与定时采集脚本同 TTL,防误判回池

// ── 跟卖 modal 抓取注入函数(移植 price-watch-collect.js,单参数无闭包) ──
const FOLLOW_SELL_MODAL_FN = async (p) => {
  const fsSku = p?.sku;
  const timeout = p?.timeout || 15000;
  if (!fsSku) {
    return { ok: false, followSellData: null, errorReason: 'NO_SKU' };
  }
  const fsController = new AbortController();
  const fsTimer = setTimeout(() => fsController.abort(), timeout);
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
      return { ok: false, followSellData: null, errorReason: 'HTTP_' + fsResp.status, status: fsResp.status };
    }
    const fsData = await fsResp.json();
    const fsStates = fsData && fsData.widgetStates ? fsData.widgetStates : {};
    const wslKey = Object.keys(fsStates).find((k) => k.startsWith('webSellerList'));
    if (!wslKey) {
      return { ok: true, followSellData: { count: 0, sellers: [], source: 'no-sellers' }, status: fsResp.status };
    }
    let wsl = fsStates[wslKey];
    if (typeof wsl === 'string') {
      try {
        wsl = JSON.parse(wsl);
      } catch {
        return { ok: true, followSellData: { count: 0, sellers: [], source: 'parse-fail' }, status: fsResp.status };
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
    return { ok: true, followSellData: { count: rawSellers.length, sellers, source: 'modal' }, status: fsResp.status };
  } catch (e) {
    clearTimeout(fsTimer);
    const reason = e?.name === 'AbortError' ? 'TIMEOUT' : 'NET_' + (e?.message || 'error').slice(0, 60);
    return { ok: false, followSellData: null, errorReason: reason };
  }
};

// challenge 页标题识别(移植 deep-collect.js)
function isChallengeTitle(title) {
  const t = String(title || '').toLowerCase();
  return /доступ|antibot|challenge|verify|just a moment|attention/.test(t);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 单 SKU 采集:启动浏览器 → 抓跟卖 → 计算指标 → 落库 ──
// 返回:
//   { status: 'ok', snapshot }           采集成功(快照字段与列表展示对齐)
//   { status: 'claimed' }                SKU 正被其他实例采集(定时脚本/其他按需)
//   { status: 'profile_locked' }         linqx-profile 被平台订单/登录窗口占用
//   { status: 'antibot', error }         触发 Ozon 反爬
//   { status: 'error', error }           其他失败(404/网络/超时)
export async function fetchFollowSellForSku(sku, { profileDir }) {
  const skuStr = String(sku || '').trim();
  if (!/^\d+$/.test(skuStr)) return { status: 'error', error: 'sku 非法' };
  const instanceId = `pm-${process.pid}-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLAIM_TTL_MIN * 60_000).toISOString();

  // 1. 原子抢占(失败 = 正在被采集)
  const claim = db
    .prepare(
      `INSERT OR IGNORE INTO price_watch_claims (sku, instance_id, claimed_at, expires_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(skuStr, instanceId, now.toISOString(), expiresAt);
  if (claim.changes === 0) return { status: 'claimed' };

  const release = () => {
    try {
      db.prepare(`DELETE FROM price_watch_claims WHERE sku = ? AND instance_id = ?`).run(skuStr, instanceId);
    } catch { /* 忽略 */ }
  };

  let browser = null;
  try {
    // 2. 启动浏览器(linqx-profile;被 platform-orders 占用会抛错)
    browser = await launchPersistentContext({
      userDataDir: profileDir,
      headless: true,
    });
    const restored = (() => { try { return browser.pages(); } catch { return []; } })();
    for (const p of restored.slice(1)) await p.close().catch(() => {});
    const page = restored[0] || (await browser.newPage());

    // 3. warmup:访问 ozon.ru 刷新访客 cookie,降低 403 概率
    await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    await page.waitForTimeout(WARMUP_MS);
    let title = await page.title().catch(() => '');
    if (isChallengeTitle(title)) {
      await sleep(15_000);
      await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
      await page.waitForTimeout(WARMUP_MS);
      title = await page.title().catch(() => '');
      if (isChallengeTitle(title)) return { status: 'antibot', error: 'Ozon 挑战页未通过' };
    }

    // 4. 导航商品页
    const navResp = await page.goto(`https://www.ozon.ru/product/${skuStr}`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_GOTO_TIMEOUT_MS,
    });
    const navStatus = navResp?.status() || 0;
    if (navStatus === 403 || navStatus === 429) {
      return { status: 'antibot', error: `HTTP_${navStatus}` };
    }
    if (navStatus === 404) return { status: 'error', error: 'HTTP_404 商品页不存在' };
    await page.waitForTimeout(3000);
    const finalUrl = page.url();
    if (!/\/product\//.test(finalUrl)) {
      if (/challenge|access|denied/i.test(finalUrl)) return { status: 'antibot', error: '重定向到挑战页' };
      return { status: 'error', error: `重定向偏离商品页: ${String(finalUrl).slice(0, 80)}` };
    }

    // 5. 页面内 fetch 跟卖列表
    const fsRes = await page.evaluate(FOLLOW_SELL_MODAL_FN, { sku: skuStr, timeout: MODAL_TIMEOUT_MS });
    if (!fsRes?.ok) {
      const reason = String(fsRes?.errorReason || 'unknown');
      if (/HTTP_403|HTTP_429|ANTIBOT/.test(reason)) return { status: 'antibot', error: reason };
      return { status: 'error', error: reason };
    }
    const sellers = Array.isArray(fsRes.followSellData?.sellers) ? fsRes.followSellData.sellers : [];

    // 6. 我的现价 + 对比指标(与定时采集 report 同口径)
    const cache = db
      .prepare(`SELECT sku, store_id, fetched_at, data FROM product_data_cache WHERE sku = ?`)
      .get(skuStr);
    let myPrice = null;
    if (cache?.data) {
      try { myPrice = extractMyPrice(JSON.parse(cache.data)); } catch { /* 损坏置空 */ }
    }
    const m = computeMetrics(myPrice, sellers);
    const fetchedAt = new Date().toISOString();

    // 7. 落库(与 price-watch report 同字段)
    db.prepare(
      `INSERT INTO price_watch_snapshots
        (sku, store_id, my_price, seller_count, min_price, median_price, avg_price,
         my_rank, is_cheapest, gap_abs, gap_pct, vs_median, sellers,
         status, error_reason, price_fetched_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      skuStr, cache?.store_id || null, myPrice, m.sellerCount, m.minPrice, m.medianPrice, m.avgPrice,
      m.myRank, m.isCheapest, m.gapAbs, m.gapPct, m.vsMedian,
      JSON.stringify(sellers),
      m.sellerCount > 0 ? 'ok' : 'empty', m.sellerCount > 0 ? null : String(fsRes.followSellData?.source || 'no-sellers'),
      cache?.fetched_at || null, fetchedAt
    );

    return {
      status: 'ok',
      snapshot: {
        sku: skuStr,
        myPrice,
        sellerCount: m.sellerCount,
        minPrice: m.minPrice,
        medianPrice: m.medianPrice,
        avgPrice: m.avgPrice,
        myRank: m.myRank,
        isCheapest: m.isCheapest,
        gapAbs: m.gapAbs,
        gapPct: m.gapPct,
        vsMedian: m.vsMedian,
        status: m.sellerCount > 0 ? 'ok' : 'empty',
        fetchedAt,
      },
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // profile 被其它 Chromium 实例占用(platform-orders 浏览器/登录窗口)
    if (/single|in use|user data|locked|crashed|Target|closed/i.test(msg)) {
      return { status: 'profile_locked', error: msg };
    }
    logger.warn({ err: msg, sku: skuStr }, '[price-watch-fetch] 采集失败');
    return { status: 'error', error: msg.slice(0, 120) };
  } finally {
    try { await browser?.close(); } catch { /* 忽略 */ }
    release();
  }
}