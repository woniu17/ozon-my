<script setup>
// 商品详情对比页:对比「已上架在线商品(Ozon 后台同步)」↔「源商品(采集画像)」
// 与采集箱 Preview.vue(源商品→拟上架)不同,本页是反向对比,用于发现上架后实际数据与源采集的偏差。
// 5 项对比卡:①图片 ②字段概览 ③描述 ④富内容(#11254) ⑤所有属性
// 导航:前端拉 idsOnly 全量 SKU 列表 + sessionStorage 缓存,支持按当前筛选跨页上一个/下一个
import { reactive, ref, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getProducts, getProductDetail, getProductAttributes } from '../api/products.js';
import { getSkuProfile } from '../api/collect-box-v2.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import ImageLightbox from '../components/ImageLightbox.vue';
import JsonTree from '../components/JsonTree.vue';

const route = useRoute();
const router = useRouter();
const storesStore = useStoresStore();
const { show } = useToast();

const sku = computed(() => String(route.params.sku || ''));

// 富内容属性 ID(OPI 字典 11254 = 富内容)
const RICH_ATTR_ID = 11254;
// 项目硬约束:这些属性 ID 在上架链路被强制跳过(避免重复字段),对比时也过滤,避免虚假差异
const BANNED_ATTR_IDS = new Set([4194, 4195, 4497, 9454, 9455, 9456, 23536]);

// ── 状态 ───────────────────────────────────────────────────
const state = reactive({
  loading: true,
  error: '', // 已上架商品加载失败(主错误,阻断页面)
  // 已上架商品(product_data_cache,OPI /v3)
  listed: null, // { sku, storeId, fetchedAt, data }
  listedStoreId: '',
  // 已上架属性+描述(/products/:sku/attributes,OPI /v4 + /v1)
  attrRes: null, // { attributes, description, fetchedAt, source }
  attrError: '', // 属性/描述加载失败(非阻断,降级显示)
  // 源商品画像(采集缓存)
  profile: null, // { sources, original, item, portalItem, opiItem, attrDict, partial, error? }
  profileError: '', // 源商品画像无数据或加载失败(非阻断,源侧显示提示)
  // 导航
  navList: [], // 当前筛选下的全量 sku 列表
  navLoading: false,
  // 源 SKU(从 offer_id 解析,如 "4339734364-0811-qx" → "4339734364")
  sourceSku: '',
});

// Lightbox
const lb = reactive({ open: false, url: '', list: [], title: '' });

// ── 导航筛选条件(从 URL query 的 f* 前缀还原列表筛选) ─────
const currentFilters = computed(() => {
  const q = route.query || {};
  return {
    storeId: q.fStoreId || q.storeId || '',
    keyword: q.fKeyword || '',
    productStatus: q.fProductStatus || '',
    hasStock: q.fHasStock || '',
    imageIssue: q.fImageIssue || '',
    descriptionQuality: q.fDescriptionQuality || '',
  };
});

// offer_id 格式约定:{源SKU}-{MMDD}-qx(与 listing-builder.js:416 / collect-queue.js:591 一致)
// 源 SKU 是纯数字,不含 '-',split('-')[0] 安全
function extractSourceSku(offerId) {
  if (!offerId || typeof offerId !== 'string') return '';
  if (!offerId.includes('-')) return '';
  return offerId.split('-')[0] || '';
}

// ── 数据加载:两阶段 ──────────────────────────────────────
// 阶段1:并行拉 已上架商品(detail) + 属性/描述(attributes),都基于路由 sku(FBS 变体 SKU)
// 阶段2:从 detail.data.offer_id 解析源 SKU,再用源 SKU 调 getSkuProfile(采集画像)
async function loadAll() {
  state.loading = true;
  state.error = '';
  state.attrError = '';
  state.profileError = '';
  state.listed = null;
  state.attrRes = null;
  state.profile = null;
  state.sourceSku = '';
  const storeId = route.query.storeId || '';

  // 阶段1:detail + attributes 并行(都基于 listedSku)
  const [detailR, attrR] = await Promise.allSettled([
    getProductDetail(sku.value),
    // 始终调用:后端从 product_data_cache.store_id 兜底取 storeId
    getProductAttributes(sku.value, storeId),
  ]);

  // 已上架商品(主):失败则阻断,不再拉 profile
  if (detailR.status !== 'fulfilled') {
    state.error = detailR.reason?.message || '商品加载失败';
    state.loading = false;
    return;
  }
  state.listed = detailR.value || null;
  state.listedStoreId = detailR.value?.storeId || storeId || '';

  // 属性+描述:失败降级
  if (attrR.status === 'fulfilled') {
    state.attrRes = attrR.value || null;
  } else {
    state.attrError = attrR.reason?.message || '属性/描述加载失败';
  }

  // 阶段2:从 offer_id 解析源 SKU,拉采集画像
  const offerId = listedData.value.offer_id || '';
  state.sourceSku = extractSourceSku(offerId);
  if (state.sourceSku) {
    try {
      const profile = await getSkuProfile(state.sourceSku, state.listedStoreId || undefined);
      state.profile = profile || null;
      if (profile?.error) state.profileError = profile.error;
    } catch (err) {
      state.profileError = err.message || '源商品画像加载失败';
    }
  } else {
    state.profileError = offerId
      ? `OfferID "${offerId}" 不含 "-",无法解析源 SKU`
      : '已上架商品无 OfferID,无法关联源商品';
  }
  state.loading = false;
}

