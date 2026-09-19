<template>
  <view class="page" v-if="pkg">
    <!-- 顶部:包裹摘要 -->
    <view class="card">
      <view class="head-line">
        <text class="store">{{ pkg.storeName }}</text>
        <text class="posting">{{ pkg.postingNumber }}</text>
      </view>
      <view class="head-sub">{{ items.length }} 个商品行 · 采购合计 {{ fmtMoney(pkg.totalPurchaseAmount) }}</view>
    </view>

    <!-- Step2:平台订单选择 -->
    <view v-if="step === 'select'">
      <view class="card">
        <!-- 已有采购入口(2026-09-19:进页直接展示平台订单,已有采购收进此入口条) -->
        <view v-if="groups.length" class="linked-entry" @click="step = 'manage'">
          <text>已有采购 {{ groups.length }} 单 · 改分摊/删除</text>
          <text class="linked-entry-arrow">›</text>
        </view>
        <view class="section-title">选择平台订单</view>
        <!-- 平台×账号 tabs(多账号展开,与 web 端一致) -->
        <scroll-view class="plat-tabs" scroll-x :show-scrollbar="false">
          <view class="plat-tabs-inner">
            <view
              v-for="t in platTabs"
              :key="t.key"
              class="plat-tab"
              :class="{ on: activeTabKey === t.key }"
              @click="switchPlatTab(t.key)"
            >{{ t.label }}</view>
          </view>
        </scroll-view>

        <!-- 登录态警示:恢复登录需在服务器/电脑端操作 -->
        <view v-if="curPlatLogin !== 'yes'" class="login-warn">
          {{ curTabDef ? curTabDef.label : '当前平台' }}未检测到登录态,可能拉不到订单。恢复登录需在服务器/电脑端操作。
        </view>

        <!-- 状态子 tab + 刷新 -->
        <view class="subtabs">
          <view
            v-for="sb in subTabs"
            :key="sb.key"
            class="subtab"
            :class="{ on: curStore.tab === sb.key }"
            @click="switchSubTab(sb.key)"
          >{{ sb.label }}</view>
          <view class="subtab refresh" @click="refreshOrders">刷新</view>
        </view>

        <!-- 按单号精确搜索(跨账号) -->
        <view class="imp-search">
          <input
            class="imp-search-input"
            v-model="searchKeyword"
            placeholder="按采购单号精确搜索(跨账号)"
            confirm-type="search"
            @confirm="doSearch"
          />
        </view>

        <!-- 订单列表 -->
        <view v-if="curStore.loading" class="muted-line pad">加载中…</view>
        <view v-else-if="curStore.error" class="err-line pad">{{ curStore.error }}</view>
        <view v-else-if="!impOrders.length" class="muted-line pad">暂无订单(可尝试刷新或搜索)</view>
        <view
          v-for="o in impOrders"
          :key="o.orderSn"
          class="po-order"
          :class="{ sel: curStore.selected.includes(o.orderSn), disabled: isRestoredLinked(o) }"
          @click="toggleSelect(o)"
        >
          <view class="po-check">{{ curStore.selected.includes(o.orderSn) ? '☑' : '☐' }}</view>
          <image
            v-if="o.goods && o.goods[0] && o.goods[0].thumbUrl"
            class="po-order-img"
            :src="o.goods[0].thumbUrl"
            mode="aspectFill"
            lazy-load
          />
          <view v-else class="po-order-img"></view>
          <view class="po-order-main">
            <view class="po-order-title">
              {{ (o.goods && o.goods[0] && o.goods[0].goodsName) || '—' }}<text v-if="o.goods && o.goods.length > 1" class="po-more"> 等{{ o.goods.length }}件商品</text>
            </view>
            <view class="po-order-meta">
              <text class="po-order-amt">¥{{ o.amount }}</text>
              <text class="po-order-time">{{ fmtOrderTime(o) }}</text>
            </view>
            <view class="po-order-sn">{{ o.orderSn }}<text v-if="o.trackingNumber"> · {{ o.trackingNumber }}</text></view>
          </view>
          <text v-if="isRestoredLinked(o)" class="restored-badge">已关联</text>
        </view>
      </view>

      <!-- 底部条:已选统计 + 返回/下一步 -->
      <view class="action-bar">
        <view class="sel-info">
          <text class="sel-count">已选 {{ selCount }} 单</text>
          <text class="sel-total">合计 ¥{{ newSelectedTotal }}</text>
        </view>
        <button class="abtn ghost" @click="uni.navigateBack()">返回</button>
        <button class="abtn primary" :disabled="!selCount" @click="goStep3">下一步</button>
      </view>
    </view>

    <!-- Step3:分摊确认 + 提交 -->
    <view v-else-if="step === 'confirm'">
      <view class="card">
        <view class="section-title">分摊确认</view>

        <!-- 已选订单摘要 -->
        <view class="sum-box">
          <view class="sum-line">
            <text class="po-platform">{{ platformLabel(step3Platform) }}</text>
            <text class="sum-count">已选 {{ selCount }} 单</text>
            <text class="sum-total">¥{{ newSelectedTotal }}</text>
          </view>
          <view class="sum-sns">{{ step3Sn }}</view>
          <!-- 拼单提示(lookup 查到已关联包裹时) -->
          <view v-if="lookupResult && lookupResult.linkedPackages && lookupResult.linkedPackages.length" class="lookup-tip">
            采购单已关联 {{ lookupResult.linkedPackages.length }} 个包裹,本次为追加关联;auto 模式下已关联 auto 包裹的 {{ autoPreview.existingAutoQty }} 件将参与加权分摊。
          </view>
        </view>

        <!-- 分摊模式切换 -->
        <view class="mode-switch">
          <view class="mode-btn" :class="{ on: allocMode === 'auto' }" @click="switchAllocMode('auto')">
            自动·按数量
          </view>
          <view class="mode-btn" :class="{ on: allocMode === 'manual' }" @click="switchAllocMode('manual')">
            手动指定
          </view>
        </view>

        <!-- auto:只读加权预览 -->
        <template v-if="allocMode === 'auto'">
          <view class="tip">
            订单合计 ¥{{ newSelectedTotal }} 按商品数量加权分摊到各产品行{{ autoPreview.existingAutoQty ? '(加权总数 ' + autoPreview.sumQty + ' 件 = 本包裹 ' + autoPreview.currentQty + ' + 已关联 ' + autoPreview.existingAutoQty + ')' : '' }}。
          </view>
          <view v-for="(it, i) in autoPreview.rows" :key="i" class="alloc-row">
            <image v-if="it.picUrl" class="alloc-img" :src="it.picUrl" mode="aspectFill" />
            <view v-else class="alloc-img"></view>
            <view class="alloc-main">
              <view class="alloc-title">{{ it.title || '—' }}</view>
              <view class="alloc-sub">SKU {{ it.sku || '—' }} ×{{ it.quantity }}</view>
              <view class="alloc-amount">¥{{ it.previewAmount.toFixed(2) }}</view>
            </view>
          </view>
        </template>

        <!-- manual:手填各产品行金额 -->
        <template v-else>
          <view class="tip">各产品行分摊金额已按数量预填,可自行修改。</view>
          <view v-for="(it, i) in manualItems" :key="i" class="alloc-row">
            <image v-if="it.picUrl" class="alloc-img" :src="it.picUrl" mode="aspectFill" />
            <view v-else class="alloc-img"></view>
            <view class="alloc-main">
              <view class="alloc-title">{{ it.title || '—' }}</view>
              <view class="alloc-sub">SKU {{ it.sku || '—' }} ×{{ it.quantity }}</view>
              <view class="alloc-input-wrap">
                <text class="rmb">¥</text>
                <input class="alloc-input" type="digit" v-model="it.amount" placeholder="0.00" />
              </view>
            </view>
          </view>
          <view class="alloc-sum">
            合计:<text class="alloc-sum-num">¥{{ manualTotal.toFixed(2) }}</text>
          </view>
        </template>

        <!-- 国内快递单号(选填,预填平台单号) -->
        <view class="field">
          <text class="field-label">国内快递单号(选填)</text>
          <input class="field-input" v-model="logisticsInput" placeholder="多个用英文逗号分隔,留空待同步补全" />
        </view>
      </view>
      <view class="action-bar">
        <button class="abtn ghost" @click="step = 'select'">返回</button>
        <button class="abtn ghost" :disabled="submitting" @click="doSubmit()">
          {{ submitting ? '提交中…' : '仅保存' }}
        </button>
        <button class="abtn outline-blue" :disabled="submitting || !canShipAfterSave" @click="doSubmit(true)">
          {{ submitting ? '处理中…' : '保存并备货' }}
        </button>
      </view>
    </view>

    <!-- 改分摊编辑模式 -->
    <view v-else-if="allocEditing">
      <view class="card">
        <view class="section-title">修改分摊金额</view>
        <view class="tip">
          自己指定各商品行分摊到本包裹的金额。保存只修改已有采购单的分摊金额,不会新增采购单。
        </view>
        <view v-for="(it, i) in allocItems" :key="i" class="alloc-row">
          <image v-if="it.picUrl" class="alloc-img" :src="it.picUrl" mode="aspectFill" />
          <view v-else class="alloc-img"></view>
          <view class="alloc-main">
            <view class="alloc-title">{{ it.title || '—' }}</view>
            <view class="alloc-sub">SKU {{ it.sku || '—' }} ×{{ it.quantity }}</view>
            <view class="alloc-input-wrap">
              <text class="rmb">¥</text>
              <input class="alloc-input" type="digit" v-model="it.amount" placeholder="0.00" />
            </view>
          </view>
        </view>
        <view class="alloc-sum">
          合计:<text class="alloc-sum-num">¥{{ allocTotal.toFixed(2) }}</text>
        </view>
      </view>
      <view class="action-bar">
        <button class="abtn ghost" @click="exitAllocEdit">取消</button>
        <button class="abtn primary" :disabled="saving" @click="saveAlloc">
          {{ saving ? '保存中…' : '保存修改' }}
        </button>
      </view>
    </view>

    <!-- 默认视图:已有采购管理(2026-09-19:进页直接展示平台订单,本视图经「已有采购」入口进入) -->
    <view v-else>
      <view class="back-bar" @click="enterSelect">‹ 返回平台订单</view>
      <view class="card">
        <view class="section-title">已有采购({{ groups.length }})</view>
        <view v-if="!groups.length" class="muted-line">尚无采购关联</view>
        <view v-for="g in groups" :key="g.purchaseOrderId" class="po">
          <view class="po-head">
            <text class="po-platform">{{ platformLabel(g.platform) }}</text>
            <text class="po-sn">{{ g.purchaseSn || '#' + g.purchaseOrderId }}</text>
            <text class="po-status">{{ poStatusLabel(g.poStatus) }}</text>
          </view>
          <view class="po-meta">
            <text class="po-amt">分摊 {{ fmtMoney(g.allocated) }}</text>
            <text v-if="g.buyerAccount" class="po-meta-item">买:{{ g.buyerAccount }}</text>
          </view>
          <view v-for="(pi, j) in g.items" :key="j" class="po-goods">
            <image
              v-if="pi.thumbUrl || pi.picUrl"
              class="po-img"
              :src="pi.thumbUrl || pi.picUrl"
              mode="aspectFill"
              lazy-load
            />
            <view v-else class="po-img"></view>
            <view class="po-goods-main">
              <view class="po-goods-title">{{ pi.goodsName || pi.title || '采购商品' }}</view>
              <view class="po-goods-sub">{{ pi.spec ? pi.spec + ' · ' : '' }}¥{{ pi.price ?? '—' }} × {{ pi.number || pi.num || 1 }}</view>
            </view>
          </view>
          <view v-if="g.poLogisticsNo" class="po-logi">
            <text class="po-logi-company">{{ g.poLogisticsCompany }}</text>
            <text class="po-logi-no">{{ g.poLogisticsNo }}</text>
          </view>
          <view class="po-actions">
            <button class="mini-btn" @click="enterAllocEdit">改分摊</button>
            <button class="mini-btn danger" :disabled="removing" @click="removeGroup(g)">删除</button>
          </view>
        </view>
      </view>
    </view>
  </view>

  <view v-else class="page">
    <view class="empty">{{ loadError || '加载中…' }}</view>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import {
  getOrderDetail,
  updatePurchaseAlloc,
  unlinkPurchase,
  clearPurchaseInfo,
  submitPurchase,
  lookupPurchase,
  shipPackage,
  getPlatformOrders,
  searchPlatformOrder,
  getPlatformOrdersStatus,
} from '../../api/order.js';
import { fmtMoney, fmtTime } from '../../utils/fmt.js';

