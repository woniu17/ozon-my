<script setup>
// 打印货运标签(2026-10-25,设计文档: docs/打印货运标签-功能设计.md)
// 所有店铺的发运合并为一个列表,按发运日期倒序展示最近 5 个货运标签;
// 支持按店铺+货运标签 ID 搜索;每行显示是否已打印,行内预览/打印。
// 打印组件与扫描发货页一致:本机菜鸟组件 + 服务器组件双通道(前端双通道打印)。
import { ref, reactive, computed, onMounted } from 'vue';
import { getStores } from '../api/stores.js';
import {
  getAllPrinters,
  fetchContainerLabel,
  fetchContainerLabels,
  fetchContainerLabelPrintStatus,
  printContainerLabelImage,
  parsePrinter,
  encodePrinter,
} from '../api/print-agent.js';
import { useToast } from '../components/useToast.js';

const { show } = useToast();

// ── 店铺与合并列表 ────────────────────────────────────
const stores = ref([]);
const merged = reactive({ carriages: [], loaded: false, loading: false });

// 搜索(指定店铺)
const searchStoreId = ref('');
const searchId = ref('');
const searching = ref(false);
const searchRow = ref(null); // 搜索命中行(不在最近 5 个中时追加到顶部)

// 预览
const pdfUrl = ref('');
const pdfSize = ref(0);
const loadingPdfId = ref(null); // 正在拉 PDF 的 labelId

// 打印
const printingId = ref(null);

// ── 打印机组(同 ScanShip:本机 + 服务器双通道)────────────
const agentOnline = ref(null);      // 本机菜鸟组件:null=探测中 true/false
const serverOnline = ref(null);     // 服务器转发组件:null=探测中 true/false
const printers = ref([]);           // 本机组件打印机名列表
const defaultPrinter = ref('');     // 本机组件默认打印机
const serverPrinters = ref([]);     // 服务器组件打印机名列表
const serverDefaultPrinter = ref(''); // 服务器组件默认打印机
const selectedPrinter = ref('');    // 指定打印机(编码 local:/server:),''=自动

// Ozon carriage 状态文案(未知值原样展示)
const CARRIAGE_STATUS_LABELS = {
  formed: '已形成',
  created: '已创建',
  awaiting_delivery: '待发运',
  delivering: '运输中',
  delivered: '已送达',
  cancelled: '已取消',
};
function carriageStatusLabel(status) {
  return CARRIAGE_STATUS_LABELS[status] || status || '—';
}

function fmtSize(n) {
  if (!n) return '';
  return n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB';
}

// 汇总单个店铺所有配送方式下的发运(过滤 id<=0 的占位行),附店铺信息
function extractStoreCarriages(methods, storeId, storeName) {
  const all = [];
  for (const m of methods || []) {
    for (const c of m.carriages || []) {
      if (!Number(c.id) || Number(c.id) <= 0) continue;
      all.push({
        ...c,
        store_id: storeId,
        store_name: storeName || storeId,
        delivery_method_name: m.delivery_method_name || '',
        departure_date: m.departure_date || '',
      });
    }
  }
  return all;
}

// 并行加载所有店铺 → 合并 → 按发运日期倒序取最近 5 个
async function loadAllLabels() {
  if (merged.loading) return;
  merged.loading = true;
  try {
    const results = await Promise.all(
      stores.value.map(async (s) => {
        try {
          const data = await fetchContainerLabels(s.id, '', 1000);
          return extractStoreCarriages(data?.methods, s.id, s.name);
        } catch (err) {
          console.warn(`[container-label] ${s.name} 加载失败:`, err.message);
          return [];
        }
      })
    );
    const all = results.flat();
    // departure_date 为 YYYY-MM-DD,字符串可直接倒序;同日按 id 倒序
    all.sort((a, b) => (b.departure_date || '').localeCompare(a.departure_date || '') || Number(b.id) - Number(a.id));
    merged.carriages = all.slice(0, 5);
    merged.loaded = true;
    // 打印状态需按店铺查询,逐条回填
    for (const c of merged.carriages) c.printed = false;
    const byStore = new Map();
    for (const c of merged.carriages) {
      if (!byStore.has(c.store_id)) byStore.set(c.store_id, []);
      byStore.get(c.store_id).push(c);
    }
    await Promise.all(
      [...byStore.entries()].map(async ([storeId, rows]) => {
        try {
          const ids = rows.map((c) => Number(c.id)).filter((n) => Number.isInteger(n) && n > 0);
          if (!ids.length) return;
          const { printed } = await fetchContainerLabelPrintStatus(storeId, ids);
          for (const c of rows) c.printed = !!printed[Number(c.id)];
        } catch { /* 忽略 */ }
      })
    );
  } finally {
    merged.loading = false;
  }
}

