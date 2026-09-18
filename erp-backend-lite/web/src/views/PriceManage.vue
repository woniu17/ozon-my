<script setup>
// 价格管理(2026-09,商品维度定价基准)
// 设计文档: docs/价格管理-概要设计.md
// 数据流:手动同步 Ozon 价格(本地 product_id 映射 + v5 批量并发)→ 缓存;维护采购价/重量(product_data_cache)
//        → 服务端按共享公式算利润/利润率 → 目标成本利润率反推建议价 → 单品改价(限频/日志/30s回读)
// 公式口径与订单处理页一致(profit-estimator.js 单点维护):佣金16% + 配送 3.37+0.0281×重量,全 CNY
import { ref, computed, onMounted } from 'vue';
import {
  syncPrices, getPriceStores, getPriceList, getPriceSummary,
  setSkuCustoms, getSkuOrders, updatePrice,
} from '../api/price-manage.js';
import { getStores } from '../api/stores.js';
import { useToast } from '../components/useToast.js';
import { useConfirmStore } from '../stores/confirm.js';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();
const confirmStore = useConfirmStore();

// 与后端 profit-estimator.js 同款常量(前端仅做建议价预览,服务端改价时二次校验)
const COMMISSION_RATE = 0.16;
const DELIVERY_BASE_CNY = 3.37;
const DELIVERY_PER_G_CNY = 0.0281;
const TARGET_RATES = [20, 30, 40, 50]; // 按成本利润率定价选项(%)
const DEFAULT_TARGET_RATE = 40;             // 默认选中 40%

const SORTS = [
  { key: 'profitRateCost', label: '成本利润率' },
  { key: 'profitRateSale', label: '销售利润率' },
  { key: 'profit', label: '当前利润' },
  { key: 'price', label: '售价' },
  { key: 'sales90', label: '90天销量' },
  { key: 'purchase', label: '采购价' },
  { key: 'weight', label: '重量' },
  { key: 'syncedAt', label: '最近同步' },
];

// ── 状态 ────────────────────────────────────────────────
// 筛选/排序/店铺选择持久化(localStorage,记住上一次选择)
const VIEW_STATE_KEY = 'pm_view_state';
function loadViewState() {
  try { return JSON.parse(localStorage.getItem(VIEW_STATE_KEY)) || {}; } catch { return {}; }
}
const savedView = loadViewState();

const stores = ref([]);            // [{storeId, count, lastSyncedAt}]
const activeStoreId = ref(savedView.activeStoreId || '');     // '' = 全部店铺
const summary = ref(null);
const rows = ref([]);
const loading = ref(false);
const syncing = ref(false);
const pager = ref({ current: 1, total: 0, pageSize: 20 });
const filters = ref({
  keyword: '', purchaseSet: '', weightSet: '', profitRateMin: '', profitRateMax: '',
  ...(savedView.filters || {}),
});
const sortKey = ref(SORTS.some((s) => s.key === savedView.sortKey) ? savedView.sortKey : 'profitRateCost');
const sortDir = ref(savedView.sortDir === 'desc' ? 'desc' : 'asc'); // 默认升序:最亏的排最前

function persistViewState() {
  try {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({
      activeStoreId: activeStoreId.value,
      filters: filters.value,
      sortKey: sortKey.value,
      sortDir: sortDir.value,
    }));
  } catch { /* 隐私模式等场景忽略 */ }
}
const expanded = ref(new Set());   // 展开的 sku
const ordersMap = ref({});         // sku → 历史订单列表
const ordersLoading = ref({});
const rateChoice = ref({});        // sku → 目标成本利润率(20~60,未选默认20)
const updatingSku = ref('');
const storeNameMap = ref({});                                     // 店铺 id → 名称
const storeName = (storeId) => storeNameMap.value[storeId] || storeId || '—';

// ── 加载 ────────────────────────────────────────────────
// 店铺 tab = 配置店铺(常驻,首次同步前也能选店触发同步) + 缓存统计(count/最近同步)
async function loadStores(keepActive = false) {
  try {
    const [cacheStores, cfgStores] = await Promise.all([getPriceStores(), getStores()]);
    const byId = new Map((cacheStores || []).map((s) => [s.storeId, s]));
    stores.value = (cfgStores || []).map(
      (s) => byId.get(s.id) || { storeId: s.id, count: 0, lastSyncedAt: null }
    );
    // 店铺 id → 名称映射(如 YQL01),用于 tabs 与商品行展示
    storeNameMap.value = Object.fromEntries(
      (cfgStores || []).map((s) => [s.id, s.name || s.id])
    );
    if (!keepActive) activeStoreId.value = '';
    // 记住的店铺已不存在(被删除)时回退全部
    else if (activeStoreId.value && !stores.value.some((s) => s.storeId === activeStoreId.value)) {
      activeStoreId.value = '';
    }
  } catch (e) {
    show(e.message || '店铺分布加载失败', 'error');
  }
}

