// 订单处理(2026-08,个人自发货模式)
// 管理采购订单(1688/拼多多/淘宝)与 Ozon FBS 订单的关联
// 设计文档: docs/采购订单-Ozon订单关联管理-功能设计.md
//
// 路由:
//   GET  /admin/api/order-process/tabs            Tab 计数(待处理/待打单发货/交运/已发货/已搁置)
//   GET  /admin/api/order-process/list            包裹分页列表(tab+筛选+关键词)
//   GET  /admin/api/order-process/detail/:id      包裹详情(产品行+采购关联+轨迹)
//   GET  /admin/api/order-process/purchase/lookup 查询采购单已关联包裹(拼单提示)
//   POST /admin/api/order-process/purchase        提交采购信息(模式B:金额+国内快递单号)
//   POST /admin/api/order-process/unlink          取消采购关联(冲回金额)
//   POST /admin/api/order-process/ignore          搁置/恢复包裹
//   POST /admin/api/order-process/print-label     标记已打印面单(流转交运)
//   POST /admin/api/order-process/ship            备货(Ozon /v4/posting/fbs/ship 搜集订单,不拆分)
//   POST /admin/api/order-process/scan-ship/submit   扫描发货:提交重量(权威状态校验,仅 wait_ship 落库)
//   POST /admin/api/order-process/scan-ship/correct-weight  扫描发货:交运后更正重量(仅更新 weight)
//   GET  /admin/api/order-process/scan-ship/records  扫描发货:发货记录(今日/昨日,北京时间日界)
//   POST /admin/api/order-process/sync-run        手动触发 Ozon 订单增量同步(双接口)
//   POST /admin/api/order-process/sync-all-list  手动触发 /v4/posting/fbs/list 全量同步
//   GET  /admin/api/order-process/sync-status    各店铺最近同步状态
//   GET  /admin/api/order-process/sync-progress  实时同步进度(店铺数/已处理/已拉订单数)
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';
import config from '../config/index.js';
import { orderPackageDao } from '../db/dao/sqlite/order-daos.js';
import { upsertMiaoshouOrders, listMiaoshouPackages, countMiaoshouTabs, getMiaoshouPackageDetail } from '../db/dao/sqlite/miaoshou-dao.js';
import { runOrderSyncNow, runSyncAllList, runAccrualSync, syncSinglePackage, isSyncing, getSyncProgress, clearSyncProgress } from '../services/order-sync.js';
import { triggerPurchaseLogisticsSync, getPurchaseLogisticsStatus, syncPurchaseLogisticsForPackage } from '../services/purchase-logistics-poller.js';
import {
  packageLabel,
  postingFbsGet,
  postingFbsGetByBarcode,
  postingFbsShip,
  postingFbsUnfulfilledList,
  productInfoList,
  productInfoListBySku,
  productStocks,
  deliveryMethodList,
  carriageDeliveryList,
  carriageCreate,
  carriageGet,
  carriageApprove,
  carriageSetPostings,
  carriageCancel,
  carriageCourierContactSet,
  carriageCourierContactGet,
  carriagePostingList,
} from '../services/ozon-opi.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { notifyPostingEvent } from '../services/webhook/feishu-notify.js';
import { translateCancelReason } from '../services/cancel-reason-i18n.js';
import { getWaybill, setWaybill } from '../services/waybill-cache.js';
import { extractWaybillBarcodes } from '../services/waybill-barcode.js';
import { upsertPostingBarcode, findPostingByBarcode, missingBarcodePostings } from '../db/dao/sqlite/label-barcode-daos.js';
import { getAccrualsByPackageIds, getAccrualTypeSumsByPackageIds, getRubCnyRate, setRubCnyRate, getBydayStats, getSettledEligiblePackageIds } from '../db/dao/sqlite/accrual-dao.js';
import { stripImageSizeSuffix, imageCacheUrlFor } from '../services/order-image-cache.js';
import { runAccrualByDaySync } from '../services/accrual-byday-sync.js';
import { getPendingExportState } from '../db/dao/sqlite/purchase-sync-dao.js';
import {
  DELIVERY_BASE_CNY,
  DELIVERY_PER_G_CNY,
  estimateDeliveryCny,
  estimateProfit,
  isOglDelivery,
} from '../services/profit-estimator.js';
import { deriveOglWeight, getOglGroup } from '../services/ogl-freight.js';
// 采购单自动补全用平台搜索(跨账号,按单号拉订单详情含 goods)
import { searchAliOrder } from './platform-orders.js';
import { searchPddOrder } from '../services/platform-orders/adapters/pdd.js';
import { searchTaobaoOrder } from '../services/platform-orders/adapters/taobao.js';
import { searchXianyuOrder } from '../services/platform-orders/adapters/xianyu.js';

const router = Router();

// 预估佣金率/国际配送公式常量已抽取至 services/profit-estimator.js(2026-09-18,与价格管理页单点维护)
// 预估佣金率 16%(实测 payout/commission 未妥投恒为 0,需自算;对齐妙手"平台佣金 XX 估"口径)
// 国际配送费公式:delivery_cny = 3.37 + 0.0281 × weight_g(对齐 Ozon type 67)

// 解析 RUB→CNY 汇率(app_config 优先,.env 兜底)
function resolveRubCnyRate() {
  const fromConfig = getRubCnyRate();
  if (fromConfig) return fromConfig;
  if (config.rubCnyRateFallback > 0) {
    return { rate: config.rubCnyRateFallback, updatedAt: null, source: 'env' };
  }
  return null;
}

// ── 面单条码解析(2026-10-25,扫描发货扫码支持)───────────────────────────
// 扫码可能输入:采购快递单号/货件号(现有 7 字段直接命中)/面单条码(走本解析)
// 本地 op_posting_barcode 映射表优先,Ozon /v2/posting/fbs/get-by-barcode 在线兜底。

// 在线反查:条码 → 货件号,并回填本地映射表(多店铺按序尝试)
async function resolveBarcodeOnline(barcode, storeId) {
  const stores = (config.loadStores() || []).filter((s) => !storeId || s.id === storeId);
  for (const store of stores) {
    try {
      const r = await postingFbsGetByBarcode(store, barcode);
      const postingNumber = r?.result?.posting_number;
      if (postingNumber) {
        upsertPostingBarcode({
          storeId: store.id,
          postingNumber,
          lowerBarcode: barcode,
          fetchedAt: new Date().toISOString(),
        });
        return { postingNumber, storeId: store.id };
      }
    } catch (e) {
      // Ozon 对不存在的条码返回非 2xx(ozon-opi call 已记录 warn),这里仅记录意外错误
      const httpStatus = e?.details?.httpStatus;
      if (!(e instanceof ApiError) || !(httpStatus >= 400 && httpStatus < 500)) {
        logger.warn({ err: e?.message, store: store.id, barcode }, '[scan-barcode] get-by-barcode 查询异常');
      }
    }
  }
  return null;
}

// 扫码条码解析:本地映射优先,在线兜底
async function resolveBarcodeForList(barcode, storeId) {
  const local = findPostingByBarcode({ storeId: storeId || undefined, barcode });
  if (local) return { postingNumber: local.postingNumber, storeId: local.storeId };
  return resolveBarcodeOnline(barcode, storeId);
}

// 打印面单后回填条码映射(幂等;条码数与货件一致按索引 zip,不一致则逐条码在线反查归属)
async function backfillPostingBarcodes(storeId, postingNumbers, pdfBuffer) {
  const barcodes = await extractWaybillBarcodes(pdfBuffer);
  if (!barcodes.length) return 0;
  const now = new Date().toISOString();
  let filled = 0;
  if (barcodes.length === postingNumbers.length) {
    for (let i = 0; i < postingNumbers.length; i++) {
      const bc = barcodes[i];
      if (!bc) continue;
      upsertPostingBarcode({ storeId, postingNumber: postingNumbers[i], lowerBarcode: bc, fetchedAt: now });
      filled++;
    }
  } else {
    // 多页/少页:不按索引猜,逐条码在线反查归属
    for (const bc of barcodes) {
      if (!bc) continue;
      const resolved = await resolveBarcodeOnline(bc, storeId);
      if (resolved) filled++;
    }
  }
  return filled;
}

// 包裹列表响应富化(列表页/扫描发货共用:产品行 + 采购关联 + 应计 + 重量 + 利润)
function enrichListData(data) {
  const orderIds = data.packages.map((p) => p.ozonOrderId);
  const items = orderPackageDao.getItemsByOrderIds(orderIds);
  const pkgIds = data.packages.map((p) => p.id);
  const { links } = orderPackageDao.getPurchasesByPackageIds(pkgIds);
  const rateInfo = resolveRubCnyRate();
  const accrualMap = buildAccrualBreakdown(
    data.packages,
    getAccrualTypeSumsByPackageIds(pkgIds),
    rateInfo?.rate
  );
  const weightMap = orderPackageDao.getWeightsByPackageIds(pkgIds);
  const itemsByOrder = new Map();
  for (const it of items) {
    if (!itemsByOrder.has(it.ozonOrderId)) itemsByOrder.set(it.ozonOrderId, []);
    itemsByOrder.get(it.ozonOrderId).push(it);
  }
  const linksByPkg = new Map();
  for (const l of links) {
    if (!linksByPkg.has(l.packageId)) linksByPkg.set(l.packageId, []);
    linksByPkg.get(l.packageId).push(l);
  }
  for (const pkg of data.packages) {
    pkg.items = itemsByOrder.get(pkg.ozonOrderId) || [];
    pkg.purchaseLinks = linksByPkg.get(pkg.id) || [];
    pkg.cancelReasonCn = translateCancelReason(pkg.cancelReason); // 取消原因中文(未收录原样返回)
    if (accrualMap.has(pkg.id)) pkg.accrual = accrualMap.get(pkg.id);
    if (weightMap.has(pkg.id)) {
      const w = weightMap.get(pkg.id);
      pkg.weightG = w.weightG;
      pkg.weightSource = w.source;
      pkg.ozonWeightG = w.ozonWeightG ?? null;
      pkg.systemWeightG = w.systemWeightG ?? null;
    } else {
      pkg.ozonWeightG = null;
      pkg.systemWeightG = null;
    }
    pkg.profit = computeProfit(pkg, pkg.operateStatus === 'cancelled', rateInfo?.rate);
  }
  data.rubRate = rateInfo;
  // 机器名(2026-10-16 多机部署):供安卓差集兜底通知展示来源
  data.machineName = config.machineName;
  return data;
}

// 应计类型分组常量(列表金额列拆分:销售佣金/国际配送/其它[含代理佣金])
const TYPE_AGENT_FEE = 66;   // RfbsGlobalAgentFee 代理佣金(2026-09-18 起并入其它费用展示)
const TYPE_SALE_FEE = 69;    // SaleCommission 销售佣金
const TYPE_DELIVERY = 67;    // RfbsGlobalDelivery 国际配送

/** 为一批包裹构建应计 CNY 分组(列表行注入 pkg.accrual)
 *  typeSums: getAccrualTypeSumsByPackageIds 结果(RUB)
 *  返回 Map<packageId, accrual>;accrual.totalRub 为 null 的包裹不入 Map(拉过但空)
 *  结构: { rate, saleFee, agentFee, delivery, others, total, sale, payout,  // CNY
 *          saleFeeRub, agentFeeRub, deliveryRub, othersRub, totalRub, saleRub,  // RUB 原值(悬浮展示)
 *          derivedWeight }                                          // 由实际配送费反推的重量(g)
 */
