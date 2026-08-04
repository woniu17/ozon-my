<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useStoresStore } from '../stores/stores.js';
import {
  createStore,
  updateStore,
  deleteStore,
  testConnection,
  testConnectionForStore,
  getStoreWarehouses,
  getStoresQuota,
} from '../api/stores.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import { useConfirmStore } from '../stores/confirm.js';

const storesStore = useStoresStore();
const { show } = useToast();
const confirmStore = useConfirmStore();

// ── 上传配额面板 ───────────────────────────────────────────
const quotaLoading = ref(false);
const quotaItems = ref([]); // [{ storeId, storeName, quota, archived, effective, error }]
const quotaLoadedAt = ref('');

async function loadQuota() {
  quotaLoading.value = true;
  try {
    const r = await getStoresQuota();
    // request 已解 envelope:r 即 { items: [...] }
    const data = r && r.items ? r : r?.data || {};
    quotaItems.value = Array.isArray(data.items) ? data.items : [];
    quotaLoadedAt.value = new Date().toLocaleTimeString();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    quotaLoading.value = false;
  }
}

// 配额卡片展示用:扁平化每店铺一行
const quotaRows = computed(() =>
  quotaItems.value.map((it) => {
    const q = it.quota || {};
    const t = q.total || {};
    const dc = q.daily_create || {};
    const du = q.daily_update || {};
    const a = it.archived || {};
    const eff = it.effective || null;
    return {
      storeId: it.storeId,
      storeName: it.storeName,
      // 账号总数(原始)
      totalUsage: t.usage ?? null,
      totalLimit: t.limit ?? null,
      totalPercent:
        typeof t.limit === 'number' && t.limit !== -1 && typeof t.usage === 'number'
          ? Number(((t.usage / t.limit) * 100).toFixed(1))
          : null,
      // 扣除归档后
      effUsage: eff?.usage ?? null,
      effLimit: eff?.limit ?? null,
      effPercent: eff?.percent ?? null,
      archived: a.ARCHIVED ?? null,
      archivedAuto: a.AUTO_ARCHIVED ?? null,
      archivedManual: a.MANUAL_ARCHIVED ?? null,
      archivedSeasonal: a.SEASONAL_AUTO_ARCHIVED ?? null,
      // 日建/日更
      dcUsage: dc.usage ?? null,
      dcLimit: dc.limit ?? null,
      dcPercent:
        typeof dc.limit === 'number' && dc.limit !== -1 && typeof dc.usage === 'number'
          ? Number(((dc.usage / dc.limit) * 100).toFixed(1))
          : null,
      dcResetAt: dc.reset_at || '',
      duUsage: du.usage ?? null,
      duLimit: du.limit ?? null,
      duPercent:
        typeof du.limit === 'number' && du.limit !== -1 && typeof du.usage === 'number'
          ? Number(((du.usage / du.limit) * 100).toFixed(1))
          : null,
      duResetAt: du.reset_at || '',
      error: it.error || null,
    };
  })
);

// 根据使用率返回颜色 class
function levelClass(percent) {
  if (percent == null) return '';
  if (percent >= 100) return 'quota-crit';
  if (percent >= 80) return 'quota-warn';
  return 'quota-ok';
}

function fmtResetAt(iso) {
  if (!iso) return '';
  // ISO UTC -> 北京时间 HH:MM
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  } catch {
    return iso;
  }
}

// ── 编辑/新增弹窗 ───────────────────────────────────────────
const editOpen = ref(false);
const editSaving = ref(false);
const testingInForm = ref(false);
const editErr = ref('');
const editForm = reactive({
  id: '',
  name: '',
  warehouse_id: '',
  currency_code: 'CNY',
  link: '',
  clientId: '',
  apiKey: '',
});

function resetEditForm() {
  editForm.id = '';
  editForm.name = '';
  editForm.warehouse_id = '';
  editForm.currency_code = 'CNY';
  editForm.link = '';
  editForm.clientId = '';
  editForm.apiKey = '';
  editErr.value = '';
}

