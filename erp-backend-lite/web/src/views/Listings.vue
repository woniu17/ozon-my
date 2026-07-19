<script setup>
import { ref, reactive, onMounted } from 'vue';
import { getListings } from '../api/listings.js';
import { get } from '../api/request.js';
import { useStoresStore } from '../stores/stores.js';
import { useToast } from '../components/useToast.js';
import AppModal from '../components/AppModal.vue';
import AppPager from '../components/AppPager.vue';

const storesStore = useStoresStore();
const { show } = useToast();

// ── 列表状态 ───────────────────────────────────────────────
const state = reactive({
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 20,
  filters: {
    storeId: '',
    keyword: '',
    status: '',
    dateFrom: '',
    dateTo: '',
  },
});

async function loadListings() {
  state.loading = true;
  try {
    const data = await getListings({
      currentPage: state.page,
      pageSize: state.pageSize,
      storeId: state.filters.storeId,
      keyword: state.filters.keyword.trim(),
      status: state.filters.status,
      dateFrom: state.filters.dateFrom,
      dateTo: state.filters.dateTo,
    });
    state.items = data?.items || [];
    state.total = data?.total || 0;
  } catch (err) {
    show(err.message || String(err), 'error');
    state.items = [];
    state.total = 0;
  } finally {
    state.loading = false;
  }
}

// 查询:重置到第 1 页后加载
function search() {
  state.page = 1;
  loadListings();
}

// 翻页:先更新页码再加载,确保读取最新 page
function onPageChange(p) {
  state.page = p;
  loadListings();
}

// ── 详情弹窗 ───────────────────────────────────────────────
const detailOpen = ref(false);
const detailLoading = ref(false);
const detailTask = ref(null);
const detailItems = ref([]);
// 详情弹窗内的 tab:items=商品明细 / payloads=请求体与响应
const detailTab = ref('items');
// 请求体与响应(raw / transformed / opi_request / opi_response)
const detailPayloads = ref([]);
const detailPayloadsLoading = ref(false);
// 当前选中的 payload stage
const activePayloadStage = ref('');

async function openDetail(localTaskId) {
  detailOpen.value = true;
  detailLoading.value = true;
  detailTab.value = 'items';
  detailTask.value = null;
  detailItems.value = [];
  detailPayloads.value = [];
  activePayloadStage.value = '';
  try {
    const data = await get('/admin/api/listing-records/' + encodeURIComponent(localTaskId));
    detailTask.value = data?.task || null;
    detailItems.value = data?.items || [];
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detailLoading.value = false;
  }
}

// 切到「请求体与响应」tab 时按需加载 payloads(只拉一次)
async function ensurePayloadsLoaded() {
  if (!detailTask.value || detailPayloads.value.length > 0) return;
  detailPayloadsLoading.value = true;
  try {
    const data = await get(
      '/admin/api/listing-records/' + encodeURIComponent(detailTask.value.localTaskId) + '/payloads'
    );
    const stages = data?.stages || [];
    detailPayloads.value = stages;
    // 默认选中第一个 stage
    if (stages.length > 0 && !activePayloadStage.value) {
      activePayloadStage.value = stages[stages.length - 1].stage;
    }
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    detailPayloadsLoading.value = false;
  }
}

function switchTab(tab) {
  detailTab.value = tab;
  if (tab === 'payloads') ensurePayloadsLoaded();
}

// payload 展示标签映射
const STAGE_LABEL = {
  raw: '插件原始 (raw)',
  transformed: '转换后 (transformed)',
  opi_request: 'OPI 请求体 (opi_request)',
  opi_response: 'OPI 查询响应 (opi_response)',
};
function stageLabel(st) {
  return STAGE_LABEL[st] || st;
}

// 格式化 JSON 展示(2 空格缩进)
function prettyJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

// 按 stage 排序:raw → transformed → opi_request → opi_response
const STAGE_ORDER = ['raw', 'transformed', 'opi_request', 'opi_response'];
function sortedPayloads(list) {
  return [...list].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
  );
}

// ── 渲染辅助 ───────────────────────────────────────────────
function storeName(storeId) {
  const s = storesStore.list.find((x) => x.id === storeId);
  return s?.name || storeId || '—';
}