function buildAccrualBreakdown(packages, typeSums, rate) {
  const byPkg = new Map();
  for (const t of typeSums) {
    if (!byPkg.has(t.packageId)) byPkg.set(t.packageId, new Map());
    byPkg.get(t.packageId).set(t.typeId, t.sum);
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  const out = new Map();
  // 终态门槛(2026-09-24):by-day 主源下在途订单早期即产生 Acquiring 等费用,
  // accrual_total 非空但收入侧(POSTING)未生成 → payout≈纯负费用,利润≈-采购严重失真
  // (postings 时代只对终态订单拉应计故无此问题)。仅签收/取消包裹走真实口径。
  const eligible = getSettledEligiblePackageIds(packages.map((p) => p.id));
  for (const pkg of packages) {
    if (pkg.accrualTotal == null || !rate) continue;
    if (!eligible.has(pkg.id)) continue;
    const m = byPkg.get(pkg.id) || new Map();
    const agentRub = m.get(TYPE_AGENT_FEE) || 0;
    const saleFeeRub = m.get(TYPE_SALE_FEE) || 0;
    const deliveryRub = m.get(TYPE_DELIVERY) || 0;
    const totalRub = Number(pkg.accrualTotal) || 0;
    const saleRub = Number(pkg.accrualSaleTotal) || 0;
    // 其它费用 = 应计合计 − 销售佣金(69) − 国际配送(67);代理佣金(66)并入其它展示
    const othersRub = round2(totalRub - saleFeeRub - deliveryRub);
    // 由实际配送费(CNY)反推商品重量(整数 g)
    // OGL(Доставка Ozon курьеру):按价值档分段反解(同一价值档小/大两组试算取一致)
    // 其他(ABT Economy 等):旧线性公式 weight = (|delivery| - 3.37) / 0.0281
    const deliveryCny = round2(deliveryRub * rate);
    const deliveryAbs = Math.abs(deliveryCny);
    const derivedWeight = isOglDelivery(pkg.deliveryMethod, pkg.tplIntegrationType)
      ? deriveOglWeight({ valueCny: pkg.orderAmount, deliveryCny: deliveryAbs })
      : (deliveryAbs > DELIVERY_BASE_CNY
        ? Math.floor((deliveryAbs - DELIVERY_BASE_CNY) / DELIVERY_PER_G_CNY)
        : null);
    out.set(pkg.id, {
      rate,
      saleFee: round2(saleFeeRub * rate),
      agentFee: round2(agentRub * rate),
      delivery: deliveryCny,
      others: round2(othersRub * rate),
      total: round2(totalRub * rate),
      sale: round2(saleRub * rate),
      payout: round2((saleRub + totalRub) * rate),
      saleFeeRub: round2(saleFeeRub),
      agentFeeRub: round2(agentRub),
      deliveryRub: round2(deliveryRub),
      othersRub,
      totalRub: round2(totalRub),
      saleRub: round2(saleRub),
      derivedWeight,
    });
  }
  return out;
}

// 计算列表行的利润指标(金额列:订单金额/采购金额/代理佣金/国际配送/其它费用/利润)
// 双口径(2026-09):有真实应计(已完成/已取消且 accrual_total 非空)用真实口径,否则预估口径
//   真实口径: 利润 = (销售+应计合计)×汇率 − 采购;estimated=false(前端显示"实")
//   预估口径: 佣金 = orderAmount × 0.16;estimated=true(前端显示"估")
// 已取消(2026-09-03):无订单收入,佣金不估算(应计无佣金即 0),利润 = −采购(无采购/应计则为 0)
function computeProfit(pkg, cancelled = false, rate = null) {
  const orderAmount = Number(pkg.orderAmount) || 0;
  const purchase = Number(pkg.totalPurchaseAmount) || 0;
  const round2 = (n) => Math.round(n * 100) / 100;

  // 真实应计口径(列表路由已注入 pkg.accrual CNY 分组)
  const a = pkg.accrual;
  if (a?.rate && a.payout != null) {
    const profit = round2(a.payout - purchase);
    // 同时按配送方式估算配送费(基于实际重量,供前端对比展示;OGL 走分档费率并附评分组)
    const w = pkg.weightG != null ? Number(pkg.weightG) : null;
    const deliveryEst = w != null
      ? estimateDeliveryCny({
          weightG: w,
          valueCny: orderAmount,
          deliveryMethodName: pkg.deliveryMethod,
          tplIntegrationType: pkg.tplIntegrationType,
        })
      : null;
    const deliveryGroup = w != null && isOglDelivery(pkg.deliveryMethod, pkg.tplIntegrationType)
      ? getOglGroup(orderAmount, w)?.name || null
      : null;
    return {
      estimated: false,
      // 佣金兼容字段:非配送类扣款合计(销售佣金+代理佣金+其它;others 已含 66,勿再加 agentFee)
      commission: round2(a.total - a.delivery),
      escrow: a.payout,
      profit,
      // 公式估算的配送费(基于实际重量,仅展示用,不参与利润计算)
      delivery: deliveryEst,
      deliveryGroup,
      weightG: w,
      weightSource: pkg.weightSource || null,
      // 已取消订单收入为 0,利润率无意义不显示
      profitRateCost: cancelled ? null : (purchase > 0 ? Math.round((profit / purchase) * 10000) / 100 : null),
      profitRateSale: cancelled ? null : (orderAmount > 0 ? Math.round((profit / orderAmount) * 10000) / 100 : null),
      rubRate: a.rate,
      payoutRub: round2(a.saleRub + a.totalRub),
    };
  }

  // 已取消/已关闭(无应计):无收入,佣金/配送/其它均 0,利润 = −采购
  if (cancelled) {
    return {
      commission: 0,
      escrow: 0,
      profit: round2(-purchase),
      profitRateCost: null,
      profitRateSale: null,
      estimated: true,
      cancelled: true,
    };
  }

  // 已退货且无真实应计(2026-09-15):退货货款必然被 Ozon 全额扣回(应计可能尚未同步),
  // 不做乐观预估(按正常销售估算会虚高),按确定性规则 利润=−采购;退货商品一律销毁,无残值
  if (pkg.isReturned) {
    return {
      commission: 0,
      escrow: 0,
      profit: round2(-purchase),
      profitRateCost: null,
      profitRateSale: null,
      estimated: true,
      returned: true,
    };
  }

  // 预估口径(2026-09-18 抽取为共享 profit-estimator,与价格管理页单点维护):
  // 佣金 16%;配送独立扣减(3.37 + 0.0281×weight_g,CNY);无重量回退 16% 打包口径
  const est = estimateProfit({
    amountCny: orderAmount,
    purchaseCny: purchase,
    weightG: pkg.weightG != null ? Number(pkg.weightG) : null,
    deliveryMethodName: pkg.deliveryMethod,
    tplIntegrationType: pkg.tplIntegrationType,
  });
  return { ...est, weightSource: pkg.weightSource || null };
}

// ── Tab 计数 ────────────────────────────────────────────────
router.get('/admin/api/order-process/tabs', (_req, res) => {
  res.json(ok(orderPackageDao.tabCounts()));
});

// ── 待导出状态(采购信息跨机文件同步徽标)──────────────────────
// 本机跑过导出脚本(app_config mode=secondary)才激活;
// count = 上次导出后发生过人工操作(采购/称重/交运/搁置)的包裹数(提示性信号)
router.get('/admin/api/order-process/pending-export', (_req, res) => {
  res.json(ok(getPendingExportState()));
});

// ── 已用标签列表(筛选下拉,2026-09-15)──────────────────────
router.get('/admin/api/order-process/tags', (_req, res) => {
  res.json(ok(orderPackageDao.listPackageTags()));
});

// ── 设置标签全局顺序(2026-09-15 v4)────────────────────────
// body: { names: string[] } 全量覆盖,索引即顺序;
// 影响:筛选下拉/选择面板/订单 chip 展示顺序(三者一致)
router.put('/admin/api/order-process/tags-order', (req, res, next) => {
  try {
    const names = req.body?.names;
    if (!Array.isArray(names) || names.length === 0) {
      return res.status(400).json({ ok: false, message: 'names 必须为非空数组' });
    }
    const n = orderPackageDao.setTagOrder(names);
    res.json(ok({ count: n }));
  } catch (e) { next(e); }
});

// ── 包裹列表 ────────────────────────────────────────────────
// query: tab / keyword / storeId / purchaseStatus / arrived / cancelInitiator / page / pageSize
//        / globalKeyword / globalMode(eq|ss) —— 全局搜索:跨所有状态检索(§9.1.1)
//        / sortBy(order|delivering|return) / sortOrder(desc|asc) —— 排序(2026-09-20)
router.get('/admin/api/order-process/list', async (req, res, next) => {
  try {
    const q = req.query;
    const globalKw = String(q.globalKeyword || '').trim();
    const baseFilters = {
      tab: q.tab,
      keyword: q.keyword,
      storeId: q.storeId,
      purchaseStatus: q.purchaseStatus,
      noteFilter: q.noteFilter, // ''|'has'|'none' 备注筛选(2026-09-15)
      tag: q.tag,               // 标签名精确筛选(2026-09-15)
      arrived: q.arrived,
      cancelInitiator: q.cancelInitiator, // client/ozon/seller(仅 cancelled tab 用)
      globalKeyword: globalKw,
      globalMode: q.globalMode,
      sortBy: q.sortBy,         // order|delivering|return(2026-09-20)
      sortOrder: q.sortOrder,   // desc|asc(2026-09-20)
      purchaseUnshippedHours: q.purchaseUnshippedHours, // 采购超 N h 未发货(2026-10-17)
      logisticsStaleHours: q.logisticsStaleHours,      // 物流超 N h 未更新(2026-10-17)
      page: q.page,
      pageSize: q.pageSize,
    };
    let data = orderPackageDao.listPackages(baseFilters);

    // 全局搜索 0 结果且关键词疑似面单条码(纯数字 >=10 位)时,尝试条码→货件号解析(2026-10-25)
    if (data.total === 0 && /^\d{10,}$/.test(globalKw)) {
      const resolved = await resolveBarcodeForList(globalKw, q.storeId);
      if (resolved) {
        data = orderPackageDao.listPackages({
          ...baseFilters,
          storeId: resolved.storeId || q.storeId || undefined,
          globalKeyword: resolved.postingNumber,
          globalMode: 'eq',
        });
      }
    }

    enrichListData(data);
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

// ── Tab 聚合统计(当前 Tab+筛选全集不分页,分四组:已结算/已采购未结算/已取消/已退货)─────
// query 同 /list(除不接 page/pageSize)
// 已结算组:delivered 且应计同时含 type 66 和 67(真实口径)
// 已采购未结算组:已采购(purchase_status != 'none')且不满足已结算且非已取消(预估口径)
// 已取消组(2026-09-15):利润=−采购(无应计)或应计退款口径,利润率无意义不计算
// 已退货组(2026-09-15):妥投后退货退款,按行内同口径利润单独汇总
router.get('/admin/api/order-process/summary', (req, res, next) => {
  try {
    const q = req.query;
    const data = orderPackageDao.aggregatePackages({
      tab: q.tab,
      keyword: q.keyword,
      storeId: q.storeId,
      purchaseStatus: q.purchaseStatus,
      noteFilter: q.noteFilter,
      tag: q.tag,
      arrived: q.arrived,
      cancelInitiator: q.cancelInitiator,
      globalKeyword: q.globalKeyword,
      globalMode: q.globalMode,
    });
    const pkgs = data.packages;
    const pkgIds = pkgs.map((p) => p.id);
    const rateInfo = resolveRubCnyRate();
    const rate = rateInfo?.rate;
    // 调一次 typeSums,既给 buildAccrualBreakdown 用,也用于构造 has66/has67 集合
    const typeSums = getAccrualTypeSumsByPackageIds(pkgIds);
    const accrualMap = buildAccrualBreakdown(pkgs, typeSums, rate);
    // 批量查包裹重量(供 computeProfit 走国际配送公式 3.37 + 0.0281 × weight_g)
    const weightMap = orderPackageDao.getWeightsByPackageIds(pkgIds);
    const has66 = new Set();
    const has67 = new Set();
    for (const t of typeSums) {
      if (t.typeId === TYPE_AGENT_FEE) has66.add(t.packageId);
      else if (t.typeId === TYPE_DELIVERY) has67.add(t.packageId);
    }
    for (const pkg of pkgs) {
      if (accrualMap.has(pkg.id)) pkg.accrual = accrualMap.get(pkg.id);
      if (weightMap.has(pkg.id)) {
        pkg.weightG = weightMap.get(pkg.id).weightG;
        pkg.weightSource = weightMap.get(pkg.id).source;
      }
      pkg.profit = computeProfit(pkg, pkg.operateStatus === 'cancelled', rate);
    }

    const round2 = (n) => Math.round(n * 100) / 100;
    const settled = { orderCount: 0, totalOrderAmount: 0, totalPurchaseAmount: 0, totalProfit: 0, profitRateSale: null, profitRateCost: null, estimated: !rate };
    const pendingSettled = { orderCount: 0, totalOrderAmount: 0, totalPurchaseAmount: 0, totalProfit: 0, profitRateSale: null, profitRateCost: null, estimated: true };
    // 已取消(2026-09-15):利润=−采购(无应计)或应计退款口径(有应计),利润率无意义不计算
    // byInitiator:按取消发起者细分(client/ozon/seller/unknown);ozonQualityInspection:ozon 取消中质检单(992/994)
    const cancelled = {
      orderCount: 0, totalOrderAmount: 0, totalPurchaseAmount: 0, totalProfit: 0, estimated: !rate,
      byInitiator: { client: 0, ozon: 0, seller: 0, unknown: 0 },
      ozonQualityInspection: 0,
    };
    // 已退货(2026-09-15):妥投后退货退款,按行内同口径利润单独汇总
    const returned = { orderCount: 0, totalOrderAmount: 0, totalPurchaseAmount: 0, totalProfit: 0, profitRateSale: null, profitRateCost: null, estimated: !rate };
    let cancelledCount = 0;
    let returnedCount = 0;

    for (const pkg of pkgs) {
      const isCancelled = pkg.operateStatus === 'cancelled';
      if (isCancelled) {
        cancelledCount++;
        cancelled.orderCount++;
        cancelled.totalOrderAmount += pkg.orderAmount;
        cancelled.totalPurchaseAmount += pkg.totalPurchaseAmount;
        cancelled.totalProfit += pkg.profit.profit;
        if (pkg.profit.estimated) cancelled.estimated = true;
        // 细分:按取消发起者计数;ozon 取消中质检单(992/994)单独计数
        const init = pkg.cancellationType;
        if (init === 'client' || init === 'ozon' || init === 'seller') {
          cancelled.byInitiator[init]++;
          if (init === 'ozon' && (pkg.cancelReasonId === 992 || pkg.cancelReasonId === 994)) {
            cancelled.ozonQualityInspection++;
          }
        } else {
          cancelled.byInitiator.unknown++;
        }
        continue;
      }
      // 已退货订单不参与"已成功/已采购未结算"两组汇总(与 Tab 口径一致,单独成组)
      if (pkg.isReturned) {
        returnedCount++;
        returned.orderCount++;
        returned.totalOrderAmount += pkg.orderAmount;
        returned.totalPurchaseAmount += pkg.totalPurchaseAmount;
        returned.totalProfit += pkg.profit.profit;
        if (pkg.profit.estimated) returned.estimated = true;
        continue;
      }

      const isSettled = pkg.operateStatus === 'wait_receiver_confirm'
        && pkg.deliveredAt != null
        && has66.has(pkg.id) && has67.has(pkg.id);

      if (isSettled) {
        settled.orderCount++;
        settled.totalOrderAmount += pkg.orderAmount;
        settled.totalPurchaseAmount += pkg.totalPurchaseAmount;
        settled.totalProfit += pkg.profit.profit;
        if (pkg.profit.estimated) settled.estimated = true;
      } else if (pkg.purchaseStatus !== 'none') {
        // 已采购未结算(含未妥投的已采购订单,符合用户原话语义)
        pendingSettled.orderCount++;
        pendingSettled.totalOrderAmount += pkg.orderAmount;
        pendingSettled.totalPurchaseAmount += pkg.totalPurchaseAmount;
        pendingSettled.totalProfit += pkg.profit.profit;
      }
    }

    settled.totalOrderAmount = round2(settled.totalOrderAmount);
    settled.totalPurchaseAmount = round2(settled.totalPurchaseAmount);
    settled.totalProfit = round2(settled.totalProfit);
    settled.profitRateSale = settled.totalOrderAmount > 0 ? Math.round((settled.totalProfit / settled.totalOrderAmount) * 10000) / 100 : null;
    settled.profitRateCost = settled.totalPurchaseAmount > 0 ? Math.round((settled.totalProfit / settled.totalPurchaseAmount) * 10000) / 100 : null;

    pendingSettled.totalOrderAmount = round2(pendingSettled.totalOrderAmount);
    pendingSettled.totalPurchaseAmount = round2(pendingSettled.totalPurchaseAmount);
    pendingSettled.totalProfit = round2(pendingSettled.totalProfit);
    pendingSettled.profitRateSale = pendingSettled.totalOrderAmount > 0 ? Math.round((pendingSettled.totalProfit / pendingSettled.totalOrderAmount) * 10000) / 100 : null;
    pendingSettled.profitRateCost = pendingSettled.totalPurchaseAmount > 0 ? Math.round((pendingSettled.totalProfit / pendingSettled.totalPurchaseAmount) * 10000) / 100 : null;

    cancelled.totalOrderAmount = round2(cancelled.totalOrderAmount);
    cancelled.totalPurchaseAmount = round2(cancelled.totalPurchaseAmount);
    cancelled.totalProfit = round2(cancelled.totalProfit);

    returned.totalOrderAmount = round2(returned.totalOrderAmount);
    returned.totalPurchaseAmount = round2(returned.totalPurchaseAmount);
    returned.totalProfit = round2(returned.totalProfit);
    returned.profitRateSale = returned.totalOrderAmount > 0 ? Math.round((returned.totalProfit / returned.totalOrderAmount) * 10000) / 100 : null;
    returned.profitRateCost = returned.totalPurchaseAmount > 0 ? Math.round((returned.totalProfit / returned.totalPurchaseAmount) * 10000) / 100 : null;

    // 整体(终态合计,2026-09-15):已成功 + 已取消 + 已退货 三组之和
    // 不含"已采购未结算"(在途,未到终态);利润率按合计算,估/实取任一估则估
    const overall = {
      orderCount: settled.orderCount + cancelled.orderCount + returned.orderCount,
      totalOrderAmount: round2(settled.totalOrderAmount + cancelled.totalOrderAmount + returned.totalOrderAmount),
      totalPurchaseAmount: round2(settled.totalPurchaseAmount + cancelled.totalPurchaseAmount + returned.totalPurchaseAmount),
      totalProfit: round2(settled.totalProfit + cancelled.totalProfit + returned.totalProfit),
      estimated: (settled.orderCount > 0 && settled.estimated) || (cancelled.orderCount > 0 && cancelled.estimated) || (returned.orderCount > 0 && returned.estimated),
    };
    overall.profitRateSale = overall.totalOrderAmount > 0 ? Math.round((overall.totalProfit / overall.totalOrderAmount) * 10000) / 100 : null;
    overall.profitRateCost = overall.totalPurchaseAmount > 0 ? Math.round((overall.totalProfit / overall.totalPurchaseAmount) * 10000) / 100 : null;

    res.json(ok({
      overall,
      settled,
      pendingSettled,
      cancelled,
      returned,
      returnedCount,
      totalOrders: settled.orderCount + pendingSettled.orderCount + cancelledCount + returnedCount,
      cancelledCount,
      truncated: data.truncated,
      truncatedAt: data.truncatedAt,
      totalUnfiltered: data.truncated ? data.total : null,
      rubRate: rateInfo,
    }));
  } catch (e) {
    next(e);
  }
});

// ── 包裹详情 ────────────────────────────────────────────────
// 响应追加 accruals(应计明细,含 CNY 换算字段)+ accrual(CNY 分组)+ rubRate(汇率)
router.get('/admin/api/order-process/detail/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const detail = orderPackageDao.getPackageDetail(id);
    if (!detail) return res.status(404).json({ ok: false, message: '包裹不存在' });
    const rateInfo = resolveRubCnyRate();
    const rate = rateInfo?.rate;
    // 明细行附 CNY 换算(amountCny/sellerPriceCny;RUB 原值保留在 amount/sellerPrice)
    detail.accruals = getAccrualsByPackageIds([id]).map((a) => ({
      ...a,
      amountCny: rate != null ? Math.round((Number(a.amount) || 0) * rate * 100) / 100 : null,
      sellerPriceCny: rate != null && a.sellerPrice != null
        ? Math.round(Number(a.sellerPrice) * rate * 100) / 100 : null,
    }));
    const accrualMap = buildAccrualBreakdown([detail.package], getAccrualTypeSumsByPackageIds([id]), rate);
    if (accrualMap.has(id)) detail.package.accrual = accrualMap.get(id);
    // 注入包裹重量(供 computeProfit 走国际配送公式 3.37 + 0.0281 × weight_g)
    const weightMap = orderPackageDao.getWeightsByPackageIds([id]);
    if (weightMap.has(id)) {
      detail.package.weightG = weightMap.get(id).weightG;
      detail.package.weightSource = weightMap.get(id).source;
    }
    detail.rubRate = rateInfo;
    detail.package.profit = computeProfit(detail.package, detail.package.operateStatus === 'cancelled', rate);
    res.json(ok(detail));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/order-process/purchase-history/:packageId —— 未采购订单"最近采购参考"(2026-10-28)
// 按包裹商品 SKU 精确匹配历史采购单(最多5条),供未采购订单录入采购时参考最近价格/供应商/买家账号
// 2026-10-29:由 offer_id 改为 SKU(同 SKU 可能因改款/变体有多个 offer_id,仅按 offer_id 会漏同款历史单)
router.get('/admin/api/order-process/purchase-history/:packageId', (req, res, next) => {
  try {
    const packageId = Number(req.params.packageId);
    if (!packageId) return res.status(400).json({ ok: false, message: 'packageId 必填' });
    const detail = orderPackageDao.getPackageDetail(packageId);
    if (!detail) return res.status(404).json({ ok: false, message: '包裹不存在' });
    const skus = (detail.items || []).map((it) => it.sku);
    const history = orderPackageDao.getRecentPurchasesBySkus(skus, 5);
    res.json(ok(history));
  } catch (e) {
    next(e);
  }
});

// GET /admin/api/order-process/detail/:id/stock —— 查询订单商品库存(2026-10-17)
// 策略(2026-10-18):订单里的 offer_id 可能因商品改款/重新上架与 Ozon 当前不一致,
// 先按订单 offer_id 查 /v3/product/info/list,未命中的商品再按 sku 回退查询。
// Ozon 返回 stocks 为 { has_stock, stocks:[{present,reserved,sku,source}] },source=fbs 即卖家仓库库存。
// 返回时 offerId 用订单原始 offer_id,保证前端按 offerId 关联展示。
router.get('/admin/api/order-process/detail/:id/stock', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const detail = orderPackageDao.getPackageDetail(id);
    if (!detail) return res.status(404).json({ ok: false, message: '包裹不存在' });
    const storeId = detail.package.storeId;
    const store = config.loadStores().find((s) => s.id === storeId);
    if (!store) return res.json(ok({ stocks: [] })); // 店铺已下架等:返回空,前端不展示库存
    const items = detail.items || [];
    if (!items.length) return res.json(ok({ stocks: [] }));

    // sku -> { present, reserved, productId }
    const foundBySku = new Map();
    const parseStock = (it) => {
      const arr = it?.stocks && Array.isArray(it.stocks.stocks) ? it.stocks.stocks : [];
      const fbs = arr.filter((s) => !s.source || s.source === 'fbs');
      const present = fbs.reduce((sum, s) => sum + (Number(s.present) || 0), 0);
      const reserved = fbs.reduce((sum, s) => sum + (Number(s.reserved) || 0), 0);
      return { present, reserved, productId: String(it.id || '') };
    };

    const offerItems = items.filter((it) => it.offerId);
    if (offerItems.length) {
      const r = await productInfoList(store, offerItems.map((it) => it.offerId));
      for (const oi of r?.items || []) {
        if (oi && oi.sku != null) foundBySku.set(String(oi.sku), parseStock(oi));
      }
    }
    const missing = items.filter((it) => it.sku != null && String(it.sku).trim() !== '' && !foundBySku.has(String(it.sku)));
    if (missing.length) {
      const r = await productInfoListBySku(store, missing.map((it) => Number(it.sku)));
      for (const oi of r?.items || []) {
        if (oi && oi.sku != null) foundBySku.set(String(oi.sku), parseStock(oi));
      }
    }

    const stocks = items
      .map((it) => {
        const info = it.sku != null ? foundBySku.get(String(it.sku)) : undefined;
        if (!info) return null;
        return {
          sku: it.sku,
          offerId: it.offerId, // 用订单原始 offer_id,前端 stockMap 按 offerId 匹配
          productId: info.productId,
          present: info.present,
          reserved: info.reserved,
          total: info.present + info.reserved,
        };
      })
      .filter(Boolean);
    res.json(ok({ stocks }));
  } catch (e) {
    next(e);
  }
});

// POST /admin/api/order-process/detail/:id/stock —— 修改订单商品库存(2026-10-17)
// body: { offerId, stock }  → 调 Ozon /v2/products/stocks 更新当前店铺仓库库存
router.post('/admin/api/order-process/detail/:id/stock', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const offerId = String(req.body?.offerId || '');
    const stock = Number(req.body?.stock);
    if (!offerId) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'offerId 必填'));
    if (!Number.isFinite(stock) || stock < 0) return next(new ApiError(ErrorCode.VALIDATION_ERROR, 'stock 必须为非负整数'));
    const detail = orderPackageDao.getPackageDetail(id);
    if (!detail) return res.status(404).json({ ok: false, message: '包裹不存在' });
    const storeId = detail.package.storeId;
    const store = config.loadStores().find((s) => s.id === storeId);
    if (!store) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, '店铺不存在: ' + storeId));
    // 先查 product_id(/v2/products/stocks 需要 product_id + offer_id)
    // 订单 offer_id 可能已改款/重新上架,查不到时按 body.sku 回退(2026-10-18)
    const sku = req.body?.sku ? Number(req.body.sku) : 0;
    let pInfo = (await productInfoList(store, [offerId]))?.items?.[0];
    if (!pInfo && sku) {
      pInfo = (await productInfoListBySku(store, [sku]))?.items?.[0];
    }
    if (!pInfo) return next(new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `Ozon 未查到商品 offer_id=${offerId}`));
    // 用 Ozon 当前有效的 offer_id 设置库存(订单旧 offer_id 可能已失效)
    const targetOfferId = pInfo.offer_id || offerId;
    const upd = await productStocks(store, [{ offerId: targetOfferId, productId: Number(pInfo.id), stock: Math.round(stock) }]);
    const updated = upd?.result?.[0]?.updated ?? false;
    res.json(ok({ updated }));
  } catch (e) {
    next(e);
  }
});

