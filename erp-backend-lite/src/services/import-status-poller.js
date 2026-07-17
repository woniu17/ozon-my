// 上架结果轮询器
// 周期性扫描 follow_sell_tasks 中 PROCESSING 状态的任务,主动调 OPI 拉取结果并落库,
// 避免插件不触发时任务永久停在 PROCESSING。
//
// 规则:
//   - 每 5 分钟扫描一次
//   - 仅处理 status='PROCESSING' AND ozon_task_id IS NOT NULL 的任务
//   - created_at 距今超过 1 小时的任务直接标 FAILED(超时未完成)
//   - 其余任务调 opi.productImportInfo 拉取最新状态,upsert items 后汇总
//   - 串行处理(避免 OPI 限流),单次扫描内每任务一次失败不阻塞下一个
import { db } from '../db/index.js';
import config from '../config/index.js';
import * as opi from './ozon-opi.js';
import { upsertTaskItems, summarizeTaskStatus } from '../modules/products.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 1 小时

// 单次扫描:返回 { scanned, updated, failed, errors }
async function scanOnce() {
  const rows = db
    .prepare(
      `SELECT local_task_id, store_id, ozon_task_id, created_at
       FROM follow_sell_tasks
       WHERE status='PROCESSING' AND ozon_task_id IS NOT NULL`
    )
    .all();

  logger.info({ scanned: rows.length }, 'import-status-poller: 扫描完成');

  if (rows.length === 0) {
    return { scanned: 0, updated: 0, failed: 0, errors: 0 };
  }

  const stores = config.loadStores();
  const now = Date.now();
  let updated = 0;
  let failed = 0;
  let errors = 0;

  for (const row of rows) {
    const createdAtMs = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();
    const ageMs = now - createdAtMs;

    // 1) 超时:直接标 FAILED
    if (Number.isFinite(ageMs) && ageMs > STALE_TIMEOUT_MS) {
      try {
        db.prepare(
          `UPDATE follow_sell_tasks
           SET status='FAILED', error_message='上架结果轮询超时(超过1小时未完成)', completed_at=datetime('now')
           WHERE local_task_id=? AND status='PROCESSING'`
        ).run(row.local_task_id);
        failed++;
        logger.warn(
          { localTaskId: row.local_task_id, ozonTaskId: row.ozon_task_id, ageMs },
          'import-status-poller: 任务超时,已标 FAILED'
        );
      } catch (e) {
        errors++;
        logger.warn({ localTaskId: row.local_task_id, err: e.message }, 'poller mark stale failed');
      }
      continue;
    }

    // 2) 未超时:调 OPI 拉取
    const store = stores.find((s) => s.id === row.store_id);
    if (!store) {
      // 找不到 store 凭证,跳过本次,等待下次扫描(若仍超时会被规则1处理)
      errors++;
      logger.warn(
        { localTaskId: row.local_task_id, storeId: row.store_id },
        'poller: store 不存在,跳过'
      );
      continue;
    }

    try {
      const info = await opi.productImportInfo(store, row.ozon_task_id);
      const items = (info?.result?.items || []).map((it) => ({
        offer_id: it.offer_id,
        product_id: it.product_id,
        status: it.status, // pending / imported / failed / skipped
        errors: (it.errors || []).map((e) => ({
          code: e.code,
          message: e.message,
          field: e.field,
          level: e.level,
          description: e.description,
          attribute_id: e.attribute_id,
          attribute_name: e.attribute_name,
        })),
      }));

      if (items.length === 0) {
        // OPI 还未返回 items,等下次扫描
        continue;
      }

      upsertTaskItems(row.local_task_id, items);
      const summary = summarizeTaskStatus(row.local_task_id);
      updated++;
      logger.info(
        { localTaskId: row.local_task_id, ozonTaskId: row.ozon_task_id, summary },
        'import-status-poller: 已更新任务状态'
      );
    } catch (e) {
      errors++;
      logger.warn(
        { localTaskId: row.local_task_id, ozonTaskId: row.ozon_task_id, err: e.message },
        'poller: productImportInfo 调用失败,等待下次扫描'
      );
    }
  }

  return { scanned: rows.length, updated, failed, errors };
}

let timer = null;

export function startImportStatusPoller() {
  if (timer) return;
  // 启动后 30 秒做首次扫描(避免与启动瞬间的其他初始化竞争),之后每 5 分钟一次
  setTimeout(() => {
    scanOnce().catch((e) => logger.warn({ err: e.message }, 'import-status-poller 首次扫描异常'));
    timer = setInterval(() => {
      scanOnce().catch((e) => logger.warn({ err: e.message }, 'import-status-poller 扫描异常'));
    }, POLL_INTERVAL_MS);
    timer.unref();
  }, 30 * 1000).unref();
  logger.info(
    { intervalMin: POLL_INTERVAL_MS / 60000, staleTimeoutMin: STALE_TIMEOUT_MS / 60000 },
    'import-status-poller: 已启动(5分钟扫描一次,超1小时未完成标FAILED)'
  );
}

export function stopImportStatusPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
