// 统一错误处理
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import logger from './log.js';

// 404
export function notFound(req, _res, next) {
  next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `路径不存在: ${req.method} ${req.path}`));
}

// 错误转换
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
  }

  // express body-parser 错误
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: '请求体 JSON 解析失败' });
  }

  // 其他未知错误
  logger.error({ err, path: req.path }, '未处理错误');
  return res.status(500).json({
    code: ErrorCode.INTERNAL_ERROR,
    message: err.message || '服务器内部错误',
  });
}