const packageId = ref('');
const pkg = ref(null);
const items = ref([]);
const links = ref([]);
const loadError = ref('');
const saving = ref(false);
const removing = ref(false);
const allocEditing = ref(false);
const allocItems = ref([]);

// ── 标签映射(与详情页/ web 端同步)────────────────────────
const PLATFORM_LABELS = {
  '1688': '1688',
  ali1688: '1688',
  pdd: '拼多多',
  yangkeduo: '拼多多',
  taobao: '淘宝',
  other: '手工(其他)',
};
function platformLabel(p) {
  return PLATFORM_LABELS[p] || p || '—';
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
function poStatusLabel(s) {
  return PO_STATUS_LABELS[s] || s || '—';
}

// 行级 link 按 purchaseOrderId 分组成"已有采购单"(与 web 端 restoredPurchases 同构)
const groups = computed(() => {
  const byPo = new Map();
  for (const l of links.value) {
    if (!byPo.has(l.purchaseOrderId)) byPo.set(l.purchaseOrderId, []);
    byPo.get(l.purchaseOrderId).push(l);
  }
  return [...byPo.values()].map((ls) => {
    const first = ls[0];
    return {
      purchaseOrderId: first.purchaseOrderId,
      platform: first.platform,
      purchaseSn: first.purchaseSn,
      poStatus: first.poStatus,
      allocated: ls.reduce((s, l) => s + (Number(l.allocatedAmount) || 0), 0),
      buyerAccount: first.buyerAccount,
      sellerName: first.sellerName,
      items: first.items || [],
      poLogisticsNo: first.poLogisticsNo,
      poLogisticsCompany: first.poLogisticsCompany,
    };
  });
});

const allocTotal = computed(() =>
  allocItems.value.reduce((s, it) => s + (Number(it.amount) || 0), 0)
);

// ── 数据加载 ────────────────────────────────────────────────
async function loadDetail() {
  loadError.value = '';
  try {
    const d = await getOrderDetail(packageId.value);
    pkg.value = d?.package || null;
    items.value = d?.items || [];
    links.value = d?.purchaseLinks || [];
    if (!pkg.value) loadError.value = '包裹不存在';
  } catch (e) {
    loadError.value = e.message || '加载失败';
  }
}

function notifyRefresh() {
  // 通知订单列表页刷新(tab 计数 + 列表)
  uni.$emit('orders-refresh');
}

// ── 改分摊(语义与 web 端 5893fbf 一致)────────────────────
// 进入编辑:已有采购的分摊金额按产品行回填,作为手改起点
function enterAllocEdit() {
  const linkByItem = new Map();
  for (const l of links.value) {
    const iid = l.ozonOrderItemId;
    linkByItem.set(iid, (linkByItem.get(iid) || 0) + (Number(l.allocatedAmount) || 0));
  }
  allocItems.value = items.value.map((it) => ({
    itemId: it.id,
    title: it.title,
    sku: it.sku,
    picUrl: it.picUrl,
    quantity: it.quantity,
    amount:
      linkByItem.has(it.id)
        ? String(Math.round(linkByItem.get(it.id) * 100) / 100)
        : '',
  }));
  allocEditing.value = true;
}

function exitAllocEdit() {
  allocEditing.value = false;
  allocItems.value = [];
}

// 保存:修改已有采购单分摊到本包裹的金额(不新增采购单)
function saveAlloc() {
  if (saving.value) return;
  const list = allocItems.value
    .map((it) => ({ itemId: it.itemId, amount: Number(it.amount) || 0 }))
    .filter((it) => it.itemId);
  if (!list.some((it) => it.amount > 0)) {
    uni.showToast({ title: '请至少填写一行分摊金额', icon: 'none' });
    return;
  }
  const totalAmount = list.reduce((s, it) => s + it.amount, 0);
  const oldAlloc = groups.value.reduce((s, g) => s + g.allocated, 0);
  const pos = groups.value.map((g) => g.purchaseSn || '(手工单)').join('、');
  uni.showModal({
    title: '修改分摊金额',
    content:
      '将已有采购单 ' + pos + ' 分摊到本包裹的金额修改为 ¥' +
      totalAmount.toFixed(2) + '(当前 ¥' + oldAlloc.toFixed(2) + ')?\n不会新增采购单。',
    confirmText: '修改',
    success: async (res) => {
      if (!res.confirm) return;
      saving.value = true;
      try {
        const r = await updatePurchaseAlloc({ packageId: packageId.value, items: list });
        uni.showToast({
          title: '已修改分摊 ¥' + (Number(r?.total) || totalAmount).toFixed(2),
          icon: 'none',
        });
        notifyRefresh();
        // 返回详情页(详情页 onShow 会自动刷新)
        setTimeout(() => uni.navigateBack(), 600);
      } catch (e) {
        /* 错误 toast 已由 request.js 统一弹出 */
      } finally {
        saving.value = false;
      }
    },
  });
}

// ── 删除采购关联 ────────────────────────────────────────────
function removeGroup(g) {
  if (removing.value) return;
  uni.showModal({
    title: '删除采购关联',
    content:
      '删除 ' + (g.purchaseSn || '#' + g.purchaseOrderId) + ' 与本包裹的关联?\n将冲回该单分摊到本包裹的金额(' + fmtMoney(g.allocated) + ')。',
    confirmText: '删除',
    success: async (res) => {
      if (!res.confirm) return;
      removing.value = true;
      try {
        await unlinkPurchase(g.purchaseOrderId, packageId.value);
        // 全部删光:清残留聚合(采购状态/头程物流),对齐 web 端"逐单删光后保存"语义
        const remaining = groups.value.filter((x) => x.purchaseOrderId !== g.purchaseOrderId);
        if (!remaining.length) await clearPurchaseInfo(packageId.value);
        uni.showToast({ title: '已删除采购关联', icon: 'none' });
        notifyRefresh();
        await loadDetail();
      } catch (e) {
        /* 已 toast */
      } finally {
        removing.value = false;
      }
    },
  });
}

// ════════════════════════════════════════════════════════════
// Step2:平台订单选择(与 web 端 OrderProcess.vue 同构,2026-09-13 多账号模型)
// ════════════════════════════════════════════════════════════
// 平台 tab 元数据:platform(请求用)→ platformVal(入库平台值)/label
const PLATFORM_TAB_META = {
  pdd: { platformVal: 'yangkeduo', label: '拼多多' },
  ali1688: { platformVal: '1688', label: '1688' },
  taobao: { platformVal: 'taobao', label: '淘宝' },
};

const step = ref('select'); // select=选平台订单(默认,进页直接展示) | manage=管理已有采购
// 默认 tabs(/status 未返回时兜底,与 web 端一致)
const platTabs = ref([
  { key: 'pdd', platform: 'pdd', account: 'linqx', label: '拼多多' },
  { key: 'ali:linqx', platform: 'ali1688', account: 'linqx', label: '1688·linqx' },
  { key: 'taobao', platform: 'taobao', account: 'linqx', label: '淘宝' },
]);
const platLogin = reactive({}); // `${platform}:${account}` → 'yes'|'no'|'unknown'
const stores = reactive({});    // tabKey → { orders, loading, error, tab, selected, searched }
const activeTabKey = ref('');
const searchKeyword = ref('');

function storeFor(key) {
  if (!stores[key]) {
    stores[key] = { orders: [], loading: false, error: '', tab: 'all', selected: [], searched: [] };
  }
  return stores[key];
}

const curTabDef = computed(() => platTabs.value.find((t) => t.key === activeTabKey.value) || null);
const curStore = computed(() => storeFor(activeTabKey.value));
const curPlatLogin = computed(() => {
  const d = curTabDef.value;
  return d ? platLogin[d.platform + ':' + d.account] || 'unknown' : 'unknown';
});

// 状态子 tab(pdd 无"待发货",与 web 端一致)
const subTabs = computed(() => {
  if ((curTabDef.value?.platform || '') === 'pdd') {
    return [{ key: 'all', label: '全部' }, { key: 'unreceived', label: '待收货' }];
  }
  return [{ key: 'all', label: '全部' }, { key: 'unshipped', label: '待发货' }, { key: 'unreceived', label: '待收货' }];
});

// 已有采购单的 SN 键集合(逗号拼接的 SN 拆开),平台列表里标记"已关联"并禁止重复勾选
const restoredSnKeys = computed(() => {
  const s = new Set();
  for (const g of groups.value) {
    for (const part of String(g.purchaseSn || '').split(',')) {
      const p = part.trim();
      if (p) s.add(g.platform + ':' + p);
    }
  }
  return s;
});

function isRestoredLinked(o) {
  const plat = PLATFORM_TAB_META[curTabDef.value?.platform]?.platformVal || '';
  return restoredSnKeys.value.has(plat + ':' + o.orderSn);
}

// 当前 tab 订单(搜索命中置顶去重;注入 _platform 入库平台值)
const impOrders = computed(() => {
  const st = curStore.value;
  const plat = PLATFORM_TAB_META[curTabDef.value?.platform]?.platformVal || '';
  const inList = new Set(st.orders.map((o) => o.orderSn));
  const wrap = (o) => (o._platform === plat ? o : { ...o, _platform: plat });
  return [...st.searched.filter((o) => !inList.has(o.orderSn)).map(wrap), ...st.orders.map(wrap)];
});

// 跨平台×账号合并的新勾选订单(排除已关联单);提交时只入库新增部分
const newSelectedOrders = computed(() => {
  const sel = [];
  for (const t of platTabs.value) {
    const st = stores[t.key];
    if (!st) continue;
    const inList = new Set((st.orders || []).map((o) => o.orderSn));
    const merged = [...(st.searched || []).filter((x) => !inList.has(x.orderSn)), ...(st.orders || [])];
    for (const o of merged) {
      if (
        st.selected.includes(o.orderSn) &&
        !restoredSnKeys.value.has((PLATFORM_TAB_META[t.platform]?.platformVal || '') + ':' + o.orderSn)
      ) {
        sel.push({ ...o, _platform: PLATFORM_TAB_META[t.platform]?.platformVal, _account: t.account });
      }
    }
  }
  return sel;
});
const selCount = computed(() => newSelectedOrders.value.length);
const newSelectedTotal = computed(() =>
  newSelectedOrders.value.reduce((s, o) => s + (Number(o.amount) || 0), 0).toFixed(2)
);

// 浏览器登录态探测 + 按账号展开平台 tabs(与 web 端 rebuildAccountTabs 一致)
async function loadPlatformStatus() {
  try {
    const data = await getPlatformOrdersStatus();
    const tabs = [];
    for (const [platform, meta] of Object.entries(PLATFORM_TAB_META)) {
      const accounts = Object.keys(data?.platforms?.[platform]?.accounts || {});
      if (!accounts.length) continue; // 后端未配置该平台 → 保留默认
      const multi = accounts.length > 1;
      for (const account of accounts) {
        const prefix = platform === 'ali1688' ? 'ali' : platform;
        tabs.push({
          key: multi ? prefix + ':' + account : prefix,
          platform,
          account,
          label: multi ? meta.label + '·' + account : meta.label,
        });
      }
    }
    if (tabs.length) {
      platTabs.value = tabs;
      if (!tabs.some((t) => t.key === activeTabKey.value)) activeTabKey.value = tabs[0].key;
    }
    for (const [plat, info] of Object.entries(data?.platforms || {})) {
      for (const [account, v] of Object.entries(info?.accounts || {})) {
        platLogin[plat + ':' + account] = v?.login || 'unknown';
      }
    }
  } catch (e) {
    /* 静默:探测失败不阻塞主流程 */
  }
}

// 拉取指定 tab 的订单(懒建 store;刷新列表保留搜索命中单的勾选)
async function loadOrders(tabKey) {
  const def = platTabs.value.find((t) => t.key === tabKey);
  if (!def) return;
  const st = storeFor(tabKey);
  st.loading = true;
  st.error = '';
  const keepSn = new Set(st.searched.map((o) => o.orderSn));
  st.selected = st.selected.filter((s) => keepSn.has(s));
  try {
    const data = await getPlatformOrders(def.platform, { tab: st.tab, size: 30, account: def.account });
    st.orders = data?.orders || [];
  } catch (e) {
    st.error = e.message || '获取订单失败';
    st.orders = [];
  } finally {
    st.loading = false;
  }
}

function enterSelect() {
  step.value = 'select';
  if (!activeTabKey.value) activeTabKey.value = platTabs.value[0]?.key || '';
  if (!Object.keys(platLogin).length) loadPlatformStatus();
  const st = storeFor(activeTabKey.value);
  if (!st.orders.length && !st.loading) loadOrders(activeTabKey.value);
}

function switchPlatTab(key) {
  if (activeTabKey.value === key || curStore.value.loading) return;
  activeTabKey.value = key;
  searchKeyword.value = '';
  const st = storeFor(key);
  if (!st.orders.length && !st.loading) loadOrders(key);
}

function switchSubTab(t) {
  if (curStore.value.tab === t || curStore.value.loading) return;
  curStore.value.tab = t;
  loadOrders(activeTabKey.value);
}

function refreshOrders() {
  loadOrders(activeTabKey.value);
}

// 按采购单号精确搜索(后端跨账号);命中置顶且刷新列表不丢
async function doSearch() {
  const kw = searchKeyword.value.trim();
  const def = curTabDef.value;
  if (!kw || !def) return;
  const st = curStore.value;
  st.loading = true;
  st.error = '';
  try {
    const data = await searchPlatformOrder(def.platform, kw);
    const hit = data?.result;
    if (hit) {
      st.searched = [hit, ...st.searched.filter((o) => o.orderSn !== hit.orderSn)];
    } else {
      uni.showToast({ title: '未找到该采购单号', icon: 'none' });
    }
  } catch (e) {
    st.error = e.message || '搜索失败';
  } finally {
    st.loading = false;
  }
}

function toggleSelect(o) {
  if (isRestoredLinked(o)) return;
  const st = curStore.value;
  const i = st.selected.indexOf(o.orderSn);
  if (i >= 0) st.selected.splice(i, 1);
  else st.selected.push(o.orderSn);
}

// 平台订单时间:PDD(yangkeduo)为秒级数字需 ×1000;1688/淘宝为字符串
function fmtOrderTime(o) {
  const t = o.orderTime;
  if (t == null || t === '') return '—';
  if (o._platform === 'yangkeduo') return fmtTime(Number(t) * 1000);
  return String(t).replace('T', ' ').slice(0, 16);
}

// ════════════════════════════════════════════════════════════
// Step3:分摊确认 + 提交(与 web 端 savePurchase 语义对齐,5893fbf)
// ════════════════════════════════════════════════════════════
const allocMode = ref('auto'); // 'auto' 按数量加权 | 'manual' 手动指定
const manualItems = ref([]); // manual 模式各产品行金额(切模式时按数量加权预填)
const lookupResult = ref(null); // 拼单查询结果(单单有效;多单拼接查询查不到则忽略)
const logisticsInput = ref(''); // 国内快递单号(选填,预填平台单号)
const submitting = ref(false);

const step3Sel = computed(() => newSelectedOrders.value);
const step3Sn = computed(() => step3Sel.value.map((o) => o.orderSn).join(','));
const step3Platform = computed(() => step3Sel.value[0]?._platform || 'other');

const manualTotal = computed(() =>
  manualItems.value.reduce((s, it) => s + (Number(it.amount) || 0), 0)
);

// auto 模式加权预览(与 web 端 autoPreview 同构)
// 公式:每行分摊 = (该行 quantity / Σauto 关联 quantity) × 订单合计
// Σ = 本包裹各行数量 + lookup 已关联 auto 模式包裹的数量(manual 关联不参与加权)
const autoPreview = computed(() => {
  const payment = Number(newSelectedTotal.value) || 0;
  const currentQty = items.value.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  const existingAutoQty = (lookupResult.value?.linkedPackages || [])
    .filter((p) => (p.alloc_modes || '').includes('auto'))
    .reduce((s, p) => s + (Number(p.quantity) || 0), 0);
  const sumQty = currentQty + existingAutoQty;
  const round2 = (n) => Math.round(n * 100) / 100;
  const rows = items.value.map((it) => ({
    itemId: it.id,
    title: it.title,
    sku: it.sku,
    picUrl: it.picUrl,
    quantity: it.quantity,
    previewAmount: sumQty ? round2(((Number(it.quantity) || 0) * payment) / sumQty) : 0,
  }));
  return { rows, sumQty, payment, currentQty, existingAutoQty };
});

function switchAllocMode(m) {
  if (allocMode.value === m) return;
  allocMode.value = m;
  if (m === 'manual') {
    // 从订单合计按数量加权预填(最后一行兜底差额,与 web 端切模式逻辑一致)
    const total = Number(newSelectedTotal.value) || 0;
    const list = items.value;
    const sumQty = list.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
    let allocated = 0;
    manualItems.value = list.map((it, i) => {
      let a;
      if (i === list.length - 1) a = Math.round((total - allocated) * 100) / 100;
      else {
        a = sumQty ? Math.round(((total * (Number(it.quantity) || 0)) / sumQty) * 100) / 100 : 0;
        allocated += a;
      }
      return {
        itemId: it.id,
        title: it.title,
        sku: it.sku,
        picUrl: it.picUrl,
        quantity: it.quantity,
        amount: String(a),
      };
    });
  }
}

// 进入 Step3:重置状态 + 预填快递单号 + 拼单探测
async function goStep3() {
  if (!selCount.value) return;
  step.value = 'confirm';
  allocMode.value = 'auto';
  manualItems.value = [];
  lookupResult.value = null;
  const tracks = [...new Set(step3Sel.value.map((o) => o.trackingNumber).filter(Boolean))];
  logisticsInput.value = tracks.join(',');
  const sn = step3Sn.value;
  if (step3Platform.value !== 'other' && sn) {
    try {
      const r = await lookupPurchase(step3Platform.value, sn);
      if (r?.exists) lookupResult.value = r;
    } catch (e) {
      /* 探测失败不阻塞,提交前还会再查一次 */
    }
  }
}

// 提交采购(与 web 端 savePurchase 正常提交分支对齐)
// withShip=true:保存成功后立即备货(「保存并备货」按钮)
async function doSubmit(withShip = false) {
  if (submitting.value) return;
  const isAuto = allocMode.value === 'auto';
  const sel = step3Sel.value;
  if (!sel.length) return;
  // 产品行分摊:auto 用加权预览值,manual 用手填值
  const itemsArg = (isAuto ? autoPreview.value.rows : manualItems.value).map((it) => ({
    itemId: it.itemId,
    amount: Number(it.amount ?? it.previewAmount) || 0,
    quantity: it.quantity,
  }));
  if (!isAuto && !itemsArg.some((it) => it.amount > 0)) {
    uni.showToast({ title: '请至少填写一行分摊金额', icon: 'none' });
    return;
  }
  // 拼单检测:进入 Step3 已查过的复用;查到已关联包裹需确认追加
  const platform = step3Platform.value;
  const sn = step3Sn.value;
  if (platform !== 'other' && sn) {
    try {
      const r = lookupResult.value || (await lookupPurchase(platform, sn));
      if (r?.exists && r.linkedPackages?.length) {
        const confirmed = await new Promise((resolve) => {
          uni.showModal({
            title: '拼单提示',
            content:
              '采购单已关联 ' + r.linkedPackages.length + ' 个包裹,本次将追加关联到本包裹' +
              (isAuto ? '(auto 模式:已关联包裹分摊金额将按数量重新加权)' : '') + '。是否继续?',
            confirmText: '追加关联',
            success: (res) => resolve(!!res.confirm),
          });
        });
        if (!confirmed) return;
      }
    } catch (e) {
      /* lookup 失败不阻塞提交 */
    }
  }
  submitting.value = true;
  try {
    // 表单回填口径与 web 端 watch(newSelectedOrders) 一致
    const snList = sel.map((o) => o.orderSn);
    const buyerAccounts = [...new Set(sel.map((o) => o.account || o._account || o.buyerUsername).filter(Boolean))];
    const buyerIds = [...new Set(sel.map((o) => o.buyerUserId).filter(Boolean))];
    const sellers = [...new Set(sel.map((o) => o.mallName || o.sellerName).filter(Boolean))];
    const companies = [...new Set(sel.map((o) => o.logisticsCompany).filter(Boolean))];
    await submitPurchase({
      packageId: packageId.value,
      platform,
      purchaseSn: snList.join(',') || null,
      buyerAccount: buyerAccounts.join(',') || null,
      buyerUserId: buyerIds.join(',') || null,
      sellerName: sellers.join(',') || null,
      paymentAmount: Number(newSelectedTotal.value) || null,
      logisticsCompany: companies.join(',') || null,
      logisticsNo: logisticsInput.value.trim() || null,
      note: null,
      items: itemsArg,
      platformGoods: sel.flatMap((o) => o.goods || []),
      allocMode: isAuto ? 'auto' : 'manual',
    });
    uni.showToast({ title: '已提交,流转待打单发货', icon: 'none' });
    // 保存并备货:提交成功后向 Ozon 确认货件(多件二次确认,单件直接备货)
    if (withShip && canShipAfterSave.value) await shipAfterSave();
    notifyRefresh();
    // 返回详情页(onShow 自动刷新)
    setTimeout(() => uni.navigateBack(), 600);
  } catch (e) {
    /* 错误 toast 已由 request.js 统一弹出 */
  } finally {
    submitting.value = false;
  }
}

// 保存后可备货:未交运未取消且 Ozon 侧待打包(与 web 端备货按钮同口径)
const canShipAfterSave = computed(() => {
  const p = pkg.value;
  return (
    !!p &&
    (p.operateStatus === 'wait_process' || p.operateStatus === 'wait_ship') &&
    p.ozonStatus === 'awaiting_packaging'
  );
});

// 备货(与详情页 onShip 同口径:存在数量≥2 的商品二次确认,单件直接备货)
async function shipAfterSave() {
  const multiQty = items.value.some((it) => (Number(it.quantity) || 0) >= 2);
  const qty = items.value.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  const doShip = async () => {
    try {
      const r = await shipPackage(packageId.value);
      uni.showToast({
        title: r?.pending
          ? '备货指令已提交,Ozon 状态变更中'
          : r?.alreadyShipped
            ? '该包裹已备货过'
            : '备货成功',
        icon: 'none',
      });
    } catch (e) {
      /* 备货失败不影响已保存的采购;toast 已由 request.js 弹出 */
    }
  };
  if (!multiQty) return doShip();
  return new Promise((resolve) => {
    uni.showModal({
      title: '备货确认',
      content:
        '货件 ' + (pkg.value?.postingNumber || '') + '\n含数量≥2的商品(共 ' + qty + ' 件),将向 Ozon 确认全部商品为一个货件(不拆分)。',
      confirmText: '备货',
      success: async (res) => {
        if (res.confirm) await doShip();
        resolve();
      },
    });
  });
}

onLoad((opts) => {
  packageId.value = String((opts && opts.id) || '');
  loadDetail().then(() => {
    // 进页默认展示平台订单:初始化平台 tabs/登录态/首屏订单
    if (pkg.value) enterSelect();
  });
});
</script>

<style scoped>
.page {
  padding: 24rpx 24rpx 200rpx;
}

.card {
  background: #ffffff;
  border-radius: 18rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
}

.head-line {
  display: flex;
  align-items: center;
}

.store {
  font-size: 24rpx;
  color: #165dff;
  background: #eef4ff;
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
  margin-right: 12rpx;
}

.posting {
  font-size: 26rpx;
  color: #1f2329;
  font-family: 'Courier New', monospace;
}

.head-sub {
  margin-top: 12rpx;
  font-size: 23rpx;
  color: #86909c;
}

.section-title {
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  margin-bottom: 16rpx;
}

/* 已有采购入口条(平台订单视图顶部,点击进入管理) */
.linked-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #f0f5ff;
  border: 2rpx solid #a8ccff;
  border-radius: 12rpx;
  padding: 16rpx 20rpx;
  font-size: 26rpx;
  color: #165dff;
  margin-bottom: 16rpx;
}

