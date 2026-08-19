// Ozon 推送源 IP 白名单中间件
// 仅放行 Ozon 文档声明的 3 段 IP,拒绝其他来源
// 开发时设置 IP_WHITELIST_ENABLED=false 可关闭
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

// 真实客户端 IP:app.proxy=true 时 ctx.ip 已解析 X-Forwarded-For 首个 IP
export const ipWhitelist = () => async (ctx, next) => {
  // /health 不受白名单限制(用于反代/监控探活)
  if (ctx.path === '/health') return next();

  if (!config.ipWhitelistEnabled) {
    return next();
  }

  const ip = ctx.ip;
  const allowed = config.ozonPushCidrs.some(cidr => ipInCidr(ip, cidr));
  if (!allowed) {
    logger.warn({ ip, path: ctx.path }, 'IP 白名单拒绝');
    ctx.status = 403;
    ctx.set('Content-Type', 'application/json');
    ctx.body = { error: { code: 'ERROR_UNKNOWN', message: 'forbidden', details: null } };
    return;
  }
  return next();
};
