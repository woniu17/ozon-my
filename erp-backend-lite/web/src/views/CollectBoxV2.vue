<script setup>
import { reactive, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getCollectBoxV2FromCache, getCollectBoxV2Sellers } from '../api/collect-box-v2.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

const router = useRouter();
const { show } = useToast();

// 采集源卖家列表(供下拉框) — 从 ozon_auto_collect_log distinct sellerSlug
const sellers = ref([]);

// 记住上一次筛选条件(localStorage 持久化,跨会话保留)
const FILTERS_STORAGE_KEY = 'collect-box-v2:filters';
function loadStoredFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
const storedFilters = loadStoredFilters();

// ── 列表状态(缓存视图:以 cardCache 为基准,聚合 7 类缓存命中位图) ──
const state = reactive({
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 20,
  filters: {
    keyword: '',
    fullData: false, // 数据完整:7 类缓存命中 ≥5
    sellerSlug: '',
    unlisted: false,
    hasComments: false,
    priceMin: '', // 价格范围(闭区间,空字符串=不限)
    priceMax: '',
    // 用上次的筛选条件覆盖初值
    ...(storedFilters || {}),
  },
});

async function loadList() {
  state.loading = true;
  try {
    const params = {
      currentPage: state.page,
      pageSize: state.pageSize,
      keyword: state.filters.keyword.trim(),
    };
    if (state.filters.fullData) params.minCacheHits = '5';
    if (state.filters.sellerSlug) params.sellerSlug = state.filters.sellerSlug;
    if (state.filters.unlisted) params.unlisted = '1';
    if (state.filters.hasComments) params.hasComments = '1';
    if (state.filters.priceMin !== '') params.priceMin = state.filters.priceMin;
    if (state.filters.priceMax !== '') params.priceMax = state.filters.priceMax;
    const data = await getCollectBoxV2FromCache(params);
    state.items = data?.items || [];
    state.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    state.items = [];
    state.total = 0;
  } finally {
    state.loading = false;
  }
}

function search() {
  state.page = 1;
  loadList();
}

function onPageChange(p) {
  state.page = p;
  loadList();
}

// 持久化筛选条件:任意字段变化时写回 localStorage
watch(
  () => state.filters,
  (v) => {
    try {
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(v));
    } catch {
      /* 忽略写入失败(如 quota 超限) */
    }
  },
  { deep: true }
);

// 7 类缓存命中位图
const CACHE_HIT_KEYS = [
  { key: 'search', label: 'S', title: 'search 缓存' },
  { key: 'bundle', label: 'B', title: 'bundle 缓存' },
  { key: 'card', label: 'C', title: 'card 缓存' },
  { key: 'richMedia', label: 'R', title: 'richMedia 缓存' },
  { key: 'detail', label: 'D', title: 'detail 缓存' },
  { key: 'marketStats', label: 'M', title: 'marketStats 缓存' },
  { key: 'followSell', label: 'F', title: 'followSell 缓存' },
];

// 跳转上架预览页
function goPreview(it) {
  if (!it.sku) {
    show('SKU 缺失,无法预览', 'error');
    return;
  }
  router.push(`/preview/${encodeURIComponent(it.sku)}`);
}

