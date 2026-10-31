<script setup>
// 店铺健康-错误指数(2026-11-03)
// 数据源:Ozon /v1/rating/index/fbs/info + /v1/rating/index/fbs/posting/list(后端落库)
// 展示:错误指数概览 / 每日趋势 / 类型与配送方案分布 / 影响货件明细
// 设计文档: docs/店铺健康页面-功能设计.md
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { getRatingSummary, getRatingErrors, triggerRatingSync, getRatingSyncStatus } from '../api/store-health.js';

const router = useRouter();

// ── 时间预设(日期粒度,不涉及时区日界)────────────────────────
const presets = [
  { key: '7d', label: '近7日' },
  { key: '30d', label: '近30日' },
  { key: 'thisMonth', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'custom', label: '自定义' },
];
const activePreset = ref('30d');
const fromDate = ref('');
const toDate = ref('');

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function shiftDays(base, n) {
  const d = new Date(`${base}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function presetRange(key) {
  const today = todayStr();
  switch (key) {
    case '7d': return { from: shiftDays(today, -6), to: today };
    case '30d': return { from: shiftDays(today, -29), to: today };
    case 'thisMonth': {
      const d = new Date();
      return { from: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`, to: today };
    }
    case 'lastMonth': {
      const d = new Date();
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const lm = m === 1 ? 12 : m - 1;
      const ly = m === 1 ? y - 1 : y;
      const first = `${ly}-${pad(lm)}-01`;
      const last = shiftDays(`${y}-${pad(m)}-01`, -1);
      return { from: first, to: last };
    }
    default: return null;
  }
}
function applyPreset(key) {
  activePreset.value = key;
  const r = presetRange(key);
  if (r) {
    fromDate.value = r.from;
    toDate.value = r.to;
  }
  pager.offset = 0;
  loadAll();
}
function onCustomChange() {
  if (!fromDate.value || !toDate.value) return;
  if (fromDate.value > toDate.value) {
    const t = fromDate.value;
    fromDate.value = toDate.value;
    toDate.value = t;
  }
  pager.offset = 0;
  loadAll();
}

// ── 店铺选择(多选,空=全选)──────────────────────────────────
const allStores = ref([]);
const selectedStoreIds = ref([]);
const storeDropdownOpen = ref(false);
const storeSelectionLabel = computed(() => {
  const all = allStores.value;
  if (all.length === 0) return '全部店铺';
  if (selectedStoreIds.value.length === 0) return `全部店铺(${all.length})`;
  const names = all.filter((s) => selectedStoreIds.value.includes(s.id)).map((s) => s.name);
  return names.length <= 2 ? names.join(',') : `${names.length}家店铺`;
});
function isStoreIncluded(id) {
  return selectedStoreIds.value.length === 0 || selectedStoreIds.value.includes(id);
}
function handleStoreCheckbox(id) {
  const set = new Set(selectedStoreIds.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  selectedStoreIds.value = [...set];
  if (selectedStoreIds.value.length === allStores.value.length) selectedStoreIds.value = [];
  pager.offset = 0;
  loadAll();
}
function selectAllStores() {
  selectedStoreIds.value = [];
  pager.offset = 0;
  loadAll();
}
function selectNoStores() {
  selectedStoreIds.value = allStores.value.map((s) => s.id);
  pager.offset = 0;
  loadAll();
}

// ── 数据加载 ─────────────────────────────────────────────────
const summary = ref(null);
const errors = ref(null);
const loading = ref(false);
const error = ref('');
const syncError = ref('');
const syncing = ref(false);

function storeIdsParam() {
  return selectedStoreIds.value.length ? selectedStoreIds.value.join(',') : '';
}

async function loadSummary() {
  try {
    summary.value = await getRatingSummary({
      from: fromDate.value,
      to: toDate.value,
      storeIds: storeIdsParam(),
    });
  } catch (e) {
    error.value = e.message;
  }
}

async function loadErrors() {
  try {
    errors.value = await getRatingErrors({
      from: fromDate.value,
      to: toDate.value,
      storeIds: storeIdsParam(),
      offset: pager.offset,
      limit: pager.limit,
    });
  } catch (e) {
    error.value = e.message;
  }
}

async function loadAll() {
  loading.value = true;
  error.value = '';
  await Promise.all([loadSummary(), loadErrors()]);
  loading.value = false;
}

// ── 手动同步 ─────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function doSync() {
  if (syncing.value) return;
  syncing.value = true;
  syncError.value = '';
  try {
    await triggerRatingSync({
      storeIds: selectedStoreIds.value.length ? selectedStoreIds.value : undefined,
      from: fromDate.value,
      to: toDate.value,
    });
    // 轮询同步状态(最多 60s),完成后刷新
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const st = await getRatingSyncStatus();
      if (!st.running) break;
    }
    await loadAll();
  } catch (e) {
    syncError.value = e.message;
  } finally {
    syncing.value = false;
  }
}

