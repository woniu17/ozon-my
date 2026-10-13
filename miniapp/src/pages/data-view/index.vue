<template>
  <view class="page">
    <!-- Tab 切换 -->
    <view class="tabs">
      <view
        v-for="t in TABS"
        :key="t.key"
        class="tab"
        :class="{ on: activeTab === t.key }"
        @click="switchTab(t.key)"
      >{{ t.label }}</view>
    </view>

    <!-- 搜索框 -->
    <view class="search-box">
      <input
        class="search-input"
        v-model="keyword"
        :placeholder="searchPlaceholder"
        placeholder-class="ph"
        confirm-type="search"
        @confirm="doSearch"
      />
      <text v-if="keyword" class="search-clear" @click="clearSearch">×</text>
      <view class="search-btn" @click="doSearch">查询</view>
    </view>

    <view v-if="error" class="error-bar">{{ error }}</view>

    <!-- ═══ SKU 数据列表 ═══ -->
    <template v-if="activeTab === 'sku'">
      <view v-if="view.total" class="count-hint">共 {{ view.total }} 条 SKU 记录</view>
      <view class="list">
        <template v-if="view.loading && !view.items.length">
          <view v-for="i in 4" :key="i" class="card skeleton">
            <view class="sk-line w40"></view>
            <view class="sk-line w80"></view>
          </view>
        </template>
        <template v-else-if="!view.items.length">
          <view class="empty">暂无数据</view>
        </template>
        <template v-else>
          <view v-for="it in view.items" :key="it.sku" class="card">
            <view class="card-head">
              <text class="sku" @click="copyText(it.sku, 'SKU')">{{ it.sku }}</text>
              <text class="hit-count">{{ it.hitCount ?? 0 }} 类命中</text>
            </view>
            <view class="hit-grid">
              <view class="hit-item">
                <text class="hit-k">Dom</text>
                <text class="hit-v" :class="hitCls(domHit(it))">{{ domHit(it) ? '✓' : '—' }}</text>
              </view>
              <view class="hit-item">
                <text class="hit-k">Attribute</text>
                <text class="hit-v" :class="hitCls(attrHit(it))">{{ attrHit(it) ? '✓' : '—' }}</text>
              </view>
              <view class="hit-item">
                <text class="hit-k">富媒体</text>
                <text class="hit-v" :class="hitCls(!!it.richMedia)">{{ it.richMedia ? '✓' : '—' }}</text>
              </view>
              <view class="hit-item">
                <text class="hit-k">市场</text>
                <text class="hit-v" :class="marketCls(it)">{{ marketText(it) }}</text>
              </view>
              <view class="hit-item">
                <text class="hit-k">跟卖</text>
                <text class="hit-v" :class="followCls(it)">{{ followText(it) }}</text>
              </view>
            </view>
            <view class="card-foot">
              <text class="time">最后抓取 {{ fmtUtc(it.lastFetchedAt) }}</text>
              <text v-if="it.listed" class="listed-tag">已上架</text>
            </view>
          </view>
          <view v-if="view.loadingMore" class="load-more">加载中…</view>
          <view v-else-if="view.finished" class="load-more">没有更多了</view>
        </template>
      </view>
    </template>

    <!-- ═══ 店铺数据列表 ═══ -->
    <template v-else-if="activeTab === 'store'">
      <view v-if="view.total" class="count-hint">共 {{ view.total }} 条店铺记录</view>
      <view class="list">
        <template v-if="view.loading && !view.items.length">
          <view v-for="i in 4" :key="i" class="card skeleton">
            <view class="sk-line w40"></view>
            <view class="sk-line w80"></view>
          </view>
        </template>
        <template v-else-if="!view.items.length">
          <view class="empty">暂无数据</view>
        </template>
        <template v-else>
          <view v-for="sc in view.items" :key="sc._id || sc.sellerId" class="card">
            <view class="card-head">
              <text class="store-name" @click="copyText(sc.sellerId || sc._id, 'Seller ID')">{{ sc.sellerName || '—' }}</text>
              <text class="china-badge" :class="chinaCls(sc.isMainlandChina)">{{ chinaLabel(sc.isMainlandChina) }}</text>
            </view>
            <view class="store-sub">
              <text class="sub-id">Seller {{ sc.sellerId || sc._id || '—' }}</text>
              <text v-if="sc.companyInfo?.companyName" class="sub-id">· {{ sc.companyInfo.companyName }}</text>
            </view>
            <view class="card-grid">
              <view class="cg-item"><text class="k">采集 SKU</text><text class="v">{{ sc.skuCount ?? 0 }}</text></view>
              <view class="cg-item"><text class="k">订单数</text><text class="v">{{ sc.ordersCount ?? '—' }}</text></view>
              <view class="cg-item"><text class="k">评论数</text><text class="v">{{ sc.reviewsCount ?? '—' }}</text></view>
              <view class="cg-item"><text class="k">评分</text><text class="v">{{ sc.rating != null ? Number(sc.rating).toFixed(1) : '—' }}</text></view>
              <view class="cg-item"><text class="k">开业</text><text class="v">{{ sc.openedMonths != null ? sc.openedMonths + '月' : '—' }}</text></view>
              <view class="cg-item"><text class="k">分类</text><text class="v">{{ sc.classifiedBy || '—' }}</text></view>
            </view>
            <view class="card-foot">
              <text class="time">最后访问 {{ fmtUtc(sc.lastSeenAt) }}</text>
              <text class="open-link" @click="openStore(sc)">访问店铺 ↗</text>
            </view>
          </view>
          <view v-if="view.loadingMore" class="load-more">加载中…</view>
          <view v-else-if="view.finished" class="load-more">没有更多了</view>
        </template>
      </view>
    </template>

    <!-- ═══ 店铺 SKU 列表 ═══ -->
    <template v-else>
      <view v-if="view.total" class="count-hint">共 {{ view.total }} 条关联记录</view>
      <view class="list">
        <template v-if="view.loading && !view.items.length">
          <view v-for="i in 4" :key="i" class="card skeleton">
            <view class="sk-line w40"></view>
            <view class="sk-line w80"></view>
          </view>
        </template>
        <template v-else-if="!view.items.length">
          <view class="empty">暂无数据</view>
        </template>
        <template v-else>
          <view v-for="ss in view.items" :key="ss._id || ss.sku" class="card">
            <view class="card-head">
              <text class="sku" @click="copyText(ss.sku, 'SKU')">{{ ss.sku }}</text>
              <text class="collect-badge" :class="collectCls(ss.lastCollectStatus)">{{ ss.lastCollectStatus || '—' }}</text>
            </view>
            <view class="store-sub">
              <text class="sub-id">Seller {{ ss.sellerId || '—' }}</text>
              <text v-if="ss.sellerSlug" class="sub-id">· {{ ss.sellerSlug }}</text>
            </view>
            <view class="store-sub name-line">{{ ss.sellerName || '—' }}</view>
            <view class="card-grid">
              <view class="cg-item"><text class="k">首次发现</text><text class="v">{{ fmtUtc(ss.firstSeenAt) }}</text></view>
              <view class="cg-item"><text class="k">最后发现</text><text class="v">{{ fmtUtc(ss.lastSeenAt) }}</text></view>
              <view class="cg-item"><text class="k">最后采集</text><text class="v">{{ fmtUtc(ss.lastCollectAt) }}</text></view>
            </view>
          </view>
          <view v-if="view.loadingMore" class="load-more">加载中…</view>
          <view v-else-if="view.finished" class="load-more">没有更多了</view>
        </template>
      </view>
    </template>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onLoad, onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app';
