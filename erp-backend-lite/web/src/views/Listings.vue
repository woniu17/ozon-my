<script setup>
import { ref, reactive, onMounted } from 'vue';
import { getListings } from '../api/listings.js';
import { get } from '../api/request.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';

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
    dateFrom: '',
    dateTo: '',
  },
});

async function loadListings() {
  state.loading = true;
  try {
    const data = await getListings({
      currentPage: state.page,
      pageSize: state.pageSize,
      storeId: state.filters.storeId,
      keyword: state.filters.keyword.trim(),
      status: state.filters.status,
      dateFrom: state.filters.dateFrom,
      dateTo: state.filters.dateTo,
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
  loadListings();
}

// 翻页:先更新页码再加载,确保读取最新 page
function onPageChange(p) {
  state.page = p;
  loadListings();
}

// ── 详情弹窗 ───────────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailTask = ref(null);
const detailItems = ref([]);

async function openDetail(localTaskId) {
  detailOpen.value = true;
  detailLoading.value = true;
  detailTask.value = null;
  detailItems.value = [];
  try {
    const data = await get('/admin/api/listing-records/' + encodeURIComponent(localTaskId));
    detailTask.value = data?.task || null;
    detailItems.value = data?.items || [];
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

const STATUS_MAP = {
  SUCCESS: { cls: 'badge-success', label: '成功' },
  FAILED: { cls: 'badge-failed', label: '失败' },
  PROCESSING: { cls: 'badge-processing', label: '处理中' },
  PENDING: { cls: 'badge-pending', label: '待处理' },
};
function statusInfo(st) {
  return STATUS_MAP[st] || { cls: 'badge-pending', label: st || '—' };
}

function fmtTime(t) {
  if (!t) return '—';
  return String(t).replace('T', ' ').slice(0, 19);
}

// 列表行:成功/失败计数(summary 可能为 null)
function resultText(r) {
  const s = r.summary || { imported: 0, failed: 0 };
  return `✓${s.imported || 0} ✗${s.failed || 0}`;
}

// 详情:从 items 数组按状态计数(成功/失败)
function countByStatus(items, st) {
  return (items || []).filter((i) => String(i.status) === st).length;
}

const ITEM_STATUS_LABEL = {
  imported: '已创建',
  failed: '失败',
  pending: '处理中',
  skipped: '跳过',
};
function itemStatusLabel(st) {
  return ITEM_STATUS_LABEL[st] || st || '—';
}

// 商品错误信息拼接(对齐原 admin.js renderListingDetailItems)
function itemErrorText(it) {
  const errs = it.errors || [];
  if (!errs.length) return '';
  return errs
    .map(
      (e) =>
        `${e.message || e.description || e.code || ''}${e.field ? ` [${e.field}]` : ''}${e.attribute_name ? ` (${e.attribute_name})` : ''}`
    )
    .filter(Boolean)
    .join('; ');
}

onMounted(() => {
  storesStore.load();
  loadListings();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>上架记录</h2>
      <button class="btn btn-ghost" :disabled="state.loading" @click="loadListings">
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
        placeholder="搜索任务ID / Ozon Task ID"
        @keydown.enter="search"
      />
      <select class="filter-select" v-model="state.filters.status">
        <option value="">全部状态</option>
        <option value="SUCCESS">成功</option>
        <option value="FAILED">失败</option>
        <option value="PROCESSING">处理中</option>
      </select>
      <input class="filter-input" type="date" v-model="state.filters.dateFrom" />
      <span class="muted">至</span>
      <input class="filter-input" type="date" v-model="state.filters.dateTo" />
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="listings-table-wrap">
      <table class="listings-table">
        <thead>
          <tr>
            <th class="col-task">任务ID</th>
            <th class="col-store">店铺</th>
            <th>SKU 数</th>
            <th>成功/失败</th>
            <th>状态</th>
            <th class="col-time">创建时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="7" class="muted" style="padding: 24px; text-align: center">加载中...</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="7" class="muted" style="padding: 24px; text-align: center">暂无上架记录</td>
          </tr>
          <tr v-for="r in state.items" :key="r.localTaskId">
            <td class="col-task" :title="r.localTaskId">{{ r.localTaskId }}</td>
            <td class="col-store">{{ storeName(r.storeId) }}</td>
            <td>{{ r.itemsCount }}</td>
            <td class="col-result">{{ resultText(r) }}</td>
            <td>
              <span class="badge" :class="statusInfo(r.status).cls">{{ statusInfo(r.status).label }}</span>
            </td>
            <td class="col-time">{{ fmtTime(r.createdAt) }}</td>
            <td class="col-actions">
              <button class="btn btn-sm btn-ghost" @click="openDetail(r.localTaskId)">查看详情</button>
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
    <AppModal :open="detailOpen" title="上架记录详情" size="lg" @update:open="detailOpen = $event">
      <div v-if="detailLoading" class="empty">加载中...</div>
      <template v-else-if="detailTask">
        <div class="listing-detail-meta">
          <div class="meta-row">
            <span class="meta-k">任务 ID</span><span class="meta-v">{{ detailTask.localTaskId }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">店铺</span><span class="meta-v">{{ storeName(detailTask.storeId) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">创建时间</span><span class="meta-v">{{ fmtTime(detailTask.createdAt) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">完成时间</span><span class="meta-v">{{ fmtTime(detailTask.completedAt) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">状态</span>
            <span class="meta-v">
              <span class="badge" :class="statusInfo(detailTask.status).cls">{{
                statusInfo(detailTask.status).label
              }}</span>
            </span>
          </div>
          <div class="meta-row">
            <span class="meta-k">总计</span><span class="meta-v">{{ detailTask.itemsCount }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">成功</span><span class="meta-v">{{ countByStatus(detailItems, 'imported') }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">失败</span><span class="meta-v">{{ countByStatus(detailItems, 'failed') }}</span>
          </div>
        </div>

        <h3 style="margin: 16px 0 8px">商品明细</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>状态</th>
              <th>错误信息</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!detailItems.length">
              <td colspan="3" class="muted" style="padding: 16px; text-align: center">
                无明细数据(可能任务尚未完成或未上报)
              </td>
            </tr>
            <tr v-for="(it, idx) in detailItems" :key="idx">
              <td class="col-task">{{ it.offerId || '—' }}</td>
              <td>
                <span class="item-status" :class="it.status">{{ itemStatusLabel(it.status) }}</span>
              </td>
              <td>
                <span v-if="itemErrorText(it)">{{ itemErrorText(it) }}</span>
                <span v-else style="color: #52c41a">无错误</span>
              </td>
            </tr>
          </tbody>
        </table>
      </template>
      <div v-else class="empty">无数据</div>
    </AppModal>
  </div>
</template>
