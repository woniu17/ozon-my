<script setup>
// 订单处理(2026-08,个人自发货模式)
// 数据来源:order-sync.js 定时同步的 Ozon FBS 订单(op_* 表),本页管理采购录入与关联
// 设计文档: docs/采购订单-Ozon订单关联管理-功能设计.md
// 核心流程:买家Ozon下单 → 我采购(提交采购信息→直接流转待打单发货) → 上家发货给我
//          → 轨迹签收=到货(标记提示) → 我自行打包打面单 → 交运 → 妥投回款
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import {
  getOrderTabs, getOrderList, getOrderDetail,
  submitPurchase, unlinkPurchase, revertPackage, ignorePackage, markPrinted, fetchPackageLabel,
  runSync, runSyncAllList, getSyncStatus, getSyncProgress, dismissSyncProgress,
} from '../api/order-process.js';
import { useToast } from '../components/useToast.js';
import { useConfirmStore } from '../stores/confirm.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();
const confirmStore = useConfirmStore();

// ── Tab 页签(operate_status 分流)─────────────────────────
// 全部:跨所有状态(含搁置);已发货=已交运未妥投;已完成=已妥投(财务数据完整)
const TABS = [
  { key: 'all', label: '全部' },
  { key: 'waitProcess', label: '待处理' },
  { key: 'waitShip', label: '待打单发货' },
  { key: 'shipSuccess', label: '交运' },
  { key: 'waitReceiverConfirm', label: '已发货' },
  { key: 'completed', label: '已完成' },
  { key: 'cancelled', label: '已取消' },
  { key: 'ignored', label: '已搁置' },
];
const activeTab = ref('waitProcess');
const tabCounts = ref({});

// ── 筛选 ───────────────────────────────────────────────
const filters = reactive({
  keyword: '',
  purchaseStatus: '', // '' | 'none' | 'purchased'
  arrived: '',        // '' | '0' | '1'
  cancelInitiator: '',  // '' | 'client' | 'ozon' | 'seller'(仅已取消 tab 用)
});
// 取消发起者选项(与 Ozon cancellation_type 对应)
const CANCEL_INITIATOR_OPTIONS = [
  { value: 'client', label: '客户取消' },
  { value: 'ozon', label: 'Ozon 取消' },
  { value: 'seller', label: '卖家取消' },
];
// 取消原因 reason_id → 中文释义(实测 TOP,其他直接显示俄文原文)
// 992/994:Ozon 发起的质检单取消,不代表商品不通过(只是平台抽检流程导致订单取消)
const CANCEL_REASON_LABELS = {
  992: 'Ozon质检单',
  79: '客户拒收:商品不合适',
  578: '客户拒收:商品不合适',
  505: '客户取消:期限不合适',
  506: '客户取消:发现更便宜',
  504: '客户取消',
  508: '客户取消',
  710: '客户取消',
  502: '客户取消',
  537: '客户未取货',
  665: '客户未取货',
  686: '卖家未按时发货',
  402: '卖家取消:其他',
  586: '客户拒收:错发商品',
  20: '客户拒收:缺件',
  512: '无法送达',
  994: 'Ozon质检单',
};

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
// 详细进度(替代纯布尔 syncing,展示店铺数/当前店/已拉订单数/耗时)
const progress = ref({
  active: false,
  type: '',            // 'incremental' | 'all-list'
  totalStores: 0,
  doneStores: 0,
  currentStoreId: '',
  currentStoreName: '',
  currentPhase: '',
  currentPage: 0,
  postingsPulled: 0,
  startedAt: null,
  elapsedMs: 0,
  message: '',
  finishedAt: null,    // ISOString 完成时间(null=未结束)
  errorCount: 0,
  failures: [],        // [{ storeId, storeName, phase, page, error, stack }] 失败详情
});
// 是否展开失败详情(默认折叠,失败数>0 时自动展开)
const showFailures = ref(false);

