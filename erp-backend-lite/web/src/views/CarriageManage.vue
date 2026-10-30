<script setup>
// FBS 货运创建/发运管理(2026-10-29)
// 流程:备货 → 选配送方式 → 创建发运 → 查看/调整货件 → 设快递员联系方式(OGL 上门取件)
//      → 确认发运 → 打面单/货位标签(跳转打印页) → 取消发运。
// 与 ContainerLabelPrint 互补:本页负责"创建/确认/取消"发运生命周期,
// 面单与货位标签打印仍走打印页。
import { ref, reactive, computed, onMounted } from 'vue';
import { useStoresStore } from '../stores/stores.js';
import { useConfirmStore } from '../stores/confirm.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import {
  getCarriageDeliveryMethods,
  getCarriageList,
  createCarriage,
  getCarriage,
  getCarriagePostings,
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
};
function carriageStatusLabel(status) {
  return CARRIAGE_STATUS_LABELS[status] || status || '—';
}
function hasAction(c, action) {
  return Array.isArray(c?.available_actions) && c.available_actions.includes(action);
}

// ── 店铺与配送方式 ──────────────────────────────────────
const storeId = ref('');
const deliveryMethods = ref([]);
const methodsLoading = ref(false);
const selectedMethodId = ref('');
const departureDate = ref(new Date().toISOString().slice(0, 10));

// 创建发运
const creating = ref(false);

// 发运清单
const carriageList = reactive({ methods: [], loaded: false, loading: false });

// 详情弹窗
const detail = reactive({
  open: false,
  carriageId: 0,
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
});

// 货件编辑(增加/删除后全量 set-postings 保存)
const editPostings = reactive({ dirty: false, saving: false });

// 可加入货件候选弹窗
const candidate = reactive({
  open: false,
  loading: false,
  postings: [],
  selected: {},
});

