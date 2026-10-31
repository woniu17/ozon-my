<template>
  <view class="page">
    <!-- 时间预设(横滑) -->
    <scroll-view class="presets" scroll-x :show-scrollbar="false">
      <view class="presets-inner">
        <view
          v-for="p in presets"
          :key="p.key"
          class="preset-chip"
          :class="{ on: activePreset === p.key }"
          @click="applyPreset(p.key)"
        >{{ p.label }}</view>
        <picker mode="date" :value="fromDate" @change="onFromChange">
          <view class="preset-chip" :class="{ on: activePreset === 'custom' }">{{ fromDate || '起' }}</view>
        </picker>
        <picker mode="date" :value="toDate" @change="onToChange">
          <view class="preset-chip" :class="{ on: activePreset === 'custom' }">{{ toDate || '止' }}</view>
        </picker>
      </view>
    </scroll-view>

    <!-- 店铺选择 + 同步 -->
    <view class="filter-bar">
      <scroll-view class="store-scroll" scroll-x :show-scrollbar="false">
        <view class="presets-inner">
          <view class="preset-chip" :class="{ on: currentStoreId === '' }" @click="selectStore('')">全部店铺</view>
          <view
            v-for="s in stores"
            :key="s.id"
            class="preset-chip"
            :class="{ on: currentStoreId === s.id }"
            @click="selectStore(s.id)"
          >{{ s.name }}</view>
        </view>
      </scroll-view>
      <view class="sync-btn" :class="{ loading: syncing }" @click="doSync">{{ syncing ? '同步中…' : '🔄 同步' }}</view>
    </view>

    <view class="range-hint">{{ fromDate }} ~ {{ toDate }} · 错误指数为周期汇总</view>
    <view v-if="error" class="error-bar">{{ error }}</view>
    <view v-if="syncError" class="error-bar">同步失败:{{ syncError }}</view>

    <!-- ═══ 概览指标卡 ═══ -->
    <view v-if="summary && summary.stores.length" class="summary-grid">
      <view class="summary-card">
        <view class="sc-head">🏥 错误指数</view>
        <view class="sc-count">{{ fmtIndex(topStore.index) }}</view>
        <view class="sc-sub">{{ topStore.storeName }}</view>
        <view class="sc-sub">{{ topStore.periodFrom }} ~ {{ topStore.periodTo }}</view>
      </view>
      <view class="summary-card">
        <view class="sc-head">💰 错误处理费用</view>
        <view class="sc-count">¥{{ fmtMoney(totals.chargeSum) }}</view>
        <view class="sc-sub">{{ totals.errorPostingCount }} 单计费</view>
      </view>
      <view class="summary-card">
        <view class="sc-head">📦 影响货件</view>
        <view class="sc-count">{{ fmtNum(totals.errorPostingCount) }} 单</view>
        <view class="sc-sub">取消 <text class="red-t">{{ fmtNum(totals.sellerCancellationCount) }}</text> · 逾期 <text class="orange-t">{{ fmtNum(totals.sellerDelayCount) }}</text></view>
      </view>
      <view class="summary-card">
        <view class="sc-head">🛡️ 宽限货件</view>
        <view class="sc-count">{{ fmtNum(totals.graceCount) }} 单</view>
        <view class="sc-sub">has_grace_status=true</view>
      </view>
    </view>
    <view v-else-if="summary" class="empty-tip">暂无错误指数数据,点击「同步」拉取 Ozon 最新数据</view>

    <!-- ═══ 每日错误指数趋势(分组柱状) ═══ -->
    <view v-if="hasChart" class="chart-card">
      <view class="chart-title">每日错误指数趋势</view>
      <scroll-view scroll-x :show-scrollbar="false">
        <view class="bars">
          <view v-for="d in chartDates" :key="d" class="bar-col">
            <view class="bar-track">
              <view class="bar-group">
                <view
                  v-for="seg in dailySegments(d)"
                  :key="seg.storeId"
                  class="bar-single"
                  :style="{ height: seg.pct + '%', background: seg.color }"
                ></view>
              </view>
            </view>
            <view class="bar-date">{{ d.slice(5) }}</view>
          </view>
        </view>
      </scroll-view>
      <view class="legend">
        <view v-for="s in chartSeries" :key="'lg' + s.storeId" class="legend-item">
          <view class="legend-color" :style="{ background: s.color }"></view>
          <text>{{ s.storeName }}</text>
        </view>
      </view>
    </view>

    <!-- ═══ 每日错误处理费用(柱状) ═══ -->
    <view v-if="costBars.length" class="chart-card">
      <view class="chart-title">每日错误处理费用</view>
      <scroll-view scroll-x :show-scrollbar="false">
        <view class="bars">
          <view v-for="b in costBars" :key="b.date" class="bar-col">
            <view class="bar-track">
              <view class="bar-group">
                <view class="bar-single cost" :style="{ height: Math.max(2, (b.total / costMax) * 100) + '%' }"></view>
              </view>
            </view>
            <view class="bar-date">{{ b.date.slice(5) }}</view>
          </view>
        </view>
      </scroll-view>
      <view class="bar-hint">最高 ¥{{ fmtMoney(costMax) }}</view>
    </view>

    <!-- ═══ 错误类型分布 ═══ -->
    <view v-if="totals && totals.errorPostingCount > 0" class="chart-card">
      <view class="chart-title">错误类型分布</view>
      <view v-for="it in typeDist" :key="it.key" class="dist-item">
        <view class="dist-head">
          <text :style="{ color: it.color }">{{ it.label }}</text>
          <text class="dist-num">{{ it.count }} 单 · {{ it.pct }}%</text>
        </view>
        <view class="dist-track">
          <view class="dist-fill" :style="{ width: it.pct + '%', background: it.color }"></view>
        </view>
      </view>
    </view>

    <!-- ═══ 影响货件明细 ═══ -->
    <view class="list-head">
      <text>影响货件明细({{ total }})</text>
      <text class="list-head-hint">点击单号复制</text>
    </view>
    <view v-for="it in items" :key="it.storeId + it.postingNumber" class="err-item">
      <view class="err-top">
        <text class="posting" @click="copyPosting(it.postingNumber)">{{ it.postingNumber }}</text>
        <text class="tag" :class="it.postingErrorType === 'SELLER_CANCELLATION' ? 'tag-cancel' : 'tag-delay'">{{ typeLabel(it.postingErrorType) }}</text>
      </view>
      <view class="err-mid">{{ it.storeName }} · {{ it.errorAt }} · {{ it.deliverySchema || '未知方案' }}</view>
      <view class="err-bottom">
        <text>货值 ¥{{ fmtMoney(it.productPrice) }}</text>
        <text class="red-t">费用 ¥{{ fmtMoney(it.chargePrice) }}</text>
        <text class="grace" :class="it.hasGraceStatus ? 'grace-yes' : 'grace-no'">{{ it.hasGraceStatus ? '宽限' : '计费' }}</text>
      </view>
    </view>
    <view v-if="items.length === 0 && !loading" class="empty-tip">该区间内没有影响错误指数的货件</view>

    <view v-if="hasMore" class="load-more" @click="loadMore">加载更多</view>
    <view v-if="loading" class="load-more">加载中…</view>
  </view>
