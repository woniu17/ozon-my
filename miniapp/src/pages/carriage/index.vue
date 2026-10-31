<template>
  <view class="page">
    <!-- 顶部 Tab:待处理 / 已完成 -->
    <view class="tabs">
      <view class="tab" :class="{ on: tab === 'pending' }" @click="switchTab('pending')">待处理</view>
      <view class="tab" :class="{ on: tab === 'done' }" @click="switchTab('done')">已完成</view>
    </view>

    <!-- 工具栏:刷新 + 联系方式配置 -->
    <view class="toolbar">
      <view class="toolbar-title">{{ tab === 'pending' ? '发运清单 · 待处理' : '发运清单 · 已完成' }}</view>
      <view class="toolbar-actions">
        <view class="tool-btn" @click="refresh">刷新</view>
        <view class="tool-btn primary" @click="openContactConfig">联系方式配置</view>
      </view>
    </view>

    <!-- 加载/空态 -->
    <view v-if="loading && !listRows.length" class="empty">加载中…</view>
    <view v-else-if="loaded && !listRows.length" class="empty">
      {{ tab === 'pending' ? '暂无进行中的发运' : '暂无已完成发运' }}
    </view>

    <!-- 待处理列表:按配送方式分组的发运卡 -->
    <view v-else-if="tab === 'pending'" class="method-group" v-for="(g, gi) in methodGroups" :key="gi">
      <view v-for="row in g.rows" :key="g.methodKey + '-' + row.id" class="carriage-card">
        <!-- 占位卡(可创建发运) -->
        <template v-if="row.is_placeholder">
          <view class="card-head">
            <view class="store-name">{{ row.store_name }}</view>
            <view class="status-tag create-tag">可创建</view>
          </view>
          <view class="card-body">
            <view class="dm-name">{{ row.delivery_method_name || row.delivery_method_id }}</view>
            <view v-if="row.timeslot" class="row-sub">{{ row.timeslot }}</view>
            <view class="row-sub">{{ row.departure_date || '—' }}</view>
          </view>
          <view class="card-foot">
            <view class="count">{{ row.postings_count }} 个货件</view>
            <view class="btn primary sm" @click="openCreate(row)">创建发运</view>
          </view>
        </template>

        <!-- 普通发运卡 -->
        <template v-else>
          <view class="card-head">
            <view class="store-name">{{ row.store_name }}</view>
            <view class="status-tag" :class="'st-' + row.status">{{ carriageStatusLabel(row.status) }}</view>
          </view>
          <view class="card-body">
            <view class="label-id">#{{ row.id }}</view>
            <view class="dm-name">{{ row.delivery_method_name || row.delivery_method_id }}</view>
            <view v-if="row.warehouse_name || row.warehouse_city" class="row-sub">
              {{ row.warehouse_name || '' }}{{ row.warehouse_city ? ' · ' + row.warehouse_city : '' }}
            </view>
            <view class="row-sub">{{ row.departure_date || '—' }}</view>
          </view>
          <view class="card-foot">
            <view class="count">
              {{ row.postings_count }} 个货件
              <text v-if="row.printed" class="printed-mark">已打印</text>
            </view>
            <view class="ops">
              <view class="btn ghost sm" @click="openDetail(row)">详情</view>
              <view
                class="btn ghost sm"
                :class="{ disabled: !canPrint(row) }"
                @click="canPrint(row) && onPreview(row)"
              >预览</view>
              <view
                class="btn primary sm"
                :class="{ disabled: !canPrint(row) }"
                @click="canPrint(row) && onPrint(row)"
              >打印</view>
            </view>
          </view>
        </template>
      </view>
    </view>

    <!-- 已完成列表 -->
    <view v-else class="method-group">
      <view v-for="row in historyRows" :key="'h-' + row.store_id + '-' + row.id" class="carriage-card">
        <view class="card-head">
          <view class="store-name">{{ row.store_name || ('店铺 ' + row.store_id) }}</view>
          <view class="status-tag">{{ row.status_label || carriageStatusLabel(row.status) }}</view>
        </view>
        <view class="card-body">
          <view class="label-id">#{{ row.id }}</view>
          <view class="dm-name">{{ row.delivery_method_name || row.delivery_method_id }}</view>
          <view class="row-sub">{{ row.departure_date || '—' }}</view>
        </view>
        <view class="card-foot">
          <view class="count">{{ row.postings_count }} 个货件</view>
          <view class="ops">
            <view class="btn ghost sm" @click="openDetail(row)">详情</view>
          </view>
        </view>
      </view>
    </view>

    <!-- 创建发运弹窗 -->
    <view v-if="createModal.open" class="mask" @click="createModal.open = false">
      <view class="sheet create-sheet" @click.stop>
        <view class="sheet-title">创建发运</view>
        <view class="form-row">
          <text class="form-label">店铺</text>
          <text class="form-value">{{ createModal.storeName }}</text>
        </view>
        <view class="form-row">
          <text class="form-label">配送方式</text>
          <text class="form-value">{{ createModal.deliveryMethodName }}</text>
        </view>
        <view class="form-row">
          <text class="form-label">发运日期</text>
          <picker mode="date" :value="createModal.departureDate" @change="createModal.departureDate = $event.detail.value">
            <view class="picker-value">{{ createModal.departureDate || '选择日期' }}</view>
          </picker>
        </view>
        <view class="form-hint">该配送方式下所有「已准备发运」货件将自动进入发运。</view>
        <view class="sheet-actions">
          <view class="btn ghost" @click="createModal.open = false">取消</view>
          <view class="btn primary" :class="{ disabled: createModal.creating }" @click="createSubmit">
            {{ createModal.creating ? '创建中…' : '创建发运' }}
          </view>
        </view>
      </view>
    </view>

    <!-- 详情弹窗 -->
    <view v-if="detail.open" class="mask" @click="closeDetail">
      <view class="sheet detail-sheet" @click.stop>
        <view class="sheet-title">发运详情</view>

        <scroll-view scroll-y class="detail-scroll">
          <!-- 基本信息 -->
          <view class="detail-grid">
            <view class="detail-item"><text class="detail-label">店铺</text><text class="detail-value">{{ detail.storeName || '—' }}</text></view>
            <view class="detail-item"><text class="detail-label">发运 ID</text><text class="detail-value mono">#{{ detail.carriageId }}</text></view>
            <view class="detail-item"><text class="detail-label">状态</text><text class="detail-value">{{ carriageStatusLabel(detail.carriage?.status) }}</text></view>
            <view class="detail-item"><text class="detail-label">配送方式</text><text class="detail-value">{{ detail.carriage?.delivery_method_name || detail.carriage?.delivery_method_id || '—' }}</text></view>
            <view class="detail-item"><text class="detail-label">发运日期</text><text class="detail-value">{{ detail.carriage?.departure_date || '—' }}</text></view>
            <view class="detail-item"><text class="detail-label">首程类型</text><text class="detail-value">{{ detail.carriage?.first_mile_type || '—' }}</text></view>
            <view class="detail-item"><text class="detail-label">集成方式</text><text class="detail-value">{{ detail.carriage?.integration_type || '—' }}</text></view>
          </view>

          <!-- 货件列表 -->
          <view class="detail-section">
            <view class="section-head">
              <text class="section-name">货件列表</text>
              <text v-if="postingsEditable" class="section-hint">new 状态可增删</text>
              <view class="spacer"></view>
              <view v-if="editPostings.dirty" class="btn primary sm" :class="{ disabled: editPostings.saving }" @click="onSavePostings">
                {{ editPostings.saving ? '保存中…' : '保存货件' }}
              </view>
              <view v-if="postingsEditable" class="btn ghost sm" @click="onOpenCandidate">添加货件</view>
            </view>
            <view v-if="detail.postingsLoading && !detail.postings.length" class="empty small">加载中…</view>
            <view v-else-if="!detail.postings.length" class="empty small">该发运暂无货件</view>
            <view v-else class="posting-list">
              <view v-for="p in detail.postings" :key="p.posting_number" class="posting-item">
                <view class="posting-main">
                  <view class="posting-number mono">{{ p.posting_number }}</view>
                  <view class="posting-products">
                    <view v-for="it in p.products || []" :key="it.sku || it.offer_id || it.name" class="posting-product">
                      <image v-if="it.image_url" class="posting-img" :src="it.image_url" mode="aspectFill" />
                      <view v-else class="posting-img placeholder-img" />
                      <text class="posting-name">{{ it.name || it.offer_id || it.sku }}</text>
                      <text class="posting-qty">×{{ it.quantity ?? '' }}</text>
                    </view>
                  </view>
                </view>
                <view class="posting-ops">
                  <text class="printed-tag" :class="p.can_print_label ? 'yes' : 'no'">{{ p.can_print_label ? '可打印' : '不可' }}</text>
                  <text v-if="postingsEditable" class="remove" @click="onRemovePosting(p)">移除</text>
                </view>
              </view>
            </view>
          </view>

          <!-- 快递员联系方式 -->
          <view class="detail-section">
            <view class="section-head">
              <text class="section-name">快递员联系方式</text>
              <text v-if="detail.fromHistory" class="section-hint">历史快照,仅展示</text>
              <text v-else-if="!contactApplicable" class="section-hint">仅 OGL 上门取件适用</text>
            </view>
            <view v-if="!detail.fromHistory" class="form-row">
              <text class="form-label">选择配置</text>
              <picker
                :range="contactConfigNames"
                range-key="label"
                :disabled="!contactApplicable || !contactConfigs.list.length"
                @change="onSelectContactConfig($event.detail.value)"
              >
                <view class="picker-value">
                  {{ contactConfigNames[contactConfigIndex]?.label || '手动填写' }}
                </view>
              </picker>
            </view>
            <view class="form-row">
              <text class="form-label">电话 <text class="req">*</text></text>
              <input
                v-model="detail.phone"
                class="form-input"
                placeholder="快递员联系电话"
                :disabled="detail.fromHistory"
              />
            </view>
            <view class="form-row">
              <text class="form-label">下单人名称</text>
              <input
                v-model="detail.wechatNickname"
                class="form-input"
                :placeholder="'选填,默认:' + (detail.storeName || '店铺名')"
                :disabled="detail.fromHistory"
              />
            </view>
            <view class="form-row">
              <text class="form-label">地址 <text class="req">*</text></text>
              <input
                v-model="detail.comment"
                class="form-input"
                placeholder="提供给快递公司的取件地址"
                :disabled="detail.fromHistory"
              />
            </view>
            <view v-if="!detail.fromHistory" class="section-actions">
              <view class="btn ghost sm" :class="{ disabled: detail.savingContact || !contactApplicable }" @click="onSaveContact">
                {{ detail.savingContact ? '保存中…' : '保存' }}
              </view>
              <view class="btn ghost sm" :class="{ disabled: !contactApplicable }" @click="onSetAsDefault">设为默认</view>
            </view>
            <view class="form-hint">电话与地址必填(地址为提供给快递公司的取件地址);下单人名称选填默认店铺名。</view>
          </view>

          <!-- 发运操作 -->
          <view v-if="!detail.fromHistory" class="detail-actions">
            <view v-if="hasAction('approve')" class="form-row">
              <text class="form-label">容器数(可选)</text>
              <input v-model="detail.containersCount" class="form-input" type="number" placeholder="信任验收按货位发运时填写" />
            </view>
            <view class="sheet-actions">
              <view v-if="hasAction('cancel')" class="btn danger" :class="{ disabled: detail.cancelling }" @click="onCancel">
                {{ detail.cancelling ? '取消中…' : '取消发运' }}
              </view>
              <view v-if="hasAction('approve')" class="btn primary" :class="{ disabled: detail.approving }" @click="onApprove">
                {{ detail.approving ? '确认中…' : '确认发运' }}
              </view>
            </view>
          </view>
        </scroll-view>
      </view>
    </view>

    <!-- 添加货件候选弹窗 -->
    <view v-if="candidate.open" class="mask" @click="candidate.open = false">
      <view class="sheet candidate-sheet" @click.stop>
        <view class="sheet-title">添加货件</view>
        <view class="sheet-sub">
          <text v-if="candidate.loading">加载中…</text>
          <text v-else>已准备发运、不在当前发运中的货件(共 {{ candidate.postings.length }} 个)</text>
        </view>
        <scroll-view scroll-y class="candidate-scroll">
          <view v-if="candidate.loading && !candidate.postings.length" class="empty small">加载中…</view>
          <view v-else-if="!candidate.postings.length" class="empty small">没有可加入的「已准备发运」货件</view>
          <view v-else>
            <view v-for="p in candidate.postings" :key="p.posting_number" class="posting-item candidate-item" @click="toggleCandidate(p.posting_number)">
              <view class="candidate-check" :class="{ on: candidate.selected[p.posting_number] }">
                {{ candidate.selected[p.posting_number] ? '✓' : '' }}
              </view>
              <view class="posting-main">
                <view class="posting-number mono">{{ p.posting_number }}</view>
                <view class="posting-products">
                  <view v-for="it in p.products || []" :key="it.sku || it.offer_id || it.name" class="posting-product">
                    <image v-if="it.image_url" class="posting-img" :src="it.image_url" mode="aspectFill" />
                    <view v-else class="posting-img placeholder-img" />
                    <text class="posting-name">{{ it.name || it.offer_id || it.sku }}</text>
                    <text class="posting-qty">×{{ it.quantity ?? '' }}</text>
                  </view>
                </view>
              </view>
            </view>
          </view>
        </scroll-view>
        <view class="sheet-actions">
          <view class="btn ghost" @click="candidate.open = false">取消</view>
          <view class="btn primary" :class="{ disabled: candidate.loading }" @click="onConfirmAddCandidates">加入选中</view>
        </view>
      </view>
    </view>

    <!-- 货运标签预览弹窗 -->
    <view v-if="preview.open" class="mask" @click="preview.open = false">
      <view class="sheet preview-sheet" @click.stop>
        <view class="sheet-title">
          货运标签预览
          <text v-if="preview.images.length > 1" class="page-indicator">{{ preview.page + 1 }}/{{ preview.images.length }}</text>
        </view>
        <image v-if="preview.images.length" class="preview-img" :src="preview.images[preview.page]" mode="widthFix" />
        <view v-if="preview.images.length > 1" class="preview-nav">
          <view class="btn ghost sm" :class="{ disabled: preview.page === 0 }" @click="previewPrev">上一页</view>
          <view class="btn ghost sm" :class="{ disabled: preview.page === preview.images.length - 1 }" @click="previewNext">下一页</view>
        </view>
        <view class="form-hint">服务器按 PDF 渲染 76×130mm 竖向纸,预览即实际出纸版式。</view>
      </view>
    </view>

    <!-- 快递员联系方式配置弹窗 -->
    <view v-if="contactConfigs.open" class="mask" @click="contactConfigs.open = false">
      <view class="sheet config-sheet" @click.stop>
        <view class="sheet-title">快递员联系方式配置 <text class="sheet-sub">全店铺通用</text></view>
        <scroll-view scroll-y class="config-scroll">
          <view v-if="!contactConfigs.list.length" class="empty small">暂无联系方式配置</view>
          <view v-for="(c, i) in contactConfigs.list" :key="c.id" class="config-item">
            <view class="config-item-head">
              <text class="config-def" @click="setContactConfigDefault(i)">
                {{ c.isDefault ? '⭐ 默认' : '设为默认' }}
              </text>
              <text class="config-remove" @click="removeContactConfig(i)">删除</text>
            </view>
            <view class="form-row">
              <text class="form-label">电话 <text class="req">*</text></text>
              <input v-model="c.phone" class="form-input" placeholder="快递员联系电话" />
            </view>
            <view class="form-row">
              <text class="form-label">下单人名称</text>
              <input v-model="c.wechatNickname" class="form-input" placeholder="选填,默认店铺名" />
            </view>
            <view class="form-row">
              <text class="form-label">地址 <text class="req">*</text></text>
              <input v-model="c.comment" class="form-input" placeholder="提供给快递公司的取件地址" />
            </view>
          </view>
        </scroll-view>
        <view class="sheet-actions">
          <view class="btn ghost" @click="addContactConfig">添加联系方式</view>
          <view class="spacer"></view>
          <view class="btn ghost" @click="contactConfigs.open = false">关闭</view>
          <view class="btn primary" :class="{ disabled: contactConfigs.saving }" @click="saveContactConfigs">
            {{ contactConfigs.saving ? '保存中…' : '保存配置' }}
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
// FBS 发运管理(2026-10-31,自 web 端 CarriageManage.vue 移植)
// 流程:查看待处理/已完成清单 → 创建发运 → 查看/调整货件 → 设快递员联系方式(OGL 上门取件)
//      → 确认发运 → 打印/预览货运标签(未确认禁用)→ 取消发运。
import { ref, reactive, computed } from 'vue';
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app';
import {
  getCarriageList,
  getCarriageHistory,
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
} from '../../api/order.js';
import { getContainerLabelPreview, printContainerLabel, getContainerLabelPrintStatus } from '../../api/print-agent.js';
import { getStores } from '../../api/task-center.js';

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
// 列表接口不返回 available_actions,按状态判断是否已确认
const UNCONFIRMED_CARRIAGE_STATUSES = ['new', 'formed', 'created'];
const PENDING_STATUSES = ['new', 'formed', 'created', 'awaiting_delivery', 'delivering'];

