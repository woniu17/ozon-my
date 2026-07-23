// 批量均衡上架调度器(P2-2)
// 模式:沿用现有 poller 模式(setInterval + .unref())
// 职责:
//   1. 全局串行:同一时刻只跑一个批次(查 status='RUNNING' 的批次,取一个)
//   2. 顺序执行:取该批次下 seq 最小的 status='PENDING' 子任务
//   3. 速度控制:距上一子任务 finished_at < intervalSec 则跳过本轮
//   4. 执行:buildListingMessage(sku, targetStoreId) → executeListing
//   5. 状态更新:子任务 SUCCESS/FAILED,批次进度计数,无 PENDING 则批次完成
//   6. 软取消:取消时 PENDING→SKIPPED,RUNNING 等其完成
import { db } from '../db/index.js';
import { buildListingMessage, executeListing } from './listing-builder.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 2 * 1000; // 每 2 秒检查一次
const FIRST_SCAN_DELAY_MS = 10 * 1000; // 启动后 10 秒首次扫描

// 默认速度配置(批次未配置时用)
const DEFAULT_INTERVAL_SEC = 10;

let timer = null;
let running = false; // 防止 scanOnce 重入

/**
 * 扫描一次:取 RUNNING 批次 → 取 PENDING 子任务 → 速度控制 → 执行
 */
async function scanOnce() {
  if (running) return; // 上一轮未完成,跳过
  running = true;
  try {
    // 1. 全局串行:取一个 RUNNING 批次(按 created_at 升序,先创建先跑)
    const batch = db
      .prepare(`SELECT * FROM batch_upload_tasks WHERE status = 'RUNNING' ORDER BY created_at ASC LIMIT 1`)
      .get();
    if (!batch) return;

    // 2. 取该批次下 seq 最小的 PENDING 子任务
    const item = db
      .prepare(
        `SELECT * FROM batch_upload_items
         WHERE batch_task_id = ? AND status = 'PENDING'
         ORDER BY seq ASC LIMIT 1`
      )
      .get(batch.local_task_id);
    if (!item) {
      // 无 PENDING 子任务 → 批次完成
      await completeBatch(batch.local_task_id);
      return;
    }

    // 3. 速度控制:距上一子任务 finished_at < intervalSec 则跳过
    const speedConfig = parseJson(batch.speed_config) || {};
    const intervalSec = Number(speedConfig.intervalSec) || DEFAULT_INTERVAL_SEC;
    const lastFinished = db
      .prepare(
        `SELECT MAX(finished_at) AS last FROM batch_upload_items
         WHERE batch_task_id = ? AND finished_at IS NOT NULL`
      )
      .get(batch.local_task_id);
    if (lastFinished?.last) {
      const elapsed = Date.now() - new Date(lastFinished.last + 'Z').getTime();
      if (elapsed < intervalSec * 1000) return; // 间隔不足,跳过本轮
    }

    // 4. 执行子任务
    await executeBatchItem(batch, item, speedConfig);
  } catch (e) {
    logger.warn({ err: e.message }, 'batch-upload-poller 扫描异常');
  } finally {
    running = false;
  }
}

/**
 * 执行单个子任务:buildListingMessage → executeListing → 更新状态
 */
