// DAO 工厂:按 DB_DRIVER 环境变量注入 mongo 或 sqlite 实现
// 模块层(cache.js / collect-queue.js)只依赖此处导出的 daos,不感知底层驱动
// 切换方式:在 .env 中设置 DB_DRIVER=sqlite|mongo(默认 sqlite)
import dotenv from 'dotenv';
dotenv.config();

const DRIVER = process.env.DB_DRIVER || 'sqlite';

let daosPromise = null;

/**
 * 获取 DAO 集合(单例,首次调用时初始化)
 * @returns {Promise<Object>} { searchDao, bundleDao, cardDao, composerDao, entrypointDao,
 *   richMediaDao, detailDao, marketStatsDao, followSellDao,
 *   autoCollectLogDao, storeClassificationDao, storeSkuDao,
 *   collectQueueTasksDao, collectQueueOpsDao }
 */
export function getDaos() {
  if (!daosPromise) {
    daosPromise = (async () => {
      let daos;
      if (DRIVER === 'mongo') {
        daos = await import('./dao/mongo/index.js').then((m) => m.createMongoDaos());
      } else {
        daos = await import('./dao/sqlite/index.js').then((m) => m.createSqliteDaos());
      }
      console.log(`[db] driver=${DRIVER}`);
      return daos;
    })();
  }
  return daosPromise;
}

export function getDriver() {
  return DRIVER;
}
