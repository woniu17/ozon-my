<script setup>
// 货源管理(2026-11-27):维护 Ozon SKU 的平台货源商品(1688 优先)
// - 货源列表:已确认的货源(常用/备选),展示最近采购价/次数/供应商,可编辑规格/配比/备注
// - 待确认候选:由历史采购单(采购单↔Ozon SKU 关联)自动生成;多商品行订单只给候选,人工确认
// - 从历史采购回填:仅处理「单商品行 + 单 SKU」的无歧义采购单,可重复执行
import { ref, reactive, computed, onMounted } from 'vue';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import { useToast } from '../components/useToast.js';
import { useStoresStore } from '../stores/stores.js';
import {
  listSupplierProducts,
  listSupplierCandidates,
  getSupplierBySku,
  createSupplierProduct,
  updateSupplierProduct,
  deleteSupplierProduct,
  setSupplierPrimary,
  confirmSupplierCandidates,
  backfillSupplierProducts,
} from '../api/supplier-products.js';

const { show } = useToast();
const storesStore = useStoresStore();

const tab = ref('sources');
const filter = reactive({ storeId: '', platform: '', keyword: '' });
const pageSize = ref(20);

// 货源列表
const loading = ref(false);
const sources = ref([]);
const sourcesTotal = ref(0);
const sourcesPage = ref(1);

// 待确认候选(按 SKU 分组)
const candLoading = ref(false);
const candidates = ref([]);
const candidatesTotal = ref(0);
const candidatesPage = ref(1);
const selectedKeys = ref([]);

const backfilling = ref(false);

const storeOptions = computed(() => storesStore.list || []);
function storeName(id) {
  const s = storesStore.list.find((x) => x.id === id);
  return s ? s.name || s.id : id || '—';
}

function baseParams() {
  const p = { pageSize: pageSize.value };
  if (filter.storeId) p.storeId = filter.storeId;
  if (filter.platform) p.platform = filter.platform;
  if (filter.keyword.trim()) p.keyword = filter.keyword.trim();
  return p;
}

async function loadSources() {
  loading.value = true;
  try {
    const r = await listSupplierProducts({ ...baseParams(), page: sourcesPage.value });
    const d = r?.data || r || {};
    sources.value = d.items || [];
    sourcesTotal.value = d.total || 0;
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    loading.value = false;
  }
}

async function loadCandidates() {
  candLoading.value = true;
  try {
    const r = await listSupplierCandidates({ ...baseParams(), page: candidatesPage.value });
    const d = r?.data || r || {};
    candidates.value = d.items || [];
    candidatesTotal.value = d.total || 0;
    selectedKeys.value = [];
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    candLoading.value = false;
  }
}

async function refreshCounts() {
  try {
    const [s, c] = await Promise.all([
      listSupplierProducts({ ...baseParams(), page: 1, pageSize: 1 }),
      listSupplierCandidates({ ...baseParams(), page: 1, pageSize: 1 }),
    ]);
    sourcesTotal.value = (s?.data || s || {}).total || 0;
    candidatesTotal.value = (c?.data || c || {}).total || 0;
  } catch { /* 计数失败不影响列表 */ }
}

function switchTab(t) {
  if (tab.value === t) return;
  tab.value = t;
  if (t === 'sources') loadSources();
  else loadCandidates();
}

function onFilter() {
  sourcesPage.value = 1;
  candidatesPage.value = 1;
  if (tab.value === 'sources') loadSources();
  else loadCandidates();
  refreshCounts();
}

function onSourcesPage(p) {
  sourcesPage.value = p;
  loadSources();
}

function onCandidatesPage(p) {
  candidatesPage.value = p;
  loadCandidates();
}

// ── 回填 ──
async function doBackfill() {
  if (backfilling.value) return;
  if (!window.confirm('将从历史采购单回填货源(1688/拼多多,仅单商品行+单SKU的无歧义订单),可重复执行。是否继续?')) return;
  backfilling.value = true;
  try {
    const r = await backfillSupplierProducts();
    const d = r?.data || r || {};
    show(`回填完成:扫描 ${d.scanned || 0} 单,新建 ${d.created || 0},更新 ${d.updated || 0},跳过 ${d.skipped || 0}`, 'success');
    await Promise.all([loadSources(), loadCandidates()]);
    await refreshCounts();
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    backfilling.value = false;
  }
}

