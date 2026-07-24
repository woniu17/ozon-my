<script setup>
// 批量均衡上架配置弹窗
// 接收 props.skus(数组),展示店铺多选 + 速度/模板/库存配置 + 预览分配 + 手动调整 + 确认创建
import { reactive, ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useStoresStore } from '../stores/stores.js';
import { getListingTemplates } from '../api/listingTemplates.js';
import { previewBatchUpload, createBatchUpload } from '../api/batch-upload.js';
import { useToast } from './useToast.js';

const props = defineProps({
  skus: { type: Array, default: () => [] },
});
const emit = defineEmits(['close']);

const router = useRouter();
const storesStore = useStoresStore();
const { show } = useToast();

// localStorage key:记住上次选中的店铺(跨会话持久化)
const SELECTED_STORE_IDS_KEY = 'qx-batch-upload-selected-store-ids';

// ── 配置表单 ───────────────────────────────────────────────
const form = reactive({
  storeIds: [],            // 多选店铺
  intervalSec: 10,         // 提交间隔(秒)
  onFailure: 'continue',   // 失败处理:continue / pause
  templateId: '',          // 上架模板 ID
  defaultStock: 10,        // 默认库存
  name: '',                // 批次名称(可选)
});

const templates = ref([]);
const loadingPreview = ref(false);
const creating = ref(false);
// 预览结果(assignments 本地可编辑,统计摘要 + 跳过列表)
const preview = ref(null);

// ── 加载店铺列表 + 模板列表 ─────────────────────────────────
onMounted(async () => {
  try {
    await storesStore.load();
    // 从 localStorage 恢复上次选中的店铺(过滤掉已不存在的店铺 ID)
    try {
      const saved = JSON.parse(localStorage.getItem(SELECTED_STORE_IDS_KEY) || '[]');
      if (Array.isArray(saved) && saved.length) {
        form.storeIds = saved.filter((id) => storesStore.list.some((s) => s.id === id));
      }
    } catch (e) {
      // 静默失败:localStorage 数据损坏时回退到空选择
      console.warn('[BatchUploadDialog] 恢复上次店铺失败:', e?.message);
    }
  } catch (err) {
    show(err.message || '店铺列表加载失败', 'error');
  }
  try {
    const list = await getListingTemplates();
    templates.value = Array.isArray(list) ? list : [];
    // 默认选中 isDefault 模板(或第一个)
    const def = templates.value.find((t) => t.isDefault) || templates.value[0];
    if (def) {
      form.templateId = def.id;
      // 从模板 config 同步默认库存(参考 Preview.vue 的 applyTemplate)
      const c = def.config || {};
      if (c.defaultStock != null) form.defaultStock = Number(c.defaultStock) || 0;
    }
  } catch (err) {
    show(err.message || '模板列表加载失败', 'error');
  }
});

// 店铺勾选切换(单选/多选)
function toggleStore(id) {
  const i = form.storeIds.indexOf(id);
  if (i >= 0) form.storeIds.splice(i, 1);
  else form.storeIds.push(id);
  // 持久化:记住上次选中的店铺,下次打开弹窗自动恢复
  try {
    localStorage.setItem(SELECTED_STORE_IDS_KEY, JSON.stringify(form.storeIds));
  } catch (e) {
    // 静默失败:隐私模式或存储已满时不影响本次操作
  }
}

// ── 预览分配 ───────────────────────────────────────────────
async function doPreview() {
  if (!props.skus.length) {
    show('未选择 SKU', 'error');
    return;
  }
  if (!form.storeIds.length) {
    show('请至少选择一个目标店铺', 'error');
    return;
  }
  loadingPreview.value = true;
  preview.value = null;
  try {
    const payload = {
      skus: props.skus,
      storeIds: form.storeIds,
      config: {
        templateId: form.templateId || undefined,
        defaultStock: Number(form.defaultStock) || 0,
      },
      speedConfig: {
        intervalSec: Number(form.intervalSec) || 10,
        onFailure: form.onFailure,
      },
    };
    const r = await previewBatchUpload(payload);
    // request.js 已解 envelope:r 即 { assignments, summary, skipped, config, speedConfig }
    preview.value = r || null;
    // 为每个 assignment 准备本地可编辑的 targetStoreId(深拷贝避免污染)
    if (preview.value?.assignments) {
      preview.value.assignments = preview.value.assignments.map((a) => ({ ...a }));
    }
    show(
      `预览完成:${preview.value?.assignments?.length || 0} 个分配,${preview.value?.skipped?.length || 0} 个跳过`,
      'success'
    );
  } catch (err) {
    show(err.message || '预览失败', 'error');
  } finally {
    loadingPreview.value = false;
  }
}

// 手动调整某行目标店铺
function onReassign(row, newStoreId) {
  row.targetStoreId = newStoreId;
}

