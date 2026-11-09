<script setup>
// FBS 货运创建/发运管理(2026-10-29)
// 流程:入库 → 选配送方式 → 创建发运 → 查看/调整货件 → 设快递员联系方式(OGL 上门取件)
//      → 确认发运 → 打印货运标签(2026-11-01:并入行内操作)→ 取消发运。
// 2026-11-01:打印/预览(货运标签)直接融入「发运清单 · 待处理」行操作,
// 标签打印机选择栏展示在清单上方,不再依赖独立打印页。
import { ref, reactive, computed, onMounted } from 'vue';
import { useStoresStore } from '../stores/stores.js';
import { useConfirmStore } from '../stores/confirm.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import { useCarriageLabelPrint } from '../composables/useCarriageLabelPrint.js';
import { fetchContainerLabelPrintStatus } from '../api/print-agent.js';
import {
  getCarriageList,
  getCarriageHistory,
  createCarriage,
  getCarriage,
  getCarriagePostings,
  getPendingPostings,
  reshipCarriagePosting,
  approveCarriage,
  cancelCarriage,
  getCarriageCourierContact,
  setCarriageCourierContact,
  setCarriagePostings,
  getAvailableCarriagePostings,
  getMixedCarriageCandidates,
  addMixedCarriagePostings,
  removeMixedCarriagePosting,
  listCourierContactConfigs,
  saveCourierContactConfigs,
} from '../api/order-process.js';

const storesStore = useStoresStore();
const confirmStore = useConfirmStore();
const { show } = useToast();

// 货运标签打印/预览(2026-11-01):并入发运清单行内操作,打印机选择栏在清单上方
// 2026-10-30 修复:composable 返回的 ref 必须用 reactive() 包裹,模板里 labelPrint.agentOnline 才会自动解包,
// 否则模板拿到 ref 对象本身,=== true/false/null 全部不成立 → 探测状态永远显示"探测中"、下拉空白、title 显示 [object Object]。
const labelPrint = reactive(useCarriageLabelPrint());

// 页面模式(2026-11-01):由 CarriageCenter 顶层 tab 驱动
// - pending:快递员联系方式配置 + 全店铺进行中发运清单(含创建/打印)
// - all:全部发运(进行中不含"待创建"占位行 + 已完成历史)
// - done:已完成发运历史(本地持久化,兼容旧入口)
const props = defineProps({
  mode: { type: String, default: 'pending' },
});
const isPending = computed(() => props.mode === 'pending');
const isDone = computed(() => props.mode === 'done');
const isAll = computed(() => props.mode === 'all');

// ── 状态文案 ────────────────────────────────────────────
const CARRIAGE_STATUS_LABELS = {
  new: '新建',
  formed: '已形成',
  created: '已创建',
  awaiting_delivery: '待发运',
  delivering: '运输中',
  received: '已接收',
  delivered: '已送达',
  cancelled: '已取消',
  closed: '已完结',
  archived: '已归档',
};
function carriageStatusLabel(status) {
  return CARRIAGE_STATUS_LABELS[status] || status || '—';
}
// 货件状态(operate_status,与订单处理一致;2026-11-02 详情/创建发运弹窗展示)
const POSTING_STATUS_LABELS = {
  wait_process: { label: '待采购', cls: 'st-warn' },
  wait_stock: { label: '待入库', cls: 'st-info' },
  wait_stick: { label: '待打单', cls: 'st-info' },
  wait_dispatch: { label: '待发运', cls: 'st-info' },
  dispatching: { label: '交运中', cls: 'st-info' },
  delivering: { label: '集运中', cls: 'st-ok' },
  signed: { label: '已签收', cls: 'st-ok' },
  settled: { label: '已成功', cls: 'st-ok' },
  returned: { label: '已退货', cls: 'st-warn' },
  cancelled: { label: '已取消', cls: 'st-err' },
};
function postingStatusMeta(status) {
  return POSTING_STATUS_LABELS[status] || null;
}
// ozon_status 兜底文案(历史快照本地查不到 operate_status 时用)
const OZON_STATUS_LABELS = {
  awaiting_packaging: '待打包',
  awaiting_registration: '待登记',
  awaiting_deliver: '待发运',
  dispatching: '交运中',
  delivering: '集运中',
  delivered: '已送达',
  not_delivered: '未送达',
  arbitration: '仲裁中',
  cancelled: '已取消',
};
function ozonStatusLabel(status) {
  return OZON_STATUS_LABELS[status] || status || '—';
}
function postingStatusText(p) {
  const m = postingStatusMeta(p?.operate_status);
  if (m) return m.label;
  if (p?.operate_status) return p.operate_status;
  return ozonStatusLabel(p?.ozon_status);
}
// 2026-11-07:跨店大包已发出悬浮提示(来源发运单/状态/OGL 单号/加入时间)
// 2026-11-08:formed(已形成)视为"已随大包创建发运",received/delivered/closed 视为"已随大包发出"
function crossShippedTitle(p) {
  const s = p?.cross_store_shipped;
  if (!s) return '';
  const created = s.carriageStatus === 'formed';
  const parts = [`已随发运单 ${s.carriageId} ${created ? '创建发运' : '发出'}`];
  if (s.carriageStatus) parts.push(`状态 ${s.carriageStatus}`);
  if (s.trackingNumber) parts.push(`OGL ${s.trackingNumber}`);
  if (s.addedAt) parts.push(`加入 ${s.addedAt}`);
  return parts.join('，');
}
// 2026-11-08:跨店补登记标签文案(formed=创建发运,已发出=Ozon 补登记)
function crossShippedLabel(p) {
  const s = p?.cross_store_shipped;
  if (!s) return '';
  const created = s.carriageStatus === 'formed';
  return `📦 已随 ${s.carriageId} 大包${created ? '创建发运' : '发出（Ozon 补登记）'}`;
}
function hasAction(c, action) {
  return Array.isArray(c?.available_actions) && c.available_actions.includes(action);
}
// 发运是否已确认:列表接口 /v2/carriage/delivery/list 不返回 available_actions(仅详情接口有),
// 只能按状态判断。2026-11-02 实测:formed(已形成)即可生成货位标签(预览/打印可用),
// 仅 new(新建,尚未形成发运)不可用;确认(approve)后进入 created/awaiting_delivery 仍可打印。
const UNCONFIRMED_CARRIAGE_STATUSES = ['new'];
function isCarriageConfirmed(c) {
  return !UNCONFIRMED_CARRIAGE_STATUSES.includes(c?.status);
}

// ── 当前店铺(配置接口鉴权用;发运清单已聚合所有店铺) ──────
const storeId = ref('');

// 创建发运弹窗(占位行触发,2026-11-01:移除顶部创建卡片;
// 2026-11-02:参考详情弹窗布局,展示将自动进入发运的待发运货件列表+货件状态)
const createModal = reactive({
  open: false,
  storeId: '',
  storeName: '',
  deliveryMethodId: '',
  deliveryMethodName: '',
  departureDate: new Date().toISOString().slice(0, 10),
  loading: false,
  postings: [],
  creating: false,
  // 快递员联系方式(创建时一并指定,2026-11-04;2026-11-05:直接由选中的配置项决定,无多余输入框)
  selectedContactConfigId: '', // 选中的配置项 id(无配置时为空,可先添加配置)
  contactConfigs: [], // 按创建店铺独立加载的联系方式配置
  configEditing: false, // 创建弹窗内配置管理(新增/修改)展开状态
  savingConfigs: false, // 配置保存中
  // 货件列表指定(2026-11-04):Ozon create 不支持指定货件,创建后走 set-postings 全量覆盖
  selectedPostingNumbers: [], // 勾选进入发运的货件号
  allSelected: true, // 全选状态
});

// 发运清单(2026-11-01:聚合所有店铺)
const carriageList = reactive({ stores: [], loaded: false, loading: false });

// 详情弹窗
const detail = reactive({
  open: false,
  carriageId: 0,
  fromHistory: false, // 2026-11-01:本地历史快照详情只读(Ozon 已完成发运查不到)
  carriage: null,
  postings: [],
  manualSnapshot: [], // 2026-11-02:进入详情时的跨店货件快照(保存时 diff 本地增删)
  crossCarriagePostings: [], // 2026-11-09:已在其他发运单活跃的货件(不弹窗,列表区提示条展示)
  postingsLoading: false,
  contact: [],
  contactLoading: false,
  // 联系方式表单
  phone: '',
  wechatNickname: '',
  comment: '',
  selectedContactConfigId: '', // 选中的配置项 id(2026-11-05:无配置时为空,表单可直接编辑)
  savingContact: false,
  editingContact: false, // 2026-11-05:详情弹窗联系方式默认只读展示,点击「修改」才进入输入框编辑
  containersCount: '',
  approving: false,
  cancelling: false,
});

// 2026-11-08:发运详情货件统计(本大包实际货件 / Ozon 补登记)
// 补登记 = 货件带 cross_store_shipped 标记(已随其它大包创建发运/发出,本发运单仅为 Ozon 补登记);
// 本大包实际货件 = 总货件 - 补登记。
const detailStats = computed(() => {
  const ps = detail.postings || [];
  const supplement = ps.filter((p) => p.cross_store_shipped).length;
  return { total: ps.length, actual: ps.length - supplement, supplement };
});

// 快递员联系方式配置(2026-10-30,支持多条 + 默认项)
const contactConfigs = reactive({
  loaded: false,
  saving: false,
  list: [], // [{ id, phone, wechatNickname, comment, isDefault }]
  expanded: false, // 2026-11-01:折叠时只展示默认项,展开后编辑全部
});

// 默认配置项(折叠时展示)
const defaultContactConfig = computed(
  () => contactConfigs.list.find((c) => c.isDefault) || contactConfigs.list[0] || null
);

// 货件编辑(增加/删除后全量 set-postings 保存)
const editPostings = reactive({ dirty: false, saving: false });

// 可加入货件候选弹窗(2026-11-02:本店/跨店分页 + 打单时间筛选)
// 2026-11-08:已完成发运单进入 history 模式(本地补记,本店+跨店)。
const candidate = reactive({
  open: false,
  loading: false,
  saving: false,
  tab: 'self',            // self=本店货件 / cross=跨店货件 / history=已完成发运单本地补记
  sourceStoreIds: [],     // 候选店铺 id 多选(默认全选)
  printedRange: 'all',    // 打单时间快捷筛选:all/today/yesterday
  printedFrom: '',        // 自定义起始日期 YYYY-MM-DD(至今,优先于快捷筛选)
  keyword: '',
  postings: [],
  selected: {},
});

// 跨店候选(2026-11-02;2026-11-06 店铺多选/全选,快捷筛选只留全部/今天/昨天)
const PRINTED_RANGES = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
];
const crossStores = computed(() => storesStore.list.filter((s) => String(s.id) !== String(storeId.value)));
// 候选店铺列表:补记模式含本店
const candidateStores = computed(() => {
  if (detail.fromHistory) {
    const self = storesStore.list.find((s) => String(s.id) === String(storeId.value));
    return [self, ...crossStores.value].filter(Boolean);
  }
  return crossStores.value;
});
const allStoresSelected = computed(
  () => candidateStores.value.length > 0 && candidateStores.value.every((s) => candidate.sourceStoreIds.includes(s.id))
);
function toggleAllStores() {
  candidate.sourceStoreIds = allStoresSelected.value ? [] : candidateStores.value.map((s) => s.id);
}

// 待发运货件弹窗(2026-11-02:点击占位行"货件数"查看该配送方式下待发运货件)
const pendingPostings = reactive({
  open: false,
  loading: false,
  storeId: '',
  storeName: '',
  deliveryMethodId: '',
  deliveryMethodName: '',
  postings: [],
});

