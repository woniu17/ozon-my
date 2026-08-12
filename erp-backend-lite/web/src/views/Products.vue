<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import {
  getProducts,
  getProductDetail,
  syncProducts,
  syncProductDescriptions,
  getSyncProgress,
  deleteProduct as deleteProductApi,
  deleteProductsBatch,
} from '../api/products.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import AppAccordion from '../components/AppAccordion.vue';
import JsonTree from '../components/JsonTree.vue';
import ImageRefreshDialog from '../components/ImageRefreshDialog.vue';
import StockRefreshDialog from '../components/StockRefreshDialog.vue';
import ProductUpdateDialog from '../components/ProductUpdateDialog.vue';
import DeepCollectByProductsDialog from '../components/DeepCollectByProductsDialog.vue';
import { useConfirmStore } from '../stores/confirm.js';

const router = useRouter();
const route = useRoute();
const storesStore = useStoresStore();
const { show } = useToast();
const confirmStore = useConfirmStore();

// ── 列表状态 ───────────────────────────────────────────────
const state = reactive({
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 20,
  // 各状态数量(口径 A:排除 productStatus 筛选,后端返回)
  // { all, saleable, created_no_stock, pending_creation, rejected, other }
  statusCounts: { all: 0, saleable: 0, created_no_stock: 0, pending_creation: 0, rejected: 0, other: 0 },
  filters: {
    storeId: '',
    keyword: '',
    productStatus: '', // 简化状态(2026-07):'' 全部 | saleable/created_no_stock/pending_creation/rejected/other
    hasStock: '', // '' 全部 | '1' 有库存 | '0' 无库存
    imageIssue: '',
    descriptionQuality: '', // 描述状态:'' 全部 | '0' 空 | '1' 占位 | '2' 按钮污染 | '3' 正常 | '1,2' 需清洗
  },
});

// 列表行勾选(批量更新图片用)
const selectedSkus = ref([]);
// 图片更新弹窗
const refreshDialog = ref({ open: false, mode: 'single', singleItem: null, selectedProducts: [] });
// 库存更新弹窗(2026-07)
const stockDialog = ref({ open: false, mode: 'single', singleItem: null, selectedProducts: [] });
// 商品信息更新弹窗(2026-07)
const productUpdateDialog = ref({ open: false, mode: 'single', singleItem: null, selectedProducts: [] });
// 按筛选深度采集弹窗(2026-08)
const deepCollectDialog = ref({ open: false, items: [], storeId: '' });
// 按筛选批量操作:拉取中的状态('image' | 'stock' | 'info' | 'collect' | '')
const filterBatchLoading = ref('');
// 删除中状态(单条 sku 或 'batch' 或 '')
const deletingId = ref('');

// 同步状态:从 Ozon 拉取店铺商品写入本地缓存
const syncing = ref(false);
const syncLabel = ref('同步店铺商品');
// 描述同步状态:批量拉取 /v1/product/info/description 并计算描述质量标记
// 复用 syncing 进度面板(syncProgressMap 按 storeId + phase=desc-* 上报)
const syncingDesc = ref(false);
const syncDescLabel = ref('同步描述');
// 同步进度:各店铺实时进度列表(轮询 GET /sync-progress 填充)
const syncProgressItems = ref([]);
let syncProgressTimer = null;
// 同步总计时(从开始同步到所有店铺完成,显示在进度面板标题处)
const syncStartedAt = ref(0); // 0 表示未开始
const syncElapsedSec = ref(0); // 实时累计秒数
let syncElapsedTimer = null;
// 同步是否已完成(用于完成后停止计时但保留面板)
const syncFinished = ref(false);

function startProgressPolling() {
  stopProgressPolling();
  const poll = async () => {
    try {
      const r = await getSyncProgress();
      const newItems = r?.items || [];
      // 合并而非直接替换:后端完成后 60s 会清理 syncProgressMap,
      // 先完成的店铺会从后端响应中消失;且延迟启动的店铺后端还没进度
      // 前端已有的 pending(等待中)/done/error 都需保留
      const seen = new Set();
      const merged = [];
      for (const p of newItems) {
        merged.push(p);
        seen.add(p.storeId);
      }
      // 补上前端已有但后端未返回的(pending=还没开始,done/error=已完成被后端清理)
      for (const p of syncProgressItems.value) {
        if (!seen.has(p.storeId)) {
          merged.push(p);
          seen.add(p.storeId);
        }
      }
      // 按 storesStore.list 顺序排序,保持面板稳定
      const order = new Map((storesStore.list || []).map((s, i) => [s.id, i]));
      merged.sort((a, b) => (order.get(a.storeId) ?? 999) - (order.get(b.storeId) ?? 999));
      syncProgressItems.value = merged;
    } catch {
      // 轮询失败不阻断,下次重试
    }
  };
  poll();
  syncProgressTimer = setInterval(poll, 2000);
}

function stopProgressPolling() {
  if (syncProgressTimer) {
    clearInterval(syncProgressTimer);
    syncProgressTimer = null;
  }
}

// 等待指定店铺集合全部到达终态(done/error)
// 用于异步同步模式:后端立即返回 202,同步在后台执行,前端通过轮询 syncProgressItems 等待完成
function waitForSyncComplete(targetIds) {
  return new Promise((resolve) => {
    const check = () => {
      const relevant = syncProgressItems.value.filter((p) => targetIds.has(p.storeId));
      if (
        relevant.length >= targetIds.size &&
        relevant.every((p) => p.status === 'done' || p.status === 'error')
      ) {
        resolve();
        return;
      }
      setTimeout(check, 1000);
    };
    check();
  });
}

