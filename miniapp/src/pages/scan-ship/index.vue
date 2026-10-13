<template>
  <view class="page">
    <!-- 搜索区(扫码枪/手动输入,确认即搜) -->
    <view class="search-box">
      <input
        class="search-input"
        v-model="keyword"
        placeholder="扫快递单号 / 货件号 / SKU / 采购单号"
        placeholder-class="ph"
        confirm-type="search"
        focus
        @confirm="doSearch"
      />
      <text v-if="keyword" class="search-clear" @click="clearSearch">×</text>
    </view>
    <view class="hint">支持:Ozon单号 / 包裹号 / 物流号 / offer_id / SKU / 采购单号 / 采购物流单号</view>

    <!-- 搜索状态横幅 -->
    <view v-if="banner.text" class="banner" :class="'banner-' + banner.type">{{ banner.text }}</view>

    <!-- 结果卡片流 -->
    <view v-if="results.length" class="list">
      <view v-for="pkg in results" :key="pkg.id" class="card">
        <view class="card-head">
          <text class="store">{{ pkg.storeName }}</text>
          <text class="posting">{{ pkg.postingNumber }}</text>
          <text v-if="pkg.isIgnored" class="op-tag op-mute">搁置</text>
          <text v-else class="op-tag" :class="'op-' + opTag(pkg).cls">{{ opTag(pkg).label }}</text>
        </view>

        <view class="prod-row">
          <image v-if="it.picUrl" class="prod-img" :src="it.picUrl" mode="aspectFill" lazy-load />
          <view v-else class="prod-img"></view>
          <view class="prod-main">
            <view class="prod-title">{{ it.title || '—' }}</view>
            <view class="prod-sub">
              <text v-if="it.sku" class="sku">{{ it.sku }}</text>
              <text class="qty" :class="{ 'qty-multi': (Number(it.quantity) || 0) > 1 }">×{{ it.quantity }}</text>
            </view>
          </view>
          <view class="prod-price">{{ fmtMoney(it.price) }}</view>
        </view>

        <view class="card-foot">
          <text v-if="pkg.items && pkg.items.length" class="p-tag">{{ pkg.items.length }} 个商品行</text>
          <text class="p-tag" :class="pkg.purchaseStatus === 'none' ? 'p-none' : 'p-ok'">
            {{ pkg.purchaseStatus === 'none' ? '未采购' : '已采购' }}
          </text>
          <view class="foot-amts">
            <text class="amt">金额 {{ fmtMoney(pkg.orderAmount) }}</text>
            <text class="amt muted">{{ pkg.weightG != null ? Math.floor(pkg.weightG) + 'g' : '—' }}</text>
          </view>
        </view>

        <!-- 操作区 -->
        <view class="card-actions">
          <!-- 未备货:备货 -->
          <button
            v-if="canShipPkg(pkg)"
            class="mini-btn primary"
            :disabled="shippingPkgId === pkg.id"
            @click.stop="onShipPackage(pkg)"
          >{{ shippingPkgId === pkg.id ? '备货中…' : '备货' }}</button>

          <!-- 待打单:录重量 + 提交发货 + 面单 -->
          <template v-if="canShipCard(pkg)">
            <view class="weight-box">
              <input
                class="weight-input"
                type="number"
                :value="weights[pkg.id] ?? ''"
                :disabled="shippingPkgId === pkg.id"
                placeholder="重量(g)"
                placeholder-class="ph"
                @input="onWeightInput(pkg, $event)"
                @confirm="onSubmitShip(pkg)"
              />
              <text class="weight-unit">g</text>
            </view>
            <button
              class="mini-btn primary"
              :disabled="shippingPkgId === pkg.id"
              @click.stop="onSubmitShip(pkg)"
            >{{ shippingPkgId === pkg.id ? '提交中…' : '提交发货' }}</button>
            <button class="mini-btn" @click.stop="openLabel(pkg)">面单</button>
            <view v-if="weightErr[pkg.id]" class="field-err">{{ weightErr[pkg.id] }}</view>
          </template>

          <!-- 已交运/已发货:面单 + 更正重量 -->
          <template v-if="canReprintCard(pkg)">
            <button class="mini-btn" @click.stop="openLabel(pkg)">面单</button>
            <view class="weight-box">
              <input
                class="weight-input"
                type="number"
                :value="correctWeights[pkg.id] ?? (pkg.weightG != null ? Math.floor(pkg.weightG) : '')"
                placeholder="更正重量(g)"
                placeholder-class="ph"
                @input="onCorrectInput(pkg, $event)"
              />
              <text class="weight-unit">g</text>
            </view>
            <button
              class="mini-btn"
              :disabled="correcting === pkg.id"
              @click.stop="onCorrectWeight(pkg)"
            >{{ correcting === pkg.id ? '保存中…' : '更正' }}</button>
            <view v-if="correctErr[pkg.id]" class="field-err">{{ correctErr[pkg.id] }}</view>
          </template>

          <!-- 非可操作状态提示 -->
          <text v-if="!canShipCard(pkg) && !canReprintCard(pkg) && !canShipPkg(pkg)" class="block-reason">{{ blockReason(pkg) }}</text>
        </view>
      </view>
    </view>

    <view v-if="searching" class="empty">搜索中…</view>
    <view v-if="!searching && !results.length" class="empty">
      {{ searchedOnce ? '未找到匹配订单' : '输入单号后回车搜索' }}
    </view>

    <!-- 今日发货记录 -->
    <view v-if="records.length" class="card records">
      <view class="section-title">今日已交运({{ records.length }})</view>
      <view v-for="r in records" :key="r.id" class="rec-row">
        <text class="rec-posting">{{ r.postingNumber }}</text>
        <text class="rec-w">{{ r.weightG != null ? Math.floor(r.weightG) + 'g' : '—' }}</text>
        <text class="rec-time">{{ fmtTime(r.waybillPrintedAt || r.createdAt) }}</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import {
  getOrderList, shipPackage, scanShipSubmit, correctShipWeight, getScanShipRecords, fetchPackageLabel, markPrinted,
} from '../../api/order.js';
import { fmtMoney, fmtTime } from '../../utils/fmt.js';

