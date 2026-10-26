// 菜鸟打印组件 WebSocket 客户端(官方协议 docId=107014,实测组件 1.5.3.0)
// 组件为本机常驻进程:http 页面连 ws://127.0.0.1:13528,https 页面连 wss://localhost:13529(证书原因见 wsUrl)
// 打印链路:Ozon 面单 PDF → pdfjs 前端渲染为 PNG → CNPL 图片模板(/cnpl/label-image.xml)
//          → 组件把图片按 70×130mm 标签纸排版(宽 70 等比缩放,顶部对齐)
// 预览链路:同上但 task.preview=true,组件只渲染不出纸;1.5.x 组件先回裸 ack(仅 status:success),
//          渲染完成后才发第二条 print 响应(responses[].urls / previewImage 在第二条里,2026-09 实测)

// pdfjs worker 经 vite ?url 打包为带 hash 的静态资产:
// 不再依赖手动拷贝 src/public/pdfjs/(该目录被 .gitignore 忽略,服务器拉不到,2026-09-15 实测踩坑)
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { get, post, postBlob } from './request.js';

let ws = null;                 // 长连接(复用)
let connecting = null;         // 连接中的 promise(防并发重连)
const reqWaiters = new Map();  // requestID → 响应 handler(是否消费由 handler 自决,preview 需等第二条)
const taskWaiters = new Map(); // taskID → 任务通知 handler(打印进度/失败兜底)

// 任务进度通知:0.x 用 notifyPrintResult(taskID/taskStatus);
// 1.5.x 另发 notifyDocResult/notifyTaskResult(taskId 小写 d/status),均带 taskId,统一按任务分发
const NOTIFY_CMDS = new Set(['notifyPrintResult', 'notifyDocResult', 'notifyTaskResult']);

// ── 双通道:本机 WS 直连(默认) + 服务器组件转发(SSH 隧道)────────────────
// 打印机选择编码为 "local:打印机名" / "server:打印机名"(空名=用该组件默认打印机),
// 打印时按编码路由到本机 WS 或后端转发接口;旧版 localStorage 纯打印机名按本机处理。
const LOCAL_FAIL_TTL = 30_000;   // 本机组件失败负缓存有效期
const LOCAL_OK_TTL = 10_000;     // 本机组件在线缓存有效期(打印/下拉时避免反复 getPrinters 往返)
let localProbeCache = null;      // 本机探测结果缓存 { at, result }(失败 30s / 在线 10s 内不重复探测)
let serverDefaultPrinter = '';   // 最近一次服务器组件探测得到的默认打印机名(打印时显式传名,避免空 printer 落到系统默认)

export function parsePrinter(value) {
  const v = String(value || '');
  if (v.startsWith('local:')) return { source: 'local', name: v.slice(6) };
  if (v.startsWith('server:')) return { source: 'server', name: v.slice(7) };
  return { source: 'local', name: v }; // 旧值/空值按本机处理
}
export function encodePrinter(source, name) {
  return `${source}:${name}`;
}

