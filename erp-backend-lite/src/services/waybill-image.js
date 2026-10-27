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

  // 店铺行高度(仅 overlayText 时启用,货运标签不传此参数保持原布局):
  // 面单打印时顶部留 3mm 空白,其下是一行店铺名(左/中/右各重复一次),再下方才是面单内容
  // (2026-10-28 由底部定制区改为顶部:不再遮挡面单原始内容)
  // 行高 90px:68px 店铺名视觉高约 62px,上下各留 ~14px(约 1mm)内边距,紧凑且容得下店铺名
  const shopRowH = overlayText ? 90 : 0;
  const topPad = shopRowH > 0 ? Math.round((canvasW * 3) / widthMm) : 0; // 3mm 顶部空白
  const availH = shopRowH > 0 ? canvasH - topPad - shopRowH : canvasH; // 店铺行下方留给面单内容的高度

  // contain:按宽适配 vs 按可用高适配,取缩放较小者(PDF 比可用区域瘦长时按高缩,留左右白边)
  const scale = Math.min(canvasW / base.width, availH / base.height);
  const viewport = page.getViewport({ scale, rotation });

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // PDF 透明底铺白
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 水平居中;面单打印(有店铺行)内容从店铺行下方开始;
  // 货运标签(无店铺区)保持原居中布局不变(2026-10-26 用户确认)
  const offsetX = Math.round((canvasW - viewport.width) / 2);
  const offsetY = shopRowH > 0 ? topPad + shopRowH : Math.round((canvasH - viewport.height) / 2);
  if (offsetX > 0 || offsetY > 0) {
    ctx.save();
    ctx.translate(offsetX, offsetY);
    await page.render({ canvasContext: ctx, viewport }).promise;
    ctx.restore();
  } else {
    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  // 顶部店铺行:白底黑字店铺名(68px = 原 34px 的 2 倍),同一行左/中/右重复 3 次,
  // 便于折叠/分拣时任一方向都能看到店铺(与前端 renderPdfPageToPng 同口径)
  // rowY 向上补偿 10px:68px 字体在 middle 基线下的字形视觉中心比 em 中线低约 10px,补偿后视觉居中
  if (overlayText && shopRowH > 0) {
    const rowY = topPad + shopRowH / 2 - 10;
    const margin = Math.round((canvasW * 4) / widthMm); // 左右边距约 4mm
    ctx.fillStyle = '#000';
    ctx.font = 'bold 68px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(overlayText, margin, rowY);
    ctx.textAlign = 'center';
    ctx.fillText(overlayText, canvasW / 2, rowY);
    ctx.textAlign = 'right';
    ctx.fillText(overlayText, canvasW - margin, rowY);
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