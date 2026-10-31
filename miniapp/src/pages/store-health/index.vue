<template>
  <view class="page">
    <!-- 指数统计时间段 + 同步 -->
    <view class="top-bar">
      <view class="range-hint">{{ periodText }} · 错误指数为周期汇总</view>
      <view class="sync-btn" :class="{ loading: syncing }" @click="doSync">{{ syncing ? '同步中…' : '🔄 同步' }}</view>
    </view>
    <view v-if="error" class="error-bar">{{ error }}</view>
    <view v-if="syncError" class="error-bar">同步失败:{{ syncError }}</view>

    <!-- ═══ 各店铺错误指数(Ozon 官方阈值着色) ═══ -->
    <view v-if="summary && summary.stores.length" class="store-cards">
      <view v-for="s in sortedStores" :key="s.storeId" class="store-card">
        <view class="store-card-head">
          <text class="store-card-name">{{ s.storeName }}</text>
          <text class="store-card-index" :style="{ color: indexColor(s.index) }">{{ fmtIndex(s.index) }}</text>
        </view>
        <view class="index-scale">
          <view
            v-for="(z, i) in scaleSegments(s.index)"
            :key="i"
            class="scale-seg"
            :style="segStyle(z)"
          >
            <text v-if="z.isActive" class="scale-value" :style="segLabelStyle(z)">{{ fmtIndex(s.index) }}</text>
          </view>
        </view>
        <view class="scale-thresholds">
          <text v-for="t in INDEX_THRESHOLDS" :key="t" class="threshold">{{ t }}</text>
        </view>
        <view class="store-card-sub">
          <text>{{ s.periodFrom }} ~ {{ fmtPeriodEnd(s.periodTo) }}</text>
          <text>罚款 ¥{{ fmtMoney(s.processingCostsSum) }}</text>
        </view>
      </view>
    </view>
    <view v-else-if="summary" class="empty-tip">暂无错误指数数据,点击「同步」拉取 Ozon 最新数据</view>

    <!-- ═══ 每日错误指数趋势(分组柱状) ═══ -->
    <view v-if="hasChart" class="chart-card">
      <view class="chart-title">每日错误指数趋势</view>
      <scroll-view scroll-x :show-scrollbar="false">
        <view class="chart-body">
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
            </view>
          </view>
          <!-- X 轴:轴线 + 日期刻度 -->
          <view class="x-axis">
            <view v-for="d in chartDates" :key="d" class="x-axis-item">
              <view class="x-tick"></view>
              <text class="x-label">{{ d.slice(5) }}</text>
            </view>
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
      <view class="err-mid">{{ it.storeName }} · {{ fmtTime(it.errorAt) }} · {{ it.deliverySchema || '未知方案' }}</view>
      <view class="err-bottom">
        <text>货值 ¥{{ fmtMoney(it.productPrice) }}</text>
        <text class="red-t">费用 ¥{{ fmtMoney(it.chargePrice) }}</text>
        <text class="grace" :class="it.hasGraceStatus ? 'grace-yes' : 'grace-no'">{{ it.hasGraceStatus ? '宽限' : '计费' }}</text>
      </view>
    </view>
    <view v-if="items.length === 0 && !loading" class="empty-tip">该指数统计周期内没有影响错误指数的货件</view>

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
} from '../../api/store-health.js';
import { fmtTime } from '../../utils/fmt.js';

// ── 数据 ──