function canPrint(row) {
  return row && !UNCONFIRMED_CARRIAGE_STATUSES.includes(row.status);
}

// ── 数据状态 ────────────────────────────────────────────
const tab = ref('pending');
const loading = ref(false);
const loaded = ref(false);
const stores = ref([]); // 可用店铺(已配置 sync_credentials)
const activeStoreId = ref(''); // 配置/历史接口鉴权用
const pendingRows = ref([]);
const historyRows = ref([]);
const methodGroups = computed(() => {
  // 按 店铺+配送方式 分组,组内占位行在前
  const map = new Map();
  for (const row of pendingRows.value) {
    const key = row.store_id + '|' + row.delivery_method_id;
    if (!map.has(key)) {
      map.set(key, {
        methodKey: key,
        rows: [],
      });
    }
    map.get(key).rows.push(row);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.rows.sort((a, b) => (Number(a.is_placeholder) ? -1 : 1) - (Number(b.is_placeholder) ? -1 : 1));
  }
  return groups;
});

const listRows = computed(() => (tab.value === 'pending' ? pendingRows.value : historyRows.value));

// 创建发运弹窗
const createModal = reactive({
  open: false,
  storeId: '',
  storeName: '',
  deliveryMethodId: '',
  deliveryMethodName: '',
  departureDate: '',
  creating: false,
});

