// SQLite 数据库初始化(使用 Node 22.5+ 内置的 node:sqlite,零原生依赖)
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { classifyDescriptionQuality } from '../utils/description-quality.js';

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
export async function initSchema() {
  // 2026-07: isChinese → isMainlandChina 列重命名必须在 exec(schema.sql) 之前执行,
  // 因为 schema.sql 的 CREATE INDEX 引用 isMainlandChina 列,旧库需先 RENAME 才能创建索引
  const _scColsPre = db.prepare(`PRAGMA table_info(ozon_store_classification)`).all();
  if (_scColsPre.length > 0 && _scColsPre.some((c) => c.name === 'isChinese')) {
    db.exec(`ALTER TABLE ozon_store_classification RENAME COLUMN isChinese TO isMainlandChina`);
    db.exec(`DROP INDEX IF EXISTS idx_sc_chinese`);
    console.log('[db] migration: renamed column ozon_store_classification.isChinese → isMainlandChina');
  }
  const _legacyColsPre = db.prepare(`PRAGMA table_info(ozon_store_classification_legacy)`).all();
  if (_legacyColsPre.length > 0 && _legacyColsPre.some((c) => c.name === 'isChinese')) {
    db.exec(`ALTER TABLE ozon_store_classification_legacy RENAME COLUMN isChinese TO isMainlandChina`);
    console.log('[db] migration: renamed column ozon_store_classification_legacy.isChinese → isMainlandChina');
  }
  const sql = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(sql);
  await ensureMigrations();
}