import { getCacheOverview, getStoreClassificationList, getStoreSkuList } from '../../api/data-view.js';

const TABS = [
  { key: 'sku', label: 'SKU 数据' },
  { key: 'store', label: '店铺数据' },
  { key: 'store-sku', label: '店铺 SKU' },
];

const PAGE_SIZE = 20;
const activeTab = ref('sku');
const keyword = ref('');
const error = ref('');

function makeView() {
  return {
    items: [],
    page: 0,
    total: 0,
    loading: false,
    loadingMore: false,
    finished: false,
    loaded: false,
  };
}

const views = reactive({
  sku: makeView(),
  store: makeView(),
  'store-sku': makeView(),
});

const view = computed(() => views[activeTab.value]);

const API_MAP = {
  sku: getCacheOverview,
  store: getStoreClassificationList,
  'store-sku': getStoreSkuList,
};

const searchPlaceholder = computed(() => {
  if (activeTab.value === 'sku') return '搜索 SKU';
  if (activeTab.value === 'store') return '搜索店铺名 / Seller ID';
  return '搜索 SKU / 店铺名 / Slug / SellerId';
});

async function loadList(reset) {
  const v = view.value;
  if (v.loading) return;
  if (reset) {
    v.page = 1;
    v.finished = false;
    v.items = [];
    v.loading = true;
  } else {
    if (v.finished || v.loadingMore) return;
    v.page += 1;
    v.loadingMore = true;
  }
  error.value = '';
  const fn = API_MAP[activeTab.value];
  const isSku = activeTab.value === 'sku';
  try {
    const data = await fn(
      isSku
        ? { keyword: keyword.value.trim(), page: v.page, pageSize: PAGE_SIZE }
        : { keyword: keyword.value.trim(), currentPage: v.page, pageSize: PAGE_SIZE }
    );
    const items = data?.items || [];
    v.total = data?.total || 0;
    v.items = reset ? items : v.items.concat(items);
    if (v.items.length >= v.total) v.finished = true;
    v.loaded = true;
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    v.loading = false;
    v.loadingMore = false;
  }
}

