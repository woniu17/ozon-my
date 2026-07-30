<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { getProducts, getProductDetail, syncProducts, getSyncProgress } from '../api/products.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import AppAccordion from '../components/AppAccordion.vue';
import JsonTree from '../components/JsonTree.vue';
import ImageRefreshDialog from '../components/ImageRefreshDialog.vue';
import StockRefreshDialog from '../components/StockRefreshDialog.vue';

const router = useRouter();
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
    imageIssue: '',
  },
});

// 列表行勾选(批量更新图片用)
const selectedSkus = ref([]);
// 图片更新弹窗
const refreshDialog = ref({ open: false, mode: 'single', singleItem: null, selectedProducts: [] });
// 库存更新弹窗(2026-07)
const stockDialog = ref({ open: false, mode: 'single', singleItem: null, selectedProducts: [] });
// 按筛选批量操作:拉取中的状态('image' | 'stock' | '')
const filterBatchLoading = ref('');

// 同步状态:从 Ozon 拉取店铺商品写入本地缓存
const syncing = ref(false);
const syncLabel = ref('同步店铺商品');
// 同步进度:各店铺实时进度列表(轮询 GET /sync-progress 填充)
const syncProgressItems = ref([]);
let syncProgressTimer = null;

function startProgressPolling() {
  stopProgressPolling();
  const poll = async () => {
    try {
      const r = await getSyncProgress();
      syncProgressItems.value = r?.items || [];
    } catch {
      // 轮询失败不阻断,下次重试
    }
  };
  poll();
  syncProgressTimer = setInterval(poll, 2000);
}

function stopProgressPolling() {
  if (syncProgressTimer) {
    clearInterval(syncProgressTimer);
    syncProgressTimer = null;
  }
}

