// 妙手 ERP 订单数据 DAO(2026-09,独立新表,与 op_* 分离)
// 表结构见 schema.sql miaoshou_package / miaoshou_purchase;
// 设计文档: docs/妙手订单数据提取-功能设计.md
//
// 数据来源:miaoshou-helper 插件从妙手历史订单页提取的 JSON
// 同步主键:op_order_package_id(妙手包裹内部 ID)
// 采购单去重:UNIQUE(platform, purchase_sn)
import { db } from '../../index.js';
import { getAccrualsByPackageIds } from './accrual-dao.js';

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
      // quantity 从 items 数组提取(订单商品数量,用于采购金额加权分摊)
      const quantity = (r.items || []).reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
      db.prepare(
        `INSERT INTO miaoshou_package (
          op_order_package_id, app_package_no, posting_number, shop_id, shop_nick,
          platform, platform_order_sn, order_amount, buyer_name, buyer_country,
          gmt_order_start, weighing_weight, note, operate_status, purchase_status,
          app_package_tab, platform_package_status, app_package_status_text,
          purchase_amount, logistics_no, logistics_company, gmt_create, gmt_modified, gmt_delivery,
          items_json, quantity, raw_json, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          app_package_tab=excluded.app_package_tab,
          platform_package_status=excluded.platform_package_status,
          app_package_status_text=excluded.app_package_status_text,
          purchase_amount=excluded.purchase_amount,
          logistics_no=excluded.logistics_no,
          logistics_company=excluded.logistics_company,
          gmt_create=excluded.gmt_create,
          gmt_modified=excluded.gmt_modified,
          gmt_delivery=excluded.gmt_delivery,
          items_json=excluded.items_json,
          quantity=excluded.quantity,
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
        r.appPackageTab || null,
        r.platformPackageStatus || null,
        r.appPackageStatusText || null,
        r.purchaseAmount != null ? Number(r.purchaseAmount) : null,
        r.logisticsNo || null,
        r.logisticsCompany || null,
        r.gmtCreate || null,
        r.gmtModified || null,
        r.gmtDelivery || null,
        r.items?.length ? JSON.stringify(r.items) : null,
        quantity,
        r.raw ? JSON.stringify(r.raw) : null,
        now
      );
      pkgUpserted++;

      // 反查真实 id(node:sqlite ON CONFLICT 路径下 lastInsertRowid 不可靠)
      const pkgRow = db
        .prepare(`SELECT id FROM miaoshou_package WHERE op_order_package_id = ?`)
        .get(String(r.opOrderPackageId));

      // 子表 upsert 采购单 + 多对多关联
      // 2026-09 修复:采购单按 UNIQUE(platform, purchase_sn) 去重,只更新采购单自身字段;
      // 不再 update miaoshou_package_id(原 ON CONFLICT 会让后入库包裹抢走关联,
      // 拼单场景下另一个包裹会丢采购单)。关联关系全部走中间表 miaoshou_package_purchase_map。
      // 2026-09-04 修复:对比删除妙手侧已不存在的关联(只增不删导致已取消的关联残留)
      const returnedPurchaseIds = [];
      for (const po of r.purchases || []) {
        if (!po.purchaseSn || !po.platform) continue; // 缺唯一键的跳过
        const purRes = db.prepare(
          `INSERT INTO miaoshou_purchase (
            miaoshou_package_id, purchase_order_id, purchase_sn, platform,
            platform_name, detail_url,
            buyer_account, seller_name, payment_amount, currency, status,
            purchase_start_time, send_at, logistics_company, logistics_no,
            last_trace, items_json, raw_json, is_auto_rsync, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(platform, purchase_sn) DO UPDATE SET
            purchase_order_id=excluded.purchase_order_id,
            platform_name=excluded.platform_name,
            detail_url=excluded.detail_url,
            buyer_account=excluded.buyer_account,
            seller_name=excluded.seller_name,
            payment_amount=excluded.payment_amount,
            status=excluded.status,
            purchase_start_time=excluded.purchase_start_time,
            send_at=excluded.send_at,
            logistics_company=excluded.logistics_company,
            logistics_no=excluded.logistics_no,
            last_trace=excluded.last_trace,
            items_json=excluded.items_json,
            raw_json=excluded.raw_json,
            is_auto_rsync=excluded.is_auto_rsync,
            synced_at=excluded.synced_at,
            updated_at=datetime('now')
          RETURNING id`
        ).get(
          pkgRow.id,                      // 兼容:首次插入时填,后续 ON CONFLICT 路径不更新此列
          po.purchaseOrderId || null,
          po.purchaseSn,
          po.platform,
          po.platformName || null,
          po.detailUrl || null,
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
          po.items?.length ? JSON.stringify(po.items) : null,
          po.raw ? JSON.stringify(po.raw) : null,
          po.raw?.isAutoRsyncPurchasePayment === '1' || po.raw?.isAutoRsyncPurchasePayment === 1 ? 1 : 0,
          now
        );
        // RETURNING id 兼容 INSERT 与 ON CONFLICT 两条路径,取出真实采购单 id
        const purchaseId = purRes?.id
          ?? db.prepare(`SELECT id FROM miaoshou_purchase WHERE platform=? AND purchase_sn=?`).get(po.platform, po.purchaseSn).id;
        // 中间表 upsert(package_id, purchase_id) — 多对多关联
        // raw_json 存该包裹采集此采购单时的原始 JSON(每个包裹视角不同,如 platformOrderSn/opOrderPackageId)
        db.prepare(
          `INSERT INTO miaoshou_package_purchase_map (package_id, purchase_id, raw_json, synced_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(package_id, purchase_id) DO UPDATE SET
             raw_json=excluded.raw_json,
             synced_at=excluded.synced_at`
        ).run(pkgRow.id, purchaseId, po.raw ? JSON.stringify(po.raw) : null, now);
        returnedPurchaseIds.push(purchaseId);
        purUpserted++;
      }
      // 对比删除:删除本地有但妙手侧已不存在的关联(妙手侧取消关联后,重新同步可感知并清除)
      if (returnedPurchaseIds.length > 0) {
        const placeholders = returnedPurchaseIds.map(() => '?').join(',');
        const delRes = db.prepare(
          `DELETE FROM miaoshou_package_purchase_map
           WHERE package_id = ? AND purchase_id NOT IN (${placeholders})`
        ).run(pkgRow.id, ...returnedPurchaseIds);
        if (delRes.changes > 0) {
          console.log(`[miaoshou-dao] 包裹 ${r.appPackageNo} 清理 ${delRes.changes} 个妙手侧已删除的采购单关联`);
        }
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
  // 状态 tab 筛选(按妙手自身 tab 分组 appPackageTab:waitProcess/waitShip/submitPlatform/
  // waitReceiverConfirm/closed/isolation;操作状态 operate_status 会分散在多个 tab,不能用于分类)
  if (filters.appPackageTab) {
    where.push('mp.app_package_tab = ?');
    vals.push(filters.appPackageTab);
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
        (SELECT op.accrual_total FROM op_package op WHERE op.logistics_no = mp.posting_number) AS accrual_total,
        (SELECT op.accrual_sale_total FROM op_package op WHERE op.logistics_no = mp.posting_number) AS accrual_sale_total,
        (SELECT op.total_purchase_amount FROM op_package op WHERE op.logistics_no = mp.posting_number) AS total_purchase_amount,
        -- 采购金额分摊:用 quantity(订单商品数量)加权,比均摊更精确
        -- 每个采购单:该包裹 quantity × payment_amount / Σ(所有关联包裹 quantity)
        -- purchaseNum=quantity(来自订单商品数量),D场景3/2→68.7/45.8精确分摊
        -- quantity 都=1时退化为均摊(G场景),不影响总额
        -- NULLIF 防除0(quantity 全0时返回 NULL,兜底链回退)
        (SELECT SUM(pur.payment_amount * 1.0 * mp.quantity / NULLIF(
          (SELECT SUM(mp3.quantity) FROM miaoshou_package_purchase_map m2
           JOIN miaoshou_package mp3 ON mp3.id = m2.package_id
           WHERE m2.purchase_id = pur.id), 0))
         FROM miaoshou_purchase pur
         JOIN miaoshou_package_purchase_map m ON m.purchase_id = pur.id
         WHERE m.package_id = mp.id) AS ms_purchase_amount,
        -- 是否有非自动同步(isAuto=0)的采购单:用券场景,妙手包裹级已被用户手动纠正,可信
        (SELECT COUNT(*) FROM miaoshou_purchase pur
         JOIN miaoshou_package_purchase_map m ON m.purchase_id = pur.id
         WHERE m.package_id = mp.id AND pur.is_auto_rsync = 0) AS ms_has_manual,
        (SELECT o.status FROM op_package op JOIN op_ozon_order o ON o.id = op.ozon_order_id WHERE op.logistics_no = mp.posting_number) AS local_ozon_status,
        (SELECT COUNT(*) FROM miaoshou_package_purchase_map m WHERE m.package_id = mp.id) AS purchase_count
       FROM miaoshou_package mp
       ${whereSql}
       ORDER BY mp.synced_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...vals, pageSize, offset);

  return { packages: rows.map(parsePackageRow), total, page, pageSize };
}

// items_json → items 数组(前端产品信息展示)
function parsePackageRow(row) {
  if (!row) return row;
  let items = [];
  if (row.items_json) {
    try { items = JSON.parse(row.items_json) || []; } catch { items = []; }
  }
  return { ...row, items_json: undefined, items };
}

/**
 * 状态 tab 计数(按妙手自身 tab 分组 app_package_tab,附总数与本地关联数)
 * 值域:waitProcess/waitShip/submitPlatform/waitReceiverConfirm/finished/closed/isolation
 */
export function countMiaoshouTabs() {
  const byTab = db
    .prepare(`SELECT app_package_tab AS s, COUNT(*) AS n FROM miaoshou_package GROUP BY app_package_tab`)
    .all();
  const linked = db
    .prepare(`SELECT COUNT(*) AS n FROM miaoshou_package mp WHERE ${LOCAL_PKG_EXISTS}`)
    .get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM miaoshou_package`).get().n;

  const counts = {
    all: total,
    waitProcess: 0,
    waitShip: 0,
    submitPlatform: 0,
    waitReceiverConfirm: 0,
    closed: 0,
    isolation: 0,
  };
  for (const r of byTab) {
    if (r.s === 'waitProcess') counts.waitProcess = r.n;
    else if (r.s === 'waitShip') counts.waitShip = r.n;
    else if (r.s === 'submitPlatform') counts.submitPlatform = r.n;
    else if (r.s === 'waitReceiverConfirm') counts.waitReceiverConfirm = r.n;
    else if (r.s === 'finished') counts.finished = r.n;
    else if (r.s === 'closed') counts.closed = r.n;
    else if (r.s === 'isolation') counts.isolation = r.n;
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
        (SELECT op.id FROM op_package op WHERE op.logistics_no = mp.posting_number) AS local_pkg_id,
        (SELECT op.accrual_total FROM op_package op WHERE op.logistics_no = mp.posting_number) AS accrual_total,
        (SELECT op.accrual_sale_total FROM op_package op WHERE op.logistics_no = mp.posting_number) AS accrual_sale_total
       FROM miaoshou_package mp WHERE mp.id = ?`
    )
    .get(id);
  if (!pkg) return null;

  const purchases = db
    .prepare(
      `SELECT pur.*, m.synced_at AS map_synced_at
       FROM miaoshou_purchase pur
       JOIN miaoshou_package_purchase_map m ON m.purchase_id = pur.id
       WHERE m.package_id = ?
       ORDER BY m.synced_at DESC`
    )
    .all(id)
    .map((po) => {
      let items = [];
      if (po.items_json) {
        try { items = JSON.parse(po.items_json) || []; } catch { items = []; }
      }
      return { ...po, items_json: undefined, items };
    });

  // 本地关联包裹的应计明细(存在 local_pkg_id 时)
  let accruals = [];
  if (pkg.local_pkg_id) {
    accruals = getAccrualsByPackageIds([pkg.local_pkg_id]);
  }

  return { package: parsePackageRow(pkg), purchases, accruals };
}
