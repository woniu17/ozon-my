// 图片托管与水印渲染模块
// prepareBundleItems 加工链调用:下载原图 → 渲染水印 → 落盘到 public/images/ → 返回公网反代 URL
// 供 Ozon OPI 拉取,避免直接引用源站图片
import { request } from 'undici';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../middleware/log.js';
import config from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '../public');
const IMAGES_DIR = join(PUBLIC_DIR, 'images');

// sharp 可选导入(缺失时模块整体降级,调用方需检测 sharpAvailable)
let sharp = null;
try {
  const mod = await import('sharp');
  sharp = mod.default || mod;
} catch {
  sharp = null;
}
export const sharpAvailable = !!sharp;

/**
 * 处理单张商品图片:下载 → 渲染水印 → 落盘 → 返回公网 URL
 * 任一步失败时抛错,由调用方(watermark.js)捕获并降级为透传原 URL
 *
 * @param {string} url - 原图 URL(http/https)
 * @param {string} sku - SKU 标识(用于子目录命名)
 * @param {object} templateConfig - 水印模板配置 JSON
 * @returns {Promise<string>} 公网反代 URL
 */
export async function processImage(url, sku, templateConfig) {
  if (!config.imageHostBaseUrl) {
    throw new Error('IMAGE_HOST_BASE_URL 未配置');
  }
  if (!sharp) {
    throw new Error('sharp 未安装');
  }
  const type = templateConfig?.type;
  if (type !== 'text' && type !== 'border' && type !== 'image') {
    throw new Error('水印模板 type 无效');
  }

  // 文件名 hash 必须包含原图 URL + 水印模板配置,
  // 否则切换水印模板时同 URL 命中旧缓存,水印不更新(2026-07 修复)
  const templateFingerprint = JSON.stringify(templateConfig);
  const hash = createHash('md5').update(url).update(templateFingerprint).digest('hex');
  const safeSku = sanitizeSku(sku);
  const subDir = join(IMAGES_DIR, safeSku);
  const filePath = join(subDir, hash + '.jpg');
  const publicUrl = `${config.imageHostBaseUrl}/images/${safeSku}/${hash}.jpg`;

  // 幂等:同 url + 同水印模板配置已存在则直接返回,跳过下载和渲染
  if (existsSync(filePath)) {
    return publicUrl;
  }

  mkdirSync(subDir, { recursive: true });

  // 下载原图
  let buffer;
  try {
    const res = await request(url, {
      method: 'GET',
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
      maxRedirections: 5,
    });
    if (res.statusCode >= 400) {
      throw new Error(`下载原图失败: HTTP ${res.statusCode}`);
    }
    buffer = Buffer.from(await res.body.arrayBuffer());
  } catch (e) {
    logger.warn({ err: e?.message, url, sku }, '下载原图失败');
    throw e;
  }

  // 渲染水印
  let renderedBuffer;
  try {
    renderedBuffer = await renderWatermark(buffer, templateConfig);
  } catch (e) {
    logger.warn({ err: e?.message, url, sku }, '渲染水印失败');
    throw e;
  }

  writeFileSync(filePath, renderedBuffer);
  return publicUrl;
}

/**
 * 按模板 type 分发到对应渲染器
 * @param {Buffer} buffer - 原图 Buffer
 * @param {object} config - 水印模板配置({ type, text?, border?, image? })
 * @returns {Promise<Buffer>} 渲染后的 Buffer
 */
export async function renderWatermark(buffer, config) {
  switch (config.type) {
    case 'text':
      return renderText(buffer, config.text);
    case 'border':
      return renderBorder(buffer, config.border);
    case 'image':
      return renderImage(buffer, config.image);
    default:
      throw new Error('未知水印类型: ' + config.type);
  }
}

/**
 * 文字水印:用 sharp 在原图上叠加 SVG 文字
 * @param {Buffer} buffer - 原图 Buffer
 * @param {object} textCfg - 文字配置({ content, fontSize?, color?, opacity?, position? })
 * @returns {Promise<Buffer>}
 */
