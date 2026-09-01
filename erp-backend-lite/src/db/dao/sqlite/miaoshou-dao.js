// 妙手 ERP 订单数据 DAO(2026-09,独立新表,与 op_* 分离)
// 表结构见 schema.sql miaoshou_package / miaoshou_purchase;
// 设计文档: docs/妙手订单数据提取-功能设计.md
//
// 数据来源:miaoshou-helper 插件从妙手历史订单页提取的 JSON
// 同步主键:op_order_package_id(妙手包裹内部 ID)
// 采购单去重:UNIQUE(platform, purchase_sn)
import { db } from '../../index.js';

function nowIso() {
  return new Date().toISOString();
}

// node:sqlite(DatabaseSync) 无 db.transaction(),用显式事务
function runInTx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 批量 upsert 妙手数据到独立新表
 * @param {Array} records — 插件提取的精简订单数组(见 simplify 函数)
 * @returns {{ packages: number, purchases: number, total: number }}
 */
export function upsertMiaoshouOrders(records) {
  return runInTx(() => {
    let pkgUpserted = 0;
    let purUpserted = 0;
    const now = nowIso();

    for (const r of records) {
      if (!r.opOrderPackageId) continue; // 缺主键的记录跳过

      // 主表 upsert by op_order_package_id
      db.prepare(
        `INSERT INTO miaoshou_package (
          op_order_package_id, app_package_no, posting_number, shop_id, shop_nick,
          platform, platform_order_sn, order_amount, buyer_name, buyer_country,
          gmt_order_start, weighing_weight, note, operate_status, purchase_status,
          logistics_no, logistics_company, gmt_create, gmt_modified, gmt_delivery,
          raw_json, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(op_order_package_id) DO UPDATE SET
          app_package_no=excluded.app_package_no,
          posting_number=excluded.posting_number,
          shop_id=excluded.shop_id,
          shop_nick=excluded.shop_nick,
          platform_order_sn=excluded.platform_order_sn,
          order_amount=excluded.order_amount,
          buyer_name=excluded.buyer_name,
          buyer_country=excluded.buyer_country,
          gmt_order_start=excluded.gmt_order_start,
          weighing_weight=excluded.weighing_weight,
          note=excluded.note,
          operate_status=excluded.operate_status,
          purchase_status=excluded.purchase_status,
          logistics_no=excluded.logistics_no,
          logistics_company=excluded.logistics_company,
          gmt_create=excluded.gmt_create,
          gmt_modified=excluded.gmt_modified,
          gmt_delivery=excluded.gmt_delivery,
          raw_json=excluded.raw_json,
          synced_at=excluded.synced_at,
          updated_at=datetime('now')`
      ).run(
        String(r.opOrderPackageId),
        r.appPackageNo || null,
        r.postingNumber || null,
        r.shopId || null,
        r.shopNick || null,
        'ozon',
        r.platformOrderSn || null,
        r.orderAmount || null,
        r.buyerName || null,
        r.buyerCountry || null,
        r.gmtOrderStart || null,
        r.weighingWeight != null ? Number(r.weighingWeight) : null,
        r.note || null,
        r.operateStatus || null,
        r.purchaseStatus || null,
        r.logisticsNo || null,
        r.logisticsCompany || null,
        r.gmtCreate || null,
        r.gmtModified || null,
        r.gmtDelivery || null,
        r.raw ? JSON.stringify(r.raw) : null,
        now
      );
      pkgUpserted++;

      // 反查真实 id(node:sqlite ON CONFLICT 路径下 lastInsertRowid 不可靠)
      const pkgRow = db
        .prepare(`SELECT id FROM miaoshou_package WHERE op_order_package_id = ?`)
        .get(String(r.opOrderPackageId));

      // 子表 upsert 采购单
      for (const po of r.purchases || []) {
        if (!po.purchaseSn || !po.platform) continue; // 缺唯一键的跳过
        db.prepare(
          `INSERT INTO miaoshou_purchase (
            miaoshou_package_id, purchase_order_id, purchase_sn, platform,
            buyer_account, seller_name, payment_amount, currency, status,
            purchase_start_time, send_at, logistics_company, logistics_no,
            last_trace, raw_json, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(platform, purchase_sn) DO UPDATE SET
            miaoshou_package_id=excluded.miaoshou_package_id,
            purchase_order_id=excluded.purchase_order_id,
            buyer_account=excluded.buyer_account,
            seller_name=excluded.seller_name,
            payment_amount=excluded.payment_amount,
            status=excluded.status,
            purchase_start_time=excluded.purchase_start_time,
            send_at=excluded.send_at,
            logistics_company=excluded.logistics_company,
            logistics_no=excluded.logistics_no,
            last_trace=excluded.last_trace,
            raw_json=excluded.raw_json,
            synced_at=excluded.synced_at,
            updated_at=datetime('now')`
        ).run(
          pkgRow.id,
          po.purchaseOrderId || null,
          po.purchaseSn,
          po.platform,
          po.buyerAccount || null,
          po.sellerName || null,
          po.paymentAmount != null ? Number(po.paymentAmount) : 0,
          'CNY',
          po.status || null,
          po.purchaseStartTime || null,
          po.sendAt || null,
          po.logisticsCompany || null,
          po.logisticsNo || null,
          po.lastTrace || null,
          po.raw ? JSON.stringify(po.raw) : null,
          now
        );
        purUpserted++;
      }
    }

    return { packages: pkgUpserted, purchases: purUpserted, total: records.length };
  });
}

