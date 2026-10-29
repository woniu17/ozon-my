// 一次性数据修复(2026-10-29):历史快照中 Ozon 返回的跟卖报价有部分是卢布(₽),
// 导致 min_price/median/my_rank/gap 等指标与 my_price(人民币)混算错误。
// 修复:对每个含卢布价格的快照,用 parsePriceText(统一换算 CNY)重算指标字段。
// sellers JSON 保留原始价格(接口返回时 normalizeSellersForResponse 动态换算展示)。
import { db } from './src/db/index.js';
import { computeMetrics } from './src/modules/price-watch.js';
import { refreshRubCnyRate, getRubCnyRate } from './src/services/rub-cny-rate.js';

await refreshRubCnyRate();
console.log('当前汇率 1 RUB =', getRubCnyRate(), 'CNY');

const rows = db
  .prepare(`SELECT id, sku, my_price, sellers FROM price_watch_snapshots WHERE status='ok'`)
  .all();

let fixed = 0;
let skipped = 0;
let hasRubCount = 0;
const stmt = db.prepare(
  `UPDATE price_watch_snapshots
     SET seller_count=?, min_price=?, median_price=?, avg_price=?,
         my_rank=?, is_cheapest=?, gap_abs=?, gap_pct=?, vs_median=?
   WHERE id=?`
);
db.exec('BEGIN');
try {
  for (const r of rows) {
    let sellers = [];
    try { sellers = JSON.parse(r.sellers || '[]'); } catch { /* 忽略损坏 */ }
    if (!Array.isArray(sellers)) sellers = [];
    const hasRub = sellers.some((s) => /₽|руб|RUB/i.test(JSON.stringify(s?.price || '')));
    if (hasRub) hasRubCount++;
    const m = computeMetrics(r.my_price, sellers);
    if (!hasRub) { skipped++; continue; }
    stmt.run(
      m.sellerCount, m.minPrice, m.medianPrice, m.avgPrice,
      m.myRank, m.isCheapest, m.gapAbs, m.gapPct, m.vsMedian, r.id
    );
    fixed++;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
console.log(`扫描 ${rows.length} 条 ok 快照, 含卢布 ${hasRubCount} 条, 已修复 ${fixed} 条, 跳过(纯人民币) ${skipped} 条`);