function wsUrl() {
  // wss 必须用 localhost 而非 127.0.0.1:组件的自签名证书只签给 localhost(无 127.0.0.1 的 IP SAN),
  // Edge 校验 wss 证书时 127.0.0.1 握手直接失败(close 1006,2026-09-15 实测);ws 明文不校验证书,127.0.0.1 不受影响
  return location.protocol === 'https:' ? 'wss://localhost:13529' : 'ws://127.0.0.1:13528';
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

// 服务器组件(后端转发)状态:SSH 隧道把打印电脑组件暴露到服务器 127.0.0.1:13528
export async function getServerAgentStatus() {
  try {
    const data = await get('/admin/api/print-agent/status');
    serverDefaultPrinter = data?.defaultPrinter || '';
    return {
      online: !!data?.online,
      defaultPrinter: serverDefaultPrinter,
      printers: data?.printers || [],
    };
  } catch {
    return { online: false, defaultPrinter: '', printers: [] };
  }
}

// 本机组件探测(失败负缓存:30s 内不重复试连,远程机器秒回)
async function probeLocalAgent() {
  if (localProbeCache) {
    const age = Date.now() - localProbeCache.at;
    if (age < LOCAL_FAIL_TTL && !localProbeCache.result.online) return localProbeCache.result;
    if (age < LOCAL_OK_TTL && localProbeCache.result.online) return localProbeCache.result;
  }
  try {
    const r = await getAgentPrinters();
    localProbeCache = { at: Date.now(), result: { online: true, defaultPrinter: r.defaultPrinter, printers: r.printers } };
  } catch {
    localProbeCache = { at: Date.now(), result: { online: false, defaultPrinter: '', printers: [] } };
  }
  return localProbeCache.result;
}

// 合并本机 + 服务器两组打印机(供打印机下拉同时展示)
// 2026-10 排查:改为顺序探测(本机优先)。组件为单连接,本机与服务器转发同时连会互踢 WS,
// 并行探测会让本机直连间歇性掉线,进而触发"服务器兜底空打印机"错误路径。
export async function getAllPrinters() {
  const local = await probeLocalAgent();
  const server = await getServerAgentStatus();
  return { local, server };
}

// 选标签打印机:localStorage 记忆 > 本机默认(printLabelImage 会在本机不可用时自动兜底服务器)
// 不再调用 getAllPrinters():打印时触发服务器转发探测会让后端也去连本机组件,
// 单连接组件会互踢 WS 导致本机连接频繁断线重连(打印 50% 失败的根因之一)。
export async function pickLabelPrinter() {
  try {
    const saved = localStorage.getItem('erp:labelPrinter');
    if (saved) return saved;
  } catch { /* noop */ }
  // 未手动选择:显式用本机/服务器默认打印机名,避免组件把空 printer 解析成系统默认打印机
  // (曾导致本机打印失败兜底后间歇性打到 PDFwriter,2026-10 排查)
  const local = localProbeCache?.result ?? await probeLocalAgent();
  if (local.online && local.defaultPrinter) return `local:${local.defaultPrinter}`;
  if (serverDefaultPrinter) return `server:${serverDefaultPrinter}`;
  return 'local:';
}

// PDF 第 1 页 → PNG dataURL(pdfjs;worker 走 vite 打包的带 hash 资产,见文件头 import)
// 画布固定按标签纸比例(默认 76:129,宽 1100px)创建,PDF 内容等比 contain 缩放(水平居中/顶部对齐),
// 多余区域白底补齐 → 组件把图拉伸填满 layout 时长宽比与原 PDF 完全一致,零变形
// (2026-09-15:此前画布按 PDF 原比例,layout 拉伸到 129mm 导致 ~2-5% 纵向拉伸,QR 码定位点变椭圆)
// rotation:顺时针旋转角度(0/90/180/270)。货运标签 PDF 为 100x70mm 横向,
// 打印到 76x130mm 竖向纸时 rotation=90 转成 70x100 竖向再 contain(2026-10-25 适配纸张)
// overlayText:非空时在画布底部定制区绘制(如店铺名 YQL01),用于面单分拣(2026-10-26 由顶部白条改为底部定制区)
async function pdfToPng(blob, widthMm = 76, pageHm = 129, rotation = 0, overlayText = '') {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const page = await (await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise).getPage(1);
  const base = page.getViewport({ scale: 1, rotation });
  const canvasW = 1100; // 目标宽 1100px,条码足够清晰
  const canvasH = Math.round((canvasW * pageHm) / widthMm); // 画布高按标签纸比例固定
  // contain:按宽适配 vs 按高适配,取缩放较小者(PDF 比标签瘦长时按高缩,留左右白边)
  const scale = Math.min(canvasW / base.width, canvasH / base.height);
  const viewport = page.getViewport({ scale, rotation });
  // 定制区高度(仅 overlayText 时启用,货运标签不传此参数保持原布局)
  const customH = overlayText ? 250 : 0;
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PDF 透明底铺白
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 水平居中;面单打印(有定制区)内容顶部留 5mm 空白,底部整段留给定制区;
  // 货运标签(无定制区)保持原居中布局不变(与后端 pdfToPngDataUrl 同口径)
  const offsetX = Math.round((canvasW - viewport.width) / 2);
  const topPad = customH > 0 ? Math.round((canvasW * 5) / widthMm) : 0; // 5mm 顶部空白
  const offsetY = customH > 0 ? topPad : Math.round((canvasH - viewport.height) / 2);
  if (offsetX > 0 || offsetY > 0) {
    ctx.save();
    ctx.translate(offsetX, offsetY);
    await page.render({ canvasContext: ctx, viewport }).promise;
    ctx.restore();
  } else {
    await page.render({ canvasContext: ctx, viewport }).promise;
  }
  // 底部定制区:白底黑字店铺名(68px = 原 34px 的 2 倍),垂直/水平居中(与后端 pdfToPngDataUrl 同口径)
  if (overlayText && customH > 0) {
    const top = canvasH - customH;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, top, canvas.width, customH);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 68px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(overlayText, canvasW / 2, top + customH / 2);
  }
  return { dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
}

// CNPL 图片模板任务内容(明文 data:img=PNG dataURL,h=图高 mm;documentID 自定义模板需保证唯一,用运单号)
// 模板经组件拉取 ${location.origin}/cnpl/${templateName}(默认面单纵向 label-image.xml;
// 货运标签 100x70 横向用 label-image-100x70.xml),模板内用 _data.img/_data.h 取值
// URL 必须带时间戳:组件按 URL 缓存模板,不带参数会读到旧缓存(2026-09-15 实测:改模板后不加参数
// 依旧 completeFailure,加 ?t= 后立即生效;模板仅 1KB,每次下载 ~34ms 可忽略)
function buildImageContents(dataUrl, hMm, documentId, templateName = '') {
  const base = templateName ? `${location.origin}/cnpl/${templateName}` : `${location.origin}/cnpl/label-image.xml`;
  return [
    {
      documentID: String(documentId),
      contents: [{ templateURL: `${base}?t=${Date.now()}`, data: { img: dataUrl, h: hMm } }],
    },
  ];
}

// 服务器组件打印:前端转好的 PNG dataURL 交给后端转发到隧道后的组件
// templateName 传给后端 /print 端点,组件拉取对应 CNPL 模板(货运标签横版等)
// storeId 可选:货运标签打印时传入,后端写入 print_log 供「是否已打印」查询
async function printViaServer(dataUrl, hMm, documentId, printer, templateName = '', storeId = '') {
  await post('/admin/api/print-agent/print', {
    imageDataUrl: dataUrl,
    hMm,
    documentId: String(documentId),
    printer: printer || '',
    templateName: templateName || '',
    storeId: storeId || '',
  });
}

// 本机组件 WS 直连打印:组件渲染 CNPL 模板并出纸;waiter 仅在终态清理(提前清理会漏接 printed 导致超时)
// 终态判定兼容两代协议:0.x notifyPrintResult 用 taskStatus(printed/failed);
// 1.5.x notifyDocResult/notifyTaskResult 用 status(printed/completeSuccess/failed/completeFailed)
function printViaLocal(dataUrl, hMm, documentId, printer, templateName = '') {
  return connectAgent().then((sock) => {
    const taskID = genId();
    const reqId = genId();
    return new Promise((resolve, reject) => {
      const finish = (fn, arg) => {
        taskWaiters.delete(taskID);
        reqWaiters.delete(reqId);
        clearTimeout(timer);
        fn(arg);
      };
      // 任务通知(主流路径):0.x notifyPrintResult(taskStatus) / 1.5.x notifyDocResult|notifyTaskResult(status)
      taskWaiters.set(taskID, (v) => {
        const st = v.taskStatus || v.status;
        if (st === 'printed' || st === 'completeSuccess') {
          finish(resolve, v);
        } else if (st === 'failed' || st === 'completeFailed' || st === 'canceled') {
          const msgs = (v.printStatus || []).map((k) => k.msg || k.detail).filter(Boolean).join('; ');
          finish(reject, new Error('打印失败: ' + (msgs || v.detail || v.msg || '未知原因')));
        }
      });
      // 兜底:部分协议变体把任务终态放在 print 响应(裸 ack)里,这里也能识别;
      // 裸 ack(status:success 无任务终态)不消费,继续等任务通知。
      reqWaiters.set(reqId, (msg) => {
        const st = msg.taskStatus || msg.status;
        if (st === 'printed' || st === 'completeSuccess') {
          finish(resolve, msg);
        } else if (st === 'failed' || st === 'completeFailed' || st === 'canceled') {
          const msgs = (msg.printStatus || []).map((k) => k.msg || k.detail).filter(Boolean).join('; ');
          finish(reject, new Error('打印失败: ' + (msgs || msg.detail || msg.msg || '未知原因')));
        }
        // 其余(如裸 ack status:success)→ 不消费,继续等任务通知
      });
      const timer = setTimeout(() => {
        taskWaiters.delete(taskID);
        reqWaiters.delete(reqId);
        reject(new Error('打印超时(60 秒未出纸)'));
      }, 60000);
      sock.send(
        JSON.stringify({
          cmd: 'print',
          requestID: reqId,
          version: '1.0',
          task: {
            taskID,
            preview: false,
            printer: printer || '',
            documents: buildImageContents(dataUrl, hMm, documentId, templateName),
          },
        })
      );
    });
  });
}

// 静默打印(双通道):明确选了服务器组件 → 后端转发;
// 本机组件可用 → 本机直连,打印中途失败再兜底服务器;本机不可用 → 直接走服务器
// 2026-10 排查:任何路径都尽量传"显式打印机名"(用户指定 > 组件默认打印机名),
// 不再传空字符串——菜鸟组件把空 printer 解析成系统默认打印机时,会间歇性打到 PDFwriter。
// 打印:默认 70×129mm 纵向面单纸;opts.pageHm 覆盖画布高 mm,opts.rotation 旋转内容,
// opts.templateName 选择 CNPL 模板(货运标签 76×130 竖向纸旋转适配,见 printContainerLabelImage)
export async function printLabelImage(blob, documentId, printer = '', widthMm = 70, opts = {}) {
  const pageHm = opts.pageHm || Math.round((widthMm * 129) / 70); // 默认 70:129 纵版
  const templateName = opts.templateName || '';
  const rotation = opts.rotation || 0;
  const storeId = opts.storeId || '';
  const overlayText = opts.storeName || ''; // 面单打印时叠加店铺名(如 YQL01)
  const { dataUrl, w, h } = await pdfToPng(blob, widthMm, pageHm, rotation, overlayText);
  const hMm = Math.round((widthMm * h) / w * 10) / 10;
  const parsed = parsePrinter(printer);

  if (parsed.source === 'server') {
    await printViaServer(dataUrl, hMm, documentId, parsed.name || serverDefaultPrinter, templateName, storeId);
    return;
  }

  // 本机直连:不再用 isLocalAgentAvailable() 预探测做硬开关——
  // 预探测的 getPrinters 往返在单连接组件上会与服务器转发探测互踢 WS,
  // 且探测失败会误伤真实打印(50% 不打印的根因)。直接尝试本机打印,
  // 连接/超时由 printViaLocal 负责;仅当最近(30s)已探测本机离线时才跳过,避免空等连接超时。
  const localDefault = localProbeCache?.result?.online ? localProbeCache.result.defaultPrinter : '';
  const localPrinter = parsed.name || localDefault;
  const cacheFreshOffline = localProbeCache
    && Date.now() - localProbeCache.at < LOCAL_FAIL_TTL
    && !localProbeCache.result.online;
  if (!cacheFreshOffline) {
    try {
      await printViaLocal(dataUrl, hMm, documentId, localPrinter, templateName);
      return;
    } catch (err) {
      // 本机打印中途失败 → 服务器组件兜底:保留用户指定打印机名,未指定用服务器默认打印机名
      const server = await getServerAgentStatus();
      if (server.online) {
        await printViaServer(dataUrl, hMm, documentId, parsed.name || server.defaultPrinter, templateName, storeId);
        return;
      }
      throw err;
    }
  }

  const server = await getServerAgentStatus();
  if (server.online) {
    await printViaServer(dataUrl, hMm, documentId, parsed.name || server.defaultPrinter, templateName, storeId);
    return;
  }
  throw new Error('菜鸟打印组件不可用:本机组件未连接,服务器组件转发也不可用');
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

// 服务器组件预览:返回组件渲染图 URL(远程机器上可能无法直接访问,以本机预览为准)
// templateName 传给后端 /preview 端点,组件拉取对应 CNPL 模板(货运标签 76×130 竖向专用等)
async function previewViaServer(dataUrl, hMm, documentId, templateName = '') {
  const r = await post('/admin/api/print-agent/preview', {
    imageDataUrl: dataUrl,
    hMm,
    documentId: String(documentId),
    templateName: templateName || '',
  });
  return r?.url || '';
}

// 本机组件 WS 无纸预览:preview:true + previewType:'image',组件渲染 CNPL 模板不出纸、不流转状态
// 1.5.x 报文流(实测):①裸 ack(status:success,无 URL)→ ②notifyDocResult(rendered→printed)
//   → ③第二条 print 响应(带 responses[].urls/previewImage)→ ④notifyTaskResult(completeSuccess)
// 故 reqWaiters 收到裸 ack 不能消费,须等第二条;taskWaiters 兜底接收渲染失败通知
// templateName 与打印链路一致:货运标签传 label-image-76x130.xml(2026-10-26 预览同步支持)
function previewViaLocal(dataUrl, hMm, documentId, templateName = '') {
  return connectAgent().then((sock) => {
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
            documents: buildImageContents(dataUrl, hMm, documentId, templateName),
          },
        })
      );
    });
  });
}

