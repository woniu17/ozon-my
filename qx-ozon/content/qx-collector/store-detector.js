// QX采集器 - 店铺检测区块
// 用于显示当前店铺的中国/非中国/待确认状态,支持人工标记
(function () {
  if (window.QXStoreDetector) return;

  /**
   * 渲染店铺检测区块
   * @param {HTMLElement} container - 容器元素
   * @param {object} state - {slug, name, isChinese, classifiedBy}
   *   isChinese: true(中国)/false(非中国)/null(待确认)/undefined(未检测)
   *   classifiedBy: 'rule:known-list' | 'rule:company-country' | 'manual' | null
   */
  function renderStoreDetectionBlock(container, state) {
    // 清空容器
    container.innerHTML = '';
    container.className = 'qx-c-store-detector';

    // 标题
    const title = document.createElement('div');
    title.className = 'qx-c-store-detector-title';
    title.textContent = '店铺检测';
    container.appendChild(title);

    // 状态区
    const statusDiv = document.createElement('div');
    statusDiv.className = 'qx-c-store-detector-status';

    if (state.isChinese === undefined || (!state.slug && !state.name)) {
      // 未检测
      statusDiv.innerHTML = '<span class="qx-c-store-pending">— 等待页面加载 —</span>';
      container.appendChild(statusDiv);
      return;
    }

    // 显示店铺名
    const nameDiv = document.createElement('div');
    nameDiv.className = 'qx-c-store-name';
    nameDiv.textContent = state.name || state.slug || '未知店铺';
    statusDiv.appendChild(nameDiv);

    // 根据 isChinese 渲染不同状态
    if (state.isChinese === true) {
      // 中国店铺
      const badge = document.createElement('span');
      badge.className = 'qx-c-store-badge qx-c-store-chinese';
      const ruleText = state.classifiedBy === 'manual' ? '(人工确认)' : `(规则: ${state.classifiedBy || '未知'})`;
      badge.textContent = `✓ 中国店铺 ${ruleText}`;
      statusDiv.appendChild(badge);

      // [重新分类] 按钮
      const reBtn = document.createElement('button');
      reBtn.className = 'qx-c-btn qx-c-btn-secondary';
      reBtn.textContent = '重新分类';
      reBtn.onclick = () => {
        // 区块回到「待确认」状态(不清除 L1/L2 记录,仅 UI 状态变化)
        renderStoreDetectionBlock(container, { ...state, isChinese: null, classifiedBy: null });
      };
      statusDiv.appendChild(reBtn);
    } else if (state.isChinese === false) {
      // 非中国店铺
      const badge = document.createElement('span');
      badge.className = 'qx-c-store-badge qx-c-store-non-chinese';
      const ruleText = state.classifiedBy === 'manual' ? '(人工确认)' : `(规则: ${state.classifiedBy || '未知'})`;
      badge.textContent = `✗ 非中国店铺 ${ruleText}`;
      statusDiv.appendChild(badge);

      // [重新分类] 按钮
      const reBtn = document.createElement('button');
      reBtn.className = 'qx-c-btn qx-c-btn-secondary';
      reBtn.textContent = '重新分类';
      reBtn.onclick = () => {
        renderStoreDetectionBlock(container, { ...state, isChinese: null, classifiedBy: null });
      };
      statusDiv.appendChild(reBtn);
    } else {
      // 待确认(isChinese === null)
      const badge = document.createElement('span');
      badge.className = 'qx-c-store-badge qx-c-store-pending';
      badge.textContent = '⚠ 待确认';
      statusDiv.appendChild(badge);

      // [✓ 标记中国] 按钮
      const markCnBtn = document.createElement('button');
      markCnBtn.className = 'qx-c-btn qx-c-btn-primary';
      markCnBtn.textContent = '✓ 标记中国';
      markCnBtn.onclick = async () => {
        markCnBtn.disabled = true;
        try {
          await sendMessage('classifyStore', { slug: state.slug, name: state.name, isChinese: true });
          // 刷新区块状态
          renderStoreDetectionBlock(container, { ...state, isChinese: true, classifiedBy: 'manual' });
          // 通知该页所有未采集 SKU 开始 autoCollect
          // 通过 CustomEvent 通知 content script
          window.dispatchEvent(
            new CustomEvent('jz-store-classified', { detail: { slug: state.slug, isChinese: true } })
          );
        } catch (e) {
          console.error('[QXStoreDetector] 标记中国失败:', e);
          markCnBtn.disabled = false;
        }
      };
      statusDiv.appendChild(markCnBtn);

      // [✗ 标记非中国] 按钮
      const markNonCnBtn = document.createElement('button');
      markNonCnBtn.className = 'qx-c-btn qx-c-btn-secondary';
      markNonCnBtn.textContent = '✗ 标记非中国';
      markNonCnBtn.onclick = async () => {
        markNonCnBtn.disabled = true;
        try {
          await sendMessage('classifyStore', { slug: state.slug, name: state.name, isChinese: false });
          renderStoreDetectionBlock(container, { ...state, isChinese: false, classifiedBy: 'manual' });
          window.dispatchEvent(
            new CustomEvent('jz-store-classified', { detail: { slug: state.slug, isChinese: false } })
          );
        } catch (e) {
          console.error('[QXStoreDetector] 标记非中国失败:', e);
          markNonCnBtn.disabled = false;
        }
      };
      statusDiv.appendChild(markNonCnBtn);
    }

    container.appendChild(statusDiv);
  }

  window.QXStoreDetector = { renderStoreDetectionBlock };
})();
