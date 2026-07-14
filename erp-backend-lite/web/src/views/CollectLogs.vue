<script setup>
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue';
import { getAutoCollectStats, getAutoCollectLogs } from '../api/cache.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();

// 8 类缓存类型
const EIGHT_TYPES = [
  { key: 'card', label: 'card' },
  { key: 'detail', label: 'detail' },
  { key: 'composer', label: 'composer' },
  { key: 'entrypoint', label: 'entrypoint' },
  { key: 'search', label: 'search' },
  { key: 'bundle', label: 'bundle' },
  { key: 'marketStats', label: 'marketStats' },
  { key: 'followSell', label: 'followSell' },
];

// 统计数据
const stats = ref({});
// 日志列表
const logs = ref([]);
// 展开的行(查看错误详情)
const expandedRows = ref(new Set());

// 筛选条件
const filters = reactive({
  sku: '',
  status: '',
  source: '',
  sellerSlug: '',
});

// 分页
const pager = reactive({
  current: 1,
  total: 0,
  pageSize: 50,
});

// 自动刷新
const autoRefresh = ref(false);
const refreshInterval = ref(5); // 秒
let refreshTimer = null;

// 加载状态
const loading = ref(false);

// ── 数据加载 ───────────────────────────────────────────────
async function loadStats() {
  try {
    stats.value = await getAutoCollectStats();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function loadLogs() {
  loading.value = true;
  try {
    const data = await getAutoCollectLogs({
      sku: filters.sku.trim(),
      status: filters.status,
      source: filters.source,
      sellerSlug: filters.sellerSlug.trim(),
      page: pager.current,
      pageSize: pager.pageSize,
    });
    logs.value = data?.items || [];
    pager.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    logs.value = [];
    pager.total = 0;
  } finally {
    loading.value = false;
  }
}

function searchLogs() {
  pager.current = 1;
  expandedRows.value.clear();
  loadLogs();
}

function onPageChange(p) {
  pager.current = p;
  expandedRows.value.clear();
  loadLogs();
}

function refreshAll() {
  loadStats();
  loadLogs();
}

// ── 自动刷新 ───────────────────────────────────────────────
function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  if (autoRefresh.value) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    loadStats();
    loadLogs();
  }, refreshInterval.value * 1000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function onIntervalChange() {
  if (autoRefresh.value) {
    startAutoRefresh();
  }
}

// ── 行展开(查看错误详情) ────────────────────────────────────
function toggleExpand(id) {
  if (expandedRows.value.has(id)) {
    expandedRows.value.delete(id);
  } else {
    expandedRows.value.add(id);
  }
}

function isExpanded(id) {
  return expandedRows.value.has(id);
}

// 获取某条日志中所有有 error 的缓存类型
function getErrorDetails(log) {
  if (!Array.isArray(log.results)) return [];
  return log.results.filter((r) => r.error).map((r) => ({ type: r.type, error: r.error }));
}

// ── 格式化工具 ─────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logResultTag(log, type) {
  const r = log.results?.find((x) => x.type === type);
  if (!r) return '—';
  if (r.hit) return '✓';
  if (r.error) return '✗';
  return '-';
}

function logResultClass(log, type) {
  const r = log.results?.find((x) => x.type === type);
  if (!r) return '';
  if (r.hit) return 'result-hit';
  if (r.error) return 'result-err';
  return '';
}

function logStatusTag(status) {
  if (status === 'success') return 'tag tag-ok';
  if (status === 'failed' || status === 'antibot') return 'tag tag-err';
  if (status === 'partial') return 'tag tag-warn';
  return 'tag tag-mute';
}

function logStatusLabel(status) {
  const map = {
    success: '成功',
    partial: '部分',
    failed: '失败',
    skipped: '跳过',
    antibot: '反爬',
  };
  return map[status] || status;
}

// 统计:成功率
const successRate = computed(() => {
  const today = stats.value?.today;
  if (!today || !today.total) return 0;
  return Math.round((today.success / today.total) * 100);
});

