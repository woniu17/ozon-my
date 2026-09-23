<template>
  <view v-if="pkg" class="page">
    <!-- 头部:店铺 + 货件号 + 状态徽标 + 信息网格 -->
    <view class="card">
      <view class="head-line">
        <text class="store">{{ pkg.storeName }}</text>
        <text class="op-tag" :class="'op-' + opTag.cls">{{ opTag.label }}</text>
      </view>
      <view class="head-line">
        <template v-if="isQcPosting(pkg.postingNumber)">
          <text class="qc-badge">质检单</text>
          <text class="posting qc">{{ pkg.postingNumber }}</text>
        </template>
        <text v-else class="posting">{{ pkg.postingNumber }}</text>
        <text v-if="pkg.parentId" class="split-badge child">子件(母件 {{ pkg.parentId }})</text>
        <text v-else-if="pkg.hasChildren" class="split-badge mother">母件</text>
      </view>
      <view v-if="pkg.tags && pkg.tags.length" class="tags-line">
        <text v-for="t in pkg.tags" :key="t" class="tag-chip">{{ t }}</text>
      </view>

      <!-- 主信息:单列展示核心字段 -->
      <view class="info-list">
        <view class="info-row"><text class="k">Ozon状态</text><text class="v">{{ pkg.ozonStatus || '—' }}{{ pkg.substatus ? ' · ' + pkg.substatus : '' }}</text></view>
        <view class="info-row"><text class="k">下单时间</text><text class="v">{{ fmtTime(pkg.inProcessAt) }}<text v-if="weekdayCN(pkg.inProcessAt)" class="weekday">（{{ weekdayCN(pkg.inProcessAt) }}）</text></text></view>
        <view class="info-row"><text class="k">最晚发货</text><text class="v">{{ fmtTime(pkg.shipmentDate) }}<text v-if="weekdayCN(pkg.shipmentDate)" class="weekday">（{{ weekdayCN(pkg.shipmentDate) }}）</text></text></view>
        <view v-if="showCountdown" class="info-row" :class="{ overdue: cd.overdue }">
          <text class="k">{{ cd.overdue ? '已超时' : '剩发' }}</text>
          <text class="v countdown" :class="{ overdue: cd.overdue }">{{ cd.text }}</text>
        </view>
        <view class="info-row"><text class="k">重量</text><text class="v">{{ pkg.weightG != null ? Math.floor(pkg.weightG) + 'g' : '—' }}</text></view>
        <view class="info-row"><text class="k">订单金额</text><text class="v strong">{{ fmtMoney(pkg.orderAmount) }}</text></view>
        <view class="info-row"><text class="k">采购合计</text><text class="v">{{ fmtMoney(pkg.totalPurchaseAmount) }}</text></view>
      </view>

      <!-- 其它信息:折叠 -->
      <view class="info-more">
        <view class="info-more-toggle" @click="infoOpen = !infoOpen">
          <text>{{ infoOpen ? '收起其它信息' : '更多订单信息' }}</text>
          <text class="info-more-arrow" :class="{ open: infoOpen }">›</text>
        </view>
        <view v-if="infoOpen" class="info-grid">
          <view class="info-item"><text class="k">订单号</text><text class="v">{{ pkg.orderNumber || '—' }}</text></view>
          <view class="info-item"><text class="k">买家</text><text class="v">{{ pkg.buyerName || '—' }}</text></view>
          <view class="info-item"><text class="k">配送方式</text><text class="v">{{ pkg.deliveryMethod || '—' }}</text></view>
          <view class="info-item"><text class="k">发货仓库</text><text class="v">{{ pkg.warehouse || '—' }}</text></view>
          <view v-if="pkg.isReturned" class="info-item"><text class="k">退货状态</text><text class="v">{{ returnState }}</text></view>
          <view v-if="isCancelled && cancelReasonText" class="info-item info-full"><text class="k">取消原因</text><text class="v">{{ cancelReasonText }}</text></view>
        </view>
      </view>
    </view>

    <!-- 产品行 -->
    <view class="card">
      <view class="section-title">商品({{ items.length }})</view>
      <view v-for="(it, i) in items" :key="i" class="prod">
        <image
          v-if="it.picUrl"
          class="prod-img"
          :src="it.picUrl"
          mode="aspectFill"
          lazy-load
          @click="previewImg(it.picUrl)"
        />
        <view v-else class="prod-img"></view>
        <view class="prod-main">
          <view class="prod-title" :class="{ link: it.sku }" @click="openGoodsPage(it.sku)">{{ it.title || '—' }}</view>
          <view class="prod-sub"><text v-if="it.sku">SKU {{ it.sku }}</text></view>
          <view class="prod-sub"><text>OfferID {{ it.offerId || '—' }}</text></view>
          <view class="prod-sub"><text>单价 {{ fmtMoney(it.price) }}</text></view>
        </view>
        <view class="prod-qty">×{{ it.quantity }}</view>
      </view>
      <view v-if="!items.length" class="muted-line">—</view>
    </view>

    <!-- 采购关联 -->
    <view class="card">
      <view class="section-title">采购关联({{ links.length }})</view>
      <view v-if="!links.length" class="muted-line">未录入采购</view>
      <view v-for="l in links" :key="l.id" class="po">
        <view class="po-head">
          <text class="po-platform">{{ platformLabel(l.platform) }}</text>
          <view class="po-sn-wrap">
            <text
              v-if="orderDetailUrl(l.platform, l.purchaseSn)"
              class="po-sn link"
              @click="openOrderPage(l.platform, l.purchaseSn)"
            >{{ l.purchaseSn }}</text>
            <text v-else class="po-sn">{{ l.purchaseSn || '#' + l.purchaseOrderId }}</text>
            <text v-if="l.purchaseSn" class="copy-tag" @click.stop="copyText(l.purchaseSn, '采购单号')">复制</text>
          </view>
          <text class="po-status">{{ poStatusLabel(l.poStatus) }}</text>
        </view>
        <view class="po-meta">
          <text class="po-amt">分摊 {{ fmtMoney(l.allocatedAmount) }}</text>
          <text v-if="l.sellerName" class="po-meta-item">{{ l.sellerName }}</text>
          <text v-if="l.buyerAccount" class="po-meta-item">买:{{ l.buyerAccount }}</text>
        </view>
        <view v-for="(pi, j) in l.items" :key="j" class="po-goods">
          <image
            v-if="pi.thumbUrl || pi.picUrl"
            class="po-img"
            :src="pi.thumbUrl || pi.picUrl"
            mode="aspectFill"
            lazy-load
            @click="previewImg(pi.thumbUrl || pi.picUrl)"
          />
          <view v-else class="po-img"></view>
          <view class="po-goods-main">
            <view class="po-goods-title">{{ pi.goodsName || pi.title || '采购商品' }}</view>
            <view class="po-goods-sub">{{ pi.spec ? pi.spec + ' · ' : '' }}¥{{ pi.price ?? '—' }} × {{ pi.number || pi.num || 1 }}</view>
          </view>
        </view>
        <view v-if="l.poLogisticsNo" class="po-logi">
          <text class="po-logi-company">{{ l.poLogisticsCompany }}</text>
          <text class="po-logi-no link" @click="copyText(l.poLogisticsNo, '快递单号')">{{ l.poLogisticsNo }}</text>
        </view>
      </view>
    </view>

    <!-- 国内物流轨迹(上家→我,最新在前) -->
    <view class="card" v-if="traces.length">
      <view class="section-title">国内物流轨迹({{ traces.length }})</view>
      <view v-for="(t, i) in visibleTraces" :key="i" class="trace">
        <text class="trace-time">{{ fmtTime(t.trace_at || t.traceAt) }}</text>
        <text class="trace-desc">{{ t.description || t.company }}</text>
      </view>
      <view v-if="traces.length > 3" class="trace-toggle" @click="traceOpen = !traceOpen">
        {{ traceOpen ? '收起' : '展开全部 ' + traces.length + ' 条' }}
      </view>
    </view>

    <!-- 底部操作条(显隐规则与 web 端 831ecb6 行级判断一致;顺序:同步订单→备货→采购/编辑采购→同步采购物流)
         2026-09-22:非待处理状态无论有无采购关联均可进入采购页(删除采购后可重新添加),文案随 links 动态 -->
    <view class="action-bar">
      <button class="abtn ghost" :disabled="syncing" @click="onSync">
        {{ syncing ? '同步中…' : '同步订单' }}
      </button>
      <button
        v-if="canShip"
        class="abtn"
        :class="{ primary: pkg.operateStatus === 'wait_ship' }"
        :disabled="shipping"
        @click="onShip"
      >{{ shipping ? '备货中…' : '备货' }}</button>
      <button
        v-if="pkg.operateStatus === 'wait_process'"
        class="abtn primary"
        @click="onPurchase"
      >采购</button>
      <button
        v-if="pkg.operateStatus !== 'wait_process'"
        class="abtn ghost"
        @click="onPurchase"
      >{{ links.length ? '编辑采购' : '添加采购' }}</button>
      <button
        v-if="links.length && pkg.operateStatus !== 'wait_process'"
        class="abtn ghost"
        :disabled="logisticsSyncing"
        @click="onSyncLogistics"
      >{{ logisticsSyncing ? '物流同步中…' : '同步采购物流' }}</button>
    </view>
  </view>

  <view v-else class="page">
    <view class="empty">{{ loadError || '加载中…' }}</view>
  </view>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { getOrderDetail, syncPackage, shipPackage, syncPackagePurchaseLogistics } from '../../api/order.js';
