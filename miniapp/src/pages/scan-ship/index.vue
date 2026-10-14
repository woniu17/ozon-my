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
      <!-- #ifdef H5 -->
      <text class="scan-btn" @click="openH5Scanner">📷</text>
      <!-- #endif -->
      <!-- #ifdef MP-WEIXIN -->
      <text class="scan-btn" @click="scanCode">📷</text>
      <!-- #endif -->
    </view>
    <view class="hint">支持:Ozon单号 / 包裹号 / 物流号 / offer_id / SKU / 采购单号 / 采购物流单号</view>

    <!-- 搜索状态横幅 -->
    <view v-if="banner.text" class="banner" :class="'banner-' + banner.type">{{ banner.text }}</view>

    <!-- 结果卡片流(信息维度与 web 端 ScanShip 对齐) -->
    <view v-if="results.length" class="list">
      <view v-for="pkg in results" :key="pkg.id" class="card">
        <!-- ── 订单级信息:店铺/货件号/子件/状态/复制 ── -->
        <view class="card-head">
          <text class="store">{{ pkg.storeName }}</text>
          <text class="posting">{{ pkg.postingNumber }}</text>
          <text v-if="pkg.parentId" class="op-tag op-mute">子件</text>
          <text v-if="pkg.isIgnored" class="op-tag op-mute">搁置</text>
          <text v-else class="op-tag" :class="'op-' + opTag(pkg).cls">{{ opTag(pkg).label }}</text>
          <text class="copy-link" @click.stop="copyText(pkg.postingNumber, '货件号')">复制</text>
        </view>

        <!-- 订单标签(8色 hash 配色,同名同色) -->
        <view v-if="pkg.tags && pkg.tags.length" class="tag-row">
          <text v-for="t in pkg.tags" :key="t" class="ship-tag" :class="tagColorClass(t)">{{ t }}</text>
        </view>

        <!-- 备注(单行省略) -->
        <view v-if="pkg.note" class="order-note">备注:{{ pkg.note }}</view>

        <!-- 下单时间 / 最迟发货 / 剩余时间 -->
        <view class="order-times">
          <text>下单 {{ fmtTime(pkg.inProcessAt) }}</text>
          <template v-if="pkg.lastDeliveryAt">
            <text> · 最迟发货 {{ fmtTime(pkg.lastDeliveryAt) }}</text>
            <text class="ship-remain" :class="shipRemainCls(pkg)">{{ fmtRemain(pkg) }}</text>
          </template>
        </view>

        <!-- ── 产品信息 ── -->
        <view class="section-label">产品信息</view>
        <view v-for="(it, i) in pkg.items" :key="i" class="prod-row">
          <image v-if="it.picUrl" class="prod-img" :src="it.picUrl" mode="aspectFill" lazy-load />
          <view v-else class="prod-img"></view>
          <view class="prod-main">
            <view class="prod-title">{{ it.title || '—' }}</view>
            <view class="prod-sub">
              <text class="sku mono">SKU:{{ it.sku ?? '—' }}</text>
              <text v-if="it.sku != null" class="copy-link" @click.stop="copyText(it.sku, 'SKU')">复制</text>
            </view>
            <view class="prod-sub">
              <text class="mono">Offer ID:{{ it.offerId ?? '—' }}</text>
              <text v-if="it.offerId != null" class="copy-link" @click.stop="copyText(it.offerId, 'Offer ID')">复制</text>
            </view>
            <view class="prod-sub">
              <text>单价 {{ fmtMoney(it.price) }}</text>
              <text class="qty" :class="{ 'qty-multi': (Number(it.quantity) || 0) > 1 }">×{{ it.quantity }}</text>
            </view>
          </view>
        </view>
        <view v-if="!pkg.items?.length" class="muted small">—</view>

        <!-- ── 采购信息 ── -->
        <view class="section-label">采购信息</view>
        <view v-if="!pkg.purchaseLinks?.length" class="muted small">未录入采购信息</view>
        <view v-for="l in pkg.purchaseLinks" :key="l.id" class="purchase-block">
          <view class="purchase-line">
            <text class="platform">{{ platformLabel(l.platform) }}</text>
            <text class="mono purchase-sn">{{ l.purchaseSn || '#' + l.id }}</text>
            <text v-if="l.purchaseSn" class="copy-link" @click.stop="copyText(l.purchaseSn, '采购订单号')">复制</text>
          </view>
          <view class="purchase-line muted">采购买家:{{ l.buyerAccount || '—' }}<text v-if="poGoodsCount(l)"> · 数量 ×{{ poGoodsCount(l) }}</text></view>
          <view class="purchase-line muted">采购时间:{{ fmtTime(l.poPayAt || l.poGmtCreate) }}</view>
          <view class="purchase-line muted">采购金额:{{ fmtMoney(l.allocatedAmount) }}</view>
          <view class="purchase-line muted">
            物流:{{ logisticsLabel(l) }}
            <text v-if="l.poLogisticsNo" class="copy-link" @click.stop="copyText(l.poLogisticsNo, '快递单号')">复制</text>
          </view>
        </view>

        <!-- ── 金额与利润(公式化展示,对齐 web profit-block) ── -->
        <view class="profit-block">
          <view class="profit-head">
            <text class="profit-label">订单金额 <text class="mono strong">{{ fmtMoney(pkg.orderAmount) }}</text></text>
            <text class="est-tag" :class="profitEstimated(pkg) ? 'est-est' : 'est-real'">{{ profitEstimated(pkg) ? '估' : '实' }}</text>
            <text class="profit-final">利润 <text class="mono strong" :class="profitClass(pkg.profit?.profit)">{{ fmtMoney(pkg.profit?.profit) }}</text></text>
          </view>
          <view class="formula">{{ profitCalc(pkg).main }}</view>
          <view v-if="profitCalc(pkg).rates" class="formula sub">{{ profitCalc(pkg).rates }}</view>
        </view>

        <!-- ── 操作区 ── -->
        <view class="card-actions">
          <!-- 未备货:备货 -->
          <button
            v-if="canShipPkg(pkg)"
            class="mini-btn primary"
            :disabled="shippingPkgId === pkg.id"
            @click.stop="onShipPackage(pkg)"
          >{{ shippingPkgId === pkg.id ? '备货中…' : '备货' }}</button>

          <!-- 待打单:参考重量 + 录重量 + 提交发货 + 面单 -->
          <template v-if="canShipCard(pkg)">
            <view class="weight-refs">
              <text class="ref-weight">Ozon后台 {{ pkg.ozonWeightG != null ? Math.floor(pkg.ozonWeightG) + 'g' : '—' }}</text>
              <text class="ref-weight">本系统 {{ pkg.systemWeightG != null ? Math.floor(pkg.systemWeightG) + 'g' : '—' }}</text>
            </view>
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

          <!-- 已交运/已发货:称重 + 面单 + 更正重量 -->
          <template v-if="canReprintCard(pkg)">
            <text class="ref-weight">称重 {{ pkg.weightG != null ? Math.floor(pkg.weightG) + 'g' : '—' }}</text>
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

          <!-- 非可操作状态提示 + 称重 -->
          <view v-if="!canShipCard(pkg) && !canReprintCard(pkg) && !canShipPkg(pkg)" class="block-wrap">
            <text class="block-reason">{{ blockReason(pkg) }}</text>
            <text v-if="pkg.weightG != null" class="ref-weight">称重 {{ Math.floor(pkg.weightG) + 'g' }}</text>
          </view>
        </view>
      </view>
    </view>

    <view v-if="searching" class="empty">搜索中…</view>
    <view v-if="!searching && !results.length" class="empty">
      {{ searchedOnce ? '未找到匹配订单' : '输入单号后回车搜索' }}
    </view>

    <!-- 发货记录(今日/昨日) -->
    <view class="card records">
      <view class="rec-head">
        <view class="rec-tabs">
          <view
            v-for="t in RECORD_TABS"
            :key="t.key"
            class="rec-tab"
            :class="{ on: recordTab === t.key }"
            @click="switchRecordTab(t.key)"
          >{{ t.label }}{{ counts[t.key] != null ? `(${counts[t.key]})` : '' }}</view>
        </view>
      </view>
      <view v-if="!records.length" class="empty small">{{ recordTab === 'today' ? '今日暂无发货记录' : '昨日暂无发货记录' }}</view>
      <view v-for="r in records" :key="r.id" class="rec-row">
        <text class="rec-store">{{ r.storeName }}</text>
        <text class="rec-posting">{{ r.postingNumber }}</text>
        <text class="rec-w">{{ r.weightG != null ? Math.floor(r.weightG) + 'g' : '—' }}</text>
        <text class="rec-time">{{ fmtTime(r.waybillPrintedAt || r.createdAt) }}</text>
      </view>
    </view>

    <!-- #ifdef H5 -->
    <!-- 摄像头扫码遮罩 -->
    <view v-if="scanVisible" class="scan-mask">
      <view class="scan-header">
        <text class="scan-title">扫描面单条码</text>
        <text class="scan-close" @click="closeH5Scanner">✕</text>
      </view>
      <view id="scan-reader" class="scan-reader" :class="{ 'native-frame': barcodeDetectorSupported }"></view>
      <view class="scan-engine" :class="{ ok: barcodeDetectorSupported }">
        识别引擎: {{ barcodeDetectorSupported ? 'BarcodeDetector 原生解码' : 'ZXing 兼容解码(不支持BarcodeDetector)' }}
      </view>
      <view class="scan-tip">将快递单号 / 面单条码放入框内，自动识别并搜索</view>
    </view>
    <!-- #endif -->
  </view>