// 详情弹窗
const detail = reactive({
  open: false,
  fromHistory: false,
  carriageId: 0,
  storeId: '',
  storeName: '',
  carriage: null,
  postings: [],
  postingsLoading: false,
  contact: [],
  phone: '',
  wechatNickname: '',
  comment: '',
  selectedContactConfigId: '',
  containersCount: '',
  savingContact: false,
  approving: false,
  cancelling: false,
});
const editPostings = reactive({ dirty: false, saving: false });

// 可加入货件候选
const candidate = reactive({ open: false, loading: false, postings: [], selected: {} });

// 货运标签预览
const preview = reactive({ open: false, images: [], page: 0 });

// 快递员联系方式配置(全店铺通用)
const contactConfigs = reactive({ open: false, loaded: false, saving: false, list: [] });

const contactApplicable = computed(() => {
  const c = detail.carriage;
  return c?.first_mile_type === 'pickup' && c?.integration_type === 'ozon_outsourced';
});
const postingsEditable = computed(() => !detail.fromHistory && detail.carriage?.status === 'new');
const defaultContactConfig = computed(
  () => contactConfigs.list.find((c) => c.isDefault) || contactConfigs.list[0] || null
);
// 详情「选择配置」picker 数据(带"手动填写"占位)
const contactConfigNames = computed(() => {
  const names = [{ id: '', label: '手动填写' }];
  for (const c of contactConfigs.list) {
    names.push({
      id: c.id,
      label: `${c.wechatNickname || c.phone || '(未命名)'}${c.phone ? ' · ' + c.phone : ''}${c.isDefault ? ' · 默认' : ''}`,
    });
  }
  return names;
});
const contactConfigIndex = computed(() => {
  const idx = contactConfigNames.value.findIndex((n) => n.id === detail.selectedContactConfigId);
  return idx >= 0 ? idx : 0;
});