async function executeBatchItem(batch, item, speedConfig) {
  const batchTaskId = batch.local_task_id;
  // ⚠️ 数据库字段是 snake_case:source_sku / target_store_id,不能直接解构为 sku
  const sku = item.source_sku;
  const targetStoreId = item.target_store_id;

  // 标记 RUNNING + started_at
  db.prepare(
    `UPDATE batch_upload_items SET status='RUNNING', started_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
  ).run(item.id);

  // 首次执行时更新 batch.started_at
  if (!batch.started_at) {
    db.prepare(`UPDATE batch_upload_tasks SET started_at=datetime('now') WHERE local_task_id=? AND started_at IS NULL`).run(
      batchTaskId
    );
  }

  try {
    // 解析配置(模板 + 库存 + 价格策略)
    const config = parseJson(batch.config) || {};
    const options = {
      defaultStock: config.defaultStock ?? 0,
      templateId: config.templateId ?? null,
    };
    // 价格策略(可选,来自模板配置)
    if (config.salePrice != null) options.salePrice = config.salePrice;
    if (config.oldPrice != null) options.oldPrice = config.oldPrice;
    if (config.minPrice != null) options.minPrice = config.minPrice;

    // 构建上架 message
    const { message } = await buildListingMessage(sku, targetStoreId, options);
    // 执行上架
    const result = await executeListing(message, targetStoreId);

    if (result.error) {
      // 失败
      db.prepare(
        `UPDATE batch_upload_items
         SET status='FAILED', follow_task_id=?, error_message=?, finished_at=datetime('now'), updated_at=datetime('now')
         WHERE id=?`
      ).run(result.localTaskId, result.error, item.id);
      db.prepare(
        `UPDATE batch_upload_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`
      ).run(batchTaskId);
      logger.warn({ batchTaskId, sku, err: result.error }, 'batch-upload 子任务失败');

      // 失败策略:onFailure='pause' 则暂停批次
      if (speedConfig.onFailure === 'pause') {
        db.prepare(
          `UPDATE batch_upload_tasks SET status='PAUSED', error_message='子任务失败触发暂停' WHERE local_task_id=?`
        ).run(batchTaskId);
        logger.info({ batchTaskId, sku }, 'batch-upload 批次因失败暂停');
      }
    } else {
      // 成功(OPI 调用成功,进入 PROCESSING,最终状态由 import-status-poller 收尾)
      db.prepare(
        `UPDATE batch_upload_items
         SET status='SUCCESS', follow_task_id=?, finished_at=datetime('now'), updated_at=datetime('now')
         WHERE id=?`
      ).run(result.localTaskId, item.id);
      db.prepare(
        `UPDATE batch_upload_tasks SET success_count = success_count + 1 WHERE local_task_id=?`
      ).run(batchTaskId);
      logger.info({ batchTaskId, sku, localTaskId: result.localTaskId }, 'batch-upload 子任务成功');
    }
  } catch (e) {
    // 构建或执行过程异常(如缓存数据不足)
    const errMsg = e.message;
    db.prepare(
      `UPDATE batch_upload_items
       SET status='FAILED', error_message=?, finished_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`
    ).run(errMsg, item.id);
    db.prepare(
      `UPDATE batch_upload_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`
    ).run(batchTaskId);
    logger.warn({ batchTaskId, sku, err: errMsg, stack: e.stack }, 'batch-upload 子任务异常');

    if (speedConfig.onFailure === 'pause') {
      db.prepare(
        `UPDATE batch_upload_tasks SET status='PAUSED', error_message='子任务异常触发暂停' WHERE local_task_id=?`
      ).run(batchTaskId);
    }
  }
}

/**
 * 批次完成:无 PENDING 子任务,汇总状态
 */
async function completeBatch(batchTaskId) {
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status='SKIPPED' THEN 1 ELSE 0 END) AS skipped
       FROM batch_upload_items WHERE batch_task_id=?`
    )
    .get(batchTaskId);

  let status;
  if (stats.failed === 0) status = 'SUCCESS';
  else if (stats.success === 0) status = 'FAILED';
  else status = 'PARTIAL';

  db.prepare(
    `UPDATE batch_upload_tasks
     SET status=?, completed_at=datetime('now')
     WHERE local_task_id=?`
  ).run(status, batchTaskId);
  logger.info(
    { batchTaskId, status, total: stats.total, success: stats.success, failed: stats.failed, skipped: stats.skipped },
    'batch-upload 批次完成'
  );
}

function parseJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function startBatchUploadPoller() {
  if (timer) return;
  setTimeout(() => {
    scanOnce().catch((e) => logger.warn({ err: e.message }, 'batch-upload-poller 首次扫描异常'));
    timer = setInterval(() => {
      scanOnce().catch((e) => logger.warn({ err: e.message }, 'batch-upload-poller 扫描异常'));
    }, POLL_INTERVAL_MS);
    timer.unref();
  }, FIRST_SCAN_DELAY_MS).unref();
  logger.info(
    { intervalSec: POLL_INTERVAL_MS / 1000, defaultIntervalSec: DEFAULT_INTERVAL_SEC },
    'batch-upload-poller: 已启动(2秒检查一次,全局串行,固定间隔限速)'
  );
}

export function stopBatchUploadPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
