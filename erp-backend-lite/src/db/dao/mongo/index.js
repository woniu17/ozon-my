// MongoDB DAO 入口:组合所有 DAO 实例,由 adapter.js 调用
// 注:Mongo 模式目前未实际启用,SQLite 是主路径
//     新增的 domDao/attributeDao/indexDao 仅在 SQLite 模式下有实现,
//     Mongo 模式启用时这些 DAO 会抛出明确错误(避免调用方拿到 null 后 NPE 难以排查)
//     旧的 searchDao/cardDao/detailDao/bundleDao 已移除(对应集合已废弃,合并到 dom/attribute),
//     Mongo 模式若要启用,需先补齐 domDao/attributeDao/indexDao 三个新 DAO 实现。
import { getMongo } from '../../mongo.js';
import { createCacheDao } from './cache-daos.js';
import { autoCollectLogDao } from './log-dao.js';
import { storeClassificationDao, storeSkuDao } from './store-daos.js';
import { collectQueueTasksDao, collectQueueOpsDao } from './queue-daos.js';

// 不支持的方法 stub:抛出明确错误而非返回 null(防止调用方 NPE)
function makeUnsupportedDao(name) {
  const err = new Error(
    `Mongo 模式不支持 ${name}(新表结构仅在 SQLite 模式下有实现)。请设置 DB_DRIVER=sqlite 或为 Mongo 补齐 ${name} 实现。`
  );
  // 拦截所有可能的属性访问,统一抛错
  // 白名单:symbol 属性(如 Symbol.toPrimitive/Symbol.iterator)+ then
  //   (避免 await/解构/隐式转换触发意外抛错,这些场景应该走 undefined 而非 throw)
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') return undefined; // 避免 await dao 时被当作 thenable
        throw err;
      },
    }
  );
}

/**
 * 创建 MongoDB DAO 集合
 * 首次调用时建立 MongoDB 连接 + ensureIndexes
 * 注:目前 Mongo 模式不再维护新表结构,建议使用 SQLite 模式
 */
export async function createMongoDaos() {
  await getMongo(); // 触发连接 + 索引建立

  // 3 类独立缓存 DAO 仍可用(对应集合未废弃)
  const richMediaDao = createCacheDao('richMediaCache', 'ozon_rich_media_cache');
  const marketStatsDao = createCacheDao('marketStatsCache', 'ozon_market_stats_cache', { hasL2Synced: true });
  const followSellDao = createCacheDao('followSellCache', 'ozon_follow_sell_cache', { hasL2Synced: true });

  return {
    // 新 DAO 在 Mongo 模式下未实现,访问任意方法都会抛出明确错误
    // (替代原来的 null,避免调用方拿到 null 后 NPE)
    domDao: makeUnsupportedDao('domDao'),
    attributeDao: makeUnsupportedDao('attributeDao'),
    indexDao: makeUnsupportedDao('indexDao'),
    shallowCollectLogDao: makeUnsupportedDao('shallowCollectLogDao'),
    // 3 类独立缓存 DAO
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
