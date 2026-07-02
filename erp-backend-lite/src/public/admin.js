// ERP 配置后台前端逻辑 —— 纯原生 JS,无依赖
// 账号:由 .env 的 USER_PHONE / USER_PASSWORD 配置,登录后 token 存 localStorage

const TOKEN_KEY = 'erp_admin_token';
const USER_KEY = 'erp_admin_user';
const PHONE_KEY = 'erp_admin_phone'; // 记住上次手机号,便于复用

// ── 工具函数 ────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}
function setUser(u) {
  localStorage.setItem(USER_KEY, JSON.stringify(u));
}

// 统一 fetch 封装:自动带 token、处理 401、处理业务错误码
async function api(path, { method = 'GET', body, headers: extraHeaders } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (extraHeaders) Object.assign(headers, extraHeaders);
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
  try {
    data = await res.json();
  } catch {
    data = null;
  }
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
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  loadListings();
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
    // 同步更新上架记录页的店铺筛选下拉
    syncStoreFilter();
  } catch (err) {
    container.innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
  }
}

// 把 storesCache 填充到上架记录 + 采集箱筛选下拉
function syncStoreFilter() {
  const sel = $('#filterStore');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">全部店铺</option>' +
      storesCache.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    if (cur) sel.value = cur;
  }
  const cbSel = $('#cbFilterStore');
  if (cbSel) {
    const cur = cbSel.value;
    cbSel.innerHTML =
      '<option value="">全部店铺</option>' +
      storesCache.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    if (cur) cbSel.value = cur;
  }
  const btSel = $('#batchFilterStore');
  if (btSel) {
    const cur = btSel.value;
    btSel.innerHTML =
      '<option value="">全部店铺</option>' +
      storesCache.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    if (cur) btSel.value = cur;
  }
  const prodSel = $('#prodFilterStore');
  if (prodSel) {
    const cur = prodSel.value;
    prodSel.innerHTML =
      '<option value="">全部店铺</option>' +
      storesCache.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    if (cur) prodSel.value = cur;
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
  const credState =
    clientId && apiKey
      ? '<span class="badge badge-pending">未验证</span>'
      : '<span class="badge badge-fail">未配置</span>';
  const currency = s.currency_code || 'RUB';
  return `
    <div class="store-card" data-id="${escapeHtml(s.id)}">
      <div class="store-card-head">
        <h3>${escapeHtml(s.name)}</h3>
        <span class="store-id">${escapeHtml(s.id)}</span>
      </div>
      <div class="store-fields">
        <div class="row"><span class="k">公司ID</span><span class="v">${escapeHtml(s.company_id || '—')}</span></div>
        <div class="row"><span class="k">默认仓库</span><span class="v">${escapeHtml(s.warehouse_id || '—')}</span></div>
        <div class="row"><span class="k">合同货币</span><span class="v"><strong>${escapeHtml(currency)}</strong></span></div>
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
  $('#storeCompanyId').value = isEdit ? store.company_id || '' : '';
  $('#storeWarehouseId').value = isEdit ? store.warehouse_id || '' : '';
  $('#storeCurrencyCode').value = isEdit && store.currency_code ? store.currency_code : 'RUB';
  $('#storeClientId').value = isEdit ? store.sync_credentials?.clientId || '' : '';
  $('#storeApiKey').value = isEdit ? store.sync_credentials?.apiKey || '' : '';
  $('#formError').hidden = true;
  $('#storeModal').hidden = false;
}

function closeStoreModal() {
  $('#storeModal').hidden = true;
}

function readStoreForm() {
  return {
    name: $('#storeName').value.trim(),
    company_id: $('#storeCompanyId').value.trim(),
    warehouse_id: $('#storeWarehouseId').value.trim(),
    currency_code: $('#storeCurrencyCode').value,
    sync_credentials: {
      clientId: $('#storeClientId').value.trim(),
      apiKey: $('#storeApiKey').value.trim(),
    },
  };
}

// 弹窗关闭按钮(所有 [data-close])
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target.matches('.modal-mask')) {
    $$('.modal').forEach((m) => {
      m.hidden = true;
    });
  }
});

$('#storeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#formError');
  errEl.hidden = true;
  const id = $('#storeId').value;
  const body = readStoreForm();
  if (!body.name) {
    errEl.textContent = '店铺名称必填';
    errEl.hidden = false;
    return;
  }
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
  btn.disabled = true;
  btn.textContent = '测试中...';
  try {
    const r = await api('/admin/api/test-connection', {
      method: 'POST',
      body: { sync_credentials: body.sync_credentials },
    });
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
    btn.disabled = false;
    btn.textContent = '测试连接';
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

$('#refreshWhBtn').addEventListener('click', () => {
  if (currentWhStoreId) fetchWarehouses();
});

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
  const meta = [w.warehouse_type || null, w.status || null, w.is_rfbs ? 'RFBS' : null].filter(Boolean).join(' · ');
  return `
    <div class="wh-item">
      <div class="wh-info">
        <span class="wh-name">${escapeHtml(name || '(未命名)')}</span>
        <span class="wh-meta">ID: ${escapeHtml(id)}${meta ? ' · ' + escapeHtml(meta) : ''}</span>
      </div>
      <button class="btn btn-sm btn-ghost" data-set-wh="${escapeHtml(id)}">设为默认</button>
    </div>`;
}

// ── Tab 切换 ────────────────────────────────────────────────
function switchTab(target) {
  const btn = document.querySelector(`.tab[data-tab="${target}"]`);
  if (!btn) return;
  $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tab-panel').forEach((p) => {
    const isActive = p.id === 'tab' + target.charAt(0).toUpperCase() + target.slice(1);
    p.classList.toggle('active', isActive);
    // 同步 hidden 属性:CSS 中 [hidden]{display:none !important} 会覆盖 .active,
    // 因此切换 tab 时必须同时维护 hidden,否则面板内容不可见
    p.hidden = !isActive;
  });
  if (target === 'dashboard') loadDashboard();
  else if (target === 'listings') loadListings();
  else if (target === 'collect-box') loadCollectBox();
  else if (target === 'products') loadProducts();
  else if (target === 'batch') loadBatch();
  else if (target === 'audit') loadAudit();
  else if (target === 'config') loadConfig();
  // 同步 URL hash,支持深链直达
  if (location.hash !== '#' + target) {
    history.replaceState(null, '', '#' + target);
  }
}

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// 监听 URL hash 变化(支持 popup 导航跳转 /admin#collect-box 等)
window.addEventListener('hashchange', () => {
  const h = location.hash.replace(/^#/, '');
  if (h && document.querySelector(`.tab[data-tab="${h}"]`)) {
    switchTab(h);
  }
});

// ── 首页统计 ────────────────────────────────────────────────
async function loadDashboard() {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set('dashTodayTotal', '加载中...');
  [
    'dashTodaySuccess',
    'dashTodayFailed',
    'dashCollect',
    'dashProducts',
    'dashStores',
    'dashTodayRate',
    'dashTodaySub',
  ].forEach((id) => set(id, ''));
  document.getElementById('dashChart').innerHTML =
    '<div class="muted" style="padding:24px;text-align:center">加载中...</div>';
  try {
    const r = await api('/admin/api/dashboard-stats');
    const d = r.data || r;
    set('dashTodayTotal', d.today.total);
    set('dashTodaySuccess', d.today.success);
    set('dashTodayFailed', d.today.failed);
    set('dashTodayRate', d.today.total > 0 ? `成功率 ${d.today.successRate}%` : '');
    set('dashCollect', d.collectPending);
    set('dashProducts', d.productCount);
    set('dashStores', d.storeCount);
    renderDashTrend(d.trend || []);
  } catch (e) {
    set('dashTodayTotal', '加载失败');
    document.getElementById('dashChart').innerHTML =
      '<div class="muted" style="padding:24px;text-align:center">加载失败: ' + esc(String(e.message || e)) + '</div>';
  }
}

function renderDashTrend(trend) {
  const el = document.getElementById('dashChart');
  if (!trend.length) {
    el.innerHTML = '<div class="muted" style="padding:24px;text-align:center">近 7 天暂无数据</div>';
    return;
  }
  const maxN = Math.max(1, ...trend.map((t) => t.total));
  const bars = trend
    .map((t) => {
      const hTotal = Math.round((t.total / maxN) * 100);
      const hOk = t.total > 0 ? Math.round((t.success / t.total) * hTotal) : 0;
      const label = t.date.slice(5); // MM-DD
      return (
        '<div class="dash-bar-col">' +
        '<div class="dash-bar-wrap">' +
        '<div class="dash-bar dash-bar-total" style="height:' +
        hTotal +
        '%"></div>' +
        '<div class="dash-bar dash-bar-ok" style="height:' +
        hOk +
        '%"></div>' +
        '</div>' +
        '<div class="dash-bar-label">' +
        label +
        '</div>' +
        '<div class="dash-bar-num">' +
        t.total +
        '</div>' +
        '</div>'
      );
    })
    .join('');
  el.innerHTML =
    '<div class="dash-bar-chart">' +
    bars +
    '</div>' +
    '<div class="dash-legend"><span class="dash-legend-item"><i class="dash-dot dash-dot-total"></i>总上架</span>' +
    '<span class="dash-legend-item"><i class="dash-dot dash-dot-ok"></i>成功</span></div>';
}

document.getElementById('refreshDashboardBtn')?.addEventListener('click', loadDashboard);

// ── 批量上架任务 ────────────────────────────────────────────
let batchState = { currentPage: 1, pageSize: 20, total: 0 };

const BATCH_STATUS_LABEL = {
  PENDING: '待处理',
  RUNNING: '进行中',
  SUCCESS: '成功',
  PARTIAL: '部分成功',
  FAILED: '失败',
};
const BATCH_STATUS_CLASS = {
  PENDING: 'tag tag-muted',
  RUNNING: 'tag tag-info',
  SUCCESS: 'tag tag-ok',
  PARTIAL: 'tag tag-warn',
  FAILED: 'tag tag-err',
};

async function loadBatch() {
  const body = $('#batchBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">加载中...</td></tr>';
  const params = new URLSearchParams();
  params.set('currentPage', batchState.currentPage);
  params.set('pageSize', batchState.pageSize);
  const storeId = $('#batchFilterStore')?.value;
  const status = $('#batchFilterStatus')?.value;
  const keyword = $('#batchFilterKeyword')?.value.trim();
  if (storeId) params.set('storeId', storeId);
  if (status) params.set('status', status);
  if (keyword) params.set('keyword', keyword);
  try {
    const r = await api('/admin/api/batch-tasks?' + params.toString());
    const d = r.data || r;
    batchState.total = d.total || 0;
    renderBatch(d.items || []);
    renderBatchPager();
  } catch (e) {
    body.innerHTML =
      '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">加载失败: ' +
      escapeHtml(String(e.message || e)) +
      '</td></tr>';
  }
}

function renderBatch(items) {
  const body = $('#batchBody');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">暂无数据</td></tr>';
    return;
  }
  body.innerHTML = items
    .map((t) => {
      const progress = `${t.successCount}/${t.totalCount}` + (t.failedCount > 0 ? `(失败${t.failedCount})` : '');
      const storeName = (storesCache.find((s) => s.id === t.storeId) || {}).name || t.storeId;
      return (
        '<tr>' +
        '<td><a class="link" data-batch-detail="' +
        escapeHtml(t.localTaskId) +
        '">' +
        escapeHtml(t.localTaskId) +
        '</a></td>' +
        '<td>' +
        escapeHtml(storeName) +
        '</td>' +
        '<td>' +
        escapeHtml(progress) +
        '</td>' +
        '<td><span class="' +
        (BATCH_STATUS_CLASS[t.status] || 'tag tag-muted') +
        '">' +
        (BATCH_STATUS_LABEL[t.status] || t.status) +
        '</span></td>' +
        '<td>' +
        escapeHtml(t.createdAt || '') +
        '</td>' +
        '<td class="row-actions">' +
        '<button class="btn btn-sm" data-batch-detail="' +
        escapeHtml(t.localTaskId) +
        '">详情</button>' +
        (t.failedCount > 0
          ? ' <button class="btn btn-sm" data-batch-retry="' + escapeHtml(t.localTaskId) + '">重试</button>'
          : '') +
        ' <button class="btn btn-sm btn-danger" data-batch-delete="' +
        escapeHtml(t.localTaskId) +
        '">删除</button>' +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
}

function renderBatchPager() {
  const pager = $('#batchPager');
  const pages = Math.ceil(batchState.total / batchState.pageSize) || 1;
  pager.innerHTML =
    `<span class="pager-info">共 ${batchState.total} 条 / ${pages} 页</span>` +
    (batchState.currentPage > 1
      ? `<button class="btn btn-sm" data-batch-page="${batchState.currentPage - 1}">上一页</button>`
      : '') +
    (batchState.currentPage < pages
      ? `<button class="btn btn-sm" data-batch-page="${batchState.currentPage + 1}">下一页</button>`
      : '');
}

async function openBatchDetail(localTaskId) {
  const modal = $('#batchDetailModal');
  const body = $('#batchDetailBody');
  body.innerHTML = '<div class="muted" style="padding:24px;text-align:center">加载中...</div>';
  modal.hidden = false;
  try {
    const r = await api('/ozon/products/batch-import/' + encodeURIComponent(localTaskId));
    const d = r.data || r;
    const itemsHtml = (d.items || [])
      .map((it) => {
        const cls = it.status === 'SUCCESS' ? 'tag tag-ok' : it.status === 'FAILED' ? 'tag tag-err' : 'tag tag-muted';
        return (
          '<tr>' +
          '<td>' +
          escapeHtml(it.sourceSku || '-') +
          '</td>' +
          '<td>' +
          (it.sourceUrl ? `<a href="${escapeHtml(it.sourceUrl)}" target="_blank" class="link">查看</a>` : '-') +
          '</td>' +
          '<td><span class="' +
          cls +
          '">' +
          escapeHtml(it.status) +
          '</span></td>' +
          '<td>' +
          escapeHtml(it.errorMessage || it.followTaskId || '-') +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
    body.innerHTML =
      '<div class="batch-detail-head">' +
      '<div><b>任务ID:</b> ' +
      escapeHtml(d.localTaskId) +
      '</div>' +
      '<div><b>店铺:</b> ' +
      escapeHtml(d.storeId) +
      '</div>' +
      '<div><b>状态:</b> <span class="' +
      (BATCH_STATUS_CLASS[d.status] || 'tag tag-muted') +
      '">' +
      (BATCH_STATUS_LABEL[d.status] || d.status) +
      '</span></div>' +
      '<div><b>进度:</b> ' +
      d.successCount +
      '/' +
      d.totalCount +
      (d.failedCount > 0 ? '(失败' + d.failedCount + ')' : '') +
      '</div>' +
      '<div><b>创建:</b> ' +
      escapeHtml(d.createdAt || '-') +
      '</div>' +
      '<div><b>完成:</b> ' +
      escapeHtml(d.completedAt || '-') +
      '</div>' +
      '</div>' +
      '<table class="data-table"><thead><tr><th>SKU</th><th>来源</th><th>状态</th><th>说明/关联任务</th></tr></thead><tbody>' +
      (itemsHtml || '<tr><td colspan="4" class="muted">无明细</td></tr>') +
      '</tbody></table>';
  } catch (e) {
    body.innerHTML = '<div class="muted">加载失败: ' + escapeHtml(String(e.message || e)) + '</div>';
  }
}

async function deleteBatch(localTaskId) {
  if (!confirm('确认删除批量任务 ' + localTaskId + '?')) return;
  try {
    await api('/ozon/products/batch-import/' + encodeURIComponent(localTaskId), { method: 'DELETE' });
    loadBatch();
  } catch (e) {
    alert('删除失败: ' + (e.message || e));
  }
}

async function retryBatch(localTaskId) {
  try {
    const r = await api('/ozon/products/batch-import/' + encodeURIComponent(localTaskId) + '/retry', {
      method: 'POST',
    });
    const d = r.data || r;
    alert('已重置 ' + (d.resetCount || 0) + ' 个失败项,等待重新执行');
    loadBatch();
  } catch (e) {
    alert('重试失败: ' + (e.message || e));
  }
}

// 批量任务事件委托(详情/重试/删除/分页)
document.addEventListener('click', (e) => {
  const t = e.target;
  const detailId = t.getAttribute?.('data-batch-detail');
  const retryId = t.getAttribute?.('data-batch-retry');
  const deleteId = t.getAttribute?.('data-batch-delete');
  const page = t.getAttribute?.('data-batch-page');
  if (detailId) {
    openBatchDetail(detailId);
  } else if (retryId) {
    retryBatch(retryId);
  } else if (deleteId) {
    deleteBatch(deleteId);
  } else if (page) {
    batchState.currentPage = parseInt(page, 10) || 1;
    loadBatch();
  }
});
$('#batchSearchBtn')?.addEventListener('click', () => {
  batchState.currentPage = 1;
  loadBatch();
});
$('#batchRefreshBtn')?.addEventListener('click', loadBatch);

// ── 操作日志 ────────────────────────────────────────────────
let auditState = { currentPage: 1, pageSize: 20, total: 0 };

const AUDIT_ACTION_LABEL = {
  'store.create': '创建店铺',
  'store.update': '更新店铺',
  'store.delete': '删除店铺',
  'listing.import': '上架提交',
  'listing.importReport': '上架报告',
  'collect.create': '采集新增',
  'collect.batchCreate': '批量采集',
  'collect.delete': '采集删除',
  'collect.update': '采集更新',
  'config.update': '配置变更',
  'watermark.create': '水印模板新增',
  'watermark.update': '水印模板变更',
  'batch.create': '批量上架创建',
  'batch.delete': '批量上架删除',
  'batch.retry': '批量重试',
};

async function loadAudit() {
  const body = $('#auditBody');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">加载中...</td></tr>';
  const params = new URLSearchParams();
  params.set('currentPage', auditState.currentPage);
  params.set('pageSize', auditState.pageSize);
  const action = $('#auditFilterAction')?.value;
  const storeId = $('#auditFilterStore')?.value.trim();
  if (action) params.set('action', action);
  if (storeId) params.set('storeId', storeId);
  try {
    const r = await api('/admin/api/audit-logs?' + params.toString());
    const d = r.data || r;
    auditState.total = d.total || 0;
    renderAudit(d.items || []);
    renderAuditPager();
  } catch (e) {
    body.innerHTML =
      '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">加载失败: ' +
      escapeHtml(String(e.message || e)) +
      '</td></tr>';
  }
}

function renderAudit(items) {
  const body = $('#auditBody');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">暂无数据</td></tr>';
    return;
  }
  body.innerHTML = items
    .map((it) => {
      const label = AUDIT_ACTION_LABEL[it.action] || it.action;
      const detailStr = it.detail ? JSON.stringify(it.detail) : '-';
      const detailDisplay =
        detailStr.length > 80
          ? '<span class="audit-detail" title="' +
            escapeHtml(detailStr) +
            '">' +
            escapeHtml(detailStr.slice(0, 80)) +
            '...</span>'
          : escapeHtml(detailStr);
      return (
        '<tr>' +
        '<td class="col-time">' +
        escapeHtml(it.createdAt || '') +
        '</td>' +
        '<td>' +
        escapeHtml(label) +
        '</td>' +
        '<td>' +
        escapeHtml(it.target || '-') +
        '</td>' +
        '<td>' +
        escapeHtml(it.storeId || '-') +
        '</td>' +
        '<td>' +
        escapeHtml(it.operator || '-') +
        '</td>' +
        '<td class="audit-detail-cell">' +
        detailDisplay +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
}

function renderAuditPager() {
  const pager = $('#auditPager');
  const pages = Math.ceil(auditState.total / auditState.pageSize) || 1;
  pager.innerHTML =
    `<span class="pager-info">共 ${auditState.total} 条 / ${pages} 页</span>` +
    (auditState.currentPage > 1
      ? `<button class="btn btn-sm" data-audit-page="${auditState.currentPage - 1}">上一页</button>`
      : '') +
    (auditState.currentPage < pages
      ? `<button class="btn btn-sm" data-audit-page="${auditState.currentPage + 1}">下一页</button>`
      : '');
}

document.addEventListener('click', (e) => {
  const page = e.target.getAttribute?.('data-audit-page');
  if (page) {
    auditState.currentPage = parseInt(page, 10) || 1;
    loadAudit();
  }
});
$('#auditSearchBtn')?.addEventListener('click', () => {
  auditState.currentPage = 1;
  loadAudit();
});
$('#auditRefreshBtn')?.addEventListener('click', loadAudit);

// ── 上架记录 ────────────────────────────────────────────────
let listingsState = { currentPage: 1, pageSize: 20, total: 0 };

async function loadListings() {
  const body = $('#listingsBody');
  const pager = $('#listingsPager');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="8" class="muted" style="padding:24px;text-align:center">加载中...</td></tr>';
  pager.innerHTML = '';
  const params = new URLSearchParams();
  params.set('currentPage', listingsState.currentPage);
  params.set('pageSize', listingsState.pageSize);
  const storeId = $('#filterStore')?.value;
  const status = $('#filterStatus')?.value;
  const viaPortal = $('#filterViaPortal')?.value;
  const keyword = $('#filterKeyword')?.value.trim();
  if (storeId) params.set('storeId', storeId);
  if (status) params.set('status', status);
  if (viaPortal) params.set('viaPortal', viaPortal);
  if (keyword) params.set('keyword', keyword);
  try {
    const r = await api('/admin/api/listing-records?' + params.toString());
    const data = r?.data || {};
    listingsState.total = data.total || 0;
    renderListings(data.items || []);
    renderPager();
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="error-text" style="padding:16px">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderListings(items) {
  const body = $('#listingsBody');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted" style="padding:24px;text-align:center">暂无上架记录</td></tr>';
    return;
  }
  body.innerHTML = items.map(renderListingRow).join('');
  body.querySelectorAll('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', () => openListingDetail(btn.dataset.detail));
  });
  body.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteListing(btn.dataset.del));
  });
}

function renderListingRow(r) {
  const storeName = (storesCache.find((s) => s.id === r.storeId) || {}).name || r.storeId;
  const s = r.summary || { imported: 0, failed: 0, pending: 0, skipped: 0 };
  const resultText = `✓${s.imported} ✗${s.failed} ⏳${s.pending + s.skipped}`;
  const badge = statusBadge(r.status);
  const time = (r.completedAt || r.createdAt || '').replace('T', ' ').slice(0, 19);
  return `
    <tr>
      <td class="col-time">${escapeHtml(time)}</td>
      <td class="col-task" title="${escapeHtml(r.localTaskId)}">${escapeHtml(r.localTaskId.slice(0, 20))}${r.localTaskId.length > 20 ? '…' : ''}</td>
      <td class="col-store">${escapeHtml(storeName)}</td>
      <td>${r.viaPortal ? '<span class="badge badge-pending">模拟手动</span>' : '<span class="badge badge-ok">API</span>'}</td>
      <td>${r.itemsCount}</td>
      <td class="col-result">${escapeHtml(resultText)}</td>
      <td>${badge}</td>
      <td class="col-actions">
        <button class="btn btn-sm btn-ghost" data-detail="${escapeHtml(r.localTaskId)}">详情</button>
        <button class="btn btn-sm btn-danger" data-del="${escapeHtml(r.localTaskId)}">删除</button>
      </td>
    </tr>`;
}

function statusBadge(st) {
  const map = {
    SUCCESS: ['badge-success', '成功'],
    FAILED: ['badge-failed', '失败'],
    PROCESSING: ['badge-processing', '处理中'],
    PENDING: ['badge-pending', '待处理'],
  };
  const [cls, label] = map[st] || ['badge-pending', st || '—'];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function renderPager() {
  const pager = $('#listingsPager');
  const totalPages = Math.max(1, Math.ceil(listingsState.total / listingsState.pageSize));
  const cur = listingsState.currentPage;
  let html = `<span class="pager-info">共 ${listingsState.total} 条 / 第 ${cur}/${totalPages} 页</span>`;
  html += `<button ${cur <= 1 ? 'disabled' : ''} data-page="${cur - 1}">上一页</button>`;
  html += `<button ${cur >= totalPages ? 'disabled' : ''} data-page="${cur + 1}">下一页</button>`;
  pager.innerHTML = html;
  pager.querySelectorAll('button[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      listingsState.currentPage = Number(btn.dataset.page);
      loadListings();
    });
  });
}

$('#searchListingsBtn')?.addEventListener('click', () => {
  listingsState.currentPage = 1;
  loadListings();
});
$('#refreshListingsBtn')?.addEventListener('click', () => loadListings());
$('#filterKeyword')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    listingsState.currentPage = 1;
    loadListings();
  }
});

// ── 上架记录详情 ────────────────────────────────────────────
async function openListingDetail(localTaskId) {
  $('#listingDetailModal').hidden = false;
  $('#listingDetailMeta').innerHTML = '<p class="muted">加载中...</p>';
  $('#listingDetailItems').innerHTML =
    '<tr><td colspan="7" class="muted" style="padding:16px;text-align:center">加载中...</td></tr>';
  try {
    const r = await api('/admin/api/listing-records/' + encodeURIComponent(localTaskId));
    const data = r?.data || {};
    const t = data.task || {};
    listingDetailState.task = t;
    listingDetailState.items = data.items || [];
    const storeName = (storesCache.find((s) => s.id === t.storeId) || {}).name || t.storeId;
    const metaRows = [
      ['任务 ID', t.localTaskId],
      ['店铺', storeName],
      ['上架方式', t.viaPortal ? '模拟手动 (viaPortal)' : 'API 上架 (OPI)'],
      ['Ozon Task ID', t.ozonTaskId || '—'],
      ['Bundle IDs', t.bundleIds ? t.bundleIds.join(', ') : '—'],
      ['任务状态', statusBadge(t.status).replace('<span', '<span style="pointer-events:none"')],
      ['商品总数', t.itemsCount],
      ['创建时间', (t.createdAt || '').replace('T', ' ').slice(0, 19)],
      ['完成时间', t.completedAt ? (t.completedAt + '').replace('T', ' ').slice(0, 19) : '—'],
    ];
    if (t.errorMessage) metaRows.push(['错误信息', t.errorMessage]);
    if (t.strictSkipped && t.strictSkipped.length) metaRows.push(['严格模式跳过', t.strictSkipped.length + ' 个']);
    if (t.invalidImage && t.invalidImage.length) metaRows.push(['无效图片剔除', t.invalidImage.length + ' 个']);
    $('#listingDetailMeta').innerHTML = metaRows
      .map(
        ([k, v]) =>
          `<div class="meta-row"><span class="meta-k">${escapeHtml(k)}</span><span class="meta-v">${v}</span></div>`
      )
      .join('');
    renderListingDetailItems(listingDetailState.items);
  } catch (err) {
    $('#listingDetailMeta').innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
  }
}

// 上架详情当前任务/明细缓存(供重试按钮读取 storeId/原数据)
const listingDetailState = { task: null, items: [] };

function renderListingDetailItems(items) {
  const body = $('#listingDetailItems');
  if (!items.length) {
    body.innerHTML =
      '<tr><td colspan="7" class="muted" style="padding:16px;text-align:center">无明细数据(可能任务尚未完成或未上报)</td></tr>';
    return;
  }
  const statusLabel = { imported: '已创建', failed: '失败', pending: '处理中', skipped: '跳过' };
  body.innerHTML = items
    .map((it, idx) => {
      const st = String(it.status || 'pending');
      const label = statusLabel[st] || st;
      const errText = (it.errors || [])
        .map(
          (e) =>
            `${e.message || e.description || e.code || ''}${e.field ? ` [${e.field}]` : ''}${e.attribute_name ? ` (${e.attribute_name})` : ''}`
        )
        .filter(Boolean)
        .join('; ');
      const retryBtn =
        st === 'failed' && it.offerId
          ? `<button class="btn btn-ghost btn-sm" data-retry-idx="${idx}">重试</button>`
          : '';
      return `
      <tr>
        <td class="col-task">${escapeHtml(it.offerId || '—')}</td>
        <td>${escapeHtml(it.name || '—')}</td>
        <td>${escapeHtml(it.price || '—')}</td>
        <td class="col-task">${escapeHtml(it.productId || '—')}</td>
        <td><span class="item-status ${escapeHtml(st)}">${escapeHtml(label)}</span></td>
        <td>${errText ? escapeHtml(errText) : '<span style="color:#52c41a">无错误</span>'}</td>
        <td>${retryBtn}</td>
      </tr>`;
    })
    .join('');
}

// 重试单条 failed item:复用 POST /ozon/products/import 重新提交
async function retryListingItem(idx) {
  const t = listingDetailState.task;
  const it = listingDetailState.items[idx];
  if (!t || !it || !it.offerId) {
    toast('无法重试:缺少任务或商品数据', 'error');
    return;
  }
  if (!confirm(`确认重试上架 offer_id=${it.offerId} ?将调用 Ozon API 重新提交单条。`)) return;
  try {
    const r = await api('/ozon/products/import', {
      method: 'POST',
      headers: { 'x-ozon-store-id': t.storeId },
      body: {
        items: [
          {
            offer_id: it.offerId,
            name: it.name,
            price: it.price,
          },
        ],
      },
    });
    const newLocal = r?.result?.local_task_id || r?.result?.task_id;
    toast(newLocal ? `已重新提交,新任务 ${newLocal}` : '已重新提交', 'success');
    // 刷新当前详情
    await openListingDetail(t.localTaskId);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// 上架详情重试按钮事件委托
document.addEventListener('click', (e) => {
  const idx = e.target.getAttribute?.('data-retry-idx');
  if (idx != null && idx !== '') {
    retryListingItem(parseInt(idx, 10));
  }
});

async function deleteListing(localTaskId) {
  if (!confirm(`确认删除上架记录「${localTaskId}」?此操作不可恢复。`)) return;
  try {
    await api('/admin/api/listing-records/' + encodeURIComponent(localTaskId), { method: 'DELETE' });
    toast('已删除', 'success');
    await loadListings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── 采集箱 ──────────────────────────────────────────────────
let collectBoxState = { currentPage: 1, pageSize: 20, total: 0 };

async function loadCollectBox() {
  const list = $('#collectBoxList');
  const pager = $('#cbPager');
  if (!list) return;
  list.innerHTML = '<p class="muted" style="padding:24px;text-align:center">加载中...</p>';
  pager.innerHTML = '';
  const params = new URLSearchParams();
  params.set('currentPage', collectBoxState.currentPage);
  params.set('pageSize', collectBoxState.pageSize);
  const storeId = $('#cbFilterStore')?.value;
  const published = $('#cbFilterPublished')?.value;
  const keyword = $('#cbFilterKeyword')?.value.trim();
  if (storeId) params.set('storeId', storeId);
  if (published) params.set('published', published);
  if (keyword) params.set('keyword', keyword);
  try {
    const r = await api('/admin/api/collect-box?' + params.toString());
    const data = r?.data || {};
    collectBoxState.total = data.total || 0;
    collectBoxState._current = data.items || [];
    renderCollectBox(collectBoxState._current);
    renderCbPager();
  } catch (err) {
    list.innerHTML = `<p class="error-text" style="padding:16px">${escapeHtml(err.message)}</p>`;
  }
}

// 从 product JSON 中容错提取展示字段(插件不同版本字段名可能不同)
function extractProductDisplay(p) {
  const obj = p || {};
  const title = obj.title || obj.name || obj.productName || '';
  const sku = obj.sku || obj.id || '';
  const image =
    obj.image ||
    obj.mainImage ||
    obj.primary_image ||
    (Array.isArray(obj.images) ? obj.images[0] : '') ||
    (Array.isArray(obj.imageUrls) ? obj.imageUrls[0] : '') ||
    '';
  const price = obj.price || obj.marketing_price || '';
  const url = obj.url || obj.link || obj.source_url || '';
  return { title, sku, image, price, url };
}

function renderCollectBox(items) {
  const list = $('#collectBoxList');
  if (!items.length) {
    list.innerHTML = '<div class="empty" style="grid-column:1/-1">暂无采集记录</div>';
    return;
  }
  list.innerHTML = items.map(renderCollectCard).join('');
  list.querySelectorAll('[data-cb-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteCollectBox(Number(btn.dataset.cbDel)));
  });
  list.querySelectorAll('[data-cb-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleCollectBoxPublished(Number(btn.dataset.cbToggle)));
  });
}

function renderCollectCard(it) {
  const p = extractProductDisplay(it.product);
  const storeName = (storesCache.find((s) => s.id === it.storeId) || {}).name || it.storeId || '—';
  const time = (it.createdAt || '').replace('T', ' ').slice(0, 19);
  const imgHtml = p.image
    ? `<img src="${escapeHtml(p.image)}" alt="" loading="lazy" onerror="this.style.display='none'"/>`
    : '<div class="cb-no-img">无图</div>';
  const pubBadge = it.published
    ? '<span class="badge badge-success">已发布</span>'
    : '<span class="badge badge-pending">未发布</span>';
  return `
    <div class="cb-card">
      <div class="cb-thumb">${imgHtml}</div>
      <div class="cb-body">
        <div class="cb-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title || '(未命名)')}</div>
        <div class="cb-meta">
          <span>SKU: ${escapeHtml(p.sku || '—')}</span>
          ${p.price ? `<span>价格: ${escapeHtml(String(p.price))}</span>` : ''}
          <span>店铺: ${escapeHtml(storeName)}</span>
        </div>
        <div class="cb-foot">
          <span class="cb-time">${escapeHtml(time)}</span>
          ${pubBadge}
        </div>
      </div>
      <div class="cb-actions">
        ${p.url ? `<a class="btn btn-sm btn-ghost" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">查看源</a>` : ''}
        <button class="btn btn-sm btn-ghost" data-cb-toggle="${it.id}">${it.published ? '标为未发布' : '标为已发布'}</button>
        <button class="btn btn-sm btn-danger" data-cb-del="${it.id}">删除</button>
      </div>
    </div>`;
}

function renderCbPager() {
  const pager = $('#cbPager');
  const totalPages = Math.max(1, Math.ceil(collectBoxState.total / collectBoxState.pageSize));
  const cur = collectBoxState.currentPage;
  let html = `<span class="pager-info">共 ${collectBoxState.total} 条 / 第 ${cur}/${totalPages} 页</span>`;
  html += `<button ${cur <= 1 ? 'disabled' : ''} data-page="${cur - 1}">上一页</button>`;
  html += `<button ${cur >= totalPages ? 'disabled' : ''} data-page="${cur + 1}">下一页</button>`;
  pager.innerHTML = html;
  pager.querySelectorAll('button[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      collectBoxState.currentPage = Number(btn.dataset.page);
      loadCollectBox();
    });
  });
}

async function deleteCollectBox(id) {
  if (!confirm(`确认删除采集箱条目 #${id}?`)) return;
  try {
    await api('/admin/api/collect-box/' + id, { method: 'DELETE' });
    toast('已删除', 'success');
    await loadCollectBox();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function toggleCollectBoxPublished(id) {
  try {
    const row = collectBoxState._current?.find((x) => x.id === id);
    const newPub = row ? !row.published : true;
    await api('/admin/api/collect-box/' + id, { method: 'PATCH', body: { published: newPub } });
    toast(newPub ? '已标为已发布' : '已标为未发布', 'success');
    await loadCollectBox();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#cbSearchBtn')?.addEventListener('click', () => {
  collectBoxState.currentPage = 1;
  loadCollectBox();
});
$('#cbRefreshBtn')?.addEventListener('click', () => loadCollectBox());
$('#cbFilterKeyword')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    collectBoxState.currentPage = 1;
    loadCollectBox();
  }
});