</template>

<script setup>
import { ref, reactive, nextTick } from 'vue';
import { onLoad, onPullDownRefresh, onUnload } from '@dcloudio/uni-app';
import {
  getOrderList, shipPackage, scanShipSubmit, correctShipWeight, getScanShipRecords, fetchPackageLabel, markPrinted,
} from '../../api/order.js';
import { fmtMoney, fmtTime, fmtRate } from '../../utils/fmt.js';
// #ifdef H5
import { Html5Qrcode } from 'html5-qrcode';
// #endif

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
// 发货记录(今日/昨日切换,与 web 端 RECORD_TABS 同口径)
const RECORD_TABS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
];
const recordTab = ref('today');
const counts = reactive({ today: 0, yesterday: 0 });

// ── 扫码识别(快递单号/面单条码) ──
// #ifdef H5
// H5 扫码:
//  - 优先用浏览器原生 BarcodeDetector(Chrome/安卓):直接在 video 元素上异步检测,
//    不经过 ZXing 主线程逐帧解码,避免开启几秒后画面卡顿;
//  - 不支持时回退 html5-qrcode(ZXing):降低分辨率/fps/禁用镜像二次解码,减轻 CPU。
const scanVisible = ref(false);
let scanSession = 0;                  // 会话代际:关闭/重开都会自增,使旧会话的异步回调全部失效
let h5Qr = null;                      // html5-qrcode 实例(ZXing 回退路径)
let h5QrCleanup = Promise.resolve(); // 上一次实例 stop+clear 的完成态,防止重开时旧 clear() 清掉新实例
let nativeStream = null;              // 原生 BarcodeDetector 路径的 MediaStream
let nativeVideo = null;               // 原生路径创建的 video 元素
let nativeTimer = null;               // 原生路径检测循环句柄

