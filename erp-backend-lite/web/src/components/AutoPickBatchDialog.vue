<script setup>
// 按筛选条件自动选取 + 批量均衡上架弹窗
// 与 BatchUploadDialog 的差异:
//   1. 不依赖手动勾选 SKU,接收 filters(当前筛选条件)+ targetCount(目标数量)
//   2. 调用 /admin/api/batch-upload/auto-pick 后端按 sellerId 均衡选取 N 个 SKU
//   3. 分配预览表增加价格、评论数列(便于评估选取质量)
//   4. 创建批次时,用 auto-pick 返回的 skus + assignments 调用原 createBatchUpload
import { reactive, ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useStoresStore } from '../stores/stores.js';
import { getListingTemplates } from '../api/listingTemplates.js';
import { autoPickBatchUpload, createBatchUpload } from '../api/batch-upload.js';
import { useToast } from './useToast.js';

const props = defineProps({
  filters: { type: Object, default: () => ({}) }, // 采集箱当前筛选条件
});
const emit = defineEmits(['close']);

const router = useRouter();
const storesStore = useStoresStore();
const { show } = useToast();

// localStorage key:记住上次选中的店铺(跨会话持久化,与 BatchUploadDialog 共用)
const SELECTED_STORE_IDS_KEY = 'qx-batch-upload-selected-store-ids';
// localStorage key:记住上次的所有配置(跨会话持久化)
const CONFIG_KEY = 'qx-auto-pick-config';

// 默认配置
const DEFAULT_FORM = {
  perStoreCount: 25,
  storeIds: [],
  intervalSec: 10,
  onFailure: 'continue',
  templateId: '',
  defaultStock: 10,
  name: '',
};

// 从 localStorage 恢复上次配置
function loadSavedConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    return {
      perStoreCount: saved.perStoreCount ?? DEFAULT_FORM.perStoreCount,
      intervalSec: saved.intervalSec ?? DEFAULT_FORM.intervalSec,
      onFailure: saved.onFailure ?? DEFAULT_FORM.onFailure,
      templateId: saved.templateId ?? DEFAULT_FORM.templateId,
      defaultStock: saved.defaultStock ?? DEFAULT_FORM.defaultStock,
    };
  } catch {
    return {};
  }
}

const savedConfig = loadSavedConfig();

// ── 配置表单 ───────────────────────────────────────────────
const form = reactive({
  perStoreCount: savedConfig.perStoreCount ?? DEFAULT_FORM.perStoreCount,
  storeIds: [],            // storeIds 单独从 SELECTED_STORE_IDS_KEY 恢复(与 BatchUploadDialog 共用)
  intervalSec: savedConfig.intervalSec ?? DEFAULT_FORM.intervalSec,
  onFailure: savedConfig.onFailure ?? DEFAULT_FORM.onFailure,
  templateId: savedConfig.templateId ?? DEFAULT_FORM.templateId,
  defaultStock: savedConfig.defaultStock ?? DEFAULT_FORM.defaultStock,
  name: DEFAULT_FORM.name, // 批次名称不持久化(一次性使用)
});

// 持久化所有配置(除 name 外)
function persistConfig() {
  try {
    const { name, ...rest } = form;
    localStorage.setItem(CONFIG_KEY, JSON.stringify(rest));
  } catch {
    /* 静默失败 */
  }
}

const templates = ref([]);
const loadingPreview = ref(false);
const creating = ref(false);
// 预览结果(assignments 本地可编辑,统计摘要 + 跳过列表 + 选取信息)
const preview = ref(null);

// ── 加载店铺列表 + 模板列表 ─────────────────────────────────
onMounted(async () => {
  try {
    await storesStore.load();
    try {
      const saved = JSON.parse(localStorage.getItem(SELECTED_STORE_IDS_KEY) || '[]');
      if (Array.isArray(saved) && saved.length) {
        form.storeIds = saved.filter((id) => storesStore.list.some((s) => s.id === id));
      }
    } catch (e) {
      console.warn('[AutoPickBatchDialog] 恢复上次店铺失败:', e?.message);
    }
  } catch (err) {
    show(err.message || '店铺列表加载失败', 'error');
  }
  try {
    const list = await getListingTemplates();
    templates.value = Array.isArray(list) ? list : [];
    // 只在 templateId 为空或无效时才用默认模板(避免覆盖已恢复的上次选择)
    const validTemplate = templates.value.find((t) => String(t.id) === String(form.templateId));
    if (!validTemplate) {
      const def = templates.value.find((t) => t.isDefault) || templates.value[0];
      if (def) {
        form.templateId = def.id;
        // 首次使用默认模板时同步 defaultStock(后续不再覆盖用户的修改)
        if (!savedConfig.templateId) {
          const c = def.config || {};
          if (c.defaultStock != null) form.defaultStock = Number(c.defaultStock) || 0;
        }
      }
    }
  } catch (err) {
    show(err.message || '模板列表加载失败', 'error');
  }
});

