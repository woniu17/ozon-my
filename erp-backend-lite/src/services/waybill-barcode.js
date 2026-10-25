// 面单 PDF → 逐页提取下条码(2026-10-25,扫描发货扫码支持)
// 复用 waybill-image.js 的 pdfjs-dist legacy 加载方式(Node 环境,disableWorker)
// 提取逻辑:每页文本拼接后取第一个 >=10 位纯数字串(实测为面单下条码,如 551620749311000)
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
// 用 require.resolve 定位 pdfjs-dist 包目录(兼容 node_modules 提升/扁平化结构)
const STANDARD_FONTS_DIR = `${dirname(require.resolve('pdfjs-dist/package.json'))}/standard_fonts/`;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

// 下条码:纯数字长串(面单上唯一;货件号 93036752-0054-1 含连字符不会被误匹配)
const BARCODE_RE = /\b\d{10,}\b/;

/**
 * 提取面单 PDF 每页的下条码。
 * @param {Buffer|Uint8Array} pdfBuffer Ozon 面单 PDF
 * @returns {Promise<Array<string|null>>} 每页一个条码;页面无条码时为 null
 */
export async function extractWaybillBarcodes(pdfBuffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs
    .getDocument({
      data: new Uint8Array(pdfBuffer),
      disableWorker: true,
      standardFontDataUrl: STANDARD_FONTS_DIR,
    })
    .promise;
  const result = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join('\n');
    const m = text.match(BARCODE_RE);
    result.push(m ? m[0] : null);
  }
  return result;
}