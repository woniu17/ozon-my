<script setup>
// 批量均衡上架 · 批次详情页
// 路由:/batch-upload/:batchNo
// 功能:批次信息 + 操作按钮(暂停/继续/取消)+ 子任务表 + 自动刷新 + 行内 reassign
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  getBatchUploadDetail,
  pauseBatchUpload,
  resumeBatchUpload,
  cancelBatchUpload,
  reassignBatchItem,
} from '../api/batch-upload.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';

const route = useRoute();
const router = useRouter();
const storesStore = useStoresStore();
const { show } = useToast();

const batchNo = computed(() => String(route.params.batchNo || ''));

const state = ref({
  loading: true,
  detail: null,
  error: '',
  actionLoading: '', // 'pause' | 'resume' | 'cancel' | ''(空闲)
  reassigningId: '', // 当前正在 reassign 的子任务 ID
});

let pollTimer = null;

// ── 加载详情 ───────────────────────────────────────────────
async function loadDetail(silent = false) {
  if (!silent) state.value.loading = true;
  state.value.error = '';
  try {
    const r = await getBatchUploadDetail(batchNo.value);
    // request.js 已解 envelope:r 即批次对象 + items
    state.value.detail = r || null;
    schedulePolling();
  } catch (err) {
    state.value.error = err.message || String(err);
    if (!silent) state.value.detail = null;
  } finally {
    if (!silent) state.value.loading = false;
  }
}

// ── 自动轮询(RUNNING/PAUSED 时每 3 秒刷新) ──────────────────
function schedulePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const st = state.value.detail?.status;
  if (st === 'RUNNING' || st === 'PAUSED') {
    pollTimer = setInterval(() => {
      // 静默刷新,不打断用户操作(actionLoading/reassigningId 非空时跳过本次)
      if (!state.value.actionLoading && !state.value.reassigningId) {
        loadDetail(true);
      }
    }, 3000);
  }
}

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});

// ── 操作按钮 ───────────────────────────────────────────────
async function onPause() {
  if (state.value.actionLoading) return;
  state.value.actionLoading = 'pause';
  try {
    await pauseBatchUpload(batchNo.value);
    show('已暂停', 'success');
    await loadDetail(true);
  } catch (err) {
    show(err.message || '暂停失败', 'error');
  } finally {
    state.value.actionLoading = '';
  }
}

async function onResume() {
  if (state.value.actionLoading) return;
  state.value.actionLoading = 'resume';
  try {
    await resumeBatchUpload(batchNo.value);
    show('已继续', 'success');
    await loadDetail(true);
  } catch (err) {
    show(err.message || '继续失败', 'error');
  } finally {
    state.value.actionLoading = '';
  }
}

async function onCancel() {
  if (state.value.actionLoading) return;
  if (!confirm('确认取消该批次?未执行的子任务将被标记为 SKIPPED。')) return;
  state.value.actionLoading = 'cancel';
  try {
    await cancelBatchUpload(batchNo.value);
    show('已取消', 'success');
    await loadDetail(true);
  } catch (err) {
    show(err.message || '取消失败', 'error');
  } finally {
    state.value.actionLoading = '';
  }
}

// ── 行内 reassign(PENDING 子任务) ──────────────────────────
async function onReassign(item, newStoreId) {
  if (!newStoreId || newStoreId === item.targetStoreId) return;
  if (state.value.reassigningId) return;
  state.value.reassigningId = item.id;
  try {
    await reassignBatchItem(batchNo.value, item.id, newStoreId);
    // 本地更新,避免等待轮询
    item.targetStoreId = newStoreId;
    show('目标店铺已调整', 'success');
  } catch (err) {
    show(err.message || '调整失败', 'error');
  } finally {
    state.value.reassigningId = '';
  }
}

// ── 渲染辅助 ───────────────────────────────────────────────
function storeName(storeId) {
  if (!storeId) return '—';
  const s = storesStore.list.find((x) => x.id === storeId);
  return s?.name || storeId;
}

function fmtTime(t) {
  if (!t) return '—';
  const s = String(t).replace('T', ' ').slice(0, 19);
  return s;
}