// ── 查询采购单已关联包裹(拼单提交前提示用)─────────────────
router.get('/admin/api/order-process/purchase/lookup', (req, res, next) => {
  try {
    const { platform, purchaseSn } = req.query;
    if (!platform || !purchaseSn) {
      return res.status(400).json({ ok: false, message: 'platform/purchaseSn 必填' });
    }
    res.json(ok(orderPackageDao.lookupPurchase(platform, purchaseSn)));
  } catch (e) {
    next(e);
  }
});

// ── 提交采购信息(模式B)────────────────────────────────────
// body: {
//   packageId, platform?, purchaseSn?, paymentAmount?, logisticsCompany?, logisticsNo?,
//   buyerAccount?, sellerName?, note?,
//   items: [{ itemId, amount, quantity }],
//   platformGoods?: [{ goodsName, spec, price, number, thumbUrl }] —— 平台订单商品(导入勾选携带),直接写入 items_json
//   allocMode?: 'manual' | 'auto'  —— manual=手动填金额, auto=按quantity加权自动分摊
// }
// 提交即流转:包裹 wait_process → wait_ship(直接待打单发货)
// 保存后兜底:手填单号(无 platformGoods)且平台单号单一时,异步搜索详情自动补全 items_json

// 采购单自动补全(2026-09-16):按单号跨账号搜索平台订单详情,goods 含 thumbUrl 时写入 items_json
// 场景:模式B手填单号保存时无商品信息,后台异步拉详情补全,免手动"补全采购订单信息"
// 失败仅记日志不阻塞流程(浏览器未开/登录失效时用户可手动补全兜底)
const AUTO_ENRICH_SEARCH = {
  '1688': (orderSn, accounts) => searchAliOrder(orderSn, accounts),
  yangkeduo: (orderSn, accounts) => searchPddOrder(orderSn, accounts),
  taobao: (orderSn, accounts) => searchTaobaoOrder(orderSn, accounts),
  xianyu: (orderSn, accounts) => searchXianyuOrder(orderSn, accounts),
};
async function autoEnrichPurchase(dbPlatform, orderSn) {
  try {
    const po = db
      .prepare(`SELECT id, items_json, seller_name FROM op_purchase_order WHERE platform = ? AND purchase_sn = ?`)
      .get(dbPlatform, orderSn);
    if (!po) return;
    // 2026-10-28:已有图但缺卖家名时不提前返回——继续搜索,只回填卖家名不覆盖已有商品图
    const hasThumb = !!(po.items_json && po.items_json.includes('thumbUrl'));
    const hasSeller = !!(po.seller_name && String(po.seller_name).trim());
    if (hasThumb && hasSeller) return;
    const searchFn = AUTO_ENRICH_SEARCH[dbPlatform];
    const accounts = config.platformAccounts[{ '1688': 'ali1688', yangkeduo: 'pdd', taobao: 'taobao', xianyu: 'xianyu' }[dbPlatform]] || [];
    if (!searchFn || !accounts.length) return;
    const { result } = await searchFn(orderSn, accounts);
    if (!result?.goods?.length && !result?.sellerName) return;
    // 2026-10-27:搜索结果带回 sellerName,随补全一并回填(手动录入单买家账号已有,卖家名缺失)
    const r = orderPackageDao.enrichPurchaseItems([{
      platform: dbPlatform,
      purchaseSn: orderSn,
      sellerName: result.sellerName || null,
      goods: hasThumb ? [] : result.goods, // 已有图只回填卖家名,不重复写 items_json
    }]);
    if (r.updated > 0) logger.info({ platform: dbPlatform, purchaseSn: orderSn, goods: result.goods.length }, '[order-process] 采购单自动补全完成');
  } catch (e) {
    logger.warn({ platform: dbPlatform, purchaseSn: orderSn, err: e?.message }, '[order-process] 采购单自动补全失败(可手动补全兜底)');
  }
}

