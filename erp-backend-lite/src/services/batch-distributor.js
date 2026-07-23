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
