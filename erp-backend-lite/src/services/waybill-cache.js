// 面单 PDF/PNG 文件缓存(2026-09,订单打印标签;2026-10-22 增加 PNG 二级缓存)
// PDF 缓存:避免重复调用 Ozon /v2/posting/fbs/package-label 与限流
// PNG 缓存:pdfToPngDataUrl 服务端渲染开销大(解析 PDF + canvas),同一面单
//   PDF 内容固定,渲染结果缓存为 dataURL 文本,补打时跳过渲染直接转发
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 支持 ERP_DATA_DIR 覆盖(测试隔离/多实例),默认 data/waybills
const WAYBILL_DIR = join(process.env.ERP_DATA_DIR || join(__dirname, '..', '..', 'data'), 'waybills');

// 文件名:<store_id>__<posting_numbers 按字典序 join('-')>.pdf
// posting_numbers 含 '-' 等字符但对 Windows 文件名安全(仅单个包裹场景即 <store>__<posting>.pdf)
function filePath(storeId, postingNumbers) {
  const key = [...postingNumbers].sort().join('-').replace(/[<>:"/\\|?*]/g, '_');
  return join(WAYBILL_DIR, `${storeId}__${key}.pdf`);
}

// PNG dataURL 文件名:<store>__<posting>__<宽>x<高>__v4.dataurl
// 规格体现在文件名(便于换纸不串缓存);v4 为渲染版本(2026-10-26 面单内容顶部对齐+底部定制区店铺名),
// 旧版本(居中布局/顶部白条/无店铺名)缓存文件名不含 v4 自动失效,无需手工清理
const PNG_RENDER_VERSION = 'v4';
function pngFilePath(storeId, postingNumbers, widthMm, pageHm) {
  const key = [...postingNumbers].sort().join('-').replace(/[<>:"/\\|?*]/g, '_');
  return join(WAYBILL_DIR, `${storeId}__${key}__${widthMm}x${pageHm}__${PNG_RENDER_VERSION}.dataurl`);
}

/** 读取 PDF 缓存;未命中返回 null */
export function getWaybill(storeId, postingNumbers) {
  const fp = filePath(storeId, postingNumbers);
  if (!existsSync(fp)) return null;
  try {
    return readFileSync(fp);
  } catch {
    return null; // 读失败(并发写/损坏)视为未命中,走 Ozon 重拉
  }
}

/** 写入 PDF 缓存(先写临时文件再 rename,避免并发读到半截) */
export function setWaybill(storeId, postingNumbers, buffer) {
  if (!existsSync(WAYBILL_DIR)) {
    try {
      mkdirSync(WAYBILL_DIR, { recursive: true });
    } catch {
      return; // 目录创建失败不阻断返回 PDF
    }
  }
  const fp = filePath(storeId, postingNumbers);
  const tmp = fp + '.tmp';
  try {
    writeFileSync(tmp, buffer);
    renameSync(tmp, fp);
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch { /* 忽略清理失败 */ }
  }
}

/** 读取 PNG dataURL 缓存;未命中返回 null */
export function getWaybillPng(storeId, postingNumbers, widthMm, pageHm) {
  const fp = pngFilePath(storeId, postingNumbers, widthMm, pageHm);
  if (!existsSync(fp)) return null;
  try {
    return readFileSync(fp, 'utf8');
  } catch {
    return null;
  }
}

/** 写入 PNG dataURL 缓存(文本,先写临时文件再 rename) */
export function setWaybillPng(storeId, postingNumbers, widthMm, pageHm, dataUrl) {
  if (!existsSync(WAYBILL_DIR)) {
    try {
      mkdirSync(WAYBILL_DIR, { recursive: true });
    } catch {
      return;
    }
  }
  const fp = pngFilePath(storeId, postingNumbers, widthMm, pageHm);
  const tmp = fp + '.tmp';
  try {
    writeFileSync(tmp, dataUrl, 'utf8');
    renameSync(tmp, fp);
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch { /* 忽略清理失败 */ }
  }
}