.linked-entry-arrow {
  font-size: 32rpx;
  line-height: 1;
}

/* 管理视图顶部返回条 */
.back-bar {
  display: inline-block;
  font-size: 26rpx;
  color: #165dff;
  padding: 8rpx 0 16rpx;
}

.muted-line {
  font-size: 24rpx;
  color: #a6abb3;
}

.tip {
  font-size: 22rpx;
  color: #86909c;
  background: #f7f8fa;
  border-radius: 10rpx;
  padding: 14rpx 18rpx;
  margin-bottom: 16rpx;
  line-height: 1.6;
}

/* ── 改分摊编辑 ── */
.alloc-row {
  display: flex;
  align-items: flex-start;
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}

.alloc-img {
  width: 96rpx;
  height: 96rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}

.alloc-main {
  flex: 1;
  margin-left: 16rpx;
  overflow: hidden;
}

.alloc-title {
  font-size: 25rpx;
  color: #1f2329;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.alloc-sub {
  margin-top: 4rpx;
  font-size: 22rpx;
  color: #86909c;
}

.alloc-input-wrap {
  margin-top: 12rpx;
  display: flex;
  align-items: center;
  border: 1rpx solid #e5e6eb;
  border-radius: 10rpx;
  padding: 0 16rpx;
  height: 68rpx;
  background: #ffffff;
}

