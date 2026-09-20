<template>
  <view class="page">
    <!-- 顶部固定区:搜索 + tabs -->
    <view class="top-bar">
      <view class="search-box">
        <input
          class="search-input"
          v-model="keyword"
          placeholder="搜索:货件号 / SKU / 采购单号 / 标签"
          placeholder-class="ph"
          confirm-type="search"
          @confirm="doSearch"
        />
        <text v-if="keyword" class="search-clear" @click="clearSearch">×</text>
      </view>
      <view v-if="globalActive" class="global-hint">
        <text class="global-text">全局搜索"{{ keyword }}" 命中 {{ total }} 单</text>
        <text class="global-exit" @click="clearSearch">退出</text>
      </view>
      <scroll-view
        class="tabs"
        scroll-x
        :scroll-into-view="'tab-' + activeTab"
        :show-scrollbar="false"
      >
        <view class="tabs-inner">
          <view
            v-for="t in TABS"
            :key="t.key"
            :id="'tab-' + t.key"
            class="tab"
            :class="{ on: activeTab === t.key }"
            @click="switchTab(t.key)"
          >
            <text>{{ t.label }}</text>
            <text class="tab-cnt">{{ tabCounts[t.key] ?? 0 }}</text>
          </view>
        </view>
      </scroll-view>

      <!-- 排序(与 web 端同步):按 tab 动态显示可用排序键;各 tab 独立记忆 -->
      <view class="sort-bar">
        <picker mode="selector" :range="sortLabels" @change="onSortPick">
          <view class="sort-chip">排序:{{ currentSortLabel }} ▾</view>
        </picker>
        <text class="sort-hint">揽收=国际物流商揽收,无此时间排最后</text>
      </view>
    </view>

    <!-- 订单卡片流 -->
    <view class="list">
      <view v-for="pkg in rows" :key="pkg.id" class="card" @click="goDetail(pkg)">
        <view class="card-head">
          <text class="store">{{ pkg.storeName }}</text>
          <template v-if="isQcPosting(pkg.postingNumber)">
            <text class="qc-badge">质检单</text>
            <text class="posting qc">{{ pkg.postingNumber }}</text>
          </template>
          <text v-else class="posting">{{ pkg.postingNumber }}</text>
          <text v-if="pkg.parentId" class="split-badge child">子件</text>
          <text v-else-if="pkg.hasChildren" class="split-badge mother">母件</text>
          <text class="op-tag" :class="'op-' + opTag(pkg).cls">{{ opTag(pkg).label }}</text>
        </view>

        <view v-if="pkg.tags && pkg.tags.length" class="tags-line">
          <text v-for="t in pkg.tags.slice(0, 4)" :key="t" class="tag-chip">{{ t }}</text>
        </view>

        <view v-for="(it, i) in pkg.items" :key="i" class="prod">
          <image v-if="it.picUrl" class="prod-img" :src="it.picUrl" mode="aspectFill" lazy-load @click.stop="previewImg(pkg, it)" />
          <view v-else class="prod-img"></view>
          <view class="prod-main">
            <view class="prod-title">{{ it.title || '—' }}</view>
            <view class="prod-sub">
              <text v-if="it.sku" class="sku" @click.stop="searchBySku(it.sku)">{{ it.sku }}</text>
              <text class="qty" :class="{ 'qty-multi': (Number(it.quantity) || 0) > 1 }">×{{ it.quantity }}</text>
            </view>
          </view>
          <view class="prod-price">{{ fmtMoney(it.price) }}</view>
        </view>

        <view class="card-foot">
          <text class="p-tag" :class="pkg.purchaseStatus === 'none' ? 'p-none' : 'p-ok'">
            {{ pkg.purchaseStatus === 'none' ? '未采购' : '已采购' }}
          </text>
          <text v-if="pkg.arrivedAt" class="p-tag p-arr">已到货</text>
          <view class="foot-amts">
            <text class="amt">订单 {{ fmtMoney(pkg.orderAmount) }}</text>
            <text class="amt">采购 {{ fmtMoney(pkg.totalPurchaseAmount) }}</text>
            <text class="amt muted">{{ pkg.weightG != null ? Math.floor(pkg.weightG) + 'g' : '—' }}</text>
          </view>
        </view>
      </view>

      <view v-if="loading && !rows.length" class="empty">加载中…</view>
      <view v-if="!loading && !rows.length" class="empty">
        {{ globalActive ? '全局搜索未命中包裹' : '暂无订单' }}
      </view>
      <view v-if="rows.length && rows.length >= total" class="end-tip">
        — 共 {{ total }} 单,已全部加载 —
      </view>
      <view v-if="loadingMore" class="end-tip">加载中…</view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onUnload, onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app';
