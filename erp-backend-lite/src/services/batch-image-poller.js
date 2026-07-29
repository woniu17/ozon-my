// 批量上架·第一阶段:图片处理 poller(2026-07 两阶段改造)
// 职责:
//   1. 扫描所有 RUNNING 批次下的 PENDING item(不限速,不受 intervalSec 控制)
//   2. 标记 IMAGE_PENDING,并发执行 prepareListing(含水印加工链)
//   3. 完成后标记 IMAGE_DONE,存 follow_task_id 供第二阶段(batch-upload-poller)读取
//   4. 失败(如缓存数据不足)标记为 FAILED,触发 onFailure 策略
// 并发度:MAX_CONCURRENCY=5,同时处理 5 个 item 的图片
// 轮询周期:500ms(短周期提升吞吐,实际处理时间取决于水印渲染)
import { db } from '../db/index.js';
import { buildListingMessage, prepareListing } from './listing-builder.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 500; // 500ms 扫描一次(不限速)
const FIRST_SCAN_DELAY_MS = 8 * 1000; // 启动后 8 秒首次扫描
const MAX_CONCURRENCY = 5; // 最多同时处理 5 个 item

let timer = null;
let running = false; // 防止 scanOnce 重入

/**
 * 扫描一次:取所有 RUNNING 批次下的 PENDING item(最多 MAX_CONCURRENCY 个) → 并发执行图片处理
 */
async function scanOnce() {
  if (running) return; // 上一轮未完成,跳过
  running = true;
  try {
    // 取所有 RUNNING 批次下的 PENDING item(兼容旧数据 PENDING 和新流程)
    // 一次最多取 MAX_CONCURRENCY 个,按 seq 升序
    const items = db
      .prepare(
        `SELECT bi.*, bt.config, bt.speed_config, bt.started_at AS batch_started_at
         FROM batch_upload_items bi
         JOIN batch_upload_tasks bt ON bi.batch_task_id = bt.local_task_id
         WHERE bt.status = 'RUNNING' AND bi.status = 'PENDING'
         ORDER BY bi.seq ASC
         LIMIT ?`
      )
      .all(MAX_CONCURRENCY);

    if (items.length === 0) return;

    // 并发执行(最多 5 个同时跑)
    await Promise.all(items.map((item) => processItemImage(item)));
  } catch (e) {
    logger.warn({ err: e.message }, 'batch-image-poller 扫描异常');
  } finally {
    running = false;
  }
}

/**
 * 处理单个 item 的图片阶段:buildListingMessage → prepareListing → 标记 IMAGE_DONE
 * 失败时(如缓存数据不足)标记 FAILED,触发 onFailure 策略
 * 水印渲染失败由 watermark.js 透传原图,不阻断此阶段
 */
async function processItemImage(item) {
  const batchTaskId = item.batch_task_id;
  const sku = item.source_sku;
  const targetStoreId = item.target_store_id;

  // 标记 IMAGE_PENDING + started_at
  db.prepare(
    `UPDATE batch_upload_items SET status='IMAGE_PENDING', started_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
  ).run(item.id);

  // 首次执行时更新 batch.started_at
  if (!item.batch_started_at) {
    db.prepare(
      `UPDATE batch_upload_tasks SET started_at=datetime('now') WHERE local_task_id=? AND started_at IS NULL`
    ).run(batchTaskId);
  }

  try {
    const config = parseJson(item.config) || {};
    const options = {
      defaultStock: config.defaultStock ?? 0,
      templateId: config.templateId ?? null,
    };
    if (config.salePrice != null) options.salePrice = config.salePrice;
    if (config.oldPrice != null) options.oldPrice = config.oldPrice;
    if (config.minPrice != null) options.minPrice = config.minPrice;

    // 构建上架 message(从缓存合成 item + 价格策略 + 水印字段注入)
    const { message } = await buildListingMessage(sku, targetStoreId, options);
    // 执行 prepareListing(含水印加工链:ai_rewrite → watermark → ai_poster → copy_ban)
    // 水印渲染失败时 watermark.js 透传原图,prepareListing 仍返回成功
    const prepared = await prepareListing(message, targetStoreId);

    if (prepared.error) {
      // prepareListing 失败(如缓存数据不足、prepareBundleItems 转换后无有效 items)
      db.prepare(
        `UPDATE batch_upload_items
         SET status='FAILED', follow_task_id=?, error_message=?, finished_at=datetime('now'), updated_at=datetime('now')
         WHERE id=?`
      ).run(prepared.localTaskId, prepared.error, item.id);
      db.prepare(`UPDATE batch_upload_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(batchTaskId);
      logger.warn({ batchTaskId, sku, err: prepared.error }, 'batch-image 图片处理失败');

      // 失败策略:onFailure='pause' 则暂停批次
      const speedConfig = parseJson(item.speed_config) || {};
      if (speedConfig.onFailure === 'pause') {
        db.prepare(
          `UPDATE batch_upload_tasks SET status='PAUSED', error_message='图片处理失败触发暂停' WHERE local_task_id=?`
        ).run(batchTaskId);
        logger.info({ batchTaskId, sku }, 'batch-upload 批次因图片处理失败暂停');
      }
      return;
    }

    // 成功:标记 IMAGE_DONE,存 follow_task_id 供第二阶段读取
    // 注意:不写 finished_at(finished_at 是 OPI 阶段的完成时间,用于限速判断)
    db.prepare(
      `UPDATE batch_upload_items SET status='IMAGE_DONE', follow_task_id=?, updated_at=datetime('now') WHERE id=?`
    ).run(prepared.localTaskId, item.id);
    logger.info({ batchTaskId, sku, localTaskId: prepared.localTaskId }, 'batch-image 图片处理完成');
  } catch (e) {
    const errMsg = e.message;
    db.prepare(
      `UPDATE batch_upload_items
       SET status='FAILED', error_message=?, finished_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?`
    ).run(errMsg, item.id);
    db.prepare(`UPDATE batch_upload_tasks SET failed_count = failed_count + 1 WHERE local_task_id=?`).run(batchTaskId);
    logger.warn({ batchTaskId, sku, err: errMsg, stack: e.stack }, 'batch-image 图片处理异常');

    const speedConfig = parseJson(item.speed_config) || {};
    if (speedConfig.onFailure === 'pause') {
      db.prepare(
        `UPDATE batch_upload_tasks SET status='PAUSED', error_message='图片处理异常触发暂停' WHERE local_task_id=?`
      ).run(batchTaskId);
    }
  }
}

function parseJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function startBatchImagePoller() {
  if (timer) return;
  setTimeout(() => {
    scanOnce().catch((e) => logger.warn({ err: e.message }, 'batch-image-poller 首次扫描异常'));
    timer = setInterval(() => {
      scanOnce().catch((e) => logger.warn({ err: e.message }, 'batch-image-poller 扫描异常'));
    }, POLL_INTERVAL_MS);
    timer.unref();
  }, FIRST_SCAN_DELAY_MS).unref();
  logger.info(
    { intervalMs: POLL_INTERVAL_MS, concurrency: MAX_CONCURRENCY },
    'batch-image-poller: 已启动(500ms检查,并发5,不限速,负责图片处理/水印渲染)'
  );
}

export function stopBatchImagePoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
