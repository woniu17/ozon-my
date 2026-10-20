<script setup>
// 打印日志监控(2026-10-22):打印组件(本机/服务器转发)出纸记录查询
// 数据源:print_log 表(print-agent-relay 每次转发打印后写入)
//   - stats: 当日/昨日 成功失败统计 + 按打印机分组
//   - logs:  分页明细,支持状态/关键字过滤
// 设计:与 CollectLogs 同款布局(统计卡片 + 过滤工具栏 + 可展开错误详情的表格)
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { getPrintLogs, getPrintStats, parsePrinter } from '../api/print-agent.js';
import { getStores } from '../api/stores.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();

// 日期范围(与后端口径一致:北京时间日界)
const dayOptions = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
];

const filters = reactive({
  day: 'today',
  status: '',
  keyword: '',
});

// 分页
const pager = reactive({ current: 1, total: 0, pageSize: 50 });

// 数据
const stats = ref(null);
const logs = ref([]);
const loading = ref(false);
const stores = ref([]); // 店铺列表(store_id → 店铺名)
const expandedRows = ref(new Set());

// 自动刷新(打印进行时方便盯屏)
const autoRefresh = ref(false);
const refreshInterval = ref(10); // 秒
let refreshTimer = null;

// store_id → 店铺名(print 直连日志不落 store_id,显示 —)
const storeMap = computed(() => {
  const m = new Map();
  for (const s of stores.value) m.set(String(s.id), s.name);
  return m;
});

const storeNameOf = (storeId) => {
  if (storeId === null || storeId === undefined || storeId === '') return '—';
  return storeMap.value.get(String(storeId)) || `#${storeId}`;
};

// 打印机名:去掉 local:/server: 前缀;空值显示默认打印机
const printerLabel = (printer) => {
  const parsed = parsePrinter(printer);
  return parsed.name || '默认打印机';
};
// 仅当打印机名带 local:/server: 前缀时标注通道(无前缀的历史值无法区分,不标注)
const printerSource = (printer) => {
  if (!printer) return '';
  if (printer.startsWith('server:')) return '服务器';
  if (printer.startsWith('local:')) return '本机';
  return '';
};

// 来源中文
const sourceLabel = (source) => {
  const map = {
    print: '图片打印',
    'print-package': '按包裹打印',
  };
  return map[source] || source || '—';
};

// 失败率颜色
const failRateClass = computed(() => {
  const rate = stats.value?.failRate ?? 0;
  if (rate === 0) return 'stat-ok';
  if (rate < 5) return 'stat-warn';
  return 'stat-err';
});

