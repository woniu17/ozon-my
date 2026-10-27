<script setup>
// 定时任务执行日志(2026-10-27)
// 三个主子 Tab(分钟级/小时级/天级),展示各定时任务执行记录:
//   - 概览卡:当前级别每个任务最近一次执行状态 + 相对时间(点击筛选该任务)
//   - 筛选:任务/时间范围/状态/关键词 + 自动刷新
//   - 表格:执行时间/任务/状态/耗时/结果摘要/错误,点击行展开 JSON 详情
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import AppTabs from '../components/AppTabs.vue';
import AppPager from '../components/AppPager.vue';
import JsonTree from '../components/JsonTree.vue';
import { getTaskLogTasks, getTaskLogLatest, getTaskLogs } from '../api/task-logs.js';

const LEVELS = [
  { key: 'minute', label: '分钟级' },
  { key: 'hour', label: '小时级' },
  { key: 'day', label: '天级' },
];

const RANGES = [
  { label: '1小时', hours: 1 },
  { label: '6小时', hours: 6 },
  { label: '24小时', hours: 24 },
  { label: '7天', hours: 168 },
];

const PAGE_SIZE = 20;

const activeLevel = ref('minute');
const rangeIdx = ref(1); // 默认 6 小时
const taskDefs = ref([]);
const logs = ref([]);
const latest = ref([]);
const loading = ref(false);
const error = ref('');
const total = ref(0);
const stats = ref({ success: 0, failed: 0, skipped: 0, running: 0 });
const page = ref(1);
const expandedRows = ref(new Set());

const filters = reactive({ task: '', status: '', keyword: '' });

// 自动刷新
const autoRefresh = ref(false);
const refreshInterval = ref(30);
let refreshTimer = null;

// ── 派生 ──────────────────────────────────────────────────
const fromIso = computed(() => new Date(Date.now() - RANGES[rangeIdx.value].hours * 3600_000).toISOString());
const toIso = computed(() => new Date().toISOString());

const tasksInLevel = computed(() => taskDefs.value.filter((d) => d.level === activeLevel.value).sort((a, b) => a.intervalLabel.localeCompare(b.intervalLabel)));

const latestMap = computed(() => {
  const m = {};
  for (const row of latest.value) m[row.task] = row;
  return m;
});

const successRate = computed(() => {
  const ok = stats.value.success || 0;
  const fail = stats.value.failed || 0;
  if (ok + fail === 0) return null;
  return ((ok / (ok + fail)) * 100).toFixed(1);
});

