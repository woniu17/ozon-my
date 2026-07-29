// 批量均衡上架·第二阶段:OPI 上架 poller(2026-07 两阶段改造)
// 模式:沿用现有 poller 模式(setInterval + .unref())
// 职责:
//   1. 全局串行:同一时刻只跑一个批次(查 status='RUNNING' 的批次,取一个)
//   2. 顺序执行:取该批次下 seq 最小的 status='IMAGE_DONE' 子任务(图片已就绪)
//   3. 速度控制:距上一子任务 finished_at < intervalSec 则跳过本轮
//   4. 执行:从 follow_sell_task_payloads 读取 transformedItems → commitListing(opi.productImport)
//   5. 状态更新:子任务 SUCCESS/FAILED,批次进度计数,无待处理则批次完成
//   6. 软取消:取消时 PENDING/IMAGE_PENDING/IMAGE_DONE→SKIPPED,RUNNING 等其完成
//
// 注意:图片处理(第一阶段)由 batch-image-poller 负责,不受 intervalSec 限速
// 本 poller 只负责 OPI 请求阶段,受 intervalSec 限速
import { db } from '../db/index.js';
import { commitListing } from './listing-builder.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 2 * 1000; // 每 2 秒检查一次
const FIRST_SCAN_DELAY_MS = 10 * 1000; // 启动后 10 秒首次扫描

// 默认速度配置(批次未配置时用)
const DEFAULT_INTERVAL_SEC = 10;

// 图片处理完成后的冷却期(秒):IMAGE_DONE 后等待 N 秒才允许提交 OPI
// 确保落盘文件可被静态资源服务/公网 CDN 访问
const IMAGE_DONE_COOLDOWN_SEC = 5;

let timer = null;
let running = false; // 防止 scanOnce 重入

/**
 * 扫描一次:取 RUNNING 批次 → 取 IMAGE_DONE 子任务 → 速度控制 → 执行 OPI
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

    // 2. 取该批次下 seq 最小的 IMAGE_DONE 子任务(图片已就绪,待 OPI)
    const item = db
      .prepare(
        `SELECT * FROM batch_upload_items
         WHERE batch_task_id = ? AND status = 'IMAGE_DONE'
         ORDER BY seq ASC LIMIT 1`
      )
      .get(batch.local_task_id);
    if (!item) {
      // 无 IMAGE_DONE 子任务,检查是否还有待处理(PENDING/IMAGE_PENDING/IMAGE_DONE)
      // 若全部处理完(无 PENDING/IMAGE_PENDING/IMAGE_DONE),则批次完成
      const pending = db
        .prepare(
          `SELECT COUNT(*) AS n FROM batch_upload_items
           WHERE batch_task_id = ? AND status IN ('PENDING','IMAGE_PENDING','IMAGE_DONE')`
        )
        .get(batch.local_task_id);
      if (pending.n === 0) {
        await completeBatch(batch.local_task_id);
      }
      // 否则:图片阶段还在处理中,等下一轮
      return;
    }

    // 3. 图片冷却:IMAGE_DONE 后等待冷却期,确保落盘文件可被访问
    if (item.updated_at) {
      const imageDoneTime = new Date(item.updated_at + 'Z').getTime();
      const elapsedSinceDone = Date.now() - imageDoneTime;
      if (elapsedSinceDone < IMAGE_DONE_COOLDOWN_SEC * 1000) {
        return; // 冷却中,等下一轮
      }
    }

    // 4. 速度控制:距上一子任务 finished_at < intervalSec 则跳过
    // finished_at 是 OPI 阶段的完成时间(图片阶段不写 finished_at)
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

    // 5. 执行 OPI 上架子任务
    await executeBatchItem(batch, item, speedConfig);
  } catch (e) {
    logger.warn({ err: e.message }, 'batch-upload-poller 扫描异常');
  } finally {
    running = false;
  }
}

/**
 * 执行单个子任务的 OPI 阶段:读取缓存的 transformedItems → commitListing → 更新状态
 */
