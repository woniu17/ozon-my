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

  // 加载守卫:扩展重载后 chrome.scripting.executeScript 重新注入时,
  // 新 ISOLATED world 没有此标志,脚本正常执行;旧 ISOLATED world 已设标志不会重复执行。
  if (window.__JZ_DATA_PANEL_LOADED__) return;
  window.__JZ_DATA_PANEL_LOADED__ = true;

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
  // 自动采集总开关(对应 popup 上的"自动采集"toggle,storage key 'jz-auto-collect-config')。
  // 关闭后:不提交深度采集任务、不写 card 缓存(避免 highlight/店铺页等持续污染 dom 缓存)。
  // 数据面板显隐与渲染不受此开关影响(仍可查 ERP 缓存展示历史数据)。
  const autoCollectState = { running: true };
  const panelDataCache = new Map();
  let onlyWithRating = false;
  // 价格/评论数范围过滤:[minNum|null, maxNum|null](null 表示不限)
  // 解析:null/空/非数字 → null(不限);否则取 Number
  let priceRange = [null, null];
  let ratingRange = [null, null];
  function _parseRange(minStr, maxStr) {
    const min = minStr !== '' && Number.isFinite(Number(minStr)) ? Number(minStr) : null;
    const max = maxStr !== '' && Number.isFinite(Number(maxStr)) ? Number(maxStr) : null;
    return [min, max];
  }
  // 判定商品卡是否通过范围过滤(price/ratingCount 任一不在范围内则过滤掉)
  // null 字段表示不限。商品卡字段缺失(number 不有限)视为不匹配。
  function _passesRangeFilter(info) {
    if (priceRange[0] != null || priceRange[1] != null) {
      const p = Number(info.price);
      if (!Number.isFinite(p)) return false;
      if (priceRange[0] != null && p < priceRange[0]) return false;
      if (priceRange[1] != null && p > priceRange[1]) return false;
    }
    if (ratingRange[0] != null || ratingRange[1] != null) {
      const r = Number(info.ratingCount);
      if (!Number.isFinite(r)) return false;
      if (ratingRange[0] != null && r < ratingRange[0]) return false;
      if (ratingRange[1] != null && r > ratingRange[1]) return false;
    }
    return true;
  }
  // 从 jz-seller-info 事件缓存的当前页卖家 slug,供 loadPanelData → __jzSubmitCollectTask 用。
  // 店铺页 seller-info-main.js 提取后通过 CustomEvent 推过来;非店铺页保持 ''。
  let sellerSlug = '';
  let sellerName = ''; // 店铺名称,用于在商品卡上显示"店铺商品:xxx"标签
  let sellerId = ''; // 卖家 ID(从 __NUXT__ 获取,稳定主键,slug 可变)

  // ── 采集门控(collectGate):解决 IntersectionObserver 与 sellerSlug 竞态 ──
  // 问题:IO 在 t≈200ms 触发,但 sellerSlug 要等 t≈500ms~15s 才就绪。
  //       若 IO 触发时直接提交 __jzSubmitCollectTask,会用空 slug 入队 + dedup 阻止重提交。
  // 方案:SKU 先入 _pendingSkus 队列,等 collectGate(sellerInfo+分类结果)就绪后批量 flush。
  //       panel 渲染零阻塞(查 ERP、渲染字段立即执行),只有采集提交被 gate 门控。
  // 非店铺页(无 sellerInfo)直接 resolve gate(isNonShopPage=true),立即放行。
  let _collectGate = null;
  let _resolveCollectGate = null;
  let _pendingSkus = [];
  let _storeClassResult = null; // { isChinese, classifiedBy } | null
  let _gateState = 'pending'; // 'pending' | 'ready' | 'timedOut'

  function _initCollectGate() {
    _gateState = 'pending';
    _pendingSkus = [];
    _collectGate = new Promise((resolve) => {
      _resolveCollectGate = resolve;
    });
    // 超时降级:5s 后 sellerInfo 仍未到达,按"未分类"放行(让 SW 判定 unclassified-store)
    // 避免页面卡死,也避免 sellerInfo 异常时永不提交
    setTimeout(() => {
      if (_gateState === 'pending') {
        _gateState = 'timedOut';
        console.warn('[panel] collectGate 超时降级,sellerInfo 未到达');
        _resolveCollectGate({ timedOut: true, sellerSlug: '', sellerId: '', isChinese: null });
        _flushPendingSkus();
      }
    }, 5000);
  }

  // gate 就绪后对单个 SKU 决策:提交 / 静默丢弃
  function _maybeFlushSku(sku, card, ctx) {
    if (ctx.timedOut) {
      // 超时降级:sellerInfo 未到达,按空 slug 提交(让 SW 判定 unclassified-store)
      window.__jzSubmitCollectTask?.(sku, card, '', '').catch(() => {});
      return;
    }
    // onlyChineseStores 开启时,非中国店铺静默丢弃(不入 _autoCollectSeen,允许切换店铺重试)
    if (_storeClassResult && _storeClassResult.isChinese === false) {
      console.log('[panel] 非中国店铺,跳过采集:', sku);
      return;
    }
    // 中国店铺 / 未分类 / onlyChineseStores=false → 提交
    window.__jzSubmitCollectTask?.(sku, card, ctx.sellerSlug, ctx.sellerId).catch(() => {});
  }

  // 批量 flush pending 队列(用于 sellerInfo 到达 / 用户手动标记后)
  function _flushPendingSkus() {
    if (_pendingSkus.length === 0) return;
    const ctx = {
      sellerSlug,
      sellerId,
      isChinese: _storeClassResult?.isChinese,
      timedOut: _gateState === 'timedOut',
    };
    console.log(`[panel] flush ${_pendingSkus.length} 个 pending SKU, gateState=${_gateState}`);
    for (const { sku, card } of _pendingSkus) {
      _maybeFlushSku(sku, card, ctx);
    }
    _pendingSkus = [];
  }

  // 判断商品卡是否属于当前店铺 SKU(而非"推荐/相关商品"区域)。
  // 方案 1(最可靠):向上查找 data-widget 属性。
  //   店铺 SKU:父级 widget = tileGridDesktop / infiniteVirtualPaginator
  //   非店铺 SKU:父级 widget = skuGrid
  // 实测数据(2026-07-14 youqulin 店铺页):
  //   tileGridDesktop: 15 张卡片,target=_blank,href 含 _bctx=
  //   infiniteVirtualPaginator: 8 张卡片(懒加载),target=_blank,href 含 _bctx=
  //   skuGrid: 30 张卡片(推荐区),target=_self,href 不含 _bctx=
  function isStoreSkuCard(card) {
    let el = card;
    while (el && el !== document.body) {
      el = el.parentElement;
      if (!el) break;
      const w = el.getAttribute('data-widget');
      if (w === 'tileGridDesktop' || w === 'infiniteVirtualPaginator') return true;
      if (w === 'skuGrid') return false;
    }
    // 未找到已知 widget 时默认视为店铺 SKU(避免漏标)
    return true;
  }

  // 采集状态相关代码已迁移至 collect/content/collect-status.js,
  // 通过 window.__jzCollectStatus.* 桥接访问:
  //   - setStatus/getStatus(SKU 状态读写)
  //   - refreshUi/refreshAllUi(刷新徽章+状态条)
  //   - applyQueuePaused(应用队列暂停状态)
  //   - addStoreSku/getStoreSkuCount(店铺 SKU 收集)
  //   - renderCollectStatusBar/refreshCollectStatusBar/updateCollectBadge
  //   - STATUS_MAP/CACHE_TYPE_LABELS(常量)

  // ── 定时刷新:页面级 5s 定时器 + 视口批量查询 ──
  // 主动查缓存刷新数据 + 采集状态。不依赖自动采集开关:即使自动采集关闭,
  // 也定时查 SW 缓存填充面板。详见下方 _refreshVisiblePanels 实现。
  const PANEL_REFRESH_INTERVAL_MS = 5000;

  // 接收 SW 推送的 collectDone / taskStatus / antibotDetected 事件,实时更新
  // 状态读写通过 window.__jzCollectStatus.* 桥接(collect/content/collect-status.js)
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    const CS = () => window.__jzCollectStatus;

    // 熔断检测:SW 检测到反爬时广播 antibotDetected
    if (msg.type === 'antibotDetected' && msg.pausedUntil) {
      window.__jzCircuitBreakerUntil = msg.pausedUntil;
      CS()?.refreshAllUi();
      return;
    }

    // 队列暂停:SW 因 daily-limit/not-running/paused 暂停队列时广播。
    // 详见 collect-status.js 的 applyQueuePaused(同时用于启动时主动查询,防时序竞态)。
    if (msg.type === 'queuePaused') {
      CS()?.applyQueuePaused(msg.reason);
      return;
    }

    // 队列恢复:SW 跨日重置或熔断过期后恢复消费时广播。
    // 清除全局标志,让后续新 panel 正常走采集流程。
    if (msg.type === 'queueResumed') {
      console.log('[panel] 队列恢复,清除 __jzQueuePaused 标志');
      window.__jzQueuePaused = false;
      return;
    }

    // rescan:SW 通过 rescan op 触发的不刷新页面重新扫描。
    // 清空 dedup + 清除暂停标志 + 重置所有 panel 为 loading + 重新提交所有可见 SKU。
    if (msg.type === 'rescan') {
      console.log('[panel] 收到 rescan,重新提交所有可见 SKU');
      window.__jzAutoCollectResetSeen?.();
      window.__jzQueuePaused = false;
      try {
        const cards = getCards();
        for (const card of cards) {
          const info = extractCardInfo(card);
          const productId = extractProductId(info.url);
          if (!productId) continue;
          // "仅抓有评价"开启时跳过无评价商品
          if (onlyWithRating && !info.ratingCount) continue;
          // 价格/评论数范围过滤:不在范围内则跳过采集
          if (!_passesRangeFilter(info)) continue;
          const panel = card.querySelector('.ozon-helper-data-panel');
          if (panel) panel.dataset.jzLoadStatus = 'loading';
          window.__jzSubmitCollectTask?.(productId, card, sellerSlug, sellerId);
        }
      } catch (err) {
        console.warn('[panel] rescan failed:', err);
      }
      return;
    }

    // taskStatus:SW 在入队/开始处理/重试时广播,更新 _collectStatusMap
    if (msg.type === 'taskStatus' && msg.sku) {
      const skuStr = String(msg.sku);
      const uiStatus = CS()?.STATUS_MAP?.[msg.status];
      if (uiStatus) {
        CS()?.setStatus(skuStr, {
          status: uiStatus,
          reason: null,
          results: null,
          duration: null,
          timestamp: Date.now(),
        });
        CS()?.refreshUi(skuStr);
        // 状态变化可能影响采集/略过拆分计数(如 pending→skipped),刷新面板计数
        _updateStoreSkuCount();
      }
      return;
    }

    if (msg.type !== 'collectDone' || !msg.sku) return;
    const skuStr = String(msg.sku);

    const uiStatus = CS()?.STATUS_MAP?.[msg.status] || msg.status;

    // steps { card:'ok', detail:'ok', ... } → results [{ type, hit }]
    let results = null;
    if (msg.steps && typeof msg.steps === 'object') {
      const labels = CS()?.CACHE_TYPE_LABELS || [];
      results = labels.map((type) => ({ type, hit: msg.steps[type] === 'ok' }));
    }

    const hitCount = results ? results.filter((r) => r.hit).length + '/' + results.length : '?';
    console.log('[panel] 收到 collectDone:', skuStr, 'status=', uiStatus, 'hit=', hitCount);
    // collectDone 携带实际采集结果(success/partial/failed)说明队列已恢复消费,
    // 清除 __jzQueuePaused 标志,让后续新 panel 正常走采集流程。
    // skipped 状态不清除(可能是 daily-limit/not-running 导致的跳过,队列仍暂停)。
    if (window.__jzQueuePaused && uiStatus !== 'skipped') {
      window.__jzQueuePaused = false;
      console.log('[panel] collectDone 非 skip 状态,清除 __jzQueuePaused 标志');
    }
    CS()?.setStatus(skuStr, {
      status: uiStatus,
      reason: msg.error?.type || msg.reason || null,
      results: results || msg.results || null,
      duration: msg.duration != null ? msg.duration : null,
      timestamp: msg.collectedAt || Date.now(),
    });
    // 采集完成(终态)后刷新采集/略过拆分计数
    _updateStoreSkuCount();

    // 广播携带完整数据时即时回填面板
    // 注意:无论 status 是 success/partial/skipped/failed_final,collectDone 都表示
    // 该 SKU 的处理已结束,panel 应标记为 ready,否则 AutoScroller 的 isReadyToScroll
    // 会永远等待(尤其 skipped 时 data 全 null,panel 停在 'loading' 导致死锁)。
    const panel = document.querySelector(`[data-jz-sku="${skuStr}"] .ozon-helper-data-panel`);
    if (panel) {
      if (msg.data && typeof window.jzPopulatePanelV2 === 'function') {
        try {
          // 必须先调 jzRenderProductPanelV2 创建带 [data-field] 的 HTML 结构,
          // 否则 jzPopulatePanelV2 的 updateField 找不到字段节点,数据无法回填。
          if (typeof window.jzRenderProductPanelV2 === 'function') {
            window.jzRenderProductPanelV2(panel, { sku: skuStr, initial: { preFetched: msg.data } });
          }
          window.jzPopulatePanelV2(panel, skuStr, { preFetched: msg.data });
        } catch (e) {
          console.warn('[panel] collectDone 回填面板失败:', skuStr, e);
        }
      }
      panel.dataset.jzLoadStatus = 'ready';
    }

    CS()?.refreshUi(skuStr);
  });

  // ── 定时刷新:页面级 5s 定时器 + 视口批量查询 ──────────────────
  // 旧实现:每个 panel 独立 setInterval,N 个 panel = 2N 条消息/5s(SW 消息洪水)。
  // 新实现:1 个页面级定时器,批量查视口内所有 panel 的 ERP 数据 + 缓存状态,
  //       2 条消息搞定所有 panel(消息数固定,与 panel 数量无关)。
  // 批量 action:queryErpProductDataBatch / queryCacheStatusBatch(SW inflight 去重)。
  const _pageRefreshSkus = new Map(); // sku → { card, panel }
  let _pageRefreshTimer = null;
  let _pageRefreshInflight = false; // 防止上一轮未完成就启动下一轮

  function _startPageRefresh() {
    if (_pageRefreshTimer) return;
    _pageRefreshTimer = setInterval(_refreshVisiblePanels, PANEL_REFRESH_INTERVAL_MS);
  }

  function _stopPageRefresh() {
    if (_pageRefreshTimer) {
      clearInterval(_pageRefreshTimer);
      _pageRefreshTimer = null;
    }
    _pageRefreshSkus.clear();
  }

  // 注册 panel 到页面级刷新(替代旧 _startPanelRefresh)
  function _registerPanelForRefresh(card, panel) {
    if (!panel) return;
    const info = extractCardInfo(card);
    const productId = extractProductId(info.url);
    if (!productId) return;
    _pageRefreshSkus.set(String(productId), { card, panel });
    // 确保页面级定时器已启动
    _startPageRefresh();
  }

  function _unregisterPanelForRefresh(panel) {
    if (!panel) return;
    for (const [sku, entry] of _pageRefreshSkus) {
      if (entry.panel === panel) {
        _pageRefreshSkus.delete(sku);
        break;
      }
    }
  }

  // 批量刷新视口内所有 panel
  async function _refreshVisiblePanels() {
    if (_pageRefreshInflight) return; // 上一轮还没完成,跳过
    _pageRefreshInflight = true;
    try {
      // 收集视口内所有需要刷新的 panel
      const visible = [];
      for (const [sku, { card, panel }] of _pageRefreshSkus) {
        if (!panel.isConnected) {
          _pageRefreshSkus.delete(sku);
          continue;
        }
        const rect = panel.getBoundingClientRect();
        if (rect.bottom > -200 && rect.top < window.innerHeight + 200) {
          visible.push({ sku, card, panel });
        }
      }
      if (!visible.length) return;

      // 批量查 ERP 数据 + 缓存状态(2 条消息搞定所有 SKU)
      const skus = visible.map((v) => v.sku);
      const [erpBatch, cacheBatch] = await Promise.all([
        window.sendMessage('queryErpProductDataBatch', { skus }).catch(() => null),
        window.sendMessage('queryCacheStatusBatch', { skus }).catch(() => null),
      ]);

      // 分发结果到各 panel
      for (const { sku, card, panel } of visible) {
        const erpData = erpBatch?.[sku];
        const cacheStatus = cacheBatch?.[sku] || null;
        try {
          if (erpData?.preFetched && typeof window.jzPopulatePanelV2 === 'function') {
            if (panel.querySelector('.ozon-helper-sidebar-card-body')) {
              try {
                await window.jzPopulatePanelV2(panel, sku, { preFetched: erpData.preFetched });
              } catch {}
            } else if (typeof window.jzRenderProductPanelV2 === 'function') {
              window.jzRenderProductPanelV2(panel, { sku, initial: erpData });
              try {
                await window.jzPopulatePanelV2(panel, sku, { preFetched: erpData.preFetched });
              } catch {}
            }
            panelDataCache.set(sku, erpData);
          }
        } catch {
          // 静默失败,下次定时再试
        }
        // 刷新徽章 + 状态条
        window.__jzCollectStatus?.updateCollectBadge(card, sku);
        window.__jzCollectStatus?.renderCollectStatusBar(panel, sku, cacheStatus);
      }
    } finally {
      _pageRefreshInflight = false;
    }
  }

  // 单 panel 首次加载数据(不改批量,首次进入视口立即查,不等 5s 定时器)
  async function _refreshPanelData(card, panel) {
    const info = extractCardInfo(card);
    const productId = extractProductId(info.url);
    if (!productId || !panel || !panel.isConnected) return;
    try {
      const erpData = await window.sendMessage('queryErpProductData', { sku: productId });
      if (erpData?.preFetched && typeof window.jzPopulatePanelV2 === 'function') {
        if (panel.querySelector('.ozon-helper-sidebar-card-body')) {
          try {
            await window.jzPopulatePanelV2(panel, productId, { preFetched: erpData.preFetched });
          } catch {}
        } else if (typeof window.jzRenderProductPanelV2 === 'function') {
          window.jzRenderProductPanelV2(panel, { sku: productId, initial: erpData });
          try {
            await window.jzPopulatePanelV2(panel, productId, { preFetched: erpData.preFetched });
          } catch {}
        }
        panelDataCache.set(productId, erpData);
      }
    } catch {
      // 静默失败,5s 定时器会再试
    }
    window.__jzCollectStatus?.updateCollectBadge(card, productId);
    try {
      const cacheStatus = await window.sendMessage('queryCacheStatus', { sku: productId });
      window.__jzCollectStatus?.renderCollectStatusBar(panel, productId, cacheStatus);
    } catch {
      window.__jzCollectStatus?.renderCollectStatusBar(panel, productId, null);
    }
  }

  function _startPanelRefresh(card, panel) {
    // 注册到页面级批量刷新(旧 _panelRefreshTimers 已废弃)
    _registerPanelForRefresh(card, panel);
  }

  function _stopPanelRefresh(panel) {
    _unregisterPanelForRefresh(panel);
  }

  // 判断当前是否在 PDP(/product/<sku>/)
  // PDP 上的商品卡(主商品下方"也看了"/相关推荐)都不属于当前商品所在店铺,
  // 应统一标记为"非店铺商品",不依赖 isStoreSkuCard 的父级 widget 判定。
  function _isPdpPage() {
    return /^\/product\/[^/]+\/?$/i.test(window.location.pathname);
  }

  // 渲染店铺归属标签(商品卡顶部左上角)
  // 店铺 SKU:显示"店铺商品:xxx"(绿色)
  // 非店铺 SKU:显示"非店铺商品"(灰色)
  function renderSellerTag(card) {
    if (!card) return;
    let tag = card.querySelector('.jz-seller-tag');
    // 仅在店铺页(sellerSlug 非空)或 PDP(有 sellerInfo)才显示标签
    if (!sellerSlug) {
      if (tag) tag.remove();
      return;
    }
    // PDP 推荐区:所有 tile 都是非店铺商品(主商品不是 tile,不会进此函数)
    // 店铺页:用 isStoreSkuCard 区分店铺 SKU vs 推荐区
    const isStore = _isPdpPage() ? false : isStoreSkuCard(card);
    const text = isStore ? `店铺商品${sellerName ? ': ' + sellerName : ''}` : '非店铺商品';
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'jz-seller-tag';
      card.appendChild(tag);
    }
    tag.textContent = text;
    tag.dataset.isStore = isStore ? '1' : '0';
    tag.title = isStore
      ? `此商品属于当前店铺${sellerName ? '(' + sellerName + ')' : ''}`
      : '此商品为推荐/相关商品,不属于当前店铺';
  }

  // 暴露给 shared-utils.js 的 __jzSubmitCollectTask 复用 DOM 提取
  window.__jzExtractCardInfo = extractCardInfo;

  // 当前店铺页非店铺商品 SKU 集合(推荐区等),用于避免把非本店 SKU 关联到当前店铺
  const _nonStoreSkus = new Set();

  // 更新 MY 采集器面板的店铺 SKU 收集计数
  // 通过 collect-status.js 的 getStoreSkuStats() 桥接读取采集/略过拆分计数
  function _updateStoreSkuCount() {
    const panel = window.__qxCollectorPanel;
    if (panel && typeof panel.setStoreSkuCount === 'function') {
      const stats = window.__jzCollectStatus?.getStoreSkuStats?.() || { collected: 0, skipped: 0 };
      panel.setStoreSkuCount(stats);
    }
  }

  // ── store-sku 发现上报 ──────────────────────────────────────
  // panel 加载时上报"发现"关系到后端 ozon_store_sku 集合。
  // 触发条件:店铺页的店铺商品(SKU 属于当前店铺)、详情页当前展示的 SKU。
  // 搜索页不上报(无店铺信息);详情页"也看了"推荐区不上报(非当前商品)。
  // 去重策略:内存 Set 同一会话只上报一次 firstSeen;lastSeen 用 5 分钟 throttle
  const _storeSkuReported = new Set(); // 同一会话已上报 firstSeen 的 SKU
  const _storeSkuLastSeenTs = new Map(); // sku → 上次 lastSeen 上报时间戳
  const _STORE_SKU_SEEN_THROTTLE_MS = 5 * 60 * 1000; // 5 分钟
  function reportStoreSkuDiscovery(sku, options = {}) {
    try {
      const skuStr = String(sku);
      if (!skuStr || !sellerId) return; // 无 sellerId 不上报
      const now = Date.now();
      const isFirst = !_storeSkuReported.has(skuStr);
      const lastTs = _storeSkuLastSeenTs.get(skuStr) || 0;
      // firstSeen 总是上报;非 firstSeen 用 5 分钟 throttle
      if (!isFirst && now - lastTs < _STORE_SKU_SEEN_THROTTLE_MS) return;
      _storeSkuReported.add(skuStr);
      _storeSkuLastSeenTs.set(skuStr, now);
      // fire-and-forget,不阻塞 panel 渲染
      window.sendMessage('reportStoreSku', {
        sku: skuStr,
        sellerId,
        sellerSlug,
        sellerName,
        // 采集信息(可选,采集完成时 SW 会再次上报覆盖)
        lastCollectAt: options.lastCollectAt || null,
        lastCollectStatus: options.lastCollectStatus || null,
        lastCollectResults: options.lastCollectResults || null,
      });
    } catch (e) {
      console.warn('[ozon-data-panel] reportStoreSkuDiscovery 失败:', e?.message || e);
    }
  }

  // 1s interval 刷新采集中动画/冷却期状态 已迁移至 collect/content/collect-status.js

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
    const title = ariaLabel || imgAlt || textTitle;

    const priceNode =
      card.querySelector('[data-widget="searchResultsPrice"]') || card.querySelector('[data-widget="webPrice"]');
    const priceText = extractVisiblePriceText(card, priceNode);
    const price = window.normalizePrice ? window.normalizePrice(priceText) : null;

    // 评价数:Ozon 新版 DOM 移除了 data-widget 属性,改用公共提取函数
    // (见 shared-utils.js window.jzExtractRatingCount)
    const ratingCount = window.jzExtractRatingCount ? window.jzExtractRatingCount(card) : null;

    return {
      url: link?.href || '',
      name: title,
      price,
      image: img?.getAttribute('src') || img?.getAttribute('data-src') || '',
      ratingCount,
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

    // 用于 collectDone 广播快速定位面板
    card.dataset.jzSku = productId;
    if (panel) panel.dataset.jzSku = productId;

    // 上报"发现"关系到后端 ozon_store_sku(店铺页店铺商品 + 详情页当前 SKU)
    // - 店铺页:仅当 isStoreSkuCard(card)=true 时上报(非店铺商品已被 ensureDataPanel 跳过)
    // - 详情页:仅当 card 的 SKU = 当前页面 URL 的 SKU 时上报(跳过"也看了"推荐区)
    // - 搜索页:sellerId 为空,不上报
    if (sellerId) {
      const pdpSku = extractProductId(window.location.pathname);
      const isPdpMain = pdpSku && String(pdpSku) === String(productId);
      if (isPdpMain || (sellerSlug && isStoreSkuCard(card))) {
        reportStoreSkuDiscovery(productId);
      }
    }

    // 异步写 dom 缓存(card 类型,商品卡 DOM 5 字段,fire-and-forget,对齐 ozon-search.js)
    // 受 autoCollectState.running(自动采集总开关)控制:关闭时不写 card 缓存,
    // 避免 highlight/店铺页等在用户关闭自动采集后仍持续污染 dom 缓存。
    // 关闭时面板仍可渲染(通过定时刷新查 ERP 缓存填充数据)。
    if (window.sendMessage && autoCollectState.running) {
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
            ratingCount: info.ratingCount ?? null,
          },
        });
      } catch {
        /* fire-and-forget */
      }
    }

    // 1) 采集任务提交:受 panelState.enabled(自动采集开关)控制。
    //    关闭时不提交采集任务,但面板仍渲染(通过定时刷新查缓存填充数据)。
    //    panel 渲染(查 ERP、渲染字段)零阻塞,只有采集提交被 gate + 开关门控。
    //    非店铺页(无 sellerInfo)_collectGate 会被立即 resolve,等同直接提交。
    //    "仅抓有评价"开启时跳过 ratingCount=0/null 的商品(不入队不采集)。
    //    价格/评论数范围过滤同理:不在范围内不入队(但仍渲染面板)
    if (window.__jzSubmitCollectTask && _collectGate && panelState.enabled) {
      if (onlyWithRating && !info.ratingCount) {
        // 无评价且开关开启 → 跳过采集(但仍渲染面板)
      } else if (!_passesRangeFilter(info)) {
        // 不在价格/评论范围 → 跳过采集(但仍渲染面板)
      } else {
        _pendingSkus.push({ sku: productId, card });
        _collectGate.then((ctx) => _maybeFlushSku(productId, card, ctx));
      }
    }

    // 2) 优先用本页已 fetch 的缓存渲染(避免重复请求)
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
      window.__jzCollectStatus?.updateCollectBadge(card, productId);
      window.__jzCollectStatus?.refreshCollectStatusBar(panel, productId);
      return;
    }

    // 3) 缓存未命中时异步查 ERP 兜底;有数据直接渲染。
    // 无数据时也必须立刻 ready:骨架保留,等 collectDone 广播回填。
    // 若等采集完成才 ready,AutoScroller.isReadyToScroll 会永久卡在
    //「等待视口数据就绪」(翻页 ↔ 采集耦合,与队列重构解耦目标相反)。
    try {
      const erpData = await window.sendMessage('queryErpProductData', { sku: productId });
      if (erpData) {
        if (typeof window.jzRenderProductPanelV2 === 'function' && erpData.preFetched) {
          window.jzRenderProductPanelV2(panel, { sku: productId, initial: erpData });
          try {
            await window.jzPopulatePanelV2(panel, productId, { preFetched: erpData.preFetched });
          } catch {}
        } else {
          window.jzRenderProductCardPanel(panel, erpData);
        }
      } else {
        // ERP 无数据:直接渲染 V2 骨架(全 '-' 字段 + 状态条),等 collectDone 广播回填。
        // 避免面板停在 skeleton 状态,让用户看到完整字段布局 + 采集状态。
        if (typeof window.jzRenderProductPanelV2 === 'function') {
          window.jzRenderProductPanelV2(panel, { sku: productId });
        }
        // 补查终态/队列暂停,用于徽章文案;不论是否命中都 ready。
        // 时序竞态:SW 很快终态时 collectDone 可能先于 panel 创建 → 广播丢失,
        // 这里用 collect-status 的 _collectStatusMap 兜底徽章,避免误显示「采集中」。
        const CS = window.__jzCollectStatus;
        const st = CS?.getStatus(String(productId));
        if (st && ['success', 'partial', 'skipped', 'failed', 'antibot'].includes(st.status)) {
          // 已有终态,仅刷新徽章
        } else if (window.__jzQueuePaused) {
          // 队列暂停广播可能先于本 panel 创建,补一条 skipped 状态
          CS?.setStatus(String(productId), {
            status: 'skipped',
            reason: window.__jzQueuePaused.reason || 'paused',
            results: null,
            duration: null,
            timestamp: Date.now(),
          });
        }
      }
    } catch (e) {
      console.warn('[panel] ERP query failed:', e);
    }
    if (panel) panel.dataset.jzLoadStatus = 'ready';
    window.__jzCollectStatus?.updateCollectBadge(card, productId);
    window.__jzCollectStatus?.refreshCollectStatusBar(panel, productId);
    // 启动 5s 定时刷新(主动查缓存刷新数据 + 采集状态,不依赖自动采集开关)
    _startPanelRefresh(card, panel);
  }

  function ensureDataPanel(card) {
    if (card._ohPanelAttached) return;
    // 跳过没商品链接的 tile（推广位 / 占位 / 类目 chip 之类）
    if (!card.querySelector('a[href*="/product/"]')) return;
    card._ohPanelAttached = true;

    // 商品卡高度对齐:Ozon 原生 align-self:start 导致同一行卡高度不一致,
    // 用内联样式覆盖为 stretch,让同行卡拉伸到行高(CSS !important 可能被 Ozon 覆盖)
    card.style.setProperty('align-self', 'stretch', 'important');

    // 渲染店铺归属标签(店铺 SKU / 非店铺商品)
    renderSellerTag(card);

    // 店铺页:收集店铺 SKU 到 collect-status.js 的 _storeCollectedSkus
    // (用于 MY 采集器面板计数 + jz-collect-badge 标记)
    // 非店铺商品(推荐区)不收集,只记录到 _nonStoreSkus
    // PDP 推荐区全部视为非店铺,不收集(跟 renderSellerTag 判定一致)
    if (sellerSlug && !_isPdpPage() && isStoreSkuCard(card)) {
      const link = card.querySelector('a[href*="/product/"]');
      const m = link?.href.match(/\/product\/.*-(\d{5,})/);
      if (m) {
        const skuStr = String(m[1]);
        // addStoreSku 返回 true 表示新增,触发计数刷新
        if (window.__jzCollectStatus?.addStoreSku(skuStr)) {
          _updateStoreSkuCount();
        }
      }
    }

    // 店铺页:非店铺商品(推荐区/相关商品)只显示归属标签,不加载 panel 也不请求数据。
    // 原因:
    //   1. 非店铺商品与当前店铺无关,采集其数据会污染本店铺的 SKU 集合
    //   2. 节省网络请求(每个 panel 至少 4 个 fetch:marketStats/productStats/variants/followSell)
    //   3. 减少反爬风险(推荐区商品多达 30+,真调密度过高)
    // 注意:仍渲染 jz-seller-tag 标签(灰色"非店铺商品"),让用户知道这些是推荐商品
    // PDP 推荐区全部视为非店铺商品(跟 renderSellerTag 的判定一致)
    const isStore = _isPdpPage() ? false : isStoreSkuCard(card);
    if (sellerSlug && !isStore) {
      card._ohPanelSkipped = true; // 标记跳过,供 applyToAll/removeDataPanel 识别
      // 记录非店铺商品 SKU,避免把推荐区 SKU 错误关联到当前店铺
      const link = card.querySelector('a[href*="/product/"]');
      const m = link?.href.match(/\/product\/.*-(\d{5,})/);
      if (m) _nonStoreSkus.add(String(m[1]));
      return;
    }

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

    // 兜底:快速滚动时 IntersectionObserver 可能漏触发(元素从视口下方直接
    // 跳到上方,从未在视口+margin 范围内停留)。记录滚动起止位置,scroll 事件
    // 中检查 panel 是否在滚动路径上(起点到终点之间)。
    let _lastScrollY = window.scrollY;
    const _scrollCheck = () => {
      if (panel.dataset.jzLoadStatus !== 'pending') {
        window.removeEventListener('scroll', _scrollCheck, { capture: true });
        return;
      }
      if (panel._jzRafPending) return;
      panel._jzRafPending = true;
      const startY = _lastScrollY;
      const endY = window.scrollY;
      _lastScrollY = endY;
      requestAnimationFrame(() => {
        panel._jzRafPending = false;
        if (panel.dataset.jzLoadStatus !== 'pending') return;
        const rect = panel.getBoundingClientRect();
        const vh = window.innerHeight;
        // panel 在视口+margin 内(正常触发)
        if (rect.top < vh + 200 && rect.bottom > -200) {
          window.removeEventListener('scroll', _scrollCheck, { capture: true });
          observer.disconnect();
          loadPanelData(card, panel);
          return;
        }
        // panel 在滚动路径上(快速滚动跳过):panel 的文档绝对位置在 startY~endY+vh 之间
        const panelDocTop = endY + rect.top;
        const scrollMin = Math.min(startY, endY) - 200;
        const scrollMax = Math.max(startY, endY) + vh + 200;
        if (panelDocTop >= scrollMin && panelDocTop <= scrollMax) {
          window.removeEventListener('scroll', _scrollCheck, { capture: true });
          observer.disconnect();
          loadPanelData(card, panel);
        }
      });
    };
    window.addEventListener('scroll', _scrollCheck, { capture: true, passive: true });
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
      _stopPanelRefresh(card._ohPanel);
      card._ohPanel.remove();
      card._ohPanel = null;
    }
    // 清理店铺归属标签(关闭面板时一并移除)
    const tag = card.querySelector('.jz-seller-tag');
    if (tag) tag.remove();
    card._ohPanelAttached = false;
    card._ohPanelSkipped = false;
  }

  function getCards() {
    const cards = new Set();
    CARD_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((card) => cards.add(card));
    });
    return Array.from(cards);
  }

  function applyToAll() {
    // 数据面板始终展示,不再受自动采集开关(panelState.enabled)控制。
    // panelState.enabled 只控制采集行为(队列暂停/恢复),不影响面板显隐。
    const cards = getCards();
    cards.forEach((card) => ensureDataPanel(card));
  }

  // ─── 数据面板开关：从 chrome.storage.local 读 + 监听 onChanged ───
  // 旧版本是右下角浮动 toggle 按钮（.ozon-helper-panel-toggle）。
  // 现在统一移到极掌 popup 「工具与分析」分区里 toggle，状态持久化到
  // chrome.storage.local.ozon_data_panel_enabled。
  // 这里只订阅 storage 变化，自动 apply/remove 面板。
  const STORAGE_KEY = 'ozon_data_panel_enabled';
  const AUTO_COLLECT_CONFIG_KEY = 'jz-auto-collect-config';

  async function loadPanelEnabled() {
    try {
      const r = await chrome.storage.local.get(STORAGE_KEY);
      // 默认 true（首次安装时未设置 = 开启）
      panelState.enabled = r[STORAGE_KEY] !== false;
    } catch {
      panelState.enabled = true;
    }
  }

  async function loadAutoCollectRunning() {
    try {
      const r = await chrome.storage.local.get(AUTO_COLLECT_CONFIG_KEY);
      const cfg = r[AUTO_COLLECT_CONFIG_KEY] || {};
      autoCollectState.running = cfg.autoCollectRunning !== false;
    } catch {
      autoCollectState.running = true;
    }
  }

  function listenStorageToggle() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[STORAGE_KEY]) {
          panelState.enabled = changes[STORAGE_KEY].newValue !== false;
          // 数据面板始终展示,这里只更新 panelState.enabled(控制采集行为)
          // 不再调用 applyToAll() 移除/恢复面板
        }
        if (changes[AUTO_COLLECT_CONFIG_KEY]) {
          const cfg = changes[AUTO_COLLECT_CONFIG_KEY].newValue || {};
          autoCollectState.running = cfg.autoCollectRunning !== false;
        }
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
        // 操作 DOM 期间先 disconnect,避免 applyToAll 修改 DOM 触发自身 Observer
        // 形成反馈循环(单实例靠 RAF 节流可控,但扩展重载时所有标签页同时启动
        // 这个循环 + Ozon SPA 自身 DOM 更新 → 累积 CPU 负载不可忽视)。
        observer.disconnect();
        try {
          applyToAll();
        } catch (e) {
          console.error('[ozon-data-panel] applyToAll error in observer:', e);
        }
        // 重新观察(下一帧再接事件,避免本轮剩余 mutation 再次触发)
        requestAnimationFrame(() => {
          observer.observe(document.body, { childList: true, subtree: true });
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── QX采集器面板（非 search 页）────────────────
  // search/category 由 ozon-search.js 处理；本节负责首页 / 品牌 / 卖家 /
  // 商品详情"也看了" 等所有其他 ozon 页面。
  // QX采集器面板由 collect/content/collector-panel.js 提供,通过 SW autoCollect* action 管理状态。
  const COLLECTOR_KEY = 'ozon_collector_enabled';
  let collectorEnabled = true;
  let _collectorPanel = null;
  let _autoScroller = null;
  let _autoScrollStatusTimer = null;

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
            try {
              _collectorPanel.setAutoScrollStatus(_autoScroller.getScrollStatus());
            } catch {}
          },
          onEmpty: () => {
            if (!_collectorPanel) return;
            _collectorPanel.toast('当前页已抓取完成', 'success', 1800);
            try {
              _collectorPanel.setAutoScrollStatus(_autoScroller.getScrollStatus());
            } catch {}
          },
        });
      } catch {}
      // 500ms 轮询翻页状态，更新面板展示
      if (_autoScrollStatusTimer) clearInterval(_autoScrollStatusTimer);
      _autoScrollStatusTimer = setInterval(() => {
        if (!_autoScroller || !_collectorPanel) return;
        try {
          let status;
          if (!_autoScroller.isUserActive()) {
            // 自动翻页未开启: 如果有完成原因显示完成,否则显示 disabled
            const sc = _autoScroller.getScrollStatus();
            if (sc.status === 'completed') {
              status = sc;
            } else {
              status = { status: 'disabled', reason: '自动翻页未开启', detail: '' };
            }
          } else {
            status = _autoScroller.getScrollStatus();
          }
          _collectorPanel.setAutoScrollStatus(status);
        } catch {}
      }, 500);
    }

    // QXCollectorPanel.create 内部已调 mount(),无需单独调用
    _collectorPanel = window.QXCollectorPanel.create({
      callbacks: {
        onToggleRunning: (next) => {
          // 主开关:只控制采集行为(队列暂停/恢复),不影响数据面板显隐。
          // 数据面板始终展示,通过定时刷新主动查缓存填充数据。
          panelState.enabled = next;
          if (next) {
            taskQueue.resume();
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
          onlyWithRating = !!next;
        },
        // 价格/评论数范围变化:更新内部变量,影响后续新扫到的卡片是否入队
        // (已入队的不会主动取消,等下次自然轮询/rescan 时新过滤生效)
        onRangeFilterChange: ({ priceMin, priceMax, ratingMin, ratingMax }) => {
          if (priceMin !== undefined && priceMax !== undefined) {
            priceRange = _parseRange(priceMin, priceMax);
          }
          if (ratingMin !== undefined && ratingMax !== undefined) {
            ratingRange = _parseRange(ratingMin, ratingMax);
          }
        },
      },
    });
    // 暴露 jzCollectorToast 兼容 shared-utils.js 中可能的 toast 调用
    window.jzCollectorToast = (msg, type, duration) => _collectorPanel?.toast?.(msg, type, duration);
    _collectorPanel.setRunning(panelState.enabled);
    onlyWithRating = _collectorPanel.getInitialSalesFilter();
    // 启动时读面板初值(用户上次设置的过滤范围)
    try {
      const pRange = _collectorPanel.getPriceRange?.() || ['', ''];
      priceRange = _parseRange(pRange[0], pRange[1]);
      const rRange = _collectorPanel.getRatingRange?.() || ['', ''];
      ratingRange = _parseRange(rRange[0], rRange[1]);
    } catch (e) {
      console.warn('[panel] 读取范围初值失败:', e);
    }

    // 页面加载恢复:若主开关已开启且自动翻页开关勾选,启动 AutoScroller
    // (onToggleRunning 只在用户点击时触发,页面加载恢复时不会走那个分支)
    if (panelState.enabled && _autoScroller) {
      const cb = document.querySelector('[data-el="auto-scroll-toggle"]');
      if (cb && cb.checked) {
        try {
          _autoScroller.start();
        } catch {}
      }
    }

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
  //   1) 缓存 sellerSlug 供 loadPanelData → __jzSubmitCollectTask 用
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
    document.documentElement.setAttribute(
      'data-jz-seller-info-debug',
      JSON.stringify({
        step: 'handleSellerInfo-called',
        detail: detail ? { pageType: detail.pageType, slug: detail.slug } : null,
      })
    );
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
    if (!detail || (detail.pageType !== 'shop' && detail.pageType !== 'pdp')) {
      console.log('[ozon-data-panel] 非 shop/pdp 页面,跳过 checkStoreClassification');
      return;
    }
    const { slug, name, companyInfo } = detail;
    if (!slug) {
      console.log('[ozon-data-panel] slug 为空,跳过');
      return;
    }
    sellerSlug = slug; // 缓存,供 loadPanelData → __jzSubmitCollectTask 用
    sellerName = name || ''; // 缓存店铺名称,供 renderSellerTag 显示
    sellerId = detail.sellerId || ''; // 缓存 sellerId,供上报 store-sku 用
    // 店铺切换时清空非店铺商品 SKU 集合(页面刷新时 Set 自然重置,此处防御性处理)
    if (detail.pageType === 'shop') _nonStoreSkus.clear();
    // 收到店铺信息后,纠正时序问题(仅店铺页):ensureDataPanel 可能在 sellerSlug 到达前已执行,
    // 导致非店铺商品(推荐区)也创建了 panel。这里扫描所有卡片,移除非店铺商品的 panel。
    if (detail.pageType === 'shop') {
      try {
        const cards = document.querySelectorAll(CARD_SELECTORS.join(','));
        let removedCount = 0;
        for (const card of cards) {
          renderSellerTag(card);
          // 非店铺商品:移除可能已创建的 panel,记录 SKU 到 _nonStoreSkus
          if (!isStoreSkuCard(card)) {
            const link = card.querySelector('a[href*="/product/"]');
            const m = link?.href.match(/\/product\/.*-(\d{5,})/);
            if (m) _nonStoreSkus.add(String(m[1]));
            if (card._ohPanel) {
              card._ohPanel.remove();
              card._ohPanel = null;
              card._ohPanelAttached = false;
              card._ohPanelSkipped = true;
              removedCount++;
            }
          }
        }
        console.log(
          '[ozon-data-panel] sellerName 已缓存,已为',
          cards.length,
          '个商品卡刷新店铺标签,移除',
          removedCount,
          '个非店铺商品 panel'
        );
      } catch (e) {
        console.warn('[ozon-data-panel] 刷新店铺标签失败:', e);
      }
    }
    try {
      document.documentElement.setAttribute('data-jz-seller-info-debug', JSON.stringify({ step: 'calling-SW', slug }));
      console.log('[ozon-data-panel] >>> 调用 SW checkStoreClassification, 参数:', {
        slug,
        name,
        companyInfo,
        sellerId,
      });
      const result = await window.sendMessage('checkStoreClassification', { slug, name, companyInfo, sellerId });
      document.documentElement.setAttribute(
        'data-jz-seller-info-debug',
        JSON.stringify({
          step: 'SW-returned',
          result: result ? { isChinese: result.isChinese, classifiedBy: result.classifiedBy } : null,
          hasPanel: !!window.__qxCollectorPanel,
        })
      );
      console.log(
        '[ozon-data-panel] <<< SW checkStoreClassification 返回:',
        result,
        'hasPanel:',
        !!window.__qxCollectorPanel
      );
      // result: { isChinese, classifiedBy } | null
      // SW 返回 null 表示已查询但未分类(规则引擎无匹配 + ERP 无记录),
      // 此时 isChinese 应为 null(待确认),不能是 undefined(会被 store-detector 当作"未检测")
      const update = {
        slug,
        name,
        sellerId: detail.sellerId || '',
        pageType: detail.pageType || '',
        method: detail.method || '',
        companyInfo: detail.companyInfo || null,
        isChinese: result ? result.isChinese : null,
        classifiedBy: result ? result.classifiedBy : null,
      };
      // 缓存分类结果 + resolve collectGate,让 pending SKU 批量 flush
      _storeClassResult = result ? { isChinese: result.isChinese, classifiedBy: result.classifiedBy } : null;
      if (_gateState === 'pending') {
        _gateState = 'ready';
        _resolveCollectGate({ sellerSlug, sellerId, isChinese: update.isChinese });
      }
      _flushPendingSkus();
      console.log('[ozon-data-panel] 准备 updateStoreDetection:', update);
      _pendingStoreUpdate = update; // 缓存,供 mountCollectorHere 重放
      if (window.__qxCollectorPanel) {
        window.__qxCollectorPanel.updateStoreDetection(update);
        document.documentElement.setAttribute(
          'data-jz-seller-info-debug',
          JSON.stringify({ step: 'updateStoreDetection-called', update })
        );
        console.log('[ozon-data-panel] updateStoreDetection 已调用,面板已更新');
      } else {
        document.documentElement.setAttribute(
          'data-jz-seller-info-debug',
          JSON.stringify({ step: 'panel-not-ready', update })
        );
        console.log('[ozon-data-panel] 面板未挂载,update 已缓存,等 mountCollectorHere 时重放');
      }
    } catch (err) {
      document.documentElement.setAttribute(
        'data-jz-seller-info-debug',
        JSON.stringify({ step: 'SW-error', error: err?.message || String(err) })
      );
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
          console.log(
            '[ozon-data-panel] poll detected seq change:',
            _lastSeq,
            '->',
            parsed.seq,
            '(attempt ' + _pollCount + ')'
          );
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
  // 标记为中国后:重置去重集合 + 更新分类结果 + resolve gate + 重新提交当前页可见 SKU。
  window.addEventListener('jz-store-classified', (e) => {
    const { slug, isChinese } = e.detail || {};
    if (isChinese !== true) return;
    if (slug) sellerSlug = slug;
    // 更新分类结果 + resolve collectGate(让 pending SKU flush)
    _storeClassResult = { isChinese: true, classifiedBy: 'manual' };
    if (_gateState === 'pending') {
      _gateState = 'ready';
      _resolveCollectGate({ sellerSlug, sellerId, isChinese: true });
    }
    // 重置去重集合,让已见 SKU 重新触发提交
    window.__jzAutoCollectResetSeen?.();
    // 重新扫描页面已挂面板的 card,用新队列入口提交任务
    try {
      const cards = getCards();
      for (const card of cards) {
        const info = extractCardInfo(card);
        const productId = extractProductId(info.url);
        if (!productId) continue;
        window.__jzSubmitCollectTask?.(productId, card, sellerSlug, sellerId);
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

    // 初始化 collectGate:门控采集任务提交时机,避免 IntersectionObserver 在
    // sellerSlug 就绪前触发导致空 slug 入队。
    // 店铺页(/seller/*)等 sellerInfo 到达后 resolve;非店铺页立即 resolve(放行)。
    _initCollectGate();
    const _isShopPage = /^\/seller\/[^/]+\/?($|\/products\/?$)/i.test(window.location.pathname);
    if (!_isShopPage) {
      _gateState = 'ready';
      _resolveCollectGate({ sellerSlug: '', sellerId: '', isChinese: null });
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
    await loadAutoCollectRunning();
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
