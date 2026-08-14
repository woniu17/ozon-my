<script setup>
// 商品归档任务详情页(2026-08)
// 路由:/product-archive/:localTaskId
// 功能:任务概要 + items 表(商品 ID/SKU/状态/错误) + 重试 + 自动轮询
// 注:OPI /v1/product/archive 响应只返回整体布尔,整批失败时所有 item 共享相同错误信息
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getProductArchiveDetail, retryProductArchiveItem } from '../api/productArchive.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';

const route = useRoute();
const router = useRouter();
const storesStore = useStoresStore();
const { show } = useToast();

const localTaskId = computed(() => String(route.params.localTaskId || ''));

const state = ref({
  loading: true,
  detail: null,
  error: '',
  retryingId: '',
  activeStore: '', // '' = 全部,跨店铺时按店铺筛选 items
});
let pollTimer = null;

// 是否跨店铺任务(items 来自多个店铺)
const isMultiStore = computed(() => {
  const items = state.value.detail?.items || [];
  const set = new Set(items.map((it) => it.storeId));
  return set.size > 1;
});

// 按店铺分组统计:[{ storeId, storeName, total, success, failed }]
const storeGroups = computed(() => {
  const items = state.value.detail?.items || [];
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.storeId)) {
      map.set(it.storeId, { storeId: it.storeId, storeName: storeName(it.storeId), total: 0, success: 0, failed: 0 });
    }
    const g = map.get(it.storeId);
    g.total++;
    if (it.status === 'SUCCESS') g.success++;
    else if (it.status === 'FAILED') g.failed++;
  }
  return Array.from(map.values());
});

// 按 activeStore 筛选后的 items
const filteredItems = computed(() => {
  const items = state.value.detail?.items || [];
  if (!state.value.activeStore) return items;
  return items.filter((it) => it.storeId === state.value.activeStore);
});

async function loadDetail(silent = false) {
  if (!silent) state.value.loading = true;
  state.value.error = '';
  try {
    const r = await getProductArchiveDetail(localTaskId.value);
    state.value.detail = r || null;
    schedulePolling();
  } catch (err) {
    state.value.error = err.message || String(err);
    if (!silent) state.value.detail = null;
  } finally {
    if (!silent) state.value.loading = false;
  }
}

// RUNNING/PENDING 时每 3s 轮询
function schedulePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const st = state.value.detail?.task?.status;
  if (st === 'RUNNING' || st === 'PENDING') {
    pollTimer = setInterval(() => {
      if (!state.value.retryingId) {
        loadDetail(true);
      }
    }, 3000);
  }
}

async function retryItem(item) {
  state.value.retryingId = item.id;
  try {
    await retryProductArchiveItem(localTaskId.value, item.id);
    show('已重新加入队列', 'success');
    await loadDetail(true);
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    state.value.retryingId = '';
  }
}

