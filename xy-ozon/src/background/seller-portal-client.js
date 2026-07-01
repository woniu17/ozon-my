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
  // ────────────────────────────────────────────────────────────
  function normalizeSearchVariantToSv(v) {
    if (!v) return null;
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
    return {
      variant_id: v.variant_id || (v.barcodes && v.barcodes[0]) || '',
      description_category_id: Number(v.description_type_dict_value) || 0,
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
  }

  // ────────────────────────────────────────────────────────────
  // fetchBundleByVariantId —— 补完整 attributes(对齐原项目,简化:去掉 cache)
  // ────────────────────────────────────────────────────────────
  async function fetchBundleByVariantId(sku, variantId, companyId, opts = {}) {
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
    return resp?.item || null;
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
  };
})();
