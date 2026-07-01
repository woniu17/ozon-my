// Premium 透视眼浮动面板 —— 从原项目 0.13.31.1 抽离的 Demo。
// 原项目"透视眼"是 hook fetch/XHR 伪造 Ozon Premium 接口响应的工具;
// 本 Demo 只复刻 UI 视觉和开关交互,不做真实 fetch hook(避免 TOS 风险)。
// 开关状态持久化到 chrome.storage.local.xy_xray_enabled,位置持久化到 chrome.storage.local.xy_xray_pos。
// 所有 class 用 `xy-xray-` 前缀(原项目用内联样式,这里改成 class)。

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // 状态
  // ────────────────────────────────────────────────────────────
  let enabled = false;

  // ────────────────────────────────────────────────────────────
  // chrome.storage 读写封装(兼容 service worker / content script)
  // ────────────────────────────────────────────────────────────
  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (res) => resolve(res?.[key]));
      } catch {
        resolve(undefined);
      }
    });
  }

  function storageSet(obj) {
    try {
      chrome.storage.local.set(obj);
    } catch {
      // 忽略存储异常
    }
  }

  // ────────────────────────────────────────────────────────────
  // Toast(固定定位,2.4 秒自动消失)
  // ────────────────────────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg) {
    let t = document.querySelector('.xy-xray-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'xy-xray-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('xy-xray-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('xy-xray-toast-show');
    }, 2400);
  }

  // ────────────────────────────────────────────────────────────
  // 状态加载 / 渲染
  // ────────────────────────────────────────────────────────────
  async function loadState() {
    const val = await storageGet('xy_xray_enabled');
    enabled = val === true;
    render();
  }

  function render() {
    const panel = document.getElementById('xy-xray-panel');
    if (!panel) return;
    panel.classList.toggle('is-on', enabled);
    const status = panel.querySelector('.xy-xray-status');
    if (status) status.textContent = enabled ? '透视眼已开启' : '透视眼已关闭';
  }

  function toggle() {
    enabled = !enabled;
    storageSet({ xy_xray_enabled: enabled });
    render();
    showToast(enabled ? '透视眼已开启(mock)' : '透视眼已关闭');
  }

  // ────────────────────────────────────────────────────────────
  // 拖拽逻辑(panel 区为 handle;toggle 点击不触发拖拽)
  // ────────────────────────────────────────────────────────────
  function makeDraggable(panelEl) {
    panelEl.addEventListener('mousedown', (e) => {
      // 点击 toggle 开关不触发拖拽
      if (e.target.closest('[data-action="toggle"]')) return;
      const rect = panelEl.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      // 切换为 left/top 定位,便于自由拖拽
      panelEl.style.left = `${rect.left}px`;
      panelEl.style.top = `${rect.top}px`;
      panelEl.style.right = 'auto';
      panelEl.style.transform = 'none';

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
        const left = parseFloat(panelEl.style.left);
        const top = parseFloat(panelEl.style.top);
        if (!Number.isNaN(left) && !Number.isNaN(top)) {
          storageSet({ xy_xray_pos: { left, top } });
        }
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  // ────────────────────────────────────────────────────────────
  // 挂载条件:仅在 seller.ozon.ru/app/analytics* 页面挂载
  // 注:本 Demo 的 content_scripts 只匹配 ozon.ru(不含 seller.ozon.ru),
  //     此面板实际不会自动挂载,但模块 API 保留,供手动调用测试。
  // ────────────────────────────────────────────────────────────
  function shouldMount() {
    try {
      return /seller\.ozon\.ru\/app\/analytics/.test(location.href);
    } catch {
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 挂载 / 卸载
  // ────────────────────────────────────────────────────────────
  async function mount() {
    if (!shouldMount()) return; // 不在 seller analytics 页面,不挂载
    if (document.getElementById('xy-xray-panel')) return; // 已挂载

    const root = document.createElement('div');
    root.id = 'xy-xray-panel';
    root.className = 'xy-xray-panel';
    root.innerHTML = `
      <div class="xy-xray-header">
        <span class="xy-xray-title">透视眼</span>
        <span class="xy-xray-brand">MY</span>
      </div>
      <div class="xy-xray-toggle" data-action="toggle">
        <div class="xy-xray-toggle-knob"></div>
      </div>
      <div class="xy-xray-status">透视眼已关闭</div>
      <div class="xy-xray-hint">开启后展示商品深度分析(mock)</div>
    `;

    // 恢复持久化位置
    const pos = await storageGet('xy_xray_pos');
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      root.style.left = `${pos.left}px`;
      root.style.top = `${pos.top}px`;
      root.style.right = 'auto';
      root.style.transform = 'none';
    }

    document.body.appendChild(root);

    // 绑定 toggle 点击(stopPropagation 避免触发拖拽)
    const toggleEl = root.querySelector('[data-action="toggle"]');
    if (toggleEl) {
      toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
      });
    }

    makeDraggable(root);
    await loadState(); // 加载开关状态并渲染
  }

  function unmount() {
    const el = document.getElementById('xy-xray-panel');
    if (el) el.remove();
  }

  // ────────────────────────────────────────────────────────────
  // 模块导出
  // ────────────────────────────────────────────────────────────
  self.JZXrayPanel = {
    mount,
    unmount,
    toggle,
  };
})();