// 监听表单变化自动持久化(除 name 外)
watch(
  () => ({ ...form }),
  () => persistConfig(),
  { deep: true }
);

function toggleStore(id) {
  const i = form.storeIds.indexOf(id);
  if (i >= 0) form.storeIds.splice(i, 1);
  else form.storeIds.push(id);
  try {
    localStorage.setItem(SELECTED_STORE_IDS_KEY, JSON.stringify(form.storeIds));
  } catch (e) {
    /* 静默失败 */
  }
}

// ── 当前筛选条件摘要(展示用) ───────────────────────────────
const filterSummary = computed(() => {
  const f = props.filters || {};
  const parts = [];
  if (f.keyword) parts.push(`关键词:"${f.keyword}"`);
  if (f.sellerId) parts.push('指定来源卖家');
  if (f.hasComments) parts.push('有评论');
  if (f.hasRichContent) parts.push('有富内容');
  if (f.unlisted) parts.push('未跟卖');
  if (f.fullData) parts.push('数据完整');
  if (f.excludeFilteredCategories) parts.push('排除类型过滤');
  if (f.priceMin !== '' && f.priceMin != null) parts.push(`最低价 ${f.priceMin}`);
  if (f.priceMax !== '' && f.priceMax != null) parts.push(`最高价 ${f.priceMax}`);
  return parts.length ? parts.join(' / ') : '无(全部采集箱商品)';
});

// 总选取数预览 = 每家店铺数量 × 已选目标店铺数
const totalRequestedPreview = computed(() => {
  const M = Number(form.perStoreCount) || 0;
  return M * form.storeIds.length;
});