const STATUS_MAP = {
  SUCCESS: { cls: 'badge-success', label: '成功' },
  FAILED: { cls: 'badge-failed', label: '失败' },
  PROCESSING: { cls: 'badge-processing', label: '处理中' },
  PENDING: { cls: 'badge-pending', label: '待处理' },
};
function statusInfo(st) {
  return STATUS_MAP[st] || { cls: 'badge-pending', label: st || '—' };
}

function fmtTime(t) {
  if (!t) return '—';
  return String(t).replace('T', ' ').slice(0, 19);
}

// 列表行:成功/失败计数(summary 可能为 null)
function resultText(r) {
  const s = r.summary || { imported: 0, failed: 0 };
  return `✓${s.imported || 0} ✗${s.failed || 0}`;
}

// 详情:从 items 数组按"有效状态"计数(imported + hasError 计为 failed)
function countByStatus(items, st) {
  return (items || []).filter((i) => effectiveStatus(i) === st).length;
}

const ITEM_STATUS_LABEL = {
  imported: '已创建',
  failed: '失败',
  pending: '处理中',
  skipped: '跳过',
};
function itemStatusLabel(st) {
  return ITEM_STATUS_LABEL[st] || st || '—';
}

// 详情列表行状态展示(根据 status + hasError + hasWarning 组合判断):
//   - imported + hasError   → "审核拒绝"(红色,实质失败)
//   - imported + hasWarning → "已创建(有警告)"(黄色,成功但有警告)
//   - imported + 无错误     → "已创建"(绿色)
//   - failed                → "失败"(红色)
//   - pending/skipped       → 原状态
function itemDisplayStatus(it) {
  if (it.status === 'imported' && it.hasError) return { label: '审核拒绝', cls: 'is-failed' };
  if (it.status === 'imported' && it.hasWarning) return { label: '已创建(有警告)', cls: 'is-warning' };
  if (it.status === 'imported') return { label: '已创建', cls: 'is-imported' };
  if (it.status === 'failed') return { label: '失败', cls: 'is-failed' };
  if (it.status === 'pending') return { label: '处理中', cls: 'is-pending' };
  if (it.status === 'skipped') return { label: '跳过', cls: 'is-skipped' };
  return { label: it.status || '—', cls: '' };
}

// 详情列表:成功/失败计数按"有效状态"计算
// imported + hasError → 计为失败;其余按 status
function effectiveStatus(it) {
  if (it.status === 'imported' && it.hasError) return 'failed';
  return it.status;
}

// 商品错误信息拼接(对齐原 admin.js renderListingDetailItems)
function itemErrorText(it) {
  const errs = it.errors || [];
  if (!errs.length) return '';
  return errs
    .map(
      (e) =>
        `${e.message || e.description || e.code || ''}${e.field ? ` [${e.field}]` : ''}${e.attribute_name ? ` (${e.attribute_name})` : ''}`
    )
    .filter(Boolean)
    .join('; ');
}