import { fmtMoney, fmtTime, weekdayCN } from '../../utils/fmt.js';

const packageId = ref('');
const pkg = ref(null);
const items = ref([]);
const links = ref([]);
const traces = ref([]);
const traceOpen = ref(false);
const infoOpen = ref(false);
const loadError = ref('');
const syncing = ref(false);
const shipping = ref(false);
const logisticsSyncing = ref(false);

// 每秒刷新的当前时间(驱动剩发倒计时秒级跳动,与 web 端 OrderProcess.vue 一致)
const nowTs = ref(Date.now());
let cdTimer = null;
function startCdTimer() {
  if (cdTimer) return;
  cdTimer = setInterval(() => { nowTs.value = Date.now(); }, 1000);
}
function stopCdTimer() {
  if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
}

// 剩发倒计时仅在 待处理/待打单发货/交运 三态展示(其它状态无发货义务)
const SHOW_COUNTDOWN_STATUSES = ['wait_process', 'wait_ship', 'ship_success'];
const showCountdown = computed(() => {
  const p = pkg.value;
  if (!p) return false;
  return !!p.shipmentDate && SHOW_COUNTDOWN_STATUSES.includes(p.operateStatus);
});

// 倒计时文本:cutoff = shipment_date,依赖 nowTs 每秒重算
const cd = computed(() => {
  const p = pkg.value;
  if (!p || !p.shipmentDate) return { overdue: false, text: '—' };
  const end = new Date(p.shipmentDate).getTime();
  if (isNaN(end)) return { overdue: false, text: '—' };
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
});

