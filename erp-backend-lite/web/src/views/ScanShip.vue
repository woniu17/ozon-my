<script setup>
// 扫描发货(2026-09,设计文档: docs/扫描发货-功能设计.md)
// 打包发货场景:扫采购快递单号/采购单号/Ozon单号 → 全局搜索定位包裹 → 录入实物重量
// → wait_ship 自动打印面单并流转交运;非 wait_ship 提示状态问题不动状态
// 键盘流:扫描框 Enter=搜索 → 重量框 Enter=发货 → 终态自动回焦扫描框(扫码枪零鼠标作业)
import { ref, reactive, computed, onMounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import {
  getOrderList, scanShipSubmit, getScanShipRecords, fetchPackageLabel, markPrinted,
} from '../api/order-process.js';
import { pickLabelPrinter, printLabelImage, getAgentPrinters } from '../api/print-agent.js';
import { useToast } from '../components/useToast.js';
import { useConfirmStore } from '../stores/confirm.js';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();
const confirmStore = useConfirmStore();
const router = useRouter();

// ── 扫描输入 ─────────────────────────────────────────────
const scanForm = reactive({ keyword: '', mode: 'ss' }); // mode: 'ss'模糊(默认,防拼单逗号拼接漏单) | 'eq'精确
const scanInputRef = ref(null);
const searching = ref(false);
const results = ref([]);          // 全局搜索命中的包裹(快照)
const selectedId = ref(0);        // 当前选中卡片(多结果时唯一可操作的卡)
const printingPkgId = ref(0);     // 打印互斥(与 OrderProcess printingId 同模式)
const retryPkgIds = ref(new Set()); // 重量已保存但打印失败的包裹(重试只走打印+流转)
const agentOnline = ref(null);    // 菜鸟组件探测:null=探测中 true/false
const weightEls = {};             // 动态 ref:重量输入框(pkgId → el)

// 结果横幅(aria-live 播报;内容保留至下一次搜索)
const banner = reactive({ type: '', text: '' }); // type: 'ok'|'err'|'info'

// 重量输入值与错误(pkgId → string / error message)
const weightValues = reactive({});
const weightErrors = reactive({});

// ── 发货记录(右侧栏)──────────────────────────────────────
const RECORD_TABS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
];
const records = reactive({
  tab: 'today',
  loading: false,
  rows: [],
  pager: { current: 1, total: 0, pageSize: 20 },
});

// ── 展示工具(对齐 OrderProcess)──────────────────────────
const PLATFORMS = [
  { value: 'other', label: '手工(其他)' },
  { value: '1688', label: '1688' },
  { value: 'yangkeduo', label: '拼多多' },
  { value: 'taobao', label: '淘宝' },
];
const OPERATE_LABELS = {
  wait_process: { label: '待处理', cls: 'tag-warn' },
  wait_ship: { label: '待打单发货', cls: 'tag-info' },
  ship_success: { label: '交运', cls: 'tag-info' },
  wait_receiver_confirm: { label: '已发货', cls: 'tag-ok' },
  cancelled: { label: '已取消', cls: 'tag-err' },
};
const WEIGHT_SOURCE_LABELS = { ship: '发货称重', miaoshou: '订单称重', system: '系统维护', ozon: 'Ozon后台同步' };