function openEdit(store) {
  if (store) {
    editForm.id = store.id || '';
    editForm.name = store.name || '';
    editForm.warehouse_id = store.warehouse_id || '';
    editForm.currency_code = store.currency_code || 'CNY';
    editForm.link = store.link || '';
    editForm.clientId = store.sync_credentials?.clientId || '';
    editForm.apiKey = store.sync_credentials?.apiKey || '';
  } else {
    resetEditForm();
  }
  editErr.value = '';
  editOpen.value = true;
}

function readBody() {
  // company_id 与 Client-Id 同值,后端会自动同步,前端不再单独传
  return {
    name: editForm.name.trim(),
    warehouse_id: editForm.warehouse_id.trim(),
    currency_code: editForm.currency_code,
    link: editForm.link.trim(),
    sync_credentials: {
      clientId: editForm.clientId.trim(),
      apiKey: editForm.apiKey.trim(),
    },
  };
}

async function submitEdit() {
  editErr.value = '';
  const body = readBody();
  if (!body.name) {
    editErr.value = '店铺名称必填';
    return;
  }
  editSaving.value = true;
  try {
    if (editForm.id) {
      await updateStore(editForm.id, body);
      show('店铺已更新', 'success');
    } else {
      await createStore(body);
      show('店铺已新增', 'success');
    }
    editOpen.value = false;
    await storesStore.load(true);
  } catch (err) {
    editErr.value = err.message || String(err);
  } finally {
    editSaving.value = false;
  }
}

// 用表单内填写的凭据测试连接(无需先保存)
async function testConnInForm() {
  editErr.value = '';
  const body = readBody();
  if (!body.sync_credentials.clientId || !body.sync_credentials.apiKey) {
    editErr.value = '请先填写 Client-Id 与 Api-Key';
    return;
  }
  testingInForm.value = true;
  try {
    const r = await testConnection({ sync_credentials: body.sync_credentials });
    // request() 已解 envelope:r 即 { success, warehouses, error }
    const result = r || {};
    if (result.success) {
      const n = (result.warehouses || []).length;
      show(`连接成功,共 ${n} 个仓库`, 'success');
      // 若未填默认仓库且仅有一个仓库,自动回填
      if (!editForm.warehouse_id && n === 1) {
        editForm.warehouse_id = result.warehouses[0].id || '';
      }
    } else {
      editErr.value = '连接失败:' + (result.error || '未知错误');
    }
  } catch (err) {
    editErr.value = err.message || String(err);
  } finally {
    testingInForm.value = false;
  }
}

// ── 卡片操作:测试连接 / 删除 ───────────────────────────────
const testingStoreId = ref('');

async function testConnForStore(store) {
  show(`正在测试「${store.name}」连接...`);
  testingStoreId.value = store.id;
  try {
    const r = await testConnectionForStore(store.id);
    // request() 已解 envelope:r 即 { success, warehouses, error }
    const result = r || {};
    if (result.success) {
      const n = (result.warehouses || []).length;
      show(`「${store.name}」连接成功,共 ${n} 个仓库`, 'success');
      // 后端已把 credentials_verified 持久化为 true,刷新店铺列表以更新 badge
      await storesStore.load(true);
    } else {
      show(`「${store.name}」连接失败:` + (result.error || '未知错误'), 'error');
    }
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    testingStoreId.value = '';
  }
}

