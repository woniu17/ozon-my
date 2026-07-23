// MongoDB 连接(仅保留新表结构对应的集合)
// 缓存集合:ozon_rich_media_cache / ozon_market_stats_cache / ozon_follow_sell_cache
// 其它集合:ozon_auto_collect_log(采集日志)/ ozon_store_classification(店铺分类)/ ozon_store_sku / collect_queue_tasks / collect_queue_ops
// 旧的 search/bundle/card/composer/entrypoint/detail 6 类集合已合并到 SQLite 的 dom/attribute 表,
// Mongo 模式若要启用需先补齐 domDao/attributeDao/indexDao 三个新 DAO 实现。
// .env 配置:MONGO_HOST / MONGO_PORT / MONGO_USERNAME / MONGO_PASSWORD / MONGO_AUTH_SOURCE
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URL =
  `mongodb://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}` +
  `@${process.env.MONGO_HOST}:${process.env.MONGO_PORT}/?authSource=${process.env.MONGO_AUTH_SOURCE}`;
const DB_NAME = 'ozon_erp';

let client = null;
let db = null;

export async function getMongo() {
  if (db) return db;
  client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(DB_NAME);
  await ensureIndexes(db);
  console.log('[mongo] connected to', process.env.MONGO_HOST);
  return db;
}

async function ensureIndexes(db) {
  // 缓存类集合:_id = sku,天然唯一,无需额外索引
  // 无 TTL(永久存储),空属性 6h 重验由应用层判定

  // ozon_auto_collect_log 索引(采集日志,按 sku/status/collectedAt/sellerSlug 查询)
  try {
    const logCol = db.collection('ozon_auto_collect_log');
    await Promise.all([
      logCol.createIndex({ sku: 1, collectedAt: -1 }),
      logCol.createIndex({ status: 1, collectedAt: -1 }),
      logCol.createIndex({ collectedAt: -1 }),
      logCol.createIndex({ sellerSlug: 1, collectedAt: -1 }),
    ]);
  } catch (e) {
    console.warn('[mongo] ensureIndexes auto_collect_log failed:', e.message);
  }

  // ozon_store_classification 索引(店铺分类,按 isMainlandChina/sellerName/lastSeenAt 查询)
  try {
    const clsCol = db.collection('ozon_store_classification');
    // 旧索引使用 sparse: true,但 sparse 只跳过 null/不存在,不跳过空字符串,
    // 多个 sellerId='' 的文档会触发 E11000。改用 partialFilterExpression 只对非空 sellerId 建唯一索引。
    try {
      await clsCol.dropIndex('sellerId_1');
    } catch (_) {
      /* 旧索引可能不存在(首次部署),忽略 */
    }
    await Promise.all([
      clsCol.createIndex({ isMainlandChina: 1 }),
      clsCol.createIndex({ sellerName: 1 }),
      clsCol.createIndex({ lastSeenAt: -1 }),
      clsCol.createIndex(
        { sellerId: 1 },
        { unique: true, partialFilterExpression: { sellerId: { $type: 'string', $gt: '' } } }
      ),
    ]);
  } catch (e) {
    console.warn('[mongo] ensureIndexes store_classification failed:', e.message);
  }

  // ozon_store_sku 索引(SKU-店铺关联,以 SKU 为 _id 一一对应)
  try {
    const storeSkuCol = db.collection('ozon_store_sku');
    await Promise.all([
      storeSkuCol.createIndex({ sellerId: 1, lastSeenAt: -1 }),
      storeSkuCol.createIndex({ sellerId: 1, lastCollectAt: -1 }),
      storeSkuCol.createIndex({ lastCollectAt: -1 }),
    ]);
  } catch (e) {
    console.warn('[mongo] ensureIndexes store_sku failed:', e.message);
  }

  // 采集队列任务镜像(collect_queue_tasks)
  try {
    const taskCol = db.collection('collect_queue_tasks');
    await Promise.all([
      taskCol.createIndex({ sku: 1 }, { unique: true }),
      taskCol.createIndex({ status: 1, nextRetryAt: 1 }),
      taskCol.createIndex({ createdAt: -1 }),
      taskCol.createIndex({ updatedAt: -1 }),
    ]);
  } catch (e) {
    console.warn('[mongo] ensureIndexes collect_queue_tasks failed:', e.message);
  }

  // 采集队列操作指令(collect_queue_ops)
  try {
    const opsCol = db.collection('collect_queue_ops');
    await Promise.all([
      opsCol.createIndex({ processed: 1, ts: 1 }),
      opsCol.createIndex({ ts: -1 }),
      // TTL:已处理 op(processedAt 非 null)7 天后自动删除
      opsCol.createIndex({ processedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }),
      // 支撑 retry/delete op 去重查询
      opsCol.createIndex({ op: 1, sku: 1, processed: 1 }),
    ]);
  } catch (e) {
    console.warn('[mongo] ensureIndexes collect_queue_ops failed:', e.message);
  }
}

// 集合引用(懒加载,首次调用时连接)
// 旧的 searchCache/bundleCache/cardCache/composerCache/entrypointCache/detailCache 6 个引用已移除,
// mongo DAO 入口(createMongoDaos)不再使用它们。
export const cols = {
  richMediaCache: () => getMongo().then((d) => d.collection('ozon_rich_media_cache')),
  marketStatsCache: () => getMongo().then((d) => d.collection('ozon_market_stats_cache')),
  followSellCache: () => getMongo().then((d) => d.collection('ozon_follow_sell_cache')),
  autoCollectLog: () => getMongo().then((d) => d.collection('ozon_auto_collect_log')),
  storeClassification: () => getMongo().then((d) => d.collection('ozon_store_classification')),
  storeSku: () => getMongo().then((d) => d.collection('ozon_store_sku')),
  collectQueueTasks: () => getMongo().then((d) => d.collection('collect_queue_tasks')),
  collectQueueOps: () => getMongo().then((d) => d.collection('collect_queue_ops')),
};