async function loadList() {
  loading.value = true;
  try {
    const data = await getPriceList({
      storeId: activeStoreId.value || undefined,
      keyword: filters.value.keyword || undefined,
      purchaseSet: filters.value.purchaseSet || undefined,
      weightSet: filters.value.weightSet || undefined,
      profitRateMin: filters.value.profitRateMin || undefined,
      profitRateMax: filters.value.profitRateMax || undefined,
      sort: sortKey.value,
      dir: sortDir.value,
      page: pager.value.current,
      pageSize: pager.value.pageSize,
    });
    rows.value = data.items || [];
    pager.value.total = data.total || 0;
  } catch (e) {
    show(e.message || '列表加载失败', 'error');
  } finally {
    loading.value = false;
  }
}

async function loadSummary() {
  try {
    summary.value = await getPriceSummary();
  } catch { /* 统计条失败不阻塞 */ }
}

async function refreshAll() {
  await Promise.all([loadList(), loadSummary()]);
}

// ── 同步价格(手动,当前店铺或全部店铺顺序同步) ──
async function syncNow() {
  const targets = activeStoreId.value
    ? [activeStoreId.value]
    : stores.value.map((s) => s.storeId).filter(Boolean);
  if (!targets.length) { show('无可用店铺', 'error'); return; }
  if (!(await confirmStore.ask({
    message: `同步 ${targets.length} 个店铺的 Ozon 价格(按本地商品分批并发拉取${targets.length > 1 ? ',店铺间顺序执行,约需数分钟' : ''})?`,
  }))) return;
  syncing.value = true;
  try {
    let total = 0;
    for (const storeId of targets) {
      const r = await syncPrices(storeId);
      total += r.count || 0;
      if (r.note) { show(`店铺 ${storeId}:${r.note}`, 'error'); continue; }
      const failTip = r.failedBatches ? `,${r.failedBatches} 个批次失败` : '';
      show(`店铺 ${storeId}:同步 ${r.count}/${r.localTotal} 个商品价格${failTip}`, r.failedBatches ? 'error' : 'success');
    }
    await loadStores(true);
    await refreshAll();
    if (total > 0) show(`同步完成,共 ${total} 个商品`, 'success');
  } catch (e) {
    show(e.message || '同步失败', 'error');
  } finally {
    syncing.value = false;
  }
}

// ── 行内编辑采购价/重量(失焦保存) ──
const editBuf = {}; // sku → { purchase, weight } 输入缓冲

function editVal(row, field) {
  if (!editBuf[row.sku]) editBuf[row.sku] = {};
  if (editBuf[row.sku][field] === undefined) {
    const v = field === 'purchase' ? row.custom_purchase_price : row.custom_weight;
    editBuf[row.sku][field] = v == null ? '' : String(v);
  }
  return editBuf[row.sku][field];
}

async function saveCell(row, field) {
  const buf = editBuf[row.sku] || {};
  const raw = (buf[field] ?? '').trim();
  const orig = field === 'purchase' ? row.custom_purchase_price : row.custom_weight;
  const origStr = orig == null ? '' : String(orig);
  if (raw === origStr) return; // 未变化
  const body = field === 'purchase' ? { purchasePrice: raw === '' ? null : Number(raw) } : { weightG: raw === '' ? null : Number(raw) };
  if (raw !== '' && !Number.isFinite(body.purchasePrice ?? body.weightG)) {
    show('请输入数字', 'error');
    return;
  }
  try {
    await setSkuCustoms(row.sku, body);
    show('已保存', 'success');
    delete editBuf[row.sku];
    await refreshAll();
  } catch (e) {
    show(e.message || '保存失败', 'error');
  }
}