// 启动总计时器:每秒更新 syncElapsedSec
function startElapsedTimer() {
  stopElapsedTimer();
  syncStartedAt.value = Date.now();
  syncElapsedSec.value = 0;
  syncFinished.value = false;
  syncElapsedTimer = setInterval(() => {
    if (syncStartedAt.value) {
      syncElapsedSec.value = Math.floor((Date.now() - syncStartedAt.value) / 1000);
    }
  }, 1000);
}

function stopElapsedTimer() {
  if (syncElapsedTimer) {
    clearInterval(syncElapsedTimer);
    syncElapsedTimer = null;
  }
}

// 格式化秒数为 mm:ss 或 h:mm:ss
function fmtDuration(sec) {
  if (!sec || sec < 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 用户手动关闭进度面板
function closeSyncPanel() {
  syncProgressItems.value = [];
  stopElapsedTimer();
  syncStartedAt.value = 0;
  syncElapsedSec.value = 0;
  syncFinished.value = false;
}

// 格式化单条进度为简短文本
function fmtProgress(p) {
  if (!p) return '';
  if (p.status === 'pending') return `⏳ ${p.message || '等待中'}`;
  const secs = Math.round((p.elapsedMs || 0) / 1000);
  const t = `${secs}s`;
  if (p.status === 'done') return `✓ ${p.message} (${t})`;
  if (p.status === 'error') return `✗ ${p.message} (${t})`;
  return `${p.message || p.phase} (${t})`;
}

async function loadList() {
  state.loading = true;
  try {
    const data = await getProducts({
      currentPage: state.page,
      pageSize: state.pageSize,
      storeId: state.filters.storeId,
      keyword: state.filters.keyword.trim(),
      productStatus: state.filters.productStatus,
      hasStock: state.filters.hasStock,
      imageIssue: state.filters.imageIssue,
      descriptionQuality: state.filters.descriptionQuality,
    });
    state.items = data?.items || [];
    state.total = data?.total || 0;
    state.statusCounts = data?.statusCounts || state.statusCounts;
  } catch (err) {
    show(err.message || String(err), 'error');
    state.items = [];
    state.total = 0;
  } finally {
    state.loading = false;
  }
}

// ── URL state 同步(2026-07) ─────────────────────────────────
// 筛选条件 + 页码同步到 URL query params,刷新/分享不丢失状态
// 设计:
//   - onMounted 时从 route.query 回填 state(loadFromUrl),再 loadList
//   - watch state.filters(deep) + state.page → debounce 300ms 写入 router.replace(syncToUrl)
//   - 用 syncUrlPending flag 防止 loadFromUrl → watch → syncToUrl 循环
//   - 空值不写入 query,保持 URL 简洁
let syncUrlTimer = null;
let syncUrlPending = false; // true 时跳过 watch 触发的 syncToUrl(loadFromUrl 回填期间)

function buildQueryFromState() {
  const q = {};
  const f = state.filters;
  if (f.storeId) q.storeId = f.storeId;
  if (f.keyword && f.keyword.trim()) q.keyword = f.keyword.trim();
  if (f.productStatus) q.productStatus = f.productStatus;
  if (f.hasStock) q.hasStock = f.hasStock;
  if (f.imageIssue) q.imageIssue = f.imageIssue;
  if (f.descriptionQuality) q.descriptionQuality = f.descriptionQuality;
  if (state.page && state.page > 1) q.page = String(state.page);
  return q;
}

function syncToUrl() {
  if (syncUrlPending) return; // loadFromUrl 回填期间跳过
  if (syncUrlTimer) clearTimeout(syncUrlTimer);
  syncUrlTimer = setTimeout(() => {
    const q = buildQueryFromState();
    // 仅当 query 变化时才 replace,避免无谓的导航
    const cur = route.query;
    const changed =
      Object.keys({ ...q, ...cur }).some((k) => String(q[k] ?? '') !== String(cur[k] ?? ''));
    if (changed) {
      router.replace({ query: q });
    }
  }, 300);
}

function loadFromUrl() {
  syncUrlPending = true;
  const q = route.query || {};
  // 回填筛选条件(容错:非法值忽略)
  if (typeof q.storeId === 'string' && q.storeId) state.filters.storeId = q.storeId;
  if (typeof q.keyword === 'string' && q.keyword) state.filters.keyword = q.keyword;
  if (typeof q.productStatus === 'string' && q.productStatus) {
    // 仅接受合法状态值,防止恶意 URL
    const valid = ['', 'saleable', 'created_no_stock', 'pending_creation', 'rejected', 'other'];
    if (valid.includes(q.productStatus)) state.filters.productStatus = q.productStatus;
  }
  if (q.hasStock === '0' || q.hasStock === '1') state.filters.hasStock = q.hasStock;
  if (q.imageIssue === '0' || q.imageIssue === '1') state.filters.imageIssue = q.imageIssue;
  // 描述状态:'' 全部 | '0'/'1'/'2'/'3' | '1,2' 需清洗(校验避免恶意 URL)
  if (typeof q.descriptionQuality === 'string' && q.descriptionQuality) {
    if (/^[0-9]+(,[0-9]+)*$/.test(q.descriptionQuality)) {
      state.filters.descriptionQuality = q.descriptionQuality;
    }
  }
  if (q.page) {
    const n = parseInt(q.page, 10);
    if (!Number.isNaN(n) && n >= 1) state.page = n;
  }
  // 回填完成后,下一 tick 解除 flag,允许后续 watch 正常同步
  syncUrlPending = false;
}

// watch filters + page → debounce 写入 URL
watch(
  () => state.filters,
  () => syncToUrl(),
  { deep: true }
);
watch(
  () => state.page,
  () => syncToUrl()
);

// 查询:重置到第 1 页后加载
function search() {
  state.page = 1;
  loadList();
}

// 同步:从 Ozon 拉取店铺商品写入本地缓存
// - 选了店铺:只同步该店铺
// - 未选店铺:并行同步所有店铺,店铺间间隔 5s 发请求避免触发限流,单店铺失败不影响其他
async function syncStoreProducts() {
  const storeId = state.filters.storeId;
  const targets = storeId
    ? [{ id: storeId, name: storeName(storeId) }]
    : (storesStore.list || []).map((s) => ({ id: s.id, name: s.name || s.id }));

  if (targets.length === 0) {
    show('没有可同步的店铺', 'error');
    return;
  }

  const scopeText = storeId ? `店铺「${storeName(storeId)}」` : `全部 ${targets.length} 个店铺`;
  if (!(await confirmStore.ask({ message: `确认从 Ozon 拉取 ${scopeText} 的商品到本地缓存?大店铺可能耗时较久。` }))) {
    return;
  }

  syncing.value = true;
  const STORE_INTERVAL_MS = 5000; // 店铺间发请求间隔,避免触发 Ozon 限流
  // 立即初始化进度面板:所有店铺显示"等待中",避免延迟启动的店铺一开始不在面板上
  syncProgressItems.value = targets.map((t) => ({
    storeId: t.id,
    storeName: t.name,
    status: 'pending',
    phase: 'pending',
    message: '等待中',
    elapsedMs: 0,
  }));
  startProgressPolling(); // 启动进度轮询(2s 间隔)
  startElapsedTimer(); // 启动总计时器(每秒更新)
  try {
    // 异步发起同步请求(后端立即返回 202,同步在后台执行)
    // 不再 await 结果做汇总——汇总从 syncProgressItems 终态取
    const targetIds = new Set(targets.map((t) => t.id));
    const launchPromises = targets.map((t, i) => {
      return (async () => {
        if (i > 0) await new Promise((r) => setTimeout(r, i * STORE_INTERVAL_MS));
        try {
          await syncProducts(t.id); // 立即返回 accepted,不等同步完成
        } catch (err) {
          // 启动失败(网络/404等,不是同步本身的失败)
          show(`店铺 ${t.name} 启动同步失败: ${err.message || String(err)}`, 'error');
          const idx = syncProgressItems.value.findIndex((p) => p.storeId === t.id);
          if (idx >= 0) {
            const cur = syncProgressItems.value[idx];
            syncProgressItems.value[idx] = {
              ...cur,
              status: 'error',
              phase: 'error',
              message: err.message || String(err),
              elapsedMs: Date.now() - (cur.startedAt || Date.now()),
            };
          }
        }
      })();
    });

    syncLabel.value = storeId ? '同步中…' : `同步中 (并行 ${targets.length} 个店铺)`;

    // 等所有启动请求发出(后端已返回 202,同步在后台跑)
    await Promise.all(launchPromises);

    // 等待所有店铺到达终态(done/error),通过轮询 syncProgressItems 检查
    await waitForSyncComplete(targetIds);

    // 从 syncProgressItems 终态汇总统计
    let totalSynced = 0;
    let totalTotal = 0;
    let totalRemoved = 0;
    let failed = 0;
    let totalFailedBatches = 0;
    for (const p of syncProgressItems.value) {
      if (!targetIds.has(p.storeId)) continue;
      if (p.status === 'error') {
        failed++;
        continue;
      }
      totalSynced += p.synced ?? 0;
      totalTotal += p.total ?? 0;
      totalRemoved += p.removed ?? 0;
      totalFailedBatches += p.failedBatches ?? 0;
    }
    const summary = `同步完成:写入 ${totalSynced}/${totalTotal} 条,清理 ${totalRemoved} 条已下架${
      failed > 0 ? `,失败 ${failed} 个店铺` : ''
    }${totalFailedBatches > 0 ? `,${totalFailedBatches} 批详情拉取失败(见日志)` : ''}`;
    show(summary, failed > 0 || totalFailedBatches > 0 ? 'error' : 'success');
    state.page = 1;
    await loadList();
  } finally {
    // 轮询已在 waitForSyncComplete 期间持续更新 syncProgressItems,无需再查一次
    stopProgressPolling();
    stopElapsedTimer();
    syncFinished.value = true;
    syncing.value = false;
    syncLabel.value = '同步店铺商品';
  }
}

// 同步描述:批量拉取 /v1/product/info/description,计算描述质量标记(占位/按钮污染)
// 复用进度面板(syncProgressMap phase=desc-*);需先「同步店铺商品」拿到商品列表后才有意义
async function syncDescriptions() {
  const storeId = state.filters.storeId;
  const targets = storeId
    ? [{ id: storeId, name: storeName(storeId) }]
    : (storesStore.list || []).map((s) => ({ id: s.id, name: s.name || s.id }));

  if (targets.length === 0) {
    show('没有可同步描述的店铺', 'error');
    return;
  }

  const scopeText = storeId ? `店铺「${storeName(storeId)}」` : `全部 ${targets.length} 个店铺`;
  if (
    !(await confirmStore.ask({
      message: `确认拉取 ${scopeText} 的商品描述并计算描述质量?大店铺需逐条调用接口,耗时较长。将统一重新拉取全部商品描述(不判断本地是否已有)。`,
    }))
  ) {
    return;
  }

  syncingDesc.value = true;
  // 立即初始化进度面板:所有店铺显示"等待中"
  syncProgressItems.value = targets.map((t) => ({
    storeId: t.id,
    storeName: t.name,
    status: 'pending',
    phase: 'pending',
    message: '等待中',
    elapsedMs: 0,
  }));
  startProgressPolling();
  startElapsedTimer();
  syncFinished.value = false;
  try {
    const STORE_INTERVAL_MS = 5000;
    const targetIds = new Set(targets.map((t) => t.id));
    const launchPromises = targets.map((t, i) => {
      return (async () => {
        if (i > 0) await new Promise((r) => setTimeout(r, i * STORE_INTERVAL_MS));
        try {
          await syncProductDescriptions(t.id, true); // 立即返回 accepted
        } catch (err) {
          show(`店铺 ${t.name} 描述同步失败: ${err.message || String(err)}`, 'error');
          const idx = syncProgressItems.value.findIndex((p) => p.storeId === t.id);
          if (idx >= 0) {
            const cur = syncProgressItems.value[idx];
            syncProgressItems.value[idx] = {
              ...cur,
              status: 'error',
              phase: 'error',
              message: err.message || String(err),
              elapsedMs: Date.now() - (cur.startedAt || Date.now()),
            };
          }
        }
      })();
    });

    syncDescLabel.value = storeId ? '描述同步中…' : `描述同步中 (并行 ${targets.length} 个店铺)`;

    await Promise.all(launchPromises);
    await waitForSyncComplete(targetIds);

    let totalSynced = 0;
    let totalTotal = 0;
    let failedStores = 0;
    let totalFailed = 0;
    for (const p of syncProgressItems.value) {
      if (!targetIds.has(p.storeId)) continue;
      if (p.status === 'error') {
        failedStores++;
        continue;
      }
      totalSynced += p.synced ?? 0;
      totalTotal += p.total ?? 0;
      totalFailed += p.failedBatches ?? 0;
    }
    const summary = `描述同步完成:${totalSynced}/${totalTotal}${
      failedStores > 0 ? `,失败 ${failedStores} 个店铺` : ''
    }${totalFailed > 0 ? `,${totalFailed} 条拉取失败(见日志)` : ''}`;
    show(summary, failedStores > 0 || totalFailed > 0 ? 'error' : 'success');
    await loadList();
  } finally {
    stopProgressPolling();
    stopElapsedTimer();
    syncFinished.value = true;
    syncingDesc.value = false;
    syncDescLabel.value = '同步描述';
  }
}

// 翻页:先更新页码再加载,确保读取最新 page
function onPageChange(p) {
  state.page = p;
  loadList();
}

// ── 详情弹窗 ───────────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detail = ref(null);

async function openDetail(sku) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    const data = await getProductDetail(sku);
    detail.value = data || null;
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detailLoading.value = false;
  }
}

