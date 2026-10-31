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

      <!-- 快速筛选(2026-10-17 与 web/安卓同步):仅待入库 tab;两键可同时启用(并集),显示各自命中数 -->
      <view v-if="activeTab === 'waitStock'" class="quick-bar">
        <text
          class="quick-chip"
          :class="{ on: purchaseUnshippedHours > 0 }"
          @click="toggleQuickFilter('purchase')"
        >采购超24h未发货<text v-if="quickCounts.purchaseUnshipped" class="quick-cnt">({{ quickCounts.purchaseUnshipped }})</text></text>
        <text
          class="quick-chip"
          :class="{ on: logisticsStaleHours > 0 }"
          @click="toggleQuickFilter('logistics')"
        >物流超24h未揽收<text v-if="quickCounts.logisticsStale" class="quick-cnt">({{ quickCounts.logisticsStale }})</text></text>
      </view>

      <!-- 批量录采购(2026-09-28 与 web 端同步):勾选包裹后进入批量关联页 -->
      <view class="batch-bar">
        <view class="batch-chk" @click="toggleSelAll">
          <text>{{ allRowsChecked ? '☑' : '☐' }}</text>
          <text>全选本页</text>
        </view>
        <button class="batch-btn" :disabled="!batchCount" @click="goBatchPurchase">
          批量录采购{{ batchCount ? ' (' + batchCount + ')' : '' }}
        </button>
      </view>
    </view>

    <!-- 订单卡片流 -->
    <view class="list">
      <view v-for="pkg in rows" :key="pkg.id" class="card" @click="goDetail(pkg)">
        <view class="card-head">
          <text class="row-chk" :class="{ on: batchSel.has(pkg.id) }" @click.stop="toggleBatchSel(pkg)">{{ batchSel.has(pkg.id) ? '☑' : '☐' }}</text>
          <text class="store">{{ pkg.storeName }}</text>
          <template v-if="isQcPosting(pkg.postingNumber)">
            <text class="qc-badge">质检单</text>
            <text class="posting qc">{{ pkg.postingNumber }}</text>
            <text class="copy-btn" @click.stop="copyText(pkg.postingNumber, '货件号')"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></text>
          </template>
          <text v-else class="posting">{{ pkg.postingNumber }}<text class="copy-btn" @click.stop="copyText(pkg.postingNumber, '货件号')"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></text></text>
          <text v-if="pkg.parentId" class="split-badge child">子件</text>
          <text v-else-if="pkg.hasChildren" class="split-badge mother">母件</text>
          <view v-if="pkg.isIgnored" class="tag-group">
            <text class="op-tag op-mute">搁置</text>
            <text class="op-tag" :class="'op-' + opTag(pkg).cls">{{ opTag(pkg).label }}</text>
          </view>
          <text v-else class="op-tag" :class="'op-' + opTag(pkg).cls">{{ opTag(pkg).label }}</text>
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

        <!-- 采购物流(2026-10-17):每采购单一行,有单号=公司+单号(点击复制),无单号=灰色"未同步" -->
        <view v-if="pkg.purchaseLinks && pkg.purchaseLinks.length" class="card-logi">
          <view v-for="l in pkg.purchaseLinks" :key="l.id" class="logi-line">
            <text class="logi-label">物流</text>
            <template v-if="l.poLogisticsNo">
              <text v-if="l.poLogisticsCompany" class="logi-company">{{ l.poLogisticsCompany }}</text>
              <text class="logi-no" @click.stop="copyText(l.poLogisticsNo, '物流单号')">{{ l.poLogisticsNo }}</text>
            </template>
            <text v-else class="logi-empty">未同步</text>
          </view>
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

        <!-- 时间行:未交运(有最迟发货时间且非取消)展示下单/最迟/剩发,有利润时显示预估利润 -->
        <view v-if="showShipCountdown(pkg)" class="time-row">
          <view class="t-line">
            <text class="t-k">下单</text>
            <text class="t-v">{{ fmtTime(pkg.inProcessAt) }}<text v-if="weekdayCN(pkg.inProcessAt)" class="t-wd">（{{ weekdayCN(pkg.inProcessAt) }}）</text></text>
          </view>
          <view class="t-line">
            <text class="t-k">最迟</text>
            <text class="t-v">{{ fmtTime(pkg.shipmentDate) }}<text v-if="weekdayCN(pkg.shipmentDate)" class="t-wd">（{{ weekdayCN(pkg.shipmentDate) }}）</text></text>
          </view>
          <view class="t-line" :class="{ overdue: countdown(pkg).overdue }">
            <text class="t-k">{{ countdown(pkg).overdue ? '已超时' : '剩发' }}</text>
            <text class="t-v cd">{{ countdown(pkg).text }}</text>
          </view>
          <view v-if="pkg.profit" class="t-line">
            <text class="t-k">预估利润</text>
            <text class="t-v" :class="profitClass(pkg)">{{ fmtMoney(pkg.profit.profit) }}</text>
          </view>
        </view>

        <!-- 时间行:交运中/集运中/已签收/已成功/已退货 展示下单/集运/签收/退货 + 利润 -->
        <view v-else-if="showShipTimes(pkg)" class="time-row">
          <view class="t-line">
            <text class="t-k">下单</text>
            <text class="t-v">{{ fmtTime(pkg.inProcessAt) }}<text v-if="weekdayCN(pkg.inProcessAt)" class="t-wd">（{{ weekdayCN(pkg.inProcessAt) }}）</text></text>
          </view>
          <view v-if="pkg.deliveringDate" class="t-line">
            <text class="t-k">集运</text>
            <text class="t-v">{{ fmtTime(pkg.deliveringDate) }}<text v-if="weekdayCN(pkg.deliveringDate)" class="t-wd">（{{ weekdayCN(pkg.deliveringDate) }}）</text></text>
          </view>
          <view v-if="pkg.deliveredAt" class="t-line">
            <text class="t-k">签收</text>
            <text class="t-v">{{ fmtTime(pkg.deliveredAt) }}<text v-if="weekdayCN(pkg.deliveredAt)" class="t-wd">（{{ weekdayCN(pkg.deliveredAt) }}）</text></text>
          </view>
          <view v-if="pkg.returnAt" class="t-line">
            <text class="t-k">退货</text>
            <text class="t-v">{{ fmtTime(pkg.returnAt) }}<text v-if="weekdayCN(pkg.returnAt)" class="t-wd">（{{ weekdayCN(pkg.returnAt) }}）</text></text>
          </view>
          <view v-if="pkg.profit" class="t-line">
            <text class="t-k">{{ profitLabel(pkg) }}</text>
            <text class="t-v" :class="profitClass(pkg)">{{ fmtMoney(pkg.profit.profit) }}</text>
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

    <!-- 底部功能导航(参考安卓端排版) -->
    <app-tabbar active="order" />
  </view>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { onLoad, onUnload, onPullDownRefresh, onReachBottom, onShow, onHide } from '@dcloudio/uni-app';
