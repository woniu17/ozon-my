// 一次性分析脚本:ERP 订单销售统计
// 1) 全部订单:哪个类目卖得最多(数量)、哪个商品卖得最多
// 2) 已结算订单(口径与 finance-stats 一致):各类目/商品的 利润、利润率
// 依赖:data/erp.db (better-sqlite3)、data/ozon-categories-all.json(类目映射)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'erp.db');
const catPath = path.join(__dirname, '..', 'data', 'ozon-categories-all.json');

const db = new DatabaseSync(dbPath, { readOnly: true });

// ── 汇率 ──
const rateRow = db.prepare(`SELECT value FROM app_config WHERE key = 'rub_cny_rate'`).get();
const rate = rateRow ? JSON.parse(rateRow.value)?.rate : null;
console.log('RUB→CNY 汇率:', rate);

// ── 类目映射(description_category_id → path / 一级类目)──
const catData = JSON.parse(fs.readFileSync(catPath, 'utf8'));
const catById = new Map();
for (const c of catData.categories) {
  if (c.descriptionCategoryId != null) {
    catById.set(c.descriptionCategoryId, {
      path: c.path || c.categoryName || '',
      top: c.path ? c.path.split('/')[0].trim() : (c.categoryName || ''),
    });
  }
}

// ── 商品类目:从 product_data_cache.data.description_category_id 解析 ──
const skuRows = db.prepare(`
  SELECT CAST(sku AS TEXT) AS sku, json_extract(data, '$.description_category_id') AS cat_id
  FROM product_data_cache
  WHERE data IS NOT NULL
`).all();
const skuCatMap = new Map(); // sku -> { catId, path, top }
for (const r of skuRows) {
  if (r.cat_id == null) continue;
  const info = catById.get(Number(r.cat_id));
  skuCatMap.set(String(r.sku), {
    catId: Number(r.cat_id),
    path: info ? info.path : `未知(${r.cat_id})`,
    top: info ? info.top : '未知',
  });
}

// ── 已结算判定(与 finance-stats.js 完全同口径)──
// 成功:operate_status='wait_receiver_confirm' AND delivered_at 非空 AND is_returned=0 且存在 type_id=67 应计
// 已取消:operate_status='cancelled'
// 已退款:is_returned=1(非 cancelled)
// 排除:秒取消订单(采购/应计全0) 与 质检单(取消原因 992/994)
const hasAccrual67 = db.prepare(`SELECT 1 FROM op_accrual WHERE package_id = ? AND type_id = 67 LIMIT 1`);

function isSettled(p) {
  if (p.is_ignored) return false;
  const cancelled = p.operate_status === 'cancelled';
  const returned = !!p.is_returned;
  const success = !cancelled && !returned && p.operate_status === 'wait_receiver_confirm'
    && p.delivered_at != null && !!hasAccrual67.get(p.package_id);
  if (!(success || cancelled || returned)) return false;
  const cancelInfo = JSON.parse(p.cancellation_json || '{}');
  const zeroCancel = cancelled && !p.total_purchase_amount && !p.accrual_sale_total && !p.accrual_total;
  const qc = cancelled && [992, 994].includes(cancelInfo?.cancel_reason_id);
  return !zeroCancel && !qc;
}

// 单包裹利润(与 finance-stats calcProfit 同口径)
function calcProfit(p) {
  const purchase = Number(p.total_purchase_amount) || 0;
  const terminal = p.delivered_at != null || p.operate_status === 'cancelled' || p.is_returned;
  const accrualTotal = p.accrual_total != null ? Number(p.accrual_total) : null;
  if (terminal && accrualTotal != null && rate) {
    const saleRub = Number(p.accrual_sale_total) || 0;
    const payout = (saleRub + accrualTotal) * rate;
    return { payout, profit: payout - purchase, real: true };
  }
  if (p.operate_status === 'cancelled' || p.is_returned) {
    return { payout: 0, profit: -purchase, real: false };
  }
  return null; // 不应出现在已结算组
}

