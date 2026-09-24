// 对比 /v1/finance/accrual/by-day 扫描结果 与 op_accrual(来源 /v1/finance/accrual/postings)
// 输出:类型分布、by-day 有而 postings 无的应计(类型级+明细级)、反向差、POSTING 销售明细统计
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';

const RAW = 'data/accrual-byday-raw.json';

function loadTypesDict(db) {
  const cols = db.prepare('PRAGMA table_info(app_config)').all().map((c) => c.name);
  const keyCol = cols.includes('config_key') ? 'config_key' : cols[0];
  const valCol = cols.includes('value_json') ? 'value_json' : cols[1];
  const rows = db.prepare(`SELECT ${valCol} v FROM app_config WHERE ${keyCol} LIKE '%accrual%types%'`).all();
  const map = new Map();
  if (rows.length) {
    const list = JSON.parse(rows[0].v).types || JSON.parse(rows[0].v);
    for (const t of list) map.set(Number(t.id), t.name);
  }
  return map;
}

function main() {
  if (!existsSync(RAW)) { console.error(`先运行 scan-accrual-byday.mjs 生成 ${RAW}`); process.exit(1); }
  const cache = JSON.parse(readFileSync(RAW, 'utf8'));
  const db = new DatabaseSync('data/erp.db', { readOnly: true });
  const dict = loadTypesDict(db);

  // ── 1. 展平 by-day ─────────────────────────────────────────
  // feeRow: { storeId, unit, type_id, sku, amount }  (ITEM + NON_ITEM)
  // postingRows: POSTING 类别销售明细(无 type_id)
  const feeRows = [];
  const postingRows = [];
  const catDist = { ITEM: 0, NON_ITEM: 0, POSTING: 0, OTHER: 0 };
  const errors = [];
  for (const [key, day] of Object.entries(cache)) {
    if (day.error) { errors.push(`${key}: ${day.error}`); continue; }
    const [storeId] = key.split('|');
    for (const a of day.accruals || []) {
      catDist[a.accrued_category] = (catDist[a.accrued_category] || 0) + 1;
      if (a.accrued_category === 'ITEM') {
        for (const g of a.item_fees?.fees || []) {
          for (const f of g.fees || []) {
            feeRows.push({ storeId, unit: a.unit_number, typeId: f.type_id, sku: g.sku, amount: Number(f.accrued?.amount ?? 0) });
          }
        }
      } else if (a.accrued_category === 'NON_ITEM') {
        feeRows.push({ storeId, unit: a.unit_number, typeId: a.non_item_fee?.type_id, sku: null, amount: Number(a.non_item_fee?.accrued?.amount ?? 0) });
      } else if (a.accrued_category === 'POSTING') {
        for (const p of a.posting?.products || []) {
          postingRows.push({ storeId, unit: a.unit_number, sku: p.sku, quantity: p.quantity, commission: p.commission });
          // 物流服务明细(含 type_id,如 59 ReturnFlowLogistic / 6 Cancellation)
          for (const s of p.delivery?.services || []) {
            feeRows.push({ storeId, unit: a.unit_number, typeId: s.type_id, sku: p.sku, amount: Number(s.accrued?.amount ?? 0) });
          }
        }
      } else {
        catDist.OTHER++;
      }
    }
  }

  // ── 2. 类型分布对比 ────────────────────────────────────────
  const bydayTypes = new Map();
  for (const r of feeRows) {
    const t = bydayTypes.get(r.typeId) || { count: 0, sum: 0 };
    t.count++; t.sum += r.amount;
    bydayTypes.set(r.typeId, t);
  }
  const dbTypes = new Map();
  for (const r of db.prepare('SELECT type_id, COUNT(*) c, SUM(amount) s FROM op_accrual GROUP BY type_id').all()) {
    dbTypes.set(r.type_id, { count: r.c, sum: r.s });
  }

  console.log('════ A. by-day 类别分布 ════');
  console.log(JSON.stringify(catDist), `fee 明细 ${feeRows.length} 行,POSTING 销售明细 ${postingRows.length} 行`);
  if (errors.length) console.log(`⚠ ${errors.length} 天拉取失败(示例: ${errors[0]})`);

  console.log('\n════ B. by-day 类型分布(ITEM+NON_ITEM) ════');
  console.log('type_id | 名称 | by-day条数 | by-day金额 | DB条数 | DB金额');
  const allTypes = [...new Set([...bydayTypes.keys(), ...dbTypes.keys()])].sort((a, b) => (bydayTypes.get(b)?.count || 0) - (bydayTypes.get(a)?.count || 0));
  for (const id of allTypes) {
    const b = bydayTypes.get(id) || { count: 0, sum: 0 };
    const d = dbTypes.get(id) || { count: 0, sum: 0 };
    const mark = b.count && !d.count ? ' ← postings 无此类型' : (!b.count && d.count ? ' ← by-day 无此类型' : '');
    console.log(`${id} | ${dict.get(id) || '(未知)'} | ${b.count} | ${b.sum.toFixed(2)} | ${d.count} | ${d.sum.toFixed(2)}${mark}`);
  }

  // ── 3. 明细级多重集对比 ────────────────────────────────────
  const keyOf = (r) => `${r.storeId}|${r.unit}|${r.typeId}|${r.sku ?? ''}|${Number(r.amount).toFixed(2)}`;
  const bydayMap = new Map();
  for (const r of feeRows) bydayMap.set(keyOf(r), (bydayMap.get(keyOf(r)) || 0) + 1);
  const dbMap = new Map();
  for (const r of db.prepare('SELECT store_id, posting_number, type_id, sku, amount FROM op_accrual').all()) {
    const k = `${r.store_id}|${r.posting_number}|${r.type_id}|${r.sku ?? ''}|${Number(r.amount).toFixed(2)}`;
    dbMap.set(k, (dbMap.get(k) || 0) + 1);
  }

  const missingInDb = [];   // by-day 有,DB(postings) 无
  for (const [k, n] of bydayMap) {
    const have = dbMap.get(k) || 0;
    for (let i = 0; i < n - have; i++) missingInDb.push(k);
  }
  const missingInByday = []; // DB 有,by-day 无
  for (const [k, n] of dbMap) {
    const have = bydayMap.get(k) || 0;
    for (let i = 0; i < n - have; i++) missingInByday.push(k);
  }

  console.log(`\n════ C. 明细级差(键: 店铺|货件|type|sku|金额) ════`);
  console.log(`by-day 有而 DB 无: ${missingInDb.length} 行`);
  const missType = new Map();
  let missSum = 0;
  for (const k of missingInDb) {
    const typeId = Number(k.split('|')[2]);
    const amount = Number(k.split('|')[4]);
    const t = missType.get(typeId) || { count: 0, sum: 0 };
    t.count++; t.sum += amount;
    missType.set(typeId, t);
    missSum += amount;
  }
  for (const [id, t] of [...missType.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  type ${id} (${dict.get(id) || '?'}): ${t.count} 行, ${t.sum.toFixed(2)}`);
  }
  console.log(`  合计金额: ${missSum.toFixed(2)}`);
  console.log(`  示例: ${missingInDb.slice(0, 5).join(' ; ')}`);

  console.log(`\nDB 有而 by-day 无: ${missingInByday.length} 行`);
  const revType = new Map();
  for (const k of missingInByday) {
    const typeId = Number(k.split('|')[2]);
    revType.set(typeId, (revType.get(typeId) || 0) + 1);
  }
  for (const [id, c] of [...revType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  type ${id} (${dict.get(id) || '?'}): ${c} 行`);
  }
  console.log(`  示例: ${missingInByday.slice(0, 5).join(' ; ')}`);

  // ── 4. POSTING 销售明细(postings 接口没有的收入侧) ─────────
  console.log(`\n════ D. POSTING 类别销售明细(postings 接口无对应) ════`);
  let seller = 0, sale = 0, comm = 0, coinvest = 0, bonus = 0;
  const postingUnits = new Set(postingRows.map((r) => `${r.storeId}|${r.unit}`));
  for (const r of postingRows) {
    const c = r.commission || {};
    seller += Number(c.seller_price?.amount ?? 0) * (r.quantity || 1);
    sale += Number(c.sale_amount?.amount ?? 0) * (r.quantity || 1);
    comm += Number(c.commission?.amount ?? 0) * (r.quantity || 1);
    coinvest += Number(c.coinvestment?.amount ?? 0) * (r.quantity || 1);
    bonus += Number(c.bonus?.amount ?? 0) * (r.quantity || 1);
  }
  console.log(`涉及货件 ${postingUnits.size} 个,明细 ${postingRows.length} 行:`);
  console.log(`  seller_price(卖家售价)合计: ${seller.toFixed(2)}`);
  console.log(`  sale_amount(实际结算)合计: ${sale.toFixed(2)}`);
  console.log(`  commission(佣金)合计: ${comm.toFixed(2)}`);
  console.log(`  coinvestment(共同投资)合计: ${coinvest.toFixed(2)}`);
  console.log(`  bonus(奖金)合计: ${bonus.toFixed(2)}`);
}

main();
