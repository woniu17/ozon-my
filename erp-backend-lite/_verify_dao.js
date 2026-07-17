// DAO 烟雾测试:验证 SQLite DAO 核心路径正确
import { initSchema, db } from './src/db/index.js';
import { createSqliteDaos } from './src/db/dao/sqlite/index.js';

initSchema();

// 清理残留数据,保证计数断言稳定(测试库可安全清空)
const TABLES_TO_CLEAN = [
  'ozon_search_cache', 'ozon_bundle_cache', 'ozon_card_cache', 'ozon_detail_cache',
  'ozon_rich_media_cache', 'ozon_market_stats_cache', 'ozon_follow_sell_cache',
  'ozon_composer_cache', 'ozon_entrypoint_cache',
  'ozon_auto_collect_log', 'ozon_store_classification', 'ozon_store_sku',
  'collect_queue_tasks', 'collect_queue_ops',
];
for (const t of TABLES_TO_CLEAN) {
  db.prepare(`DELETE FROM ${t}`).run();
}
// 重置快照表
db.prepare(`UPDATE collect_queue_snapshot SET pending=0, running=0, success=0, failed=0, syncedAt=NULL, consumePaused=NULL, lastConsumeAt=NULL WHERE id=1`).run();

const daos = await createSqliteDaos();

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log('\n[Test] searchDao');
await daos.searchDao.upsert('SKU001', { name: 'test' });
let r = await daos.searchDao.getBySku('SKU001');
assert(r.data && r.data.name === 'test', 'upsert + getBySku');
assert((await daos.searchDao.estimatedCount()) === 1, 'estimatedCount');
const list = await daos.searchDao.findPagedList('', 1, 10);
assert(list.total === 1 && list.items[0].sku === 'SKU001', 'findPagedList');
const ov = await daos.searchDao.findOverviewList('');
assert(ov.length === 1 && ov[0].sku === 'SKU001', 'findOverviewList');
await daos.searchDao.deleteBySku('SKU001');
assert((await daos.searchDao.estimatedCount()) === 0, 'deleteBySku');

console.log('\n[Test] bundleDao (空属性重验)');
await daos.bundleDao.upsert('SKU002', { attributes: [] }, { bundleId: 'B1' });
r = await daos.bundleDao.getBySku('SKU002');
// 刚写入 attrsEmptyVerifiedAt = now,6h 内不算 stale,数据命中
assert(r.data !== null && r.stale === undefined, '空属性 6h 内 → 命中(非 stale)');
assert((await daos.bundleDao.countEmptyAttrs()) === 1, 'countEmptyAttrs');
// 模拟 7h 前 verifiedAt,应触发 stale
const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
db.prepare(`UPDATE ozon_bundle_cache SET attrsEmptyVerifiedAt = ? WHERE _id = ?`).run(sevenHoursAgo, 'SKU002');
r = await daos.bundleDao.getBySku('SKU002');
assert(r.data === null && r.stale === true, '空属性 7h 后 → stale');
await daos.bundleDao.upsert('SKU003', { attributes: [{ attribute_id: 1, values: [] }] }, {});
r = await daos.bundleDao.getBySku('SKU003');
assert(r.data !== null, '有属性 → 命中');

console.log('\n[Test] autoCollectLogDao ($facet 拆解)');
await daos.autoCollectLogDao.insert({
  sku: 'SKU001',
  source: 'shop-page',
  sellerSlug: 'seller1',
  storeClassified: 'chinese',
  status: 'success',
  results: [
    { type: 'card', hit: true },
    { type: 'detail', hit: false, error: 'timeout' },
  ],
  totalDuration: 1000,
});
const stats = await daos.autoCollectLogDao.aggregateStats({});
assert(stats.total === 1, 'aggregateStats.total');
assert(stats.statusCounts.success === 1, 'statusCounts.success');
assert(stats.typeCounts.card === 1, 'typeCounts.card (json_each 展开)');
assert(stats.typeCounts.detail === 1, 'typeCounts.detail');
assert(stats.sourceCounts['shop-page'] === 1, 'sourceCounts');
assert(stats.storeClassCounts.chinese === 1, 'storeClassCounts');
const logs = await daos.autoCollectLogDao.findPagedList({ sku: 'SKU001' }, 1, 10);
assert(logs.total === 1 && logs.items[0].results.length === 2, 'findPagedList + results 反序列化');
const bySku = await daos.autoCollectLogDao.findBySku('SKU001');
assert(bySku.length === 1, 'findBySku');

console.log('\n[Test] storeClassificationDao (partial unique index)');
await daos.storeClassificationDao.upsertBySlug('seller1', {
  sellerId: 'SID001',
  sellerName: 'Seller One',
  isChinese: true,
  companyInfo: { name: 'Company' },
});
r = await daos.storeClassificationDao.getBySlug('seller1');
assert(r.sellerId === 'SID001' && r.isChinese === true, 'upsert + getBySlug');
assert(r.companyInfo && r.companyInfo.name === 'Company', 'companyInfo JSON 反序列化');
const scList = await daos.storeClassificationDao.findPagedList({ keyword: 'seller' }, 1, 10);
assert(scList.total === 1, 'findPagedList keyword 模糊');
// 测试 sellerId 空字符串不写入(避免违反 partial unique)
await daos.storeClassificationDao.upsertBySlug('seller2', { sellerId: '', sellerName: 'Seller Two' });
r = await daos.storeClassificationDao.getBySlug('seller2');
assert(r.sellerId === null, '空 sellerId 不写入');

