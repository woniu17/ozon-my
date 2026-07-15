import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../../erp-backend-lite/.env') });

const url =
  `mongodb://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}` +
  `@${process.env.MONGO_HOST}:${process.env.MONGO_PORT}/?authSource=${process.env.MONGO_AUTH_SOURCE}`;

const c = new MongoClient(url);
await c.connect();
const db = c.db('ozon_erp');

const tasks = await db.collection('collect_queue_tasks').find({}).sort({ _id: -1 }).limit(3).toArray();
console.log('--- TASKS ---');
for (const t of tasks) {
  console.log({
    sku: t.sku,
    status: t.status,
    attempts: t.attempts,
    error: t.error,
    reason: t.reason,
    steps: t.steps,
    lastError: t.lastError,
    history: t.history,
  });
}

const logs = await db.collection('ozon_auto_collect_log').find({}).sort({ _id: -1 }).limit(3).toArray();
console.log('--- LOGS (FULL) ---');
for (const l of logs) {
  console.log(JSON.stringify(l, null, 2));
}

const failedTasks = await db
  .collection('collect_queue_tasks')
  .find({ status: { $in: ['failed_final', 'failed_partial', 'failed_retry'] } })
  .sort({ _id: -1 })
  .limit(3)
  .toArray();
console.log('--- FAILED TASKS (FULL) ---');
for (const t of failedTasks) {
  console.log(JSON.stringify(t, null, 2));
}

const cardCount = await db.collection('ozon_card_cache').countDocuments({});
console.log('--- CACHE COUNTS ---');
console.log({ card: cardCount });

await c.close();
