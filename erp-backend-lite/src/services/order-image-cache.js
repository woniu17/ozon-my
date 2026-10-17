// 订单/采购商品主图本地缓存模块(2026-10,订单图片本地化)
//
// 目标:订单处理页的 Ozon 商品主图(picUrl)与采购商品主图(thumbUrl)
// 不再直连 Ozon/PDD/1688/淘宝 CDN,统一由 ERP 图床提供。
//
// 设计:
// - URL 即缓存键:md5(原图URL) 作为文件名,无需映射表,天然幂等。
//   Ozon CDN 图为内容寻址(图变了 URL 就变),哈希自动失效,无"旧图不更新"问题。
// - 输出层重写:DAO/推送把 picUrl/thumbUrl/productImageUrl 重写为
//   {IMAGE_HOST_BASE_URL}/images/cache/{hash}.jpg?src=<原图URL>
// - 懒下载:浏览器请求本地 URL 时若文件不存在,本路由按 src 下载落盘后返回;
//   下载失败 302 降级到原图,保证图不丢。
// - 白名单校验:只允许已知平台图片域名,防 SSRF/开放代理。
// - 预下载(预热):商品缓存回源/采购单补全写入后,异步把主图拉取到本地。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { request } from 'undici';
import logger from '../middleware/log.js';
import config from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '../public/images/cache');

// 允许缓存的图片域名后缀(平台 CDN 白名单,防 SSRF)
// 匹配规则:host === suffix 或 host 以 `.suffix` 结尾
const ALLOWED_HOST_SUFFIXES = [
  // Ozon
  'ozon.ru',
  'ozonstatic.cn',
  'ozone.ru',
  'ozonstatic.ru',
  // 1688 / 淘宝 / 闲鱼(同属阿里 CDN)
  'alicdn.com',
  'taobaocdn.com',
  'tbcdn.cn',
  '1688.com',
  // 拼多多
  'pinduoduo.com',
  'yangkeduo.com',
  'pddpic.com',
  'pddugc.com',
  // 闲鱼
  'goofish.com',
  'idlefish.com',
];

/** 下载中的去重 Map(hash → Promise),防止同一文件并发重复下载 */
const inflight = new Map();

/**
 * 请求级图片图床上下文(2026-10-17 内网直连修复)
 *
 * 背景:安卓/H5 常通过内网直连 ERP(http://192.168.1.212:3001,不经 nginx),
 * 而图片 URL 若固定用公网 IMAGE_HOST_BASE_URL(yochylin.com:17443),
 * 内网设备无法回环访问公网域名 → 图片加载失败。
 * 解决:用 AsyncLocalStorage 记录每个请求的图床 base URL——
 *   公网 nginx 转发(X-Forwarded-Proto: https)→ https://yochylin.com:17443
 *   内网直连(X-Forwarded-Proto 无)→ http://192.168.1.212:3001
 * 输出层 imageCacheUrlFor 自动取当前请求的 base,前端/安卓零改动。
 */
const imageCtx = new AsyncLocalStorage();

/** 根据请求头计算当前请求的图床 base URL(无 Host 时回退配置) */
function resolveImageBaseUrl(req) {
  try {
    const host = req?.headers?.host;
    if (!host) return config.imageHostBaseUrl;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    let proto = forwardedProto || req.protocol || 'http';
    // 兜底(2026-10-17):nginx location / 曾缺 X-Forwarded-Proto,公网 https 请求会被当成 http,
    // 生成 http 图片 URL 被浏览器/安卓混合内容拦截;公网 17443 是 nginx SSL 端口,据此推断 https
    if (!forwardedProto && String(host).includes(':17443')) {
      proto = 'https';
    }
    return `${proto}://${host}`;
  } catch {
    return config.imageHostBaseUrl;
  }
}

/**
 * Express 中间件:为当前请求创建图片图床上下文。
 * 用法: app.use((req, res, next) => withImageRequestContext(req, next));
 * ALS 上下文会自动传播到路由处理器及其异步操作,请求结束自动销毁。
 */