router.post('/admin/api/order-process/purchase', (req, res, next) => {
  try {
    const b = req.body || {};
    const packageId = Number(b.packageId);
    if (!packageId) return res.status(400).json({ ok: false, message: 'packageId 必填' });
    const items = Array.isArray(b.items) ? b.items : [];
    if (items.length === 0) {
      return res.status(400).json({ ok: false, message: '至少填写一行采购金额' });
    }
    const isAuto = b.allocMode === 'auto';
    // 校验:auto 模式看 paymentAmount(总额按数量加权分摊);manual 看每行 amount
    const hasAmount = isAuto ? Number(b.paymentAmount) > 0 : items.some((it) => Number(it.amount) > 0);
    const hasLogisticsNo = !!b.logisticsNo;
    if (!hasAmount && !hasLogisticsNo) {
      return res.status(400).json({ ok: false, message: '请填写采购金额或国内快递单号' });
    }
    // 2026-09-19 手工单(无单号)下线:新建提交必须携带采购单号,防止再产生 platform=other+无单号的空壳手工单
    if (!String(b.purchaseSn || '').trim()) {
      return res.status(400).json({ ok: false, message: '请填写采购单号或从平台订单选择(已不支持无单号手工单)' });
    }
    // 2026-09-20 多单号防误粘:一次提交只允许一个采购单号
    // 实测事故:两个单号连逗号一起粘进输入框,系统按"一个单号"建单导致
    // 单号拼接/物流同步失败/单号查找语义混乱(采购单 260915-216226916643751,260920-...)
    if (/[,，;；\s]/.test(String(b.purchaseSn).trim())) {
      return res.status(400).json({ ok: false, message: '采购单号一次只能填写一个(检测到分隔符或多个单号)，多个采购单请分次提交' });
    }
    // 平台订单商品:过滤出有 thumbUrl 的(与 enrichPurchaseItems 口径一致),序列化后随 upsert 写入
    // 2026-10-17:落库前统一去掉平台缩略图尺寸后缀(1688 .80x80.jpg → 原图),保证采购主图清晰
    const goodsArr = (Array.isArray(b.platformGoods) ? b.platformGoods : [])
      .filter((g) => g && g.thumbUrl)
      .map((g) => ({ ...g, thumbUrl: stripImageSizeSuffix(g.thumbUrl) }));
    const itemsJson = goodsArr.length ? JSON.stringify(goodsArr) : null;
    const r = orderPackageDao.submitPurchase({
      packageId,
      platform: b.platform || 'other',
      purchaseSn: b.purchaseSn || null,
      paymentAmount: b.paymentAmount,
      logisticsCompany: b.logisticsCompany || null,
      logisticsNo: b.logisticsNo || null,
      buyerAccount: b.buyerAccount || null,
      buyerUserId: b.buyerUserId || null,
      sellerName: b.sellerName || null,
      note: b.note || null,
      items,
      itemsJson,
      allocMode: isAuto ? 'auto' : 'manual',
    });
    // 异步自动补全:无 goods 写入(手填)或未填卖家名时,且是可搜索平台的单一单号,后台拉详情
    // 2026-10-29:放宽为"无图或缺卖家名"都触发——带平台商品图提交但卖家名为空的单,
    // 也会走 autoEnrichPurchase(内部已有图则只回填卖家名、不覆盖 items_json)
    const sn = String(b.purchaseSn || '').trim();
    const needSeller = !String(b.sellerName || '').trim();
    if ((!goodsArr.length || needSeller) && AUTO_ENRICH_SEARCH[b.platform] && sn && !sn.includes(',')) {
      setImmediate(() => autoEnrichPurchase(b.platform, sn));
    }
    // 回填本系统维护的采购价/重量(仅空值时,有值不动;2026-09-19)
    try {
      const bf = orderPackageDao.backfillProductCache(packageId);
      if (bf.purchaseFilled || bf.weightFilled) {
        logger.info({ packageId, ...bf }, '[order-process] 自动回填采购价/重量');
      }
    } catch (e) {
      logger.warn({ packageId, err: e.message }, '[order-process] 回填采购价/重量失败');
    }
    // 保存后异步补查物流(2026-09-17):采购弹窗列表已不再逐单查物流(1688限流主因),
    // 勾选保存为采购订单后统一补一次(1688补单号+拉轨迹/PDD搜索+轨迹,限速2s/单)
    setImmediate(async () => {
      try {
        await syncPurchaseLogisticsForPackage(packageId);
      } catch (e) {
        logger.warn({ packageId, err: e.message }, '[order-process] 保存后补查采购物流失败');
      }
    });
    logger.info({ packageId, purchaseOrderId: r.purchaseOrderId, allocMode: isAuto ? 'auto' : 'manual', goodsSaved: goodsArr.length }, '[order-process] 采购信息已提交');
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

// ── 修改已有采购的分摊金额(采购弹窗取消「自动填写金额」后手填保存)──
// body: { packageId, items: [{ itemId, amount }] }
// 语义:不新增采购单,只更新已有 link 的 allocated_amount;行级归属唯一才可修改
router.post('/admin/api/order-process/purchase-alloc', (req, res, next) => {
  try {
    const packageId = Number(req.body?.packageId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!packageId) return res.status(400).json({ ok: false, message: 'packageId 必填' });
    if (!items.length) return res.status(400).json({ ok: false, message: '至少填写一行采购金额' });
    const r = orderPackageDao.updatePurchaseAlloc({ packageId, items });
    // 回填本系统维护的采购价(仅空值时,有值不动;2026-09-19)
    try {
      const bf = orderPackageDao.backfillProductCache(packageId);
      if (bf.purchaseFilled || bf.weightFilled) {
        logger.info({ packageId, ...bf }, '[order-process] 自动回填采购价/重量(改分摊)');
      }
    } catch (e) {
      logger.warn({ packageId, err: e.message }, '[order-process] 回填采购价/重量失败(改分摊)');
    }
    logger.info({ packageId, ...r }, '[order-process] 采购分摊金额已修改');
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

// ── 手动录入/修改采购单国内物流单号(2026-09-20,闲鱼等无物流接口平台)──
// body: { purchaseOrderId, logisticsNo, logisticsCompany? }
// 闲鱼列表接口不返回物流单号,卖家发货后用户从闲鱼订单/聊天复制单号手动录入;
// 状态联动 wait_send/wait_pay→shipped,关联包裹头程物流空值补齐;详见 DAO 注释
router.post('/admin/api/order-process/purchase-logistics', (req, res, next) => {
  try {
    const purchaseOrderId = Number(req.body?.purchaseOrderId);
    if (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0) {
      return res.status(400).json({ ok: false, message: 'purchaseOrderId 必填' });
    }
    const r = orderPackageDao.updatePurchaseLogistics({
      purchaseOrderId,
      logisticsNo: req.body?.logisticsNo,
      logisticsCompany: req.body?.logisticsCompany,
    });
    logger.info({ ...r }, '[order-process] 采购单物流单号已录入');
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

// ── 清空采购信息(采购弹窗空表单保存:冲回全部关联+聚合/头程物流归零)──
// body: { packageId }
// 返回 { cleared, hadPurchase };不回退 operate_status(回流待处理走 /revert)
router.post('/admin/api/order-process/purchase/clear', (req, res, next) => {
  try {
    const packageId = Number(req.body?.packageId);
    if (!packageId) return res.status(400).json({ ok: false, message: 'packageId 必填' });
    const r = orderPackageDao.clearAllPurchase(packageId);
    logger.info({ packageId, ...r }, '[order-process] 采购信息已清空');
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

// ── 取消采购关联 ────────────────────────────────────────────
router.post('/admin/api/order-process/unlink', (req, res, next) => {
  try {
    const purchaseOrderId = Number(req.body?.purchaseOrderId);
    const packageId = Number(req.body?.packageId);
    if (!purchaseOrderId || !packageId) {
      return res.status(400).json({ ok: false, message: 'purchaseOrderId/packageId 必填' });
    }
    orderPackageDao.unlinkPurchase(purchaseOrderId, packageId);
    res.json(ok({ purchaseOrderId, packageId }));
  } catch (e) {
    next(e);
  }
});

// ── 退回待处理(取消全部采购关联,回流未采购)──────────────
router.post('/admin/api/order-process/revert', (req, res, next) => {
  try {
    const packageId = Number(req.body?.packageId);
    if (!packageId) return res.status(400).json({ ok: false, message: 'packageId 必填' });
    orderPackageDao.revertToWaitProcess(packageId);
    res.json(ok({ packageId }));
  } catch (e) {
    next(e);
  }
});

// ── 搁置/恢复 ───────────────────────────────────────────────
router.post('/admin/api/order-process/ignore', (req, res, next) => {
  try {
    const packageId = Number(req.body?.packageId);
    if (!packageId) return res.status(400).json({ ok: false, message: 'packageId 必填' });
    orderPackageDao.setIgnored(packageId, !!req.body?.ignored);
    res.json(ok({ packageId, ignored: !!req.body?.ignored }));
  } catch (e) {
    next(e);
  }
});

// ── 更新本地备注/标签(2026-09-15)─────────────────────────
// body: { packageId, note?: string|null, tags?: string[] }
// note/tags 不传的字段不动;note 传 null/'' 清空;tags 传空数组清空
router.post('/admin/api/order-process/package-meta', (req, res, next) => {
  try {
    const packageId = Number(req.body?.packageId);
    if (!packageId) return res.status(400).json({ ok: false, message: 'packageId 必填' });
    const { note, tags } = req.body || {};
    if (note === undefined && tags === undefined) {
      return res.status(400).json({ ok: false, message: 'note/tags 至少传一个' });
    }
    if (tags !== undefined && !Array.isArray(tags)) {
      return res.status(400).json({ ok: false, message: 'tags 须为数组' });
    }
    const updated = orderPackageDao.updatePackageMeta(packageId, {
      note: typeof note === 'string' ? note : note === null ? '' : undefined,
      tags,
    });
    if (!updated) return res.status(404).json({ ok: false, message: '包裹不存在' });
    res.json(ok({
      packageId,
      note: updated.note,
      tags: updated.tags ? updated.tags.split(',').filter(Boolean) : [],
    }));
  } catch (e) {
    next(e);
  }
});

// ── 标记已打印面单(交运)──────────────────────────────────
router.post('/admin/api/order-process/print-label', (req, res, next) => {
  try {
    const packageId = Number(req.body?.packageId);
    if (!packageId) return res.status(400).json({ ok: false, message: 'packageId 必填' });
    orderPackageDao.markWaybillPrinted(packageId);
    res.json(ok({ packageId }));
  } catch (e) {
    next(e);
  }
});

// ── 扫描发货(2026-09,设计文档: docs/扫描发货-功能设计.md)──
//   POST /admin/api/order-process/scan-ship/submit    提交发货重量(权威状态校验,仅 wait_ship 落库)
//   GET  /admin/api/order-process/scan-ship/records   发货记录(今日/昨日,北京时间日界)

// 非待打单发货状态的拦截提示(前端横幅直接展示)
const SHIP_BLOCK_MESSAGES = {
  wait_process: '订单状态问题:待处理(未采购),请先提交采购信息',
  ship_success: '订单状态问题:已交运',
  wait_receiver_confirm: '订单状态问题:已发货(已交运)',
  cancelled: '订单状态问题:订单已取消',
};

// 北京时间日界 → UTC 区间:北京 00:00 = UTC 前一日 16:00
// 返回 { startAt, endAt } UTC ISO 字符串,区间 [startAt, endAt)
function beijingDayRangeUtc(day) {
  const bjNow = new Date(Date.now() + 8 * 3600_000);
  let start = Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate()) - 8 * 3600_000;
  if (day === 'yesterday') start -= 86400_000;
  return { startAt: new Date(start).toISOString(), endAt: new Date(start + 86400_000).toISOString() };
}

// 提交发货重量:按 DB 当前状态权威判定 canShip
// body: { packageId, weightG }  weightG: 正整数克 1~50000
// canShip=true  → 重量已落库,前端继续拉面单打印并 markPrinted 交运
// canShip=false → 不写重量不流转,message 返回拦截原因
router.post('/admin/api/order-process/scan-ship/submit', (req, res, next) => {
  try {
    const packageId = Number(req.body?.packageId);
    const weightG = Number(req.body?.weightG);
    if (!Number.isInteger(packageId) || packageId <= 0) {
      return res.status(400).json({ ok: false, message: 'packageId 必填' });
    }
    if (!Number.isInteger(weightG) || weightG < 1 || weightG > 50000) {
      return res.status(400).json({ ok: false, message: 'weightG 必须为 1~50000 的整数(克)' });
    }
    const r = orderPackageDao.scanShipSubmit(packageId, weightG);
    if (!r.found) return res.status(404).json({ ok: false, message: '包裹不存在' });
    // 称重落库后回填维护重量(仅空值时,有值不动;2026-09-19)
    try {
      const bf = orderPackageDao.backfillProductCache(packageId);
      if (bf.weightFilled || bf.purchaseFilled) {
        logger.info({ packageId, ...bf }, '[order-process] 自动回填采购价/重量(称重)');
      }
    } catch (e) {
      logger.warn({ packageId, err: e.message }, '[order-process] 回填采购价/重量失败(称重)');
    }
    const message = r.canShip
      ? ''
      : r.isIgnored
        ? '订单状态问题:已搁置'
        : SHIP_BLOCK_MESSAGES[r.operateStatus] || `订单状态问题:${r.operateStatus}`;
    res.json(
      ok({
        canShip: r.canShip,
        operateStatus: r.operateStatus,
        isIgnored: r.isIgnored,
        waybillPrintedAt: r.waybillPrintedAt,
        message,
      })
    );
  } catch (e) {
    next(e);
  }
});

// 更正重量:任意状态人工修正发货重量(2026-09-22 起解除"仅交运后"限制)
// 仅更新 op_package.weight,不改交运时间/状态;利润中国际配送(估)随之按新重量变化
// body: { packageId, weightG }  weightG: 正整数克 1~50000
router.post('/admin/api/order-process/scan-ship/correct-weight', (req, res, next) => {
  try {
    const packageId = Number(req.body?.packageId);
    const weightG = Number(req.body?.weightG);
    if (!Number.isInteger(packageId) || packageId <= 0) {
      return res.status(400).json({ ok: false, message: 'packageId 必填' });
    }
    if (!Number.isInteger(weightG) || weightG < 1 || weightG > 50000) {
      return res.status(400).json({ ok: false, message: 'weightG 必须为 1~50000 的整数(克)' });
    }
    const r = orderPackageDao.scanShipCorrectWeight(packageId, weightG);
    if (!r.found) return res.status(404).json({ ok: false, message: '包裹不存在' });
    res.json(ok({ updated: true, oldWeightG: r.oldWeightG, weightG }));
  } catch (e) {
    next(e);
  }
});

// 发货记录:今日/昨日已交运包裹(按 waybill_printed_at 北京时间日界切分,倒序)
// query: day=today|yesterday(默认 today), page(默认1), pageSize(默认20,≤500;前端不分页一次拉全量)
// 响应含:items(产品行)/purchaseLinks/weightG+weightSource(富化同 /list)
router.get('/admin/api/order-process/scan-ship/records', (req, res, next) => {
  try {
    const q = req.query || {};
    const day = q.day === 'yesterday' ? 'yesterday' : 'today';
    const { startAt, endAt } = beijingDayRangeUtc(day);
    const data = orderPackageDao.listShippedPackages({
      startAt,
      endAt,
      page: q.page,
      pageSize: q.pageSize,
    });
    // 富化产品行 + 重量(与 /list 相同的聚合口径)
    const orderIds = data.packages.map((p) => p.ozonOrderId);
    const items = orderIds.length ? orderPackageDao.getItemsByOrderIds(orderIds) : [];
    const itemsByOrder = new Map();
    for (const it of items) {
      if (!itemsByOrder.has(it.ozonOrderId)) itemsByOrder.set(it.ozonOrderId, []);
      itemsByOrder.get(it.ozonOrderId).push(it);
    }
    const weightMap = orderPackageDao.getWeightsByPackageIds(data.packages.map((p) => p.id));
    for (const pkg of data.packages) {
      pkg.items = itemsByOrder.get(pkg.ozonOrderId) || [];
      const w = weightMap.get(pkg.id);
      if (w) {
        pkg.weightG = w.weightG;
        pkg.weightSource = w.source;
      }
    }
    data.day = day;
    data.range = { startAt, endAt };
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

// ── 获取 Ozon 面单 PDF(打印标签)────────────────────────
// body: { packageIds: number[](≤20,须同店铺), refresh?: boolean, mode?: 'stream'|'url' }
// 行为:文件缓存优先,未命中调 Ozon /v2/posting/fbs/package-label 并落缓存
// 返回:mode=stream(默认)→ application/pdf;mode=url → { url, expiresIn }(供菜鸟打印组件拉取)
// 注:url 模式返回带 HMAC 签名的 10 分钟短时公开链接(见 GET /print/waybill/:token)
// 注:拉取成功不自动流转状态,前端打印成功后走 print-label 标记交运
router.post('/admin/api/order-process/package-label', async (req, res, next) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.packageIds) ? b.packageIds.map(Number).filter(Number.isInteger) : [];
    if (ids.length === 0) return res.status(400).json({ ok: false, message: 'packageIds 必填' });
    if (ids.length > 20) return res.status(400).json({ ok: false, message: '单次最多 20 个包裹(Ozon 上限)' });
    const rows = orderPackageDao.getPackagePostings(ids);
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => r.packageId));
      return res.status(400).json({ ok: false, message: `包裹不存在: ${ids.filter((i) => !found.has(i)).join(', ')}` });
    }
    const storeIds = [...new Set(rows.map((r) => r.storeId))];
    if (storeIds.length > 1) {
      return res.status(400).json({ ok: false, message: '不支持跨店铺混打,请逐个包裹打印' });
    }
    const storeId = storeIds[0];
    // 按前端传入的 ids 顺序确定 postingNumbers(与 Ozon 生成 PDF 的页序一致,供条码 zip 使用)
    const rowById = new Map(rows.map((r) => [r.packageId, r]));
    const postingNumbers = ids.map((id) => rowById.get(id)?.postingNumber).filter(Boolean);

    // 缓存优先(refresh=true 时强制重拉)
    let pdf = null;
    if (!b.refresh) {
      pdf = getWaybill(storeId, postingNumbers);
      if (pdf) {
        logger.info({ storeId, postings: postingNumbers.length, cacheHit: true }, '[package-label] 缓存命中');
      }
    }

    if (!pdf) {
      const store = (config.loadStores() || []).find((s) => s.id === storeId);
      if (!store) return res.status(400).json({ ok: false, message: `店铺 ${storeId} 不存在` });
      const started = Date.now();
      try {
        pdf = (await packageLabel(store, postingNumbers)).buffer;
      } catch (e) {
        const msg = e?.message || '';
        // Ozon 装配后 45-60s 才能出标签,未就绪返回 409 让前端引导重试
        if (/aren't ready/i.test(msg)) {
          return res.status(409).json({ ok: false, code: 'LABEL_NOT_READY', message: '面单尚未就绪(Ozon 装配后需 45-60 秒),请稍后重试' });
        }
        // Ozon 限制:仅 awaiting_deliver(待发货)状态货件可打印标签(实测 delivering/已取消等会报 INVALID_ARGUMENT)
        if (/INVALID_ARGUMENT/i.test(msg)) {
          return res.status(409).json({ ok: false, code: 'LABEL_NOT_AVAILABLE', message: 'Ozon 拒绝生成面单:仅"待发货(awaiting_deliver)"状态的订单可打印面单' });
        }
        throw e;
      }
      setWaybill(storeId, postingNumbers, pdf);
      logger.info(
        { storeId, postings: postingNumbers.length, cacheHit: false, durationMs: Date.now() - started },
        '[package-label] Ozon 拉取成功'
      );
    }

    // 回填面单条码映射(异步旁路,不阻塞打印;仅当存在未建映射的货件时解析 PDF)
    try {
      const missing = missingBarcodePostings(storeId, postingNumbers);
      if (missing.length) {
        backfillPostingBarcodes(storeId, postingNumbers, pdf)
          .then((n) => logger.info({ storeId, postings: postingNumbers.length, filled: n }, '[package-label] 条码映射回填完成'))
          .catch((e) => logger.warn({ err: e?.message, storeId }, '[package-label] 条码映射回填失败'));
      }
    } catch (e) {
      logger.warn({ err: e?.message, storeId }, '[package-label] 条码映射检查失败');
    }

    if (b.mode === 'url') {
      // 生成短时签名链接,供菜鸟打印组件(本地进程,无 JWT)直接 GET 拉取 PDF
      const token = signWaybillToken({ storeId, postings: postingNumbers, exp: Date.now() + WAYBILL_URL_TTL_MS });
      const base = `${req.protocol}://${req.get('host')}`;
      return res.json(ok({ url: `${base}/print/waybill/${token}`, expiresIn: WAYBILL_URL_TTL_MS / 1000 }));
    }
    sendPdf(res, postingNumbers.length, pdf);
  } catch (e) {
    next(e);
  }
});

// ── 面单公开链接(菜鸟打印组件拉取用)──────────────────────
// 组件是本地进程,无法带 Authorization;用 HMAC 签名 + 10 分钟过期的令牌保护
// (路径已在 auth.js PUBLIC_PATHS 前缀放行)
router.get('/print/waybill/:token', (req, res, next) => {
  try {
    const p = verifyWaybillToken(req.params.token);
    if (!p) return res.status(403).json({ ok: false, message: '面单链接无效或已过期,请重新打印' });
    const pdf = getWaybill(p.storeId, p.postings);
    if (!pdf) return res.status(404).json({ ok: false, message: '面单缓存不存在,请重新打印' });
    sendPdf(res, p.postings.length, pdf);
  } catch (e) {
    next(e);
  }
});

// 面单短链令牌:HMAC-SHA256(jwtSecret 复用),payload 含店铺/货件/过期时间
const WAYBILL_URL_TTL_MS = 10 * 60_000;
function signWaybillToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', config.jwtSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyWaybillToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = createHmac('sha256', config.jwtSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Array.isArray(p.postings) || !p.storeId || Date.now() > p.exp) return null;
    return p;
  } catch {
    return null;
  }
}

function sendPdf(res, n, buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="waybill-${n}.pdf"`);
  res.end(buffer);
}

// ── 手动触发增量同步(双接口:unfulfilled + list)──────────────
router.post('/admin/api/order-process/sync-run', async (req, res, next) => {
  try {
    if (isSyncing()) {
      return res.json(ok({ skipped: true, reason: '同步已在进行中' }));
    }
    // body.level 可选 fast(默认,未完成订单7天)|mid(近90天)|slow(近365天),与定时三级节奏同窗口
    const level = ['fast', 'mid', 'slow'].includes(req.body?.level) ? req.body.level : 'fast';
    // 异步执行,立即返回(同步全店铺可能耗时数分钟)
    runOrderSyncNow({ level, trigger: 'manual' })
      .then((r) => logger.info({ level, stores: r.stores?.length, durationMs: r.durationMs }, '[order-process] 增量同步完成'))
      .catch((e) => logger.error({ err: e?.message }, '[order-process] 增量同步失败'));
    res.json(ok({ started: true, type: 'incremental', level }));
  } catch (e) {
    next(e);
  }
});

// ── 手动触发全量同步(仅 /v4/posting/fbs/list)──────────────
// body:
//   { sinceDays: 1|7|30|90 }                —— 快捷天数,后端计算 since
//   { since: ISO, to: ISO }                  —— 自定义起止(优先级高于 sinceDays)
// 时区:since/to 按 ISO 字符串直传;sinceDays 由后端按当前 UTC 计算
router.post('/admin/api/order-process/sync-all-list', async (req, res, next) => {
  try {
    if (isSyncing()) {
      return res.json(ok({ skipped: true, reason: '同步已在进行中' }));
    }
    const b = req.body || {};
    const hasCustom = !!(b.since && b.to);
    const sinceDays = Number(b.sinceDays);
    if (!hasCustom && (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 365)) {
      return res.status(400).json({ ok: false, message: '请提供 sinceDays(1-365) 或 since/to 时间段' });
    }
    const opts = hasCustom ? { since: String(b.since), to: String(b.to) } : { sinceDays };
    runSyncAllList(opts)
      .then((r) => logger.info({ stores: r.stores?.length, durationMs: r.durationMs, since: r.since, to: r.to }, '[order-process] 全量list同步完成'))
      .catch((e) => logger.error({ err: e?.message }, '[order-process] 全量list同步失败'));
    res.json(ok({ started: true, type: 'all-list', ...opts }));
  } catch (e) {
    next(e);
  }
});

// ── 同步状态(布尔 + cursors,轻量)─────────────────────────
router.get('/admin/api/order-process/sync-status', (_req, res) => {
  res.json(ok({ syncing: isSyncing(), cursors: orderPackageDao.getSyncCursors() }));
});

// ── 同步进度(详细:店铺数/当前店/页/已拉订单数/耗时)──────
// 前端每秒轮询,驱动进度条更新;完成后保留 finishedAt,前端展示完成态+关闭按钮
router.get('/admin/api/order-process/sync-progress', (_req, res) => {
  res.json(ok(getSyncProgress()));
});

// ── 关闭已完成进度(用户点关闭按钮触发)──────────────────────
// 仅在 active=false 时可清空;同步进行中调用返回 cleared=false
router.post('/admin/api/order-process/sync-progress/dismiss', (_req, res) => {
  res.json(ok(clearSyncProgress()));
});

// ── 同步结果历史日志(2026-10,持久化可回溯)────────────────────
// 每次同步每店铺一行,倒序返回;query: limit(默认50,上限500)/storeId/trigger
router.get('/admin/api/order-process/sync-logs', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const storeId = String(req.query.storeId || '');
  const trigger = String(req.query.trigger || '');
  const logs = orderPackageDao.getOrderSyncLogs({ limit, storeId, trigger });
  res.json(ok({ logs }));
});

// ── 手动触发应计同步 ────────────────────────────────────────
// body:
//   { mode: 'backfill', sinceDays: 210 }  —— 存量回补(窗口内全部已完成/已取消)
//   { mode: 'packages', packageIds: [1,2] } —— 单包裹刷新(详情弹窗"刷新应计"按钮)
//   {}                                     —— 增量待拉(与定时同步同一清单逻辑)
// 注:与订单同步互不阻塞;单店铺失败不影响其余店铺
router.post('/admin/api/order-process/accrual-sync', async (req, res, next) => {
  try {
    const b = req.body || {};
    const mode = ['pending', 'backfill', 'packages'].includes(b.mode) ? b.mode : 'pending';
    if (mode === 'backfill') {
      const d = Number(b.sinceDays);
      if (!Number.isInteger(d) || d < 1 || d > 365) {
        return res.status(400).json({ ok: false, message: 'backfill 模式需提供 sinceDays(1-365)' });
      }
    }
    if (mode === 'packages') {
      const ids = Array.isArray(b.packageIds) ? b.packageIds.map(Number).filter(Number.isInteger) : [];
      if (ids.length === 0) {
        return res.status(400).json({ ok: false, message: 'packages 模式需提供 packageIds' });
      }
    }
    const r = await runAccrualSync({
      mode,
      sinceDays: b.sinceDays,
      packageIds: b.packageIds,
      storeId: b.storeId,
    });
    logger.info({ mode: r.mode, totalPackages: r.totalPackages, totalAccrualRows: r.totalAccrualRows }, '[order-process] 应计同步完成');
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

// ── by-day 应计同步(2026-09-24,主数据源)─────────────────────
// POST body: { days?: number }  —— 手动触发一轮(默认 35 天窗口,1-120)
// 定时任务每 24h 自动跑;此路由供部署后验证/按需补拉
router.post('/admin/api/order-process/accrual-byday-sync', async (req, res, next) => {
  try {
    const b = req.body || {};
    let days = Number(b.days);
    if (!Number.isInteger(days) || days < 1 || days > 120) days = 35;
    const r = await runAccrualByDaySync({ days });
    logger.info({ days, ...r }, '[order-process] by-day 应计同步完成');
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

// GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&store_id= —— 费用类型分布 + 收入侧汇总(对账/报表)
router.get('/admin/api/order-process/accrual-byday-stats', (req, res, next) => {
  try {
    const { from, to, store_id: storeId } = req.query || {};
    const r = getBydayStats({
      from: /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : undefined,
      to: /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to : undefined,
      storeId: storeId || undefined,
    });
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

// ── RUB→CNY 汇率(读/写)─────────────────────────────────────
// GET  → { rate, updatedAt, source } | null(未配置)
// POST → body: { rate: number } 写 app_config.rub_cny_rate
router.get('/admin/api/order-process/rub-rate', (_req, res) => {
  res.json(ok(resolveRubCnyRate()));
});

// ── 单订单强制同步(用户点击"同步"按钮触发)─────────────────────
// POST body: { packageId: number }
// 流程:/v3/posting/fbs/get 拉最新订单状态(无时间窗口限制) + 强拉应计项目(无 24h 限制)
// 返回 { ok, postingNumber, orderSynced, accrualRows, statusBefore, statusAfter }
router.post('/admin/api/order-process/sync-package', async (req, res, next) => {
  try {
    const id = Number(req.body?.packageId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'packageId 必须为正整数' });
    }
    const r = await syncSinglePackage(id);
    logger.info(
      { packageId: id, postingNumber: r.postingNumber, orderSynced: r.orderSynced, accrualRows: r.accrualRows },
      '[order-process] 单订单同步完成'
    );
    res.json(ok(r));
  } catch (e) {
    // 友好错误:店铺未配置凭据 / 单号不存在 / Ozon 接口错
    const msg = e?.message || String(e);
    const status = /未配置|未找到|必须为/.test(msg) ? 400 : 502;
    logger.warn({ err: msg, packageId: req.body?.packageId }, '[order-process] 单订单同步失败');
    res.status(status).json({ ok: false, message: msg });
  }
});

// ── 备货(2026-09-15)─────────────────────────────────────────
// POST body: { packageId: number }
// 调 Ozon /v4/posting/fbs/ship 搜集订单(不拆分:单 package 含全部商品),UI 名"备货"
// 实测结论(测试货件 52800136-0155-1):
//   1. products[].product_id 传 posting products[].sku 的值;
//      用 /v3/product/info/list 按 sku 反查的商品主 id 会报 UNKNOWN_PRODUCT_DEFINED
//   2. HTTP 200 不代表备货成功,须再 get 校验:状态离开 awaiting_packaging 且 substatus≠ship_failed
//      (实测成功后状态 awaiting_packaging → awaiting_registration 待注册面单)
//   3. 仅 Ozon awaiting_packaging 可备货;awaiting_registration/awaiting_deliver 视为已备货(幂等)
// 前置:本地 operate_status 为 wait_process/wait_ship(备货只看 Ozon 状态,与本地采购进度无关)
// 2026-10-23:解除搁置订单备货限制(前端二次弹窗确认,保持搁置标记)
router.post('/admin/api/order-process/ship', async (req, res, next) => {
  try {
    const packageId = Number(req.body?.packageId);
    if (!Number.isInteger(packageId) || packageId <= 0) {
      return res.status(400).json({ ok: false, message: 'packageId 必须为正整数' });
    }
    const row = db
      .prepare(
        `SELECT p.id, p.operate_status AS operateStatus, p.is_ignored AS isIgnored,
                o.posting_number AS postingNumber, o.store_id AS storeId
         FROM op_package p JOIN op_ozon_order o ON o.id = p.ozon_order_id
         WHERE p.id = ?`
      )
      .get(packageId);
    if (!row || !row.postingNumber || !row.storeId) {
      return res.status(404).json({ ok: false, message: `未找到 packageId=${packageId} 对应的订单` });
    }
    // 备货只依赖 Ozon 侧状态(awaiting_packaging),与本地采购进度无关:
    // 待处理(wait_process,未采购)与待打单(wait_ship,已采购)均可提前备货
    if (row.operateStatus !== 'wait_ship' && row.operateStatus !== 'wait_process') {
      return res.status(400).json({
        ok: false,
        message: `订单状态 ${row.operateStatus} 不可备货(仅待处理/待打单发货可备货)`,
      });
    }
    const store = (config.loadStores() || []).find((s) => s.id === row.storeId);
    if (!store || !store?.sync_credentials?.clientId) {
      return res.status(400).json({ ok: false, message: `店铺 ${row.storeId} 未配置 sync_credentials,无法直连 Ozon` });
    }

    // 1) 实时拉取 Ozon 状态(不用本地缓存,防过期)
    const g1 = await postingFbsGet(store, row.postingNumber);
    const p1 = g1?.result;
    const ozonStatus = p1?.status || '';
    // 已备货态:幂等返回(不再调 ship)
    if (ozonStatus === 'awaiting_registration' || ozonStatus === 'awaiting_deliver') {
      orderPackageDao.syncPosting(store.id, p1); // 顺带校准本地状态
      return res.json(ok({ alreadyShipped: true, ozonStatus, substatus: p1?.substatus || null }));
    }
    if (ozonStatus !== 'awaiting_packaging') {
      return res.status(400).json({
        ok: false,
        message:
          ozonStatus === 'cancelled'
            ? 'Ozon 订单已取消,不能备货'
            : `Ozon 当前状态 ${ozonStatus || '(未知)'} 不可备货(仅待备货状态可操作)`,
      });
    }

    // 2) 构造商品清单:product_id 传 posting 的 sku 值(实测口径)
    const products = (p1?.products || [])
      .map((x) => ({ product_id: x.sku ? Number(x.sku) : null, quantity: Number(x.quantity) || 1 }))
      .filter((x) => x.product_id);
    if (!products.length) {
      return res.status(400).json({ ok: false, message: '订单商品清单为空(缺少 sku),无法备货' });
    }

    // 3) 调 ship(不拆分:单 package 全部商品)
    // 2026-10-29:竞态容错——ship 瞬间 Ozon 状态已离开 awaiting_packaging(通常另一请求已备货成功/
    //   后台已流转)会返回 400:HAS_INCORRECT_STATUS。此时重查最新状态:已进入备货后状态链则按
    //   "已备货"幂等返回(不再误报失败),已取消则明确提示,其余状态透出冲突原因。
    try {
      await postingFbsShip(store, row.postingNumber, products);
    } catch (shipErr) {
      const shipMsg = shipErr?.message || String(shipErr);
      if (!shipMsg.includes('HAS_INCORRECT_STATUS')) throw shipErr; // 其他错误原样上抛
      let reGet = null;
      try {
        reGet = await postingFbsGet(store, row.postingNumber);
      } catch { /* 重查失败则按未知状态处理 */ }
      const pNow = reGet?.result;
      const stNow = pNow?.status || '';
      if (stNow === 'cancelled' || stNow === 'not_accepted') {
        return res.status(400).json({ ok: false, message: 'Ozon 订单已取消,不能备货' });
      }
      if (['awaiting_registration', 'awaiting_deliver', 'delivering', 'driver_pickup', 'delivered'].includes(stNow)) {
        if (pNow) orderPackageDao.syncPosting(store.id, pNow); // 校准本地 Ozon 状态,前端刷新后按钮自然隐藏
        logger.info(
          { packageId, postingNumber: row.postingNumber, status: stNow, substatus: pNow?.substatus || null },
          '[order-process] 备货竞态已备货(HAS_INCORRECT_STATUS),幂等返回'
        );
        return res.json(ok({ alreadyShipped: true, ozonStatus: stNow, substatus: pNow?.substatus || null }));
      }
      return res.status(400).json({
        ok: false,
        message: `Ozon 当前状态 ${stNow || '(未知)'} 不可备货(备货仅限待备货状态),请刷新后重试`,
      });
    }

    // 4) 轮询 get 校验(200 不代表成功;Ozon 状态变更是异步的,实测常需数十秒,
    //    2026-09-17 由单次校验改为最多 5 次 × 3s ≈15s,期间状态离开 awaiting_packaging 即生效)
    let p2 = null;
    let newStatus = '';
    let newSub = '';
    for (let i = 0; i < 5; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 3000));
      const g2 = await postingFbsGet(store, row.postingNumber);
      p2 = g2?.result;
      newStatus = p2?.status || '';
      newSub = p2?.substatus || '';
      if (newSub === 'ship_failed') break;
      if (newStatus !== 'awaiting_packaging') break; // 已离开待备货 → 生效
    }
    if (newSub === 'ship_failed') {
      logger.warn({ packageId, postingNumber: row.postingNumber, newStatus, newSub }, '[order-process] 备货失败(ship_failed)');
      return res.status(502).json({
        ok: false,
        message: `备货失败:Ozon 返回 ship_failed,请检查商品清单(SKU/数量)或稍后重试`,
      });
    }
    if (newStatus === 'awaiting_packaging') {
      // 指令已受理但 Ozon 状态尚未变更(异步延迟):不再误报失败,返回软成功;
      // 本地状态不动,由订单同步(fast 轮/手动同步)自动校准
      logger.warn({ packageId, postingNumber: row.postingNumber }, '[order-process] 备货指令已提交,Ozon 状态变更中');
      return res.json(ok({ pending: true, ozonStatus: newStatus, substatus: newSub || null }));
    }

    // 5) 成功:同步最新 posting 落库(校准本地 Ozon 状态)
    orderPackageDao.syncPosting(store.id, p2);
    logger.info({ packageId, postingNumber: row.postingNumber, newStatus, newSub }, '[order-process] 备货成功');
    // 6) 备货飞书通知(2026-09-22):备货动作本地直发,不再依赖 Ozon STATE_CHANGED 推送——
    //    webhook 停推期间 71 单备货通知丢失的教训;2026-10-16 去重重构后,
    //    原子 claim/release 已收敛到 notifyPostingEvent 内部,与 webhook/轮询兜底共用
    //    feishu_stocking_notified_at 标记。异步发送不阻塞响应,发送失败内部自动释放标记
    Promise.resolve(
      notifyPostingEvent('TYPE_STATE_CHANGED', {
        posting_number: row.postingNumber,
        seller_id: Number(store.company_id),
        changed_state_date: new Date().toISOString(),
        new_state: 'posting_awaiting_registration',
      }, 'manual')
    ).catch((e) => logger.warn({ err: e?.message, postingNumber: row.postingNumber }, '[order-process] 备货通知发送失败'));
    res.json(ok({ alreadyShipped: false, ozonStatus: newStatus, substatus: newSub || null }));
  } catch (e) {
    const msg = e?.message || String(e);
    const status = /必填|必须为|未配置|不能|不可|尚未/.test(msg) ? 400 : 502;
    logger.warn({ err: msg, packageId: req.body?.packageId }, '[order-process] 备货失败');
    res.status(status).json({ ok: false, message: `Ozon 备货失败:${msg}` });
  }
});

// ── 货运创建(FBS 发运,2026-10-29)────────────────────────────
// 备货完成后走"创建发运"流程:配送方式 → 创建发运 → 查看/调整货件 →
// 设置快递员联系方式(OGL 上门取件) → 确认发运 → 打面单/货位标签。
// 接口封装见 services/ozon-opi.js「FBS 货运创建(Carriage)API 封装」;
// 流程文档见 docs/ozon-api/05-FBS订单与配送.md「FBS配送」。
function requireCarriageStore(req) {
  const storeId = req.body?.storeId;
  const store = (config.loadStores() || []).find((s) => s.id === storeId);
  if (!store || !store?.sync_credentials?.clientId) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, `店铺 ${storeId} 未配置 sync_credentials,无法直连 Ozon`);
  }
  return store;
}
function carriageHandleError(e, req, res, action) {
  const msg = e?.message || String(e);
  const status = /必填|必须为|未配置|不能|不可|尚未/.test(msg) ? 400 : 502;
  logger.warn({ err: msg, storeId: req.body?.storeId }, `[order-process] ${action}失败`);
  res.status(status).json({ ok: false, message: `Ozon ${action}失败:${msg}` });
}

// 按货件号批量补充商品主图(2026-10-30)
// Ozon 货运接口(/v1/assembly/carriage/posting/list、/v4/posting/fbs/unfulfilled/list)
// 返回的 products 不含 image_url;本地商品缓存(product_data_cache.primary_image/images)
// 与订单 SKU 一一对应,按 posting_number 批量反查后按 sku/offer_id 挂回 products[].image_url。
function attachPostingProductImages(storeId, postings) {
  if (!Array.isArray(postings) || !postings.length) return postings;
  const numbers = [...new Set(postings.map((p) => p?.posting_number).filter(Boolean))];
  if (!numbers.length) return postings;
  const placeholders = numbers.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT o.posting_number, oi.sku, oi.offer_id, oi.title,
              COALESCE(json_extract(p.data, '$.primary_image[0]'), json_extract(p.data, '$.images[0]')) AS pic_url
       FROM op_ozon_order_item oi
       JOIN op_ozon_order o ON o.id = oi.ozon_order_id
       LEFT JOIN product_data_cache p ON p.sku = CAST(oi.sku AS TEXT)
       WHERE o.store_id = ? AND o.posting_number IN (${placeholders})`
    )
    .all(storeId, ...numbers);
  const byPosting = new Map();
  for (const r of rows) {
    if (!byPosting.has(r.posting_number)) byPosting.set(r.posting_number, []);
    byPosting.get(r.posting_number).push({
      sku: r.sku,
      offerId: r.offer_id,
      title: r.title,
      picUrl: imageCacheUrlFor(r.pic_url),
    });
  }
  for (const p of postings) {
    const imgs = byPosting.get(p?.posting_number) || [];
    for (const prod of p?.products || []) {
      const found =
        imgs.find((i) => i.sku != null && String(i.sku) === String(prod?.sku)) ||
        imgs.find((i) => i.offerId && i.offerId === prod?.offer_id);
      if (found) prod.image_url = found.picUrl;
    }
  }
  return postings;
}

// 快递员联系方式配置(2026-10-30,支持多条 + 默认项)
// 新结构 key: carriage_courier_contacts:<storeId>, value: [{ id, phone, wechatNickname, comment, isDefault }]
// 兼容旧单条 key: carriage_courier_contact_default:<storeId> 存在时包装成一条迁移。
const COURIER_CONTACTS_KEY_PREFIX = 'carriage_courier_contacts:';
const LEGACY_DEFAULT_CONTACT_KEY_PREFIX = 'carriage_courier_contact_default:';
function readLegacyDefaultCourierContact(storeId) {
  try {
    const row = db
      .prepare('SELECT value FROM app_config WHERE key = ?')
      .get(LEGACY_DEFAULT_CONTACT_KEY_PREFIX + String(storeId));
    if (!row) return null;
    const v = JSON.parse(row.value);
    return {
      phone: String(v?.phone || '').trim(),
      wechatNickname: String(v?.wechatNickname || '').trim(),
      comment: String(v?.comment || '').trim(),
    };
  } catch {
    return null;
  }
}
function normalizeContactConfig(c) {
  return {
    id: String(c?.id || ''),
    phone: String(c?.phone || '').trim(),
    wechatNickname: String(c?.wechatNickname || '').trim(),
    comment: String(c?.comment || '').trim(),
    isDefault: !!c?.isDefault,
  };
}
function readCourierContactConfigs(storeId) {
  const sid = String(storeId);
  try {
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(COURIER_CONTACTS_KEY_PREFIX + sid);
    if (row) {
      const arr = JSON.parse(row.value);
      if (Array.isArray(arr)) return arr.map(normalizeContactConfig);
    }
  } catch { /* 数据损坏按空处理 */ }
  // 兼容旧单条默认配置:迁移成一条默认
  const legacy = readLegacyDefaultCourierContact(sid);
  if (legacy && (legacy.phone || legacy.wechatNickname || legacy.comment)) {
    return [{ id: 'legacy', ...legacy, isDefault: true }];
  }
  return [];
}
function writeCourierContactConfigs(storeId, contacts) {
  const sid = String(storeId);
  const list = (Array.isArray(contacts) ? contacts : []).map(normalizeContactConfig);
  // 至多一条默认:重复默认只保留第一个;全未标记时第一条作为默认
  let defaultAssigned = false;
  const normalized = list.map((c) => {
    if (c.isDefault) {
      if (defaultAssigned) return { ...c, isDefault: false };
      defaultAssigned = true;
      return c;
    }
    return c;
  });
  if (!defaultAssigned && normalized.length) normalized[0].isDefault = true;
  db.prepare(
    `INSERT INTO app_config (key, value, scope, description, updated_at)
     VALUES (?, ?, 'carriage', '快递员联系方式配置', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       scope = excluded.scope,
       description = excluded.description,
       updated_at = datetime('now')`
  ).run(COURIER_CONTACTS_KEY_PREFIX + sid, JSON.stringify(normalized));
  return normalized;
}

// 配送方式列表(创建发运前置:取 delivery_method_id)
router.post('/admin/api/order-process/carriage/delivery-methods', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await deliveryMethodList(store, { limit: req.body?.limit, filter: req.body?.filter });
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '获取配送方式'); }
});

// 发运清单(/v2/carriage/delivery/list;旧 /v1/posting/carriage-available 已废弃 2026-03-20)
router.post('/admin/api/order-process/carriage/list', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await carriageDeliveryList(store, {
      cursor: req.body?.cursor,
      filter: req.body?.filter,
      limit: req.body?.limit,
    });
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '获取发运清单'); }
});

