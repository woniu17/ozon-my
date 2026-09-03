// 订单处理 DAO(2026-08,个人自发货模式)
// 表结构见 schema.sql op_* 系列;设计文档: docs/采购订单-Ozon订单关联管理-功能设计.md
// 关键语义:
//   - operate_status 只前进不回退(采购提交/打单/Ozon状态联动均为事件驱动推进)
//   - purchase_amount 回写在 ozon_order_item 上(取消关联时冲回)
//   - 提交采购信息 → 包裹直接流转 wait_ship(到货进度以 arrived_at 标记展示,不阻塞)
import { db } from '../../index.js';

// operate_status 前进序( cancelled 独立,任意状态可进 )
const OPERATE_RANK = {
  wait_process: 0,
  wait_ship: 1,
  ship_success: 2,
  wait_receiver_confirm: 3,
};

function nowIso() {
  return new Date().toISOString();
}

// node:sqlite(DatabaseSync) 无 db.transaction(),用显式事务
// (project memory:使用 db.transaction 会 500)
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

// 包裹号:MS + yyMMddHHmmss + 3位随机(对齐妙手 MS20260829... 格式)
function genPackageNo() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    String(d.getFullYear()).slice(2) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  const rand = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `MS${ts}${rand}`;
}

// ── 订单同步落库 ─────────────────────────────────────────────

/** upsert Ozon 订单(posting)→ 返回订单 id
 *  注意:ON CONFLICT DO UPDATE 路径下 lastInsertRowid 不可靠(可能为 0/陈旧值),
 *  统一 upsert 后按唯一键 SELECT 反查真实 id,否则后续子表 INSERT 触发 FK 失败
 */
function upsertOrder(storeId, p) {
  const now = nowIso();
  const products = Array.isArray(p.products) ? p.products : [];
  // v4 实测:products[].price 为 {amount, currency} 对象;兜底 financial_data 数字价
  let orderAmount = 0;
  for (const pr of products) {
    const amount =
      Number(typeof pr.price === 'object' ? pr.price?.amount : pr.price) || 0;
    orderAmount += amount * (Number(pr.quantity) || 1);
  }
  const dm = p.delivery_method || {};
  db
    .prepare(
      `INSERT INTO op_ozon_order (
        store_id, posting_number, order_id, order_number, parent_posting_number,
        status, substatus, in_process_at, shipment_date, delivering_date,
        currency, order_amount, buyer_id, buyer_name, buyer_city,
        delivery_method_name, warehouse_name, tpl_integration_type, is_express,
        cancellation_json, raw_json, first_synced_at, last_synced_at, gmt_create, gmt_modified
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_id, posting_number) DO UPDATE SET
        order_id = excluded.order_id,
        order_number = excluded.order_number,
        parent_posting_number = excluded.parent_posting_number,
        status = excluded.status,
        substatus = excluded.substatus,
        in_process_at = excluded.in_process_at,
        shipment_date = excluded.shipment_date,
        delivering_date = excluded.delivering_date,
        order_amount = excluded.order_amount,
        buyer_id = excluded.buyer_id,
        buyer_name = excluded.buyer_name,
        buyer_city = excluded.buyer_city,
        delivery_method_name = excluded.delivery_method_name,
        warehouse_name = excluded.warehouse_name,
        tpl_integration_type = excluded.tpl_integration_type,
        is_express = excluded.is_express,
        cancellation_json = excluded.cancellation_json,
        raw_json = excluded.raw_json,
        last_synced_at = excluded.last_synced_at,
        gmt_modified = excluded.gmt_modified`
    )
    .run(
      storeId,
      String(p.posting_number || ''),
      p.order_id ? Number(p.order_id) : null,
      p.order_number || null,
      p.parent_posting_number || null,
      p.status || null,
      p.substatus || null,
      p.in_process_at || null,
      p.shipment_date || null,
      p.delivering_date || null,
      'CNY',
      Math.round(orderAmount * 100) / 100,
      p.customer?.customer_id ? String(p.customer.customer_id) : null,
      p.customer?.name || null,
      p.customer?.address?.city || p.analytics_data?.city || null,
      dm.name || null,
      dm.warehouse || p.analytics_data?.warehouse || null,
      p.tpl_integration_type || null,
      p.is_express ? 1 : 0,
      p.cancellation ? JSON.stringify(p.cancellation) : null,
      JSON.stringify(p),
      now,
      now,
      now,
      now
    );
  const found = db
    .prepare(`SELECT id FROM op_ozon_order WHERE store_id = ? AND posting_number = ?`)
    .get(storeId, String(p.posting_number || ''));
  return found.id;
}