// ── 导航列表:拉取当前筛选下全量 sku(idsOnly),sessionStorage 缓存 ─
async function loadNavList() {
  if (state.navLoading) return;
  const filters = currentFilters.value;
  const key = 'pdc:nav:' + JSON.stringify(filters);
  // 先读缓存
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) {
      state.navList = JSON.parse(cached);
      return;
    }
  } catch (_) {
    /* 缓存解析失败,重新拉取 */
  }
  state.navLoading = true;
  try {
    const res = await getProducts({ ...filters, idsOnly: '1' });
    const skus = (res?.items || []).map((it) => it.sku).filter(Boolean);
    state.navList = skus;
    try {
      sessionStorage.setItem(key, JSON.stringify(skus));
    } catch (_) {
      /* sessionStorage 满或禁用,忽略 */
    }
  } catch (_) {
    // 导航加载失败不阻断主流程,仅无法上下导航
    state.navList = [];
  } finally {
    state.navLoading = false;
  }
}

const navIndex = computed(() => state.navList.indexOf(sku.value));
const navTotal = computed(() => state.navList.length);
const canPrev = computed(() => navIndex.value > 0);
const canNext = computed(() => navIndex.value >= 0 && navIndex.value < navTotal.value - 1);
const navPosLabel = computed(() => {
  if (state.navLoading) return '加载列表…';
  if (!navTotal.value) return '—';
  if (navIndex.value < 0) return `${sku.value} 不在当前筛选列表`;
  return `第 ${navIndex.value + 1} / ${navTotal.value}`;
});

function goPrev() {
  if (!canPrev.value) return;
  const prevSku = state.navList[navIndex.value - 1];
  router.replace({ name: 'product-detail', params: { sku: prevSku }, query: { ...route.query } });
}
function goNext() {
  if (!canNext.value) return;
  const nextSku = state.navList[navIndex.value + 1];
  router.replace({ name: 'product-detail', params: { sku: nextSku }, query: { ...route.query } });
}
function goBack() {
  // 返回商品列表,带筛选条件
  const f = currentFilters.value;
  const query = {};
  if (f.storeId) query.storeId = f.storeId;
  if (f.keyword) query.keyword = f.keyword;
  if (f.productStatus) query.productStatus = f.productStatus;
  if (f.hasStock) query.hasStock = f.hasStock;
  if (f.imageIssue) query.imageIssue = f.imageIssue;
  if (f.descriptionQuality) query.descriptionQuality = f.descriptionQuality;
  router.push({ name: 'products', query });
}

// ── 已上架商品字段提取 ────────────────────────────────────
// data: OPI /v3/product/info/list 返回的单个 item(字符串数组 images,标量字段)
const listedData = computed(() => state.listed?.data || {});
// 已上架属性数组:/v4 响应 result[0].attributes,每项 {attribute_id, complex_id, values:[{value}]}
const listedAttrItems = computed(() => {
  const r = state.attrRes?.attributes?.result;
  const arr = Array.isArray(r) ? r[0]?.attributes : r?.attributes;
  return Array.isArray(arr) ? arr : [];
});
// 已上架描述文本:/v1 响应 result.description(防御兼容顶层 description)
const listedDesc = computed(() => {
  const d = state.attrRes?.description;
  return d?.result?.description ?? d?.description ?? '';
});
const listedAttrSource = computed(() => state.attrRes?.source || '');

