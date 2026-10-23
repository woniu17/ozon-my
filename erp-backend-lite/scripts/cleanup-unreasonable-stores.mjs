#!/usr/bin/env node
// 一次性清理任务:删除定价不合理的跟卖抽取店铺
//
// 背景:
//   extractSellersToStoreClassification 历史上把跟卖列表里所有店铺都写入
//   ozon_store_classification(当前 46.5 万行)。按「中位数 ±10%」的定价合理性标准,
//   约 69% 的店铺属于低价锚点店/高价影子店,无跟踪价值。
//   同时 cache.js 已上线同标准过滤,后续新采集只写合理店铺;本任务负责清理存量。
//
// 清理规则(按 [0.9, 1.1] × 同组跟卖中位数):
//   保留 - 定价合理:至少在某个跟卖组中价格落在 [0.9, 1.1]×中位数 内
//   保留 - 已有采集 SKU:在 ozon_store_sku / ozon_auto_collect_log /
//          collect_queue_tasks / ozon_shallow_collect_log 中出现过的店铺(即使定价不合理也跳过)
//   删除 - 可评判但不合理、且无采集 SKU 的店铺
//   可选 - --include-unknown 时,同时删除「不在当前跟卖缓存」的历史店铺(无法评判,默认保留)
//
// 用法:
//   node --experimental-sqlite scripts/cleanup-unreasonable-stores.mjs                 # 预览(dry-run)
//   node --experimental-sqlite scripts/cleanup-unreasonable-stores.mjs --execute       # 执行删除
//   node --experimental-sqlite scripts/cleanup-unreasonable-stores.mjs --execute --include-unknown
//   ERP_DATA_DIR=/path/to/data node ...                                               # 指定数据目录
//
// 幂等:已删除的行不在分类表中,重复执行天然幂等,可安全重跑。
// 注意:只清理 ozon_store_classification,不动 legacy 表,也不动任何 SKU/日志表。
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXECUTE = process.argv.includes('--execute');
const INCLUDE_UNKNOWN = process.argv.includes('--include-unknown');
const BATCH_SIZE = 500;

// 与 cache.js 保持一致(可用同一批环境变量覆盖)
const BAND_LOW = Number(process.env.FOLLOW_SELL_PRICE_BAND_LOW ?? 0.9);
const BAND_HIGH = Number(process.env.FOLLOW_SELL_PRICE_BAND_HIGH ?? 1.1);
const MIN_GROUP_SIZE = Number(process.env.FOLLOW_SELL_PRICE_MIN_GROUP_SIZE ?? 3);

const DATA_DIR = process.env.ERP_DATA_DIR || join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'collect.db');

