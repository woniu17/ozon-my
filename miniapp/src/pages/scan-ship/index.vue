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

    <!-- 扫描入库模式工具栏(2026-11):连扫暂停/继续 + 本次入库计数 -->
    <view v-if="stockMode" class="stock-bar">
      <text class="stock-mode-tag">扫描入库模式</text>
      <text class="stock-pause-btn" @click="toggleStockPause">{{ stockPaused ? '▶ 继续连扫' : '⏸ 暂停连扫' }}</text>
      <text class="stock-count">本次入库 {{ stockRecords.length }} · 扫{{ scanStats.total }}/成{{ scanStats.ok }}/重{{ scanStats.dup }}/败{{ scanStats.fail }}</text>
    </view>

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
          <!-- 未入库:入库 -->
          <button
            v-if="canShipPkg(pkg)"
            class="mini-btn primary"
            :disabled="shippingPkgId === pkg.id"
            @click.stop="onShipPackage(pkg)"
          >{{ shippingPkgId === pkg.id ? '入库中…' : '入库' }}</button>

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

    <!-- 本次入库记录(2026-11,仅扫描入库模式):商品首图 + 单号 + 状态;连扫去重不重复添加 -->
    <view v-if="stockMode" class="card records">
      <view class="rec-head">
        <text class="rec-title">本次入库记录({{ stockRecords.length }})</text>
      </view>
      <view v-if="!stockRecords.length" class="empty small">扫到待入库订单自动入库(可点视频区暂停连扫)</view>
      <view v-for="(r, i) in stockRecords" :key="i" class="rec-row stock-rec">
        <image v-if="r.thumbUrl" class="stock-rec-img" :src="r.thumbUrl" mode="aspectFill" lazy-load />
        <view v-else class="stock-rec-img"></view>
        <view class="stock-rec-main">
          <text class="rec-posting">{{ r.postingNumber }}</text>
          <text class="stock-rec-title">{{ r.title }}</text>
        </view>
        <text class="stock-rec-status" :class="'st-' + r.status">{{ r.status === 'ok' ? '已入库' : (r.status === 'pending' ? '指令已提交' : (r.status === 'fail' ? '失败' : r.status)) }}</text>
      </view>
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
      <view id="scan-reader" class="scan-reader" :class="{ 'native-frame': barcodeDetectorSupported }" @click="toggleStockPause"></view>
      <view class="scan-engine" :class="{ ok: scanEngineText.indexOf('BarcodeDetector') === 0 }" @click="onEngineTap">
        识别引擎: {{ scanEngineText || '启动中...' }}
      </view>
      <view class="scan-tip">将快递单号 / 面单条码放入框内，自动识别并搜索</view>
      <!-- #region debug-point scan-cam-freeze (临时诊断插桩) -->
      <view v-if="dbgOn" class="dbg-overlay"><text>{{ dbgText }}</text></view>
      <!-- #endregion -->
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

