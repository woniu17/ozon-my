<script setup>
// 商品信息更新任务详情页(2026-07)
// 路由:/product-update/:localTaskId
// 功能:任务概要 + items 表(状态 + 新旧值对比 + errors) + 重试 + 取消 + 自动轮询
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  getProductUpdateDetail,
  retryProductUpdateItem,
  cancelProductUpdate,
} from '../api/productUpdate.js';
import { useStoresStore } from '../stores/stores.js';
import { useConfirmStore } from '../stores/confirm.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

const route = useRoute();
const router = useRouter();
const storesStore = useStoresStore();
const confirmStore = useConfirmStore();
const { show } = useToast();

const localTaskId = computed(() => String(route.params.localTaskId || ''));

const state = ref({
  loading: true,
  detail: null,
  error: '',
  retryingId: '',
  cancelling: false,
});
const page = ref(1);
const pageSize = ref(50);
let pollTimer = null;

async function loadDetail(silent = false) {
  if (!silent) state.value.loading = true;
  state.value.error = '';
  try {
    const r = await getProductUpdateDetail(localTaskId.value, { page: page.value, pageSize: pageSize.value });
    state.value.detail = r || null;
    schedulePolling();
  } catch (err) {
    state.value.error = err.message || String(err);
    if (!silent) state.value.detail = null;
  } finally {
    if (!silent) state.value.loading = false;
  }
}

function onPageChange(p) {
  page.value = p;
  loadDetail();
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
      if (!state.value.retryingId && !state.value.cancelling) {
        loadDetail(true);
      }
    }, 3000);
  }
}

async function retryItem(item) {
  state.value.retryingId = item.id;
  try {
    await retryProductUpdateItem(localTaskId.value, item.id);
    show('已重新加入队列', 'success');
    await loadDetail(true);
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    state.value.retryingId = '';
  }
}

async function cancelTask() {
  if (state.value.cancelling) return;
  if (!(await confirmStore.ask({ message: '确认取消未处理的 items?已完成的 items 不受影响。' }))) return;
  state.value.cancelling = true;
  try {
    const r = await cancelProductUpdate(localTaskId.value);
    show(`已取消 ${r.cancelled} 个未处理 item,任务状态:${r.status}`, 'success');
    await loadDetail(true);
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    state.value.cancelling = false;
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
  return (
    d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes()) + ':' +
    pad(d.getSeconds())
  );
}

function storeName(storeId) {
  const s = storesStore.list.find((x) => x.id === storeId);
  return s?.name || storeId || '—';
}

// 字段键 → 中文标签
const FIELD_LABEL = {
  name: '标题',
  description: '描述',
  price: '价格',
  old_price: '划线价',
  weight: '重量',
  dimensions: '尺寸',
  primary_image: '主图',
  images: '图片',
};
function fieldLabel(f) {
  return FIELD_LABEL[f] || f;
}