onShow(() => startCdTimer());
onHide(() => stopCdTimer());
onUnload(() => stopCdTimer());
onUnmounted(() => stopCdTimer());

// ── 标签映射(与 web 端 OrderProcess.vue 同步)──────────────
const OPERATE_LABELS = {
  wait_process: { label: '待处理', cls: 'warn' },
  wait_ship: { label: '待打单发货', cls: 'info' },
  ship_success: { label: '交运', cls: 'info' },
  wait_receiver_confirm: { label: '已发货', cls: 'ok' },
  cancelled: { label: '已取消', cls: 'err' },
};
const opTag = computed(() => {
  const p = pkg.value;
  if (!p) return { label: '—', cls: 'mute' };
  if (p.isReturned) return { label: '已退货', cls: 'err' };
  return OPERATE_LABELS[p.operateStatus] || { label: p.operateStatus || '—', cls: 'mute' };
});

// 质检单货件号(02131/024785 开头,与 web 端 isQcPosting 同口径):红色徽标 + 红色加粗货件号
function isQcPosting(sn) {
  const s = String(sn || '');
  return s.startsWith('02131') || s.startsWith('024785');
}

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

// ── 采购单号/快递单号交互(与 web 端 orderDetailUrl/copyText 对齐)──
// 采购订单详情页链接:1688 买家订单列表带搜索词 | 拼多多订单详情页(单号缺失返回空)
function orderDetailUrl(platform, purchaseSn) {
  const sn = String(purchaseSn || '').trim();
  if (!sn) return '';
  if (platform === '1688') return `https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?word=${encodeURIComponent(sn)}`;
  if (platform === 'yangkeduo') return `https://mobile.yangkeduo.com/order.html?order_sn=${encodeURIComponent(sn)}`;
  return '';
}