// 本地关联子查询(posting_number = op_package.logistics_no)
const LOCAL_PKG_EXISTS = `EXISTS (SELECT 1 FROM op_package op WHERE op.logistics_no = mp.posting_number)`;

/**
 * 分页查询妙手订单(关联本地 op_package)
 * @param {{ page?: number, pageSize?: number, shopNick?: string, keyword?: string,
 *           operateStatus?: string, localLinked?: ''|'0'|'1' }} filters
 */
export function listMiaoshouPackages(filters = {}) {
  const page = Number(filters.page) || 1;
  const pageSize = Number(filters.pageSize) || 20;
  const offset = (page - 1) * pageSize;

  const where = [];
  const vals = [];
  if (filters.shopNick) {
    where.push('mp.shop_nick = ?');
    vals.push(filters.shopNick);
  }
  if (filters.keyword) {
    where.push('(mp.posting_number LIKE ? OR mp.app_package_no LIKE ? OR mp.note LIKE ?)');
    const kw = `%${filters.keyword}%`;
    vals.push(kw, kw, kw);
  }
  // 状态 tab 筛选(operate_status 值域与本地 op_package 一致)
  if (filters.operateStatus) {
    where.push('mp.operate_status = ?');
    vals.push(filters.operateStatus);
  }
  // 本地关联筛选:'1' 已关联本地 op_package,'0' 未关联
  if (filters.localLinked === '1') where.push(LOCAL_PKG_EXISTS);
  else if (filters.localLinked === '0') where.push(`NOT ${LOCAL_PKG_EXISTS}`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db
    .prepare(`SELECT COUNT(*) as n FROM miaoshou_package mp ${whereSql}`)
    .get(...vals).n;

  const rows = db
    .prepare(
      `SELECT mp.*,
        (SELECT op.id FROM op_package op WHERE op.logistics_no = mp.posting_number) AS local_pkg_id,
        (SELECT COUNT(*) FROM miaoshou_purchase pur WHERE pur.miaoshou_package_id = mp.id) AS purchase_count
       FROM miaoshou_package mp
       ${whereSql}
       ORDER BY mp.synced_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...vals, pageSize, offset);

  return { packages: rows, total, page, pageSize };
}

/**
 * 状态 tab 计数(按 operate_status 分组,附总数与本地关联数)
 * 值域:wait_process/wait_ship/ship_success/wait_receiver_confirm/cancelled
 */
export function countMiaoshouTabs() {
  const byStatus = db
    .prepare(`SELECT operate_status AS s, COUNT(*) AS n FROM miaoshou_package GROUP BY operate_status`)
    .all();
  const linked = db
    .prepare(`SELECT COUNT(*) AS n FROM miaoshou_package mp WHERE ${LOCAL_PKG_EXISTS}`)
    .get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM miaoshou_package`).get().n;

  const counts = {
    all: total,
    waitProcess: 0,
    waitShip: 0,
    shipSuccess: 0,
    waitReceiverConfirm: 0,
    cancelled: 0,
  };
  for (const r of byStatus) {
    if (r.s === 'wait_process') counts.waitProcess = r.n;
    else if (r.s === 'wait_ship') counts.waitShip = r.n;
    else if (r.s === 'ship_success') counts.shipSuccess = r.n;
    else if (r.s === 'wait_receiver_confirm') counts.waitReceiverConfirm = r.n;
    else if (r.s === 'cancelled') counts.cancelled = r.n;
  }
  counts.linked = linked;
  counts.unlinked = total - linked;
  return counts;
}

/**
 * 查询单个妙手包裹详情(含采购单列表)
 */
export function getMiaoshouPackageDetail(id) {
  const pkg = db
    .prepare(
      `SELECT mp.*,
        (SELECT op.id FROM op_package op WHERE op.logistics_no = mp.posting_number) AS local_pkg_id
       FROM miaoshou_package mp WHERE mp.id = ?`
    )
    .get(id);
  if (!pkg) return null;

  const purchases = db
    .prepare(
      `SELECT * FROM miaoshou_purchase WHERE miaoshou_package_id = ? ORDER BY synced_at DESC`
    )
    .all(id);

  return { package: pkg, purchases };
}