// ── 概览指标 ─────────────────────────────────────────────────
const topStore = computed(() => {
  const stores = summary.value?.stores || [];
  if (stores.length === 0) return null;
  return [...stores].sort((a, b) => (Number(b.index) || 0) - (Number(a.index) || 0))[0];
});
function indexStatus(idx) {
  const n = Number(idx) || 0;
  // 本地参考阈值:<=0.15 OK,<=0.35 WARNING,>0.35 CRITICAL(非官方,仅页面视觉提示)
  if (n <= 0.15) return 'ok';
  if (n <= 0.35) return 'warning';
  return 'critical';
}
const totals = computed(() => summary.value?.totals || null);

// ── 趋势图(指数折线 + 费用柱状)─────────────────────────────
const STORE_COLORS = ['#165dff', '#00b42a', '#d97706', '#722ed1', '#eb2f96', '#13c2c2', '#fa8c16'];
const chartSeries = computed(() => {
  const stores = summary.value?.stores || [];
  return stores.map((s, i) => ({
    storeId: s.storeId,
    storeName: s.storeName,
    color: STORE_COLORS[i % STORE_COLORS.length],
    points: (s.defects || [])
      .filter((d) => d.date >= fromDate.value && d.date <= toDate.value)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({ date: d.date, value: Number(d.indexByDate) || 0 })),
  }));
});
const chartDates = computed(() => {
  const set = new Set();
  for (const s of chartSeries.value) for (const p of s.points) set.add(p.date);
  return [...set].sort();
});
const chartMax = computed(() => {
  let m = 0;
  for (const s of chartSeries.value) for (const p of s.points) m = Math.max(m, p.value);
  return m > 0 ? m * 1.2 : 1;
});
const SVG_W = 720;
const SVG_H = 180;
function pointXY(series, date, idx) {
  const x = chartDates.value.length <= 1 ? 20 : 20 + (idx / (chartDates.value.length - 1)) * (SVG_W - 40);
  const y = SVG_H - 24 - (series.points[idx].value / chartMax.value) * (SVG_H - 48);
  return { x, y };
}
function polylinePoints(series) {
  return series.points.map((p, i) => {
    const { x, y } = pointXY(series, p.date, i);
    return `${x},${y}`;
  }).join(' ');
}
function lastPoint(series) {
  const i = Math.min(series.points.length - 1, chartDates.value.length - 1);
  return series.points[i] ? pointXY(series, series.points[i].date, i) : null;
}
// 费用柱状:按日期汇总(多店相加)
const costBars = computed(() => {
  const map = new Map();
  for (const s of chartSeries.value) {
    for (const p of s.points) {
      const key = p.date;
      const cost = Number(summary.value?.stores.find((st) => st.storeId === s.storeId)?.defects.find((d) => d.date === key)?.processingCostsSumByDate) || 0;
      map.set(key, (map.get(key) || 0) + cost);
    }
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, total]) => ({ date, total }));
});
const costMax = computed(() => {
  let m = 0;
  for (const b of costBars.value) m = Math.max(m, b.total);
  return m > 0 ? m : 1;
});

