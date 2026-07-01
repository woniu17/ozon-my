// 请求日志中间件
import logger from './log.js';

export function requestLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start,
      userId: req.user?.id,
      storeId: req.headers['x-ozon-store-id'],
    });
  });
  next();
}