// ── 商品列表 ────────────────────────────────────────────────
let productsState = { currentPage: 1, pageSize: 20, total: 0 };

async function loadProducts() {
  const body = $('#productsBody');
  const pager = $('#prodPager');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">加载中...</td></tr>';
  pager.innerHTML = '';
  const params = new URLSearchParams();
  params.set('currentPage', productsState.currentPage);
  params.set('pageSize', productsState.pageSize);
  const keyword = $('#prodFilterKeyword')?.value.trim();
  if (keyword) params.set('keyword', keyword);
  const storeId = $('#prodFilterStore')?.value;
  if (storeId) params.set('storeId', storeId);
  try {
    const r = await api('/admin/api/products?' + params.toString());
    const data = r?.data || {};
    productsState.total = data.total || 0;
    renderProducts(data.items || []);
    renderProdPager();
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="error-text" style="padding:16px">${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderProducts(items) {
  const body = $('#productsBody');
  if (!items.length) {
    body.innerHTML =
      '<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">暂无商品数据(插件查询过的商品会自动缓存到这里)</td></tr>';
    return;
  }
  body.innerHTML = items
    .map((it) => {
      const time = (it.fetchedAt || '').replace('T', ' ').slice(0, 19);
      const imgHtml = it.image
        ? `<img src="${escapeHtml(it.image)}" alt="" loading="lazy" style="width:40px;height:40px;object-fit:cover;border-radius:4px" onerror="this.style.display='none'"/>`
        : '<span class="muted">—</span>';
      const priceText = it.price ? `${escapeHtml(String(it.price))} ${escapeHtml(it.currency || '')}`.trim() : '—';
      return `
      <tr>
        <td class="col-task">${escapeHtml(it.sku)}</td>
        <td>${imgHtml}</td>
        <td class="col-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name || '—')}</td>
        <td>${escapeHtml(priceText)}</td>
        <td class="col-task">${escapeHtml(it.productId || '—')}</td>
        <td class="col-time">${escapeHtml(time)}</td>
        <td><button class="btn btn-sm btn-ghost" data-prod-detail="${escapeHtml(it.sku)}">详情</button></td>
      </tr>`;
    })
    .join('');
  body.querySelectorAll('[data-prod-detail]').forEach((btn) => {
    btn.addEventListener('click', () => openProductDetail(btn.dataset.prodDetail));
  });
}

function renderProdPager() {
  const pager = $('#prodPager');
  const totalPages = Math.max(1, Math.ceil(productsState.total / productsState.pageSize));
  const cur = productsState.currentPage;
  let html = `<span class="pager-info">共 ${productsState.total} 条 / 第 ${cur}/${totalPages} 页</span>`;
  html += `<button ${cur <= 1 ? 'disabled' : ''} data-page="${cur - 1}">上一页</button>`;
  html += `<button ${cur >= totalPages ? 'disabled' : ''} data-page="${cur + 1}">下一页</button>`;
  pager.innerHTML = html;
  pager.querySelectorAll('button[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      productsState.currentPage = Number(btn.dataset.page);
      loadProducts();
    });
  });
}