// ── 分布卡片 ─────────────────────────────────────────────────
const typeDist = computed(() => {
  const t = totals.value;
  if (!t) return [];
  const items = [
    { key: 'SELLER_CANCELLATION', label: '卖家取消', count: t.sellerCancellationCount, color: '#f53f3f' },
    { key: 'SELLER_DELAY', label: '卖家逾期', count: t.sellerDelayCount, color: '#d97706' },
  ];
  const total = t.errorPostingCount || 1;
  return items.map((it) => ({ ...it, pct: Math.round((it.count / total) * 100) }));
});

// ── 明细分页 ─────────────────────────────────────────────────────
const pager = reactive({ offset: 0, limit: 20 });
const totalItems = computed(() => errors.value?.total || 0);
const pageCount = computed(() => Math.max(1, Math.ceil(totalItems.value / pager.limit)));
const currentPage = computed(() => Math.floor(pager.offset / pager.limit) + 1);
function prevPage() {
  if (pager.offset <= 0) return;
  pager.offset = Math.max(0, pager.offset - pager.limit);
  loadErrors();
}
function nextPage() {
  if (pager.offset + pager.limit >= totalItems.value) return;
  pager.offset += pager.limit;
  loadErrors();
}
function goOrder(postingNumber) {
  router.push({ path: '/order-process', query: { kw: postingNumber } });
}

