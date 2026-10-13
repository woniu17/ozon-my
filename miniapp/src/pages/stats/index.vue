<template>
  <view class="page">
    <!-- Tab 切换 -->
    <view class="tabs">
      <view class="tab" :class="{ on: tab === 'order' }" @click="switchTab('order')">订单统计</view>
      <view class="tab" :class="{ on: tab === 'finance' }" @click="switchTab('finance')">财务统计</view>
    </view>

    <!-- 预设时间(横滑) -->
    <scroll-view class="presets" scroll-x :show-scrollbar="false">
      <view class="presets-inner">
        <view
          v-for="p in presets"
          :key="p.key"
          class="preset-chip"
          :class="{ on: activePreset === p.key }"
          @click="applyPreset(p.key)"
        >{{ p.label }}</view>
        <!-- 时区切换 -->
        <view class="tz-group">
          <view class="tz-chip" :class="{ on: tz === 'Asia/Shanghai' }" @click="setTz('Asia/Shanghai')">北京</view>
          <view class="tz-chip" :class="{ on: tz === 'Europe/Moscow' }" @click="setTz('Europe/Moscow')">莫斯科</view>
        </view>
      </view>
    </scroll-view>

    <!-- 财务统计专用筛选:自然月 / 自定义日期 / 店铺 -->
    <template v-if="tab === 'finance'">
      <scroll-view v-if="monthPresets.length" class="presets months" scroll-x :show-scrollbar="false">
        <view class="presets-inner">
          <view
            v-for="mp in monthPresets"
            :key="mp.key"
            class="preset-chip month-chip"
            :class="{ on: activePreset === mp.key }"
            @click="applyMonth(mp)"
          >{{ mp.label }}</view>
        </view>
      </scroll-view>

      <view class="filter-bar">
        <!-- 自定义日期 -->
        <view class="date-range" :class="{ disabled: activePreset !== 'custom' }">
          <picker mode="date" :value="fromDate" :disabled="activePreset !== 'custom'" @change="onFromDateChange">
            <view class="date-box">{{ fromDate || '开始日期' }}</view>
          </picker>
          <text class="date-sep">~</text>
          <picker mode="date" :value="toDate" :disabled="activePreset !== 'custom'" @change="onToDateChange">
            <view class="date-box">{{ toDate || '结束日期' }}</view>
          </picker>
        </view>
        <!-- 店铺筛选 -->
        <view class="store-btn" @click="storePickerOpen = true">
          <text>{{ storeSelectionLabel }}</text>
          <text class="store-caret">▾</text>
        </view>
      </view>
    </template>

    <view class="range-hint">{{ rangeHint }}</view>
    <view v-if="error" class="error-bar">{{ error }}</view>

    <!-- ═══ 订单统计 ═══ -->
    <template v-if="tab === 'order'">
      <view v-if="orderData" class="summary-grid">
        <view class="summary-card s-new">
          <view class="sc-head">🆕 新订单</view>
          <view class="sc-count">{{ fmtCount(orderData.totals.new.count) }} 单</view>
          <view class="sc-money">¥{{ fmtMoney(orderData.totals.new.amount) }}</view>
          <view class="sc-sub">剔除取消 ¥{{ fmtMoney(orderData.totals.new.validAmount) }}</view>
        </view>
        <view class="summary-card s-pickup">
          <view class="sc-head">📦 揽收</view>
          <view class="sc-count">{{ fmtCount(orderData.totals.pickup.count) }} 单</view>
          <view class="sc-money">¥{{ fmtMoney(orderData.totals.pickup.amount) }}</view>
        </view>
        <view class="summary-card s-delivered">
          <view class="sc-head">✅ 签收</view>
          <view class="sc-count">{{ fmtCount(orderData.totals.delivered.count) }} 单</view>
          <view class="sc-money">¥{{ fmtMoney(orderData.totals.delivered.amount) }}</view>
        </view>
        <view class="summary-card s-returned">
          <view class="sc-head">↩️ 退货</view>
          <view class="sc-count">{{ fmtCount(orderData.totals.returned.count) }} 单</view>
          <view class="sc-money">¥{{ fmtMoney(orderData.totals.returned.amount) }}</view>
        </view>
      </view>

      <view v-if="orderData && orderData.byStore?.length" class="card store-list">
        <view class="section-title">分店铺明细</view>
        <view v-for="row in orderData.byStore" :key="row.storeId" class="store-row">
          <view class="store-head">
            <text class="store-name">{{ row.storeName }}</text>
            <text class="store-num">新订单 {{ fmtCount(row.new.count) }} · 金额 ¥{{ fmtMoney(row.new.amount) }}</text>
          </view>
          <view class="store-grid">
            <view class="sg-item"><text class="k">揽收</text><text class="v">{{ fmtCount(row.pickup.count) }} / ¥{{ fmtMoney(row.pickup.amount) }}</text></view>
            <view class="sg-item"><text class="k">签收</text><text class="v">{{ fmtCount(row.delivered.count) }} / ¥{{ fmtMoney(row.delivered.amount) }}</text></view>
            <view class="sg-item"><text class="k">退货</text><text class="v">{{ fmtCount(row.returned.count) }} / ¥{{ fmtMoney(row.returned.amount) }}</text></view>
            <view v-if="row.new.validAmount != null" class="sg-item"><text class="k">剔除取消</text><text class="v">¥{{ fmtMoney(row.new.validAmount) }}</text></view>
          </view>
        </view>
      </view>
      <view v-if="!loading && !orderData" class="empty">暂无数据</view>
    </template>

    <!-- ═══ 财务统计 ═══ -->
    <template v-else>
      <view v-if="finance" class="summary-grid">
        <view class="summary-card s-settled">
          <view class="sc-head">✅ 已结算利润</view>
          <view class="sc-count">{{ fmtCount(finance.settled.orderCount) }} 单</view>
          <view class="sc-money" :class="profitClass(finance.settled.totalProfit)">¥{{ fmtMoney(finance.settled.totalProfit) }}</view>
          <view class="sc-sub">销售利润率 {{ fmtRate(finance.settled.profitRateSale) }}</view>
          <view class="sc-sub">采购成本 ¥{{ fmtMoney(-finance.settled.totalPurchaseAmount) }}</view>
          <view class="sc-sub">回款 ¥{{ fmtMoney(finance.settled.totalPayout) }} · 成本利润率 {{ fmtRate(finance.settled.profitRateCost) }}</view>
        </view>
        <view class="summary-card s-pending">
          <view class="sc-head">🚚 在途预估利润{{ finance.pending.estimated ? '(估)' : '' }}</view>
          <view class="sc-count">{{ fmtCount(finance.pending.orderCount) }} 单</view>
          <view class="sc-money" :class="profitClass(finance.pending.totalProfit)">¥{{ fmtMoney(finance.pending.totalProfit) }}</view>
          <view class="sc-sub">订单 ¥{{ fmtMoney(finance.pending.totalOrderAmount) }}</view>
          <view class="sc-sub">采购成本 ¥{{ fmtMoney(-finance.pending.totalPurchaseAmount) }}</view>
          <view class="sc-sub">回款(估) ¥{{ fmtMoney(finance.pending.totalPayout) }}</view>
        </view>
        <view class="summary-card s-nonorder">
          <view class="sc-head">🧾 非订单应计</view>
          <view class="sc-money" :class="profitClass(finance.nonOrder.totalCny)">¥{{ fmtMoney(finance.nonOrder.totalCny) }}</view>
          <view class="sc-sub">{{ fmtCount(finance.nonOrder.count) }} 笔</view>
          <view v-if="rubRate" class="sc-sub">卢布汇率 {{ rubRate }}</view>
        </view>
      </view>

      <!-- 非订单应计明细 -->
      <view class="card">
        <view class="section-title">非订单应计明细</view>
        <view v-if="noLoading && !noItems.length" class="empty small">加载中…</view>
        <view v-else-if="!noItems.length" class="empty small">该范围内暂无非订单应计</view>
        <view v-else>
          <view v-for="it in noItems" :key="it.id" class="fin-row">
            <view class="fin-row-head">
              <text class="fin-posting">{{ it.nameCn }}<text v-if="it.typeId" class="type-id"> #{{ it.typeId }}</text></text>
              <text class="fin-profit" :class="profitClass(it.cny)">{{ fmtMoney(it.cny) }}</text>
            </view>
            <view class="fin-row-sub">
              <text>{{ it.accrualDate || '—' }}</text>
              <text>{{ it.storeName || '' }}</text>
              <text v-if="it.unitNumber">{{ it.unitNumber }}</text>
            </view>
          </view>
          <view v-if="noItems.length < noTotal" class="load-more" @click="loadMoreNo">{{ noLoading ? '加载中…' : '加载更多' }}</view>
        </view>
      </view>

      <!-- 订单列表 -->
      <view class="card">
        <view class="fin-tabs">
          <view class="fin-tab" :class="{ on: finGroup === 'settled' }" @click="setFinGroup('settled')">已结算</view>
          <view class="fin-tab" :class="{ on: finGroup === 'pending' }" @click="setFinGroup('pending')">在途</view>
        </view>
        <view v-if="finLoading && !finOrders.length" class="empty small">加载中…</view>
        <view v-else-if="!finOrders.length" class="empty small">暂无订单</view>
        <view v-else>
          <view v-for="o in finOrders" :key="o.packageId || o.id" class="fin-row">
            <view class="fin-row-head">
              <text class="fin-posting">{{ o.postingNumber || o.packageId }}</text>
              <text class="fin-store">{{ o.storeName || '' }}</text>
              <text class="fin-profit" :class="profitClass(o.profit)">{{ fmtMoney(o.profit) }}</text>
            </view>
            <view class="fin-row-sub">
              <text>订单 ¥{{ fmtMoney(o.orderAmount) }}</text>
              <text v-if="o.purchaseAmount != null">采购 ¥{{ fmtMoney(o.purchaseAmount) }}</text>
              <text v-if="o.estimated" class="est-tag">估</text>
            </view>
          </view>
          <view v-if="finOrders.length < finTotal" class="load-more" @click="loadMoreFin">{{ finLoading ? '加载中…' : '加载更多' }}</view>
        </view>
      </view>
    </template>

    <view v-if="loading" class="empty">加载中…</view>

    <!-- 店铺多选弹层 -->
    <view v-if="storePickerOpen" class="mask" @click="storePickerOpen = false">
      <view class="store-panel" @click.stop>
        <view class="store-panel-head">
          <text>选择店铺</text>
          <text class="store-panel-action" @click="selectAllStores">全选</text>
        </view>
        <scroll-view scroll-y class="store-panel-list">
          <view v-for="s in allStores" :key="s.id" class="store-option" @click="toggleStore(s.id)">
            <view class="check" :class="{ on: isStoreIncluded(s.id) }">{{ isStoreIncluded(s.id) ? '✓' : '' }}</view>
            <text>{{ s.name }}</text>
          </view>
          <view v-if="!allStores.length" class="empty small">无店铺数据</view>
        </scroll-view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import {
  getOrderStatsSummary,
  getFinanceSummary,
  getFinanceOrders,
  getNonOrderAccruals,
  getOrderMonths,
  getFinanceStores,
} from '../../api/stats.js';