function toast(title, icon = 'none') {
  uni.showToast({ title, icon, duration: 2200 });
}

function hasAction(action) {
  return Array.isArray(detail.carriage?.available_actions) && detail.carriage.available_actions.includes(action);
}

// ── 加载 ────────────────────────────────────────────────
function loadStores() {
  return getStores()
    .then((list) => {
      stores.value = (list || []).filter((s) => s?.sync_credentials?.clientId);
      activeStoreId.value = stores.value[0]?.id || '';
    })
    .catch((err) => toast(err.message || '店铺列表加载失败'));
}

// 待处理:聚合所有可用店铺发运清单
async function loadCarriages() {
  if (loading.value) return;
  loading.value = true;
  try {
    const jobs = stores.value.map(async (s) => {
      try {
        const data = await getCarriageList(s.id, { limit: 1000 });
        return { storeId: s.id, storeName: s.name || '', methods: data?.methods || [] };
      } catch (err) {
        toast(`店铺「${s.name || s.id}」发运清单加载失败:${err.message || err}`);
        return { storeId: s.id, storeName: s.name || '', methods: [] };
      }
    });
    const storeResults = await Promise.all(jobs);
    const rows = [];
    for (const sr of storeResults) {
      for (const m of sr.methods || []) {
        for (const c of m.carriages || []) {
          const isPlaceholder = !Number(c.id) || Number(c.id) <= 0;
          rows.push({
            ...c,
            printed: !!c.printed,
            is_placeholder: isPlaceholder,
            store_id: sr.storeId,
            store_name: sr.storeName || '',
            delivery_method_id: m.delivery_method_id,
            delivery_method_name: m.delivery_method_name || '',
            departure_date: m.departure_date || '',
            warehouse_name: m.warehouse_name || '',
            warehouse_city: m.warehouse_city || '',
            timeslot: (m.timeslot_from || '') + (m.timeslot_to ? ' ~ ' + m.timeslot_to : ''),
          });
        }
      }
    }
    pendingRows.value = rows;
    loaded.value = true;
    fillPrintedStatus(pendingRows.value.filter((r) => !r.is_placeholder));
  } catch (err) {
    toast(err.message || '发运清单加载失败');
  } finally {
    loading.value = false;
  }
}