// ── 渲染辅助 ───────────────────────────────────────────────
function storeName(storeId) {
  const s = storesStore.list.find((x) => x.id === storeId);
  return s?.name || storeId || '—';
}

function fmtTime(t) {
  if (!t) return '—';
  return String(t).replace('T', ' ').slice(0, 19);
}

// ── 图片更新 ──────────────────────────────────────────────
function toggleSelect(sku) {
  const idx = selectedSkus.value.indexOf(sku);
  if (idx >= 0) selectedSkus.value.splice(idx, 1);
  else selectedSkus.value.push(sku);
}
function isSelected(sku) {
  return selectedSkus.value.includes(sku);
}
const allSelected = computed(
  () => state.items.length > 0 && state.items.every((r) => selectedSkus.value.includes(r.sku))
);
function toggleSelectAll() {
  if (allSelected.value) {
    const skus = new Set(state.items.map((r) => r.sku));
    selectedSkus.value = selectedSkus.value.filter((s) => !skus.has(s));
  } else {
    const existing = new Set(selectedSkus.value);
    for (const r of state.items) existing.add(r.sku);
    selectedSkus.value = [...existing];
  }
}
// 单条更新图片:详情弹窗「图片」分组触发
function openSingleRefresh(item) {
  if (!item.productId) {
    show('该商品无 product_id,可能未同步完整', 'error');
    return;
  }
  refreshDialog.value = {
    open: true,
    mode: 'single',
    // offerId 用后端返回的卖家SKU(data.offer_id),不能用 item.sku(那是 FBS 变体SKU)
    singleItem: { productId: item.productId, storeId: item.storeId, offerId: item.offerId },
    selectedProducts: [],
  };
}
// 批量更新图片:列表勾选触发(不限图片问题)
function openBatchRefresh() {
  const products = state.items
    .filter((r) => selectedSkus.value.includes(r.sku) && r.productId)
    .map((r) => ({ productId: r.productId, storeId: r.storeId }));
  if (!products.length) {
    show('请先勾选有 product_id 的商品', 'error');
    return;
  }
  refreshDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
}

