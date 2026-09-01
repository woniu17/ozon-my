<script setup>
// 妙手订单(2026-09,与"订单处理"同层级导航)
// 数据来源:miaoshou-helper 插件从妙手 ERP 历史订单页提取,存独立 miaoshou_* 表(只读镜像)
// 用途:查妙手侧采购信息/称重重量/本地备注;经 posting_number 关联本地 op_package
// 页面设计对齐 OrderProcess.vue:状态 Tab(operate_status 分流)+ 筛选 + 分页列表 + 详情弹窗
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { getMiaoshouList, getMiaoshouTabs, getMiaoshouDetail, syncFromMiaoshou } from '../api/order-process.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();
const router = useRouter();

// ── 状态 Tab(operate_status 分流,值域与本地 op_package 一致)──
const TABS = [
  { key: 'all', label: '全部' },
  { key: 'wait_process', label: '待处理' },
  { key: 'wait_ship', label: '待打单发货' },
  { key: 'ship_success', label: '交运' },
  { key: 'wait_receiver_confirm', label: '已发货' },
  { key: 'cancelled', label: '已取消' },
];
const activeTab = ref('all');
const tabCounts = ref({});

// ── 筛选 ───────────────────────────────────────────────
const filters = reactive({
  keyword: '',      // Ozon单号/妙手包裹号/备注
  shopNick: '',     // 店铺昵称
  localLinked: '',  // '' 全部 | '1' 已关联本地 | '0' 未关联本地
});

const pager = reactive({ current: 1, total: 0, pageSize: 20 });
const loading = ref(false);
const rows = ref([]);

// ── 详情弹窗 ───────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detail = ref(null);

// ── 从妙手同步(插件提取,分批入库)────────────────────
// 通过 erp-bridge.js 中继,触发 miaoshou-helper content script 翻页提取妙手订单
// 桥接协议:ping 探活 → GET_ORDERS(立即 ack)→ 每页一批 MS_BATCH 逐批入库
//          → PROGRESS 翻页进度 → DONE/ERROR 结束通知
// 分批设计:每页 20 条一批边提取边入库(upsert 幂等),中途失败已入库数据不丢,
//          避免一次性大 payload(413)与长时间等待单次响应超时
const MS_NS = 'erp-ms';
const msExtracting = ref(false);
const msBridgeReady = ref(false);
const msProgress = reactive({ page: 0, count: 0, saved: 0 });
const msResult = ref(null); // { packages, purchases }(累计)
let msReqSeq = 0;
const msPending = new Map(); // reqId -> resolve
// 分批同步累计值 + 串行入库队列(批次按序 POST,避免并发)
const msTotals = reactive({ packages: 0, purchases: 0, failedBatches: 0 });
let msBatchChain = Promise.resolve();

function msPing() {
  window.postMessage({ source: MS_NS, type: 'MS_PING' }, window.location.origin);
}

// 发送提取请求(等待 ack;订单数据经 MS_BATCH 分批到达)
function msRequest(payload) {
  return new Promise((resolve) => {
    const reqId = ++msReqSeq;
    const timer = setTimeout(() => {
      msPending.delete(reqId);
      resolve({ ok: false, error: '请求超时:请确认 miaoshou-helper 扩展已启用并已重新加载,且妙手历史订单页已打开' });
    }, 60_000);
    msPending.set(reqId, (data) => { clearTimeout(timer); resolve(data); });
    window.postMessage({ source: MS_NS, type: 'MS_GET_ORDERS', reqId, payload }, window.location.origin);
  });
}

