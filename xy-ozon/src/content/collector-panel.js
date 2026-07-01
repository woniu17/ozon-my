// 采集器浮动面板 + 智能筛选弹窗 —— 从原项目 0.13.31.1 抽离的 Demo。
// ERP / 后端用 mock,采集数据用内存 Map;UI 完整复刻原项目视觉与交互。
// 所有 class / localStorage key / 全局变量均用 `xy-cp-` 前缀。

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 常量 / localStorage key
  // ────────────────────────────────────────────────────────────
  const LS_COLLAPSED = 'xy-cp-collapsed';
  const LS_KW_MAX = 'xy-cp-kw-max';
  const LS_SALES_FILTER = 'xy-cp-sales-filter';
  const LS_SMART_FILTER = 'xy-cp-smart-filter-state';
  const DEFAULT_TEMPLATE_ID = 'smart-filter-default';

  // ────────────────────────────────────────────────────────────
  // 内存 mock 桶(替代 IndexedDB)
  // ────────────────────────────────────────────────────────────
  const bucket = new Map(); // 商品 key -> data
  const kwBucket = new Map(); // 关键词采集结果

  // 运行时状态
  let running = false;
  let kwRunning = false;
  let stats = { success: 0, running: 0, failed: 0 };
  let kwStats = { collected: 0 };
  let pushedCount = 0;

  // ────────────────────────────────────────────────────────────
  // 智能筛选字段定义(19 数值 + 品牌 + 物流 = 21 条件)
  // 物流行在 displayConversionRate 之后插入(见 buildFilterTable)
  // ────────────────────────────────────────────────────────────
  const NUMERIC_FIELDS = [
    { key: 'soldCount', label: '月销量' },
    { key: 'gmvSum', label: '月销售额范围', prefix: '¥' },
    { key: 'price', label: '价格范围', prefix: '¥' },
    { key: 'weight', label: '重量范围', suffix: 'g' },
    { key: 'listedDays', label: '上架时间', suffix: '天' },
    { key: 'monthlyTurnoverDynamic', label: '月周转动态', suffix: '%' },
    { key: 'adCostRatio', label: '广告费占比', suffix: '%' },
    { key: 'promoDays', label: '参与促销天数', suffix: '天' },
    { key: 'promoDiscount', label: '参与促销的折扣', suffix: '%' },
    { key: 'promoConversionRate', label: '促销活动的转化率', suffix: '%' },
    { key: 'paidPromotionDays', label: '付费推广天数', suffix: '天' },
    { key: 'views', label: '商品卡浏览量' },
    { key: 'cardAddToCartRate', label: '商品卡加购率', suffix: '%' },
    { key: 'searchCatalogViews', label: '搜索目录浏览量' },
    { key: 'searchCatalogAddToCartRate', label: '搜索目录加购率', suffix: '%' },
    { key: 'displayConversionRate', label: '展示转化率', suffix: '%' },
    // 物流行在此之后插入
    { key: 'returnCancelRate', label: '退货取消率', suffix: '%' },
    { key: 'followerCount', label: '跟卖人数', suffix: '人' },
    { key: 'lowestFollowerPrice', label: '跟卖最低价' },
  ];

  // 字段 fallback 映射(用于 smartGetDataField)
  const FIELD_FALLBACKS = {
    soldCount: ['soldCount', 'info.soldCount', 'sales30d'],
    gmvSum: ['gmvSumCny', 'revenue30dCny', 'revenue30d'],
    price: ['price', 'info.price', 'avgPrice'],
    weight: ['weightG', 'weight', 'info.weightG'],
    listedDays: ['listedDays', 'info.listedDays', 'daysListed'],
    monthlyTurnoverDynamic: ['monthlyTurnoverDynamic', 'turnoverRate', 'info.monthlyTurnoverDynamic'],
    adCostRatio: ['adCostRatio', 'adSpendRatio', 'info.adCostRatio'],
    promoDays: ['promoDays', 'promoDaysCount', 'info.promoDays'],
    promoDiscount: ['promoDiscount', 'discountRate', 'info.promoDiscount'],
    promoConversionRate: ['promoConversionRate', 'promoCvr', 'info.promoConversionRate'],
    paidPromotionDays: ['paidPromotionDays', 'paidPromoDays', 'info.paidPromotionDays'],
    views: ['views', 'cardViews', 'info.views'],
    cardAddToCartRate: ['cardAddToCartRate', 'cardCartRate', 'info.cardAddToCartRate'],
    searchCatalogViews: ['searchCatalogViews', 'catalogViews', 'info.searchCatalogViews'],
    searchCatalogAddToCartRate: ['searchCatalogAddToCartRate', 'catalogCartRate', 'info.searchCatalogAddToCartRate'],
    displayConversionRate: ['displayConversionRate', 'displayCvr', 'info.displayConversionRate'],
    returnCancelRate: ['returnCancelRate', 'returnRate', 'info.returnCancelRate'],
    followerCount: ['followerCount', 'info.followCount', 'followCount'],
    lowestFollowerPrice: ['lowestFollowerPrice', 'minFollowerPrice', 'info.lowestFollowerPrice'],
  };

  // ────────────────────────────────────────────────────────────
  // 默认模板
  // ────────────────────────────────────────────────────────────
  function makeDefaultTemplate() {
    const conditions = {};
    for (const f of NUMERIC_FIELDS) {
      conditions[f.key] = { min: '', max: '' };
    }
    return {
      id: DEFAULT_TEMPLATE_ID,
      name: '默认模板',
      conditions,
      brandOption: 'any',
      shippingMode: 'any',
    };
  }

  // ────────────────────────────────────────────────────────────
  // 智能筛选状态(从 localStorage 加载)
  // ────────────────────────────────────────────────────────────
  let smartFilterState = loadSmartFilter();

  function loadSmartFilter() {
    try {
      const raw = localStorage.getItem(LS_SMART_FILTER);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.templates) && parsed.templates.length) {
          // 确保默认模板存在
          if (!parsed.templates.find((t) => t.id === DEFAULT_TEMPLATE_ID)) {
            parsed.templates.unshift(makeDefaultTemplate());
          }
          if (!parsed.currentTemplateId || !parsed.templates.find((t) => t.id === parsed.currentTemplateId)) {
            parsed.currentTemplateId = DEFAULT_TEMPLATE_ID;
          }
          parsed.enabled = !!parsed.enabled;
          return parsed;
        }
      }
    } catch (e) {
      // ignore
    }
    return {
      enabled: false,
      templates: [makeDefaultTemplate()],
      currentTemplateId: DEFAULT_TEMPLATE_ID,
    };
  }

  function saveSmartFilter() {
    try {
      localStorage.setItem(LS_SMART_FILTER, JSON.stringify(smartFilterState));
    } catch (e) {
      // ignore
    }
  }

  function smartCurrentTemplate() {
    return (
      smartFilterState.templates.find((t) => t.id === smartFilterState.currentTemplateId) ||
      smartFilterState.templates[0]
    );
  }

  // 识别品牌空值('-' / '无' / '无品牌' / 'без бренда' 等视为无品牌)
  function smartHasBrand(data) {
    const v = data ? (data.brand ?? data.brandName ?? (data.info ? data.info.brand : undefined)) : undefined;
    if (v == null) return null; // 未知
    const s = String(v).trim().toLowerCase();
    if (!s) return false;
    if (['-', '无', '无品牌', 'без бренда', 'no brand', 'nobrand', 'none'].includes(s)) return false;
    return true;
  }

  // 取字段值(带 fallback)。paths 形如 ['price', 'info.price', 'avgPrice']
  function smartGetDataField(data, key, info) {
    const paths = FIELD_FALLBACKS[key] || [key];
    for (const p of paths) {
      let v;
      if (p.startsWith('info.')) {
        v = info ? info[p.slice(5)] : undefined;
      } else {
        v = data ? data[p] : undefined;
      }
      if (v != null && v !== '') return v;
    }
    return null;
  }

  function smartMatchesFieldValue(val, cfg) {
    if (!cfg) return true;
    const min = cfg.min === '' || cfg.min == null ? null : Number(cfg.min);
    const max = cfg.max === '' || cfg.max == null ? null : Number(cfg.max);
    if (min == null && max == null) return true;
    if (val == null) return false; // 字段缺失
    const n = Number(val);
    if (Number.isNaN(n)) return false;
    if (min != null && n < min) return false;
    if (max != null && n > max) return false;
    return true;
  }

  function smartMatches(data, info) {
    if (!smartFilterState.enabled) return true;
    const tpl = smartCurrentTemplate();
    if (!tpl) return true;

    // 1. brandOption: branded / noBrand / any
    const hasBrand = smartHasBrand(data);
    if (tpl.brandOption === 'branded' && hasBrand === false) return false;
    if (tpl.brandOption === 'noBrand' && hasBrand === true) return false;

    // 2. shippingMode: 从多个字段取值,转大写比对
    if (tpl.shippingMode && tpl.shippingMode !== 'any') {
      const sources = [
        data ? data.shippingMode : undefined,
        data ? data.deliverySchema : undefined,
        data ? data.deliveryType : undefined,
        data ? data.salesSchema : undefined,
        data && Array.isArray(data.sources) ? data.sources : [],
      ];
      const matched = sources.some(
        (s) => s != null && String(s).toUpperCase() === String(tpl.shippingMode).toUpperCase()
      );
      if (!matched) return false;
    }

    // 3. 遍历数值条件
    const c = tpl.conditions || {};
    for (const f of NUMERIC_FIELDS) {
      const cfg = c[f.key];
      if (!cfg) continue;
      if ((cfg.min === '' || cfg.min == null) && (cfg.max === '' || cfg.max == null)) continue;
      const val = smartGetDataField(data, f.key, info);
      if (!smartMatchesFieldValue(val, cfg)) return false;
    }
    return true;
  }

  function smartGetMissingFields(data, info) {
    const missing = [];
    if (smartGetDataField(data, 'price', info) == null) missing.push('price');
    return missing;
  }

  // ────────────────────────────────────────────────────────────
  // DOM 工具
  // ────────────────────────────────────────────────────────────
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else node.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function logoSvg() {
    return (
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="4" fill="#fff"/>' +
      '<rect x="8" y="8" width="8" height="8" rx="1.5" fill="rgb(232,77,146)"/>' +
      '</svg>'
    );
  }

  // ────────────────────────────────────────────────────────────
  // 持久化辅助
  // ────────────────────────────────────────────────────────────
  function loadKwMax() {
    const v = parseInt(localStorage.getItem(LS_KW_MAX), 10);
    return Number.isFinite(v) && v > 0 ? v : 200;
  }
  function saveKwMax(v) {
    localStorage.setItem(LS_KW_MAX, String(v));
  }
  function loadSalesFilter() {
    return localStorage.getItem(LS_SALES_FILTER) === '1';
  }
  function saveSalesFilter(on) {
    localStorage.setItem(LS_SALES_FILTER, on ? '1' : '0');
  }
  function loadCollapsed() {
    return localStorage.getItem(LS_COLLAPSED) === '1';
  }
  function saveCollapsed(on) {
    if (on) localStorage.setItem(LS_COLLAPSED, '1');
    else localStorage.removeItem(LS_COLLAPSED);
  }

  // ────────────────────────────────────────────────────────────
  // Toast
  // ────────────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, type = 'default') {
    if (!panelEl) return;
    const t = panelEl.querySelector('[data-el="toast"]');
    if (!t) return;
    t.textContent = msg;
    t.className = 'xy-cp-toast';
    if (type === 'error') t.classList.add('is-error');
    else if (type === 'success') t.classList.add('is-success');
    t.classList.remove('xy-cp-hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.add('xy-cp-hidden');
    }, 2500);
  }

  // ────────────────────────────────────────────────────────────
  // 面板 DOM 构建(9 段,自上而下)
  // ────────────────────────────────────────────────────────────
  let panelEl = null; // .xy-cp-panel
  let bubbleEl = null; // .xy-cp-bubble

  function buildPanel() {
    const salesFilter = loadSalesFilter();
    const kwMax = loadKwMax();
    const root = el('div', { class: 'xy-cp-panel', 'data-role': 'panel' });
    root.innerHTML =
      '<div class="xy-cp-header">' +
      '<div class="xy-cp-brand"><span class="xy-cp-logo">' +
      logoSvg() +
      '</span><span>MY采集器</span></div>' +
      '<button class="xy-cp-icon-btn" data-act="collapse" title="折叠" type="button">—</button>' +
      '</div>' +
      '<div class="xy-cp-status-row">' +
      '<div class="xy-cp-status"><span class="xy-cp-status-dot"></span>' +
      '<span class="xy-cp-status-text" data-el="status-text">未启动</span></div>' +
      '<button class="xy-cp-btn xy-cp-btn-sm" data-act="toggle" type="button">启动采集</button>' +
      '</div>' +
      '<div class="xy-cp-progress">' +
      '<div class="xy-cp-stat"><div class="xy-cp-stat-num" data-el="stat-success">0</div>' +
      '<div class="xy-cp-stat-label">成功</div></div>' +
      '<div class="xy-cp-stat"><div class="xy-cp-stat-num" data-el="stat-running">0</div>' +
      '<div class="xy-cp-stat-label">进行中</div></div>' +
      '<div class="xy-cp-stat is-failed"><div class="xy-cp-stat-num" data-el="stat-failed">0</div>' +
      '<div class="xy-cp-stat-label">失败 <a class="xy-cp-link" data-act="retry-failures" href="javascript:void(0)">重试</a></div></div>' +
      '</div>' +
      '<div class="xy-cp-row">' +
      '<label class="xy-cp-check"><input type="checkbox" data-act="auto-scroll-toggle"> 自动翻页</label>' +
      '<label class="xy-cp-check"><input type="checkbox" data-act="sales-filter"' +
      (salesFilter ? ' checked' : '') +
      '> 仅抓有销量</label>' +
      '</div>' +
      '<div class="xy-cp-filter-entry">' +
      '<strong>智能筛选</strong>' +
      '<span class="xy-cp-filter-summary" data-el="filter-summary">未启用</span>' +
      '<button class="xy-cp-btn-ghost xy-cp-btn-sm" data-act="filter-open" type="button">筛选设置</button>' +
      '</div>' +
      '<details class="xy-cp-section">' +
      '<summary>关键词采集器</summary>' +
      '<div class="xy-cp-section-body">' +
      '<textarea class="xy-cp-textarea" data-el="kw-input" rows="3" placeholder="一行一个关键词"></textarea>' +
      '<div class="xy-cp-kw-controls">' +
      '<span>上限</span>' +
      '<input class="xy-cp-input xy-cp-input-sm" data-el="kw-max" type="number" min="1" value="' +
      kwMax +
      '">' +
      '<button class="xy-cp-btn xy-cp-btn-sm" data-act="kw-start" type="button">开始</button>' +
      '<button class="xy-cp-btn-ghost xy-cp-btn-sm" data-act="kw-stop" type="button">停止</button>' +
      '<button class="xy-cp-btn-ghost xy-cp-btn-sm" data-act="kw-clear" type="button">清空</button>' +
      '</div>' +
      '<div class="xy-cp-pill" data-el="kw-pill">已采集 0/' +
      kwMax +
      '</div>' +
      '</div>' +
      '</details>' +
      '<div class="xy-cp-bucket">' +
      '<span>已采集 <strong data-el="bucket-count">0</strong> 个商品</span>' +
      '<span class="xy-cp-pushed" data-el="pushed-info">未推送</span>' +
      '</div>' +
      '<div class="xy-cp-actions">' +
      '<div class="xy-cp-actions-row">' +
      '<button class="xy-cp-btn-ghost xy-cp-btn-sm" data-act="export-csv" type="button">导出 CSV</button>' +
      '<button class="xy-cp-btn-danger-ghost xy-cp-btn-sm" data-act="clear" type="button">清空</button>' +
      '</div>' +
      '<button class="xy-cp-btn" data-act="push" type="button">推送到候选池</button>' +
      '</div>' +
      '<div class="xy-cp-toast xy-cp-hidden" data-el="toast"></div>';
    return root;
  }

  function buildBubble() {
    const b = el('div', { class: 'xy-cp-bubble', 'data-role': 'bubble' });
    b.innerHTML =
      '<span class="xy-cp-bubble-logo">' +
      logoSvg() +
      '</span>' +
      '<span class="xy-cp-badge xy-cp-hidden" data-el="badge">0</span>';
    return b;
  }

  // ────────────────────────────────────────────────────────────
  // 智能筛选弹窗
  // ────────────────────────────────────────────────────────────
  let modalEl = null; // .xy-cp-filter-mask

  function openFilterModal() {
    if (modalEl) return;
    modalEl = el('div', { class: 'xy-cp-filter-mask', 'data-role': 'filter-mask' });
    modalEl.innerHTML =
      '<div class="xy-cp-filter-modal">' +
      '<div class="xy-cp-filter-head"><h3>编辑选品规则</h3>' +
      '<button class="xy-cp-icon-btn" data-act="filter-close" type="button">×</button></div>' +
      '<div class="xy-cp-filter-toolbar">' +
      '<label class="xy-cp-check"><input type="checkbox" data-field="enabled"' +
      (smartFilterState.enabled ? ' checked' : '') +
      '> 启用</label>' +
      '<select class="xy-cp-select" data-el="filter-template"></select>' +
      '<button class="xy-cp-btn-ghost xy-cp-btn-sm" data-act="filter-add" type="button">新增</button>' +
      '<button class="xy-cp-btn-ghost xy-cp-btn-sm" data-act="filter-rename" type="button">重命名</button>' +
      '<button class="xy-cp-btn-danger-ghost xy-cp-btn-sm" data-act="filter-delete" type="button">删除</button>' +
      '</div>' +
      '<div class="xy-cp-filter-table" data-el="filter-table"></div>' +
      '<div class="xy-cp-filter-foot">' +
      '<button class="xy-cp-btn-ghost" data-act="filter-close" type="button">取消</button>' +
      '<button class="xy-cp-btn-danger-ghost" data-act="filter-reset" type="button">重置为空</button>' +
      '<button class="xy-cp-btn" data-act="filter-save" type="button">保存</button>' +
      '</div>' +
      '</div>';
    document.body.append(modalEl);
    modalEl.addEventListener('click', onModalClick);
    modalEl.addEventListener('change', onModalChange);
    refreshTemplateSelect();
    renderFilterTable();
  }

  function closeFilterModal() {
    if (!modalEl) return;
    modalEl.remove();
    modalEl = null;
  }

  function refreshTemplateSelect() {
    if (!modalEl) return;
    const sel = modalEl.querySelector('[data-el="filter-template"]');
    if (!sel) return;
    sel.innerHTML = smartFilterState.templates
      .map((t) => '<option value="' + t.id + '">' + t.name + '</option>')
      .join('');
    sel.value = smartFilterState.currentTemplateId;
  }

  function renderFilterTable() {
    if (!modalEl) return;
    const table = modalEl.querySelector('[data-el="filter-table"]');
    if (!table) return;
    table.innerHTML = '';
    const tpl = smartCurrentTemplate();

    // 品牌行(置顶)
    table.append(buildBrandRow(tpl.brandOption || 'any'));

    // 数值字段(在 displayConversionRate 之后插入物流行)
    for (const f of NUMERIC_FIELDS) {
      const cfg = (tpl.conditions && tpl.conditions[f.key]) || { min: '', max: '' };
      table.append(buildNumericRow(f, cfg));
      if (f.key === 'displayConversionRate') {
        table.append(buildShippingRow(tpl.shippingMode || 'any'));
      }
    }
  }

  function buildNumericRow(f, cfg) {
    const row = el('div', { class: 'xy-cp-filter-row', 'data-field': f.key });
    row.append(el('label', { class: 'xy-cp-filter-label' }, f.label));

    // 最小值 cell
    const minCell = el('div', { class: 'xy-cp-filter-cell' });
    if (f.prefix) minCell.append(el('span', { class: 'xy-cp-filter-unit' }, f.prefix));
    minCell.append(
      el('input', {
        class: 'xy-cp-filter-input',
        type: 'number',
        'data-side': 'min',
        value: cfg.min == null ? '' : String(cfg.min),
        placeholder: '最小',
      })
    );
    if (f.suffix) minCell.append(el('span', { class: 'xy-cp-filter-unit' }, f.suffix));

    const sep = el('span', { class: 'xy-cp-filter-sep' }, '至');

    // 最大值 cell
    const maxCell = el('div', { class: 'xy-cp-filter-cell' });
    if (f.prefix) maxCell.append(el('span', { class: 'xy-cp-filter-unit' }, f.prefix));
    maxCell.append(
      el('input', {
        class: 'xy-cp-filter-input',
        type: 'number',
        'data-side': 'max',
        value: cfg.max == null ? '' : String(cfg.max),
        placeholder: '最大',
      })
    );
    if (f.suffix) maxCell.append(el('span', { class: 'xy-cp-filter-unit' }, f.suffix));

    row.append(minCell, sep, maxCell);
    return row;
  }

  function buildBrandRow(value) {
    const row = el('div', { class: 'xy-cp-filter-row is-brand', 'data-field': 'brandOption' });
    row.append(el('label', { class: 'xy-cp-filter-label' }, '品牌'));
    const options = [
      { v: 'branded', label: '有品牌' },
      { v: 'noBrand', label: '无品牌' },
      { v: 'any', label: '不限' },
    ];
    for (const opt of options) {
      const lab = el('label', { class: 'xy-cp-radio' });
      const input = el('input', {
        type: 'radio',
        name: 'brand-option',
        value: opt.v,
        'data-side': 'value',
      });
      if (opt.v === value) input.checked = true;
      lab.append(input, document.createTextNode(opt.label));
      row.append(lab);
    }
    return row;
  }

  function buildShippingRow(value) {
    const row = el('div', { class: 'xy-cp-filter-row is-select', 'data-field': 'shippingMode' });
    row.append(el('label', { class: 'xy-cp-filter-label' }, '物流'));
    const select = el('select', { class: 'xy-cp-filter-select', 'data-side': 'value' });
    const options = [
      { v: 'any', label: '不限' },
      { v: 'FBS', label: 'FBS' },
      { v: 'FBO', label: 'FBO' },
    ];
    for (const opt of options) {
      const o = el('option', { value: opt.v }, opt.label);
      if (opt.v === value) o.selected = true;
      select.append(o);
    }
    row.append(el('div', { class: 'xy-cp-filter-cell' }, select));
    return row;
  }

  // 读取弹窗表单 -> { conditions, brandOption, shippingMode }
  function readFilterForm() {
    if (!modalEl) return null;
    const table = modalEl.querySelector('[data-el="filter-table"]');
    if (!table) return null;
    const tpl = smartCurrentTemplate();
    const conditions = {};
    for (const f of NUMERIC_FIELDS) {
      const old = (tpl.conditions && tpl.conditions[f.key]) || { min: '', max: '' };
      conditions[f.key] = { min: old.min ?? '', max: old.max ?? '' };
    }
    let brandOption = tpl.brandOption || 'any';
    let shippingMode = tpl.shippingMode || 'any';

    const rows = table.querySelectorAll('.xy-cp-filter-row');
    rows.forEach((row) => {
      const field = row.getAttribute('data-field');
      if (row.classList.contains('is-brand')) {
        const checked = row.querySelector('input[type="radio"]:checked');
        if (checked) brandOption = checked.value;
      } else if (row.classList.contains('is-select')) {
        const sel = row.querySelector('select');
        if (sel) shippingMode = sel.value;
      } else if (field) {
        const min = row.querySelector('[data-side="min"]');
        const max = row.querySelector('[data-side="max"]');
        conditions[field] = {
          min: min ? min.value : '',
          max: max ? max.value : '',
        };
      }
    });
    return { conditions, brandOption, shippingMode };
  }

  function applyFilterFormToCurrent() {
    const data = readFilterForm();
    if (!data) return;
    const tpl = smartCurrentTemplate();
    if (!tpl) return;
    tpl.conditions = data.conditions;
    tpl.brandOption = data.brandOption;
    tpl.shippingMode = data.shippingMode;
    saveSmartFilter();
    refreshFilterSummary();
  }

  function refreshFilterSummary() {
    if (!panelEl) return;
    const sum = panelEl.querySelector('[data-el="filter-summary"]');
    if (!sum) return;
    if (!smartFilterState.enabled) {
      sum.textContent = '未启用';
      return;
    }
    const tpl = smartCurrentTemplate();
    let active = 0;
    const c = (tpl && tpl.conditions) || {};
    for (const f of NUMERIC_FIELDS) {
      const cfg = c[f.key];
      if (!cfg) continue;
      if ((cfg.min !== '' && cfg.min != null) || (cfg.max !== '' && cfg.max != null)) active++;
    }
    if (tpl && tpl.brandOption && tpl.brandOption !== 'any') active++;
    if (tpl && tpl.shippingMode && tpl.shippingMode !== 'any') active++;
    sum.textContent = (tpl ? tpl.name : '默认模板') + ' · ' + active + ' 个条件';
  }

  // ────────────────────────────────────────────────────────────
  // 模板管理
  // ────────────────────────────────────────────────────────────
  function genTemplateId() {
    return Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  function resetCurrentTemplate() {
    const tpl = smartCurrentTemplate();
    if (!tpl) return;
    const conditions = {};
    for (const f of NUMERIC_FIELDS) {
      conditions[f.key] = { min: '', max: '' };
    }
    tpl.conditions = conditions;
    tpl.brandOption = 'any';
    tpl.shippingMode = 'any';
    saveSmartFilter();
    renderFilterTable();
    showToast('已重置为空', 'success');
  }

  function addTemplate() {
    const cur = smartCurrentTemplate();
    // 复制当前模板的条件
    const conditions = {};
    for (const f of NUMERIC_FIELDS) {
      const c = (cur && cur.conditions && cur.conditions[f.key]) || { min: '', max: '' };
      conditions[f.key] = { min: c.min ?? '', max: c.max ?? '' };
    }
    // 名字自动避免重名:新模板 / 新模板 1 / 新模板 2 ...
    const exist = new Set(smartFilterState.templates.map((t) => t.name));
    let name = '新模板';
    let i = 1;
    while (exist.has(name)) {
      name = '新模板 ' + i++;
    }
    const t = {
      id: genTemplateId(),
      name,
      conditions,
      brandOption: (cur && cur.brandOption) || 'any',
      shippingMode: (cur && cur.shippingMode) || 'any',
    };
    smartFilterState.templates.push(t);
    smartFilterState.currentTemplateId = t.id;
    saveSmartFilter();
    refreshTemplateSelect();
    renderFilterTable();
    showToast('已新增模板「' + name + '」', 'success');
  }

  function renameTemplate() {
    const tpl = smartCurrentTemplate();
    if (!tpl) return;
    if (tpl.id === DEFAULT_TEMPLATE_ID) {
      showToast('默认模板不可重命名', 'error');
      return;
    }
    const name = window.prompt('请输入模板名称(最多 40 字符)', tpl.name);
    if (name == null) return;
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) {
      showToast('名称不能为空', 'error');
      return;
    }
    tpl.name = trimmed;
    saveSmartFilter();
    refreshTemplateSelect();
    showToast('已重命名', 'success');
  }

  function deleteTemplate() {
    const tpl = smartCurrentTemplate();
    if (!tpl) return;
    if (tpl.id === DEFAULT_TEMPLATE_ID) {
      showToast('默认模板不可删除', 'error');
      return;
    }
    if (!window.confirm('确认删除模板「' + tpl.name + '」?')) return;
    const idx = smartFilterState.templates.findIndex((t) => t.id === tpl.id);
    if (idx >= 0) smartFilterState.templates.splice(idx, 1);
    smartFilterState.currentTemplateId = DEFAULT_TEMPLATE_ID;
    saveSmartFilter();
    refreshTemplateSelect();
    renderFilterTable();
    showToast('已删除模板', 'success');
  }

  // ────────────────────────────────────────────────────────────
  // Mock 行为
  // ────────────────────────────────────────────────────────────
  function toggleRunning() {
    running = !running;
    updateStatus();
    if (running) showToast('采集已启动(mock)', 'success');
    else showToast('采集已暂停(mock)');
  }

  function updateStatus() {
    if (!panelEl) return;
    const dot = panelEl.querySelector('.xy-cp-status-dot');
    const txt = panelEl.querySelector('[data-el="status-text"]');
    const btn = panelEl.querySelector('[data-act="toggle"]');
    if (!dot || !txt || !btn) return;
    dot.classList.remove('is-running', 'is-paused');
    if (running) {
      dot.classList.add('is-running');
      txt.textContent = '采集中';
      btn.textContent = '暂停采集';
    } else {
      dot.classList.add('is-paused');
      txt.textContent = '已暂停';
      btn.textContent = '启动采集';
    }
  }

  function retryFailures() {
    const n = stats.failed;
    if (!n) {
      showToast('没有失败任务');
      return;
    }
    showToast('已重试 ' + n + ' 个失败任务(mock)', 'success');
    stats.running += n;
    stats.failed = 0;
    refreshStats();
  }

  function exportCsv() {
    showToast('已导出 ' + bucket.size + ' 条(mock)', 'success');
  }

  function clearBucket() {
    if (!bucket.size) {
      showToast('桶为空');
      return;
    }
    if (!window.confirm('确认清空 ' + bucket.size + ' 个商品?')) return;
    bucket.clear();
    refreshBucket();
    showToast('已清空(mock)', 'success');
  }

  function pushToCandidate() {
    if (!bucket.size) {
      showToast('桶为空,无法推送', 'error');
      return;
    }
    const n = bucket.size;
    pushedCount += n;
    showToast('已推送 ' + n + ' 个商品到候选池(mock)', 'success');
    if (panelEl) {
      const info = panelEl.querySelector('[data-el="pushed-info"]');
      if (info) info.textContent = '已推送 ' + pushedCount;
    }
    // 清空 badge
    if (bubbleEl) {
      const badge = bubbleEl.querySelector('[data-el="badge"]');
      if (badge) {
        badge.classList.add('xy-cp-hidden');
        badge.textContent = '0';
      }
    }
  }

  function kwStart() {
    if (!panelEl) return;
    const input = panelEl.querySelector('[data-el="kw-input"]');
    const max = panelEl.querySelector('[data-el="kw-max"]');
    if (!input || !max) return;
    const kws = input.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!kws.length) {
      showToast('请输入关键词', 'error');
      return;
    }
    const maxN = parseInt(max.value, 10) || 200;
    saveKwMax(maxN);
    kwRunning = true;
    kwStats.collected = 0;
    refreshKwPill(maxN);
    showToast('关键词采集已启动(mock),共 ' + kws.length + ' 个关键词', 'success');
  }

  function kwStop() {
    kwRunning = false;
    showToast('关键词采集已停止(mock)');
  }

  function kwClear() {
    if (!panelEl) return;
    const input = panelEl.querySelector('[data-el="kw-input"]');
    if (input) input.value = '';
    kwBucket.clear();
    kwStats.collected = 0;
    refreshKwPill();
    showToast('关键词已清空(mock)', 'success');
  }

  function refreshKwPill(max) {
    if (!panelEl) return;
    const pill = panelEl.querySelector('[data-el="kw-pill"]');
    if (!pill) return;
    const m = max || loadKwMax();
    pill.textContent = '已采集 ' + kwStats.collected + '/' + m;
  }

  function refreshStats() {
    if (!panelEl) return;
    const s = panelEl.querySelector('[data-el="stat-success"]');
    const r = panelEl.querySelector('[data-el="stat-running"]');
    const f = panelEl.querySelector('[data-el="stat-failed"]');
    if (s) s.textContent = String(stats.success);
    if (r) r.textContent = String(stats.running);
    if (f) f.textContent = String(stats.failed);
  }

  function refreshBucket() {
    if (!panelEl) return;
    const c = panelEl.querySelector('[data-el="bucket-count"]');
    if (c) c.textContent = String(bucket.size);
    // bubble badge 显示未推送数(用桶大小作为未推送数 mock)
    if (bubbleEl) {
      const badge = bubbleEl.querySelector('[data-el="badge"]');
      if (badge) {
        if (bucket.size > 0) {
          badge.textContent = String(bucket.size);
          badge.classList.remove('xy-cp-hidden');
        } else {
          badge.classList.add('xy-cp-hidden');
        }
      }
    }
  }

  function collapsePanel() {
    if (!panelEl || !bubbleEl) return;
    panelEl.classList.add('xy-cp-hidden');
    bubbleEl.classList.remove('xy-cp-hidden');
    saveCollapsed(true);
  }

  function expandPanel() {
    if (!panelEl || !bubbleEl) return;
    panelEl.classList.remove('xy-cp-hidden');
    bubbleEl.classList.add('xy-cp-hidden');
    saveCollapsed(false);
  }

  // ────────────────────────────────────────────────────────────
  // 事件处理(委托)
  // ────────────────────────────────────────────────────────────
  function onPanelClick(e) {
    const target = e.target.closest('[data-act]');
    if (!target) return;
    const act = target.getAttribute('data-act');
    switch (act) {
      case 'collapse':
        collapsePanel();
        break;
      case 'toggle':
        toggleRunning();
        break;
      case 'retry-failures':
        retryFailures();
        break;
      case 'export-csv':
        exportCsv();
        break;
      case 'clear':
        clearBucket();
        break;
      case 'push':
        pushToCandidate();
        break;
      case 'kw-start':
        kwStart();
        break;
      case 'kw-stop':
        kwStop();
        break;
      case 'kw-clear':
        kwClear();
        break;
      case 'filter-open':
        openFilterModal();
        break;
      default:
        break;
    }
  }

  function onPanelChange(e) {
    const target = e.target.closest('[data-act]');
    if (!target) return;
    const act = target.getAttribute('data-act');
    switch (act) {
      case 'auto-scroll-toggle':
        showToast(target.checked ? '已启用自动翻页(mock)' : '已关闭自动翻页(mock)');
        break;
      case 'sales-filter':
        saveSalesFilter(target.checked);
        showToast(target.checked ? '已启用仅抓有销量' : '已关闭仅抓有销量');
        break;
      default:
        break;
    }
    // kw-max 输入持久化
    if (target.getAttribute('data-el') === 'kw-max') {
      const v = parseInt(target.value, 10);
      if (Number.isFinite(v) && v > 0) saveKwMax(v);
    }
  }

  function onModalClick(e) {
    const target = e.target.closest('[data-act]');
    if (!target) {
      // 点击遮罩本身关闭
      if (e.target === modalEl) closeFilterModal();
      return;
    }
    const act = target.getAttribute('data-act');
    switch (act) {
      case 'filter-close':
        closeFilterModal();
        break;
      case 'filter-save':
        applyFilterFormToCurrent();
        showToast('筛选规则已保存', 'success');
        closeFilterModal();
        break;
      case 'filter-reset':
        resetCurrentTemplate();
        break;
      case 'filter-add':
        addTemplate();
        break;
      case 'filter-rename':
        renameTemplate();
        break;
      case 'filter-delete':
        deleteTemplate();
        break;
      default:
        break;
    }
  }

  function onModalChange(e) {
    // 模板下拉切换
    const tplSel = e.target.closest('[data-el="filter-template"]');
    if (tplSel) {
      smartFilterState.currentTemplateId = tplSel.value;
      renderFilterTable();
      return;
    }
    // 启用复选框
    const en = e.target.closest('[data-field="enabled"]');
    if (en) {
      smartFilterState.enabled = en.checked;
      saveSmartFilter();
      refreshFilterSummary();
    }
  }

  // ────────────────────────────────────────────────────────────
  // 模块 API
  // ────────────────────────────────────────────────────────────
  function mount() {
    if (panelEl) return; // 已挂载则跳过
    panelEl = buildPanel();
    bubbleEl = buildBubble();
    document.body.append(panelEl, bubbleEl);

    // 初始折叠态
    if (loadCollapsed()) {
      panelEl.classList.add('xy-cp-hidden');
    } else {
      bubbleEl.classList.add('xy-cp-hidden');
    }

    // 事件委托
    panelEl.addEventListener('click', onPanelClick);
    panelEl.addEventListener('change', onPanelChange);
    bubbleEl.addEventListener('click', expandPanel);

    refreshFilterSummary();
    refreshBucket();
    refreshStats();
    refreshKwPill();
  }

  function unmount() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    if (bubbleEl) {
      bubbleEl.remove();
      bubbleEl = null;
    }
    closeFilterModal();
  }

  function toggle() {
    if (!panelEl) return;
    if (panelEl.classList.contains('xy-cp-hidden')) {
      expandPanel();
    } else {
      collapsePanel();
    }
  }

  function create() {
    mount();
    return {
      panelEl,
      bubbleEl,
      unmount,
      toggle,
      refreshBucket,
    };
  }

  // ────────────────────────────────────────────────────────────
  // 导出
  // ────────────────────────────────────────────────────────────
  self.JZCollectorPanel = {
    create,
    mount,
    unmount,
    toggle,
    refreshBucket,
  };

  self.JZCollectorFilter = {
    matches: smartMatches,
    getMissingFields: smartGetMissingFields,
  };
})();