// 把包裹利润分摊到商品行(真实口径按销售额占比,取消/退款无应计按采购额占比)
function allocateItemProfits(pkg, profitInfo) {
  const items = pkg.items;
  const totalSale = items.reduce((s, i) => s + i.saleAmount, 0);
  const totalPurchase = items.reduce((s, i) => s + i.purchaseAmount, 0);
  const useSaleShare = profitInfo.real && totalSale > 0;
  for (const it of items) {
    let share = 0;
    if (useSaleShare) share = it.saleAmount / totalSale;
    else if (totalPurchase > 0) share = it.purchaseAmount / totalPurchase;
    else if (items.length) share = 1 / items.length;
    it.profit = profitInfo.profit * share;
  }
}

// ── 加载全部数据 ──
const rows = db.prepare(`
  SELECT
    o.id AS order_id, o.order_amount, o.currency, o.status AS order_status, o.in_process_at,
    o.cancellation_json,
    p.id AS package_id, p.operate_status, p.delivered_at, p.is_returned, p.is_ignored,
    p.total_purchase_amount, p.accrual_total, p.accrual_sale_total,
    oi.id AS item_id, CAST(oi.sku AS TEXT) AS sku, oi.offer_id, oi.title,
    oi.quantity, oi.price, oi.purchase_amount, oi.purchase_num
  FROM op_ozon_order o
  JOIN op_package p ON p.ozon_order_id = o.id
  JOIN op_ozon_order_item oi ON oi.ozon_order_id = o.id
  ORDER BY o.in_process_at
`).all();

console.log('订单行总数:', rows.length);

const pkgMap = new Map();
for (const r of rows) {
  const cat = skuCatMap.get(r.sku) || { catId: null, path: '未知类目', top: '未知类目' };
  const item = {
    ...r,
    catPath: cat.path,
    catTop: cat.top,
    saleAmount: (Number(r.price) || 0) * (Number(r.quantity) || 0),
    purchaseAmount: Number(r.purchase_amount) || 0,
  };
  if (!pkgMap.has(r.package_id)) pkgMap.set(r.package_id, { ...r, items: [] });
  pkgMap.get(r.package_id).items.push(item);
}

// ── 聚合 ──
const allCatQty = new Map();
const allCatQtyPath = new Map();
const allSkuQty = new Map();
const settledCatProfit = new Map(); // catTop -> stats
const settledCatProfitPath = new Map();
const settledSkuProfit = new Map(); // sku -> stats(含 pkgIds Set)
const settledPkgIds = new Set();

// 先判定已结算集合
for (const pkg of pkgMap.values()) if (isSettled(pkg)) settledPkgIds.add(pkg.package_id);

for (const pkg of pkgMap.values()) {
  const cancelled = pkg.operate_status === 'cancelled';
  const cancelInfo = JSON.parse(pkg.cancellation_json || '{}');
  const zeroCancel = cancelled && !pkg.total_purchase_amount && !pkg.accrual_sale_total && !pkg.accrual_total;
  const qc = cancelled && [992, 994].includes(cancelInfo?.cancel_reason_id);
  const normalOrder = !zeroCancel && !qc;

  // 1) 全部订单销量(排除秒取消/质检)
  if (normalOrder) {
    for (const it of pkg.items) {
      const q = Number(it.quantity) || 0;
      allCatQty.set(it.catTop, (allCatQty.get(it.catTop) || 0) + q);
      allCatQtyPath.set(it.catPath, (allCatQtyPath.get(it.catPath) || 0) + q);
      const cur = allSkuQty.get(it.sku) || { title: it.title, qty: 0, saleAmount: 0 };
      cur.qty += q;
      cur.saleAmount += it.saleAmount;
      if (!cur.title) cur.title = it.title;
      allSkuQty.set(it.sku, cur);
    }
  }

  // 2) 已结算利润
  if (!settledPkgIds.has(pkg.package_id)) continue;
  const profitInfo = calcProfit(pkg);
  if (!profitInfo) continue;
  allocateItemProfits(pkg, profitInfo);
  for (const it of pkg.items) {
    const q = Number(it.quantity) || 0;
    const sale = it.saleAmount;
    const purchase = it.purchaseAmount;
    for (const [map, key] of [
      [settledCatProfit, it.catTop],
      [settledCatProfitPath, it.catPath],
    ]) {
      const c = map.get(key) || { profit: 0, saleAmount: 0, purchase: 0, qty: 0, orderCnt: 0 };
      c.profit += it.profit;
      c.saleAmount += sale;
      c.purchase += purchase;
      c.qty += q;
      map.set(key, c);
    }
    const s = settledSkuProfit.get(it.sku) || { title: it.title, catTop: it.catTop, catPath: it.catPath, profit: 0, saleAmount: 0, purchase: 0, qty: 0, pkgIds: new Set() };
    s.profit += it.profit;
    s.saleAmount += sale;
    s.purchase += purchase;
    s.qty += q;
    s.pkgIds.add(pkg.package_id);
    settledSkuProfit.set(it.sku, s);
  }
}

