<script setup>
// 商品归档弹窗(2026-08)
// 高危操作:归档后商品在 Ozon 后台移入归档区,买家不可见,可通过 /v1/product/unarchive 恢复
// 三种模式:
//   single  — 单条归档(列表行操作)
//   batch   — 批量归档(列表勾选)
//   filter  — 按筛选归档(后端直接接收筛选条件展开,前端预拉 count 展示)
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { createProductArchive } from '../api/productArchive.js';
import { useToast } from './useToast.js';
import { useConfirmStore } from '../stores/confirm.js';
import AppModal from './AppModal.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  // 'single' | 'batch' | 'filter'
  mode: { type: String, default: 'single' },
  // single 模式:{ productId, storeId, offerId? }
  singleItem: { type: Object, default: null },
  // batch 模式:[{ productId, storeId, offerId? }]
  selectedProducts: { type: Array, default: () => [] },
  // filter 模式:筛选条件对象 { storeId, keyword, productStatus, hasStock, imageIssue, descriptionQuality }
  filters: { type: Object, default: () => ({}) },
  // filter 模式:预计算的匹配商品数量(父组件预拉)
  filterCount: { type: Number, default: 0 },
});
const emit = defineEmits(['update:open', 'submitted']);

const router = useRouter();
const { show } = useToast();
const confirmStore = useConfirmStore();
const submitting = ref(false);

// 当前模式下的商品数量
const count = computed(() => {
  if (props.mode === 'single') return props.singleItem ? 1 : 0;
  if (props.mode === 'batch') return props.selectedProducts?.length || 0;
  if (props.mode === 'filter') return props.filterCount || 0;
  return 0;
});

// 打开时重置提交状态
watch(
  () => props.open,
  (v) => {
    if (v) submitting.value = false;
  }
);

async function submit() {
  if (submitting.value) return;
  if (count.value === 0) {
    show('无可用商品', 'error');
    return;
  }

  // 二次确认:归档是高危操作,需用户明确确认
  const confirmed = await confirmStore.ask({
    title: '确认归档商品',
    message: `即将归档 ${count.value} 个商品。归档后商品在 Ozon 后台移入归档区,买家不可见。此操作可通过 Ozon 后台或 /v1/product/unarchive 恢复。是否继续?`,
    danger: true,
    confirmText: '确认归档',
  });
  if (!confirmed) return;

  submitting.value = true;
  try {
    let body;
    if (props.mode === 'filter') {
      // filter 模式:直接传筛选条件给后端展开
      body = { filters: props.filters };
    } else if (props.mode === 'batch') {
      body = {
        products: props.selectedProducts.map((p) => ({ productId: p.productId, storeId: p.storeId })),
      };
    } else {
      // single 模式
      const it = props.singleItem;
      if (!it || !it.productId || !it.storeId) {
        show('缺少 productId/storeId', 'error');
        submitting.value = false;
        return;
      }
      body = { items: [{ productId: it.productId, storeId: it.storeId, offerId: it.offerId }] };
    }
    const r = await createProductArchive(body);
    show(`归档任务已创建(${r.totalCount} 个商品)`, 'success');
    emit('submitted', r);
    emit('update:open', false);
    router.push('/product-archive/' + encodeURIComponent(r.localTaskId));
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AppModal :open="open" title="商品归档" size="md" @update:open="$emit('update:open', $event)">
    <div class="pa-dialog">
      <!-- 单条模式信息 -->
      <div v-if="mode === 'single' && singleItem" class="pa-info">
        <div class="meta-row">
          <span class="meta-k">商品 ID</span><span class="meta-v">{{ singleItem.productId }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-k">SKU</span><span class="meta-v">{{ singleItem.offerId || '—' }}</span>
        </div>
      </div>

      <!-- 批量模式信息 -->
      <div v-else-if="mode === 'batch'" class="pa-info">
        <div class="meta-row">
          <span class="meta-k">选中商品</span>
          <span class="meta-v">{{ selectedProducts.length }} 个</span>
        </div>
      </div>

      <!-- 按筛选模式信息 -->
      <div v-else-if="mode === 'filter'" class="pa-info">
        <div class="meta-row">
          <span class="meta-k">筛选匹配</span>
          <span class="meta-v">{{ filterCount }} 个商品</span>
        </div>
        <div class="muted" style="margin-top: 4px">
          后端将根据当前筛选条件展开为 product_id 列表,逐批提交归档(每批最多 100 个)
        </div>
      </div>

      <!-- 危险操作提示 -->
      <div class="pa-warning">
        <div class="pa-warning-title">⚠️ 高危操作</div>
        <div class="pa-warning-text">
          归档后商品在 Ozon 后台移入归档区,买家不可见。此操作可通过 Ozon 后台或 /v1/product/unarchive 恢复。
        </div>
      </div>

      <div class="pa-actions">
        <button class="btn btn-ghost" :disabled="submitting" @click="$emit('update:open', false)">取消</button>
        <button class="btn btn-danger" :disabled="submitting || count === 0" @click="submit">
          {{ submitting ? '提交中…' : `确认归档(${count})` }}
        </button>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.pa-dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.pa-info {
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
.pa-warning {
  background: #fff1f0;
  border: 1px solid #ffa39e;
  border-radius: 6px;
  padding: 10px 12px;
}
.pa-warning-title {
  font-size: 13px;
  font-weight: 600;
  color: #cf1322;
  margin-bottom: 4px;
}
.pa-warning-text {
  font-size: 12px;
  color: #5c0011;
  line-height: 1.6;
}
.pa-actions {
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
