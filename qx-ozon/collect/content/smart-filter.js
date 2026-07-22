// QX采集器 — Smart Filter (V3)
//
// 智能筛选模块,从 collector/panel.js 抽取。
// 提供多字段范围匹配、品牌筛选、发货模式筛选及模板管理。
//
// 字段数据源映射 (V3 设计):
//   16 字段从 marketStats 缓存读取:
//     soldCount / gmvSum / avgPrice / salesDynamics / drr /
//     avgOrdersOnAccDays / avgGmvOnAccDays / daysInPromo / discount /
//     promoRevenueShare / daysWithTrafarets / qtyViewPdp /
//     sessionCount / sessionCountSearch / pdpToCartConversion / convToCartPdp
//   2 字段从 followSell 缓存读取:
//     followerCount (跟卖卖家数,即 followSellData.sellers.length)
//     lowestFollowerPrice (跟卖最低价,即 Math.min(...sellers.map(s=>s.price)))
//
// 注意: smart-filter.js 只负责从传入的 data 对象读取字段值,
//       实际的数据源拼装由调用方 (collectAutoIfMatched / panel.js) 负责。

(() => {
  if (window.QXSmartFilter) return;

  const SMART_FILTER_DEFAULT_ID = 'smart-filter-default';
  const SMART_TEMPLATE_MAX_NAME_LENGTH = 40;
  const STORAGE_KEY = 'qx-smart-filter-state';

  const SMART_FILTER_FIELD_KEYS = [
    { key: 'soldCount', label: '月销量范围：', minPlaceholder: '最小值', maxPlaceholder: '最大值' },
    { key: 'gmvSum', label: '月销售额范围：', minPlaceholder: '最小值', maxPlaceholder: '最大值', prefix: '¥' },
    { key: 'price', label: '价格范围：', minPlaceholder: '最小价格', maxPlaceholder: '最大价格', prefix: '¥' },
    { key: 'weight', label: '重量范围：', minPlaceholder: '最小重量', maxPlaceholder: '最大重量', suffix: 'g' },
    { key: 'listedDays', label: '上架时间：', minPlaceholder: '最小天数', maxPlaceholder: '最大天数', suffix: '天' },
    {
      key: 'monthlyTurnoverDynamic',
      label: '月周转动态：',
      minPlaceholder: '最小',
      maxPlaceholder: '最大',
      suffix: '%',
    },
    { key: 'adCostRatio', label: '广告费占比：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'promoDays', label: '参与促销天数：', minPlaceholder: '最小天数', maxPlaceholder: '最大天数', suffix: '天' },
    { key: 'promoDiscount', label: '参与促销的折扣：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    {
      key: 'promoConversionRate',
      label: '促销活动的转化率：',
      minPlaceholder: '最小',
      maxPlaceholder: '最大',
      suffix: '%',
    },
    {
      key: 'paidPromotionDays',
      label: '付费推广天数：',
      minPlaceholder: '最小天数',
      maxPlaceholder: '最大天数',
      suffix: '天',
    },
    { key: 'views', label: '商品卡浏览量：', minPlaceholder: '最小值', maxPlaceholder: '最大值' },
    { key: 'cardAddToCartRate', label: '商品卡加购率：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'searchCatalogViews', label: '搜索目录浏览量：', minPlaceholder: '最小值', maxPlaceholder: '最大值' },
    {
      key: 'searchCatalogAddToCartRate',
      label: '搜索目录加购率：',
      minPlaceholder: '最小',
      maxPlaceholder: '最大',
      suffix: '%',
    },
    {
      key: 'displayConversionRate',
      label: '展示转化率：',
      minPlaceholder: '最小',
      maxPlaceholder: '最大',
      suffix: '%',
    },
    { key: 'returnCancelRate', label: '退货取消率：', minPlaceholder: '最小', maxPlaceholder: '最大', suffix: '%' },
    { key: 'followerCount', label: '跟卖人数：', minPlaceholder: '最小值', maxPlaceholder: '最大值', suffix: '人' },
    { key: 'lowestFollowerPrice', label: '跟卖最低价：', minPlaceholder: '最小值', maxPlaceholder: '最大值' },
  ];
  const SMART_FILTER_SELECT_KEYS = [{ key: 'shippingMode', label: '发货模式：', options: ['FBS', 'FBO', '不限'] }];
  const SMART_FILTER_BRAND_OPTIONS = [
    { value: 'branded', label: '有品牌' },
    { value: 'noBrand', label: '无品牌' },
    { value: 'any', label: '不限' },
  ];

  function _toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value)
      .replace(/\u00a0/g, ' ')
      .trim();
    const match = normalized.replace(/\s+/g, '').match(/[-+]?\d+(?:[,.]\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function _toFixedNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const normalized = value.replace(/\u00a0/g, ' ').trim();
      const match = normalized.replace(/\s+/g, '').match(/[-+]?\d+(?:[,.]\d+)?/);
      if (!match) return null;
      const parsed = Number(match[0].replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function _firstValue(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function _daysSince(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return null;
    return Math.max(0, Math.floor((Date.now() - time) / 86400000));
  }

  function _daysFieldValue(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) return value;
        continue;
      }
      const text = String(value)
        .replace(/\u00a0/g, ' ')
        .trim();
      if (!text || text === '-' || text === '—') continue;
      const dayMatch = text.match(/(\d+)\s*(?:天|days?|дн)/i);
      if (dayMatch) return Number(dayMatch[1]);
      const dateMatch = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      if (dateMatch) {
        const days = _daysSince(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
        if (days !== null) return days;
        continue;
      }
      const num = _toFixedNumber(text);
      if (num !== null) return num;
    }
    return null;
  }

  function _moneyTextToCny(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value)
      .replace(/\u00a0/g, ' ')
      .trim();
    const cnyMatch = text.replace(/\s+/g, '').match(/[\u00A5\uFFE5]\s*([-+]?\d+(?:[,.]\d+)?)/);
    if (cnyMatch) {
      const cny = Number(cnyMatch[1].replace(',', '.'));
      return Number.isFinite(cny) ? cny : null;
    }
    return null;
  }

  function _rubToCny(value) {
    const rub = _toFixedNumber(value);
    return rub === null ? null : rub * 0.084;
  }

  function _percentFieldValue(...values) {
    const value = _firstValue(...values);
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value)
      .replace(/\u00a0/g, ' ')
      .replace(/[−–—]/g, '-')
      .replace(',', '.')
      .trim();
    if (!text || text === '-' || text === '--') return null;
    const match = text.match(/[-+]?\d+(?:\.\d+)?/);
    if (!match) return null;
    const num = Number(match[0]);
    return Number.isFinite(num) ? num : null;
  }

  function _genTemplateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function _smartDefaultTemplate() {
    return {
      id: SMART_FILTER_DEFAULT_ID,
      name: '默认模板',
      brandOption: 'any',
      shippingMode: '不限',
      conditions: {
        soldCount: { min: null, max: null },
        gmvSum: { min: null, max: null },
        price: { min: null, max: null },
        weight: { min: null, max: null },
        listedDays: { min: null, max: null },
        monthlyTurnoverDynamic: { min: null, max: null },
        adCostRatio: { min: null, max: null },
        promoDays: { min: null, max: null },
        promoDiscount: { min: null, max: null },
        promoConversionRate: { min: null, max: null },
        paidPromotionDays: { min: null, max: null },
        views: { min: null, max: null },
        cardAddToCartRate: { min: null, max: null },
        searchCatalogViews: { min: null, max: null },
        searchCatalogAddToCartRate: { min: null, max: null },
        displayConversionRate: { min: null, max: null },
        returnCancelRate: { min: null, max: null },
        followerCount: { min: null, max: null },
        lowestFollowerPrice: { min: null, max: null },
      },
    };
  }

  function _smartNormTemplate(template) {
    const src = template || {};
    const norm = {
      id: String(src.id || _genTemplateId()),
      name:
        String(src.name || '未命名模板')
          .trim()
          .slice(0, SMART_TEMPLATE_MAX_NAME_LENGTH) || '未命名模板',
      brandOption: SMART_FILTER_BRAND_OPTIONS.some((item) => item.value === src.brandOption) ? src.brandOption : 'any',
      shippingMode: SMART_FILTER_SELECT_KEYS[0].options.includes(src.shippingMode) ? src.shippingMode : '不限',
      conditions: {},
    };
    SMART_FILTER_FIELD_KEYS.forEach((field) => {
      const raw = src.conditions?.[field.key] || {};
      norm.conditions[field.key] = {
        min: _toNumber(raw.min),
        max: _toNumber(raw.max),
      };
    });
    return norm;
  }

  function smartMatchesFieldValue(value, cfg) {
    const minBound = cfg ? _toNumber(cfg.min) : null;
    const maxBound = cfg ? _toNumber(cfg.max) : null;
    const hasBounds = minBound !== null || maxBound !== null;
    if (!hasBounds) return true;
    if (!cfg) return true;
    const num = _toFixedNumber(value);
    if (num === null) return false;
    if (minBound !== null && num < minBound) return false;
    if (maxBound !== null && num > maxBound) return false;
    return true;
  }

  function smartGetDataField(data, key, info) {
    if (!data && !info) return null;
    if (key === 'price')
      return _firstValue(
        Number(data?.price) > 0 ? data.price : null,
        Number(info?.price) > 0 ? info.price : null,
        Number(data?.avgPrice) > 0 ? data.avgPrice : null
      );
    if (key === 'soldCount') return data?.soldCount;
    if (key === 'gmvSum')
      return _firstValue(
        data?.gmvSumCny,
        data?.revenue30dCny,
        _moneyTextToCny(data?.revenue30d),
        _rubToCny(data?.gmvSum),
        _rubToCny(data?.revenue30dRub)
      );
    if (key === 'views') return _firstValue(data?.views, data?.qtyViewPdp, data?.sessionCount, data?.pdpViews);
    if (key === 'weight') return _firstValue(data?.weight, data?.weightG, data?.weightGrams);
    if (key === 'listedDays')
      return _daysFieldValue(data?.listedDays, data?.daysOnline, data?.createDate, data?.nullableCreateDate);
    if (key === 'monthlyTurnoverDynamic')
      return _percentFieldValue(data?.monthlyTurnoverDynamic, data?.turnoverDynamic, data?.salesDynamics);
    if (key === 'adCostRatio') return _firstValue(data?.adCostRatio, data?.adCostPercent, data?.drr);
    if (key === 'promoDays') return _firstValue(data?.promoDays, data?.daysInPromo);
    if (key === 'promoDiscount') return _firstValue(data?.promoDiscount, data?.discount);
    if (key === 'promoConversionRate')
      return _firstValue(data?.promoConversionRate, data?.promoRevenueShare, data?.promoConvRate);
    if (key === 'paidPromotionDays')
      return _firstValue(data?.paidPromotionDays, data?.daysWithTrafarets, data?.daysWithAds);
    if (key === 'cardAddToCartRate')
      return _firstValue(data?.cardAddToCartRate, data?.pdpToCartConversion, data?.convToCartPdp, data?.pdpCartRate);
    if (key === 'searchCatalogViews')
      return _firstValue(data?.searchCatalogViews, data?.sessionCountSearch, data?.searchViews);
    if (key === 'searchCatalogAddToCartRate')
      return _firstValue(data?.searchCatalogAddToCartRate, data?.convToCartSearch, data?.searchCartRate);
    if (key === 'displayConversionRate') return _firstValue(data?.displayConversionRate, data?.convViewToOrder);
    if (key === 'returnCancelRate') {
      const direct = _firstValue(data?.returnCancelRate, data?.returnRate);
      if (direct !== null) return direct;
      const redemption = _toFixedNumber(data?.nullableRedemptionRate);
      return redemption === null ? null : 100 - redemption;
    }
    if (key === 'followerCount') return _firstValue(data?.followerCount, data?.followSellCount, data?.heroFollow);
    if (key === 'lowestFollowerPrice')
      return _firstValue(data?.lowestFollowerPrice, data?.followSellMinPrice, data?.followMinPrice);
    return null;
  }

  function smartHasBrand(info, expectedBrand) {
    if (!expectedBrand || expectedBrand === 'any') return true;
    const rawBrand = [info?.brandName, info?.brand, info?.brand_name, info?.raw?.brandName, info?.raw?.brand].find(
      (value) => value !== undefined && value !== null && String(value).trim() !== ''
    );
    const text = String(rawBrand || '').trim();
    let hasBrand = false;
    if (text) {
      const normalized = text.toLowerCase();
      hasBrand = ![
        '-',
        '--',
        '—',
        '无',
        '无品牌',
        '没有品牌',
        '未设置品牌',
        'no brand',
        'no_brand',
        'nobrand',
        'none',
        'null',
        'undefined',
        'без бренда',
        'нет бренда',
      ].includes(normalized);
    }
    if (expectedBrand === 'branded') return hasBrand;
    if (expectedBrand === 'noBrand') return !hasBrand;
    return true;
  }

  function smartCurrentTemplate(state) {
    const templates = state?.templates || [];
    return templates.find((item) => item.id === state?.currentTemplateId) || templates[0] || _smartDefaultTemplate();
  }

  function smartMissingFields(data, info, state) {
    if (!state?.enabled) return [];
    const template = smartCurrentTemplate(state);
    const missing = [];
    Object.entries(template.conditions || {}).forEach(([key, cfg]) => {
      const minBound = cfg ? _toNumber(cfg.min) : null;
      const maxBound = cfg ? _toNumber(cfg.max) : null;
      if (minBound === null && maxBound === null) return;
      if (_toFixedNumber(smartGetDataField(data, key, info)) === null) {
        missing.push(key);
      }
    });
    return missing;
  }

  function smartMatches(data, info, state) {
    if (!state?.enabled) return true;
    const template = smartCurrentTemplate(state);
    if (template.brandOption && template.brandOption !== 'any') {
      if (!smartHasBrand(data, template.brandOption)) return false;
    }
    if (template.shippingMode && template.shippingMode !== '不限') {
      const shippingMode = String(
        data?.shippingMode ||
        data?.deliverySchema ||
        data?.deliveryType ||
        data?.salesSchema ||
        (Array.isArray(data?.sources) ? data.sources.join('/') : '') ||
        ''
      )
        .trim()
        .toUpperCase();
      if (!shippingMode || shippingMode !== template.shippingMode) return false;
    }
    return Object.entries(template.conditions || {}).every(([key, cfg]) => {
      const matched = smartMatchesFieldValue(smartGetDataField(data, key, info), cfg);
      return matched;
    });
  }

  async function _loadState() {
    const fallback = {
      enabled: false,
      currentTemplateId: SMART_FILTER_DEFAULT_ID,
      templates: [_smartDefaultTemplate()],
    };
    let raw;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      raw = result[STORAGE_KEY];
    } catch {
      return fallback;
    }
    if (!raw) return fallback;
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const seenIds = new Set();
      const templates = Array.isArray(parsed?.templates)
        ? parsed.templates.map(_smartNormTemplate).filter((item) => {
          if (!item || !item.id) return false;
          if (seenIds.has(item.id)) return false;
          seenIds.add(item.id);
          return true;
        })
        : [_smartDefaultTemplate()];
      if (!templates.length) templates.push(_smartDefaultTemplate());
      if (!templates.some((item) => item.id === SMART_FILTER_DEFAULT_ID)) {
        templates.unshift(_smartDefaultTemplate());
      } else {
        const defaultIndex = templates.findIndex((item) => item.id === SMART_FILTER_DEFAULT_ID);
        if (defaultIndex > 0) {
          const defaultTemplate = templates.splice(defaultIndex, 1)[0];
          templates.unshift(defaultTemplate);
        }
      }
      let currentTemplateId = String(parsed.currentTemplateId || SMART_FILTER_DEFAULT_ID);
      if (!templates.some((x) => x.id === currentTemplateId)) {
        currentTemplateId = SMART_FILTER_DEFAULT_ID;
      }
      return {
        enabled: typeof parsed?.enabled === 'boolean' ? !!parsed.enabled : false,
        currentTemplateId,
        templates,
      };
    } catch {
      return fallback;
    }
  }

  async function _saveState(state) {
    const templates = Array.isArray(state?.templates)
      ? state.templates.map(_smartNormTemplate).filter((item) => item && item.id)
      : [_smartDefaultTemplate()];
    const seenIds = new Set();
    const dedupedTemplates = [];
    templates.forEach((item) => {
      if (seenIds.has(item.id)) return;
      seenIds.add(item.id);
      dedupedTemplates.push(item);
    });
    let currentTemplateId = String(state?.currentTemplateId || SMART_FILTER_DEFAULT_ID);
    if (!dedupedTemplates.some((item) => item.id === currentTemplateId)) {
      currentTemplateId = SMART_FILTER_DEFAULT_ID;
    }
    const fixed = {
      enabled: !!state?.enabled,
      currentTemplateId,
      templates: dedupedTemplates,
    };
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: fixed });
    } catch { }
  }

  async function listTemplates() {
    const state = await _loadState();
    return state.templates;
  }

  async function loadTemplate(id) {
    const state = await _loadState();
    return state.templates.find((t) => t.id === id) || null;
  }

  async function saveTemplate(template) {
    const state = await _loadState();
    const norm = _smartNormTemplate(template);
    const idx = state.templates.findIndex((t) => t.id === norm.id);
    if (idx >= 0) {
      state.templates[idx] = norm;
    } else {
      state.templates.push(norm);
    }
    await _saveState(state);
    return norm;
  }

  async function deleteTemplate(id) {
    const state = await _loadState();
    if (id === SMART_FILTER_DEFAULT_ID) return;
    state.templates = state.templates.filter((t) => t.id !== id);
    if (!state.templates.some((t) => t.id === SMART_FILTER_DEFAULT_ID)) {
      state.templates.unshift(_smartDefaultTemplate());
    }
    if (!state.templates.some((t) => t.id === state.currentTemplateId)) {
      state.currentTemplateId = SMART_FILTER_DEFAULT_ID;
    }
    await _saveState(state);
  }

  window.QXSmartFilter = {
    SMART_FILTER_FIELD_KEYS,
    SMART_FILTER_SELECT_KEYS,
    SMART_FILTER_BRAND_OPTIONS,
    smartGetDataField,
    smartMatches,
    smartHasBrand,
    smartMissingFields,
    loadTemplate,
    saveTemplate,
    listTemplates,
    deleteTemplate,
  };
})();
