/* =========================================================
 * 采集任务提交入口(从 shared-utils.js 抽离)
 *
 * 职责:
 *   - 页面级 SKU 去重(_autoCollectSeen)
 *   - 维护"采集中" SKU 集合(__jzCollectingSkus)
 *   - 提交采集任务到 SW 队列(__jzSubmitCollectTask)
 *   - 监听 SW 广播同步采集状态(collectDone/taskStatus)
 *
 * 依赖(window 挂载,由其他文件提供):
 *   - window.__jzExtractCardInfo  (ozon-data-panel.js)
 *   - window.jzExtractRatingCount (shared-utils.js)
 *   - window.normalizePrice       (shared-utils.js)
 *   - window.sendMessage          (shared-utils.js)
 *   - window.__jzRefreshCollectStatusUi (ozon-data-panel.js)
 *
 * 暴露(window 挂载):
 *   - window.__jzSubmitCollectTask
 *   - window.__jzAutoCollectResetSeen
 *   - window.__jzCollectingSkus
 * ========================================================= */
(() => {
  if (window.__jzSubmitCollectTask) return; // 守卫,防止重复加载

  const _autoCollectSeen = new Set(); // 页面级去重,避免同一 SKU 重复提交采集任务
  // 正在采集中的 SKU 集合(用于 UI 显示"采集中"状态)
  // __jzSubmitCollectTask 提交前 add,collectDone/taskStatus 收到后 delete
  window.__jzCollectingSkus = window.__jzCollectingSkus || new Set();

  /**
   * 从商品卡提取 submitTask 需要的轻量 DOM 信息。
   * 优先复用 ozon-data-panel.js 暴露的 __jzExtractCardInfo,不可用则退化最小实现。
   */
  function _extractDomInfoForTask(card) {
    if (window.__jzExtractCardInfo) {
      const info = window.__jzExtractCardInfo(card);
      return {
        title: info.name || '',
        price: info.price != null ? Number(info.price) : null,
        imageUrl: info.image || '',
        ratingCount: info.ratingCount ?? null,
      };
    }

    const link = card?.querySelector('a[href*="/product/"]');
    const img = card?.querySelector('img');
    const priceNode =
      card?.querySelector('[data-widget="searchResultsPrice"]') || card?.querySelector('[data-widget="webPrice"]');
    const priceText = priceNode?.textContent || '';

    const ratingCount = window.jzExtractRatingCount ? window.jzExtractRatingCount(card) : null;

    return {
      title: (link?.getAttribute('aria-label') || img?.getAttribute('alt') || link?.textContent?.trim() || '').slice(
        0,
        200
      ),
      price: window.normalizePrice ? window.normalizePrice(priceText) : null,
      imageUrl: img?.getAttribute('src') || img?.getAttribute('data-src') || '',
      ratingCount,
    };
  }

  /**
   * 提交采集任务到 SW 队列。
   * - 全站可用(店铺页/搜索页/详情页等),非店铺页无 sellerSlug 时自动跳过中国卖家筛选;
   * - 开启 onlyChineseStores 时先 checkStoreClass,非中国店铺永久跳过,未分类/SW 故障仅本次跳过;
   * - 页面级 _autoCollectSeen 去重,最终去权由 SW 队列保证。
   *
   * @param {string|number} sku
   * @param {HTMLElement} card
   * @param {string} sellerSlug
   * @param {string} sellerId
   */
  async function __jzSubmitCollectTask(sku, card, sellerSlug, sellerId) {
    const skuStr = String(sku);
    if (_autoCollectSeen.has(skuStr)) {
      return;
    }

    let config = {};
    try {
      const r = await chrome.storage.local.get('jz-auto-collect-config');
      config = r['jz-auto-collect-config'] || {};
    } catch {
      /* 忽略,按默认配置走 */
    }

    // 浅度采集开关:关闭时不提交任务到 SW 队列
    // (浅度开关门控"是否触发采集",深度开关门控"SW 是否消费任务",两者独立)
    // 深度开关 autoCollectRunning 关闭时,任务仍会入队,SW Gate0 跳过,等用户开启后再消费
    if (config.shallowCollectRunning === false) {
      return;
    }

    // 中国店铺筛选:仅在店铺页(sellerSlug 非空)且开启 onlyChineseStores 时执行。
    // - isChinese === false:确实非中国,永久跳过(add 到 seen)
    // - isChinese === null/undefined(未分类):本次跳过但不永久标记,下次可重试
    // - checkStoreClass 异常(SW 短暂故障):本次跳过但不永久标记,下次可重试
    if (config.onlyChineseStores && sellerSlug) {
      try {
        const result = await window.sendMessage('checkStoreClass', { slug: sellerSlug, sellerId: sellerId || '' });
        if (result?.isChinese === false) {
          console.log('[submitTask] 跳过非中国店铺:', sellerSlug, result);
          if (_autoCollectSeen.size > 2000) _autoCollectSeen.clear();
          _autoCollectSeen.add(skuStr);
          return;
        }
        if (result?.isChinese !== true) {
          console.log('[submitTask] 店铺未分类,本次跳过:', sellerSlug, result);
          return;
        }
      } catch (e) {
        console.warn('[submitTask] checkStoreClass 失败,本次跳过:', skuStr, e);
        return;
      }
    }

    const domInfo = _extractDomInfoForTask(card);
    try {
      await window.sendMessage('submitTask', {
        sku: skuStr,
        sellerSlug: sellerSlug || '',
        sellerId: sellerId || '',
        domInfo,
      });
      if (_autoCollectSeen.size > 2000) _autoCollectSeen.clear();
      _autoCollectSeen.add(skuStr);
      console.log('[submitTask] 已提交:', skuStr);
    } catch (e) {
      console.warn('[submitTask] 提交失败:', skuStr, e);
    }
  }
  window.__jzSubmitCollectTask = __jzSubmitCollectTask;

  /**
   * 清空去重集合(供面板/popup「强制刷新当前页」调用)
   */
  window.__jzAutoCollectResetSeen = function () {
    _autoCollectSeen.clear();
  };

  // 监听 SW 发来的 __jzAutoCollectResetSeen 消息,清空去重集合
  // 同时处理 collectDone / taskStatus 广播,同步"采集中"集合与徽章。
  chrome.runtime.onMessage?.addListener((message) => {
    if (!message) return;
    if (message === '__jzAutoCollectResetSeen' || message.type === '__jzAutoCollectResetSeen') {
      _autoCollectSeen.clear();
      return;
    }
    if (message.type === 'collectDone' && message.sku) {
      const skuStr = String(message.sku);
      window.__jzCollectingSkus.delete(skuStr);
      if (window.__jzRefreshCollectStatusUi) window.__jzRefreshCollectStatusUi(skuStr);
      return;
    }
    if (message.type === 'taskStatus' && message.sku) {
      const skuStr = String(message.sku);
      if (message.status === 'running' || message.status === 'pending') {
        window.__jzCollectingSkus.add(skuStr);
      } else {
        window.__jzCollectingSkus.delete(skuStr);
      }
      if (window.__jzRefreshCollectStatusUi) window.__jzRefreshCollectStatusUi(skuStr);
    }
  });
})();