import { getOrderTabs, getOrderList } from '../../api/order.js';
import { fmtMoney } from '../../utils/fmt.js';

// Tab 页签(与 web 端 OrderProcess.vue TABS 同步)
const TABS = [
  { key: 'all', label: '全部' },
  { key: 'waitProcess', label: '待处理' },
  { key: 'waitShip', label: '待打单发货' },
  { key: 'shipSuccess', label: '交运' },
  { key: 'waitReceiverConfirm', label: '已发货' },
  { key: 'signed', label: '已签收' },
  { key: 'settled', label: '已成功' },
  { key: 'returned', label: '已退货' },
  { key: 'cancelled', label: '已取消' },
  { key: 'ignored', label: '已搁置' },
];

const PAGE_SIZE = 20;

const activeTab = ref('waitProcess');
const tabCounts = ref({});
const keyword = ref('');
const globalActive = ref(false);
const globalMode = ref('ss'); // 'ss' 模糊 | 'eq' 精确(点击 SKU 时用)
const rows = ref([]);
const page = ref(1);
const total = ref(0);
const loading = ref(false);
const loadingMore = ref(false);

// ── 排序(与 web 端 OrderProcess.vue 同步,2026-09-20)──────────
// key 对应后端 sortBy 白名单;delivering=揽收时间(国际物流商揽收)
// 发货前取消的单无揽收时间,后端 NULLS LAST 排最后
const SORT_OPTIONS = {
  order_desc: { key: 'order', label: '下单时间 新→旧' },
  order_asc: { key: 'order', label: '下单时间 旧→新' },
  delivering_desc: { key: 'delivering', label: '揽收时间 新→旧' },
  delivering_asc: { key: 'delivering', label: '揽收时间 旧→新' },
  return_desc: { key: 'return', label: '退货时间 新→旧' },
  return_asc: { key: 'return', label: '退货时间 旧→新' },
  delivered_desc: { key: 'delivered', label: '签收时间 新→旧' },
  delivered_asc: { key: 'delivered', label: '签收时间 旧→新' },
};
// 各 tab 可用排序键(与 web 端 TAB_SORT_KEYS 一致):
// 揽收排序适用所有状态(除待处理/待打单/交运——货件尚未被物流商揽收)
// 退货排序:已签收/已成功/已取消/已退货;签收排序:已签收/已成功(delivered_at 100% 覆盖)
const TAB_SORT_KEYS = {
  all: ['order', 'delivering'],
  waitProcess: ['order'],
  waitShip: ['order'],
  shipSuccess: ['order'],
  waitReceiverConfirm: ['order', 'delivering'],
  signed: ['order', 'delivering', 'return', 'delivered'],
  settled: ['order', 'delivering', 'return', 'delivered'],
  returned: ['order', 'delivering', 'return'],
  cancelled: ['order', 'delivering', 'return'],
  ignored: ['order', 'delivering'],
};
// 各 tab 独立记住排序选择:切 tab 恢复该 tab 上次选择,storage 持久化
const SORT_PREF_KEY = 'op_sort_pref_v1';
let savedSortPref = {};
try { savedSortPref = JSON.parse(uni.getStorageSync(SORT_PREF_KEY) || '{}') || {}; } catch (e) { /* 忽略损坏数据 */ }
const tabSort = ref(savedSortPref);
// 当前 tab 的排序值;保存值不可用(键被裁撤)时回退默认
const currentSort = computed(() => {
  const val = tabSort.value[activeTab.value];
  const keys = TAB_SORT_KEYS[activeTab.value] || ['order'];
  return val && SORT_OPTIONS[val] && keys.includes(SORT_OPTIONS[val].key) ? val : 'order_desc';
});
const currentSortLabel = computed(() => SORT_OPTIONS[currentSort.value].label);
const sortLabels = computed(() => {
  const keys = TAB_SORT_KEYS[activeTab.value] || ['order'];
  return Object.entries(SORT_OPTIONS).filter(([, v]) => keys.includes(v.key)).map(([, v]) => v.label);
});
function onSortPick(e) {
  const keys = TAB_SORT_KEYS[activeTab.value] || ['order'];
  const opts = Object.entries(SORT_OPTIONS).filter(([, v]) => keys.includes(v.key));
  const opt = opts[Number(e.detail.value)];
  if (!opt) return;
  tabSort.value = { ...tabSort.value, [activeTab.value]: opt[0] };
  try { uni.setStorageSync(SORT_PREF_KEY, JSON.stringify(tabSort.value)); } catch (e2) { /* 存储满等异常忽略 */ }
  reload().catch(() => {});
}

