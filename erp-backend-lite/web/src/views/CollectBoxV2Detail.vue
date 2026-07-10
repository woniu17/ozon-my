<script setup>
import { ref, computed, watch } from 'vue';
import AppAccordion from '../components/AppAccordion.vue';
import SourcedField from '../components/SourcedField.vue';
import JsonTree from '../components/JsonTree.vue';
import { previewOpi } from '../api/listingTemplates.js';
import { getAttributeDictionary, getCategoryNames, getAttributeValues } from '../api/collect-box-v2.js';

const props = defineProps({
  data: { type: Object, default: () => ({}) },
});

// 当前 sub-tab: overview / dom / seller-portal / page-json / synthesized
const activeSubtab = ref('overview');
const subtabs = [
  { key: 'overview', label: '概览' },
  { key: 'dom', label: 'DOM 数据源' },
  { key: 'seller-portal', label: 'Seller Portal' },
  { key: 'page-json', label: 'Page-JSON' },
  { key: 'synthesized', label: 'OPI 请求预览' },
];

// 富内容(11254)是 JSON 字符串,尝试解析为对象供 JsonTree 渲染;解析失败返回 null(降级为纯文本)
function parseRichContent(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

// ── OPI 请求预览:调用后端 preview-opi 把 synthesizedItems 转成 OPI v3 schema ──
const opiItems = ref([]); // 转换后的 OPI v3 items
const opiLoading = ref(false);
const opiError = ref('');
const opiLoaded = ref(false); // 是否已加载(避免重复请求)

// 提取 synthesizedItems 的纯值数组(供 preview-opi 接口消费)
function plainItems(items) {
  return (items || []).map((item) => {
    const out = {};
    for (const [k, v] of Object.entries(item || {})) {
      if (v && typeof v === 'object' && 'value' in v && 'source' in v) {
        out[k] = v.value;
      } else {
        out[k] = v;
      }
    }
    return out;
  });
}

async function loadOpiPreview() {
  if (opiLoaded.value || opiLoading.value) return;
  if (!synthesizedItems.value.length) return;
  opiLoading.value = true;
  opiError.value = '';
  try {
    const r = await previewOpi(plainItems(synthesizedItems.value));
    opiItems.value = Array.isArray(r?.items) ? r.items : [];
    opiLoaded.value = true;
  } catch (err) {
    opiError.value = err.message || String(err);
  } finally {
    opiLoading.value = false;
  }
}

// 切到 synthesized tab 时自动加载 OPI 预览
watch(activeSubtab, (v) => {
  if (v === 'synthesized') loadOpiPreview();
});

// ── OPI 字段来源追溯 ──
// OPI 字段 → synthesizedItems 字段名映射(用于追溯值的来源)
const OPI_SOURCE_MAP = {
  name: 'name',
  offer_id: 'offer_id',
  price: 'price',
  old_price: 'old_price',
  currency_code: 'currency_code',
  vat: 'vat',
  weight: 'weight',
  weight_unit: 'weight_unit',
  depth: 'depth',
  width: 'width',
  height: 'height',
  dimension_unit: 'dimension_unit',
  images: 'images',
  images360: 'images360',
  pdf_list: 'pdf_list',
  attributes: 'attributes',
  complex_attributes: 'bundleComplexAttrs',
  primary_image: 'images',
  color_image: null,
  type_id: 'description_category_id',
  description_category_id: 'description_category_id',
  new_description_category_id: null,
  barcode: 'barcode',
  video_url: 'videoUrl',
  video_cover: 'videoCover',
};

// 从 synthesizedItem 提取指定 OPI 字段的来源
function getFieldSource(synItem, opiField) {
  if (!synItem) return 'computed';
  const synField = OPI_SOURCE_MAP[opiField];
  if (!synField) return 'computed';

  // 1) 直接字段查找
  const v = synItem[synField];
  if (v && typeof v === 'object' && 'source' in v) return v.source || 'computed';

  // 2) 从 _sourceVariant 派生的字段(barcode/attributes/type_id/description_category_id)
  //    _sourceVariant 来自 Seller Portal API,其 source 通常为 'seller-portal'
  const svDerivedFields = ['barcode', 'attributes', 'type_id', 'description_category_id'];
  if (svDerivedFields.includes(opiField)) {
    const sv = synItem._sourceVariant;
    if (sv && typeof sv === 'object' && 'source' in sv) return sv.source || 'seller-portal';
    return 'seller-portal';
  }

  // 3) primary_image 从 images 派生
  if (opiField === 'primary_image') {
    const imgs = synItem.images;
    if (imgs && typeof imgs === 'object' && 'source' in imgs) return imgs.source || 'computed';
  }

  // 4) complex_attributes 从 bundleComplexAttrs 派生
  if (opiField === 'complex_attributes') {
    const bca = synItem.bundleComplexAttrs;
    if (bca && typeof bca === 'object' && 'source' in bca) return bca.source || 'seller-portal';
    return 'seller-portal';
  }

  return 'computed';
}

function getFieldSourceDetail(synItem, opiField) {
  if (!synItem) return '';
  const synField = OPI_SOURCE_MAP[opiField];
  if (!synField) return '';
  const v = synItem[synField];
  if (v && typeof v === 'object' && 'sourceDetail' in v) return v.sourceDetail || '';
  // 派生字段补充 sourceDetail
  if (['barcode', 'attributes'].includes(opiField)) return 'sv._searchMeta / sv.attributes';
  if (opiField === 'complex_attributes') return 'bundleComplexAttrs';
  if (opiField === 'primary_image') return 'images[default]';
  return '';
}

// OPI 字段显示顺序:基础字段在前,images/images360/pdf_list/attributes/complex_attributes 在后
const OPI_FIELD_ORDER = [
  'name',
  'offer_id',
  'price',
  'old_price',
  'currency_code',
  'vat',
  'weight',
  'weight_unit',
  'depth',
  'width',
  'height',
  'dimension_unit',
  'primary_image',
  'color_image',
  'type_id',
  'description_category_id',
  'new_description_category_id',
  'barcode',
  'video_url',
  'video_cover',
  'images',
  'images360',
  'pdf_list',
  'attributes',
  'complex_attributes',
];

// 为每个 OPI item 构建带来源的字段列表
function buildSourcedFields(opiItem, synItem) {
  return OPI_FIELD_ORDER.filter((k) => opiItem[k] !== undefined).map((k) => ({
    label: k,
    field: {
      value: opiItem[k],
      source: getFieldSource(synItem, k),
      sourceDetail: getFieldSourceDetail(synItem, k),
    },
  }));
}

function fmtTime(t) {
  if (!t) return '—';
  // 毫秒时间戳(collected_at 是 INTEGER ms) → 本地时间
  const ms = typeof t === 'number' ? t : /^\d{13}$/.test(String(t)) ? Number(t) : 0;
  if (ms > 0) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  // datetime 字符串(created_at 是 SQLite datetime('now') UTC)→ 转本地时间
  const s = String(t).replace('T', ' ').slice(0, 19);
  const ms2 = Date.parse(s.replace(' ', 'T') + 'Z');
  if (!Number.isNaN(ms2)) {
    const d = new Date(ms2);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return s;
}

// 概览 meta source
const metaSource = 'dom';

const rawBySource = computed(() => props.data?.rawBySource || {});
const domSource = computed(() => rawBySource.value.dom || {});
const sellerPortal = computed(() => rawBySource.value.sellerPortal || {});
const pageJson = computed(() => rawBySource.value.pageJson || {});
const sellerSkus = computed(() => Object.keys(sellerPortal.value));
const pageJsonSkus = computed(() => Object.keys(pageJson.value));
const synthesizedItems = computed(() => props.data?.synthesizedItems || []);
const isTruncated = computed(() => !!rawBySource.value._truncated);

function attrCount(sv) {
  return Array.isArray(sv?.attributes) ? sv.attributes.length : 0;
}

// ── 属性字典 / 类目名 / 类型名查询 ──
// 流程:从 pickedSv 提取 typeId → 调 category-names 按 typeId 搜树,
// 获取 descriptionCategoryId + 类目名 + 类型名 → 再用 descriptionCategoryId + typeId 查属性字典。
const attrDict = ref([]); // [{id, name, description, type, is_required, dictionary_id, ...}]
const attrDictLoading = ref(false);
const attrDictError = ref('');
const categoryNames = ref({ descriptionCategoryId: 0, categoryName: '', typeName: '' });

// 从 pickedSv 提取 type_id
// 注:sv.description_category_id 实际是 type_id(描述类型字典值),
//     Ozon description-category API 的 type_id 和它一致。
function extractTypeId(pickedSv) {
  if (!pickedSv) return 0;
  return Number(pickedSv.description_category_id) || Number(pickedSv._bundleItem?.type_id) || 0;
}

// 从第一个有 pickedSv 的 SKU 取 typeId
const metaTypeId = computed(() => {
  for (const sku of sellerSkus.value) {
    const pickedSv = sellerPortal.value[sku]?.pickedSv;
    if (pickedSv) return extractTypeId(pickedSv);
  }
  return 0;
});

// 属性字典 map: { id → attrDesc }
const attrDictMap = computed(() => {
  const m = new Map();
  for (const a of attrDict.value) m.set(String(a.id), a);
  return m;
});

// 把 pickedSv.attributes 归一化为统一列表(兼容 /search 和 /bundle 两种 shape)
function normalizeAttrs(pickedSv) {
  if (!pickedSv) return [];
  // 优先 _bundleItem.attributes(更完整,含 dictionary_value_id)
  const bundleAttrs = pickedSv._bundleItem?.attributes;
  if (Array.isArray(bundleAttrs) && bundleAttrs.length > 0) {
    return bundleAttrs.map((a) => ({
      id: String(a.attribute_id || a.id || ''),
      values: (a.values || []).map((v) => v?.value || '').filter(Boolean),
      dictIds: (a.values || []).map((v) => v?.dictionary_value_id).filter(Boolean),
      complexId: a.complex_id || 0,
      source: 'bundle',
    }));
  }
  // 兜底 pickedSv.attributes(/search 归一化)
  const svAttrs = pickedSv.attributes;
  if (Array.isArray(svAttrs)) {
    return svAttrs.map((a) => {
      const vals = [];
      if (a.value != null) vals.push(String(a.value));
      if (Array.isArray(a.collection)) vals.push(...a.collection.map(String));
      return {
        id: String(a.key || a.attribute_id || a.id || ''),
        values: vals,
        dictIds: [],
        complexId: a.complex_id || 0,
        source: 'search',
      };
    });
  }
  return [];
}

// 把 OPI v3 item.attributes 归一化为统一列表(供 OPI 预览属性含义展示)
// OPI v3 shape: {complex_id, id, values:[{value, dictionary_value_id?}]}
function normalizeOpiAttrs(opiItem) {
  const attrs = opiItem?.attributes;
  if (!Array.isArray(attrs)) return [];
  return attrs.map((a) => ({
    id: String(a.id ?? ''),
    values: (a.values || []).map((v) => (v?.value != null ? String(v.value) : '')).filter(Boolean),
    dictIds: (a.values || []).map((v) => v?.dictionary_value_id).filter((x) => x != null),
    complexId: a.complex_id || 0,
    source: 'opi',
  }));
}

async function loadAttrMeta() {
  const storeId = props.data?.storeId;
  const typeId = metaTypeId.value;
  if (!storeId || !typeId) return;
  attrDictLoading.value = true;
  attrDictError.value = '';
  dictValueCache.value = new Map(); // 重置字典值缓存
  try {
    // 1. 先按 typeId 查类目树,获取 descriptionCategoryId + 类目名 + 类型名
    const names = await getCategoryNames(storeId, typeId);
    categoryNames.value = names || { descriptionCategoryId: 0, categoryName: '', typeName: '' };
    // 2. 再用 descriptionCategoryId + typeId 查属性字典
    const categoryId = Number(names?.descriptionCategoryId) || 0;
    if (categoryId) {
      const attrs = await getAttributeDictionary(storeId, categoryId, typeId);
      attrDict.value = Array.isArray(attrs) ? attrs : [];
      // 3. 对有 dictionary_id 的属性,批量查字典值并建立 id→value 映射
      await loadDictValues(storeId, categoryId, typeId);
    }
  } catch (err) {
    attrDictError.value = err.message || String(err);
  } finally {
    attrDictLoading.value = false;
  }
}

// ── 字典值缓存 ──
// dictValueCache: { dictId → readableValue }
// 对于有 dictionary_id 的属性,调 /attribute-values 把所有可选值拉回来,
// 再按 pickedSv 里的 dictIds 反查可读值。
const dictValueCache = ref(new Map());
const dictValuesLoading = ref(false);

async function loadDictValues(storeId, categoryId, typeId) {
  const dictAttrs = attrDict.value.filter((a) => a.dictionary_id);
  if (dictAttrs.length === 0) return;
  dictValuesLoading.value = true;
  try {
    const cache = new Map();
    // 并发拉取每个字典属性的值(限制并发 5)
    const chunks = [];
    for (let i = 0; i < dictAttrs.length; i += 5) {
      chunks.push(dictAttrs.slice(i, i + 5));
    }
    for (const chunk of chunks) {
      const results = await Promise.all(
        chunk.map((a) =>
          getAttributeValues(storeId, categoryId, typeId, a.id)
            .then((vals) => ({ attrId: a.id, vals: Array.isArray(vals) ? vals : [] }))
            .catch(() => ({ attrId: a.id, vals: [] }))
        )
      );
      for (const { vals } of results) {
        for (const v of vals) {
          cache.set(String(v.id), v.value || '');
        }
      }
    }
    dictValueCache.value = cache;
  } finally {
    dictValuesLoading.value = false;
  }
}

// 把单个属性的值渲染成可读字符串
// 对于字典属性,如果 dictIds[i] 能在 cache 中找到,显示可读值(附 dictId 备注)
function formatAttrValue(a) {
  if (!a.values || a.values.length === 0) return '—';
  const parts = a.values.map((val, i) => {
    const dictId = a.dictIds?.[i];
    if (dictId) {
      const readable = dictValueCache.value.get(String(dictId));
      if (readable) return `${readable} (id:${dictId})`;
      return `${val} (dict:${dictId})`;
    }
    return val;
  });
  return parts.join(', ');
}

// 数据变化时自动加载属性字典
watch(
  () => [props.data?.id, metaTypeId.value],
  () => {
    attrDict.value = [];
    categoryNames.value = { descriptionCategoryId: 0, categoryName: '', typeName: '' };
    loadAttrMeta();
  },
  { immediate: true }
);

// ── 5 类数据源采集状态(判定 rawBySource 中各源是否非空)──
// ok=true 表示已采集到数据,miss=true 表示缺失(该源未采或降级为 null)
// tab 字段非空时点击 chip 可跳转到对应 sub-tab 查看
const sourceStatuses = computed(() => {
  const r = rawBySource.value;
  const dom = r.dom;
  const domOk = dom != null && typeof dom === 'object' && Object.keys(dom).length > 0;
  const sp = r.sellerPortal || {};
  const spVals = Object.values(sp);
  const spOk = spVals.length > 0 && spVals.some((v) => v?.pickedSv);
  const pj = r.pageJson || {};
  const pjOk = Object.keys(pj).length > 0;
  const ssr = r.ssrAspects;
  const ssrOk =
    ssr != null &&
    typeof ssr === 'object' &&
    (Array.isArray(ssr.mergedVariants) ? ssr.mergedVariants.length > 0 : Object.keys(ssr).length > 0);
  const vt = r.videoTranscode || {};
  const vtOk = !!vt.transferredVideoUrl || !!vt.originalMp4Url;
  return [
    {
      key: 'dom',
      label: 'DOM',
      ok: domOk,
      tab: 'dom',
      desc: 'PDP 页面元素抽取(productData/breadcrumbs/hashtags/characteristics/aspectVariants)',
    },
    {
      key: 'seller-portal',
      label: 'Seller Portal',
      ok: spOk,
      tab: 'seller-portal',
      desc: 'seller.ozon.ru /api/v1/search + /bundle(pickedSv/searchResponse/bundleResponse)',
    },
    {
      key: 'page-json',
      label: 'Page-JSON',
      ok: pjOk,
      tab: 'page-json',
      desc: 'entrypoint-api fetchVariantGallery(gallery/richContent/description/hashtags)',
    },
    {
      key: 'ssr-aspects',
      label: 'SSR-Aspects',
      ok: ssrOk,
      tab: '',
      desc: '页面 SSR mergedVariants(aspectValues)',
    },
    {
      key: 'video-transcode',
      label: 'Video-Transcode',
      ok: vtOk,
      tab: '',
      desc: 'SW 视频转存(originalMp4Url/transferredVideoUrl/transferredCoverUrl)',
    },
  ];
});
</script>

<template>
  <div class="cbv2-detail">
    <!-- sub-tab 切换栏 -->
    <div class="sub-tabs">
      <button
        v-for="t in subtabs"
        :key="t.key"
        class="sub-tab"
        :class="{ active: activeSubtab === t.key }"
        @click="activeSubtab = t.key"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- ── 概览 ── -->
    <div v-show="activeSubtab === 'overview'">
      <!-- 数据源采集状态:5 类数据源 chip,绿✓已采集/灰✗缺失,已采集可点击跳转 -->
      <AppAccordion title="数据源采集状态" :default-open="true">
        <div class="source-status-grid">
          <span
            v-for="s in sourceStatuses"
            :key="s.key"
            class="source-chip"
            :class="{
              'source-chip--ok': s.ok,
              'source-chip--miss': !s.ok,
              'source-chip--clickable': s.ok && s.tab,
            }"
            :title="s.desc + (s.ok ? '' : ' (未采集/降级为 null)')"
            @click="s.ok && s.tab && (activeSubtab = s.tab)"
          >
            <span class="source-chip-icon">{{ s.ok ? '✓' : '✗' }}</span>
            <span class="source-chip-label">{{ s.label }}</span>
          </span>
        </div>
        <p class="source-status-tip">
          共 5 类数据源(DOM / Seller Portal / Page-JSON / SSR-Aspects /
          Video-Transcode)。绿色✓表示已采集,灰色✗表示缺失(该源未采或降级为
          null)。点击已采集且高亮的标签可跳转到对应数据源详情。
        </p>
      </AppAccordion>
      <AppAccordion title="采集元信息" :default-open="true">
        <SourcedField label="sku" :field="{ value: data.sku, source: metaSource }" />
        <SourcedField label="anchor_sku" :field="{ value: data.anchorSku, source: metaSource }" />
        <SourcedField label="collect_source" :field="{ value: data.collectSource || '—', source: metaSource }" />
        <SourcedField label="store_id" :field="{ value: data.storeId, source: metaSource }" />
        <SourcedField
          label="类目名 / 类型名"
          :field="{
            value: categoryNames.categoryName
              ? categoryNames.typeName
                ? categoryNames.categoryName + ' / ' + categoryNames.typeName
                : categoryNames.categoryName
              : '—',
            source: metaSource,
          }"
        />
        <SourcedField label="collected_at" :field="{ value: fmtTime(data.collectedAt), source: metaSource }" />
        <SourcedField label="created_at" :field="{ value: fmtTime(data.createdAt), source: metaSource }" />
      </AppAccordion>
    </div>

    <!-- ── DOM 数据源 ── -->
    <div v-show="activeSubtab === 'dom'">
      <div v-if="isTruncated" class="muted">
        ⚠️ 原始数据已截断: {{ rawBySource._reason || '超 5MB' }} (原始大小: {{ rawBySource._originalSize }} 字节)
      </div>
      <template v-else>
        <AppAccordion title="extractProductData (PDP 商品数据)" :default-open="true">
          <JsonTree :data="domSource.productData" root-key="productData" />
        </AppAccordion>
        <AppAccordion title="extractBreadcrumbs (面包屑)" :default-open="true">
          <JsonTree :data="domSource.breadcrumbs" root-key="breadcrumbs" />
        </AppAccordion>
        <AppAccordion title="extractKeywords (主题标签)" :default-open="true">
          <JsonTree :data="domSource.hashtags" root-key="hashtags" />
        </AppAccordion>
        <AppAccordion title="extractCharacteristics (物理特性)" :default-open="true">
          <JsonTree :data="domSource.characteristics" root-key="characteristics" />
        </AppAccordion>
        <AppAccordion title="extractAspectVariants (变体轴)" :default-open="true">
          <JsonTree :data="domSource.aspectVariants" root-key="aspectVariants" />
        </AppAccordion>
      </template>
    </div>

    <!-- ── Seller Portal ── -->
    <div v-show="activeSubtab === 'seller-portal'">
      <p v-if="!sellerSkus.length" class="muted">无 Seller Portal 数据</p>
      <AppAccordion
        v-for="sku in sellerSkus"
        :key="'sp-' + sku"
        :title="'SKU ' + sku"
        :badge="attrCount(sellerPortal[sku]?.pickedSv) + ' attrs'"
        :default-open="true"
      >
        <template v-if="sellerPortal[sku]">
          <SourcedField
            label="variant_id"
            :field="{
              value: sellerPortal[sku].pickedSv?.variant_id,
              source: 'seller-portal',
              sourceDetail: '/api/v1/search',
            }"
          />
          <SourcedField
            label="类目"
            :field="{ value: sellerPortal[sku].pickedSv?.categories, source: 'seller-portal' }"
          />
          <SourcedField
            label="attributes 数"
            :field="{ value: attrCount(sellerPortal[sku].pickedSv), source: 'seller-portal' }"
          />
          <!-- 属性含义:把 attribute_id 翻译成属性名/描述/类型 + 当前值(字典值可读化) -->
          <AppAccordion title="属性含义" :default-open="true">
            <p v-if="attrDictLoading" class="muted">加载属性字典中…</p>
            <p v-else-if="attrDictError" class="error-text">属性字典加载失败:{{ attrDictError }}</p>
            <p v-else-if="!attrDict.length" class="muted">无属性字典(需店铺配置 OPI 凭据 + 有 typeId)</p>
            <template v-else>
              <p v-if="dictValuesLoading" class="muted" style="margin-bottom: 8px">正在加载字典值(可读名称)…</p>
              <div class="attr-dict-table">
                <div class="attr-dict-row attr-dict-header">
                  <span>ID</span>
                  <span>属性名</span>
                  <span>类型</span>
                  <span>当前值</span>
                </div>
                <div
                  v-for="a in normalizeAttrs(sellerPortal[sku].pickedSv)"
                  :key="a.id"
                  class="attr-dict-row"
                  :title="attrDictMap.get(a.id)?.description || ''"
                >
                  <span class="attr-dict-id">{{ a.id }}</span>
                  <span class="attr-dict-name">
                    {{ attrDictMap.get(a.id)?.name || '(未在字典中)' }}
                    <span v-if="attrDictMap.get(a.id)?.is_required" class="attr-required">*</span>
                  </span>
                  <span class="attr-dict-type">{{ attrDictMap.get(a.id)?.type || '—' }}</span>
                  <span class="attr-dict-value">{{ formatAttrValue(a) }}</span>
                </div>
              </div>
            </template>
          </AppAccordion>
          <AppAccordion title="完整 sv 对象" :default-open="true">
            <JsonTree :data="sellerPortal[sku].pickedSv" root-key="pickedSv" />
          </AppAccordion>
          <AppAccordion v-if="sellerPortal[sku].searchResponse" title="/search 响应" :default-open="true">
            <JsonTree :data="sellerPortal[sku].searchResponse" root-key="searchResponse" />
          </AppAccordion>
          <AppAccordion v-if="sellerPortal[sku].bundleResponse" title="/bundle 响应" :default-open="true">
            <JsonTree :data="sellerPortal[sku].bundleResponse" root-key="bundleResponse" />
          </AppAccordion>
        </template>
      </AppAccordion>
    </div>

    <!-- ── Page-JSON ── -->
    <div v-show="activeSubtab === 'page-json'">
      <p v-if="!pageJsonSkus.length" class="muted">无 Page-JSON 数据</p>
      <AppAccordion
        v-for="sku in pageJsonSkus"
        :key="'pj-' + sku"
        :title="'SKU ' + sku"
        :badge="(pageJson[sku]?.gallery || []).length + ' 图'"
        :default-open="true"
      >
        <template v-if="pageJson[sku]">
          <SourcedField label="图册数" :field="{ value: (pageJson[sku].gallery || []).length, source: 'page-json' }" />
          <SourcedField label="endpoint" :field="{ value: pageJson[sku].endpoint, source: 'page-json' }" />
          <AppAccordion title="图册" :default-open="true">
            <JsonTree :data="pageJson[sku].gallery" root-key="gallery" />
          </AppAccordion>
          <AppAccordion v-if="pageJson[sku].richContent" title="富内容(11254)" :default-open="true">
            <JsonTree
              v-if="parseRichContent(pageJson[sku].richContent)"
              :data="parseRichContent(pageJson[sku].richContent)"
              root-key="richContent"
            />
            <pre v-else class="sf-value-pre">{{ pageJson[sku].richContent }}</pre>
          </AppAccordion>
          <AppAccordion v-if="pageJson[sku].response" title="完整响应" :default-open="true">
            <JsonTree :data="pageJson[sku].response" root-key="response" />
          </AppAccordion>
        </template>
      </AppAccordion>
    </div>

    <!-- ── OPI 请求预览 (OPI v3) ── -->
    <div v-show="activeSubtab === 'synthesized'">
      <p v-if="!synthesizedItems.length" class="muted">无 OPI 请求数据</p>
      <template v-else>
        <p v-if="opiLoading" class="muted">正在转换 OPI v3 格式...</p>
        <p v-else-if="opiError" class="error-text">转换失败:{{ opiError }}</p>
        <AppAccordion
          v-for="(item, i) in opiItems"
          v-else
          :key="'syn-' + i"
          :title="'变体 ' + (i + 1)"
          :badge="(item.attributes?.length || 0) + ' 属性'"
          :default-open="false"
        >
          <!-- 每个字段带来源标签 -->
          <SourcedField
            v-for="f in buildSourcedFields(item, synthesizedItems[i])"
            :key="f.label"
            :label="f.label"
            :field="f.field"
          />
          <!-- 属性含义:把 OPI v3 attribute id 翻译成属性名/描述/类型 + 当前值(字典值可读化) -->
          <AppAccordion title="属性含义" :default-open="false">
            <p v-if="attrDictLoading" class="muted">加载属性字典中…</p>
            <p v-else-if="attrDictError" class="error-text">属性字典加载失败:{{ attrDictError }}</p>
            <p v-else-if="!attrDict.length" class="muted">无属性字典(需店铺配置 OPI 凭据 + 有 typeId)</p>
            <template v-else>
              <p v-if="dictValuesLoading" class="muted" style="margin-bottom: 8px">正在加载字典值(可读名称)…</p>
              <div class="attr-dict-table">
                <div class="attr-dict-row attr-dict-header">
                  <span>ID</span>
                  <span>属性名</span>
                  <span>类型</span>
                  <span>当前值</span>
                </div>
                <div
                  v-for="a in normalizeOpiAttrs(item)"
                  :key="a.id"
                  class="attr-dict-row"
                  :title="attrDictMap.get(a.id)?.description || ''"
                >
                  <span class="attr-dict-id">{{ a.id }}</span>
                  <span class="attr-dict-name">
                    {{ attrDictMap.get(a.id)?.name || '(未在字典中)' }}
                    <span v-if="attrDictMap.get(a.id)?.is_required" class="attr-required">*</span>
                  </span>
                  <span class="attr-dict-type">{{ attrDictMap.get(a.id)?.type || '—' }}</span>
                  <span class="attr-dict-value">{{ formatAttrValue(a) }}</span>
                </div>
              </div>
            </template>
          </AppAccordion>
          <!-- 可折叠的原始 OPI JSON -->
          <details class="opi-raw-json">
            <summary>原始 OPI JSON</summary>
            <JsonTree :data="item" :root-key="'变体 ' + (i + 1)" />
          </details>
        </AppAccordion>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cbv2-detail {
  min-height: 120px;
}
/* 原始 OPI JSON 折叠区 */
.opi-raw-json {
  margin-top: 12px;
  border-top: 1px dashed #e5e7eb;
  padding-top: 8px;
}
.opi-raw-json summary {
  cursor: pointer;
  font-size: 12px;
  color: #6b7280;
  user-select: none;
}
.opi-raw-json summary:hover {
  color: #374151;
}
/* 属性含义表 */
.attr-dict-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
}
.attr-dict-row {
  display: grid;
  grid-template-columns: 60px 1fr 70px 1.5fr;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 4px;
  align-items: baseline;
}
.attr-dict-row:nth-child(even) {
  background: #f9fafb;
}
.attr-dict-header {
  font-weight: 600;
  color: #6b7280;
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 6px;
}
.attr-dict-id {
  font-family: monospace;
  color: #6b7280;
}
.attr-dict-name {
  font-weight: 500;
  color: #1f2937;
}
.attr-required {
  color: #dc2626;
}
.attr-dict-type {
  color: #7c3aed;
  font-size: 11px;
}
.attr-dict-value {
  color: #374151;
  word-break: break-all;
}
/* 数据源采集状态 chip */
.source-status-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0 4px;
}
.source-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 500;
  cursor: default;
  user-select: none;
  border: 1px solid transparent;
  transition: opacity 0.15s;
}
.source-chip-icon {
  font-weight: bold;
  font-size: 13px;
}
.source-chip--ok {
  background: #dcfce7;
  color: #15803d;
  border-color: #86efac;
}
.source-chip--miss {
  background: #f3f4f6;
  color: #9ca3af;
  border-color: #e5e7eb;
}
.source-chip--clickable {
  cursor: pointer;
}
.source-chip--clickable:hover {
  opacity: 0.8;
}
.source-status-tip {
  font-size: 11px;
  color: #6b7280;
  margin: 6px 0 0;
  line-height: 1.5;
}
</style>
