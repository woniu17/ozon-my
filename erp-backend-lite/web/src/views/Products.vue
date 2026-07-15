<script setup>
import { ref, reactive, onMounted } from 'vue';
import { getProducts, getProductDetail } from '../api/products.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import AppAccordion from '../components/AppAccordion.vue';
import JsonTree from '../components/JsonTree.vue';

const storesStore = useStoresStore();
const { show } = useToast();

// ── 列表状态 ───────────────────────────────────────────────
const state = reactive({
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 20,
  filters: {
    storeId: '',
    keyword: '',
    status: '',
  },
});

async function loadList() {
  state.loading = true;
  try {
    const data = await getProducts({
      currentPage: state.page,
      pageSize: state.pageSize,
      storeId: state.filters.storeId,
      keyword: state.filters.keyword.trim(),
      status: state.filters.status,
    });
    state.items = data?.items || [];
    state.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    state.items = [];
    state.total = 0;
  } finally {
    state.loading = false;
  }
}

// 查询:重置到第 1 页后加载
function search() {
  state.page = 1;
  loadList();
}

// 翻页:先更新页码再加载,确保读取最新 page
function onPageChange(p) {
  state.page = p;
  loadList();
}

// ── 详情弹窗 ───────────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detail = ref(null);

async function openDetail(sku) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    const data = await getProductDetail(sku);
    detail.value = data || null;
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detailLoading.value = false;
  }
}

// ── 渲染辅助 ───────────────────────────────────────────────
function storeName(storeId) {
  const s = storesStore.list.find((x) => x.id === storeId);
  return s?.name || storeId || '—';
}

function fmtTime(t) {
  if (!t) return '—';
  return String(t).replace('T', ' ').slice(0, 19);
}

// 商品状态:从列表项 _raw 提取(Ozon 商品 info 的 status / state 字段)
function productStatus(item) {
  const raw = item?._raw || {};
  return raw.status || raw.state || '';
}

const STATUS_BADGE = {
  published: { cls: 'badge-success', label: '已发布' },
  imported: { cls: 'badge-processing', label: '已导入' },
  ready_to_publish: { cls: 'badge-processing', label: '待发布' },
  pending: { cls: 'badge-pending', label: '待处理' },
  pending_moderation: { cls: 'badge-pending', label: '待审核' },
  moderating: { cls: 'badge-processing', label: '审核中' },
  failed_validation: { cls: 'badge-failed', label: '校验失败' },
  failed: { cls: 'badge-failed', label: '失败' },
  removed: { cls: 'badge-failed', label: '已下架' },
};

function statusInfo(st) {
  return STATUS_BADGE[st] || { cls: 'badge-pending', label: st || '—' };
}

// 详情弹窗:用 AppAccordion 分组展示商品缓存数据
// 每组内容统一用 <pre class="sf-value-pre"> 渲染 JSON
function detailSections(d) {
  if (!d) return [];
  const raw = d.data || {};
  const basic = {
    sku: d.sku,
    name: raw.name || raw.title || '',
    store_id: d.storeId,
    status: raw.status || raw.state || '',
    fetchedAt: d.fetchedAt,
    productId: raw.product_id || raw.id || '',
  };
  return [
    { title: '基本信息', value: basic, open: true },
    { title: 'attributes', value: raw.attributes ?? null, open: false },
    { title: '描述', value: raw.description ?? null, open: false },
    {
      title: '图片',
      value: { primary_image: raw.primary_image || raw.image || '', images: raw.images || [] },
      open: false,
    },
    { title: '完整数据', value: raw, open: false },
  ];
}

onMounted(() => {
  storesStore.load();
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>商品列表</h2>
      <button class="btn btn-ghost" :disabled="state.loading" @click="loadList">
        {{ state.loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <div class="filter-bar">
      <select class="filter-select" v-model="state.filters.storeId">
        <option value="">全部店铺</option>
        <option v-for="s in storesStore.list" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <input
        class="filter-input"
        type="text"
        v-model.trim="state.filters.keyword"
        placeholder="搜索 SKU / 名称"
        @keydown.enter="search"
      />
      <select class="filter-select" v-model="state.filters.status">
        <option value="">全部状态</option>
        <option value="published">已发布</option>
        <option value="imported">已导入</option>
        <option value="pending">待处理</option>
        <option value="moderating">审核中</option>
        <option value="failed">失败</option>
      </select>
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>名称</th>
            <th>店铺</th>
            <th>状态</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="6" class="muted" style="padding: 24px; text-align: center">加载中...</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="6" class="empty">暂无商品数据(插件查询过的商品会自动缓存到这里)</td>
          </tr>
          <tr v-for="it in state.items" :key="it.sku">
            <td>{{ it.sku }}</td>
            <td :title="it.name">{{ it.name || '—' }}</td>
            <td>{{ storeName(it.storeId) }}</td>
            <td>
              <span class="badge" :class="statusInfo(productStatus(it)).cls">{{
                statusInfo(productStatus(it)).label
              }}</span>
            </td>
            <td>{{ fmtTime(it.fetchedAt) }}</td>
            <td>
              <button class="btn btn-sm btn-ghost" @click="openDetail(it.sku)">查看详情</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AppPager
      :modelValue="state.page"
      :total="state.total"
      :pageSize="state.pageSize"
      @update:modelValue="onPageChange"
    />

    <!-- 详情弹窗 -->
    <AppModal :open="detailOpen" title="商品详情" size="lg" @update:open="detailOpen = $event">
      <div v-if="detailLoading" class="empty">加载中...</div>
      <template v-else-if="detail">
        <AppAccordion
          v-for="(sec, idx) in detailSections(detail)"
          :key="idx"
          :title="sec.title"
          :default-open="sec.open"
        >
          <JsonTree :data="sec.value" :root-key="sec.title" />
        </AppAccordion>
      </template>
      <div v-else class="empty">无数据</div>
    </AppModal>
  </div>
</template>