// ── 打印日志监控(2026-10-22)────────────────────────────
// 后端 DAO 见 server/src/db/dao/sqlite/order-daos.js(listPrintLogs/printStats),
// 日志由 print-agent-relay 模块在每次转发打印后写入 print_log 表。
// GET /admin/api/print-agent/logs   分页查询(day=today|yesterday, status, keyword, page, pageSize)
// GET /admin/api/print-agent/stats  当日/昨日成功失败统计(含按打印机分组)
export function getPrintLogs(params) {
  return get('/admin/api/print-agent/logs', params);
}
export function getPrintStats(params) {
  return get('/admin/api/print-agent/stats', params);
}

// 无纸预览(双通道):本机优先,不可用时走服务器转发
// 与 printLabelImage 一致:不做预探测硬开关,仅当最近已探测本机离线时才跳过本机直连
// opts.pageHm/rotation/templateName/storeName 与 printLabelImage 同口径(货运标签旋转+76×130模板等)
export async function previewLabelImage(blob, documentId, widthMm = 76, opts = {}) {
  const pageHm = opts.pageHm || Math.round((widthMm * 129) / 70); // 默认 76:129 纵版
  const rotation = opts.rotation || 0;
  const templateName = opts.templateName || '';
  const overlayText = opts.storeName || ''; // 面单预览时叠加店铺名,与实际出纸一致
  const { dataUrl, w, h } = await pdfToPng(blob, widthMm, pageHm, rotation, overlayText);
  const hMm = Math.round((widthMm * h) / w * 10) / 10;
  const cacheFreshOffline = localProbeCache
    && Date.now() - localProbeCache.at < LOCAL_FAIL_TTL
    && !localProbeCache.result.online;
  if (!cacheFreshOffline) {
    try {
      return await previewViaLocal(dataUrl, hMm, documentId, templateName);
    } catch {
      /* 本机预览失败 → 尝试服务器 */
    }
  }
  const server = await getServerAgentStatus();
  if (server.online) return previewViaServer(dataUrl, hMm, documentId, templateName);
  throw new Error('菜鸟打印组件不可用:本机组件未连接,服务器组件转发也不可用');
}

