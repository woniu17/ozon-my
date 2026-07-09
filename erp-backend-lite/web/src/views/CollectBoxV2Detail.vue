<script setup>
import { ref, computed, watch } from 'vue';
import AppAccordion from '../components/AppAccordion.vue';
import SourcedField from '../components/SourcedField.vue';
import JsonTree from '../components/JsonTree.vue';
import { previewOpi } from '../api/listingTemplates.js';

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
  { key: 'synthesized', label: '合成请求预览' },
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

// ── 合成请求预览(OPI v3):调用后端 preview-opi 把 synthesizedItems 转成 OPI v3 schema ──
const opiItems = ref([]);      // 转换后的 OPI v3 items
const opiLoading = ref(false);
const opiError = ref('');
const opiLoaded = ref(false);  // 是否已加载(避免重复请求)

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

function fmtTime(t) {
  if (!t) return '—';
  return String(t).replace('T', ' ').slice(0, 19);
}

const isLegacy = computed(() => props.data?.sourceTable === 'collect_box');

// 概览 meta source: 老表全部 legacy,新表用 dom
const metaSource = computed(() => (isLegacy.value ? 'legacy' : 'dom'));

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
      >{{ t.label }}</button>
    </div>

    <!-- ── 概览 ── -->
    <div v-show="activeSubtab === 'overview'">
      <div v-if="isLegacy" class="cbv2-legacy-banner">
        <strong>⚠ 旧版采集记录</strong> — 此记录由旧版采集通道推送，无字段级来源标记（source 全部显示为 <code>legacy</code>），也无 5 类数据源原始响应与合成请求预览。<br>如需查看完整来源信息，请在 Ozon 商品详情页重新点「一键采集」（确保已重新加载扩展）。
      </div>
      <AppAccordion title="采集元信息" :default-open="true">
        <SourcedField label="anchor_sku" :field="{ value: data.anchorSku, source: metaSource }" />
        <SourcedField label="store_id" :field="{ value: data.storeId, source: metaSource }" />
        <SourcedField label="variant_count" :field="{ value: data.variantCount, source: metaSource }" />
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
            :field="{ value: sellerPortal[sku].pickedSv?.variant_id, source: 'seller-portal', sourceDetail: '/api/v1/search' }"
          />
          <SourcedField
            label="类目"
            :field="{ value: sellerPortal[sku].pickedSv?.categories, source: 'seller-portal' }"
          />
          <SourcedField
            label="attributes 数"
            :field="{ value: attrCount(sellerPortal[sku].pickedSv), source: 'seller-portal' }"
          />
          <AppAccordion title="完整 sv 对象" :default-open="true">
            <JsonTree :data="sellerPortal[sku].pickedSv" root-key="pickedSv" />
          </AppAccordion>
          <AppAccordion
            v-if="sellerPortal[sku].searchResponse"
            title="/search 响应"
            :default-open="true"
          >
            <JsonTree :data="sellerPortal[sku].searchResponse" root-key="searchResponse" />
          </AppAccordion>
          <AppAccordion
            v-if="sellerPortal[sku].bundleResponse"
            title="/bundle 响应"
            :default-open="true"
          >
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
          <SourcedField
            label="图册数"
            :field="{ value: (pageJson[sku].gallery || []).length, source: 'page-json' }"
          />
          <SourcedField
            label="endpoint"
            :field="{ value: pageJson[sku].endpoint, source: 'page-json' }"
          />
          <AppAccordion title="图册" :default-open="true">
            <JsonTree :data="pageJson[sku].gallery" root-key="gallery" />
          </AppAccordion>
          <AppAccordion
            v-if="pageJson[sku].richContent"
            title="富内容(11254)"
            :default-open="true"
          >
            <JsonTree
              v-if="parseRichContent(pageJson[sku].richContent)"
              :data="parseRichContent(pageJson[sku].richContent)"
              root-key="richContent"
            />
            <pre v-else class="sf-value-pre">{{ pageJson[sku].richContent }}</pre>
          </AppAccordion>
          <AppAccordion
            v-if="pageJson[sku].response"
            title="完整响应"
            :default-open="true"
          >
            <JsonTree :data="pageJson[sku].response" root-key="response" />
          </AppAccordion>
        </template>
      </AppAccordion>
    </div>

    <!-- ── 合成请求预览 (OPI v3) ── -->
    <div v-show="activeSubtab === 'synthesized'">
      <p v-if="!synthesizedItems.length" class="muted">无合成请求数据</p>
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
          <JsonTree :data="item" :root-key="'变体 ' + (i + 1)" />
        </AppAccordion>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cbv2-detail {
  min-height: 120px;
}
</style>
