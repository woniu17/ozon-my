// mtop 签名工具(2026-09,平台订单获取 M2)
// 语义基准:miaoshou-helper/ali-1688-page-bridge.js 内嵌的 JS MD5(RFC 1321,Joseph Myers 实现)
// 签名公式:sign = md5(`${token}&${t}&${appKey}&${data}`)
//  - token 取平台域 _m_h5_tk cookie 下划线前 32 位 hex(1688/淘宝各自独立)
//  - Node 侧用 node:crypto 计算,与插件注入的 JS MD5 结果一致(同为 RFC 1321 UTF-8
//    字节摘要),免去向页面注入约 100 行 MD5 源码
import { createHash } from 'node:crypto';

/** UTF-8 感知 MD5(与插件 md5(unescape(encodeURIComponent(s))) 等价) */
export function md5Hex(s) {
  return createHash('md5').update(String(s), 'utf8').digest('hex');
}

/** mtop 签名:md5(token&t&appKey&data) */
export function mtopSign(token, t, appKey, data) {
  return md5Hex(`${token}&${t}&${appKey}&${data}`);
}

/** 从 cookies 数组提取 mtop token(_m_h5_tk 值下划线前段;未登录/缺失返回空串) */
export function tokenFromCookies(cookies) {
  const c = (Array.isArray(cookies) ? cookies : []).find((x) => x && x.name === '_m_h5_tk');
  return c && c.value ? String(c.value).split('_')[0] : '';
}