function platformLabel(p) {
  return PLATFORMS.find((x) => x.value === p)?.label || p || '—';
}
function fmtMoney(n) {
  if (n == null) return '—';
  return '¥' + Number(n).toFixed(2);
}
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtHm(t) {
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function operateTag(pkg) {
  return OPERATE_LABELS[pkg.operateStatus] || { label: pkg.operateStatus, cls: 'tag-mute' };
}
// 卡片是否可发货(快照预判;submit 时服务端权威二次校验)
function canShipCard(pkg) {
  return pkg.operateStatus === 'wait_ship' && !pkg.isIgnored;
}
// 非 wait_ship 卡片的拦截原因(置灰卡 + 横幅文案同源)
function blockReason(pkg) {
  if (pkg.isIgnored) return '已搁置';
  switch (pkg.operateStatus) {
    case 'wait_process': return '待处理(未采购)';
    case 'ship_success': return '已交运';
    case 'wait_receiver_confirm': return '已发货(已交运)';
    case 'cancelled': return '订单已取消';
    default: return pkg.operateStatus;
  }
}
// 重量参考提示(placeholder,不自动填充——强制人工读秤)
function weightPlaceholder(pkg) {
  if (pkg.weightG != null) {
    return `参考:${Math.floor(pkg.weightG)}g(${WEIGHT_SOURCE_LABELS[pkg.weightSource] || '未知来源'})`;
  }
  return '输入称重重量';
}

// ── 搜索 ─────────────────────────────────────────────────
async function doSearch() {
  const kw = scanForm.keyword.trim();
  if (!kw || searching.value) return;
  searching.value = true;
  results.value = [];
  selectedId.value = 0;
  retryPkgIds.value = new Set();
  banner.type = 'info';
  banner.text = '搜索中…';
  try {
    // 复用 /list 全局搜索(跨所有状态,7 类字段:Ozon单号/包裹号/包裹物流号/offer_id/SKU/采购单号/采购物流单号)
    const data = await getOrderList({
      tab: 'all',
      globalKeyword: kw,
      globalMode: scanForm.mode,
      page: 1,
      pageSize: 50,
    });
    results.value = data?.packages || [];
    const n = results.value.length;
    if (n === 0) {
      banner.text = `未找到匹配订单「${kw}」`;
      focusScan();
    } else if (n === 1) {
      selectCard(results.value[0]);
      banner.text = '';
    } else {
      // 多结果(拼单场景):需人工选卡
      banner.type = 'info';
      banner.text = `命中 ${n} 个包裹,请选择要发货的订单`;
      focusScan();
    }
  } catch (err) {
    banner.type = 'err';
    banner.text = err.message || String(err);
    focusScan();
  } finally {
    searching.value = false;
  }
}

function selectCard(pkg) {
  if (!canShipCard(pkg)) return;
  selectedId.value = pkg.id;
  banner.type = '';
  banner.text = '';
  nextTick(() => weightEls[pkg.id]?.focus());
}

function focusScan() {
  nextTick(() => {
    scanInputRef.value?.focus();
    scanInputRef.value?.select();
  });
}

function onScanKeydown(e) {
  if (e.key === 'Escape') {
    scanForm.keyword = '';
    results.value = [];
    selectedId.value = 0;
    banner.type = '';
    banner.text = '';
  }
}

// ── 发货提交(核心流程)──────────────────────────────────
// 提交重量 → 服务端权威状态校验 → canShip 时打印面单 → 出纸后 markPrinted 流转交运
async function onSubmitShip(pkg) {
  if (printingPkgId.value) return;
  // 前端重量校验(服务端 400 之外的即时反馈)
  const raw = String(weightValues[pkg.id] ?? '').trim();
  const g = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(g) || g < 1 || g > 50000) {
    weightErrors[pkg.id] = '重量须为 1~50000 的整数(克)';
    weightEls[pkg.id]?.focus();
    return;
  }
  weightErrors[pkg.id] = '';
  printingPkgId.value = pkg.id;
  let submitted = false; // 重量是否已成功落库(区分 submit 失败与打印失败)
  try {
    // 1) 服务端权威校验(覆盖搜索后状态被同步任务/他端操作改变的场景)
    const r = await scanShipSubmit(pkg.id, g);
    if (!r.canShip) {
      // 非 wait_ship:不打印不改状态,横幅提示原因
      banner.type = 'err';
      banner.text = r.message || `订单状态问题:${r.operateStatus}`;
      // 已交运:可选重打(缓存秒出,不改状态)
      if (r.operateStatus === 'ship_success' && !r.isIgnored) {
        const ok = await confirmStore.ask({
          message: `包裹 ${pkg.postingNumber} 已交运。面单丢失或打花?重新打印面单(不改状态)`,
        });
        if (ok) await doPrint(pkg, { reprint: true });
      }
      focusScan();
      return;
    }
    submitted = true; // canShip=true → 重量已落库
    // 2) 打印面单 → 出纸后流转交运
    await doPrint(pkg, { reprint: false });
    banner.type = 'ok';
    banner.text = `✓ 已交运 ${pkg.postingNumber} · 重量 ${g}g · 面单已打印`;
    // 卡片就地流转(留作上下文,不消失)
    pkg.operateStatus = 'ship_success';
    pkg.weightG = g;
    pkg.weightSource = 'ship';
    retryPkgIds.value.delete(pkg.id);
    refreshRecords();
    focusScan();
  } catch (err) {
    const msg = err?.message || String(err);
    banner.type = 'err';
    if (submitted) {
      // 打印阶段失败:重量已保存,重试只走打印+流转(不再提交重量)
      retryPkgIds.value.add(pkg.id);
      banner.text = `${msg}(重量 ${g}g 已保存,点击「重试打印」继续)`;
    } else {
      // submit 本身失败(网络/5xx):重量未保存,直接重按 Enter 走全流程
      banner.text = msg;
    }
    focusScan();
  } finally {
    printingPkgId.value = 0;
  }
}