const listed = computed(() => {
  const d = listedData.value;
  const imgs = Array.isArray(d.images) ? d.images : [];
  const primary = d.primary_image || d.image || (imgs.length ? imgs[0] : '');
  return {
    sku: d.sku ?? state.listed?.sku ?? sku.value,
    offerId: d.offer_id,
    productId: d.product_id || d.id,
    name: d.name,
    price: d.price,
    oldPrice: d.old_price,
    minPrice: d.min_price,
    currency: d.currency_code || d.currency,
    vat: d.vat,
    primaryImage: primary,
    images: imgs,
    weight: d.weight,
    depth: d.depth,
    width: d.width,
    height: d.height,
    weightUnit: d.weight_unit,
    dimensionUnit: d.dimension_unit,
    descCategoryId: d.description_category_id,
    typeId: d.type_id,
    barcode: d.barcode,
    videoUrl: d.video_url,
    fetchedAt: state.listed?.fetchedAt,
  };
});

// ── 源商品字段提取(采集画像) ───────────────────────────────
const source = computed(() => {
  const o = state.profile?.original || {};
  const p = state.profile?.portalItem || {};
  const imgs = Array.isArray(o.images) ? o.images : [];
  const primary = o.primaryImage || (imgs.length ? imgs[0] : '');
  return {
    sku: o.sku ?? sku.value,
    offerId: o.offerId,
    name: o.name,
    price: o.price,
    oldPrice: o.oldPrice,
    primaryImage: primary,
    images: imgs,
    description: o.description || '',
    weight: o.weight,
    depth: o.dimensions?.depth,
    width: o.dimensions?.width,
    height: o.dimensions?.height,
    videoUrl: o.videoUrl,
    barcode: o.barcode,
    descCategoryId: p.descriptionCategoryId,
    typeId: p.typeId,
    attributes: Array.isArray(o.attributes) ? o.attributes : [],
  };
});
const attrDict = computed(() => state.profile?.attrDict || {});
const sourceSources = computed(() => state.profile?.sources || {});

// ── 辅助:图片 URL / 属性取值 / 格式化 ─────────────────────
function imgUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return u;
}
// 属性 ID 统一:已上架用 attribute_id,源用 id,取其一
function attrIdOf(a) {
  return Number(a.attribute_id || a.id || 0);
}
// 取某属性 ID 的展示值(逗号连接多 value)
function getAttrValue(attrs, id) {
  const a = (attrs || []).find((x) => attrIdOf(x) === Number(id));
  if (!a) return '';
  const vals = Array.isArray(a.values) ? a.values : [];
  return vals
    .map((v) => v?.value ?? '')
    .filter((v) => v !== '')
    .join(', ');
}
function fmtPrice(v, currency) {
  if (v == null || v === '') return '';
  const n = Number(v);
  const s = Number.isFinite(n) ? n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : String(v);
  return currency ? s + ' ' + currency : s;
}
function fmtWeight(v, unit) {
  if (v == null || v === '') return '';
  return v + (unit ? ' ' + unit : ' kg');
}
function fmtDims(d, w, h, unit) {
  const parts = [d, w, h].filter((x) => x != null && x !== '');
  if (!parts.length) return '';
  return parts.join('×') + (unit ? ' ' + unit : '');
}
function or(v, fallback = '—') {
  return v == null || v === '' ? fallback : v;
}

// ── ① 图片对比 ────────────────────────────────────────────
// 主图置顶,其余按原顺序;去重主图
function buildImageList(primary, images) {
  const all = [];
  if (primary) all.push(primary);
  for (const img of images) {
    if (img && img !== primary) all.push(img);
  }
  return all;
}
const listedImages = computed(() => buildImageList(listed.value.primaryImage, listed.value.images));
const sourceImages = computed(() => buildImageList(source.value.primaryImage, source.value.images));
const imageDiff = computed(() => ({
  listedCount: listedImages.value.length,
  sourceCount: sourceImages.value.length,
  countChanged: listedImages.value.length !== sourceImages.value.length,
  primaryChanged: listed.value.primaryImage !== source.value.primaryImage,
}));

// ── ② 字段概览对比 ────────────────────────────────────────
const fieldRows = computed(() => {
  const l = listed.value;
  const s = source.value;
  const rows = [
    { key: 'SKU', listed: or(l.sku), source: or(s.sku) },
    { key: 'OfferID', listed: or(l.offerId), source: or(s.offerId) },
    { key: 'ProductID', listed: or(l.productId), source: or(s.productId) },
    { key: '商品名称', listed: or(l.name), source: or(s.name) },
    { key: '价格', listed: or(fmtPrice(l.price, l.currency)), source: or(fmtPrice(s.price, l.currency)) },
    { key: '划线价', listed: or(fmtPrice(l.oldPrice, l.currency)), source: or(fmtPrice(s.oldPrice, l.currency)) },
    { key: '最低价', listed: or(fmtPrice(l.minPrice, l.currency)), source: '—' },
    { key: '重量', listed: or(fmtWeight(l.weight, l.weightUnit)), source: or(fmtWeight(s.weight)) },
    { key: '尺寸 D×W×H', listed: or(fmtDims(l.depth, l.width, l.height, l.dimensionUnit)), source: or(fmtDims(s.depth, s.width, s.height)) },
    { key: '类目ID', listed: or(l.descCategoryId), source: or(s.descCategoryId) },
    { key: '类型ID', listed: or(l.typeId), source: or(s.typeId) },
    { key: '条码', listed: or(l.barcode), source: or(s.barcode) },
    { key: '视频', listed: l.videoUrl ? '有' : '无', source: s.videoUrl ? '有' : '无' },
    { key: '品牌 #85', listed: or(getAttrValue(listedAttrItems.value, 85)), source: or(getAttrValue(s.attributes, 85)) },
  ];
  return rows.map((r) => ({
    ...r,
    changed: String(r.listed) !== String(r.source) && !(r.listed === '—' && r.source === '—'),
  }));
});
const fieldDiffCount = computed(() => fieldRows.value.filter((r) => r.changed).length);

