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
        <button class="btn btn-ghost" :disabled="syncing" @click="doSyncTrace">{{ syncing ? '同步中…' : '同步物流轨迹' }}</button>
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
            <th>物流信息 / 轨迹</th>
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
            <td class="logi-cell">
              <div class="mono">{{ (row.logisticsCompany || '') }} {{ row.logisticsNo || '—' }}</div>
              <div v-if="row.lastTraceDesc" class="muted trace-latest" :title="row.lastTraceDesc">{{ fmtTime(row.lastTraceAt) }} {{ row.lastTraceDesc }}</div>
              <div v-if="(row.trace || []).length" class="trace-toggle" @click="toggleTrace(row.id)">
                {{ expanded[row.id] ? '收起轨迹' : `展开轨迹(${row.trace.length})` }}
              </div>
              <div v-if="expanded[row.id]" class="trace-list">
                <div v-for="(t, ti) in row.trace" :key="ti" class="trace-line">
                  <span class="trace-time">{{ fmtTime(t.acceptTime) }}</span>
                  <span class="trace-remark">{{ t.remark }}</span>
                </div>
              </div>
            </td>
            <td>
              <div v-for="(g, i) in (row.items || []).slice(0, 2)" :key="i" class="goods-cell">
                <img v-if="g.thumbUrl || g.picUrl" :src="g.thumbUrl || g.picUrl" class="goods-img" referrerpolicy="no-referrer" loading="lazy" alt="" />
                <div v-else class="goods-img goods-img-empty"></div>
                <div class="goods-info">
                  <span class="goods-name">{{ g.goodsName || g.title || '商品' }}</span>
                  <span class="goods-sub">¥{{ g.price ?? '—' }} × {{ g.number || g.num || g.quantity || 1 }}</span>
                </div>
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
        <!-- 平台×账号 tabs(1688 多账号) -->
        <div class="platform-tabs">
          <button
            v-for="t in createTabs"
            :key="t.key"
            class="tab-btn"
            :class="{ active: createTab === t.key }"
            @click="switchCreateTab(t.key)"
          >
            {{ t.label }}
            <span v-if="loginState(t) === 'no'" class="login-bad" title="登录态可能失效">未登录</span>
          </button>
        </div>

        <!-- 订单号搜索 -->
        <div class="search-row">
          <input
            v-model="createSearch.keyword"
            class="form-control"
            placeholder="输入订单号精确搜索(可跨该平台账号)"
            @keyup.enter="doSearchOrder"
          />
          <button class="btn btn-primary" :disabled="createSearch.loading" @click="doSearchOrder">
            {{ createSearch.loading ? '搜索中…' : '搜索' }}
          </button>
          <button class="btn btn-ghost" :disabled="create.loading" @click="loadOrders">
            {{ create.loading ? '拉取中…' : '刷新列表' }}
          </button>
        </div>
        <div v-if="createSearch.error" class="search-err">{{ createSearch.error }}</div>

        <div class="create-toolbar">
          <span class="muted">已选 {{ createSelectedCount }} 笔 · 当前 {{ currentGoodsCount }} 笔订单</span>
        </div>

        <div v-if="create.loading" class="list-empty">正在拉取订单…</div>
        <div v-else-if="create.error" class="list-empty">{{ create.error }}</div>
        <div v-else-if="!currentPostings.length" class="list-empty">该平台/账号暂无可选订单，或使用上方订单号搜索</div>
        <table v-else class="pre-table">
          <thead>
            <tr>
              <th class="sel-col"><input type="checkbox" :checked="curStore.allSelected" @change="toggleCreateAll" /></th>
              <th>订单号</th>
              <th>商品</th>
              <th class="num">金额</th>
              <th>快递单号(可改)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in currentPostings" :key="o.orderSn">
              <td class="sel-col"><input type="checkbox" v-model="curStore.selected[o.orderSn]" @change="syncCreateSelectedCount" /></td>
              <td class="mono">
                {{ o.orderSn }}
                <span
                  v-if="linkedCount(currentTabDef?.platform, o.orderSn)"
                  class="linked-tag"
                  :title="`该平台订单已在现有采购中关联了 ${linkedCount(currentTabDef?.platform, o.orderSn)} 个 Ozon 包裹`"
                >已关联包裹</span>
              </td>
              <td>
                <div v-for="(g, gi) in (o.goods || []).slice(0, 3)" :key="gi" class="goods-cell">
                  <img v-if="g.thumbUrl || g.picUrl" :src="g.thumbUrl || g.picUrl" class="goods-img" referrerpolicy="no-referrer" loading="lazy" alt="" />
                  <div v-else class="goods-img goods-img-empty"></div>
                  <div class="goods-info">
                    <span class="goods-name">{{ g.goodsName || g.title || '商品' }}</span>
                    <span class="goods-sub">{{ g.spec ? g.spec + ' · ' : '' }}¥{{ g.price ?? '—' }} × {{ g.number || g.num || 1 }}</span>
                  </div>
                </div>
              </td>
              <td class="num">{{ fmtMoney(orderAmount(o)) }}</td>
              <td><input v-model="curStore.logistics[o.orderSn]" class="form-control" :placeholder="o.trackingNumber || '快递单号'" /></td>
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
          <input ref="receiveInputRef" v-model="receive.code" class="form-control" placeholder="快递单号" @keyup.enter="searchReceive" />
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
import { ref, reactive, computed, nextTick, onMounted } from 'vue';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import { useToast } from '../components/useToast.js';
import { listPrePurchases, createPrePurchase, deletePrePurchase, receivePrePurchase, receiveByCode, checkLinked, syncTrace } from '../api/pre-purchase.js';
import { getPlatformOrders, searchPlatformOrder, getPlatformOrdersStatus } from '../api/order-process.js';

