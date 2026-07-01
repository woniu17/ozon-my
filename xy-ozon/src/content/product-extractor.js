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
  // 对齐原项目 extractStateData / findStateDataByKeys
  // ────────────────────────────────────────────────────────────
  function extractStateData(key) {
    try {
      const el = document.getElementById(key);
      if (!el) return null;
      const txt = el.textContent || el.innerText || '';
      if (!txt.trim()) return null;
      return JSON.parse(txt);
    } catch {
      return null;
    }
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
  // extractVariantSkus —— 从商品页提取所有变体 SKU 列表
  // Ozon 商品页 URL 形如 /product/{slug}-{sku}/,每个变体有独立 SKU。
  // 提取策略(按可靠性排序):
  //   A. DOM:变体选择器区域的 /product/ 链接(最可靠)
  //   B. state JSON:widgetStates 里的 skus/variants 数组
  //   C. JSON-LD:Product 模型的 offers 数组
  //   D. 兜底:仅当前 URL SKU
  // 返回:[{ sku, title?, price?, coverImage?, url? }, ...] 去重,首个为当前变体
  // ────────────────────────────────────────────────────────────
  function extractVariantSkus() {
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

    // 确保当前 SKU 排首位
    if (currentSku) pushVariant({ sku: currentSku });

    // Strategy A:DOM 变体选择器区域的 /product/ 链接
    // Ozon 变体按钮通常在 [data-widget="webSKU"] 或 SKU 选择器区域,
    // 每个变体是一个指向 /product/xxx-{sku}/ 的链接
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
            url: a.href,
            title: safeText(a.textContent) || undefined,
          });
        }
      });
    } catch {}

    // Strategy A2:更宽泛 —— 页面所有指向 /product/ 的链接(含同款其他变体)
    if (result.length < 2) {
      try {
        const allProductLinks = document.querySelectorAll('a[href*="/product/"]');
        allProductLinks.forEach((a) => {
          const href = a.getAttribute('href') || '';
          // 排除面包屑、推荐位等(只取变体选择器附近的)
          // 启发式:链接文本短(变体标签通常短)或在 SKU widget 内
          const m = href.match(/-(\d{4,})(?:\/|$|\?)/);
          if (m && m[1] !== currentSku) {
            const text = safeText(a.textContent);
            // 变体链接通常文本较短(颜色/尺码),排除长标题链接
            if (text && text.length < 60) {
              pushVariant({ sku: m[1], url: a.href, title: text });
            }
          }
        });
      } catch {}
    }

    // Strategy B:state JSON 里的 skus/variants 数组
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

    // Strategy C:JSON-LD Product 模型的 offers 数组
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
                    url: o.url || undefined,
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
  };
})();
