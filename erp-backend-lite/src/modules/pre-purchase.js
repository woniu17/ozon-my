// 预采购订单路由(2026-11-16)
// 预采购 = 提前采购商品、暂不绑定 Ozon 订单;到货后扫描快递单号签收。
// 与 op_purchase_order(已关联 Ozon 包裹的采购)独立。
//
// 路由:
//   GET  /admin/api/pre-purchase/list?tab=all|pending|received&keyword=&page=&pageSize=
//   POST /admin/api/pre-purchase/create          新增预采购(仅选平台订单)
//   PUT  /admin/api/pre-purchase/update/:id      修改快递单号/备注等
//   POST /admin/api/pre-purchase/receive         签收(ids 或 logisticsNo)
//   POST /admin/api/pre-purchase/receive-by-code 扫描签收用:按快递单号查 pending 预采购(不签收)
//   DELETE /admin/api/pre-purchase/delete/:id    删除
import { Router } from 'express';
import { db } from '../db/index.js';
import { ok } from '../utils/response.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import { imageCacheUrlFor } from '../services/order-image-cache.js';

const router = Router();

const nowIso = () => new Date().toISOString();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 商品图片重写为本地图床(与采购单一致) */
function mapGoods(goods) {
  if (!Array.isArray(goods)) return [];
  return goods.map((g) => {
    const out = { ...g };
    for (const k of ['thumbUrl', 'picUrl', 'image_url']) {
      if (typeof out[k] === 'string' && out[k]) out[k] = imageCacheUrlFor(out[k]);
    }
    return out;
  });
}

function rowToItem(r) {
  let items = [];
  let platformGoods = [];
  try { items = JSON.parse(r.items_json) || []; } catch { items = []; }
  try { platformGoods = JSON.parse(r.platform_goods_json) || []; } catch { platformGoods = []; }
  const goods = mapGoods(items.length ? items : platformGoods);
  const totalQty = goods.reduce((s, g) => s + (Number(g.number || g.num || g.quantity) || 0), 0);
  return {
    id: r.id,
    platform: r.platform,
    purchaseSn: r.purchase_sn,
    buyerAccount: r.buyer_account,
    buyerUserId: r.buyer_user_id,
    sellerName: r.seller_name,
    paymentAmount: r.payment_amount != null ? Number(r.payment_amount) : 0,
    goodsAmount: r.goods_amount != null ? Number(r.goods_amount) : 0,
    logisticsCompany: r.logistics_company,
    logisticsNo: r.logistics_no,
    poStatus: r.po_status,
    payAt: r.pay_at,
    note: r.note,
    receiveStatus: r.receive_status,
    receivedAt: r.received_at,
    receivedBy: r.received_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    items: goods,
    totalQty,
  };
}