// ── 展开历史订单 ──
async function toggleExpand(row) {
  const s = expanded.value;
  if (s.has(row.sku)) {
    s.delete(row.sku);
  } else {
    s.add(row.sku);
    if (!ordersMap.value[row.sku]) {
      ordersLoading.value[row.sku] = true;
      try {
        ordersMap.value[row.sku] = await getSkuOrders(row.sku, 20);
      } catch (e) {
        show(e.message || '历史订单加载失败', 'error');
        ordersMap.value[row.sku] = [];
      } finally {
        ordersLoading.value[row.sku] = false;
      }
    }
  }
  expanded.value = new Set(s); // 触发响应
}

// 以此单回填采购价
async function adoptOrderPrice(row, o) {
  if (o.unit_ref_purchase == null) return;
  if (!(await confirmStore.ask({
    message: `以订单 ${o.posting_number} 的单件采购价 ¥${o.unit_ref_purchase} 回填 SKU ${row.sku} 的采购价?`,
  }))) return;
  try {
    await setSkuCustoms(row.sku, { purchasePrice: Number(o.unit_ref_purchase) });
    show('已回填采购价', 'success');
    await refreshAll();
  } catch (e) {
    show(e.message || '保存失败', 'error');
  }
}

// ── 按成本利润率定价 ──
// 当前行选中的目标率(未选时默认 20%)
function selRate(row) {
  return rateChoice.value[row.sku] || DEFAULT_TARGET_RATE;
}

function suggestedPrice(row) {
  const rate = selRate(row);
  const purchase = Number(row.custom_purchase_price);
  const w = Number(row.weight_g);
  if (!(purchase > 0) || !(w > 0)) return null;
  const delivery = DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w;
  // 向上取整到整数元(展示与提交同口径,后端校验同步取整)
  return Math.ceil((purchase * (1 + rate / 100) + delivery) / (1 - COMMISSION_RATE));
}

// 当前利润明细:与后端 listPriceProducts PROFIT 口径完全一致
// 利润 = 售价×(1−佣金率) − 国际物流费(无重量按0,回退打包口径) − 采购价
function currentBreakdown(row) {
  const price = row.price != null ? Number(row.price) : null;
  const purchase = row.custom_purchase_price != null ? Number(row.custom_purchase_price) : null;
  if (price == null || purchase == null) return null;
  const w = row.weight_g != null ? Number(row.weight_g) : null;
  const commission = Math.round(price * COMMISSION_RATE * 100) / 100;
  const delivery = w != null ? Math.round((DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w) * 100) / 100 : 0;
  const profit = Math.round((price - commission - delivery - purchase) * 100) / 100;
  return {
    price, commission, delivery, profit,
    saleRate: price > 0 ? Math.round((profit / price) * 10000) / 100 : null,
    costRate: purchase > 0 ? Math.round((profit / purchase) * 10000) / 100 : null,
  };
}

// 调整利润明细:按选中目标率定价(建议价向上取整)后的真实口径
// 取整后利润 = 建议价 − 佣金 − 配送 − 采购(略高于 采购×r)
// rate 均为百分数刻度(与后端 profit_rate_* 一致,fmtRate 直接展示)
function adjustedProfit(row) {
  const price = suggestedPrice(row);
  if (price == null) return null;
  const purchase = Number(row.custom_purchase_price);
  const w = Number(row.weight_g);
  const commission = Math.round(price * COMMISSION_RATE * 100) / 100;
  const delivery = Math.round((DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w) * 100) / 100;
  const profit = Math.round((price - commission - delivery - purchase) * 100) / 100;
  return {
    price, commission, delivery, profit,
    saleRate: Math.round((profit / price) * 10000) / 100,
    costRate: purchase > 0 ? Math.round((profit / purchase) * 10000) / 100 : null,
  };
}

// 明细 → 展示行(当前/调整两列共用)
function breakdownRows(bd) {
  if (!bd) return null;
  return [
    { k: '销售价格', v: fmtMoney(bd.price) },
    { k: 'ozon佣金', v: fmtMoney(bd.commission) },
    { k: '国际物流费', v: fmtMoney(bd.delivery) },
    { k: '利润', v: fmtMoney(bd.profit), cls: rateClass(bd.profit) },
    { k: '销售利润率', v: fmtRate(bd.saleRate), cls: rateClass(bd.saleRate) },
    { k: '成本利润率', v: fmtRate(bd.costRate), cls: rateClass(bd.costRate) },
  ];
}

function canTarget(row) {
  return Number(row.custom_purchase_price) > 0 && Number(row.weight_g) > 0;
}

