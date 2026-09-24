<script setup>
// 财务统计(2026-09-25,订单维度:采购成本/各项应计项目/利润)
// 数据源:finance-stats.js 后端模块,三组口径:
//   已结算 —— 已成功(妥投+应计含 66/67)+ 已取消 + 已退款(妥投后退货),按下单时间过滤;
//             有真实应计走真实口径,无应计的取消/退款按 利润=−采购
//   已采购未结算 —— 有采购且未达已成功(非取消/退货),按下单时间过滤,利润为预估口径
//   非订单应计项目 —— package_id IS NULL 的应计行(罚款/逆向物流等),按应计日期过滤
// 时间维度:全部 / 自然月(所有有订单的月份) / 近 7/14/30 天 / 自定义;时区北京/莫斯科
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import AppPager from '../components/AppPager.vue';
import { parseUtcDate } from '../utils/time.js';
import {
  getFinanceSummary,
  getFinanceOrders,
  getNonOrderAccruals,
  getOrderMonths,
  getFinanceStores,
} from '../api/finance-stats.js';

// ── 统计时区(日界按所选时区 00:00 划分;应计日期为日粒度不受影响)──
const TZ_OPTIONS = [
  { value: 'Asia/Shanghai', label: '北京时间' },
  { value: 'Europe/Moscow', label: '莫斯科时间' },
];
const tz = ref('Asia/Shanghai');
const tzLabel = computed(() => TZ_OPTIONS.find((t) => t.value === tz.value)?.label || '');
function setTz(v) {
  if (tz.value === v) return;
  tz.value = v;
  loadOrderMonths(); // 月界随时区变化,重新拉取有订单月份
  // "近 N 天"等预设随日界变化需重算;自然月/自定义仅重查
  const k = activePreset.value;
  if (k === 'custom' || k === 'all' || k.startsWith('month:')) scheduleLoadAll();
  else applyPreset(k);
}

// ── 时间预设 ────────────────────────────────────────────────────
const presets = [
  { key: 'all', label: '全部' },
  { key: '7d', label: '近7日' },
  { key: '14d', label: '近14日' },
  { key: '30d', label: '近30日' },
  { key: 'custom', label: '自定义' },
];
const activePreset = ref('all');

