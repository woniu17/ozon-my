<script setup>
// 打印货运标签(2026-10-25,设计文档: docs/打印货运标签-功能设计.md)
// Ozon FBS 交接单按集装箱/包裹生成独立货运标签,由 /v2/carriage/delivery/list 列出,
// /v2/posting/fbs/act/get-container-labels 按 ID 取 PDF(实测 100x70mm 横向)。
// 用户纸张为 76x130mm 竖向:渲染时顺时针旋转 90° 成 70x100 竖向适配纸张,
// 预览直接内嵌原始 PDF(iframe objectURL)。
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { getStores } from '../api/stores.js';
import {
  getAllPrinters,
  fetchContainerLabel,
  fetchContainerLabels,
  printContainerLabel,
  printContainerLabelImage,
  parsePrinter,
  encodePrinter,
} from '../api/print-agent.js';
import { useToast } from '../components/useToast.js';

const { show } = useToast();

// ── 表单 ─────────────────────────────────────────────
const stores = ref([]);
const form = reactive({ storeId: '', labelId: '' });
const loadingPdf = ref(false);   // 拉 PDF/预览中
const printing = ref(false);    // 前端双通道打印中
const serverPrinting = ref(false); // 服务器直打中
const pdfUrl = ref('');          // object URL(预览 iframe)
const pdfSize = ref(0);         // 最近一次 PDF 字节数

// ── 货运标签列表(/v2/carriage/delivery/list)────────────
const list = reactive({ methods: [], cursor: '', has_next: false, loaded: false });
const loadingList = ref(false);
const loadingMore = ref(false);

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

async function loadLabels(reset = true) {
  if (!form.storeId || loadingList.value || loadingMore.value) return;
  loadingList.value = true;
  try {
    const data = await fetchContainerLabels(form.storeId, reset ? '' : list.cursor, 1000);
    const methods = data?.methods || [];
    if (reset) {
      list.methods = methods;
      list.cursor = data?.cursor || '';
      list.has_next = !!data?.has_next;
    } else if (methods.length) {
      list.methods = list.methods.concat(methods);
      list.cursor = data?.cursor || '';
      list.has_next = !!data?.has_next;
    }
    list.loaded = true;
  } catch (err) {
    show(err.message || String(err), 'error');
    list.methods = [];
    list.has_next = false;
    list.loaded = true;
  } finally {
    loadingList.value = false;
    loadingMore.value = false;
  }
}

function onLoadMore() {
  if (!list.has_next || loadingMore.value) return;
  loadingMore.value = true;
  loadLabels(false);
}

// 点击列表项 → 填入货运 ID 并提示可打印/预览
function pickLabel(c) {
  form.labelId = String(c.id);
  show(`已填入货运标签 ID #${c.id},可点击预览或打印`, 'success');
}

// ── 打印机组(同 ScanShip)──────────────────────────
const agentOnline = ref(null);      // 本机菜鸟组件:null=探测中 true/false
const serverOnline = ref(null);     // 服务器转发组件:null=探测中 true/false
const printers = ref([]);           // 本机组件枚举的打印机名列表
const defaultPrinter = ref('');     // 本机组件默认打印机
const serverPrinters = ref([]);     // 服务器组件枚举的打印机名列表
const serverDefaultPrinter = ref(''); // 服务器组件默认打印机
const selectedPrinter = ref('');    // 指定打印机(编码 local:/server:),''=自动

function fmtSize(n) {
  if (!n) return '';
  return n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB';
}

// 当前服务器组件打印机名(服务器直打用):用户显式选了服务器打印机用它,否则用服务器默认
function serverPrinterName() {
  if (!selectedPrinter.value) return serverDefaultPrinter.value || '';
  const parsed = parsePrinter(selectedPrinter.value);
  return parsed.source === 'server' ? parsed.name : (serverDefaultPrinter.value || '');
}

// 表单校验
function validate() {
  if (!form.storeId) {
    show('请先选择店铺', 'error');
    return false;
  }
  const raw = String(form.labelId || '').trim();
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    show('货运标签 ID 必须为正整数', 'error');
    return false;
  }
  return true;
}

// 拉取 PDF blob(共用):成功返回 blob,失败 toast 并返回 null
async function fetchPdf() {
  if (!validate()) return null;
  const labelId = Number(String(form.labelId).trim());
  try {
    loadingPdf.value = true;
    const blob = await fetchContainerLabel(form.storeId, labelId);
    pdfSize.value = blob.size;
    return blob;
  } catch (err) {
    show(err.message || String(err), 'error');
    return null;
  } finally {
    loadingPdf.value = false;
  }
}

// 预览:拉 PDF → 生成 objectURL 内嵌 iframe
async function onPreview() {
  if (loadingPdf.value || printing.value || serverPrinting.value) return;
  const blob = await fetchPdf();
  if (!blob) return;
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
  pdfUrl.value = URL.createObjectURL(blob);
  const labelId = String(form.labelId).trim();
  show(`已加载货运标签 PDF(${labelId}):${fmtSize(blob.size)}`, 'success');
}

