// QX采集器面板
//
// 用法（在 content script 里）:
//   const panel = window.QXCollectorPanel.create({
//     host: document.body,             // 可选, 挂载容器
//     callbacks: {
//       onToggleRunning:        (running) => {},   // 主开关切换
//       onAutoScrollToggle:     (enabled) => {},   // 自动翻页 on/off
//       onSalesFilterChange:    (enabled) => {},   // 仅抓有销量
//       onOnlyChineseStoresChange: (enabled) => {},// 只采集中国店铺
//       onFilterOpen:           () => {},          // 智能筛选弹窗打开
//       onFilterSave:           (state) => {},     // 智能筛选保存
//       onFilterReset:          () => {},          // 智能筛选重置
//       onForceRefresh:         () => {},          // 强制刷新当前页
//       onViewErp:              () => {},          // 查看 ERP
//     },
//   });
//   panel.setRunning(true);
//   panel.updateStoreDetection({ slug, name, isChinese, classifiedBy });
//   panel.toast('提示', 'success', 2000);
//   panel.destroy();
//
// 数据来源: SW action autoCollectGetConfig / autoCollectSetConfig /
//   autoCollectGetStats / autoCollectGetRecent / autoCollectForceRefreshPage
// （这些 action 返回裸对象, 不走 {ok,data} 包络, 故面板直接用 chrome.runtime.sendMessage）

