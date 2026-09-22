<script setup>
// 订单统计(2026-09,跨店铺跨时间窗口的订单量级与金额概览)
// 数据源:order-stats.js 后端模块,按事件发生时间计数(不去重)
//   新订单 = op_ozon_order.in_process_at 当日
//   揽收   = op_ozon_order.delivering_date 当日
//   签收   = op_package.delivered_at 当日
//   退货   = op_package.return_at 当日
// 金额统一 currency='CNY';新订单金额拆 amount(含取消) + validAmount(剔除取消)
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getOrderStatsSummary, getOrderStatsStores } from '../api/order-stats.js';

// ── 统计时区(2026-09-22):北京/莫斯科,日界按所选时区 00:00 划分 ──
const TZ_OPTIONS = [
  { value: 'Asia/Shanghai', label: '北京时间' },
  { value: 'Europe/Moscow', label: '莫斯科时间' },
];
const tz = ref('Asia/Shanghai');
const tzLabel = computed(() => TZ_OPTIONS.find(t => t.value === tz.value)?.label || '');
function setTz(v) {
  if (tz.value === v) return;
  tz.value = v;
  // "今天/本月"等预设随日界变化需重算;自然月/自定义日期不变,仅重查
  const k = activePreset.value;
  if (k === 'custom' || k.startsWith('month:')) scheduleLoad();
  else applyPreset(k);
}

// ── 时间预设 ────────────────────────────────────────────────────
const presets = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: '7d', label: '近7日' },
  { key: '14d', label: '近14日' },
  { key: '30d', label: '近30日' },
  { key: 'thisMonth', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'custom', label: '自定义' },
];
const activePreset = ref('today');

