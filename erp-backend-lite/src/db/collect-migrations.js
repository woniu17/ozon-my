// 采集库迁移(2026-10-13 从主库 src/db/index.js 拆分)
// 所有采集域表(ozon_cache_* / collect_queue_* / ozon_store_* / 采集日志 / 过滤类目)
// 的迁移逻辑集中在此,统一操作 collectDb(第二个 SQLite 连接,data/collect.db)。
// 主库业务表迁移仍留在 src/db/index.js。
//
// 说明:ensureCollectMigrations(mainDb, collectDb) 由 src/db/index.js 的
// initSchema() 调用,mainDb 仅 migrateListedFields 跨库回填使用(读 follow_sell_*)。

// ── 一次性回填 ozon_cache_index.has_rich_content ──
// 逻辑与 index-dao.js syncSku 一致:richMedia.data.richContent 非空(字符串长度>0) → 1
function backfillHasRichContent(collectDb) {
  const result = collectDb
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
    `[collect-db] migration: backfilled has_rich_content for ${result.changes} SKUs (rich_media_hit=1)`
  );
}

// 一次性回填 ozon_cache_index.description_quality
// 与 index-dao.js syncSku 的 descriptionQuality 计算同口径:
//   0=空 1=占位(Не удалось загрузить…/纯按钮文案) 2=按钮污染(真描述末尾粘Читать далее) 3=正常
// 注:SQL 内用 LIKE 近似实现 classify,边界情况由 scripts/backfill-description-quality.mjs (JS 正则精准版)修正
function backfillDescriptionQuality(collectDb) {
  // 用 UPDATE-FROM 语法(SQLite 3.33+),从 ozon_rich_media_cache.data.description 提取并 classify
  const result = collectDb
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
    `[collect-db] migration: backfilled description_quality for ${result.changes} SKUs (rich_media_hit=1)`
  );
}

// 一次性回填 ozon_cache_index.market_stats_empty
// 逻辑与 index-dao.js syncSku 一致:marketStats.data.__empty === true → 1
// 用 json_extract 精准匹配布尔 true,避免 LIKE 误伤(LIKE '%__empty%' 可能匹配到子串)
function backfillMarketStatsEmpty(collectDb) {
  const result = collectDb
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
    `[collect-db] migration: backfilled market_stats_empty for ${result.changes} SKUs (market_stats_hit=1)`
  );
}

// 索引表补 price_value 列 + FTS5 虚拟表 + 触发器(旧采集库升级用,新库由 collect-schema.sql 直接建好)
function ensureCacheIndexFtsAndPriceValue(collectDb) {
  const ciCols = collectDb.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)
  if (!ciCols.some((c) => c.name === 'price_value')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN price_value REAL`);
    console.log('[collect-db] migration: added column ozon_cache_index.price_value');
    collectDb.exec(`
      UPDATE ozon_cache_index
      SET price_value = CAST(
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
          price, ' ', ''), ',', ''), '₽', ''), '€', ''), '$', ''), '￥', ''
        ) AS REAL
      )
      WHERE price IS NOT NULL AND price <> ''
    `);
    console.log('[collect-db] migration: backfilled price_value from price');
  }
  collectDb.exec(`CREATE INDEX IF NOT EXISTS idx_ci_price_value ON ozon_cache_index(price_value)`);
  collectDb.exec(`DROP INDEX IF EXISTS idx_ci_fts`);
  collectDb.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ozon_cache_index_fts USING fts5(
      sku, name, seller_name,
      content='ozon_cache_index', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
  collectDb.exec(`
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
  const ftsCount = collectDb.prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index_fts`).get().n;
  const ciCount = collectDb.prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index`).get().n;
  if (ciCount > 0 && ftsCount === 0) {
    collectDb.exec(`
      INSERT INTO ozon_cache_index_fts(rowid, sku, name, seller_name)
      SELECT rowid, sku, name, seller_name FROM ozon_cache_index
    `);
    console.log(`[collect-db] migration: rebuilt FTS5 index with ${ciCount} rows`);
  }
}