// 创建发运:所有"已准备发运"货件自动进入
router.post('/admin/api/order-process/carriage/create', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await carriageCreate(store, {
      deliveryMethodId: req.body?.deliveryMethodId,
      departureDate: req.body?.departureDate,
      allBlrTraceable: req.body?.allBlrTraceable,
    });
    logger.info({ storeId: store.id, carriageId: r?.carriage_id }, '[order-process] 创建发运成功');
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '创建发运'); }
});

// 发运信息
router.post('/admin/api/order-process/carriage/get', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await carriageGet(store, req.body?.carriageId);
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '获取发运'); }
});

// 发运中的货件列表(附带商品主图,2026-10-30:Ozon 货运接口 products 无图片,本地缓存补)
router.post('/admin/api/order-process/carriage/posting-list', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await carriagePostingList(store, req.body?.carriageId, {
      cursor: req.body?.cursor,
      limit: req.body?.limit,
      cutoffFrom: req.body?.cutoffFrom,
      cutoffTo: req.body?.cutoffTo,
      deliveryMethodId: req.body?.deliveryMethodId,
    });
    if (r?.postings) attachPostingProductImages(store.id, r.postings);
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '获取发运货件'); }
});

// 确认发运
router.post('/admin/api/order-process/carriage/approve', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await carriageApprove(store, req.body?.carriageId, req.body?.containersCount);
    logger.info({ storeId: store.id, carriageId: req.body?.carriageId }, '[order-process] 确认发运成功');
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '确认发运'); }
});

