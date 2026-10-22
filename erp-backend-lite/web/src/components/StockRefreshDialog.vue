<script setup>
// 库存更新弹窗(2026-07)
// 单条模式:对单个商品设置库存
// 批量模式:对多个商品批量设置统一库存值
// 2026-10:支持选择目标仓库(仅当全部商品属于同一店铺时;跨店铺按各店铺默认仓库执行)
import { ref, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import { createStockRefresh } from '../api/stockRefresh.js';
import { getStoreWarehouses } from '../api/stores.js';
import { useStoresStore } from '../stores/stores.js';
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
const storesStore = useStoresStore();

const STOCK_LS_KEY = 'stockRefresh.lastStockValue';
const stockValue = ref(localStorage.getItem(STOCK_LS_KEY) || '10');
const submitting = ref(false);

// ── 仓库选择状态 ──
const targetStoreId = ref(''); // 弹窗涉及的目标店铺(全部商品同店时才有值)
const multiStore = ref(false); // 是否跨店铺(跨店铺不提供仓库选择)
const warehouseOptions = ref([]); // [{ id, name, meta? }]
const warehouseId = ref(''); // 当前选中的仓库 ID
const warehouseLoading = ref(false);
const warehouseError = ref('');

const isBatch = computed(() => props.mode === 'batch');

// 打开时回填上次库存值 + 初始化仓库选择
watch(
  () => props.open,
  async (v) => {
    if (!v) return;
    const last = localStorage.getItem(STOCK_LS_KEY);
    stockValue.value = last || '10';

    // 重置仓库选择状态
    targetStoreId.value = '';
    multiStore.value = false;
    warehouseOptions.value = [];
    warehouseId.value = '';
    warehouseLoading.value = false;
    warehouseError.value = '';

    // 解析目标店铺:单条取 singleItem.storeId;批量取 selectedProducts 的唯一 storeId
    let storeId = '';
    if (props.mode === 'single') {
      storeId = props.singleItem?.storeId || '';
    } else {
      const ids = [...new Set((props.selectedProducts || []).map((p) => p.storeId).filter(Boolean))];
      if (ids.length === 1) storeId = ids[0];
      else if (ids.length > 1) multiStore.value = true;
    }
    if (!storeId) return;
    targetStoreId.value = storeId;

    // 确保店铺列表已加载(拿默认 warehouse_id)
    if (!storesStore.list.length) {
      try {
        await storesStore.load();
      } catch {
        /* 忽略,仓库下拉仍可尝试拉取 */
      }
    }
    const store = storesStore.findStore(storeId);
    const defaultWid = store?.warehouse_id ? String(store.warehouse_id) : '';

    // 拉取该店铺的真实仓库列表
    warehouseLoading.value = true;
    try {
      const r = await getStoreWarehouses(storeId);
      const result = r || {};
      if (result.success) {
        const items = (result.warehouses || []).map((w) => ({
          id: String(w.warehouse_id ?? w.id ?? ''),
          name: w.name || '(未命名)',
          meta: [w.warehouse_type || null, w.status || null, w.is_rfbs ? 'RFBS' : null].filter(Boolean).join(' · '),
        })).filter((w) => w.id);
        // 默认仓库(店铺配置的 warehouse_id)若不在 OPI 返回列表中,补一个"默认仓库"选项
        if (defaultWid && !items.some((w) => w.id === defaultWid)) {
          items.unshift({ id: defaultWid, name: '默认仓库', meta: '' });
        }
        warehouseOptions.value = items;
        // 默认选中店铺配置的默认仓库(若用户之前选过其他仓库,本次仍以默认仓库为初始值)
        warehouseId.value = defaultWid || (items[0]?.id || '');
      } else {
        warehouseError.value = result.error || '仓库列表拉取失败';
      }
    } catch (e) {
      warehouseError.value = e.message || String(e);
    } finally {
      warehouseLoading.value = false;
    }
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
    // 仅当全部商品同店且已确定目标仓库时,才随任务提交 warehouseId;否则按各店铺默认仓库
    const useWarehouse = !!targetStoreId.value && !multiStore.value && !!warehouseId.value;
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
    if (useWarehouse) body.warehouseId = warehouseId.value;
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
      </div>

      <!-- 仓库选择:全部商品同店时可选;跨店铺按各店铺默认仓库 -->
      <div v-if="targetStoreId && !multiStore" class="sr-field">
        <label class="sr-label">目标仓库</label>
        <select v-if="warehouseOptions.length" v-model="warehouseId" class="filter-select">
          <option v-for="w in warehouseOptions" :key="w.id" :value="w.id">
            {{ w.name }}{{ w.meta ? ' · ' + w.meta : '' }}（{{ w.id }}）
          </option>
        </select>
        <div v-else-if="warehouseLoading" class="muted">仓库列表加载中…</div>
        <div v-else class="muted">仓库列表不可用:{{ warehouseError || '将使用店铺默认仓库' }}</div>
        <div class="muted" style="margin-top: 4px">
          {{ warehouseOptions.length ? '库存将更新到所选仓库;默认使用店铺配置的默认仓库' : '未指定仓库时按店铺默认仓库执行' }}
        </div>
      </div>
      <div v-else-if="multiStore" class="muted">跨店铺任务:将按各店铺默认仓库执行</div>

      <div class="sr-actions">
        <button class="btn btn-ghost" :disabled="submitting" @click="$emit('update:open', false)">取消</button>
        <button class="btn btn-primary" :disabled="submitting" @click="submit">
          {{ submitting ? '提交中…' : '提交' }}
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