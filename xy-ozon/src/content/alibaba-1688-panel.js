// 1688 采集面板 —— 浮动卡片,支持拖拽、收起为圆球、状态持久化。
// 对齐原项目 jzc-1688-* 视觉,前缀替换为 xy-1688-*;后端全部 mock。

(function () {
  'use strict';

  const STORAGE_KEY = 'xy-1688-float';
  const PANEL_ID = 'xy-1688-panel';

  // ────────────────────────────────────────────────────────────
  // 持久化状态:{ collapsed, left, top }
  // ────────────────────────────────────────────────────────────
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { collapsed: false, left: null, top: null };
      const s = JSON.parse(raw);
      return {
        collapsed: !!s.collapsed,
        left: typeof s.left === 'number' ? s.left : null,
        top: typeof s.top === 'number' ? s.top : null,
      };
    } catch {
      return { collapsed: false, left: null, top: null };
    }
  }

  function saveState(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* 忽略写入异常 */
    }
  }

  // ────────────────────────────────────────────────────────────
  // Toast 轻提示(顶部居中)
  // ────────────────────────────────────────────────────────────
  function toast(msg, type = 'info') {
    let host = document.getElementById('xy-1688-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'xy-1688-toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `xy-1688-toast is-${type}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 300);
    }, 1800);
  }

  // ────────────────────────────────────────────────────────────
  // 从页面 DOM 抓取 1688 商品数据(mock 简化版)
  // ────────────────────────────────────────────────────────────
  function buildPayload() {
    const title = document.querySelector('h1.title')?.textContent || document.title || '1688 商品';
    const priceEl = document.querySelector('.price, .mod-detail-price');
    const price = priceEl?.textContent?.trim() || '¥0';
    const imgEl = document.querySelector('.detail-gallery-img, img.main-pic, img[data-role="main"]');
    const mainImage = imgEl?.src || '';
    const offerId = location.pathname.match(/offer\/(\d+)/)?.[1] || String(Date.now());
    return {
      sku: offerId,
      offerId,
      title,
      mainImages: mainImage ? [mainImage] : [],
      price,
      priceRange: price,
      seller: { name: 'Demo 供应商', shopUrl: location.href },
      url: location.href,
    };
  }

  // ────────────────────────────────────────────────────────────
  // 构建 DOM
  // ────────────────────────────────────────────────────────────
  function buildPanel() {
    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.innerHTML = `
      <div class="xy-1688-card">
        <div class="xy-1688-brand">
          <span class="xy-1688-logo">M</span>
          <span class="xy-1688-name">MY</span>
          <span class="xy-1688-collapse" data-action="collapse" title="收起">—</span>
        </div>
        <div class="xy-1688-divider"></div>
        <button class="xy-1688-action" data-action="copy-image" type="button">
          <span class="xy-1688-action-icon">🖼️</span>
          <span class="xy-1688-action-label">复制图片</span>
        </button>
        <button class="xy-1688-action" data-action="collect-product" type="button">
          <span class="xy-1688-action-icon">📦</span>
          <span class="xy-1688-action-label">采集商品</span>
        </button>
        <button class="xy-1688-action is-primary" data-action="manual-listing" type="button">
          <span class="xy-1688-action-icon">🚀</span>
          <span class="xy-1688-action-label">手动上架</span>
          <span class="xy-1688-hot">HOT</span>
        </button>
        <button class="xy-1688-action is-primary" data-action="ai-wizard" type="button">
          <span class="xy-1688-action-icon">🤖</span>
          <span class="xy-1688-action-label">AI 采集</span>
          <span class="xy-1688-hot">AI</span>
        </button>
      </div>
      <div class="xy-1688-ball" title="展开MY">M</div>
    `;
    return root;
  }

  // 应用位置(同时同步 card 与 ball,ball 为 position:fixed)
  function applyPosition(el, state) {
    if (state.left != null && state.top != null) {
      el.style.left = `${state.left}px`;
      el.style.top = `${state.top}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    } else {
      el.style.left = '';
      el.style.top = '';
      el.style.right = '';
      el.style.bottom = '';
    }
  }

  function applyState(root, state) {
    const card = root.querySelector('.xy-1688-card');
    const ball = root.querySelector('.xy-1688-ball');
    applyPosition(root, state);
    applyPosition(ball, state);
    if (state.collapsed) {
      card.style.display = 'none';
      ball.style.display = 'flex';
    } else {
      card.style.display = 'block';
      ball.style.display = 'none';
    }
  }

  // ────────────────────────────────────────────────────────────
  // 拖拽逻辑(brand 区为 handle)
  // ────────────────────────────────────────────────────────────
  function bindDrag(root) {
    const handle = root.querySelector('.xy-1688-brand');
    const ball = root.querySelector('.xy-1688-ball');
    let dragging = false;
    let startMouseX = 0;
    let startMouseY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener('mousedown', (e) => {
      // 点击收起按钮不触发拖拽
      if (e.target.closest('[data-action="collapse"]')) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      startMouseX = e.clientX;
      startMouseY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      root.classList.add('xy-1688-dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;
      // 约束在视口内(至少留 60px 可见)
      const maxLeft = window.innerWidth - 60;
      const maxTop = window.innerHeight - 60;
      const newLeft = Math.max(0, Math.min(maxLeft, startLeft + dx));
      const newTop = Math.max(0, Math.min(maxTop, startTop + dy));
      // 同步 root 与 ball 位置
      [root, ball].forEach((el) => {
        el.style.left = `${newLeft}px`;
        el.style.top = `${newTop}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      });
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      root.classList.remove('xy-1688-dragging');
      const rect = root.getBoundingClientRect();
      const state = loadState();
      state.left = Math.round(rect.left);
      state.top = Math.round(rect.top);
      saveState(state);
    });
  }

  // ────────────────────────────────────────────────────────────
  // 按钮事件(data-action)
  // ────────────────────────────────────────────────────────────
  function bindActions(root) {
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      switch (action) {
        case 'collapse': {
          root.querySelector('.xy-1688-card').style.display = 'none';
          root.querySelector('.xy-1688-ball').style.display = 'flex';
          const s = loadState();
          s.collapsed = true;
          saveState(s);
          break;
        }
        case 'copy-image': {
          const payload = buildPayload();
          const img = payload.mainImages[0];
          if (!img) {
            toast('未找到图片', 'error');
            return;
          }
          // mock 复制到剪贴板
          try {
            navigator.clipboard?.writeText(img);
          } catch {
            /* 忽略 */
          }
          toast('已复制图片链接');
          break;
        }
        case 'collect-product': {
          buildPayload();
          toast('已加入采集箱(mock)');
          break;
        }
        case 'manual-listing': {
          buildPayload();
          toast('已打开编辑器(mock)');
          break;
        }
        case 'ai-wizard': {
          const raw = buildPayload();
          if (self.JZAIWizard?.open) {
            self.JZAIWizard.open(raw);
          } else {
            toast('AI 向导未加载', 'error');
          }
          break;
        }
        default:
          break;
      }
    });

    // 圆球点击展开
    root.querySelector('.xy-1688-ball').addEventListener('click', () => {
      root.querySelector('.xy-1688-card').style.display = 'block';
      root.querySelector('.xy-1688-ball').style.display = 'none';
      const s = loadState();
      s.collapsed = false;
      saveState(s);
    });
  }

  // ────────────────────────────────────────────────────────────
  // mount / unmount
  // ────────────────────────────────────────────────────────────
  function mount() {
    if (document.getElementById(PANEL_ID)) return;
    const root = buildPanel();
    document.body.appendChild(root);
    applyState(root, loadState());
    bindDrag(root);
    bindActions(root);
  }

  function unmount() {
    document.getElementById(PANEL_ID)?.remove();
    const host = document.getElementById('xy-1688-toast-host');
    if (host) host.remove();
  }

  self.JZAlibaba1688Panel = { mount, unmount };
})();