// ── 数据 ──
const summary = ref(null);
const items = ref([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const syncError = ref('');
const syncing = ref(false);
const pager = ref({ offset: 0, limit: 20 });

// 指数统计时间段(来自后端快照;periodTo 为排他上界,展示减一天)
const periodText = computed(() => {
  const s = summary.value?.stores?.[0];
  if (!s || !s.periodFrom || !s.periodTo) return '';
  return `${s.periodFrom} ~ ${fmtPeriodEnd(s.periodTo)}`;
});

async function loadSummary() {
  try {
    summary.value = await getRatingSummary({});
  } catch (e) {
    error.value = e.message;
  }
}

async function loadErrors() {
  try {
    const res = await getRatingErrors({
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
    await triggerRatingSync({});
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

/** Ozon 官方错误指数色带阈值(≤4% 绿 / ≤10% 青 / ≤20% 黄 / ≤40% 橙 / >40% 红) */
function indexColor(idx) {
  const n = Number(idx) || 0;
  if (n <= 0.04) return '#00a32e';
  if (n <= 0.10) return '#009a9a';
  if (n <= 0.20) return '#d99000';
  if (n <= 0.40) return '#ee6a00';
  return '#e53414';
}

// ── Ozon 五色指数刻度条(绿/青/黄/橙/红)──
const INDEX_ZONES = [
  { from: 0.0, to: 0.04, tint: '#d7f9d7', solid: '#00c451' },
  { from: 0.04, to: 0.1, tint: '#d7f6f5', solid: '#00bebe' },
  { from: 0.1, to: 0.2, tint: '#fff8e0', solid: '#ffb800' },
  { from: 0.2, to: 0.4, tint: '#ffebd2', solid: '#f88f14' },
  { from: 0.4, to: 1.01, tint: '#ffe9e3', solid: '#f53c14' },
];
const INDEX_THRESHOLDS = ['0%', '4%', '10%', '20%', '40%', '100%'];
function scaleSegments(idx) {
  const n = Math.min(Math.max(Number(idx) || 0, 0), 1);
  const activeIdx = INDEX_ZONES.findIndex((z) => n < z.to);
  return INDEX_ZONES.map((z, i) => {
    const isActive = i === activeIdx;
    const fillPct = isActive ? Math.max(0, Math.min(1, (n - z.from) / (z.to - z.from))) * 100 : 0;
    return { ...z, isActive, fillPct };
  });
}
function segStyle(z) {
  if (!z.isActive) return { background: z.tint };
  return { background: `linear-gradient(90deg, ${z.solid} 0%, ${z.solid} ${z.fillPct}%, ${z.tint} ${z.fillPct}%, ${z.tint} 100%)` };
}
function segLabelStyle(z) {
  if (!z.isActive) return {};
  const onFill = z.fillPct > 30;
  const style = { color: onFill ? '#fff' : z.solid };
  if (onFill) {
    style.right = `calc(${100 - z.fillPct}% + 4px)`;
    style.left = 'auto';
  } else {
    style.left = '6px';
    style.right = 'auto';
  }
  return style;
}

// ── 趋势图 ──
const STORE_COLORS = ['#165dff', '#00b42a', '#d97706', '#722ed1', '#eb2f96', '#13c2c2', '#fa8c16'];
const chartSeries = computed(() => {
  const stores = summary.value?.stores || [];
  return stores.map((s, i) => ({
    storeId: s.storeId,
    storeName: s.storeName,
    color: STORE_COLORS[i % STORE_COLORS.length],
    defects: s.defects || [],
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
function fmtMoney(n) { return (Number(n) || 0).toFixed(2); }
function fmtIndex(n) { return ((Number(n) || 0) * 100).toFixed(2) + '%'; }
/** 指数周期结束日减一天展示(与 Ozon 后台一致:接口 periodTo 为排他上界) */
function fmtPeriodEnd(dateStr) {
  const d = new Date(`${String(dateStr)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr || '';
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
/** 全部店铺按店铺编号顺序(YQL01~YQL06) */
const sortedStores = computed(() => {
  const stores = summary.value?.stores || [];
  return [...stores].sort((a, b) => String(a.storeId).localeCompare(String(b.storeId)));
});
function typeLabel(t) {
  return t === 'SELLER_CANCELLATION' ? '卖家取消' : t === 'SELLER_DELAY' ? '卖家逾期' : t || '未知';
}

// ── 生命周期 ──
onShow(() => {
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

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
  margin-bottom: 16rpx;
}
.range-hint {
  flex: 1;
  min-width: 0;
  font-size: 22rpx;
  color: #86909c;
}
.sync-btn {
  flex-shrink: 0;
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
.error-bar {
  background: #ffece8;
  color: #f53f3f;
  border-radius: 12rpx;
  padding: 16rpx 20rpx;
  font-size: 24rpx;
  margin-bottom: 16rpx;
}

/* 各店铺错误指数卡片(Ozon 官方阈值着色,每行最多3个) */
.store-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20rpx;
  margin-bottom: 20rpx;
}
.store-card {
  background: #fff;
  border: 1rpx solid #e9edf3;
  border-radius: 24rpx;
  padding: 24rpx;
  box-sizing: border-box;
}
.store-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
  margin-bottom: 4rpx;
}
.store-card-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.store-card-index {
  font-size: 44rpx;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.index-scale {
  display: flex;
  gap: 6rpx;
  margin-top: 16rpx;
  height: 40rpx;
}
.scale-seg {
  position: relative;
  flex: 1;
  border-radius: 8rpx;
  overflow: hidden;
}
.scale-seg:first-child { border-radius: 12rpx 0 0 12rpx; }
.scale-seg:last-child { border-radius: 0 12rpx 12rpx 0; }
.scale-value {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  font-size: 22rpx;
  font-weight: 700;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  z-index: 1;
}
.scale-thresholds {
  display: flex;
  justify-content: space-between;
  margin-top: 8rpx;
  font-size: 18rpx;
  color: #86909c;
}
.store-card-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
  margin-top: 16rpx;
  font-size: 22rpx;
  color: #86909c;
}
.red-t { color: #f53f3f; }

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
.chart-body {
  min-width: 100%;
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
/* X 轴:轴线 + 日期刻度 */
.x-axis {
  display: flex;
  gap: 8rpx;
  min-width: 100%;
  border-top: 2rpx solid #c9cdd4;
  margin-top: 12rpx;
  padding-top: 0;
}
.x-axis-item {
  flex: 1;
  min-width: 48rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.x-tick {
  width: 1rpx;
  height: 8rpx;
  background: #c9cdd4;
}
.x-label {
  font-size: 18rpx;
  color: #86909c;
  margin-top: 4rpx;
  white-space: nowrap;
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