// 回填货运标签打印状态(失败静默)
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
        const data = await getContainerLabelPrintStatus(storeId, ids);
        for (const r of list) {
          if (data?.printed && data.printed[Number(r.id)]) {
            const row = pendingRows.value.find((x) => x.store_id === storeId && Number(x.id) === Number(r.id));
            if (row) row.printed = true;
          }
        }
      } catch { /* 忽略 */ }
    })
  );
}

// 已完成:本地持久化历史(全店铺)
async function loadHistory() {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await getCarriageHistory(activeStoreId.value);
    historyRows.value = (data?.items || []).map((it) => ({
      ...it,
      status_label:
        it.archived_at && PENDING_STATUSES.includes(it.status) ? '已归档' : carriageStatusLabel(it.status),
    }));
    loaded.value = true;
  } catch (err) {
    toast(err.message || '发运历史加载失败');
  } finally {
    loading.value = false;
  }
}

function refresh() {
  if (tab.value === 'pending') {
    if (!stores.value.length) {
      loadStores().then(loadCarriages);
    } else {
      loadCarriages();
    }
  } else {
    loadHistory();
  }
}

function switchTab(t) {
  if (tab.value === t) return;
  tab.value = t;
  loaded.value = false;
  refresh();
}

onShow(() => {
  if (!stores.value.length) {
    loadStores().then(() => {
      if (tab.value === 'pending') loadCarriages();
    });
  } else if (tab.value === 'pending') {
    // 回到页面时刷新待处理清单(创建/确认/取消后返回保持最新)
    loadCarriages();
  }
});

onPullDownRefresh(() => {
  refresh().finally(() => uni.stopPullDownRefresh());
});

// ── 创建发运 ────────────────────────────────────────────
function openCreate(row) {
  createModal.storeId = row.store_id;
  createModal.storeName = row.store_name || '';
  createModal.deliveryMethodId = String(row.delivery_method_id || '');
  createModal.deliveryMethodName = row.delivery_method_name || '';
  createModal.departureDate = new Date().toISOString().slice(0, 10);
  createModal.creating = false;
  createModal.open = true;
}

async function createSubmit() {
  if (!createModal.storeId || !createModal.deliveryMethodId) {
    toast('缺少店铺或配送方式信息');
    return;
  }
  createModal.creating = true;
  try {
    const body = { deliveryMethodId: Number(createModal.deliveryMethodId) };
    if (createModal.departureDate) body.departureDate = createModal.departureDate;
    const r = await createCarriage(createModal.storeId, body);
    toast(`发运创建成功:${r?.carriage_id ? '#' + r.carriage_id : ''}`, 'success');
    createModal.open = false;
    await loadCarriages();
    const cid = Number(r?.carriage_id);
    if (cid > 0) {
      const found = pendingRows.value.find(
        (row) => Number(row.id) === cid && row.store_id === createModal.storeId
      );
      openDetail(found || {
        id: cid,
        store_id: createModal.storeId,
        store_name: createModal.storeName,
        status: 'new',
        delivery_method_id: createModal.deliveryMethodId,
        delivery_method_name: createModal.deliveryMethodName,
      });
    }
  } catch (err) {
    toast(err.message || '创建发运失败');
  } finally {
    createModal.creating = false;
  }
}

// ── 详情 ──────────────────────────────────────────────────
async function openDetail(row) {
  detail.open = true;
  detail.carriageId = Number(row.id);
  detail.storeId = row.store_id || activeStoreId.value;
  detail.storeName = row.store_name || '';
  detail.fromHistory = !!row.from_history;
  detail.carriage = { ...row };
  detail.postings = [];
  detail.contact = [];
  detail.phone = '';
  detail.wechatNickname = '';
  detail.comment = '';
  detail.containersCount = '';
  detail.selectedContactConfigId = '';
  editPostings.dirty = false;
  if (!contactConfigs.loaded) await loadContactConfigs();

  if (row.from_history) {
    // 历史快照:直接展示本地保存的货件/联系方式
    detail.carriage = { ...row, ...(row.carriage || {}), available_actions: [] };
    detail.postings = row.postings || [];
    detail.contact = row.contact || [];
    const first = detail.contact[0];
    detail.phone = first?.phone || '';
    detail.wechatNickname = first?.wechat_nickname || detail.storeName;
    detail.comment = first?.comment || '';
    return;
  }
  await Promise.all([loadCarriageDetail(), loadPostings(), loadContact()]);
}

function closeDetail() {
  if (editPostings.dirty) {
    uni.showModal({
      title: '货件有未保存修改',
      content: '直接关闭将丢失对货件列表的修改,是否确认关闭?',
      success: (res) => {
        if (res.confirm) detail.open = false;
      },
    });
    return;
  }
  detail.open = false;
}

async function loadCarriageDetail() {
  try {
    const data = await getCarriage(detail.storeId, detail.carriageId);
    detail.carriage = { ...detail.carriage, ...(data || {}) };
  } catch (err) {
    toast(`获取发运详情失败:${err.message || err}`);
  }
}

async function loadPostings() {
  detail.postingsLoading = true;
  try {
    const data = await getCarriagePostings(detail.storeId, detail.carriageId, { limit: 100 });
    detail.postings = data?.postings || [];
  } catch (err) {
    toast(`获取发运货件失败:${err.message || err}`);
  } finally {
    detail.postingsLoading = false;
  }
}

// ── 快递员联系方式配置 ────────────────────────────────────
async function loadContactConfigs(force = false) {
  if (contactConfigs.loaded && !force) return;
  try {
    const data = await listCourierContactConfigs(activeStoreId.value);
    contactConfigs.list = data?.contacts || [];
    contactConfigs.loaded = true;
  } catch (err) {
    toast(err.message || '联系方式配置加载失败');
  }
}