// 覆盖发运货件组成(全量)
router.post('/admin/api/order-process/carriage/set-postings', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await carriageSetPostings(store, req.body?.carriageId, req.body?.postingNumbers);
    logger.info(
      { storeId: store.id, carriageId: req.body?.carriageId, count: (req.body?.postingNumbers || []).length },
      '[order-process] 设置发运货件成功'
    );
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '设置发运货件'); }
});

// 可加入发运的货件候选(2026-10-30,增加货件用)
// 来源:/v4/posting/fbs/unfulfilled/list 拉全部未妥投,筛 status=awaiting_deliver(已准备发运),
//      并排除当前发运已有货件;附商品主图(本地缓存补)。
router.post('/admin/api/order-process/carriage/available-postings', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const carriageId = req.body?.carriageId;
    if (!carriageId) throw new ApiError(ErrorCode.VALIDATION_ERROR, 'carriageId 必填');
    const deliveryMethodId = req.body?.deliveryMethodId;
    const current = await carriagePostingList(store, carriageId, { limit: 100 });
    const currentSet = new Set((current?.postings || []).map((p) => p.posting_number));
    const candidates = [];
    let cursor = '';
    let guard = 0;
    do {
      const page = await postingFbsUnfulfilledList(store, {
        cutoffFrom: '2000-01-01T00:00:00.000Z',
        cutoffTo: '2999-12-31T23:59:59.999Z',
        cursor,
        limit: 100,
        deliveryMethodId,
        withData: {},
      });
      const list = page?.result?.postings || page?.postings || [];
      for (const p of list) {
        if (p?.status === 'awaiting_deliver' && !currentSet.has(p.posting_number)) {
          candidates.push(p);
        }
      }
      cursor = page?.result?.cursor || page?.cursor || '';
      guard += 1;
      if (guard > 50) break; // 防死循环(最多 5000 条)
    } while (cursor);
    if (candidates.length) attachPostingProductImages(store.id, candidates);
    res.json(ok({ postings: candidates, count: candidates.length }));
  } catch (e) { carriageHandleError(e, req, res, '获取可加入货件'); }
});