// 监听 erp-bridge 返回的消息(PONG + ORDERS_RESULT + PROGRESS + BATCH/DONE/ERROR)
function onMsMessage(ev) {
  if (ev.source !== window || !ev.data || ev.data.source !== MS_NS) return;
  if (ev.data.type === 'MS_PONG') { msBridgeReady.value = true; return; }
  // 进度上报(content script → background → 透传)
  if (ev.data.type === 'MS_PROGRESS') {
    msProgress.page = ev.data.page || 0;
    msProgress.count = ev.data.count || 0;
    return;
  }
  // 每页一批订单:串行入队逐批 POST 入库
  if (ev.data.type === 'MS_BATCH') {
    queueMsBatch(ev.data.orders || []);
    return;
  }
  // 提取全部完成(等队列内批次入库完后收尾;非本页发起的同步忽略)
  if (ev.data.type === 'MS_DONE') {
    if (msExtracting.value) finishMsSync(null);
    return;
  }
  // 提取失败(已入库的批次保留;非本页发起的同步忽略)
  if (ev.data.type === 'MS_ERROR') {
    if (msExtracting.value) finishMsSync(ev.data.error || '提取失败');
    return;
  }
  // MS_GET_ORDERS 的 ack/错误响应
  if (ev.data.type === 'MS_ORDERS_RESULT') {
    const cb = msPending.get(ev.data.reqId);
    if (cb) { msPending.delete(ev.data.reqId); cb(ev.data.data); }
  }
}

// 批次串行入队:按到达顺序逐批入库,失败计数不中断后续批次
function queueMsBatch(orders) {
  if (!msExtracting.value || !orders.length) return;
  msBatchChain = msBatchChain.then(async () => {
    try {
      const r = await syncFromMiaoshou(orders);
      msTotals.packages += r.packages || 0;
      msTotals.purchases += r.purchases || 0;
      msProgress.saved = msTotals.packages;
      msResult.value = { packages: msTotals.packages, purchases: msTotals.purchases };
    } catch (e) {
      msTotals.failedBatches++;
      show(`妙手批次入库失败(跳过 ${orders.length} 单):${e.message || e}`, 'error');
    }
  });
}

// 收尾:等最后一批入库完成,汇总提示并刷新
async function finishMsSync(err) {
  await msBatchChain.catch(() => {});
  msExtracting.value = false;
  const summary = `已入库 ${msTotals.packages} 个包裹/${msTotals.purchases} 个采购单`;
  if (err) {
    show(`妙手提取失败:${err}(${summary})`, 'error');
  } else if (msTotals.failedBatches) {
    show(`妙手同步完成:${summary},${msTotals.failedBatches} 批入库失败`, 'error');
  } else {
    show(`妙手同步完成:${summary}`, 'success');
  }
  loadTabs();
  loadList();
}

async function triggerMiaoshouSync() {
  if (msExtracting.value) return;
  if (!msBridgeReady.value) {
    show('未检测到助手扩展,请先安装/启用 miaoshou-helper 并刷新本页', 'error');
    return;
  }
  msExtracting.value = true;
  msResult.value = null;
  msProgress.page = 0;
  msProgress.count = 0;
  msProgress.saved = 0;
  msTotals.packages = 0;
  msTotals.purchases = 0;
  msTotals.failedBatches = 0;

  try {
    // ack 模式:扩展确认已启动提取;数据经 MS_BATCH 分批到达,完成由 MS_DONE/MS_ERROR 通知
    const resp = await msRequest({});
    if (!resp.ok) {
      msExtracting.value = false;
      show(resp.error || '妙手提取失败', 'error');
    }
  } catch (e) {
    msExtracting.value = false;
    show('妙手同步异常: ' + (e.message || e), 'error');
  }
}

// ── 数据加载 ───────────────────────────────────────────
async function loadTabs() {
  try {
    tabCounts.value = await getMiaoshouTabs();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function loadList() {
  loading.value = true;
  try {
    const data = await getMiaoshouList({
      page: pager.current,
      pageSize: pager.pageSize,
      keyword: filters.keyword.trim(),
      shopNick: filters.shopNick.trim(),
      operateStatus: activeTab.value === 'all' ? '' : activeTab.value,
      localLinked: filters.localLinked,
    });
    rows.value = data?.packages || [];
    pager.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    rows.value = [];
    pager.total = 0;
  } finally {
    loading.value = false;
  }
}

function switchTab(key) {
  if (activeTab.value === key) return;
  activeTab.value = key;
  pager.current = 1;
  loadList();
}

function search() {
  pager.current = 1;
  loadList();
}

function onPageChange(p) {
  pager.current = p;
  loadList();
}

async function openDetail(row) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await getMiaoshouDetail(row.id);
  } catch (err) {
    show(err.message || String(err), 'error');
    detailOpen.value = false;
  } finally {
    detailLoading.value = false;
  }
}

