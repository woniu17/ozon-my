<script setup>
// 库存更新弹窗(2026-07)
// 单条模式:对单个商品设置库存
// 批量模式:对多个商品批量设置统一库存值
import { ref, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import { createStockRefresh } from '../api/stockRefresh.js';
import { useToast } from './useToast.js';
import AppModal from './AppModal.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  // 'single' | 'batch'
  mode: { type: String, default: 'single' },
  // single 模式:{ productId, storeId, offerId? }
  singleItem: { type: Object, default: null },
  // batch 模式:[{ productId, storeId }]
  selectedProducts: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:open', 'submitted']);

const router = useRouter();
const { show } = useToast();

const STOCK_LS_KEY = 'stockRefresh.lastStockValue';
const stockValue = ref(localStorage.getItem(STOCK_LS_KEY) || '10');
const submitting = ref(false);

const isBatch = computed(() => props.mode === 'batch');

// 打开时回填上次库存值
watch(
  () => props.open,
  (v) => {
    if (!v) return;
    const last = localStorage.getItem(STOCK_LS_KEY);
    stockValue.value = last || '10';
  }
);

async function submit() {
  if (submitting.value) return;
  const sv = Number(stockValue.value);
  if (!Number.isInteger(sv) || sv < 0) {
    show('库存值必须为非负整数', 'error');
    return;
  }
  submitting.value = true;
  try {
    let body;
    if (isBatch.value) {
      if (!props.selectedProducts || props.selectedProducts.length === 0) {
        show('未选中任何商品', 'error');
        submitting.value = false;
        return;
      }
      body = {
        products: props.selectedProducts.map((p) => ({ productId: p.productId, storeId: p.storeId })),
        stockValue: sv,
      };
    } else {
      const it = props.singleItem;
      if (!it || !it.productId || !it.storeId) {
        show('缺少 productId/storeId', 'error');
        submitting.value = false;
        return;
      }
      body = {
        items: [{ productId: it.productId, storeId: it.storeId, offerId: it.offerId }],
        stockValue: sv,
      };
    }
    const r = await createStockRefresh(body);
    localStorage.setItem(STOCK_LS_KEY, String(sv));
    show('库存更新任务已创建', 'success');
    emit('submitted', r);
    emit('update:open', false);
    router.push('/stock-refresh/' + encodeURIComponent(r.localTaskId));
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AppModal :open="open" title="更新库存" size="md" @update:open="$emit('update:open', $event)">
    <div class="sr-dialog">
      <!-- 单条模式信息 -->
      <div v-if="!isBatch && singleItem" class="sr-info">
        <div class="meta-row">
          <span class="meta-k">商品 ID</span><span class="meta-v">{{ singleItem.productId }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-k">SKU</span><span class="meta-v">{{ singleItem.offerId || '—' }}</span>
        </div>
      </div>

      <!-- 批量模式信息 -->
      <div v-else-if="isBatch" class="sr-info">
        <div class="meta-row">
          <span class="meta-k">选中商品</span>
          <span class="meta-v">{{ selectedProducts.length }} 个</span>
        </div>
        <div class="muted" style="margin-top: 4px">
          为选中的每个商品设置统一库存值,异步提交到 Ozon(串行处理,避免触发限流)
        </div>
      </div>

      <!-- 库存值输入 -->
      <div class="sr-field">
        <label class="sr-label">库存数量</label>
        <input
          class="filter-input"
          type="number"
          min="0"
          step="1"
          v-model="stockValue"
          placeholder="请输入库存数量(非负整数)"
        />
        <div class="muted" style="margin-top: 4px">
          仓库:自动使用商品所属店铺配置的 warehouse_id
        </div>
      </div>

      <div class="sr-actions">
        <button class="btn btn-ghost" :disabled="submitting" @click="$emit('update:open', false)">取消</button>
        <button class="btn btn-primary" :disabled="submitting" @click="submit">
          {{ submitting ? '提交中...' : '提交' }}
        </button>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.sr-dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.sr-info {
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
.sr-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sr-label {
  font-size: 13px;
  font-weight: 500;
  color: #333;
}
.sr-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.muted {
  color: #999;
  font-size: 12px;
}
</style>
