// 业务自定义错误(自 ozon-webhook 迁入):统一 Ozon 错误模板 { error: { code, message, details } }
// 用 throw new AppError(...) 抛出,由接收路由/全局 errorHandler 转换响应
export class AppError extends Error {
  constructor({ status = 500, code = 'ERROR_UNKNOWN', message = '未知错误', details = null }) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