.rmb {
  font-size: 22rpx;
  color: #a6abb3;
  margin-right: 8rpx;
}

.alloc-input {
  flex: 1;
  font-size: 28rpx;
  color: #1f2329;
  height: 68rpx;
  line-height: 68rpx;
  text-align: right;
}

.alloc-sum {
  margin-top: 16rpx;
  text-align: right;
  font-size: 25rpx;
  color: #4e5969;
}

.alloc-sum-num {
  font-size: 30rpx;
  font-weight: 600;
  color: #1f2329;
}

/* ── 已有采购卡 ── */
.po {
  padding: 16rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}

.po:last-child {
  border-bottom: none;
}

.po-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.po-platform {
  font-size: 22rpx;
  color: #165dff;
  background: #eef4ff;
  padding: 2rpx 12rpx;
  border-radius: 8rpx;
  margin-right: 12rpx;
}

.po-sn {
  font-size: 24rpx;
  color: #1f2329;
  font-family: 'Courier New', monospace;
}

.po-status {
  margin-left: auto;
  font-size: 22rpx;
  color: #4e5969;
}

.po-meta {
  display: flex;
  flex-wrap: wrap;
  margin-top: 10rpx;
  font-size: 22rpx;
  color: #86909c;
}

.po-amt {
  color: #1f2329;
  margin-right: 16rpx;
}