async function applyTargetPrice(row) {
  const rate = selRate(row);
  const newPrice = suggestedPrice(row);
  if (newPrice == null) return;
  const old = row.price;
  const delta = old != null ? Math.round(((newPrice - old) / old) * 1000) / 10 : null;
  if (!(await confirmStore.ask({
    message: `确认修改 SKU ${row.sku} 价格?\n${old != null ? `¥${old}` : '无现价'} → ¥${newPrice}${delta != null ? `(${delta > 0 ? '+' : ''}${delta}%)` : ''}\n目标成本利润率 ${rate}%;划线价将设为 ¥${Math.round(newPrice * 2 * 100) / 100}`,
  }))) return;
  updatingSku.value = row.sku;
  try {
    await updatePrice({ sku: row.sku, newPrice, targetRate: rate / 100 });
    show('改价已提交,30秒后自动回读校准', 'success');
    row.price = newPrice;
    row.old_price = Math.round(newPrice * 2 * 100) / 100;
    await loadSummary();
  } catch (e) {
    show(e.message || '改价失败', 'error');
  } finally {
    updatingSku.value = '';
  }
}

// ── 筛选/排序/分页(变更即持久化) ──
function onFilterChange() {
  pager.value.current = 1;
  persistViewState();
  loadList();
}
function toggleSortDir() {
  sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  persistViewState();
  loadList();
}
function onSortChange() {
  persistViewState();
  loadList();
}
function onPageChange(p) {
  pager.value.current = p;
  loadList();
}
function switchStore(storeId) {
  activeStoreId.value = storeId;
  pager.value.current = 1;
  expanded.value = new Set();
  persistViewState();
  loadList();
}

// ── 展示 ────────────────────────────────────────────────
const fmtMoney = (v) => (v == null || v === '' ? '—' : `¥${Number(v).toFixed(2)}`);
const fmtNum = (v, digits = 0) => (v == null ? '—' : Number(v).toFixed(digits));
const fmtRate = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
const fmtTime = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : '—');
const rateClass = (v) => (v == null ? '' : Number(v) >= 0 ? 'pos' : 'neg');

const OPERATE_TEXT = {
  wait_process: '待处理', wait_ship: '待打单发货', ship_success: '交运',
  wait_receiver_confirm: '已发货', cancelled: '已取消',
};

/** Ozon 商品详情页链接(与订单处理页同款) */
function pdpUrl(row) {
  return row?.sku ? `https://ozon.ru/context/detail/id/${row.sku}` : null;
}

/** 复制文本到剪贴板(降级兼容 http 环境,与订单处理页同款) */
async function copyText(val, label) {
  const s = String(val || '').trim();
  if (!s) return;
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  show(`${label}已复制:${s}`, 'success');
}

onMounted(async () => {
  await loadStores(true); // keepActive:恢复记住的店铺选择
  await refreshAll();
});
</script>

