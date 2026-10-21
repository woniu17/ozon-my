// 一次性回填脚本: 用 JS parsePriceValue 重算 ozon_cache_index 的 price_value + price
// 用法: node erp-backend-lite/scripts/backfill-price-value.mjs [--dry-run]
//
// 背景: Ozon 价格存在逗号小数格式("21,91 ¥"=21.91),旧逻辑会解析成 2191(膨胀 100 倍)。
//       修复 index-dao.js 的 parsePriceValue 后,用本脚本重算存量数据:
//         - price_value: 数字价格(供采集箱价格范围过滤/导出跟卖价计算)
//         - price       : 展示价格,统一规范化为数字字符串("15,12 ¥" → "15.12")
//
// 适用场景: parsePriceValue 解析逻辑调整后,重跑一次即可修正存量 price/price_value。
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parsePriceValue } from '../src/db/dao/sqlite/index-dao.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'collect.db');
const DRY_RUN = process.argv.includes('--dry-run');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

console.log(`[1/3] 读取待重算的 SKU(price 非空)...`);
const rows = db
  .prepare(`SELECT sku, price, price_value FROM ozon_cache_index WHERE price IS NOT NULL AND price <> ''`)
  .all();
console.log(`    共 ${rows.length} 个 SKU`);

console.log(`[2/3] 重算 price / price_value...`);
const updates = [];
const stats = { same: 0, priceChanged: 0, valueChanged: 0 };
for (const r of rows) {
  const v = parsePriceValue(r.price);
  const newPrice = v === null ? '' : String(v);
  const priceChanged = newPrice !== r.price;
  const valueChanged = v !== r.price_value;
  if (priceChanged || valueChanged) {
    updates.push({ sku: r.sku, price: r.price, newPrice, newValue: v, oldValue: r.price_value });
    if (priceChanged) stats.priceChanged++;
    if (valueChanged) stats.valueChanged++;
  } else {
    stats.same++;
  }
}
console.log(`    无需变更: ${stats.same} | price 展示需修正: ${stats.priceChanged} | price_value 需修正: ${stats.valueChanged}`);

if (updates.length === 0) {
  console.log(`[3/3] 无需更新`);
  process.exit(0);
}

// 预览前 20 条变化
console.log(`\n变化预览(前 ${Math.min(updates.length, 20)} 条):`);
for (const u of updates.slice(0, 20)) {
  const oldP = JSON.stringify(u.price);
  const newP = JSON.stringify(u.newPrice);
  const oldV = u.oldValue ?? '(null)';
  const newV = u.newValue ?? '(null)';
  console.log(`  ${u.sku}  price: ${oldP} → ${newP}  |  price_value: ${oldV} → ${newV}`);
}
if (updates.length > 20) {
  console.log(`  ... 其余 ${updates.length - 20} 条略`);
}

if (DRY_RUN) {
  console.log(`\n[dry-run] 跳过写入,共 ${updates.length} 条待更新`);
  process.exit(0);
}

console.log(`\n[3/3] 写入 ${updates.length} 条更新...`);
const stmt = db.prepare(
  `UPDATE ozon_cache_index SET price = ?, price_value = ?, updated_at = datetime('now') WHERE sku = ?`
);
db.exec('BEGIN');
try {
  for (const u of updates) {
    stmt.run(u.newPrice, u.newValue, u.sku);
  }
  db.exec('COMMIT');
  console.log(`    完成: ${updates.length} 条已修正`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`    失败,已回滚: ${e.message}`);
  process.exit(1);
}