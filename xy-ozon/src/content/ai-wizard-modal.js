// 1688 AI 上架向导 —— 全屏 modal,4 步流水线 mock。
// 对齐原项目 jzc-aiw-*/aiw-* 视觉,前缀替换为 xy-aiw-*;后端全部 mock。

(function () {
  'use strict';

  const MASK_ID = 'xy-aiw-mask';
  // 占位缩略图(无主图时使用)
  const PLACEHOLDER_IMG =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='46' height='46'><rect width='46' height='46' fill='%23f1f5f9'/><text x='50%' y='55%' text-anchor='middle' font-size='10' fill='%2394a3b8'>无图</text></svg>";

  // 运行时状态
  let root = null;
  let rawData = null;
  let pipelineTimer = null;
  let isRunning = false;

  // ────────────────────────────────────────────────────────────
  // Toast(独立于 1688 面板,避免依赖)
  // ────────────────────────────────────────────────────────────
  function toast(msg) {
    let host = document.getElementById('xy-aiw-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'xy-aiw-toast-host';
      host.className = 'xy-1688-toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'xy-1688-toast';
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 300);
    }, 1800);
  }

  // HTML 转义
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ────────────────────────────────────────────────────────────
  // 构建 modal 骨架
  // ────────────────────────────────────────────────────────────
  function buildModal() {
    const mask = document.createElement('div');
    mask.id = MASK_ID;
    mask.innerHTML = `
      <div id="xy-aiw">
        <div class="xy-aiw-side">
          <div class="xy-aiw-brand">AI 采集</div>
          <div class="xy-aiw-nav on" data-view="workbench">🛠️ 工作台</div>
          <div class="xy-aiw-nav" data-view="images">🖼️ 商品图片中心</div>
          <div class="xy-aiw-nav" data-view="settings">⚙️ 系统设置</div>
        </div>
        <div class="xy-aiw-main">
          <div class="xy-aiw-top">
            <div>
              <div class="xy-aiw-h1">AI 智能工作台</div>
              <div class="xy-aiw-sub">采集商品 → AI 智能体输出 → 一键上架</div>
            </div>
            <button class="xy-aiw-btn primary lg" id="xy-aiw-launch" type="button">🚀 点击启动</button>
            <button class="xy-aiw-x" id="xy-aiw-close" type="button" title="关闭">×</button>
          </div>
          <div class="xy-aiw-body" id="xy-aiw-body"></div>
        </div>
      </div>
    `;
    return mask;
  }

  // ────────────────────────────────────────────────────────────
  // 视图渲染
  // ────────────────────────────────────────────────────────────

  // 工作台:步骤条 + 基础配置卡 + 商品列表卡
  function renderWorkbench() {
    const body = root.querySelector('#xy-aiw-body');
    const data = rawData || {};
    const title = esc(data.title || '1688 商品');
    const price = esc(data.price || '¥0');
    const thumb = data.mainImages?.[0] || PLACEHOLDER_IMG;

    body.innerHTML = `
      <div class="xy-aiw-steps">
        <div class="xy-aiw-step is-done"><span class="xy-aiw-dot">✓</span><span class="xy-aiw-step-label">获取数据</span></div>
        <div class="xy-aiw-step-line"></div>
        <div class="xy-aiw-step is-current"><span class="xy-aiw-dot">2</span><span class="xy-aiw-step-label">选择数据</span></div>
        <div class="xy-aiw-step-line"></div>
        <div class="xy-aiw-step"><span class="xy-aiw-dot">3</span><span class="xy-aiw-step-label">AI 输出</span></div>
        <div class="xy-aiw-step-line"></div>
        <div class="xy-aiw-step"><span class="xy-aiw-dot">4</span><span class="xy-aiw-step-label">完成</span></div>
      </div>

      <div class="xy-aiw-card">
        <div class="xy-aiw-card-title">基础配置</div>
        <div class="xy-aiw-form">
          <label class="xy-aiw-field">
            <span>产品类目 *</span>
            <select id="xy-aiw-cat">
              <option value="">请选择</option>
              <option value="electronics">电子配件</option>
              <option value="apparel">服饰</option>
              <option value="home">家居</option>
            </select>
          </label>
          <label class="xy-aiw-field">
            <span>店铺 *</span>
            <select id="xy-aiw-store">
              <option value="store-001">Demo 店铺 001</option>
            </select>
          </label>
          <label class="xy-aiw-field">
            <span>仓库</span>
            <select id="xy-aiw-wh">
              <option value="wh-001">仓库 001</option>
            </select>
          </label>
          <label class="xy-aiw-field">
            <span>货号前缀</span>
            <input type="text" id="xy-aiw-prefix" value="DPWL-I">
          </label>
        </div>
        <div class="xy-aiw-switches">
          <label class="xy-aiw-sw" data-opt="directListing"><input type="checkbox" checked> 是否直上</label>
          <label class="xy-aiw-sw" data-opt="imageTranslate"><input type="checkbox"> 图片翻译</label>
        </div>
      </div>

      <div class="xy-aiw-card">
        <div class="xy-aiw-card-title-row">
          <span class="xy-aiw-card-title">商品列表</span>
          <button class="xy-aiw-btn sm" id="xy-aiw-batch-price" type="button">批量设置售价</button>
        </div>
        <table class="xy-aiw-table">
          <thead>
            <tr>
              <th>✓</th><th>主图</th><th>SKU</th><th>采购价</th><th>售价</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><input type="checkbox" class="xy-aiw-ck-row" checked></td>
              <td><img class="xy-aiw-thumb" src="${thumb}" alt=""></td>
              <td>${title}</td>
              <td>${price}</td>
              <td><input type="number" class="xy-aiw-price" value="999"></td>
              <td><button class="xy-aiw-del" type="button">×</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    bindWorkbenchEvents();
  }

  // 图片中心视图(mock 占位)
  function renderImages() {
    const body = root.querySelector('#xy-aiw-body');
    body.innerHTML = `<div class="xy-aiw-empty">功能开发中</div>`;
  }

  // 系统设置视图(mock 配置开关)
  function renderSettings() {
    const body = root.querySelector('#xy-aiw-body');
    body.innerHTML = `
      <div class="xy-aiw-card">
        <div class="xy-aiw-card-title">系统设置</div>
        <div class="xy-aiw-settings-list">
          <label class="xy-aiw-sw"><input type="checkbox" checked> 启用 AI 自动重写标题</label>
          <label class="xy-aiw-sw"><input type="checkbox" checked> 启用 AI 自动翻译</label>
          <label class="xy-aiw-sw"><input type="checkbox"> 启用智能定价</label>
          <label class="xy-aiw-sw"><input type="checkbox"> 自动填充必填属性</label>
        </div>
      </div>
    `;
  }

  // ────────────────────────────────────────────────────────────
  // 工作台事件绑定
  // ────────────────────────────────────────────────────────────
  function bindWorkbenchEvents() {
    // 货号前缀:过滤非 [A-Za-z0-9_\-./] 字符
    const prefix = root.querySelector('#xy-aiw-prefix');
    if (prefix) {
      prefix.addEventListener('input', (e) => {
        const cleaned = e.target.value.replace(/[^A-Za-z0-9_\-.\/]/g, '');
        if (cleaned !== e.target.value) e.target.value = cleaned;
      });
    }

    // 批量设置售价
    const batch = root.querySelector('#xy-aiw-batch-price');
    if (batch) {
      batch.addEventListener('click', () => toast('已批量设置售价(mock)'));
    }

    // 删除行(事件委托)
    const body = root.querySelector('#xy-aiw-body');
    body.addEventListener('click', (e) => {
      const del = e.target.closest('.xy-aiw-del');
      if (!del) return;
      const row = del.closest('tr');
      if (row) row.remove();
    });
  }

  // ────────────────────────────────────────────────────────────
  // 步骤条更新:setStep(n) 标记 1..n-1 为 done,n 为 current
  // ────────────────────────────────────────────────────────────
  function setStep(n) {
    const steps = root.querySelectorAll('.xy-aiw-step');
    steps.forEach((el, idx) => {
      const i = idx + 1;
      el.classList.remove('is-done', 'is-current');
      const dot = el.querySelector('.xy-aiw-dot');
      if (i < n) {
        el.classList.add('is-done');
        if (dot) dot.textContent = '✓';
      } else if (i === n) {
        // 最后一步完成时,直接置为 done
        if (n >= 4) {
          el.classList.add('is-done');
          if (dot) dot.textContent = '✓';
        } else {
          el.classList.add('is-current');
          if (dot) dot.textContent = String(i);
        }
      } else {
        if (dot) dot.textContent = String(i);
      }
    });
  }

  // ────────────────────────────────────────────────────────────
  // AI 输出日志:首次写入时自动创建日志卡
  // ────────────────────────────────────────────────────────────
  function appendLog(msg) {
    let logCard = root.querySelector('#xy-aiw-log-card');
    if (!logCard) {
      logCard = document.createElement('div');
      logCard.id = 'xy-aiw-log-card';
      logCard.className = 'xy-aiw-card';
      logCard.innerHTML = `
        <div class="xy-aiw-card-title-row">
          <span class="xy-aiw-card-title">AI 输出日志</span>
          <span class="xy-aiw-chip">GPT-4 Demo</span>
        </div>
        <div class="xy-aiw-log" id="xy-aiw-log"></div>
      `;
      const body = root.querySelector('#xy-aiw-body');
      body.appendChild(logCard);
    }
    const log = logCard.querySelector('#xy-aiw-log');
    const line = document.createElement('div');
    line.className = 'xy-aiw-log-line';
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    line.textContent = `[${ts}] ${msg}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  // ────────────────────────────────────────────────────────────
  // 4 步流水线(mock):step 2 → 3,逐条输出日志,完成 → step 4
  // ────────────────────────────────────────────────────────────
  function runPipeline() {
    if (isRunning) return;
    isRunning = true;
    const launchBtn = root.querySelector('#xy-aiw-launch');
    if (launchBtn) {
      launchBtn.disabled = true;
      launchBtn.textContent = '⏳ 处理中...';
    }

    setStep(3);
    appendLog('开始 AI 智能体流水线...');

    const steps = [
      { msg: '采集商品入箱...', delay: 500 },
      { msg: 'AI 重写标题:无线蓝牙耳机 → Wireless Bluetooth Earbuds', delay: 800 },
      { msg: 'AI 重写描述:已生成多语言描述', delay: 600 },
      { msg: 'AI 生成主题标签:#wireless #earbuds #bluetooth #audio', delay: 500 },
      { msg: '智能定价:采购 ¥15 → 售价 ₽999(利润率 32%)', delay: 700 },
      { msg: 'AI 填充必填属性:品牌/颜色/材质 已填充', delay: 600 },
      { msg: '提交到 Ozon...', delay: 800 },
      { msg: '完成!成功 1,失败 0', delay: 200 },
    ];
    let i = 0;
    pipelineTimer = setInterval(() => {
      if (i >= steps.length) {
        clearInterval(pipelineTimer);
        pipelineTimer = null;
        setStep(4);
        appendLog('✅ 全流程完成');
        isRunning = false;
        if (launchBtn) {
          launchBtn.disabled = false;
          launchBtn.textContent = '🚀 点击启动';
        }
        return;
      }
      appendLog(steps[i].msg);
      i++;
    }, 600);
  }

  // ────────────────────────────────────────────────────────────
  // 视图切换
  // ────────────────────────────────────────────────────────────
  function switchView(view) {
    root.querySelectorAll('.xy-aiw-nav').forEach((el) => {
      el.classList.toggle('on', el.dataset.view === view);
    });
    if (view === 'workbench') renderWorkbench();
    else if (view === 'images') renderImages();
    else if (view === 'settings') renderSettings();
  }

  // ────────────────────────────────────────────────────────────
  // 顶层事件绑定
  // ────────────────────────────────────────────────────────────
  function bindEvents() {
    // 启动流水线
    root.querySelector('#xy-aiw-launch').addEventListener('click', runPipeline);

    // 关闭按钮
    root.querySelector('#xy-aiw-close').addEventListener('click', close);

    // 点蒙版空白关闭
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });

    // 导航切换(事件委托)
    root.querySelector('.xy-aiw-side').addEventListener('click', (e) => {
      const nav = e.target.closest('.xy-aiw-nav[data-view]');
      if (!nav) return;
      switchView(nav.dataset.view);
    });
  }

  // ────────────────────────────────────────────────────────────
  // open / close
  // ────────────────────────────────────────────────────────────
  function open(raw) {
    // 已存在则先关闭再开
    if (root) close();
    rawData = raw || null;
    isRunning = false;
    root = buildModal();
    document.body.appendChild(root);
    renderWorkbench();
    bindEvents();
  }

  function close() {
    if (pipelineTimer) {
      clearInterval(pipelineTimer);
      pipelineTimer = null;
    }
    isRunning = false;
    if (root) {
      root.remove();
      root = null;
    }
    rawData = null;
    const host = document.getElementById('xy-aiw-toast-host');
    if (host) host.remove();
  }

  self.JZAIWizard = { open, close };
})();
