// 上架结果轮询器
// 周期性扫描 follow_sell_tasks 中 PROCESSING 状态的任务,主动调 OPI 拉取结果并落库,
// 避免插件不触发时任务永久停在 PROCESSING。
//
// 规则(2026-07 修复竞态 bug):
//   - 每 5 分钟扫描一次
//   - 仅处理 status='PROCESSING' AND ozon_task_id IS NOT NULL 的任务
//   - 超时基准用 opi_submitted_at(OPI 提交时刻);NULL 回退 created_at(向后兼容)
//   - 超时阈值:opi_submitted_at 起算 1 小时(created_at 回退时放宽到 3 小时,兼容旧数据无 opi_submitted_at)
//   - 超时前必须先查一次 OPI:有结果就落库,避免"OPI 已成功但被误标 FAILED"的竞态
//   - 只有 OPI 仍无结果(pending/空 items)才标超时 FAILED
//   - 串行处理(避免 OPI 限流),单次扫描内每任务一次失败不阻塞下一个
import { db } from '../db/index.js';
import config from '../config/index.js';
import * as opi from './ozon-opi.js';
import { upsertTaskItems, summarizeTaskStatus, saveOpiResponse } from '../modules/products.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 1 小时(从 opi_submitted_at 起算)
const STALE_FALLBACK_MS = 3 * 60 * 60 * 1000; // 3 小时(无 opi_submitted_at 时从 created_at 起算,兼容旧数据)

// 解析 SQLite datetime 字段为毫秒时间戳(兼容 'YYYY-MM-DD HH:MM:SS' 和 ISO)
function parseTs(s) {
  if (!s) return NaN;
  const str = String(s).trim();
  if (!str) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str)) return new Date(str).getTime();
  return new Date(str.replace(' ', 'T') + 'Z').getTime();
}

// 拉取并落库 OPI 结果;返回 true 表示已拿到最终结果(应跳过超时判定)
async function fetchAndSaveOpiResult(row, store) {
  const info = await opi.productImportInfo(store, row.ozon_task_id);
  saveOpiResponse(row.local_task_id, row.store_id, info);
  const items = (info?.result?.items || []).map((it) => ({
    offer_id: it.offer_id,
    product_id: it.product_id,
    status: it.status,
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
  if (items.length === 0) return false; // OPI 还未返回 items,不算最终结果

  upsertTaskItems(row.local_task_id, items, row.store_id);
  const summary = summarizeTaskStatus(row.local_task_id);
  logger.info(
    { localTaskId: row.local_task_id, ozonTaskId: row.ozon_task_id, summary },
    'import-status-poller: 已更新任务状态'
  );
  return true;
}

// 单次扫描:返回 { scanned, updated, failed, errors }
async function scanOnce() {
  const rows = db
    .prepare(
      `SELECT local_task_id, store_id, ozon_task_id, opi_submitted_at, created_at
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
    // 优先用 opi_submitted_at(OPI 真正提交时刻),NULL 回退 created_at(旧数据兼容)
    const baseTs = parseTs(row.opi_submitted_at);
    const useFallback = !Number.isFinite(baseTs);
    const refTs = useFallback ? parseTs(row.created_at) : baseTs;
    const ageMs = now - refTs;
    const threshold = useFallback ? STALE_FALLBACK_MS : STALE_TIMEOUT_MS;
    const isStale = Number.isFinite(ageMs) && ageMs > threshold;

    const store = stores.find((s) => s.id === row.store_id);
    if (!store) {
      errors++;
      logger.warn(
        { localTaskId: row.local_task_id, storeId: row.store_id },
        'poller: store 不存在,跳过'
      );
      continue;
    }

    try {
      // 始终先查 OPI 拉取最新结果(避免竞态:OPI 已成功但被误标超时)
      const gotFinal = await fetchAndSaveOpiResult(row, store);
      if (gotFinal) {
        updated++;
        continue;
      }
      // OPI 仍无最终结果
      if (isStale) {
        // 超时:OPI 长时间无结果,标 FAILED
        db.prepare(
          `UPDATE follow_sell_tasks
           SET status='FAILED', error_message=?, completed_at=datetime('now')
           WHERE local_task_id=? AND status='PROCESSING'`
        ).run(
          `上架结果轮询超时(${useFallback ? 'created_at' : 'opi_submitted_at'} 起算超过 ${
            threshold / 3600000
          } 小时未完成)`,
          row.local_task_id
        );
        failed++;
        logger.warn(
          { localTaskId: row.local_task_id, ozonTaskId: row.ozon_task_id, ageMs, base: useFallback ? 'created_at' : 'opi_submitted_at' },
          'import-status-poller: 任务超时,已标 FAILED'
        );
      }
      // 未超时:等下次扫描
    } catch (e) {
      errors++;
      // OPI 调用失败:若已超时,也标 FAILED(否则会无限重试)
      if (isStale) {
        db.prepare(
          `UPDATE follow_sell_tasks
           SET status='FAILED', error_message=?, completed_at=datetime('now')
           WHERE local_task_id=? AND status='PROCESSING'`
        ).run(
          `上架结果轮询超时(${useFallback ? 'created_at' : 'opi_submitted_at'} 起算超过 ${
            threshold / 3600000
          } 小时,OPI 查询失败: ${e.message})`,
          row.local_task_id
        );
        failed++;
        logger.warn(
          { localTaskId: row.local_task_id, ozonTaskId: row.ozon_task_id, ageMs, err: e.message },
          'import-status-poller: 任务超时且 OPI 查询失败,已标 FAILED'
        );
      } else {
        logger.warn(
          { localTaskId: row.local_task_id, ozonTaskId: row.ozon_task_id, err: e.message },
          'poller: productImportInfo 调用失败,等待下次扫描'
        );
      }
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