// ── 库存更新(2026-07)──────────────────────────────────────
// 单条更新库存:列表行操作触发
function openSingleStock(item) {
  if (!item.productId) {
    show('该商品无 product_id,可能未同步完整', 'error');
    return;
  }
  stockDialog.value = {
    open: true,
    mode: 'single',
    singleItem: { productId: item.productId, storeId: item.storeId, offerId: item.offerId },
    selectedProducts: [],
  };
}
// 批量更新库存:列表勾选触发
function openBatchStock() {
  const products = state.items
    .filter((r) => selectedSkus.value.includes(r.sku) && r.productId)
    .map((r) => ({ productId: r.productId, storeId: r.storeId }));
  if (!products.length) {
    show('请先勾选有 product_id 的商品', 'error');
    return;
  }
  stockDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
}

// ── 商品信息更新(2026-07)──────────────────────────────────
// 单条更新信息:列表行操作触发
function openSingleProductUpdate(item) {
  if (!item.productId) {
    show('该商品无 product_id,可能未同步完整', 'error');
    return;
  }
  productUpdateDialog.value = {
    open: true,
    mode: 'single',
    singleItem: { productId: item.productId, storeId: item.storeId, offerId: item.offerId, sku: item.sku },
    selectedProducts: [],
  };
}
// 批量更新信息:列表勾选触发(同文案,统一更新相同字段)
function openBatchProductUpdate() {
  const products = state.items
    .filter((r) => selectedSkus.value.includes(r.sku) && r.productId)
    .map((r) => ({ productId: r.productId, storeId: r.storeId, offerId: r.offerId }));
  if (!products.length) {
    show('请先勾选有 product_id 的商品', 'error');
    return;
  }
  productUpdateDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
}

