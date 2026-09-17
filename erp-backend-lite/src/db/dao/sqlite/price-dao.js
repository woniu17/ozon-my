// 价格管理 DAO(2026-09,商品维度定价基准)
// 表结构见 schema.sql op_product_price_cache / op_price_change_log;
// 设计文档: docs/价格管理-概要设计.md
// 关键语义:
//   - op_product_price_cache 以 sku 为唯一键(Ozon SKU 全局唯一,用户确认),手动同步全量覆盖
//   - 采购价/重量存 product_data_cache.custom_purchase_price / custom_weight_g(与商品列表共用)
//   - 利润/利润率/建议价不在库里计算,由 services/profit-estimator.js 统一(排序场景在 SQL 内联同款公式)
import { db } from '../../index.js';

function nowIso() {
  return new Date().toISOString();
}

// ── 价格缓存 ────────────────────────────────────────────────

// 批量 upsert(v5+v3 同步结果)
export function upsertPriceCacheRows(rows) {
  if (!rows || !rows.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO op_product_price_cache (
       sku, store_id, product_id, offer_id, price, old_price, min_price, currency_code,
       sales_percent_fbs, market_min_price_rub, price_index_color, name, image, raw_json, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sku) DO UPDATE SET
       store_id = excluded.store_id,
       product_id = excluded.product_id,
       offer_id = excluded.offer_id,
       price = excluded.price,
       old_price = excluded.old_price,
       min_price = excluded.min_price,
       currency_code = excluded.currency_code,
       sales_percent_fbs = excluded.sales_percent_fbs,
       market_min_price_rub = excluded.market_min_price_rub,
       price_index_color = excluded.price_index_color,
       name = CASE WHEN excluded.name IS NOT NULL THEN excluded.name ELSE op_product_price_cache.name END,
       image = CASE WHEN excluded.image IS NOT NULL THEN excluded.image ELSE op_product_price_cache.image END,
       raw_json = excluded.raw_json,
       synced_at = excluded.synced_at`
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        String(r.sku), r.storeId, r.productId ?? null, r.offerId ?? null,
        r.price ?? null, r.oldPrice ?? null, r.minPrice ?? null, r.currencyCode ?? 'CNY',
        r.salesPercentFbs ?? null, r.marketMinPriceRub ?? null, r.priceIndexColor ?? null,
        r.name ?? null, r.image ?? null, r.rawJson ?? null, r.syncedAt ?? nowIso()
      );
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return n;
}

export function getPriceCacheBySku(sku) {
  return db.prepare(`SELECT * FROM op_product_price_cache WHERE sku = ?`).get(String(sku)) || null;
}

// 本地 product_id → sku/name/image 映射(同步映射源,零 API 调用)
// product_data_cache.data 即 v3 商品对象:$.id = product_id,$.images[0] = 首图
// 实测六店铺 13071 商品 100% 有 $.id,可完全替代 v3 反查
export function getLocalProductIdMap(storeId) {
  return db
    .prepare(
      `SELECT CAST(json_extract(data, '$.id') AS INTEGER) AS pid, sku,
              json_extract(data, '$.name') AS name,
              json_extract(data, '$.images[0]') AS image
       FROM product_data_cache
       WHERE store_id = ? AND json_extract(data, '$.id') IS NOT NULL`
    )
    .all(storeId);
}

// SKU 自定义值(改价校验用):采购价 + 重量(custom_weight_g > attributes 兜底)
export function getSkuCustoms(sku) {
  return (
    db
      .prepare(
        `SELECT pdc.sku,
                pdc.custom_purchase_price AS custom_purchase_price,
                CAST(COALESCE(pdc.custom_weight_g, json_extract(pac.attributes_data, '$.weight')) AS REAL) AS weight_g
         FROM product_data_cache pdc
         LEFT JOIN product_attributes_cache pac ON pac.sku = pdc.sku
         WHERE pdc.sku = ?`
      )
      .get(String(sku)) || null
  );
}

// 缓存内店铺分布(页面店铺 tab)
export function priceCacheStores() {
  return db
    .prepare(
      `SELECT store_id AS storeId, COUNT(*) AS count, MAX(synced_at) AS lastSyncedAt
       FROM op_product_price_cache GROUP BY store_id ORDER BY count DESC`
    )
    .all();
}

// ── 商品列表(核心查询:价格缓存 × 商品自定义值 × 订单聚合) ──
// 利润公式与 services/profit-estimator.js 完全一致(佣金率/配送参数由调用方注入,单点维护)
export function listPriceProducts(params) {
  const {
    storeId, keyword, purchaseSet, weightSet,
    profitRateMin, profitRateMax,
    sort = 'profitRateCost', dir = 'asc',
    page = 1, pageSize = 20,
    commissionRate = 0.16, deliveryBase = 3.37, deliveryPerGram = 0.0281,
  } = params || {};

  // 权重表达式:custom_weight_g > attributes_cache.weight(与 getWeightsByPackageIds 同款优先级)
  const WEIGHT = `CAST(COALESCE(pdc.custom_weight_g, json_extract(pac.attributes_data, '$.weight')) AS REAL)`;
  // 单件利润(CNY):售价×(1-佣金率) − 配送(无重量按0,回退打包口径) − 采购价
  const PROFIT = `CASE WHEN c.price IS NOT NULL AND pdc.custom_purchase_price IS NOT NULL THEN
      ROUND(c.price * (1 - @cr) - CASE WHEN ${WEIGHT} IS NOT NULL THEN @db + @dg * ${WEIGHT} ELSE 0 END - pdc.custom_purchase_price, 2)
    END`;
  const RATE_COST = `CASE WHEN ${PROFIT} IS NOT NULL AND pdc.custom_purchase_price > 0 THEN
      ROUND(${PROFIT} / pdc.custom_purchase_price * 100, 2) END`;
  const RATE_SALE = `CASE WHEN ${PROFIT} IS NOT NULL AND c.price > 0 THEN
      ROUND(${PROFIT} / c.price * 100, 2) END`;

  const where = [];
  const args = { cr: commissionRate, db: deliveryBase, dg: deliveryPerGram };
  if (storeId) { where.push(`c.store_id = @storeId`); args.storeId = storeId; }
  if (keyword) {
    where.push(`(c.sku LIKE @kw OR c.name LIKE @kw OR c.offer_id LIKE @kw)`);
    args.kw = `%${keyword}%`;
  }
  if (purchaseSet === 'set') where.push(`pdc.custom_purchase_price IS NOT NULL`);
  if (purchaseSet === 'unset') where.push(`pdc.custom_purchase_price IS NULL`);
  if (weightSet === 'set') where.push(`${WEIGHT} IS NOT NULL`);
  if (weightSet === 'unset') where.push(`${WEIGHT} IS NULL`);
  if (profitRateMin != null && profitRateMin !== '') {
    where.push(`${RATE_COST} >= @rmin`); args.rmin = Number(profitRateMin);
  }
  if (profitRateMax != null && profitRateMax !== '') {
    where.push(`${RATE_COST} <= @rmax`); args.rmax = Number(profitRateMax);
  }

  // 排序白名单(表达式与上方一致);NULL 值排最后(asc/desc 均如此,避免缺数据行淹没列表)
  const SORTS = {
    profitRateCost: RATE_COST,
    profitRateSale: RATE_SALE,
    profit: PROFIT,
    price: `c.price`,
    sales90: `COALESCE(agg.sales90, 0)`,
    refPurchase: `agg.ref_purchase_price`,
    customPurchase: `pdc.custom_purchase_price`,
    weight: WEIGHT,
    syncedAt: `c.synced_at`,
  };
  const sortExpr = SORTS[sort] || SORTS.profitRateCost;
  const direction = dir === 'desc' ? 'DESC' : 'ASC';

  const base = `
    FROM op_product_price_cache c
    LEFT JOIN product_data_cache pdc ON pdc.sku = c.sku
    LEFT JOIN product_attributes_cache pac ON pac.sku = c.sku
    LEFT JOIN (
      -- 90天销量(剔除已取消)+ 参考采购价(有分摊采购金额的行,采购额/数量加权)
      SELECT CAST(oi.sku AS TEXT) AS sku,
             SUM(CASE WHEN o.in_process_at >= @since90 THEN oi.quantity ELSE 0 END) AS sales90,
             SUM(CASE WHEN oi.purchase_amount > 0 THEN oi.purchase_amount ELSE 0 END)
               / NULLIF(SUM(CASE WHEN oi.purchase_amount > 0 THEN oi.quantity ELSE 0 END), 0) AS ref_purchase_price
      FROM op_ozon_order_item oi
      JOIN op_ozon_order o ON o.id = oi.ozon_order_id
      JOIN op_package p ON p.ozon_order_id = o.id
      WHERE p.operate_status != 'cancelled'
      GROUP BY oi.sku
    ) agg ON agg.sku = c.sku`;
  args.since90 = new Date(Date.now() - 90 * 86400_000).toISOString();

  const cols = `
      c.sku, c.store_id AS store_id, c.product_id, c.offer_id,
      c.price, c.old_price, c.min_price, c.currency_code,
      c.sales_percent_fbs, c.market_min_price_rub, c.price_index_color,
      c.name, c.image, c.synced_at,
      pdc.custom_purchase_price, pdc.custom_purchase_price_at,
      pdc.custom_weight_g AS custom_weight,
      ${WEIGHT} AS weight_g,
      agg.sales90, agg.ref_purchase_price,
      ${PROFIT} AS profit_cny,
      ${RATE_COST} AS profit_rate_cost,
      ${RATE_SALE} AS profit_rate_sale`;

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db
    .prepare(`SELECT COUNT(*) AS n ${base} ${whereSql}`)
    .get(args).n;
  const limit = Math.min(Number(pageSize) || 20, 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const items = db
    .prepare(
      `SELECT ${cols} ${base} ${whereSql}
       ORDER BY (${sortExpr}) IS NULL ASC, ${sortExpr} ${direction}, c.sku ASC
       LIMIT ${limit} OFFSET ${offset}`
    )
    .all(args);
  return { total, items };
}

// ── SKU 维护(采购价/重量,写 product_data_cache) ──

export function setSkuCustoms(sku, { purchasePrice, weightG } = {}) {
  const sets = [];
  const args = [];
  if (purchasePrice !== undefined) {
    sets.push(`custom_purchase_price = ?`, `custom_purchase_price_at = ?`);
    const v = purchasePrice === null || purchasePrice === '' ? null : Number(purchasePrice);
    if (v != null && (!Number.isFinite(v) || v < 0)) throw new Error('采购价必须为非负数字');
    args.push(v, nowIso());
  }
  if (weightG !== undefined) {
    sets.push(`custom_weight_g = ?`);
    const w = weightG === null || weightG === '' ? null : Number(weightG);
    if (w != null && (!Number.isFinite(w) || w <= 0)) throw new Error('重量必须为正数');
    args.push(w);
  }
  if (!sets.length) return { updated: 0 };
  args.push(String(sku));
  const r = db
    .prepare(`UPDATE product_data_cache SET ${sets.join(', ')} WHERE sku = ?`)
    .run(...args);
  return { updated: r.changes };
}

// ── SKU 历史订单(展开行) ──

export function skuOrderList(sku, limit = 20) {
  const skuNum = Number(sku);
  if (!Number.isInteger(skuNum)) return [];
  return db
    .prepare(
      `SELECT o.posting_number, o.in_process_at, o.status, o.substatus,
              p.package_no, p.operate_status, p.purchase_status, p.is_ignored,
              p.delivered_at, p.arrived_at,
              oi.quantity, oi.price AS unit_price,
              oi.purchase_amount AS item_purchase_amount,
              p.total_purchase_amount,
              (SELECT SUM(quantity) FROM op_ozon_order_item WHERE ozon_order_id = o.id) AS pkg_total_qty,
              -- 单件参考采购价:行分摊采购额/行数量 → 包裹采购总额/包裹总数量 → NULL
              CASE
                WHEN oi.purchase_amount > 0 AND oi.quantity > 0 THEN ROUND(oi.purchase_amount / oi.quantity, 2)
                WHEN p.total_purchase_amount > 0 AND (SELECT SUM(quantity) FROM op_ozon_order_item WHERE ozon_order_id = o.id) > 0
                  THEN ROUND(p.total_purchase_amount / (SELECT SUM(quantity) FROM op_ozon_order_item WHERE ozon_order_id = o.id), 2)
                ELSE NULL
              END AS unit_ref_purchase
       FROM op_ozon_order_item oi
       JOIN op_ozon_order o ON o.id = oi.ozon_order_id
       JOIN op_package p ON p.ozon_order_id = o.id
       WHERE oi.sku = ?
       ORDER BY o.in_process_at DESC
       LIMIT ?`
    )
    .all(skuNum, Math.min(Number(limit) || 20, 100));
}

// ── 改价日志与限频 ─────────────────────────────────────────

// Ozon 限制:每商品每小时改价 ≤10 次
export function countPriceChangesSince(sku, sinceIso) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM op_price_change_log WHERE sku = ? AND created_at >= ?`)
    .get(String(sku), sinceIso).n;
}