// 轻量迁移:为已存在的表补列(CREATE TABLE IF NOT EXISTS 不会更新旧表结构)
async function ensureMigrations() {
  // product_data_cache.store_id(用于关联店铺,拉特征/描述时需用对应店铺凭据)
  const cols = db.prepare(`PRAGMA table_info(product_data_cache)`).all();
  if (!cols.some((c) => c.name === 'store_id')) {
    db.exec(`ALTER TABLE product_data_cache ADD COLUMN store_id TEXT`);
    console.log('[db] migration: added column product_data_cache.store_id');
  }
  // product_data_cache.description_quality:描述质量分级,用于商品列表"描述状态"过滤
  // 0=空 1=占位 2=按钮污染 3=正常(同步时由 classifyDescriptionQuality 计算)
  let addedProductDescQuality = false;
  if (!cols.some((c) => c.name === 'description_quality')) {
    db.exec(`ALTER TABLE product_data_cache ADD COLUMN description_quality INTEGER DEFAULT 0`);
    console.log('[db] migration: added column product_data_cache.description_quality');
    addedProductDescQuality = true;
  }
  if (addedProductDescQuality) {
    backfillProductDescriptionQuality();
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
  // collect_box_v2 表已废弃(改为以 cardCache 为基准的缓存视图),清理旧表
  dropLegacyCollectBoxV2(db);
  // collect_queue_tasks:增加 duration 列(SW result 接口上报任务耗时)
  const taskCols = db.prepare(`PRAGMA table_info(collect_queue_tasks)`).all();
  if (!taskCols.some((c) => c.name === 'duration')) {
    db.exec(`ALTER TABLE collect_queue_tasks ADD COLUMN duration INTEGER`);
    console.log('[db] migration: added column collect_queue_tasks.duration');
  }
  // collect_queue_tasks:增加 force_refresh 列(1=强制重新采集,SW 消费时传 forceRefresh=true)
  // 旧库(CREATE TABLE IF NOT EXISTS 不会更新旧表结构)需 ALTER TABLE 补列
  if (!taskCols.some((c) => c.name === 'forceRefresh')) {
    db.exec(`ALTER TABLE collect_queue_tasks ADD COLUMN forceRefresh INTEGER DEFAULT 0`);
    console.log('[db] migration: added column collect_queue_tasks.forceRefresh');
  }
  // follow_sell_tasks:库存快照列(任务创建时存,模板修改不影响)
  const fstCols = db.prepare(`PRAGMA table_info(follow_sell_tasks)`).all();
  if (!fstCols.some((c) => c.name === 'stock_snapshot')) {
    db.exec(`ALTER TABLE follow_sell_tasks ADD COLUMN stock_snapshot INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_tasks.stock_snapshot');
  }
  if (!fstCols.some((c) => c.name === 'template_id')) {
    db.exec(`ALTER TABLE follow_sell_tasks ADD COLUMN template_id INTEGER`);
    console.log('[db] migration: added column follow_sell_tasks.template_id');
  }
  // 2026-07: OPI 提交时间(拿到 ozon_task_id 的时刻),用于 import-status-poller 精准判超时
  // 旧数据 opi_submitted_at=NULL,poller 回退到 created_at 计算(保持向后兼容)
  if (!fstCols.some((c) => c.name === 'opi_submitted_at')) {
    db.exec(`ALTER TABLE follow_sell_tasks ADD COLUMN opi_submitted_at TEXT`);
    console.log('[db] migration: added column follow_sell_tasks.opi_submitted_at');
  }
  // 2026-07:自动触发图片更新时回写的关联任务 ID(import-status-poller 检测到图片错误后创建)
  // 用于上架记录页展示"图片更新"状态徽章并跳转到详情
  if (!fstCols.some((c) => c.name === 'image_refresh_task_id')) {
    db.exec(`ALTER TABLE follow_sell_tasks ADD COLUMN image_refresh_task_id TEXT`);
    console.log('[db] migration: added column follow_sell_tasks.image_refresh_task_id');
  }
  // follow_sell_task_items:库存同步状态
  const fstiCols = db.prepare(`PRAGMA table_info(follow_sell_task_items)`).all();
  if (!fstiCols.some((c) => c.name === 'stock_set')) {
    db.exec(`ALTER TABLE follow_sell_task_items ADD COLUMN stock_set INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_task_items.stock_set');
  }
  if (!fstiCols.some((c) => c.name === 'stock_attempts')) {
    db.exec(`ALTER TABLE follow_sell_task_items ADD COLUMN stock_attempts INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_task_items.stock_attempts');
  }
  // has_error / has_warning:按 errors[].level 计算,用于 summarizeTaskStatus 判断
  // imported + has_error=1 视为审核拒绝(失败),has_warning=1 视为有警告但成功
  if (!fstiCols.some((c) => c.name === 'has_error')) {
    db.exec(`ALTER TABLE follow_sell_task_items ADD COLUMN has_error INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_task_items.has_error');
  }
  if (!fstiCols.some((c) => c.name === 'has_warning')) {
    db.exec(`ALTER TABLE follow_sell_task_items ADD COLUMN has_warning INTEGER DEFAULT 0`);
    console.log('[db] migration: added column follow_sell_task_items.has_warning');
  }
  // 2026-07: sellerSlug → sellerId 主键迁移
  // 1) ozon_cache_index 补 seller_id 列 + 索引,从 ozon_store_sku 反查回填
  // 2) ozon_auto_collect_log 补 sellerId 列 + 索引,从 ozon_store_sku 反查回填
  // 3) ozon_store_classification 重建表(_id = sellerId),旧表数据迁移到 legacy 表
  await migrateSellerIdPrimaryKey(db);
  // 2026-07: 清理 ozon_store_classification 中 _id 非 数字 的脏记录(slug 被当 sellerId 写入)
  await cleanupStoreClassificationDirtyRows(db);
  // 2026-07: 跟卖状态即时标记 — ozon_cache_index 补 listed_store_id/listed_at/listed_task_id 列
  // 并从 follow_sell_task_items + follow_sell_tasks 一次性回填(取最近一条任务)
  await migrateListedFields(db);
  // 2026-08: 超轻小件筛选 — ozon_cache_index 补 weight_g / dim_sum_mm 列 + 从 bundle_data 回填
  await migrateUltraLightFields(db);
  // 2026-08: 深度采集日志补 reason 列(跳过原因)
  migrateAutoCollectLogReason(db);
  // P2-2: 批量均衡上架 — batch_upload_tasks / batch_upload_items 补列(多店铺分配 + 顺序执行 + 速度控制)
  migrateBatchUploadTables(db);
  // 2026-07: watermark_templates.name UNIQUE 索引(旧库 schema 没有 UNIQUE,需补建)
  // 若已存在重名行,迁移前先去重(保留最早 id),再建 UNIQUE 索引
  const wmCols = db.prepare(`PRAGMA table_info(watermark_templates)`).all();
  if (wmCols.length > 0) {
    const dupNames = db
      .prepare(`SELECT name, COUNT(*) as n FROM watermark_templates GROUP BY name HAVING n > 1`)
      .all();
    if (dupNames.length > 0) {
      // 重名行:保留最小 id,其余改为 "{name}_{id}" 避免冲突
      for (const d of dupNames) {
        const rows = db
          .prepare(`SELECT id, name FROM watermark_templates WHERE name=? ORDER BY id ASC`)
          .all(d.name);
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          db.prepare(`UPDATE watermark_templates SET name=? WHERE id=?`).run(`${r.name}_${r.id}`, r.id);
        }
      }
      console.log(`[db] migration: deduplicated ${dupNames.length} watermark_templates names`);
    }
    const idxExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='watermark_templates' AND name='idx_wm_name_unique'`)
      .get();
    if (!idxExists) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wm_name_unique ON watermark_templates(name)`);
      console.log('[db] migration: created UNIQUE index watermark_templates.name');
    }
  }
  // ozon_cache_index.has_rich_content:richMedia.data.richContent 非空则 1,用于采集箱"有富内容"筛选
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  let addedHasRichContent = false;
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'has_rich_content')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN has_rich_content INTEGER DEFAULT 0`);
    console.log('[db] migration: added column ozon_cache_index.has_rich_content');
    addedHasRichContent = true;
  }
  // ozon_cache_index.description_quality:描述质量分级,用于采集箱"描述状态"过滤
  // 0=空 1=占位(Не удалось загрузить…/纯按钮文案) 2=按钮污染(真描述末尾粘Читать далее) 3=正常
  // 与 scripts/scan-description-placeholders.mjs + qx-ozon/lib/follow-sell-content-copy.js 同口径
  let addedDescriptionQuality = false;
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'description_quality')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN description_quality INTEGER DEFAULT 0`);
    console.log('[db] migration: added column ozon_cache_index.description_quality');
    addedDescriptionQuality = true;
  }
  // ozon_cache_index.market_stats_empty:marketStats 缓存 __empty 标记(采集成功但 Ozon 无数据)
  // 用于采集箱"有/无市场统计"筛选。market_stats_hit 不区分 __empty,需额外冗余位
  let addedMarketStatsEmpty = false;
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'market_stats_empty')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN market_stats_empty INTEGER DEFAULT 0`);
    console.log('[db] migration: added column ozon_cache_index.market_stats_empty');
    addedMarketStatsEmpty = true;
  }
  // 缓存表重构:直接 DROP 旧 7 表 + legacy 表,新版用 6 张表(1 索引 + 5 数据)
  // 不写迁移脚本,旧数据自然过期(SW 重新采集填充新表)
  dropLegacyCacheTables(db);
  // 索引表新增 price_value 列 + FTS5 虚拟表 + 触发器
  ensureCacheIndexFtsAndPriceValue(db);
  // 一次性回填:has_rich_content 列刚加上时,旧 syncSku 未计算此字段(默认 0)
  // 对 rich_media_hit=1 的 SKU 从 ozon_rich_media_cache 重算 has_rich_content
  if (addedHasRichContent) {
    backfillHasRichContent();
  }
  // 一次性回填:description_quality 列刚加上时,旧 syncSku 未计算此字段(默认 0)
  // 对 rich_media_hit=1 的 SKU 从 ozon_rich_media_cache 提取 description 并 classify
  if (addedDescriptionQuality) {
    backfillDescriptionQuality();
  }
  // 一次性回填:market_stats_empty 列刚加上时,旧 syncSku 未计算此字段(默认 0)
  // 对 market_stats_hit=1 的 SKU 从 ozon_market_stats_cache.data 检测 __empty 标记
  if (addedMarketStatsEmpty) {
    backfillMarketStatsEmpty();
  }
  // 2026-07: 跟卖列表抽取店铺数据 — ozon_store_classification 补 logoImageUrl 列
  const scCols = db.prepare(`PRAGMA table_info(ozon_store_classification)`).all();
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'logoImageUrl')) {
    db.exec(`ALTER TABLE ozon_store_classification ADD COLUMN logoImageUrl TEXT`);
    console.log('[db] migration: added column ozon_store_classification.logoImageUrl');
  }
  // 2026-08: 店铺统计指标 — 4 个顶层列(便于 SQL 排序/筛选),数据从 companyInfo.stats 提取
  // 数据稀疏:仅店铺页方案B(entrypoint-api)能取到,PDP/方案A 为 NULL
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'orders_count')) {
    db.exec(`ALTER TABLE ozon_store_classification ADD COLUMN orders_count INTEGER`);
    console.log('[db] migration: added column ozon_store_classification.orders_count');
  }
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'reviews_count')) {
    db.exec(`ALTER TABLE ozon_store_classification ADD COLUMN reviews_count INTEGER`);
    console.log('[db] migration: added column ozon_store_classification.reviews_count');
  }
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'rating')) {
    db.exec(`ALTER TABLE ozon_store_classification ADD COLUMN rating REAL`);
    console.log('[db] migration: added column ozon_store_classification.rating');
  }
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'opened_months')) {
    db.exec(`ALTER TABLE ozon_store_classification ADD COLUMN opened_months INTEGER`);
    console.log('[db] migration: added column ozon_store_classification.opened_months');
  }
  // 排序索引(CREATE INDEX IF NOT EXISTS 自身幂等,无需 PRAGMA 检查)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sc_orders ON ozon_store_classification(orders_count DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sc_rating ON ozon_store_classification(rating DESC)`);
  // isChinese → isMainlandChina 列重命名已在 ensureMigrations 开头执行
}

