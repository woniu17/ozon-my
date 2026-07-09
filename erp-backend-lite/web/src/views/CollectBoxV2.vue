<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { getCollectBoxV2, getCollectBoxV2Detail, deleteCollectBoxV2 } from '../api/collect-box-v2.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import CollectBoxV2Detail from './CollectBoxV2Detail.vue';

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
    hasVideo: '',
    minVariants: '',
  },
});

async function loadList() {
  state.loading = true;
  try {
    const data = await getCollectBoxV2({
      page: state.page,
      pageSize: state.pageSize,
      storeId: state.filters.storeId,
      keyword: state.filters.keyword.trim(),
      hasVideo: state.filters.hasVideo,
      minVariants: state.filters.minVariants,
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

// 翻页:先更新页码再加载
function onPageChange(p) {
  state.page = p;
  loadList();
}

// ── 详情弹窗 ───────────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailData = ref({});
const detailTitle = computed(() => {
  const d = detailData.value;
  if (!d || !d.id) return '采集详情';
  return `采集详情 #${d.id} · SKU ${d.anchorSku} · ${d.variantCount} 变体`;
});

async function openDetail(it) {
  detailOpen.value = true;
  detailLoading.value = true;
  detailData.value = {};
  try {
    const data = await getCollectBoxV2Detail(it.id, it.sourceTable);
    detailData.value = data || {};
  } catch (err) {
    show(err.message || String(err), 'error');
    detailData.value = {};
  } finally {
    detailLoading.value = false;
  }
}

// ── 删除 ───────────────────────────────────────────────────
async function onRemove(it) {
  if (!confirm(`确认删除采集记录 #${it.id}?`)) return;
  try {
    await deleteCollectBoxV2(it.id, it.sourceTable);
    show('已删除', 'success');
    await loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
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

onMounted(() => {
  storesStore.load();
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>采集箱(全源)</h2>
      <button
        class="btn btn-ghost"
        :disabled="state.loading"
        @click="loadList"
      >{{ state.loading ? '刷新中...' : '刷新' }}</button>
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
        placeholder="搜索 SKU"
        @keydown.enter="search"
      />
      <select class="filter-select" v-model="state.filters.hasVideo">
        <option value="">全部</option>
        <option value="1">有视频</option>
      </select>
      <input
        class="filter-input"
        type="number"
        min="0"
        v-model="state.filters.minVariants"
        placeholder="最少变体数"
        @keydown.enter="search"
      />
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="cb-grid">
      <div v-if="state.loading && !state.items.length" class="empty" style="grid-column:1/-1">
        加载中...
      </div>
      <div v-else-if="!state.items.length" class="empty" style="grid-column:1/-1">
        暂无采集记录
      </div>
      <div v-for="it in state.items" :key="it.id" class="cb-card">
        <div class="cb-thumb">
          <img
            v-if="it.primaryImage"
            :src="it.primaryImage"
            alt=""
            loading="lazy"
            @error="$event.target.style.display = 'none'"
          />
          <div v-else class="cb-no-img">无图</div>
          <span class="cb-badge-v2">全源</span>
        </div>
        <div class="cb-body">
          <div class="cb-title" :title="it.name || it.anchorSku">
            {{ it.name || '(未命名)' }}
          </div>
          <div class="cb-meta">
            <span>SKU: {{ it.anchorSku || '—' }}</span>
            <span v-if="it.price">价格: {{ it.price }}</span>
            <span>店铺: {{ storeName(it.storeId) }}</span>
            <span>变体: {{ it.variantCount ?? 0 }} 个</span>
          </div>
          <div class="cb-foot">
            <span class="cb-time">{{ fmtTime(it.collectedAt || it.createdAt) }}</span>
          </div>
        </div>
        <div class="cb-actions">
          <button class="btn btn-sm btn-ghost" @click="openDetail(it)">详情</button>
          <button class="btn btn-sm btn-danger" @click="onRemove(it)">删除</button>
        </div>
      </div>
    </div>

    <AppPager
      :modelValue="state.page"
      :total="state.total"
      :pageSize="state.pageSize"
      @update:modelValue="onPageChange"
    />

    <!-- 详情弹窗 -->
    <AppModal :open="detailOpen" :title="detailTitle" size="lg" @update:open="detailOpen = $event">
      <p v-if="detailLoading" class="muted">加载中...</p>
      <CollectBoxV2Detail v-else :data="detailData" />
    </AppModal>
  </div>
</template>