// 浏览器是否真正支持 BarcodeDetector(属性存在且可实例化,避免桌面 Chrome 仅有属性但不可用)
function detectBarcodeDetectorSupport() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return false;
  try {
    const d = new BarcodeDetector({ formats: ['qr_code'] });
    return !!d;
  } catch (e) {
    return false;
  }
}
const barcodeDetectorSupported = detectBarcodeDetectorSupport();

function openH5Scanner() {
  scanVisible.value = true;
  const session = ++scanSession;
  nextTick(async () => {
    if (session !== scanSession) return; // 打开瞬间已被关闭/重开
    try {
      if (barcodeDetectorSupported) {
        await startNativeScanner(session);
      } else {
        await startHtml5QrScanner(session);
      }
    } catch (e) {
      if (session !== scanSession) return;
      uni.showToast({ title: '摄像头不可用(需HTTPS)', icon: 'none' });
      closeH5Scanner();
    }
  });
}

// ── 原生 BarcodeDetector 路径:轻量、不卡顿 ──
async function startNativeScanner(session) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 640, max: 640 },
      height: { ideal: 480, max: 480 },
      frameRate: { ideal: 15 },
    },
    audio: false,
  });
  if (session !== scanSession) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  nativeStream = stream;
  const reader = document.getElementById('scan-reader');
  const el = document.createElement('video');
  el.id = 'scan-native-video';
  el.setAttribute('playsinline', '');
  el.muted = true;
  el.autoplay = true;
  el.srcObject = stream;
  reader.innerHTML = '';
  reader.appendChild(el);
  nativeVideo = el;
  await el.play();
  if (session !== scanSession) return; // 播放期间被关闭
  const detector = new BarcodeDetector();
  const tick = async () => {
    if (session !== scanSession) return;
    if (!nativeVideo || nativeVideo.readyState < 2) {
      nativeTimer = setTimeout(tick, 200);
      return;
    }
    let codes = null;
    try {
      codes = await detector.detect(nativeVideo);
    } catch (e) { /* 单帧识别失败忽略 */ }
    if (session !== scanSession) return; // 检测期间被关闭/重开,丢弃旧结果
    if (codes && codes.length) {
      const code = String(codes[0].rawValue || '').trim();
      if (code) {
        onScanned(code);
        return;
      }
    }
    nativeTimer = setTimeout(tick, 200);
  };
  nativeTimer = setTimeout(tick, 100);
}

