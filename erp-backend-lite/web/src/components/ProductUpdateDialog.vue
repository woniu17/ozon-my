<script setup>
// 商品信息更新弹窗(2026-07)
// 单条模式:对单个商品更新标题/描述等字段,可预览当前值
// 批量模式:对多个商品更新,支持两种填充方式:
//   ① 统一文案(所有商品相同的 name/description)
//   ② 从缓存批量获取(每个商品各自的源 SKU 缓存值,分页预览可编辑)
// 统一走 /v3/product/import 全量重传,字段驱动(FieldUpdater 可拓展)
import { ref, watch, computed, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { createProductUpdate, previewProductUpdate, getSupportedFields } from '../api/productUpdate.js';
import { getSkuProfile, getSkuProfileBatch } from '../api/collect-box-v2.js';
import { useToast } from './useToast.js';
import AppModal from './AppModal.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  // 'single' | 'batch'
  mode: { type: String, default: 'single' },
  // single 模式:{ productId, storeId, offerId }
  singleItem: { type: Object, default: null },
  // batch 模式:[{ productId, storeId, offerId }]
  selectedProducts: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:open', 'submitted']);

const router = useRouter();
const { show } = useToast();

const submitting = ref(false);
const previewing = ref(false);
// 支持的字段列表(从后端拉取)
const supportedFields = ref([]);
// 当前预览到的商品信息(单条模式)
const previewData = ref(null);

// 字段键 → 中文标签
const FIELD_LABEL = {
  name: '标题',
  description: '描述',
  price: '价格',
  old_price: '划线价',
  weight: '重量',
  dimensions: '尺寸',
  primary_image: '主图',
  images: '图片',
};
function fieldLabel(f) {
  return FIELD_LABEL[f] || f;
}

// ── 描述高亮:把占位文案(quality=1)和按钮污染文案(quality=2)标红 ──
// 与后端 src/utils/description-quality.js 同口径
const DESC_UI_CHROME_RE = /(читать далее|показать полностью|свернуть описание|развернуть описание)/gi;
const DESC_LOAD_FAIL_RE = /(не удалось загрузить|ошибка загрузки|попробуйте (обновить|позже)|failed to load)/gi;

// 把描述切分为片段数组:[{ text, type: 'normal'|'placeholder'|'chrome' }]
// type:'placeholder' = 加载失败占位(quality=1);'chrome' = 按钮污染文案(quality=2)
function splitDescSegments(desc) {
  if (!desc) return [];
  const s = String(desc);
  const segments = [];
  // 合并两个正则的所有匹配区间,统一扫描
  // 用一个组合正则做全局扫描,match 出所有命中片段及位置
  const combined = new RegExp(
    '(' + [
      'читать далее', 'показать полностью', 'свернуть описание', 'развернуть описание',
      'не удалось загрузить', 'ошибка загрузки', 'попробуйте (?:обновить|позже)', 'failed to load',
    ].join('|') + ')',
    'gi'
  );
  let last = 0;
  let m;
  while ((m = combined.exec(s)) !== null) {
    if (m.index > last) segments.push({ text: s.slice(last, m.index), type: 'normal' });
    // 判断类型:命中"加载失败"关键词 → placeholder;否则(按钮文案) → chrome
    const isFail = DESC_LOAD_FAIL_RE.test(m[0]);
    segments.push({ text: m[0], type: isFail ? 'placeholder' : 'chrome' });
    last = m.index + m[0].length;
    // 防止零宽匹配死循环
    if (m[0].length === 0) combined.lastIndex++;
  }
  if (last < s.length) segments.push({ text: s.slice(last), type: 'normal' });
  return segments;
}

// 单条模式:统一字段勾选 + 值(单条和批量统一文案模式共用)
// 默认勾选标题、描述(用户最常更新的两个字段)
const fieldState = reactive({
  name: { checked: true, value: '' },
  description: { checked: true, value: '' },
});
// 字段是否处于编辑模式(默认 false=只读展示,点"编辑"后 true=显示输入框)
const editingFields = reactive({
  name: false,
  description: false,
});
function startEdit(field) { editingFields[field] = true; }
function finishEdit(field) { editingFields[field] = false; }

// 批量模式:每条商品每字段的编辑状态,key=`${offerId}:${field}`
const batchEditing = reactive(new Set());
function isBatchEditing(offerId, field) { return batchEditing.has(`${offerId}:${field}`); }
function startBatchEdit(offerId, field) { batchEditing.add(`${offerId}:${field}`); }
function finishBatchEdit(offerId, field) { batchEditing.delete(`${offerId}:${field}`); }

// 批量模式:是否使用"从缓存批量获取"模式
const useBatchCacheMode = ref(false);
// 批量缓存数据:Map<offerId, { name, description, sources }>
const batchCacheData = ref(new Map());
// 批量缓存加载状态
const batchCacheLoading = ref(false);
// 批量分页
const batchPage = ref(1);
const batchPageSize = 3;

const isBatch = computed(() => props.mode === 'batch');

// 当前生效的 storeId(single 取 singleItem,batch 取 selectedProducts[0])
const currentStoreId = computed(() => {
  if (isBatch.value) {
    return props.selectedProducts?.[0]?.storeId || '';
  }
  return props.singleItem?.storeId || '';
});

// 当前生效的 offerId(single 模式)
const currentOfferId = computed(() => props.singleItem?.offerId || '');

// 从缓存填充字段的加载状态 + 缓存命中情况(单条模式)
const fillingFromCache = ref(false);
const cacheProfile = ref(null);

// 批量分页数据
const batchPagedItems = computed(() => {
  if (!isBatch.value || !useBatchCacheMode.value) return [];
  const items = props.selectedProducts || [];
  const start = (batchPage.value - 1) * batchPageSize;
  return items.slice(start, start + batchPageSize);
});
const batchTotalPages = computed(() => {
  if (!isBatch.value) return 1;
  return Math.max(1, Math.ceil((props.selectedProducts?.length || 0) / batchPageSize));
});

// 打开时重置状态 + 拉取支持字段
watch(
  () => props.open,
  async (v) => {
    if (!v) return;
    // 重置(默认勾选标题、描述)
    fieldState.name = { checked: true, value: '' };
    fieldState.description = { checked: true, value: '' };
    editingFields.name = false;
    editingFields.description = false;
    batchEditing.clear();
    previewData.value = null;
    cacheProfile.value = null;
    useBatchCacheMode.value = false;
    batchCacheData.value = new Map();
    batchPage.value = 1;
    // 拉取支持字段(后端可拓展)
    try {
      const r = await getSupportedFields();
      supportedFields.value = r?.fields || ['name', 'description'];
    } catch {
      supportedFields.value = ['name', 'description'];
    }
    // 单条模式:自动预览 Ozon 当前值 + 从 SKU 缓存自动填充更新内容
    if (!isBatch.value && currentStoreId.value && currentOfferId.value) {
      loadPreview();
      // 自动从缓存填充(失败静默,用户可手动点"从缓存获取"重试)
      try {
        await fillFromCache('name');
        await fillFromCache('description');
      } catch (e) { /* 静默:cacheProfile 已在 fillFromCache 内 toast */ }
    }
    // 批量模式:自动从缓存批量获取
    if (isBatch.value && props.selectedProducts?.length > 0 && currentStoreId.value) {
      fillBatchFromCache();
    }
  }
);

// 预览当前商品信息(单条模式)
async function loadPreview() {
  if (!currentStoreId.value || !currentOfferId.value) return;
  previewing.value = true;
  try {
    const r = await previewProductUpdate({
      storeId: currentStoreId.value,
      offerId: currentOfferId.value,
    });
    previewData.value = r;
    // 回填到输入框(用户可基于当前值编辑)
    if (fieldState.name.value === '' && r.name) fieldState.name.value = r.name;
    if (fieldState.description.value === '' && r.description) fieldState.description.value = r.description;
  } catch (e) {
    show(e.message || String(e), 'error');
    previewData.value = null;
  } finally {
    previewing.value = false;
  }
}

// 单条模式:从本地 SKU 缓存填充指定字段的值
// field: 'name' | 'description'
async function fillFromCache(field) {
  const offerId = props.singleItem?.offerId || '';
  const cacheSku = offerId ? String(offerId).split('-')[0] : '';
  if (!cacheSku) {
    show('缺少 offer_id,无法从缓存获取(仅单条模式可用)', 'error');
    return;
  }
  if (!cacheProfile.value) {
    fillingFromCache.value = true;
    try {
      const r = await getSkuProfile(cacheSku, currentStoreId.value);
      if (r?.error) {
        show(`缓存不可用:${r.error}`, 'error');
        return;
      }
      if (!r?.original) {
        show('该 SKU 无缓存数据', 'error');
        return;
      }
      cacheProfile.value = r.original;
    } catch (e) {
      show(e.message || String(e), 'error');
      return;
    } finally {
      fillingFromCache.value = false;
    }
  }
  const orig = cacheProfile.value;
  const FIELD_MAP = {
    name: orig.name || '',
    description: orig.description || '',
  };
  const val = FIELD_MAP[field];
  if (!val) {
    show(`缓存中「${fieldLabel(field)}」无值`, 'error');
    return;
  }
  fieldState[field].value = val;
  show(`已从缓存填充「${fieldLabel(field)}」`, 'success');
}

// 批量模式:从缓存批量获取所有商品的 name/description
async function fillBatchFromCache() {
  if (batchCacheLoading.value) return;
  const products = props.selectedProducts || [];
  if (!products.length) {
    show('未选中任何商品', 'error');
    return;
  }
  // 从 offerId 提取源 SKU(格式 {源Ozon数字SKU}-{MMDD}-qx)
  const skuMap = new Map(); // cacheSku -> [offerId, ...]
  for (const p of products) {
    const cacheSku = p.offerId ? String(p.offerId).split('-')[0] : '';
    if (!cacheSku) continue;
    if (!skuMap.has(cacheSku)) skuMap.set(cacheSku, []);
    skuMap.get(cacheSku).push(p.offerId);
  }
  const skus = Array.from(skuMap.keys());
  if (!skus.length) {
    show('无法从 offer_id 提取源 SKU', 'error');
    return;
  }
  batchCacheLoading.value = true;
  try {
    // 后端 batch 接口限制单次最多 200 个 SKU,这里分批调用
    const BATCH_SIZE = 200;
    const dataMap = new Map();
    let hitCount = 0;
    for (let i = 0; i < skus.length; i += BATCH_SIZE) {
      const chunk = skus.slice(i, i + BATCH_SIZE);
      const r = await getSkuProfileBatch(chunk, currentStoreId.value);
      const items = r?.items || [];
      for (const item of items) {
        const offerIds = skuMap.get(item.sku) || [];
        for (const oid of offerIds) {
          dataMap.set(oid, {
            name: item.name || '',
            description: item.description || '',
            sources: item.sources || {},
          });
          if (item.name || item.description) hitCount++;
        }
      }
    }
    batchCacheData.value = dataMap;
    useBatchCacheMode.value = true;
    // 自动勾选 name/description(如果缓存有值)
    if (!fieldState.name.checked && hitCount > 0) fieldState.name.checked = true;
    if (!fieldState.description.checked && hitCount > 0) fieldState.description.checked = true;
    show(`已批量获取缓存(${hitCount}/${products.length} 个命中)`, 'success');
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    batchCacheLoading.value = false;
  }
}

// 获取批量缓存中某个 offerId 的字段值
function getBatchCacheValue(offerId, field) {
  const d = batchCacheData.value.get(offerId);
  if (!d) return '';
  return d[field] || '';
}

// 缓存命中情况摘要(单条模式,展示在按钮 tooltip)
const cacheSourcesSummary = computed(() => {
  if (!cacheProfile.value) return '';
  const o = cacheProfile.value;
  const parts = [];
  if (o.name) parts.push('标题');
  if (o.description) parts.push('描述');
  return parts.length ? `缓存含:${parts.join('、')}` : '缓存已加载(字段为空)';
});

// 批量缓存命中摘要
const batchCacheSummary = computed(() => {
  if (!useBatchCacheMode.value || batchCacheData.value.size === 0) return '';
  let hitName = 0;
  let hitDesc = 0;
  for (const [, v] of batchCacheData.value) {
    if (v.name) hitName++;
    if (v.description) hitDesc++;
  }
  return `标题:${hitName}/${batchCacheData.value.size} 命中,描述:${hitDesc}/${batchCacheData.value.size} 命中`;
});

// 选中的字段列表
const checkedFields = computed(() => supportedFields.value.filter((f) => fieldState[f]?.checked));

// 提交校验 + 构造请求
async function submit() {
  if (submitting.value) return;
  const fields = checkedFields.value;
  if (fields.length === 0) {
    show('请至少勾选一个要更新的字段', 'error');
    return;
  }

  // 构造 items
  let items;
  if (isBatch.value) {
    if (!props.selectedProducts || props.selectedProducts.length === 0) {
      show('未选中任何商品', 'error');
      return;
    }
    if (useBatchCacheMode.value) {
      // 批量缓存模式:每个 item 携带各自的 newValues
      items = props.selectedProducts.map((p) => {
        const newValues = {};
        for (const f of fields) {
          const v = getBatchCacheValue(p.offerId, f);
          if (f === 'name' && !String(v).trim()) {
            // name 为空跳过此 item(不更新)
            newValues[f] = '';
          } else {
            newValues[f] = v;
          }
        }
        return {
          productId: String(p.productId),
          offerId: String(p.offerId || ''),
          storeId: String(p.storeId || ''),
          updateFields: fields,
          newValues,
        };
      }).filter((it) => {
        // 过滤掉 name/description 全空的 item(无缓存数据,无法更新)
        return fields.some((f) => String(it.newValues[f] || '').trim());
      });
      if (items.length === 0) {
        show('所有商品缓存均无值,无法更新(请先采集或改用统一文案模式)', 'error');
        return;
      }
      if (items.length < props.selectedProducts.length) {
        const skipped = props.selectedProducts.length - items.length;
        show(`跳过 ${skipped} 个无缓存值的商品,实际更新 ${items.length} 个`, 'success');
      }
    } else {
      // 统一文案模式:所有商品共用 newValues
      const newValues = {};
      for (const f of fields) {
        const v = fieldState[f]?.value ?? '';
        if (f === 'name' && !String(v).trim()) {
          show('标题不能为空', 'error');
          return;
        }
        newValues[f] = v;
      }
      items = props.selectedProducts.map((p) => ({
        productId: String(p.productId),
        offerId: String(p.offerId || ''),
        storeId: String(p.storeId || ''),
        updateFields: fields,
        newValues,
      }));
    }
  } else {
    const it = props.singleItem;
    if (!it || !it.productId || !it.storeId) {
      show('缺少 productId/storeId', 'error');
      return;
    }
    const newValues = {};
    for (const f of fields) {
      const v = fieldState[f]?.value ?? '';
      if (f === 'name' && !String(v).trim()) {
        show('标题不能为空', 'error');
        return;
      }
      newValues[f] = v;
    }
    items = [
      {
        productId: String(it.productId),
        offerId: String(it.offerId || ''),
        storeId: String(it.storeId || ''),
        updateFields: fields,
        newValues,
      },
    ];
  }

  submitting.value = true;
  try {
    const r = await createProductUpdate({
      storeId: currentStoreId.value,
      items,
    });
    show(`商品信息更新任务已创建(${items.length} 个商品)`, 'success');
    emit('submitted', r);
    emit('update:open', false);
    router.push('/product-update/' + encodeURIComponent(r.localTaskId));
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AppModal :open="open" title="商品信息更新" size="md" class="pu-modal-wide" @update:open="$emit('update:open', $event)">
    <div class="pu-dialog">
      <!-- 单条模式信息 -->
      <div v-if="!isBatch && singleItem" class="pu-info">
        <div class="meta-row">
          <span class="meta-k">SKU</span><span class="meta-v">{{ singleItem.offerId || '—' }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-k">商品 ID</span><span class="meta-v">{{ singleItem.productId }}</span>
        </div>
      </div>

      <!-- 批量模式信息 -->
      <div v-else-if="isBatch" class="pu-info">
        <div class="meta-row">
          <span class="meta-k">选中商品</span>
          <span class="meta-v">{{ selectedProducts.length }} 个</span>
        </div>
        <div class="muted" style="margin-top: 4px">
          批量模式:统一文案模式(所有商品相同字段值)或从缓存批量获取(每个商品各自的源 SKU 缓存值)
        </div>
      </div>

      <!-- 预览当前值(单条模式) -->
      <div v-if="!isBatch && previewData" class="pu-preview">
        <div class="preview-title">当前商品信息(来自 Ozon 实时数据)</div>
        <div class="preview-row"><span class="preview-k">当前标题</span><span class="preview-v">{{ previewData.name || '—' }}</span></div>
        <div class="preview-row"><span class="preview-k">当前价格</span><span class="preview-v">{{ previewData.price || '—' }} {{ previewData.currencyCode }}</span></div>
        <div class="preview-row preview-desc">
          <span class="preview-k">当前描述</span>
          <span class="preview-v preview-desc-text" v-if="previewData.description">
            <span
              v-for="(seg, i) in splitDescSegments(previewData.description)"
              :key="i"
              :class="seg.type === 'placeholder' ? 'desc-hl-placeholder' : (seg.type === 'chrome' ? 'desc-hl-chrome' : 'desc-hl-normal')"
            >{{ seg.text }}</span>
          </span>
          <span class="preview-v" v-else>—</span>
        </div>
        <div class="preview-desc-legend" v-if="previewData.description">
          <span class="legend-item"><span class="legend-dot desc-hl-placeholder"></span>占位文案</span>
          <span class="legend-item"><span class="legend-dot desc-hl-chrome"></span>需清洗(按钮污染)</span>
        </div>
      </div>

      <!-- 字段选择 + 输入 -->
      <div class="pu-fields">
        <div class="pu-field-title">选择要更新的字段:</div>

        <!-- 标题 -->
        <div class="pu-field-row">
          <label class="pu-checkbox">
            <input type="checkbox" v-model="fieldState.name.checked" />
            <span>标题</span>
          </label>
          <div v-if="fieldState.name.checked && !useBatchCacheMode" class="pu-field-content">
            <!-- 只读展示模式 -->
            <div v-if="!editingFields.name" class="pu-readonly-view">
              <div class="pu-readonly-text" :title="fieldState.name.value">{{ fieldState.name.value || '(空,待从缓存获取)' }}</div>
              <button class="btn btn-sm btn-ghost pu-action-btn" :disabled="submitting" @click="startEdit('name')">编辑</button>
            </div>
            <!-- 编辑模式:预填输入框 -->
            <div v-else class="pu-input-with-action">
              <input
                class="pu-input"
                v-model="fieldState.name.value"
                placeholder="输入新标题(统一文案)"
                :disabled="submitting"
              />
              <button
                v-if="!isBatch && (props.singleItem?.offerId)"
                class="btn btn-sm btn-ghost pu-cache-btn"
                :disabled="fillingFromCache || submitting"
                :title="cacheSourcesSummary || '从本地采集缓存填充标题'"
                @click="fillFromCache('name')"
              >{{ fillingFromCache ? '读取中…' : '从缓存获取' }}</button>
              <button class="btn btn-sm btn-primary pu-action-btn" :disabled="submitting" @click="finishEdit('name')">完成</button>
            </div>
          </div>
        </div>

        <!-- 描述 -->
        <div class="pu-field-row">
          <label class="pu-checkbox">
            <input type="checkbox" v-model="fieldState.description.checked" />
            <span>描述</span>
          </label>
          <div v-if="fieldState.description.checked && !useBatchCacheMode" class="pu-field-content">
            <!-- 只读展示模式:带高亮 -->
            <div v-if="!editingFields.description" class="pu-readonly-view pu-readonly-desc">
              <div class="pu-readonly-desc-text">
                <template v-if="fieldState.description.value">
                  <span
                    v-for="(seg, i) in splitDescSegments(fieldState.description.value)"
                    :key="i"
                    :class="seg.type === 'placeholder' ? 'desc-hl-placeholder' : (seg.type === 'chrome' ? 'desc-hl-chrome' : 'desc-hl-normal')"
                  >{{ seg.text }}</span>
                </template>
                <span v-else class="muted">(空,待从缓存获取)</span>
              </div>
              <button class="btn btn-sm btn-ghost pu-action-btn" :disabled="submitting" @click="startEdit('description')">编辑</button>
            </div>
            <!-- 编辑模式:普通 textarea(文字可见可编辑) -->
            <div v-else class="pu-input-with-action">
              <textarea
                class="pu-textarea"
                v-model="fieldState.description.value"
                placeholder="输入新描述(统一文案,支持多行)"
                rows="8"
                :disabled="submitting"
              ></textarea>
              <button
                v-if="!isBatch && (props.singleItem?.offerId)"
                class="btn btn-sm btn-ghost pu-cache-btn"
                :disabled="fillingFromCache || submitting"
                :title="cacheSourcesSummary || '从本地采集缓存填充描述'"
                @click="fillFromCache('description')"
              >{{ fillingFromCache ? '读取中…' : '从缓存获取' }}</button>
              <button class="btn btn-sm btn-primary pu-action-btn" :disabled="submitting" @click="finishEdit('description')">完成</button>
            </div>
          </div>
        </div>

        <!-- 批量模式:从缓存批量获取按钮 -->
        <div v-if="isBatch && checkedFields.length > 0" class="pu-batch-cache">
          <button
            class="btn btn-sm btn-primary"
            :disabled="batchCacheLoading || submitting"
            @click="fillBatchFromCache"
          >{{ batchCacheLoading ? '批量获取中…' : (useBatchCacheMode ? '重新批量获取' : '从缓存批量获取') }}</button>
          <span v-if="batchCacheSummary" class="pu-batch-summary">{{ batchCacheSummary }}</span>
          <label v-if="useBatchCacheMode" class="pu-checkbox pu-mode-toggle">
            <input type="checkbox" v-model="useBatchCacheMode" />
            <span class="muted">使用缓存值(取消则回到统一文案模式)</span>
          </label>
        </div>

        <!-- 批量缓存模式:分页预览(卡片式,每页3个) -->
        <div v-if="isBatch && useBatchCacheMode && batchCacheData.size > 0" class="pu-batch-table">
          <div class="pu-batch-table-title">
            缓存值预览(可编辑) — 第 {{ batchPage }}/{{ batchTotalPages }} 页
          </div>
          <div v-for="p in batchPagedItems" :key="p.offerId" class="pu-batch-card">
            <div class="pu-batch-card-head">
              <span class="pu-batch-card-offer">{{ p.offerId }}</span>
              <span v-if="!getBatchCacheValue(p.offerId, 'name') && !getBatchCacheValue(p.offerId, 'description')" class="pu-batch-card-empty">无缓存</span>
            </div>
            <div v-if="fieldState.name.checked" class="pu-batch-field">
              <label class="pu-batch-field-label">标题</label>
              <div v-if="!isBatchEditing(p.offerId, 'name')" class="pu-readonly-view">
                <div class="pu-readonly-text" :title="getBatchCacheValue(p.offerId, 'name')">{{ getBatchCacheValue(p.offerId, 'name') || '(无缓存)' }}</div>
                <button class="btn btn-sm btn-ghost pu-action-btn" @click="startBatchEdit(p.offerId, 'name')">编辑</button>
              </div>
              <div v-else class="pu-readonly-view">
                <input
                  class="pu-input pu-batch-name-input"
                  :value="getBatchCacheValue(p.offerId, 'name')"
                  @input="(e) => { const d = batchCacheData.get(p.offerId); if (d) { d.name = e.target.value; batchCacheData.value = new Map(batchCacheData.value); } }"
                  placeholder="(无缓存)"
                />
                <button class="btn btn-sm btn-primary pu-action-btn" @click="finishBatchEdit(p.offerId, 'name')">完成</button>
              </div>
            </div>
            <div v-if="fieldState.description.checked" class="pu-batch-field">
              <label class="pu-batch-field-label">描述</label>
              <div v-if="!isBatchEditing(p.offerId, 'description')" class="pu-readonly-view pu-readonly-desc">
                <div class="pu-readonly-desc-text">
                  <template v-if="getBatchCacheValue(p.offerId, 'description')">
                    <span
                      v-for="(seg, i) in splitDescSegments(getBatchCacheValue(p.offerId, 'description'))"
                      :key="i"
                      :class="seg.type === 'placeholder' ? 'desc-hl-placeholder' : (seg.type === 'chrome' ? 'desc-hl-chrome' : 'desc-hl-normal')"
                    >{{ seg.text }}</span>
                  </template>
                  <span v-else class="muted">(无缓存)</span>
                </div>
                <button class="btn btn-sm btn-ghost pu-action-btn" @click="startBatchEdit(p.offerId, 'description')">编辑</button>
              </div>
              <div v-else class="pu-batch-desc-edit-wrap">
                <textarea
                  class="pu-textarea pu-batch-desc-input"
                  :value="getBatchCacheValue(p.offerId, 'description')"
                  @input="(e) => { const d = batchCacheData.get(p.offerId); if (d) { d.description = e.target.value; batchCacheData.value = new Map(batchCacheData.value); } }"
                  placeholder="(无缓存)"
                  rows="6"
                ></textarea>
                <button class="btn btn-sm btn-primary pu-batch-finish-btn" @click="finishBatchEdit(p.offerId, 'description')">完成</button>
              </div>
            </div>
          </div>
          <!-- 分页控件 -->
          <div v-if="batchTotalPages > 1" class="pu-batch-pager">
            <button class="btn btn-sm btn-ghost" :disabled="batchPage <= 1" @click="batchPage--">上一页</button>
            <span class="muted">{{ batchPage }} / {{ batchTotalPages }}</span>
            <button class="btn btn-sm btn-ghost" :disabled="batchPage >= batchTotalPages" @click="batchPage++">下一页</button>
          </div>
        </div>

        <!-- 占位:后续可拓展的价格/重量等字段 -->
        <div class="pu-field-row pu-disabled">
          <label class="pu-checkbox">
            <input type="checkbox" disabled />
            <span class="muted">价格(本期待实现)</span>
          </label>
        </div>
        <div class="pu-field-row pu-disabled">
          <label class="pu-checkbox">
            <input type="checkbox" disabled />
            <span class="muted">重量/尺寸(本期待实现)</span>
          </label>
        </div>
      </div>

      <!-- 提示 -->
      <div class="pu-tip muted">
        统一走 /v3/product/import 全量重传:从 Ozon 实时拉完整商品数据,只替换勾选的字段,其他字段保留当前值。
      </div>

      <div class="pu-actions">
        <button class="btn btn-ghost" :disabled="submitting" @click="$emit('update:open', false)">取消</button>
        <button
          v-if="!isBatch && currentStoreId && currentOfferId"
          class="btn btn-ghost"
          :disabled="previewing || submitting"
          @click="loadPreview"
        >
          {{ previewing ? '加载中…' : '预览当前值' }}
        </button>
        <button class="btn btn-primary" :disabled="submitting || checkedFields.length === 0" @click="submit">
          {{ submitting ? '提交中…' : '提交任务' }}
        </button>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
/* 弹窗宽度加宽到 2 倍(960px),便于查看完整描述 */
.pu-modal-wide :deep(.modal-card) {
  width: 960px;
  max-width: calc(100vw - 32px);
}
.pu-dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.pu-info {
  background: #f7f8fa;
  border-radius: 6px;
  padding: 12px;
}
.meta-row {
  display: flex;
  gap: 8px;
  font-size: 13px;
  line-height: 1.8;
}
.meta-k {
  color: #888;
  min-width: 72px;
}
.meta-v {
  color: #333;
  word-break: break-all;
}
.pu-preview {
  background: #fffbe6;
  border: 1px solid #ffe58f;
  border-radius: 6px;
  padding: 10px;
}
.preview-title {
  font-size: 12px;
  color: #888;
  margin-bottom: 6px;
}
.preview-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}
.preview-k {
  color: #888;
  min-width: 60px;
}
.preview-v {
  color: #333;
  word-break: break-all;
}
.preview-desc {
  align-items: flex-start;
}
/* 当前描述完整展示(保留换行)+ 高亮 */
.preview-desc-text {
  white-space: pre-wrap;
  word-break: break-word;
  display: block;
  max-height: 320px;
  overflow-y: auto;
  padding: 6px 8px;
  background: #fafafa;
  border-radius: 4px;
}
.desc-hl-placeholder {
  color: #ff4d4f;
  background: #fff1f0;
  font-weight: 600;
}
.desc-hl-chrome {
  color: #ff4d4f;
  background: #fff7e6;
  font-weight: 600;
}
.desc-hl-normal {
  color: #333;
}

/* 批量模式描述编辑容器 */
.pu-batch-desc-edit-wrap {
  width: 100%;
}

/* 字段内容容器 */
.pu-field-content {
  flex: 1;
  min-width: 0;
}
/* 只读展示 + 编辑按钮 */
.pu-readonly-view {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
}
.pu-readonly-text {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 4px;
  font-size: 13px;
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-height: 32px;
}
.pu-readonly-desc {
  flex-direction: column;
}
.pu-readonly-desc-text {
  padding: 6px 8px;
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
  margin-bottom: 6px;
}
.pu-action-btn {
  flex-shrink: 0;
  align-self: flex-start;
}
.pu-batch-finish-btn {
  margin-top: 6px;
}
/* 图例 */
.preview-desc-legend {
  display: flex;
  gap: 16px;
  margin-top: 6px;
  font-size: 11px;
  color: #999;
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.pu-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pu-field-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}
.pu-field-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pu-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}
.pu-checkbox input[type='checkbox'] {
  margin: 0;
}
.pu-input {
  padding: 6px 8px;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  font-size: 13px;
}
.pu-textarea {
  padding: 6px 8px;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  font-size: 13px;
  resize: vertical;
  font-family: inherit;
}
.pu-input-with-action {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.pu-input-with-action .pu-input,
.pu-input-with-action .pu-textarea {
  flex: 1;
  min-width: 0;
}
.pu-cache-btn {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 12px;
  padding: 5px 10px;
  align-self: flex-start;
  margin-top: 1px;
}
.pu-disabled {
  opacity: 0.6;
}
.pu-disabled .pu-checkbox {
  cursor: not-allowed;
}
.pu-batch-cache {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  padding: 8px;
  background: #f0f5ff;
  border-radius: 4px;
  border: 1px solid #adc6ff;
}
.pu-batch-summary {
  font-size: 12px;
  color: #52c41a;
}
.pu-mode-toggle {
  margin-left: auto;
  font-size: 12px;
}
.pu-batch-table {
  border: 1px solid #e8e8e8;
  border-radius: 4px;
  overflow: hidden;
}
.pu-batch-table-title {
  font-size: 12px;
  color: #666;
  padding: 6px 10px;
  background: #fafafa;
  border-bottom: 1px solid #e8e8e8;
}
/* 卡片式:每页3个,垂直堆叠,标题/描述分行展示更宽更长 */
.pu-batch-card {
  padding: 10px 12px;
  border-bottom: 1px solid #f0f0f0;
}
.pu-batch-card:last-of-type {
  border-bottom: none;
}
.pu-batch-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.pu-batch-card-offer {
  font-size: 12px;
  color: #555;
  font-weight: 600;
  word-break: break-all;
}
.pu-batch-card-empty {
  font-size: 11px;
  color: #ff4d4f;
  background: #fff1f0;
  padding: 1px 6px;
  border-radius: 2px;
}
.pu-batch-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}
.pu-batch-field:last-child {
  margin-bottom: 0;
}
.pu-batch-field-label {
  font-size: 11px;
  color: #999;
}
.pu-batch-name-input {
  font-size: 13px;
  padding: 6px 8px;
  width: 100%;
}
.pu-batch-desc-input {
  font-size: 12px;
  padding: 6px 8px;
  width: 100%;
  line-height: 1.6;
  resize: vertical;
  min-height: 120px;
}
.pu-batch-pager {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  padding: 6px;
  background: #fafafa;
}
.pu-tip {
  font-size: 12px;
  color: #999;
  line-height: 1.6;
  background: #f7f8fa;
  padding: 8px;
  border-radius: 4px;
}
.pu-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.muted {
  color: #999;
}
</style>
