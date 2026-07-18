// 索引表跨表字段同步定时任务
// 周期性刷新 ozon_cache_index 中无法在数据表 upsert 时同步的字段:
//   - seller_slug / seller_name / searchable_text(从 ozon_auto_collect_log + ozon_store_classification 取)
//   - listed(从 follow_sell_task_items 取,offer_id LIKE sku || '-%')
//
// 规则:
//   - 每 5 分钟扫描一次
//   - 全量刷新(轻量 SQL,单次约毫秒级)
//   - 索引表的命中位 / 冗余展示字段在数据表 upsert 时已由 indexDao.syncSku 即时同步
//
// 关联:
//   - 与 domDao / attributeDao / richMediaDao / marketStatsDao / followSellDao 解耦
//   - 数据表 upsert 时只更新本表字段 + 触发 indexDao.syncSku(即时)
//   - 本任务只负责跨表聚合的 seller/listed 字段(延迟可接受)
import { indexDao } from '../db/dao/sqlite/index-dao.js';
import logger from '../middleware/log.js';

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

// 单次扫描:返回 { sellersRefreshed, listedRefreshed }
async function scanOnce() {
  const [sellerRes, listedRes] = await Promise.all([
    indexDao.refreshSellerInfo(),
    indexDao.refreshListedStatus(),
  ]);
  return {
    sellersRefreshed: sellerRes.refreshed,
    sellersTotal: sellerRes.total,
    listedRefreshed: listedRes.refreshed,
    listedTotal: listedRes.total,
  };
}

let timer = null;

export function startIndexSync() {
  if (timer) return;
  // 启动后 30 秒做首次扫描(错开 import-status-poller 的 30 秒 + stock-sync 的 1 分钟)
  // 让数据先就绪,本任务再批量刷新索引
  setTimeout(() => {
    scanOnce()
      .then((r) => {
        logger.info(r, 'index-sync: 首次刷新完成');
      })
      .catch((e) => logger.warn({ err: e.message }, 'index-sync 首次刷新异常'));
    timer = setInterval(() => {
      scanOnce()
        .then((r) => {
          logger.info(r, 'index-sync: 刷新完成');
        })
        .catch((e) => logger.warn({ err: e.message }, 'index-sync 刷新异常'));
    }, SYNC_INTERVAL_MS);
    timer.unref();
  }, 30 * 1000).unref();
  logger.info(
    { intervalMin: SYNC_INTERVAL_MS / 60000 },
    'index-sync: 已启动(5分钟刷新一次 seller/listed 字段)'
  );
}

export function stopIndexSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