</template>

<script setup>
// 店铺健康-错误指数(2026-11-03,H5)
// 数据源:Ozon /v1/rating/index/fbs/info + /v1/rating/index/fbs/posting/list(后端落库)
// 设计文档: docs/店铺健康页面-功能设计.md
import { ref, computed } from 'vue';
import { onShow, onReachBottom } from '@dcloudio/uni-app';
import {
  getRatingSummary,
  getRatingErrors,
  triggerRatingSync,
  getRatingSyncStatus,
  getStores,
} from '../../api/store-health.js';

// ── 时间预设 ──
const presets = [
  { key: '7d', label: '近7日' },
  { key: '30d', label: '近30日' },
  { key: 'thisMonth', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'custom', label: '自定义' },
];
const activePreset = ref('7d');
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
function onFromChange(e) {
  activePreset.value = 'custom';
  fromDate.value = e.detail.value;
  if (fromDate.value && toDate.value && fromDate.value > toDate.value) toDate.value = fromDate.value;
  pager.offset = 0;
  loadAll();
}
function onToChange(e) {
  activePreset.value = 'custom';
  toDate.value = e.detail.value;
  if (fromDate.value && toDate.value && fromDate.value > toDate.value) fromDate.value = toDate.value;
  pager.offset = 0;
  loadAll();
}

