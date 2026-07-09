<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import { getDashboard } from '../api/dashboard.js';
import { useToast } from '../components/useToast.js';

const { show } = useToast();

const stats = reactive({
  todayTotal: 0,
  todaySuccess: 0,
  todayFailed: 0,
  todayRate: '',
  collect: 0,
  products: 0,
  stores: 0,
  trend: [],
});

const loading = ref(false);

async function loadDashboard() {
  loading.value = true;
  try {
    const r = await getDashboard();
    const d = r && r.data ? r.data : r;
    const today = d.today || {};
    stats.todayTotal = today.total ?? 0;
    stats.todaySuccess = today.success ?? 0;
    stats.todayFailed = today.failed ?? 0;
    stats.todayRate = today.total > 0 ? `成功率 ${today.successRate}%` : '';
    stats.collect = d.collectPending ?? 0;
    stats.products = d.productCount ?? 0;
    stats.stores = d.storeCount ?? 0;
    stats.trend = Array.isArray(d.trend) ? d.trend : [];
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(loadDashboard);

// 趋势图:每天一个柱子,高度 = total/maxN*100%
const trendBars = computed(() => {
  const list = stats.trend;
  if (!list.length) return [];
  const maxN = Math.max(1, ...list.map((t) => Number(t.total) || 0));
  return list.map((t) => {
    const total = Number(t.total) || 0;
    return {
      date: t.date || '',
      label: (t.date || '').slice(5),
      total,
      height: Math.round((total / maxN) * 100),
    };
  });
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>首页统计</h2>
      <button class="btn" :disabled="loading" @click="loadDashboard">刷新</button>
    </div>

    <div class="dash-cards">
      <div class="dash-card">
        <div class="dash-card-label">今日上架</div>
        <div class="dash-card-value">{{ loading ? '加载中...' : stats.todayTotal }}</div>
        <div class="dash-card-sub">{{ stats.todayRate }}</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-label">今日成功</div>
        <div class="dash-card-value dash-ok">{{ loading ? '-' : stats.todaySuccess }}</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-label">今日失败</div>
        <div class="dash-card-value dash-err">{{ loading ? '-' : stats.todayFailed }}</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-label">采集箱待发布</div>
        <div class="dash-card-value">{{ loading ? '-' : stats.collect }}</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-label">商品缓存</div>
        <div class="dash-card-value">{{ loading ? '-' : stats.products }}</div>
      </div>
      <div class="dash-card">
        <div class="dash-card-label">店铺数</div>
        <div class="dash-card-value">{{ loading ? '-' : stats.stores }}</div>
      </div>
    </div>

    <div class="dash-trend">
      <h3>近 7 天上架趋势</h3>
      <div class="dash-chart">
        <div v-if="loading" class="muted" style="padding:24px;text-align:center">加载中...</div>
        <div v-else-if="!trendBars.length" class="muted" style="padding:24px;text-align:center">近 7 天暂无数据</div>
        <div v-else class="dash-bar-chart">
          <div v-for="b in trendBars" :key="b.date" class="dash-bar-col">
            <div class="dash-bar-wrap">
              <div class="dash-bar dash-bar-total" :style="{ height: b.height + '%' }"></div>
            </div>
            <div class="dash-bar-label">{{ b.label }}</div>
            <div class="dash-bar-num">{{ b.total }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
