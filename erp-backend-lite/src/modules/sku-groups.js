// 采集箱同款分组(基于跟卖关系并查集)
// ─────────────────────────────────────────────────────────────
// 背景:深度采集为主 SKU 抓取 Ozon"其他卖家报价"列表(ozon_follow_sell_cache.sellers),
//       不同卖家对同一款产品各自建商品卡(标题/图片各写各的),平台将其聚合为"其他卖家"。
//       因此 followSell 关系可作为"同款商品"的启发式信号。
// 分组规则(用户已确认):单向关系 —— 若 A 的跟卖列表含 B,且 A、B 都在采集箱 → 同一组。
// 代表 SKU 选择(用户已确认):
//   ① 数据完整度(dom+attribute+richMedia 全命中,能直接上架预览)
//   ② 已跟卖(listed=1)
//   ③ 已导出(exported=1)
//   ④ 价格低(price_value 升序)
//   ⑤ 评论多(rating_count)
//   ⑥ 采集时间新(last_fetched_at)
// ─────────────────────────────────────────────────────────────
// 用法:
//   import { rebuildSkuGroups } from './src/modules/sku-groups.js';
//   const stats = rebuildSkuGroups(db, { apply: true });
//   db 需为 node:sqlite DatabaseSync 连接(含 ozon_cache_index / ozon_follow_sell_cache)。

const BATCH = 5000;

export function rebuildSkuGroups(db, { apply = false } = {}) {
  // ── 1. 采集箱 SKU 集合 + 代表评分所需属性 ──
  const rows = db
    .prepare(
      `SELECT sku, card_hit, detail_hit, search_hit, bundle_hit, rich_media_hit,
              listed, exported, price_value, rating_count, last_fetched_at
       FROM ozon_cache_index`
    )
    .all();
  const info = new Map(); // sku -> 行数据
  for (const r of rows) info.set(r.sku, r);

  // ── 2. 并查集:遍历 followSell 缓存,主SKU与其跟卖中也在采集箱的SKU 合并 ──
  const parent = new Map();
  const find = (x) => {
    let p = parent.get(x);
    if (p === undefined) {
      parent.set(x, x);
      return x;
    }
    if (p !== parent.get(p)) parent.set(x, find(p));
    return parent.get(x);
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const total = db.prepare('SELECT COUNT(*) AS n FROM ozon_follow_sell_cache').get().n;
  let linkedPairs = 0;
  for (let off = 0; off < total; off += BATCH) {
    const batch = db
      .prepare('SELECT _id, data FROM ozon_follow_sell_cache LIMIT ? OFFSET ?')
      .all(BATCH, off);
    for (const row of batch) {
      if (!info.has(row._id)) continue; // 主SKU不在采集箱,其跟卖关系不影响采集箱分组
      let d;
      try {
        d = JSON.parse(row.data);
      } catch {
        continue;
      }
      const sellers = Array.isArray(d.sellers) ? d.sellers : [];
      for (const s of sellers) {
        const sku = String(s.sku || '').trim();
        if (sku && info.has(sku)) {
          union(row._id, sku);
          linkedPairs++;
        }
      }
    }
  }

  // ── 3. 连通分量 → 分组 + 代表选择 ──
  const comp = new Map(); // root -> [skus]
  for (const sku of info.keys()) {
    const r = find(sku);
    if (!comp.has(r)) comp.set(r, []);
    comp.get(r).push(sku);
  }

  const scoreOf = (r) => ({
    completeness:
      (r.card_hit || r.detail_hit ? 1 : 0) +
      (r.search_hit && r.bundle_hit ? 1 : 0) +
      (r.rich_media_hit ? 1 : 0),
    listed: r.listed ? 1 : 0,
    exported: r.exported ? 1 : 0,
    price: r.price_value ?? null,
    rating: r.rating_count ?? 0,
    fetchedAt: r.last_fetched_at || '',
  });

  // a 优于 b 返回正数,否则返回负数/0
  const compareScore = (a, b) => {
    for (const key of ['completeness', 'listed', 'exported']) {
      if (a[key] !== b[key]) return a[key] - b[key];
    }
    const pa = a.price;
    const pb = b.price;
    if (pa !== null && pb !== null && pa !== pb) return pb - pa; // 价格低者优
    if (pa !== null && pb === null) return 1;
    if (pa === null && pb !== null) return -1;
    if (a.rating !== b.rating) return a.rating - b.rating;
    return a.fetchedAt.localeCompare(b.fetchedAt);
  };

  const assignments = []; // { sku, groupId, isRep }
  let groups = 0;
  let groupedSkus = 0;
  for (const members of comp.values()) {
    if (members.length < 2) continue; // 单件不成组
    members.sort();
    let best = members[0];
    let bestScore = scoreOf(info.get(best));
    for (let i = 1; i < members.length; i++) {
      const sc = scoreOf(info.get(members[i]));
      if (compareScore(sc, bestScore) > 0) {
        best = members[i];
        bestScore = sc;
      }
    }
    groups++;
    groupedSkus += members.length;
    for (const m of members) {
      assignments.push({ sku: m, groupId: best, isRep: m === best ? 1 : 0 });
    }
  }

  // ── 4. 写回(仅 apply 模式) ──
  let applied = 0;
  if (apply) {
    db.exec('BEGIN');
    try {
      // 先清空旧分组(未分组行不受影响)
      db.prepare('UPDATE ozon_cache_index SET group_id = NULL, group_rep = 0 WHERE group_id IS NOT NULL').run();
      const stmt = db.prepare('UPDATE ozon_cache_index SET group_id = ?, group_rep = ? WHERE sku = ?');
      for (const a of assignments) {
        stmt.run(a.groupId, a.isRep, a.sku);
        applied++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  return {
    totalSku: info.size,
    followSellRows: total,
    linkedPairs,
    groups,
    groupedSkus,
    hiddenSkus: groupedSkus - groups,
    applied,
    dryRun: !apply,
  };
}