async function openProductDetail(sku) {
  const modal = $('#productDetailModal');
  modal.hidden = false;
  $('#prodDetailSku').textContent = '· ' + sku;
  $('#prodDetailMeta').innerHTML = '<p class="muted">加载中...</p>';
  $('#prodDetailJson').textContent = '加载中...';
  // 重置子 Tab 状态:默认 basic active,attributes/description panel 隐藏并标记未加载
  modal.dataset.sku = sku;
  modal.dataset.attrLoaded = '0';
  modal.dataset.descLoaded = '0';
  modal.querySelectorAll('.sub-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.subtab === 'basic');
  });
  $('#prodDetailBasic').classList.add('active');
  $('#prodDetailAttr').classList.remove('active');
  $('#prodDetailDesc').classList.remove('active');
  $('#prodDetailAttrJson').textContent = '点击上方"商品特征描述"加载...';
  $('#prodDetailDescJson').textContent = '点击上方"商品详情信息"加载...';
  // 填充店铺下拉:优先选商品所属店铺,无则选第一个
  const detailStoreSel = $('#prodDetailStore');
  if (detailStoreSel) {
    detailStoreSel.innerHTML = storesCache
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join('');
  }
  try {
    const r = await api('/admin/api/products/' + encodeURIComponent(sku));
    const data = r?.data || {};
    // 缓存商品所属店铺,子 Tab 拉特征/描述时优先用此 storeId
    modal.dataset.storeId = data.storeId || '';
    if (detailStoreSel) {
      const preferred = data.storeId || storesCache[0]?.id || '';
      if (preferred) detailStoreSel.value = preferred;
    }
    const metaRows = [
      ['SKU', data.sku],
      ['采集时间', (data.fetchedAt || '').replace('T', ' ').slice(0, 19)],
    ];
    $('#prodDetailMeta').innerHTML = metaRows
      .map(
        ([k, v]) =>
          `<div class="meta-row"><span class="meta-k">${escapeHtml(k)}</span><span class="meta-v">${escapeHtml(String(v ?? '—'))}</span></div>`
      )
      .join('');
    $('#prodDetailJson').textContent = JSON.stringify(data.data || {}, null, 2);
  } catch (err) {
    $('#prodDetailMeta').innerHTML = `<p class="error-text">${escapeHtml(err.message)}</p>`;
    $('#prodDetailJson').textContent = '';
  }
}

