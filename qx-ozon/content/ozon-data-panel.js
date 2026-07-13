/**
 * 数据面板 — 在所有 ozon.ru 商品卡下方注入「极掌 ERP」销量/转化数据卡。
 *
 * 跟 ozon-search.js 的关系：
 *   - 之前数据面板逻辑跟「选品模式 / 采集器 / 自动滚动 / 关键词导航」捆在 ozon-search.js
 *   - manifest matches 仅 search / category / search-by-image，其他页（首页、商品详情页推荐区、
 *     品牌页、卖家店铺页、收藏夹）注不进去 → 看不到数据卡
 *   - 抽出独立脚本 + manifest matches 改成 www.ozon.ru/*，全站注入
 *   - 选品模式等 search-only 功能仍留在 ozon-search.js
 *
 * 共用资源（shared-utils.js 提供，content_scripts 加载顺序保证）：
 *   - window.formatNumber
 *   - window.sendMessage
 *   - window.JZTaskQueue（用于节流并发请求）
 *   - window.checkAuth（避免未登录时白打请求）
 */
(function () {
  'use strict';

  // 通用商品卡 selector — Ozon 各页面（search / category / 首页 carousel /
  // brand / seller / 收藏夹 / 商品详情页"也看了"）目前都用 .tile-root 作为容器
  const CARD_SELECTORS = [
    '.tile-root',
    '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
    '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
  ];

  // skipPaths：商品详情页本体（/product/<id>/）已经有侧边栏数据卡，
  // 不要在它的"也看了" tile 上重复出现（会被商品详情侧边卡盖住信息）
  // 改主意：还是在所有 tile 上展示，这样用户在详情页也能直接对比"也看了"的数据。
  // 留空，全站注入。
  const SKIP_PATHS = [];

  const panelState = { enabled: true };
  const panelDataCache = new Map();
  let onlyWithSales = false;
  // 从 jz-seller-info 事件缓存的当前页卖家 slug,供 loadPanelData → collectAutoIfMatched 用。
  // 店铺页 seller-info-main.js 提取后通过 CustomEvent 推过来;非店铺页保持 ''。
  let sellerSlug = '';

  // ── 采集状态同步到商品卡(徽章+状态条) ──────────────────────────
  // sku → { status, reason, results, duration, timestamp }
  // status: 'success' | 'partial' | 'skipped' | 'failed' | 'antibot'
  // reason: skipped 时为 'not-running'/'paused'/'daily-limit'/'non-chinese-store'/'unclassified-store'/'all-cached'
  // results: [{type, hit}] 8 类缓存命中明细
  const _collectStatusMap = new Map();
  let _collectStatusMapReady = false;

  // 初始化:从 SW 拉取最近 200 条采集记录,填充 Map
  async function _initCollectStatusMap() {
    if (_collectStatusMapReady) return;
    _collectStatusMapReady = true; // 防止重复加载
    try {
      const recent = await window.sendMessage('autoCollectGetRecent', { limit: 200 });
      if (!Array.isArray(recent)) return;
      // 倒序遍历,后到的覆盖先到的(保留最近一次状态)
      for (let i = recent.length - 1; i >= 0; i--) {
        const e = recent[i];
        if (!e || !e.sku) continue;
        if (!_collectStatusMap.has(e.sku)) {
          _collectStatusMap.set(String(e.sku), {
            status: e.status,
            reason: e.reason || null,
            results: e.results || null,
            duration: e.duration,
            timestamp: e.timestamp,
          });
        }
      }
      console.log('[ozon-data-panel] _collectStatusMap 初始化完成, 共', _collectStatusMap.size, '条');
      // 刷新当前页所有已渲染的商品卡
      _refreshAllCollectStatusUi();
    } catch (e) {
      console.warn('[ozon-data-panel] _initCollectStatusMap 失败:', e);
    }
  }

  // 接收 SW 推送的 collectDone 事件,实时更新
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'collectDone' || !msg.entry?.sku) return;
    const e = msg.entry;
    _collectStatusMap.set(String(e.sku), {
      status: e.status,
      reason: e.reason || null,
      results: e.results || null,
      duration: e.duration,
      timestamp: e.timestamp,
    });
    _refreshCollectStatusUi(String(e.sku));
  });

  // 状态文案
  const _COLLECT_STATUS_LABELS = {
    success: { text: '已采集', icon: '✓', color: '#16a34a' },
    partial: { text: '部分采集', icon: '◐', color: '#f59e0b' },
    skipped: { text: '跳过', icon: '−', color: '#94a3b8' },
    failed: { text: '失败', icon: '✗', color: '#ef4444' },
    antibot: { text: '熔断', icon: '⚠', color: '#f97316' },
  };
  const _COLLECT_REASON_LABELS = {
    'not-running': '自动采集未开启',
    paused: '冷却期中',
    'daily-limit': '达每日上限',
    'non-chinese-store': '非中国店铺',
    'unclassified-store': '店铺未分类',
    'all-cached': '8 类缓存全命中',
    antibot: '反爬熔断',
  };
  const _CACHE_TYPE_LABELS = ['card', 'detail', 'composer', 'entrypoint', 'search', 'bundle', 'marketStats', 'followSell'];

  // 渲染状态条(数据面板底部)
  function renderCollectStatusBar(panel, sku) {
    if (!panel) return;
    let bar = panel.querySelector('.jz-collect-status-bar');
    const status = _collectStatusMap.get(String(sku));
    if (!status) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'jz-collect-status-bar';
      panel.appendChild(bar);
    }
    const meta = _COLLECT_STATUS_LABELS[status.status] || _COLLECT_STATUS_LABELS.failed;
    const reasonText = status.reason ? ` · ${_COLLECT_REASON_LABELS[status.reason] || status.reason}` : '';
    const durationText = status.duration != null ? ` · ${(status.duration / 1000).toFixed(1)}s` : '';
    // 8 类缓存命中明细
    let cacheDetail = '';
    if (Array.isArray(status.results) && status.results.length > 0) {
      const hitCount = status.results.filter((r) => r.hit).length;
      const detailParts = status.results.map((r) => {
        const label = r.type;
        return `<span class="jz-cache-${r.hit ? 'hit' : 'miss'}">${label}${r.hit ? '✓' : '✗'}</span>`;
      });
      cacheDetail = ` · <span class="jz-cache-summary">${hitCount}/${status.results.length}</span> <span class="jz-cache-detail">${detailParts.join(' ')}</span>`;
    }
    bar.innerHTML =
      `<span class="jz-collect-status-icon" style="color:${meta.color}">${meta.icon}</span>` +
      `<span class="jz-collect-status-text" style="color:${meta.color}">${meta.text}</span>` +
      `<span class="jz-collect-status-reason">${reasonText}${durationText}${cacheDetail}</span>`;
    bar.dataset.status = status.status;
  }

  // 渲染角落徽章(商品卡 tile-root 右上角)
  function updateCollectBadge(card, sku) {
    if (!card) return;
    let badge = card.querySelector('.jz-collect-badge');
    const status = _collectStatusMap.get(String(sku));
    if (!status) {
      if (badge) badge.remove();
      return;
    }
    const meta = _COLLECT_STATUS_LABELS[status.status] || _COLLECT_STATUS_LABELS.failed;
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'jz-collect-badge';
      card.appendChild(badge);
    }
    badge.textContent = meta.icon;
    badge.style.backgroundColor = meta.color;
    badge.dataset.status = status.status;
    badge.title = `${meta.text}${status.reason ? ' · ' + (_COLLECT_REASON_LABELS[status.reason] || status.reason) : ''}`;
  }

  // 刷新单个 SKU 对应的所有商品卡 UI(徽章+状态条)
  function _refreshCollectStatusUi(sku) {
    const cards = document.querySelectorAll(CARD_SELECTORS.join(','));
    for (const card of cards) {
      const link = card.querySelector('a[href*="/product/"]');
      if (!link) continue;
      const m = link.href.match(/\/product\/.*-(\d{5,})/);
      if (!m) continue;
      if (String(m[1]) !== String(sku)) continue;
      updateCollectBadge(card, sku);
      const panel = card._ohPanel;
      if (panel) renderCollectStatusBar(panel, sku);
    }
  }

  // 刷新当前页所有商品卡 UI
  function _refreshAllCollectStatusUi() {
    const cards = document.querySelectorAll(CARD_SELECTORS.join(','));
    for (const card of cards) {
      const link = card.querySelector('a[href*="/product/"]');
      if (!link) continue;
      const m = link.href.match(/\/product\/.*-(\d{5,})/);
      if (!m) continue;
      updateCollectBadge(card, m[1]);
      const panel = card._ohPanel;
      if (panel) renderCollectStatusBar(panel, m[1]);
    }
  }

  // 启动时拉取一次
  setTimeout(_initCollectStatusMap, 1500);

  // 节流并发：跟原 ozon-search 配置一致
  const taskQueue = new window.JZTaskQueue({
    concurrency: 6,
    timeoutMs: 60000,
    autoPauseHigh: 12,
    autoPauseLow: 6,
    pauseLowPending: 12,
  });

  // ─── 工具函数 ──────────────────────────────────────
  function extractProductId(url) {
    if (!url) return null;
    const m = url.match(/\/product\/.*-(\d{5,})/);
    return m ? m[1] : null;
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

    // 名称优先级（避开 Chrome 翻译污染）：
    //   1. <a aria-label>            ← attribute，不被翻译
    //   2. <img alt>                 ← attribute，不被翻译
    //   3. <a> 上嵌入的 [data-state] / span 子元素 textContent —— 翻译态下退化
    //   4. <a> textContent            ← 翻译态下是中文，**仅在非翻译态使用**
    // 翻译态下若都拿不到原始名，name 留空，让后端走 search-variant-model
    // attr 4180 拿原始俄/英文名（更可靠）。
    const ariaLabel = (link?.getAttribute('aria-label') || '').trim();
    const imgAlt = (img?.getAttribute('alt') || '').trim();
    const translated = window.jzIsTranslated?.();
    const textTitle = translated ? '' : link?.textContent?.trim() || card.textContent?.trim().slice(0, 120) || '';
    const title = ariaLabel || imgAlt || textTitle;

    const priceNode =
      card.querySelector('[data-widget="searchResultsPrice"]') || card.querySelector('[data-widget="webPrice"]');
    const priceText = extractVisiblePriceText(card, priceNode);
    const price = window.normalizePrice ? window.normalizePrice(priceText) : null;

    return {
      url: link?.href || '',
      name: title,
      price,
      image: img?.getAttribute('src') || img?.getAttribute('data-src') || '',
    };
  }

  // 格式化 + 数据合并 + 渲染逻辑统一放在 shared-utils.js,跟 ozon-search.js 共用。
  // 见 window.jzMergeCardPanelData / window.jzRenderProductCardPanel /
  //   window.jzRenderPanelSkeleton。

  // 渲染逻辑统一在 shared-utils.js 的 window.jzRenderProductCardPanel。

  // ─── 加载数据 + 渲染 ─────────────────────────────────
  async function loadPanelData(card, panel) {
    if (panel) panel.dataset.jzLoadStatus = 'loading';
    const info = extractCardInfo(card);
    const productId = extractProductId(info.url);
    if (!productId) {
      if (panel) panel.dataset.jzLoadStatus = 'error';
      panel.innerHTML = '';
      return;
    }

    // 异步写 card 缓存(商品卡 DOM 5 字段,fire-and-forget,对齐 ozon-search.js)
    if (window.sendMessage) {
      try {
        window.sendMessage('cardCacheSet', {
          sku: String(productId),
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

    if (panelDataCache.has(productId)) {
      const cached = panelDataCache.get(productId);
      // V2 优先(对齐详情页 5-section 布局),用 cached.preFetched 复用之前已 fetch 的结果
      if (typeof window.jzRenderProductPanelV2 === 'function' && cached?.preFetched) {
        window.jzRenderProductPanelV2(panel, { sku: productId, initial: cached });
        try {
          await window.jzPopulatePanelV2(panel, productId, { preFetched: cached.preFetched });
        } catch {}
      } else {
        window.jzRenderProductCardPanel(panel, cached);
      }
      if (panel) panel.dataset.jzLoadStatus = 'ready';
      // 触发 autoCollect(检查 onlyWithSales / smartFilter / 中国店铺 Gate 0.5);
      // fire-and-forget,不阻塞 panel 渲染。sellerSlug 来自 jz-seller-info 事件缓存。
      window.__jzCollectAutoIfMatched?.(productId, card, info, cached, panel, 'shop-page', sellerSlug);
      // 渲染采集状态(徽章+状态条)
      updateCollectBadge(card, productId);
      renderCollectStatusBar(panel, productId);
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
      // searchVariants 现走 sw.js /api/v1/search + bundle 组合,bundle 注入物理 attr
      // (4497 重量、9454-9456 尺寸)到 items[0].attributes,jzMergeCardPanelData
      // 直接从 sv 拿到。jzFetchPublicFollowSell 同源 composer-api 内部有 cache。
      const fetchTask = () =>
        Promise.allSettled([
          window.sendMessage('getMarketStats', { sku: productId }),
          window.sendMessage('getProductStats', { url: info.url }),
          window.sendMessage('searchVariants', { sku: productId }),
          window.jzFetchPublicFollowSell(productId),
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
      // 把 fetch 结果挂到 cache 上,后续命中 cache 时 V2 走 preFetched 路径
      // 复用已有结果,避免再次往 backend / SW 发请求。
      data.preFetched = {
        stats: productResult,
        market: marketResult,
        variant: variantResult,
        followCount: followSellResult,
      };
      panelDataCache.set(productId, data);
      // V2 完整对齐详情页 5-section 布局(对齐 PDP)。jzRenderProductPanelV2 渲染
      // 骨架,jzPopulatePanelV2(走 preFetched 路径)同步把 stats / market /
      // variant / followCount 字段灌进 data-field 节点。fallback 走旧 V1 渲染。
      if (typeof window.jzRenderProductPanelV2 === 'function') {
        window.jzRenderProductPanelV2(panel, { sku: productId, initial: data });
        try {
          await window.jzPopulatePanelV2(panel, productId, { preFetched: data.preFetched });
        } catch {}
      } else {
        window.jzRenderProductCardPanel(panel, data);
      }

      if (panel) panel.dataset.jzLoadStatus = 'ready';
      // 触发 autoCollect(检查 onlyWithSales / smartFilter / 中国店铺 Gate 0.5);
      // fire-and-forget,不阻塞 panel 渲染。sellerSlug 来自 jz-seller-info 事件缓存。
      window.__jzCollectAutoIfMatched?.(productId, card, info, data, panel, 'shop-page', sellerSlug);
      // 渲染采集状态(徽章+状态条)
      updateCollectBadge(card, productId);
      renderCollectStatusBar(panel, productId);
    } catch {
      showError();
    }
  }

  function ensureDataPanel(card) {
    if (card._ohPanelAttached) return;
    // 跳过没商品链接的 tile（推广位 / 占位 / 类目 chip 之类）
    if (!card.querySelector('a[href*="/product/"]')) return;
    card._ohPanelAttached = true;

    const panel = document.createElement('div');
    panel.className = 'ozon-helper-data-panel';
    panel.setAttribute('lang', 'zh-Hans');
    window.jzRenderPanelSkeleton(panel);
    panel.dataset.jzLoadStatus = 'pending';
    card.appendChild(panel);
    card._ohPanel = panel;

    // 阻止整个 panel 的 click 冒泡到 Ozon tile（避免误触发跳转）
    panel.addEventListener('click', (e) => {
      const actionTarget = e.target.closest('[data-click-action], [data-action]');
      if (!actionTarget) return;
      e.preventDefault();
      e.stopPropagation();
      const action = actionTarget.getAttribute('data-click-action') || actionTarget.getAttribute('data-action');
      handlePanelAction(action, card, panel, actionTarget);
    });

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

  // ─── 点击事件分发 ──────────────────────────────────
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

  function handlePanelAction(action, card, panel, btn) {
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
      // 底部「一键跟卖」按钮:新 tab + URL hash 唤起主扩展上架面板(批采/AI 改图)
      window.open(info.url + '#jz-follow-sell', '_blank');
      return;
    }

    if (action === 'edit-list') {
      handleEditList(card, panel, btn);
      return;
    }

    if (action === 'collect-one') {
      handleCollectOne(card, panel, btn, info);
      return;
    }
  }

  // 「采集」按钮:写 backend 采集箱(pushSourceCollect)。
  //
  // resp shape (SW ENVELOPE_FIX 2025-05):{ dedupeHit, lastAt, result }
  //   - dedupeHit:24h 内已采过同 SKU,SW 走 cache 没打 backend
  //   - result.id:backend OzonCollectBoxItem.id(可用于跳编辑页)
  // sendMessage 在 SW ok:false 时直接 reject(走外层 catch),不必检查 resp.ok。
  async function handleCollectOne(card, panel, btn, info) {
    if (btn.dataset.busy === '1') return;
    const productId = extractProductId(info.url);
    if (!productId) {
      _flashBtn(btn, '无效 SKU', 'is-failed', 1500);
      return;
    }
    btn.dataset.busy = '1';
    try {
      const data = panelDataCache.get(productId) || null;

      // 1. searchVariants 补 sv 数据(品牌/类目/属性等富字段),失败兜底空
      const variantResp = await window.sendMessage('searchVariants', { sku: productId }).catch(() => null);
      const variantItems = variantResp?.items || variantResp?.data?.items || [];
      const variantMatch = variantItems.find((it) => String(it.variant_id) === productId) || variantItems[0] || null;

      // 2. 写 backend 采集箱(主路径)
      const collectPayload = {
        sku: String(productId),
        url: info.url,
        name: info.name,
        price: info.price != null ? String(info.price) : undefined,
        image: info.image || undefined,
        images: info.image ? [info.image] : undefined,
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
      _flashBtn(btn, label, 'is-collected', 1800);
    } catch (e) {
      console.warn('[ozon-helper] data-panel collect-one failed:', e);
      const msg = e?.message || '';
      const friendly = /NETWORK_ERROR|超时|timeout|网络/i.test(msg) ? '网络错误' : '失败';
      _flashBtn(btn, friendly, 'is-failed', 1800);
    } finally {
      btn.dataset.busy = '';
    }
  }

  function _flashBtn(btn, text, cls, ms) {
    const original = btn.innerHTML;
    btn.classList.add(cls);
    btn.innerHTML = `<span class="oh-btn-icon">✓</span>${text}`;
    setTimeout(() => {
      btn.classList.remove(cls);
      btn.innerHTML = original;
    }, ms);
  }

  // ─── 编辑上架：复刻 ozon-product.js:1599-1649 的 edit-list 流程 ──
  async function handleEditList(card, panel, btn) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '采集中…';

    try {
      const info = extractCardInfo(card);
      const sku = extractProductId(info.url);
      if (!sku) throw new Error('missing-sku');

      const variantResp = await window.sendMessage('searchVariants', { sku }).catch(() => null);
      const variantItems = variantResp?.items || variantResp?.data?.items || [];
      const variantMatch = variantItems.find((it) => String(it.variant_id) === sku) || variantItems[0] || null;

      const collectPayload = {
        sku,
        url: info.url,
        name: info.name,
        price: info.price != null ? String(info.price) : undefined,
        image: info.image || undefined,
        images: info.image ? [info.image] : undefined,
        variantData: variantMatch || undefined,
      };
      // SW 把 envelope (dedupeHit/lastAt) + 后端 result 都装进 data,这里 resp 已是
      // { dedupeHit, lastAt, result }。itemId 在 result.id。
      const resp = await window.sendMessage('pushSourceCollect', {
        sourceId: 'ozon',
        raw: collectPayload,
      });
      const itemId = resp?.result?.id;
      const auth = await window.sendMessage('getAuth');
      // 从 brand webHost 直接构造,不要从 backendUrl 反推 — 旧 `.replace('/api','')`
      // 会把 `https://api.jizhangerp.com` 中 `://api` 后 4 字符 `/api` 误删,
      // 得到 `https:/.jizhangerp.com` 残缺 URL,浏览器按相对路径解析 →
      // 拼到 ozon.ru 下变成 `https://www.ozon.ru/.jizhangerp.com/...`。
      const frontendUrl = auth?.backendUrl?.includes('localhost')
        ? 'http://localhost:3000'
        : `https://${globalThis.__JZ_BRAND__.webHost}`;
      if (itemId) {
        window.open(`${frontendUrl}/ozon/products/collect/edit?id=${itemId}`, '_blank');
      } else {
        window.open(`${frontendUrl}/ozon/products/collect`, '_blank');
      }
      btn.innerHTML = original;
      btn.disabled = false;
      btn.dataset.busy = '0';
    } catch (err) {
      console.warn('[ozon-helper] data-panel edit-list failed:', err);
      btn.innerHTML = '失败';
      setTimeout(() => {
        btn.innerHTML = original;
        btn.disabled = false;
        btn.dataset.busy = '0';
      }, 2000);
    }
  }

  function removeDataPanel(card) {
    if (card._ohPanel) {
      card._ohPanel.remove();
      card._ohPanel = null;
    }
    card._ohPanelAttached = false;
  }

  function getCards() {
    const cards = new Set();
    CARD_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((card) => cards.add(card));
    });
    return Array.from(cards);
  }

  function applyToAll() {
    const cards = getCards();
    if (panelState.enabled) {
      cards.forEach((card) => ensureDataPanel(card));
    } else {
      cards.forEach((card) => removeDataPanel(card));
    }
  }

  // ─── 数据面板开关：从 chrome.storage.local 读 + 监听 onChanged ───
  // 旧版本是右下角浮动 toggle 按钮（.ozon-helper-panel-toggle）。
  // 现在统一移到极掌 popup 「工具与分析」分区里 toggle，状态持久化到
  // chrome.storage.local.ozon_data_panel_enabled。
  // 这里只订阅 storage 变化，自动 apply/remove 面板。
  const STORAGE_KEY = 'ozon_data_panel_enabled';

  async function loadPanelEnabled() {
    try {
      const r = await chrome.storage.local.get(STORAGE_KEY);
      // 默认 true（首次安装时未设置 = 开启）
      panelState.enabled = r[STORAGE_KEY] !== false;
    } catch {
      panelState.enabled = true;
    }
  }

  function listenStorageToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!changes[STORAGE_KEY]) return;
        panelState.enabled = changes[STORAGE_KEY].newValue !== false;
        applyToAll();
      });
    } catch {}
  }

  function createObserver() {
    let pending = false;
    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        applyToAll();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── QX采集器面板（非 search 页）────────────────
  // search/category 由 ozon-search.js 处理；本节负责首页 / 品牌 / 卖家 /
  // 商品详情"也看了" 等所有其他 ozon 页面。
  // QX采集器面板由 qx-collector/panel.js 提供,通过 SW autoCollect* action 管理状态。
  const COLLECTOR_KEY = 'ozon_collector_enabled';
  let collectorEnabled = true;
  let _collectorPanel = null;
  let _autoScroller = null;

  async function loadCollectorEnabled() {
    try {
      const r = await chrome.storage.local.get(COLLECTOR_KEY);
      collectorEnabled = r[COLLECTOR_KEY] !== false;
    } catch {
      collectorEnabled = true;
    }
  }

  function unmountCollectorHere() {
    if (_collectorPanel) {
      try {
        _collectorPanel.destroy();
      } catch {}
      _collectorPanel = null;
    }
    if (_autoScroller) {
      try {
        _autoScroller.stop && _autoScroller.stop();
      } catch {}
      _autoScroller = null;
    }
  }

  function listenCollectorToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[COLLECTOR_KEY]) return;
        collectorEnabled = changes[COLLECTOR_KEY].newValue !== false;
        if (collectorEnabled) mountCollectorHere();
        else unmountCollectorHere();
      });
    } catch {}
  }

  function mountCollectorHere() {
    if (!collectorEnabled) return;
    if (_collectorPanel || !window.QXCollectorPanel) return;

    function isDataPanelSettled(panel) {
      if (!panel) return false;
      const status = panel.dataset.jzLoadStatus || '';
      if (status === 'ready' || status === 'error') return true;
      if (panel.querySelector('.ozon-helper-panel-error')) return true;
      if (panel.querySelector('.is-skeleton, .is-skeleton-section, .oh-skeleton-row')) return false;
      return status === 'ready';
    }

    function isCurrentViewportDataReady() {
      if (!panelState.enabled) return true;
      // 注意: 必须用 panel 的 rect 而非 card 的 rect 判定视口范围, 且 margin 对齐
      // ensureDataPanel 里 IntersectionObserver 的 rootMargin('200px').
      // 否则当 card 很高时, card 顶部进入 +80px 范围但 panel(在 card 底部)还在
      // IO 触发范围之外 → isCurrentViewportDataReady 永远等 panel ready, 而 IO
      // 永远不触发加载 → 死锁, AutoScroller 卡在 "采集中".
      const cards = getCards().filter((card) => {
        if (!card.querySelector('a[href*="/product/"]')) return false;
        const panel = card.querySelector('.ozon-helper-data-panel');
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        return rect.bottom > -200 && rect.top < window.innerHeight + 200;
      });
      if (!cards.length) return true;
      return cards.every((card) => isDataPanelSettled(card.querySelector('.ozon-helper-data-panel')));
    }

    // QXAutoScroller：仅店铺页启用(panel.js isShopPage 判断控制 UI 显示)
    if (window.QXAutoScroller && !_autoScroller) {
      try {
        _autoScroller = new window.QXAutoScroller({
          queue: taskQueue,
          intervalMs: 500,
          settleMs: 1000,
          scrollStepRatio: 0.95,
          minScrollStepPx: 680,
          emptyThreshold: 5,
          readinessPollMs: 300,
          isReadyToScroll: () => isCurrentViewportDataReady(),
          getCardCount: () => getCards().length,
          onCongestionPause: (which) => {
            if (!_collectorPanel) return;
            _collectorPanel.toast(which === 'paused' ? '队列拥塞，自动暂停翻页' : '队列恢复，继续翻页', 'info', 1800);
          },
          onEmpty: () => {
            if (!_collectorPanel) return;
            _collectorPanel.toast('当前页已抓取完成', 'success', 1800);
          },
        });
      } catch {}
    }

    // QXCollectorPanel.create 内部已调 mount(),无需单独调用
    _collectorPanel = window.QXCollectorPanel.create({
      callbacks: {
        onToggleRunning: (next) => {
          // 主开关：控制 panelState（数据面板自动加载）+ autoCollectRunning(SW 侧)
          panelState.enabled = next;
          if (next) {
            taskQueue.resume();
            applyToAll();
            // 恢复采集: 若"自动翻页"开关仍勾选(用户偏好), 重新启动 AutoScroller
            if (_autoScroller) {
              const cb = document.querySelector('[data-el="auto-scroll-toggle"]');
              if (cb && cb.checked) _autoScroller.start();
            }
          } else {
            taskQueue.pause();
            if (_autoScroller) _autoScroller.stop();
          }
        },
        onAutoScrollToggle: (next) => {
          if (!_autoScroller) return;
          if (next) _autoScroller.start();
          else _autoScroller.stop();
        },
        onSalesFilterChange: (next) => {
          onlyWithSales = !!next;
        },
        onForceRefresh: () => {
          // 强制刷新:重置去重集合 + 重新扫描已见 SKU(带 forceRefresh)
          window.__jzAutoCollectResetSeen?.();
          try {
            const cards = getCards();
            for (const card of cards) {
              const info = extractCardInfo(card);
              const productId = extractProductId(info.url);
              if (!productId) continue;
              const cached = panelDataCache.get(productId);
              const panel = card._ohPanel || card.querySelector('.ozon-helper-data-panel');
              window.__jzCollectAutoIfMatched?.(productId, card, info, cached, panel, 'shop-page', sellerSlug, {
                forceRefresh: true,
              });
            }
          } catch (err) {
            console.warn('[ozon-data-panel] force refresh rescan failed:', err);
          }
        },
      },
    });
    // 暴露 jzCollectorToast 兼容 shared-utils.js 中可能的 toast 调用
    window.jzCollectorToast = (msg, type, duration) => _collectorPanel?.toast?.(msg, type, duration);
    _collectorPanel.setRunning(panelState.enabled);
    onlyWithSales = _collectorPanel.getInitialSalesFilter();

    // 重放早到的店铺信息(若 MAIN world 写 data-jz-seller-info 时面板还没挂好)
    if (_pendingStoreUpdate) {
      console.log('[ozon-data-panel] replaying pending store update:', _pendingStoreUpdate);
      try {
        _collectorPanel.updateStoreDetection(_pendingStoreUpdate);
      } catch (_) {
        /* ignore */
      }
    }
  }

  // ─── 监听 MAIN world 的 seller-info-main.js 发来的店铺信息 ────────
  // 店铺页 seller-info-main.js 从 __NUXT__ / data-state 提取 slug/name/sellerId +
  // companyInfo(含 country),通过 CustomEvent 推过来。这里:
  //   1) 缓存 sellerSlug 供 loadPanelData → collectAutoIfMatched 用
  //   2) 调 SW checkStoreClassification 做中国店铺判定,并更新 QX面板店铺检测区块
  //      (window.__qxCollectorPanel 由 Task 21 创建,未渲染时跳过)
  //
  // MV3 跨 world 通信:seller-info-main.js 在 MAIN world 执行,dispatchEvent 不会跨到
  // ISOLATED world。MAIN world 同时写 documentElement data-jz-seller-info 属性(DOM 属性
  // 跨 world 共享),这里用 MutationObserver 监听属性变化读取数据。
  // 保留 addEventListener('jz-seller-info') 兼容同 world 调用(如 popup 或其他 ISOLATED 脚本)。
  //
  // 重试机制:MAIN world 写属性时机可能早于 QX 面板挂载(init 异步 await checkAuth)。
  // 若 __qxCollectorPanel 未就绪,缓存最后一次 SW 查询结果,_pendingStoreUpdate 队列
  // 在 mountCollectorHere 完成后由 replayPendingStoreUpdate 重放。
  let _pendingStoreUpdate = null;

  async function handleSellerInfo(detail) {
    // 调试:把执行状态写到 DOM,方便从 MAIN world 检查
    document.documentElement.setAttribute('data-jz-seller-info-debug', JSON.stringify({ step: 'handleSellerInfo-called', detail: detail ? { pageType: detail.pageType, slug: detail.slug } : null }));
    console.log('[ozon-data-panel] ===== 收到店铺信息 =====');
    console.log('[ozon-data-panel] 店铺完整信息:', detail);
    if (detail) {
      console.log('[ozon-data-panel]   pageType:', detail.pageType);
      console.log('[ozon-data-panel]   slug:', detail.slug);
      console.log('[ozon-data-panel]   name:', detail.name);
      console.log('[ozon-data-panel]   sellerId:', detail.sellerId);
      console.log('[ozon-data-panel]   method:', detail.method);
      console.log('[ozon-data-panel]   companyInfo:', detail.companyInfo);
      if (detail.companyInfo) {
        console.log('[ozon-data-panel]     companyName:', detail.companyInfo.companyName);
        console.log('[ozon-data-panel]     legalAddress:', detail.companyInfo.legalAddress);
        console.log('[ozon-data-panel]     country:', detail.companyInfo.country);
      }
    }
    console.log('[ozon-data-panel] =======================');
    if (!detail || detail.pageType !== 'shop') {
      console.log('[ozon-data-panel] 非 shop 页面,跳过 checkStoreClassification');
      return;
    }
    const { slug, name, companyInfo } = detail;
    if (!slug) {
      console.log('[ozon-data-panel] slug 为空,跳过');
      return;
    }
    sellerSlug = slug; // 缓存,供 loadPanelData → collectAutoIfMatched 用
    try {
      document.documentElement.setAttribute('data-jz-seller-info-debug', JSON.stringify({ step: 'calling-SW', slug }));
      console.log('[ozon-data-panel] >>> 调用 SW checkStoreClassification, 参数:', { slug, name, companyInfo });
      const result = await window.sendMessage('checkStoreClassification', { slug, name, companyInfo });
      document.documentElement.setAttribute('data-jz-seller-info-debug', JSON.stringify({ step: 'SW-returned', result: result ? { isChinese: result.isChinese, classifiedBy: result.classifiedBy } : null, hasPanel: !!window.__qxCollectorPanel }));
      console.log('[ozon-data-panel] <<< SW checkStoreClassification 返回:', result, 'hasPanel:', !!window.__qxCollectorPanel);
      // result: { isChinese, classifiedBy } | null
      // SW 返回 null 表示已查询但未分类(规则引擎无匹配 + ERP 无记录),
      // 此时 isChinese 应为 null(待确认),不能是 undefined(会被 store-detector 当作"未检测")
      const update = {
        slug,
        name,
        isChinese: result ? result.isChinese : null,
        classifiedBy: result ? result.classifiedBy : null,
      };
      console.log('[ozon-data-panel] 准备 updateStoreDetection:', update);
      _pendingStoreUpdate = update; // 缓存,供 mountCollectorHere 重放
      if (window.__qxCollectorPanel) {
        window.__qxCollectorPanel.updateStoreDetection(update);
        document.documentElement.setAttribute('data-jz-seller-info-debug', JSON.stringify({ step: 'updateStoreDetection-called', update }));
        console.log('[ozon-data-panel] updateStoreDetection 已调用,面板已更新');
      } else {
        document.documentElement.setAttribute('data-jz-seller-info-debug', JSON.stringify({ step: 'panel-not-ready', update }));
        console.log('[ozon-data-panel] 面板未挂载,update 已缓存,等 mountCollectorHere 时重放');
      }
    } catch (err) {
      document.documentElement.setAttribute('data-jz-seller-info-debug', JSON.stringify({ step: 'SW-error', error: err?.message || String(err) }));
      console.warn('[ozon-data-panel] checkStoreClassification 失败:', err);
    }
  }

  window.addEventListener('jz-seller-info', (e) => {
    handleSellerInfo(e.detail);
  });

  // MV3 跨 world 通信监听(主路径):window message 事件
  // MAIN world seller-info-main.js 调 window.postMessage({ type:'jz-seller-info', detail }, origin)
  // postMessage 跨 world 可靠(MAIN/ISOLATED 都能监听 window message)
  window.addEventListener('message', (e) => {
    // 调试:看所有 message 来源
    if (e.data && typeof e.data === 'object' && e.data.type && String(e.data.type).includes('jz')) {
      console.log('[ozon-data-panel] message received, type:', e.data.type, 'origin:', e.origin, 'data:', e.data);
    }
    if (e.origin !== location.origin) return;
    const data = e.data;
    if (!data || data.type !== 'jz-seller-info') return;
    console.log('[ozon-data-panel] postMessage received:', data.detail);
    handleSellerInfo(data.detail);
  });
  console.log('[ozon-data-panel] message listener registered, origin:', location.origin);

  // MV3 跨 world 通信监听(辅助):documentElement data-jz-seller-info 属性
  // 经实测 MutationObserver 不跨 world,但保留作同 world 兼容
  const _sellerInfoObserver = new MutationObserver((mutations) => {
    console.log('[ozon-data-panel] MutationObserver fired:', mutations.length, 'records');
    for (const m of mutations) {
      if (m.attributeName !== 'data-jz-seller-info') continue;
      const raw = document.documentElement.getAttribute('data-jz-seller-info');
      console.log('[ozon-data-panel] attr changed, raw:', raw ? raw.slice(0, 100) + '...' : 'null');
      if (!raw) continue;
      try {
        const { detail } = JSON.parse(raw);
        handleSellerInfo(detail);
      } catch (_) {
        /* ignore */
      }
    }
  });
  _sellerInfoObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-jz-seller-info'] });
  console.log('[ozon-data-panel] MutationObserver registered on documentElement');

  // 启动时读取一次 + 轮询重试(MV3 跨 world 通信实测:MutationObserver/postMessage
  // 都不跨 world,只能 ISOLATED world 主动轮询读 DOM 属性)
  // MAIN world seller-info-main.js 等 __NUXT__.sellerId 最多 15s,这里轮询 30s 兜底
  let _lastSeq = 0;
  let _pollCount = 0;
  const _sellerInfoPollMax = 30; // 30 次 × 1s = 30s
  function _pollSellerInfo() {
    _pollCount++;
    try {
      const raw = document.documentElement.getAttribute('data-jz-seller-info');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.seq !== _lastSeq) {
          console.log('[ozon-data-panel] poll detected seq change:', _lastSeq, '->', parsed.seq, '(attempt ' + _pollCount + ')');
          _lastSeq = parsed.seq;
          handleSellerInfo(parsed.detail);
          return; // 读到就停止轮询
        }
      }
    } catch (_) {
      /* ignore */
    }
    if (_pollCount < _sellerInfoPollMax) {
      setTimeout(_pollSellerInfo, 1000);
    } else {
      console.warn('[ozon-data-panel] seller info poll timeout after', _pollCount, 'attempts');
    }
  }
  _pollSellerInfo();
  console.log('[ozon-data-panel] seller info polling started (max', _sellerInfoPollMax, 'attempts)');

  // 监听人工标记后的通知(用户在 QX面板手动标记某店铺为中国/非中国)。
  // 标记为中国后:重置去重集合 + 重新扫描页面已挂面板的 SKU,触发 autoCollect。
  window.addEventListener('jz-store-classified', (e) => {
    const { slug, isChinese } = e.detail || {};
    if (isChinese !== true) return;
    if (slug) sellerSlug = slug;
    // 重置去重集合,让已见 SKU 重新触发 autoCollect
    window.__jzAutoCollectResetSeen?.();
    // 重新扫描页面已挂面板的 card,用 panelDataCache 缓存数据调 collectAutoIfMatched
    // (避免重新 fetch;cache 未命中的 card 留待 IntersectionObserver 后续触发)
    try {
      const cards = getCards();
      for (const card of cards) {
        const info = extractCardInfo(card);
        const productId = extractProductId(info.url);
        if (!productId) continue;
        const cached = panelDataCache.get(productId);
        if (!cached) continue;
        const panel = card._ohPanel || card.querySelector('.ozon-helper-data-panel');
        window.__jzCollectAutoIfMatched?.(productId, card, info, cached, panel, 'shop-page', sellerSlug);
      }
    } catch (err) {
      console.warn('[ozon-data-panel] jz-store-classified rescan failed:', err);
    }
  });

  // ─── 启动 ─────────────────────────────────────────
  async function init() {
    // 搜索/类目/search-by-image 页由 ozon-search.js 管数据面板（它跟选品模式、
    // 采集器、关键词导航深度耦合）。本脚本仅负责"其他页面"——首页、品牌页、
    // 卖家店铺、收藏夹、商品详情页"也看了"等，避免跟 ozon-search 重复挂面板。
    if (window.OzonHelperSearchInjected) return;

    if (SKIP_PATHS.some((p) => new RegExp(`^${p.replace(/\*/g, '.*')}$`).test(window.location.pathname))) {
      return;
    }

    // 鉴权检查：未登录就不加载（避免无 token 调极掌后端打 401 产生 spam）
    try {
      const auth = await window.checkAuth?.();
      if (auth && !auth.loggedIn) return;
    } catch {
      // checkAuth 失败也按未登录处理
      return;
    }

    await loadPanelEnabled();
    listenStorageToggle();
    applyToAll();
    createObserver();

    // QX采集器面板：在所有有商品卡的 ozon.ru 页面（首页 / 品牌 / 卖家 /
    // 商品详情"也看了" 等）挂载浮动采集器面板。
    // search/category 页由 ozon-search.js 自行处理（不接入 QX面板），
    // 本脚本不在那些路径执行（被 OzonHelperSearchInjected flag 拦掉，见 init 顶部）。
    await loadCollectorEnabled();
    listenCollectorToggle();
    if (collectorEnabled) mountCollectorHere();
  }

  // shared-utils + collector libs 可能后于本脚本初始化（content_scripts 顺序虽固定，
  // 但 init 内部用到的全局可能受 site script 干扰）；用 idle callback 兜底
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
