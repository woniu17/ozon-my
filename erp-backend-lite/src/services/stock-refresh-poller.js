// 库存更新任务调度 poller(2026-07)
// 职责:轮询 stock_refresh_tasks(PENDING/RUNNING),对每个 item 调
//   /v2/products/stocks 设置库存 → 更新状态
// 串行处理每个 item,item 间间隔 10s,避免触发 Ozon API 限流
//   (OPI 限制:每 30 秒同商品-仓库只能更新一次)
// 单次最多 100 个 item(OPI /v2/products/stocks 单批上限)
import { db } from '../db/index.js';
import config from '../config/index.js';
import * as opi from './ozon-opi.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 10000;
const FIRST_SCAN_DELAY_MS = 10 * 1000;
const MAX_CONCURRENCY = 1; // 串行处理,降低并发避免 Ozon API 限流
const ITEM_INTERVAL_MS = 10000; // item 间时间间隔,避免连续提交触发 Ozon 限流(每 30s 同商品-仓库只能更新一次)

let timer = null;
let running = false;

// 处理单个 item
async function processItem(item, task) {
  const store = config.loadStores().find((s) => s.id === item.store_id);
  if (!store) {
    failItem(item, task, `店铺不存在: ${item.store_id}`);
    return;
  }
  if (!store.warehouse_id) {
    failItem(item, task, `店铺 ${item.store_id} 未配置 warehouse_id`);
    return;
  }
  // 标记 PROCESSING
  db.prepare(
    `UPDATE stock_refresh_items SET status='PROCESSING', updated_at=datetime('now') WHERE id=?`
  ).run(item.id);
  // 首次执行时更新 task 状态为 RUNNING
  if (task.status === 'PENDING') {
    db.prepare(`UPDATE stock_refresh_tasks SET status='RUNNING' WHERE local_task_id=?`).run(task.local_task_id);
  }

  try {
    // 调 /v2/products/stocks 提交
    const resp = await opi.productStocks(store, [
      {
        offerId: item.offer_id || undefined,
        productId: item.product_id,
        stock: item.stock_value,
      },
    ]);
    // OPI 响应:result 数组,每项含 product_id/offer_id/updated/errors
    const results = Array.isArray(resp?.result) ? resp.result : [];
    const found = results.find(
      (r) => String(r.product_id) === String(item.product_id) ||
             (item.offer_id && String(r.offer_id) === String(item.offer_id))
    );
    const updated = found?.updated === true;
    const errs = Array.isArray(found?.errors) ? found.errors : [];

    db.prepare(
      `UPDATE stock_refresh_items
       SET status=?, opi_result=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(
      updated && errs.length === 0 ? 'SUCCESS' : 'FAILED',
      JSON.stringify(found || resp),
      item.id
    );

    if (updated && errs.length === 0) {
      db.prepare(`UPDATE stock_refresh_tasks SET success_count = success_count + 1 WHERE local_task_id=?`).run(
        task.local_task_id
      );
      logger.info({ itemId: item.id, productId: item.product_id, stock: item.stock_value }, 'stock-refresh 库存更新成功');
    } else {
      db.prepare(`UPDATE stock_refresh_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(
        task.local_task_id
      );
      const errMsg = errs.map((e) => e.message || e.code || JSON.stringify(e)).join('; ');
      db.prepare(`UPDATE stock_refresh_items SET error_message=?, updated_at=datetime('now') WHERE id=?`).run(
        errMsg || 'OPI 未返回 updated=true',
        item.id
      );
      logger.warn({ itemId: item.id, productId: item.product_id, errs }, 'stock-refresh 库存更新失败');
    }
    summarizeTask(task.local_task_id);
  } catch (e) {
    failItem(item, task, e.message || String(e));
  }
}

function failItem(item, task, msg) {
  db.prepare(
    `UPDATE stock_refresh_items SET status='FAILED', error_message=?, updated_at=datetime('now') WHERE id=?`
  ).run(msg, item.id);
  db.prepare(`UPDATE stock_refresh_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(
    task.local_task_id
  );
  logger.warn({ itemId: item.id, err: msg }, 'stock-refresh item 失败');
  summarizeTask(task.local_task_id);
}

// 汇总任务状态:无 PENDING/PROCESSING item 时计算终态
function summarizeTask(localTaskId) {
  const pending = db
    .prepare(`SELECT COUNT(*) as n FROM stock_refresh_items WHERE task_id=? AND status IN ('PENDING','PROCESSING')`)
    .get(localTaskId).n;
  if (pending > 0) return;
  const task = db.prepare(`SELECT * FROM stock_refresh_tasks WHERE local_task_id=?`).get(localTaskId);
  if (!task) return;
  if (['SUCCESS', 'FAILED'].includes(task.status)) return; // 已终态
  let newStatus;
  if (task.success_count > 0 && task.failed_count > 0) newStatus = 'PARTIAL';
  else if (task.success_count > 0) newStatus = 'SUCCESS';
  else newStatus = 'FAILED';
  db.prepare(`UPDATE stock_refresh_tasks SET status=?, completed_at=datetime('now') WHERE local_task_id=?`).run(
    newStatus,
    localTaskId
  );
  logger.info({ localTaskId, status: newStatus, success: task.success_count, failed: task.failed_count }, 'stock-refresh 任务完成');
}

// 扫描一次
async function scanOnce() {
  if (running) return;
  running = true;
  try {
    // 取 PENDING/RUNNING 任务
    const tasks = db
      .prepare(`SELECT * FROM stock_refresh_tasks WHERE status IN ('PENDING','RUNNING') ORDER BY created_at ASC`)
      .all();
    for (const task of tasks) {
      // 取该任务下 PENDING item(最多 MAX_CONCURRENCY)
      const items = db
        .prepare(`SELECT * FROM stock_refresh_items WHERE task_id=? AND status='PENDING' ORDER BY id ASC LIMIT ?`)
        .all(task.local_task_id, MAX_CONCURRENCY);
      if (items.length === 0) continue;
      // 串行处理每个 item,item 间增加时间间隔,避免触发 Ozon API 限流
      for (const it of items) {
        await processItem(it, task);
        await new Promise((r) => setTimeout(r, ITEM_INTERVAL_MS));
      }
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'stock-refresh-poller 扫描异常');
  } finally {
    running = false;
  }
}

export function startStockRefreshPoller() {
  if (timer) return;
  setTimeout(() => {
    scanOnce().catch((e) => logger.warn({ err: e.message }, 'stock-refresh-poller 首次扫描异常'));
    timer = setInterval(() => {
      scanOnce().catch((e) => logger.warn({ err: e.message }, 'stock-refresh-poller 扫描异常'));
    }, POLL_INTERVAL_MS);
    timer.unref();
  }, FIRST_SCAN_DELAY_MS).unref();
  logger.info(
    { intervalMs: POLL_INTERVAL_MS, concurrency: MAX_CONCURRENCY, itemIntervalMs: ITEM_INTERVAL_MS },
    'stock-refresh-poller: 已启动(10s检查,串行处理,item间10s间隔,库存更新调度)'
  );
}

export function stopStockRefreshPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