(function () {
  if (window.QXCollectorPanel) return;

  var COLLAPSED_KEY = 'qx-c-panel-collapsed';
  var SALES_FILTER_KEY = 'qx-c-sales-filter';
  var AUTO_SCROLL_KEY = 'qx-c-auto-scroll';
  var SMART_FILTER_STORAGE_KEY = 'qx-smart-filter-state';
  var SMART_FILTER_DEFAULT_ID = 'smart-filter-default';
  var SMART_TEMPLATE_MAX_NAME_LENGTH = 40;
  var POLL_INTERVAL_MS = 5000;
  var COUNTDOWN_INTERVAL_MS = 1000;

  // 8 类缓存命中
  var CACHE_TYPES = [
    { key: 'card', label: 'card' },
    { key: 'detail', label: 'detail' },
    { key: 'composer', label: 'composer' },
    { key: 'entrypoint', label: 'entrypoint' },
    { key: 'search', label: 'search' },
    { key: 'bundle', label: 'bundle' },
    { key: 'marketStats', label: 'marketStats', staleable: true },
    { key: 'followSell', label: 'followSell', staleable: true },
  ];

  var BRAND_DISPLAY_NAME = (globalThis.__JZ_BRAND__ && globalThis.__JZ_BRAND__.displayName) || 'MY';

  function _toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    var normalized = String(value)
      .replace(/\u00a0/g, ' ')
      .trim();
    var match = normalized.replace(/\s+/g, '').match(/[-+]?\d+(?:[,.]\d+)?/);
    if (!match) return null;
    var parsed = Number(match[0].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function _genTemplateId() {
    return Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  function _smartDefaultTemplate(fieldKeys) {
    var conditions = {};
    (fieldKeys || []).forEach(function (f) {
      conditions[f.key] = { min: null, max: null };
    });
    return {
      id: SMART_FILTER_DEFAULT_ID,
      name: '默认模板',
      brandOption: 'any',
      shippingMode: '不限',
      conditions: conditions,
    };
  }

  function _smartNormTemplate(template, fieldKeys, brandOptions, selectKeys) {
    var src = template || {};
    var conditions = {};
    (fieldKeys || []).forEach(function (f) {
      var raw = (src.conditions && src.conditions[f.key]) || {};
      conditions[f.key] = { min: _toNumber(raw.min), max: _toNumber(raw.max) };
    });
    var brandOk = (brandOptions || []).some(function (b) {
      return b.value === src.brandOption;
    });
    var shippingOk = selectKeys && selectKeys[0] ? selectKeys[0].options.indexOf(src.shippingMode) !== -1 : true;
    return {
      id: String(src.id || _genTemplateId()),
      name:
        String(src.name || '未命名模板')
          .trim()
          .slice(0, SMART_TEMPLATE_MAX_NAME_LENGTH) || '未命名模板',
      brandOption: brandOk ? src.brandOption : 'any',
      shippingMode: shippingOk ? src.shippingMode : '不限',
      conditions: conditions,
    };
  }

  class QXCollectorPanel {
    constructor(options) {
      options = options || {};
      this.host = options.host || document.body;
      this.callbacks = options.callbacks || {};

      this.config = {};
      this.stats = {};
      this.recent = [];
      this.storeDetection = { slug: null, name: null, isChinese: undefined, classifiedBy: null };

      this.panelEl = null;
      this.bubbleEl = null;
      this.filterMaskEl = null;
      this.toastEl = null;

      this.pollTimer = null;
      this.queueTimer = null; // 采集队列快速刷新定时器(500ms,只刷队列区域)
      this.countdownTimer = null;
      this.toastTimer = null;

      this.collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
      this.running = false;

      // 自动翻页状态
      this._autoScrollStatus = { status: 'idle', reason: '未启动', detail: '' };
      this._autoScrollStatusShown = false;

      // 智能筛选 state（从 chrome.storage.local 异步加载）
      this.smartFilterState = null;

      // 只在店铺页启用 AutoScroller / 仅抓有销量 / 智能筛选
      this.isShopPage =
        /^\/seller\/[^/]+\/?$/i.test(location.pathname) || /^\/seller\/[^/]+\/products\/?$/i.test(location.pathname);

      // 拖动
      this._dragging = false;
      this._dragOffsetX = 0;
      this._dragOffsetY = 0;
      this._onMouseMove = this._onMouseMove.bind(this);
      this._onMouseUp = this._onMouseUp.bind(this);
    }

    static create(options) {
      var panel = new QXCollectorPanel(options);
      panel.mount();
      return panel;
    }

    // ── SW 消息: autoCollect* action 返回裸对象, 其他 action 返回 {ok,data} ──
    _send(action, params) {
      params = params || {};
      return new Promise(function (resolve, reject) {
        try {
          chrome.runtime.sendMessage(Object.assign({ action: action }, params), function (response) {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'ok')) {
              if (response.ok) resolve(response.data);
              else reject(new Error(response.error || 'UNKNOWN_ERROR'));
            } else {
              resolve(response);
            }
          });
        } catch (e) {
          reject(e);
        }
      });
    }

    _q(sel) {
      return this.panelEl ? this.panelEl.querySelector('[data-el="' + sel + '"]') : null;
    }
    _qm(sel) {
      return this.filterMaskEl ? this.filterMaskEl.querySelector('[data-el="' + sel + '"]') : null;
    }
    _qmf(sel) {
      return this.filterMaskEl ? this.filterMaskEl.querySelector('[data-field="' + sel + '"]') : null;
    }

    mount() {
      if (this.panelEl) return;
      this._build();
      this.host.appendChild(this.panelEl);
      this.host.appendChild(this.bubbleEl);
      if (this.filterMaskEl) document.body.appendChild(this.filterMaskEl);
      this._applyCollapsedState();
      this._restoreInputs();
      this._renderStatus();
      this._renderStats();
      this._renderCacheHits();
      this._renderRecent();
      this._renderAutoScrollStatus();
      this._renderCircuitBreaker();
      this.updateStoreDetection(this.storeDetection);
      this.startPolling();
      this._loadSmartFilterState();
      // 挂全局引用, 供 ozon-data-panel.js / ozon-product.js 调 updateStoreDetection
      window.__qxCollectorPanel = this;
    }

    _build() {
      var self = this;
      this.panelEl = document.createElement('div');
      this.panelEl.className = 'qx-c-panel';
      this.panelEl.innerHTML = this._panelHTML();

      this.bubbleEl = document.createElement('div');
      this.bubbleEl.className = 'qx-c-bubble';
      this.bubbleEl.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="11" width="18" height="10" rx="2"/>' +
        '<circle cx="12" cy="5" r="2"/>' +
        '<path d="M12 7v4"/>' +
        '<line x1="8" y1="16" x2="8" y2="16"/>' +
        '<line x1="16" y1="16" x2="16" y2="16"/>' +
        '</svg>';

      this.filterMaskEl = document.createElement('div');
      this.filterMaskEl.className = 'qx-c-filter-mask qx-c-hidden';
      this.filterMaskEl.innerHTML = this._filterModalHTML();

      this.toastEl = this._q('toast');
      this._bindEvents();
    }

    _panelHTML() {
      var shopOnly = this.isShopPage;
      return (
        '<div class="qx-c-header">' +
        '  <div class="qx-c-header-left">' +
        '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '      <rect x="3" y="11" width="18" height="10" rx="2"/>' +
        '      <circle cx="12" cy="5" r="2"/>' +
        '      <path d="M12 7v4"/>' +
        '      <line x1="8" y1="16" x2="8" y2="16"/>' +
        '      <line x1="16" y1="16" x2="16" y2="16"/>' +
        '    </svg>' +
        '    <span>' +
        BRAND_DISPLAY_NAME +
        '采集器</span>' +
        '  </div>' +
        '  <div class="qx-c-header-actions">' +
        '    <button class="qx-c-icon-btn" data-act="collapse" title="折叠">' +
        '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
        '        <line x1="5" y1="12" x2="19" y2="12"/>' +
        '      </svg>' +
        '    </button>' +
        '  </div>' +
        '</div>' +
        '<div class="qx-c-body">' +
        // 主控制
        '  <div class="qx-c-section-block">' +
        '    <div class="qx-c-section-title">主控制</div>' +
        '    <div class="qx-c-row">' +
        '      <label class="qx-c-switch">' +
        '        <input type="checkbox" data-act="toggle" data-el="toggle" />' +
        '        <span class="qx-c-switch-track"><span class="qx-c-switch-knob"></span></span>' +
        '        <span class="qx-c-switch-label">自动采集</span>' +
        '      </label>' +
        '    </div>' +
        (shopOnly
          ? '    <div class="qx-c-row">' +
            '      <label class="qx-c-switch">' +
            '        <input type="checkbox" data-act="auto-scroll-toggle" data-el="auto-scroll-toggle" />' +
            '        <span class="qx-c-switch-track"><span class="qx-c-switch-knob"></span></span>' +
            '        <span class="qx-c-switch-label">自动翻页</span>' +
            '      </label>' +
            '    </div>' +
            '    <div class="qx-c-autoscroll-status qx-c-hidden" data-el="autoscroll-status">' +
            '      <span class="qx-c-autoscroll-dot"></span>' +
            '      <span class="qx-c-autoscroll-text" data-el="autoscroll-status-text">未启动</span>' +
            '    </div>' +
            '    <div class="qx-c-row">' +
            '      <label class="qx-c-checkbox">' +
            '        <input type="checkbox" data-act="sales-filter" data-el="sales-filter" />' +
            '        <span>仅抓有销量</span>' +
            '      </label>' +
            '    </div>'
          : '') +
        '    <div class="qx-c-row">' +
        '      <label class="qx-c-checkbox">' +
        '        <input type="checkbox" data-act="only-chinese" data-el="only-chinese" />' +
        '        <span>只采集中国店铺</span>' +
        '      </label>' +
        '    </div>' +
        (shopOnly
          ? '    <div class="qx-c-filter-entry">' +
            '      <div>' +
            '        <strong>智能筛选</strong>' +
            '        <span class="qx-c-filter-summary" data-el="filter-summary">未配置</span>' +
            '      </div>' +
            '      <button class="qx-c-btn qx-c-btn-ghost" data-act="filter-open">筛选设置</button>' +
            '    </div>'
          : '') +
        '  </div>' +
        // 店铺检测
        '  <div class="qx-c-section-block">' +
        '    <div class="qx-c-section-title">店铺检测</div>' +
        '    <div data-el="store-detection"></div>' +
        '  </div>' +
        // 今日统计
        '  <div class="qx-c-section-block">' +
        '    <div class="qx-c-section-title">今日统计</div>' +
        '    <div class="qx-c-progress">' +
        '      <div class="qx-c-stat">' +
        '        <span class="qx-c-stat-num" data-el="stat-success">0</span>' +
        '        <span class="qx-c-stat-label">成功</span>' +
        '      </div>' +
        '      <div class="qx-c-stat">' +
        '        <span class="qx-c-stat-num" data-el="stat-skipped">0</span>' +
        '        <span class="qx-c-stat-label">跳过</span>' +
        '      </div>' +
        '      <div class="qx-c-stat is-failed">' +
        '        <span class="qx-c-stat-num" data-el="stat-failed">0</span>' +
        '        <span class="qx-c-stat-label">失败</span>' +
        '      </div>' +
        '      <div class="qx-c-stat is-antibot">' +
        '        <span class="qx-c-stat-num" data-el="stat-antibot">0</span>' +
        '        <span class="qx-c-stat-label">熔断</span>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        // 缓存命中
        '  <div class="qx-c-section-block">' +
        '    <div class="qx-c-section-title">缓存命中 (8 类)</div>' +
        '    <div class="qx-c-cache-grid" data-el="cache-grid">' +
        '      <div class="qx-c-cache-item"><span class="qx-c-cache-label">card</span><span class="qx-c-cache-num" data-el="cache-card">0</span></div>' +
        '      <div class="qx-c-cache-item"><span class="qx-c-cache-label">detail</span><span class="qx-c-cache-num" data-el="cache-detail">0</span></div>' +
        '      <div class="qx-c-cache-item"><span class="qx-c-cache-label">composer</span><span class="qx-c-cache-num" data-el="cache-composer">0</span></div>' +
        '      <div class="qx-c-cache-item"><span class="qx-c-cache-label">entrypoint</span><span class="qx-c-cache-num" data-el="cache-entrypoint">0</span></div>' +
        '      <div class="qx-c-cache-item"><span class="qx-c-cache-label">search</span><span class="qx-c-cache-num" data-el="cache-search">0</span></div>' +
        '      <div class="qx-c-cache-item"><span class="qx-c-cache-label">bundle</span><span class="qx-c-cache-num" data-el="cache-bundle">0</span></div>' +
        '      <div class="qx-c-cache-item" data-el="cache-marketStats-row"><span class="qx-c-cache-label">marketStats</span><span class="qx-c-cache-num" data-el="cache-marketStats">0</span></div>' +
        '      <div class="qx-c-cache-item" data-el="cache-followSell-row"><span class="qx-c-cache-label">followSell</span><span class="qx-c-cache-num" data-el="cache-followSell">0</span></div>' +
        '    </div>' +
        '  </div>' +
        // 采集队列
        '  <div class="qx-c-section-block">' +
        '    <div class="qx-c-section-title">采集队列 <span class="qx-c-queue-len" data-el="queue-len">0</span></div>' +
        '    <div class="qx-c-recent" data-el="recent-list"></div>' +
        '  </div>' +
        // 操作按钮
        '  <div class="qx-c-actions">' +
        '    <button class="qx-c-btn qx-c-btn-ghost" data-act="force-refresh">强制刷新当前页</button>' +
        '    <button class="qx-c-btn qx-c-btn-ghost" data-act="view-erp">查看ERP</button>' +
        '  </div>' +
        // 熔断倒计时
        '  <div class="qx-c-circuit-breaker qx-c-hidden" data-el="circuit-breaker">' +
        '    <span class="qx-c-circuit-breaker-icon">⚠</span>' +
        '    <span data-el="circuit-breaker-text">反爬熔断, 恢复中…</span>' +
        '  </div>' +
        // toast
        '  <div class="qx-c-toast" data-el="toast"></div>' +
        '</div>'
      );
    }

    _filterModalHTML() {
      return (
        '<div class="qx-c-filter-modal">' +
        '  <div class="qx-c-filter-head">' +
        '    <div><h3>编辑选品规则</h3></div>' +
        '    <button class="qx-c-btn qx-c-btn-ghost qx-c-filter-close" data-act="filter-close">×</button>' +
        '  </div>' +
        '  <div class="qx-c-filter-toolbar">' +
        '    <label class="qx-c-checkbox">' +
        '      <input type="checkbox" data-field="enabled" />' +
        '      <span>启用选品规则</span>' +
        '    </label>' +
        '    <div class="qx-c-filter-template">' +
        '      <span>模板：</span>' +
        '      <select class="qx-c-filter-template-select" data-el="filter-template" data-field="template"></select>' +
        '      <div class="qx-c-filter-template-actions">' +
        '        <button class="qx-c-btn qx-c-btn-ghost" data-act="filter-add">新建</button>' +
        '        <button class="qx-c-btn qx-c-btn-ghost" data-act="filter-rename">重命名</button>' +
        '        <button class="qx-c-btn qx-c-btn-danger-ghost" data-act="filter-delete">删除</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="qx-c-filter-table" data-el="filter-table"></div>' +
        '  <div class="qx-c-filter-footer">' +
        '    <button class="qx-c-btn qx-c-btn-ghost" data-act="filter-reset">重置</button>' +
        '    <button class="qx-c-btn" data-act="filter-save">保存</button>' +
        '  </div>' +
        '</div>'
      );
    }

    _bindEvents() {
      var self = this;
      var panelEl = this.panelEl;

      // 点击委托
      panelEl.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-act]');
        if (!btn) return;
        var act = btn.dataset.act;
        if (act === 'collapse') return self._collapse();
        if (act === 'toggle') return self._onToggleClick();
        if (act === 'force-refresh') return self._onForceRefresh();
        if (act === 'view-erp') return self._onViewErp();
        if (act === 'filter-open') return self._openFilterModal();
      });

      // change 委托（checkbox）
      panelEl.addEventListener('change', function (e) {
        var t = e.target;
        if (!t.dataset || !t.dataset.act) return;
        var act = t.dataset.act;
        if (act === 'toggle') return; // 主开关由 click 处理
        if (act === 'auto-scroll-toggle') return self._onAutoScrollToggle(t.checked);
        if (act === 'sales-filter') return self._onSalesFilterChange(t.checked);
        if (act === 'only-chinese') return self._onOnlyChineseChange(t.checked);
      });

      // bubble 点击展开
      this.bubbleEl.addEventListener('click', function () {
        self._expand();
      });

      // 拖动（header mousedown）
      var header = panelEl.querySelector('.qx-c-header');
      if (header) {
        header.addEventListener('mousedown', function (e) {
          self._onDragStart(e);
        });
      }

      // 筛选弹窗事件
      if (this.filterMaskEl) {
        this.filterMaskEl.addEventListener('click', function (e) {
          if (e.target === self.filterMaskEl) return self._closeFilterModal();
          var actEl = e.target.closest('[data-act]');
          if (!actEl) return;
          var act = actEl.dataset.act;
          if (act === 'filter-close') return self._closeFilterModal();
          if (act === 'filter-save') return self._saveFilterForm();
          if (act === 'filter-reset') return self._resetFilterForm();
          if (act === 'filter-add') return self._addTemplate();
          if (act === 'filter-rename') return self._renameTemplate();
          if (act === 'filter-delete') return self._deleteTemplate();
        });
        this.filterMaskEl.addEventListener('change', function (e) {
          var t = e.target;
          if (!t.matches || !t.matches('[data-field]')) return;
          if (t.dataset.field === 'template') return self._onTemplateChange(t.value);
        });
      }
    }

    // ── 拖动 ──
    _onDragStart(e) {
      if (e.target.closest('button')) return; // 不拦截按钮点击
      this._dragging = true;
      var rect = this.panelEl.getBoundingClientRect();
      this._dragOffsetX = e.clientX - rect.left;
      this._dragOffsetY = e.clientY - rect.top;
      this.panelEl.classList.add('qx-c-dragging');
      document.addEventListener('mousemove', this._onMouseMove);
      document.addEventListener('mouseup', this._onMouseUp);
      e.preventDefault();
    }

    _onMouseMove(e) {
      if (!this._dragging || !this.panelEl) return;
      var x = e.clientX - this._dragOffsetX;
      var y = e.clientY - this._dragOffsetY;
      var maxX = window.innerWidth - this.panelEl.offsetWidth;
      var maxY = window.innerHeight - 40;
      x = Math.max(0, Math.min(x, maxX));
      y = Math.max(0, Math.min(y, maxY));
      this.panelEl.style.left = x + 'px';
      this.panelEl.style.top = y + 'px';
      this.panelEl.style.right = 'auto';
      this.panelEl.style.bottom = 'auto';
    }

    _onMouseUp() {
      this._dragging = false;
      if (this.panelEl) this.panelEl.classList.remove('qx-c-dragging');
      document.removeEventListener('mousemove', this._onMouseMove);
      document.removeEventListener('mouseup', this._onMouseUp);
    }

    // ── 折叠/展开 ──
    _collapse() {
      this.collapsed = true;
      localStorage.setItem(COLLAPSED_KEY, '1');
      this._applyCollapsedState();
    }

    _expand() {
      this.collapsed = false;
      localStorage.removeItem(COLLAPSED_KEY);
      this._applyCollapsedState();
    }

    _applyCollapsedState() {
      if (!this.panelEl || !this.bubbleEl) return;
      this.panelEl.classList.toggle('qx-c-hidden', this.collapsed);
      this.bubbleEl.classList.toggle('qx-c-hidden', !this.collapsed);
    }

    _restoreInputs() {
      // 仅抓有销量
      var salesCb = this._q('sales-filter');
      if (salesCb) salesCb.checked = localStorage.getItem(SALES_FILTER_KEY) === '1';
      // 自动翻页
      var scrollCb = this._q('auto-scroll-toggle');
      if (scrollCb) scrollCb.checked = localStorage.getItem(AUTO_SCROLL_KEY) === '1';
      // 只采集中国店铺 — 由轮询 config 填充, 这里不预设
    }

    // ── 主开关 ──
    async _onToggleClick() {
      var next = !this.running;
      try {
        await this._send('autoCollectSetConfig', { config: { autoCollectRunning: next } });
        this.running = next;
        this._renderStatus();
        if (typeof this.callbacks.onToggleRunning === 'function') {
          this.callbacks.onToggleRunning(next);
        }
        this.toast(next ? '已启动自动采集' : '已停止自动采集', 'success', 1500);
      } catch (err) {
        this._renderStatus(); // 回滚 checkbox 到 this.running
        this.toast(err.message || '操作失败', 'error', 2500);
      }
    }

    _onAutoScrollToggle(enabled) {
      localStorage.setItem(AUTO_SCROLL_KEY, enabled ? '1' : '0');
      if (typeof this.callbacks.onAutoScrollToggle === 'function') {
        try {
          this.callbacks.onAutoScrollToggle(enabled);
        } catch (err) {
          this.toast(err.message || '操作失败', 'error', 2500);
        }
      }
    }

    _onSalesFilterChange(enabled) {
      localStorage.setItem(SALES_FILTER_KEY, enabled ? '1' : '0');
      if (typeof this.callbacks.onSalesFilterChange === 'function') {
        try {
          this.callbacks.onSalesFilterChange(enabled);
        } catch (err) {
          this.toast(err.message || '操作失败', 'error', 2500);
        }
      }
    }

    async _onOnlyChineseChange(enabled) {
      try {
        await this._send('autoCollectSetConfig', { config: { onlyChineseStores: enabled } });
        if (typeof this.callbacks.onOnlyChineseStoresChange === 'function') {
          this.callbacks.onOnlyChineseStoresChange(enabled);
        }
        this.toast(enabled ? '已开启只采集中国店铺' : '已关闭只采集中国店铺', 'success', 1500);
      } catch (err) {
        this.toast(err.message || '操作失败', 'error', 2500);
        // 回滚 checkbox
        var cb = this._q('only-chinese');
        if (cb) cb.checked = !enabled;
      }
    }

    async _onForceRefresh() {
      try {
        await this._send('autoCollectForceRefreshPage');
        if (typeof this.callbacks.onForceRefresh === 'function') {
          this.callbacks.onForceRefresh();
        }
        this.toast('已强制刷新当前页', 'success', 1500);
      } catch (err) {
        this.toast(err.message || '强制刷新失败', 'error', 2500);
      }
    }

    _onViewErp() {
      if (typeof this.callbacks.onViewErp === 'function') {
        this.callbacks.onViewErp();
      } else {
        // 默认: 打开 ERP overview (新窗口)
        try {
          this._send('openFrontend', { path: 'overview' }).catch(function () {});
        } catch (e) {
          window.open('/admin#/overview', '_blank');
        }
      }
    }

    // ── 轮询 ──
    startPolling() {
      var self = this;
      this._poll(); // 立即拉一次
      this.pollTimer = setInterval(function () {
        self._poll();
      }, POLL_INTERVAL_MS);
      // 采集队列快速刷新:500ms 刷一次,实时反映"采集中→已完成"状态变化
      // __jzCollectingSkus 是 content script 内存 Set,无需走 SW 消息,读取零开销
      this.queueTimer = setInterval(function () {
        self._renderRecent();
      }, 500);
    }

    async _poll() {
      var tasks = [
        this._send('autoCollectGetConfig').then(function (c) {
          return { type: 'config', data: c };
        }),
        this._send('autoCollectGetStats').then(function (s) {
          return { type: 'stats', data: s };
        }),
        this._send('autoCollectGetRecent', { limit: 5 }).then(function (r) {
          return { type: 'recent', data: r };
        }),
      ];
      var results = await Promise.allSettled(tasks);
      results.forEach(function (r) {
        if (r.status !== 'fulfilled') return;
        var res = r.value;
        if (res.type === 'config') this._applyConfig(res.data);
        else if (res.type === 'stats') this._applyStats(res.data);
        else if (res.type === 'recent') this._applyRecent(res.data);
      }, this);
    }

    _applyConfig(config) {
      if (!config) return;
      this.config = config;
      // 主开关
      var wasRunning = this.running;
      this.running = !!config.autoCollectRunning;
      if (wasRunning !== this.running) this._renderStatus();
      var toggleCb = this._q('toggle');
      if (toggleCb && toggleCb.checked !== this.running) toggleCb.checked = this.running;
      // 只采集中国店铺
      var chineseCb = this._q('only-chinese');
      if (chineseCb && config.onlyChineseStores !== undefined) {
        chineseCb.checked = !!config.onlyChineseStores;
      }
      // 熔断倒计时
      this._renderCircuitBreaker();
    }

    _applyStats(stats) {
      if (!stats) return;
      this.stats = stats;
      this._renderStats();
      this._renderCacheHits();
    }

    _applyRecent(recent) {
      this.recent = Array.isArray(recent) ? recent : [];
      this._renderRecent();
    }

    // ── 渲染: 状态 ──
    _renderStatus() {
      var toggleCb = this._q('toggle');
      if (toggleCb && toggleCb.checked !== this.running) toggleCb.checked = this.running;
    }

    // ── 渲染: 今日统计 ──
    _renderStats() {
      var today = (this.stats && this.stats.today) || {};
      var el;
      el = this._q('stat-success');
      if (el) el.textContent = String(today.success || 0);
      el = this._q('stat-skipped');
      if (el) el.textContent = String(today.skipped || 0);
      el = this._q('stat-failed');
      if (el) el.textContent = String(today.failed || 0);
      el = this._q('stat-antibot');
      if (el) el.textContent = String(today.antibot || 0);
    }

    // ── 渲染: 缓存命中 (8 类) ──
    _renderCacheHits() {
      var byType = (this.stats && this.stats.byType) || {};
      var byTypeStale = (this.stats && this.stats.byTypeStale) || {};
      var self = this;
      CACHE_TYPES.forEach(function (t) {
        var el = self._q('cache-' + t.key);
        if (el) el.textContent = String(byType[t.key] || 0);
        if (t.staleable) {
          var row = self._q('cache-' + t.key + '-row');
          if (row) {
            // stale 计数 > 0 时标橙
            row.classList.toggle('qx-c-stale', (byTypeStale[t.key] || 0) > 0);
          }
        }
      });
    }

    // ── 渲染: 采集队列(正在采集 + 最近已完成,合并去重,限 5 条) ──
    _renderRecent() {
      var container = this._q('recent-list');
      if (!container) return;

      // 1. 正在采集的 SKU(从 shared-utils 的 __jzCollectingSkus Set 读取)
      var collectingSkus = [];
      try {
        var set = window.__jzCollectingSkus;
        if (set && typeof set.forEach === 'function') {
          set.forEach(function (sku) {
            collectingSkus.push({ sku: String(sku), status: 'collecting', source: '—', duration: null });
          });
        }
      } catch (_) {}

      // 2. 已完成的最近记录(SW 端 _autoCollectRecent)
      var recent = this.recent || [];
      var collectingSet = {};
      collectingSkus.forEach(function (c) {
        collectingSet[c.sku] = true;
      });
      // 去重:已完成的 SKU 如果正在采集中,不重复显示(以 collecting 状态为准)
      var doneList = recent.filter(function (r) {
        return !collectingSet[r.sku];
      });

      // 3. 合并:collecting 在前,已完成在后,限 5 条
      var list = collectingSkus.concat(doneList).slice(0, 5);

      // 更新队列长度徽章:只显示正在采集的数量
      var queueLenEl = this._q('queue-len');
      if (queueLenEl) {
        var inFlight = collectingSkus.length;
        queueLenEl.textContent = String(inFlight);
        // 有进行中任务时高亮为品牌色
        if (inFlight > 0) {
          queueLenEl.classList.add('is-active');
        } else {
          queueLenEl.classList.remove('is-active');
        }
      }

      if (!list.length) {
        container.innerHTML = '<div class="qx-c-recent-empty">暂无记录</div>';
        return;
      }

      var html =
        '<div class="qx-c-recent-head">' +
        '<span>SKU</span><span>来源</span><span>状态</span><span>耗时</span>' +
        '</div>';
      html += list
        .map(function (r) {
          var statusCls = 'qx-c-recent-status-' + (r.status || 'unknown');
          var statusText = r.status || '—';
          var duration = '—';
          if (r.duration != null) {
            duration = (r.duration / 1000).toFixed(1) + 's';
          }
          var sku = r.sku || '—';
          var source = r.source || '—';
          return (
            '<div class="qx-c-recent-row">' +
            '<span class="qx-c-recent-sku" title="' +
            sku +
            '">' +
            sku +
            '</span>' +
            '<span>' +
            source +
            '</span>' +
            '<span class="' +
            statusCls +
            '">' +
            statusText +
            '</span>' +
            '<span>' +
            duration +
            '</span>' +
            '</div>'
          );
        })
        .join('');
      container.innerHTML = html;
    }

    // ── 渲染: 熔断倒计时 ──
    _renderCircuitBreaker() {
      var cfg = this.config || {};
      var el = this._q('circuit-breaker');
      var textEl = this._q('circuit-breaker-text');
      if (!el || !textEl) return;
      var paused = !!cfg.paused;
      var until = Number(cfg.pausedUntil) || 0;
      if (paused && until > Date.now()) {
        el.classList.remove('qx-c-hidden');
        this._updateCountdownText(until, textEl);
        this._startCountdownTimer(until, textEl, el);
      } else {
        el.classList.add('qx-c-hidden');
        this._stopCountdownTimer();
      }
    }

    _updateCountdownText(until, textEl) {
      var remaining = Math.max(0, until - Date.now());
      var mins = Math.floor(remaining / 60000);
      var secs = Math.floor((remaining % 60000) / 1000);
      var mm = String(mins).padStart(2, '0');
      var ss = String(secs).padStart(2, '0');
      textEl.textContent = '⚠ 反爬熔断, ' + mm + ':' + ss + ' 后恢复';
    }

    _startCountdownTimer(until, textEl, el) {
      var self = this;
      this._stopCountdownTimer();
      this.countdownTimer = setInterval(function () {
        if (Date.now() >= until) {
          el.classList.add('qx-c-hidden');
          self._stopCountdownTimer();
          return;
        }
        self._updateCountdownText(until, textEl);
      }, COUNTDOWN_INTERVAL_MS);
    }

    _stopCountdownTimer() {
      if (this.countdownTimer) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
      }
    }

    // ── 店铺检测 (委托 QXStoreDetector) ──
    updateStoreDetection(state) {
      if (state) this.storeDetection = Object.assign({}, this.storeDetection, state);
      var container = this._q('store-detection');
      if (!container) return;
      if (window.QXStoreDetector && typeof window.QXStoreDetector.renderStoreDetectionBlock === 'function') {
        window.QXStoreDetector.renderStoreDetectionBlock(container, this.storeDetection);
      } else {
        container.textContent = '店铺检测模块未加载';
      }
    }

    // ── 主开关状态 ──
    setRunning(running) {
      this.running = !!running;
      this._renderStatus();
    }

    // ── 自动翻页状态 ──
    setAutoScrollStatus(status) {
      this._autoScrollStatus = status || { status: 'idle', reason: '未启动', detail: '' };
      this._renderAutoScrollStatus();
    }

    _renderAutoScrollStatus() {
      var row = this._q('autoscroll-status');
      var textEl = this._q('autoscroll-status-text');
      if (!row || !textEl) return;
      var st = this._autoScrollStatus;
      var status = st.status;
      var reason = st.reason;
      var detail = st.detail;
      // 曾显示过非 idle 状态后,持续显示
      if (status !== 'idle') this._autoScrollStatusShown = true;
      if (!this._autoScrollStatusShown) {
        row.classList.add('qx-c-hidden');
        return;
      }
      row.classList.remove('qx-c-hidden');
      row.className = 'qx-c-autoscroll-status' + (status !== 'idle' ? ' is-' + status : '');
      textEl.textContent = detail ? reason + ' · ' + detail : reason;
    }

    // ── 仅抓有销量初始值 ──
    getInitialSalesFilter() {
      var cb = this._q('sales-filter');
      return cb ? cb.checked : localStorage.getItem(SALES_FILTER_KEY) === '1';
    }

    // ── toast ──
    toast(message, type, durationMs) {
      if (!this.toastEl) return;
      type = type || 'info';
      durationMs = durationMs == null ? 2000 : durationMs;
      this.toastEl.textContent = message;
      this.toastEl.className =
        'qx-c-toast' + (type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : '');
      if (this.toastTimer) clearTimeout(this.toastTimer);
      if (durationMs > 0) {
        var self = this;
        this.toastTimer = setTimeout(function () {
          self.toastEl.textContent = '';
          self.toastEl.className = 'qx-c-toast';
        }, durationMs);
      }
    }

    // ── 智能筛选 ──
    async _loadSmartFilterState() {
      try {
        var result = await chrome.storage.local.get(SMART_FILTER_STORAGE_KEY);
        var raw = result[SMART_FILTER_STORAGE_KEY];
        this.smartFilterState = this._normalizeSmartFilterState(raw);
      } catch (e) {
        this.smartFilterState = this._defaultSmartFilterState();
      }
      this._renderFilterSummary();
    }

    _getFieldKeys() {
      return (window.QXSmartFilter && window.QXSmartFilter.SMART_FILTER_FIELD_KEYS) || [];
    }

    _getBrandOptions() {
      return (window.QXSmartFilter && window.QXSmartFilter.SMART_FILTER_BRAND_OPTIONS) || [];
    }

    _getSelectKeys() {
      return (window.QXSmartFilter && window.QXSmartFilter.SMART_FILTER_SELECT_KEYS) || [];
    }

    _defaultSmartFilterState() {
      return {
        enabled: false,
        currentTemplateId: SMART_FILTER_DEFAULT_ID,
        templates: [_smartDefaultTemplate(this._getFieldKeys())],
      };
    }

    _normalizeSmartFilterState(raw) {
      var fieldKeys = this._getFieldKeys();
      var brandOptions = this._getBrandOptions();
      var selectKeys = this._getSelectKeys();
      var fallback = this._defaultSmartFilterState();
      if (!raw) return fallback;
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!parsed) return fallback;
      var seenIds = {};
      var templates = Array.isArray(parsed.templates)
        ? parsed.templates
            .map(function (t) {
              return _smartNormTemplate(t, fieldKeys, brandOptions, selectKeys);
            })
            .filter(function (t) {
              if (!t || !t.id || seenIds[t.id]) return false;
              seenIds[t.id] = true;
              return true;
            })
        : [];
      if (!templates.length) templates = [_smartDefaultTemplate(fieldKeys)];
      if (
        !templates.some(function (t) {
          return t.id === SMART_FILTER_DEFAULT_ID;
        })
      ) {
        templates.unshift(_smartDefaultTemplate(fieldKeys));
      }
      var currentTemplateId = String(parsed.currentTemplateId || SMART_FILTER_DEFAULT_ID);
      if (
        !templates.some(function (t) {
          return t.id === currentTemplateId;
        })
      ) {
        currentTemplateId = SMART_FILTER_DEFAULT_ID;
      }
      return {
        enabled: typeof parsed.enabled === 'boolean' ? !!parsed.enabled : false,
        currentTemplateId: currentTemplateId,
        templates: templates,
      };
    }

    async _saveSmartFilterState() {
      if (!this.smartFilterState) return;
      try {
        var payload = {};
        payload[SMART_FILTER_STORAGE_KEY] = this.smartFilterState;
        await chrome.storage.local.set(payload);
      } catch (e) {
        // swallow
      }
    }

    _currentTemplate() {
      if (!this.smartFilterState) return null;
      var self = this;
      return (
        this.smartFilterState.templates.find(function (t) {
          return t.id === self.smartFilterState.currentTemplateId;
        }) || this.smartFilterState.templates[0]
      );
    }

    _renderFilterSummary() {
      var summary = this._q('filter-summary');
      if (!summary) return;
      if (!this.smartFilterState) {
        summary.textContent = '加载中…';
        return;
      }
      if (!this.smartFilterState.enabled) {
        summary.textContent = '未开启';
        summary.classList.remove('is-on');
        return;
      }
      var template = this._currentTemplate();
      if (!template) {
        summary.textContent = '已开启';
        summary.classList.add('is-on');
        return;
      }
      var fieldKeys = this._getFieldKeys();
      var hasRange = fieldKeys.some(function (f) {
        var cfg = template.conditions && template.conditions[f.key];
        return cfg && (_toNumber(cfg.min) !== null || _toNumber(cfg.max) !== null);
      });
      var hasBrand = !!template.brandOption && template.brandOption !== 'any';
      var hasShipping = !!template.shippingMode && template.shippingMode !== '不限';
      if (hasRange || hasBrand || hasShipping) {
        summary.textContent = '已开启（' + template.name + '）';
      } else {
        summary.textContent = '已开启（无筛选条件）';
      }
      summary.classList.add('is-on');
    }

    _openFilterModal() {
      if (!this.filterMaskEl) return;
      this.filterMaskEl.classList.remove('qx-c-hidden');
      this._renderFilterTemplateOptions();
      this._renderFilterForm();
      if (typeof this.callbacks.onFilterOpen === 'function') {
        this.callbacks.onFilterOpen();
      }
    }

    _closeFilterModal() {
      if (!this.filterMaskEl) return;
      this.filterMaskEl.classList.add('qx-c-hidden');
      this._renderFilterSummary();
    }

    _renderFilterTemplateOptions() {
      var select = this._qm('filter-template');
      if (!select || !this.smartFilterState) return;
      var current = this.smartFilterState.currentTemplateId;
      select.innerHTML = this.smartFilterState.templates
        .map(function (t) {
          return '<option value="' + t.id + '"' + (t.id === current ? ' selected' : '') + '>' + t.name + '</option>';
        })
        .join('');
    }

    _renderFilterForm() {
      if (!this.smartFilterState) return;
      var table = this._qm('filter-table');
      if (!table) return;
      var template = this._currentTemplate();
      if (!template) return;

      // enabled checkbox
      var enabledCb = this._qmf('enabled');
      if (enabledCb) enabledCb.checked = !!this.smartFilterState.enabled;

      var fieldKeys = this._getFieldKeys();
      var brandOptions = this._getBrandOptions();
      var selectKeys = this._getSelectKeys();
      var html = '';

      // 品牌行
      if (brandOptions.length) {
        html += '<div class="qx-c-filter-row is-brand">';
        html += '<span>品牌：</span>';
        brandOptions.forEach(function (b) {
          var checked = template.brandOption === b.value ? ' checked' : '';
          html +=
            '<label><input type="radio" name="qx-filter-brand" value="' +
            b.value +
            '"' +
            checked +
            ' /><span>' +
            b.label +
            '</span></label>';
        });
        html += '</div>';
      }

      // 发货模式行
      if (selectKeys.length) {
        var sk = selectKeys[0];
        html += '<div class="qx-c-filter-row is-select">';
        html += '<span>' + sk.label + '</span>';
        html += '<select data-field="shippingMode">';
        sk.options.forEach(function (opt) {
          var selected = template.shippingMode === opt ? ' selected' : '';
          html += '<option value="' + opt + '"' + selected + '>' + opt + '</option>';
        });
        html += '</select>';
        html += '</div>';
      }

      // 字段范围行
      fieldKeys.forEach(function (f) {
        var cfg = (template.conditions && template.conditions[f.key]) || {};
        var minVal = cfg.min != null ? cfg.min : '';
        var maxVal = cfg.max != null ? cfg.max : '';
        html += '<div class="qx-c-filter-row">';
        html += '<span>' + f.label + '</span>';
        html += '<div class="qx-c-filter-input">';
        if (f.prefix) html += '<span class="qx-c-filter-addon">' + f.prefix + '</span>';
        html +=
          '<input type="text" data-field="' +
          f.key +
          '-min" placeholder="' +
          (f.minPlaceholder || '') +
          '" value="' +
          minVal +
          '" />';
        html += '<em>~</em>';
        html +=
          '<input type="text" data-field="' +
          f.key +
          '-max" placeholder="' +
          (f.maxPlaceholder || '') +
          '" value="' +
          maxVal +
          '" />';
        if (f.suffix) html += '<span class="qx-c-filter-addon">' + f.suffix + '</span>';
        html += '</div>';
        html += '</div>';
      });

      table.innerHTML = html;
    }

    _collectTemplatePayload() {
      var template = this._currentTemplate();
      if (!template) return null;
      var fieldKeys = this._getFieldKeys();
      var conditions = {};
      fieldKeys.forEach(function (f) {
        var minEl = this._qmf(f.key + '-min');
        var maxEl = this._qmf(f.key + '-max');
        conditions[f.key] = {
          min: minEl ? _toNumber(minEl.value) : null,
          max: maxEl ? _toNumber(maxEl.value) : null,
        };
      }, this);

      // 品牌
      var brandOption = template.brandOption;
      var brandChecked = this.filterMaskEl.querySelector('input[name="qx-filter-brand"]:checked');
      if (brandChecked) brandOption = brandChecked.value;

      // 发货模式
      var shippingMode = template.shippingMode;
      var shippingSel = this._qmf('shippingMode');
      if (shippingSel) shippingMode = shippingSel.value;

      return {
        id: template.id,
        name: template.name,
        brandOption: brandOption,
        shippingMode: shippingMode,
        conditions: conditions,
      };
    }

    async _saveFilterForm() {
      if (!this.smartFilterState) return;
      var payload = this._collectTemplatePayload();
      if (!payload) return;
      // 更新当前模板
      var idx = this.smartFilterState.templates.findIndex(function (t) {
        return t.id === payload.id;
      });
      if (idx >= 0) {
        this.smartFilterState.templates[idx] = Object.assign({}, this.smartFilterState.templates[idx], {
          brandOption: payload.brandOption,
          shippingMode: payload.shippingMode,
          conditions: payload.conditions,
        });
      }
      var enabledCb = this._qmf('enabled');
      this.smartFilterState.enabled = !!(enabledCb && enabledCb.checked);

      await this._saveSmartFilterState();

      if (typeof this.callbacks.onFilterSave === 'function') {
        this.callbacks.onFilterSave(this.smartFilterState);
      }
      this._renderFilterSummary();
      this._closeFilterModal();
      this.toast('筛选配置已保存', 'success', 1200);
    }

    _resetFilterForm() {
      if (!this.smartFilterState) return;
      var template = this._currentTemplate();
      if (!template) return;
      var baseline = _smartDefaultTemplate(this._getFieldKeys());
      template.conditions = baseline.conditions;
      template.brandOption = baseline.brandOption;
      template.shippingMode = baseline.shippingMode;
      this._renderFilterForm();
      if (typeof this.callbacks.onFilterReset === 'function') {
        this.callbacks.onFilterReset();
      }
    }

    _onTemplateChange(nextTemplateId) {
      if (!this.smartFilterState) return;
      this.smartFilterState.currentTemplateId = nextTemplateId;
      this._renderFilterForm();
    }

    _addTemplate() {
      if (!this.smartFilterState) return;
      var current = this._currentTemplate();
      var newTemplate = _smartNormTemplate(
        {
          id: _genTemplateId(),
          name: '新模板',
          brandOption: current ? current.brandOption : 'any',
          shippingMode: current ? current.shippingMode : '不限',
          conditions: current ? current.conditions : null,
        },
        this._getFieldKeys(),
        this._getBrandOptions(),
        this._getSelectKeys()
      );
      this.smartFilterState.templates.push(newTemplate);
      this.smartFilterState.currentTemplateId = newTemplate.id;
      this._saveSmartFilterState();
      this._renderFilterTemplateOptions();
      this._renderFilterForm();
    }

    _renameTemplate() {
      if (!this.smartFilterState) return;
      var template = this._currentTemplate();
      if (!template) return;
      var input = window.prompt('请输入模板名称', template.name);
      if (input === null) return;
      var name = String(input).trim().slice(0, SMART_TEMPLATE_MAX_NAME_LENGTH);
      if (!name) return;
      template.name = name;
      this._saveSmartFilterState();
      this._renderFilterTemplateOptions();
    }

    _deleteTemplate() {
      if (!this.smartFilterState) return;
      var template = this._currentTemplate();
      if (!template) return;
      if (template.id === SMART_FILTER_DEFAULT_ID) {
        this.toast('默认模板不可删除', 'error', 1500);
        return;
      }
      this.smartFilterState.templates = this.smartFilterState.templates.filter(function (t) {
        return t.id !== template.id;
      });
      this.smartFilterState.currentTemplateId = SMART_FILTER_DEFAULT_ID;
      this._saveSmartFilterState();
      this._renderFilterTemplateOptions();
      this._renderFilterForm();
    }

    // ── 销毁 ──
    destroy() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.queueTimer) {
        clearInterval(this.queueTimer);
        this.queueTimer = null;
      }
      this._stopCountdownTimer();
      if (this.toastTimer) {
        clearTimeout(this.toastTimer);
        this.toastTimer = null;
      }
      document.removeEventListener('mousemove', this._onMouseMove);
      document.removeEventListener('mouseup', this._onMouseUp);
      if (this.panelEl) this.panelEl.remove();
      if (this.bubbleEl) this.bubbleEl.remove();
      if (this.filterMaskEl) this.filterMaskEl.remove();
      this.panelEl = null;
      this.bubbleEl = null;
      this.filterMaskEl = null;
      this.toastEl = null;
      if (window.__qxCollectorPanel === this) {
        window.__qxCollectorPanel = null;
      }
    }
  }

  window.QXCollectorPanel = QXCollectorPanel;
})();