import { getOrderTabs, getOrderList } from '../../api/order.js';
import AppTabbar from '../../components/app-tabbar/app-tabbar.vue';
import { fmtMoney, fmtTime, weekdayCN } from '../../utils/fmt.js';

// Tab 页签(与 web 端 OrderProcess.vue TABS 同步;2026-11 新流程状态名)
// 全部:跨所有状态(含搁置);已成功=已妥投且应计完整;已退货=妥投后买家退货退款(is_returned)
// 待采购 → 待入库 → 待打单 → 待发运 → 交运中 → 集运中 → 已签收 → 已成功
const TABS = [
  { key: 'all', label: '全部' },
  { key: 'waitProcess', label: '待采购' },
  { key: 'waitStock', label: '待入库' },
  { key: 'waitStick', label: '待打单' },
  { key: 'waitDispatch', label: '待发运' },
  { key: 'dispatching', label: '交运中' },
  { key: 'delivering', label: '集运中' },
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

// ── 快速筛选(2026-10-17,与 web/安卓同步):采购超24h未发货 / 物流超24h未揽收,可同时启用(并集) ──
const purchaseUnshippedHours = ref(0);
const logisticsStaleHours = ref(0);
const quickCounts = ref({});
function toggleQuickFilter(kind) {
  if (kind === 'purchase') purchaseUnshippedHours.value = purchaseUnshippedHours.value > 0 ? 0 : 24;
  else logisticsStaleHours.value = logisticsStaleHours.value > 0 ? 0 : 24;
  reload();
}

// ── 批量录采购(2026-09-28 与 web 端同步):行勾选 + 全选本页 + 批量关联入口 ──
const batchSel = ref(new Set());
const batchCount = computed(() => rows.value.filter((r) => batchSel.value.has(r.id)).length);
const allRowsChecked = computed(() => rows.value.length > 0 && rows.value.every((r) => batchSel.value.has(r.id)));
function toggleBatchSel(pkg) {
  const s = new Set(batchSel.value);
  if (s.has(pkg.id)) s.delete(pkg.id);
  else s.add(pkg.id);
  batchSel.value = s;
}
function toggleSelAll() {
  const s = new Set(batchSel.value);
  if (allRowsChecked.value) rows.value.forEach((r) => s.delete(r.id));
  else rows.value.forEach((r) => s.add(r.id));
  batchSel.value = s;
}
function goBatchPurchase() {
  if (!batchSel.value.size) return;
  uni.navigateTo({ url: '/pages/purchase/index?batch=1&ids=' + [...batchSel.value].join(',') });
}

// ── 排序(与 web 端 OrderProcess.vue 同步,2026-09-20)──────────
// key 对应后端 sortBy 白名单;delivering=集运时间(国际物流商集运)
// 发货前取消的单无集运时间,后端 NULLS LAST 排最后
const SORT_OPTIONS = {
  order_desc: { key: 'order', label: '下单时间 新→旧' },
  order_asc: { key: 'order', label: '下单时间 旧→新' },
  delivering_desc: { key: 'delivering', label: '集运时间 新→旧' },
  delivering_asc: { key: 'delivering', label: '集运时间 旧→新' },
  return_desc: { key: 'return', label: '退货时间 新→旧' },
  return_asc: { key: 'return', label: '退货时间 旧→新' },
  delivered_desc: { key: 'delivered', label: '签收时间 新→旧' },
  delivered_asc: { key: 'delivered', label: '签收时间 旧→新' },
  shipped_desc: { key: 'shipped', label: '交运时间 新→旧' },
  shipped_asc: { key: 'shipped', label: '交运时间 旧→新' },
};
// 各 tab 可用排序键(与 web 端 TAB_SORT_KEYS 一致,2026-11 新状态名):
// 集运排序适用所有状态(除待采购/待入库/待打单/待发运/交运中——货件尚未被物流商集运)
// 退货排序:已签收/已成功/已取消/已退货;签收排序:已签收/已成功(delivered_at 100% 覆盖)
// 交运排序:交运中 tab 用(按本地 waybill_printed_at)
const TAB_SORT_KEYS = {
  all: ['order', 'delivering'],
  waitProcess: ['order'],
  waitStock: ['order'],
  waitStick: ['order'],
  waitDispatch: ['order'],
  dispatching: ['order', 'shipped'],
  delivering: ['order', 'delivering'],
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

// 行级操作状态徽标(与 web 端 OPERATE_LABELS 同步;2026-11 新状态名;isReturned 优先显示退货)
const OPERATE_LABELS = {
  wait_process: { label: '待采购', cls: 'warn' },
  wait_stock: { label: '待入库', cls: 'info' },
  wait_stick: { label: '待打单', cls: 'info' },
  wait_dispatch: { label: '待发运', cls: 'info' },
  dispatching: { label: '交运中', cls: 'info' },
  delivering: { label: '集运中', cls: 'ok' },
  signed: { label: '已签收', cls: 'ok' },
  settled: { label: '已成功', cls: 'ok' },
  returned: { label: '已退货', cls: 'warn' },
  cancelled: { label: '已取消', cls: 'err' },
};
function opTag(pkg) {
  if (pkg.isReturned) return { label: '已退货', cls: 'err' };
  return OPERATE_LABELS[pkg.operateStatus] || { label: pkg.operateStatus || '—', cls: 'mute' };
}

// 复制文本到剪贴板(uni API,H5/小程序通用;与 order-detail/index.vue 同口径)
function copyText(val, label) {
  const s = String(val || '').trim();
  if (!s) return;
  uni.setClipboardData({
    data: s,
    success: () => uni.showToast({ title: (label || '') + '已复制', icon: 'none' }),
  });
}

// ── 剩发倒计时(与 web 端 OrderProcess.vue 同口径)──────────────
// 有最晚发货时间、未交运且非取消的包裹展示下单/最迟/剩发(已交运/已取消无发货义务)
function showShipCountdown(pkg) {
  return !!pkg && !!pkg.shipmentDate && !pkg.isShipped && pkg.ozonStatus !== 'cancelled';
}

// ── 交运中/集运中/已签收/已成功/已退货 时间行(下单/集运/签收/退货 + 利润)──────
// 2026-11 新状态名:dispatching(交运中)/delivering(集运中)/signed(已签收)/settled(已成功)/returned(已退货)
const SHIP_TIMES_STATUSES = ['dispatching', 'delivering', 'signed', 'settled', 'returned'];
function showShipTimes(pkg) {
  return !!pkg && SHIP_TIMES_STATUSES.includes(pkg.operateStatus);
}

// ── 利润展示(与 web 端 OrderProcess.vue profitLabel/profitTitle 同口径)──
// estimated=false → 真实应计口径;cancelled → 已取消无收入;否则按 16% 预估
function profitLabel(pkg) {
  const p = pkg.profit;
  if (!p) return '利润';
  if (p.cancelled) return '利润';
  return p.estimated === false ? '利润实' : '预估利润';
}
function profitClass(pkg) {
  const v = pkg.profit?.profit;
  if (v == null) return 'muted';
  if (v > 0) return 'profit-pos';
  if (v < 0) return 'profit-neg';
  return 'muted';
}
// 每秒刷新的当前时间(驱动所有卡片剩发倒计时秒级跳动)
const nowTs = ref(Date.now());
let cdTimer = null;
function startCdTimer() {
  if (cdTimer) return;
  cdTimer = setInterval(() => { nowTs.value = Date.now(); }, 1000);
}
function stopCdTimer() {
  if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
}
// 倒计时文本:cutoff = shipment_date,依赖 nowTs 每秒重算
function countdown(pkg) {
  if (!pkg || !pkg.shipmentDate) return { overdue: false, text: '—' };
  const end = new Date(pkg.shipmentDate).getTime();
  if (isNaN(end)) return { overdue: false, text: '—' };
  const diff = end - nowTs.value;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const mins = Math.floor((abs % 3600000) / 60000);
  const secs = Math.floor((abs % 60000) / 1000);
  const text = days > 0
    ? `${days}天${hours}小时${mins}分${secs}秒`
    : hours > 0
      ? `${hours}小时${mins}分${secs}秒`
      : `${mins}分${secs}秒`;
  return { overdue: diff < 0, text };
}
onShow(() => startCdTimer());
onHide(() => stopCdTimer());
onUnload(() => stopCdTimer());
onUnmounted(() => stopCdTimer());

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
      purchaseUnshippedHours: purchaseUnshippedHours.value || 0,
      logisticsStaleHours: logisticsStaleHours.value || 0,
      page: page.value,
      pageSize: PAGE_SIZE,
    });
    const list = data?.packages || [];
    rows.value = page.value === 1 ? list : rows.value.concat(list);
    total.value = data?.total || 0;
    quickCounts.value = data?.quickCounts || {};
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

