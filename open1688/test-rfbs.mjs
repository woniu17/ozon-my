// /v2/returns/rfbs/list 找正确过滤写法 + 确认 0114386170-0307-1
import fs from 'fs';

const storesCfg = JSON.parse(fs.readFileSync('c:/root/code/ozon-my/erp-backend-lite/src/config/stores.json', 'utf8'));
const stores = Array.isArray(storesCfg) ? storesCfg : storesCfg.stores || [];
const s = stores.find(x => x.id === 'store-yql01-b6b2b1' || /YQL01/i.test(x.name || '')) || stores.find(x => x.sync_credentials);

const OPI = 'https://api-seller.ozon.ru';
async function call(path, body) {
  const r = await fetch(OPI + path, {
    method: 'POST',
    headers: { 'Client-Id': s.sync_credentials.clientId, 'Api-Key': s.sync_credentials.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 400) }; }
  return { http: r.status, ...j };
}

// 1. 全量翻页,找目标订单 + 统计总数
let all = [];
let offset = 0;
const LIMIT = 1000;
while (true) {
  const r = await call('/v2/returns/rfbs/list', { limit: LIMIT, offset });
  const rs = r.returns || [];
  all = all.concat(rs);
  if (!r.has_more || rs.length === 0) { console.log('total:', r.total ?? 'n/a', '| has_more:', r.has_more, '| accumulated:', all.length); break; }
  offset += LIMIT;
  if (offset > 5000) { console.log('safety break at', offset); break; }
}
console.log('\n共拉到', all.length, '条 rFBS 退货(YQL01 全部)');

// 按月统计
const byMonth = {};
for (const x of all) {
  const m = (x.created_at || '').slice(0, 7);
  byMonth[m] = (byMonth[m] || 0) + 1;
}
console.log('按月分布:', JSON.stringify(byMonth));

// 状态统计
const byState = {};
for (const x of all) {
  const st = x.state?.group_state || x.state?.state || '?';
  byState[st] = (byState[st] || 0) + 1;
}
console.log('状态分布:', JSON.stringify(byState));

// 2. 目标订单在里面吗?
const target = all.filter(x => x.posting_number === '0114386170-0307-1');
console.log('\n目标订单 0114386170-0307-1:', target.length ? '找到!' : '不在列表中');
if (target.length) console.log(JSON.stringify(target, null, 1));

// 3. 试其它过滤写法(单号字符串数组)
const r2 = await call('/v2/returns/rfbs/list', {
  filter: { posting_numbers: ['0114386170-0307-1'] },
  limit: 50, offset: 0,
});
console.log('\n== filter.posting_numbers 写法 ==');
console.log('http:', r2.http, '| count:', (r2.returns || []).length);
if (r2.message) console.log('message:', r2.message);
