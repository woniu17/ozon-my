// 索引表跨表字段同步定时任务
// 周期性刷新 ozon_cache_index 中无法在数据表 upsert 时同步的字段:
//   - seller_slug / seller_name / searchable_text(从 ozon_auto_collect_log + ozon_store_classification 取)
//
// 注:listed / listed_store_id / listed_at / listed_task_id 已改由 products.js
//   upsertTaskItems 即时写入(提交跟卖任务时同步标记),不再走定时任务刷新。
//
// 规则:
//   - 每 5 分钟扫描一次
//   - 全量刷新(轻量 SQL,单次约毫秒级)
//   - 索引表的命中位 / 冗余展示字段在数据表 upsert 时已由 indexDao.syncSku 即时同步
//
// 关联:
//   - 与 domDao / attributeDao / richMediaDao / marketStatsDao / followSellDao 解耦
//   - 数据表 upsert 时只更新本表字段 + 触发 indexDao.syncSku(即时)
//   - 本任务只负责跨表聚合的 seller 字段(延迟可接受)
import { indexDao } from '../db/dao/sqlite/index-dao.js';
import logger from '../middleware/log.js';

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
const STARTUP_DELAY_MS = 30 * 1000; // 启动后 30 秒做首次扫描

// 单次扫描:返回 { sellersRefreshed }
// 使用 running 标志位抑制重入:若上一次扫描未完成,setInterval 的下一次触发会被跳过
let running = false;
async function scanOnce() {
  if (running) {
    logger.warn('index-sync: 上一次扫描仍在进行,本次跳过');
    return { skipped: true };
  }
  running = true;
  try {
    const sellerRes = await Promise.allSettled([indexDao.refreshSellerInfo()]);
    const seller = sellerRes[0].status === 'fulfilled' ? sellerRes[0].value : { refreshed: 0, total: 0 };
    if (sellerRes[0].status === 'rejected') {
      logger.warn({ err: sellerRes[0].reason?.message }, 'index-sync: refreshSellerInfo 失败');
    }
    return {
      sellersRefreshed: seller.refreshed,
      sellersTotal: seller.total,
    };
  } finally {
    running = false;
  }
}

let startupTimer = null; // 启动延迟 setTimeout 句柄
let intervalTimer = null; // 周期 setInterval 句柄

export function startIndexSync() {
  if (startupTimer || intervalTimer) return;
  // 启动后 30 秒做首次扫描(错开 import-status-poller 的 30 秒 + stock-sync 的 1 分钟)
  // 让数据先就绪,本任务再批量刷新索引
  startupTimer = setTimeout(() => {
    startupTimer = null;
    scanOnce()
      .then((r) => {
        logger.info(r, 'index-sync: 首次刷新完成');
      })
      .catch((e) => logger.warn({ err: e.message }, 'index-sync 首次刷新异常'));
    intervalTimer = setInterval(() => {
      scanOnce()
        .then((r) => {
          logger.info(r, 'index-sync: 刷新完成');
        })
        .catch((e) => logger.warn({ err: e.message }, 'index-sync 刷新异常'));
    }, SYNC_INTERVAL_MS);
    intervalTimer.unref();
  }, STARTUP_DELAY_MS);
  startupTimer.unref();
  logger.info(
    { intervalMin: SYNC_INTERVAL_MS / 60000 },
    'index-sync: 已启动(5分钟刷新一次 seller 字段)'
  );
}

export function stopIndexSync() {
  // 同时清理启动延迟 setTimeout 与周期 setInterval,避免 30 秒内停机出现"僵尸 setInterval"
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