const keyword = ref('');
const searching = ref(false);
const results = ref([]);
const searchedOnce = ref(false);
const shippingPkgId = ref(0);
const correcting = ref(0);
const weights = reactive({});
const weightErr = reactive({});
const correctWeights = reactive({});
const correctErr = reactive({});
const records = ref([]);
const banner = reactive({ type: '', text: '' });

const OPERATE_LABELS = {
  wait_process: { label: '待处理', cls: 'warn' },
  wait_ship: { label: '待打单', cls: 'info' },
  ship_success: { label: '交运', cls: 'info' },
  wait_receiver_confirm: { label: '已发货', cls: 'ok' },
  cancelled: { label: '已取消', cls: 'err' },
};
function opTag(pkg) {
  if (pkg.isReturned) return { label: '已退货', cls: 'err' };
  return OPERATE_LABELS[pkg.operateStatus] || { label: pkg.operateStatus || '—', cls: 'mute' };
}
function canShipCard(pkg) {
  return pkg.operateStatus === 'wait_ship' && !pkg.isIgnored;
}
function canReprintCard(pkg) {
  return pkg.operateStatus === 'ship_success' || pkg.operateStatus === 'wait_receiver_confirm';
}
function canShipPkg(pkg) {
  return pkg.ozonStatus === 'awaiting_packaging' && !pkg.isIgnored && !!pkg.id;
}
function blockReason(pkg) {
  if (pkg.isIgnored) return '已搁置';
  switch (pkg.operateStatus) {
    case 'wait_process': return '待处理(未采购)';
    case 'ship_success': return '已交运';
    case 'wait_receiver_confirm': return '已发货(已交运)';
    case 'cancelled': return '订单已取消';
    default: return pkg.operateStatus || '—';
  }
}

async function doSearch() {
  const kw = keyword.value.trim();
  if (!kw || searching.value) return;
  searching.value = true;
  searchedOnce.value = true;
  results.value = [];
  banner.text = '';
  try {
    const data = await getOrderList({
      tab: 'all',
      globalKeyword: kw,
      globalMode: 'ss',
      page: 1,
      pageSize: 50,
    });
    results.value = data?.packages || [];
    const n = results.value.length;
    banner.type = n ? 'ok' : 'err';
    banner.text = n ? `命中 ${n} 个包裹,请在卡片上操作` : `未找到匹配订单「${kw}」`;
  } catch (err) {
    banner.type = 'err';
    banner.text = err.message || String(err);
  } finally {
    searching.value = false;
  }
}

function clearSearch() {
  keyword.value = '';
  results.value = [];
  searchedOnce.value = false;
  banner.text = '';
}

function onWeightInput(pkg, e) {
  weights[pkg.id] = e.detail.value;
  weightErr[pkg.id] = '';
}
function onCorrectInput(pkg, e) {
  correctWeights[pkg.id] = e.detail.value;
  correctErr[pkg.id] = '';
}

