// 货件-发运单关联 DAO(2026-11-02)
// 表结构见 schema.sql op_carriage_posting;设计文档: .trellis/tasks/10-31-carriage-posting-link/design.md
// 背景:货件与发运单的绑定关系原本只存在 Ozon 侧,本地无 carriage 字段。
//       本表将 "货件 ↔ 发运单" 关系持久化到本地,支持发运单→货件(当前+历史)、
//       货件→所属发运单、同一发运单共用头程 YT 单号的货件集合。
// 关键语义:
//   - 同一发运单内同一货件只有一行:UNIQUE(store_id, carriage_id, posting_number)
//   - 同一货件当前只能在一个发运单:部分唯一索引 (store_id, posting_number) WHERE removed_at IS NULL
//   - removed_at 软删除:货件移出发运单/发运取消时置值,保留历史轨迹
//   - 冗余 ozon_order_id / package_id:便于 JOIN op_ozon_order / op_package(头程单号、操作状态)
import { db } from '../../index.js';

// 由货件号反查本地订单/包裹 ID(冗余列来源;拆单子件号(-N)也能命中)
function lookupOrderLink(storeId, postingNumber) {
  const row = db
    .prepare(
      `SELECT o.id AS ozonOrderId, p.id AS packageId
       FROM op_ozon_order o
       LEFT JOIN op_package p ON p.ozon_order_id = o.id
       WHERE o.store_id = ? AND o.posting_number = ?
       LIMIT 1`
    )
    .get(String(storeId), String(postingNumber));
  return {
    ozonOrderId: row?.ozonOrderId != null ? Number(row.ozonOrderId) : null,
    packageId: row?.packageId != null ? Number(row.packageId) : null,
  };
}

/**
 * upsert 一条货件-发运单关联(幂等)
 * 首次插入时记录 added_at(进入发运时间);重复同步只更新冗余字段并清除 removed_at。
 * @param {{storeId:string, carriageId:number, posting:object,
 *          deliveryMethodId?:number, departureDate?:string, status?:string, now?:string}} args
 */
export function upsertCarriagePostingRow({ storeId, carriageId, posting, deliveryMethodId, departureDate, status, now } = {}) {
  const postingNumber = posting?.posting_number || posting?.postingNumber;
  if (!storeId || !Number(carriageId) || !postingNumber) return;
  const ts = now || new Date().toISOString();
  const { ozonOrderId, packageId } = lookupOrderLink(storeId, postingNumber);
  db.prepare(
    `INSERT INTO op_carriage_posting
       (store_id, carriage_id, posting_number, ozon_order_id, package_id,
        delivery_method_id, departure_date, status, added_at, removed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(store_id, carriage_id, posting_number) DO UPDATE SET
       ozon_order_id = excluded.ozon_order_id,
       package_id = excluded.package_id,
       delivery_method_id = excluded.delivery_method_id,
       departure_date = excluded.departure_date,
       status = excluded.status,
       removed_at = NULL,
       updated_at = excluded.updated_at`
  ).run(
    String(storeId),
    Number(carriageId),
    String(postingNumber),
    ozonOrderId,
    packageId,
    deliveryMethodId != null ? Number(deliveryMethodId) : null,
    departureDate || null,
    status || posting?.status || null,
    ts,
    ts,
    ts
  );
}

/**
 * 将"当前列表"之外此前仍活跃的行标记为 removed_at(移出发运单)
 * @param {string} storeId
 * @param {number} carriageId
 * @param {string[]} postingNumbers 当前仍在该发运单的货件号(空数组=整单无货件)
 * @param {string} [now]
 * @returns {number} 本次标记移出的行数
 */
export function markAbsentPostingsRemoved(storeId, carriageId, postingNumbers, now) {
  const ts = now || new Date().toISOString();
  const list = [...new Set((Array.isArray(postingNumbers) ? postingNumbers : []).map(String).filter(Boolean))];
  const baseArgs = [ts, ts, String(storeId), Number(carriageId)];
  let sql;
  let args;
  if (list.length) {
    const ph = list.map(() => '?').join(',');
    sql = `UPDATE op_carriage_posting
           SET removed_at = ?, updated_at = ?
           WHERE store_id = ? AND carriage_id = ? AND removed_at IS NULL
             AND posting_number NOT IN (${ph})`;
    args = [...baseArgs, ...list];
  } else {
    // 当前列表为空 → 该发运单全部货件都已移出
    sql = `UPDATE op_carriage_posting
           SET removed_at = ?, updated_at = ?
           WHERE store_id = ? AND carriage_id = ? AND removed_at IS NULL`;
    args = baseArgs;
  }
  const info = db.prepare(sql).run(...args);
  return Number(info.changes);
}