// 拉面单 → 组件静默出纸;reprint=true 时不动状态(markPrinted 会刷新交运时间,重打禁止)
async function doPrint(pkg, { reprint }) {
  const blob = await fetchPackageLabel([pkg.id]);
  const printer = await pickLabelPrinter();
  await printLabelImage(blob, pkg.logisticsNo || String(pkg.id), printer);
  if (!reprint) {
    await markPrinted(pkg.id);
  } else {
    banner.type = 'ok';
    banner.text = `面单已重新打印(交运订单,状态不变)`;
  }
}

// 重试打印(重量已保存的场景):只走打印 + 流转
async function onRetryPrint(pkg) {
  if (printingPkgId.value) return;
  printingPkgId.value = pkg.id;
  try {
    await doPrint(pkg, { reprint: false });
    banner.type = 'ok';
    banner.text = `✓ 已交运 ${pkg.postingNumber} · 面单已打印`;
    pkg.operateStatus = 'ship_success';
    retryPkgIds.value.delete(pkg.id);
    refreshRecords();
    focusScan();
  } catch (err) {
    banner.type = 'err';
    banner.text = err?.message || String(err);
    focusScan();
  } finally {
    printingPkgId.value = 0;
  }
}

// 已交运卡片的重打入口(拼单场景发完剩余卡片)
async function onReprint(pkg) {
  if (printingPkgId.value) return;
  const ok = await confirmStore.ask({
    message: `包裹 ${pkg.postingNumber} 已交运。面单丢失或打花?重新打印面单(不改状态)`,
  });
  if (!ok) return;
  printingPkgId.value = pkg.id;
  try {
    await doPrint(pkg, { reprint: true });
    focusScan();
  } catch (err) {
    banner.type = 'err';
    banner.text = err?.message || String(err);
    focusScan();
  } finally {
    printingPkgId.value = 0;
  }
}

// ── 发货记录 ─────────────────────────────────────────────
async function loadRecords() {
  records.loading = true;
  try {
    const data = await getScanShipRecords({
      day: records.tab,
      page: records.pager.current,
      pageSize: records.pager.pageSize,
    });
    records.rows = data?.packages || [];
    records.pager.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    records.rows = [];
    records.pager.total = 0;
  } finally {
    records.loading = false;
  }
}

function switchRecordTab(key) {
  if (records.tab === key) return;
  records.tab = key;
  records.pager.current = 1;
  loadRecords();
}

function onRecordPage(page) {
  records.pager.current = page;
  loadRecords();
}

// 发货成功后静默刷新(不抢焦点)
async function refreshRecords() {
  try {
    const data = await getScanShipRecords({
      day: records.tab,
      page: records.pager.current,
      pageSize: records.pager.pageSize,
    });
    records.rows = data?.packages || [];
    records.pager.total = data?.total || 0;
  } catch { /* 静默 */ }
}

// 记录行 Ozon 单号 → 跳订单处理页全局搜索(复用妙手订单页"本地包裹"跳转模式)
function jumpToOrderProcess(pkg) {
  router.push({ path: '/order-process', query: { kw: pkg.postingNumber } });
}

