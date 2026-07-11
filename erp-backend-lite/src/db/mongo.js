// MongoDB 连接(缓存集合:ozon_search_cache / ozon_bundle_cache / ozon_pdp_cache / ozon_composer_cache / ozon_entrypoint_cache / ozon_dynamic_cache)
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
  // _id = sku,天然唯一,无需额外索引
  // 无 TTL(永久存储),空属性 6h 重验由应用层判定
}

// 集合引用(懒加载,首次调用时连接)
export const cols = {
  searchCache: () => getMongo().then((d) => d.collection('ozon_search_cache')),
  bundleCache: () => getMongo().then((d) => d.collection('ozon_bundle_cache')),
  pdpCache: () => getMongo().then((d) => d.collection('ozon_pdp_cache')),
  composerCache: () => getMongo().then((d) => d.collection('ozon_composer_cache')),
  entrypointCache: () => getMongo().then((d) => d.collection('ozon_entrypoint_cache')),
  dynamicCache: () => getMongo().then((d) => d.collection('ozon_dynamic_cache')),
};