// 一次性回填 ozon_cache_index.has_rich_content
// 旧 syncSku 不计算此字段,新增列后默认 0,需对 rich_media_hit=1 的 SKU 重算
// 逻辑与 index-dao.js syncSku 一致:richMedia.data.richContent 非空(字符串长度>0) → 1
function backfillHasRichContent() {
  const result = db
    .prepare(
      `UPDATE ozon_cache_index
       SET has_rich_content = COALESCE((
         SELECT CASE
           WHEN json_extract(r.data, '$.richContent') IS NOT NULL
             AND LENGTH(CAST(json_extract(r.data, '$.richContent') AS TEXT)) > 0
           THEN 1 ELSE 0 END
         FROM ozon_rich_media_cache r
         WHERE r._id = ozon_cache_index.sku
       ), 0)
       WHERE rich_media_hit = 1`
    )
    .run();
  console.log(
    `[db] migration: backfilled has_rich_content for ${result.changes} SKUs (rich_media_hit=1)`
  );
}

// 一次性回填 ozon_cache_index.description_quality
// 旧 syncSku 不计算此字段,新增列后默认 0,需对 rich_media_hit=1 的 SKU 重算
// 与 index-dao.js syncSku 的 descriptionQuality 计算同口径:
//   0=空 1=占位(Не удалось загрузить…/纯按钮文案) 2=按钮污染(真描述末尾粘Читать далее) 3=正常
// 注:SQL 内用 LIKE 近似实现 classify,边界情况由 scripts/backfill-description-quality.mjs (JS 正则精准版)修正
// 2026-08 修复:加载失败关键词改为任意位置匹配(原仅开头匹配会漏判末尾占位)
function backfillDescriptionQuality() {
  // 用 UPDATE-FROM 语法(SQLite 3.33+),从 ozon_rich_media_cache.data.description 提取并 classify
  // - 空或 NULL → 0
  // - 剥掉按钮文案后为空(纯按钮文案) → 1
  // - 任意位置命中加载失败关键词(Не удалось загрузить / Ошибка загрузки / Попробуйте …) → 1
  // - 含按钮文案但剥后非空(真描述末尾粘按钮) → 2
  // - 其余非空 → 3
  // REPLACE 区分大小写,故大小写各一次(читать далее/Читать далее 等共 8 次)
  // LIKE 对西里尔字母大小写敏感,故加载失败关键词也大小写各一次
  const result = db
    .prepare(
      `UPDATE ozon_cache_index
       SET description_quality = CASE
         WHEN r_desc IS NULL OR TRIM(r_desc) = '' THEN 0
         WHEN TRIM(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
           r_desc,
           'Читать далее', ''), 'читать далее', ''),
           'Показать полностью', ''), 'показать полностью', ''),
           'Свернуть описание', ''), 'свернуть описание', ''),
           'Развернуть описание', ''), 'развернуть описание', ''
         )) = '' THEN 1
         WHEN r_desc LIKE '%Не удалось загрузить%' OR r_desc LIKE '%не удалось загрузить%'
           OR r_desc LIKE '%Ошибка загрузки%' OR r_desc LIKE '%ошибка загрузки%'
           OR r_desc LIKE '%Попробуйте обновить%' OR r_desc LIKE '%попробуйте обновить%'
           OR r_desc LIKE '%Попробуйте позже%' OR r_desc LIKE '%попробуйте позже%'
           OR r_desc LIKE '%failed to load%' THEN 1
         WHEN r_desc LIKE '%Читать далее%' OR r_desc LIKE '%читать далее%'
           OR r_desc LIKE '%Показать полностью%' OR r_desc LIKE '%показать полностью%'
           OR r_desc LIKE '%Свернуть описание%' OR r_desc LIKE '%свернуть описание%'
           OR r_desc LIKE '%Развернуть описание%' OR r_desc LIKE '%развернуть описание%' THEN 2
         ELSE 3
         END
       FROM (
         SELECT oci.sku AS sku,
                CAST(json_extract(r.data, '$.description') AS TEXT) AS r_desc
         FROM ozon_cache_index oci
         LEFT JOIN ozon_rich_media_cache r ON r._id = oci.sku
       ) src
       WHERE ozon_cache_index.sku = src.sku
         AND ozon_cache_index.rich_media_hit = 1`
    )
    .run();
  console.log(
    `[db] migration: backfilled description_quality for ${result.changes} SKUs (rich_media_hit=1)`
  );
}