/** 同步产品行:upsert by (order, sku, offer_id);删除 Ozon 侧已不存在的行(保留 purchase_amount) */
function syncOrderItems(ozonOrderId, products) {
  const now = nowIso();
  const upsert = db.prepare(
    `INSERT INTO op_ozon_order_item (ozon_order_id, sku, offer_id, title, quantity, price, currency_code, gmt_create, gmt_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ozon_order_id, sku, offer_id) DO UPDATE SET
       title = excluded.title,
       quantity = excluded.quantity,
       price = excluded.price,
       currency_code = excluded.currency_code,
       gmt_modified = excluded.gmt_modified`
  );
  const seen = [];
  for (const pr of Array.isArray(products) ? products : []) {
    const sku = pr.sku ? Number(pr.sku) : null;
    const offerId = pr.offer_id != null ? String(pr.offer_id) : '';
    const price =
      Number(typeof pr.price === 'object' ? pr.price?.amount : pr.price) || 0;
    upsert.run(ozonOrderId, sku, offerId, pr.name || null, Number(pr.quantity) || 1, price, 'CNY', now, now);
    seen.push({ sku, offerId });
  }
  // 删除已不存在的行(注意保留关联了采购的行:被采购关联的产品行不允许静默删除)
  const rows = db
    .prepare(`SELECT id, sku, offer_id FROM op_ozon_order_item WHERE ozon_order_id = ?`)
    .all(ozonOrderId);
  const del = db.prepare(
    `DELETE FROM op_ozon_order_item WHERE id = ? AND id NOT IN (SELECT ozon_order_item_id FROM op_purchase_link WHERE ozon_order_item_id = op_ozon_order_item.id)`
  );
  for (const r of rows) {
    const still = seen.some(
      (s) => String(s.sku) === String(r.sku) && String(s.offerId) === String(r.offer_id)
    );
    if (!still) del.run(r.id);
  }
}

/** 确保包裹存在(一个 posting = 一个包裹)→ 返回包裹 id */
function ensurePackage(ozonOrderId, storeId, posting) {
  const found = db
    .prepare(`SELECT id FROM op_package WHERE ozon_order_id = ?`)
    .get(ozonOrderId);
  if (found) return found.id;
  const now = nowIso();
  const r = db
    .prepare(
      `INSERT INTO op_package (package_no, ozon_order_id, store_id, operate_status, logistics_no, last_delivery_at, gmt_create, gmt_modified)
       VALUES (?, ?, ?, 'wait_process', ?, ?, ?, ?)`
    )
    .run(
      genPackageNo(),
      ozonOrderId,
      storeId,
      String(posting.posting_number || ''),
      posting.shipment_date || null,
      now,
      now
    );
  return Number(r.lastInsertRowid);
}

/** Ozon 状态联动(只前进,不回退;cancelled 任意状态可进) */
function applyOzonStatus(packageId, ozonStatus, { deliveringDate, shipmentDate } = {}) {
  const pkg = db.prepare(`SELECT * FROM op_package WHERE id = ?`).get(packageId);
  if (!pkg || pkg.is_ignored) return;
  const now = nowIso();
  const sets = [];
  const vals = [];

  const rank = (s) => OPERATE_RANK[s] ?? -1;
  const advanceTo = (target) => {
    if (rank(target) > rank(pkg.operate_status)) {
      sets.push('operate_status = ?');
      vals.push(target);
    }
  };

  if (ozonStatus === 'cancelled' || ozonStatus === 'not_accepted') {
    if (pkg.operate_status !== 'cancelled') {
      sets.push('operate_status = ?');
      vals.push('cancelled');
    }
  } else if (
    ozonStatus === 'delivering' ||
    ozonStatus === 'driver_pickup' ||
    ozonStatus === 'delivered'
  ) {
    advanceTo('wait_receiver_confirm');
    if (!pkg.is_shipped) {
      sets.push('is_shipped = 1');
    }
    if (!pkg.shipped_at) {
      sets.push('shipped_at = ?');
      vals.push(deliveringDate || now);
    }
    if (ozonStatus === 'delivered' && !pkg.delivered_at) {
      sets.push('delivered_at = ?');
      vals.push(now);
    }
  }
  // ★ 方案A(2026-08-29):Ozon状态联动不再推进 wait_ship ——
  //   await_ship 流转的唯一入口是「提交采购信息」(submitPurchase),
  //   待处理=未采购、待打单发货=已采购待打单 的语义由采购动作驱动,Ozon状态仅供展示。
  //   同步仅推进: delivering/delivered → wait_receiver_confirm(已发货),cancelled → cancelled。
  // awaiting_packaging / awaiting_approve / awaiting_registration / awaiting_deliver / arbitration → 维持当前操作状态

  if (shipmentDate) {
    sets.push('last_delivery_at = ?');
    vals.push(shipmentDate);
  }
  if (sets.length === 0) return;
  sets.push('gmt_modified = ?');
  vals.push(now);
  db.prepare(`UPDATE op_package SET ${sets.join(', ')} WHERE id = ?`).run(...vals, packageId);
}

