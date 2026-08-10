<script setup>
// 按筛选条件批量发起深度采集任务弹窗
// 接收采集箱当前 filters,调用 /admin/api/collect-queue/batch-submit-by-filter 批量入队
// 选项:skipIfTodaySuccess(跳过今日已成功) / forceRefresh(强制重新采集,忽略缓存)
import { reactive, ref, computed, onMounted } from 'vue';
import { batchSubmitByFilter } from '../api/collectQueue.js';
import { getCollectBoxV2FromCache } from '../api/collect-box-v2.js';
import { useToast } from './useToast.js';

const props = defineProps({
  filters: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['close']);

const { show } = useToast();

// ── 状态 ───────────────────────────────────────────────
const state = reactive({
  loadingPreview: true, // 预览匹配数加载中
  submitting: false,    // 提交中
  totalFound: 0,        // 匹配商品数
  skipIfTodaySuccess: true, // 跳过今日已成功(默认勾选)
  forceRefresh: false,      // 强制重新采集(默认不勾选)
  // 提交结果
  result: null, // { totalFound, enqueued, skipped, alreadyQueued, forceRefresh }
});

// ── 计算属性 ───────────────────────────────────────────────
// forceRefresh=true 时禁用 skipIfTodaySuccess(语义互斥)
const skipIfTodaySuccessDisabled = computed(() => state.forceRefresh);

// 筛选条件摘要(展示用)
const DESC_QUALITY_LABEL = {
  '0': '描述为空',
  '1': '含占位符',
  '2': '按钮污染',
  '3': '描述有效',
  '1,2': '需清洗',
};
const filterSummary = computed(() => {
  const f = props.filters || {};
  const parts = [];
  if (f.keyword) parts.push(`关键词="${f.keyword}"`);
  if (f.cacheCompleteness === 'full') parts.push('数据完整');
  else if (f.cacheCompleteness === 'partial') parts.push('数据不完整');
  if (f.sellerId) parts.push(`卖家=${f.sellerId}`);
  if (f.unlisted) parts.push('未跟卖');
  if (f.hasComments) parts.push('有评论');
  if (f.hasRichContent) parts.push('有富内容');
  if (f.excludeFilteredCategories) parts.push('排除类型过滤');
  if (f.descriptionQuality && DESC_QUALITY_LABEL[f.descriptionQuality]) {
    parts.push(`描述=${DESC_QUALITY_LABEL[f.descriptionQuality]}`);
  }
  if (f.ultraLight === '1') parts.push('超轻小件');
  else if (f.ultraLight === '0') parts.push('非超轻小件');
  if (f.marketStats === 'has') parts.push('有市场统计');
  else if (f.marketStats === 'none') parts.push('无市场统计');
  if (f.priceMin !== '' && f.priceMin != null) parts.push(`≥${f.priceMin}`);
  if (f.priceMax !== '' && f.priceMax != null) parts.push(`≤${f.priceMax}`);
  return parts.length ? parts.join('、') : '无筛选(全部商品)';
});

// ── 方法 ───────────────────────────────────────────────
// 把 filters 转为后端 query 参数(与 CollectBoxV2.vue loadList 一致)
function buildFilterParams() {
  const f = props.filters || {};
  const params = {};
  if (f.keyword) params.keyword = String(f.keyword).trim();
  if (f.cacheCompleteness === 'full') params.minCacheHits = '3';
  if (f.cacheCompleteness === 'partial') params.maxCacheHits = '2';
  if (f.sellerId) params.sellerId = f.sellerId;
  if (f.unlisted) params.unlisted = '1';
  if (f.hasComments) params.hasComments = '1';
  if (f.hasRichContent) params.hasRichContent = '1';
  if (f.excludeFilteredCategories) params.excludeFilteredCategories = '1';
  if (f.ultraLight !== '') params.ultraLight = f.ultraLight;
  if (f.priceMin !== '' && f.priceMin != null) params.priceMin = f.priceMin;
  if (f.priceMax !== '' && f.priceMax != null) params.priceMax = f.priceMax;
  if (f.descriptionQuality) params.descriptionQuality = f.descriptionQuality;
  if (f.marketStats) params.marketStats = f.marketStats;
  return params;
}

// 预览匹配数(调 from-cache 接口拿 total,pageSize=1 减少数据传输)
async function loadPreview() {
  state.loadingPreview = true;
  try {
    const params = { ...buildFilterParams(), currentPage: 1, pageSize: 1 };
    const data = await getCollectBoxV2FromCache(params);
    state.totalFound = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    state.totalFound = 0;
  } finally {
    state.loadingPreview = false;
  }
}

// forceRefresh 变化时联动 skipIfTodaySuccess
function onForceRefreshChange() {
  if (state.forceRefresh) {
    state.skipIfTodaySuccess = false;
  }
}

// 发起深度采集
async function submit() {
  if (state.totalFound === 0) {
    show('没有匹配的商品', 'error');
    return;
  }
  state.submitting = true;
  state.result = null;
  try {
    const payload = {
      filters: buildFilterParams(),
      skipIfTodaySuccess: state.skipIfTodaySuccess && !state.forceRefresh,
      forceRefresh: state.forceRefresh,
    };
    const data = await batchSubmitByFilter(payload);
    state.result = data;
    show(
      `深度采集任务已入队:新增 ${data.enqueued} / 已存在 ${data.alreadyQueued} / 跳过 ${data.skipped}`,
      'success'
    );
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    state.submitting = false;
  }
}

onMounted(() => {
  loadPreview();
});
</script>

<template>
  <div class="dc-dialog-overlay" @click.self="emit('close')">
    <div class="dc-dialog">
      <div class="dc-dialog-header">
        <h3>按筛选发起深度采集</h3>
        <button class="dc-dialog-close" @click="emit('close')">×</button>
      </div>

      <div class="dc-dialog-body">
        <!-- 筛选条件摘要 -->
        <div class="dc-section">
          <div class="dc-label">筛选条件</div>
          <div class="dc-filter-summary">{{ filterSummary }}</div>
        </div>

        <!-- 匹配商品数 -->
        <div class="dc-section">
          <div class="dc-label">匹配商品</div>
          <div v-if="state.loadingPreview" class="dc-value">加载中…</div>
          <div v-else class="dc-value dc-value-large">
            {{ state.totalFound }} 件
            <span v-if="state.totalFound === 0" class="dc-hint">(无匹配商品,无法发起)</span>
          </div>
        </div>

        <!-- 选项 -->
        <div class="dc-section">
          <div class="dc-label">选项</div>
          <label class="dc-check" :class="{ 'dc-check-disabled': skipIfTodaySuccessDisabled }">
            <input
              type="checkbox"
              v-model="state.skipIfTodaySuccess"
              :disabled="skipIfTodaySuccessDisabled"
            />
            <span>跳过今日已成功采集的 SKU</span>
            <span class="dc-check-hint">(24h 内已 success 的不入队,避免重复采集)</span>
          </label>
          <label class="dc-check">
            <input
              type="checkbox"
              v-model="state.forceRefresh"
              @change="onForceRefreshChange"
            />
            <span>强制重新采集</span>
            <span class="dc-check-hint">(忽略已有缓存,重新拉取全量数据。用于修复脏数据)</span>
          </label>
        </div>

        <!-- 警告提示 -->
        <div class="dc-warn">
          <strong>⚠ 注意:</strong>
          任务将由插件 SW 串行消费(5-15s/个),{{ state.totalFound }} 件预计耗时
          {{ Math.ceil((state.totalFound * 10) / 60) }} 分钟 ~ {{ Math.ceil((state.totalFound * 15) / 60) }} 分钟。
          请确保插件已打开且深度采集开关已启用。
          <template v-if="state.forceRefresh">
            <br /><strong>强制模式:</strong>所有匹配 SKU 都会重新采集,已成功但未满 24h 的也会重采。
          </template>
        </div>

        <!-- 提交结果 -->
        <div v-if="state.result" class="dc-result">
          <div class="dc-result-title">入队结果</div>
          <div class="dc-result-grid">
            <div class="dc-result-item">
              <span class="dc-result-num dc-num-ok">{{ state.result.enqueued }}</span>
              <span class="dc-result-label">新增入队</span>
            </div>
            <div class="dc-result-item">
              <span class="dc-result-num dc-num-info">{{ state.result.alreadyQueued }}</span>
              <span class="dc-result-label">已存在(更新)</span>
            </div>
            <div class="dc-result-item">
              <span class="dc-result-num dc-num-warn">{{ state.result.skipped }}</span>
              <span class="dc-result-label">跳过(今日已成功)</span>
            </div>
          </div>
        </div>
      </div>

      <div class="dc-dialog-footer">
        <button class="btn btn-ghost" @click="emit('close')" :disabled="state.submitting">
          {{ state.result ? '关闭' : '取消' }}
        </button>
        <button
          v-if="!state.result"
          class="btn btn-primary"
          @click="submit"
          :disabled="state.submitting || state.loadingPreview || state.totalFound === 0"
        >
          {{ state.submitting ? '提交中…' : '发起采集' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dc-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.dc-dialog {
  background: #fff;
  border-radius: 8px;
  width: 560px;
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}
.dc-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #e5e7eb;
}
.dc-dialog-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.dc-dialog-close {
  border: none;
  background: none;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: #6b7280;
  padding: 0 4px;
}
.dc-dialog-close:hover {
  color: #111;
}
.dc-dialog-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}
.dc-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid #e5e7eb;
}
.dc-section {
  margin-bottom: 16px;
}
.dc-label {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 6px;
  font-weight: 500;
}
.dc-value {
  font-size: 14px;
  color: #111;
}
.dc-value-large {
  font-size: 20px;
  font-weight: 600;
}
.dc-hint {
  font-size: 12px;
  color: #9ca3af;
  font-weight: 400;
  margin-left: 8px;
}
.dc-filter-summary {
  font-size: 13px;
  color: #374151;
  background: #f9fafb;
  padding: 8px 10px;
  border-radius: 4px;
  line-height: 1.5;
}
.dc-check {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;
  cursor: pointer;
  font-size: 14px;
}
.dc-check input[type='checkbox'] {
  margin: 0;
  cursor: pointer;
}
.dc-check span {
  color: #111;
}
.dc-check-hint {
  font-size: 12px !important;
  color: #9ca3af !important;
}
.dc-check-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dc-warn {
  font-size: 12px;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 4px;
  padding: 10px 12px;
  line-height: 1.6;
}
.dc-result {
  margin-top: 16px;
  padding: 12px;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 4px;
}
.dc-result-title {
  font-size: 13px;
  font-weight: 600;
  color: #166534;
  margin-bottom: 8px;
}
.dc-result-grid {
  display: flex;
  gap: 24px;
}
.dc-result-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.dc-result-num {
  font-size: 24px;
  font-weight: 700;
}
.dc-num-ok {
  color: #16a34a;
}
.dc-num-info {
  color: #2563eb;
}
.dc-num-warn {
  color: #d97706;
}
.dc-result-label {
  font-size: 12px;
  color: #6b7280;
  margin-top: 2px;
}
</style>
