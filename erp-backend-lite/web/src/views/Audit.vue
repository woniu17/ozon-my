<script setup>
import { reactive, onMounted } from 'vue';
import { getAuditLogs } from '../api/audit.js';
import { useToast } from '../components/useToast.js';
import AppPager from '../components/AppPager.vue';

const { show } = useToast();

// 操作类型 → 中文标签(参考原 admin.js AUDIT_ACTION_LABEL)
const AUDIT_ACTION_LABEL = {
  'store.create': '创建店铺',
  'store.update': '更新店铺',
  'store.delete': '删除店铺',
  'listing.import': '上架提交',
  'listing.importReport': '上架报告',
  'collect.create': '采集新增',
  'collect.batchCreate': '批量采集',
  'collect.delete': '采集删除',
  'collect.update': '采集更新',
  'config.update': '配置变更',
  'watermark.create': '水印模板新增',
  'watermark.update': '水印模板变更',
  'batch.create': '批量上架创建',
  'batch.delete': '批量上架删除',
  'batch.retry': '批量重试',
};

// 操作类型下拉选项(全部 + 各 action)
const actionOptions = Object.entries(AUDIT_ACTION_LABEL).map(([value, label]) => ({ value, label }));

const state = reactive({
  items: [],
  total: 0,
  loading: false,
  page: 1,
  pageSize: 20,
  filters: {
    keyword: '',
    action: '',
    dateFrom: '',
    dateTo: '',
  },
});

async function loadList() {
  state.loading = true;
  try {
    // 字段映射:page→currentPage,keyword→operator(LIKE),dateFrom→startDate,dateTo→endDate
    const data = await getAuditLogs({
      currentPage: state.page,
      pageSize: state.pageSize,
      action: state.filters.action,
      operator: state.filters.keyword.trim(),
      startDate: state.filters.dateFrom,
      endDate: state.filters.dateTo,
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
  loadList();
}

// 翻页:先更新页码再加载
function onPageChange(p) {
  state.page = p;
  loadList();
}

// ── 渲染辅助 ───────────────────────────────────────────────
function actionLabel(action) {
  return AUDIT_ACTION_LABEL[action] || action || '—';
}

function fmtTime(t) {
  if (!t) return '—';
  return String(t).replace('T', ' ').slice(0, 19);
}

// detail 后端返回为对象,统一序列化为字符串(与原 admin.js 一致)
function detailStr(row) {
  const d = row?.detail;
  if (d === null || d === undefined || d === '') return '-';
  if (typeof d === 'string') return d;
  try {
    return JSON.stringify(d);
  } catch (_) {
    return String(d);
  }
}

function truncate(str, len = 100) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

onMounted(() => {
  loadList();
});
</script>

<template>
  <div>
    <div class="toolbar">
      <h2>操作日志</h2>
      <button class="btn btn-ghost" :disabled="state.loading" @click="loadList">
        {{ state.loading ? '刷新中...' : '刷新' }}
      </button>
    </div>

    <div class="filter-bar">
      <select class="filter-select" v-model="state.filters.action">
        <option value="">全部操作</option>
        <option v-for="opt in actionOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <input
        class="filter-input"
        type="text"
        v-model.trim="state.filters.keyword"
        placeholder="搜索操作人"
        @keydown.enter="search"
      />
      <input class="filter-input" type="date" v-model="state.filters.dateFrom" />
      <input class="filter-input" type="date" v-model="state.filters.dateTo" />
      <button class="btn btn-primary" @click="search">查询</button>
    </div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>操作</th>
            <th>操作人</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="state.loading && !state.items.length">
            <td colspan="4" class="muted" style="padding: 24px; text-align: center">加载中...</td>
          </tr>
          <tr v-else-if="!state.items.length">
            <td colspan="4" class="empty">暂无操作日志</td>
          </tr>
          <tr v-for="row in state.items" :key="row.id">
            <td>{{ fmtTime(row.createdAt) }}</td>
            <td>{{ actionLabel(row.action) }}</td>
            <td>{{ row.operator || '—' }}</td>
            <td class="audit-detail-cell audit-detail" :title="detailStr(row)">{{ truncate(detailStr(row)) }}</td>
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
  </div>
</template>
