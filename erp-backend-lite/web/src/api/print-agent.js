// 菜鸟打印组件 WebSocket 客户端(官方协议 docId=107014,实测组件 1.5.3.0)
// 组件为本机常驻进程:http 页面连 ws://127.0.0.1:13528,https 页面连 wss://127.0.0.1:13529
// 打印链路:Ozon 面单 PDF → pdfjs 前端渲染为 PNG → CNPL 图片模板(/cnpl/label-image.xml)
//          → 组件把图片按 70×130mm 标签纸排版(宽 70 等比缩放,顶部对齐)
// 预览链路:同上但 task.preview=true,组件只渲染不出纸;1.5.x 组件先回裸 ack(仅 status:success),
//          渲染完成后才发第二条 print 响应(responses[].urls / previewImage 在第二条里,2026-09 实测)

let ws = null;                 // 长连接(复用)
let connecting = null;         // 连接中的 promise(防并发重连)
const reqWaiters = new Map();  // requestID → 响应 handler(是否消费由 handler 自决,preview 需等第二条)
const taskWaiters = new Map(); // taskID → 任务通知 handler(打印进度/失败兜底)

// 任务进度通知:0.x 用 notifyPrintResult(taskID/taskStatus);
// 1.5.x 另发 notifyDocResult/notifyTaskResult(taskId 小写 d/status),均带 taskId,统一按任务分发
const NOTIFY_CMDS = new Set(['notifyPrintResult', 'notifyDocResult', 'notifyTaskResult']);

function wsUrl() {
  return location.protocol === 'https:' ? 'wss://127.0.0.1:13529' : 'ws://127.0.0.1:13528';
}

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function onMessage(msg) {
  if (NOTIFY_CMDS.has(msg.cmd)) {
    const handler = taskWaiters.get(msg.taskID || msg.taskId);
    if (handler) handler(msg);
    return;
  }
  // 其余(print/getPrinters 等命令响应):按 requestID 分发,handler 自行决定是否消费
  const handler = reqWaiters.get(msg.requestID);
  if (handler) handler(msg);
}

// 连接组件(长连接复用;断线自动清引用,下次调用重连)
function connectAgent(timeoutMs = 4000) {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    let done = false;
    const sock = new WebSocket(wsUrl());
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { sock.close(); } catch { /* noop */ }
        connecting = null;
        reject(new Error('连接菜鸟打印组件超时(请确认组件已启动)'));
      }
    }, timeoutMs);
    sock.onopen = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws = sock;
      connecting = null;
      resolve(sock);
    };
    sock.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connecting = null;
      reject(new Error('无法连接菜鸟打印组件(127.0.0.1:13528),请确认组件已启动'));
    };
    sock.onclose = () => {
      ws = null;
      connecting = null;
    };
    sock.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch { /* 非 JSON 忽略 */ }
    };
  });
  return connecting;
}

// 发送请求并等待 requestID 响应(单响应命令用,如 getPrinters;preview 需等多条,见 previewLabelImage)
function request(payload, timeoutMs, timeoutMsg) {
  return connectAgent().then(
    (sock) =>
      new Promise((resolve, reject) => {
        const id = genId();
        const timer = setTimeout(() => {
          if (reqWaiters.has(id)) {
            reqWaiters.delete(id);
            reject(new Error(timeoutMsg));
          }
        }, timeoutMs);
        reqWaiters.set(id, (msg) => {
          reqWaiters.delete(id);
          clearTimeout(timer);
          resolve(msg);
        });
        sock.send(JSON.stringify({ ...payload, requestID: id, version: '1.0' }));
      })
  );
}

// 枚举本机打印机(含组件默认打印机)
export async function getAgentPrinters() {
  const resp = await request({ cmd: 'getPrinters' }, 5000, '获取打印机列表超时');
  if (resp.status === 'failed') throw new Error(resp.msg || '获取打印机列表失败');
  return { defaultPrinter: resp.defaultPrinter || '', printers: (resp.printers || []).map((p) => p.name) };
}

// 选标签打印机:localStorage 记忆 > 组件默认
export async function pickLabelPrinter() {
  try {
    const saved = localStorage.getItem('erp:labelPrinter');
    if (saved) return saved;
  } catch { /* noop */ }
  const { defaultPrinter } = await getAgentPrinters();
  return defaultPrinter;
}

// PDF 第 1 页 → PNG dataURL(pdfjs;worker 走后端静态 /pdfjs/pdf.worker.min.mjs)
// 目标宽 1100px,条码足够清晰
async function pdfToPng(blob) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  const page = await (await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise).getPage(1);
  const scale = 1100 / page.getViewport({ scale: 1 }).width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PDF 透明底铺白
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
}