// ── 自动选取 + 预览分配 ───────────────────────────────────
async function doPreview() {
  const M = Number(form.perStoreCount) || 0;
  if (M <= 0) {
    show('请输入有效的每家店铺上架数量', 'error');
    return;
  }
  if (!form.storeIds.length) {
    show('请至少选择一个目标店铺', 'error');
    return;
  }
  loadingPreview.value = true;
  preview.value = null;
  try {
    // 构造筛选条件(与 collect-box-v2/from-cache 接口一致的字符串型参数)
    const f = props.filters || {};
    const filters = {
      keyword: f.keyword || '',
      sellerId: f.sellerId || '',
      unlisted: f.unlisted ? '1' : '',
      hasComments: f.hasComments ? '1' : '',
      hasRichContent: f.hasRichContent ? '1' : '',
      excludeFilteredCategories: f.excludeFilteredCategories ? '1' : '',
      priceMin: f.priceMin !== '' && f.priceMin != null ? String(f.priceMin) : '',
      priceMax: f.priceMax !== '' && f.priceMax != null ? String(f.priceMax) : '',
      minCacheHits: f.fullData ? '3' : '',
    };
    const payload = {
      filters,
      perStoreCount: M,
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
    const r = await autoPickBatchUpload(payload);
    preview.value = r || null;
    // 为每个 assignment 准备本地可编辑的 targetStoreId(深拷贝避免污染)
    if (preview.value?.assignments) {
      preview.value.assignments = preview.value.assignments.map((a) => ({ ...a }));
    }
    const pi = preview.value?.pickInfo || {};
    if (pi.insufficient) {
      show(
        `候选不足:符合 ${pi.eligibleCount} 件,实际选取 ${pi.actualPicked}/${pi.requestedCount} 件(每家店铺约 ${Math.floor(pi.actualPicked / pi.storeCount)} 件)`,
        'warn'
      );
    } else {
      show(
        `选取完成:${pi.actualPicked} 件(每家店铺 ${pi.perStoreCount} 件 × ${pi.storeCount} 家,来自 ${pi.totalSellers} 家来源卖家),跳过 ${pi.skippedCount} 件`,
        'success'
      );
    }
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
  if (!preview.value?.assignments?.length) {
    show('请先预览分配', 'error');
    return;
  }
  if (!form.storeIds.length) {
    show('请至少选择一个目标店铺', 'error');
    return;
  }
  creating.value = true;
  try {
    // 用 auto-pick 选出的 skus + 调整后的 assignments 创建批次
    const skus = preview.value.assignments.map((a) => a.sku);
    const payload = {
      skus,
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
      assignments: preview.value.assignments.map((a) => ({
        sku: a.sku,
        sellerId: a.sellerId,
        targetStoreId: a.targetStoreId,
        seq: a.seq,
      })),
    };
    const r = await createBatchUpload(payload);
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

const SKIP_REASON_LABEL = {
  NOT_FOUND: 'SKU 不在缓存',
  LISTED: '已跟卖',
  INSUFFICIENT_DATA: '数据不完整',
};
function skipReasonLabel(reason) {
  return SKIP_REASON_LABEL[reason] || reason || '—';
}

const balanceTag = computed(() => {
  if (!preview.value?.summary) return null;
  const s = preview.value.summary;
  return s.isBalanced
    ? { cls: 'tag-ok', label: '目标店铺均衡(差≤1)' }
    : { cls: 'tag-warn', label: `目标店铺不均衡(差=${s.maxStoreCount - s.minStoreCount})` };
});

const pickBalanceTag = computed(() => {
  const pi = preview.value?.pickInfo;
  if (!pi) return null;
  // 来源卖家选取数均衡度:最大 - 最小
  const counts = Object.values(pi.bySellerCount || {});
  if (counts.length === 0) return null;
  const mx = Math.max(...counts);
  const mn = Math.min(...counts);
  return mx - mn <= 1
    ? { cls: 'tag-ok', label: `来源卖家均衡(差≤1)` }
    : { cls: 'tag-warn', label: `来源卖家不均衡(差=${mx - mn})` };
});

function close() {
  emit('close');
}
</script>

<template>
  <div class="apbd-overlay">
    <div class="apbd-mask" @click="close"></div>
    <div class="apbd-card">
      <div class="apbd-header">
        <h2>按筛选自动上架</h2>
        <button class="apbd-close" @click="close" title="关闭">✕</button>
      </div>
      <div class="apbd-body">
        <!-- 顶部信息 -->
        <div class="apbd-info">
          <span>当前筛选:<b>{{ filterSummary }}</b></span>
        </div>

        <!-- 配置区 -->
        <div class="apbd-section">
          <div class="apbd-section-title">每家店铺上架数量</div>
          <div class="apbd-form-row">
            <label class="apbd-field">
              <span>每家目标店铺上架数量 M</span>
              <input type="number" min="1" step="1" v-model.number="form.perStoreCount" />
            </label>
            <div class="apbd-total-preview">
              <span class="muted small">总选取数预览</span>
              <b>{{ totalRequestedPreview }}</b>
              <span class="muted small">= {{ form.perStoreCount || 0 }} × {{ form.storeIds.length }} 家店铺</span>
            </div>
          </div>
          <div class="muted small" style="margin-top: 6px">
            算法:总选取数 N = M × 目标店铺数。按来源卖家(sellerId)均衡选取 N 个(每家来源卖家取 floor(N/卖家数),差额均摊),
            再 round-robin 分配到目标店铺(同源 SKU 散到不同店铺,保证每家店铺内来源尽量分散)
          </div>
        </div>

        <div class="apbd-section">
          <div class="apbd-section-title">店铺多选(目标上架店铺)</div>
          <div v-if="!storesStore.loaded" class="muted small">加载中...</div>
          <div v-else-if="!storesStore.list.length" class="muted small">暂无店铺,请先在店铺管理中配置</div>
          <div v-else class="apbd-store-grid">
            <label
              v-for="s in storesStore.list"
              :key="s.id"
              class="apbd-store-item"
              :class="{ active: form.storeIds.includes(s.id) }"
            >
              <input
                type="checkbox"
                :checked="form.storeIds.includes(s.id)"
                @change="toggleStore(s.id)"
              />
              <span>{{ s.name }}</span>
              <span class="apbd-store-id">{{ s.id }}</span>
            </label>
          </div>
        </div>

        <div class="apbd-section">
          <div class="apbd-section-title">速度配置</div>
          <div class="apbd-form-row">
            <label class="apbd-field">
              <span>提交间隔(秒)</span>
              <input type="number" min="1" step="1" v-model.number="form.intervalSec" />
            </label>
            <label class="apbd-field">
              <span>失败处理</span>
              <select v-model="form.onFailure">
                <option value="continue">continue(继续后续)</option>
                <option value="pause">pause(暂停批次)</option>
              </select>
            </label>
          </div>
        </div>

        <div class="apbd-section">
          <div class="apbd-section-title">模板与库存</div>
          <div class="apbd-form-row">
            <label class="apbd-field">
              <span>上架模板</span>
              <select v-model="form.templateId">
                <option value="">(不指定)</option>
                <option v-for="t in templates" :key="t.id" :value="t.id">
                  {{ t.name }}{{ t.isDefault ? '(默认)' : '' }}
                </option>
              </select>
            </label>
            <label class="apbd-field">
              <span>默认库存</span>
              <input type="number" min="0" step="1" v-model.number="form.defaultStock" />
            </label>
          </div>
        </div>

        <div class="apbd-section">
          <div class="apbd-section-title">批次名称(可选)</div>
          <input
            type="text"
            class="apbd-input"
            v-model.trim="form.name"
            placeholder="留空则自动生成"
          />
        </div>

        <div class="apbd-actions">
          <button class="btn btn-ghost" @click="close">取消</button>
          <button class="btn btn-primary" :disabled="loadingPreview" @click="doPreview">
            {{ loadingPreview ? '选取中...' : '自动选取+预览' }}
          </button>
          <button
            class="btn btn-primary"
            :disabled="creating || !preview?.assignments?.length"
            @click="doCreate"
          >
            {{ creating ? '创建中...' : '确认创建' }}
          </button>
        </div>

        <!-- 预览结果 -->
        <template v-if="preview">
          <!-- 选取摘要 -->
          <div class="apbd-section" v-if="preview.pickInfo">
            <div class="apbd-section-title">
              选取摘要
              <span v-if="pickBalanceTag" class="tag" :class="pickBalanceTag.cls">{{ pickBalanceTag.label }}</span>
            </div>
            <div class="apbd-summary">
              <div class="apbd-summary-item">
                <span class="apbd-summary-label">每家店铺数量</span>
                <span class="apbd-summary-cnt">{{ preview.pickInfo.perStoreCount }}</span>
              </div>
              <div class="apbd-summary-item">
                <span class="apbd-summary-label">目标店铺数</span>
                <span class="apbd-summary-cnt">{{ preview.pickInfo.storeCount }}</span>
              </div>
              <div class="apbd-summary-item">
                <span class="apbd-summary-label">目标总数</span>
                <span class="apbd-summary-cnt">{{ preview.pickInfo.requestedCount }}</span>
              </div>
              <div class="apbd-summary-item">
                <span class="apbd-summary-label">实际选取</span>
                <span class="apbd-summary-cnt">{{ preview.pickInfo.actualPicked }}</span>
              </div>
              <div class="apbd-summary-item">
                <span class="apbd-summary-label">候选总数</span>
                <span class="apbd-summary-cnt">{{ preview.pickInfo.totalAvailable }}</span>
              </div>
              <div class="apbd-summary-item">
                <span class="apbd-summary-label">可上架数</span>
                <span class="apbd-summary-cnt">{{ preview.pickInfo.eligibleCount }}</span>
              </div>
              <div class="apbd-summary-item">
                <span class="apbd-summary-label">来源卖家数</span>
                <span class="apbd-summary-cnt">{{ preview.pickInfo.totalSellers }}</span>
              </div>
              <div class="apbd-summary-item">
                <span class="apbd-summary-label">跳过</span>
                <span class="apbd-summary-cnt">{{ preview.pickInfo.skippedCount }}</span>
              </div>
            </div>
            <div v-if="preview.pickInfo.insufficient" class="apbd-warn">
              候选不足,实际选取 {{ preview.pickInfo.actualPicked }} / 目标 {{ preview.pickInfo.requestedCount }}
              (每家店铺约 {{ Math.floor(preview.pickInfo.actualPicked / preview.pickInfo.storeCount) }} 件,不均衡)
            </div>
          </div>

          <!-- 各来源卖家选取数 -->
          <div class="apbd-section" v-if="preview.pickInfo?.bySellerCount">
            <div class="apbd-section-title">来源卖家选取分布</div>
            <div class="apbd-summary">
              <div
                v-for="(cnt, sid) in preview.pickInfo.bySellerCount"
                :key="sid"
                class="apbd-summary-item"
              >
                <span class="apbd-summary-label">{{ sid || '(未知卖家)' }}</span>
                <span class="apbd-summary-cnt">{{ cnt }}</span>
              </div>
            </div>
          </div>

          <!-- 目标店铺分配摘要 -->
          <div class="apbd-section" v-if="preview.summary">
            <div class="apbd-section-title">
              目标店铺分配摘要
              <span v-if="balanceTag" class="tag" :class="balanceTag.cls">{{ balanceTag.label }}</span>
            </div>
            <div class="apbd-summary">
              <div v-for="(cnt, sid) in preview.summary.byStore || {}" :key="sid" class="apbd-summary-item">
                <span class="apbd-summary-label">{{ storeName(sid) }}</span>
                <span class="apbd-summary-cnt">{{ cnt }}</span>
              </div>
            </div>
          </div>

          <!-- 分配表(可手动调整目标店铺,含价格/评论数) -->
          <div class="apbd-section">
            <div class="apbd-section-title">分配预览({{ preview.assignments?.length || 0 }} 行)</div>
            <div class="apbd-table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th style="width: 50px">序号</th>
                    <th>SKU</th>
                    <th>商品名</th>
                    <th style="width: 90px">价格</th>
                    <th style="width: 70px">评论数</th>
                    <th>来源卖家</th>
                    <th style="width: 180px">目标店铺</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!preview.assignments || !preview.assignments.length">
                    <td colspan="7" class="muted" style="text-align: center; padding: 16px">无分配</td>
                  </tr>
                  <tr v-for="(a, idx) in preview.assignments || []" :key="a.sku + ':' + idx">
                    <td>{{ a.seq }}</td>
                    <td class="apbd-sku">{{ a.sku }}</td>
                    <td class="apbd-name" :title="a.name || ''">{{ a.name || '—' }}</td>
                    <td>{{ a.price || '—' }}</td>
                    <td>{{ a.ratingCount != null ? a.ratingCount : '—' }}</td>
                    <td class="apbd-sku">{{ a.sellerId || '—' }}</td>
                    <td>
                      <select
                        class="apbd-store-select"
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
          <div v-if="preview.skipped && preview.skipped.length" class="apbd-section">
            <div class="apbd-section-title">跳过列表({{ preview.skipped.length }})</div>
            <div class="apbd-table-wrap">
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
                    <td class="apbd-sku">{{ s.sku }}</td>
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
/* 弹窗样式:与 BatchUploadDialog 风格保持一致(前缀 apbd = auto-pick batch dialog) */
.apbd-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}
.apbd-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}
.apbd-card {
  position: relative;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  width: 880px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.apbd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, #e4e8ee);
}
.apbd-header h2 {
  margin: 0;
  font-size: 16px;
}
.apbd-close {
  border: none;
  background: transparent;
  font-size: 22px;
  line-height: 1;
  color: var(--muted, #6b7280);
  cursor: pointer;
  padding: 0 4px;
}
.apbd-close:hover {
  color: var(--text, #1f2937);
}
.apbd-body {
  padding: 16px 20px;
  overflow: auto;
}
.apbd-info {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--muted, #6b7280);
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.apbd-info b {
  color: var(--text, #1f2937);
  font-weight: 600;
}
.apbd-section {
  margin-bottom: 16px;
}
.apbd-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #1f2937);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.apbd-store-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}
.apbd-store-item {
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
.apbd-store-item.active {
  border-color: var(--primary, #2563eb);
  background: #eff6ff;
}
.apbd-store-item input {
  margin: 0;
}
.apbd-store-id {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted, #6b7280);
  font-family: ui-monospace, Menlo, monospace;
}
.apbd-form-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}
.apbd-total-preview {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: 1px dashed var(--border, #e4e8ee);
  border-radius: 6px;
  background: #f9fafb;
  font-size: 13px;
}
.apbd-total-preview b {
  color: var(--primary, #2563eb);
  font-size: 16px;
  font-weight: 600;
}
.apbd-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  flex: 1;
  min-width: 200px;
}
.apbd-field input,
.apbd-field select {
  padding: 6px 10px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
}
.apbd-field input:focus,
.apbd-field select:focus,
.apbd-input:focus {
  outline: none;
  border-color: var(--primary, #2563eb);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
.apbd-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
}
.apbd-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border, #e4e8ee);
}
.apbd-summary {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.apbd-summary-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  font-size: 13px;
  background: #f9fafb;
}
.apbd-summary-label {
  color: var(--muted, #6b7280);
}
.apbd-summary-cnt {
  font-weight: 600;
  color: var(--primary, #2563eb);
}
.apbd-warn {
  margin-top: 8px;
  padding: 6px 10px;
  background: #fff7e6;
  border: 1px solid #ffd591;
  border-radius: 4px;
  color: #d46b08;
  font-size: 12px;
}
.apbd-table-wrap {
  overflow-x: auto;
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
}
.apbd-sku {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}
.apbd-name {
  font-size: 12px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.apbd-store-select {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 4px;
  font-size: 12px;
  background: #fff;
}
.apbd-store-select:focus {
  outline: none;
  border-color: var(--primary, #2563eb);
}
</style>
