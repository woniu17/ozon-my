// 面单 PDF 文件缓存(2026-09,订单打印标签)
// 缓存 Ozon /v2/posting/fbs/package-label 返回的 PDF,避免重复调用与限流
// 同一 posting_number 的标签内容固定,故缓存不过期(补打场景须返回同版面单)
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAYBILL_DIR = join(__dirname, '..', '..', 'data', 'waybills');

// 文件名:<store_id>__<posting_numbers 按字典序 join('-')>.pdf
// posting_numbers 含 '-' 等字符但对 Windows 文件名安全(仅单个包裹场景即 <store>__<posting>.pdf)
function filePath(storeId, postingNumbers) {
  const key = [...postingNumbers].sort().join('-').replace(/[<>:"/\\|?*]/g, '_');
  return join(WAYBILL_DIR, `${storeId}__${key}.pdf`);
}

/** 读取缓存;未命中返回 null */
export function getWaybill(storeId, postingNumbers) {
  const fp = filePath(storeId, postingNumbers);
  if (!existsSync(fp)) return null;
  try {
    return readFileSync(fp);
  } catch {
    return null; // 读失败(并发写/损坏)视为未命中,走 Ozon 重拉
  }
}

/** 写入缓存(先写临时文件再 rename,避免并发读到半截) */
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
