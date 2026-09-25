// 财务统计(2026-09-25,订单维度:采购成本/应计项目/利润聚合)
// 三组口径:
//   1) 已结算 —— 已成功(妥投 + 应计含 66/67)+ 已取消 + 已退款(妥投后退货),按下单时间
//      (op_ozon_order.in_process_at)过滤;利润:有真实应计的走真实口径,无应计的
//      取消/退款按 利润=−采购(货款必然被扣回,与订单处理 computeProfit 同规则)
//   2) 已采购未结算 —— 有采购(purchase_status != 'none')且非已成功、非取消、非退货,
//      按下单时间过滤;利润为预估口径(佣金 16% + 配送公式,在途无收入侧应计)
//      已妥投但缺 66/67 的包裹按真实口径(终态已有应计),与订单处理 /summary 一致
//   3) 非订单应计项目 —— op_accrual 中 package_id IS NULL 的行(罚款/逆向物流等挂不到
//      货件的费用),按应计自身 accrual_date(YYYY-MM-DD)过滤,不受时区影响
// 路由:
//   GET /admin/api/finance-stats/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&storeIds=a,b&tz=...
//     from/to 缺省 = 全部时间;to 为排他日界(含 from 当日,不含 to 当日)
//   GET /admin/api/finance-stats/orders?group=settled|pending&from&to&storeIds&tz&page&pageSize&keyword&category&typeId
//     category=success|cancelled|returned(已结算组内分类筛选);typeId=应计类型筛选(方块点击联动)
//     订单行含 items(产品行:图/标题/SKU/数量/售价/已采数量/采购金额,与订单处理详情同源)
//   GET /admin/api/finance-stats/non-order-accruals?from&to&storeIds&page&pageSize
//   GET /admin/api/finance-stats/order-months?tz=... —— 有订单的自然月列表(YYYY-MM 降序,月界按 tz 换算)
// 金额币种:采购/订单金额 CNY;应计 RUB,按 app_config rub_cny_rate 换算 CNY
// 已结算组回款三分口径(seller_price 来自 by-day POSTING 佣金行,双写 op_accrual):
//   总回款 grossPayout   = 正向 sp 合计×汇率 + 无 sp 取消单订单金额 = |有效| + |无效|
//   有效回款 validPayout = 有正向 sp 订单的净回款(正负冲抵)= |采购|+|国际配送|+|销售佣金|+|其它应计|+|利润|
//   无效回款 invalidPayout = 负向 sp 合计×汇率 − 无 sp 取消单订单金额(负值)
//   销售利润率(已结算)= 利润 ÷ 有效回款(无有效销售回退订单金额基数)
// 统计范围排除(三组订单侧 + 月份列表统一生效,汇总/明细/占比口径一致):
//   秒取消订单 —— 已取消且采购/销售收款/应计合计均为 0(回款利润全 0,纯噪音)
//   质检单 —— Ozon 平台抽检下单,取消原因为 992/994(质检流程),非真实客户订单
import { Router } from 'express';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import { listStores } from '../services/webhook/store-map.js';
import { orderPackageDao } from '../db/dao/sqlite/order-daos.js';
import { ACCRUAL_TYPE_CN, getAccrualTypeSumsByPackageIds, getSellerPriceSumsByPackageIds, getRubCnyRate } from '../db/dao/sqlite/accrual-dao.js';
import { estimateProfit } from '../services/profit-estimator.js';

const router = Router();

// 支持的统计时区 → 固定偏移(与 order-stats.js 一致,两时区均无夏令时)
const TZ_OFFSETS = {
  'Asia/Shanghai': '+08:00',
  'Europe/Moscow': '+03:00',
};
const DEFAULT_TZ = 'Asia/Shanghai';
const MAX_RANGE_DAYS = 1095; // 自定义跨度上限(3 年;「全部」不受限)
const AGG_LIMIT = 20000;     // 聚合行数上限(防极端场景阻塞 event loop,对齐 aggregatePackages)

const TYPE_AGENT_FEE = 66;
const TYPE_SALE_FEE = 69;
const TYPE_DELIVERY = 67;

const round2 = (n) => Math.round(n * 100) / 100;