export function insertPriceChangeLog(entry) {
  db.prepare(
    `INSERT INTO op_price_change_log (
       store_id, sku, product_id, old_price, new_price, old_old_price,
       currency_code, target_rate, source, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.storeId, String(entry.sku), entry.productId ?? null,
    entry.oldPrice ?? null, entry.newPrice ?? null, entry.oldOldPrice ?? null,
    entry.currencyCode ?? 'CNY', entry.targetRate ?? null,
    entry.source ?? 'target', entry.createdAt ?? nowIso()
  );
}

export function lastPriceChange(sku) {
  return db
    .prepare(`SELECT * FROM op_price_change_log WHERE sku = ? ORDER BY id DESC LIMIT 1`)
    .get(String(sku)) || null;
}

// ── 顶部统计条 ──────────────────────────────────────────────

export function priceManageSummary({ commissionRate = 0.16, deliveryBase = 3.37, deliveryPerGram = 0.0281 } = {}) {
  const WEIGHT = `CAST(COALESCE(pdc.custom_weight_g, json_extract(pac.attributes_data, '$.weight')) AS REAL)`;
  const PROFIT = `CASE WHEN c.price IS NOT NULL AND pdc.custom_purchase_price IS NOT NULL THEN
      c.price * (1 - @cr) - CASE WHEN ${WEIGHT} IS NOT NULL THEN @db + @dg * ${WEIGHT} ELSE 0 END - pdc.custom_purchase_price
    END`;
  const RATE_COST = `CASE WHEN ${PROFIT} IS NOT NULL AND pdc.custom_purchase_price > 0 THEN ${PROFIT} / pdc.custom_purchase_price * 100 END`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN pdc.custom_purchase_price IS NOT NULL THEN 1 ELSE 0 END) AS purchase_set,
              SUM(CASE WHEN ${WEIGHT} IS NOT NULL THEN 1 ELSE 0 END) AS weight_set,
              SUM(CASE WHEN ${RATE_COST} IS NOT NULL AND ${RATE_COST} < 20 THEN 1 ELSE 0 END) AS low_profit
       FROM op_product_price_cache c
       LEFT JOIN product_data_cache pdc ON pdc.sku = c.sku
       LEFT JOIN product_attributes_cache pac ON pac.sku = c.sku`
    )
    .get({ cr: commissionRate, db: deliveryBase, dg: deliveryPerGram });
  return {
    total: row.total || 0,
    purchaseSet: row.purchase_set || 0,
    weightSet: row.weight_set || 0,
    lowProfit: row.low_profit || 0,
  };
}