.po-meta-item {
  margin-right: 16rpx;
}

.po-goods {
  display: flex;
  align-items: center;
  margin-top: 12rpx;
}

.po-img {
  width: 80rpx;
  height: 80rpx;
  border-radius: 10rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}

.po-goods-main {
  flex: 1;
  margin-left: 14rpx;
  overflow: hidden;
}

.po-goods-title {
  font-size: 24rpx;
  color: #1f2329;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.po-goods-sub {
  margin-top: 4rpx;
  font-size: 21rpx;
  color: #86909c;
}

.po-logi {
  margin-top: 12rpx;
  font-size: 22rpx;
  color: #4e5969;
  background: #f7f8fa;
  border-radius: 8rpx;
  padding: 8rpx 14rpx;
}

.po-logi-company {
  margin-right: 12rpx;
}

.po-logi-no {
  font-family: 'Courier New', monospace;
}

.po-actions {
  margin-top: 16rpx;
  display: flex;
  justify-content: flex-end;
}

.mini-btn {
  font-size: 24rpx;
  height: 60rpx;
  line-height: 60rpx;
  padding: 0 28rpx;
  margin: 0 0 0 16rpx;
  border-radius: 12rpx;
  background: #eef4ff;
  color: #165dff;
}

.mini-btn::after {
  border: none;
}

