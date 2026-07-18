// SQLite DAO 入口:组合所有 DAO 实例,由 adapter.js 调用
// 启动 TTL 清理器(替代 MongoDB TTL 索引)
import { createCacheDao } from './cache-daos.js';
import { domDao } from './dom-dao.js';
import { attributeDao } from './attribute-dao.js';
import { indexDao } from './index-dao.js';
import { autoCollectLogDao } from './log-dao.js';
import { storeClassificationDao, storeSkuDao } from './store-daos.js';
import { collectQueueTasksDao, collectQueueOpsDao } from './queue-daos.js';
import { startTtlCleaner } from './ttl-cleaner.js';

/**
 * 创建 SQLite DAO 集合
 * schema 已由 src/db/index.js 的 initSchema() 创建
 * 缓存表设计(6 张:1 索引 + 5 数据):
 *   ozon_cache_index        — 索引表(列表查询唯一入口)
 *   ozon_dom_cache          — card + detail 合并
 *   ozon_attribute_cache    — search + bundle 合并
 *   ozon_rich_media_cache   — PDP 富内容
 *   ozon_market_stats_cache — 市场统计
 *   ozon_follow_sell_cache  — 跟卖竞争
 */
export async function createSqliteDaos() {
  // 3 类独立缓存 DAO(走通用 createCacheDao)
  const richMediaDao = createCacheDao('ozon_rich_media_cache');
  const marketStatsDao = createCacheDao('ozon_market_stats_cache', { hasL2Synced: true });
  const followSellDao = createCacheDao('ozon_follow_sell_cache', { hasL2Synced: true });

  // 启动 TTL 清理器(仅 SQLite 模式需要)
  startTtlCleaner();

  return {
    // 新增:合并表 DAO
    domDao,
    attributeDao,
    indexDao,
    // 独立缓存 DAO
    richMediaDao,
    marketStatsDao,
    followSellDao,
    // 其他业务 DAO
    autoCollectLogDao,
    storeClassificationDao,
    storeSkuDao,
    collectQueueTasksDao,
    collectQueueOpsDao,
  };
}