const { show } = useToast();

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待收货' },
  { key: 'received', label: '签收' },
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

// 物流轨迹展开/收起
const expanded = reactive({});
function toggleTrace(id) { expanded[id] = !expanded[id]; }

// 手动同步物流轨迹
const syncing = ref(false);
async function doSyncTrace() {
  syncing.value = true;
  try {
    await syncTrace();
    show('已触发物流轨迹同步,稍后自动刷新', 'success');
    setTimeout(loadList, 15000);
    setTimeout(loadList, 60000);
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    syncing.value = false;
  }
}
async function removeRow(row) {
  if (!confirm(`确认删除预采购单 ${row.purchaseSn || row.id}？`)) return;
  try {
    await deletePrePurchase(row.id);
    show('已删除', 'success');
    loadList();
  } catch (e) { show(e.message || String(e), 'error'); }
}

// ── 新增预采购(平台×账号 tabs) ──
const PLATFORM_META = {
  pdd: { prefix: 'pdd', platform: 'pdd', label: '拼多多' },
  ali1688: { prefix: 'ali', platform: 'ali1688', label: '1688' },
  taobao: { prefix: 'taobao', platform: 'taobao', label: '淘宝' },
  xianyu: { prefix: 'xianyu', platform: 'xianyu', label: '闲鱼' },
};
const platformLogin = reactive({});
const createTabs = ref([
  { key: 'pdd', platform: 'pdd', account: '', label: '拼多多' },
  { key: 'ali', platform: 'ali1688', account: '', label: '1688' },
  { key: 'taobao', platform: 'taobao', account: '', label: '淘宝' },
  { key: 'xianyu', platform: 'xianyu', account: '', label: '闲鱼' },
]);
const createTab = ref('pdd');
const createSearch = reactive({ keyword: '', loading: false, error: '' });

function rebuildAccountTabs(platforms) {
  const tabs = [];
  for (const [platform, meta] of Object.entries(PLATFORM_META)) {
    const accounts = Object.keys(platforms?.[platform]?.accounts || {});
    if (!accounts.length) {
      tabs.push({ key: meta.prefix, platform, account: '', label: meta.label });
      continue;
    }
    const multi = accounts.length > 1;
    for (const account of accounts) {
      tabs.push({
        key: multi ? `${meta.prefix}:${account}` : meta.prefix,
        platform, account,
        label: multi ? `${meta.label}·${account}` : meta.label,
      });
    }
  }
  createTabs.value = tabs;
  if (!tabs.some((t) => t.key === createTab.value)) createTab.value = tabs[0].key;
}
function loginState(t) { return platformLogin[`${t.platform}:${t.account}`] || 'unknown'; }

