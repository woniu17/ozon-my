// 一次性裁剪脚本: 删除 ozon_follow_sell_cache.data 中 sellers[].trackingInfo /
// sellerInfoTracking / informationBtnTracking 三个埋点字段(纯上报标识,无任何消费方)
//
// 背景: 三字段占缓存总体积 ~29%(约 400MB / 1.37GB),是 Ozon modal 接口的埋点上报 key,
//       落库后零读取价值。裁剪后单文档平均 100KB → ~71KB。
//
// 用法:
//   node erp-backend-lite/scripts/trim-follow-sell-tracking.mjs --dry-run        # 预览不写入
//   node erp-backend-lite/scripts/trim-follow-sell-tracking.mjs --limit 10       # 只处理前 10 行(小批量验证)
//   node erp-backend-lite/scripts/trim-follow-sell-tracking.mjs                  # 全量执行
//   node erp-backend-lite/scripts/trim-follow-sell-tracking.mjs --vacuum         # 裁剪后 VACUUM 回收磁盘空间
//                                                                     # (需无其他连接占用,建议停服后执行)
//
// 幂等: 已裁剪过的行(无三字段)自动跳过,可重复执行。
// 内存: 游标分批流式处理(每批 200 行),不整表加载,避免 1.37GB 数据 OOM。
// 注意: 只改 data 列,_id/fetchedAt/l2Synced 不动;分批事务避免 WAL 膨胀。
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'erp.db');
const DRY_RUN = process.argv.includes('--dry-run');
const VACUUM = process.argv.includes('--vacuum');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : null;

const TRACKING_FIELDS = ['trackingInfo', 'sellerInfoTracking', 'informationBtnTracking'];
const BATCH_SIZE = 200;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 10000;'); // ERP 服务可能同时在写,等待而非立即失败

const total = db.prepare(`SELECT COUNT(*) AS n FROM ozon_follow_sell_cache`).get().n;
const scanLimit = LIMIT != null && Number.isFinite(LIMIT) ? LIMIT : total;
console.log(`ozon_follow_sell_cache 共 ${total} 行,本次扫描 ${scanLimit} 行,模式: ${DRY_RUN ? 'DRY-RUN(预览)' : '写入'}`);

let scannedRows = 0; // 扫描的文档数
let trimmedRows = 0; // 实际改写的文档数
let skippedRows = 0; // 无三字段/解析失败,跳过
let trimmedSellers = 0; // 删过字段的 seller 条数
let savedBytes = 0; // 裁剪掉的 JSON 字节数
let firstTrimmedId = null; // 第一个改写文档,收尾抽查用

const updateStmt = db.prepare(`UPDATE ozon_follow_sell_cache SET data = ? WHERE _id = ?`);
const fetchBatch = db.prepare(`SELECT _id, data FROM ozon_follow_sell_cache WHERE _id > ? ORDER BY _id LIMIT ?`);

let cursor = '';
while (scannedRows < scanLimit) {
  const want = Math.min(BATCH_SIZE, scanLimit - scannedRows);
  const rows = fetchBatch.all(cursor, want);
  if (rows.length === 0) break;
  cursor = rows[rows.length - 1]._id;

  const writes = [];
  for (const r of rows) {
    scannedRows++;
    let doc;
    try {
      doc = JSON.parse(r.data);
    } catch {
      skippedRows++; // JSON 损坏的行不碰
      continue;
    }
    if (!Array.isArray(doc?.sellers) || doc.sellers.length === 0) {
      skippedRows++; // no-sellers / 空文档
      continue;
    }
    let docTrimmed = false;
    for (const s of doc.sellers) {
      if (!s || typeof s !== 'object') continue;
      let hit = false;
      for (const f of TRACKING_FIELDS) {
        if (s[f] !== undefined) {
          delete s[f];
          hit = true;
        }
      }
      if (hit) {
        docTrimmed = true;
        trimmedSellers++;
      }
    }
    if (!docTrimmed) {
      skippedRows++;
      continue;
    }
    const next = JSON.stringify(doc);
    savedBytes += r.data.length - next.length;
    trimmedRows++;
    if (firstTrimmedId === null) firstTrimmedId = r._id;
    writes.push({ id: r._id, data: next });
  }

  // 该批事务写入(批内即写即释放,不跨批攒内存)
  if (!DRY_RUN && writes.length > 0) {
    db.exec('BEGIN');
    try {
      for (const w of writes) updateStmt.run(w.data, w.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  if (scannedRows % 2000 === 0 || scannedRows >= scanLimit) {
    console.log(`  进度: ${scannedRows}/${scanLimit} 行扫描,${trimmedRows} 行改写`);
  }
}

console.log('═══ 结果统计 ═══');
console.log(`  扫描文档     : ${scannedRows}`);
console.log(`  改写文档     : ${DRY_RUN ? '(预览) ' : ''}${trimmedRows}`);
console.log(`  跳过文档     : ${skippedRows}(无三字段/空 sellers/JSON 损坏)`);
console.log(`  裁剪 seller 数: ${trimmedSellers}`);
console.log(`  节省体积     : ${(savedBytes / 1024 / 1024).toFixed(1)} MB`);
if (DRY_RUN) {
  console.log('\nDRY-RUN 模式未写入。去掉 --dry-run 执行裁剪。');
} else {
  console.log('\n提示: 数据文件不会自动缩小,需 VACUUM 回收磁盘空间(建议停服后执行):');
  console.log('  node erp-backend-lite/scripts/trim-follow-sell-tracking.mjs --vacuum');
}

// VACUUM 回收磁盘空间(需要独占访问,ERP 服务运行中可能 SQLITE_BUSY)
if (VACUUM && !DRY_RUN) {
  console.log('\n═══ VACUUM 回收磁盘空间 ═══');
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('VACUUM;');
    console.log('  VACUUM 完成');
  } catch (e) {
    console.error(`  VACUUM 失败: ${e.message}(通常因 ERP 服务占用,停服后重跑 --vacuum)`);
  }
}

// 抽查第一个改写后的文档结构,确认三字段已删且其余字段完好
if (!DRY_RUN && firstTrimmedId !== null) {
  const sample = db.prepare(`SELECT _id, data FROM ozon_follow_sell_cache WHERE _id = ?`).get(firstTrimmedId);
  const doc = JSON.parse(sample.data);
  const s0 = doc.sellers[0] || {};
  const leftover = TRACKING_FIELDS.filter((f) => f in s0);
  console.log(`\n═══ 抽查 ${sample._id} ═══`);
  console.log(`  sellers.length = ${doc.sellers.length}, count = ${doc.count}, source = ${doc.source}`);
  console.log(`  seller[0] keys = ${Object.keys(s0).join(', ')}`);
  console.log(`  三字段残留: ${leftover.length === 0 ? '无(OK)' : leftover.join(',') + ' (异常!)'}`);
}

db.close();
console.log('\n完成');
