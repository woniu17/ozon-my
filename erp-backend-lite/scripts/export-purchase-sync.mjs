// 采购信息跨机同步 · 导出脚本(2026-09)
// 场景:服务器不可达期间在本地 ERP 录入的采购/发货/搁置操作,导出为 JSON 文件,
//       拷贝(scp/网盘/U盘)到服务器后用 import-purchase-sync.mjs 合并入库。
//
// 导出范围(全量,不挑时间窗,防漏):所有带人工操作痕迹的包裹
//   - 有采购关联(op_purchase_link)
//   - 有称重(weight)
//   - 已交运(waybill_printed_at)
//   - 已搁置(is_ignored)
//
// 用法:
//   node scripts/export-purchase-sync.mjs                    # 导出到 data/purchase-sync-export-<时间戳>.json
//   node scripts/export-purchase-sync.mjs --out /tmp/a.json  # 指定输出路径
//
// 副作用:记录 app_config purchase_sync.last_export_at + mode=secondary
//        (订单处理页"待导出"徽标从此激活,提示有未导出的变更)
// 安全:只读业务表;ERP 服务运行中可执行(WAL + busy_timeout)
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outIdx = process.argv.indexOf('--out');
const OUT_PATH =
  outIdx > -1 ? process.argv[outIdx + 1] : null;

const { db, initSchema } = await import('../src/db/index.js');
const { exportPurchaseSyncData, markExported } = await import(
  '../src/db/dao/sqlite/purchase-sync-dao.js'
);

db.exec('PRAGMA busy_timeout = 10000;'); // ERP 服务可能同时在写,等待而非立即失败
await initSchema(); // 幂等:补齐 sync_uuid 等新列(服务未重启过也能跑)

const data = exportPurchaseSyncData({ machine: os.hostname() });
const purchaseCount = data.packages.reduce((s, p) => s + p.purchases.length, 0);
const linkCount = data.packages.reduce(
  (s, p) => s + p.purchases.reduce((x, q) => x + q.links.length, 0),
  0
);

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const out = OUT_PATH || join(__dirname, '..', 'data', `purchase-sync-export-${ts}.json`);
writeFileSync(out, JSON.stringify(data, null, 2), 'utf-8');
markExported();

console.log('═══ 采购信息导出完成 ═══');
console.log(`  包裹     : ${data.packages.length}`);
console.log(`  采购单   : ${purchaseCount}(含拼单重复计数)`);
console.log(`  关联明细 : ${linkCount}`);
console.log(`  文件     : ${out}`);
console.log(`  下一步   : 拷贝到目标机器后执行`);
console.log(`             node scripts/import-purchase-sync.mjs <该文件>`);
db.close();
