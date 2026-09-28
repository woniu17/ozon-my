// Ozon 卖家后台店铺昵称徽章 content script
// （自 qx-ozon/content/ozon-seller-bridge.js 迁移）
//
// 在 seller.ozon.ru 顶部店铺切换器中为每个店铺显示 YQLxx 昵称徽章：
// - 顶栏当前店铺名前插入徽章（按 sc_company_id cookie 匹配）
// - 下拉列表每个店铺行插入徽章、加宽下拉框、按 YQL01→06 顺序重排
// 映射来源: erp-backend-lite/src/config/stores.json 的 company_id。
// 选择器尽量使用稳定属性(data-onboarding-target、语义类名 label-400/
// table-500)，但 Ozon UI 的生成类名(n2d-*/cs*-*)可能随版本变化。
(() => {
  const STORE_NICKS = {
    '3891653': { nick: 'YQL01', color: '#2563eb' },
    '3905796': { nick: 'YQL02', color: '#16a34a' },
    '4173548': { nick: 'YQL03', color: '#9333ea' },
    '4173939': { nick: 'YQL04', color: '#dc2626' },
    '4173989': { nick: 'YQL05', color: '#ea580c' },
    '4174037': { nick: 'YQL06', color: '#0891b2' },
  };

  function _createNickBadge(nick, color) {
    const badge = document.createElement('span');
    badge.setAttribute('data-yql-nick', nick);
    badge.textContent = nick;
    badge.style.cssText =
      'display:inline-block;margin-right:8px;padding:1px 8px;border-radius:999px;' +
      'color:#fff;font-weight:700;font-size:11px;line-height:18px;' +
      'background:' + color + ';vertical-align:middle;letter-spacing:.3px;white-space:nowrap;';
    return badge;
  }

  function _injectDropdownBadges() {
    // 下拉项: 包含 "Seller ID" 文本的 label-400 元素
    const candidates = document.querySelectorAll('[class*="label-400"]');
    candidates.forEach((el) => {
      const m = /Seller\s*ID\s*(\d+)/i.exec(el.textContent || '');
      if (!m) return;
      const info = STORE_NICKS[m[1]];
      if (!info) return;
      const row = el.parentElement;
      if (!row || row.querySelector('[data-yql-nick]')) return;
      const nameEl = row.querySelector('[class*="table-500"]');
      if (nameEl) nameEl.insertBefore(_createNickBadge(info.nick, info.color), nameEl.firstChild);
    });
  }

  function _injectHeaderBadge() {
    const header = document.querySelector(
      '[data-onboarding-target="headerCompanyName"]'
    );
    if (!header) return;
    // 找到直接包含店铺名的最深元素
    let nameEl = null;
    for (const el of header.querySelectorAll('div, span')) {
      const hasDirectText = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent.trim()
      );
      if (hasDirectText) {
        nameEl = el;
        break;
      }
    }
    if (!nameEl) return;

    const cid = document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('sc_company_id='))
      ?.split('=')[1];
    if (!cid) return;
    const info = STORE_NICKS[cid];
    if (!info) return;

    // 切换店铺后旧徽章需替换
    const existing = nameEl.querySelector('[data-yql-nick]');
    if (existing && existing.getAttribute('data-yql-nick') === info.nick) return;
    if (existing) existing.remove();

    nameEl.insertBefore(_createNickBadge(info.nick, info.color), nameEl.firstChild);
  }

  function _widenDropdown() {
    // 加宽店铺切换下拉框，让店铺名和昵称徽章在同一行
    const sellerIdEls = document.querySelectorAll('[class*="label-400"]');
    for (const el of sellerIdEls) {
      if (!/Seller\s*ID\s*\d+/i.test(el.textContent || '')) continue;
      // 从 "Seller ID" 元素向上找到下拉框容器(宽度 200~260px 的祖先)
      let pop = el.parentElement;
      while (pop && pop !== document.body) {
        const w = pop.getBoundingClientRect().width;
        if (w >= 200 && w <= 260) {
          if (!pop.getAttribute('data-yql-widened')) {
            pop.style.minWidth = '340px';
            pop.setAttribute('data-yql-widened', '1');
          }
          // 防止店铺名 + 徽章换行
          pop.querySelectorAll('[class*="table-500"]').forEach((nameEl) => {
            nameEl.style.whiteSpace = 'nowrap';
          });
          return;
        }
        pop = pop.parentElement;
      }
    }
  }

  function _sortDropdown() {
    // 按 YQL01、02、03... 顺序重排下拉框中的店铺行
    // 不在映射表中的店铺(如 4175184)排在最后，保持原相对顺序
    const allSellerIdEls = Array.from(
      document.querySelectorAll('[class*="label-400"]'),
    ).filter((el) => /Seller\s*ID\s*\d+/i.test(el.textContent || ''));
    if (allSellerIdEls.length < 2) return;

    // 找到共同容器: 从第一个 Seller ID 元素向上，找到包含所有 Seller ID 元素的祖先
    let container = allSellerIdEls[0];
    while (container && container.parentElement) {
      const cnt = container.parentElement.querySelectorAll(
        '[class*="label-400"]',
      ).length;
      if (cnt >= allSellerIdEls.length) {
        container = container.parentElement;
        break;
      }
      container = container.parentElement;
    }
    if (!container) return;

    // 收集店铺行(容器的直接子元素中包含 Seller ID 的)
    const rows = [];
    for (const child of Array.from(container.children)) {
      const sidEl = Array.from(
        child.querySelectorAll('[class*="label-400"]'),
      ).find((el) => /Seller\s*ID\s*(\d+)/i.test(el.textContent || ''));
      if (!sidEl) continue;
      const m = /Seller\s*ID\s*(\d+)/i.exec(sidEl.textContent || '');
      if (!m) continue;
      rows.push({ row: child, cid: m[1] });
    }
    if (rows.length < 2) return;

    // 计算 YQL 排序键(不在映射中的给一个大值，排最后)
    const nickOrder = (cid) => {
      const info = STORE_NICKS[cid];
      if (!info) return 999;
      const m = /^YQL(\d+)$/.exec(info.nick);
      return m ? parseInt(m[1], 10) : 999;
    };

    // V8 的 Array.prototype.sort 是稳定的(TimSort)，相同 order 保持原顺序
    const sorted = [...rows].sort((a, b) => nickOrder(a.cid) - nickOrder(b.cid));

    // 检查是否已排序，避免重复 DOM 操作触发 MutationObserver 死循环
    let alreadySorted = true;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].row !== sorted[i].row) {
        alreadySorted = false;
        break;
      }
    }
    if (alreadySorted) return;

    // 找到第一个店铺行之前的稳定锚点(非店铺行元素，如"添加公司"标题)
    const firstRow = rows[0].row;
    const stableAnchor = firstRow.previousSibling;

    // 用 DocumentFragment 收集排序后的行(appendChild 会从原 DOM 移除)
    const frag = document.createDocumentFragment();
    sorted.forEach(({ row }) => frag.appendChild(row));

    // 在稳定锚点之后插入
    if (stableAnchor) {
      container.insertBefore(frag, stableAnchor.nextSibling);
    } else {
      container.insertBefore(frag, container.firstChild);
    }
  }

  function _injectAll() {
    _injectHeaderBadge();
    _injectDropdownBadges();
    _widenDropdown();
    _sortDropdown();
  }

  _injectAll();

  // MutationObserver: 下拉框每次打开都会重新渲染 DOM，需重新注入
  let _nickRaf = null;
  const _nickObserver = new MutationObserver(() => {
    if (_nickRaf) return;
    _nickRaf = requestAnimationFrame(() => {
      _nickRaf = null;
      _injectAll();
    });
  });
  _nickObserver.observe(document.body, { childList: true, subtree: true });
})();