.mini-btn.danger {
  background: #ffece8;
  color: #f53f3f;
}

.mini-btn[disabled] {
  opacity: 0.6;
}

/* ── 新增采购入口 ── */
.add-btn {
  width: 100%;
  height: 84rpx;
  line-height: 84rpx;
  font-size: 27rpx;
  border-radius: 14rpx;
  background: #f7f8fa;
  color: #4e5969;
  margin-top: 16rpx;
}

.add-btn::after {
  border: none;
}

/* ── Step2 平台订单选择 ── */
.plat-tabs {
  white-space: nowrap;
  margin-bottom: 16rpx;
}

.plat-tabs-inner {
  display: inline-flex;
}

.plat-tab {
  display: inline-flex;
  align-items: center;
  padding: 10rpx 24rpx;
  margin-right: 12rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
  font-size: 25rpx;
  color: #4e5969;
  flex-shrink: 0;
}

.plat-tab.on {
  background: #165dff;
  color: #ffffff;
}

.login-warn {
  font-size: 22rpx;
  color: #d97706;
  background: #fff7e6;
  border-radius: 10rpx;
  padding: 12rpx 16rpx;
  margin-bottom: 16rpx;
  line-height: 1.5;
}

.subtabs {
  display: flex;
  align-items: center;
  margin-bottom: 16rpx;
}

