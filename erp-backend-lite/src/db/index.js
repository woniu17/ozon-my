// SQLite 数据库初始化(使用 Node 22.5+ 内置的 node:sqlite,零原生依赖)
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_PATH = join(DATA_DIR, 'erp.db');
const SCHEMA_PATH = join(__dirname, 'schema.sql');

// 确保数据目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// 初始化 schema
export function initSchema() {
  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);
  ensureMigrations();
}

// 轻量迁移:为已存在的表补列(CREATE TABLE IF NOT EXISTS 不会更新旧表结构)
function ensureMigrations() {
  // product_data_cache.store_id(用于关联店铺,拉特征/描述时需用对应店铺凭据)
  const cols = db.prepare(`PRAGMA table_info(product_data_cache)`).all();
  if (!cols.some((c) => c.name === 'store_id')) {
    db.exec(`ALTER TABLE product_data_cache ADD COLUMN store_id TEXT`);
    console.log('[db] migration: added column product_data_cache.store_id');
  }
  // listing_templates 内置默认模板(is_builtin=1,不可删不可改)
  const builtinCount = db.prepare(`SELECT COUNT(*) as n FROM listing_templates WHERE is_builtin = 1`).get().n;
  if (builtinCount === 0) {
    const defaultConfig = JSON.stringify({
      brand: 'no_brand',
      imageOrder: 'keep',
      currency: 'CNY',
      mergeEnabled: false,
      uploadMode: 'api',
      applyWatermark: false,
      watermarkTemplateId: '',
      applyPoster: false,
      posterPrimaryOnly: false,
      applyAiRewrite: false,
      defaultStock: 10,
      salePriceStrategy: { type: 'ratio', value: 1 },
      minPriceStrategy: null,
      oldPriceStrategy: { type: 'ratio', value: 2 },
    });
    db.prepare(`INSERT INTO listing_templates (name, config_json, is_builtin, is_default) VALUES (?, ?, 1, 1)`).run(
      '默认模板',
      defaultConfig
    );
    console.log('[db] seed: inserted builtin default listing template');
  }
  // collect_box_v2:改为以 (store_id, sku) 为 key,多变体拆成多条记录
  migrateCollectBoxV2BySku(db);
}