// 跳转订单处理页查看本地包裹(带 Ozon 单号触发全局搜索)
function gotoLocalPackage(postingNumber) {
  router.push({ path: '/order-process', query: { kw: postingNumber } });
}

// ── 展示辅助 ───────────────────────────────────────────
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

function fmtWeight(g) {
  if (g == null) return '—';
  return `${Number(g).toFixed(0)} g`;
}

// 操作状态标签(值域与本地 operate_status 一致)
const OPERATE_LABELS = {
  wait_process: { label: '待处理', cls: 'tag-warn' },
  wait_ship: { label: '待打单发货', cls: 'tag-info' },
  ship_success: { label: '交运', cls: 'tag-info' },
  wait_receiver_confirm: { label: '已发货', cls: 'tag-ok' },
  cancelled: { label: '已取消', cls: 'tag-err' },
};
function operateTag(row) {
  return OPERATE_LABELS[row.operate_status] || { label: row.operate_status || '—', cls: 'tag-mute' };
}

// 采购状态(appPurchaseStatus:none/purchased)
function purchaseTag(row) {
  if (row.purchase_status === 'none') return { cls: 'tag tag-mute', label: '未采购' };
  if (row.purchase_status) return { cls: 'tag tag-ok', label: '已采购' };
  return { cls: 'tag tag-mute', label: '—' };
}

