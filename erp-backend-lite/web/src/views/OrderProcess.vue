<script setup>
// 订单处理(2026-08,个人自发货模式)
// 数据来源:order-sync.js 定时同步的 Ozon FBS 订单(op_* 表),本页管理采购录入与关联
// 设计文档: docs/采购订单-Ozon订单关联管理-功能设计.md
// 核心流程:买家Ozon下单 → 我采购(提交采购信息→直接流转待打单发货) → 上家发货给我
//          → 轨迹签收=到货(标记提示) → 我自行打包打面单 → 交运 → 妥投回款
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import {
  getOrderTabs, getOrderList, getOrderDetail,
  submitPurchase, unlinkPurchase, revertPackage, ignorePackage, markPrinted,
  runSync, getSyncStatus,
} from '../api/order-process.js';
import { useToast } from '../components/useToast.js';
import { useConfirmStore } from '../stores/confirm.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();
const confirmStore = useConfirmStore();

// ── Tab 页签(operate_status 分流)─────────────────────────
const TABS = [
  { key: 'waitProcess', label: '待处理' },
  { key: 'waitShip', label: '待打单发货' },
  { key: 'shipSuccess', label: '交运' },
  { key: 'waitReceiverConfirm', label: '已发货' },
  { key: 'ignored', label: '已搁置' },
];
const activeTab = ref('waitProcess');
const tabCounts = ref({});

// ── 筛选 ───────────────────────────────────────────────
const filters = reactive({
  keyword: '',
  purchaseStatus: '', // '' | 'none' | 'purchased'
  arrived: '',        // '' | '0' | '1'
});

// ── 全局搜索(跨所有状态,§9.1.1)─────────────────────────
const globalSearch = reactive({
  keyword: '',
  mode: 'ss',        // 'ss' 模糊 | 'eq' 精确
  active: false,     // 处于全局搜索模式(有关键词且已触发)
  total: 0,          // 全局命中数
});
const globalSearchBar = ref(null);

const pager = reactive({ current: 1, total: 0, pageSize: 20 });
const loading = ref(false);
const rows = ref([]);

// ── 采购录入弹窗(模式B)────────────────────────────────
const purchaseOpen = ref(false);
const purchaseSaving = ref(false);
const purchaseForm = reactive({
  packageId: null,
  packageNo: '',
  platform: 'other',
  purchaseSn: '',
  buyerAccount: '',
  sellerName: '',
  paymentAmount: '',
  logisticsCompany: '',
  logisticsNo: '',
  note: '',
  items: [], // [{ itemId, offerId, title, quantity, amount }]
});
const PLATFORMS = [
  { value: 'other', label: '手工(其他)' },
  { value: '1688', label: '1688' },
  { value: 'yangkeduo', label: '拼多多' },
  { value: 'taobao', label: '淘宝' },
];

// ── 详情弹窗 ───────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detail = ref(null);

// ── 同步状态 ───────────────────────────────────────────
const syncInfo = ref({ syncing: false, cursors: [] });
const syncing = ref(false);

