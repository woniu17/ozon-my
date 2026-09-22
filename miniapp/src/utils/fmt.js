// 金额/比率格式化(与 web 端 OrderProcess.vue 同口径)
export function fmtMoney(n) {
  if (n == null) return '—';
  return '¥' + Number(n).toFixed(2);
}

export function fmtRate(n) {
  if (n == null) return '—';
  return Number(n).toFixed(2) + '%';
}

// 时间格式化:YYYY-MM-DD HH:mm(与 web 端展示口径一致;无效值原样返回)
export function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

// 时间戳 → 中文周几(如"周三");无效时间返回空串(与 web 端 weekdayCN 同口径)
export function weekdayCN(t) {
  if (!t) return '';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '';
  return '周' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
}