// 行级操作状态徽标(与 web 端 OPERATE_LABELS 同步;isReturned 优先显示退货)
const OPERATE_LABELS = {
  wait_process: { label: '待处理', cls: 'warn' },
  wait_ship: { label: '待打单', cls: 'info' },
  ship_success: { label: '交运', cls: 'info' },
  wait_receiver_confirm: { label: '已发货', cls: 'ok' },
  cancelled: { label: '已取消', cls: 'err' },
};
function opTag(pkg) {
  if (pkg.isReturned) return { label: '已退货', cls: 'err' };
  return OPERATE_LABELS[pkg.operateStatus] || { label: pkg.operateStatus || '—', cls: 'mute' };
}

async function loadTabs() {
  try {
    tabCounts.value = (await getOrderTabs()) || {};
  } catch (e) {
    /* 静默:错误 toast 已由 request.js 统一弹出 */
  }
}

async function loadList() {
  loading.value = true;
  const isGlobal = globalActive.value && keyword.value.trim();
  // 排序值取当前 tab 记住的选择(与 web 端一致):order_desc → sortBy=order + sortOrder=desc
  const [sortBy, sortOrder] = currentSort.value.split('_');
  try {
    const data = await getOrderList({
      tab: activeTab.value,
      globalKeyword: isGlobal ? keyword.value.trim() : '',
      globalMode: globalMode.value,
      sortBy,
      sortOrder,
      page: page.value,
      pageSize: PAGE_SIZE,
    });
    const list = data?.packages || [];
    rows.value = page.value === 1 ? list : rows.value.concat(list);
    total.value = data?.total || 0;
  } catch (e) {
    if (page.value === 1) rows.value = [];
    throw e; // 交调用方处理(触底加载回退页码)
  } finally {
    loading.value = false;
  }
}

function reload() {
  page.value = 1;
  return loadList();
}

function switchTab(key) {
  if (activeTab.value === key) return;
  activeTab.value = key;
  // 全局搜索模式下切 tab = 退出全局模式回到该 tab 视图(与 web 端一致)
  keyword.value = '';
  globalActive.value = false;
  globalMode.value = 'ss';
  reload().catch(() => {});
}

function doSearch() {
  const kw = keyword.value.trim();
  if (!kw) {
    if (globalActive.value) clearSearch();
    return;
  }
  globalActive.value = true;
  globalMode.value = 'ss';
  reload().catch(() => {});
}

function clearSearch() {
  keyword.value = '';
  globalActive.value = false;
  globalMode.value = 'ss';
  reload().catch(() => {});
}

// 点击 SKU:全局精确搜索该 SKU 的相关订单(跨所有状态,与 web 端一致)
function searchBySku(sku) {
  const kw = String(sku || '').trim();
  if (!kw) return;
  keyword.value = kw;
  globalActive.value = true;
  globalMode.value = 'eq';
  reload().catch(() => {});
}