// 价格解析(与 price-watch.js parsePriceText 同口径)
function parsePriceText(raw) {
  if (raw == null) return null;
  const plain = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
  let text = plain(raw);
  if (text == null && typeof raw === 'object') {
    text =
      plain(raw?.cardPrice?.price) ??
      plain(raw?.cardPrice?.text) ??
      plain(raw?.cardPrice) ??
      plain(raw?.text) ??
      plain(raw?.price) ??
      plain(raw?.originalPrice) ??
      '';
  }
  const m = String(text).replace(/[\s  ]/g, '').match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 10000;'); // ERP 服务可能同时在写,等待而非立即失败

console.log(`=== 清理定价不合理的跟卖抽取店铺 ===`);
console.log(`DB:        ${DB_PATH}`);
console.log(`模式:      ${EXECUTE ? 'EXECUTE(写入)' : 'DRY-RUN(预览,不写入)'}`);
console.log(`合理性区间: [${BAND_LOW}, ${BAND_HIGH}] × 同组中位数`);
console.log(`样本下限:  ${MIN_GROUP_SIZE}(有效价格不足不评判)`);
console.log(`清理未知店: ${INCLUDE_UNKNOWN ? '是(不在当前跟卖缓存的历史店也删)' : '否(默认保留)'}`);

// ── 1. 计算合理/可评判店铺集合(流式扫描跟卖缓存,避免整表加载 OOM) ──
console.log('\n[1/4] 扫描跟卖缓存,计算合理价格集合...');
const reasonable = new Set(); // 至少一次定价落在 [LOW, HIGH] 内
const judged = new Set(); // 出现在可评判组(有效价格>=3)中的店铺
let groupCount = 0;
const stmt = db.prepare('SELECT data FROM ozon_follow_sell_cache');
for (const row of stmt.iterate()) {
  let d;
  try {
    d = JSON.parse(row.data);
  } catch {
    continue;
  }
  const sellers = Array.isArray(d?.sellers) ? d.sellers : [];
  if (sellers.length < MIN_GROUP_SIZE) continue;
  const entries = [];
  for (const s of sellers) {
    if (!s?.id || !/^\d+$/.test(String(s.id))) continue;
    const p = parsePriceText(s?.price);
    if (p != null && p > 0) entries.push({ id: String(s.id), p });
  }
  if (entries.length < MIN_GROUP_SIZE) continue;
  groupCount++;
  const sorted = entries.map((x) => x.p).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  if (!(median > 0)) continue;
  for (const x of entries) {
    judged.add(x.id);
    const r = x.p / median;
    if (r >= BAND_LOW && r <= BAND_HIGH) reasonable.add(x.id);
  }
}
console.log(`跟卖组:   ${groupCount}`);
console.log(`可评判店铺: ${judged.size} | 合理店铺: ${reasonable.size} | 不合理店铺: ${judged.size - reasonable.size}`);

// ── 2. 计算「已有采集 SKU」的保护店铺集合 ──
console.log('\n[2/4] 计算已有采集 SKU 的保护店铺集合...');
const protectedSet = new Set();
const PROTECT_TABLES = [
  'ozon_store_sku',
  'ozon_auto_collect_log',
  'collect_queue_tasks',
  'ozon_shallow_collect_log',
];
for (const tbl of PROTECT_TABLES) {
  const rows = db
    .prepare(`SELECT DISTINCT sellerId AS id FROM ${tbl} WHERE sellerId IS NOT NULL AND sellerId != ''`)
    .all();
  for (const r of rows) protectedSet.add(String(r.id));
}
console.log(`保护店铺(有采集SKU): ${protectedSet.size}`);

// ── 3. 扫描店铺分类表,归类 ──
console.log('\n[3/4] 扫描店铺分类表,归类...');
const totalCls = db.prepare('SELECT COUNT(*) AS n FROM ozon_store_classification').get().n;
let keptReasonable = 0;
let keptProtected = 0;
let keptOther = 0;
let delUnreasonable = 0;
let delUnknown = 0;
const samples = [];

const scan = db.prepare("SELECT _id, sellerId, sellerName, sellerSlug, classifiedBy FROM ozon_store_classification");
for (const row of scan.iterate()) {
  if (row.classifiedBy !== 'rule:follow-sell-credentials') {
    keptOther++;
    continue;
  }
  const id = String(row._id || row.sellerId || '');
  if (!id) {
    keptOther++;
    continue;
  }
  if (protectedSet.has(id)) {
    keptProtected++;
    continue;
  }
  if (reasonable.has(id)) {
    keptReasonable++;
    continue;
  }
  if (judged.has(id)) {
    delUnreasonable++;
  } else {
    if (!INCLUDE_UNKNOWN) {
      keptOther++; // 未知店铺默认保留
      continue;
    }
    delUnknown++;
  }
  if (samples.length < 10) {
    samples.push({ id, name: row.sellerName || '', slug: row.sellerSlug || '' });
  }
}
const totalDel = delUnreasonable + delUnknown;
console.log(`分类表总行数: ${totalCls}`);
console.log(`  保留-定价合理:        ${keptReasonable}`);
console.log(`  保留-已有采集SKU:     ${keptProtected}`);
console.log(`  保留-非rule/未知:     ${keptOther}`);
console.log(`  删除-可评判但不合理:  ${delUnreasonable}`);
if (INCLUDE_UNKNOWN) console.log(`  删除-不在缓存的历史店: ${delUnknown}`);
console.log(`  → 合计待删除: ${totalDel} 行`);

if (samples.length) {
  console.log(`\n待删除样例(前 ${samples.length} 条):`);
  for (const s of samples) {
    console.log(`    sellerId=${s.id}  name=${s.name || '-'}  slug=${s.slug || '-'}`);
  }
}

if (!EXECUTE) {
  console.log(`\nDRY-RUN 结束:未写入任何删除。确认无误后加 --execute 执行。`);
  db.close();
  process.exit(0);
}

// ── 4. 分批事务删除 ──
console.log(`\n[4/4] 开始分批删除(${totalDel} 行,batch=${BATCH_SIZE})...`);
const deleteStmt = db.prepare('DELETE FROM ozon_store_classification WHERE _id = ?');
const candidates = [];
const scan2 = db.prepare("SELECT _id, sellerId, classifiedBy FROM ozon_store_classification");
for (const row of scan2.iterate()) {
  if (row.classifiedBy !== 'rule:follow-sell-credentials') continue;
  const id = String(row._id || row.sellerId || '');
  if (!id) continue;
  if (protectedSet.has(id) || reasonable.has(id)) continue;
  if (!judged.has(id) && !INCLUDE_UNKNOWN) continue;
  candidates.push(id);
}
let deleted = 0;
for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
  const batch = candidates.slice(i, i + BATCH_SIZE);
  db.exec('BEGIN');
  try {
    for (const id of batch) deleteStmt.run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  deleted += batch.length;
  console.log(`  已删除 ${deleted}/${totalDel}...`);
}
console.log(`\n清理完成:共删除 ${deleted} 行。`);
console.log(`提示:删除仅影响 ozon_store_classification;SKU/日志等业务表不受影响。`);
db.close();