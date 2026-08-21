<script setup>
// 按筛选条件导出 Excel 弹窗(2026-08 采集箱导出)
// 逻辑参考"按筛选自动上架":后端按 sellerId 均衡选取(尽可能多地覆盖源店铺)
// Excel 列:SKU / 评论数 / 原价格 / 跟卖价格(公式) / 跟卖最低价格(公式) / 组合列(公式)
// 跟卖价格规则:原价格<=15 → 19,否则 = 原价格;最低价格 = 跟卖价格 - 0.01(公式写入 xlsx)
import { reactive, ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { createExportTask, downloadExportExcel, previewExportExcel } from '../api/exportExcel.js';
import { useToast } from './useToast.js';

const props = defineProps({
  filters: { type: Object, default: () => ({}) }, // 采集箱当前筛选条件
});
const emit = defineEmits(['close', 'exported']);

const router = useRouter();
const { show } = useToast();

const CONFIG_KEY = 'qx-export-excel-config';

// 从 localStorage 恢复上次配置(跨会话)
function loadSavedConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
  } catch {
    return {};
  }
}
const saved = loadSavedConfig();

const form = reactive({
  count: saved.count ?? 100,          // 导出总数 N
  marketStatsRatio: saved.marketStatsRatio ?? 50, // 有市场统计数据的占比(0-100%)
  name: '',                            // 任务名(可选,不持久化)
});

// 持久化配置(除 name 外)
function persistConfig() {
  try {
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ count: form.count, marketStatsRatio: form.marketStatsRatio })
    );
  } catch {
    /* 静默失败 */
  }
}

const creating = ref(false);
const downloading = ref(false);
// 创建结果(任务统计)
const result = ref(null);

// ── 当前筛选条件摘要(展示用) ───────────────────────────────
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
  if (f.keyword) parts.push(`关键词:"${f.keyword}"`);
  if (f.hasComments) parts.push('有评论');
  if (f.hasRichContent) parts.push('有富内容');
  if (f.unlisted) parts.push('未跟卖');
  if (f.cacheCompleteness === 'full') parts.push('数据完整');
  if (f.cacheCompleteness === 'partial') parts.push('数据不完整');
  if (f.excludeFilteredCategories) parts.push('排除类型过滤');
  if (f.descriptionQuality && DESC_QUALITY_LABEL[f.descriptionQuality]) {
    parts.push(`描述:${DESC_QUALITY_LABEL[f.descriptionQuality]}`);
  }
  if (f.marketStats === 'has') parts.push('有市场统计');
  else if (f.marketStats === 'none') parts.push('无市场统计');
  if (f.priceMin !== '' && f.priceMin != null) parts.push(`最低价 ${f.priceMin}`);
  if (f.priceMax !== '' && f.priceMax != null) parts.push(`最高价 ${f.priceMax}`);
  if (f.fetchedFrom || f.fetchedTo) {
    parts.push(`采集时间:${f.fetchedFrom || '…'} ~ ${f.fetchedTo || '…'}`);
  }
  return parts.length ? parts.join(' / ') : '无(全部采集箱商品)';
});

// ── 导出预览(不创建任务,弹窗打开时统计候选池) ─────────────
const preview = ref(null);
const previewLoading = ref(false);

// 构造筛选条件(与 collect-box-v2/from-cache 接口一致的字符串型参数,预览/导出共用)
function buildFilters() {
  const f = props.filters || {};
  return {
    keyword: f.keyword || '',
    unlisted: f.unlisted ? '1' : '',
    hasComments: f.hasComments ? '1' : '',
    hasRichContent: f.hasRichContent ? '1' : '',
    excludeFilteredCategories: f.excludeFilteredCategories ? '1' : '',
    priceMin: f.priceMin !== '' && f.priceMin != null ? String(f.priceMin) : '',
    priceMax: f.priceMax !== '' && f.priceMax != null ? String(f.priceMax) : '',
    minCacheHits: f.cacheCompleteness === 'full' ? '3' : '',
    maxCacheHits: f.cacheCompleteness === 'partial' ? '2' : '',
    descriptionQuality: f.descriptionQuality || '',
    marketStats: f.marketStats || '',
    fetchedFrom: f.fetchedFrom || '',
    fetchedTo: f.fetchedTo || '',
  };
}

