(function () {
  'use strict';

  // 标记：ozon-search.js 已经在本页注入。
  // ozon-data-panel.js 看到这个 flag 就跳过自己的数据面板渲染逻辑，
  // 让搜索/类目页继续由 ozon-search.js 一手管（含选品模式）。
  window.OzonHelperSearchInjected = true;

  const SELECTORS = [
    '[data-widget="searchResultsV2"] > div > div',
    '[data-widget="searchResults"] > div > div',
    '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
    '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
    '.tile-root',
  ];

  // --- Data Panel State ---
  // panelState.enabled = 数据面板自动加载开关。新用户默认开(true)— 搜索/类目页
  // 一进来卡片就自动挂面板、拉数据填充。老用户在 popup 里显式关过会读出来保持关。
  const panelState = { enabled: true };
  const panelDataCache = new Map();

  // --- TaskQueue ---
  // queue 由 content_scripts 注入顺序保证
  const taskQueue = new window.JZTaskQueue({
    concurrency: 6, // 数据面板请求并发上限(backend 走的 market/product stats)
    timeoutMs: 60000,
    autoPauseHigh: 12,
    autoPauseLow: 6,
    pauseLowPending: 12,
  });

  // 通用 staggered queue 工厂:while + 同步预占 inFlight/lastLaunchAt,timer=null
  // 单一 settled 信号,task timeout 防 service-worker hang。
  //
  // 历史:v0.9.91 写错的 inFlight++ 在 setTimeout 回调里,导致 pump 同步看到的
  // inFlight 永远是 0,30 个 add 全被一次性调度,concurrency 形同虚设。v0.9.92
  // 修了 variantsQueue,这里抽成工厂供 followSellQueue 复用同一份正确实现。
  function makeStaggeredQueue({ concurrency, staggerMs, taskTimeoutMs = 60000 }) {
    let inFlight = 0;
    let lastLaunchAt = 0;
    const waiting = [];
    const pump = () => {
      while (inFlight < concurrency && waiting.length > 0) {
        const next = waiting.shift();
        inFlight++;
        const sinceLast = Date.now() - lastLaunchAt;
        const wait = Math.max(0, staggerMs - sinceLast);
        lastLaunchAt = Date.now() + wait;
        setTimeout(() => {
          let timer = setTimeout(() => {
            if (timer == null) return;
            timer = null;
            next.reject(new Error('queue task timeout'));
            inFlight--;
            pump();
          }, taskTimeoutMs);
          Promise.resolve()
            .then(next.task)
            .then(
              (v) => {
                if (timer == null) return;
                clearTimeout(timer);
                timer = null;
                next.resolve(v);
                inFlight--;
                pump();
              },
              (e) => {
                if (timer == null) return;
                clearTimeout(timer);
                timer = null;
                next.reject(e);
                inFlight--;
                pump();
              }
            );
        }, wait);
      }
    };
    return {
      add: (task) =>
        new Promise((resolve, reject) => {
          waiting.push({ task, resolve, reject });
          pump();
        }),
    };
  }

  // searchVariants: seller-portal chrome.scripting.executeScript,反爬指纹敏感,
  // 30+ 卡同时打容易 403 雪崩。2 并发 + 300ms stagger。
  const variantsQueue = makeStaggeredQueue({ concurrency: 2, staggerMs: 300 });

  // jzFetchPublicFollowSell: composer-api 同源 fetch,heavier than seller-portal,
  // 比 variants 更保守:1 并发 + 500ms stagger,且 cache 命中(4h)时 0 网络成本,
  // 真正受限的只有首次访问的 SKU。
  const followSellQueue = makeStaggeredQueue({ concurrency: 1, staggerMs: 500 });

  function getCards() {
    const cards = new Set();
    SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((card) => cards.add(card));
    });
    return Array.from(cards);
  }

  function extractVisiblePriceText(card, priceNode) {
    const nodeText = priceNode?.textContent || '';
    if (nodeText && window.normalizePrice(nodeText) > 0) return nodeText;
    const text = (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/(\d[\d\s]*(?:[,.]\d{1,2})?)\s*(?:\u20bd|\u00a5|\u0440\u0443\u0431\.?)/i);
    return match ? match[0] : '';
  }

  function extractCardInfo(card) {
    const link = card.querySelector('a[href*="/product/"]');
    const img = card.querySelector('img');

    // 名称优先级（避开 Chrome 翻译污染 + 价格污染）：
    //   1. <a aria-label>            ← attribute，不被翻译
    //   2. <img alt>                 ← attribute，不被翻译
    //   3. <a> 内嵌的 title-like 元素(h3/h2/[class*=title]) ← 非翻译态精确取值
    // 不再 fallback 到 link.textContent / card.textContent —— 它们会抓到价格 span
    // (如 "110,21 ¥700,89 ¥−84%") 污染 name。
    // 拿不到原始名时 name 留空,让后端走 search-variant-model attr 4180 拿原始俄/英文名。
    const ariaLabel = (link?.getAttribute('aria-label') || '').trim();
    const imgAlt = (img?.getAttribute('alt') || '').trim();
    const translated = window.jzIsTranslated?.();
    const textTitle = translated
      ? ''
      : link?.querySelector('h3, h2, [class*="title"], [class*="Title"], [class*="name"]')?.textContent?.trim() || '';
    // 角标(Новинка / 0% до N дней 分期等)会被 textContent 抓进名字,剥掉它们;
    // 整串都是角标时留空,让后端 attr 4180 兜底拿原始俄文名。
    const title = window.jzStripPromo
      ? window.jzStripPromo(ariaLabel || imgAlt || textTitle)
      : ariaLabel || imgAlt || textTitle;

    const priceNode =
      card.querySelector('[data-widget="searchResultsPrice"]') ||
      card.querySelector('[data-widget="searchResultsV2"] [data-widget="webPrice"]') ||
      card.querySelector('[data-widget="webPrice"]');
    const priceText = extractVisiblePriceText(card, priceNode);
    const price = window.normalizePrice(priceText);

    return {
      url: link?.href || '',
      name: title,
      price,
      image: img?.getAttribute('src') || img?.getAttribute('data-src') || '',
    };
  }

  function ensureBadge(card) {
    let badge = card.querySelector('.ozon-helper-card-badge');
    if (badge) {
      return badge;
    }
    badge = document.createElement('div');
    badge.className = 'ozon-helper-card-badge';

    const priceNode =
      card.querySelector('[data-widget="searchResultsPrice"]') || card.querySelector('[data-widget="webPrice"]');
    const priceText = extractVisiblePriceText(card, priceNode);
    const price = window.normalizePrice(priceText);
    const oldPriceNode =
      card.querySelector('[data-widget="searchResultsOldPrice"]') || card.querySelector('[data-widget="oldPrice"]');
    const oldPriceText = oldPriceNode?.textContent || '';
    const oldPrice = window.normalizePrice(oldPriceText);
    const discount = oldPrice > price && oldPrice > 0 ? Math.round(((oldPrice - price) / oldPrice) * 100) : 0;

    const salesNode = card.querySelector('[data-widget="searchResultsSales"]');
    const salesText = salesNode?.textContent?.trim();

    const sellerNode = card.querySelector('[data-widget="searchResultsSeller"]');
    const sellerText = sellerNode?.textContent?.trim();

    // 评价数:Ozon 新版 DOM 移除了 data-widget,改用 span 文本匹配
    const _ratingSpan = Array.from(card.querySelectorAll('span')).find((s) => /отзыв/.test(s.textContent));
    const ratingText = _ratingSpan?.textContent?.trim();

    badge.innerHTML = `
      ${salesText ? `<div class="ozon-helper-card-sales">${salesText}</div>` : ''}
      ${discount ? `<div class="ozon-helper-card-discount">-${discount}%</div>` : ''}
      ${price ? `<div class="ozon-helper-card-price">${window.formatNumber(price)} ₽</div>` : ''}
      ${sellerText ? `<div class="ozon-helper-card-seller">${sellerText}</div>` : ''}
      ${ratingText ? `<div class="ozon-helper-card-rating">${ratingText}</div>` : ''}
    `;

    card.style.position = 'relative';
    card.appendChild(badge);

    return badge;
  }

  // --- Data Panel: Extract Product ID from URL ---
  // URL format: /product/some-name-here-1234567890/
  // The product ID is the last numeric segment after the final hyphen
  function extractProductId(url) {
    if (!url) return null;
    const m = url.match(/\/product\/.*-(\d{5,})/);
    return m ? m[1] : null;
  }

  // 格式化 + merge + 渲染统一放在 shared-utils.js,跟 ozon-data-panel.js 共用。
  // 见 window.jzMergeCardPanelData / window.jzRenderProductCardPanel /
  //   window.jzRenderPanelSkeleton。
  // 注:search 页暂未调用 fetchPublicFollowSell,hero「跟卖」会显示空态。

  // --- Data Panel: Load data for a card(通过 JZTaskQueue 节流) ---
  // panel 数据展示无条件加载。
  async function loadPanelData(card, panel) {
    if (panel) panel.dataset.jzLoadStatus = 'loading';
    const info = extractCardInfo(card);
    const productId = extractProductId(info.url);
    if (!productId) {
      if (panel) panel.dataset.jzLoadStatus = 'error';
      panel.innerHTML = '';
      return;
    }

    // 用于 collectDone 广播快速定位面板
    card.dataset.jzSku = productId;
    if (panel) panel.dataset.jzSku = productId;

    // 异步写 dom 缓存(card 类型,商品卡 DOM 字段,fire-and-forget)
    if (productId && window.sendMessage) {
      try {
        window.sendMessage('domCacheSet', {
          sku: String(productId),
          type: 'card',
          data: {
            sku: String(productId),
            url: info.url || '',
            name: info.name || '',
            price: info.price != null ? Number(info.price) : null,
            image: info.image || '',
          },
        });
      } catch {
        /* fire-and-forget */
      }
    }

    // 新采集队列:fire-and-forget 提交任务(搜索页无 sellerSlug,传空字符串)
    if (window.__jzSubmitCollectTask) {
      window.__jzSubmitCollectTask(productId, card, '', '').catch(() => {});
    }

    if (panelDataCache.has(productId)) {
      const cached = panelDataCache.get(productId);
      // V2 优先(对齐详情页 5-section)— 用 cached.preFetched 复用之前 fetch 结果
      if (typeof window.jzRenderProductPanelV2 === 'function' && cached?.preFetched) {
        window.jzRenderProductPanelV2(panel, { sku: productId, initial: cached });
        try {
          await window.jzPopulatePanelV2(panel, productId, { preFetched: cached.preFetched });
        } catch {}
      } else {
        window.jzRenderProductCardPanel(panel, cached);
      }
      if (panel) panel.dataset.jzLoadStatus = 'ready';
      return;
    }

    const showError = () => {
      if (panel) panel.dataset.jzLoadStatus = 'error';
      panel.innerHTML =
        '<div class="ozon-helper-panel-error" style="cursor:pointer;color:var(--oh-red,#ff4d4f);font-size:12px;padding:8px 12px;">数据加载失败，点击重试</div>';
      panel.querySelector('.ozon-helper-panel-error')?.addEventListener(
        'click',
        () => {
          window.jzRenderPanelSkeleton(panel);
          loadPanelData(card, panel);
        },
        { once: true }
      );
    };

    try {
      // TaskQueue 通过 taskId 去重(同 sku 重复入队复用同一 promise)。
      // 三个独立队列:
      //   - taskQueue(6 并发):backend 的 market/product stats
      //   - variantsQueue(2 并发,300ms):seller-portal searchVariants
      //     (sw.js 已切到 /api/v1/search + bundle 注入 4497/9454-9456 物理 attr,
      //     数据卡片重量·尺寸直接从 sv items[0].attributes 拿到,无需 /features/ 兜底)
      //   - followSellQueue(1 并发,500ms):composer-api 跟卖数
      // 公共 fetch 内部都有 sessionStorage cache,首屏后命中即返不打网。
      const fetchTask = () =>
        Promise.allSettled([
          window.sendMessage('getMarketStats', { sku: productId, period: window.jzGetSalesPeriod?.() || 'monthly' }),
          window.sendMessage('getProductStats', { url: info.url, period: window.jzGetSalesPeriod?.() || 'monthly' }),
          variantsQueue.add(() => window.sendMessage('searchVariants', { sku: productId })),
          followSellQueue.add(() => window.jzFetchPublicFollowSell(productId)),
        ]);
      const [marketResult, productResult, variantResult, followSellResult] = await taskQueue.add(
        `stats-${productId}`,
        fetchTask
      );

      if (marketResult.status === 'rejected' && productResult.status === 'rejected') {
        showError();
        return;
      }

      // sv 失败/auth issue 兜底:从 chrome.storage.local 读详情页采集的 cache
      // (用户曾访问该 SKU 详情页时 jzc-calc/ozon-product 抓的真实数据)
      const cachedWeightDims =
        variantResult.status !== 'fulfilled' || !variantResult.value?.items?.[0]
          ? await (window.jzReadCachedWeightDims?.(productId).catch(() => null) ?? null)
          : null;

      const data = window.jzMergeCardPanelData(
        marketResult.status === 'fulfilled' ? marketResult.value : null,
        productResult.status === 'fulfilled' ? productResult.value : null,
        variantResult.status === 'fulfilled' ? variantResult.value : null,
        followSellResult.status === 'fulfilled' && followSellResult.value
          ? {
              followSellCount: followSellResult.value.count,
              sellers: followSellResult.value.sellers,
            }
          : null,
        productId,
        cachedWeightDims
      );
      // 挂 preFetched 让后续 cache 命中时 V2 复用,避免再次往 backend / SW 发请求
      data.preFetched = {
        stats: productResult,
        market: marketResult,
        variant: variantResult,
        followCount: followSellResult,
      };
      panelDataCache.set(productId, data);
      // V2 完整对齐详情页 5-section 布局(类目/品牌/佣金/促销/流量等)
      if (typeof window.jzRenderProductPanelV2 === 'function') {
        window.jzRenderProductPanelV2(panel, { sku: productId, initial: data });
        try {
          await window.jzPopulatePanelV2(panel, productId, { preFetched: data.preFetched });
        } catch {}
      } else {
        window.jzRenderProductCardPanel(panel, data);
      }

      if (panel) panel.dataset.jzLoadStatus = 'ready';
    } catch {
      showError();
    }
  }

  // --- Data Panel: 点击事件分发(hero followsell + 底部按钮) ---
  function getPanelFollowSellProduct(card, panel) {
    const info = extractCardInfo(card);
    const productId = extractProductId(info.url);
    if (!productId) return null;
    const cached = panelDataCache.get(productId) || {};
    return {
      sku: String(productId),
      productId: String(productId),
      url: info.url,
      followSellCount: cached.followSellCount,
    };
  }

  async function handlePanelAction(action, card, panel, btn) {
    if (action === 'toggle-section') {
      window.JZSidebarSectionToggle?.toggleSidebarSection(btn);
      return;
    }

    // 字段设置齿轮:不依赖 info.url(放在 url 守卫之前),对全站数据卡生效。
    if (action === 'open-field-settings') {
      window.jzOpenFieldSettings?.(panel);
      return;
    }

    const info = extractCardInfo(card);
    if (!info.url) return;

    if (action === 'show-followsell-modal' || action === 'view-sellers') {
      // Hero follow-sell stat: show our seller modal; keep Ozon URL fallback.
      const product = getPanelFollowSellProduct(card, panel);
      if (product && window.jzShowFollowSellListModal) {
        window.jzShowFollowSellListModal(btn, product, { trigger: 'click' });
      } else {
        const sep = info.url.includes('?') ? '&' : '?';
        window.open(`${info.url}${sep}prefer_sellers=true`, '_blank');
      }
      return;
    }

    if (action === 'open-followsell' || action === 'follow-sell') {
      // 底部「一键跟卖」按钮 → 主扩展上架面板
      window.open(info.url + '#jz-follow-sell', '_blank');
      return;
    }

    if (action === 'edit-list') {
      await handleEditList(card, panel, btn, info);
      return;
    }

    if (action === 'collect-one') {
      await handleCollectOne(card, panel, btn, info);
      return;
    }
  }

  // 「采集」按钮:与 action bar 上的「一键采集」语义统一,写 backend 采集箱
  // (pushSourceCollect)。
  //
  // resp shape (SW ENVELOPE_FIX 2025-05):{ dedupeHit, lastAt, result }。
  // sendMessage 在 SW ok:false 时直接 reject(走外层 catch),不必检查 resp.ok。
  async function handleCollectOne(card, panel, btn, info) {
    if (btn.dataset.busy === '1') return;
    const productId = extractProductId(info.url);
    if (!productId) {
      flashBtn(btn, '无效 SKU', 'is-failed', 1500);
      return;
    }
    btn.dataset.busy = '1';
    try {
      // 优先用 panelDataCache 里已加载的完整数据;还没加载就用最少字段(标题/图/价/url)
      const data = panelDataCache.get(productId) || null;

      // 1. searchVariants 补 sv 富字段(品牌/类目/属性),失败兜底空
      const variantResp = await window.sendMessage('searchVariants', { sku: productId }).catch(() => null);
      const variantItems = variantResp?.items || variantResp?.data?.items || [];
      const variantMatch = variantItems.find((it) => String(it.variant_id) === productId) || variantItems[0] || null;

      // 2. 写 backend 采集箱(主路径)
      // 跟卖式 catalog:name/images 切 sv(search+bundle)优先,DOM(info)兜底;
      // 统计仍走 DOM/后端 stats(seller-portal 不返回)。
      const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
      const collectName = window.jzPreferSourceName
        ? window.jzPreferSourceName(svCat?.name, info.name)
        : info.name || svCat?.name || '';
      const collectImages = svCat?.images?.length ? svCat.images : info.image ? [info.image] : [];
      const collectPayload = {
        sku: String(productId),
        url: info.url,
        name: collectName || info.name,
        price: info.price != null ? String(info.price) : undefined,
        image: svCat?.mainImage || info.image || undefined,
        images: collectImages.length ? collectImages : undefined,
        variantData: variantMatch || undefined,
        soldCount: data?.soldCount ?? undefined,
        soldSum: data?.gmvSum != null ? String(data.gmvSum) : undefined,
        views: data?.views ?? undefined,
        convViewToOrder: data?.convViewToOrder != null ? String(data.convViewToOrder) : undefined,
        discount: data?.discount != null ? String(data.discount) : undefined,
        gmvSum: data?.gmvSum != null ? String(data.gmvSum) : undefined,
      };
      const resp = await window.sendMessage('pushSourceCollect', {
        sourceId: 'ozon',
        raw: collectPayload,
      });

      const label = resp?.dedupeHit ? '近期已采集' : '已采集';
      flashBtn(btn, label, 'is-collected', 1800);
    } catch (e) {
      console.warn('[ozon-helper] collect-one failed:', e);
      const msg = e?.message || '';
      const friendly = /NETWORK_ERROR|超时|timeout|网络/i.test(msg) ? '网络错误' : '失败';
      flashBtn(btn, friendly, 'is-failed', 1800);
    } finally {
      btn.dataset.busy = '';
    }
  }

  function flashBtn(btn, text, cls, ms) {
    const original = btn.innerHTML;
    btn.classList.add(cls);
    btn.innerHTML = `<span class="oh-btn-icon">✓</span>${text}`;
    setTimeout(() => {
      btn.classList.remove(cls);
      btn.innerHTML = original;
    }, ms);
  }

  async function handleEditList(card, panel, btn, info) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '采集中…';

    try {
      const sku = extractProductId(info.url);
      if (!sku) throw new Error('missing-sku');

      const variantResp = await window.sendMessage('searchVariants', { sku }).catch(() => null);
      const variantItems = variantResp?.items || variantResp?.data?.items || [];
      const variantMatch = variantItems.find((it) => String(it.variant_id) === sku) || variantItems[0] || null;

      // sendMessage 在 SW ok:false 时直接 reject(走外层 catch),resolve 时只透出
      // response.data。SW 已统一把 envelope 塞进 data,resp 形如 { dedupeHit, lastAt, result }。
      // 不再检查 resp.ok — 那是历史残留,resp 已不带 envelope。
      // 跟卖式 catalog:name/images 切 sv 优先,DOM(info)兜底。
      const svCat = window.jzExtractCatalogFromSv ? window.jzExtractCatalogFromSv(variantMatch) : null;
      const collectName = window.jzPreferSourceName
        ? window.jzPreferSourceName(svCat?.name, info.name)
        : info.name || svCat?.name || '';
      const collectImages = svCat?.images?.length ? svCat.images : info.image ? [info.image] : [];
      const resp = await window.sendMessage('pushSourceCollect', {
        sourceId: 'ozon',
        raw: {
          sku,
          url: info.url,
          name: collectName || info.name,
          price: info.price != null ? String(info.price) : undefined,
          image: svCat?.mainImage || info.image || undefined,
          images: collectImages.length ? collectImages : undefined,
          variantData: variantMatch || undefined,
        },
      });
      const itemId = resp?.result?.id;
      const auth = await window.sendMessage('getAuth');
      const frontendUrl = auth?.backendUrl?.includes('localhost')
        ? 'http://localhost:3000'
        : `https://${globalThis.__JZ_BRAND__.webHost}`;
      window.open(
        itemId ? `${frontendUrl}/ozon/products/collect/edit?id=${itemId}` : `${frontendUrl}/ozon/products/collect`,
        '_blank'
      );
      btn.innerHTML = resp.dedupeHit ? '近期已采集' : original;
      btn.disabled = false;
      btn.dataset.busy = '0';
      if (resp.dedupeHit) {
        setTimeout(() => {
          btn.innerHTML = original;
        }, 2500);
      }
    } catch (err) {
      console.error('[ozon-helper] search edit-list failed:', err);
      const msg = err?.message || '';
      btn.innerHTML = /NETWORK_ERROR|超时|timeout|网络/i.test(msg) ? '网络错误' : '失败';
      setTimeout(() => {
        btn.innerHTML = original;
        btn.disabled = false;
        btn.dataset.busy = '0';
      }, 2500);
    }
  }

  // --- Data Panel: Inject panel inside card (bottom) ---
  function ensureDataPanel(card) {
    if (card._ohPanelAttached) return;
    card._ohPanelAttached = true;

    const panel = document.createElement('div');
    panel.className = 'ozon-helper-data-panel';
    panel.setAttribute('lang', 'zh-Hans');
    window.jzRenderPanelSkeleton(panel);
    panel.dataset.jzLoadStatus = 'pending';
    card.appendChild(panel);
    card._ohPanel = panel;

    // 阻止 hero/按钮 click 冒泡到 Ozon tile(避免误触发跳转)
    panel.addEventListener('click', (e) => {
      const target = e.target.closest('[data-click-action], [data-action]');
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const action = target.getAttribute('data-click-action') || target.getAttribute('data-action');
      handlePanelAction(action, card, panel, target);
    });

    // Use IntersectionObserver for lazy loading
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            observer.disconnect();
            loadPanelData(card, panel);
          }
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(panel);
  }

  function removeDataPanel(card) {
    if (card._ohPanel) {
      card._ohPanel.remove();
      card._ohPanel = null;
    }
    card._ohPanelAttached = false;
  }

  // --- Data Panel: 开关从 chrome.storage.local 读取 + 监听 onChanged ---
  // 旧版本是右下角浮动 toggle 按钮（.ozon-helper-panel-toggle）。
  // 现在统一移到极掌 popup 里 toggle，状态持久化到
  // chrome.storage.local.ozon_data_panel_enabled。
  const PANEL_STORAGE_KEY = 'ozon_data_panel_enabled';

  async function loadPanelEnabled() {
    try {
      const r = await chrome.storage.local.get(PANEL_STORAGE_KEY);
      // 默认 true(首次安装/未设置 = 自动加载数据面板,跟 popup 默认显示一致)。
      // 只有 storage 里显式存 false 才关 — 老用户关过的状态会保留。
      panelState.enabled = r[PANEL_STORAGE_KEY] !== false;
    } catch {
      panelState.enabled = true;
    }
  }

  function listenStorageToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!changes[PANEL_STORAGE_KEY]) return;
        // !== false 兼容 undefined/true 两种 default-on 写法
        panelState.enabled = changes[PANEL_STORAGE_KEY].newValue !== false;
        const cards = getCards();
        if (panelState.enabled) {
          cards.forEach((c) => ensureDataPanel(c));
        } else {
          cards.forEach((c) => removeDataPanel(c));
        }
      });
    } catch {}
  }

  function applyToCards() {
    const cards = getCards();
    cards.forEach((card) => {
      ensureBadge(card);
      if (panelState.enabled) {
        ensureDataPanel(card);
      }
    });
  }

  function createObserver() {
    let _applyPending = false;
    const observer = new MutationObserver(() => {
      if (_applyPending) return;
      _applyPending = true;
      requestAnimationFrame(() => {
        _applyPending = false;
        applyToCards();
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // 接收 SW 推送的 collectDone 事件,回填面板数据(搜索页无 ozon-data-panel.js)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'collectDone' || !msg.sku || !msg.data) return;
    const skuStr = String(msg.sku);
    const panel = document.querySelector(`[data-jz-sku="${skuStr}"] .ozon-helper-data-panel`);
    if (panel && typeof window.jzPopulatePanelV2 === 'function') {
      try {
        window.jzPopulatePanelV2(panel, skuStr, { preFetched: msg.data });
      } catch (e) {
        console.warn('[ozon-search] collectDone 回填面板失败:', skuStr, e);
      }
    }
  });

  async function init() {
    const auth = await window.checkAuth();
    if (!auth.loggedIn) {
      window.createLoginPrompt();
      return;
    }

    await loadPanelEnabled();
    listenStorageToggle();
    applyToCards();
    createObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
