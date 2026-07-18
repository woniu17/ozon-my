<script setup>
import { reactive, ref, computed, onMounted } from 'vue';
import {
  getCacheOverview,
  getOpiPreview,
  getCacheByType,
  getListedRecords,
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

// Ozon 商品详情页 URL(sku 直接拼到 /product/-{sku}/)
const OZON_PDP_PREFIX = 'https://www.ozon.ru/product/-';

// ── SKU 数据列表 ───────────────────────────────────────────
const state = reactive({
  type: 'overview', // overview | store-classification | store-sku
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
    const data = await getCacheOverview({
      keyword: state.keyword.trim(),
      page: state.page,
      pageSize: state.pageSize,
    });
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

// ── 渲染辅助 ───────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// overview 行中 dom 命中 = card 或 detail 任一命中
function domHit(it) {
  return !!(it.card || it.detail);
}
function domFetchedAt(it) {
  const a = it.card?.fetchedAt ? new Date(it.card.fetchedAt).getTime() : 0;
  const b = it.detail?.fetchedAt ? new Date(it.detail.fetchedAt).getTime() : 0;
  const max = Math.max(a, b);
  return max ? new Date(max).toISOString() : null;
}
// overview 行中 attribute 命中 = search 或 bundle 任一命中
function attributeHit(it) {
  return !!(it.search || it.bundle);
}
function attributeFetchedAt(it) {
  const a = it.search?.fetchedAt ? new Date(it.search.fetchedAt).getTime() : 0;
  const b = it.bundle?.fetchedAt ? new Date(it.bundle.fetchedAt).getTime() : 0;
  const max = Math.max(a, b);
  return max ? new Date(max).toISOString() : null;
}

function isStale(it, type) {
  // overview 矩阵:marketStats 基于 fetchedAt 超过 24h 判定 stale
  if (type === 'marketStats') {
    const entry = it.marketStats;
    if (!entry || !entry.fetchedAt) return false;
    const age = Date.now() - new Date(entry.fetchedAt).getTime();
    return age > 24 * 60 * 60 * 1000;
  }
  return false;
}

// 命中徽章渲染
// type: 'dom' | 'attribute' | 'richMedia' | 'marketStats' | 'listed'
function hitBadgeClass(it, type) {
  let hit = false;
  let stale = false;
  if (type === 'dom') {
    hit = domHit(it);
  } else if (type === 'attribute') {
    hit = attributeHit(it);
  } else if (type === 'richMedia') {
    hit = !!it.richMedia;
  } else if (type === 'marketStats') {
    hit = !!it.marketStats;
    stale = isStale(it, 'marketStats');
  } else if (type === 'listed') {
    hit = !!it.listed;
  }
  if (!hit) return 'tag tag-mute';
  return stale ? 'tag tag-warn' : 'tag tag-ok';
}
function hitBadgeText(it, type) {
  let hit = false;
  let stale = false;
  let fetchedAt = null;
  if (type === 'dom') {
    hit = domHit(it);
    fetchedAt = domFetchedAt(it);
  } else if (type === 'attribute') {
    hit = attributeHit(it);
    fetchedAt = attributeFetchedAt(it);
  } else if (type === 'richMedia') {
    hit = !!it.richMedia;
    fetchedAt = it.richMedia?.fetchedAt;
  } else if (type === 'marketStats') {
    hit = !!it.marketStats;
    stale = isStale(it, 'marketStats');
    fetchedAt = it.marketStats?.fetchedAt;
  } else if (type === 'listed') {
    hit = !!it.listed;
  }
  if (!hit) return '—';
  if (stale) return '过期';
  return '✓';
}
function hitBadgeTitle(it, type) {
  let fetchedAt = null;
  if (type === 'dom') fetchedAt = domFetchedAt(it);
  else if (type === 'attribute') fetchedAt = attributeFetchedAt(it);
  else if (type === 'richMedia') fetchedAt = it.richMedia?.fetchedAt;
  else if (type === 'marketStats') fetchedAt = it.marketStats?.fetchedAt;
  else if (type === 'listed') return it.listed ? '已提交跟卖任务' : '未跟卖';
  return fetchedAt ? `抓取于 ${fmtTime(fetchedAt)}` : '';
}

// ── 详情弹窗(按 type 调用 /ozon/cache/{type}/:sku 或 /admin/api/cache/listed/:sku) ────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailType = ref(''); // 'dom' | 'attribute' | 'richMedia' | 'marketStats' | 'listed'
const detailSku = ref('');
const detailData = ref(null); // 原始响应
const detailTitle = computed(() => `详情 · ${detailType.value} · ${detailSku.value}`);

const TYPE_LABELS = {
  dom: 'Dom(card + detail 合并)',
  attribute: 'Attribute(search + bundle 合并)',
  richMedia: 'richMedia(富媒体)',
  marketStats: 'marketStats(市场统计)',
  listed: '已跟卖(跟卖任务记录)',
};

async function openDetail(it, type) {
  // 仅在命中时才允许打开
  if (!hitBadgeText(it, type) || hitBadgeText(it, type) === '—') return;
  detailOpen.value = true;
  detailLoading.value = true;
  detailType.value = type;
  detailSku.value = it.sku;
  detailData.value = null;
  try {
    if (type === 'listed') {
      // 跟卖记录走 /admin/api/cache/listed/:sku
      detailData.value = await getListedRecords(it.sku);
    } else {
      detailData.value = await getCacheByType(type, it.sku);
    }
  } catch (err) {
    show(err.message || String(err), 'error');
    detailData.value = null;
  } finally {
    detailLoading.value = false;
  }
}

// 把详情响应扁平化为 { label, value } 项列表用于展示 meta
function detailMetaItems() {
  if (!detailData.value) return [];
  const d = detailData.value;
  const items = [];
  if (detailType.value === 'dom') {
    if (d.cardFetchedAt) items.push({ label: 'card 抓取时间', value: fmtTime(d.cardFetchedAt) });
    if (d.detailFetchedAt) items.push({ label: 'detail 抓取时间', value: fmtTime(d.detailFetchedAt) });
  } else if (detailType.value === 'attribute') {
    if (d.searchFetchedAt) items.push({ label: 'search 抓取时间', value: fmtTime(d.searchFetchedAt) });
    if (d.bundleFetchedAt) items.push({ label: 'bundle 抓取时间', value: fmtTime(d.bundleFetchedAt) });
    if (d.bundleId) items.push({ label: 'bundleId', value: d.bundleId });
    if (d.attrsEmptyVerifiedAt)
      items.push({ label: '空属性验证', value: fmtTime(d.attrsEmptyVerifiedAt) });
    if (d.stale !== undefined)
      items.push({ label: '数据状态', value: d.stale ? '已过期(空属性超 6h)' : '新鲜' });
  } else if (detailType.value === 'richMedia') {
    if (d.fetchedAt) items.push({ label: '抓取时间', value: fmtTime(d.fetchedAt) });
  } else if (detailType.value === 'marketStats') {
    if (d.fetchedAt) items.push({ label: '抓取时间', value: fmtTime(d.fetchedAt) });
    if (d.l2Synced !== undefined)
      items.push({ label: 'L2 同步', value: d.l2Synced ? '已同步' : '待同步' });
    if (d.stale !== undefined)
      items.push({ label: '数据状态', value: d.stale ? '已过期' : '新鲜' });
  } else if (detailType.value === 'listed') {
    const count = d.items?.length || 0;
    items.push({ label: '跟卖记录数', value: String(count) });
  }
  return items;
}

// 详情的 JsonTree 节点:按 type 取出主要数据部分展示
function detailJsonNodes() {
  if (!detailData.value) return [];
  const d = detailData.value;
  const nodes = [];
  if (detailType.value === 'dom') {
    if (d.card) nodes.push({ key: 'card', data: d.card });
    if (d.detail) nodes.push({ key: 'detail', data: d.detail });
  } else if (detailType.value === 'attribute') {
    if (d.searchData) nodes.push({ key: 'search', data: d.searchData });
    if (d.bundleData) nodes.push({ key: 'bundle', data: d.bundleData });
  } else if (detailType.value === 'richMedia') {
    if (d.data) nodes.push({ key: 'data', data: d.data });
  } else if (detailType.value === 'marketStats') {
    if (d.data) nodes.push({ key: 'data', data: d.data });
  }
  // listed 类型不返回 JsonTree 节点,改用专门表格展示
  return nodes;
}

// listed 详情的跟卖记录列表
function listedRecords() {
  if (detailType.value !== 'listed' || !detailData.value) return [];
  return detailData.value.items || [];
}

// 跟卖记录状态徽章
function listedStatusBadge(status) {
  if (status === 'imported') return 'tag tag-ok';
  if (status === 'failed') return 'tag tag-err';
  if (status === 'pending' || status === 'skipped') return 'tag tag-mute';
  return 'tag tag-mute';
}

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
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>数据管理</h2>
      <div style="display: flex; gap: 8px">
        <button
          v-if="state.type === 'overview'"
          class="btn btn-ghost"
          :disabled="state.loading"
          @click="loadList"
        >
          {{ state.loading ? '刷新中...' : '刷新列表' }}
        </button>
      </div>
    </div>

    <!-- 类型切换 -->
    <div class="cache-type-tabs">
      <button class="cache-type-tab" :class="{ active: state.type === 'overview' }" @click="switchType('overview')">
        SKU 数据
      </button>
      <button
        class="cache-type-tab"
        :class="{ active: state.type === 'store-classification' }"
        @click="switchType('store-classification')"
      >
        店铺数据
      </button>
      <button class="cache-type-tab" :class="{ active: state.type === 'store-sku' }" @click="switchType('store-sku')">
        店铺 SKU
      </button>
    </div>

    <!-- SKU 数据 tab -->
    <template v-if="state.type === 'overview'">
      <!-- 筛选 -->
      <div class="filter-bar">
        <input
          class="filter-input"
          type="text"
          v-model.trim="state.keyword"
          placeholder="搜索 SKU / 名称 / 店铺"
          @keydown.enter="search"
        />
        <button class="btn btn-primary" @click="search">查询</button>
      </div>

      <!-- 列表 -->
      <div class="table-wrap">
        <table class="data-table overview-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th title="card + detail 合并表(DOM 解析字段)">Dom</th>
              <th title="search + bundle 合并表(Seller Portal 属性)">Attribute</th>
              <th title="富媒体缓存(图册/视频/富内容/fields)">richMedia</th>
              <th title="市场统计缓存(stale 24h)">marketStats</th>
              <th title="是否已提交过跟卖任务(基于 follow_sell_task_items)">已跟卖</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="state.loading && !state.items.length">
              <td colspan="7" class="muted" style="padding: 24px; text-align: center">加载中...</td>
            </tr>
            <tr v-else-if="!state.items.length">
              <td colspan="7" class="empty">暂无数据</td>
            </tr>
            <tr v-for="it in state.items" :key="it.sku">
              <td class="col-sku">
                <a :href="OZON_PDP_PREFIX + it.sku + '/'" target="_blank" rel="noopener" class="sku-link">
                  {{ it.sku }}
                </a>
              </td>
              <td
                class="cell-clickable"
                :title="hitBadgeTitle(it, 'dom')"
                @click="openDetail(it, 'dom')"
              >
                <span :class="hitBadgeClass(it, 'dom')">{{ hitBadgeText(it, 'dom') }}</span>
              </td>
              <td
                class="cell-clickable"
                :title="hitBadgeTitle(it, 'attribute')"
                @click="openDetail(it, 'attribute')"
              >
                <span :class="hitBadgeClass(it, 'attribute')">{{ hitBadgeText(it, 'attribute') }}</span>
              </td>
              <td
                class="cell-clickable"
                :title="hitBadgeTitle(it, 'richMedia')"
                @click="openDetail(it, 'richMedia')"
              >
                <span :class="hitBadgeClass(it, 'richMedia')">{{ hitBadgeText(it, 'richMedia') }}</span>
              </td>
              <td
                class="cell-clickable"
                :title="hitBadgeTitle(it, 'marketStats')"
                @click="openDetail(it, 'marketStats')"
              >
                <span :class="hitBadgeClass(it, 'marketStats')">{{ hitBadgeText(it, 'marketStats') }}</span>
              </td>
              <td
                class="cell-clickable"
                :title="hitBadgeTitle(it, 'listed')"
                @click="openDetail(it, 'listed')"
              >
                <span :class="hitBadgeClass(it, 'listed')">{{ hitBadgeText(it, 'listed') }}</span>
              </td>
              <td class="row-actions">
                <button class="btn btn-sm btn-primary" @click="openOpiPreview(it.sku)">OPI 预览</button>
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

    <!-- ── 店铺数据 tab ───────────────────────────────────── -->
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
          <div class="meta-header">{{ TYPE_LABELS[detailType] }}</div>
          <div v-for="(m, i) in detailMetaItems()" :key="i" class="meta-item">
            <b>{{ m.label }}:</b> {{ m.value }}
          </div>
        </div>
        <!-- listed 类型:展示跟卖记录表格 -->
        <div v-if="detailType === 'listed'" class="listed-records">
          <table v-if="listedRecords().length" class="data-table listed-table">
            <thead>
              <tr>
                <th>Offer ID</th>
                <th>店铺</th>
                <th>商品名</th>
                <th>价格</th>
                <th>Product ID</th>
                <th>状态</th>
                <th>库存</th>
                <th>提交时间</th>
                <th>任务状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in listedRecords()" :key="r.id">
                <td class="col-sku">{{ r.offerId }}</td>
                <td>{{ r.storeId || '—' }}</td>
                <td class="col-name">{{ r.name || '—' }}</td>
                <td>{{ r.price || '—' }}</td>
                <td>{{ r.productId || '—' }}</td>
                <td>
                  <span :class="listedStatusBadge(r.status)">{{ r.status }}</span>
                </td>
                <td>
                  <span v-if="r.stockSet === 1" class="tag tag-ok">已设置</span>
                  <span v-else-if="r.stockSet === 2" class="tag tag-err">失败</span>
                  <span v-else class="tag tag-mute">待处理</span>
                </td>
                <td class="col-time">{{ fmtTime(r.itemCreatedAt) }}</td>
                <td>{{ r.taskStatus || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">无跟卖记录</p>
        </div>
        <!-- 其他类型:展示 JsonTree -->
        <div v-else class="cache-detail-data">
          <div v-for="(node, i) in detailJsonNodes()" :key="i" class="json-block">
            <h3>{{ node.key }}</h3>
            <JsonTree :data="node.data" :default-expand-level="2" :root-key="node.key" />
          </div>
          <p v-if="!detailJsonNodes().length" class="muted">无数据</p>
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
.sku-link {
  color: var(--primary);
  text-decoration: none;
}
.sku-link:hover {
  text-decoration: underline;
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
.cell-clickable {
  cursor: pointer;
  transition: background 0.15s;
}
.cell-clickable:hover {
  background: #f9fafb;
}

/* 详情弹窗 */
.cache-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.cache-detail-meta {
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
}
.cache-detail-meta .meta-header {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text);
}
.cache-detail-meta .meta-item {
  margin: 2px 0;
}
.cache-detail-meta b {
  color: var(--muted);
  font-weight: 500;
}
.cache-detail-data .json-block {
  margin-bottom: 16px;
}
.cache-detail-data .json-block h3 {
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

/* listed 跟卖记录表格 */
.listed-records .listed-table {
  font-size: 12px;
}
.listed-records .listed-table th,
.listed-records .listed-table td {
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
.listed-records .col-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.listed-records .col-time {
  white-space: nowrap;
  color: var(--muted);
}
.tag-err {
  background: #fef2f2;
  color: #b91c1c;
}
.tag-ok {
  background: #ecfdf5;
  color: #047857;
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

/* ── overview stale(marketStats 超 24h)── */
.tag-warn {
  background: #fff7ed;
  color: #c2410c;
}

/* ── 店铺数据 tab ─────────────────────────────────────── */
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