/** 指定时区日界日期(YYYY-MM-DD) → UTC ISO [start, end) */
function localDateToUtcRange(from, to, offset) {
  const fromTs = Date.parse(from + 'T00:00:00' + offset);
  const toTs = Date.parse(to + 'T00:00:00' + offset);
  if (Number.isNaN(fromTs) || Number.isNaN(toTs)) return null;
  return { start: new Date(fromTs).toISOString(), end: new Date(toTs).toISOString() };
}

/** 解析 storeIds(逗号分隔)→ 去重数组;空返回 null(不筛选) */
function parseStoreIds(s) {
  if (!s || typeof s !== 'string') return null;
  const list = [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];
  return list.length ? list : null;
}

/** 解析时间参数:返回 { allTime, range } 或错误信息
 *  allTime=true 表示全部时间(订单侧不加 in_process_at 条件,应计侧不加 accrual_date 条件)
 */
function parseTimeParams(query) {
  const { from, to } = query;
  if (!from && !to) return { allTime: true, range: null };
  if (!from || !to) return { error: 'from/to 需同时提供(或都不传表示全部)' };
  const tz = TZ_OFFSETS[query.tz] ? query.tz : DEFAULT_TZ;
  const range = localDateToUtcRange(from, to, TZ_OFFSETS[tz]);
  if (!range) return { error: 'from/to 格式非法(应为 YYYY-MM-DD)' };
  if (range.end <= range.start) return { error: 'from 必须 < to' };
  const days = (Date.parse(range.end) - Date.parse(range.start)) / 86400_000;
  if (days > MAX_RANGE_DAYS) return { error: `时间范围最长 ${MAX_RANGE_DAYS} 天` };
  return {
    allTime: false,
    range,
    // 非订单应计按 accrual_date(YYYY-MM-DD)日粒度过滤,to 为排他日界
    dateRange: { from, to },
    tz,
  };
}

// 已成功判定(与订单处理 tabCounts「settled」同口径:妥投 + 应计同时含 66/67,不含退货)
const SUCCESS_COND = `p.operate_status = 'wait_receiver_confirm' AND p.delivered_at IS NOT NULL
  AND p.is_returned = 0
  AND EXISTS (SELECT 1 FROM op_accrual a66 WHERE a66.package_id = p.id AND a66.type_id = 66)
  AND EXISTS (SELECT 1 FROM op_accrual a67 WHERE a67.package_id = p.id AND a67.type_id = 67)`;

// 统计范围排除条件(汇总/订单明细/月份列表统一引用):
//   秒取消订单(已取消且采购/收款/应计全为0,无财务影响,原默认隐藏→现彻底移出统计范围)
//   质检单(取消原因 992/994 = Ozon 质检流程取消,平台抽检下单非真实客户订单;
//   货件号 02131/024785 前缀仅是粗略特征——有已妥投质检单被误杀(有真实应计)、
//   也有不带前缀的质检取消单被漏掉,故按取消原因精确判定)
const ZERO_CANCEL_COND = `(p.operate_status = 'cancelled'
  AND COALESCE(p.total_purchase_amount, 0) = 0
  AND COALESCE(p.accrual_sale_total, 0) = 0
  AND COALESCE(p.accrual_total, 0) = 0)`;
const QC_CANCEL_COND = `(p.operate_status = 'cancelled'
  AND COALESCE(json_extract(o.cancellation_json, '$.cancel_reason_id'), 0) IN (992, 994))`;
const SCOPE_EXCLUDE = `NOT ${ZERO_CANCEL_COND} AND NOT ${QC_CANCEL_COND}`;

/** 组 WHERE(不含时间/店铺过滤,由调用方拼接)
 *  settled:已结算(已成功 ∪ 已取消 ∪ 已退款);
 *  pending:已采购未结算(有采购 且 非已成功 且 非取消 且 非退货)
 *  两组均排除秒取消订单与质检单(统计范围口径)
 */
function buildGroupWhere(group) {
  if (group === 'settled') {
    return `p.is_ignored = 0 AND ((${SUCCESS_COND}) OR p.operate_status = 'cancelled' OR p.is_returned = 1)
      AND ${SCOPE_EXCLUDE}`;
  }
  return `p.is_ignored = 0 AND p.is_returned = 0
    AND p.operate_status != 'cancelled'
    AND p.purchase_status != 'none'
    AND NOT (${SUCCESS_COND})
    AND ${SCOPE_EXCLUDE}`;
}