.subtab {
  font-size: 24rpx;
  color: #4e5969;
  padding: 8rpx 22rpx;
  border-radius: 999rpx;
  background: #f2f3f5;
  margin-right: 12rpx;
}

.subtab.on {
  background: #eef4ff;
  color: #165dff;
  font-weight: 600;
}

.subtab.refresh {
  margin-left: auto;
  margin-right: 0;
  color: #165dff;
  background: #eef4ff;
}

.imp-search {
  margin-bottom: 8rpx;
}

.imp-search-input {
  background: #f7f8fa;
  border-radius: 12rpx;
  height: 68rpx;
  line-height: 68rpx;
  padding: 0 24rpx;
  font-size: 25rpx;
}

.pad {
  padding: 24rpx 0;
}

.err-line {
  font-size: 23rpx;
  color: #f53f3f;
  line-height: 1.5;
}

.po-order {
  display: flex;
  align-items: center;
  padding: 16rpx 8rpx;
  border-bottom: 1rpx solid #f7f8fa;
  border-radius: 8rpx;
}

.po-order.disabled {
  opacity: 0.55;
}

.po-order.sel {
  background: #f0f7ff;
}

.po-check {
  font-size: 36rpx;
  color: #c9cdd4;
  margin-right: 14rpx;
  line-height: 1;
}

