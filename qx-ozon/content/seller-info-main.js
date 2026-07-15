/**
 * seller-info-main.js — MAIN world content script:提取店铺信息并通过 CustomEvent 传给 ISOLATED world。
 *
 * 注入: MAIN world / document_idle / matches: ozon.ru/seller/* + ozon.ru/product/*
 * 此文件能直接访问 window.__NUXT__,不调用 chrome.* API(MAIN world 限制)。
 *
 * 背景:
 *   ozon-data-panel.js(ISOLATED world)无法访问 window.__NUXT__,也无法读取
 *   SSR 注入的 <div data-state="..."> 上的 JSON 数据。独立 MAIN world 脚本能
 *   直接访问 window.__NUXT__ 和 DOM 属性。
 *
 * 通信:
 *   不调 chrome.* API、不调 sendMessage(MAIN world 限制)。
 *   三写策略(MV3 跨 world 通信,event 多重保险):
 *   1) window.dispatchEvent(new CustomEvent('jz-seller-info', { detail })) — 同 world 兼容
 *   2) window.postMessage({ type: 'jz-seller-info', detail }, location.origin) —
 *      MV3 跨 world 可靠通信(MAIN/ISOLATED 都能监听 window message)
 *   3) document.documentElement.setAttribute('data-jz-seller-info', JSON.stringify(...)) —
 *      DOM 属性(经实测 MutationObserver 不跨 world,仅作调试/同 world 兼容)
 *
 * 数据来源:
 *   - 详情页(/product/<slug>/): 从 div[id^="state-webCurrentSeller-"] 的
 *     data-state HTML 属性解析,提取 sellerId/sellerName/sellerSlug + trustFactors
 *     companyInfo(含 country)
 *   - 店铺页(/seller/<slug>/): 从 __NUXT__.state.pageInfo.analyticsInfo.sellerId
 *     提取 sellerId,再 fetch 店铺页第一个 SKU 的详情页 HTML 提取 companyInfo
 *     (方案 A 优先,失败退回 entrypoint-api 方案 B)
 */