// 当前表格行:最近 5 个 + (搜索结果不在其中时)搜索结果行
function currentCarriages() {
  const rows = merged.carriages.slice();
  if (searchRow.value && !rows.some((c) => Number(c.id) === Number(searchRow.value.id))) {
    rows.unshift(searchRow.value);
  }
  return rows;
}

// ── 搜索 ─────────────────────────────────────────────
async function onSearch() {
  const raw = String(searchId.value || '').trim();
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    show('请输入正确的货运标签 ID(正整数)', 'error');
    return;
  }
  if (!searchStoreId.value) {
    show('请先选择搜索的店铺', 'error');
    return;
  }
  searching.value = true;
  const labelId = Number(raw);
  try {
    // 能拉到 PDF 即说明该店铺存在此货运标签
    await fetchContainerLabel(searchStoreId.value, labelId);
    const store = stores.value.find((s) => s.id === searchStoreId.value);
    searchRow.value = {
      id: labelId,
      store_id: searchStoreId.value,
      store_name: store?.name || searchStoreId.value,
      status: 'searched',
      postings_count: '—',
      quantum_count: '—',
      delivery_method_name: '搜索结果',
      departure_date: '',
      printed: false,
      isSearchResult: true,
    };
    try {
      const { printed } = await fetchContainerLabelPrintStatus(searchStoreId.value, [labelId]);
      searchRow.value.printed = !!printed[labelId];
    } catch { /* 忽略 */ }
    show(`找到货运标签 #${labelId}(${searchRow.value.store_name})`, 'success');
  } catch (err) {
    searchRow.value = null;
    show(`未找到货运标签 #${raw}:${err.message || String(err)}`, 'error');
  } finally {
    searching.value = false;
  }
}

function clearSearch() {
  searchId.value = '';
  searchRow.value = null;
}

// ── 预览/打印 ────────────────────────────────────────
async function onPreview(c) {
  if (!c?.store_id) return;
  loadingPdfId.value = Number(c.id);
  try {
    const blob = await fetchContainerLabel(c.store_id, Number(c.id));
    if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
    pdfUrl.value = URL.createObjectURL(blob);
    pdfSize.value = blob.size;
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    loadingPdfId.value = null;
  }
}

// 前端双通道打印(同 ScanShip):本机组件优先,失败/离线时服务器组件兜底
async function onPrint(c) {
  if (!c?.store_id) return;
  printingId.value = Number(c.id);
  try {
    const blob = await fetchContainerLabel(c.store_id, Number(c.id));
    if (!blob) return;
    await printContainerLabelImage(blob, Number(c.id), selectedPrinter.value, c.store_id);
    show(`已发送打印:货运标签 #${c.id}(${c.store_name})`, 'success');
    // 更新本行打印状态(当前会话内即时反馈;服务器转发打印已落库,刷新后仍为已打印)
    c.printed = true;
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    printingId.value = null;
  }
}

function onClearPreview() {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
  pdfUrl.value = '';
  pdfSize.value = 0;
}

// 打印机下拉提示(与 ScanShip 同口径)
const printerSelectTitle = computed(() => {
  if (agentOnline.value !== true && serverOnline.value !== true) return '打印组件未连接,无法选择打印机';
  if (agentOnline.value !== true) return '本机组件未连接,仅服务器组件在线,请选择服务器打印机';
  if (serverOnline.value !== true) return '本机组件在线,打印机默认走本机';
  return '标签打印机(记住上次选择;本机组件优先,服务器组件兜底)';
});

// 指定打印机(编码 local:/server: 存入记忆;''=自动)
function onPrinterChange() {
  try {
    if (selectedPrinter.value) localStorage.setItem('erp:labelPrinter', selectedPrinter.value);
    else localStorage.removeItem('erp:labelPrinter');
  } catch { /* noop */ }
}

// ── 初始化 ─────────────────────────────────────────────
onMounted(async () => {
  try {
    const list = await getStores();
    stores.value = list || [];
    if (stores.value.length) {
      searchStoreId.value = stores.value[0].id;
      await loadAllLabels();
    }
  } catch (err) {
    show(err.message || '店铺列表加载失败', 'error');
  }
  // 打印机双通道探测(与 ScanShip 相同;失败不阻塞)
  getAllPrinters().then(({ local, server }) => {
    agentOnline.value = local.online;
    printers.value = local.printers;
    defaultPrinter.value = local.defaultPrinter || '';
    serverOnline.value = server.online;
    serverPrinters.value = server.printers;
    serverDefaultPrinter.value = server.defaultPrinter || '';
    let saved = '';
    try { saved = localStorage.getItem('erp:labelPrinter') || ''; } catch { /* noop */ }
    if (saved) {
      const { source, name } = parsePrinter(saved);
      const list = source === 'server' ? serverPrinters.value : printers.value;
      if (!name || list.includes(name)) {
        selectedPrinter.value = encodePrinter(source, name);
      } else {
        selectedPrinter.value = '';
        try { localStorage.removeItem('erp:labelPrinter'); } catch { /* noop */ }
      }
    }
  });
});
</script>

