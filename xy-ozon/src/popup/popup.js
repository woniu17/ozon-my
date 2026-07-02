// Popup 主逻辑 —— 登录视图 + 主视图切换 + 导航跳转。
// 通过 chrome.runtime.sendMessage 调用 service-worker,后者用 erp-client.js 对接 ERP 后端:
//   登录  → POST /auth/login-password
//   店铺  → GET  /auth/ozon-stores
//   切换  → 写入 chrome.storage.local.ozonStoreId

(function () {
  'use strict';

  const loginView = document.getElementById('login-view');
  const mainView = document.getElementById('main-view');
  const storeSelect = document.getElementById('store-select');
  const loginTip = document.getElementById('login-tip');

  const STORAGE_KEYS = { token: 'ozonAuthToken', storeId: 'ozonStoreId' };

  // 向 SW 发消息的 Promise 包装
  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (resp) => resolve(resp || { ok: false, error: '无响应' }));
    });
  }

  function setLoginState(loggedIn) {
    loginView.style.display = loggedIn ? 'none' : 'flex';
    mainView.classList.toggle('active', loggedIn);
  }

  function showTip(text, isError) {
    if (!loginTip) return;
    loginTip.textContent = text;
    loginTip.style.color = isError ? '#dc2626' : '#16a34a';
    loginTip.style.display = 'block';
    setTimeout(() => {
      loginTip.style.display = 'none';
    }, 2500);
  }

  // Tab 切换(短信/密码)
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // 渲染店铺下拉
  function renderStores(stores, selectedId) {
    if (!storeSelect) return;
    storeSelect.innerHTML = '';
    if (!Array.isArray(stores) || stores.length === 0) {
      storeSelect.innerHTML = '<option value="">无可用店铺</option>';
      storeSelect.disabled = true;
      return;
    }
    for (const s of stores) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name || s.id;
      if (selectedId && s.id === selectedId) opt.selected = true;
      storeSelect.appendChild(opt);
    }
    storeSelect.disabled = false;
  }

  // 加载店铺列表(登录后或启动时已登录时调用)
  async function loadStores() {
    const resp = await sendMessage({ type: 'getStores' });
    if (!resp?.ok) {
      showTip(resp?.error || '加载店铺失败', true);
      return [];
    }
    const stores = resp.data || [];
    // 缓存 stores 列表(含 currency_code 等),供 content script 读取
    await chrome.storage.local.set({ ozonStores: stores });
    const stored = await chrome.storage.local.get(STORAGE_KEYS.storeId);
    const selectedId = stored[STORAGE_KEYS.storeId] || (stores[0] && stores[0].id) || '';
    renderStores(stores, selectedId);
    if (selectedId && !stored[STORAGE_KEYS.storeId]) {
      await chrome.storage.local.set({ [STORAGE_KEYS.storeId]: selectedId });
    }
    return stores;
  }

  // 密码登录 → SW → erp-client.login + getStores
  async function doPasswordLogin() {
    const phoneNumber = document.getElementById('login-phone')?.value?.trim();
    const password = document.getElementById('login-password')?.value;
    if (!phoneNumber || !password) {
      showTip('请输入手机号和密码', true);
      return;
    }
    const btn = document.getElementById('login-btn');
    if (btn) btn.disabled = true;
    try {
      const resp = await sendMessage({ type: 'login', phoneNumber, password });
      if (!resp?.ok) {
        showTip(resp?.error || '登录失败', true);
        return;
      }
      const stores = resp.data?.stores || [];
      renderStores(stores, resp.data?.selectedStoreId);
      setLoginState(true);
    } catch (e) {
      showTip(e?.message || '登录异常', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 短信登录:个人版 ERP 仅支持密码登录,占位提示
  function doSmsLogin() {
    showTip('个人版仅支持密码登录,请切换到密码登录页签', true);
  }

  document.getElementById('sms-login-btn')?.addEventListener('click', doSmsLogin);
  document.getElementById('login-btn')?.addEventListener('click', doPasswordLogin);
  document.getElementById('web-login-btn')?.addEventListener('click', async () => {
    // 跳转本 ERP 的 admin 页面(由 SW 提供 baseUrl,避免硬编码 jizhangerp)
    const { baseUrl } = await sendMessage({ type: 'getErpBaseUrl' });
    chrome.tabs.create({ url: (baseUrl || 'http://localhost:3001') + '/admin' });
  });

  // 店铺切换
  storeSelect?.addEventListener('change', async () => {
    const storeId = storeSelect.value;
    if (!storeId) return;
    await sendMessage({ type: 'selectStore', storeId });
  });

  // 退出 → SW → erp-client.logout
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await sendMessage({ type: 'logout' });
    if (storeSelect) {
      storeSelect.innerHTML = '<option value="">未登录</option>';
      storeSelect.disabled = true;
    }
    setLoginState(false);
  });

  // seller portal 跳转
  document.getElementById('seller-portal-btn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://seller.ozon.ru/' });
  });

  // 导航按钮跳转 hash 表(对应本 ERP admin 页面的 tab hash 路由)
  // 用 hash 而非 path 是因为 admin 是单页应用,所有 tab 通过 #xxx 切换
  const ACTION_HASHES = {
    dashboard: '#dashboard',
    products: '#products',
    'collect-box': '#collect-box',
    'import-history': '#listings',
    reshelf: '#listings',
    watermark: '#config',
    stores: '#stores',
  };

  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      if (action === 'batch-upload') {
        chrome.windows.create({
          url: chrome.runtime.getURL('src/batch-upload/index.html'),
          type: 'popup',
          width: 1100,
          height: 760,
        });
      } else if (ACTION_HASHES[action]) {
        const { baseUrl } = await sendMessage({ type: 'getErpBaseUrl' });
        chrome.tabs.create({ url: (baseUrl || 'http://localhost:3001') + '/admin' + ACTION_HASHES[action] });
      } else if (action === 'pricing' || action === 'data-panel') {
        // 这些功能在商品页激活,popup 里只提示
        const tip = document.getElementById('login-tip');
        if (tip) {
          tip.textContent = action === 'pricing' ? '请在 Ozon 商品页使用 MY 算价' : '数据面板在商品搜索页自动显示';
          tip.style.display = 'block';
          setTimeout(() => {
            tip.style.display = 'none';
          }, 2000);
        }
      }
    });
  });

  // 启动:检查 chrome.storage 是否有 token;有则进主视图并加载店铺
  chrome.storage.local.get([STORAGE_KEYS.token], async (result) => {
    if (result[STORAGE_KEYS.token]) {
      setLoginState(true);
      await loadStores();
    } else {
      setLoginState(false);
    }
  });
})();