// ── 店铺选择(空=全部) ──
const stores = ref([]);
const currentStoreId = ref('');

// ── 数据 ──
const summary = ref(null);
const items = ref([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const syncError = ref('');
const syncing = ref(false);
const pager = ref({ offset: 0, limit: 20 });

function storeIdsParam() {
  return currentStoreId.value || '';
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
    const res = await getRatingErrors({
      from: fromDate.value,
      to: toDate.value,
      storeIds: storeIdsParam(),
      offset: pager.value.offset,
      limit: pager.value.limit,
    });
    if (pager.value.offset === 0) items.value = res.items || [];
    else items.value = items.value.concat(res.items || []);
    total.value = res.total || 0;
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

// ── 手动同步 ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function doSync() {
  if (syncing.value) return;
  syncing.value = true;
  syncError.value = '';
  try {
    await triggerRatingSync({
      storeIds: storeIdsParam() || undefined,
      from: fromDate.value,
      to: toDate.value,
    });
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const st = await getRatingSyncStatus();
      if (!st.running) break;
    }
    pager.value.offset = 0;
    await loadAll();
  } catch (e) {
    syncError.value = e.message;
  } finally {
    syncing.value = false;
  }
}

// ── 概览指标 ──
const topStore = computed(() => {
  const stores = summary.value?.stores || [];
  if (!stores.length) return null;
  return [...stores].sort((a, b) => (Number(b.index) || 0) - (Number(a.index) || 0))[0];
});
function indexStatus(idx) {
  const n = Number(idx) || 0;
  if (n <= 0.15) return 'ok';
  if (n <= 0.35) return 'warning';
  return 'critical';
}
const totals = computed(() => summary.value?.totals || null);

// ── 趋势图 ──
const STORE_COLORS = ['#165dff', '#00b42a', '#d97706', '#722ed1', '#eb2f96', '#13c2c2', '#fa8c16'];
const chartSeries = computed(() => {
  const stores = summary.value?.stores || [];
  return stores.map((s, i) => ({
    storeId: s.storeId,
    storeName: s.storeName,
    color: STORE_COLORS[i % STORE_COLORS.length],
    defects: (s.defects || []).filter((d) => d.date >= fromDate.value && d.date <= toDate.value),
  }));
});
const chartDates = computed(() => {
  const set = new Set();
  for (const s of chartSeries.value) for (const d of s.defects) set.add(d.date);
  return [...set].sort();
});
const chartMax = computed(() => {
  let m = 0;
  for (const s of chartSeries.value) for (const d of s.defects) m = Math.max(m, Number(d.indexByDate) || 0);
  return m > 0 ? m : 1;
});
const hasChart = computed(() => chartDates.value.length > 0);
function dailySegments(date) {
  return chartSeries.value
    .filter((s) => s.defects.some((d) => d.date === date))
    .map((s) => {
      const d = s.defects.find((x) => x.date === date);
      return {
        storeId: s.storeId,
        color: s.color,
        pct: Math.max(2, ((Number(d.indexByDate) || 0) / chartMax.value) * 100),
      };
    });
}
// 每日费用柱状(跨店累计)
const costBars = computed(() => {
  const map = new Map();
  for (const s of chartSeries.value) {
    for (const d of s.defects) {
      map.set(d.date, (map.get(d.date) || 0) + (Number(d.processingCostsSumByDate) || 0));
    }
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, t]) => ({ date, total: t }));
});
const costMax = computed(() => {
  let m = 0;
  for (const b of costBars.value) m = Math.max(m, b.total);
  return m > 0 ? m : 1;
});

