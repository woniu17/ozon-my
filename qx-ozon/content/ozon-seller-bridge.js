/**
 * Content script injected into seller.ozon.ru pages.
 *
 * Bridges the service worker and seller.ozon.ru API by fetching directly
 * from the content script. Content scripts are not subject to the page's
 * CSP, and the extension's host_permissions grant access to seller.ozon.ru,
 * so cookies are sent automatically with credentials: 'include'.
 *
 * Flow:
 *   service-worker  →  chrome.tabs.sendMessage  →  this content script
 *   this script     →  fetch (with cookies)      →  seller.ozon.ru API
 *   this script     →  sendResponse              →  service-worker
 */

(() => {
  // ── Bestsellers 类目映射 relay ──────────────────────────────
  // page-world hook（content/ozon-bestsellers-hook.js）通过 window.postMessage 上报
  // {name, leafIds}，这里转发给 service worker → QX后端入库。
  //
  // ── Premium 透视眼 storage 同步 relay ─────────────────────
  // page-world hook（content/ozon-premium-hook.js）通过 window.postMessage 询问
  // 开关状态 / 请求切换 / 持久化面板位置；这里跟 chrome.storage.local 对接。
  // chrome.storage.onChanged 事件再反传给 main-world hook（来自 popup / 别的 tab
  // 切换开关时本 tab 也要同步）。
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__jzcReport !== 1) return;

    // 老逻辑：bestsellers 类目映射上报
    if (d.type === 'JZC_BESTSELLERS_REPORT') {
      const { name, leafIds, source } = d;
      if (!name || !Array.isArray(leafIds) || leafIds.length === 0) return;
      try {
        chrome.runtime.sendMessage({
          action: 'reportCategoryMapping',
          name,
          leafIds,
          source: source || 'bestsellers-hook',
        });
      } catch {
        // SW 未唤醒等场景静默忽略
      }
      return;
    }

    // 透视眼：拉初值
    if (d.type === 'JZC_PREMIUM_QUERY') {
      try {
        chrome.storage.local.get(
          ['ozon_premium_enabled', 'ozon_premium_panel_pos'],
          ({ ozon_premium_enabled, ozon_premium_panel_pos }) => {
            window.postMessage({ __jzcReport: 1, type: 'JZC_PREMIUM_TOGGLE', enabled: !!ozon_premium_enabled }, '*');
            if (ozon_premium_panel_pos) {
              window.postMessage(
                {
                  __jzcReport: 1,
                  type: 'JZC_PREMIUM_PANEL_POS_RESTORE',
                  pos: ozon_premium_panel_pos,
                },
                '*'
              );
            }
          }
        );
      } catch { }
      return;
    }

    // 透视眼：浮动面板内 toggle 触发切换
    if (d.type === 'JZC_PREMIUM_REQUEST_TOGGLE') {
      try {
        chrome.storage.local.set({ ozon_premium_enabled: !!d.next });
      } catch { }
      return;
    }

    // 透视眼：浮动面板拖动后持久化位置
    if (d.type === 'JZC_PREMIUM_PANEL_POS' && d.pos) {
      try {
        chrome.storage.local.set({ ozon_premium_panel_pos: d.pos });
      } catch { }
      return;
    }
  });

  // 启动时主动广播一次（针对 main-world hook 注入早于 bridge 启动的场景，
  // 它的 JZC_PREMIUM_QUERY 可能在 bridge 监听器装好之前就发了）
  try {
    chrome.storage.local.get(
      ['ozon_premium_enabled', 'ozon_premium_panel_pos'],
      ({ ozon_premium_enabled, ozon_premium_panel_pos }) => {
        window.postMessage({ __jzcReport: 1, type: 'JZC_PREMIUM_TOGGLE', enabled: !!ozon_premium_enabled }, '*');
        if (ozon_premium_panel_pos) {
          window.postMessage(
            {
              __jzcReport: 1,
              type: 'JZC_PREMIUM_PANEL_POS_RESTORE',
              pos: ozon_premium_panel_pos,
            },
            '*'
          );
        }
      }
    );
  } catch { }

  // 监听 storage 变化（来自 popup / 别 tab）→ 推送给本 tab 的 main-world hook
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.ozon_premium_enabled) {
        window.postMessage(
          {
            __jzcReport: 1,
            type: 'JZC_PREMIUM_TOGGLE',
            enabled: !!changes.ozon_premium_enabled.newValue,
          },
          '*'
        );
      }
      if (changes.ozon_premium_panel_pos) {
        window.postMessage(
          {
            __jzcReport: 1,
            type: 'JZC_PREMIUM_PANEL_POS_RESTORE',
            pos: changes.ozon_premium_panel_pos.newValue,
          },
          '*'
        );
      }
    });
  } catch { }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'sellerPortalFetch') return false;

    const { apiPath, reqBody, fallbackCompanyId, timeoutMs } = message;
    // 兼容新调用：可选 urlPrefix / pageType；缺省退回原跟卖默认值
    const urlPrefix = message.urlPrefix !== undefined ? message.urlPrefix : '/api/v1';
    const pageType = message.pageType || 'products-other';

    (async () => {
      try {
        // Read sc_company_id from document.cookie, fall back to service worker value
        const companyId =
          document.cookie
            .split(';')
            .map((c) => c.trim())
            .find((c) => c.startsWith('sc_company_id='))
            ?.split('=')[1] ||
          fallbackCompanyId ||
          '';

        if (!companyId) {
          sendResponse({ ok: false, error: 'sc_company_id cookie 未找到，请确保已登录 seller.ozon.ru' });
          return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const resp = await fetch('https://seller.ozon.ru' + urlPrefix + apiPath, {
            method: 'POST',
            signal: controller.signal,
            credentials: 'include',
            headers: {
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'x-o3-app-name': 'seller-ui',
              'x-o3-company-id': companyId,
              'x-o3-language': 'zh-Hans',
              'x-o3-page-type': pageType,
            },
            body: JSON.stringify(reqBody),
          });
          clearTimeout(timer);

          // Handle redirects (login expired)
          if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
            sendResponse({
              ok: false,
              status: 401,
              code: 'AUTH_REDIRECT',
              error: 'Seller portal cookie已过期，请重新登录',
            });
            return;
          }

          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            // codex review MEDIUM 修复 — 与 service-worker.doFetch 对齐:把 status 和
            // 响应体 code 单独抠出来传出去,让 background 的 makeStructuredError
            // 能识别 404 ResourceNotFound 当 bridge 是唯一可用 strategy 时也降级。
            let parsedCode = '';
            try {
              const json = JSON.parse(text);
              parsedCode = (json && (json.code || (json.error && json.error.code))) || '';
            } catch { }
            sendResponse({
              ok: false,
              status: resp.status,
              code: parsedCode,
              error: `Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}`,
            });
            return;
          }

          const result = await resp.json();
          sendResponse({ ok: true, data: result });
        } catch (e) {
          clearTimeout(timer);
          if (e.name === 'AbortError') {
            sendResponse({ ok: false, error: `Seller portal 请求超时 (${timeoutMs}ms)` });
          } else {
            throw e;
          }
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();

    return true; // async sendResponse
  });

  // ── 店铺昵称徽章 ─────────────────────────────────────────────
  // 在 seller.ozon.ru 顶部店铺切换器中为每个店铺显示 YQLxx 昵称徽章。
  // 映射来源: erp-backend-lite/src/config/stores.json 的 company_id。
  // 选择器尽量使用稳定属性(data-onboarding-target、语义类名 label-400/
  // table-500)，但 Ozon UI 的生成类名(n2d-*/cs*-*)可能随版本变化。
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