const STATUS_MAP = {
  PENDING: { cls: 'badge-pending', label: '待处理' },
  PROCESSING: { cls: 'badge-processing', label: '处理中' },
  SUCCESS: { cls: 'badge-success', label: '成功' },
  FAILED: { cls: 'badge-failed', label: '失败' },
  PARTIAL: { cls: 'badge-processing', label: '部分成功' },
  RUNNING: { cls: 'badge-processing', label: '运行中' },
};
function statusInfo(st) {
  return STATUS_MAP[st] || { cls: 'badge-pending', label: st || '—' };
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
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function storeName(storeId) {
  const s = storesStore.list.find((x) => x.id === storeId);
  return s?.name || storeId || '—';
}

onMounted(() => {
  storesStore.load();
  loadDetail();
});
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>商品归档详情</h2>
      <button class="btn btn-ghost" @click="router.back()">返回</button>
    </div>

    <div v-if="state.loading" class="empty">加载中…</div>
    <div v-else-if="state.error" class="empty">加载失败:{{ state.error }}</div>
    <template v-else-if="state.detail">
      <!-- 任务概要 -->
      <div class="pa-summary">
        <div class="meta-row"><span class="meta-k">任务 ID</span><span class="meta-v">{{ state.detail.task.localTaskId }}</span></div>
        <div class="meta-row">
          <span class="meta-k">店铺</span>
          <span class="meta-v">
            <span v-if="isMultiStore" style="color:#1890ff;font-weight:600">多个 ({{ storeGroups.length }} 个店铺)</span>
            <span v-else>{{ storeName(state.detail.task.storeId) }}</span>
          </span>
        </div>
        <div class="meta-row"><span class="meta-k">来源</span><span class="meta-v">{{ state.detail.task.sourceType || '—' }}</span></div>
        <div class="meta-row"><span class="meta-k">状态</span><span class="meta-v"><span class="badge" :class="statusInfo(state.detail.task.status).cls">{{ statusInfo(state.detail.task.status).label }}</span></span></div>
        <div class="meta-row"><span class="meta-k">总计</span><span class="meta-v">{{ state.detail.task.totalCount }}</span></div>
        <div class="meta-row"><span class="meta-k">成功</span><span class="meta-v" style="color:#52c41a">{{ state.detail.task.successCount }}</span></div>
        <div class="meta-row"><span class="meta-k">失败</span><span class="meta-v" style="color:#ff4d4f">{{ state.detail.task.failedCount }}</span></div>
        <div class="meta-row"><span class="meta-k">创建时间</span><span class="meta-v">{{ fmtTime(state.detail.task.createdAt) }}</span></div>
        <div class="meta-row"><span class="meta-k">完成时间</span><span class="meta-v">{{ fmtTime(state.detail.task.completedAt) }}</span></div>
      </div>

      <!-- 跨店铺:店铺筛选 tab + 各店铺统计 -->
      <div v-if="isMultiStore" class="store-tabs">
        <button
          class="store-tab"
          :class="{ active: !state.activeStore }"
          @click="state.activeStore = ''"
        >
          全部 ({{ state.detail.items.length }})
        </button>
        <button
          v-for="g in storeGroups"
          :key="g.storeId"
          class="store-tab"
          :class="{ active: state.activeStore === g.storeId }"
          @click="state.activeStore = g.storeId"
        >
          {{ g.storeName }} ({{ g.total }})
          <span v-if="g.failed" style="color:#ff4d4f">·失败{{ g.failed }}</span>
          <span v-else-if="g.success === g.total" style="color:#52c41a">·全成功</span>
        </button>
      </div>

      <!-- items 表 -->
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th v-if="isMultiStore">店铺</th>
              <th>商品 ID</th>
              <th>SKU</th>
              <th>状态</th>
              <th>错误信息</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!filteredItems.length">
              <td :colspan="isMultiStore ? 6 : 5" class="muted" style="padding:16px;text-align:center">无明细数据</td>
            </tr>
            <tr v-for="it in filteredItems" :key="it.id">
              <td v-if="isMultiStore" style="font-size:12px;color:#666">{{ storeName(it.storeId) }}</td>
              <td>{{ it.productId }}</td>
              <td>{{ it.offerId || '—' }}</td>
              <td><span class="badge" :class="statusInfo(it.status).cls">{{ statusInfo(it.status).label }}</span></td>
              <td>
                <span v-if="it.errorMessage" style="color:#ff4d4f">{{ it.errorMessage }}</span>
                <span v-else style="color:#52c41a">无错误</span>
              </td>
              <td>
                <button
                  v-if="it.status === 'FAILED'"
                  class="btn btn-sm btn-ghost"
                  :disabled="state.retryingId === it.id"
                  @click="retryItem(it)"
                >
                  {{ state.retryingId === it.id ? '...' : '重试' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <div v-else class="empty">无数据</div>
  </div>
</template>

<style scoped>
.pa-summary {
  background: #f7f8fa;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 16px;
}
.store-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.store-tab {
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  white-space: nowrap;
}
.store-tab:hover {
  border-color: #1890ff;
  color: #1890ff;
}
.store-tab.active {
  background: #1890ff;
  border-color: #1890ff;
  color: #fff;
}
.meta-row {
  display: flex;
  gap: 8px;
  font-size: 13px;
  line-height: 1.8;
}
.meta-k {
  color: #888;
  min-width: 72px;
}
.meta-v {
  color: #333;
  word-break: break-all;
}
.muted {
  color: #999;
  font-size: 12px;
}
</style>