// 清理旧缓存表(card/detail/search/bundle/composer/entrypoint 已合并为 dom/attribute)
function dropLegacyCacheTables(collectDb) {
  const legacyTables = [
    'ozon_card_cache',
    'ozon_detail_cache',
    'ozon_search_cache',
    'ozon_bundle_cache',
    'ozon_composer_cache',
    'ozon_entrypoint_cache',
  ];
  for (const name of legacyTables) {
    const exists = collectDb
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name);
    if (exists) {
      collectDb.exec(`DROP TABLE IF EXISTS ${name}`);
      console.log(`[collect-db] migration: dropped legacy table ${name} (已合并到 dom/attribute)`);
    }
  }
}

// 清理 ozon_store_classification 中 _id 非数字的脏记录
// 根因:SW _erpStoreClassSet 曾在 sellerId 为空时 fallback 用 slug 作为 _id 写入主表
// 清理策略:
//   - _id 非数字 + 同一 slug 已有数字 ID 记录 → 直接删除脏记录
//   - _id 非数字 + 同一 slug 无数字 ID 记录 → 迁移到 legacy 表后删除
async function cleanupStoreClassificationDirtyRows(collectDb) {
  const tableExists = collectDb
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ozon_store_classification'`)
    .get();
  if (!tableExists) return;

  const dirtyRows = collectDb
    .prepare(`SELECT _id, sellerSlug, sellerId, sellerName, isMainlandChina, classifiedBy, companyInfo, classifiedAt, lastSeenAt, lastSeenUrl FROM ozon_store_classification WHERE _id NOT GLOB '[0-9]*'`)
    .all();
  if (dirtyRows.length === 0) return;

  let deleted = 0;
  let migrated = 0;
  for (const d of dirtyRows) {
    const slug = d.sellerSlug || '';
    const correct = slug
      ? collectDb
          .prepare(`SELECT _id FROM ozon_store_classification WHERE sellerSlug = ? AND _id GLOB '[0-9]*'`)
          .get(slug)
      : null;
    if (correct) {
      collectDb.prepare(`DELETE FROM ozon_store_classification WHERE _id = ?`).run(d._id);
      deleted++;
    } else {
      collectDb.prepare(
        `INSERT OR REPLACE INTO ozon_store_classification_legacy (_id, sellerSlug, sellerId, sellerName, isMainlandChina, classifiedBy, companyInfo, classifiedAt, lastSeenAt, lastSeenUrl, migratedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        d._id, slug, d.sellerId || '', d.sellerName || '', d.isMainlandChina, d.classifiedBy || '',
        d.companyInfo || null, d.classifiedAt, d.lastSeenAt, d.lastSeenUrl || '', new Date().toISOString()
      );
      collectDb.prepare(`DELETE FROM ozon_store_classification WHERE _id = ?`).run(d._id);
      migrated++;
    }
  }
  console.log(`[collect-db] migration: cleanupStoreClassificationDirtyRows 删除 ${deleted} 条,迁移到 legacy ${migrated} 条`);
}

// sellerSlug → sellerId 主键迁移(2026-07)
//  1) ozon_cache_index 补 seller_id 列 + 索引,从 ozon_store_sku 反查回填
//  2) ozon_auto_collect_log 补 sellerId 列 + 索引,从 ozon_store_sku 反查回填
//  3) ozon_store_classification 重建表(_id = sellerId),旧表数据迁移到 legacy 表
async function migrateSellerIdPrimaryKey(collectDb) {
  // ── Step 1: ozon_cache_index 补 seller_id 列 + 索引 ──
  const ciCols = collectDb.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'seller_id')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN seller_id TEXT`);
    console.log('[collect-db] migration: added column ozon_cache_index.seller_id');
    collectDb.exec(`
      UPDATE ozon_cache_index
      SET seller_id = (
        SELECT s.sellerId FROM ozon_store_sku s
        WHERE s._id = ozon_cache_index.sku
          AND s.sellerId IS NOT NULL AND s.sellerId != ''
        ORDER BY s.lastSeenAt DESC LIMIT 1
      )
      WHERE seller_id IS NULL
    `);
    const filled = collectDb
      .prepare(`SELECT COUNT(*) AS n FROM ozon_cache_index WHERE seller_id IS NOT NULL AND seller_id != ''`)
      .get().n;
    console.log(`[collect-db] migration: backfilled ozon_cache_index.seller_id for ${filled} rows`);
  }
  collectDb.exec(`CREATE INDEX IF NOT EXISTS idx_ci_seller_id ON ozon_cache_index(seller_id)`);

  // ── Step 2: ozon_auto_collect_log 补 sellerId 列 + 索引 ──
  const logCols = collectDb.prepare(`PRAGMA table_info(ozon_auto_collect_log)`).all();
  if (logCols.length > 0 && !logCols.some((c) => c.name === 'sellerId')) {
    collectDb.exec(`ALTER TABLE ozon_auto_collect_log ADD COLUMN sellerId TEXT`);
    console.log('[collect-db] migration: added column ozon_auto_collect_log.sellerId');
    collectDb.exec(`
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
    const filled = collectDb
      .prepare(`SELECT COUNT(*) AS n FROM ozon_auto_collect_log WHERE sellerId IS NOT NULL AND sellerId != ''`)
      .get().n;
    console.log(`[collect-db] migration: backfilled ozon_auto_collect_log.sellerId for ${filled} rows`);
  }
  collectDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_log_sellerId_time ON ozon_auto_collect_log(sellerId, collectedAt DESC)`
  );

  // ── Step 3: ozon_store_classification 重建表(_id = sellerId) ──
  const scCols = collectDb.prepare(`PRAGMA table_info(ozon_store_classification)`).all();
  if (scCols.length > 0) {
    const sellerIdCol = scCols.find((c) => c.name === 'sellerId');
    const isOldSchema = sellerIdCol && (sellerIdCol.notnull === 0 || sellerIdCol.dflt_value === null);
    if (isOldSchema && sellerIdCol.notnull === 0) {
      console.log('[collect-db] migration: rebuilding ozon_store_classification (_id = sellerId)');
      collectDb.exec(`
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
      const migrated = collectDb
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
        `[collect-db] migration: migrated ${migrated.changes} rows to ozon_store_classification_new (_id = sellerId)`
      );
      const legacyCount = collectDb
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
        `[collect-db] migration: moved ${legacyCount.changes} rows to ozon_store_classification_legacy (sellerId 为空)`
      );
      collectDb.exec(`
        DROP TABLE ozon_store_classification;
        ALTER TABLE ozon_store_classification_new RENAME TO ozon_store_classification;
      `);
      collectDb.exec(`
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
      console.log('[collect-db] migration: ozon_store_classification rebuild complete');
    }
  }

  // ── Step 4: 浅度采集日志补 sellerId 索引(字段已在 schema.sql 中,索引补建) ──
  collectDb.exec(
    `CREATE INDEX IF NOT EXISTS idx_shallow_log_sellerId_time ON ozon_shallow_collect_log(sellerId, collectedAt DESC)`
  );
}

// 跟卖状态即时标记 — 给 ozon_cache_index 补 listed_store_id/listed_at/listed_task_id 列
// 并从 follow_sell_task_items + follow_sell_tasks(主库)一次性回填(取最近一条任务)
// 迁移后 listed 字段不再由 index-sync 定时任务刷新,改由 upsertTaskItems 即时写入
// 幂等:已迁移过的库(新表结构)直接跳过 ALTER,回填用 COALESCE 保留已有值
async function migrateListedFields(mainDb, collectDb) {
  const ciCols = collectDb.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)

  let addedListedStoreId = false;
  if (!ciCols.some((c) => c.name === 'listed_store_id')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN listed_store_id TEXT`);
    console.log('[collect-db] migration: added column ozon_cache_index.listed_store_id');
    addedListedStoreId = true;
  }
  if (!ciCols.some((c) => c.name === 'listed_at')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN listed_at TEXT`);
    console.log('[collect-db] migration: added column ozon_cache_index.listed_at');
  }
  if (!ciCols.some((c) => c.name === 'listed_task_id')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN listed_task_id TEXT`);
    console.log('[collect-db] migration: added column ozon_cache_index.listed_task_id');
  }

  // 仅在首次新增 listed_store_id 列时执行回填(其他列一同被回填)
  if (!addedListedStoreId) return;

  const result = collectDb
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
    `[collect-db] migration: backfill listed fields for ${result.changes} SKUs (from mainDb follow_sell_*)`
  );
}

// 超轻小件筛选 — ozon_cache_index 补 weight_g / dim_sum_mm 列 + 从 bundle_data 回填
// 幂等:已迁移过的库(新表结构)直接跳过 ALTER,回填仅首次执行
async function migrateUltraLightFields(collectDb) {
  const ciCols = collectDb.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)

  let addedWeightG = false;
  if (!ciCols.some((c) => c.name === 'weight_g')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN weight_g REAL`);
    console.log('[collect-db] migration: added column ozon_cache_index.weight_g');
    addedWeightG = true;
  }
  if (!ciCols.some((c) => c.name === 'dim_sum_mm')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN dim_sum_mm REAL`);
    console.log('[collect-db] migration: added column ozon_cache_index.dim_sum_mm');
  }

  // 仅在首次新增列时执行回填,后续启动由 syncSku 维护
  if (!addedWeightG) return;

  const result = collectDb
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
    `[collect-db] migration: backfilled weight_g / dim_sum_mm for ${result.changes} SKUs`
  );
}

// 采集箱同款分组 — ozon_cache_index 补 group_id / group_rep 列 + 索引(2026-10)
// 字段由 scripts/rebuild-sku-groups.mjs / sku-group-sync 定时任务重建填充:
//   group_id = 组代表 SKU(未分组为 NULL), group_rep = 1 表示该行是组代表
// 采集箱列表查询通过 (group_id IS NULL OR group_rep = 1) 只显示每组一个 SKU
function migrateSkuGroupFields(collectDb) {
  const ciCols = collectDb.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)
  if (!ciCols.some((c) => c.name === 'group_id')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN group_id TEXT`);
    console.log('[collect-db] migration: added column ozon_cache_index.group_id');
  }
  if (!ciCols.some((c) => c.name === 'group_rep')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN group_rep INTEGER DEFAULT 0`);
    console.log('[collect-db] migration: added column ozon_cache_index.group_rep');
  }
  collectDb.exec(`CREATE INDEX IF NOT EXISTS idx_ci_group_id ON ozon_cache_index(group_id)`);
  collectDb.exec(`CREATE INDEX IF NOT EXISTS idx_ci_group_rep ON ozon_cache_index(group_rep)`);
}

// 采集箱导出 — ozon_cache_index 补 exported / exported_at / export_task_id 列 + 索引
function migrateExportFields(collectDb) {
  const ciCols = collectDb.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  if (ciCols.length === 0) return; // 表不存在,跳过(schema.sql 会创建)
  if (!ciCols.some((c) => c.name === 'exported')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN exported INTEGER DEFAULT 0`);
    console.log('[collect-db] migration: added column ozon_cache_index.exported');
  }
  if (!ciCols.some((c) => c.name === 'exported_at')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN exported_at TEXT`);
    console.log('[collect-db] migration: added column ozon_cache_index.exported_at');
  }
  if (!ciCols.some((c) => c.name === 'export_task_id')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN export_task_id TEXT`);
    console.log('[collect-db] migration: added column ozon_cache_index.export_task_id');
  }
  collectDb.exec(`CREATE INDEX IF NOT EXISTS idx_ci_exported ON ozon_cache_index(exported)`);
}