function switchTab(key) {
  if (activeTab.value === key) return;
  activeTab.value = key;
  error.value = '';
  if (!view.value.loaded) loadList(true);
}

function doSearch() {
  loadList(true);
}

function clearSearch() {
  keyword.value = '';
  loadList(true);
}

// ── SKU 命中辅助 ─────────────────────────────────────────
function domHit(it) {
  return !!(it.card || it.detail);
}
function attrHit(it) {
  return !!(it.search || it.bundle);
}
function hitCls(hit) {
  return hit ? 'hit-on' : 'hit-off';
}
function marketText(it) {
  const m = it.marketStats;
  if (!m) return '—';
  if (m.stale) return '过期';
  return m.empty ? '✓无数据' : '✓';
}
function marketCls(it) {
  const m = it.marketStats;
  if (!m) return 'hit-off';
  return m.stale ? 'hit-stale' : 'hit-on';
}
function followText(it) {
  const f = it.followSell;
  if (!f) return '—';
  return f.stale ? '过期' : '✓';
}
function followCls(it) {
  const f = it.followSell;
  if (!f) return 'hit-off';
  return f.stale ? 'hit-stale' : 'hit-on';
}

// ── 店铺辅助 ─────────────────────────────────────────────
function chinaLabel(v) {
  if (v === true) return '中国';
  if (v === false) return '非中国';
  return '待确认';
}
function chinaCls(v) {
  if (v === true) return 'cn-yes';
  if (v === false) return 'cn-no';
  return 'cn-unknown';
}
function collectCls(st) {
  if (st === 'success') return 'cl-ok';
  if (st === 'failed' || st === 'antibot') return 'cl-err';
  if (st === 'partial') return 'cl-warn';
  return 'cl-mute';
}

// ── 通用辅助 ─────────────────────────────────────────────
// 后端时间均为 UTC(SQLite datetime / ISO / epoch),统一解析后本地展示(北京时间)
function fmtUtc(t) {
  if (t == null || t === '') return '—';
  let d;
  if (typeof t === 'number') {
    d = new Date(t);
  } else {
    const s = String(t).trim();
    if (/^\d{13}$/.test(s)) d = new Date(Number(s));
    else if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) d = new Date(s);
    else d = new Date(s.replace(' ', 'T') + 'Z');
  }
  if (!d || isNaN(d.getTime())) return String(t);
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

function copyText(text, label) {
  if (!text) return;
  uni.setClipboardData({
    data: String(text),
    success: () => uni.showToast({ title: `${label}已复制`, icon: 'none' }),
  });
}

function openStore(sc) {
  const sid = sc?.sellerId || sc?._id || '';
  if (!sid) return;
  // #ifdef H5
  window.open('https://www.ozon.ru/seller/' + encodeURIComponent(sid) + '/', '_blank');
  // #endif
}

onLoad(() => {
  loadList(true);
});

onPullDownRefresh(async () => {
  await loadList(true);
  uni.stopPullDownRefresh();
});