// 打印(前端双通道):拉 PDF → 本机直连/服务器转发渲染打印(横版模板)
async function onPrint() {
  if (loadingPdf.value || printing.value || serverPrinting.value) return;
  if (!validate()) return;
  const labelId = Number(String(form.labelId).trim());
  printing.value = true;
  try {
    const blob = await fetchContainerLabel(form.storeId, labelId);
    if (!blob) return;
    await printContainerLabelImage(blob, labelId, selectedPrinter.value);
    show(`已发送打印:货运标签 #${labelId}`, 'success');
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    printing.value = false;
  }
}

// 服务器直打:后端拉 PDF → 渲染 PNG → 转发打印组件出纸(不依赖前端渲染上传)
async function onServerPrint() {
  if (loadingPdf.value || printing.value || serverPrinting.value) return;
  if (!validate()) return;
  const labelId = Number(String(form.labelId).trim());
  if (serverOnline.value !== true) {
    show('服务器组件未连接(检查 SSH 隧道),无法直打', 'error');
    return;
  }
  serverPrinting.value = true;
  try {
    await printContainerLabel(form.storeId, labelId, serverPrinterName());
    show(`服务器直打完成:货运标签 #${labelId}`, 'success');
  } catch (err) {
    show(err.message || String(err), 'error');
  } finally {
    serverPrinting.value = false;
  }
}

// 清除预览
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

// 切换店铺 → 自动刷新货运标签列表
watch(() => form.storeId, (val) => {
  if (val) {
    list.methods = [];
    list.cursor = '';
    list.has_next = false;
    list.loaded = false;
    loadLabels(true);
  }
});