// 备货(与 web 端同口径:多件商品弹窗确认)
async function onShipPackage(pkg) {
  if (shippingPkgId.value) return;
  const totalQty = (pkg.items || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  if (totalQty > 1) {
    const ok = await new Promise((resolve) => {
      uni.showModal({
        title: '备货确认',
        content: `货件 ${pkg.postingNumber}\n共 ${totalQty} 件商品,将向 Ozon 确认全部商品为一个货件(不拆分)。`,
        confirmText: '备货',
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!ok) return;
  }
  shippingPkgId.value = pkg.id;
  try {
    const r = await shipPackage(pkg.id);
    if (r.ozonStatus) pkg.ozonStatus = r.ozonStatus;
    if (r.operateStatus) pkg.operateStatus = r.operateStatus;
    uni.showToast({
      title: r.alreadyShipped ? '该包裹已备货过' : (r.pending ? '备货指令已提交' : '备货成功'),
      icon: 'none',
    });
  } catch (e) {
    /* request.js 已 toast */
  } finally {
    shippingPkgId.value = 0;
  }
}

// 提交发货:重量落库 → 标记交运 → 尝试打开面单
async function onSubmitShip(pkg) {
  if (shippingPkgId.value) return;
  const raw = String(weights[pkg.id] ?? '').trim();
  const g = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(g) || g < 1 || g > 50000) {
    weightErr[pkg.id] = '重量须为 1~50000 的整数(克)';
    return;
  }
  weightErr[pkg.id] = '';
  shippingPkgId.value = pkg.id;
  try {
    const r = await scanShipSubmit(pkg.id, g);
    if (!r.canShip) {
      uni.showToast({ title: r.message || `订单状态问题:${r.operateStatus}`, icon: 'none', duration: 2500 });
      return;
    }
    await markPrinted(pkg.id);
    pkg.operateStatus = 'ship_success';
    pkg.weightG = g;
    uni.showToast({ title: '已交运 ' + pkg.postingNumber, icon: 'none' });
    openLabel(pkg).catch(() => {});
    loadRecords();
  } catch (e) {
    /* request.js 已 toast */
  } finally {
    shippingPkgId.value = 0;
  }
}

// 打开/复制面单(后端返回 10 分钟短时公开链接)
async function openLabel(pkg) {
  const r = await fetchPackageLabel(pkg.id);
  const url = r && r.url;
  if (!url) return;
  // #ifdef H5
  window.open(url, '_blank');
  // #endif
  // #ifdef MP-WEIXIN
  uni.setClipboardData({ data: url, success: () => uni.showToast({ title: '面单链接已复制,请在浏览器打开', icon: 'none' }) });
  // #endif
}

async function onCorrectWeight(pkg) {
  if (correcting.value) return;
  const raw = String(correctWeights[pkg.id] ?? (pkg.weightG != null ? Math.floor(pkg.weightG) : '')).trim();
  const g = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(g) || g < 1 || g > 50000) {
    correctErr[pkg.id] = '重量须为 1~50000 的整数(克)';
    return;
  }
  correctErr[pkg.id] = '';
  correcting.value = pkg.id;
  try {
    await correctShipWeight(pkg.id, g);
    pkg.weightG = g;
    correctWeights[pkg.id] = '';
    uni.showToast({ title: '重量已更正', icon: 'none' });
  } catch (e) {
    /* request.js 已 toast */
  } finally {
    correcting.value = 0;
  }
}

async function loadRecords() {
  try {
    const data = await getScanShipRecords({ day: 'today', page: 1, pageSize: 8 });
    records.value = data?.records || [];
  } catch (e) {
    /* 静默 */
  }
}

onLoad(() => {
  loadRecords();
});
onPullDownRefresh(async () => {
  await doSearch();
  await loadRecords();
  uni.stopPullDownRefresh();
});
</script>

<style scoped>
.page {
  padding: 20rpx 24rpx 60rpx;
}

.search-box {
  display: flex;
  align-items: center;
  background: #ffffff;
  border-radius: 16rpx;
  padding: 6rpx 16rpx;
}
.search-input {
  flex: 1;
  height: 72rpx;
  font-size: 28rpx;
  color: #1f2329;
}
.ph {
  color: #a6abb3;
}
.search-clear {
  font-size: 36rpx;
  color: #c9cdd4;
  padding: 0 8rpx;
}
.hint {
  margin-top: 10rpx;
  font-size: 21rpx;
  color: #86909c;
}
.banner {
  margin-top: 16rpx;
  padding: 14rpx 18rpx;
  border-radius: 12rpx;
  font-size: 25rpx;
  line-height: 1.5;
}
.banner-ok { color: #00b42a; background: #e8ffea; }
.banner-err { color: #f53f3f; background: #ffece8; }
.banner-info { color: #165dff; background: #eef4ff; }

.list {
  margin-top: 16rpx;
}
.card {
  background: #ffffff;
  border-radius: 18rpx;
  padding: 20rpx;
  margin-bottom: 20rpx;
}
.card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10rpx;
}
.store {
  font-size: 22rpx;
  color: #165dff;
  background: #eef4ff;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  margin-right: 12rpx;
}
.posting {
  font-size: 26rpx;
  color: #1f2329;
  font-family: 'Courier New', monospace;
  margin-right: auto;
}
.op-tag {
  font-size: 22rpx;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
}
.op-warn { color: #d97706; background: #fff7e6; }
.op-info { color: #165dff; background: #eef4ff; }
.op-ok { color: #00b42a; background: #e8ffea; }
.op-err { color: #f53f3f; background: #ffece8; }
.op-mute { color: #86909c; background: #f2f3f5; }

/* 商品行(与订单列表页同风格) */
.prod-row {
  display: flex;
  align-items: flex-start;
  padding: 12rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}
.prod-img {
  width: 96rpx;
  height: 96rpx;
  border-radius: 10rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}
.prod-main {
  flex: 1;
  margin-left: 14rpx;
  overflow: hidden;
}
.prod-title {
  font-size: 25rpx;
  color: #1f2329;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.prod-sub {
  margin-top: 6rpx;
  display: flex;
  align-items: center;
  font-size: 22rpx;
  color: #86909c;
}
.sku {
  color: #165dff;
}
.qty {
  margin-left: 10rpx;
}
.qty-multi {
  color: #d93026;
  font-weight: 600;
}
.prod-price {
  font-size: 25rpx;
  color: #1f2329;
  margin-left: 10rpx;
  flex-shrink: 0;
}
.card-foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 12rpx;
}
.p-tag {
  font-size: 21rpx;
  color: #4e5969;
  background: #f2f3f5;
  padding: 2rpx 12rpx;
  border-radius: 999rpx;
  margin-right: 10rpx;
}
.p-none { color: #d93026; background: #ffece8; }
.p-ok { color: #00b42a; background: #e8ffea; }
.foot-amts {
  margin-left: auto;
  display: flex;
  gap: 14rpx;
  font-size: 22rpx;
  color: #4e5969;
}
.amt.muted { color: #86909c; }

.card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12rpx;
  margin-top: 14rpx;
}
.mini-btn {
  font-size: 24rpx;
  line-height: 1;
  padding: 0 24rpx;
  height: 60rpx;
  border-radius: 10rpx;
  background: #f2f3f5;
  color: #4e5969;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mini-btn::after {
  border: none;
}
.mini-btn.primary {
  background: #165dff;
  color: #ffffff;
}
.mini-btn[disabled] {
  opacity: 0.6;
}
.weight-box {
  display: flex;
  align-items: center;
  background: #f7f8fa;
  border-radius: 10rpx;
  padding: 0 14rpx;
  height: 60rpx;
}
.weight-input {
  width: 160rpx;
  font-size: 26rpx;
  color: #1f2329;
}
.weight-unit {
  font-size: 22rpx;
  color: #86909c;
}
.field-err {
  width: 100%;
  font-size: 21rpx;
  color: #f53f3f;
}
.block-reason {
  font-size: 23rpx;
  color: #86909c;
}

.records {
  margin-top: 4rpx;
}
.section-title {
  font-size: 27rpx;
  font-weight: 600;
  color: #1f2329;
  margin-bottom: 12rpx;
}
.rec-row {
  display: flex;
  align-items: center;
  padding: 10rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
  font-size: 23rpx;
}
.rec-row:last-child {
  border-bottom: none;
}
.rec-posting {
  flex: 1;
  font-family: 'Courier New', monospace;
  color: #1f2329;
}
.rec-w {
  color: #4e5969;
  margin-right: 16rpx;
}
.rec-time {
  color: #86909c;
  font-size: 21rpx;
}

.empty {
  text-align: center;
  padding: 80rpx 0;
  color: #a6abb3;
  font-size: 26rpx;
}
</style>