function pad(n) { return String(n).padStart(2, '0'); }
// 所选时区下的当前日期组件 { y, m, d }
function tzDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz.value, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);
  return { y, m, d };
}
// 在所选时区"今天"的基础上位移 n 天(纯日期运算,不经过系统本地时区)
function shiftLocalDays(n) {
  const { y, m, d } = tzDate();
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
// 某年月 1 号 / 下月 1 号
function firstOfMonth(y, m) { return `${y}-${pad(m)}-01`; }
function firstOfNextMonth(y, m) {
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

function presetRange(key) {
  const todayStr = shiftLocalDays(0);
  switch (key) {
    case 'today': return { from: todayStr, to: shiftLocalDays(1) };
    case 'yesterday': return { from: shiftLocalDays(-1), to: todayStr };
    case '7d': return { from: shiftLocalDays(-7), to: shiftLocalDays(1) };
    case '14d': return { from: shiftLocalDays(-14), to: shiftLocalDays(1) };
    case '30d': return { from: shiftLocalDays(-30), to: shiftLocalDays(1) };
    case 'thisMonth': {
      const { y, m } = tzDate();
      return { from: firstOfMonth(y, m), to: shiftLocalDays(1) };
    }
    // 上月整月:[上月1号, 本月1号) —— to 为排他端点,含月末最后一天
    case 'lastMonth': {
      const { y, m } = tzDate();
      const lm = m === 1 ? 12 : m - 1;
      const ly = m === 1 ? y - 1 : y;
      return { from: firstOfMonth(ly, lm), to: firstOfMonth(y, m) };
    }
    default: return null;
  }
}

// ── 自然月快捷(2026-09-22):最近 6 个自然月(含当月),一键整月切换 ──
const MONTH_PRESET_COUNT = 6;
const monthPresets = computed(() => {
  const { y, m } = tzDate();
  const list = [];
  for (let i = MONTH_PRESET_COUNT - 1; i >= 0; i--) {
    let my = y, mm = m - i;
    while (mm <= 0) { mm += 12; my -= 1; }
    list.push({
      key: `month:${my}-${pad(mm)}`,
      label: my === y ? `${mm}月` : `${my}年${mm}月`,
      from: firstOfMonth(my, mm),
      to: firstOfNextMonth(my, mm), // 排他;当月未来日期无数据,不影响结果
    });
  }
  return list;
});
function applyMonth(mp) {
  activePreset.value = mp.key;
  fromDate.value = mp.from;
  toDate.value = mp.to;
  scheduleLoad();
}

// 当前生效的 from/to (YYYY-MM-DD)
const fromDate = ref('');
const toDate = ref('');

// ── 店铺多选下拉 ────────────────────────────────────────────────
// 选中集合语义:selectedStoreIds 存"已勾选的店铺 id",勾选=纳入筛选;
// 这里反过来:UI 上勾选 = 纳入,所以选中集合存的就是被纳入的店铺;
// 集合为空 = 全选(默认)
const allStores = ref([]);
const selectedStoreIds = ref(new Set());  // 空=全选
const storeDropdownOpen = ref(false);

async function loadStores() {
  try {
    const r = await getOrderStatsStores();
    const list = (r?.stores || []).filter(s => s?.id && s?.name);
    allStores.value = list.map(s => ({ id: s.id, name: s.name }));
  } catch (e) {
    allStores.value = [];
  }
}

function toggleStore(id) {
  const s = new Set(selectedStoreIds.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selectedStoreIds.value = s;
  scheduleLoad();
}
function selectAllStores() {
  // 选中"全选" = 清空筛选集合(空集合语义=全选)
  selectedStoreIds.value = new Set();
  scheduleLoad();
}
function selectNoStores() {
  // "全不选":把所有店铺 id 装入集合(但 storeIds 非空 → 后端 IN 子句匹配 0 个)
  // 与 UI"全选"反向;实际效果=空结果集
  selectedStoreIds.value = new Set(allStores.value.map(s => s.id));
  scheduleLoad();
}
const storeSelectionLabel = computed(() => {
  const n = selectedStoreIds.value.size;
  if (n === 0) return '全部店铺';
  return `已选 ${n}/${allStores.value.length}`;
});
function isStoreIncluded(id) {
  // 在 UI 上:勾选 = 纳入筛选 → 但集合语义是"已选中的纳入筛选"
  // 当集合为空时,所有店铺都纳入(全选)
  if (selectedStoreIds.value.size === 0) return true;
  return selectedStoreIds.value.has(id);
}
function handleStoreCheckbox(id) {
  // 反转:勾选 → 纳入;但因为集合空=全选,需要特殊处理
  // 简化:如果当前是"全选"状态,用户取消某个店铺 → 把所有店铺都加入集合,再移除被取消的
  if (selectedStoreIds.value.size === 0) {
    const all = new Set(allStores.value.map(s => s.id));
    all.delete(id);
    selectedStoreIds.value = all;
  } else {
    toggleStore(id);
  }
  scheduleLoad();
}
function closeStoreDropdown(e) {
  if (!e.target.closest('.multi-select')) storeDropdownOpen.value = false;
}

// ── 数据加载 ────────────────────────────────────────────────────
const data = ref(null);
const loading = ref(false);
const error = ref(null);
let reqId = 0;
let debounceTimer = null;

async function load() {
  if (!fromDate.value || !toDate.value) return;
  const myId = ++reqId;
  loading.value = true;
  error.value = null;
  try {
    const params = { from: fromDate.value, to: toDate.value, tz: tz.value };
    if (selectedStoreIds.value.size > 0) {
      params.storeIds = [...selectedStoreIds.value].join(',');
    }
    const r = await getOrderStatsSummary(params);
    if (myId !== reqId) return;
    data.value = r;
    if (allStores.value.length === 0 && r.byStore?.length) {
      allStores.value = r.byStore.map(s => ({ id: s.storeId, name: s.storeName }));
    }
  } catch (err) {
    if (myId !== reqId) return;
    error.value = err.message || String(err);
  } finally {
    if (myId === reqId) loading.value = false;
  }
}
function scheduleLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(load, 300);
}

function applyPreset(key) {
  activePreset.value = key;
  const r = presetRange(key);
  if (r) {
    fromDate.value = r.from;
    toDate.value = r.to;
    scheduleLoad();
  }
}

// 展示用区间末端:to 为排他日界,回退一天得到"实际包含的最后一天"
const rangeEndDisplay = computed(() => {
  if (!toDate.value) return '';
  const [y, m, d] = toDate.value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
});

// ── 金额/数量格式化 ─────────────────────────────────────────────
function fmtMoney(n) {
  return (Number(n) || 0).toFixed(2);
}
function fmtCount(n) {
  return String(Number(n) || 0);
}

// ── 表格排序 ─────────────────────────────────────────────────────
const sortKey = ref('storeName');
const sortDir = ref('asc');
function toggleSort(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'desc';
  }
}
function sortMark(key) {
  if (sortKey.value !== key) return '↕';
  return sortDir.value === 'asc' ? '↑' : '↓';
}
function getNested(row, path) {
  const parts = path.split('.');
  let v = row;
  for (const p of parts) v = v?.[p];
  return Number(v) || 0;
}
const sortedByStore = computed(() => {
  if (!data.value?.byStore) return [];
  const list = [...data.value.byStore];
  const key = sortKey.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    if (key === 'storeName') return a.storeName.localeCompare(b.storeName, 'zh-CN') * dir;
    return (getNested(a, key) - getNested(b, key)) * dir;
  });
  return list;
});