// ── ③ 描述对比 ────────────────────────────────────────────
// 行集合 diff:逐行判定是否仅本侧独有(不考虑顺序,简单可靠);空行不标记
const descDiff = computed(() => {
  const lText = listedDesc.value || '';
  const sText = source.value.description || '';
  const lLines = lText.split('\n');
  const sLines = sText.split('\n');
  const sSet = new Set(sLines.map((t) => t.trim()).filter(Boolean));
  const lSet = new Set(lLines.map((t) => t.trim()).filter(Boolean));
  return {
    changed: lText.trim() !== sText.trim(),
    left: lLines.map((t) => ({ text: t, only: t.trim() !== '' && !sSet.has(t.trim()) })),
    right: sLines.map((t) => ({ text: t, only: t.trim() !== '' && !lSet.has(t.trim()) })),
    leftLen: lText.length,
    rightLen: sText.length,
    leftEmpty: !lText.trim(),
    rightEmpty: !sText.trim(),
  };
});

// ── ④ 富内容对比(attr 11254) ──────────────────────────────
const listedRichRaw = computed(() => getAttrValue(listedAttrItems.value, RICH_ATTR_ID));
const sourceRichRaw = computed(() => getAttrValue(source.value.attributes, RICH_ATTR_ID));
function tryParseJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}
const listedRichJson = computed(() => tryParseJson(listedRichRaw.value));
const sourceRichJson = computed(() => tryParseJson(sourceRichRaw.value));
const richDiff = computed(() => {
  const hasL = !!listedRichRaw.value;
  const hasS = !!sourceRichRaw.value;
  let label = '一致';
  let cls = 'tag-eq';
  if (!hasL && !hasS) {
    label = '两侧均无';
    cls = 'tag-neutral';
  } else if (hasL && !hasS) {
    label = '仅已上架有';
    cls = 'tag-add';
  } else if (!hasL && hasS) {
    label = '仅源商品有';
    cls = 'tag-del';
  } else if (listedRichRaw.value !== sourceRichRaw.value) {
    label = '内容有差异';
    cls = 'tag-changed';
  }
  return { hasL, hasS, label, cls };
});

// ── ⑤ 所有属性对比 ────────────────────────────────────────
// 以 attrDict(字典)为基准,合并两方属性 ID,过滤 BANNED
const attrDiff = computed(() => {
  const dict = attrDict.value;
  const lAttrs = listedAttrItems.value;
  const sAttrs = source.value.attributes;
  const ids = new Set();
  Object.keys(dict).forEach((id) => ids.add(Number(id)));
  lAttrs.forEach((a) => ids.add(attrIdOf(a)));
  sAttrs.forEach((a) => ids.add(attrIdOf(a)));
  const rows = [...ids]
    .filter((id) => !BANNED_ATTR_IDS.has(id))
    .sort((a, b) => a - b)
    .map((id) => {
      const lVal = getAttrValue(lAttrs, id);
      const sVal = getAttrValue(sAttrs, id);
      const d = dict[id] || {};
      return {
        id,
        name: d.name || '',
        listed: lVal,
        source: sVal,
        added: !!lVal && !sVal,
        removed: !lVal && !!sVal,
        changed: !!lVal && !!sVal && lVal !== sVal,
      };
    });
  return rows;
});
const attrStats = computed(() => {
  let added = 0,
    removed = 0,
    changed = 0;
  for (const a of attrDiff.value) {
    if (a.added) added++;
    else if (a.removed) removed++;
    else if (a.changed) changed++;
  }
  return { added, removed, changed, total: attrDiff.value.length };
});
function attrRowClass(a) {
  if (a.added) return 'pdc-row-added';
  if (a.removed) return 'pdc-row-removed';
  if (a.changed) return 'pdc-row-changed';
  return '';
}