// ── 不支持 BarcodeDetector 时回退 html5-qrcode(ZXing)──
async function startHtml5QrScanner(session) {
  // 等待上一次实例彻底清理完毕,避免旧 clear() 清掉新实例的 video 元素
  await h5QrCleanup;
  if (session !== scanSession) return;
  if (!h5Qr) {
    h5Qr = new Html5Qrcode('scan-reader', {
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: false,
      },
    });
  }
  await h5Qr.start(
    { facingMode: 'environment' },
    {
      // 纯 ZXing 主线程解码:低 fps + 小解码区 + 低分辨率 + 禁用镜像二次解码,避免 CPU 满载卡顿
      fps: 3,
      qrbox: { width: '60%', height: '35%' },
      disableFlip: true,
      videoConstraints: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 480, max: 480 },
        height: { ideal: 360, max: 360 },
        frameRate: { ideal: 10 },
      },
    },
    (decodedText) => {
      // 旧实例的残留回调:会话已失效或已关闭,直接忽略,防止重开时误填入结果
      if (session !== scanSession) return;
      if (!scanVisible.value) return;
      const code = (decodedText || '').trim();
      if (!code) return;
      onScanned(code);
    },
    () => { /* 每帧未识别,忽略 */ }
  );
}

// 识别成功后统一收尾:关闭遮罩 + 填入关键词 + 搜索
function onScanned(code) {
  closeH5Scanner();
  keyword.value = code;
  doSearch();
}

function closeH5Scanner() {
  scanSession++; // 使当前会话所有在途回调/循环全部失效
  scanVisible.value = false;
  // 清理原生 BarcodeDetector 路径
  if (nativeTimer) {
    clearTimeout(nativeTimer);
    nativeTimer = null;
  }
  if (nativeStream) {
    try { nativeStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* 忽略 */ }
    nativeStream = null;
  }
  if (nativeVideo) {
    try { nativeVideo.srcObject = null; } catch (e) { /* 忽略 */ }
    try { nativeVideo.remove(); } catch (e) { /* 忽略 */ }
    nativeVideo = null;
  }
  // 清理 html5-qrcode 路径
  const qr = h5Qr;
  h5Qr = null;
  if (qr) {
    try {
      if (qr.isRunning()) {
        h5QrCleanup = qr.stop()
          .then(() => { try { qr.clear(); } catch (e) { /* 忽略 */ } })
          .catch(() => { /* 忽略 */ });
      } else {
        try { qr.clear(); } catch (e) { /* 忽略 */ }
        h5QrCleanup = Promise.resolve();
      }
    } catch (e) { /* 忽略 */ h5QrCleanup = Promise.resolve(); }
  } else {
    h5QrCleanup = Promise.resolve();
  }
}
onUnload(() => closeH5Scanner());
// #endif