export function withImageRequestContext(req, next) {
  return imageCtx.run({ baseUrl: resolveImageBaseUrl(req) }, next);
}

/**
 * 去掉平台图片 URL 中的尺寸后缀取原图(2026-10-17,1688 采购主图过小问题)。
 * 1688/淘宝 alicdn 缩略图 URL 形如 "...-cib.80x80.jpg"(也有 _100x100.jpg / -200x200.webp),
 * 去掉其中 "<分隔符><宽>x<高>" 即可得到原图(实测 80x80 → 1920x1920)。
 * 非图片扩展名或未命中时原样返回,保证其它平台/原图 URL 不受影响。
 */
export function stripImageSizeSuffix(url) {
  const s = String(url || '').trim();
  if (!s) return s;
  return s.replace(/([._-])\d{1,4}x\d{1,4}(?=\.(?:jpe?g|png|webp)(?:$|[?#]))/i, '');
}

/** 下载超时/大小上限 */
const HEADERS_TIMEOUT_MS = 10_000;
const BODY_TIMEOUT_MS = 30_000;
const MAX_BYTES = 20 * 1024 * 1024; // 20MB

/** 是否允许下载该 URL(协议 + 域名白名单) */
export function isAllowedImageUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
  } catch {
    return false;
  }
}

/** 根据原图 URL 计算哈希与落盘路径(无网络 IO,可同步调用) */
export function imageCachePathForUrl(url) {
  const s = String(url || '').trim();
  const hash = createHash('md5').update(s).digest('hex');
  return { hash, filePath: join(CACHE_DIR, `${hash}.jpg`) };
}

/**
 * 把原图 URL 重写为本地图床 URL(输出层统一调用)。
 * - 图床 base 优先取当前请求上下文(内网直连返回内网地址,公网返回公网地址)
 * - 无请求上下文(如 push-hub 推送)回退配置的 IMAGE_HOST_BASE_URL
 * 未配置 base 或非 http(s) 直链时原样返回,保证本地开发/异常数据不受影响。
 * 已是本图床 URL 或已含 /images/cache/ 的 URL 直接透传,防止二次缓存。
 */
export function imageCacheUrlFor(url) {
  const ctx = imageCtx.getStore();
  const base = ctx?.baseUrl || config.imageHostBaseUrl;
  if (!url || !base) return url || null;
  const s = String(url).trim();
  if (!s || s.startsWith('data:')) return url;
  if (s.startsWith(base) || s.includes('/images/cache/')) return url;
  let normalized = s;
  if (normalized.startsWith('//')) normalized = 'https:' + normalized;
  if (!/^https?:\/\//i.test(normalized)) return url;
  const { hash } = imageCachePathForUrl(normalized);
  return `${base}/images/cache/${hash}.jpg?src=${encodeURIComponent(normalized)}`;
}

/** 下载图片 Buffer(带重试;HTTP 4xx/5xx 业务错误不重试) */
async function downloadImageBuffer(url) {
  let buffer;
  let lastErr = null;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const headers = {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      };
      // 部分平台 CDN 校验 Referer,按域名补常用来源(失败可降级,不强依赖)
      const host = new URL(url).hostname.toLowerCase();
      if (host.endsWith('alicdn.com') || host.endsWith('1688.com')) {
        headers.referer = 'https://detail.1688.com/';
      } else if (host.endsWith('pinduoduo.com') || host.endsWith('yangkeduo.com') || host.endsWith('pddpic.com') || host.endsWith('pddugc.com')) {
        headers.referer = 'https://mobile.yangkeduo.com/';
      } else if (host.endsWith('goofish.com') || host.endsWith('idlefish.com')) {
        headers.referer = 'https://www.goofish.com/';
      }
      const res = await request(url, {
        method: 'GET',
        headers,
        headersTimeout: HEADERS_TIMEOUT_MS,
        bodyTimeout: BODY_TIMEOUT_MS,
        maxRedirections: 5,
      });
      if (res.statusCode >= 400) {
        throw new Error(`HTTP ${res.statusCode}`);
      }
      const contentLength = Number(res.headers['content-length'] || 0);
      if (contentLength > MAX_BYTES) {
        throw new Error(`图片过大(${contentLength} bytes)`);
      }
      buffer = Buffer.from(await res.body.arrayBuffer());
      if (buffer.length > MAX_BYTES) {
        throw new Error(`图片过大(${buffer.length} bytes)`);
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (/^HTTP [45]\d\d/.test(e.message)) break; // 业务错误不重试
      if (attempt < MAX_ATTEMPTS) {
        logger.warn({ err: e.message, url, attempt }, '[image-cache] 下载失败,重试中');
        continue;
      }
    }
  }
  if (lastErr) throw lastErr;
  return buffer;
}

/** 下载并落盘(内部方法,调用方负责白名单/去重) */
async function downloadAndWrite(url, filePath) {
  const buffer = await downloadImageBuffer(url);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * 预热:把原图异步下载到本地(失败仅告警,不阻塞业务)。
 * 供商品缓存回源/采购单补全写入后调用,让新订单一进来图就在本地。
 */
export async function ensureImageCached(url) {
  if (!url || !config.imageHostBaseUrl) return;
  const normalized = String(url).trim();
  if (!isAllowedImageUrl(normalized)) return;
  const { hash, filePath } = imageCachePathForUrl(normalized);
  if (existsSync(filePath)) return;
  if (inflight.has(hash)) {
    try { await inflight.get(hash); } catch { /* 忽略,懒下载兜底 */ }
    return;
  }
  const p = downloadAndWrite(normalized, filePath)
    .then(() => {
      inflight.delete(hash);
      logger.debug({ url: normalized, file: `${hash}.jpg` }, '[image-cache] 预热下载完成');
    })
    .catch((e) => {
      inflight.delete(hash);
      logger.warn({ err: e.message, url: normalized }, '[image-cache] 预热下载失败(将懒下载兜底)');
    });
  inflight.set(hash, p);
  try { await p; } catch { /* 已在上面的 catch 消化 */ }
}

/**
 * Express 处理器:GET /images/cache/:fileName?src=<原图URL>
 * - 文件已存在 → 直接返回(长缓存)
 * - 文件不存在且 src 通过白名单+哈希校验 → 下载落盘后返回
 * - 下载失败 → 302 降级到原图 URL(图不丢)
 */
export async function handleImageCacheRequest(req, res) {
  const fileName = String(req.params.fileName || '');
  const src = String(req.query.src || '').trim();
  const match = /^([a-f0-9]{32})\.jpg$/i.exec(fileName);
  if (!match) {
    return res.status(404).end();
  }
  const hash = match[1].toLowerCase();
  const filePath = join(CACHE_DIR, fileName);

  if (existsSync(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(filePath);
  }

  // 文件不存在:必须有 src,且通过白名单 + 哈希一致校验
  if (!src) {
    return res.status(404).end();
  }
  if (!isAllowedImageUrl(src)) {
    logger.warn({ src }, '[image-cache] 拒绝缓存非白名单 URL');
    return res.status(403).end();
  }
  const srcHash = createHash('md5').update(src).digest('hex');
  if (srcHash !== hash) {
    return res.status(400).end();
  }

  // 并发去重:同一 hash 在途时等待其完成
  if (inflight.has(hash)) {
    try {
      await inflight.get(hash);
      if (existsSync(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.sendFile(filePath);
      }
    } catch {
      // 在途下载失败,继续走下面的新下载
    }
  }

  const task = downloadAndWrite(src, filePath)
    .then(() => {
      inflight.delete(hash);
    })
    .catch((e) => {
      inflight.delete(hash);
      throw e;
    });
  inflight.set(hash, task);
  try {
    await task;
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(filePath);
  } catch (e) {
    logger.warn({ err: e.message, src, fileName }, '[image-cache] 懒下载失败,302 降级到原图');
    res.redirect(302, src);
  }
}