// ── 分布 ──
const typeDist = computed(() => {
  const t = totals.value;
  if (!t) return [];
  const items = [
    { key: 'SELLER_CANCELLATION', label: '卖家取消', count: t.sellerCancellationCount, color: '#f53f3f' },
    { key: 'SELLER_DELAY', label: '卖家逾期', count: t.sellerDelayCount, color: '#d97706' },
  ];
  const sum = t.errorPostingCount || 1;
  return items.map((it) => ({ ...it, pct: Math.round((it.count / sum) * 100) }));
});

// ── 明细分页 ──
const hasMore = computed(() => items.value.length < total.value);
function loadMore() {
  if (loading.value || !hasMore.value) return;
  pager.value.offset += pager.value.limit;
  loadErrors();
}
function copyPosting(postingNumber) {
  uni.setClipboardData({
    data: postingNumber,
    success: () => uni.showToast({ title: '货件号已复制', icon: 'none' }),
  });
}

// ── 格式化 ──
function fmtNum(n) { return String(Number(n) || 0); }
function fmtMoney(n) { return (Number(n) || 0).toFixed(2); }
function fmtIndex(n) { return (Number(n) || 0).toFixed(2); }
function typeLabel(t) {
  return t === 'SELLER_CANCELLATION' ? '卖家取消' : t === 'SELLER_DELAY' ? '卖家逾期' : t || '未知';
}

// ── 生命周期 ──
onShow(() => {
  const r = presetRange('7d');
  fromDate.value = r.from;
  toDate.value = r.to;
  getStores()
    .then((res) => {
      stores.value = res?.stores || [];
    })
    .catch(() => {});
  loadAll();
});
onReachBottom(() => {
  loadMore();
});
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding: 20rpx 24rpx 60rpx;
  box-sizing: border-box;
  background: #f5f6f7;
}

.presets,
.filter-bar {
  margin-bottom: 16rpx;
}
.presets-inner {
  display: inline-flex;
  padding: 4rpx 8rpx;
  gap: 12rpx;
}
.preset-chip {
  padding: 10rpx 26rpx;
  border-radius: 999rpx;
  font-size: 24rpx;
  color: #4e5969;
  background: #fff;
  border: 1rpx solid #e5e6eb;
  white-space: nowrap;
}
.preset-chip.on {
  background: #165dff;
  color: #fff;
  border-color: #165dff;
}
.filter-bar {
  display: flex;
  align-items: center;
  gap: 12rpx;
}
.store-scroll {
  flex: 1;
  min-width: 0;
}
.sync-btn {
  padding: 12rpx 24rpx;
  border-radius: 999rpx;
  background: #165dff;
  color: #fff;
  font-size: 24rpx;
  white-space: nowrap;
}
.sync-btn.loading {
  opacity: 0.7;
}

.range-hint {
  font-size: 22rpx;
  color: #86909c;
  margin-bottom: 16rpx;
}
.error-bar {
  background: #ffece8;
  color: #f53f3f;
  border-radius: 12rpx;
  padding: 16rpx 20rpx;
  font-size: 24rpx;
  margin-bottom: 16rpx;
}

