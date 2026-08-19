// pino 请求日志:与 erp-backend-lite 一致风格
import pino from 'pino';
import config from '../config/index.js';

const logger = pino({
  level: config.logLevel,
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
});

// Koa 请求日志中间件(async/await,禁用 callback 风格)
export const requestLog = () => async (ctx, next) => {
  const start = Date.now();
  await next();
  const cost = Date.now() - start;
  logger.info({
    method: ctx.method,
    path: ctx.path,
    status: ctx.status,
    cost,
    ip: ctx.ip,
  }, 'req');
};

export default logger;