async function removeStore(store) {
  if (!(await confirmStore.ask({ message: `确认删除店铺「${store.name}」?此操作不可恢复。`, danger: true }))) return;
  try {
    await deleteStore(store.id);
    show('已删除', 'success');
    await storesStore.load(true);
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 仓库列表弹窗 ───────────────────────────────────────────
const whOpen = ref(false);
const whStore = ref(null);
const whLoading = ref(false);
const whStatus = ref('');
const whItems = ref([]);
const whError = ref('');

async function openWarehouse(store) {
  whStore.value = store;
  whOpen.value = true;
  whStatus.value = '';
  whItems.value = [];
  whError.value = '';
  await fetchWarehouses();
}

async function fetchWarehouses() {
  if (!whStore.value) return;
  whLoading.value = true;
  whStatus.value = '正在从 Ozon 实时拉取...';
  whItems.value = [];
  whError.value = '';
  try {
    const r = await getStoreWarehouses(whStore.value.id);
    // request() 已解 envelope:r 即 { success, warehouses, error }
    const result = r || {};
    if (result.success) {
      const items = result.warehouses || [];
      whStatus.value = `共 ${items.length} 个仓库(实时拉取)`;
      whItems.value = items.map((w) => ({
        id: w.warehouse_id ?? w.id ?? '',
        name: w.name || '(未命名)',
        meta: [w.warehouse_type || null, w.status || null, w.is_rfbs ? 'RFBS' : null].filter(Boolean).join(' · '),
      }));
      if (!items.length) {
        whError.value = 'OPI 未返回任何仓库,请确认店铺凭据与仓库已开通';
      }
    } else {
      whStatus.value = '连接失败';
      whError.value = result.error || '未知错误';
    }
  } catch (err) {
    whStatus.value = '请求失败';
    whError.value = err.message || String(err);
  } finally {
    whLoading.value = false;
  }
}

// 把仓库设为默认仓库
async function setDefaultWarehouse(wid) {
  const store = whStore.value;
  if (!store) return;
  try {
    await updateStore(store.id, {
      name: store.name,
      warehouse_id: wid,
      currency_code: store.currency_code,
      link: store.link,
      sync_credentials: store.sync_credentials,
    });
    show('已设为默认仓库', 'success');
    whOpen.value = false;
    await storesStore.load(true);
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

onMounted(() => {
  storesStore.load();
  loadQuota();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>店铺管理</h2>
      <button class="btn btn-primary" @click="openEdit(null)">+ 新增店铺</button>
    </div>

    <!-- 上传配额面板 -->
    <div class="quota-panel">
      <div class="quota-head">
        <h3>上传配额</h3>
        <div class="quota-head-right">
          <span v-if="quotaLoadedAt" class="muted">更新于 {{ quotaLoadedAt }}</span>
          <button class="btn btn-sm" :disabled="quotaLoading" @click="loadQuota">
            {{ quotaLoading ? '刷新中…' : '刷新' }}
          </button>
        </div>
      </div>
      <div v-if="quotaLoading && !quotaRows.length" class="empty">加载中…(实时调用 OPI,约 2-5 秒)</div>
      <div v-else-if="!quotaRows.length" class="empty">暂无配额数据,点击右上角刷新</div>
      <div v-else class="quota-grid">
        <div v-for="r in quotaRows" :key="r.storeId" class="quota-card">
          <div class="quota-card-head">
            <span class="quota-store-name">{{ r.storeName }}</span>
            <span v-if="r.error" class="badge badge-fail" :title="r.error">异常</span>
          </div>
          <!-- 账号总数(扣除归档) -->
          <div class="quota-row">
            <div class="quota-row-label">
              账号总数
              <span class="quota-row-hint" v-if="r.archived != null">(扣除归档 {{ r.archived }})</span>
            </div>
            <div class="quota-row-value">
              <strong :class="levelClass(r.effPercent ?? r.totalPercent)">
                {{ r.effUsage ?? r.totalUsage ?? '-' }}
              </strong>
              <span class="muted"> / {{ r.effLimit ?? r.totalLimit ?? '-' }}</span>
              <span
                v-if="r.effPercent != null"
                class="quota-pct"
                :class="levelClass(r.effPercent)"
              >{{ r.effPercent }}%</span>
              <span v-else-if="r.totalPercent != null" class="quota-pct" :class="levelClass(r.totalPercent)">
                {{ r.totalPercent }}%(含归档)
              </span>
              <span v-else-if="r.totalLimit === -1" class="quota-pct quota-ok">无限制</span>
            </div>
          </div>
          <!-- 日建 -->
          <div class="quota-row">
            <div class="quota-row-label">
              日建
              <span class="quota-row-hint" v-if="r.dcResetAt">重置 {{ fmtResetAt(r.dcResetAt) }}</span>
            </div>
            <div class="quota-row-value">
              <strong :class="levelClass(r.dcPercent)">{{ r.dcUsage ?? '-' }}</strong>
              <span class="muted"> / {{ r.dcLimit ?? '-' }}</span>
              <span v-if="r.dcPercent != null" class="quota-pct" :class="levelClass(r.dcPercent)">{{ r.dcPercent }}%</span>
              <span v-else-if="r.dcLimit === -1" class="quota-pct quota-ok">无限制</span>
            </div>
          </div>
          <!-- 日更 -->
          <div class="quota-row">
            <div class="quota-row-label">
              日更
              <span class="quota-row-hint" v-if="r.duResetAt">重置 {{ fmtResetAt(r.duResetAt) }}</span>
            </div>
            <div class="quota-row-value">
              <strong :class="levelClass(r.duPercent)">{{ r.duUsage ?? '-' }}</strong>
              <span class="muted"> / {{ r.duLimit ?? '-' }}</span>
              <span v-if="r.duPercent != null" class="quota-pct" :class="levelClass(r.duPercent)">{{ r.duPercent }}%</span>
              <span v-else-if="r.duLimit === -1" class="quota-pct quota-ok">无限制</span>
            </div>
          </div>
          <!-- 归档明细 -->
          <div v-if="r.archived != null || r.archivedAuto != null" class="quota-archived">
            归档:
            <span>总 {{ r.archived ?? '-' }}</span>
            <span class="muted">·</span>
            <span>自动 {{ r.archivedAuto ?? '-' }}</span>
            <span class="muted">·</span>
            <span>手动 {{ r.archivedManual ?? '-' }}</span>
            <span v-if="r.archivedSeasonal" class="muted">· 季节 {{ r.archivedSeasonal }}</span>
          </div>
          <div v-if="r.error" class="quota-error">{{ r.error }}</div>
        </div>
      </div>
    </div>

    <div v-if="!storesStore.loaded" class="empty">加载中…</div>
    <div v-else-if="!storesStore.list.length" class="empty">暂无店铺,点击右上角「+ 新增店铺」开始配置</div>
    <div v-else class="store-list">
      <div v-for="s in storesStore.list" :key="s.id" class="store-card">
        <div class="store-card-head">
          <h3>{{ s.name }}</h3>
          <span class="store-id">{{ s.id }}</span>
        </div>
        <div class="store-fields">
          <div class="row">
            <span class="k">默认仓库</span><span class="v">{{ s.warehouse_id || '—' }}</span>
          </div>
          <div class="row">
            <span class="k">合同货币</span>
            <span class="v"
              ><strong>{{ s.currency_code || 'CNY' }}</strong></span
            >
          </div>
          <div class="row">
            <span class="k">店铺链接</span>
            <span class="v">
              <a v-if="s.link" :href="s.link" target="_blank" rel="noopener noreferrer" class="store-link">
                {{ s.link }}
              </a>
              <template v-else>—</template>
            </span>
          </div>
          <div class="row">
            <span class="k">采集 SKU 数</span>
            <span class="v"><strong>{{ s.collected_sku_count ?? 0 }}</strong></span>
          </div>
          <div class="row">
            <span class="k">Client-Id</span>
            <span class="v">{{ s.sync_credentials?.clientId || '—' }}</span>
          </div>
          <div class="row">
            <span class="k">Api-Key</span>
            <span class="v">{{ s.sync_credentials?.apiKey || '—' }}</span>
          </div>
          <div class="row">
            <span class="k">凭据状态</span>
            <span class="v">
              <span
                v-if="s.credentials_verified"
                class="badge badge-success"
                title="最近一次连接测试已通过"
                >已验证</span
              >
              <span
                v-else-if="s.sync_credentials?.clientId && s.sync_credentials?.apiKey"
                class="badge badge-pending"
                >未验证</span
              >
              <span v-else class="badge badge-fail">未配置</span>
            </span>
          </div>
        </div>
        <div class="store-card-actions">
          <button class="btn btn-sm btn-ghost" @click="openWarehouse(s)">查看仓库</button>
          <button class="btn btn-sm btn-ghost" :disabled="testingStoreId === s.id" @click="testConnForStore(s)">
            {{ testingStoreId === s.id ? '测试中…' : '测试连接' }}
          </button>
          <button class="btn btn-sm btn-ghost" @click="openEdit(s)">编辑</button>
          <button class="btn btn-sm btn-danger" @click="removeStore(s)">删除</button>
        </div>
      </div>
    </div>

    <!-- 新增/编辑弹窗 -->
    <AppModal :open="editOpen" :title="editForm.id ? '编辑店铺' : '新增店铺'" @update:open="editOpen = $event">
      <form class="form" @submit.prevent="submitEdit">
        <label>
          <span>店铺名称 <em>*</em></span>
          <input type="text" v-model.trim="editForm.name" placeholder="店铺名称…" autocomplete="off" />
        </label>
        <label>
          <span>默认仓库</span>
          <input type="text" v-model.trim="editForm.warehouse_id" placeholder="默认仓库ID…" autocomplete="off" />
        </label>
        <label>
          <span>合同货币</span>
          <select v-model="editForm.currency_code" aria-label="合同货币">
            <option value="CNY">CNY</option>
            <option value="RUB">RUB</option>
            <option value="KZT">KZT</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
          </select>
        </label>
        <label>
          <span>店铺链接</span>
          <input type="url" inputmode="url" v-model.trim="editForm.link" placeholder="https://www.ozon.ru/seller/…" autocomplete="off" />
        </label>
        <label>
          <span>Client-Id</span>
          <input type="text" v-model.trim="editForm.clientId" placeholder="OPI Client-Id…" autocomplete="off" spellcheck="false" />
        </label>
        <label>
          <span>Api-Key</span>
          <input type="text" v-model.trim="editForm.apiKey" placeholder="OPI Api-Key…" autocomplete="off" spellcheck="false" />
        </label>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" :disabled="editSaving">
            {{ editSaving ? '保存中…' : '保存' }}
          </button>
          <button type="button" class="btn btn-ghost" :disabled="testingInForm" @click="testConnInForm">
            {{ testingInForm ? '测试中…' : '测试连接' }}
          </button>
        </div>
        <p class="error-text" v-show="editErr">{{ editErr }}</p>
      </form>
    </AppModal>

    <!-- 仓库列表弹窗 -->
    <AppModal
      :open="whOpen"
      :title="'仓库列表' + (whStore ? ' · ' + whStore.name : '')"
      size="lg"
      @update:open="whOpen = $event"
    >
      <div class="form-actions" style="margin-bottom: 8px">
        <span class="muted">{{ whStatus }}</span>
        <button type="button" class="btn btn-sm btn-ghost" :disabled="whLoading || !whStore" @click="fetchWarehouses">
          刷新
        </button>
      </div>
      <div v-if="whError" class="empty error-text">{{ whError }}</div>
      <div v-else-if="!whItems.length && !whLoading" class="empty">暂无仓库</div>
      <div v-else class="warehouse-list">
        <div v-for="w in whItems" :key="w.id" class="wh-item">
          <div class="wh-info">
            <span class="wh-name">{{ w.name }}</span>
            <span class="wh-meta">ID: {{ w.id }}{{ w.meta ? ' · ' + w.meta : '' }}</span>
          </div>
          <button class="btn btn-sm btn-ghost" @click="setDefaultWarehouse(w.id)">设为默认</button>
        </div>
      </div>
    </AppModal>
  </div>
</template>
