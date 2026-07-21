<script setup>
import { reactive, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getCollectBoxV2FromCache, getCollectBoxV2Sellers } from '../api/collect-box-v2.js';
import {
  getFilteredCategories,
  addFilteredCategory,
  deleteFilteredCategory,
  getCategoryNamesBatch,
} from '../api/category-filter.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';
import ImageLightbox from '../components/ImageLightbox.vue';

const router = useRouter();
const { show } = useToast();

// 采集源卖家列表(供下拉框) — 从 ozon_store_sku 按 sellerId 分组
const sellers = ref([]);

// ── 中文类目名映射(2026-07 新增) ───────────────────────────
// key = descriptionCategoryId, value = categoryName(中文,来自 OPI 类目树 ZH_HANS)
// 当前数据 type_id 全部为 NULL,只能查到 description_category 这层的中文类目名,
// type_name 无法获取,前端统一显示"—"
const categoryNameMap = ref({});
const typeNameMap = ref({});

// 取商品的中文类目名(优先用 OPI 中文名,其次用商品自带 categoryName,最后回退 ID)
function displayCategoryName(it) {
  if (!it?.descriptionCategoryId) return '';
  const cn = categoryNameMap.value[it.descriptionCategoryId];
  if (cn) return cn;
  if (it.categoryName) return it.categoryName;
  return `${it.descriptionCategoryId}:${it.typeId || 0}`;
}

// 取商品的中文类型名(当前数据无 type_id,统一显示"—")
function displayTypeName(it) {
  if (!it?.typeId) return '—';
  const tn = typeNameMap.value[it.typeId];
  return tn || '—';
}

// 批量加载当前页所有商品的中文类目名 + 类型名
async function loadCategoryNamesForPage(items) {
  if (!items || items.length === 0) return;
  const descCatIds = [
    ...new Set(
      items
        .map((it) => Number(it.descriptionCategoryId))
        .filter((v) => Number.isFinite(v) && v > 0)
    ),
  ];
  const typeIds = [
    ...new Set(
      items
        .map((it) => Number(it.typeId))
        .filter((v) => Number.isFinite(v) && v > 0)
    ),
  ];
  if (descCatIds.length === 0 && typeIds.length === 0) return;
  try {
    const r = await getCategoryNamesBatch(
      descCatIds.length > 0 ? descCatIds : [],
      typeIds.length > 0 ? typeIds : []
    );
    const catList = r?.items || [];
    const typeList = r?.typeItems || [];
    const catMap = { ...categoryNameMap.value };
    for (const it of catList) {
      if (it.categoryName) catMap[it.descriptionCategoryId] = it.categoryName;
    }
    categoryNameMap.value = catMap;
    if (typeList.length > 0) {
      const tMap = { ...typeNameMap.value };
      for (const it of typeList) {
        if (it.typeName) tMap[it.typeId] = it.typeName;
      }
      typeNameMap.value = tMap;
    }
  } catch (err) {
    // 静默失败:不影响主列表渲染,类目显示回退到 ID
    console.warn('[CollectBoxV2] loadCategoryNamesForPage failed:', err);
  }
}

// ── 类目过滤黑名单(2026-07 新增) ───────────────────────────
// Vue 3 reactive(Set) 支持 add/delete/has 的响应式追踪
// key = `${descriptionCategoryId}:${typeId || 0}`
// 注:当前 bundle_data 不含 type_id,实际 type_id 全部为 NULL,前端用 0 占位
//    过滤实际按 descriptionCategoryId 单维度工作,typeId 为 0 时所有同类目商品共享同一 key
const filteredSet = reactive(new Set());

function filterKey(descCatId, typeId) {
  return `${descCatId}:${Number(typeId) || 0}`;
}

function isFiltered(it) {
  if (!it || !it.descriptionCategoryId) return false;
  return filteredSet.has(filterKey(it.descriptionCategoryId, it.typeId));
}

async function loadFilteredList() {
  try {
    const data = await getFilteredCategories();
    const list = data?.items || [];
    list.forEach((c) => {
      if (c.descriptionCategoryId) {
        filteredSet.add(filterKey(c.descriptionCategoryId, c.typeId));
      }
    });
  } catch (err) {
    // 静默失败:不影响主列表渲染
    console.warn('[CollectBoxV2] loadFilteredList failed:', err);
  }
}

