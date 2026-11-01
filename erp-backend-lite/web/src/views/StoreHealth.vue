<script setup>
// 店铺健康-错误指数(2026-11-03)
// 数据源:Ozon /v1/rating/index/fbs/info + /v1/rating/index/fbs/posting/list(后端落库)
// 展示:错误指数概览 / 每日趋势 / 类型与配送方案分布 / 影响货件明细
// 设计文档: docs/店铺健康页面-功能设计.md
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { getRatingSummary, getRatingErrors, triggerRatingSync, getRatingSyncStatus } from '../api/store-health.js';

const router = useRouter();

// ── 数据加载 ─────────────────────────────────────────────────
const summary = ref(null);
const errors = ref(null);
const loading = ref(false);
const error = ref('');
const syncError = ref('');
const syncing = ref(false);

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
    errors.value = await getRatingErrors({
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
    await triggerRatingSync({});
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

/** Ozon 官方错误指数色带阈值(≤4% 绿 / ≤10% 青 / ≤20% 黄 / ≤40% 橙 / >40% 红) */
function indexColor(idx) {
  const n = Number(idx) || 0;
  if (n <= 0.04) return '#00a32e';
  if (n <= 0.10) return '#009a9a';
  if (n <= 0.20) return '#d99000';
  if (n <= 0.40) return '#ee6a00';
  return '#e53414';
}

// ── Ozon 五色指数刻度条(绿/青/黄/橙/红)──────────────────────
const INDEX_ZONES = [
  { from: 0.0, to: 0.04, tint: '#d7f9d7', solid: '#00c451' },
  { from: 0.04, to: 0.1, tint: '#d7f6f5', solid: '#00bebe' },
  { from: 0.1, to: 0.2, tint: '#fff8e0', solid: '#ffb800' },
  { from: 0.2, to: 0.4, tint: '#ffebd2', solid: '#f88f14' },
  { from: 0.4, to: 1.01, tint: '#ffe9e3', solid: '#f53c14' },
];
const INDEX_THRESHOLDS = ['0%', '4%', '10%', '20%', '40%', '100%'];

/** 计算每个区段的展示状态:当前指数所在区段实心填充,其余浅色底 */
function scaleSegments(idx) {
  const n = Math.min(Math.max(Number(idx) || 0, 0), 1);
  const activeIdx = INDEX_ZONES.findIndex((z) => n < z.to);
  return INDEX_ZONES.map((z, i) => {
    const isActive = i === activeIdx;
    const fillPct = isActive
      ? Math.max(0, Math.min(1, (n - z.from) / (z.to - z.from))) * 100
      : 0;
    return { ...z, isActive, fillPct };
  });
}
/** 刻度条区段背景:活动区段用 solid→tint 渐变表示已填充比例 */
function segStyle(z) {
  if (!z.isActive) return { background: z.tint };
  return {
    background: `linear-gradient(90deg, ${z.solid} 0%, ${z.solid} ${z.fillPct}%, ${z.tint} ${z.fillPct}%, ${z.tint} 100%)`,
  };
}
/** 刻度条数值标签:填充够宽时白色放填充右端内侧,否则实心色放区段左端 */
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
// ── 趋势图(指数折线 + 费用柱状)─────────────────────────────
const STORE_COLORS = ['#165dff', '#00b42a', '#d97706', '#722ed1', '#eb2f96', '#13c2c2', '#fa8c16'];
const chartSeries = computed(() => {
  const stores = summary.value?.stores || [];
  return stores.map((s, i) => ({
    storeId: s.storeId,
    storeName: s.storeName,
    color: STORE_COLORS[i % STORE_COLORS.length],
    points: (s.defects || [])
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
/** X 轴第 i 个日期的横坐标 */
function axisX(i) {
  return chartDates.value.length <= 1 ? 20 : 20 + (i / (chartDates.value.length - 1)) * (SVG_W - 40);
}
function pointXY(series, date, idx) {
  const x = axisX(idx);
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
function fmtMoney(n) {
  return (Number(n) || 0).toFixed(2);
}
function fmtPct(n) {
  return ((Number(n) || 0) * 100).toFixed(2);
}
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
/**
 * 归零预测:滚动窗口为 [D-14, D-1](不含今日),最后错误发生在 C 日时最多影响至 C+14,
 * 因此 C+15 起指数归零。假设未来无新取消,返回预测文案;已归零/缺数据/已过期返回空串。
 */
function zeroForecast(s) {
  const idx = Number(s.index) || 0;
  if (idx <= 0 || !s.lastErrorAt) return '';
  const c = new Date(`${String(s.lastErrorAt).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(c.getTime())) return '';
  c.setUTCDate(c.getUTCDate() + 15);
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = Math.round((c.getTime() - todayUtc) / 86400000);
  if (daysLeft <= 0) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `预测:无新取消时 ${p(c.getUTCMonth() + 1)}-${p(c.getUTCDate())} 归零(还剩 ${daysLeft} 天)`;
}
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
  loadAll();
});
</script>

<template>
  <div class="store-health">
    <!-- 顶部工具栏 -->
    <div class="top-bar">
      <div class="range-hint">
        指数统计时间段:{{ periodText }} · 错误指数为周期汇总(Ozon 官方阈值着色)
      </div>
      <button class="btn btn-primary btn-sm sync-btn" :disabled="syncing" @click="doSync">
        {{ syncing ? '同步中…' : '🔄 同步数据' }}
      </button>
    </div>

    <div v-if="syncError" class="error-bar">同步失败:{{ syncError }}</div>
    <div v-if="error" class="error-bar">加载失败:{{ error }}</div>

    <!-- 加载状态 -->
    <div v-if="loading && !summary" class="summary-skeleton">
      <div class="skeleton-card" v-for="i in 4" :key="i"></div>
    </div>

    <!-- ═══ 各店铺错误指数(Ozon 官方阈值着色) ═══ -->
    <div class="store-cards" v-if="summary && summary.stores.length > 0">
      <div class="store-card" v-for="s in sortedStores" :key="s.storeId">
        <div class="store-card-head">
          <span class="store-card-name">{{ s.storeName }}</span>
          <span class="store-card-index" :style="{ color: indexColor(s.index) }">{{ fmtPct(s.index) }}%</span>
        </div>
        <div class="index-scale">
          <div
            v-for="(z, i) in scaleSegments(s.index)"
            :key="i"
            class="scale-seg"
            :style="segStyle(z)"
          >
            <span v-if="z.isActive" class="scale-value" :style="segLabelStyle(z)">{{ fmtPct(s.index) }}%</span>
          </div>
        </div>
        <div class="scale-thresholds">
          <span v-for="t in INDEX_THRESHOLDS" :key="t" class="threshold">{{ t }}</span>
        </div>
        <div class="store-card-sub">
          <span>{{ s.periodFrom }} ~ {{ fmtPeriodEnd(s.periodTo) }}</span>
          <span>罚款 ¥{{ fmtMoney(s.processingCostsSum) }}</span>
        </div>
        <div v-if="zeroForecast(s)" class="store-card-forecast">{{ zeroForecast(s) }}</div>
      </div>
    </div>
    <div v-else-if="summary && summary.stores.length === 0" class="empty-tip">
      暂无错误指数数据,请点击「同步数据」拉取 Ozon 最新数据。
    </div>

    <!-- ═══ 每日错误指数趋势(各店铺) ═══ -->
    <div class="chart-card" v-if="summary && chartSeries.some((s) => s.points.length)">
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
        <!-- X 轴:轴线 + 日期刻度 -->
        <line :x1="20" :x2="SVG_W - 20" :y1="SVG_H - 24" :y2="SVG_H - 24" class="axis-line" />
        <template v-for="(d, i) in chartDates" :key="'x' + d">
          <line :x1="axisX(i)" :x2="axisX(i)" :y1="SVG_H - 24" :y2="SVG_H - 18" class="axis-tick" />
          <text :x="axisX(i)" :y="SVG_H - 8" text-anchor="middle" class="axis-label">{{ d.slice(5) }}</text>
        </template>
      </svg>
      <div class="legend">
        <span v-for="s in chartSeries" :key="'lg' + s.storeId" class="legend-item">
          <i :style="{ background: s.color }"></i>{{ s.storeName }}
        </span>
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

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.range-hint {
  flex: 1;
  min-width: 0;
  color: #86909c;
  font-size: 13px;
}
.sync-btn {
  flex-shrink: 0;
}

/* ── 各店铺错误指数卡片(Ozon 官方阈值着色) ── */
.index-scale {
  display: flex;
  gap: 4px;
  margin-top: 14px;
  height: 26px;
}
.scale-seg {
  position: relative;
  flex: 1;
  border-radius: 6px;
  overflow: hidden;
}
.scale-seg:first-child { border-radius: 8px 0 0 8px; }
.scale-seg:last-child { border-radius: 0 8px 8px 0; }
.scale-value {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  z-index: 1;
}
.scale-thresholds {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 11px;
  color: #86909c;
}

/* ── 各店铺错误指数卡片(每行最多3个) ── */
.store-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.store-card {
  background: #fff;
  border: 1px solid #e9edf3;
  border-radius: 16px;
  padding: 16px 18px 12px;
}
.store-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.store-card-name {
  font-size: 15px;
  font-weight: 600;
  color: #1f2329;
}
.store-card-index {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.store-card-sub {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  font-size: 11px;
  color: #86909c;
}

/* 归零预测行(滚动窗口推算,假设未来无新取消) */
.store-card-forecast {
  margin-top: 4px;
  font-size: 11px;
  color: #00a32e;
}

.red-text { color: #f53f3f; }
.orange-text { color: #d97706; }
.sep { margin: 0 4px; }

/* ── 趋势图 ── */
.chart-card {
  background: #fff;
  border-radius: 10px;
  padding: 14px;
  border: 1px solid #f2f3f5;
}
.chart-card h3 {
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
.axis-line {
  stroke: #c9cdd4;
  stroke-width: 1;
}
.axis-tick {
  stroke: #c9cdd4;
  stroke-width: 1;
}
.axis-label {
  fill: #86909c;
  font-size: 10px;
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

</style>