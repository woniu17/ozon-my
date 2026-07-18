// 库存自动同步定时任务
// 周期性扫描已 imported 但未设库存的 follow_sell_task_items,调 OPI /v2/products/stocks 设置库存。
//
// 规则:
//   - 每 5 分钟扫描一次
//   - 仅处理 status='imported' AND stock_set=0 AND stock_attempts < 5 的 items
//   - 串行处理(避免 OPI 限流:每分钟 80 请求、每 30 秒同商品-仓库一次)
//   - 商品需变 price_sent 后才能设库存,故刚 imported 的可能返回 errors,需重试
//   - stock_attempts ≥ 5(约 25 分钟)后放弃,标 stock_set=2 不再处理
//
// 关联:
//   - 与 import-status-poller.js 解耦:poller 负责 upsert items 状态,本任务负责设库存
//   - 库存值取自 follow_sell_tasks.stock_snapshot(任务创建时快照,模板修改不影响)
//   - 仓库取自 store.warehouse_id
import { db } from '../db/index.js';
import config from '../config/index.js';
import * as opi from './ozon-opi.js';
import logger from '../middleware/log.js';

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
const MAX_ATTEMPTS = 5; // 失败重试上限(约 25 分钟)
const BATCH_SIZE = 100; // OPI /v2/products/stocks 单批上限

// 单次扫描:返回 { scanned, synced, failed, skipped }
async function scanOnce() {
  // 联表查询:找出所有 imported 且 stock_set=0 且 attempts < 5 的 items
  // JOIN follow_sell_tasks 拿 store_id 和 stock_snapshot
  const rows = db
    .prepare(
      `SELECT ti.id AS item_id, ti.local_task_id, ti.offer_id, ti.product_id, ti.stock_attempts,
              t.store_id, t.stock_snapshot, t.local_task_id AS task_id
       FROM follow_sell_task_items ti
       JOIN follow_sell_tasks t ON ti.local_task_id = t.local_task_id
       WHERE ti.status='imported'
         AND ti.stock_set = 0
         AND ti.stock_attempts < ${MAX_ATTEMPTS}
         AND t.stock_snapshot > 0
         AND ti.product_id IS NOT NULL
         AND ti.product_id != ''`
    )
    .all();

  if (rows.length === 0) {
    return { scanned: 0, synced: 0, failed: 0, skipped: 0 };
  }

  logger.info({ scanned: rows.length }, 'stock-sync: 扫描到待设库存 items');

  const stores = config.loadStores();
  let synced = 0;
  let failed = 0;
  let skipped = 0;

  // 按 store_id 分组(OPI 调用按 store 鉴权 + warehouse_id 也是 store 级)
  // 同一 store 内批量设库存
  const byStore = new Map();
  for (const r of rows) {
    if (!byStore.has(r.store_id)) byStore.set(r.store_id, []);
    byStore.get(r.store_id).push(r);
  }

  for (const [storeId, items] of byStore) {
    const store = stores.find((s) => s.id === storeId);
    if (!store) {
      logger.warn({ storeId, n: items.length }, 'stock-sync: store 不存在,跳过');
      skipped += items.length;
      continue;
    }
    if (!store.warehouse_id) {
      logger.warn({ storeId, n: items.length }, 'stock-sync: store.warehouse_id 未配置,跳过');
      skipped += items.length;
      continue;
    }

    // 同一 store 的 items 共享 stock_snapshot(任务级快照,按任务分组更准确)
    // 按 local_task_id 分组(每个任务的 stock_snapshot 可能不同)
    const byTask = new Map();
    for (const it of items) {
      if (!byTask.has(it.task_id)) byTask.set(it.task_id, []);
      byTask.get(it.task_id).push(it);
    }

    for (const [taskId, taskItems] of byTask) {
      const stockSnapshot = taskItems[0].stock_snapshot;
      try {
        // 按 BATCH_SIZE 分批调 OPI
        for (let i = 0; i < taskItems.length; i += BATCH_SIZE) {
          const batch = taskItems.slice(i, i + BATCH_SIZE);
          const opiItems = batch.map((b) => ({
            offerId: b.offer_id,
            productId: b.product_id,
            stock: stockSnapshot,
          }));

          const r = await opi.productStocks(store, opiItems);
          const results = Array.isArray(r?.result) ? r.result : [];

          // 按 offer_id 建立响应索引(OPI 响应顺序与请求顺序不保证一致)
          const respMap = new Map();
          for (const rr of results) {
            if (rr.offer_id) respMap.set(String(rr.offer_id), rr);
          }

          for (const b of batch) {
            const resp = respMap.get(String(b.offer_id));
            const updated = resp?.updated === true;
            const errs = Array.isArray(resp?.errors) ? resp.errors : [];
            if (updated && errs.length === 0) {
              db.prepare(
                `UPDATE follow_sell_task_items SET stock_set=1, updated_at=datetime('now') WHERE id=?`
              ).run(b.item_id);
              synced++;
            } else {
              // 失败:attempts+1,若达上限标 stock_set=2 放弃
              const newAttempts = (b.stock_attempts || 0) + 1;
              const giveUp = newAttempts >= MAX_ATTEMPTS ? 2 : 0;
              db.prepare(
                `UPDATE follow_sell_task_items
                 SET stock_attempts=?, stock_set=?, updated_at=datetime('now')
                 WHERE id=?`
              ).run(newAttempts, giveUp, b.item_id);
              failed++;
              if (giveUp === 2) {
                logger.warn(
                  { itemId: b.item_id, offerId: b.offer_id, attempts: newAttempts, errs },
                  'stock-sync: 重试达上限,放弃'
                );
              }
            }
          }
        }
      } catch (e) {
        // 整批调用失败(网络/OPI 500 等):attempts+1,不放弃,等下次重试
        logger.warn(
          { taskId, storeId, n: taskItems.length, err: e.message },
          'stock-sync: productStocks 调用失败,本次跳过等下次重试'
        );
        for (const b of taskItems) {
          const newAttempts = (b.stock_attempts || 0) + 1;
          const giveUp = newAttempts >= MAX_ATTEMPTS ? 2 : 0;
          db.prepare(
            `UPDATE follow_sell_task_items
             SET stock_attempts=?, stock_set=?, updated_at=datetime('now')
             WHERE id=?`
          ).run(newAttempts, giveUp, b.item_id);
          failed++;
        }
      }
    }
  }

  return { scanned: rows.length, synced, failed, skipped };
}

let timer = null;

export function startStockSync() {
  if (timer) return;
  // 启动后 1 分钟做首次扫描(错开 import-status-poller 的 30 秒首次扫描)
  // 让 import-status-poller 先把 items 状态拉到最新,本任务再读 items 表设库存
  setTimeout(() => {
    scanOnce().catch((e) => logger.warn({ err: e.message }, 'stock-sync 首次扫描异常'));
    timer = setInterval(() => {
      scanOnce().catch((e) => logger.warn({ err: e.message }, 'stock-sync 扫描异常'));
    }, SYNC_INTERVAL_MS);
    timer.unref();
  }, 60 * 1000).unref();
  logger.info(
    { intervalMin: SYNC_INTERVAL_MS / 60000, maxAttempts: MAX_ATTEMPTS },
    'stock-sync: 已启动(5分钟扫描一次,失败重试5次后放弃)'
  );
}

export function stopStockSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
