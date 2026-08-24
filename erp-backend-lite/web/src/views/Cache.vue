<script setup>
import { reactive, ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  getCacheOverview,
  getOpiPreview,
  getCacheByType,
  getStoreClassificationList,
  updateStoreClassification,
  deleteStoreClassification,
  getStoreSkuList,
  deleteStoreSku,
  deleteSkuAll,
  batchDeleteSkus,
} from '../api/cache.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';
import JsonTree from '../components/JsonTree.vue';
import { useConfirmStore } from '../stores/confirm.js';

const { show } = useToast();
const confirmStore = useConfirmStore();
const route = useRoute();
const router = useRouter();

// Ozon 商品详情页 URL(sku 直接拼到 /product/{sku}/)
const OZON_PDP_PREFIX = 'https://www.ozon.ru/product/';

// 子 tab type 到一级路由 path 的映射(用于导航高亮与切换)
const TYPE_TO_PATH = {
  overview: '/sku-data',
  'store-classification': '/store-data',
  'store-sku': '/store-sku',
};
const PATH_TO_TYPE = {
  '/sku-data': 'overview',
  '/store-data': 'store-classification',
  '/store-sku': 'store-sku',
};

// 由当前路由 path 决定初始 type(一级 tab 驱动)
function typeFromRoute() {
  return PATH_TO_TYPE[route.path] || 'overview';
}

// ── SKU 数据列表 ───────────────────────────────────────────
const state = reactive({
  type: typeFromRoute(), // overview | store-classification | store-sku
  keyword: '',
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 50,
  deleting: false, // 批量/单个删除进行中(禁用按钮)
});

// 当前页选中的 SKU 集合(Set 便于增删查;切换页/搜索时清空)
const selectedSkus = ref(new Set());
const allChecked = computed(
  () => state.items.length > 0 && state.items.every((it) => selectedSkus.value.has(it.sku))
);
const someChecked = computed(
  () => state.items.some((it) => selectedSkus.value.has(it.sku)) && !allChecked.value
);
const selectedCount = computed(() => selectedSkus.value.size);

// 并发请求序号:用户快速翻页/搜索时,旧请求的响应应被忽略,避免旧数据覆盖新状态
let loadListReqId = 0;
async function loadList() {
  const myId = ++loadListReqId;
  state.loading = true;
  try {
    const data = await getCacheOverview({
      keyword: state.keyword.trim(),
      page: state.page,
      pageSize: state.pageSize,
    });
    if (myId !== loadListReqId) return; // 已被新请求取代,丢弃旧响应
    state.items = data?.items || [];
    state.total = data?.total || 0;
    // 翻页/搜索后清空选中(选中集合仅限当前页有效)
    selectedSkus.value = new Set();
  } catch (err) {
    if (myId !== loadListReqId) return;
    show(err.message || String(err), 'error');
    state.items = [];
    state.total = 0;
    selectedSkus.value = new Set();
  } finally {
    if (myId === loadListReqId) state.loading = false;
  }
}

function search() {
  state.page = 1;
  loadList();
}

function onPageChange(p) {
  state.page = p;
  loadList();
}

// 切换子 tab 现通过一级路由导航实现(保留 switchType 供内部调用)
function switchType(t) {
  const path = TYPE_TO_PATH[t];
  if (path && path !== route.path) {
    router.push(path);
  }
}

// 路由变化时同步 state.type 并加载对应数据(一级 tab 切换驱动)
watch(
  () => route.path,
  (newPath) => {
    const t = PATH_TO_TYPE[newPath];
    if (!t || t === state.type) return;
    state.type = t;
    state.page = 1;
    state.keyword = '';
    selectedSkus.value = new Set();
    if (t === 'store-classification') {
      loadStoreClassifications();
    } else if (t === 'store-sku') {
      loadStoreSkus();
    } else {
      loadList();
    }
  }
);

// ── SKU 多选与删除 ─────────────────────────────────────────
function toggleRow(sku, checked) {
  const next = new Set(selectedSkus.value);
  if (checked) next.add(sku);
  else next.delete(sku);
  selectedSkus.value = next;
}

function toggleAll(checked) {
  const next = new Set(selectedSkus.value);
  if (checked) {
    for (const it of state.items) next.add(it.sku);
  } else {
    for (const it of state.items) next.delete(it.sku);
  }
  selectedSkus.value = next;
}

// 单个删除:删除该 SKU 的 5 类缓存 + 索引行
async function deleteOne(it) {
  if (!it?.sku) return;
  if (!(await confirmStore.ask({ message: `确认删除 SKU ${it.sku} 的全部缓存(dom/attribute/richMedia/marketStats/followSell + 索引)?`, danger: true }))) return;
  state.deleting = true;
  try {
    await deleteSkuAll(it.sku);
    show(`已删除 SKU ${it.sku}`, 'success');
    // 从选中集合中移除(若存在)
    if (selectedSkus.value.has(it.sku)) {
      const next = new Set(selectedSkus.value);
      next.delete(it.sku);
      selectedSkus.value = next;
    }
    await loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    state.deleting = false;
  }
}

// 选中删除:批量删除当前选中的 SKU
async function deleteSelected() {
  const skus = Array.from(selectedSkus.value);
  if (!skus.length) {
    show('请先选择要删除的 SKU', 'error');
    return;
  }
  if (!(await confirmStore.ask({ message: `确认删除选中的 ${skus.length} 个 SKU 的全部缓存?`, danger: true }))) return;
  state.deleting = true;
  try {
    const r = await batchDeleteSkus({ skus });
    const ok2 = r?.deletedCount || 0;
    const fail = r?.failed?.length || 0;
    show(`已删除 ${ok2}/${skus.length} 个 SKU${fail ? `,${fail} 个失败` : ''}`, fail ? 'error' : 'success');
    selectedSkus.value = new Set();
    await loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    state.deleting = false;
  }
}

// 按当前筛选条件删除:删除所有匹配 keyword 的 SKU(不限当前页)
async function deleteByFilter() {
  const kw = state.keyword.trim();
  const tip = kw
    ? `确认删除所有匹配关键词 "${kw}" 的 SKU 缓存?(不限当前页,可能数量较多)`
    : '确认删除所有 SKU 缓存?(未输入关键词,将清空全部)';
  if (!(await confirmStore.ask({ message: tip, danger: true }))) return;
  state.deleting = true;
  try {
    const r = await batchDeleteSkus({ filter: { keyword: kw } });
    const ok2 = r?.deletedCount || 0;
    const fail = r?.failed?.length || 0;
    const total = r?.total || 0;
    show(`已删除 ${ok2}/${total} 个 SKU${fail ? `,${fail} 个失败` : ''}`, fail ? 'error' : 'success');
    selectedSkus.value = new Set();
    state.page = 1;
    await loadList();
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    state.deleting = false;
  }
}

// ── 渲染辅助 ───────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// overview 行中 dom 命中 = card 或 detail 任一命中
function domHit(it) {
  return !!(it.card || it.detail);
}
function domFetchedAt(it) {
  const a = it.card?.fetchedAt ? new Date(it.card.fetchedAt).getTime() : 0;
  const b = it.detail?.fetchedAt ? new Date(it.detail.fetchedAt).getTime() : 0;
  const max = Math.max(a, b);
  return max ? new Date(max).toISOString() : null;
}
// overview 行中 attribute 命中 = search 或 bundle 任一命中
function attributeHit(it) {
  return !!(it.search || it.bundle);
}
function attributeFetchedAt(it) {
  const a = it.search?.fetchedAt ? new Date(it.search.fetchedAt).getTime() : 0;
  const b = it.bundle?.fetchedAt ? new Date(it.bundle.fetchedAt).getTime() : 0;
  const max = Math.max(a, b);
  return max ? new Date(max).toISOString() : null;
}

function isStale(it, type) {
  // overview 矩阵:marketStats 基于 fetchedAt 超过 24h 判定 stale
  if (type === 'marketStats') {
    const entry = it.marketStats;
    if (!entry || !entry.fetchedAt) return false;
    const age = Date.now() - new Date(entry.fetchedAt).getTime();
    return age > 24 * 60 * 60 * 1000;
  }
  // followSell:基于 fetchedAt 超过 4h 判定 stale(与后端 FOLLOW_SELL_STALE_MS 对齐)
  if (type === 'followSell') {
    const entry = it.followSell;
    if (!entry || !entry.fetchedAt) return false;
    const age = Date.now() - new Date(entry.fetchedAt).getTime();
    return age > 4 * 60 * 60 * 1000;
  }
  return false;
}

