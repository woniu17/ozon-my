/**
 * ERP 质检单高亮 content script
 * 在 erp.91miaoshou.com/order/package/index 页面识别质检单订单号并突出展示。
 *
 * 规则：订单号（span.platform-order-sn 文本）以任一配置前缀开头即为质检单。
 * 默认前缀：02131、02478
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'qc_prefixes';
  const DEFAULT_PREFIXES = ['02131', '02478'];
  const MARK_ATTR = 'data-jz-qc-marked';
  const HIGHLIGHT_CLASS = 'jz-qc-row';
  const BADGE_CLASS = 'jz-qc-badge';
  const FLOATER_ID = 'jz-qc-floater';

  let prefixes = DEFAULT_PREFIXES.slice();
  let stats = { total: 0, qc: 0 };
  let floaterEl = null;
  let observer = null;
  let rescanTimer = null;

  // ============ 工具方法 ============

  function normalizePrefixes(list) {
    if (!Array.isArray(list)) return DEFAULT_PREFIXES.slice();
    const out = [];
    for (const p of list) {
      if (typeof p !== 'string') continue;
      const s = p.trim();
      if (s) out.push(s);
    }
    return out.length ? out : DEFAULT_PREFIXES.slice();
  }

  function isQcOrder(sn) {
    if (!sn) return false;
    const text = String(sn).trim();
    for (const p of prefixes) {
      if (text.startsWith(p)) return true;
    }
    return false;
  }

  /** 找到最近的表格行（tr） */
  function findRow(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.tagName === 'TR') return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // ============ 浮窗统计 ============

  function ensureFloater() {
    if (floaterEl && document.body.contains(floaterEl)) return;
    floaterEl = document.createElement('div');
    floaterEl.id = FLOATER_ID;
    floaterEl.className = 'jz-qc-floater';
    floaterEl.innerHTML = `
      <div class="jz-qc-floater-title">质检单统计</div>
      <div class="jz-qc-floater-row"><span>当前页订单</span><b id="jz-qc-total">0</b></div>
      <div class="jz-qc-floater-row"><span>质检单</span><b id="jz-qc-count" class="jz-qc-floater-hit">0</b></div>
      <div class="jz-qc-floater-tip">订单号以 ${prefixes.join(' / ')} 开头</div>
    `;
    // document.body.appendChild(floaterEl);
  }

  function updateFloater() {
    if (!floaterEl) return;
    const totalEl = floaterEl.querySelector('#jz-qc-total');
    const countEl = floaterEl.querySelector('#jz-qc-count');
    const tipEl = floaterEl.querySelector('.jz-qc-floater-tip');
    if (totalEl) totalEl.textContent = stats.total;
    if (countEl) countEl.textContent = stats.qc;
    if (tipEl) tipEl.textContent = `订单号以 ${prefixes.join(' / ')} 开头`;
    floaterEl.classList.toggle('jz-qc-floater-zero', stats.qc === 0);
  }

  function resetStats() {
    stats = { total: 0, qc: 0 };
  }

  // ============ 扫描与高亮 ============

  function markOrder(snEl) {
    if (!snEl || snEl.hasAttribute(MARK_ATTR)) return;
    snEl.setAttribute(MARK_ATTR, '1');

    const text = (snEl.textContent || '').trim();
    stats.total++;

    if (!isQcOrder(text)) return;

    stats.qc++;
    snEl.classList.add('jz-qc-sn');
    const row = findRow(snEl);
    if (row) row.classList.add(HIGHLIGHT_CLASS);

    // 追加"质检单"徽章（避免重复追加）
    if (!snEl.dataset.jzBadge) {
      const badge = document.createElement('span');
      badge.className = BADGE_CLASS;
      badge.textContent = '质检单';
      badge.title = `订单号 ${text} 命中前缀：${prefixes.join(' / ')}`;
      // 插到 sn 后面（同一父级）
      if (snEl.parentElement) {
        snEl.parentElement.insertBefore(badge, snEl.nextSibling);
      } else {
        snEl.appendChild(badge);
      }
      snEl.dataset.jzBadge = '1';
    }
  }

  function scanAll() {
    const nodes = document.querySelectorAll('span.platform-order-sn');
    if (!nodes.length) {
      updateFloater();
      return;
    }
    // 全量重算（处理翻页/筛选/刷新后老节点被替换的情况）
    resetStats();
    // 清掉旧标记（DOM 节点可能被 ERP 复用，导致 hasAttribute 仍为 1 但内容已变）
    nodes.forEach((n) => {
      n.removeAttribute(MARK_ATTR);
      // 清掉旧徽章
      if (n.dataset.jzBadge) {
        const old = n.nextElementSibling;
        if (old && old.classList.contains(BADGE_CLASS)) old.remove();
        delete n.dataset.jzBadge;
      }
      n.classList.remove('jz-qc-sn');
      const row = findRow(n);
      if (row) row.classList.remove(HIGHLIGHT_CLASS);
    });
    nodes.forEach(markOrder);
    updateFloater();
  }

  function scheduleScan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scanAll();
    }, 100);
  }

  // ============ MutationObserver ============

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      let needScan = false;
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes && m.addedNodes.length) {
          needScan = true;
          break;
        }
      }
      if (needScan) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============ 配置加载 ============

  function loadPrefixes() {
    return new Promise((resolve) => {
      chrome.storage.sync.get([STORAGE_KEY], (res) => {
        prefixes = normalizePrefixes(res && res[STORAGE_KEY]);
        resolve(prefixes);
      });
    });
  }

  function onStorageChanged(changes, area) {
    if (area !== 'sync') return;
    if (!changes[STORAGE_KEY]) return;
    prefixes = normalizePrefixes(changes[STORAGE_KEY].newValue);
    // 清掉所有旧标记和徽章，触发全量重新扫描
    document
      .querySelectorAll(`span.platform-order-sn[${MARK_ATTR}]`)
      .forEach((n) => n.removeAttribute(MARK_ATTR));
    scanAll();
  }

  // ============ 启动 ============

  async function init() {
    await loadPrefixes();
    ensureFloater();
    scanAll();
    startObserver();
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(onStorageChanged);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
