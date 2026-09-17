// 店铺查找(自 ozon-webhook store-loader.js 重写,2026-09-17)
// 原实现:文件读取 + POST /admin/stores/reload 手工热刷新 → 全部废弃
// 现实现:erp config.loadStores() 每次调用直读 stores.json(天然热加载),
//         同进程读同一文件,无需缓存失效通知
// 校验规则对齐原 store-loader:缺 sync_credentials / credentials_verified=false / company_id 非法 → 跳过
import config from '../../config/index.js';

function validStores() {
  const list = config.loadStores();
  if (!Array.isArray(list)) return [];
  return list.filter((s) => {
    if (!s?.sync_credentials?.clientId || !s?.sync_credentials?.apiKey) return false;
    if (s.credentials_verified === false) return false;
    // seller_id 推送用 company_id(数字);clientId 是字符串但数值一致
    const sellerId = Number(s.company_id);
    if (!Number.isInteger(sellerId) || sellerId <= 0) return false;
    return true;
  });
}

/**
 * 按 seller_id(数字)取店铺对象
 * @param {number|string} sellerId
 * @returns {object|null}
 */
export function getStoreBySellerId(sellerId) {
  if (sellerId == null) return null;
  const n = Number(sellerId);
  return validStores().find((s) => Number(s.company_id) === n) ?? null;
}

export function listStores() {
  return validStores();
}

// /webhook/health 元信息(热加载模式下无缓存,无加载时间戳)
export function getStoresMeta() {
  return {
    count: validStores().length,
    lastLoadedAt: null,
    lastLoadedPath: 'src/config/stores.json(erp 热加载)',
  };
}