// 详情页操作(入库/同步)成功后通知刷新(tab 计数 + 列表重置第 1 页)
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
  padding-bottom: 220rpx; /* 预留底部导航高度(120rpx + 安全区) */
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

/* 批量录采购条(全选本页 + 批量入口) */
.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12rpx;
}

/* 快速筛选(2026-10-17 与 web/安卓同步):采购超24h未发货 / 物流超24h未揽收 */
.quick-bar {
  display: flex;
  align-items: center;
  margin-top: 12rpx;
  gap: 12rpx;
}
.quick-chip {
  display: inline-flex;
  align-items: center;
  background: #f2f3f5;
  border-radius: 999rpx;
  padding: 8rpx 22rpx;
  font-size: 24rpx;
  color: #4e5969;
}
.quick-chip.on {
  background: #e8f0ff;
  color: #165dff;
}
.quick-cnt {
  margin-left: 4rpx;
}

.batch-chk {
  display: inline-flex;
  align-items: center;
  background: #ffffff;
  border-radius: 999rpx;
  padding: 8rpx 22rpx;
  font-size: 24rpx;
  color: #4e5969;
  gap: 8rpx;
}

.batch-btn {
  background: #165dff;
  color: #ffffff;
  border-radius: 999rpx;
  font-size: 24rpx;
  line-height: 2;
  padding: 0 26rpx;
  margin: 0;
}

