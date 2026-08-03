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
 * 计算图片的落盘路径与公网 URL(供本地处理与缓存预判共用)
 * 文件名 hash 必须包含原图 URL + 水印模板配置,
 * 否则切换水印模板时同 URL 命中旧缓存,水印不更新(2026-07 修复)
 */
function computeImagePath(url, sku, templateConfig) {
  const templateFingerprint = JSON.stringify(templateConfig);
  const hash = createHash('md5').update(url).update(templateFingerprint).digest('hex');
  const safeSku = sanitizeSku(sku);
  const subDir = join(IMAGES_DIR, safeSku);
  const filePath = join(subDir, hash + '.jpg');
  const publicUrl = `${config.imageHostBaseUrl}/images/${safeSku}/${hash}.jpg`;
  return { filePath, publicUrl, subDir };
}

/**
 * 本地处理单张商品图片:下载 → 渲染水印 → 落盘 → 返回公网 URL
 * 任一步失败时抛错,由调用方捕获并降级为透传原 URL
 *
 * @param {string} url - 原图 URL(http/https)
 * @param {string} sku - SKU 标识(用于子目录命名)
 * @param {object} templateConfig - 水印模板配置 JSON
 * @returns {Promise<string>} 公网反代 URL
 */
export async function processImageLocal(url, sku, templateConfig) {
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

  const { filePath, publicUrl, subDir } = computeImagePath(url, sku, templateConfig);

  // 幂等:同 url + 同水印模板配置已存在则直接返回,跳过下载和渲染
  if (existsSync(filePath)) {
    return publicUrl;
  }

  mkdirSync(subDir, { recursive: true });

  // 下载原图(CDN 偶发抖动时重试 1 次;HTTP 4xx 业务错误不重试)
  let buffer;
  let lastErr = null;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await request(url, {
        method: 'GET',
        headersTimeout: 10_000,
        bodyTimeout: 20_000,
        maxRedirections: 5,
      });
      if (res.statusCode >= 400) {
        throw new Error(`下载原图失败: HTTP ${res.statusCode}`);
      }
      buffer = Buffer.from(await res.body.arrayBuffer());
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // HTTP 业务错误(4xx/5xx)不重试
      if (/^下载原图失败: HTTP/.test(e.message)) break;
      if (attempt < MAX_ATTEMPTS) {
        logger.warn({ err: e?.message, url, sku, attempt }, '下载原图失败,重试中');
        continue;
      }
    }
  }
  if (lastErr) {
    logger.warn({ err: lastErr?.message, url, sku }, '下载原图失败');
    throw lastErr;
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
 * 远程处理单张图片(包装批量接口,提取首项结果)
 * 供 previewWatermark 等单图场景使用,失败抛错由调用方降级
 */
async function processImageRemote(url, sku, templateConfig) {
  const { results } = await processImageBatchRemote([url], sku, templateConfig);
  const r = results[0];
  if (!r || !r.ok) {
    throw new Error(r?.error || '远程图片处理失败');
  }
  return r.publicUrl;
}

/**
 * 处理单张商品图片(分发器):根据 IMAGE_HOST_MODE 走本地或远程
 * 保持原 processImage 签名,供 previewWatermark 等单图场景调用
 *   local  = 直接调 processImageLocal
 *   remote/self = 调 processImageRemote(走 HTTP 批量接口)
 * @returns {Promise<string>} 公网反代 URL
 */
export async function processImage(url, sku, templateConfig) {
  if (config.imageHostMode === 'remote' || config.imageHostMode === 'self') {
    return processImageRemote(url, sku, templateConfig);
  }
  return processImageLocal(url, sku, templateConfig);
}

/**
 * 本地批量处理:Promise.all 并行渲染,单图失败隔离透传原图
 * @returns {Promise<{results: Array}>} 统一结构,永不抛错
 */
export async function processImageBatchLocal(urls, sku, templateConfig) {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const { filePath, publicUrl } = computeImagePath(url, sku, templateConfig);
        const cached = existsSync(filePath);
        await processImageLocal(url, sku, templateConfig);
        return { originalUrl: url, publicUrl, ok: true, cached };
      } catch (e) {
        return { originalUrl: url, publicUrl: null, ok: false, cached: false, error: e.message };
      }
    })
  );
  return { results };
}

/**
 * 远程批量处理:HTTP POST 远程 ERP 批量接口
 * 网络/鉴权失败时整体抛错(由 watermark.js 捕获后全部透传原图)
 * 单图失败在 results 中返回 ok:false,不抛错
 * @returns {Promise<{results: Array}>}
 */
async function processImageBatchRemote(urls, sku, templateConfig) {
  if (!config.remoteImageHostUrl) {
    throw new Error('REMOTE_IMAGE_HOST_URL 未配置');
  }
  if (!config.remoteImageHostToken) {
    throw new Error('REMOTE_IMAGE_HOST_TOKEN 未配置');
  }

  const endpoint = `${config.remoteImageHostUrl}/admin/api/image-host/process-batch`;
  let res;
  try {
    res = await request(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-image-host-token': config.remoteImageHostToken,
      },
      body: JSON.stringify({ urls, sku, templateConfig }),
      headersTimeout: 120_000,
      bodyTimeout: 120_000,
      maxRedirections: 5,
    });
  } catch (e) {
    logger.warn({ err: e?.message, endpoint, sku, urlCount: urls.length }, '远程图片处理请求失败');
    throw e;
  }

  if (res.statusCode === 401) {
    throw new Error('远程图片处理鉴权失败(token 无效)');
  }
  if (res.statusCode === 400) {
    throw new Error('远程图片处理请求体非法(urls 非数组/为空/超 20 张)');
  }
  if (res.statusCode >= 400) {
    let msg = `远程图片处理失败: HTTP ${res.statusCode}`;
    try {
      const body = await res.body.json();
      if (body?.error) msg += ` - ${body.error}`;
    } catch {
      // 忽略响应体解析失败
    }
    throw new Error(msg);
  }

  const data = await res.body.json();
  if (!data || data.ok !== true || !Array.isArray(data.results)) {
    throw new Error('远程图片处理响应格式异常');
  }
  return { results: data.results };
}

/**
 * 批量处理图片(分发器):根据 IMAGE_HOST_MODE 走本地并行或远程批量接口
 *   local  = 直接调 processImageBatchLocal(Promise.all 并行渲染)
 *   remote = HTTP POST 远程 ERP 批量接口
 *   self   = HTTP POST 本机 /admin/api/image-host/process-batch(测试用,走完整远程链路)
 *
 * 统一返回结构(本地/远程一致):
 * { results: [{ originalUrl, publicUrl, ok, cached, error? }] }
 * 永不抛错(远程整体失败除外,此时抛错由 watermark.js 透传所有原图)
 *
 * @param {string[]} urls - 原图 URL 数组
 * @param {string} sku - SKU 标识
 * @param {object} templateConfig - 水印模板配置
 * @returns {Promise<{results: Array}>}
 */
export async function processImageBatch(urls, sku, templateConfig) {
  if (config.imageHostMode === 'remote' || config.imageHostMode === 'self') {
    return processImageBatchRemote(urls, sku, templateConfig);
  }
  return processImageBatchLocal(urls, sku, templateConfig);
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
