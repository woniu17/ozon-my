// Ozon 推送源 IP 白名单中间件(2026-09-17 自 ozon-webhook 迁入,Express 化)
// 仅放行 Ozon 文档声明的 3 段 IP,拒绝其他来源
// 挂载方式:webhook router 内部,只包 POST /webhook/ozon(见 modules/webhook.js)
// 开发时设置 IP_WHITELIST_ENABLED=false 可关闭(本地 curl 调试)
import config from '../config/index.js';
import logger from './log.js';

// 简易 CIDR 匹配器:支持 IPv4 单段(不处理 :: 等特殊场景)
// 返回 true 表示 ip 落在 cidr 内
function ipInCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = parseInt(bits, 10);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt == null || baseInt == null) return false;
  // 计算掩码:32 位无符号,shift 后取掩码
  const maskInt = mask === 0 ? 0 : (0xFFFFFFFF << (32 - mask)) >>> 0;
  return (ipInt & maskInt) === (baseInt & maskInt);
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// 真实客户端 IP:不设全局 trust proxy(避免影响 erp 其他中间件的 req.ip 语义),
// 中间件内自行解析 X-Forwarded-For 首个 IP(nginx proxy_set_header 透传),无头时取 socket 地址
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

export function ipWhitelist(req, res, next) {
  if (!config.webhook.ipWhitelistEnabled) {
    return next();
  }
  const ip = clientIp(req);
  const allowed = config.webhook.ozonPushCidrs.some(cidr => ipInCidr(ip, cidr));
  if (!allowed) {
    logger.warn({ ip, path: req.path }, 'IP 白名单拒绝');
    return res.status(403).json({ error: { code: 'ERROR_UNKNOWN', message: 'forbidden', details: null } });
  }
  next();
}