// 按打印机分组统计(合并 stats.byPrinter 行)
const printerStats = computed(() => {
  const rows = stats.value?.byPrinter || [];
  const map = new Map();
  for (const r of rows) {
    const key = r.printer || '';
    if (!map.has(key)) map.set(key, { printer: r.printer, total: 0, success: 0, failed: 0 });
    const item = map.get(key);
    item.total += r.c;
    if (r.status === 'success') item.success += r.c;
    else if (r.status === 'failed') item.failed += r.c;
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
});

// ── 数据加载 ───────────────────────────────────────────────
async function loadStores() {
  try {
    stores.value = await getStores();
  } catch {
    /* 店铺名映射失败不影响日志展示 */
  }
}

async function loadStats() {
  try {
    stats.value = await getPrintStats({ day: filters.day });
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function loadLogs() {
  loading.value = true;
  try {
    const data = await getPrintLogs({
      day: filters.day,
      page: pager.current,
      pageSize: pager.pageSize,
      status: filters.status,
      keyword: filters.keyword.trim(),
    });
    logs.value = data?.logs || [];
    pager.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    logs.value = [];
    pager.total = 0;
  } finally {
    loading.value = false;
  }
}

function refreshAll() {
  loadStats();
  loadLogs();
}

// 查询:重置页码 + 收起展开行
function searchLogs() {
  pager.current = 1;
  expandedRows.value.clear();
  refreshAll();
}

// 切换 今日/昨日:统计与列表一起刷新
function changeDay() {
  searchLogs();
}

function onPageChange(p) {
  pager.current = p;
  expandedRows.value.clear();
  loadLogs();
}

// ── 自动刷新 ───────────────────────────────────────────────
function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  if (autoRefresh.value) startAutoRefresh();
  else stopAutoRefresh();
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
  if (autoRefresh.value) startAutoRefresh();
}

// ── 行展开(查看错误详情) ────────────────────────────────────
function toggleExpand(id) {
  if (expandedRows.value.has(id)) expandedRows.value.delete(id);
  else expandedRows.value.add(id);
}
const isExpanded = (id) => expandedRows.value.has(id);
const hasError = (log) => log.status === 'failed' && !!log.error;

// ── 格式化 ─────────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return Math.round(ms) + 'ms';
}
function statusTag(status) {
  return status === 'success' ? 'tag tag-ok' : 'tag tag-err';
}
function statusLabel(status) {
  return status === 'success' ? '成功' : '失败';
}

// ── 生命周期 ───────────────────────────────────────────────
onMounted(() => {
  loadStores();
  refreshAll();
});
onUnmounted(() => {
  stopAutoRefresh();
});
</script>

<template>
  <div class="print-logs-page">
    <div class="page-header">
      <h2 class="page-title">打印日志监控</h2>
      <p class="page-desc">
        记录经打印组件出纸的每一次请求(本机直连 + 服务器转发),成功失败均落库,用于排查面单打印异常。
      </p>
    </div>

    <!-- 日期切换 + 统计卡片 -->
    <div class="day-toggle" role="tablist" aria-label="日期范围">
      <button
        v-for="d in dayOptions"
        :key="d.key"
        class="day-btn"
        :class="{ active: filters.day === d.key }"
        @click="filters.day = d.key; changeDay()"
      >
        {{ d.label }}
      </button>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">总打印</div>
        <div class="stat-value">{{ stats?.total ?? 0 }}</div>
        <div class="stat-sub">次</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">成功</div>
        <div class="stat-value stat-ok">{{ stats?.success ?? 0 }}</div>
        <div class="stat-sub">次</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">失败</div>
        <div class="stat-value" :class="{ 'stat-err': (stats?.failed ?? 0) > 0 }">
          {{ stats?.failed ?? 0 }}
        </div>
        <div class="stat-sub">次</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">失败率</div>
        <div class="stat-value" :class="failRateClass">{{ stats?.failRate ?? 0 }}%</div>
        <div class="stat-sub">成功 {{ stats?.success ?? 0 }} / 失败 {{ stats?.failed ?? 0 }}</div>
      </div>
    </div>

    <!-- 按打印机分布 -->
    <div class="printer-stats" v-if="printerStats.length">
      <span class="ps-title">打印机分布:</span>
      <span v-for="p in printerStats" :key="p.printer" class="ps-item" :class="{ 'ps-err': p.failed > 0 }">
        <span class="ps-name">{{ printerLabel(p.printer) }}</span>
        <span class="ps-count">{{ p.total }}次</span>
        <span class="ps-break">成功{{ p.success }}</span>
        <span v-if="p.failed" class="ps-break ps-fail">失败{{ p.failed }}</span>
      </span>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="filter-bar">
        <select v-model="filters.status" class="filter-input" @change="searchLogs">
          <option value="">全部状态</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
        </select>
        <input
          class="filter-input keyword-input"
          type="text"
          v-model.trim="filters.keyword"
          placeholder="货件号 / 店铺 / 打印机 / 错误"
          @keydown.enter="searchLogs"
        />
        <button class="btn btn-primary" @click="searchLogs">查询</button>
        <button class="btn btn-ghost" :disabled="loading" @click="refreshAll">
          {{ loading ? '加载中…' : '刷新' }}
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

    <!-- 日志表格 -->
    <div class="table-wrap">
      <table class="data-table log-table">
        <thead>
          <tr>
            <th class="col-expand"></th>
            <th>时间</th>
            <th>货件号</th>
            <th>店铺</th>
            <th>打印机</th>
            <th>来源</th>
            <th>状态</th>
            <th>耗时</th>
            <th>IP</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!logs.length">
            <td colspan="10" class="empty">{{ loading ? '加载中…' : '暂无打印日志' }}</td>
          </tr>
          <template v-for="log in logs" :key="log.id">
            <tr
              :class="{ 'row-has-error': hasError(log) }"
              @click="hasError(log) && toggleExpand(log.id)"
            >
              <td class="col-expand">
                <span v-if="hasError(log)" class="expand-icon">{{ isExpanded(log.id) ? '▼' : '▶' }}</span>
              </td>
              <td class="col-time">{{ fmtTime(log.created_at) }}</td>
              <td class="col-posting">{{ log.posting_number || '—' }}</td>
              <td>{{ storeNameOf(log.store_id) }}</td>
              <td class="col-printer">
                <span>{{ printerLabel(log.printer) }}</span>
                <span v-if="printerSource(log.printer)" class="printer-src">{{ printerSource(log.printer) }}</span>
              </td>
              <td>{{ sourceLabel(log.source) }}</td>
              <td>
                <span :class="statusTag(log.status)">{{ statusLabel(log.status) }}</span>
              </td>
              <td class="col-duration">{{ fmtDuration(log.duration_ms) }}</td>
              <td class="col-ip">{{ log.ip || '—' }}</td>
              <td class="col-error">
                <span v-if="log.error" class="error-trunc" :title="log.error">{{ log.error }}</span>
                <span v-else class="muted">—</span>
              </td>
            </tr>
            <tr v-if="isExpanded(log.id)" class="row-detail">
              <td :colspan="10">
                <div class="error-detail">
                  <span class="error-type">错误详情:</span>
                  <span class="error-msg">{{ log.error }}</span>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="footer-bar">
      <span class="footer-info">
        共 {{ pager.total }} 条 · 失败 {{ stats?.failed ?? 0 }} 次
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
.print-logs-page {
  padding: 16px;
  max-width: 1400px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 16px;
}

.page-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 6px 0;
  color: var(--text-primary, #111827);
}

.page-desc {
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
  margin: 0;
  line-height: 1.5;
}

/* 日期切换 */
.day-toggle {
  display: inline-flex;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 12px;
  background: var(--bg-card, #fff);
}

.day-btn {
  padding: 6px 18px;
  font-size: 13px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.day-btn.active {
  background: var(--primary, #2563eb);
  color: #fff;
  font-weight: 600;
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
  min-width: 150px;
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
  font-variant-numeric: tabular-nums;
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

/* 打印机分布 */
.printer-stats {
  display: flex;
  gap: 8px 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  padding: 8px 14px;
  background: var(--bg-card, #f9fafb);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  font-size: 12px;
  align-items: center;
}

.ps-title {
  color: var(--text-secondary, #6b7280);
}

.ps-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-elevated, #f3f4f6);
}

.ps-err {
  background: #fef2f2;
}

.ps-name {
  font-weight: 600;
  color: var(--text-primary, #111827);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ps-count {
  color: var(--text-primary, #374151);
}

.ps-break {
  color: var(--text-secondary, #6b7280);
}

.ps-fail {
  color: #ef4444;
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

.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.keyword-input {
  width: 220px;
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
  white-space: nowrap;
  text-align: center;
}

.col-expand {
  width: 28px;
}

.expand-icon {
  font-size: 10px;
  color: var(--text-secondary, #6b7280);
}

.col-time {
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
  font-variant-numeric: tabular-nums;
}

.col-posting {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
  color: var(--text-primary, #111827);
}

.col-printer {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.printer-src {
  margin-left: 4px;
  font-size: 10px;
  color: var(--text-secondary, #9ca3af);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 3px;
  padding: 0 3px;
}

.col-duration {
  font-variant-numeric: tabular-nums;
}

.col-ip {
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
}

.col-error {
  max-width: 260px;
}

.error-trunc {
  display: inline-block;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  color: #ef4444;
}

.muted {
  color: var(--text-secondary, #9ca3af);
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
  text-align: left;
}

.error-detail {
  display: flex;
  gap: 8px;
  font-size: 12px;
  align-items: baseline;
}

.error-type {
  font-weight: 600;
  color: #ef4444;
  flex-shrink: 0;
}

.error-msg {
  color: var(--text-primary, #374151);
  word-break: break-all;
  white-space: pre-wrap;
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