// ── 初始化 ─────────────────────────────────────────────
onMounted(async () => {
  // 店铺列表,默认选中第一家
  try {
    const list = await getStores();
    stores.value = list || [];
    if (stores.value.length) form.storeId = stores.value[0].id;
  } catch (err) {
    show(err.message || '店铺列表加载失败', 'error');
  }
  // 打印机双通道探测(仅状态展示;打印时 printContainerLabelImage 自行兜底)
  getAllPrinters().then(({ local, server }) => {
    agentOnline.value = local.online;
    printers.value = local.printers;
    defaultPrinter.value = local.defaultPrinter || '';
    serverOnline.value = server.online;
    serverPrinters.value = server.printers;
    serverDefaultPrinter.value = server.defaultPrinter || '';
    // 恢复上次指定打印机(记忆值仍在对应组件打印机列表中才生效)
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
    <div class="card form-card">
      <div class="page-head">
        <h2>打印货运标签</h2>
        <span class="page-sub">Ozon FBS 交接单货运标签 · 纸张 76×130mm 竖向(横版内容自动旋转适配)</span>
      </div>

      <div class="form-grid">
        <div class="field">
          <label class="field-label" for="cl-store">店铺</label>
          <select
            id="cl-store"
            v-model="form.storeId"
            class="filter-input store-select"
            :disabled="loadingPdf || printing || serverPrinting"
          >
            <option v-for="s in stores" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </div>

        <div class="field">
          <label class="field-label" for="cl-label-id">货运标签 ID</label>
          <input
            id="cl-label-id"
            v-model.trim="form.labelId"
            class="label-id-input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            placeholder="例如 124466396"
            :disabled="loadingPdf || printing || serverPrinting"
            @keydown.enter="onPrint"
          />
        </div>

        <div class="field printer-field">
          <label class="field-label" for="cl-printer">标签打印机</label>
          <select
            id="cl-printer"
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
            :title="agentOnline === true ? '本机菜鸟组件已连接' : agentOnline === false ? '本机菜鸟组件未连接' : '正在探测本机组件…'"
          >{{ agentOnline === true ? '本机在线' : agentOnline === false ? '本机离线' : '探测本机…' }}</span>
          <span
            class="agent-dot"
            :class="serverOnline === true ? 'on' : serverOnline === false ? 'off' : ''"
            :title="serverOnline === true ? '服务器菜鸟组件已连接' : serverOnline === false ? '服务器菜鸟组件未连接' : '正在探测服务器组件…'"
          >{{ serverOnline === true ? '服务器在线' : serverOnline === false ? '服务器离线' : '探测服务器…' }}</span>
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-ghost" :disabled="loadingPdf || printing || serverPrinting" @click="onPreview">
          {{ loadingPdf ? '加载中…' : (pdfUrl ? '重新预览' : '预览') }}
        </button>
        <button class="btn btn-primary" :disabled="loadingPdf || printing || serverPrinting" @click="onPrint">
          {{ printing ? '打印中…' : '打印' }}
        </button>
        <button
          class="btn btn-ghost"
          :disabled="loadingPdf || printing || serverPrinting || serverOnline !== true"
          :title="serverOnline === true ? '后端拉 PDF 渲染后直接经服务器组件出纸' : '服务器组件未连接'"
          @click="onServerPrint"
        >
          {{ serverPrinting ? '直打中…' : '服务器直打' }}
        </button>
      </div>

      <div v-if="pdfSize" class="pdf-meta">已加载 PDF · {{ fmtSize(pdfSize) }} · 1 页</div>
    </div>

    <!-- 货运标签列表(/v2/carriage/delivery/list,每个发运 id 即货运标签 ID) -->
    <div class="card list-card">
      <div class="list-head">
        <span class="list-title">货运标签列表</span>
        <span class="list-sub">点击行填入货运 ID,再预览/打印</span>
        <button class="btn btn-ghost btn-sm" :disabled="loadingList || !form.storeId" @click="loadLabels(true)">
          {{ loadingList ? '加载中…' : '刷新' }}
        </button>
      </div>

      <div v-if="loadingList && !list.methods.length" class="list-empty">加载中…</div>
      <div v-else-if="list.loaded && !list.methods.length" class="list-empty">该店铺暂无发运记录</div>

      <div v-for="(m, mi) in list.methods" :key="mi" class="method-block">
        <div class="method-head">
          <span class="method-name">{{ m.delivery_method_name || '配送方式' }}</span>
          <span v-if="m.departure_date" class="method-date">{{ m.departure_date }}</span>
        </div>
        <table class="label-table">
          <thead>
            <tr>
              <th>货运 ID</th>
              <th>状态</th>
              <th class="num">货件数</th>
              <th class="num">包裹数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in m.carriages" :key="c.id" class="label-row" @click="pickLabel(c)">
              <td class="mono label-id">#{{ c.id }}</td>
              <td><span class="status-tag">{{ carriageStatusLabel(c.status) }}</span></td>
              <td class="num">{{ c.postings_count }}</td>
              <td class="num">{{ c.quantum_count ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <button
        v-if="list.has_next"
        class="btn btn-ghost btn-sm load-more"
        :disabled="loadingMore"
        @click="onLoadMore"
      >
        {{ loadingMore ? '加载中…' : '加载更多' }}
      </button>
    </div>

    <!-- 预览区:内嵌原始 PDF(与打印同源,可缩放查看) -->
    <div class="card preview-card">
      <div class="preview-head">
        <span class="preview-title">PDF 预览</span>
        <button v-if="pdfUrl" class="btn btn-ghost btn-sm" @click="onClearPreview">清除</button>
      </div>
      <div v-if="pdfUrl" class="preview-frame-wrap">
        <iframe class="preview-frame" :src="pdfUrl" title="货运标签 PDF 预览" />
      </div>
      <div v-else class="preview-empty">
        选择店铺并输入货运标签 ID 后点击「预览」或「打印」
      </div>
    </div>
  </div>
</template>

<style scoped>
.container-label-page {
  padding: 24px;
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 16px;
}
.page-head h2 {
  margin: 0;
  font-size: 20px;
}
.page-sub {
  font-size: 12.5px;
  color: var(--muted);
}

.form-grid {
  display: grid;
  grid-template-columns: minmax(180px, 220px) minmax(200px, 280px) minmax(260px, 1fr);
  gap: 14px;
  align-items: end;
}
@media (max-width: 860px) {
  .form-grid {
    grid-template-columns: 1fr;
    align-items: stretch;
  }
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.store-select {
  min-width: 0;
}
.printer-field {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.printer-field .field-label {
  width: 100%;
}
.printer-select {
  max-width: 220px;
  min-width: 120px;
  font-size: 12px;
  padding: 5px 6px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.label-id-input {
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 15px;
  font-family: ui-monospace, 'Cascadia Code', Menlo, monospace;
  background: #fff;
  color: var(--text);
  transition: border-color 0.15s;
}
.label-id-input:focus,
.label-id-input:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
}
.label-id-input:disabled {
  background: #f9fafb;
  cursor: not-allowed;
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

.actions {
  display: flex;
  gap: 10px;
  margin-top: 18px;
}
.pdf-meta {
  margin-top: 10px;
  font-size: 12px;
  color: var(--muted);
}

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
.preview-frame-wrap {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: #f8fafc;
  height: 520px;
}
.preview-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
.preview-empty {
  padding: 60px 20px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
  border: 1px dashed var(--border);
  border-radius: 8px;
}

/* ── 货运标签列表 ── */
.list-card {
  padding: 14px 16px;
}
.list-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.list-title {
  font-size: 14px;
  font-weight: 600;
}
.list-sub {
  flex: 1;
  font-size: 12px;
  color: var(--muted);
}
.list-empty {
  padding: 30px 0;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
.method-block {
  margin-bottom: 14px;
}
.method-block:last-of-type {
  margin-bottom: 0;
}
.method-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #f8fafc;
  border-radius: 6px 6px 0 0;
  border: 1px solid var(--border);
  border-bottom: none;
}
.method-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.method-date {
  font-size: 12px;
  color: var(--muted);
}
.label-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 0 0 6px 6px;
  overflow: hidden;
}
.label-table th,
.label-table td {
  padding: 7px 10px;
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
.label-row {
  cursor: pointer;
  transition: background 0.12s;
}
.label-row:hover {
  background: #eff6ff;
}
.label-row:last-of-type td {
  border-bottom: none;
}
.label-id {
  font-weight: 600;
  color: var(--primary);
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
.load-more {
  margin-top: 12px;
  width: 100%;
}
</style>