// 深度采集日志补 reason 列(跳过原因,仅 status='skipped' 时有值)
function migrateAutoCollectLogReason(collectDb) {
  const logCols = collectDb.prepare(`PRAGMA table_info(ozon_auto_collect_log)`).all();
  if (logCols.length > 0 && !logCols.some((c) => c.name === 'reason')) {
    collectDb.exec(`ALTER TABLE ozon_auto_collect_log ADD COLUMN reason TEXT`);
    console.log('[collect-db] migration: added column ozon_auto_collect_log.reason');
  }
}

// 采集队列任务表补列:duration(耗时上报) + forceRefresh(1=强制重新采集)
function migrateCollectQueueTaskColumns(collectDb) {
  const taskCols = collectDb.prepare(`PRAGMA table_info(collect_queue_tasks)`).all();
  if (taskCols.length === 0) return; // 表不存在,跳过(collect-schema.sql 会创建)
  if (!taskCols.some((c) => c.name === 'duration')) {
    collectDb.exec(`ALTER TABLE collect_queue_tasks ADD COLUMN duration INTEGER`);
    console.log('[collect-db] migration: added column collect_queue_tasks.duration');
  }
  if (!taskCols.some((c) => c.name === 'forceRefresh')) {
    collectDb.exec(`ALTER TABLE collect_queue_tasks ADD COLUMN forceRefresh INTEGER DEFAULT 0`);
    console.log('[collect-db] migration: added column collect_queue_tasks.forceRefresh');
  }
}