<template>
  <div class="pm-page">
    <!-- 工具栏:店铺 tabs + 同步按钮 -->
    <div class="pm-toolbar">
      <div class="store-tabs">
        <button class="store-tab" :class="{ active: activeStoreId === '' }" @click="switchStore('')">全部店铺</button>
        <button
          v-for="s in stores" :key="s.storeId"
          class="store-tab" :class="{ active: activeStoreId === s.storeId }"
          :title="s.storeId"
          @click="switchStore(s.storeId)"
        >{{ storeName(s.storeId) }} ({{ s.count }})</button>
      </div>
      <button class="btn btn-primary" :disabled="syncing" @click="syncNow">
        {{ syncing ? '同步中…' : '同步 Ozon 价格' }}
      </button>
    </div>

    <!-- 统计条 -->
    <div class="pm-summary" v-if="summary">
      <span class="sum-item">商品 <b>{{ summary.total }}</b></span>
      <span class="sum-item">已设采购价 <b>{{ summary.purchaseSet }}</b></span>
      <span class="sum-item">已设重量 <b>{{ summary.weightSet }}</b></span>
      <span class="sum-item sum-warn">成本利润率&lt;20% <b>{{ summary.lowProfit }}</b></span>
    </div>

    <!-- 筛选/排序栏 -->
    <div class="pm-filters">
      <input v-model="filters.keyword" class="input" placeholder="SKU / 名称 / offer_id" @change="onFilterChange" />
      <select v-model="filters.purchaseSet" class="input" @change="onFilterChange">
        <option value="">采购价:全部</option>
        <option value="set">已设</option>
        <option value="unset">未设</option>
      </select>
      <select v-model="filters.weightSet" class="input" @change="onFilterChange">
        <option value="">重量:全部</option>
        <option value="set">已设</option>
        <option value="unset">未设</option>
      </select>
      <span class="rate-range">
        成本率 <input v-model="filters.profitRateMin" class="input input-narrow" placeholder="min" @change="onFilterChange" /> ~
        <input v-model="filters.profitRateMax" class="input input-narrow" placeholder="max" @change="onFilterChange" /> %
      </span>
      <select v-model="sortKey" class="input" @change="onSortChange">
        <option v-for="s in SORTS" :key="s.key" :value="s.key">按{{ s.label }}排序</option>
      </select>
      <button class="btn" @click="toggleSortDir">{{ sortDir === 'asc' ? '↑ 升序' : '↓ 降序' }}</button>
    </div>

    <!-- 商品列表 -->
    <div class="pm-table-wrap">
      <table class="pm-table">
        <thead>
          <tr>
            <th class="col-expand"></th>
            <th class="col-product">商品</th>
            <th class="col-num">售价</th>
            <th class="col-num">90天销量</th>
            <th class="col-num">采购价(本系统)</th>
            <th class="col-num">重量(g)</th>
            <th class="col-num">当前利润</th>
            <th class="col-num">调整利润</th>
            <th class="col-target">按成本利润率定价</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.sku">
            <tr class="row-main" :class="{ open: expanded.has(row.sku) }">
              <td class="col-expand" @click="toggleExpand(row)">
                <span class="caret">{{ expanded.has(row.sku) ? '▾' : '▸' }}</span>
              </td>
              <td class="col-product">
                <div class="prod">
                  <div v-if="row.image" class="img-hover-wrap">
                    <a :href="pdpUrl(row)" target="_blank" rel="noopener" class="product-img-box" :title="row.name || '查看Ozon商品'">
                      <img :src="row.image" class="product-img" loading="lazy" referrerpolicy="no-referrer" alt="" />
                    </a>
                    <img class="img-preview" :src="row.image" loading="lazy" referrerpolicy="no-referrer" alt="" />
                  </div>
                  <div v-else class="product-img-box prod-img-empty">无图</div>
                  <div class="prod-info">
                    <a v-if="row.name" :href="pdpUrl(row)" target="_blank" rel="noopener" class="prod-name" :title="row.name">{{ row.name }}</a>
                    <div v-else class="prod-name">(未同步名称)</div>
                    <div class="prod-sku">{{ storeName(row.store_id) }}</div>
                    <div class="prod-sku">
                      SKU：{{ row.sku }}
                      <button class="copy-btn" title="复制SKU" @click.stop="copyText(row.sku, 'SKU')">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                      </button>
                      <span v-if="row.price_index_color === 'RED'" class="tag tag-warn" title="Ozon 价格指数偏红:价格高于市场">市场红</span>
                      <span v-if="row.sales_percent_fbs != null" class="tag" :title="`v5 实际 FBS 佣金率 ${row.sales_percent_fbs}%`">佣金{{ row.sales_percent_fbs }}%</span>
                    </div>
                    <div v-if="row.offer_id" class="prod-sku">
                      Offer ID：{{ row.offer_id }}
                      <button class="copy-btn" title="复制Offer ID" @click.stop="copyText(row.offer_id, 'Offer ID')">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                      </button>
                    </div>
                  </div>
                </div>
              </td>
              <td class="col-num">{{ fmtMoney(row.price) }}<div v-if="row.old_price" class="sub">划线 ¥{{ row.old_price }}</div></td>
              <td class="col-num">{{ row.sales90 ?? 0 }}</td>
              <td class="col-num">
                <input
                  class="cell-input" :value="editVal(row, 'purchase')"
                  @input="editBuf[row.sku].purchase = $event.target.value"
                  @blur="saveCell(row, 'purchase')" @keyup.enter="$event.target.blur()"
                  placeholder="—" />
              </td>
              <td class="col-num">
                <input
                  class="cell-input" :value="editVal(row, 'weight')"
                  @input="editBuf[row.sku].weight = $event.target.value"
                  @blur="saveCell(row, 'weight')" @keyup.enter="$event.target.blur()"
                  :placeholder="row.weight_g != null ? String(row.weight_g) + '(oz)' : '—'" />
              </td>
              <!-- 当前利润明细:销售价格/ozon佣金/国际物流费/利润/销售利润率/成本利润率 -->
              <td class="col-num col-profit" title="单件口径:售价 − 佣金16% − 国际物流费 − 采购价">
                <template v-if="breakdownRows(currentBreakdown(row))">
                  <div v-for="l in breakdownRows(currentBreakdown(row))" :key="l.k" class="bl" :class="l.cls">
                    <span class="bl-k">{{ l.k }}</span><span>{{ l.v }}</span>
                  </div>
                </template>
                <span v-else class="sub">—</span>
              </td>
              <!-- 调整利润明细:按选中目标率定价后的完整口径 -->
              <td class="col-num col-profit" :title="canTarget(row) ? `按 ${selRate(row)}% 成本利润率定价后的口径` : '需先维护采购价与重量'">
                <template v-if="breakdownRows(adjustedProfit(row))">
                  <div v-for="l in breakdownRows(adjustedProfit(row))" :key="l.k" class="bl" :class="l.cls">
                    <span class="bl-k">{{ l.k }}</span><span>{{ l.v }}</span>
                  </div>
                </template>
                <span v-else class="sub">—</span>
              </td>
              <td class="col-target">
                <div
                  class="target-grid"
                  :title="canTarget(row) ? `按 ${selRate(row)}% 成本利润率定价` : '需先维护采购价与重量'"
                >
                  <!-- 子列1:销售价格/划线价格/最低价 -->
                  <div class="tg-prices">
                    <div class="tg-line">
                      <span class="tg-label">销售价格</span>
                      <b class="suggest">{{ suggestedPrice(row) != null ? '¥' + suggestedPrice(row) : '—' }}</b>
                    </div>
                    <div class="tg-line">
                      <span class="tg-label">划线价格</span>
                      <span>{{ suggestedPrice(row) != null ? '¥' + suggestedPrice(row) * 2 : '—' }}</span>
                    </div>
                    <div class="tg-line">
                      <span class="tg-label">最低价</span>
                      <span>{{ suggestedPrice(row) != null ? '¥' + suggestedPrice(row) : '—' }}</span>
                    </div>
                  </div>
                  <!-- 子列2:目标率选项(竖排) -->
                  <div class="tg-rates">
                    <button
                      v-for="r in TARGET_RATES" :key="r" type="button" class="rate-opt"
                      :class="{ active: selRate(row) === r }"
                      :disabled="!canTarget(row)"
                      @click="rateChoice[row.sku] = r"
                    >{{ r }}%</button>
                  </div>
                  <!-- 子列3:改价按钮 -->
                  <div class="tg-act">
                    <button
                      v-if="canTarget(row)" class="btn btn-sm btn-primary"
                      :disabled="updatingSku === row.sku" @click="applyTargetPrice(row)"
                    >{{ updatingSku === row.sku ? '提交中' : '改价' }}</button>
                  </div>
                </div>
              </td>
            </tr>
            <!-- 展开行:历史订单 -->
            <tr v-if="expanded.has(row.sku)" class="row-orders">
              <td :colspan="9">
                <div v-if="ordersLoading[row.sku]" class="orders-loading">加载历史订单…</div>
                <template v-else-if="(ordersMap[row.sku] || []).length">
                  <div class="orders-title">历史订单(最新 {{ ordersMap[row.sku].length }} 条)</div>
                  <table class="orders-table">
                    <thead>
                      <tr>
                        <th>订单号</th><th>下单时间</th><th>状态</th><th>数量</th>
                        <th>单价</th><th>包裹采购合计</th><th>包裹称重重量</th><th>单件采购价格</th><th>单件称重重量</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="o in ordersMap[row.sku]" :key="o.posting_number">
                        <td class="mono">{{ o.posting_number }}</td>
                        <td>{{ fmtTime(o.in_process_at) }}</td>
                        <td>
                          <span class="tag">{{ OPERATE_TEXT[o.operate_status] || o.operate_status }}</span>
                          <span v-if="o.is_ignored" class="tag tag-warn">搁置</span>
                        </td>
                        <td>{{ o.quantity }}</td>
                        <td>{{ fmtMoney(o.unit_price) }}</td>
                        <td>{{ fmtMoney(o.total_purchase_amount) }}</td>
                        <td>{{ o.pkg_weigh_weight != null ? o.pkg_weigh_weight + ' g' : '—' }}</td>
                        <td>{{ fmtMoney(o.unit_ref_purchase) }}</td>
                        <td>{{ o.unit_weigh_weight != null ? o.unit_weigh_weight + ' g' : '—' }}</td>
                        <td>
                          <button v-if="o.unit_ref_purchase != null" class="btn-link" @click="adoptOrderPrice(row, o)">以此单回填</button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </template>
                <div v-else class="orders-empty">该 SKU 暂无本地订单记录</div>
              </td>
            </tr>
          </template>
          <tr v-if="!loading && rows.length === 0">
            <td :colspan="9" class="empty-tip">
              暂无数据{{ stores.length === 0 ? ',请先点击右上角「同步 Ozon 价格」' : '' }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="loading" class="loading-mask">加载中…</div>
    </div>

    <!-- 分页 -->
    <div class="pm-footer">
      <span class="footer-info">共 {{ pager.total }} 个商品</span>
      <AppPager :modelValue="pager.current" :total="pager.total" :pageSize="pager.pageSize" @update:modelValue="onPageChange" />
    </div>
  </div>
</template>

<style scoped>
.pm-page {
  padding: 16px;
  /* 与订单处理页同款:去掉 1560px 上限,宽屏下表格(≥1900px)全列同屏展示,不横向滚动 */
  margin: 0 auto;
  color: var(--text-primary, #374151);
}

/* 工具栏 */
.pm-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.store-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.store-tab {
  padding: 4px 12px;
  border: 1px solid var(--border, #d1d5db);
  background: var(--bg-card, #fff);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
}
.store-tab.active {
  background: var(--tag-bg, #e0e7ff);
  color: var(--tag-fg, #4338ca);
  border-color: var(--tag-fg, #4338ca);
}

/* 统计条 */
.pm-summary {
  display: flex;
  gap: 18px;
  align-items: center;
  padding: 8px 14px;
  background: var(--bg-card, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--text-secondary, #6b7280);
  flex-wrap: wrap;
}
.sum-item b { color: var(--text-primary, #111827); margin-left: 2px; }
.sum-warn b { color: #b45309; }

/* 筛选栏 */
.pm-filters {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.input {
  padding: 5px 8px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg-card, #fff);
  color: var(--text-primary, #374151);
}
.input:focus { outline: none; border-color: var(--tag-fg, #4338ca); }
.input-narrow { width: 56px; text-align: center; }
.rate-range { font-size: 13px; color: var(--text-secondary, #6b7280); display: flex; align-items: center; gap: 4px; }

.btn {
  padding: 5px 12px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  background: var(--bg-card, #fff);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary, #374151);
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #4338ca; }
.btn-sm { padding: 2px 8px; font-size: 12px; }
.btn-link {
  border: none; background: none; color: #4f46e5; cursor: pointer;
  font-size: 12px; padding: 0 2px; text-decoration: underline;
}

/* 表格 */
.pm-table-wrap { position: relative; overflow-x: auto; background: var(--bg-card, #fff); border: 1px solid var(--border, #e5e7eb); border-radius: 8px; }
/* 表格整体:字体放大 1.4 倍(13→18px),内部小号字同步放大 */
.pm-table { width: 100%; border-collapse: collapse; font-size: 18px; min-width: 1900px; }
.pm-table .sub { font-size: 15px; }
.pm-table .mono { font-size: 17px; }
.pm-table .tag { font-size: 15px; }
.pm-table .btn-sm { font-size: 17px; }
.pm-table thead th {
  text-align: left; padding: 8px 10px;
  background: var(--bg, #f9fafb);
  border-bottom: 1px solid var(--border, #e5e7eb);
  font-weight: 600; white-space: nowrap;
  color: var(--text-secondary, #6b7280);
}
.pm-table tbody td { padding: 7px 10px; border-bottom: 1px solid var(--border, #eef0f3); vertical-align: middle; }
.row-main:hover { background: var(--bg, #f9fafb); }
.row-main.open { background: var(--tag-bg, #eef2ff); }

.col-expand { width: 28px; cursor: pointer; text-align: center; color: var(--text-secondary, #9ca3af); }
.col-num { text-align: right; white-space: nowrap; }
.col-product { min-width: 360px; }
.col-target { min-width: 230px; white-space: nowrap; }

.pos { color: #047857; }
.neg { color: #dc2626; }
.sub { font-size: 11px; color: var(--text-secondary, #9ca3af); font-weight: normal; }
.mono { font-family: monospace; font-size: 12px; }
.tag {
  display: inline-block; padding: 0 6px; border-radius: 4px;
  font-size: 11px; background: var(--tag-bg, #e0e7ff); color: var(--tag-fg, #4338ca);
  margin-left: 4px;
}
.tag-warn { background: #fef3c7; color: #b45309; }

/* 商品列 */
.prod { display: flex; gap: 8px; align-items: flex-start; }
/* 商品图(与订单处理页同款:120×120 缩略图 + hover 右侧 280 大图预览) */
.img-hover-wrap { position: relative; flex-shrink: 0; }
.product-img-box {
  flex: 0 0 120px;
  width: 120px;
  height: 120px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f9fafb;
}
.product-img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
.img-preview {
  display: none;
  position: absolute;
  left: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
  width: 280px;
  height: 280px;
  object-fit: contain;
  background: #fff;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  z-index: 30;
  pointer-events: none;
}
.img-hover-wrap:hover .img-preview { display: block; }
.prod-img-empty {
  display: flex; align-items: center; justify-content: center;
  font-size: 15px; color: var(--text-secondary, #9ca3af); background: var(--bg, #f3f4f6);
}
/* 复制小图标(与订单处理页同款) */
.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  vertical-align: middle;
  border-radius: 3px;
  flex: 0 0 auto;
}
.copy-btn:hover { color: #3b82f6; background: #eff6ff; }
.prod-info { min-width: 0; }
.prod-name {
  font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px;
  color: var(--text-primary, #111827);
}
/* 名称为链接时 */
a.prod-name { text-decoration: none; display: block; }
a.prod-name:hover { color: #4338ca; text-decoration: underline; }
/* 店铺名/SKU/OfferID:黑色字体(与名称区分层级) */
.prod-sku { font-size: 15px; color: var(--text-primary, #111827); margin-top: 3px; }

/* 单元格输入 */
.cell-input {
  width: 84px; padding: 3px 6px; text-align: right;
  border: 1px solid transparent; border-radius: 4px; background: transparent;
  font-size: 18px; color: var(--text-primary, #374151);
}
.cell-input:hover { border-color: var(--border, #d1d5db); background: var(--bg-card, #fff); }
.cell-input:focus { outline: none; border-color: var(--tag-fg, #4338ca); background: var(--bg-card, #fff); }

/* 按成本利润率定价:三子列(价格×目标率×改价按钮) */
.target-grid { display: flex; align-items: center; gap: 14px; white-space: nowrap; }
.tg-prices { display: flex; flex-direction: column; gap: 2px; }
.tg-line { font-size: 17px; }
.tg-label { display: inline-block; color: var(--text-secondary, #6b7280); margin-right: 6px; min-width: 5em; }
.tg-rates { display: flex; flex-direction: column; gap: 3px; }
.tg-act { display: flex; flex-direction: column; align-items: center; justify-content: center; }
.rate-opt {
  padding: 1px 10px; font-size: 15px; line-height: 1.5; border: 1px solid var(--border, #d1d5db);
  border-radius: 4px; background: var(--bg-card, #fff); color: var(--text-secondary, #6b7280); cursor: pointer;
}
.rate-opt:hover:not(:disabled) { border-color: #4338ca; color: #4338ca; }
.rate-opt.active { background: #4338ca; border-color: #4338ca; color: #fff; font-weight: 600; }
.rate-opt:disabled { opacity: .45; cursor: not-allowed; }
.suggest { font-weight: 600; color: #4338ca; }

/* 利润明细列(当前/调整):键值两栏对齐 */
.bl { display: flex; justify-content: space-between; gap: 10px; line-height: 1.55; white-space: nowrap; min-width: 132px; }
.bl-k { color: var(--text-secondary, #6b7280); }

/* 展开订单行 */
.row-orders > td { background: var(--bg, #f9fafb); padding: 10px 14px; }
.orders-title { font-size: 17px; color: var(--text-secondary, #6b7280); margin-bottom: 6px; }
.orders-table { width: 100%; border-collapse: collapse; font-size: 17px; background: var(--bg-card, #fff); }
.orders-table th {
  text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border, #e5e7eb);
  color: var(--text-secondary, #6b7280); font-weight: 500; white-space: nowrap;
}
.orders-table td { padding: 4px 8px; border-bottom: 1px solid var(--border, #f3f4f6); }
.orders-loading, .orders-empty { font-size: 17px; color: var(--text-secondary, #9ca3af); padding: 8px 0; }

.empty-tip { text-align: center; padding: 40px 0; color: var(--text-secondary, #9ca3af); }
.loading-mask { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.6); font-size: 13px; color: var(--text-secondary, #6b7280); }

/* 底部 */
.pm-footer {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 10px; font-size: 13px; color: var(--text-secondary, #6b7280);
}
</style>