const TZ_OPTIONS = [
  { value: 'Asia/Shanghai', label: '北京时间' },
  { value: 'Europe/Moscow', label: '莫斯科时间' },
];
const tab = ref('order');
const tz = ref('Asia/Shanghai');
const activePreset = ref('today');
const fromDate = ref('');
const toDate = ref('');
const orderData = ref(null);
const finance = ref(null);
const loading = ref(false);
const error = ref('');
const finGroup = ref('settled');
const finOrders = ref([]);
const finLoading = ref(false);
const finPage = ref(1);
const finTotal = ref(0);
const noItems = ref([]);
const noLoading = ref(false);
const noPage = ref(1);
const noTotal = ref(0);
const rubRate = ref('');
// 店铺筛选
const allStores = ref([]);
const selectedStoreIds = ref(new Set());
const storePickerOpen = ref(false);
// 自然月快捷
const monthPresets = ref([]);
const PAGE_SIZE = 10;

function pad(n) { return String(n).padStart(2, '0'); }
function tzDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: tz.value, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return {
    y: Number(parts.find((p) => p.type === 'year').value),
    m: Number(parts.find((p) => p.type === 'month').value),
    d: Number(parts.find((p) => p.type === 'day').value),
  };
}
function shiftLocalDays(n) {
  const { y, m, d } = tzDate();
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function firstOfMonth(y, m) { return `${y}-${pad(m)}-01`; }
function firstOfNextMonth(y, m) { return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`; }

// 订单统计预设
const ORDER_PRESETS = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: '7d', label: '近7日' },
  { key: '30d', label: '近30日' },
  { key: 'thisMonth', label: '本月' },
];
// 财务统计预设(对齐 web:全部/近7/14/30日/本月/自定义)
const FIN_PRESETS = [
  { key: 'all', label: '全部' },
  { key: '7d', label: '近7日' },
  { key: '14d', label: '近14日' },
  { key: '30d', label: '近30日' },
  { key: 'thisMonth', label: '本月' },
  { key: 'custom', label: '自定义' },
];
const presets = computed(() => (tab.value === 'order' ? ORDER_PRESETS : FIN_PRESETS));

function presetRange(key) {
  const todayStr = shiftLocalDays(0);
  switch (key) {
    case 'all': return { from: '', to: '' };
    case 'today': return { from: todayStr, to: shiftLocalDays(1) };
    case 'yesterday': return { from: shiftLocalDays(-1), to: todayStr };
    // 「近 N 日」= 含今天往前共 N 个自然日:from 取今天-(N-1),to 为明天(排他日界)
    case '7d': return { from: shiftLocalDays(-6), to: shiftLocalDays(1) };
    case '14d': return { from: shiftLocalDays(-13), to: shiftLocalDays(1) };
    case '30d': return { from: shiftLocalDays(-29), to: shiftLocalDays(1) };
    case 'thisMonth': {
      const { y, m } = tzDate();
      return { from: firstOfMonth(y, m), to: shiftLocalDays(1) };
    }
    default: return null;
  }
}

function rangeHint() {
  if (tab.value === 'order') return `统计区间:${fromDate.value || '—'} ~ ${toDate.value || '—'}(按事件时间)`;
  return `统计区间:${fromDate.value || '全部时间'} ~ ${toDate.value || ''}(订单按下单时间)`;
}
const rangeHintText = computed(rangeHint);

// 公共查询参数(店铺多选:空集合=全选)
function baseParams() {
  const p = {};
  if (fromDate.value && toDate.value) { p.from = fromDate.value; p.to = toDate.value; }
  p.tz = tz.value;
  if (selectedStoreIds.value.size > 0) p.storeIds = [...selectedStoreIds.value].join(',');
  return p;
}

function setTz(v) {
  if (tz.value === v) return;
  tz.value = v;
  if (tab.value === 'finance') loadOrderMonths(); // 月界随时区变化,重新拉取有订单月份
  applyPreset(activePreset.value);
}
function applyPreset(key) {
  activePreset.value = key;
  if (key === 'custom') {
    // 自定义必须两端齐全才查询;只填一端视为未完成不触发
    if (fromDate.value && toDate.value) loadData();
    return;
  }
  const r = presetRange(key);
  if (!r) return;
  fromDate.value = r.from;
  toDate.value = r.to;
  loadData();
}
function onFromDateChange(e) {
  fromDate.value = e.detail.value;
  activePreset.value = 'custom';
  if (fromDate.value && toDate.value) loadData();
}
function onToDateChange(e) {
  toDate.value = e.detail.value;
  activePreset.value = 'custom';
  if (fromDate.value && toDate.value) loadData();
}
function switchTab(t) {
  if (tab.value === t) return;
  tab.value = t;
  applyPreset(t === 'order' ? 'today' : 'all');
}

// 自然月快捷
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
        to: firstOfNextMonth(y, m),
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
  loadData();
}

// 店铺筛选
async function loadStores() {
  try {
    const r = await getFinanceStores();
    allStores.value = (r?.stores || []).filter((s) => s?.id && s?.name).map((s) => ({ id: s.id, name: s.name }));
  } catch (e) {
    allStores.value = [];
  }
}
function isStoreIncluded(id) {
  return selectedStoreIds.value.size === 0 || selectedStoreIds.value.has(id);
}
function toggleStore(id) {
  const s = new Set(selectedStoreIds.value.size === 0 ? allStores.value.map((x) => x.id) : selectedStoreIds.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  selectedStoreIds.value = s;
  loadData();
}
function selectAllStores() {
  selectedStoreIds.value = new Set();
  storePickerOpen.value = false;
  loadData();
}
const storeSelectionLabel = computed(() => {
  const n = selectedStoreIds.value.size;
  return n === 0 ? '全部店铺' : `已选 ${n}/${allStores.value.length}`;
});

async function loadData() {
  loading.value = true;
  error.value = '';
  try {
    if (tab.value === 'order') {
      orderData.value = await getOrderStatsSummary(baseParams());
    } else {
      const r = await getFinanceSummary(baseParams());
      finance.value = r;
      rubRate.value = r?.rubRate ? `1₽=¥${Number(r.rubRate).toFixed(4)}` : '';
      finPage.value = 1;
      noPage.value = 1;
      await Promise.all([loadFinOrders(true), loadNonOrder(true)]);
    }
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

// 财务订单列表(分页,reset=true 时从第一页开始)
async function loadFinOrders(reset = false) {
  finLoading.value = true;
  const page = reset ? 1 : finPage.value;
  const params = { ...baseParams(), group: finGroup.value, page, pageSize: PAGE_SIZE };
  try {
    const r = await getFinanceOrders(params);
    finTotal.value = r?.total || 0;
    const list = r?.orders || [];
    finOrders.value = reset ? list : [...finOrders.value, ...list];
    finPage.value = page + 1;
  } catch (e) {
    if (reset) finOrders.value = [];
    finTotal.value = 0;
  } finally {
    finLoading.value = false;
  }
}
function setFinGroup(g) {
  if (finGroup.value === g) return;
  finGroup.value = g;
  loadFinOrders(true);
}
function loadMoreFin() {
  if (finLoading.value || finOrders.value.length >= finTotal.value) return;
  loadFinOrders(false);
}

// 非订单应计明细(分页,reset=true 时从第一页开始)
async function loadNonOrder(reset = false) {
  noLoading.value = true;
  const page = reset ? 1 : noPage.value;
  const params = { ...baseParams(), page, pageSize: PAGE_SIZE };
  try {
    const r = await getNonOrderAccruals(params);
    noTotal.value = r?.total || 0;
    const list = r?.items || [];
    noItems.value = reset ? list : [...noItems.value, ...list];
    noPage.value = page + 1;
  } catch (e) {
    if (reset) noItems.value = [];
    noTotal.value = 0;
  } finally {
    noLoading.value = false;
  }
}
function loadMoreNo() {
  if (noLoading.value || noItems.value.length >= noTotal.value) return;
  loadNonOrder(false);
}

function fmtMoney(n) {
  return Number(n || 0).toFixed(2);
}
function fmtCount(n) {
  return String(Number(n) || 0);
}
function fmtRate(n) {
  return n == null ? '—' : Number(n).toFixed(2) + '%';
}
function profitClass(v) {
  const n = Number(v) || 0;
  if (n > 0) return 'profit-pos';
  if (n < 0) return 'profit-neg';
  return '';
}

onLoad(() => {
  applyPreset('today');
  loadOrderMonths();
  loadStores();
});
onPullDownRefresh(async () => {
  await Promise.all([loadData(), loadOrderMonths(), loadStores()]);
  uni.stopPullDownRefresh();
});
</script>

<style scoped>
.page {
  padding: 20rpx 24rpx 60rpx;
}
.tabs {
  display: flex;
  background: #ffffff;
  border-radius: 14rpx;
  padding: 6rpx;
}
.tab {
  flex: 1;
  text-align: center;
  font-size: 27rpx;
  color: #4e5969;
  padding: 14rpx 0;
  border-radius: 10rpx;
}
.tab.on {
  background: #165dff;
  color: #ffffff;
  font-weight: 600;
}

.presets {
  margin-top: 16rpx;
  white-space: nowrap;
}
.presets-inner {
  display: inline-flex;
  align-items: center;
  padding: 4rpx 2rpx;
}
.preset-chip {
  display: inline-flex;
  align-items: center;
  font-size: 23rpx;
  color: #4e5969;
  background: #ffffff;
  border-radius: 999rpx;
  padding: 8rpx 22rpx;
  margin-right: 12rpx;
}
.preset-chip.on {
  color: #ffffff;
  background: #165dff;
  font-weight: 600;
}
.tz-group {
  display: inline-flex;
  margin-left: 6rpx;
}
.tz-chip {
  font-size: 22rpx;
  color: #4e5969;
  background: #f2f3f5;
  padding: 8rpx 16rpx;
}
.tz-chip:first-child {
  border-radius: 999rpx 0 0 999rpx;
}
.tz-chip:last-child {
  border-radius: 0 999rpx 999rpx 0;
}
.tz-chip.on {
  color: #165dff;
  background: #eef4ff;
  font-weight: 600;
}

/* 自然月横滑 */
.months {
  margin-top: 8rpx;
}
.month-chip {
  background: #f2f3f5;
}

/* 财务统计筛选栏:自定义日期 + 店铺 */
.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
  flex-wrap: wrap;
  margin-top: 12rpx;
}
.date-range {
  display: flex;
  align-items: center;
  gap: 8rpx;
}
.date-range.disabled {
  opacity: 0.5;
}
.date-box {
  font-size: 22rpx;
  color: #4e5969;
  background: #ffffff;
  border-radius: 999rpx;
  padding: 8rpx 18rpx;
  border: 1rpx solid #e5e6eb;
}
.date-sep {
  color: #86909c;
  font-size: 22rpx;
}
.store-btn {
  display: flex;
  align-items: center;
  font-size: 22rpx;
  color: #4e5969;
  background: #ffffff;
  border-radius: 999rpx;
  padding: 8rpx 18rpx;
  border: 1rpx solid #e5e6eb;
}
.store-caret {
  margin-left: 6rpx;
  font-size: 18rpx;
  color: #86909c;
}

.range-hint {
  margin-top: 12rpx;
  font-size: 21rpx;
  color: #86909c;
}
.error-bar {
  margin-top: 12rpx;
  font-size: 24rpx;
  color: #f53f3f;
  background: #ffece8;
  padding: 12rpx 16rpx;
  border-radius: 10rpx;
}

.summary-grid {
  margin-top: 16rpx;
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
}
.summary-card {
  flex: 1 1 calc(50% - 8rpx);
  background: #ffffff;
  border-radius: 16rpx;
  padding: 20rpx;
  box-sizing: border-box;
  min-width: calc(50% - 8rpx);
}
.sc-head {
  font-size: 23rpx;
  color: #4e5969;
}
.sc-count {
  margin-top: 8rpx;
  font-size: 30rpx;
  font-weight: 600;
  color: #1f2329;
}
.sc-money {
  margin-top: 4rpx;
  font-size: 32rpx;
  font-weight: 700;
  color: #1f2329;
  font-variant-numeric: tabular-nums;
}
.sc-sub {
  margin-top: 4rpx;
  font-size: 21rpx;
  color: #86909c;
}
.s-new .sc-money { color: #165dff; }
.s-pickup .sc-money { color: #d97706; }
.s-delivered .sc-money { color: #00b42a; }
.s-returned .sc-money { color: #f53f3f; }
.profit-pos { color: #00b42a !important; }
.profit-neg { color: #f53f3f !important; }

.card {
  background: #ffffff;
  border-radius: 16rpx;
  padding: 20rpx;
  margin-top: 16rpx;
}
.section-title {
  font-size: 27rpx;
  font-weight: 600;
  color: #1f2329;
  margin-bottom: 12rpx;
}
.store-row {
  padding: 14rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}
.store-row:last-child {
  border-bottom: none;
}
.store-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
}
.store-name {
  font-size: 26rpx;
  font-weight: 600;
  color: #1f2329;
}
.store-num {
  font-size: 22rpx;
  color: #165dff;
}
.store-grid {
  margin-top: 10rpx;
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
}
.sg-item {
  flex: 1 1 calc(50% - 5rpx);
  font-size: 22rpx;
  color: #4e5969;
}
.sg-item .k {
  color: #86909c;
  margin-right: 6rpx;
}

.fin-tabs {
  display: flex;
  margin-bottom: 12rpx;
}
.fin-tab {
  font-size: 24rpx;
  color: #4e5969;
  padding: 8rpx 24rpx;
  border-radius: 999rpx;
  margin-right: 12rpx;
  background: #f2f3f5;
}
.fin-tab.on {
  color: #ffffff;
  background: #165dff;
  font-weight: 600;
}
.fin-row {
  padding: 12rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}
.fin-row:last-child {
  border-bottom: none;
}
.fin-row-head {
  display: flex;
  align-items: center;
}
.fin-posting {
  flex: 1;
  font-family: 'Courier New', monospace;
  font-size: 24rpx;
  color: #1f2329;
}
.fin-store {
  font-size: 21rpx;
  color: #86909c;
  margin-right: 12rpx;
}
.fin-profit {
  font-size: 26rpx;
  font-weight: 600;
  color: #1f2329;
  font-variant-numeric: tabular-nums;
}
.fin-row-sub {
  margin-top: 4rpx;
  font-size: 21rpx;
  color: #86909c;
  display: flex;
  gap: 16rpx;
  align-items: center;
}
.type-id {
  color: #86909c;
  font-size: 20rpx;
  margin-left: 4rpx;
}
.est-tag {
  font-size: 18rpx;
  color: #d97706;
  border: 1rpx solid #d97706;
  border-radius: 6rpx;
  padding: 0 6rpx;
}

/* 加载更多 */
.load-more {
  text-align: center;
  color: #165dff;
  font-size: 24rpx;
  padding: 16rpx 0 4rpx;
}

/* 店铺多选弹层 */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 999;
  display: flex;
  align-items: flex-end;
}
.store-panel {
  width: 100%;
  background: #ffffff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 24rpx 24rpx 40rpx;
  box-sizing: border-box;
}
.store-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  margin-bottom: 16rpx;
}
.store-panel-action {
  font-size: 24rpx;
  color: #165dff;
  font-weight: 500;
}
.store-panel-list {
  max-height: 50vh;
}
.store-option {
  display: flex;
  align-items: center;
  gap: 12rpx;
  padding: 16rpx 4rpx;
  font-size: 26rpx;
  color: #1f2329;
  border-bottom: 1rpx solid #f7f8fa;
}
.check {
  width: 36rpx;
  height: 36rpx;
  border-radius: 50%;
  border: 2rpx solid #c9cdd4;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24rpx;
  color: #ffffff;
  flex-shrink: 0;
}
.check.on {
  background: #165dff;
  border-color: #165dff;
}

.empty {
  text-align: center;
  padding: 60rpx 0;
  color: #a6abb3;
  font-size: 25rpx;
}
.empty.small {
  padding: 30rpx 0;
}
</style>