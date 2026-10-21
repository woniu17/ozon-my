// 采集箱同款分组定时重建(2026-10)
// 基于跟卖关系(ozon_follow_sell_cache)周期重建 ozon_cache_index.group_id / group_rep,
// 使采集箱"合并同款"功能保持最新(新采集的 SKU / 新抓取的跟卖数据会改变分组)。
// 30 分钟一次;全量扫描较重(读约 2.7 万 followSell + 6.5 万索引行),用 running 标志抑制重入。
import { collectDb } from '../db/collect-db.js';
import { rebuildSkuGroups } from '../modules/sku-groups.js';
import logger from '../middleware/log.js';

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
const STARTUP_DELAY_MS = 2 * 60 * 1000; // 启动 2 分钟后首次执行,避开启动期各轮询器高峰

let running = false;
let timer = null;

function scanOnce() {
  if (running) {
    logger.warn('sku-group-sync: 上一次重建仍在进行,本次跳过');
    return { skipped: true };
  }
  running = true;
  try {
    const stats = rebuildSkuGroups(collectDb, { apply: true });
    logger.info({ ...stats }, 'sku-group-sync: 同款分组重建完成');
    return stats;
  } catch (e) {
    logger.warn({ err: e.message }, 'sku-group-sync: 同款分组重建失败');
    return { error: e.message };
  } finally {
    running = false;
  }
}

export function startSkuGroupSync() {
  if (timer) return;
  setTimeout(() => {
    scanOnce();
  }, STARTUP_DELAY_MS);
  timer = setInterval(() => {
    scanOnce();
  }, SYNC_INTERVAL_MS);
}

export function stopSkuGroupSync() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}