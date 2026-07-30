<script setup>
// 图片更新任务详情页(2026-07)
// 路由:/image-refresh/:localTaskId
// 功能:任务概要 + items 表(源图/加工后图缩略图 + 状态 + errors) + 重试 + 实时检查图片状态 + 自动轮询
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getImageRefreshDetail, retryImageRefreshItem, getProductPicturesInfo } from '../api/imageRefresh.js';
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
  checkingId: '',
});
let pollTimer = null;

async function loadDetail(silent = false) {
  if (!silent) state.value.loading = true;
  state.value.error = '';
  try {
    const r = await getImageRefreshDetail(localTaskId.value);
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
      if (!state.value.retryingId && !state.value.checkingId) {
        loadDetail(true);
      }
    }, 3000);
  }
}

async function retryItem(item) {
  state.value.retryingId = item.id;
  try {
    await retryImageRefreshItem(localTaskId.value, item.id);
    show('已重新加入队列', 'success');
    await loadDetail(true);
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    state.value.retryingId = '';
  }
}

// 实时检查单个商品图片状态(调 /v2/product/pictures/info)
async function checkPictures(item) {
  state.value.checkingId = item.id;
  try {
    const r = await getProductPicturesInfo(item.productId, item.storeId);
    show(
      r.errors && r.errors.length
        ? `仍有错误:${r.errors.map((e) => e.message || e.code || JSON.stringify(e)).join('; ')}`
        : '图片状态正常,无错误',
      r.errors && r.errors.length ? 'error' : 'success'
    );
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    state.value.checkingId = '';
  }
}

const STATUS_MAP = {
  PENDING: { cls: 'badge-pending', label: '待处理' },
  PROCESSING: { cls: 'badge-processing', label: '处理中' },
  SUCCESS: { cls: 'badge-success', label: '成功' },
  FAILED: { cls: 'badge-failed', label: '失败' },
  SKIPPED: { cls: 'badge-pending', label: '跳过' },
  PARTIAL: { cls: 'badge-warning', label: '部分成功' },
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

// opi_result 中的 errors 拼接展示
function opiErrors(item) {
  const r = item.opiResult;
  if (!r) return '';
  const errs = r.errors || [];
  if (!errs.length) return '';
  return errs.map((e) => e.message || e.code || e.description || JSON.stringify(e)).join('; ');
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
      <h2>图片更新详情</h2>
      <button class="btn btn-ghost" @click="router.back()">返回</button>
    </div>

    <div v-if="state.loading" class="empty">加载中...</div>
    <div v-else-if="state.error" class="empty">加载失败:{{ state.error }}</div>
    <template v-else-if="state.detail">
      <!-- 任务概要 -->
      <div class="ir-summary">
        <div class="meta-row"><span class="meta-k">任务 ID</span><span class="meta-v">{{ state.detail.task.localTaskId }}</span></div>
        <div class="meta-row"><span class="meta-k">店铺</span><span class="meta-v">{{ storeName(state.detail.task.storeId) }}</span></div>
        <div class="meta-row"><span class="meta-k">状态</span><span class="meta-v"><span class="badge" :class="statusInfo(state.detail.task.status).cls">{{ statusInfo(state.detail.task.status).label }}</span></span></div>
        <div class="meta-row"><span class="meta-k">总计</span><span class="meta-v">{{ state.detail.task.totalCount }}</span></div>
        <div class="meta-row"><span class="meta-k">成功</span><span class="meta-v" style="color:#52c41a">{{ state.detail.task.successCount }}</span></div>
        <div class="meta-row"><span class="meta-k">失败</span><span class="meta-v" style="color:#ff4d4f">{{ state.detail.task.failedCount }}</span></div>
        <div class="meta-row"><span class="meta-k">模板</span><span class="meta-v">{{ state.detail.task.templateId || '不加工' }}</span></div>
        <div class="meta-row"><span class="meta-k">创建时间</span><span class="meta-v">{{ fmtTime(state.detail.task.createdAt) }}</span></div>
        <div class="meta-row"><span class="meta-k">完成时间</span><span class="meta-v">{{ fmtTime(state.detail.task.completedAt) }}</span></div>
      </div>

      <!-- items 表 -->
      <div class="listings-table-wrap">
        <table class="listings-table">
          <thead>
            <tr>
              <th>商品 ID</th>
              <th>SKU</th>
              <th>状态</th>
              <th>源图</th>
              <th>加工后图</th>
              <th>错误信息</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!state.detail.items.length">
              <td colspan="7" class="muted" style="padding:16px;text-align:center">无明细数据</td>
            </tr>
            <tr v-for="it in state.detail.items" :key="it.id">
              <td>{{ it.productId }}</td>
              <td>{{ it.offerId || '—' }}</td>
              <td><span class="badge" :class="statusInfo(it.status).cls">{{ statusInfo(it.status).label }}</span></td>
              <td>
                <div v-if="it.sourceImages.length" class="thumb-row">
                  <img v-for="(u, i) in it.sourceImages.slice(0, 4)" :key="i" :src="u" class="thumb" loading="lazy" @error="$event.target.style.display='none'" />
                  <span v-if="it.sourceImages.length > 4" class="muted">+{{ it.sourceImages.length - 4 }}</span>
                </div>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <div v-if="it.processedImages.length" class="thumb-row">
                  <img v-for="(u, i) in it.processedImages.slice(0, 4)" :key="i" :src="u" class="thumb" loading="lazy" @error="$event.target.style.display='none'" />
                </div>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <span v-if="it.errorMessage || opiErrors(it)" style="color:#ff4d4f">{{ it.errorMessage || opiErrors(it) }}</span>
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
                <button
                  class="btn btn-sm btn-ghost"
                  :disabled="state.checkingId === it.id"
                  @click="checkPictures(it)"
                >
                  {{ state.checkingId === it.id ? '...' : '检查状态' }}
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
.ir-summary {
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
.thumb-row {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-wrap: wrap;
}
.thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid #eee;
}
.muted {
  color: #999;
  font-size: 12px;
}
</style>
