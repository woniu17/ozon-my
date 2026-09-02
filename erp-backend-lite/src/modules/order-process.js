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
import { runOrderSyncNow, runSyncAllList, isSyncing, getSyncProgress, clearSyncProgress } from '../services/order-sync.js';
import { packageLabel } from '../services/ozon-opi.js';
import { getWaybill, setWaybill } from '../services/waybill-cache.js';

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
// query: tab / keyword / storeId / purchaseStatus / arrived / cancelInitiator / page / pageSize
//        / globalKeyword / globalMode(eq|ss) —— 全局搜索:跨所有状态检索(§9.1.1)
router.get('/admin/api/order-process/list', (req, res, next) => {
  try {
    const q = req.query;
    const data = orderPackageDao.listPackages({
      tab: q.tab,
      keyword: q.keyword,
      storeId: q.storeId,
      purchaseStatus: q.purchaseStatus,
      arrived: q.arrived,
      cancelInitiator: q.cancelInitiator, // client/ozon/seller(仅 cancelled tab 用)
      globalKeyword: q.globalKeyword,
      globalMode: q.globalMode,
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
    const postingNumbers = rows.map((r) => r.postingNumber);

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
    // 异步执行,立即返回(同步全店铺可能耗时数分钟)
    runOrderSyncNow()
      .then((r) => logger.info({ stores: r.stores?.length, durationMs: r.durationMs }, '[order-process] 增量同步完成'))
      .catch((e) => logger.error({ err: e?.message }, '[order-process] 增量同步失败'));
    res.json(ok({ started: true, type: 'incremental' }));
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

// ── 关闭已完成进度(用户点关闭按钮触发)──────────────────
// 仅在 active=false 时可清空;同步进行中调用返回 cleared=false
router.post('/admin/api/order-process/sync-progress/dismiss', (_req, res) => {
  res.json(ok(clearSyncProgress()));
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

// ── 妙手订单列表(分页,关联本地 op_package)────────────────
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

// ── 妙手订单详情(含采购单列表)──────────────────────────
router.get('/admin/api/order-process/miaoshou-detail/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const detail = getMiaoshouPackageDetail(id);
    if (!detail) return res.status(404).json({ ok: false, message: '妙手订单不存在' });
    res.json(ok(detail));
  } catch (e) {
    next(e);
  }
});

export default router;