// ── Lightbox ──────────────────────────────────────────────
function openLb(url, list, side) {
  lb.url = imgUrl(url) || '';
  lb.list = (list || []).map(imgUrl).filter(Boolean);
  lb.title = `${side || ''} · ${sku.value}`;
  lb.open = true;
}

// ── 数据来源标签 ─────────────────────────────────────────
const storeNameLabel = computed(() => {
  const s = storesStore.list.find((x) => x.id === state.listedStoreId);
  return s?.name || state.listedStoreId || '';
});
const listedSourceLabel = computed(() => {
  if (state.attrError) return '属性加载失败';
  const src = listedAttrSource.value;
  if (src === 'mem') return 'OPI 内存缓存';
  if (src === 'db') return 'OPI 数据库缓存';
  if (src === 'opi') return 'OPI 实时';
  if (src === 'db-stale') return 'OPI 过期缓存(降级)';
  return src || 'OPI';
});
const sourceSourceLabel = computed(() => {
  if (state.profileError) return '画像不可用';
  const so = sourceSources.value;
  const hits = [];
  if (so.dom) hits.push('DOM');
  if (so.attribute) hits.push('属性');
  if (so.richMedia) hits.push('富媒体');
  if (so.marketStats) hits.push('市场');
  if (so.followSell) hits.push('跟卖');
  return hits.length ? hits.join('+') + ' 缓存' : '采集缓存';
});

// ── 生命周期 ───────────────────────────────────────────────
watch(
  () => sku.value,
  () => {
    if (sku.value) {
      loadAll();
      // 滚动到顶部,切换商品时回到页面起始
      document.querySelector('.pdc-body')?.scrollTo?.({ top: 0 });
    }
  }
);

onMounted(() => {
  loadAll();
  loadNavList();
});
</script>