// 格式化单条进度为简短文本
function fmtProgress(p) {
  if (!p) return '';
  const secs = Math.round((p.elapsedMs || 0) / 1000);
  const t = `${secs}s`;
  if (p.status === 'done') return `✓ ${p.message} (${t})`;
  if (p.status === 'error') return `✗ ${p.message} (${t})`;
  return `${p.message || p.phase} (${t})`;
}

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
      imageIssue: state.filters.imageIssue,
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
// - 未选店铺:并行同步所有店铺,店铺间间隔 5s 发请求避免触发限流,单店铺失败不影响其他
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
  const STORE_INTERVAL_MS = 5000; // 店铺间发请求间隔,避免触发 Ozon 限流
  startProgressPolling(); // 启动进度轮询(2s 间隔)
  try {
    // 并行启动:第 i 个店铺延迟 i*5s 发请求,各店铺独立 await 不阻塞其他
    const promises = targets.map((t, i) => {
      // 单店铺任务:延迟启动 + 独立错误隔离
      const task = async () => {
        if (i > 0) await new Promise((r) => setTimeout(r, i * STORE_INTERVAL_MS));
        const r = await syncProducts(t.id);
        return { target: t, result: r };
      };
      return task().catch((err) => {
        // 单店铺失败不影响其他,返回 error 标记
        show(`店铺 ${t.name} 同步失败: ${err.message || String(err)}`, 'error');
        return { target: t, error: err };
      });
    });

    // 显示"同步中"提示(详细进度见下方进度列表)
    syncLabel.value = storeId ? '同步中...' : `同步中 (并行 ${targets.length} 个店铺)`;

    const results = await Promise.all(promises);
    let totalSynced = 0;
    let totalTotal = 0;
    let totalRemoved = 0;
    let failed = 0;
    let totalFailedBatches = 0;
    for (const r of results) {
      if (r.error) {
        failed++;
        continue;
      }
      totalSynced += r.result?.synced ?? 0;
      totalTotal += r.result?.total ?? 0;
      totalRemoved += r.result?.removed ?? 0;
      totalFailedBatches += r.result?.failedBatches ?? 0;
    }
    const summary = `同步完成:写入 ${totalSynced}/${totalTotal} 条,清理 ${totalRemoved} 条已下架${
      failed > 0 ? `,失败 ${failed} 个店铺` : ''
    }${totalFailedBatches > 0 ? `,${totalFailedBatches} 批详情拉取失败(见日志)` : ''}`;
    show(summary, failed > 0 || totalFailedBatches > 0 ? 'error' : 'success');
    state.page = 1;
    await loadList();
  } finally {
    // 最后再轮询一次拿终态,然后停止
    try { const r = await getSyncProgress(); syncProgressItems.value = r?.items || []; } catch {}
    stopProgressPolling();
    // 保留进度显示 5s 后清空
    setTimeout(() => { syncProgressItems.value = []; }, 5000);
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

// ── 图片更新 ──────────────────────────────────────────────
function toggleSelect(sku) {
  const idx = selectedSkus.value.indexOf(sku);
  if (idx >= 0) selectedSkus.value.splice(idx, 1);
  else selectedSkus.value.push(sku);
}
function isSelected(sku) {
  return selectedSkus.value.includes(sku);
}
const allSelected = computed(
  () => state.items.length > 0 && state.items.every((r) => selectedSkus.value.includes(r.sku))
);
function toggleSelectAll() {
  if (allSelected.value) {
    const skus = new Set(state.items.map((r) => r.sku));
    selectedSkus.value = selectedSkus.value.filter((s) => !skus.has(s));
  } else {
    const existing = new Set(selectedSkus.value);
    for (const r of state.items) existing.add(r.sku);
    selectedSkus.value = [...existing];
  }
}
// 单条更新图片:详情弹窗「图片」分组触发
function openSingleRefresh(item) {
  if (!item.productId) {
    show('该商品无 product_id,可能未同步完整', 'error');
    return;
  }
  refreshDialog.value = {
    open: true,
    mode: 'single',
    // offerId 用后端返回的卖家SKU(data.offer_id),不能用 item.sku(那是 FBS 变体SKU)
    singleItem: { productId: item.productId, storeId: item.storeId, offerId: item.offerId },
    selectedProducts: [],
  };
}
// 批量更新图片:列表勾选触发(不限图片问题)
function openBatchRefresh() {
  const products = state.items
    .filter((r) => selectedSkus.value.includes(r.sku) && r.productId)
    .map((r) => ({ productId: r.productId, storeId: r.storeId }));
  if (!products.length) {
    show('请先勾选有 product_id 的商品', 'error');
    return;
  }
  refreshDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
}

// ── 库存更新(2026-07)──────────────────────────────────────
// 单条更新库存:列表行操作触发
function openSingleStock(item) {
  if (!item.productId) {
    show('该商品无 product_id,可能未同步完整', 'error');
    return;
  }
  stockDialog.value = {
    open: true,
    mode: 'single',
    singleItem: { productId: item.productId, storeId: item.storeId, offerId: item.offerId },
    selectedProducts: [],
  };
}
// 批量更新库存:列表勾选触发
function openBatchStock() {
  const products = state.items
    .filter((r) => selectedSkus.value.includes(r.sku) && r.productId)
    .map((r) => ({ productId: r.productId, storeId: r.storeId }));
  if (!products.length) {
    show('请先勾选有 product_id 的商品', 'error');
    return;
  }
  stockDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
}

// 按当前筛选条件批量更新(不限于当前页,拉取全量匹配商品的 productId/storeId)
// type: 'image' | 'stock'
async function openFilteredBatch(type) {
  if (filterBatchLoading.value) return;
  filterBatchLoading.value = type;
  try {
    const data = await getProducts({
      storeId: state.filters.storeId,
      keyword: state.filters.keyword.trim(),
      status: state.filters.status,
      hasStock: state.filters.hasStock,
      imageIssue: state.filters.imageIssue,
      idsOnly: 1,
    });
    const products = (data?.items || []).filter((p) => p.productId);
    if (!products.length) {
      show('当前筛选无可用商品(缺少 product_id)', 'error');
      return;
    }
    if (!confirm(`将对当前筛选匹配的 ${products.length} 个商品批量更新${type === 'image' ? '图片' : '库存'},是否继续?`)) {
      return;
    }
    if (type === 'image') {
      refreshDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
    } else {
      stockDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
    }
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    filterBatchLoading.value = '';
  }
}
function openFilteredRefresh() {
  return openFilteredBatch('image');
}
function openFilteredStock() {
  return openFilteredBatch('stock');
}

// 商品状态:从列表项 _raw.statuses 提取(OPI /v3/product/info/list 状态嵌套在 statuses 对象内)
function productStatus(item) {
  const raw = item?._raw || {};
  return raw.statuses?.status || raw.status || raw.state || '';
}

const STATUS_BADGE = {
  // 实际数据中出现的状态(OPI /v3/product/info/list 的 statuses.status)
  price_sent: { cls: 'badge-success', label: '准备出售' },
  variant_wait: { cls: 'badge-failed', label: '未创建' },
  new: { cls: 'badge-pending', label: '新建' },
  unmatched: { cls: 'badge-failed', label: '未匹配' },
  moderated: { cls: 'badge-success', label: '已审核' },
  offer_validated: { cls: 'badge-processing', label: '报价已验证' },
  // 兼容可能出现的其他状态(同步拉取后可能出现)
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

// 库存徽章:基于后端返回的 hasStock(来自 OPI stocks.has_stock)
//   true=有库存可售(绿);false=无库存(price_sent 准备出售但缺货,红)
function stockBadgeClass(it) {
  return it.hasStock ? 'badge-success' : 'badge-failed';
}
function stockBadgeLabel(it) {
  return String(Number(it.stockPresent) || 0);
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

    <!-- 同步进度:右上角浮动卡片(不占文档流,避免破坏页面布局) -->
    <div
      v-if="syncProgressItems.length"
      style="position:fixed;top:16px;right:16px;z-index:2000;min-width:320px;max-width:420px;background:#fff;border:1px solid #e0e0e0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.12);padding:12px 14px;font-size:13px"
    >
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #f0f0f0">
        <span style="font-weight:600">同步进度</span>
        <span style="color:#999;font-size:12px">{{ syncProgressItems.length }} 个店铺</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;max-height:50vh;overflow-y:auto">
        <div
          v-for="p in syncProgressItems"
          :key="p.storeId"
          style="display:flex;gap:10px;align-items:center"
        >
          <span style="min-width:64px;font-weight:600;flex-shrink:0">{{ p.storeName }}</span>
          <span :style="{ color: p.status === 'done' ? '#2e7d32' : p.status === 'error' ? '#c62828' : '#666', flex:1, wordBreak:'break-all' }">
            {{ fmtProgress(p) }}
          </span>
        </div>
      </div>
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
        <option value="price_sent">准备出售</option>
        <option value="variant_wait">未创建</option>
        <option value="new">新建</option>
        <option value="unmatched">未匹配</option>
        <option value="moderated">已审核</option>
        <option value="offer_validated">报价已验证</option>
        <option value="published">已发布</option>
        <option value="imported">已导入</option>
        <option value="ready_to_publish">待发布</option>
        <option value="pending">待处理</option>
        <option value="pending_moderation">待审核</option>
        <option value="moderating">审核中</option>
        <option value="failed_validation">校验失败</option>
        <option value="failed">失败</option>
        <option value="removed">已下架</option>
      </select>
      <select class="filter-select" v-model="state.filters.imageIssue">
        <option value="">全部商品</option>
        <option value="1">仅图片问题</option>
      </select>
      <select class="filter-select" v-model="state.filters.hasStock">
        <option value="">全部库存</option>
        <option value="1">有库存</option>
        <option value="0">无库存</option>
      </select>
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div v-if="selectedSkus.length" style="display:flex;gap:12px;align-items:center;padding:8px 4px">
      <span class="muted">已选 {{ selectedSkus.length }} 个商品</span>
      <button class="btn btn-primary" @click="openBatchRefresh">批量更新图片</button>
      <button class="btn btn-primary" @click="openBatchStock">批量更新库存</button>
    </div>

    <!-- 按当前筛选条件批量操作(不限于当前页) -->
    <div v-if="state.total > 0" style="display:flex;gap:12px;align-items:center;padding:8px 4px">
      <span class="muted">当前筛选匹配 {{ state.total }} 个商品</span>
      <button class="btn btn-ghost" :disabled="!!filterBatchLoading" @click="openFilteredRefresh">
        {{ filterBatchLoading === 'image' ? '拉取中...' : '按筛选更新图片' }}
      </button>
      <button class="btn btn-ghost" :disabled="!!filterBatchLoading" @click="openFilteredStock">
        {{ filterBatchLoading === 'stock' ? '拉取中...' : '按筛选更新库存' }}
      </button>
    </div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:32px"><input type="checkbox" :checked="allSelected" @change="toggleSelectAll" /></th>
            <th>SKU</th>
            <th style="width:140px">Offer ID</th>
            <th style="width:140px">名称</th>
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
            <td colspan="10" class="muted" style="padding: 24px; text-align: center">加载中...</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="10" class="empty">暂无商品数据(插件查询过的商品会自动缓存到这里)</td>
          </tr>
          <tr v-for="it in state.items" :key="it.sku">
            <td><input type="checkbox" :checked="isSelected(it.sku)" @change="toggleSelect(it.sku)" /></td>
            <td>{{ it.sku }}</td>
            <td>{{ it.offerId || '—' }}</td>
            <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="it.name">{{ it.name || '—' }}</td>
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
              <button v-if="it.productId" class="btn btn-sm btn-ghost" @click="openSingleRefresh(it)">更新图片</button>
              <button v-if="it.productId" class="btn btn-sm btn-ghost" @click="openSingleStock(it)">更新库存</button>
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
        <div v-if="detail.productId" style="margin-top:12px;text-align:right">
          <button class="btn btn-primary" @click="openSingleRefresh({ productId: detail.productId, storeId: detail.storeId, sku: detail.sku })">
            更新图片
          </button>
          <button class="btn btn-primary" @click="openSingleStock({ productId: detail.productId, storeId: detail.storeId, offerId: detail.data?.offer_id })">
            更新库存
          </button>
        </div>
      </template>
      <div v-else class="empty">无数据</div>
    </AppModal>

    <!-- 图片更新弹窗 -->
    <ImageRefreshDialog
      v-model:open="refreshDialog.open"
      :mode="refreshDialog.mode"
      :single-item="refreshDialog.singleItem"
      :selected-products="refreshDialog.selectedProducts"
    />

    <!-- 库存更新弹窗 -->
    <StockRefreshDialog
      v-model:open="stockDialog.open"
      :mode="stockDialog.mode"
      :single-item="stockDialog.singleItem"
      :selected-products="stockDialog.selectedProducts"
    />
  </div>
</template>