// 命中徽章渲染
// type: 'dom' | 'attribute' | 'richMedia' | 'marketStats' | 'followSell'
function hitBadgeClass(it, type) {
  let hit = false;
  let stale = false;
  if (type === 'dom') {
    hit = domHit(it);
  } else if (type === 'attribute') {
    hit = attributeHit(it);
  } else if (type === 'richMedia') {
    hit = !!it.richMedia;
  } else if (type === 'marketStats') {
    hit = !!it.marketStats;
    stale = isStale(it, 'marketStats');
  } else if (type === 'followSell') {
    hit = !!it.followSell;
    stale = isStale(it, 'followSell');
  }
  if (!hit) return 'tag tag-mute';
  return stale ? 'tag tag-warn' : 'tag tag-ok';
}
function hitBadgeText(it, type) {
  let hit = false;
  let stale = false;
  let fetchedAt = null;
  if (type === 'dom') {
    hit = domHit(it);
    fetchedAt = domFetchedAt(it);
  } else if (type === 'attribute') {
    hit = attributeHit(it);
    fetchedAt = attributeFetchedAt(it);
  } else if (type === 'richMedia') {
    hit = !!it.richMedia;
    fetchedAt = it.richMedia?.fetchedAt;
  } else if (type === 'marketStats') {
    hit = !!it.marketStats;
    stale = isStale(it, 'marketStats');
    fetchedAt = it.marketStats?.fetchedAt;
  } else if (type === 'followSell') {
    hit = !!it.followSell;
    stale = isStale(it, 'followSell');
    fetchedAt = it.followSell?.fetchedAt;
  }
  if (!hit) return '—';
  if (stale) return '过期';
  return '✓';
}
function hitBadgeTitle(it, type) {
  let fetchedAt = null;
  if (type === 'dom') fetchedAt = domFetchedAt(it);
  else if (type === 'attribute') fetchedAt = attributeFetchedAt(it);
  else if (type === 'richMedia') fetchedAt = it.richMedia?.fetchedAt;
  else if (type === 'marketStats') fetchedAt = it.marketStats?.fetchedAt;
  else if (type === 'followSell') fetchedAt = it.followSell?.fetchedAt;
  return fetchedAt ? `抓取于 ${fmtTime(fetchedAt)}` : '';
}

// ── 详情弹窗(按 type 调用 /ozon/cache/{type}/:sku,5 类缓存统一接口) ────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailType = ref(''); // 'dom' | 'attribute' | 'richMedia' | 'marketStats' | 'followSell'
const detailSku = ref('');
const detailData = ref(null); // 原始响应
const detailTitle = computed(() => `详情 · ${detailType.value} · ${detailSku.value}`);

const TYPE_LABELS = {
  dom: 'Dom(card + detail 合并)',
  attribute: 'Attribute(search + bundle 合并)',
  richMedia: 'richMedia(富媒体)',
  marketStats: 'marketStats(市场统计)',
  followSell: '跟卖列表(采集到的跟卖数据)',
};

// 详情弹窗并发序号:用户快速切换不同 SKU/类型时,旧请求响应应被忽略
let openDetailReqId = 0;
async function openDetail(it, type) {
  // 仅在命中时才允许打开
  if (!hitBadgeText(it, type) || hitBadgeText(it, type) === '—') return;
  const myId = ++openDetailReqId;
  detailOpen.value = true;
  detailLoading.value = true;
  detailType.value = type;
  detailSku.value = it.sku;
  detailData.value = null;
  try {
    // 5 类缓存统一走 /ozon/cache/{type}/:sku
    const data = await getCacheByType(type, it.sku);
    if (myId !== openDetailReqId) return; // 已被新请求取代,丢弃旧响应
    detailData.value = data;
  } catch (err) {
    if (myId !== openDetailReqId) return;
    show(err.message || String(err), 'error');
    detailData.value = null;
  } finally {
    if (myId === openDetailReqId) detailLoading.value = false;
  }
}

// 把详情响应扁平化为 { label, value } 项列表用于展示 meta
function detailMetaItems() {
  if (!detailData.value) return [];
  const d = detailData.value;
  const items = [];
  if (detailType.value === 'dom') {
    if (d.cardFetchedAt) items.push({ label: 'card 抓取时间', value: fmtTime(d.cardFetchedAt) });
    if (d.detailFetchedAt) items.push({ label: 'detail 抓取时间', value: fmtTime(d.detailFetchedAt) });
  } else if (detailType.value === 'attribute') {
    if (d.searchFetchedAt) items.push({ label: 'search 抓取时间', value: fmtTime(d.searchFetchedAt) });
    if (d.bundleFetchedAt) items.push({ label: 'bundle 抓取时间', value: fmtTime(d.bundleFetchedAt) });
    if (d.bundleId) items.push({ label: 'bundleId', value: d.bundleId });
    if (d.attrsEmptyVerifiedAt)
      items.push({ label: '空属性验证', value: fmtTime(d.attrsEmptyVerifiedAt) });
    if (d.stale !== undefined)
      items.push({ label: '数据状态', value: d.stale ? '已过期(空属性超 6h)' : '新鲜' });
  } else if (detailType.value === 'richMedia') {
    if (d.fetchedAt) items.push({ label: '抓取时间', value: fmtTime(d.fetchedAt) });
  } else if (detailType.value === 'marketStats') {
    if (d.fetchedAt) items.push({ label: '抓取时间', value: fmtTime(d.fetchedAt) });
    if (d.l2Synced !== undefined)
      items.push({ label: 'L2 同步', value: d.l2Synced ? '已同步' : '待同步' });
    if (d.stale !== undefined)
      items.push({ label: '数据状态', value: d.stale ? '已过期' : '新鲜' });
  } else if (detailType.value === 'followSell') {
    if (d.fetchedAt) items.push({ label: '抓取时间', value: fmtTime(d.fetchedAt) });
    if (d.l2Synced !== undefined)
      items.push({ label: 'L2 同步', value: d.l2Synced ? '已同步' : '待同步' });
    if (d.stale !== undefined)
      items.push({ label: '数据状态', value: d.stale ? '已过期(>4h)' : '新鲜' });
    // 跟卖列表数据可能有 sellers / competitors 字段
    const sellers = d.data?.sellers || d.data?.competitors;
    if (Array.isArray(sellers)) {
      items.push({ label: '跟卖卖家数', value: String(sellers.length) });
    }
  }
  return items;
}

// 详情的 JsonTree 节点:按 type 取出主要数据部分展示
function detailJsonNodes() {
  if (!detailData.value) return [];
  const d = detailData.value;
  const nodes = [];
  if (detailType.value === 'dom') {
    if (d.card) nodes.push({ key: 'card', data: d.card });
    if (d.detail) nodes.push({ key: 'detail', data: d.detail });
  } else if (detailType.value === 'attribute') {
    if (d.searchData) nodes.push({ key: 'search', data: d.searchData });
    if (d.bundleData) nodes.push({ key: 'bundle', data: d.bundleData });
  } else if (detailType.value === 'richMedia') {
    if (d.data) nodes.push({ key: 'data', data: d.data });
  } else if (detailType.value === 'marketStats') {
    if (d.data) nodes.push({ key: 'data', data: d.data });
  } else if (detailType.value === 'followSell') {
    if (d.data) nodes.push({ key: 'data', data: d.data });
  }
  return nodes;
}

// ── OPI 预览 ───────────────────────────────────────────────
const opiOpen = ref(false);
const opiLoading = ref(false);
const opiSku = ref('');
const opiData = ref(null);
const opiSources = ref(null);
const opiError = ref('');
const opiTitle = computed(() => `OPI 预览 · ${opiSku.value}`);
// 字段对照标签页:五路原始数据 + 纯 search 归一化 + 属性名字典
const opiRaw = ref(null);
const opiSearchSv = ref(null);
const opiAttrDict = ref({});
const opiTab = ref('json'); // 'json' | 'compare'

// OPI 预览并发序号:用户快速切换不同 SKU 时,旧请求响应应被忽略
let openOpiReqId = 0;
async function openOpiPreview(sku) {
  const myId = ++openOpiReqId;
  opiOpen.value = true;
  opiLoading.value = true;
  opiSku.value = sku;
  opiData.value = null;
  opiSources.value = null;
  opiError.value = '';
  opiRaw.value = null;
  opiSearchSv.value = null;
  opiAttrDict.value = {};
  opiTab.value = 'json';
  try {
    const r = await getOpiPreview(sku);
    if (myId !== openOpiReqId) return; // 已被新请求取代,丢弃旧响应
    opiData.value = r?.item || null;
    opiSources.value = r?.sources || null;
    opiError.value = r?.error || '';
    opiRaw.value = r?.raw || null;
    opiSearchSv.value = r?.searchSv || null;
    opiAttrDict.value = r?.attrDict || {};
  } catch (err) {
    if (myId !== openOpiReqId) return;
    opiError.value = err.message || String(err);
  } finally {
    if (myId === openOpiReqId) opiLoading.value = false;
  }
}

// ── 字段对照(跟卖上架数据来源逐字段展示) ─────────────────
// 行结构: { groupHeader?: string, label, sub, sources: [{tag, display, selected, state, force}], final, note, state }
//   sources.state: 'ok' | 'diff'(与选中值不一致) | 'empty'(无值) | 'strike'(被覆盖/过滤)
//   行 state: 'ok' | 'warn'(存在不一致) | 'mute'(不发送/被过滤)

