// MongoDB DAO 入口:组合所有 DAO 实例,由 adapter.js 调用
// 注:Mongo 模式目前未实际启用,SQLite 是主路径
//     为保持接口一致,这里也提供 domDao/attributeDao/indexDao 同名出口
//     但实际查询逻辑走 SQLite 实现(见 sqlite/ 目录)
import { getMongo } from '../../mongo.js';
import { createCacheDao } from './cache-daos.js';
import { bundleDao } from './bundle-dao.js';
import { autoCollectLogDao } from './log-dao.js';
import { storeClassificationDao, storeSkuDao } from './store-daos.js';
import { collectQueueTasksDao, collectQueueOpsDao } from './queue-daos.js';

/**
 * 创建 MongoDB DAO 集合
 * 首次调用时建立 MongoDB 连接 + ensureIndexes
 * 注:目前 Mongo 模式不再维护新表结构,建议使用 SQLite 模式
 */
export async function createMongoDaos() {
  await getMongo(); // 触发连接 + 索引建立

  // 兼容老接口(实际未使用 Mongo 的新表结构,如需启用需补齐 domDao/attributeDao/indexDao)
  const searchDao = createCacheDao('searchCache', 'ozon_search_cache');
  const cardDao = createCacheDao('cardCache', 'ozon_card_cache');
  const richMediaDao = createCacheDao('richMediaCache', 'ozon_rich_media_cache');
  const detailDao = createCacheDao('detailCache', 'ozon_detail_cache');
  const marketStatsDao = createCacheDao('marketStatsCache', 'ozon_market_stats_cache', { hasL2Synced: true });
  const followSellDao = createCacheDao('followSellCache', 'ozon_follow_sell_cache', { hasL2Synced: true });

  return {
    // 兼容字段(Mongo 未实现新 DAO,走旧表)
    domDao: null,
    attributeDao: null,
    indexDao: null,
    // 兼容旧 dao
    searchDao,
    bundleDao,
    cardDao,
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
