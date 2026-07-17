/* =========================================================
 * 采集状态同步(采集代码隔离 Phase 5)
 *
 * 从 content/ozon-data-panel.js 提取的采集状态相关代码:
 *   - _collectStatusMap(SKU→状态表)
 *   - _storeCollectedSkus(店铺 SKU 集合,供 badge 标记)
 *   - renderCollectStatusBar / refreshCollectStatusBar(7 类缓存状态条)
 *   - updateCollectBadge(商品卡角落徽章)
 *   - _refreshCollectStatusUi / _refreshAllCollectStatusUi
 *   - _applyQueuePaused(队列暂停状态应用)
 *   - _initCollectStatusMap(启动时拉取最近采集记录)
 *   - 1s interval(采集中动画 + 冷却期刷新)
 *   - 启动 setTimeout×2(拉取状态 + 查询队列)
 *
 * 架构(对齐 Phase 3/4 桥接模式):
 *   - 本文件在 ozon-data-panel.js 之前注入(manifest 顺序)
 *   - 暴露 window.__jzCollectStatus = { ... } 供 data-panel 调用
 *   - 暴露 window.__jzRefreshCollectStatusUi 兼容 collect-entry.js 旧调用
 *   - onMessage listener 保留在 data-panel.js,antibotDetected/queuePaused/
 *     queueResumed/taskStatus 分支改为调本文件桥接 API
 *   - rescan/collectDone 分支留 data-panel(耦合太深)
 *
 * 不迁移(留 data-panel.js):
 *   - 5s 定时器(_startPanelRefresh/_refreshPanelData/_stopPanelRefresh)
 *   - onMessage listener(分支改为调桥接)
 *   - _updateStoreSkuCount(改调 getStoreSkuCount())
 *   - renderSellerTag / reportStoreSkuDiscovery
 * ========================================================= */