// 按当前筛选条件批量更新(不限于当前页,拉取全量匹配商品的 productId/storeId)
// type: 'image' | 'stock' | 'info' | 'collect'
async function openFilteredBatch(type) {
  if (filterBatchLoading.value) return;
  filterBatchLoading.value = type;
  try {
    const data = await getProducts({
      storeId: state.filters.storeId,
      keyword: state.filters.keyword.trim(),
      productStatus: state.filters.productStatus,
      hasStock: state.filters.hasStock,
      imageIssue: state.filters.imageIssue,
      descriptionQuality: state.filters.descriptionQuality,
      idsOnly: 1,
    });
    const products = (data?.items || []).filter((p) => p.productId);
    if (!products.length) {
      show('当前筛选无可用商品(缺少 product_id)', 'error');
      return;
    }
    if (type === 'collect') {
      // 深度采集:直接打开弹窗,弹窗内展示匹配数并二次确认
      deepCollectDialog.value = {
        open: true,
        items: products.map((p) => ({ offerId: String(p.offerId || ''), productId: String(p.productId), storeId: p.storeId || '' })),
        storeId: state.filters.storeId || '',
      };
      return;
    }
    const typeLabel = type === 'image' ? '图片' : type === 'stock' ? '库存' : '信息';
    if (!(await confirmStore.ask({ message: `将对当前筛选匹配的 ${products.length} 个商品批量更新${typeLabel},是否继续?` }))) {
      return;
    }
    if (type === 'image') {
      refreshDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
    } else if (type === 'stock') {
      stockDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
    } else if (type === 'info') {
      productUpdateDialog.value = { open: true, mode: 'batch', singleItem: null, selectedProducts: products };
    }
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    filterBatchLoading.value = '';
  }
}
function openFilteredRefresh() {
  return openFilteredBatch('image');
}
function openFilteredStock() {
  return openFilteredBatch('stock');
}
function openFilteredProductUpdate() {
  return openFilteredBatch('info');
}
function openFilteredDeepCollect() {
  return openFilteredBatch('collect');
}

// ── 删除商品缓存(2026-08)──────────────────────────────────────
// 单条删除:仅删除 ERP 本地缓存,不影响 Ozon 后台商品
async function deleteSingle(it) {
  if (deletingId.value) return;
  if (
    !(await confirmStore.ask({
      title: '删除商品缓存',
      message: `确认删除商品「${it.sku}」的本地缓存?此操作仅删除 ERP 缓存,不影响 Ozon 后台商品。`,
      danger: true,
      confirmText: '删除',
    }))
  )
    return;
  deletingId.value = it.sku;
  try {
    await deleteProductApi(it.sku);
    selectedSkus.value = selectedSkus.value.filter((s) => s !== it.sku);
    show('已删除', 'success');
    await loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    deletingId.value = '';
  }
}

// 批量删除:基于已勾选的 SKU
async function deleteSelected() {
  if (deletingId.value) return;
  const skus = [...selectedSkus.value];
  if (!skus.length) {
    show('请先勾选要删除的商品', 'error');
    return;
  }
  if (
    !(await confirmStore.ask({
      title: '批量删除商品缓存',
      message: `确认删除已勾选的 ${skus.length} 个商品的本地缓存?此操作仅删除 ERP 缓存,不影响 Ozon 后台商品。`,
      danger: true,
      confirmText: '删除',
    }))
  )
    return;
  deletingId.value = 'batch';
  try {
    const r = await deleteProductsBatch(skus);
    const deleted = r?.deleted ?? 0;
    const notFoundCount = r?.notFound?.length ?? 0;
    show(`已删除 ${deleted} 个商品${notFoundCount ? `,${notFoundCount} 个未找到` : ''}`, 'success');
    selectedSkus.value = [];
    await loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    deletingId.value = '';
  }
}

// 商品简化状态徽章(2026-07):基于后端返回的 productStatus(5 类)
// 2026-07:改名 saleable→出售中、created_no_stock→准备出售;合并 in_review/unknown → other
const PRODUCT_STATUS_BADGE = {
  saleable: { cls: 'badge-success', label: '出售中' },
  created_no_stock: { cls: 'badge-pending', label: '准备出售' },
  pending_creation: { cls: 'badge-processing', label: '待创建' },
  rejected: { cls: 'badge-failed', label: '审核拒绝' },
  other: { cls: 'badge-pending', label: '其它' },
};