async function executeBatchItem(batch, item, speedConfig) {
  const batchTaskId = batch.local_task_id;
  const localTaskId = item.follow_task_id; // prepareListing 返回的 localTaskId
  const targetStoreId = item.target_store_id;
  const sku = item.source_sku;

  if (!localTaskId) {
    // 异常:IMAGE_DONE 但无 follow_task_id(数据不一致)
    db.prepare(
      `UPDATE batch_upload_items
       SET status='FAILED', error_message='IMAGE_DONE 但 follow_task_id 为空', finished_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`
    ).run(item.id);
    db.prepare(`UPDATE batch_upload_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(batchTaskId);
    logger.warn({ batchTaskId, sku, itemId: item.id }, 'batch-upload 子任务异常:IMAGE_DONE 但 follow_task_id 为空');
    return;
  }

  // 标记 RUNNING
  db.prepare(
    `UPDATE batch_upload_items SET status='RUNNING', updated_at=datetime('now') WHERE id=?`
  ).run(item.id);

  try {
    // 从 follow_sell_task_payloads 读取 prepareListing 缓存的 transformedItems
    const row = db
      .prepare(`SELECT payload FROM follow_sell_task_payloads WHERE local_task_id=? AND stage='transformed'`)
      .get(localTaskId);
    if (!row) {
      throw new Error(`transformedItems 缓存不存在(local_task_id=${localTaskId})`);
    }
    const transformedItems = JSON.parse(row.payload);
    if (!Array.isArray(transformedItems) || transformedItems.length === 0) {
      throw new Error('transformedItems 为空或非数组');
    }

    // 执行 OPI 上架(第二阶段,受 intervalSec 限速)
    const result = await commitListing(localTaskId, transformedItems, targetStoreId);

    if (result.error) {
      // 失败
      db.prepare(
        `UPDATE batch_upload_items
         SET status='FAILED', follow_task_id=?, error_message=?, finished_at=datetime('now'), updated_at=datetime('now')
         WHERE id=?`
      ).run(result.localTaskId, result.error, item.id);
      db.prepare(`UPDATE batch_upload_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(batchTaskId);
      logger.warn({ batchTaskId, sku, err: result.error }, 'batch-upload OPI 子任务失败');

      // 失败策略:onFailure='pause' 则暂停批次
      if (speedConfig.onFailure === 'pause') {
        db.prepare(
          `UPDATE batch_upload_tasks SET status='PAUSED', error_message='OPI 子任务失败触发暂停' WHERE local_task_id=?`
        ).run(batchTaskId);
        logger.info({ batchTaskId, sku }, 'batch-upload 批次因 OPI 失败暂停');
      }
    } else {
      // 成功(OPI 调用成功,进入 PROCESSING,最终状态由 import-status-poller 收尾)
      db.prepare(
        `UPDATE batch_upload_items
         SET status='SUCCESS', follow_task_id=?, finished_at=datetime('now'), updated_at=datetime('now')
         WHERE id=?`
      ).run(result.localTaskId, item.id);
      db.prepare(`UPDATE batch_upload_tasks SET success_count = success_count + 1 WHERE local_task_id=?`).run(batchTaskId);
      logger.info({ batchTaskId, sku, localTaskId: result.localTaskId, ozonTaskId: result.ozonTaskId }, 'batch-upload OPI 子任务成功');
    }
  } catch (e) {
    // 读取缓存或 OPI 调用异常
    const errMsg = e.message;
    db.prepare(
      `UPDATE batch_upload_items
       SET status='FAILED', error_message=?, finished_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`
    ).run(errMsg, item.id);
    db.prepare(`UPDATE batch_upload_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(batchTaskId);
    logger.warn({ batchTaskId, sku, err: errMsg, stack: e.stack }, 'batch-upload OPI 子任务异常');

    if (speedConfig.onFailure === 'pause') {
      db.prepare(
        `UPDATE batch_upload_tasks SET status='PAUSED', error_message='OPI 子任务异常触发暂停' WHERE local_task_id=?`
      ).run(batchTaskId);
    }
  }
}

/**
 * 批次完成:无待处理子任务(PENDING/IMAGE_PENDING/IMAGE_DONE),汇总状态
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
    'batch-upload-poller: 已启动(2秒检查,全局串行,OPI阶段限速,取IMAGE_DONE执行OPI)'
  );
}

export function stopBatchUploadPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