// collect_box_v2 迁移:从 anchor_sku 维度(一条含多变体)改为 sku 维度(一变体一条)
// 步骤:1) 加 sku 列 2) 删旧索引 3) 拆分多变体行 4) 去重 5) 建新唯一索引
function migrateCollectBoxV2BySku(db) {
  const cbv2Cols = db.prepare(`PRAGMA table_info(collect_box_v2)`).all();
  const hasSkuCol = cbv2Cols.some((c) => c.name === 'sku');

  // 1) 加 sku 列(临时允许 NULL,拆分后再 NOT NULL —— SQLite 无法直接加 NOT NULL 列,故先加可空列,拆分后补约束)
  if (!hasSkuCol) {
    db.exec(`ALTER TABLE collect_box_v2 ADD COLUMN sku TEXT`);
    console.log('[db] migration: added column collect_box_v2.sku');
  }

  // 2) 删旧索引(普通索引 idx_cbv2_anchor_sku 和旧唯一索引 uniq_cbv2_store_anchor)
  db.exec(`DROP INDEX IF EXISTS idx_cbv2_anchor_sku`);
  db.exec(`DROP INDEX IF EXISTS uniq_cbv2_store_anchor`);

  // 3) 拆分多变体行:遍历每条记录的 variants_json,为每个变体生成一行
  //    旧记录的 variants_json 是数组(含母体+N变体),拆分后每行只保留对应变体
  //    已拆分过的记录(sku 已赋值)跳过
  const rowsToSplit = db
    .prepare(
      `SELECT id, store_id, anchor_sku, source_page_url, variants_json, raw_by_source_json, synthesized_items_json, collected_at, COALESCE(sku, '') as sku_val FROM collect_box_v2`
    )
    .all();

  let splitCount = 0;
  for (const row of rowsToSplit) {
    if (row.sku_val) continue; // 已拆分(sku 已赋值),跳过

    const variants = JSON.parse(row.variants_json || '[]');
    const synthesized = JSON.parse(row.synthesized_items_json || '[]');

    if (variants.length === 0) {
      // 无变体数据,用 anchor_sku 兜底
      db.prepare(`UPDATE collect_box_v2 SET sku = ? WHERE id = ?`).run(row.anchor_sku, row.id);
      splitCount++;
      continue;
    }

    // 第一条变体:原地更新(复用当前 id,避免删后重建)
    const firstVar = variants[0];
    const firstSku = String(firstVar?.sku?.value || firstVar?.sku || row.anchor_sku);
    const firstSyn = synthesized[0] ? JSON.stringify([synthesized[0]]) : '[]';
    db.prepare(`UPDATE collect_box_v2 SET sku = ?, variants_json = ?, synthesized_items_json = ? WHERE id = ?`).run(
      firstSku,
      JSON.stringify([firstVar]),
      firstSyn,
      row.id
    );
    splitCount++;

    // 剩余变体:插入新行
    for (let i = 1; i < variants.length; i++) {
      const v = variants[i];
      const vSku = String(v?.sku?.value || v?.sku || row.anchor_sku);
      const vSyn = synthesized[i] ? JSON.stringify([synthesized[i]]) : '[]';
      db.prepare(
        `INSERT INTO collect_box_v2
          (store_id, sku, anchor_sku, source_page_url, variants_json, raw_by_source_json, synthesized_items_json, collected_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      ).run(
        row.store_id,
        vSku,
        row.anchor_sku,
        row.source_page_url,
        JSON.stringify([v]),
        row.raw_by_source_json,
        vSyn,
        row.collected_at
      );
      splitCount++;
    }
  }
  if (splitCount > 0) {
    console.log(`[db] migration: split collect_box_v2 into ${splitCount} sku-level rows`);
  }

  // 4) 去重:同 (store_id, sku) 只保留 collected_at 最新的一条
  //    (拆分后可能出现同 sku 的重复,如同一变体被采集多次)
  const dupCount = db
    .prepare(
      `SELECT COUNT(*) as n FROM collect_box_v2
       WHERE sku IS NOT NULL AND id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY COALESCE(store_id, ''), sku
             ORDER BY COALESCE(collected_at, 0) DESC, id DESC
           ) AS rn
           FROM collect_box_v2 WHERE sku IS NOT NULL
         ) WHERE rn = 1
       )`
    )
    .get().n;
  if (dupCount > 0) {
    db.exec(
      `DELETE FROM collect_box_v2
       WHERE id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY COALESCE(store_id, ''), sku
             ORDER BY COALESCE(collected_at, 0) DESC, id DESC
           ) AS rn
           FROM collect_box_v2 WHERE sku IS NOT NULL
         ) WHERE rn = 1
       ) AND sku IS NOT NULL`
    );
    console.log(`[db] migration: dedup collect_box_v2 by (store_id, sku), removed ${dupCount} rows`);
  }

  // 5) 建新唯一索引(schema.sql 里也有同样定义,IF NOT EXISTS 保证幂等)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_cbv2_store_sku ON collect_box_v2(COALESCE(store_id, ''), sku)`);
  // 重建 anchor_sku 普通索引(用于同组变体关联查询)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cbv2_anchor_sku ON collect_box_v2(anchor_sku)`);
  console.log('[db] migration: ensured unique index uniq_cbv2_store_sku on collect_box_v2');
}

// 直接运行时初始化(node src/db/index.js)
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('db/index.js');
if (isMain) {
  initSchema();
  console.log('[db] schema initialized at', DB_PATH);
  db.close();
  process.exit(0);
}