// 批次级状态徽章
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

// 子任务级状态徽章(PENDING/RUNNING/SUCCESS/FAILED/SKIPPED/CANCELLED)
function itemStatusInfo(st) {
  const s = String(st || '').toUpperCase();
  if (s === 'SUCCESS') return { cls: 'badge-success', label: '成功' };
  if (s === 'FAILED') return { cls: 'badge-failed', label: '失败' };
  if (s === 'RUNNING') return { cls: 'badge-processing', label: '执行中' };
  if (s === 'PENDING') return { cls: 'badge-pending', label: '待执行' };
  if (s === 'SKIPPED') return { cls: 'badge-pending', label: '已跳过' };
  if (s === 'CANCELLED') return { cls: 'badge-failed', label: '已取消' };
  return { cls: 'badge-pending', label: st || '—' };
}

// 是否非终态(可取消)
function isCancelable(st) {
  return !['SUCCESS', 'FAILED', 'PARTIAL', 'CANCELLED'].includes(st);
}

// 进度百分比
const progressPct = computed(() => {
  const d = state.value.detail;
  if (!d || !d.totalCount) return 0;
  const done = (d.successCount || 0) + (d.failedCount || 0) + (d.skippedCount || 0);
  return Math.min(100, Math.round((done / d.totalCount) * 100));
});