const createStores = reactive({});
// 已关联 Ozon 包裹的平台订单标记:key="platform:orderSn" → 关联包裹数
const linkedMap = reactive({});
async function markLinked(platform, orders) {
  if (!platform || !orders?.length) return;
  try {
    const r = await checkLinked(orders.map((o) => ({ platform, purchaseSn: o.orderSn })));
    const linked = r?.linked || r?.data?.linked || {};
    Object.assign(linkedMap, linked);
  } catch { /* 忽略:标记失败不影响选单 */ }
}
function linkedCount(platform, sn) {
  if (!platform || !sn) return 0;
  return linkedMap[`${platform}:${sn}`] || 0;
}
function storeFor(key) {
  if (!createStores[key]) {
    createStores[key] = { orders: [], searched: [], loading: false, error: '', selected: {}, logistics: {}, allSelected: false };
  }
  return createStores[key];
}
const curStore = computed(() => storeFor(createTab.value));
const currentTabDef = computed(() => createTabs.value.find((t) => t.key === createTab.value) || null);
const currentPostings = computed(() => {
  const st = curStore.value;
  const map = new Map();
  for (const o of st.orders) map.set(o.orderSn, o);
  for (const o of st.searched) map.set(o.orderSn, o);
  return [...map.values()];
});
const currentGoodsCount = computed(() => currentPostings.value.length);
const createSelectedCount = ref(0);
function syncCreateSelectedCount() {
  let n = 0;
  for (const st of Object.values(createStores)) n += Object.values(st.selected).filter(Boolean).length;
  createSelectedCount.value = n;
}

const create = reactive({ open: false, saving: false, loading: false, error: '' });

async function loadStatus() {
  try {
    const data = await getPlatformOrdersStatus();
    rebuildAccountTabs(data.platforms || {});
    for (const [plat, info] of Object.entries(data.platforms || {})) {
      for (const [account, v] of Object.entries(info?.accounts || {})) {
        platformLogin[`${plat}:${account}`] = v?.login || 'unknown';
      }
    }
  } catch { /* 静默 */ }
}

async function openCreate() {
  create.open = true;
  createSearch.keyword = '';
  createSearch.error = '';
  await loadStatus();
  loadOrders();
}

function switchCreateTab(key) {
  if (createTab.value === key) return;
  createTab.value = key;
  createSearch.keyword = '';
  createSearch.error = '';
  loadOrders();
}

async function loadOrders() {
  const def = currentTabDef.value;
  if (!def) return;
  const st = storeFor(createTab.value);
  st.loading = true;
  st.error = '';
  create.loading = true;
  try {
    const params = { tab: 'all', size: 30 };
    if (def.account) params.account = def.account;
    const r = await getPlatformOrders(def.platform, params);
    st.orders = (r?.orders || []).map(normalizeOrder);
    st.searched = [];
    if (!st.orders.length) st.error = '该平台/账号暂无可选订单';
    markLinked(def.platform, st.orders);
  } catch (e) {
    st.error = e.message || String(e);
    st.orders = [];
  } finally {
    st.loading = false;
    create.loading = false;
  }
}

function normalizeOrder(o) {
  return {
    orderSn: o.orderSn || o.order_sn,
    amount: o.amount,
    paidAmount: o.paidAmount,
    trackingNumber: o.trackingNumber || o.logisticsNo || '',
    logisticsCompany: o.logisticsCompany || '',
    sellerName: o.sellerName || '',
    buyerAccount: o.buyerAccount || '',
    buyerUserId: o.buyerUserId || '',
    goods: o.goods || [],
  };
}

async function doSearchOrder() {
  const sn = createSearch.keyword.trim();
  const def = currentTabDef.value;
  if (!sn || !def) return;
  createSearch.loading = true;
  createSearch.error = '';
  const st = storeFor(createTab.value);
  try {
    const r = await searchPlatformOrder(def.platform, sn, def.account);
    const result = r?.result || r?.data?.result;
    if (result) {
      st.searched = [normalizeOrder(result)];
      st.selected[result.orderSn || sn] = true;
      syncCreateSelectedCount();
      markLinked(def.platform, st.searched);
    } else {
      createSearch.error = `未找到订单 ${sn}（单号不存在，或不属于当前账号 ${def.account || '主账号'}）`;
    }
  } catch (e) {
    createSearch.error = e.message || String(e);
  } finally {
    createSearch.loading = false;
  }
}

