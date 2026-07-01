/**
 * 1688-image-search.js — 注入到 1688（s.1688.com / www.1688.com）。
 *
 * 用途：用户在 Ozon 商品页点"1688找货源"按钮时，极掌跳转到
 * `https://s.1688.com/youyuan/index.htm?tab=imageSearch&__jzcOzonImg=<encoded ozon image url>`
 * 本脚本读取 __jzcOzonImg 参数 → 让 background 代理 fetch ozon 图片（避开 CORS）
 * → 把 blob 通过 DataTransfer 注入到 1688 自身的 file input → dispatch change 事件
 * → 触发 1688 原生的"以图搜款"流程。
 *
 * 等同于用户手动点击"以图搜款"按钮选了 ozon 图片，但全程自动。
 */

(() => {
  const PARAM = '__jzcOzonImg';
  const FILE_INPUT_SELECTOR = 'input#img-search-upload, input[type="file"][accept*="image"]';
  const SAVED_KEY = '__jzcLast1688AutoUpload';

  const getOzonImgFromUrl = () => {
    try {
      const u = new URL(location.href);
      return u.searchParams.get(PARAM);
    } catch {
      return null;
    }
  };

  /** 用 background fetch 拉 ozon 图（绕过页面 CORS），返回 base64 dataURL */
  const proxyFetch = (url) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'proxyImageFetch', url }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: 'no response' });
      });
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e) });
    }
  });

  const dataUrlToFile = (dataUrl, name) => {
    const [meta, b64] = dataUrl.split(',');
    const mime = (meta.match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const ext = mime.split('/')[1] || 'jpg';
    return new File([buf], `${name}.${ext}`, { type: mime });
  };

  const waitForFileInput = () => new Promise((resolve) => {
    const found = document.querySelector(FILE_INPUT_SELECTOR);
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(FILE_INPUT_SELECTOR);
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // 兜底：15 秒超时
    setTimeout(() => { obs.disconnect(); resolve(document.querySelector(FILE_INPUT_SELECTOR)); }, 15000);
  });

  /**
   * 上传成功后 1688 会弹出"帮你找同款"小卡片，里面有橙色的"搜索图片"按钮。
   * 必须再点一下才会真正跳到结果页。等到该按钮出现就自动 click。
   */
  const waitAndClickSearchButton = () => new Promise((resolve) => {
    const findBtn = () => {
      const all = document.querySelectorAll('button, a, div, span');
      for (const el of all) {
        const t = (el.textContent || '').trim();
        if (t === '搜索图片' && el.offsetParent !== null && el.children.length < 5) {
          return el;
        }
      }
      return null;
    };
    const tryClick = () => {
      const btn = findBtn();
      if (!btn) return false;
      // 派发完整 mouse 事件序列，部分按钮只监听 mousedown / pointerdown
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((ev) => {
        btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window, button: 0 }));
      });
      return true;
    };
    if (tryClick()) return resolve(true);
    const obs = new MutationObserver(() => {
      if (tryClick()) {
        obs.disconnect();
        resolve(true);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(false); }, 8000);
  });

  const inject = async (ozonUrl) => {
    // 防重复执行（同 SPA 路由切换不再触发）
    try {
      const last = sessionStorage.getItem(SAVED_KEY);
      if (last === ozonUrl) return;
      sessionStorage.setItem(SAVED_KEY, ozonUrl);
    } catch {}

    const resp = await proxyFetch(ozonUrl);
    if (!resp?.ok || !resp.dataUrl) {
      console.warn('[jzc-1688] proxyFetch failed:', resp?.error);
      return;
    }
    const file = dataUrlToFile(resp.dataUrl, 'ozon');
    const input = await waitForFileInput();
    if (!input) {
      console.warn('[jzc-1688] file input not found');
      return;
    }
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      console.warn('[jzc-1688] inject failed:', e);
      return;
    }
    // 等"搜索图片"按钮出现 + 自动点击（无此步只显示上传 popover，搜索结果不刷新）
    await waitAndClickSearchButton();
  };

  const ozonUrl = getOzonImgFromUrl();
  if (ozonUrl) inject(ozonUrl);
})();
