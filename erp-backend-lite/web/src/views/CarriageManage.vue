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
  approveCarriage,
  cancelCarriage,
  getCarriageCourierContact,
  setCarriageCourierContact,
  setCarriagePostings,
  getAvailableCarriagePostings,
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
  archived: '已归档',
};
function carriageStatusLabel(status) {
  return CARRIAGE_STATUS_LABELS[status] || status || '—';
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

// 创建发运弹窗(占位行触发,2026-11-01:移除顶部创建卡片)
const createModal = reactive({
  open: false,
  storeId: '',
  storeName: '',
  deliveryMethodId: '',
  deliveryMethodName: '',
  departureDate: new Date().toISOString().slice(0, 10),
  creating: false,
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
  postingsLoading: false,
  contact: [],
  contactLoading: false,
  // 联系方式表单
  phone: '',
  wechatNickname: '',
  comment: '',
  selectedContactConfigId: '', // 下拉选择的配置项 id(空=手动填写)
  savingContact: false,
  containersCount: '',
  approving: false,
  cancelling: false,
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

// 可加入货件候选弹窗
const candidate = reactive({
  open: false,
  loading: false,
  postings: [],
  selected: {},
});

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

// 全部:进行中(不含"待创建"占位行) + 已完成历史
const allRows = computed(() => [...activeRows.value, ...history.list]);

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
function onGoCreate(row) {
  createModal.storeId = row.store_id || storeId.value || '';
  createModal.storeName = row.store_name || '';
  createModal.deliveryMethodId = String(row.delivery_method_id || '');
  createModal.deliveryMethodName = row.delivery_method_name || '';
  createModal.departureDate = new Date().toISOString().slice(0, 10);
  createModal.creating = false;
  createModal.open = true;
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
    show(`发运创建成功:${r?.carriage_id ? '#' + r.carriage_id : ''}`, 'success');
    createModal.open = false;
    await loadCarriages();
    const cid = Number(r?.carriage_id);
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
  detail.contact = [];
  detail.phone = '';
  detail.wechatNickname = '';
  detail.comment = '';
  detail.containersCount = '';
  detail.selectedContactConfigId = '';
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
    await loadContact(detail.carriage);
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detail.savingContact = false;
  }
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
    .map((it) => `${it.name || it.offer_id || it.sku || ''} ×${it.quantity ?? ''}`)
    .filter(Boolean)
    .join('、') + (items.length > 3 ? ` 等${items.length}项` : '');
}

// ── 货件增加/删除(2026-10-30,set-postings 全量覆盖) ──────────
// 仅 new 状态允许调整货件(Ozon set-postings 仅发运创建后未确认前可用)
const postingsEditable = computed(() => detail.carriage?.status === 'new');

// 打开候选货件弹窗
async function onOpenCandidate() {
  candidate.open = true;
  candidate.selected = {};
  candidate.postings = [];
  candidate.loading = true;
  try {
    const data = await getAvailableCarriagePostings(storeId.value, detail.carriageId, {
      deliveryMethodId: detail.carriage?.delivery_method_id || undefined,
    });
    candidate.postings = data?.postings || [];
    if (!candidate.postings.length) show('没有可加入的「已准备发运」货件', 'info');
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    candidate.loading = false;
  }
}

// 确认加入候选货件
function onConfirmAddCandidates() {
  const selected = candidate.postings.filter((p) => candidate.selected[p.posting_number]);
  if (!selected.length) {
    show('请先勾选要加入的货件', 'warning');
    return;
  }
  const existing = new Set(detail.postings.map((p) => p.posting_number));
  const added = selected.filter((p) => !existing.has(p.posting_number));
  if (!added.length) {
    show('所选货件已在列表中', 'info');
    candidate.open = false;
    return;
  }
  detail.postings = [...detail.postings, ...added];
  editPostings.dirty = true;
  candidate.open = false;
  show(`已加入 ${added.length} 个货件`, 'success');
}

// 从发运移除货件(前端临时,保存时全量提交)
function onRemovePosting(p) {
  detail.postings = detail.postings.filter((x) => x.posting_number !== p.posting_number);
  editPostings.dirty = true;
}

// 保存货件组成(全量覆盖)
async function onSavePostings() {
  if (!detail.postings.length) {
    show('发运至少保留 1 个货件,如需清空请取消发运', 'error');
    return;
  }
  editPostings.saving = true;
  try {
    await setCarriagePostings(
      storeId.value,
      detail.carriageId,
      detail.postings.map((p) => p.posting_number)
    );
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
              <th>地址 <em class="req">*</em></th>
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
              <td><input v-model="c.comment" placeholder="提供给快递公司的取件地址" /></td>
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
              <td class="mono label-id">#{{ row.id }}</td>
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
            <button
              v-if="!detail.fromHistory"
              class="btn btn-ghost btn-sm"
              :disabled="detail.postingsLoading"
              @click="loadPostings(detail.carriage)"
            >
              {{ detail.postingsLoading ? '加载中…' : '刷新' }}
            </button>
          </div>
          <div v-if="detail.postingsLoading && !detail.postings.length" class="list-empty">加载中…</div>
          <div v-else-if="!detail.postings.length" class="list-empty">该发运暂无货件</div>
          <table v-else class="posting-table">
            <thead>
              <tr>
                <th>货件号</th>
                <th>商品</th>
                <th class="num">件数</th>
                <th>可打印面单</th>
                <th v-if="postingsEditable" class="ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in detail.postings" :key="p.posting_number">
                <td class="mono">{{ p.posting_number }}</td>
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
                      <span class="posting-product-name" :title="it.name || it.offer_id || it.sku">
                        {{ it.name || it.offer_id || it.sku }}
                      </span>
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
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 快递员联系方式 -->
        <div class="detail-section">
          <div class="detail-section-head">
            <span>快递员联系方式</span>
            <em v-if="detail.fromHistory" class="field-hint">历史快照,仅展示</em>
            <em v-else-if="!contactApplicable" class="field-hint">仅 OGL 上门取件(pickup + ozon_outsourced)适用</em>
          </div>
          <div class="contact-form">
            <label class="contact-select-label">
              <span>选择配置</span>
              <select
                v-model="detail.selectedContactConfigId"
                :disabled="detail.fromHistory || !contactApplicable || !contactConfigs.list.length"
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
              <input v-model="detail.phone" placeholder="快递员联系电话" :disabled="detail.fromHistory || !contactApplicable" />
            </label>
            <label>
              <span>下单人名称</span>
              <input v-model="detail.wechatNickname" :placeholder="`选填,默认:${currentStoreName() || '店铺名'}`" :disabled="detail.fromHistory || !contactApplicable" />
            </label>
            <label>
              <span>地址 <em class="req">*</em></span>
              <input v-model="detail.comment" placeholder="提供给快递公司的取件地址" :disabled="detail.fromHistory || !contactApplicable" />
            </label>
            <button
              v-if="!detail.fromHistory"
              class="btn btn-ghost btn-sm"
              :disabled="detail.savingContact || !contactApplicable"
              @click="onSaveContact"
            >
              {{ detail.savingContact ? '保存中…' : '保存' }}
            </button>
            <button
              v-if="!detail.fromHistory"
              class="btn btn-ghost btn-sm"
              :disabled="!contactApplicable"
              @click="onSetAsDefault"
            >
              设为默认
            </button>
          </div>
          <p class="form-hint">
            电话与地址必填(地址为提供给快递公司的取件地址);下单人名称选填默认店铺名。
            从配置中选择可自动填充;「设为默认」把当前内容存为默认配置项。
          </p>
        </div>

        <!-- 发运操作 -->
        <div class="detail-actions">
          <label v-if="hasAction(detail.carriage, 'approve')" class="containers-field">
            <span>容器数(信任验收按货位发运时填写)</span>
            <input v-model="detail.containersCount" type="number" min="1" placeholder="可选" />
          </label>
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
            <td class="mono">{{ p.posting_number }}</td>
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
                  <span class="posting-product-name" :title="it.name || it.offer_id || it.sku">
                    {{ it.name || it.offer_id || it.sku }}
                  </span>
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

    <!-- 创建发运弹窗(2026-11-01:占位行触发) -->
    <AppModal :open="createModal.open" title="创建发运" size="sm" @update:open="createModal.open = $event">
      <div class="create-modal">
        <p class="create-modal-store">店铺:{{ createModal.storeName }}</p>
        <p class="create-modal-method">配送方式:{{ createModal.deliveryMethodName }}</p>
        <label class="create-modal-field">
          <span>发运日期</span>
          <input v-model="createModal.departureDate" type="date" />
        </label>
        <p class="form-hint">该配送方式下所有「已准备发运」货件将自动进入发运。</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="createModal.open = false">取消</button>
          <button
            class="btn btn-primary"
            :disabled="createModal.creating"
            @click="onCreateFromModal"
          >
            {{ createModal.creating ? '创建中…' : '创建发运' }}
          </button>
        </div>
      </div>
    </AppModal>

    <!-- 可加入货件候选弹窗(2026-10-30) -->
    <AppModal :open="candidate.open" title="添加货件" size="lg" @update:open="candidate.open = $event">
      <div class="candidate-head">
        <span v-if="candidate.loading" class="field-hint">加载中…</span>
        <span v-else class="field-hint">
          已准备发运、不在当前发运中的货件(共 {{ candidate.postings.length }} 个),勾选后加入
        </span>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" :disabled="candidate.loading" @click="onOpenCandidate">刷新</button>
        <button class="btn btn-primary btn-sm" :disabled="candidate.loading" @click="onConfirmAddCandidates">
          加入选中
        </button>
      </div>
      <div v-if="candidate.loading && !candidate.postings.length" class="list-empty">加载中…</div>
      <div v-else-if="!candidate.postings.length" class="list-empty">没有可加入的「已准备发运」货件</div>
      <table v-else class="posting-table candidate-table">
        <thead>
          <tr>
            <th class="candidate-check"></th>
            <th>货件号</th>
            <th>商品</th>
            <th class="num">件数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in candidate.postings" :key="p.posting_number">
            <td class="candidate-check">
              <input v-model="candidate.selected[p.posting_number]" type="checkbox" />
            </td>
            <td class="mono">{{ p.posting_number }}</td>
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
                  <span class="posting-product-name" :title="it.name || it.offer_id || it.sku">
                    {{ it.name || it.offer_id || it.sku }}
                  </span>
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

/* ── 创建发运弹窗(2026-11-01) ── */
.create-modal {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 0;
}
.create-modal-store,
.create-modal-method {
  margin: 0;
  font-size: 13.5px;
  color: var(--text);
}
.create-modal-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.create-modal-field span {
  font-size: 12px;
  color: var(--muted);
}
.create-modal-field input[type='date'] {
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13.5px;
  background: #fff;
  color: var(--text);
  max-width: 220px;
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
  align-items: center;
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
.posting-product-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.posting-product-qty {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
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