// 错误码定义(对齐插件 classifyError 逻辑)
export const ErrorCode = {
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  RESOURCE_NOT_FOUND: 'ResourceNotFound',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

export const ErrorCodeToStatus = {
  AUTH_EXPIRED: 401,
  AUTH_REQUIRED: 403,
  ResourceNotFound: 404,
  VALIDATION_ERROR: 422,
  QUOTA_EXCEEDED: 429,
  TIMEOUT: 408,
  RATE_LIMITED: 429,
  NETWORK_ERROR: 503,
  INTERNAL_ERROR: 500,
};

// 业务错误类
export class ApiError extends Error {
  constructor(code, message, { status, details } = {}) {
    super(message);
    this.code = code;
    this.status = status || ErrorCodeToStatus[code] || 500;
    this.details = details;
  }
}

export function makeError(code, message, details) {
  return new ApiError(code, message, { details });
}
