<script setup>
// 订单处理(2026-08,个人自发货模式)
// 数据来源:order-sync.js 定时同步的 Ozon FBS 订单(op_* 表),本页管理采购录入与关联
// 设计文档: docs/采购订单-Ozon订单关联管理-功能设计.md
// 核心流程:买家Ozon下单 → 我采购(提交采购信息→直接流转待打单发货) → 上家发货给我
//          → 轨迹签收=到货(标记提示) → 我自行打包打面单 → 交运 → 妥投回款
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { parseUtcDate } from '../utils/time.js';
import { useRoute } from 'vue-router';
import {
  getOrderTabs, getOrderList, getOrderDetail,
  submitPurchase, lookupPurchase, unlinkPurchase, clearPurchaseInfo, revertPackage, ignorePackage, markPrinted, fetchPackageLabel,
  updatePackageMeta, listPackageTags, updateTagOrder,
  runSync, runSyncAllList, getSyncStatus, getSyncProgress, dismissSyncProgress,
  runAccrualSync, getRubRate, setRubRate,
  syncMsToLocal,
  enrichPurchaseItems,
  listPendingPurchases,
  syncPurchaseLogistics, getPurchaseLogisticsProgress,
  syncPackagePurchaseLogistics,
  getOrderSummary,
  syncPackage,
  shipPackage,
  getPlatformOrders, searchPlatformOrder, getPlatformOrdersStatus, syncPddCookies,
  getPendingExportState,
} from '../api/order-process.js';
import { useToast } from '../components/useToast.js';
import { useConfirmStore } from '../stores/confirm.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import { pickLabelPrinter, printLabelImage, previewLabelImage } from '../api/print-agent.js';

const { show } = useToast();
const confirmStore = useConfirmStore();

// ── Tab 页签(operate_status 分流)─────────────────────────
// 全部:跨所有状态(含搁置);已发货=已交运未妥投;已成功=已妥投且应计完整
// 已退货:妥投后买家退货退款(is_returned,来自 /v2/returns/rfbs/list)
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
const activeTab = ref('waitProcess');
const tabCounts = ref({});

// ── 筛选 ───────────────────────────────────────────────
const filters = reactive({
  keyword: '',
  purchaseStatus: '', // '' | 'none' | 'purchased' | 'multi'(多条采购) | 'manual'(手工采购)
  noteFilter: '',     // '' | 'has' | 'none' 备注筛选(2026-09-15)
  tag: '',            // 标签筛选:标签名精确匹配(2026-09-15)
  arrived: '',        // '' | '0' | '1'
  cancelInitiator: '',  // '' | 'client' | 'ozon' | 'seller'(仅已取消 tab 用)
});
// 已用标签选项(筛选下拉):[{ name, count }](2026-09-15)
const tagOptions = ref([]);
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

// ── 订单金额统计(全量订单口径,不随 tab/筛选变化,2026-09-18)──────
const summary = ref(null);
const summaryLoading = ref(false);
const summaryError = ref(null);
let summaryReqId = 0;
let lastSummaryParams = null;
// 明细三卡(已成功/已取消/已退货)默认折叠,点击"展开明细"切换(2026-09-18)
const summaryDetailOpen = ref(false);
const summaryEmpty = computed(() => summary.value && summary.value.totalOrders === 0);
// 全量统计空态提示(不再随 tab 变化)
const summaryEmptyHint = '暂无订单数据,同步订单后展示统计';
async function loadSummary(params) {
  const reqId = ++summaryReqId;
  lastSummaryParams = params;
  summaryLoading.value = true;
  summaryError.value = null;
  try {
    const data = await getOrderSummary(params);
    if (reqId !== summaryReqId) return;  // 旧响应丢弃,防快速切 Tab 覆盖
    summary.value = data;
  } catch (err) {
    if (reqId !== summaryReqId) return;
    summaryError.value = err.message || String(err);
  } finally {
    if (reqId === summaryReqId) summaryLoading.value = false;
  }
}

// ── 采购录入弹窗(模式B)────────────────────────────────
const purchaseOpen = ref(false);
const purchaseSaving = ref(false);
const purchaseForm = reactive({
  packageId: null,
  packageNo: '',
  platform: 'other',
  purchaseSn: '',
  buyerAccount: '',
  buyerUserId: '',   // 平台用户ID(导入平台订单自动附带;非表单项,随提交透传)
  sellerName: '',
  paymentAmount: '',
  logisticsCompany: '',
  logisticsNo: '',
  note: '',
  allocMode: 'auto', // 'auto'=勾选自动填写金额, 'manual'=取消勾选手动填写
  items: [], // [{ itemId, offerId, title, quantity, amount }]
  platformGoods: [], // 选中平台订单的商品(图片/数量/规格),随提交写入 items_json,免事后补全
});
// auto 模式拼单预览:查询已关联包裹信息(含数量,用于加权分摊预览)
const lookupResult = ref(null);
const lookupLoading = ref(false);
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
const syncingMs = ref(false);

