<script setup>
// 批量上架 · 批次列表页(新版 batch-upload 两阶段系统)
// 点击"查看详情"跳转到 BatchUploadDetail.vue(与创建批次后进入的详情页一致)
import { reactive, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { getBatchUploadList } from '../api/batch-upload.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

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
    status: '',
    keyword: '',
  },
});

async function loadList() {
  state.loading = true;
  try {
    const data = await getBatchUploadList({
      currentPage: state.page,
      pageSize: state.pageSize,
      status: state.filters.status,
      keyword: state.filters.keyword.trim(),
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

// 跳转到批次详情页(与创建时进入的页面一致)
function openDetail(batchNo) {
  router.push('/batch-upload/' + encodeURIComponent(batchNo));
}

// ── 渲染辅助 ───────────────────────────────────────────────
function storeNames(storeIds) {
  const ids = Array.isArray(storeIds) ? storeIds : [storeIds].filter(Boolean);
  if (!ids.length) return '—';
  return ids.map((id) => storesStore.list.find((x) => x.id === id)?.name || id).join(', ');
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

// 批次级状态徽章(与 BatchUploadDetail.vue 一致)
const STATUS_BADGE = {
  PENDING: { cls: 'badge-pending', label: '待处理' },
  RUNNING: { cls: 'badge-processing', label: '进行中' },
  PAUSED: { cls: 'badge-pending', label: '已暂停' },
  SUCCESS: { cls: 'badge-success', label: '成功' },
  FAILED: { cls: 'badge-failed', label: '失败' },
  PARTIAL: { cls: 'badge-processing', label: '部分成功' },
  CANCELLED: { cls: 'badge-failed', label: '已取消' },
};

function statusInfo(st) {
  if (!st) return { cls: 'badge-pending', label: '—' };
  return STATUS_BADGE[st] || STATUS_BADGE[String(st).toUpperCase()] || { cls: 'badge-pending', label: st };
}

onMounted(() => {
  storesStore.load();
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>批量上架</h2>
      <button class="btn btn-ghost" :disabled="state.loading" @click="loadList">
        {{ state.loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div class="filter-bar">
      <select class="filter-select" v-model="state.filters.status">
        <option value="">全部状态</option>
        <option value="RUNNING">进行中</option>
        <option value="PAUSED">已暂停</option>
        <option value="SUCCESS">成功</option>
        <option value="PARTIAL">部分成功</option>
        <option value="FAILED">失败</option>
        <option value="CANCELLED">已取消</option>
        <option value="PENDING">待处理</option>
      </select>
      <input
        class="filter-input"
        type="text"
        v-model.trim="state.filters.keyword"
        placeholder="搜索批次号 / 名称"
        @keydown.enter="search"
      />
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>名称</th>
            <th>目标店铺</th>
            <th>总数</th>
            <th>成功/失败/跳过</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="8" class="muted" style="padding: 24px; text-align: center">加载中…</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="8" class="empty">暂无批量上架批次</td>
          </tr>
          <tr v-for="t in state.items" :key="t.batchNo">
            <td>{{ t.batchNo }}</td>
            <td>{{ t.name || '—' }}</td>
            <td>{{ storeNames(t.storeIds) }}</td>
            <td>{{ t.totalCount ?? 0 }}</td>
            <td>{{ t.successCount ?? 0 }} / {{ t.failedCount ?? 0 }} / {{ t.skippedCount ?? 0 }}</td>
            <td>
              <span class="badge" :class="statusInfo(t.status).cls">{{ statusInfo(t.status).label }}</span>
            </td>
            <td>{{ fmtTime(t.createdAt) }}</td>
            <td>
              <button class="btn btn-sm btn-ghost" @click="openDetail(t.batchNo)">查看详情</button>
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