onReachBottom(() => {
  loadList(false);
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
  font-size: 26rpx;
  color: #4e5969;
  padding: 14rpx 0;
  border-radius: 10rpx;
}
.tab.on {
  background: #165dff;
  color: #ffffff;
  font-weight: 600;
}

.search-box {
  margin-top: 16rpx;
  display: flex;
  align-items: center;
  background: #ffffff;
  border-radius: 12rpx;
  padding: 0 8rpx 0 20rpx;
  height: 72rpx;
}
.search-input {
  flex: 1;
  font-size: 26rpx;
  color: #1f2329;
  height: 100%;
}
.ph {
  color: #a6abb3;
}
.search-clear {
  font-size: 34rpx;
  color: #a6abb3;
  padding: 0 12rpx;
}
.search-btn {
  font-size: 25rpx;
  color: #ffffff;
  background: #165dff;
  border-radius: 10rpx;
  padding: 10rpx 28rpx;
  margin: 8rpx 0;
}

.error-bar {
  margin-top: 12rpx;
  font-size: 24rpx;
  color: #f53f3f;
  background: #ffece8;
  padding: 12rpx 16rpx;
  border-radius: 10rpx;
}
.count-hint {
  margin-top: 14rpx;
  font-size: 22rpx;
  color: #86909c;
}

.list {
  margin-top: 12rpx;
}
.card {
  background: #ffffff;
  border-radius: 16rpx;
  padding: 20rpx;
  margin-bottom: 16rpx;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sku {
  font-family: 'Courier New', monospace;
  font-size: 27rpx;
  font-weight: 600;
  color: #165dff;
}
.hit-count {
  font-size: 21rpx;
  color: #86909c;
}

.hit-grid {
  margin-top: 14rpx;
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
}
.hit-item {
  flex: 1 1 calc(33.333% - 8rpx);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f7f8fa;
  border-radius: 10rpx;
  padding: 10rpx 14rpx;
  box-sizing: border-box;
}
.hit-k {
  font-size: 21rpx;
  color: #86909c;
}
.hit-v {
  font-size: 22rpx;
  font-weight: 600;
}
.hit-on {
  color: #00b42a;
}
.hit-off {
  color: #c9cdd4;
}
.hit-stale {
  color: #d97706;
}

.card-foot {
  margin-top: 12rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.time {
  font-size: 20rpx;
  color: #86909c;
}
.listed-tag {
  font-size: 20rpx;
  color: #00b42a;
  background: #e8ffea;
  border-radius: 999rpx;
  padding: 4rpx 14rpx;
}

.store-name {
  flex: 1;
  font-size: 27rpx;
  font-weight: 600;
  color: #1f2329;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.china-badge {
  font-size: 20rpx;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
  margin-left: 12rpx;
  flex-shrink: 0;
}
.cn-yes {
  color: #165dff;
  background: #eef4ff;
}
.cn-no {
  color: #d97706;
  background: #fff7e6;
}
.cn-unknown {
  color: #86909c;
  background: #f2f3f5;
}

.store-sub {
  margin-top: 6rpx;
  display: flex;
  flex-wrap: wrap;
}
.sub-id {
  font-family: 'Courier New', monospace;
  font-size: 21rpx;
  color: #86909c;
  margin-right: 8rpx;
}
.name-line {
  font-size: 23rpx;
  color: #4e5969;
}

.card-grid {
  margin-top: 12rpx;
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
}
.cg-item {
  flex: 1 1 calc(50% - 5rpx);
  font-size: 22rpx;
  color: #4e5969;
}
.cg-item .k {
  color: #86909c;
  margin-right: 6rpx;
}
.cg-item .v {
  font-variant-numeric: tabular-nums;
}

.open-link {
  font-size: 21rpx;
  color: #165dff;
}

.collect-badge {
  font-size: 20rpx;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
  margin-left: 12rpx;
  flex-shrink: 0;
}
.cl-ok {
  color: #00b42a;
  background: #e8ffea;
}
.cl-err {
  color: #f53f3f;
  background: #ffece8;
}
.cl-warn {
  color: #d97706;
  background: #fff7e6;
}
.cl-mute {
  color: #86909c;
  background: #f2f3f5;
}

.empty {
  text-align: center;
  padding: 80rpx 0;
  color: #a6abb3;
  font-size: 25rpx;
}
.load-more {
  text-align: center;
  padding: 20rpx 0;
  color: #a6abb3;
  font-size: 22rpx;
}

.skeleton {
  padding: 20rpx;
}
.sk-line {
  height: 26rpx;
  border-radius: 6rpx;
  background: #f2f3f5;
  margin-bottom: 14rpx;
}
.sk-line.w40 { width: 40%; }
.sk-line.w80 { width: 80%; }
</style>