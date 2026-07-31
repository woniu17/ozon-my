<script setup>
// 商品信息更新弹窗(2026-07)
// 单条模式:对单个商品更新标题/描述等字段,可预览当前值
// 批量模式:对多个商品统一更新相同字段(同文案)
// 统一走 /v3/product/import 全量重传,字段驱动(FieldUpdater 可拓展)
import { ref, watch, computed, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { createProductUpdate, previewProductUpdate, getSupportedFields } from '../api/productUpdate.js';
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
// 当前预览到的商品信息
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

// 各字段勾选状态 + 新值
const fieldState = reactive({
  name: { checked: false, value: '' },
  description: { checked: false, value: '' },
});

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

// 打开时重置状态 + 拉取支持字段
watch(
  () => props.open,
  async (v) => {
    if (!v) return;
    // 重置
    fieldState.name = { checked: false, value: '' };
    fieldState.description = { checked: false, value: '' };
    previewData.value = null;
    // 拉取支持字段(后端可拓展)
    try {
      const r = await getSupportedFields();
      supportedFields.value = r?.fields || ['name', 'description'];
    } catch {
      supportedFields.value = ['name', 'description'];
    }
    // 单条模式自动预览当前值
    if (!isBatch.value && currentStoreId.value && currentOfferId.value) {
      loadPreview();
    }
  }
);

// 预览当前商品信息
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
  // 构造 newValues
  const newValues = {};
  for (const f of fields) {
    const v = fieldState[f]?.value ?? '';
    if (f === 'name' && !String(v).trim()) {
      show('标题不能为空', 'error');
      return;
    }
    newValues[f] = v;
  }

  // 构造 items
  let items;
  if (isBatch.value) {
    if (!props.selectedProducts || props.selectedProducts.length === 0) {
      show('未选中任何商品', 'error');
      return;
    }
    items = props.selectedProducts.map((p) => ({
      productId: String(p.productId),
      offerId: String(p.offerId || ''),
      updateFields: fields,
      newValues,
    }));
  } else {
    const it = props.singleItem;
    if (!it || !it.productId || !it.storeId) {
      show('缺少 productId/storeId', 'error');
      return;
    }
    items = [
      {
        productId: String(it.productId),
        offerId: String(it.offerId || ''),
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
  <AppModal :open="open" title="商品信息更新" size="md" @update:open="$emit('update:open', $event)">
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
          批量模式:所有选中的商品将统一更新为相同的字段值
        </div>
      </div>

      <!-- 预览当前值(单条模式) -->
      <div v-if="!isBatch && previewData" class="pu-preview">
        <div class="preview-title">当前商品信息(来自 Ozon 实时数据)</div>
        <div class="preview-row"><span class="preview-k">当前标题</span><span class="preview-v">{{ previewData.name || '—' }}</span></div>
        <div class="preview-row"><span class="preview-k">当前价格</span><span class="preview-v">{{ previewData.price || '—' }} {{ previewData.currencyCode }}</span></div>
        <div class="preview-row preview-desc">
          <span class="preview-k">当前描述</span>
          <span class="preview-v">{{ previewData.description ? (previewData.description.length > 120 ? previewData.description.slice(0, 120) + '…' : previewData.description) : '—' }}</span>
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
          <input
            v-if="fieldState.name.checked"
            class="pu-input"
            v-model="fieldState.name.value"
            placeholder="输入新标题"
            :disabled="submitting"
          />
        </div>

        <!-- 描述 -->
        <div class="pu-field-row">
          <label class="pu-checkbox">
            <input type="checkbox" v-model="fieldState.description.checked" />
            <span>描述</span>
          </label>
          <textarea
            v-if="fieldState.description.checked"
            class="pu-textarea"
            v-model="fieldState.description.value"
            placeholder="输入新描述(支持多行)"
            rows="5"
            :disabled="submitting"
          ></textarea>
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
.pu-disabled {
  opacity: 0.6;
}
.pu-disabled .pu-checkbox {
  cursor: not-allowed;
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