/**
 * 全量刷新一个发运单的货件关联(幂等;纯 DB 组合,不调 Ozon)
 * 先逐条 upsert 当前货件,再把已不在当前列表的活跃行标记 removed_at。
 * 由调用方(写路径/读路径/定时任务)负责先从 Ozon 拉取 postings。
 * @param {string} storeId
 * @param {number} carriageId
 * @param {object[]} postings Ozon 返回的当前货件列表
 * @param {{deliveryMethodId?:number, departureDate?:string}} [meta] 冗余的发运单维度字段
 * @param {string} [now]
 * @returns {{carriageId:number, count:number}}
 */
export function syncCarriagePostings(storeId, carriageId, postings, meta = {}, now) {
  const ts = now || new Date().toISOString();
  const current = [];
  for (const p of Array.isArray(postings) ? postings : []) {
    const postingNumber = p?.posting_number || p?.postingNumber;
    if (!postingNumber) continue;
    current.push(String(postingNumber));
    upsertCarriagePostingRow({
      storeId,
      carriageId,
      posting: p,
      deliveryMethodId: meta?.deliveryMethodId,
      departureDate: meta?.departureDate,
      now: ts,
    });
  }
  markAbsentPostingsRemoved(storeId, carriageId, current, ts);
  return { carriageId: Number(carriageId), count: current.length };
}

/**
 * 查一个发运单的货件关联行
 * @param {string} storeId
 * @param {number} carriageId
 * @param {{includeRemoved?:boolean}} [opts] includeRemoved=true 时含历史(已移出)行
 * @returns {Array<object>} 行对象(camelCase 别名)
 */
export function getCarriagePostingRows(storeId, carriageId, { includeRemoved = false } = {}) {
  return db
    .prepare(
      `SELECT id,
              store_id          AS storeId,
              carriage_id       AS carriageId,
              posting_number    AS postingNumber,
              ozon_order_id     AS ozonOrderId,
              package_id        AS packageId,
              delivery_method_id AS deliveryMethodId,
              departure_date    AS departureDate,
              status,
              added_at          AS addedAt,
              removed_at        AS removedAt,
              created_at        AS createdAt,
              updated_at        AS updatedAt
       FROM op_carriage_posting
       WHERE store_id = ? AND carriage_id = ?
         ${includeRemoved ? '' : 'AND removed_at IS NULL'}
       ORDER BY added_at DESC`
    )
    .all(String(storeId), Number(carriageId));
}

/**
 * 查一个货件所属的所有发运单(含历史;按进入时间倒序)
 * @param {string} storeId
 * @param {string} postingNumber
 * @returns {Array<object>}
 */
export function getPostingCarriages(storeId, postingNumber) {
  if (!postingNumber) return [];
  return db
    .prepare(
      `SELECT id,
              carriage_id       AS carriageId,
              status,
              added_at          AS addedAt,
              removed_at        AS removedAt,
              updated_at        AS updatedAt
       FROM op_carriage_posting
       WHERE store_id = ? AND posting_number = ?
       ORDER BY added_at DESC`
    )
    .all(String(storeId), String(postingNumber));
}

/**
 * 发运取消:该发运单所有活跃关联行置 removed_at(货件回到待发运池)
 * @param {string} storeId
 * @param {number} carriageId
 * @param {string} [now]
 * @returns {number} 本次标记移出的行数
 */
export function markCarriageRemoved(storeId, carriageId, now) {
  const ts = now || new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE op_carriage_posting
       SET removed_at = ?, updated_at = ?
       WHERE store_id = ? AND carriage_id = ? AND removed_at IS NULL`
    )
    .run(ts, ts, String(storeId), Number(carriageId));
  return Number(info.changes);
}