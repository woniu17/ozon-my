// 订单处理(2026-08,个人自发货模式)
// 管理采购订单(1688/拼多多/淘宝)与 Ozon FBS 订单的关联
// 设计文档: docs/采购订单-Ozon订单关联管理-功能设计.md
//
// 路由:
//   GET  /admin/api/order-process/tabs            Tab 计数(待处理/待打单发货/交运/已发货/已搁置)
//   GET  /admin/api/order-process/list            包裹分页列表(tab+筛选+关键词)
//   GET  /admin/api/order-process/detail/:id      包裹详情(产品行+采购关联+轨迹)
//   POST /admin/api/order-process/purchase        提交采购信息(模式B:金额+国内快递单号)
//   POST /admin/api/order-process/unlink          取消采购关联(冲回金额)
//   POST /admin/api/order-process/ignore          搁置/恢复包裹
//   POST /admin/api/order-process/print-label     标记已打印面单(流转交运)
//   POST /admin/api/order-process/sync-run        手动触发 Ozon 订单同步
//   GET  /admin/api/order-process/sync-status     各店铺最近同步状态
import { Router } from 'express';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import logger from '../middleware/log.js';
import { orderPackageDao } from '../db/dao/sqlite/order-daos.js';
import { runOrderSyncNow, isSyncing } from '../services/order-sync.js';

const router = Router();

// 预估佣金率(实测 payout/commission 未妥投恒为 0,需自算;对齐妙手"平台佣金 XX 估"口径)
// 后续可挂 app_config 按店铺配置
const DEFAULT_COMMISSION_RATE = 0.16;

// 计算列表行的利润指标(对齐妙手金额列:订单金额/预估佣金/采购金额/预估利润/利润率)
function computeProfit(pkg) {
  const orderAmount = Number(pkg.orderAmount) || 0;
  const purchase = Number(pkg.totalPurchaseAmount) || 0;
  const commission = Math.round(orderAmount * DEFAULT_COMMISSION_RATE * 100) / 100;
  const escrow = Math.round((orderAmount - commission) * 100) / 100;
  const profit = Math.round((escrow - purchase) * 100) / 100;
  return {
    commission,
    escrow,
    profit,
    profitRateCost: purchase > 0 ? Math.round((profit / purchase) * 1000) / 10 : null,
    profitRateSale: orderAmount > 0 ? Math.round((profit / orderAmount) * 1000) / 10 : null,
  };
}

// ── Tab 计数 ────────────────────────────────────────────────
router.get('/admin/api/order-process/tabs', (_req, res) => {
  res.json(ok(orderPackageDao.tabCounts()));
});

// ── 包裹列表 ────────────────────────────────────────────────
// query: tab / keyword / storeId / purchaseStatus / arrived / page / pageSize
router.get('/admin/api/order-process/list', (req, res, next) => {
  try {
    const q = req.query;
    const data = orderPackageDao.listPackages({
      tab: q.tab,
      keyword: q.keyword,
      storeId: q.storeId,
      purchaseStatus: q.purchaseStatus,
      arrived: q.arrived,
      page: q.page,
      pageSize: q.pageSize,
    });
    // 聚合产品行 + 采购关联
    const orderIds = data.packages.map((p) => p.ozonOrderId);
    const items = orderPackageDao.getItemsByOrderIds(orderIds);
    const pkgIds = data.packages.map((p) => p.id);
    const { links } = orderPackageDao.getPurchasesByPackageIds(pkgIds);
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
      pkg.profit = computeProfit(pkg);
    }
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

// ── 包裹详情 ────────────────────────────────────────────────
router.get('/admin/api/order-process/detail/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const detail = orderPackageDao.getPackageDetail(id);
    if (!detail) return res.status(404).json({ ok: false, message: '包裹不存在' });
    detail.package.profit = computeProfit(detail.package);
    res.json(ok(detail));
  } catch (e) {
    next(e);
  }
});

// ── 提交采购信息(模式B)────────────────────────────────────
// body: {
//   packageId, platform?, purchaseSn?, paymentAmount?, logisticsCompany?, logisticsNo?,
//   buyerAccount?, sellerName?, note?,
//   items: [{ itemId, amount, quantity }]
// }
// 提交即流转:包裹 wait_process → wait_ship(直接待打单发货)
router.post('/admin/api/order-process/purchase', (req, res, next) => {
  try {
    const b = req.body || {};
    const packageId = Number(b.packageId);
    if (!packageId) return res.status(400).json({ ok: false, message: 'packageId 必填' });
    const items = Array.isArray(b.items) ? b.items : [];
    if (items.length === 0) {
      return res.status(400).json({ ok: false, message: '至少填写一行采购金额' });
    }
    // 校验:金额与快递单号至少有一项(全空无意义)
    const hasAmount = items.some((it) => Number(it.amount) > 0);
    const hasLogisticsNo = !!b.logisticsNo;
    if (!hasAmount && !hasLogisticsNo) {
      return res.status(400).json({ ok: false, message: '请填写采购金额或国内快递单号' });
    }
    const r = orderPackageDao.submitPurchase({
      packageId,
      platform: b.platform || 'other',
      purchaseSn: b.purchaseSn || null,
      paymentAmount: b.paymentAmount,
      logisticsCompany: b.logisticsCompany || null,
      logisticsNo: b.logisticsNo || null,
      buyerAccount: b.buyerAccount || null,
      sellerName: b.sellerName || null,
      note: b.note || null,
      items,
    });
    logger.info({ packageId, purchaseOrderId: r.purchaseOrderId }, '[order-process] 采购信息已提交');
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

// ── 手动触发同步 ────────────────────────────────────────────
router.post('/admin/api/order-process/sync-run', async (req, res, next) => {
  try {
    if (isSyncing()) {
      return res.json(ok({ skipped: true, reason: '同步已在进行中' }));
    }
    // 异步执行,立即返回(同步全店铺可能耗时数分钟)
    runOrderSyncNow()
      .then((r) => logger.info({ stores: r.stores?.length, durationMs: r.durationMs }, '[order-process] 手动同步完成'))
      .catch((e) => logger.error({ err: e?.message }, '[order-process] 手动同步失败'));
    res.json(ok({ started: true }));
  } catch (e) {
    next(e);
  }
});

// ── 同步状态 ────────────────────────────────────────────────
router.get('/admin/api/order-process/sync-status', (_req, res) => {
  res.json(ok({ syncing: isSyncing(), cursors: orderPackageDao.getSyncCursors() }));
});

export default router;