async function loadPreview() {
  previewLoading.value = true;
  try {
    preview.value = await previewExportExcel({ filters: buildFilters() });
  } catch (err) {
    show(err.message || '预览加载失败', 'error');
    preview.value = null;
  } finally {
    previewLoading.value = false;
  }
}
onMounted(loadPreview);

// 预计导出构成:count/ratio 变化时即时重算(互补规则与后端同口径,不重复请求)
const previewBreakdown = computed(() => {
  const p = preview.value;
  if (!p) return null;
  const n = Math.max(0, Math.floor(Number(form.count) || 0));
  const r = Math.max(0, Math.min(100, Math.round(Number(form.marketStatsRatio) || 0)));
  let statsTarget = Math.round((n * r) / 100);
  let noStatsTarget = n - statsTarget;
  if (p.withStats < statsTarget) {
    noStatsTarget += statsTarget - p.withStats;
    statsTarget = p.withStats;
  }
  if (p.withoutStats < noStatsTarget) {
    statsTarget += noStatsTarget - p.withoutStats;
    noStatsTarget = p.withoutStats;
  }
  return { estimated: Math.min(n, p.poolTotal), statsTarget, noStatsTarget };
});

// 无可导出候选时禁用导出按钮
const noCandidates = computed(() => !!preview.value && preview.value.poolTotal === 0);

// ── SKU 级试算预览(按当前 count/ratio 预演最终选取结果,不创建任务、不标记已导出) ──
const skuPreview = ref(null);
const skuPreviewLoading = ref(false);