// 货运标签无纸预览:76×130mm 竖向纸,PDF 顺时针旋转 90° 后 contain(与 printContainerLabelImage 同口径)
export async function previewContainerLabelImage(blob, labelId, storeId = '') {
  return previewLabelImage(blob, String(labelId), 76, {
    pageHm: 129,
    rotation: 90,
    templateName: 'label-image-76x130.xml',
  });
}

// ── 货运标签打印(2026-10-25)────────────────────────────
// Ozon FBS 交接单按集装箱/包裹生成独立货运标签 PDF(/v2/posting/fbs/act/get-container-labels)。
// 前端链路:拉取 PDF blob → 双通道打印(与面单相同);另有服务端直打接口(见 printContainerLabel)。
export function fetchContainerLabel(storeId, labelId) {
  return postBlob('/admin/api/print-agent/container-label-pdf', { storeId, labelId });
}

// 货运标签(发运)列表:/v2/carriage/delivery/list → { cursor, has_next, methods[] }
export function fetchContainerLabels(storeId, cursor = '', limit = 1000) {
  return post('/admin/api/print-agent/container-labels', { storeId, cursor, limit });
}

// 服务端直打:后端拉 PDF → 渲染 PNG → 转发打印组件出纸(打印机为服务器组件上的打印机名)
export function printContainerLabel(storeId, labelId, printer = '') {
  return post('/admin/api/print-agent/print-container-label', {
    storeId,
    labelId,
    printer: printer || '',
  });
}

