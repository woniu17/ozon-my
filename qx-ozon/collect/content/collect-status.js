/* =========================================================
 * 采集状态同步(采集代码隔离 Phase 5 — 2026-07 重构)
 *
 * 重构目标:深度采集队列状态与前端 UI 完全解耦。
 *   - 不再监听 collectDone/queuePaused/queueResumed/antibotDetected/taskStatus
 *   - 不再维护 _collectStatusMap(深度采集状态表)和 __jzCollectingSkus Set
 *   - 不再有 1s 动画定时器和启动时队列状态查询
 *   - 徽章仅展示浅度采集状态:
 *       无徽章  = 未发现
 *       蓝色 •  = 已发现未采集(店铺 SKU 已扫到但 ERP 缓存无数据)
 *       绿色 ✓  = 已采集(ERP 缓存有数据 — 任一缓存类型命中即视为已采集)
 *   - 缓存命中数据由 data-panel.js 的 5s 定时器通过 queryCacheStatusBatch
 *     批量查询,结果传入 renderCollectStatusBar 时同步更新 _skuCacheHitSet
 *
 * 保留职责:
 *   - _storeCollectedSkus(店铺 SKU 集合,供徽章判定 + MY 采集器面板计数)
 *   - renderCollectStatusBar(数据面板内 5 类缓存命中状态条)
 *   - updateCollectBadge(商品卡角落徽章 — 缓存命中驱动)
 *   - _refreshCollectStatusUi / _refreshAllCollectStatusUi(刷新徽章 + 状态条)
 *
 * 架构(对齐 Phase 3/4 桥接模式):
 *   - 本文件在 ozon-data-panel.js 之前注入(manifest 顺序)
 *   - 暴露 window.__jzCollectStatus = { ... } 供 data-panel 调用
 *   - 暴露 window.__jzRefreshCollectStatusUi 兼容 collect-entry.js 旧调用
 *   - onMessage listener 保留在 data-panel.js(仅 rescan)
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

  // 当前店铺页已收集的店铺 SKU 集合(用于 MY 采集器面板计数 + jz-collect-badge 标记)
  // 收集时机:data-panel 的 ensureDataPanel 创建 panel 时调用 addStoreSku(sku)
  const _storeCollectedSkus = new Set();

  // 已采集 SKU 集合(缓存命中驱动)
  // 由 renderCollectStatusBar 在收到 5s 定时器的 cacheStatus 时同步更新:
  //   - hitCount > 0 → 加入集合(已采集)
  //   - hitCount === 0 → 从集合移除(未采集,可能采集未完成或还未采集)
  // 该集合是徽章"已采集"判定的唯一依据,不依赖深度采集队列状态。
  const _skuCacheHitSet = new Set();

  // 5 类合并缓存命中位(与采集箱对齐)
  //   dom = card OR detail(任一有采集)
  //   attribute = search AND bundle(都需要)
  //   richMedia / marketStats / followSell 各自独立
  const _CACHE_TYPE_LABELS = ['dom', 'attribute', 'richMedia', 'marketStats', 'followSell'];

  // ── 状态条渲染 ──────────────────────────────────────────────────
  // 渲染状态条(数据面板 hero section 下方,商品信息上方,固定展示)
  // 仅展示 5 类缓存命中状态,不查采集队列状态。
  // 单行布局:汇总图标 + 文案 + 5 类命中明细
  // cacheStatus: { results: [{type, hit}], hitCount, total } | null | undefined
  //
  // 副作用:同步更新 _skuCacheHitSet — hitCount > 0 时加入 sku,否则移除。
  // 这是徽章"已采集"判定的唯一数据源,确保徽章与状态条数据一致。
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
    // 构建缓存命中明细(5 类合并,与采集箱对齐)
    // cacheStatus 为 null/undefined 时用全 miss 占位(让用户看到 5 类缓存字段布局)
    const results =
      cacheStatus && Array.isArray(cacheStatus.results) && cacheStatus.results.length > 0
        ? _CACHE_TYPE_LABELS.map((type) => cacheStatus.results.find((r) => r.type === type) || { type, hit: false })
        : _CACHE_TYPE_LABELS.map((type) => ({ type, hit: false }));
    const hitCount = results.filter((r) => r.hit).length;
    const total = results.length;
    // 同步更新 _skuCacheHitSet(徽章数据源)
    const skuStr = String(sku);
    if (hitCount > 0) {
      _skuCacheHitSet.add(skuStr);
    } else {
      _skuCacheHitSet.delete(skuStr);
    }
    // 单行布局:汇总图标 + 文案 + 5 类命中明细
    //   全命中:绿色 ✓ 缓存完整;部分命中:橙色 ◐ 缓存部分;全未命中:灰色 ○ 无缓存
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
    const detailHtml = results
      .map((r) => `<span class="jz-cache-${r.hit ? 'hit' : 'miss'}">${r.type}${r.hit ? '✓' : '✗'}</span>`)
      .join(' ');
    bar.innerHTML =
      `<div class="jz-collect-status-row jz-collect-status-row-1">` +
      `<span class="jz-collect-status-icon" style="color:${color}">${icon}</span>` +
      `<span class="jz-collect-status-text" style="color:${color}">${text}</span>` +
      `<span class="jz-collect-status-reason"> · <span class="jz-cache-summary">${hitCount}/${total}</span> · ${detailHtml}</span>` +
      `</div>`;
    bar.dataset.hitCount = String(hitCount);
    bar.dataset.total = String(total);
  }

  // 异步刷新状态条:no-op(2026-07 移除单 SKU queryCacheStatus 调用)
  // 状态条由 5s 定时器 _pageRefreshTimer 通过 queryCacheStatusBatch 批量刷新,
  // 单 SKU 即时刷新取消,首次渲染最多 5s 后由定时器补上。
  // 保留函数签名避免破坏外部调用方(ozon-data-panel.js 等)。
  async function refreshCollectStatusBar(panel, sku) {
    return;
  }

  // ── 徽章渲染 ──────────────────────────────────────────────────
  // 渲染角落徽章(商品卡 tile-root 右上角)
  // 二态(2026-07 重构,深度采集状态与 UI 解耦):
  //   - 无徽章  = 未发现(非店铺商品,或还未扫到)
  //   - 蓝色 •  = 已发现未采集(店铺 SKU 已收集,但 ERP 缓存无数据)
  //                   典型场景:浅度采集开关关闭、采集未完成、5s 定时器尚未查询
  //   - 绿色 ✓  = 已采集(ERP 缓存有数据 — 任一缓存类型命中即视为已采集)
  // 判定依据:
  //   - _storeCollectedSkus.has(sku) = 已发现(店铺页扫到 + addStoreSku 调用过)
  //   - _skuCacheHitSet.has(sku) = 已采集(5s 定时器查缓存命中后写入集合)
  function updateCollectBadge(card, sku) {
    if (!card) return;
    const skuStr = String(sku);
    const isDiscovered = _storeCollectedSkus.has(skuStr);
    if (!isDiscovered) {
      const badge = card.querySelector('.jz-collect-badge');
      if (badge) badge.remove();
      return;
    }
    const isCollected = _skuCacheHitSet.has(skuStr);

    let badge = card.querySelector('.jz-collect-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'jz-collect-badge';
      card.appendChild(badge);
    }
    if (isCollected) {
      badge.textContent = '✓';
      badge.style.backgroundColor = '#16a34a';
      badge.dataset.status = 'collected';
      badge.title = '已采集';
    } else {
      badge.textContent = '•';
      badge.style.backgroundColor = '#0ea5e9';
      badge.dataset.status = 'discovered';
      badge.title = '已发现未采集';
    }
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

  // 获取已发现店铺 SKU 的采集/略过统计(供 MY 采集器面板展示拆分计数)
  // - collected(采集):已发现 + ERP 缓存命中(_skuCacheHitSet)
  // - skipped(略过):已发现总数 - 采集数
  // 注:缓存命中是异步的(5s 定时器刷新),首次加载时 collected 可能为 0,
  //     定时器跑过一轮后即准确。
  function getStoreSkuStats() {
    let collected = 0;
    const total = _storeCollectedSkus.size;
    for (const sku of _storeCollectedSkus) {
      if (_skuCacheHitSet.has(sku)) collected++;
    }
    return { collected, skipped: Math.max(0, total - collected), total };
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

  // ── 桥接对象:供 data-panel.js 调用 ──
  window.__jzCollectStatus = {
    renderCollectStatusBar,
    refreshCollectStatusBar,
    updateCollectBadge,
    addStoreSku,
    getStoreSkuCount,
    getStoreSkuStats,
    refreshUi: _refreshCollectStatusUi,
    refreshAllUi: _refreshAllCollectStatusUi,
    CACHE_TYPE_LABELS: _CACHE_TYPE_LABELS,
  };
})();
