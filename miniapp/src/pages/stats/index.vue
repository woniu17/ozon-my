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
        </view>
        <view class="summary-card s-pending">
          <view class="sc-head">🚚 在途预估利润{{ finance.pending.estimated ? '(估)' : '' }}</view>
          <view class="sc-count">{{ fmtCount(finance.pending.orderCount) }} 单</view>
          <view class="sc-money" :class="profitClass(finance.pending.totalProfit)">¥{{ fmtMoney(finance.pending.totalProfit) }}</view>
          <view class="sc-sub">订单 ¥{{ fmtMoney(finance.pending.totalOrderAmount) }}</view>
        </view>
        <view class="summary-card s-nonorder">
          <view class="sc-head">🧾 非订单应计</view>
          <view class="sc-money" :class="profitClass(finance.nonOrder.totalCny)">¥{{ fmtMoney(finance.nonOrder.totalCny) }}</view>
          <view v-if="rubRate" class="sc-sub">卢布汇率 {{ rubRate }}</view>
        </view>
      </view>

      <!-- 订单列表 -->
      <view class="card">
        <view class="fin-tabs">
          <view class="fin-tab" :class="{ on: finGroup === 'settled' }" @click="setFinGroup('settled')">已结算</view>
          <view class="fin-tab" :class="{ on: finGroup === 'pending' }" @click="setFinGroup('pending')">在途</view>
        </view>
        <view v-if="finLoading" class="empty small">加载中…</view>
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
            </view>
          </view>
        </view>
      </view>
    </template>

    <view v-if="loading" class="empty">加载中…</view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import { getOrderStatsSummary, getFinanceSummary, getFinanceOrders } from '../../api/stats.js';

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
const rubRate = ref('');

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
// 财务统计预设
const FIN_PRESETS = [
  { key: 'all', label: '全部' },
  { key: '7d', label: '近7日' },
  { key: '30d', label: '近30日' },
  { key: 'thisMonth', label: '本月' },
];
const presets = computed(() => (tab.value === 'order' ? ORDER_PRESETS : FIN_PRESETS));

function presetRange(key) {
  const todayStr = shiftLocalDays(0);
  switch (key) {
    case 'all': return { from: '', to: '' };
    case 'today': return { from: todayStr, to: shiftLocalDays(1) };
    case 'yesterday': return { from: shiftLocalDays(-1), to: todayStr };
    case '7d': return { from: shiftLocalDays(-6), to: shiftLocalDays(1) };
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

function setTz(v) {
  if (tz.value === v) return;
  tz.value = v;
  applyPreset(activePreset.value);
}
function applyPreset(key) {
  activePreset.value = key;
  const r = presetRange(key);
  if (!r) return;
  fromDate.value = r.from;
  toDate.value = r.to;
  loadData();
}
function switchTab(t) {
  if (tab.value === t) return;
  tab.value = t;
  // 切换时重置为各 tab 默认预设并加载
  applyPreset(t === 'order' ? 'today' : 'all');
}

async function loadData() {
  loading.value = true;
  error.value = '';
  const params = {};
  if (fromDate.value && toDate.value) { params.from = fromDate.value; params.to = toDate.value; }
  params.tz = tz.value;
  try {
    if (tab.value === 'order') {
      orderData.value = await getOrderStatsSummary(params);
    } else {
      const r = await getFinanceSummary(params);
      finance.value = r;
      rubRate.value = r?.rubRate ? `1₽=¥${Number(r.rubRate).toFixed(4)}` : '';
      await loadFinOrders();
    }
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function loadFinOrders() {
  finLoading.value = true;
  const params = {};
  if (fromDate.value && toDate.value) { params.from = fromDate.value; params.to = toDate.value; }
  params.tz = tz.value;
  params.group = finGroup.value;
  params.page = 1;
  params.pageSize = 10;
  try {
    const r = await getFinanceOrders(params);
    finOrders.value = r?.orders || [];
  } catch (e) {
    finOrders.value = [];
  } finally {
    finLoading.value = false;
  }
}
function setFinGroup(g) {
  if (finGroup.value === g) return;
  finGroup.value = g;
  loadFinOrders();
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
});
onPullDownRefresh(async () => {
  await loadData();
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