// ── 格式化 ──────────────────────────────────────────────────
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
  return `${Math.floor(diff / 86400_000)}天前`;
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}分${Math.round((ms % 60_000) / 1000)}秒`;
}

function statusClass(s) {
  return {
    success: 'tag tag-ok',
    failed: 'tag tag-err',
    skipped: 'tag tag-muted',
    running: 'tag tag-info',
  }[s] || 'tag tag-muted';
}

function statusLabel(s) {
  return { success: '成功', failed: '失败', skipped: '跳过', running: '运行中' }[s] || s;
}

function taskDef(task) {
  return taskDefs.value.find((d) => d.task === task) || { task, name: task, intervalLabel: '' };
}

function parseData(row) {
  if (!row?.data) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function errorStack(row) {
  const d = parseData(row);
  return d && typeof d === 'object' && d.stack ? d.stack : null;
}

// ── 数据加载 ────────────────────────────────────────────────
async function loadTasks() {
  try {
    taskDefs.value = (await getTaskLogTasks()) || [];
  } catch {
    /* 静默:任务下拉为空时仍可查日志 */
  }
}

async function loadLatest() {
  try {
    latest.value = (await getTaskLogLatest(activeLevel.value)) || [];
  } catch {
    latest.value = [];
  }
}

async function loadLogs() {
  loading.value = true;
  error.value = '';
  try {
    const r = await getTaskLogs({
      level: activeLevel.value,
      task: filters.task || '',
      status: filters.status || '',
      from: fromIso.value,
      to: toIso.value,
      keyword: filters.keyword || '',
      page: page.value,
      pageSize: PAGE_SIZE,
    });
    logs.value = r?.list || [];
    total.value = r?.total || 0;
    stats.value = r?.stats || { success: 0, failed: 0, skipped: 0, running: 0 };
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

function loadAll() {
  loadLatest();
  loadLogs();
}

function onLevelChange() {
  filters.task = '';
  page.value = 1;
  expandedRows.value.clear();
  loadAll();
}

function setRange(i) {
  rangeIdx.value = i;
  onRangeChange();
}

function onRangeChange() {
  page.value = 1;
  loadLogs();
}

function search() {
  page.value = 1;
  expandedRows.value.clear();
  loadLogs();
}

function filterByTask(taskKey) {
  filters.task = filters.task === taskKey ? '' : taskKey;
  page.value = 1;
  expandedRows.value.clear();
  loadLogs();
}

function onPageChange(p) {
  page.value = p;
  loadLogs();
}

function toggleExpand(id) {
  const s = new Set(expandedRows.value);
  s.has(id) ? s.delete(id) : s.add(id);
  expandedRows.value = s;
}

function isExpanded(id) {
  return expandedRows.value.has(id);
}

function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value;
  if (autoRefresh.value) {
    refreshTimer = setInterval(loadAll, refreshInterval.value * 1000);
  } else if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function onIntervalChange() {
  if (autoRefresh.value) {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(loadAll, refreshInterval.value * 1000);
  }
}

onMounted(() => {
  loadTasks();
  loadAll();
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <div class="page">
    <h2>定时任务日志</h2>
    <p class="page-hint">查看各定时任务是否按周期执行、执行是否成功、耗时与错误详情（高频轮询器每 5 分钟节流汇总一条）。</p>

    <!-- 概览卡:当前级别每个任务最近一次执行 -->
    <div class="ov-cards">
      <button
        v-for="def in tasksInLevel"
        :key="def.task"
        class="ov-card"
        :class="{ active: filters.task === def.task }"
        :title="`点击筛选:${def.name}`"
        @click="filterByTask(def.task)"
      >
        <div class="ov-name">{{ def.name }}</div>
        <div class="ov-status-row">
          <span class="status-dot" :class="latestMap[def.task]?.status || 'none'"></span>
          <span class="ov-status-text" :class="{ 'muted': !latestMap[def.task] }">
            {{ latestMap[def.task] ? statusLabel(latestMap[def.task].status) : '暂无记录' }}
          </span>
        </div>
        <div class="ov-time">{{ latestMap[def.task] ? fmtRelative(latestMap[def.task].started_at) : '—' }}</div>
        <div class="ov-interval">{{ def.intervalLabel }}</div>
      </button>
      <div v-if="!tasksInLevel.length" class="empty-hint">该级别暂无任务定义</div>
    </div>

    <!-- 主子 Tab -->
    <AppTabs :tabs="LEVELS" :model-value="activeLevel" @update:model-value="(v) => { activeLevel = v; onLevelChange(); }" />

    <!-- 筛选栏 -->
    <div class="filter-bar task-filter-bar">
      <div class="range-group">
        <button v-for="(r, i) in RANGES" :key="r.label" class="range-btn" :class="{ active: rangeIdx === i }" @click="setRange(i)">
          {{ r.label }}
        </button>
      </div>
      <select v-model="filters.task" class="filter-select" @change="search">
        <option value="">全部任务</option>
        <option v-for="def in tasksInLevel" :key="def.task" :value="def.task">{{ def.name }}（{{ def.intervalLabel }}）</option>
      </select>
      <select v-model="filters.status" class="filter-select" @change="search">
        <option value="">全部状态</option>
        <option value="success">成功</option>
        <option value="failed">失败</option>
        <option value="skipped">跳过</option>
        <option value="running">运行中</option>
      </select>
      <input v-model="filters.keyword" class="filter-input task-keyword" placeholder="搜索任务名/摘要/错误" @keyup.enter="search" />
      <button class="btn btn-primary" @click="search">查询</button>
      <button class="btn btn-ghost" @click="loadAll" :disabled="loading">{{ loading ? '加载中…' : '刷新' }}</button>
      <div class="refresh-ctrl">
        <label class="auto-refresh-toggle">
          <input type="checkbox" :checked="autoRefresh" @change="toggleAutoRefresh" />
          自动刷新
        </label>
        <select v-model="refreshInterval" class="filter-select interval-select" :disabled="!autoRefresh" @change="onIntervalChange">
          <option :value="10">10秒</option>
          <option :value="30">30秒</option>
          <option :value="60">60秒</option>
        </select>
      </div>
    </div>

    <!-- 汇总行 -->
    <div class="summary-line">
      <span v-if="error" class="error-text">{{ error }}</span>
      <template v-else>
        <span>共 <b>{{ total }}</b> 条</span>
        <span class="sum-ok">成功 {{ stats.success }}</span>
        <span v-if="stats.failed" class="sum-fail">失败 {{ stats.failed }}</span>
        <span v-if="stats.skipped" class="sum-skip">跳过 {{ stats.skipped }}</span>
        <span v-if="successRate !== null" class="sum-rate">成功率 {{ successRate }}%</span>
      </template>
    </div>

    <!-- 日志表格 -->
    <div class="table-wrap task-table-wrap">
      <table class="data-table task-log-table">
        <thead>
          <tr>
            <th class="col-expand"></th>
            <th>执行时间</th>
            <th>任务</th>
            <th>状态</th>
            <th>耗时</th>
            <th>结果摘要</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!logs.length">
            <td colspan="7" class="empty">{{ loading ? '加载中…' : '暂无执行记录（任务可能还没到执行周期）' }}</td>
          </tr>
          <template v-for="log in logs" :key="log.id">
            <tr
              :class="{ 'row-has-error': log.status === 'failed', 'row-expanded': isExpanded(log.id) }"
              :title="log.data ? '点击展开详情' : ''"
              @click="log.data ? toggleExpand(log.id) : null"
            >
              <td class="col-expand">
                <span v-if="log.data" class="expand-icon">{{ isExpanded(log.id) ? '▼' : '▶' }}</span>
              </td>
              <td class="col-time">
                <div>{{ fmtTime(log.started_at) }}</div>
                <div class="time-rel">{{ fmtRelative(log.started_at) }}</div>
              </td>
              <td>
                <div class="task-name">{{ taskDef(log.task).name || log.task }}</div>
                <div class="task-interval">{{ taskDef(log.task).intervalLabel }}</div>
              </td>
              <td>
                <span :class="statusClass(log.status)">{{ statusLabel(log.status) }}</span>
              </td>
              <td class="col-duration">{{ fmtDuration(log.duration_ms) }}</td>
              <td class="col-detail" :title="log.detail || ''">{{ log.detail || '—' }}</td>
              <td class="col-error" :title="log.error || ''">
                <span v-if="log.error" class="error-text">{{ log.error }}</span>
                <span v-else>—</span>
              </td>
            </tr>
            <tr v-if="isExpanded(log.id)" class="row-detail">
              <td colspan="7">
                <div class="task-detail">
                  <div v-if="log.detail" class="detail-line"><b>结果:</b> {{ log.detail }}</div>
                  <div v-if="log.error" class="detail-line detail-error"><b>错误:</b> {{ log.error }}</div>
                  <div v-if="errorStack(log)" class="detail-line detail-stack"><b>堆栈:</b>
                    <pre>{{ errorStack(log) }}</pre>
                  </div>
                  <div v-if="parseData(log)" class="detail-json">
                    <JsonTree :data="parseData(log)" :default-expand-level="2" root-key="详情数据" />
                  </div>
                  <div v-if="!log.detail && !log.error && !parseData(log)" class="no-error">无更多详情</div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="footer-bar">
      <span class="footer-info">第 {{ page }} 页 / 每页 {{ PAGE_SIZE }} 条</span>
      <AppPager :model-value="page" :total="total" :page-size="PAGE_SIZE" @update:model-value="onPageChange" />
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 16px;
  max-width: 1400px;
  margin: 0 auto;
}

h2 {
  margin: 0 0 4px;
  font-size: 18px;
}

.page-hint {
  color: var(--muted);
  font-size: 12px;
  margin: 0 0 12px;
}

.empty-hint {
  color: var(--muted);
  padding: 12px;
}

/* ── 概览卡 ── */
.ov-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.ov-card {
  flex: 1 1 150px;
  max-width: 180px;
  min-width: 140px;
  text-align: left;
  padding: 8px 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  font-size: 12px;
  color: var(--text);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.ov-card:hover {
  border-color: var(--primary);
}

.ov-card.active {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.ov-name {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ov-status-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex: none;
}

.status-dot.success {
  background: var(--success);
}

.status-dot.failed {
  background: var(--danger);
}

.status-dot.skipped {
  background: var(--muted);
}

.status-dot.running {
  background: var(--info);
}

.status-dot.none {
  background: #d1d5db;
}

.ov-status-text {
  font-size: 12px;
  font-weight: 500;
}

.ov-time {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}

.ov-interval {
  font-size: 10px;
  color: #9ca3af;
  margin-top: 2px;
}

/* ── 筛选栏 ── */
.task-filter-bar {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}

.range-group {
  display: flex;
  gap: 4px;
}

.range-btn {
  padding: 4px 10px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
  color: var(--text);
}

.range-btn.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}

.task-keyword {
  min-width: 180px;
}

.refresh-ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
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
  width: 76px;
}

/* ── 汇总行 ── */
.summary-line {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 12px;
  color: var(--muted);
  padding: 4px 2px 8px;
  flex-wrap: wrap;
}

.sum-ok {
  color: var(--success);
}

.sum-fail {
  color: var(--danger);
}

.sum-skip {
  color: var(--muted);
}

.sum-rate {
  font-weight: 600;
  color: var(--text);
}

/* ── 表格 ── */
.task-table-wrap {
  padding: 0;
  max-height: 65vh;
}

.task-log-table {
  font-size: 12px;
}

.task-log-table th,
.task-log-table td {
  padding: 8px 10px;
  vertical-align: top;
}

.col-expand {
  width: 24px;
}

.expand-icon {
  font-size: 10px;
  color: var(--muted);
}

.col-time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.time-rel {
  font-size: 10px;
  color: #9ca3af;
}

.task-name {
  font-weight: 500;
}

.task-interval {
  font-size: 10px;
  color: #9ca3af;
}

.col-duration {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.col-detail {
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-error {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--danger);
}

.row-has-error {
  cursor: pointer;
}

.row-has-error:hover {
  background: #fef2f2;
}

.row-expanded {
  background: #f9fafb;
}

.row-detail td {
  background: #fafafa;
  padding: 10px 16px 12px 40px;
}

.task-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.detail-line {
  word-break: break-all;
}

.detail-error {
  color: var(--danger);
}

.detail-stack pre {
  background: #f3f4f6;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font-size: 11px;
  overflow: auto;
  max-height: 240px;
  white-space: pre-wrap;
  word-break: break-all;
}

.detail-json {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  background: #fff;
}

.no-error {
  color: #9ca3af;
}
</style>