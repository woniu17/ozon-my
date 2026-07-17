<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import {
  getCacheStats,
  getCacheList,
  getCacheDetail,
  deleteCache,
  clearCache,
  getCacheOverview,
  getOpiPreview,
  getStoreClassificationList,
  updateStoreClassification,
  deleteStoreClassification,
  getStoreSkuList,
  deleteStoreSku,
} from '../api/cache.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import JsonTree from '../components/JsonTree.vue';

const { show } = useToast();

// ── 统计 ───────────────────────────────────────────────────
const stats = ref({
  search: { count: 0 },
  bundle: { count: 0, emptyAttrs: 0, stale: 0 },
  card: { count: 0 },
  richMedia: { count: 0 },
  detail: { count: 0 },
  marketStats: { count: 0 },
  followSell: { count: 0 },
});

async function loadStats() {
  try {
    stats.value = await getCacheStats();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 列表 ───────────────────────────────────────────────────
const state = reactive({
  type: 'overview', // overview | search | bundle | card | richMedia | detail
  keyword: '',
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 50,
});

async function loadList() {
  state.loading = true;
  try {
    if (state.type === 'overview') {
      const data = await getCacheOverview({
        keyword: state.keyword.trim(),
        page: state.page,
        pageSize: state.pageSize,
      });
      state.items = data?.items || [];
      state.total = data?.total || 0;
    } else {
      const data = await getCacheList({
        type: state.type,
        keyword: state.keyword.trim(),
        page: state.page,
        pageSize: state.pageSize,
      });
      state.items = data?.items || [];
      state.total = data?.total || 0;
    }
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

function switchType(t) {
  state.type = t;
  state.page = 1;
  state.keyword = '';
  if (t === 'store-classification') {
    loadStoreClassifications();
  } else if (t === 'store-sku') {
    loadStoreSkus();
  } else {
    loadList();
  }
}

// ── 详情弹窗 ───────────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailData = ref(null);
const detailTitle = computed(() => {
  if (!detailData.value) return '缓存详情';
  return `缓存详情 · ${state.type} · ${detailData.value.sku}`;
});

async function openDetail(it) {
  detailOpen.value = true;
  detailLoading.value = true;
  detailData.value = null;
  try {
    detailData.value = await getCacheDetail(state.type, it.sku);
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detailLoading.value = false;
  }
}

// ── 删除 ───────────────────────────────────────────────────
async function onRemove(it) {
  if (!confirm(`确认删除缓存 ${state.type}/${it.sku}?`)) return;
  try {
    await deleteCache(state.type, it.sku);
    show('已删除', 'success');
    await Promise.all([loadList(), loadStats()]);
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function onClearAll() {
  const label = state.type;
  const count = stats.value[state.type]?.count || 0;
  if (!confirm(`确认清空所有 ${label} 缓存?共 ${count} 条,此操作不可恢复!`)) return;
  try {
    const r = await clearCache(state.type);
    show(`已清空 ${r.deletedCount} 条`, 'success');
    state.page = 1;
    await Promise.all([loadList(), loadStats()]);
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 渲染辅助 ───────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isStale(it, type) {
  // overview 矩阵:marketStats/followSell 基于 fetchedAt 超过 24h 判定 stale
  if (type === 'marketStats' || type === 'followSell') {
    const entry = it[type];
    if (!entry || !entry.fetchedAt) return false;
    const age = Date.now() - new Date(entry.fetchedAt).getTime();
    return age > 24 * 60 * 60 * 1000;
  }
  // 后端 list 接口预计算 attrsStale,前端直接使用
  return state.type === 'bundle' && !!it.attrsStale;
}

// ── 缓存类型中文名 ────────────────────────────────────────
const TYPE_LABELS = {
  search: 'search',
  bundle: 'bundle',
  card: 'card(商品卡)',
  richMedia: 'richMedia(富媒体)',
  detail: 'detail(详情页)',
  marketStats: 'marketStats(市场统计)',
  followSell: 'followSell(跟卖)',
};

// 单类型列表 colspan:SKU + 抓取时间 + 操作(基础3)+ bundle 专属2 / marketStats/followSell 专属2
const singleTypeColspan = computed(() => {
  if (state.type === 'bundle' || state.type === 'marketStats' || state.type === 'followSell') return 5;
  return 3;
});

// ── OPI 预览 ───────────────────────────────────────────────
const opiOpen = ref(false);
const opiLoading = ref(false);
const opiSku = ref('');
const opiData = ref(null);
const opiSources = ref(null);
const opiError = ref('');
const opiTitle = computed(() => `OPI 预览 · ${opiSku.value}`);

async function openOpiPreview(sku) {
  opiOpen.value = true;
  opiLoading.value = true;
  opiSku.value = sku;
  opiData.value = null;
  opiSources.value = null;
  opiError.value = '';
  try {
    const r = await getOpiPreview(sku);
    opiData.value = r?.item || null;
    opiSources.value = r?.sources || null;
    opiError.value = r?.error || '';
  } catch (err) {
    opiError.value = err.message || String(err);
  } finally {
    opiLoading.value = false;
  }
}

function opiSourceTag(hit) {
  return hit ? 'tag-ok' : 'tag-mute';
}

function opiSourceLabel(hit, type) {
  return hit ? type : '—';
}

// ── 店铺分类徽章 ──────────────────────────────────────────
function storeClassBadge(isChinese) {
  if (isChinese === true) return 'badge-chinese';
  if (isChinese === false) return 'badge-non-chinese';
  return 'badge-pending';
}

// ── 店铺分类 ───────────────────────────────────────────────
const storeClassifications = ref([]);
const storeClassFilters = reactive({
  isChinese: null,
  keyword: '',
});
const storeClassPager = reactive({
  current: 1,
  total: 0,
  pageSize: 50,
});

async function loadStoreClassifications() {
  try {
    const data = await getStoreClassificationList({
      isChinese: storeClassFilters.isChinese,
      keyword: storeClassFilters.keyword.trim(),
      page: storeClassPager.current,
      pageSize: storeClassPager.pageSize,
    });
    storeClassifications.value = data?.items || [];
    storeClassPager.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    storeClassifications.value = [];
    storeClassPager.total = 0;
  }
}

function searchStoreClassifications() {
  storeClassPager.current = 1;
  loadStoreClassifications();
}

function onStoreClassPageChange(p) {
  storeClassPager.current = p;
  loadStoreClassifications();
}

async function updateStoreClass(slug, data) {
  try {
    // ERP 后台手动标记视为 manual 分类,与 SW 的 manualClassifyStore 保持一致
    // (不补 classifiedBy 时后端默认写空字符串,导致 SW L2 命中后无法识别分类来源)
    await updateStoreClassification(slug, { ...data, classifiedBy: 'manual' });
    show('已更新', 'success');
    await loadStoreClassifications();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function deleteStoreClass(slug) {
  if (!confirm(`确认删除店铺分类 ${slug}?`)) return;
  try {
    await deleteStoreClassification(slug);
    show('已删除', 'success');
    await loadStoreClassifications();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 店铺 SKU 关联 ─────────────────────────────────────────
const storeSkus = ref([]);
const storeSkuFilters = reactive({
  keyword: '',
});
const storeSkuPager = reactive({
  current: 1,
  total: 0,
  pageSize: 50,
});

async function loadStoreSkus() {
  try {
    const data = await getStoreSkuList({
      keyword: storeSkuFilters.keyword.trim(),
      currentPage: storeSkuPager.current,
      pageSize: storeSkuPager.pageSize,
    });
    storeSkus.value = data?.items || [];
    storeSkuPager.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    storeSkus.value = [];
    storeSkuPager.total = 0;
  }
}

function searchStoreSkus() {
  storeSkuPager.current = 1;
  loadStoreSkus();
}

function onStoreSkuPageChange(p) {
  storeSkuPager.current = p;
  loadStoreSkus();
}

async function deleteStoreSkuRecord(sku) {
  if (!confirm(`确认删除店铺 SKU 关联 ${sku}?`)) return;
  try {
    await deleteStoreSku(sku);
    show('已删除', 'success');
    await loadStoreSkus();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// 采集状态标签 class
function collectStatusTag(status) {
  if (status === 'success') return 'tag tag-ok';
  if (status === 'failed' || status === 'antibot') return 'tag tag-err';
  if (status === 'partial') return 'tag tag-warn';
  if (status === 'skipped') return 'tag tag-mute';
  return 'tag tag-mute';
}

onMounted(() => {
  loadStats();
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>缓存管理</h2>
      <div style="display: flex; gap: 8px">
        <button class="btn btn-ghost" :disabled="state.loading" @click="loadList">
          {{ state.loading ? '刷新中...' : '刷新列表' }}
        </button>
        <button class="btn btn-ghost" @click="loadStats">刷新统计</button>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="cache-stats">
      <div class="cache-stat-card">
        <div class="cache-stat-label">search 缓存</div>
        <div class="cache-stat-value">{{ stats.search.count }}</div>
        <div class="cache-stat-sub">条记录</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">bundle 缓存</div>
        <div class="cache-stat-value">{{ stats.bundle.count }}</div>
        <div class="cache-stat-sub">条记录</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">bundle 空属性</div>
        <div class="cache-stat-value" :class="{ 'stat-warn': stats.bundle.emptyAttrs > 0 }">
          {{ stats.bundle.emptyAttrs }}
        </div>
        <div class="cache-stat-sub">条(attributes=[])</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">bundle 待重验</div>
        <div class="cache-stat-value" :class="{ 'stat-err': stats.bundle.stale > 0 }">
          {{ stats.bundle.stale }}
        </div>
        <div class="cache-stat-sub">条(空属性超 6h)</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">card 缓存</div>
        <div class="cache-stat-value">{{ stats.card?.count || 0 }}</div>
        <div class="cache-stat-sub">条(商品卡 sku/url/name/price/image)</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">richMedia 缓存</div>
        <div class="cache-stat-value">{{ stats.richMedia?.count || 0 }}</div>
        <div class="cache-stat-sub">条(图册/视频/富内容/fields)</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">detail 缓存</div>
        <div class="cache-stat-value">{{ stats.detail?.count || 0 }}</div>
        <div class="cache-stat-sub">条(详情页 DOM 全字段)</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">marketStats 缓存</div>
        <div class="cache-stat-value">{{ stats.marketStats?.count || 0 }}</div>
        <div class="cache-stat-sub">条(市场统计,stale 24h)</div>
      </div>
      <div class="cache-stat-card">
        <div class="cache-stat-label">followSell 缓存</div>
        <div class="cache-stat-value">{{ stats.followSell?.count || 0 }}</div>
        <div class="cache-stat-sub">条(跟卖信息,stale 4h)</div>
      </div>
    </div>

    <!-- 类型切换 -->
    <div class="cache-type-tabs">
      <button class="cache-type-tab" :class="{ active: state.type === 'overview' }" @click="switchType('overview')">
        全览
      </button>
      <button class="cache-type-tab" :class="{ active: state.type === 'bundle' }" @click="switchType('bundle')">
        bundle 缓存
      </button>
      <button class="cache-type-tab" :class="{ active: state.type === 'search' }" @click="switchType('search')">
        search 缓存
      </button>
      <button class="cache-type-tab" :class="{ active: state.type === 'card' }" @click="switchType('card')">
        商品卡缓存
      </button>
      <button class="cache-type-tab" :class="{ active: state.type === 'richMedia' }" @click="switchType('richMedia')">
        richMedia 缓存
      </button>
      <button class="cache-type-tab" :class="{ active: state.type === 'detail' }" @click="switchType('detail')">
        详情页缓存
      </button>
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'marketStats' }"
        @click="switchType('marketStats')"
      >
        marketStats 缓存
      </button>
      <button class="cache-type-tab" :class="{ active: state.type === 'followSell' }" @click="switchType('followSell')">
        followSell 缓存
      </button>
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'store-classification' }"
        @click="switchType('store-classification')"
      >
        店铺分类
      </button>
      <button class="cache-type-tab" :class="{ active: state.type === 'store-sku' }" @click="switchType('store-sku')">
        店铺 SKU
      </button>
    </div>

    <!-- 缓存列表区(非店铺分类/店铺 SKU tab) -->
    <template
      v-if="state.type !== 'store-classification' && state.type !== 'store-sku'"
    >
      <!-- 筛选 -->
      <div class="filter-bar">
        <input
          class="filter-input"
          type="text"
          v-model.trim="state.keyword"
          placeholder="搜索 SKU"
          @keydown.enter="search"
        />
        <button class="btn btn-primary" @click="search">查询</button>
        <span class="spacer"></span>
        <button v-if="state.type !== 'overview'" class="btn btn-danger" @click="onClearAll">
          清空 {{ state.type }} 缓存
        </button>
      </div>

      <!-- 列表:全览模式 -->
      <div v-if="state.type === 'overview'" class="table-wrap">
        <table class="data-table overview-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th title="Seller Portal /api/v1/search 源数据">search</th>
              <th title="create-bundle-by-variant-id 完整属性">bundle</th>
              <th title="商品卡 DOM:sku/url/name/price/image">商品卡</th>
              <th title="富媒体缓存(合并 entrypoint+composer:图册/视频/富内容/描述/标签/fields)">richMedia</th>
              <th title="详情页 DOM 全字段(静态+动态)">详情页</th>
              <th title="市场统计缓存">marketStats</th>
              <th title="跟卖缓存">followSell</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="state.loading && !state.items.length">
              <td colspan="9" class="muted" style="padding: 24px; text-align: center">加载中...</td>
            </tr>
            <tr v-else-if="!state.items.length">
              <td colspan="9" class="empty">暂无缓存记录</td>
            </tr>
            <tr v-for="it in state.items" :key="it.sku">
              <td class="col-sku">{{ it.sku }}</td>
              <td>
                <span v-if="it.search" class="tag tag-ok" :title="fmtTime(it.search.fetchedAt)">✓</span>
                <span v-else class="tag tag-mute">—</span>
              </td>
              <td>
                <span v-if="!it.bundle" class="tag tag-mute">—</span>
                <span v-else-if="!it.bundle.attrsEmpty" class="tag tag-ok" :title="fmtTime(it.bundle.fetchedAt)"
                  >有属性</span
                >
                <span v-else-if="it.bundle.attrsStale" class="tag tag-err" :title="fmtTime(it.bundle.fetchedAt)"
                  >空(待重验)</span
                >
                <span v-else class="tag tag-warn" :title="fmtTime(it.bundle.fetchedAt)">空(6h内)</span>
              </td>
              <td>
                <span v-if="it.card" class="tag tag-ok" :title="fmtTime(it.card.fetchedAt)">✓</span>
                <span v-else class="tag tag-mute">—</span>
              </td>
              <td>
                <span v-if="it.richMedia" class="tag tag-ok" :title="fmtTime(it.richMedia.fetchedAt)">✓</span>
                <span v-else class="tag tag-mute">—</span>
              </td>
              <td>
                <span v-if="it.detail" class="tag tag-ok" :title="fmtTime(it.detail.fetchedAt)">✓</span>
                <span v-else class="tag tag-mute">—</span>
              </td>
              <td :class="{ stale: isStale(it, 'marketStats') }">
                <span v-if="it.marketStats" class="tag tag-ok" :title="fmtTime(it.marketStats.fetchedAt)">✓</span>
                <span v-else class="tag tag-mute">—</span>
              </td>
              <td :class="{ stale: isStale(it, 'followSell') }">
                <span v-if="it.followSell" class="tag tag-ok" :title="fmtTime(it.followSell.fetchedAt)">✓</span>
                <span v-else class="tag tag-mute">—</span>
              </td>
              <td class="row-actions">
                <button class="btn btn-sm btn-primary" @click="openOpiPreview(it.sku)">OPI 预览</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 列表:单类型模式 -->
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>抓取时间</th>
              <th v-if="state.type === 'bundle'">bundleId</th>
              <th v-if="state.type === 'bundle'">属性状态</th>
              <th v-if="state.type === 'marketStats' || state.type === 'followSell'">L2 同步</th>
              <th v-if="state.type === 'marketStats' || state.type === 'followSell'">数据状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="state.loading && !state.items.length">
              <td :colspan="singleTypeColspan" class="muted" style="padding: 24px; text-align: center">加载中...</td>
            </tr>
            <tr v-else-if="!state.items.length">
              <td :colspan="singleTypeColspan" class="empty">暂无缓存记录</td>
            </tr>
            <tr v-for="it in state.items" :key="it.sku">
              <td class="col-sku">{{ it.sku }}</td>
              <td class="col-time">{{ fmtTime(it.fetchedAt) }}</td>
              <td v-if="state.type === 'bundle'" class="col-bundle-id">{{ it.bundleId || '—' }}</td>
              <td v-if="state.type === 'bundle'">
                <span v-if="!it.attrsEmpty" class="tag tag-ok">有属性</span>
                <span v-else-if="isStale(it)" class="tag tag-err">空(待重验)</span>
                <span v-else class="tag tag-warn">空(6h 内验证)</span>
              </td>
              <td v-if="state.type === 'marketStats' || state.type === 'followSell'">
                <span v-if="it.l2Synced" class="tag tag-ok">已同步</span>
                <span v-else class="tag tag-warn">待同步</span>
              </td>
              <td v-if="state.type === 'marketStats' || state.type === 'followSell'">
                <span v-if="it.stale" class="tag tag-err">已过期</span>
                <span v-else class="tag tag-ok">新鲜</span>
              </td>
              <td class="row-actions">
                <button class="btn btn-sm btn-ghost" @click="openDetail(it)">详情</button>
                <button class="btn btn-sm btn-danger" @click="onRemove(it)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <AppPager
        :modelValue="state.page"
        :total="state.total"
        :pageSize="state.pageSize"
        @update:modelValue="onPageChange"
      />
    </template>

    <!-- ── 店铺分类 tab ───────────────────────────────────── -->
    <div v-if="state.type === 'store-classification'" class="store-classification-tab">
      <div class="filter-bar">
        <select v-model="storeClassFilters.isChinese" class="filter-input">
          <option :value="null">全部分类</option>
          <option :value="true">中国店铺</option>
          <option :value="false">非中国店铺</option>
        </select>
        <input
          class="filter-input"
          type="text"
          v-model.trim="storeClassFilters.keyword"
          placeholder="店铺名/Slug"
          @keydown.enter="searchStoreClassifications"
        />
        <button class="btn btn-primary" @click="searchStoreClassifications">查询</button>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Seller Slug</th>
              <th>Seller Name</th>
              <th>是否中国</th>
              <th>分类方式</th>
              <th>公司信息</th>
              <th>最后访问</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!storeClassifications.length">
              <td colspan="7" class="empty">暂无店铺分类记录</td>
            </tr>
            <tr v-for="sc in storeClassifications" :key="sc._id">
              <td class="col-sku">{{ sc.sellerSlug }}</td>
              <td>{{ sc.sellerName || '—' }}</td>
              <td>
                <span :class="storeClassBadge(sc.isChinese)">
                  {{ sc.isChinese === true ? '中国' : sc.isChinese === false ? '非中国' : '待确认' }}
                </span>
              </td>
              <td>{{ sc.classifiedBy || '—' }}</td>
              <td>{{ sc.companyInfo?.companyName || '—' }}</td>
              <td class="col-time">{{ fmtTime(sc.lastSeenAt) }}</td>
              <td class="row-actions">
                <button class="btn btn-sm btn-primary" @click="updateStoreClass(sc.sellerSlug, { isChinese: true })">
                  标记中国
                </button>
                <button class="btn btn-sm btn-ghost" @click="updateStoreClass(sc.sellerSlug, { isChinese: false })">
                  标记非中国
                </button>
                <button class="btn btn-sm btn-danger" @click="deleteStoreClass(sc.sellerSlug)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <AppPager
        :modelValue="storeClassPager.current"
        :total="storeClassPager.total"
        :pageSize="storeClassPager.pageSize"
        @update:modelValue="onStoreClassPageChange"
      />
    </div>

    <!-- 店铺 SKU 关联 tab -->
    <div v-if="state.type === 'store-sku'" class="store-sku-tab">
      <div class="filter-bar">
        <input
          class="filter-input"
          type="text"
          v-model.trim="storeSkuFilters.keyword"
          placeholder="SKU / 店铺名 / Slug / SellerId"
          @keydown.enter="searchStoreSkus"
        />
        <button class="btn btn-primary" @click="searchStoreSkus">查询</button>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Seller ID</th>
              <th>Seller Slug</th>
              <th>Seller Name</th>
              <th>采集状态</th>
              <th>首次发现</th>
              <th>最后发现</th>
              <th>最后采集</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!storeSkus.length">
              <td colspan="9" class="empty">暂无店铺 SKU 关联记录</td>
            </tr>
            <tr v-for="ss in storeSkus" :key="ss._id">
              <td class="col-sku">{{ ss.sku }}</td>
              <td>{{ ss.sellerId || '—' }}</td>
              <td>{{ ss.sellerSlug || '—' }}</td>
              <td>{{ ss.sellerName || '—' }}</td>
              <td>
                <span v-if="ss.lastCollectStatus" :class="collectStatusTag(ss.lastCollectStatus)">
                  {{ ss.lastCollectStatus }}
                </span>
                <span v-else class="muted">—</span>
              </td>
              <td class="col-time">{{ fmtTime(ss.firstSeenAt) }}</td>
              <td class="col-time">{{ fmtTime(ss.lastSeenAt) }}</td>
              <td class="col-time">{{ fmtTime(ss.lastCollectAt) }}</td>
              <td class="row-actions">
                <button class="btn btn-sm btn-danger" @click="deleteStoreSkuRecord(ss.sku)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <AppPager
        :modelValue="storeSkuPager.current"
        :total="storeSkuPager.total"
        :pageSize="storeSkuPager.pageSize"
        @update:modelValue="onStoreSkuPageChange"
      />
    </div>

    <!-- 详情弹窗 -->
    <AppModal :open="detailOpen" :title="detailTitle" size="lg" @update:open="detailOpen = $event">
      <p v-if="detailLoading" class="muted">加载中...</p>
      <div v-else-if="detailData" class="cache-detail">
        <div class="cache-detail-meta">
          <div><b>SKU:</b> {{ detailData.sku }}</div>
          <div><b>抓取时间:</b> {{ fmtTime(detailData.fetchedAt) }}</div>
          <div v-if="detailData.bundleId"><b>bundleId:</b> {{ detailData.bundleId }}</div>
          <div v-if="detailData.attrsEmptyVerifiedAt">
            <b>空属性验证:</b> {{ fmtTime(detailData.attrsEmptyVerifiedAt) }}
          </div>
          <div v-if="detailData.l2Synced !== undefined">
            <b>L2 同步:</b>
            <span :class="detailData.l2Synced ? 'tag tag-ok' : 'tag tag-warn'">
              {{ detailData.l2Synced ? '已同步' : '待同步' }}
            </span>
          </div>
          <div v-if="detailData.stale !== undefined">
            <b>数据状态:</b>
            <span :class="detailData.stale ? 'tag tag-err' : 'tag tag-ok'">
              {{ detailData.stale ? '已过期' : '新鲜' }}
            </span>
          </div>
        </div>
        <div class="cache-detail-data">
          <h3>缓存数据</h3>
          <JsonTree :data="detailData.data" :default-expand-level="2" root-key="data" />
        </div>
      </div>
      <p v-else class="muted">未找到缓存记录</p>
    </AppModal>

    <!-- OPI 预览弹窗 -->
    <AppModal :open="opiOpen" :title="opiTitle" size="lg" @update:open="opiOpen = $event">
      <p v-if="opiLoading" class="muted">加载中...</p>
      <div v-else-if="opiError" class="opi-error">
        <p>⚠️ {{ opiError }}</p>
        <div v-if="opiSources" class="opi-sources">
          <span>缓存来源:</span>
          <span :class="opiSourceTag(opiSources.search)">search</span>
          <span :class="opiSourceTag(opiSources.bundle)">bundle</span>
          <span :class="opiSourceTag(opiSources.card)">商品卡</span>
          <span :class="opiSourceTag(opiSources.richMedia)">richMedia</span>
          <span :class="opiSourceTag(opiSources.detail)">详情页</span>
        </div>
      </div>
      <div v-else-if="opiData" class="opi-preview">
        <div class="opi-sources-bar">
          <span class="opi-sources-label">缓存来源:</span>
          <span
            :class="opiSourceTag(opiSources?.search)"
            :title="opiSourceLabel(opiSources?.search, 'Seller Portal /api/v1/search')"
          >
            search {{ opiSourceLabel(opiSources?.search, '✓') }}
          </span>
          <span
            :class="opiSourceTag(opiSources?.bundle)"
            :title="opiSourceLabel(opiSources?.bundle, 'create-bundle-by-variant-id')"
          >
            bundle {{ opiSourceLabel(opiSources?.bundle, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.card)" :title="opiSourceLabel(opiSources?.card, '商品卡 DOM')">
            商品卡 {{ opiSourceLabel(opiSources?.card, '✓') }}
          </span>
          <span
            :class="opiSourceTag(opiSources?.richMedia)"
            :title="opiSourceLabel(opiSources?.richMedia, '富媒体缓存(合并 entrypoint+composer)')"
          >
            richMedia {{ opiSourceLabel(opiSources?.richMedia, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.detail)" :title="opiSourceLabel(opiSources?.detail, '详情页 DOM')">
            详情页 {{ opiSourceLabel(opiSources?.detail, '✓') }}
          </span>
        </div>
        <div class="opi-field-summary">
          <div><b>name:</b> {{ opiData.name || '—' }}</div>
          <div><b>offer_id:</b> {{ opiData.offer_id || '—' }}</div>
          <div><b>price:</b> {{ opiData.price || '—' }}</div>
          <div><b>images:</b> {{ opiData.images?.length || 0 }} 张</div>
          <div><b>attributes:</b> {{ opiData.attributes?.length || 0 }} 个</div>
          <div><b>complex_attributes:</b> {{ opiData.complex_attributes?.length || 0 }} 组</div>
          <div v-if="opiData.weight"><b>weight:</b> {{ opiData.weight }} {{ opiData.weight_unit }}</div>
          <div v-if="opiData.type_id"><b>type_id:</b> {{ opiData.type_id }}</div>
          <div v-if="opiData.description_category_id">
            <b>description_category_id:</b> {{ opiData.description_category_id }}
          </div>
        </div>
        <div class="opi-json-section">
          <h3>OPI v3 JSON</h3>
          <JsonTree :data="opiData" :default-expand-level="2" root-key="item" />
        </div>
      </div>
      <p v-else class="muted">无数据</p>
    </AppModal>
  </div>
</template>

<style scoped>
.cache-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  padding: 0 24px 16px;
}
.cache-stat-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px;
  text-align: center;
}
.cache-stat-label {
  font-size: 12px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.cache-stat-value {
  font-size: 28px;
  font-weight: 600;
  margin: 6px 0 2px;
  color: var(--text);
}
.cache-stat-value.stat-warn {
  color: var(--warning);
}
.cache-stat-value.stat-err {
  color: var(--danger);
}
.cache-stat-sub {
  font-size: 12px;
  color: var(--muted);
}

.cache-type-tabs {
  display: flex;
  gap: 0;
  padding: 0 24px 12px;
}
.cache-type-tab {
  padding: 8px 18px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}
.cache-type-tab:first-child {
  border-radius: 6px 0 0 6px;
}
.cache-type-tab:last-child {
  border-radius: 0 6px 6px 0;
  border-left: none;
}
.cache-type-tab.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}

.col-sku {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 12px;
}
.col-bundle-id {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 12px;
  color: var(--muted);
}

.cache-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.cache-detail-meta {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
}
.cache-detail-meta b {
  color: var(--muted);
  font-weight: 500;
}
.cache-detail-data h3 {
  margin-bottom: 8px;
}

/* 全览表格 */
.overview-table th,
.overview-table td {
  text-align: center;
}
.overview-table .col-sku {
  text-align: left;
}
.tag-mute {
  background: #f3f4f6;
  color: #9ca3af;
}
.overview-table .row-actions {
  text-align: center;
}

/* OPI 预览弹窗 */
.opi-preview {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.opi-sources-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 10px 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 12px;
}
.opi-sources-label {
  color: var(--muted);
  margin-right: 4px;
}
.opi-sources-bar > span:not(.opi-sources-label) {
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
}
.opi-field-summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
}
.opi-field-summary b {
  color: var(--muted);
  font-weight: 500;
}
.opi-json-section h3 {
  margin-bottom: 8px;
}
.opi-error {
  padding: 12px;
  background: #fef2f2;
  border-radius: 6px;
  color: #b91c1c;
}
.opi-error .opi-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
}
.opi-error .opi-sources > span {
  padding: 2px 8px;
  border-radius: 4px;
}

/* ── overview stale(marketStats/followSell 超 24h)── */
.stale {
  color: var(--warning);
}
.stale .tag {
  background: #fff7ed;
  color: #c2410c;
}

/* ── 店铺分类 tab ─────────────────────────────────────── */
.badge-chinese {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background: #dbeafe;
  color: #1d4ed8;
}
.badge-non-chinese {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background: #fef3c7;
  color: #b45309;
}
.badge-pending {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background: #f3f4f6;
  color: #6b7280;
}
</style>
