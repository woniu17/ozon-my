// MongoDB 连接(缓存集合:ozon_search_cache / ozon_bundle_cache / ozon_card_cache / ozon_composer_cache / ozon_entrypoint_cache / ozon_detail_cache / ozon_market_stats_cache / ozon_follow_sell_cache)
// 其它集合:ozon_auto_collect_log(采集日志)/ ozon_store_classification(店铺分类)
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

  // ozon_store_classification 索引(店铺分类,按 isChinese/sellerName/lastSeenAt 查询)
  try {
    const clsCol = db.collection('ozon_store_classification');
    await Promise.all([
      clsCol.createIndex({ isChinese: 1 }),
      clsCol.createIndex({ sellerName: 1 }),
      clsCol.createIndex({ lastSeenAt: -1 }),
    ]);
  } catch (e) {
    console.warn('[mongo] ensureIndexes store_classification failed:', e.message);
  }
}

// 集合引用(懒加载,首次调用时连接)
export const cols = {
  searchCache: () => getMongo().then((d) => d.collection('ozon_search_cache')),
  bundleCache: () => getMongo().then((d) => d.collection('ozon_bundle_cache')),
  cardCache: () => getMongo().then((d) => d.collection('ozon_card_cache')),
  composerCache: () => getMongo().then((d) => d.collection('ozon_composer_cache')),
  entrypointCache: () => getMongo().then((d) => d.collection('ozon_entrypoint_cache')),
  detailCache: () => getMongo().then((d) => d.collection('ozon_detail_cache')),
  marketStatsCache: () => getMongo().then((d) => d.collection('ozon_market_stats_cache')),
  followSellCache: () => getMongo().then((d) => d.collection('ozon_follow_sell_cache')),
  autoCollectLog: () => getMongo().then((d) => d.collection('ozon_auto_collect_log')),
  storeClassification: () => getMongo().then((d) => d.collection('ozon_store_classification')),
};
