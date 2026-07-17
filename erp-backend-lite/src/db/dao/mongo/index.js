// MongoDB DAO 入口:组合所有 DAO 实例,由 adapter.js 调用
import { getMongo } from '../../mongo.js';
import { createCacheDao } from './cache-daos.js';
import { bundleDao } from './bundle-dao.js';
import { autoCollectLogDao } from './log-dao.js';
import { storeClassificationDao, storeSkuDao } from './store-daos.js';
import { collectQueueTasksDao, collectQueueOpsDao } from './queue-daos.js';

/**
 * 创建 MongoDB DAO 集合
 * 首次调用时建立 MongoDB 连接 + ensureIndexes
 */
export async function createMongoDaos() {
  await getMongo(); // 触发连接 + 索引建立

  // 9 类缓存 DAO:composer/entrypoint 为 legacy,仅保留 getBySku/upsert/deleteBySku
  const searchDao = createCacheDao('searchCache', 'ozon_search_cache');
  const cardDao = createCacheDao('cardCache', 'ozon_card_cache');
  const composerDao = createCacheDao('composerCache', 'ozon_composer_cache');
  const entrypointDao = createCacheDao('entrypointCache', 'ozon_entrypoint_cache');
  const richMediaDao = createCacheDao('richMediaCache', 'ozon_rich_media_cache');
  const detailDao = createCacheDao('detailCache', 'ozon_detail_cache');
  const marketStatsDao = createCacheDao('marketStatsCache', 'ozon_market_stats_cache', { hasL2Synced: true });
  const followSellDao = createCacheDao('followSellCache', 'ozon_follow_sell_cache', { hasL2Synced: true });

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
