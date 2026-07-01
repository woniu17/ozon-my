// 跟卖商家列表弹窗(锚点定位浮动卡片)—— 从原项目 0.13.31.1 抽离的 Demo。
// 后端用 mock,UI 完整复刻原项目视觉与交互。所有 class 用 `xy-sl-` 前缀。
// 模块导出:self.JZSellerListModal = { show, close }

(function () {
  'use strict';

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
  // Mock 数据生成
  // ────────────────────────────────────────────────────────────
  function generateMockSellers(sku) {
    const names = [
      'ООО Ромашка',
      'ИП Иванов',
      'Shop Premium',
      'Торговый Дом',
      'Global Trade',
      'Магазин №1',
      'Alpha Sales',
      'Beta Store',
    ];
    const regions = ['俄罗斯', '白俄罗斯', '哈萨克斯坦', '中国'];
    const deliveries = ['明天送达', '2-3 天', '3-5 天', '5-7 天', '7-14 天'];
    const seed = parseInt(String(sku).slice(-4), 10) || 1234;
    const count = 3 + (seed % 6); // 3-8 个商家
    return Array.from({ length: count }, (_, i) => {
      const price = 500 + (seed % 500) + i * 80;
      return {
        name: names[(seed + i) % names.length],
        price: `₽ ${price.toLocaleString('ru-RU')}`,
        priceNum: price,
        sku: String(1000000 + seed + i),
        link: `https://www.ozon.ru/seller/${(seed + i) % 100}/`,
        avatar: null,
        rating: (3.5 + (seed % 15) / 10).toFixed(1),
        reviewsCount: 10 + ((seed + i * 7) % 500),
        region: regions[(seed + i) % regions.length],
        deliveryText: deliveries[i % deliveries.length],
        deliveryRank: i + 1, // 1=最快
      };
    });
  }

  // ────────────────────────────────────────────────────────────
  // 统计与排序
  // ────────────────────────────────────────────────────────────
  function sellerListStats(sellers) {
    const prices = sellers.map((s) => s.priceNum).filter((p) => p > 0);
    const ranks = sellers.map((s) => s.deliveryRank).filter((r) => r != null);
    return {
      minPrice: prices.length ? Math.min(...prices) : null,
      fastestRank: ranks.length ? Math.min(...ranks) : null,
    };
  }

  function sortSellers(sellers, mode) {
    if (mode === 'delivery') {
      return [...sellers].sort((a, b) => (a.deliveryRank || 999) - (b.deliveryRank || 999) || a.priceNum - b.priceNum);
    }
    return [...sellers].sort((a, b) => a.priceNum - b.priceNum);
  }

  // ────────────────────────────────────────────────────────────
  // 运行时状态
  // ────────────────────────────────────────────────────────────
  let modalEl = null; // .xy-sl-modal
  let currentAnchor = null;
  let currentSellers = []; // 原始 mock 列表
  let currentMode = 'price'; // 'price' / 'delivery'
  let currentSku = 'demo';
  let loadTimer = null;

  // ────────────────────────────────────────────────────────────
  // 行渲染
  // ────────────────────────────────────────────────────────────
  function renderSellerRow(seller, stats) {
    const isMin = stats.minPrice != null && seller.priceNum === stats.minPrice;
    const isFastest = stats.fastestRank != null && seller.deliveryRank === stats.fastestRank;
    const rowClasses = ['xy-sl-seller-row'];
    if (isMin) rowClasses.push('is-min');
    else if (isFastest) rowClasses.push('is-fastest');

    // 头像:有 avatar 用图片,否则首字母色块
    const initial = (seller.name || '?').trim().charAt(0).toUpperCase() || '?';
    const avatarHtml = seller.avatar
      ? `<img class="xy-sl-avatar" src="${esc(seller.avatar)}" alt="">`
      : `<span class="xy-sl-avatar xy-sl-avatar-fallback" style="background:#94a3b8">${esc(initial)}</span>`;

    // 价格(最低价加 is-min + 「最低」tag)
    let priceHtml = `<span class="xy-sl-price${isMin ? ' is-min' : ''}">${esc(seller.price)}`;
    if (isMin) priceHtml += ' <span class="xy-sl-tag is-price">最低</span>';
    priceHtml += '</span>';

    // 配送(最快加「最快」tag)
    let deliveryHtml = '<span class="xy-sl-delivery-text">';
    deliveryHtml += `<span class="xy-sl-delivery-main">${esc(seller.deliveryText)}</span>`;
    if (isFastest) deliveryHtml += ' <span class="xy-sl-tag is-delivery">最快</span>';
    deliveryHtml += '</span>';

    return (
      `<div class="${rowClasses.join(' ')}">` +
      `<div class="xy-sl-cell xy-sl-avatar-cell">${avatarHtml}</div>` +
      '<div class="xy-sl-cell xy-sl-name-cell">' +
      `<a class="xy-sl-name" href="${esc(seller.link)}" target="_blank">${esc(seller.name)}</a>` +
      '<div class="xy-sl-meta">' +
      `<span class="xy-sl-rating">★ ${esc(seller.rating)}</span>` +
      `<span class="xy-sl-reviews">${seller.reviewsCount}评</span>` +
      `<span class="xy-sl-region">${esc(seller.region)}</span>` +
      `<span class="xy-sl-sku">SKU ${esc(seller.sku)}</span>` +
      '</div>' +
      '</div>' +
      `<div class="xy-sl-cell xy-sl-price-cell">${priceHtml}</div>` +
      `<div class="xy-sl-cell xy-sl-delivery-cell">${deliveryHtml}</div>` +
      '</div>'
    );
  }

  function renderSkeleton() {
    const row =
      '<div class="xy-sl-seller-row is-skeleton">' +
      '<div class="xy-sl-cell xy-sl-avatar-cell"><span class="xy-sl-skeleton xy-sl-skeleton-circle"></span></div>' +
      '<div class="xy-sl-cell xy-sl-name-cell">' +
      '<span class="xy-sl-skeleton xy-sl-skeleton-line" style="width: 60%"></span>' +
      '<span class="xy-sl-skeleton xy-sl-skeleton-line" style="width: 80%; margin-top: 6px"></span>' +
      '</div>' +
      '<div class="xy-sl-cell xy-sl-price-cell"><span class="xy-sl-skeleton xy-sl-skeleton-line" style="width: 70px"></span></div>' +
      '<div class="xy-sl-cell xy-sl-delivery-cell"><span class="xy-sl-skeleton xy-sl-skeleton-line" style="width: 90px"></span></div>' +
      '</div>';
    return row.repeat(5);
  }

  function renderEmpty() {
    return '<div class="xy-sl-empty">暂无跟卖商家</div>';
  }

  // ────────────────────────────────────────────────────────────
  // 弹窗 DOM 构建
  // ────────────────────────────────────────────────────────────
  function buildModal() {
    const modal = document.createElement('div');
    modal.className = 'xy-sl-modal';
    modal.id = 'xy-seller-list-modal';
    modal.innerHTML =
      '<div class="xy-sl-header">' +
      '<div class="xy-sl-title-row">' +
      '<span class="xy-sl-title">跟卖商家列表</span>' +
      '<span class="xy-sl-count" data-el="count">0</span>' +
      '</div>' +
      '<button class="xy-sl-close" data-action="close" type="button">×</button>' +
      '</div>' +
      '<div class="xy-sl-tabs">' +
      '<button class="xy-sl-tab" data-seller-mode="delivery" type="button">更快配送</button>' +
      '<button class="xy-sl-tab is-active" data-seller-mode="price" type="button">较低价格</button>' +
      '</div>' +
      '<div class="xy-sl-body" data-el="body"></div>' +
      '<div class="xy-sl-footer"></div>';
    return modal;
  }

  // ────────────────────────────────────────────────────────────
  // 渲染 ready 列表(排序 + 统计 + 计数 + footer)
  // ────────────────────────────────────────────────────────────
  function renderReady() {
    if (!modalEl) return;
    const stats = sellerListStats(currentSellers);
    const sorted = sortSellers(currentSellers, currentMode);
    const body = modalEl.querySelector('[data-el="body"]');
    if (body) {
      body.innerHTML = sorted.length ? sorted.map((s) => renderSellerRow(s, stats)).join('') : renderEmpty();
    }
    const countEl = modalEl.querySelector('[data-el="count"]');
    if (countEl) countEl.textContent = String(currentSellers.length);
    const footer = modalEl.querySelector('.xy-sl-footer');
    if (footer) {
      const href = `https://www.ozon.ru/product/${encodeURIComponent(currentSku)}/?prefer_sellers=true`;
      footer.innerHTML = `<a class="xy-sl-cta" href="${esc(href)}" target="_blank">在 Ozon 查看完整列表 →</a>`;
    }
  }

  function showSkeleton() {
    if (!modalEl) return;
    const body = modalEl.querySelector('[data-el="body"]');
    if (body) body.innerHTML = renderSkeleton();
  }

  // ────────────────────────────────────────────────────────────
  // 事件处理
  // ────────────────────────────────────────────────────────────
  function onModalClick(e) {
    const target = e.target.closest('[data-action]');
    if (target) {
      const act = target.getAttribute('data-action');
      if (act === 'close') {
        close();
        return;
      }
    }
    // Tab 切换
    const tabBtn = e.target.closest('[data-seller-mode]');
    if (tabBtn) {
      const mode = tabBtn.getAttribute('data-seller-mode');
      if (!mode || mode === currentMode) return;
      const tabs = modalEl ? modalEl.querySelectorAll('.xy-sl-tab') : null;
      if (tabs) {
        tabs.forEach((t) => t.classList.remove('is-active'));
      }
      tabBtn.classList.add('is-active');
      currentMode = mode;
      renderReady();
    }
  }

  // 外部点击关闭:target 不在 modal 也不在 anchor → close
  function onOutsideClick(e) {
    if (!modalEl) return;
    if (modalEl.contains(e.target)) {
      // 内部点击:不关闭,重新绑定外部监听(once 已被消费)
      document.addEventListener('click', onOutsideClick, { once: true });
      return;
    }
    if (currentAnchor && currentAnchor.contains(e.target)) {
      document.addEventListener('click', onOutsideClick, { once: true });
      return;
    }
    close();
  }

  // ────────────────────────────────────────────────────────────
  // 模块 API
  // ────────────────────────────────────────────────────────────
  function show(anchorEl, productData) {
    close(); // 先关已有的
    currentMode = 'price';
    currentSellers = [];
    currentSku = productData && productData.sku != null ? String(productData.sku) : 'demo';
    currentAnchor = anchorEl || null;

    modalEl = buildModal();
    document.body.appendChild(modalEl);

    // 定位:对齐 anchor,水平居中,垂直优先下方,不够翻上方
    const rect = anchorEl ? anchorEl.getBoundingClientRect() : { left: 80, top: 80, width: 0, bottom: 80 };
    const modalWidth = Math.min(720, window.innerWidth - 24);
    const modalHeight = Math.min(620, window.innerHeight - 20);
    let left = rect.left + rect.width / 2 - modalWidth / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - modalWidth - 10));
    let top = rect.bottom + 8;
    if (top + modalHeight > window.innerHeight) {
      top = rect.top - modalHeight - 8;
    }
    modalEl.style.top = `${top}px`;
    modalEl.style.left = `${left}px`;

    // 事件委托
    modalEl.addEventListener('click', onModalClick);

    // 加载态:先 skeleton,300ms 后渲染 mock
    showSkeleton();
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      currentSellers = generateMockSellers(currentSku);
      renderReady();
    }, 300);

    // 外部点击关闭
    setTimeout(() => {
      document.addEventListener('click', onOutsideClick, { once: true });
    }, 0);
  }

  function close() {
    clearTimeout(loadTimer);
    document.removeEventListener('click', onOutsideClick);
    if (modalEl) {
      modalEl.removeEventListener('click', onModalClick);
      modalEl.remove();
      modalEl = null;
    }
    currentAnchor = null;
    currentSellers = [];
    currentMode = 'price';
    currentSku = 'demo';
  }

  // ────────────────────────────────────────────────────────────
  // 导出
  // ────────────────────────────────────────────────────────────
  self.JZSellerListModal = {
    show,
    close,
  };
})();