<template>
  <div class="container-label-page">
    <div class="page-head">
      <h2>打印货运标签</h2>
      <span class="page-sub">Ozon FBS 交接单 · 全部店铺最近 5 个发运 · 76×130mm 竖向纸(横版自动旋转)</span>
      <button class="btn btn-ghost btn-sm" :disabled="merged.loading" @click="loadAllLabels">
        {{ merged.loading ? '加载中…' : '刷新' }}
      </button>
    </div>

    <!-- 打印机组(同扫描发货:本机 + 服务器双通道) -->
    <div class="card printer-bar">
      <span class="printer-label">标签打印机</span>
      <select
        v-model="selectedPrinter"
        class="filter-input printer-select"
        :disabled="(agentOnline !== true && serverOnline !== true) || (!printers.length && !serverPrinters.length)"
        :title="printerSelectTitle"
        @change="onPrinterChange"
      >
        <option value="">自动(可用组件默认)</option>
        <optgroup v-if="agentOnline === true" label="本机组件">
          <option value="local:">默认{{ defaultPrinter ? `(${defaultPrinter})` : '' }}</option>
          <option v-for="p in printers" :key="'L' + p" :value="'local:' + p">{{ p }}</option>
        </optgroup>
        <optgroup v-if="serverOnline === true" label="服务器组件">
          <option value="server:">默认{{ serverDefaultPrinter ? `(${serverDefaultPrinter})` : '' }}</option>
          <option v-for="p in serverPrinters" :key="'S' + p" :value="'server:' + p">{{ p }}</option>
        </optgroup>
      </select>
      <span
        class="agent-dot"
        :class="agentOnline === true ? 'on' : agentOnline === false ? 'off' : ''"
        :title="agentOnline === true ? '本机菜鸟组件已连接' : agentOnline === false ? '本机菜鸟组件未连接(打印前请启动组件)' : '正在探测本机组件…'"
      >{{ agentOnline === true ? '本机组件已连接' : agentOnline === false ? '本机组件未连接' : '探测本机…' }}</span>
      <span
        class="agent-dot"
        :class="serverOnline === true ? 'on' : serverOnline === false ? 'off' : ''"
        :title="serverOnline === true ? '服务器菜鸟组件已连接(SSH 隧道转发)' : serverOnline === false ? '服务器菜鸟组件未连接(检查 SSH 隧道)' : '正在探测服务器组件…'"
      >{{ serverOnline === true ? '服务器组件已连接' : serverOnline === false ? '服务器组件未连接' : '探测服务器…' }}</span>
    </div>

    <!-- 搜索:指定店铺 + 货运标签 ID -->
    <div class="card search-bar">
      <span class="search-label">搜索货运标签</span>
      <select v-model="searchStoreId" class="filter-input store-select" :disabled="searching">
        <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <input
        v-model.trim="searchId"
        class="filter-input search-input"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        placeholder="货运标签 ID"
        @keydown.enter="onSearch"
      />
      <button class="btn btn-primary btn-sm" :disabled="searching || !searchStoreId" @click="onSearch">
        {{ searching ? '搜索中…' : '搜索' }}
      </button>
      <button v-if="searchRow" class="btn btn-ghost btn-sm" @click="clearSearch">清除</button>
      <span class="search-hint">按「店铺 + 货运标签 ID」查找,结果置顶显示</span>
    </div>

    <!-- 货运标签列表(全部店铺最近 5 个) -->
    <div class="card list-card">
      <div v-if="merged.loading && !merged.carriages.length" class="list-empty">加载中…</div>
      <div v-else-if="merged.loaded && !currentCarriages().length" class="list-empty">
        全部店铺暂无发运记录
      </div>
      <table v-else class="label-table">
        <thead>
          <tr>
            <th>货运 ID</th>
            <th>店铺</th>
            <th>状态</th>
            <th class="num">货件数</th>
            <th class="num">包裹数</th>
            <th>已打印</th>
            <th class="ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in currentCarriages()"
            :key="c.id"
            :class="{ 'search-hit': searchRow && Number(c.id) === Number(searchRow.id) }"
          >
            <td class="mono label-id">#{{ c.id }}</td>
            <td><span class="store-tag">{{ c.store_name }}</span></td>
            <td class="status-cell">
              <span v-if="c.isSearchResult" class="status-tag search-tag">搜索结果</span>
              <span v-else class="status-tag">{{ carriageStatusLabel(c.status) }}</span>
              <span v-if="c.departure_date" class="row-sub">{{ c.departure_date }}</span>
            </td>
            <td class="num">{{ c.postings_count }}</td>
            <td class="num">{{ c.quantum_count ?? '—' }}</td>
            <td>
              <span class="printed-tag" :class="c.printed ? 'yes' : 'no'">
                {{ c.printed ? '已打印' : '未打印' }}
              </span>
            </td>
            <td class="ops">
              <button
                class="btn btn-ghost btn-sm"
                :disabled="loadingPdfId === Number(c.id)"
                @click="onPreview(c)"
              >
                {{ loadingPdfId === Number(c.id) ? '加载中…' : '预览' }}
              </button>
              <button
                class="btn btn-primary btn-sm"
                :disabled="printingId === Number(c.id) || (agentOnline !== true && serverOnline !== true)"
                :title="(agentOnline !== true && serverOnline !== true) ? '打印组件未连接' : '前端双通道打印'"
                @click="onPrint(c)"
              >
                {{ printingId === Number(c.id) ? '打印中…' : '打印' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 预览区:内嵌原始 PDF -->
    <div class="card preview-card">
      <div class="preview-head">
        <span class="preview-title">PDF 预览</span>
        <span v-if="pdfSize" class="preview-size">{{ fmtSize(pdfSize) }} · 1 页</span>
        <button v-if="pdfUrl" class="btn btn-ghost btn-sm" @click="onClearPreview">清除</button>
      </div>
      <div v-if="pdfUrl" class="preview-frame-wrap">
        <iframe class="preview-frame" :src="pdfUrl" title="货运标签 PDF 预览" />
      </div>
      <div v-else class="preview-empty">点击行内「预览」查看货运标签 PDF</div>
    </div>
  </div>
</template>

<style scoped>
.container-label-page {
  padding: 24px;
  max-width: 1080px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 2px;
}
.page-head h2 {
  margin: 0;
  font-size: 20px;
}
.page-sub {
  flex: 1;
  min-width: 240px;
  font-size: 12.5px;
  color: var(--muted);
}

/* ── 打印机组(同 ScanShip 风格) ── */
.printer-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 16px;
}
.printer-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.printer-select {
  max-width: 240px;
  min-width: 140px;
  font-size: 12px;
  padding: 5px 6px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.agent-dot {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.agent-dot::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d1d5db;
}
.agent-dot.on {
  color: var(--success);
}
.agent-dot.on::before {
  background: var(--success);
}
.agent-dot.off {
  color: var(--warning);
}
.agent-dot.off::before {
  background: var(--warning);
}

/* ── 搜索栏 ── */
.search-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 16px;
}
.search-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.store-select {
  max-width: 160px;
  min-width: 110px;
}
.search-input {
  width: 160px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
}
.search-input:focus,
.search-input:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
.search-hint {
  font-size: 12px;
  color: var(--muted);
}

/* ── 列表 ── */
.list-card {
  padding: 14px 16px;
}
.list-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
.label-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.label-table th,
.label-table td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid #f1f5f9;
}
.label-table th {
  background: #f8fafc;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
}
.label-table td.num,
.label-table th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.label-table tbody tr:last-child td {
  border-bottom: none;
}
.label-table tbody tr {
  transition: background 0.12s;
}
.label-table tbody tr:hover {
  background: #f8fafc;
}
.label-table tbody tr.search-hit {
  background: #eff6ff;
}
.label-id {
  font-weight: 600;
  color: var(--primary);
}
.store-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 500;
  background: #f0fdf4;
  color: #166534;
}
.status-cell {
  position: relative;
}
.status-tag {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 500;
  background: #f1f5f9;
  color: #475569;
}
.search-tag {
  background: #dbeafe;
  color: #1d4ed8;
}
.row-sub {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted);
}
.printed-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 500;
}
.printed-tag::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.printed-tag.yes {
  color: var(--success);
}
.printed-tag.yes::before {
  background: var(--success);
}
.printed-tag.no {
  color: #94a3b8;
}
.printed-tag.no::before {
  background: #cbd5e1;
}
.ops {
  white-space: nowrap;
  text-align: right;
}
.ops .btn {
  margin-left: 6px;
}

/* ── 预览 ── */
.preview-card {
  padding: 14px 16px;
}
.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.preview-title {
  font-size: 14px;
  font-weight: 600;
}
.preview-size {
  flex: 1;
  margin-left: 10px;
  font-size: 12px;
  color: var(--muted);
}
.preview-frame-wrap {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: #f8fafc;
  height: 480px;
}
.preview-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
.preview-empty {
  padding: 50px 20px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}
</style>