function productStatusInfo(it) {
  return PRODUCT_STATUS_BADGE[it.productStatus] || { cls: 'badge-pending', label: it.productStatus || '—' };
}

// 状态错误提示(2026-07):基于后端返回的 statusErrors(去重+中文翻译)
// 用于状态列下方的小字提示 + hover tooltip 展示完整错误
// 返回:{ count, hint, tooltip } 或 null(无错误)
function statusErrorInfo(it) {
  const se = it.statusErrors;
  if (!se || !se.count || !Array.isArray(se.items) || se.items.length === 0) return null;
  // hint:第 1 条错误的中文描述(短),前面带计数
  const first = se.items[0];
  const hint = se.count === 1 ? first.codeCn : `${first.codeCn} 等 ${se.count} 条`;
  // tooltip:拼接所有错误(最多 5 条),格式「· 中文描述(属性名)」
  const lines = se.items.slice(0, 5).map((e) => {
    const attr = e.attributeName ? `(${e.attributeName})` : '';
    return `· ${e.codeCn}${attr}`;
  });
  if (se.count > 5) lines.push(`... 共 ${se.count} 条`);
  const tooltip = lines.join('\n');
  return { count: se.count, hint, tooltip };
}

// 状态子tab 配置(2026-07):顺序与展示标签,与 PRODUCT_STATUS_BADGE 同步
// 2026-07:改名 + 合并 in_review/unknown → other
const PRODUCT_STATUS_TABS = [
  { value: 'saleable', label: '出售中' },
  { value: 'created_no_stock', label: '准备出售' },
  { value: 'pending_creation', label: '待创建' },
  { value: 'rejected', label: '审核拒绝' },
  { value: 'other', label: '其它' },
];

// 切换状态 tab:重置到第 1 页并加载
function setStatusTab(val) {
  if (state.filters.productStatus === val) return;
  state.filters.productStatus = val;
  state.page = 1;
  loadList();
}

// 库存徽章:基于后端返回的 hasStock(来自 OPI stocks.has_stock)
//   true=有库存可售(绿);false=无库存(price_sent 准备出售但缺货,红)
function stockBadgeClass(it) {
  return it.hasStock ? 'badge-success' : 'badge-failed';
}
function stockBadgeLabel(it) {
  return String(Number(it.stockPresent) || 0);
}

// 图片徽章:基于后端返回的 hasImageError(来自 OPI errors[].code 判断)
//   false=正常(无图片错误);true=警告(出现 primary_image_load_failed/pics_http_error/some_image_failed/all_image_failed)
function imageBadgeClass(it) {
  return it.hasImageError ? 'badge-failed' : 'badge-success';
}
function imageBadgeLabel(it) {
  return it.hasImageError ? '图片异常' : '正常';
}

// 详情弹窗:用 AppAccordion 分组展示商品缓存数据
// 每组内容统一用 <pre class="sf-value-pre"> 渲染 JSON
function detailSections(d) {
  if (!d) return [];
  const raw = d.data || {};
  const basic = {
    sku: d.sku,
    name: raw.name || raw.title || '',
    store_id: d.storeId,
    status: raw.statuses?.status || raw.status || raw.state || '',
    status_name: raw.statuses?.status_name || '',
    moderate_status: raw.statuses?.moderate_status || '',
    validation_status: raw.statuses?.validation_status || '',
    is_created: raw.statuses?.is_created,
    fetchedAt: d.fetchedAt,
    productId: raw.product_id || raw.id || '',
  };
  return [
    { title: '基本信息', value: basic, open: true },
    { title: 'attributes', value: raw.attributes ?? null, open: false },
    { title: '描述', value: raw.description ?? null, open: false },
    {
      title: '图片',
      value: { primary_image: raw.primary_image || raw.image || '', images: raw.images || [] },
      open: false,
    },
    { title: '完整数据', value: raw, open: false },
  ];
}