// 一次性回填 product_data_cache.description_quality
// v3 product/info/list 不返回 description,描述仅在 product_attributes_cache.description_data 中缓存
// (由「同步描述」或属性面板拉取 /v1/product/info/description 后写入)
// 回填从 product_attributes_cache.description_data 提取 description 并 classify
// 用 JS 正则精准分类(与 admin.js、index-dao.js syncSku 同口径),
// SQLite 无内建正则,故逐行读出 → classify → 批量 UPDATE(事务包裹)
function backfillProductDescriptionQuality() {
  const rows = db
    .prepare(
      `SELECT p.sku AS sku, json_extract(a.description_data, '$.result.description') AS desc
       FROM product_data_cache p
       JOIN product_attributes_cache a ON a.sku = p.sku
       WHERE a.description_data IS NOT NULL`
    )
    .all();
  if (!rows.length) return;
  const update = db.prepare(`UPDATE product_data_cache SET description_quality = ? WHERE sku = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) {
      update.run(classifyDescriptionQuality(r.desc), r.sku);
    }
  });
  tx();
  console.log(`[db] migration: backfilled product_data_cache.description_quality for ${rows.length} products (from product_attributes_cache)`);
}

// 一次性回填 ozon_cache_index.market_stats_empty
// 旧 syncSku 不计算此字段,新增列后默认 0,需对 market_stats_hit=1 的 SKU 重算
// 逻辑与 index-dao.js syncSku 一致:marketStats.data.__empty === true → 1
// 用 json_extract 精准匹配布尔 true,避免 LIKE 误伤(LIKE '%__empty%' 可能匹配到子串)
function backfillMarketStatsEmpty() {
  const result = db
    .prepare(
      `UPDATE ozon_cache_index
       SET market_stats_empty = CASE
         WHEN json_extract(m.data, '$.__empty') IS 1 THEN 1
         ELSE 0
       END
       FROM ozon_market_stats_cache m
       WHERE m._id = ozon_cache_index.sku
         AND ozon_cache_index.market_stats_hit = 1`
    )
    .run();
  console.log(
    `[db] migration: backfilled market_stats_empty for ${result.changes} SKUs (market_stats_hit=1)`
  );
}

// 旧表迁移:为 ozon_cache_index 补 price_value 列 + 一次性 rebuild FTS5 索引
// 注:price_value/FTS5 在 schema.sql 中已对全新库创建,本函数只为旧库补列 + 重建索引
function ensureCacheIndexFtsAndPriceValue(db) {
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)
  if (!ciCols.some((c) => c.name === 'price_value')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN price_value REAL`);
    console.log('[db] migration: added column ozon_cache_index.price_value');
    // 回填:从 price 字段解析数字写入 price_value
    // 与 index-dao.js 的 parsePriceValue 保持一致:去掉所有非数字非小数点字符
    //   "1 299 ₽" → 1299,"1,299.50" → 1299.50,"1299.00" → 1299.00
    // 注:用嵌套 REPLACE 去除常见符号 + 逗号(避免 SQLite CAST 对 "1,299" 截断为 1)
    db.exec(`
      UPDATE ozon_cache_index
      SET price_value = CAST(
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
          price, ' ', ''), ',', ''), '₽', ''), '€', ''), '$', ''), '￥', ''
        ) AS REAL
      )
      WHERE price IS NOT NULL AND price <> ''
    `);
    console.log('[db] migration: backfilled price_value from price');
  }
  // idx_ci_price_value 索引:在 schema.sql 中已移除,统一在此创建
  // (旧库需先 ALTER TABLE 补列再建索引,新库 ALTER 跳过,索引直接创建)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_price_value ON ozon_cache_index(price_value)`);
  // 删除旧的 idx_ci_fts(普通 B-tree,对 LIKE '%keyword%' 无效,被 FTS5 虚拟表替代)
  db.exec(`DROP INDEX IF EXISTS idx_ci_fts`);
  // 确保 FTS5 虚拟表与触发器存在(schema.sql 已创建,但旧库需补)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ozon_cache_index_fts USING fts5(
      sku, name, seller_name,
      content='ozon_cache_index', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ozon_cache_index_fts_ai AFTER INSERT ON ozon_cache_index BEGIN
      INSERT INTO ozon_cache_index_fts(rowid, sku, name, seller_name)
      VALUES (new.rowid, new.sku, new.name, new.seller_name);
    END;
    CREATE TRIGGER IF NOT EXISTS ozon_cache_index_fts_ad AFTER DELETE ON ozon_cache_index BEGIN
      INSERT INTO ozon_cache_index_fts(ozon_cache_index_fts, rowid, sku, name, seller_name)
      VALUES ('delete', old.rowid, old.sku, old.name, old.seller_name);
    END;
    CREATE TRIGGER IF NOT EXISTS ozon_cache_index_fts_au AFTER UPDATE ON ozon_cache_index BEGIN
      INSERT INTO ozon_cache_index_fts(ozon_cache_index_fts, rowid, sku, name, seller_name)
      VALUES ('delete', old.rowid, old.sku, old.name, old.seller_name);
      INSERT INTO ozon_cache_index_fts(rowid, sku, name, seller_name)
      VALUES (new.rowid, new.sku, new.name, new.seller_name);
    END;
  `);
  // 一次性 rebuild FTS5 索引(若 FTS5 表为空但 ozon_cache_index 非空,说明是旧库首次升级)
  const ftsCount = db.prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index_fts`).get().n;
  const ciCount = db.prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index`).get().n;
  if (ciCount > 0 && ftsCount === 0) {
    db.exec(`
      INSERT INTO ozon_cache_index_fts(rowid, sku, name, seller_name)
      SELECT rowid, sku, name, seller_name FROM ozon_cache_index
    `);
    console.log(`[db] migration: rebuilt FTS5 index with ${ciCount} rows`);
  }
}

// 清理旧缓存表(card/detail/search/bundle/composer/entrypoint 已合并为 dom/attribute)
function dropLegacyCacheTables(db) {
  const legacyTables = [
    'ozon_card_cache',
    'ozon_detail_cache',
    'ozon_search_cache',
    'ozon_bundle_cache',
    'ozon_composer_cache',
    'ozon_entrypoint_cache',
  ];
  for (const name of legacyTables) {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name);
    if (exists) {
      db.exec(`DROP TABLE IF EXISTS ${name}`);
      console.log(`[db] migration: dropped legacy table ${name} (已合并到 dom/attribute)`);
    }
  }
}

// 清理旧 collect_box_v2 表(及其索引)
// 数据已迁移到 7 类缓存表(cardCache 为基准 + 6 类辅助),采集箱前端只用缓存视图
function dropLegacyCollectBoxV2(db) {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='collect_box_v2'`)
    .get();
  if (exists) {
    db.exec(`DROP TABLE IF EXISTS collect_box_v2`);
    console.log('[db] migration: dropped legacy table collect_box_v2 (已用缓存视图替代)');
  }
}