/** 已结算组内分类(行级判定,供徽标与子计数) */
function settledCategory(r) {
  if (r.operate_status === 'cancelled') return 'cancelled';
  if (r.is_returned) return 'returned';
  return 'success';
}

const PKG_SELECT = `SELECT p.id, p.operate_status, p.purchase_status, p.delivered_at, p.is_returned,
       p.total_purchase_amount, p.accrual_total, p.accrual_sale_total,
       o.order_amount, o.store_id, o.posting_number, o.in_process_at`;

/** 订单组公共过滤(时间按下单时间 in_process_at,ISO 串直接比较——两测均为 UTC ISO 格式) */
function appendOrderFilters(where, params, t, storeIds) {
  if (!t.allTime) {
    where.push('o.in_process_at >= ? AND o.in_process_at < ?');
    params.push(t.range.start, t.range.end);
  }
  if (storeIds) {
    where.push(`o.store_id IN (${storeIds.map(() => '?').join(',')})`);
    params.push(...storeIds);
  }
}

/** 单包裹利润(对齐 order-process.js computeProfit 口径)
 *  真实口径:经济终态(已妥投/已取消/已退货)且 accrual_total 非空 → (销售+应计合计)×汇率 − 采购;
 *  退货含未妥投退货(取货点拒收):逆向物流等费用为最终扣款,计入利润,
 *  否则费用进方块而利润漏扣,破坏 |有效回款| = |采购|+|配送|+|佣金|+|其它应计|+|利润| 恒等式
 *  返回值不逐行 round2 —— 聚合按未舍入值累加后统一舍入,避免 ~200 单的逐行舍入累积
 *  破坏方块恒等式(明细行展示时再舍入)
 *  预估口径:佣金 = 订单金额×16%,配送 = 3.37 + 0.0281×weight_g(g)
 */
function calcProfit(r, rate, weightG) {
  const orderAmount = Number(r.order_amount) || 0;
  const purchase = Number(r.total_purchase_amount) || 0;
  const terminal = r.delivered_at != null || r.operate_status === 'cancelled' || r.is_returned;
  const accrualTotal = r.accrual_total != null ? Number(r.accrual_total) : null;
  if (terminal && accrualTotal != null && rate) {
    const saleRub = Number(r.accrual_sale_total) || 0;
    const payout = (saleRub + accrualTotal) * rate;
    return { estimated: false, payout, profit: payout - purchase };
  }
  // 已取消/已退款且无真实应计 → 货款必然被扣回,商品销毁无残值,利润 = −采购(真实口径)
  if (r.operate_status === 'cancelled' || r.is_returned) {
    return { estimated: false, payout: 0, profit: -purchase };
  }
  const est = estimateProfit({ amountCny: orderAmount, purchaseCny: purchase, weightG });
  return { estimated: true, payout: est.escrow, profit: est.profit, commission: est.commission, delivery: est.delivery };
}

/** 真实口径应计 CNY 分组(对齐 buildAccrualBreakdown:69/67/其它=合计−69−67,66 并入其它) */
function buildAccrualCny(typeMap, accrualTotal, accrualSaleTotal, rate) {
  const saleFeeRub = typeMap.get(TYPE_SALE_FEE) || 0;
  const deliveryRub = typeMap.get(TYPE_DELIVERY) || 0;
  const totalRub = Number(accrualTotal) || 0;
  const saleRub = Number(accrualSaleTotal) || 0;
  const othersRub = round2(totalRub - saleFeeRub - deliveryRub);
  return {
    saleFee: round2(saleFeeRub * rate),
    agentFee: round2((typeMap.get(TYPE_AGENT_FEE) || 0) * rate),
    delivery: round2(deliveryRub * rate),
    others: round2(othersRub * rate),
    total: round2(totalRub * rate),
    sale: round2(saleRub * rate),
    payout: round2((saleRub + totalRub) * rate),
  };
}

/** 应计类型分组 → 展示数组(按 type_id 升序,含中文名) */
function typeRowsByPackage(typeSums, packageIdSet, rate) {
  const acc = new Map(); // typeId → { count, rub }
  for (const t of typeSums) {
    if (!packageIdSet.has(t.packageId)) continue;
    const cur = acc.get(t.typeId) || { typeId: t.typeId, count: 0, rub: 0 };
    cur.count += 1;
    cur.rub = round2(cur.rub + t.sum);
    acc.set(t.typeId, cur);
  }
  return [...acc.values()]
    .sort((a, b) => a.typeId - b.typeId)
    .map((t) => ({
      typeId: t.typeId,
      nameCn: ACCRUAL_TYPE_CN[t.typeId] || `类型 ${t.typeId}`,
      count: t.count,
      rub: t.rub,
      cny: round2(t.rub * rate),
    }));
}

