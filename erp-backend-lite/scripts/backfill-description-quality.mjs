// 一次性回填脚本: 用 JS 正则精准计算 ozon_cache_index + product_data_cache 的 description_quality
// 用法: node erp-backend-lite/scripts/backfill-description-quality.mjs [--dry-run]
//
// 与 db/index.js 的 backfillDescriptionQuality() 的区别:
//   - db/index.js 用 SQL LIKE 近似 classify,启动时自动跑一次,边界情况可能不准
//   - 本脚本用 JS 正则精准 classify(与 syncSku / scan-description-placeholders.mjs 同口径)
//
// 适用场景:
//   1. 首次迁移后,用本脚本重算一次,修正 SQL 近似的误差
//   2. 后续如需重算(如 classify 逻辑调整),可直接重跑
//   3. 可加 --dry-run 参数预览不写入
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyDescriptionQuality } from '../src/utils/description-quality.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'erp.db');
const DRY_RUN = process.argv.includes('--dry-run');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

// ════════════════════════════════════════════════════════════════
// Part A: 回填 ozon_cache_index.description_quality(采集箱商品)
//   数据源:ozon_rich_media_cache.data.description
// ════════════════════════════════════════════════════════════════
console.log('═══ Part A: ozon_cache_index.description_quality ═══');

// 检查列是否存在
const cols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
if (!cols.some((c) => c.name === 'description_quality')) {
  console.error('[error] ozon_cache_index.description_quality 列不存在,请先启动 ERP 触发迁移');
  process.exit(1);
}

// 取所有 rich_media_hit=1 的 SKU + 对应 description
console.log('[1/3] 查询需回填的 SKU(rich_media_hit=1)...');
const rows = db
  .prepare(
    `SELECT oci.sku, CAST(json_extract(r.data, '$.description') AS TEXT) AS description
     FROM ozon_cache_index oci
     LEFT JOIN ozon_rich_media_cache r ON r._id = oci.sku
     WHERE oci.rich_media_hit = 1`
  )
  .all();
console.log(`    共 ${rows.length} 个 SKU 待回填`);

// classify
console.log('[2/3] 计算 description_quality...');
const statsA = { 0: 0, 1: 0, 2: 0, 3: 0 };
const updatesA = [];
for (const r of rows) {
  const q = classifyDescriptionQuality(r.description);
  statsA[q]++;
  updatesA.push({ sku: r.sku, quality: q });
}
console.log('    分级统计:');
console.log(`      0 (空)     : ${statsA[0]}`);
console.log(`      1 (占位)   : ${statsA[1]}`);
console.log(`      2 (按钮污染): ${statsA[2]}`);
console.log(`      3 (正常)   : ${statsA[3]}`);

// 写入
console.log(`[3/3] ${DRY_RUN ? '预览模式,不写入' : '写入 ozon_cache_index.description_quality...'};`);
if (!DRY_RUN) {
  const updateStmt = db.prepare(`UPDATE ozon_cache_index SET description_quality = ? WHERE sku = ?`);
  db.exec('BEGIN');
  try {
    for (const u of updatesA) updateStmt.run(u.quality, u.sku);
    db.exec('COMMIT');
    console.log(`    已更新 ${updatesA.length} 行`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
} else {
  console.log(`    (预览) 将更新 ${updatesA.length} 行`);
}

// ════════════════════════════════════════════════════════════════
// Part B: 回填 product_data_cache.description_quality(商品列表已上架商品)
//   数据源:product_attributes_cache.description_data.description
//   v3/product/info/list 不返回 description,描述由「同步描述」单独拉取缓存到
//   product_attributes_cache.description_data,故只有同步过描述的商品才能回填
// ════════════════════════════════════════════════════════════════
console.log('\n═══ Part B: product_data_cache.description_quality ═══');

const pdcCols = db.prepare(`PRAGMA table_info(product_data_cache)`).all();
if (!pdcCols.some((c) => c.name === 'description_quality')) {
  console.error('[error] product_data_cache.description_quality 列不存在,请先启动 ERP 触发迁移');
  process.exit(1);
}

console.log('[1/3] 查询需回填的商品(已同步描述的)...');
const pdcRows = db
  .prepare(
    `SELECT p.sku AS sku, json_extract(a.description_data, '$.result.description') AS description
     FROM product_data_cache p
     JOIN product_attributes_cache a ON a.sku = p.sku
     WHERE a.description_data IS NOT NULL`
  )
  .all();
console.log(`    共 ${pdcRows.length} 个商品待回填`);

console.log('[2/3] 计算 description_quality...');
const statsB = { 0: 0, 1: 0, 2: 0, 3: 0 };
const updatesB = [];
for (const r of pdcRows) {
  const q = classifyDescriptionQuality(r.description);
  statsB[q]++;
  updatesB.push({ sku: r.sku, quality: q });
}
console.log('    分级统计:');
console.log(`      0 (空)     : ${statsB[0]}`);
console.log(`      1 (占位)   : ${statsB[1]}`);
console.log(`      2 (按钮污染): ${statsB[2]}`);
console.log(`      3 (正常)   : ${statsB[3]}`);

console.log(`[3/3] ${DRY_RUN ? '预览模式,不写入' : '写入 product_data_cache.description_quality...'};`);
if (!DRY_RUN) {
  const updateStmt = db.prepare(`UPDATE product_data_cache SET description_quality = ? WHERE sku = ?`);
  db.exec('BEGIN');
  try {
    for (const u of updatesB) updateStmt.run(u.quality, u.sku);
    db.exec('COMMIT');
    console.log(`    已更新 ${updatesB.length} 行`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
} else {
  console.log(`    (预览) 将更新 ${updatesB.length} 行`);
}

// 校验:当前两张表 description_quality 分布
console.log('\n═══ 校验:回填后分布 ═══');
console.log('\n[ozon_cache_index.description_quality 分布]:');
const distA = db
  .prepare(
    `SELECT description_quality, COUNT(*) as n
     FROM ozon_cache_index
     GROUP BY description_quality
     ORDER BY description_quality`
  )
  .all();
for (const d of distA) {
  console.log(`  quality=${d.description_quality}: ${d.n} SKUs`);
}

console.log('\n[product_data_cache.description_quality 分布]:');
const distB = db
  .prepare(
    `SELECT description_quality, COUNT(*) as n
     FROM product_data_cache
     GROUP BY description_quality
     ORDER BY description_quality`
  )
  .all();
for (const d of distB) {
  console.log(`  quality=${d.description_quality}: ${d.n} 商品`);
}

db.close();
console.log('\n完成');
