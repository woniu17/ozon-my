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
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs
    .getDocument({
      data: new Uint8Array(pdfBuffer),
      disableWorker: true, // Node 环境不用 worker
      standardFontDataUrl: STANDARD_FONTS_DIR,
    })
    .promise;
  const page = await doc.getPage(1);

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

  // 水平居中;面单打印(有定制区)内容顶部对齐,底部整段留给定制区;
  // 货运标签(无定制区)保持原居中布局不变(2026-10-26 用户确认)
  const offsetX = Math.round((canvasW - viewport.width) / 2);
  const offsetY = customH > 0 ? 0 : Math.round((canvasH - viewport.height) / 2);
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