/** 聚合一个订单组(settled/pending):返回统计 + 明细行(供 summary 路由) */
function aggregateOrderGroup(group, t, storeIds, rate) {
  const where = [buildGroupWhere(group)];
  const params = [];
  appendOrderFilters(where, params, t, storeIds);
  const rows = db
    .prepare(
      `${PKG_SELECT}
       FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.in_process_at DESC, p.id DESC
       LIMIT ?`
    )
    .all(...params, AGG_LIMIT);

  const pkgIds = rows.map((r) => r.id);
  const typeSums = getAccrualTypeSumsByPackageIds(pkgIds);
  const weightMap = orderPackageDao.getWeightsByPackageIds(pkgIds);
  const byPkgTypes = new Map();
  for (const ts of typeSums) {
    if (!byPkgTypes.has(ts.packageId)) byPkgTypes.set(ts.packageId, new Map());
    byPkgTypes.get(ts.packageId).set(ts.typeId, ts.sum);
  }

  const agg = {
    orderCount: 0,
    totalOrderAmount: 0,
    totalPurchaseAmount: 0,
    totalProfit: 0,
    totalPayout: 0,
    totalCommission: 0, // 预估口径销售佣金合计(仅 estimated 行有值,正数成本)
    totalDelivery: 0, // 预估口径国际配送合计(仅 estimated 行有值,正数成本)
    estimated: false, // 任一包裹为预估口径则 true
    accrualTypes: [],
    byCategory: group === 'settled' ? { success: 0, cancelled: 0, returned: 0 } : null,
    byCategoryProfit: group === 'settled' ? { success: 0, cancelled: 0, returned: 0 } : null,
  };
  const pkgIdSet = new Set(pkgIds);
  for (const r of rows) {
    const weightG = weightMap.get(r.id)?.weightG ?? null;
    const p = calcProfit(r, rate, weightG);
    agg.orderCount += 1;
    agg.totalOrderAmount += Number(r.order_amount) || 0;
    agg.totalPurchaseAmount += Number(r.total_purchase_amount) || 0;
    agg.totalProfit += p.profit;
    agg.totalPayout += p.payout;
    agg.totalCommission += p.commission || 0;
    agg.totalDelivery += p.delivery || 0;
    if (p.estimated) agg.estimated = true;
    if (agg.byCategory) {
      const cat = settledCategory(r);
      agg.byCategory[cat] += 1;
      agg.byCategoryProfit[cat] += p.profit;
    }
  }
  if (agg.byCategoryProfit) {
    for (const k of Object.keys(agg.byCategoryProfit)) agg.byCategoryProfit[k] = round2(agg.byCategoryProfit[k]);
  }
  // ─ 回款三分口径(仅已结算组;取消单无 seller_price,退款单正负冲抵)──
  //  总回款 grossPayout  = 正向 sp 合计×汇率 + 无 sp 取消单订单金额 = |有效| + |无效|
  //  有效回款 validPayout = 有正向 sp 订单的净回款(正负冲抵)= |采购|+|国际配送|+|销售佣金|+|其它应计|+|利润|
  //  无效回款 invalidPayout = 负向 sp 合计×汇率 − 无 sp 取消单订单金额(负值)
  if (group === 'settled') {
    const spSums = getSellerPriceSumsByPackageIds(pkgIds);
    const posPkgIds = new Set(spSums.filter((s) => s.posRub > 0).map((s) => s.packageId));
    let posRub = 0;
    let negRub = 0;
    let validRub = 0;
    let noSpCancelledAmt = 0; // 无 sp 取消单的订单金额(CNY 挂牌价)
    for (const s of spSums) {
      if (!posPkgIds.has(s.packageId)) continue; // 负冲跟随原单,孤儿负行不重复计入
      posRub += s.posRub;
      negRub += s.negRub;
    }
    for (const r of rows) {
      if (posPkgIds.has(r.id)) validRub += Number(r.accrual_sale_total) || 0;
      else if (r.operate_status === 'cancelled') noSpCancelledAmt += Number(r.order_amount) || 0;
    }
    agg.grossPayout = rate ? round2(posRub * rate + noSpCancelledAmt) : null;
    agg.validPayout = rate ? round2(validRub * rate) : null;
    agg.invalidPayout = rate ? round2(negRub * rate - noSpCancelledAmt) : null;
  }
  agg.totalCommission = round2(agg.totalCommission);
  agg.totalDelivery = round2(agg.totalDelivery);
  agg.totalOrderAmount = round2(agg.totalOrderAmount);
  agg.totalPurchaseAmount = round2(agg.totalPurchaseAmount);
  agg.totalProfit = round2(agg.totalProfit);
  agg.totalPayout = round2(agg.totalPayout);
  // 销售利润率:已结算按 利润÷有效回款(真实销售利润率;无有效销售回退订单金额基数),
  // 未结算按 利润÷订单金额(预估口径基数)
  const saleBase = group === 'settled' ? (agg.validPayout > 0 ? agg.validPayout : agg.totalOrderAmount) : agg.totalOrderAmount;
  agg.profitRateSale = saleBase > 0 ? Math.round((agg.totalProfit / saleBase) * 10000) / 100 : null;
  agg.profitRateCost = agg.totalPurchaseAmount > 0 ? Math.round((agg.totalProfit / agg.totalPurchaseAmount) * 10000) / 100 : null;
  agg.accrualTypes = rate ? typeRowsByPackage(typeSums, pkgIdSet, rate) : [];
  agg.truncated = rows.length === AGG_LIMIT;
  return agg;
}

