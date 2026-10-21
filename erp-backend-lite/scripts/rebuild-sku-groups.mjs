// 采集箱同款分组重建脚本
// ─────────────────────────────────────────────
// 用途:基于 ozon_follow_sell_cache(跟卖关系)重建 ozon_cache_index.group_id / group_rep,
//       使采集箱"合并同款"功能生效。可手动执行,也可由 cron / 定时任务周期调用。
// 用法:
//   node --experimental-sqlite scripts/rebuild-sku-groups.mjs          # dry-run,只统计不写库
//   node --experimental-sqlite scripts/rebuild-sku-groups.mjs --apply  # 实际写库
// 输出:JSON 统计(分组数/涉及SKU/隐藏数/已写行数)
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildSkuGroups } from '../src/modules/sku-groups.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'collect.db');

const apply = process.argv.includes('--apply');
const db = new DatabaseSync(dbPath, { readOnly: !apply });

const stats = rebuildSkuGroups(db, { apply });
console.log(JSON.stringify(stats, null, 2));
console.log(apply ? '✅ 已写库' : '⚠️ dry-run,未写库(加 --apply 实际写入)');

db.close();