onMounted(() => {
  storesStore.load();
  // 先从 URL 回填筛选/页码,再加载列表(支持刷新/分享保状态)
  loadFromUrl();
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>商品列表</h2>
      <button class="btn btn-primary" :disabled="syncing || syncingDesc" @click="syncStoreProducts">
        {{ syncLabel }}
      </button>
      <button
        class="btn btn-primary"
        :disabled="syncing || syncingDesc"
        :title="'批量拉取商品描述并计算描述质量(占位/按钮污染),用于「描述状态」筛选'"
        @click="syncDescriptions"
      >
        {{ syncDescLabel }}
      </button>
      <button class="btn btn-ghost" :disabled="state.loading || syncing || syncingDesc" @click="loadList">
        {{ state.loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <!-- 同步进度:右上角浮动卡片(不占文档流,避免破坏页面布局)
         2026-07:完成后不自动消失,显示总计时 + 关闭按钮供用户手动关闭 -->
    <div
      v-if="syncProgressItems.length || syncFinished"
      style="position:fixed;top:16px;right:16px;z-index:2000;min-width:320px;max-width:420px;background:#fff;border:1px solid #e0e0e0;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.12);padding:12px 14px;font-size:13px"
    >
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #f0f0f0">
        <span style="font-weight:600">
          同步进度
          <span style="color:#666;font-weight:normal;margin-left:8px">{{ syncProgressItems.length }} 个店铺</span>
        </span>
        <span style="display:flex;align-items:center;gap:10px">
          <span :style="{ color: syncFinished ? '#2e7d32' : '#0288d1', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }" :title="'总耗时'">
            ⏱ {{ fmtDuration(syncElapsedSec) }}
          </span>
          <button
            v-if="syncFinished"
            style="background:none;border:none;cursor:pointer;color:#999;font-size:16px;padding:0 2px;line-height:1"
            title="关闭"
            @click="closeSyncPanel"
          >×</button>
        </span>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;max-height:50vh;overflow-y:auto">
        <div
          v-for="p in syncProgressItems"
          :key="p.storeId"
          style="display:flex;gap:10px;align-items:center"
        >
          <span style="min-width:64px;font-weight:600;flex-shrink:0">{{ p.storeName }}</span>
          <span :style="{ color: p.status === 'done' ? '#2e7d32' : p.status === 'error' ? '#c62828' : '#666', flex:1, wordBreak:'break-all' }">
            {{ fmtProgress(p) }}
          </span>
        </div>
      </div>
    </div>

    <div class="filter-bar">
      <select class="filter-select" v-model="state.filters.storeId">
        <option value="">全部店铺</option>
        <option v-for="s in storesStore.list" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <input
        class="filter-input"
        type="text"
        v-model.trim="state.filters.keyword"
        placeholder="搜索 SKU / 名称"
        @keydown.enter="search"
      />
      <label class="filter-checkbox" :title="'勾选后只显示无库存的商品'">
        <input
          type="checkbox"
          :checked="state.filters.hasStock === '0'"
          @change="state.filters.hasStock = $event.target.checked ? '0' : ''"
        />
        <span>无库存</span>
      </label>
      <label class="filter-checkbox" :title="'勾选后只显示图片缺失的商品'">
        <input
          type="checkbox"
          :checked="state.filters.imageIssue === '1'"
          @change="state.filters.imageIssue = $event.target.checked ? '1' : ''"
        />
        <span>图片缺失</span>
      </label>
      <select
        class="filter-select"
        v-model="state.filters.descriptionQuality"
        title="描述状态:同步时按描述内容质量分级(占位文案/按钮污染)"
        @change="search"
      >
        <option value="">全部描述</option>
        <option value="0">描述为空</option>
        <option value="1">含占位符</option>
        <option value="2">按钮污染</option>
        <option value="3">描述有效</option>
        <option value="1,2">需清洗</option>
      </select>
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <!-- 状态子tab筛选(2026-07):5 类简化状态 + 数量统计 -->
    <div class="status-tabs">
      <button
        class="status-tab"
        :class="{ active: state.filters.productStatus === '' }"
        @click="setStatusTab('')"
      >全部({{ state.statusCounts.all || 0 }})</button>
      <button
        v-for="opt in PRODUCT_STATUS_TABS"
        :key="opt.value"
        class="status-tab"
        :class="{ active: state.filters.productStatus === opt.value, ['status-tab-' + opt.value]: true }"
        @click="setStatusTab(opt.value)"
      >{{ opt.label }}({{ state.statusCounts[opt.value] || 0 }})</button>
    </div>

    <div v-if="selectedSkus.length" style="display:flex;gap:12px;align-items:center;padding:8px 4px">
      <span class="muted">已选 {{ selectedSkus.length }} 个商品</span>
      <button class="btn btn-primary" @click="openBatchRefresh">批量更新图片</button>
      <button class="btn btn-primary" @click="openBatchStock">批量更新库存</button>
      <button class="btn btn-primary" @click="openBatchProductUpdate">批量更新信息</button>
      <button
        class="btn btn-danger"
        :disabled="!!deletingId"
        @click="deleteSelected"
      >{{ deletingId === 'batch' ? '删除中…' : '批量删除' }}</button>
    </div>

    <!-- 按当前筛选条件批量操作(不限于当前页) -->
    <div v-if="state.total > 0" style="display:flex;gap:12px;align-items:center;padding:8px 4px">
      <span class="muted">当前筛选匹配 {{ state.total }} 个商品</span>
      <button class="btn btn-ghost" :disabled="!!filterBatchLoading" @click="openFilteredRefresh">
        {{ filterBatchLoading === 'image' ? '拉取中…' : '按筛选更新图片' }}
      </button>
      <button class="btn btn-ghost" :disabled="!!filterBatchLoading" @click="openFilteredStock">
        {{ filterBatchLoading === 'stock' ? '拉取中…' : '按筛选更新库存' }}
      </button>
      <button class="btn btn-ghost" :disabled="!!filterBatchLoading" @click="openFilteredProductUpdate">
        {{ filterBatchLoading === 'info' ? '拉取中…' : '按筛选更新信息' }}
      </button>
      <button class="btn btn-ghost" :disabled="!!filterBatchLoading" @click="openFilteredDeepCollect">
        {{ filterBatchLoading === 'collect' ? '拉取中…' : '按筛选深度采集' }}
      </button>
    </div>

    <div class="table-wrap">
      <table class="data-table" aria-label="商品列表">
        <caption class="sr-only">商品数据缓存列表,含 SKU、Offer ID、名称、店铺、状态、库存、图片与操作</caption>
        <thead>
          <tr>
            <th style="width:32px"><input type="checkbox" :checked="allSelected" aria-label="全选当前页" @change="toggleSelectAll" /></th>
            <th>SKU</th>
            <th style="width:140px">Offer ID</th>
            <th style="width:160px">名称</th>
            <th>店铺</th>
            <th>状态</th>
            <th>库存</th>
            <th>图片</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="10" class="muted" style="padding: 24px; text-align: center">加载中…</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="10" class="empty">暂无商品数据(插件查询过的商品会自动缓存到这里)</td>
          </tr>
          <tr v-for="it in state.items" :key="it.sku">
            <td><input type="checkbox" :checked="isSelected(it.sku)" :aria-label="`选择 SKU ${it.sku}`" @change="toggleSelect(it.sku)" /></td>
            <td>{{ it.sku }}</td>
            <td>{{ it.offerId || '—' }}</td>
            <td style="max-width:160px">
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="it.name">{{ it.name || '—' }}</div>
              <span
                v-if="it.descriptionQuality === 0"
                class="dq-tag dq-tag-warn"
                title="商品描述为空(未填写或无描述)"
              >无描述</span>
              <span
                v-else-if="it.descriptionQuality === 1"
                class="dq-tag dq-tag-danger"
                title="描述是加载失败占位文案(如「Не удалось загрузить」),需重新填写"
              >占位</span>
              <span
                v-else-if="it.descriptionQuality === 2"
                class="dq-tag dq-tag-warn"
                title="描述末尾粘有按钮文案(如「Читать далее」),源数据需清洗"
              >需清洗</span>
            </td>
            <td>{{ storeName(it.storeId) }}</td>
            <td>
              <div class="status-cell">
                <span class="badge" :class="productStatusInfo(it).cls">{{
                  productStatusInfo(it).label
                }}</span>
                <span
                  v-if="statusErrorInfo(it)"
                  class="err-hint"
                  :title="statusErrorInfo(it).tooltip"
                >{{ statusErrorInfo(it).hint }}</span>
              </div>
            </td>
            <td>
              <span class="badge" :class="stockBadgeClass(it)">{{ stockBadgeLabel(it) }}</span>
            </td>
            <td>
              <span class="badge" :class="imageBadgeClass(it)">{{ imageBadgeLabel(it) }}</span>
            </td>
            <td>{{ fmtTime(it.fetchedAt) }}</td>
            <td>
              <button class="btn btn-sm btn-ghost" @click="openDetail(it.sku)">查看详情</button>
              <button v-if="it.productId" class="btn btn-sm btn-ghost" @click="openSingleRefresh(it)">更新图片</button>
              <button v-if="it.productId" class="btn btn-sm btn-ghost" @click="openSingleStock(it)">更新库存</button>
              <button v-if="it.productId" class="btn btn-sm btn-ghost" @click="openSingleProductUpdate(it)">更新信息</button>
              <button
                class="btn btn-sm btn-danger"
                :disabled="deletingId === it.sku || deletingId === 'batch'"
                @click="deleteSingle(it)"
              >{{ deletingId === it.sku ? '删除中…' : '删除' }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AppPager
      :modelValue="state.page"
      :total="state.total"
      :pageSize="state.pageSize"
      @update:modelValue="onPageChange"
    />

    <!-- 详情弹窗 -->
    <AppModal :open="detailOpen" title="商品详情" size="lg" @update:open="detailOpen = $event">
      <div v-if="detailLoading" class="empty">加载中…</div>
      <template v-else-if="detail">
        <AppAccordion
          v-for="(sec, idx) in detailSections(detail)"
          :key="idx"
          :title="sec.title"
          :default-open="sec.open"
        >
          <JsonTree :data="sec.value" :root-key="sec.title" />
        </AppAccordion>
        <div v-if="detail.productId" style="margin-top:12px;text-align:right">
          <button class="btn btn-primary" @click="openSingleRefresh({ productId: detail.productId, storeId: detail.storeId, sku: detail.sku })">
            更新图片
          </button>
          <button class="btn btn-primary" @click="openSingleStock({ productId: detail.productId, storeId: detail.storeId, offerId: detail.data?.offer_id })">
            更新库存
          </button>
          <button class="btn btn-primary" @click="openSingleProductUpdate({ productId: detail.productId, storeId: detail.storeId, offerId: detail.data?.offer_id, sku: detail.sku })">
            更新信息
          </button>
        </div>
      </template>
      <div v-else class="empty">无数据</div>
    </AppModal>

    <!-- 图片更新弹窗 -->
    <ImageRefreshDialog
      v-model:open="refreshDialog.open"
      :mode="refreshDialog.mode"
      :single-item="refreshDialog.singleItem"
      :selected-products="refreshDialog.selectedProducts"
    />

    <!-- 库存更新弹窗 -->
    <StockRefreshDialog
      v-model:open="stockDialog.open"
      :mode="stockDialog.mode"
      :single-item="stockDialog.singleItem"
      :selected-products="stockDialog.selectedProducts"
    />

    <!-- 商品信息更新弹窗(2026-07) -->
    <ProductUpdateDialog
      v-model:open="productUpdateDialog.open"
      :mode="productUpdateDialog.mode"
      :single-item="productUpdateDialog.singleItem"
      :selected-products="productUpdateDialog.selectedProducts"
    />
    <DeepCollectByProductsDialog
      v-if="deepCollectDialog.open"
      :items="deepCollectDialog.items"
      :store-id="deepCollectDialog.storeId"
      @close="deepCollectDialog.open = false"
    />
  </div>
</template>

<style scoped>
/* 描述质量标签(与采集箱 cb-extra-tag 同口径配色) */
.dq-tag {
  display: inline-block;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 2px;
  margin-top: 2px;
  background: #f0f0f0;
  color: #666;
}
.dq-tag-warn {
  background: #fffbe6;
  color: #d48806;
}
.dq-tag-danger {
  background: #fff1f0;
  color: #cf1322;
}
</style>
