// 商品页右侧浮动动作栏 —— 复刻原项目 createActionBar。
// 品牌头 + 8 个动作按钮（一键采集/模拟手动跟卖/批量上架/MY算价/1688找货源/OZON以图搜图/主题标签/进入ERP）。
// 支持拖拽移动 + 双击折叠 + 位置持久化。

(function () {
  'use strict';

  const STORAGE_POS = 'xy-bar-position';
  const STORAGE_COLLAPSED = 'xy-bar-collapsed';
  const STYLE_ID = 'xy-action-bar-style';
  const DRAG_THRESHOLD = 4; // 拖拽触发阈值(px),小于此位移视为点击

  // ────────────────────────────────────────────────────────────
  // 图标 SVG(Feather 风格 24x24 stroke)
  // ────────────────────────────────────────────────────────────
  const ICONS = {
    collect:
      '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    followSell:
      '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
    batchUpload:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    profit: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    source: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    imageSearch:
      '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    keyword:
      '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    erp: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  };

  function wrapSvg(inner) {
    return (
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      inner +
      '</svg>'
    );
  }

  // ────────────────────────────────────────────────────────────
  // 注入 CSS(只注入一次)
  // ────────────────────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .xy-action-bar {
        position: fixed;
        right: 20px;
        top: 50%;
        transform: translateY(-50%);
        z-index: 10000;
        width: 220px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 14px;
        border-radius: 18px;
        background: #fff;
        box-shadow: 0 14px 32px rgba(11, 23, 48, 0.15);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-sizing: border-box;
      }
      .xy-action-bar * {
        box-sizing: border-box;
      }
      .xy-action-bar.is-dragging {
        opacity: 0.9;
        cursor: grabbing;
        user-select: none;
      }
      .xy-action-bar.is-collapsed {
        width: auto;
        padding: 10px;
      }
      .xy-action-bar.is-collapsed .xy-bar-divider,
      .xy-action-bar.is-collapsed .xy-action-button {
        display: none;
      }

      .xy-bar-brand {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 2px 6px;
        cursor: grab;
        user-select: none;
      }
      .xy-bar-brand:active {
        cursor: grabbing;
      }
      .xy-bar-brand-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: #1d6bff;
        color: #fff;
        font-weight: 700;
        font-size: 16px;
        flex-shrink: 0;
      }
      .xy-bar-brand-name {
        font-size: 14px;
        font-weight: 700;
        color: #0b1730;
        letter-spacing: 0.2px;
      }

      .xy-bar-divider {
        width: 100%;
        height: 1px;
        background: #eaf1f9;
        margin: 4px 0;
        border: 0;
      }

      .xy-action-button {
        position: relative;
        width: 100%;
        height: 38px;
        padding: 0 12px;
        border-radius: 9px;
        font-size: 13px;
        font-weight: 600;
        text-align: left;
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        background: #f5f8fc;
        color: #0b1730;
        border: 1px solid transparent;
        font-family: inherit;
        transition: background 0.15s ease;
      }
      .xy-action-button:hover {
        background: #e8f0ff;
      }
      .xy-action-button .xy-action-icon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        color: #1d6bff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .xy-action-button .xy-action-label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .xy-action-button[data-color='purple'] {
        background: #e8f0ff;
        color: #1d6bff;
        border: 1px solid #1d6bff;
        font-weight: 700;
      }
      .xy-action-button[data-color='purple'] .xy-action-icon {
        color: #1d6bff;
      }
      .xy-action-button[data-color='purple']::after {
        content: 'HOT';
        position: absolute;
        top: -7px;
        right: -7px;
        background: #ff3b3b;
        color: #fff;
        font-size: 9px;
        font-weight: 800;
        line-height: 1;
        padding: 3px 5px;
        border-radius: 8px;
        letter-spacing: 0.4px;
        box-shadow: 0 2px 6px rgba(255, 59, 59, 0.4);
        pointer-events: none;
      }

      .xy-action-button[data-color='teal'] {
        background: #0b1730;
        color: #fff;
        font-weight: 700;
      }
      .xy-action-button[data-color='teal'] .xy-action-icon {
        color: #fff;
      }
      .xy-action-button[data-color='teal']:hover {
        background: #0b1730;
      }

      .xy-toast {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 10001;
        max-width: 300px;
        padding: 10px 14px;
        border-radius: 8px;
        background: #0b1730;
        color: #fff;
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 20px rgba(11, 23, 48, 0.25);
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .xy-toast.xy-toast-show {
        opacity: 1;
        transform: translateY(0);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ────────────────────────────────────────────────────────────
  // Toast 提示(右下角,3 秒自动消失)
  // ────────────────────────────────────────────────────────────
  function toast(msg) {
    const existing = document.querySelector('.xy-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'xy-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('xy-toast-show'));
    setTimeout(() => {
      el.classList.remove('xy-toast-show');
      setTimeout(() => el.remove(), 220);
    }, 3000);
  }

  // ────────────────────────────────────────────────────────────
  // 按钮工厂
  // ────────────────────────────────────────────────────────────
  function createActionButton(icon, label, color, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xy-action-button';
    btn.dataset.color = color;
    btn.innerHTML = `<span class="xy-action-icon">${icon}</span><span class="xy-action-label">${label}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function createDivider() {
    const d = document.createElement('div');
    d.className = 'xy-bar-divider';
    return d;
  }

  // ────────────────────────────────────────────────────────────
  // 按钮点击处理
  // ────────────────────────────────────────────────────────────
  function onCollect() {
    console.log('[ActionBar] 一键采集');
    toast('采集功能开发中');
  }
  function onFollowSell() {
    console.log('[ActionBar] 模拟手动跟卖');
    self.JZFollowSellPanel.toggle();
  }
  function onBatchUpload() {
    console.log('[ActionBar] 批量上架');
    toast('批量上架功能开发中');
  }
  function onProfit() {
    console.log('[ActionBar] MY 算价');
    toast('MY算价功能开发中');
  }
  function onSource() {
    console.log('[ActionBar] 1688找货源');
    toast('1688找货源功能开发中');
  }
  function onImageSearch() {
    console.log('[ActionBar] OZON以图搜图');
    toast('OZON以图搜图功能开发中');
  }
  function onKeyword() {
    console.log('[ActionBar] 主题标签');
    toast('主题标签功能开发中');
  }
  function onErp() {
    console.log('[ActionBar] 进入ERP');
    window.open('https://my.jizhangerp.com', '_blank');
  }

  // ────────────────────────────────────────────────────────────
  // 拖拽移动(品牌头作为 drag handle)
  // ────────────────────────────────────────────────────────────
  function bindDrag(bar, handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // 只响应左键
      const rect = bar.getBoundingClientRect();
      const startMouseX = e.clientX;
      const startMouseY = e.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      let moved = false;

      // 切换为 left/top 定位(脱离默认 right/transform)
      bar.style.right = 'auto';
      bar.style.transform = 'none';
      bar.style.left = startLeft + 'px';
      bar.style.top = startTop + 'px';
      bar.classList.add('is-dragging');

      const onMove = (ev) => {
        const dx = ev.clientX - startMouseX;
        const dy = ev.clientY - startMouseY;
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) moved = true;
        const maxLeft = Math.max(0, window.innerWidth - bar.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - bar.offsetHeight);
        const newLeft = Math.max(0, Math.min(startLeft + dx, maxLeft));
        const newTop = Math.max(0, Math.min(startTop + dy, maxTop));
        bar.style.left = newLeft + 'px';
        bar.style.top = newTop + 'px';
      };

      const onUp = () => {
        bar.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (moved) {
          const pos = {
            left: parseInt(bar.style.left, 10) || 0,
            top: parseInt(bar.style.top, 10) || 0,
          };
          try {
            chrome.storage.local.set({ [STORAGE_POS]: pos }).catch(() => {});
          } catch (e) {
            // storage 不可用时静默
          }
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ────────────────────────────────────────────────────────────
  // 双击折叠(品牌头作为 collapse toggle)
  // ────────────────────────────────────────────────────────────
  function bindCollapse(bar, handle) {
    handle.addEventListener('dblclick', () => {
      bar.classList.toggle('is-collapsed');
      const collapsed = bar.classList.contains('is-collapsed') ? '1' : '0';
      try {
        chrome.storage.local.set({ [STORAGE_COLLAPSED]: collapsed }).catch(() => {});
      } catch (e) {
        // storage 不可用时静默
      }
    });
  }

  // ────────────────────────────────────────────────────────────
  // 还原持久化状态(位置 + 折叠)
  // ────────────────────────────────────────────────────────────
  async function restoreState(bar) {
    try {
      const data = await chrome.storage.local.get([STORAGE_POS, STORAGE_COLLAPSED]);
      const pos = data[STORAGE_POS];
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        const w = bar.offsetWidth || 220;
        const h = bar.offsetHeight || 200;
        const left = Math.max(0, Math.min(pos.left, Math.max(0, window.innerWidth - w)));
        const top = Math.max(0, Math.min(pos.top, Math.max(0, window.innerHeight - h)));
        bar.style.right = 'auto';
        bar.style.transform = 'none';
        bar.style.left = left + 'px';
        bar.style.top = top + 'px';
      }
      if (data[STORAGE_COLLAPSED] === '1') {
        bar.classList.add('is-collapsed');
      }
    } catch (e) {
      // storage 不可用时静默
    }
  }

  // ────────────────────────────────────────────────────────────
  // 创建动作栏 DOM
  // ────────────────────────────────────────────────────────────
  function createActionBar() {
    const bar = document.createElement('div');
    bar.className = 'xy-action-bar';

    // 品牌头(drag handle + collapse toggle)
    const brand = document.createElement('div');
    brand.className = 'xy-bar-brand';
    brand.title = '拖拽移动 / 双击折叠';
    brand.innerHTML = '<span class="xy-bar-brand-icon">M</span><span class="xy-bar-brand-name">MY ERP</span>';
    bar.appendChild(brand);

    // 分隔线 1:品牌头与动作按钮之间
    bar.appendChild(createDivider());

    // 动作按钮 1-7
    bar.appendChild(createActionButton(wrapSvg(ICONS.collect), '一键采集', 'coral', onCollect));
    bar.appendChild(createActionButton(wrapSvg(ICONS.followSell), '模拟手动跟卖', 'purple', onFollowSell));
    bar.appendChild(createActionButton(wrapSvg(ICONS.batchUpload), '批量上架', 'coral', onBatchUpload));
    bar.appendChild(createActionButton(wrapSvg(ICONS.profit), 'MY 算价', 'indigo', onProfit));
    bar.appendChild(createActionButton(wrapSvg(ICONS.source), '1688找货源', 'amber', onSource));
    bar.appendChild(createActionButton(wrapSvg(ICONS.imageSearch), 'OZON以图搜图', 'cyan', onImageSearch));
    bar.appendChild(createActionButton(wrapSvg(ICONS.keyword), '主题标签', 'green', onKeyword));

    // 分隔线 2:动作按钮与 ERP 入口之间
    bar.appendChild(createDivider());

    // 进入 ERP
    bar.appendChild(createActionButton(wrapSvg(ICONS.erp), '进入ERP', 'teal', onErp));

    bindDrag(bar, brand);
    bindCollapse(bar, brand);

    return bar;
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API
  // ────────────────────────────────────────────────────────────
  let barEl = null;

  function mount() {
    if (barEl) return;
    injectStyle();
    barEl = createActionBar();
    document.body.appendChild(barEl);
    restoreState(barEl);
  }

  function unmount() {
    if (!barEl) return;
    barEl.remove();
    barEl = null;
  }

  function toggle() {
    if (!barEl) {
      mount();
      return;
    }
    const hidden = barEl.style.display === 'none';
    barEl.style.display = hidden ? '' : 'none';
  }

  self.JZActionBar = { mount, unmount, toggle };
})();
