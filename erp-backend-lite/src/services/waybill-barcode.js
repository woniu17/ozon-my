// 面单 PDF → 逐页提取下条码(2026-10-25,扫描打单扫码支持)
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

// 货运标签 PDF 中的 OGL 国内集运仓快递单号(2026-10-30)
// 实测 Ozon /v2/posting/fbs/act/get-container-labels 对 OGL 集运(圆通承运)的发运
// 返回国内段快递面单 PDF:每页一张面单,含一个 YT 开头的圆通单号(文本+条码)。
// 该单号即"发往 Ozon OGL 国内集运仓"的快递单号,回填到 op_package.head_logistics_no。
const YT_RE = /\bYT\d+\b/;

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

/**
 * 提取货运标签 PDF 每页的 OGL 国内集运仓快递单号(YT 开头,圆通承运)。
 * @param {Buffer|Uint8Array} pdfBuffer Ozon get-container-labels 返回的货运标签 PDF
 * @returns {Promise<Array<string|null>>} 每页一个 OGL 入仓快递单号;页面无 YT 单号时为 null
 */
export async function extractOglInboundTrackingNumbers(pdfBuffer) {
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
    const m = text.match(YT_RE);
    result.push(m ? m[0] : null);
  }
  return result;
}