// #ifdef MP-WEIXIN
// 微信小程序:调起微信原生扫码(二维码/一维码)
function scanCode() {
  uni.scanCode({
    scanType: ['barCode', 'qrCode'],
    success: (res) => {
      const code = (res.result || '').trim();
      if (!code) return;
      keyword.value = code;
      doSearch();
    },
    fail: () => { /* 用户取消或失败,忽略 */ },
  });
}
// #endif

// ── 与 web 端 ScanShip 同口径的展示辅助 ──
const OPERATE_LABELS = {
  wait_process: { label: '待处理', cls: 'warn' },
  wait_ship: { label: '待打单发货', cls: 'info' },
  ship_success: { label: '交运', cls: 'info' },
  wait_receiver_confirm: { label: '已发货', cls: 'ok' },
  cancelled: { label: '已取消', cls: 'err' },
};
const PLATFORMS = [
  { value: 'other', label: '手工(其他)' },
  { value: '1688', label: '1688' },
  { value: 'yangkeduo', label: '拼多多' },
  { value: 'taobao', label: '淘宝' },
];

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

// 复制(货件号/SKU/OfferID/采购单号/快递单号)
function copyText(val, label) {
  if (val == null || val === '') return;
  uni.setClipboardData({
    data: String(val),
    success: () => uni.showToast({ title: `${label}已复制`, icon: 'none' }),
  });
}

// 标签配色(与 web 端同 hash 口径:同名永远同色)
function tagColorClass(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'tag-c' + (h % 8);
}
function platformLabel(p) {
  return PLATFORMS.find((x) => x.value === p)?.label || p || '—';
}
// 采购商品数量合计(items_json 各商品 number 求和)
function poGoodsCount(l) {
  return (l.items || []).reduce((s, i) => s + Number(i.number || i.num || 1), 0);
}
function logisticsLabel(l) {
  if (!l.poLogisticsNo) return '—';
  return `${l.poLogisticsCompany || ''} ${l.poLogisticsNo}`.trim();
}

// ── 利润展示(对齐 web profit-block;数据源 /list 注入 pkg.profit)──
function profitEstimated(pkg) {
  return pkg.profit ? pkg.profit.estimated !== false : true;
}
function profitCalc(pkg) {
  const n2 = (n) => (n == null ? '—' : Number(n).toFixed(2));
  const p = pkg.profit;
  const orderAmount = Number(pkg.orderAmount) || 0;
  const purchase = Number(pkg.totalPurchaseAmount) || 0;
  if (!p) return { estimated: true, main: '利润:—(无计算数据)', rates: null };
  const saleRate = orderAmount > 0
    ? `销售利润率 = ${n2(p.profit)} ÷ ${n2(orderAmount)} = ${fmtRate(p.profitRateSale)}`
    : '销售利润率 = —(无订单金额)';
  const costRate = purchase > 0
    ? `成本利润率 = ${n2(p.profit)} ÷ ${n2(purchase)} = ${fmtRate(p.profitRateCost)}`
    : '成本利润率 = —(无采购金额)';
  if (p.estimated === false) {
    return {
      estimated: false,
      main: `利润(实) = 打款 ${n2(p.escrow)} − 采购 ${n2(purchase)} = ${fmtMoney(p.profit)}`,
      rates: `${saleRate} · ${costRate}`,
    };
  }
  if (p.cancelled) {
    return { estimated: true, main: `利润 = −采购 ${n2(purchase)} = ${fmtMoney(p.profit)}(已取消,无销售收入)`, rates: null };
  }
  if (p.returned) {
    return { estimated: true, main: `利润 = −采购 ${n2(purchase)} = ${fmtMoney(p.profit)}(已退货,货款被全额扣回)`, rates: null };
  }
  if (p.delivery != null) {
    return {
      estimated: true,
      main: `利润(估) = 订单 ${n2(orderAmount)} − 佣金 ${n2(p.commission)}(订单×16%) − 国际配送 ${n2(p.delivery)}(3.37+0.0281×${Math.floor(p.weightG ?? 0)}g) − 采购 ${n2(purchase)} = ${fmtMoney(p.profit)}`,
      rates: `${saleRate} · ${costRate}`,
    };
  }
  return {
    estimated: true,
    main: `利润(估) = 订单 ${n2(orderAmount)} − 佣金 ${n2(p.commission)}(订单×16%,配送隐含) − 采购 ${n2(purchase)} = ${fmtMoney(p.profit)}(无重量,配送未单独估算)`,
    rates: `${saleRate} · ${costRate}`,
  };
}

