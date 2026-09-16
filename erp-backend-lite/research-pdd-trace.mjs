// 研究:PDD 轨迹 API(api/express/shipping/track)在浏览器上下文是否可调(一次性研究脚本,服务器跑)
import { withPage } from './src/services/platform-orders/browser-manager.js';

const ORDER_SN = '260827-429811362083751';
const TRACK_NO = 'JT5519906265411';

const r = await withPage('linqx', 'pdd', 'https://mobile.yangkeduo.com/', 'https://mobile.yangkeduo.com', async (page) => {
  return page.evaluate(async (params) => {
    const qs = new URLSearchParams(params).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const resp = await fetch(`https://mobile.yangkeduo.com/proxy/api/api/express/shipping/track?${qs}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      let json = null;
      try { json = await resp.json(); } catch { /* ignore */ }
      return { status: resp.status, json };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  }, { order_sn: ORDER_SN, tracking_number: TRACK_NO, query_type: 1 });
});

console.log('HTTP', r.status, r.error || '');
const j = r.json || {};
console.log('success:', j.success, 'error_code:', j.error_code, 'error_msg:', (j.error_msg || '').slice(0, 120));
const ship = j.result && j.result.shipping;
if (ship) {
  console.log('shipping keys:', Object.keys(ship).join(','));
  const trace = ship.track_list || ship.trace_list || [];
  console.log('track_list length:', trace.length);
  for (const t of trace.slice(0, 5)) console.log(' -', JSON.stringify(t).slice(0, 220));
} else {
  console.log(JSON.stringify(j).slice(0, 1200));
}
