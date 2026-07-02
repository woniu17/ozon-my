// MY 算价面板 —— 复刻原项目 ozon-helper 算价精灵 + 利润计算(0.13.31.1)。
// 固定定位侧边面板,2 个 tab:定价精灵(反算售价)+ 利润计算(正算利润)。
// 汇率/佣金/物流费从 ERP 配置中心拉取(pricing scope),UI 完整复刻原项目视觉与交互。
// 所有 class 用 `xy-pp-` 前缀,替代原 `ozon-helper-calc-*` / `ozon-helper-profit-*`。

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 消息发送(封装 chrome.runtime.sendMessage)
  // ────────────────────────────────────────────────────────────
  function sendMessage(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error('chrome.runtime 不可用(扩展可能正在重载)'));
        return;
      }
      chrome.runtime.sendMessage({ type, ...data }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(resp);
      });
    });
  }

  // ────────────────────────────────────────────────────────────
  // 常量(默认值;P1-2:面板挂载时从 ERP 配置中心拉取 pricing scope 覆盖)
  // ────────────────────────────────────────────────────────────
  let RATE_RUB = 11.08; // 固定汇率 ¥1 = ₽11.08
  let COMMISSION_RATES = {
    beauty_mid: 0.15,
    beauty_high: 0.17,
    electronics: 0.13,
    apparel: 0.14,
    home: 0.12,
  };
  let LOGISTICS_COST = { xs: 8, budget: 12, small: 18, big: 35 }; // 定价精灵:固定 ¥
  let PROFIT_LOGISTICS = { guoo: 0.06, cel: 0.055, xy: 0.05, zto: 0.065 }; // 利润计算:¥/g

  // 配置是否已拉取(避免重复请求)
  let __pricingConfigLoaded = false;
  async function loadPricingConfig() {
    if (__pricingConfigLoaded) return;
    try {
      const resp = await sendMessage('getConfig', { query: { scope: 'pricing' } });
      const cfg = resp?.data?.data || {};
      if (typeof cfg.rate_rub === 'number') RATE_RUB = cfg.rate_rub;
      if (cfg.commission_rates && typeof cfg.commission_rates === 'object') COMMISSION_RATES = cfg.commission_rates;
      if (cfg.logistics_cost && typeof cfg.logistics_cost === 'object') LOGISTICS_COST = cfg.logistics_cost;
      if (cfg.profit_logistics && typeof cfg.profit_logistics === 'object') PROFIT_LOGISTICS = cfg.profit_logistics;
    } catch (e) {
      console.warn('[Pricing] 拉取配置中心失败,使用内置默认值:', e?.message || e);
    }
    __pricingConfigLoaded = true;
  }

  const PANEL_ID = 'xy-pricing-panel';

  // ────────────────────────────────────────────────────────────
  // 状态
  // ────────────────────────────────────────────────────────────
  let panelEl = null;

  // ────────────────────────────────────────────────────────────
  // 面板 HTML 模板(2 tab:定价精灵 + 利润计算)
  // ────────────────────────────────────────────────────────────
  function panelTemplate() {
    return (
      '<div class="xy-pp-panel" id="' +
      PANEL_ID +
      '">' +
      // Header
      '<div class="xy-pp-header">' +
      '<div class="xy-pp-brand-row">' +
      '<span class="xy-pp-brand-mark">M</span>' +
      '<span class="xy-pp-brand-name">MY算价</span>' +
      '<span class="xy-pp-brand-sub">定价 · 利润 · 安全线</span>' +
      '<span class="xy-pp-brand-spacer"></span>' +
      '<button class="xy-pp-close" data-action="close">×</button>' +
      '</div>' +
      '<div class="xy-pp-tabs">' +
      '<button class="xy-pp-tab is-active" data-tab="pricing">定价精灵</button>' +
      '<button class="xy-pp-tab" data-tab="profit">利润计算</button>' +
      '</div>' +
      '</div>' +
      // Content
      '<div class="xy-pp-content">' +
      // Tab 1: 定价精灵
      '<div class="xy-pp-page is-active" data-page="pricing">' +
      '<div class="xy-pp-section">' +
      '<div class="xy-pp-section-title">基础参数</div>' +
      '<div class="xy-pp-grid">' +
      '<label class="xy-pp-field"><span>所属行业</span>' +
      '<select data-pf="p-industry">' +
      '<option value="beauty_mid">美妆(中)</option>' +
      '<option value="beauty_high">美妆(高)</option>' +
      '<option value="electronics">电子</option>' +
      '<option value="apparel">服饰</option>' +
      '<option value="home">家居</option>' +
      '</select></label>' +
      '<label class="xy-pp-field"><span>采购成本 (¥)</span>' +
      '<input type="number" data-pf="p-purchase" value="0" min="0" step="0.01"></label>' +
      '<label class="xy-pp-field"><span>包裹重量 (g)</span>' +
      '<input type="number" data-pf="p-weight" value="50" min="0" step="1"></label>' +
      '<label class="xy-pp-field"><span>毛利 (%)</span>' +
      '<input type="number" data-pf="p-margin" value="20" min="0" step="0.1"></label>' +
      '<label class="xy-pp-field"><span>前台折扣 (%)</span>' +
      '<input type="number" data-pf="p-discount" value="50" min="0" max="100" step="1"></label>' +
      '<label class="xy-pp-field"><span>物流方式</span>' +
      '<select data-pf="p-logistics">' +
      '<option value="xs">XS 小包</option>' +
      '<option value="budget">经济包</option>' +
      '<option value="small">小件</option>' +
      '<option value="big">大件</option>' +
      '</select></label>' +
      '</div>' +
      '<button class="xy-pp-toggle" data-action="toggle-pricing-more">更多设置 ▾</button>' +
      '<div class="xy-pp-more" data-section="pricing-more" style="display:none;">' +
      '<div class="xy-pp-grid">' +
      '<label class="xy-pp-field"><span>境内段运费 (¥)</span>' +
      '<input type="number" data-pf="p-domestic" value="0" min="0" step="0.01"></label>' +
      '<label class="xy-pp-field"><span>广告费 (%)</span>' +
      '<input type="number" data-pf="p-ad" value="0" min="0" step="0.1"></label>' +
      '<label class="xy-pp-field"><span>提现费 (%)</span>' +
      '<input type="number" data-pf="p-withdraw" value="3" min="0" step="0.1"></label>' +
      '<label class="xy-pp-field"><span>退货率 (%)</span>' +
      '<input type="number" data-pf="p-return" value="2" min="0" step="0.1"></label>' +
      '<label class="xy-pp-field"><span>其他费用 (¥)</span>' +
      '<input type="number" data-pf="p-other" value="0" min="0" step="0.01"></label>' +
      '</div>' +
      '</div>' +
      '</div>' +
      // 结果区
      '<div class="xy-pp-result">' +
      '<div class="xy-pp-result-row">' +
      '<span class="xy-pp-result-label">商品原价(折前)</span>' +
      '<span class="xy-pp-result-value" data-pf="r-before">¥0.00</span>' +
      '<span class="xy-pp-result-sub" data-pf="r-before-rub">₽0</span>' +
      '</div>' +
      '<div class="xy-pp-result-row">' +
      '<span class="xy-pp-result-label">商品售价(折后)</span>' +
      '<span class="xy-pp-result-value" data-pf="r-after">¥0.00</span>' +
      '<span class="xy-pp-result-sub" data-pf="r-after-rub">₽0</span>' +
      '</div>' +
      '<div class="xy-pp-result-row xy-pp-result-big">' +
      '<span class="xy-pp-result-label">毛利</span>' +
      '<span class="xy-pp-result-value" data-pf="r-gross">¥0.00</span>' +
      '<span class="xy-pp-result-sub" data-pf="r-margin-pct">0.0%</span>' +
      '</div>' +
      '</div>' +
      // 明细
      '<button class="xy-pp-toggle" data-action="toggle-pricing-detail">计算明细 ▾</button>' +
      '<div class="xy-pp-detail" data-section="pricing-detail" style="display:none;">' +
      '<div class="xy-pp-detail-row"><span>采购成本</span><span data-pf="d-purchase">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>境内运费</span><span data-pf="d-domestic">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>跨境物流</span><span data-pf="d-logistics">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>平台佣金</span><span data-pf="d-commission">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>广告费</span><span data-pf="d-ad">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>提现费</span><span data-pf="d-withdraw">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>退货损耗</span><span data-pf="d-return">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>其他</span><span data-pf="d-other">¥0</span></div>' +
      '</div>' +
      '<div class="xy-pp-note">汇率固定 ¥1 = ₽11.08(mock)</div>' +
      '</div>' +
      // Tab 2: 利润计算
      '<div class="xy-pp-page" data-page="profit">' +
      '<div class="xy-pp-section">' +
      '<div class="xy-pp-section-title">利润计算器</div>' +
      '<div class="xy-pp-grid">' +
      '<label class="xy-pp-field"><span>售价 (¥)</span>' +
      '<input type="number" data-pf="lp-price" value="0" min="0" step="0.01"></label>' +
      '<label class="xy-pp-field"><span>采购成本 (¥)</span>' +
      '<input type="number" data-pf="lp-purchase" value="0" min="0" step="0.01"></label>' +
      '<label class="xy-pp-field"><span>类目佣金</span>' +
      '<select data-pf="lp-commission">' +
      '<option value="beauty_mid">美妆(中) 15%</option>' +
      '<option value="beauty_high">美妆(高) 17%</option>' +
      '<option value="electronics">电子 13%</option>' +
      '<option value="apparel">服饰 14%</option>' +
      '<option value="home">家居 12%</option>' +
      '</select></label>' +
      '<label class="xy-pp-field"><span>包裹重量 (g)</span>' +
      '<input type="number" data-pf="lp-weight" value="50" min="0" step="1"></label>' +
      '<label class="xy-pp-field"><span>跨境物流商</span>' +
      '<select data-pf="lp-logistics">' +
      '<option value="guoo">GUOO</option>' +
      '<option value="cel">CEL</option>' +
      '<option value="xy">兴远</option>' +
      '<option value="zto">ZTO</option>' +
      '<option value="custom">自定义</option>' +
      '</select></label>' +
      '<label class="xy-pp-field" data-section="lp-custom-rate" style="display:none;"><span>自定义费率 (¥/kg)</span>' +
      '<input type="number" data-pf="lp-custom-rate" value="0" min="0" step="0.1"></label>' +
      '<label class="xy-pp-field"><span>国内运费+代贴 (¥)</span>' +
      '<input type="number" data-pf="lp-domestic" value="0" min="0" step="0.01"></label>' +
      '<label class="xy-pp-field"><span>广告费 (%)</span>' +
      '<input type="number" data-pf="lp-ad" value="0" min="0" step="0.1"></label>' +
      '<label class="xy-pp-field"><span>其他 (¥)</span>' +
      '<input type="number" data-pf="lp-other" value="1" min="0" step="0.01"></label>' +
      '</div>' +
      '</div>' +
      '<div class="xy-pp-result">' +
      '<div class="xy-pp-result-row xy-pp-result-big">' +
      '<span class="xy-pp-result-label">利润</span>' +
      '<span class="xy-pp-result-value" data-pf="lr-profit">¥0.00</span>' +
      '<span class="xy-pp-result-sub" data-pf="lr-margin">0.0%</span>' +
      '</div>' +
      '</div>' +
      '<div class="xy-pp-detail">' +
      '<div class="xy-pp-detail-row is-highlight"><span>利润</span><span data-pf="ld-profit">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>采购成本</span><span data-pf="ld-purchase">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>平台佣金</span><span data-pf="ld-commission">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>跨境物流</span><span data-pf="ld-logistics">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>国内运费</span><span data-pf="ld-domestic">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>广告费</span><span data-pf="ld-ad">¥0</span></div>' +
      '<div class="xy-pp-detail-row"><span>其他</span><span data-pf="ld-other">¥0</span></div>' +
      '</div>' +
      '<div class="xy-pp-note" data-pf="lr-exchange-info">汇率 ¥1 = ₽11.08(mock)</div>' +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  // ────────────────────────────────────────────────────────────
  // 工具:读取/写入面板内 data-pf 字段
  // ────────────────────────────────────────────────────────────
  function getValue(panel, k) {
    const el = panel.querySelector('[data-pf="' + k + '"]');
    return Number(el?.value || 0);
  }

  function setText(panel, k, v) {
    const el = panel.querySelector('[data-pf="' + k + '"]');
    if (el) el.textContent = v;
  }

  // ────────────────────────────────────────────────────────────
  // 定价精灵:反算售价(简化 mock 版)
  // ────────────────────────────────────────────────────────────
  function recalcPricing(panel) {
    const purchase = getValue(panel, 'p-purchase');
    const margin = getValue(panel, 'p-margin');
    const discount = getValue(panel, 'p-discount');
    const domestic = getValue(panel, 'p-domestic');
    const logisticsKey = panel.querySelector('[data-pf="p-logistics"]')?.value || 'xs';
    const logisticsCost = LOGISTICS_COST[logisticsKey] || 8;
    const ad = getValue(panel, 'p-ad');
    const withdraw = getValue(panel, 'p-withdraw');
    const ret = getValue(panel, 'p-return');
    const other = getValue(panel, 'p-other');
    const industry = panel.querySelector('[data-pf="p-industry"]')?.value || 'beauty_mid';
    const commissionRate = COMMISSION_RATES[industry] || 0.15;

    const totalCostCny = purchase + domestic + other + logisticsCost;
    const deductionRate = (commissionRate * 100 + ad + withdraw + ret) / 100;
    const marginRate = margin / 100;
    const denom = 1 - deductionRate - marginRate;
    let afterDiscountCny = 0;
    let beforeDiscountCny = 0;
    if (denom > 0.01) {
      afterDiscountCny = totalCostCny / denom;
      beforeDiscountCny = discount > 0 ? afterDiscountCny / (discount / 100) : afterDiscountCny;
    }

    const gross = afterDiscountCny - totalCostCny;
    const marginPct = afterDiscountCny > 0 ? (gross / afterDiscountCny) * 100 : 0;
    const commissionCny = afterDiscountCny * commissionRate;
    const adCny = (afterDiscountCny * ad) / 100;
    const withdrawCny = (afterDiscountCny * withdraw) / 100;
    const returnCny = (afterDiscountCny * ret) / 100;

    setText(panel, 'r-before', '¥' + beforeDiscountCny.toFixed(2));
    setText(panel, 'r-before-rub', '₽' + (beforeDiscountCny * RATE_RUB).toFixed(0));
    setText(panel, 'r-after', '¥' + afterDiscountCny.toFixed(2));
    setText(panel, 'r-after-rub', '₽' + (afterDiscountCny * RATE_RUB).toFixed(0));
    const grossEl = panel.querySelector('[data-pf="r-gross"]');
    if (grossEl) {
      grossEl.textContent = '¥' + gross.toFixed(2);
      grossEl.className = 'xy-pp-result-value ' + (gross > 0 ? 'is-profit' : gross < 0 ? 'is-loss' : 'is-muted');
    }
    setText(panel, 'r-margin-pct', marginPct.toFixed(1) + '%');
    setText(panel, 'd-purchase', '¥' + purchase.toFixed(2));
    setText(panel, 'd-domestic', '¥' + domestic.toFixed(2));
    setText(panel, 'd-logistics', '¥' + logisticsCost.toFixed(2));
    setText(panel, 'd-commission', '¥' + commissionCny.toFixed(2));
    setText(panel, 'd-ad', '¥' + adCny.toFixed(2));
    setText(panel, 'd-withdraw', '¥' + withdrawCny.toFixed(2));
    setText(panel, 'd-return', '¥' + returnCny.toFixed(2));
    setText(panel, 'd-other', '¥' + other.toFixed(2));
  }

  // ────────────────────────────────────────────────────────────
  // 利润计算:正算利润(简化 mock 版)
  // ────────────────────────────────────────────────────────────
  function recalcProfitCalc(panel) {
    const price = getValue(panel, 'lp-price');
    const purchase = getValue(panel, 'lp-purchase');
    const industry = panel.querySelector('[data-pf="lp-commission"]')?.value || 'beauty_mid';
    const commissionRate = COMMISSION_RATES[industry] || 0.15;
    const weight = getValue(panel, 'lp-weight');
    const logisticsKey = panel.querySelector('[data-pf="lp-logistics"]')?.value || 'guoo';
    let logisticsCost;
    if (logisticsKey === 'custom') {
      logisticsCost = (weight / 1000) * getValue(panel, 'lp-custom-rate');
    } else {
      logisticsCost = weight * (PROFIT_LOGISTICS[logisticsKey] || 0.06);
    }
    const domestic = getValue(panel, 'lp-domestic');
    const ad = getValue(panel, 'lp-ad');
    const other = getValue(panel, 'lp-other');

    const commission = price * commissionRate;
    const adCost = (price * ad) / 100;
    const profit = price - purchase - commission - logisticsCost - domestic - adCost - other;
    const margin = price > 0 ? (profit / price) * 100 : 0;

    const profitEl = panel.querySelector('[data-pf="lr-profit"]');
    if (profitEl) {
      profitEl.textContent = '¥' + profit.toFixed(2);
      profitEl.className = 'xy-pp-result-value ' + (profit > 0 ? 'is-profit' : profit < 0 ? 'is-loss' : 'is-muted');
    }
    setText(panel, 'lr-margin', margin.toFixed(1) + '%');
    setText(panel, 'ld-profit', '¥' + profit.toFixed(2));
    setText(panel, 'ld-purchase', '¥' + purchase.toFixed(2));
    setText(panel, 'ld-commission', '¥' + commission.toFixed(2));
    setText(panel, 'ld-logistics', '¥' + logisticsCost.toFixed(2));
    setText(panel, 'ld-domestic', '¥' + domestic.toFixed(2));
    setText(panel, 'ld-ad', '¥' + adCost.toFixed(2));
    setText(panel, 'ld-other', '¥' + other.toFixed(2));
  }

  // ────────────────────────────────────────────────────────────
  // 根据当前激活 tab 重算
  // ────────────────────────────────────────────────────────────
  function recalcActiveTab(panel) {
    const activePage = panel.querySelector('.xy-pp-page.is-active');
    if (!activePage) return;
    if (activePage.dataset.page === 'pricing') {
      recalcPricing(panel);
    } else if (activePage.dataset.page === 'profit') {
      recalcProfitCalc(panel);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 切换 tab
  // ────────────────────────────────────────────────────────────
  function switchTab(panel, tabName) {
    panel.querySelectorAll('.xy-pp-tab').forEach((t) => {
      t.classList.toggle('is-active', t.dataset.tab === tabName);
    });
    panel.querySelectorAll('.xy-pp-page').forEach((p) => {
      p.classList.toggle('is-active', p.dataset.page === tabName);
    });
    recalcActiveTab(panel);
  }

  // ────────────────────────────────────────────────────────────
  // 折叠区切换
  // ────────────────────────────────────────────────────────────
  function toggleSection(panel, sectionName) {
    const sec = panel.querySelector('[data-section="' + sectionName + '"]');
    if (!sec) return;
    sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
  }

  // ────────────────────────────────────────────────────────────
  // 自定义物流费率联动
  // ────────────────────────────────────────────────────────────
  function syncCustomLogistics(panel) {
    const sel = panel.querySelector('[data-pf="lp-logistics"]');
    const customWrap = panel.querySelector('[data-section="lp-custom-rate"]');
    if (!sel || !customWrap) return;
    customWrap.style.display = sel.value === 'custom' ? 'flex' : 'none';
  }

  // ────────────────────────────────────────────────────────────
  // 事件绑定(委托)
  // ────────────────────────────────────────────────────────────
  function bindEvents(panel) {
    // 输入变化 → 重算当前 tab
    panel.addEventListener('input', () => recalcActiveTab(panel));
    panel.addEventListener('change', () => recalcActiveTab(panel));

    // 点击事件委托
    panel.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');
      switch (action) {
        case 'close':
          hide();
          break;
        case 'toggle-pricing-more':
          toggleSection(panel, 'pricing-more');
          break;
        case 'toggle-pricing-detail':
          toggleSection(panel, 'pricing-detail');
          break;
        default:
          break;
      }
    });

    // tab 切换
    panel.querySelectorAll('.xy-pp-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(panel, tab.dataset.tab));
    });

    // 利润计算:物流商切换 → 自定义费率联动
    const lpLogistics = panel.querySelector('[data-pf="lp-logistics"]');
    if (lpLogistics) {
      lpLogistics.addEventListener('change', () => {
        syncCustomLogistics(panel);
      });
    }
  }

  // ────────────────────────────────────────────────────────────
  // 创建并挂载面板
  // ────────────────────────────────────────────────────────────
  function buildPanel() {
    const panel = document.createElement('div');
    panel.innerHTML = panelTemplate();
    const root = panel.firstElementChild;
    bindEvents(root);
    // 初始重算两个 tab
    recalcPricing(root);
    recalcProfitCalc(root);
    syncCustomLogistics(root);
    return root;
  }

  // ────────────────────────────────────────────────────────────
  // 显示 / 隐藏
  // ────────────────────────────────────────────────────────────
  function show() {
    if (!panelEl) return;
    panelEl.style.display = 'block';
    // 重新触发 slide-in 动画
    panelEl.classList.remove('is-anim');
    void panelEl.offsetWidth;
    panelEl.classList.add('is-anim');
  }

  function hide() {
    if (!panelEl) return;
    panelEl.style.display = 'none';
  }

  // ────────────────────────────────────────────────────────────
  // mount / unmount / toggle
  // ────────────────────────────────────────────────────────────
  async function mount() {
    if (panelEl) {
      // 已挂载则 toggle 显示
      show();
      return;
    }
    // 首次挂载:从 ERP 配置中心拉取 pricing scope 覆盖默认常量
    await loadPricingConfig();
    panelEl = buildPanel();
    document.body.appendChild(panelEl);
    panelEl.classList.add('is-anim');
  }

  function unmount() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
  }

  function toggle() {
    if (!panelEl) {
      mount();
      return;
    }
    if (panelEl.style.display === 'none') {
      show();
    } else {
      hide();
    }
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API
  // ────────────────────────────────────────────────────────────
  self.JZPricingPanel = {
    mount,
    unmount,
    toggle,
  };
})();