/* 概览卡片 */
.summary-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
  margin-bottom: 20rpx;
}
.summary-card {
  flex: 1 1 calc(50% - 8rpx);
  min-width: 300rpx;
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  box-sizing: border-box;
}
.sc-head {
  font-size: 24rpx;
  color: #4e5969;
  margin-bottom: 10rpx;
}
.sc-count {
  font-size: 44rpx;
  font-weight: 700;
  color: #1f2329;
  line-height: 1.2;
}
.sc-sub {
  font-size: 22rpx;
  color: #86909c;
  margin-top: 6rpx;
}
.red-t { color: #f53f3f; }
.orange-t { color: #d97706; }

/* 图表卡片 */
.chart-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}
.chart-title {
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  margin-bottom: 16rpx;
}
.bars {
  display: flex;
  align-items: flex-end;
  gap: 8rpx;
  min-width: 100%;
  height: 240rpx;
}
.bar-col {
  flex: 1;
  min-width: 48rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
}
.bar-track {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  background: #f7f8fa;
  border-radius: 6rpx 6rpx 0 0;
  overflow: hidden;
}
.bar-group {
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2rpx;
  height: 100%;
}
.bar-single {
  width: 50%;
  max-width: 24rpx;
  background: #165dff;
  border-radius: 4rpx 4rpx 0 0;
  min-height: 2rpx;
}
.bar-single.cost {
  width: 70%;
  background: #165dff;
}
.bar-date {
  font-size: 18rpx;
  color: #86909c;
  margin-top: 8rpx;
  white-space: nowrap;
}
.bar-hint {
  font-size: 22rpx;
  color: #86909c;
  margin-top: 8rpx;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 20rpx;
  margin-top: 16rpx;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 8rpx;
  font-size: 22rpx;
  color: #4e5969;
}
.legend-color {
  width: 28rpx;
  height: 8rpx;
  border-radius: 4rpx;
}

/* 分布 */
.dist-item {
  margin-bottom: 20rpx;
}
.dist-head {
  display: flex;
  justify-content: space-between;
  font-size: 24rpx;
  margin-bottom: 8rpx;
}
.dist-num {
  color: #86909c;
}
.dist-track {
  height: 12rpx;
  background: #f2f3f5;
  border-radius: 6rpx;
  overflow: hidden;
}
.dist-fill {
  height: 100%;
  border-radius: 6rpx;
}

/* 明细列表 */
.list-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  margin: 8rpx 4rpx 16rpx;
}
.list-head-hint {
  font-size: 22rpx;
  font-weight: 400;
  color: #86909c;
}
.err-item {
  background: #fff;
  border-radius: 16rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 16rpx;
}
.err-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
}
.posting {
  font-family: monospace;
  font-size: 26rpx;
  color: #165dff;
  word-break: break-all;
}
.tag {
  flex-shrink: 0;
  padding: 4rpx 14rpx;
  border-radius: 6rpx;
  font-size: 20rpx;
}
.tag-cancel { background: #ffece8; color: #f53f3f; }
.tag-delay { background: #fff3e8; color: #d97706; }
.err-mid {
  font-size: 22rpx;
  color: #86909c;
  margin-top: 8rpx;
}
.err-bottom {
  display: flex;
  align-items: center;
  gap: 20rpx;
  font-size: 22rpx;
  color: #4e5969;
  margin-top: 12rpx;
}
.grace {
  margin-left: auto;
  padding: 4rpx 14rpx;
  border-radius: 6rpx;
  font-size: 20rpx;
}
.grace-yes { background: #e8ffea; color: #00b42a; }
.grace-no { background: #f2f3f5; color: #86909c; }

.empty-tip {
  background: #fff;
  border: 1rpx dashed #e5e6eb;
  border-radius: 16rpx;
  padding: 48rpx 32rpx;
  text-align: center;
  color: #86909c;
  font-size: 24rpx;
  margin-bottom: 20rpx;
}
.load-more {
  text-align: center;
  color: #86909c;
  font-size: 24rpx;
  padding: 24rpx;
}
</style>