// 时间格式化(ISO-UTC 字符串/ms 时间戳 → 本地时间;与采集箱 fmtTime 同口径)
function fmtTime(t) {
  if (!t) return '—';
  const ms = typeof t === 'number' ? t : /^\d{13}$/.test(String(t)) ? Number(t) : 0;
  if (ms > 0) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const s = String(t).replace('T', ' ').slice(0, 19);
  const ms2 = Date.parse(s.replace(' ', 'T') + 'Z');
  if (!Number.isNaN(ms2)) {
    const d = new Date(ms2);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return s;
}

async function loadSkuPreview() {
  const n = Math.floor(Number(form.count));
  if (!Number.isFinite(n) || n < 1) {
    show('请输入有效的导出总数(≥1)后再预览', 'error');
    return;
  }
  if (n > 10000) {
    show('导出总数上限 10000', 'error');
    return;
  }
  skuPreviewLoading.value = true;
  try {
    const r = await previewExportExcel({
      count: n,
      marketStatsRatio: Math.max(0, Math.min(100, Math.round(Number(form.marketStatsRatio) || 0))),
      filters: buildFilters(),
    });
    skuPreview.value = r || null;
  } catch (err) {
    show(err.message || 'SKU 预览加载失败', 'error');
    skuPreview.value = null;
  } finally {
    skuPreviewLoading.value = false;
  }
}

// count/ratio 变化后旧试算结果已失真,自动清空(下次点预览按钮重新试算)
watch(
  () => [form.count, form.marketStatsRatio],
  () => {
    skuPreview.value = null;
  }
);

// ── 创建导出任务 ───────────────────────────────────────────
async function doExport() {
  const n = Math.floor(Number(form.count));
  if (!Number.isFinite(n) || n < 1) {
    show('请输入有效的导出总数(≥1)', 'error');
    return;
  }
  if (n > 10000) {
    show('导出总数上限 10000', 'error');
    return;
  }
  creating.value = true;
  result.value = null;
  try {
    persistConfig();
    const r = await createExportTask({
      count: n,
      marketStatsRatio: Math.max(0, Math.min(100, Math.round(Number(form.marketStatsRatio) || 0))),
      name: form.name.trim() || undefined,
      filters: buildFilters(),
    });
    result.value = r || null;
    skuPreview.value = null; // 已导出的 SKU 不再可选,试算结果作废
    if (r?.insufficient) {
      show(`导出完成(候选不足):实际导出 ${r.totalCount}/${r.requestedCount} 条`, 'warn');
    } else {
      show(`导出完成:${r?.totalCount ?? 0} 条(来自 ${r?.sellerCount ?? 0} 家源卖家)`, 'success');
    }
    emit('exported'); // 通知父组件刷新列表(已导出标记)
  } catch (err) {
    show(err.message || '导出失败', 'error');
  } finally {
    creating.value = false;
  }
}

// ── 下载 Excel(可多次下载) ────────────────────────────────
async function doDownload() {
  const id = result.value?.localTaskId;
  if (!id) return;
  downloading.value = true;
  try {
    await downloadExportExcel(id);
    show('已开始下载 Excel', 'success');
  } catch (err) {
    show(err.message || '下载失败', 'error');
  } finally {
    downloading.value = false;
  }
}

function goTaskList() {
  router.push('/export-tasks');
}

function close() {
  emit('close');
}
</script>

<template>
  <div class="eed-overlay">
    <div class="eed-mask" @click="close"></div>
    <div class="eed-card">
      <div class="eed-header">
        <h2>按筛选导出 Excel</h2>
        <button class="eed-close" @click="close" title="关闭">✕</button>
      </div>
      <div class="eed-body">
        <!-- 顶部信息 -->
        <div class="eed-info">
          <span>当前筛选:<b>{{ filterSummary }}</b></span>
        </div>

        <!-- 候选预览(未导出,弹窗打开时统计,不创建任务) -->
        <div class="eed-section">
          <div class="eed-section-title">
            候选预览(未导出)
            <button
              class="btn btn-sm btn-ghost eed-preview-refresh"
              :disabled="previewLoading"
              @click="loadPreview"
            >
              {{ previewLoading ? '统计中…' : '刷新' }}
            </button>
          </div>
          <template v-if="preview">
            <div class="eed-summary">
              <div class="eed-summary-item">
                <span class="eed-summary-label">可导出候选</span>
                <span class="eed-summary-cnt">{{ preview.poolTotal }}</span>
              </div>
              <div class="eed-summary-item">
                <span class="eed-summary-label">有市场统计</span>
                <span class="eed-summary-cnt">{{ preview.withStats }}</span>
              </div>
              <div class="eed-summary-item">
                <span class="eed-summary-label">无市场统计</span>
                <span class="eed-summary-cnt">{{ preview.withoutStats }}</span>
              </div>
              <div class="eed-summary-item">
                <span class="eed-summary-label">覆盖卖家</span>
                <span class="eed-summary-cnt">{{ preview.sellerCount }}</span>
              </div>
              <div v-if="preview.noPrice > 0" class="eed-summary-item">
                <span class="eed-summary-label">无价格排除</span>
                <span class="eed-summary-cnt">{{ preview.noPrice }}</span>
              </div>
              <div v-if="preview.skippedExported > 0" class="eed-summary-item">
                <span class="eed-summary-label">已导出跳过</span>
                <span class="eed-summary-cnt">{{ preview.skippedExported }}</span>
              </div>
            </div>
            <div v-if="noCandidates" class="eed-warn" style="margin-top: 8px">
              没有符合条件的未导出 SKU{{
                preview.matchedTotal > 0 ? `(匹配 ${preview.matchedTotal} 条均无有效价格)` : ''
              }},请调整筛选条件后再导出
            </div>
            <div v-else-if="previewBreakdown" class="muted small" style="margin-top: 8px">
              预计导出 {{ previewBreakdown.estimated }} 条:有市场统计 {{ previewBreakdown.statsTarget }} 条 +
              无市场统计 {{ previewBreakdown.noStatsTarget }} 条(某组不足时从另一组补足)
            </div>
          </template>
          <div v-else class="muted small">{{ previewLoading ? '候选统计中…' : '暂无预览数据' }}</div>
        </div>

        <!-- 配置区 -->
        <div class="eed-section">
          <div class="eed-form-row">
            <label class="eed-field">
              <span>导出总数 N</span>
              <input type="number" min="1" step="1" max="10000" v-model.number="form.count" />
            </label>
            <label class="eed-field">
              <span>有市场统计数据的占比(%)</span>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                v-model.number="form.marketStatsRatio"
              />
            </label>
          </div>
          <div class="muted small" style="margin-top: 6px">
            已导出过的 SKU 强制跳过;按来源卖家均衡选取,尽可能多地覆盖源店铺
          </div>
          <div class="eed-form-row" style="margin-top: 10px">
            <button
              class="btn btn-ghost"
              :disabled="skuPreviewLoading || noCandidates"
              :title="noCandidates ? '没有符合条件的未导出 SKU' : '按当前 N 与占比预演最终选取结果(不创建任务、不标记已导出)'"
              @click="loadSkuPreview"
            >
              {{ skuPreviewLoading ? '试算中…' : '预览选取 SKU' }}
            </button>
            <span class="muted small">按当前 N 与占比试算最终选取的 SKU 明细</span>
          </div>
        </div>

        <!-- SKU 试算预览结果(点"预览选取 SKU"后显示) -->
        <div v-if="skuPreview" class="eed-section">
          <div class="eed-section-title">选取试算(未导出)</div>
          <div class="eed-summary">
            <div class="eed-summary-item">
              <span class="eed-summary-label">试算选取</span>
              <span class="eed-summary-cnt">{{ skuPreview.pickedCount ?? 0 }}</span>
            </div>
            <div class="eed-summary-item">
              <span class="eed-summary-label">有市场统计</span>
              <span class="eed-summary-cnt">{{ skuPreview.pickedStatsCount ?? 0 }}</span>
            </div>
            <div class="eed-summary-item">
              <span class="eed-summary-label">来源卖家</span>
              <span class="eed-summary-cnt">{{ skuPreview.pickedSellerCount ?? 0 }}</span>
            </div>
          </div>
          <div class="muted small" style="margin-top: 8px">
            实际采集时间范围:{{
              skuPreview.pickedTimeRange
                ? `${fmtTime(skuPreview.pickedTimeRange.from)} ~ ${fmtTime(skuPreview.pickedTimeRange.to)}`
                : '—(所选 SKU 均无采集时间)'
            }}
          </div>
          <div v-if="skuPreview.items && skuPreview.items.length" class="eed-item-table-wrap">
            <table class="eed-item-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>SKU</th>
                  <th>原价格</th>
                  <th>评论数</th>
                  <th>市场统计</th>
                  <th>采集时间</th>
                  <th>卖家</th>
                  <th>名称</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="it in skuPreview.items" :key="it.sku">
                  <td>{{ it.seq }}</td>
                  <td class="eed-item-sku">{{ it.sku }}</td>
                  <td>{{ it.price ?? '—' }}</td>
                  <td>{{ it.ratingCount ?? '—' }}</td>
                  <td>{{ it.marketStats ? '有' : '无' }}</td>
                  <td>{{ fmtTime(it.lastFetchedAt) }}</td>
                  <td :title="it.sellerId">{{ it.sellerName || it.sellerId || '—' }}</td>
                  <td class="eed-item-name" :title="it.name">{{ it.name || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="muted small" style="margin-top: 6px">
            明细最多展示 1000 条{{
              (skuPreview.pickedCount || 0) > 1000 ? `(共 ${skuPreview.pickedCount} 条)` : ''
            }};试算与最终导出走同一选取逻辑,两次请求之间数据变化可能导致结果略有差异
          </div>
        </div>

        <div class="eed-section">
          <div class="eed-section-title">任务名称(可选)</div>
          <input
            type="text"
            class="eed-input"
            v-model.trim="form.name"
            placeholder="留空则自动生成"
          />
        </div>

        <div class="eed-section">
          <div class="eed-section-title">Excel 列与价格规则</div>
          <div class="muted small eed-rules">
            列:SKU / 评论数 / 原价格 / 跟卖价格 / 跟卖最低价格 / "SKU, 跟卖价格, 跟卖最低价格"组合列<br />
            跟卖价格 = 原价格 ≤ 15 ? 19 : 原价格(Excel 公式 IF 实现,改原价格列可联动重算)<br />
            跟卖最低价格 = 跟卖价格 − 0.01(公式实现)
          </div>
        </div>

        <div class="eed-actions">
          <button class="btn btn-ghost" @click="close">取消</button>
          <button
            class="btn btn-primary"
            :disabled="creating || noCandidates"
            :title="noCandidates ? '没有符合条件的未导出 SKU,请调整筛选条件' : ''"
            @click="doExport"
          >
            {{ creating ? '导出中…' : '确认导出' }}
          </button>
        </div>

        <!-- 导出结果 -->
        <template v-if="result">
          <div class="eed-section">
            <div class="eed-section-title">导出结果</div>
            <div class="eed-summary">
              <div class="eed-summary-item">
                <span class="eed-summary-label">实际导出</span>
                <span class="eed-summary-cnt">{{ result.totalCount }}</span>
              </div>
              <div class="eed-summary-item">
                <span class="eed-summary-label">请求</span>
                <span class="eed-summary-cnt">{{ result.requestedCount }}</span>
              </div>
              <div class="eed-summary-item">
                <span class="eed-summary-label">有市场统计</span>
                <span class="eed-summary-cnt">{{ result.marketStatsCount }}</span>
              </div>
              <div class="eed-summary-item">
                <span class="eed-summary-label">来源卖家</span>
                <span class="eed-summary-cnt">{{ result.sellerCount }}</span>
              </div>
              <div class="eed-summary-item">
                <span class="eed-summary-label">跳过(已导出)</span>
                <span class="eed-summary-cnt">{{ result.skippedCount }}</span>
              </div>
            </div>
            <div v-if="result.insufficient" class="eed-warn">
              候选不足,实际导出 {{ result.totalCount }} / 请求 {{ result.requestedCount }} 条
            </div>
          </div>
          <div class="eed-actions">
            <button class="btn btn-ghost" @click="goTaskList">查看历史任务</button>
            <button class="btn btn-primary" :disabled="downloading" @click="doDownload">
              {{ downloading ? '下载中…' : '下载 Excel' }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 弹窗样式:与 AutoPickBatchDialog 风格一致(前缀 eed = export excel dialog) */
.eed-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}
.eed-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
}
.eed-card {
  position: relative;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  /* 与"按筛选自动上架"弹窗(AutoPickBatchDialog)宽度对齐 */
  width: 880px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.eed-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, #e4e8ee);
}
.eed-header h2 {
  margin: 0;
  font-size: 16px;
}
.eed-close {
  border: none;
  background: transparent;
  font-size: 22px;
  line-height: 1;
  color: var(--muted, #6b7280);
  cursor: pointer;
  padding: 0 4px;
}
.eed-close:hover {
  color: var(--text, #1f2937);
}
.eed-body {
  padding: 16px 20px;
  overflow: auto;
}
.eed-info {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--muted, #6b7280);
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.eed-info b {
  color: var(--text, #1f2937);
  font-weight: 600;
}
.eed-section {
  margin-bottom: 16px;
}
.eed-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #1f2937);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.eed-preview-refresh {
  margin-left: auto;
}
.eed-form-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}
.eed-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  flex: 1;
  min-width: 220px;
}
.eed-field input,
.eed-input {
  padding: 6px 10px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
}
.eed-field input:focus,
.eed-input:focus {
  outline: none;
  border-color: var(--primary, #2563eb);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
.eed-input {
  width: 100%;
}
.eed-rules {
  line-height: 1.8;
  padding: 8px 10px;
  background: #f9fafb;
  border: 1px dashed var(--border, #e4e8ee);
  border-radius: 6px;
}
.eed-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border, #e4e8ee);
}
.eed-summary {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.eed-summary-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  font-size: 13px;
  background: #f9fafb;
}
.eed-summary-label {
  color: var(--muted, #6b7280);
}
.eed-summary-cnt {
  font-weight: 600;
  color: var(--primary, #2563eb);
}
.eed-warn {
  margin-top: 8px;
  padding: 6px 10px;
  background: #fff7e6;
  border: 1px solid #ffd591;
  border-radius: 4px;
  color: #d46b08;
  font-size: 12px;
}
/* SKU 试算明细表(可滚动,表头吸顶) */
.eed-item-table-wrap {
  margin-top: 8px;
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
}
.eed-item-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.eed-item-table th,
.eed-item-table td {
  padding: 4px 8px;
  border-bottom: 1px solid #f0f1f3;
  text-align: left;
  white-space: nowrap;
}
.eed-item-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #f9fafb;
  font-weight: 600;
}
.eed-item-sku {
  font-family: ui-monospace, Consolas, monospace;
}
.eed-item-name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
