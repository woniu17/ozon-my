// 订单统计(2026-09,跨店铺跨时间窗口的订单量级与金额概览)
// 路由:
//   GET /admin/api/order-stats/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&storeIds=a,b&tz=Asia/Shanghai|Europe/Moscow
//     返回 { totals, byStore } 各店铺的新订单/揽收/签收/退货 单数与金额
//     tz 为统计时区(日界按该时区 00:00 划分),默认 Asia/Shanghai
//
// 指标口径(按事件发生时间计数,不去重):
//   新订单 = op_ozon_order.in_process_at 落在 [from, to)
//   揽收   = op_ozon_order.delivering_date 落在 [from, to)
//   签收   = op_package.delivered_at 落在 [from, to) AND is_ignored = 0
//   退货   = op_package.return_at 落在 [from, to) AND is_ignored = 0
// 金额口径:统一 currency='CNY'(与 buildTodaySummaryFromDb 同源);新订单金额拆
//   amount(含取消) + validAmount(剔除取消),其余 3 指标天然不含取消
import { Router } from 'express';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import { listStores } from '../services/webhook/store-map.js';

const router = Router();

// GET /admin/api/order-stats/stores — 当前可见店铺列表(供前端筛选下拉用)
router.get('/admin/api/order-stats/stores', (_req, res, next) => {
  try {
    const stores = listStores().map(s => ({ id: s.id, name: s.name, companyId: s.company_id }));
    res.json(ok({ stores }));
  } catch (err) {
    next(err);
  }
});

// 支持的统计时区 → 固定偏移(两时区均无夏令时,全年统一)
const TZ_OFFSETS = {
  'Asia/Shanghai': '+08:00', // 北京 UTC+8
  'Europe/Moscow': '+03:00', // 莫斯科 UTC+3(2014-10 起全年无 DST)
};
const DEFAULT_TZ = 'Asia/Shanghai';
const MAX_RANGE_DAYS = 365;
const API_CANCELED = ['cancelled', 'cancelled_from_split_pending', 'not_accepted'];

/**
 * 指定时区日界日期字符串(YYYY-MM-DD) → UTC ISO [start, end)
 *   北京   from=2026-09-21 → start = 2026-09-20T16:00:00.000Z(北京 9/21 00:00)
 *   莫斯科 from=2026-09-21 → start = 2026-09-20T21:00:00.000Z(莫斯科 9/21 00:00)
 */
function localDateToUtcRange(from, to, offset) {
  const fromTs = Date.parse(from + 'T00:00:00' + offset);
  const toTs = Date.parse(to + 'T00:00:00' + offset);
  if (Number.isNaN(fromTs) || Number.isNaN(toTs)) return null;
  return { start: new Date(fromTs).toISOString(), end: new Date(toTs).toISOString() };
}

/**
 * 解析 storeIds 查询参数(逗号分隔),返回去重后的数组;空/全选返回 null
 */
function parseStoreIds(s) {
  if (!s || typeof s !== 'string') return null;
  const list = [...new Set(s.split(',').map(x => x.trim()).filter(Boolean))];
  return list.length ? list : null;
}

/**
 * 构建 IN 子句的占位符和参数
 * @param {string[]|null} storeIds null=不筛选,数组=IN 筛选
 * @param {boolean} withColumn true=返回"store_id IN (...)",false=返回" AND store_id IN (...)"
 */
function buildStoreFilter(storeIds, withColumn = false) {
  if (!storeIds || storeIds.length === 0) return { clause: '', params: [] };
  const ph = storeIds.map(() => '?').join(',');
  const clause = (withColumn ? 'store_id' : ' AND store_id') + ` IN (${ph})`;
  return { clause, params: storeIds };
}