// ── 数据加载 ───────────────────────────────────────────
async function loadTabs() {
  try {
    tabCounts.value = await getOrderTabs();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function loadList() {
  loading.value = true;
  try {
    const isGlobal = globalSearch.active && globalSearch.keyword.trim();
    const data = await getOrderList({
      tab: activeTab.value,
      keyword: filters.keyword.trim(),
      purchaseStatus: filters.purchaseStatus,
      arrived: filters.arrived,
      globalKeyword: isGlobal ? globalSearch.keyword.trim() : '',
      globalMode: globalSearch.mode,
      page: pager.current,
      pageSize: pager.pageSize,
    });
    globalSearch.total = isGlobal ? (data?.total || 0) : 0;
    rows.value = data?.packages || [];
    pager.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    rows.value = [];
    pager.total = 0;
  } finally {
    loading.value = false;
  }
}

async function loadSyncStatus() {
  try {
    syncInfo.value = await getSyncStatus();
    syncing.value = !!syncInfo.value?.syncing;
  } catch { /* 静默 */ }
}

function switchTab(key) {
  if (activeTab.value === key) return;
  activeTab.value = key;
  // 全局搜索模式下切 tab = 退出全局模式回到该 tab 视图
  if (globalSearch.active) clearGlobalSearch(false);
  pager.current = 1;
  loadList();
}

function search() {
  pager.current = 1;
  loadList();
}

// ── 全局搜索触发/清除 ───────────────────────────────────
function doGlobalSearch() {
  const kw = globalSearch.keyword.trim();
  if (!kw) {
    if (globalSearch.active) clearGlobalSearch();
    return;
  }
  globalSearch.active = true;
  pager.current = 1;
  loadList();
}

function clearGlobalSearch(reload = true) {
  globalSearch.keyword = '';
  globalSearch.active = false;
  globalSearch.total = 0;
  if (reload) {
    pager.current = 1;
    loadList();
  }
}

function onPageChange(p) {
  pager.current = p;
  loadList();
}

async function triggerSync() {
  if (syncing.value) {
    show('同步已在进行中,请稍候', 'info');
    return;
  }
  syncing.value = true;
  try {
    await runSync();
    show('同步已启动(约需 1-2 分钟),稍后刷新查看', 'success');
    // 轮询同步状态,完成后刷新列表
    setTimeout(pollSyncDone, 5000);
  } catch (err) {
    show(err.message || String(err), 'error');
    syncing.value = false;
  }
}

function pollSyncDone() {
  loadSyncStatus();
  if (syncInfo.value?.syncing) {
    setTimeout(pollSyncDone, 5000);
  } else {
    syncing.value = false;
    loadTabs();
    loadList();
  }
}

// ── 采购录入 ───────────────────────────────────────────
function openPurchase(pkg) {
  purchaseForm.packageId = pkg.id;
  purchaseForm.packageNo = pkg.packageNo;
  purchaseForm.platform = 'other';
  purchaseForm.purchaseSn = '';
  purchaseForm.buyerAccount = '';
  purchaseForm.sellerName = '';
  purchaseForm.paymentAmount = '';
  purchaseForm.logisticsCompany = '';
  purchaseForm.logisticsNo = '';
  purchaseForm.note = '';
  purchaseForm.items = (pkg.items || []).map((it) => ({
    itemId: it.id,
    offerId: it.offerId,
    title: it.title,
    quantity: it.quantity,
    amount: '',
    picUrl: it.picUrl,
    pdpUrl: it.pdpUrl,
  }));
  purchaseOpen.value = true;
}

async function savePurchase() {
  if (purchaseSaving.value) return;
  const items = purchaseForm.items
    .map((it) => ({ itemId: it.itemId, amount: Number(it.amount) || 0, quantity: it.quantity }))
    .filter((it) => it.itemId);
  const hasAmount = items.some((it) => it.amount > 0);
  const hasNo = !!purchaseForm.logisticsNo.trim();
  if (!hasAmount && !hasNo) {
    show('请至少填写采购金额或国内快递单号', 'error');
    return;
  }
  purchaseSaving.value = true;
  try {
    await submitPurchase({
      packageId: purchaseForm.packageId,
      platform: purchaseForm.platform,
      purchaseSn: purchaseForm.purchaseSn.trim() || null,
      buyerAccount: purchaseForm.buyerAccount.trim() || null,
      sellerName: purchaseForm.sellerName.trim() || null,
      paymentAmount: Number(purchaseForm.paymentAmount) || null,
      logisticsCompany: purchaseForm.logisticsCompany.trim() || null,
      logisticsNo: hasNo ? purchaseForm.logisticsNo.trim() : null,
      note: purchaseForm.note.trim() || null,
      items,
    });
    show('采购信息已提交,包裹已流转到待打单发货', 'success');
    purchaseOpen.value = false;
    loadTabs();
    loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    purchaseSaving.value = false;
  }
}

// ── 拼多多订单导入(miaoshou-helper 扩展桥接)──────────
// 协议:window.postMessage(source='erp-pdd') ⇄ erp-bridge.js ⇄ background.js → PDD order_list_v4
const PDD_NS = 'erp-pdd';
const pddDialogOpen = ref(false);
const pddLoading = ref(false);
const pddError = ref('');
const pddOrders = ref([]);          // 精简后的 PDD 订单列表
const pddTab = ref('all');          // 'all' | 'unreceived'
const pddSelected = ref([]);        // 已勾选的 orderSn
const pddBridgeReady = ref(false);  // 是否检测到扩展桥接
let pddReqSeq = 0;
const pddPending = new Map();       // reqId -> resolve

function pddRequest(payload) {
  return new Promise((resolve) => {
    const reqId = ++pddReqSeq;
    const timer = setTimeout(() => {
      pddPending.delete(reqId);
      resolve({ ok: false, error: '请求超时:请确认 miaoshou-helper 扩展已启用并已重新加载(扩展更新后需刷新本页)' });
    }, 10_000);
    pddPending.set(reqId, (data) => { clearTimeout(timer); resolve(data); });
    window.postMessage({ source: PDD_NS, type: 'PDD_GET_ORDERS', reqId, payload }, window.location.origin);
  });
}

function onPddMessage(ev) {
  if (ev.source !== window || !ev.data || ev.data.source !== PDD_NS) return;
  if (ev.data.type === 'PDD_PONG') { pddBridgeReady.value = true; return; }
  if (ev.data.type === 'PDD_ORDERS_RESULT') {
    const cb = pddPending.get(ev.data.reqId);
    if (cb) { pddPending.delete(ev.data.reqId); cb(ev.data.data); }
  }
}

function pddPing() {
  window.postMessage({ source: PDD_NS, type: 'PDD_PING' }, window.location.origin);
}

async function loadPddOrders() {
  pddLoading.value = true;
  pddError.value = '';
  pddSelected.value = [];
  try {
    const resp = await pddRequest({ tab: pddTab.value, size: 30 });
    if (!resp.ok) throw new Error(resp.error || '获取订单失败');
    pddOrders.value = resp.orders || [];
  } catch (err) {
    pddError.value = err.message || String(err);
    pddOrders.value = [];
  } finally {
    pddLoading.value = false;
  }
}

async function openPddDialog() {
  pddDialogOpen.value = true;
  await loadPddOrders();
}

function switchPddTab(t) {
  if (pddTab.value === t || pddLoading.value) return;
  pddTab.value = t;
  loadPddOrders();
}

function isPddCancelled(o) {
  return /取消/.test(o.statusPrompt || '');
}

const pddSelectedOrders = computed(() =>
  pddOrders.value.filter((o) => pddSelected.value.includes(o.orderSn)));
const pddTotal = computed(() =>
  pddSelectedOrders.value.reduce((s, o) => s + Number(o.amount || 0), 0).toFixed(2));

// 快递单号前缀 → 物流公司(启发式推断,仅预填,可手改)
const COURIER_RULES = [
  [/^YT/, '圆通速递'],
  [/^SF/, '顺丰速运'],
  [/^JT/, '极兔速递'],
  [/^77/, '申通快递'],
  [/^75|^78/, '中通快递'],
  [/^JD/, '京东物流'],
  [/^EMS|^98/, '邮政快递'],
];
function inferCourier(no) {
  if (!no) return '';
  const hit = COURIER_RULES.find(([re]) => re.test(no));
  return hit ? hit[1] : '';
}

/** 导入选中的 PDD 订单回填采购表单 */
function applyPddSelection() {
  const sel = pddSelectedOrders.value;
  if (!sel.length) return;
  purchaseForm.platform = 'yangkeduo';
  purchaseForm.purchaseSn = sel.map((o) => o.orderSn).join(',');
  const malls = [...new Set(sel.map((o) => o.mallName).filter(Boolean))];
  purchaseForm.sellerName = malls.join(',');
  purchaseForm.paymentAmount = pddTotal.value;
  const tracks = sel.map((o) => o.trackingNumber).filter(Boolean);
  purchaseForm.logisticsNo = tracks.join(',');
  purchaseForm.logisticsCompany = tracks.length ? inferCourier(tracks[0]) : '';
  // 单订单+单商品行时自动填行金额,其余场景保持手动填写
  if (sel.length === 1 && sel[0].goods.length === 1 && purchaseForm.items.length === 1) {
    purchaseForm.items[0].amount = sel[0].amount;
  }
  pddDialogOpen.value = false;
  show(`已导入 ${sel.length} 个拼多多订单(金额 ¥${pddTotal.value}),请核对后保存`, 'success');
}

// ── 行操作 ─────────────────────────────────────────────
async function onUnlink(pkg, link) {
  if (!(await confirmStore.ask({
    message: `确认取消采购单 ${link.purchaseSn || link.id} 与包裹 ${pkg.packageNo} 的关联?将冲回该采购金额(${fmtMoney(link.allocatedAmount)})`,
    danger: true,
  }))) return;
  try {
    await unlinkPurchase(link.purchaseOrderId, pkg.id);
    show('已取消关联', 'success');
    loadTabs();
    loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function onIgnore(pkg, ignored) {
  try {
    await ignorePackage(pkg.id, ignored);
    show(ignored ? '已搁置' : '已恢复', 'success');
    loadTabs();
    loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function onPrinted(pkg) {
  try {
    await markPrinted(pkg.id);
    show('已标记打印面单,流转交运', 'success');
    loadTabs();
    loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// 退回待处理:取消全部采购关联并回流未采购(方案A语义:待处理=未采购)
async function onRevert(pkg) {
  const n = pkg.purchaseLinks?.length || 0;
  if (!(await confirmStore.ask({
    message: `确认将包裹 ${pkg.packageNo} 退回待处理?将取消全部 ${n} 条采购关联(冲回采购金额 ${fmtMoney(pkg.totalPurchaseAmount)}),包裹回到未采购状态`,
    danger: true,
  }))) return;
  try {
    await revertPackage(pkg.id);
    show('已退回待处理', 'success');
    loadTabs();
    loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function openDetail(pkg) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await getOrderDetail(pkg.id);
  } catch (err) {
    show(err.message || String(err), 'error');
    detailOpen.value = false;
  } finally {
    detailLoading.value = false;
  }
}

// ── 展示工具 ───────────────────────────────────────────
function fmtMoney(n) {
  if (n == null) return '—';
  return '¥' + Number(n).toFixed(2);
}

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const OZON_STATUS_LABELS = {
  awaiting_registration: '等待登记',
  awaiting_approve: '等待确认',
  awaiting_packaging: '等待包装',
  awaiting_deliver: '等待发运',
  delivering: '运输中',
  driver_pickup: '司机派送中',
  delivered: '已送达',
  cancelled: '已取消',
  arbitration: '仲裁',
  client_arbitration: '客户仲裁',
  not_accepted: '未接收',
};
function ozonStatus(s) {
  return OZON_STATUS_LABELS[s] || s || '—';
}

const PO_STATUS_LABELS = {
  wait_pay: '待付款',
  wait_send: '待发货',
  shipped: '已发货',
  part_shipped: '部分发货',
  signed: '已签收',
  finished: '已完成',
  closed: '已关闭',
};
function poStatus(s) {
  return PO_STATUS_LABELS[s] || s || '—';
}

// 包裹操作状态标签(全局搜索结果行显示所属状态)
const OPERATE_LABELS = {
  wait_process: { label: '待处理', cls: 'tag-warn' },
  wait_ship: { label: '待打单发货', cls: 'tag-info' },
  ship_success: { label: '交运', cls: 'tag-info' },
  wait_receiver_confirm: { label: '已发货', cls: 'tag-ok' },
  cancelled: { label: '已取消', cls: 'tag-err' },
};
function operateTag(pkg) {
  const o = OPERATE_LABELS[pkg.operateStatus] || { label: pkg.operateStatus, cls: 'tag-mute' };
  return o;
}

// 每秒刷新的当前时间(驱动剩发倒计时秒级跳动)
const nowTs = ref(Date.now());

// 剩余发货倒计时(cutoff = shipment_date,精确到秒,依赖 nowTs 每秒重算)
function countdown(pkg) {
  if (!pkg.shipmentDate) return null;
  const end = new Date(pkg.shipmentDate).getTime();
  if (isNaN(end)) return null;
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

function purchaseTag(pkg) {
  if (pkg.purchaseStatus === 'none') return { cls: 'tag tag-mute', label: '未采购' };
  return { cls: 'tag tag-ok', label: '已采购' };
}

function arrivedTag(pkg) {
  if (pkg.arrivedAt) return { cls: 'tag tag-ok', label: '已到货' };
  if (pkg.purchaseStatus !== 'none') return { cls: 'tag tag-warn', label: '等收货' };
  return null;
}

function platformLabel(p) {
  return PLATFORMS.find((x) => x.value === p)?.label || p || '—';
}

// 弹窗里展示的产品行(含已回写采购金额)
const detailItems = computed(() => detail.value?.items || []);
const detailLinks = computed(() => detail.value?.purchaseLinks || []);

let statusTimer = null;
let tickTimer = null;
onMounted(() => {
  loadTabs();
  loadList();
  loadSyncStatus();
  statusTimer = setInterval(loadSyncStatus, 30_000);
  tickTimer = setInterval(() => { nowTs.value = Date.now(); }, 1000);
  // 拼多多导入桥接:监听扩展回包 + 主动探测(扩展公告可能早于本页挂载)
  window.addEventListener('message', onPddMessage);
  pddPing();
});
onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer);
  if (tickTimer) clearInterval(tickTimer);
  window.removeEventListener('message', onPddMessage);
});
</script>

<template>
  <div class="order-process-page">
    <!-- Tab 页签 -->
    <div class="tabs-bar">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab-btn"
        :class="{ active: activeTab === t.key }"
        @click="switchTab(t.key)"
      >
        {{ t.label }}
        <span class="tab-count">{{ tabCounts[t.key] ?? 0 }}</span>
      </button>
      <div class="sync-area">
        <div class="global-search-bar" v-if="!globalSearch.active">
          <select v-model="globalSearch.mode" class="filter-input mode-select" title="匹配模式">
            <option value="ss">模糊匹配</option>
            <option value="eq">精确匹配</option>
          </select>
          <input
            ref="globalSearchBar"
            class="filter-input global-kw-input"
            type="text"
            v-model.trim="globalSearch.keyword"
            placeholder="全局搜索:包裹号/订单号/运单号/采购单号/采购物流单号/SKU"
            title="跨所有状态搜索订单"
            @keydown.enter="doGlobalSearch"
          />
          <button class="btn btn-primary" @click="doGlobalSearch">搜索</button>
        </div>
        <div class="global-search-hint" v-else>
          <span class="tag tag-info">全局搜索</span>
          <span>命中 <b>{{ globalSearch.total }}</b> 个包裹(全部状态)</span>
          <button class="btn btn-ghost btn-sm" @click="clearGlobalSearch()">退出搜索</button>
        </div>
        <span v-if="syncInfo.cursors?.length" class="sync-info" :title="syncInfo.cursors.map(c => `${c.storeId}: ${c.lastError || c.lastRunAt}`).join('\n')">
          最近同步 {{ fmtTime(syncInfo.cursors[0]?.lastRunAt) }}
        </span>
        <button class="btn btn-ghost" :disabled="syncing" @click="triggerSync">
          {{ syncing ? '同步中…' : '同步订单' }}
        </button>
      </div>
    </div>

    <!-- 全局搜索模式提示条 -->
    <div v-if="globalSearch.active" class="global-banner">
      全局搜索「{{ globalSearch.keyword }}」({{ globalSearch.mode === 'eq' ? '精确' : '模糊' }}):跨所有状态命中 {{ globalSearch.total }} 个包裹 · 当前第 {{ pager.current }} 页
      <button class="btn btn-ghost btn-sm" @click="clearGlobalSearch()">清除</button>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="filter-bar">
        <input
          class="filter-input kw-input"
          type="text"
          v-model.trim="filters.keyword"
          placeholder="订单号/包裹号/采购单号/物流单号/SKU/买家"
          @keydown.enter="search"
        />
        <select v-model="filters.purchaseStatus" class="filter-input" @change="search">
          <option value="">全部采购</option>
          <option value="none">未采购</option>
          <option value="purchased">已采购</option>
        </select>
        <select v-model="filters.arrived" class="filter-input" @change="search">
          <option value="">全部到货</option>
          <option value="0">等收货</option>
          <option value="1">已到货</option>
        </select>
        <button class="btn btn-primary" @click="search">查询</button>
        <button class="btn btn-ghost" :disabled="loading" @click="loadList">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="table-wrap">
      <table class="data-table pkg-table">
        <thead>
          <tr>
            <th class="col-product">产品信息</th>
            <th class="col-qty">数量</th>
            <th class="col-order">订单信息</th>
            <th class="col-amount">金额(利润)</th>
            <th class="col-purchase">采购信息</th>
            <th class="col-status">状态/时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="7" class="empty">{{ loading ? '加载中…' : (globalSearch.active ? '全局搜索未命中包裹' : '暂无订单(点击右上角「同步订单」拉取 Ozon 订单)') }}</td>
          </tr>
          <tr v-for="pkg in rows" :key="pkg.id" class="pkg-row">
            <td class="col-product">
              <div v-for="(it, i) in pkg.items" :key="i" class="product-item">
                <a v-if="it.picUrl" :href="it.pdpUrl" target="_blank" rel="noopener" class="product-img-box" :title="it.title || '查看Ozon商品'">
                  <img :src="it.picUrl" referrerpolicy="no-referrer" loading="lazy" class="product-img" alt="" />
                </a>
                <div class="product-main">
                  <a v-if="it.pdpUrl" :href="it.pdpUrl" target="_blank" rel="noopener" class="product-title" :title="it.title || ''">{{ it.title || '—' }}</a>
                  <div v-else class="product-title">{{ it.title || '—' }}</div>
                  <div class="product-sub">Offer ID：{{ it.offerId }}</div>
                  <div class="product-sub">产品单价：{{ fmtMoney(it.price) }}</div>
                </div>
              </div>
              <div v-if="!pkg.items?.length" class="muted">—</div>
            </td>
            <td class="col-qty">
              <div v-for="(it, i) in pkg.items" :key="i" class="qty-line" :class="{ 'qty-multi': it.quantity > 1 }">× {{ it.quantity }}</div>
              <div v-if="!pkg.items?.length" class="muted">—</div>
            </td>
            <td class="col-order">
              <div class="mono">{{ pkg.postingNumber }}</div>
              <div class="sub">
                <span v-if="pkg.parentId" class="tag tag-mute" title="拆单子件">子件</span>
                {{ pkg.storeName }} · {{ pkg.orderNumber }}
              </div>
              <div class="sub muted">{{ pkg.buyerName || '—' }} {{ pkg.buyerCity ? '· ' + pkg.buyerCity : '' }}</div>
            </td>
            <td class="col-amount">
              <div>订单 {{ fmtMoney(pkg.orderAmount) }}</div>
              <div class="sub muted">佣金估 {{ fmtMoney(pkg.profit?.commission) }}</div>
              <div>采购 <span :class="{ 'muted': !pkg.totalPurchaseAmount }">{{ fmtMoney(pkg.totalPurchaseAmount) }}</span></div>
              <div :class="pkg.profit?.profit > 0 ? 'profit-pos' : 'profit-neg'">
                利润 {{ fmtMoney(pkg.profit?.profit) }}
                <span v-if="pkg.profit?.profitRateSale != null" class="sub">({{ pkg.profit.profitRateSale }}%)</span>
              </div>
            </td>
            <td class="col-purchase">
              <div v-if="!pkg.purchaseLinks?.length" class="muted">未录入</div>
              <div v-for="l in pkg.purchaseLinks" :key="l.id" class="purchase-item">
                <div>
                  <span class="tag tag-ok">已关联</span>
                  {{ platformLabel(l.platform) }}
                  <span class="mono">{{ l.purchaseSn || '#' + l.id }}</span>
                </div>
                <div class="sub muted">
                  {{ poStatus(l.poStatus) }} · {{ fmtMoney(l.allocatedAmount) }}
                  <template v-if="l.poLogisticsNo">· {{ l.poLogisticsCompany }} {{ l.poLogisticsNo }}</template>
                </div>
              </div>
            </td>
            <td class="col-status">
              <div>
                <!-- 全局搜索模式:显示包裹所属操作状态(跨tab辨识) -->
                <span v-if="globalSearch.active" class="tag" :class="operateTag(pkg).cls" style="margin-right: 4px" title="包裹所属状态">{{ operateTag(pkg).label }}</span>
                <!-- Ozon状态展示原始值(如 awaiting_deliver),中文释义放悬浮提示 -->
                <span class="tag mono" :class="pkg.ozonStatus === 'cancelled' ? 'tag-err' : 'tag-mute'" :title="ozonStatus(pkg.ozonStatus) + (pkg.substatus ? '(' + pkg.substatus + ')' : '')">{{ pkg.ozonStatus || '—' }}</span>
                <span :class="purchaseTag(pkg).cls" style="margin-left: 4px">{{ purchaseTag(pkg).label }}</span>
                <span v-if="arrivedTag(pkg)" :class="arrivedTag(pkg).cls" style="margin-left: 4px">{{ arrivedTag(pkg).label }}</span>
              </div>
              <div class="sub muted">下单：{{ fmtTime(pkg.inProcessAt) }}</div>
              <div v-if="pkg.shipmentDate && !pkg.isShipped" class="sub muted">最迟：{{ fmtTime(pkg.shipmentDate) }}</div>
              <div v-if="countdown(pkg) && !pkg.isShipped" class="sub" :class="countdown(pkg).overdue ? 'overdue' : 'countdown'">
                {{ countdown(pkg).overdue ? '已超时：' : '剩发：' }}{{ countdown(pkg).text }}
              </div>
              <div v-if="pkg.isShipped" class="sub muted">已交运 {{ fmtTime(pkg.shippedAt) }}</div>
            </td>
            <td class="col-actions">
              <div class="action-group">
                <button
                  v-if="pkg.operateStatus === 'wait_process' || pkg.purchaseStatus === 'none'"
                  class="btn btn-primary btn-sm"
                  @click="openPurchase(pkg)"
                >提交采购信息</button>
                <button v-else class="btn btn-ghost btn-sm" @click="openPurchase(pkg)">追加采购</button>
                <button class="btn btn-ghost btn-sm" @click="openDetail(pkg)">详情</button>
                <button
                  v-if="pkg.operateStatus === 'wait_ship'"
                  class="btn btn-ghost btn-sm"
                  title="标记已打印Ozon面单,流转交运"
                  @click="onPrinted(pkg)"
                >打单交运</button>
                <button
                  v-if="pkg.operateStatus === 'wait_ship'"
                  class="btn btn-danger btn-sm"
                  title="取消全部采购关联,退回未采购"
                  @click="onRevert(pkg)"
                >退回待处理</button>
                <button
                  v-for="l in pkg.purchaseLinks"
                  :key="'un' + l.id"
                  class="btn btn-danger btn-sm"
                  @click="onUnlink(pkg, l)"
                >取消关联</button>
                <button class="btn btn-ghost btn-sm" @click="onIgnore(pkg, !pkg.isIgnored)">
                  {{ pkg.isIgnored ? '恢复' : '搁置' }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="footer-bar">
      <span class="footer-info">共 {{ pager.total }} 个包裹</span>
      <AppPager
        :modelValue="pager.current"
        :total="pager.total"
        :pageSize="pager.pageSize"
        @update:modelValue="onPageChange"
      />
    </div>

    <!-- 提交采购信息弹窗(模式B) -->
    <AppModal :open="purchaseOpen" :title="`提交采购信息 · ${purchaseForm.packageNo}`" size="lg" @update:open="purchaseOpen = $event">
      <div class="purchase-form">
        <div class="form-row">
          <label>采购单号</label>
          <input v-model.trim="purchaseForm.purchaseSn" class="filter-input" placeholder="1688/拼多多订单号(可留空)" />
          <label>采购平台</label>
          <select v-model="purchaseForm.platform" class="filter-input">
            <option v-for="p in PLATFORMS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </div>
        <div v-if="purchaseForm.platform === 'yangkeduo'" class="form-row pdd-import-row">
          <label></label>
          <div class="pdd-import-cell">
            <button class="btn btn-ghost btn-sm" @click="openPddDialog">从拼多多导入订单</button>
            <span v-if="!pddBridgeReady" class="pdd-bridge-warn" title="需要安装/启用 miaoshou-helper 扩展,并保持浏览器已登录拼多多">
              未检测到助手扩展
            </span>
          </div>
        </div>
        <div class="form-row">
          <label>采购账号</label>
          <input v-model.trim="purchaseForm.buyerAccount" class="filter-input" placeholder="如 清祥17 / PCC01(可留空)" />
          <label>上家名称</label>
          <input v-model.trim="purchaseForm.sellerName" class="filter-input" placeholder="如 深圳市嘉龙盛(可留空)" />
        </div>
        <div class="form-row">
          <label>实付合计</label>
          <input v-model.trim="purchaseForm.paymentAmount" class="filter-input" placeholder="可留空(按行金额计)" />
          <label>备注</label>
          <input v-model.trim="purchaseForm.note" class="filter-input" placeholder="可留空" />
        </div>
        <div class="form-row">
          <label>国内快递单号</label>
          <input v-model.trim="purchaseForm.logisticsNo" class="filter-input" placeholder="上家发货单号(填了视为已发货)" />
          <label>物流公司</label>
          <input v-model.trim="purchaseForm.logisticsCompany" class="filter-input" placeholder="如 顺丰/韵达/极兔" />
        </div>

        <div class="form-section-title">订单产品 · 采购金额(按行填写)</div>
        <table class="data-table item-table">
          <thead>
            <tr>
              <th style="width: 260px">产品</th>
              <th>数量</th>
              <th>售价</th>
              <th>已采金额</th>
              <th style="width: 140px">本次采购金额</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in purchaseForm.items" :key="it.itemId">
              <td>
                <div class="product-item">
                  <a v-if="it.picUrl" :href="it.pdpUrl" target="_blank" rel="noopener" class="product-img-box">
                    <img :src="it.picUrl" referrerpolicy="no-referrer" loading="lazy" class="product-img" alt="" />
                  </a>
                  <div class="product-main">
                    <div class="product-title">{{ it.title || '—' }}</div>
                    <div class="product-sub">SKU {{ it.offerId }}</div>
                  </div>
                </div>
              </td>
              <td>× {{ it.quantity }}</td>
              <td>{{ fmtMoney(it.price) }}</td>
              <td class="muted">—</td>
              <td>
                <input v-model.trim="it.amount" class="filter-input amount-input" placeholder="0.00" />
              </td>
            </tr>
          </tbody>
        </table>

        <div class="form-tip">
          提交后包裹将直接流转到「待打单发货」;国内快递单号可留空后续补录。个人自发货模式:无货代,收货人为你本人。
        </div>
        <div class="form-actions">
          <button class="btn btn-ghost" @click="purchaseOpen = false">取 消</button>
          <button class="btn btn-primary" :disabled="purchaseSaving" @click="savePurchase">
            {{ purchaseSaving ? '保存中…' : '保 存' }}
          </button>
        </div>
      </div>
    </AppModal>

    <!-- 拼多多订单选择弹窗(二级,数据来自 miaoshou-helper 扩展桥接) -->
    <AppModal :open="pddDialogOpen" title="选择拼多多订单" size="lg" @update:open="pddDialogOpen = $event">
      <div class="pdd-dialog">
        <div class="pdd-toolbar">
          <div class="pdd-tabs">
            <button class="pdd-tab" :class="{ active: pddTab === 'all' }" @click="switchPddTab('all')">全部</button>
            <button class="pdd-tab" :class="{ active: pddTab === 'unreceived' }" @click="switchPddTab('unreceived')">待收货</button>
          </div>
          <button class="btn btn-ghost btn-sm" :disabled="pddLoading" @click="loadPddOrders">刷新</button>
        </div>

        <div v-if="pddLoading" class="empty">加载中…</div>
        <div v-else-if="pddError" class="pdd-error">{{ pddError }}</div>
        <div v-else-if="!pddOrders.length" class="empty">没有查询到订单</div>
        <div v-else class="pdd-list">
          <label
            v-for="o in pddOrders"
            :key="o.orderSn"
            class="pdd-item"
            :class="{ disabled: isPddCancelled(o), selected: pddSelected.includes(o.orderSn) }"
          >
            <input
              type="checkbox"
              :value="o.orderSn"
              :disabled="isPddCancelled(o)"
              v-model="pddSelected"
            />
            <img
              v-if="o.goods[0]?.thumbUrl"
              :src="o.goods[0].thumbUrl"
              class="pdd-thumb"
              loading="lazy"
              referrerpolicy="no-referrer"
              alt=""
            />
            <div v-else class="pdd-thumb pdd-thumb-empty"></div>
            <div class="pdd-info">
              <div class="pdd-goods" :title="o.goods[0]?.goodsName">
                {{ o.goods[0]?.goodsName || '—' }}
                <span v-if="o.goods.length > 1" class="pdd-more">等{{ o.goods.length }}件商品</span>
              </div>
              <div class="pdd-meta">
                <span class="pdd-mall">{{ o.mallName || '—' }}</span>
                <span class="pdd-amount">¥{{ o.amount }}</span>
                <span>{{ fmtTime(o.orderTime * 1000) }}</span>
                <span class="tag" :class="isPddCancelled(o) ? 'tag-mute' : 'tag-info'">{{ o.statusPrompt || '—' }}</span>
              </div>
              <div class="pdd-sn mono">
                {{ o.orderSn }}<template v-if="o.trackingNumber"> · {{ o.trackingNumber }}</template>
              </div>
            </div>
          </label>
        </div>

        <div class="pdd-footer">
          <span class="pdd-footer-info">已选 {{ pddSelected.length }} 单 · 合计 ¥{{ pddTotal }}</span>
          <div class="form-actions">
            <button class="btn btn-ghost" @click="pddDialogOpen = false">取 消</button>
            <button class="btn btn-primary" :disabled="!pddSelected.length" @click="applyPddSelection">导入所选</button>
          </div>
        </div>
      </div>
    </AppModal>

    <!-- 详情弹窗 -->
    <AppModal :open="detailOpen" :title="detail?.package ? `包裹详情 · ${detail.package.packageNo}` : '包裹详情'" size="lg" @update:open="detailOpen = $event">
      <div v-if="detailLoading" class="empty">加载中…</div>
      <div v-else-if="detail" class="detail-body">
        <div class="detail-grid">
          <div><span class="dl">Ozon订单</span><span class="mono">{{ detail.package.postingNumber }}</span></div>
          <div><span class="dl">订单号</span>{{ detail.package.orderNumber }}</div>
          <div><span class="dl">店铺</span>{{ detail.package.storeName }}</div>
          <div><span class="dl">Ozon状态</span><span class="mono" :title="ozonStatus(detail.package.ozonStatus)">{{ detail.package.ozonStatus || '—' }}{{ detail.package.substatus ? ' · ' + detail.package.substatus : '' }}</span></div>
          <div><span class="dl">买家</span>{{ detail.package.buyerName || '—' }}</div>
          <div><span class="dl">配送方式</span>{{ detail.package.deliveryMethod || '—' }}</div>
          <div><span class="dl">发货仓库</span>{{ detail.package.warehouse || '—' }}</div>
          <div><span class="dl">下单时间</span>{{ fmtTime(detail.package.inProcessAt) }}</div>
          <div><span class="dl">最晚发货</span>{{ fmtTime(detail.package.shipmentDate) }}</div>
          <div><span class="dl">订单金额</span>{{ fmtMoney(detail.package.orderAmount) }}</div>
          <div><span class="dl">佣金估</span>{{ fmtMoney(detail.package.profit?.commission) }}</div>
          <div><span class="dl">采购合计</span>{{ fmtMoney(detail.package.totalPurchaseAmount) }}</div>
          <div><span class="dl">预估利润</span>{{ fmtMoney(detail.package.profit?.profit) }}</div>
        </div>

        <div class="detail-section">订单产品</div>
        <table class="data-table item-table">
          <thead>
            <tr><th style="width: 260px">产品</th><th>数量</th><th>售价</th><th>已采数量</th><th>采购金额(回写)</th></tr>
          </thead>
          <tbody>
            <tr v-for="it in detailItems" :key="it.id">
              <td>
                <div class="product-item">
                  <a v-if="it.picUrl" :href="it.pdpUrl" target="_blank" rel="noopener" class="product-img-box">
                    <img :src="it.picUrl" referrerpolicy="no-referrer" loading="lazy" class="product-img" alt="" />
                  </a>
                  <div class="product-main">
                    <div class="product-title">{{ it.title || '—' }}</div>
                    <div class="product-sub">SKU {{ it.offerId }}</div>
                  </div>
                </div>
              </td>
              <td>× {{ it.quantity }}</td>
              <td>{{ fmtMoney(it.price) }}</td>
              <td>{{ it.purchaseNum }}</td>
              <td>{{ fmtMoney(it.purchaseAmount) }}</td>
            </tr>
          </tbody>
        </table>

        <div class="detail-section">采购关联</div>
        <table v-if="detailLinks.length" class="data-table item-table">
          <thead>
            <tr><th>采购单</th><th>平台</th><th>状态</th><th>金额</th><th>上家</th><th>国内物流</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in detailLinks" :key="l.id">
              <td class="mono">{{ l.purchaseSn || '#' + l.purchaseOrderId }}</td>
              <td>{{ platformLabel(l.platform) }}</td>
              <td>{{ poStatus(l.poStatus) }}</td>
              <td>{{ fmtMoney(l.allocatedAmount) }}</td>
              <td>{{ l.sellerName || '—' }}</td>
              <td>{{ l.poLogisticsCompany }} {{ l.poLogisticsNo || '' }}</td>
              <td>
                <button class="btn btn-danger btn-sm" @click="onUnlink(detail.package, l)">取消关联</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">未录入采购</div>

        <div class="detail-section">国内物流轨迹(上家→我)</div>
        <div v-if="detail.traces?.length" class="trace-list">
          <div v-for="(t, i) in detail.traces" :key="i" class="trace-item">
            <span class="trace-time mono">{{ fmtTime(t.trace_at || t.traceAt) }}</span>
            <span>{{ t.description || t.company }}</span>
          </div>
        </div>
        <div v-else class="muted">暂无轨迹(物流同步 P2 提供)</div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.order-process-page {
  padding: 16px;
  max-width: 1400px;
  margin: 0 auto;
}

/* Tab 页签 */
.tabs-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.tab-btn {
  padding: 6px 14px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  background: var(--bg-card, #fff);
  color: var(--text-primary, #374151);
  font-size: 13px;
  cursor: pointer;
}

.tab-btn.active {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}

.tab-count {
  margin-left: 4px;
  font-size: 11px;
  opacity: 0.8;
}

.sync-area {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sync-info {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}

/* 全局搜索栏 */
.global-search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mode-select {
  width: 96px;
}

.global-kw-input {
  width: 320px;
}

.global-search-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-primary, #374151);
}

/* 全局搜索模式提示条 */
.global-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  margin-bottom: 10px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
  font-size: 12px;
  color: #1d4ed8;
}

/* 工具栏 */
.toolbar {
  margin-bottom: 12px;
}

.kw-input {
  min-width: 280px;
}

/* 表格 */
.pkg-table {
  font-size: 12px;
}

.pkg-table th {
  text-align: left;
  white-space: nowrap;
}

.pkg-row td {
  vertical-align: top;
  padding: 10px 8px;
}

.col-product {
  min-width: 220px;
  max-width: 280px;
}

.product-item + .product-item {
  margin-top: 6px;
}

/* 商品图(Ozon CDN 直链,70×70,与妙手列表缩略图同尺寸) */
.product-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.product-img-box {
  flex: 0 0 70px;
  width: 70px;
  height: 70px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f9fafb;
}

.product-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}

.product-main {
  flex: 1;
  min-width: 0;
}

.product-title {
  /* display:block 关键:<a> 默认 inline,ellipsis/max-width 对 inline 无效会导致长名称溢出覆盖 */
  display: block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text-primary, #111827);
}

a.product-title:hover {
  color: #2563eb;
}

.product-sub {
  display: block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-secondary, #9ca3af);
}

/* 产品数量列(与产品信息列行间距对齐);数量>1 红色加粗提示采购量 */
.col-qty {
  min-width: 48px;
  max-width: 60px;
  white-space: nowrap;
}

.qty-line + .qty-line {
  margin-top: 6px;
}

.qty-line {
  line-height: 70px; /* 与 70×70 产品图垂直对齐 */
}

.qty-multi {
  color: #dc2626;
  font-weight: 700;
  font-size: 2em;
}

.col-order {
  min-width: 170px;
}

.col-amount {
  min-width: 120px;
}

.col-purchase {
  min-width: 180px;
}

.col-status {
  min-width: 140px;
}

.col-actions {
  min-width: 160px;
}

.action-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}

.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.sub {
  font-size: 11px;
  margin-top: 2px;
}

.muted {
  color: var(--text-secondary, #9ca3af);
}

.profit-pos {
  color: #16a34a;
}

.profit-neg {
  color: #ef4444;
}

.countdown {
  color: #2563eb;
}

.overdue {
  color: #ef4444;
  font-weight: 700;
}

.tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.tag-ok { background: #dcfce7; color: #16a34a; }
.tag-err { background: #fee2e2; color: #ef4444; }
.tag-warn { background: #fef3c7; color: #f59e0b; }
.tag-info { background: #dbeafe; color: #2563eb; }
.tag-mute { background: #f3f4f6; color: #6b7280; }

.empty {
  text-align: center;
  padding: 32px 0;
  color: var(--text-secondary, #9ca3af);
}

.footer-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
  gap: 8px;
}

.footer-info {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}

/* 采购表单 */
.purchase-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-row {
  display: grid;
  grid-template-columns: 90px 1fr 90px 1fr;
  gap: 8px;
  align-items: center;
}

.form-row label {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  text-align: right;
}

.form-section-title {
  font-size: 12px;
  font-weight: 700;
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #e5e7eb);
}

.item-table {
  font-size: 12px;
}

.amount-input {
  width: 120px;
}

.form-tip {
  font-size: 11px;
  color: var(--text-secondary, #9ca3af);
  background: #f9fafb;
  border-radius: 6px;
  padding: 8px 10px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 拼多多订单导入 */
.pdd-import-row {
  grid-template-columns: 90px 1fr;
  margin-top: -4px;
}

.pdd-import-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pdd-bridge-warn {
  font-size: 11px;
  color: #f59e0b;
}

.pdd-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 200px;
}

.pdd-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pdd-tabs {
  display: flex;
  gap: 6px;
}

.pdd-tab {
  padding: 4px 14px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  background: var(--bg-card, #fff);
  color: var(--text-primary, #374151);
  font-size: 12px;
  cursor: pointer;
}

.pdd-tab.active {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}

.pdd-error {
  padding: 14px 12px;
  border-radius: 6px;
  background: #fee2e2;
  color: #dc2626;
  font-size: 12px;
  word-break: break-all;
}

.pdd-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow: auto;
}

.pdd-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  cursor: pointer;
}

.pdd-item:hover {
  background: #f9fafb;
}

.pdd-item.selected {
  border-color: #2563eb;
  background: #eff6ff;
}

.pdd-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pdd-item input[type='checkbox'] {
  margin-top: 22px;
  flex: 0 0 auto;
}

.pdd-thumb {
  flex: 0 0 56px;
  width: 56px;
  height: 56px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  object-fit: cover;
}

.pdd-thumb-empty {
  background: #f3f4f6;
}

.pdd-info {
  flex: 1;
  min-width: 0;
}

.pdd-goods {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary, #111827);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pdd-more {
  font-weight: 400;
  color: var(--text-secondary, #9ca3af);
}

.pdd-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
}

.pdd-mall {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pdd-amount {
  color: #dc2626;
  font-weight: 700;
}

.pdd-sn {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-secondary, #9ca3af);
}

.pdd-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #e5e7eb);
}

.pdd-footer-info {
  font-size: 12px;
  color: var(--text-primary, #374151);
}

/* 详情 */
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 20px;
  font-size: 12px;
}

.detail-grid .dl {
  display: inline-block;
  min-width: 72px;
  color: var(--text-secondary, #6b7280);
}

.detail-section {
  font-size: 12px;
  font-weight: 700;
  margin-top: 14px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #e5e7eb);
}

.trace-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trace-item {
  font-size: 12px;
  display: flex;
  gap: 10px;
}

.trace-time {
  color: var(--text-secondary, #9ca3af);
  white-space: nowrap;
}
</style>