// 商品详情弹窗:子 Tab 按需加载(全局事件委托,只绑一次;状态通过 modal.dataset 持有)
$('#productDetailModal')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.sub-tab');
  if (!btn || !btn.dataset.subtab) return;
  const modal = $('#productDetailModal');
  const subtab = btn.dataset.subtab;
  // 切换 active 类
  modal.querySelectorAll('.sub-tab').forEach((b) => {
    b.classList.toggle('active', b === btn);
  });
  // 切换 panel 显隐(用 active 类,与 CSS .sub-panel.active { display: block } 配合)
  $('#prodDetailBasic').classList.toggle('active', subtab === 'basic');
  $('#prodDetailAttr').classList.toggle('active', subtab === 'attributes');
  $('#prodDetailDesc').classList.toggle('active', subtab === 'description');
  // basic 数据已在 openProductDetail 中渲染,无需远程拉取
  if (subtab === 'basic') return;
  const sku = modal.dataset.sku;
  if (!sku) return;
  const isAttr = subtab === 'attributes';
  const loadedFlag = isAttr ? 'attrLoaded' : 'descLoaded';
  const targetEl = isAttr ? $('#prodDetailAttrJson') : $('#prodDetailDescJson');
  // 已加载过则跳过(避免重复请求)
  if (modal.dataset[loadedFlag] === '1') return;
  // storeId 优先级:弹窗内店铺下拉 > 商品所属店铺(DB) > storesCache[0]
  const storeId =
    $('#prodDetailStore')?.value || modal.dataset.storeId || $('#prodFilterStore')?.value || storesCache[0]?.id;
  if (!storeId) {
    targetEl.textContent = '需要先配置店铺才能拉取特征描述/详情信息';
    return;
  }
  targetEl.textContent = '加载中...';
  try {
    const r = await api(
      '/admin/api/products/' + encodeURIComponent(sku) + '/attributes?storeId=' + encodeURIComponent(storeId)
    );
    const payload = r?.data || {};
    const content = isAttr ? payload.attributes : payload.description;
    targetEl.textContent = JSON.stringify(content ?? {}, null, 2);
    modal.dataset[loadedFlag] = '1';
  } catch (err) {
    targetEl.textContent = '加载失败:' + err.message;
  }
});

