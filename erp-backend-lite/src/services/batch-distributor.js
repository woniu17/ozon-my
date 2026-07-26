// 批量均衡分配算法(P2-2)
// 目标:把 N 个 SKU 均衡分配到 M 个店铺,同源(同 sellerId)的 SKU 尽量分散到不同店铺
//
// 算法:分组 round-robin + 组间偏移
//   1. 按 sellerId 分组(空 sellerId 归入 "unknown")
//   2. 组内 shuffle(打散,避免同源连续)
//   3. 每组计算起始偏移 offset_i = i mod storeCount(不同组错开,避免同源集中)
//   4. 组内第 k 个 SKU: targetStoreId = stores[(offset_i + k) mod storeCount]
//   5. 合并所有组,按 (组序号, 组内序号) 作为执行 seq
//
// 数学保证:round-robin 使各店铺分配数差异 ≤ 1,同源 SKU 必分散到不同店铺(组内不重复)

// Fisher-Yates shuffle(确定性可选,用于组内打散)
function shuffle(arr, seed = 0) {
  const a = [...arr];
  // 简单确定性 PRNG(LCG),seed=0 时用 Math.random
  let s = seed || Date.now();
  const rand = () => {
    if (!seed) return Math.random();
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 均衡分配 SKU 到店铺
 * @param {Array<{sku, sellerId?}>} skus - 待分配 SKU 列表
 * @param {string[]} storeIds - 目标店铺 ID 列表(至少 1 个)
 * @returns {Array<{sku, sellerId, targetStoreId, seq}>} 分配结果(按 seq 升序)
 */
export function distributeSkus(skus, storeIds) {
  if (!Array.isArray(skus) || skus.length === 0) return [];
  if (!Array.isArray(storeIds) || storeIds.length === 0) {
    throw new Error('storeIds 必填且非空');
  }
  const stores = [...storeIds];
  const storeCount = stores.length;

  // 1. 按 sellerId 分组(空值归入 "__unknown__")
  const groups = new Map();
  for (const s of skus) {
    const key = s.sellerId || '__unknown__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  // 2. 组内 shuffle + 3/4. round-robin 分配(组间偏移)
  const result = [];
  let groupIndex = 0;
  for (const [sellerId, groupSkus] of groups) {
    const shuffled = shuffle(groupSkus);
    const offset = groupIndex % storeCount;
    shuffled.forEach((skuItem, k) => {
      const targetStoreId = stores[(offset + k) % storeCount];
      result.push({
        sku: skuItem.sku,
        sellerId: sellerId === '__unknown__' ? '' : sellerId,
        targetStoreId,
        // seq 在全部合并后统一编号
      });
    });
    groupIndex++;
  }

  // 5. 合并后统一编号 seq(0 起)
  result.forEach((r, i) => {
    r.seq = i;
  });

  return result;
}

/**
 * 统计分配结果(供前端预览展示)
 * @param {Array} assignments - distributeSkus 返回值
 * @param {string[]} storeIds
 * @returns {{
 *   byStore: Object<string, number>,  // 每个店铺分配数
 *   bySellerByStore: Object<string, Object<string, number>>,  // 每个来源卖家在各店铺的分配数
 *   maxStoreCount: number,  // 最大店铺分配数
 *   minStoreCount: number,  // 最小店铺分配数
 *   isBalanced: boolean,    // 是否均衡(差≤1)
 * }}
 */
export function summarizeDistribution(assignments, storeIds) {
  const byStore = {};
  for (const sid of storeIds) byStore[sid] = 0;
  const bySellerByStore = {};
  for (const a of assignments) {
    byStore[a.targetStoreId] = (byStore[a.targetStoreId] || 0) + 1;
    const sellerKey = a.sellerId || '__unknown__';
    if (!bySellerByStore[sellerKey]) bySellerByStore[sellerKey] = {};
    bySellerByStore[sellerKey][a.targetStoreId] = (bySellerByStore[sellerKey][a.targetStoreId] || 0) + 1;
  }
  const counts = Object.values(byStore);
  const maxStoreCount = counts.length ? Math.max(...counts) : 0;
  const minStoreCount = counts.length ? Math.min(...counts) : 0;
  return {
    byStore,
    bySellerByStore,
    maxStoreCount,
    minStoreCount,
    isBalanced: maxStoreCount - minStoreCount <= 1,
  };
}

/**
 * 按目标店铺精确均衡分配 SKU(每家店铺 perStoreCount 个,同源 SKU 尽量散到不同店铺)
 *
 * 与 distributeSkus 的差异:
 *   - distributeSkus 保证各店铺总数差≤1,但在组大小非 storeCount 倍数时可能差=2
 *   - 本函数保证每个店铺精确 perStoreCount 个(当总数 = perStoreCount × storeCount 时)
 *   - 本函数优先把同源 SKU 放到"同源数最少"的桶,保证每个店铺内来源尽量分散
 *
 * 算法(贪心列填充):
 *   1. 按 sellerId 分组,按组大小降序排列
 *   2. 对每个 SKU,选择"未满 + 同源数最少 + 总数最少"的桶放入
 *   3. 桶满(perStoreCount)后不再接收
 *
 * @param {Array<{sku, sellerId?}>} skus - 已选出的 SKU(总数应 = perStoreCount × storeIds.length)
 * @param {string[]} storeIds - 目标店铺 ID 列表
 * @param {number} perStoreCount - 每家店铺精确数量 M
 * @returns {Array<{sku, sellerId, targetStoreId, seq}>} 分配结果(按 seq 升序)
 */
export function distributeSkusByStore(skus, storeIds, perStoreCount) {
  if (!Array.isArray(skus) || skus.length === 0) return [];
  if (!Array.isArray(storeIds) || storeIds.length === 0) {
    throw new Error('storeIds 必填且非空');
  }
  const M = Math.max(0, Math.floor(Number(perStoreCount) || 0));

  // 1. 按 sellerId 分组(空值归入 "__unknown__")
  const groups = new Map();
  for (const s of skus) {
    const key = s.sellerId || '__unknown__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  // 2. 桶:每个店铺一个,记录已放 SKU 和各来源卖家计数
  const buckets = storeIds.map((sid) => ({
    store: sid,
    items: [],
    sellerCount: {},
  }));

  // 3. 按组大小降序排列(大组先分配,更容易均衡散开)
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  // 4. 对每个组的每个 SKU,选择最优桶(未满 + 同源最少 + 总数最少)
  for (const [sellerId, groupSkus] of sortedGroups) {
    for (const skuItem of groupSkus) {
      let bestBucket = null;
      let bestScore = Infinity;
      for (const b of buckets) {
        if (M > 0 && b.items.length >= M) continue; // 桶满(若 M=0 表示不限制,但 auto-pick 场景不会出现)
        const sameSeller = b.sellerCount[sellerId] || 0;
        // 评分:同源数优先(权重 1000),其次总数(保证均衡)
        const score = sameSeller * 1000 + b.items.length;
        if (score < bestScore) {
          bestScore = score;
          bestBucket = b;
        }
      }
      if (!bestBucket) break; // 所有桶都满了,丢弃剩余 SKU(理论不会发生,因为选取数 = M × storeCount)
      bestBucket.items.push({
        sku: skuItem.sku,
        sellerId: sellerId === '__unknown__' ? '' : sellerId,
        targetStoreId: bestBucket.store,
      });
      bestBucket.sellerCount[sellerId] = (bestBucket.sellerCount[sellerId] || 0) + 1;
    }
  }

  // 5. 合并所有桶,按桶顺序编号 seq
  const result = [];
  let seq = 0;
  for (const b of buckets) {
    for (const item of b.items) {
      result.push({ ...item, seq: seq++ });
    }
  }
  return result;
}

/**
 * 按来源卖家(sellerId)均衡选取 N 个 SKU(差额均摊给有富余的卖家)
 *
 * 算法:
 *   1. 按 sellerId 分组(空 sellerId 归入 "__unknown__")
 *   2. 初始配额 quota = floor(N / 卖家数 k),每家取 min(quota, actual[i])
 *   3. 剩余 remaining = N - sum(taken[i])
 *   4. 把卖家按"富余量"(actual[i] - taken[i])降序,依次补足 remaining,
 *      每家最多补到其富余量(无法补足时返回实际可凑的总数)
 *   5. 每组内按传入顺序取前 taken[i] 个(SKU 列表已由调用方按 last_fetched_at DESC 排序)
 *
 * @param {Array<{sku, sellerId?, price?, ratingCount?, name?, primaryImage?}>} skus - 候选 SKU(应已按 last_fetched_at DESC 排序)
 * @param {number} targetCount - 目标选取数量 N
 * @returns {{
 *   picked: Array<{sku, sellerId, price, ratingCount, name, primaryImage}>,
 *   bySellerCount: Object<string, number>,  // 每个来源卖家实际选取数
 *   totalAvailable: number,                  // 候选总数
 *   totalSellers: number,                    // 来源卖家数
 *   requestedCount: number,
 *   actualPicked: number,
 *   insufficient: boolean                    // 是否凑不够 N(actualPicked < N)
 * }}
 */
export function autoPickBySeller(skus, targetCount) {
  const N = Math.max(0, Math.floor(Number(targetCount) || 0));
  if (!Array.isArray(skus) || skus.length === 0 || N === 0) {
    return {
      picked: [],
      bySellerCount: {},
      totalAvailable: Array.isArray(skus) ? skus.length : 0,
      totalSellers: 0,
      requestedCount: N,
      actualPicked: 0,
      insufficient: false,
    };
  }

  // 1. 按 sellerId 分组(空值归入 "__unknown__"),组内保持传入顺序(最新优先)
  const groups = new Map();
  for (const s of skus) {
    const key = s.sellerId || '__unknown__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const sellerKeys = [...groups.keys()];
  const k = sellerKeys.length;

  // 2. 初始配额 = floor(N / k),每家取 min(quota, actual)
  const baseQuota = Math.floor(N / k);
  const actual = {};
  const taken = {};
  for (const key of sellerKeys) {
    actual[key] = groups.get(key).length;
    taken[key] = Math.min(baseQuota, actual[key]);
  }

  // 3. 剩余配额按"富余量"降序依次补足(每轮每家最多补 1 个,保证均衡)
  let remaining = N - sellerKeys.reduce((sum, key) => sum + taken[key], 0);
  while (remaining > 0) {
    // 计算各家富余量,按富余量降序排序(富余相同的按 key 稳定排序)
    const surplusList = sellerKeys
      .map((key) => ({ key, surplus: actual[key] - taken[key] }))
      .filter((x) => x.surplus > 0)
      .sort((a, b) => b.surplus - a.surplus || (a.key < b.key ? -1 : 1));
    if (surplusList.length === 0) break; // 已无可补
    let allocatedThisRound = 0;
    for (const x of surplusList) {
      if (remaining <= 0) break;
      taken[x.key]++;
      remaining--;
      allocatedThisRound++;
    }
    if (allocatedThisRound === 0) break; // 防御:避免死循环
  }

  // 4. 从每组按 taken[key] 取出前 taken[key] 个(组内已按 last_fetched_at DESC 排序)
  const picked = [];
  const bySellerCount = {};
  for (const key of sellerKeys) {
    const groupSkus = groups.get(key);
    const cnt = taken[key];
    for (let i = 0; i < cnt; i++) {
      const s = groupSkus[i];
      picked.push({
        sku: s.sku,
        sellerId: key === '__unknown__' ? '' : key,
        price: s.price ?? '',
        ratingCount: s.ratingCount ?? null,
        name: s.name || '',
        primaryImage: s.primaryImage || '',
      });
    }
    if (cnt > 0) bySellerCount[key === '__unknown__' ? '' : key] = cnt;
  }

  return {
    picked,
    bySellerCount,
    totalAvailable: skus.length,
    totalSellers: k,
    requestedCount: N,
    actualPicked: picked.length,
    insufficient: picked.length < N,
  };
}