// 货运标签打印状态:一次性查询多个 labelId 是否已成功打印过
// → { printed: { '123': true, '124': false, ... } }
export function fetchContainerLabelPrintStatus(storeId, labelIds) {
  const ids = (Array.isArray(labelIds) ? labelIds : []).join(',');
  return get('/admin/api/print-agent/container-label-print-status', { storeId, labelIds: ids });
}

// 货运标签"本机直连打印"补记(2026-10-26):本机组件直打不经过后端,不会落打印日志,
// 刷新后「已打印」状态会丢失;前端打印成功后调用此接口补记,与服务器转发同口径。
export function markContainerLabelPrinted(storeId, labelId, printer = '') {
  return post('/admin/api/print-agent/mark-container-label-printed', {
    storeId,
    labelId,
    printer: printer || '',
  });
}

// 货运标签前端打印:76×130mm 竖向标签纸(用户纸张)。货运标签 PDF 实测 100x70mm 横向,
// 渲染时顺时针旋转 90° 成 70x100 竖向,contain 到 76:129 画布(上下留白),模板用 76×130 竖向专用
// storeId 可选:服务器转发打印时后端记录日志;本机直连打印成功后由本函数补记日志,
// 保证「是否已打印」刷新后仍正确(2026-10-25:纸张由横版 100x70 调整为竖向 76x130)
export async function printContainerLabelImage(blob, labelId, printer = '', storeId = '') {
  await printLabelImage(blob, String(labelId), printer, 76, {
    pageHm: 129,
    rotation: 90,
    templateName: 'label-image-76x130.xml',
    storeId: storeId || '',
  });
  // 打印已出纸:无论本机直连还是服务器转发,都补记/确保日志存在,刷新后仍显示已打印
  if (storeId) {
    try {
      await markContainerLabelPrinted(storeId, Number(labelId), printer);
    } catch { /* 状态补记失败不影响已打印结果 */ }
  }
}