// 弹窗内切换店铺时,重置已加载状态(下次切子 Tab 会用新 storeId 重拉)
$('#prodDetailStore')?.addEventListener('change', () => {
  const modal = $('#productDetailModal');
  if (!modal) return;
  modal.dataset.attrLoaded = '0';
  modal.dataset.descLoaded = '0';
  $('#prodDetailAttrJson').textContent = '点击上方"商品特征描述"加载...';
  $('#prodDetailDescJson').textContent = '点击上方"商品详情信息"加载...';
});

async function syncProducts() {
  const btn = $('#prodSyncBtn');
  if (!btn) return;
  let storeId = $('#prodFilterStore')?.value;
  if (!storeId) storeId = storesCache[0]?.id;
  if (!storeId) {
    toast('请先在店铺管理中添加店铺', 'error');
    return;
  }
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '同步中...';
  try {
    const r = await api('/admin/api/products/sync?storeId=' + encodeURIComponent(storeId), { method: 'POST' });
    const d = r?.data || {};
    toast(`同步完成: ${d.synced || 0} 个商品(总计 ${d.total || 0}),耗时 ${(d.durationMs || 0) / 1000}s`, 'success');
    productsState.currentPage = 1;
    await loadProducts();
  } catch (err) {
    toast('同步失败: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}
$('#prodSyncBtn')?.addEventListener('click', syncProducts);

$('#prodSearchBtn')?.addEventListener('click', () => {
  productsState.currentPage = 1;
  loadProducts();
});
$('#prodRefreshBtn')?.addEventListener('click', () => loadProducts());
$('#prodFilterKeyword')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    productsState.currentPage = 1;
    loadProducts();
  }
});