// 取消发运
router.post('/admin/api/order-process/carriage/cancel', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await carriageCancel(store, req.body?.carriageId);
    logger.info({ storeId: store.id, carriageId: req.body?.carriageId, status: r?.carriage_status }, '[order-process] 取消发运成功');
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '取消发运'); }
});

// 设置快递员联系方式(OGL 上门取件场景)
router.post('/admin/api/order-process/carriage/courier-contact/set', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await carriageCourierContactSet(store, {
      carriageId: req.body?.carriageId,
      phone: req.body?.phone,
      wechatNickname: req.body?.wechatNickname,
      comment: req.body?.comment,
    });
    logger.info({ storeId: store.id, carriageId: req.body?.carriageId }, '[order-process] 设置快递员联系方式成功');
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '设置联系方式'); }
});

// 获取快递员联系方式
router.post('/admin/api/order-process/carriage/courier-contact/get', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const r = await carriageCourierContactGet(store, req.body?.carriageId);
    res.json(ok(r));
  } catch (e) { carriageHandleError(e, req, res, '获取联系方式'); }
});

// 获取店铺的默认快递员联系方式(兼容旧接口:返回配置列表中的默认项)
router.post('/admin/api/order-process/carriage/courier-contact/default/get', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const contacts = readCourierContactConfigs(store.id);
    const def = contacts.find((c) => c.isDefault) || contacts[0] || null;
    res.json(ok({ contact: def ? { phone: def.phone, wechatNickname: def.wechatNickname, comment: def.comment } : null }));
  } catch (e) { carriageHandleError(e, req, res, '获取默认联系方式'); }
});

