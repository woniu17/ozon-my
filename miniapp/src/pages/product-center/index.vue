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
        placeholder="搜索 SKU / 商品名 / offer_id"
        placeholder-class="ph"
        confirm-type="search"
        @confirm="doSearch"
      />
      <text v-if="keyword" class="search-clear" @click="clearSearch">×</text>
      <view class="search-btn" @click="doSearch">查询</view>
    </view>

    <view v-if="error" class="error-bar">{{ error }}</view>

    <view v-if="view.total" class="count-hint">共 {{ view.total }} 条记录</view>

    <!-- ═══ 商品列表 ═══ -->
    <template v-if="activeTab === 'product'">
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
            <view class="prod-row">
              <image v-if="it.image" class="prod-img" :src="it.image" mode="aspectFill" lazy-load @click="previewImg(it.image)" />
              <view v-else class="prod-img"></view>
              <view class="prod-main">
                <view class="prod-title">{{ it.name || '—' }}</view>
                <view class="prod-sub">
                  <text class="sku" @click="copyText(it.sku, 'SKU')">{{ it.sku }}</text>
                  <text v-if="it.offerId && it.offerId !== it.sku" class="offer-id">{{ it.offerId }}</text>
                </view>
                <view class="prod-tags">
                  <text class="status-badge" :class="'ps-' + it.productStatus">{{ statusInfo(it.productStatus).label }}</text>
                  <text v-if="it.hasImageError" class="tag-warn-badge">图片问题</text>
                  <text v-if="it.descriptionQuality != null && it.descriptionQuality > 0" class="dq-badge" :class="'dq-' + it.descriptionQuality">{{ dqLabel(it.descriptionQuality) }}</text>
                </view>
              </view>
              <view class="prod-price">{{ fmtPrice(it.price, it.currency) }}</view>
            </view>
            <view class="card-grid">
              <view class="cg-item"><text class="k">库存</text><text class="v" :class="it.hasStock ? 'ok' : 'muted'">{{ it.hasStock ? (it.stockPresent || '有') : '无' }}</text></view>
              <view class="cg-item"><text class="k">销量</text><text class="v">{{ it.salesQty ?? 0 }}{{ it.salesQty30d ? ' (30d ' + it.salesQty30d + ')' : '' }}</text></view>
              <view class="cg-item"><text class="k">重量</text><text class="v">{{ fmtWeight(it.customWeightG ?? it.weightG) }}</text></view>
              <view class="cg-item"><text class="k">类目</text><text class="v ellipsis">{{ it.categoryName || it.typeName || '—' }}</text></view>
            </view>
            <view class="card-foot">
              <text class="time">同步 {{ fmtUtc(it.fetchedAt) }}</text>
              <text v-if="(Number(it.statusErrors?.length) || 0) > 0" class="err-text" @click="showErrors(it)">{{ it.statusErrors.length }} 个状态错误</text>
            </view>
          </view>
          <view v-if="view.loadingMore" class="load-more">加载中…</view>
          <view v-else-if="view.finished" class="load-more">没有更多了</view>
        </template>
      </view>
    </template>

    <!-- ═══ 采集箱 ═══ -->
    <template v-else>
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
            <view class="prod-row">
              <image v-if="it.primaryImage" class="prod-img" :src="it.primaryImage" mode="aspectFill" lazy-load @click="previewImg(it.primaryImage)" />
              <view v-else class="prod-img"></view>
              <view class="prod-main">
                <view class="prod-title">{{ it.name || '—' }}</view>
                <view class="prod-sub">
                  <text class="sku" @click="copyText(it.sku, 'SKU')">{{ it.sku }}</text>
                  <text v-if="it.ratingCount != null" class="rating">⭐ {{ it.ratingCount }}</text>
                </view>
                <view class="hit-line">
                  <text class="hit-badge" :class="hitCls(it.cacheHits?.dom)">Dom{{ it.cacheHits?.dom ? '✓' : '—' }}</text>
                  <text class="hit-badge" :class="hitCls(it.cacheHits?.attribute)">Attr{{ it.cacheHits?.attribute ? '✓' : '—' }}</text>
                  <text class="hit-badge" :class="hitCls(it.cacheHits?.richMedia)">媒体{{ it.cacheHits?.richMedia ? '✓' : '—' }}</text>
                  <text class="hit-badge" :class="hitCls(it.cacheHits?.marketStats)">市场{{ it.cacheHits?.marketStats ? '✓' : '—' }}</text>
                  <text class="hit-badge" :class="hitCls(it.cacheHits?.followSell)">跟卖{{ it.cacheHits?.followSell ? '✓' : '—' }}</text>
                </view>
              </view>
              <view class="prod-price">{{ fmtPrice(it.price, '₽') }}</view>
            </view>
            <view class="card-grid">
              <view class="cg-item"><text class="k">命中</text><text class="v">{{ it.hitCount ?? 0 }}/5</text></view>
              <view class="cg-item"><text class="k">竞品</text><text class="v">{{ it.competitorCount ?? '—' }}</text></view>
              <view class="cg-item"><text class="k">市场P50</text><text class="v">{{ it.marketPriceP50 != null ? it.marketPriceP50 : '—' }}</text></view>
              <view class="cg-item"><text class="k">视频</text><text class="v">{{ it.hasVideo ? '有' : '无' }}</text></view>
            </view>
            <view class="card-foot">
              <text class="seller">{{ it.sellerName || it.sellerSlug || it.sellerId || '—' }}</text>
              <view class="foot-right">
                <text v-if="it.listed" class="listed-tag">已上架</text>
                <text v-if="it.exported" class="exported-tag">已导出</text>
                <text class="time">采集 {{ fmtUtc(it.lastCollectedAt) }}</text>
              </view>
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
import { getProducts, getCollectBoxList } from '../../api/products.js';

