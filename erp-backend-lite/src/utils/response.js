// 统一响应封装
export function ok(data) {
  return { ok: true, data };
}

// 直接透传业务体(插件很多接口直接读 result 字段)
export function raw(body) {
  return body;
}