function goDetail(pkg) {
  uni.navigateTo({ url: '/pages/order-detail/index?id=' + pkg.id });
}

// 质检单货件号(02131/024785 开头,与 web 端 isQcPosting 同口径):红色徽标 + 红色加粗货件号
function isQcPosting(sn) {
  const s = String(sn || '');
  return s.startsWith('02131') || s.startsWith('024785');
}

// 点击商品图:预览大图(该包裹全部商品图可左右切换)
function previewImg(pkg, it) {
  const urls = (pkg.items || []).map((x) => x.picUrl).filter(Boolean);
  if (!urls.length) return;
  uni.previewImage({ current: it.picUrl, urls });
}

// 详情页操作(备货/同步)成功后通知刷新(tab 计数 + 列表重置第 1 页)
function onOrdersRefresh() {
  loadTabs();
  reload().catch(() => {});
}

onLoad(async () => {
  uni.$on('orders-refresh', onOrdersRefresh);
  loadTabs();
  try {
    await reload();
  } catch (e) {
    /* 首屏失败已 toast */
  }
});

onUnload(() => {
  uni.$off('orders-refresh', onOrdersRefresh);
});

// 下拉刷新:tabs 计数 + 列表重置第 1 页
onPullDownRefresh(async () => {
  try {
    await Promise.all([loadTabs(), reload()]);
  } catch (e) {
    /* 已 toast */
  } finally {
    uni.stopPullDownRefresh();
  }
});

// 上拉触底:加载下一页
onReachBottom(async () => {
  if (loading.value || loadingMore.value) return;
  if (rows.value.length >= total.value) return;
  loadingMore.value = true;
  page.value++;
  try {
    await loadList();
  } catch (e) {
    page.value--; // 失败回退页码,下次触底重试
  } finally {
    loadingMore.value = false;
  }
});
</script>

<style scoped>
.page {
  padding-bottom: 40rpx;
}

/* ── 顶部固定区 ── */
.top-bar {
  position: sticky;
  top: 0;
  z-index: 10;
  background: #f5f6f7;
  padding: 16rpx 24rpx 12rpx;
  box-shadow: 0 4rpx 12rpx rgba(0, 0, 0, 0.04);
}

.search-box {
  display: flex;
  align-items: center;
  background: #ffffff;
  border-radius: 36rpx;
  padding: 0 28rpx;
  height: 72rpx;
}

.search-input {
  flex: 1;
  font-size: 28rpx;
  height: 72rpx;
  line-height: 72rpx;
}

.ph {
  color: #a6abb3;
}

.search-clear {
  padding: 8rpx 4rpx 8rpx 16rpx;
  color: #a6abb3;
  font-size: 36rpx;
  line-height: 1;
}

.global-hint {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14rpx 8rpx 0;
  font-size: 24rpx;
}

.global-text {
  color: #4e5969;
}

.global-exit {
  color: #165dff;
}

/* ── tabs ── */
.tabs {
  margin-top: 12rpx;
  white-space: nowrap;
}

.tabs-inner {
  display: inline-flex;
}

.tab {
  display: inline-flex;
  align-items: center;
  padding: 12rpx 22rpx;
  margin-right: 12rpx;
  border-radius: 12rpx;
  background: #ffffff;
  font-size: 26rpx;
  color: #4e5969;
  flex-shrink: 0;
}

.tab.on {
  background: #165dff;
  color: #ffffff;
}

.tab-cnt {
  margin-left: 8rpx;
  font-size: 22rpx;
  opacity: 0.75;
}

/* ── 排序栏(与 web 端同步) ── */
.sort-bar {
  display: flex;
  align-items: center;
  margin-top: 12rpx;
}

.sort-chip {
  display: inline-flex;
  align-items: center;
  background: #ffffff;
  border-radius: 999rpx;
  padding: 8rpx 22rpx;
  font-size: 24rpx;
  color: #4e5969;
  flex-shrink: 0;
}

