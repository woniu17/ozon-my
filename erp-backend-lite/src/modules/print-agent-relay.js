// 菜鸟打印组件 · 服务器端转发模块(2026-09)
// 本机常驻的菜鸟打印组件经 SSH 反向隧道暴露到服务器本地(ws://127.0.0.1:13528),
// 后端作为 WS 客户端替远程前端/安卓把打印命令转发给组件,让没有连接打印机的电脑也能打印。
// 协议与前端 web/src/api/print-agent.js 完全一致(官方 docId=107014,组件 1.5.3.0):
//   - 长连接复用,断线自动清引用,下次调用重连
//   - requestID 分发单响应命令(getPrinters),taskID 分发打印进度通知
//     (notifyPrintResult/notifyDocResult/notifyTaskResult,兼容 0.x/1.5.x 两代协议)
// 路由:
//   GET  /admin/api/print-agent/status    组件在线状态 + 打印机列表
//   POST /admin/api/print-agent/print     转发图片打印命令(等出纸)
//   POST /admin/api/print-agent/preview   转发无纸预览(返回组件渲染图 URL)
import { Router } from 'express';
import { WebSocket } from 'ws';
import { ok } from '../utils/response.js';
import { pdfToPngDataUrl } from '../services/waybill-image.js';
import { orderPackageDao } from '../db/dao/sqlite/order-daos.js';
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { packageLabel } from '../services/ozon-opi.js';
import { getWaybill, setWaybill, getWaybillPng, setWaybillPng } from '../services/waybill-cache.js';

// SSH 隧道把打印电脑的组件端口转发到服务器 127.0.0.1:13528;可用环境变量覆盖
const AGENT_WS_URL = process.env.PRINT_AGENT_WS_URL || 'ws://127.0.0.1:13528';

let ws = null;                 // 长连接(复用)
let connecting = null;         // 连接中的 promise(防并发重连)
let lastConnectFailAt = 0;     // 最近一次连接失败时间戳(负缓存,status 秒回,避免隧道抖动时每次都等超时)
const CONNECT_FAIL_TTL = 10_000;
const reqWaiters = new Map();  // requestID → 响应 handler(是否消费由 handler 自决,preview 需等第二条)
const taskWaiters = new Map(); // taskID → 任务通知 handler(打印进度/失败兜底)

const NOTIFY_CMDS = new Set(['notifyPrintResult', 'notifyDocResult', 'notifyTaskResult']);

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
  if (Date.now() - lastConnectFailAt < CONNECT_FAIL_TTL) {
    return Promise.reject(new Error('菜鸟打印组件(服务器转发)暂不可用,请检查 SSH 隧道'));
  }
  connecting = new Promise((resolve, reject) => {
    let done = false;
    const sock = new WebSocket(AGENT_WS_URL);
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { sock.close(); } catch { /* noop */ }
        connecting = null;
        lastConnectFailAt = Date.now();
        reject(new Error('连接菜鸟打印组件(服务器转发)超时,请检查 SSH 隧道'));
      }
    }, timeoutMs);
    sock.on('open', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws = sock;
      connecting = null;
      lastConnectFailAt = 0;
      resolve(sock);
    });
    sock.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connecting = null;
      lastConnectFailAt = Date.now();
      reject(new Error('无法连接菜鸟打印组件(服务器转发),请检查 SSH 隧道'));
    });
    sock.on('close', () => {
      ws = null;
      connecting = null;
    });
    sock.on('message', (data) => {
      try { onMessage(JSON.parse(data.toString())); } catch { /* 非 JSON 忽略 */ }
    });
  });
  return connecting;
}

// 发送请求并等待 requestID 响应(单响应命令用,如 getPrinters)
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

// 枚举服务器组件的打印机(含组件默认打印机)
async function getAgentPrinters() {
  const resp = await request({ cmd: 'getPrinters' }, 5000, '获取打印机列表超时');
  if (resp.status === 'failed') throw new Error(resp.msg || '获取打印机列表失败');
  return {
    defaultPrinter: resp.defaultPrinter || '',
    printers: (resp.printers || []).map((p) => p.name),
  };
}

// 组件拉取 CNPL 模板用的 base URL:必须用公网可达且与访问入口一致的协议。
// 反代(nginx/caddy 终止 TLS)向后端转发的是 http,req.protocol 会错判成 http,
// 而公网入口 17443 只接受 https,组件用 http 拉模板会收到 400 → 优先取 x-forwarded-proto。
function getTemplateBase(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  return `${proto}://${req.get('host')}`;
}

