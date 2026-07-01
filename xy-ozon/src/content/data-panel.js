// 搜索页商品卡注入数据面板 —— 复刻原项目 ozon-helper 商品卡注入(V2 5-section 结构)。
// 仅在 /search、/category、/search-by-image 路径挂载;后端数据用 mock,UI 复刻原项目视觉与交互。

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 商品卡选择器(多个 selector 命中同一节点用 Set 去重)
  // ────────────────────────────────────────────────────────────
  const CARD_SELECTORS = [
    '[data-widget="searchResultsV2"] > div > div',
    '[data-widget="searchResults"] > div > div',
    '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
    '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
    '.tile-root',
  ];

  const STORAGE_KEY = 'xy_data_panel_enabled';
  const SUPPORTED_PATHS = ['/search', '/category', '/search-by-image'];
  const ATTACH_FLAG = '_xyDpPanelAttached';

  // ────────────────────────────────────────────────────────────
  // Hero 2×2 stat 卡配置
  // ────────────────────────────────────────────────────────────
  const HERO_CARDS = [
    { field: 'sales30d', label: '月销量', accent: 'blue', clickable: false },
    { field: 'createDate', label: '上架时间', accent: 'green', clickable: false },
    {
      field: 'heroFollow',
      label: '跟卖',
      accent: 'orange',
      clickable: true,
      clickAction: 'show-followsell-modal',
    },
    { field: 'heroSize', label: '重量·尺寸', accent: 'purple', clickable: false },
  ];

  // ────────────────────────────────────────────────────────────
  // 4 个可折叠 Section 配置
  // ────────────────────────────────────────────────────────────
  const SECTIONS = [
    {
      id: 'info',
      title: '商品信息',
      accent: 'blue',
      icon: '📦',
      fields: [
        { label: '一级类目', field: 'category' },
        { label: '三级类目', field: 'categoryL3' },
        { label: 'SKU', field: 'sku', copyable: true },
        { label: '品牌', field: 'brand' },
        { label: '发货模式', field: 'salesSchema' },
        { label: 'rFBS佣金', field: 'commRfbs' },
        { label: 'FBP佣金', field: 'commFbp' },
        { label: '月销售额', field: 'revenue30d' },
        { label: '月周转动态', field: 'salesDynamics' },
        { label: '日销量', field: 'dailySales' },
        { label: '日销售额', field: 'dailyRevenue' },
        { label: '广告费占比', field: 'drr' },
      ],
    },
    {
      id: 'promo',
      title: '促销推广',
      accent: 'orange',
      icon: '🎯',
      fields: [
        { label: '促销天数', field: 'daysInPromo' },
        { label: '促销折扣', field: 'promoDiscount' },
        { label: '促销转化率', field: 'promoConvRate' },
        { label: '推广天数', field: 'daysWithAds' },
      ],
    },
    {
      id: 'traffic',
      title: '流量转化',
      accent: 'green',
      icon: '📊',
      fields: [
        { label: '卡片浏览', field: 'pdpViews' },
        { label: '卡片加购率', field: 'pdpCartRate' },
        { label: '搜索浏览', field: 'searchViews' },
        { label: '搜索加购率', field: 'searchCartRate' },
        { label: '展示转化率', field: 'convViewToOrder' },
        { label: '点击率', field: 'clickRate' },
      ],
    },
    {
      id: 'logistics',
      title: '物流详情',
      accent: 'purple',
      icon: '🚚',
      fields: [
        { label: '退货率', field: 'returnRate', valueClass: 'is-red' },
        { label: '评分', field: 'rating', valueClass: 'is-gold' },
        { label: '长宽高', field: 'dimensions' },
        { label: '体积(L)', field: 'volume' },
        { label: '重量', field: 'weight' },
      ],
    },
  ];

  // ────────────────────────────────────────────────────────────
  // 状态
  // ────────────────────────────────────────────────────────────
  let observer = null;
  let storageListener = null;
  let mounted = false;
  // panel -> IntersectionObserver,卸载时断开
  const ioMap = new WeakMap();

  // ────────────────────────────────────────────────────────────
  // Toast
  // ────────────────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `xy-dp-toast xy-dp-toast-${type}`;
    t.textContent = msg;
    t.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);' +
      'color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;z-index:2147483647;' +
      'transition:opacity 0.3s;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 2000);
  }

  // ────────────────────────────────────────────────────────────
  // Mock 数据生成(基于 sku 生成稳定但随机的数据)
  // ────────────────────────────────────────────────────────────
  function generateMockData(sku, name, price) {
    const seed = parseInt(String(sku).slice(-6), 10) || 12345;
    const rand = (min, max) => min + ((seed % 1000) / 1000) * (max - min);
    return {
      sales30d: Math.floor(rand(10, 500)),
      createDate: `${2024 + Math.floor(rand(0, 2))}-${String(Math.floor(rand(1, 13))).padStart(2, '0')}-${String(
        Math.floor(rand(1, 29))
      ).padStart(2, '0')}`,
      followerCount: Math.floor(rand(0, 50)),
      weight: `${Math.floor(rand(50, 2000))}g`,
      dimensions: `${Math.floor(rand(5, 50))}×${Math.floor(rand(5, 50))}×${Math.floor(rand(5, 50))}`,
      category: '电子配件',
      categoryL3: '手机壳',
      brand: seed % 3 === 0 ? '无品牌' : 'DemoBrand',
      salesSchema: seed % 2 === 0 ? 'FBS' : 'FBO',
      commRfbs: `${rand(5, 25).toFixed(1)}%`,
      commFbp: `${rand(8, 30).toFixed(1)}%`,
      revenue30d: `¥${rand(1000, 50000).toFixed(0)}`,
      salesDynamics: `${rand(-20, 100).toFixed(1)}%`,
      dailySales: Math.floor(rand(0, 20)),
      dailyRevenue: `¥${rand(30, 1500).toFixed(0)}`,
      drr: `${rand(0, 30).toFixed(1)}%`,
      daysInPromo: Math.floor(rand(0, 30)),
      promoDiscount: `${rand(0, 40).toFixed(1)}%`,
      promoConvRate: `${rand(0, 15).toFixed(1)}%`,
      daysWithAds: Math.floor(rand(0, 30)),
      pdpViews: Math.floor(rand(100, 5000)),
      pdpCartRate: `${rand(0, 20).toFixed(1)}%`,
      searchViews: Math.floor(rand(50, 3000)),
      searchCartRate: `${rand(0, 15).toFixed(1)}%`,
      convViewToOrder: `${rand(0, 10).toFixed(1)}%`,
      clickRate: `${rand(0, 25).toFixed(1)}%`,
      returnRate: `${rand(0, 15).toFixed(1)}%`,
      rating: rand(3.5, 5).toFixed(1),
      volume: `${rand(0.1, 5).toFixed(2)}L`,
    };
  }

  // ────────────────────────────────────────────────────────────
  // 卡片信息抽取
  // ────────────────────────────────────────────────────────────
  function extractCardInfo(card) {
    const link = card.querySelector('a[href*="/product/"]');
    const url = link ? link.href : '';
    const imgEl = card.querySelector('img');
    const name = imgEl?.getAttribute('alt') || '';
    const image = imgEl?.src || '';
    let price = '';
    const priceEl = card.querySelector('[class*="price"], span[class*="tsHead"]');
    if (priceEl) price = (priceEl.textContent || '').replace(/\s+/g, ' ').trim();
    return { url, name, price, image };
  }

  function extractProductId(url) {
    const m = String(url || '').match(/\/product\/.*-(\d{5,})/);
    return m ? m[1] : '';
  }

  // ────────────────────────────────────────────────────────────
  // 渲染:Hero stat 卡(骨架 / 真实)
  // ────────────────────────────────────────────────────────────
  function renderHeroSkeleton() {
    return HERO_CARDS.map(() => '<div class="xy-dp-hero-stat is-skeleton"></div>').join('');
  }

  function renderHero(data) {
    return HERO_CARDS.map((h) => {
      let val = '—';
      if (h.field === 'sales30d') val = data.sales30d;
      else if (h.field === 'createDate') val = data.createDate;
      else if (h.field === 'heroFollow') val = `${data.followerCount}`;
      else if (h.field === 'heroSize') val = data.weight;
      const clickableCls = h.clickable ? ' is-clickable' : '';
      const clickAttr = h.clickable ? ` data-click-action="${h.clickAction}"` : '';
      return (
        `<div class="xy-dp-hero-stat is-${h.accent}${clickableCls}"${clickAttr}>` +
        `<div class="xy-dp-hero-value" data-field="${h.field}">${val}<small>${h.label}</small></div>` +
        '</div>'
      );
    }).join('');
  }

  // ────────────────────────────────────────────────────────────
  // 渲染:Section 字段(骨架 / 真实)
  // ────────────────────────────────────────────────────────────
  function renderSectionSkeleton() {
    return '<div class="xy-dp-skeleton-row"></div><div class="xy-dp-skeleton-row"></div>';
  }

  function renderSectionFields(s, data) {
    return s.fields
      .map((f) => {
        let val = data[f.field];
        if (val == null) val = '—';
        const valCls = f.valueClass ? ` ${f.valueClass}` : '';
        const copyAttr = f.copyable ? ' data-action="copy-sku"' : '';
        return (
          '<div class="xy-dp-field">' +
          `<span class="xy-dp-field-label">${f.label}</span>` +
          `<span class="xy-dp-field-value${valCls}" data-field="${f.field}"${copyAttr}>${val}</span>` +
          '</div>'
        );
      })
      .join('');
  }

  // ────────────────────────────────────────────────────────────
  // 创建面板 DOM(shell:header + hero 容器 + sections 容器 + actions)
  // ────────────────────────────────────────────────────────────
  function createPanel() {
    const panel = document.createElement('div');
    panel.className = 'xy-dp-panel';
    panel.innerHTML =
      '<div class="xy-dp-header">' +
      '<span class="xy-dp-logo">⚡</span>' +
      '<span class="xy-dp-brand">MYERP</span>' +
      '<button class="xy-dp-gear" data-action="open-field-settings" title="字段设置">⚙</button>' +
      '</div>' +
      '<div class="xy-dp-hero-section"></div>' +
      SECTIONS.map(
        (s) =>
          `<div class="xy-dp-section is-accent-${s.accent}" data-section="${s.id}">` +
          '<div class="xy-dp-section-header" data-action="toggle-section">' +
          `<span class="xy-dp-section-title"><span class="xy-dp-section-icon">${s.icon}</span>${s.title}</span>` +
          '<span class="xy-dp-chevron">▼</span>' +
          '</div>' +
          '<div class="xy-dp-section-body"></div>' +
          '</div>'
      ).join('') +
      '<div class="xy-dp-actions">' +
      '<button class="xy-dp-btn is-primary" data-action="follow-sell">' +
      '<span class="xy-dp-btn-icon">🔗</span>一键跟卖</button>' +
      '<div class="xy-dp-actions-row">' +
      '<button class="xy-dp-btn" data-action="edit-list">编辑上架</button>' +
      '<button class="xy-dp-btn" data-action="collect-one">采集</button>' +
      '</div>' +
      '</div>';
    bindPanelEvents(panel);
    return panel;
  }

  // ────────────────────────────────────────────────────────────
  // 渲染骨架
  // ────────────────────────────────────────────────────────────
  function renderSkeleton(panel) {
    const hero = panel.querySelector('.xy-dp-hero-section');
    if (hero) hero.innerHTML = renderHeroSkeleton();
    SECTIONS.forEach((s) => {
      const body = panel.querySelector(`[data-section="${s.id}"] .xy-dp-section-body`);
      if (body) body.innerHTML = renderSectionSkeleton();
    });
  }

  // ────────────────────────────────────────────────────────────
  // 渲染真实数据
  // ────────────────────────────────────────────────────────────
  function renderPanel(panel, data) {
    const hero = panel.querySelector('.xy-dp-hero-section');
    if (hero) hero.innerHTML = renderHero(data);
    SECTIONS.forEach((s) => {
      const body = panel.querySelector(`[data-section="${s.id}"] .xy-dp-section-body`);
      if (body) body.innerHTML = renderSectionFields(s, data);
    });
  }

  // ────────────────────────────────────────────────────────────
  // 事件委托:在 panel 节点上监听 click
  // ────────────────────────────────────────────────────────────
  function bindPanelEvents(panel) {
    panel.addEventListener('click', (e) => {
      const target = e.target.closest('[data-click-action], [data-action]');
      if (!target) return;
      // 防误触发 Ozon tile 跳转
      e.preventDefault();
      e.stopPropagation();
      const action = target.getAttribute('data-action') || target.getAttribute('data-click-action');
      handlePanelAction(action, target, panel);
    });
  }

  function handlePanelAction(action, target, panel) {
    const info = panel._xyDpInfo || {};
    switch (action) {
      case 'open-field-settings':
        showToast('字段设置(mock)');
        break;
      case 'toggle-section': {
        const section = target.closest('.xy-dp-section');
        if (section) section.classList.toggle('is-collapsed');
        break;
      }
      case 'show-followsell-modal':
        showToast('跟卖列表(mock)');
        break;
      case 'follow-sell':
        if (info.url) {
          window.open(info.url + '#xy-follow-sell', '_blank');
        } else {
          showToast('未识别到商品链接');
        }
        break;
      case 'edit-list':
        showToast('编辑上架(mock)');
        break;
      case 'collect-one': {
        const btn = target.closest('.xy-dp-btn');
        if (btn) {
          const original = btn.innerHTML;
          btn.classList.add('is-collected');
          btn.textContent = '已采集';
          setTimeout(() => {
            btn.classList.remove('is-collected');
            btn.innerHTML = original;
          }, 1800);
        }
        break;
      }
      case 'copy-sku': {
        const val = target.textContent || '';
        try {
          navigator.clipboard?.writeText(val);
          showToast('已复制 SKU');
        } catch {
          showToast('复制失败');
        }
        break;
      }
      default:
        break;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 加载面板数据(IO 触发)
  // ────────────────────────────────────────────────────────────
  function loadPanelData(card, panel) {
    const info = extractCardInfo(card);
    panel._xyDpInfo = info;
    renderSkeleton(panel);
    const sku = extractProductId(info.url) || '123456';
    const delay = 500 + Math.floor(Math.random() * 300); // 500-800ms 模拟异步
    setTimeout(() => {
      const data = generateMockData(sku, info.name, info.price);
      data.sku = sku;
      renderPanel(panel, data);
      // 暴露采集数据供采集器面板调用(可选)
      try {
        if (!window.__xyDpCollectData) window.__xyDpCollectData = {};
        window.__xyDpCollectData[sku] = { info, data };
      } catch {}
    }, delay);
  }

  // ────────────────────────────────────────────────────────────
  // 注入面板到单个商品卡
  // ────────────────────────────────────────────────────────────
  function injectPanelIntoCard(card) {
    if (!card || card[ATTACH_FLAG]) return;
    // 必须有商品链接,跳过推广位/占位
    if (!card.querySelector('a[href*="/product/"]')) return;
    const panel = createPanel();
    card.appendChild(panel);
    card[ATTACH_FLAG] = true;
    // IO 懒加载:面板进入视口前 200px 才触发 loadPanelData
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            io.disconnect();
            loadPanelData(card, panel);
          }
        }
      },
      { rootMargin: '200px' }
    );
    io.observe(panel);
    ioMap.set(panel, io);
  }

  // ────────────────────────────────────────────────────────────
  // 扫描所有商品卡并注入(Set 去重)
  // ────────────────────────────────────────────────────────────
  function applyToAll() {
    if (!mounted) return;
    const cards = new Set();
    CARD_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((c) => cards.add(c));
    });
    cards.forEach(injectPanelIntoCard);
  }

  // ────────────────────────────────────────────────────────────
  // MutationObserver(节流:requestAnimationFrame 合并连续 mutation)
  // ────────────────────────────────────────────────────────────
  function createObserver() {
    let applyPending = false;
    const obs = new MutationObserver(() => {
      if (applyPending) return;
      applyPending = true;
      requestAnimationFrame(() => {
        applyPending = false;
        applyToAll();
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return obs;
  }

  // ────────────────────────────────────────────────────────────
  // 路径 / 开关判断
  // ────────────────────────────────────────────────────────────
  function isSupportedPage() {
    const p = window.location.pathname;
    return SUPPORTED_PATHS.some((sp) => p === sp || p.startsWith(sp + '/') || p.startsWith(sp));
  }

  async function isEnabled() {
    try {
      const data = await chrome.storage.local.get([STORAGE_KEY]);
      return data[STORAGE_KEY] !== false;
    } catch {
      return true;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 根据 路径+开关 同步挂载状态
  // ────────────────────────────────────────────────────────────
  async function syncMountState() {
    if (isSupportedPage() && (await isEnabled())) {
      mount();
    } else {
      unmount();
    }
  }

  // ────────────────────────────────────────────────────────────
  // mount / unmount / refresh
  // ────────────────────────────────────────────────────────────
  function mount() {
    if (mounted) return;
    mounted = true;
    applyToAll();
    observer = createObserver();
  }

  function unmount() {
    mounted = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    // 移除所有已注入面板并断开 IO
    document.querySelectorAll('.xy-dp-panel').forEach((panel) => {
      const io = ioMap.get(panel);
      if (io) io.disconnect();
      const card = panel.parentElement;
      if (card) card[ATTACH_FLAG] = false;
      panel.remove();
    });
  }

  function refresh() {
    applyToAll();
  }

  // ────────────────────────────────────────────────────────────
  // storage 变化监听(实时 mount/unmount)
  // ────────────────────────────────────────────────────────────
  function setupStorageListener() {
    if (storageListener) return;
    storageListener = (changes, area) => {
      if (area !== 'local') return;
      if (STORAGE_KEY in changes) syncMountState();
    };
    try {
      chrome.storage.onChanged.addListener(storageListener);
    } catch {}
  }

  // ────────────────────────────────────────────────────────────
  // 初始化
  // ────────────────────────────────────────────────────────────
  function init() {
    setupStorageListener();
    syncMountState();
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API
  // ────────────────────────────────────────────────────────────
  self.JZDataPanel = {
    mount,
    unmount,
    refresh,
  };
})();
