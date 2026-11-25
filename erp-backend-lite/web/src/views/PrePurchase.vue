<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h2 class="page-title">预采购</h2>
        <p class="page-desc">提前采购、暂不绑定 Ozon 订单；到货后扫描快递单号签收。</p>
      </div>
      <div class="header-actions">
        <button class="btn btn-primary" @click="openCreate">+ 新增预采购</button>
        <button class="btn btn-ghost" @click="openReceive">扫描签收</button>
      </div>
    </div>

    <div class="tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab-btn"
        :class="{ active: tab === t.key }"
        @click="switchTab(t.key)"
      >
        {{ t.label }}<span v-if="counts[t.key] != null" class="tab-count">({{ counts[t.key] }})</span>
      </button>
    </div>

    <div class="card">
      <div v-if="loading" class="list-empty">加载中…</div>
      <div v-else-if="!items.length" class="list-empty">
        {{ tab === 'pending' ? '暂无待收货预采购' : tab === 'received' ? '暂无已签收预采购' : '暂无预采购订单' }}
      </div>
      <table v-else class="pre-table">
        <thead>
          <tr>
            <th>平台</th>
            <th>采购单号</th>
            <th>快递单号</th>
            <th>商品</th>
            <th class="num">金额</th>
            <th>状态</th>
            <th>签收时间</th>
            <th class="ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in items" :key="row.id">
            <td><span class="platform-tag">{{ platformLabel(row.platform) }}</span></td>
            <td class="mono">{{ row.purchaseSn || '—' }}</td>
            <td class="mono">{{ row.logisticsNo || '—' }}</td>
            <td>
              <div v-for="(g, i) in (row.items || []).slice(0, 2)" :key="i" class="goods-line">
                <span class="goods-name">{{ g.goodsName || g.title || '商品' }}</span>
                <span class="goods-qty">×{{ g.number || g.num || g.quantity || 1 }}</span>
              </div>
              <div v-if="(row.items || []).length > 2" class="muted">等 {{ row.items.length }} 件商品</div>
            </td>
            <td class="num">{{ fmtMoney(row.paymentAmount) }}</td>
            <td>
              <span class="status-tag" :class="row.receiveStatus === 'received' ? 'st-ok' : 'st-pending'">
                {{ row.receiveStatus === 'received' ? '已签收' : '待收货' }}
              </span>
            </td>
            <td class="muted">{{ row.receivedAt ? fmtTime(row.receivedAt) : '—' }}</td>
            <td class="ops">
              <button v-if="row.receiveStatus === 'pending'" class="btn btn-primary btn-sm" @click="receiveOne(row)">签收</button>
              <button class="btn btn-danger btn-sm" @click="removeRow(row)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <AppPager
        v-if="total > pageSize"
        :modelValue="page"
        :total="total"
        :pageSize="pageSize"
        @update:modelValue="onPageChange"
      />
    </div>

    <!-- 新增预采购弹窗 -->
    <AppModal :open="create.open" title="新增预采购" size="xl" @update:open="create.open = $event">
      <div class="create-modal">
        <div class="platform-tabs">
          <button
            v-for="p in PLATFORMS"
            :key="p.key"
            class="tab-btn"
            :class="{ active: create.platform === p.key }"
            @click="switchCreatePlatform(p.key)"
          >{{ p.label }}</button>
        </div>
        <div class="create-toolbar">
          <span class="muted">已选 {{ createSelectedCount }} 笔 · {{ create.postings.length }} 笔订单</span>
          <button class="btn btn-ghost btn-sm" :disabled="create.loading" @click="loadPlatformOrders">
            {{ create.loading ? '拉取中…' : '刷新订单' }}
          </button>
        </div>
        <div v-if="create.loading" class="list-empty">正在拉取 {{ platformLabel(create.platform) }} 订单…</div>
        <div v-else-if="!create.postings.length" class="list-empty">{{ create.error || '该平台暂无可选订单' }}</div>
        <table v-else class="pre-table">
          <thead>
            <tr>
              <th class="sel-col"><input type="checkbox" :checked="create.allSelected" @change="toggleCreateAll" /></th>
              <th>订单号</th>
              <th>商品</th>
              <th class="num">金额</th>
              <th>快递单号(可改)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(o, i) in create.postings" :key="o.orderSn + i">
              <td class="sel-col"><input type="checkbox" v-model="create.selected[o.orderSn]" /></td>
              <td class="mono">{{ o.orderSn }}</td>
              <td>
                <div v-for="(g, gi) in (o.goods || []).slice(0, 2)" :key="gi" class="goods-line">
                  <span class="goods-name">{{ g.goodsName || g.title || '商品' }}</span>
                  <span class="goods-qty">×{{ g.number || g.num || 1 }}</span>
                </div>
              </td>
              <td class="num">{{ fmtMoney(orderAmount(o)) }}</td>
              <td><input v-model="create.logistics[o.orderSn]" class="form-control" :placeholder="o.trackingNumber || '快递单号'" /></td>
            </tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="create.open = false">取消</button>
          <button class="btn btn-primary" :disabled="create.saving || !createSelectedCount" @click="submitCreate">
            {{ create.saving ? '提交中…' : `提交预采购(${createSelectedCount})` }}
          </button>
        </div>
      </div>
    </AppModal>

    <!-- 扫描签收弹窗 -->
    <AppModal :open="receive.open" title="预采购 · 扫描签收" size="lg" @update:open="receive.open = $event">
      <div class="receive-modal">
        <p class="muted">输入或扫描快递单号，匹配待收货预采购订单后确认签收。</p>
        <div class="receive-input-row">
          <input
            ref="receiveInputRef"
            v-model="receive.code"
            class="form-control"
            placeholder="快递单号"
            @keyup.enter="searchReceive"
          />
          <button class="btn btn-primary" :disabled="receive.searching" @click="searchReceive">
            {{ receive.searching ? '查询中…' : '查询' }}
          </button>
        </div>
        <div v-if="receive.searched" class="receive-result">
          <div v-if="!receive.matches.length" class="list-empty">未匹配到待收货预采购订单</div>
          <div v-else>
            <div v-for="m in receive.matches" :key="m.id" class="receive-match">
              <div class="match-head">
                <span class="platform-tag">{{ platformLabel(m.platform) }}</span>
                <span class="mono">{{ m.purchaseSn || '—' }}</span>
                <span class="muted">快递 {{ m.logisticsNo }}</span>
              </div>
              <div class="muted">{{ (m.items || []).map((g) => g.goodsName || g.title).filter(Boolean).join(' / ') }} · {{ fmtMoney(m.paymentAmount) }}</div>
            </div>
            <button class="btn btn-primary" :disabled="receive.saving" @click="confirmReceive">
              {{ receive.saving ? '签收中…' : `确认签收(${receive.matches.length})` }}
            </button>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" @click="receive.open = false">关闭</button>
        </div>
      </div>
    </AppModal>
  </div>