(function () {
  'use strict';
  if (window.__JZ_SELLER_INFO_MAIN_INSTALLED__) return;
  window.__JZ_SELLER_INFO_MAIN_INSTALLED__ = true;

  // ─── 页面类型判断 ──────────────────────────────────
  const path = location.pathname;
  const isShopPage = /^\/seller\/[^/]+\/?$/i.test(path) || /^\/seller\/[^/]+\/products\/?$/i.test(path);
  const isPDP = /^\/product\/[^/]+\/?$/i.test(path);
  if (!isShopPage && !isPDP) return;

  // ─── 辅助函数 ──────────────────────────────────────
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 轮询等待 check() 返回真值;超时返回 null
  async function waitFor(check, timeoutMs, intervalMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const v = check();
        if (v) return v;
      } catch (_) {
        /* ignore */
      }
      await sleep(intervalMs);
    }
    return null;
  }

  // ─── 公共:从 data-state 提取 companyInfo ───────────
  // 详情页 DOM 与方案 A fetch 回来的详情页 HTML 解析后共用此函数。
  // trustFactors[0].tooltip.subtitle 是 textAtom 数组,约定:
  //   texts[0] = companyName
  //   texts[1] = legalAddress
  //   texts[2] = 形如 "CN, Xiamen" → 取逗号前大写部分为 country("CN")
  function _extractCompanyInfoFromState(state) {
    const empty = { companyName: '', legalAddress: '', country: '' };
    if (!state) return empty;
    // Ozon 改版后 trustFactors 有多个(订单数、关于店铺等),
    // 公司信息在 "О магазине"(关于店铺)的 tooltip.subtitle 数组里。
    // 旧代码只看 trustFactors[0] 拿不到公司信息,改为遍历所有 trustFactors
    // 找到含 subtitle 数组(且至少 2 个 text 项)的那个。
    const trustFactors = state.trustFactors;
    if (!Array.isArray(trustFactors)) return empty;

    let texts = null;
    for (let i = 0; i < trustFactors.length; i++) {
      const tf = trustFactors[i];
      const subtitle = tf?.tooltip?.subtitle;
      if (!Array.isArray(subtitle)) continue;
      const textItems = subtitle
        .filter((x) => x && x.type === 'text' && typeof x.content === 'string')
        .map((x) => x.content.trim());
      // 公司信息块至少有 3 个 text 项(公司名、地址、国家)
      if (textItems.length >= 3) {
        texts = textItems;
        console.log('[seller-info-main] 找到公司信息在 trustFactors[' + i + '], texts:', textItems);
        break;
      }
    }
    if (!texts) {
      console.warn(
        '[seller-info-main] trustFactors 中未找到含公司信息的 subtitle, trustFactors:',
        trustFactors.map((tf) => ({
          title: tf?.title?.text,
          tooltipTitle: tf?.tooltip?.title?.text,
          hasSubtitle: Array.isArray(tf?.tooltip?.subtitle),
        }))
      );
      return empty;
    }

    const companyName = texts[0] || '';
    const legalAddress = texts[1] || '';

    let country = '';
    if (texts[2]) {
      const m = texts[2].match(/^\s*([A-Z]{2,3})\s*,/);
      if (m) country = m[1];
    }

    return { companyName, legalAddress, country };
  }

  // ─── 详情页 ────────────────────────────────────────
  async function extractSellerInfoFromPDP() {
    const node = await waitFor(() => document.querySelector('[id^="state-webCurrentSeller-"]'), 10000, 200);
    if (!node) {
      console.warn('[seller-info-main] PDP: state-webCurrentSeller 节点未找到');
      return null;
    }

    // 注意:是 attribute,不是 textContent
    const raw = node.getAttribute('data-state');
    if (!raw) {
      console.warn('[seller-info-main] PDP: data-state 属性为空');
      return null;
    }

    let state;
    try {
      state = JSON.parse(raw);
    } catch (e) {
      console.warn('[seller-info-main] PDP: data-state JSON.parse 失败:', e?.message);
      return null;
    }

    const sellerId =
      state?.badge?.subscribed?.common?.action?.params?.sellerId ||
      state?.badge?.unsubscribed?.common?.action?.params?.sellerId ||
      '';
    const sellerName = state?.sellerCell?.centerBlock?.title?.text || '';
    const sellerLink = state?.sellerCell?.centerBlock?.common?.action?.link || '';
    const slugMatch = sellerLink.match(/\/seller\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : '';
    const companyInfo = _extractCompanyInfoFromState(state);

    if (!sellerId && !slug) {
      console.warn('[seller-info-main] PDP: 既无 sellerId 也无 slug,放弃');
      return null;
    }

    return {
      pageType: 'pdp',
      slug,
      name: sellerName,
      sellerId: sellerId ? String(sellerId) : '',
      companyInfo,
    };
  }

  // ─── 店铺页 ────────────────────────────────────────
  function _extractShopNameFromDOM(slug) {
    const fromWidget = document
      .querySelector('[data-widget="sellerTransparency"] span.tsHeadline600Large')
      ?.textContent?.trim();
    if (fromWidget) return fromWidget;

    const fromH1 = document.querySelector('h1')?.textContent?.trim();
    if (fromH1) return fromH1;

    const fromOg = document.querySelector('meta[property="og:title"]')?.content?.split(/[–-]/)[0]?.trim();
    if (fromOg) return fromOg;

    return slug || '';
  }

  function _findFirstSkuLink() {
    return (
      document.querySelector('[data-widget="searchResultsV2"] a[href*="/product/"]') ||
      document.querySelector('a[href*="/product/"]')
    );
  }

  // 方案 A:fetch 详情页 HTML,DOMParser 解析 data-state
  async function _companyInfoViaPdpFetch(productUrl, expectedSlug) {
    const resp = await fetch(productUrl, {
      credentials: 'include',
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    if (!resp.ok) throw new Error(`fetch pdp http ${resp.status}`);
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const node = doc.querySelector('[id^="state-webCurrentSeller-"]');
    if (!node) throw new Error('pdp html 无 state-webCurrentSeller');

    const raw = node.getAttribute('data-state');
    if (!raw) throw new Error('pdp html data-state 为空');

    let state;
    try {
      state = JSON.parse(raw);
    } catch (e) {
      throw new Error('pdp html data-state JSON.parse 失败: ' + e?.message);
    }

    // 校验:详情页 sellerSlug 应与店铺页 slug 一致(不一致仅 warn,仍采用详情页 companyInfo)
    const sellerLink = state?.sellerCell?.centerBlock?.common?.action?.link || '';
    const pdpSlugMatch = sellerLink.match(/\/seller\/([^/]+)/);
    if (expectedSlug && pdpSlugMatch && pdpSlugMatch[1] !== expectedSlug) {
      console.warn(`[seller-info-main] 店铺页 slug="${expectedSlug}" 与详情页 slug="${pdpSlugMatch[1]}" 不一致`);
    }

    return _extractCompanyInfoFromState(state);
  }

  // 方案 B:entrypoint-api,fetch /modal/shop-in-shop-info?seller_id=...
  async function _companyInfoViaEntrypointApi(sellerId) {
    const url =
      '/api/entrypoint-api.bx/page/json/v2?url=' +
      encodeURIComponent('/modal/shop-in-shop-info?seller_id=' + sellerId + '&page_changed=true');

    const resp = await fetch(url, {
      credentials: 'include',
      headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`entrypoint-api http ${resp.status}`);
    const json = await resp.json();

    const widgetStates = json?.widgetStates;
    if (!widgetStates || typeof widgetStates !== 'object') {
      throw new Error('entrypoint-api 响应无 widgetStates');
    }

    // 找含 companyInfo 的 widget — 键名可能含 "marketing.sellerLegalInformation" 或类似
    // body 是 textAtom 数组
    let companyName = '';
    for (const key of Object.keys(widgetStates)) {
      const w = widgetStates[key];
      if (!w || typeof w !== 'object') continue;
      // 启发式:键名包含 seller / company / legal / shop
      if (!/seller|company|legal|shop/i.test(key)) continue;

      const body = w.body || w.textAtoms || w.atoms || w.content;
      if (!Array.isArray(body)) continue;

      // 取第一个非空 text atom 作为 companyName
      const firstText = body.find((a) => {
        const t = a?.text?.text || a?.content || a?.text;
        return typeof t === 'string' && t.trim();
      });
      if (firstText) {
        companyName =
          firstText.text?.text?.trim() ||
          firstText.content?.trim() ||
          (typeof firstText.text === 'string' ? firstText.text.trim() : '');
        if (companyName) break;
      }
    }

    if (!companyName) {
      throw new Error('entrypoint-api 未找到 companyName');
    }

    // country 启发式:公司名后缀含 "Trading Co., LTD" / "Technology Co., LTD" /
    // "Import Export Co., LTD" → "CN"
    let country = '';
    if (/Trading Co\.,?\s*LTD|Technology Co\.,?\s*LTD|Import Export Co\.,?\s*LTD/i.test(companyName)) {
      country = 'CN';
    }

    // entrypoint-api 拿不到 legalAddress
    return { companyName, legalAddress: '', country };
  }

  async function extractSellerInfoFromShopPage() {
    const slugMatch = path.match(/\/seller\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : '';
    const name = _extractShopNameFromDOM(slug);

    // 等 __NUXT__.state.pageInfo.analyticsInfo.sellerId(15s,每 500ms 检查)
    const sellerIdRaw = await waitFor(() => window.__NUXT__?.state?.pageInfo?.analyticsInfo?.sellerId, 15000, 500);
    if (!sellerIdRaw) {
      console.warn('[seller-info-main] ShopPage: __NUXT__ sellerId 等待超时');
      return null;
    }
    const sellerId = String(sellerIdRaw);

    // 方案 A:fetch 详情页 HTML
    let companyInfo = null;
    let method = 'failed';
    const firstSkuLink = _findFirstSkuLink();
    if (firstSkuLink) {
      const productUrl = firstSkuLink.href;
      try {
        companyInfo = await _companyInfoViaPdpFetch(productUrl, slug);
        method = 'via-pdp';
      } catch (e) {
        console.warn('[seller-info-main] 方案 A(via-pdp)失败:', e?.message, '→ 退回方案 B');
      }
    } else {
      console.warn('[seller-info-main] ShopPage: 未找到 SKU 链接,跳过方案 A');
    }

    // 方案 B:entrypoint-api(方案 A 失败时退回)
    if (!companyInfo) {
      try {
        companyInfo = await _companyInfoViaEntrypointApi(sellerId);
        method = 'via-entrypoint-api';
      } catch (e) {
        console.warn('[seller-info-main] 方案 B(via-entrypoint-api)失败:', e?.message);
      }
    }

    if (!companyInfo) {
      companyInfo = { companyName: '', legalAddress: '', country: '' };
      method = 'failed';
    }

    return {
      pageType: 'shop',
      slug,
      name,
      sellerId,
      companyInfo,
      method,
    };
  }

  // ─── 主流程 ────────────────────────────────────────
  // 把结果推给 ISOLATED world(MV3 跨 world 通信):
  //   - postMessage:跨 world 可靠(MAIN/ISOLATED 都能监听 window message)
  //   - dispatchEvent:同 world 兼容
  //   - setAttribute:DOM 属性(MutationObserver 不跨 world,仅作辅助)
  let _seq = 0;
  function publishToIsolatedWorld(detail) {
    _seq = (_seq + 1) % 1000000;
    console.log('[seller-info-main] publishToIsolatedWorld seq=' + _seq, detail);
    // postMessage 不限 origin(同源页面 message 较少,放宽避免漏收)
    try {
      window.postMessage({ type: 'jz-seller-info', seq: _seq, detail: detail }, '*');
      console.log('[seller-info-main] postMessage sent, seq=' + _seq);
    } catch (e) {
      console.error('[seller-info-main] postMessage failed:', e?.message || e);
    }
    try {
      window.dispatchEvent(new CustomEvent('jz-seller-info', { detail }));
    } catch (_) {
      /* ignore */
    }
    try {
      document.documentElement.setAttribute('data-jz-seller-info', JSON.stringify({ seq: _seq, detail }));
    } catch (_) {
      /* ignore */
    }
  }

  (async () => {
    try {
      let result = null;
      if (isPDP) {
        result = await extractSellerInfoFromPDP();
      } else if (isShopPage) {
        result = await extractSellerInfoFromShopPage();
      }
      if (result) {
        console.log('[seller-info-main] 提取成功:', result);
        publishToIsolatedWorld(result);
      } else {
        console.warn('[seller-info-main] 提取失败');
        publishToIsolatedWorld(null);
      }
    } catch (e) {
      console.error('[seller-info-main] 异常:', e);
      publishToIsolatedWorld(null);
    }
  })();
})();