console.log('\n[Test] storeSkuDao ($setOnInsert firstSeenAt)');
await daos.storeSkuDao.upsertBySku('SKU100', { sellerId: 'SID001', sellerSlug: 'seller1', sellerName: 'S1' });
let ss = await daos.storeSkuDao.getBySku('SKU100');
assert(ss.firstSeenAt !== null, 'firstSeenAt 首次写入');
const firstSeen = ss.firstSeenAt;
// 二次 upsert,firstSeenAt 不变
await new Promise((r) => setTimeout(r, 10));
await daos.storeSkuDao.upsertBySku('SKU100', { sellerId: 'SID001', sellerSlug: 'seller1' });
ss = await daos.storeSkuDao.getBySku('SKU100');
assert(ss.firstSeenAt === firstSeen, 'firstSeenAt 不被覆盖');
const byStore = await daos.storeSkuDao.findBySellerSlug('seller1');
assert(byStore.length === 1 && byStore[0].sku === 'SKU100', 'findBySellerSlug');

console.log('\n[Test] collectQueueTasksDao (__snapshot__ 拆表)');
await daos.collectQueueTasksDao.submit({
  sku: 'SKU200',
  sellerSlug: 'seller1',
  status: 'pending',
  attempts: 0,
  maxAttempts: 3,
});
let t = await daos.collectQueueTasksDao.getBySku('SKU200');
assert(t && t.status === 'pending', 'submit + getBySku');
// 重复 submit(同 sku),应 upsert 而非新建
await daos.collectQueueTasksDao.submit({
  sku: 'SKU200',
  sellerSlug: 'seller1',
  status: 'running',
  attempts: 1,
  maxAttempts: 3,
});
assert((await daos.collectQueueTasksDao.countList()) === 1, '同 sku submit = upsert');
// createdAt 不被覆盖
t = await daos.collectQueueTasksDao.getBySku('SKU200');
assert(t.createdAt === t.createdAt, 'createdAt 保留');
// 快照
await daos.collectQueueTasksDao.upsertSnapshot({ pending: 5, running: 2, success: 1, failed: 0, consumePaused: true });
const snap = await daos.collectQueueTasksDao.findSnapshot();
assert(snap && snap.pending === 5 && snap.consumePaused === true, 'upsertSnapshot + findSnapshot');
// 聚合状态
const statusCounts = await daos.collectQueueTasksDao.aggregateStatusCounts();
assert(statusCounts.some((s) => s._id === 'running' && s.count === 1), 'aggregateStatusCounts');
// ANTIBOT 查询
await daos.collectQueueTasksDao.updateResult('SKU200', {
  status: 'failed_final',
  finishedAt: new Date().toISOString(),
  lastError: { type: 'ANTIBOT_BLOCKED', msg: 'test' },
});
const since = new Date(Date.now() - 10 * 60 * 1000);
const antibot = await daos.collectQueueTasksDao.findLatestAntibotBlocked(since);
assert(antibot && antibot.lastError.type === 'ANTIBOT_BLOCKED', 'findLatestAntibotBlocked (json_extract)');
// deletePendingAll 不删快照
await daos.collectQueueTasksDao.deletePendingAll();
const snap2 = await daos.collectQueueTasksDao.findSnapshot();
assert(snap2 && snap2.pending === 5, 'deletePendingAll 不影响快照表');

console.log('\n[Test] collectQueueOpsDao (ObjectId → INTEGER)');
const opR = await daos.collectQueueOpsDao.insertOp('retry', 'SKU200');
assert(opR.insertedId > 0, 'insertOp');
const dedup = await daos.collectQueueOpsDao.findDedup('retry', 'SKU200');
assert(dedup && dedup.processed === false, 'findDedup');
const pending = await daos.collectQueueOpsDao.findPendingOps(100);
assert(pending.length === 1, 'findPendingOps');
// markProcessed
const markR = await daos.collectQueueOpsDao.markProcessed(opR.insertedId);
assert(markR.modifiedCount === 1, 'markProcessed');
// 重复标记(幂等)
const markR2 = await daos.collectQueueOpsDao.markProcessed(opR.insertedId);
assert(markR2.modifiedCount === 0, 'markProcessed 幂等');
// 非法 id
const markR3 = await daos.collectQueueOpsDao.markProcessed('abc');
assert(markR3.modifiedCount === 0, 'markProcessed 拒绝非法 id');
// batch insert
await daos.collectQueueOpsDao.insertManyOps([
  { op: 'retry', sku: 'SKU300', params: {}, ts: new Date() },
  { op: 'retry', sku: 'SKU400', params: {}, ts: new Date() },
]);
assert((await daos.collectQueueOpsDao.findPendingOps(100)).length === 2, 'insertManyOps');

console.log(`\n[Result] ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail > 0 ? 1 : 0);
