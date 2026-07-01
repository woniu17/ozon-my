// 商品页右侧栏数据卡 —— 复刻原项目 createSidebarDataCard。
// 蓝色渐变 header + hero 4 卡（月销/上架/跟卖/重量尺寸）+ 5 个可折叠分组 + 一键上架/编辑/采集按钮。

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // CSS（全部 xy- 前缀，通过 <style> 注入 document.head）
  // ────────────────────────────────────────────────────────────
  const CSS_TEXT = `
.xy-sidebar-card {
  --xy-card-radius: 14px;
  --xy-border: #eef2f6;
  --xy-label: #94a3b8;
  --xy-value: #0f172a;
  --xy-muted: #cbd5e1;
  --xy-section-bg: #f8fafc;
  width: 100%;
  flex: 1 1 auto;
  align-self: stretch;
  margin-top: 12px;
  border-radius: 14px;
  border: 1px solid rgba(15, 23, 42, 0.05);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 24px rgba(15, 23, 42, 0.06);
  background: #fff;
  font-size: 12px;
  font-family: inherit;
  overflow: hidden;
}

/* ── Header ───────────────────────────────────────── */
.xy-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: linear-gradient(135deg, #1d6bff, #1452cc);
  color: #fff;
  border-radius: 14px 14px 0 0;
}
.xy-sidebar-logo {
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 700;
  font-size: 13px;
}
.xy-sidebar-logo-icon {
  font-size: 14px;
}
.xy-sidebar-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.xy-sidebar-gear,
.xy-sidebar-close {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.18);
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: transform 0.2s, background 0.2s;
}
.xy-sidebar-gear:hover {
  transform: rotate(45deg);
  background: rgba(255, 255, 255, 0.3);
}
.xy-sidebar-close:hover {
  transform: rotate(90deg);
  background: rgba(255, 255, 255, 0.3);
}

/* ── Body ─────────────────────────────────────────── */
.xy-sidebar-body {
  display: flex;
  flex-direction: column;
}

/* ── Hero ─────────────────────────────────────────── */
.xy-hero-section {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--xy-border);
}
.xy-hero-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px 8px;
  border-radius: 10px;
  border: 1px solid #e2e8f0;
  background: #f5f8fc;
  min-height: 76px;
  transition: transform 0.15s, box-shadow 0.15s;
}
.xy-hero-stat:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.08);
}
.xy-hero-stat.is-clickable {
  cursor: pointer;
}
.xy-hero-label {
  font-size: 11px;
  color: #64748b;
  font-weight: 500;
}
.xy-hero-value {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 18px;
  font-weight: 800;
  font-family: 'JetBrains Mono', 'Consolas', monospace;
  line-height: 1.1;
}
.xy-hero-value small {
  font-size: 11px;
  font-weight: 500;
  color: #94a3b8;
  margin-top: 2px;
}
/* accent 色调 */
.xy-hero-stat.is-accent-blue {
  background: #e8f0ff;
  border-color: #c7dbff;
}
.xy-hero-stat.is-accent-blue .xy-hero-value {
  color: #1d6bff;
}
.xy-hero-stat.is-accent-green {
  background: #e6f7ec;
  border-color: #b8e6c5;
}
.xy-hero-stat.is-accent-green .xy-hero-value {
  color: #16a34a;
}
.xy-hero-stat.is-accent-orange {
  background: #fff0e6;
  border-color: #ffd0a8;
}
.xy-hero-stat.is-accent-orange .xy-hero-value {
  color: #ea580c;
}
.xy-hero-stat.is-accent-purple {
  background: #f0e8ff;
  border-color: #d4c2ff;
}
.xy-hero-stat.is-accent-purple .xy-hero-value {
  color: #7c3aed;
}

/* ── Section ──────────────────────────────────────── */
.xy-sidebar-section {
  border-bottom: 1px solid var(--xy-border);
}
.xy-sidebar-section:last-child {
  border-bottom: none;
}
.xy-sidebar-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 7px 14px 7px 12px;
  background: var(--xy-section-bg);
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  color: #475569;
  border-left: 3px solid transparent;
  transition: padding-left 0.15s;
  user-select: none;
}
.xy-sidebar-section-header:hover {
  padding-left: 14px;
}
.xy-sidebar-section-header > span:first-child {
  display: flex;
  align-items: center;
  gap: 4px;
}
.xy-section-icon {
  font-size: 12px;
}
.xy-sidebar-chevron {
  font-size: 9px;
  color: #cbd5e1;
  transition: transform 0.25s;
}
.xy-sidebar-section:has(.xy-sidebar-section-body.is-collapsed) .xy-sidebar-chevron {
  transform: rotate(-90deg);
}
/* accent border-left */
.xy-sidebar-section.is-accent-blue > .xy-sidebar-section-header {
  border-left-color: #1d6bff;
}
.xy-sidebar-section.is-accent-green > .xy-sidebar-section-header {
  border-left-color: #16a34a;
}
.xy-sidebar-section.is-accent-orange > .xy-sidebar-section-header {
  border-left-color: #ea580c;
}
.xy-sidebar-section.is-accent-purple > .xy-sidebar-section-header {
  border-left-color: #7c3aed;
}
.xy-sidebar-section.is-accent-pink > .xy-sidebar-section-header {
  border-left-color: #db2777;
}
.xy-sidebar-section-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  max-height: 600px;
  padding: 10px 14px 12px;
  transition: max-height 0.25s, padding 0.25s;
}
.xy-sidebar-section-body.is-collapsed {
  max-height: 0;
  padding: 0 14px;
  overflow: hidden;
}

/* ── Row ──────────────────────────────────────────── */
.xy-sidebar-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 1px 0;
  transition: background 0.15s;
}
.xy-sidebar-row:hover {
  background: rgba(99, 102, 241, 0.03);
}
.xy-sidebar-label {
  color: var(--xy-label);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.xy-sidebar-value {
  color: var(--xy-value);
  font-weight: 600;
  font-size: 12px;
  text-align: right;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
.xy-sidebar-value.is-blue {
  color: #2563eb;
}
.xy-sidebar-value.is-green {
  color: #16a34a;
}
.xy-sidebar-value.is-red {
  color: #ef4444;
}
.xy-sidebar-value.is-orange {
  color: #ea580c;
}
.xy-sidebar-value.is-dim {
  color: #cbd5e1;
}

/* ── Actions ──────────────────────────────────────── */
.xy-sidebar-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--xy-border);
  background: linear-gradient(180deg, #fafbfc, #f5f7fa);
}
.xy-sidebar-actions-row {
  display: flex;
  gap: 8px;
}
.xy-sidebar-actions-row .xy-sidebar-btn {
  flex: 1;
}
.xy-sidebar-btn {
  flex: 1;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
  font-size: 12px;
  font-weight: 600;
  color: #0f172a;
  cursor: pointer;
  transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.xy-sidebar-btn:hover {
  border-color: #1d6bff;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(29, 107, 255, 0.15);
}
.xy-sidebar-btn.is-primary {
  min-height: 42px;
  font-size: 13px;
  background: linear-gradient(135deg, #1d6bff, #1452cc);
  color: #fff;
  border: none;
}
.xy-sidebar-btn.is-primary:hover {
  box-shadow: 0 6px 16px rgba(29, 107, 255, 0.35);
}

/* ── Toast ────────────────────────────────────────── */
.xy-sidebar-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%) translateY(20px);
  background: rgba(15, 23, 42, 0.92);
  color: #fff;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  z-index: 2147483647;
  opacity: 0;
  transition: opacity 0.2s, transform 0.2s;
  pointer-events: none;
}
.xy-sidebar-toast.xy-sidebar-toast-show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
`;

  // ────────────────────────────────────────────────────────────
  // 配置：Hero 4 卡
  // ────────────────────────────────────────────────────────────
  const HERO_CARDS = [
    { field: 'sales30d', label: '月销量', accent: 'blue', clickable: false, sub: null },
    { field: 'createDate', label: '上架时间', accent: 'green', clickable: false, sub: null },
    {
      field: 'heroFollow',
      label: '跟卖',
      accent: 'orange',
      clickable: true,
      clickAction: 'show-followsell-modal',
      sub: '卖家',
    },
    { field: 'heroSize', label: '重量·尺寸', accent: 'purple', clickable: false, sub: '—' },
  ];

  // ────────────────────────────────────────────────────────────
  // 配置：5 个可折叠分组
  // ────────────────────────────────────────────────────────────
  const SECTIONS = [
    {
      id: 'info',
      title: '商品信息',
      accent: 'blue',
      icon: '📦',
      rows: [
        { label: 'SKU', field: 'sku' },
        { label: '标题', field: 'title' },
        { label: '品牌', field: 'brand' },
        { label: '类目', field: 'category' },
        { label: '原价', field: 'originalPrice' },
        { label: '评分', field: 'rating' },
        { label: '评论数', field: 'reviews' },
        { label: '收藏数', field: 'favorites' },
      ],
    },
    {
      id: 'promo',
      title: '促销推广',
      accent: 'orange',
      icon: '🎯',
      rows: [
        { label: '促销价格', field: 'promoPrice' },
        { label: '促销转化率', field: 'promoConversionRate' },
        { label: '广告费占比', field: 'adSpendRatio' },
        { label: '促销天数', field: 'promoDays' },
      ],
    },
    {
      id: 'traffic',
      title: '流量转化',
      accent: 'green',
      icon: '📊',
      rows: [
        { label: '商品卡浏览量', field: 'cardViews' },
        { label: '加购率', field: 'addToCartRate' },
        { label: '搜索目录浏览量', field: 'searchCatalogViews' },
        { label: '搜索目录加购率', field: 'searchCatalogAddToCartRate' },
        { label: '展示转化率', field: 'impressionConversionRate' },
        { label: '退货取消率', field: 'returnCancelRate' },
      ],
    },
    {
      id: 'logistics',
      title: '物流详情',
      accent: 'purple',
      icon: '🚚',
      rows: [
        { label: '发货模式', field: 'shippingMode' },
        { label: '仓库', field: 'warehouse' },
        { label: '配送时长', field: 'deliveryDays' },
        { label: '包装重量', field: 'packageWeight' },
        { label: '包装尺寸', field: 'packageSize' },
      ],
    },
    {
      id: 'follow',
      title: '跟卖信息',
      accent: 'pink',
      icon: '🔗',
      rows: [
        { label: '跟卖人数', field: 'followCount' },
        { label: '跟卖最低价', field: 'followMinPrice' },
      ],
    },
  ];

  // ────────────────────────────────────────────────────────────
  // 状态
  // ────────────────────────────────────────────────────────────
  let currentCard = null;

  // ────────────────────────────────────────────────────────────
  // 工具函数
  // ────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('xy-sidebar-card-styles')) return;
    const style = document.createElement('style');
    style.id = 'xy-sidebar-card-styles';
    style.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'xy-sidebar-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    // 强制 reflow 触发 transition
    void t.offsetWidth;
    t.classList.add('xy-sidebar-toast-show');
    setTimeout(() => {
      t.classList.remove('xy-sidebar-toast-show');
      setTimeout(() => t.remove(), 220);
    }, 2500);
  }

  // ────────────────────────────────────────────────────────────
  // 渲染：Hero 卡
  // ────────────────────────────────────────────────────────────
  function renderHeroCard(h) {
    const clickableCls = h.clickable ? ' is-clickable' : '';
    const clickAttr = h.clickable ? ` data-click-action="${h.clickAction}"` : '';
    const subHtml = h.sub != null ? `<small>${h.sub}</small>` : '';
    return `
      <div class="xy-hero-stat is-accent-${h.accent}${clickableCls}"${clickAttr}>
        <div class="xy-hero-label">${h.label}</div>
        <div class="xy-hero-value" data-field="${h.field}">—${subHtml}</div>
      </div>
    `;
  }

  // ────────────────────────────────────────────────────────────
  // 渲染：行
  // ────────────────────────────────────────────────────────────
  function renderRow(r) {
    return `
      <div class="xy-sidebar-row">
        <span class="xy-sidebar-label">${r.label}</span>
        <span class="xy-sidebar-value" data-field="${r.field}">—</span>
      </div>
    `;
  }

  // ────────────────────────────────────────────────────────────
  // 渲染：分组 section
  // ────────────────────────────────────────────────────────────
  function renderSection(s) {
    return `
      <div class="xy-sidebar-section is-accent-${s.accent}" data-section="${s.id}">
        <div class="xy-sidebar-section-header" data-action="toggle-section">
          <span><span class="xy-section-icon">${s.icon}</span>${s.title}</span>
          <span class="xy-sidebar-chevron">▼</span>
        </div>
        <div class="xy-sidebar-section-body">
          ${s.rows.map(renderRow).join('')}
        </div>
      </div>
    `;
  }

  // ────────────────────────────────────────────────────────────
  // 创建卡片 DOM
  // ────────────────────────────────────────────────────────────
  function createCard() {
    const card = document.createElement('div');
    card.className = 'xy-sidebar-card';
    card.innerHTML = `
      <div class="xy-sidebar-header">
        <span class="xy-sidebar-logo">
          <span class="xy-sidebar-logo-icon">⚡</span>MY ERP
        </span>
        <div class="xy-sidebar-header-actions">
          <button class="xy-sidebar-gear" title="字段设置" data-action="settings">⚙</button>
          <button class="xy-sidebar-close" data-action="close" title="关闭">×</button>
        </div>
      </div>
      <div class="xy-sidebar-body">
        <div class="xy-hero-section">
          ${HERO_CARDS.map(renderHeroCard).join('')}
        </div>
        ${SECTIONS.map(renderSection).join('')}
      </div>
      <div class="xy-sidebar-actions">
        <button class="xy-sidebar-btn is-primary" data-action="quick-list">⚡ 一键上架</button>
        <div class="xy-sidebar-actions-row">
          <button class="xy-sidebar-btn" data-action="edit-list">✏ 编辑上架</button>
          <button class="xy-sidebar-btn" data-action="collect-one">📥 采集</button>
        </div>
      </div>
    `;
    return card;
  }

  // ────────────────────────────────────────────────────────────
  // 绑定事件
  // ────────────────────────────────────────────────────────────
  function bindEvents(card) {
    // 关闭
    card.querySelector('[data-action="close"]').addEventListener('click', () => {
      unmount();
    });

    // 字段设置齿轮
    card.querySelector('[data-action="settings"]').addEventListener('click', () => {
      console.log('[JZSidebarCard] 字段设置');
      showToast('字段设置开发中');
    });

    // 一键上架
    card.querySelector('[data-action="quick-list"]').addEventListener('click', () => {
      if (self.JZFollowSellPanel && typeof self.JZFollowSellPanel.toggle === 'function') {
        self.JZFollowSellPanel.toggle();
      } else {
        console.warn('[JZSidebarCard] JZFollowSellPanel.toggle 不可用');
      }
    });

    // 编辑上架
    card.querySelector('[data-action="edit-list"]').addEventListener('click', () => {
      console.log('[JZSidebarCard] edit-list');
      showToast('功能开发中');
    });

    // 采集
    card.querySelector('[data-action="collect-one"]').addEventListener('click', () => {
      console.log('[JZSidebarCard] collect-one');
      showToast('功能开发中');
    });

    // 折叠/展开分组
    card.querySelectorAll('[data-action="toggle-section"]').forEach((header) => {
      header.addEventListener('click', () => {
        const section = header.closest('.xy-sidebar-section');
        const body = section.querySelector('.xy-sidebar-section-body');
        const collapsed = body.classList.toggle('is-collapsed');
        const sectionId = section.dataset.section;
        try {
          sessionStorage.setItem(`xy-sidebar-collapsed-${sectionId}`, collapsed ? '1' : '0');
        } catch {}
      });
    });

    // Hero 跟卖卡点击
    card.querySelectorAll('[data-click-action="show-followsell-modal"]').forEach((el) => {
      el.addEventListener('click', () => {
        console.log('[JZSidebarCard] show-followsell-modal');
        showToast('跟卖商家列表开发中');
      });
    });
  }

  // ────────────────────────────────────────────────────────────
  // 恢复折叠状态（从 sessionStorage）
  // ────────────────────────────────────────────────────────────
  function restoreCollapsed(card) {
    SECTIONS.forEach((s) => {
      const section = card.querySelector(`[data-section="${s.id}"]`);
      if (!section) return;
      const body = section.querySelector('.xy-sidebar-section-body');
      if (!body) return;
      try {
        if (sessionStorage.getItem(`xy-sidebar-collapsed-${s.id}`) === '1') {
          body.classList.add('is-collapsed');
        }
      } catch {}
    });
  }

  // ────────────────────────────────────────────────────────────
  // 挂载到 webStickyColumn 内 webSale 之后
  // ────────────────────────────────────────────────────────────
  function doMount(sticky) {
    if (currentCard) unmount();
    const card = createCard();
    const sale = sticky.querySelector('[data-widget="webSale"]');
    if (sale && sale.parentNode === sticky) {
      sale.after(card);
    } else {
      sticky.appendChild(card);
    }
    currentCard = card;
    bindEvents(card);
    restoreCollapsed(card);
    refresh();
  }

  // ────────────────────────────────────────────────────────────
  // 挂载重试（5 秒间隔，最多 3 次）
  // ────────────────────────────────────────────────────────────
  function tryMount(retryCount) {
    const sticky = document.querySelector('[data-widget="webStickyColumn"]');
    if (sticky) {
      doMount(sticky);
      return;
    }
    if (retryCount < 3) {
      console.warn(`[JZSidebarCard] 挂载点 webStickyColumn 未就绪,5 秒后重试 (${retryCount + 1}/3)`);
      setTimeout(() => tryMount(retryCount + 1), 5000);
    } else {
      console.warn('[JZSidebarCard] 挂载点 webStickyColumn 未找到,已放弃挂载');
    }
  }

  // ────────────────────────────────────────────────────────────
  // 数据填充：调用 extractProductData 填充基础字段
  // 需 seller portal 的字段（月销/跟卖/评分等）暂显示 —
  // ────────────────────────────────────────────────────────────
  function refresh() {
    if (!currentCard) return;
    let data = {};
    try {
      data = self.JZProductExtractor.extractProductData() || {};
    } catch (e) {
      console.warn('[JZSidebarCard] extractProductData 失败:', e);
      return;
    }
    const fillMap = {
      sku: data.sku || '—',
      title: data.title || '—',
      brand: data.brand || '—',
      category: data.breadcrumbs && data.breadcrumbs.length ? data.breadcrumbs.join(' / ') : '—',
      originalPrice: data.price ? `${data.price} ${data.currency || 'RUB'}` : '—',
    };
    Object.entries(fillMap).forEach(([field, val]) => {
      const el = currentCard.querySelector(`[data-field="${field}"]`);
      if (el) el.textContent = val;
    });
  }

  // ────────────────────────────────────────────────────────────
  // 卸载
  // ────────────────────────────────────────────────────────────
  function unmount() {
    if (currentCard) {
      currentCard.remove();
      currentCard = null;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 挂载入口
  // ────────────────────────────────────────────────────────────
  function mount() {
    injectStyles();
    tryMount(0);
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API
  // ────────────────────────────────────────────────────────────
  self.JZSidebarCard = {
    mount,
    unmount,
    refresh,
  };
})();
