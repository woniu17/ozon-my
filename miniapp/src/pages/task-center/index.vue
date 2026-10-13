<template>
  <view class="page">
    <!-- Tab 切换 -->
    <scroll-view class="tabs" scroll-x :show-scrollbar="false">
      <view class="tabs-inner">
        <view
          v-for="t in TABS"
          :key="t.key"
          class="tab"
          :class="{ on: activeTab === t.key }"
          @click="switchTab(t.key)"
        >{{ t.label }}</view>
      </view>
    </scroll-view>

    <!-- 状态筛选 -->
    <scroll-view class="filters" scroll-x :show-scrollbar="false">
      <view class="filters-inner">
        <view
          v-for="f in STATUS_FILTERS"
          :key="f.value"
          class="filter-chip"
          :class="{ on: view.filterStatus === f.value }"
          @click="setFilter(f.value)"
        >{{ f.label }}</view>
      </view>
    </scroll-view>

    <view v-if="error" class="error-bar">{{ error }}</view>

    <!-- 任务列表 -->
    <view class="list">
      <template v-if="view.loading && !view.items.length">
        <view v-for="i in 4" :key="i" class="card skeleton">
          <view class="sk-line w40"></view>
          <view class="sk-line w80"></view>
          <view class="sk-line w60"></view>
        </view>
      </template>

      <template v-else-if="!view.items.length">
        <view class="empty">暂无任务</view>
      </template>

      <template v-else>
        <view
          v-for="t in view.items"
          :key="t.localTaskId"
          class="card"
          @click="onTapTask(t)"
        >
          <!-- ═══ 导出任务卡片 ═══ -->
          <template v-if="activeTab === 'export'">
            <view class="card-head">
              <text class="status-badge" :class="'st-' + t.status">{{ statusInfo(t.status).label }}</text>
              <text class="task-name" :title="t.name || ''">{{ t.name || t.localTaskId }}</text>
            </view>
            <view class="card-grid">
              <view class="cg-item"><text class="k">导出</text><text class="v" :class="{ warn: (Number(t.totalCount) || 0) < (Number(t.requestedCount) || 0) }">{{ t.totalCount ?? 0 }}/{{ t.requestedCount ?? 0 }}</text></view>
              <view class="cg-item"><text class="k">市场统计</text><text class="v">{{ t.marketStatsCount ?? 0 }}({{ t.marketStatsRatio ?? 0 }}%)</text></view>
              <view class="cg-item"><text class="k">来源卖家</text><text class="v">{{ t.sellerCount ?? 0 }}</text></view>
              <view class="cg-item"><text class="k">跳过</text><text class="v">{{ t.skippedCount ?? 0 }}</text></view>
              <view class="cg-item"><text class="k">下载次数</text><text class="v">{{ t.downloadCount ?? 0 }}</text></view>
            </view>
            <view class="card-foot">
              <text class="time">{{ fmtTime(t.createdAt) }}</text>
              <button
                class="mini-btn primary"
                :disabled="downloading === t.localTaskId"
                @click.stop="onDownload(t)"
              >{{ downloading === t.localTaskId ? '下载中…' : '下载 Excel' }}</button>
            </view>
          </template>

          <!-- ═══ 其他任务卡片 ═══ -->
          <template v-else>
            <view class="card-head">
              <text class="status-badge" :class="'st-' + t.status">{{ statusInfo(t.status).label }}</text>
              <text class="task-id">{{ shortId(t.localTaskId) }}</text>
              <text v-if="t.storeIds && t.storeIds.length > 1" class="store multi">多店铺({{ t.storeIds.length }})</text>
              <text v-else class="store">{{ storeName(t.storeId) }}</text>
            </view>
            <view class="card-grid">
              <view class="cg-item"><text class="k">来源</text><text class="v">{{ sourceLabel(t.sourceType) }}</text></view>
              <view class="cg-item"><text class="k">总数</text><text class="v">{{ t.totalCount ?? 0 }}</text></view>
              <view class="cg-item"><text class="k">成功</text><text class="v ok">{{ t.successCount ?? 0 }}</text></view>
              <view class="cg-item"><text class="k">失败</text><text class="v" :class="{ err: (Number(t.failedCount) || 0) > 0 }">{{ t.failedCount ?? 0 }}</text></view>
            </view>
            <view class="card-foot">
              <text class="time">创建 {{ fmtTime(t.createdAt) }}</text>
              <text v-if="t.completedAt" class="time">完成 {{ fmtTime(t.completedAt) }}</text>
            </view>
            <view v-if="t.errorMessage" class="err-msg">{{ t.errorMessage }}</view>
          </template>
        </view>

        <view v-if="view.loadingMore" class="load-more">加载中…</view>
        <view v-else-if="view.finished" class="load-more">没有更多了</view>
      </template>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onLoad, onPullDownRefresh, onReachBottom } from '@dcloudio/uni-app';
