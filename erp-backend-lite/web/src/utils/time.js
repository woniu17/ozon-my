// 统一时间解析(展示为北京时间/浏览器本地时间)
// 后端时间字段有三种存储格式,全部代表 UTC 时刻:
//  1) epoch 毫秒(数字或 13 位数字字符串)
//  2) ISO8601 带时区后缀(…Z / ±hh:mm),如 new Date().toISOString()、Ozon 接口时间
//  3) SQLite datetime('now') 的 'YYYY-MM-DD HH:MM:SS'(无时区后缀)
// 统一解析为 Date 后用本地 getter 格式化即得北京时间。
// 注意:国内平台(妙手/1688/拼多多)返回的北京时间字符串不带时区,不能用本函数(会被误当 UTC 多加 8h)。
export function parseUtcDate(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number') return isNaN(t) ? null : new Date(t);
  const s = String(t).trim();
  if (!s) return null;
  let d;
  if (/^\d{13}$/.test(s)) {
    d = new Date(Number(s));
  } else if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    d = new Date(s);
  } else {
    d = new Date(s.replace(' ', 'T') + 'Z');
  }
  return isNaN(d.getTime()) ? null : d;
}