async function toggleFilter(it) {
  if (!it.descriptionCategoryId) {
    show('该商品缺少类目信息,无法加入类型过滤', 'error');
    return;
  }
  const key = filterKey(it.descriptionCategoryId, it.typeId);
  const label = displayCategoryName(it) || key;
  if (filteredSet.has(key)) {
    // 取消类型过滤
    try {
      await deleteFilteredCategory(it.descriptionCategoryId, it.typeId);
      filteredSet.delete(key);
      // 当前页同类目商品的"已过滤"标签会因 filteredSet 响应式自动联动更新
      show(`已从类型过滤名单移除 ${label}`, 'success');
    } catch (err) {
      show(err.message || '取消类型过滤失败', 'error');
    }
  } else {
    // 加入类型过滤
    try {
      await addFilteredCategory({
        descriptionCategoryId: it.descriptionCategoryId,
        typeId: Number(it.typeId) || 0,
        categoryName: displayCategoryName(it) || it.categoryName || '',
      });
      filteredSet.add(key);
      // 当前页同类目商品的"已过滤"标签会因 filteredSet 响应式自动联动更新
      show(`已将 ${label} 加入类型过滤名单`, 'success');
    } catch (err) {
      show(err.message || '加入类型过滤失败', 'error');
    }
  }
}

// 记住上一次筛选条件(localStorage 持久化,跨会话保留)
const FILTERS_STORAGE_KEY = 'collect-box-v2:filters';
function loadStoredFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'sellerSlug' in parsed && !('sellerId' in parsed)) {
      // 旧版用 sellerSlug,新版改用 sellerId,旧值清空避免误用
      delete parsed.sellerSlug;
    }
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
    fullData: false, // 数据完整:dom + attribute + richMedia 三类全命中(marketStats/followSell 不算)
    sellerId: '', // 2026-07:从 sellerSlug 改用 sellerId(稳定主键)
    unlisted: false,
    hasComments: false,
    hasRichContent: false, // 只看有富内容(richMedia.richContent 非空)
    excludeFilteredCategories: false, // 排除已在类目过滤黑名单中的商品(ozon_filtered_categories 表)
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
    if (state.filters.fullData) params.minCacheHits = '3';
    if (state.filters.sellerId) params.sellerId = state.filters.sellerId;
    if (state.filters.unlisted) params.unlisted = '1';
    if (state.filters.hasComments) params.hasComments = '1';
    if (state.filters.hasRichContent) params.hasRichContent = '1';
    if (state.filters.excludeFilteredCategories) params.excludeFilteredCategories = '1';
    if (state.filters.priceMin !== '') params.priceMin = state.filters.priceMin;
    if (state.filters.priceMax !== '') params.priceMax = state.filters.priceMax;
    const data = await getCollectBoxV2FromCache(params);
    state.items = data?.items || [];
    state.total = data?.total || 0;
    // 异步加载当前页商品的中文类目名(不 await,不阻塞列表渲染)
    loadCategoryNamesForPage(state.items);
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