// ── 独立扫描入库模式(2026-11,对齐 Web /scan-stock 与安卓 StockScanFragment)──
// 通过 URL 参数 mode=stock 进入:扫到待入库订单自动入库(连扫),2s 内同码去重,
// 本次入库记录展示商品首图;已入库订单连扫不重复添加记录。
const stockMode = ref(false);
const stockPaused = ref(false);   // 暂停自动连扫(避免误扫)
const stockBusy = ref(false);     // 连扫处理中,防止并发
const stockRecords = ref([]);     // 本次会话入库记录(新在前)
const lastStockAt = reactive({}); // postingNumber → 最近处理时间戳(2s 去重)
// 扫描统计(2026-11,对齐安卓 baa6502):本次会话 扫描总数/成功/重复/失败
const scanStats = reactive({ total: 0, ok: 0, dup: 0, fail: 0 });
// 单号格式预检(宽松版,适配通用搜索):长度≥4 且仅含数字/字母/常见连接符
function validateScanKeyword(kw) {
  if (kw.length < 4) return '单号过短,请确认扫描完整';
  if (!/^[0-9A-Za-z\-_/]{4,}$/.test(kw)) return '单号含非法字符,请检查';
  return '';
}
function addStockRecord(pkg, status) {
  const first = (pkg.items || [])[0];
  stockRecords.value.unshift({
    postingNumber: pkg.postingNumber || '',
    thumbUrl: first?.picUrl || first?.thumbUrl || '',
    title: first?.title || '',
    status,
    time: Date.now(),
  });
  if (stockRecords.value.length > 50) stockRecords.value.pop();
}
function toggleStockPause() {
  if (!stockMode.value) return;
  stockPaused.value = !stockPaused.value;
  uni.showToast({ title: stockPaused.value ? '连扫已暂停' : '连扫已继续', icon: 'none' });
}
// 连扫:对待入库订单逐个自动入库(多件/搁置弹窗确认期间自然等待);已入库过不重复记录
async function autoStockScan(pkgs) {
  for (const p of pkgs || []) {
    if (stockPaused.value) return;
    if (!canShipPkg(p)) continue;
    const now = Date.now();
    const prev = lastStockAt[p.postingNumber] || 0;
    if (now - prev < 2000) {
      scanStats.dup++;
      continue;
    }
    lastStockAt[p.postingNumber] = now;
    const st = await onShipPackage(p);
    if (st === 'ok' || st === 'pending') {
      scanStats.ok++;
      addStockRecord(p, st);
    } else if (st === 'fail') {
      scanStats.fail++;
    }
    // 'already'/'fail' 不重复添加记录(已入库过仅 toast 提示)
  }
}

// ── 扫码识别(快递单号/面单条码) ──
// #ifdef H5
// H5 扫码:
//  - 优先用浏览器原生 BarcodeDetector(Chrome/安卓):小画布异步检测,轻量不占主线程;
//    开摄像头前先做能力探测(部分浏览器如小米浏览器 detect() 实际不可用,直接降级);
//  - ZXing(html5-qrcode)兜底:低分辨率/低 fps/禁用镜像二次解码;
//  - 两条路径都监听 track ended(部分浏览器/系统约 30s 终止摄像头轨道),
//    事件驱动立即重建流,避免画面冻结;ZXing 另保留 2 分钟定时重启兜底。
const scanVisible = ref(false);
const scanEngineText = ref('');          // 实际运行中的识别引擎(打开时确定,降级时更新)
let scanSession = 0;                  // 会话代际:关闭/重开都会自增,使旧会话的异步回调全部失效
let h5Qr = null;                      // html5-qrcode 实例(ZXing 回退路径)
let h5QrCleanup = Promise.resolve(); // 上一次实例 stop+clear 的完成态,防止重开时旧 clear() 清掉新实例
let h5RestartTimer = null;           // html5-qrcode 路径的定期重启定时器
let nativeStream = null;              // 原生 BarcodeDetector 路径的 MediaStream
let nativeVideo = null;               // 原生路径创建的 video 元素
let nativeTimer = null;               // 原生路径检测循环句柄
let nativeDetectFails = 0;            // 原生 detect 连续失败次数,>=5 自动降级 ZXing
let nativeDetectorBroken = false;     // 探测/运行期确认 detect() 不可用,本页面内不再走原生路径
const CAMERA_RESTART_MS = 2 * 60 * 1000; // ZXing 兜底路径的定期重启间隔

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