// 复制文本到剪贴板(uni API,H5/小程序通用)
function copyText(val, label) {
  const s = String(val || '').trim();
  if (!s) return;
  uni.setClipboardData({
    data: s,
    success: () => uni.showToast({ title: (label || '') + '已复制', icon: 'none' }),
  });
}

// 打开采购平台订单详情页(H5 新标签打开;小程序无外链能力,复制链接提示浏览器打开)
function openOrderPage(platform, purchaseSn) {
  const url = orderDetailUrl(platform, purchaseSn);
  if (!url) return;
  // #ifdef H5
  window.open(url, '_blank');
  // #endif
  // #ifdef MP-WEIXIN
  uni.setClipboardData({
    data: url,
    success: () => uni.showToast({ title: '订单页链接已复制,请在浏览器打开', icon: 'none' }),
  });
  // #endif
}

// Ozon 商品详情页链接(与价格管理页口径一致:/context/detail/id/{sku};H5 新标签,小程序复制链接)
function openGoodsPage(sku) {
  const s = String(sku || '').trim();
  if (!s) return;
  const url = `https://ozon.ru/context/detail/id/${s}`;
  // #ifdef H5
  window.open(url, '_blank');
  // #endif
  // #ifdef MP-WEIXIN
  uni.setClipboardData({
    data: url,
    success: () => uni.showToast({ title: '商品页链接已复制,请在浏览器打开', icon: 'none' }),
  });
  // #endif
}

// rFBS 退货状态中文释义(与 web 端同步)
const RETURN_STATE_LABELS = {
  Utilized: '已销毁',
  UtilizedByOzon: 'Ozon销毁',
  Utilizing: '销毁中',
  ArrivedAtWarehouse: '已到退货仓',
  MoneyReturned: '已退款',
  MoneyReturning: '退款中',
  WaitingShipment: '待寄回',
  Shipping: '退货运输中',
  ReturnedToSeller: '已退回卖家',
};
const returnState = computed(() => {
  const p = pkg.value;
  if (!p || !p.isReturned) return '';
  return RETURN_STATE_LABELS[p.returnState] || p.returnStateName || p.returnState || '退货中';
});

// 取消原因中文释义(常用,与 web 端 CANCEL_REASON_LABELS 同步)
const CANCEL_REASON_LABELS = {
  992: 'Ozon质检单',
  994: 'Ozon质检单',
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
};
const isCancelled = computed(() => pkg.value?.operateStatus === 'cancelled');
const cancelReasonText = computed(() => {
  const p = pkg.value;
  if (!p) return '';
  return CANCEL_REASON_LABELS[p.cancelReasonId] || p.cancelReason || '';
});

// 备货按钮显隐:(待处理|待打单) 且 Ozon awaiting_packaging(与 web 端一致)
const canShip = computed(() => {
  const p = pkg.value;
  if (!p) return false;
  return (
    (p.operateStatus === 'wait_process' || p.operateStatus === 'wait_ship') &&
    p.ozonStatus === 'awaiting_packaging'
  );
});

const visibleTraces = computed(() => (traceOpen.value ? traces.value : traces.value.slice(0, 3)));

// ── 数据加载 ────────────────────────────────────────────────
async function loadDetail() {
  loadError.value = '';
  try {
    const d = await getOrderDetail(packageId.value);
    pkg.value = d?.package || null;
    items.value = d?.items || [];
    links.value = d?.purchaseLinks || [];
    traces.value = d?.traces || [];
    if (!pkg.value) loadError.value = '包裹不存在';
  } catch (e) {
    loadError.value = e.message || '加载失败';
  }
}

// ── 操作 ────────────────────────────────────────────────────
function notifyListRefresh() {
  // 通知订单列表页刷新(tab 计数 + 列表)
  uni.$emit('orders-refresh');
}