// 采集库迁移总入口(mainDb 仅 migrateListedFields 跨库回填使用)
export async function ensureCollectMigrations(mainDb, collectDb) {
  // ── sellerSlug → sellerId 主键迁移 + 脏记录清理 ──
  await migrateSellerIdPrimaryKey(collectDb);
  await cleanupStoreClassificationDirtyRows(collectDb);
  // ── 跟卖状态即时标记(跨库:读主库 follow_sell_* → 写采集库 ozon_cache_index) ──
  await migrateListedFields(mainDb, collectDb);
  // ── 超轻小件筛选 / 采集箱导出 / 同款分组 / 深度日志补列 / 队列任务补列 ──
  await migrateUltraLightFields(collectDb);
  migrateExportFields(collectDb);
  migrateSkuGroupFields(collectDb);
  migrateAutoCollectLogReason(collectDb);
  migrateCollectQueueTaskColumns(collectDb);

  // ── ozon_cache_index 冗余列(采集箱筛选) ──
  const ciCols = collectDb.prepare(`PRAGMA table_info(ozon_cache_index)`).all();
  let addedHasRichContent = false;
  let addedDescriptionQuality = false;
  let addedMarketStatsEmpty = false;
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'has_rich_content')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN has_rich_content INTEGER DEFAULT 0`);
    console.log('[collect-db] migration: added column ozon_cache_index.has_rich_content');
    addedHasRichContent = true;
  }
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'description_quality')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN description_quality INTEGER DEFAULT 0`);
    console.log('[collect-db] migration: added column ozon_cache_index.description_quality');
    addedDescriptionQuality = true;
  }
  if (ciCols.length > 0 && !ciCols.some((c) => c.name === 'market_stats_empty')) {
    collectDb.exec(`ALTER TABLE ozon_cache_index ADD COLUMN market_stats_empty INTEGER DEFAULT 0`);
    console.log('[collect-db] migration: added column ozon_cache_index.market_stats_empty');
    addedMarketStatsEmpty = true;
  }

  // 缓存表重构:直接 DROP 旧 7 表 + legacy 表,新版用 6 张表(1 索引 + 5 数据)
  dropLegacyCacheTables(collectDb);
  // 索引表新增 price_value 列 + FTS5 虚拟表 + 触发器
  ensureCacheIndexFtsAndPriceValue(collectDb);
  // 一次性回填
  if (addedHasRichContent) backfillHasRichContent(collectDb);
  if (addedDescriptionQuality) backfillDescriptionQuality(collectDb);
  if (addedMarketStatsEmpty) backfillMarketStatsEmpty(collectDb);

  // ── ozon_store_classification 店铺统计指标列 + 索引 ──
  const scCols = collectDb.prepare(`PRAGMA table_info(ozon_store_classification)`).all();
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'logoImageUrl')) {
    collectDb.exec(`ALTER TABLE ozon_store_classification ADD COLUMN logoImageUrl TEXT`);
    console.log('[collect-db] migration: added column ozon_store_classification.logoImageUrl');
  }
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'orders_count')) {
    collectDb.exec(`ALTER TABLE ozon_store_classification ADD COLUMN orders_count INTEGER`);
    console.log('[collect-db] migration: added column ozon_store_classification.orders_count');
  }
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'reviews_count')) {
    collectDb.exec(`ALTER TABLE ozon_store_classification ADD COLUMN reviews_count INTEGER`);
    console.log('[collect-db] migration: added column ozon_store_classification.reviews_count');
  }
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'rating')) {
    collectDb.exec(`ALTER TABLE ozon_store_classification ADD COLUMN rating REAL`);
    console.log('[collect-db] migration: added column ozon_store_classification.rating');
  }
  if (scCols.length > 0 && !scCols.some((c) => c.name === 'opened_months')) {
    collectDb.exec(`ALTER TABLE ozon_store_classification ADD COLUMN opened_months INTEGER`);
    console.log('[collect-db] migration: added column ozon_store_classification.opened_months');
  }
  collectDb.exec(`CREATE INDEX IF NOT EXISTS idx_sc_orders ON ozon_store_classification(orders_count DESC)`);
  collectDb.exec(`CREATE INDEX IF NOT EXISTS idx_sc_rating ON ozon_store_classification(rating DESC)`);
}