import {
  getImageRefreshList,
  getStockRefreshList,
  getProductUpdateList,
  getProductArchiveList,
  getExportTaskList,
  getStores,
  downloadExportExcel,
} from '../../api/task-center.js';
import { fmtTime } from '../../utils/fmt.js';

const TABS = [
  { key: 'image', label: '图片更新' },
  { key: 'stock', label: '库存更新' },
  { key: 'product', label: '商品更新' },
  { key: 'archive', label: '归档' },
  { key: 'export', label: '导出' },
];

const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'PENDING', label: '待处理' },
  { value: 'RUNNING', label: '进行中' },
  { value: 'SUCCESS', label: '成功' },
  { value: 'PARTIAL', label: '部分成功' },
  { value: 'FAILED', label: '失败' },
];

const STATUS_BADGE = {
  PENDING: { label: '待处理' },
  RUNNING: { label: '进行中' },
  SUCCESS: { label: '成功' },
  FAILED: { label: '失败' },
  PARTIAL: { label: '部分成功' },
};

const SOURCE_LABEL = {
  manual: '手动',
  batch: '批量',
  auto: '自动',
  filter: '按筛选',
};

const PAGE_SIZE = 15;
const activeTab = ref('image');
const error = ref('');
const downloading = ref('');
const storesMap = reactive({});

function makeView() {
  return {
    items: [],
    page: 0,
    total: 0,
    loading: false,
    loadingMore: false,
    finished: false,
    loaded: false,
    filterStatus: '',
  };
}

const views = reactive({
  image: makeView(),
  stock: makeView(),
  product: makeView(),
  archive: makeView(),
  export: makeView(),
});

const view = computed(() => views[activeTab.value]);

const API_MAP = {
  image: getImageRefreshList,
  stock: getStockRefreshList,
  product: getProductUpdateList,
  archive: getProductArchiveList,
  export: getExportTaskList,
};

function statusInfo(st) {
  if (!st) return { label: '—' };
  return STATUS_BADGE[st] || { label: st };
}

function sourceLabel(s) {
  return SOURCE_LABEL[s] || s || '—';
}

function shortId(id) {
  if (!id) return '—';
  const s = String(id);
  return s.length > 24 ? s.slice(0, 24) + '…' : s;
}

function storeName(storeId) {
  if (storeId == null || storeId === '') return '—';
  const s = storesMap[String(storeId)];
  return s || String(storeId);
}

