// 金额/比率格式化(与 web 端 OrderProcess.vue 同口径)
export function fmtMoney(n) {
  if (n == null) return '—';
  return '¥' + Number(n).toFixed(2);
}

export function fmtRate(n) {
  if (n == null) return '—';
  return Number(n).toFixed(2) + '%';
}