// ── 初始化 ───────────────────────────────────────────────
onMounted(() => {
  focusScan();
  loadRecords();
  // 菜鸟组件探测(仅状态展示,失败不阻塞——打印时 pickLabelPrinter 会再连)
  getAgentPrinters()
    .then(() => { agentOnline.value = true; })
    .catch(() => { agentOnline.value = false; });
});
</script>

<template>
  <div class="scan-ship-page">
    <!-- ① 扫描输入区(sticky,扫码枪主操作目标) -->
    <div class="scan-bar-wrap">
      <div class="scan-bar card">
        <select v-model="scanForm.mode" class="filter-input scan-mode" title="匹配模式:默认模糊(拼单采购单号逗号拼接,精确匹配会漏单)">
          <option value="ss">模糊</option>
          <option value="eq">精确</option>
        </select>
        <input
          ref="scanInputRef"
          v-model.trim="scanForm.keyword"
          class="scan-input"
          type="text"
          aria-label="扫描输入"
          placeholder="扫描/输入 采购快递单号 · 采购单号 · Ozon订单号"
          :readonly="searching"
          @keydown.enter="doSearch"
          @keydown="onScanKeydown"
        />
        <button class="btn btn-primary scan-btn" :disabled="searching" @click="doSearch">
          {{ searching ? '搜索中…' : '搜索' }}
        </button>
        <span
          class="agent-dot"
          :class="agentOnline === true ? 'on' : agentOnline === false ? 'off' : ''"
          :title="agentOnline === true ? '菜鸟打印组件已连接' : agentOnline === false ? '菜鸟打印组件未连接(打印前请启动组件)' : '正在探测打印组件…'"
        >
          {{ agentOnline === true ? '打印组件已连接' : agentOnline === false ? '打印组件未连接' : '探测打印组件…' }}
        </span>
      </div>
    </div>

    <!-- ② 结果反馈横幅(自动播报) -->
    <div v-if="banner.text" class="scan-banner" :class="`banner-${banner.type || 'info'}`" role="status" aria-live="polite">
      {{ banner.text }}
    </div>

    <div class="scan-body">
      <!-- ③ 搜索结果(左侧工作区) -->
      <section class="results-col" aria-label="搜索结果">
        <div v-if="!results.length" class="empty card">
          {{ searching ? '搜索中…' : '扫描采购快递单号开始发货' }}
        </div>

        <div
          v-for="pkg in results"
          :key="pkg.id"
          class="pkg-card card"
          :class="{
            selected: selectedId === pkg.id,
            disabled: !canShipCard(pkg),
            shipped: pkg.operateStatus === 'ship_success',
          }"
          :aria-current="selectedId === pkg.id ? 'true' : undefined"
          @click="selectCard(pkg)"
        >
          <div class="pkg-grid">
            <!-- 左列:订单信息 + 商品信息 -->
            <div class="pkg-left">
              <div class="pkg-head">
                <span class="mono pkg-posting">{{ pkg.postingNumber }}</span>
                <span v-if="pkg.parentId" class="tag tag-mute" title="拆单子件">子件</span>
                <span class="tag" :class="operateTag(pkg).cls">{{ operateTag(pkg).label }}</span>
                <span class="muted pkg-store">{{ pkg.storeName }}</span>
              </div>

              <!-- 订单信息 -->
              <div class="pkg-meta sub muted">
                {{ pkg.orderNumber }} · {{ pkg.buyerName || '—' }}{{ pkg.buyerCity ? ' · ' + pkg.buyerCity : '' }}
                · 订单金额 {{ fmtMoney(pkg.orderAmount) }} · 下单 {{ fmtTime(pkg.inProcessAt) }}
              </div>

              <!-- 商品信息(无标题:SKU/OfferID/单价/数量;图 70x70 悬浮放大) -->
              <div class="pkg-products">
                <div v-for="(it, i) in pkg.items" :key="i" class="product-item">
                  <div class="img-hover-wrap">
                    <img v-if="it.picUrl" :src="it.picUrl" referrerpolicy="no-referrer" loading="lazy" class="thumb70" alt="" />
                    <div v-else class="thumb70 thumb-empty">—</div>
                    <img v-if="it.picUrl" :src="it.picUrl" referrerpolicy="no-referrer" class="img-preview" alt="" />
                  </div>
                  <div class="product-main">
                    <div class="product-line">
                      <span class="mono">SKU:{{ it.sku ?? '—' }}</span>
                      <span class="mono">Offer ID:{{ it.offerId ?? '—' }}</span>
                      <span>单价 {{ fmtMoney(it.price) }}</span>
                      <span class="qty" :class="{ 'qty-multi': it.quantity > 1 }">× {{ it.quantity }}</span>
                    </div>
                  </div>
                </div>
                <div v-if="!pkg.items?.length" class="muted">—</div>
              </div>
            </div>

            <!-- 右列:采购信息 -->
            <div class="pkg-right">
              <div class="pkg-right-label">采购信息</div>
              <div class="pkg-purchases">
                <div v-if="!pkg.purchaseLinks?.length" class="muted sub">未录入采购信息</div>
                <div v-for="l in pkg.purchaseLinks" :key="l.id" class="purchase-item">
                  <div class="purchase-imgs">
                    <div v-for="(pi, j) in (l.items || []).slice(0, 3)" :key="j" class="img-hover-wrap">
                      <img :src="pi.thumbUrl || pi.picUrl" referrerpolicy="no-referrer" loading="lazy" class="thumb70" alt="" />
                      <img :src="pi.thumbUrl || pi.picUrl" referrerpolicy="no-referrer" class="img-preview" alt="" />
                    </div>
                    <span v-if="!l.items?.length" class="thumb70 thumb-empty">—</span>
                    <span v-if="l.items?.length > 3" class="muted sub purchase-more">+{{ l.items.length - 3 }}</span>
                  </div>
                  <div class="purchase-info">
                    <div class="purchase-line">
                      <span class="tag tag-ok">已关联</span>
                      <span class="mono">{{ l.purchaseSn || '#' + l.id }}</span>
                      <span class="muted">{{ platformLabel(l.platform) }}</span>
                    </div>
                    <div class="purchase-line sub muted">采购账号:{{ l.buyerAccount || '—' }}</div>
                    <div class="purchase-line sub muted">
                      物流:{{ l.poLogisticsNo ? `${l.poLogisticsCompany || ''} ${l.poLogisticsNo}`.trim() : '—' }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 操作条 -->
          <div class="pkg-actions">
            <template v-if="canShipCard(pkg)">
              <label class="weight-label" :for="'weight-' + pkg.id">重量(g)</label>
              <input
                :id="'weight-' + pkg.id"
                :ref="(el) => (weightEls[pkg.id] = el)"
                v-model="weightValues[pkg.id]"
                class="weight-input"
                :class="{ 'weight-invalid': weightErrors[pkg.id] }"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                :placeholder="weightPlaceholder(pkg)"
                :disabled="selectedId !== pkg.id || printingPkgId === pkg.id"
                :aria-describedby="weightErrors[pkg.id] ? 'weight-err-' + pkg.id : undefined"
                @keydown.enter="onSubmitShip(pkg)"
                @input="weightErrors[pkg.id] = ''"
              />
              <button
                class="btn btn-primary ship-btn"
                :disabled="selectedId !== pkg.id || printingPkgId === pkg.id || printingPkgId !== 0"
                :title="retryPkgIds.has(pkg.id) ? '重量已保存,重试打印面单并流转交运' : '打印面单并流转交运(仅待打单发货状态)'"
                @click.stop="retryPkgIds.has(pkg.id) ? onRetryPrint(pkg) : onSubmitShip(pkg)"
              >
                {{ printingPkgId === pkg.id ? '打印中…' : retryPkgIds.has(pkg.id) ? '重试打印' : '打印并发货' }}
              </button>
            </template>
            <template v-else-if="pkg.operateStatus === 'ship_success'">
              <span class="tag tag-ok">已交运 {{ fmtTime(pkg.shippedAt || pkg.waybillPrintedAt) }}</span>
              <button
                class="btn btn-ghost btn-sm"
                :disabled="printingPkgId !== 0"
                title="面单丢失或打花时重新打印(缓存秒出,不改状态)"
                @click.stop="onReprint(pkg)"
              >重新打印</button>
            </template>
            <template v-else>
              <span class="tag tag-mute">{{ blockReason(pkg) }} · 不可发货</span>
            </template>
          </div>
          <div v-if="weightErrors[pkg.id]" :id="'weight-err-' + pkg.id" class="error-text weight-err">
            {{ weightErrors[pkg.id] }}
          </div>
        </div>
      </section>

      <!-- ④ 发货记录(右侧参考栏) -->
      <aside class="records-col card" aria-label="发货记录">
        <div class="records-head">
          <div class="record-tabs">
            <button
              v-for="t in RECORD_TABS"
              :key="t.key"
              class="tab-btn"
              :class="{ active: records.tab === t.key }"
              @click="switchRecordTab(t.key)"
            >
              {{ t.label }}
              <span class="tab-count">{{ records.pager.total }}</span>
            </button>
          </div>
          <button class="btn btn-ghost btn-sm" :disabled="records.loading" @click="loadRecords" title="刷新发货记录">
            {{ records.loading ? '加载中…' : '刷新' }}
          </button>
        </div>

        <div v-if="!records.rows.length" class="empty records-empty">
          {{ records.loading ? '加载中…' : (records.tab === 'today' ? '今日暂无发货记录' : '昨日暂无发货记录') }}
        </div>

        <div
          v-for="p in records.rows"
          :key="p.id"
          class="record-row"
          title="点击 Ozon 单号跳转订单处理页全局搜索"
        >
          <span class="record-time mono">{{ fmtHm(p.waybillPrintedAt) }}</span>
          <img
            v-if="p.items?.[0]?.picUrl"
            :src="p.items[0].picUrl"
            referrerpolicy="no-referrer"
            loading="lazy"
            class="record-thumb"
            alt=""
          />
          <div class="record-main">
            <span class="link mono record-posting" @click="jumpToOrderProcess(p)">{{ p.postingNumber }}</span>
            <div class="record-title sub" :title="p.items?.[0]?.title || ''">{{ p.items?.[0]?.title || '—' }}</div>
          </div>
          <span class="record-weight mono" :title="WEIGHT_SOURCE_LABELS[p.weightSource] || ''">
            {{ p.weightG != null ? Math.floor(p.weightG) + 'g' : '—' }}
          </span>
        </div>

        <AppPager
          v-if="records.pager.total > records.pager.pageSize"
          :modelValue="records.pager.current"
          :total="records.pager.total"
          :pageSize="records.pager.pageSize"
          @update:modelValue="onRecordPage"
        />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.scan-ship-page {
  padding: 20px 24px 24px;
  max-width: 1440px;
  margin: 0 auto;
}

/* ── ① 扫描输入区(sticky 置顶)── */
.scan-bar-wrap {
  position: sticky;
  top: 0;
  z-index: 10;
}
.scan-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
}
.scan-mode {
  min-width: 76px;
}
.scan-input {
  flex: 1;
  height: 46px;
  padding: 0 16px;
  border: 2px solid var(--border);
  border-radius: 8px;
  font-size: 17px;
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  background: #fff;
  color: var(--text);
  transition: border-color 0.15s;
}
.scan-input:hover {
  border-color: #c7cdd6;
}
.scan-input:focus,
.scan-input:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
.scan-input[readonly] {
  background: #f9fafb;
}
.scan-btn {
  height: 46px;
  padding: 0 24px;
  font-size: 15px;
}
.agent-dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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