// ── 配置中心 ────────────────────────────────────────────────
// 配置项元信息:声明每个 key 的展示方式(类型/分组/标签/单位/帮助文案)
// 未在此表中的 key 不渲染(隐藏在 _raw 里),便于扩展新配置而不破坏 UI
const CONFIG_META = {
  // extension scope
  price_max: { scope: 'extension', group: '价格配置', label: '售价上限', type: 'number', unit: '卢布' },
  old_price_ratio: {
    scope: 'extension',
    group: '价格配置',
    label: '默认划线价比例',
    type: 'number',
    step: '0.01',
    help: '划线价 = 售价 × 此比例',
  },
  discount_threshold: {
    scope: 'extension',
    group: '价格配置',
    label: '折扣阈值',
    type: 'number',
    step: '0.01',
    help: '售价 / 划线价 不得低于此值,否则 Ozon 审核失败',
  },
  stock_max: { scope: 'extension', group: '库存配置', label: '库存上限', type: 'number' },
  default_stock: { scope: 'extension', group: '库存配置', label: '默认库存', type: 'number' },
  enable_video_transfer: { scope: 'extension', group: '功能开关', label: '视频转存', type: 'boolean' },
  enable_ai_rewrite: { scope: 'extension', group: '功能开关', label: 'AI 标题改写', type: 'boolean' },
  enable_watermark: { scope: 'extension', group: '功能开关', label: '水印渲染', type: 'boolean' },
  // pricing scope
  rate_rub: { scope: 'pricing', group: '定价配置', label: '人民币兑卢布汇率', type: 'number', step: '0.001' },
  commission_rates: { scope: 'pricing', group: '定价配置', label: '类目佣金率 (JSON)', type: 'json' },
  logistics_cost: { scope: 'pricing', group: '定价配置', label: '物流费表 (JSON)', type: 'json' },
  profit_logistics: { scope: 'pricing', group: '定价配置', label: '利润物流系数 (JSON)', type: 'json' },
};

