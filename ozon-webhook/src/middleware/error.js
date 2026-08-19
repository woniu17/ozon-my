// 错误处理中间件:统一返回 Ozon 错误模板
// { error: { code, message, details } }
import logger from './log.js';

// 业务自定义错误:用 throw new AppError(...) 抛出
export class AppError extends Error {
  constructor({ status = 500, code = 'ERROR_UNKNOWN', message = '未知错误', details = null }) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errorHandler = () => async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    const status = err.status || 500;
    ctx.status = status;
    ctx.set('Content-Type', 'application/json');
    ctx.body = {
      error: {
        code: err.code || 'ERROR_UNKNOWN',
        message: err.message || '未知错误',
        details: err.details ?? null,
      },
    };
    // 5xx 入 pino error,4xx 入 warn
    if (status >= 500) {
      logger.error({ err, path: ctx.path, method: ctx.method }, '请求处理错误');
    } else {
      logger.warn({ err, path: ctx.path, method: ctx.method }, '请求处理警告');
    }
    ctx.app.emit('error', err, ctx);
  }
};