// 同步订单:按单号直查 Ozon 拉最新状态 + 强拉应计(无时间窗口限制)
// toast 口径与 web 端 onSyncPackage 一致:订单/应计/状态流转(statusX 为 {ozon, operate} 对象)
async function onSync() {
  if (syncing.value) return;
  syncing.value = true;
  try {
    const r = await syncPackage(packageId.value);
    const parts = ['订单' + (r?.orderSynced ? '已同步' : '未更新')];
    if (r?.accrualRows != null) parts.push('应计 ' + r.accrualRows + ' 行');
    if (r?.statusBefore && r?.statusAfter) {
      const before = r.statusBefore.ozon + '/' + r.statusBefore.operate;
      const after = r.statusAfter.ozon + '/' + r.statusAfter.operate;
      if (before !== after) parts.push('状态 ' + before + ' → ' + after);
    }
    uni.showToast({ title: '同步完成:' + parts.join(' · '), icon: 'none', duration: 2500 });
    await loadDetail();
    notifyListRefresh();
  } catch (e) {
    /* 错误 toast 已由 request.js 统一弹出 */
  } finally {
    syncing.value = false;
  }
}

// 备货:向 Ozon 确认全部商品为一个货件(不拆分);已备货幂等返回 alreadyShipped
// 仅当存在数量≥2的商品时二次确认(防多件误发);全部单件直接备货
function onShip() {
  if (shipping.value) return;
  const multiQty = items.value.some((it) => (Number(it.quantity) || 0) >= 2);
  const qty = items.value.reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  const doShip = async () => {
    shipping.value = true;
    try {
      const r = await shipPackage(packageId.value);
      uni.showToast({ title: r?.alreadyShipped ? '该包裹已备货过' : '备货成功', icon: 'none' });
      await loadDetail();
      notifyListRefresh();
    } catch (e) {
      /* 已 toast */
    } finally {
      shipping.value = false;
    }
  };
  if (!multiQty) return doShip();
  uni.showModal({
    title: '备货确认',
    content:
      '货件 ' + pkg.value.postingNumber + '\n含数量≥2的商品(共 ' + qty + ' 件),将向 Ozon 确认全部商品为一个货件(不拆分)。',
    confirmText: '备货',
    success: (res) => res.confirm && doShip(),
  });
}

// 同步采购物流:该包裹全部关联采购单补单号 + 拉轨迹(强制刷新)
async function onSyncLogistics() {
  if (logisticsSyncing.value) return;
  logisticsSyncing.value = true;
  try {
    const r = await syncPackagePurchaseLogistics(packageId.value);
    const n = Array.isArray(r?.results) ? r.results.length : 0;
    uni.showToast({ title: '已同步 ' + n + ' 个采购单物流', icon: 'none' });
    await loadDetail();
    notifyListRefresh();
  } catch (e) {
    /* 已 toast */
  } finally {
    logisticsSyncing.value = false;
  }
}

// 打开采购页(待处理=新增采购;非待处理=管理已有采购:改分摊/删除,任务4)
function onPurchase() {
  uni.navigateTo({ url: '/pages/purchase/index?id=' + packageId.value });
}

function previewImg(url) {
  if (!url) return;
  uni.previewImage({ urls: [url] });
}

onLoad((opts) => {
  packageId.value = String((opts && opts.id) || '');
  loadDetail();
});

