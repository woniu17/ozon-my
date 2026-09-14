// 采购信息跨机同步 · 差异对比脚本(2026-09)
// 场景:删除/重置某台机器数据库前的安全检查——确认"对方机器"已完整拥有本机的人工操作数据。
//       典型用法:在服务器上执行,传入本地机器的导出文件:
//         node scripts/diff-purchase-sync.mjs purchase-sync-export-xxx.json
//       safe-to-wipe=true(文件中所有包裹/关联服务器都有)才可安全清理本地库。
//
// 检查内容:
//   missingPackages : 文件中有、本机没有的包裹(风险:数据不在本机)
//   missingLinks    : 文件中有、本机没有的采购关联(风险:数据不在本机)★ 删库前必须为 0
//   extraLinks      : 本机有、文件没有的关联(本机后来新增的,仅提示)
//   fieldMismatches : 称重/交运/搁置字段两边不同(仅提示)
//
// 用法:
//   node scripts/diff-purchase-sync.mjs <导出文件.json>
// 退出码:0 = 安全(safe-to-wipe) 1 = 有缺失
import { readFileSync } from 'node:fs';

const fileArg = process.argv[2];
if (!fileArg) {
  console.error('用法: node scripts/diff-purchase-sync.mjs <导出文件.json>');
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
const { diffPurchaseSyncAgainstDb } = await import('../src/db/dao/sqlite/purchase-sync-dao.js');

db.exec('PRAGMA busy_timeout = 10000;');
await initSchema();

const r = diffPurchaseSyncAgainstDb(data);

console.log('═══ 采购信息差异对比(文件 vs 本机数据库)═══');
console.log(`  文件   : ${fileArg}(导出于 ${r.file.exportedAt},机器 ${r.file.machine || '?'})`);
console.log(`  包裹   : ${r.file.packages}`);
console.log(`  ── 缺失(本机没有而文件有)──`);
console.log(`  缺包裹 : ${r.missingPackages.length}`);
for (const x of r.missingPackages.slice(0, 20)) console.log(`    ${x}`);
console.log(`  缺关联 : ${r.missingLinks.length}`);
for (const x of r.missingLinks.slice(0, 20)) console.log(`    ${x}`);
if (r.missingLinks.length > 20) console.log(`    …共 ${r.missingLinks.length} 条`);
console.log(`  ── 本机独有(文件没有,仅提示)──`);
console.log(`  多关联 : ${r.extraLinks.length}`);
for (const x of r.extraLinks.slice(0, 10)) console.log(`    ${x}`);
if (r.extraLinks.length > 10) console.log(`    …共 ${r.extraLinks.length} 条`);
console.log(`  ── 字段差异(仅提示)──`);
console.log(`  不同   : ${r.fieldMismatches.length}`);
for (const x of r.fieldMismatches.slice(0, 20)) console.log(`    ${x}`);

console.log('');
if (r.safeToWipe) {
  console.log('✅ safe-to-wipe:文件中的采购/操作数据本机已完整拥有,可安全清理文件来源机器');
} else {
  console.log('❌ 不安全:文件来源机器仍有本机没有的数据(缺包裹/缺关联),先导入再清理:');
  console.log('   node scripts/import-purchase-sync.mjs ' + fileArg);
}
db.close();
process.exit(r.safeToWipe ? 0 : 1);