// 5 类合并缓存命中位图
//   dom = card OR detail(任一有采集)
//   attribute = search AND bundle(都需要)
//   richMedia / marketStats / followSell 各自独立
// 注:"数据完整"筛选只看前 3 类(dom + attribute + richMedia)
const CACHE_HIT_KEYS = [
  { key: 'dom', label: 'D', title: 'dom 缓存(card/detail 任一)' },
  { key: 'attribute', label: 'A', title: 'attribute 缓存(search+bundle)' },
  { key: 'richMedia', label: 'R', title: 'richMedia 缓存' },
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

// ── 图片放大 Lightbox ──
const lightbox = reactive({
  open: false,
  url: '',
  list: [],
  title: '',
});

function openImage(it) {
  if (!it?.primaryImage) return;
  lightbox.url = it.primaryImage;
  lightbox.list = [it.primaryImage];
  lightbox.title = it.name || it.sku || '';
  lightbox.open = true;
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
  // 加载类目过滤黑名单(与列表并行加载,不影响主列表渲染)
  loadFilteredList();
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
      <select class="filter-select" v-model="state.filters.sellerId" title="按采集源 SKU 所属卖家筛选">
        <option value="">全部卖家</option>
        <option v-for="s in sellers" :key="s.sellerId" :value="s.sellerId">
          {{ s.sellerName || s.sellerId }} ({{ s.skuCount }})
        </option>
      </select>
      <label class="filter-check" title="只显示有评论数(ratingCount > 0)的 SKU">
        <input type="checkbox" v-model="state.filters.hasComments" />
        <span>有评论</span>
      </label>
      <label class="filter-check" title="只显示 richMedia 含富内容(richContent 非空)的 SKU">
        <input type="checkbox" v-model="state.filters.hasRichContent" />
        <span>有富内容</span>
      </label>
      <label class="filter-check" title="只显示在任意用户店铺尚未提交跟卖任务的 SKU">
        <input type="checkbox" v-model="state.filters.unlisted" />
        <span>未跟卖</span>
      </label>
      <label class="filter-check" title="只显示 dom + attribute + richMedia 三类缓存全命中的 SKU(数据完整)">
        <input type="checkbox" v-model="state.filters.fullData" />
        <span>数据完整</span>
      </label>
      <label class="filter-check" title="排除已在类目过滤黑名单中的 SKU(ozon_filtered_categories 表)">
        <input type="checkbox" v-model="state.filters.excludeFilteredCategories" />
        <span>排除类型过滤</span>
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
        <div
          class="cb-thumb"
          :class="{ 'cb-thumb-clickable': it.primaryImage }"
          @click="openImage(it)"
        >
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
            <div class="cb-dots" :title="`命中 ${it.hitCount}/5 类缓存(dom + attribute + richMedia + marketStats + followSell)`">
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
                v-if="it.sellerId || it.sellerSlug"
                class="cb-extra-tag cb-tag-seller"
                :title="`采集自卖家:${it.sellerName || it.sellerId || it.sellerSlug}`"
                >{{ it.sellerName || it.sellerId || it.sellerSlug }}</span
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
              <span v-if="it.hasRichContent" class="cb-extra-tag cb-tag-rich" title="richMedia 含富内容(richContent 非空)">富内容</span>
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
              <span
                v-if="it.descriptionCategoryId"
                class="cb-extra-tag cb-tag-category"
                :title="`类目 ID:${it.descriptionCategoryId}:${it.typeId || 0}`"
                >类目:{{ displayCategoryName(it) }}</span
              >
              <span
                v-if="it.descriptionCategoryId"
                class="cb-extra-tag cb-tag-category-type"
                :title="`类型 ID:${it.typeId || 0}`"
                >类型:{{ displayTypeName(it) }}</span
              >
              <span
                v-if="isFiltered(it)"
                class="cb-extra-tag cb-tag-filtered"
                title="该商品类目在过滤名单中,上架预览一键提交将被禁用"
                >类型过滤</span
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
          <button
            v-if="it.descriptionCategoryId"
            class="btn btn-sm"
            :class="isFiltered(it) ? 'btn-ghost' : 'btn-warn'"
            @click="toggleFilter(it)"
            :title="isFiltered(it) ? '从类型过滤名单移除该类目' : '将该类目加入类型过滤名单'"
          >
            {{ isFiltered(it) ? '取消类型过滤' : '类型过滤' }}
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

    <!-- 图片放大 Lightbox -->
    <ImageLightbox
      v-model:open="lightbox.open"
      :url="lightbox.url"
      :list="lightbox.list"
      :title="lightbox.title"
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
.cb-thumb.cb-thumb-clickable {
  cursor: zoom-in;
}
.cb-thumb.cb-thumb-clickable:hover img {
  opacity: 0.85;
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
.cb-tag-rich {
  background: #f6ffed;
  color: #389e0d;
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
.cb-tag-category {
  background: #f5f5f5;
  color: #333;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cb-tag-category-type {
  background: #e6f7ff;
  color: #1890ff;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cb-tag-filtered {
  background: #fff1f0;
  color: #cf1322;
  font-weight: 500;
  border: 1px solid #ffa39e;
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
.btn-warn {
  background: #fa8c16;
  color: #fff;
  border: 1px solid #fa8c16;
  cursor: pointer;
}
.btn-warn:hover {
  background: #d46b08;
  border-color: #d46b08;
}
.btn-warn:disabled {
  background: #ffd591;
  border-color: #ffd591;
  cursor: not-allowed;
}
</style>