// ── 三组聚合 ─────────────────────────────────────────────────
router.get('/admin/api/finance-stats/summary', (req, res, next) => {
  try {
    const t = parseTimeParams(req.query);
    if (t.error) return res.status(400).json({ ok: false, message: t.error });
    const storeIds = parseStoreIds(req.query.storeIds);
    const rateInfo = getRubCnyRate();
    const rate = rateInfo?.rate || null;

    // 1) 已成功 + 2) 已采购未结算(按下单时间过滤)
    const settled = aggregateOrderGroup('settled', t, storeIds, rate);
    const pending = aggregateOrderGroup('pending', t, storeIds, rate);

    // 3) 非订单应计(package_id IS NULL,按 accrual_date 过滤;to 为排他日界)
    const noWhere = ['package_id IS NULL'];
    const noParams = [];
    if (!t.allTime) {
      noWhere.push('accrual_date >= ? AND accrual_date < ?');
      noParams.push(t.dateRange.from, t.dateRange.to);
    }
    if (storeIds) {
      noWhere.push(`store_id IN (${storeIds.map(() => '?').join(',')})`);
      noParams.push(...storeIds);
    }
    const nonOrderRows = db
      .prepare(
        `SELECT type_id AS typeId, COUNT(*) AS cnt, ROUND(SUM(amount), 2) AS rub
         FROM op_accrual WHERE ${noWhere.join(' AND ')}
         GROUP BY type_id ORDER BY type_id`
      )
      .all(...noParams);
    const nonOrder = {
      count: 0,
      totalRub: 0,
      totalCny: rate ? 0 : null,
      accrualTypes: nonOrderRows.map((r) => ({
        typeId: r.typeId,
        nameCn: ACCRUAL_TYPE_CN[r.typeId] || `类型 ${r.typeId}`,
        count: r.cnt,
        rub: Number(r.rub) || 0,
        cny: rate ? round2((Number(r.rub) || 0) * rate) : null,
      })),
    };
    for (const r of nonOrderRows) {
      nonOrder.count += r.cnt;
      nonOrder.totalRub = round2(nonOrder.totalRub + (Number(r.rub) || 0));
      if (rate) nonOrder.totalCny = round2(nonOrder.totalCny + (Number(r.rub) || 0) * rate);
    }

    res.json(ok({
      allTime: t.allTime,
      from: t.allTime ? null : t.dateRange.from,
      to: t.allTime ? null : t.dateRange.to,
      tz: t.allTime ? null : t.tz,
      storeIds: storeIds || [],
      rubRate: rateInfo,
      settled,
      pending,
      nonOrder,
    }));
  } catch (err) {
    next(err);
  }
});