/** 同步单个 posting(订单+产品行+包裹+状态联动) */
function syncPosting(storeId, p) {
  const orderId = upsertOrder(storeId, p);
  syncOrderItems(orderId, p.products);
  const packageId = ensurePackage(orderId, storeId, p);
  applyOzonStatus(packageId, p.status, {
    deliveringDate: p.delivering_date,
    shipmentDate: p.shipment_date,
  });
  return { orderId, packageId };
}

/** 更新同步游标 */
function updateSyncCursor(storeId, { count, error } = {}) {
  db.prepare(
    `INSERT INTO op_sync_cursor (store_id, sync_type, last_run_at, last_count, last_error)
     VALUES (?, 'orders', ?, ?, ?)
     ON CONFLICT(store_id, sync_type) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_count = excluded.last_count,
       last_error = excluded.last_error`
  ).run(storeId, nowIso(), count ?? 0, error || null);
}

function getSyncCursors() {
  return db
    .prepare(`SELECT store_id AS storeId, last_run_at AS lastRunAt, last_count AS lastCount, last_error AS lastError FROM op_sync_cursor WHERE sync_type = 'orders'`)
    .all();
}

// ── 列表查询 ─────────────────────────────────────────────────

/** Tab 计数(页面页签)
 *  拆分(2026-09):wait_receiver_confirm 按 delivered_at 是否为空再拆为
 *    - waitReceiverConfirm: 已交运未妥投(delivered_at IS NULL)
 *    - completed: 已妥投=已完成(delivered_at IS NOT NULL,财务数据已完整)
 *  新增 all:全部订单(含 ignored 搁置)
 */
function tabCounts() {
  const rows = db
    .prepare(
      `SELECT
        CASE
          WHEN operate_status = 'wait_receiver_confirm' AND delivered_at IS NOT NULL THEN 'completed'
          WHEN operate_status = 'wait_receiver_confirm' AND delivered_at IS NULL THEN 'wait_receiver_confirm'
          ELSE operate_status
        END AS bucket,
        COUNT(*) AS n
       FROM op_package WHERE is_ignored = 0
       GROUP BY bucket`
    )
    .all();
  const map = Object.fromEntries(rows.map((r) => [r.bucket, r.n]));
  const ignored = db
    .prepare(`SELECT COUNT(*) AS n FROM op_package WHERE is_ignored = 1`)
    .get().n;
  const active = (map.wait_process || 0) + (map.wait_ship || 0) + (map.ship_success || 0)
    + (map.wait_receiver_confirm || 0) + (map.completed || 0) + (map.cancelled || 0);
  return {
    all: active + ignored,
    waitProcess: map.wait_process || 0,
    waitShip: map.wait_ship || 0,
    shipSuccess: map.ship_success || 0,
    waitReceiverConfirm: map.wait_receiver_confirm || 0,
    completed: map.completed || 0,
    cancelled: map.cancelled || 0,
    ignored,
  };
}

const TAB_STATUS = {
  waitProcess: ['wait_process'],
  waitShip: ['wait_ship'],
  shipSuccess: ['ship_success'],
  waitReceiverConfirm: ['wait_receiver_confirm'], // 列表查询时再叠加 delivered_at IS NULL
  completed: ['wait_receiver_confirm'],             // 列表查询时再叠加 delivered_at IS NOT NULL
  cancelled: ['cancelled'],
  ignored: null, // is_ignored = 1
  all: null,     // 全部(含 ignored)
};

/**
 * 包裹分页列表(联订单+采购聚合)
 * filters: { tab, keyword, storeId, purchaseStatus, arrived, page, pageSize,
 *            globalKeyword, globalMode }
 *  - purchaseStatus: '' | 'none' | 'purchased'(采购筛选)
 *  - arrived: '' | '0' | '1'(到货筛选,仅提示标记)
 *  - globalKeyword: 全局搜索关键词(跨所有状态,忽略 tab;妙手 appPackageTab=isolation 等价)
 *  - globalMode: 'ss' 模糊(LIKE,默认) | 'eq' 精确(全值)
 *    匹配字段: 订单号(posting_number,即Ozon运单号)/包裹号/平台SKU(offer_id)/SKU/
 *             采购单号/采购物流单号/Ozon运单号
 */
