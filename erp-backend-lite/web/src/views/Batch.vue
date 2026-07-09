<script setup>
import { ref, reactive, onMounted } from 'vue';
import { getBatchTasks, getBatchTaskDetail } from '../api/batch.js';
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
    status: '',
    keyword: '',
  },
});

async function loadList() {
  state.loading = true;
  try {
    const data = await getBatchTasks({
      currentPage: state.page,
      pageSize: state.pageSize,
      storeId: state.filters.storeId,
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
const detail = ref(null);

async function openDetail(localTaskId) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    const data = await getBatchTaskDetail(localTaskId);
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

// 任务级状态徽章(兼容大小写)
const STATUS_BADGE = {
  PENDING: { cls: 'badge-pending', label: '待处理' },
  RUNNING: { cls: 'badge-processing', label: '进行中' },
  SUCCESS: { cls: 'badge-success', label: '成功' },
  PARTIAL: { cls: 'badge-processing', label: '部分成功' },
  FAILED: { cls: 'badge-failed', label: '失败' },
};

function statusInfo(st) {
  if (!st) return { cls: 'badge-pending', label: '—' };
  return STATUS_BADGE[st] || STATUS_BADGE[String(st).toUpperCase()] || { cls: 'badge-pending', label: st };
}

// 商品级明细状态徽章(SUCCESS/FAILED)
function itemStatusInfo(st) {
  const s = String(st || '').toUpperCase();
  if (s === 'SUCCESS') return { cls: 'badge-success', label: '成功' };
  if (s === 'FAILED') return { cls: 'badge-failed', label: '失败' };
  return { cls: 'badge-pending', label: st || '—' };
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
      <select class="filter-select" v-model="state.filters.status">
        <option value="">全部状态</option>
        <option value="processing">进行中</option>
        <option value="success">成功</option>
        <option value="failed">失败</option>
        <option value="pending">待处理</option>
      </select>
      <input
        class="filter-input"
        type="text"
        v-model.trim="state.filters.keyword"
        placeholder="搜索任务 ID / SKU"
        @keydown.enter="search"
      />
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>任务ID</th>
            <th>店铺</th>
            <th>SKU 数</th>
            <th>成功/失败</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="7" class="muted" style="padding: 24px; text-align: center">加载中...</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="7" class="empty">暂无批量上架任务</td>
          </tr>
          <tr v-for="t in state.items" :key="t.localTaskId">
            <td>{{ t.localTaskId }}</td>
            <td>{{ storeName(t.storeId) }}</td>
            <td>{{ t.totalCount ?? 0 }}</td>
            <td>{{ t.successCount ?? 0 }} / {{ t.failedCount ?? 0 }}</td>
            <td>
              <span class="badge" :class="statusInfo(t.status).cls">{{ statusInfo(t.status).label }}</span>
            </td>
            <td>{{ fmtTime(t.createdAt) }}</td>
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

    <!-- 详情弹窗 -->
    <AppModal
      :open="detailOpen"
      title="批量任务详情"
      size="lg"
      @update:open="detailOpen = $event"
    >
      <div v-if="detailLoading" class="empty">加载中...</div>
      <template v-else-if="detail">
        <div class="batch-detail-head">
          <div><b>任务ID:</b> {{ detail.localTaskId }}</div>
          <div><b>店铺:</b> {{ storeName(detail.storeId) }}</div>
          <div><b>状态:</b>
            <span class="badge" :class="statusInfo(detail.status).cls">{{ statusInfo(detail.status).label }}</span>
          </div>
          <div><b>总计:</b> {{ detail.totalCount ?? 0 }}</div>
          <div><b>成功:</b> {{ detail.successCount ?? 0 }}</div>
          <div><b>失败:</b> {{ detail.failedCount ?? 0 }}</div>
          <div><b>创建:</b> {{ fmtTime(detail.createdAt) }}</div>
          <div><b>完成:</b> {{ fmtTime(detail.completedAt) }}</div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>状态</th>
              <th>错误信息</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!detail.items || !detail.items.length">
              <td colspan="3" class="muted" style="text-align: center">无明细</td>
            </tr>
            <tr v-for="(it, idx) in (detail.items || [])" :key="idx">
              <td>{{ it.sourceSku || '—' }}</td>
              <td>
                <span class="badge" :class="itemStatusInfo(it.status).cls">{{ itemStatusInfo(it.status).label }}</span>
              </td>
              <td>{{ it.errorMessage || it.followTaskId || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </template>
      <div v-else class="empty">无数据</div>
    </AppModal>
  </div>
</template>