const TABS = [
  { key: 'product', label: '商品列表' },
  { key: 'collect', label: '采集箱' },
];

const PAGE_SIZE = 20;
const activeTab = ref('product');
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
  product: makeView(),
  collect: makeView(),
});

const view = computed(() => views[activeTab.value]);

const API_MAP = {
  product: getProducts,
  collect: getCollectBoxList,
};

const PRODUCT_STATUS = {
  saleable: { label: '在售' },
  created_no_stock: { label: '无库存' },
  pending_creation: { label: '待创建' },
  rejected: { label: '被拒' },
  other: { label: '其他' },
};

function statusInfo(st) {
  return PRODUCT_STATUS[st] || { label: st || '—' };
}

const DQ_LABELS = { 1: '空描述', 2: '按钮污染', 3: '描述正常' };
function dqLabel(v) {
  return DQ_LABELS[v] || ('描述' + v);
}

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
  try {
    const data = await fn({
      keyword: keyword.value.trim(),
      currentPage: v.page,
      pageSize: PAGE_SIZE,
    });
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

// ── 辅助 ─────────────────────────────────────────────────
function fmtPrice(price, currency) {
  if (price == null || price === '') return '—';
  const n = Number(price);
  if (!Number.isFinite(n)) return String(price);
  const sym = currency === 'CNY' || currency === '¥' ? '¥' : currency === '₽' || currency === 'RUB' ? '₽' : (currency || '');
  return sym + n.toFixed(2);
}

function fmtWeight(g) {
  if (g == null || !Number(g)) return '—';
  const n = Number(g);
  return n >= 1000 ? (n / 1000).toFixed(2) + 'kg' : Math.round(n) + 'g';
}

function fmtUtc(t) {
  if (t == null || t === '') return '—';
  let d;
  if (typeof t === 'number') d = new Date(t);
  else {
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

function hitCls(hit) {
  return hit ? 'hit-on' : 'hit-off';
}

function copyText(text, label) {
  if (!text) return;
  uni.setClipboardData({
    data: String(text),
    success: () => uni.showToast({ title: `${label}已复制`, icon: 'none' }),
  });
}

function previewImg(url) {
  if (!url) return;
  uni.previewImage({ urls: [url], current: url });
}

function showErrors(it) {
  const errs = Array.isArray(it.statusErrors) ? it.statusErrors : [];
  const text = errs.map((e) => `${e.codeCn || e.code || ''}${e.attributeName ? ' · ' + e.attributeName : ''}${e.description ? '\n' + e.description : ''}`).join('\n\n');
  uni.showModal({ title: `状态错误 (${errs.length})`, content: text || '无详情', showCancel: false });
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
.prod-row {
  display: flex;
  align-items: flex-start;
}
.prod-img {
  width: 110rpx;
  height: 110rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
  flex-shrink: 0;
  margin-right: 16rpx;
}
.prod-main {
  flex: 1;
  min-width: 0;
}
.prod-title {
  font-size: 26rpx;
  color: #1f2329;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.prod-sub {
  margin-top: 6rpx;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.sku {
  font-family: 'Courier New', monospace;
  font-size: 21rpx;
  color: #165dff;
}
.offer-id {
  font-family: 'Courier New', monospace;
  font-size: 19rpx;
  color: #a6abb3;
  margin-left: 10rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200rpx;
}
.rating {
  font-size: 20rpx;
  color: #d97706;
  margin-left: 10rpx;
}
.prod-tags {
  margin-top: 8rpx;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8rpx;
}
.status-badge {
  font-size: 19rpx;
  padding: 3rpx 12rpx;
  border-radius: 999rpx;
}
.ps-saleable { color: #00b42a; background: #e8ffea; }
.ps-created_no_stock { color: #d97706; background: #fff7e6; }
.ps-pending_creation { color: #165dff; background: #eef4ff; }
.ps-rejected { color: #f53f3f; background: #ffece8; }
.ps-other { color: #86909c; background: #f2f3f5; }
.tag-warn-badge {
  font-size: 19rpx;
  color: #f53f3f;
  background: #ffece8;
  border-radius: 999rpx;
  padding: 3rpx 12rpx;
}
.dq-badge {
  font-size: 19rpx;
  border-radius: 999rpx;
  padding: 3rpx 12rpx;
}
.dq-1 { color: #d97706; background: #fff7e6; }
.dq-2 { color: #f53f3f; background: #ffece8; }
.dq-3 { color: #00b42a; background: #e8ffea; }

.prod-price {
  font-size: 26rpx;
  font-weight: 600;
  color: #1f2329;
  margin-left: 12rpx;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.card-grid {
  margin-top: 12rpx;
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
  border-top: 1rpx solid #f7f8fa;
  padding-top: 12rpx;
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
.cg-item .v.ok { color: #00b42a; }
.cg-item .v.muted { color: #a6abb3; }
.cg-item .v.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180rpx;
  display: inline-block;
  vertical-align: bottom;
}

.card-foot {
  margin-top: 10rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.time {
  font-size: 20rpx;
  color: #86909c;
}
.err-text {
  font-size: 20rpx;
  color: #f53f3f;
}
.seller {
  font-size: 20rpx;
  color: #4e5969;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.foot-right {
  display: flex;
  align-items: center;
  gap: 8rpx;
}
.listed-tag {
  font-size: 18rpx;
  color: #00b42a;
  background: #e8ffea;
  border-radius: 999rpx;
  padding: 3rpx 10rpx;
}
.exported-tag {
  font-size: 18rpx;
  color: #165dff;
  background: #eef4ff;
  border-radius: 999rpx;
  padding: 3rpx 10rpx;
}

.hit-line {
  margin-top: 8rpx;
  display: flex;
  flex-wrap: wrap;
  gap: 6rpx;
}
.hit-badge {
  font-size: 18rpx;
  border-radius: 6rpx;
  padding: 3rpx 8rpx;
}
.hit-on {
  color: #00b42a;
  background: #e8ffea;
}
.hit-off {
  color: #c9cdd4;
  background: #f7f8fa;
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