// ── 确认创建 ───────────────────────────────────────────────
async function doCreate() {
  if (!props.skus.length) {
    show('未选择 SKU', 'error');
    return;
  }
  if (!form.storeIds.length) {
    show('请至少选择一个目标店铺', 'error');
    return;
  }
  creating.value = true;
  try {
    const payload = {
      skus: props.skus,
      storeIds: form.storeIds,
      name: form.name.trim() || undefined,
      config: {
        templateId: form.templateId || undefined,
        defaultStock: Number(form.defaultStock) || 0,
      },
      speedConfig: {
        intervalSec: Number(form.intervalSec) || 10,
        onFailure: form.onFailure,
      },
      // 预览过则带上调整后的 assignments,否则后端自动分配
      assignments: preview.value?.assignments || undefined,
    };
    const r = await createBatchUpload(payload);
    // request.js 已解 envelope:r 即批次对象
    const batchNo = r?.batchNo;
    show(`批次已创建:${batchNo || ''}`, 'success');
    emit('close');
    if (batchNo) {
      router.push(`/batch-upload/${encodeURIComponent(batchNo)}`);
    }
  } catch (err) {
    show(err.message || '创建失败', 'error');
  } finally {
    creating.value = false;
  }
}

// ── 渲染辅助 ───────────────────────────────────────────────
function storeName(storeId) {
  const s = storesStore.list.find((x) => x.id === storeId);
  return s?.name || storeId || '—';
}

// 跳过原因中文映射
const SKIP_REASON_LABEL = {
  NOT_FOUND: 'SKU 不在缓存',
  LISTED: '已跟卖',
  INSUFFICIENT_DATA: '数据不完整',
};
function skipReasonLabel(reason) {
  return SKIP_REASON_LABEL[reason] || reason || '—';
}

// 摘要均衡徽章
const balanceTag = computed(() => {
  if (!preview.value?.summary) return null;
  const s = preview.value.summary;
  return s.isBalanced
    ? { cls: 'tag-ok', label: '均衡(差≤1)' }
    : { cls: 'tag-warn', label: `不均衡(差=${s.maxStoreCount - s.minStoreCount})` };
});

// 关闭弹窗
function close() {
  emit('close');
}
</script>

