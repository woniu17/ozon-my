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
    const empty = { companyName: '', legalAddress: '', country: '', stats: null };
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

  // ─── 公共:从 entrypoint-api 的 widgetStates 提取店铺统计指标 ──
  // 数据源:cellList widget(键名形如 cellList-<数字>-default-1,数字不固定),
  // 值为 JSON 字符串需二次 parse。每个 cell 的 centerBlock.title.text 是字段名
  // (俄文),rightBlock.badge.text 是值。字段对应:
  //   "Заказов"                  → 订单数量(如 "455")
  //   "Работает с Ozon"          → 店铺开业时长(如 "9 месяцев" / "1 год")
  //   "Средняя оценка товаров"   → 产品质量分(如 "4,5 из 5")
  //   "Количество отзывов"       → 评论数量(如 "126")
  function _parseRussianMonths(text) {
    if (!text) return null;
    // 月:"9 месяцев" → 9
    const mMonth = text.match(/(\d+)\s+(месяц|месяца|месяцев)/i);
    if (mMonth) return Number(mMonth[1]);
    // 年:"1 год" / "2 года" / "5 лет" → 转换为月(1 年 = 12 个月)
    const mYear = text.match(/(\d+)\s+(год|года|лет)/i);
    if (mYear) return Number(mYear[1]) * 12;
    return null;
  }

  // 解析俄语格式数字,兼容 K(тысяча/千)和 M(миллион/百万)后缀。
  // 例:
  //   "455"         → 455
  //   "12,2 K"      → 12200   (K=kilo,逗号为俄语小数点)
  //   "1,5 M"       → 1500000
  function _parseRussianNumber(value) {
    if (!value) return null;
    // 去除普通空格和 NBSP(\u00A0),Ozon 常用 NBSP 作千分位分隔
    let s = String(value).replace(/[\s\u00A0]/g, '');
    let multiplier = 1;
    const kMatch = s.match(/^([\d.,]+)K$/i);
    if (kMatch) {
      multiplier = 1000;
      s = kMatch[1];
    } else {
      const mMatch = s.match(/^([\d.,]+)M$/i);
      if (mMatch) {
        multiplier = 1000000;
        s = mMatch[1];
      }
    }
    // 俄语小数点为逗号 → 替换为点
    s = s.replace(',', '.');
    const n = Number(s);
    if (!isFinite(n)) return null;
    return Math.round(n * multiplier);
  }

  function _extractSellerStatsFromWidgetStates(widgetStates) {
    const empty = {
      ordersCount: null,
      reviewsCount: null,
      rating: null,
      ratingRaw: '',
      openedDurationRaw: '',
      openedMonths: null,
    };
    if (!widgetStates || typeof widgetStates !== 'object') return empty;

    // 找 cellList widget(键名前缀 "cellList-")
    let cellList = null;
    for (const key of Object.keys(widgetStates)) {
      if (!key.startsWith('cellList-')) continue;
      const w = widgetStates[key];
      if (typeof w === 'string') {
        try {
          cellList = JSON.parse(w);
        } catch (_) {
          /* ignore,试下一个 */
        }
      } else if (w && typeof w === 'object') {
        cellList = w;
      }
      if (cellList) break;
    }
    if (!cellList || !Array.isArray(cellList.cells)) return empty;

    const stats = { ...empty };
    for (const cell of cellList.cells) {
      const dsCell = cell?.dsCell;
      if (!dsCell) continue;
      const title = dsCell?.centerBlock?.title?.text;
      const value = dsCell?.rightBlock?.badge?.text;
      if (!title || !value) continue;
      switch (title) {
        case 'Заказов': // 订单数量,如 "455" / "12,2 K"
          stats.ordersCount = _parseRussianNumber(value);
          break;
        case 'Работает с Ozon': // 店铺开业时长
          stats.openedDurationRaw = value;
          stats.openedMonths = _parseRussianMonths(value);
          break;
        case 'Средняя оценка товаров': // 产品质量分
          stats.ratingRaw = value;
          // "4,5 из 5" → 4.5
          stats.rating =
            Number(value.replace(',', '.').replace(/\s*из\s*\d+/i, '').trim()) || null;
          break;
        case 'Количество отзывов': // 评论数量,如 "126" / "1,2 K"
          stats.reviewsCount = _parseRussianNumber(value);
          break;
      }
    }
    return stats;
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

    // sellerId fallback 链:Ozon 多次改版,badge 路径时有变化
    const sellerId =
      state?.badge?.subscribed?.common?.action?.params?.sellerId ||
      state?.badge?.unsubscribed?.common?.action?.params?.sellerId ||
      state?.sellerCell?.sellerId ||
      state?.sellerCell?.common?.action?.params?.sellerId ||
      state?.sellerId ||
      '';
    // sellerName / sellerLink fallback 链(对齐 ozon-product.js#L468-499 已验证路径)
    const sc = state?.sellerCell;
    const strOr = (v) => (typeof v === 'string' && v ? v : '');
    const sellerName =
      strOr(sc?.centerBlock?.title?.text) || strOr(sc?.centerBlock?.title) || strOr(sc?.name) || strOr(state?.name) || '';
    const sellerLink =
      strOr(sc?.common?.action?.link) ||
      strOr(sc?.centerBlock?.title?.link) ||
      strOr(sc?.link) ||
      strOr(state?.link) ||
      '';
    const slugMatch = sellerLink.match(/\/seller\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : '';
    const companyInfo = _extractCompanyInfoFromState(state);

    if (!sellerId && !slug) {
      console.warn('[seller-info-main] PDP: 既无 sellerId 也无 slug,放弃');
      console.warn(
        '[seller-info-main] state 顶层 keys:',
        state ? Object.keys(state) : 'null',
        'sellerCell keys:',
        sc ? Object.keys(sc) : 'null',
        'badge keys:',
        state?.badge ? Object.keys(state.badge) : 'null'
      );
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

    // 端点耗时埋点(www.entrypoint.shop-info;MAIN world 无 chrome.runtime,
    // 经 window.postMessage 由 ISOLATED world 的 shared-utils.js 中继给 SW 上报 ERP)
    const t0 = Date.now();
    const reportMetric = (statusCode, ok, errorKind) => {
      try {
        window.postMessage(
          {
            type: 'jz-endpoint-metric',
            metric: {
              endpoint: 'www.entrypoint.shop-info',
              method: 'GET',
              ts: new Date(t0).toISOString(),
              durationMs: Date.now() - t0,
              statusCode,
              ok,
              errorKind: errorKind || null,
              sellerId: String(sellerId || '') || null,
            },
          },
          '*'
        );
      } catch { /* 静默 */ }
    };

    let resp;
    try {
      resp = await fetch(url, {
        credentials: 'include',
        headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
      });
    } catch (e) {
      reportMetric(null, false, e?.name === 'AbortError' ? 'TIMEOUT' : 'NET');
      throw e;
    }
    if (!resp.ok) {
      reportMetric(resp.status, false, 'HTTP_' + resp.status);
      throw new Error(`entrypoint-api http ${resp.status}`);
    }
    const json = await resp.json();
    reportMetric(resp.status, true);

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
    // 同步提取店铺统计指标(订单数/评论数/开业时长/质量分)
    const stats = _extractSellerStatsFromWidgetStates(widgetStates);
    return { companyName, legalAddress: '', country, stats };
  }

  async function extractSellerInfoFromShopPage() {
    const slugMatch = path.match(/\/seller\/([^/]+)/);
    const slug = slugMatch ? slugMatch[1] : '';
    const name = _extractShopNameFromDOM(slug);

    // 2026-08:店铺分类改用 sellerId(稳定主键),slug 不再参与分类。
    // 阶段 1 的 slug-only publish 已删除 — sellerId 缺失时 ISOLATED 端无法调
    // checkStoreClassification(入参校验 if (!sellerId) return null)。
    // 等 sellerId 到达后一次性 publish,延迟通常 ~100ms,最长 15s 超时。

    // 等 __NUXT__.state.pageInfo.analyticsInfo.sellerId(15s,每 100ms 检查)
    // 间隔从 500ms 缩短到 100ms,典型命中延迟从 ~500ms 降到 ~100ms
    const sellerIdRaw = await waitFor(() => window.__NUXT__?.state?.pageInfo?.analyticsInfo?.sellerId, 15000, 100);
    if (!sellerIdRaw) {
      console.warn('[seller-info-main] ShopPage: __NUXT__ sellerId 等待超时,店铺分类跳过');
      // 超时:返回 slug + 空 sellerId,ISOLATED 端 handlePdpSellerInfo 会因 sellerId 空跳过分类
      // 面板仍可展示 slug/name(基础信息),店铺检测状态保持"未检测"
      return {
        pageType: 'shop',
        slug,
        name,
        sellerId: '',
        companyInfo: null,
        method: 'nuxt-timeout',
      };
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
      companyInfo = { companyName: '', legalAddress: '', country: '', stats: null };
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