// 货件期限展示(2026-11-02,与 H5 一致):已妥投/取消/退货不显示期限徽标
const SHIPPED_STATUSES = ['delivering', 'delivered', 'cancelled', 'returned'];
function postingDeadlineVisible(p) {
  return !!p?.shipment_date && !SHIPPED_STATUSES.includes(p?.ozon_status);
}
function fmtDeadline(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function isDeadlineUrgent(iso) {
  if (!iso) return false;
  const t = new Date(iso).getTime() - Date.now();
  return t > 0 && t <= 24 * 3600 * 1000;
}
function isDeadlineOverdue(iso) {
  return !!iso && new Date(iso).getTime() <= Date.now();
}

// 当前表格行(所有店铺各配送方式下发运 + 可创建占位行)
const currentRows = computed(() => {
  const rows = [];
  for (const s of carriageList.stores || []) {
    for (const m of s.methods || []) {
      for (const c of m.carriages || []) {
        const isPlaceholder = !Number(c.id) || Number(c.id) <= 0;
        rows.push({
          ...c,
          printed: !!c.printed, // 2026-11-01:响应式依赖打印状态(行内标记 + 打印后即时反馈)
          is_placeholder: isPlaceholder,
          store_id: s.storeId,
          store_name: s.storeName || '',
          delivery_method_id: m.delivery_method_id,
          delivery_method_name: m.delivery_method_name || '',
          departure_date: m.departure_date || '',
          warehouse_name: m.warehouse_name || '',
          warehouse_city: m.warehouse_city || '',
          cutoff_at: m.cutoff_at || '',
          timeslot: (m.timeslot_from || '') + (m.timeslot_to ? ` ~ ${m.timeslot_to}` : ''),
        });
      }
    }
  }
  return rows;
});

// 待处理:可创建占位行 + 正在进行中的发运(new/formed/created/awaiting_delivery/delivering)
const PENDING_STATUSES = ['new', 'formed', 'created', 'awaiting_delivery', 'delivering'];
const pendingRows = computed(() =>
  currentRows.value.filter((r) => r.is_placeholder || PENDING_STATUSES.includes(r.status))
);
// 进行中(排除"待创建"占位行)
const activeRows = computed(() => pendingRows.value.filter((r) => !r.is_placeholder));

// 已完成:本地持久化历史(2026-11-01,Ozon 已完成发运查不到,由后端同步入库)
const history = reactive({ list: [], loaded: false, loading: false });

async function loadHistory() {
  if (history.loading) return;
  history.loading = true;
  try {
    const data = await getCarriageHistory(storeId.value);
    history.list = (data?.items || []).map((it) => ({
      ...it,
      // 从 Ozon 列表消失被归档的进行中记录,在"已完成"里显示为"已归档"
      status_label:
        it.archived_at && PENDING_STATUSES.includes(it.status) ? '已归档' : carriageStatusLabel(it.status),
    }));
    history.loaded = true;
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    history.loading = false;
  }
}

// 店铺编号排序:YQL01→1, YQL02→2...(无法提取数字时排最后)
function storeRank(name = '') {
  const m = String(name).match(/(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}
// 全部:进行中(不含"待创建"占位行) + 已完成历史
// 2026-11-04:按发运时间排序(降序,最新在前),同一天按店铺名第二排序(YQL01, YQL02...),再按发运单号降序
const allRows = computed(() => {
  const rows = [...activeRows.value, ...history.list];
  return rows.sort((a, b) => {
    const da = a.departure_date || '';
    const db = b.departure_date || '';
    if (da !== db) return da > db ? -1 : 1;
    const ra = storeRank(a.store_name || a.store_id);
    const rb = storeRank(b.store_name || b.store_id);
    if (ra !== rb) return ra - rb;
    return Number(b.id || 0) - Number(a.id || 0);
  });
});

// 当前模式展示行与加载状态(mode 由顶层 tab 驱动;全部=进行中+历史)
const listLoading = computed(() =>
  isPending.value ? carriageList.loading : isAll.value ? carriageList.loading || history.loading : history.loading
);
const listLoaded = computed(() =>
  isPending.value ? carriageList.loaded : isAll.value ? carriageList.loaded && history.loaded : history.loaded
);
const listRows = computed(() =>
  isPending.value ? pendingRows.value : isAll.value ? allRows.value : history.list
);

// 刷新当前模式数据
function refreshCurrent() {
  if (isPending.value) {
    loadCarriages();
    if (!contactConfigs.loaded) loadContactConfigs();
  } else if (isAll.value) {
    // 全部模式:进行中 + 历史一起刷新
    loadCarriages();
    loadHistory();
    if (!contactConfigs.loaded) loadContactConfigs();
  } else {
    loadHistory();
  }
}

// 可用店铺(已配置 sync_credentials 的店铺)
const usableStores = computed(() => storesStore.list.filter((s) => s?.sync_credentials?.clientId));

// ── 发运清单(2026-11-01:聚合所有可用店铺) ──────────────────
async function loadCarriages() {
  if (carriageList.loading) return;
  carriageList.loading = true;
  try {
    const storeJobs = usableStores.value.map(async (s) => {
      try {
        const data = await getCarriageList(s.id, { limit: 1000 });
        return { storeId: s.id, storeName: s.name || '', methods: data?.methods || [] };
      } catch (err) {
        show(`店铺「${s.name || s.id}」发运清单加载失败:${err.message || String(err)}`, 'error');
        return { storeId: s.id, storeName: s.name || '', methods: [] };
      }
    });
    carriageList.stores = await Promise.all(storeJobs);
    carriageList.loaded = true;
    // 回填进行中发运的货运标签打印状态(与打印页同口径,按店铺批量查询)
    fillPrintedStatus(pendingRows.value.filter((r) => !r.is_placeholder));
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    carriageList.loading = false;
  }
}

// 按店铺批量查询货运标签打印状态并回填到行(失败静默,不影响清单展示)
// 行对象由 computed 展开(非响应式),直接写回 reactive 的原始 carriage 才能触发模板更新。
async function fillPrintedStatus(rows) {
  const byStore = new Map();
  for (const r of rows) {
    if (!byStore.has(r.store_id)) byStore.set(r.store_id, []);
    byStore.get(r.store_id).push(r);
  }
  await Promise.all(
    [...byStore.entries()].map(async ([storeId, list]) => {
      try {
        const ids = list.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
        if (!ids.length) return;
        const { printed } = await fetchContainerLabelPrintStatus(storeId, ids);
        const store = carriageList.stores.find((s) => s.storeId === storeId);
        for (const r of list) {
          for (const m of store?.methods || []) {
            for (const c of m.carriages || []) {
              if (Number(c.id) === Number(r.id)) c.printed = !!printed[Number(r.id)];
            }
          }
        }
      } catch { /* 忽略 */ }
    })
  );
}

// 行内打印:转发给 composable 执行,成功后同步写回 reactive 原始 carriage 的打印状态
async function onPrintLabel(row, copies) {
  await labelPrint.printLabel(row, copies);
  if (!row.printed) return;
  const store = carriageList.stores.find((s) => s.storeId === row.store_id);
  for (const m of store?.methods || []) {
    for (const c of m.carriages || []) {
      if (Number(c.id) === Number(row.id)) c.printed = true;
    }
  }
}

// ── 创建发运(占位行 → 弹窗,2026-11-01:移除顶部创建卡片) ──────
async function onGoCreate(row) {
  createModal.storeId = row.store_id || storeId.value || '';
  createModal.storeName = row.store_name || '';
  createModal.deliveryMethodId = String(row.delivery_method_id || '');
  createModal.deliveryMethodName = row.delivery_method_name || '';
  createModal.departureDate = new Date().toISOString().slice(0, 10);
  createModal.creating = false;
  createModal.postings = [];
  // 创建时同时指定快递员联系方式(2026-11-04;2026-11-05:预选默认配置,随发运一并保存)
  createModal.selectedContactConfigId = '';
  createModal.contactConfigs = [];
  createModal.configEditing = false; // 每次打开创建弹窗默认收起配置管理(2026-11-05)
  try {
    const data = await listCourierContactConfigs(createModal.storeId);
    createModal.contactConfigs = data?.contacts || [];
    const defaultItem =
      createModal.contactConfigs.find((c) => c.isDefault) || createModal.contactConfigs[0] || null;
    // 默认单选框选中默认配置
    createModal.selectedContactConfigId = defaultItem?.id || '';
  } catch (err) {
    // 配置加载失败不阻塞创建弹窗,仍可先展开管理配置重新添加
  }
  createModal.open = true;
  await loadCreatePostings();
}

// 加载该配送方式下将自动进入发运的待发运货件
async function loadCreatePostings() {
  if (!createModal.storeId || !createModal.deliveryMethodId) {
    createModal.postings = [];
    createModal.selectedPostingNumbers = [];
    createModal.allSelected = true;
    return;
  }
  createModal.loading = true;
  try {
    const data = await getPendingPostings(createModal.storeId, createModal.deliveryMethodId);
    createModal.postings = data?.postings || [];
    // 默认全选:创建后仅当用户取消勾选时才调用 set-postings 覆盖
    createModal.selectedPostingNumbers = createModal.postings.map((p) => p.posting_number).filter(Boolean);
    createModal.allSelected = true;
    // 2026-11-09:已在其他发运单的货件在列表行内标记"已发货·在#xxx",此处仅简短提示
    const existing = data?.existingCarriagePostings || [];
    if (existing.length) {
      show(`${existing.length} 个货件已在其他发运单(已发货),创建后不会自动带出;如需补发可在发运单详情「添加货件」中处理`, 'warning');
    }
  } catch (err) {
    show(err.message || String(err), 'error');
    createModal.postings = [];
    createModal.selectedPostingNumbers = [];
    createModal.allSelected = true;
  } finally {
    createModal.loading = false;
  }
}

async function onCreateFromModal() {
  if (!createModal.storeId) {
    show('缺少店铺信息,无法创建发运', 'error');
    return;
  }
  if (!createModal.deliveryMethodId) {
    show('缺少配送方式,无法创建发运', 'error');
    return;
  }
  createModal.creating = true;
  try {
    const body = { deliveryMethodId: Number(createModal.deliveryMethodId) };
    if (createModal.departureDate) body.departureDate = createModal.departureDate;
    const r = await createCarriage(createModal.storeId, body);
    const cid = Number(r?.carriage_id);
    // 创建时同时指定快递员联系方式(2026-11-04;2026-11-05:使用选中的配置项,未选则不保存)
    let contactSaved = false;
    const selectedContact = createModal.contactConfigs.find(
      (c) => c.id === createModal.selectedContactConfigId
    );
    if (cid > 0 && selectedContact && selectedContact.phone.trim() && selectedContact.comment.trim()) {
      try {
        // 2026-11-06:下单人名称为空时默认店铺名(兑现配置文案承诺;否则 Ozon 侧不存该字段,详情显示"—")
        const createStoreName = storesStore.list.find(
          (s) => String(s.id) === String(createModal.storeId)
        )?.name || '';
        await setCarriageCourierContact(createModal.storeId, cid, {
          phone: selectedContact.phone.trim(),
          wechatNickname: selectedContact.wechatNickname.trim() || createStoreName,
          comment: selectedContact.comment.trim(),
        });
        contactSaved = true;
      } catch (err) {
        show(`发运已创建,但快递员联系方式保存失败:${err.message || String(err)}`, 'error');
      }
    }
    // 指定货件列表(2026-11-04):仅当用户取消勾选了自动进入的货件时,set-postings 全量覆盖
    let postingsOverridden = false;
    if (cid > 0) {
      const autoNumbers = (createModal.postings || []).map((p) => p.posting_number).filter(Boolean);
      const selected = [...createModal.selectedPostingNumbers];
      if (autoNumbers.length && autoNumbers.some((n) => !selected.includes(n))) {
        try {
          await setCarriagePostings(createModal.storeId, cid, selected);
          postingsOverridden = true;
        } catch (err) {
          show(`发运已创建,但货件列表设置失败:${err.message || String(err)}`, 'error');
        }
      }
    }
    show(
      `发运创建成功:${cid ? '#' + cid : ''}${contactSaved ? ',联系方式已保存' : ''}${postingsOverridden ? ',货件已指定' : ''}`,
      'success'
    );
    createModal.open = false;
    await loadCarriages();
    if (cid > 0) {
      const found = currentRows.value.find(
        (row) => Number(row.id) === cid && row.store_id === createModal.storeId
      );
      openDetail(found || { id: cid, store_id: createModal.storeId });
    }
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    createModal.creating = false;
  }
}

// 创建弹窗:配置管理(2026-11-05)
function onCreateAddConfig() {
  createModal.contactConfigs.push({
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    phone: '',
    wechatNickname: '',
    comment: '',
    isDefault: false,
  });
  createModal.configEditing = true;
}

function onCreateRemoveConfig(index) {
  createModal.contactConfigs.splice(index, 1);
}

function onCreateSetDefault(item) {
  for (const c of createModal.contactConfigs) c.isDefault = false;
  item.isDefault = true;
}

async function onCreateSaveConfigs() {
  const incomplete = createModal.contactConfigs.find((c) => !c.phone.trim() || !c.comment.trim());
  if (incomplete) {
    show('每条配置都需要填写电话和地址', 'error');
    return;
  }
  const valid = createModal.contactConfigs.filter((c) => c.phone.trim() && c.comment.trim());
  createModal.savingConfigs = true;
  try {
    const data = await saveCourierContactConfigs(createModal.storeId, valid);
    createModal.contactConfigs = data?.contacts || [];
    // 保存成功后,保持当前选中的配置(若已被删则回退默认配置)
    const cur =
      createModal.contactConfigs.find((c) => c.id === createModal.selectedContactConfigId) ||
      createModal.contactConfigs.find((c) => c.isDefault) ||
      createModal.contactConfigs[0] ||
      null;
    createModal.selectedContactConfigId = cur?.id || '';
    show('联系方式配置已保存', 'success');
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    createModal.savingConfigs = false;
  }
}

// 创建弹窗:货件全选/取消全选(2026-11-04)
function onToggleCreateSelectAll(e) {
  createModal.allSelected = !!e?.target?.checked;
  createModal.selectedPostingNumbers = createModal.allSelected
    ? createModal.postings.map((p) => p.posting_number).filter(Boolean)
    : [];
}

// 创建弹窗:单个货件勾选变化后同步全选状态
function onCreatePostingSelectChange() {
  createModal.allSelected =
    createModal.postings.length > 0 &&
    createModal.selectedPostingNumbers.length === createModal.postings.length;
}

// ── 点击"货件数"查看货件列表(2026-11-02,与 H5 一致)──────
// 真实发运/历史 → 详情弹窗(内含货件列表);可创建占位行 → 待发运货件弹窗
async function onViewPostings(row) {
  if (row.is_placeholder) {
    pendingPostings.open = true;
    pendingPostings.loading = true;
    pendingPostings.storeId = row.store_id || storeId.value;
    pendingPostings.storeName = row.store_name || '';
    pendingPostings.deliveryMethodId = row.delivery_method_id || '';
    pendingPostings.deliveryMethodName = row.delivery_method_name || '';
    pendingPostings.postings = [];
    try {
      const data = await getPendingPostings(pendingPostings.storeId, pendingPostings.deliveryMethodId);
      pendingPostings.postings = data?.postings || [];
    } catch (err) {
      show(`获取待发运货件失败:${err.message || String(err)}`, 'error');
    } finally {
      pendingPostings.loading = false;
    }
    return;
  }
  await openDetail(row);
}

// ── 详情 ────────────────────────────────────────────────
async function openDetail(row) {
  // 发运清单跨店铺,详情相关接口以该发运所属店铺为准
  storeId.value = row.store_id || storeId.value;
  detail.open = true;
  detail.carriageId = Number(row.id);
  detail.fromHistory = !!row.from_history;
  detail.carriage = row;
  detail.postings = [];
  detail.crossCarriagePostings = [];
  detail.contact = [];
  detail.phone = '';
  detail.wechatNickname = '';
  detail.comment = '';
  detail.containersCount = '1'; // 默认 1(2026-11-06)
  detail.selectedContactConfigId = '';
  detail.editingContact = false; // 详情弹窗默认只读展示联系方式(2026-11-05)
  editPostings.dirty = false;
  if (!contactConfigs.loaded) await loadContactConfigs();
  // 本地历史快照(2026-11-01):Ozon 已完成发运查不到,直接展示本地保存的货件/联系方式
  if (row.from_history) {
    detail.carriage = { ...row, ...(row.carriage || {}), available_actions: [] };
    detail.postings = row.postings || [];
    detail.contact = row.contact || [];
    const first = detail.contact[0];
    const storeName = currentStoreName();
    detail.phone = first?.phone || '';
    detail.wechatNickname = first?.wechat_nickname || storeName;
    detail.comment = first?.comment || '';
    return;
  }
  await Promise.all([loadCarriageDetail(row), loadPostings(row), loadContact(row)]);
}

async function loadCarriageDetail(row) {
  try {
    const data = await getCarriage(storeId.value, Number(row.id));
    detail.carriage = { ...row, ...(data || {}) };
  } catch (err) {
    show(`获取发运详情失败:${err.message || String(err)}`, 'error');
  }
}

async function loadPostings(row) {
  detail.postingsLoading = true;
  try {
    // Ozon 实测 limit 上限 100(超限报 invalid AssemblyCarriagePostingListRequest.Limit)
    const data = await getCarriagePostings(storeId.value, Number(row.id), { limit: 100 });
    detail.postings = data?.postings || [];
    // 2026-11-09:跨发运单货件不再弹窗询问,以列表区提示条展示(补发入口在「添加货件」弹窗)
    detail.crossCarriagePostings = data?.crossCarriagePostings || [];
    // 2026-11-02:记录进入详情时的跨店货件快照(保存时 diff 本地增删)
    detail.manualSnapshot = detail.postings
      .filter((p) => p.source === 'manual')
      .map((p) => `${p.store_id}|${p.posting_number}`);
  } catch (err) {
    show(`获取发运货件失败:${err.message || String(err)}`, 'error');
  } finally {
    detail.postingsLoading = false;
  }
}

// 当前店铺名(微信昵称默认值)
function currentStoreName() {
  return storesStore.list.find((s) => String(s.id) === String(storeId.value))?.name || '';
}

// ── 快递员联系方式配置(多条 + 默认项,2026-10-30) ──────────
async function loadContactConfigs(force = false) {
  if (contactConfigs.loaded && !force) return;
  try {
    const data = await listCourierContactConfigs(storeId.value);
    contactConfigs.list = data?.contacts || [];
    contactConfigs.loaded = true;
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

function onAddContactConfig() {
  contactConfigs.list.push({
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    phone: '',
    wechatNickname: '',
    comment: '',
    isDefault: false,
  });
  // 新增配置需要编辑,自动展开
  contactConfigs.expanded = true;
}

function onRemoveContactConfig(index) {
  contactConfigs.list.splice(index, 1);
}

function onSetContactConfigDefault(item) {
  for (const c of contactConfigs.list) c.isDefault = false;
  item.isDefault = true;
}

async function onSaveContactConfigs() {
  // 每条配置必填:电话 + 地址(提供给快递公司);下单人名称选填
  const incomplete = contactConfigs.list.find((c) => !c.phone.trim() || !c.comment.trim());
  if (incomplete) {
    show('每条配置都需要填写电话和地址', 'error');
    return;
  }
  const valid = contactConfigs.list.filter((c) => c.phone.trim() && c.comment.trim());
  contactConfigs.saving = true;
  try {
    const data = await saveCourierContactConfigs(storeId.value, valid);
    contactConfigs.list = data?.contacts || [];
    contactConfigs.loaded = true;
    show('联系方式配置已保存', 'success');
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    contactConfigs.saving = false;
  }
}

// 详情表单:选择已配置的联系方式后自动填充
function onSelectContactConfig() {
  const item = contactConfigs.list.find((c) => c.id === detail.selectedContactConfigId);
  if (!item) return;
  detail.phone = item.phone || '';
  detail.wechatNickname = item.wechatNickname || currentStoreName();
  detail.comment = item.comment || '';
}

// 把当前详情表单存为配置(同电话更新为默认,否则新增一条默认)
async function onSetAsDefault() {
  if (!detail.phone.trim()) {
    show('请先填写快递员联系电话', 'error');
    return;
  }
  if (!detail.comment.trim()) {
    show('请填写提供给快递公司的取件地址', 'error');
    return;
  }
  try {
    const list = contactConfigs.list.map((c) => ({ ...c, isDefault: false }));
    const idx = list.findIndex((c) => c.phone === detail.phone.trim());
    if (idx >= 0) {
      list[idx] = {
        ...list[idx],
        phone: detail.phone.trim(),
        wechatNickname: detail.wechatNickname.trim(),
        comment: detail.comment.trim(),
        isDefault: true,
      };
    } else {
      list.push({
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        phone: detail.phone.trim(),
        wechatNickname: detail.wechatNickname.trim(),
        comment: detail.comment.trim(),
        isDefault: true,
      });
    }
    const data = await saveCourierContactConfigs(storeId.value, list);
    contactConfigs.list = data?.contacts || [];
    show('当前联系方式已设为默认配置', 'success');
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function loadContact(row) {
  detail.contactLoading = true;
  if (!contactConfigs.loaded) await loadContactConfigs();
  const defaultItem = contactConfigs.list.find((c) => c.isDefault) || contactConfigs.list[0] || null;
  const storeName = currentStoreName();
  try {
    const data = await getCarriageCourierContact(storeId.value, Number(row.id));
    const list = data?.contact || [];
    detail.contact = list;
    const first = list[0];
    // 默认加载规则(2026-10-30):Ozon 已存值优先 → 配置默认项兜底 → 微信昵称再兜底店铺名
    detail.phone = first?.phone || defaultItem?.phone || '';
    detail.wechatNickname = first?.wechat_nickname || defaultItem?.wechatNickname || storeName;
    detail.comment = first?.comment || defaultItem?.comment || '';
    detail.selectedContactConfigId = '';
  } catch (err) {
    // 不适用/未配置时静默:详情页仍可手动填写
    detail.contact = [];
    detail.phone = defaultItem?.phone || '';
    detail.wechatNickname = defaultItem?.wechatNickname || storeName;
    detail.comment = defaultItem?.comment || '';
    detail.selectedContactConfigId = '';
  } finally {
    detail.contactLoading = false;
  }
}

// 联系方式仅适用 first_mile_type=pickup + integration_type=ozon_outsourced
const contactApplicable = computed(() => {
  const c = detail.carriage;
  return c?.first_mile_type === 'pickup' && c?.integration_type === 'ozon_outsourced';
});

async function onSaveContact() {
  if (!detail.phone.trim()) {
    show('请填写快递员联系电话', 'error');
    return;
  }
  if (!detail.comment.trim()) {
    show('请填写提供给快递公司的取件地址', 'error');
    return;
  }
  detail.savingContact = true;
  try {
    await setCarriageCourierContact(storeId.value, detail.carriageId, {
      phone: detail.phone.trim(),
      wechatNickname: detail.wechatNickname.trim(),
      comment: detail.comment.trim(),
    });
    show('快递员联系方式已保存', 'success');
    detail.editingContact = false;
    await loadContact(detail.carriage);
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detail.savingContact = false;
  }
}

// 取消编辑:退出编辑模式并恢复为已保存值
function onCancelEditContact() {
  detail.editingContact = false;
  const first = detail.contact[0];
  const storeName = currentStoreName();
  if (first) {
    detail.phone = first.phone || '';
    detail.wechatNickname = first.wechat_nickname || storeName;
    detail.comment = first.comment || '';
  } else {
    detail.phone = '';
    detail.wechatNickname = storeName;
    detail.comment = '';
  }
  detail.selectedContactConfigId = '';
}

async function onApprove() {
  // 2026-11-02:OGL 上门取件发运确认前必须先保存快递员联系方式(Ozon COURIER_CONTACT_REQUIRE)
  if (contactApplicable.value && !(detail.contact || []).length) {
    show('该发运需先保存快递员联系方式(联系电话+取件地址),再确认发运', 'error');
    return;
  }
  const ok = await confirmStore.ask({
    title: '确认发运',
    message: `确认发运 #${detail.carriageId}?\n确认后发运进入「已生成」状态,后续可打印面单/货位标签。`,
    confirmText: '确认发运',
  });
  if (!ok) return;
  detail.approving = true;
  try {
    await approveCarriage(storeId.value, detail.carriageId, detail.containersCount || undefined);
    show(`发运 #${detail.carriageId} 已确认`, 'success');
    await loadCarriageDetail(detail.carriage);
    await loadCarriages();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detail.approving = false;
  }
}

async function onCancel() {
  const ok = await confirmStore.ask({
    title: '取消发运',
    message: `确认取消发运 #${detail.carriageId}?\n取消后货件将回到未发运状态,可重新组入下一次发运。`,
    confirmText: '取消发运',
    danger: true,
  });
  if (!ok) return;
  detail.cancelling = true;
  try {
    await cancelCarriage(storeId.value, detail.carriageId);
    show(`发运 #${detail.carriageId} 已取消`, 'success');
    detail.open = false;
    await loadCarriages();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detail.cancelling = false;
  }
}

// 货件内商品摘要
function productsSummary(p) {
  const items = p?.products || [];
  if (!items.length) return '—';
  return items
    .slice(0, 3)
    .map((it) => `${it.name || it.product_name || it.offer_id || it.sku || ''} ×${it.quantity ?? ''}`)
    .filter(Boolean)
    .join('、') + (items.length > 3 ? ` 等${items.length}项` : '');
}

// 商品名称展示截断(2026-11-05):最长15个字符,超长以省略号结尾
function shortProductName(name, len = 15) {
  if (!name) return '';
  const s = String(name);
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

// ── 货件增加/删除(2026-10-30,set-postings 全量覆盖) ──────────
// 仅 new 状态允许调整货件(Ozon set-postings 仅发运创建后未确认前可用)
const postingsEditable = computed(() => detail.carriage?.status === 'new');

// 打开候选货件弹窗(2026-11-02:默认本店货件 tab)
// 2026-11-08:已完成发运单进入本地补记模式(本店+跨店候选,纯本地关联)
async function onOpenCandidate() {
  candidate.open = true;
  candidate.selected = {};
  candidate.printedRange = 'all';
  candidate.printedFrom = '';
  candidate.keyword = '';
  candidate.postings = [];
  if (detail.fromHistory) {
    candidate.tab = 'history';
    candidate.sourceStoreIds = candidateStores.value.map((s) => s.id);
    await loadHistoryCandidates();
  } else {
    candidate.tab = 'self';
    candidate.sourceStoreIds = [];
    await loadSelfCandidates();
  }
}

// 本店货件候选(2026-11-09:未妥投池单来源 = awaiting_deliver 中曾在本店其他发运单记录过的货件)
async function loadSelfCandidates() {
  candidate.loading = true;
  try {
    const data = await getAvailableCarriagePostings(storeId.value, detail.carriageId, {
      deliveryMethodId: detail.carriage?.delivery_method_id || undefined,
    });
    candidate.postings = data?.postings || [];
    if (!candidate.postings.length) show('没有曾在本店其他发运单记录过的待发运货件', 'info');
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    candidate.loading = false;
  }
}

// 切换 本店/跨店 分页
function switchCandidateTab(tab) {
  if (candidate.tab === tab) return;
  candidate.tab = tab;
  candidate.selected = {};
  candidate.postings = [];
  if (tab === 'cross') {
    candidate.sourceStoreIds = crossStores.value.map((s) => s.id); // 默认全选
    candidate.printedRange = 'all';
    candidate.printedFrom = '';
    candidate.keyword = '';
  }
}

function setPrintedRange(key) {
  candidate.printedRange = key;
  candidate.printedFrom = ''; // 点快捷选项即清除自定义日期,避免两套条件叠加
}

// 计算打单时间筛选区间 → UTC ISO(北京时间日界;自定义为起始日至今)
function computePrintedRange(key, fromDate) {
  const pad = (n) => String(n).padStart(2, '0');
  const dayStartIso = (d) => {
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00+08:00`;
    return new Date(local).toISOString();
  };
  if (fromDate) return { from: new Date(`${fromDate}T00:00:00+08:00`).toISOString() };
  const now = new Date();
  if (key === 'today') return { from: dayStartIso(now) };
  if (key === 'yesterday') {
    const y = new Date(now.getTime() - 24 * 3600 * 1000);
    return { from: dayStartIso(y), to: dayStartIso(now) };
  }
  return {};
}

function fmtPrinted(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 跨店待发运候选(本地库 + 打单时间筛选;2026-11-06 店铺多选)
async function loadCrossCandidates() {
  if (!candidate.sourceStoreIds.length) {
    show('请先选择店铺', 'warning');
    return;
  }
  candidate.loading = true;
  try {
    const params = { carriageId: detail.carriageId, sourceStoreIds: candidate.sourceStoreIds };
    const range = computePrintedRange(candidate.printedRange, candidate.printedFrom);
    if (range.from) params.printedFrom = range.from;
    if (range.to) params.printedTo = range.to;
    if (candidate.keyword.trim()) params.keyword = candidate.keyword.trim();
    const data = await getMixedCarriageCandidates(storeId.value, params);
    candidate.postings = data?.postings || [];
    candidate.selected = {};
    if (!candidate.postings.length) show('没有符合筛选条件的待发运货件', 'info');
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    candidate.loading = false;
  }
}

// 已完成发运单本地补记候选(2026-11-08):本店+跨店,走 mixed-candidates includeSelf
async function loadHistoryCandidates() {
  if (!candidate.sourceStoreIds.length) {
    show('请先选择店铺', 'warning');
    return;
  }
  candidate.loading = true;
  try {
    const params = {
      carriageId: detail.carriageId,
      sourceStoreIds: candidate.sourceStoreIds,
      includeSelf: true,
    };
    const range = computePrintedRange(candidate.printedRange, candidate.printedFrom);
    if (range.from) params.printedFrom = range.from;
    if (range.to) params.printedTo = range.to;
    if (candidate.keyword.trim()) params.keyword = candidate.keyword.trim();
    const data = await getMixedCarriageCandidates(storeId.value, params);
    candidate.postings = data?.postings || [];
    candidate.selected = {};
    if (!candidate.postings.length) show('没有符合筛选条件的待发运货件', 'info');
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    candidate.loading = false;
  }
}

// 候选列表全选/反选(2026-11-06)
function selectAllCandidates() {
  for (const p of candidate.postings) candidate.selected[p.posting_number] = true;
}
function invertCandidates() {
  for (const p of candidate.postings) candidate.selected[p.posting_number] = !candidate.selected[p.posting_number];
}
const selectedCount = computed(() => candidate.postings.filter((p) => candidate.selected[p.posting_number]).length);

// 确认加入候选货件
async function onConfirmAddCandidates() {
  const selected = candidate.postings.filter((p) => candidate.selected[p.posting_number]);
  if (!selected.length) {
    show('请先勾选要加入的货件', 'warning');
    return;
  }
  // 已完成发运单:本地补记关联(纯本地写入,不推送 Ozon)
  if (detail.fromHistory) {
    candidate.saving = true;
    try {
      const items = selected.map((p) => ({ storeId: p.store_id, postingNumber: p.posting_number }));
      const r = await addMixedCarriagePostings(storeId.value, detail.carriageId, items);
      const addedCount = r?.addedCount ?? 0;
      candidate.open = false;
      if (addedCount) show(`已补记 ${addedCount} 个货件`, 'success');
      else show('所选货件均已关联,无需重复添加', 'info');
      await refreshHistoryDetail();
    } catch (err) {
      show(err.message || String(err), 'error');
    } finally {
      candidate.saving = false;
    }
    return;
  }
  // 2026-11-09:已在其他发运单(已发货)的货件 → 勾选即补发(reship 立即落库,两个发运单同时记录);
  // 普通货件保持原有"加入列表 → 保存"流程(全量 set-postings 生效)。
  const reshipItems = selected.filter((p) => p.inOtherCarriage);
  const normalItems = selected.filter((p) => !p.inOtherCarriage);
  let reshipped = 0;
  if (reshipItems.length) {
    candidate.saving = true;
    try {
      for (const p of reshipItems) {
        try {
          await reshipCarriagePosting(storeId.value, detail.carriageId, p.posting_number);
          reshipped += 1;
        } catch (err) {
          show(`补发 ${p.posting_number} 失败:${err.message || String(err)}`, 'error');
        }
      }
    } finally {
      candidate.saving = false;
    }
  }
  const existing = new Set(detail.postings.map((p) => p.posting_number));
  const added = normalItems.filter((p) => !existing.has(p.posting_number));
  if (added.length) {
    detail.postings = [...detail.postings, ...added];
    editPostings.dirty = true;
  }
  if (!reshipped && !added.length) {
    show('所选货件已在列表中', 'info');
    candidate.open = false;
    return;
  }
  candidate.open = false;
  const msgs = [];
  if (reshipped) msgs.push(`已补发 ${reshipped} 个货件(将同时记录在两个发运单)`);
  if (added.length) msgs.push(`已加入 ${added.length} 个货件${reshipped ? '(保存后生效)' : ''}`);
  if (msgs.length) show(msgs.join(';'), 'success');
  // 仅补发(无普通货件暂存)时刷新详情列表,让补发货件立即出现在当前发运单
  if (reshipped && !added.length) {
    await loadPostings(detail.carriage);
  }
}

// 已完成发运单补记后刷新历史列表并重开详情(展示本地新增 manual 行)
async function refreshHistoryDetail() {
  await loadHistory();
  const row = history.list.find((r) => Number(r.id) === Number(detail.carriageId));
  if (row) await openDetail(row);
}

// 移除已完成发运单的本地补记关联(2026-11-08)
async function onRemoveHistoryPosting(p) {
  if (!(await confirmStore.ask({
    message: `确认移除货件 ${p.posting_number} 的补记关联?`,
    danger: true,
  }))) return;
  try {
    await removeMixedCarriagePosting(storeId.value, detail.carriageId, p.store_id, p.posting_number);
    show('已移除补记关联', 'success');
    await refreshHistoryDetail();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// 从发运移除货件(前端临时,保存时全量提交)
function onRemovePosting(p) {
  detail.postings = detail.postings.filter((x) => x.posting_number !== p.posting_number);
  editPostings.dirty = true;
}

// 保存货件组成(2026-11-02):本店货件走 Ozon set-postings,跨店货件本地 diff 增删
async function onSavePostings() {
  const ozonNumbers = detail.postings.filter((p) => p.source !== 'manual').map((p) => p.posting_number);
  const manualCurrent = detail.postings.filter((p) => p.source === 'manual');
  if (!ozonNumbers.length && !manualCurrent.length) {
    show('发运至少保留 1 个货件,如需清空请取消发运', 'error');
    return;
  }
  editPostings.saving = true;
  try {
    // 1) 本店货件 → Ozon 全量覆盖(有本店货件才调)
    if (ozonNumbers.length) {
      await setCarriagePostings(storeId.value, detail.carriageId, ozonNumbers);
    }
    // 2) 跨店货件 → 对比进入详情时的快照,本地增删
    const snapshot = new Set(detail.manualSnapshot || []);
    const key = (p) => `${p.store_id}|${p.posting_number}`;
    const added = manualCurrent.filter((p) => !snapshot.has(key(p)));
    const removed = [...snapshot].filter((k) => !manualCurrent.some((p) => key(p) === k));
    if (added.length) {
      await addMixedCarriagePostings(
        storeId.value,
        detail.carriageId,
        added.map((p) => ({ storeId: p.store_id, postingNumber: p.posting_number }))
      );
    }
    for (const k of removed) {
      const sep = k.indexOf('|');
      const postingStoreId = k.slice(0, sep);
      const postingNumber = k.slice(sep + 1);
      await removeMixedCarriagePosting(storeId.value, detail.carriageId, postingStoreId, postingNumber);
    }
    show('货件列表已保存', 'success');
    editPostings.dirty = false;
    await loadPostings(detail.carriage);
    await loadCarriages();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    editPostings.saving = false;
  }
}

// ── 初始化 ─────────────────────────────────────────────
onMounted(async () => {
  // 打印机双通道探测与店铺加载解耦(2026-11-01):即使店铺加载失败也要尽快结束"探测中"状态
  if (!isDone.value) labelPrint.probePrinters();
  try {
    await storesStore.load();
    // 默认选第一个已配置 sync_credentials 的店铺(作为全局配置接口鉴权)
    storeId.value = usableStores.value[0]?.id || storesStore.list[0]?.id || '';
    if (isPending.value) {
      loadCarriages();
      loadContactConfigs();
    } else if (isAll.value) {
      loadCarriages();
      loadHistory();
      loadContactConfigs();
    } else {
      loadHistory();
    }
  } catch (err) {
    show(err.message || '店铺列表加载失败', 'error');
  }
});

// 暴露给父组件 CarriageCenter(页面标题/刷新已上移,2026-10-30)
defineExpose({ refreshCurrent, listLoading });
</script>

<template>
  <div class="carriage-page">
    <!-- 页面标题(发运管理/发运历史 + 副标题 + 刷新)已上移到 CarriageCenter 顶部(2026-10-30) -->

    <!-- 快递员联系方式配置(2026-10-30,多条 + 默认项;全店铺通用一份;2026-11-01:默认只展示默认项,其它折叠;仅在待处理模式展示) -->
    <div v-if="isPending" class="card contact-config-card">
      <div class="section-title">快递员联系方式配置 <em class="field-hint">全店铺通用</em></div>

      <!-- 折叠视图:只展示默认项 -->
      <template v-if="!contactConfigs.expanded">
        <div v-if="defaultContactConfig" class="contact-config-collapsed">
          <span class="cc-item cc-phone">{{ defaultContactConfig.phone }}</span>
          <span class="cc-item">{{ defaultContactConfig.wechatNickname || '默认店铺名' }}</span>
          <span class="cc-item cc-address" :title="defaultContactConfig.comment">
            {{ defaultContactConfig.comment }}
          </span>
          <div class="spacer"></div>
          <button class="btn btn-ghost btn-sm" @click="contactConfigs.expanded = true">
            展开全部({{ contactConfigs.list.length }})
          </button>
        </div>
        <div v-else class="contact-config-collapsed empty">
          <span class="form-hint">暂无联系方式配置</span>
          <div class="spacer"></div>
          <button class="btn btn-ghost btn-sm" @click="onAddContactConfig">添加联系方式</button>
        </div>
      </template>

      <!-- 展开视图:完整可编辑表格 -->
      <template v-else>
        <table v-if="contactConfigs.list.length" class="contact-config-table">
          <thead>
            <tr>
              <th class="def-col">默认</th>
              <th>电话 <em class="req">*</em></th>
              <th>下单人名称</th>
              <th class="cc-addr-col">地址 <em class="req">*</em></th>
              <th class="ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in contactConfigs.list" :key="c.id">
              <td class="def-col">
                <input
                  type="radio"
                  name="contact-config-default"
                  :checked="c.isDefault"
                  @change="onSetContactConfigDefault(c)"
                />
              </td>
              <td><input v-model="c.phone" class="cc-phone-input" placeholder="快递员联系电话" /></td>
              <td><input v-model="c.wechatNickname" class="cc-nick-input" :placeholder="`选填,默认:${currentStoreName() || '店铺名'}`" /></td>
              <td class="cc-addr-col"><input v-model="c.comment" placeholder="提供给快递公司的取件地址" /></td>
              <td class="ops">
                <button class="btn btn-danger btn-sm" @click="onRemoveContactConfig(i)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="contact-config-actions">
          <button class="btn btn-ghost btn-sm" @click="onAddContactConfig">添加联系方式</button>
          <button class="btn btn-ghost btn-sm" @click="contactConfigs.expanded = false">收起</button>
          <button
            class="btn btn-primary btn-sm"
            :disabled="contactConfigs.saving"
            @click="onSaveContactConfigs"
          >
            {{ contactConfigs.saving ? '保存中…' : '保存配置' }}
          </button>
        </div>
      </template>

      <p class="form-hint">
        电话与地址为必填(地址提供给快递公司取件);下单人名称选填,为空时默认使用店铺名「{{ currentStoreName() }}」。
        配置为全店铺通用一份,切换店铺不会改变。
      </p>
    </div>

    <!-- 发运清单(2026-11-01:待处理=进行中,已完成=历史快照,全部=进行中+历史;创建发运入口在待处理占位行) -->
    <div class="card list-card">
      <div class="section-title">
        {{ isPending ? '发运清单 · 待处理' : isAll ? '发运清单 · 全部' : '发运清单 · 已完成' }}
      </div>

      <!-- 标签打印机(2026-11-01:并入发运清单,展示在清单上方;待处理/全部模式) -->
      <div v-if="!isDone" class="printer-bar">
        <span class="printer-label">标签打印机</span>
        <select
          v-model="labelPrint.selectedPrinter"
          class="filter-input printer-select"
          :disabled="(labelPrint.agentOnline !== true && labelPrint.serverOnline !== true) || (!labelPrint.printers.length && !labelPrint.serverPrinters.length)"
          :title="labelPrint.printerSelectTitle"
          @change="labelPrint.onPrinterChange"
        >
          <option value="">自动(可用组件默认)</option>
          <optgroup v-if="labelPrint.agentOnline === true" label="本机组件">
            <option value="local:">默认{{ labelPrint.defaultPrinter ? `(${labelPrint.defaultPrinter})` : '' }}</option>
            <option v-for="p in labelPrint.printers" :key="'L' + p" :value="'local:' + p">{{ p }}</option>
          </optgroup>
          <optgroup v-if="labelPrint.serverOnline === true" label="服务器组件">
            <option value="server:">默认{{ labelPrint.serverDefaultPrinter ? `(${labelPrint.serverDefaultPrinter})` : '' }}</option>
            <option v-for="p in labelPrint.serverPrinters" :key="'S' + p" :value="'server:' + p">{{ p }}</option>
          </optgroup>
        </select>
        <span
          class="agent-dot"
          :class="labelPrint.agentOnline === true ? 'on' : labelPrint.agentOnline === false ? 'off' : ''"
          :title="labelPrint.agentOnline === true ? '本机菜鸟组件已连接' : labelPrint.agentOnline === false ? '本机菜鸟组件未连接(打印前请启动组件)' : '正在探测本机组件…'"
        >{{ labelPrint.agentOnline === true ? '本机组件已连接' : labelPrint.agentOnline === false ? '本机组件未连接' : '探测本机…' }}</span>
        <span
          class="agent-dot"
          :class="labelPrint.serverOnline === true ? 'on' : labelPrint.serverOnline === false ? 'off' : ''"
          :title="labelPrint.serverOnline === true ? '服务器菜鸟组件已连接(SSH 隧道转发)' : labelPrint.serverOnline === false ? '服务器菜鸟组件未连接(检查 SSH 隧道)' : '正在探测服务器组件…'"
        >{{ labelPrint.serverOnline === true ? '服务器组件已连接' : labelPrint.serverOnline === false ? '服务器组件未连接' : '探测服务器…' }}</span>
        <button
          class="btn btn-ghost btn-sm"
          :disabled="labelPrint.agentOnline === null || labelPrint.serverOnline === null"
          @click="labelPrint.probePrinters()"
        >
          重新探测
        </button>
      </div>

      <div v-if="listLoading && !listRows.length" class="list-empty">加载中…</div>
      <div v-else-if="listLoaded && !listRows.length" class="list-empty">
        {{ isPending ? '暂无进行中的发运' : isAll ? '暂无发运记录' : '暂无已完成发运' }}
      </div>
      <table v-else class="carriage-table">
        <thead>
          <tr>
            <th>店铺</th>
            <th>发运 ID</th>
            <th>配送方式</th>
            <th>发运日期</th>
            <th>状态</th>
            <th class="num">货件数</th>
            <th class="ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in listRows"
            :key="row.store_id + '-' + row.id + '-' + row.delivery_method_id"
          >
            <template v-if="row.is_placeholder">
              <td><span class="store-name">{{ row.store_name }}</span></td>
              <td class="mono placeholder">待创建</td>
              <td>
                <span class="dm-name">{{ row.delivery_method_name || row.delivery_method_id }}</span>
                <span v-if="row.timeslot" class="row-sub">{{ row.timeslot }}</span>
              </td>
              <td>{{ row.departure_date || '—' }}</td>
              <td><span class="status-tag create-tag">可创建</span></td>
              <td class="num count-link" title="查看待发运货件" @click="onViewPostings(row)">
                {{ row.postings_count }}
                <div v-if="row.deadline_24h_count" class="dl-badge">24h内 {{ row.deadline_24h_count }}</div>
                <div v-if="row.deadline_overdue_count" class="dl-badge overdue">超时 {{ row.deadline_overdue_count }}</div>
              </td>
              <td class="ops">
                <button class="btn btn-primary btn-sm" @click="onGoCreate(row)">创建发运</button>
              </td>
            </template>
            <template v-else>
              <td><span class="store-name">{{ row.store_name }}</span></td>
              <td class="mono label-id">
                #{{ row.id }}
                <span v-if="row.tracking_number" class="row-sub tracking-no" title="OGL 国内集运仓快递单号">
                  <template v-for="(tn, i) in row.tracking_number.split(',')" :key="i">
                    {{ tn }}<br v-if="i < row.tracking_number.split(',').length - 1" />
                  </template>
                </span>
              </td>
              <td>
                <span class="dm-name">{{ row.delivery_method_name || row.delivery_method_id }}</span>
                <span v-if="row.warehouse_city || row.warehouse_name" class="row-sub">
                  {{ row.warehouse_name || '' }}{{ row.warehouse_city ? ` · ${row.warehouse_city}` : '' }}
                </span>
              </td>
              <td>{{ row.departure_date || '—' }}</td>
              <td>
                <span class="status-tag">{{ row.status_label || carriageStatusLabel(row.status) }}</span>
                <span v-if="row.postings_count" class="row-sub">{{ row.postings_count }} 个货件</span>
                <span v-if="row.printed" class="row-sub printed-mark">已打印</span>
              </td>
              <td class="num count-link" title="查看货件列表" @click="onViewPostings(row)">
                {{ row.postings_count }}
                <div v-if="row.deadline_24h_count" class="dl-badge">24h内 {{ row.deadline_24h_count }}</div>
                <div v-if="row.deadline_overdue_count" class="dl-badge overdue">超时 {{ row.deadline_overdue_count }}</div>
                <!-- 2026-11-08:本大包实际货件 / 补登记货件统计 -->
                <div v-if="row.supplement_count != null" class="row-sub supplement-stats">
                  实际 {{ row.actual_count }} · 补登记 {{ row.supplement_count }}
                </div>
              </td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="openDetail(row)">详情</button>
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="!isCarriageConfirmed(row) || labelPrint.labelPreview.loading === Number(row.id)"
                  :title="isCarriageConfirmed(row) ? '' : '发运确认后生成标签,方可预览'"
                  @click="labelPrint.previewRender(row)"
                >
                  {{ labelPrint.labelPreview.loading === Number(row.id) ? '预览中…' : '预览' }}
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  :disabled="!isCarriageConfirmed(row) || labelPrint.pdfPreview.loading === Number(row.id)"
                  :title="isCarriageConfirmed(row) ? '' : '发运确认后生成标签,方可查看 PDF'"
                  @click="labelPrint.previewPdf(row)"
                >
                  {{ labelPrint.pdfPreview.loading === Number(row.id) ? '加载中…' : 'PDF' }}
                </button>
                <button
                  class="btn btn-primary btn-sm"
                  :disabled="!isCarriageConfirmed(row) || labelPrint.printingId === Number(row.id) || (labelPrint.agentOnline !== true && labelPrint.serverOnline !== true)"
                  :title="!isCarriageConfirmed(row) ? '发运确认后生成标签,方可打印' : ((labelPrint.agentOnline !== true && labelPrint.serverOnline !== true) ? '打印组件未连接' : '打印 1 张')"
                  @click="onPrintLabel(row, 1)"
                >
                  {{ labelPrint.printingId === Number(row.id) ? '打印中…' : '打印1张' }}
                </button>
                <button
                  class="btn btn-primary btn-sm"
                  :disabled="!isCarriageConfirmed(row) || labelPrint.printingId === Number(row.id) || (labelPrint.agentOnline !== true && labelPrint.serverOnline !== true)"
                  :title="!isCarriageConfirmed(row) ? '发运确认后生成标签,方可打印' : ((labelPrint.agentOnline !== true && labelPrint.serverOnline !== true) ? '打印组件未连接' : '打印 3 张')"
                  @click="onPrintLabel(row, 3)"
                >
                  {{ labelPrint.printingId === Number(row.id) ? '打印中…' : '打印3张' }}
                </button>
                <button
                  v-if="hasAction(row, 'approve')"
                  class="btn btn-primary btn-sm"
                  @click="openDetail(row)"
                >
                  确认
                </button>
                <button
                  v-if="hasAction(row, 'cancel')"
                  class="btn btn-danger btn-sm"
                  @click="openDetail(row)"
                >
                  取消
                </button>
              </td>
            </template>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 详情弹窗 -->
    <AppModal :open="detail.open" title="发运详情" size="xl" @update:open="detail.open = $event">
      <template v-if="detail.carriage">
        <div class="detail-grid">
          <div class="detail-item">
            <span class="detail-label">店铺</span>
            <span class="detail-value">{{ currentStoreName() || detail.carriage.store_name || '—' }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">发运 ID</span>
            <span class="detail-value mono">#{{ detail.carriageId }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">状态</span>
            <span class="detail-value">
              <span class="status-tag">{{ carriageStatusLabel(detail.carriage.status) }}</span>
            </span>
          </div>
          <div class="detail-item">
            <span class="detail-label">货件数量</span>
            <span class="detail-value">
              {{ detail.postingsLoading ? '加载中…' : detail.postings.length }}
            </span>
          </div>
          <!-- 2026-11-08:本大包实际货件 / Ozon 补登记统计 -->
          <div class="detail-item">
            <span class="detail-label">本大包实际货件</span>
            <span class="detail-value">
              {{ detail.postingsLoading ? '加载中…' : detailStats.actual }}
            </span>
          </div>
          <div class="detail-item">
            <span class="detail-label">补登记货件</span>
            <span class="detail-value">
              {{ detail.postingsLoading ? '加载中…' : detailStats.supplement }}
            </span>
          </div>
          <div class="detail-item">
            <span class="detail-label">配送方式</span>
            <span class="detail-value">{{ detail.carriage.delivery_method_name || detail.carriage.delivery_method_id || '—' }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">发运日期</span>
            <span class="detail-value">{{ detail.carriage.departure_date || '—' }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">首程类型</span>
            <span class="detail-value">{{ detail.carriage.first_mile_type || '—' }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">集成方式</span>
            <span class="detail-value">{{ detail.carriage.integration_type || '—' }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">OGL 国内集运仓快递单号</span>
            <span class="detail-value mono">
              <template v-if="detail.carriage.tracking_number">
                <template v-for="(tn, i) in detail.carriage.tracking_number.split(',')" :key="i">
                  {{ tn }}<br v-if="i < detail.carriage.tracking_number.split(',').length - 1" />
                </template>
              </template>
              <template v-else>—</template>
            </span>
          </div>
        </div>

        <!-- 快递员联系方式(2026-11-04:调整到货件列表上方;2026-11-05:默认只读展示,「修改」才进入输入框编辑) -->
        <div class="detail-section">
          <div class="detail-section-head">
            <span>快递员联系方式</span>
            <em v-if="detail.fromHistory" class="field-hint">历史快照,仅展示</em>
            <em v-else-if="!contactApplicable" class="field-hint">仅 OGL 上门取件(pickup + ozon_outsourced)适用</em>
            <em v-else-if="!detail.contact.length" class="field-hint">未填写</em>
            <div class="spacer"></div>
            <button
              v-if="!detail.fromHistory && contactApplicable && !detail.editingContact"
              class="btn btn-ghost btn-sm"
              @click="detail.editingContact = true"
            >
              修改
            </button>
          </div>

          <!-- 只读展示(2026-11-05:默认不显示输入框;2026-11-05:改为一行横排) -->
          <div v-if="!detail.editingContact" class="contact-view">
            <template v-if="detail.contact.length">
              <div class="contact-view-row">
                <span class="contact-view-label">电话</span>
                <span class="contact-view-value">{{ detail.contact[0].phone || '—' }}</span>
                <span class="contact-view-sep">·</span>
                <span class="contact-view-label">下单人名称</span>
                <!-- 2026-11-06:Ozon 未存时按兜底链展示(默认配置/店铺名),与编辑表单口径一致 -->
                <span class="contact-view-value">{{ detail.contact[0].wechat_nickname || detail.wechatNickname || '—' }}</span>
                <span class="contact-view-sep">·</span>
                <span class="contact-view-label">取件地址</span>
                <span class="contact-view-value">{{ detail.contact[0].comment || '—' }}</span>
              </div>
            </template>
            <p v-else class="form-hint">该发运暂未保存快递员联系方式。</p>
          </div>

          <!-- 编辑模式(仅在点击「修改」后出现) -->
          <div v-else class="contact-form">
            <label class="contact-select-label">
              <span>选择配置</span>
              <select
                v-model="detail.selectedContactConfigId"
                :disabled="!contactConfigs.list.length"
                @change="onSelectContactConfig"
              >
                <option value="">手动填写</option>
                <option v-for="c in contactConfigs.list" :key="c.id" :value="c.id">
                  {{ c.wechatNickname || c.phone || '(未命名)' }}{{ c.phone ? ` · ${c.phone}` : '' }}{{ c.isDefault ? ' · 默认' : '' }}
                </option>
              </select>
            </label>
            <label>
              <span>电话 <em class="req">*</em></span>
              <input v-model="detail.phone" placeholder="快递员联系电话" />
            </label>
            <label>
              <span>下单人名称</span>
              <input v-model="detail.wechatNickname" :placeholder="`选填,默认:${currentStoreName() || '店铺名'}`" />
            </label>
            <label class="contact-address-field">
              <span>地址 <em class="req">*</em></span>
              <input v-model="detail.comment" placeholder="提供给快递公司的取件地址" />
            </label>
            <button
              class="btn btn-primary btn-sm"
              :disabled="detail.savingContact"
              @click="onSaveContact"
            >
              {{ detail.savingContact ? '保存中…' : '保存' }}
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="!contactApplicable" @click="onSetAsDefault">
              设为默认
            </button>
            <button class="btn btn-ghost btn-sm" @click="onCancelEditContact">取消</button>
          </div>
          <p class="form-hint">
            电话与地址必填(地址为提供给快递公司的取件地址);下单人名称选填默认店铺名。
            「设为默认」把当前内容存为默认配置项,供下次创建发运时自动选择。
          </p>
        </div>

        <!-- 容器数(2026-11-06:默认1;移至货件列表上方、联系方式下方) -->
        <div v-if="hasAction(detail.carriage, 'approve')" class="containers-field containers-row">
          <span>容器数</span>
          <input v-model="detail.containersCount" type="number" min="1" />
          <span class="field-hint">信任验收按货位发运时填写</span>
        </div>

        <!-- 货件列表(2026-10-30:图片 + 增删,new 状态可编辑) -->
        <div class="detail-section">
          <div class="detail-section-head">
            <span>货件列表</span>
            <em v-if="postingsEditable" class="field-hint">new 状态可增删,保存后全量生效</em>
            <div class="spacer"></div>
            <button
              v-if="editPostings.dirty"
              class="btn btn-primary btn-sm"
              :disabled="editPostings.saving"
              @click="onSavePostings"
            >
              {{ editPostings.saving ? '保存中…' : '保存货件' }}
            </button>
            <button v-if="postingsEditable" class="btn btn-ghost btn-sm" @click="onOpenCandidate">添加货件</button>
            <button v-if="detail.fromHistory" class="btn btn-ghost btn-sm" @click="onOpenCandidate">添加漏掉的订单</button>
            <button
              v-if="!detail.fromHistory"
              class="btn btn-ghost btn-sm"
              :disabled="detail.postingsLoading"
              @click="loadPostings(detail.carriage)"
            >
              {{ detail.postingsLoading ? '加载中…' : '刷新' }}
            </button>
          </div>
          <!-- 2026-11-09:已在其他发运单的货件(已发货)提示条,不弹窗;补发入口在「添加货件」弹窗 -->
          <div v-if="!detail.fromHistory && detail.crossCarriagePostings.length" class="carriage-reship-hint">
            <span class="hint-icon">⚠️</span>
            <span class="hint-text">
              以下货件已在其他发运单(已发货),当前发运单不展示;如需补发请在「添加货件」中勾选:
              <template v-for="(c, i) in detail.crossCarriagePostings" :key="c.postingNumber">
                <em>{{ i ? '、' : '' }}{{ c.postingNumber }}(#{{ c.carriageId }})</em>
              </template>
            </span>
          </div>
          <div v-if="detail.postingsLoading && !detail.postings.length" class="list-empty">加载中…</div>
          <div v-else-if="!detail.postings.length" class="list-empty">该发运暂无货件</div>
          <table v-else class="posting-table">
            <thead>
              <tr>
                <th>货件号</th>
                <th>状态</th>
                <th>商品</th>
                <th class="num">件数</th>
                <th>可打印面单</th>
                <th v-if="postingsEditable" class="ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in detail.postings" :key="p.posting_number">
                <td>
                  <div class="posting-no-cell">
                    <span class="mono">{{ p.posting_number }}</span>
                    <span v-if="p.source === 'manual'" class="cross-tag block-tag" :title="p.store_id">{{ p.store_name || p.store_id }}·跨店</span>
                    <span v-else class="self-tag block-tag">本店</span>
                  </div>
                  <!-- 2026-11-09:补发场景标记(货件同时记录在多个发运单) -->
                  <div v-if="p.inOtherCarriage" class="carriage-shipped-tags">
                    <span class="reship-tag" :title="`该货件已在发运单 #${p.otherCarriageId} 发出`">已发货·在 #{{ p.otherCarriageId }}</span>
                  </div>
                  <!-- 2026-11-07:跨店大包已发出标注(manual=已随本发运单发出;ozon=已随其它大包发出,Ozon补登记) -->
                  <div v-if="p.shipped_with_this_carriage" class="carriage-shipped-tags">
                    <span class="tag tag-ok">✅ 已随本发运单发出</span>
                  </div>
                  <div v-else-if="p.cross_store_shipped" class="carriage-shipped-tags">
                    <span class="tag tag-info" :title="crossShippedTitle(p)">{{ crossShippedLabel(p) }}</span>
                  </div>
                </td>
                <td>
                  <span class="posting-status" :class="(postingStatusMeta(p.operate_status) || {}).cls || 'st-muted'">
                    {{ postingStatusText(p) }}
                  </span>
                </td>
                <td>
                  <div v-if="(p.products || []).length" class="posting-products">
                    <div v-for="it in p.products" :key="it.sku || it.offer_id || it.name" class="posting-product">
                      <img
                        v-if="it.image_url"
                        :src="it.image_url"
                        referrerpolicy="no-referrer"
                        loading="lazy"
                        class="posting-product-img"
                        alt=""
                      />
                      <div class="posting-product-info">
                        <span class="posting-product-name" :title="it.name || it.product_name || it.offer_id || it.sku">
  {{ shortProductName(it.name || it.product_name || it.offer_id || it.sku) || '—' }}
</span>
                        <span class="posting-product-meta">SKU: {{ it.sku || '—' }}</span>
                        <span class="posting-product-meta">OfferId: {{ it.offer_id || '—' }}</span>
                      </div>
                      <span class="posting-product-qty">×{{ it.quantity ?? '' }}</span>
                    </div>
                  </div>
                  <span v-else>—</span>
                </td>
                <td class="num">{{ (p.products || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0) }}</td>
                <td>
                  <span class="printed-tag" :class="p.can_print_label ? 'yes' : 'no'">
                    {{ p.can_print_label ? '可打印' : '不可' }}
                  </span>
                </td>
                <td v-if="postingsEditable" class="ops">
                  <button class="btn btn-danger btn-sm" @click="onRemovePosting(p)">移除</button>
                </td>
                <td v-else-if="detail.fromHistory && p.source === 'manual'" class="ops">
                  <button class="btn btn-danger btn-sm" @click="onRemoveHistoryPosting(p)">移除补记</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 发运操作 -->
        <div class="detail-actions">
          <div class="spacer"></div>
          <button
            v-if="hasAction(detail.carriage, 'cancel')"
            class="btn btn-danger"
            :disabled="detail.cancelling"
            @click="onCancel"
          >
            {{ detail.cancelling ? '取消中…' : '取消发运' }}
          </button>
          <button
            v-if="hasAction(detail.carriage, 'approve')"
            class="btn btn-primary"
            :disabled="detail.approving"
            @click="onApprove"
          >
            {{ detail.approving ? '确认中…' : '确认发运' }}
          </button>
        </div>
      </template>
    </AppModal>

    <!-- 待发运货件弹窗(2026-11-02:点击占位行"货件数"查看) -->
    <AppModal :open="pendingPostings.open" title="待发运货件" size="lg" @update:open="pendingPostings.open = $event">
      <div class="candidate-head">
        <span class="field-hint">
          {{ pendingPostings.storeName }} · {{ pendingPostings.deliveryMethodName || pendingPostings.deliveryMethodId }} · 共 {{ pendingPostings.postings.length }} 件
        </span>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" :disabled="pendingPostings.loading" @click="pendingPostings.open = false">关闭</button>
      </div>
      <div v-if="pendingPostings.loading" class="list-empty">加载中…</div>
      <div v-else-if="!pendingPostings.postings.length" class="list-empty">该配送方式下暂无待发运货件</div>
      <table v-else class="posting-table">
        <thead>
          <tr>
            <th>货件号</th>
            <th>商品</th>
            <th class="num">件数</th>
            <th>发运期限</th>
            <th>可打印面单</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in pendingPostings.postings" :key="p.posting_number">
            <td class="mono">
              {{ p.posting_number }}
              <span v-if="p.inOtherCarriage" class="reship-tag" :title="`该货件已在发运单 #${p.otherCarriageId} 发出`">已发货·在 #{{ p.otherCarriageId }}</span>
            </td>
            <td>
              <div v-if="(p.products || []).length" class="posting-products">
                <div v-for="it in p.products" :key="it.sku || it.offer_id || it.name" class="posting-product">
                  <img
                    v-if="it.image_url"
                    :src="it.image_url"
                    referrerpolicy="no-referrer"
                    loading="lazy"
                    class="posting-product-img"
                    alt=""
                  />
                  <div class="posting-product-info">
                    <span class="posting-product-name" :title="it.name || it.product_name || it.offer_id || it.sku">
  {{ shortProductName(it.name || it.product_name || it.offer_id || it.sku) || '—' }}
</span>
                    <span class="posting-product-meta">SKU: {{ it.sku || '—' }}</span>
                    <span class="posting-product-meta">OfferId: {{ it.offer_id || '—' }}</span>
                  </div>
                  <span class="posting-product-qty">×{{ it.quantity ?? '' }}</span>
                </div>
              </div>
              <span v-else>—</span>
            </td>
            <td class="num">{{ (p.products || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0) }}</td>
            <td>
              <span
                v-if="postingDeadlineVisible(p)"
                class="dl-badge"
                :class="{ overdue: isDeadlineOverdue(p.shipment_date) }"
              >
                {{ isDeadlineOverdue(p.shipment_date) ? '已超时' : isDeadlineUrgent(p.shipment_date) ? '24h内' : '' }}
                {{ fmtDeadline(p.shipment_date) }}
              </span>
              <span v-else>—</span>
            </td>
            <td>
              <span class="printed-tag" :class="p.can_print_label ? 'yes' : 'no'">
                {{ p.can_print_label ? '可打印' : '不可' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </AppModal>

    <!-- 创建发运弹窗(2026-11-01:占位行触发;2026-11-02:参考详情弹窗布局,展示将自动进入发运的货件列表+状态) -->
    <AppModal :open="createModal.open" title="创建发运" size="xl" @update:open="createModal.open = $event">
      <div class="create-modal">
        <div class="detail-grid">
          <div class="detail-item">
            <span class="detail-label">店铺</span>
            <span class="detail-value">{{ createModal.storeName }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">配送方式</span>
            <span class="detail-value">{{ createModal.deliveryMethodName || createModal.deliveryMethodId }}</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">发运日期</span>
            <input v-model="createModal.departureDate" type="date" class="form-control" />
          </div>
        </div>

        <!-- 快递员联系方式:创建时一并指定(2026-11-04;2026-11-05:展示全部配置选项,默认单选框选中默认配置,可在此新增/修改) -->
        <div class="detail-section">
          <div class="detail-section-head">
            <span>快递员联系方式</span>
            <em class="field-hint">OGL 上门取件(pickup + ozon_outsourced)适用;填写电话 + 取件地址后随发运一并保存</em>
          </div>

          <!-- 配置单选列表(2026-11-05):展示所有配置,默认选中默认配置 -->
          <div v-if="createModal.contactConfigs.length" class="create-contact-picker">
            <label
              v-for="c in createModal.contactConfigs"
              :key="c.id"
              class="cc-radio-row"
              :class="{ active: createModal.selectedContactConfigId === c.id }"
            >
              <input
                type="radio"
                name="create-contact-config"
                :value="c.id"
                v-model="createModal.selectedContactConfigId"
              />
              <span class="cc-phone">{{ c.phone || '(未填电话)' }}</span>
              <span class="cc-item">{{ c.wechatNickname || '默认店铺名' }}</span>
              <span class="cc-item cc-address" :title="c.comment">{{ c.comment || '—' }}</span>
              <span v-if="c.isDefault" class="cc-default-tag">默认</span>
            </label>
          </div>

          <!-- 创建时以选中的配置作为快递员联系方式(2026-11-05:移除多余输入框,随发运一并保存) -->
          <div class="contact-form-actions">
            <button class="btn btn-ghost btn-sm" @click="createModal.configEditing = !createModal.configEditing">
              {{ createModal.configEditing ? '收起配置管理' : '管理配置' }}
            </button>
          </div>

          <!-- 配置管理(2026-11-05):在创建弹窗内直接新增/修改/删除/设默认 -->
          <div v-if="createModal.configEditing" class="create-contact-config-edit">
            <table v-if="createModal.contactConfigs.length" class="contact-config-table">
              <thead>
                <tr>
                  <th class="def-col">默认</th>
                  <th>电话 <em class="req">*</em></th>
                  <th>下单人名称</th>
                  <th class="cc-addr-col">地址 <em class="req">*</em></th>
                  <th class="ops">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in createModal.contactConfigs" :key="c.id">
                  <td class="def-col">
                    <input
                      type="radio"
                      name="create-contact-config-default"
                      :checked="c.isDefault"
                      @change="onCreateSetDefault(c)"
                    />
                  </td>
                  <td><input v-model="c.phone" class="cc-phone-input" placeholder="快递员联系电话" /></td>
                  <td>
                    <input
                      v-model="c.wechatNickname"
                      class="cc-nick-input"
                      :placeholder="`选填,默认:${createModal.storeName || '店铺名'}`"
                    />
                  </td>
                  <td class="cc-addr-col"><input v-model="c.comment" placeholder="提供给快递公司的取件地址" /></td>
                  <td class="ops">
                    <button class="btn btn-danger btn-sm" @click="onCreateRemoveConfig(i)">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="contact-config-actions">
              <button class="btn btn-ghost btn-sm" @click="onCreateAddConfig">添加联系方式</button>
              <button
                class="btn btn-primary btn-sm"
                :disabled="createModal.savingConfigs"
                @click="onCreateSaveConfigs"
              >
                {{ createModal.savingConfigs ? '保存中…' : '保存配置' }}
              </button>
            </div>
          </div>
        </div>

        <div class="detail-section create-postings-section">
          <div class="detail-section-head">
            <span>将进入发运的货件</span>
            <em v-if="createModal.loading" class="field-hint">加载中…</em>
            <em v-else class="field-hint">共 {{ createModal.postings.length }} 件(该配送方式下所有「已准备发运」货件自动进入)</em>
          </div>
          <div v-if="createModal.loading" class="list-empty">加载中…</div>
          <div v-else-if="!createModal.postings.length" class="list-empty">该配送方式下暂无待发运货件</div>
          <table v-else class="posting-table create-postings-table">
            <thead>
              <tr>
                <th class="sel-col">
                  <input type="checkbox" :checked="createModal.allSelected" title="全选/取消全选" @change="onToggleCreateSelectAll" />
                </th>
                <th>货件号</th>
                <th>状态</th>
                <th>商品</th>
                <th class="num">件数</th>
                <th>发运期限</th>
                <th>可打印面单</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in createModal.postings" :key="p.posting_number">
                <td class="sel-col">
                  <input
                    type="checkbox"
                    v-model="createModal.selectedPostingNumbers"
                    :value="p.posting_number"
                    @change="onCreatePostingSelectChange"
                  />
                </td>
                <td>
                  <!-- 2026-11-05:货件号格式对齐详情弹窗 -->
                  <div class="posting-no-cell">
                    <span class="mono">{{ p.posting_number }}</span>
                    <span v-if="p.source === 'manual'" class="cross-tag block-tag" :title="p.store_id">{{ p.store_name || p.store_id }}·跨店</span>
                    <span v-else class="self-tag block-tag">本店</span>
                  </div>
                  <!-- 2026-11-09:已在其他发运单(已发货)标记 -->
                  <div v-if="p.inOtherCarriage" class="carriage-shipped-tags">
                    <span class="reship-tag" :title="`该货件已在发运单 #${p.otherCarriageId} 发出`">已发货·在 #{{ p.otherCarriageId }}</span>
                  </div>
                  <!-- 2026-11-07:已随跨店大包发出(加入当前发运单 = Ozon 补登记) -->
                  <div v-if="p.cross_store_shipped" class="carriage-shipped-tags">
                    <span class="tag tag-info" :title="crossShippedTitle(p)">{{ crossShippedLabel(p) }}</span>
                  </div>
                </td>
                <td>
                  <span class="posting-status" :class="(postingStatusMeta(p.operate_status) || {}).cls || 'st-muted'">
                    {{ postingStatusText(p) }}
                  </span>
                </td>
                <td>
                  <div v-if="(p.products || []).length" class="posting-products">
                    <div v-for="it in p.products" :key="it.sku || it.offer_id || it.name" class="posting-product">
                      <img
                        v-if="it.image_url"
                        :src="it.image_url"
                        referrerpolicy="no-referrer"
                        loading="lazy"
                        class="posting-product-img"
                        alt=""
                      />
                      <div class="posting-product-info">
                        <span class="posting-product-name" :title="it.name || it.product_name || it.offer_id || it.sku">
  {{ shortProductName(it.name || it.product_name || it.offer_id || it.sku) || '—' }}
</span>
                        <span class="posting-product-meta">SKU: {{ it.sku || '—' }}</span>
                        <span class="posting-product-meta">OfferId: {{ it.offer_id || '—' }}</span>
                      </div>
                      <span class="posting-product-qty">×{{ it.quantity ?? '' }}</span>
                    </div>
                  </div>
                  <span v-else>—</span>
                </td>
                <td class="num">{{ (p.products || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0) }}</td>
                <td>
                  <span
                    v-if="postingDeadlineVisible(p)"
                    class="dl-badge"
                    :class="{ overdue: isDeadlineOverdue(p.shipment_date) }"
                  >
                    {{ isDeadlineOverdue(p.shipment_date) ? '已超时' : isDeadlineUrgent(p.shipment_date) ? '24h内' : '' }}
                    {{ fmtDeadline(p.shipment_date) }}
                  </span>
                  <span v-else>—</span>
                </td>
                <td>
                  <!-- 2026-11-05:对齐详情弹窗 -->
                  <span class="printed-tag" :class="p.can_print_label ? 'yes' : 'no'">
                    {{ p.can_print_label ? '可打印' : '不可' }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="modal-actions">
          <button class="btn btn-ghost" @click="createModal.open = false">取消</button>
          <button
            class="btn btn-primary"
            :disabled="createModal.creating || createModal.loading"
            @click="onCreateFromModal"
          >
            {{ createModal.creating ? '创建中…' : '创建发运' }}
          </button>
        </div>
      </div>
    </AppModal>

    <!-- 可加入货件候选弹窗(2026-11-02:本店/跨店分页 + 打单时间筛选) -->
    <AppModal :open="candidate.open" title="添加货件" size="lg" @update:open="candidate.open = $event">
      <div v-if="!detail.fromHistory" class="candidate-tabs">
        <button class="candidate-tab" :class="{ on: candidate.tab === 'self' }" @click="switchCandidateTab('self')">本店货件</button>
        <button class="candidate-tab" :class="{ on: candidate.tab === 'cross' }" @click="switchCandidateTab('cross')">跨店货件</button>
      </div>
      <div v-if="detail.fromHistory" class="candidate-history-hint">
        已完成发运单补记:从本店/跨店待发运订单中选择漏掉的货件,仅本地关联(不推送 Ozon)。
      </div>

      <!-- 跨店/补记筛选栏(2026-11-06:店铺全选/多选 + 打单时间快捷 + 起始日至今 + 关键字) -->
      <div v-if="candidate.tab === 'cross' || candidate.tab === 'history'" class="candidate-filter">
        <div class="filter-row">
          <label class="filter-check filter-check-all">
            <input type="checkbox" :checked="allStoresSelected" @change="toggleAllStores" />
            全选
          </label>
          <label v-for="s in candidateStores" :key="s.id" class="filter-check">
            <input type="checkbox" :value="s.id" v-model="candidate.sourceStoreIds" />
            {{ s.name || s.id }}{{ String(s.id) === String(storeId) ? '(本店)' : '' }}
          </label>
        </div>
        <div class="filter-row">
          <input v-model="candidate.keyword" class="form-control filter-keyword" placeholder="货件号搜索" @keyup.enter="candidate.tab === 'history' ? loadHistoryCandidates() : loadCrossCandidates()" />
          <button class="btn btn-primary btn-sm" :disabled="candidate.loading" @click="candidate.tab === 'history' ? loadHistoryCandidates() : loadCrossCandidates()">搜索</button>
        </div>
        <div class="filter-chips">
          <button
            v-for="r in PRINTED_RANGES"
            :key="r.key"
            class="chip"
            :class="{ on: candidate.printedRange === r.key && !candidate.printedFrom }"
            @click="setPrintedRange(r.key)"
          >{{ r.label }}</button>
        </div>
        <div class="filter-dates">
          <input v-model="candidate.printedFrom" type="date" class="form-control filter-date" title="打单起始日期" />
          <span class="date-sep">~ 至今</span>
        </div>
      </div>

      <div class="candidate-head">
        <span v-if="candidate.loading" class="field-hint">加载中…</span>
        <span v-else-if="candidate.tab === 'self'" class="field-hint">
          曾在本店其他发运单记录过、现回到可发运池的货件(共 {{ candidate.postings.length }} 个),勾选即补发到当前发运单
        </span>
        <span v-else class="field-hint">
          已选 {{ candidate.sourceStoreIds.length }}/{{ candidateStores.length }} 家店铺的待发运货件(共 {{ candidate.postings.length }} 个),已排除当前发运中货件
        </span>
        <div class="spacer"></div>
        <span class="field-hint">已选 {{ selectedCount }} 个</span>
        <button class="btn btn-ghost btn-sm" :disabled="candidate.loading || !candidate.postings.length" @click="selectAllCandidates">全选</button>
        <button class="btn btn-ghost btn-sm" :disabled="candidate.loading || !candidate.postings.length" @click="invertCandidates">反选</button>
        <button
          class="btn btn-ghost btn-sm"
          :disabled="candidate.loading"
          @click="candidate.tab === 'self' ? loadSelfCandidates() : (candidate.tab === 'history' ? loadHistoryCandidates() : loadCrossCandidates())"
        >刷新</button>
        <button class="btn btn-primary btn-sm" :disabled="candidate.loading || candidate.saving" @click="onConfirmAddCandidates">
          {{ candidate.saving ? '保存中…' : (detail.fromHistory ? '补记选中' : '加入选中') }}
        </button>
      </div>
      <div v-if="candidate.loading && !candidate.postings.length" class="list-empty">加载中…</div>
      <div v-else-if="!candidate.postings.length" class="list-empty">{{ candidate.tab === 'self' ? '没有曾在本店其他发运单记录过的待发运货件' : '没有符合筛选条件的待发运货件' }}</div>
      <table v-else class="posting-table candidate-table">
        <thead>
          <tr>
            <th class="candidate-check"></th>
            <th>货件号</th>
            <th v-if="candidate.tab === 'cross' || candidate.tab === 'history'">店铺 / 打单时间</th>
            <th>商品</th>
            <th class="num">件数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in candidate.postings" :key="p.posting_number">
            <td class="candidate-check">
              <input v-model="candidate.selected[p.posting_number]" type="checkbox" />
            </td>
            <td class="mono">
              {{ p.posting_number }}
              <!-- 2026-11-09:曾记录(在其他发运单)候选标记,勾选确认即补发 -->
              <span
                v-if="p.inOtherCarriage"
                class="reship-tag"
                :title="`该货件曾记录在发运单 #${p.otherCarriageId},勾选即补发到当前发运单`"
              >曾记录·在 #{{ p.otherCarriageId }}</span>
            </td>
            <td v-if="candidate.tab === 'cross' || candidate.tab === 'history'">
              <div class="candidate-store">{{ p.store_name || p.store_id }}{{ String(p.store_id) === String(storeId) ? '(本店)' : '·跨店' }}</div>
              <div class="candidate-time">打单 {{ fmtPrinted(p.printed_at || p.waybill_printed_at) }}</div>
            </td>
            <td>
              <div v-if="(p.products || []).length" class="posting-products">
                <div v-for="it in p.products" :key="it.sku || it.offer_id || it.name" class="posting-product">
                  <img
                    v-if="it.image_url"
                    :src="it.image_url"
                    referrerpolicy="no-referrer"
                    loading="lazy"
                    class="posting-product-img"
                    alt=""
                  />
                  <div class="posting-product-info">
                    <span class="posting-product-name" :title="it.name || it.product_name || it.offer_id || it.sku">
  {{ shortProductName(it.name || it.product_name || it.offer_id || it.sku) || '—' }}
</span>
                    <span class="posting-product-meta">SKU: {{ it.sku || '—' }}</span>
                    <span class="posting-product-meta">OfferId: {{ it.offer_id || '—' }}</span>
                  </div>
                  <span class="posting-product-qty">×{{ it.quantity ?? '' }}</span>
                </div>
              </div>
              <span v-else>—</span>
            </td>
            <td class="num">{{ (p.products || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0) }}</td>
          </tr>
        </tbody>
      </table>
    </AppModal>

    <!-- 货运标签 PNG 预览弹窗(2026-11-01:显示实际出纸版式,多页可翻页) -->
    <AppModal
      :open="labelPrint.labelPreview.open"
      :title="'货运标签预览 · 76×130mm' + (labelPrint.labelPreview.images.length > 1 ? ' · ' + (labelPrint.labelPreview.page + 1) + '/' + labelPrint.labelPreview.images.length + '页' : '')"
      @update:open="labelPrint.labelPreview.open = $event"
    >
      <div class="label-preview-body">
        <img
          v-if="labelPrint.labelPreview.images.length"
          :src="labelPrint.labelPreview.images[labelPrint.labelPreview.page]"
          alt="货运标签预览"
          class="label-preview-img"
        />
        <div v-if="labelPrint.labelPreview.images.length > 1" class="label-preview-nav">
          <button class="btn btn-ghost btn-sm" :disabled="labelPrint.labelPreview.page === 0" @click="labelPrint.previewPrev">上一页</button>
          <span class="label-preview-page">{{ labelPrint.labelPreview.page + 1 }} / {{ labelPrint.labelPreview.images.length }}</span>
          <button class="btn btn-ghost btn-sm" :disabled="labelPrint.labelPreview.page === labelPrint.labelPreview.images.length - 1" @click="labelPrint.previewNext">下一页</button>
        </div>
        <div class="label-preview-tip">
          服务器按 PDF 渲染:货运标签旋转 90° 适配 76×130mm 竖向纸,预览即实际出纸版式,
          不消耗纸张、不流转订单状态。
        </div>
      </div>
    </AppModal>

    <!-- 货运标签 PDF 预览弹窗(2026-11-01:原始 PDF,便于核对条形码) -->
    <AppModal :open="labelPrint.pdfPreview.open" title="货运标签 PDF" size="lg" @update:open="labelPrint.pdfPreview.open = $event">
      <div class="pdf-preview-head">
        <span class="preview-title">PDF 预览</span>
        <span v-if="labelPrint.pdfPreview.size" class="preview-size">{{ labelPrint.fmtSize(labelPrint.pdfPreview.size) }} · 1 页</span>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" @click="labelPrint.clearPdfPreview">清除</button>
      </div>
      <div class="preview-frame-wrap">
        <iframe
          v-if="labelPrint.pdfPreview.url"
          class="preview-frame"
          :src="labelPrint.pdfPreview.url"
          title="货运标签 PDF 预览"
        />
        <div v-else class="preview-empty">点击行内「PDF」查看货运标签原始 PDF</div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.carriage-page {
  padding: 24px;
  max-width: 1180px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 12px;
}

/* ── 创建发运弹窗(2026-11-01;2026-11-02:参考详情弹窗布局) ── */
.create-modal {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0;
}
.create-postings-section {
  padding-top: 12px;
}
.create-postings-table {
  min-width: 640px;
}
.sel-col {
  width: 28px;
  text-align: center;
}

/* ── 货件状态标签(2026-11-02,详情/创建发运弹窗) ── */
.posting-status {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}
.posting-status.st-info {
  background: #eff6ff;
  color: #2563eb;
}
.posting-status.st-ok {
  background: #dcfce7;
  color: #16a34a;
}
.posting-status.st-warn {
  background: #fef3c7;
  color: #f59e0b;
}
.posting-status.st-err {
  background: #fee2e2;
  color: #ef4444;
}
.posting-status.st-muted {
  background: #f1f5f9;
  color: #64748b;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
.form-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.field-hint {
  font-size: 12px;
  color: var(--muted);
  font-style: normal;
}

/* ── 列表 ── */
.list-card {
  padding: 16px 20px;
}
.list-empty {
  padding: 28px 0;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
.carriage-table,
.posting-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.carriage-table th,
.carriage-table td,
.posting-table th,
.posting-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: middle;
}
.carriage-table th,
.posting-table th {
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}
.carriage-table tr:last-child td,
.posting-table tr:last-child td {
  border-bottom: none;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ops {
  text-align: right;
  white-space: nowrap;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.label-id {
  font-weight: 600;
}
.placeholder {
  color: var(--muted);
}
.dm-name {
  font-weight: 500;
}
.store-name {
  font-weight: 500;
  white-space: nowrap;
}
.row-sub {
  display: block;
  font-size: 11.5px;
  color: var(--muted);
  margin-top: 1px;
}
.tracking-no {
  color: #0e9f6e;
  font-weight: 500;
  letter-spacing: 0.3px;
}
.status-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: #eef2ff;
  color: var(--primary);
}
.create-tag {
  background: #ecfdf5;
  color: #059669;
}

/* ── 详情 ── */
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px 16px;
  margin-bottom: 16px;
}
.detail-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.detail-label {
  font-size: 11.5px;
  color: var(--muted);
}
.detail-value {
  font-size: 13.5px;
  color: var(--text);
}
.detail-section {
  border-top: 1px dashed var(--border);
  padding-top: 14px;
  margin-top: 14px;
}
.detail-section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13.5px;
  font-weight: 600;
  margin-bottom: 10px;
}
.detail-section-head .field-hint {
  font-weight: 400;
}
.contact-form {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 10px;
}
.contact-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.contact-form label > span {
  font-size: 12px;
  color: var(--muted);
}
.contact-form input {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  min-width: 160px;
  background: #fff;
  color: var(--text);
}
/* 地址输入框加长(2026-11-05):占满表单剩余宽度 */
.contact-form label.contact-address-field {
  flex: 1 1 320px;
  min-width: 260px;
}
.contact-form label.contact-address-field input {
  width: 100%;
  min-width: 0;
}
/* 详情弹窗联系方式只读展示(2026-11-05;2026-11-05:一行横排) */
.contact-view {
  display: flex;
  align-items: center;
}
.contact-view-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 13px;
}
.contact-view-label {
  font-size: 12px;
  color: var(--muted);
}
.contact-view-value {
  color: var(--text);
  word-break: break-all;
}
.contact-view-sep {
  color: var(--border, #d0d7de);
  margin: 0 2px;
}
/* 创建弹窗配置单选列表(2026-11-05) */
.create-contact-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.cc-radio-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  transition: border-color 0.15s, background 0.15s;
}
.cc-radio-row:hover {
  border-color: var(--primary);
}
.cc-radio-row.active {
  border-color: var(--primary);
  background: rgba(24, 144, 255, 0.06);
}
.cc-radio-row input[type='radio'] {
  accent-color: var(--primary);
  margin: 0;
}
.cc-default-tag {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  background: var(--primary);
  color: #fff;
}
.create-contact-config-edit {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}
/* 创建弹窗联系方式:管理配置按钮行(2026-11-05) */
.contact-form-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.req {
  color: var(--danger);
  font-style: normal;
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  border-top: 1px dashed var(--border);
  margin-top: 14px;
  padding-top: 14px;
}
.containers-field {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}
.containers-row {
  margin: 12px 0 0;
}
.containers-field input {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  width: 80px;
  background: #fff;
  color: var(--text);
}
.spacer {
  flex: 1;
}
.printed-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11.5px;
}
.printed-tag.yes {
  background: #ecfdf5;
  color: #059669;
}
.printed-tag.no {
  background: #fef3f2;
  color: #dc2626;
}

/* ── 快递员联系方式配置卡片(2026-10-30,多条) ── */
.contact-config-card {
  padding: 16px 20px;
}
.contact-config-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.contact-config-table th,
.contact-config-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: middle;
}
.contact-config-table th {
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
}
.contact-config-table input[type='text'],
.contact-config-table input:not([type]) {
  width: 100%;
  min-width: 120px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
  color: var(--text);
}
.contact-config-table input:focus {
  outline: none;
  border-color: var(--primary);
}
/* 电话/下单人名称输入框调整为单元格一半宽(2026-11-01) */
.contact-config-table input.cc-phone-input,
.contact-config-table input.cc-nick-input {
  width: 50%;
  min-width: 100px;
}
.def-col {
  width: 46px;
  text-align: center;
}
/* 配置表格地址列加宽(2026-11-05):约增加原来的三分之一 */
.contact-config-table th.cc-addr-col,
.contact-config-table td.cc-addr-col {
  width: 40%;
}
.def-col input[type='radio'] {
  accent-color: var(--primary);
}
.contact-config-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}
.contact-config-collapsed {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 2px;
}
.contact-config-collapsed.empty {
  padding: 4px 2px;
}
.cc-item {
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
}
.cc-phone {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.cc-address {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 420px;
}

/* 详情联系方式:配置下拉框 */
.contact-select-label select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  min-width: 180px;
  background: #fff;
  color: var(--text);
}

/* ── 货件商品图片(2026-10-30) ── */
.posting-products {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 240px;
}
.posting-product {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.posting-product-img {
  width: 34px;
  height: 34px;
  border-radius: 6px;
  object-fit: cover;
  border: 1px solid var(--border);
  flex-shrink: 0;
  background: #f5f5f5;
}
.posting-product-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.posting-product-name {
  min-width: 0;
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.posting-product-meta {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.posting-product-qty {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}

/* ── 候选货件弹窗(2026-10-30) ── */
.candidate-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.candidate-table {
  min-width: 640px;
}
.candidate-check {
  width: 34px;
  text-align: center;
}
.candidate-check input {
  accent-color: var(--primary);
}

/* ── 货件来源标签(2026-11-02,跨店混装) ── */
.self-tag,
.cross-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  vertical-align: 1px;
  white-space: nowrap;
}
.self-tag {
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
}
.cross-tag {
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
}
/* 详情表格内来源标签换行到货件号下一行(2026-11-04) */
.posting-no-cell .block-tag {
  display: block;
  margin-left: 0;
  margin-top: 4px;
  width: fit-content;
}

/* ── 跨店大包已发出标注(2026-11-07) ── */
.carriage-shipped-tags {
  margin-top: 4px;
}
.carriage-shipped-tags .tag {
  font-size: 11px;
  line-height: 16px;
  padding: 1px 6px;
  max-width: 260px;
  white-space: normal;
}

/* ── 补发场景标记(2026-11-09) ── */
.reship-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 16px;
  color: #b91c1c;
  background: #fef2f2;
  border: 1px solid #fecaca;
  white-space: nowrap;
  vertical-align: 1px;
}
.candidate-table .reship-tag,
.posting-table .reship-tag {
  margin-left: 0;
  margin-top: 4px;
  display: block;
  width: fit-content;
}
/* 详情列表区顶部提示条(不弹窗) */
.carriage-reship-hint {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 10px 0 2px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  color: #92400e;
  font-size: 12px;
  line-height: 18px;
}
.carriage-reship-hint .hint-icon {
  line-height: 18px;
}
.carriage-reship-hint .hint-text em {
  font-style: normal;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  margin-right: 4px;
}

/* ── 候选弹窗:本店/跨店 tabs + 跨店筛选(2026-11-02) ── */
.candidate-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.candidate-tab {
  padding: 7px 16px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.candidate-tab:hover {
  color: var(--text);
}
.candidate-tab.on {
  color: var(--primary);
  border-bottom-color: var(--primary);
}
.candidate-filter {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f8fafc;
}
.filter-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.filter-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}
.filter-check-all {
  color: var(--primary);
  font-weight: 600;
}
.filter-keyword {
  max-width: 220px;
}
.filter-date {
  max-width: 160px;
}
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: #fff;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
}
.chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.chip.on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.filter-dates {
  display: flex;
  align-items: center;
  gap: 6px;
}
.date-sep {
  color: var(--muted);
}
.candidate-store {
  font-size: 12px;
  color: #b45309;
  font-weight: 600;
}
.candidate-time {
  font-size: 12px;
  color: var(--muted);
}

/* ── 标签打印机选择栏(2026-11-01,并入发运清单上方) ── */
.printer-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f8fafc;
}
.printer-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.printer-select {
  max-width: 240px;
  min-width: 140px;
  font-size: 12px;
  padding: 5px 6px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.agent-dot {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.agent-dot::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d1d5db;
}
.agent-dot.on {
  color: var(--success);
}
.agent-dot.on::before {
  background: var(--success);
}
.agent-dot.off {
  color: var(--warning);
}
.agent-dot.off::before {
  background: var(--warning);
}

/* 行内已打印标记 */
.printed-mark {
  color: var(--success);
  font-weight: 500;
}

/* 2026-11-02:24h内发运期限 / 已超时 货件数徽标 */
.dl-badge {
  display: inline-block;
  margin-top: 4px;
  padding: 0 6px;
  border-radius: 4px;
  background: #fff7e6;
  color: #d46b08;
  font-size: 11px;
  line-height: 1.6;
  white-space: nowrap;
}
.dl-badge.overdue {
  background: #ffece8;
  color: #f53f3f;
}

/* 2026-11-02:货件数可点击查看货件列表弹窗(与 H5 一致) */
.count-link {
  cursor: pointer;
}
.count-link:hover {
  color: #165dff;
}

/* 操作列按钮间距(按钮较多,横向滚动兜底) */
.ops .btn {
  margin-left: 6px;
}
.carriage-table {
  min-width: 980px;
}
.list-card {
  overflow-x: auto;
}

/* ── 货运标签预览弹窗(2026-11-01) ── */
.label-preview-body {
  text-align: center;
}
.label-preview-img {
  max-width: 100%;
  max-height: 70vh;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: #fff;
}
.label-preview-tip {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
}
.label-preview-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 10px;
}
.label-preview-page {
  font-size: 13px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

/* ── PDF 预览弹窗(2026-11-01) ── */
.pdf-preview-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.preview-title {
  font-size: 14px;
  font-weight: 600;
}
.preview-size {
  font-size: 12px;
  color: var(--muted);
}
.preview-frame-wrap {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: #f8fafc;
  height: 70vh;
  min-height: 420px;
}
.preview-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
.preview-empty {
  padding: 60px 20px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
</style>