// ── 列表 ──
router.get('/admin/api/pre-purchase/list', (req, res, next) => {
  try {
    const tab = String(req.query.tab || 'all');
    const keyword = String(req.query.keyword || '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const where = [];
    const args = [];
    if (tab === 'pending' || tab === 'received') {
      where.push('receive_status = ?');
      args.push(tab);
    }
    if (keyword) {
      where.push('(purchase_sn LIKE ? OR logistics_no LIKE ? OR platform LIKE ?)');
      const kw = `%${keyword}%`;
      args.push(kw, kw, kw);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM op_pre_purchase ${whereSql}`).get(...args).n;
    const rows = db
      .prepare(
        `SELECT * FROM op_pre_purchase ${whereSql} ORDER BY (receive_status='pending') DESC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...args, pageSize, (page - 1) * pageSize);
    const counts = db
      .prepare(
        `SELECT SUM(CASE WHEN receive_status='received' THEN 1 ELSE 0 END) AS received, COUNT(*) AS allN FROM op_pre_purchase`
      )
      .get();
    const all = Number(counts.allN) || 0;
    const received = Number(counts.received) || 0;
    res.json(ok({
      items: rows.map(rowToItem),
      total,
      page,
      pageSize,
      counts: { all, pending: all - received, received },
    }));
  } catch (e) {
    next(e);
  }
});

// ── 新增预采购 ──
router.post('/admin/api/pre-purchase/create', (req, res, next) => {
  try {
    const b = req.body || {};
    const platform = String(b.platform || '').trim();
    if (!platform) throw new ApiError(ErrorCode.VALIDATION_ERROR, 'platform 必填');
    const purchaseSn = b.purchaseSn != null ? String(b.purchaseSn).trim() : null;
    const itemsJson = JSON.stringify(Array.isArray(b.items) ? b.items : (Array.isArray(b.platformGoods) ? b.platformGoods : []));
    const platformGoodsJson = JSON.stringify(Array.isArray(b.platformGoods) ? b.platformGoods : []);
    const now = nowIso();
    const r = db.prepare(
      `INSERT INTO op_pre_purchase
        (platform, purchase_sn, buyer_account, buyer_user_id, seller_name, payment_amount, goods_amount,
         items_json, platform_goods_json, logistics_company, logistics_no, po_status, pay_at, note,
         receive_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`
    ).run(
      platform,
      purchaseSn || null,
      b.buyerAccount != null ? String(b.buyerAccount) : null,
      b.buyerUserId != null ? String(b.buyerUserId) : null,
      b.sellerName != null ? String(b.sellerName) : null,
      round2(b.paymentAmount),
      round2(b.goodsAmount),
      itemsJson,
      platformGoodsJson,
      b.logisticsCompany != null ? String(b.logisticsCompany) : null,
      b.logisticsNo != null ? String(b.logisticsNo).trim() : null,
      b.poStatus != null ? String(b.poStatus) : null,
      b.payAt != null ? String(b.payAt) : null,
      b.note != null ? String(b.note) : null,
      now,
      now
    );
    res.json(ok({ id: Number(r.lastInsertRowid), purchaseSn }));
  } catch (e) {
    next(e);
  }
});

// ── 修改 ──
router.put('/admin/api/pre-purchase/update/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) throw new ApiError(ErrorCode.VALIDATION_ERROR, 'id 必填');
    const b = req.body || {};
    const sets = [];
    const args = [];
    if (b.logisticsNo !== undefined) { sets.push('logistics_no = ?'); args.push(b.logisticsNo != null ? String(b.logisticsNo).trim() : null); }
    if (b.logisticsCompany !== undefined) { sets.push('logistics_company = ?'); args.push(b.logisticsCompany != null ? String(b.logisticsCompany) : null); }
    if (b.note !== undefined) { sets.push('note = ?'); args.push(b.note != null ? String(b.note) : null); }
    if (b.poStatus !== undefined) { sets.push('po_status = ?'); args.push(b.poStatus != null ? String(b.poStatus) : null); }
    if (!sets.length) throw new ApiError(ErrorCode.VALIDATION_ERROR, '无可更新字段');
    sets.push('updated_at = ?');
    args.push(nowIso(), id);
    db.prepare(`UPDATE op_pre_purchase SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    res.json(ok({ id }));
  } catch (e) {
    next(e);
  }
});

// ── 删除 ──
router.delete('/admin/api/pre-purchase/delete/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) throw new ApiError(ErrorCode.VALIDATION_ERROR, 'id 必填');
    const r = db.prepare(`DELETE FROM op_pre_purchase WHERE id = ?`).run(id);
    res.json(ok({ removed: r.changes || 0 }));
  } catch (e) {
    next(e);
  }
});

/** 内部:标记签收(幂等,已签收跳过) */
function markReceived(ids, by) {
  const list = (ids || []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (!list.length) return 0;
  const now = nowIso();
  const ph = list.map(() => '?').join(',');
  const r = db.prepare(
    `UPDATE op_pre_purchase SET receive_status='received', received_at=?, received_by=?, updated_at=?
     WHERE id IN (${ph}) AND receive_status='pending'`
  ).run(now, by || 'manual', now, ...list);
  return r.changes || 0;
}

// ── 签收(ids 或 logisticsNo)──
router.post('/admin/api/pre-purchase/receive', (req, res, next) => {
  try {
    const b = req.body || {};
    let ids = Array.isArray(b.ids) ? b.ids : [];
    // 按快递单号签收:匹配所有 pending 记录
    if (!ids.length && b.logisticsNo) {
      const code = String(b.logisticsNo).trim();
      const rows = db
        .prepare(`SELECT id FROM op_pre_purchase WHERE receive_status='pending' AND instr(logistics_no, ?) > 0`)
        .all(code);
      ids = rows.map((r) => r.id);
    }
    const changed = markReceived(ids, b.by || 'manual');
    res.json(ok({ received: changed }));
  } catch (e) {
    next(e);
  }
});

// ── 扫描签收用:按快递单号查 pending 预采购(不签收,供二次确认)──
router.post('/admin/api/pre-purchase/receive-by-code', (req, res, next) => {
  try {
    const code = String(req.body?.logisticsNo || req.body?.code || '').trim();
    if (!code) return res.json(ok({ matches: [] }));
    const rows = db
      .prepare(
        `SELECT * FROM op_pre_purchase WHERE receive_status='pending' AND instr(logistics_no, ?) > 0 ORDER BY id DESC LIMIT 20`
      )
      .all(code);
    res.json(ok({ matches: rows.map(rowToItem) }));
  } catch (e) {
    next(e);
  }
});

export default router;