function listPackages(filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 20));
  const where = [];
  const params = [];

  const globalKw = filters.globalKeyword ? String(filters.globalKeyword).trim() : '';
  const globalMode = filters.globalMode === 'eq' ? 'eq' : 'ss';

  if (globalKw) {
    // ── 全局搜索:忽略 tab,跨所有状态(含搁置)检索 7 类单号字段 ──
    where.push('1 = 1');
    const op = globalMode === 'eq' ? '= ?' : 'LIKE ?';
    const val = globalMode === 'eq' ? globalKw : `%${globalKw}%`;
    where.push(`(
      o.posting_number ${op}
      OR p.package_no ${op}
      OR p.logistics_no ${op}
      OR EXISTS (SELECT 1 FROM op_ozon_order_item oi
                 WHERE oi.ozon_order_id = o.id
                   AND (oi.offer_id ${op} OR CAST(oi.sku AS TEXT) ${op}))
      OR EXISTS (SELECT 1 FROM op_purchase_order po
                 JOIN op_purchase_link pl ON pl.purchase_order_id = po.id
                 WHERE pl.package_id = p.id
                   AND (po.purchase_sn ${op} OR po.logistics_no ${op}))
    )`);
    // 7 个占位符:posting_number/package_no/logistics_no/offer_id/sku/purchase_sn/po.logistics_no
    params.push(val, val, val, val, val, val, val);
  } else {
    const tab = filters.tab || 'waitProcess';
    if (tab === 'ignored') {
      where.push('p.is_ignored = 1');
    } else if (tab === 'all') {
      // 全部:不加 is_ignored/operate_status 过滤,涵盖搁置与所有状态
      where.push('1 = 1');
    } else if (tab === 'completed') {
      // 已完成=已妥投:wait_receiver_confirm + delivered_at 有值
      where.push('p.is_ignored = 0');
      where.push("p.operate_status = 'wait_receiver_confirm' AND p.delivered_at IS NOT NULL");
    } else if (tab === 'waitReceiverConfirm') {
      // 已发货=已交运未妥投:wait_receiver_confirm + delivered_at 为空
      where.push('p.is_ignored = 0');
      where.push("p.operate_status = 'wait_receiver_confirm' AND p.delivered_at IS NULL");
    } else {
      where.push('p.is_ignored = 0');
      const sts = TAB_STATUS[tab] || TAB_STATUS.waitProcess;
      where.push(`p.operate_status IN (${sts.map(() => '?').join(',')})`);
      params.push(...sts);
    }
  }
  if (filters.storeId) {
    where.push('o.store_id = ?');
    params.push(filters.storeId);
  }
  if (filters.purchaseStatus === 'none') {
    where.push("p.purchase_status = 'none'");
  } else if (filters.purchaseStatus === 'purchased') {
    where.push("p.purchase_status != 'none'");
  }
  if (filters.arrived === '1') {
    where.push('p.arrived_at IS NOT NULL');
  } else if (filters.arrived === '0') {
    where.push('p.arrived_at IS NULL');
  }
  // 取消发起者筛选(仅 cancelled tab 有意义):前端传 client/ozon/seller
  // 用 cancellation_type(英文枚举)精确匹配,比 cancellation_initiator(俄文)更稳定
  if (filters.cancelInitiator && ['client', 'ozon', 'seller'].includes(filters.cancelInitiator)) {
    where.push(`json_extract(o.cancellation_json, '$.cancellation_type') = ?`);
    params.push(filters.cancelInitiator);
  }
  if (filters.keyword) {
    const kw = `%${filters.keyword.trim()}%`;
    where.push(`(
      o.posting_number LIKE ? OR o.order_number LIKE ? OR p.package_no LIKE ?
      OR o.buyer_name LIKE ?
      OR EXISTS (SELECT 1 FROM op_purchase_order po JOIN op_purchase_link pl ON pl.purchase_order_id = po.id
                 WHERE pl.package_id = p.id AND (po.purchase_sn LIKE ? OR po.logistics_no LIKE ?))
      OR EXISTS (SELECT 1 FROM op_ozon_order_item oi WHERE oi.ozon_order_id = o.id
                 AND (oi.offer_id LIKE ? OR oi.title LIKE ?))
    )`);
    params.push(kw, kw, kw, kw, kw, kw, kw, kw);
  }

  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
    )
    .get(...params).n;

  const rows = db
    .prepare(
      `SELECT p.*, o.posting_number, o.order_number, o.order_id AS ozon_api_order_id, o.parent_posting_number,
              o.status AS ozon_status, o.substatus, o.in_process_at, o.shipment_date, o.delivering_date,
              o.order_amount, o.buyer_name, o.buyer_city, o.delivery_method_name, o.warehouse_name, o.store_id,
              o.cancellation_json
       FROM op_package p
       JOIN op_ozon_order o ON o.id = p.ozon_order_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY o.in_process_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);

  return {
    total,
    page,
    pageSize,
    globalSearch: !!globalKw,   // 前端据此显示"全局搜索"提示条
    globalKeyword: globalKw,
    packages: rows.map(rowToPackage),
  };
}

// 店铺名:store_id → stores.json name(sync 服务注入,避免 DAO 依赖 config)
let _storeNameMap = new Map();
export function setStoreNameMap(map) {
  _storeNameMap = map || new Map();
}

function rowToPackage(r) {
  // 解析 cancellation_json → 结构化字段(便于前端列表展示取消原因)
  // cancellation 对象含:cancellation_type(client/ozon/seller) / cancellation_initiator(俄文)
  //   / cancel_reason_id / cancel_reason / cancelled_after_ship / affect_cancellation_rating
  let cancellation = null;
  if (r.cancellation_json) {
    try { cancellation = JSON.parse(r.cancellation_json); } catch { /* 兼容脏数据 */ }
  }
  return {
    id: r.id,
    packageNo: r.package_no,
    storeId: r.store_id,
    storeName: _storeNameMap.get(r.store_id) || r.store_id,
    postingNumber: r.posting_number,
    orderNumber: r.order_number,
    parentId: r.parent_posting_number,
    // ★ 本地订单 id(p.ozon_order_id 外键,产品行查询键;注意不是 o.order_id 的 Ozon API 数字 id)
    ozonOrderId: r.ozon_order_id,
    ozonApiOrderId: r.ozon_api_order_id,
    ozonStatus: r.ozon_status,
    substatus: r.substatus,
    operateStatus: r.operate_status,
    purchaseStatus: r.purchase_status,
    isShipped: !!r.is_shipped,
    isIgnored: !!r.is_ignored,
    inProcessAt: r.in_process_at,
    shipmentDate: r.shipment_date,
    lastDeliveryAt: r.last_delivery_at,
    deliveredAt: r.delivered_at,
    orderAmount: r.order_amount,
    buyerName: r.buyer_name,
    buyerCity: r.buyer_city,
    deliveryMethod: r.delivery_method_name,
    warehouse: r.warehouse_name,
    logisticsNo: r.logistics_no,
    headLogisticsNo: r.head_logistics_no,
    headLogisticsCompany: r.head_logistics_company,
    arrivedAt: r.arrived_at,
    totalPurchaseAmount: r.total_purchase_amount,
    accrualTotal: r.accrual_total != null ? Number(r.accrual_total) : null,
    accrualSaleTotal: r.accrual_sale_total != null ? Number(r.accrual_sale_total) : null,
    accrualSyncedAt: r.accrual_synced_at,
    waybillPrintedAt: r.waybill_printed_at,
    note: r.note,
    // ─ 取消细分状态(cancellation_json 解析,仅 cancelled 状态订单有) ─
    cancellation,
    cancellationType: cancellation?.cancellation_type || null,        // 'client' | 'ozon' | 'seller'
    cancellationInitiator: cancellation?.cancellation_initiator || null, // 俄文发起者
    cancelReasonId: cancellation?.cancel_reason_id || null,
    cancelReason: cancellation?.cancel_reason || null,                 // 俄文原因描述
    cancelledAfterShip: cancellation?.cancelled_after_ship ?? null,
    affectCancellationRating: cancellation?.affect_cancellation_rating ?? null,
  };
}

/** 批量取产品行(按订单 id 列表)
 *  LEFT JOIN product_data_cache(现有商品缓存,OPI /v3/product/info 同步)
 *  取 Ozon CDN 直链图片:primary_image[0] 优先,images[0] 兜底(均为 ir-20.ozonstatic.cn 直链)
 */
function getItemsByOrderIds(orderIds) {
  if (!orderIds.length) return [];
  const ph = orderIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT oi.*,
              COALESCE(
                json_extract(p.data, '$.primary_image[0]'),
                json_extract(p.data, '$.images[0]')
              ) AS pic_url,
              json_extract(p.data, '$.name') AS cached_name
       FROM op_ozon_order_item oi
       LEFT JOIN product_data_cache p ON p.sku = CAST(oi.sku AS TEXT)
       WHERE oi.ozon_order_id IN (${ph})
       ORDER BY oi.id`
    )
    .all(...orderIds);
  return rows.map((r) => ({
    id: r.id,
    ozonOrderId: r.ozon_order_id,
    sku: r.sku,
    offerId: r.offer_id,
    title: r.cached_name || r.title,
    quantity: r.quantity,
    price: r.price,
    picUrl: r.pic_url || null,
    pdpUrl: r.sku ? `https://ozon.ru/context/detail/id/${r.sku}` : null,
    purchaseAmount: r.purchase_amount,
    purchaseNum: r.purchase_num,
  }));
}