// ── 全量同步弹窗 ───────────────────────────────────────
const syncAllOpen = ref(false);
const syncAllSubmitting = ref(false);
// 快捷选项(今天/7天/30天/90天),点击自动填充下方起止日期
const QUICK_OPTIONS = [
  { days: 1, label: '今天' },
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
];
// 当前选中的快捷天数(null 表示已手动改日期,无快捷选中)
const syncAllQuick = ref(30);
// 起止日期 YYYY-MM-DD(本地),默认近 30 天
const syncAllSince = ref('');
const syncAllTo = ref('');

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function daysAgoStr(n) {
  const d = new Date(Date.now() - n * 86400_000);
  const pad = (n2) => String(n2).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// 将本地日期(YYYY-MM-DD)转 ISO 字符串(UTC)
// 起始日期按 00:00:00 本地时间 → 转 UTC;结束日期按 23:59:59 本地时间 → 转 UTC
function localDateToIsoStart(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function localDateToIsoEnd(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59`);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
// 点击快捷选项:自动填充起止日期
function applyQuickOption(days) {
  syncAllQuick.value = days;
  syncAllSince.value = daysAgoStr(days);
  syncAllTo.value = todayStr();
}
// 手动改日期时清除快捷选中态
function onSinceInput() { syncAllQuick.value = null; }
function onToInput() { syncAllQuick.value = null; }

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
      cancelInitiator: activeTab.value === 'cancelled' ? filters.cancelInitiator : '',
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

async function loadProgress() {
  try {
    const p = await getSyncProgress();
    progress.value = p || progress.value;
    syncing.value = !!(p?.active || p?.syncing);
  } catch { /* 静默 */ }
}

function switchTab(key) {
  if (activeTab.value === key) return;
  activeTab.value = key;
  // 切 tab 时清空"取消发起者"筛选(仅已取消 tab 有意义)
  if (key !== 'cancelled') filters.cancelInitiator = '';
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

// 触发增量同步(双接口:unfulfilled + list)
async function triggerSync() {
  if (syncing.value) {
    show('同步已在进行中,请稍候', 'info');
    return;
  }
  // 清除上次的 dismissed 标记,允许显示新进度
  progress.value = { ...progress.value, dismissed: false, finishedAt: null };
  syncing.value = true;
  try {
    await runSync();
    show('增量同步已启动(约需 1-2 分钟),完成后自动刷新', 'success');
    setTimeout(pollProgress, 2000);
  } catch (err) {
    show(err.message || String(err), 'error');
    syncing.value = false;
  }
}

// 打开全量同步弹窗
function openSyncAllDialog() {
  if (syncing.value) {
    show('同步已在进行中,请稍候', 'info');
    return;
  }
  // 默认快捷近 30 天,自动填好起止日期
  syncAllQuick.value = 30;
  syncAllSince.value = daysAgoStr(30);
  syncAllTo.value = todayStr();
  syncAllOpen.value = true;
}

// 触发全量同步(/v4/posting/fbs/list)
async function triggerSyncAllList() {
  if (syncing.value) {
    show('同步已在进行中,请稍候', 'info');
    return;
  }
  const sinceIso = localDateToIsoStart(syncAllSince.value);
  const toIso = localDateToIsoEnd(syncAllTo.value);
  if (!sinceIso || !toIso) {
    show('请正确选择起始和结束日期', 'error');
    return;
  }
  if (new Date(sinceIso) > new Date(toIso)) {
    show('起始日期不能晚于结束日期', 'error');
    return;
  }
  const opts = { since: sinceIso, to: toIso };
  syncAllSubmitting.value = true;
  try {
    // 清除上次的 dismissed 标记,允许显示新进度
    progress.value = { ...progress.value, dismissed: false, finishedAt: null };
    await runSyncAllList(opts);
    syncAllOpen.value = false;
    show('全量同步已启动(覆盖所有状态含 delivered/cancelled),完成后自动刷新', 'success');
    setTimeout(pollProgress, 2000);
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    syncAllSubmitting.value = false;
  }
}

// 轮询详细进度,完成后保留进度条等用户关闭,仅刷新数据
function pollProgress() {
  loadProgress();
  if (progress.value?.active) {
    // 进行中:继续轮询
    setTimeout(pollProgress, 1500);
  } else {
    // 已完成(syncing=false):停止轮询,但进度条保留显示等用户关闭
    syncing.value = false;
    // 有失败时自动展开失败列表,便于查看错误
    if (progress.value?.errorCount > 0) showFailures.value = true;
    loadTabs();
    loadList();
    loadSyncStatus();
  }
}

// 进度计算属性:用于 UI 展示
const progressPct = computed(() => {
  const p = progress.value;
  if (!p?.totalStores) return 0;
  // 完成态固定 100%
  if (p?.finishedAt) return 100;
  return Math.min(100, Math.round((p.doneStores / p.totalStores) * 100));
});
const progressPhaseLabel = computed(() => {
  const ph = progress.value?.currentPhase;
  if (ph === 'unfulfilled') return '未妥投接口';
  if (ph === 'list') return '全量list接口';
  if (ph === 'cache-backfill') return '商品缓存回源';
  return '';
});
const progressTypeLabel = computed(() =>
  progress.value?.type === 'all-list' ? '全量同步(/v4/posting/fbs/list)' : '增量同步(双接口)'
);
const progressFinished = computed(() => !!progress.value?.finishedAt);
// 是否展示进度条:进行中 或 已结束未关闭
const showProgressBar = computed(() =>
  (progress.value?.active || progress.value?.finishedAt) && !progress.value?.dismissed
);
function fmtElapsed(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r}s`;
}

// 用户点击关闭按钮:后端清空 progress,前端本地标记 dismissed 兜底
async function dismissProgress() {
  // 同步进行中不允许关闭
  if (progress.value?.active || syncing.value) {
    show('同步进行中,无法关闭进度条', 'info');
    return;
  }
  // 本地立即隐藏(避免等 API 返回才消失)
  progress.value = { ...progress.value, dismissed: true };
  try {
    await dismissSyncProgress();
  } catch { /* 静默 */ }
  // 关闭后刷新数据(同步结束 → 列表/Tab 应已更新)
  loadTabs();
  loadList();
  loadSyncStatus();
}

// ── 采购录入 ───────────────────────────────────────────
// 采购弹窗内嵌订单导入区的平台 tab
const importTab = ref('pdd'); // 'pdd' | 'ali' | 'tb'

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
  // 清空三平台选中,重置到拼多多 tab 并自动加载
  pddSelected.value = [];
  aliSelected.value = [];
  tbSelected.value = [];
  importTab.value = 'pdd';
  purchaseOpen.value = true;
  loadPddOrders();
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

// ── 1688订单导入(miaoshou-helper 扩展桥接)────────────
// 协议:window.postMessage(source='erp-ali') ⇄ erp-bridge.js ⇄ background.js → 1688 mtop dataline
const ALI_NS = 'erp-ali';
const aliDialogOpen = ref(false);
const aliLoading = ref(false);
const aliError = ref('');
const aliOrders = ref([]);          // 精简后的 1688 订单列表
const aliTab = ref('all');          // 'all' | 'unshipped' | 'unreceived'
const aliSelected = ref([]);        // 已勾选的 orderSn
const aliBridgeReady = ref(false);  // 是否检测到扩展桥接
let aliReqSeq = 0;
const aliPending = new Map();       // reqId -> resolve

function aliRequest(payload) {
  return new Promise((resolve) => {
    const reqId = ++aliReqSeq;
    // 1688 需签名+可能一次 token 轮换重试,超时放宽到 20s
    const timer = setTimeout(() => {
      aliPending.delete(reqId);
      resolve({ ok: false, error: '请求超时:请确认 miaoshou-helper 扩展已启用并已重新加载(扩展更新后需刷新本页)' });
    }, 20_000);
    aliPending.set(reqId, (data) => { clearTimeout(timer); resolve(data); });
    window.postMessage({ source: ALI_NS, type: 'ALI_GET_ORDERS', reqId, payload }, window.location.origin);
  });
}

function onAliMessage(ev) {
  if (ev.source !== window || !ev.data || ev.data.source !== ALI_NS) return;
  if (ev.data.type === 'ALI_PONG') { aliBridgeReady.value = true; return; }
  if (ev.data.type === 'ALI_ORDERS_RESULT') {
    const cb = aliPending.get(ev.data.reqId);
    if (cb) { aliPending.delete(ev.data.reqId); cb(ev.data.data); }
  }
}

function aliPing() {
  window.postMessage({ source: ALI_NS, type: 'ALI_PING' }, window.location.origin);
}

async function loadAliOrders() {
  aliLoading.value = true;
  aliError.value = '';
  aliSelected.value = [];
  try {
    const resp = await aliRequest({ tab: aliTab.value, size: 30 });
    if (!resp.ok) throw new Error(resp.error || '获取订单失败');
    aliOrders.value = resp.orders || [];
  } catch (err) {
    aliError.value = err.message || String(err);
    aliOrders.value = [];
  } finally {
    aliLoading.value = false;
  }
}

async function openAliDialog() {
  aliDialogOpen.value = true;
  await loadAliOrders();
}

function switchAliTab(t) {
  if (aliTab.value === t || aliLoading.value) return;
  aliTab.value = t;
  loadAliOrders();
}

function isAliCancelled(o) {
  return /取消|关闭/.test(o.statusPrompt || '') || /close|cancel/i.test(o.status || '');
}

const aliSelectedOrders = computed(() =>
  aliOrders.value.filter((o) => aliSelected.value.includes(o.orderSn)));
const aliTotal = computed(() =>
  aliSelectedOrders.value.reduce((s, o) => s + Number(o.amount || 0), 0).toFixed(2));

/** 导入选中的 1688 订单回填采购表单 */
function applyAliSelection() {
  const sel = aliSelectedOrders.value;
  if (!sel.length) return;
  purchaseForm.platform = '1688';
  purchaseForm.purchaseSn = sel.map((o) => o.orderSn).join(',');
  const sellers = [...new Set(sel.map((o) => o.sellerName).filter(Boolean))];
  purchaseForm.sellerName = sellers.join(',');
  purchaseForm.paymentAmount = aliTotal.value;
  const tracks = sel.map((o) => o.trackingNumber).filter(Boolean);
  purchaseForm.logisticsNo = tracks.join(',');
  purchaseForm.logisticsCompany = tracks.length ? inferCourier(tracks[0]) : '';
  // 单订单+单商品行时自动填行金额,其余场景保持手动填写
  if (sel.length === 1 && sel[0].goods.length === 1 && purchaseForm.items.length === 1) {
    purchaseForm.items[0].amount = sel[0].amount;
  }
  aliDialogOpen.value = false;
  show(`已导入 ${sel.length} 个1688订单(金额 ¥${aliTotal.value}),请核对后保存`, 'success');
}

// ── 淘宝订单导入(miaoshou-helper 扩展桥接)────────────
// 协议:window.postMessage(source='erp-tb') ⇄ erp-bridge.js ⇄ background.js → 淘宝 mtop queryboughtlistV2
const TB_NS = 'erp-tb';
const tbDialogOpen = ref(false);
const tbLoading = ref(false);
const tbError = ref('');
const tbOrders = ref([]);          // 精简后的淘宝订单列表
const tbTab = ref('all');          // 'all' | 'unshipped' | 'unreceived'
const tbSelected = ref([]);        // 已勾选的 orderSn
const tbBridgeReady = ref(false);  // 是否检测到扩展桥接
let tbReqSeq = 0;
const tbPending = new Map();       // reqId -> resolve

function tbRequest(payload) {
  return new Promise((resolve) => {
    const reqId = ++tbReqSeq;
    const timer = setTimeout(() => {
      tbPending.delete(reqId);
      resolve({ ok: false, error: '请求超时:请确认 miaoshou-helper 扩展已启用并已重新加载(扩展更新后需刷新本页)' });
    }, 20_000);
    tbPending.set(reqId, (data) => { clearTimeout(timer); resolve(data); });
    window.postMessage({ source: TB_NS, type: 'TB_GET_ORDERS', reqId, payload }, window.location.origin);
  });
}

function onTbMessage(ev) {
  if (ev.source !== window || !ev.data || ev.data.source !== TB_NS) return;
  if (ev.data.type === 'TB_PONG') { tbBridgeReady.value = true; return; }
  if (ev.data.type === 'TB_ORDERS_RESULT') {
    const cb = tbPending.get(ev.data.reqId);
    if (cb) { tbPending.delete(ev.data.reqId); cb(ev.data.data); }
  }
}

function tbPing() {
  window.postMessage({ source: TB_NS, type: 'TB_PING' }, window.location.origin);
}

async function loadTbOrders() {
  tbLoading.value = true;
  tbError.value = '';
  tbSelected.value = [];
  try {
    const resp = await tbRequest({ tab: tbTab.value });
    if (!resp.ok) throw new Error(resp.error || '获取订单失败');
    tbOrders.value = resp.orders || [];
  } catch (err) {
    tbError.value = err.message || String(err);
    tbOrders.value = [];
  } finally {
    tbLoading.value = false;
  }
}

async function openTbDialog() {
  tbDialogOpen.value = true;
  await loadTbOrders();
}

function switchTbTab(t) {
  if (tbTab.value === t || tbLoading.value) return;
  tbTab.value = t;
  loadTbOrders();
}

function isTbCancelled(o) {
  return /关闭|取消|退款成功/.test(o.statusPrompt || '');
}

const tbSelectedOrders = computed(() =>
  tbOrders.value.filter((o) => tbSelected.value.includes(o.orderSn)));
const tbTotal = computed(() =>
  tbSelectedOrders.value.reduce((s, o) => s + Number(o.amount || 0), 0).toFixed(2));

/** 导入选中的淘宝订单回填采购表单 */
function applyTbSelection() {
  const sel = tbSelectedOrders.value;
  if (!sel.length) return;
  purchaseForm.platform = 'taobao';
  purchaseForm.purchaseSn = sel.map((o) => o.orderSn).join(',');
  const sellers = [...new Set(sel.map((o) => o.sellerName).filter(Boolean))];
  purchaseForm.sellerName = sellers.join(',');
  purchaseForm.paymentAmount = tbTotal.value;
  const tracks = sel.map((o) => o.trackingNumber).filter(Boolean);
  purchaseForm.logisticsNo = tracks.join(',');
  purchaseForm.logisticsCompany = tracks.length ? inferCourier(tracks[0]) : '';
  // 单订单+单商品行时自动填行金额,其余场景保持手动填写
  if (sel.length === 1 && sel[0].goods.length === 1 && purchaseForm.items.length === 1) {
    purchaseForm.items[0].amount = sel[0].amount;
  }
  tbDialogOpen.value = false;
  show(`已导入 ${sel.length} 个淘宝订单(金额 ¥${tbTotal.value}),请核对后保存`, 'success');
}

// ── 采购弹窗内嵌订单导入区(统一三平台,放在 PDD/ALI/TB 声明之后)──
// 当前平台的状态子 tab
const importSubTab = computed({
  get: () => (importTab.value === 'pdd' ? pddTab.value : importTab.value === 'ali' ? aliTab.value : tbTab.value),
  set: (v) => {
    if (importTab.value === 'pdd') pddTab.value = v;
    else if (importTab.value === 'ali') aliTab.value = v;
    else tbTab.value = v;
  },
});
const importSubTabs = computed(() => {
  if (importTab.value === 'pdd') return [{ key: 'all', label: '全部' }, { key: 'unreceived', label: '待收货' }];
  return [{ key: 'all', label: '全部' }, { key: 'unshipped', label: '待发货' }, { key: 'unreceived', label: '待收货' }];
});

// 当前平台的 orders / loading / error / selected
const importOrders = computed(() => importTab.value === 'pdd' ? pddOrders.value : importTab.value === 'ali' ? aliOrders.value : tbOrders.value);
const importLoading = computed(() => importTab.value === 'pdd' ? pddLoading.value : importTab.value === 'ali' ? aliLoading.value : tbLoading.value);
const importError = computed(() => importTab.value === 'pdd' ? pddError.value : importTab.value === 'ali' ? aliError.value : tbError.value);

// 统一选中模型:当前平台的 selected ref
const importSelected = computed({
  get: () => importTab.value === 'pdd' ? pddSelected.value : importTab.value === 'ali' ? aliSelected.value : tbSelected.value,
  set: (v) => {
    if (importTab.value === 'pdd') pddSelected.value = v;
    else if (importTab.value === 'ali') aliSelected.value = v;
    else tbSelected.value = v;
  },
});

// 跨三平台合并的已选订单(用于下方展示)
const allSelectedOrders = computed(() => {
  const sel = (orders, selected) => orders.filter((o) => selected.includes(o.orderSn));
  return [
    ...sel(pddOrders.value, pddSelected.value).map((o) => ({ ...o, _platform: 'yangkeduo' })),
    ...sel(aliOrders.value, aliSelected.value).map((o) => ({ ...o, _platform: '1688' })),
    ...sel(tbOrders.value, tbSelected.value).map((o) => ({ ...o, _platform: 'taobao' })),
  ];
});
const allSelectedTotal = computed(() =>
  allSelectedOrders.value.reduce((s, o) => s + Number(o.amount || 0), 0).toFixed(2));

function switchImportTab(t) {
  if (importTab.value === t || importLoading.value) return;
  importTab.value = t;
  if (t === 'pdd' && !pddOrders.value.length && !pddLoading.value) loadPddOrders();
  else if (t === 'ali' && !aliOrders.value.length && !aliLoading.value) loadAliOrders();
  else if (t === 'tb' && !tbOrders.value.length && !tbLoading.value) loadTbOrders();
}

function switchImportSubTab(t) {
  importSubTab.value = t;
  if (importTab.value === 'pdd') loadPddOrders();
  else if (importTab.value === 'ali') loadAliOrders();
  else loadTbOrders();
}

function isImportCancelled(o) {
  return /取消|关闭/.test(o.statusPrompt || '') || /close|cancel/i.test(o.status || '');
}

function platformLabelByVal(v) { return PLATFORMS.find((p) => p.value === v)?.label || v; }

/** 从下方选中区移除一单 */
function removeSelectedOrder(platform, orderSn) {
  if (platform === 'yangkeduo') pddSelected.value = pddSelected.value.filter((s) => s !== orderSn);
  else if (platform === '1688') aliSelected.value = aliSelected.value.filter((s) => s !== orderSn);
  else tbSelected.value = tbSelected.value.filter((s) => s !== orderSn);
}

/** 选中订单变化时自动回填 purchaseForm(无需手动点按钮) */
watch(allSelectedOrders, (sel) => {
  if (!sel.length) return;
  const first = sel[0];
  purchaseForm.platform = first._platform;
  purchaseForm.purchaseSn = sel.map((o) => o.orderSn).join(',');
  const sellers = [...new Set(sel.map((o) => o.mallName || o.sellerName).filter(Boolean))];
  purchaseForm.sellerName = sellers.join(',');
  purchaseForm.paymentAmount = allSelectedTotal.value;
  const tracks = sel.map((o) => o.trackingNumber).filter(Boolean);
  purchaseForm.logisticsNo = tracks.join(',');
  purchaseForm.logisticsCompany = tracks.length ? inferCourier(tracks[0]) : '';
  if (sel.length === 1 && sel[0].goods.length === 1 && purchaseForm.items.length === 1) {
    purchaseForm.items[0].amount = sel[0].amount;
  }
}, { deep: true });

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

// ── 打印 Ozon 面单(D1:隐藏 iframe + contentWindow.print() 一键弹打印)──
// 流程:拉 PDF(后端缓存优先)→ iframe 加载后自动弹系统打印框 →
//       打印框关闭后确认流转交运(取消则保持 wait_ship,可重复打印)
const printingId = ref(0); // 正在打印的包裹 id(按钮 loading)
let printFrame = null;      // 当前打印用隐藏 iframe(复用,避免每次重建)

function printBlobViaIframe(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    if (!printFrame) {
      printFrame = document.createElement('iframe');
      printFrame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
      document.body.appendChild(printFrame);
    }
    const frame = printFrame;
    const cleanup = () => {
      frame.onload = null;
      // 延时释放 objectURL,给 PDF 渲染留时间
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        // 打印框关闭(打印完成/取消)后 resolve
        win.onafterprint = () => { cleanup(); resolve(); };
        win.focus();
        win.print();
        // 兜底:onafterprint 未触发(部分浏览器)时,print() 同步返回后延时 resolve
        setTimeout(() => { cleanup(); resolve(); }, 3_000);
      } catch (e) {
        cleanup();
        reject(e);
      }
    };
    frame.onerror = () => { cleanup(); reject(new Error('面单加载失败')); };
    frame.src = url;
  });
}