</template>

<script setup>
import { ref, reactive, nextTick, onMounted } from 'vue';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import { useToast } from '../components/useToast.js';
import { listPrePurchases, createPrePurchase, deletePrePurchase, receivePrePurchase, receiveByCode } from '../api/pre-purchase.js';
import { getPlatformOrders } from '../api/order-process.js';

const { show } = useToast();

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待收货' },
  { key: 'received', label: '签收' },
];
const PLATFORMS = [
  { key: 'pdd', label: '拼多多' },
  { key: 'ali1688', label: '1688' },
  { key: 'taobao', label: '淘宝' },
  { key: 'xianyu', label: '闲鱼' },
];
const PLATFORM_LABEL = { pdd: '拼多多', yangkeduo: '拼多多', ali1688: '1688', '1688': '1688', taobao: '淘宝', xianyu: '闲鱼', other: '手工' };
function platformLabel(p) { return PLATFORM_LABEL[p] || p || '—'; }
function fmtMoney(v) { return v == null || v === '' ? '—' : '¥' + Number(v).toFixed(2); }
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return t;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 列表 ──
const tab = ref('all');
const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const counts = reactive({ all: 0, pending: 0, received: 0 });

async function loadList() {
  loading.value = true;
  try {
    const r = await listPrePurchases({ tab: tab.value, page: page.value, pageSize: pageSize.value });
    const d = r?.data || r || {};
    items.value = d.items || [];
    total.value = d.total || 0;
    if (d.counts) Object.assign(counts, d.counts);
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    loading.value = false;
  }
}
function switchTab(k) { tab.value = k; page.value = 1; loadList(); }
function onPageChange(p) { page.value = p; loadList(); }

async function receiveOne(row) {
  try {
    await receivePrePurchase({ ids: [row.id], by: 'manual' });
    show('已签收', 'success');
    loadList();
  } catch (e) { show(e.message || String(e), 'error'); }
}
async function removeRow(row) {
  if (!confirm(`确认删除预采购单 ${row.purchaseSn || row.id}？`)) return;
  try {
    await deletePrePurchase(row.id);
    show('已删除', 'success');
    loadList();
  } catch (e) { show(e.message || String(e), 'error'); }
}

