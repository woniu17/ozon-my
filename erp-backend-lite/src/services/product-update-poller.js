// 商品信息更新任务调度 poller(2026-07)
// 职责:轮询 product_update_tasks(PENDING/RUNNING),对每个 item 执行
//   1. buildProductUpdatePayload(store, offerId, updateFields, newValues, applyFieldUpdaters)
//      → 从 Ozon 实时拉数据 + 应用 FieldUpdater → 得到 opiItem
//   2. productImport(store, [opiItem]) → 拿 task_id
//   3. 轮询 productImportInfo(store, task_id) 直到 status != pending(或超时)
//   4. 更新 item.status(SUCCESS/FAILED)+ opi_result + error_message
//   5. 全部 item 完成后汇总 task.status(SUCCESS/FAILED/PARTIAL)
// 串行处理每个 item(避免 OPI 限流),轮询周期 5s
import { db } from '../db/index.js';
import config from '../config/index.js';
import * as opi from './ozon-opi.js';
import { applyFieldUpdaters } from './field-updaters/index.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 5000;
const FIRST_SCAN_DELAY_MS = 8 * 1000;
const ITEM_INTERVAL_MS = 2000; // item 间间隔,避免 OPI 限流
const IMPORT_INFO_POLL_INTERVAL_MS = 3000; // 单次 import/info 轮询间隔
const IMPORT_INFO_TIMEOUT_MS = 60_000; // 单次 import 最长等待 60s

let timer = null;
let running = false;

