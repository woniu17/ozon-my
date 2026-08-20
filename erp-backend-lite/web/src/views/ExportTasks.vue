<script setup>
// 导出任务列表页(2026-08 采集箱按筛选导出 Excel)
// 展示历史导出任务,支持多次下载 Excel(后端按明细重新生成)与查看导出明细
import { reactive, ref, onMounted } from 'vue';
import { getExportTaskList, getExportTaskDetail, downloadExportExcel } from '../api/exportExcel.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();

const state = reactive({
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 20,
});

// 当前展开查看明细的任务
const detail = ref(null);
const detailLoading = ref(false);
const downloadingId = ref('');

async function loadList() {
  state.loading = true;
  try {
    const data = await getExportTaskList({
      currentPage: state.page,
      pageSize: state.pageSize,
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

function onPageChange(p) {
  state.page = p;
  loadList();
}

// 展开/收起任务明细
async function toggleDetail(task) {
  if (detail.value?.localTaskId === task.localTaskId) {
    detail.value = null;
    return;
  }
  detailLoading.value = true;
  try {
    const d = await getExportTaskDetail(task.localTaskId);
    detail.value = d || null;
  } catch (err) {
    show(err.message || '明细加载失败', 'error');
  } finally {
    detailLoading.value = false;
  }
}

// 下载 Excel(可多次下载)
async function doDownload(task) {
  downloadingId.value = task.localTaskId;
  try {
    await downloadExportExcel(task.localTaskId);
    show('已开始下载 Excel', 'success');
    // 刷新下载次数显示
    task.downloadCount = (task.downloadCount || 0) + 1;
  } catch (err) {
    show(err.message || '下载失败', 'error');
  } finally {
    downloadingId.value = '';
  }
}

function fmtTime(t) {
  if (!t) return '—';
  const s = String(t).trim();
  if (!s) return '—';
  let d;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    d = new Date(s);
  } else {
    d = new Date(s.replace(' ', 'T') + 'Z');
  }
  if (isNaN(d.getTime())) return s;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' +
    pad(d.getMonth() + 1) + '-' +
    pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' +
    pad(d.getMinutes()) + ':' +
    pad(d.getSeconds())
  );
}

onMounted(() => {
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>导出任务</h2>
      <button class="btn btn-ghost" :disabled="state.loading" @click="loadList">
        {{ state.loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div class="et-table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width: 200px">任务 ID</th>
            <th>名称</th>
            <th style="width: 110px">导出 / 请求</th>
            <th style="width: 110px">有市场统计</th>
            <th style="width: 90px">来源卖家</th>
            <th style="width: 90px">跳过(已导出)</th>
            <th style="width: 90px">下载次数</th>
            <th style="width: 160px">创建时间</th>
            <th style="width: 160px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!state.items.length && !state.loading">
            <td colspan="9" class="muted" style="text-align: center; padding: 24px">
              暂无导出任务,去采集箱"按筛选导出"创建
            </td>
          </tr>
          <template v-for="t in state.items" :key="t.localTaskId">
            <tr>
              <td class="et-sku">{{ t.localTaskId }}</td>
              <td class="et-name" :title="t.name || ''">{{ t.name || '—' }}</td>
              <td>
                <b :class="{ 'et-insufficient': t.totalCount < t.requestedCount }">
                  {{ t.totalCount }}
                </b>
                / {{ t.requestedCount }}
              </td>
              <td>{{ t.marketStatsCount }}(占比 {{ t.marketStatsRatio }}%)</td>
              <td>{{ t.sellerCount }}</td>
              <td>{{ t.skippedCount }}</td>
              <td>{{ t.downloadCount }}</td>
              <td>{{ fmtTime(t.createdAt) }}</td>
              <td>
                <button
                  class="btn btn-sm btn-ghost"
                  :disabled="detailLoading"
                  @click="toggleDetail(t)"
                >
                  {{ detail?.localTaskId === t.localTaskId ? '收起明细' : '查看明细' }}
                </button>
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="downloadingId === t.localTaskId"
                  @click="doDownload(t)"
                >
                  {{ downloadingId === t.localTaskId ? '下载中…' : '下载 Excel' }}
                </button>
              </td>
            </tr>
            <!-- 任务明细(展开行) -->
            <tr v-if="detail?.localTaskId === t.localTaskId" class="et-detail-row">
              <td colspan="9">
                <div v-if="detailLoading" class="muted" style="padding: 12px">明细加载中…</div>
                <div v-else class="et-detail-wrap">
                  <table class="data-table et-detail-table">
                    <thead>
                      <tr>
                        <th style="width: 50px">序号</th>
                        <th>SKU</th>
                        <th>商品名</th>
                        <th style="width: 80px">评论数</th>
                        <th style="width: 100px">原价格</th>
                        <th style="width: 100px">跟卖价格</th>
                        <th style="width: 100px">跟卖最低价格</th>
                        <th style="width: 90px">市场统计</th>
                        <th>来源卖家</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="it in detail.items || []" :key="it.sku">
                        <td>{{ it.seq }}</td>
                        <td class="et-sku">{{ it.sku }}</td>
                        <td class="et-name" :title="it.name || ''">{{ it.name || '—' }}</td>
                        <td>{{ it.ratingCount != null ? it.ratingCount : '—' }}</td>
                        <td>{{ it.priceValue ?? '—' }}</td>
                        <td>{{ it.salePrice ?? '—' }}</td>
                        <td>{{ it.salePrice != null ? Math.round((it.salePrice - 0.01) * 100) / 100 : '—' }}</td>
                        <td>
                          <span class="tag" :class="it.marketStats ? 'tag-ok' : 'tag-warn'">
                            {{ it.marketStats ? '有' : '无' }}
                          </span>
                        </td>
                        <td class="et-sku">{{ it.sellerId || '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <AppPager
      :modelValue="state.page"
      :total="state.total"
      :pageSize="state.pageSize"
      @update:modelValue="onPageChange"
    />
  </div>
</template>

<style scoped>
.et-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  background: #fff;
}
.et-sku {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}
.et-name {
  font-size: 12px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.et-insufficient {
  color: #d97706;
}
.et-detail-row > td {
  background: #f9fafb;
  padding: 8px 12px;
}
.et-detail-wrap {
  max-height: 420px;
  overflow: auto;
  border: 1px solid var(--border, #e4e8ee);
  border-radius: 6px;
  background: #fff;
}
.et-detail-table {
  margin: 0;
}
</style>
