/**
 * 我的妙手助手 popup
 * 1) 质检单前缀设置(妙手 ERP 订单页高亮)
 * 2) 拼多多登录同步(2026-09-14):把本浏览器 PDD 登录态同步给 ERP 后台
 *    链路经 background 中转:采 cookie → ERP 页面桥 → 后端注入 cloakbrowser
 *    设计文档: docs/PDD登录同步-概要设计.md §4.1
 */
(function () {
  'use strict';

  // ── 质检单前缀设置 ─────────────────────────────────────
  const STORAGE_KEY = 'qc_prefixes';
  const DEFAULT_PREFIXES = ['02131', '024785'];

  const $textarea = document.getElementById('prefixes');
  const $save = document.getElementById('save');
  const $reset = document.getElementById('reset');
  const $toast = document.getElementById('toast');

  function showToast(msg, isError) {
    if (!$toast) return;
    $toast.textContent = msg;
    $toast.classList.toggle('toast-error', !!isError);
    $toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      $toast.hidden = true;
    }, 2600);
  }

  function load() {
    chrome.storage.sync.get([STORAGE_KEY], (res) => {
      const list = res && Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : DEFAULT_PREFIXES;
      $textarea.value = list.filter((s) => typeof s === 'string' && s.trim()).join('\n');
    });
  }

  function save() {
    const raw = $textarea.value || '';
    const list = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const finalList = list.length ? list : DEFAULT_PREFIXES.slice();
    chrome.storage.sync.set({ [STORAGE_KEY]: finalList }, () => {
      if (chrome.runtime.lastError) {
        showToast('保存失败：' + chrome.runtime.lastError.message, true);
        return;
      }
      $textarea.value = finalList.join('\n');
      showToast('已保存（共 ' + finalList.length + ' 条）');
    });
  }

  function reset() {
    chrome.storage.sync.set({ [STORAGE_KEY]: DEFAULT_PREFIXES.slice() }, () => {
      $textarea.value = DEFAULT_PREFIXES.join('\n');
      showToast('已恢复默认');
    });
  }

  $save.addEventListener('click', save);
  $reset.addEventListener('click', reset);

  // ── 拼多多登录同步 ─────────────────────────────────────
  // 2026-09-15 起直连 ERP 后端:popup 登录(手机号+密码→JWT)后,
  // 账号列表/cookie 同步均由 background 直接 fetch 后端 API,无需打开 ERP 页面
  const $state = document.getElementById('pdd-login-state');
  const $backend = document.getElementById('erp-backend');
  const $erpAuthState = document.getElementById('erp-auth-state');
  const $erpLoginRow = document.getElementById('erp-login-row');
  const $erpPhone = document.getElementById('erp-phone');
  const $erpPassword = document.getElementById('erp-password');
  const $erpLoginBtn = document.getElementById('erp-login-btn');
  const $account = document.getElementById('pdd-account');
  const $accountsHint = document.getElementById('pdd-accounts-hint');
  const $syncBtn = document.getElementById('pdd-sync');
  const ACCOUNT_KEY = 'pddSyncAccount';
  let syncing = false;

  /** 向 background 发消息(Promise 包装) */
  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: '扩展后台无响应' });
      });
    });
  }

  // ── ERP 后端选择(参考 qx-ozon;选中后端 = API 直连该地址)──
  async function initBackendSelect() {
    const r = await sendMsg({ type: 'GET_ERP_BACKENDS' });
    if (!r || !r.ok || !Array.isArray(r.candidates)) return;
    $backend.innerHTML = '';
    for (const c of r.candidates) {
      const opt = document.createElement('option');
      opt.value = c.url;
      opt.textContent = c.label;
      if (c.url === r.selected) opt.selected = true;
      $backend.appendChild(opt);
    }
  }

  /** 刷新 ERP 登录态展示(未登录时显示登录表单) */
  async function refreshErpAuth() {
    const r = await sendMsg({ type: 'ERP_AUTH_STATE' });
    if (r && r.ok && r.loggedIn) {
      const who = (r.user && (r.user.phone || r.user.username)) || '已登录';
      $erpAuthState.textContent = `ERP 已登录：${who}`;
      $erpAuthState.className = 'pdd-login-state ok';
      $erpLoginRow.hidden = true;
    } else {
      $erpAuthState.textContent = `ERP 未登录(${(r && r.backend) || '未知后端'})`;
      $erpAuthState.className = 'pdd-login-state err';
      $erpLoginRow.hidden = false;
    }
  }

  $erpLoginBtn.addEventListener('click', async () => {
    const phoneNumber = ($erpPhone.value || '').trim();
    const password = $erpPassword.value || '';
    if (!phoneNumber || !password) {
      showToast('请输入 ERP 手机号和密码', true);
      return;
    }
    $erpLoginBtn.disabled = true;
    $erpLoginBtn.textContent = '登录中…';
    try {
      const r = await sendMsg({ type: 'ERP_LOGIN', phoneNumber, password });
      if (r && r.ok) {
        $erpPassword.value = '';
        showToast('ERP 登录成功');
        await refreshErpAuth();
        await refreshAccounts(); // 登录后立即拉账号列表
      } else {
        showToast('登录失败：' + ((r && r.error) || '未知错误'), true);
      }
    } finally {
      $erpLoginBtn.disabled = false;
      $erpLoginBtn.textContent = '登录';
    }
  });

  $backend.addEventListener('change', async () => {
    const r = await sendMsg({ type: 'SET_ERP_BACKEND', url: $backend.value });
    if (!r || !r.ok) {
      showToast('切换失败：' + ((r && r.error) || '未知错误'), true);
      await initBackendSelect(); // 回滚显示到实际生效值
      return;
    }
    showToast('已切换 ERP 后端');
    // 登录态/账号列表按后端隔离,切换后都要重查
    await refreshErpAuth();
    await refreshAccounts();
  });

  async function initPddSync() {
    await initBackendSelect();
    await refreshErpAuth();
    // 拼多多登录态探测(与 ERP 登录态独立)
    const st = await sendMsg({ type: 'PDD_LOGIN_STATE' });
    if (st && st.loggedIn) {
      const who = st.nickname ? `${st.nickname} (${st.uid})` : st.uid;
      $state.textContent = `已登录：${who}`;
      $state.classList.add('ok');
    } else {
      $state.textContent = '未登录拼多多(请先在本浏览器登录 mobile.yangkeduo.com)';
      $state.classList.add('err');
      $syncBtn.disabled = true;
      return; // 未登录时不拉账号(同步按钮保持禁用)
    }
    // 账号列表(直连 status 接口 + 缓存)
    await refreshAccounts();
  }

  async function refreshAccounts() {
    const acc = await sendMsg({ type: 'PDD_GET_ACCOUNTS' });
    const accounts = (acc && acc.accounts) || [];
    if (accounts.length) {
      $account.innerHTML = '';
      for (const a of accounts) {
        const opt = document.createElement('option');
        opt.value = a;
        opt.textContent = a;
        $account.appendChild(opt);
      }
      // 记忆上次选择
      const v = await chrome.storage.local.get(ACCOUNT_KEY).catch(() => ({}));
      if (v[ACCOUNT_KEY] && accounts.includes(v[ACCOUNT_KEY])) $account.value = v[ACCOUNT_KEY];
      $accountsHint.textContent = acc.cached ? '账号列表来自缓存(ERP 登录后可刷新)' : '';
      $syncBtn.disabled = false;
    } else {
      $accountsHint.textContent = (acc && acc.error) || '获取账号列表失败';
      $syncBtn.disabled = true;
    }
  }

  async function doSync() {
    if (syncing) return;
    const account = $account.value;
    if (!account) {
      showToast('请选择要同步的 ERP 账号', true);
      return;
    }
    syncing = true;
    $syncBtn.disabled = true;
    $syncBtn.textContent = '同步中…';
    try {
      await chrome.storage.local.set({ [ACCOUNT_KEY]: account }).catch(() => {});
      const r = await sendMsg({ type: 'PDD_POPUP_SYNC', payload: { account } });
      if (r && r.ok) {
        const d = r.data || {};
        showToast(`已同步到 ${d.account || account}(${d.cookieCount || '?'} 条 cookie${d.injected ? ',已注入运行中浏览器' : ',下次拉单自动生效'})`);
      } else {
        showToast('同步失败：' + ((r && r.error) || '未知错误'), true);
        // token 过期:唤出登录表单
        if (r && r.authRequired) await refreshErpAuth();
      }
    } finally {
      syncing = false;
      $syncBtn.textContent = '同步登录到 ERP';
      $syncBtn.disabled = !$account.value;
    }
  }

  $syncBtn.addEventListener('click', doSync);

  document.addEventListener('DOMContentLoaded', () => {
    load();
    initPddSync();
  });
})();