// 打印发货/更正重量后,按新重量本地重算利润(预估口径,公式与后端 computeProfit 一致)
// 真实应计口径(estimated=false)/已取消/已退货的利润不随重量变化,不重算
const EST_COMMISSION_RATE = 0.16;   // 预估佣金率(对齐后端 DEFAULT_COMMISSION_RATE)
const DELIVERY_BASE_CNY = 3.37;     // 国际配送费公式(对齐后端)
const DELIVERY_PER_G_CNY = 0.0281;
function recomputeProfitByWeight(pkg, g) {
  const p = pkg.profit;
  if (!p || p.estimated === false || p.cancelled || p.returned) return;
  const orderAmount = Number(pkg.orderAmount) || 0;
  const purchase = Number(pkg.totalPurchaseAmount) || 0;
  const round2 = (n) => Math.round(n * 100) / 100;
  const commission = round2(orderAmount * EST_COMMISSION_RATE);
  const delivery = round2(DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * g);
  const escrow = round2(orderAmount - commission - delivery);
  const profit = round2(escrow - purchase);
  p.commission = commission;
  p.delivery = delivery;
  p.escrow = escrow;
  p.profit = profit;
  p.weightG = g;
  p.profitRateSale = orderAmount > 0 ? Math.round((profit / orderAmount) * 10000) / 100 : null;
  p.profitRateCost = purchase > 0 ? Math.round((profit / purchase) * 10000) / 100 : null;
}

// 最迟发货剩余时间(颜色分级:已超时=红 / <24h=红 / <48h=橙)
function shipRemainCls(pkg) {
  if (!pkg.lastDeliveryAt) return '';
  const t = new Date(pkg.lastDeliveryAt).getTime();
  if (isNaN(t)) return '';
  const ms = t - Date.now();
  if (ms <= 0) return 'remain-over';
  if (ms < 24 * 3600 * 1000) return 'remain-urg';
  if (ms < 48 * 3600 * 1000) return 'remain-warn';
  return '';
}
function fmtRemain(pkg) {
  if (!pkg.lastDeliveryAt) return '';
  const t = new Date(pkg.lastDeliveryAt).getTime();
  if (isNaN(t)) return '';
  const diff = t - Date.now();
  const neg = diff < 0;
  let s = Math.floor(Math.abs(diff) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  const body = d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : `${m}分`;
  return neg ? `已超时${body}` : `剩${body}`;
}

// ── 搜索与操作 ──
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
    // 打印发货后按称重重量重算利润(预估口径,国际配送费随重量变化)
    recomputeProfitByWeight(pkg, g);
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
    // 更正重量后本地重算利润(预估口径,国际配送费随重量变化)
    recomputeProfitByWeight(pkg, g);
    correctWeights[pkg.id] = '';
    uni.showToast({ title: '重量已更正', icon: 'none' });
  } catch (e) {
    /* request.js 已 toast */
  } finally {
    correcting.value = 0;
  }
}

