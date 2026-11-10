// 发运单「添加货件」候选缓存(2026-11-10)
//
// 背景:Ozon /v4/posting/fbs/unfulfilled/list 服务器端响应实测 8~20 秒(与窗口/with/status
// 参数无关),available-postings 每次打开弹窗都串行拉未妥投池(2 页)+ 当前发运单列表,
// 总计 20~35 秒(pm2 日志确认 17~33s),用户体感"加载很慢"。
//
// 本模块缓存 Ozon 原始数据:
//   - 未妥投池(storeId|deliveryMethodId):全部 awaiting_deliver 货件原始对象
//   - 当前发运单货件号(storeId|carriageId):carriagePostingList 返回的 posting_number
// 本地富化(商品图/发货日期/跨店标记/历史标记)每次实时做(毫秒级),保证标记基于最新数据库。
// 缓存带并发去重:同一 key 未命中时多个请求只打一次 Ozon,其余等待同一 Promise。
// 写操作(set-postings/reship)成功后必须调用 invalidateCarriageCandidateCaches 失效。

const TTL_UNFULFILLED_MS = 120 * 1000; // 未妥投池 2 分钟
const TTL_CARRIAGE_POSTINGS_MS = 120 * 1000; // 当前发运单货件列表 2 分钟

const unfulfilledCache = new Map(); // key: `${storeId}|${deliveryMethodId}` → { postings, fetchedAt }
const carriageCache = new Map(); // key: `${storeId}|${carriageId}` → { numbers, fetchedAt }
const inflightUnfulfilled = new Map(); // key → Promise<postings[]>
const inflightCarriage = new Map(); // key → Promise<string[]>

function uKey(storeId, deliveryMethodId) {
  return `${storeId}|${deliveryMethodId}`;
}

function cKey(storeId, carriageId) {
  return `${storeId}|${carriageId}`;
}

/** 读取未妥投池缓存(返回深拷贝,调用方可安全富化);未命中/过期返回 null */
export function getCachedUnfulfilled(storeId, deliveryMethodId, maxAgeMs = TTL_UNFULFILLED_MS) {
  const item = unfulfilledCache.get(uKey(storeId, deliveryMethodId));
  if (!item) return null;
  if (Date.now() - item.fetchedAt > maxAgeMs) {
    unfulfilledCache.delete(uKey(storeId, deliveryMethodId));
    return null;
  }
  return structuredClone(item.postings);
}

/** 读取当前发运单货件号缓存(返回副本);未命中/过期返回 null */
export function getCachedCarriagePostings(storeId, carriageId, maxAgeMs = TTL_CARRIAGE_POSTINGS_MS) {
  const item = carriageCache.get(cKey(storeId, carriageId));
  if (!item) return null;
  if (Date.now() - item.fetchedAt > maxAgeMs) {
    carriageCache.delete(cKey(storeId, carriageId));
    return null;
  }
  return item.numbers.slice();
}

/** 获取未妥投池:缓存命中返回副本;未命中用 fetcher 拉取并缓存(并发去重) */
export async function getOrFetchUnfulfilled(store, deliveryMethodId, fetcher) {
  const key = uKey(store.id, deliveryMethodId);
  const cached = getCachedUnfulfilled(store.id, deliveryMethodId);
  if (cached) return cached;
  if (inflightUnfulfilled.has(key)) return inflightUnfulfilled.get(key);
  const p = (async () => {
    const postings = await fetcher();
    unfulfilledCache.set(key, { postings: structuredClone(postings), fetchedAt: Date.now() });
    return structuredClone(postings);
  })().finally(() => inflightUnfulfilled.delete(key));
  inflightUnfulfilled.set(key, p);
  return p;
}

/** 获取当前发运单货件号:缓存命中返回副本;未命中用 fetcher 拉取并缓存(并发去重) */
export async function getOrFetchCarriagePostings(store, carriageId, fetcher) {
  const key = cKey(store.id, carriageId);
  const cached = getCachedCarriagePostings(store.id, carriageId);
  if (cached) return cached;
  if (inflightCarriage.has(key)) return inflightCarriage.get(key);
  const p = (async () => {
    const numbers = await fetcher();
    carriageCache.set(key, { numbers: numbers.slice(), fetchedAt: Date.now() });
    return numbers.slice();
  })().finally(() => inflightCarriage.delete(key));
  inflightCarriage.set(key, p);
  return p;
}

/** 失效缓存:写操作(set-postings/reship)后调用;carriageId 为空时只失效该店铺全部未妥投池 */
export function invalidateCarriageCandidateCaches(storeId, carriageId) {
  for (const key of [...unfulfilledCache.keys()]) {
    if (key.startsWith(`${storeId}|`)) unfulfilledCache.delete(key);
  }
  if (carriageId != null) {
    carriageCache.delete(cKey(storeId, carriageId));
  }
}

/** 后台预热未妥投池(发运单详情加载后 fire-and-forget,不阻塞响应);已缓存/拉取中则复用 */
export function warmUnfulfilledCache(store, deliveryMethodId, fetcher) {
  if (deliveryMethodId == null || deliveryMethodId === '') return;
  if (getCachedUnfulfilled(store.id, deliveryMethodId)) return;
  void getOrFetchUnfulfilled(store, deliveryMethodId, fetcher).catch(() => {
    // 预热失败不打扰用户,后续打开弹窗时会重新拉取
  });
}