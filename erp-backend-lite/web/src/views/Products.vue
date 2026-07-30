<script setup>
import { ref, reactive, onMounted } from 'vue';
import { getProducts, getProductDetail, syncProducts } from '../api/products.js';
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
    hasStock: '', // '' 全部 | '1' 有库存 | '0' 无库存
  },
});

// 同步状态:从 Ozon 拉取店铺商品写入本地缓存
const syncing = ref(false);
const syncLabel = ref('同步店铺商品');

async function loadList() {
  state.loading = true;
  try {
    const data = await getProducts({
      currentPage: state.page,
      pageSize: state.pageSize,
      storeId: state.filters.storeId,
      keyword: state.filters.keyword.trim(),
      status: state.filters.status,
      hasStock: state.filters.hasStock,
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

// 同步:从 Ozon 拉取店铺商品写入本地缓存
// - 选了店铺:只同步该店铺
// - 未选店铺:依次同步所有店铺,逐个显示进度,单店铺失败不影响其他
async function syncStoreProducts() {
  const storeId = state.filters.storeId;
  const targets = storeId
    ? [{ id: storeId, name: storeName(storeId) }]
    : (storesStore.list || []).map((s) => ({ id: s.id, name: s.name || s.id }));

  if (targets.length === 0) {
    show('没有可同步的店铺', 'error');
    return;
  }

  const scopeText = storeId ? `店铺「${storeName(storeId)}」` : `全部 ${targets.length} 个店铺`;
  if (!confirm(`确认从 Ozon 拉取 ${scopeText} 的商品到本地缓存?大店铺可能耗时较久。`)) {
    return;
  }

  syncing.value = true;
  let totalSynced = 0;
  let totalTotal = 0;
  let totalRemoved = 0;
  let totalMs = 0;
  let failed = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      syncLabel.value = storeId
        ? '同步中...'
        : `同步中 (${i + 1}/${targets.length}) ${t.name}`;
      try {
        const r = await syncProducts(t.id);
        totalSynced += r?.synced ?? 0;
        totalTotal += r?.total ?? 0;
        totalRemoved += r?.removed ?? 0;
        totalMs += r?.durationMs ?? 0;
      } catch (err) {
        failed++;
        show(`店铺 ${t.name} 同步失败: ${err.message || String(err)}`, 'error');
      }
    }
    const summary = `同步完成:写入 ${totalSynced}/${totalTotal} 条,清理 ${totalRemoved} 条已下架${
      failed > 0 ? `,失败 ${failed} 个店铺` : ''
    }`;
    show(summary, failed > 0 ? 'error' : 'success');
    state.page = 1;
    await loadList();
  } finally {
    syncing.value = false;
    syncLabel.value = '同步店铺商品';
  }
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

// 商品状态:从列表项 _raw.statuses 提取(OPI /v3/product/info/list 状态嵌套在 statuses 对象内)
function productStatus(item) {
  const raw = item?._raw || {};
  return raw.statuses?.status || raw.status || raw.state || '';
}

const STATUS_BADGE = {
  published: { cls: 'badge-success', label: '已发布' },
  imported: { cls: 'badge-processing', label: '已导入' },
  ready_to_publish: { cls: 'badge-processing', label: '待发布' },
  pending: { cls: 'badge-pending', label: '待处理' },
  pending_moderation: { cls: 'badge-pending', label: '待审核' },
  moderating: { cls: 'badge-processing', label: '审核中' },
  variant_wait: { cls: 'badge-failed', label: '未创建' },
  price_sent: { cls: 'badge-success', label: '准备出售' },
  failed_validation: { cls: 'badge-failed', label: '校验失败' },
  failed: { cls: 'badge-failed', label: '失败' },
  removed: { cls: 'badge-failed', label: '已下架' },
};

function statusInfo(st) {
  return STATUS_BADGE[st] || { cls: 'badge-pending', label: st || '—' };
}

// 库存徽章:基于后端返回的 hasStock(来自 OPI stocks.has_stock)
//   true=有库存可售(绿);false=无库存(price_sent 准备出售但缺货,红)
function stockBadgeClass(it) {
  return it.hasStock ? 'badge-success' : 'badge-failed';
}
function stockBadgeLabel(it) {
  return it.hasStock ? '有库存' : '无库存';
}

// 图片徽章:基于后端返回的 hasImageError(来自 OPI errors[].code 判断)
//   false=正常(无图片错误);true=警告(出现 primary_image_load_failed/pics_http_error/some_image_failed/all_image_failed)
function imageBadgeClass(it) {
  return it.hasImageError ? 'badge-failed' : 'badge-success';
}
function imageBadgeLabel(it) {
  return it.hasImageError ? '图片异常' : '正常';
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
    status: raw.statuses?.status || raw.status || raw.state || '',
    status_name: raw.statuses?.status_name || '',
    moderate_status: raw.statuses?.moderate_status || '',
    validation_status: raw.statuses?.validation_status || '',
    is_created: raw.statuses?.is_created,
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
      <button class="btn btn-primary" :disabled="syncing" @click="syncStoreProducts">
        {{ syncLabel }}
      </button>
      <button class="btn btn-ghost" :disabled="state.loading || syncing" @click="loadList">
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
      <select class="filter-select" v-model="state.filters.hasStock">
        <option value="">全部库存</option>
        <option value="1">有库存</option>
        <option value="0">无库存</option>
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
            <th>库存</th>
            <th>图片</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="8" class="muted" style="padding: 24px; text-align: center">加载中...</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="8" class="empty">暂无商品数据(插件查询过的商品会自动缓存到这里)</td>
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
            <td>
              <span class="badge" :class="stockBadgeClass(it)">{{ stockBadgeLabel(it) }}</span>
            </td>
            <td>
              <span class="badge" :class="imageBadgeClass(it)">{{ imageBadgeLabel(it) }}</span>
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