onMounted(() => {
  storesStore.load();
  loadDetail();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <div class="bud-head-left">
        <h2>批次详情</h2>
        <span class="muted small" style="margin-left: 8px">{{ batchNo }}</span>
      </div>
      <div class="bud-head-right">
        <button class="btn btn-ghost btn-sm" @click="router.back()">返回</button>
        <button class="btn btn-ghost btn-sm" :disabled="state.loading" @click="loadDetail()">
          {{ state.loading ? '刷新中...' : '刷新' }}
        </button>
      </div>
    </div>

    <div v-if="state.loading && !state.detail" class="empty">加载中...</div>
    <div v-else-if="state.error && !state.detail" class="empty error-text">{{ state.error }}</div>
    <template v-else-if="state.detail">
      <!-- 批次信息卡 -->
      <div class="bud-detail-card">
        <div class="bud-detail-grid">
          <div class="bud-meta-row">
            <span class="bud-meta-k">批次号</span>
            <span class="bud-meta-v">{{ state.detail.batchNo || '—' }}</span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">名称</span>
            <span class="bud-meta-v">{{ state.detail.name || '(未命名)' }}</span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">状态</span>
            <span class="bud-meta-v">
              <span class="badge" :class="statusInfo(state.detail.status).cls">
                {{ statusInfo(state.detail.status).label }}
              </span>
            </span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">总数</span>
            <span class="bud-meta-v">{{ state.detail.totalCount ?? 0 }}</span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">成功</span>
            <span class="bud-meta-v" style="color: var(--success, #16a34a)">{{ state.detail.successCount ?? 0 }}</span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">失败</span>
            <span class="bud-meta-v" style="color: var(--danger, #dc2626)">{{ state.detail.failedCount ?? 0 }}</span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">跳过</span>
            <span class="bud-meta-v muted">{{ state.detail.skippedCount ?? 0 }}</span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">提交间隔</span>
            <span class="bud-meta-v">{{ state.detail.speedConfig?.intervalSec ?? '—' }} 秒</span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">失败处理</span>
            <span class="bud-meta-v">{{ state.detail.speedConfig?.onFailure || '—' }}</span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">创建时间</span>
            <span class="bud-meta-v muted">{{ fmtTime(state.detail.createdAt) }}</span>
          </div>
          <div class="bud-meta-row">
            <span class="bud-meta-k">完成时间</span>
            <span class="bud-meta-v muted">{{ fmtTime(state.detail.completedAt) }}</span>
          </div>
          <div v-if="state.detail.errorMessage" class="bud-meta-row">
            <span class="bud-meta-k">错误</span>
            <span class="bud-meta-v error-text">{{ state.detail.errorMessage }}</span>
          </div>
        </div>

        <!-- 进度条 -->
        <div class="bud-progress">
          <div class="bud-progress-bar" :style="{ width: progressPct + '%' }"></div>
          <span class="bud-progress-text">{{ progressPct }}%</span>
        </div>

        <!-- 操作按钮 -->
        <div class="bud-detail-actions">
          <button
            v-if="state.detail.status === 'RUNNING'"
            class="btn btn-sm btn-ghost"
            :disabled="state.actionLoading === 'pause'"
            @click="onPause"
          >
            {{ state.actionLoading === 'pause' ? '暂停中...' : '暂停' }}
          </button>
          <button
            v-if="state.detail.status === 'PAUSED'"
            class="btn btn-sm btn-primary"
            :disabled="state.actionLoading === 'resume'"
            @click="onResume"
          >
            {{ state.actionLoading === 'resume' ? '继续中...' : '继续' }}
          </button>
          <button
            v-if="isCancelable(state.detail.status)"
            class="btn btn-sm btn-danger"
            :disabled="state.actionLoading === 'cancel'"
            @click="onCancel"
          >
            {{ state.actionLoading === 'cancel' ? '取消中...' : '取消批次' }}
          </button>
          <span v-if="['RUNNING', 'PAUSED'].includes(state.detail.status)" class="muted small">
            (自动刷新中,每 3 秒)
          </span>
        </div>
      </div>

      <!-- 子任务列表 -->
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 50px">序号</th>
              <th>SKU</th>
              <th>来源卖家</th>
              <th style="width: 180px">目标店铺</th>
              <th style="width: 90px">状态</th>
              <th>跳过原因/错误</th>
              <th style="width: 150px">开始时间</th>
              <th style="width: 150px">完成时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!state.detail.items || !state.detail.items.length">
              <td colspan="8" class="muted" style="text-align: center; padding: 16px">无子任务</td>
            </tr>
            <tr v-for="it in state.detail.items || []" :key="it.id">
              <td>{{ it.seq }}</td>
              <td class="bud-sku">{{ it.sourceSku || '—' }}</td>
              <td>{{ it.sellerId || '—' }}</td>
              <td>
                <select
                  v-if="it.status === 'PENDING'"
                  class="bud-store-select"
                  :value="it.targetStoreId"
                  :disabled="state.reassigningId === it.id"
                  @change="onReassign(it, $event.target.value)"
                >
                  <option v-for="s in state.detail.storeIds || []" :key="s" :value="s">
                    {{ storeName(s) }}
                  </option>
                </select>
                <span v-else>{{ storeName(it.targetStoreId) }}</span>
              </td>
              <td>
                <span class="badge" :class="itemStatusInfo(it.status).cls">
                  {{ itemStatusInfo(it.status).label }}
                </span>
              </td>
              <td class="bud-error-cell">{{ it.skipReason || it.errorMessage || '—' }}</td>
              <td class="muted small">{{ fmtTime(it.startedAt) }}</td>
              <td class="muted small">{{ fmtTime(it.finishedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bud-head-left {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.bud-head-right {
  display: flex;
  gap: 8px;
}
.bud-detail-card {
  margin: 0 24px 16px;
  background: #fff;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
}
.bud-detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px 16px;
  font-size: 13px;
}
.bud-meta-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.bud-meta-k {
  color: var(--muted, #6b7280);
  min-width: 80px;
  font-size: 12px;
}
.bud-meta-v {
  word-break: break-all;
}
.bud-progress {
  position: relative;
  margin-top: 12px;
  height: 18px;
  background: #f3f4f6;
  border-radius: 4px;
  overflow: hidden;
}
.bud-progress-bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--primary, #2563eb);
  transition: width 0.3s ease;
}
.bud-progress-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #fff;
  font-weight: 500;
}
.bud-detail-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border, #e4e8ee);
}
.bud-sku {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}
.bud-store-select {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 4px;
  font-size: 12px;
  background: #fff;
}
.bud-store-select:focus {
  outline: none;
  border-color: var(--primary, #2563eb);
}
.bud-error-cell {
  max-width: 240px;
  font-size: 12px;
  color: var(--muted, #6b7280);
  word-break: break-all;
}
</style>