// ── 待导出徽标(采购信息跨机文件同步)─────────────────────
// 本机跑过 scripts/export-purchase-sync.mjs 才激活(active=true);
// count = 上次导出后有采购/称重/交运/搁置变更的包裹数(提示性,提醒把数据导出给服务器)
const pendingExport = ref({ active: false, count: 0, lastExportAt: null });
async function loadPendingExport() {
  try {
    const resp = await getPendingExportState();
    pendingExport.value = resp?.data || resp || { active: false, count: 0 };
  } catch { /* 静默:徽标失败不影响页面 */ }
}

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
  const isGlobal = globalSearch.active && globalSearch.keyword.trim();
  const listParams = {
    tab: activeTab.value,
    keyword: filters.keyword.trim(),
    purchaseStatus: filters.purchaseStatus,
    noteFilter: filters.noteFilter,
    tag: filters.tag,
    arrived: filters.arrived,
    cancelInitiator: activeTab.value === 'cancelled' ? filters.cancelInitiator : '',
    globalKeyword: isGlobal ? globalSearch.keyword.trim() : '',
    globalMode: globalSearch.mode,
    page: pager.current,
    pageSize: pager.pageSize,
  };
  // 订单金额统计并行触发(2026-09-18:全量订单口径,tab='all' 走后端"全部"分支(1=1),不随当前tab/筛选变化)
  loadSummary({ tab: 'all' });
  try {
    const data = await getOrderList(listParams);
    globalSearch.total = isGlobal ? (data?.total || 0) : 0;
    rows.value = data?.packages || [];
    pager.total = data?.total || 0;
    rubRate.value = data?.rubRate || null;
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

// 已取消卡片:点击细分 chip(买家/Ozon/卖家)→ 切到已取消 tab 并应用对应发起者筛选
function applyCancelInitiatorFilter(initiator) {
  if (globalSearch.active) clearGlobalSearch(false);
  activeTab.value = 'cancelled';
  filters.cancelInitiator = initiator;
  pager.current = 1;
  loadList();
}

// 比率百分比(保留2位):part/total,分母为0显示 —;用于整体卡的退货率/取消率
function ratePct(part, total) {
  if (!total) return '—';
  return (Math.round((part / total) * 10000) / 100) + '%';
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

// 点击 SKU(2026-09-17):页内导航到全局搜索该 SKU 的相关订单(跨所有状态,精确匹配)
async function searchBySku(sku) {
  const kw = String(sku || '').trim();
  if (!kw) return;
  globalSearch.keyword = kw;
  globalSearch.mode = 'eq';
  globalSearch.active = true;
  pager.current = 1;
  await loadList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

// 从妙手同步到本地订单(重量/备注/采购金额/采购订单详情)
// 有勾选行时同步勾选的,无勾选时同步当前筛选全部
async function onSyncMsToLocal() {
  if (syncingMs.value) return;
  const selectedRows = rows.value.filter((r) => r._checked);
  const isPartial = selectedRows.length > 0;
  const scopeLabel = isPartial ? `勾选的 ${selectedRows.length} 条` : '当前筛选全部(以 logistics_no 关联妙手)';
  if (!await confirmStore.ask({
    message: `将把妙手订单的重量/备注/旗帜备注/采购金额/采购订单详情同步到本地,范围:${scopeLabel}。妙手侧已有采购信息的订单,会先清空本地已录入的采购信息(采购单关联/金额/国内物流单号),再以妙手数据为准重新写入;妙手侧无采购信息的订单保留本地已有。妙手备注将覆盖本地备注;妙手旗帜备注将作为本地标签写入(已有同名标签不重复);有采购单关联的待处理订单将自动推进到待打单发货。确认继续?`,
    confirmText: '开始同步',
    danger: true,
  })) return;
  syncingMs.value = true;
  try {
    const packageIds = isPartial ? selectedRows.map((r) => r.id) : null;
    const resp = await syncMsToLocal(packageIds);
    const data = resp?.data || resp || {};
    const { synced = 0, skipped = 0, purchases = 0, advanced = 0, cleared = 0, errors = [] } = data;
    let msg = `已同步 ${synced} 条(采购单 ${purchases} 条`;
    if (cleared > 0) msg += `,清除旧采购信息 ${cleared} 条`;
    if (advanced > 0) msg += `,推进待打单 ${advanced} 条`;
    if (skipped > 0) msg += `,跳过 ${skipped} 条(无妙手匹配)`;
    msg += ')';
    if (errors.length > 0) msg += `,失败 ${errors.length} 条`;
    show(msg, errors.length > 0 ? 'warning' : 'success');
    await loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    syncingMs.value = false;
  }
}

// 补全采购订单商品信息(支持拼多多+1688+淘宝)
// 逻辑:后端 listPendingPurchases 返回所有 items_json 不含 thumbUrl 的采购单(不限当前页),
//      串行+限速(2s/单,失败退避到 5s)逐个调后端平台订单搜索接口
//      (/admin/api/platform-orders/:platform/search,cloakbrowser 直取),
//      每 10 条一批推送后端,避免一次性大 payload;连续失败 3 次中止防反爬
const enrichingItems = ref(false);
let enrichStopFlag = false;
const enrichProgress = reactive({ total: 0, done: 0, found: 0, notFound: 0, failed: 0, updated: 0, current: '', platform: '' });
const ENRICH_INTERVAL_MS = 2000;   // 正常每单间隔 2s
const ENRICH_BACKOFF_MS = 5000;     // 失败后下次间隔延长到 5s
const ENRICH_MAX_CONSEC_FAIL = 3;   // 连续失败 3 次中止
const ENRICH_BATCH_SIZE = 10;       // 每 10 条推送一次后端
function enrichStop() { enrichStopFlag = true; }

// 构建补全确认弹窗的 message:展示按平台分组的采购订单号列表(前 20 条 + 更多提示)
function buildEnrichConfirmMessage(pending, platforms) {
  const platformLabels = { yangkeduo: '拼多多', '1688': '1688', taobao: '淘宝' };
  const lines = [];
  lines.push(`检测到 ${pending.length} 条待补全采购单(${platforms.join('+')},全量,不限当前页)。`);
  lines.push(`将逐个搜索补全商品图/数量,每单间隔 ${ENRICH_INTERVAL_MS / 1000}s 限速,连续失败 ${ENRICH_MAX_CONSEC_FAIL} 次自动中止。`);
  lines.push('此操作由 ERP 后端浏览器取数,需在 qxqx 的 persistent 中已登录对应平台。');
  lines.push('');
  lines.push('── 待补全采购订单号 ──');
  // 按平台分组展示
  const MAX_SHOW = 20; // 每平台最多展示前 20 条
  for (const plat of ['yangkeduo', '1688', 'taobao']) {
    const group = pending.filter((p) => p._platform === plat);
    if (!group.length) continue;
    const label = platformLabels[plat] || plat;
    lines.push(`【${label}】${group.length} 条:`);
    const shown = group.slice(0, MAX_SHOW);
    for (const p of shown) lines.push(`  ${p.purchaseSn || '(无单号)'}`);
    if (group.length > MAX_SHOW) lines.push(`  ... 还有 ${group.length - MAX_SHOW} 条`);
  }
  lines.push('');
  lines.push('是否继续?');
  return lines.join('\n');
}
async function onEnrichPurchaseItems() {
  if (enrichingItems.value) return;
  // 拉取全部待补全采购单(拼多多+1688+淘宝,不限当前页)
  let pending = [];
  const platforms = [];
  try {
    const [pddResp, aliResp, tbResp] = await Promise.all([
      listPendingPurchases('yangkeduo'),
      listPendingPurchases('1688'),
      listPendingPurchases('taobao'),
    ]);
    const pddList = (pddResp?.data || pddResp || []).map((p) => ({ ...p, _platform: 'yangkeduo' }));
    const aliList = (aliResp?.data || aliResp || []).map((p) => ({ ...p, _platform: '1688' }));
    const tbList = (tbResp?.data || tbResp || []).map((p) => ({ ...p, _platform: 'taobao' }));
    pending = [...pddList, ...aliList, ...tbList];
    if (pddList.length) platforms.push('拼多多');
    if (aliList.length) platforms.push('1688');
    if (tbList.length) platforms.push('淘宝');
  } catch (e) {
    show('拉取待补全列表失败:' + (e.message || e), 'error');
    return;
  }
  if (!pending.length) {
    show('无待补全的采购单(全部已补全或无单号)', 'info');
    return;
  }
  // 检查对应平台登录态(后端浏览器 cookie 探测,替代原扩展桥就绪检查)
  // 'yes' 仅代表登录 cookie 存在,session 真实失效由请求时的 AUTH_REQUIRED 提示兜底;
  // 多账号:平台任一账号非明确 'no' 即放行(搜索后端会跨账号)
  const platformAnyLogin = (platformVal) => importAccountTabs.value
    .filter((t) => PLATFORM_TAB_META[t.platform]?.platformVal === platformVal)
    .some((t) => platformLogin[`${t.platform}:${t.account}`] !== 'no');
  const needPdd = pending.some((p) => p._platform === 'yangkeduo');
  const needAli = pending.some((p) => p._platform === '1688');
  const needTb = pending.some((p) => p._platform === 'taobao');
  if (needPdd && !platformAnyLogin('yangkeduo')) {
    show('拼多多补全需要先登录:请运行 qxqx 的 persistent(账号参数)登录拼多多后重试', 'warning');
    return;
  }
  if (needAli && !platformAnyLogin('1688')) {
    show('1688补全需要先登录:请运行 qxqx 的 persistent(账号参数)登录1688后重试', 'warning');
    return;
  }
  if (needTb && !platformAnyLogin('taobao')) {
    show('淘宝补全需要先登录:请运行 qxqx 的 persistent(账号参数)登录淘宝后重试', 'warning');
    return;
  }
  if (!await confirmStore.ask({
    title: '补全采购订单信息',
    message: buildEnrichConfirmMessage(pending, platforms),
    confirmText: '开始补全',
  })) return;
  enrichingItems.value = true;
  enrichStopFlag = false;
  Object.assign(enrichProgress, { total: pending.length, done: 0, found: 0, notFound: 0, failed: 0, updated: 0, current: pending[0]?.purchaseSn || '', platform: platforms.join('+') });
  const items = [];
  let consecFail = 0;
  let lastErr = '';
  try {
    let i = 0;
    for (const p of pending) {
      if (enrichStopFlag) break;
      i++;
      enrichProgress.done = i;
      enrichProgress.current = p.purchaseSn || '';
      // 按平台路由到后端搜索(后端跨该平台全部账号依次搜)
      // platformKey 为入库平台值 'yangkeduo'|'1688'|'taobao',转为请求平台键
      const platformKey = p._platform;
      // 数据库 platform 值(yangkeduo/1688/taobao)→ API platform key(pdd/ali1688/taobao)
      // 修复(2026-09-13):原仅转 1688→ali1688 漏 yangkeduo→pdd,导致 PDD 搜索全 404
      const reqPlatform = platformKey === 'yangkeduo' ? 'pdd'
                        : platformKey === '1688' ? 'ali1688'
                        : platformKey;
      let ok = false;
      try {
        const resp = await platformSearchReq(reqPlatform, p.purchaseSn);
        if (resp?.ok && resp.result && Array.isArray(resp.result.goods) && resp.result.goods.length) {
          items.push({
            purchaseSn: p.purchaseSn,
            platform: platformKey,
            goods: resp.result.goods.map((g) => ({
              goodsName: g.goodsName || '',
              spec: g.spec || '',
              price: g.price,
              number: g.number || 1,
              thumbUrl: g.thumbUrl || '',
            })),
          });
          enrichProgress.found++;
          ok = true;
        } else {
          enrichProgress.notFound++;
          // 超时/登录失效等 {ok:false} 响应也记录错误文案,供连续失败中止提示引用
          if (resp && resp.error) lastErr = resp.error;
        }
      } catch (e) {
        enrichProgress.failed++;
        lastErr = e.message || String(e);
      }
      // 连续失败计数:成功重置,失败累加;达阈值中止防反爬
      if (ok) consecFail = 0;
      else {
        consecFail++;
        if (consecFail >= ENRICH_MAX_CONSEC_FAIL) {
          show(`连续 ${ENRICH_MAX_CONSEC_FAIL} 次失败,已中止(可能触发反爬或登录失效)。最后错误:${lastErr}`, 'warning');
          break;
        }
      }
      // 每 10 条一批推送后端(避免一次性大 payload + 中途中断不丢已采集数据)
      if (items.length >= ENRICH_BATCH_SIZE) {
        await flushEnrichBatch(items);
      }
      // 限速:正常 2s,失败后退避 5s;最后一单不等
      if (i < pending.length && !enrichStopFlag) {
        const delay = ok ? ENRICH_INTERVAL_MS : ENRICH_BACKOFF_MS;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    // 收尾:刷剩余未入库的批次
    if (items.length) await flushEnrichBatch(items);
    // 汇总
    let msg = `补全完成:已更新 ${enrichProgress.updated} 条`;
    if (enrichProgress.notFound > 0) msg += `,未找到 ${enrichProgress.notFound} 条`;
    if (enrichProgress.failed > 0) msg += `,失败 ${enrichProgress.failed} 条`;
    if (enrichStopFlag) msg += '(已中止)';
    show(msg, enrichProgress.failed > 0 ? 'warning' : 'success');
    await loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    enrichingItems.value = false;
    enrichProgress.current = '';
    enrichProgress.platform = '';
  }
}
// 推送一批到后端并清空缓冲
async function flushEnrichBatch(items) {
  if (!items.length) return;
  const batch = items.splice(0, items.length);
  try {
    const resp = await enrichPurchaseItems(batch);
    const data = resp?.data || resp || {};
    enrichProgress.updated += data.updated || 0;
  } catch (e) {
    // 入库失败:把本批塞回 items 末尾,下轮重试一次(若已到末尾则丢弃)
    items.push(...batch);
    show('入库批次失败:' + (e.message || e), 'error');
  }
}

// ── 同步采购物流信息(手动触发后台一轮,2026-09-17) ──────────────
// 后端与每小时定时轮同逻辑互斥:补物流单号(1688)+拉轨迹(1688官方API+拼多多goods_express);
// POST 启动后 3s 轮询进度,完成 toast 汇总并刷新列表
const syncingLogistics = ref(false);
const logisticsProgress = reactive({ phase: '', done: 0, total: 0 });
let logisticsTimer = null;
const LOGISTICS_PHASE_LABEL = { 'fill-ali': '补1688单号', 'fill-pdd': '补拼多多单号', 'trace-ali': '拉1688轨迹', 'trace-pdd': '拉拼多多轨迹' };

async function onSyncPurchaseLogistics() {
  if (syncingLogistics.value) return;
  try {
    const resp = await syncPurchaseLogistics();
    const data = resp?.data || resp || {};
    if (data.started === false) {
      show('采购物流同步已在进行中(定时轮或手动),展示进度如下', 'info');
    } else {
      show('采购物流同步已启动:补单号 + 1688/拼多多轨迹(每阶段上限100单)', 'success');
    }
    const st = data.status || {};
    Object.assign(logisticsProgress, { phase: st.phase || '', done: st.progress?.done || 0, total: st.progress?.total || 0 });
    syncingLogistics.value = true;
    startLogisticsPolling();
  } catch (e) {
    show('启动采购物流同步失败:' + (e.message || e), 'error');
  }
}

function startLogisticsPolling() {
  if (logisticsTimer) clearInterval(logisticsTimer);
  logisticsTimer = setInterval(async () => {
    try {
      const resp = await getPurchaseLogisticsProgress();
      const st = resp?.data || resp;
      if (!st) return;
      logisticsProgress.phase = st.phase || '';
      logisticsProgress.done = st.progress?.done || 0;
      logisticsProgress.total = st.progress?.total || 0;
      if (!st.running) {
        clearInterval(logisticsTimer);
        logisticsTimer = null;
        syncingLogistics.value = false;
        if (st.error) {
          show('采购物流同步异常:' + st.error, 'error');
        } else if (st.result) {
          const r = st.result;
          const parts = [
            `1688单号 ${r.phaseA?.filled ?? 0}/${r.phaseA?.scanned ?? 0}`,
            `PDD单号 ${r.phaseApdd?.filled ?? 0}/${r.phaseApdd?.scanned ?? 0}`,
            `1688轨迹 ${r.phaseB?.updated ?? 0}/${r.phaseB?.scanned ?? 0}`,
            `PDD轨迹 ${r.phaseC?.updated ?? 0}/${r.phaseC?.scanned ?? 0}`,
          ];
          show(`物流同步完成:${parts.join(', ')}`, 'success');
        }
        await loadList();
      }
    } catch { /* 网络闪断:继续轮询 */ }
  }, 3000);
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
// 采购弹窗内嵌订单导入区的平台×账号 tab key
// 'pdd' | 'ali:linqx' | 'ali:chenlin' | 'taobao' | 'manual'(多账号平台带账号后缀,单账号平台保持裸键)
const importTab = ref('pdd');
// 已有采购单恢复态:打开弹窗时从 pkg.purchaseLinks 按采购单分组重建,显示在"已选订单"区,可逐单删除
const restoredPurchases = ref([]);

/** 平台值(入库的 yangkeduo/1688/taobao)→ 首个匹配的账号 tab key(用于打开弹窗恢复) */
function tabKeyForPlatform(platformVal) {
  const hit = importAccountTabs.value.find((t) => PLATFORM_TAB_META[t.platform]?.platformVal === platformVal);
  return hit ? hit.key : 'manual';
}

function openPurchase(pkg) {
  purchaseForm.packageId = pkg.id;
  purchaseForm.packageNo = pkg.packageNo;
  purchaseForm.platform = 'other';
  purchaseForm.purchaseSn = '';
  purchaseForm.buyerAccount = '';
  purchaseForm.buyerUserId = '';
  purchaseForm.sellerName = '';
  purchaseForm.paymentAmount = '';
  purchaseForm.logisticsCompany = '';
  purchaseForm.logisticsNo = '';
  purchaseForm.note = '';
  purchaseForm.allocMode = 'auto';
  purchaseForm.platformGoods = [];
  lookupResult.value = null;
  purchaseForm.items = (pkg.items || []).map((it) => ({
    itemId: it.id,
    offerId: it.offerId,
    title: it.title,
    quantity: it.quantity,
    amount: '',
    picUrl: it.picUrl,
    pdpUrl: it.pdpUrl,
  }));
  // 清空所有账号 tab 的勾选(懒建的 store 可能不存在,容错跳过)
  for (const tabDef of importAccountTabs.value) {
    const st = importStores[tabDef.key];
    if (st) st.selected = [];
  }
  // 已有采购信息:恢复成"已选中"状态(按采购单分组重建)——可继续勾选追加平台订单,也可逐单删除已有采购
  if (pkg.purchaseLinks?.length) {
    const byPo = new Map();
    for (const l of pkg.purchaseLinks) {
      if (!byPo.has(l.purchaseOrderId)) byPo.set(l.purchaseOrderId, []);
      byPo.get(l.purchaseOrderId).push(l);
    }
    restoredPurchases.value = [...byPo.values()].map((links) => {
      const first = links[0];
      return {
        purchaseOrderId: first.purchaseOrderId,
        platform: first.platform || 'other',
        orderSn: first.purchaseSn || '',
        amount: first.paymentAmount != null ? Number(first.paymentAmount) : 0,
        // 本包裹的分摊合计(拼单时 < 采购单总额,删除时冲回的就是这个数)
        allocated: links.reduce((s, l) => s + (Number(l.allocatedAmount) || 0), 0),
        sellerName: first.sellerName || '',
        buyerUsername: first.buyerAccount || '',
        buyerUserId: first.buyerUserId || '',
        trackingNumber: first.poLogisticsNo || '',
        goods: first.items || [],
        _platform: first.platform || 'other',
        _existing: true,
      };
    });
    purchaseForm.platform = restoredPurchases.value[0].platform;
    // 表单为空(已有采购不入表单),保持 auto:新勾选订单按数量自动分摊金额,无需逐行填写
    purchaseForm.allocMode = 'auto';
    importTab.value = tabKeyForPlatform(purchaseForm.platform);
    purchaseOpen.value = true;
    if (importTab.value !== 'manual') loadOrders(importTab.value);
    return;
  }
  restoredPurchases.value = [];
  // 无采购信息:重置到拼多多 tab 并自动加载
  importTab.value = 'pdd';
  purchaseOpen.value = true;
  loadOrders('pdd');
}

// ── auto 模式:查询采购单已关联包裹(含数量,用于加权分摊预览) ──
async function refreshLookup() {
  const sn = purchaseForm.purchaseSn.trim();
  if (purchaseForm.platform === 'other' || !sn) {
    lookupResult.value = null;
    return;
  }
  lookupLoading.value = true;
  try {
    const r = await lookupPurchase(purchaseForm.platform, sn);
    lookupResult.value = r.exists ? r : null;
  } catch (e) {
    console.warn('lookupPurchase failed', e);
    lookupResult.value = null;
  } finally {
    lookupLoading.value = false;
  }
}

// auto 模式分摊预览计算
// 公式:每行分摊 = (该行 quantity / Σ所有 auto 关联 quantity) × paymentAmount
// Σ = 已关联 auto 包裹的数量合计 + 当前包裹各行的数量合计
const autoPreview = computed(() => {
  if (purchaseForm.allocMode !== 'auto') return null;
  const payment = Number(purchaseForm.paymentAmount) || 0;
  const currentQty = purchaseForm.items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  // 已关联的 auto 模式包裹数量合计(manual 模式关联不参与加权)
  const existingAutoQty = (lookupResult.value?.linkedPackages || [])
    .filter((p) => (p.alloc_modes || '').includes('auto'))
    .reduce((s, p) => s + (Number(p.quantity) || 0), 0);
  const sumQty = currentQty + existingAutoQty;
  if (sumQty === 0) return { items: [], sumQty: 0, payment, currentQty, existingAutoQty };
  const round2 = (n) => Math.round(n * 100) / 100;
  const items = purchaseForm.items.map((it) => ({
    ...it,
    previewAmount: round2((Number(it.quantity) || 0) * payment / sumQty),
  }));
  return { items, sumQty, payment, currentQty, existingAutoQty };
});

// 切换 allocMode 或输入 purchaseSn 时自动刷新 lookup
watch(() => purchaseForm.allocMode, (mode) => {
  if (mode === 'auto') refreshLookup();
  else {
    // 切到 manual:从已选采购订单合计(newSelectedTotal,不含已有采购恢复项)按数量加权分摊到各产品行
    // 不依赖 paymentAmount(可能被 watch 链时序影响),直接用合计确保多选时用合计
    const total = Number(newSelectedTotal.value) || 0;
    if (total <= 0) return;
    const items = purchaseForm.items || [];
    const sumQty = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    if (sumQty <= 0) return;
    let allocated = 0;
    for (let i = 0; i < items.length; i++) {
      const q = Number(items[i].quantity) || 0;
      if (i === items.length - 1) {
        items[i].amount = (Math.round((total - allocated) * 100) / 100).toString();
      } else {
        const a = Math.round((total * q / sumQty) * 100) / 100;
        items[i].amount = a.toString();
        allocated += a;
      }
    }
  }
});
watch(() => purchaseForm.purchaseSn, () => {
  if (purchaseForm.allocMode === 'auto') refreshLookup();
});
// auto 模式分摊预览变化时,把分摊值同步到 it.amount,确保切换到 manual 时保留已分摊数值
watch(autoPreview, (pv) => {
  if (!pv || !pv.items) return;
  pv.items.forEach((it, idx) => {
    if (purchaseForm.items[idx] && it.previewAmount != null) {
      purchaseForm.items[idx].amount = String(it.previewAmount);
    }
  });
});

async function savePurchase() {
  if (purchaseSaving.value) return;
  const isAuto = purchaseForm.allocMode === 'auto';
  const items = purchaseForm.items
    .map((it) => ({ itemId: it.itemId, amount: Number(it.amount) || 0, quantity: it.quantity }))
    .filter((it) => it.itemId);
  // auto 模式:校验 paymentAmount;manual 模式:校验每行 amount
  const hasAmount = isAuto ? Number(purchaseForm.paymentAmount) > 0 : items.some((it) => it.amount > 0);
  const hasNo = !!purchaseForm.logisticsNo.trim();
  // 新勾选的平台订单也算有新采购(订单金额可能为 0)
  const hasNew = hasAmount || hasNo || newSelectedOrders.value.length > 0;
  if (!hasNew) {
    // 空表单保存 = 清空采购信息
    // - 已有采购未删除 → 二次确认后一键清空(冲回全部关联)
    // - 已有采购已逐单删除(或本就没有) → 直接清残留聚合(采购状态/头程物流)
    if (restoredPurchases.value.length) {
      const allocatedSum = restoredPurchases.value.reduce((s, r) => s + (Number(r.allocated) || 0), 0);
      const okClear = await confirmStore.ask({
        message: `未填写新采购信息。是否清空包裹 ${purchaseForm.packageNo} 已有的 ${restoredPurchases.value.length} 单采购关联?将冲回全部分摊金额(${fmtMoney(allocatedSum)})`,
        confirmText: '清空',
        danger: true,
      });
      if (!okClear) return;
    }
    purchaseSaving.value = true;
    try {
      const r = await clearPurchaseInfo(purchaseForm.packageId);
      show(r?.hadPurchase ? '采购信息已清空' : '未提交采购信息', 'success');
      purchaseOpen.value = false;
      loadTabs();
      loadList();
    } catch (err) {
      show(err.message || String(err), 'error');
    } finally {
      purchaseSaving.value = false;
    }
    return;
  }
  // 拼单检测:platform≠other 且 purchaseSn 非空时,查询采购单是否已关联其他包裹
  // auto 模式下已有 lookupResult(manual 模式实时查询)
  const sn = purchaseForm.purchaseSn.trim();
  if (purchaseForm.platform !== 'other' && sn) {
    try {
      const r = lookupResult.value || await lookupPurchase(purchaseForm.platform, sn);
      if (r?.exists && r.linkedPackages?.length) {
        const sum = r.linkedPackages.reduce((s, p) => s + (Number(p.allocated_amount) || 0), 0);
        const lines = r.linkedPackages
          .map((p) => `  · ${p.package_no} (${p.posting_number}) 数量${p.quantity||0} 分摊 ${fmtMoney(p.allocated_amount)}`)
          .join('\n');
        const ok = await confirmStore.ask({
          message: `采购单 ${sn} 已关联 ${r.linkedPackages.length} 个包裹(分摊合计 ${fmtMoney(sum)}):\n${lines}\n\n本次将追加关联到当前包裹 ${purchaseForm.packageNo}${isAuto ? '(auto 模式:已关联包裹的分摊金额将按数量重新加权计算)' : ''}。`,
          confirmText: '追加关联',
          danger: true,
        });
        if (!ok) return;
      }
    } catch (e) {
      // lookup 失败不阻塞提交
      console.warn('lookupPurchase failed', e);
    }
  }
  purchaseSaving.value = true;
  try {
    await submitPurchase({
      packageId: purchaseForm.packageId,
      platform: purchaseForm.platform,
      purchaseSn: purchaseForm.purchaseSn.trim() || null,
      buyerAccount: purchaseForm.buyerAccount.trim() || null,
      buyerUserId: purchaseForm.buyerUserId.trim() || null,
      sellerName: purchaseForm.sellerName.trim() || null,
      paymentAmount: Number(purchaseForm.paymentAmount) || null,
      logisticsCompany: purchaseForm.logisticsCompany.trim() || null,
      logisticsNo: hasNo ? purchaseForm.logisticsNo.trim() : null,
      note: purchaseForm.note.trim() || null,
      items,
      platformGoods: purchaseForm.platformGoods,
      allocMode: isAuto ? 'auto' : 'manual',
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

// ── 平台订单获取(ERP 后端 cloakbrowser 直取,2026-09 M3;2026-09-13 多账号)─────
// 协议:GET /admin/api/platform-orders/:platform(/search);后端在对应账号 profile 浏览器
// 页面上下文取数,错误已映射为 AUTH_REQUIRED/RISK_VALIDATE 等友好 message。
// 这里包装回插件时代的 {ok, orders|result|error} 形状,下游 load*/补全链路零改动
async function platformOrdersReq(platform, payload) {
  try {
    const data = await getPlatformOrders(platform, payload);
    return { ok: true, orders: data.orders || [] };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// 按采购单号精确搜索(后端跨该平台全部账号依次搜,前端无感知);
// 未找到返回 {ok:true, result:null}(与插件搜索语义一致)
async function platformSearchReq(platform, orderSn) {
  try {
    const data = await searchPlatformOrder(platform, orderSn);
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ── 多账号 tab 配置(来自后端 /status 的账号列表)──────────
// 单账号平台 key 与旧值一致('pdd'/'taobao');多账号平台展开为 'ali:linqx'/'ali:chenlin'
const PLATFORM_TAB_META = {
  pdd: { prefix: 'pdd', platformVal: 'yangkeduo', label: '拼多多', platformReq: 'pdd' },
  ali1688: { prefix: 'ali', platformVal: '1688', label: '1688', platformReq: 'ali1688' },
  taobao: { prefix: 'taobao', platformVal: 'taobao', label: '淘宝', platformReq: 'taobao' },
};
// 默认(后端 /status 未返回时):三平台各一个主账号,行为与 M3 完全一致
const importAccountTabs = ref([
  { key: 'pdd', platform: 'pdd', account: 'linqx', label: '拼多多' },
  { key: 'ali:linqx', platform: 'ali1688', account: 'linqx', label: '1688·linqx' },
  { key: 'taobao', platform: 'taobao', account: 'linqx', label: '淘宝' },
]);

/** 按 /status 返回的各平台账号列表展开 tab 配置 */
function rebuildAccountTabs(platforms) {
  const tabs = [];
  for (const [platform, meta] of Object.entries(PLATFORM_TAB_META)) {
    const accounts = Object.keys(platforms?.[platform]?.accounts || {});
    if (!accounts.length) continue; // 后端未配置该平台 → 保留默认(下面兜底)
    const multi = accounts.length > 1;
    for (const account of accounts) {
      tabs.push({
        key: multi ? `${meta.prefix}:${account}` : meta.prefix,
        platform, account,
        label: multi ? `${meta.label}·${account}` : meta.label,
      });
    }
  }
  if (tabs.length) {
    // 当前 importTab 指向的 tab 被新配置淘汰时,归位到第一个平台 tab
    if (!tabs.some((t) => t.key === importTab.value) && importTab.value !== 'manual') {
      importTab.value = tabs[0].key;
    }
    importAccountTabs.value = tabs;
  }
}

// 后端浏览器登录态探测(替代原扩展 PING/PONG):'yes' | 'no' | 'unknown'
// 键为 `${platform}:${account}` 复合键
// 注意 'yes' 仅代表登录 cookie 存在,session 真实失效由请求时的 AUTH_REQUIRED 提示兜底
const platformLogin = reactive({});
async function loadPlatformStatus() {
  try {
    const data = await getPlatformOrdersStatus();
    rebuildAccountTabs(data.platforms || {});
    for (const [plat, info] of Object.entries(data.platforms || {})) {
      for (const [account, v] of Object.entries(info?.accounts || {})) {
        platformLogin[`${plat}:${account}`] = v?.login || 'unknown';
      }
    }
  } catch { /* 静默:探测失败不阻塞主流程 */ }
}

// ── PDD 登录同步页面桥(2026-09-14)────────────────────────────
// 链路:插件 popup → background → erp-bridge(content script)
//       → window.postMessage(此处)→ 调后端 API(JWT)→ 结果回传
// 消息(source:'erp-pdd-sync'):
//   入: { type:'PDD_SYNC_COOKIES', reqId, payload:{account, uid, cookies[]} }
//       { type:'PDD_GET_ACCOUNTS', reqId }
//   出: { type:'PDD_SYNC_COOKIES_RESULT'|'PDD_GET_ACCOUNTS_RESULT', reqId, data:{ok,...} }
// 设计文档: docs/PDD登录同步-概要设计.md §4.4
const PDD_SYNC_NS = 'erp-pdd-sync';
function postToPddSyncBridge(type, reqId, data) {
  window.postMessage({ source: PDD_SYNC_NS, type, reqId, data }, window.location.origin);
}
async function onPddSyncBridgeMessage(ev) {
  if (ev.source !== window || !ev.data || ev.data.source !== PDD_SYNC_NS) return;
  const { type, reqId, payload } = ev.data;
  try {
    if (type === 'PDD_SYNC_COOKIES') {
      const data = await syncPddCookies({
        account: payload?.account,
        uid: payload?.uid,
        cookies: payload?.cookies || [],
      });
      postToPddSyncBridge('PDD_SYNC_COOKIES_RESULT', reqId, { ok: true, data });
      // 同步成功后刷新登录态展示(status 会显示 plugin-synced)
      loadPlatformStatus();
    } else if (type === 'PDD_GET_ACCOUNTS') {
      const accounts = importAccountTabs.value
        .filter((t) => t.platform === 'pdd')
        .map((t) => t.account);
      postToPddSyncBridge('PDD_GET_ACCOUNTS_RESULT', reqId, { ok: true, accounts });
    }
  } catch (e) {
    // 后端错误(如账号不存在/cookie 不完整):回传给插件 popup 展示
    postToPddSyncBridge(`${type}_RESULT`, reqId, { ok: false, error: e?.message || String(e) });
  }
}

// ── 统一订单导入 store(按 tabKey 分账号存储,切 tab 互不影响)──
// importStores: tabKey → { orders, loading, error, tab, selected, searched }
// searched:订单号搜索命中的订单(置顶展示;刷新列表不丢,勾选随列表刷新保留)
const importStores = reactive({});
function storeFor(key) {
  if (!importStores[key]) {
    importStores[key] = { orders: [], loading: false, error: '', tab: 'all', selected: [], searched: [] };
  }
  return importStores[key];
}

/** 当前平台 tab 定义(manual 时返回 null) */
const currentTabDef = computed(() => importAccountTabs.value.find((t) => t.key === importTab.value) || null);

/** 拉取指定 tab 的订单(懒建 store;account 由 tab 配置透传) */
async function loadOrders(tabKey) {
  const def = importAccountTabs.value.find((t) => t.key === tabKey);
  if (!def) return;
  const st = storeFor(tabKey);
  st.loading = true;
  st.error = '';
  // 列表勾选清空;搜索命中的订单是显式操作结果,保留其勾选
  const keepSn = new Set(st.searched.map((o) => o.orderSn));
  st.selected = st.selected.filter((s) => keepSn.has(s));
  try {
    const resp = await platformOrdersReq(def.platform, { tab: st.tab, size: 30, account: def.account });
    if (!resp.ok) throw new Error(resp.error || '获取订单失败');
    st.orders = resp.orders || [];
    // tab 标签固定用配置别名(PLATFORM_ACCOUNTS_*,如 linrh);不再用订单 buyerUsername 增强——
    // 2026-09-17 用户确认统一别名口径,原增强会把 linrh 替换成平台登录名 tb537642872(仅该账号订单带 loginId)
  } catch (err) {
    st.error = err.message || String(err);
    st.orders = [];
  } finally {
    st.loading = false;
  }
}

// 快递单号前缀 → 物流公司(启发式推断,仅预填,可手改)
const COURIER_RULES = [
  [/^YT/, '圆通速递'],
  [/^SF/, '顺丰速运'],
  [/^JT/, '极兔速递'],
  [/^77/, '申通快递'],
  [/^75|^78|^79/, '中通快递'],
  [/^JD/, '京东物流'],
  [/^EMS|^98/, '邮政快递'],
];
function inferCourier(no) {
  if (!no) return '';
  const hit = COURIER_RULES.find(([re]) => re.test(no));
  return hit ? hit[1] : '';
}

// ── 采购弹窗内嵌订单导入区(统一账号 store 模型,2026-09-13 多账号)──
// 当前 tab 的 store(懒建保证响应性;manual 时返回空 store,模板不渲染)
const currentStore = computed(() => storeFor(importTab.value));
// 当前平台的状态子 tab
const importSubTab = computed({
  get: () => currentStore.value.tab,
  set: (v) => { currentStore.value.tab = v; },
});
const importSubTabs = computed(() => {
  if ((currentTabDef.value?.platform || '') === 'pdd') return [{ key: 'all', label: '全部' }, { key: 'unreceived', label: '待收货' }];
  return [{ key: 'all', label: '全部' }, { key: 'unshipped', label: '待发货' }, { key: 'unreceived', label: '待收货' }];
});

// 当前导入 tab 对应的平台中文名/登录态(导入区登录提示用)
// 登录态为复合键 `${platform}:${account}`;'yes' 仅代表 cookie 存在,真实失效由 AUTH_REQUIRED 兜底
const currentPlatformName = computed(() => currentTabDef.value?.label || '');
const currentPlatformLogin = computed(() => {
  const d = currentTabDef.value;
  return d ? (platformLogin[`${d.platform}:${d.account}`] || 'unknown') : 'unknown';
});

// 当前 tab 的 orders(搜索命中置顶去重)/ loading / error / selected
// 注入 _platform(入库平台值)供模板按平台区分渲染(PDD orderTime 为秒级数字需 ×1000 格式化,
// 2026-09-17 修复:多账号重构后列表区 o._platform 判断失效,PDD 列表时间显示成原始数字)
const importOrders = computed(() => {
  const st = currentStore.value;
  const plat = PLATFORM_TAB_META[currentTabDef.value?.platform]?.platformVal || '';
  const inList = new Set(st.orders.map((o) => o.orderSn));
  const wrap = (o) => (o._platform === plat ? o : { ...o, _platform: plat });
  return [...st.searched.filter((o) => !inList.has(o.orderSn)).map(wrap), ...st.orders.map(wrap)];
});
const importLoading = computed(() => currentStore.value.loading);
const importError = computed(() => currentStore.value.error);
const importSelected = computed({
  get: () => currentStore.value.selected,
  set: (v) => { currentStore.value.selected = v; },
});

// 已有采购单的 SN 键集合(逗号拼接的 SN 拆开),用于平台列表里标记"已关联"并禁止重复勾选
const restoredSnKeys = computed(() => {
  const s = new Set();
  for (const r of restoredPurchases.value) {
    for (const part of String(r.orderSn || '').split(',')) {
      const p = part.trim();
      if (p) s.add(`${r.platform}:${p}`);
    }
  }
  return s;
});

// 跨平台×账号合并的已选订单(用于下方展示):已有采购恢复项排在最前 + 新勾选的平台订单
// 同 SN 去重与显示列表(importOrders)同口径(2026-09-17 修复):搜索命中若已存在于当前账号列表,
// 以列表版为准(字段同源完整)——否则同一单在已选区出现两条(搜索版缺 amount 字段显示空金额)
const allSelectedOrders = computed(() => {
  const sel = [];
  for (const t of importAccountTabs.value) {
    const st = importStores[t.key];
    if (!st) continue;
    const inList = new Set((st.orders || []).map((o) => o.orderSn));
    const merged = [...(st.searched || []).filter((x) => !inList.has(x.orderSn)), ...(st.orders || [])];
    for (const o of merged) {
      if (st.selected.includes(o.orderSn) && !restoredSnKeys.value.has(`${PLATFORM_TAB_META[t.platform]?.platformVal}:${o.orderSn}`)) {
        sel.push({ ...o, _platform: PLATFORM_TAB_META[t.platform]?.platformVal, _account: t.account });
      }
    }
  }
  return [...restoredPurchases.value, ...sel];
});
const allSelectedTotal = computed(() =>
  allSelectedOrders.value.reduce((s, o) => s + (Number(o.amount) || 0), 0).toFixed(2));

// 新勾选的订单(不含已有采购恢复项):提交时只入库新增部分,避免已有采购重复累加
const newSelectedOrders = computed(() => allSelectedOrders.value.filter((o) => !o._existing));
const newSelectedTotal = computed(() =>
  newSelectedOrders.value.reduce((s, o) => s + (Number(o.amount) || 0), 0).toFixed(2));

function switchImportTab(t) {
  if (importTab.value === t || importLoading.value) return;
  importTab.value = t;
  importSearch.keyword = '';
  importSearch.error = '';
  if (t === 'manual') {
    // 切到手动录入:清空全部账号已勾选的平台采购订单,平台改为其它
    for (const tabDef of importAccountTabs.value) {
      const st = importStores[tabDef.key];
      if (st) st.selected = [];
    }
    purchaseForm.platform = 'other';
    purchaseForm.purchaseSn = '';
    purchaseForm.sellerName = '';
    return;
  }
  const st = storeFor(t);
  if (!st.orders.length && !st.loading) loadOrders(t);
}

function switchImportSubTab(t) {
  importSubTab.value = t;
  if (importTab.value !== 'manual') loadOrders(importTab.value);
}

// ── 订单号搜索(2026-09-16 先支持 1688;2026-09-17 扩展拼多多 + 只搜当前tab所属账号,省API调用)──
// 命中的订单置顶插入当前 tab 列表并自动勾选;后端返回结构与列表订单逐字段一致
const importSearch = reactive({ keyword: '', loading: false, error: '' });
// 支持订单号搜索的平台(1688 官方API buyerView / PDD order_list_search_v4)
const SEARCHABLE_PLATFORMS = ['ali1688', 'pdd'];
const isSearchableTab = computed(() => SEARCHABLE_PLATFORMS.includes(currentTabDef.value?.platform));
const searchPlaceholder = computed(() =>
  (currentTabDef.value?.platform === 'pdd' ? '输入拼多多订单号搜索' : '输入 1688 订单号搜索'));
async function onSearchImportOrder() {
  const sn = importSearch.keyword.trim();
  if (!sn || importSearch.loading || !currentTabDef.value) return;
  const platLabel = currentTabDef.value.label || '平台';
  importSearch.loading = true;
  importSearch.error = '';
  try {
    const data = await searchPlatformOrder(currentTabDef.value.platform, sn, currentTabDef.value.account);
    const found = data?.result || null;
    if (!found?.orderSn) {
      importSearch.error = `未找到订单 ${sn}(单号不存在,或不属于当前账号 ${currentTabDef.value.account || '—'})`;
      return;
    }
    const st = currentStore.value;
    // 字段规范化(2026-09-17):搜索接口返回 orderAmount,前端表格/保存逻辑用 amount——
    // 缺失会导致已选区金额空、保存采购金额算成 0
    const hit = { ...found, amount: found.orderAmount ?? found.amount ?? 0 };
    // 置顶插入搜索区(去重),并自动勾选(已取消/已关联的不勾)
    st.searched = [hit, ...st.searched.filter((o) => o.orderSn !== found.orderSn)];
    if (!isImportCancelled(found) && !isRestoredLinked(found) && !st.selected.includes(found.orderSn)) {
      st.selected.push(found.orderSn);
    }
    show(`已找到 ${platLabel}订单 ${found.orderSn}(¥${found.amount})`, 'success');
  } catch (e) {
    importSearch.error = e?.message || String(e);
  } finally {
    importSearch.loading = false;
  }
}

// 手动录入 tab:输入金额后均摊到各产品行(同步显示到上方第①块)
function syncManualAmount() {
  const total = Number(purchaseForm.value.paymentAmount);
  if (!total || !isFinite(total) || total <= 0) return;
  const items = purchaseForm.value.items || [];
  const sumQty = items.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  if (sumQty <= 0) return;
  // 按数量加权均摊,末行吸收尾差
  let allocated = 0;
  for (let i = 0; i < items.length; i++) {
    const q = Number(items[i].quantity) || 0;
    if (i === items.length - 1) {
      items[i].amount = (Math.round((total - allocated) * 100) / 100).toString();
    } else {
      const a = Math.round((total * q / sumQty) * 100) / 100;
      items[i].amount = a.toString();
      allocated += a;
    }
  }
}

function isImportCancelled(o) {
  return /取消|关闭/.test(o.statusPrompt || '') || /close|cancel/i.test(o.status || '');
}

function platformLabelByVal(v) { return PLATFORMS.find((p) => p.value === v)?.label || v; }

/** 从下方选中区移除一单(同平台可能有多个账号 tab,遍历清掉对应勾选) */
function removeSelectedOrder(platformVal, orderSn) {
  for (const t of importAccountTabs.value) {
    if (PLATFORM_TAB_META[t.platform]?.platformVal !== platformVal) continue;
    const st = importStores[t.key];
    if (st) st.selected = st.selected.filter((s) => s !== orderSn);
  }
}

/** 删除一条已有采购关联(冲回该采购分摊金额,对齐详情弹窗的"取消关联") */
async function removeRestoredPurchase(po) {
  const label = po.orderSn || `#${po.purchaseOrderId}`;
  if (!(await confirmStore.ask({
    message: `确认删除已有采购单 ${label} 与包裹 ${purchaseForm.packageNo} 的关联?将冲回本包裹分摊的采购金额(${fmtMoney(po.allocated)})`,
    danger: true,
  }))) return;
  try {
    await unlinkPurchase(po.purchaseOrderId, purchaseForm.packageId);
    restoredPurchases.value = restoredPurchases.value.filter((r) => r.purchaseOrderId !== po.purchaseOrderId);
    show('已删除该采购关联', 'success');
    loadTabs();
    loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// 当前 importTab 对应的平台值(用于 restoredSnKeys 匹配)
const importTabPlatform = computed(() => PLATFORM_TAB_META[currentTabDef.value?.platform]?.platformVal || '');
/** 平台列表行是否已在已有采购关联中(禁止重复勾选,避免重复入库) */
function isRestoredLinked(o) {
  return restoredSnKeys.value.has(`${importTabPlatform.value}:${o.orderSn}`);
}

/** 新勾选订单变化时自动回填 purchaseForm(无需手动点按钮;已有采购恢复项不参与,避免重复入库) */
watch(newSelectedOrders, (sel) => {
  if (!sel.length) return;
  const first = sel[0];
  purchaseForm.platform = first._platform;
  purchaseForm.purchaseSn = sel.map((o) => o.orderSn).join(',');
  const sellers = [...new Set(sel.map((o) => o.mallName || o.sellerName).filter(Boolean))];
  purchaseForm.sellerName = sellers.join(',');
  // 买家身份:采购账号统一用配置账号名(PLATFORM_ACCOUNTS_*,如 linqx/chenlin/linrh/yefu),
  // 平台登录名(tb537642872 之类)仅作无 account 时兜底;平台用户ID随提交落库
  const buyerNames = [...new Set(sel.map((o) => o.account || o.buyerUsername).filter(Boolean))];
  purchaseForm.buyerAccount = buyerNames.join(',');
  const buyerIds = [...new Set(sel.map((o) => o.buyerUserId).filter(Boolean))];
  purchaseForm.buyerUserId = buyerIds.join(',');
  purchaseForm.paymentAmount = newSelectedTotal.value;
  const tracks = sel.map((o) => o.trackingNumber).filter(Boolean);
  purchaseForm.logisticsNo = tracks.join(',');
  // 物流公司:平台真实公司名优先(1688 openapi logisticsCompanyName),无则按单号前缀推断兜底
  const companies = [...new Set(sel.map((o) => o.logisticsCompany).filter(Boolean))];
  purchaseForm.logisticsCompany = companies.join(',') || (tracks.length ? inferCourier(tracks[0]) : '');
  // 平台订单商品(图片/数量/规格)随表单携带,保存时直接写入 items_json(免事后补全)
  purchaseForm.platformGoods = sel.flatMap((o) => o.goods || []);
  if (sel.length === 1 && sel[0].goods.length === 1 && purchaseForm.items.length === 1) {
    purchaseForm.items[0].amount = sel[0].amount;
  }
}, { deep: true });

// ── 行操作 ─────────────────────────────────────────────
// 行"更多"操作菜单(2026-09-17):主操作列只留 备货/同步订单/同步采购物流,
// 次要操作(采购/详情/打印面单/预览/仅标记交运/退回待处理/搁置)收进 fixed 定位菜单
// fixed 定位:脱离 .data-table overflow:hidden / .table-wrap overflow 裁剪
const rowMore = reactive({ pkgId: null, top: 0, left: 0 });
function toggleRowMore(e, pkg) {
  if (rowMore.pkgId === pkg.id) { closeRowMore(); return; }
  const rect = e.currentTarget.getBoundingClientRect();
  const MENU_W = 150, EST_H = 230; // 菜单最大 7 项的估算尺寸
  let top = rect.bottom + 4;
  if (top + EST_H > window.innerHeight) top = Math.max(8, rect.top - EST_H - 4);
  Object.assign(rowMore, { pkgId: pkg.id, top, left: Math.max(8, rect.right - MENU_W) });
}
function closeRowMore() {
  rowMore.pkgId = null;
}

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

// ── 备注/标签行内编辑(2026-09-15 重设计:去弹窗,子行即编辑面)──────────────
// 本地标签存 op_package.tags(逗号分隔),妙手同步不覆盖;
// 本地备注存 op_package.note,妙手同步 COALESCE 覆盖(妙手有值时以妙手为准)
// 交互:标签 chip 名=点击筛选(再点取消)/×=移除/＋=弹出选择面板(搜索/列表选择/新建);
//      备注点击文本进入编辑,blur/Ctrl+Enter 保存,Esc 取消;乐观更新+失败回滚
// 标签颜色(2026-09-15 v4):按标签名 hash 分配 8 色板,同名永远同色;
// 标签顺序(2026-09-15 v4):全局顺序(后端 op_tag_order),下拉/面板/订单 chip 三处一致
const tagEdit = reactive({ pkgId: null, search: '', sortMode: false });
const noteEdit = reactive({ pkgId: null, draft: '', saving: false });

// 标签 → 颜色类:8 色板循环,hash 稳定(同名同色,跨订单/跨面板一致)
function tagColorClass(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'tag-c' + (h % 8);
}

// 标签全局顺序索引(tagOptions 顺序即全局顺序);未知标签排最后按字典序
const tagOrderIndex = computed(() => {
  const m = new Map();
  (tagOptions.value || []).forEach((t, i) => m.set(t.name, i));
  return m;
});
// 订单 chip 按全局顺序排序展示(与下拉/选择面板一致)
function sortTagsByOrder(tags) {
  const idx = tagOrderIndex.value;
  return [...(tags || [])].sort((a, b) => {
    const ia = idx.has(a) ? idx.get(a) : 9999;
    const ib = idx.has(b) ? idx.get(b) : 9999;
    return ia - ib || a.localeCompare(b, 'zh');
  });
}
// 质检单货件号(02131/024785 开头):标签行第一列显著展示 + "质检单"标记
function isQcPosting(sn) {
  const s = String(sn || '');
  return s.startsWith('02131') || s.startsWith('024785');
}
// 采购物流轨迹展开状态(link.id → bool)与解析(trace_json = [{acceptTime, remark}] 最新在前)
const traceOpen = reactive({});
function parseTraceSteps(l) {
  if (!l || !l.traceJson) return [];
  try {
    const arr = JSON.parse(l.traceJson);
    return Array.isArray(arr) ? arr.filter((s) => s && (s.remark || s.acceptTime)) : [];
  } catch { return []; }
}
// 轨迹可见条数(2026-09-17):默认仅最新一条,点"更多"展开全部(最新在前)
function visibleTraceSteps(l) {
  const steps = parseTraceSteps(l);
  return traceOpen[l.id] ? steps : steps.slice(0, 1);
}

// 选择面板:打开(同一时刻仅一行)
function openTagPicker(pkg) {
  tagEdit.pkgId = pkg.id;
  tagEdit.search = '';
  tagEdit.sortMode = false;
}
function closeTagPicker() {
  tagEdit.pkgId = null;
  tagEdit.search = '';
  tagEdit.sortMode = false;
}

// 标签:持久化(乐观更新,失败回滚并提示)
async function persistTags(pkg, nextTags) {
  const prev = pkg.tags || [];
  pkg.tags = nextTags;
  try {
    const updated = await updatePackageMeta(pkg.id, { tags: nextTags });
    pkg.tags = updated.tags || [];
    loadTagOptions(); // 标签集合变化,刷新筛选下拉与选择面板
  } catch (err) {
    pkg.tags = prev;
    show(err.message || String(err), 'error');
  }
}

// 选择面板:列表项 = tagOptions 按全局序,支持搜索过滤(不区分大小写);已含的显示勾选态
function tagPickerOptions(pkg) {
  const kw = tagEdit.search.trim().toLowerCase();
  const own = new Set(pkg.tags || []);
  return (tagOptions.value || [])
    .filter((t) => !kw || t.name.toLowerCase().includes(kw))
    .map((t) => ({ ...t, own: own.has(t.name) }));
}
const tagPickerHasExact = (pkg) =>
  (pkg.tags || []).includes(tagEdit.search.trim()) ||
  (tagOptions.value || []).some((t) => t.name === tagEdit.search.trim());

// 选择面板:点列表项 toggle(已含→移除,未含→添加;面板保持开启便于连续选择)
function toggleTag(pkg, name) {
  if (tagEdit.sortMode) return; // 排序模式下不 toggle,只排序
  if ((pkg.tags || []).includes(name)) {
    persistTags(pkg, pkg.tags.filter((x) => x !== name));
  } else {
    persistTags(pkg, [...(pkg.tags || []), name]);
  }
}

// 选择面板:搜索框回车 = 选中精确/首个匹配,或新建;Esc 关闭(isComposing 守卫)
function onTagSearchKeydown(e, pkg) {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeTagPicker();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const kw = tagEdit.search.trim();
    if (!kw) return;
    const opts = tagPickerOptions(pkg);
    const hit = opts.find((t) => t.name === kw) || opts[0];
    if (hit) {
      toggleTag(pkg, hit.name);
      tagEdit.search = '';
    } else {
      persistTags(pkg, [...(pkg.tags || []), kw]);
      tagEdit.search = '';
    }
  }
}

// 排序模式:上移/下移(乐观更新顺序,PUT 全量,失败回滚)
async function moveTagOrder(name, dir) {
  const list = tagOptions.value.map((t) => ({ ...t }));
  const i = list.findIndex((t) => t.name === name);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const prev = tagOptions.value;
  tagOptions.value = list; // 乐观:面板/下拉/chip 立即生效
  try {
    await updateTagOrder(list.map((t) => t.name));
  } catch (err) {
    tagOptions.value = prev;
    show(err.message || String(err), 'error');
  }
}

function removeTag(pkg, t) {
  persistTags(pkg, (pkg.tags || []).filter((x) => x !== t));
}

// 选择面板:document 点击关闭(面板自身 @click.stop 拦截冒泡)
function onDocClickCloseTagPicker() {
  if (tagEdit.pkgId != null) closeTagPicker();
  if (rowMore.pkgId != null) closeRowMore(); // 行"更多"菜单:点外部关闭
}

// 行"更多"菜单:滚动时关闭(fixed 定位不随滚动移动,关掉最稳)
function onDocScrollCloseRowMore() {
  if (rowMore.pkgId != null) closeRowMore();
}

// 标签:点击 chip 名=按此标签筛选(再点同一标签取消)
function applyTagFilter(t) {
  filters.tag = filters.tag === t ? '' : t;
  search();
}

// 备注:进入/退出编辑
function startNoteEdit(pkg) {
  noteEdit.pkgId = pkg.id;
  noteEdit.draft = pkg.note || '';
  noteEdit.saving = false;
}
function onNoteEsc(e) {
  if (e.isComposing) return;
  noteEdit.pkgId = null;
}
async function saveNote(pkg) {
  if (noteEdit.pkgId !== pkg.id || noteEdit.saving) return;
  const v = noteEdit.draft.trim();
  if (v === (pkg.note || '')) { noteEdit.pkgId = null; return; } // 无变化直接收起
  noteEdit.saving = true;
  try {
    const updated = await updatePackageMeta(pkg.id, { note: v });
    pkg.note = updated.note;
    noteEdit.pkgId = null;
    show('备注已保存', 'success');
  } catch (err) {
    show(err.message || String(err), 'error');
    noteEdit.saving = false;
  }
}

// 拉取已用标签选项(筛选下拉);静默失败不打扰
async function loadTagOptions() {
  try {
    const list = await listPackageTags();
    tagOptions.value = Array.isArray(list) ? list : [];
  } catch { /* 静默 */ }
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

// ── 打印 Ozon 面单(菜鸟打印组件 CNPL 模板静默打印,iframe 兜底)──
// 主路径:拉 PDF(后端缓存优先)→ pdfjs 转 PNG → CNPL 图片模板(70×130 纸,宽 70 等比缩放)
//         → 组件静默出纸 → wait_ship 自动流转交运;ship_success 补打状态不变
// 兜底:组件未启动/连接失败 → 隐藏 iframe + contentWindow.print() 浏览器打印框 + 人工确认流转
const printingId = ref(0); // 正在打印的包裹 id(按钮 loading)
let printFrame = null;     // 兜底打印用隐藏 iframe(复用,避免每次重建)

// 单订单强制同步(列表行"同步订单"按钮):走 /v3/posting/fbs/get 拉最新状态 + 强拉应计,无时间窗口限制
const syncingPkgId = ref(0); // 正在同步的包裹 id(按钮 loading)
async function onSyncPackage(pkg) {
  if (syncingPkgId.value) return;
  syncingPkgId.value = pkg.id;
  try {
    const r = await syncPackage(pkg.id);
    const parts = [`订单${r.orderSynced ? '已同步' : '未更新'}`];
    if (r.accrualRows != null) parts.push(`应计 ${r.accrualRows} 行`);
    if (r.statusBefore && r.statusAfter) {
      const before = `${r.statusBefore.ozon}/${r.statusBefore.operate}`;
      const after = `${r.statusAfter.ozon}/${r.statusAfter.operate}`;
      if (before !== after) parts.push(`状态 ${before} → ${after}`);
    }
    show(`同步完成:${parts.join(' · ')}`, 'success');
    // 刷新当前页 + 计数 + 汇总(状态或应计可能变化)
    await loadList();
    await loadTabs();
  } catch (err) {
    show(`同步失败:${err.message || String(err)}`, 'error');
  } finally {
    syncingPkgId.value = 0;
  }
}

// 单包裹同步采购物流(列表行"同步采购物流"按钮,2026-09-17)
// 范围:该包裹全部关联采购单——补物流单号(1688官方API/拼多多搜索)+拉最新轨迹;
// 与顶栏全局按钮互补:全局走后台整轮(每小时同逻辑),本按钮即时同步当前包裹
const logisticsPkgId = ref(0); // 正在同步采购物流的包裹 id(按钮 loading)
const PLATFORM_SHORT = { '1688': '1688', yangkeduo: '拼多多', taobao: '淘宝', other: '手工' };
async function onSyncPackageLogistics(pkg) {
  if (logisticsPkgId.value) return;
  logisticsPkgId.value = pkg.id;
  try {
    const r = await syncPackagePurchaseLogistics(pkg.id);
    if (!r || !r.orders) {
      show('该包裹无关联采购单,无需同步', 'info');
      return;
    }
    const parts = (r.results || []).map((x) => {
      const pf = PLATFORM_SHORT[x.platform] || x.platform || '?';
      const sn = x.purchaseSn ? `…${String(x.purchaseSn).slice(-6)}` : '';
      return `${pf}${sn} ${x.detail || ''}`;
    });
    const hasErr = (r.results || []).some((x) => x.action === 'error');
    show(`采购物流同步完成(${r.orders}单):${parts.join(' · ')}`, hasErr ? 'warning' : 'success');
    await loadList();
  } catch (err) {
    show(`采购物流同步失败:${err.message || String(err)}`, 'error');
  } finally {
    logisticsPkgId.value = 0;
  }
}

// 备货(列表行"备货"按钮,2026-09-15):Ozon /v4/posting/fbs/ship 搜集订单(不拆分)
// 打面单前置动作:Ozon awaiting_packaging → awaiting_registration(待注册面单)
const shippingPkgId = ref(0); // 正在备货的包裹 id(按钮 loading)
async function onShipPackage(pkg) {
  if (shippingPkgId.value) return;
  // 确认弹窗(2026-09-17):单件商品(总数量=1)直接备货,两件以上才弹窗确认
  const totalQty = (pkg.items || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  if (totalQty > 1) {
    if (!confirm(`确认备货 ${pkg.logisticsNo}?\n该货件共 ${totalQty} 件商品,将向 Ozon 确认全部商品为一个货件(不拆分),之后可打印面单。`)) return;
  }
  shippingPkgId.value = pkg.id;
  try {
    const r = await shipPackage(pkg.id);
    if (r.pending) {
      // Ozon 状态变更中(后端已轮询~15s仍未生效):软成功提示,本地等同步校准
      show(`备货指令已提交:${pkg.logisticsNo} Ozon 状态变更中(通常数十秒内),稍后点「同步订单」或等自动同步校准`, 'success');
    } else {
      show(
        r.alreadyShipped
          ? `该订单已备货过(Ozon 状态 ${r.ozonStatus}),无需重复操作`
          : `备货成功:${pkg.logisticsNo} 已确认货件(Ozon 状态 → ${r.ozonStatus}),可打印面单`,
        'success'
      );
    }
    await loadList();
    await loadTabs();
  } catch (err) {
    show(`备货失败:${err.message || String(err)}`, 'error');
  } finally {
    shippingPkgId.value = 0;
  }
}

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

// 兜底路径:浏览器打印框(打印框关闭后人工确认流转)
async function printLabelViaBrowser(pkg) {
  const blob = await fetchPackageLabel([pkg.id]);
  await printBlobViaIframe(blob);
  if (pkg.operateStatus === 'ship_success') {
    show('面单已重新打印(交运订单,状态不变)', 'success');
    return;
  }
  if (await confirmStore.ask({
    message: `包裹 ${pkg.packageNo} 的面单打印框已关闭,确认流转交运?(未实际打印可取消,稍后重打)`,
  })) {
    await markPrinted(pkg.id);
    show('面单已打印,流转交运', 'success');
    loadTabs();
    loadList();
  }
}

// 主路径:组件静默打印;wait_ship 出纸后自动流转交运,ship_success 补打状态不变
async function onPrintLabel(pkg) {
  if (printingId.value) return;
  printingId.value = pkg.id;
  const isReprint = pkg.operateStatus === 'ship_success';
  try {
    const blob = await fetchPackageLabel([pkg.id]);
    const printer = await pickLabelPrinter();
    await printLabelImage(blob, pkg.logisticsNo || String(pkg.id), printer);
    if (isReprint) {
      show('面单已重新打印(交运订单,状态不变)', 'success');
      return;
    }
    await markPrinted(pkg.id);
    show('面单已静默打印,流转交运', 'success');
    loadTabs();
    loadList();
  } catch (err) {
    const msg = err?.message || String(err);
    if (/菜鸟打印组件/.test(msg)) {
      // 组件不可用 → 回退浏览器打印框
      show(`${msg},改用浏览器打印框`, 'warn');
      try {
        await printLabelViaBrowser(pkg);
      } catch (e2) {
        show(e2.message || String(e2), 'error');
      }
    } else {
      show(msg, 'error');
    }
  } finally {
    printingId.value = 0;
  }
}

// ── 无纸预览(验证 CNPL 模板渲染效果,不出纸不流转状态)──
const labelPreview = reactive({ open: false, url: '', loading: 0 });

async function onPreviewLabel(pkg) {
  if (labelPreview.loading) return;
  labelPreview.loading = pkg.id;
  try {
    const blob = await fetchPackageLabel([pkg.id]);
    const url = await previewLabelImage(blob, pkg.logisticsNo || String(pkg.id));
    labelPreview.url = url;
    labelPreview.open = true;
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    labelPreview.loading = 0;
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

// ── 应计项目(2026-09,已完成/已取消货件的 Ozon 财务应计)─────
// 汇率:列表响应附带 rubRate(每次 loadList 同步刷新);未配置时真实口径自动回退预估
const rubRate = ref(null);
const accrualRefreshing = ref(0); // 正在刷新应计的包裹 id

function fmtRub(n) {
  if (n == null) return '—';
  return Number(n).toFixed(2) + ' ₽';
}

// 金额列六行悬浮提示(真实口径显示 RUB 原值换算明细)
// 已取消订单:无收入,不估算佣金
function isCancelled(pkg) {
  return pkg.operateStatus === 'cancelled';
}
function saleFeeTitle(pkg) {
  if (pkg.accrual) return `销售佣金(SaleCommission)实扣 ${fmtRub(pkg.accrual.saleFeeRub)} × 汇率 ${pkg.accrual.rate}`;
  if (isCancelled(pkg)) return '已取消订单:无销售佣金扣款';
  return '无应计数据(未妥投或 Ozon 未生成),不估算';
}
// 销售佣金占订单金额百分比(应计 type 69 实扣;无应计或订单金额为 0 显示 —)
function saleFeePct(pkg) {
  const fee = pkg.accrual?.saleFee;
  if (fee == null || !pkg.orderAmount) return '—';
  return ((fee / pkg.orderAmount) * 100).toFixed(1) + '%';
}
function deliveryTitle(pkg) {
  const real = pkg.accrual?.delivery;
  const est = pkg.profit?.delivery;
  const parts = [];
  if (real != null) parts.push(`实扣 ${fmtRub(pkg.accrual.deliveryRub)} × 汇率 ${pkg.accrual.rate} = ¥${real}`);
  if (est != null) parts.push(`估按公式 3.37 + 0.0281 × ${pkg.profit.weightG}g = ¥${est}`);
  if (parts.length) return `国际配送 ${parts.join(' | ')}`;
  if (pkg.profit?.weightMissing) return '无重量数据(妙手未称重 + SKU 未缓存),配送费隐含在 16% 代理佣金预估内';
  return '无应计数据(未妥投或 Ozon 未生成)';
}
// 重量悬浮:实际重量(妙手称重/Ozon SKU)+ 推导重量(由实际配送费反推)
// 重量来源标签:miaoshou=订单称重,system=系统维护,ozon=Ozon后台同步
function weightLabel(pkg) {
  if (pkg.weightSource === 'ship') return '重量(称)';
  if (pkg.weightSource === 'miaoshou') return '重量(订单)';
  if (pkg.weightSource === 'system') return '重量(系统)';
  if (pkg.weightSource === 'ozon') return '重量(ozon)';
  return '重量';
}
function weightTitle(pkg) {
  const actual = pkg.weightG;
  const derived = pkg.accrual?.derivedWeight;
  const parts = [];
  const srcLabel = pkg.weightSource === 'ship' ? '发货称重'
    : pkg.weightSource === 'miaoshou' ? '订单称重'
    : pkg.weightSource === 'system' ? '系统维护'
    : pkg.weightSource === 'ozon' ? 'Ozon后台同步' : '未知';
  if (actual != null) parts.push(`实际 ${actual}g(${srcLabel})`);
  if (derived != null) parts.push(`推导 ${derived}g(由实际配送费反推)`);
  if (parts.length) return `商品重量 ${parts.join(' | ')}`;
  return '无重量数据(订单未称重 + 系统未配置 + Ozon SKU 未缓存)';
}
function othersTitle(pkg) {
  if (pkg.accrual) return `其它费用(代理佣金/星星商品/逆向物流等)${fmtRub(pkg.accrual.othersRub)} × 汇率 ${pkg.accrual.rate}`;
  return '无应计数据(未妥投或 Ozon 未生成)';
}

function profitLabel(pkg) {
  if (pkg.profit?.cancelled) return '利润';
  return pkg.profit?.estimated === false ? '利润实' : '预估利润';
}
// 利润悬浮:真实口径显示汇率与回款换算
function profitTitle(pkg) {
  const p = pkg.profit;
  if (!p) return '';
  if (p.estimated === false) {
    return `回款 ${fmtRub(p.payoutRub)} × 汇率 ${p.rubRate} = ¥${p.escrow?.toFixed(2)}`;
  }
  if (p.cancelled) return '已取消订单:无订单收入,利润 = −采购金额(无采购/其它应计为 0)';
  return '按 16% 预估佣金计算(无应计数据或未妥投)';
}

// 详情弹窗"刷新应计"按钮:单包裹重拉应计(拉到过数据后新应计如逆向物流的兜底入口)
async function onRefreshAccrual(pkg) {
  if (accrualRefreshing.value) return;
  accrualRefreshing.value = pkg.id;
  try {
    const r = await runAccrualSync({ mode: 'packages', packageIds: [pkg.id] });
    if (r?.stores?.length && !r.stores[0].ok) {
      throw new Error(r.stores[0].error || '刷新失败');
    }
    show(`应计已刷新(${r?.totalAccrualRows ?? 0} 条明细)`, 'success');
    // 重新拉详情 + 列表(冗余合计已更新)
    await openDetail(pkg);
    loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    accrualRefreshing.value = 0;
  }
}

// ── 汇率管理 ──────────────────────────────────────────────
const rateDialogOpen = ref(false);
const rateSaving = ref(false);
const rateInput = ref('');

function openRateDialog() {
  rateInput.value = rubRate.value?.rate != null ? String(rubRate.value.rate) : '';
  rateDialogOpen.value = true;
}

async function saveRate() {
  const rate = Number(rateInput.value);
  if (!(rate > 0)) {
    show('汇率必须为正数(如 0.082,即 1 RUB = 0.082 CNY)', 'error');
    return;
  }
  rateSaving.value = true;
  try {
    const r = await setRubRate(rate);
    rubRate.value = r;
    rateDialogOpen.value = false;
    show(`汇率已更新:1 RUB = ${r.rate} CNY`, 'success');
    loadList(); // 利润换算口径刷新
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    rateSaving.value = false;
  }
}

// 详情应计区块:明细行(类型中文优先,悬浮英文名)
const detailAccruals = computed(() => detail.value?.accruals || []);
// 详情应计合计行:回款 = 销售 + 应计(已换算 CNY;悬浮显示 RUB 原值)
const detailAccrualSummary = computed(() => {
  const pkg = detail.value?.package;
  if (!pkg || pkg.accrualTotal == null) return null;
  const a = pkg.accrual; // 后端注入的 CNY 分组(无汇率时为 undefined)
  const rate = detail.value?.rubRate?.rate;
  if (a?.rate) {
    return {
      saleRub: a.saleRub, totalRub: a.totalRub,
      payoutRub: Math.round((a.saleRub + a.totalRub) * 100) / 100,
      saleCny: a.sale, totalCny: a.total, payoutCny: a.payout,
      rate: a.rate,
    };
  }
  // 无汇率兜底:前端按 rate(可能 null)换算
  const payoutRub = (pkg.accrualSaleTotal || 0) + (pkg.accrualTotal || 0);
  return {
    saleRub: pkg.accrualSaleTotal,
    totalRub: pkg.accrualTotal,
    payoutRub: Math.round(payoutRub * 100) / 100,
    saleCny: rate != null ? Math.round((pkg.accrualSaleTotal || 0) * rate * 100) / 100 : null,
    totalCny: rate != null ? Math.round((pkg.accrualTotal || 0) * rate * 100) / 100 : null,
    payoutCny: rate ? Math.round(payoutRub * rate * 100) / 100 : null,
    rate,
    syncedAt: pkg.accrualSyncedAt,
  };
});

// ── 展示工具 ───────────────────────────────────────────
function fmtMoney(n) {
  if (n == null) return '—';
  return '¥' + Number(n).toFixed(2);
}

// 利润率格式化:null 返回 —;后端 computeProfit 已 ×10000/100 转为百分数(如 23.45)
function fmtRate(n) {
  if (n == null) return '—';
  return Number(n).toFixed(2) + '%';
}

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// SQLite datetime('now') UTC 字段专用(如 app_config.updated_at);
// 妙手/1688 等国内平台北京时间字符串不能走本函数(会被误加 8h),继续用上面的 fmtTime
function fmtUtcTime(t) {
  const d = parseUtcDate(t);
  if (!d) return '—';
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

// rFBS 退货状态中文释义(/v2/returns/rfbs/list state.state → 中文;未知值回退俄文 state_name)
// 实测出现的值(2026-09 全量):Utilizing/Utilized/UtilizedByOzon/MoneyReturned/ArrivedAtWarehouse/
//   PartialCompensationReturnedByOzon
const RETURN_STATE_LABELS = {
  Utilized: '已销毁',
  UtilizedByOzon: 'Ozon销毁',
  Utilizing: '销毁中',
  ArrivedAtWarehouse: '已到退货仓',
  MoneyReturned: '已退款',
  PartialCompensationReturnedByOzon: 'Ozon部分赔付',
  WaitingShipment: '待寄回',
  Shipping: '退货运输中',
  ReturnedToSeller: '已退回卖家',
  MoneyReturning: '退款中',
  OnSellerApproval: '待卖家审核',
};
function returnStateLabel(pkg) {
  if (!pkg?.isReturned) return null;
  return RETURN_STATE_LABELS[pkg.returnState] || pkg.returnStateName || pkg.returnState || '退货中';
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

/** 采购商品标题/规格最多显示 20 字(超出截断加…,全文悬浮 title 查看,2026-09-17) */
function clip20(v) {
  const s = String(v ?? '').trim();
  return s.length > 20 ? s.slice(0, 20) + '…' : s;
}

/** 采购商品详情页链接(平台 + 商品ID 拼 URL;ID 缺失/非数字返回空,不加链接)
 *  1688: detail.1688.com/offer/{id}.html | 拼多多: mobile.yangkeduo.com/goods.html?goods_id={id}
 *  淘宝: item.taobao.com/item.htm?id={id}
 */
function goodsDetailUrl(platform, goodsId) {
  const id = String(goodsId || '').trim();
  if (!id || !/^\d+$/.test(id)) return '';
  if (platform === '1688') return `https://detail.1688.com/offer/${id}.html`;
  if (platform === 'yangkeduo') return `https://mobile.yangkeduo.com/goods.html?goods_id=${id}`;
  if (platform === 'taobao') return `https://item.taobao.com/item.htm?id=${id}`;
  return '';
}

/** 采购订单详情页链接(平台 + 采购单号拼 URL;单号缺失返回空)
 *  1688: 买家订单列表带搜索词(支持逗号分隔多单号) | 拼多多: 订单详情页
 */
function orderDetailUrl(platform, purchaseSn) {
  const sn = String(purchaseSn || '').trim();
  if (!sn) return '';
  if (platform === '1688') return `https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?word=${encodeURIComponent(sn)}`;
  if (platform === 'yangkeduo') return `https://mobile.yangkeduo.com/order.html?order_sn=${encodeURIComponent(sn)}`;
  return '';
}

/** 国内快递单号物流查询链接(百度按"快递公司 单号"搜索;公司缺失只搜单号) */
function trackingSearchUrl(company, trackingNo) {
  const no = String(trackingNo || '').trim();
  if (!no) return '';
  const kw = `${String(company || '').trim()} ${no}`.trim();
  return `https://www.baidu.com/s?wd=${encodeURIComponent(kw)}`;
}

/** 复制文本到剪贴板(降级兼容 http 环境) */
async function copyText(val, label) {
  const s = String(val || '').trim();
  if (!s) return;
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  show(`${label}已复制:${s}`, 'success');
}

/** 时间戳 → 中文周几(如"周三");无效时间返回空串 */
function weekdayCN(t) {
  if (!t) return '';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '';
  return '周' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
}

// 弹窗里展示的产品行(含已回写采购金额)
const detailItems = computed(() => detail.value?.items || []);
const detailLinks = computed(() => detail.value?.purchaseLinks || []);

let statusTimer = null;
let tickTimer = null;
const route = useRoute();
onMounted(() => {
  loadTabs();
  loadTagOptions(); // 标签筛选下拉选项(2026-09-15)
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
  loadPendingExport();
  // 同步在跑时高频轮询进度,空闲时低频刷新 cursors(顺带刷新待导出徽标)
  statusTimer = setInterval(() => {
    if (progress.value?.active || syncing.value) loadProgress();
    else {
      loadSyncStatus();
      loadPendingExport();
    }
  }, 5_000);
  tickTimer = setInterval(() => { nowTs.value = Date.now(); }, 1000);
  // 平台订单登录态探测(后端 cloakbrowser,替代原扩展 PING/PONG)
  loadPlatformStatus();
  // 采购物流轮若正在跑(定时轮/他页触发),恢复进度轮询态(2026-09-17)
  getPurchaseLogisticsProgress().then((resp) => {
    const st = resp?.data || resp;
    if (st?.running) {
      syncingLogistics.value = true;
      Object.assign(logisticsProgress, { phase: st.phase || '', done: st.progress?.done || 0, total: st.progress?.total || 0 });
      startLogisticsPolling();
    }
  }).catch(() => { /* 静默 */ });
  // PDD 登录同步页面桥(插件 popup 同步 cookie 的接入口)
  window.addEventListener('message', onPddSyncBridgeMessage);
  // 标签选择面板:点面板外任意处关闭(2026-09-15 v4);行"更多"菜单同策略
  document.addEventListener('click', onDocClickCloseTagPicker);
  // 行"更多"菜单:任意滚动(含 table-wrap 内部滚动,capture 捕获)即关闭
  window.addEventListener('scroll', onDocScrollCloseRowMore, true);
});
onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer);
  if (tickTimer) clearInterval(tickTimer);
  if (logisticsTimer) clearInterval(logisticsTimer);
  window.removeEventListener('message', onPddSyncBridgeMessage);
  document.removeEventListener('click', onDocClickCloseTagPicker);
  window.removeEventListener('scroll', onDocScrollCloseRowMore, true);
  if (printFrame) {
    printFrame.remove();
    printFrame = null;
  }
});
</script>

<template>
  <div class="order-process-page">
    <!-- 同步与搜索操作行(2026-09-18:移至订单tab上一行) -->
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
      <span
        v-if="pendingExport.active && pendingExport.count > 0"
        class="tag tag-warn"
        :title="`上次导出(${pendingExport.lastExportAt || '未知'})后有 ${pendingExport.count} 个包裹发生了采购/称重/交运/搁置变更,记得运行导出脚本同步到服务器:node scripts/export-purchase-sync.mjs`"
      >待导出 {{ pendingExport.count }}</span>
      <button class="btn btn-ghost" :disabled="syncing" @click="triggerSync" title="增量同步:unfulfilled [now-14d, now+14d] + list [now-60d, now],双接口">
        {{ syncing ? '同步中…' : '同步进行中订单' }}
      </button>
      <button class="btn btn-ghost" :disabled="syncing" @click="openSyncAllDialog" title="全量同步:仅 /v4/posting/fbs/list,覆盖所有状态含 delivered/cancelled 终态,可选时间范围">
        同步所有订单
      </button>
      <button class="btn btn-ghost" :disabled="syncingMs" @click="onSyncMsToLocal" title="从妙手同步:把妙手订单的重量/备注/采购金额/采购订单详情同步到本地">
        {{ syncingMs ? '妙手同步中…' : '从妙手同步' }}
      </button>
      <button class="btn btn-ghost" :disabled="enrichingItems || syncingMs" @click="onEnrichPurchaseItems" title="补全采购订单信息:拉取全量待补全清单(拼多多+1688+淘宝),串行限速搜索补全商品图/数量,连续失败3次自动中止">
        {{ enrichingItems ? '补全中…' : '补全采购订单信息' }}
      </button>
      <button v-if="enrichingItems" class="btn btn-danger" @click="enrichStop" title="中止当前补全任务(已采集未入库的批次会收尾入库)">中止</button>
      <button class="btn btn-ghost" :disabled="syncingLogistics" @click="onSyncPurchaseLogistics" title="同步采购物流信息:补物流单号(1688)+拉完整轨迹(1688官方API+拼多多),与每小时定时轮同逻辑互斥,单轮每阶段上限100单">
        {{ syncingLogistics ? '物流同步中…' : '同步采购物流信息' }}
      </button>
    </div>
    <div v-if="syncingLogistics" class="enrich-progress-bar">
      <span class="tag tag-info">物流同步</span>
      <span class="enrich-progress-text">
        {{ LOGISTICS_PHASE_LABEL[logisticsProgress.phase] || '准备中' }}
        <template v-if="logisticsProgress.total"> · {{ logisticsProgress.done }}/{{ logisticsProgress.total }}</template>
      </span>
    </div>
    <div v-if="enrichingItems" class="enrich-progress-bar">
      <span class="tag tag-info">补全中</span>
      <span class="enrich-progress-text">
        {{ enrichProgress.done }}/{{ enrichProgress.total }}
        <template v-if="enrichProgress.platform"> · {{ enrichProgress.platform }}</template>
        · 找到 <b>{{ enrichProgress.found }}</b>
        · 未找到 <b>{{ enrichProgress.notFound }}</b>
        · 失败 <b>{{ enrichProgress.failed }}</b>
        · 已入库 <b>{{ enrichProgress.updated }}</b>
        <template v-if="enrichProgress.current"> · 当前 {{ enrichProgress.current }}</template>
      </span>
    </div>

    <!-- 同步进度条(进行中或已完成未关闭,2026-09-18:移至订单tab上一行) -->
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

    <!-- 订单金额统计(2026-09-18:移至订单tab上一行;全量订单口径不随tab/筛选变化;默认只展示已采购未结算+整体合计两行,已成功/已取消/已退货明细默认折叠) -->
    <div class="summary-bar" v-if="summary?.truncated">
      <span class="tag tag-warn">仅统计前 {{ summary.truncatedAt }} 单(共 {{ summary.totalUnfiltered }})</span>
    </div>
    <div class="summary-bar summary-loading" v-else-if="summaryLoading && !summary">
      <span class="muted">统计中…</span>
    </div>
    <div class="summary-bar summary-error" v-else-if="summaryError">
      <span class="muted">统计失败:{{ summaryError }}</span>
      <button class="btn btn-ghost btn-sm" @click="loadSummary(lastSummaryParams)">重试</button>
    </div>
    <div class="summary-bar summary-empty" v-else-if="summaryEmpty" v-show="!summaryLoading">
      <span class="muted">{{ summaryEmptyHint }}</span>
    </div>
    <div class="summary-bar summary-stack" v-else-if="summary" v-show="!summaryLoading">
      <!-- 第1行:已采购未结算(在途,估) -->
      <div class="summary-card summary-pending">
        <div class="summary-head">
          <span class="summary-title">已采购未结算</span>
          <span class="tag tag-warn">{{ summary.pendingSettled.orderCount }} 单</span>
          <span class="muted">（估）</span>
        </div>
        <div class="summary-metrics">
          <span class="metric"><span class="metric-label">订单总额</span><span class="metric-val">{{ fmtMoney(summary.pendingSettled.totalOrderAmount) }}</span></span>
          <span class="metric"><span class="metric-label">采购总额</span><span class="metric-val">{{ fmtMoney(summary.pendingSettled.totalPurchaseAmount) }}</span></span>
          <span class="metric"><span class="metric-label">利润总额</span><span class="metric-val" :class="summary.pendingSettled.totalProfit > 0 ? 'profit-pos' : (summary.pendingSettled.totalProfit < 0 ? 'profit-neg' : 'muted')">{{ fmtMoney(summary.pendingSettled.totalProfit) }}</span></span>
          <span class="metric"><span class="metric-label">销售利润率</span><span class="metric-val">{{ fmtRate(summary.pendingSettled.profitRateSale) }}</span></span>
          <span class="metric"><span class="metric-label">成本利润率</span><span class="metric-val">{{ fmtRate(summary.pendingSettled.profitRateCost) }}</span></span>
        </div>
      </div>
      <!-- 第2行:整体合计(终态:成功+取消+退货,不含在途) -->
      <div v-if="summary.overall && summary.overall.orderCount > 0" class="summary-card summary-overall" title="已成功+已取消+已退货 三组终态订单合计;不含已采购未结算(在途);退货率/取消率分母均为终态总单数">
        <div class="summary-head">
          <span class="summary-title">整体合计</span>
          <span class="tag">{{ summary.overall.orderCount }} 单</span>
          <span class="muted">（成功 {{ summary.settled.orderCount }} + 取消 {{ summary.cancelledCount }} + 退货 {{ summary.returnedCount }}）</span>
          <button class="btn btn-ghost btn-sm summary-detail-toggle" @click="summaryDetailOpen = !summaryDetailOpen" title="展开/收起已成功、已取消、已退货明细">
            {{ summaryDetailOpen ? '收起明细 ▴' : '展开明细 ▾' }}
          </button>
        </div>
        <div class="summary-metrics">
          <span class="metric"><span class="metric-label">订单总额</span><span class="metric-val">{{ fmtMoney(summary.overall.totalOrderAmount) }}</span></span>
          <span class="metric"><span class="metric-label">采购总额</span><span class="metric-val">{{ fmtMoney(summary.overall.totalPurchaseAmount) }}</span></span>
          <span class="metric"><span class="metric-label">利润总额</span><span class="metric-val" :class="summary.overall.totalProfit > 0 ? 'profit-pos' : (summary.overall.totalProfit < 0 ? 'profit-neg' : 'muted')">{{ fmtMoney(summary.overall.totalProfit) }}</span></span>
          <span class="metric"><span class="metric-label">销售利润率</span><span class="metric-val">{{ fmtRate(summary.overall.profitRateSale) }}</span></span>
          <span class="metric"><span class="metric-label">成本利润率</span><span class="metric-val">{{ fmtRate(summary.overall.profitRateCost) }}</span></span>
          <span class="metric"><span class="metric-label">退货率</span><span class="metric-val">{{ ratePct(summary.returnedCount, summary.overall.orderCount) }}</span></span>
          <span class="metric"><span class="metric-label">取消率</span><span class="metric-val">{{ ratePct(summary.cancelledCount, summary.overall.orderCount) }}</span></span>
        </div>
        <!-- 取消率细分:按取消发起者,分母均为终态总单数 -->
        <div class="summary-rate-breakdown">
          <span>买家取消率 <b>{{ ratePct(summary.cancelled.byInitiator.client, summary.overall.orderCount) }}</b></span>
          <span>Ozon取消率 <b>{{ ratePct(summary.cancelled.byInitiator.ozon, summary.overall.orderCount) }}</b><span v-if="summary.cancelled.ozonQualityInspection > 0" class="rate-sub">(质检单率 {{ ratePct(summary.cancelled.ozonQualityInspection, summary.overall.orderCount) }})</span></span>
          <span>卖家取消率 <b>{{ ratePct(summary.cancelled.byInitiator.seller, summary.overall.orderCount) }}</b></span>
        </div>
      </div>
      <!-- 明细(默认折叠):已成功 / 已取消 / 已退货 -->
      <div v-show="summaryDetailOpen" class="summary-row">
        <div class="summary-card summary-settled">
          <div class="summary-head">
            <span class="summary-title">已成功</span>
            <span class="tag tag-ok">{{ summary.settled.orderCount }} 单</span>
          </div>
          <div class="summary-metrics">
            <span class="metric"><span class="metric-label">订单总额</span><span class="metric-val">{{ fmtMoney(summary.settled.totalOrderAmount) }}</span></span>
            <span class="metric"><span class="metric-label">采购总额</span><span class="metric-val">{{ fmtMoney(summary.settled.totalPurchaseAmount) }}</span></span>
            <span class="metric"><span class="metric-label">利润总额</span><span class="metric-val" :class="summary.settled.totalProfit > 0 ? 'profit-pos' : (summary.settled.totalProfit < 0 ? 'profit-neg' : 'muted')">{{ fmtMoney(summary.settled.totalProfit) }}</span></span>
            <span class="metric"><span class="metric-label">销售利润率</span><span class="metric-val">{{ fmtRate(summary.settled.profitRateSale) }}</span></span>
            <span class="metric"><span class="metric-label">成本利润率</span><span class="metric-val">{{ fmtRate(summary.settled.profitRateCost) }}</span></span>
          </div>
        </div>
        <div v-if="summary.cancelledCount > 0" class="summary-card summary-cancelled" title="取消订单无收入:利润=−采购(无应计)或应计退款口径(有应计);订单总额为原下单金额,未实际收款">
          <div class="summary-head">
            <span class="summary-title">已取消</span>
            <span class="tag tag-err">{{ summary.cancelledCount }} 单</span>
          </div>
          <div class="summary-metrics">
            <span class="metric"><span class="metric-label">订单总额</span><span class="metric-val muted">{{ fmtMoney(summary.cancelled.totalOrderAmount) }}</span></span>
            <span class="metric"><span class="metric-label">采购总额</span><span class="metric-val">{{ fmtMoney(summary.cancelled.totalPurchaseAmount) }}</span></span>
            <span class="metric"><span class="metric-label">利润总额</span><span class="metric-val" :class="summary.cancelled.totalProfit > 0 ? 'profit-pos' : (summary.cancelled.totalProfit < 0 ? 'profit-neg' : 'muted')">{{ fmtMoney(summary.cancelled.totalProfit) }}</span></span>
          </div>
          <!-- 取消发起者细分:买家/Ozon(含质检单)/卖家;点击可跳转对应筛选 -->
          <div class="summary-cancel-breakdown">
            <button class="cancel-chip" title="买家取消的订单" @click="applyCancelInitiatorFilter('client')">买家取消 {{ summary.cancelled.byInitiator.client }}</button>
            <button class="cancel-chip" title="Ozon 取消的订单(质检单=抽检流程,不代表商品不通过)" @click="applyCancelInitiatorFilter('ozon')">
              Ozon 取消 {{ summary.cancelled.byInitiator.ozon }}<span v-if="summary.cancelled.ozonQualityInspection > 0" class="cancel-chip-sub">(质检单 {{ summary.cancelled.ozonQualityInspection }})</span>
            </button>
            <button class="cancel-chip" title="卖家取消的订单" @click="applyCancelInitiatorFilter('seller')">卖家取消 {{ summary.cancelled.byInitiator.seller }}</button>
            <span v-if="summary.cancelled.byInitiator.unknown > 0" class="muted">未分类 {{ summary.cancelled.byInitiator.unknown }}</span>
          </div>
        </div>
        <div v-if="summary.returnedCount > 0" class="summary-card summary-returned" title="妥投后买家退货退款,按行内同口径利润单独汇总,不计入已成功/已采购未结算两组">
          <div class="summary-head">
            <span class="summary-title">已退货</span>
            <span class="tag tag-err">{{ summary.returnedCount }} 单</span>
          </div>
          <div class="summary-metrics">
            <span class="metric"><span class="metric-label">订单总额</span><span class="metric-val">{{ fmtMoney(summary.returned.totalOrderAmount) }}</span></span>
            <span class="metric"><span class="metric-label">采购总额</span><span class="metric-val">{{ fmtMoney(summary.returned.totalPurchaseAmount) }}</span></span>
            <span class="metric"><span class="metric-label">利润总额</span><span class="metric-val" :class="summary.returned.totalProfit > 0 ? 'profit-pos' : (summary.returned.totalProfit < 0 ? 'profit-neg' : 'muted')">{{ fmtMoney(summary.returned.totalProfit) }}</span></span>
            <span class="metric"><span class="metric-label">销售利润率</span><span class="metric-val">{{ fmtRate(summary.returned.profitRateSale) }}</span></span>
            <span class="metric"><span class="metric-label">成本利润率</span><span class="metric-val">{{ fmtRate(summary.returned.profitRateCost) }}</span></span>
          </div>
        </div>
      </div>
    </div>

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
          <option value="multi" title="关联 ≥2 个采购单(拼单)">多条采购</option>
          <option value="manual" title="存在手工录入的采购单(模式B)">手工采购</option>
        </select>
        <select v-model="filters.noteFilter" class="filter-input" @change="search">
          <option value="">全部备注</option>
          <option value="has">有备注</option>
          <option value="none">无备注</option>
        </select>
        <select v-model="filters.tag" class="filter-input" :disabled="!tagOptions.length" @change="search">
          <option value="">{{ tagOptions.length ? '全部标签' : '暂无标签' }}</option>
          <option v-for="t in tagOptions" :key="t.name" :value="t.name">{{ t.name }} ({{ t.count }})</option>
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
        <button class="btn btn-ghost" @click="openRateDialog" title="RUB→CNY 汇率:已完成订单真实应计利润换算用">
          汇率 {{ rubRate?.rate ?? '未设置' }}
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
            <th class="col-purchase">采购信息</th>
            <th class="col-amount">金额(利润)</th>
            <th class="col-status">状态/时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="6" class="empty">{{ loading ? '加载中…' : (globalSearch.active ? '全局搜索未命中包裹' : '暂无订单(点击右上角「同步订单」拉取 Ozon 订单)') }}</td>
          </tr>
          <!-- 每订单固定 3 行:标签行(上) → 主行 → 备注行(下),空态也常驻(2026-09-15 v2) -->
          <template v-for="pkg in rows" :key="pkg.id">
          <!-- 标签行分两列(2026-09-16:订单信息列取消,店铺名+货件号+复制上移到第一列):第一列=店铺+货件号+复制,第二列=标签 + 选择面板 -->
          <tr class="pkg-subrow pkg-tags-row">
            <td colspan="2" class="pkg-tags-meta">
              <div class="pkg-tags-meta-line">
                <span class="pkg-tags-store" :title="pkg.storeName">{{ pkg.storeName }}</span>
                <template v-if="isQcPosting(pkg.postingNumber)">
                  <span class="pkg-qc-badge" title="质检单货件(02131/024785 开头)">质检单</span>
                  <span class="mono qc-posting" title="质检单货件号">{{ pkg.postingNumber }}</span>
                </template>
                <span v-else class="mono">{{ pkg.postingNumber }}</span>
                <button class="copy-btn" title="复制货件号" @click.stop="copyText(pkg.postingNumber, '货件号')">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
              </div>
            </td>
            <td colspan="4">
              <span v-for="t in sortTagsByOrder(pkg.tags)" :key="t" class="pkg-tag" :class="[tagColorClass(t), { 'pkg-tag-on': filters.tag === t }]">
                <button
                  class="pkg-tag-name"
                  :title="filters.tag === t ? '点击取消此标签筛选' : '点击按此标签筛选'"
                  @click="applyTagFilter(t)"
                >{{ t }}</button>
                <button class="pkg-tag-x" :aria-label="'移除标签 ' + t" title="移除标签" @click="removeTag(pkg, t)">×</button>
              </span>
              <!-- 选择面板(2026-09-15 v4):搜索+列表选择(点击 toggle,可多选)+新建+排序模式;替代原平铺快捷 chips -->
              <template v-if="tagEdit.pkgId === pkg.id">
                <div class="pkg-tag-pop" @click.stop>
                  <input
                    :ref="(el) => { if (el) el.focus() }"
                    v-model="tagEdit.search"
                    class="pkg-tag-pop-search"
                    placeholder="搜索或新建标签,回车确认"
                    @keydown="onTagSearchKeydown($event, pkg)"
                  />
                  <div class="pkg-tag-pop-list">
                    <div
                      v-for="(opt, oi) in tagPickerOptions(pkg)"
                      :key="opt.name"
                      class="pkg-tag-pop-item"
                      :class="{ own: opt.own, 'sort-mode': tagEdit.sortMode }"
                      :title="tagEdit.sortMode ? '使用箭头调整标签顺序(全局生效)' : (opt.own ? '点击移除该标签' : '点击添加该标签')"
                      @mousedown.prevent
                      @click="toggleTag(pkg, opt.name)"
                    >
                      <span class="pkg-tag-dot" :class="tagColorClass(opt.name)"></span>
                      <span class="pkg-tag-pop-name">{{ opt.name }}</span>
                      <span class="pkg-tag-pop-cnt">{{ opt.count }}</span>
                      <template v-if="tagEdit.sortMode">
                        <button class="pkg-tag-sort-btn" :disabled="oi === 0" title="上移" @click.stop="moveTagOrder(opt.name, -1)">↑</button>
                        <button class="pkg-tag-sort-btn" :disabled="oi === tagPickerOptions(pkg).length - 1" title="下移" @click.stop="moveTagOrder(opt.name, 1)">↓</button>
                      </template>
                      <span v-else-if="opt.own" class="pkg-tag-pop-check">✓</span>
                    </div>
                    <div
                      v-if="tagEdit.search.trim() && !tagPickerHasExact(pkg)"
                      class="pkg-tag-pop-item pkg-tag-pop-new"
                      :title="'新建标签:' + tagEdit.search.trim()"
                      @mousedown.prevent
                      @click="persistTags(pkg, [...(pkg.tags || []), tagEdit.search.trim()]); tagEdit.search = ''"
                    >＋ 新建“{{ tagEdit.search.trim() }}”</div>
                    <div v-if="!tagPickerOptions(pkg).length && !tagEdit.search.trim()" class="pkg-tag-pop-empty">暂无标签,输入名称回车新建</div>
                  </div>
                  <div class="pkg-tag-pop-foot">
                    <button class="pkg-tag-sort-toggle" :class="{ on: tagEdit.sortMode }" @mousedown.prevent @click="tagEdit.sortMode = !tagEdit.sortMode">
                      {{ tagEdit.sortMode ? '完成排序' : '排序' }}
                    </button>
                    <span class="pkg-tag-pop-hint">{{ tagEdit.sortMode ? '箭头调整顺序,全局生效(下拉/chip 同步)' : '点击选择可多选,已选✓再点移除' }}</span>
                  </div>
                </div>
              </template>
              <button v-else class="pkg-tag pkg-tag-add" title="添加标签(搜索选择已有,或输入新建)" @click.stop="openTagPicker(pkg)">＋ 标签</button>
            </td>
          </tr>
            <tr class="pkg-row">
            <td class="col-product">
              <div v-for="(it, i) in pkg.items" :key="i" class="product-item">
                <div v-if="it.picUrl" class="img-hover-wrap">
                  <a :href="it.pdpUrl" target="_blank" rel="noopener" class="product-img-box" :title="it.title || '查看Ozon商品'">
                    <img :src="it.picUrl" referrerpolicy="no-referrer" loading="lazy" class="product-img" alt="" />
                  </a>
                  <img class="img-preview" :src="it.picUrl" referrerpolicy="no-referrer" loading="lazy" alt="" />
                </div>
                <div class="product-main">
                  <a v-if="it.pdpUrl" :href="it.pdpUrl" target="_blank" rel="noopener" class="product-title" :title="it.title || ''">{{ it.title || '—' }}</a>
                  <div v-else class="product-title">{{ it.title || '—' }}</div>
                  <div class="product-sub" v-if="it.sku">SKU：<a class="order-link sku-link" href="javascript:void(0)" title="点击全局搜索该 SKU 的相关订单(跨所有状态,精确匹配)" @click.stop="searchBySku(it.sku)">{{ it.sku }}</a>
                    <button class="copy-btn" title="复制SKU" @click.stop="copyText(it.sku, 'SKU')">
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                  </div>
                  <div class="product-sub">Offer ID：{{ it.offerId }}
                    <button class="copy-btn" title="复制Offer ID" @click.stop="copyText(it.offerId, 'Offer ID')">
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                  </div>
                  <div class="product-sub">产品单价：{{ fmtMoney(it.price) }}</div>
                </div>
              </div>
              <div v-if="!pkg.items?.length" class="muted">—</div>
            </td>
            <td class="col-qty">
              <div v-for="(it, i) in pkg.items" :key="i" class="qty-line" :class="{ 'qty-multi': it.quantity > 1 }">× {{ it.quantity }}</div>
              <div v-if="!pkg.items?.length" class="muted">—</div>
            </td>
            <td class="col-purchase">
              <div v-if="!pkg.purchaseLinks?.length" class="muted">未录入</div>
              <div v-for="l in pkg.purchaseLinks" :key="l.id" class="purchase-item">
                <div class="purchase-head">
                  <span>{{ platformLabel(l.platform) }}</span>
                  <template v-if="l.purchaseSn">
                    <a v-if="orderDetailUrl(l.platform, l.purchaseSn)" :href="orderDetailUrl(l.platform, l.purchaseSn)" target="_blank" rel="noopener" class="mono order-link" :title="'打开' + platformLabel(l.platform) + '订单详情'">{{ l.purchaseSn }}</a>
                    <span v-else class="mono">{{ l.purchaseSn }}</span>
                    <button class="copy-btn" title="复制采购单号" @click.stop="copyText(l.purchaseSn, '采购单号')">
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                  </template>
                  <span v-else class="mono">#{{ l.id }}</span>
                </div>
                <div class="purchase-meta sub">
                  {{ poStatus(l.poStatus) }} · 采购金额 {{ fmtMoney(l.allocatedAmount) }}<template v-if="l.sellerName"> · {{ l.sellerName }}</template><template v-if="l.buyerAccount"> · 买:{{ l.buyerAccount }}</template>
                </div>
                <div v-for="(pi, j) in l.items" :key="j" class="purchase-goods">
                  <div v-if="pi.thumbUrl || pi.picUrl" class="img-hover-wrap">
                    <a v-if="goodsDetailUrl(l.platform, pi.goodsId)" :href="goodsDetailUrl(l.platform, pi.goodsId)" target="_blank" rel="noopener" class="goods-link">
                      <img :src="pi.thumbUrl || pi.picUrl"
                        referrerpolicy="no-referrer" loading="lazy" class="purchase-goods-img" alt=""
                        :title="pi.goodsName || pi.title || '采购商品'" />
                    </a>
                    <img v-else :src="pi.thumbUrl || pi.picUrl"
                      referrerpolicy="no-referrer" loading="lazy" class="purchase-goods-img" alt=""
                      :title="pi.goodsName || pi.title || '采购商品'" />
                    <img class="img-preview" :src="pi.thumbUrl || pi.picUrl" referrerpolicy="no-referrer" loading="lazy" alt="" />
                  </div>
                  <div class="purchase-goods-main">
                    <a v-if="goodsDetailUrl(l.platform, pi.goodsId)" :href="goodsDetailUrl(l.platform, pi.goodsId)" target="_blank" rel="noopener" class="goods-link purchase-goods-title" :title="pi.goodsName || pi.title || ''">
                      {{ clip20(pi.goodsName || pi.title || '采购商品') }}
                    </a>
                    <div v-else class="purchase-goods-title" :title="pi.goodsName || pi.title || ''">
                      {{ clip20(pi.goodsName || pi.title || '采购商品') }}
                    </div>
                    <div class="purchase-goods-sub">
                      <span v-if="pi.spec" :title="pi.spec">{{ clip20(pi.spec) }} · </span>¥{{ pi.price ?? '—' }} × {{ pi.number || pi.num || 1 }}
                    </div>
                  </div>
                </div>
                <div v-if="l.poLogisticsNo" class="sub po-logistics-line" :title="l.lastTraceDesc || ''">
                  {{ l.poLogisticsCompany }}
                  <a :href="trackingSearchUrl(l.poLogisticsCompany, l.poLogisticsNo)" target="_blank" rel="noopener" class="order-link" title="百度搜索物流状态">{{ l.poLogisticsNo }}</a>
                  <button v-if="parseTraceSteps(l).length > 1" class="trace-toggle" :title="'共' + parseTraceSteps(l).length + '条轨迹'" @click.stop="traceOpen[l.id] = !traceOpen[l.id]">
                    {{ traceOpen[l.id] ? '收起' : '更多' }}
                  </button>
                </div>
                <!-- 物流轨迹(1688买家版API/妙手,最新在前):默认仅最新一条,点"更多"展开其余(2026-09-17) -->
                <div v-if="parseTraceSteps(l).length" class="trace-box trace-box-collapsed">
                  <div v-for="(s, k) in visibleTraceSteps(l)" :key="k" class="trace-step">
                    <span class="trace-time mono">{{ s.acceptTime }}</span>
                    <span class="trace-remark">{{ s.remark }}</span>
                  </div>
                </div>
              </div>
            </td>
            <td class="col-amount">
              <!-- 金额列:名称左对齐、数字右对齐(amt-row flex);利润率单独两行 -->
              <div class="amt-row"><span class="amt-name">订单</span><span class="amt-val">{{ fmtMoney(pkg.orderAmount) }}</span></div>
              <div class="amt-row"><span class="amt-name">采购</span><span class="amt-val" :class="{ muted: !pkg.totalPurchaseAmount }">{{ fmtMoney(pkg.totalPurchaseAmount) }}</span></div>
              <!-- 销售佣金:应计 type 69 SaleCommission 实扣换算;无应计不估算(代理佣金已并入其它费用) -->
              <div class="amt-row sub" :title="saleFeeTitle(pkg)"><span class="amt-name">销售佣金</span><span class="amt-val" :class="{ muted: pkg.accrual?.saleFee == null }">{{ pkg.accrual?.saleFee != null ? fmtMoney(pkg.accrual.saleFee) : '—' }}</span></div>
              <!-- 销售佣金占订单金额百分比 -->
              <div class="amt-row sub muted" :title="'销售佣金 ÷ 订单金额 × 100%'"><span class="amt-name">佣金占比</span><span class="amt-val">{{ saleFeePct(pkg) }}</span></div>
              <!-- 国际配送(实际):应计 type 67 -->
              <div class="amt-row sub" :title="deliveryTitle(pkg)"><span class="amt-name">国际配送</span><span class="amt-val" :class="{ muted: pkg.accrual?.delivery == null }">{{ pkg.accrual?.delivery != null ? fmtMoney(pkg.accrual.delivery) : '—' }}</span></div>
              <!-- 国际配送(估):公式 3.37 + 0.0281 × weight_g 估算 -->
              <div class="amt-row sub muted" :title="deliveryTitle(pkg)"><span class="amt-name">国际配送(估)</span><span class="amt-val" :class="{ muted: pkg.profit?.delivery == null }">{{ pkg.profit?.delivery != null ? fmtMoney(pkg.profit.delivery) : '—' }}</span></div>
              <!-- 重量(实际):来源=订单称重 或 Ozon后台同步SKU加权(整数 g) -->
              <div class="amt-row sub" :title="weightTitle(pkg)"><span class="amt-name">{{ weightLabel(pkg) }}</span><span class="amt-val" :class="{ muted: pkg.weightG == null }">{{ pkg.weightG != null ? Math.floor(pkg.weightG) + 'g' : '—' }}</span></div>
              <!-- 重量(估):由实际配送费反推(整数 g) -->
              <div class="amt-row sub muted" :title="weightTitle(pkg)"><span class="amt-name">重量(估)</span><span class="amt-val" :class="{ muted: pkg.accrual?.derivedWeight == null }">{{ pkg.accrual?.derivedWeight != null ? pkg.accrual.derivedWeight + 'g' : '—' }}</span></div>
              <!-- 其它费用:代理佣金/星星商品/逆向物流等,= 应计合计 − 销售佣金 − 配送 -->
              <div class="amt-row sub" :title="othersTitle(pkg)"><span class="amt-name">其它费用</span><span class="amt-val" :class="{ muted: !pkg.accrual }">{{ pkg.accrual ? fmtMoney(pkg.accrual.others) : '—' }}</span></div>
              <div class="amt-row" :title="profitTitle(pkg)">
                <span class="amt-name sub">{{ profitLabel(pkg) }}</span>
                <span class="amt-val" :class="pkg.profit?.profit > 0 ? 'profit-pos' : (pkg.profit?.profit < 0 ? 'profit-neg' : 'muted')">{{ fmtMoney(pkg.profit?.profit) }}</span>
              </div>
              <div class="amt-row sub" title="销售利润率 = 利润 / 订单金额"><span class="amt-name">销售利润率</span><span class="amt-val">{{ fmtRate(pkg.profit?.profitRateSale) }}</span></div>
              <div class="amt-row sub" title="成本利润率 = 利润 / 采购金额"><span class="amt-name">成本利润率</span><span class="amt-val">{{ fmtRate(pkg.profit?.profitRateCost) }}</span></div>
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
              <!-- 退货信息行(仅 is_returned 订单显示:妥投后买家退货退款) -->
              <div v-if="pkg.isReturned" class="sub cancel-reason-line">
                <span class="tag tag-err" title="妥投后买家申请退货退款(销售冲回,配送/佣金等费用不返还)">已退货</span>
                <span class="cancel-reason-text" :title="pkg.returnState || ''">{{ returnStateLabel(pkg) }}</span>
                <span v-if="pkg.returnAt" class="tag tag-mute" title="买家发起退货时间">{{ fmtTime(pkg.returnAt) }}</span>
              </div>
              <div class="sub">下单：{{ fmtTime(pkg.inProcessAt) }}<template v-if="weekdayCN(pkg.inProcessAt)">（{{ weekdayCN(pkg.inProcessAt) }}）</template></div>
              <!-- 已取消订单不再展示最迟/剩发/已超时(取消后无发货义务,倒计时无意义) -->
              <div v-if="pkg.shipmentDate && !pkg.isShipped && pkg.ozonStatus !== 'cancelled'" class="sub">最迟：{{ fmtTime(pkg.shipmentDate) }}<template v-if="weekdayCN(pkg.shipmentDate)">（{{ weekdayCN(pkg.shipmentDate) }}）</template></div>
              <div v-if="countdown(pkg) && !pkg.isShipped && pkg.ozonStatus !== 'cancelled'" class="sub" :class="countdown(pkg).overdue ? 'overdue' : 'countdown'">
                {{ countdown(pkg).overdue ? '已超时：' : '剩发：' }}{{ countdown(pkg).text }}
              </div>
              <div v-if="pkg.isShipped" class="sub muted">已交运 {{ fmtTime(pkg.shippedAt) }}</div>
            </td>
            <td class="col-actions">
              <div class="action-group">
                <!-- 主操作(2026-09-17 v2):待处理tab=采购/备货/同步订单/更多;其它tab=备货/同步订单/同步采购物流/更多 -->
                <button
                  v-if="activeTab === 'waitProcess'"
                  class="btn btn-primary btn-sm"
                  title="录入/编辑采购信息(该包裹的采购单关联)"
                  @click="openPurchase(pkg)"
                >采购</button>
                <button
                  v-if="(pkg.operateStatus === 'wait_process' || pkg.operateStatus === 'wait_ship') && pkg.ozonStatus === 'awaiting_packaging'"
                  class="btn btn-ghost btn-sm"
                  :disabled="shippingPkgId === pkg.id"
                  :title="shippingPkgId === pkg.id ? '备货中…' : '向 Ozon 确认全部商品为一个货件(不拆分),备货后方可打印面单'"
                  @click="onShipPackage(pkg)"
                >{{ shippingPkgId === pkg.id ? '备货中…' : '备货' }}</button>
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="syncingPkgId === pkg.id"
                  :title="syncingPkgId === pkg.id ? '同步中…' : '按单号直查 Ozon 拉最新订单状态 + 强制拉应计项目(无时间窗口限制)'"
                  @click="onSyncPackage(pkg)"
                >{{ syncingPkgId === pkg.id ? '同步中…' : '同步订单' }}</button>
                <!-- 同步采购物流(2026-09-17):待处理tab收进"更多"菜单,其它tab主列直显 -->
                <button
                  v-if="pkg.purchaseLinks?.length && activeTab !== 'waitProcess'"
                  class="btn btn-ghost btn-sm"
                  :disabled="logisticsPkgId === pkg.id"
                  :title="logisticsPkgId === pkg.id ? '采购物流同步中…' : '该包裹全部关联采购单:补物流单号(1688/拼多多)+拉最新轨迹,强制刷新(不受1小时窗口限制)'"
                  @click="onSyncPackageLogistics(pkg)"
                >{{ logisticsPkgId === pkg.id ? '物流同步中…' : '同步采购物流' }}</button>
                <!-- 更多:次要操作下拉(采购/详情/打印面单/预览面单/仅标记交运/退回待处理/搁置) -->
                <div class="row-more">
                  <button class="btn btn-ghost btn-sm" title="更多操作" @click.stop="toggleRowMore($event, pkg)">更多<span class="row-more-caret">▾</span></button>
                </div>
              </div>
              <!-- 更多菜单(fixed 定位,脱离表格 overflow 裁剪;点外部/滚动关闭,项点击后即关) -->
              <div v-if="rowMore.pkgId === pkg.id" class="row-more-pop" :style="{ top: rowMore.top + 'px', left: rowMore.left + 'px' }" @click.stop>
                <!-- 采购:待处理tab已提升为主按钮,仅其它tab留在菜单 -->
                <button
                  v-if="activeTab !== 'waitProcess'"
                  class="row-more-item"
                  :class="{ 'row-more-item-strong': pkg.operateStatus === 'wait_process' || pkg.purchaseStatus === 'none' }"
                  title="录入/编辑采购信息"
                  @click="closeRowMore(); openPurchase(pkg)"
                >采购</button>
                <!-- 同步采购物流:待处理tab时从主列收进菜单(2026-09-17 v2) -->
                <button
                  v-if="activeTab === 'waitProcess' && pkg.purchaseLinks?.length"
                  class="row-more-item"
                  :disabled="logisticsPkgId === pkg.id"
                  :title="logisticsPkgId === pkg.id ? '采购物流同步中…' : '该包裹全部关联采购单:补物流单号(1688/拼多多)+拉最新轨迹,强制刷新'"
                  @click="closeRowMore(); onSyncPackageLogistics(pkg)"
                >{{ logisticsPkgId === pkg.id ? '物流同步中…' : '同步采购物流' }}</button>
                <button class="row-more-item" title="订单详情(产品行+采购关联+轨迹)" @click="closeRowMore(); openDetail(pkg)">详情</button>
                <button
                  v-if="pkg.operateStatus === 'wait_ship' || pkg.operateStatus === 'ship_success'"
                  class="row-more-item"
                  :disabled="printingId === pkg.id"
                  :title="printingId === pkg.id ? '面单打印中…' : pkg.operateStatus === 'ship_success' ? '重新打印该包裹的 Ozon 面单(缓存秒出)' : '拉取 Ozon 面单并静默打印(菜鸟打印组件),出纸后自动流转交运'"
                  @click="closeRowMore(); onPrintLabel(pkg)"
                >{{ printingId === pkg.id ? '打印中…' : '打印面单' }}</button>
                <button
                  v-if="pkg.operateStatus === 'wait_ship' || pkg.operateStatus === 'ship_success'"
                  class="row-more-item"
                  :disabled="labelPreview.loading === pkg.id"
                  title="无纸预览:组件按 CNPL 模板渲染面单效果,不出纸、不流转状态"
                  @click="closeRowMore(); onPreviewLabel(pkg)"
                >{{ labelPreview.loading === pkg.id ? '渲染中…' : '预览面单' }}</button>
                <button
                  v-if="pkg.operateStatus === 'wait_ship'"
                  class="row-more-item"
                  title="不拉取面单,仅标记已打印并流转交运(补录场景)"
                  @click="closeRowMore(); onPrinted(pkg)"
                >仅标记交运</button>
                <button
                  v-if="pkg.operateStatus === 'wait_ship'"
                  class="row-more-item row-more-item-danger"
                  title="取消全部采购关联,退回未采购"
                  @click="closeRowMore(); onRevert(pkg)"
                >退回待处理</button>
                <button class="row-more-item" :title="pkg.isIgnored ? '恢复搁置的包裹' : '暂不处理该包裹'" @click="closeRowMore(); onIgnore(pkg, !pkg.isIgnored)">
                  {{ pkg.isIgnored ? '恢复' : '搁置' }}
                </button>
              </div>
            </td>
            </tr>
            <!-- 备注行:点击进入行内编辑,blur/Ctrl+Enter 保存,Esc 取消;空态常驻"＋备注"按钮(2026-09-15 v2) -->
            <tr
              class="pkg-subrow pkg-note-row"
              :class="{ 'is-editing': noteEdit.pkgId === pkg.id }"
            >
              <td colspan="6">
                <span class="pkg-note-label">{{ noteEdit.pkgId === pkg.id ? (noteEdit.saving ? '保存中' : '编辑中') : '备注' }}</span>
                <textarea
                  v-if="noteEdit.pkgId === pkg.id"
                  :ref="(el) => { if (el) el.focus() }"
                  v-model="noteEdit.draft"
                  class="pkg-note-input"
                  rows="2"
                  :disabled="noteEdit.saving"
                  placeholder="备注(如采购说明、异常情况…),Ctrl+Enter 保存 / Esc 取消"
                  @keydown.esc="onNoteEsc"
                  @keydown.ctrl.enter.prevent="saveNote(pkg)"
                  @blur="saveNote(pkg)"
                ></textarea>
                <span
                  v-else-if="pkg.note"
                  class="pkg-note-text"
                  role="button"
                  tabindex="0"
                  title="点击编辑备注"
                  @click="startNoteEdit(pkg)"
                  @keydown.enter="startNoteEdit(pkg)"
                >{{ pkg.note }}</span>
                <button v-else class="pkg-note-add" title="添加备注" @click="startNoteEdit(pkg)">＋ 备注</button>
              </td>
            </tr>
          </template>
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

    <!-- 面单预览弹窗(无纸验证 CNPL 模板渲染效果,不出纸不流转状态) -->
    <AppModal :open="labelPreview.open" title="面单预览(CNPL 模板渲染 · 70×130mm)" @update:open="labelPreview.open = $event">
      <div class="label-preview-body">
        <img v-if="labelPreview.url" :src="labelPreview.url" alt="面单预览" class="label-preview-img" />
        <div class="label-preview-tip">
          组件按 CNPL 模板(label-image.xml)渲染:面单图片宽 70mm 等比缩放、顶部对齐,预览即实际出纸版式。
          出纸时会按 70×130mm 标签纸打印,预览不消耗纸张、不流转订单状态。
        </div>
      </div>
    </AppModal>

    <!-- 汇率设置弹窗(RUB→CNY,真实应计利润换算) -->
    <AppModal :open="rateDialogOpen" title="RUB → CNY 汇率设置" @update:open="rateDialogOpen = $event">
      <div class="rate-form">
        <div class="sync-all-tip">
          已完成/已取消订单的「真实口径利润」用应计数据(RUB)换算:回款 RUB × 汇率 = CNY。
          <br />未配置汇率时自动回退 16% 预估口径(显示"估")。
        </div>
        <div class="sync-all-date-row">
          <label>汇率</label>
          <input v-model.trim="rateInput" class="filter-input" placeholder="如 0.082(1 RUB = 0.082 CNY)" />
        </div>
        <div v-if="rubRate?.updatedAt" class="muted rate-updated-at">上次更新:{{ fmtUtcTime(rubRate.updatedAt) }}</div>
        <div class="form-actions">
          <button class="btn btn-ghost" @click="rateDialogOpen = false">取 消</button>
          <button class="btn btn-primary" :disabled="rateSaving" @click="saveRate">
            {{ rateSaving ? '保存中…' : '保 存' }}
          </button>
        </div>
      </div>
    </AppModal>

    <!-- 提交采购信息弹窗(模式B):两列布局(左=采购平台列表,右=订单信息+已选采购单,2026-09-17) -->
    <AppModal :open="purchaseOpen" :title="`采购 · ${purchaseForm.packageNo}`" size="xl" @update:open="purchaseOpen = $event">
      <div class="purchase-form purchase-form-cols">
        <!-- 左列:各采购平台列表(账号tabs + 平台订单列表/手动录入) -->
        <div class="purchase-col-left">
          <div class="import-platform-tabs">
            <button
              v-for="t in importAccountTabs"
              :key="t.key"
              class="pdd-tab"
              :class="{ active: importTab === t.key }"
              @click="switchImportTab(t.key)"
            >{{ t.label }}</button>
            <button class="pdd-tab" :class="{ active: importTab === 'manual' }" @click="switchImportTab('manual')">手动录入</button>
            <span v-if="importTab !== 'manual' && currentPlatformLogin === 'no'" class="pdd-bridge-warn" title="后端未检测到该账号登录态,请运行 qxqx 的 persistent(带账号参数)登录对应平台">未检测到{{ currentPlatformName }}登录态</span>
          </div>

          <!-- 平台订单列表(非手动录入) -->
          <div v-if="importTab !== 'manual'" class="import-section">
            <div class="pdd-toolbar">
              <div class="pdd-tabs">
                <button v-for="st in importSubTabs" :key="st.key" class="pdd-tab" :class="{ active: importSubTab === st.key }" @click="switchImportSubTab(st.key)">{{ st.label }}</button>
              </div>
              <!-- 订单号搜索(2026-09-16 先支持 1688;2026-09-17 扩展拼多多;只搜当前tab账号) -->
              <div v-if="isSearchableTab" class="pdd-search">
                <input
                  v-model.trim="importSearch.keyword"
                  class="filter-input pdd-search-input"
                  type="text"
                  :placeholder="searchPlaceholder"
                  :disabled="importSearch.loading"
                  @focus="$event.target.select()"
                  @keydown.enter="onSearchImportOrder"
                />
                <button class="btn btn-ghost btn-sm" :disabled="importSearch.loading || !importSearch.keyword" @click="onSearchImportOrder">
                  {{ importSearch.loading ? '搜索中…' : '搜索' }}
                </button>
              </div>
              <button class="btn btn-ghost btn-sm" :disabled="importLoading" @click="loadOrders(importTab)">刷新</button>
            </div>
            <div v-if="importSearch.error" class="pdd-error">{{ importSearch.error }}</div>

            <div v-if="importLoading" class="empty">加载中…</div>
            <div v-else-if="importError" class="pdd-error">{{ importError }}</div>
            <div v-else-if="!importOrders.length" class="empty">没有查询到订单</div>
            <div v-else class="pdd-list">
              <label
                v-for="o in importOrders"
                :key="o.orderSn"
                class="pdd-item"
                :class="{ disabled: isImportCancelled(o), selected: importSelected.includes(o.orderSn) || isRestoredLinked(o) }"
                :title="isRestoredLinked(o) ? '该订单已在已有采购关联中,如需删除请到右侧已选区点「删除」' : ''"
              >
                <input
                  type="checkbox"
                  :value="o.orderSn"
                  :disabled="isImportCancelled(o) || isRestoredLinked(o)"
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
                    <span>{{ o._platform === 'yangkeduo' ? fmtTime(o.orderTime * 1000) : (o.orderTime || '—') }}</span>
                    <span class="tag" :class="isImportCancelled(o) ? 'tag-mute' : 'tag-info'">{{ o.statusPrompt || '—' }}</span>
                    <span v-if="isRestoredLinked(o)" class="tag tag-warn">已关联</span>
                  </div>
                  <div class="pdd-sn mono">
                    {{ o.orderSn }}<template v-if="o.trackingNumber"> · {{ o.trackingNumber }}</template>
                  </div>
                </div>
              </label>
            </div>
          </div>

          <!-- 手动录入 tab:金额 + 快递单号 + 物流公司(左列,与平台列表同位) -->
          <div v-if="importTab === 'manual'" class="manual-input-section">
            <div class="form-row">
              <label>采购金额</label>
              <input v-model.trim="purchaseForm.paymentAmount" class="filter-input" placeholder="如 29.21(填了均摊到各产品行)" @input="syncManualAmount" />
              <label>采购平台</label>
              <select v-model="purchaseForm.platform" class="filter-input">
                <option v-for="p in PLATFORMS" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
            </div>
            <div class="form-row">
              <label>快递单号</label>
              <input v-model.trim="purchaseForm.logisticsNo" class="filter-input" placeholder="上家发货单号(填了视为已发货)" />
              <label>物流公司</label>
              <input v-model.trim="purchaseForm.logisticsCompany" class="filter-input" placeholder="如 顺丰/韵达/极兔" />
            </div>
          </div>
        </div>

        <!-- 右列:订单信息(产品表) + 已选采购订单 -->
        <div class="purchase-col-right">
        <!-- ① 最上方:订单产品(只读展示,采购金额从第②块同步显示上来) -->
        <div class="prod-title-row">
          <span class="form-section-title" style="margin: 0">订单产品</span>
          <label class="alloc-checkbox">
            <input type="checkbox" :checked="purchaseForm.allocMode === 'auto'" @change="purchaseForm.allocMode = $event.target.checked ? 'auto' : 'manual'" />
            <span>自动填写金额</span>
          </label>
        </div>
        <table class="data-table item-table">
          <thead>
            <tr>
              <th style="width: 260px">产品</th>
              <th>数量</th>
              <th>售价</th>
              <th style="width: 140px">采购金额</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, idx) in purchaseForm.items" :key="it.itemId">
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
                <!-- auto 模式:只读显示分摊预览;manual 模式:可输入(保留已分摊数值) -->
                <span v-if="purchaseForm.allocMode === 'auto'" class="alloc-amount-display">
                  {{ autoPreview && autoPreview.items[idx] ? fmtMoney(autoPreview.items[idx].previewAmount) : '—' }}
                </span>
                <input v-else v-model.trim="it.amount" class="filter-input amount-input" placeholder="0.00" />
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 已选采购订单区(固定在产品下方):平台/订单号/下单时间/金额(含已有采购恢复项) -->
        <div v-if="allSelectedOrders.length" class="selected-orders">
          <div class="selected-orders-title">
            已选 {{ allSelectedOrders.length }} 单 · 合计 ¥{{ allSelectedTotal }}
            <span v-if="restoredPurchases.length" class="selected-orders-sub">含已有采购 {{ restoredPurchases.length }} 单;勾选新订单后点「保存」追加;已有单可单独删除,或清空后点「保存」一键清空</span>
          </div>
          <table class="data-table selected-orders-table">
            <thead>
              <tr>
                <th style="width: 110px">平台</th>
                <th>订单号</th>
                <th style="width: 160px">下单时间</th>
                <th style="width: 100px">金额</th>
                <th style="width: 60px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in allSelectedOrders" :key="o._existing ? 'ex-' + o.purchaseOrderId : o._platform + ':' + (o._account || '') + ':' + o.orderSn">
                <td>
                  <span class="tag tag-info">{{ platformLabelByVal(o._platform) }}</span>
                  <!-- 买家账号显示优先级(2026-09-17):归一账号名(account=搜索命中/openapi 自带,_account=tab 账号)
                       > 平台原始登录名(tb537642872 之类仅 title 里参考);_existing 恢复项 buyerUsername 已是 DB 归一名 -->
                  <span v-if="o.account || o.buyerUsername || o._account" class="tag tag-mute" :title="o.buyerUserId ? `买手账号 ${o.account || o._account || o.buyerUsername}(平台登录名 ${o.buyerUsername},平台ID ${o.buyerUserId})` : '买手账号'">{{ o.account || o._account || o.buyerUsername }}</span>
                  <span v-if="o._existing" class="tag tag-warn" title="打开弹窗时恢复的已有采购关联">已有</span>
                </td>
                <td class="mono">{{ o.orderSn || '(手工单)' }}</td>
                <td>{{ o._existing ? '—' : (o._platform === 'yangkeduo' ? fmtTime(o.orderTime * 1000) : (o.orderTime || '—')) }}</td>
                <td class="pdd-amount">¥{{ o.amount }}</td>
                <td>
                  <button
                    v-if="o._existing"
                    class="btn btn-danger btn-sm"
                    title="删除该已有采购关联并冲回采购金额"
                    @click="removeRestoredPurchase(o)"
                  >删除</button>
                  <button v-else class="btn btn-ghost btn-sm" @click="removeSelectedOrder(o._platform, o.orderSn)">✕</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        </div><!-- /右列 purchase-col-right -->

        <!-- 底部通栏:提示 + 操作 -->
        <div class="purchase-form-footer">
        <div class="form-tip">
          提交后包裹将直接流转到「待打单发货」;国内快递单号可留空后续补录。清空所有采购后点「保存」即清空该包裹采购信息(状态不变)。个人自发货模式:无货代,收货人为你本人。
        </div>
        <div class="form-actions">
          <button class="btn btn-ghost" @click="purchaseOpen = false">取 消</button>
          <button class="btn btn-primary" :disabled="purchaseSaving" @click="savePurchase">
            {{ purchaseSaving ? '保存中…' : '保 存' }}
          </button>
        </div>
        </div><!-- /purchase-form-footer -->
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
          <div :title="saleFeeTitle(detail.package)"><span class="dl">销售佣金</span>{{ detail.package.accrual?.saleFee != null ? fmtMoney(detail.package.accrual.saleFee) : '—' }} <span class="muted">({{ saleFeePct(detail.package) }})</span></div>
          <div><span class="dl">采购合计</span>{{ fmtMoney(detail.package.totalPurchaseAmount) }}</div>
          <div :title="profitTitle(detail.package)"><span class="dl">{{ profitLabel(detail.package) }}</span>{{ fmtMoney(detail.package.profit?.profit) }}</div>
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

        <!-- Ozon 应计明细(已完成/已取消货件有数据;真实财务扣款,RUB) -->
        <div class="detail-section">
          <div class="detail-section-title">
            Ozon 应计明细
            <span v-if="detailAccrualSummary" class="tag tag-info" title="真实应计口径:回款=销售+应计,经汇率换算">真实口径</span>
            <span v-else class="tag tag-mute" title="未妥投或 Ozon 尚未生成应计(妥投后 2-3 周生成)">无应计数据</span>
            <button
              v-if="detail.package.ozonStatus === 'delivered' || detail.package.ozonStatus === 'cancelled' || detail.package.ozonStatus === 'not_accepted'"
              class="btn btn-ghost btn-sm"
              :disabled="accrualRefreshing === detail.package.id"
              :title="'重拉该货件的 Ozon 应计(取消后新增逆向物流等费用的兜底入口)· 上次拉取: ' + (detail.package.accrualSyncedAt ? fmtTime(detail.package.accrualSyncedAt) : '从未')"
              @click="onRefreshAccrual(detail.package)"
            >{{ accrualRefreshing === detail.package.id ? '刷新中…' : '刷新应计' }}</button>
          </div>
          <template v-if="detailAccruals.length">
            <table class="data-table item-table accrual-table">
              <thead>
                <tr><th>应计类型</th><th>金额(¥)</th><th>单价(¥)</th><th>数量</th><th>SKU</th><th>应计日期</th></tr>
              </thead>
              <tbody>
                <tr v-for="a in detailAccruals" :key="a.id">
                  <td><span :title="a.typeDescCn || a.typeName">{{ a.typeNameCn || a.typeName || a.typeId }}</span></td>
                  <td class="accrual-neg" :title="fmtRub(a.amount)">{{ fmtMoney(a.amountCny) }}</td>
                  <td :title="a.sellerPrice != null ? fmtRub(a.sellerPrice) : ''">{{ a.sellerPriceCny != null ? fmtMoney(a.sellerPriceCny) : '—' }}</td>
                  <td>{{ a.quantity ?? '—' }}</td>
                  <td class="mono">{{ a.sku || '—' }}</td>
                  <td>{{ a.accrualDate || '—' }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="detailAccrualSummary" class="accrual-summary">
              <span :title="fmtRub(detailAccrualSummary.saleRub)">销售收入 {{ fmtMoney(detailAccrualSummary.saleCny) }}</span>
              <span :title="fmtRub(detailAccrualSummary.totalRub)">应计合计 <b class="accrual-neg">{{ fmtMoney(detailAccrualSummary.totalCny) }}</b></span>
              <span :title="fmtRub(detailAccrualSummary.payoutRub)">回款 {{ fmtMoney(detailAccrualSummary.payoutCny) }}</span>
              <span v-if="detailAccrualSummary.rate" class="muted">汇率 {{ detailAccrualSummary.rate }}</span>
              <span v-else class="muted">(未配置汇率,无法换算 CNY)</span>
            </div>
          </template>
          <div v-else class="muted">该货件暂无应计明细{{ detail.package.accrualSyncedAt ? '(Ozon 尚未生成,妥投后 2-3 周生成,可稍后点「刷新应计」)' : '' }}</div>
        </div>

        <div class="detail-section">采购关联</div>
        <table v-if="detailLinks.length" class="data-table item-table">
          <thead>
            <tr><th>采购单</th><th>平台</th><th>状态</th><th>金额/商品</th><th>上家</th><th>国内物流</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in detailLinks" :key="l.id">
              <td class="mono">
                <a v-if="orderDetailUrl(l.platform, l.purchaseSn)" :href="orderDetailUrl(l.platform, l.purchaseSn)" target="_blank" rel="noopener" class="order-link" :title="'打开' + platformLabel(l.platform) + '订单详情'">{{ l.purchaseSn || '#' + l.purchaseOrderId }}</a>
                <template v-else>{{ l.purchaseSn || '#' + l.purchaseOrderId }}</template>
              </td>
              <td>{{ platformLabel(l.platform) }}</td>
              <td>{{ poStatus(l.poStatus) }}</td>
              <td>
                <div>{{ fmtMoney(l.allocatedAmount) }}</div>
                <div v-for="(pi, j) in l.items" :key="j" class="po-item-line">
                  <a v-if="goodsDetailUrl(l.platform, pi.goodsId)" :href="goodsDetailUrl(l.platform, pi.goodsId)" target="_blank" rel="noopener" class="goods-link">
                    <img v-if="pi.thumbUrl || pi.picUrl" :src="pi.thumbUrl || pi.picUrl"
                      referrerpolicy="no-referrer" loading="lazy" class="po-item-img" alt=""
                      :title="pi.goodsName || pi.title || '采购商品'" />
                  </a>
                  <img v-else-if="pi.thumbUrl || pi.picUrl" :src="pi.thumbUrl || pi.picUrl"
                    referrerpolicy="no-referrer" loading="lazy" class="po-item-img" alt=""
                    :title="pi.goodsName || pi.title || '采购商品'" />
                  <div class="po-item-info">
                    <a v-if="goodsDetailUrl(l.platform, pi.goodsId)" :href="goodsDetailUrl(l.platform, pi.goodsId)" target="_blank" rel="noopener" class="goods-link po-item-title" :title="pi.goodsName || pi.title || ''">
                      {{ pi.goodsName || pi.title || '采购商品' }}
                    </a>
                    <div v-else class="po-item-title" :title="pi.goodsName || pi.title || ''">
                      {{ pi.goodsName || pi.title || '采购商品' }}
                    </div>
                    <div class="po-item-sub muted">
                      <span v-if="pi.spec">{{ pi.spec }} · </span>¥{{ pi.price ?? '—' }} × {{ pi.number || pi.num || 1 }}
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <div>{{ l.sellerName || '—' }}</div>
                <div v-if="l.buyerAccount || l.buyerUserId" class="muted" style="font-size: 11px;">
                  买:{{ l.buyerAccount || '—' }}<template v-if="l.buyerUserId">(#{{ l.buyerUserId }})</template>
                </div>
              </td>
              <td>{{ l.poLogisticsCompany }} <a v-if="l.poLogisticsNo" :href="trackingSearchUrl(l.poLogisticsCompany, l.poLogisticsNo)" target="_blank" rel="noopener" class="order-link" title="百度搜索物流状态">{{ l.poLogisticsNo }}</a></td>
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
  /* 2026-09-17:去掉 1400px 上限——产品/采购列各 500px,列 min-width 合计约 1560px,
     1400 上限导致表格必然横向滚动;放开后宽屏(≥1600px)全列同屏展示 */
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
  /* 2026-09-18:自 tabs-bar 内移出独立成行(置于订单tab上一行),不再右贴 */
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
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

/* ── 大字号(2026-09-17):产品/采购/金额/状态/操作列主体字体 ×1.5;数量列保持原样 ── */
.pkg-row td {
  font-size: 19.5px; /* 原 .data-table 13px × 1.5 */
}
.pkg-row .col-qty {
  font-size: 13px; /* 数量列未点名,保持原样(含 .qty-multi 2em 原比例) */
}
.pkg-row .sub {
  font-size: 16.5px; /* 原 11px:下单/最迟/剩发/费率等次行 */
}
.pkg-row .mono {
  font-size: 18px; /* 原 12px:主行内 Ozon 状态等 mono 文本 */
}
.pkg-row .btn-sm {
  font-size: 18px; /* 原 12px:操作按钮 */
}
.pkg-row .tag {
  font-size: 18px; /* 原 12px:状态/采购/到货徽章 */
}

.col-product {
  min-width: 500px;
  max-width: 500px;
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
  flex: 0 0 120px;
  width: 120px;
  height: 120px;
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
  max-width: 300px; /* 2026-09-17:字体放大1.5倍后同步放宽(原200px) */
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
  max-width: 300px; /* 2026-09-17:字体放大1.5倍后同步放宽(原200px),减少省略 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 16.5px; /* 2026-09-17:11px × 1.5 */
  color: var(--text-primary, #111827);
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

.col-amount {
  min-width: 150px;
}

/* 金额列行:名称左对齐、数字右对齐 */
.amt-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.amt-row .amt-val {
  white-space: nowrap;
}

.col-purchase {
  min-width: 500px;
  max-width: 500px;
}

/* 采购信息列:参考产品信息列 product-item 结构,展示采购商品图/名称/规格/价格×数量 */
.purchase-item + .purchase-item {
  margin-top: 6px;
}
.purchase-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.purchase-meta {
  margin-top: 2px;
}
.purchase-goods {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 4px;
}
.purchase-goods-img {
  width: 120px;
  height: 120px;
  object-fit: contain;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 4px;
  flex: 0 0 120px;
}
.purchase-goods-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}
/* 采购商品详情页链接(图片/标题;悬停下划线示意可点) */
.goods-link {
  text-decoration: none;
  color: inherit;
  display: inline-flex;
  min-width: 0;
}
.goods-link:hover {
  text-decoration: underline;
}

/* 采购订单详情页链接(单号;蓝色示意可点) */
.order-link {
  text-decoration: none;
  color: #3b82f6;
}
.order-link:hover {
  text-decoration: underline;
}

/* 复制小图标按钮(采购单号旁) */
.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  vertical-align: middle;
  border-radius: 3px;
  flex: 0 0 auto;
}
.copy-btn:hover {
  color: #3b82f6;
  background: #eff6ff;
}

.purchase-goods-title {
  font-size: 18px; /* 2026-09-17:12px × 1.5 */
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.purchase-goods-sub {
  font-size: 16.5px; /* 2026-09-17:11px × 1.5 */
  line-height: 1.3;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 图片悬浮大图预览(订单商品/采购商品 120px;hover 在原图右侧放大 280px,2026-09-17) */
.img-hover-wrap {
  position: relative;
  flex-shrink: 0;
}
.img-preview {
  display: none;
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
  width: 280px;
  height: 280px;
  object-fit: contain;
  background: #fff;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  z-index: 30;
  pointer-events: none;
}
.img-hover-wrap:hover .img-preview {
  display: block;
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

/* ── 行"更多"操作菜单(2026-09-17)──────────────────────────
 * 主操作列只留 备货/同步订单/同步采购物流,次要操作收进本菜单;
 * fixed 定位:脱离 .data-table overflow:hidden / .table-wrap overflow 裁剪 */
.row-more {
  display: flex;
}
.row-more-caret {
  margin-left: 3px;
  font-size: 10px;
}
.row-more-pop {
  position: fixed;
  min-width: 150px;
  background: #fff;
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(30, 41, 59, 0.18);
  z-index: 60;
  padding: 4px 0;
}
.row-more-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  color: #1f2937;
  background: none;
  border: none;
  border-radius: 0;
  cursor: pointer;
}
.row-more-item:hover { background: #f1f5f9; }
.row-more-item:disabled { color: #9ca3af; cursor: default; background: none; }
.row-more-item-strong { color: #4338ca; font-weight: 700; }
.row-more-item-strong:hover { background: #e0e7ff; }
.row-more-item-danger { color: #dc2626; }
.row-more-item-danger:hover { background: #fee2e2; }

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

/* ── 订单子行:标签行(上,浅靛)/备注行(下,浅琥珀)(2026-09-15 重设计:行内编辑)── */
.pkg-subrow td {
  padding: 3px 10px;
  font-size: 12px;
  border-bottom: none;
}
.pkg-tags-row td {
  background: #f5f7ff;
  border-top: 1px solid #e5e7eb;
}
/* 标签行第一列(2026-09-16 订单信息列取消):店铺名+货件号+复制小图标,与右侧标签用细分隔线区分 */
.pkg-tags-row td.pkg-tags-meta {
  border-right: 1px solid #e5e7eb;
}
.pkg-tags-meta-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.pkg-tags-store {
  color: #374151;
  font-weight: 700;
  font-size: 21px; /* 2026-09-17:14px × 1.5(店铺名) */
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}
/* 质检单货件号(02131/024785 开头):红色加粗显著展示 */
.pkg-tags-meta-line .mono {
  flex: none;
  font-size: 18px; /* 2026-09-17:12px × 1.5(货件号) */
}
.pkg-tags-meta-line .qc-posting {
  font-weight: 700;
  font-size: 21px; /* 2026-09-17:14px × 1.5(质检单货件号) */
  color: #dc2626;
}
.pkg-qc-badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: #fee2e2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
/* 采购物流行:轨迹展开按钮 + 完整轨迹面板(最新在前,限高滚动) */
.po-logistics-line {
  display: flex;
  align-items: center;
  gap: 6px;
}
.trace-toggle {
  flex: none;
  padding: 0 6px;
  border: 1px solid #c7d2fe;
  border-radius: 4px;
  background: #eef2ff;
  color: #4338ca;
  font-size: 11px;
  line-height: 18px;
  cursor: pointer;
}
.trace-toggle:hover {
  background: #e0e7ff;
}
.trace-box {
  margin-top: 4px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fafafa;
  padding: 6px 8px;
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 折叠态(默认仅最新一条,2026-09-17):无边框无底色,融入正文 */
.trace-box-collapsed {
  border: none;
  background: none;
  padding: 0;
  max-height: none;
  overflow: visible;
}
.trace-step {
  display: flex;
  gap: 8px;
  font-size: 11px;
  line-height: 1.4;
}
.trace-time {
  flex: none;
  color: #6b7280;
}
.trace-remark {
  color: #111827;
  word-break: break-all;
}
.pkg-tags-meta-line .copy-btn {
  flex: none;
}
.pkg-note-row td {
  background: #fffbeb;
  color: #92400e;
  border-bottom: 1px solid #e5e7eb;
  word-break: break-all;
}
.pkg-note-label {
  flex: none;
  display: inline-block;
  margin-right: 8px;
  padding: 0 6px;
  border-radius: 4px;
  background: #fde68a;
  color: #92400e;
  font-size: 11px;
  font-weight: 600;
}
/* 备注行内容横排:标签 chip 与文本/输入框对齐 */
.pkg-note-row td {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.pkg-note-row.is-editing td { align-items: flex-start; }

/* ── 本地标签 chip:名=筛选 / ×=移除(悬停浮现);妙手旗帜同步时并入 tags 统一展示 ──
   v4(2026-09-15):8 色板循环,按 tag 名 hash 稳定分配,同名永远同色;
   色板变量(--tag-bg/--tag-fg/--tag-hover/--tag-dot)由 .tag-c0~.tag-c7 提供 */
.pkg-tag {
  display: inline-flex;
  align-items: center;
  margin: 1px 2px 1px 0;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  background: var(--tag-bg, #e0e7ff);
  color: var(--tag-fg, #4338ca);
  max-width: 220px;
  overflow: hidden;
  white-space: nowrap;
  transition: background .12s ease, box-shadow .12s ease;
}
.pkg-tag:hover { background: var(--tag-hover, #c7d2fe); }
.pkg-tag-name {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  padding: 2px 4px 2px 7px;
  cursor: pointer;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pkg-tag-name:hover { text-decoration: underline; text-underline-offset: 2px; }
.pkg-tag-x {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 2px 6px 2px 0;
  cursor: pointer;
  opacity: 0;
  line-height: 1;
}
.pkg-tag:hover .pkg-tag-x { opacity: .55; }
.pkg-tag-x:hover { opacity: 1; }
/* 当前筛选中的标签:用 chip 自身色作描边环,适配任意配色 */
.pkg-tag-on {
  box-shadow: 0 0 0 2px var(--tag-dot, #a5b4fc);
}
/* ＋ 添加标签 ghost chip */
.pkg-tag-add {
  display: inline-flex;
  align-items: center;
  margin: 1px 2px 1px 0;
  padding: 1px 7px;
  border: 1px dashed #c7d2fe;
  border-radius: 5px;
  background: transparent;
  color: #818cf8;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.pkg-tag-add:hover { background: #e0e7ff; border-style: solid; }

/* ── 8 色板:同名同色(hash 稳定,跨订单/跨面板一致)──
   chip:浅底深字 + hover 浅一档;dot:纯色实心(选择面板圆点) */
.pkg-tag.tag-c0, .pkg-tag-dot.tag-c0 { --tag-bg:#e0e7ff; --tag-fg:#4338ca; --tag-hover:#c7d2fe; --tag-dot:#6366f1; }
.pkg-tag.tag-c1, .pkg-tag-dot.tag-c1 { --tag-bg:#d1fae5; --tag-fg:#065f46; --tag-hover:#a7f3d0; --tag-dot:#10b981; }
.pkg-tag.tag-c2, .pkg-tag-dot.tag-c2 { --tag-bg:#fef3c7; --tag-fg:#92400e; --tag-hover:#fde68a; --tag-dot:#f59e0b; }
.pkg-tag.tag-c3, .pkg-tag-dot.tag-c3 { --tag-bg:#ffe4e6; --tag-fg:#9f1239; --tag-hover:#fecdd3; --tag-dot:#f43f5e; }
.pkg-tag.tag-c4, .pkg-tag-dot.tag-c4 { --tag-bg:#e0f2fe; --tag-fg:#075985; --tag-hover:#bae6fd; --tag-dot:#0ea5e9; }
.pkg-tag.tag-c5, .pkg-tag-dot.tag-c5 { --tag-bg:#ede9fe; --tag-fg:#5b21b6; --tag-hover:#ddd6fe; --tag-dot:#8b5cf6; }
.pkg-tag.tag-c6, .pkg-tag-dot.tag-c6 { --tag-bg:#fce7f3; --tag-fg:#9d174d; --tag-hover:#fbcfe8; --tag-dot:#ec4899; }
.pkg-tag.tag-c7, .pkg-tag-dot.tag-c7 { --tag-bg:#ccfbf1; --tag-fg:#115e59; --tag-hover:#99f6e4; --tag-dot:#14b8a6; }
/* dot 实心圆:用色板纯色,继承 --tag-dot */
.pkg-tag-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--tag-dot, #6366f1);
  flex: none;
}

/* ── 标签选择面板(替代原 datalist/快捷 chip;搜索+列表选择+新建+排序)── */
.pkg-tag-pop {
  display: inline-block;
  vertical-align: top;
  margin: 1px 0 1px 2px;
  width: 280px;
  max-width: calc(100vw - 64px);
  border: 1px solid #c7d2fe;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(30, 41, 59, 0.18);
  z-index: 20;
  overflow: hidden;
}
.pkg-tag-pop-search {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 7px 10px;
  font-size: 12px;
  font-family: inherit;
  border: none;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fbff;
  color: #1f2937;
  outline: none;
}
.pkg-tag-pop-search:focus { background: #fff; border-bottom-color: #a5b4fc; }
.pkg-tag-pop-list {
  max-height: 240px;
  overflow-y: auto;
  padding: 4px 0;
}
.pkg-tag-pop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  font-size: 12px;
  color: #1f2937;
  cursor: pointer;
  user-select: none;
}
.pkg-tag-pop-item:hover { background: #f1f5f9; }
.pkg-tag-pop-item.own { color: #4338ca; background: #f5f7ff; }
.pkg-tag-pop-item.own:hover { background: #e0e7ff; }
.pkg-tag-pop-item.sort-mode { cursor: default; }
.pkg-tag-pop-item.sort-mode:hover { background: transparent; }
.pkg-tag-pop-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pkg-tag-pop-cnt {
  flex: none;
  font-size: 11px;
  color: #9ca3af;
  font-weight: 600;
}
.pkg-tag-pop-check {
  flex: none;
  color: #4338ca;
  font-weight: 700;
  font-size: 13px;
  line-height: 1;
}
.pkg-tag-sort-btn {
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  background: #fff;
  color: #4338ca;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.pkg-tag-sort-btn:hover:not(:disabled) { background: #e0e7ff; border-color: #a5b4fc; }
.pkg-tag-sort-btn:disabled { opacity: .35; cursor: not-allowed; }
.pkg-tag-pop-new {
  color: #16a34a;
  font-weight: 600;
  border-top: 1px dashed #e5e7eb;
}
.pkg-tag-pop-new:hover { background: #f0fdf4; color: #15803d; }
.pkg-tag-pop-empty {
  padding: 12px 10px;
  font-size: 12px;
  color: #9ca3af;
  text-align: center;
}
.pkg-tag-pop-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid #e5e7eb;
  background: #f9fbff;
}
.pkg-tag-sort-toggle {
  flex: none;
  padding: 3px 10px;
  border: 1px solid #c7d2fe;
  border-radius: 4px;
  background: #fff;
  color: #4338ca;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.pkg-tag-sort-toggle:hover { background: #e0e7ff; }
.pkg-tag-sort-toggle.on { background: #4338ca; color: #fff; border-color: #4338ca; }
.pkg-tag-pop-hint {
  font-size: 11px;
  color: #9ca3af;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 备注行内编辑 ── */
.pkg-note-row:hover td { background: #fef3c7; }
.pkg-note-text {
  cursor: text;
  white-space: pre-wrap;
  min-width: 0;
  flex: 1;
}
.pkg-note-row:hover .pkg-note-text {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}
.pkg-note-input {
  flex: 1;
  margin: 0;
  padding: 4px 8px;
  font-size: 12px;
  font-family: inherit;
  border: 1px solid #fcd34d;
  border-radius: 5px;
  background: #fff;
  color: #1f2937;
  resize: vertical;
  outline: none;
}

/* ── 空态常驻按钮(2026-09-15 v2:标签/备注行空态也常驻展示)── */
.pkg-note-add {
  border: 1px dashed #fcd34d;
  border-radius: 5px;
  background: transparent;
  color: #b45309;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  cursor: pointer;
}
.pkg-note-add:hover { background: #fef3c7; border-style: solid; }

/* ── Tab 聚合统计(默认两行=已采购未结算+整体合计,明细三卡默认折叠,2026-09-18)── */
.summary-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
/* 主卡纵排(2026-09-18):第1行已采购未结算,第2行整体合计,第3行明细(默认折叠) */
.summary-bar.summary-stack {
  flex-direction: column;
  flex-wrap: nowrap;
}
.summary-stack .summary-card { width: 100%; }
/* 整体合计卡头右侧的明细展开/收起按钮 */
.summary-detail-toggle { margin-left: auto; }
.summary-bar.summary-loading,
.summary-bar.summary-error,
.summary-bar.summary-empty {
  padding: 6px 12px;
  font-size: 12px;
  align-items: center;
}
.summary-card {
  flex: 1;
  min-width: 280px;
  padding: 8px 12px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  background: #f9fafb;
}
.summary-settled { border-left: 3px solid #16a34a; }
.summary-pending { border-left: 3px solid #f59e0b; }
/* 已取消/已退货卡片(2026-09-15):红色系描边,与两组主卡区分 */
.summary-cancelled { border-left: 3px solid #dc2626; background: #fef2f2; }
.summary-returned { border-left: 3px solid #dc2626; background: #fef2f2; }
/* 整体合计卡片(2026-09-15):靛蓝描边,已成功+已取消+已退货终态合计 */
.summary-overall { border-left: 3px solid #4f46e5; background: #eef2ff; }
/* 已取消卡片:发起者细分行(买家/Ozon/卖家,点击跳转筛选) */
.summary-cancel-breakdown {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed #fecaca;
}
.cancel-chip {
  border: 1px solid #fecaca;
  border-radius: 4px;
  background: #fff;
  color: #b91c1c;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  cursor: pointer;
}
.cancel-chip:hover { background: #fee2e2; border-color: #fca5a5; }
.cancel-chip-sub { font-weight: 400; opacity: .8; }
.summary-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-weight: 600;
  font-size: 13px;
}
.summary-title { color: var(--text-primary, #111827); }
.summary-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.metric-label {
  color: var(--text-secondary, #6b7280);
  font-size: 11px;
}
.metric-val {
  font-weight: 600;
  color: var(--text-primary, #111827);
}
/* 明细行(2026-09-18):已成功/已取消/已退货 三卡横排,窄屏自动换行 */
.summary-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.summary-row .summary-card { flex: 1 1 200px; }
/* 整体卡:取消率细分行(买家/Ozon/卖家,分母=终态总单数) */
.summary-rate-breakdown {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed #c7d2fe;
  color: #4338ca;
  font-size: 11px;
}
.summary-rate-breakdown b { font-size: 12px; }
.rate-sub { opacity: .8; font-weight: 400; }

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
/* 两列布局(2026-09-17):左=采购平台列表,右=订单信息+已选采购单;底部通栏放提示/操作 */
.purchase-form-cols {
  display: grid;
  grid-template-columns: minmax(360px, 46%) minmax(340px, 1fr);
  gap: 0 20px;
  align-items: start;
}
.purchase-col-left {
  min-width: 0;
  border-right: 1px solid var(--border);
  padding-right: 20px;
}
/* 左列列表区独立滚动,避免长列表撑爆弹窗 */
.purchase-col-left .import-section {
  margin-bottom: 0;
}
.purchase-col-right {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.purchase-form-footer {
  grid-column: 1 / -1;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
@media (max-width: 1100px) {
  .purchase-form-cols {
    grid-template-columns: 1fr;
  }
  .purchase-col-left {
    border-right: none;
    padding-right: 0;
    border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
  }
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
  /* 多列排布(2026-09-17):grid 每行最多4个tab,超出自动换行(账号tab会越加越多) */
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
  margin-bottom: 8px;
}
/* 登录态警告横跨整行 */
.import-platform-tabs .pdd-bridge-warn {
  grid-column: 1 / -1;
}
/* 单格内超长账号名省略,不撑破格 */
.import-platform-tabs .pdd-tab {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.selected-orders-sub {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted, #9ca3af);
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

.pdd-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* 1688 订单号搜索区(工具栏中部) */
.pdd-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  margin-right: 8px;
}
.pdd-search-input {
  width: 230px;
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

/* 面单预览弹窗(无纸验证 CNPL 模板渲染) */
.label-preview-body {
  text-align: center;
}
.label-preview-img {
  max-width: 100%;
  max-height: 70vh;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 4px;
  background: #fff;
}
.label-preview-tip {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary, #9ca3af);
}

/* ── 应计项目(2026-09)────────────────────────────────── */
/* 应计扣款金额:红字(RUB,负数) */
.accrual-neg {
  color: #dc2626;
}

/* 应计明细表 */
.accrual-table td {
  padding: 6px 8px;
}

/* 应计合计行:销售收入/应计合计/回款/换算 */
.accrual-summary {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding: 8px 10px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 12px;
}
.accrual-payout-cny {
  color: #16a34a;
  font-weight: 700;
}

/* 汇率设置弹窗 */
.rate-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rate-updated-at {
  font-size: 11px;
}

/* 分摊模式切换(auto/manual) */
.alloc-mode-row {
  display: flex;
  align-items: center;
  margin: 12px 0 8px;
}
.prod-title-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 12px 0 8px;
}
.alloc-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
  color: var(--text-secondary, #667085);
}
.alloc-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.auto-alloc-section {
  margin-bottom: 8px;
}
.alloc-preview-info {
  margin: 4px 0 8px;
}
.alloc-hint {
  font-size: 12px;
  color: var(--text-secondary, #667085);
}
.alloc-linked-warn {
  font-size: 12px;
  color: #b54708;
  background: #fef3c7;
  padding: 6px 10px;
  border-radius: 4px;
  margin: 4px 0 8px;
}
.alloc-amount-display {
  font-weight: 600;
  color: var(--primary, #2563eb);
}

/* 详情弹窗采购关联表:商品图+规格+数量(数据来源 op_purchase_order.items_json,由"补全采购订单信息"按钮写入) */
.po-item-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-top: 1px dashed var(--border-color, #eee);
  margin-top: 4px;
}
.po-item-line:first-of-type {
  border-top: none;
  margin-top: 4px;
}
.po-item-img {
  width: 48px;
  height: 48px;
  object-fit: contain;
  border: 1px solid #eee;
  border-radius: 4px;
  flex: 0 0 48px;
}
.po-item-info {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}
.po-item-title {
  font-size: 12px;
  line-height: 1.3;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.po-item-sub {
  font-size: 11px;
  line-height: 1.3;
  margin-top: 2px;
}

/* 补全采购订单信息进度条 */
.enrich-progress-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  margin-top: 6px;
  /* 2026-09-18:随操作行移至 tabs 上方,与订单tab行拉开距离 */
  margin-bottom: 8px;
  background: var(--bg-soft, #f9fafb);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 4px;
  font-size: 12px;
}
.enrich-progress-text {
  color: var(--text-secondary, #6b7280);
}


</style>