export async function renderText(buffer, textCfg) {
  const cfg = textCfg || {};
  const content = cfg.content;
  if (!content) {
    throw new Error('文字水印 content 必填');
  }
  const fontSize = Number(cfg.fontSize) || 32;
  const color = cfg.color || '#FFFFFF';
  const opacity = Number(cfg.opacity ?? 0.6);
  const position = cfg.position || 'bottom-right';

  const meta = await sharp(buffer).metadata();
  const W = meta.width;
  const H = meta.height;

  const { x, y, anchor } = computeTextPosition(position, W, H, fontSize);

  const svg = `<svg width="${W}" height="${H}">
  <text x="${x}" y="${y}" font-size="${fontSize}" fill="${color}" fill-opacity="${opacity}" font-family="sans-serif" text-anchor="${anchor}">${escapeXml(content)}</text>
</svg>`;

  // SVG 尺寸与原图一致,gravity 用 'centre' 即可对齐
  return sharp(buffer)
    .composite([{ input: Buffer.from(svg), gravity: 'centre' }])
    .jpeg()
    .toBuffer();
}

/**
 * 边框水印:用 sharp extend 在四周添加半透明边框
 * @param {Buffer} buffer - 原图 Buffer
 * @param {object} borderCfg - 边框配置({ width?, color?, opacity? })
 * @returns {Promise<Buffer>}
 */
export async function renderBorder(buffer, borderCfg) {
  const cfg = borderCfg || {};
  const width = Number(cfg.width) || 10;
  const color = cfg.color || '#000000';
  const opacity = Number(cfg.opacity ?? 0.5);

  const { r, g, b } = hexToRgb(color);

  return sharp(buffer)
    .extend({
      top: width,
      bottom: width,
      left: width,
      right: width,
      background: { r, g, b, alpha: opacity },
    })
    .jpeg()
    .toBuffer();
}

/**
 * 图片水印:下载水印图 → 缩放 → 调整 opacity → composite 到原图
 * @param {Buffer} buffer - 原图 Buffer
 * @param {object} imageCfg - 图片水印配置({ url, scale?, opacity?, position? })
 * @returns {Promise<Buffer>}
 */
export async function renderImage(buffer, imageCfg) {
  const cfg = imageCfg || {};
  const url = cfg.url;
  if (!url) {
    throw new Error('图片水印 url 必填');
  }
  const scale = Number(cfg.scale ?? 0.2);
  const opacity = Number(cfg.opacity ?? 0.5);
  const position = cfg.position || 'bottom-right';

  // 下载水印图
  const res = await request(url, {
    method: 'GET',
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
    maxRedirections: 5,
  });
  if (res.statusCode >= 400) {
    throw new Error(`下载水印图失败: HTTP ${res.statusCode}`);
  }
  const wmBuffer = Buffer.from(await res.body.arrayBuffer());

  // 获取原图尺寸,计算水印图目标宽度
  const meta = await sharp(buffer).metadata();
  const wmWidth = Math.round(meta.width * scale);

  // 缩放水印图并调整透明度
  const wmResized = await sharp(wmBuffer)
    .resize(wmWidth)
    .ensureAlpha(opacity)
    .toBuffer();

  const gravity = positionToGravity(position);

  return sharp(buffer)
    .composite([{ input: wmResized, gravity }])
    .jpeg()
    .toBuffer();
}

// ─── 辅助函数 ───

/**
 * 计算文字水印在 SVG 中的坐标与 text-anchor
 * 右下角固定 padding=20
 */
function computeTextPosition(position, W, H, fontSize) {
  const pad = 20;
  switch (position) {
    case 'top-left':
      return { x: pad, y: pad + fontSize, anchor: 'start' };
    case 'top-right':
      return { x: W - pad, y: pad + fontSize, anchor: 'end' };
    case 'bottom-left':
      return { x: pad, y: H - pad, anchor: 'start' };
    case 'bottom-right':
      return { x: W - pad, y: H - pad, anchor: 'end' };
    case 'center':
      return { x: W / 2, y: (H + fontSize) / 2, anchor: 'middle' };
    default:
      return { x: W - pad, y: H - pad, anchor: 'end' };
  }
}

/**
 * position 字符串 → sharp gravity 常量
 */
function positionToGravity(position) {
  switch (position) {
    case 'top-left':
      return 'northwest';
    case 'top-right':
      return 'northeast';
    case 'bottom-left':
      return 'southwest';
    case 'bottom-right':
      return 'southeast';
    case 'center':
      return 'centre';
    default:
      return 'southeast';
  }
}

/**
 * 转义 XML 特殊字符
 */
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 把 SKU 中非 [a-zA-Z0-9_-] 的字符替换为 _
 */
function sanitizeSku(sku) {
  return String(sku).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * hex 颜色 → {r, g, b}
 * 支持 #FFF 和 #FFFFFF
 */
function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h;
  const num = parseInt(v, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}