<template>
  <div class="bud-overlay">
    <div class="bud-mask" @click="close"></div>
    <div class="bud-card">
      <div class="bud-header">
        <h2>批量均衡上架</h2>
        <button class="bud-close" @click="close" title="关闭">✕</button>
      </div>
      <div class="bud-body">
        <!-- 顶部信息 -->
        <div class="bud-info">
          <span>已选 SKU:<b>{{ skus.length }}</b> 件</span>
          <span>已选店铺:<b>{{ form.storeIds.length }}</b> 个</span>
        </div>

        <!-- 配置区 -->
        <div class="bud-section">
          <div class="bud-section-title">店铺多选</div>
          <div v-if="!storesStore.loaded" class="muted small">加载中...</div>
          <div v-else-if="!storesStore.list.length" class="muted small">暂无店铺,请先在店铺管理中配置</div>
          <div v-else class="bud-store-grid">
            <label
              v-for="s in storesStore.list"
              :key="s.id"
              class="bud-store-item"
              :class="{ active: form.storeIds.includes(s.id) }"
            >
              <input
                type="checkbox"
                :checked="form.storeIds.includes(s.id)"
                @change="toggleStore(s.id)"
              />
              <span>{{ s.name }}</span>
              <span class="bud-store-id">{{ s.id }}</span>
            </label>
          </div>
        </div>

        <div class="bud-section">
          <div class="bud-section-title">速度配置</div>
          <div class="bud-form-row">
            <label class="bud-field">
              <span>提交间隔(秒)</span>
              <input type="number" min="1" step="1" v-model.number="form.intervalSec" />
            </label>
            <label class="bud-field">
              <span>失败处理</span>
              <select v-model="form.onFailure">
                <option value="continue">continue(继续后续)</option>
                <option value="pause">pause(暂停批次)</option>
              </select>
            </label>
          </div>
        </div>

        <div class="bud-section">
          <div class="bud-section-title">模板与库存</div>
          <div class="bud-form-row">
            <label class="bud-field">
              <span>上架模板</span>
              <select v-model="form.templateId">
                <option value="">(不指定)</option>
                <option v-for="t in templates" :key="t.id" :value="t.id">
                  {{ t.name }}{{ t.isDefault ? '(默认)' : '' }}
                </option>
              </select>
            </label>
            <label class="bud-field">
              <span>默认库存</span>
              <input type="number" min="0" step="1" v-model.number="form.defaultStock" />
            </label>
          </div>
        </div>

        <div class="bud-section">
          <div class="bud-section-title">批次名称(可选)</div>
          <input
            type="text"
            class="bud-input"
            v-model.trim="form.name"
            placeholder="留空则自动生成"
          />
        </div>

        <div class="bud-actions">
          <button class="btn btn-ghost" @click="close">取消</button>
          <button class="btn btn-primary" :disabled="loadingPreview" @click="doPreview">
            {{ loadingPreview ? '预览中...' : '预览分配' }}
          </button>
          <button class="btn btn-primary" :disabled="creating" @click="doCreate">
            {{ creating ? '创建中...' : '确认创建' }}
          </button>
        </div>

        <!-- 预览结果 -->
        <template v-if="preview">
          <!-- 摘要 -->
          <div class="bud-section">
            <div class="bud-section-title">
              分配摘要
              <span v-if="balanceTag" class="tag" :class="balanceTag.cls">{{ balanceTag.label }}</span>
            </div>
            <div class="bud-summary">
              <div v-for="(cnt, sid) in preview.summary?.byStore || {}" :key="sid" class="bud-summary-item">
                <span class="bud-summary-store">{{ storeName(sid) }}</span>
                <span class="bud-summary-cnt">{{ cnt }}</span>
              </div>
            </div>
            <div class="muted small" style="margin-top: 6px">
              最大={{ preview.summary?.maxStoreCount }} 最小={{ preview.summary?.minStoreCount }}
            </div>
          </div>

          <!-- 分配表(可手动调整目标店铺) -->
          <div class="bud-section">
            <div class="bud-section-title">分配预览({{ preview.assignments?.length || 0 }} 行)</div>
            <div class="bud-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th style="width: 50px">序号</th>
                    <th>SKU</th>
                    <th>来源卖家</th>
                    <th style="width: 180px">目标店铺</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!preview.assignments || !preview.assignments.length">
                    <td colspan="4" class="muted" style="text-align: center; padding: 16px">无分配</td>
                  </tr>
                  <tr v-for="(a, idx) in preview.assignments || []" :key="a.sku + ':' + idx">
                    <td>{{ a.seq }}</td>
                    <td class="bud-sku">{{ a.sku }}</td>
                    <td>{{ a.sellerId || '—' }}</td>
                    <td>
                      <select
                        class="bud-store-select"
                        :value="a.targetStoreId"
                        @change="onReassign(a, $event.target.value)"
                      >
                        <option v-for="s in storesStore.list" :key="s.id" :value="s.id">
                          {{ s.name }}
                        </option>
                      </select>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 跳过列表 -->
          <div v-if="preview.skipped && preview.skipped.length" class="bud-section">
            <div class="bud-section-title">跳过列表({{ preview.skipped.length }})</div>
            <div class="bud-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>跳过原因</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(s, idx) in preview.skipped" :key="s.sku + ':' + idx">
                    <td class="bud-sku">{{ s.sku }}</td>
                    <td><span class="tag tag-warn">{{ skipReasonLabel(s.reason) }}</span></td>
                    <td class="muted small">{{ s.message || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 弹窗覆盖层(参考 .modal/.modal-card 全局样式,内联以避免依赖 AppModal 滚动行为) */
.bud-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bud-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}
.bud-card {
  position: relative;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  width: 720px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.bud-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, #e4e8ee);
}
.bud-header h2 {
  margin: 0;
  font-size: 16px;
}
.bud-close {
  border: none;
  background: transparent;
  font-size: 22px;
  line-height: 1;
  color: var(--muted, #6b7280);
  cursor: pointer;
  padding: 0 4px;
}
.bud-close:hover {
  color: var(--text, #1f2937);
}
.bud-body {
  padding: 16px 20px;
  overflow: auto;
}
.bud-info {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--muted, #6b7280);
  margin-bottom: 12px;
}
.bud-info b {
  color: var(--text, #1f2937);
  font-weight: 600;
}
.bud-section {
  margin-bottom: 16px;
}
.bud-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #1f2937);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.bud-store-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}
.bud-store-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  background: #fff;
}
.bud-store-item.active {
  border-color: var(--primary, #2563eb);
  background: #eff6ff;
}
.bud-store-item input {
  margin: 0;
}
.bud-store-id {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted, #6b7280);
  font-family: ui-monospace, Menlo, monospace;
}
.bud-form-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.bud-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  flex: 1;
  min-width: 200px;
}
.bud-field input,
.bud-field select {
  padding: 6px 10px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
}
.bud-field input:focus,
.bud-field select:focus,
.bud-input:focus {
  outline: none;
  border-color: var(--primary, #2563eb);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
.bud-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
}
.bud-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border, #e4e8ee);
}
.bud-summary {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.bud-summary-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  font-size: 13px;
  background: #f9fafb;
}
.bud-summary-cnt {
  font-weight: 600;
  color: var(--primary, #2563eb);
}
.bud-table-wrap {
  overflow-x: auto;
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
}
.bud-sku {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}
.bud-store-select {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 4px;
  font-size: 12px;
  background: #fff;
}
.bud-store-select:focus {
  outline: none;
  border-color: var(--primary, #2563eb);
}
</style>
