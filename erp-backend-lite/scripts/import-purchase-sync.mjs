// 采购信息跨机同步 · 导入脚本(2026-09)
// 场景:把 export-purchase-sync.mjs 生成的 JSON 文件合并进本机数据库
//       (通常在服务器上执行,合并本地机器离线期间的录入)
//
// 合并语义(叠加合并,幂等,重复导入安全):
//   - 采购单:按 (platform, purchase_sn) 或 sync_uuid 判重;已存在只补空缺字段,不覆盖
//   - 采购关联:按 (采购单 + 包裹 + 产品行) 判重;已存在跳过(金额不同记冲突),不存在才插入
//   - 聚合金额:由关联行 SUM 绝对重算,不会重复累计
//   - 称重/交运:本机为空回填;两边都有且不同 → 文件较新才覆盖,否则记冲突
//   - 搁置:按文件目标状态设置(文件较新才覆盖,否则记冲突)
//   - 包裹不存在:跳过并提示(先同步 Ozon 订单再导入)
//
// 用法:
//   node scripts/import-purchase-sync.mjs <文件> --dry-run   # 预览(不落库)
//   node scripts/import-purchase-sync.mjs <文件>             # 正式导入
//
// 输出:终端报告 + data/purchase-sync-import-report-<时间戳>.json(冲突明细留档)
// 安全:整个导入在单事务内,单包裹失败只回滚该包裹;--dry-run 全量回滚
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const fileArg = process.argv.find((a) => !a.startsWith('--') && a !== process.argv[1]);
if (!fileArg) {
  console.error('用法: node scripts/import-purchase-sync.mjs <导出文件.json> [--dry-run]');
  process.exit(2);
}

let data;
try {
  data = JSON.parse(readFileSync(fileArg, 'utf-8'));
} catch (e) {
  console.error(`读取/解析文件失败: ${e.message}`);
  process.exit(2);
}

const { db, initSchema } = await import('../src/db/index.js');
const { importPurchaseSyncData } = await import('../src/db/dao/sqlite/purchase-sync-dao.js');

db.exec('PRAGMA busy_timeout = 10000;');
await initSchema(); // 幂等:补齐 sync_uuid 等新列

const report = importPurchaseSyncData(data, { dryRun: DRY_RUN });

// 报告落盘(冲突/错误明细留档,dry-run 也写,便于检查)
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const reportPath = join(__dirname, '..', 'data', `purchase-sync-import-report-${ts}.json`);
writeFileSync(reportPath, JSON.stringify({ ...report, sourceFile: fileArg }, null, 2), 'utf-8');

const a = report.applied;
const s = report.skipped;
console.log('═══ 采购信息导入' + (DRY_RUN ? '(DRY-RUN 预览,未落库)' : '完成') + ' ═══');
console.log(`  文件       : ${fileArg}(导出于 ${report.file.exportedAt},机器 ${report.file.machine || '?'})`);
console.log(`  包裹       : ${report.file.packages}`);
console.log(`  ── 应用 ──`);
console.log(`  新增采购单 : ${a.purchases}  更新采购单(补空缺): ${a.purchaseUpdates}`);
console.log(`  新增关联   : ${a.links}`);
console.log(`  称重回填   : ${a.weights}  交运回填: ${a.waybills}  搁置更新: ${a.ignores}`);
console.log(`  ── 跳过 ──`);
console.log(`  已存在关联 : ${s.links}  缺包裹: ${s.packages}  缺产品行: ${s.items}`);
console.log(`  ── 冲突/错误 ──`);
console.log(`  冲突       : ${report.conflicts.length}  错误: ${report.errors.length}`);
for (const c of report.conflicts.slice(0, 20)) {
  console.log(`    [${c.type}] ${c.detail}`);
}
if (report.conflicts.length > 20) console.log(`    …共 ${report.conflicts.length} 条,详见报告文件`);
for (const e of report.errors.slice(0, 10)) {
  console.log(`    [error] ${e}`);
}
console.log(`  报告文件   : ${reportPath}`);
if (s.packages > 0) {
  console.log(`\n提示: 有 ${s.packages} 个包裹本机不存在,先在本机执行「同步订单」拉取 Ozon 订单后重导`);
}
if (DRY_RUN) {
  console.log('\nDRY-RUN 未写入。去掉 --dry-run 正式导入。');
}
db.close();
