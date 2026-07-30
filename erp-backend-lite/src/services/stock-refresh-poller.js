// 库存更新任务调度 poller(2026-07)
// 职责:轮询 stock_refresh_tasks(PENDING/RUNNING),按店铺分组批量调
//   /v2/products/stocks 设置库存 → 更新状态
// 批量提交:同店铺 item 合并到一个 OPI 请求(最多 100 组/请求,符合官方建议)
//   不同商品-仓库组合不触发 30s 限制,无需 item 间间隔
//   请求间 1s 间隔,每分钟≤60 请求 < 80 上限
import { db } from '../db/index.js';
import config from '../config/index.js';
import * as opi from './ozon-opi.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 5000;
const FIRST_SCAN_DELAY_MS = 5 * 1000;
const MAX_BATCH_SIZE = 100; // OPI /v2/products/stocks 单批上限 100 组商品-仓库
const REQUEST_INTERVAL_MS = 1000; // 请求间间隔,每分钟≤60 请求 < 80 上限

let timer = null;
let running = false;

// 批量处理同店铺的一组 items(≤100 个)
async function processBatch(items, task) {
  const storeId = items[0].store_id;
  const store = config.loadStores().find((s) => s.id === storeId);
  if (!store) {
    for (const it of items) failItem(it, task, `店铺不存在: ${storeId}`);
    return;
  }
  if (!store.warehouse_id) {
    for (const it of items) failItem(it, task, `店铺 ${storeId} 未配置 warehouse_id`);
    return;
  }

  // 标记所有 item 为 PROCESSING
  const stmtProc = db.prepare(
    `UPDATE stock_refresh_items SET status='PROCESSING', updated_at=datetime('now') WHERE id=?`
  );
  for (const it of items) stmtProc.run(it.id);

  // 首次执行时更新 task 状态为 RUNNING
  if (task.status === 'PENDING') {
    db.prepare(`UPDATE stock_refresh_tasks SET status='RUNNING' WHERE local_task_id=?`).run(task.local_task_id);
  }

  try {
    // 构造 OPI 请求(最多 MAX_BATCH_SIZE 组)
    const opiItems = items.slice(0, MAX_BATCH_SIZE).map((it) => ({
      offerId: it.offer_id || undefined,
      productId: it.product_id,
      stock: it.stock_value,
    }));
    const resp = await opi.productStocks(store, opiItems);

    // 解析响应:result 数组,每项含 product_id/offer_id/updated/errors
    const results = Array.isArray(resp?.result) ? resp.result : [];

    const stmtUpd = db.prepare(
      `UPDATE stock_refresh_items
       SET status=?, opi_result=?, error_message=?, updated_at=datetime('now')
       WHERE id=?`
    );
    const stmtIncSuccess = db.prepare(
      `UPDATE stock_refresh_tasks SET success_count = success_count + 1 WHERE local_task_id=?`
    );
    const stmtIncFailed = db.prepare(
      `UPDATE stock_refresh_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`
    );

    for (const it of items) {
      const found = results.find(
        (r) => String(r.product_id) === String(it.product_id) ||
               (it.offer_id && String(r.offer_id) === String(it.offer_id))
      );
      const updated = found?.updated === true;
      const errs = Array.isArray(found?.errors) ? found.errors : [];
      const isSuccess = updated && errs.length === 0;
      const errMsg = errs.length > 0
        ? errs.map((e) => e.message || e.code || JSON.stringify(e)).join('; ')
        : (isSuccess ? null : 'OPI 未返回 updated=true');

      stmtUpd.run(
        isSuccess ? 'SUCCESS' : 'FAILED',
        JSON.stringify(found || resp),
        errMsg,
        it.id
      );
      if (isSuccess) {
        stmtIncSuccess.run(task.local_task_id);
      } else {
        stmtIncFailed.run(task.local_task_id);
      }
    }
    logger.info(
      { localTaskId: task.local_task_id, storeId, batchCount: items.length, resultCount: results.length },
      'stock-refresh 批量提交完成'
    );
    summarizeTask(task.local_task_id);
  } catch (e) {
    // 整个请求异常(网络/超时等),所有 item 标记 FAILED
    for (const it of items) failItem(it, task, e.message || String(e));
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
    const tasks = db
      .prepare(`SELECT * FROM stock_refresh_tasks WHERE status IN ('PENDING','RUNNING') ORDER BY created_at ASC`)
      .all();
    for (const task of tasks) {
      // 取该任务下所有 PENDING item
      const items = db
        .prepare(`SELECT * FROM stock_refresh_items WHERE task_id=? AND status='PENDING' ORDER BY id ASC`)
        .all(task.local_task_id);
      if (items.length === 0) continue;

      // 按 store_id 分组(不同店铺 warehouse_id 不同,不能混在一个请求)
      const groups = new Map();
      for (const it of items) {
        if (!groups.has(it.store_id)) groups.set(it.store_id, []);
        const g = groups.get(it.store_id);
        // 每组最多 MAX_BATCH_SIZE 个(OPI 单批上限)
        if (g.length < MAX_BATCH_SIZE) g.push(it);
      }

      // 逐组批量提交,组间 REQUEST_INTERVAL_MS 间隔
      for (const [, groupItems] of groups) {
        await processBatch(groupItems, task);
        await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS));
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
    { intervalMs: POLL_INTERVAL_MS, maxBatchSize: MAX_BATCH_SIZE, requestIntervalMs: REQUEST_INTERVAL_MS },
    'stock-refresh-poller: 已启动(5s检查,同店铺批量≤100/请求,请求间1s间隔)'
  );
}

export function stopStockRefreshPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