function openContactConfig() {
  if (!contactConfigs.loaded) loadContactConfigs();
  contactConfigs.open = true;
}
function addContactConfig() {
  contactConfigs.list.push({
    id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
    phone: '',
    wechatNickname: '',
    comment: '',
    isDefault: false,
  });
}
function removeContactConfig(index) {
  contactConfigs.list.splice(index, 1);
}
function setContactConfigDefault(index) {
  for (const c of contactConfigs.list) c.isDefault = false;
  contactConfigs.list[index].isDefault = true;
}
async function saveContactConfigs() {
  const incomplete = contactConfigs.list.find((c) => !(c.phone || '').trim() || !(c.comment || '').trim());
  if (incomplete) {
    toast('每条配置都需要填写电话和地址');
    return;
  }
  const valid = contactConfigs.list.filter((c) => (c.phone || '').trim() && (c.comment || '').trim());
  contactConfigs.saving = true;
  try {
    const data = await saveCourierContactConfigs(activeStoreId.value, valid);
    contactConfigs.list = data?.contacts || [];
    contactConfigs.loaded = true;
    toast('联系方式配置已保存', 'success');
  } catch (err) {
    toast(err.message || '保存联系方式配置失败');
  } finally {
    contactConfigs.saving = false;
  }
}

// 详情表单:选择已配置的联系方式后自动填充
function onSelectContactConfig(idx) {
  const item = contactConfigNames.value[idx];
  if (!item || !item.id) {
    detail.selectedContactConfigId = '';
    return;
  }
  const cfg = contactConfigs.list.find((c) => c.id === item.id);
  if (!cfg) return;
  detail.selectedContactConfigId = cfg.id;
  detail.phone = cfg.phone || '';
  detail.wechatNickname = cfg.wechatNickname || detail.storeName;
  detail.comment = cfg.comment || '';
}

async function loadContact() {
  if (!contactConfigs.loaded) await loadContactConfigs();
  const defaultItem = defaultContactConfig.value;
  const storeName = detail.storeName;
  try {
    const data = await getCarriageCourierContact(detail.storeId, detail.carriageId);
    const list = data?.contact || [];
    detail.contact = list;
    const first = list[0];
    // Ozon 已存值优先 → 配置默认项兜底 → 微信昵称再兜底店铺名
    detail.phone = first?.phone || defaultItem?.phone || '';
    detail.wechatNickname = first?.wechat_nickname || defaultItem?.wechatNickname || storeName;
    detail.comment = first?.comment || defaultItem?.comment || '';
    detail.selectedContactConfigId = '';
  } catch {
    // 不适用/未配置时静默:详情页仍可手动填写
    detail.contact = [];
    detail.phone = defaultItem?.phone || '';
    detail.wechatNickname = defaultItem?.wechatNickname || storeName;
    detail.comment = defaultItem?.comment || '';
    detail.selectedContactConfigId = '';
  }
}

async function onSaveContact() {
  if (!(detail.phone || '').trim()) {
    toast('请填写快递员联系电话');
    return;
  }
  if (!(detail.comment || '').trim()) {
    toast('请填写提供给快递公司的取件地址');
    return;
  }
  detail.savingContact = true;
  try {
    await setCarriageCourierContact(detail.storeId, detail.carriageId, {
      phone: detail.phone.trim(),
      wechatNickname: detail.wechatNickname.trim(),
      comment: detail.comment.trim(),
    });
    toast('快递员联系方式已保存', 'success');
    await loadContact();
  } catch (err) {
    toast(err.message || '保存联系方式失败');
  } finally {
    detail.savingContact = false;
  }
}

async function onSetAsDefault() {
  if (!(detail.phone || '').trim()) {
    toast('请先填写快递员联系电话');
    return;
  }
  if (!(detail.comment || '').trim()) {
    toast('请填写提供给快递公司的取件地址');
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
    const data = await saveCourierContactConfigs(activeStoreId.value, list);
    contactConfigs.list = data?.contacts || [];
    toast('当前联系方式已设为默认配置', 'success');
  } catch (err) {
    toast(err.message || '设为默认失败');
  }
}

// ── 货件增加/删除(set-postings 全量覆盖) ────────────────
async function onOpenCandidate() {
  candidate.open = true;
  candidate.selected = {};
  candidate.postings = [];
  candidate.loading = true;
  try {
    const data = await getAvailableCarriagePostings(detail.storeId, detail.carriageId, {
      deliveryMethodId: detail.carriage?.delivery_method_id || undefined,
    });
    candidate.postings = data?.postings || [];
    if (!candidate.postings.length) toast('没有可加入的「已准备发运」货件');
  } catch (err) {
    toast(err.message || '获取可加入货件失败');
  } finally {
    candidate.loading = false;
  }
}

function toggleCandidate(postingNumber) {
  candidate.selected[postingNumber] = !candidate.selected[postingNumber];
}

function onConfirmAddCandidates() {
  const selected = candidate.postings.filter((p) => candidate.selected[p.posting_number]);
  if (!selected.length) {
    toast('请先勾选要加入的货件');
    return;
  }
  const existing = new Set(detail.postings.map((p) => p.posting_number));
  const added = selected.filter((p) => !existing.has(p.posting_number));
  if (!added.length) {
    toast('所选货件已在列表中');
    candidate.open = false;
    return;
  }
  detail.postings = [...detail.postings, ...added];
  editPostings.dirty = true;
  candidate.open = false;
  toast(`已加入 ${added.length} 个货件`, 'success');
}

function onRemovePosting(p) {
  detail.postings = detail.postings.filter((x) => x.posting_number !== p.posting_number);
  editPostings.dirty = true;
}