// 2026-07: 清理 ozon_store_classification 中 _id 非数字的脏记录
// 根因:SW _erpStoreClassSet 曾在 sellerId 为空时 fallback 用 slug 作为 _id 写入主表,
// 产生 _id='xizixiaopu' 之类脏数据(同一 slug 后续拿到真实 sellerId 后会再写一条 _id=数字 的正确记录)。
// 清理策略:
//   - _id 非数字 + 同一 slug 已有数字 ID 记录 → 直接删除脏记录(信息已由正确记录保留)
//   - _id 非数字 + 同一 slug 无数字 ID 记录 → 迁移到 legacy 表后删除(保留历史分类信息)
// 幂等:无脏记录时直接跳过。
async function cleanupStoreClassificationDirtyRows(db) {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ozon_store_classification'`)
    .get();
  if (!tableExists) return;

  const dirtyRows = db
    .prepare(`SELECT _id, sellerSlug, sellerId, sellerName, isMainlandChina, classifiedBy, companyInfo, classifiedAt, lastSeenAt, lastSeenUrl FROM ozon_store_classification WHERE _id NOT GLOB '[0-9]*'`)
    .all();
  if (dirtyRows.length === 0) return;

  let deleted = 0;
  let migrated = 0;
  for (const d of dirtyRows) {
    const slug = d.sellerSlug || '';
    // 查同一 slug 是否已有数字 ID 的正确记录
    const correct = slug
      ? db
          .prepare(`SELECT _id FROM ozon_store_classification WHERE sellerSlug = ? AND _id GLOB '[0-9]*'`)
          .get(slug)
      : null;
    if (correct) {
      // 已有正确记录,直接删除脏记录
      db.prepare(`DELETE FROM ozon_store_classification WHERE _id = ?`).run(d._id);
      deleted++;
    } else {
      // 无正确记录,迁移到 legacy 表后删除
      db.prepare(
        `INSERT OR REPLACE INTO ozon_store_classification_legacy (_id, sellerSlug, sellerId, sellerName, isMainlandChina, classifiedBy, companyInfo, classifiedAt, lastSeenAt, lastSeenUrl, migratedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        d._id, slug, d.sellerId || '', d.sellerName || '', d.isMainlandChina, d.classifiedBy || '',
        d.companyInfo || null, d.classifiedAt, d.lastSeenAt, d.lastSeenUrl || '', new Date().toISOString()
      );
      db.prepare(`DELETE FROM ozon_store_classification WHERE _id = ?`).run(d._id);
      migrated++;
    }
  }
  console.log(`[db] migration: cleanupStoreClassificationDirtyRows 删除 ${deleted} 条,迁移到 legacy ${migrated} 条`);
}

// 2026-07: sellerSlug → sellerId 主键迁移
// 三件事:
//  1) ozon_cache_index 补 seller_id 列 + 索引,从 ozon_store_sku 反查回填
//  2) ozon_auto_collect_log 补 sellerId 列 + 索引,从 ozon_store_sku 反查回填
//  3) ozon_store_classification 重建表(_id = sellerId),旧表数据迁移到 legacy 表
// 幂等:已迁移过的库(新表结构)直接跳过。
async function migrateSellerIdPrimaryKey(db) {
  // ── Step 1: ozon_cache_index 补 seller_id 列 + 索引 ──
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'seller_id')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN seller_id TEXT`);
    console.log('[db] migration: added column ozon_cache_index.seller_id');
    // 从 ozon_store_sku 反查回填(优先 sellerId 非空的记录)
    // 多条 store_sku 记录同一 sku 时取最近一条(lastSeenAt DESC)
    db.exec(`
      UPDATE ozon_cache_index
      SET seller_id = (
        SELECT s.sellerId FROM ozon_store_sku s
        WHERE s._id = ozon_cache_index.sku
          AND s.sellerId IS NOT NULL AND s.sellerId != ''
        ORDER BY s.lastSeenAt DESC LIMIT 1
      )
      WHERE seller_id IS NULL
    `);
    const filled = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index WHERE seller_id IS NOT NULL AND seller_id != ''`)
      .get().n;
    console.log(`[db] migration: backfilled ozon_cache_index.seller_id for ${filled} rows`);
  }
  // 索引(schema.sql 已声明,IF NOT EXISTS 幂等)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ci_seller_id ON ozon_cache_index(seller_id)`);

  // ── Step 2: ozon_auto_collect_log 补 sellerId 列 + 索引 ──
  const logCols = db.prepare(`PRAGMA table_info(ozon_auto_collect_log)`).all();
  if (logCols.length > 0 && !logCols.some((c) => c.name === 'sellerId')) {
    db.exec(`ALTER TABLE ozon_auto_collect_log ADD COLUMN sellerId TEXT`);
    console.log('[db] migration: added column ozon_auto_collect_log.sellerId');
    // 从 ozon_store_sku 反查回填(按 sellerSlug 关联)
    // 一条 log 的 sellerSlug 可能对应多条 store_sku,取最近一条的 sellerId
    db.exec(`
      UPDATE ozon_auto_collect_log
      SET sellerId = (
        SELECT s.sellerId FROM ozon_store_sku s
        WHERE s.sellerSlug = ozon_auto_collect_log.sellerSlug
          AND s.sellerId IS NOT NULL AND s.sellerId != ''
        ORDER BY s.lastSeenAt DESC LIMIT 1
      )
      WHERE sellerId IS NULL
        AND sellerSlug IS NOT NULL AND sellerSlug != ''
    `);
    const filled = db
      .prepare(`SELECT COUNT(*) AS n FROM ozon_auto_collect_log WHERE sellerId IS NOT NULL AND sellerId != ''`)
      .get().n;
    console.log(`[db] migration: backfilled ozon_auto_collect_log.sellerId for ${filled} rows`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_log_sellerId_time ON ozon_auto_collect_log(sellerId, collectedAt DESC)`
  );

  // ── Step 3: ozon_store_classification 重建表(_id = sellerId) ──
  // 检测旧表结构:_id = sellerSlug(旧)vs _id = sellerId(新)
  // 旧表 sellerSlug NOT NULL + sellerId 可空;新表 sellerId NOT NULL + sellerSlug 可空
  const scCols = db.prepare(`PRAGMA table_info(ozon_store_classification)`).all();
  if (scCols.length > 0) {
    const sellerIdCol = scCols.find((c) => c.name === 'sellerId');
    const isOldSchema = sellerIdCol && (sellerIdCol.notnull === 0 || sellerIdCol.dflt_value === null);
    // 旧表特征:sellerId 可为空(NOT NULL = 0);新表特征:sellerId NOT NULL
    if (isOldSchema && sellerIdCol.notnull === 0) {
      console.log('[db] migration: rebuilding ozon_store_classification (_id = sellerId)');

      // 确保新表 + legacy 表已创建(schema.sql 已声明,但旧库可能没有)
      db.exec(`
        CREATE TABLE IF NOT EXISTS ozon_store_classification_new (
          _id           TEXT PRIMARY KEY,
          sellerId      TEXT NOT NULL,
          sellerSlug    TEXT,
          sellerName    TEXT,
          isMainlandChina     INTEGER,
          classifiedBy  TEXT,
          classifiedAt  TEXT,
          companyInfo   TEXT,
          lastSeenAt    TEXT,
          lastSeenUrl   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sc_new_mainland_china ON ozon_store_classification_new(isMainlandChina);
        CREATE INDEX IF NOT EXISTS idx_sc_new_name    ON ozon_store_classification_new(sellerName);
        CREATE INDEX IF NOT EXISTS idx_sc_new_seen    ON ozon_store_classification_new(lastSeenAt DESC);
        CREATE INDEX IF NOT EXISTS idx_sc_new_slug    ON ozon_store_classification_new(sellerSlug);

        CREATE TABLE IF NOT EXISTS ozon_store_classification_legacy (
          _id           TEXT PRIMARY KEY,
          sellerSlug    TEXT NOT NULL,
          sellerId      TEXT,
          sellerName    TEXT,
          isMainlandChina     INTEGER,
          classifiedBy  TEXT,
          classifiedAt  TEXT,
          companyInfo   TEXT,
          lastSeenAt    TEXT,
          lastSeenUrl   TEXT,
          migratedAt    TEXT NOT NULL
        );
      `);

      // 1) sellerId 非空的记录迁移到新表(_id = sellerId)
      const migrated = db
        .prepare(
          `INSERT OR REPLACE INTO ozon_store_classification_new
           (_id, sellerId, sellerSlug, sellerName, isMainlandChina, classifiedBy, classifiedAt,
            companyInfo, lastSeenAt, lastSeenUrl)
           SELECT sellerId, sellerId, sellerSlug, sellerName, isMainlandChina, classifiedBy, classifiedAt,
                  companyInfo, lastSeenAt, lastSeenUrl
           FROM ozon_store_classification
           WHERE sellerId IS NOT NULL AND sellerId != ''`
        )
        .run();
      console.log(
        `[db] migration: migrated ${migrated.changes} rows to ozon_store_classification_new (_id = sellerId)`
      );

      // 2) sellerId 为空的记录迁移到 legacy 表
      const legacyCount = db
        .prepare(
          `INSERT OR REPLACE INTO ozon_store_classification_legacy
           (_id, sellerSlug, sellerId, sellerName, isMainlandChina, classifiedBy, classifiedAt,
            companyInfo, lastSeenAt, lastSeenUrl, migratedAt)
           SELECT _id, sellerSlug, sellerId, sellerName, isMainlandChina, classifiedBy, classifiedAt,
                  companyInfo, lastSeenAt, lastSeenUrl, datetime('now')
           FROM ozon_store_classification
           WHERE sellerId IS NULL OR sellerId = ''`
        )
        .run();
      console.log(
        `[db] migration: moved ${legacyCount.changes} rows to ozon_store_classification_legacy (sellerId 为空)`
      );

      // 3) 替换旧表
      db.exec(`
        DROP TABLE ozon_store_classification;
        ALTER TABLE ozon_store_classification_new RENAME TO ozon_store_classification;
      `);
      // 索引名规范化(去掉 _new 后缀)
      db.exec(`
        DROP INDEX IF EXISTS idx_sc_new_mainland_chinese;
        DROP INDEX IF EXISTS idx_sc_new_chinese;
        DROP INDEX IF EXISTS idx_sc_new_name;
        DROP INDEX IF EXISTS idx_sc_new_seen;
        DROP INDEX IF EXISTS idx_sc_new_slug;
        CREATE INDEX IF NOT EXISTS idx_sc_mainland_china ON ozon_store_classification(isMainlandChina);
        CREATE INDEX IF NOT EXISTS idx_sc_name    ON ozon_store_classification(sellerName);
        CREATE INDEX IF NOT EXISTS idx_sc_seen    ON ozon_store_classification(lastSeenAt DESC);
        CREATE INDEX IF NOT EXISTS idx_sc_slug    ON ozon_store_classification(sellerSlug);
      `);
      console.log('[db] migration: ozon_store_classification rebuild complete');
    }
  }

  // ── Step 4: 浅度采集日志补 sellerId 索引(字段已在 schema.sql 中,索引补建) ──
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_shallow_log_sellerId_time ON ozon_shallow_collect_log(sellerId, collectedAt DESC)`
  );
}

// 2026-07: 跟卖状态即时标记 — 给 ozon_cache_index 补 listed_store_id/listed_at/listed_task_id 列
// 并从 follow_sell_task_items + follow_sell_tasks 一次性回填(取最近一条任务)
// 迁移后 listed 字段不再由 index-sync 定时任务刷新,改由 upsertTaskItems 即时写入
// 幂等:已迁移过的库(新表结构)直接跳过 ALTER,回填用 COALESCE 保留已有值
async function migrateListedFields(db) {
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)

  let addedListedStoreId = false;
  if (!ciCols.some((c) => c.name === 'listed_store_id')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN listed_store_id TEXT`);
    console.log('[db] migration: added column ozon_cache_index.listed_store_id');
    addedListedStoreId = true;
  }
  if (!ciCols.some((c) => c.name === 'listed_at')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN listed_at TEXT`);
    console.log('[db] migration: added column ozon_cache_index.listed_at');
  }
  if (!ciCols.some((c) => c.name === 'listed_task_id')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN listed_task_id TEXT`);
    console.log('[db] migration: added column ozon_cache_index.listed_task_id');
  }

  // 仅在首次新增 listed_store_id 列时执行回填(其他列一同被回填)
  // 后续启动时 listed 字段由 upsertTaskItems 维护,不再批量回填
  if (!addedListedStoreId) return;

  // 子查询:对每个 SKU 取最近一条 task_items 关联的 task(按 i.id DESC)
  // offer_id 格式:sku-variantId,用 SUBSTR(offer_id, 1, INSTR(offer_id, '-') - 1) 提取 SKU 前缀
  const result = db
    .prepare(
      `UPDATE ozon_cache_index
       SET listed = 1,
           listed_store_id = COALESCE(
             (SELECT t.store_id
              FROM follow_sell_task_items i
              JOIN follow_sell_tasks t ON t.local_task_id = i.local_task_id
              WHERE SUBSTR(i.offer_id, 1, INSTR(i.offer_id, '-') - 1) = ozon_cache_index.sku
                AND i.offer_id LIKE '%-%'
                AND t.store_id IS NOT NULL AND t.store_id != ''
              ORDER BY i.id DESC LIMIT 1),
             listed_store_id),
           listed_at = COALESCE(
             (SELECT t.created_at
              FROM follow_sell_task_items i
              JOIN follow_sell_tasks t ON t.local_task_id = i.local_task_id
              WHERE SUBSTR(i.offer_id, 1, INSTR(i.offer_id, '-') - 1) = ozon_cache_index.sku
                AND i.offer_id LIKE '%-%'
              ORDER BY i.id DESC LIMIT 1),
             listed_at),
           listed_task_id = COALESCE(
             (SELECT i.local_task_id
              FROM follow_sell_task_items i
              WHERE SUBSTR(i.offer_id, 1, INSTR(i.offer_id, '-') - 1) = ozon_cache_index.sku
                AND i.offer_id LIKE '%-%'
              ORDER BY i.id DESC LIMIT 1),
             listed_task_id)
       WHERE listed = 0
         AND sku IN (
           SELECT DISTINCT SUBSTR(offer_id, 1, INSTR(offer_id, '-') - 1)
           FROM follow_sell_task_items
           WHERE offer_id LIKE '%-%'
         )`
    )
    .run();
  console.log(
    `[db] migration: backfill listed fields for ${result.changes} SKUs`
  );
}

// 2026-08: 超轻小件筛选 — ozon_cache_index 补 weight_g / dim_sum_mm 列 + 从 bundle_data 回填
// 两件事:
//  1) 补 weight_g(克)/ dim_sum_mm(三边之和,毫米)两列(旧库 ALTER TABLE)
//  2) 从 ozon_attribute_cache.bundle_data(JSON 顶层物理字段)回填到索引表
// 幂等:已迁移过的库(新表结构)直接跳过 ALTER,回填仅首次执行
async function migrateUltraLightFields(db) {
  const ciCols = db.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)

  let addedWeightG = false;
  if (!ciCols.some((c) => c.name === 'weight_g')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN weight_g REAL`);
    console.log('[db] migration: added column ozon_cache_index.weight_g');
    addedWeightG = true;
  }
  if (!ciCols.some((c) => c.name === 'dim_sum_mm')) {
    db.exec(`ALTER TABLE ozon_cache_index ADD COLUMN dim_sum_mm REAL`);
    console.log('[db] migration: added column ozon_cache_index.dim_sum_mm');
  }

  // 仅在首次新增列时执行回填,后续启动由 syncSku 维护
  if (!addedWeightG) return;

  // 从 bundle_data 顶层物理字段提取(OPI bundle 接口单位:g / mm)
  //   weight_g = bundle_data.weight(>0 才有效)
  //   dim_sum_mm = bundle_data.depth + width + height(三者均 >0 才有效)
  const result = db
    .prepare(
      `UPDATE ozon_cache_index
       SET weight_g = (
             SELECT CASE
                      WHEN json_extract(a.bundle_data, '$.weight') IS NOT NULL
                        AND CAST(json_extract(a.bundle_data, '$.weight') AS REAL) > 0
                      THEN CAST(json_extract(a.bundle_data, '$.weight') AS REAL)
                      ELSE NULL END
             FROM ozon_attribute_cache a
             WHERE a._id = ozon_cache_index.sku AND a.bundle_data IS NOT NULL
           ),
           dim_sum_mm = (
             SELECT CASE
                      WHEN json_extract(a.bundle_data, '$.depth') IS NOT NULL
                        AND json_extract(a.bundle_data, '$.width') IS NOT NULL
                        AND json_extract(a.bundle_data, '$.height') IS NOT NULL
                        AND CAST(json_extract(a.bundle_data, '$.depth') AS REAL) > 0
                        AND CAST(json_extract(a.bundle_data, '$.width') AS REAL) > 0
                        AND CAST(json_extract(a.bundle_data, '$.height') AS REAL) > 0
                      THEN CAST(json_extract(a.bundle_data, '$.depth') AS REAL)
                         + CAST(json_extract(a.bundle_data, '$.width') AS REAL)
                         + CAST(json_extract(a.bundle_data, '$.height') AS REAL)
                      ELSE NULL END
             FROM ozon_attribute_cache a
             WHERE a._id = ozon_cache_index.sku AND a.bundle_data IS NOT NULL
           )
       WHERE EXISTS (
         SELECT 1 FROM ozon_attribute_cache a
         WHERE a._id = ozon_cache_index.sku AND a.bundle_data IS NOT NULL
       )`
    )
    .run();
  console.log(
    `[db] migration: backfilled weight_g / dim_sum_mm for ${result.changes} SKUs`
  );
}