async function loadRecords() {
  const day = recordTab.value;
  try {
    // 注意:后端返回字段是 packages(非 records),与 /list 同源
    const data = await getScanShipRecords({ day, page: 1, pageSize: 8 });
    records.value = data?.packages || [];
    counts[day] = data?.total || 0;
  } catch (e) {
    records.value = [];
  }
  // 静默补另一个 tab 的数量(仅取 total)
  const other = day === 'today' ? 'yesterday' : 'today';
  try {
    const d2 = await getScanShipRecords({ day: other, page: 1, pageSize: 1 });
    counts[other] = d2?.total || 0;
  } catch (e) {
    /* 静默 */
  }
}
function switchRecordTab(tab) {
  if (recordTab.value === tab) return;
  recordTab.value = tab;
  loadRecords();
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
.scan-btn {
  font-size: 34rpx;
  padding: 4rpx 8rpx;
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

/* ── 订单级信息 ── */
.card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 8rpx;
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
  font-size: 21rpx;
  padding: 3rpx 12rpx;
  border-radius: 999rpx;
  margin-right: 8rpx;
}
.op-warn { color: #d97706; background: #fff7e6; }
.op-info { color: #165dff; background: #eef4ff; }
.op-ok { color: #00b42a; background: #e8ffea; }
.op-err { color: #f53f3f; background: #ffece8; }
.op-mute { color: #86909c; background: #f2f3f5; }
.copy-link {
  font-size: 21rpx;
  color: #165dff;
  padding: 2rpx 8rpx;
  margin-left: 6rpx;
}

/* 订单标签(8 色 hash) */
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8rpx;
  margin-bottom: 8rpx;
}
.ship-tag {
  font-size: 20rpx;
  padding: 2rpx 12rpx;
  border-radius: 999rpx;
}
.tag-c0 { color: #165dff; background: #eef4ff; }
.tag-c1 { color: #00b42a; background: #e8ffea; }
.tag-c2 { color: #d97706; background: #fff7e6; }
.tag-c3 { color: #f53f3f; background: #ffece8; }
.tag-c4 { color: #7d4dd3; background: #f5efff; }
.tag-c5 { color: #0fc6c2; background: #e6fffe; }
.tag-c6 { color: #b8860b; background: #fffbe6; }
.tag-c7 { color: #86909c; background: #f2f3f5; }

.order-note {
  font-size: 22rpx;
  color: #4e5969;
  background: #f7f8fa;
  border-radius: 8rpx;
  padding: 8rpx 12rpx;
  margin-bottom: 8rpx;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.order-times {
  font-size: 21rpx;
  color: #86909c;
  margin-bottom: 12rpx;
  flex-wrap: wrap;
}
.ship-remain {
  margin-left: 8rpx;
  font-weight: 600;
}
.remain-over { color: #f53f3f; }
.remain-urg { color: #f53f3f; }
.remain-warn { color: #d97706; }

/* ── 分区小标题 ── */
.section-label {
  display: flex;
  align-items: center;
  font-size: 22rpx;
  color: #86909c;
  font-weight: 600;
  margin: 14rpx 0 8rpx;
}
.section-label::before {
  content: '';
  width: 6rpx;
  height: 22rpx;
  border-radius: 3rpx;
  background: #165dff;
  margin-right: 10rpx;
}

/* ── 产品信息 ── */
.prod-row {
  display: flex;
  align-items: flex-start;
  padding: 10rpx 0;
  border-bottom: 1rpx solid #f7f8fa;
}
.prod-row:last-child {
  border-bottom: none;
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
  font-size: 24rpx;
  color: #1f2329;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.prod-sub {
  margin-top: 4rpx;
  display: flex;
  align-items: center;
  font-size: 21rpx;
  color: #86909c;
  flex-wrap: wrap;
}
.sku {
  color: #165dff;
}
.mono {
  font-family: 'Courier New', monospace;
}
.qty {
  margin-left: 10rpx;
  font-weight: 600;
}
.qty-multi {
  color: #d93026;
  font-weight: 700;
}

/* ── 采购信息 ── */
.purchase-block {
  background: #f7f8fa;
  border-radius: 10rpx;
  padding: 10rpx 14rpx;
  margin-bottom: 10rpx;
}
.purchase-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  font-size: 21rpx;
  color: #4e5969;
  padding: 2rpx 0;
}
.purchase-line.muted {
  color: #86909c;
}
.platform {
  font-size: 20rpx;
  color: #165dff;
  background: #eef4ff;
  border-radius: 6rpx;
  padding: 0 8rpx;
  margin-right: 8rpx;
}
.purchase-sn {
  color: #1f2329;
  margin-right: auto;
}
.muted.small {
  font-size: 22rpx;
  color: #86909c;
}

/* ── 金额与利润 ── */
.profit-block {
  margin-top: 14rpx;
  background: #f5f8ff;
  border-radius: 12rpx;
  padding: 14rpx 16rpx;
}
.profit-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  font-size: 23rpx;
  color: #4e5969;
}
.profit-label {
  margin-right: 10rpx;
}
.strong {
  font-weight: 700;
  color: #1f2329;
}
.est-tag {
  font-size: 19rpx;
  padding: 2rpx 10rpx;
  border-radius: 6rpx;
  margin-right: 10rpx;
}
.est-est { color: #d97706; background: #fff7e6; }
.est-real { color: #00b42a; background: #e8ffea; }
.profit-final {
  margin-left: auto;
}
.formula {
  margin-top: 6rpx;
  font-size: 20rpx;
  color: #4e5969;
  font-family: 'Courier New', monospace;
  line-height: 1.5;
  word-break: break-all;
}
.formula.sub {
  color: #86909c;
}
.profit-pos { color: #00b42a !important; }
.profit-neg { color: #f53f3f !important; }

/* ── 操作区 ── */
.card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12rpx;
  margin-top: 14rpx;
}
.weight-refs {
  width: 100%;
  display: flex;
  gap: 16rpx;
  font-size: 21rpx;
  color: #86909c;
}
.ref-weight {
  font-size: 21rpx;
  color: #86909c;
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
.block-wrap {
  display: flex;
  align-items: center;
  gap: 16rpx;
}
.block-reason {
  font-size: 23rpx;
  color: #86909c;
}

/* ── 发货记录 ── */
.records {
  margin-top: 4rpx;
}
.rec-head {
  margin-bottom: 8rpx;
}
.rec-tabs {
  display: flex;
  gap: 12rpx;
}
.rec-tab {
  font-size: 23rpx;
  color: #4e5969;
  background: #f2f3f5;
  border-radius: 999rpx;
  padding: 6rpx 20rpx;
}
.rec-tab.on {
  color: #ffffff;
  background: #165dff;
  font-weight: 600;
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
  font-size: 22rpx;
}
.rec-row:last-child {
  border-bottom: none;
}
.rec-store {
  font-size: 20rpx;
  color: #165dff;
  background: #eef4ff;
  border-radius: 6rpx;
  padding: 0 8rpx;
  margin-right: 10rpx;
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
  font-size: 20rpx;
}

.empty {
  text-align: center;
  padding: 80rpx 0;
  color: #a6abb3;
  font-size: 26rpx;
}
.empty.small {
  padding: 30rpx 0;
  font-size: 23rpx;
}
/* ── H5 摄像头扫码遮罩 ── */
.scan-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: #000;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.scan-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24rpx 36rpx;
  box-sizing: border-box;
}
.scan-title {
  color: #ffffff;
  font-size: 30rpx;
  font-weight: 600;
}
.scan-close {
  color: #ffffff;
  font-size: 44rpx;
  padding: 8rpx 20rpx;
}
.scan-reader {
  width: 100%;
  max-width: 640rpx;
  height: 640rpx;
  margin-top: 100rpx;
  overflow: hidden;
  position: relative;
}
.scan-reader video {
  width: 100%;
  height: 100%;
  border-radius: 16rpx;
  object-fit: cover;
}
/* 原生 BarcodeDetector 路径的取景框(html5-qrcode 路径自带遮罩,不重复渲染) */
.scan-reader.native-frame::after {
  content: '';
  position: absolute;
  left: 15%;
  right: 15%;
  top: 30%;
  bottom: 30%;
  border: 4rpx solid rgba(255, 255, 255, 0.85);
  border-radius: 12rpx;
  box-shadow: 0 0 0 9999rpx rgba(0, 0, 0, 0.18);
  pointer-events: none;
  z-index: 2;
}
.scan-engine {
  margin-top: 28rpx;
  font-size: 22rpx;
  color: #ffa940;
  text-align: center;
  padding: 0 60rpx;
}
.scan-engine.ok {
  color: #52c41a;
}
.scan-tip {
  color: #cccccc;
  font-size: 24rpx;
  margin-top: 20rpx;
  text-align: center;
  padding: 0 60rpx;
}
</style>