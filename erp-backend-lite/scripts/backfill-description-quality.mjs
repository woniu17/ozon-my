// 一次性回填脚本: 用 JS 正则精准计算 ozon_cache_index.description_quality
// 用法: node erp-backend-lite/scripts/backfill-description-quality.mjs
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'erp.db');
const DRY_RUN = process.argv.includes('--dry-run');

// ── classify 逻辑(与 index-dao.js syncSku + qx-ozon/lib/follow-sell-content-copy.js 同口径) ──
const UI_CHROME_RE = /(читать далее|показать полностью|свернуть описание|развернуть описание)/gi;
const LOAD_FAIL_RE = /(не удалось загрузить|ошибка загрузки|попробуйте (обновить|позже)|failed to load)/i;

function classifyDescription(raw) {
  if (!raw) return 0; // 空
  const str = String(raw).trim();
  if (!str) return 0;
  // 剥按钮文案
  const cleaned = str.replace(UI_CHROME_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 1; // 剥完为空 → 纯按钮文案,占位
  // 开头(前 120 字符)命中加载失败关键词 → 占位
  if (LOAD_FAIL_RE.test(cleaned.slice(0, 120))) return 1;
  // 含按钮文案但剥后非空 → 按钮污染
  if (UI_CHROME_RE.test(str)) return 2;
  // 其余 → 正常
  return 3;
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

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
const stats = { 0: 0, 1: 0, 2: 0, 3: 0 };
const updates = [];
for (const r of rows) {
  const q = classifyDescription(r.description);
  stats[q]++;
  updates.push({ sku: r.sku, quality: q });
}
console.log('    分级统计:');
console.log(`      0 (空)     : ${stats[0]}`);
console.log(`      1 (占位)   : ${stats[1]}`);
console.log(`      2 (按钮污染): ${stats[2]}`);
console.log(`      3 (正常)   : ${stats[3]}`);

// 写入
console.log(`[3/3] ${DRY_RUN ? '预览模式,不写入' : '写入 ozon_cache_index.description_quality...'};`);
if (!DRY_RUN) {
  const updateStmt = db.prepare(`UPDATE ozon_cache_index SET description_quality = ? WHERE sku = ?`);
  db.exec('BEGIN');
  try {
    for (const u of updates) updateStmt.run(u.quality, u.sku);
    db.exec('COMMIT');
    console.log(`    已更新 ${updates.length} 行`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
} else {
  console.log(`    (预览) 将更新 ${updates.length} 行`);
}

// 校验:与旧 SQL 回填结果对比(如有差异说明 SQL 近似有误差)
console.log('\n[校验] 当前 ozon_cache_index.description_quality 分布:');
const dist = db
  .prepare(
    `SELECT description_quality, COUNT(*) as n
     FROM ozon_cache_index
     GROUP BY description_quality
     ORDER BY description_quality`
  )
  .all();
for (const d of dist) {
  console.log(`  quality=${d.description_quality}: ${d.n} SKUs`);
}

db.close();
console.log('\n完成');
