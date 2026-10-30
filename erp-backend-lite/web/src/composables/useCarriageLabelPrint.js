// 货运标签打印/预览(2026-11-01)
// 从 ContainerLabelPrint 抽取,供 CarriageManage「发运清单 · 待处理」行内操作复用。
// 双通道打印:本机菜鸟组件 + 服务器组件,与 ScanShip/打印页同口径。
// 预览分两种:
// - PNG 弹窗:服务器渲染 PDF 每页为 PNG,展示实际出纸版式(76×130mm,多页可翻页)
// - PDF 弹窗:内嵌 iframe 查看原始 PDF,便于核对条形码细节
import { ref, reactive, computed } from 'vue';
import {
  getAllPrinters,
  fetchContainerLabel,
  fetchContainerLabelPreview,
  printContainerLabelImage,
  parsePrinter,
  encodePrinter,
} from '../api/print-agent.js';
import { useToast } from '../components/useToast.js';

export function useCarriageLabelPrint() {
  const { show } = useToast();

  // ── 打印机组(本机 + 服务器双通道) ────────────────
  const agentOnline = ref(null);          // 本机菜鸟组件:null=探测中 true/false
  const serverOnline = ref(null);         // 服务器转发组件:null=探测中 true/false
  const printers = ref([]);                // 本机组件打印机名列表
  const defaultPrinter = ref('');          // 本机组件默认打印机
  const serverPrinters = ref([]);         // 服务器组件打印机名列表
  const serverDefaultPrinter = ref('');   // 服务器组件默认打印机
  const selectedPrinter = ref('');        // 指定打印机(编码 local:/server:),''=自动

  // ── 货运标签 PNG 预览弹窗(实际出纸版式) ─────────
  const labelPreview = reactive({ open: false, images: [], page: 0, loading: 0 });

  // ── 原始 PDF 预览弹窗(核对条形码) ──────────────
  const pdfPreview = reactive({ open: false, url: '', size: 0, loading: 0 });

  // ── 打印中状态(行内按钮防重复) ──────────────────
  const printingId = ref(null);

  function fmtSize(n) {
    if (!n) return '';
    return n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB';
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

  // 打印机双通道探测(失败不阻塞)
  // 2026-11-01:加整体超时兜底 + catch,避免探测 promise 长时间不 settle 导致 UI 一直"探测中"。
  function probePrinters() {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      if (agentOnline.value === null) agentOnline.value = false;
      if (serverOnline.value === null) serverOnline.value = false;
    }, 10_000);
    getAllPrinters()
      .then(({ local, server }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        agentOnline.value = local.online;
        printers.value = local.printers;
        defaultPrinter.value = local.defaultPrinter || '';
        serverOnline.value = server.online;
        serverPrinters.value = server.printers;
        serverDefaultPrinter.value = server.defaultPrinter || '';
        restoreSavedPrinter();
      })
      .catch(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        agentOnline.value = false;
        serverOnline.value = false;
      });
  }

  // 恢复上次选择的打印机(localStorage 记忆,失效则清空)
  function restoreSavedPrinter() {
    let saved = '';
    try { saved = localStorage.getItem('erp:labelPrinter') || ''; } catch { /* noop */ }
    if (!saved) return;
    const { source, name } = parsePrinter(saved);
    const list = source === 'server' ? serverPrinters.value : printers.value;
    if (!name || list.includes(name)) {
      selectedPrinter.value = encodePrinter(source, name);
    } else {
      selectedPrinter.value = '';
      try { localStorage.removeItem('erp:labelPrinter'); } catch { /* noop */ }
    }
  }

  // ── PNG 预览(服务器渲染 PDF 每页,不依赖组件预览图 URL) ──
  async function previewRender(c) {
    if (!c?.store_id) return;
    if (labelPreview.loading) return;
    labelPreview.loading = Number(c.id);
    try {
      const data = await fetchContainerLabelPreview(c.store_id, Number(c.id));
      const images = data?.images || [];
      if (!images.length) throw new Error('预览图拉取失败');
      labelPreview.images = images;
      labelPreview.page = 0;
      labelPreview.open = true;
    } catch (err) {
      show(err.message || String(err), 'error');
    } finally {
      labelPreview.loading = 0;
    }
  }
  function previewPrev() {
    if (labelPreview.page > 0) labelPreview.page--;
  }
  function previewNext() {
    if (labelPreview.page < labelPreview.images.length - 1) labelPreview.page++;
  }

  // ── 原始 PDF 预览(弹窗内嵌 iframe) ─────────────
  async function previewPdf(c) {
    if (!c?.store_id) return;
    pdfPreview.loading = Number(c.id);
    try {
      const blob = await fetchContainerLabel(c.store_id, Number(c.id));
      if (pdfPreview.url) URL.revokeObjectURL(pdfPreview.url);
      pdfPreview.url = URL.createObjectURL(blob);
      pdfPreview.size = blob.size;
      pdfPreview.open = true;
    } catch (err) {
      show(err.message || String(err), 'error');
    } finally {
      pdfPreview.loading = 0;
    }
  }
  function clearPdfPreview() {
    if (pdfPreview.url) URL.revokeObjectURL(pdfPreview.url);
    pdfPreview.url = '';
    pdfPreview.size = 0;
  }

  // ── 前端双通道打印(本机优先,失败/离线时服务器组件兜底) ──
  async function printLabel(c, copies = 1) {
    if (!c?.store_id) return;
    printingId.value = Number(c.id);
    try {
      const blob = await fetchContainerLabel(c.store_id, Number(c.id));
      if (!blob) return;
      await printContainerLabelImage(blob, Number(c.id), selectedPrinter.value, c.store_id, copies);
      show(`已发送打印:货运标签 #${c.id}(${c.store_name}) × ${copies}`, 'success');
      // 更新本行打印状态(当前会话内即时反馈;服务器转发打印已落库,刷新后仍为已打印)
      c.printed = true;
    } catch (err) {
      show(err.message || String(err), 'error');
    } finally {
      printingId.value = null;
    }
  }

  return {
    agentOnline,
    serverOnline,
    printers,
    defaultPrinter,
    serverPrinters,
    serverDefaultPrinter,
    selectedPrinter,
    printerSelectTitle,
    onPrinterChange,
    probePrinters,
    labelPreview,
    previewRender,
    previewPrev,
    previewNext,
    pdfPreview,
    previewPdf,
    clearPdfPreview,
    printingId,
    printLabel,
    fmtSize,
  };
}