.sort-hint {
  margin-left: 16rpx;
  font-size: 20rpx;
  color: #a6abb3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── 卡片流 ── */
.list {
  padding: 20rpx 24rpx 0;
}

.card {
  background: #ffffff;
  border-radius: 18rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.store {
  font-size: 22rpx;
  color: #165dff;
  background: #eef4ff;
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
  margin-right: 12rpx;
}

.posting {
  font-size: 24rpx;
  color: #1f2329;
  font-family: 'Courier New', monospace;
}

/* 质检单货件号(02131/024785 开头):红色加粗显著展示 */
.posting.qc {
  color: #d93026;
  font-weight: 700;
}

.qc-badge {
  flex-shrink: 0;
  font-size: 20rpx;
  color: #d93026;
  border: 2rpx solid #d93026;
  border-radius: 6rpx;
  padding: 0 8rpx;
  line-height: 34rpx;
  margin-right: 8rpx;
  font-weight: 700;
}

.split-badge {
  font-size: 20rpx;
  padding: 2rpx 10rpx;
  border-radius: 6rpx;
  margin-left: 10rpx;
}

.split-badge.child {
  color: #b45309;
  background: #fff7e6;
}

.split-badge.mother {
  color: #4338ca;
  background: #eef2ff;
}

.op-tag {
  margin-left: auto;
  font-size: 22rpx;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
}

.op-warn {
  color: #d97706;
  background: #fff7e6;
}

.op-info {
  color: #165dff;
  background: #eef4ff;
}

.op-ok {
  color: #00b42a;
  background: #e8ffea;
}

.op-err {
  color: #f53f3f;
  background: #ffece8;
}

.op-mute {
  color: #86909c;
  background: #f2f3f5;
}

.tags-line {
  margin-top: 12rpx;
  display: flex;
  flex-wrap: wrap;
}

.tag-chip {
  font-size: 20rpx;
  color: #4e5969;
  background: #f2f3f5;
  padding: 2rpx 12rpx;
  border-radius: 999rpx;
  margin-right: 10rpx;
}

/* ── 产品行 ── */
.prod {
  display: flex;
  align-items: center;
  margin-top: 16rpx;
}

.prod-img {
  width: 140rpx;
  height: 140rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}

.prod-main {
  flex: 1;
  margin-left: 16rpx;
  overflow: hidden;
}

.prod-title {
  font-size: 27rpx;
  color: #1f2329;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.prod-sub {
  margin-top: 6rpx;
  font-size: 22rpx;
  color: #86909c;
  display: flex;
  align-items: center;
}

/* 数量>1:红色加大加粗(与 web 端 qty-multi 同口径) */
.qty-multi {
  color: #dc2626;
  font-weight: 700;
  font-size: 32rpx;
  line-height: 1;
}

.sku {
  color: #165dff;
  margin-right: 16rpx;
}

.prod-price {
  font-size: 24rpx;
  color: #4e5969;
  margin-left: 12rpx;
  flex-shrink: 0;
}

/* ── 卡片底部 ── */
.card-foot {
  margin-top: 18rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid #f2f3f5;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.p-tag {
  font-size: 20rpx;
  padding: 2rpx 12rpx;
  border-radius: 999rpx;
  margin-right: 10rpx;
}

.p-none {
  color: #86909c;
  background: #f2f3f5;
}

.p-ok {
  color: #00b42a;
  background: #e8ffea;
}

.p-arr {
  color: #d97706;
  background: #fff7e6;
}

.foot-amts {
  margin-left: auto;
  display: flex;
  align-items: center;
}

.amt {
  font-size: 22rpx;
  color: #1f2329;
  margin-left: 14rpx;
}

.muted {
  color: #a6abb3;
}

.empty {
  text-align: center;
  padding: 120rpx 0;
  color: #a6abb3;
  font-size: 26rpx;
}

.end-tip {
  text-align: center;
  padding: 24rpx 0;
  color: #a6abb3;
  font-size: 22rpx;
}
</style>