async function loadStores() {
  try {
    const list = await getStores();
    if (Array.isArray(list)) {
      for (const s of list) storesMap[String(s.id)] = s.name || String(s.id);
    }
  } catch (_) {
    /* 店铺名映射失败不影响任务列表 */
  }
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
      currentPage: v.page,
      pageSize: PAGE_SIZE,
      status: v.filterStatus,
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

function setFilter(val) {
  const v = view.value;
  if (v.filterStatus === val) return;
  v.filterStatus = val;
  loadList(true);
}

async function onDownload(t) {
  downloading.value = t.localTaskId;
  try {
    await downloadExportExcel(t.localTaskId);
    t.downloadCount = (Number(t.downloadCount) || 0) + 1;
    uni.showToast({ title: '已开始下载', icon: 'none' });
  } catch (e) {
    uni.showToast({ title: e.message || '下载失败', icon: 'none', duration: 2500 });
  } finally {
    downloading.value = '';
  }
}

// 点击任务卡片:复制任务ID,方便到 Web 端查看详情
function onTapTask(t) {
  if (!t.localTaskId) return;
  uni.setClipboardData({ data: t.localTaskId });
}

onLoad(() => {
  loadStores();
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
  white-space: nowrap;
}
.tabs-inner {
  display: inline-flex;
  padding: 4rpx 2rpx;
}
.tab {
  font-size: 26rpx;
  color: #4e5969;
  background: #ffffff;
  border-radius: 999rpx;
  padding: 10rpx 26rpx;
  margin-right: 12rpx;
}
.tab.on {
  color: #ffffff;
  background: #165dff;
  font-weight: 600;
}

.filters {
  margin-top: 12rpx;
  white-space: nowrap;
}
.filters-inner {
  display: inline-flex;
  padding: 4rpx 2rpx;
}
.filter-chip {
  font-size: 22rpx;
  color: #4e5969;
  background: #f2f3f5;
  border-radius: 999rpx;
  padding: 6rpx 18rpx;
  margin-right: 10rpx;
}
.filter-chip.on {
  color: #165dff;
  background: #eef4ff;
  font-weight: 600;
}

.error-bar {
  margin-top: 12rpx;
  font-size: 24rpx;
  color: #f53f3f;
  background: #ffece8;
  padding: 12rpx 16rpx;
  border-radius: 10rpx;
}

.list {
  margin-top: 16rpx;
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
}
.status-badge {
  font-size: 20rpx;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
  margin-right: 12rpx;
  flex-shrink: 0;
}
.st-PENDING { color: #d97706; background: #fff7e6; }
.st-RUNNING { color: #165dff; background: #eef4ff; }
.st-SUCCESS { color: #00b42a; background: #e8ffea; }
.st-FAILED { color: #f53f3f; background: #ffece8; }
.st-PARTIAL { color: #d97706; background: #fff7e6; }

.task-id {
  flex: 1;
  font-family: 'Courier New', monospace;
  font-size: 23rpx;
  color: #1f2329;
}
.task-name {
  flex: 1;
  font-size: 26rpx;
  font-weight: 600;
  color: #1f2329;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.store {
  font-size: 21rpx;
  color: #86909c;
  margin-left: 8rpx;
}
.store.multi {
  color: #165dff;
  font-weight: 600;
}

.card-grid {
  margin-top: 14rpx;
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
}
.cg-item {
  flex: 1 1 calc(50% - 6rpx);
  font-size: 23rpx;
  color: #4e5969;
}
.cg-item .k {
  color: #86909c;
  margin-right: 6rpx;
}
.cg-item .v.ok { color: #00b42a; }
.cg-item .v.err { color: #f53f3f; font-weight: 600; }
.cg-item .v.warn { color: #d97706; font-weight: 600; }

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

.mini-btn {
  font-size: 23rpx;
  padding: 8rpx 22rpx;
  border-radius: 8rpx;
  background: #f2f3f5;
  color: #1f2329;
  line-height: 1.4;
  margin: 0;
}
.mini-btn.primary {
  background: #165dff;
  color: #ffffff;
}
.mini-btn[disabled] {
  opacity: 0.6;
}

.err-msg {
  margin-top: 10rpx;
  font-size: 21rpx;
  color: #f53f3f;
  background: #ffece8;
  border-radius: 8rpx;
  padding: 8rpx 12rpx;
  word-break: break-all;
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
.sk-line.w60 { width: 60%; }
</style>