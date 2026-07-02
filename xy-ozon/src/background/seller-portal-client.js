// Seller Portal 真实客户端 —— 从原项目 0.13.31.1 抽离的核心数据采集逻辑。
// 负责 Phase 3 变体预取:直连 seller.ozon.ru,带真实 cookie/UA/fingerprint。
//
// 核心能力(对齐原项目):
//   1. fetchSellerPortal        通用 portal 请求(节流闸门 + 跨域快路 + seller tab 回退)
//   2. fetchSellerViaOzonTab    跨域快路(从 www.ozon.ru tab MAIN world 直发)
//   3. ensureSellerTab          找/开 seller.ozon.ru tab
//   4. searchVariants           /api/v1/search 拿 variant_id + 基础 attr
//   5. fetchBundleByVariantId   /api/site/seller-prototype/create-bundle-by-variant-id 补完整 attr
//   6. normalizeSearchVariantToSv  归一化 /search 返回为 sv shape
//   7. resolveSellerCompanyId   读 sc_company_id cookie
//   8. classifyError            403 细分(ANTIBOT_BLOCKED / AUTH_REQUIRED)
//
// 注意:本模块只做「读」(数据采集),不做「写」(建品 6b-6d 仍走 mock-seller-portal)。

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 全局节流闸门 —— 所有 portal 调用串行,相邻至少 200ms(对齐原项目)
  // ────────────────────────────────────────────────────────────
  const SELLER_PORTAL_MIN_INTERVAL_MS = 200;
  let _gatePromise = Promise.resolve();
  let _gateLastTs = 0;

  function _sellerPortalGate() {
    const run = async () => {
      const now = Date.now();
      const wait = Math.max(0, SELLER_PORTAL_MIN_INTERVAL_MS - (now - _gateLastTs));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      _gateLastTs = Date.now();
    };
    _gatePromise = _gatePromise.then(run, run);
    return _gatePromise;
  }

  // ────────────────────────────────────────────────────────────
  // 403 错误细分(对齐原项目 classifyError)
  // ────────────────────────────────────────────────────────────
  function classifyError(e) {
    const msg = e.message || String(e);
    const status = typeof e.status === 'number' ? e.status : null;
    const code = typeof e.code === 'string' ? e.code : null;
    let errorCode = 'UNKNOWN_ERROR';
    if (status === 404 && code === 'ResourceNotFound') {
      errorCode = 'NOT_IN_OWN_CATALOG';
    } else if (msg.includes('请先打开') || msg.includes('No seller tab') || msg.includes('无可用 seller')) {
      errorCode = 'NO_SELLER_TAB';
    } else if (msg.includes('Cannot access contents') || msg.includes('permission to access')) {
      errorCode = 'PERMISSION_DENIED';
    } else if (
      status === 401 ||
      code === 'AUTH_REDIRECT' ||
      msg.includes('sc_company_id') ||
      msg.includes('过期') ||
      msg.includes('登录') ||
      msg.includes('signin') ||
      msg.includes('login')
    ) {
      errorCode = 'AUTH_REQUIRED';
    } else if (status === 403 || msg.includes('403')) {
      // 403 细分:Ozon 反爬挑战是 HTML 页;company_id 失效是结构化 JSON。
      const blob = `${code || ''} ${msg}`.toLowerCase();
      const looksHtmlChallenge =
        /<html|<!doctype|just a moment|attention required|enable javascript|are you a robot|вы не робот|captcha|challenge|too many requests/.test(
          blob
        );
      const looksStructuredApiError =
        /"code"|"message"|permission_?denied|company_?id|sc_company|unauthenticated|invalid.?token|session/.test(blob);
      errorCode = looksStructuredApiError && !looksHtmlChallenge ? 'AUTH_REQUIRED' : 'ANTIBOT_BLOCKED';
    } else if (
      msg.includes('超时') ||
      msg.includes('timeout') ||
      msg.includes('AbortError') ||
      msg.includes('Timeout')
    ) {
      errorCode = 'TIMEOUT';
    } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('network')) {
      errorCode = 'NETWORK_ERROR';
    }
    return { errorCode, msg };
  }

  // ────────────────────────────────────────────────────────────
  // 解析 sc_company_id
  // 多路探测:unpartitioned → partitioned → www.ozon.ru 域 → 列全部 cookie 辅助诊断
  // ────────────────────────────────────────────────────────────
  async function resolveSellerCompanyId() {
    // 路 1:标准查 seller.ozon.ru 的 sc_company_id(unpartitioned)
    try {
      const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
      if (scCookies[0]?.value) {
        console.log('[resolveSellerCompanyId] 命中 seller.ozon.ru unpartitioned:', scCookies[0].value);
        return scCookies[0].value;
      }
    } catch (e) {
      console.warn('[resolveSellerCompanyId] 路1失败:', e?.message || e);
    }

    // 路 2:partitioned cookie(Chrome CHIPS,cookie 可能被 partition 到 seller.ozon.ru 顶级站)
    try {
      const partitioned = await chrome.cookies.getAll({
        url: 'https://seller.ozon.ru/',
        name: 'sc_company_id',
        partitionKey: { topLevelSite: 'https://seller.ozon.ru' },
      });
      if (partitioned[0]?.value) {
        console.log('[resolveSellerCompanyId] 命中 partitioned(seller.ozon.ru):', partitioned[0].value);
        return partitioned[0].value;
      }
    } catch {}
    // partitionKey www.ozon.ru 顶级站
    try {
      const partitioned2 = await chrome.cookies.getAll({
        url: 'https://seller.ozon.ru/',
        name: 'sc_company_id',
        partitionKey: { topLevelSite: 'https://www.ozon.ru' },
      });
      if (partitioned2[0]?.value) {
        console.log('[resolveSellerCompanyId] 命中 partitioned(www.ozon.ru):', partitioned2[0].value);
        return partitioned2[0].value;
      }
    } catch {}

    // 路 3:www.ozon.ru 域(cookie 域级共享时可能设在 .ozon.ru)
    try {
      const wwwCookies = await chrome.cookies.getAll({ url: 'https://www.ozon.ru/', name: 'sc_company_id' });
      if (wwwCookies[0]?.value) {
        console.log('[resolveSellerCompanyId] 命中 www.ozon.ru:', wwwCookies[0].value);
        return wwwCookies[0].value;
      }
    } catch {}

    // 路 4:用 domain 查 .ozon.ru 所有 cookie
    try {
      const domainCookies = await chrome.cookies.getAll({ domain: 'ozon.ru' });
      const hit = domainCookies.find((c) => c.name === 'sc_company_id');
      if (hit?.value) {
        console.log('[resolveSellerCompanyId] 命中 domain=ozon.ru:', hit.value);
        return hit.value;
      }
      // 诊断:列出所有 cookie name,帮排查到底有哪些 cookie
      const names = domainCookies.map((c) => `${c.name}@${c.domain}`).sort();
      console.warn(
        `[resolveSellerCompanyId] cookies API 未返回 sc_company_id(共 ${domainCookies.length} 个 cookie):`,
        names
      );
    } catch (e) {
      console.warn('[resolveSellerCompanyId] 路4诊断失败:', e?.message || e);
    }

    // 路 5(fallback):chrome.cookies API 读不到时,直接从 tab 的 document.cookie 读取。
    // 某些 Chrome 版本对非 __Secure 前缀的第三方 cookie 有读取限制,
    // 但页面内 document.cookie 一定能读到非 HttpOnly cookie。
    const tabCompanyId = await resolveSellerCompanyIdViaTab();
    if (tabCompanyId) {
      console.log('[resolveSellerCompanyId] 命中 document.cookie(tab 注入):', tabCompanyId);
      return tabCompanyId;
    }

    return '';
  }

  // ────────────────────────────────────────────────────────────
  // resolveSellerCompanyIdViaTab —— 从 ozon.ru tab 的 document.cookie 读 sc_company_id
  // 绕过 chrome.cookies API 的读取限制(第三方 cookie / cookie store 隔离)
  // ────────────────────────────────────────────────────────────
  async function resolveSellerCompanyIdViaTab() {
    const readCookie = () => {
      // document.cookie 只能读非 HttpOnly cookie,sc_company_id 不是 HttpOnly
      const match = document.cookie.match(/(?:^|;\s*)sc_company_id=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    };

    // 优先从 seller.ozon.ru tab 读
    try {
      const sellerTabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
      const ready = sellerTabs.find((t) => t.status === 'complete');
      if (ready) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: ready.id },
          func: readCookie,
          world: 'MAIN',
        });
        const val = results?.[0]?.result;
        if (val) return val;
      }
    } catch (e) {
      console.warn('[resolveSellerCompanyIdViaTab] seller tab 读取失败:', e?.message || e);
    }

    // 回退:从 www.ozon.ru tab 读(cookie 域 .ozon.ru 共享)
    try {
      const ozonTabs = await chrome.tabs.query({ url: 'https://www.ozon.ru/*' });
      const ready = ozonTabs.find((t) => t.status === 'complete');
      if (ready) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: ready.id },
          func: readCookie,
          world: 'MAIN',
        });
        const val = results?.[0]?.result;
        if (val) return val;
      }
    } catch (e) {
      console.warn('[resolveSellerCompanyIdViaTab] www tab 读取失败:', e?.message || e);
    }

    return '';
  }

  // ────────────────────────────────────────────────────────────
  // ensureSellerTab —— 找/开 seller.ozon.ru tab(对齐原项目)
  // ────────────────────────────────────────────────────────────
  let _ensureSellerTabInflight = null;

  function ensureSellerTab(timeoutMs = 20000) {
    if (_ensureSellerTabInflight) return _ensureSellerTabInflight;
    _ensureSellerTabInflight = _ensureSellerTabImpl(timeoutMs).finally(() => {
      _ensureSellerTabInflight = null;
    });
    return _ensureSellerTabInflight;
  }

  async function _ensureSellerTabImpl(timeoutMs = 20000) {
    const queryTabs = () => chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
    const isAuthUrl = (u) => /\/(registration|signin|auth|login)/i.test(u || '');
    const pickReadyTab = (list) =>
      list.find((t) => t.status === 'complete' && t.url?.includes('/app/') && !isAuthUrl(t.url)) ||
      list.find((t) => t.status === 'complete' && !isAuthUrl(t.url)) ||
      list.find((t) => t.status === 'complete' && t.url?.includes('/app/')) ||
      list.find((t) => t.status === 'complete') ||
      null;

    let tabs = await queryTabs();
    let ready = pickReadyTab(tabs);
    if (ready) return ready;

    // 有 tab 但都在 loading → 等它们 complete
    if (tabs.length) {
      console.log('[ensureSellerTab] 已有 tab 但都在加载中,等待 complete...');
      const waitDeadline = Date.now() + timeoutMs;
      while (Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 500));
        tabs = await queryTabs();
        ready = pickReadyTab(tabs);
        if (ready) return ready;
        if (tabs.length === 0) break;
      }
    }

    // 无 tab 或等待超时 → 新开一个
    console.log('[ensureSellerTab] 无可用 seller.ozon.ru tab,后台打开...');
    const created = await chrome.tabs.create({
      url: 'https://seller.ozon.ru/app/products/copy/list',
      active: false,
      pinned: true,
    });

    const createDeadline = Date.now() + timeoutMs;
    while (Date.now() < createDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const t = await chrome.tabs.get(created.id);
        if (t.status === 'complete') {
          console.log(`[ensureSellerTab] tab ${created.id} 加载完成,url=${t.url}`);
          return t;
        }
      } catch {
        throw new Error('自动打开的 seller.ozon.ru tab 已被关闭');
      }
    }
    throw new Error(`seller.ozon.ru tab 加载超时(${timeoutMs / 1000}s)`);
  }

  // ────────────────────────────────────────────────────────────
  // 跨域快路 fetchSellerViaOzonTab —— 从 www.ozon.ru tab MAIN world 直发
  // (对齐原项目,cookie 域级共享,免依赖 seller 专用标签)
  // ────────────────────────────────────────────────────────────
  async function fetchSellerViaOzonTab(path, body, opts = {}, preferTabId = null) {
    const timeoutMs = opts.timeoutMs || 30000;
    const urlPrefix = opts.urlPrefix !== undefined ? opts.urlPrefix : '/api/v1';

    // 解析目标标签:优先消息来源标签(用户正所在的 www 商品页),否则任意已加载完成的 *.ozon.ru 标签
    const isOzonUrl = (u) => /^https?:\/\/([^/]+\.)?ozon\.ru\//i.test(u || '');
    let target = null;
    if (preferTabId) {
      try {
        const t = await chrome.tabs.get(preferTabId);
        if (t && isOzonUrl(t.url)) target = t;
      } catch {}
    }
    if (!target) {
      const tabs = await chrome.tabs.query({ url: ['*://*.ozon.ru/*'] });
      target =
        tabs.find((t) => t.status === 'complete' && t.active) || tabs.find((t) => t.status === 'complete') || null;
    }
    if (!target) {
      const e = new Error('无可用 ozon.ru 标签(跨域快路)');
      e.tabUnavailable = true;
      throw e;
    }

    // 注入 MAIN world 的跨域 fetch:严格只用 CORS-safelisted 头(content-type:text/plain),
    // company_id 已在 body 内。任何自定义头都会触发预检 → seller 不放行 → Failed to fetch。
    const doFetchXO = async (apiPath, reqBody, timeout, prefix) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await fetch('https://seller.ozon.ru' + (prefix || '/api/v1') + apiPath, {
          method: 'POST',
          signal: controller.signal,
          credentials: 'include',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify(reqBody),
        });
        clearTimeout(timer);
        if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
          return { ok: false, status: 401, code: 'AUTH_REDIRECT', error: 'Seller portal cookie已过期,请重新登录' };
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          let parsedCode = '';
          try {
            const j = JSON.parse(text);
            parsedCode = (j && (j.code || (j.error && j.error.code))) || '';
          } catch {}
          return {
            ok: false,
            status: resp.status,
            code: parsedCode,
            error: `Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}`,
          };
        }
        return { ok: true, data: await resp.json() };
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') return { ok: false, error: `请求超时 (${timeout}ms)` };
        return { ok: false, error: e.message || String(e) };
      }
    };

    let results;
    try {
      results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: target.id },
          func: doFetchXO,
          args: [path, body, timeoutMs, urlPrefix],
          world: 'MAIN',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), timeoutMs + 5000)),
      ]);
    } catch (e) {
      const err = new Error(`ozon-tab 注入失败: ${e.message || e}`);
      err.tabUnavailable = true;
      throw err;
    }
    const r = results?.[0]?.result;
    if (!r) {
      const e = new Error('ozon-tab executeScript 未返回结果');
      e.tabUnavailable = true;
      throw e;
    }
    if (!r.ok) {
      const err = new Error(r.error || 'unknown');
      if (typeof r.status === 'number') err.status = r.status;
      if (typeof r.code === 'string') err.code = r.code;
      throw err;
    }
    console.log(`[fetchSellerViaOzonTab] ok tab=${target.id} path=${path}`);
    return r.data;
  }

  // ────────────────────────────────────────────────────────────
  // fetchSellerPortal —— 通用 portal 请求(对齐原项目)
  // 流程:跨域快路(allowOzonTab 时) → ensureSellerTab + executeScript 回退
  // ────────────────────────────────────────────────────────────
  async function fetchSellerPortal(path, body, timeoutMsOrOpts = 30000) {
    await _sellerPortalGate();
    const opts = typeof timeoutMsOrOpts === 'number' ? { timeoutMs: timeoutMsOrOpts } : timeoutMsOrOpts || {};
    const timeoutMs = opts.timeoutMs || 30000;
    const urlPrefix = opts.urlPrefix !== undefined ? opts.urlPrefix : '/api/v1';
    const pageType = opts.pageType || 'products-other';

    // 0. 跨域快路
    if (opts.allowOzonTab) {
      try {
        return await fetchSellerViaOzonTab(path, body, opts, opts.preferTabId);
      } catch (e) {
        if (e.status === 404 && e.code === 'ResourceNotFound') throw e;
        console.warn(`[fetchSellerPortal] ozon-tab 快路失败,回退 seller-tab: ${e.message || e}`);
      }
    }

    // 1. seller tab 回退
    const targetTab = await ensureSellerTab();
    console.log(`[fetchSellerPortal] tab=${targetTab.id} url=${targetTab.url} path=${path}`);

    // 2. 解析 sc_company_id
    const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
    const companyId = scCookies[0]?.value || '';
    if (!companyId) {
      throw new Error('sc_company_id cookie 未找到,请确保已登录 seller.ozon.ru');
    }

    // 3. executeScript 在 seller tab 内发 fetch
    const doFetch = async (apiPath, reqBody, xCompanyId, timeout, prefix, pageTypeHdr) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await fetch('https://seller.ozon.ru' + (prefix || '/api/v1') + apiPath, {
          method: 'POST',
          signal: controller.signal,
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-o3-app-name': 'seller-ui',
            'x-o3-company-id': xCompanyId,
            'x-o3-language': 'zh-Hans',
            'x-o3-page-type': pageTypeHdr || 'products-other',
          },
          body: JSON.stringify(reqBody),
        });
        clearTimeout(timer);
        if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
          const e = new Error('Seller portal cookie已过期,请重新登录');
          e.status = 401;
          e.code = 'AUTH_REDIRECT';
          throw e;
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          let parsedCode = '';
          try {
            const j = JSON.parse(text);
            parsedCode = (j && (j.code || (j.error && j.error.code))) || '';
          } catch {}
          const e = new Error(`Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}`);
          e.status = resp.status;
          e.code = parsedCode;
          throw e;
        }
        return await resp.json();
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') {
          const err = new Error(`请求超时 (${timeout}ms)`);
          err.code = 'TIMEOUT';
          throw err;
        }
        throw e;
      }
    };

    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: doFetch,
      args: [path, body, companyId, timeoutMs, urlPrefix, pageType],
      world: 'MAIN',
    });
    const r = results?.[0]?.result;
    if (r === undefined || r === null) {
      throw new Error('seller tab executeScript 未返回结果');
    }
    return r;
  }

  // ────────────────────────────────────────────────────────────
  // normalizeSearchVariantToSv —— /search 返回归一化为 sv shape(对齐原项目)
  //
  // ⚠️ 字段命名历史包袱(对齐 0.13 service-worker.js:420):
  //   sv.description_category_id = Number(v.description_type_dict_value) || 0
  // 这是个混淆命名 —— v.description_type_dict_value 实际是 type_id(类型字典值),
  // 不是 description_category_id(类目 ID)。下游 prepare-bundle.js 据此解析 type_id。
  //
  // /search 响应有时也会带真正的 v.description_category_id 字段(叶子类目 ID),
  // 这里额外保留为 sv.search_description_category_id,供 prepare-bundle.js 优先使用。
  // ────────────────────────────────────────────────────────────
  function normalizeSearchVariantToSv(v) {
    if (!v) return null;
    // 已是 sv shape(含 attributes 数组)→ 原样返回
    if (Array.isArray(v.attributes) && v.attributes.length > 0) return v;
    const attributes = [];
    if (v.description_type_name) attributes.push({ key: '8229', value: v.description_type_name });
    if (v.brand_name) attributes.push({ key: '85', value: v.brand_name });
    const productName = v.variant_name || v.title || v.name;
    if (productName) attributes.push({ key: '4180', value: productName });
    if (v.description) attributes.push({ key: '4191', value: v.description });
    if (v.main_image) attributes.push({ key: '4194', value: v.main_image });
    const secondaries = Array.isArray(v.secondary_images) ? v.secondary_images : [];
    if (secondaries.length > 0) attributes.push({ key: '4195', collection: secondaries });
    if (Array.isArray(v.barcodes) && v.barcodes.length > 0) {
      const gtin = String(v.barcodes[0] || '').trim();
      if (gtin) attributes.push({ key: '7822', value: gtin });
    }

    // description_type_dict_value 实际是 type_id;若 /search 同时返回了真正的
    // description_category_id 字段(叶子类目 ID),额外保留以免后端解析时丢失。
    const svTypeId = Number(v.description_type_dict_value) || 0;
    const searchDescCatId = Number(v.description_category_id) || 0;
    const out = {
      variant_id: v.variant_id || (v.barcodes && v.barcodes[0]) || '',
      // ⚠️ 混淆命名:实际是 type_id(来自 description_type_dict_value),对齐 0.13
      description_category_id: svTypeId,
      categories: (v.categories || []).map((c) => ({
        id: Number(c.id),
        level: Number(c.level),
        name: c.name || '',
        title: c.title || c.name || '',
      })),
      _searchMeta: {
        skus: v.skus || [],
        barcodes: v.barcodes || [],
        brand_id: v.brand_id,
        is_copy_allowed: v.is_copy_allowed,
        is_content_copy_allowed: v.is_content_copy_allowed,
        rating: v.rating,
      },
      attributes,
    };
    // 仅当 /search 真返回了 description_category_id 且与 type_id 不同时才补,
    // 避免与混淆命名的 sv.description_category_id 冲突。
    if (searchDescCatId && searchDescCatId !== svTypeId) {
      out.search_description_category_id = searchDescCatId;
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────
  // bundle cache —— chrome.storage.local 24h 缓存(对齐 0.13 service-worker.js:464-516)
  // cache key 含 companyId + variantId,防同一 Chrome profile 多店串数据
  // ────────────────────────────────────────────────────────────
  const _BUNDLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
  // v2 cache key 含 companyId + variantId:v1(只含 sku)会让 B 店复用 A 店的 bundle
  // item,串店导致重量/尺寸/属性串数据。variant_id 在 Ozon 内是 store-scoped,加
  // companyId 双保险。
  const _BUNDLE_CACHE_PREFIX = 'jz-sw-bundle-v2:';
  const _bundleCacheKey = (companyId, variantId) => `${_BUNDLE_CACHE_PREFIX}${companyId || 'unknown'}:${variantId}`;

  // SW 启动时清理 v1 旧缓存 —— 它的 key 只含 sku,可能跨店污染过用户数据。
  // 一次性清理,跑完后用户的 v2 缓存重建即可。
  (async () => {
    try {
      const all = await new Promise((r) => chrome.storage.local.get(null, r));
      const stale = Object.keys(all || {}).filter((k) => k.startsWith('jz-sw-bundle-v1:'));
      if (stale.length) {
        await new Promise((r) => chrome.storage.local.remove(stale, r));
        console.log(`[SW] cleared ${stale.length} v1 bundle cache entries (cross-store risk)`);
      }
    } catch {}
  })();

  // ────────────────────────────────────────────────────────────
  // fetchBundleByVariantId —— 补完整 attributes(对齐原项目,带 24h 缓存)
  // chrome.storage.local 24h 缓存;forceRefresh=true 跳过缓存直拉
  // companyId 为 null(未登录)时不缓存,直接请求
  // ────────────────────────────────────────────────────────────
  async function fetchBundleByVariantId(sku, variantId, companyId, opts = {}) {
    // companyId 存在时才走缓存;null(未登录)直接请求,不读不写
    const cacheKey = companyId ? _bundleCacheKey(companyId, variantId) : null;

    // 命中缓存且未过期且非 forceRefresh → 直接返回,不请求 seller.ozon.ru
    if (cacheKey && !opts.forceRefresh) {
      try {
        const cached = await new Promise((resolve) => {
          chrome.storage.local.get([cacheKey], (data) => resolve(data?.[cacheKey] || null));
        });
        if (cached && Date.now() - (cached.at || 0) < _BUNDLE_CACHE_TTL_MS && cached.item) {
          return cached.item;
        }
      } catch {}
    }

    const resp = await fetchSellerPortal(
      '/seller-prototype/create-bundle-by-variant-id',
      {
        company_id: String(companyId),
        variant_id: String(variantId),
        source: 'SOURCE_UI_COPY_APPAREL',
      },
      {
        urlPrefix: '/api/site',
        pageType: 'products',
        timeoutMs: 30000,
        allowOzonTab: true,
        preferTabId: opts.preferTabId,
      }
    );
    const item = resp?.item || null;
    if (!item) return null;

    // 写缓存(仅 companyId 存在时;含 sku + bundle_id 便于 debug,item 才是数据本体)
    if (cacheKey) {
      try {
        chrome.storage.local.set({
          [cacheKey]: { at: Date.now(), item, sku, bundleId: resp.bundle_id || null },
        });
      } catch {}
    }

    return item;
  }

  // ────────────────────────────────────────────────────────────
  // searchVariants —— Phase 3 核心入口(对齐原项目 case 'searchVariants')
  // 返回归一化 sv(含 bundle 补的物理 attr)
  // ────────────────────────────────────────────────────────────
  async function searchVariants(sku, opts = {}) {
    const preferTabId = opts.preferTabId || null;
    const forceRefresh = Boolean(opts.forceRefresh);

    // /search 必须 body 带 company_id(否则 403 PermissionDenied)
    const companyId = await resolveSellerCompanyId();
    if (!companyId) {
      const err = new Error('sc_company_id cookie 未找到,请先登录 seller.ozon.ru');
      err.code = 'AUTH_REQUIRED';
      throw err;
    }

    const MAX_RETRIES = 2;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetchSellerPortal(
          '/search',
          {
            company_id: companyId,
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
          {
            urlPrefix: '/api/v1',
            pageType: 'products',
            timeoutMs: 30000,
            allowOzonTab: true,
            preferTabId,
          }
        );

        const rawVariants = Array.isArray(resp?.variants)
          ? resp.variants
          : Array.isArray(resp?.items)
            ? resp.items
            : Array.isArray(resp?.products)
              ? resp.products
              : Array.isArray(resp)
                ? resp
                : [];
        const items = rawVariants.map(normalizeSearchVariantToSv).filter(Boolean);
        if (items.length === 0) {
          console.log(`[searchVariants] sku=${sku} no variants from /search`);
          return null; // 未找到
        }

        // Step 2: bundle 补完整 attributes(物理 + 40-63 个完整 attr)
        try {
          const variantId = items[0].variant_id;
          if (variantId) {
            const bundleItem = await fetchBundleByVariantId(sku, variantId, companyId, {
              forceRefresh,
              preferTabId,
            });
            if (bundleItem) {
              const existingKeys = new Set(items[0].attributes.map((a) => String(a.key)));
              const physicalAttrs = [];
              if (Number(bundleItem.weight) > 0 && !existingKeys.has('4497')) {
                physicalAttrs.push({ key: '4497', value: String(bundleItem.weight) });
              }
              if (Number(bundleItem.depth) > 0 && !existingKeys.has('9454')) {
                physicalAttrs.push({ key: '9454', value: String(bundleItem.depth) });
              }
              if (Number(bundleItem.width) > 0 && !existingKeys.has('9455')) {
                physicalAttrs.push({ key: '9455', value: String(bundleItem.width) });
              }
              if (Number(bundleItem.height) > 0 && !existingKeys.has('9456')) {
                physicalAttrs.push({ key: '9456', value: String(bundleItem.height) });
              }
              if (bundleItem.barcode && !existingKeys.has('7822')) {
                physicalAttrs.push({ key: '7822', value: String(bundleItem.barcode) });
              }

              // bundle 简单 attr(complex_id=0)转成 sv 兼容 shape
              const bundleComplexAttrs = [];
              if (Array.isArray(bundleItem.attributes)) {
                for (const ba of bundleItem.attributes) {
                  if (ba.complex_id && String(ba.complex_id) !== '0') {
                    bundleComplexAttrs.push(ba);
                    continue;
                  }
                  const key = String(ba.attribute_id || '');
                  if (!key || existingKeys.has(key)) continue;
                  const vals = Array.isArray(ba.values)
                    ? ba.values.filter((v) => v && v.value != null && v.value !== '')
                    : [];
                  if (vals.length === 0) continue;
                  if (vals.length > 1) {
                    physicalAttrs.push({ key, collection: vals.map((v) => String(v.value)) });
                  } else {
                    physicalAttrs.push({ key, value: String(vals[0].value) });
                  }
                  existingKeys.add(key);
                }
              }

              if (physicalAttrs.length > 0) {
                items[0] = { ...items[0], attributes: [...items[0].attributes, ...physicalAttrs] };
              }
              if (bundleComplexAttrs.length > 0) {
                items[0]._bundleComplexAttrs = bundleComplexAttrs;
              }
              // 完整 bundle item 也挂上(供高级 caller 用)
              items[0]._bundleItem = bundleItem;

              // DEBUG: dump bundle item 的分类/类型字段,排查 description_type_is_empty
              try {
                const biKeys = bundleItem ? Object.keys(bundleItem) : [];
                console.log(`[searchVariants] bundleItem keys for sku=${sku}:`, biKeys.slice(0, 40));
                console.log(
                  `[searchVariants] bundleItem description_category_id=${bundleItem?.description_category_id}, type_id=${bundleItem?.type_id}`
                );
                // 检查 bundle item 内可能嵌套的字段
                if (bundleItem?.category) {
                  console.log(
                    `[searchVariants] bundleItem.category=`,
                    JSON.stringify(bundleItem.category).slice(0, 200)
                  );
                }
                if (bundleItem?.description_category) {
                  console.log(
                    `[searchVariants] bundleItem.description_category=`,
                    JSON.stringify(bundleItem.description_category).slice(0, 200)
                  );
                }
                // /search 原始字段
                console.log(
                  `[searchVariants] /search description_type_dict_value=${items[0]?.description_category_id}, categories count=${(items[0]?.categories || []).length}`
                );
                if (Array.isArray(items[0]?.categories) && items[0].categories.length > 0) {
                  console.log(
                    `[searchVariants] /search categories=`,
                    items[0].categories.map((c) => ({ id: c.id, level: c.level, name: c.name }))
                  );
                }
              } catch (_) {
                // ignore logging errors
              }
            }
          }
        } catch (e) {
          console.warn(`[searchVariants] bundle injection failed for sku=${sku}:`, e.message || e);
        }

        return items[0];
      } catch (e) {
        lastErr = e;
        const { errorCode, msg } = classifyError(e);
        // 业务空结果(404):立即返回 null
        if (errorCode === 'NOT_IN_OWN_CATALOG') {
          console.log(`[searchVariants] sku=${sku} not found on platform (404)`);
          return null;
        }
        console.warn(`[searchVariants] attempt ${attempt}/${MAX_RETRIES} failed [${errorCode}]:`, msg);
        const isRetryable = ['TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_ERROR'].includes(errorCode);
        if (attempt >= MAX_RETRIES || !isRetryable) {
          const err = new Error(`[${errorCode}] ${msg}`);
          err.code = errorCode;
          throw err;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw lastErr || new Error('searchVariants 未知失败');
  }

  // ────────────────────────────────────────────────────────────
  // searchProductBySku —— 全平台降级搜索(对齐原项目 case 'searchProductBySku')
  // searchVariants 没命中(陌生 SKU)时用 /api/v1/search 全平台 API,不做 bundle 补充
  // ────────────────────────────────────────────────────────────
  async function searchProductBySku(sku, opts = {}) {
    const preferTabId = opts.preferTabId || null;
    const companyId = await resolveSellerCompanyId();
    const resp = await fetchSellerPortal(
      '/search',
      {
        company_id: companyId,
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
      {
        urlPrefix: '/api/v1',
        pageType: 'products',
        timeoutMs: 30000,
        allowOzonTab: true,
        preferTabId,
      }
    );
    const rawVariants = Array.isArray(resp?.variants)
      ? resp.variants
      : Array.isArray(resp?.items)
        ? resp.items
        : Array.isArray(resp?.products)
          ? resp.products
          : Array.isArray(resp)
            ? resp
            : [];
    return rawVariants.map(normalizeSearchVariantToSv).filter(Boolean);
  }

  // ────────────────────────────────────────────────────────────
  // syncSellerCookies —— 刷新 seller.ozon.ru 登录态
  // 对齐原项目:打开 seller tab 触发 cookie 刷新
  // ────────────────────────────────────────────────────────────
  async function syncSellerCookies() {
    try {
      const tab = await ensureSellerTab();
      // 触发一次轻量请求刷新 session
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => fetch('https://seller.ozon.ru/api/v1/user/me', { credentials: 'include' }).catch(() => {}),
        world: 'MAIN',
      });
      return true;
    } catch (e) {
      console.warn('[syncSellerCookies] failed:', e?.message || e);
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────
  // getUploadTaskList —— Phase 7 轮询:拉 async-upload 任务列表
  // 对齐原项目 getUploadTaskList
  // ────────────────────────────────────────────────────────────
  async function getUploadTaskList(companyId, opts = {}, preferTabId = null) {
    return fetchSellerPortal(
      '/async-upload/v1/task/get-list',
      {
        company_id: String(companyId),
        limit: opts.limit || 30,
        page: opts.page || 1,
      },
      {
        urlPrefix: '/api/site',
        pageType: 'products',
        timeoutMs: 15000,
        allowOzonTab: true,
        preferTabId,
      }
    );
  }

  // ────────────────────────────────────────────────────────────
  // getUploadTaskErrors —— Phase 7 轮询:拉失败任务错误明细
  // 对齐原项目 getUploadTaskErrors
  // ────────────────────────────────────────────────────────────
  async function getUploadTaskErrors(companyId, taskId, opts = {}, preferTabId = null) {
    return fetchSellerPortal(
      '/async-upload/v1/task/get-errors',
      {
        company_id: String(companyId),
        task_id: Number(taskId),
        page: opts.page || 1,
        page_size: opts.page_size || 50,
      },
      {
        urlPrefix: '/api/site',
        pageType: 'products',
        timeoutMs: 15000,
        allowOzonTab: true,
        preferTabId,
      }
    );
  }

  // ────────────────────────────────────────────────────────────
  // 门户建品写操作(对齐 0.13 service-worker.js:567-627)
  // 6b/6c/6d 三步建品,复用 fetchSellerPortal(自动走 200ms 闸门 + 跨域快路 + 403 细分)
  // ────────────────────────────────────────────────────────────
  const _bundlePortalOpts = (preferTabId, timeoutMs = 30000) => ({
    urlPrefix: '/api/site',
    pageType: 'products',
    timeoutMs,
    allowOzonTab: true,
    preferTabId,
  });

  // 6b. 建空草稿 → bundle_id
  //
  // 对齐官方 seller-ui app.js (pos 748579):
  //   Request:  { company_id, description_category_lvl3_name, source_item_id }
  //   Response: { bundle_id }
  //
  // - description_category_lvl3_name: 三级类目名(按名匹配,避免跨店类目 ID 错位)
  // - source_item_id: 复制流程的源商品 ID(新建流程不传)
  //
  // 两个新参数均为可选,缺省时与官方新建流程行为一致(source_item_id=undefined)。
  async function createBundle(companyId, preferTabId = null, opts = {}) {
    const body = {
      company_id: String(companyId),
    };
    // 类目名(按名匹配):ERP prepare-bundle-items 返回的 bundle.description_category_lvl3_name
    if (opts.catName) {
      body.description_category_lvl3_name = String(opts.catName);
    }
    // 复制流程源商品 ID(可选):用于服务端关联源商品数据
    if (opts.sourceItemId) {
      body.source_item_id = String(opts.sourceItemId);
    }
    const resp = await fetchSellerPortal('/seller-prototype/create-bundle', body, _bundlePortalOpts(preferTabId));
    const bundleId = resp?.bundle_id;
    if (!bundleId) throw new Error('create-bundle 未返回 bundle_id');
    return String(bundleId);
  }

  // 6c. 写入商品数据(可反复调)
  //
  // 对齐官方 seller-ui app.js (pos 752644, 755277):
  //   Request:  { bundle_id, company_id, items, source }
  //   Response: {} (fire-and-forget 草稿同步)
  //
  // ⚠️ 不含 description_category_lvl3_name —— 类目信息已在 create-bundle 时固化到 bundle,
  //    每个 item 自身的类目通过 description_category_id / new_description_category_id 携带。
  //
  // 参考 /v3/product/import 官方 API schema(v3ImportProductsRequestItem)必填字段:
  //   required: attributes, description_category_id, depth, dimension_unit, height,
  //             images, name, offer_id, price, vat, weight, weight_unit, width, type_id
  //
  // 门户 update-bundle-items proto 与 v3 基本一致,差异:
  //   - type_id / description_category_id 为 0 时不传(让 Ozon 走 create-bundle 时的 lvl3_name 按名匹配)
  //
  // 此函数对每个 item 做字段归一化 + 必填校验,确保提交数据满足 v3 schema。
  async function updateBundleItems(bundleId, companyId, items, source, preferTabId = null) {
    const normalizedItems = (Array.isArray(items) ? items : []).map((item, idx) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`update-bundle-items: items[${idx}] 不是对象`);
      }

      // ── 归一化:确保字段类型对齐 v3 schema ──
      const out = {
        // 字符串字段
        offer_id: String(item.offer_id || ''),
        name: String(item.name || ''),
        price: String(item.price || '0'),
        old_price: String(item.old_price || item.price || '0'),
        vat: String(item.vat || '0'),
        currency_code: String(item.currency_code || 'RUB'),
        // 物理参数(数字,缺省 100 兜底,对齐 v3 示例)
        weight: Number(item.weight) > 0 ? Math.round(Number(item.weight)) : 100,
        weight_unit: item.weight_unit || 'g',
        depth: Number(item.depth) > 0 ? Math.round(Number(item.depth)) : 100,
        width: Number(item.width) > 0 ? Math.round(Number(item.width)) : 100,
        height: Number(item.height) > 0 ? Math.round(Number(item.height)) : 100,
        dimension_unit: item.dimension_unit || 'mm',
        // 数组字段
        images: Array.isArray(item.images) ? item.images.map((u) => String(u)).filter(Boolean) : [],
        attributes: _normalizeV3Attributes(item.attributes),
        complex_attributes: _normalizeV3ComplexAttributes(item.complex_attributes),
        // v3 非必填字段(传默认值,对齐 v3 示例)
        primary_image: String(item.primary_image || ''),
        color_image: String(item.color_image || ''),
        images360: Array.isArray(item.images360) ? item.images360.map((u) => String(u)).filter(Boolean) : [],
        pdf_list: Array.isArray(item.pdf_list) ? item.pdf_list : [],
        new_description_category_id: Number(item.new_description_category_id) || 0,
      };

      // type_id / description_category_id: 有值才传,为 0 不传(让 Ozon 走按名匹配)
      if (Number(item.type_id) > 0) out.type_id = Number(item.type_id);
      if (Number(item.description_category_id) > 0) {
        out.description_category_id = Number(item.description_category_id);
      }

      // barcode(可选)
      if (item.barcode) out.barcode = String(item.barcode);

      // ── 必填字段校验(v3 required) ──
      const missing = [];
      if (!out.offer_id) missing.push('offer_id');
      if (!out.name) missing.push('name');
      if (!out.price || out.price === '0') missing.push('price');
      if (out.images.length === 0) missing.push('images');
      if (out.attributes.length === 0) missing.push('attributes');
      // 物理参数不能为 0(v3 文档:"请勿在请求中跳过这些参数,也不要指定0")
      if (out.weight <= 0) missing.push('weight');
      if (out.depth <= 0) missing.push('depth');
      if (out.width <= 0) missing.push('width');
      if (out.height <= 0) missing.push('height');
      if (!out.weight_unit) missing.push('weight_unit');
      if (!out.dimension_unit) missing.push('dimension_unit');
      if (out.vat === '') missing.push('vat');

      if (missing.length > 0) {
        throw new Error(
          `update-bundle-items: items[${idx}] (offer_id=${out.offer_id}) 缺少必填字段: ${missing.join(', ')}`
        );
      }

      return out;
    });

    if (normalizedItems.length === 0) {
      throw new Error('update-bundle-items: items 为空');
    }

    console.log(`[updateBundleItems] bundle=${bundleId}, items=${normalizedItems.length}, source=${source || ''}`);

    return fetchSellerPortal(
      '/seller-prototype/update-bundle-items',
      {
        bundle_id: String(bundleId),
        company_id: String(companyId),
        source: source || 'SOURCE_MERGED',
        items: normalizedItems,
      },
      _bundlePortalOpts(preferTabId)
    );
  }

  // ── v3 attributes 归一化:{complex_id:int, id:int, values:[{value, dictionary_value_id?}]} ──
  function _normalizeV3Attributes(attrs) {
    if (!Array.isArray(attrs)) return [];
    return attrs
      .map((a) => {
        if (!a || typeof a !== 'object') return null;
        // 兼容多种输入字段名:attribute_id / id / key
        const id = Number(a.id || a.attribute_id || a.key || 0);
        if (!id) return null;
        const complexId = Number(a.complex_id) || 0;
        const rawVals = Array.isArray(a.values) ? a.values : [];
        const values = rawVals
          .filter((v) => v && v.value != null && v.value !== '')
          .map((v) => {
            const val = typeof v === 'object' ? v : { value: String(v) };
            const o = { value: String(val.value) };
            if (val.dictionary_value_id != null && Number(val.dictionary_value_id) > 0) {
              o.dictionary_value_id = Number(val.dictionary_value_id);
            }
            return o;
          });
        if (values.length === 0) return null;
        return { complex_id: complexId, id, values };
      })
      .filter(Boolean);
  }

  // ── v3 complex_attributes 归一化:[{attributes:[{complex_id, id, values}]}] ──
  function _normalizeV3ComplexAttributes(cas) {
    if (!Array.isArray(cas)) return [];
    return cas
      .map((ca) => {
        if (!ca || typeof ca !== 'object') return null;
        const innerAttrs = _normalizeV3Attributes(ca.attributes || ca.complex_attributes);
        if (innerAttrs.length === 0) return null;
        return { attributes: innerAttrs };
      })
      .filter(Boolean);
  }

  // 6d. 提交发布 → upload_task_id
  //
  // 对齐官方 seller-ui app.js (pos 755997):
  //   Request:  { bundle_id, company_id, name }
  //   Response: { upload_task_id }
  //
  // - name: 类目名(与 create-bundle 时的 description_category_lvl3_name 同源,再次确认)
  //
  // xy-ozon 扩展:额外传 strict:true 启用严格模式(无效图片/字段直接报错而非静默跳过)。
  // 与官方 proto 不冲突(strict 字段服务端已支持,官方 UI 默认 false 不传)。
  async function uploadBundle(bundleId, companyId, preferTabId = null, opts = {}) {
    const body = {
      bundle_id: String(bundleId),
      company_id: String(companyId),
      // xy-ozon 扩展:严格模式(默认开启)
      strict: opts.strict !== undefined ? Boolean(opts.strict) : true,
    };
    // 类目名(对齐官方):与 create-bundle 时的 description_category_lvl3_name 同源
    if (opts.name) {
      body.name = String(opts.name);
    }
    const resp = await fetchSellerPortal('/seller-prototype/upload-bundle', body, _bundlePortalOpts(preferTabId));
    const taskId = resp?.upload_task_id;
    if (!taskId) throw new Error('upload-bundle 未返回 upload_task_id');
    return String(taskId);
  }

  // ────────────────────────────────────────────────────────────
  // transferVideoToOzon —— 视频转存:mp4 → ir.ozone.ru/s3
  // 对齐 0.13 service-worker.js:863-931
  // 走独立 executeScript 路径(multipart,不经 fetchSellerPortal JSON 通道)
  // ────────────────────────────────────────────────────────────
  async function transferVideoToOzon(srcUrl) {
    if (!srcUrl || typeof srcUrl !== 'string') return { ok: false, error: 'srcUrl required' };
    const targetTab = await ensureSellerTab();
    const companyId = await resolveSellerCompanyId();
    if (!companyId) {
      return { ok: false, error: 'AUTH_REQUIRED', message: 'sc_company_id cookie 未找到,请先登录 seller.ozon.ru' };
    }

    // 在 seller.ozon.ru tab MAIN world 跑:跨源拉源 .mp4 → multipart 同源 POST(带 cookie)
    const doUpload = async (src, xCompanyId, timeout) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const dl = await fetch(src, { signal: controller.signal });
        if (!dl.ok) {
          clearTimeout(timer);
          return { ok: false, error: '源视频下载失败 ' + dl.status };
        }
        const blob = await dl.blob();
        if (!blob || blob.size === 0) {
          clearTimeout(timer);
          return { ok: false, error: '源视频为空' };
        }
        const fname = (src.split('/').pop() || 'video.mp4').split('?')[0].split('#')[0] || 'video.mp4';
        const fd = new FormData();
        fd.append('file_name', fname);
        fd.append('tmp', 'true');
        fd.append('body', new File([blob], fname, { type: blob.type || 'video/mp4' }));
        const resp = await fetch('https://seller.ozon.ru/api/media-storage/upload-file', {
          method: 'POST',
          signal: controller.signal,
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'x-o3-company-id': xCompanyId,
            'x-o3-language': 'zh-Hans',
          },
          body: fd,
        });
        clearTimeout(timer);
        if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
          return { ok: false, status: 401, error: 'Seller portal cookie已过期，请重新登录' };
        }
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          return { ok: false, status: resp.status, error: 'upload-file ' + resp.status + ': ' + t.slice(0, 200) };
        }
        const j = await resp.json().catch(() => null);
        return { ok: true, url: (j && j.url) || null, size: blob.size };
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: e.name === 'AbortError' ? '上传超时' : e.message || String(e) };
      }
    };

    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: doUpload,
        args: [srcUrl, companyId, 90000],
        world: 'MAIN',
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), 95000)),
    ]);
    const r = results && results[0] && results[0].result;
    if (!r) return { ok: false, error: 'executeScript 未返回结果' };
    if (!r.ok || !r.url) return { ok: false, error: r.error || '上传未返回 url' };
    console.log(`[transferVideoToOzon] ${srcUrl} → ${r.url} (${r.size}B)`);
    return { ok: true, url: r.url };
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API
  // ────────────────────────────────────────────────────────────
  self.SellerPortalClient = {
    searchVariants,
    searchProductBySku,
    fetchBundleByVariantId,
    resolveSellerCompanyId,
    ensureSellerTab,
    fetchSellerPortal,
    classifyError,
    normalizeSearchVariantToSv,
    syncSellerCookies,
    getUploadTaskList,
    getUploadTaskErrors,
    createBundle,
    updateBundleItems,
    uploadBundle,
    transferVideoToOzon,
  };
})();