// 安全 JSON 解析
function safeParse(s, fallback) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// 处理单个 item:构建 payload → 提交 OPI → 轮询结果 → 落库
async function processItem(item, task) {
  const store = config.loadStores().find((s) => s.id === item.store_id);
  if (!store) {
    failItem(item, task, `店铺不存在: ${item.store_id}`);
    return;
  }
  // 标记 PROCESSING
  db.prepare(`UPDATE product_update_items SET status='PROCESSING', updated_at=datetime('now') WHERE id=?`).run(item.id);
  // 首次执行时更新 task 状态为 RUNNING
  if (task.status === 'PENDING') {
    db.prepare(`UPDATE product_update_tasks SET status='RUNNING' WHERE local_task_id=?`).run(task.local_task_id);
  }

  try {
    const updateFields = safeParse(item.update_fields, []);
    const newValues = safeParse(item.new_values, {});
    if (updateFields.length === 0) {
      failItem(item, task, 'update_fields 为空');
      return;
    }

    // Step 1+2: 构建 payload(从 Ozon 实时拉数据 + 应用 FieldUpdater)
    logger.info({ itemId: item.id, offerId: item.offer_id, fields: updateFields }, 'product-update 开始构建 payload');
    const opiItem = await opi.buildProductUpdatePayload(
      store,
      item.offer_id,
      updateFields,
      newValues,
      applyFieldUpdaters
    );

    // Step 3: 提交 /v3/product/import
    const importResp = await opi.productImport(store, [opiItem]);
    const opiTaskId = importResp?.result?.task_id;
    if (!opiTaskId) {
      failItem(item, task, `OPI 未返回 task_id,响应: ${JSON.stringify(importResp)}`);
      return;
    }
    logger.info({ itemId: item.id, offerId: item.offer_id, opiTaskId }, 'product-update 已提交 OPI');
    db.prepare(`UPDATE product_update_items SET opi_task_id=?, updated_at=datetime('now') WHERE id=?`).run(
      String(opiTaskId),
      item.id
    );

    // Step 4: 轮询 /v1/product/import/info 直到非 pending(或超时)
    const startTime = Date.now();
    let finalInfo = null;
    while (Date.now() - startTime < IMPORT_INFO_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, IMPORT_INFO_POLL_INTERVAL_MS));
      const info = await opi.productImportInfo(store, opiTaskId);
      const items = info?.result?.items || [];
      if (items.length === 0) continue; // OPI 还未返回 items
      const found = items.find((it) => String(it.offer_id) === String(item.offer_id));
      if (!found) continue;
      if (found.status === 'pending') continue; // 仍在处理
      finalInfo = found;
      break;
    }

    if (!finalInfo) {
      // 超时未拿到结果,标记 FAILED(可重试)
      failItem(item, task, `OPI 任务 ${opiTaskId} 超时 ${IMPORT_INFO_TIMEOUT_MS / 1000}s 未返回结果`);
      return;
    }

    // Step 5: 落库结果
    const errors = finalInfo.errors || [];
    db.prepare(
      `UPDATE product_update_items
       SET status=?, opi_result=?, error_message=?, updated_at=datetime('now')
       WHERE id=?`
    ).run(
      errors.length === 0 ? 'SUCCESS' : 'FAILED',
      JSON.stringify(finalInfo),
      errors.length === 0 ? null : JSON.stringify(errors),
      item.id
    );
    if (errors.length === 0) {
      db.prepare(`UPDATE product_update_tasks SET success_count = success_count + 1 WHERE local_task_id=?`).run(
        task.local_task_id
      );
      logger.info({ itemId: item.id, offerId: item.offer_id, opiTaskId }, 'product-update 更新成功');
    } else {
      db.prepare(`UPDATE product_update_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(
        task.local_task_id
      );
      logger.warn({ itemId: item.id, offerId: item.offer_id, opiTaskId, errors }, 'product-update 更新失败');
    }
    summarizeTask(task.local_task_id);
  } catch (e) {
    failItem(item, task, e.message || String(e));
  }
}

function failItem(item, task, msg) {
  db.prepare(
    `UPDATE product_update_items SET status='FAILED', error_message=?, updated_at=datetime('now') WHERE id=?`
  ).run(msg, item.id);
  db.prepare(`UPDATE product_update_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(
    task.local_task_id
  );
  logger.warn({ itemId: item.id, err: msg }, 'product-update item 失败');
  summarizeTask(task.local_task_id);
}

// 汇总任务状态:无 PENDING/PROCESSING item 时计算终态
function summarizeTask(localTaskId) {
  const pending = db
    .prepare(`SELECT COUNT(*) as n FROM product_update_items WHERE task_id=? AND status IN ('PENDING','PROCESSING')`)
    .get(localTaskId).n;
  if (pending > 0) return;
  const task = db.prepare(`SELECT * FROM product_update_tasks WHERE local_task_id=?`).get(localTaskId);
  if (!task) return;
  if (['SUCCESS', 'FAILED', 'PARTIAL'].includes(task.status)) return; // 已终态
  let newStatus;
  if (task.success_count > 0 && task.failed_count > 0) newStatus = 'PARTIAL';
  else if (task.success_count > 0) newStatus = 'SUCCESS';
  else newStatus = 'FAILED';
  db.prepare(`UPDATE product_update_tasks SET status=?, completed_at=datetime('now') WHERE local_task_id=?`).run(
    newStatus,
    localTaskId
  );
  logger.info(
    { localTaskId, status: newStatus, success: task.success_count, failed: task.failed_count },
    'product-update 任务完成'
  );
}

// 扫描一次
async function scanOnce() {
  if (running) return;
  running = true;
  try {
    // 取 PENDING/RUNNING 任务
    const tasks = db
      .prepare(`SELECT * FROM product_update_tasks WHERE status IN ('PENDING','RUNNING') ORDER BY created_at ASC`)
      .all();
    for (const task of tasks) {
      // 取该任务下 PENDING item(串行,每次取 1 个)
      const items = db
        .prepare(`SELECT * FROM product_update_items WHERE task_id=? AND status='PENDING' ORDER BY id ASC LIMIT 1`)
        .all(task.local_task_id);
      if (items.length === 0) continue;
      await processItem(items[0], task);
      await new Promise((r) => setTimeout(r, ITEM_INTERVAL_MS));
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'product-update-poller 扫描异常');
  } finally {
    running = false;
  }
}

export function startProductUpdatePoller() {
  if (timer) return;
  setTimeout(() => {
    scanOnce().catch((e) => logger.warn({ err: e.message }, 'product-update-poller 首次扫描异常'));
    timer = setInterval(() => {
      scanOnce().catch((e) => logger.warn({ err: e.message }, 'product-update-poller 扫描异常'));
    }, POLL_INTERVAL_MS);
    timer.unref();
  }, FIRST_SCAN_DELAY_MS).unref();
  logger.info(
    { intervalMs: POLL_INTERVAL_MS, itemIntervalMs: ITEM_INTERVAL_MS },
    'product-update-poller: 已启动(5s检查,串行处理,item间2s间隔,商品信息更新调度)'
  );
}

export function stopProductUpdatePoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
