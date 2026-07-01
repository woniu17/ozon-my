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
 *   - window.JZCollectorDB（顺手把数据写入 IndexedDB sales store，供采集器复用）
 *   - window.checkAuth（避免未登录时白打请求）
 */
(function () {
  "use strict";

  // 通用商品卡 selector — Ozon 各页面（search / category / 首页 carousel /
  // brand / seller / 收藏夹 / 商品详情页"也看了"）目前都用 .tile-root 作为容器
  const CARD_SELECTORS = [
    ".tile-root",
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
    const img = card.querySelector("img");

    // 名称优先级（避开 Chrome 翻译污染）：
    //   1. <a aria-label>            ← attribute，不被翻译
    //   2. <img alt>                 ← attribute，不被翻译
    //   3. <a> 上嵌入的 [data-state] / span 子元素 textContent —— 翻译态下退化
    //   4. <a> textContent            ← 翻译态下是中文，**仅在非翻译态使用**
    // 翻译态下若都拿不到原始名，name 留空，让后端走 search-variant-model
    // attr 4180 拿原始俄/英文名（更可靠）。
    const ariaLabel = (link?.getAttribute("aria-label") || "").trim();
    const imgAlt = (img?.getAttribute("alt") || "").trim();
    const translated = window.jzIsTranslated?.();
    const textTitle = translated
      ? ""
      : link?.textContent?.trim() || card.textContent?.trim().slice(0, 120) || "";
    const title = ariaLabel || imgAlt || textTitle;

    const priceNode =
      card.querySelector('[data-widget="searchResultsPrice"]') ||
      card.querySelector('[data-widget="webPrice"]');
    const priceText = extractVisiblePriceText(card, priceNode);
    const price = window.normalizePrice
      ? window.normalizePrice(priceText)
      : null;

    return {
      url: link?.href || "",
      name: title,
      price,
      image: img?.getAttribute("src") || img?.getAttribute("data-src") || "",
    };
  }

  async function waitForCollectorFilterData(card, data, info, panel) {
    let nextInfo = info;
    while (true) {
      const missing = window.JZCollectorFilter?.getMissingFields
        ? window.JZCollectorFilter.getMissingFields(data, nextInfo)
        : [];
      if (!missing.length) return nextInfo;
      if (!missing.some((key) => key === "price")) return nextInfo;
      if (!card?.isConnected) return nextInfo;
      const panelStatus = panel?.dataset?.jzLoadStatus || "";
      if (panelStatus === "ready" || panelStatus === "error" || panel?.querySelector?.(".ozon-helper-panel-error")) {
        const refreshedInfo = extractCardInfo(card);
        return {
          ...nextInfo,
          ...refreshedInfo,
          price: Number(refreshedInfo.price) > 0 ? refreshedInfo.price : nextInfo.price,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      const refreshedInfo = extractCardInfo(card);
      nextInfo = {
        ...nextInfo,
        ...refreshedInfo,
        price: Number(refreshedInfo.price) > 0 ? refreshedInfo.price : nextInfo.price,
      };
    }
  }

  // 格式化 + 数据合并 + 渲染逻辑统一放在 shared-utils.js,跟 ozon-search.js 共用。
  // 见 window.jzMergeCardPanelData / window.jzRenderProductCardPanel /
  //   window.jzRenderPanelSkeleton。


  // 渲染逻辑统一在 shared-utils.js 的 window.jzRenderProductCardPanel。

  // ─── 入桶（沿用原逻辑：仅在搜索/类目页有 keyword 时落 IndexedDB） ─────
  function buildSaleRecord(productId, info, data) {
    const keyword =
      new URLSearchParams(window.location.search).get("text") || "";
    return {
      sku: String(productId),
      url: info.url || "",
      name: info.name || "",
      price: info.price != null ? String(info.price) : null,
      image: info.image || "",
      soldCount: data?.soldCount ?? null,
      gmvSum: data?.gmvSum != null ? String(data.gmvSum) : null,
      views: data?.views ?? null,
      convViewToOrder:
        data?.convViewToOrder != null ? String(data.convViewToOrder) : null,
      discount: data?.discount != null ? String(data.discount) : null,
      keyword,
      collectedAt: Date.now(),
      status: "local",
      raw: data || null,
    };
  }

  // 全站任意 ozon.ru 页面都自动入桶（首页推荐 / 商品详情"也看了" / 品牌页等）。
  // 用户后续可在采集器里看到合并后的桶数据。
  // 注：keyword 字段在非 search 页面会是 ''（无关键词上下文），仍然按 sku 落库。
  async function collectSaleIfMatched(productId, card, info, data, panel) {
    if (!shouldPersistToBucket()) return false;
    const sourceData = window.jzExtractPanelFilterData
      ? window.jzExtractPanelFilterData(panel, info, data || {})
      : (data || {});
    const readyInfo = await waitForCollectorFilterData(card, sourceData, info, panel);
    if (readyInfo && passCollectorFilters(sourceData, readyInfo)) {
      try {
        await window.JZCollectorDB?.putSale(buildSaleRecord(productId, readyInfo, sourceData));
        return true;
      } catch {}
    }
    return false;
  }

  function passCollectorFilters(data, info) {
    if (onlyWithSales) {
      const sold = Number(data?.soldCount);
      if (!Number.isFinite(sold) || sold <= 0) return false;
    }
    return window.JZCollectorFilter?.matches ? window.JZCollectorFilter.matches(data, info) : true;
  }

  function shouldPersistToBucket() {
    return true;
  }

  // ─── 加载数据 + 渲染 ─────────────────────────────────
  async function loadPanelData(card, panel) {
    if (panel) panel.dataset.jzLoadStatus = "loading";
    const info = extractCardInfo(card);
    const productId = extractProductId(info.url);
    if (!productId) {
      if (panel) panel.dataset.jzLoadStatus = "error";
      panel.innerHTML = "";
      return;
    }

    if (panelDataCache.has(productId)) {
      const cached = panelDataCache.get(productId);
      // V2 优先(对齐详情页 5-section 布局),用 cached.preFetched 复用之前已 fetch 的结果
      if (typeof window.jzRenderProductPanelV2 === 'function' && cached?.preFetched) {
        window.jzRenderProductPanelV2(panel, { sku: productId, initial: cached });
        try { await window.jzPopulatePanelV2(panel, productId, { preFetched: cached.preFetched }); } catch {}
      } else {
        window.jzRenderProductCardPanel(panel, cached);
      }
      if (panel) panel.dataset.jzLoadStatus = "ready";
      await collectSaleIfMatched(productId, card, info, cached, panel);
      return;
    }

    const showError = () => {
      if (panel) panel.dataset.jzLoadStatus = "error";
      panel.innerHTML =
        '<div class="ozon-helper-panel-error" style="cursor:pointer;color:var(--oh-red,#ff4d4f);font-size:12px;padding:8px 12px;">数据加载失败，点击重试</div>';
      panel
        .querySelector(".ozon-helper-panel-error")
        ?.addEventListener(
          "click",
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
          window.sendMessage("getMarketStats", { sku: productId }),
          window.sendMessage("getProductStats", { url: info.url }),
          window.sendMessage("searchVariants", { sku: productId }),
          window.jzFetchPublicFollowSell(productId),
        ]);
      const [marketResult, productResult, variantResult, followSellResult] =
        await taskQueue.add(`stats-${productId}`, fetchTask);

      if (
        marketResult.status === "rejected" &&
        productResult.status === "rejected"
      ) {
        showError();
        return;
      }

      // sv 失败/auth issue 兜底:从 chrome.storage.local 读详情页采集的 cache
      const cachedWeightDims = (variantResult.status !== "fulfilled" || !variantResult.value?.items?.[0])
        ? await (window.jzReadCachedWeightDims?.(productId).catch(() => null) ?? null)
        : null;

      const data = window.jzMergeCardPanelData(
        marketResult.status === "fulfilled" ? marketResult.value : null,
        productResult.status === "fulfilled" ? productResult.value : null,
        variantResult.status === "fulfilled" ? variantResult.value : null,
        followSellResult.status === "fulfilled" && followSellResult.value
          ? {
              followSellCount: followSellResult.value.count,
              sellers: followSellResult.value.sellers,
            }
          : null,
        productId,
        cachedWeightDims,
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
        try { await window.jzPopulatePanelV2(panel, productId, { preFetched: data.preFetched }); } catch {}
      } else {
        window.jzRenderProductCardPanel(panel, data);
      }

      if (panel) panel.dataset.jzLoadStatus = "ready";
      await collectSaleIfMatched(productId, card, info, data, panel);
    } catch {
      showError();
    }
  }

  function ensureDataPanel(card) {
    if (card._ohPanelAttached) return;
    // 跳过没商品链接的 tile（推广位 / 占位 / 类目 chip 之类）
    if (!card.querySelector('a[href*="/product/"]')) return;
    card._ohPanelAttached = true;

    const panel = document.createElement("div");
    panel.className = "ozon-helper-data-panel";
    panel.setAttribute("lang", "zh-Hans");
    window.jzRenderPanelSkeleton(panel);
    panel.dataset.jzLoadStatus = "pending";
    card.appendChild(panel);
    card._ohPanel = panel;

    // 阻止整个 panel 的 click 冒泡到 Ozon tile（避免误触发跳转）
    panel.addEventListener("click", (e) => {
      const actionTarget = e.target.closest("[data-click-action], [data-action]");
      if (!actionTarget) return;
      e.preventDefault();
      e.stopPropagation();
      const action =
        actionTarget.getAttribute("data-click-action") ||
        actionTarget.getAttribute("data-action");
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
      { rootMargin: "200px" }
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
    if (action === "toggle-section") {
      window.JZSidebarSectionToggle?.toggleSidebarSection(btn);
      return;
    }

    // 字段设置齿轮:不依赖 info.url(放在 url 守卫之前),对全站数据卡生效。
    if (action === "open-field-settings") {
      window.jzOpenFieldSettings?.(panel);
      return;
    }

    const info = extractCardInfo(card);
    if (!info.url) return;

    if (action === "show-followsell-modal" || action === "view-sellers") {
      // Hero follow-sell stat: show our seller modal; keep Ozon URL fallback.
      const product = getPanelFollowSellProduct(card, panel);
      if (product && window.jzShowFollowSellListModal) {
        window.jzShowFollowSellListModal(btn, product, { trigger: "click" });
      } else {
        const sep = info.url.includes("?") ? "&" : "?";
        window.open(`${info.url}${sep}prefer_sellers=true`, "_blank");
      }
      return;
    }

    if (action === "open-followsell" || action === "follow-sell") {
      // 底部「一键跟卖」按钮:新 tab + URL hash 唤起主扩展上架面板(批采/AI 改图)
      window.open(info.url + "#jz-follow-sell", "_blank");
      return;
    }

    if (action === "edit-list") {
      handleEditList(card, panel, btn);
      return;
    }

    if (action === "collect-one") {
      handleCollectOne(card, panel, btn, info);
      return;
    }
  }

  // 「采集」按钮:与 action bar 上的「一键采集」语义统一,写 backend 采集箱
  // (pushSourceCollect)。同时保留本地 IndexedDB 写入,供「极掌采集器」关键词
  // 巡航的桶视图复用 sale record。绕过 collectorRunning gate(用户主动点 = 显式同意)。
  //
  // resp shape (SW ENVELOPE_FIX 2025-05):{ dedupeHit, lastAt, result }
  //   - dedupeHit:24h 内已采过同 SKU,SW 走 cache 没打 backend
  //   - result.id:backend OzonCollectBoxItem.id(可用于跳编辑页)
  // sendMessage 在 SW ok:false 时直接 reject(走外层 catch),不必检查 resp.ok。
  async function handleCollectOne(card, panel, btn, info) {
    if (btn.dataset.busy === "1") return;
    const productId = extractProductId(info.url);
    if (!productId) {
      _flashBtn(btn, "无效 SKU", "is-failed", 1500);
      return;
    }
    btn.dataset.busy = "1";
    try {
      const data = panelDataCache.get(productId) || null;

      // 1. searchVariants 补 sv 数据(品牌/类目/属性等富字段),失败兜底空
      const variantResp = await window
        .sendMessage("searchVariants", { sku: productId })
        .catch(() => null);
      const variantItems =
        variantResp?.items || variantResp?.data?.items || [];
      const variantMatch =
        variantItems.find((it) => String(it.variant_id) === productId) ||
        variantItems[0] ||
        null;

      // 2. 写 backend 采集箱(主路径) + 写本地 IndexedDB(兼容采集器桶)
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
        convViewToOrder:
          data?.convViewToOrder != null ? String(data.convViewToOrder) : undefined,
        discount: data?.discount != null ? String(data.discount) : undefined,
        gmvSum: data?.gmvSum != null ? String(data.gmvSum) : undefined,
      };
      const resp = await window.sendMessage("pushSourceCollect", {
        sourceId: "ozon",
        raw: collectPayload,
      });

      // 本地桶 (失败静默,backend 写成功就算采集成功;桶仅服务关键词巡航 UI)
      try {
        const record = data
          ? buildSaleRecord(productId, info, data)
          : {
              sku: String(productId),
              url: info.url || "",
              name: info.name || "",
              price: info.price != null ? String(info.price) : null,
              image: info.image || "",
              keyword: "",
              collectedAt: Date.now(),
            };
        await window.JZCollectorDB?.putSale(record);
      } catch (e) {
        console.warn(
          "[ozon-helper] data-panel collect-one local-bucket write failed:",
          e
        );
      }

      const label = resp?.dedupeHit ? "近期已采集" : "已采集";
      _flashBtn(btn, label, "is-collected", 1800);
    } catch (e) {
      console.warn("[ozon-helper] data-panel collect-one failed:", e);
      const msg = e?.message || "";
      const friendly = /NETWORK_ERROR|超时|timeout|网络/i.test(msg)
        ? "网络错误"
        : "失败";
      _flashBtn(btn, friendly, "is-failed", 1800);
    } finally {
      btn.dataset.busy = "";
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
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "采集中…";

    try {
      const info = extractCardInfo(card);
      const sku = extractProductId(info.url);
      if (!sku) throw new Error("missing-sku");

      const variantResp = await window
        .sendMessage("searchVariants", { sku })
        .catch(() => null);
      const variantItems = variantResp?.items || variantResp?.data?.items || [];
      const variantMatch =
        variantItems.find((it) => String(it.variant_id) === sku) ||
        variantItems[0] ||
        null;

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
      const resp = await window.sendMessage("pushSourceCollect", {
        sourceId: "ozon",
        raw: collectPayload,
      });
      const itemId = resp?.result?.id;
      const auth = await window.sendMessage("getAuth");
      // 从 brand webHost 直接构造,不要从 backendUrl 反推 — 旧 `.replace('/api','')`
      // 会把 `https://api.jizhangerp.com` 中 `://api` 后 4 字符 `/api` 误删,
      // 得到 `https:/.jizhangerp.com` 残缺 URL,浏览器按相对路径解析 →
      // 拼到 ozon.ru 下变成 `https://www.ozon.ru/.jizhangerp.com/...`。
      const frontendUrl = auth?.backendUrl?.includes("localhost")
        ? "http://localhost:3000"
        : `https://${globalThis.__JZ_BRAND__.webHost}`;
      if (itemId) {
        window.open(
          `${frontendUrl}/ozon/products/collect/edit?id=${itemId}`,
          "_blank"
        );
      } else {
        window.open(`${frontendUrl}/ozon/products/collect`, "_blank");
      }
      btn.innerHTML = original;
      btn.disabled = false;
      btn.dataset.busy = "0";
    } catch (err) {
      console.warn("[ozon-helper] data-panel edit-list failed:", err);
      btn.innerHTML = "失败";
      setTimeout(() => {
        btn.innerHTML = original;
        btn.disabled = false;
        btn.dataset.busy = "0";
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
  const STORAGE_KEY = "ozon_data_panel_enabled";

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
        if (area !== "local") return;
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

  // ─── 极掌采集器（非 search 页同款功能）────────────────
  // search/category 由 ozon-search.js 处理；本节负责首页 / 品牌 / 卖家 /
  // 商品详情"也看了" 等所有其他 ozon 页面。
  // 默认开，状态由 popup 里的 toggle 控制（chrome.storage.local.ozon_collector_enabled）。
  const COLLECTOR_KEY = "ozon_collector_enabled";
  let collectorEnabled = true;
  let _collectorPanel = null;
  let _autoScroller = null;
  let _antiBan = null;

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
      try { _collectorPanel.unmount(); } catch {}
      _collectorPanel = null;
    }
    if (_autoScroller) {
      try { _autoScroller.stop && _autoScroller.stop(); } catch {}
      _autoScroller = null;
    }
    if (_antiBan) {
      try { _antiBan.stop && _antiBan.stop(); } catch {}
      _antiBan = null;
    }
  }

  function listenCollectorToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[COLLECTOR_KEY]) return;
        collectorEnabled = changes[COLLECTOR_KEY].newValue !== false;
        if (collectorEnabled) mountCollectorHere();
        else unmountCollectorHere();
      });
    } catch {}
  }

  function mountCollectorHere() {
    if (!collectorEnabled) return;
    if (_collectorPanel || !window.JZCollectorPanel) return;

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
      const cards = getCards().filter((card) => {
        if (!card.querySelector('a[href*="/product/"]')) return false;
        const rect = card.getBoundingClientRect();
        return rect.bottom > -80 && rect.top < window.innerHeight + 80;
      });
      if (!cards.length) return true;
      return cards.every((card) => isDataPanelSettled(card.querySelector('.ozon-helper-data-panel')));
    }

    // autoScroller：在首页 / 品牌 / 卖家 等 lazy-load 列表里也有用
    if (window.JZAutoScroller && !_autoScroller) {
      try {
        _autoScroller = new window.JZAutoScroller({
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
            _collectorPanel.setAutoScrollerState({
              running: _autoScroller.isUserActive(),
              autoPaused: _autoScroller.isAutoPaused(),
            });
            _collectorPanel.toast(
              which === "paused" ? "队列拥塞，自动暂停翻页" : "队列恢复，继续翻页",
              "info",
              1800,
            );
          },
          onEmpty: () => {
            if (!_collectorPanel) return;
            _collectorPanel.setAutoScrollerState({ running: false, autoPaused: false });
            _collectorPanel.toast("当前页已抓取完成", "success", 1800);
          },
        });
      } catch {}
    }

    // antiBan：监控失败率
    if (window.JZAntiBanGuard && !_antiBan) {
      try {
        _antiBan = new window.JZAntiBanGuard({
          queue: taskQueue,
          windowSize: 20,
          failureRateThreshold: 0.5,
          cooldownMs: 60000,
          onTrigger: (msg) => {
            _collectorPanel?.toast(msg, "error", 5000);
          },
        });
        _antiBan.start();
      } catch {}
    }

    _collectorPanel = window.JZCollectorPanel.create({
      queue: taskQueue,
      db: window.JZCollectorDB,
      onPushClick: async () => {
        // 把本地桶 status='local' 全部推送到极掌后端候选池
        try {
          if (!window.JZCollectorDB) return;
          const all = await window.JZCollectorDB.getAllSales({ status: "local" });
          if (!all.length) {
            _collectorPanel?.toast("本地桶无待推送", "info", 1500);
            return;
          }
          const items = all.map((rec) => ({
            sku: rec.sku,
            url: rec.url || undefined,
            name: rec.name || undefined,
            price: rec.price != null ? String(rec.price) : undefined,
            image: rec.image || undefined,
          }));
          const resp = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { action: "pushToCollectBox", items, mode: "update" },
              resolve,
            );
          });
          if (resp?.ok) {
            const r = resp.data;
            _collectorPanel?.toast(
              `创建 ${r.created || 0} / 更新 ${r.updated || 0}`,
              "success",
              2500,
            );
            try {
              await window.JZCollectorDB.markPushed(items.map((x) => x.sku));
            } catch {}
          } else {
            _collectorPanel?.toast(
              (resp?.error || "推送失败").slice(0, 30),
              "error",
              2500,
            );
          }
        } catch (e) {
          _collectorPanel?.toast(e.message || "推送失败", "error", 2500);
        }
      },
      onClearClick: () => window.JZCollectorDB?.clearSales(),
      onToggleRunning: (next) => {
        // 主开关：控制 panelState（数据面板自动加载）
        panelState.enabled = next;
        if (next) {
          taskQueue.resume();
          applyToAll();
        } else {
          taskQueue.pause();
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
      // keyword pilot 在非 search 页面没意义（无 ?text= 参数语义），
      // 不传 onKeywordsStart 让 panel 自然降级（按钮无响应）
    });
    _collectorPanel.mount();
    _collectorPanel.setRunning(panelState.enabled);
    onlyWithSales = _collectorPanel.getInitialSalesFilter();
  }

  // ─── 启动 ─────────────────────────────────────────
  async function init() {
    // 搜索/类目/search-by-image 页由 ozon-search.js 管数据面板（它跟选品模式、
    // 采集器、关键词导航深度耦合）。本脚本仅负责"其他页面"——首页、品牌页、
    // 卖家店铺、收藏夹、商品详情页"也看了"等，避免跟 ozon-search 重复挂面板。
    if (window.OzonHelperSearchInjected) return;

    if (
      SKIP_PATHS.some((p) =>
        new RegExp(`^${p.replace(/\*/g, ".*")}$`).test(window.location.pathname)
      )
    ) {
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

    try {
      await window.JZCollectorDB?.init();
    } catch {}

    await loadPanelEnabled();
    listenStorageToggle();
    applyToAll();
    createObserver();

    // 极掌采集器：在所有有商品卡的 ozon.ru 页面（首页 / 品牌 / 卖家 /
    // 商品详情"也看了" 等）也挂载浮动采集器面板，受 popup 里的 toggle 控制。
    // search/category 页由 ozon-search.js 自行处理（它跟 keyword pilot 深度耦合），
    // 本脚本不在那些路径执行（被 OzonHelperSearchInjected flag 拦掉，见 init 顶部）。
    await loadCollectorEnabled();
    listenCollectorToggle();
    if (collectorEnabled) mountCollectorHere();
  }

  // shared-utils + collector libs 可能后于本脚本初始化（content_scripts 顺序虽固定，
  // 但 init 内部用到的全局可能受 site script 干扰）；用 idle callback 兜底
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
