// 店铺健康-错误指数 DAO(2026-11-03)
// 表结构见 schema.sql op_rating_* 系列;设计文档: docs/店铺健康页面-功能设计.md
// 语义:
//   - op_rating_daily:每日错误指数/费用快照(同店铺同日覆盖),供趋势图
//   - op_rating_snapshot:当前周期错误指数汇总(info 接口),同店铺覆盖,供概览大数字
//   - op_rating_error_posting:影响错误指数的货件明细(同店铺同货件覆盖),供明细表
// 同步采用「先删后插」区间替换:Ozon 数据可能回退/修正,避免残留旧行
import { db } from '../../index.js';

function nowIso() {
  return new Date().toISOString();
}

function buildStoreClause(storeIds, prefix = '') {
  const ids = (Array.isArray(storeIds) ? storeIds : []).filter(Boolean);
  if (ids.length === 0) return { sql: '', params: [] };
  return { sql: ` AND ${prefix}store_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** upsert 每日错误指数(同店铺同日覆盖) */
export function replaceRatingDaily(storeId, date, indexByDate, costsByDate, periodFrom, periodTo) {
  db.prepare(
    `INSERT INTO op_rating_daily (store_id, date, index_by_date, processing_costs_sum_by_date, period_from, period_to, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id, date) DO UPDATE SET
       index_by_date = excluded.index_by_date,
       processing_costs_sum_by_date = excluded.processing_costs_sum_by_date,
       period_from = excluded.period_from,
       period_to = excluded.period_to,
       synced_at = excluded.synced_at`
  ).run(
    String(storeId),
    String(date),
    Number(indexByDate) || 0,
    Number(costsByDate) || 0,
    periodFrom || null,
    periodTo || null,
    nowIso()
  );
}

/** upsert 当前周期错误指数汇总(同店铺覆盖) */
export function replaceRatingSnapshot(storeId, { index, processingCostsSum, currencyCode, periodFrom, periodTo }) {
  db.prepare(
    `INSERT INTO op_rating_snapshot (store_id, rating_index, processing_costs_sum, currency_code, period_from, period_to, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id) DO UPDATE SET
       rating_index = excluded.rating_index,
       processing_costs_sum = excluded.processing_costs_sum,
       currency_code = excluded.currency_code,
       period_from = excluded.period_from,
       period_to = excluded.period_to,
       synced_at = excluded.synced_at`
  ).run(
    String(storeId),
    Number(index) || 0,
    Number(processingCostsSum) || 0,
    currencyCode || null,
    periodFrom || null,
    periodTo || null,
    nowIso()
  );
}

/** upsert 影响错误指数的货件(同店铺同货件覆盖) */
export function replaceRatingErrorPosting(storeId, e) {
  db.prepare(
    `INSERT INTO op_rating_error_posting (
       store_id, posting_number, posting_error_type, delivery_schema, error_at,
       rating_index, has_grace_status, charge_percent, charge_price, charge_price_currency_code,
       product_price, product_price_currency_code, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id, posting_number) DO UPDATE SET
       posting_error_type = excluded.posting_error_type,
       delivery_schema = excluded.delivery_schema,
       error_at = excluded.error_at,
       rating_index = excluded.rating_index,
       has_grace_status = excluded.has_grace_status,
       charge_percent = excluded.charge_percent,
       charge_price = excluded.charge_price,
       charge_price_currency_code = excluded.charge_price_currency_code,
       product_price = excluded.product_price,
       product_price_currency_code = excluded.product_price_currency_code,
       synced_at = excluded.synced_at`
  ).run(
    String(storeId),
    String(e.posting_number || ''),
    String(e.posting_error_type || 'UNSPECIFIED'),
    e.delivery_schema || null,
    e.error_at || null,
    Number(e.index) || 0,
    e.has_grace_status ? 1 : 0,
    Number(e.charge_percent) || 0,
    Number(e.charge_price) || 0,
    e.charge_price_currency_code || null,
    Number(e.product_price) || 0,
    e.product_price_currency_code || null,
    nowIso()
  );
}

/** 删除区间内每日快照(同步前清空,防 Ozon 修正后残留旧值) */
export function clearRatingDaily(storeIds, from, to) {
  const c = buildStoreClause(storeIds);
  db.prepare(
    `DELETE FROM op_rating_daily WHERE date BETWEEN ? AND ?${c.sql}`
  ).run(String(from), String(to), ...c.params);
}

/** 删除区间内影响货件(同步前清空,防 Ozon 修正后残留旧值) */
export function clearRatingErrors(storeIds, from, to) {
  const c = buildStoreClause(storeIds);
  db.prepare(
    `DELETE FROM op_rating_error_posting WHERE error_at BETWEEN ? AND ?${c.sql}`
  ).run(String(from), String(to), ...c.params);
}

/** 每店每日序列(趋势图):返回 [{ storeId, date, indexByDate, processingCostsSumByDate }] */
export function getRatingDailyByStore(storeIds, from, to) {
  const c = buildStoreClause(storeIds);
  return db.prepare(
    `SELECT store_id AS storeId, date, index_by_date AS indexByDate, processing_costs_sum_by_date AS processingCostsSumByDate
     FROM op_rating_daily
     WHERE date BETWEEN ? AND ?${c.sql}
     ORDER BY store_id, date`
  ).all(String(from), String(to), ...c.params);
}

/** 每店当前周期快照:返回 [{ storeId, index, processingCostsSum, currencyCode, periodFrom, periodTo, syncedAt }] */
export function getRatingSnapshots(storeIds) {
  const c = buildStoreClause(storeIds);
  return db.prepare(
    `SELECT store_id AS storeId, rating_index AS "index", processing_costs_sum AS processingCostsSum, currency_code AS currencyCode,
            period_from AS periodFrom, period_to AS periodTo, synced_at AS syncedAt
     FROM op_rating_snapshot
     WHERE 1=1${c.sql}
     ORDER BY store_id`
  ).all(...c.params);
}

/** 影响货件统计:返回 { errorPostingCount, sellerCancellationCount, sellerDelayCount, graceCount, chargeSum, chargeCurrencyCode, schemaCounts } */
export function getRatingErrorTotals(storeIds, from, to) {
  const c = buildStoreClause(storeIds);
  const row = db.prepare(
    `SELECT
       COUNT(*) AS errorPostingCount,
       SUM(CASE WHEN posting_error_type = 'SELLER_CANCELLATION' THEN 1 ELSE 0 END) AS sellerCancellationCount,
       SUM(CASE WHEN posting_error_type = 'SELLER_DELAY' THEN 1 ELSE 0 END) AS sellerDelayCount,
       SUM(CASE WHEN has_grace_status = 1 THEN 1 ELSE 0 END) AS graceCount,
       SUM(charge_price) AS chargeSum,
       MAX(charge_price_currency_code) AS chargeCurrencyCode
     FROM op_rating_error_posting
     WHERE error_at BETWEEN ? AND ?${c.sql}`
  ).get(String(from), String(to), ...c.params);
  const schemaRows = db.prepare(
    `SELECT delivery_schema AS deliverySchema, COUNT(*) AS n
     FROM op_rating_error_posting
     WHERE error_at BETWEEN ? AND ?${c.sql}
     GROUP BY delivery_schema`
  ).all(String(from), String(to), ...c.params);
  return {
    errorPostingCount: Number(row?.errorPostingCount) || 0,
    sellerCancellationCount: Number(row?.sellerCancellationCount) || 0,
    sellerDelayCount: Number(row?.sellerDelayCount) || 0,
    graceCount: Number(row?.graceCount) || 0,
    chargeSum: Number(row?.chargeSum) || 0,
    chargeCurrencyCode: row?.chargeCurrencyCode || null,
    schemaCounts: schemaRows.map((r) => ({ deliverySchema: r.deliverySchema || 'UNKNOWN', n: Number(r.n) || 0 })),
  };
}

/**
 * 影响货件分页明细(offset 分页)
 * 返回 { items, total }
 * items[] 额外 join op_ozon_order 带订单状态(orderStatus),便于前端跳转订单详情
 */
export function getRatingErrors(storeIds, from, to, { limit = 50, offset = 0 } = {}) {
  const cTotal = buildStoreClause(storeIds);
  const cItems = buildStoreClause(storeIds, 'e.');
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM op_rating_error_posting WHERE error_at BETWEEN ? AND ?${cTotal.sql}`
  ).get(String(from), String(to), ...cTotal.params).n;
  const items = db.prepare(
    `SELECT e.store_id AS storeId,
            e.posting_number AS postingNumber,
            e.posting_error_type AS postingErrorType,
            e.delivery_schema AS deliverySchema,
            e.error_at AS errorAt,
            e.rating_index AS "index",
            e.has_grace_status AS hasGraceStatus,
            e.charge_percent AS chargePercent,
            e.charge_price AS chargePrice,
            e.charge_price_currency_code AS chargeCurrencyCode,
            e.product_price AS productPrice,
            e.product_price_currency_code AS productCurrencyCode,
            o.status AS orderStatus
     FROM op_rating_error_posting e
     LEFT JOIN op_ozon_order o ON o.store_id = e.store_id AND o.posting_number = e.posting_number
     WHERE e.error_at BETWEEN ? AND ?${cItems.sql}
     ORDER BY e.error_at DESC, e.id DESC
     LIMIT ? OFFSET ?`
  ).all(String(from), String(to), ...cItems.params, n, off);
  return { items, total: Number(total) || 0 };
}