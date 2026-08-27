<script setup>
// 价格优势监控看板:我的商品价 vs 跟卖报价(最低价/中位数/排名/价差)
// 数据来源:qxqx/price-watch-collect.js 定期采集上报的快照(price_watch_snapshots)
// 任务为派生视图,本页只读;采集入口:qxqx 目录 node price-watch-collect.js
import { ref, reactive, onMounted } from 'vue';
import { getPriceWatchStats, getPriceWatchList, getPriceWatchDetail } from '../api/price-watch.js';
import { getStores } from '../api/stores.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();

// 统计与店铺同步信息
const stats = ref({});
const syncInfo = ref([]);

// 店铺下拉
const storeOptions = ref([]);

// 列表
const items = ref([]);
const loading = ref(false);

// 展开行(单展开:当前展开的 sku)
const expandedSku = ref('');
const expandLoading = ref(false);
const detail = ref(null); // { latest, history }

// 筛选
const filters = reactive({
  storeId: '',
  position: '', // '' | 'cheapest' | 'behind' | 'no-follow'
  keyword: '',
  gapPctMin: '',
  gapPctMax: '',
});

// 分页
const pager = reactive({ current: 1, total: 0, pageSize: 20 });

// ── 数据加载 ───────────────────────────────────────────────
async function loadStats() {
  try {
    const d = await getPriceWatchStats();
    stats.value = d?.dist || {};
    syncInfo.value = d?.syncInfo || [];
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function loadStores() {
  try {
    const d = await getStores();
    storeOptions.value = d?.items || d || [];
  } catch {
    /* 店铺列表加载失败不阻断看板 */
  }
}

async function loadList() {
  loading.value = true;
  try {
    const d = await getPriceWatchList({
      currentPage: pager.current,
      pageSize: pager.pageSize,
      storeId: filters.storeId,
      position: filters.position,
      keyword: filters.keyword.trim(),
      gapPctMin: filters.gapPctMin,
      gapPctMax: filters.gapPctMax,
    });
    items.value = d?.items || [];
    pager.total = d?.total || 0;
    expandedSku.value = '';
    detail.value = null;
  } catch (err) {
    show(err.message || String(err), 'error');
    items.value = [];
    pager.total = 0;
  } finally {
    loading.value = false;
  }
}

function search() {
  pager.current = 1;
  loadList();
}

function onPageChange(p) {
  pager.current = p;
  loadList();
}

function refreshAll() {
  loadStats();
  loadList();
}

// ── 行展开:加载跟卖明细 + 历史 ────────────────────────────
async function toggleExpand(row) {
  if (expandedSku.value === row.sku) {
    expandedSku.value = '';
    detail.value = null;
    return;
  }
  expandedSku.value = row.sku;
  detail.value = null;
  expandLoading.value = true;
  try {
    detail.value = await getPriceWatchDetail(row.sku, 30);
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    expandLoading.value = false;
  }
}

// ── 展示工具 ───────────────────────────────────────────────
// 价格数字解析(与后端 parsePriceText 同规则:"1 990 ₽" → 1990)
// price 原始对象已知两种形态:{cardPrice:{price:"65,29 ¥"}} 与 {originalPrice:"657,01 ¥",price:"657,01 ¥"}
const _plain = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
function parsePrice(raw) {
  if (raw == null) return null;
  const text =
    _plain(raw) ??
    (typeof raw === 'object'
      ? _plain(raw.cardPrice?.price) ??
        _plain(raw.cardPrice?.text) ??
        _plain(raw.cardPrice) ??
        _plain(raw.text) ??
        _plain(raw.price) ??
        _plain(raw.originalPrice) ??
        ''
      : '');
  const m = text.replace(/\s|\u00A0/g, '').match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// 卖家报价展示文本(price 对象 → 文本),解析不出任何字段时返回 '—' 而非 "[object Object]"
function sellerPriceText(s) {
  const raw = s?.price;
  if (raw == null) return '—';
  const text =
    _plain(raw) ??
    (typeof raw === 'object'
      ? _plain(raw.cardPrice?.price) ??
        _plain(raw.cardPrice?.text) ??
        _plain(raw.cardPrice) ??
        _plain(raw.text) ??
        _plain(raw.price) ??
        _plain(raw.originalPrice)
      : null);
  return text != null ? text : '—';
}

// 明细卖家按价格升序(解析失败的排尾部)
function sortedSellers() {
  const list = detail.value?.latest?.sellers || [];
  return [...list].sort((a, b) => {
    const pa = parsePrice(a.price);
    const pb = parsePrice(b.price);
    if (pa == null && pb == null) return 0;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  });
}

function fmtNum(v, digits = 2) {
  if (v == null) return '—';
  return Number(v).toFixed(digits).replace(/\.?0+$/, (m) => (m.includes('.') ? '' : m));
}

function fmtInt(v) {
  if (v == null) return '—';
  return String(v);
}

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return String(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 我的价格是否滞后(>48h 提示)
function isPriceStale(row) {
  if (!row?.price_fetched_at) return false;
  const t = Date.parse(row.price_fetched_at);
  return Number.isFinite(t) && Date.now() - t > 48 * 3600 * 1000;
}

function storeLabel(storeId) {
  const s = storeOptions.value.find?.((x) => x.id === storeId || x.storeId === storeId);
  return s?.name || storeId || '—';
}

// 徽标:优势状态
function badge(row) {
  if (row.status === 'error') return { cls: 'tag tag-err', label: '采集失败' };
  if (!row.seller_count) return { cls: 'tag tag-mute', label: '无跟卖' };
  if (row.is_cheapest === 1) return { cls: 'tag tag-ok', label: '最低价' };
  return { cls: 'tag tag-warn', label: '落后' };
}

// vs 中位数箭头
function vsMedianMark(row) {
  if (row.vs_median === 'above') return '▲ 高于中位';
  if (row.vs_median === 'below') return '▼ 低于中位';
  if (row.vs_median === 'equal') return '＝ 持平';
  return '—';
}

function vsMedianCls(row) {
  if (row.vs_median === 'above') return 'vs-above';
  if (row.vs_median === 'below') return 'vs-below';
  return 'vs-equal';
}

// ── 生命周期 ───────────────────────────────────────────────
onMounted(() => {
  loadStores();
  refreshAll();
});
</script>

<template>
  <div class="price-watch-page">
    <!-- 统计卡片 -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">监控 SKU</div>
        <div class="stat-value">{{ stats.total || 0 }}</div>
        <div class="stat-sub">最新快照覆盖</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">有价格优势</div>
        <div class="stat-value stat-ok">{{ stats.cheapest || 0 }}</div>
        <div class="stat-sub">我的价 ≤ 全场最低</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">价格落后</div>
        <div class="stat-value stat-err">{{ stats.behind || 0 }}</div>
        <div class="stat-sub">高于跟卖最低价</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">无跟卖</div>
        <div class="stat-value">{{ stats.no_follow || stats.noFollow || 0 }}</div>
        <div class="stat-sub">独占商品</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">采集失败</div>
        <div class="stat-value" :class="{ 'stat-err': stats.error > 0 }">{{ stats.error || 0 }}</div>
        <div class="stat-sub">可 FORCE=1 重采</div>
      </div>
    </div>

    <!-- 价格缓存滞后提醒 -->
    <div v-if="stats.stalePrice > 0" class="stale-tip">
      ⚠ {{ stats.stalePrice }} 个 SKU 的价格缓存超过 48h,对比结果可能失真——请先在「商品列表」页同步商品价格。
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="filter-bar">
        <select v-model="filters.storeId" class="filter-input" @change="search">
          <option value="">全部店铺</option>
          <option v-for="s in storeOptions" :key="s.id || s.storeId" :value="s.id || s.storeId">
            {{ s.name || s.id || s.storeId }}
          </option>
        </select>
        <select v-model="filters.position" class="filter-input" @change="search">
          <option value="">全部状态</option>
          <option value="cheapest">有优势</option>
          <option value="behind">落后</option>
          <option value="no-follow">无跟卖</option>
        </select>
        <input
          class="filter-input"
          type="text"
          v-model.trim="filters.keyword"
          placeholder="SKU / 卖家名"
          @keydown.enter="search"
        />
        <input class="filter-input num" type="number" v-model.trim="filters.gapPctMin" placeholder="价差% ≥" @keydown.enter="search" />
        <input class="filter-input num" type="number" v-model.trim="filters.gapPctMax" placeholder="价差% ≤" @keydown.enter="search" />
        <button class="btn btn-primary" @click="search">查询</button>
        <button class="btn btn-ghost" @click="refreshAll" :disabled="loading">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
      <div class="sync-info">
        <span v-for="s in syncInfo" :key="s.storeId" class="sync-item">
          {{ storeLabel(s.storeId) }}:{{ s.skuCount }} SKU / 缓存 {{ fmtTime(s.lastSyncAt) }}
        </span>
      </div>
    </div>

    <!-- 快照列表 -->
    <div class="table-wrap">
      <table class="data-table pw-table">
        <thead>
          <tr>
            <th class="col-expand"></th>
            <th class="col-sku">SKU</th>
            <th>Offer ID</th>
            <th>店铺</th>
            <th>我的价</th>
            <th>跟卖数</th>
            <th>最低价</th>
            <th>中位价</th>
            <th>我的排名</th>
            <th>价差(vs最低)</th>
            <th>vs 中位价</th>
            <th>状态</th>
            <th class="col-time">快照时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!items.length">
            <td colspan="13" class="empty">
              {{ loading ? '加载中…' : '暂无快照数据——在 qxqx 目录运行 node price-watch-collect.js 采集' }}
            </td>
          </tr>
          <template v-for="row in items" :key="row.sku">
            <tr :class="{ 'row-open': expandedSku === row.sku }">
              <td class="col-expand" @click="toggleExpand(row)" title="展开/收起详情">{{ expandedSku === row.sku ? '▾' : '▸' }}</td>
              <td class="col-sku">{{ row.sku }}</td>
              <td class="col-sku">{{ row.offer_id || '—' }}</td>
              <td class="col-store">{{ storeLabel(row.store_id) }}</td>
              <td>
                <span :class="{ 'price-stale': isPriceStale(row) }">{{ fmtNum(row.my_price) }}</span>
                <span v-if="isPriceStale(row)" class="stale-mark" title="价格缓存超过48h">⏳</span>
              </td>
              <td>{{ fmtInt(row.seller_count) }}</td>
              <td class="price-min">{{ fmtNum(row.min_price) }}</td>
              <td>{{ fmtNum(row.median_price) }}</td>
              <td>
                <template v-if="row.my_rank != null">#{{ row.my_rank }}<span class="rank-total">/{{ row.seller_count }}</span></template>
                <template v-else>—</template>
              </td>
              <td>
                <template v-if="row.gap_abs != null">
                  <span :class="row.gap_abs > 0 ? 'gap-up' : 'gap-down'">
                    {{ row.gap_abs > 0 ? '+' : '' }}{{ fmtNum(row.gap_abs) }}
                  </span>
                  <span v-if="row.gap_pct != null" class="gap-pct">({{ row.gap_pct > 0 ? '+' : '' }}{{ fmtNum(row.gap_pct, 1) }}%)</span>
                </template>
                <template v-else>—</template>
              </td>
              <td :class="vsMedianCls(row)">{{ vsMedianMark(row) }}</td>
              <td><span :class="badge(row).cls">{{ badge(row).label }}</span></td>
              <td class="col-time">{{ fmtTime(row.fetched_at) }}</td>
            </tr>
            <tr v-if="expandedSku === row.sku" class="expand-row">
              <td colspan="13">
                <div v-if="expandLoading" class="expand-loading">明细加载中…</div>
                <template v-else-if="detail">
                  <!-- 采集失败原因 -->
                  <div v-if="row.status === 'error'" class="expand-error">
                    失败原因:{{ row.error_reason || 'unknown' }} —— 可 FORCE=1 重采该 SKU
                  </div>
                  <!-- 无跟卖 -->
                  <div v-else-if="!row.seller_count" class="expand-empty">
                    无跟卖报价(独占商品)
                  </div>
                  <!-- 跟卖明细 -->
                  <template v-else>
                    <div class="expand-title">跟卖卖家明细(按价格升序,共 {{ detail.latest?.sellers?.length || 0 }} 家)</div>
                    <table class="data-table seller-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>卖家</th>
                          <th>报价</th>
                          <th>报价 SKU</th>
                          <th>卖家 ID</th>
                          <th>链接</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(s, i) in sortedSellers()" :key="(s.id || s.sku || i) + '-' + i">
                          <td>{{ i + 1 }}</td>
                          <td class="col-seller">
                            <img v-if="s.logoImageUrl" :src="s.logoImageUrl" class="seller-logo" alt="" loading="lazy" />
                            {{ s.name || '—' }}
                          </td>
                          <td class="price-min">{{ sellerPriceText(s) }}</td>
                          <td class="col-sku">{{ s.sku || '—' }}</td>
                          <td class="col-sku">{{ s.id || '—' }}</td>
                          <td>
                            <a v-if="s.productLink || s.link" :href="s.productLink || s.link" target="_blank" rel="noopener noreferrer">打开</a>
                            <span v-else>—</span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </template>
                  <!-- 快照历史 -->
                  <div v-if="detail.history && detail.history.length > 1" class="expand-title hist-title">
                    近 30 天历史({{ detail.history.length }} 条)
                  </div>
                  <table v-if="detail.history && detail.history.length > 1" class="data-table seller-table hist-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>我的价</th>
                        <th>最低价</th>
                        <th>中位价</th>
                        <th>跟卖数</th>
                        <th>排名</th>
                        <th>价差</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="h in detail.history" :key="h.id">
                        <td class="col-time">{{ fmtTime(h.fetched_at) }}</td>
                        <td>{{ fmtNum(h.my_price) }}</td>
                        <td>{{ fmtNum(h.min_price) }}</td>
                        <td>{{ fmtNum(h.median_price) }}</td>
                        <td>{{ fmtInt(h.seller_count) }}</td>
                        <td>{{ h.my_rank != null ? '#' + h.my_rank : '—' }}</td>
                        <td>{{ h.gap_abs != null ? (h.gap_abs > 0 ? '+' : '') + fmtNum(h.gap_abs) : '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </template>
                <div v-else class="expand-loading">明细加载失败</div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="footer-bar">
      <span class="footer-info">共 {{ pager.total }} 个 SKU(点击行首 ▸ 展开跟卖明细)</span>
      <AppPager
        :modelValue="pager.current"
        :total="pager.total"
        :pageSize="pager.pageSize"
        @update:modelValue="onPageChange"
      />
    </div>
  </div>
</template>

<style scoped>
.price-watch-page {
  padding: 16px;
  max-width: 1400px;
  margin: 0 auto;
}

/* 统计卡片 */
.stats-row {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.stat-card {
  flex: 1;
  min-width: 140px;
  background: var(--bg-card, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 12px 16px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary, #111827);
}

.stat-ok { color: #16a34a; }
.stat-err { color: #ef4444; }

.stat-sub {
  font-size: 11px;
  color: var(--text-secondary, #9ca3af);
  margin-top: 2px;
}

/* 滞后提醒 */
.stale-tip {
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  margin-bottom: 12px;
}

/* 工具栏 */
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.filter-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.filter-input {
  padding: 6px 10px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  font-size: 13px;
  background: var(--bg-card, #fff);
  color: var(--text-primary, #111827);
  min-width: 80px;
}

.filter-input.num {
  width: 90px;
  min-width: 90px;
}

.sync-info {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-secondary, #9ca3af);
  align-items: center;
}

/* 表格 */
.pw-table {
  font-size: 12px;
}

.pw-table th,
.pw-table td {
  text-align: center;
  white-space: nowrap;
}

.pw-table tbody tr {
  cursor: default;
}

.row-open {
  background: var(--bg-hover, #f0f9ff);
}

.col-expand {
  width: 24px;
  color: var(--text-secondary, #9ca3af);
  cursor: pointer;
  user-select: none;
}

.col-sku {
  text-align: left;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
}

.col-store {
  text-align: left;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.col-time {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
}

.price-min {
  color: #16a34a;
  font-weight: 600;
}

.price-stale {
  color: #f59e0b;
}

.stale-mark {
  margin-left: 2px;
  font-size: 11px;
}

.rank-total {
  color: var(--text-secondary, #9ca3af);
  font-size: 11px;
}

.gap-up { color: #ef4444; font-weight: 600; }
.gap-down { color: #16a34a; font-weight: 600; }
.gap-pct { color: var(--text-secondary, #9ca3af); font-size: 11px; margin-left: 2px; }

.vs-above { color: #ef4444; }
.vs-below { color: #16a34a; }
.vs-equal { color: var(--text-secondary, #6b7280); }

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
.tag-mute { background: #f3f4f6; color: #6b7280; }

.empty {
  text-align: center;
  padding: 32px 0;
  color: var(--text-secondary, #9ca3af);
}

/* 展开行 */
.expand-row td {
  background: var(--bg-hover, #f8fafc);
  padding: 12px 16px;
  white-space: normal;
  cursor: default;
}

.expand-loading,
.expand-empty {
  color: var(--text-secondary, #9ca3af);
  font-size: 12px;
  padding: 8px 0;
}

.expand-error {
  color: #ef4444;
  font-size: 12px;
  padding: 8px 0;
}

.expand-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary, #111827);
  margin: 8px 0;
}

.hist-title {
  margin-top: 16px;
}

.seller-table {
  font-size: 12px;
  background: var(--bg-card, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
}

.seller-table th,
.seller-table td {
  padding: 4px 10px;
  text-align: left;
  white-space: nowrap;
}

.col-seller {
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.seller-logo {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  vertical-align: -3px;
  margin-right: 4px;
}

.hist-table td {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
}

.footer-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
  flex-wrap: wrap;
  gap: 8px;
}

.footer-info {
  font-size: 12px;
  color: var(--text-secondary, #6b7280);
}
</style>
