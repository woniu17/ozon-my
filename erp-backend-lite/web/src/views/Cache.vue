<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import {
  getCacheStats,
  getCacheList,
  getCacheDetail,
  deleteCache,
  clearCache,
  getCacheOverview,
  getOpiPreview,
} from '../api/cache.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import JsonTree from '../components/JsonTree.vue';

const { show } = useToast();

// ── 统计 ───────────────────────────────────────────────────
const stats = ref({
  search: { count: 0 },
  bundle: { count: 0, emptyAttrs: 0, stale: 0 },
  pdp: { count: 0 },
  composer: { count: 0 },
  entrypoint: { count: 0 },
  dynamic: { count: 0 },
});

async function loadStats() {
  try {
    stats.value = await getCacheStats();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 列表 ───────────────────────────────────────────────────
const state = reactive({
  type: 'overview', // overview | search | bundle | pdp | composer | entrypoint | dynamic
  keyword: '',
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 50,
});

async function loadList() {
  state.loading = true;
  try {
    if (state.type === 'overview') {
      const data = await getCacheOverview({
        keyword: state.keyword.trim(),
        page: state.page,
        pageSize: state.pageSize,
      });
      state.items = data?.items || [];
      state.total = data?.total || 0;
    } else {
      const data = await getCacheList({
        type: state.type,
        keyword: state.keyword.trim(),
        page: state.page,
        pageSize: state.pageSize,
      });
      state.items = data?.items || [];
      state.total = data?.total || 0;
    }
  } catch (err) {
    show(err.message || String(err), 'error');
    state.items = [];
    state.total = 0;
  } finally {
    state.loading = false;
  }
}

function search() {
  state.page = 1;
  loadList();
}

function onPageChange(p) {
  state.page = p;
  loadList();
}

function switchType(t) {
  state.type = t;
  state.page = 1;
  state.keyword = '';
  loadList();
}

// ── 详情弹窗 ───────────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailData = ref(null);
const detailTitle = computed(() => {
  if (!detailData.value) return '缓存详情';
  return `缓存详情 · ${state.type} · ${detailData.value.sku}`;
});

async function openDetail(it) {
  detailOpen.value = true;
  detailLoading.value = true;
  detailData.value = null;
  try {
    detailData.value = await getCacheDetail(state.type, it.sku);
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detailLoading.value = false;
  }
}

// ── 删除 ───────────────────────────────────────────────────
async function onRemove(it) {
  if (!confirm(`确认删除缓存 ${state.type}/${it.sku}?`)) return;
  try {
    await deleteCache(state.type, it.sku);
    show('已删除', 'success');
    await Promise.all([loadList(), loadStats()]);
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function onClearAll() {
  const label = state.type;
  const count = stats.value[state.type]?.count || 0;
  if (!confirm(`确认清空所有 ${label} 缓存?共 ${count} 条,此操作不可恢复!`)) return;
  try {
    const r = await clearCache(state.type);
    show(`已清空 ${r.deletedCount} 条`, 'success');
    state.page = 1;
    await Promise.all([loadList(), loadStats()]);
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 渲染辅助 ───────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isStale(it) {
  // 后端 list 接口预计算 attrsStale,前端直接使用
  return state.type === 'bundle' && !!it.attrsStale;
}

// ── OPI 预览 ───────────────────────────────────────────────
const opiOpen = ref(false);
const opiLoading = ref(false);
const opiSku = ref('');
const opiData = ref(null);
const opiSources = ref(null);
const opiError = ref('');
const opiTitle = computed(() => `OPI 预览 · ${opiSku.value}`);

async function openOpiPreview(sku) {
  opiOpen.value = true;
  opiLoading.value = true;
  opiSku.value = sku;
  opiData.value = null;
  opiSources.value = null;
  opiError.value = '';
  try {
    const r = await getOpiPreview(sku);
    opiData.value = r?.item || null;
    opiSources.value = r?.sources || null;
    opiError.value = r?.error || '';
  } catch (err) {
    opiError.value = err.message || String(err);
  } finally {
    opiLoading.value = false;
  }
}

function opiSourceTag(hit) {
  return hit ? 'tag-ok' : 'tag-mute';
}

function opiSourceLabel(hit, type) {
  return hit ? type : '—';
}

onMounted(() => {
  loadStats();
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>缓存管理</h2>
      <div style="display: flex; gap: 8px">
        <button class="btn btn-ghost" :disabled="state.loading" @click="loadList">
          {{ state.loading ? '刷新中...' : '刷新列表' }}
        </button>
        <button class="btn btn-ghost" @click="loadStats">刷新统计</button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="cache-stats">
      <div class="cache-stat-card">
        <div class="cache-stat-label">search 缓存</div>
        <div class="cache-stat-value">{{ stats.search.count }}</div>
        <div class="cache-stat-sub">条记录</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">bundle 缓存</div>
        <div class="cache-stat-value">{{ stats.bundle.count }}</div>
        <div class="cache-stat-sub">条记录</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">bundle 空属性</div>
        <div class="cache-stat-value" :class="{ 'stat-warn': stats.bundle.emptyAttrs > 0 }">
          {{ stats.bundle.emptyAttrs }}
        </div>
        <div class="cache-stat-sub">条(attributes=[])</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">bundle 待重验</div>
        <div class="cache-stat-value" :class="{ 'stat-err': stats.bundle.stale > 0 }">
          {{ stats.bundle.stale }}
        </div>
        <div class="cache-stat-sub">条(空属性超 6h)</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">pdp 缓存</div>
        <div class="cache-stat-value">{{ stats.pdp.count }}</div>
        <div class="cache-stat-sub">条(DOM 静态字段)</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">composer 缓存</div>
        <div class="cache-stat-value">{{ stats.composer?.count || 0 }}</div>
        <div class="cache-stat-sub">条(widgetStates)</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">entrypoint 缓存</div>
        <div class="cache-stat-value">{{ stats.entrypoint?.count || 0 }}</div>
        <div class="cache-stat-sub">条(page-json 图册/富内容)</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">dynamic 缓存</div>
        <div class="cache-stat-value">{{ stats.dynamic?.count || 0 }}</div>
        <div class="cache-stat-sub">条(DOM 动态字段,1h TTL)</div>
      </div>
    </div>

    <!-- 类型切换 -->
    <div class="cache-type-tabs">
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'overview' }"
        @click="switchType('overview')"
      >
        全览
      </button>
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'bundle' }"
        @click="switchType('bundle')"
      >
        bundle 缓存
      </button>
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'search' }"
        @click="switchType('search')"
      >
        search 缓存
      </button>
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'pdp' }"
        @click="switchType('pdp')"
      >
        pdp 缓存
      </button>
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'composer' }"
        @click="switchType('composer')"
      >
        composer 缓存
      </button>
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'entrypoint' }"
        @click="switchType('entrypoint')"
      >
        entrypoint 缓存
      </button>
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'dynamic' }"
        @click="switchType('dynamic')"
      >
        dynamic 缓存
      </button>
    </div>

    <!-- 筛选 -->
    <div class="filter-bar">
      <input
        class="filter-input"
        type="text"
        v-model.trim="state.keyword"
        placeholder="搜索 SKU"
        @keydown.enter="search"
      />
      <button class="btn btn-primary" @click="search">查询</button>
      <span class="spacer"></span>
      <button v-if="state.type !== 'overview'" class="btn btn-danger" @click="onClearAll">清空 {{ state.type }} 缓存</button>
    </div>

    <!-- 列表:全览模式 -->
    <div v-if="state.type === 'overview'" class="table-wrap">
      <table class="data-table overview-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th title="Seller Portal /api/v1/search 源数据">search</th>
            <th title="create-bundle-by-variant-id 完整属性">bundle</th>
            <th title="DOM 解析静态字段">pdp</th>
            <th title="composer-api widgetStates">composer</th>
            <th title="entrypoint-api page-json 图册/富内容">entrypoint</th>
            <th title="DOM 动态字段(1h TTL)">dynamic</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="8" class="muted" style="padding: 24px; text-align: center">加载中...</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="8" class="empty">暂无缓存记录</td>
          </tr>
          <tr v-for="it in state.items" :key="it.sku">
            <td class="col-sku">{{ it.sku }}</td>
            <td>
              <span v-if="it.search" class="tag tag-ok" :title="fmtTime(it.search.fetchedAt)">✓</span>
              <span v-else class="tag tag-mute">—</span>
            </td>
            <td>
              <span v-if="!it.bundle" class="tag tag-mute">—</span>
              <span v-else-if="!it.bundle.attrsEmpty" class="tag tag-ok" :title="fmtTime(it.bundle.fetchedAt)">有属性</span>
              <span v-else-if="it.bundle.attrsStale" class="tag tag-err" :title="fmtTime(it.bundle.fetchedAt)">空(待重验)</span>
              <span v-else class="tag tag-warn" :title="fmtTime(it.bundle.fetchedAt)">空(6h内)</span>
            </td>
            <td>
              <span v-if="it.pdp" class="tag tag-ok" :title="fmtTime(it.pdp.fetchedAt)">✓</span>
              <span v-else class="tag tag-mute">—</span>
            </td>
            <td>
              <span v-if="it.composer" class="tag tag-ok" :title="fmtTime(it.composer.fetchedAt)">✓</span>
              <span v-else class="tag tag-mute">—</span>
            </td>
            <td>
              <span v-if="it.entrypoint" class="tag tag-ok" :title="fmtTime(it.entrypoint.fetchedAt)">✓</span>
              <span v-else class="tag tag-mute">—</span>
            </td>
            <td>
              <span v-if="!it.dynamic" class="tag tag-mute">—</span>
              <span v-else-if="!it.dynamic.expired" class="tag tag-ok" :title="fmtTime(it.dynamic.fetchedAt)">✓</span>
              <span v-else class="tag tag-warn" :title="fmtTime(it.dynamic.fetchedAt)">过期</span>
            </td>
            <td class="row-actions">
              <button class="btn btn-sm btn-primary" @click="openOpiPreview(it.sku)">OPI 预览</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 列表:单类型模式 -->
    <div v-else class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>抓取时间</th>
            <th v-if="state.type === 'bundle'">bundleId</th>
            <th v-if="state.type === 'bundle'">属性状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td :colspan="state.type === 'bundle' ? 5 : 3" class="muted" style="padding: 24px; text-align: center">
              加载中...
            </td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td :colspan="state.type === 'bundle' ? 5 : 3" class="empty">暂无缓存记录</td>
          </tr>
          <tr v-for="it in state.items" :key="it.sku">
            <td class="col-sku">{{ it.sku }}</td>
            <td class="col-time">{{ fmtTime(it.fetchedAt) }}</td>
            <td v-if="state.type === 'bundle'" class="col-bundle-id">{{ it.bundleId || '—' }}</td>
            <td v-if="state.type === 'bundle'">
              <span v-if="!it.attrsEmpty" class="tag tag-ok">有属性</span>
              <span v-else-if="isStale(it)" class="tag tag-err">空(待重验)</span>
              <span v-else class="tag tag-warn">空(6h 内验证)</span>
            </td>
            <td class="row-actions">
              <button class="btn btn-sm btn-ghost" @click="openDetail(it)">详情</button>
              <button class="btn btn-sm btn-danger" @click="onRemove(it)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AppPager :modelValue="state.page" :total="state.total" :pageSize="state.pageSize" @update:modelValue="onPageChange" />

    <!-- 详情弹窗 -->
    <AppModal :open="detailOpen" :title="detailTitle" size="lg" @update:open="detailOpen = $event">
      <p v-if="detailLoading" class="muted">加载中...</p>
      <div v-else-if="detailData" class="cache-detail">
        <div class="cache-detail-meta">
          <div><b>SKU:</b> {{ detailData.sku }}</div>
          <div><b>抓取时间:</b> {{ fmtTime(detailData.fetchedAt) }}</div>
          <div v-if="detailData.bundleId"><b>bundleId:</b> {{ detailData.bundleId }}</div>
          <div v-if="detailData.attrsEmptyVerifiedAt">
            <b>空属性验证:</b> {{ fmtTime(detailData.attrsEmptyVerifiedAt) }}
          </div>
        </div>
        <div class="cache-detail-data">
          <h3>缓存数据</h3>
          <JsonTree :data="detailData.data" :default-expand-level="2" root-key="data" />
        </div>
      </div>
      <p v-else class="muted">未找到缓存记录</p>
    </AppModal>

    <!-- OPI 预览弹窗 -->
    <AppModal :open="opiOpen" :title="opiTitle" size="lg" @update:open="opiOpen = $event">
      <p v-if="opiLoading" class="muted">加载中...</p>
      <div v-else-if="opiError" class="opi-error">
        <p>⚠️ {{ opiError }}</p>
        <div v-if="opiSources" class="opi-sources">
          <span>缓存来源:</span>
          <span :class="opiSourceTag(opiSources.search)">search</span>
          <span :class="opiSourceTag(opiSources.bundle)">bundle</span>
          <span :class="opiSourceTag(opiSources.pdp)">pdp</span>
          <span :class="opiSourceTag(opiSources.composer)">composer</span>
          <span :class="opiSourceTag(opiSources.entrypoint)">entrypoint</span>
          <span :class="opiSourceTag(opiSources.dynamic)">dynamic</span>
        </div>
      </div>
      <div v-else-if="opiData" class="opi-preview">
        <div class="opi-sources-bar">
          <span class="opi-sources-label">缓存来源:</span>
          <span :class="opiSourceTag(opiSources?.search)" :title="opiSourceLabel(opiSources?.search, 'Seller Portal /api/v1/search')">
            search {{ opiSourceLabel(opiSources?.search, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.bundle)" :title="opiSourceLabel(opiSources?.bundle, 'create-bundle-by-variant-id')">
            bundle {{ opiSourceLabel(opiSources?.bundle, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.pdp)" :title="opiSourceLabel(opiSources?.pdp, 'DOM 解析')">
            pdp {{ opiSourceLabel(opiSources?.pdp, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.composer)" :title="opiSourceLabel(opiSources?.composer, 'composer-api')">
            composer {{ opiSourceLabel(opiSources?.composer, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.entrypoint)" :title="opiSourceLabel(opiSources?.entrypoint, 'entrypoint-api')">
            entrypoint {{ opiSourceLabel(opiSources?.entrypoint, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.dynamic)" :title="opiSourceLabel(opiSources?.dynamic, 'DOM 动态字段')">
            dynamic {{ opiSourceLabel(opiSources?.dynamic, '✓') }}
          </span>
        </div>
        <div class="opi-field-summary">
          <div><b>name:</b> {{ opiData.name || '—' }}</div>
          <div><b>offer_id:</b> {{ opiData.offer_id || '—' }}</div>
          <div><b>price:</b> {{ opiData.price || '—' }}</div>
          <div><b>images:</b> {{ opiData.images?.length || 0 }} 张</div>
          <div><b>attributes:</b> {{ opiData.attributes?.length || 0 }} 个</div>
          <div><b>complex_attributes:</b> {{ opiData.complex_attributes?.length || 0 }} 组</div>
          <div v-if="opiData.weight"><b>weight:</b> {{ opiData.weight }} {{ opiData.weight_unit }}</div>
          <div v-if="opiData.type_id"><b>type_id:</b> {{ opiData.type_id }}</div>
          <div v-if="opiData.description_category_id"><b>description_category_id:</b> {{ opiData.description_category_id }}</div>
        </div>
        <div class="opi-json-section">
          <h3>OPI v3 JSON</h3>
          <JsonTree :data="opiData" :default-expand-level="2" root-key="item" />
        </div>
      </div>
      <p v-else class="muted">无数据</p>
    </AppModal>
  </div>
</template>

<style scoped>
.cache-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  padding: 0 24px 16px;
}
.cache-stat-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px;
  text-align: center;
}
.cache-stat-label {
  font-size: 12px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.cache-stat-value {
  font-size: 28px;
  font-weight: 600;
  margin: 6px 0 2px;
  color: var(--text);
}
.cache-stat-value.stat-warn {
  color: var(--warning);
}
.cache-stat-value.stat-err {
  color: var(--danger);
}
.cache-stat-sub {
  font-size: 12px;
  color: var(--muted);
}

.cache-type-tabs {
  display: flex;
  gap: 0;
  padding: 0 24px 12px;
}
.cache-type-tab {
  padding: 8px 18px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}
.cache-type-tab:first-child {
  border-radius: 6px 0 0 6px;
}
.cache-type-tab:last-child {
  border-radius: 0 6px 6px 0;
  border-left: none;
}
.cache-type-tab.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}

.col-sku {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 12px;
}
.col-bundle-id {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 12px;
  color: var(--muted);
}

.cache-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.cache-detail-meta {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
}
.cache-detail-meta b {
  color: var(--muted);
  font-weight: 500;
}
.cache-detail-data h3 {
  margin-bottom: 8px;
}

/* 全览表格 */
.overview-table th,
.overview-table td {
  text-align: center;
}
.overview-table .col-sku {
  text-align: left;
}
.tag-mute {
  background: #f3f4f6;
  color: #9ca3af;
}
.overview-table .row-actions {
  text-align: center;
}

/* OPI 预览弹窗 */
.opi-preview {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.opi-sources-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 10px 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 12px;
}
.opi-sources-label {
  color: var(--muted);
  margin-right: 4px;
}
.opi-sources-bar > span:not(.opi-sources-label) {
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
}
.opi-field-summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
}
.opi-field-summary b {
  color: var(--muted);
  font-weight: 500;
}
.opi-json-section h3 {
  margin-bottom: 8px;
}
.opi-error {
  padding: 12px;
  background: #fef2f2;
  border-radius: 6px;
  color: #b91c1c;
}
.opi-error .opi-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
}
.opi-error .opi-sources > span {
  padding: 2px 8px;
  border-radius: 4px;
}
</style>