// 2026-08: 深度采集日志补 reason 列(跳过原因,仅 status='skipped' 时有值)
// 新库由 schema.sql CREATE TABLE IF NOT EXISTS 直接建好,此函数幂等跳过
function migrateAutoCollectLogReason(db) {
  const logCols = db.prepare(`PRAGMA table_info(ozon_auto_collect_log)`).all();
  if (logCols.length > 0 && !logCols.some((c) => c.name === 'reason')) {
    db.exec(`ALTER TABLE ozon_auto_collect_log ADD COLUMN reason TEXT`);
    console.log('[db] migration: added column ozon_auto_collect_log.reason');
  }
}

// P2-2: 批量均衡上架 — batch_upload_tasks / batch_upload_items 补列
// 旧库(P2-1 阶段建的表)缺 P2-2 新增列,需 ALTER TABLE 补列 + 建索引
// 新库由 schema.sql CREATE TABLE IF NOT EXISTS 直接建好,此函数幂等跳过
function migrateBatchUploadTables(db) {
  // ── batch_upload_tasks 补列 ──
  const butCols = db.prepare(`PRAGMA table_info(batch_upload_tasks)`).all();
  if (butCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)
  if (!butCols.some((c) => c.name === 'batch_no')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN batch_no TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.batch_no');
  }
  if (!butCols.some((c) => c.name === 'name')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN name TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.name');
  }
  if (!butCols.some((c) => c.name === 'store_ids')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN store_ids TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.store_ids');
  }
  if (!butCols.some((c) => c.name === 'skipped_count')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN skipped_count INTEGER DEFAULT 0`);
    console.log('[db] migration: added column batch_upload_tasks.skipped_count');
  }
  if (!butCols.some((c) => c.name === 'speed_config')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN speed_config TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.speed_config');
  }
  if (!butCols.some((c) => c.name === 'started_at')) {
    db.exec(`ALTER TABLE batch_upload_tasks ADD COLUMN started_at TEXT`);
    console.log('[db] migration: added column batch_upload_tasks.started_at');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_but_status ON batch_upload_tasks(status, created_at DESC)`);

  // ── batch_upload_items 补列 ──
  const buiCols = db.prepare(`PRAGMA table_info(batch_upload_items)`).all();
  if (buiCols.length === 0) return;
  if (!buiCols.some((c) => c.name === 'seq')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN seq INTEGER DEFAULT 0`);
    console.log('[db] migration: added column batch_upload_items.seq');
  }
  if (!buiCols.some((c) => c.name === 'seller_id')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN seller_id TEXT`);
    console.log('[db] migration: added column batch_upload_items.seller_id');
  }
  if (!buiCols.some((c) => c.name === 'target_store_id')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN target_store_id TEXT`);
    console.log('[db] migration: added column batch_upload_items.target_store_id');
  }
  if (!buiCols.some((c) => c.name === 'skip_reason')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN skip_reason TEXT`);
    console.log('[db] migration: added column batch_upload_items.skip_reason');
  }
  if (!buiCols.some((c) => c.name === 'started_at')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN started_at TEXT`);
    console.log('[db] migration: added column batch_upload_items.started_at');
  }
  if (!buiCols.some((c) => c.name === 'finished_at')) {
    db.exec(`ALTER TABLE batch_upload_items ADD COLUMN finished_at TEXT`);
    console.log('[db] migration: added column batch_upload_items.finished_at');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bui_batch_seq ON batch_upload_items(batch_task_id, seq)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bui_status ON batch_upload_items(status)`);
}

// 直接运行时初始化(node src/db/index.js)
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('db/index.js');
if (isMain) {
  initSchema()
    .then(() => {
      console.log('[db] schema initialized at', DB_PATH);
      db.close();
      process.exit(0);
    })
    .catch((e) => {
      console.error('[db] schema init failed:', e);
      process.exit(1);
    });
}