async function onSavePostings() {
  if (!detail.postings.length) {
    toast('发运至少保留 1 个货件,如需清空请取消发运');
    return;
  }
  editPostings.saving = true;
  try {
    await setCarriagePostings(
      detail.storeId,
      detail.carriageId,
      detail.postings.map((p) => p.posting_number)
    );
    toast('货件列表已保存', 'success');
    editPostings.dirty = false;
    await loadPostings();
    await loadCarriages();
  } catch (err) {
    toast(err.message || '保存货件失败');
  } finally {
    editPostings.saving = false;
  }
}

// ── 确认/取消发运 ────────────────────────────────────────
async function onApprove() {
  const confirmed = await new Promise((resolve) => {
    uni.showModal({
      title: '确认发运',
      content: `确认发运 #${detail.carriageId}?\n确认后发运进入「已生成」状态,后续可打印面单/货位标签。`,
      confirmText: '确认发运',
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
  if (!confirmed) return;
  detail.approving = true;
  try {
    await approveCarriage(detail.storeId, detail.carriageId, detail.containersCount || undefined);
    toast(`发运 #${detail.carriageId} 已确认`, 'success');
    await loadCarriageDetail();
    await loadCarriages();
  } catch (err) {
    toast(err.message || '确认发运失败');
  } finally {
    detail.approving = false;
  }
}

async function onCancel() {
  const confirmed = await new Promise((resolve) => {
    uni.showModal({
      title: '取消发运',
      content: `确认取消发运 #${detail.carriageId}?\n取消后货件将回到未发运状态,可重新组入下一次发运。`,
      confirmText: '取消发运',
      confirmColor: '#ff4d4f',
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
  if (!confirmed) return;
  detail.cancelling = true;
  try {
    await cancelCarriage(detail.storeId, detail.carriageId);
    toast(`发运 #${detail.carriageId} 已取消`, 'success');
    detail.open = false;
    await loadCarriages();
  } catch (err) {
    toast(err.message || '取消发运失败');
  } finally {
    detail.cancelling = false;
  }
}

// ── 货运标签预览/打印(服务器组件,未确认发运禁用) ──────
async function onPreview(row) {
  if (!canPrint(row)) {
    toast('发运确认后生成标签,方可预览');
    return;
  }
  uni.showLoading({ title: '预览加载中…' });
  try {
    const data = await getContainerLabelPreview(row.store_id, Number(row.id));
    const images = data?.images || [];
    if (!images.length) throw new Error('预览图拉取失败');
    preview.images = images;
    preview.page = 0;
    preview.open = true;
  } catch (err) {
    toast(err.message || '预览失败');
  } finally {
    uni.hideLoading();
  }
}
function previewPrev() {
  if (preview.page > 0) preview.page--;
}
function previewNext() {
  if (preview.page < preview.images.length - 1) preview.page++;
}

async function onPrint(row) {
  if (!canPrint(row)) {
    toast('发运确认后生成标签,方可打印');
    return;
  }
  const confirmed = await new Promise((resolve) => {
    uni.showModal({
      title: '打印货运标签',
      content: `打印货运标签 #${row.id}(${row.store_name})?将打印 1 张。`,
      confirmText: '打印',
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
  if (!confirmed) return;
  uni.showLoading({ title: '打印中…' });
  try {
    await printContainerLabel(row.store_id, Number(row.id), '', 1);
    const r = pendingRows.value.find((x) => x.store_id === row.store_id && Number(x.id) === Number(row.id));
    if (r) r.printed = true;
    toast(`已发送打印:货运标签 #${row.id}`, 'success');
  } catch (err) {
    toast(err.message || '打印失败');
  } finally {
    uni.hideLoading();
  }
}
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding: 20rpx 24rpx 60rpx;
  box-sizing: border-box;
  background: #f5f6f7;
}

/* ── Tab ── */
.tabs {
  display: flex;
  background: #fff;
  border-radius: 16rpx;
  padding: 8rpx;
  margin-bottom: 20rpx;
}
.tab {
  flex: 1;
  text-align: center;
  padding: 16rpx 0;
  font-size: 28rpx;
  color: #86909c;
  border-radius: 12rpx;
}
.tab.on {
  background: #165dff;
  color: #fff;
  font-weight: 600;
}

/* ── 工具栏 ── */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20rpx;
}
.toolbar-title {
  font-size: 26rpx;
  color: #4e5969;
  font-weight: 600;
}
.toolbar-actions {
  display: flex;
  gap: 16rpx;
}
.tool-btn {
  font-size: 26rpx;
  color: #165dff;
  padding: 8rpx 20rpx;
  background: #fff;
  border-radius: 12rpx;
}
.tool-btn.primary {
  background: #165dff;
  color: #fff;
}

/* ── 空态 ── */
.empty {
  padding: 80rpx 0;
  text-align: center;
  color: #86909c;
  font-size: 26rpx;
}
.empty.small {
  padding: 40rpx 0;
}
.empty.small {
  font-size: 24rpx;
}

/* ── 发运卡 ── */
.carriage-card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12rpx;
}
.store-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #1d2129;
}
.status-tag {
  font-size: 22rpx;
  padding: 4rpx 14rpx;
  border-radius: 8rpx;
  background: #e8f3ff;
  color: #165dff;
}
.status-tag.create-tag {
  background: #fff7e6;
  color: #d46b08;
}
.card-body {
  margin-bottom: 16rpx;
}
.label-id {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 700;
  font-size: 30rpx;
  margin-bottom: 6rpx;
}
.dm-name {
  font-size: 26rpx;
  color: #4e5969;
}
.row-sub {
  font-size: 22rpx;
  color: #86909c;
  margin-top: 4rpx;
}
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.count {
  font-size: 24rpx;
  color: #86909c;
}
.printed-mark {
  color: #00b42a;
  margin-left: 8rpx;
}
.ops {
  display: flex;
  gap: 12rpx;
}

/* ── 按钮 ── */
.btn {
  font-size: 24rpx;
  padding: 10rpx 24rpx;
  border-radius: 10rpx;
  text-align: center;
  line-height: 1.4;
}
.btn.primary {
  background: #165dff;
  color: #fff;
}
.btn.ghost {
  background: #f2f3f5;
  color: #4e5969;
}
.btn.danger {
  background: #ff4d4f;
  color: #fff;
}
.btn.sm {
  padding: 8rpx 18rpx;
  font-size: 22rpx;
}
.btn.disabled {
  opacity: 0.4;
}

/* ── 弹窗 ── */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 1000;
  display: flex;
  align-items: flex-end;
}
.sheet {
  width: 100%;
  background: #fff;
  border-radius: 24rpx 24rpx 0 0;
  padding: 32rpx 28rpx 40rpx;
  box-sizing: border-box;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}
.sheet-title {
  font-size: 32rpx;
  font-weight: 600;
  color: #1d2129;
  margin-bottom: 24rpx;
  display: flex;
  align-items: baseline;
}
.sheet-sub {
  font-size: 22rpx;
  color: #86909c;
  margin-bottom: 16rpx;
}
.page-indicator {
  font-size: 22rpx;
  color: #86909c;
  font-weight: 400;
  margin-left: 12rpx;
}
.sheet-actions {
  display: flex;
  justify-content: flex-end;
  gap: 16rpx;
  margin-top: 24rpx;
}

/* ── 表单 ── */
.form-row {
  display: flex;
  align-items: center;
  margin-bottom: 20rpx;
}
.form-label {
  width: 180rpx;
  font-size: 26rpx;
  color: #4e5969;
  flex-shrink: 0;
}
.form-value {
  font-size: 26rpx;
  color: #1d2129;
}
.form-input {
  flex: 1;
  font-size: 26rpx;
  border: 1rpx solid #e5e6eb;
  border-radius: 10rpx;
  padding: 12rpx 16rpx;
  background: #fff;
  color: #1d2129;
}
.picker-value {
  font-size: 26rpx;
  color: #165dff;
  padding: 10rpx 0;
}
.req {
  color: #ff4d4f;
}
.form-hint {
  font-size: 22rpx;
  color: #86909c;
  margin-top: 8rpx;
}

/* ── 详情 ── */
.detail-sheet {
  max-height: 92vh;
}
.detail-scroll {
  max-height: 72vh;
}
.detail-grid {
  display: flex;
  flex-wrap: wrap;
  background: #f7f8fa;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 24rpx;
}
.detail-item {
  width: 50%;
  display: flex;
  flex-direction: column;
  padding: 8rpx 0;
  box-sizing: border-box;
}
.detail-label {
  font-size: 22rpx;
  color: #86909c;
  margin-bottom: 4rpx;
}
.detail-value {
  font-size: 26rpx;
  color: #1d2129;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.detail-section {
  margin-bottom: 32rpx;
}
.section-head {
  display: flex;
  align-items: center;
  margin-bottom: 16rpx;
}
.section-name {
  font-size: 28rpx;
  font-weight: 600;
  color: #1d2129;
}
.section-hint {
  font-size: 22rpx;
  color: #86909c;
  margin-left: 12rpx;
}
.spacer {
  flex: 1;
}
.section-actions {
  display: flex;
  gap: 16rpx;
  margin-top: 8rpx;
}

/* ── 货件列表 ── */
.posting-item {
  display: flex;
  align-items: flex-start;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f2f3f5;
}
.posting-item:last-child {
  border-bottom: none;
}
.posting-main {
  flex: 1;
  min-width: 0;
}
.posting-number {
  font-size: 24rpx;
  font-weight: 600;
  color: #1d2129;
  margin-bottom: 8rpx;
}
.posting-products {
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}
.posting-product {
  display: flex;
  align-items: center;
  gap: 12rpx;
}
.posting-img {
  width: 64rpx;
  height: 64rpx;
  border-radius: 8rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}
.placeholder-img {
  border: 1rpx dashed #e5e6eb;
}
.posting-name {
  flex: 1;
  min-width: 0;
  font-size: 22rpx;
  color: #4e5969;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.posting-qty {
  font-size: 22rpx;
  color: #86909c;
  flex-shrink: 0;
}
.posting-ops {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin-left: 16rpx;
  flex-shrink: 0;
}
.printed-tag {
  font-size: 20rpx;
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
}
.printed-tag.yes {
  background: #e8ffea;
  color: #00b42a;
}
.printed-tag.no {
  background: #f2f3f5;
  color: #86909c;
}
.remove {
  font-size: 22rpx;
  color: #ff4d4f;
}

/* ── 候选货件 ── */
.candidate-sheet {
  max-height: 88vh;
}
.candidate-scroll {
  max-height: 60vh;
}
.candidate-item {
  align-items: center;
}
.candidate-check {
  width: 40rpx;
  height: 40rpx;
  border-radius: 8rpx;
  border: 2rpx solid #c9cdd4;
  margin-right: 16rpx;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 24rpx;
}
.candidate-check.on {
  background: #165dff;
  border-color: #165dff;
}

/* ── 预览 ── */
.preview-sheet {
  align-items: center;
}
.preview-img {
  width: 70%;
  border-radius: 12rpx;
  box-shadow: 0 4rpx 20rpx rgba(0, 0, 0, 0.08);
}
.preview-nav {
  display: flex;
  gap: 16rpx;
  margin-top: 20rpx;
}

/* ── 联系方式配置 ── */
.config-sheet {
  max-height: 88vh;
}
.config-scroll {
  max-height: 60vh;
}
.config-item {
  background: #f7f8fa;
  border-radius: 12rpx;
  padding: 20rpx;
  margin-bottom: 16rpx;
}
.config-item-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12rpx;
}
.config-def {
  font-size: 24rpx;
  color: #d46b08;
}
.config-remove {
  font-size: 24rpx;
  color: #ff4d4f;
}
</style>