// ── 订单详情列表(group=settled|pending,分页)─────────────────
router.get('/admin/api/finance-stats/orders', (req, res, next) => {
  try {
    const group = req.query.group === 'pending' ? 'pending' : 'settled';
    const t = parseTimeParams(req.query);
    if (t.error) return res.status(400).json({ ok: false, message: t.error });
    const storeIds = parseStoreIds(req.query.storeIds);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const rateInfo = getRubCnyRate();
    const rate = rateInfo?.rate || null;
    const stores = listStores();
    const storeMap = new Map(stores.map((s) => [s.id, s.name]));

    const where = [buildGroupWhere(group)];
    const params = [];
    appendOrderFilters(where, params, t, storeIds);
    // 方块点击筛选:已结算组内分类(已成功/已取消/已退款)
    const category = ['success', 'cancelled', 'returned'].includes(req.query.category) ? req.query.category : null;
    if (category === 'cancelled') where.push(`p.operate_status = 'cancelled'`);
    else if (category === 'returned') where.push(`p.is_returned = 1 AND p.operate_status != 'cancelled'`); // 与展示分类一致:cancelled 优先
    else if (category === 'success') where.push(SUCCESS_COND);
    // 方块点击筛选:按应计类型(该包裹存在此类型的应计行)
    const typeId = Number(req.query.typeId);
    if (Number.isInteger(typeId) && typeId > 0) {
      where.push(`EXISTS (SELECT 1 FROM op_accrual af WHERE af.package_id = p.id AND af.type_id = ?)`);
      params.push(typeId);
    }
    if (req.query.keyword) {
      where.push('o.posting_number LIKE ?');
      params.push(`%${String(req.query.keyword).trim()}%`);
    }
    // 秒取消订单与质检单已移出统计范围(buildGroupWhere 统一排除,与汇总口径一致)
    const whereClause = `FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id WHERE ${where.join(' AND ')}`;

    const total = db.prepare(`SELECT COUNT(*) AS n ${whereClause}`).get(...params).n;
    const rows = db
      .prepare(
        `${PKG_SELECT}, p.ozon_order_id ${whereClause}
         ORDER BY o.in_process_at DESC, p.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    const pkgIds = rows.map((r) => r.id);
    const typeSums = getAccrualTypeSumsByPackageIds(pkgIds);
    const weightMap = orderPackageDao.getWeightsByPackageIds(pkgIds);
    const byPkgTypes = new Map();
    for (const ts of typeSums) {
      if (!byPkgTypes.has(ts.packageId)) byPkgTypes.set(ts.packageId, new Map());
      byPkgTypes.get(ts.packageId).set(ts.typeId, ts.sum);
    }

    // 商品信息(与订单处理详情同源 getItemsByOrderIds:缓存图/标题/SKU/数量/售价/已采数量/采购金额)
    const itemsByOrder = new Map();
    if (rows.length) {
      const orderIds = [...new Set(rows.map((r) => r.ozon_order_id))];
      for (const it of orderPackageDao.getItemsByOrderIds(orderIds)) {
        if (!itemsByOrder.has(it.ozonOrderId)) itemsByOrder.set(it.ozonOrderId, []);
        itemsByOrder.get(it.ozonOrderId).push(it);
      }
    }

    const orders = rows.map((r) => {
      const weightG = weightMap.get(r.id)?.weightG ?? null;
      const p = calcProfit(r, rate, weightG);
      const orderAmount = Number(r.order_amount) || 0;
      const purchase = Number(r.total_purchase_amount) || 0;
      const typeMap = byPkgTypes.get(r.id) || new Map();
      const accrualTotal = r.accrual_total != null ? Number(r.accrual_total) : null;
      // 真实口径(终态+有应计+有汇率)才有 CNY 分组;在途为预估(佣金/配送按公式)
      const real = !p.estimated && r.accrual_total != null;
      return {
        packageId: r.id,
        postingNumber: r.posting_number,
        storeId: r.store_id,
        storeName: storeMap.get(r.store_id) || r.store_id,
        inProcessAt: r.in_process_at,
        deliveredAt: r.delivered_at,
        orderAmount: round2(orderAmount),
        purchaseAmount: round2(purchase),
        weightG,
        items: itemsByOrder.get(r.ozon_order_id) || [],
        estimated: p.estimated,
        category: group === 'settled' ? settledCategory(r) : null,
        payout: round2(p.payout), // calcProfit 返回未舍入值,明细行展示时舍入
        profit: round2(p.profit),
        profitRateSale: orderAmount > 0 ? Math.round((p.profit / orderAmount) * 10000) / 100 : null,
        profitRateCost: purchase > 0 ? Math.round((p.profit / purchase) * 10000) / 100 : null,
        accrual: real ? buildAccrualCny(typeMap, accrualTotal, r.accrual_sale_total, rate) : null,
        // 已产生应计明细(含在途包裹已落库的部分费用;预估口径利润尚未计入)
        accrualTypes: rate
          ? [...typeMap.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([typeId, rub]) => ({
                typeId,
                nameCn: ACCRUAL_TYPE_CN[typeId] || `类型 ${typeId}`,
                rub: round2(rub),
                cny: round2(rub * rate),
              }))
          : [],
        // 预估口径明细(佣金/配送公式值,前端展示用)
        estimate: p.estimated ? { commission: p.commission, delivery: p.delivery } : null,
      };
    });

    res.json(ok({ group, total, page, pageSize, orders, rubRate: rateInfo }));
  } catch (err) {
    next(err);
  }
});

// ── 非订单应计明细(package_id IS NULL,分页)──────────────────
router.get('/admin/api/finance-stats/non-order-accruals', (req, res, next) => {
  try {
    const t = parseTimeParams(req.query);
    if (t.error) return res.status(400).json({ ok: false, message: t.error });
    const storeIds = parseStoreIds(req.query.storeIds);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const rateInfo = getRubCnyRate();
    const rate = rateInfo?.rate || null;
    const stores = listStores();
    const storeMap = new Map(stores.map((s) => [s.id, s.name]));

    const where = ['package_id IS NULL'];
    const params = [];
    if (!t.allTime) {
      where.push('accrual_date >= ? AND accrual_date < ?');
      params.push(t.dateRange.from, t.dateRange.to);
    }
    if (storeIds) {
      where.push(`store_id IN (${storeIds.map(() => '?').join(',')})`);
      params.push(...storeIds);
    }
    const whereClause = `FROM op_accrual WHERE ${where.join(' AND ')}`;

    const total = db.prepare(`SELECT COUNT(*) AS n ${whereClause}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT id, store_id, posting_number, type_id, type_name, amount, currency,
                accrual_date, synced_at
         ${whereClause}
         ORDER BY accrual_date DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize);

    const items = rows.map((r) => ({
      id: r.id,
      storeId: r.store_id,
      storeName: storeMap.get(r.store_id) || r.store_id,
      unitNumber: r.posting_number,
      typeId: r.type_id,
      nameCn: ACCRUAL_TYPE_CN[r.type_id] || r.type_name || `类型 ${r.type_id}`,
      typeName: r.type_name,
      rub: round2(Number(r.amount) || 0),
      cny: rate ? round2((Number(r.amount) || 0) * rate) : null,
      accrualDate: r.accrual_date,
      syncedAt: r.synced_at,
    }));

    res.json(ok({ total, page, pageSize, items, rubRate: rateInfo }));
  } catch (err) {
    next(err);
  }
});

// ── 有订单月份列表(自然月快捷选项;月界按所选时区换算)─────────
router.get('/admin/api/finance-stats/order-months', (req, res, next) => {
  try {
    const tz = TZ_OFFSETS[req.query.tz] ? req.query.tz : DEFAULT_TZ;
    // in_process_at 为 UTC ISO(带 T/Z 后缀),SQLite 时间函数可直接解析并应用时区修饰符
    const rows = db
      .prepare(
        `SELECT DISTINCT strftime('%Y-%m', o.in_process_at, ?) AS ym
         FROM op_ozon_order o JOIN op_package p ON p.ozon_order_id = o.id
         WHERE p.is_ignored = 0 AND o.in_process_at IS NOT NULL
           AND NOT ${ZERO_CANCEL_COND} AND NOT ${QC_CANCEL_COND}
         ORDER BY ym DESC`
      )
      .all(TZ_OFFSETS[tz]);
    res.json(ok({ months: rows.map((r) => r.ym).filter(Boolean) }));
  } catch (err) {
    next(err);
  }
});

export default router;