// 包裹数(订单数)按类目去重统计
for (const pkg of pkgMap.values()) {
  if (!settledPkgIds.has(pkg.package_id)) continue;
  const seenTop = new Set();
  const seenPath = new Set();
  for (const it of pkg.items) {
    if (!seenTop.has(it.catTop)) {
      const c = settledCatProfit.get(it.catTop);
      if (c) c.orderCnt += 1;
      seenTop.add(it.catTop);
    }
    if (!seenPath.has(it.catPath)) {
      const cp = settledCatProfitPath.get(it.catPath);
      if (cp) cp.orderCnt += 1;
      seenPath.add(it.catPath);
    }
  }
}

db.close();

// ── 输出工具 ──
const round2 = (n) => Math.round(n * 100) / 100;
const pct = (n) => `${(Math.round(n * 10000) / 100).toFixed(2)}%`;
const marginSale = (x) => (x.saleAmount > 0 ? x.profit / x.saleAmount : null);
const marginCost = (x) => (x.purchase > 0 ? x.profit / x.purchase : null);

function fmtProfitList(list, label, n) {
  console.log(`\n===== ${label} =====`);
  list.slice(0, n).forEach((x, i) => {
    const ms = marginSale(x);
    const mc = marginCost(x);
    console.log(`${i + 1}. ${x.name}`);
    console.log(`   销量: ${x.qty} 件 | 订单数: ${x.orderCnt || '-'} | 销售额: ¥${round2(x.saleAmount)} | 采购成本: ¥${round2(x.purchase)}`);
    console.log(`   利润: ¥${round2(x.profit)} | 销售利润率: ${ms == null ? '-' : pct(ms)} | 成本利润率: ${mc == null ? '-' : pct(mc)}`);
  });
}

// ── 输出 1:全部订单销量 ──
console.log('\n################################################');
console.log('# 一、全部订单(正常订单,排除秒取消/质检)销量');
console.log('################################################');

const catQtyList = [...allCatQty.entries()].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
console.log('\n=== 一级类目销量 TOP 15 ===');
catQtyList.slice(0, 15).forEach((x, i) => console.log(`${i + 1}. ${x.name}: ${x.qty} 件`));

const catQtyPathList = [...allCatQtyPath.entries()].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty);
console.log('\n=== 完整类目路径销量 TOP 15 ===');
catQtyPathList.slice(0, 15).forEach((x, i) => console.log(`${i + 1}. ${x.name}: ${x.qty} 件`));

const skuQtyList = [...allSkuQty.entries()].map(([sku, v]) => ({ sku, title: v.title, qty: v.qty, saleAmount: v.saleAmount })).sort((a, b) => b.qty - a.qty);
console.log('\n=== 商品销量 TOP 20 ===');
skuQtyList.slice(0, 20).forEach((x, i) => console.log(`${i + 1}. [${x.sku}] ${x.title}: ${x.qty} 件, 销售额 ¥${round2(x.saleAmount)}`));

// ── 输出 2:已结算订单利润 ──
let settledProfitSum = 0;
let settledSaleSum = 0;
for (const v of settledCatProfit.values()) { settledProfitSum += v.profit; settledSaleSum += v.saleAmount; }
console.log('\n################################################');
console.log('# 二、已结算订单利润/利润率');
console.log(`# 已结算包裹数: ${settledPkgIds.size} | 利润合计: ¥${round2(settledProfitSum)} | 销售额合计: ¥${round2(settledSaleSum)}`);
console.log('################################################');