// 当前表格行(各配送方式下发运 + 可创建占位行)
const currentRows = computed(() => {
  const rows = [];
  for (const m of carriageList.methods || []) {
    for (const c of m.carriages || []) {
      const isPlaceholder = !Number(c.id) || Number(c.id) <= 0;
      rows.push({
        ...c,
        is_placeholder: isPlaceholder,
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
  return rows;
});

// 可用店铺(已配置 sync_credentials 的店铺)
const usableStores = computed(() => storesStore.list.filter((s) => s?.sync_credentials?.clientId));

// ── 配送方式 ────────────────────────────────────────────
async function loadDeliveryMethods() {
  if (!storeId.value) return;
  methodsLoading.value = true;
  deliveryMethods.value = [];
  selectedMethodId.value = '';
  try {
    const data = await getCarriageDeliveryMethods(storeId.value);
    deliveryMethods.value = (data?.delivery_methods || []).filter((m) => m?.id);
    if (!deliveryMethods.value.length) {
      show('该店铺没有可用的配送方式', 'error');
    }
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    methodsLoading.value = false;
  }
}

// ── 发运清单 ────────────────────────────────────────────
async function loadCarriages() {
  if (!storeId.value) return;
  if (carriageList.loading) return;
  carriageList.loading = true;
  try {
    const data = await getCarriageList(storeId.value, { limit: 1000 });
    carriageList.methods = data?.methods || [];
    carriageList.loaded = true;
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    carriageList.loading = false;
  }
}

// ── 创建发运 ────────────────────────────────────────────
async function onCreateCarriage() {
  if (!storeId.value) {
    show('请先选择店铺', 'error');
    return;
  }
  // 店铺有多个配送方式时必须显式选择;只有一个时可不传(自动选择唯一配送方式)
  const body = {};
  if (selectedMethodId.value) body.deliveryMethodId = Number(selectedMethodId.value);
  if (departureDate.value) body.departureDate = departureDate.value;

  const methodName =
    deliveryMethods.value.find((m) => String(m.id) === String(selectedMethodId.value))?.name || '自动选择';
  const ok = await confirmStore.ask({
    title: '创建发运',
    message: `确认创建发运?\n店铺:${storeId.value}\n配送方式:${methodName}\n发运日期:${departureDate.value || '不指定'}\n该配送方式下所有「已准备发运」货件将自动进入发运。`,
    confirmText: '创建发运',
  });
  if (!ok) return;

  creating.value = true;
  try {
    const r = await createCarriage(storeId.value, body);
    show(`发运创建成功:${r?.carriage_id ? '#' + r.carriage_id : ''}`, 'success');
    // 刷新清单,并自动打开新发运详情
    await loadCarriages();
    const cid = Number(r?.carriage_id);
    if (cid > 0) {
      const found = currentRows.value.find((row) => Number(row.id) === cid);
      openDetail(found || { id: cid, store_id: storeId.value });
    }
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    creating.value = false;
  }
}

// 占位行(可创建):把配送方式带到创建区
function onGoCreate(row) {
  selectedMethodId.value = String(row.delivery_method_id || '');
  document.getElementById('carriage-create-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  show(`已选择配送方式:${row.delivery_method_name || row.delivery_method_id}`, 'success');
}

// ── 详情 ────────────────────────────────────────────────
async function openDetail(row) {
  detail.open = true;
  detail.carriageId = Number(row.id);
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
  try {
    await storesStore.load();
    // 默认选第一个已配置 sync_credentials 的店铺
    storeId.value = usableStores.value[0]?.id || storesStore.list[0]?.id || '';
    if (storeId.value) {
      loadDeliveryMethods();
      loadCarriages();
      loadContactConfigs();
    }
  } catch (err) {
    show(err.message || '店铺列表加载失败', 'error');
  }
});

// 切换店铺
async function onStoreChange() {
  contactConfigs.loaded = false;
  loadDeliveryMethods();
  loadCarriages();
  loadContactConfigs(true);
}
</script>

<template>
  <div class="carriage-page">
    <div class="page-head">
      <h2>货运创建 · 发运管理</h2>
      <span class="page-sub">FBS 备货后创建发运 · 查看货件 · 设快递员联系方式 · 确认/取消发运</span>
      <button class="btn btn-ghost btn-sm" :disabled="carriageList.loading" @click="loadCarriages">
        {{ carriageList.loading ? '加载中…' : '刷新' }}
      </button>
    </div>

    <!-- 创建发运 -->
    <div id="carriage-create-card" class="card create-card">
      <div class="section-title">创建发运</div>
      <div class="create-form">
        <label>
          <span>店铺</span>
          <select v-model="storeId" @change="onStoreChange">
            <option value="" disabled>请选择店铺</option>
            <option v-for="s in storesStore.list" :key="s.id" :value="s.id">
              {{ s.name }}{{ s?.sync_credentials?.clientId ? '' : '(未配置 Ozon 凭证)' }}
            </option>
          </select>
        </label>
        <label>
          <span>配送方式</span>
          <select v-model="selectedMethodId" :disabled="methodsLoading">
            <option value="">自动选择(唯一配送方式)</option>
            <option v-for="m in deliveryMethods" :key="m.id" :value="String(m.id)">
              {{ m.name || m.id }}{{ m.status ? ` · ${m.status}` : '' }}
            </option>
          </select>
          <em v-if="methodsLoading" class="field-hint">加载中…</em>
        </label>
        <label>
          <span>发运日期</span>
          <input v-model="departureDate" type="date" />
        </label>
        <button class="btn btn-primary" :disabled="creating || !storeId" @click="onCreateCarriage">
          {{ creating ? '创建中…' : '创建发运' }}
        </button>
      </div>
      <p v-if="deliveryMethods.length" class="form-hint">
        共 {{ deliveryMethods.length }} 个配送方式;不选时 Ozon 自动使用唯一可用配送方式。
      </p>
    </div>

    <!-- 快递员联系方式配置(2026-10-30,支持多条 + 默认项) -->
    <div class="card contact-config-card">
      <div class="section-title">快递员联系方式配置</div>
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
            <td><input v-model="c.phone" placeholder="快递员联系电话" /></td>
            <td><input v-model="c.wechatNickname" :placeholder="`选填,默认:${currentStoreName() || '店铺名'}`" /></td>
            <td><input v-model="c.comment" placeholder="提供给快递公司的取件地址" /></td>
            <td class="ops">
              <button class="btn btn-danger btn-sm" @click="onRemoveContactConfig(i)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="contact-config-actions">
        <button class="btn btn-ghost btn-sm" @click="onAddContactConfig">添加联系方式</button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="contactConfigs.saving"
          @click="onSaveContactConfigs"
        >
          {{ contactConfigs.saving ? '保存中…' : '保存配置' }}
        </button>
      </div>
      <p class="form-hint">
        电话与地址为必填(地址提供给快递公司取件);下单人名称选填,为空时默认使用店铺名「{{ currentStoreName() }}」。
      </p>
    </div>

    <!-- 发运清单 -->
    <div class="card list-card">
      <div class="section-title">发运清单</div>
      <div v-if="carriageList.loading && !currentRows.length" class="list-empty">加载中…</div>
      <div v-else-if="carriageList.loaded && !currentRows.length" class="list-empty">
        该店铺暂无发运记录
      </div>
      <table v-else class="carriage-table">
        <thead>
          <tr>
            <th>发运 ID</th>
            <th>配送方式</th>
            <th>发运日期</th>
            <th>状态</th>
            <th class="num">货件数</th>
            <th class="ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in currentRows" :key="row.id + '-' + row.delivery_method_id">
            <template v-if="row.is_placeholder">
              <td class="mono placeholder">待创建</td>
              <td>
                <span class="dm-name">{{ row.delivery_method_name || row.delivery_method_id }}</span>
                <span v-if="row.timeslot" class="row-sub">{{ row.timeslot }}</span>
              </td>
              <td>{{ row.departure_date || '—' }}</td>
              <td><span class="status-tag create-tag">可创建</span></td>
              <td class="num">{{ row.postings_count }}</td>
              <td class="ops">
                <button class="btn btn-primary btn-sm" @click="onGoCreate(row)">创建发运</button>
              </td>
            </template>
            <template v-else>
              <td class="mono label-id">#{{ row.id }}</td>
              <td>
                <span class="dm-name">{{ row.delivery_method_name || row.delivery_method_id }}</span>
                <span v-if="row.warehouse_city || row.warehouse_name" class="row-sub">
                  {{ row.warehouse_name || '' }}{{ row.warehouse_city ? ` · ${row.warehouse_city}` : '' }}
                </span>
              </td>
              <td>{{ row.departure_date || '—' }}</td>
              <td>
                <span class="status-tag">{{ carriageStatusLabel(row.status) }}</span>
                <span v-if="row.postings_count" class="row-sub">{{ row.postings_count }} 个货件</span>
              </td>
              <td class="num">{{ row.postings_count }}</td>
              <td class="ops">
                <button class="btn btn-ghost btn-sm" @click="openDetail(row)">详情</button>
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
            <button class="btn btn-ghost btn-sm" :disabled="detail.postingsLoading" @click="loadPostings(detail.carriage)">
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
            <em v-if="!contactApplicable" class="field-hint">仅 OGL 上门取件(pickup + ozon_outsourced)适用</em>
          </div>
          <div class="contact-form">
            <label class="contact-select-label">
              <span>选择配置</span>
              <select
                v-model="detail.selectedContactConfigId"
                :disabled="!contactApplicable || !contactConfigs.list.length"
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
              <input v-model="detail.phone" placeholder="快递员联系电话" :disabled="!contactApplicable" />
            </label>
            <label>
              <span>下单人名称</span>
              <input v-model="detail.wechatNickname" :placeholder="`选填,默认:${currentStoreName() || '店铺名'}`" :disabled="!contactApplicable" />
            </label>
            <label>
              <span>地址 <em class="req">*</em></span>
              <input v-model="detail.comment" placeholder="提供给快递公司的取件地址" :disabled="!contactApplicable" />
            </label>
            <button
              class="btn btn-ghost btn-sm"
              :disabled="detail.savingContact || !contactApplicable"
              @click="onSaveContact"
            >
              {{ detail.savingContact ? '保存中…' : '保存' }}
            </button>
            <button
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

.page-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 2px;
}
.page-head h2 {
  margin: 0;
  font-size: 20px;
}
.page-sub {
  flex: 1;
  min-width: 240px;
  font-size: 12.5px;
  color: var(--muted);
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 12px;
}

/* ── 创建区 ── */
.create-card {
  padding: 16px 20px;
}
.create-form {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}
.create-form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.create-form label > span {
  font-size: 12.5px;
  color: var(--muted);
}
.create-form select,
.create-form input[type='date'] {
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13.5px;
  background: #fff;
  color: var(--text);
  min-width: 220px;
}
.create-form select:focus,
.create-form input:focus {
  outline: none;
  border-color: var(--primary);
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
</style>