// ── 生命周期 ─────────────────────────────────────────────────────
onMounted(() => {
  loadStores();
  applyPreset('today');
  document.addEventListener('click', closeStoreDropdown);
});
onUnmounted(() => {
  document.removeEventListener('click', closeStoreDropdown);
});
</script>

<template>
  <div class="order-stats">
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
        <input class="filter-input" type="date" v-model="fromDate" :disabled="activePreset !== 'custom'" @change="scheduleLoad" />
        <span class="sep">—</span>
        <input class="filter-input" type="date" v-model="toDate" :disabled="activePreset !== 'custom'" @change="scheduleLoad" />
      </div>

      <!-- 时区切换:日界按所选时区 00:00 划分 -->
      <div class="tz-group" role="group" aria-label="统计时区">
        <button
          v-for="t in TZ_OPTIONS"
          :key="t.value"
          class="btn btn-sm"
          :class="{ 'btn-primary': tz === t.value, 'btn-ghost': tz !== t.value }"
          @click="setTz(t.value)"
        >{{ t.label }}</button>
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
    </div>

    <!-- 自然月快捷 + 时间范围展示 -->
    <div class="sub-toolbar">
      <div class="month-group">
        <span class="group-label">自然月</span>
        <button
          v-for="mp in monthPresets"
          :key="mp.key"
          class="btn btn-sm"
          :class="{ 'btn-primary': activePreset === mp.key, 'btn-ghost': activePreset !== mp.key }"
          @click="applyMonth(mp)"
        >{{ mp.label }}</button>
      </div>
      <div class="range-hint">
        当前统计区间({{ tzLabel }}):{{ fromDate }} ~ {{ rangeEndDisplay }}
      </div>
    </div>

    <!-- 加载/错误状态 -->
    <div v-if="error" class="error-bar">加载失败:{{ error }}</div>

    <!-- 总计卡片 -->
    <div class="summary-cards" v-if="data">
      <div class="summary-card card-new">
        <div class="sc-head"><span class="sc-icon">🆕</span><span>新订单</span></div>
        <div class="sc-count">{{ fmtCount(data.totals.new.count) }} 单</div>
        <div class="sc-money">¥ {{ fmtMoney(data.totals.new.amount) }}</div>
        <div class="sc-sub">剔除取消 ¥ {{ fmtMoney(data.totals.new.validAmount) }}</div>
      </div>
      <div class="summary-card card-pickup">
        <div class="sc-head"><span class="sc-icon">📦</span><span>揽收</span></div>
        <div class="sc-count">{{ fmtCount(data.totals.pickup.count) }} 单</div>
        <div class="sc-money">¥ {{ fmtMoney(data.totals.pickup.amount) }}</div>
      </div>
      <div class="summary-card card-delivered">
        <div class="sc-head"><span class="sc-icon">✅</span><span>签收</span></div>
        <div class="sc-count">{{ fmtCount(data.totals.delivered.count) }} 单</div>
        <div class="sc-money">¥ {{ fmtMoney(data.totals.delivered.amount) }}</div>
      </div>
      <div class="summary-card card-returned">
        <div class="sc-head"><span class="sc-icon">↩️</span><span>退货</span></div>
        <div class="sc-count">{{ fmtCount(data.totals.returned.count) }} 单</div>
        <div class="sc-money">¥ {{ fmtMoney(data.totals.returned.amount) }}</div>
      </div>
    </div>
    <div v-else-if="loading" class="summary-skeleton">
      <div class="skeleton-card" v-for="i in 4" :key="i"></div>
    </div>

    <!-- 店铺表格 -->
    <div class="table-wrap" v-if="data">
      <table class="stats-table">
        <thead>
          <tr>
            <th class="col-store" @click="toggleSort('storeName')">店铺 <span class="sort-mark" :class="{dim: sortKey !== 'storeName'}">{{ sortMark('storeName') }}</span></th>
            <th class="col-num" @click="toggleSort('new.count')">新订单 <span class="sort-mark" :class="{dim: sortKey !== 'new.count'}">{{ sortMark('new.count') }}</span></th>
            <th class="col-amt" @click="toggleSort('new.amount')">金额 <span class="sort-mark" :class="{dim: sortKey !== 'new.amount'}">{{ sortMark('new.amount') }}</span></th>
            <th class="col-num" @click="toggleSort('pickup.count')">揽收 <span class="sort-mark" :class="{dim: sortKey !== 'pickup.count'}">{{ sortMark('pickup.count') }}</span></th>
            <th class="col-amt" @click="toggleSort('pickup.amount')">金额 <span class="sort-mark" :class="{dim: sortKey !== 'pickup.amount'}">{{ sortMark('pickup.amount') }}</span></th>
            <th class="col-num" @click="toggleSort('delivered.count')">签收 <span class="sort-mark" :class="{dim: sortKey !== 'delivered.count'}">{{ sortMark('delivered.count') }}</span></th>
            <th class="col-amt" @click="toggleSort('delivered.amount')">金额 <span class="sort-mark" :class="{dim: sortKey !== 'delivered.amount'}">{{ sortMark('delivered.amount') }}</span></th>
            <th class="col-num" @click="toggleSort('returned.count')">退货 <span class="sort-mark" :class="{dim: sortKey !== 'returned.count'}">{{ sortMark('returned.count') }}</span></th>
            <th class="col-amt" @click="toggleSort('returned.amount')">金额 <span class="sort-mark" :class="{dim: sortKey !== 'returned.amount'}">{{ sortMark('returned.amount') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sortedByStore" :key="row.storeId">
            <td class="col-store">{{ row.storeName }}</td>
            <td class="col-num">{{ fmtCount(row.new.count) }}</td>
            <td class="col-amt">
              ¥ {{ fmtMoney(row.new.amount) }}
              <div class="sub" v-if="row.new.validAmount != null">剔除取消 ¥ {{ fmtMoney(row.new.validAmount) }}</div>
            </td>
            <td class="col-num">{{ fmtCount(row.pickup.count) }}</td>
            <td class="col-amt">¥ {{ fmtMoney(row.pickup.amount) }}</td>
            <td class="col-num">{{ fmtCount(row.delivered.count) }}</td>
            <td class="col-amt">¥ {{ fmtMoney(row.delivered.amount) }}</td>
            <td class="col-num">{{ fmtCount(row.returned.count) }}</td>
            <td class="col-amt">¥ {{ fmtMoney(row.returned.amount) }}</td>
          </tr>
          <tr class="total-row" v-if="data.totals">
            <td class="col-store">合计</td>
            <td class="col-num">{{ fmtCount(data.totals.new.count) }}</td>
            <td class="col-amt">¥ {{ fmtMoney(data.totals.new.amount) }}</td>
            <td class="col-num">{{ fmtCount(data.totals.pickup.count) }}</td>
            <td class="col-amt">¥ {{ fmtMoney(data.totals.pickup.amount) }}</td>
            <td class="col-num">{{ fmtCount(data.totals.delivered.count) }}</td>
            <td class="col-amt">¥ {{ fmtMoney(data.totals.delivered.amount) }}</td>
            <td class="col-num">{{ fmtCount(data.totals.returned.count) }}</td>
            <td class="col-amt">¥ {{ fmtMoney(data.totals.returned.amount) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="!loading && !error" class="empty">暂无数据</div>
  </div>
</template>

<style scoped>
.order-stats {
  padding-bottom: 32px;
}
/* 工具栏内容增多(预设+日期+时区+店铺),允许换行防止挤压 */
.order-stats .toolbar {
  flex-wrap: wrap;
  gap: 8px;
}
.preset-group {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}
.tz-group {
  display: inline-flex;
  gap: 4px;
}
.sub-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 12px;
  padding: 0 24px;
}
.month-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.group-label {
  font-size: 12px;
  color: var(--muted);
  margin-right: 4px;
}
.date-range {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.date-range.disabled {
  opacity: 0.6;
}
.date-range .sep {
  color: var(--muted);
}
.multi-select {
  position: relative;
  display: inline-block;
}
.multi-select .caret {
  margin-left: 4px;
  font-size: 10px;
  color: var(--muted);
}
.multi-select-panel {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 220px;
  max-height: 320px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  z-index: 100;
  padding: 6px;
}
.multi-select-actions {
  display: flex;
  gap: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 6px;
}
.multi-select-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  cursor: pointer;
  font-size: 13px;
  border-radius: 4px;
}
.multi-select-item:hover {
  background: #f3f4f6;
}
.multi-select-empty {
  padding: 12px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}
.range-hint {
  color: var(--muted);
  font-size: 12px;
}
.error-bar {
  margin: 0 24px 12px;
  padding: 10px 14px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: var(--danger);
  border-radius: 6px;
  font-size: 13px;
}
.summary-cards,
.summary-skeleton {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  padding: 0 24px 16px;
}
.summary-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
  font-weight: 500;
}
.sc-icon {
  font-size: 16px;
}
.sc-count {
  font-size: 22px;
  font-weight: 600;
  color: var(--text);
}
.sc-money {
  font-size: 16px;
  color: var(--primary);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.sc-sub {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.skeleton-card {
  background: #f3f4f6;
  border-radius: var(--radius);
  height: 130px;
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.8; }
}
.table-wrap {
  padding: 0 24px;
  overflow-x: auto;
}
.stats-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  font-size: 13px;
}
.stats-table thead th {
  background: #f9fafb;
  padding: 10px 8px;
  text-align: center;
  font-weight: 500;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.stats-table thead th:hover {
  background: #f3f4f6;
}
.stats-table tbody td {
  padding: 10px 8px;
  text-align: center;
  border-bottom: 1px solid #f3f4f6;
  font-variant-numeric: tabular-nums;
}
.stats-table tbody tr:hover {
  background: #fafbfc;
}
.col-store {
  text-align: left !important;
  font-weight: 500;
}
.col-amt .sub {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
}
.total-row td {
  background: #f9fafb;
  font-weight: 600;
  border-top: 2px solid var(--border);
}
.sort-mark {
  font-size: 10px;
  margin-left: 4px;
  color: var(--primary);
}
.sort-mark.dim {
  color: var(--muted);
  opacity: 0.4;
}
.empty {
  padding: 60px 24px;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
}
</style>
