// Ozon 面单条码映射 DAO(2026-10-25,扫描发货扫码支持)
// 表结构见 schema.sql op_posting_barcode
// 语义:
//   - upsertPostingBarcode:打印面单时回填 (store_id, posting_number) ↔ lower_barcode,幂等
//   - findPostingByBarcode:扫码搜索用,条码 → 货件号(本地映射)
//   - missingBarcodePostings:返回尚未建立条码映射的货件号(避免缓存命中时反复解析 PDF)
import { db } from '../../index.js';

/** upsert 一条面单条码映射(重复打印只更新条码/采集时间) */
export function upsertPostingBarcode({ storeId, postingNumber, lowerBarcode, upperBarcode = null, fetchedAt }) {
  if (!storeId || !postingNumber || !lowerBarcode) return;
  db.prepare(
    `INSERT INTO op_posting_barcode (store_id, posting_number, lower_barcode, upper_barcode, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(store_id, posting_number) DO UPDATE SET
       lower_barcode = excluded.lower_barcode,
       upper_barcode = excluded.upper_barcode,
       fetched_at   = excluded.fetched_at`
  ).run(storeId, postingNumber, lowerBarcode, upperBarcode, fetchedAt);
}

/**
 * 条码 → 货件号(本地映射)
 * @param {{storeId?: string, barcode: string}} args storeId 可选(不传则跨店取第一条)
 * @returns {{storeId:string, postingNumber:string, lowerBarcode:string}|undefined}
 */
export function findPostingByBarcode({ storeId, barcode }) {
  if (!barcode) return undefined;
  if (storeId) {
    return db
      .prepare(
        `SELECT store_id AS storeId, posting_number AS postingNumber, lower_barcode AS lowerBarcode
         FROM op_posting_barcode WHERE store_id = ? AND lower_barcode = ?`
      )
      .get(storeId, barcode);
  }
  return db
    .prepare(
      `SELECT store_id AS storeId, posting_number AS postingNumber, lower_barcode AS lowerBarcode
       FROM op_posting_barcode WHERE lower_barcode = ? LIMIT 1`
    )
    .get(barcode);
}

/** 返回尚未建立条码映射的货件号(数组) */
export function missingBarcodePostings(storeId, postings) {
  const list = (Array.isArray(postings) ? postings : []).filter(Boolean);
  if (!list.length || !storeId) return list;
  const ph = list.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT posting_number AS postingNumber FROM op_posting_barcode
       WHERE store_id = ? AND posting_number IN (${ph}) AND lower_barcode IS NOT NULL`
    )
    .all(storeId, ...list);
  const have = new Set(rows.map((r) => r.postingNumber));
  return list.filter((p) => !have.has(p));
}