/**
 * ERP 页面 ⇄ 扩展后台 中继(content script)
 * 注入到个人 ERP(yochylin.com/admin 或 localhost dev)。
 *
 * 协议(window.postMessage,source 固定为 'erp-pdd'):
 *  页面 → 扩展: { source:'erp-pdd', type:'PDD_PING', reqId }            探测桥接可用
 *  页面 → 扩展: { source:'erp-pdd', type:'PDD_GET_ORDERS', reqId, payload:{tab,size} }
 *  扩展 → 页面: { source:'erp-pdd', type:'PDD_PONG', reqId }
 *  扩展 → 页面: { source:'erp-pdd', type:'PDD_ORDERS_RESULT', reqId, data:{ok,orders|error} }
 */
(function () {
  'use strict';

  const NS = 'erp-pdd';
  const post = (msg) => window.postMessage(msg, window.location.origin);

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== NS) return;
    const { type, reqId, payload } = ev.data;
    if (type === 'PDD_PING') {
      post({ source: NS, type: 'PDD_PONG', reqId });
      return;
    }
    if (type === 'PDD_GET_ORDERS') {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        const data = chrome.runtime.lastError
          ? { ok: false, error: chrome.runtime.lastError.message }
          : (resp || { ok: false, error: '扩展后台无响应' });
        post({ source: NS, type: 'PDD_ORDERS_RESULT', reqId, data });
      });
    }
  });

  // 初始公告 + load 后再公告一次(页面脚本可能晚于本脚本加载,两次确保页面能收到)
  post({ source: NS, type: 'PDD_PONG' });
  window.addEventListener('load', () => post({ source: NS, type: 'PDD_PONG' }));
})();
