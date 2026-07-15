<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import {
  getCollectQueueStats,
  getCollectQueueList,
  getCollectQueueTask,
  retryCollectQueueTask,
  deleteCollectQueueTask,
  batchRetryAllFailed,
  clearCollectQueue,
  pauseCollectQueueConsume,
  resumeCollectQueueConsume,
} from '../api/collectQueue.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import JsonTree from '../components/JsonTree.vue';

const { show } = useToast();

// 8 个采集步骤(与 SW 侧 _doAutoCollect 一致)
const STEP_KEYS = [
  { key: 'card', label: 'card' },
  { key: 'detail', label: 'detail' },
  { key: 'composer', label: 'composer' },
  { key: 'entrypoint', label: 'entrypoint' },
  { key: 'search', label: 'search' },
  { key: 'marketStats', label: 'marketStats' },
  { key: 'bundle', label: 'bundle' },
  { key: 'followSell', label: 'followSell' },
];

// 状态 tab
const TABS = [
  { key: 'pending', label: '待采集' },
  { key: 'running', label: '采集中' },
  { key: 'failed_retry', label: '重试中' },
  { key: 'success', label: '已完成' },
  { key: 'failed_final', label: '失败' },
  { key: '', label: '全部' },
];

const STATUS_LABELS = {
  pending: '待采集',
  running: '采集中',
  failed_retry: '重试中',
  failed_final: '失败',
  failed_partial: '部分失败',
  success: '已完成',
};

// ── 统计 ───────────────────────────────────────────────────
const stats = ref({
  byStatus: {},
  circuitBreaker: { active: false, remainingMs: 0 },
  total: 0,
  consumePaused: false,
});
const statsLoading = ref(false);

async function loadStats() {
  statsLoading.value = true;
  try {
    stats.value = await getCollectQueueStats();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    statsLoading.value = false;
  }
}

// ── 列表 ───────────────────────────────────────────────────
const currentTab = ref('pending');
const items = ref([]);
const loading = ref(false);
const pager = reactive({ current: 1, total: 0, pageSize: 20 });
let _listReqId = 0;

async function loadList() {
  const reqId = ++_listReqId;
  loading.value = true;
  try {
    const data = await getCollectQueueList({
      status: currentTab.value,
      page: pager.current,
      pageSize: pager.pageSize,
    });
    if (reqId !== _listReqId) return; // 不是最新请求,丢弃
    items.value = data?.items || [];
    pager.total = data?.total || 0;
  } catch (err) {
    if (reqId !== _listReqId) return;
    show(err.message || String(err), 'error');
    items.value = [];
    pager.total = 0;
  } finally {
    if (reqId === _listReqId) loading.value = false;
  }
}

function onTabChange(tab) {
  currentTab.value = tab;
  pager.current = 1;
  loadList();
}

function onPageChange(p) {
  pager.current = p;
  loadList();
}

function refreshAll() {
  loadStats();
  loadList();
}