// 截断长文本(用于展示)
function truncate(s, max = 80) {
  if (!s) return '';
  const str = String(s);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// opi_result 中的 errors 拼接展示
function opiErrors(item) {
  if (item.errorMessage) return item.errorMessage;
  const r = item.opiResult;
  if (!r) return '';
  const errs = r.errors || [];
  if (!errs.length) return '';
  return errs.map((e) => e.message || e.code || e.description || JSON.stringify(e)).join('; ');
}

// 是否可取消(任务未终态,且 total > success+failed 表示还有未处理 items)
const canCancel = computed(() => {
  const task = state.value.detail?.task;
  if (!task) return false;
  if (['SUCCESS', 'FAILED', 'PARTIAL'].includes(task.status)) return false;
  return task.totalCount > (task.successCount || 0) + (task.failedCount || 0);
});

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
      <h2>商品信息更新详情</h2>
      <div style="display: flex; gap: 8px">
        <button
          v-if="canCancel"
          class="btn btn-ghost"
          :disabled="state.cancelling"
          @click="cancelTask"
        >
          {{ state.cancelling ? '取消中…' : '取消未处理' }}
        </button>
        <button class="btn btn-ghost" @click="router.back()">返回</button>
      </div>
    </div>

    <div v-if="state.loading" class="empty">加载中…</div>
    <div v-else-if="state.error" class="empty">加载失败:{{ state.error }}</div>
    <template v-else-if="state.detail">
      <!-- 任务概要 -->
      <div class="pu-summary">
        <div class="meta-row"><span class="meta-k">任务 ID</span><span class="meta-v">{{ state.detail.task.localTaskId }}</span></div>
        <div class="meta-row"><span class="meta-k">店铺</span><span class="meta-v">{{ storeName(state.detail.task.storeId) }}</span></div>
        <div class="meta-row"><span class="meta-k">状态</span><span class="meta-v"><span class="badge" :class="statusInfo(state.detail.task.status).cls">{{ statusInfo(state.detail.task.status).label }}</span></span></div>
        <div class="meta-row">
          <span class="meta-k">更新字段</span>
          <span class="meta-v">
            <span v-for="f in state.detail.task.updateFields" :key="f" class="field-chip">{{ fieldLabel(f) }}</span>
          </span>
        </div>
        <div class="meta-row"><span class="meta-k">总计</span><span class="meta-v">{{ state.detail.task.totalCount }}</span></div>
        <div class="meta-row"><span class="meta-k">成功</span><span class="meta-v" style="color:#52c41a">{{ state.detail.task.successCount }}</span></div>
        <div class="meta-row"><span class="meta-k">失败</span><span class="meta-v" style="color:#ff4d4f">{{ state.detail.task.failedCount }}</span></div>
        <div class="meta-row"><span class="meta-k">创建时间</span><span class="meta-v">{{ fmtTime(state.detail.task.createdAt) }}</span></div>
        <div class="meta-row"><span class="meta-k">完成时间</span><span class="meta-v">{{ fmtTime(state.detail.task.completedAt) }}</span></div>
      </div>

      <!-- items 表 -->
      <div class="listings-table-wrap">
        <table class="listings-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>状态</th>
              <th>更新字段</th>
              <th>新值预览</th>
              <th>错误信息</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!state.detail.items.length">
              <td colspan="6" class="muted" style="padding:16px;text-align:center">无明细数据</td>
            </tr>
            <tr v-for="it in state.detail.items" :key="it.id">
              <td style="font-family: monospace; font-size: 12px">{{ it.offerId || '—' }}</td>
              <td><span class="badge" :class="statusInfo(it.status).cls">{{ statusInfo(it.status).label }}</span></td>
              <td>
                <span v-for="f in it.updateFields" :key="f" class="field-chip">{{ fieldLabel(f) }}</span>
              </td>
              <td>
                <div v-for="f in it.updateFields" :key="f" class="value-row">
                  <span class="value-label">{{ fieldLabel(f) }}:</span>
                  <span class="value-text" :title="it.newValues[f]">{{ truncate(it.newValues[f]) }}</span>
                </div>
              </td>
              <td>
                <span v-if="opiErrors(it)" style="color:#ff4d4f">{{ truncate(opiErrors(it), 120) }}</span>
                <span v-else style="color:#52c41a">无错误</span>
              </td>
              <td class="col-actions">
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

      <AppPager
        :modelValue="page"
        :total="state.detail.total || 0"
        :pageSize="pageSize"
        @update:modelValue="onPageChange"
      />
    </template>
    <div v-else class="empty">无数据</div>
  </div>
</template>

<style scoped>
.pu-summary {
  background: #f7f8fa;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 16px;
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
.field-chip {
  display: inline-block;
  padding: 1px 6px;
  margin-right: 4px;
  font-size: 11px;
  background: #e6f7ff;
  color: #1890ff;
  border-radius: 3px;
  white-space: nowrap;
}
.value-row {
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 2px;
}
.value-label {
  color: #888;
  margin-right: 4px;
}
.value-text {
  color: #333;
  word-break: break-all;
}
.muted {
  color: #999;
  font-size: 12px;
}
</style>
