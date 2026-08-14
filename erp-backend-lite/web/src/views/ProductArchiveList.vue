<script setup>
// 商品归档任务列表页(2026-08)
// 展示所有 product_archive_tasks,点击查看详情跳转到 ProductArchiveDetail.vue
import { reactive, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { getProductArchiveList } from '../api/productArchive.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

const router = useRouter();
const storesStore = useStoresStore();
const { show } = useToast();

const state = reactive({
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 20,
  filters: {
    storeId: '',
    status: '',
  },
});

async function loadList() {
  state.loading = true;
  try {
    const data = await getProductArchiveList({
      currentPage: state.page,
      pageSize: state.pageSize,
      storeId: state.filters.storeId,
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

function search() {
  state.page = 1;
  loadList();
}

function onPageChange(p) {
  state.page = p;
  loadList();
}

function openDetail(localTaskId) {
  router.push('/product-archive/' + encodeURIComponent(localTaskId));
}

function storeName(storeId) {
  const s = storesStore.list.find((x) => x.id === storeId);
  return s?.name || storeId || '—';
}

function fmtTime(t) {
  if (!t) return '—';
  const s = String(t).trim();
  if (!s) return '—';
  let d;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    d = new Date(s);
  } else {
    d = new Date(s.replace(' ', 'T') + 'Z');
  }
  if (isNaN(d.getTime())) return s;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes()) + ':' +
    pad(d.getSeconds())
  );
}

const STATUS_BADGE = {
  PENDING: { cls: 'badge-pending', label: '待处理' },
  RUNNING: { cls: 'badge-processing', label: '进行中' },
  SUCCESS: { cls: 'badge-success', label: '成功' },
  FAILED: { cls: 'badge-failed', label: '失败' },
  PARTIAL: { cls: 'badge-processing', label: '部分成功' },
};

function statusInfo(st) {
  if (!st) return { cls: 'badge-pending', label: '—' };
  return STATUS_BADGE[st] || { cls: 'badge-pending', label: st };
}

const SOURCE_TYPE_LABEL = {
  manual: '手动',
  batch: '批量勾选',
  filter: '按筛选',
};

onMounted(() => {
  storesStore.load();
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>商品归档任务</h2>
      <button class="btn btn-ghost" :disabled="state.loading" @click="loadList">
        {{ state.loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div class="filter-bar">
      <select class="filter-select" v-model="state.filters.storeId">
        <option value="">全部店铺</option>
        <option v-for="s in storesStore.list" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <select class="filter-select" v-model="state.filters.status">
        <option value="">全部状态</option>
        <option value="PENDING">待处理</option>
        <option value="RUNNING">进行中</option>
        <option value="SUCCESS">成功</option>
        <option value="PARTIAL">部分成功</option>
        <option value="FAILED">失败</option>
      </select>
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>任务ID</th>
            <th>店铺</th>
            <th>来源</th>
            <th>总数</th>
            <th>成功/失败</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>完成时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="9" class="muted" style="padding: 24px; text-align: center">加载中…</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="9" class="empty">暂无归档任务</td>
          </tr>
          <tr v-for="t in state.items" :key="t.localTaskId">
            <td :title="t.localTaskId" style="font-family: monospace; font-size: 12px">
              {{ t.localTaskId.slice(0, 24) }}…
            </td>
            <td>
              <span v-if="t.storeIds && t.storeIds.length > 1" :title="t.storeIds.map(storeName).join(', ')" style="color:#1890ff;font-weight:600">多店铺 ({{ t.storeIds.length }})</span>
              <span v-else>{{ storeName(t.storeId) }}</span>
            </td>
            <td>{{ SOURCE_TYPE_LABEL[t.sourceType] || t.sourceType || '—' }}</td>
            <td>{{ t.totalCount ?? 0 }}</td>
            <td>{{ t.successCount ?? 0 }} / {{ t.failedCount ?? 0 }}</td>
            <td>
              <span class="badge" :class="statusInfo(t.status).cls">{{ statusInfo(t.status).label }}</span>
            </td>
            <td>{{ fmtTime(t.createdAt) }}</td>
            <td>{{ fmtTime(t.completedAt) }}</td>
            <td>
              <button class="btn btn-sm btn-ghost" @click="openDetail(t.localTaskId)">查看详情</button>
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
  </div>
</template>
