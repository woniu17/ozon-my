// QX采集器 - 店铺检测区块
// 用于显示当前店铺的完整信息(名称/slug/sellerId/公司信息/国家/采集方式/中国大陆状态),支持人工标记
(function () {
  if (window.QXStoreDetector) return;

  // 采集方式文案映射
  const _METHOD_LABELS = {
    'via-pdp': '详情页提取',
    'via-entrypoint-api': 'API 提取',
    'slug-only': '仅 slug',
    'nuxt-timeout': 'NUXT 超时',
    failed: '提取失败',
    '': '—',
  };

  // 国家代码 → 中文名(常见国家)
  const _COUNTRY_LABELS = {
    CN: '中国大陆(CN)',
    RU: '俄罗斯(RU)',
    US: '美国(US)',
    HK: '香港(HK)',
    TW: '台湾(TW)',
    KZ: '哈萨克斯坦(KZ)',
    BY: '白俄罗斯(BY)',
    TR: '土耳其(TR)',
  };

  function _countryLabel(code) {
    if (!code) return '—';
    return _COUNTRY_LABELS[code] || code;
  }

  // 创建一行信息(label: value)
  function _infoRow(label, value, opts) {
    opts = opts || {};
    const row = document.createElement('div');
    row.className = 'qx-c-store-info-row';
    if (opts.muted) row.classList.add('qx-c-store-info-muted');
    const labelEl = document.createElement('span');
    labelEl.className = 'qx-c-store-info-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = 'qx-c-store-info-value';
    valueEl.textContent = value || '—';
    if (opts.muted && !value) valueEl.classList.add('qx-c-store-info-empty');
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    return row;
  }

  /**
   * 渲染店铺检测区块
   * @param {HTMLElement} container - 容器元素
   * @param {object} state - {slug, name, sellerId, pageType, method, companyInfo, isMainlandChina, classifiedBy}
   *   companyInfo: { companyName, legalAddress, country } | null
   *   isMainlandChina: true(中国大陆)/false(非中国大陆)/null(待确认)/undefined(未检测)
   *   classifiedBy: 'rule:known-list' | 'rule:company-country' | 'manual' | null
   */
  function renderStoreDetectionBlock(container, state) {
    // 清空容器
    container.innerHTML = '';
    container.className = 'qx-c-store-detector';

    // 未检测态:slug 和 name 都没有
    if (state.isMainlandChina === undefined || (!state.slug && !state.name)) {
      const statusDiv = document.createElement('div');
      statusDiv.className = 'qx-c-store-detector-status';
      statusDiv.innerHTML = '<span class="qx-c-store-badge qx-c-store-pending">— 等待页面加载 —</span>';
      container.appendChild(statusDiv);
      return;
    }

    // 状态区
    const statusDiv = document.createElement('div');
    statusDiv.className = 'qx-c-store-detector-status';

    // 店铺名(标题)
    const nameDiv = document.createElement('div');
    nameDiv.className = 'qx-c-store-name';
    nameDiv.textContent = state.name || state.slug || '未知店铺';
    statusDiv.appendChild(nameDiv);

    // 中国大陆/非中国大陆/待确认 badge
    if (state.isMainlandChina === true) {
      const badge = document.createElement('span');
      badge.className = 'qx-c-store-badge qx-c-store-chinese';
      const ruleText = state.classifiedBy === 'manual' ? '(人工确认)' : `(规则: ${state.classifiedBy || '未知'})`;
      badge.textContent = `✓ 中国大陆店铺 ${ruleText}`;
      statusDiv.appendChild(badge);
    } else if (state.isMainlandChina === false) {
      const badge = document.createElement('span');
      badge.className = 'qx-c-store-badge qx-c-store-non-chinese';
      const ruleText = state.classifiedBy === 'manual' ? '(人工确认)' : `(规则: ${state.classifiedBy || '未知'})`;
      badge.textContent = `✗ 非中国大陆店铺 ${ruleText}`;
      statusDiv.appendChild(badge);
    } else {
      // isMainlandChina === null 待确认
      const badge = document.createElement('span');
      badge.className = 'qx-c-store-badge qx-c-store-pending';
      badge.textContent = '⚠ 待确认';
      statusDiv.appendChild(badge);
    }

    container.appendChild(statusDiv);

    // 详细信息区(label: value 行)
    const infoDiv = document.createElement('div');
    infoDiv.className = 'qx-c-store-info';

    infoDiv.appendChild(_infoRow('Slug', state.slug));
    infoDiv.appendChild(_infoRow('Seller ID', state.sellerId));

    // 公司信息
    const ci = state.companyInfo || {};
    infoDiv.appendChild(_infoRow('公司名称', ci.companyName));
    infoDiv.appendChild(_infoRow('法定地址', ci.legalAddress));
    infoDiv.appendChild(_infoRow('国家', _countryLabel(ci.country)));

    // 采集方式
    infoDiv.appendChild(_infoRow('采集方式', _METHOD_LABELS[state.method] || state.method || '—', { muted: true }));

    container.appendChild(infoDiv);

    // 操作按钮区
    const actionDiv = document.createElement('div');
    actionDiv.className = 'qx-c-store-actions';

    if (state.isMainlandChina === true || state.isMainlandChina === false) {
      // 已分类:显示[重新分类]
      const reBtn = document.createElement('button');
      reBtn.className = 'qx-c-btn qx-c-btn-secondary';
      reBtn.textContent = '重新分类';
      reBtn.onclick = () => {
        // 区块回到「待确认」状态(不清除 L1/L2 记录,仅 UI 状态变化)
        renderStoreDetectionBlock(container, { ...state, isMainlandChina: null, classifiedBy: null });
      };
      actionDiv.appendChild(reBtn);
    } else {
      // 待确认:显示[✓ 标记中国大陆] [✗ 标记非中国大陆]
      const markCnBtn = document.createElement('button');
      markCnBtn.className = 'qx-c-btn qx-c-btn-primary';
      markCnBtn.textContent = '✓ 标记中国大陆';
      markCnBtn.onclick = async () => {
        markCnBtn.disabled = true;
        try {
          await sendMessage('classifyStore', { slug: state.slug, name: state.name, isMainlandChina: true });
          renderStoreDetectionBlock(container, { ...state, isMainlandChina: true, classifiedBy: 'manual' });
          window.dispatchEvent(
            new CustomEvent('jz-store-classified', { detail: { slug: state.slug, isMainlandChina: true } })
          );
        } catch (e) {
          console.error('[QXStoreDetector] 标记中国大陆失败:', e);
          markCnBtn.disabled = false;
        }
      };
      actionDiv.appendChild(markCnBtn);

      const markNonCnBtn = document.createElement('button');
      markNonCnBtn.className = 'qx-c-btn qx-c-btn-secondary';
      markNonCnBtn.textContent = '✗ 标记非中国大陆';
      markNonCnBtn.onclick = async () => {
        markNonCnBtn.disabled = true;
        try {
          await sendMessage('classifyStore', { slug: state.slug, name: state.name, isMainlandChina: false });
          renderStoreDetectionBlock(container, { ...state, isMainlandChina: false, classifiedBy: 'manual' });
          window.dispatchEvent(
            new CustomEvent('jz-store-classified', { detail: { slug: state.slug, isMainlandChina: false } })
          );
        } catch (e) {
          console.error('[QXStoreDetector] 标记非中国大陆失败:', e);
          markNonCnBtn.disabled = false;
        }
      };
      actionDiv.appendChild(markNonCnBtn);
    }

    container.appendChild(actionDiv);
  }

  window.QXStoreDetector = { renderStoreDetectionBlock };
})();