// 值格式化:文本截断(弹窗已加宽,阈值放宽),数组显示 张数/首项
function fcText(v, max = 160) {
  if (v == null || v === '') return '';
  const s = String(v);
  return s.length > max ? `${s.slice(0, max)}…(${s.length}字)` : s;
}
function fcArr(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const first = String(arr[0] || '');
  const firstShort = first.length > 90 ? `${first.slice(0, 90)}…` : first;
  return `${arr.length} 项 · ${firstShort}`;
}
// 全等比较(文本 ===;数组按元素全等)
function fcEq(a, b) {
  const sa = Array.isArray(a) ? a.map(String).join('\u0001') : String(a ?? '');
  const sb = Array.isArray(b) ? b.map(String).join('\u0001') : String(b ?? '');
  return sa === sb;
}
// 候选来源标记:选中 = 第一个非空;与选中值不一致的非空来源标 diff
function fcMark(cands) {
  const picked = cands.findIndex((c) => !c.isEmpty);
  const pickedVal = picked >= 0 ? cands[picked].value : null;
  return cands.map((c, i) => ({
    ...c,
    selected: i === picked,
    state: c.isEmpty ? 'empty' : i === picked || fcEq(c.value, pickedVal) ? 'ok' : 'diff',
  }));
}
function fcRow(label, sub, cands, final, note = '', rowState = 'ok') {
  const sources = fcMark(cands);
  const hasDiff = sources.some((s) => s.state === 'diff');
  return {
    label, sub, sources, final, note,
    state: hasDiff ? 'warn' : rowState,
  };
}

// transformItemForPortal 的 SKIP_ATTR_IDS(同后端 prepare-bundle.js)
const FC_SKIP_ATTR_IDS = new Set([4194, 4195, 4497, 9454, 9455, 9456, 23536]);
// 上架时强制注入的属性(buildListingMessage,_forcedAttributes)
const FC_FORCED_ATTRS = {
  85: { display: 'Нет бренда (dict 126745801)', note: '上架时强制注入' },
  9024: { display: '= offer_id', note: '上架时强制注入' },
  9048: { display: '时间戳36进制', note: '上架时强制注入' },
};

// bundle 扁平属性值 → 展示文本(values 数组含 dictionary_value_id)
function fcBundleAttrVal(ba) {
  if (!Array.isArray(ba?.values)) return '';
  return ba.values
    .map((v) => (v.dictionary_value_id ? `${v.value} (dict ${v.dictionary_value_id})` : String(v.value ?? '')))
    .filter(Boolean)
    .join(' | ');
}
// search 归一化属性值 → 展示文本
function fcSearchAttrVal(sa) {
  if (!sa) return '';
  if (Array.isArray(sa.collection)) return fcArr(sa.collection);
  return fcText(sa.value);
}