// CNPL 图片模板任务内容(明文 data:img=PNG dataURL,h=图高 mm;documentID 自定义模板需保证唯一,用运单号)
// 模板经组件拉取 ${location.origin}/cnpl/label-image.xml,模板内用 _data.img/_data.h 取值
function buildImageContents(dataUrl, hMm, documentId) {
  return [
    {
      documentID: String(documentId),
      contents: [{ templateURL: `${location.origin}/cnpl/label-image.xml`, data: { img: dataUrl, h: hMm } }],
    },
  ];
}

// 静默打印:组件渲染 CNPL 模板并出纸;waiter 仅在终态清理(提前清理会漏接 printed 导致超时)
// 终态判定兼容两代协议:0.x notifyPrintResult 用 taskStatus(printed/failed);
// 1.5.x notifyDocResult/notifyTaskResult 用 status(printed/completeSuccess/failed/completeFailed)
export async function printLabelImage(blob, documentId, printer = '', widthMm = 70) {
  const { dataUrl, w, h } = await pdfToPng(blob);
  const hMm = Math.round((widthMm * h) / w * 10) / 10;
  const sock = await connectAgent();
  const taskID = genId();
  return new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      taskWaiters.delete(taskID);
      clearTimeout(timer);
      fn(arg);
    };
    taskWaiters.set(taskID, (v) => {
      const st = v.taskStatus || v.status;
      if (st === 'printed' || st === 'completeSuccess') {
        finish(resolve, v);
      } else if (st === 'failed' || st === 'completeFailed' || st === 'canceled') {
        const msgs = (v.printStatus || []).map((k) => k.msg || k.detail).filter(Boolean).join('; ');
        finish(reject, new Error('打印失败: ' + (msgs || v.detail || v.msg || '未知原因')));
      }
    });
    const timer = setTimeout(() => {
      taskWaiters.delete(taskID);
      reject(new Error('打印超时(60 秒未出纸)'));
    }, 60000);
    sock.send(
      JSON.stringify({
        cmd: 'print',
        requestID: genId(),
        version: '1.0',
        task: {
          taskID,
          preview: false,
          printer: printer || '',
          documents: buildImageContents(dataUrl, hMm, documentId),
        },
      })
    );
  });
}

// 从 print 响应中提取预览图 URL(兼容 1.5.x responses[].urls/previewImage 与文档字段 previewURL/urls)
function extractPreviewUrl(msg) {
  return (
    (msg.previewImage && msg.previewImage[0]) ||
    msg.previewURL ||
    (msg.responses || []).flatMap((r) => r.urls || [])[0] ||
    (msg.urls && msg.urls[0]) ||
    ''
  );
}

// 无纸预览:preview:true + previewType:'image',组件渲染 CNPL 模板不出纸、不流转状态
// 1.5.x 报文流(实测):①裸 ack(status:success,无 URL)→ ②notifyDocResult(rendered→printed)
//   → ③第二条 print 响应(带 responses[].urls/previewImage)→ ④notifyTaskResult(completeSuccess)
// 故 reqWaiters 收到裸 ack 不能消费,须等第二条;taskWaiters 兜底接收渲染失败通知
export async function previewLabelImage(blob, documentId, widthMm = 70) {
  const { dataUrl, w, h } = await pdfToPng(blob);
  const hMm = Math.round((widthMm * h) / w * 10) / 10;
  const sock = await connectAgent();
  const reqId = genId();
  const taskID = genId();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      reqWaiters.delete(reqId);
      taskWaiters.delete(taskID);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('预览超时(组件 20 秒内未返回渲染结果)'));
    }, 20000);
    // print 响应:status:failed 立即失败;裸 ack(无 URL)继续等第二条
    reqWaiters.set(reqId, (msg) => {
      if (msg.status === 'failed') {
        cleanup();
        reject(new Error(msg.msg || '预览渲染失败'));
        return;
      }
      const url = extractPreviewUrl(msg);
      if (url) {
        cleanup();
        resolve(url);
      }
    });
    // 兜底:渲染失败时组件可能只发任务通知、不发第二条响应
    taskWaiters.set(taskID, (v) => {
      const st = v.taskStatus || v.status;
      if (st === 'failed' || st === 'completeFailed' || st === 'canceled') {
        cleanup();
        reject(new Error(v.detail || v.msg || '预览渲染失败'));
      }
    });
    sock.send(
      JSON.stringify({
        cmd: 'print',
        requestID: reqId,
        version: '1.0',
        task: {
          taskID,
          preview: true,
          previewType: 'image',
          printer: '',
          documents: buildImageContents(dataUrl, hMm, documentId),
        },
      })
    );
  });
}
