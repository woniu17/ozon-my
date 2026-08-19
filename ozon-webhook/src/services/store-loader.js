// 店铺凭证加载器
// 从 erp-backend-lite/src/config/stores.json 读取店铺列表,构建 Map<seller_id, store>
// 凭据结构与 erp 对齐:
//   { id, name, company_id, warehouse_id, sync_credentials:{clientId, apiKey}, credentials_verified }
// 推送 payload 中的 seller_id === store.company_id === store.sync_credentials.clientId
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../config/index.js';
import logger from '../middleware/log.js';

// Map<seller_id_number, store>
const storeBySellerId = new Map();
// Map<store.id, store> —— 备用,后续 admin 接口可能用
const storeById = new Map();
// 记录最近一次加载时间,便于运行时刷新判断
let lastLoadedAt = null;
let lastLoadedPath = null;

export function loadStores() {
  const p = resolve(config.storesConfigPath);
  let raw;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch (err) {
    logger.error({ path: p, err: err.message }, 'stores.json 读取失败');
    storeBySellerId.clear();
    storeById.clear();
    return { count: 0, path: p, error: err.message };
  }

  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    logger.error({ path: p, err: err.message }, 'stores.json 解析失败');
    storeBySellerId.clear();
    storeById.clear();
    return { count: 0, path: p, error: err.message };
  }

  if (!Array.isArray(list)) {
    logger.error({ path: p, shape: typeof list }, 'stores.json 应为数组');
    return { count: 0, path: p, error: 'not an array' };
  }

  storeBySellerId.clear();
  storeById.clear();

  let validCount = 0;
  for (const s of list) {
    if (!s?.sync_credentials?.clientId || !s?.sync_credentials?.apiKey) {
      logger.warn({ storeId: s?.id, name: s?.name }, '店铺缺 sync_credentials,跳过');
      continue;
    }
    if (s.credentials_verified === false) {
      logger.warn({ storeId: s.id, name: s.name }, '店铺 credentials_verified=false,跳过');
      continue;
    }
    // seller_id 推送用 company_id(数字);clientId 是字符串但数值一致
    const sellerId = Number(s.company_id);
    if (!Number.isInteger(sellerId) || sellerId <= 0) {
      logger.warn({ storeId: s.id, companyId: s.company_id }, 'company_id 非法,跳过');
      continue;
    }
    storeBySellerId.set(sellerId, s);
    storeById.set(s.id, s);
    validCount++;
  }

  lastLoadedAt = new Date().toISOString();
  lastLoadedPath = p;
  logger.info(
    { count: validCount, total: list.length, path: p, loadedAt: lastLoadedAt },
    'stores.json 加载完成',
  );
  return { count: validCount, total: list.length, path: p };
}

/**
 * 按 seller_id(数字)取店铺对象
 * @param {number|string} sellerId
 * @returns {object|null}
 */
export function getStoreBySellerId(sellerId) {
  if (sellerId == null) return null;
  return storeBySellerId.get(Number(sellerId)) ?? null;
}

export function listStores() {
  return Array.from(storeBySellerId.values());
}

export function getStoresMeta() {
  return {
    count: storeBySellerId.size,
    lastLoadedAt,
    lastLoadedPath,
  };
}