const fieldCompareRows = computed(() => {
  const raw = opiRaw.value;
  if (!raw) return [];
  const bundle = raw.bundleData || {};
  const card = raw.cardData || {};
  const detail = raw.detailData || {};
  const rm = raw.richMediaData || {};
  const sv = opiSearchSv.value || {};
  const opi = opiData.value || {};
  const rows = [];

  // ── A 组:顶层多来源字段(兜底链与后端 buildSynthesizedFromCache 一致) ──
  rows.push({ groupHeader: 'A · 顶层多来源字段' });

  const bAttr = (id) => (Array.isArray(bundle.attributes) ? bundle.attributes.find((a) => String(a.attribute_id || a.id) === id) : null);
  const sAttr = (id) => (Array.isArray(sv.attributes) ? sv.attributes.find((a) => String(a.key) === id) : null);
  const opiAttrById = (id) => (Array.isArray(opi.attributes) ? opi.attributes.find((a) => String(a.id) === id) : null);
  const rmGallery = rm.gallery?.length ? rm.gallery : rm.fields?.images || [];

  // 商品名:bundle.4180 → search.4180 → detail.title → card.name
  rows.push(fcRow('商品名', 'name', [
    { tag: 'bundle.4180', value: bAttr('4180')?.values?.[0]?.value || '' },
    { tag: 'search.4180', value: sAttr('4180')?.value || '' },
    { tag: 'detail.title', value: detail.title || '' },
    { tag: 'card.name', value: card.name || '' },
  ].map((c) => ({ ...c, isEmpty: !c.value, display: fcText(c.value) })), fcText(opi.name, 120)));

  // 售价基数:detail.price → card.price(最终价由模板公式组装时重算,此处只展示基数)
  rows.push(fcRow('售价基数', 'price', [
    { tag: 'detail.price', value: detail.price ?? '' },
    { tag: 'card.price', value: card.price ?? '' },
  ].map((c) => ({ ...c, isEmpty: c.value === '' || c.value == null, display: String(c.value ?? '') })),
    String(detail.price ?? card.price ?? ''), '模板公式组装时重算,此处不展示最终价'));

  // 划线价基数:detail.originalPrice
  rows.push(fcRow('划线价基数', 'old_price', [
    { tag: 'detail.originalPrice', value: detail.originalPrice ?? '' },
  ].map((c) => ({ ...c, isEmpty: c.value === '' || c.value == null, display: String(c.value ?? '') })),
    String(detail.originalPrice ?? ''), '组装时按售价×oldPriceA% 重算'));

  // 主图:bundle.primary_image → rm.gallery[0] → detail.images[0] → card.image
  rows.push(fcRow('主图', 'primary_image', [
    { tag: 'bundle', value: bundle.primary_image || '' },
    { tag: 'rm.gallery[0]', value: rmGallery[0] || '' },
    { tag: 'detail.images[0]', value: detail.images?.[0] || '' },
    { tag: 'card.image', value: card.image || '' },
  ].map((c) => ({ ...c, isEmpty: !c.value, display: fcText(c.value, 200) })), fcText(opi.primary_image, 200)));

  // 图片组:bundle.images → rm.gallery[1:] → detail.images(注意:detail 兜底是全量数组含主图,
  // 转换出口 transformItemForPortal 5.1 会剔除与 primary 重复的项,保证 OPI v3 约束)
  const imgB = Array.isArray(bundle.images) ? bundle.images : [];
  const imgRm = rmGallery.length > 1 ? rmGallery.slice(1) : [];
  const imgD = Array.isArray(detail.images) ? detail.images : [];
  rows.push(fcRow('图片组', 'images', [
    { tag: 'bundle', value: imgB },
    { tag: 'rm.gallery[1:]', value: imgRm },
    { tag: 'detail.images', value: imgD },
  ].map((c) => ({ ...c, isEmpty: !c.value.length, display: fcArr(c.value) })),
    fcArr(opi.images), 'detail 兜底含主图,转换时剔除重复;上架可按模板 shuffle 打乱'));

  // 描述 4191 实际优先级(与 transformItemForPortal 5.2a→5.2b→5.2c 一致):
  //   bundle.4191 → search.4191(compose merge;实测 /search 从不返回 description,恒空)
  //   → rm.description → detail.description(5.2c scraped_description 注入)
  {
    const descB = bAttr('4191')?.values?.[0]?.value || '';
    const descFinalAttr = opiAttrById('4191');
    const descFinal = descFinalAttr
      ? descFinalAttr.values.map((v) => String(v.value ?? '')).filter(Boolean).join(' | ')
      : '';
    rows.push(fcRow('描述', 'attr 4191', [
      { tag: 'bundle.4191', value: descB },
      { tag: 'search.4191', value: sAttr('4191')?.value || '' },
      { tag: 'rm.description', value: rm.description || '' },
      { tag: 'detail.desc', value: detail.description || '' },
    ].map((c) => ({ ...c, isEmpty: !c.value, display: fcText(c.value) })), fcText(descFinal, 200)));
  }

  // 物理参数:bundle 顶层(缺失兜底 100)
  for (const [label, key, unit] of [['重量', 'weight', 'g'], ['长', 'depth', 'mm'], ['宽', 'width', 'mm'], ['高', 'height', 'mm']]) {
    const v = bundle[key];
    rows.push(fcRow(label, key, [
      { tag: 'bundle', value: v ?? '' },
    ].map((c) => ({ ...c, isEmpty: c.value === '' || c.value == null, display: String(c.value ?? '') })),
      v != null && Number(v) > 0 ? `${Math.round(Number(v))} ${unit}` : `100 ${unit}(兜底)`, '缺失时兜底 100'));
  }

  // type_id:search.description_type_dict_value(sv.description_category_id 实为 type_id) → bundle.type_id
  const tidS = sv.description_category_id || '';
  const tidB = bundle.type_id ?? '';
  rows.push(fcRow('类型 ID', 'type_id', [
    { tag: 'search.dict_value', value: tidS },
    { tag: 'bundle.type_id', value: tidB },
  ].map((c) => ({ ...c, isEmpty: c.value === '' || c.value == null, display: String(c.value ?? '') })), String(opi.type_id ?? '')));

  // description_category_id:唯一来源 search.categories level=3(bundle/最深层是 level 4 叶子,不采用)
  const cats = Array.isArray(sv.categories) ? sv.categories : [];
  const lvl3 = cats.find((c) => Number(c.level) === 3 && c.id);
  const deepest = cats.filter((c) => c.id).sort((a, b) => Number(b.level || 0) - Number(a.level || 0))[0];
  {
    const picked = lvl3?.id ?? '';
    const bCat = bundle.description_category_id ?? '';
    rows.push({
      label: '类目 ID', sub: 'description_category_id',
      sources: [
        { tag: 'search.lvl3', value: picked, isEmpty: !picked, display: picked ? `${picked} (level 3)` : '', selected: !!picked, state: picked ? 'ok' : 'empty' },
        // 参考信息:bundle 的 level 4 叶子(与 search 最深层恒等),不进 payload
        { tag: 'bundle.desc_cat_id', value: bCat, isEmpty: !bCat, display: bCat ? `${bCat} (level ${deepest?.level ?? 4} 叶子)` : '', selected: false, state: 'strike' },
      ],
      final: String(opi.description_category_id ?? ''),
      note: '唯一来源 search.lvl3;level 4 叶子会导致字典接口 400',
      state: 'ok',
    });
  }

  // barcode:search.barcodes[0] → bundle.barcode(不发送)
  const bcS = sv._searchMeta?.barcodes?.[0] || '';
  const bcB = bundle.barcode || '';
  rows.push(fcRow('条码', 'barcode', [
    { tag: 'search.barcodes[0]', value: bcS },
    { tag: 'bundle.barcode', value: bcB },
  ].map((c) => ({ ...c, isEmpty: !c.value, display: fcText(c.value, 30) })),
    '不发送', 'toOpiItem 已注释,不上送 GTIN', 'mute'));

  // 视频:rm.mp4(默认 skip 不发送)
  rows.push(fcRow('视频', 'video_url', [
    { tag: 'rm.mp4', value: rm.mp4 || '' },
  ].map((c) => ({ ...c, isEmpty: !c.value, display: fcText(c.value, 200) })),
    '不发送', 'videoMode=skip 默认置空', 'mute'));

  // ── B 组:强制注入 / 生成字段 ──
  rows.push({ groupHeader: 'B · 强制注入 / 生成字段' });

  // offer_id:预览态为 SKU+sku,上架时为 {SKU}-{MMDD}-qx
  rows.push({
    label: 'offer_id', sub: '生成',
    sources: [{ tag: '生成', display: `上架时 {SKU}-{MMDD}-qx`, selected: true, state: 'ok', force: true }],
    final: opi.offer_id || '', note: '预览态占位,上架时按日期生成', state: 'ok',
  });
  // 币种/税率
  rows.push({
    label: '币种 / 税率', sub: 'currency_code / vat',
    sources: [
      { tag: '店铺配置', display: opi.currency_code || 'RUB', selected: true, state: 'ok', force: true },
      { tag: '常量', display: 'vat 0', selected: true, state: 'ok', force: true },
    ],
    final: `${opi.currency_code || 'RUB'} / ${opi.vat ?? '0'}`, note: '', state: 'ok',
  });
  // 富内容 11254:rm.richContent 强制注入 _forcedAttributes
  const rcLen = rm.richContent ? String(rm.richContent).length : 0;
  rows.push({
    label: '富内容', sub: 'attr 11254',
    sources: [{ tag: '强制(rm)', display: rcLen ? `${rcLen} 字符` : '', selected: true, state: rcLen ? 'ok' : 'empty', force: true }],
    final: rcLen ? '注入 _forcedAttributes' : '无', note: '跳过白名单,覆盖同 id 属性', state: 'ok',
  });

  // ── C 组:attributes 全量对照 ──
  const attrIds = new Set();
  if (Array.isArray(bundle.attributes)) {
    for (const a of bundle.attributes) {
      if (a.complex_id && Number(a.complex_id) !== 0) continue;
      const id = String(a.attribute_id || a.id || '');
      if (id) attrIds.add(id);
    }
  }
  if (Array.isArray(sv.attributes)) for (const a of sv.attributes) if (a.key) attrIds.add(String(a.key));
  if (Array.isArray(opi.attributes)) for (const a of opi.attributes) if (a.id) attrIds.add(String(a.id));
  for (const id of Object.keys(FC_FORCED_ATTRS)) attrIds.add(id);

  rows.push({ groupHeader: `C · attributes 全量对照(${attrIds.size} 个)` });

  const opiAttr = opiAttrById;
  for (const id of [...attrIds].sort((a, b) => Number(a) - Number(b))) {
    const attrName = opiAttrDict.value?.[id]?.name || '';
    const ba = bAttr(id);
    const sa = sAttr(id);
    const bVal = ba ? fcBundleAttrVal(ba) : '';
    const sVal = fcSearchAttrVal(sa);
    const isSkip = FC_SKIP_ATTR_IDS.has(Number(id));
    const forced = FC_FORCED_ATTRS[Number(id)];
    const finalAttr = opiAttr(id);
    const finalVal = finalAttr
      ? finalAttr.values.map((v) => (v.dictionary_value_id ? `${v.value} (dict ${v.dictionary_value_id})` : String(v.value ?? ''))).filter(Boolean).join(' | ')
      : '';

    const cands = [];
    if (forced) {
      cands.push({ tag: '强制', value: forced.display, isEmpty: false, display: forced.display, force: true });
      if (bVal) cands.push({ tag: 'bundle', value: bVal, isEmpty: false, display: bVal });
      if (sVal) cands.push({ tag: 'search', value: sVal, isEmpty: false, display: sVal });
      // 强制行:非强制来源全部 strike(被覆盖)
      const marked = cands.map((c, i) => ({ ...c, selected: i === 0, state: i === 0 ? 'ok' : 'strike' }));
      rows.push({
        label: id, sub: attrName || 'ID ' + id,
        sources: marked,
        final: finalVal || forced.display,
        note: forced.note, state: 'ok',
      });
      continue;
    }
    if (isSkip) {
      const c = [];
      if (bVal) c.push({ tag: 'bundle', value: bVal, isEmpty: false, display: bVal, selected: false, state: 'strike' });
      if (sVal) c.push({ tag: 'search', value: sVal, isEmpty: false, display: sVal, selected: false, state: 'strike' });
      if (c.length === 0) c.push({ tag: 'bundle/search', value: '', isEmpty: true, display: '—', selected: false, state: 'strike' });
      rows.push({
        label: id, sub: attrName || 'ID ' + id,
        sources: c,
        final: 'SKIP_ATTR_IDS 过滤', note: '避免重复字段错误,不上送', state: 'mute',
      });
      continue;
    }
    // 4191 特殊:bundle/search 都缺失时由 5.2c scraped_description 注入(rm → detail),
    // 把注入来源也列为候选,避免最终值"来历不明"
    if (id === '4191') {
      const rmDesc = rm.description || '';
      const detDesc = detail.description || '';
      rows.push(fcRow(id, attrName || 'ID ' + id, [
        { tag: 'bundle', value: bVal, isEmpty: !bVal, display: fcText(bVal) },
        { tag: 'search', value: sVal, isEmpty: !sVal, display: fcText(sVal) },
        { tag: 'rm.description', value: rmDesc, isEmpty: !rmDesc, display: fcText(rmDesc) },
        { tag: 'detail.desc', value: detDesc, isEmpty: !detDesc, display: fcText(detDesc) },
      ], fcText(finalVal, 300), 'bundle/search 缺失时走 5.2c 注入(scraped_description: rm→detail)'));
      continue;
    }
    // 11254 富内容:search/bundle 接口都不返回,唯一来源是 richMedia 缓存(强制注入 _forcedAttributes,
    // 跳过白名单、覆盖同 id 属性)——预览合成(opi-item-builder.injectRichContentAttr)与上架补全同通路
    if (id === '11254') {
      const rc = rm.richContent ? String(rm.richContent) : '';
      rows.push({
        label: id, sub: attrName || 'ID ' + id,
        sources: [
          { tag: 'rm.richContent', value: rc, isEmpty: !rc, display: rc ? `${rc.length} 字符(JSON)` : '', selected: !!rc, state: rc ? 'ok' : 'empty', force: true },
          { tag: 'bundle', value: bVal, isEmpty: !bVal, display: fcText(bVal) },
          { tag: 'search', value: sVal, isEmpty: !sVal, display: fcText(sVal) },
        ].map((c, i) => (i === 0 ? c : { ...c, selected: false, state: c.isEmpty ? 'empty' : 'strike' })),
        final: finalVal ? fcText(finalVal, 300) : '无',
        note: '强制注入 _forcedAttributes,跳过白名单',
        state: 'ok',
      });
      continue;
    }
    // 常规属性:bundle 优先(含 dict id,最权威),search 兜底
    cands.push({ tag: 'bundle', value: bVal, isEmpty: !bVal, display: bVal || '' });
    cands.push({ tag: 'search', value: sVal, isEmpty: !sVal, display: sVal || '' });
    rows.push(fcRow(id, attrName || 'ID ' + id, cands, finalVal, finalVal ? '' : '未进入最终 payload'));
  }

  return rows;
});

function opiSourceTag(hit) {
  return hit ? 'tag-ok' : 'tag-mute';
}

function opiSourceLabel(hit, type) {
  return hit ? type : '—';
}

// ── 店铺分类徽章 ──────────────────────────────────────────
function storeClassBadge(isMainlandChina) {
  if (isMainlandChina === true) return 'badge-mainland-china';
  if (isMainlandChina === false) return 'badge-non-mainland-china';
  return 'badge-pending';
}

// 店铺链接:固定格式 https://www.ozon.ru/seller/{sellerId}
function storeUrl(sc) {
  const sid = sc?.sellerId || sc?._id || '';
  return sid ? `https://www.ozon.ru/seller/${sid}/` : '';
}

// ── 店铺分类 ───────────────────────────────────────────────
// 持久化:sortBy 单独存(字符串);其余过滤条件整体以 JSON 存。两者独立,避免互相覆盖
const STORE_CLASS_SORT_KEY = 'erp:store-classification:sortBy';
const STORE_CLASS_FILTERS_KEY = 'erp:store-classification:filters';
function loadPersistedSortBy() {
  try {
    const v = localStorage.getItem(STORE_CLASS_SORT_KEY);
    // 仅接受合法值,空串也合法(表示默认 lastSeenAt 排序)
    if (v === null) return 'skuCount';
    if (v === '' || v === 'skuCount' || v === 'ordersCount' || v === 'reviewsCount' || v === 'rating' || v === 'openedMonths') {
      return v;
    }
  } catch (_) { /* localStorage 不可用时回退默认值 */ }
  return 'skuCount';
}
function persistSortBy(v) {
  try { localStorage.setItem(STORE_CLASS_SORT_KEY, v); } catch (_) { /* 忽略写入失败 */ }
}