<template>
  <div class="pdc-page">
    <!-- 顶栏 -->
    <div class="pdc-toolbar">
      <button class="pdc-btn-back" @click="goBack">← 返回列表</button>
      <div class="pdc-title">
        商品详情对比
        <span class="pdc-sku">{{ sku }}</span>
      </div>
      <div class="pdc-nav">
        <button class="pdc-nav-btn" :disabled="!canPrev" @click="goPrev">↑ 上一个</button>
        <span class="pdc-pos" :title="navPosLabel">{{ navPosLabel }}</span>
        <button class="pdc-nav-btn" :disabled="!canNext" @click="goNext">下一个 ↓</button>
      </div>
    </div>

    <!-- 数据来源条 -->
    <div v-if="!state.loading && !state.error" class="pdc-src-bar">
      <span class="pdc-src-chip">
        已上架 · <b>{{ listedSourceLabel }}</b>
        <template v-if="listed.fetchedAt"> · {{ listed.fetchedAt.slice(0, 16).replace('T', ' ') }}</template>
      </span>
      <span class="pdc-src-chip" :class="{ 'pdc-src-warn': state.profileError }">
        源商品 · <b>{{ sourceSourceLabel }}</b>
      </span>
      <span v-if="storeNameLabel" class="pdc-src-chip">店铺 · <b>{{ storeNameLabel }}</b></span>
      <span v-if="state.attrError" class="pdc-src-chip pdc-src-warn" :title="state.attrError">属性:{{ state.attrError }}</span>
    </div>

    <!-- loading -->
    <div v-if="state.loading" class="pdc-state">加载中…</div>
    <!-- error -->
    <div v-else-if="state.error" class="pdc-state pdc-state-error">{{ state.error }}</div>

    <div v-else class="pdc-body">
      <!-- ① 图片对比 -->
      <section class="pdc-card">
        <div class="pdc-card-head">
          <span class="pdc-card-no">1</span>
          <span class="pdc-card-title">商品图片对比</span>
          <span v-if="imageDiff.countChanged" class="pdc-diff-tag tag-changed">数量 {{ imageDiff.listedCount }}→{{ imageDiff.sourceCount }}</span>
          <span v-else-if="imageDiff.primaryChanged" class="pdc-diff-tag tag-changed">主图不同</span>
          <span v-else class="pdc-diff-tag tag-eq">主图一致 · {{ imageDiff.listedCount }}张</span>
        </div>
        <div class="pdc-cmp-2col">
          <div class="pdc-cmp-col">
            <div class="pdc-col-label">已上架 · Ozon同步 <span class="pdc-badge">{{ imageDiff.listedCount }}张</span></div>
            <div class="pdc-img-grid">
              <div
                v-for="(img, i) in listedImages"
                :key="'l' + i"
                class="pdc-img-cell"
                :class="{ 'pdc-img-primary': img === listed.primaryImage }"
                @click="openLb(img, listedImages, '已上架')"
              >
                <span class="pdc-img-idx">#{{ i + 1 }}</span>
                <span v-if="img === listed.primaryImage" class="pdc-img-main-tag">主图</span>
                <img :src="imgUrl(img)" loading="lazy" alt="" @error="$event.target.style.opacity = 0.2" />
              </div>
              <div v-if="!listedImages.length" class="pdc-empty">无图片</div>
            </div>
          </div>
          <div class="pdc-cmp-col">
            <div class="pdc-col-label">源商品 · 采集画像 <span class="pdc-badge">{{ imageDiff.sourceCount }}张</span></div>
            <div class="pdc-img-grid">
              <div
                v-for="(img, i) in sourceImages"
                :key="'s' + i"
                class="pdc-img-cell"
                :class="{ 'pdc-img-primary': img === source.primaryImage }"
                @click="openLb(img, sourceImages, '源商品')"
              >
                <span class="pdc-img-idx">#{{ i + 1 }}</span>
                <span v-if="img === source.primaryImage" class="pdc-img-main-tag">主图</span>
                <img :src="imgUrl(img)" loading="lazy" alt="" @error="$event.target.style.opacity = 0.2" />
              </div>
              <div v-if="!sourceImages.length" class="pdc-empty">无图片</div>
            </div>
          </div>
        </div>
      </section>

      <!-- ② 字段概览对比 -->
      <section class="pdc-card">
        <div class="pdc-card-head">
          <span class="pdc-card-no">2</span>
          <span class="pdc-card-title">字段概览对比</span>
          <span class="pdc-diff-count">{{ fieldDiffCount }} 项差异</span>
        </div>
        <table class="pdc-cmp-table">
          <thead>
            <tr>
              <th class="pdc-th-key">字段</th>
              <th>已上架</th>
              <th>源商品</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in fieldRows" :key="r.key" :class="{ 'pdc-row-changed': r.changed }">
              <td class="pdc-key">{{ r.key }}</td>
              <td :class="{ 'pdc-cell-changed': r.changed }">{{ r.listed }}</td>
              <td :class="{ 'pdc-cell-changed': r.changed }">{{ r.source }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- ③ 商品描述对比 -->
      <section class="pdc-card">
        <div class="pdc-card-head">
          <span class="pdc-card-no">3</span>
          <span class="pdc-card-title">商品描述对比</span>
          <span class="pdc-diff-tag" :class="descDiff.changed ? 'tag-changed' : 'tag-eq'">{{ descDiff.changed ? '不一致' : '一致' }}</span>
        </div>
        <div class="pdc-cmp-2col">
          <div class="pdc-cmp-col">
            <div class="pdc-col-label">
              已上架 · {{ descDiff.leftLen }}字
              <span v-if="descDiff.leftEmpty" class="pdc-badge pdc-badge-warn">空描述</span>
            </div>
            <div class="pdc-desc-block">
              <div v-for="(line, i) in descDiff.left" :key="i" class="pdc-desc-line" :class="{ 'pdc-line-only': line.only }">{{ line.text || ' ' }}</div>
            </div>
          </div>
          <div class="pdc-cmp-col">
            <div class="pdc-col-label">
              源商品 · {{ descDiff.rightLen }}字
              <span v-if="descDiff.rightEmpty" class="pdc-badge pdc-badge-warn">空描述</span>
            </div>
            <div class="pdc-desc-block">
              <div v-for="(line, i) in descDiff.right" :key="i" class="pdc-desc-line" :class="{ 'pdc-line-only': line.only }">{{ line.text || ' ' }}</div>
            </div>
          </div>
        </div>
      </section>

      <!-- ④ 商品富内容对比 -->
      <section class="pdc-card">
        <div class="pdc-card-head">
          <span class="pdc-card-no">4</span>
          <span class="pdc-card-title">商品富内容对比 <span class="pdc-attr-id">#attr 11254</span></span>
          <span class="pdc-diff-tag" :class="richDiff.cls">{{ richDiff.label }}</span>
        </div>
        <div class="pdc-cmp-2col">
          <div class="pdc-cmp-col">
            <div class="pdc-col-label">已上架 · Ozon同步</div>
            <JsonTree v-if="listedRichJson" :data="listedRichJson" :default-expand-level="2" root-key="富内容" />
            <div v-else class="pdc-empty">无富内容</div>
          </div>
          <div class="pdc-cmp-col">
            <div class="pdc-col-label">源商品 · 采集画像</div>
            <JsonTree v-if="sourceRichJson" :data="sourceRichJson" :default-expand-level="2" root-key="富内容" />
            <div v-else class="pdc-empty">无富内容</div>
          </div>
        </div>
      </section>

      <!-- ⑤ 所有属性对比 -->
      <section class="pdc-card">
        <div class="pdc-card-head">
          <span class="pdc-card-no">5</span>
          <span class="pdc-card-title">所有属性对比</span>
          <span class="pdc-diff-count">共 {{ attrStats.total }} 项</span>
          <span v-if="attrStats.added" class="pdc-diff-tag tag-add">增 {{ attrStats.added }}</span>
          <span v-if="attrStats.removed" class="pdc-diff-tag tag-del">删 {{ attrStats.removed }}</span>
          <span v-if="attrStats.changed" class="pdc-diff-tag tag-changed">改 {{ attrStats.changed }}</span>
        </div>
        <table class="pdc-cmp-table">
          <thead>
            <tr>
              <th class="pdc-th-key">属性</th>
              <th>已上架</th>
              <th>源商品</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in attrDiff" :key="a.id" :class="attrRowClass(a)">
              <td class="pdc-key">
                {{ a.name || '—' }}
                <span class="pdc-attr-id">#{{ a.id }}</span>
              </td>
              <td class="pdc-cell">
                {{ a.listed || '—' }}
                <span v-if="a.added" class="pdc-flag pdc-flag-add">增</span>
              </td>
              <td class="pdc-cell">
                {{ a.source || '—' }}
                <span v-if="a.removed" class="pdc-flag pdc-flag-del">删</span>
              </td>
            </tr>
            <tr v-if="!attrDiff.length">
              <td colspan="3" class="pdc-empty">无属性数据</td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="pdc-legend">
        <span><i class="lg lg-changed"></i>修改</span>
        <span><i class="lg lg-add"></i>仅已上架有</span>
        <span><i class="lg lg-del"></i>仅源商品有</span>
      </div>
    </div>

    <!-- 图片放大 -->
    <ImageLightbox v-model:open="lb.open" :url="lb.url" :list="lb.list" :title="lb.title" />
  </div>
</template>

<style scoped>
.pdc-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #f7f7f8;
}