/* ── ② 结果横幅 ── */
.scan-banner {
  margin-top: 12px;
  padding: 10px 16px;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 500;
}
.banner-ok {
  background: #d1fae5;
  color: #059669;
}
.banner-err {
  background: #fee2e2;
  color: var(--danger);
}
.banner-info {
  background: #dbeafe;
  color: #1d4ed8;
}

/* ── 主体分栏 ── */
.scan-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 16px;
  margin-top: 12px;
  align-items: start;
}
@media (max-width: 1100px) {
  .scan-body {
    grid-template-columns: 1fr;
  }
}

/* ── ③ 结果卡片 ── */
.results-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.pkg-card {
  position: relative;
  padding: 14px 16px 14px 20px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.pkg-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  border-radius: var(--radius) 0 0 var(--radius);
  background: transparent;
}
.pkg-card:hover {
  border-color: #c7cdd6;
}
.pkg-card.selected {
  background: #eff6ff;
  border-color: var(--primary);
}
.pkg-card.selected::before {
  background: var(--primary);
}
.pkg-card.disabled {
  cursor: default;
  opacity: 0.65;
}
.pkg-card.shipped {
  cursor: default;
}

.pkg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pkg-posting {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.pkg-store {
  font-size: 12px;
}

/* 两列布局:左=订单+商品 / 右=采购 */
.pkg-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 14px;
}
.pkg-left {
  min-width: 0;
}
.pkg-right {
  min-width: 0;
  border-left: 1px dashed var(--border);
  padding-left: 14px;
}
.pkg-right-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}
@media (max-width: 900px) {
  .pkg-grid {
    grid-template-columns: 1fr;
  }
  .pkg-right {
    border-left: none;
    padding-left: 0;
    border-top: 1px dashed var(--border);
    padding-top: 10px;
  }
}

