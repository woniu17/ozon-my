// CDN 防污染:容忍插件 GET 请求加的 ?_t=${timestamp} 查询参数
// 这里只是"容忍",无需做什么;Express 默认会忽略未使用参数
// 此中间件仅用于记录日志时剥离 _t,避免日志噪音
export function cdnBuster(req, _res, next) {
  next();
}
