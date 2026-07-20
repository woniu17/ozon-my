<script setup>
// 浅度采集日志:记录店铺页扫描发现的每个 SKU + 是否通过过滤
// 与深度采集日志的区别:
//   深度:SW 入队后实际执行采集流程后的完整记录(有 status/results/totalDuration)
//   浅度:仅记录"发现了某 SKU + 是否通过过滤"(无 status,有 passesFilter/skipReason)
// 用途:排查过滤效果(为什么有些 SKU 被略过)+ 浅度采集统计
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue';
import { getShallowCollectStats, getShallowCollectLogs } from '../api/cache.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();

// 统计数据
const stats = ref({});

// 日志列表
const logs = ref([]);

// 筛选条件
// 2026-07:sellerId 优先(稳定主键);sellerSlug 兼容(可变,店铺改名时变)
const filters = reactive({
  sku: '',
  passesFilter: '', // '' | '0' | '1'
  skipReason: '',
  source: '',
  sellerId: '',
});

// 跳过原因选项(对齐后端 SHALLOW_SKIP_REASONS)
const SKIP_REASONS = [
  { value: 'no-rating', label: '无评论' },
  { value: 'price-below-min', label: '价格低于下限' },
  { value: 'price-above-max', label: '价格高于上限' },
  { value: 'price-invalid', label: '价格无效' },
  { value: 'rating-below-min', label: '评论数低于下限' },
  { value: 'rating-above-max', label: '评论数高于上限' },
];

const SKIP_REASON_LABELS = Object.fromEntries(SKIP_REASONS.map((r) => [r.value, r.label]));

const SOURCES = [
  { value: 'api-scroller', label: 'API 直取' },
  { value: 'dom-scroller', label: 'DOM 滚动' },
  { value: 'shop-page', label: '店铺页' },
  { value: 'pdp', label: '详情页' },
];

const SOURCE_LABELS = Object.fromEntries(SOURCES.map((s) => [s.value, s.label]));

// 分页
const pager = reactive({
  current: 1,
  total: 0,
  pageSize: 50,
});

// 自动刷新
const autoRefresh = ref(false);
const refreshInterval = ref(5);
let refreshTimer = null;

// 加载状态
const loading = ref(false);

// ── 数据加载 ───────────────────────────────────────────────
async function loadStats() {
  try {
    stats.value = await getShallowCollectStats();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function loadLogs() {
  loading.value = true;
  try {
    const data = await getShallowCollectLogs({
      sku: filters.sku.trim(),
      passesFilter: filters.passesFilter,
      skipReason: filters.skipReason,
      source: filters.source,
      sellerId: filters.sellerId.trim(),
      currentPage: pager.current,
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
  loadLogs();
}

function onPageChange(p) {
  pager.current = p;
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

// ── 格式化工具 ─────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtPrice(p) {
  if (p == null) return '—';
  return Number(p).toFixed(2);
}

function sourceLabel(s) {
  return SOURCE_LABELS[s] || s || '—';
}

function skipReasonLabel(r) {
  if (!r) return '—';
  return SKIP_REASON_LABELS[r] || r;
}

function passTag(passes) {
  return passes ? 'tag tag-ok' : 'tag tag-err';
}

function passLabel(passes) {
  return passes ? '通过' : '略过';
}

// 统计:通过率
const passRate = computed(() => {
  const today = stats.value?.today;
  if (!today || !today.total) return 0;
  return Math.round((today.passed / today.total) * 100);
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
  <div class="shallow-logs-page">
    <!-- 统计卡片 -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">今日扫描</div>
        <div class="stat-value">{{ stats.today?.total || 0 }}</div>
        <div class="stat-sub">总 SKU 数</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">通过率</div>
        <div
          class="stat-value"
          :class="{
            'stat-ok': passRate >= 80,
            'stat-warn': passRate < 80 && passRate >= 50,
            'stat-err': passRate < 50,
          }"
        >
          {{ passRate }}%
        </div>
        <div class="stat-sub">通过 {{ stats.today?.passed || 0 }} / 略过 {{ stats.today?.skipped || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">本周扫描</div>
        <div class="stat-value">{{ stats.week?.total || 0 }}</div>
        <div class="stat-sub">通过 {{ stats.week?.passed || 0 }} / 略过 {{ stats.week?.skipped || 0 }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">主要略过原因</div>
        <div class="stat-value" style="font-size: 14px">
          <template v-if="stats.today?.skipReasonCounts">
            <span v-for="(v, k) in stats.today.skipReasonCounts" :key="k" v-show="v > 0">
              {{ skipReasonLabel(k) }}: {{ v }};
            </span>
            <span v-if="stats.today.skipReasonNull > 0">其他: {{ stats.today.skipReasonNull }};</span>
          </template>
          <span v-else>—</span>
        </div>
        <div class="stat-sub">今日</div>
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
        <select v-model="filters.passesFilter" class="filter-input" @change="searchLogs">
          <option value="">全部</option>
          <option value="1">通过</option>
          <option value="0">略过</option>
        </select>
        <select v-model="filters.skipReason" class="filter-input" @change="searchLogs">
          <option value="">全部原因</option>
          <option v-for="r in SKIP_REASONS" :key="r.value" :value="r.value">{{ r.label }}</option>
        </select>
        <select v-model="filters.source" class="filter-input" @change="searchLogs">
          <option value="">全部来源</option>
          <option v-for="s in SOURCES" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
        <input
          class="filter-input"
          type="text"
          v-model.trim="filters.sellerId"
          placeholder="卖家 ID"
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
            <th class="col-sku">SKU</th>
            <th>商品名称</th>
            <th>价格</th>
            <th>评论数</th>
            <th>过滤</th>
            <th>略过原因</th>
            <th>来源</th>
            <th>卖家</th>
            <th>发现时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!logs.length">
            <td colspan="9" class="empty">{{ loading ? '加载中...' : '暂无日志记录' }}</td>
          </tr>
          <tr v-for="log in logs" :key="log._id || (log.sku + log.collectedAt)">
            <td class="col-sku">{{ log.sku }}</td>
            <td class="col-name">{{ log.name || '—' }}</td>
            <td>{{ fmtPrice(log.price) }}</td>
            <td>{{ log.ratingCount ?? '—' }}</td>
            <td>
              <span :class="passTag(log.passesFilter)">{{ passLabel(log.passesFilter) }}</span>
            </td>
            <td>{{ skipReasonLabel(log.skipReason) }}</td>
            <td>{{ sourceLabel(log.source) }}</td>
            <td>{{ log.sellerId || log.sellerSlug || '—' }}</td>
            <td class="col-time">{{ fmtTime(log.collectedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="footer-bar">
      <span class="footer-info">共 {{ pager.total }} 条</span>
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
.shallow-logs-page {
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
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.filter-input {
  padding: 6px 10px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg-card, #fff);
  color: var(--text-primary, #111827);
  min-width: 80px;
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

.col-sku {
  text-align: left;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.col-name {
  text-align: left;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-time {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
}

.tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.tag-ok {
  background: #dcfce7;
  color: #16a34a;
}

.tag-err {
  background: #fee2e2;
  color: #ef4444;
}

.tag-warn {
  background: #fef3c7;
  color: #f59e0b;
}

.tag-mute {
  background: #f3f4f6;
  color: #6b7280;
}

.empty {
  text-align: center;
  padding: 32px 0;
  color: var(--text-secondary, #9ca3af);
}

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
