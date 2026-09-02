// JWT 鉴权中间件 + 滑动续期
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';

const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/login-password',
  '/auth/send-code',
  '/auth/captcha',
  '/auth/sms/verify',
  '/favicon.ico',
  // 扩展更新检查:SW 启动时调用,不带 Authorization(版本信息无敏感数据)
  '/extension/latest',
  // 图片处理代理:服务间调用,用 x-image-host-token 鉴权(非 JWT)
  '/admin/api/image-host/process-batch',
]);

// 前缀放行:面单打印短链(菜鸟打印组件拉取,HMAC 令牌自校验,见 order-process.js)
const PUBLIC_PATH_PREFIXES = ['/print/waybill/'];

function isPublic(path) {
  if (PUBLIC_PATHS.has(path)) return true;
  if (PUBLIC_PATH_PREFIXES.some((p) => path.startsWith(p))) return true;
  // SW 内部轮询接口,SW 可能没有有效 token(扩展重载后 token 可能过期)
  if (path === '/admin/api/collect-queue/ops/pending') return true;
  if (path.startsWith('/admin/api/collect-queue/ops/') && path.endsWith('/processed')) return true;
  return false;
}

export function authMiddleware(req, _res, next) {
  if (isPublic(req.path)) {
    return next();
  }

  // 服务间鉴权(2026-08):x-api-key 匹配 SERVICE_API_KEY → 服务身份直通
  // (无头采集脚本 deep-collect.js 等机器调用方;跳过 JWT 校验与滑动续期)
  if (req.headers['x-api-key']) {
    if (config.serviceApiKey && req.headers['x-api-key'] === config.serviceApiKey) {
      req.user = { id: 0, service: 'deep-collect' };
      return next();
    }
    // 带 key 但不匹配:直接 401(不回落 JWT,避免误导性报错)
    return next(new ApiError(ErrorCode.AUTH_EXPIRED, 'x-api-key 无效或服务端未配置 SERVICE_API_KEY'));
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return next(new ApiError(ErrorCode.AUTH_EXPIRED, '缺少 Authorization token'));
  }

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (e) {
    return next(new ApiError(ErrorCode.AUTH_EXPIRED, 'token 已过期或无效'));
  }

  req.user = payload;

  // 滑动续期:剩余有效期 < 总有效期的 50% → 重签并通过响应头返回
  const now = Math.floor(Date.now() / 1000);
  const remaining = payload.exp - now;
  const total = payload.exp - payload.iat;
  if (total > 0 && remaining < total * config.refreshThresholdRatio) {
    const newToken = jwt.sign({ id: payload.id, phone: payload.phone }, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn,
    });
    req.refreshedToken = newToken;
  }

  next();
}

// 在响应中注入 X-Refreshed-Token(放在错误处理之前)
export function tokenRefreshInjector(req, res, next) {
  if (req.refreshedToken) {
    res.setHeader('X-Refreshed-Token', req.refreshedToken);
  }
  next();
}