.batch-btn[disabled] {
  background: #c9cdd4;
  color: #ffffff;
}

.row-chk {
  font-size: 30rpx;
  color: #c9cdd4;
  margin-right: 12rpx;
  flex-shrink: 0;
}

.row-chk.on {
  color: #165dff;
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

/* 复制小图标:紧贴货件号右侧,灰色点击区 */
.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 4rpx;
  padding: 4rpx;
  color: #86909c;
  vertical-align: middle;
}
.copy-btn:active { color: #0064f9; }

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

/* 搁置徽章与状态徽标并排显示(右侧) */
.tag-group {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8rpx;
}
.tag-group .op-tag {
  margin-left: 0;
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

/* ── 采购物流(2026-10-17) ── */
.card-logi {
  margin-top: 12rpx;
  padding: 10rpx 18rpx;
  background: #f7f8fa;
  border-radius: 8rpx;
  display: flex;
  flex-direction: column;
  gap: 6rpx;
}

.logi-line {
  display: flex;
  align-items: center;
  font-size: 22rpx;
  color: #4e5969;
  min-width: 0;
}

.logi-label {
  flex: none;
  padding: 0 8rpx;
  border-radius: 4rpx;
  background: #eef2ff;
  color: #4338ca;
  font-size: 18rpx;
  line-height: 30rpx;
  margin-right: 8rpx;
}

.logi-company {
  color: #4e5969;
  margin-right: 8rpx;
  flex: none;
}

.logi-no {
  color: #165dff;
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logi-empty {
  color: #a6abb3;
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

/* 时间行(未交运包裹:下单/最迟/剩发) */
.time-row {
  margin-top: 16rpx;
  padding: 14rpx 18rpx;
  background: #f7f8fa;
  border-radius: 12rpx;
}

.t-line {
  display: flex;
  align-items: baseline;
  padding: 4rpx 0;
}

.t-line.overdue .t-k,
.t-line.overdue .t-v {
  color: #f53f3f;
}

.t-k {
  font-size: 22rpx;
  color: #86909c;
  width: 120rpx;
  flex-shrink: 0;
}

.t-v {
  flex: 1;
  font-size: 24rpx;
  color: #1f2329;
  font-variant-numeric: tabular-nums;
}

.t-wd {
  color: #86909c;
  font-size: 22rpx;
}

.t-v.cd {
  color: #d97706;
}

/* 利润颜色:正绿/负红/零灰 */
.t-v.profit-pos { color: #00b42a; }
.t-v.profit-neg { color: #f53f3f; }
.t-v.muted { color: #86909c; }

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