(function () {
  'use strict';

  if (window.__jzCollectStatus) return; // 防止 MV3 重注入

  // 通用商品卡 selector(从 data-panel.js 复制,常量无副作用)
  const CARD_SELECTORS = [
    '.tile-root',
    '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
    '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
  ];

  // ── 采集状态表 ──────────────────────────────────────────────────
  // sku → { status, reason, results, duration, timestamp }
  // status: 'success' | 'partial' | 'skipped' | 'failed' | 'antibot'
  // reason: skipped 时为 'not-running'/'paused'/'daily-limit'/'non-chinese-store'/'unclassified-store'/'all-cached'
  // results: [{type, hit}] 7 类缓存命中明细
  const _collectStatusMap = new Map();
  let _collectStatusMapReady = false;

  // 当前店铺页已收集的店铺 SKU 集合(用于 MY 采集器面板计数 + jz-collect-badge 标记)
  // 收集时机:data-panel 的 ensureDataPanel 创建 panel 时调用 addStoreSku(sku)
  const _storeCollectedSkus = new Set();

  // 初始化:从 SW 拉取最近 200 条采集记录,填充 Map
  async function _initCollectStatusMap() {
    if (_collectStatusMapReady) return;
    _collectStatusMapReady = true; // 防止重复加载
    try {
      const recent = await window.sendMessage('autoCollectGetRecent', { limit: 200 });
      if (!Array.isArray(recent)) return;
      // recent 来自 SW 的 _autoCollectRecent.slice(-N).reverse(),排列为新→旧。
      // 正序遍历(新→旧),!has(sku) 保留先到的(最新的),确保同一 SKU 的
      // 最新状态覆盖旧状态(如 success 覆盖早期的 skipped+paused)。
      for (let i = 0; i < recent.length; i++) {
        const e = recent[i];
        if (!e || !e.sku) continue;
        if (!_collectStatusMap.has(e.sku)) {
          if (_collectStatusMap.size > 2000) _collectStatusMap.clear();
          _collectStatusMap.set(String(e.sku), {
            status: e.status,
            reason: e.reason || null,
            results: e.results || null,
            duration: e.duration,
            timestamp: e.timestamp,
          });
        }
      }
      console.log('[collect-status] _collectStatusMap 初始化完成, 共', _collectStatusMap.size, '条');
      // 刷新当前页所有已渲染的商品卡
      _refreshAllCollectStatusUi();
    } catch (e) {
      console.warn('[collect-status] _initCollectStatusMap 失败:', e);
    }
  }

  // 新队列状态 → UI 状态映射(collectDone 和 taskStatus 共用)
  const _STATUS_MAP = {
    success: 'success',
    failed_partial: 'partial',
    failed_final: 'failed',
    failed_retry: 'retrying',
    pending: 'pending',
    running: 'collecting',
  };

  // 应用队列暂停状态:设置全局标志 + 将所有 loading panel 设为 ready,避免
  // AutoScroller isReadyToScroll 死锁。任务仍保持 pending,跨日/恢复后重新消费。
  // 用于:(1) queuePaused 消息 handler,(2) 启动时主动查询 SW 队列状态(防时序竞态)。
  function _applyQueuePaused(reason) {
    reason = reason || 'unknown';
    console.log('[collect-status] 队列暂停:', reason, '所有 loading panel 设 ready');
    window.__jzQueuePaused = { reason, ts: Date.now() };
    const panels = document.querySelectorAll('.ozon-helper-data-panel[data-jz-load-status="loading"]');
    for (const panel of panels) {
      const sku = panel.dataset.jzSku;
      if (sku) {
        if (_collectStatusMap.size > 2000) _collectStatusMap.clear();
        _collectStatusMap.set(String(sku), {
          status: 'skipped',
          reason: reason,
          results: null,
          duration: null,
          timestamp: Date.now(),
        });
        _refreshCollectStatusUi(String(sku));
      }
      panel.dataset.jzLoadStatus = 'ready';
    }
  }

  // 状态文案
  const _COLLECT_STATUS_LABELS = {
    collecting: { text: '采集中', icon: '⟳', color: '#3b82f6' },
    pending: { text: '等待中', icon: '⏳', color: '#6366f1' },
    retrying: { text: '重试中', icon: '↻', color: '#f59e0b' },
    success: { text: '已采集', icon: '✓', color: '#16a34a' },
    partial: { text: '部分采集', icon: '◐', color: '#f59e0b' },
    skipped: { text: '跳过', icon: '−', color: '#94a3b8' },
    failed: { text: '失败', icon: '✗', color: '#ef4444' },
    antibot: { text: '采集中止', icon: '⚠', color: '#f97316' },
  };
  const _COLLECT_REASON_LABELS = {
    'not-running': '自动采集未开启',
    paused: '冷却期中',
    'daily-limit': '达每日上限',
    'non-chinese-store': '非中国店铺',
    'unclassified-store': '店铺未分类',
    'all-cached': '7 类缓存全命中',
    antibot: '反爬熔断',
  };
  const _CACHE_TYPE_LABELS = ['card', 'detail', 'pdp', 'search', 'bundle', 'marketStats', 'followSell'];

  // partial/failed 状态在 UI 上显示"等待重试中"的冷却时长(单位:ms)
  const _PENDING_COOLDOWN_MS = 60 * 1000;

  // 获取有效状态:
  // 1. 终态(success/skipped/antibot)优先于采集中标记 — 因为 collectDone 广播
  //    可能先于 sendMessage .then() 到达,此时 __jzCollectingSkus 仍有该 SKU,
  //    若优先返回 collecting 会导致 badge 永远停在"采集中"(.then() 清除后无刷新)
  // 2. 熔断期(antibotDetected)内,非终态 SKU 显示"采集中止"
  // 3. 采集中(无终态时)优先于冷却期内的等待状态
  // 4. partial/failed 在冷却期内 → 显示等待重试中(不显示倒计时秒数)
  function _getEffectiveStatus(sku) {
    const skuStr = String(sku);
    // 1. 先检查 _collectStatusMap 的终态
    const status = _collectStatusMap.get(skuStr);
    if (status && (status.status === 'success' || status.status === 'skipped' || status.status === 'antibot')) {
      return status;
    }
    // 2. 熔断检查:SW 检测到反爬时设置 __jzCircuitBreakerUntil,非终态 SKU 显示"采集中止"
    if (window.__jzCircuitBreakerUntil && Date.now() < window.__jzCircuitBreakerUntil) {
      return { status: 'antibot', timestamp: Date.now() };
    }
    // 3. 检查采集中(shared-utils.js 维护的 Set)
    if (window.__jzCollectingSkus?.has(skuStr)) {
      return { status: 'collecting', timestamp: Date.now() };
    }
    // 4. 无状态
    if (!status) return null;
    // 5. partial/failed 且在冷却期内 → 显示等待重试中(不显示秒数)
    if ((status.status === 'partial' || status.status === 'failed') && status.timestamp) {
      const elapsed = Date.now() - status.timestamp;
      if (elapsed < _PENDING_COOLDOWN_MS) {
        return { ...status, _waiting: true };
      }
    }
    return status;
  }

  // 设置 SKU 状态(供 data-panel 的 onMessage listener 调用)
  function setStatus(sku, statusInfo) {
    const skuStr = String(sku);
    if (_collectStatusMap.size > 2000) _collectStatusMap.clear();
    _collectStatusMap.set(skuStr, statusInfo);
  }

  // 获取 SKU 状态(供 data-panel 的 collectDone 分支读取)
  function getStatus(sku) {
    return _collectStatusMap.get(String(sku));
  }

  // ── 状态条渲染 ──────────────────────────────────────────────────
  // 渲染状态条(数据面板 hero section 下方,商品信息上方,固定展示)
  // 仅展示 7 类缓存命中状态,不查采集队列状态。
  // 3 行结构:行1 缓存命中汇总,行2/3 7 类缓存明细
  // cacheStatus: { results: [{type, hit}], hitCount, total } | null | undefined
  function renderCollectStatusBar(panel, sku, cacheStatus) {
    if (!panel) return;
    let bar = panel.querySelector('.jz-collect-status-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'jz-collect-status-bar';
      // 插入到 hero section 之后,无 hero 时插入到 body 顶部
      const hero = panel.querySelector('.oh-hero-section');
      if (hero) {
        hero.insertAdjacentElement('afterend', bar);
      } else {
        const body = panel.querySelector('.ozon-helper-sidebar-card-body');
        if (body) {
          body.insertAdjacentElement('afterbegin', bar);
        } else {
          panel.appendChild(bar);
        }
      }
    }
    // 构建缓存命中明细(按 _CACHE_TYPE_LABELS 固定顺序)
    // cacheStatus 为 null/undefined 时用全 miss 占位(让用户看到 7 类缓存字段布局)
    const results =
      cacheStatus && Array.isArray(cacheStatus.results) && cacheStatus.results.length > 0
        ? _CACHE_TYPE_LABELS.map((type) => cacheStatus.results.find((r) => r.type === type) || { type, hit: false })
        : _CACHE_TYPE_LABELS.map((type) => ({ type, hit: false }));
    const hitCount = results.filter((r) => r.hit).length;
    const total = results.length;
    // 行1:缓存命中汇总
    // 全命中:绿色 ✓ 缓存完整;部分命中:橙色 ◐ 缓存部分;全未命中:灰色 ○ 无缓存
    let icon, color, text;
    if (hitCount === 0) {
      icon = '○';
      color = '#94a3b8';
      text = '无缓存';
    } else if (hitCount === total) {
      icon = '✓';
      color = '#16a34a';
      text = '缓存完整';
    } else {
      icon = '◐';
      color = '#f59e0b';
      text = '缓存部分';
    }
    const renderLine = (arr) =>
      arr.map((r) => `<span class="jz-cache-${r.hit ? 'hit' : 'miss'}">${r.type}${r.hit ? '✓' : '✗'}</span>`).join(' ');
    const line1 = renderLine(results.slice(0, 4));
    const line2 = renderLine(results.slice(4, 8));
    bar.innerHTML =
      `<div class="jz-collect-status-row jz-collect-status-row-1">` +
      `<span class="jz-collect-status-icon" style="color:${color}">${icon}</span>` +
      `<span class="jz-collect-status-text" style="color:${color}">${text}</span>` +
      `<span class="jz-collect-status-reason"> · <span class="jz-cache-summary">${hitCount}/${total}</span></span>` +
      `</div>` +
      `<div class="jz-collect-status-row jz-collect-status-row-2">${line1}</div>` +
      `<div class="jz-collect-status-row jz-collect-status-row-3">${line2}</div>`;
    bar.dataset.hitCount = String(hitCount);
    bar.dataset.total = String(total);
  }

  // 异步刷新状态条:查询 SW 缓存状态(queryCacheStatus)后渲染
  // 供事件驱动(collectDone / taskStatus)和初始加载调用
  // 5s 定时器在 data-panel 的 _refreshPanelData 中单独处理(复用同一查询)
  async function refreshCollectStatusBar(panel, sku) {
    if (!panel || !panel.isConnected) return;
    try {
      const cacheStatus = await window.sendMessage('queryCacheStatus', { sku });
      renderCollectStatusBar(panel, sku, cacheStatus);
    } catch (e) {
      renderCollectStatusBar(panel, sku, null);
    }
  }

  // ── 徽章渲染 ──────────────────────────────────────────────────
  // 渲染角落徽章(商品卡 tile-root 右上角)
  // 语义:已收集的店铺 SKU 显示绿色 ✓ badge,非店铺 SKU 不显示
  function updateCollectBadge(card, sku) {
    if (!card) return;
    let badge = card.querySelector('.jz-collect-badge');
    const isCollected = _storeCollectedSkus.has(String(sku));
    if (!isCollected) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'jz-collect-badge';
      card.appendChild(badge);
    }
    badge.textContent = '✓';
    badge.style.backgroundColor = '#16a34a';
    badge.dataset.status = 'collected';
    badge.title = '已收集';
  }

  // 添加店铺 SKU 到已收集集合(供 data-panel 的 ensureDataPanel 调用)
  // 返回 true 表示新增,false 表示已存在(Set.add 幂等)
  function addStoreSku(sku) {
    const skuStr = String(sku);
    if (_storeCollectedSkus.has(skuStr)) return false;
    _storeCollectedSkus.add(skuStr);
    return true;
  }

  // 获取已收集店铺 SKU 数量(供 data-panel 的 _updateStoreSkuCount 调用)
  function getStoreSkuCount() {
    return _storeCollectedSkus.size;
  }

  // ── UI 刷新 ──────────────────────────────────────────────────
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
      if (panel) refreshCollectStatusBar(panel, sku);
    }
  }
  // SW 广播 collectDone/taskStatus 时会同步 __jzCollectingSkus,
  // 清除后需主动刷新 UI,否则 badge 永远停在"采集中"
  // 兼容 collect-entry.js 的旧调用名
  window.__jzRefreshCollectStatusUi = _refreshCollectStatusUi;

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
      if (panel) refreshCollectStatusBar(panel, m[1]);
    }
  }

  // ── 启动初始化 ──────────────────────────────────────────────────
  // 启动时拉取一次
  setTimeout(_initCollectStatusMap, 1500);

  // 启动时主动查询 SW 队列状态:防止时序竞态(SW 在 content script 注入完成前
  // 就广播了 queuePaused,onMessage listener 未注册导致错过,panel 永远卡 loading,
  // AutoScroller isReadyToScroll 死锁)。如果发现队列已暂停,立即应用暂停状态。
  // 注意:window.sendMessage resolve 的是 response.data,不是完整 response。
  setTimeout(async () => {
    try {
      const resp = await window.sendMessage('getQueueStatus');
      if (resp?.consumePaused) {
        console.log('[collect-status] 启动查询发现队列已暂停:', resp.reason);
        _applyQueuePaused(resp.reason || 'paused');
      }
    } catch (e) {
      console.warn('[collect-status] 启动查询队列状态失败:', e);
    }
  }, 1200);

  // ── 每秒刷新 UI:更新采集中动画和等待重试状态 ──────────────────
  // 只刷新有状态变化的 SKU(采集中或冷却期内的 partial/failed)
  setInterval(() => {
    const collectingSkus = window.__jzCollectingSkus;
    // 刷新采集中的 SKU
    if (collectingSkus && collectingSkus.size > 0) {
      for (const sku of collectingSkus) {
        _refreshCollectStatusUi(sku);
      }
    }
    const now = Date.now();
    // 熔断到期:刷新所有 UI(从 antibot 恢复到正常状态)
    if (window.__jzCircuitBreakerUntil && now >= window.__jzCircuitBreakerUntil) {
      window.__jzCircuitBreakerUntil = 0;
      _refreshAllCollectStatusUi();
    }
    // 刷新冷却期内的 partial/failed SKU(等待重试状态更新)
    for (const [sku, status] of _collectStatusMap) {
      if (status.status !== 'partial' && status.status !== 'failed') continue;
      if (!status.timestamp) continue;
      const elapsed = now - status.timestamp;
      if (elapsed < _PENDING_COOLDOWN_MS) {
        _refreshCollectStatusUi(sku);
      }
    }
  }, 1000);

  // ── 桥接对象:供 data-panel.js 调用 ──
  window.__jzCollectStatus = {
    renderCollectStatusBar,
    refreshCollectStatusBar,
    updateCollectBadge,
    addStoreSku,
    getStoreSkuCount,
    refreshUi: _refreshCollectStatusUi,
    refreshAllUi: _refreshAllCollectStatusUi,
    setStatus,
    getStatus,
    applyQueuePaused: _applyQueuePaused,
    STATUS_MAP: _STATUS_MAP,
    CACHE_TYPE_LABELS: _CACHE_TYPE_LABELS,
  };
})();