/* 顶栏 */
.pdc-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.pdc-btn-back {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 6px;
  padding: 5px 12px;
  font-size: 13px;
  color: #6b7280;
  cursor: pointer;
  white-space: nowrap;
}
.pdc-btn-back:hover {
  background: #f3f4f6;
  color: #111827;
}
.pdc-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 15px;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdc-sku {
  font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace;
  color: #6d28d9;
  font-size: 13px;
  margin-left: 6px;
}
.pdc-nav {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.pdc-nav-btn {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  color: #374151;
  cursor: pointer;
}
.pdc-nav-btn:hover:not(:disabled) {
  border-color: #6d28d9;
  color: #6d28d9;
}
.pdc-nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pdc-pos {
  font-size: 12px;
  color: #6b7280;
  font-variant-numeric: tabular-nums;
  min-width: 90px;
  text-align: center;
}

/* 数据来源条 */
.pdc-src-bar {
  display: flex;
  gap: 8px;
  padding: 8px 16px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.pdc-src-chip {
  font-size: 12px;
  color: #6b7280;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  padding: 3px 10px;
}
.pdc-src-chip b {
  color: #111827;
  font-weight: 600;
}
.pdc-src-warn {
  background: #fef2f2;
  border-color: #fecaca;
  color: #991b1b;
}
.pdc-src-warn b {
  color: #991b1b;
}

/* 状态 */
.pdc-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6b7280;
  font-size: 14px;
  padding: 60px 0;
}
.pdc-state-error {
  color: #991b1b;
}

/* 主体 */
.pdc-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 对比卡 */
.pdc-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  overflow: hidden;
}
.pdc-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-bottom: 1px solid #e5e7eb;
  background: #fafafa;
  flex-wrap: wrap;
}
.pdc-card-no {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: #f5f3ff;
  color: #6d28d9;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.pdc-card-title {
  font-weight: 600;
  font-size: 13px;
  color: #111827;
  flex: 1;
}
.pdc-attr-id {
  color: #9ca3af;
  font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 11px;
  font-weight: 400;
}

/* 差异标签 */
.pdc-diff-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
}
.pdc-diff-count {
  font-size: 11px;
  color: #b45309;
  font-weight: 600;
}
.tag-changed {
  background: #fef3c7;
  color: #b45309;
}
.tag-add {
  background: #ecfdf5;
  color: #065f46;
}
.tag-del {
  background: #fef2f2;
  color: #991b1b;
}
.tag-eq {
  background: #f0fdf4;
  color: #166534;
}
.tag-neutral {
  background: #f3f4f6;
  color: #6b7280;
}