// 读取持久化过滤条件,与默认值合并(缺失字段用默认值,避免旧数据缺字段导致 undefined)
function loadPersistedFilters() {
  const defaults = {
    isMainlandChina: null,
    keyword: '',
    skuCountMin: '',
    skuCountMax: '',
    ordersCountMin: '',
    ordersCountMax: '',
    reviewsCountMin: '',
    reviewsCountMax: '',
    ratingMin: '',
    ratingMax: '',
    openedMonthsMin: '',
    openedMonthsMax: '',
  };
  try {
    const raw = localStorage.getItem(STORE_CLASS_FILTERS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    // isMainlandChina 必须是 null/true/false,其他值回退 null
    if (parsed.isMainlandChina !== null && parsed.isMainlandChina !== true && parsed.isMainlandChina !== false) {
      parsed.isMainlandChina = null;
    }
    return { ...defaults, ...parsed };
  } catch (_) {
    return defaults;
  }
}
// 持久化当前过滤条件(不含 sortBy,sortBy 单独存)
function persistFilters() {
  try {
    localStorage.setItem(
      STORE_CLASS_FILTERS_KEY,
      JSON.stringify({
        isMainlandChina: storeClassFilters.isMainlandChina,
        keyword: storeClassFilters.keyword,
        skuCountMin: storeClassFilters.skuCountMin,
        skuCountMax: storeClassFilters.skuCountMax,
        ordersCountMin: storeClassFilters.ordersCountMin,
        ordersCountMax: storeClassFilters.ordersCountMax,
        reviewsCountMin: storeClassFilters.reviewsCountMin,
        reviewsCountMax: storeClassFilters.reviewsCountMax,
        ratingMin: storeClassFilters.ratingMin,
        ratingMax: storeClassFilters.ratingMax,
        openedMonthsMin: storeClassFilters.openedMonthsMin,
        openedMonthsMax: storeClassFilters.openedMonthsMax,
      })
    );
  } catch (_) { /* 忽略写入失败 */ }
}

const _initFilters = loadPersistedFilters();
const storeClassifications = ref([]);
const storeClassFilters = reactive({
  isMainlandChina: _initFilters.isMainlandChina,
  keyword: _initFilters.keyword,
  sortBy: loadPersistedSortBy(), // 默认按采集 SKU 数降序;'' → 按 lastSeenAt 降序
  // 5 个数值范围筛选(min/max 各自可单独填)
  skuCountMin: _initFilters.skuCountMin,
  skuCountMax: _initFilters.skuCountMax,
  ordersCountMin: _initFilters.ordersCountMin,
  ordersCountMax: _initFilters.ordersCountMax,
  reviewsCountMin: _initFilters.reviewsCountMin,
  reviewsCountMax: _initFilters.reviewsCountMax,
  ratingMin: _initFilters.ratingMin,
  ratingMax: _initFilters.ratingMax,
  openedMonthsMin: _initFilters.openedMonthsMin,
  openedMonthsMax: _initFilters.openedMonthsMax,
});
const storeClassPager = reactive({
  current: 1,
  total: 0,
  pageSize: 50,
});

// 店铺分类列表并发序号:翻页/搜索时旧请求响应应被忽略
let loadStoreClassReqId = 0;
async function loadStoreClassifications() {
  const myId = ++loadStoreClassReqId;
  // 持久化过滤条件:翻页/查询时也保留,与 UI 当前状态一致
  persistFilters();
  try {
    const data = await getStoreClassificationList({
      isMainlandChina: storeClassFilters.isMainlandChina,
      keyword: storeClassFilters.keyword.trim(),
      currentPage: storeClassPager.current,
      pageSize: storeClassPager.pageSize,
      sortBy: storeClassFilters.sortBy,
      skuCountMin: storeClassFilters.skuCountMin,
      skuCountMax: storeClassFilters.skuCountMax,
      ordersCountMin: storeClassFilters.ordersCountMin,
      ordersCountMax: storeClassFilters.ordersCountMax,
      reviewsCountMin: storeClassFilters.reviewsCountMin,
      reviewsCountMax: storeClassFilters.reviewsCountMax,
      ratingMin: storeClassFilters.ratingMin,
      ratingMax: storeClassFilters.ratingMax,
      openedMonthsMin: storeClassFilters.openedMonthsMin,
      openedMonthsMax: storeClassFilters.openedMonthsMax,
    });
    if (myId !== loadStoreClassReqId) return; // 已被新请求取代
    storeClassifications.value = data?.items || [];
    storeClassPager.total = data?.total || 0;
  } catch (err) {
    if (myId !== loadStoreClassReqId) return;
    show(err.message || String(err), 'error');
    storeClassifications.value = [];
    storeClassPager.total = 0;
  }
}

// 切换排序方式:点击列 → 该列降序;再次点击同列 → 回到默认(lastSeenAt 降序)
// sortKey 可选值:'skuCount' / 'ordersCount' / 'reviewsCount' / 'rating' / 'openedMonths'
function toggleStoreClassSort(sortKey = 'skuCount') {
  storeClassFilters.sortBy = storeClassFilters.sortBy === sortKey ? '' : sortKey;
  persistSortBy(storeClassFilters.sortBy);
  storeClassPager.current = 1;
  loadStoreClassifications();
}

// 重置筛选(保留 sortBy,因为排序是用户偏好,不应当作筛选清空;清空后也持久化,避免下次恢复旧筛选)
function resetStoreClassFilters() {
  storeClassFilters.isMainlandChina = null;
  storeClassFilters.keyword = '';
  storeClassFilters.skuCountMin = '';
  storeClassFilters.skuCountMax = '';
  storeClassFilters.ordersCountMin = '';
  storeClassFilters.ordersCountMax = '';
  storeClassFilters.reviewsCountMin = '';
  storeClassFilters.reviewsCountMax = '';
  storeClassFilters.ratingMin = '';
  storeClassFilters.ratingMax = '';
  storeClassFilters.openedMonthsMin = '';
  storeClassFilters.openedMonthsMax = '';
  storeClassPager.current = 1;
  loadStoreClassifications();
}

function searchStoreClassifications() {
  storeClassPager.current = 1;
  loadStoreClassifications();
}

function onStoreClassPageChange(p) {
  storeClassPager.current = p;
  loadStoreClassifications();
}

async function updateStoreClass(sellerId, data) {
  if (!sellerId) {
    show('缺少 sellerId,无法更新(可能为旧数据,需扩展端上报 sellerId 后再操作)', 'error');
    return;
  }
  try {
    // ERP 后台手动标记视为 manual 分类,与 SW 的 manualClassifyStore 保持一致
    // (不补 classifiedBy 时后端默认写空字符串,导致 SW L2 命中后无法识别分类来源)
    await updateStoreClassification(sellerId, { ...data, classifiedBy: 'manual' });
    show('已更新', 'success');
    await loadStoreClassifications();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

async function deleteStoreClass(sellerId, displayName) {
  const label = displayName || sellerId;
  if (!(await confirmStore.ask({ message: `确认删除店铺分类 ${label}?`, danger: true }))) return;
  if (!sellerId) {
    show('缺少 sellerId,无法删除(可能为旧数据)', 'error');
    return;
  }
  try {
    await deleteStoreClassification(sellerId);
    show('已删除', 'success');
    await loadStoreClassifications();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// ── 店铺 SKU 关联 ─────────────────────────────────────────
const storeSkus = ref([]);
const storeSkuFilters = reactive({
  keyword: '',
});
const storeSkuPager = reactive({
  current: 1,
  total: 0,
  pageSize: 50,
});

// 店铺 SKU 列表并发序号:翻页/搜索时旧请求响应应被忽略
let loadStoreSkuReqId = 0;
async function loadStoreSkus() {
  const myId = ++loadStoreSkuReqId;
  try {
    const data = await getStoreSkuList({
      keyword: storeSkuFilters.keyword.trim(),
      currentPage: storeSkuPager.current,
      pageSize: storeSkuPager.pageSize,
    });
    if (myId !== loadStoreSkuReqId) return; // 已被新请求取代
    storeSkus.value = data?.items || [];
    storeSkuPager.total = data?.total || 0;
  } catch (err) {
    if (myId !== loadStoreSkuReqId) return;
    show(err.message || String(err), 'error');
    storeSkus.value = [];
    storeSkuPager.total = 0;
  }
}

function searchStoreSkus() {
  storeSkuPager.current = 1;
  loadStoreSkus();
}

function onStoreSkuPageChange(p) {
  storeSkuPager.current = p;
  loadStoreSkus();
}

async function deleteStoreSkuRecord(sku) {
  if (!(await confirmStore.ask({ message: `确认删除店铺 SKU 关联 ${sku}?`, danger: true }))) return;
  try {
    await deleteStoreSku(sku);
    show('已删除', 'success');
    await loadStoreSkus();
  } catch (err) {
    show(err.message || String(err), 'error');
  }
}

// 采集状态标签 class
function collectStatusTag(status) {
  if (status === 'success') return 'tag tag-ok';
  if (status === 'failed' || status === 'antibot') return 'tag tag-err';
  if (status === 'partial') return 'tag tag-warn';
  if (status === 'skipped') return 'tag tag-mute';
  return 'tag tag-mute';
}

// 各 type 对应的页面标题
const PAGE_TITLE = {
  overview: 'SKU 数据',
  'store-classification': '店铺数据',
  'store-sku': '店铺 SKU',
};
const pageTitle = computed(() => PAGE_TITLE[state.type] || '数据管理');

onMounted(() => {
  // 根据当前路由 type 加载对应列表
  if (state.type === 'store-classification') {
    loadStoreClassifications();
  } else if (state.type === 'store-sku') {
    loadStoreSkus();
  } else {
    loadList();
  }
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>{{ pageTitle }}</h2>
      <div style="display: flex; gap: 8px">
        <button v-if="state.type === 'overview'" class="btn btn-ghost" :disabled="state.loading" @click="loadList">
          {{ state.loading ? '刷新中…' : '刷新列表' }}
        </button>
      </div>
    </div>

    <!-- SKU 数据 tab -->
    <template v-if="state.type === 'overview'">
      <!-- 筛选 -->
      <div class="filter-bar">
        <input class="filter-input" type="text" v-model.trim="state.keyword" placeholder="搜索 SKU / 名称 / 店铺"
          @keydown.enter="search" />
        <button class="btn btn-primary" @click="search">查询</button>
        <span style="flex: 1"></span>
        <span v-if="selectedCount" class="muted" style="font-size: 12px; align-self: center">
          已选 {{ selectedCount }} 个
        </span>
        <button class="btn btn-sm btn-ghost" :disabled="state.deleting || !selectedCount" :title="'删除当前选中的 SKU 缓存'"
          @click="deleteSelected">
          选中删除
        </button>
        <button class="btn btn-sm btn-danger" :disabled="state.deleting" :title="'按当前关键词筛选删除所有匹配 SKU 缓存(不限当前页)'"
          @click="deleteByFilter">
          按筛选删除
        </button>
      </div>

      <!-- 列表 -->
      <div class="table-wrap">
        <table class="data-table overview-table">
          <thead>
            <tr>
              <th class="col-check">
                <input type="checkbox" :checked="allChecked" :indeterminate.prop="someChecked"
                  @change="toggleAll($event.target.checked)" title="全选/反选当前页" />
              </th>
              <th>SKU</th>
              <th title="card + detail 合并表(DOM 解析字段)">Dom</th>
              <th title="search + bundle 合并表(Seller Portal 属性)">Attribute</th>
              <th title="富媒体缓存(图册/视频/富内容/fields)">richMedia</th>
              <th title="市场统计缓存(stale 24h)">marketStats</th>
              <th title="点击查看采集到的跟卖列表数据(基于 followSell 缓存)">跟卖列表</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="state.loading && !state.items.length">
              <td colspan="8" class="muted" style="padding: 24px; text-align: center">加载中…</td>
            </tr>
            <tr v-else-if="!state.items.length">
              <td colspan="8" class="empty">暂无数据</td>
            </tr>
            <tr v-for="it in state.items" :key="it.sku">
              <td class="col-check">
                <input type="checkbox" :checked="selectedSkus.has(it.sku)"
                  @change="toggleRow(it.sku, $event.target.checked)" />
              </td>
              <td class="col-sku">
                <a :href="OZON_PDP_PREFIX + it.sku + '/'" target="_blank" rel="noopener" class="sku-link">
                  {{ it.sku }}
                </a>
              </td>
              <td class="cell-clickable" :title="hitBadgeTitle(it, 'dom')" @click="openDetail(it, 'dom')">
                <span :class="hitBadgeClass(it, 'dom')">{{ hitBadgeText(it, 'dom') }}</span>
              </td>
              <td class="cell-clickable" :title="hitBadgeTitle(it, 'attribute')" @click="openDetail(it, 'attribute')">
                <span :class="hitBadgeClass(it, 'attribute')">{{ hitBadgeText(it, 'attribute') }}</span>
              </td>
              <td class="cell-clickable" :title="hitBadgeTitle(it, 'richMedia')" @click="openDetail(it, 'richMedia')">
                <span :class="hitBadgeClass(it, 'richMedia')">{{ hitBadgeText(it, 'richMedia') }}</span>
              </td>
              <td class="cell-clickable" :title="hitBadgeTitle(it, 'marketStats')"
                @click="openDetail(it, 'marketStats')">
                <span :class="hitBadgeClass(it, 'marketStats')">{{ hitBadgeText(it, 'marketStats') }}</span>
              </td>
              <td class="cell-clickable" :title="hitBadgeTitle(it, 'followSell')" @click="openDetail(it, 'followSell')">
                <span :class="hitBadgeClass(it, 'followSell')">{{ hitBadgeText(it, 'followSell') }}</span>
              </td>
              <td class="row-actions">
                <button class="btn btn-sm btn-primary" @click="openOpiPreview(it.sku)">OPI 预览</button>
                <button class="btn btn-sm btn-danger" :disabled="state.deleting" @click="deleteOne(it)">
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <AppPager :modelValue="state.page" :total="state.total" :pageSize="state.pageSize"
        @update:modelValue="onPageChange" />
    </template>

    <!-- ── 店铺数据 tab ───────────────────────────────────── -->
    <div v-if="state.type === 'store-classification'" class="store-classification-tab">
      <div class="filter-bar">
        <select v-model="storeClassFilters.isMainlandChina" class="filter-input">
          <option :value="null">全部分类</option>
          <option :value="true">中国店铺</option>
          <option :value="false">非中国店铺</option>
        </select>
        <input class="filter-input" type="text" v-model.trim="storeClassFilters.keyword" placeholder="店铺名 / Seller ID"
          @keydown.enter="searchStoreClassifications" />
        <button class="btn btn-primary" @click="searchStoreClassifications">查询</button>
      </div>

      <!-- 高级筛选:min/max 数值范围,5 个字段(采集SKU/订单数/评论数/评分/开业时长) -->
      <div class="filter-advanced">
        <div class="filter-group">
          <label>采集 SKU</label>
          <input type="number" class="num-input" v-model.trim="storeClassFilters.skuCountMin" placeholder="min"
            @keydown.enter="searchStoreClassifications" />
          <span class="dash">—</span>
          <input type="number" class="num-input" v-model.trim="storeClassFilters.skuCountMax" placeholder="max"
            @keydown.enter="searchStoreClassifications" />
        </div>
        <div class="filter-group">
          <label>订单数</label>
          <input type="number" class="num-input" v-model.trim="storeClassFilters.ordersCountMin" placeholder="min"
            @keydown.enter="searchStoreClassifications" />
          <span class="dash">—</span>
          <input type="number" class="num-input" v-model.trim="storeClassFilters.ordersCountMax" placeholder="max"
            @keydown.enter="searchStoreClassifications" />
        </div>
        <div class="filter-group">
          <label>评论数</label>
          <input type="number" class="num-input" v-model.trim="storeClassFilters.reviewsCountMin" placeholder="min"
            @keydown.enter="searchStoreClassifications" />
          <span class="dash">—</span>
          <input type="number" class="num-input" v-model.trim="storeClassFilters.reviewsCountMax" placeholder="max"
            @keydown.enter="searchStoreClassifications" />
        </div>
        <div class="filter-group">
          <label>评分</label>
          <input type="number" class="num-input" step="0.1" min="0" max="5" v-model.trim="storeClassFilters.ratingMin"
            placeholder="min" @keydown.enter="searchStoreClassifications" />
          <span class="dash">—</span>
          <input type="number" class="num-input" step="0.1" min="0" max="5" v-model.trim="storeClassFilters.ratingMax"
            placeholder="max" @keydown.enter="searchStoreClassifications" />
        </div>
        <div class="filter-group">
          <label>开业时长(月)</label>
          <input type="number" class="num-input" v-model.trim="storeClassFilters.openedMonthsMin" placeholder="min"
            @keydown.enter="searchStoreClassifications" />
          <span class="dash">—</span>
          <input type="number" class="num-input" v-model.trim="storeClassFilters.openedMonthsMax" placeholder="max"
            @keydown.enter="searchStoreClassifications" />
        </div>
        <button class="btn btn-sm btn-ghost" @click="resetStoreClassFilters">重置筛选</button>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Seller ID</th>
              <th>Seller Name</th>
              <th>是否中国</th>
              <th>分类方式</th>
              <th>公司信息</th>
              <th>店铺链接</th>
              <th class="th-sortable" @click="toggleStoreClassSort('skuCount')"
                :title="storeClassFilters.sortBy === 'skuCount' ? '当前:按采集数降序,点击切回默认' : '点击按采集数降序'">
                采集 SKU 数
                <span class="sort-indicator">{{ storeClassFilters.sortBy === 'skuCount' ? '▼' : '' }}</span>
              </th>
              <th class="th-sortable" @click="toggleStoreClassSort('ordersCount')"
                :title="storeClassFilters.sortBy === 'ordersCount' ? '当前:按订单数降序,点击切回默认' : '点击按订单数降序'">
                订单数
                <span class="sort-indicator">{{ storeClassFilters.sortBy === 'ordersCount' ? '▼' : '' }}</span>
              </th>
              <th class="th-sortable" @click="toggleStoreClassSort('reviewsCount')"
                :title="storeClassFilters.sortBy === 'reviewsCount' ? '当前:按评论数降序,点击切回默认' : '点击按评论数降序'">
                评论数
                <span class="sort-indicator">{{ storeClassFilters.sortBy === 'reviewsCount' ? '▼' : '' }}</span>
              </th>
              <th class="th-sortable" @click="toggleStoreClassSort('rating')"
                :title="storeClassFilters.sortBy === 'rating' ? '当前:按评分降序,点击切回默认' : '点击按评分降序'">
                评分
                <span class="sort-indicator">{{ storeClassFilters.sortBy === 'rating' ? '▼' : '' }}</span>
              </th>
              <th class="th-sortable" @click="toggleStoreClassSort('openedMonths')"
                :title="storeClassFilters.sortBy === 'openedMonths' ? '当前:按开业时长降序,点击切回默认' : '点击按开业时长降序'">
                开业时长
                <span class="sort-indicator">{{ storeClassFilters.sortBy === 'openedMonths' ? '▼' : '' }}</span>
              </th>
              <th>最后访问</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!storeClassifications.length">
              <td colspan="13" class="empty">暂无店铺分类记录</td>
            </tr>
            <tr v-for="sc in storeClassifications" :key="sc._id">
              <td class="col-sku">{{ sc.sellerId || sc._id || '—' }}</td>
              <td>{{ sc.sellerName || '—' }}</td>
              <td>
                <span :class="storeClassBadge(sc.isMainlandChina)">
                  {{ sc.isMainlandChina === true ? '中国' : sc.isMainlandChina === false ? '非中国' : '待确认' }}
                </span>
              </td>
              <td>{{ sc.classifiedBy || '—' }}</td>
              <td>{{ sc.companyInfo?.companyName || '—' }}</td>
              <td>
                <a v-if="storeUrl(sc)" :href="storeUrl(sc)" target="_blank" rel="noopener noreferrer" class="table-link"
                  :title="storeUrl(sc)">
                  访问店铺
                </a>
                <template v-else>—</template>
              </td>
              <td>{{ sc.skuCount ?? 0 }}</td>
              <td>{{ sc.ordersCount ?? '—' }}</td>
              <td>{{ sc.reviewsCount ?? '—' }}</td>
              <td>{{ sc.rating != null ? sc.rating.toFixed(1) : '—' }}</td>
              <td>{{ sc.openedMonths != null ? sc.openedMonths + ' 月' : '—' }}</td>
              <td class="col-time">{{ fmtTime(sc.lastSeenAt) }}</td>
              <td class="row-actions">
                <button class="btn btn-sm btn-primary" :disabled="!sc.sellerId"
                  @click="updateStoreClass(sc.sellerId || sc._id, { isMainlandChina: true })">
                  标记中国
                </button>
                <button class="btn btn-sm btn-ghost" :disabled="!sc.sellerId"
                  @click="updateStoreClass(sc.sellerId || sc._id, { isMainlandChina: false })">
                  标记非中国
                </button>
                <button class="btn btn-sm btn-danger" :disabled="!sc.sellerId"
                  @click="deleteStoreClass(sc.sellerId || sc._id, sc.sellerName || sc.sellerSlug)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <AppPager :modelValue="storeClassPager.current" :total="storeClassPager.total"
        :pageSize="storeClassPager.pageSize" @update:modelValue="onStoreClassPageChange" />
    </div>

    <!-- 店铺 SKU 关联 tab -->
    <div v-if="state.type === 'store-sku'" class="store-sku-tab">
      <div class="filter-bar">
        <input class="filter-input" type="text" v-model.trim="storeSkuFilters.keyword"
          placeholder="SKU / 店铺名 / Slug / SellerId" @keydown.enter="searchStoreSkus" />
        <button class="btn btn-primary" @click="searchStoreSkus">查询</button>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Seller ID</th>
              <th>Seller Slug</th>
              <th>Seller Name</th>
              <th>采集状态</th>
              <th>首次发现</th>
              <th>最后发现</th>
              <th>最后采集</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!storeSkus.length">
              <td colspan="9" class="empty">暂无店铺 SKU 关联记录</td>
            </tr>
            <tr v-for="ss in storeSkus" :key="ss._id">
              <td class="col-sku">{{ ss.sku }}</td>
              <td>{{ ss.sellerId || '—' }}</td>
              <td>{{ ss.sellerSlug || '—' }}</td>
              <td>{{ ss.sellerName || '—' }}</td>
              <td>
                <span v-if="ss.lastCollectStatus" :class="collectStatusTag(ss.lastCollectStatus)">
                  {{ ss.lastCollectStatus }}
                </span>
                <span v-else class="muted">—</span>
              </td>
              <td class="col-time">{{ fmtTime(ss.firstSeenAt) }}</td>
              <td class="col-time">{{ fmtTime(ss.lastSeenAt) }}</td>
              <td class="col-time">{{ fmtTime(ss.lastCollectAt) }}</td>
              <td class="row-actions">
                <button class="btn btn-sm btn-danger" @click="deleteStoreSkuRecord(ss.sku)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <AppPager :modelValue="storeSkuPager.current" :total="storeSkuPager.total" :pageSize="storeSkuPager.pageSize"
        @update:modelValue="onStoreSkuPageChange" />
    </div>

    <!-- 详情弹窗 -->
    <AppModal :open="detailOpen" :title="detailTitle" size="lg" @update:open="detailOpen = $event">
      <p v-if="detailLoading" class="muted">加载中…</p>
      <div v-else-if="detailData" class="cache-detail">
        <div class="cache-detail-meta">
          <div class="meta-header">{{ TYPE_LABELS[detailType] }}</div>
          <div v-for="(m, i) in detailMetaItems()" :key="i" class="meta-item">
            <b>{{ m.label }}:</b> {{ m.value }}
          </div>
        </div>
        <!-- 所有 5 类缓存统一展示 JsonTree(dom/attribute/richMedia/marketStats/followSell) -->
        <div class="cache-detail-data">
          <div v-for="(node, i) in detailJsonNodes()" :key="i" class="json-block">
            <h3>{{ node.key }}</h3>
            <JsonTree :data="node.data" :default-expand-level="2" :root-key="node.key" />
          </div>
          <p v-if="!detailJsonNodes().length" class="muted">无数据</p>
        </div>
      </div>
      <p v-else class="muted">未找到缓存记录</p>
    </AppModal>

    <!-- OPI 预览弹窗 -->
    <AppModal :open="opiOpen" :title="opiTitle" size="lg" class="opi-modal" @update:open="opiOpen = $event">
      <p v-if="opiLoading" class="muted">加载中…</p>
      <div v-else-if="opiError" class="opi-error">
        <p>⚠️ {{ opiError }}</p>
        <div v-if="opiSources" class="opi-sources">
          <span>缓存来源:</span>
          <span :class="opiSourceTag(opiSources.search)">search</span>
          <span :class="opiSourceTag(opiSources.bundle)">bundle</span>
          <span :class="opiSourceTag(opiSources.card)">商品卡</span>
          <span :class="opiSourceTag(opiSources.richMedia)">richMedia</span>
          <span :class="opiSourceTag(opiSources.detail)">详情页</span>
        </div>
      </div>
      <div v-else-if="opiData || opiRaw" class="opi-preview">
        <div class="opi-sources-bar">
          <span class="opi-sources-label">缓存来源:</span>
          <span :class="opiSourceTag(opiSources?.search)"
            :title="opiSourceLabel(opiSources?.search, 'Seller Portal /api/v1/search')">
            search {{ opiSourceLabel(opiSources?.search, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.bundle)"
            :title="opiSourceLabel(opiSources?.bundle, 'create-bundle-by-variant-id')">
            bundle {{ opiSourceLabel(opiSources?.bundle, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.card)" :title="opiSourceLabel(opiSources?.card, '商品卡 DOM')">
            商品卡 {{ opiSourceLabel(opiSources?.card, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.richMedia)"
            :title="opiSourceLabel(opiSources?.richMedia, '富媒体缓存(合并 entrypoint+composer)')">
            richMedia {{ opiSourceLabel(opiSources?.richMedia, '✓') }}
          </span>
          <span :class="opiSourceTag(opiSources?.detail)" :title="opiSourceLabel(opiSources?.detail, '详情页 DOM')">
            详情页 {{ opiSourceLabel(opiSources?.detail, '✓') }}
          </span>
        </div>
        <div class="opi-tabs">
          <button type="button" :class="['opi-tab', opiTab === 'json' && 'active']" @click="opiTab = 'json'">
            OPI v3 JSON
          </button>
          <button type="button" :class="['opi-tab', opiTab === 'compare' && 'active']" @click="opiTab = 'compare'">
            字段对照
          </button>
        </div>
        <template v-if="opiTab === 'json'">
          <div class="opi-field-summary">
            <div><b>name:</b> {{ opiData?.name || '—' }}</div>
            <div><b>offer_id:</b> {{ opiData?.offer_id || '—' }}</div>
            <div><b>price:</b> {{ opiData?.price || '—' }}</div>
            <div><b>images:</b> {{ opiData?.images?.length || 0 }} 张</div>
            <div><b>attributes:</b> {{ opiData?.attributes?.length || 0 }} 个</div>
            <div><b>complex_attributes:</b> {{ opiData?.complex_attributes?.length || 0 }} 组</div>
            <div v-if="opiData?.weight"><b>weight:</b> {{ opiData.weight }} {{ opiData.weight_unit }}</div>
            <div v-if="opiData?.type_id"><b>type_id:</b> {{ opiData.type_id }}</div>
            <div v-if="opiData?.description_category_id">
              <b>description_category_id:</b> {{ opiData.description_category_id }}
            </div>
            <div v-if="!opiData" class="fc-note">缓存数据不完整(partial),无法合成 OPI — 请查看"字段对照"标签页确认缺失来源</div>
          </div>
          <div v-if="opiData" class="opi-json-section">
            <h3>OPI v3 JSON</h3>
            <JsonTree :data="opiData" :default-expand-level="2" root-key="item" />
          </div>
        </template>
        <div v-else class="field-compare">
          <div class="fc-legend">
            <span class="fc-key"><span class="fc-dot fc-dot-ok"></span>✓ 选中来源</span>
            <span class="fc-key"><span class="fc-dot fc-dot-warn"></span>来源值不一致(全等比较)</span>
            <span class="fc-key"><span class="fc-dot fc-dot-brand"></span>强制注入 / 生成</span>
            <span class="fc-key"><span class="fc-dot fc-dot-mute"></span>缺失 / 被过滤</span>
          </div>
          <table class="fc-table">
            <thead>
              <tr>
                <th class="fc-th-field">字段</th>
                <th>数据来源(按优先级)</th>
                <th class="fc-th-final">最终值(OPI)</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(row, idx) in fieldCompareRows" :key="idx">
                <tr v-if="row.groupHeader" class="fc-group">
                  <td colspan="3">{{ row.groupHeader }}</td>
                </tr>
                <tr v-else :class="{ 'fc-warn': row.state === 'warn', 'fc-mute': row.state === 'mute' }">
                  <td class="fc-field">
                    {{ row.label }}
                    <small>{{ row.sub }}</small>
                  </td>
                  <td class="fc-src">
                    <div v-for="(s, i) in row.sources" :key="i" class="fc-src-row">
                      <span :class="s.selected ? 'fc-check' : 'fc-nocheck'">{{ s.selected ? '✓' : '—' }}</span>
                      <span :class="['fc-tag', s.selected && 'sel', s.force && 'strong']">{{ s.tag }}</span>
                      <span :class="['fc-val', s.state]">{{ s.display || '—' }}</span>
                    </div>
                  </td>
                  <td class="fc-final">
                    {{ row.final || '—' }}
                    <small v-if="row.note" class="fc-note">{{ row.note }}</small>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
      <p v-else class="muted">无数据</p>
    </AppModal>
  </div>
</template>

<style scoped>
.cache-type-tabs {
  display: flex;
  gap: 0;
  padding: 0 24px 12px;
}

.cache-type-tab {
  padding: 8px 18px;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--muted);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}

.cache-type-tab:first-child {
  border-radius: 6px 0 0 6px;
}

.cache-type-tab:last-child {
  border-radius: 0 6px 6px 0;
  border-left: none;
}

.cache-type-tab.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}

.col-sku {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 12px;
}

.sku-link {
  color: var(--primary);
  text-decoration: none;
}

.sku-link:hover {
  text-decoration: underline;
}

.table-link {
  color: var(--primary);
  text-decoration: none;
}

.table-link:hover {
  text-decoration: underline;
}

.th-sortable {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.th-sortable:hover {
  color: var(--primary);
}

.sort-indicator {
  font-size: 11px;
  color: var(--primary);
  margin-left: 2px;
}

/* 全览表格 */
.overview-table th,
.overview-table td {
  text-align: center;
}

.overview-table .col-sku {
  text-align: left;
}

.overview-table .col-check {
  width: 36px;
  text-align: center;
}

.overview-table .col-check input[type='checkbox'] {
  margin: 0;
  cursor: pointer;
}

.tag-mute {
  background: #f3f4f6;
  color: #9ca3af;
}

.overview-table .row-actions {
  text-align: center;
}

.cell-clickable {
  cursor: pointer;
  transition: background 0.15s;
}

.cell-clickable:hover {
  background: #f9fafb;
}

/* 详情弹窗 */
.cache-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cache-detail-meta {
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
}

.cache-detail-meta .meta-header {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text);
}

.cache-detail-meta .meta-item {
  margin: 2px 0;
}

.cache-detail-meta b {
  color: var(--muted);
  font-weight: 500;
}

.cache-detail-data .json-block {
  margin-bottom: 16px;
}

.cache-detail-data .json-block h3 {
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.tag-err {
  background: #fef2f2;
  color: #b91c1c;
}

.tag-ok {
  background: #ecfdf5;
  color: #047857;
}

/* OPI 预览弹窗 */
.opi-preview {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 弹窗加宽:自适应 + 1280px 上限(字段对照的 URL/长描述需要更大展示空间) */
.opi-modal :deep(.modal-card) {
  width: min(1280px, calc(100vw - 64px));
}

/* OPI 弹窗标签页(OPI v3 JSON / 字段对照) */
.opi-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
}

.opi-tab {
  padding: 8px 16px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  position: relative;
  transition: all 0.15s;
}

.opi-tab.active {
  color: var(--primary);
  background: #f0f4ff;
  border-color: var(--border);
}

.opi-tab.active::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--primary);
  border-radius: 999px;
}

/* ── 字段对照(跟卖上架数据来源逐字段展示) ── */
.field-compare {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fc-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
}

.fc-key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.fc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.fc-dot-ok { background: #1dc981; }
.fc-dot-warn { background: #efaa17; }
.fc-dot-brand { background: var(--primary); }
.fc-dot-mute { background: #a1a1aa; }

.fc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.fc-table th {
  text-align: left;
  padding: 8px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-weight: 500;
  white-space: nowrap;
}

.fc-table td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.fc-th-field { width: min(140px, 14vw); }
.fc-th-final { width: min(280px, 24vw); }

.fc-field {
  font-weight: 500;
  white-space: nowrap;
}

.fc-field small {
  display: block;
  font-weight: 400;
  font-size: 11px;
  color: var(--muted);
}

.fc-group td {
  background: #f3f4f6;
  color: var(--muted);
  font-weight: 500;
  padding: 4px 8px;
}

.fc-src {
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 来源列吃满剩余宽度,长 URL/描述尽量单行展示 */
  width: 100%;
  min-width: 0;
}

.fc-src-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.fc-check {
  color: #1dc981;
  font-weight: 600;
  flex-shrink: 0;
}

.fc-nocheck {
  color: var(--muted);
  opacity: 0.4;
  flex-shrink: 0;
}

.fc-tag {
  flex-shrink: 0;
  white-space: nowrap;
  padding: 0 8px;
  border-radius: 4px;
  background: #f3f4f6;
  color: var(--muted);
  font-size: 12px;
  line-height: 18px;
}

.fc-tag.sel {
  background: #f0f4ff;
  color: #1a1759;
}

.fc-tag.strong {
  background: #f0f4ff;
  color: #1a1759;
  border: 1px solid var(--primary);
}

.fc-val {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 11px;
  word-break: break-all;
  min-width: 0;
}

.fc-val.diff {
  color: #b45309;
  font-weight: 500;
}

.fc-val.empty {
  color: var(--muted);
}

.fc-val.strike {
  color: var(--muted);
  text-decoration: line-through;
}

.fc-final {
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  font-size: 11px;
  word-break: break-all;
}

.fc-note {
  display: block;
  font-size: 11px;
  color: #b45309;
  font-weight: 400;
}

.fc-warn td {
  background: #fffbeb;
}

.fc-mute td {
  opacity: 0.6;
}

.opi-sources-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 10px 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 12px;
}

.opi-sources-label {
  color: var(--muted);
  margin-right: 4px;
}

.opi-sources-bar>span:not(.opi-sources-label) {
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
}

.opi-field-summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
}

.opi-field-summary b {
  color: var(--muted);
  font-weight: 500;
}

.opi-json-section h3 {
  margin-bottom: 8px;
}

.opi-error {
  padding: 12px;
  background: #fef2f2;
  border-radius: 6px;
  color: #b91c1c;
}

.opi-error .opi-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
}

.opi-error .opi-sources>span {
  padding: 2px 8px;
  border-radius: 4px;
}

/* ── overview stale(marketStats 超 24h)── */
.tag-warn {
  background: #fff7ed;
  color: #c2410c;
}

/* ── 店铺数据 tab ─────────────────────────────────────── */
.badge-mainland-china {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background: #dbeafe;
  color: #1d4ed8;
}

.badge-non-mainland-china {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background: #fef3c7;
  color: #b45309;
}

.badge-pending {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  background: #f3f4f6;
  color: #6b7280;
}

/* ── 店铺数据:高级筛选 ─────────────────────────────────── */
.filter-advanced {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding: 10px 0 12px;
  margin-bottom: 8px;
  border-bottom: 1px dashed var(--border);
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}

.filter-group label {
  color: var(--muted);
  white-space: nowrap;
  margin-right: 2px;
}

.filter-group .num-input {
  width: 76px;
  padding: 4px 6px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: #fff;
}

.filter-group .num-input:focus {
  outline: none;
  border-color: var(--primary);
}

.filter-group .dash {
  color: var(--muted);
  font-size: 12px;
}
</style>
