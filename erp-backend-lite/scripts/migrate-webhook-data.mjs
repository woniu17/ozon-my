// 一次性数据迁移:ozon-webhook 独立库 → erp.db(2026-09-17 webhook 整合,决策②)
// 用法(在 erp-backend-lite 目录下):
//   node --experimental-sqlite scripts/migrate-webhook-data.mjs [源库路径]
// 默认源库:../ozon-webhook/data/ozon-webhook.db
//
// 要点:
//   - INSERT OR IGNORE 幂等,可安全重跑(冲突=已导入过)
//   - 显式列名清单(不用 SELECT *):源库可能经 ALTER 补列(新列追加在表尾),
//     与 erp schema 列序不一致,SELECT * 会导致数据错列
//   - 执行时机:服务器上、切换 nginx 之前、停两个进程后(SQLite 写锁安全)
//   - 执行前先备份:cp data/erp.db data/erp.db.bak-webhook-merge-$(date +%m%d)
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ERP_DB = resolve(__dirname, '..', 'data', 'erp.db');
const DEFAULT_SRC = resolve(__dirname, '..', '..', 'ozon-webhook', 'data', 'ozon-webhook.db');
const SRC = resolve(process.argv[2] || DEFAULT_SRC);

if (!existsSync(SRC)) {
  console.error(`[migrate] 源库不存在: ${SRC}`);
  process.exit(1);
}
if (!existsSync(ERP_DB)) {
  console.error(`[migrate] 目标库不存在(先启动一次 erp 让 initSchema 建表): ${ERP_DB}`);
  process.exit(1);
}

// 7 张表 × 显式列名(与 erp-backend-lite/src/db/schema.sql 迁入段一致)
const TABLES = [
  {
    name: 'ozon_push_events',
    cols: ['id', 'message_type', 'idempotency_key', 'seller_id', 'posting_number', 'product_id', 'sku',
      'chat_id', 'order_number', 'raw_payload', 'status', 'retry_count', 'last_error',
      'received_at', 'processed_at'],
  },
  {
    name: 'ozon_postings',
    cols: ['posting_number', 'seller_id', 'warehouse_id', 'status', 'products_json', 'in_process_at',
      'shipment_date', 'cutoff_date', 'delivery_date_begin', 'delivery_date_end', 'tracking_number',
      'is_express', 'tpl_integration_type', 'cancel_reason_id', 'cancel_reason_message',
      'order_number', 'uuid', 'posting_type', 'creation_date', 'cancel_date', 'raw_count',
      'first_received_at', 'last_received_at', 'sale_amount_cny', 'pickup_at', 'cancel_initiator'],
  },
  {
    name: 'ozon_orders',
    cols: ['order_number', 'order_id', 'seller_id', 'status', 'uuid', 'created_at', 'cancelled_at',
      'updated_at', 'first_received_at', 'last_received_at', 'raw_count'],
  },
  {
    name: 'ozon_stocks_snapshot',
    cols: ['id', 'seller_id', 'product_id', 'sku', 'warehouse_id', 'present', 'reserved',
      'updated_at', 'received_at'],
  },
  {
    name: 'ozon_products_pending_refresh',
    cols: ['product_id', 'seller_id', 'offer_id', 'is_error', 'changed_at', 'received_at', 'consumed_at'],
  },
  {
    name: 'ozon_chat_messages',
    cols: ['id', 'chat_id', 'message_id', 'chat_type', 'seller_id', 'user_id', 'user_type',
      'event_type', 'data_json', 'created_at', 'updated_at', 'last_read_message_id', 'received_at'],
  },
  {
    name: 'ozon_category_tree_refresh_log',
    cols: ['id', 'changed_at', 'received_at', 'consumed_at'],
  },
];

const erp = new DatabaseSync(ERP_DB);
// 路径内单引号转义(ATTACH 字符串字面量)
const attachPath = SRC.replace(/'/g, "''");
erp.exec(`ATTACH DATABASE '${attachPath}' AS wh`);

console.log(`[migrate] 源库: ${SRC}`);
console.log(`[migrate] 目标: ${ERP_DB}\n`);

let failed = false;
for (const t of TABLES) {
  const colList = t.cols.join(', ');
  // 源表可能不存在(理论上不会,防御)
  const srcExists = erp
    .prepare(`SELECT name FROM wh.sqlite_master WHERE type='table' AND name=?`)
    .get(t.name);
  if (!srcExists) {
    console.log(`[skip] ${t.name}: 源库无此表`);
    continue;
  }
  const before = erp.prepare(`SELECT COUNT(*) AS n FROM main.${t.name}`).get().n;
  erp.exec(`INSERT OR IGNORE INTO main.${t.name} (${colList}) SELECT ${colList} FROM wh.${t.name}`);
  const after = erp.prepare(`SELECT COUNT(*) AS n FROM main.${t.name}`).get().n;
  const srcCount = erp.prepare(`SELECT COUNT(*) AS n FROM wh.${t.name}`).get().n;
  const inserted = after - before;
  const ok = after >= srcCount;
  if (!ok) failed = true;
  console.log(
    `[${ok ? 'ok' : 'FAIL'}] ${t.name.padEnd(34)} 源 ${String(srcCount).padStart(6)} / 导入 ${String(inserted).padStart(6)} / 目标现有 ${String(after).padStart(6)}`
  );
}

erp.exec('DETACH DATABASE wh');
erp.close();
console.log(failed ? '\n[migrate] 存在异常,请检查(目标行数 < 源行数)' : '\n[migrate] 全部完成');
process.exit(failed ? 1 : 0);