// ── 格式化 ───────────────────────────────────────────────────
function fmtNum(n) {
  return String(Number(n) || 0);
}
function fmtMoney(n) {
  return (Number(n) || 0).toFixed(2);
}
function fmtIndex(n) {
  return (Number(n) || 0).toFixed(2);
}
function fmtPct(n) {
  return ((Number(n) || 0) * 100).toFixed(2);
}
function indexColor(idx) {
  const s = indexStatus(idx);
  return s === 'ok' ? '#00b42a' : s === 'warning' ? '#d97706' : '#f53f3f';
}
function indexBarWidth(idx) {
  const n = Number(idx) || 0;
  return Math.max(2, Math.min(100, (Math.min(n, 0.5) / 0.5) * 100));
}
/** 全部店铺按错误指数降序(供店铺指数列表) */
const sortedStores = computed(() => {
  const stores = summary.value?.stores || [];
  return [...stores].sort((a, b) => (Number(b.index) || 0) - (Number(a.index) || 0));
});
function typeLabel(t) {
  return t === 'SELLER_CANCELLATION' ? '卖家取消' : t === 'SELLER_DELAY' ? '卖家逾期' : t || '未知';
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 生命周期 ─────────────────────────────────────────────────────
onMounted(() => {
  // 初始化默认时间范围(默认近30日:错误货件稀疏,近7日可能为空)
  const r = presetRange('30d');
  fromDate.value = r.from;
  toDate.value = r.to;
  // 加载店铺列表(复用订单统计的店铺接口)
  import('../api/order-stats.js').then((m) => m.getOrderStatsStores()).then((res) => {
    allStores.value = res?.stores || [];
  }).catch(() => { /* 店铺列表加载失败不阻塞页面 */ });
  loadAll();
  document.addEventListener('click', closeStoreDropdown);
});
onUnmounted(() => {
  document.removeEventListener('click', closeStoreDropdown);
});
function closeStoreDropdown() {
  storeDropdownOpen.value = false;
}
</script>

<template>
  <div class="store-health">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <div class="preset-group">
        <button
          v-for="p in presets"
          :key="p.key"
          class="btn btn-sm"
          :class="{ 'btn-primary': activePreset === p.key, 'btn-ghost': activePreset !== p.key }"
          @click="applyPreset(p.key)"
        >{{ p.label }}</button>
      </div>

      <div class="date-range" :class="{ disabled: activePreset !== 'custom' }">
        <input class="filter-input" type="date" v-model="fromDate" :disabled="activePreset !== 'custom'" @change="onCustomChange" />
        <span class="sep">—</span>
        <input class="filter-input" type="date" v-model="toDate" :disabled="activePreset !== 'custom'" @change="onCustomChange" />
      </div>

      <div class="multi-select" @click.stop>
        <button class="btn btn-ghost btn-sm" @click="storeDropdownOpen = !storeDropdownOpen">
          {{ storeSelectionLabel }} <span class="caret">▾</span>
        </button>
        <div v-if="storeDropdownOpen" class="multi-select-panel">
          <div class="multi-select-actions">
            <button class="btn btn-sm btn-ghost" @click="selectAllStores">全选</button>
            <button class="btn btn-sm btn-ghost" @click="selectNoStores">全不选</button>
          </div>
          <label v-for="s in allStores" :key="s.id" class="multi-select-item">
            <input type="checkbox" :checked="isStoreIncluded(s.id)" @change="handleStoreCheckbox(s.id)" />
            <span>{{ s.name }}</span>
          </label>
          <div class="multi-select-empty" v-if="allStores.length === 0">无店铺数据</div>
        </div>
      </div>

      <button class="btn btn-primary btn-sm sync-btn" :disabled="syncing" @click="doSync">
        {{ syncing ? '同步中…' : '🔄 同步数据' }}
      </button>
    </div>

    <div class="range-hint">
      统计区间:{{ fromDate }} ~ {{ toDate }} · 错误指数为周期汇总(本地参考阈值着色)
    </div>

    <div v-if="syncError" class="error-bar">同步失败:{{ syncError }}</div>
    <div v-if="error" class="error-bar">加载失败:{{ error }}</div>

    <!-- 加载状态 -->
    <div v-if="loading && !summary" class="summary-skeleton">
      <div class="skeleton-card" v-for="i in 4" :key="i"></div>
    </div>

    <!-- ═══ 概览指标卡 ═══ -->
    <div class="summary-cards" v-if="summary && summary.stores.length > 0">
      <div class="summary-card card-index">
        <div class="sc-head">
          <span class="sc-icon">🏥</span><span>错误指数</span>
          <span class="status-dot" :class="indexStatus(topStore.index)"></span>
        </div>
        <div class="sc-count">{{ fmtPct(topStore.index) }}%</div>
        <div class="sc-sub">最高风险:{{ topStore.storeName }}</div>
        <div class="sc-sub">{{ topStore.periodFrom }} ~ {{ topStore.periodTo }}</div>
      </div>
      <div class="summary-card card-cost">
        <div class="sc-head"><span class="sc-icon">💰</span><span>错误处理费用</span></div>
        <div class="sc-count">¥ {{ fmtMoney(totals.chargeSum) }}</div>
        <div class="sc-sub">{{ totals.errorPostingCount }} 单计费</div>
      </div>
      <div class="summary-card card-errors">
        <div class="sc-head"><span class="sc-icon">📦</span><span>影响货件</span></div>
        <div class="sc-count">{{ fmtNum(totals.errorPostingCount) }} 单</div>
        <div class="sc-sub">
          <span class="red-text">取消 {{ fmtNum(totals.sellerCancellationCount) }}</span>
          <span class="sep">·</span>
          <span class="orange-text">逾期 {{ fmtNum(totals.sellerDelayCount) }}</span>
        </div>
      </div>
      <div class="summary-card card-grace">
        <div class="sc-head"><span class="sc-icon">🛡️</span><span>宽限货件</span></div>
        <div class="sc-count">{{ fmtNum(totals.graceCount) }} 单</div>
        <div class="sc-sub">has_grace_status=true,可申诉</div>
      </div>
    </div>
    <div v-else-if="summary && summary.stores.length === 0" class="empty-tip">
      暂无错误指数数据,请点击「同步数据」拉取 Ozon 最新数据。
    </div>

    <!-- ═══ 店铺错误指数列表 ═══ -->
    <div class="store-list-card" v-if="summary && summary.stores.length > 0">
      <h3>店铺错误指数</h3>
      <div class="store-index-row" v-for="s in sortedStores" :key="s.storeId">
        <span class="status-dot" :class="indexStatus(s.index)"></span>
        <span class="sl-name">{{ s.storeName }}</span>
        <div class="sl-track">
          <div class="sl-fill" :style="{ width: indexBarWidth(s.index) + '%', background: indexColor(s.index) }"></div>
        </div>
        <span class="sl-pct" :style="{ color: indexColor(s.index) }">{{ fmtPct(s.index) }}%</span>
        <span class="sl-cost">¥{{ fmtMoney(s.processingCostsSum) }}</span>
      </div>
    </div>

    <!-- ═══ 趋势图 ═══ -->
    <div class="chart-row" v-if="summary && chartSeries.some((s) => s.points.length)">
      <div class="chart-card">
        <h3>每日错误指数趋势</h3>
        <svg :viewBox="`0 0 ${SVG_W} ${SVG_H}`" class="line-chart" preserveAspectRatio="none">
          <!-- 网格线 -->
          <line v-for="g in 4" :key="g" :x1="20" :x2="SVG_W - 20" :y1="24 + (g - 1) * ((SVG_H - 48) / 3)" :y2="24 + (g - 1) * ((SVG_H - 48) / 3)" class="grid-line" />
          <!-- 折线 -->
          <polyline
            v-for="s in chartSeries"
            :key="s.storeId"
            :points="polylinePoints(s)"
            :stroke="s.color"
            fill="none"
            stroke-width="2"
          />
          <!-- 末端圆点 -->
          <template v-for="s in chartSeries" :key="'dot' + s.storeId">
            <circle
              v-if="lastPoint(s)"
              :cx="lastPoint(s).x"
              :cy="lastPoint(s).y"
              :fill="s.color"
              r="3"
            />
          </template>
        </svg>
        <div class="legend">
          <span v-for="s in chartSeries" :key="'lg' + s.storeId" class="legend-item">
            <i :style="{ background: s.color }"></i>{{ s.storeName }}
          </span>
        </div>
      </div>

      <div class="chart-card">
        <h3>每日错误处理费用</h3>
        <div class="cost-bars">
          <div v-for="b in costBars" :key="b.date" class="bar-col" :title="`${b.date}: ¥${fmtMoney(b.total)}`">
            <div class="bar-track">
              <div class="bar-fill" :style="{ height: Math.max(2, (b.total / costMax) * 100) + '%' }"></div>
            </div>
            <div class="bar-date">{{ b.date.slice(5) }}</div>
          </div>
        </div>
        <div class="bar-max-hint">最高 ¥{{ fmtMoney(costMax) }}</div>
      </div>
    </div>

    <!-- ═══ 分布统计 ═══ -->
    <div class="dist-row" v-if="summary && totals && totals.errorPostingCount > 0">
      <div class="dist-card">
        <h3>错误类型分布</h3>
        <div v-for="it in typeDist" :key="it.key" class="dist-item">
          <div class="dist-head">
            <span class="dist-label" :style="{ color: it.color }">{{ it.label }}</span>
            <span class="dist-num">{{ it.count }} 单 · {{ it.pct }}%</span>
          </div>
          <div class="dist-track">
            <div class="dist-fill" :style="{ width: it.pct + '%', background: it.color }"></div>
          </div>
        </div>
      </div>
      <div class="dist-card">
        <h3>配送方案分布</h3>
        <div v-for="s in totals.schemaCounts" :key="s.deliverySchema" class="dist-item">
          <div class="dist-head">
            <span class="dist-label">{{ s.deliverySchema }}</span>
            <span class="dist-num">{{ s.n }} 单</span>
          </div>
          <div class="dist-track">
            <div class="dist-fill" :style="{ width: (s.n / totals.errorPostingCount) * 100 + '%', background: '#165dff' }"></div>
          </div>
        </div>
        <div v-if="!totals.schemaCounts?.length" class="dist-empty">无数据</div>
      </div>
    </div>

    <!-- ═══ 影响货件明细 ═══ -->
    <div class="table-wrap" v-if="errors">
      <table class="stats-table">
        <thead>
          <tr>
            <th>店铺</th>
            <th>货件号</th>
            <th>错误类型</th>
            <th>出错日期</th>
            <th class="col-num">货件价值</th>
            <th class="col-num">处理费用</th>
            <th>宽限</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in errors.items" :key="it.storeId + it.postingNumber">
            <td>{{ it.storeName }}</td>
            <td>
              <a class="posting-link" @click="goOrder(it.postingNumber)">{{ it.postingNumber }}</a>
            </td>
            <td>
              <span class="tag" :class="it.postingErrorType === 'SELLER_CANCELLATION' ? 'tag-cancel' : 'tag-delay'">{{ typeLabel(it.postingErrorType) }}</span>
            </td>
            <td>{{ fmtTime(it.errorAt) }}</td>
            <td class="col-num">{{ fmtMoney(it.productPrice) }} {{ it.productCurrencyCode }}</td>
            <td class="col-num red-text">{{ fmtMoney(it.chargePrice) }} {{ it.chargeCurrencyCode }}</td>
            <td>
              <span class="grace-tag" :class="it.hasGraceStatus ? 'grace-yes' : 'grace-no'">
                {{ it.hasGraceStatus ? '宽限' : '计费' }}
              </span>
            </td>
          </tr>
          <tr v-if="errors.items.length === 0">
            <td colspan="7" class="empty-cell">该区间内没有影响错误指数的货件，可切换「近30日」查看历史错误</td>
          </tr>
        </tbody>
      </table>

      <div class="pager" v-if="totalItems > pager.limit">
        <button class="btn btn-sm btn-ghost" :disabled="currentPage <= 1" @click="prevPage">上一页</button>
        <span class="pager-info">第 {{ currentPage }} / {{ pageCount }} 页 · 共 {{ totalItems }} 条</span>
        <button class="btn btn-sm btn-ghost" :disabled="currentPage >= pageCount" @click="nextPage">下一页</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.store-health {
  padding: 16px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.preset-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.date-range {
  display: flex;
  align-items: center;
  gap: 4px;
}
.date-range.disabled {
  opacity: 0.5;
}
.sep {
  color: #86909c;
  margin: 0 4px;
}
.multi-select {
  position: relative;
}
.caret {
  font-size: 12px;
  color: #86909c;
}
.multi-select-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 50;
  min-width: 180px;
  background: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  padding: 6px;
}
.multi-select-actions {
  display: flex;
  gap: 6px;
  padding: 4px 6px 8px;
  border-bottom: 1px solid #f2f3f5;
  margin-bottom: 6px;
}
.multi-select-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.multi-select-item:hover {
  background: #f7f8fa;
}
.multi-select-empty {
  color: #86909c;
  padding: 12px;
  font-size: 13px;
  text-align: center;
}
.sync-btn {
  margin-left: auto;
}

.range-hint {
  color: #86909c;
  font-size: 13px;
  margin: 4px 0 12px;
}

/* ── 指标卡 ── */
.summary-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.summary-card {
  background: #fff;
  border-radius: 10px;
  padding: 16px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  border: 1px solid #f2f3f5;
}
.sc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #4e5969;
  margin-bottom: 10px;
}
.sc-icon {
  font-size: 16px;
}
.sc-count {
  font-size: 26px;
  font-weight: 700;
  color: #1f2329;
  line-height: 1.2;
}
.sc-sub {
  font-size: 12px;
  color: #86909c;
  margin-top: 6px;
}
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  margin-left: auto;
}
.status-dot.ok { background: #00b42a; }
.status-dot.warning { background: #d97706; }
.status-dot.critical { background: #f53f3f; }
.red-text { color: #f53f3f; }
.orange-text { color: #d97706; }
.sep { margin: 0 4px; }

/* ── 店铺错误指数列表 ── */
.store-list-card {
  background: #fff;
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 16px;
  border: 1px solid #f2f3f5;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
}
.store-list-card h3 {
  font-size: 14px;
  margin: 0 0 10px;
  color: #1f2329;
}
.store-index-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed #f2f3f5;
}
.store-index-row:last-child {
  border-bottom: none;
  padding-bottom: 2px;
}
.store-index-row .status-dot {
  margin-left: 0;
  flex-shrink: 0;
}
.sl-name {
  width: 120px;
  flex-shrink: 0;
  font-size: 13px;
  color: #1f2329;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-track {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: #f2f3f5;
  overflow: hidden;
}
.sl-fill {
  height: 100%;
  border-radius: 4px;
  min-width: 2px;
  transition: width 0.3s ease;
}
.sl-pct {
  width: 72px;
  flex-shrink: 0;
  text-align: right;
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.sl-cost {
  width: 110px;
  flex-shrink: 0;
  text-align: right;
  font-size: 12px;
  color: #86909c;
  font-variant-numeric: tabular-nums;
}

/* ── 趋势图 ── */
.chart-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}
.chart-card {
  background: #fff;
  border-radius: 10px;
  padding: 14px;
  border: 1px solid #f2f3f5;
}
.chart-card h3,
.dist-card h3 {
  font-size: 14px;
  margin: 0 0 10px;
  color: #1f2329;
}
.line-chart {
  width: 100%;
  height: 180px;
}
.grid-line {
  stroke: #f2f3f5;
  stroke-width: 1;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
  font-size: 12px;
  color: #4e5969;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.legend-item i {
  width: 12px;
  height: 3px;
  border-radius: 2px;
  display: inline-block;
}
.cost-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 180px;
  padding-top: 4px;
}
.bar-col {
  flex: 1;
  min-width: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}
.bar-track {
  flex: 1;
  width: 100%;
  max-width: 22px;
  display: flex;
  align-items: flex-end;
  background: #f7f8fa;
  border-radius: 3px 3px 0 0;
  overflow: hidden;
}
.bar-fill {
  width: 100%;
  background: #165dff;
  border-radius: 3px 3px 0 0;
  min-height: 2px;
  transition: height 0.3s;
}
.bar-date {
  font-size: 10px;
  color: #86909c;
  margin-top: 4px;
  white-space: nowrap;
}
.bar-max-hint {
  font-size: 11px;
  color: #86909c;
  margin-top: 4px;
}

/* ── 分布 ── */
.dist-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}
.dist-card {
  background: #fff;
  border-radius: 10px;
  padding: 14px;
  border: 1px solid #f2f3f5;
}
.dist-item {
  margin-bottom: 12px;
}
.dist-head {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 4px;
}
.dist-num {
  color: #86909c;
}
.dist-track {
  height: 8px;
  background: #f2f3f5;
  border-radius: 4px;
  overflow: hidden;
}
.dist-fill {
  height: 100%;
  border-radius: 4px;
}
.dist-empty {
  color: #86909c;
  font-size: 13px;
}

/* ── 明细表 ── */
.stats-table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  font-size: 13px;
}
.stats-table th,
.stats-table td {
  padding: 10px 12px;
  border-bottom: 1px solid #f2f3f5;
  text-align: left;
}
.stats-table th {
  color: #86909c;
  font-weight: 500;
  background: #fafbfc;
  white-space: nowrap;
}
.stats-table td.col-num {
  text-align: right;
}
.posting-link {
  color: #165dff;
  cursor: pointer;
  font-family: monospace;
}
.posting-link:hover {
  text-decoration: underline;
}
.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.tag-cancel { background: #ffece8; color: #f53f3f; }
.tag-delay { background: #fff3e8; color: #d97706; }
.grace-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.grace-yes { background: #e8ffea; color: #00b42a; }
.grace-no { background: #f2f3f5; color: #86909c; }
.empty-cell {
  text-align: center;
  color: #86909c;
  padding: 24px;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 10px 4px;
}
.pager-info {
  font-size: 13px;
  color: #86909c;
}

/* ── 骨架屏/空态 ── */
.summary-skeleton {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.skeleton-card {
  height: 96px;
  background: linear-gradient(90deg, #f2f3f5 25%, #fafbfc 50%, #f2f3f5 75%);
  background-size: 200% 100%;
  animation: shimmer 1.2s infinite;
  border-radius: 10px;
}
.empty-tip {
  background: #fff;
  border: 1px dashed #e5e6eb;
  border-radius: 10px;
  padding: 32px;
  text-align: center;
  color: #86909c;
  margin-bottom: 16px;
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (max-width: 900px) {
  .chart-row,
  .dist-row {
    grid-template-columns: 1fr;
  }
}
</style>