function fmtTime(t) {
  if (!t) return '—';
  const ms = typeof t === 'number' ? t : /^\d{13}$/.test(String(t)) ? Number(t) : 0;
  if (ms > 0) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const s = String(t).replace('T', ' ').slice(0, 19);
  const ms2 = Date.parse(s.replace(' ', 'T') + 'Z');
  if (!Number.isNaN(ms2)) {
    const d = new Date(ms2);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return s;
}

onMounted(() => {
  // 加载采集源卖家列表(供下拉框)
  getCollectBoxV2Sellers()
    .then((list) => {
      sellers.value = Array.isArray(list) ? list : [];
    })
    .catch(() => {
      sellers.value = [];
    });
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>采集箱</h2>
      <button class="btn btn-ghost" :disabled="state.loading" @click="loadList">
        {{ state.loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <div class="filter-bar">
      <input
        class="filter-input"
        type="text"
        v-model.trim="state.filters.keyword"
        placeholder="搜索 SKU"
        @keydown.enter="search"
      />
      <select class="filter-select" v-model="state.filters.sellerSlug" title="按采集源 SKU 所属卖家筛选">
        <option value="">全部卖家</option>
        <option v-for="s in sellers" :key="s.sellerSlug" :value="s.sellerSlug">
          {{ s.sellerName || s.sellerSlug }} ({{ s.skuCount }})
        </option>
      </select>
      <label class="filter-check" title="只显示有评论数(ratingCount > 0)的 SKU">
        <input type="checkbox" v-model="state.filters.hasComments" />
        <span>有评论</span>
      </label>
      <label class="filter-check" title="只显示在任意用户店铺尚未提交跟卖任务的 SKU">
        <input type="checkbox" v-model="state.filters.unlisted" />
        <span>未跟卖</span>
      </label>
      <label class="filter-check" title="只显示 7 类缓存命中数 ≥ 5 的 SKU(数据完整)">
        <input type="checkbox" v-model="state.filters.fullData" />
        <span>数据完整</span>
      </label>
      <span class="filter-price-range" title="按 cardCache.price 过滤(闭区间)">
        <input
          class="filter-input filter-price"
          type="number"
          min="0"
          step="1"
          v-model.trim="state.filters.priceMin"
          placeholder="最低价"
          @keydown.enter="search"
        />
        <span class="filter-price-sep">~</span>
        <input
          class="filter-input filter-price"
          type="number"
          min="0"
          step="1"
          v-model.trim="state.filters.priceMax"
          placeholder="最高价"
          @keydown.enter="search"
        />
      </span>
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="cb-grid">
      <div v-if="state.loading && !state.items.length" class="empty" style="grid-column: 1/-1">加载中...</div>
      <div v-else-if="!state.items.length" class="empty" style="grid-column: 1/-1">暂无采集记录</div>
      <div v-for="it in state.items" :key="it.sku || ''" class="cb-card">
        <div class="cb-thumb">
          <img
            v-if="it.primaryImage"
            :src="it.primaryImage"
            alt=""
            loading="lazy"
            @error="$event.target.style.display = 'none'"
          />
          <div v-else class="cb-no-img">无图</div>
        </div>
        <div class="cb-body">
          <div class="cb-title" :title="it.name || it.sku">
            {{ it.name || '(未命名)' }}
          </div>
          <div class="cb-meta">
            <span>SKU: {{ it.sku || '—' }}</span>
            <span v-if="it.anchorSku && it.anchorSku !== it.sku">母体: {{ it.anchorSku }}</span>
            <span v-if="it.price">价格: {{ it.price }}</span>
            <a
              v-if="it.sku"
              :href="`https://www.ozon.ru/product/${it.sku}/`"
              target="_blank"
              rel="noopener noreferrer"
              class="cb-source-link"
              :title="`https://www.ozon.ru/product/${it.sku}/`"
              >SKU 页</a
            >
          </div>

          <div class="cb-cache-hits">
            <div class="cb-dots" :title="`命中 ${it.hitCount}/7 类缓存`">
              <span
                v-for="ck in CACHE_HIT_KEYS"
                :key="ck.key"
                class="cb-dot"
                :class="{ hit: it.cacheHits?.[ck.key] }"
                :title="ck.title + (it.cacheHits?.[ck.key] ? ' ✓' : ' ✗')"
                >{{ ck.label }}</span
              >
            </div>
            <div class="cb-cache-extra">
              <span
                v-if="it.sellerSlug"
                class="cb-extra-tag cb-tag-seller"
                :title="`采集自卖家:${it.sellerName || it.sellerSlug}`"
                >{{ it.sellerName || it.sellerSlug }}</span
              >
              <span v-if="it.marketPriceP50 != null" class="cb-extra-tag" title="市场 P50 价格">
                P50: {{ it.marketPriceP50 }}
              </span>
              <span v-if="it.competitorCount != null" class="cb-extra-tag" title="跟卖竞争度">
                竞争: {{ it.competitorCount }}
              </span>
              <span
                v-if="it.ratingCount != null"
                class="cb-extra-tag cb-tag-comments"
                title="商品评论数(采集自商品卡 DOM)"
                >评论: {{ it.ratingCount }}</span
              >
              <span v-if="it.hasVideo" class="cb-extra-tag cb-tag-video" title="richMedia 含 mp4">视频</span>
              <span
                v-if="it.listed === true"
                class="cb-extra-tag cb-tag-listed"
                title="该 SKU 已在任意店铺提交跟卖任务(不论 OPI 返回状态)"
                >已跟卖</span
              >
              <span
                v-else-if="it.listed === false"
                class="cb-extra-tag cb-tag-unlisted"
                title="该 SKU 在任意店铺尚未提交跟卖任务"
                >未跟卖</span
              >
            </div>
          </div>

          <div class="cb-foot">
            <span class="cb-time">最近缓存: {{ fmtTime(it.lastCollectedAt) }}</span>
          </div>
        </div>
        <div class="cb-actions">
          <button class="btn btn-sm btn-primary" @click="goPreview(it)" title="进入上架预览工作台">
            上架预览
          </button>
        </div>
      </div>
    </div>

    <AppPager
      :modelValue="state.page"
      :total="state.total"
      :pageSize="state.pageSize"
      @update:modelValue="onPageChange"
    />
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.toolbar h2 {
  margin: 0;
  font-size: 18px;
}
.filter-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.filter-input {
  flex: 1;
  min-width: 180px;
  padding: 6px 10px;
  border: 1px solid var(--border, #d9d9d9);
  border-radius: 4px;
}
.filter-select {
  padding: 6px 10px;
  border: 1px solid var(--border, #d9d9d9);
  border-radius: 4px;
  background: #fff;
}
.cb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.cb-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border, #eee);
  border-radius: 6px;
  padding: 10px;
  background: #fff;
}
.cb-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  background: #f5f5f5;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cb-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cb-no-img {
  color: #999;
  font-size: 12px;
}
.cb-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.cb-title {
  font-weight: 500;
  font-size: 13px;
  line-height: 1.4;
  max-height: 2.8em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.cb-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 11px;
  color: #666;
}
.cb-source-link {
  color: var(--primary, #1890ff);
  text-decoration: none;
}
.cb-source-link:hover {
  text-decoration: underline;
}
.cb-cache-hits {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}
.cb-dots {
  display: inline-flex;
  gap: 2px;
}
.cb-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 10px;
  border-radius: 50%;
  background: #eee;
  color: #999;
}
.cb-dot.hit {
  background: #52c41a;
  color: #fff;
}
.cb-cache-extra {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.cb-extra-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 2px;
  background: #f0f0f0;
  color: #666;
}
.cb-tag-video {
  background: #fff7e6;
  color: #fa8c16;
}
.cb-tag-seller {
  background: #f0f5ff;
  color: #2f54eb;
}
.cb-tag-listed {
  background: #e6fffb;
  color: #08979c;
}
.cb-tag-unlisted {
  background: #fff1f0;
  color: #cf1322;
}
.cb-tag-comments {
  background: #f9f0ff;
  color: #722ed1;
}
.filter-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #555;
  cursor: pointer;
  user-select: none;
}
.filter-check input {
  margin: 0;
}
.filter-price-range {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.filter-price {
  width: 90px;
  padding: 4px 8px;
  font-size: 13px;
}
.filter-price-sep {
  color: #999;
  font-size: 13px;
}
.cb-foot {
  margin-top: 4px;
}
.cb-time {
  font-size: 11px;
  color: #999;
}
.cb-actions {
  margin-top: 8px;
  display: flex;
  gap: 6px;
}
.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}
</style>