// CNPL 图片模板任务内容(明文 data:img=PNG dataURL,h=图高 mm)
// 模板经组件拉取 ${templateBase}/cnpl/label-image.xml,模板内用 _data.img/_data.h 取值
// templateBase 用请求的 origin(ERP 服务器地址),打印电脑经局域网可达;URL 带时间戳防模板缓存
function buildImageContents(dataUrl, hMm, documentId, templateBase) {
  return [
    {
      documentID: String(documentId),
      contents: [
        {
          templateURL: `${templateBase}/cnpl/label-image.xml?t=${Date.now()}`,
          data: { img: dataUrl, h: hMm },
        },
      ],
    },
  ];
}

// 图片打印任务:组件渲染 CNPL 模板并出纸;waiter 仅在终态清理(提前清理会漏接 printed 导致超时)
// 终态判定兼容两代协议:0.x notifyPrintResult 用 taskStatus(printed/failed);
// 1.5.x notifyDocResult/notifyTaskResult 用 status(printed/completeSuccess/failed/completeFailed)
function sendPrint(dataUrl, hMm, documentId, printer, templateBase) {
  return connectAgent().then((sock) => {
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
            documents: buildImageContents(dataUrl, hMm, documentId, templateBase),
          },
        })
      );
    });
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
// 1.5.x 报文流:①裸 ack(status:success,无 URL)→ ②notifyDocResult(rendered→printed)
//   → ③第二条 print 响应(带 responses[].urls/previewImage)→ ④notifyTaskResult(completeSuccess)
// 故 reqWaiters 收到裸 ack 不能消费,须等第二条;taskWaiters 兜底接收渲染失败通知
function sendPreview(dataUrl, hMm, documentId, templateBase) {
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
            documents: buildImageContents(dataUrl, hMm, documentId, templateBase),
          },
        })
      );
    });
  });
}

const router = Router();

// 组件在线状态 + 打印机列表(前端合并进打印机下拉,本机/服务器并行展示)
router.get('/admin/api/print-agent/status', async (_req, res) => {
  try {
    const r = await getAgentPrinters();
    res.json(ok({ online: true, defaultPrinter: r.defaultPrinter, printers: r.printers }));
  } catch {
    res.json(ok({ online: false, defaultPrinter: '', printers: [] }));
  }
});

// 打印:前端已把 PDF 转成 PNG dataURL,后端原样转发给组件(模板 URL 指向 ERP 服务器)
router.post('/admin/api/print-agent/print', async (req, res, next) => {
  const startTs = Date.now();
  const { imageDataUrl, hMm, documentId, printer } = req.body || {};
  try {
    if (!imageDataUrl || !documentId) {
      return res.status(400).json({ ok: false, message: 'imageDataUrl 与 documentId 必填' });
    }
    const templateBase = getTemplateBase(req);
    await sendPrint(imageDataUrl, Number(hMm) || 129, documentId, printer || '', templateBase);
    orderPackageDao.insertPrintLog({
      postingNumber: documentId,
      printer: printer || '',
      source: 'print',
      status: 'success',
      durationMs: Date.now() - startTs,
      ip: req.ip,
    });
    res.json(ok({ printed: true }));
  } catch (e) {
    orderPackageDao.insertPrintLog({
      postingNumber: documentId || null,
      printer: printer || '',
      source: 'print',
      status: 'failed',
      error: e?.message || String(e),
      durationMs: Date.now() - startTs,
      ip: req.ip,
    });
    next(e);
  }
});

