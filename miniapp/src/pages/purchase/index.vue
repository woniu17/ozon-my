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

    <!-- 改分摊编辑模式 -->
    <view v-if="allocEditing">
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

    <!-- 默认视图:已有采购 + 新增入口 -->
    <view v-else>
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

      <!-- 新增采购(任务 5-6 实现) -->
      <view class="card">
        <view class="section-title">新增采购</view>
        <button class="add-btn" @click="comingSoon">+ 从平台订单选择</button>
        <button class="add-btn" @click="comingSoon">+ 手动录入采购单号</button>
      </view>
    </view>
  </view>

  <view v-else class="page">
    <view class="empty">{{ loadError || '加载中…' }}</view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import {
  getOrderDetail,
  updatePurchaseAlloc,
  unlinkPurchase,
  clearPurchaseInfo,
} from '../../api/order.js';
import { fmtMoney } from '../../utils/fmt.js';

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

// 新增采购入口(任务 5-6 实现)
function comingSoon() {
  uni.showToast({ title: '平台订单选择为任务 5-6 内容', icon: 'none' });
}

onLoad((opts) => {
  packageId.value = String((opts && opts.id) || '');
  loadDetail();
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
