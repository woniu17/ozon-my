/**
 * ERP 页面 ⇄ 扩展后台 中继(content script)
 * 注入到个人 ERP(yochylin.com/admin 或 localhost dev)。
 *
 * 协议(window.postMessage,source 标识命名空间):
 *  页面 → 扩展: { source:'erp-pdd', type:'PDD_PING', reqId }            探测桥接可用
 *  页面 → 扩展: { source:'erp-pdd', type:'PDD_GET_ORDERS', reqId, payload:{tab,size} }
 *  扩展 → 页面: { source:'erp-pdd', type:'PDD_PONG', reqId }
 *  扩展 → 页面: { source:'erp-pdd', type:'PDD_ORDERS_RESULT', reqId, data:{ok,orders|error} }
 *
 * 1688 同构,source 换成 'erp-ali',消息类型为 ALI_PING/ALI_PONG/ALI_GET_ORDERS/ALI_ORDERS_RESULT。
 * 淘宝同构,source 换成 'erp-tb',消息类型为 TB_PING/TB_PONG/TB_GET_ORDERS/TB_ORDERS_RESULT。
 */
(function () {
  'use strict';

  // 命名空间 → 消息类型路由(新增平台在此登记即可)
  const ROUTES = {
    'erp-pdd': { ping: 'PDD_PING', pong: 'PDD_PONG', get: 'PDD_GET_ORDERS', result: 'PDD_ORDERS_RESULT' },
    'erp-ali': { ping: 'ALI_PING', pong: 'ALI_PONG', get: 'ALI_GET_ORDERS', result: 'ALI_ORDERS_RESULT' },
    'erp-tb': { ping: 'TB_PING', pong: 'TB_PONG', get: 'TB_GET_ORDERS', result: 'TB_ORDERS_RESULT' },
  };
  const post = (msg) => window.postMessage(msg, window.location.origin);

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    const route = ROUTES[ev.data.source];
    if (!route) return;
    const ns = ev.data.source;
    const { type, reqId, payload } = ev.data;
    if (type === route.ping) {
      post({ source: ns, type: route.pong, reqId });
      return;
    }
    if (type === route.get) {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        const data = chrome.runtime.lastError
          ? { ok: false, error: chrome.runtime.lastError.message }
          : (resp || { ok: false, error: '扩展后台无响应' });
        post({ source: ns, type: route.result, reqId, data });
      });
    }
  });

  // 初始公告 + load 后再公告一次(页面脚本可能晚于本脚本加载,两次确保页面能收到)
  Object.keys(ROUTES).forEach((ns) => post({ source: ns, type: ROUTES[ns].pong }));
  window.addEventListener('load', () => {
    Object.keys(ROUTES).forEach((ns) => post({ source: ns, type: ROUTES[ns].pong }));
  });
})();