// 按包裹打印(安卓/薄客户端用):传 packageId,后端拉 PDF 缓存 → 服务端渲染 PNG → 转发组件出纸
// body: { packageId, printer? }  printer 为服务器组件上的打印机名,空=组件默认
// PNG 二级缓存(2026-10-22):渲染结果按 (店铺,货件,纸张规格) 缓存,补打跳过 PDF 拉取与渲染
router.post('/admin/api/print-agent/print-package', async (req, res, next) => {
  const startTs = Date.now();
  const b = req.body || {};
  const printer = b.printer || '';
  let logMeta = { packageId: null, postingNumber: null, storeId: null };
  try {
    const packageId = Number(b.packageId);
    if (!Number.isInteger(packageId)) {
      return res.status(400).json({ ok: false, message: 'packageId 必填' });
    }
    const rows = orderPackageDao.getPackagePostings([packageId]);
    if (!rows.length) {
      return res.status(400).json({ ok: false, message: '包裹不存在' });
    }
    const storeIds = [...new Set(rows.map((r) => r.storeId))];
    if (storeIds.length > 1) {
      return res.status(400).json({ ok: false, message: '不支持跨店铺混打,请逐个包裹打印' });
    }
    const storeId = storeIds[0];
    const postingNumbers = rows.map((r) => r.postingNumber);
    logMeta = { packageId, postingNumber: postingNumbers[0] || null, storeId };

    // PNG 二级缓存命中:直接转发,跳过 Ozon 拉 PDF 与 canvas 渲染
    const widthMm = 70;
    const pageHm = 129;
    let dataUrl = getWaybillPng(storeId, postingNumbers, widthMm, pageHm);
    if (!dataUrl) {
      // 面单 PDF:文件缓存优先,未命中调 Ozon(与 order-process/package-label 同口径)
      let pdf = getWaybill(storeId, postingNumbers);
      if (!pdf) {
        const store = (config.loadStores() || []).find((s) => s.id === storeId);
        if (!store) return res.status(400).json({ ok: false, message: `店铺 ${storeId} 不存在` });
        try {
          pdf = (await packageLabel(store, postingNumbers)).buffer;
        } catch (e) {
          const msg = e?.message || '';
          if (/aren't ready/i.test(msg)) {
            orderPackageDao.insertPrintLog({
              ...logMeta,
              printer,
              source: 'print-package',
              status: 'failed',
              error: 'LABEL_NOT_READY:面单尚未就绪',
              durationMs: Date.now() - startTs,
              ip: req.ip,
            });
            return res.status(409).json({ ok: false, code: 'LABEL_NOT_READY', message: '面单尚未就绪(Ozon 装配后需 45-60 秒),请稍后重试' });
          }
          if (/INVALID_ARGUMENT/i.test(msg)) {
            orderPackageDao.insertPrintLog({
              ...logMeta,
              printer,
              source: 'print-package',
              status: 'failed',
              error: 'LABEL_NOT_AVAILABLE:Ozon 拒绝生成面单',
              durationMs: Date.now() - startTs,
              ip: req.ip,
            });
            return res.status(409).json({ ok: false, code: 'LABEL_NOT_AVAILABLE', message: 'Ozon 拒绝生成面单:仅"待发货(awaiting_deliver)"状态的订单可打印面单' });
          }
          throw e;
        }
        setWaybill(storeId, postingNumbers, pdf);
      }
      // 服务端渲染成 PNG dataURL,并写入二级缓存
      const rendered = await pdfToPngDataUrl(pdf, widthMm, pageHm);
      dataUrl = rendered.dataUrl;
      setWaybillPng(storeId, postingNumbers, widthMm, pageHm, dataUrl);
    }

    const hMm = Math.round(((70 * pageHm) / widthMm) * 10) / 10; // 固定规格 70×129 → 129mm
    const documentId = postingNumbers[0] || String(packageId);
    const templateBase = getTemplateBase(req);
    await sendPrint(dataUrl, hMm, documentId, printer, templateBase);
    const durationMs = Date.now() - startTs;
    logger.info({ packageId, storeId, postings: postingNumbers.length, printer: printer || 'default', durationMs }, '[print-agent] 按包裹打印成功');
    orderPackageDao.insertPrintLog({ ...logMeta, printer, source: 'print-package', status: 'success', durationMs, ip: req.ip });
    res.json(ok({ printed: true, postingNumber: documentId }));
  } catch (e) {
    orderPackageDao.insertPrintLog({
      ...logMeta,
      printer,
      source: 'print-package',
      status: 'failed',
      error: e?.message || String(e),
      durationMs: Date.now() - startTs,
      ip: req.ip,
    });
    next(e);
  }
});

// 无纸预览:返回组件渲染出的预览图 URL(远程机器上可能无法直接访问,以本机预览为准)
router.post('/admin/api/print-agent/preview', async (req, res, next) => {
  try {
    const { imageDataUrl, hMm, documentId } = req.body || {};
    if (!imageDataUrl || !documentId) {
      return res.status(400).json({ ok: false, message: 'imageDataUrl 与 documentId 必填' });
    }
    const templateBase = getTemplateBase(req);
    const url = await sendPreview(imageDataUrl, Number(hMm) || 129, documentId, templateBase);
    res.json(ok({ url }));
  } catch (e) {
    next(e);
  }
});

// ── 打印日志/监控(2026-10-22)────────────────────────────
// GET /admin/api/print-agent/logs   分页查询打印记录(今日/昨日,可过滤状态/关键字)
// GET /admin/api/print-agent/stats  当日/昨日打印成功失败统计
router.get('/admin/api/print-agent/logs', (req, res, next) => {
  try {
    const q = req.query || {};
    const data = orderPackageDao.listPrintLogs({
      day: q.day,
      page: q.page,
      pageSize: q.pageSize,
      status: q.status,
      keyword: q.keyword,
    });
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

router.get('/admin/api/print-agent/stats', (req, res, next) => {
  try {
    const q = req.query || {};
    const data = orderPackageDao.printStats({ day: q.day });
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

export default router;