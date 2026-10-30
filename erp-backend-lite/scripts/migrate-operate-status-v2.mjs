#!/usr/bin/env node
// 订单处理流程重构(2026-11):operate_status 4段式 → 新状态机 数据迁移
//
// 新流程:待采购 → 待备货 → 待贴单 → 待发运 → 交运中 → 已揽收 → 已签收 → 已成功(+ 已取消/已退货)
// 旧值 → 新值:
//   wait_ship                  → wait_stock(待备货)
//   ship_success               → dispatching(交运中)
//   wait_receiver_confirm      → 按 is_returned/delivered_at/应计(67)拆分:
//                                  is_returned=1         → returned(已退货)
//                                  delivered_at 非空+67   → settled(已成功)
//                                  delivered_at 非空      → signed(已签收)
//                                  其余                   → delivering(已揽收)
//
// 运行:node --experimental-sqlite scripts/migrate-operate-status-v2.mjs
// 前置:建议先备份(scripts/backup-sqlite-daily.sh 或手动复制 data/erp.db)
import { db } from '../src/db/index.js';

function countByStatus() {
  const rows = db.prepare(`SELECT operate_status AS s, COUNT(*) AS n FROM op_package GROUP BY s`).all();
  const map = {};
  for (const r of rows) map[r.s] = r.n;
  return map;
}

function migrate() {
  const before = countByStatus();
  console.log('迁移前 operate_status 分布:');
  console.table(before);

  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    // 1) 旧 4 段式 → 新状态
    const r1 = db
      .prepare(`UPDATE op_package SET operate_status = 'wait_stock', gmt_modified = ? WHERE operate_status = 'wait_ship'`)
      .run(now);
    const r2 = db
      .prepare(`UPDATE op_package SET operate_status = 'dispatching', gmt_modified = ? WHERE operate_status = 'ship_success'`)
      .run(now);

    // 2) wait_receiver_confirm 拆分(顺序关键:returned → settled → signed → delivering)
    const r3 = db
      .prepare(`UPDATE op_package SET operate_status = 'returned', gmt_modified = ?
                WHERE operate_status = 'wait_receiver_confirm' AND is_returned = 1`)
      .run(now);
    const r4 = db
      .prepare(`UPDATE op_package SET operate_status = 'settled', gmt_modified = ?
                WHERE operate_status = 'wait_receiver_confirm'
                  AND delivered_at IS NOT NULL
                  AND id IN (SELECT package_id FROM op_accrual WHERE type_id = 67)`)
      .run(now);
    const r5 = db
      .prepare(`UPDATE op_package SET operate_status = 'signed', gmt_modified = ?
                WHERE operate_status = 'wait_receiver_confirm' AND delivered_at IS NOT NULL`)
      .run(now);
    const r6 = db
      .prepare(`UPDATE op_package SET operate_status = 'delivering', gmt_modified = ?
                WHERE operate_status = 'wait_receiver_confirm'`)
      .run(now);

    db.exec('COMMIT');
    console.log(`迁移完成:wait_ship→wait_stock ${r1.changes} 行, ship_success→dispatching ${r2.changes} 行,`);
    console.log(`  wait_receiver_confirm→returned ${r3.changes} 行, →settled ${r4.changes} 行, →signed ${r5.changes} 行, →delivering ${r6.changes} 行`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    console.error('迁移失败,已回滚:', e?.message || e);
    process.exit(1);
  }

  const after = countByStatus();
  console.log('迁移后 operate_status 分布:');
  console.table(after);

  // 校验:旧状态应清零
  const leftover = ['wait_ship', 'ship_success', 'wait_receiver_confirm'].filter((s) => (after[s] || 0) > 0);
  if (leftover.length) {
    console.error(`警告:仍有旧状态残留 ${leftover.join(',')} = ${leftover.map((s) => after[s]).join('/')}`);
    process.exit(2);
  }
  console.log('迁移校验通过:无旧状态残留');
}

migrate();