.pkg-meta {
  margin-top: 6px;
}

.pkg-products {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.product-item {
  display: flex;
  gap: 12px;
  align-items: center;
}
.product-main {
  min-width: 0;
}
.product-line {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 13px;
}
.qty {
  font-weight: 600;
  color: var(--text);
}
/* 数量>1:字体加大、红色 */
.qty-multi {
  color: var(--danger);
  font-size: 18px;
  font-weight: 700;
}

/* 70x70 缩略图 + 悬浮放大预览 */
.thumb70 {
  width: 70px;
  height: 70px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #fff;
  flex-shrink: 0;
  display: block;
}
.thumb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 12px;
}
.img-hover-wrap {
  position: relative;
  flex-shrink: 0;
}
.img-preview {
  display: none;
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 280px;
  height: 280px;
  object-fit: contain;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  z-index: 30;
  pointer-events: none;
}
.img-hover-wrap:hover .img-preview {
  display: block;
}

.pkg-purchases {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.purchase-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.purchase-imgs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  flex-shrink: 0;
  max-width: 230px;
}
.purchase-more {
  align-self: center;
}
.purchase-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.purchase-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex-wrap: wrap;
}

/* 操作条 */
.pkg-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.weight-label {
  font-size: 13px;
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
}
.weight-input {
  width: 150px;
  height: 40px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 16px;
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
  background: #fff;
  color: var(--text);
  transition: border-color 0.15s;
}
.weight-input:focus,
.weight-input:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
.weight-input:disabled {
  background: #f3f4f6;
  cursor: not-allowed;
  opacity: 0.7;
}
.weight-input.weight-invalid {
  border-color: var(--danger);
}
.weight-err {
  margin: 6px 0 0;
  font-size: 12px;
}
.ship-btn {
  height: 40px;
  padding: 0 20px;
  font-size: 14px;
}

/* ── ④ 发货记录 ── */
.records-col {
  padding: 14px 16px;
  position: sticky;
  top: 86px;
}
.records-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.record-tabs {
  display: flex;
  gap: 4px;
}
.tab-btn {
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  touch-action: manipulation;
}
.tab-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.35);
  border-radius: 6px 6px 0 0;
}
.tab-btn:hover {
  color: var(--text);
}
.tab-btn.active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 500;
}
.tab-count {
  display: inline-block;
  min-width: 18px;
  padding: 0 5px;
  margin-left: 4px;
  border-radius: 8px;
  background: #f3f4f6;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}
.tab-btn.active .tab-count {
  background: #dbeafe;
  color: var(--primary);
}
.records-empty {
  padding: 28px 0;
  font-size: 13px;
}
.record-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 2px;
  border-bottom: 1px solid #f3f4f6;
}
.record-row:last-of-type {
  border-bottom: none;
}
.record-time {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.record-thumb {
  width: 70px;
  height: 70px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #fff;
  flex-shrink: 0;
}
.record-main {
  flex: 1;
  min-width: 0;
}
.record-posting {
  font-size: 12px;
}
.record-title {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.record-weight {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
}

.mono {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
}
.sub {
  font-size: 12px;
}
</style>