// ── 新增货源 ──
const create = reactive({
  open: false,
  saving: false,
  ozonSku: '',
  sourceUrl: '',
  sourceSpec: '',
  quantityRatio: 1,
  note: '',
  preview: null,
  previewErr: '',
});

function openCreate() {
  Object.assign(create, {
    open: true,
    saving: false,
    ozonSku: '',
    sourceUrl: '',
    sourceSpec: '',
    quantityRatio: 1,
    note: '',
    preview: null,
    previewErr: '',
  });
}

async function previewProduct() {
  const sku = String(create.ozonSku || '').trim();
  create.preview = null;
  create.previewErr = '';
  if (!/^\d+$/.test(sku)) return;
  try {
    const r = await getSupplierBySku(sku);
    create.preview = (r?.data || r || {}).product || null;
  } catch (e) {
    create.previewErr = e.message || '未找到该 SKU 的本地商品';
  }
}

async function submitCreate() {
  const sku = String(create.ozonSku || '').trim();
  const url = String(create.sourceUrl || '').trim();
  if (!/^\d+$/.test(sku)) return show('请填写正确的 Ozon SKU', 'error');
  if (!url) return show('请填写 1688 商品链接或商品ID', 'error');
  create.saving = true;
  try {
    const r = await createSupplierProduct({
      ozonSku: Number(sku),
      sourceUrl: url,
      sourceSpec: create.sourceSpec.trim(),
      quantityRatio: Number(create.quantityRatio) || 1,
      note: create.note.trim(),
    });
    const d = r?.data || r || {};
    show(d.created ? '货源已添加' : '货源已更新', 'success');
    create.open = false;
    await Promise.all([loadSources(), loadCandidates()]);
    await refreshCounts();
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    create.saving = false;
  }
}

// ── 编辑货源 ──
const edit = reactive({
  open: false,
  saving: false,
  id: null,
  title: '',
  sourceSpec: '',
  quantityRatio: 1,
  note: '',
  enabled: true,
});

function openEdit(row) {
  Object.assign(edit, {
    open: true,
    saving: false,
    id: row.id,
    title: row.title || '',
    sourceSpec: row.sourceSpec || '',
    quantityRatio: row.quantityRatio ?? 1,
    note: row.note || '',
    enabled: row.enabled !== false,
  });
}

async function submitEdit() {
  edit.saving = true;
  try {
    await updateSupplierProduct(edit.id, {
      title: edit.title,
      sourceSpec: edit.sourceSpec,
      quantityRatio: Number(edit.quantityRatio) || 1,
      note: edit.note,
      enabled: edit.enabled,
    });
    show('货源已保存', 'success');
    edit.open = false;
    loadSources();
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    edit.saving = false;
  }
}

async function makePrimary(row) {
  try {
    await setSupplierPrimary(row.id);
    show('已设为常用货源', 'success');
    loadSources();
  } catch (e) {
    show(e.message || String(e), 'error');
  }
}

async function removeRow(row) {
  if (!window.confirm(`确认删除该货源?\nSKU ${row.ozonSku} · ${row.title || row.sourceItemId}`)) return;
  try {
    await deleteSupplierProduct(row.id);
    show('已删除', 'success');
    await Promise.all([loadSources(), loadCandidates()]);
    await refreshCounts();
  } catch (e) {
    show(e.message || String(e), 'error');
  }
}

// ── 候选确认 ──
function candKey(c) {
  return `${c.ozonSku}|${c.sourceItemId}|${c.sourceSkuId || ''}`;
}

function isSelected(c) {
  return selectedKeys.value.includes(candKey(c));
}

function toggleSelect(c) {
  const k = candKey(c);
  if (selectedKeys.value.includes(k)) selectedKeys.value = selectedKeys.value.filter((x) => x !== k);
  else selectedKeys.value = [...selectedKeys.value, k];
}

const selectedCount = computed(() => selectedKeys.value.length);

function payloadOf(c) {
  const { exists, ambiguous, ...rest } = c;
  return rest;
}

async function confirmBatch(items) {
  if (!items || !items.length) return;
  try {
    const r = await confirmSupplierCandidates(items.map(payloadOf));
    const d = r?.data || r || {};
    show(`已加入货源:新建 ${d.created || 0},更新 ${d.updated || 0}`, 'success');
    if (d.errors && d.errors.length) show(`${d.errors.length} 条失败:${d.errors[0].error}`, 'error');
    await Promise.all([loadCandidates(), loadSources()]);
    await refreshCounts();
  } catch (e) {
    show(e.message || String(e), 'error');
  }
}