// 从采购页返回时刷新详情(改分摊/删除会改变采购关联与金额)
onShow(() => {
  if (pkg.value) loadDetail();
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
  flex-wrap: wrap;
  margin-bottom: 12rpx;
}

.store {
  font-size: 24rpx;
  color: #165dff;
  background: #eef4ff;
  padding: 4rpx 12rpx;
  border-radius: 8rpx;
  margin-right: auto;
}

.posting {
  font-size: 26rpx;
  color: #1f2329;
  font-family: 'Courier New', monospace;
}

/* 质检单货件号(02131/024785 开头):红色加粗显著展示 */
.posting.qc {
  color: #d93026;
  font-weight: 700;
}

.qc-badge {
  flex-shrink: 0;
  font-size: 20rpx;
  color: #d93026;
  border: 2rpx solid #d93026;
  border-radius: 6rpx;
  padding: 0 8rpx;
  line-height: 36rpx;
  margin-right: 8rpx;
  font-weight: 700;
}

.split-badge {
  font-size: 20rpx;
  padding: 2rpx 10rpx;
  border-radius: 6rpx;
  margin-left: 10rpx;
}

.split-badge.child {
  color: #b45309;
  background: #fff7e6;
}

.split-badge.mother {
  color: #4338ca;
  background: #eef2ff;
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

.tags-line {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 8rpx;
}

.tag-chip {
  font-size: 20rpx;
  color: #4e5969;
  background: #f2f3f5;
  padding: 2rpx 12rpx;
  border-radius: 999rpx;
  margin-right: 10rpx;
  margin-bottom: 8rpx;
}

/* 主信息:单列展示 */
.info-list {
  margin-top: 8rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid #f2f3f5;
}

.info-row {
  display: flex;
  align-items: baseline;
  padding: 10rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}

.info-row:last-child {
  border-bottom: none;
}

.info-row .k {
  width: 160rpx;
}

.info-row .v {
  flex: 1;
  font-size: 26rpx;
}

/* 周几后缀(浅灰) */
.weekday {
  color: #86909c;
  font-size: 24rpx;
}

/* 剩发倒计时 */
.info-row .countdown {
  color: #d97706;
  font-variant-numeric: tabular-nums;
}

.info-row.overdue .v,
.v.overdue {
  color: #f53f3f;
}

/* 折叠区 */
.info-more {
  margin-top: 12rpx;
  border-top: 1rpx solid #f7f8fa;
  padding-top: 12rpx;
}

.info-more-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24rpx;
  color: #165dff;
  padding: 8rpx 0;
}

.info-more-arrow {
  margin-left: 8rpx;
  font-size: 26rpx;
  transition: transform 0.2s;
  display: inline-block;
}

.info-more-arrow.open {
  transform: rotate(90deg);
}

/* 信息网格(折叠区内部,保留双列) */
.info-grid {
  display: flex;
  flex-wrap: wrap;
  padding-top: 8rpx;
}

.info-item {
  width: 50%;
  display: flex;
  padding: 8rpx 0;
}

.info-full {
  width: 100%;
}

.k {
  font-size: 24rpx;
  color: #86909c;
  width: 140rpx;
  flex-shrink: 0;
}

.v {
  font-size: 24rpx;
  color: #1f2329;
  flex: 1;
  word-break: break-all;
}

.strong {
  font-weight: 600;
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

/* 产品行 */
.prod {
  display: flex;
  align-items: flex-start;
  padding: 14rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}

.prod:last-child {
  border-bottom: none;
}

.prod-img {
  width: 180rpx;
  height: 180rpx;
  border-radius: 12rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}

.prod-main {
  flex: 1;
  margin-left: 16rpx;
  overflow: hidden;
}

.prod-title {
  font-size: 27rpx;
  color: #1f2329;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.prod-sub {
  margin-top: 4rpx;
  font-size: 22rpx;
  color: #86909c;
}

.prod-qty {
  font-size: 26rpx;
  color: #4e5969;
  margin-left: 12rpx;
  flex-shrink: 0;
}

/* 采购关联 */
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

/* 采购单号/快递单号可交互:蓝色链接样式 */
.link {
  color: #296ef6;
  text-decoration: underline;
}

.po-sn-wrap {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

/* 复制小标签 */
.copy-tag {
  flex-shrink: 0;
  margin-left: 12rpx;
  padding: 2rpx 12rpx;
  font-size: 20rpx;
  color: #666;
  border: 1rpx solid #d5d9e0;
  border-radius: 8rpx;
  background: #f7f8fa;
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

/* 轨迹 */
.trace {
  display: flex;
  padding: 10rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}

.trace:last-child {
  border-bottom: none;
}

.trace-time {
  font-size: 21rpx;
  color: #86909c;
  font-family: 'Courier New', monospace;
  flex-shrink: 0;
  margin-right: 16rpx;
}

.trace-desc {
  font-size: 23rpx;
  color: #4e5969;
  flex: 1;
}

.trace-toggle {
  margin-top: 12rpx;
  text-align: center;
  font-size: 23rpx;
  color: #165dff;
}

/* 底部操作条 */
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
  color: #4e5969;
}

.abtn.primary[disabled] {
  color: #ffffff;
}

.empty {
  text-align: center;
  padding: 120rpx 0;
  color: #a6abb3;
  font-size: 26rpx;
}
</style>