// ── 操作 ───────────────────────────────────────────────────
async function retryTask(sku) {
  try {
    await retryCollectQueueTask(sku);
    show('已提交重试指令', 'success');
    refreshAll();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function removeTask(sku) {
  if (!confirm(`确认删除任务 ${sku}?`)) return;
  try {
    await deleteCollectQueueTask(sku);
    show('已提交删除指令', 'success');
    refreshAll();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function batchRetryFailed() {
  if (!confirm('确认批量重试所有失败终态任务?')) return;
  try {
    await batchRetryAllFailed();
    show('已提交批量重试指令', 'success');
    refreshAll();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function onClearPending() {
  const input = window.prompt('确认清空所有待采集任务?此操作不可恢复!\n请输入 "清空" 确认:');
  if (input !== '清空') {
    if (input !== null) show('已取消', 'error');
    return;
  }
  try {
    await clearCollectQueue();
    show('已提交清空指令', 'success');
    refreshAll();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function onPauseConsume() {
  try {
    await pauseCollectQueueConsume();
    show('已提交暂停消费指令', 'success');
    refreshAll();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function onResumeConsume() {
  try {
    await resumeCollectQueueConsume();
    show('已提交恢复消费指令', 'success');
    refreshAll();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 详情弹窗 ───────────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detail = ref(null);
const detailTitle = computed(() => (detail.value ? `任务详情· ${detail.value.sku}` : '任务详情'));
let _detailReqId = 0;

async function openDetail(row) {
  const reqId = ++_detailReqId;
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    const data = await getCollectQueueTask(row.sku);
    if (reqId !== _detailReqId) return; // 不是最新请求,丢弃
    detail.value = data;
  } catch (err) {
    if (reqId !== _detailReqId) return;
    show(err.message || String(err), 'error');
  } finally {
    if (reqId === _detailReqId) detailLoading.value = false;
  }
}

// ── 自动刷新 ───────────────────────────────────────────────
let statsTimer = null;
let listTimer = null;

function startAutoRefresh() {
  stopAutoRefresh();
  statsTimer = setInterval(() => {
    loadStats();
  }, 5000);
  listTimer = setInterval(() => {
    loadList();
  }, 15000);
}

function stopAutoRefresh() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  if (listTimer) {
    clearInterval(listTimer);
    listTimer = null;
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    stopAutoRefresh();
  } else {
    startAutoRefresh();
  }
}

// ── 格式化工具 ─────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms) {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusTag(status) {
  if (status === 'success') return 'tag tag-ok';
  if (status === 'running') return 'tag tag-info';
  if (status === 'pending') return 'tag tag-muted';
  if (status === 'failed_retry') return 'tag tag-warn';
  if (status === 'failed_final' || status === 'failed_partial') return 'tag tag-err';
  return 'tag tag-muted';
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function stepTagClass(stepStatus) {
  if (stepStatus === 'ok') return 'step-ok';
  if (stepStatus === 'fail' || stepStatus === 'error') return 'step-err';
  return 'step-none';
}

function stepTagLabel(stepStatus) {
  if (stepStatus === 'ok') return '✓';
  if (stepStatus === 'fail' || stepStatus === 'error') return '✗';
  return '—';
}

function errorSummary(lastError) {
  if (!lastError) return '—';
  if (typeof lastError === 'string') return lastError.slice(0, 60);
  const msg = lastError.message || lastError.type || '';
  return msg.slice(0, 60);
}

function remainingMinutes(ms) {
  if (!ms || ms <= 0) return 0;
  return Math.ceil(ms / 60000);
}

// ── 生命周期 ───────────────────────────────────────────────
onMounted(() => {
  refreshAll();
  startAutoRefresh();
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
  stopAutoRefresh();
  document.removeEventListener('visibilitychange', onVisibilityChange);
});
</script>

<template>
  <div class="collect-queue-page">
    <!-- 统计卡片 -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">待采集</div>
        <div class="stat-value">{{ stats.byStatus?.pending || 0 }}</div>
        <div class="stat-sub">pending</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">采集中</div>
        <div class="stat-value stat-info">{{ stats.byStatus?.running || 0 }}</div>
        <div class="stat-sub">running</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">重试中</div>
        <div class="stat-value stat-warn">{{ stats.byStatus?.failed_retry || 0 }}</div>
        <div class="stat-sub">failed_retry</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">已完成</div>
        <div class="stat-value stat-ok">{{ stats.byStatus?.success || 0 }}</div>
        <div class="stat-sub">success</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">失败终态</div>
        <div class="stat-value" :class="{ 'stat-err': (stats.byStatus?.failed_final || 0) > 0 }">
          {{ stats.byStatus?.failed_final || 0 }}
        </div>
        <div class="stat-sub">failed_final</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">熔断状态</div>
        <div
          class="stat-value"
          :class="{ 'stat-err': stats.circuitBreaker?.active, 'stat-ok': !stats.circuitBreaker?.active }"
        >
          {{ stats.circuitBreaker?.active ? '熔断中' : '正常' }}
        </div>
        <div class="stat-sub" v-if="stats.circuitBreaker?.active">
          还剩 {{ remainingMinutes(stats.circuitBreaker?.remainingMs) }} 分钟
        </div>
        <div class="stat-sub" v-else>正常消费</div>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="filter-bar">
        <button class="btn btn-ghost" @click="refreshAll" :disabled="loading || statsLoading">
          {{ loading || statsLoading ? '刷新中...' : '刷新' }}
        </button>
      </div>
      <div class="action-bar">
        <button v-if="!stats.consumePaused" class="btn btn-ghost" @click="onPauseConsume">暂停消费</button>
        <button v-else class="btn btn-ghost" @click="onResumeConsume">恢复消费</button>
        <button class="btn btn-danger" @click="onClearPending">清空待采集</button>
        <button class="btn btn-primary" @click="batchRetryFailed" v-if="currentTab === 'failed_final'">批量重试</button>
      </div>
    </div>

    <!-- 状态 Tab -->
    <div class="sub-tabs">
      <button
        v-for="t in TABS"
        :key="t.key || 'all'"
        class="sub-tab"
        :class="{ active: currentTab === t.key }"
        @click="onTabChange(t.key)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 任务列表 -->
    <div class="table-wrap">
      <table class="data-table queue-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>卖家</th>
            <th>状态</th>
            <th>尝试次数</th>
            <th>创建时间</th>
            <th>下次重试</th>
            <th>最近错误</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!items.length">
            <td colspan="8" class="empty">{{ loading ? '加载中...' : '暂无任务' }}</td>
          </tr>
          <tr v-for="row in items" :key="row._id || row.sku" @click="openDetail(row)">
            <td class="col-sku">{{ row.sku }}</td>
            <td>{{ row.sellerSlug || '—' }}</td>
            <td>
              <span :class="statusTag(row.status)">{{ statusLabel(row.status) }}</span>
            </td>
            <td>{{ row.attempts || 0 }} / {{ row.maxAttempts || 3 }}</td>
            <td class="col-time">{{ fmtTime(row.createdAt) }}</td>
            <td class="col-time">{{ row.nextRetryAt ? fmtTime(row.nextRetryAt) : '—' }}</td>
            <td
              :title="
                row.lastError ? (typeof row.lastError === 'string' ? row.lastError : JSON.stringify(row.lastError)) : ''
              "
            >
              <span class="error-summary">{{ errorSummary(row.lastError) }}</span>
            </td>
            <td class="row-actions" @click.stop>
              <button v-if="row.status === 'failed_final'" class="btn btn-sm btn-primary" @click="retryTask(row.sku)">
                重试
              </button>
              <button class="btn btn-sm btn-danger" @click="removeTask(row.sku)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AppPager
      :modelValue="pager.current"
      :total="pager.total"
      :pageSize="pager.pageSize"
      @update:modelValue="onPageChange"
    />

    <!-- 详情弹窗 -->
    <AppModal :open="detailOpen" :title="detailTitle" size="lg" @update:open="detailOpen = $event">
      <p v-if="detailLoading" class="muted">加载中...</p>
      <div v-else-if="detail" class="task-detail">
        <!-- 基础信息 -->
        <div class="detail-meta">
          <div class="meta-row">
            <span class="meta-k">SKU:</span><span class="meta-v">{{ detail.sku }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">卖家:</span><span class="meta-v">{{ detail.sellerSlug || '—' }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">Seller ID:</span><span class="meta-v">{{ detail.sellerId || '—' }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">状态:</span>
            <span class="meta-v"
              ><span :class="statusTag(detail.status)">{{ statusLabel(detail.status) }}</span></span
            >
          </div>
          <div class="meta-row">
            <span class="meta-k">尝试次数:</span>
            <span class="meta-v">{{ detail.attempts || 0 }} / {{ detail.maxAttempts || 3 }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">创建时间:</span><span class="meta-v">{{ fmtTime(detail.createdAt) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">开始时间:</span><span class="meta-v">{{ fmtTime(detail.startedAt) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">完成时间:</span><span class="meta-v">{{ fmtTime(detail.finishedAt) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">耗时:</span><span class="meta-v">{{ fmtDuration(detail.duration) }}</span>
          </div>
          <div class="meta-row" v-if="detail.nextRetryAt">
            <span class="meta-k">下次重试:</span><span class="meta-v">{{ fmtTime(detail.nextRetryAt) }}</span>
          </div>
        </div>

        <!-- DOM 信息 -->
        <div class="detail-section" v-if="detail.domInfo">
          <h3>DOM 信息</h3>
          <div class="detail-dom">
            <div class="meta-row">
              <span class="meta-k">标题:</span><span class="meta-v">{{ detail.domInfo.title || '—' }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-k">价格:</span><span class="meta-v">{{ detail.domInfo.price ?? '—' }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-k">评价数:</span><span class="meta-v">{{ detail.domInfo.ratingCount ?? '—' }}</span>
            </div>
            <div class="meta-row" v-if="detail.domInfo.imageUrl && /^https?:\/\//.test(detail.domInfo.imageUrl)">
              <span class="meta-k">图片:</span>
              <a
                class="meta-v link"
                :href="detail.domInfo.imageUrl"
                target="_blank"
                rel="noopener noreferrer"
                @click.stop
                >查看图片</a
              >
            </div>
          </div>
        </div>

        <!-- 8 步状态 -->
        <div class="detail-section">
          <h3>采集步骤状态</h3>
          <div class="steps-row">
            <div v-for="s in STEP_KEYS" :key="s.key" class="step-item" :class="stepTagClass(detail.steps?.[s.key])">
              <span class="step-mark">{{ stepTagLabel(detail.steps?.[s.key]) }}</span>
              <span class="step-label">{{ s.label }}</span>
            </div>
          </div>
        </div>

        <!-- 错误信息 -->
        <div class="detail-section" v-if="detail.lastError">
          <h3>错误信息</h3>
          <div class="error-box">
            <JsonTree :data="detail.lastError" :default-expand-level="2" root-key="lastError" />
          </div>
        </div>

        <!-- 采集结果 -->
        <div class="detail-section" v-if="detail.result">
          <h3>采集结果</h3>
          <div class="result-box">
            <JsonTree :data="detail.result" :default-expand-level="2" root-key="result" />
          </div>
        </div>
      </div>
      <p v-else class="muted">未找到任务详情</p>
    </AppModal>
  </div>
</template>

<style scoped>
.collect-queue-page {
  padding: 16px;
  max-width: 1400px;
  margin: 0 auto;
}

/* 统计卡片 */
.stats-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.stat-card {
  flex: 1;
  min-width: 140px;
  background: var(--card, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: var(--shadow);
}
.stat-label {
  font-size: 12px;
  color: var(--muted, #6b7280);
  margin-bottom: 4px;
}
.stat-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--text, #111827);
}
.stat-info {
  color: var(--primary, #2563eb);
}
.stat-ok {
  color: var(--success, #16a34a);
}
.stat-warn {
  color: var(--warning, #d97706);
}
.stat-err {
  color: var(--danger, #dc2626);
}
.stat-sub {
  font-size: 11px;
  color: var(--muted, #9ca3af);
  margin-top: 2px;
}

/* 工具栏 */
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.action-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* Tab */
.sub-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border, #e5e7eb);
  margin-bottom: 12px;
}
.sub-tab {
  padding: 8px 16px;
  border: none;
  background: transparent;
  color: var(--muted, #6b7280);
  font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}
.sub-tab:hover {
  color: var(--text, #1f2937);
}
.sub-tab.active {
  color: var(--primary, #2563eb);
  border-bottom-color: var(--primary, #2563eb);
  font-weight: 500;
}

/* 表格 */
.queue-table tbody tr {
  cursor: pointer;
}
.queue-table tbody tr:hover {
  background: #f9fafb;
}
.queue-table th,
.queue-table td {
  text-align: left;
}
.col-sku {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 12px;
}
.col-time {
  font-size: 12px;
  color: var(--muted, #6b7280);
  white-space: nowrap;
}
.error-summary {
  display: inline-block;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--danger, #dc2626);
  font-size: 12px;
}

/* 详情弹窗 */
.task-detail {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.detail-section h3 {
  font-size: 14px;
  margin-bottom: 10px;
  color: var(--text, #1f2937);
}
.detail-meta,
.detail-dom {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px 16px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
}
.meta-row {
  display: flex;
  gap: 6px;
}
.meta-k {
  color: var(--muted, #6b7280);
  min-width: 70px;
  flex-shrink: 0;
}
.meta-v {
  word-break: break-all;
}

/* 步骤状态 */
.steps-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.step-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid var(--border, #e5e7eb);
  background: #f3f4f6;
  font-size: 12px;
}
.step-item.step-ok {
  background: #d1fae5;
  border-color: #a7f3d0;
  color: #059669;
}
.step-item.step-err {
  background: #fee2e2;
  border-color: #fecaca;
  color: #dc2626;
}
.step-mark {
  font-weight: 600;
}
.step-label {
  color: inherit;
}

/* 错误 / 结果 JSON */
.error-box,
.result-box {
  background: #f9fafb;
  border-radius: 6px;
  padding: 12px;
  max-height: 360px;
  overflow: auto;
}
</style>