function pad(n) { return String(n).padStart(2, '0'); }
// 所选时区下的当前日期组件 { y, m, d }
function tzDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz.value, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  return {
    y: Number(parts.find(p => p.type === 'year').value),
    m: Number(parts.find(p => p.type === 'month').value),
    d: Number(parts.find(p => p.type === 'day').value),
  };
}
// 在所选时区"今天"基础上位移 n 天(纯日期运算)
function shiftLocalDays(n) {
  const { y, m, d } = tzDate();
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function firstOfMonth(y, m) { return `${y}-${pad(m)}-01`; }
function firstOfNextMonth(y, m) {
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}
function presetRange(key) {
  const todayStr = shiftLocalDays(0);
  switch (key) {
    case 'all': return { from: '', to: '' };
    case '7d': return { from: shiftLocalDays(-7), to: shiftLocalDays(1) };
    case '14d': return { from: shiftLocalDays(-14), to: shiftLocalDays(1) };
    case '30d': return { from: shiftLocalDays(-30), to: shiftLocalDays(1) };
    default: return null;
  }
}

// ── 自然月快捷(后端返回所有有订单的月份,降序最新在前)──────────
const monthPresets = ref([]);
async function loadOrderMonths() {
  try {
    const r = await getOrderMonths({ tz: tz.value });
    const curY = tzDate().y;
    monthPresets.value = (r?.months || []).map((ym) => {
      const [y, m] = ym.split('-').map(Number);
      return {
        key: `month:${ym}`,
        label: y === curY ? `${m}月` : `${y}年${m}月`,
        from: firstOfMonth(y, m),
        to: firstOfNextMonth(y, m), // 排他;当月未来日期无数据不影响
      };
    });
  } catch (e) {
    monthPresets.value = [];
  }
}
function applyMonth(mp) {
  activePreset.value = mp.key;
  fromDate.value = mp.from;
  toDate.value = mp.to;
  scheduleLoadAll();
}

// 当前生效的 from/to(YYYY-MM-DD;全部时均为空)
const fromDate = ref('');
const toDate = ref('');

// ── 店铺多选(空集合=全选,与订单统计页同交互)──────────────────
const allStores = ref([]);
const selectedStoreIds = ref(new Set());
const storeDropdownOpen = ref(false);

async function loadStores() {
  try {
    const r = await getFinanceStores();
    allStores.value = (r?.stores || []).filter(s => s?.id && s?.name).map(s => ({ id: s.id, name: s.name }));
  } catch (e) {
    allStores.value = [];
  }
}
function handleStoreCheckbox(id) {
  const s = new Set(selectedStoreIds.value.size === 0 ? allStores.value.map(x => x.id) : selectedStoreIds.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  selectedStoreIds.value = s;
  scheduleLoadAll();
}
function selectAllStores() {
  selectedStoreIds.value = new Set();
  scheduleLoadAll();
}
const storeSelectionLabel = computed(() => {
  const n = selectedStoreIds.value.size;
  return n === 0 ? '全部店铺' : `已选 ${n}/${allStores.value.length}`;
});
function isStoreIncluded(id) {
  return selectedStoreIds.value.size === 0 || selectedStoreIds.value.has(id);
}
function closeStoreDropdown(e) {
  if (!e.target.closest('.multi-select')) storeDropdownOpen.value = false;
}

// ── 公共查询参数 ────────────────────────────────────────────────
function baseParams() {
  const p = {};
  if (fromDate.value && toDate.value) {
    p.from = fromDate.value;
    p.to = toDate.value;
    p.tz = tz.value;
  }
  if (selectedStoreIds.value.size > 0) p.storeIds = [...selectedStoreIds.value].join(',');
  return p;
}
// 展示用区间末端:to 为排他日界,回退一天得到实际包含的最后一天
const rangeEndDisplay = computed(() => {
  if (!toDate.value) return '';
  const [y, m, d] = toDate.value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
});
const rangeHint = computed(() => {
  if (!fromDate.value && !toDate.value) return '当前统计区间:全部时间';
  return `当前统计区间(${tzLabel.value }):${fromDate.value} ~ ${rangeEndDisplay.value}(订单按下单时间,非订单应计按应计日期)`;
});

// ── 汇总(三组)────────────────────────────────────────────────
const summary = ref(null);
const summaryLoading = ref(false);
const summaryError = ref(null);
let summaryReqId = 0;

async function loadSummary() {
  const myId = ++summaryReqId;
  summaryLoading.value = true;
  summaryError.value = null;
  try {
    const r = await getFinanceSummary(baseParams());
    if (myId !== summaryReqId) return;
    summary.value = r;
  } catch (err) {
    if (myId !== summaryReqId) return;
    summaryError.value = err.message || String(err);
  } finally {
    if (myId === summaryReqId) summaryLoading.value = false;
  }
}

// ── 订单详情列表 ────────────────────────────────────────────────
const ordersGroup = ref('settled'); // settled | pending
const ordersPage = ref(1);
const ORDERS_PAGE_SIZE = 20;
const ordersKeyword = ref('');
const ordersData = ref(null);
const ordersLoading = ref(false);
const ordersError = ref(null);
const expandedRows = ref(new Set());
let ordersReqId = 0;
let keywordTimer = null;

async function loadOrders() {
  const myId = ++ordersReqId;
  ordersLoading.value = true;
  ordersError.value = null;
  try {
    const p = { ...baseParams(), group: ordersGroup.value, page: ordersPage.value, pageSize: ORDERS_PAGE_SIZE };
    const kw = ordersKeyword.value.trim();
    if (kw) p.keyword = kw;
    const r = await getFinanceOrders(p);
    if (myId !== ordersReqId) return;
    ordersData.value = r;
    expandedRows.value = new Set();
  } catch (err) {
    if (myId !== ordersReqId) return;
    ordersError.value = err.message || String(err);
  } finally {
    if (myId === ordersReqId) ordersLoading.value = false;
  }
}
function setOrdersGroup(g) {
  if (ordersGroup.value === g) return;
  ordersGroup.value = g;
  ordersPage.value = 1;
  loadOrders();
}
function onOrdersPage(p) {
  ordersPage.value = p;
  loadOrders();
}
function onKeywordInput() {
  clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => {
    ordersPage.value = 1;
    loadOrders();
  }, 400);
}
function toggleExpand(id) {
  const s = new Set(expandedRows.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  expandedRows.value = s;
}

// ── 非订单应计明细列表 ──────────────────────────────────────────
const noPage = ref(1);
const NO_PAGE_SIZE = 20;
const noData = ref(null);
const noLoading = ref(false);
const noError = ref(null);
let noReqId = 0;

async function loadNonOrder() {
  const myId = ++noReqId;
  noLoading.value = true;
  noError.value = null;
  try {
    const r = await getNonOrderAccruals({ ...baseParams(), page: noPage.value, pageSize: NO_PAGE_SIZE });
    if (myId !== noReqId) return;
    noData.value = r;
  } catch (err) {
    if (myId !== noReqId) return;
    noError.value = err.message || String(err);
  } finally {
    if (myId === noReqId) noLoading.value = false;
  }
}
function onNoPage(p) {
  noPage.value = p;
  loadNonOrder();
}

// ── 联动加载 ────────────────────────────────────────────────────
let loadAllTimer = null;
function scheduleLoadAll() {
  clearTimeout(loadAllTimer);
  loadAllTimer = setTimeout(() => {
    ordersPage.value = 1;
    noPage.value = 1;
    loadSummary();
    loadOrders();
    loadNonOrder();
  }, 300);
}
function applyPreset(key) {
  activePreset.value = key;
  const r = presetRange(key);
  if (r) {
    fromDate.value = r.from;
    toDate.value = r.to;
    scheduleLoadAll();
  }
}
function onCustomDateChange() {
  activePreset.value = 'custom';
  // 自定义必须两端齐全才查询;只填一端视为未完成不触发
  if (fromDate.value && toDate.value) scheduleLoadAll();
}

// ── 格式化 ──────────────────────────────────────────────────────
function fmtMoney(n) {
  if (n == null) return '—';
  return (Number(n) || 0).toFixed(2);
}
function fmtRub(n) {
  if (n == null) return '—';
  return (Number(n) || 0).toFixed(2);
}
function fmtCount(n) {
  return String(Number(n) || 0);
}
function fmtRate(n) {
  if (n == null) return '—';
  return `${(Number(n) || 0).toFixed(2)}%`;
}
function fmtDateTime(t) {
  const d = parseUtcDate(t);
  if (!d) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function profitClass(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return 'muted';
  return v > 0 ? 'profit-pos' : 'profit-neg';
}
function rubRateText(r) {
  if (!r?.rate) return null;
  const d = parseUtcDate(r.updatedAt);
  return `RUB→CNY 汇率 ${r.rate}${d ? `(更新于 ${fmtDateTime(r.updatedAt)})` : ''}`;
}

// ── 生命周期 ────────────────────────────────────────────────────
onMounted(() => {
  loadStores();
  loadOrderMonths();
  applyPreset('all');
  document.addEventListener('click', closeStoreDropdown);
});
onUnmounted(() => {
  document.removeEventListener('click', closeStoreDropdown);
  clearTimeout(loadAllTimer);
  clearTimeout(keywordTimer);
});
</script>

<template>
  <div class="finance-stats">
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
        <input class="filter-input" type="date" v-model="fromDate" :disabled="activePreset !== 'custom'" @change="onCustomDateChange" />
        <span class="sep">—</span>
        <input class="filter-input" type="date" v-model="toDate" :disabled="activePreset !== 'custom'" @change="onCustomDateChange" />
      </div>

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
          </div>
          <label v-for="s in allStores" :key="s.id" class="multi-select-item">
            <input type="checkbox" :checked="isStoreIncluded(s.id)" @change="handleStoreCheckbox(s.id)" />
            <span>{{ s.name }}</span>
          </label>
          <div class="multi-select-empty" v-if="allStores.length === 0">无店铺数据</div>
        </div>
      </div>
    </div>

    <!-- 自然月快捷 + 区间提示 -->
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
      <div class="range-hint">{{ rangeHint }}</div>
    </div>

    <!-- 汇率 + 口径说明 -->
    <div class="meta-bar">
      <span v-if="rubRateText(summary?.rubRate)" class="meta-item">{{ rubRateText(summary.rubRate) }}</span>
      <span class="meta-item muted">口径:已结算=已成功(妥投且应计含代理佣金/国际配送)+已取消+已退款,取消/退款无应计按利润=−采购;已采购未结算=有采购且未达已成功(非取消/退货)</span>
    </div>

    <div v-if="summaryError" class="error-bar">汇总加载失败:{{ summaryError }}</div>

    <!-- ══ 已结算(左) | 已采购未结算(右),同一行 ══ -->
    <div class="two-col" v-if="summary">
      <section class="fin-section">
        <header class="fin-head">
          <h2>已结算</h2>
          <span class="badge badge-real">实</span>
          <span v-if="summary.settled.byCategory" class="cat-counts">
            已成功 {{ fmtCount(summary.settled.byCategory.success) }} · 已取消 {{ fmtCount(summary.settled.byCategory.cancelled) }} · 已退款 {{ fmtCount(summary.settled.byCategory.returned) }}
          </span>
          <span v-if="summary.settled.truncated" class="truncated-hint" title="超出聚合上限,仅统计前 20000 单">数据量超出上限,统计可能不完整</span>
        </header>
        <div class="metric-grid">
          <div class="metric">
            <div class="m-label">订单数</div>
            <div class="m-value">{{ fmtCount(summary.settled.orderCount) }}</div>
          </div>
          <div class="metric">
            <div class="m-label">订单金额(¥)</div>
            <div class="m-value">{{ fmtMoney(summary.settled.totalOrderAmount) }}</div>
          </div>
          <div class="metric">
            <div class="m-label">采购成本(¥)</div>
            <div class="m-value">{{ fmtMoney(summary.settled.totalPurchaseAmount) }}</div>
          </div>
          <div class="metric" title="回款 =(销售收款 + 应计合计)× 汇率">
            <div class="m-label">回款(¥)</div>
            <div class="m-value">{{ fmtMoney(summary.settled.totalPayout) }}</div>
          </div>
          <div class="metric">
            <div class="m-label">利润(¥)</div>
            <div class="m-value" :class="profitClass(summary.settled.totalProfit)">{{ fmtMoney(summary.settled.totalProfit) }}</div>
          </div>
          <div class="metric" title="销售利润率 = 利润 ÷ 订单金额">
            <div class="m-label">销售利润率</div>
            <div class="m-value">{{ fmtRate(summary.settled.profitRateSale) }}</div>
          </div>
          <div class="metric" title="成本利润率 = 利润 ÷ 采购成本">
            <div class="m-label">成本利润率</div>
            <div class="m-value">{{ fmtRate(summary.settled.profitRateCost) }}</div>
          </div>
        </div>
        <div class="accrual-block">
          <div class="accrual-title">应计项目明细</div>
          <div class="type-tiles" v-if="summary.settled.accrualTypes.length">
            <div class="type-tile" v-for="t in summary.settled.accrualTypes" :key="t.typeId" :title="`${t.nameCn} #${t.typeId} · ${fmtCount(t.count)}笔`">
              <div class="tile-label">{{ t.nameCn }}<span class="type-id"> #{{ t.typeId }}</span></div>
              <div class="tile-value" :class="profitClass(t.cny)">{{ fmtMoney(t.cny) }}</div>
              <div class="tile-sub">₽{{ fmtRub(t.rub) }} · {{ fmtCount(t.count) }}笔</div>
            </div>
          </div>
          <div v-else class="mini-empty">该范围内无应计数据</div>
        </div>
      </section>

      <section class="fin-section">
        <header class="fin-head">
          <h2>已采购未结算</h2>
          <span class="badge" :class="summary.pending.estimated ? 'badge-est' : 'badge-real'">{{ summary.pending.estimated ? '估' : '实' }}</span>
          <span v-if="summary.pending.estimated" class="est-hint">在途订单按预估口径:佣金 = 订单金额 × 16%,配送 = 3.37 + 0.0281 × 重量(g)</span>
          <span v-if="summary.pending.truncated" class="truncated-hint" title="超出聚合上限,仅统计前 20000 单">数据量超出上限,统计可能不完整</span>
        </header>
        <div class="metric-grid">
          <div class="metric">
            <div class="m-label">订单数</div>
            <div class="m-value">{{ fmtCount(summary.pending.orderCount) }}</div>
          </div>
          <div class="metric">
            <div class="m-label">订单金额(¥)</div>
            <div class="m-value">{{ fmtMoney(summary.pending.totalOrderAmount) }}</div>
          </div>
          <div class="metric">
            <div class="m-label">采购成本(¥)</div>
            <div class="m-value">{{ fmtMoney(summary.pending.totalPurchaseAmount) }}</div>
          </div>
          <div class="metric" title="预收回款 = 订单金额 − 预估佣金 − 预估配送(在途)">
            <div class="m-label">回款(¥,估)</div>
            <div class="m-value">{{ fmtMoney(summary.pending.totalPayout) }}</div>
          </div>
          <div class="metric">
            <div class="m-label">利润(¥,估)</div>
            <div class="m-value" :class="profitClass(summary.pending.totalProfit)">{{ fmtMoney(summary.pending.totalProfit) }}</div>
          </div>
          <div class="metric" title="销售利润率 = 利润 ÷ 订单金额">
            <div class="m-label">销售利润率</div>
            <div class="m-value">{{ fmtRate(summary.pending.profitRateSale) }}</div>
          </div>
          <div class="metric" title="成本利润率 = 利润 ÷ 采购成本">
            <div class="m-label">成本利润率</div>
            <div class="m-value">{{ fmtRate(summary.pending.profitRateCost) }}</div>
          </div>
        </div>
        <div class="accrual-block">
          <div class="accrual-title">已产生应计项目(在途订单已落库的费用,尚未计入预估利润)</div>
          <div class="type-tiles" v-if="summary.pending.accrualTypes.length">
            <div class="type-tile" v-for="t in summary.pending.accrualTypes" :key="t.typeId" :title="`${t.nameCn} #${t.typeId} · ${fmtCount(t.count)}笔`">
              <div class="tile-label">{{ t.nameCn }}<span class="type-id"> #{{ t.typeId }}</span></div>
              <div class="tile-value" :class="profitClass(t.cny)">{{ fmtMoney(t.cny) }}</div>
              <div class="tile-sub">₽{{ fmtRub(t.rub) }} · {{ fmtCount(t.count) }}笔</div>
            </div>
          </div>
          <div v-else class="mini-empty">该范围内无应计数据</div>
        </div>
      </section>
    </div>

    <!-- ══ 非订单应计项目 ══ -->
    <section class="fin-section" v-if="summary">
      <header class="fin-head">
        <h2>非订单应计项目</h2>
        <span class="est-hint">未挂到货件的费用(罚款/逆向物流等),按应计日期统计</span>
      </header>
      <div class="metric-grid cols-3">
        <div class="metric">
          <div class="m-label">笔数</div>
          <div class="m-value">{{ fmtCount(summary.nonOrder.count) }}</div>
        </div>
        <div class="metric">
          <div class="m-label">金额合计(¥)</div>
          <div class="m-value" :class="profitClass(summary.nonOrder.totalCny)">{{ fmtMoney(summary.nonOrder.totalCny) }}</div>
        </div>
        <div class="metric">
          <div class="m-label">金额合计(₽)</div>
          <div class="m-value">{{ fmtRub(summary.nonOrder.totalRub) }}</div>
        </div>
      </div>
      <div class="accrual-block">
        <div class="accrual-title">应计项目明细</div>
        <div class="type-tiles" v-if="summary.nonOrder.accrualTypes.length">
          <div class="type-tile" v-for="t in summary.nonOrder.accrualTypes" :key="t.typeId" :title="`${t.nameCn} #${t.typeId} · ${fmtCount(t.count)}笔`">
            <div class="tile-label">{{ t.nameCn }}<span class="type-id"> #{{ t.typeId }}</span></div>
            <div class="tile-value" :class="profitClass(t.cny)">{{ fmtMoney(t.cny) }}</div>
            <div class="tile-sub">₽{{ fmtRub(t.rub) }} · {{ fmtCount(t.count) }}笔</div>
          </div>
        </div>
        <div v-else class="mini-empty">该范围内无非订单应计数据</div>
      </div>
    </section>

    <div v-if="summaryLoading && !summary" class="empty">加载中…</div>

    <!-- ══ 订单详情列表 ══ -->
    <section class="fin-section">
      <header class="fin-head">
        <h2>订单详情列表</h2>
        <div class="group-switch" role="group" aria-label="订单分组">
          <button
            class="btn btn-sm"
            :class="{ 'btn-primary': ordersGroup === 'settled', 'btn-ghost': ordersGroup !== 'settled' }"
            @click="setOrdersGroup('settled')"
          >已结算</button>
          <button
            class="btn btn-sm"
            :class="{ 'btn-primary': ordersGroup === 'pending', 'btn-ghost': ordersGroup !== 'pending' }"
            @click="setOrdersGroup('pending')"
          >已采购未结算</button>
        </div>
        <input
          class="filter-input kw-input"
          type="text"
          v-model="ordersKeyword"
          placeholder="搜索货件号"
          @input="onKeywordInput"
        />
      </header>
      <div v-if="ordersError" class="error-bar">订单列表加载失败:{{ ordersError }}</div>
      <div class="table-wrap" v-if="ordersData">
        <table class="orders-table">
          <thead>
            <tr>
              <th class="ta-l">下单时间</th>
              <th class="ta-l">店铺</th>
              <th class="ta-l">货件号</th>
              <th>订单金额(¥)</th>
              <th>采购成本(¥)</th>
              <th title="真实口径为应计销售佣金(69);预估口径为订单金额×16%">销售佣金</th>
              <th title="真实口径为应计国际配送(67);预估口径为 3.37+0.0281×重量">国际配送</th>
              <th>其它费用(¥)</th>
              <th title="回款 =(销售收款+应计合计)×汇率;预估为 escrow">回款(¥)</th>
              <th>利润(¥)</th>
              <th>成本利润率</th>
              <th>口径</th>
              <th class="exp-col"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="o in ordersData.orders" :key="o.packageId">
              <tr class="order-row" :class="{ expanded: expandedRows.has(o.packageId) }" @click="toggleExpand(o.packageId)">
                <td class="ta-l">{{ fmtDateTime(o.inProcessAt) }}</td>
                <td class="ta-l">{{ o.storeName }}</td>
                <td class="ta-l mono">{{ o.postingNumber }}</td>
                <td>{{ fmtMoney(o.orderAmount) }}</td>
                <td>{{ fmtMoney(o.purchaseAmount) }}</td>
                <td>
                  <template v-if="o.estimated">≈{{ fmtMoney(o.estimate?.commission) }}</template>
                  <template v-else>{{ fmtMoney(o.accrual?.saleFee) }}</template>
                </td>
                <td>
                  <template v-if="o.estimated">≈{{ fmtMoney(o.estimate?.delivery) }}</template>
                  <template v-else>{{ fmtMoney(o.accrual?.delivery) }}</template>
                </td>
                <td>{{ o.estimated ? '—' : fmtMoney(o.accrual?.others) }}</td>
                <td>{{ fmtMoney(o.payout) }}</td>
                <td :class="profitClass(o.profit)">{{ fmtMoney(o.profit) }}</td>
                <td>{{ fmtRate(o.profitRateCost) }}</td>
                <td>
                  <span v-if="o.category === 'cancelled'" class="badge badge-cancelled" title="已取消订单">取消</span>
                  <span v-else-if="o.category === 'returned'" class="badge badge-returned" title="妥投后退货退款">退款</span>
                  <span class="badge" :class="o.estimated ? 'badge-est' : 'badge-real'">{{ o.estimated ? '估' : '实' }}</span>
                </td>
                <td class="exp-col">{{ expandedRows.has(o.packageId) ? '▾' : '▸' }}</td>
              </tr>
              <tr v-if="expandedRows.has(o.packageId)" class="detail-row">
                <td colspan="13">
                  <div class="detail-grid">
                    <div class="detail-item"><span class="d-label">重量</span><span>{{ o.weightG != null ? Math.floor(o.weightG) + 'g' : '—' }}</span></div>
                    <div class="detail-item"><span class="d-label">妥投时间</span><span>{{ fmtDateTime(o.deliveredAt) }}</span></div>
                    <div class="detail-item"><span class="d-label">销售收款</span><span>{{ o.estimated ? '—' : '¥ ' + fmtMoney(o.accrual?.sale) }}</span></div>
                    <div class="detail-item"><span class="d-label">应计合计</span><span>{{ o.estimated ? '—' : '¥ ' + fmtMoney(o.accrual?.total) }}</span></div>
                  </div>
                  <div class="type-tiles inner" v-if="o.accrualTypes.length">
                    <div class="type-tile" v-for="t in o.accrualTypes" :key="t.typeId" :title="`${t.nameCn} #${t.typeId}`">
                      <div class="tile-label">{{ t.nameCn }}<span class="type-id"> #{{ t.typeId }}</span></div>
                      <div class="tile-value" :class="profitClass(t.cny)">{{ fmtMoney(t.cny) }}</div>
                      <div class="tile-sub">₽{{ fmtRub(t.rub) }}</div>
                    </div>
                  </div>
                  <div v-else class="mini-empty">该订单暂无已落库应计明细</div>
                </td>
              </tr>
            </template>
            <tr v-if="ordersData.orders.length === 0">
              <td colspan="13" class="empty-cell">该范围内暂无订单</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager-wrap" v-if="ordersData && ordersData.total > ORDERS_PAGE_SIZE">
        <AppPager :total="ordersData.total" :pageSize="ORDERS_PAGE_SIZE" :modelValue="ordersPage" @update:modelValue="onOrdersPage" />
      </div>
      <div v-if="ordersLoading" class="loading-hint">加载中…</div>
    </section>

    <!-- ══ 非订单应计明细 ══ -->
    <section class="fin-section">
      <header class="fin-head">
        <h2>非订单应计明细</h2>
      </header>
      <div v-if="noError" class="error-bar">明细加载失败:{{ noError }}</div>
      <div class="table-wrap" v-if="noData">
        <table class="orders-table">
          <thead>
            <tr>
              <th class="ta-l">应计日期</th>
              <th class="ta-l">店铺</th>
              <th class="ta-l">类型</th>
              <th class="ta-l">关联单号</th>
              <th>金额(¥)</th>
              <th>金额(₽)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in noData.items" :key="it.id">
              <td class="ta-l">{{ it.accrualDate || '—' }}</td>
              <td class="ta-l">{{ it.storeName }}</td>
              <td class="ta-l">{{ it.nameCn }}<span class="type-id"> #{{ it.typeId }}</span></td>
              <td class="ta-l mono">{{ it.unitNumber || '—' }}</td>
              <td :class="profitClass(it.cny)">{{ fmtMoney(it.cny) }}</td>
              <td>{{ fmtRub(it.rub) }}</td>
            </tr>
            <tr v-if="noData.items.length === 0">
              <td colspan="6" class="empty-cell">该范围内暂无非订单应计</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager-wrap" v-if="noData && noData.total > NO_PAGE_SIZE">
        <AppPager :total="noData.total" :pageSize="NO_PAGE_SIZE" :modelValue="noPage" @update:modelValue="onNoPage" />
      </div>
      <div v-if="noLoading" class="loading-hint">加载中…</div>
    </section>
  </div>
</template>

<style scoped>
.finance-stats {
  padding-bottom: 32px;
}
.finance-stats .toolbar {
  flex-wrap: wrap;
  gap: 8px;
}
.preset-group,
.tz-group,
.group-switch {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
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
.sub-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 6px;
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
.range-hint,
.meta-bar {
  color: var(--muted);
  font-size: 12px;
}
.meta-bar {
  padding: 0 24px 10px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.meta-item.muted {
  opacity: 0.85;
}
/* 店铺多选下拉 */
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
.error-bar {
  margin: 0 24px 12px;
  padding: 10px 14px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: var(--danger);
  border-radius: 6px;
  font-size: 13px;
}
/* ── 统计区段 ── */
.fin-section {
  margin: 0 24px 16px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 14px 16px;
}
/* 已结算(左) | 已采购未结算(右) 同一行;窄屏自动折行 */
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 0 24px 16px;
  align-items: start;
}
.two-col .fin-section {
  margin: 0;
  min-width: 0;
}
@media (max-width: 1200px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
.fin-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.fin-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
}
.badge-real {
  color: var(--success);
  background: rgba(22, 163, 74, 0.08);
  border: 1px solid rgba(22, 163, 74, 0.35);
}
.badge-est {
  color: var(--warning);
  background: rgba(217, 119, 6, 0.08);
  border: 1px solid rgba(217, 119, 6, 0.35);
}
.badge-cancelled {
  color: #6b7280;
  background: rgba(107, 114, 128, 0.08);
  border: 1px solid rgba(107, 114, 128, 0.35);
}
.badge-returned {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.35);
}
.cat-counts {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.est-hint,
.truncated-hint {
  font-size: 12px;
  color: var(--muted);
}
.truncated-hint {
  color: var(--warning);
}
/* 指标条 */
.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.metric-grid.cols-3 {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}
.metric {
  background: #f9fafb;
  border: 1px solid #f3f4f6;
  border-radius: 6px;
  padding: 10px 12px;
}
.m-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
  white-space: nowrap;
}
.m-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
/* 应计明细小表 */
.accrual-block {
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}
.accrual-title {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}
/* 应计类型方块(与指标方块同风格) */
.type-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}
.type-tiles.inner {
  max-width: 680px;
}
.type-tile {
  background: #f9fafb;
  border: 1px solid #f3f4f6;
  border-radius: 6px;
  padding: 8px 10px;
  min-width: 0;
}
.tile-label {
  font-size: 12px;
  color: var(--text);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tile-value {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tile-sub {
  font-size: 11px;
  color: var(--muted);
  margin-top: 2px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ta-l {
  text-align: left !important;
}
.type-id {
  color: var(--muted);
  font-size: 11px;
  margin-left: 4px;
}
.mini-empty {
  padding: 10px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}
/* ── 订单/明细列表 ── */
.fin-head .kw-input {
  width: 180px;
  margin-left: auto;
}
.table-wrap {
  overflow-x: auto;
}
.orders-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.orders-table thead th {
  background: #f9fafb;
  padding: 10px 8px;
  text-align: center;
  font-weight: 500;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  user-select: none;
}
.orders-table tbody td {
  padding: 9px 8px;
  text-align: center;
  border-bottom: 1px solid #f3f4f6;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.order-row {
  cursor: pointer;
}
.order-row:hover {
  background: #fafbfc;
}
.order-row.expanded {
  background: #f8fafc;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.exp-col {
  width: 28px;
  color: var(--muted);
}
.detail-row td {
  background: #fcfcfd;
  padding: 10px 16px 14px;
  text-align: left;
}
.detail-grid {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  font-size: 12.5px;
}
.detail-item {
  display: inline-flex;
  gap: 8px;
}
.d-label {
  color: var(--muted);
}
.empty-cell {
  padding: 32px 8px !important;
  text-align: center !important;
  color: var(--muted);
}
.pager-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.loading-hint {
  padding: 8px 0;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}
.empty {
  padding: 60px 24px;
  text-align: center;
  color: var(--muted);
  font-size: 14px;
}
/* 利润正负着色(与订单处理页一致) */
.profit-pos {
  color: #16a34a;
}
.profit-neg {
  color: #ef4444;
}
.muted {
  color: var(--muted);
}
</style>