.po-order.sel .po-check {
  color: #165dff;
}

.po-order-img {
  width: 88rpx;
  height: 88rpx;
  border-radius: 10rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}

.po-order-main {
  flex: 1;
  margin-left: 14rpx;
  overflow: hidden;
}

.po-order-title {
  font-size: 25rpx;
  color: #1f2329;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.po-more {
  font-size: 21rpx;
  color: #86909c;
}

.po-order-meta {
  margin-top: 4rpx;
  display: flex;
  align-items: center;
}

.po-order-amt {
  font-size: 24rpx;
  color: #f53f3f;
  margin-right: 16rpx;
}

.po-order-time {
  font-size: 21rpx;
  color: #a6abb3;
}

.po-order-sn {
  margin-top: 4rpx;
  font-size: 21rpx;
  color: #86909c;
  font-family: 'Courier New', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.restored-badge {
  flex-shrink: 0;
  font-size: 20rpx;
  color: #86909c;
  background: #f2f3f5;
  border-radius: 999rpx;
  padding: 4rpx 14rpx;
  margin-left: 10rpx;
}

.sel-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  margin-right: 8rpx;
}

.sel-count {
  font-size: 23rpx;
  color: #4e5969;
}

.sel-total {
  font-size: 27rpx;
  color: #1f2329;
  font-weight: 600;
}

/* ── Step3 分摊确认 ── */
.sum-box {
  background: #f7f8fa;
  border-radius: 12rpx;
  padding: 18rpx 20rpx;
  margin-bottom: 20rpx;
}

.sum-line {
  display: flex;
  align-items: center;
}

.sum-count {
  margin-left: 16rpx;
  font-size: 24rpx;
  color: #4e5969;
}

.sum-total {
  margin-left: auto;
  font-size: 30rpx;
  font-weight: 600;
  color: #f53f3f;
}

.sum-sns {
  margin-top: 10rpx;
  font-size: 21rpx;
  color: #86909c;
  font-family: 'Courier New', monospace;
  word-break: break-all;
  line-height: 1.6;
}

.lookup-tip {
  margin-top: 12rpx;
  font-size: 21rpx;
  color: #d97706;
  background: #fff7e6;
  border-radius: 8rpx;
  padding: 10rpx 14rpx;
  line-height: 1.5;
}

.mode-switch {
  display: flex;
  background: #f2f3f5;
  border-radius: 14rpx;
  padding: 6rpx;
  margin-bottom: 20rpx;
}

.mode-btn {
  flex: 1;
  text-align: center;
  font-size: 25rpx;
  color: #4e5969;
  padding: 14rpx 0;
  border-radius: 10rpx;
}

.mode-btn.on {
  background: #ffffff;
  color: #165dff;
  font-weight: 600;
  box-shadow: 0 2rpx 8rpx rgba(0, 0, 0, 0.08);
}

.alloc-amount {
  margin-top: 12rpx;
  font-size: 28rpx;
  font-weight: 600;
  color: #1f2329;
  text-align: right;
}

.field {
  margin-top: 24rpx;
}

.field-label {
  font-size: 24rpx;
  color: #4e5969;
  display: block;
  margin-bottom: 12rpx;
}

.field-input {
  background: #f7f8fa;
  border-radius: 12rpx;
  height: 72rpx;
  line-height: 72rpx;
  padding: 0 24rpx;
  font-size: 25rpx;
}

/* ── 底部操作条 ── */
.action-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  background: #ffffff;
  padding: 16rpx 24rpx calc(16rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -4rpx 16rpx rgba(0, 0, 0, 0.06);
}

.abtn {
  flex: 1;
  margin: 0 8rpx;
  height: 80rpx;
  line-height: 80rpx;
  font-size: 27rpx;
  border-radius: 14rpx;
  background: #f2f3f5;
  color: #4e5969;
  padding: 0;
}

.abtn::after {
  border: none;
}

.abtn.primary {
  background: #165dff;
  color: #ffffff;
}

/* 白底蓝字描边(2026-09-19:「保存并备货」) */
.abtn.outline-blue {
  background: #ffffff;
  color: #165dff;
  border: 2rpx solid #165dff;
}

.abtn[disabled] {
  opacity: 0.6;
}

.empty {
  text-align: center;
  padding: 120rpx 0;
  color: #a6abb3;
  font-size: 26rpx;
}
</style>
