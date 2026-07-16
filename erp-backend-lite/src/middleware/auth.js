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
]);

function isPublic(path) {
  if (PUBLIC_PATHS.has(path)) return true;
  // SW 内部轮询接口,SW 可能没有有效 token(扩展重载后 token 可能过期)
  if (path === '/admin/api/collect-queue/ops/pending') return true;
  if (path.startsWith('/admin/api/collect-queue/ops/') && path.endsWith('/processed')) return true;
  return false;
}

export function authMiddleware(req, _res, next) {
  if (isPublic(req.path)) {
    return next();
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