const PLATFORM_LABELS = {
  1688: '1688',
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
function poStatus(s) {
  return PO_STATUS_LABELS[s] || s || '—';
}

onMounted(() => {
  loadTabs();
  loadList();
  // 妙手桥接:监听扩展回包 + 主动探测(扩展公告可能早于本页挂载)
  window.addEventListener('message', onMsMessage);
  msPing();
});

onUnmounted(() => {
  window.removeEventListener('message', onMsMessage);
});
</script>

<template>
  <div class="miaoshou-orders-page">
    <!-- 状态 Tab + 同步入口 -->
    <div class="tabs-bar">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab-btn"
        :class="{ active: activeTab === t.key }"
        @click="switchTab(t.key)"
      >
        {{ t.label }}
        <span class="tab-count">{{ tabCounts[t.key] ?? 0 }}</span>
      </button>
      <div class="sync-area">
        <span class="sync-info" title="本地关联 = Ozon 单号已匹配本地订单处理包裹">
          已关联本地 {{ tabCounts.linked ?? 0 }} / 未关联 {{ tabCounts.unlinked ?? 0 }}
        </span>
        <button class="btn btn-ghost" :disabled="msExtracting" @click="triggerMiaoshouSync" title="从妙手ERP历史订单页提取采购信息/称重重量/本地备注,需先打开妙手订单页并登录">
          {{ msExtracting ? `妙手提取中…(第${msProgress.page}页/${msProgress.count}单${msProgress.saved ? ',已入库' + msProgress.saved : ''})` : '从妙手同步' }}
        </button>
        <span v-if="msResult" class="ms-result-badge tag tag-ok" title="妙手数据入库结果">
          妙手 {{ msResult.packages }}包裹/{{ msResult.purchases }}采购单
        </span>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="filter-bar">
        <input
          class="filter-input kw-input"
          type="text"
          v-model.trim="filters.keyword"
          placeholder="Ozon单号/妙手包裹号/备注"
          @keydown.enter="search"
        />
        <input
          class="filter-input"
          type="text"
          v-model.trim="filters.shopNick"
          placeholder="店铺昵称"
          @keydown.enter="search"
        />
        <select v-model="filters.localLinked" class="filter-input" @change="search">
          <option value="">全部关联</option>
          <option value="1">已关联本地</option>
          <option value="0">未关联本地</option>
        </select>
        <button class="btn btn-primary" @click="search">查询</button>
        <button class="btn btn-ghost" :disabled="loading" @click="loadList">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>包裹/订单</th>
            <th>店铺/买家</th>
            <th>金额</th>
            <th>称重</th>
            <th>采购</th>
            <th>状态/时间</th>
            <th>备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="8" class="empty">{{ loading ? '加载中…' : '暂无妙手订单(点击右上角「从妙手同步」提取妙手历史订单)' }}</td>
          </tr>
          <tr v-for="row in rows" :key="row.id">
            <td>
              <div class="mono">{{ row.posting_number || '—' }}</div>
              <div class="sub muted">妙手包裹 {{ row.app_package_no || '—' }}</div>
            </td>
            <td>
              <div>{{ row.shop_nick || '—' }}</div>
              <div class="sub muted">{{ row.buyer_name || '—' }}{{ row.buyer_country ? ' · ' + row.buyer_country : '' }}</div>
            </td>
            <td>{{ fmtMoney(row.order_amount) }}</td>
            <td>{{ fmtWeight(row.weighing_weight) }}</td>
            <td>
              <span :class="purchaseTag(row).cls">{{ purchaseTag(row).label }}</span>
              <div class="sub muted">{{ row.purchase_count || 0 }} 个采购单</div>
            </td>
            <td>
              <div>
                <span class="tag" :class="operateTag(row).cls">{{ operateTag(row).label }}</span>
                <span v-if="row.local_pkg_id" class="tag tag-info" title="Ozon 单号已匹配本地订单包裹">已关联本地</span>
                <span v-else class="tag tag-mute" title="本地订单处理中未找到该 Ozon 单号">未关联</span>
              </div>
              <div class="sub muted">下单 {{ fmtTime(row.gmt_order_start) }}</div>
              <div class="sub muted">同步 {{ fmtTime(row.synced_at) }}</div>
            </td>
            <td class="ms-note-cell" :title="row.note || ''">{{ row.note || '—' }}</td>
            <td>
              <div class="action-group">
                <button class="btn btn-ghost btn-sm" @click="openDetail(row)">详情</button>
                <button
                  v-if="row.local_pkg_id"
                  class="btn btn-ghost btn-sm"
                  title="跳转订单处理页查看本地包裹"
                  @click="gotoLocalPackage(row.posting_number)"
                >本地包裹</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="footer-bar">
      <span class="footer-info">共 {{ pager.total }} 个包裹</span>
      <AppPager
        :modelValue="pager.current"
        :total="pager.total"
        :pageSize="pager.pageSize"
        @update:modelValue="onPageChange"
      />
    </div>

    <!-- 妙手订单详情弹窗(独立 miaoshou_* 表数据) -->
    <AppModal :open="detailOpen" :title="detail?.package ? `妙手订单详情 · ${detail.package.posting_number || detail.package.app_package_no || ''}` : '妙手订单详情'" size="lg" @update:open="detailOpen = $event">
      <div v-if="detailLoading" class="empty">加载中…</div>
      <div v-else-if="detail" class="detail-body">
        <div class="detail-grid">
          <div><span class="dl">Ozon单号</span><span class="mono">{{ detail.package.posting_number || '—' }}</span></div>
          <div><span class="dl">妙手包裹号</span><span class="mono">{{ detail.package.app_package_no || '—' }}</span></div>
          <div><span class="dl">店铺</span>{{ detail.package.shop_nick || '—' }}</div>
          <div><span class="dl">买家</span>{{ detail.package.buyer_name || '—' }}{{ detail.package.buyer_country ? ' · ' + detail.package.buyer_country : '' }}</div>
          <div><span class="dl">订单金额</span>{{ fmtMoney(detail.package.order_amount) }}</div>
          <div><span class="dl">称重重量</span>{{ fmtWeight(detail.package.weighing_weight) }}</div>
          <div><span class="dl">本地备注</span>{{ detail.package.note || '—' }}</div>
          <div><span class="dl">本地关联</span>
            <template v-if="detail.package.local_pkg_id">
              <span class="tag tag-info">已关联本地包裹 #{{ detail.package.local_pkg_id }}</span>
              <button class="btn btn-ghost btn-sm" style="margin-left: 6px" @click="gotoLocalPackage(detail.package.posting_number)">查看本地包裹</button>
            </template>
            <span v-else class="muted">未匹配本地订单</span>
          </div>
          <div><span class="dl">下单时间</span>{{ fmtTime(detail.package.gmt_order_start) }}</div>
          <div><span class="dl">同步时间</span>{{ fmtTime(detail.package.synced_at) }}</div>
        </div>

        <div class="detail-section">采购单({{ detail.purchases?.length || 0 }})</div>
        <table v-if="detail.purchases?.length" class="data-table item-table">
          <thead>
            <tr><th>采购单号</th><th>平台</th><th>状态</th><th>金额</th><th>买手/上家</th><th>采购时间/发货时间</th><th>国内物流</th></tr>
          </thead>
          <tbody>
            <tr v-for="po in detail.purchases" :key="po.id">
              <td class="mono">{{ po.purchase_sn || '#' + po.purchase_order_id }}</td>
              <td>{{ platformLabel(po.platform) }}</td>
              <td>{{ poStatus(po.status) }}</td>
              <td>{{ fmtMoney(po.payment_amount) }}</td>
              <td>
                <div>{{ po.buyer_account || '—' }}</div>
                <div class="sub muted">{{ po.seller_name || '—' }}</div>
              </td>
              <td>
                <div>{{ fmtTime(po.purchase_start_time) }}</div>
                <div class="sub muted" v-if="po.send_at">发货 {{ fmtTime(po.send_at) }}</div>
              </td>
              <td>
                <div>{{ po.logistics_company || '—' }}</div>
                <div class="sub muted mono">{{ po.logistics_no || '' }}</div>
                <div v-if="po.last_trace" class="sub muted" :title="po.last_trace">{{ po.last_trace }}</div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="muted">无采购单</div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.miaoshou-orders-page {
  padding: 16px;
  max-width: 1400px;
  margin: 0 auto;
}

/* Tab 页签 */
.tabs-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.tab-btn {
  padding: 6px 14px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  background: var(--bg-card, #fff);
  color: var(--text-primary, #374151);
  font-size: 13px;
  cursor: pointer;
}

.tab-btn.active {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}

.tab-count {
  margin-left: 4px;
  font-size: 11px;
  opacity: 0.8;
}

.sync-area {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sync-info {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}

/* 妙手同步结果徽章 */
.ms-result-badge {
  margin-left: 4px;
  cursor: default;
}

/* 展示辅助 */
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.sub {
  font-size: 11px;
  margin-top: 2px;
}

.muted {
  color: var(--text-secondary, #9ca3af);
}

.tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.tag-ok { background: #dcfce7; color: #16a34a; }
.tag-err { background: #fee2e2; color: #ef4444; }
.tag-warn { background: #fef3c7; color: #f59e0b; }
.tag-info { background: #dbeafe; color: #2563eb; }
.tag-mute { background: #f3f4f6; color: #6b7280; }

.empty {
  text-align: center;
  padding: 32px 0;
  color: var(--text-secondary, #9ca3af);
}

.footer-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
  gap: 8px;
}

.footer-info {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}

.item-table {
  font-size: 12px;
}

.action-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
}

/* 详情弹窗 */
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 20px;
  font-size: 12px;
}

.detail-grid .dl {
  display: inline-block;
  min-width: 72px;
  color: var(--text-secondary, #6b7280);
}

.detail-section {
  font-size: 12px;
  font-weight: 700;
  margin-top: 14px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #e5e7eb);
}

/* 备注列(超长截断,悬浮看全文) */
.ms-note-cell {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}
</style>
