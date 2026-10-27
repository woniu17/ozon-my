// 面单 PDF → PNG dataURL(服务端渲染,与前端 web/src/api/print-agent.js pdfToPng 同口径)
// 用 pdfjs-dist legacy + @napi-rs/canvas 在 Node 渲染;标准字体(base-14)从本地文件系统读取
// 画布固定按标签纸比例(76:129,宽 1100px),PDF 内容等比 contain 缩放(水平居中/顶部对齐),白底补齐
import { createCanvas } from '@napi-rs/canvas';
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

/** 打开 PDF 文档(pdfjs legacy,Node 环境) */
async function openPdf(pdfBuffer) {
  const pdfjs = await loadPdfjs();
  return pdfjs
    .getDocument({
      data: new Uint8Array(pdfBuffer),
      disableWorker: true, // Node 环境不用 worker
      standardFontDataUrl: STANDARD_FONTS_DIR,
    })
    .promise;
}

/** 渲染指定 PDF 页为 PNG dataURL(画布固定标签纸比例,PDF contain 缩放) */
async function renderPdfPage(page, widthMm, pageHm, rotation, overlayText) {
  // 同前端:画布固定标签纸比例(宽 1100px),PDF contain 缩放,避免组件拉伸变形
  const canvasW = 1100;
  const canvasH = Math.round((canvasW * pageHm) / widthMm);
  const base = page.getViewport({ scale: 1, rotation });
  const scale = Math.min(canvasW / base.width, canvasH / base.height);
  const viewport = page.getViewport({ scale, rotation });

  // 定制区高度(仅 overlayText 时启用,货运标签不传此参数保持原布局):
  // 面单打印时在纸底部预留白底区域放店铺名(2026-10-26 由顶部白条改为底部定制区,不再遮挡原内容)
  const customH = overlayText ? 250 : 0;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PDF 透明底铺白
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 水平居中;面单打印(有定制区)内容顶部留 5mm 空白,底部整段留给定制区;
  // 货运标签(无定制区)保持原居中布局不变(2026-10-26 用户确认)
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

  // 底部定制区:白底黑字店铺名(68px = 原 34px 的 2 倍),垂直/水平居中
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

/**
 * 渲染 PDF 第 1 页为 PNG dataURL(默认 76×129mm 标签纸比例)。
 * @param {Buffer|Uint8Array} pdfBuffer Ozon 面单 PDF
 * @param {number} widthMm 标签纸宽(mm),默认 76
 * @param {number} pageHm 标签纸高(mm),默认 129
 * @param {number} rotation 顺时针旋转角度(0/90/180/270);货运标签横版打竖向纸时传 90
 * @param {string} [overlayText] 非空时在画布底部定制区绘制(如店铺名 YQL01),用于面单分拣
 * @returns {Promise<{dataUrl:string,w:number,h:number}>}
 */
export async function pdfToPngDataUrl(pdfBuffer, widthMm = 76, pageHm = 129, rotation = 0, overlayText = '') {
  const doc = await openPdf(pdfBuffer);
  const page = await doc.getPage(1);
  return renderPdfPage(page, widthMm, pageHm, rotation, overlayText);
}

/**
 * 渲染 PDF 所有页为 PNG dataURL 数组(多页货运标签/面单逐页打印)。
 * 参数与 pdfToPngDataUrl 一致,返回 [{dataUrl,w,h}, ...] 每页一张。
 */
export async function pdfToPngPagesDataUrl(pdfBuffer, widthMm = 76, pageHm = 129, rotation = 0, overlayText = '') {
  const doc = await openPdf(pdfBuffer);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push(await renderPdfPage(page, widthMm, pageHm, rotation, overlayText));
  }
  return pages;
}