// #region debug-point scan-cam-freeze (临时诊断插桩:采集摄像头预览长时间运行后卡顿的运行时证据;定位后整体移除)
// 使用:三击遮罩内"识别引擎"行开关屏上诊断(localStorage 记忆);每 2s 采样一次,
// 每 ~30s 部分上报,关闭扫码/页面隐藏时终报(同源 /debug/scan-perf,防页面硬挂丢证据)
const dbgOn = ref(false);
const dbgText = ref('');
const dbgState = { t0: 0, wall: 0, seq: 0, rvfc: 0, restarts: 0, det: [], samples: [], events: [], active: false };
let dbgTimer = null;
try { dbgOn.value = localStorage.getItem('scandbg') === '1'; } catch (e) { /* 忽略 */ }
function dbgLog(ev) {
  dbgState.events.push({ t: Math.round((Date.now() - dbgState.t0) / 1000), ev });
  if (dbgState.events.length > 120) dbgState.events.shift();
}
function dbgVideo() {
  return nativeVideo || (typeof document !== 'undefined' && document.querySelector('#scan-reader video')) || null;
}
// 采样器:每 2s 记录预览健康度并在 overlay 上给出实时判定
//   rvfc = requestVideoFrameCallback 累计已呈现帧(元素渲染层);tf = totalVideoFrames(解码/轨道层)
//   rvfcΔ=0 且 tfΔ>0 → 渲染停滞(H1 元素级);tfΔ=0 且 rvfcΔ=0 → 轨道停滞(H3 摄像头级);
//   dt 异常增大 → 主线程阻塞(H2);heap 单调涨 → 内存泄漏(H2)。
function startDbgSampler(session) {
  stopDbgSampler();
  dbgState.wall = Date.now();
  dbgTimer = setInterval(() => {
    if (session !== scanSession) { stopDbgSampler(); return; }
    const v = dbgVideo();
    if (!v) return;
    const now = Date.now();
    const dt = Math.round((now - dbgState.wall) / 1000);
    dbgState.wall = now;
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    const track = nativeStream && nativeStream.getVideoTracks ? nativeStream.getVideoTracks()[0] : null;
    const s = {
      t: Math.round((now - dbgState.t0) / 1000), dt, vis: document.hidden ? 1 : 0,
      rdy: v.readyState,
      tf: q ? q.totalVideoFrames : -1, df: q ? q.droppedVideoFrames : -1,
      rvfc: dbgState.rvfc,
      heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
      trk: track && track.getSettings ? Math.round(track.getSettings().frameRate || 0) : -1,
      det: dbgState.det.length ? Math.round(dbgState.det.reduce((a, b) => a + b, 0) / dbgState.det.length) : -1,
      detMax: dbgState.det.length ? Math.max(...dbgState.det) : -1,
      rst: dbgState.restarts,
    };
    const prev = dbgState.samples[dbgState.samples.length - 1];
    const tfD = prev && s.tf >= 0 && prev.tf >= 0 ? s.tf - prev.tf : null;
    const rvD = prev ? s.rvfc - prev.rvfc : null;
    dbgState.samples.push(s);
    if (dbgState.samples.length > 600) dbgState.samples.shift();
    let verdict = '正常';
    if (s.rdy < 2) verdict = '流切换中(忽略)';
    else if (s.vis) verdict = '后台(节流,忽略)';
    else if (dt >= 4) verdict = '采样停滞→主线程阻塞嫌疑(H2)';
    else if (tfD === 0 && rvD === 0) verdict = '轨道停滞→摄像头级(H3)';
    else if (rvD === 0 && tfD > 0) verdict = '渲染停滞→video元素级(H1)';
    dbgText.value = `t=${s.t}s dt=${dt} rdy=${s.rdy} tf=${s.tf}(+${tfD === null ? '-' : tfD}) df=${s.df} rvfc=${s.rvfc}(+${rvD === null ? '-' : rvD}) trk=${s.trk} heap=${s.heap}MB det=${s.det}/${s.detMax}ms rst=${s.rst}\n判定: ${verdict}`;
    if (dbgOn.value && dbgState.samples.length % 15 === 1) dbgPost(false);
  }, 2000);
}
function stopDbgSampler() {
  if (dbgTimer) { clearInterval(dbgTimer); dbgTimer = null; }
}
function dbgPost(final) {
  if (!dbgState.samples.length) return;
  const payload = {
    final: !!final, seq: ++dbgState.seq, ua: navigator.userAgent,
    samples: dbgState.samples.slice(-400), events: dbgState.events.slice(-80),
  };
  try {
    fetch('/debug/scan-perf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}
// 三击"识别引擎"开关诊断 overlay
let dbgEngTaps = 0;
let dbgEngAt = 0;
function onEngineTap() {
  const now = Date.now();
  if (now - dbgEngAt > 1500) dbgEngTaps = 0;
  dbgEngAt = now;
  dbgEngTaps++;
  if (dbgEngTaps >= 3) {
    dbgEngTaps = 0;
    dbgOn.value = !dbgOn.value;
    try { localStorage.setItem('scandbg', dbgOn.value ? '1' : '0'); } catch (e) { /* 忽略 */ }
    uni.showToast({ title: dbgOn.value ? '诊断已开启(冻结时截图此区域)' : '诊断已关闭', icon: 'none' });
    dbgText.value = '采集中...';
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { if (dbgState.samples.length) dbgPost(true); });
}
// #endregion

// 摄像头约束(低分辨率 + 低帧率,降低编码/解码开销)
function cameraVideoConstraints() {
  return {
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 640, max: 640 },
      height: { ideal: 480, max: 480 },
      frameRate: { ideal: 15 },
    },
    audio: false,
  };
}

// BarcodeDetector 功能探测:部分浏览器(如小米浏览器)属性与构造器都可用,但 detect()
// 实际持续抛异常或挂起。开摄像头前用空白画布探测一次(含超时,防挂起),失败则本页面内
// 记为不可用,后续打开直接走 ZXing,避免原生路径空转与摄像头开关两次。
async function probeBarcodeDetector() {
  try {
    const d = new BarcodeDetector({ formats: ['qr_code'] });
    const probe = document.createElement('canvas');
    probe.width = 64;
    probe.height = 64;
    await Promise.race([
      d.detect(probe),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe-timeout')), 800)),
    ]);
    return true;
  } catch (e) {
    return false;
  }
}

function openH5Scanner() {
  scanVisible.value = true;
  const session = ++scanSession;
  nextTick(async () => {
    if (session !== scanSession) return; // 打开瞬间已被关闭/重开
    try {
      // #region debug-point scan-cam-freeze
      dbgState.active = true;
      dbgState.t0 = Date.now(); dbgState.wall = Date.now();
      dbgState.rvfc = 0; dbgState.restarts = 0; dbgState.seq = 0;
      dbgState.det.length = 0; dbgState.samples.length = 0; dbgState.events.length = 0;
      // #endregion
      let useNative = barcodeDetectorSupported && !nativeDetectorBroken;
      if (useNative) {
        useNative = await probeBarcodeDetector();
        if (!useNative) {
          nativeDetectorBroken = true;
          // #region debug-point scan-cam-freeze
          dbgLog('probe-fail → zxing');
          // #endregion
        }
      }
      scanEngineText.value = useNative
        ? 'BarcodeDetector 原生解码'
        : `ZXing 兼容解码${nativeDetectorBroken ? '(检测器不可用,已自动降级)' : '(不支持BarcodeDetector)'}`;
      if (useNative) {
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

// 清理原生 BarcodeDetector 路径资源(供降级/关闭复用;不改变 scanVisible/scanSession)
function cleanupNativeScanner() {
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
}

// ── 原生 BarcodeDetector 路径:轻量、不卡顿 ──
async function startNativeScanner(session) {
  const stream = await navigator.mediaDevices.getUserMedia(cameraVideoConstraints());
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
  // #region debug-point scan-cam-freeze
  if (!dbgState.active) {
    dbgState.active = true;
    dbgState.t0 = Date.now(); dbgState.wall = Date.now();
    dbgState.rvfc = 0; dbgState.restarts = 0; dbgState.seq = 0;
    dbgState.det.length = 0; dbgState.samples.length = 0; dbgState.events.length = 0;
  }
  dbgLog('open native');
  if (el.requestVideoFrameCallback) {
    const rvcb = () => {
      if (session !== scanSession) return;
      dbgState.rvfc++;
      el.requestVideoFrameCallback(rvcb);
    };
    el.requestVideoFrameCallback(rvcb);
  }
  const dbgTrack = stream.getVideoTracks()[0];
  if (dbgTrack) {
    dbgTrack.addEventListener('mute', () => dbgLog('track mute'));
    dbgTrack.addEventListener('unmute', () => dbgLog('track unmute'));
    dbgTrack.addEventListener('ended', () => {
      dbgLog('track ended');
      // 轨道被系统/浏览器终止(小米浏览器约 30s 即发生):会话仍活跃则立即重建摄像头流
      if (session === scanSession) restartNativeStream(session);
    });
  }
  startDbgSampler(session);
  // #endregion
  const detector = new BarcodeDetector();
  // 复用的小画布:每帧把视频缩到 480x360 再交给 BarcodeDetector,
  // 避免反复直接 detect(video) 在浏览器内部累积帧缓冲导致长时间运行后卡顿
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  nativeDetectFails = 0;

  const tick = async () => {
    if (session !== scanSession) return;
    if (!nativeVideo || nativeVideo.readyState < 2) {
      nativeTimer = setTimeout(tick, 300);
      return;
    }
    let codes = null;
    try {
      ctx.drawImage(nativeVideo, 0, 0, canvas.width, canvas.height);
      // #region debug-point scan-cam-freeze
      const dbgD0 = performance.now();
      // detect 加 2s 超时:部分实现可能挂起(Promise 永不 resolve),超时按失败处理
      codes = await Promise.race([
        detector.detect(canvas),
        new Promise((_, rej) => setTimeout(() => rej(new Error('detect-timeout')), 2000)),
      ]);
      dbgState.det.push(Math.round(performance.now() - dbgD0));
      if (dbgState.det.length > 40) dbgState.det.shift();
      nativeDetectFails = 0;
      // #endregion
    } catch (e) {
      // #region debug-point scan-cam-freeze
      nativeDetectFails++;
      dbgLog(`detect-fail ${nativeDetectFails} ${(e && e.message) || ''}`);
      // #endregion
      if (nativeDetectFails >= 5) {
        // #region debug-point scan-cam-freeze
        dbgLog('degrade-to-zxing (detect fails)');
        // #endregion
        nativeDetectorBroken = true;
        scanEngineText.value = 'ZXing 兼容解码(检测器不可用,已自动降级)';
        cleanupNativeScanner();
        if (session === scanSession) await startHtml5QrScanner(session);
        return;
      }
    }
    if (session !== scanSession) return; // 检测期间被关闭/重开,丢弃旧结果
    if (codes && codes.length) {
      const code = String(codes[0].rawValue || '').trim();
      if (code) {
        onScanned(code);
        return;
      }
    }
    nativeTimer = setTimeout(tick, 300);
  };
  nativeTimer = setTimeout(tick, 200);
  // 原生路径不使用定时重启(证据:轨道约 30s 即被系统结束,定时器无意义),
  // 改为 track ended 事件驱动重建(见上方事件监听)
}

// 轨道结束/异常时重建原生路径:清理旧资源后重新走完整启动流程(新流/新 video 元素)。
// detect 运行期故障由 tick 内的连续失败计数兜底降级;若 getUserMedia 失败则提示并关闭扫码。
async function restartNativeStream(session) {
  if (session !== scanSession) return;
  // #region debug-point scan-cam-freeze
  dbgState.restarts++;
  dbgLog('restart (track ended)');
  // #endregion
  cleanupNativeScanner();
  try {
    if (session === scanSession) await startNativeScanner(session);
  } catch (e) {
    if (session === scanSession) {
      uni.showToast({ title: '摄像头不可用(需HTTPS)', icon: 'none' });
      closeH5Scanner();
    }
  }
}

// ── 不支持 BarcodeDetector 时回退 html5-qrcode(ZXing)──
// ZXing 路径的视频观察:rVFC 帧计数(诊断用)+ 轨道 ended 事件(恢复用)。
// 每次 start 后都要重新挂接(html5-qrcode 重启会重建 video 元素)。
function watchZxVideo(session, startQr) {
  const zxV = document.querySelector('#scan-reader video');
  if (!zxV) return;
  if (zxV.requestVideoFrameCallback) {
    const rvcb = () => {
      if (session !== scanSession) return;
      dbgState.rvfc++;
      zxV.requestVideoFrameCallback(rvcb);
    };
    zxV.requestVideoFrameCallback(rvcb);
  }
  const zxTrk = zxV.srcObject && zxV.srcObject.getVideoTracks ? zxV.srcObject.getVideoTracks()[0] : null;
  if (zxTrk) {
    zxTrk.addEventListener('ended', () => {
      dbgLog('track ended(zxing)');
      // 轨道被系统/浏览器提前终止:立即重启,不等 2 分钟定时器
      if (session === scanSession) restartHtml5QrScanner(session, startQr);
    });
  }
}

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
  const startQr = () => h5Qr.start(
    { facingMode: 'environment' },
    {
      // 纯 ZXing 主线程解码:低 fps + 小解码区 + 低分辨率 + 禁用镜像二次解码,避免 CPU 满载卡顿
      fps: 2,
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
  await startQr();
  if (session !== scanSession) return;
  // #region debug-point scan-cam-freeze
  if (!dbgState.active) {
    dbgState.active = true;
    dbgState.t0 = Date.now(); dbgState.wall = Date.now();
    dbgState.rvfc = 0; dbgState.restarts = 0; dbgState.seq = 0;
    dbgState.det.length = 0; dbgState.samples.length = 0; dbgState.events.length = 0;
  }
  dbgLog('open zxing');
  // #endregion
  watchZxVideo(session, startQr);
  startDbgSampler(session);
  // 定期重启,防止长时间运行后媒体管线卡死
  h5RestartTimer = setTimeout(() => restartHtml5QrScanner(session, startQr), CAMERA_RESTART_MS);
}

// 重启 ZXing 回退路径(停掉旧实例并重新 start)
async function restartHtml5QrScanner(session, startQr) {
  if (session !== scanSession || !h5Qr) return;
  if (h5RestartTimer) {
    clearTimeout(h5RestartTimer);
    h5RestartTimer = null;
  }
  try {
    if (h5Qr.isRunning()) {
      await h5Qr.stop();
      try { h5Qr.clear(); } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略 */ }
  if (session !== scanSession) return;
  try {
    await startQr();
  } catch (e) {
    if (session === scanSession) {
      uni.showToast({ title: '摄像头不可用(需HTTPS)', icon: 'none' });
      closeH5Scanner();
    }
    return;
  }
  if (session === scanSession) {
    // #region debug-point scan-cam-freeze
    dbgState.restarts++;
    dbgLog('restart zxing');
    // #endregion
    watchZxVideo(session, startQr);
    h5RestartTimer = setTimeout(() => restartHtml5QrScanner(session, startQr), CAMERA_RESTART_MS);
  }
}

// 识别成功后统一收尾:关闭遮罩 + 填入关键词 + 搜索
function onScanned(code) {
  closeH5Scanner();
  keyword.value = code;
  doSearch();
}

function closeH5Scanner() {
  // #region debug-point scan-cam-freeze
  stopDbgSampler();
  dbgLog('close');
  dbgPost(true);
  dbgState.active = false;
  // #endregion
  scanSession++; // 使当前会话所有在途回调/循环全部失效
  scanVisible.value = false;
  // 清理原生 BarcodeDetector 路径
  cleanupNativeScanner();
  // 清理 html5-qrcode 路径
  if (h5RestartTimer) {
    clearTimeout(h5RestartTimer);
    h5RestartTimer = null;
  }
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
// 2026-10-23:解除搁置订单限制,允许打单发货/入库(前端二次弹窗确认,保持搁置标记)
function canShipCard(pkg) {
  return pkg.operateStatus === 'wait_ship';
}
function canReprintCard(pkg) {
  return pkg.operateStatus === 'ship_success' || pkg.operateStatus === 'wait_receiver_confirm';
}
function canShipPkg(pkg) {
  return pkg.ozonStatus === 'awaiting_packaging' && !!pkg.id;
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
  // 单号格式预检(2026-11):非法格式即时提示,不发起搜索
  const preErr = validateScanKeyword(kw);
  if (preErr) {
    banner.type = 'err';
    banner.text = preErr + ':「' + kw + '」';
    if (stockMode.value) scanStats.fail++;
    return;
  }
  searching.value = true;
  searchedOnce.value = true;
  results.value = [];
  banner.text = '';
  if (stockMode.value) scanStats.total++;
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
    if (stockMode.value && !n) scanStats.fail++;
    // 扫描入库模式(2026-11):扫到待入库订单自动入库,实现连扫
    if (stockMode.value && !stockPaused.value && n) {
      autoStockScan(results.value);
    }
  } catch (err) {
    banner.type = 'err';
    banner.text = err.message || String(err);
    if (stockMode.value) scanStats.fail++;
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

// 入库(与 web 端同口径:多件商品弹窗确认)
// 2026-10-23:搁置订单先二次确认再操作(保持搁置标记)
async function onShipPackage(pkg) {
  if (shippingPkgId.value) return;
  if (pkg.isIgnored) {
    const okIgnored = await new Promise((resolve) => {
      uni.showModal({
        title: '搁置订单操作确认',
        content: '该订单当前为【已搁置】状态，确认继续入库吗？',
        confirmText: '确认操作',
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!okIgnored) return;
  }
  const totalQty = (pkg.items || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0);
  if (totalQty > 1) {
    const ok = await new Promise((resolve) => {
      uni.showModal({
        title: '入库确认',
        content: `货件 ${pkg.postingNumber}\n共 ${totalQty} 件商品,将向 Ozon 确认全部商品为一个货件(不拆分)。`,
        confirmText: '入库',
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
      title: r.alreadyShipped ? '该包裹已入库过' : (r.pending ? '入库指令已提交' : '入库成功'),
      icon: 'none',
    });
    // 返回值供连扫模式记录(2026-11):'ok'入库成功 / 'pending'指令已提交 / 'already'已入库过 / 'fail'失败
    return r.alreadyShipped ? 'already' : (r.pending ? 'pending' : 'ok');
  } catch (e) {
    /* request.js 已 toast */
    return 'fail';
  } finally {
    shippingPkgId.value = 0;
  }
}

// 提交发货:重量落库 → 标记交运 → 尝试打开面单
// 2026-10-23:搁置订单先二次确认再操作(保持搁置标记)
async function onSubmitShip(pkg) {
  if (shippingPkgId.value) return;
  if (pkg.isIgnored) {
    const okIgnored = await new Promise((resolve) => {
      uni.showModal({
        title: '搁置订单操作确认',
        content: '该订单当前为【已搁置】状态，确认继续提交发货吗？',
        confirmText: '确认操作',
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!okIgnored) return;
  }
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

onLoad((opts) => {
  // 2026-11:mode=stock 进入独立"扫描入库"模式(首页入口可带参数)
  stockMode.value = (opts && opts.mode) === 'stock';
  if (stockMode.value) uni.setNavigationBarTitle({ title: '扫描入库' });
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

/* 扫描入库模式工具栏(2026-11) */
.stock-bar {
  display: flex;
  align-items: center;
  margin-top: 12rpx;
  background: #eef4ff;
  border-radius: 12rpx;
  padding: 10rpx 16rpx;
}
.stock-mode-tag {
  font-size: 22rpx;
  font-weight: 600;
  color: #165dff;
  margin-right: 20rpx;
}
.stock-pause-btn {
  font-size: 22rpx;
  color: #165dff;
  background: #ffffff;
  border: 1rpx solid #165dff;
  border-radius: 999rpx;
  padding: 4rpx 16rpx;
}
.stock-count {
  margin-left: auto;
  font-size: 22rpx;
  color: #4e5969;
}

/* 本次入库记录(2026-11):商品首图 + 单号 + 状态 */
.rec-title {
  font-size: 25rpx;
  font-weight: 600;
  color: #1f2329;
}
.stock-rec {
  gap: 12rpx;
}
.stock-rec-img {
  width: 72rpx;
  height: 72rpx;
  border-radius: 8rpx;
  background: #f2f3f5;
  flex-shrink: 0;
}
.stock-rec-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.stock-rec-title {
  font-size: 20rpx;
  color: #86909c;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stock-rec-status {
  font-size: 20rpx;
  font-weight: 600;
  flex-shrink: 0;
}
.stock-rec-status.st-ok {
  color: #16a34a;
}
.stock-rec-status.st-pending {
  color: #165dff;
}
.stock-rec-status.st-fail {
  color: #dc2626;
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
/* #region debug-point scan-cam-freeze (临时诊断插桩) */
.dbg-overlay {
  width: 100%;
  max-width: 660rpx;
  margin-top: 16rpx;
  padding: 10rpx 14rpx;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.65);
  border: 1rpx solid #2f9e44;
  border-radius: 10rpx;
  color: #69db7c;
  font-size: 19rpx;
  font-family: 'Courier New', monospace;
  line-height: 1.6;
  word-break: break-all;
  white-space: pre-line;
  text-align: left;
}
/* #endregion */
</style>