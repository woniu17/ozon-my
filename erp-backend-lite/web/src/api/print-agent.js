// 菜鸟打印组件 WebSocket 客户端(官方协议 docId=107014)
// 组件为本机常驻进程:http 页面连 ws://127.0.0.1:13528,https 页面连 wss://127.0.0.1:13529
// 打印链路:Ozon 面单 PDF → pdfjs 前端渲染为 PNG → CNPL 图片模板(/cnpl/label-image.xml)
//          → 组件把图片按 70×130mm 标签纸排版(宽 70 等比缩放,顶部对齐)
// 预览链路:同上但 task.preview=true,组件只渲染不出纸,ack 响应直接返回预览图 URL

let ws = null;                 // 长连接(复用)
let connecting = null;         // 连接中的 promise(防并发重连)
const reqWaiters = new Map();  // requestID → ack resolver(getPrinters/print 等 cmd 响应)
const taskWaiters = new Map(); // taskID → notifyPrintResult handler(打印进度通知)

function wsUrl() {
  return location.protocol === 'https:' ? 'wss://127.0.0.1:13529' : 'ws://127.0.0.1:13528';
}

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function onMessage(msg) {
  // notifyPrintResult:打印任务进度通知(rendered → printed / failed),按 taskID 分发
  if (msg.cmd === 'notifyPrintResult') {
    const handler = taskWaiters.get(msg.taskID);
    if (handler) handler(msg);
    return;
  }
  // 其余:按 requestID 匹配的 ack 响应
  const resolve = reqWaiters.get(msg.requestID);
  if (resolve) {
    reqWaiters.delete(msg.requestID);
    resolve(msg);
  }
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

// 发送请求并等待 requestID ack
function request(payload, timeoutMs, timeoutMsg) {
  return connectAgent().then(
    (sock) =>
      new Promise((resolve, reject) => {
        const id = genId();
        reqWaiters.set(id, resolve);
        setTimeout(() => {
          if (reqWaiters.has(id)) {
            reqWaiters.delete(id);
            reject(new Error(timeoutMsg));
          }
        }, timeoutMs);
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

// CNPL 图片模板任务内容(明文 data:img=PNG dataURL,h=图高 mm)
// 模板经组件拉取 ${location.origin}/cnpl/label-image.xml,模板内用 _data.img/_data.h 取值
function buildImageContents(dataUrl, hMm) {
  return [
    {
      documentID: 'label-' + genId(),
      contents: [{ templateURL: `${location.origin}/cnpl/label-image.xml`, data: { img: dataUrl, h: hMm } }],
    },
  ];
}

// 静默打印:组件渲染 CNPL 模板并出纸;waiter 仅在终态(printed/failed)清理
// (组件默认通知两次 rendered→printed,提前清理会漏接 printed 导致超时)
export async function printLabelImage(blob, documentId, printer = '', widthMm = 70) {
  const { dataUrl, w, h } = await pdfToPng(blob);
  const hMm = Math.round((widthMm * h) / w * 10) / 10;
  const sock = await connectAgent();
  const taskID = genId();
  return new Promise((resolve, reject) => {
    taskWaiters.set(taskID, (v) => {
      if (v.taskStatus === 'printed') {
        taskWaiters.delete(taskID);
        clearTimeout(timer);
        resolve(v);
      } else if (v.taskStatus === 'failed') {
        taskWaiters.delete(taskID);
        clearTimeout(timer);
        const msgs = (v.printStatus || []).map((k) => k.msg || k.detail).filter(Boolean).join('; ');
        reject(new Error('打印失败: ' + (msgs || '未知原因')));
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
          documents: buildImageContents(dataUrl, hMm),
        },
      })
    );
  });
}

// 无纸预览:preview:true + previewType:'image',组件渲染 CNPL 模板不出纸;
// 预览结果直接在 cmd:'print' 的 ack 响应中返回(previewImage 数组 / previewURL / urls 兼容取值)
export async function previewLabelImage(blob, documentId, widthMm = 70) {
  const { dataUrl, w, h } = await pdfToPng(blob);
  const hMm = Math.round((widthMm * h) / w * 10) / 10;
  const resp = await request(
    {
      cmd: 'print',
      task: { taskID: genId(), preview: true, previewType: 'image', printer: '', documents: buildImageContents(dataUrl, hMm, documentId) },
    },
    20000,
    '预览超时(组件 20 秒内未返回渲染结果)'
  );
  if (resp.status === 'failed') throw new Error(resp.msg || '预览渲染失败');
  const url = (resp.previewImage && resp.previewImage[0]) || resp.previewURL || (resp.urls && resp.urls[0]);
  if (!url) throw new Error('组件未返回预览图(previewImage/previewURL 均为空)');
  return url;
}
