// 跨境货源浮动面板 —— 从原项目 0.13.31.1 抽离的 Demo。
// 注入到 9 个跨境平台商品页(京东/拼多多批发/淘宝天猫/Amazon/Wildberries/Temu/Mercado Libre/Yandex Market/SHEIN)。
// UI 复刻 1688 采集面板视觉与交互,后端用 mock,所有 class / localStorage key / 全局变量均用 `xy-cn-` 前缀。
// 注意:跨境货源面板没有 ai-wizard 按钮(只有 1688 面板有)。

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 平台检测配置(9 平台)
  // ────────────────────────────────────────────────────────────
  const PLATFORM_CONFIGS = {
    jd: { displayName: '京东', hostPattern: /item\.(jd|m\.jd)\.com/ },
    pdd: { displayName: '拼多多批发', hostPattern: /pifa\.pinduoduo\.com/ },
    taobao: { displayName: '淘宝/天猫', hostPattern: /(item\.taobao|detail\.tmall|.*\.tmall)\.com/ },
    amazon: { displayName: 'Amazon', hostPattern: /.*\.amazon\./ },
    wb: { displayName: 'Wildberries', hostPattern: /wildberries\.ru/ },
    temu: { displayName: 'Temu', hostPattern: /.*\.temu\.com/ },
    mercadolibre: { displayName: 'Mercado Libre', hostPattern: /.*\.mercadolibre\./ },
    yandex: { displayName: 'Yandex Market', hostPattern: /market\.yandex\./ },
    shein: { displayName: 'SHEIN', hostPattern: /(shein\.com|.*\.shein\.)/ },
  };

  function detectPlatform() {
    const host = location.hostname;
    for (const [id, cfg] of Object.entries(PLATFORM_CONFIGS)) {
      if (cfg.hostPattern.test(host)) return { sourceId: id, ...cfg };
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // localStorage key
  // ────────────────────────────────────────────────────────────
  function posKey(sourceId) {
    return `xy-cn-source-float-${sourceId}`;
  }

  function loadState(sourceId) {
    try {
      const raw = localStorage.getItem(posKey(sourceId));
      if (!raw) return { collapsed: false, left: null, top: null };
      const parsed = JSON.parse(raw);
      return {
        collapsed: !!parsed.collapsed,
        left: typeof parsed.left === 'number' ? parsed.left : null,
        top: typeof parsed.top === 'number' ? parsed.top : null,
      };
    } catch {
      return { collapsed: false, left: null, top: null };
    }
  }

  function saveState(sourceId, patch) {
    try {
      const cur = loadState(sourceId);
      const next = { ...cur, ...patch };
      localStorage.setItem(posKey(sourceId), JSON.stringify(next));
    } catch {
      // 忽略存储异常
    }
  }

  // ────────────────────────────────────────────────────────────
  // Mock 数据抓取(从页面 DOM 抓商品数据,简化版)
  // ────────────────────────────────────────────────────────────
  function buildPayload(platform) {
    const title = document.querySelector('h1')?.textContent || document.title || `${platform.displayName} 商品`;
    const imgEl = document.querySelector('img[src*="product"], img.main-pic, img.detail-img, .gallery img, img');
    const mainImage = imgEl?.src || '';
    const priceEl = document.querySelector('.price, [class*="price"], [data-price]');
    const price = priceEl?.textContent?.trim() || '¥0';
    return {
      sku: String(Date.now()),
      title,
      mainImages: mainImage ? [mainImage] : [],
      price,
      seller: { name: 'Demo 供应商' },
      platform: platform.sourceId,
      url: location.href,
    };
  }

  // ────────────────────────────────────────────────────────────
  // Toast(固定定位,3 秒自动消失)
  // ────────────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg) {
    let t = document.querySelector('.xy-cn-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'xy-cn-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('xy-cn-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('xy-cn-toast-show');
    }, 2400);
  }

  // ────────────────────────────────────────────────────────────
  // 拖拽逻辑(panel 区为 handle)
  // ────────────────────────────────────────────────────────────
  function makeDraggable(panelEl, sourceId) {
    panelEl.addEventListener('mousedown', (e) => {
      // 点击按钮 / 折叠图标不触发拖拽
      if (e.target.closest('[data-action]')) return;
      const rect = panelEl.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      // 切换为 left/top 定位,便于自由拖拽
      panelEl.style.left = `${rect.left}px`;
      panelEl.style.top = `${rect.top}px`;
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';

      function onMove(ev) {
        let left = ev.clientX - offsetX;
        let top = ev.clientY - offsetY;
        // 限制在视口内
        const w = panelEl.offsetWidth;
        const h = panelEl.offsetHeight;
        left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
        top = Math.max(4, Math.min(top, window.innerHeight - h - 4));
        panelEl.style.left = `${left}px`;
        panelEl.style.top = `${top}px`;
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // 持久化位置
        const left = parseFloat(panelEl.style.left);
        const top = parseFloat(panelEl.style.top);
        if (!Number.isNaN(left) && !Number.isNaN(top)) {
          saveState(sourceId, { left, top });
        }
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  // ────────────────────────────────────────────────────────────
  // 挂载 / 卸载
  // ────────────────────────────────────────────────────────────
  let platformRef = null;

  function mount() {
    const platform = detectPlatform();
    if (!platform) return; // 不在支持的平台上,不挂载
    if (document.getElementById('xy-cn-source-panel')) return; // 已挂载

    platformRef = platform;
    const state = loadState(platform.sourceId);

    const root = document.createElement('div');
    root.id = 'xy-cn-source-panel';
    if (state.collapsed) root.classList.add('xy-cn-is-collapsed');
    // 位置:优先用持久化位置,否则用默认 right/bottom
    if (state.left != null && state.top != null) {
      root.style.left = `${state.left}px`;
      root.style.top = `${state.top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }

    root.innerHTML = `
      <div class="xy-cn-card">
        <div class="xy-cn-brand">
          <span class="xy-cn-logo">M</span>
          <span class="xy-cn-name">MY</span>
          <span class="xy-cn-platform">${platform.displayName}</span>
          <span class="xy-cn-collapse" data-action="collapse" title="收起">—</span>
        </div>
        <div class="xy-cn-divider"></div>
        <button class="xy-cn-action" data-action="copy-image">
          <span class="xy-cn-action-icon">🖼️</span>
          <span class="xy-cn-action-label">复制图片</span>
        </button>
        <button class="xy-cn-action" data-action="collect-product">
          <span class="xy-cn-action-icon">📦</span>
          <span class="xy-cn-action-label">采集商品</span>
        </button>
        <button class="xy-cn-action is-primary" data-action="manual-listing">
          <span class="xy-cn-action-icon">🚀</span>
          <span class="xy-cn-action-label">手动上架</span>
          <span class="xy-cn-hot">HOT</span>
        </button>
      </div>
      <div class="xy-cn-ball" title="展开MY">M</div>
    `;

    document.body.appendChild(root);
    bindActions(root, platform);
    makeDraggable(root, platform.sourceId);
  }

  function unmount() {
    const el = document.getElementById('xy-cn-source-panel');
    if (el) el.remove();
    platformRef = null;
  }

  // ────────────────────────────────────────────────────────────
  // 按钮交互
  // ────────────────────────────────────────────────────────────
  function bindActions(root, platform) {
    // 收起 / 展开
    const collapseBtn = root.querySelector('[data-action="collapse"]');
    const ball = root.querySelector('.xy-cn-ball');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        root.classList.add('xy-cn-is-collapsed');
        saveState(platform.sourceId, { collapsed: true });
      });
    }
    if (ball) {
      ball.addEventListener('click', (e) => {
        e.stopPropagation();
        root.classList.remove('xy-cn-is-collapsed');
        saveState(platform.sourceId, { collapsed: false });
      });
    }

    // 复制图片
    const copyBtn = root.querySelector('[data-action="copy-image"]');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const payload = buildPayload(platform);
        const img = payload.mainImages[0];
        if (!img) {
          showToast('未找到图片');
          return;
        }
        // mock:尝试写入剪贴板,失败则只 toast
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(img).then(
            () => showToast('已复制图片链接'),
            () => showToast('已复制图片链接')
          );
        } else {
          showToast('已复制图片链接');
        }
      });
    }

    // 采集商品
    const collectBtn = root.querySelector('[data-action="collect-product"]');
    if (collectBtn) {
      collectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        buildPayload(platform); // 触发抓取(mock)
        showToast(`已加入采集箱(${platform.displayName} mock)`);
      });
    }

    // 手动上架
    const listBtn = root.querySelector('[data-action="manual-listing"]');
    if (listBtn) {
      listBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        buildPayload(platform); // 触发抓取(mock)
        showToast('已打开编辑器(mock)');
      });
    }
  }

  // ────────────────────────────────────────────────────────────
  // 模块导出
  // ────────────────────────────────────────────────────────────
  self.JZCnSourcePanel = {
    mount,
    unmount,
  };
})();