// GET /admin/api/order-stats/summary?from=&to=&storeIds=&tz=
router.get('/admin/api/order-stats/summary', (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ ok: false, message: '缺少 from/to 参数' });
    }
    // 统计时区:北京(默认)/莫斯科;未知值回退默认
    const tz = TZ_OFFSETS[req.query.tz] ? req.query.tz : DEFAULT_TZ;
    const range = localDateToUtcRange(from, to, TZ_OFFSETS[tz]);
    if (!range) {
      return res.status(400).json({ ok: false, message: 'from/to 格式非法(应为 YYYY-MM-DD)' });
    }
    if (range.end <= range.start) {
      return res.status(400).json({ ok: false, message: 'from 必须 < to' });
    }
    const days = (Date.parse(range.end) - Date.parse(range.start)) / 86400_000;
    if (days > MAX_RANGE_DAYS) {
      return res.status(400).json({ ok: false, message: `时间范围最长 ${MAX_RANGE_DAYS} 天` });
    }

    const storeIds = parseStoreIds(req.query.storeIds);
    const stores = listStores();
    const storeMap = new Map(stores.map(s => [s.id, s]));

    const { start, end } = range;
    const cancelPh = API_CANCELED.map(() => '?').join(',');

    // ── 1) 新订单(含取消金额拆分)──────────────────────────────────────
    const sf1 = buildStoreFilter(storeIds, true);
    const rowsNew = db.prepare(`
      SELECT store_id,
        COUNT(*) AS cnt,
        COALESCE(SUM(CASE WHEN currency='CNY' THEN order_amount END), 0) AS amt,
        COALESCE(SUM(CASE WHEN currency='CNY' AND status NOT IN (${cancelPh}) THEN order_amount END), 0) AS valid_amt
      FROM op_ozon_order
      WHERE in_process_at IS NOT NULL
        AND in_process_at >= ? AND in_process_at < ?
        ${sf1.clause ? 'AND ' + sf1.clause : ''}
      GROUP BY store_id
    `).all(...API_CANCELED, start, end, ...sf1.params);

    // ── 2) 揽收 ──────────────────────────────────────────────────────
    const sf2 = buildStoreFilter(storeIds, true);
    const rowsPickup = db.prepare(`
      SELECT store_id, COUNT(*) AS cnt,
        COALESCE(SUM(CASE WHEN currency='CNY' THEN order_amount END), 0) AS amt
      FROM op_ozon_order
      WHERE delivering_date IS NOT NULL
        AND delivering_date >= ? AND delivering_date < ?
        ${sf2.clause ? 'AND ' + sf2.clause : ''}
      GROUP BY store_id
    `).all(start, end, ...sf2.params);

    // ── 3) 签收(op_package JOIN op_ozon_order)─────────────────────────
    const sf3 = buildStoreFilter(storeIds, false);
    const rowsDelivered = db.prepare(`
      SELECT p.store_id, COUNT(*) AS cnt,
        COALESCE(SUM(CASE WHEN o.currency='CNY' THEN o.order_amount END), 0) AS amt
      FROM op_package p
      JOIN op_ozon_order o ON o.id = p.ozon_order_id
      WHERE p.delivered_at IS NOT NULL
        AND p.delivered_at >= ? AND p.delivered_at < ?
        AND p.is_ignored = 0
        ${sf3.clause}
      GROUP BY p.store_id
    `).all(start, end, ...sf3.params);

    // ── 4) 退货 ──────────────────────────────────────────────────────
    const sf4 = buildStoreFilter(storeIds, false);
    const rowsReturned = db.prepare(`
      SELECT p.store_id, COUNT(*) AS cnt,
        COALESCE(SUM(CASE WHEN o.currency='CNY' THEN o.order_amount END), 0) AS amt
      FROM op_package p
      JOIN op_ozon_order o ON o.id = p.ozon_order_id
      WHERE p.return_at IS NOT NULL
        AND p.return_at >= ? AND p.return_at < ?
        AND p.is_ignored = 0
        ${sf4.clause}
      GROUP BY p.store_id
    `).all(start, end, ...sf4.params);

    // 合并 4 个 Map → byStore 数组(确保所有店铺都出现,即使 0 单)
    const acc = new Map();
    for (const s of stores) {
      acc.set(s.id, {
        storeId: s.id,
        storeName: s.name,
        new: { count: 0, amount: 0, validAmount: 0 },
        pickup: { count: 0, amount: 0 },
        delivered: { count: 0, amount: 0 },
        returned: { count: 0, amount: 0 },
      });
    }
    const merge = (rows, key, extraFields = {}) => {
      for (const r of rows) {
        const store = storeMap.get(r.store_id);
        const row = acc.get(r.store_id) || {
          storeId: r.store_id,
          storeName: store?.name ?? String(r.store_id),
          new: { count: 0, amount: 0, validAmount: 0 },
          pickup: { count: 0, amount: 0 },
          delivered: { count: 0, amount: 0 },
          returned: { count: 0, amount: 0 },
        };
        row[key].count = r.cnt;
        row[key].amount = Number(r.amt) || 0;
        if (extraFields.validAmount !== false && r.valid_amt != null) {
          row[key].validAmount = Number(r.valid_amt) || 0;
        }
        acc.set(r.store_id, row);
      }
    };
    merge(rowsNew, 'new');
    merge(rowsPickup, 'pickup', { validAmount: false });
    merge(rowsDelivered, 'delivered', { validAmount: false });
    merge(rowsReturned, 'returned', { validAmount: false });

    const byStore = [...acc.values()].sort((a, b) => {
      // 按 storeName 自然顺序(与 stores.json 一致)
      return a.storeName.localeCompare(b.storeName, 'zh-CN');
    });

    // 顶部总计
    const totals = {
      new: { count: 0, amount: 0, validAmount: 0 },
      pickup: { count: 0, amount: 0 },
      delivered: { count: 0, amount: 0 },
      returned: { count: 0, amount: 0 },
    };
    for (const r of byStore) {
      totals.new.count += r.new.count;
      totals.new.amount += r.new.amount;
      totals.new.validAmount += r.new.validAmount;
      totals.pickup.count += r.pickup.count;
      totals.pickup.amount += r.pickup.amount;
      totals.delivered.count += r.delivered.count;
      totals.delivered.amount += r.delivered.amount;
      totals.returned.count += r.returned.count;
      totals.returned.amount += r.returned.amount;
    }
    // 金额取 2 位小数,避免浮点累积误差
    for (const k of ['new', 'pickup', 'delivered', 'returned']) {
      totals[k].amount = Math.round(totals[k].amount * 100) / 100;
      if (totals[k].validAmount != null) {
        totals[k].validAmount = Math.round(totals[k].validAmount * 100) / 100;
      }
    }
    for (const r of byStore) {
      for (const k of ['new', 'pickup', 'delivered', 'returned']) {
        r[k].amount = Math.round(r[k].amount * 100) / 100;
        if (r[k].validAmount != null) {
          r[k].validAmount = Math.round(r[k].validAmount * 100) / 100;
        }
      }
    }

    res.json(ok({
      from,
      to,
      tz,
      storeIds: storeIds || [],
      totals,
      byStore,
    }));
  } catch (err) {
    next(err);
  }
});

export default router;