onMounted(() => {
  storesStore.load();
  loadListings();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>上架记录</h2>
      <button class="btn btn-ghost" :disabled="state.loading" @click="loadListings">
        {{ state.loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <div class="filter-bar">
      <select class="filter-select" v-model="state.filters.storeId">
        <option value="">全部店铺</option>
        <option v-for="s in storesStore.list" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <input
        class="filter-input"
        type="text"
        v-model.trim="state.filters.keyword"
        placeholder="搜索任务ID / Ozon Task ID / 跟卖SKU"
        @keydown.enter="search"
      />
      <select class="filter-select" v-model="state.filters.status">
        <option value="">全部状态</option>
        <option value="SUCCESS">成功</option>
        <option value="FAILED">失败</option>
        <option value="PROCESSING">处理中</option>
      </select>
      <input class="filter-input" type="date" v-model="state.filters.dateFrom" />
      <span class="muted">至</span>
      <input class="filter-input" type="date" v-model="state.filters.dateTo" />
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="listings-table-wrap">
      <table class="listings-table">
        <thead>
          <tr>
            <th class="col-task">任务ID</th>
            <th class="col-store">店铺</th>
            <th>SKU 数</th>
            <th>成功/失败</th>
            <th>状态</th>
            <th class="col-time">创建时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="7" class="muted" style="padding: 24px; text-align: center">加载中...</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="7" class="muted" style="padding: 24px; text-align: center">暂无上架记录</td>
          </tr>
          <tr v-for="r in state.items" :key="r.localTaskId">
            <td class="col-task" :title="r.localTaskId">{{ r.localTaskId }}</td>
            <td class="col-store">{{ storeName(r.storeId) }}</td>
            <td>{{ r.itemsCount }}</td>
            <td class="col-result">{{ resultText(r) }}</td>
            <td>
              <span class="badge" :class="statusInfo(r.status).cls">{{ statusInfo(r.status).label }}</span>
            </td>
            <td class="col-time">{{ fmtTime(r.createdAt) }}</td>
            <td class="col-actions">
              <button class="btn btn-sm btn-ghost" @click="openDetail(r.localTaskId)">查看详情</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <AppPager
      :modelValue="state.page"
      :total="state.total"
      :pageSize="state.pageSize"
      @update:modelValue="onPageChange"
    />

    <!-- 详情弹窗 -->
    <AppModal :open="detailOpen" title="上架记录详情" size="lg" @update:open="detailOpen = $event">
      <div v-if="detailLoading" class="empty">加载中...</div>
      <template v-else-if="detailTask">
        <div class="listing-detail-meta">
          <div class="meta-row">
            <span class="meta-k">任务 ID</span><span class="meta-v">{{ detailTask.localTaskId }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">店铺</span><span class="meta-v">{{ storeName(detailTask.storeId) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">创建时间</span><span class="meta-v">{{ fmtTime(detailTask.createdAt) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">完成时间</span><span class="meta-v">{{ fmtTime(detailTask.completedAt) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">状态</span>
            <span class="meta-v">
              <span class="badge" :class="statusInfo(detailTask.status).cls">{{
                statusInfo(detailTask.status).label
              }}</span>
            </span>
          </div>
          <div class="meta-row">
            <span class="meta-k">总计</span><span class="meta-v">{{ detailTask.itemsCount }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">成功</span><span class="meta-v">{{ countByStatus(detailItems, 'imported') }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-k">失败</span><span class="meta-v">{{ countByStatus(detailItems, 'failed') }}</span>
          </div>
        </div>

        <!-- Tab 切换:商品明细 / 请求体与响应 -->
        <div class="detail-tabs">
          <button
            class="detail-tab-btn"
            :class="{ active: detailTab === 'items' }"
            @click="switchTab('items')"
          >
            商品明细
          </button>
          <button
            class="detail-tab-btn"
            :class="{ active: detailTab === 'payloads' }"
            @click="switchTab('payloads')"
          >
            请求体与响应
          </button>
        </div>

        <!-- 商品明细 -->
        <div v-if="detailTab === 'items'">
          <table class="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>状态</th>
                <th>错误信息</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!detailItems.length">
                <td colspan="3" class="muted" style="padding: 16px; text-align: center">
                  无明细数据(可能任务尚未完成或未上报)
                </td>
              </tr>
              <tr v-for="(it, idx) in detailItems" :key="idx">
                <td class="col-task">{{ it.offerId || '—' }}</td>
                <td>
                  <span class="item-status" :class="itemDisplayStatus(it).cls">
                    {{ itemDisplayStatus(it).label }}
                  </span>
                </td>
                <td>
                  <span v-if="itemErrorText(it)">{{ itemErrorText(it) }}</span>
                  <span v-else style="color: #52c41a">无错误</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 请求体与响应 -->
        <div v-else-if="detailTab === 'payloads'">
          <div v-if="detailPayloadsLoading" class="empty">加载中...</div>
          <template v-else>
            <div v-if="!detailPayloads.length" class="empty" style="padding: 16px">
              无请求体备份(可能为模拟手动上架 viaPortal,或数据未保存)
            </div>
            <template v-else>
              <!-- stage 切换 -->
              <div class="payload-stage-tabs">
                <button
                  v-for="p in sortedPayloads(detailPayloads)"
                  :key="p.stage"
                  class="payload-stage-btn"
                  :class="{ active: activePayloadStage === p.stage }"
                  @click="activePayloadStage = p.stage"
                >
                  {{ stageLabel(p.stage) }}
                </button>
              </div>
              <!-- 当前 stage 内容 -->
              <div
                v-for="p in detailPayloads"
                :key="p.stage"
                v-show="activePayloadStage === p.stage"
                class="payload-block"
              >
                <div class="payload-meta">
                  <span class="muted">时间:{{ fmtTime(p.createdAt) }}</span>
                </div>
                <pre class="payload-json">{{ prettyJson(p.payload) }}</pre>
              </div>
            </template>
          </template>
        </div>
      </template>
      <div v-else class="empty">无数据</div>
    </AppModal>
  </div>
</template>