// 统计:有 error 的日志数
const errorCount = computed(() => {
  return logs.value.filter((log) => log.results?.some((r) => r.error)).length;
});

// ── 生命周期 ───────────────────────────────────────────────
onMounted(() => {
  refreshAll();
});

onUnmounted(() => {
  stopAutoRefresh();
});
</script>

<template>
  <div class="collect-logs-page">
    <!-- 统计卡片 -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">今日采集</div>
        <div class="stat-value">{{ stats.today?.total || 0 }}</div>
        <div class="stat-sub">总次数</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">成功率</div>
        <div
          class="stat-value"
          :class="{
            'stat-ok': successRate >= 80,
            'stat-warn': successRate < 80 && successRate >= 50,
            'stat-err': successRate < 50,
          }"
        >
          {{ successRate }}%
        </div>
        <div class="stat-sub">成功 {{ stats.today?.success || 0 }} / 失败 {{ stats.today?.failed || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">反爬熔断</div>
        <div class="stat-value" :class="{ 'stat-err': (stats.today?.antibot || 0) > 0 }">
          {{ stats.today?.antibot || 0 }}
        </div>
        <div class="stat-sub">次</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">店铺分类</div>
        <div class="stat-value" style="font-size: 14px">
          中国 {{ stats.today?.byStoreClass?.chinese || 0 }} / 非中国
          {{ stats.today?.byStoreClass?.['non-chinese'] || 0 }} / 未分类
          {{ stats.today?.byStoreClass?.unclassified || 0 }}
        </div>
        <div class="stat-sub">今日</div>
      </div>
    </div>

    <!-- 各类目命中数 -->
    <div class="type-hits" v-if="stats.today?.byType">
      <div v-for="t in EIGHT_TYPES" :key="t.key" class="type-hit">
        <span class="type-hit-label">{{ t.label }}:</span>
        <span class="type-hit-value">{{ stats.today.byType[t.key] || 0 }}</span>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="filter-bar">
        <input
          class="filter-input"
          type="text"
          v-model.trim="filters.sku"
          placeholder="SKU"
          @keydown.enter="searchLogs"
        />
        <select v-model="filters.status" class="filter-input" @change="searchLogs">
          <option value="">全部状态</option>
          <option value="success">成功</option>
          <option value="partial">部分</option>
          <option value="failed">失败</option>
          <option value="skipped">跳过</option>
          <option value="antibot">反爬</option>
        </select>
        <select v-model="filters.source" class="filter-input" @change="searchLogs">
          <option value="">全部来源</option>
          <option value="shop-page">店铺页</option>
          <option value="pdp">详情页</option>
        </select>
        <input
          class="filter-input"
          type="text"
          v-model.trim="filters.sellerSlug"
          placeholder="卖家 Slug"
          @keydown.enter="searchLogs"
        />
        <button class="btn btn-primary" @click="searchLogs">查询</button>
        <button class="btn btn-ghost" @click="refreshAll" :disabled="loading">
          {{ loading ? '加载中...' : '刷新' }}
        </button>
      </div>
      <div class="refresh-ctrl">
        <label class="auto-refresh-toggle">
          <input type="checkbox" :checked="autoRefresh" @change="toggleAutoRefresh" />
          自动刷新
        </label>
        <select
          v-model="refreshInterval"
          class="filter-input interval-select"
          :disabled="!autoRefresh"
          @change="onIntervalChange"
        >
          <option :value="5">5秒</option>
          <option :value="10">10秒</option>
          <option :value="30">30秒</option>
        </select>
      </div>
    </div>

    <!-- 日志列表 -->
    <div class="table-wrap">
      <table class="data-table log-table">
        <thead>
          <tr>
            <th class="col-expand"></th>
            <th class="col-sku">SKU</th>
            <th>来源</th>
            <th>状态</th>
            <th>耗时</th>
            <th v-for="t in EIGHT_TYPES" :key="t.key" :title="t.label + ' 缓存命中'">{{ t.label }}</th>
            <th>卖家</th>
            <th>采集时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!logs.length">
            <td :colspan="5 + EIGHT_TYPES.length + 2" class="empty">{{ loading ? '加载中...' : '暂无日志记录' }}</td>
          </tr>
          <template v-for="log in logs" :key="log._id">
            <tr :class="{ 'row-has-error': getErrorDetails(log).length > 0 }" @click="toggleExpand(log._id)">
              <td class="col-expand">
                <span v-if="getErrorDetails(log).length > 0" class="expand-icon">{{
                  isExpanded(log._id) ? '▼' : '▶'
                }}</span>
              </td>
              <td class="col-sku">{{ log.sku }}</td>
              <td>{{ log.source || '—' }}</td>
              <td>
                <span :class="logStatusTag(log.status)">{{ logStatusLabel(log.status) }}</span>
              </td>
              <td>{{ log.totalDuration }}ms</td>
              <td v-for="t in EIGHT_TYPES" :key="t.key" :class="logResultClass(log, t.key)">
                {{ logResultTag(log, t.key) }}
              </td>
              <td>{{ log.sellerSlug || '—' }}</td>
              <td class="col-time">{{ fmtTime(log.collectedAt) }}</td>
            </tr>
            <tr v-if="isExpanded(log._id)" class="row-detail">
              <td :colspan="5 + EIGHT_TYPES.length + 2">
                <div class="error-detail">
                  <div v-for="e in getErrorDetails(log)" :key="e.type" class="error-item">
                    <span class="error-type">{{ e.type }}:</span>
                    <span class="error-msg">{{ e.error }}</span>
                  </div>
                  <div v-if="getErrorDetails(log).length === 0" class="no-error">无错误详情</div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="footer-bar">
      <span class="footer-info">
        共 {{ pager.total }} 条 · 当前页 {{ errorCount > 0 ? errorCount + ' 条有错误' : '无错误' }}
      </span>
      <AppPager
        :modelValue="pager.current"
        :total="pager.total"
        :pageSize="pager.pageSize"
        @update:modelValue="onPageChange"
      />
    </div>
  </div>
</template>

<style scoped>
.collect-logs-page {
  padding: 16px;
  max-width: 1400px;
  margin: 0 auto;
}

/* 统计卡片 */
.stats-row {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.stat-card {
  flex: 1;
  min-width: 160px;
  background: var(--bg-card, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 12px 16px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary, #111827);
}

.stat-ok {
  color: #16a34a;
}

.stat-warn {
  color: #f59e0b;
}

.stat-err {
  color: #ef4444;
}

.stat-sub {
  font-size: 11px;
  color: var(--text-secondary, #9ca3af);
  margin-top: 2px;
}

/* 各类目命中数 */
.type-hits {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 10px 14px;
  background: var(--bg-card, #f9fafb);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
}

.type-hit {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.type-hit-label {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}

.type-hit-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #111827);
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

.refresh-ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
}

.auto-refresh-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.interval-select {
  width: 70px;
}

/* 表格 */
.log-table {
  font-size: 12px;
}

.log-table th,
.log-table td {
  text-align: center;
  white-space: nowrap;
}

.col-expand {
  width: 28px;
  cursor: pointer;
}

.expand-icon {
  font-size: 10px;
  color: var(--text-secondary, #6b7280);
}

.col-sku {
  text-align: left;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.col-time {
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
}

.row-has-error {
  cursor: pointer;
}

.row-has-error:hover {
  background: var(--bg-hover, #fef9c3);
}

.row-detail td {
  background: var(--bg-elevated, #fffbeb);
  padding: 10px 16px;
}

.error-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.error-item {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.error-type {
  font-weight: 600;
  color: #ef4444;
  min-width: 100px;
}

.error-msg {
  color: var(--text-primary, #374151);
}

.no-error {
  font-size: 12px;
  color: var(--text-secondary, #9ca3af);
}

.result-hit {
  color: #16a34a;
  font-weight: 600;
}

.result-err {
  color: #ef4444;
  font-weight: 600;
}

/* 底部栏 */
.footer-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
  flex-wrap: wrap;
  gap: 8px;
}

.footer-info {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}
</style>