// 保存店铺的默认快递员联系方式(兼容旧接口:写为新配置结构的默认项)
router.post('/admin/api/order-process/carriage/courier-contact/default/set', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const { phone, wechatNickname, comment } = req.body || {};
    const contacts = readCourierContactConfigs(store.id).map((c) => ({ ...c, isDefault: false }));
    contacts.push({
      id: String(Date.now()),
      phone: String(phone || '').trim(),
      wechatNickname: String(wechatNickname || '').trim(),
      comment: String(comment || '').trim(),
      isDefault: true,
    });
    const saved = writeCourierContactConfigs(store.id, contacts);
    const def = saved.find((c) => c.isDefault) || saved[0] || null;
    res.json(ok({ contact: def ? { phone: def.phone, wechatNickname: def.wechatNickname, comment: def.comment } : null }));
  } catch (e) { carriageHandleError(e, req, res, '保存默认联系方式'); }
});

// 获取店铺快递员联系方式配置列表(2026-10-30,多条 + 默认项)
router.post('/admin/api/order-process/carriage/courier-contact/config/list', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    res.json(ok({ contacts: readCourierContactConfigs(store.id) }));
  } catch (e) { carriageHandleError(e, req, res, '获取联系方式配置'); }
});

// 保存店铺快递员联系方式配置列表(全量覆盖)
router.post('/admin/api/order-process/carriage/courier-contact/config/save', async (req, res) => {
  try {
    const store = requireCarriageStore(req);
    const saved = writeCourierContactConfigs(store.id, req.body?.contacts);
    logger.info({ storeId: store.id, count: saved.length }, '[order-process] 保存快递员联系方式配置成功');
    res.json(ok({ contacts: saved }));
  } catch (e) { carriageHandleError(e, req, res, '保存联系方式配置'); }
});

router.post('/admin/api/order-process/rub-rate', (req, res, next) => {
  try {
    const rate = Number(req.body?.rate);
    if (!(rate > 0)) {
      return res.status(400).json({ ok: false, message: 'rate 必须为正数' });
    }
    const r = setRubCnyRate(rate);
    logger.info({ rate: r.rate }, '[order-process] RUB→CNY 汇率已更新');
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

// ════════════════════════════════════════════════════════════════
// 妙手 ERP 订单数据(2026-09,独立新表)
// 数据来源:miaoshou-helper 插件从妙手历史订单页提取
// ════════════════════════════════════════════════════════════════

// ── 从妙手同步(插件提取后 POST 到此接口)──────────────────
// body: { orders: [...] }  — 来自插件 ms-orders-extract.js 的精简数据
router.post('/admin/api/order-process/sync-from-miaoshou', (req, res, next) => {
  try {
    const orders = req.body?.orders;
    if (!Array.isArray(orders) || !orders.length) {
      return res.status(400).json({ ok: false, message: 'orders 数组必填' });
    }
    const result = upsertMiaoshouOrders(orders);
    logger.info(result, '[order-process] 妙手数据入库完成');
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// ── 妙手订单列表(分页,关联本地 op_package,含应计合计)─────
router.get('/admin/api/order-process/miaoshou-list', (req, res, next) => {
  try {
    const data = listMiaoshouPackages({
      page: req.query.page,
      pageSize: req.query.pageSize,
      shopNick: req.query.shopNick,
      keyword: req.query.keyword,
      appPackageTab: req.query.appPackageTab,
      localLinked: req.query.localLinked,
    });
    data.rubRate = resolveRubCnyRate();
    // 金额列六行注入(对齐订单处理页):已关联本地的行带出应计 CNY 分组/利润
    // 采购金额用妙手侧采购单合计(真实采购支出),无妙手采购单时回退本地录入
    const linked = data.packages.filter((p) => p.local_pkg_id);
    if (linked.length) {
      const localIds = linked.map((p) => p.local_pkg_id);
      const accrualMap = buildAccrualBreakdown(
        linked.map((p) => ({
          id: p.local_pkg_id,
          accrualTotal: p.accrual_total != null ? Number(p.accrual_total) : null,
          accrualSaleTotal: p.accrual_sale_total != null ? Number(p.accrual_sale_total) : null,
        })),
        getAccrualTypeSumsByPackageIds(localIds),
        data.rubRate?.rate
      );
      for (const p of linked) {
        if (accrualMap.has(p.local_pkg_id)) p.accrual = accrualMap.get(p.local_pkg_id);
      }
    }
    for (const p of data.packages) {
      // 采购金额兜底链(2026-09-04 修订):
      // 1. ms_has_manual(有isAuto=0采购单,用券场景)→ 妙手包裹级(用户已手动纠正)
      // 2. ms_purchase_amount(quantity 加权分摊值) > 0 → 加权分摊(isAuto=1,多采购单场景)
      // 3. 妙手包裹级 purchase_amount(手工单 payment=0,或加权分摊为空时回退)
      // 4. 本地录入 total_purchase_amount(最终兜底)
      const hasManual = Number(p.ms_has_manual) > 0;
      const msShared = p.ms_purchase_amount != null ? Number(p.ms_purchase_amount) : null;
      const pkgAmount = p.purchase_amount != null ? Number(p.purchase_amount) : null;
      if (hasManual && pkgAmount > 0) {
        // 用券场景(isAuto=0):妙手包裹级已被用户手动纠正,可信
        p.purchase_amount = pkgAmount;
      } else if (msShared > 0) {
        // 自动同步(isAuto=1):用 quantity 加权分摊
        p.purchase_amount = msShared;
      } else if (pkgAmount > 0) {
        // 兜底:妙手包裹级(手工单或加权分摊为空)
        p.purchase_amount = pkgAmount;
      } else {
        // 最终兜底:本地录入
        p.purchase_amount = Number(p.total_purchase_amount) || 0;
      }
      // 重量来源优先级:1)妙手称重 2)系统自定义 3)Ozon后台同步(与订单处理页一致)
      const msWeight = p.weighing_weight != null ? Number(p.weighing_weight) : null;
      if (msWeight != null && msWeight > 0) {
        p.weightG = msWeight;
        p.weightSource = 'miaoshou';
      } else {
        // 妙手称重缺失,回退查 product_data_cache.custom_weight_g + product_attributes_cache
        const wMap = orderPackageDao.getWeightsByPackageIds([p.id]);
        if (wMap.has(p.id)) {
          p.weightG = wMap.get(p.id).weightG;
          p.weightSource = wMap.get(p.id).source;
        }
      }
      p.profit = computeProfit({
        orderAmount: p.order_amount,
        totalPurchaseAmount: p.purchase_amount,
        accrual: p.accrual,
        weightG: p.weightG,
        weightSource: p.weightSource,
      }, p.app_package_tab === 'closed' || p.platform_package_status === 'cancelled',
      data.rubRate?.rate);
    }
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

// ── 妙手订单状态 tab 计数(按 operate_status 分组)─────────
router.get('/admin/api/order-process/miaoshou-tabs', (_req, res, next) => {
  try {
    res.json(ok(countMiaoshouTabs()));
  } catch (e) {
    next(e);
  }
});

// ── 妙手订单详情(含采购单列表 + 本地关联包裹应计明细)─────
router.get('/admin/api/order-process/miaoshou-detail/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const detail = getMiaoshouPackageDetail(id);
    if (!detail) return res.status(404).json({ ok: false, message: '妙手订单不存在' });
    detail.rubRate = resolveRubCnyRate();
    res.json(ok(detail));
  } catch (e) {
    next(e);
  }
});

// ── 从妙手同步到本地订单 ─────────────────────────────────────
// 把妙手订单的重量/备注/妙手口径采购金额/采购订单详情同步到本地 op_package + op_purchase_order
// 关联键:op_package.logistics_no = miaoshou_package.posting_number
// 平台映射:天猫(tmall)→ 淘宝(taobao),其它直接映射
// 请求体(可选):{ packageIds: [1,2,3] }  不传 = 同步 logistics_no 非空的全部
router.post('/admin/api/order-process/sync-ms-to-local', (req, res, next) => {
  try {
    const packageIds = Array.isArray(req.body?.packageIds)
      ? req.body.packageIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    const result = orderPackageDao.syncFromMiaoshou({ packageIds });
    logger.info({ ...result, errors: result.errors?.slice(0, 5) }, '[order-process] 从妙手同步到本地完成');
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// 补全采购订单商品信息(目前仅支持拼多多,后续可扩展到 1688/淘宝)
// body: { items: [{ purchaseSn, platform, goods: [{goodsName, spec, price, number, thumbUrl}] }] }
// 前端调用插件 searchPddOrder(orderSn) 拿到商品图+数量后批量推送
router.post('/admin/api/order-process/enrich-purchase-items', (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.json(ok({ updated: 0, skipped: 0 }));
    const result = orderPackageDao.enrichPurchaseItems(items);
    logger.info(result, '[order-process] 补全采购订单商品信息完成');
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

// 待补全采购订单列表(items_json 为空的所有采购单,不限当前页)
// 供前端"补全采购订单信息"按钮拉取全量待补全清单,串行+限速逐个搜索
// query: ?platform=yangkeduo(可选,按平台过滤)
router.get('/admin/api/order-process/pending-purchases', (req, res, next) => {
  try {
    const platform = req.query.platform || '';
    const list = orderPackageDao.listPendingPurchases(platform || null);
    res.json(ok(list));
  } catch (e) { next(e); }
});

// 手动同步采购物流信息(2026-09-17,前端"同步采购物流信息"按钮)
// 与每小时定时轮同逻辑互斥:补物流单号(1688)+拉完整轨迹(1688官方API+拼多多goods_express)
// POST 启动(后台异步执行,立即返回);GET 查询进度(前端3s轮询)
router.post('/admin/api/order-process/sync-purchase-logistics', (_req, res, next) => {
  try {
    const r = triggerPurchaseLogisticsSync();
    res.json(ok({ started: r.started, status: r.status }));
  } catch (e) { next(e); }
});

router.get('/admin/api/order-process/sync-purchase-logistics', (_req, res, next) => {
  try {
    res.json(ok(getPurchaseLogisticsStatus()));
  } catch (e) { next(e); }
});

// ── 单包裹同步采购物流(列表行"同步采购物流"按钮,2026-09-17)──────────
// POST body: { packageId: number }
// 范围:该包裹全部关联采购单;1688 官方API补单号+拉轨迹、拼多多搜索补单号+浏览器拉轨迹;
// 淘宝/手工单暂不支持(结果里 skip 说明)。强制刷新:不受定时轮的 1 小时窗口限制;
// 与定时轮不互斥(浏览器操作经 SerialQueue 串行,写入幂等)。
// 返回 { orders, results: [{purchaseSn, platform, action, detail}] }
router.post('/admin/api/order-process/sync-package-purchase-logistics', async (req, res, next) => {
  try {
    const id = Number(req.body?.packageId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'packageId 必须为正整数' });
    }
    const r = await syncPurchaseLogisticsForPackage(id);
    logger.info({ packageId: id, orders: r.orders, results: r.results }, '[order-process] 单包裹采购物流同步完成');
    res.json(ok(r));
  } catch (e) {
    const msg = e?.message || String(e);
    logger.warn({ err: msg, packageId: req.body?.packageId }, '[order-process] 单包裹采购物流同步失败');
    res.status(502).json({ ok: false, message: msg });
  }
});

export default router;