/** 找出某店铺订单产品行中未命中商品缓存的 SKU(同步服务回源用) */
function findUncachedSkus(storeId) {
  return db
    .prepare(
      `SELECT DISTINCT oi.sku FROM op_ozon_order_item oi
       JOIN op_ozon_order o ON o.id = oi.ozon_order_id
       WHERE o.store_id = ? AND oi.sku IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM product_data_cache p WHERE p.sku = CAST(oi.sku AS TEXT))`
    )
    .all(storeId)
    .map((r) => Number(r.sku))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** 批量取采购关联+采购单(按包裹 id 列表) */
function getPurchasesByPackageIds(packageIds) {
  if (!packageIds.length) return { links: [], purchases: [] };
  const ph = packageIds.map(() => '?').join(',');
  const links = db
    .prepare(
      `SELECT pl.*, po.purchase_sn, po.platform, po.status AS po_status, po.payment_amount,
              po.seller_name, po.buyer_account, po.logistics_company AS po_logistics_company,
              po.logistics_no AS po_logistics_no, po.link_status
       FROM op_purchase_link pl
       JOIN op_purchase_order po ON po.id = pl.purchase_order_id
       WHERE pl.package_id IN (${ph})`
    )
    .all(...packageIds);
  return {
    links: links.map((l) => ({
      id: l.id,
      purchaseOrderId: l.purchase_order_id,
      packageId: l.package_id,
      ozonOrderItemId: l.ozon_order_item_id,
      allocatedAmount: l.allocated_amount,
      quantity: l.quantity,
      purchaseSn: l.purchase_sn,
      platform: l.platform,
      poStatus: l.po_status,
      paymentAmount: l.payment_amount,
      sellerName: l.seller_name,
      buyerAccount: l.buyer_account,
      poLogisticsCompany: l.po_logistics_company,
      poLogisticsNo: l.po_logistics_no,
      linkStatus: l.link_status,
    })),
    purchases: [],
  };
}

/** 包裹详情(产品行+采购关联+轨迹) */
function getPackageDetail(packageId) {
  const row = db
    .prepare(
      `SELECT p.*, o.posting_number, o.order_number, o.parent_posting_number, o.status AS ozon_status,
              o.substatus, o.in_process_at, o.shipment_date, o.delivering_date, o.order_amount,
              o.buyer_name, o.buyer_city, o.delivery_method_name, o.warehouse_name, o.store_id,
              o.cancellation_json
       FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id WHERE p.id = ?`
    )
    .get(packageId);
  if (!row) return null;
  const pkg = rowToPackage(row);
  const items = getItemsByOrderIds([row.ozon_order_id]);
  const { links } = getPurchasesByPackageIds([packageId]);
  const traces = db
    .prepare(
      `SELECT t.trace_at, t.description, t.logistics_no, t.company
       FROM op_logistics_trace t
       JOIN op_purchase_link pl ON pl.purchase_order_id = t.purchase_order_id
       WHERE pl.package_id = ?
       ORDER BY t.trace_at DESC LIMIT 50`
    )
    .all(packageId);
  return { package: pkg, items, purchaseLinks: links, traces };
}

// ── 采购录入 ─────────────────────────────────────────────────

/**
 * 提交采购信息(模式B:金额+国内快递单号;模式A:上家单号,P2 实现自动补全)
 * items: [{ itemId, amount, quantity }]
 * 返回 { purchaseOrderId, packageId }
 */
function submitPurchase({
  packageId,
  platform = 'other',
  purchaseSn = null,
  buyerAccount = null,
  sellerName = null,
  paymentAmount = 0,
  logisticsCompany = null,
  logisticsNo = null,
  sendAt = null,
  note = null,
  items = [],
}) {
  const pkg = db.prepare(`SELECT * FROM op_package WHERE id = ?`).get(packageId);
  if (!pkg) throw new Error(`包裹不存在: ${packageId}`);
  if (pkg.operate_status === 'cancelled') throw new Error('包裹已取消,不能提交采购');
  if (pkg.is_ignored) throw new Error('包裹已搁置,请先恢复');

  const now = nowIso();
  // 有国内快递单号 → 采购单视为已发货(上家已发货);否则 wait_send
  const status = logisticsNo ? 'shipped' : 'wait_send';

  const poId = runInTx(() => {
    // 1) upsert 采购单(拼单场景:同采购单号复用,不新建)
    // ON CONFLICT(platform, purchase_sn) DO UPDATE:复用已存在采购单 id
    // payment_amount/goods_amount 用 CASE 保护:新值>0 才覆盖,避免拼单第二次提交时误清零
    // purchase_channel 不在 UPDATE 列表,保留原值(模式A platform_order 不被覆盖成 manual)
    // 边界:platform='other' + purchaseSn=null 时 SQLite NULL 不参与 UNIQUE,每次新建(符合手工单预期)
    const poRes = db
      .prepare(
        `INSERT INTO op_purchase_order (purchase_sn, platform, purchase_channel, buyer_account, seller_name,
            payment_amount, goods_amount, status, pay_at, send_at, logistics_company, logistics_no, note, gmt_create, gmt_modified)
           VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform, purchase_sn) DO UPDATE SET
            buyer_account = COALESCE(excluded.buyer_account, op_purchase_order.buyer_account),
            seller_name = COALESCE(excluded.seller_name, op_purchase_order.seller_name),
            payment_amount = CASE WHEN excluded.payment_amount > 0 THEN excluded.payment_amount ELSE op_purchase_order.payment_amount END,
            goods_amount = CASE WHEN excluded.goods_amount > 0 THEN excluded.goods_amount ELSE op_purchase_order.goods_amount END,
            status = excluded.status,
            send_at = COALESCE(excluded.send_at, op_purchase_order.send_at),
            logistics_company = COALESCE(excluded.logistics_company, op_purchase_order.logistics_company),
            logistics_no = COALESCE(excluded.logistics_no, op_purchase_order.logistics_no),
            note = COALESCE(excluded.note, op_purchase_order.note),
            gmt_modified = excluded.gmt_modified
           RETURNING id`
      )
      .get(
        purchaseSn || null,
        platform,
        buyerAccount,
        sellerName,
        Math.round((Number(paymentAmount) || 0) * 100) / 100,
        Math.round((Number(paymentAmount) || 0) * 100) / 100,
        status,
        now,
        logisticsNo ? sendAt || now : null,
        logisticsCompany,
        logisticsNo,
        note,
        now,
        now
      );
    const poId = Number(poRes?.id ?? db.prepare(`SELECT id FROM op_purchase_order WHERE platform=? AND purchase_sn=?`).get(platform, purchaseSn).id);

    // 2) 建关联(link) + 回写产品行采购金额
    const updItem = db.prepare(
      `UPDATE op_ozon_order_item SET purchase_amount = purchase_amount + ?, purchase_num = purchase_num + ?, gmt_modified = ? WHERE id = ?`
    );
    const insLink = db.prepare(
      `INSERT OR IGNORE INTO op_purchase_link (purchase_order_id, package_id, ozon_order_item_id, allocated_amount, quantity, gmt_create)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    let total = 0;
    for (const it of items) {
      const amount = Math.round((Number(it.amount) || 0) * 100) / 100;
      const qty = Number(it.quantity) || 0;
      if (!it.itemId) continue;
      updItem.run(amount, qty, now, it.itemId);
      insLink.run(poId, packageId, it.itemId, amount, qty, now);
      total += amount;
    }

    // 3) 包裹聚合:采购金额合计 + 采购状态 + 国内物流 + 直接待打单发货
    //    同包裹重复提交=累加(妙手实测为覆盖语义,但个人模式以累加更直观;取消关联可冲回)
    db.prepare(
      `UPDATE op_package SET
        total_purchase_amount = total_purchase_amount + ?,
        head_logistics_no = COALESCE(?, head_logistics_no),
        head_logistics_company = COALESCE(?, head_logistics_company),
        head_shipped_at = COALESCE(?, head_shipped_at),
        purchase_status = 'complete',
        operate_status = CASE WHEN operate_status = 'wait_process' THEN 'wait_ship' ELSE operate_status END,
        gmt_modified = ?
       WHERE id = ?`
    ).run(total, logisticsNo, logisticsCompany, logisticsNo ? sendAt || now : null, now, packageId);

    return poId;
  });

  return { purchaseOrderId: poId, packageId };
}

/** 取消关联:冲回产品行金额 + 删除 link;采购单无剩余关联时置 unlinked */
function unlinkPurchase(purchaseOrderId, packageId) {
  const now = nowIso();
  runInTx(() => {
    const links = db
      .prepare(`SELECT * FROM op_purchase_link WHERE purchase_order_id = ? AND package_id = ?`)
      .all(purchaseOrderId, packageId);
    if (!links.length) throw new Error('该采购单未关联此包裹');
    const updItem = db.prepare(
      `UPDATE op_ozon_order_item SET purchase_amount = MAX(0, purchase_amount - ?), purchase_num = MAX(0, purchase_num - ?), gmt_modified = ? WHERE id = ?`
    );
    let total = 0;
    for (const l of links) {
      updItem.run(l.allocated_amount, l.quantity, now, l.ozon_order_item_id);
      total += l.allocated_amount;
    }
    db.prepare(`DELETE FROM op_purchase_link WHERE purchase_order_id = ? AND package_id = ?`).run(
      purchaseOrderId,
      packageId
    );
    // 重算包裹聚合
    const agg = db
      .prepare(
        `SELECT COALESCE(SUM(allocated_amount), 0) AS total, COUNT(*) AS n
         FROM op_purchase_link WHERE package_id = ?`
      )
      .get(packageId);
    db.prepare(
      `UPDATE op_package SET total_purchase_amount = ?, purchase_status = ?, gmt_modified = ? WHERE id = ?`
    ).run(
      Math.round(agg.total * 100) / 100,
      agg.n > 0 ? 'complete' : 'none',
      now,
      packageId
    );
    // 采购单无剩余关联 → unlinked
    const rest = db
      .prepare(`SELECT COUNT(*) AS n FROM op_purchase_link WHERE purchase_order_id = ?`)
      .get(purchaseOrderId).n;
    if (rest === 0) {
      db.prepare(`UPDATE op_purchase_order SET link_status = 'unlinked', gmt_modified = ? WHERE id = ?`).run(
        now,
        purchaseOrderId
      );
    }
  });
}

/** 退回待处理:仅 wait_ship 可退;取消该包裹全部采购关联(冲回产品行金额/数量)
 *  并重置采购聚合(金额/国内物流/到货标记),回流 wait_process(维持方案A语义:待处理=未采购)
 */
function revertToWaitProcess(packageId) {
  const pkg = db.prepare(`SELECT * FROM op_package WHERE id = ?`).get(packageId);
  if (!pkg) throw new Error(`包裹不存在: ${packageId}`);
  if (pkg.operate_status !== 'wait_ship') {
    throw new Error('仅「待打单发货」状态的包裹可退回待处理');
  }
  const now = nowIso();
  runInTx(() => {
    // 1) 冲回产品行金额/数量,删除该包裹全部关联
    const links = db
      .prepare(`SELECT * FROM op_purchase_link WHERE package_id = ?`)
      .all(packageId);
    const updItem = db.prepare(
      `UPDATE op_ozon_order_item SET purchase_amount = MAX(0, purchase_amount - ?), purchase_num = MAX(0, purchase_num - ?), gmt_modified = ? WHERE id = ?`
    );
    for (const l of links) {
      updItem.run(l.allocated_amount, l.quantity, now, l.ozon_order_item_id);
    }
    db.prepare(`DELETE FROM op_purchase_link WHERE package_id = ?`).run(packageId);
    // 2) 关联的采购单无剩余关联 → unlinked
    for (const poId of new Set(links.map((l) => l.purchase_order_id))) {
      const rest = db
        .prepare(`SELECT COUNT(*) AS n FROM op_purchase_link WHERE purchase_order_id = ?`)
        .get(poId).n;
      if (rest === 0) {
        db.prepare(`UPDATE op_purchase_order SET link_status = 'unlinked', gmt_modified = ? WHERE id = ?`).run(
          now,
          poId
        );
      }
    }
    // 3) 包裹回流 + 重置采购聚合
    db.prepare(
      `UPDATE op_package SET
        operate_status = 'wait_process',
        purchase_status = 'none',
        total_purchase_amount = 0,
        head_logistics_no = NULL,
        head_logistics_company = NULL,
        head_shipped_at = NULL,
        arrived_at = NULL,
        gmt_modified = ?
       WHERE id = ?`
    ).run(now, packageId);
  });
}

/** 搁置/恢复 */
function setIgnored(packageId, ignored) {
  db.prepare(`UPDATE op_package SET is_ignored = ?, gmt_modified = ? WHERE id = ?`).run(
    ignored ? 1 : 0,
    nowIso(),
    packageId
  );
}

/** 标记已打印面单(交运) */
function markWaybillPrinted(packageId) {
  const now = nowIso();
  db.prepare(
    `UPDATE op_package SET waybill_printed_at = ?,
      operate_status = CASE WHEN operate_status IN ('wait_process','wait_ship') THEN 'ship_success' ELSE operate_status END,
      gmt_modified = ?
     WHERE id = ?`
  ).run(now, now, packageId);
}

/** 批量取包裹的 posting_number + store_id(打印 Ozon 面单用) */
function getPackagePostings(packageIds) {
  if (!packageIds.length) return [];
  const ph = packageIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT p.id AS packageId, o.posting_number AS postingNumber, o.store_id AS storeId
       FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id
       WHERE p.id IN (${ph})`
    )
    .all(...packageIds);
}

/** 按采购单号查询已关联包裹(拼单提示用) */
function lookupPurchase(platform, purchaseSn) {
  const po = db
    .prepare(
      `SELECT id, purchase_sn, platform, payment_amount, status
       FROM op_purchase_order WHERE platform = ? AND purchase_sn = ?`
    )
    .get(platform, purchaseSn);
  if (!po) return { exists: false };
  const linkedPackages = db
    .prepare(
      `SELECT pl.package_id, p.package_no, o.posting_number,
              SUM(pl.allocated_amount) AS allocated_amount
       FROM op_purchase_link pl
       JOIN op_package p ON p.id = pl.package_id
       JOIN op_ozon_order o ON o.id = p.ozon_order_id
       WHERE pl.purchase_order_id = ?
       GROUP BY pl.package_id
       ORDER BY pl.package_id`
    )
    .all(po.id);
  return {
    exists: true,
    purchaseOrderId: po.id,
    purchaseSn: po.purchase_sn,
    paymentAmount: po.payment_amount,
    status: po.status,
    linkedPackages,
  };
}

export const orderPackageDao = {
  syncPosting,
  updateSyncCursor,
  getSyncCursors,
  tabCounts,
  listPackages,
  getItemsByOrderIds,
  findUncachedSkus,
  getPurchasesByPackageIds,
  getPackageDetail,
  submitPurchase,
  unlinkPurchase,
  revertToWaitProcess,
  setIgnored,
  markWaybillPrinted,
  getPackagePostings,
  lookupPurchase,
};
