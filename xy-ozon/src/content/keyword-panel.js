// 主题标签面板 —— 复刻原项目 ozon-helper 主题标签抓取与翻译(0.13.31.1)。
// 固定定位侧边面板:从商品页 DOM 抓取 # 开头主题标签,提供复制 / mock 翻译。
// 后端用 mock(翻译走内置词典),UI 完整复刻原项目视觉与交互。
// 所有 class 用 `xy-kw-` 前缀,替代原 `ozon-helper-keyword-*`。

(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────
  // Mock 翻译词典(俄语标签 → 中文)
  // ────────────────────────────────────────────────────────────
  const MOCK_TRANSLATIONS = {
    '#новинка': '#新品',
    '#хит': '#爆款',
    '#распродажа': '#促销',
    '#подарок': '#礼物',
    '#ozon': '#Ozon',
    '#быстрая_доставка': '#快速配送',
    '#выгодно': '#超值',
    '#качество': '#品质',
    '#мода': '#时尚',
    '#красота': '#美妆',
    '#дом': '#家居',
    '#дети': '#儿童',
    '#спорт': '#运动',
    '#электроника': '#电子',
  };

  const MOCK_TAGS = ['#новинка', '#хит', '#распродажа', '#подарок', '#ozon', '#быстрая_доставка', '#выгодно'];

  const PANEL_ID = 'xy-keyword-panel';

  // ────────────────────────────────────────────────────────────
  // 状态
  // ────────────────────────────────────────────────────────────
  let panelEl = null;
  let keywords = [];

  // ────────────────────────────────────────────────────────────
  // Toast
  // ────────────────────────────────────────────────────────────
  function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = 'xy-kw-toast xy-kw-toast-' + type;
    t.textContent = msg;
    t.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'background:rgba(0,0,0,0.8);color:#fff;padding:8px 16px;border-radius:6px;' +
      'font-size:13px;z-index:2147483647;transition:opacity 0.3s;' +
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;';
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 2000);
  }

  // ────────────────────────────────────────────────────────────
  // 从 DOM 抓取主题标签
  // ────────────────────────────────────────────────────────────
  function extractKeywords() {
    const tags = [];
    // 优先:从 [data-widget="webHashtags"] 抓所有带 [title] 的元素
    const hashtagWidget = document.querySelector('[data-widget="webHashtags"]');
    if (hashtagWidget) {
      hashtagWidget.querySelectorAll('[title]').forEach((el) => {
        const t = el.getAttribute('title') || '';
        if (t.startsWith('#')) tags.push(t);
      });
    }
    // 兜底:从 [data-widget="tagList"] 抓 <a>
    if (tags.length === 0) {
      const tagList = document.querySelector('[data-widget="tagList"]');
      if (tagList) {
        tagList.querySelectorAll('a').forEach((el) => {
          const t = (el.textContent || '').trim();
          if (t.startsWith('#')) tags.push(t);
        });
        return tags.slice(0, 20);
      }
    }
    // Mock 兜底:如果都没找到,生成一些 mock 标签
    if (tags.length === 0) {
      return MOCK_TAGS.slice();
    }
    return tags;
  }

  // ────────────────────────────────────────────────────────────
  // HTML 转义,防 XSS
  // ────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ────────────────────────────────────────────────────────────
  // 渲染单条标签
  // ────────────────────────────────────────────────────────────
  function renderItem(tag) {
    return (
      '<div class="xy-kw-item">' +
      '<span class="xy-kw-text">' +
      esc(tag) +
      '</span>' +
      '<div class="xy-kw-item-actions">' +
      '<button class="xy-kw-btn" data-action="copy" data-keyword="' +
      esc(tag) +
      '">📋</button>' +
      '<button class="xy-kw-btn" data-action="translate" data-keyword="' +
      esc(tag) +
      '">🌐</button>' +
      '</div>' +
      '<span class="xy-kw-translation" data-keyword="' +
      esc(tag) +
      '" style="display:none;"></span>' +
      '</div>'
    );
  }

  // ────────────────────────────────────────────────────────────
  // 渲染列表
  // ────────────────────────────────────────────────────────────
  function renderList() {
    const list = panelEl?.querySelector('[data-el="list"]');
    if (!list) return;
    if (keywords.length === 0) {
      list.innerHTML = '<div class="xy-kw-empty">未找到主题标签</div>';
      return;
    }
    list.innerHTML = keywords.map(renderItem).join('');
  }

  // ────────────────────────────────────────────────────────────
  // 复制到剪贴板(带降级)
  // ────────────────────────────────────────────────────────────
  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // 降级到 execCommand
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 复制单条
  // ────────────────────────────────────────────────────────────
  async function handleCopy(btn, tag) {
    const ok = await copyText(tag);
    if (ok) {
      const original = btn.textContent;
      btn.textContent = '✓';
      showToast('已复制 ' + tag);
      setTimeout(() => {
        btn.textContent = original;
      }, 1200);
    } else {
      showToast('复制失败', 'error');
    }
  }

  // ────────────────────────────────────────────────────────────
  // 翻译单条(mock,展开 / 折叠切换)
  // ────────────────────────────────────────────────────────────
  function handleTranslate(panel, tag) {
    const transEl = panel.querySelector('.xy-kw-translation[data-keyword="' + cssEscape(tag) + '"]');
    if (!transEl) return;
    if (transEl.style.display === 'none') {
      // 展开:写入 mock 译文
      const translated = MOCK_TRANSLATIONS[tag] || mockTranslateFallback(tag);
      transEl.textContent = '译:' + translated;
      transEl.style.display = 'block';
    } else {
      // 折叠
      transEl.style.display = 'none';
    }
  }

  // mock 翻译兜底:词典未命中时,去掉 # 并标注(原文)
  function mockTranslateFallback(tag) {
    const raw = tag.replace(/^#/, '');
    if (!raw) return tag;
    // 拉丁/数字直接返回
    if (/^[a-z0-9_]+$/i.test(raw)) return '#' + raw;
    return tag + '(未识别)';
  }

  // 简易 CSS 选择器转义(用于 [data-keyword="..."] 查询)
  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // ────────────────────────────────────────────────────────────
  // 事件绑定(委托)
  // ────────────────────────────────────────────────────────────
  function bindEvents(panel) {
    panel.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const action = target.getAttribute('data-action');
      const tag = target.getAttribute('data-keyword');
      switch (action) {
        case 'close':
          hide();
          break;
        case 'copy-all':
          handleCopyAll();
          break;
        case 'copy':
          if (tag) handleCopy(target, tag);
          break;
        case 'translate':
          if (tag) handleTranslate(panel, tag);
          break;
        default:
          break;
      }
    });
  }

  // ────────────────────────────────────────────────────────────
  // 复制全部
  // ────────────────────────────────────────────────────────────
  async function handleCopyAll() {
    if (keywords.length === 0) {
      showToast('无标签', 'error');
      return;
    }
    const text = keywords.join(' ');
    const ok = await copyText(text);
    if (ok) {
      showToast('已复制 ' + keywords.length + ' 个');
    } else {
      showToast('复制失败', 'error');
    }
  }

  // ────────────────────────────────────────────────────────────
  // 面板 HTML 模板
  // ────────────────────────────────────────────────────────────
  function panelTemplate() {
    return (
      '<div class="xy-kw-panel" id="' +
      PANEL_ID +
      '">' +
      '<div class="xy-kw-header">' +
      '<span class="xy-kw-title">主题标签</span>' +
      '<div class="xy-kw-actions">' +
      '<button class="xy-kw-copy-all" data-action="copy-all">📋 复制全部</button>' +
      '<button class="xy-kw-close" data-action="close">×</button>' +
      '</div>' +
      '</div>' +
      '<div class="xy-kw-content">' +
      '<div class="xy-kw-list" data-el="list"></div>' +
      '</div>' +
      '</div>'
    );
  }

  // ────────────────────────────────────────────────────────────
  // 创建面板
  // ────────────────────────────────────────────────────────────
  function buildPanel() {
    const wrap = document.createElement('div');
    wrap.innerHTML = panelTemplate();
    const root = wrap.firstElementChild;
    bindEvents(root);
    return root;
  }

  // ────────────────────────────────────────────────────────────
  // 刷新标签(重新抓取 DOM + 渲染)
  // ────────────────────────────────────────────────────────────
  function refresh() {
    keywords = extractKeywords();
    renderList();
  }

  // ────────────────────────────────────────────────────────────
  // 显示 / 隐藏
  // ────────────────────────────────────────────────────────────
  function show() {
    if (!panelEl) return;
    // 每次显示重新抓取一次,保证数据新鲜
    refresh();
    panelEl.style.display = 'block';
    panelEl.classList.remove('is-anim');
    void panelEl.offsetWidth;
    panelEl.classList.add('is-anim');
  }

  function hide() {
    if (!panelEl) return;
    panelEl.style.display = 'none';
  }

  // ────────────────────────────────────────────────────────────
  // mount / unmount / toggle
  // ────────────────────────────────────────────────────────────
  function mount() {
    if (panelEl) {
      // 已挂载则 toggle 显示
      show();
      return;
    }
    panelEl = buildPanel();
    document.body.appendChild(panelEl);
    refresh();
    panelEl.classList.add('is-anim');
  }

  function unmount() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
  }

  function toggle() {
    if (!panelEl) {
      mount();
      return;
    }
    if (panelEl.style.display === 'none') {
      show();
    } else {
      hide();
    }
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API
  // ────────────────────────────────────────────────────────────
  self.JZKeywordPanel = {
    mount,
    unmount,
    toggle,
  };
})();