/* 双列对比 */
.pdc-cmp-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.pdc-cmp-col {
  padding: 12px 14px;
  border-right: 1px solid #e5e7eb;
  min-width: 0;
}
.pdc-cmp-col:last-child {
  border-right: none;
}
.pdc-col-label {
  font-size: 11px;
  color: #9ca3af;
  font-weight: 600;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pdc-badge {
  background: #f5f3ff;
  color: #6d28d9;
  padding: 1px 7px;
  border-radius: 4px;
  font-weight: 700;
  text-transform: none;
  letter-spacing: 0;
}
.pdc-badge-warn {
  background: #fef2f2;
  color: #991b1b;
}

/* 图片网格 */
.pdc-img-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pdc-img-cell {
  width: 76px;
  height: 76px;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  background: #fafafa;
  position: relative;
  overflow: hidden;
  cursor: pointer;
}
.pdc-img-cell:hover {
  border-color: #6d28d9;
}
.pdc-img-primary {
  border-color: #6d28d9;
  border-width: 2px;
}
.pdc-img-cell img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.pdc-img-idx {
  position: absolute;
  top: 2px;
  left: 3px;
  font-size: 10px;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 3px;
  padding: 0 4px;
  z-index: 1;
}
.pdc-img-main-tag {
  position: absolute;
  bottom: 2px;
  right: 2px;
  font-size: 9px;
  color: #fff;
  background: #6d28d9;
  border-radius: 3px;
  padding: 0 4px;
  z-index: 1;
}
.pdc-empty {
  color: #9ca3af;
  font-size: 12px;
  padding: 16px 0;
  text-align: center;
  width: 100%;
}

/* 对比表格 */
.pdc-cmp-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.pdc-cmp-table th {
  text-align: left;
  padding: 7px 14px;
  background: #fafafa;
  border-bottom: 1px solid #e5e7eb;
  font-size: 11px;
  font-weight: 600;
  color: #6b7280;
  position: sticky;
  top: 0;
  z-index: 1;
}
.pdc-cmp-table td {
  padding: 6px 14px;
  border-bottom: 1px solid #f3f4f6;
  vertical-align: top;
  word-break: break-word;
}
.pdc-cmp-table tbody tr:last-child td {
  border-bottom: none;
}
.pdc-th-key {
  width: 220px;
}
.pdc-key {
  color: #6b7280;
  white-space: nowrap;
}
.pdc-cell {
  font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace;
  color: #111827;
}

/* 行差异高亮 */
.pdc-row-changed {
  background: #fffbeb;
}
.pdc-row-added {
  background: #ecfdf5;
}
.pdc-row-removed {
  background: #fef2f2;
}
.pdc-cell-changed {
  background: #fef3c7;
  color: #92400e;
  font-weight: 600;
  border-radius: 3px;
}

/* 描述块 */
.pdc-desc-block {
  background: #fafafa;
  border-radius: 6px;
  padding: 8px 10px;
  max-height: 320px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.6;
  color: #374151;
  white-space: pre-wrap;
  word-break: break-word;
}
.pdc-desc-line {
  min-height: 1.6em;
}
.pdc-line-only {
  background: #fef3c7;
  color: #92400e;
  border-radius: 2px;
  padding: 0 2px;
}

/* 属性 flag */
.pdc-flag {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 3px;
  font-weight: 700;
  margin-left: 4px;
}
.pdc-flag-add {
  background: #d1fae5;
  color: #065f46;
}
.pdc-flag-del {
  background: #fee2e2;
  color: #991b1b;
}

/* 图例 */
.pdc-legend {
  display: flex;
  gap: 14px;
  padding: 4px 4px 0;
  font-size: 11px;
  color: #6b7280;
}
.pdc-legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pdc-legend .lg {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  display: inline-block;
}
.lg-changed {
  background: #fef3c7;
  border: 1px solid #fcd34d;
}
.lg-add {
  background: #ecfdf5;
  border: 1px solid #6ee7b7;
}
.lg-del {
  background: #fef2f2;
  border: 1px solid #fca5a5;
}

/* 响应式:窄屏双列改单列堆叠 */
@media (max-width: 760px) {
  .pdc-cmp-2col {
    grid-template-columns: 1fr;
  }
  .pdc-cmp-col {
    border-right: none;
    border-bottom: 1px solid #e5e7eb;
  }
  .pdc-cmp-col:last-child {
    border-bottom: none;
  }
  .pdc-th-key {
    width: 120px;
  }
  .pdc-nav {
    display: none;
  }
}
</style>