// ── 新增预采购 ──
const create = reactive({
  open: false,
  platform: 'pdd',
  loading: false,
  error: '',
  postings: [],
  selected: {},
  logistics: {},
  allSelected: false,
  saving: false,
});
const createSelectedCount = ref(0);
function syncCreateSelectedCount() {
  createSelectedCount.value = create.postings.filter((o) => create.selected[o.orderSn]).length;
}
function openCreate() {
  create.open = true;
  create.error = '';
  loadPlatformOrders();
}
function switchCreatePlatform(p) {
  if (create.platform === p) return;
  create.platform = p;
  loadPlatformOrders();
}
async function loadPlatformOrders() {
  create.loading = true;
  create.error = '';
  create.postings = [];
  create.selected = {};
  create.logistics = {};
  create.allSelected = false;
  createSelectedCount.value = 0;
  try {
    const r = await getPlatformOrders(create.platform, { tab: 'all', size: 30 });
    const orders = r?.orders || r?.data?.orders || [];
    create.postings = orders.map((o) => ({
      orderSn: o.orderSn || o.order_sn,
      amount: o.amount,
      paidAmount: o.paidAmount,
      trackingNumber: o.trackingNumber || o.logisticsNo || '',
      logisticsCompany: o.logisticsCompany || '',
      sellerName: o.sellerName || '',
      buyerAccount: o.buyerAccount || '',
      buyerUserId: o.buyerUserId || '',
      goods: o.goods || [],
    }));
    if (!create.postings.length) create.error = '该平台暂无可选订单';
  } catch (e) {
    create.error = e.message || String(e);
  } finally {
    create.loading = false;
  }
}
function toggleCreateAll(e) {
  const checked = !!e?.target?.checked;
  create.allSelected = checked;
  for (const o of create.postings) create.selected[o.orderSn] = checked;
  syncCreateSelectedCount();
}
function orderAmount(o) { return o.paidAmount != null ? o.paidAmount : o.amount; }

async function submitCreate() {
  const picked = create.postings.filter((o) => create.selected[o.orderSn]);
  if (!picked.length) return;
  create.saving = true;
  let ok = 0;
  try {
    for (const o of picked) {
      await createPrePurchase({
        platform: create.platform,
        purchaseSn: o.orderSn,
        buyerAccount: o.buyerAccount,
        buyerUserId: o.buyerUserId,
        sellerName: o.sellerName,
        paymentAmount: orderAmount(o),
        goodsAmount: orderAmount(o),
        logisticsCompany: o.logisticsCompany,
        logisticsNo: (create.logistics[o.orderSn] || o.trackingNumber || '').trim() || null,
        poStatus: 'shipped',
        items: o.goods || [],
        platformGoods: o.goods || [],
      });
      ok++;
    }
    show(`已新增 ${ok} 笔预采购`, 'success');
    create.open = false;
    loadList();
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    create.saving = false;
  }
}

// ── 扫描签收 ──
const receive = reactive({ open: false, code: '', searching: false, saving: false, searched: false, matches: [] });
const receiveInputRef = ref(null);
function openReceive() {
  receive.open = true;
  receive.code = '';
  receive.matches = [];
  receive.searched = false;
  nextTick(() => receiveInputRef.value?.focus());
}
async function searchReceive() {
  const code = receive.code.trim();
  if (!code) return;
  receive.searching = true;
  receive.searched = true;
  try {
    const r = await receiveByCode(code);
    receive.matches = r?.matches || r?.data?.matches || [];
  } catch (e) {
    show(e.message || String(e), 'error');
    receive.matches = [];
  } finally {
    receive.searching = false;
  }
}
async function confirmReceive() {
  if (!receive.matches.length) return;
  receive.saving = true;
  try {
    await receivePrePurchase({ ids: receive.matches.map((m) => m.id), by: 'scan' });
    show(`已签收 ${receive.matches.length} 笔预采购`, 'success');
    receive.open = false;
    loadList();
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    receive.saving = false;
  }
}

onMounted(loadList);
</script>

<style scoped>
.page { padding: 16px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
.page-title { margin: 0; font-size: 20px; }
.page-desc { margin: 4px 0 0; color: #86909c; font-size: 13px; }
.header-actions { display: flex; gap: 8px; }
.tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.tab-btn { border: 1px solid #e5e6eb; background: #fff; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; color: #4e5969; }
.tab-btn.active { background: #165dff; color: #fff; border-color: #165dff; }
.tab-count { margin-left: 4px; opacity: 0.85; }
.card { background: #fff; border-radius: 8px; padding: 12px; }
.list-empty { text-align: center; color: #a6abb3; padding: 30px 0; }
.pre-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.pre-table th, .pre-table td { padding: 8px 10px; border-bottom: 1px solid #f2f3f5; text-align: left; vertical-align: top; }
.pre-table th { color: #86909c; font-weight: 500; background: #fafbfc; }
.pre-table .num { text-align: right; }
.pre-table .ops { white-space: nowrap; }
.pre-table .sel-col { width: 36px; text-align: center; }
.mono { font-family: 'Courier New', monospace; }
.muted { color: #86909c; font-size: 12px; }
.platform-tag { background: #eef4ff; color: #165dff; border-radius: 4px; padding: 1px 6px; font-size: 12px; }
.status-tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.st-ok { color: #0b7a2d; background: #e8ffea; }
.st-pending { color: #d97706; background: #fff7e6; }
.goods-line { display: flex; gap: 6px; }
.goods-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.goods-qty { color: #f53f3f; flex-shrink: 0; }
.create-modal, .receive-modal { display: flex; flex-direction: column; gap: 12px; }
.platform-tabs { display: flex; gap: 8px; }
.create-toolbar { display: flex; align-items: center; justify-content: space-between; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.form-control { width: 100%; border: 1px solid #e5e6eb; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
.receive-input-row { display: flex; gap: 8px; }
.receive-input-row .form-control { flex: 1; }
.receive-match { border: 1px solid #e5e6eb; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; }
.match-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
</style>
