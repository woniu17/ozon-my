<script setup>
// 端点耗时监控(2026-08):Ozon 8 端点访问耗时时间轴 + 分端点统计
// 图表:纯 SVG 自绘(设计决策 D1;换库触发条件见 docs/ozon端点耗时监控-概要设计.md §9)
import { ref, reactive, computed, onMounted } from 'vue';
import { queryEndpointMetrics, getEndpointMetricsDims } from '../api/endpoint-metrics.js';

const RANGES = [
  { label: '1小时', hours: 1, bucket: '1m' },
  { label: '6小时', hours: 6, bucket: '5m' },
  { label: '24小时', hours: 24, bucket: '5m' },
  { label: '7天', hours: 24 * 7, bucket: '1h' },
];

const loading = ref(false);
const error = ref('');
const rangeIdx = ref(1); // 默认 6h
const bucket = ref('5m');
const series = ref([]);
const stats = ref([]);
const total = ref(0);
const dims = reactive({ endpoints: [], machines: [], profiles: [], ips: [], scripts: [] });
const filters = reactive({
  endpoints: [], // 空数组 = 全部
  machines: [],
  profiles: [],
  ips: [],
  scripts: [],
});
const hidden = ref(new Set()); // 图上隐藏的端点(legend 勾选)

const ENDPOINT_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706',
  '#7c3aed', '#0891b2', '#db2777', '#65a30d',
];
const colorOf = (ep) => {
  const all = dims.endpoints.length ? dims.endpoints : [...new Set(series.value.map((s) => s.endpoint))].sort();
  const i = all.indexOf(ep);
  return ENDPOINT_COLORS[i % ENDPOINT_COLORS.length];
};

const fromIso = computed(() => new Date(Date.now() - RANGES[rangeIdx.value].hours * 3600_000).toISOString());
const toIso = computed(() => new Date().toISOString());

// ── SVG 布局 ────────────────────────────────────────────────
const W = 960;
const H = 340;
const M = { top: 16, right: 16, bottom: 36, left: 64 };
const plotW = W - M.left - M.right;
const plotH = H - M.top - M.bottom;

const visibleSeries = computed(() => series.value.filter((s) => !hidden.value.has(s.endpoint)));
const bucketsAll = computed(() => [...new Set(series.value.map((s) => s.bucketTs))].sort());
const endpointsAll = computed(() => [...new Set(visibleSeries.value.map((s) => s.endpoint))].sort());
const maxDur = computed(() => Math.max(100, ...visibleSeries.value.map((s) => s.p95)) * 1.1);

const xScale = computed(() => {
  const n = bucketsAll.value.length;
  return (ts) => {
    const i = bucketsAll.value.indexOf(ts);
    return n <= 1 ? M.left + plotW / 2 : M.left + (i / (n - 1)) * plotW;
  };
});
const yScale = (v) => M.top + plotH - (v / maxDur.value) * plotH;

const pathOf = (endpoint, field) => {
  const pts = visibleSeries.value
    .filter((s) => s.endpoint === endpoint)
    .sort((a, b) => (a.bucketTs < b.bucketTs ? -1 : 1))
    .map((s) => `${xScale.value(s.bucketTs).toFixed(1)},${yScale(s[field]).toFixed(1)}`);
  return pts.length ? 'M' + pts.join(' L') : '';
};

const yTicks = computed(() => {
  const max = maxDur.value;
  return [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(max * r));
});

const xTicks = computed(() => {
  const n = bucketsAll.value.length;
  if (n === 0) return [];
  const step = Math.max(1, Math.floor(n / 8));
  const out = [];
  for (let i = 0; i < n; i += step) out.push(bucketsAll.value[i]);
  if (out[out.length - 1] !== bucketsAll.value[n - 1]) out.push(bucketsAll.value[n - 1]);
  return out;
});

