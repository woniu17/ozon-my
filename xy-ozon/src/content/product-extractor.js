// 页面数据抓取 —— 从真实 Ozon 商品页 DOM + state JSON 抓取源商品数据。
// 对齐原项目 extractProductData / extractBreadcrumbs / extractKeywords /
// fetchVariantGallery / extractCharacteristics / parseScrapedDimensionsFromCharacteristics /
// jzExtractRichContentFromStates / extractStateData / findStateDataByKeys。

(function () {
  'use strict';

  function safeText(s, max) {
    let str = String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (max && str.length > max) str = str.slice(0, max);
    return str;
  }

  // ────────────────────────────────────────────────────────────
  // state JSON 解析(Ozon 把页面数据塞进 <script data-state> 的 JSON)
  // 对齐 0.13 shared-utils.js:180-211 extractStateData
  //
  // 关键:Ozon 2026 SSR DOM 剥离场景下,[data-state] DOM 可能没有 aspects 数据。
  // ensurePdpState() 预热 composer-api page json 后,这里从缓存 fallback 读取。
  // ────────────────────────────────────────────────────────────
  const STATE_CACHE = {};
  let _jzPdpStateCache = null; // { url, expiresAt, widgetStates }
  let _jzPdpStateFetchPromise = null;

  function _statePrefixOf(stateName) {
    // state-webAspects → webAspects
    return stateName.replace(/^state-/, '');
  }

  function extractStateData(key) {
    if (STATE_CACHE[key]) return STATE_CACHE[key];
    try {
      // 旧格式:<div data-state="state-webPrice">{"price":"44 ¥"}</div>
      // 新格式:<script id="state-webPrice" type="application/json">...</script>
      const el = document.getElementById(key) || document.querySelector(`[data-state="${key}"]`);
      if (el) {
        const txt = el.textContent || el.innerText || '';
        if (txt.trim()) {
          const parsed = JSON.parse(txt);
          if (parsed != null) {
            STATE_CACHE[key] = parsed;
            return parsed;
          }
        }
      }
    } catch {}
    // Fallback: 命中 composer-api 缓存(Ozon 2026 SSR DOM 剥离场景)
    if (_jzPdpStateCache && _jzPdpStateCache.url === window.location.href && _jzPdpStateCache.expiresAt > Date.now()) {
      const prefix = _statePrefixOf(key);
      const wsKey = Object.keys(_jzPdpStateCache.widgetStates).find((k) => k.startsWith(prefix));
      if (wsKey) {
        const raw = _jzPdpStateCache.widgetStates[wsKey];
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed != null) {
            STATE_CACHE[key] = parsed;
            return parsed;
          }
        } catch {}
      }
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // ensurePdpState —— 异步预热 composer-api page json,populate 缓存
  // 对齐 0.13 shared-utils.js:221-267
  //
  // Ozon 2026 SSR DOM 剥离场景下,页面 [data-state] 没有 aspects 数据,
  // 必须先调 composer-api 拿到完整 widgetStates 缓存,
  // 之后 extractStateData('state-webAspects') 才能从缓存读到 aspects。
  //
  // content script 同源直接 fetch ozon.ru/api/...,带 cookie,不走 SW。
  // ────────────────────────────────────────────────────────────
  function ensurePdpState(opts = {}) {
    const url = window.location.href;
    const now = Date.now();
    if (!/\/product\//.test(url)) return Promise.resolve(null);
    if (!opts.force && _jzPdpStateCache && _jzPdpStateCache.url === url && _jzPdpStateCache.expiresAt > now) {
      return Promise.resolve(_jzPdpStateCache.widgetStates);
    }
    if (_jzPdpStateFetchPromise && _jzPdpStateFetchPromise._url === url) {
      return _jzPdpStateFetchPromise;
    }

    const fetchPromise = (async () => {
      try {
        let productPath = url;
        try {
          const u = new URL(url);
          productPath = u.pathname;
        } catch {}
        const endpoints = [
          `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(productPath)}`,
          `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(productPath)}`,
        ];
        for (const apiUrl of endpoints) {
          try {
            const resp = await fetch(apiUrl, {
              credentials: 'include',
              headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
            });
            if (!resp.ok) continue;
            const data = await resp.json();
            const ws = data?.widgetStates || {};
            if (Object.keys(ws).length > 0) {
              _jzPdpStateCache = { url, expiresAt: Date.now() + 60_000, widgetStates: ws };
              for (const k of Object.keys(STATE_CACHE)) delete STATE_CACHE[k];
              console.log('[FollowSell] ensurePdpState 成功,widgetStates keys:', Object.keys(ws).length);
              return ws;
            }
          } catch {}
        }
        console.warn('[FollowSell] ensurePdpState:所有 endpoint 失败');
        return null;
      } catch {
        return null;
      } finally {
        if (_jzPdpStateFetchPromise === fetchPromise) _jzPdpStateFetchPromise = null;
      }
    })();
    fetchPromise._url = url;
    _jzPdpStateFetchPromise = fetchPromise;
    return fetchPromise;
  }

  // 在所有 state JSON 里按键名查找(对齐 findStateDataByKeys)
  function findStateDataByKeys(keys) {
    const scripts = document.querySelectorAll('script[type="application/json"][id^="state-"], script[data-state]');
    for (const el of scripts) {
      try {
        const txt = el.textContent || el.innerText || '';
        if (!txt.trim()) continue;
        const obj = JSON.parse(txt);
        for (const k of keys) {
          if (obj && typeof obj === 'object' && k in obj) return obj[k];
        }
      } catch {}
    }
    // 兜底:遍历所有 state-* id
    const stateEls = document.querySelectorAll('[id^="state-"]');
    for (const el of stateEls) {
      try {
        const txt = el.textContent || el.innerText || '';
        if (!txt.trim()) continue;
        const obj = JSON.parse(txt);
        for (const k of keys) {
          if (obj && typeof obj === 'object' && k in obj) return obj[k];
        }
      } catch {}
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // SKU:从 URL 提取,Ozon 商品页 URL 形如 /product/xxx-<sku>/
  // ────────────────────────────────────────────────────────────
  function extractSkuFromUrl() {
    const m = window.location.pathname.match(/-(\d{4,})(?:\/|$)/);
    return m ? m[1] : '';
  }

  // ────────────────────────────────────────────────────────────
  // 标题:优先 state-webPrice / og:title / h1
  // ────────────────────────────────────────────────────────────
  function extractTitle() {
    const priceState = extractStateData('state-webPrice');
    if (priceState?.title) return safeText(priceState.title);
    const og = document.querySelector('meta[property="og:title"]')?.content;
    if (og) return safeText(og);
    const h1 = document.querySelector('h1');
    if (h1) return safeText(h1.textContent);
    return safeText(document.title);
  }

  // ────────────────────────────────────────────────────────────
  // 价格:state-webPrice 优先,其次 DOM
  // ────────────────────────────────────────────────────────────
  function extractPrice() {
    const priceState = extractStateData('state-webPrice');
    if (priceState) {
      const p = priceState.price || priceState.value || priceState.finalPrice;
      if (p != null && !isNaN(Number(p))) return String(p);
    }
    const candidates = ['[itemprop="price"]', '[data-testid="price"]', 'span[class*="price"]'];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      const raw = el?.textContent || el?.getAttribute('content');
      if (raw) {
        const num = String(raw)
          .replace(/[^\d.,]/g, '')
          .replace(/\.(?=\d{3}\b)/g, '')
          .replace(',', '.');
        const n = parseFloat(num);
        if (!isNaN(n) && n > 0) return String(n);
      }
    }
    return '';
  }

  // ────────────────────────────────────────────────────────────
  // 图片:state-webGallery 优先,其次 og:image
  // ────────────────────────────────────────────────────────────
  function extractCoverImage() {
    const galleryState = extractStateData('state-webGallery');
    if (galleryState) {
      const imgs = galleryState.images || galleryState.photos;
      if (Array.isArray(imgs) && imgs.length > 0) {
        const first = imgs[0];
        return typeof first === 'string' ? first : first?.url || first?.src || '';
      }
      if (galleryState.coverImage) return galleryState.coverImage;
    }
    const og = document.querySelector('meta[property="og:image"]')?.content;
    if (og) return og;
    const img = document.querySelector('img[src*="ir.ozone.ru"], img[src*="cdn"]')?.src;
    return img || '';
  }

  // 完整图册(state-webGallery)
  function extractGalleryImages() {
    const galleryState = extractStateData('state-webGallery');
    if (galleryState) {
      const imgs = galleryState.images || galleryState.photos || [];
      return imgs
        .map((i) => (typeof i === 'string' ? i : i?.url || i?.src || ''))
        .filter(Boolean)
        .map((u) => upgradeImageUrl(u));
    }
    const cover = extractCoverImage();
    return cover ? [cover] : [];
  }

  // ir.ozone.ru 的 /wc\d+\// → /wc1000/(拿大图)
  function upgradeImageUrl(url) {
    return String(url || '').replace(/\/wc\d+\//, '/wc1000/');
  }

  // ────────────────────────────────────────────────────────────
  // 品牌:state-webBrand 优先,其次面包屑
  // ────────────────────────────────────────────────────────────
  function extractBrand() {
    const brandState = extractStateData('state-webBrand');
    if (brandState) {
      const name = brandState.name || brandState.title || brandState.brand;
      if (name) return safeText(name);
    }
    // JSON-LD 兜底
    try {
      const ld = document.querySelector('script[type="application/ld+json"]')?.textContent;
      if (ld) {
        const obj = JSON.parse(ld);
        if (obj?.brand?.name) return safeText(obj.brand.name);
      }
    } catch {}
    return '';
  }

  // ────────────────────────────────────────────────────────────
  // 面包屑:state JSON 优先(不被翻译污染),其次 DOM
  // 对齐原项目 extractBreadcrumbs
  // ────────────────────────────────────────────────────────────
  function extractBreadcrumbs() {
    // 优先 state JSON
    const bc = findStateDataByKeys(['breadcrumbs', 'breadCrumbs', 'categoryBreadcrumbs']);
    if (Array.isArray(bc) && bc.length > 0) {
      const items = bc
        .map((b) => (typeof b === 'string' ? b : b?.name || b?.title || b?.text || ''))
        .map((s) => safeText(s))
        .filter((s) => s && s !== 'Ozon' && s !== 'Главная');
      if (items.length > 0) return items;
    }
    // DOM 兜底(非翻译态)
    const items = [];
    document
      .querySelectorAll(
        '[data-widget="breadCrumbs"] a, [data-widget="webBreadcrumbs"] a, nav[itemtype*="Breadcrumb"] a, .breadcrumbs a'
      )
      .forEach((a) => {
        const t = safeText(a.textContent);
        if (t && t !== 'Ozon' && t !== 'Главная') items.push(t);
      });
    return items;
  }

  // ────────────────────────────────────────────────────────────
  // 主题标签:只保留 # 开头的(对齐原项目,避免把搜索关键词当标签)
  // ────────────────────────────────────────────────────────────
  function extractKeywords() {
    const tags = [];
    // data-widget="webHashtags" 的 [title]
    document.querySelectorAll('[data-widget="webHashtags"] [title]').forEach((el) => {
      const t = safeText(el.getAttribute('title') || '');
      if (t.startsWith('#')) tags.push(t);
    });
    if (tags.length > 0) return tags;
    // 兜底:tagList 的 <a> 文本(只保留 # 开头)
    document.querySelectorAll('[data-widget="tagList"] a').forEach((a) => {
      const t = safeText(a.textContent);
      if (t.startsWith('#')) tags.push(t);
    });
    return tags;
  }

  // ────────────────────────────────────────────────────────────
  // 视频:从 state-webGallery / document 抓 .mp4
  // 对齐原项目 captureAndTransferPageVideoMedia 的抽取部分
  // ────────────────────────────────────────────────────────────
  function extractVideoUrl() {
    // state-webGallery.videos
    const galleryState = extractStateData('state-webGallery');
    if (galleryState?.videos) {
      for (const v of galleryState.videos) {
        const raw = typeof v === 'string' ? v : v?.url || v?.src || '';
        if (raw && /\.mp4(\?|#|$)/i.test(raw)) return raw;
      }
    }
    // document 兜底
    const v = document.querySelector('video[src]');
    if (v?.src) return v.src;
    const source = document.querySelector('video source[src]');
    return source?.src || '';
  }

  function extractVideoCover() {
    const galleryState = extractStateData('state-webGallery');
    if (galleryState?.videos) {
      for (const v of galleryState.videos) {
        const cover = typeof v === 'object' ? v?.cover || v?.poster || v?.preview : '';
        if (cover) return cover;
      }
    }
    const poster = document.querySelector('video[poster]')?.getAttribute('poster');
    return poster || '';
  }

  // ────────────────────────────────────────────────────────────
  // extractCharacteristics:从 state JSON / DOM 抓商品规格
  // 对齐原项目 extractCharacteristics
  // ────────────────────────────────────────────────────────────
  function extractCharacteristics() {
    // Strategy A:state JSON
    const chars = findStateDataByKeys(['characteristics', 'shortCharacteristics', 'specs']);
    if (Array.isArray(chars) && chars.length > 0) {
      const items = [];
      for (const c of chars) {
        if (!c) continue;
        const name = c.name || c.key || c.title || '';
        const value =
          c.value != null
            ? String(c.value)
            : Array.isArray(c.values)
              ? c.values.map((v) => v.value || v).join(', ')
              : '';
        if (name && value) items.push({ name: String(name), value: String(value) });
      }
      if (items.length > 0) return items;
    }
    // Strategy B:DOM data-state
    const items = [];
    document.querySelectorAll('[data-widget="webCharacteristics"]').forEach((widget) => {
      try {
        const state = widget.getAttribute('data-state');
        if (state) {
          const obj = JSON.parse(state);
          const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            if (node.key && node.value != null) {
              items.push({ name: String(node.key), value: String(node.value) });
            }
            for (const v of Object.values(node)) {
              if (Array.isArray(v)) v.forEach(walk);
              else if (typeof v === 'object') walk(v);
            }
          };
          walk(obj);
        }
      } catch {}
    });
    return items;
  }

  // ────────────────────────────────────────────────────────────
  // parseScrapedDimensionsFromCharacteristics:从规格识别 weight/depth/width/height
  // 对齐原项目,单位转换(кг→g ×1000、см→mm ×10)
  // 关键:无单位且无 label hint 时拒绝解析(避免 99g 误判为 99kg)
  // ────────────────────────────────────────────────────────────
  function parseScrapedDimensionsFromCharacteristics(chars) {
    if (!Array.isArray(chars)) return {};
    const dims = {};
    const parseVal = (s) => {
      const m = String(s).match(/(-?\d+(?:[.,]\d+)?)/);
      if (!m) return null;
      return parseFloat(m[1].replace(',', '.'));
    };
    for (const c of chars) {
      const name = String(c.name || c.key || '').toLowerCase();
      const val = String(c.value || '');
      const num = parseVal(val);
      if (num == null || !isFinite(num)) continue;
      const hasUnit = /\d/.test(val);
      if (!hasUnit) continue; // 无单位拒绝
      // 重量(g)
      if (/вес|weight|масса/.test(name)) {
        if (/кг|kg|kilogram/i.test(val)) dims.weight = Math.round(num * 1000);
        else if (/г|g|gram/i.test(val)) dims.weight = Math.round(num);
        else if (num < 100)
          dims.weight = Math.round(num * 1000); // <100 视为 kg
        else dims.weight = Math.round(num);
      }
      // 深度(mm)
      else if (/глубин|depth|длина|length/.test(name)) {
        if (/м\b|m\b|meter/i.test(val)) dims.depth = Math.round(num * 1000);
        else if (/см|cm/i.test(val)) dims.depth = Math.round(num * 10);
        else if (/мм|mm/i.test(val)) dims.depth = Math.round(num);
        else if (num < 100)
          dims.depth = Math.round(num * 10); // <100 视为 cm
        else dims.depth = Math.round(num);
      }
      // 宽度(mm)
      else if (/ширин|width/.test(name)) {
        if (/м\b|m\b|meter/i.test(val)) dims.width = Math.round(num * 1000);
        else if (/см|cm/i.test(val)) dims.width = Math.round(num * 10);
        else if (/мм|mm/i.test(val)) dims.width = Math.round(num);
        else if (num < 100) dims.width = Math.round(num * 10);
        else dims.width = Math.round(num);
      }
      // 高度(mm)
      else if (/высот|height/.test(name)) {
        if (/м\b|m\b|meter/i.test(val)) dims.height = Math.round(num * 1000);
        else if (/см|cm/i.test(val)) dims.height = Math.round(num * 10);
        else if (/мм|mm/i.test(val)) dims.height = Math.round(num);
        else if (num < 100) dims.height = Math.round(num * 10);
        else dims.height = Math.round(num);
      }
      // 组合尺寸 "10 x 20 x 30 см"
      else if (/размер|dimension/.test(name)) {
        const parts = val.match(/(\d+(?:[.,]\d+)?)/g);
        if (parts && parts.length >= 3) {
          const mult = /см|cm/i.test(val) ? 10 : /мм|mm/i.test(val) ? 1 : /м\b|m\b/i.test(val) ? 1000 : 0;
          if (mult > 0) {
            dims.depth = Math.round(parseFloat(parts[0].replace(',', '.')) * mult);
            dims.width = Math.round(parseFloat(parts[1].replace(',', '.')) * mult);
            dims.height = Math.round(parseFloat(parts[2].replace(',', '.')) * mult);
          }
        }
      }
    }
    return dims;
  }

  // ────────────────────────────────────────────────────────────
  // jzExtractRichContentFromStates:从 widgetStates 抽源富内容 11254
  // 对齐原项目,识别 richAnnotationJson 字符串或顶层 {content:[{widgetName}],version} 形状
  // ────────────────────────────────────────────────────────────
  function jzExtractRichContentFromStates(widgetStates) {
    if (!widgetStates) return '';
    const states = typeof widgetStates === 'string' ? JSON.parse(widgetStates) : widgetStates;
    if (!states || typeof states !== 'object') return '';
    for (const key of Object.keys(states)) {
      const v = states[key];
      if (!v || typeof v !== 'string') continue;
      // 识别 richAnnotationJson 字符串
      if (/richAnnotationJson/i.test(v) || /"widgetName"\s*:/.test(v)) {
        try {
          const obj = JSON.parse(v);
          if (obj && (obj.content || obj.version || obj.richAnnotationJson)) return v;
        } catch {}
      }
    }
    // 顶层 {content:[{widgetName}],version} 形状
    if (states.content && Array.isArray(states.content)) {
      const hasWidget = states.content.some((c) => c && c.widgetName);
      if (hasWidget) return JSON.stringify(states);
    }
    return '';
  }

  // ────────────────────────────────────────────────────────────
  // fetchVariantGallery:调 Ozon 买家端 entrypoint-api 抓变体图册 + 富内容
  // 对齐原项目 fetchVariantGallery
  // ────────────────────────────────────────────────────────────
  async function fetchVariantGallery(path) {
    const url = path || window.location.pathname;
    try {
      const resp = await fetch(
        'https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=' + encodeURIComponent(url),
        {
          credentials: 'include',
          headers: { 'x-o3-app-name': 'dweb_client' },
        }
      );
      let data = null;
      if (resp.ok) data = await resp.json().catch(() => null);
      // 兜底 composer-api
      if (!data) {
        const resp2 = await fetch(
          'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=' + encodeURIComponent(url),
          {
            credentials: 'include',
            headers: { 'x-o3-app-name': 'dweb_client' },
          }
        );
        if (resp2.ok) data = await resp2.json().catch(() => null);
      }
      if (!data) return { images: [], richContent: '' };

      const widgetStates = data.widgetStates || data.widgets || {};
      // 选 images 数组最长的 widget 作图册主源
      let bestImages = [];
      for (const key of Object.keys(widgetStates)) {
        const v = widgetStates[key];
        if (!v || typeof v !== 'string') continue;
        try {
          const obj = JSON.parse(v);
          const imgs = obj.images || obj.photos || obj.galleryImages;
          if (Array.isArray(imgs) && imgs.length > bestImages.length) {
            bestImages = imgs
              .map((i) => (typeof i === 'string' ? i : i?.url || i?.src || ''))
              .filter(Boolean)
              .map(upgradeImageUrl);
          }
        } catch {}
      }
      // coverImage 优先 push 到首位
      for (const key of Object.keys(widgetStates)) {
        const v = widgetStates[key];
        if (!v || typeof v !== 'string') continue;
        try {
          const obj = JSON.parse(v);
          if (obj.coverImage) {
            const cover = upgradeImageUrl(obj.coverImage);
            if (cover && !bestImages.includes(cover)) bestImages.unshift(cover);
            break;
          }
        } catch {}
      }
      // 去重
      const seen = new Set();
      const images = bestImages.filter((u) => {
        const k = u.split('?')[0].toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      // 富内容
      const richContent = jzExtractRichContentFromStates(widgetStates);
      return { images, richContent };
    } catch (e) {
      console.warn('[fetchVariantGallery] failed:', e?.message || e);
      return { images: [], richContent: '' };
    }
  }

  // ────────────────────────────────────────────────────────────
  // 组装完整商品数据
  // ────────────────────────────────────────────────────────────
  function extractProductData() {
    return {
      sku: extractSkuFromUrl(),
      url: window.location.href,
      title: extractTitle(),
      price: extractPrice(),
      currency: 'RUB',
      coverImage: extractCoverImage(),
      images: extractGalleryImages(),
      brand: extractBrand(),
      breadcrumbs: extractBreadcrumbs(),
      videoUrl: extractVideoUrl(),
      videoCover: extractVideoCover(),
      keywords: extractKeywords(),
      variantSkus: extractVariantSkus(),
    };
  }

  // ────────────────────────────────────────────────────────────
  // extractRawAspects —— 从页面 [data-state] 提取原始 aspects 结构
  // 对齐 0.13 ozon-product.js:624-644
  // 返回:[{ aspectName, variants:[{sku,data,link,availability,active}], aspectModalInfo }, ...]
  // 返回 [] 表示无 aspects(单 SKU 商品 / SSR 剥离 / 异常页)
  //
  // 注意:ensurePdpState() 预热后,extractStateData('state-webAspects') 能从
  // composer-api 缓存读到 aspects(SSR DOM 剥离场景的关键 fallback)。
  // ────────────────────────────────────────────────────────────
  function extractRawAspects() {
    // 主路径:遍历所有 [data-state],找含 aspects 数组的
    const allStateElements = document.querySelectorAll('[data-state]');
    for (const el of allStateElements) {
      try {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 20) continue;
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.aspects) && data.aspects.length > 0) return data.aspects;
      } catch {}
    }
    // Fallback 1:data-widget="webAspects"
    const widget = document.querySelector('[data-widget="webAspects"], [data-widget="aspects"]');
    if (widget) {
      try {
        const data = JSON.parse(widget.getAttribute('data-state') || '');
        if (Array.isArray(data?.aspects) && data.aspects.length > 0) return data.aspects;
      } catch {}
    }
    // Fallback 2:extractStateData('state-webAspects') —— 命中 composer-api 缓存
    // (Ozon 2026 SSR DOM 剥离场景,ensurePdpState 预热后这里能读到)
    const ws = extractStateData('state-webAspects');
    if (Array.isArray(ws?.aspects) && ws.aspects.length > 0) return ws.aspects;
    return [];
  }

  // ────────────────────────────────────────────────────────────
  // extractAspectVariants —— 从 webAspects 提取所有变体(权威源)
  // 对齐 0.13 ozon-product.js:651-736
  //
  // 流程:
  //   1. 遍历 [data-state] 找第一个含 aspects 的(主变体 widget)
  //   2. Fallback: data-widget="webAspects"
  //   3. Fallback: extractStateData('state-webAspects') ← composer-api 缓存
  //   4. 锚点校验:结果必须含当前页 SKU,否则返回 [](防推荐位误判)
  //
  // 返回:[{ sku, title, price, coverImage, link, availability, active, aspectValues }, ...]
  // ────────────────────────────────────────────────────────────
  function extractAspectVariants() {
    const currentSku = extractSkuFromUrl();

    let aspectsData = null;
    // 主路径:遍历 [data-state],找第一个含 aspects 的
    const allStateElements = document.querySelectorAll('[data-state]');
    for (const el of allStateElements) {
      try {
        const raw = el.getAttribute('data-state');
        if (!raw || raw.length < 20) continue;
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.aspects) && data.aspects.length > 0) {
          aspectsData = data.aspects;
          break;
        }
      } catch {}
    }
    // Fallback 1: data-widget="webAspects"
    if (!aspectsData) {
      const widget = document.querySelector('[data-widget="webAspects"], [data-widget="aspects"]');
      if (widget) {
        try {
          const data = JSON.parse(widget.getAttribute('data-state') || '');
          if (Array.isArray(data?.aspects) && data.aspects.length > 0) aspectsData = data.aspects;
        } catch {}
      }
    }
    // Fallback 2: extractStateData('state-webAspects') ← composer-api 缓存
    if (!aspectsData) {
      const ws = extractStateData('state-webAspects');
      if (Array.isArray(ws?.aspects) && ws.aspects.length > 0) aspectsData = ws.aspects;
    }

    if (!aspectsData || aspectsData.length === 0) return [];

    // 构建 variantMap
    const variantMap = new Map();
    for (const aspect of aspectsData) {
      const aspectName = aspect.aspectName || '';
      const variants = aspect.variants || [];
      for (const v of variants) {
        const sku = String(v.sku || '');
        if (!sku) continue;
        if (!variantMap.has(sku)) {
          const d = v.data || {};
          variantMap.set(sku, {
            sku,
            title: d.title || '',
            price: d.price || '',
            coverImage: (d.coverImage || '').replace(/\/wc\d+\//, '/wc1000/'),
            link: v.link || '',
            availability: v.availability || 'unknown',
            active: v.active === true,
            aspectValues: {},
          });
        }
        const existing = variantMap.get(sku);
        const text = v.data?.searchableText || (v.data?.textRs || []).map((t) => t.content).join('') || '';
        if (aspectName && text) existing.aspectValues[aspectName] = text;
      }
    }

    // 锚点校验:结果必须含当前页 SKU(防推荐位误判)
    if (currentSku && !variantMap.has(currentSku)) {
      console.warn('[FollowSell] extractAspectVariants:aspects 不含当前 SKU', currentSku, '→ 返回 []');
      return [];
    }
    console.log('[FollowSell] extractAspectVariants:从 aspects 读到', variantMap.size, '个变体');
    return Array.from(variantMap.values());
  }

  // ────────────────────────────────────────────────────────────
  // extractVariantSkus —— 兼容包装:优先 aspects,失败走 DOM/state/JSON-LD fallback
  // 返回 shape 与 extractAspectVariants 一致,保证下游消费方无感知
  // ────────────────────────────────────────────────────────────
  function extractVariantSkus() {
    // 主路径:从 aspects 结构化数据提取(权威,对齐 0.13)
    const aspectVariants = extractAspectVariants();
    if (aspectVariants.length > 0) return aspectVariants;

    // Fallback:旧 DOM/state/JSON-LD 启发式(aspects 缺失时兜底)
    const currentSku = extractSkuFromUrl();
    const seen = new Set();
    const result = [];

    function pushVariant(v) {
      if (!v || !v.sku) return;
      const sku = String(v.sku);
      if (seen.has(sku)) return;
      seen.add(sku);
      result.push(v);
    }

    if (currentSku) pushVariant({ sku: currentSku });

    // Fallback A:DOM 变体选择器区域的 /product/ 链接
    try {
      const skuLinks = document.querySelectorAll(
        '[data-widget="webSKU"] a[href*="/product/"], ' +
          '[data-widget="webSearchSKU"] a[href*="/product/"], ' +
          '[data-widget="webAddToCart"] a[href*="/product/"], ' +
          '.sku-selector a[href*="/product/"], ' +
          '[class*="sku"] a[href*="/product/"]'
      );
      skuLinks.forEach((a) => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/-(\d{4,})(?:\/|$|\?)/);
        if (m) {
          pushVariant({
            sku: m[1],
            link: a.href,
            title: safeText(a.textContent) || undefined,
          });
        }
      });
    } catch {}

    // Fallback A2:页面所有指向 /product/ 的短文本链接
    if (result.length < 2) {
      try {
        const allProductLinks = document.querySelectorAll('a[href*="/product/"]');
        allProductLinks.forEach((a) => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/-(\d{4,})(?:\/|$|\?)/);
          if (m && m[1] !== currentSku) {
            const text = safeText(a.textContent);
            if (text && text.length < 60) {
              pushVariant({ sku: m[1], link: a.href, title: text });
            }
          }
        });
      } catch {}
    }

    // Fallback B:state JSON 里的 skus/variants 数组
    if (result.length < 2) {
      try {
        const skuData = findStateDataByKeys(['skus', 'variantSkus', 'skuList', 'variants']);
        if (Array.isArray(skuData)) {
          for (const item of skuData) {
            if (typeof item === 'string') {
              pushVariant({ sku: item });
            } else if (item) {
              const sku = item.sku || item.id || item.offer_id;
              if (sku) {
                pushVariant({
                  sku: String(sku),
                  title: item.title || item.name || undefined,
                  price: item.price || item.value || undefined,
                  coverImage: item.image || item.coverImage || undefined,
                });
              }
            }
          }
        }
      } catch {}
    }

    // Fallback C:JSON-LD Product 模型的 offers 数组
    if (result.length < 2) {
      try {
        document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
          try {
            const obj = JSON.parse(el.textContent || '');
            const offers = obj?.offers || (Array.isArray(obj) ? obj[0]?.offers : null);
            if (offers) {
              const offerList = Array.isArray(offers) ? offers : offers['@graph'] || [offers];
              for (const o of offerList) {
                const sku = o.sku || o.mpn || '';
                if (sku) {
                  pushVariant({
                    sku: String(sku),
                    title: o.name || undefined,
                    price: o.price || undefined,
                    link: o.url || undefined,
                  });
                }
              }
            }
          } catch {}
        });
      } catch {}
    }

    // 兜底:仅当前 SKU
    if (result.length === 0 && currentSku) {
      result.push({ sku: currentSku });
    }
    return result;
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API
  // ────────────────────────────────────────────────────────────
  self.JZProductExtractor = {
    extractProductData,
    extractSkuFromUrl,
    extractTitle,
    extractPrice,
    extractCoverImage,
    extractGalleryImages,
    extractBrand,
    extractBreadcrumbs,
    extractKeywords,
    extractVideoUrl,
    extractVideoCover,
    extractStateData,
    findStateDataByKeys,
    extractCharacteristics,
    parseScrapedDimensionsFromCharacteristics,
    fetchVariantGallery,
    jzExtractRichContentFromStates,
    upgradeImageUrl,
    extractVariantSkus,
    extractRawAspects,
    extractAspectVariants,
    ensurePdpState,
  };
})();
