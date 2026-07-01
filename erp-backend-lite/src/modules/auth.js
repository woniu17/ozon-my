// 鉴权路由
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import config from '../config/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';

const router = Router();

// 简易 bcrypt 比对(避免引入 bcryptjs 依赖,直接用 crypto 的 timingSafeEqual 比对 hash 前缀)
// 注:生产环境建议用 bcryptjs。这里为保持零原生依赖,用"明文比对 hash 字符串"的简化方案。
// 用户需在 .env 中写入与 config.userPassword 一致的值即可。
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// POST /auth/login-password
router.post('/auth/login-password', (req, res, next) => {
  try {
    const { phoneNumber, password } = req.body || {};
    if (!phoneNumber || !password) {
      return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'phoneNumber 与 password 必填'));
    }
    if (String(phoneNumber) !== String(config.userPhone)) {
      return next(new ApiError(ErrorCode.AUTH_REQUIRED, '手机号或密码错误'));
    }
    // 个人版简化:password 直接与 USER_PASSWORD 比对
    // 若 USER_PASSWORD 是 bcrypt hash($2b$10$...),则用 bcrypt 比对;否则明文比对
    if (config.userPassword?.startsWith('$2')) {
      // bcrypt hash 模式 —— 需 bcryptjs,未安装则提示
      return next(
        new ApiError(
          ErrorCode.INTERNAL_ERROR,
          '检测到 bcrypt hash 密码,请安装 bcryptjs: npm i bcryptjs,或使用明文密码'
        )
      );
    }
    if (!safeEqual(password, config.userPassword)) {
      return next(new ApiError(ErrorCode.AUTH_REQUIRED, '手机号或密码错误'));
    }

    const user = { id: 1, phone: config.userPhone };
    const accessToken = jwt.sign(user, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    return res.json({ accessToken, user });
  } catch (e) {
    next(e);
  }
});

// GET /auth/ozon-stores
router.get('/auth/ozon-stores', (req, res) => {
  // 返回 stores.json,但隐藏 sync_credentials 凭据
  const stores = config.loadStores().map((s) => {
    const { sync_credentials, ...rest } = s;
    return rest;
  });
  res.json(stores);
});

// GET /auth/captcha(占位,插件旧探针,已改走 /health)
router.get('/auth/captcha', (req, res) => {
  res.json({ captchaId: randomUUID(), svg: '' });
});

// POST /auth/send-code(占位,个人版无短信)
router.post('/auth/send-code', (req, res) => {
  res.json({ ok: true });
});

// POST /auth/sms/verify(占位)
router.post('/auth/sms/verify', (req, res, next) => {
  next(new ApiError(ErrorCode.VALIDATION_ERROR, '个人版仅支持密码登录 /auth/login-password'));
});

// PUT /auth/device/heartbeat(静默 204)
router.put('/auth/device/heartbeat', (req, res) => {
  res.status(204).end();
});

export default router;