function toggleCreateAll(e) {
  const checked = !!e?.target?.checked;
  const st = curStore.value;
  st.allSelected = checked;
  for (const o of currentPostings.value) st.selected[o.orderSn] = checked;
  syncCreateSelectedCount();
}

function orderAmount(o) { return o.paidAmount != null ? o.paidAmount : o.amount; }

async function submitCreate() {
  // 收集所有 tab 下勾选的订单
  const picked = [];
  for (const t of createTabs.value) {
    const st = createStores[t.key];
    if (!st) continue;
    const map = new Map();
    for (const o of st.orders) map.set(o.orderSn, o);
    for (const o of st.searched) map.set(o.orderSn, o);
    for (const o of map.values()) {
      if (st.selected[o.orderSn]) {
        picked.push({ def: t, order: o, logistics: (st.logistics[o.orderSn] || o.trackingNumber || '').trim() });
      }
    }
  }
  if (!picked.length) return;
  create.saving = true;
  let ok = 0;
  try {
    for (const { def, order, logistics } of picked) {
      await createPrePurchase({
        platform: def.platform,
        purchaseSn: order.orderSn,
        buyerAccount: order.buyerAccount,
        buyerUserId: order.buyerUserId,
        sellerName: order.sellerName,
        paymentAmount: orderAmount(order),
        goodsAmount: orderAmount(order),
        logisticsCompany: order.logisticsCompany,
        logisticsNo: logistics || null,
        poStatus: 'shipped',
        items: order.goods || [],
        platformGoods: order.goods || [],
      });
      ok++;
    }
    show(`已新增 ${ok} 笔预采购`, 'success');
    create.open = false;
    // 清空勾选
    for (const st of Object.values(createStores)) { st.selected = {}; st.logistics = {}; st.allSelected = false; }
    createSelectedCount.value = 0;
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
.tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.tab-btn { border: 1px solid #e5e6eb; background: #fff; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; color: #4e5969; }
.tab-btn.active { background: #165dff; color: #fff; border-color: #165dff; }
.tab-count { margin-left: 4px; opacity: 0.85; }
.login-bad { color: #f53f3f; font-size: 11px; margin-left: 4px; }
.linked-tag { display: inline-block; margin-left: 6px; color: #d97706; background: #fff7e6; border-radius: 4px; padding: 0 6px; font-size: 11px; white-space: nowrap; }
.logi-cell { max-width: 240px; }
.trace-latest { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.trace-toggle { color: #165dff; font-size: 12px; cursor: pointer; margin-top: 2px; }
.trace-list { margin-top: 4px; border-top: 1px dashed #e5e6eb; padding-top: 4px; max-height: 180px; overflow-y: auto; }
.trace-line { font-size: 11px; color: #4e5969; display: flex; gap: 6px; padding: 2px 0; }
.trace-time { color: #86909c; flex-shrink: 0; }
.trace-remark { flex: 1; word-break: break-all; }
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
.goods-cell { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 6px; }
.goods-img { width: 42px; height: 42px; border-radius: 4px; object-fit: cover; background: #f2f3f5; flex-shrink: 0; }
.goods-img-empty { background: #f2f3f5; }
.goods-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.goods-sub { color: #86909c; font-size: 12px; }
.create-modal, .receive-modal { display: flex; flex-direction: column; gap: 12px; }
.platform-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.search-row { display: flex; gap: 8px; }
.search-row .form-control { flex: 1; }
.search-err { color: #f53f3f; font-size: 12px; }
.create-toolbar { display: flex; align-items: center; justify-content: space-between; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.form-control { width: 100%; border: 1px solid #e5e6eb; border-radius: 6px; padding: 6px 10px; font-size: 13px; }
.receive-input-row { display: flex; gap: 8px; }
.receive-input-row .form-control { flex: 1; }
.receive-match { border: 1px solid #e5e6eb; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; }
.match-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
</style>