function confirmSelected() {
  const all = candidates.value.flatMap((g) => g.candidates);
  const picked = all.filter((c) => isSelected(c));
  if (!picked.length) return;
  confirmBatch(picked);
}

// ── 工具 ──
function fmtMoney(v) {
  if (v == null || v === '') return '—';
  return '¥' + Number(v).toFixed(2);
}
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function platformLabel(p) {
  return { 1688: '1688', ali1688: '1688', pdd: '拼多多', yangkeduo: '拼多多', taobao: '淘宝', xianyu: '闲鱼' }[p] || p || '—';
}

onMounted(async () => {
  storesStore.load();
  await loadSources();
  await refreshCounts();
});
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">货源管理</h2>
        <p class="page-desc">
          维护 Ozon 商品的平台货源(1688 / 拼多多)。采购单保存/补全时自动积累无歧义货源;多商品行订单只生成候选,需人工确认。
        </p>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost" :disabled="backfilling" @click="doBackfill">
          {{ backfilling ? '回填中…' : '从历史采购回填' }}
        </button>
        <button class="btn btn-primary" @click="openCreate">新增货源</button>
      </div>
    </div>

    <div class="toolbar">
      <div class="tabs">
        <button class="tab-btn" :class="{ active: tab === 'sources' }" @click="switchTab('sources')">
          货源列表 <span class="tab-count">{{ sourcesTotal }}</span>
        </button>
        <button class="tab-btn" :class="{ active: tab === 'candidates' }" @click="switchTab('candidates')">
          待确认候选 <span class="tab-count">{{ candidatesTotal }}</span>
        </button>
      </div>
      <div class="toolbar-right">
        <select v-model="filter.storeId" class="form-control store-select" @change="onFilter">
          <option value="">全部店铺</option>
          <option v-for="s in storeOptions" :key="s.id" :value="s.id">{{ s.name || s.id }}</option>
        </select>
        <select v-model="filter.platform" class="form-control platform-select" @change="onFilter">
          <option value="">全部平台</option>
          <option value="1688">1688</option>
          <option value="yangkeduo">拼多多</option>
        </select>
        <input
          v-model="filter.keyword"
          class="form-control search"
          placeholder="搜索 SKU / offer / 货源商品ID / 标题 / 规格"
          @keyup.enter="onFilter"
        />
        <button class="btn btn-ghost btn-sm" @click="onFilter">查询</button>
      </div>
    </div>

    <!-- 货源列表 -->
    <div v-if="tab === 'sources'" class="card">
      <div v-if="loading" class="list-empty">加载中…</div>
      <div v-else-if="!sources.length" class="list-empty">
        暂无货源。可点击「从历史采购回填」自动生成,或「新增货源」手工添加。
      </div>
      <table v-else class="sp-table">
        <thead>
          <tr>
            <th>Ozon 商品</th>
            <th>货源商品</th>
            <th>最近采购</th>
            <th>供应商 / 账号</th>
            <th class="num">配比</th>
            <th>状态</th>
            <th class="ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sources" :key="row.id">
            <td>
              <div class="goods-cell">
                <img v-if="row.product?.image" :src="row.product.image" class="goods-img" referrerpolicy="no-referrer" loading="lazy" alt="" />
                <div v-else class="goods-img goods-img-empty"></div>
                <div class="goods-info">
                  <span class="goods-name" :title="row.product?.name">{{ row.product?.name || '—' }}</span>
                  <span class="goods-sub mono">SKU {{ row.ozonSku }} · {{ row.offerId || '—' }}</span>
                  <span class="goods-sub">{{ storeName(row.storeId) }}</span>
                </div>
              </div>
            </td>
            <td>
              <div class="goods-cell">
                <img v-if="row.sourceImage" :src="row.sourceImage" class="goods-img" referrerpolicy="no-referrer" loading="lazy" alt="" />
                <div v-else class="goods-img goods-img-empty"></div>
                <div class="goods-info">
                  <span class="goods-name-row">
                    <span class="platform-tag">{{ platformLabel(row.platform) }}</span>
                    <a
                      v-if="row.sourceUrl"
                      class="goods-name link"
                      :href="row.sourceUrl"
                      target="_blank"
                      rel="noopener"
                      :title="row.title"
                    >{{ row.title || '货源商品' }}</a>
                    <span v-else class="goods-name">{{ row.title || '—' }}</span>
                  </span>
                  <span class="goods-sub">{{ row.sourceSpec || '—' }}</span>
                  <span class="goods-sub mono">
                    {{ row.sourceItemId }}<template v-if="row.sourceSkuId"> · SKU {{ row.sourceSkuId }}</template>
                  </span>
                </div>
              </div>
            </td>
            <td>
              <div>{{ fmtMoney(row.lastPrice) }} · {{ row.purchaseCount || 0 }} 次</div>
              <div class="muted">{{ fmtTime(row.lastPurchaseAt) }}</div>
              <div class="muted mono" :title="row.lastPurchaseSn">{{ row.lastPurchaseSn || '' }}</div>
            </td>
            <td>
              <div>{{ row.sellerName || '—' }}</div>
              <div class="muted">{{ row.buyerAccount || '' }}</div>
            </td>
            <td class="num ratio-cell">1 : {{ row.quantityRatio ?? 1 }}</td>
            <td class="status-cell">
              <span v-if="row.isPrimary" class="tag-primary">常用</span>
              <span v-if="row.enabled === false" class="tag-disabled">已停用</span>
            </td>
            <td class="ops">
              <button v-if="!row.isPrimary" class="btn btn-ghost btn-sm" @click="makePrimary(row)">设为常用</button>
              <button class="btn btn-ghost btn-sm" @click="openEdit(row)">编辑</button>
              <button class="btn btn-danger btn-sm" @click="removeRow(row)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <AppPager
        v-if="sourcesTotal > pageSize"
        :modelValue="sourcesPage"
        :total="sourcesTotal"
        :pageSize="pageSize"
        @update:modelValue="onSourcesPage"
      />
    </div>

    <!-- 待确认候选 -->
    <div v-else class="card">
      <div v-if="candLoading" class="list-empty">加载中…</div>
      <div v-else-if="!candidates.length" class="list-empty">
        暂无待确认候选。采购单关联 Ozon SKU 后,历史商品行会在这里生成候选。
      </div>
      <template v-else>
        <div v-if="selectedCount" class="batch-bar">
          已选 {{ selectedCount }} 个候选
          <button class="btn btn-primary btn-sm" @click="confirmSelected">确认加入货源</button>
        </div>
        <div v-for="g in candidates" :key="g.ozonSku" class="cand-group">
          <div class="cand-head">
            <img v-if="g.product?.image" :src="g.product.image" class="goods-img" referrerpolicy="no-referrer" loading="lazy" alt="" />
            <div v-else class="goods-img goods-img-empty"></div>
            <div class="goods-info">
              <span class="goods-name" :title="g.product?.name">{{ g.product?.name || '—' }}</span>
              <span class="goods-sub mono">SKU {{ g.ozonSku }} · {{ g.offerId || g.product?.offerId || '—' }} · {{ storeName(g.storeId) }}</span>
            </div>
            <span class="cand-count">{{ g.candidateCount }} 个候选</span>
            <button class="btn btn-ghost btn-sm" @click="confirmBatch(g.candidates)">全部加入</button>
          </div>
          <table class="sp-table inner">
            <tbody>
              <tr v-for="c in g.candidates" :key="candKey(c)">
                <td class="sel-col">
                  <input type="checkbox" :checked="isSelected(c)" @change="toggleSelect(c)" />
                </td>
                <td>
                  <div class="goods-cell">
                    <img v-if="c.sourceImage" :src="c.sourceImage" class="goods-img" referrerpolicy="no-referrer" loading="lazy" alt="" />
                    <div v-else class="goods-img goods-img-empty"></div>
                    <div class="goods-info">
                      <span class="goods-name-row">
                        <span class="platform-tag">{{ platformLabel(c.platform) }}</span>
                        <a
                          v-if="c.sourceUrl"
                          class="goods-name link"
                          :href="c.sourceUrl"
                          target="_blank"
                          rel="noopener"
                          :title="c.title"
                        >{{ c.title || '货源商品' }}</a>
                        <span v-else class="goods-name">{{ c.title || '—' }}</span>
                      </span>
                      <span class="goods-sub">{{ c.sourceSpec || '—' }}</span>
                      <span class="goods-sub mono">
                        {{ c.sourceItemId }}<template v-if="c.sourceSkuId"> · SKU {{ c.sourceSkuId }}</template>
                      </span>
                    </div>
                  </div>
                </td>
                <td>
                  <div>{{ fmtMoney(c.lastPrice) }} · {{ c.purchaseCount }} 次</div>
                  <div class="muted">{{ fmtTime(c.lastPurchaseAt) }}</div>
                  <div class="muted mono">{{ c.lastPurchaseSn || '' }}</div>
                </td>
                <td>
                  <div>{{ c.sellerName || '—' }}</div>
                  <div class="muted">{{ c.buyerAccount || '' }}</div>
                  <div v-if="c.ambiguous" class="warn-tag" title="该采购单含多个商品行,无法确定与当前 SKU 的对应关系,请核对">
                    多商品行订单,请核对
                  </div>
                </td>
                <td class="ops">
                  <button class="btn btn-primary btn-sm" @click="confirmBatch([c])">加入货源</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <AppPager
          v-if="candidatesTotal > pageSize"
          :modelValue="candidatesPage"
          :total="candidatesTotal"
          :pageSize="pageSize"
          @update:modelValue="onCandidatesPage"
        />
      </template>
    </div>

    <!-- 新增货源 -->
    <AppModal :open="create.open" title="新增货源" size="lg" @update:open="create.open = $event">
      <div class="form-modal">
        <label class="form-row">
          <span class="form-label">Ozon SKU <b class="required">*</b></span>
          <input
            v-model="create.ozonSku"
            class="form-control"
            placeholder="输入 Ozon SKU,失焦后自动带出商品信息"
            @blur="previewProduct"
          />
        </label>
        <div v-if="create.preview" class="product-preview">
          <img v-if="create.preview.image" :src="create.preview.image" class="goods-img" referrerpolicy="no-referrer" alt="" />
          <div class="goods-info">
            <span class="goods-name">{{ create.preview.name }}</span>
            <span class="goods-sub mono">offer {{ create.preview.offerId || '—' }} · {{ storeName(create.preview.storeId) }}</span>
          </div>
        </div>
        <div v-else-if="create.previewErr" class="form-err">{{ create.previewErr }}</div>

        <label class="form-row">
          <span class="form-label">货源商品链接 / ID（1688 / 拼多多） <b class="required">*</b></span>
          <input
            v-model="create.sourceUrl"
            class="form-control"
            placeholder="https://detail.1688.com/offer/123456789.html 或 https://mobile.yangkeduo.com/goods.html?goods_id=..."
          />
        </label>
        <label class="form-row">
          <span class="form-label">规格</span>
          <input v-model="create.sourceSpec" class="form-control" placeholder="如 颜色:黑色;尺码:XL（拼多多可填订单规格文本）" />
        </label>
        <div class="form-row-inline">
          <label class="form-row">
            <span class="form-label">配比(1 个 Ozon 件 = N 个货源商品)</span>
            <input v-model.number="create.quantityRatio" type="number" min="0.01" step="0.01" class="form-control" />
          </label>
          <label class="form-row">
            <span class="form-label">备注</span>
            <input v-model="create.note" class="form-control" placeholder="可填供应商说明/替代款等" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="create.open = false">取消</button>
          <button class="btn btn-primary" :disabled="create.saving" @click="submitCreate">
            {{ create.saving ? '提交中…' : '保存' }}
          </button>
        </div>
      </div>
    </AppModal>

    <!-- 编辑货源 -->
    <AppModal :open="edit.open" title="编辑货源" size="lg" @update:open="edit.open = $event">
      <div class="form-modal">
        <label class="form-row">
          <span class="form-label">货源标题</span>
          <input v-model="edit.title" class="form-control" />
        </label>
        <label class="form-row">
          <span class="form-label">1688 规格</span>
          <input v-model="edit.sourceSpec" class="form-control" />
        </label>
        <div class="form-row-inline">
          <label class="form-row">
            <span class="form-label">配比(1 个 Ozon 件 = N 个货源商品)</span>
            <input v-model.number="edit.quantityRatio" type="number" min="0.01" step="0.01" class="form-control" />
          </label>
          <label class="form-row">
            <span class="form-label">启用</span>
            <label class="switch-row">
              <input v-model="edit.enabled" type="checkbox" />
              <span>{{ edit.enabled ? '已启用' : '已停用' }}</span>
            </label>
          </label>
        </div>
        <label class="form-row">
          <span class="form-label">备注</span>
          <textarea v-model="edit.note" class="form-control" rows="2"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="edit.open = false">取消</button>
          <button class="btn btn-primary" :disabled="edit.saving" @click="submitEdit">
            {{ edit.saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.page { padding: 16px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; gap: 12px; }
.page-title { margin: 0; font-size: 20px; }
.page-desc { margin: 4px 0 0; color: #86909c; font-size: 13px; max-width: 760px; }
.header-actions { display: flex; gap: 8px; flex-shrink: 0; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.tabs { display: flex; gap: 8px; }
.tab-btn { border: 1px solid #e5e6eb; background: #fff; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; color: #4e5969; }
.tab-btn.active { background: #165dff; color: #fff; border-color: #165dff; }
.tab-count { margin-left: 4px; opacity: 0.85; }
.toolbar-right { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.store-select { width: 160px; }
.platform-select { width: 120px; }
.search { width: 300px; }
.form-control { width: 100%; border: 1px solid #e5e6eb; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
.card { background: #fff; border-radius: 8px; padding: 12px; }
.list-empty { text-align: center; color: #a6abb3; padding: 30px 0; }
.sp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.sp-table th, .sp-table td { padding: 8px 10px; border-bottom: 1px solid #f2f3f5; text-align: left; vertical-align: top; }
.sp-table th { color: #86909c; font-weight: 500; background: #fafbfc; white-space: nowrap; }
.sp-table .num { text-align: right; }
.sp-table .ratio-cell, .sp-table .status-cell { white-space: nowrap; }
.sp-table .ops { white-space: nowrap; }
.sp-table .ops .btn { margin-right: 4px; }
.sp-table .sel-col { width: 36px; text-align: center; }
.sp-table.inner td { border-bottom: 1px dashed #f2f3f5; }
.mono { font-family: 'Courier New', monospace; }
.muted { color: #86909c; font-size: 12px; }
.goods-cell { display: flex; gap: 8px; align-items: flex-start; }
.goods-img { width: 42px; height: 42px; border-radius: 4px; object-fit: cover; background: #f2f3f5; flex-shrink: 0; }
.goods-img-empty { background: #f2f3f5; }
.goods-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.goods-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.platform-tag { flex-shrink: 0; background: #eef4ff; color: #165dff; border-radius: 4px; padding: 0 6px; font-size: 11px; line-height: 18px; }
.goods-name { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #1f2329; }
.goods-name.link { color: #165dff; text-decoration: none; }
.goods-name.link:hover { text-decoration: underline; }
.goods-sub { color: #86909c; font-size: 12px; }
.tag-primary { display: inline-block; background: #e8ffea; color: #0b7a2d; border-radius: 4px; padding: 1px 8px; font-size: 12px; white-space: nowrap; }
.tag-disabled { display: inline-block; background: #f2f3f5; color: #86909c; border-radius: 4px; padding: 1px 8px; font-size: 12px; margin-left: 4px; white-space: nowrap; }
.warn-tag { display: inline-block; margin-top: 4px; color: #d97706; background: #fff7e6; border-radius: 4px; padding: 1px 6px; font-size: 11px; }
.batch-bar { display: flex; align-items: center; gap: 8px; background: #eef4ff; color: #165dff; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; font-size: 13px; }
.cand-group { border: 1px solid #e5e6eb; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
.cand-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #fafbfc; border-bottom: 1px solid #f2f3f5; }
.cand-head .goods-info { flex: 1; }
.cand-count { color: #86909c; font-size: 12px; white-space: nowrap; }
.form-modal { display: flex; flex-direction: column; gap: 12px; }
.form-row { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.form-row-inline { display: flex; gap: 12px; }
.form-label { font-size: 12px; color: #4e5969; }
.required { color: #f53f3f; }
.form-err { color: #f53f3f; font-size: 12px; }
.product-preview { display: flex; gap: 8px; align-items: center; background: #f7f8fa; border-radius: 6px; padding: 8px; }
.switch-row { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #4e5969; height: 30px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>
