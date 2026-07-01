// ERP 配置后台前端逻辑 —— 纯原生 JS,无依赖
// 账号:由 .env 的 USER_PHONE / USER_PASSWORD 配置,登录后 token 存 localStorage

const TOKEN_KEY = 'erp_admin_token';
const USER_KEY = 'erp_admin_user';
const PHONE_KEY = 'erp_admin_phone'; // 记住上次手机号,便于复用

// ── 工具函数 ────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); }

function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}
function setUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

// 统一 fetch 封装:自动带 token、处理 401、处理业务错误码
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  // 滑动续期:后端通过 X-Refreshed-Token 头下发新 token
  const refreshed = res.headers.get('X-Refreshed-Token');
  if (refreshed) setToken(refreshed);

  if (res.status === 401) {
    clearToken();
    showLogin();
    throw new Error('登录已过期,请重新登录');
  }

  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const msg = data?.message || `请求失败 (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function toast(msg, type = '') {
  const el = $('#globalMsg');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── 视图切换 ────────────────────────────────────────────────
function showLogin() {
  $('#loginView').hidden = false;
  $('#mainView').hidden = true;
  $('#userBadge').hidden = true;
  $('#logoutBtn').hidden = true;
  const lastPhone = localStorage.getItem(PHONE_KEY);
  if (lastPhone) $('#loginPhone').value = lastPhone;
  $('#loginPassword').focus();
}

function showMain() {
  $('#loginView').hidden = true;
  $('#mainView').hidden = false;
  const u = getUser();
  if (u) {
    $('#userBadge').hidden = false;
    $('#userBadge').textContent = '👤 ' + (u.phone || '');
  }
  $('#logoutBtn').hidden = false;
  loadStores();
}

// ── 登录 ────────────────────────────────────────────────────
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phoneNumber = $('#loginPhone').value.trim();
  const password = $('#loginPassword').value;
  const errEl = $('#loginError');
  errEl.hidden = true;
  try {
    const r = await api('/auth/login-password', { method: 'POST', body: { phoneNumber, password } });
    setToken(r.accessToken);
    setUser(r.user);
    localStorage.setItem(PHONE_KEY, phoneNumber);
    $('#loginPassword').value = '';
    showMain();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

$('#logoutBtn').addEventListener('click', () => {
  clearToken();
  showLogin();
});

// ── 店铺列表 ────────────────────────────────────────────────
let storesCache = [];

async function loadStores() {
  const container = $('#storeList');
  container.innerHTML = '<p class="muted">加载中...</p>';
  try {
    const r = await api('/admin/api/stores');
    storesCache = r?.data || [];
    renderStores(storesCache);
  } catch (err) {
    container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
  }
}

function renderStores(stores) {
  const container = $('#storeList');
  if (!stores.length) {
    container.innerHTML = '<div class="empty">暂无店铺,点击右上角「+ 新增店铺」开始配置</div>';
    return;
  }
  container.innerHTML = stores.map(renderStoreCard).join('');
  // 绑定事件
  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', onStoreAction);
  });
}

function renderStoreCard(s) {
  const clientId = s.sync_credentials?.clientId || '';
  const apiKey = s.sync_credentials?.apiKey || '';
  const credState = clientId && apiKey
    ? '<span class="badge badge-pending">未验证</span>'
    : '<span class="badge badge-fail">未配置</span>';
  return `
    <div class="store-card" data-id="${escapeHtml(s.id)}">
      <div class="store-card-head">
        <h3>${escapeHtml(s.name)}</h3>
        <span class="store-id">${escapeHtml(s.id)}</span>
      </div>
      <div class="store-fields">
        <div class="row"><span class="k">公司ID</span><span class="v">${escapeHtml(s.company_id || '—')}</span></div>
        <div class="row"><span class="k">默认仓库</span><span class="v">${escapeHtml(s.warehouse_id || '—')}</span></div>
        <div class="row"><span class="k">Client-Id</span><span class="v">${escapeHtml(clientId || '—')}</span></div>
        <div class="row"><span class="k">Api-Key</span><span class="v">${escapeHtml(apiKey || '—')}</span></div>
        <div class="row"><span class="k">凭据状态</span><span class="v">${credState}</span></div>
      </div>
      <div class="store-card-actions">
        <button class="btn btn-sm btn-ghost" data-action="warehouses" data-id="${escapeHtml(s.id)}">查看仓库</button>
        <button class="btn btn-sm btn-ghost" data-action="test" data-id="${escapeHtml(s.id)}">测试连接</button>
        <button class="btn btn-sm btn-ghost" data-action="edit" data-id="${escapeHtml(s.id)}">编辑</button>
        <button class="btn btn-sm btn-danger" data-action="delete" data-id="${escapeHtml(s.id)}">删除</button>
      </div>
    </div>`;
}

async function onStoreAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const store = storesCache.find((s) => s.id === id);
  if (!store) return;
  if (action === 'edit') openStoreModal(store);
  else if (action === 'delete') await deleteStore(store);
  else if (action === 'test') await testConnectionForStore(store);
  else if (action === 'warehouses') await openWarehouseModal(store);
}

// ── 新增/编辑弹窗 ───────────────────────────────────────────
$('#addStoreBtn').addEventListener('click', () => openStoreModal(null));

function openStoreModal(store) {
  const isEdit = !!store;
  $('#modalTitle').textContent = isEdit ? '编辑店铺' : '新增店铺';
  $('#storeId').value = isEdit ? store.id : '';
  $('#storeName').value = isEdit ? store.name : '';
  $('#storeCompanyId').value = isEdit ? (store.company_id || '') : '';
  $('#storeWarehouseId').value = isEdit ? (store.warehouse_id || '') : '';
  $('#storeClientId').value = isEdit ? (store.sync_credentials?.clientId || '') : '';
  $('#storeApiKey').value = isEdit ? (store.sync_credentials?.apiKey || '') : '';
  $('#formError').hidden = true;
  $('#storeModal').hidden = false;
}

function closeStoreModal() { $('#storeModal').hidden = true; }

function readStoreForm() {
  return {
    name: $('#storeName').value.trim(),
    company_id: $('#storeCompanyId').value.trim(),
    warehouse_id: $('#storeWarehouseId').value.trim(),
    sync_credentials: {
      clientId: $('#storeClientId').value.trim(),
      apiKey: $('#storeApiKey').value.trim(),
    },
  };
}

// 弹窗关闭按钮(所有 [data-close])
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target.matches('.modal-mask')) {
    $$('.modal').forEach((m) => { m.hidden = true; });
  }
});

$('#storeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#formError');
  errEl.hidden = true;
  const id = $('#storeId').value;
  const body = readStoreForm();
  if (!body.name) { errEl.textContent = '店铺名称必填'; errEl.hidden = false; return; }
  try {
    if (id) {
      await api('/admin/api/stores/' + encodeURIComponent(id), { method: 'PUT', body });
      toast('店铺已更新', 'success');
    } else {
      await api('/admin/api/stores', { method: 'POST', body });
      toast('店铺已新增', 'success');
    }
    closeStoreModal();
    await loadStores();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

// 测试连接(用当前表单内填写的凭据,无需先保存)
$('#testConnBtn').addEventListener('click', async () => {
  const errEl = $('#formError');
  errEl.hidden = true;
  const body = readStoreForm();
  if (!body.sync_credentials.clientId || !body.sync_credentials.apiKey) {
    errEl.textContent = '请先填写 Client-Id 与 Api-Key';
    errEl.hidden = false;
    return;
  }
  const btn = $('#testConnBtn');
  btn.disabled = true; btn.textContent = '测试中...';
  try {
    const r = await api('/admin/api/test-connection', { method: 'POST', body: { sync_credentials: body.sync_credentials } });
    const result = r?.data || {};
    if (result.success) {
      const n = (result.warehouses || []).length;
      toast(`连接成功,共 ${n} 个仓库`, 'success');
      // 若未填默认仓库且仅有一个仓库,自动回填
      if (!$('#storeWarehouseId').value && n === 1) {
        $('#storeWarehouseId').value = result.warehouses[0].id || '';
      }
    } else {
      errEl.textContent = '连接失败:' + (result.error || '未知错误');
      errEl.hidden = false;
    }
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = '测试连接';
  }
});

// ── 删除店铺 ────────────────────────────────────────────────
async function deleteStore(store) {
  if (!confirm(`确认删除店铺「${store.name}」?此操作不可恢复。`)) return;
  try {
    await api('/admin/api/stores/' + encodeURIComponent(store.id), { method: 'DELETE' });
    toast('已删除', 'success');
    await loadStores();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── 已保存店铺的测试连接 ───────────────────────────────────
async function testConnectionForStore(store) {
  toast(`正在测试「${store.name}」连接...`);
  try {
    const r = await api('/admin/api/stores/' + encodeURIComponent(store.id) + '/test-connection', { method: 'POST' });
    const result = r?.data || {};
    if (result.success) {
      const n = (result.warehouses || []).length;
      toast(`「${store.name}」连接成功,共 ${n} 个仓库`, 'success');
    } else {
      toast(`「${store.name}」连接失败:` + (result.error || '未知错误'), 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── 仓库列表弹窗 ───────────────────────────────────────────
let currentWhStoreId = null;

async function openWarehouseModal(store) {
  currentWhStoreId = store.id;
  $('#whStoreName').textContent = '· ' + store.name;
  $('#warehouseModal').hidden = false;
  $('#warehouseList').innerHTML = '';
  await fetchWarehouses();
}

$('#refreshWhBtn').addEventListener('click', () => { if (currentWhStoreId) fetchWarehouses(); });

async function fetchWarehouses() {
  if (!currentWhStoreId) return;
  const statusEl = $('#whStatus');
  const listEl = $('#warehouseList');
  statusEl.textContent = '正在从 Ozon 实时拉取...';
  listEl.innerHTML = '';
  try {
    const r = await api('/admin/api/stores/' + encodeURIComponent(currentWhStoreId) + '/warehouses');
    const result = r?.data || {};
    if (result.success) {
      const items = result.warehouses || [];
      statusEl.textContent = `共 ${items.length} 个仓库(实时拉取)`;
      if (!items.length) {
        listEl.innerHTML = '<div class="empty">OPI 未返回任何仓库,请确认店铺凭据与仓库已开通</div>';
        return;
      }
      listEl.innerHTML = items.map(renderWhItem).join('');
      listEl.querySelectorAll('[data-set-wh]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const wid = btn.dataset.setWh;
          const store = storesCache.find((s) => s.id === currentWhStoreId);
          if (!store) return;
          try {
            await api('/admin/api/stores/' + encodeURIComponent(store.id), {
              method: 'PUT',
              body: {
                name: store.name,
                company_id: store.company_id || '',
                warehouse_id: wid,
                sync_credentials: store.sync_credentials,
              },
            });
            toast('已设为默认仓库', 'success');
            await loadStores();
            $('#warehouseModal').hidden = true;
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
    } else {
      statusEl.textContent = '连接失败';
      listEl.innerHTML = `<div class="empty error-text">${escapeHtml(result.error || '未知错误')}</div>`;
    }
  } catch (err) {
    statusEl.textContent = '请求失败';
    listEl.innerHTML = `<div class="empty error-text">${escapeHtml(err.message)}</div>`;
  }
}

function renderWhItem(w) {
  // OPI /v2/warehouse/list 实际返回字段:warehouse_id / name / warehouse_type / status / is_rfbs / ...
  const id = w.warehouse_id ?? w.id ?? '';
  const name = w.name || '';
  const meta = [
    w.warehouse_type || null,
    w.status || null,
    w.is_rfbs ? 'RFBS' : null,
  ].filter(Boolean).join(' · ');
  return `
    <div class="wh-item">
      <div class="wh-info">
        <span class="wh-name">${escapeHtml(name || '(未命名)')}</span>
        <span class="wh-meta">ID: ${escapeHtml(id)}${meta ? ' · ' + escapeHtml(meta) : ''}</span>
      </div>
      <button class="btn btn-sm btn-ghost" data-set-wh="${escapeHtml(id)}">设为默认</button>
    </div>`;
}

// ── 启动 ────────────────────────────────────────────────────
(async function init() {
  if (getToken()) {
    // 用 /admin/api/stores 探测 token 是否仍有效
    try {
      await api('/admin/api/stores');
      showMain();
    } catch {
      showLogin();
    }
  } else {
    showLogin();
  }
})();