let configState = { items: [], dirty: new Set() };

async function loadConfig() {
  const form = $('#configForm');
  if (!form) return;
  form.innerHTML = '<p class="muted" style="padding:24px;text-align:center">加载中...</p>';
  try {
    const r = await api('/app-config');
    const data = r?.data || {};
    configState.items = data.items || [];
    configState.dirty = new Set();
    renderConfigForm(configState.items);
  } catch (err) {
    form.innerHTML = `<p class="error-text" style="padding:16px">${escapeHtml(err.message)}</p>`;
  }
}

function renderConfigForm(items) {
  const form = $('#configForm');
  // 按 group 分组
  const groups = {};
  for (const it of items) {
    const meta = CONFIG_META[it.key];
    if (!meta) continue; // 未声明元信息的 key 不渲染
    if (!groups[meta.group]) groups[meta.group] = [];
    groups[meta.group].push({ ...it, meta });
  }

  let html = '';
  for (const [groupName, cfgs] of Object.entries(groups)) {
    html += `<div class="cfg-group"><h3>${escapeHtml(groupName)}</h3><div class="cfg-fields">`;
    for (const c of cfgs) {
      html += renderConfigField(c);
    }
    html += '</div></div>';
  }
  form.innerHTML = html;

  // 绑定变更事件,标记 dirty
  form.querySelectorAll('[data-cfg-key]').forEach((el) => {
    el.addEventListener('change', () => {
      configState.dirty.add(el.dataset.cfgKey);
      el.classList.add('cfg-dirty');
    });
  });
}