const fmtTime = (iso) => {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const dd = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${dd}-${day} ${hh}:${mm}`;
};
const fmtMs = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms');
const fmtPct = (v) => (v * 100).toFixed(1) + '%';

const toggleHidden = (ep) => {
  const s = new Set(hidden.value);
  s.has(ep) ? s.delete(ep) : s.add(ep);
  hidden.value = s;
};

// ── 数据加载 ────────────────────────────────────────────────
async function loadDims() {
  try {
    const d = await getEndpointMetricsDims(7);
    dims.endpoints = d.endpoints || [];
    dims.machines = d.machines || [];
    dims.profiles = d.profiles || [];
    dims.ips = d.ips || [];
    dims.scripts = d.scripts || [];
  } catch { /* 静默 */ }
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await queryEndpointMetrics({
      from: fromIso.value,
      to: toIso.value,
      bucket: bucket.value,
      ...(filters.endpoints.length ? { endpoints: filters.endpoints.join(',') } : {}),
      ...(filters.machines.length ? { machines: filters.machines.join(',') } : {}),
      ...(filters.profiles.length ? { profiles: filters.profiles.join(',') } : {}),
      ...(filters.ips.length ? { ips: filters.ips.join(',') } : {}),
      ...(filters.scripts.length ? { scripts: filters.scripts.join(',') } : {}),
    });
    series.value = r.series || [];
    stats.value = r.stats || [];
    total.value = r.count || 0;
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

function setRange(i) {
  rangeIdx.value = i;
  bucket.value = RANGES[i].bucket;
  load();
}

onMounted(() => {
  loadDims();
  load();
});
</script>

<template>
  <div class="page">
    <h2>端点耗时监控</h2>
    <p v-if="!dims.endpoints.length && !loading" class="empty-hint">
      暂无监控数据(采集脚本上报后此处展示;qxqx 三脚本已埋点)
    </p>

    <!-- 筛选栏 -->
    <div class="filters">
      <div class="range-group">
        <button
          v-for="(r, i) in RANGES"
          :key="r.label"
          class="range-btn"
          :class="{ active: rangeIdx === i }"
          @click="setRange(i)"
        >
          {{ r.label }}
        </button>
      </div>
      <select v-model="bucket" class="sel" @change="load">
        <option value="1m">粒度 1分钟</option>
        <option value="5m">粒度 5分钟</option>
        <option value="1h">粒度 1小时</option>
      </select>
      <select v-model="filters.scripts" multiple class="sel multi" title="脚本(空=全部)">
        <option v-for="s in dims.scripts" :key="s" :value="s">{{ s }}</option>
      </select>
      <select v-model="filters.machines" multiple class="sel multi" title="机器(空=全部)">
        <option v-for="m in dims.machines" :key="m" :value="m">{{ m }}</option>
      </select>
      <select v-model="filters.profiles" multiple class="sel multi" title="Profile(空=全部)">
        <option v-for="p in dims.profiles" :key="p" :value="p">{{ p }}</option>
      </select>
      <select v-model="filters.ips" multiple class="sel multi" title="出口 IP(空=全部)">
        <option v-for="ip in dims.ips" :key="ip" :value="ip">{{ ip }}</option>
      </select>
      <button class="apply-btn" @click="load">应用筛选</button>
      <span class="total">共 {{ total }} 条请求</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="loading" class="loading">加载中...</p>

    <!-- SVG 时间轴 -->
    <div v-if="endpointsAll.length" class="chart-wrap">
      <div class="legend">
        <button
          v-for="ep in [...new Set(series.map((s) => s.endpoint))].sort()"
          :key="ep"
          class="legend-item"
          :class="{ off: hidden.has(ep) }"
          @click="toggleHidden(ep)"
        >
          <span class="dot" :style="{ background: colorOf(ep) }"></span>{{ ep }}
        </button>
      </div>
      <svg :viewBox="`0 0 ${W} ${H}`" class="chart" role="img" aria-label="端点耗时时间轴(p95 实线 / p50 虚线)">
        <!-- Y 网格 + 刻度 -->
        <g v-for="t in yTicks" :key="'y' + t">
          <line :x1="M.left" :x2="W - M.right" :y1="yScale(t)" :y2="yScale(t)" class="grid" />
          <text :x="M.left - 8" :y="yScale(t) + 4" class="tick" text-anchor="end">{{ fmtMs(t) }}</text>
        </g>
        <!-- X 刻度 -->
        <g v-for="t in xTicks" :key="'x' + t">
          <text :x="xScale(t)" :y="H - 12" class="tick" text-anchor="middle">{{ fmtTime(t) }}</text>
        </g>
        <!-- 每端点:p95 实线 + p50 虚线 -->
        <g v-for="ep in endpointsAll" :key="ep">
          <path :d="pathOf(ep, 'p95')" fill="none" :stroke="colorOf(ep)" stroke-width="2" />
          <path :d="pathOf(ep, 'p50')" fill="none" :stroke="colorOf(ep)" stroke-width="1" stroke-dasharray="4 3" opacity="0.5" />
        </g>
        <line :x1="M.left" :x2="W - M.right" :y1="M.top + plotH" :y2="M.top + plotH" class="axis" />
      </svg>
      <p class="chart-hint">实线 = p95,虚线 = p50;点按粒度聚合(悬浮图例切换端点显隐)</p>
    </div>

    <!-- 分端点统计表 -->
    <table v-if="stats.length" class="stats-table">
      <thead>
        <tr>
          <th>端点</th>
          <th>请求数</th>
          <th>p50</th>
          <th>p95</th>
          <th>平均</th>
          <th>错误率</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in stats" :key="s.endpoint">
          <td><span class="dot" :style="{ background: colorOf(s.endpoint) }"></span>{{ s.endpoint }}</td>
          <td>{{ s.total }}</td>
          <td>{{ fmtMs(s.p50) }}</td>
          <td>{{ fmtMs(s.p95) }}</td>
          <td>{{ fmtMs(s.avg) }}</td>
          <td :class="{ 'err-high': s.errRate > 0.05 }">{{ fmtPct(s.errRate) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.page { padding: 16px; max-width: 1080px; margin: 0 auto; }
h2 { margin: 0 0 12px; font-size: 18px; }
.empty-hint { color: #888; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.range-group { display: flex; gap: 4px; }
.range-btn, .apply-btn {
  padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 4px;
  background: #fff; cursor: pointer; font-size: 12px;
}
.range-btn.active { background: #2563eb; color: #fff; border-color: #2563eb; }
.sel { padding: 4px 6px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px; max-width: 160px; }
.sel.multi { height: 60px; }
.total { color: #666; font-size: 12px; }
.error { color: #dc2626; }
.loading { color: #888; }
.chart-wrap { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #fff; }
.legend { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.legend-item {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
  border: 1px solid #e5e7eb; border-radius: 12px; background: #fff;
  cursor: pointer; font-size: 11px; color: #374151;
}
.legend-item.off { opacity: 0.35; text-decoration: line-through; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
.chart { width: 100%; height: auto; display: block; }
.grid { stroke: #f3f4f6; stroke-width: 1; }
.axis { stroke: #d1d5db; }
.tick { font-size: 10px; fill: #9ca3af; }
.chart-hint { color: #9ca3af; font-size: 11px; margin: 4px 0 0; }
.stats-table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
.stats-table th, .stats-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #f3f4f6; }
.stats-table th { color: #6b7280; font-weight: 500; }
.err-high { color: #dc2626; font-weight: 600; }
</style>
