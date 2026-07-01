// 选品推荐面板(3 tab:热卖榜单 / 蓝海商品 / 中国卖家)—— 从原项目 0.13.31.1 抽离的 Demo。
// 后端用 mock,UI 完整复刻原项目视觉与交互。所有 class 用 `xy-rec-` 前缀。
// 模块导出:self.JZRecommendPanel = { mount, unmount, toggle }

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // Mock 数据生成
  // ────────────────────────────────────────────────────────────
  function generateMockProducts(type) {
    // type: 'hot' / 'blue' / 'china'
    const seed = type === 'hot' ? 1 : type === 'blue' ? 2 : 3;
    const titles = {
      hot: ['无线蓝牙耳机', '便携充电宝', '手机支架', '硅胶手机壳', 'LED台灯', '蓝牙音箱', 'USB数据线', '车载充电器'],
      blue: ['手工编织包', '复古怀表', '木质茶具', '皮质钱包', '手工皂', '香薰蜡烛', '羊毛围巾', '陶瓷杯'],
      china: ['义乌小商品', '深圳电子配件', '广州服饰', '温州皮具', '宁波家居', '佛山陶瓷', '泉州鞋帽', '汕头玩具'],
    };
    const list = titles[type] || titles.hot;
    return list.slice(0, 8).map((title, i) => ({
      title: title + ` #${i + 1}`,
      image: `https://via.placeholder.com/80x80/e8f0ff/005bff?text=${encodeURIComponent(title.slice(0, 2))}`,
      url: `https://www.ozon.ru/product/demo-${seed}-${i}/`,
      price: Math.floor(500 + seed * 200 + i * 150),
      sold_count: Math.floor(100 + seed * 50 + i * 30),
    }));
  }

  // ────────────────────────────────────────────────────────────
  // HTML 转义
  // ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ────────────────────────────────────────────────────────────
  // 商品卡渲染
  // ────────────────────────────────────────────────────────────
  function renderCard(product) {
    return (
      '<div class="xy-rec-card">' +
      `<img src="${product.image}" class="xy-rec-thumb" alt="${esc(product.title)}" onerror="this.style.display='none'">` +
      '<div class="xy-rec-info">' +
      `<div class="xy-rec-name">${esc(product.title)}</div>` +
      '<div class="xy-rec-meta">' +
      `<span class="xy-rec-price">${product.price} ₽</span>` +
      `<span class="xy-rec-sales">月销 ${product.sold_count}</span>` +
      '</div>' +
      '</div>' +
      `<button class="xy-rec-btn" data-action="follow-sell" data-url="${esc(product.url)}">跟卖</button>` +
      '</div>'
    );
  }

  // ────────────────────────────────────────────────────────────
  // 面板 DOM
  // ────────────────────────────────────────────────────────────
  let panelEl = null; // .xy-rec-panel
  let currentTab = 'hot';
  let loadTimer = null;

  function buildPanel() {
    const root = document.createElement('div');
    root.className = 'xy-rec-panel';
    root.id = 'xy-recommend-panel';
    root.innerHTML =
      '<div class="xy-rec-header">' +
      '<span class="xy-rec-title">选品推荐</span>' +
      '<button class="xy-rec-close" data-action="close" type="button">×</button>' +
      '</div>' +
      '<div class="xy-rec-content">' +
      '<div class="xy-rec-tabs">' +
      '<button class="xy-rec-tab is-active" data-tab="hot" type="button">🔥 热卖榜单</button>' +
      '<button class="xy-rec-tab" data-tab="blue" type="button">💎 蓝海商品</button>' +
      '<button class="xy-rec-tab" data-tab="china" type="button">🇨🇳 中国卖家</button>' +
      '</div>' +
      '<div class="xy-rec-list" data-el="list"></div>' +
      '</div>';
    return root;
  }

  // ────────────────────────────────────────────────────────────
  // 列表渲染(含加载态 / 空态)
  // ────────────────────────────────────────────────────────────
  function setListHtml(html) {
    if (!panelEl) return;
    const list = panelEl.querySelector('[data-el="list"]');
    if (list) list.innerHTML = html;
  }

  function showLoading() {
    setListHtml('<div class="xy-rec-loading">加载中...</div>');
  }

  function showEmpty() {
    setListHtml('<div class="xy-rec-empty">暂无推荐商品</div>');
  }

  function renderList(products) {
    if (!products || !products.length) {
      showEmpty();
      return;
    }
    setListHtml(products.map(renderCard).join(''));
  }

  // 加载推荐(模拟异步:先 loading,300ms 后渲染 mock)
  function loadRecommendations(tab) {
    currentTab = tab;
    showLoading();
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      const products = generateMockProducts(tab);
      renderList(products);
    }, 300);
  }

  // ────────────────────────────────────────────────────────────
  // 事件处理(委托)
  // ────────────────────────────────────────────────────────────
  function onPanelClick(e) {
    // Tab 切换
    const tabBtn = e.target.closest('.xy-rec-tab');
    if (tabBtn) {
      const tab = tabBtn.getAttribute('data-tab');
      if (!tab || tab === currentTab) return;
      // toggle is-active
      const tabs = panelEl ? panelEl.querySelectorAll('.xy-rec-tab') : null;
      if (tabs) {
        tabs.forEach((t) => t.classList.remove('is-active'));
      }
      tabBtn.classList.add('is-active');
      loadRecommendations(tab);
      return;
    }

    const target = e.target.closest('[data-action]');
    if (!target) return;
    const act = target.getAttribute('data-action');
    switch (act) {
      case 'close':
        hide();
        break;
      case 'follow-sell': {
        const url = target.getAttribute('data-url');
        if (url) window.open(url, '_blank');
        break;
      }
      default:
        break;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 显示 / 隐藏
  // ────────────────────────────────────────────────────────────
  function show() {
    if (!panelEl) return;
    panelEl.style.display = '';
  }

  function hide() {
    if (!panelEl) return;
    panelEl.style.display = 'none';
  }

  // ────────────────────────────────────────────────────────────
  // 模块 API
  // ────────────────────────────────────────────────────────────
  function mount() {
    if (panelEl) return; // 已挂载则跳过
    panelEl = buildPanel();
    panelEl.style.display = 'none'; // 默认隐藏,toggle 控制
    document.body.append(panelEl);
    panelEl.addEventListener('click', onPanelClick);
    // 首次加载默认 tab
    loadRecommendations('hot');
  }

  function unmount() {
    clearTimeout(loadTimer);
    if (panelEl) {
      panelEl.removeEventListener('click', onPanelClick);
      panelEl.remove();
      panelEl = null;
    }
    currentTab = 'hot';
  }

  function toggle() {
    if (!panelEl) return;
    if (panelEl.style.display === 'none') {
      show();
    } else {
      hide();
    }
  }

  // ────────────────────────────────────────────────────────────
  // 导出
  // ────────────────────────────────────────────────────────────
  self.JZRecommendPanel = {
    mount,
    unmount,
    toggle,
  };
})();