async function onPrintLabel(pkg) {
  if (printingId.value) return;
  printingId.value = pkg.id;
  try {
    const blob = await fetchPackageLabel([pkg.id]);
    await printBlobViaIframe(blob);
    if (await confirmStore.ask({
      message: `包裹 ${pkg.packageNo} 的面单打印框已关闭,确认流转交运?(未实际打印可取消,稍后重打)`,
    })) {
      await markPrinted(pkg.id);
      show('面单已打印,流转交运', 'success');
      loadTabs();
      loadList();
    }
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    printingId.value = 0;
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

// 取消原因展示:reason_id 优先中文释义,否则俄文原文(可悬浮看 reason_id)
function cancelReasonLabel(pkg) {
  if (!pkg?.cancellationType) return null;
  const rid = pkg.cancelReasonId;
  const zh = CANCEL_REASON_LABELS[rid];
  return {
    initiator: pkg.cancellationType,  // client/ozon/seller
    text: zh || pkg.cancelReason || '取消',
    rid: rid || null,
    afterShip: pkg.cancelledAfterShip,
    affectRating: pkg.affectCancellationRating,
    isZh: !!zh,
    rawRu: pkg.cancelReason,
  };
}
// 取消发起者标签样式(seller 红色更显著,client 黄,ozon 灰)
function cancelInitiatorTagCls(type) {
  if (type === 'seller') return 'tag-err';
  if (type === 'client') return 'tag-warn';
  return 'tag-mute';
}
function cancelInitiatorShort(type) {
  if (type === 'seller') return '卖家';
  if (type === 'client') return '客户';
  if (type === 'ozon') return 'Ozon';
  return '?';
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
const route = useRoute();
onMounted(() => {
  loadTabs();
  // 外页跳入带 kw(如妙手订单页"本地包裹"按钮):预填关键词走全局搜索
  const kw = route.query.kw;
  if (kw) {
    globalSearch.keyword = String(kw);
    globalSearch.mode = 'eq';
    doGlobalSearch();
  } else {
    loadList();
  }
  loadSyncStatus();
  loadProgress();
  // 同步在跑时高频轮询进度,空闲时低频刷新 cursors
  statusTimer = setInterval(() => {
    if (progress.value?.active || syncing.value) loadProgress();
    else loadSyncStatus();
  }, 5_000);
  tickTimer = setInterval(() => { nowTs.value = Date.now(); }, 1000);
  // 拼多多/1688/淘宝导入桥接:监听扩展回包 + 主动探测(扩展公告可能早于本页挂载)
  window.addEventListener('message', onPddMessage);
  pddPing();
  window.addEventListener('message', onAliMessage);
  aliPing();
  window.addEventListener('message', onTbMessage);
  tbPing();
});
onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer);
  if (tickTimer) clearInterval(tickTimer);
  window.removeEventListener('message', onPddMessage);
  window.removeEventListener('message', onAliMessage);
  window.removeEventListener('message', onTbMessage);
  if (printFrame) {
    printFrame.remove();
    printFrame = null;
  }
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
        <span v-if="syncInfo.cursors?.length && !syncing" class="sync-info" :title="syncInfo.cursors.map(c => `${c.storeId}: ${c.lastError || c.lastRunAt}`).join('\n')">
          最近同步 {{ fmtTime(syncInfo.cursors[0]?.lastRunAt) }}
        </span>
        <button class="btn btn-ghost" :disabled="syncing" @click="triggerSync" title="增量同步:unfulfilled [now-14d, now+14d] + list [now-60d, now],双接口">
          {{ syncing ? '同步中…' : '同步进行中订单' }}
        </button>
        <button class="btn btn-ghost" :disabled="syncing" @click="openSyncAllDialog" title="全量同步:仅 /v4/posting/fbs/list,覆盖所有状态含 delivered/cancelled 终态,可选时间范围">
          同步所有订单
        </button>
      </div>
    </div>

    <!-- 同步进度条(进行中或已完成未关闭) -->
    <div v-if="showProgressBar" class="sync-progress-bar" :class="{ 'sync-progress-finished': progressFinished }">
      <div class="sync-progress-header">
        <span class="tag" :class="progressFinished ? (progress.errorCount > 0 ? 'tag-warn' : 'tag-ok') : 'tag-info'">
          {{ progressFinished ? (progress.errorCount > 0 ? `完成(${progress.errorCount}店失败)` : '完成') : progressTypeLabel }}
        </span>
        <span class="sync-progress-text">
          店铺 <b>{{ progress.doneStores || 0 }}/{{ progress.totalStores || 0 }}</b>
          <template v-if="!progressFinished && progress.currentStoreName"> · 当前 {{ progress.currentStoreName }}</template>
          <template v-if="!progressFinished && progressPhaseLabel"> · {{ progressPhaseLabel }}第 {{ progress.currentPage + 1 }} 页</template>
          · 已拉 <b>{{ progress.postingsPulled || 0 }}</b> 单
          · 用时 {{ fmtElapsed(progress.elapsedMs) }}
        </span>
        <button v-if="progressFinished" class="btn btn-ghost btn-sm sync-progress-close" @click="dismissProgress" title="关闭进度条">✕</button>
      </div>
      <div class="sync-progress-track">
        <div class="sync-progress-fill" :class="{ 'sync-progress-fill-done': progressFinished }" :style="{ width: progressPct + '%' }"></div>
      </div>
      <div v-if="progress.message" class="sync-progress-msg">{{ progress.message }}</div>

      <!-- 失败店铺列表(可展开) -->
      <div v-if="progress.failures?.length" class="sync-failures">
        <button class="sync-failures-toggle" @click="showFailures = !showFailures">
          {{ showFailures ? '▼' : '▶' }} 失败 {{ progress.failures.length }} 店:{{ progress.failures.map(f => f.storeName).join(', ') }}
        </button>
        <div v-if="showFailures" class="sync-failures-list">
          <div v-for="(f, i) in progress.failures" :key="i" class="sync-failure-item">
            <div class="sync-failure-head">
              <b>{{ f.storeName }}</b>
              <span class="muted">{{ f.phase || '?' }}第 {{ (f.page || 0) + 1 }} 页</span>
            </div>
            <div class="sync-failure-error">{{ f.error }}</div>
            <div v-if="f.stack" class="sync-failure-stack">{{ f.stack }}</div>
          </div>
        </div>
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
        <!-- 取消发起者筛选(仅已取消 tab 显示) -->
        <select v-if="activeTab === 'cancelled'" v-model="filters.cancelInitiator" class="filter-input" @change="search">
          <option value="">全部发起者</option>
          <option v-for="opt in CANCEL_INITIATOR_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
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
              <!-- 取消原因细分标签(仅 cancelled 状态订单显示) -->
              <div v-if="pkg.ozonStatus === 'cancelled' && cancelReasonLabel(pkg)" class="sub cancel-reason-line">
                <span class="tag" :class="cancelInitiatorTagCls(cancelReasonLabel(pkg).initiator)">{{ cancelInitiatorShort(cancelReasonLabel(pkg).initiator) }}</span>
                <span class="cancel-reason-text" :title="cancelReasonLabel(pkg).rawRu + (cancelReasonLabel(pkg).rid ? ' (#' + cancelReasonLabel(pkg).rid + ')' : '')">
                  {{ cancelReasonLabel(pkg).text }}<template v-if="cancelReasonLabel(pkg).rid && !cancelReasonLabel(pkg).isZh"> #{{ cancelReasonLabel(pkg).rid }}</template>
                </span>
                <span v-if="cancelReasonLabel(pkg).afterShip" class="tag tag-mute" title="装运后取消">装运后</span>
                <span v-if="cancelReasonLabel(pkg).affectRating" class="tag tag-err" title="影响排行">影响排行</span>
              </div>
              <div class="sub muted">下单：{{ fmtTime(pkg.inProcessAt) }}</div>
              <!-- 已取消订单不再展示最迟/剩发/已超时(取消后无发货义务,倒计时无意义) -->
              <div v-if="pkg.shipmentDate && !pkg.isShipped && pkg.ozonStatus !== 'cancelled'" class="sub muted">最迟：{{ fmtTime(pkg.shipmentDate) }}</div>
              <div v-if="countdown(pkg) && !pkg.isShipped && pkg.ozonStatus !== 'cancelled'" class="sub" :class="countdown(pkg).overdue ? 'overdue' : 'countdown'">
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
                  class="btn btn-primary btn-sm"
                  :disabled="printingId === pkg.id"
                  :title="printingId === pkg.id ? '面单获取中…' : '拉取 Ozon 面单 PDF 并弹出打印框,打印后流转交运'"
                  @click="onPrintLabel(pkg)"
                >{{ printingId === pkg.id ? '打印中…' : '打印面单' }}</button>
                <button
                  v-if="pkg.operateStatus === 'wait_ship'"
                  class="btn btn-ghost btn-sm"
                  title="不拉取面单,仅标记已打印并流转交运(补录场景)"
                  @click="onPrinted(pkg)"
                >仅标记交运</button>
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

    <!-- 同步所有订单弹窗(/v4/posting/fbs/list 全量) -->
    <AppModal :open="syncAllOpen" title="同步所有订单 · /v4/posting/fbs/list" size="md" @update:open="syncAllOpen = $event">
      <div class="sync-all-form">
        <div class="sync-all-tip">
          调用 <code>/v4/posting/fbs/list</code> 拉取指定时间段所有订单(含 delivered/cancelled 终态),适合历史回补/状态校准。
          <br />同步进行中其他同步按钮会自动禁用(并发保护)。
        </div>

        <!-- 快捷选项(点击自动填充下方起止日期) -->
        <div class="sync-all-section-label">快捷选项</div>
        <div class="sync-all-quick">
          <button
            v-for="opt in QUICK_OPTIONS"
            :key="opt.days"
            class="pdd-tab"
            :class="{ active: syncAllQuick === opt.days }"
            @click="applyQuickOption(opt.days)"
          >{{ opt.label }}</button>
        </div>

        <!-- 起止日期(默认填好,可直接编辑) -->
        <div class="sync-all-section-label">时间段</div>
        <div class="sync-all-dates">
          <div class="sync-all-date-row">
            <label>起始</label>
            <input type="date" v-model="syncAllSince" class="filter-input" @input="onSinceInput" />
          </div>
          <div class="sync-all-date-row">
            <label>结束</label>
            <input type="date" v-model="syncAllTo" class="filter-input" @input="onToInput" />
          </div>
        </div>

        <div class="form-actions">
          <button class="btn btn-ghost" @click="syncAllOpen = false">取 消</button>
          <button class="btn btn-primary" :disabled="syncAllSubmitting" @click="triggerSyncAllList">
            {{ syncAllSubmitting ? '启动中…' : '开始同步' }}
          </button>
        </div>
      </div>
    </AppModal>

    <!-- 提交采购信息弹窗(模式B) -->
    <AppModal :open="purchaseOpen" :title="`提交采购信息 · ${purchaseForm.packageNo}`" size="lg" @update:open="purchaseOpen = $event">
      <div class="purchase-form">
        <!-- 平台 tab:拼多多 / 1688 / 淘宝 / 手动录入 -->
        <div class="import-platform-tabs">
          <button class="pdd-tab" :class="{ active: importTab === 'pdd' }" @click="switchImportTab('pdd')">拼多多</button>
          <button class="pdd-tab" :class="{ active: importTab === 'ali' }" @click="switchImportTab('ali')">1688</button>
          <button class="pdd-tab" :class="{ active: importTab === 'tb' }" @click="switchImportTab('tb')">淘宝</button>
          <button class="pdd-tab" :class="{ active: importTab === 'manual' }" @click="importTab = 'manual'">手动录入</button>
          <span v-if="importTab !== 'manual' && (!pddBridgeReady || !aliBridgeReady || !tbBridgeReady)" class="pdd-bridge-warn" title="需要安装/启用 miaoshou-helper 扩展">未检测到助手扩展</span>
        </div>

        <!-- 手动录入 tab -->
        <div v-if="importTab === 'manual'" class="manual-input-section">
          <div class="form-row">
            <label>采购金额</label>
            <input v-model.trim="purchaseForm.paymentAmount" class="filter-input" placeholder="如 29.21" />
            <label>采购平台</label>
            <select v-model="purchaseForm.platform" class="filter-input">
              <option v-for="p in PLATFORMS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>国内快递单号</label>
            <input v-model.trim="purchaseForm.logisticsNo" class="filter-input" placeholder="上家发货单号(填了视为已发货)" />
            <label>物流公司</label>
            <input v-model.trim="purchaseForm.logisticsCompany" class="filter-input" placeholder="如 顺丰/韵达/极兔" />
          </div>
        </div>

        <!-- 平台订单 tab -->
        <div v-else class="import-section">
          <div class="pdd-toolbar">
            <div class="pdd-tabs">
              <button v-for="st in importSubTabs" :key="st.key" class="pdd-tab" :class="{ active: importSubTab === st.key }" @click="switchImportSubTab(st.key)">{{ st.label }}</button>
            </div>
            <button class="btn btn-ghost btn-sm" :disabled="importLoading" @click="importTab === 'pdd' ? loadPddOrders() : importTab === 'ali' ? loadAliOrders() : loadTbOrders()">刷新</button>
          </div>

          <div v-if="importLoading" class="empty">加载中…</div>
          <div v-else-if="importError" class="pdd-error">{{ importError }}</div>
          <div v-else-if="!importOrders.length" class="empty">没有查询到订单</div>
          <div v-else class="pdd-list">
            <label
              v-for="o in importOrders"
              :key="o.orderSn"
              class="pdd-item"
              :class="{ disabled: isImportCancelled(o), selected: importSelected.includes(o.orderSn) }"
            >
              <input
                type="checkbox"
                :value="o.orderSn"
                :disabled="isImportCancelled(o)"
                v-model="importSelected"
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
                  <span class="pdd-mall">{{ o.mallName || o.sellerName || '—' }}</span>
                  <span class="pdd-amount">¥{{ o.amount }}</span>
                  <span>{{ importTab === 'pdd' ? fmtTime(o.orderTime * 1000) : (o.orderTime || '—') }}</span>
                  <span class="tag" :class="isImportCancelled(o) ? 'tag-mute' : 'tag-info'">{{ o.statusPrompt || '—' }}</span>
                </div>
                <div class="pdd-sn mono">
                  {{ o.orderSn }}<template v-if="o.trackingNumber"> · {{ o.trackingNumber }}</template>
                </div>
              </div>
            </label>
          </div>

          <!-- 已选订单展示区(跨平台合并) -->
          <div v-if="allSelectedOrders.length" class="selected-orders">
            <div class="selected-orders-title">已选 {{ allSelectedOrders.length }} 单 · 合计 ¥{{ allSelectedTotal }}</div>
            <div v-for="o in allSelectedOrders" :key="o._platform + o.orderSn" class="selected-order-item">
              <span class="tag tag-info">{{ platformLabelByVal(o._platform) }}</span>
              <span class="selected-order-goods" :title="o.goods[0]?.goodsName">{{ o.goods[0]?.goodsName || '—' }}</span>
              <span class="pdd-amount">¥{{ o.amount }}</span>
              <span class="selected-order-sn mono">{{ o.orderSn }}</span>
              <button class="btn btn-ghost btn-sm" @click="removeSelectedOrder(o._platform, o.orderSn)">✕</button>
            </div>
          </div>
        </div>

        <!-- 采购金额(按行填写) -->
        <div class="form-section-title">订单产品 · 采购金额(按行填写)</div>
        <table class="data-table item-table">
          <thead>
            <tr>
              <th style="width: 260px">产品</th>
              <th>数量</th>
              <th>售价</th>
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
              <td>
                <input v-model.trim="it.amount" class="filter-input amount-input" placeholder="0.00" />
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 物流信息(平台导入自动填,手动录入在此输入) -->
        <div v-if="importTab !== 'manual'" class="form-row" style="margin-top: 12px">
          <label>国内快递单号</label>
          <input v-model.trim="purchaseForm.logisticsNo" class="filter-input" placeholder="上家发货单号(填了视为已发货)" />
          <label>物流公司</label>
          <input v-model.trim="purchaseForm.logisticsCompany" class="filter-input" placeholder="如 顺丰/韵达/极兔" />
        </div>

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

        <!-- 取消原因详情(仅已取消订单显示) -->
        <div v-if="detail.package.ozonStatus === 'cancelled' && cancelReasonLabel(detail.package)" class="detail-section cancel-detail">
          <div class="detail-section-title">取消原因 <span class="tag" :class="cancelInitiatorTagCls(cancelReasonLabel(detail.package).initiator)">{{ cancelInitiatorShort(cancelReasonLabel(detail.package).initiator) }}</span></div>
          <div class="cancel-detail-grid">
            <div><span class="dl">原因 ID</span><span class="mono">#{{ detail.package.cancelReasonId || '—' }}</span></div>
            <div><span class="dl">中文释义</span>{{ cancelReasonLabel(detail.package).isZh ? cancelReasonLabel(detail.package).text : '—' }}</div>
            <div class="cancel-detail-raw"><span class="dl">俄文原文</span>{{ detail.package.cancelReason || '—' }}</div>
            <div><span class="dl">发起者</span>{{ detail.package.cancellationInitiator || '—' }}({{ cancelInitiatorShort(detail.package.cancellationType) }})</div>
            <div><span class="dl">装运后取消</span>{{ detail.package.cancelledAfterShip ? '是' : '否' }}</div>
            <div><span class="dl">影响排行</span>{{ detail.package.affectCancellationRating ? '是' : '否' }}</div>
          </div>
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

/* 同步进度条 */
.sync-progress-bar {
  margin-bottom: 12px;
  padding: 10px 14px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
}
.sync-progress-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #1d4ed8;
  flex-wrap: wrap;
}
.sync-progress-text {
  flex: 1;
  min-width: 0;
}
.sync-progress-track {
  margin-top: 6px;
  height: 6px;
  background: #dbeafe;
  border-radius: 3px;
  overflow: hidden;
}
.sync-progress-fill {
  height: 100%;
  background: #2563eb;
  transition: width 0.5s ease;
}
/* 完成态:进度条变绿(有失败保持原色由 tag-warn 提示) */
.sync-progress-fill-done {
  background: #16a34a;
}
.sync-progress-finished .sync-progress-track {
  background: #dcfce7;
}
.sync-progress-close {
  margin-left: auto;
  padding: 0 6px;
  font-size: 14px;
  line-height: 1;
}
.sync-progress-msg {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
}

/* 失败店铺列表 */
.sync-failures {
  margin-top: 8px;
  border-top: 1px dashed #fca5a5;
  padding-top: 6px;
}
.sync-failures-toggle {
  background: transparent;
  border: none;
  font-size: 12px;
  color: #dc2626;
  cursor: pointer;
  padding: 2px 0;
  text-align: left;
}
.sync-failures-toggle:hover {
  text-decoration: underline;
}
.sync-failures-list {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sync-failure-item {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 11px;
}
.sync-failure-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: #991b1b;
  margin-bottom: 2px;
}
.sync-failure-error {
  color: #7f1d1d;
  word-break: break-all;
  font-family: ui-monospace, monospace;
}
.sync-failure-stack {
  margin-top: 4px;
  color: #6b7280;
  font-family: ui-monospace, monospace;
  font-size: 10px;
  word-break: break-all;
  white-space: pre-wrap;
}

/* 同步所有订单弹窗 */
.sync-all-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sync-all-tip {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  background: #f9fafb;
  border-radius: 6px;
  padding: 8px 10px;
  line-height: 1.6;
}
.sync-all-tip code {
  font-family: ui-monospace, monospace;
  background: #eef2ff;
  padding: 1px 4px;
  border-radius: 3px;
  color: #4338ca;
}
.sync-all-section-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary, #6b7280);
  margin-top: 4px;
}
.sync-all-quick {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.sync-all-dates {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.sync-all-date-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 200px;
}
.sync-all-date-row label {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  white-space: nowrap;
}
.sync-all-date-row input {
  flex: 1;
  min-width: 0;
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

/* 采购弹窗内嵌订单导入区 */
.import-section {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border, #e8e8e8);
}
.manual-input-section {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border, #e8e8e8);
}
.import-platform-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}
.selected-orders {
  margin-top: 8px;
  padding: 8px;
  background: var(--bg-soft, #f5f5f5);
  border-radius: 6px;
}
.selected-orders-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.selected-order-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 12px;
}
.selected-order-goods {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selected-order-sn {
  font-size: 11px;
  color: var(--text-muted, #999);
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

/* 取消原因行(列表) */
.cancel-reason-line {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 3px;
}
.cancel-reason-text {
  font-size: 11px;
  color: #991b1b;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 取消原因详情(详情弹窗) */
.detail-section-title {
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.cancel-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 20px;
  font-size: 12px;
}
.cancel-detail-raw {
  grid-column: 1 / -1;
}
.cancel-detail-raw .dl {
  display: inline-block;
  min-width: 72px;
  color: var(--text-secondary, #6b7280);
  vertical-align: top;
}
.cancel-detail-raw {
  color: #7f1d1d;
  font-family: ui-monospace, monospace;
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
