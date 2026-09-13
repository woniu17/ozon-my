// 冒烟:四账号 1688 官方 API 验证
const fs = require('fs');
const key = fs.readFileSync('c:/root/code/ozon-my/erp-backend-lite/.env', 'utf8').match(/^SERVICE_API_KEY=(.+)$/m)[1].trim();
const BASE = 'http://127.0.0.1:3001';

async function main() {
  // 1. /status 账号清单
  let r = await fetch(`${BASE}/admin/api/platform-orders/status`, { headers: { 'x-api-key': key } });
  let j = await r.json();
  const accounts = j.data?.platforms?.ali1688?.accounts || {};
  console.log('[1] /status ali1688 账号:');
  for (const [a, st] of Object.entries(accounts)) console.log(`    ${a}: login=${st.login} source=${st.source || 'browser'}`);

  // 2. 逐账号列表(验证每个 token)
  for (const a of Object.keys(accounts)) {
    const t0 = Date.now();
    try {
      r = await fetch(`${BASE}/admin/api/platform-orders/ali1688?tab=all&size=5&account=${a}`, { headers: { 'x-api-key': key } });
      j = await r.json();
      const os = j.data?.orders || [];
      const last = os[0];
      console.log(`[2] ${a}: HTTP ${r.status} 订单数=${os.length} ${Date.now() - t0}ms` + (last ? ` | 最新: ${last.orderSn} ${last.statusPrompt} ¥${last.amount} ${last.orderTime} ${String((last.goods[0]||{}).goodsName||'').slice(0,12)}` : ''));
    } catch (e) {
      console.log(`[2] ${a}: 异常 ${e.message}`);
    }
  }

  // 3. 跨账号搜索(取 chenlin 最新单号,应在 chenlin 命中)
  r = await fetch(`${BASE}/admin/api/platform-orders/ali1688?tab=all&size=1&account=chenlin`, { headers: { 'x-api-key': key } });
  j = await r.json();
  const sn = j.data?.orders?.[0]?.orderSn;
  if (sn) {
    const t1 = Date.now();
    r = await fetch(`${BASE}/admin/api/platform-orders/ali1688/search?orderSn=${sn}`, { headers: { 'x-api-key': key } });
    j = await r.json();
    console.log(`[3] 跨账号搜索 ${sn}: HTTP ${r.status} 命中账号=${j.data?.result?.account || '无'} 耗时=${Date.now() - t1}ms`);
  }
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