const catProfitList = [...settledCatProfit.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.profit - a.profit);
fmtProfitList(catProfitList, '一级类目利润 TOP 15', 15);
fmtProfitList([...catProfitList].sort((a, b) => (marginSale(b) ?? -Infinity) - (marginSale(a) ?? -Infinity)), '一级类目销售利润率 TOP 10', 10);

const catProfitPathList = [...settledCatProfitPath.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.profit - a.profit);
fmtProfitList(catProfitPathList, '完整类目路径利润 TOP 15', 15);
fmtProfitList([...catProfitPathList].sort((a, b) => (marginSale(b) ?? -Infinity) - (marginSale(a) ?? -Infinity)), '完整类目路径销售利润率 TOP 10', 10);

const skuProfitList = [...settledSkuProfit.entries()].map(([sku, v]) => ({ sku, name: v.title, orderCnt: v.pkgIds.size, ...v })).sort((a, b) => b.profit - a.profit);
fmtProfitList(skuProfitList, '商品利润 TOP 20', 20);
fmtProfitList([...skuProfitList].sort((a, b) => (marginSale(b) ?? -Infinity) - (marginSale(a) ?? -Infinity)), '商品销售利润率 TOP 15', 15);

// ── 未知类目说明 ──
console.log('\n---- 未知类目明细(已结算) ----');
const unknownSettled = settledCatProfit.get('未知类目');
if (unknownSettled) {
  const ms = marginSale(unknownSettled);
  console.log(`销量: ${unknownSettled.qty} 件 | 订单数: ${unknownSettled.orderCnt} | 销售额: ¥${round2(unknownSettled.saleAmount)} | 利润: ¥${round2(unknownSettled.profit)} | 销售利润率: ${ms == null ? '-' : pct(ms)}`);
} else {
  console.log('无');
}

// ── 导出完整 JSON 报告 ──
const report = {
  generatedAt: new Date().toISOString(),
  rubRate: rate,
  allOrders: {
    categoryTopQty: catQtyList,
    categoryPathQty: catQtyPathList,
    productQty: skuQtyList,
  },
  settled: {
    packageCount: settledPkgIds.size,
    totalProfit: round2(settledProfitSum),
    totalSaleAmount: round2(settledSaleSum),
    categoryTopProfit: catProfitList.map((x) => ({ ...x, profit: round2(x.profit), saleAmount: round2(x.saleAmount), purchase: round2(x.purchase) })),
    categoryTopMargin: [...catProfitList].sort((a, b) => (marginSale(b) ?? -Infinity) - (marginSale(a) ?? -Infinity)).map((x) => ({ ...x, profit: round2(x.profit), saleAmount: round2(x.saleAmount), purchase: round2(x.purchase), marginSale: marginSale(x), marginCost: marginCost(x) })),
    categoryPathProfit: catProfitPathList.map((x) => ({ ...x, profit: round2(x.profit), saleAmount: round2(x.saleAmount), purchase: round2(x.purchase) })),
    categoryPathMargin: [...catProfitPathList].sort((a, b) => (marginSale(b) ?? -Infinity) - (marginSale(a) ?? -Infinity)).map((x) => ({ ...x, profit: round2(x.profit), saleAmount: round2(x.saleAmount), purchase: round2(x.purchase), marginSale: marginSale(x), marginCost: marginCost(x) })),
    productProfit: skuProfitList.map((x) => ({ sku: x.sku, title: x.title, catTop: x.catTop, catPath: x.catPath, qty: x.qty, orderCnt: x.orderCnt, saleAmount: round2(x.saleAmount), purchase: round2(x.purchase), profit: round2(x.profit), marginSale: marginSale(x), marginCost: marginCost(x) })),
  },
};
const outPath = path.join(__dirname, '..', 'data', 'order-sales-report.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n完整报告已导出: ${outPath}`);