// SQLite DAO 入口:组合所有 DAO 实例,由 adapter.js 调用
// 启动 TTL 清理器(替代 MongoDB TTL 索引)
import { createCacheDao } from './cache-daos.js';
import { bundleDao } from './bundle-dao.js';
import { autoCollectLogDao } from './log-dao.js';
import { storeClassificationDao, storeSkuDao } from './store-daos.js';
import { collectQueueTasksDao, collectQueueOpsDao } from './queue-daos.js';
import { startTtlCleaner } from './ttl-cleaner.js';

/**
 * 创建 SQLite DAO 集合
 * schema 已由 src/db/index.js 的 initSchema() 创建(包含 14 张表)
 */
export async function createSqliteDaos() {
  // 9 类缓存 DAO:composer/entrypoint 为 legacy
  const searchDao = createCacheDao('ozon_search_cache');
  const cardDao = createCacheDao('ozon_card_cache');
  const composerDao = createCacheDao('ozon_composer_cache');
  const entrypointDao = createCacheDao('ozon_entrypoint_cache');
  const richMediaDao = createCacheDao('ozon_rich_media_cache');
  const detailDao = createCacheDao('ozon_detail_cache');
  const marketStatsDao = createCacheDao('ozon_market_stats_cache', { hasL2Synced: true });
  const followSellDao = createCacheDao('ozon_follow_sell_cache', { hasL2Synced: true });

  // 启动 TTL 清理器(仅 SQLite 模式需要)
  startTtlCleaner();

  return {
    searchDao,
    bundleDao,
    cardDao,
    composerDao,
    entrypointDao,
    richMediaDao,
    detailDao,
    marketStatsDao,
    followSellDao,
    autoCollectLogDao,
    storeClassificationDao,
    storeSkuDao,
    collectQueueTasksDao,
    collectQueueOpsDao,
  };
}