function renderConfigField(c) {
  const { key, value, meta } = c;
  const id = 'cfg-' + key;
  const desc = c.description ? `<span class="cfg-help">${escapeHtml(c.description)}</span>` : '';
  let inputHtml;
  if (meta.type === 'boolean') {
    inputHtml = `<label class="cfg-switch"><input type="checkbox" id="${id}" data-cfg-key="${escapeHtml(key)}" ${value ? 'checked' : ''}/><span>${value ? '已启用' : '已禁用'}</span></label>`;
  } else if (meta.type === 'json') {
    inputHtml = `<textarea id="${id}" data-cfg-key="${escapeHtml(key)}" class="cfg-textarea" rows="3">${escapeHtml(JSON.stringify(value, null, 2))}</textarea>`;
  } else {
    const step = meta.step ? ` step="${meta.step}"` : '';
    const unit = meta.unit ? `<span class="cfg-unit">${escapeHtml(meta.unit)}</span>` : '';
    inputHtml = `<div class="cfg-input-wrap"><input type="${meta.type}" id="${id}" data-cfg-key="${escapeHtml(key)}" value="${escapeHtml(String(value ?? ''))}"${step}/>${unit}</div>`;
  }
  const help = meta.help ? `<span class="cfg-help">${escapeHtml(meta.help)}</span>` : desc;
  return `
    <div class="cfg-field">
      <label for="${id}" class="cfg-label">${escapeHtml(meta.label)} <code class="cfg-key">${escapeHtml(key)}</code></label>
      ${inputHtml}
      ${help ? `<div class="cfg-help-row">${help}</div>` : ''}
    </div>`;
}

async function saveConfig() {
  const dirtyKeys = Array.from(configState.dirty);
  if (dirtyKeys.length === 0) {
    toast('没有修改需要保存', '');
    return;
  }
  const items = [];
  for (const key of dirtyKeys) {
    const el = document.querySelector(`[data-cfg-key="${CSS.escape(key)}"]`);
    if (!el) continue;
    const meta = CONFIG_META[key];
    const original = configState.items.find((x) => x.key === key);
    let value;
    if (meta.type === 'boolean') {
      value = el.checked;
    } else if (meta.type === 'json') {
      try {
        value = JSON.parse(el.value);
      } catch (e) {
        toast(`${key} 不是合法 JSON: ${e.message}`, 'error');
        return;
      }
    } else if (meta.type === 'number') {
      value = Number(el.value);
      if (Number.isNaN(value)) {
        toast(`${key} 必须是数字`, 'error');
        return;
      }
    } else {
      value = el.value;
    }
    items.push({ key, value, scope: original?.scope || meta.scope });
  }
  try {
    await api('/app-config', { method: 'PUT', body: { items } });
    toast(`已保存 ${items.length} 项配置`, 'success');
    await loadConfig();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#cfgRefreshBtn')?.addEventListener('click', () => loadConfig());
$('#cfgSaveBtn')?.addEventListener('click', () => saveConfig());

// ── 启动 ────────────────────────────────────────────────────
(async function init() {
  if (getToken()) {
    // 用 /admin/api/stores 探测 token 是否仍有效
    try {
      await api('/admin/api/stores');
      showMain();
      // 支持 URL hash 深链直达(如 /admin#collect-box);无 hash 时默认加载首页统计
      const h = location.hash.replace(/^#/, '');
      if (h && document.querySelector(`.tab[data-tab="${h}"]`)) {
        switchTab(h);
      } else {
        loadDashboard();
      }
    } catch {
      showLogin();
    }
  } else {
    showLogin();
  }
})();
