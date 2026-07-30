<script setup>
// 图片更新弹窗(2026-07)
// 单条模式:对单个商品重提图片,可编辑图片 URL
// 批量模式:对多条上架记录批量重提图片,后端按记录展开图片问题 items
import { ref, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import { createImageRefresh } from '../api/imageRefresh.js';
import { getListingTemplates } from '../api/listingTemplates.js';
import { useToast } from './useToast.js';
import AppModal from './AppModal.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  // 'single' | 'batch'
  mode: { type: String, default: 'single' },
  // single 模式:{ sourceTaskId, offerId, productId, storeId }
  singleItem: { type: Object, default: null },
  // batch 模式:[{ localTaskId, storeId }]
  selectedRecords: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:open', 'submitted']);

const router = useRouter();
const { show } = useToast();

const templates = ref([]);
const templateId = ref(''); // '' = 不加工直接重提源图
const submitting = ref(false);
// 单条模式:图片 URL 列表(可编辑,每行一个)
const imageLines = ref('');

const isBatch = computed(() => props.mode === 'batch');

// 打开时加载模板列表
watch(
  () => props.open,
  async (v) => {
    if (!v) return;
    imageLines.value = '';
    templateId.value = '';
    try {
      const data = await getListingTemplates();
      templates.value = Array.isArray(data) ? data : data?.items || [];
    } catch (e) {
      templates.value = [];
    }
  }
);

async function submit() {
  if (submitting.value) return;
  submitting.value = true;
  try {
    let body;
    if (isBatch.value) {
      if (!props.selectedRecords.length) {
        show('未选中任何记录', 'error');
        submitting.value = false;
        return;
      }
      body = {
        records: props.selectedRecords.map((r) => ({ sourceTaskId: r.localTaskId, storeId: r.storeId })),
        templateId: templateId.value ? Number(templateId.value) : null,
      };
    } else {
      const it = props.singleItem;
      if (!it || !it.productId || !it.storeId) {
        show('缺少 productId/storeId', 'error');
        submitting.value = false;
        return;
      }
      // 解析图片 URL(按换行/逗号分隔,过滤空行)
      const urls = imageLines.value
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      body = {
        items: [
          {
            sourceTaskId: it.sourceTaskId,
            offerId: it.offerId,
            productId: it.productId,
            storeId: it.storeId,
            sourceImages: urls.length > 0 ? urls : undefined,
          },
        ],
        templateId: templateId.value ? Number(templateId.value) : null,
      };
    }
    const r = await createImageRefresh(body);
    show('图片更新任务已创建', 'success');
    emit('submitted', r);
    emit('update:open', false);
    router.push('/image-refresh/' + encodeURIComponent(r.localTaskId));
  } catch (e) {
    show(e.message || String(e), 'error');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <AppModal :open="open" title="更新图片" size="md" @update:open="$emit('update:open', $event)">
    <div class="ir-dialog">
      <!-- 单条模式信息 -->
      <div v-if="!isBatch && singleItem" class="ir-info">
        <div class="meta-row">
          <span class="meta-k">商品 ID</span><span class="meta-v">{{ singleItem.productId }}</span>
        </div>
        <div class="meta-row">
          <span class="meta-k">SKU</span><span class="meta-v">{{ singleItem.offerId || '—' }}</span>
        </div>
      </div>

      <!-- 批量模式信息 -->
      <div v-else-if="isBatch" class="ir-info">
        <div class="meta-row">
          <span class="meta-k">选中记录</span>
          <span class="meta-v">{{ selectedRecords.length }} 条</span>
        </div>
        <div class="muted" style="margin-top: 4px">
          后端将自动展开每条记录中"图片有问题"的 item(审核拒绝/无效图),非图片问题 item 会被跳过
        </div>
      </div>

      <!-- 模板选择 -->
      <div class="ir-field">
        <label class="ir-label">上架模板(图片加工)</label>
        <select class="filter-select" v-model="templateId">
          <option value="">不加工(直接重提源图)</option>
          <option v-for="t in templates" :key="t.id" :value="t.id">
            {{ t.name }}{{ t.applyWatermark ? '(含水印)' : '' }}
          </option>
        </select>
        <div class="muted" style="margin-top: 4px">
          选择模板后将重新走水印加工链(从 raw payload 读原图);不加工则直接重提 transformed 已加工图
        </div>
      </div>

      <!-- 单条模式:图片 URL 编辑 -->
      <div v-if="!isBatch" class="ir-field">
        <label class="ir-label">图片 URL(可选,留空则自动读取源图)</label>
        <textarea
          class="ir-textarea"
          v-model="imageLines"
          placeholder="每行一个图片 URL,留空则后端自动从上架记录的 transformed payload 读取"
          rows="5"
        ></textarea>
      </div>

      <div class="ir-actions">
        <button class="btn btn-ghost" :disabled="submitting" @click="$emit('update:open', false)">取消</button>
        <button class="btn btn-primary" :disabled="submitting" @click="submit">
          {{ submitting ? '提交中...' : '提交' }}
        </button>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.ir-dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ir-info {
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
.ir-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ir-label {
  font-size: 13px;
  font-weight: 500;
  color: #333;
}
.ir-textarea {
  width: 100%;
  border: 1px solid #d9d9d9;
  border-radius: 4px;
  padding: 8px;
  font-size: 12px;
  font-family: monospace;
  resize: vertical;
}
.ir-actions {
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
