// 历史订单操作日志回填(2026-11):把 op_package 上已有的操作时间戳一次性回填到 op_order_log,
// 供安卓/Web 订单详情时间线展示历史操作(采购/入库/打单/交运/到货)。
// 幂等:已存在 (package_id, action) 则跳过,可重复执行。
// 运行: node scripts/backfill-order-log.mjs
import { db } from '../src/db/index.js';

const stmtExists = db.prepare(`SELECT COUNT(*) AS n FROM op_order_log WHERE package_id = ? AND action = ?`);
const stmtInsert = db.prepare(
  `INSERT INTO op_order_log (package_id, posting_number, store_id, action, action_name, result, message, detail, source, operator, ip, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'system', 'backfill', NULL, ?)`
);

const rows = db.prepare(`
  SELECT p.id AS packageId, o.posting_number AS postingNumber, p.store_id AS storeId,
         p.purchase_status AS purchaseStatus, p.stocked_at, p.waybill_printed_at, p.dispatched_at, p.arrived_at,
         (SELECT MIN(pl.gmt_create) FROM op_purchase_link pl WHERE pl.package_id = p.id) AS purchaseAt
    FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id
`).all();

let inserted = 0;
let skipped = 0;
const add = (packageId, postingNumber, storeId, action, actionName, message, time) => {
  if (!time) return;
  if (stmtExists.get(packageId, action).n > 0) {
    skipped++;
    return;
  }
  stmtInsert.run(packageId, postingNumber, storeId, action, actionName, 'success', message, time);
  inserted++;
};

for (const r of rows) {
  if (r.purchaseStatus !== 'none') {
    add(r.packageId, r.postingNumber, r.storeId, 'purchase', '采购', '采购提交(历史回填)', r.purchaseAt);
  }
  add(r.packageId, r.postingNumber, r.storeId, 'ship', '入库', '入库(历史回填)', r.stocked_at);
  add(r.packageId, r.postingNumber, r.storeId, 'print_label', '打印面单', '打印面单(历史回填)', r.waybill_printed_at);
  add(r.packageId, r.postingNumber, r.storeId, 'scan_ship_submit', '扫描打单', '交运(历史回填)', r.dispatched_at);
  add(r.packageId, r.postingNumber, r.storeId, 'arrived', '采购到货', '采购到货(历史回填)', r.arrived_at);
}

console.log(`[backfill-order-log] 完成: 插入 ${inserted} 条, 跳过已存在 ${skipped} 条`);
process.exit(0);