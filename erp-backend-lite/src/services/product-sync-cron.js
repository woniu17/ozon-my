// 商品定时同步(2026-09):每 8 小时(0点/8点/16点)自动同步所有店铺商品+详情
// 模式:沿用现有 poller 模式(setInterval + .unref())
// 串行执行避免 Ozon 限流;全程静默,结果只写日志
import { readStores, runStoreSync, runStoreSyncDescriptions } from '../modules/admin.js';
import logger from '../middleware/log.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟检查一次
const SYNC_HOURS = new Set([0, 8, 16]); // 0点/8点/16点执行

let timer = null;
let running = false; // 重入抑制:上轮未完成跳过本轮
let lastRunKey = null; // 防止同一执行窗口重复触发(格式: yyyy-MM-dd HH)

/** 检查当前是否到达执行窗口(0/8/16点的5分钟内) */
function shouldRun(now) {
  const hour = now.getHours();
  if (!SYNC_HOURS.has(hour)) return false;
  // 执行窗口:该小时的 0~5 分钟(给进程启动/重启留容错)
  if (now.getMinutes() > 5) return false;
  const date = now.toISOString().slice(0, 10);
  const key = `${date} ${hour}`;
  if (lastRunKey === key) return false; // 本窗口已执行过
  return true;
}

/** 串行同步所有店铺商品,全部完成后再串行同步详情 */
async function runSyncCycle() {
  if (running) {
    logger.info('[product-sync-cron] 上一轮同步未完成,跳过本轮');
    return;
  }
  running = true;
  const startedAt = Date.now();
  let stores = [];
  try {
    stores = readStores();
  } catch (e) {
    logger.error({ err: e.message }, '[product-sync-cron] 读取店铺列表失败');
    running = false;
    return;
  }
  if (!stores.length) {
    logger.warn('[product-sync-cron] 无店铺,跳过同步');
    running = false;
    return;
  }

  logger.info({ storeCount: stores.length }, '[product-sync-cron] 开始定时同步(商品→详情串行)');

  // 阶段1:串行同步所有店铺商品
  let productOk = 0, productFail = 0;
  for (const s of stores) {
    const storeId = s.id;
    const storeName = s.name || storeId;
    const t0 = Date.now();
    try {
      await runStoreSync(s, storeId);
      productOk++;
      logger.info(
        { storeId, storeName, durationMs: Date.now() - t0 },
        '[product-sync-cron] 商品同步完成'
      );
    } catch (e) {
      productFail++;
      logger.error(
        { storeId, storeName, errMessage: e?.message ?? String(e), durationMs: Date.now() - t0 },
        '[product-sync-cron] 商品同步失败,跳过该店铺继续下一家'
      );
    }
  }

  // 阶段2:串行同步所有店铺详情(force=false 增量,只拉未缓存的)
  let detailsOk = 0, detailsFail = 0;
  for (const s of stores) {
    const storeId = s.id;
    const storeName = s.name || storeId;
    const t0 = Date.now();
    try {
      await runStoreSyncDescriptions(s, storeId, false);
      detailsOk++;
      logger.info(
        { storeId, storeName, durationMs: Date.now() - t0 },
        '[product-sync-cron] 详情同步完成'
      );
    } catch (e) {
      detailsFail++;
      logger.error(
        { storeId, storeName, errMessage: e?.message ?? String(e), durationMs: Date.now() - t0 },
        '[product-sync-cron] 详情同步失败,跳过该店铺继续下一家'
      );
    }
  }

  const totalMs = Date.now() - startedAt;
  logger.info(
    { storeCount: stores.length, productOk, productFail, detailsOk, detailsFail, totalMs },
    '[product-sync-cron] 本次定时同步完成'
  );
  running = false;
}

/** 启动定时同步(每 5 分钟检查是否到达执行窗口) */
export function startProductSyncCron() {
  if (timer) return timer;
  const tick = () => {
    const now = new Date();
    if (shouldRun(now)) {
      lastRunKey = `${now.toISOString().slice(0, 10)} ${now.getHours()}`;
      // 异步执行,不阻塞 setInterval
      runSyncCycle().catch((e) => {
        logger.error({ errMessage: e?.message ?? String(e) }, '[product-sync-cron] 未捕获异常(不应到达)');
        running = false;
      });
    }
  };
  // 启动后 5 分钟首次检查(避免启动瞬间刚好命中执行窗口时重复触发)
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  logger.info(
    { hours: Array.from(SYNC_HOURS).join(',') },
    '[product-sync-cron] 定时同步已启动(0点/8点/16点静默执行)'
  );
  return timer;
}

/** 停止定时同步(优雅退出用) */
export function stopProductSyncCron() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('[product-sync-cron] 定时同步已停止');
  }
}
