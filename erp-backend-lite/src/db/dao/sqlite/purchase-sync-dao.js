// 采购信息跨机文件同步 DAO(2026-09,文件导出/导入方案)
// 设计文档: 多机部署场景下,本地机器(服务器不可达时)录入的采购/发货/搁置操作,
// 通过"导出 JSON 文件 → 拷贝到另一台 → 导入"合并进对方数据库。
//
// 核心原则:
//   - 全自然键定位:包裹用 (store_id, posting_number),采购单用 (platform, purchase_sn)
//     或 sync_uuid(手工单无单号),产品行用 (sku, offer_id)——绝不携带本地自增 id
//   - 叠加合并:已有的跳过,不覆盖(防重复累加);空缺的补齐
//   - 幂等:同一文件重复导入,第二次全部命中"已存在跳过",数据零变化
//   - 聚合字段(total_purchase_amount / item.purchase_amount)由关联行 SUM 绝对重算,
//     不做增量拷贝——这是幂等的关键
//
// 三个入口脚本:
//   scripts/export-purchase-sync.mjs   导出(全量人工操作数据)
//   scripts/import-purchase-sync.mjs   导入(叠加合并 + 报告)
//   scripts/diff-purchase-sync.mjs     差异对比(删库前安全检查)
import { randomUUID } from 'node:crypto';
import { db } from '../../index.js';

function nowIso() {
  return new Date().toISOString();
}

// ── 配置(app_config)────────────────────────────────────────
const CFG_LAST_EXPORT = 'purchase_sync.last_export_at';
const CFG_MODE = 'purchase_sync.mode';

function getConfig(key) {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setConfig(key, value) {
  db.prepare(
    `INSERT INTO app_config (key, value, scope, description, updated_at)
     VALUES (?, ?, 'order-process', '采购信息跨机文件同步', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, JSON.stringify(value));
}

/** 导出脚本收尾:记录导出时间 + 标记本机为"导出方"(待导出徽标只在导出方显示) */
export function markExported() {
  setConfig(CFG_LAST_EXPORT, nowIso());
  setConfig(CFG_MODE, 'secondary');
}

/**
 * 待导出状态(订单处理页徽标)
 * 计数口径:上次导出后 gmt_modified 变化 且 带人工操作痕迹
 * (采购关联/重量/交运/搁置)的包裹数。Ozon 同步也会 bump gmt_modified,
 * 故为提示性信号而非精确值;mode 非 secondary(从未导出过/纯导入方)不显示。
 */
export function getPendingExportState() {
  const mode = getConfig(CFG_MODE);
  const lastExportAt = getConfig(CFG_LAST_EXPORT);
  if (mode !== 'secondary') return { active: false, count: 0, lastExportAt };
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM op_package p
       WHERE p.gmt_modified > ?
         AND (
           EXISTS (SELECT 1 FROM op_purchase_link pl WHERE pl.package_id = p.id)
           OR p.weight IS NOT NULL
           OR p.waybill_printed_at IS NOT NULL
           OR p.is_ignored = 1
           OR (p.note IS NOT NULL AND p.note != '')
           OR (p.tags IS NOT NULL AND p.tags != '')
           OR (p.head_logistics_no IS NOT NULL AND p.head_logistics_no != '')
         )`
    )
    .get(lastExportAt || '1970-01-01T00:00:00Z');
  return { active: true, count: row.n, lastExportAt };
}

// ── 导出 ───────────────────────────────────────────────────

/**
 * 导出全量人工操作数据(采购/发货/搁置)
 * 范围:所有"带人工操作痕迹"的包裹(有采购关联 / 有称重 / 已交运 / 已搁置)
 * 输出 JSON 结构(全自然键,可安全跨机):
 * {
 *   version: 1, exportedAt, machine,
 *   packages: [{
 *     storeId, postingNumber, gmtModified,
 *     weight, waybillPrintedAt, ignored,
 *     note, tags, headLogistics: { no, company, shippedAt },
 *     purchases: [{ platform, purchaseSn, syncUuid, ...采购单字段,
 *       links: [{ sku, offerId, allocatedAmount, quantity, allocMode }] }]
 *   }]
 * }
 */
export function exportPurchaseSyncData({ machine } = {}) {
  // 1) 带人工操作痕迹的包裹
  const pkgs = db
    .prepare(
      `SELECT p.id, o.store_id, o.posting_number, p.gmt_modified,
              p.weight, p.waybill_printed_at, p.is_ignored,
              p.note, p.tags, p.head_logistics_no, p.head_logistics_company, p.head_shipped_at
       FROM op_package p
       JOIN op_ozon_order o ON o.id = p.ozon_order_id
       WHERE EXISTS (SELECT 1 FROM op_purchase_link pl WHERE pl.package_id = p.id)
          OR p.weight IS NOT NULL
          OR p.waybill_printed_at IS NOT NULL
          OR p.is_ignored = 1
          OR (p.note IS NOT NULL AND p.note != '')
          OR (p.tags IS NOT NULL AND p.tags != '')
          OR (p.head_logistics_no IS NOT NULL AND p.head_logistics_no != '')
       ORDER BY o.posting_number`
    )
    .all();
  // store_id 取订单侧(2026-09-23:历史数据存在 package.store_id 与所属订单不一致的脏值,
  // 导出/导入/diff 均按 (order.store_id, posting_number) 定位,用订单侧保证自然键可回查)
  if (!pkgs.length) {
    return { version: 1, exportedAt: nowIso(), machine: machine || null, packages: [] };
  }
  const pkgIds = pkgs.map((p) => p.id);

  // 2) 采购关联 + 采购单(一次查全,内存分组)
  const links = db
    .prepare(
      `SELECT pl.package_id, pl.allocated_amount, pl.quantity, pl.alloc_mode,
              i.sku, i.offer_id,
              po.purchase_sn, po.platform, po.purchase_channel, po.buyer_account, po.buyer_user_id,
              po.seller_name, po.payment_amount, po.goods_amount, po.status, po.pay_at, po.send_at,
              po.logistics_company, po.logistics_no, po.last_trace_at, po.last_trace_desc,
              po.note, po.sync_uuid, po.items_json
       FROM op_purchase_link pl
       JOIN op_purchase_order po ON po.id = pl.purchase_order_id
       LEFT JOIN op_ozon_order_item i ON i.id = pl.ozon_order_item_id
       WHERE pl.package_id IN (${pkgIds.map(() => '?').join(',')})`
    )
    .all(...pkgIds);

  // package_id → posting 索引;purchase 按 (pkgId + poKey) 分组,同采购单的多条 link 归并
  const pkgById = new Map(pkgs.map((p) => [p.id, p]));
  const purchMap = new Map(); // key: pkgId + '\u0000' + poIdentity
  for (const l of links) {
    const poIdentity = `${l.platform}\u0000${l.purchase_sn ?? ''}\u0000${l.sync_uuid ?? ''}`;
    const key = `${l.package_id}\u0000${poIdentity}`;
    let entry = purchMap.get(key);
    if (!entry) {
      entry = {
        packageId: l.package_id,
        platform: l.platform,
        purchaseSn: l.purchase_sn,
        syncUuid: l.sync_uuid,
        purchaseChannel: l.purchase_channel,
        buyerAccount: l.buyer_account,
        buyerUserId: l.buyer_user_id,
        sellerName: l.seller_name,
        paymentAmount: l.payment_amount,
        goodsAmount: l.goods_amount,
        status: l.status,
        payAt: l.pay_at,
        sendAt: l.send_at,
        logisticsCompany: l.logistics_company,
        logisticsNo: l.logistics_no,
        lastTraceAt: l.last_trace_at,
        lastTraceDesc: l.last_trace_desc,
        note: l.note,
        itemsJson: l.items_json,
        links: [],
      };
      purchMap.set(key, entry);
    }
    entry.links.push({
      sku: l.sku ?? null,
      offerId: l.offer_id ?? null,
      allocatedAmount: l.allocated_amount,
      quantity: l.quantity,
      allocMode: l.alloc_mode,
    });
  }

  // 3) 组装
  const packages = pkgs.map((p) => ({
    storeId: p.store_id,
    postingNumber: p.posting_number,
    gmtModified: p.gmt_modified,
    weight: p.weight ?? null,
    waybillPrintedAt: p.waybill_printed_at ?? null,
    ignored: !!p.is_ignored,
    // 2026-09-23:人工编辑的备注/标签 + 头程物流(导入侧本机为空时回填;旧版文件无这些字段,自然跳过)
    note: p.note ?? null,
    tags: p.tags ?? null,
    headLogistics: {
      no: p.head_logistics_no ?? null,
      company: p.head_logistics_company ?? null,
      shippedAt: p.head_shipped_at ?? null,
    },
    purchases: [...purchMap.values()].filter((e) => e.packageId === p.id).map(({ packageId, ...rest }) => rest),
  }));

  return {
    version: 1,
    exportedAt: nowIso(),
    machine: machine || null,
    packages,
  };
}

// ── 导入 ───────────────────────────────────────────────────

/** 按 (platform, purchase_sn) → sync_uuid 兜底 解析本地采购单 */
function resolvePo(platform, purchaseSn, syncUuid) {
  if (purchaseSn) {
    const po = db
      .prepare(`SELECT * FROM op_purchase_order WHERE platform = ? AND purchase_sn = ?`)
      .get(platform, purchaseSn);
    if (po) return po;
  }
  if (syncUuid) {
    return db.prepare(`SELECT * FROM op_purchase_order WHERE sync_uuid = ?`).get(syncUuid) || null;
  }
  return null;
}

/** 已有采购单的保守合并:只补空缺,不覆盖已有值(服务器侧数据至少一样新鲜) */
function mergeExistingPo(po, imp, report) {
  const updates = {};
  // 文本/时间字段:本地为 NULL 才回填
  for (const [impField, col] of [
    ['buyerAccount', 'buyer_account'],
    ['buyerUserId', 'buyer_user_id'],
    ['sellerName', 'seller_name'],
    ['logisticsCompany', 'logistics_company'],
    ['logisticsNo', 'logistics_no'],
    ['sendAt', 'send_at'],
    ['payAt', 'pay_at'],
    ['note', 'note'],
    ['itemsJson', 'items_json'],
    ['lastTraceDesc', 'last_trace_desc'],
  ]) {
    if (imp[impField] != null && po[col] == null) updates[col] = imp[impField];
  }
  // 金额:本地为 0/NULL 且导入值 > 0 才回填
  if (Number(po.payment_amount) === 0 && Number(imp.paymentAmount) > 0) {
    updates.payment_amount = imp.paymentAmount;
    updates.goods_amount = imp.goodsAmount;
  }
  // 状态:只进不退(wait_send/wait_pay→shipped→signed;closed 等终态不在表中,不会被覆盖)
  // 2026-09-23:由单一 wait_send→shipped 扩展为 rank 推进,补齐 shipped→signed(签收状态跨机传导)
  const statusRank = { wait_pay: 0, wait_send: 1, part_shipped: 2, shipped: 3, signed: 4 };
  if (statusRank[po.status] !== undefined && statusRank[imp.status] !== undefined
      && statusRank[imp.status] > statusRank[po.status]) {
    updates.status = imp.status;
  }
  // sync_uuid:本地缺失且导入有 → 回填(下次导出/判重可用)
  if (!po.sync_uuid && imp.syncUuid) updates.sync_uuid = imp.syncUuid;

  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map((c) => `${c} = ?`).join(', ');
    db.prepare(`UPDATE op_purchase_order SET ${sets}, gmt_modified = ? WHERE id = ?`).run(
      ...Object.values(updates), nowIso(), po.id
    );
    report.applied.purchaseUpdates++;
  }
}

/** 新建采购单(全字段直写,sync_uuid 缺失时生成) */
function insertPo(imp, report) {
  const now = nowIso();
  const r = db
    .prepare(
      `INSERT INTO op_purchase_order (purchase_sn, platform, purchase_channel, buyer_account, buyer_user_id,
          seller_name, payment_amount, goods_amount, status, pay_at, send_at, logistics_company, logistics_no,
          last_trace_at, last_trace_desc, note, sync_uuid, items_json, gmt_create, gmt_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      imp.purchaseSn || null,
      imp.platform || 'other',
      imp.purchaseChannel || 'manual',
      imp.buyerAccount || null,
      imp.buyerUserId || null,
      imp.sellerName || null,
      Math.round((Number(imp.paymentAmount) || 0) * 100) / 100,
      Math.round((Number(imp.goodsAmount) || 0) * 100) / 100,
      imp.status || 'wait_send',
      imp.payAt || null,
      imp.sendAt || null,
      imp.logisticsCompany || null,
      imp.logisticsNo || null,
      imp.lastTraceAt || null,
      imp.lastTraceDesc || null,
      imp.note || null,
      imp.syncUuid || randomUUID(),
      imp.itemsJson || null,
      now,
      now
    );
  report.applied.purchases++;
  return Number(r.id);
}

/** 按 (ozon_order_id, sku, offer_id) 解析产品行(sku/offerId 均空 = 包裹级关联 → 单 SKU 订单回退唯一行,多 SKU 返回 null) */
function resolveItemId(orderId, sku, offerId) {
  if (sku == null && offerId == null) {
    // 包裹级关联:订单恰好只有一个产品行时可精确定位,回退该行
    // (2026-09-21:避免妙手同步再产生新的包裹级 link——订单处理页采购/利润/调价均按行级匹配,包裹级会读到分摊 0)
    const only = db
      .prepare(`SELECT id FROM op_ozon_order_item WHERE ozon_order_id = ?`)
      .all(orderId);
    if (only.length === 1) return Number(only[0].id);
    return null; // 多 SKU 无法定位,保留包裹级(需人工迁移)
  }
  const row = db
    .prepare(
      `SELECT id FROM op_ozon_order_item
       WHERE ozon_order_id = ?
         AND (sku = ? OR (sku IS NULL AND ? IS NULL))
         AND (offer_id = ? OR (offer_id IS NULL AND ? IS NULL))`
    )
    .get(orderId, sku, sku, offerId, offerId);
  return row ? Number(row.id) : undefined; // undefined = 找不到对应产品行
}

/** 关联行绝对重算:包裹聚合 + 产品行金额/数量(幂等的关键,不做增量拷贝)
 *  2026-09-18 导出供 order-daos 拆单采购迁移复用(本模块仅依赖 node:crypto + db,无循环引用)
 */
export function recomputeAggregates(packageId, itemIds) {
  const now = nowIso();
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(allocated_amount), 0) AS total, COUNT(*) AS n FROM op_purchase_link WHERE package_id = ?`
    )
    .get(packageId);
  db.prepare(
    `UPDATE op_package SET
        total_purchase_amount = ?,
        purchase_status = CASE WHEN ? > 0 THEN 'complete' ELSE purchase_status END,
        operate_status = CASE WHEN operate_status = 'wait_process' AND ? > 0 THEN 'wait_ship' ELSE operate_status END,
        gmt_modified = ?
     WHERE id = ?`
  ).run(Math.round(agg.total * 100) / 100, agg.n, agg.n, now, packageId);
  const updItem = db.prepare(
    `UPDATE op_ozon_order_item SET
        purchase_amount = (SELECT COALESCE(SUM(allocated_amount), 0) FROM op_purchase_link WHERE ozon_order_item_id = op_ozon_order_item.id),
        purchase_num = (SELECT COALESCE(SUM(quantity), 0) FROM op_purchase_link WHERE ozon_order_item_id = op_ozon_order_item.id),
        gmt_modified = ?
     WHERE id = ?`
  );
  for (const itemId of itemIds) {
    if (itemId != null) updItem.run(now, itemId);
  }
}

/**
 * 导入导出文件(叠加合并)
 * @param {Object} data  exportPurchaseSyncData 的输出(JSON 反序列化)
 * @param {Object} opts  { dryRun: 预览不落库, reportPath 不在此处理 }
 * @returns 报告对象 { applied, skipped, conflicts, errors }
 */
export function importPurchaseSyncData(data, { dryRun = false } = {}) {
  const report = {
    dryRun,
    file: { exportedAt: data?.exportedAt, machine: data?.machine, packages: data?.packages?.length || 0 },
    applied: { purchases: 0, purchaseUpdates: 0, links: 0, weights: 0, waybills: 0, ignores: 0, packageMeta: 0 },
    skipped: { packages: 0, items: 0, links: 0 },
    conflicts: [],
    errors: [],
  };
  if (!data || !Array.isArray(data.packages)) {
    report.errors.push('文件格式无效:缺少 packages 数组');
    return report;
  }

  db.exec('BEGIN');
  try {
    for (const pkgImp of data.packages) {
      // 每包裹一个 SAVEPOINT:单包裹失败只回滚该包裹,不影响其余
      db.exec('SAVEPOINT pkg');
      try {
        importOnePackage(pkgImp, report);
        db.exec('RELEASE pkg');
      } catch (e) {
        db.exec('ROLLBACK TO pkg');
        db.exec('RELEASE pkg');
        report.errors.push(
          `包裹 ${pkgImp.storeId}/${pkgImp.postingNumber}: ${e.message}`
        );
      }
    }
    if (dryRun) {
      db.exec('ROLLBACK');
    } else {
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    report.errors.push(`导入事务失败: ${e.message}`);
  }
  return report;
}

function importOnePackage(pkgImp, report) {
  const order = db
    .prepare(`SELECT id FROM op_ozon_order WHERE store_id = ? AND posting_number = ?`)
    .get(pkgImp.storeId, pkgImp.postingNumber);
  const pkg = order
    ? db.prepare(`SELECT * FROM op_package WHERE ozon_order_id = ?`).get(order.id)
    : null;
  if (!pkg) {
    report.skipped.packages++;
    report.conflicts.push({
      type: 'missing_package',
      storeId: pkgImp.storeId,
      postingNumber: pkgImp.postingNumber,
      detail: '本机无此包裹(先同步 Ozon 订单再导入)',
    });
    return;
  }
  const exportedNewer = (pkgImp.gmtModified || '') > (pkg.gmt_modified || '');

  // ── 采购单 + 关联 ──
  let insertedLinks = 0;
  const touchedItems = new Set();
  for (const purImp of pkgImp.purchases || []) {
    let po = resolvePo(purImp.platform, purImp.purchaseSn, purImp.syncUuid);
    let poId;
    if (po) {
      mergeExistingPo(po, purImp, report);
      poId = Number(po.id);
    } else {
      poId = insertPo(purImp, report);
    }

    for (const linkImp of purImp.links || []) {
      const itemId = resolveItemId(order.id, linkImp.sku, linkImp.offerId);
      if (itemId === undefined) {
        report.skipped.items++;
        report.conflicts.push({
          type: 'missing_item',
          storeId: pkgImp.storeId,
          postingNumber: pkgImp.postingNumber,
          purchaseSn: purImp.purchaseSn || null,
          detail: `产品行不存在 sku=${linkImp.sku} offerId=${linkImp.offerId}(两端 Ozon 订单商品不一致)`,
        });
        continue;
      }
      // 判重:同采购单 + 同包裹 + 同产品行(COALESCE 让包裹级关联 NULL=0 参与比较)
      const existing = db
        .prepare(
          `SELECT id, allocated_amount FROM op_purchase_link
           WHERE purchase_order_id = ? AND package_id = ? AND COALESCE(ozon_order_item_id, 0) = COALESCE(?, 0)`
        )
        .get(poId, pkg.id, itemId);
      if (existing) {
        const impAmt = Math.round((Number(linkImp.allocatedAmount) || 0) * 100) / 100;
        if (Math.round(Number(existing.allocated_amount) * 100) / 100 !== impAmt) {
          report.conflicts.push({
            type: 'amount_mismatch',
            storeId: pkgImp.storeId,
            postingNumber: pkgImp.postingNumber,
            purchaseSn: purImp.purchaseSn || null,
            detail: `关联已存在但金额不同:本机 ${existing.allocated_amount} vs 文件 ${impAmt}(保留本机)`,
          });
        }
        report.skipped.links++;
        continue;
      }
      db.prepare(
        `INSERT INTO op_purchase_link (purchase_order_id, package_id, ozon_order_item_id, allocated_amount, quantity, alloc_mode, gmt_create)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        poId, pkg.id, itemId,
        Math.round((Number(linkImp.allocatedAmount) || 0) * 100) / 100,
        Number(linkImp.quantity) || 0,
        linkImp.allocMode || 'manual',
        nowIso()
      );
      insertedLinks++;
      if (itemId != null) touchedItems.add(itemId);
    }

    // 新插入关联后:头程物流补空(取有单号的采购单)
    if (insertedLinks > 0 && purImp.logisticsNo) {
      db.prepare(
        `UPDATE op_package SET
            head_logistics_no = COALESCE(head_logistics_no, ?),
            head_logistics_company = COALESCE(head_logistics_company, ?),
            head_shipped_at = COALESCE(head_shipped_at, ?),
            gmt_modified = ?
         WHERE id = ?`
      ).run(purImp.logisticsNo, purImp.logisticsCompany || null, purImp.sendAt || nowIso(), nowIso(), pkg.id);
    }
  }
  if (insertedLinks > 0) {
    report.applied.links += insertedLinks;
    recomputeAggregates(pkg.id, touchedItems);
  }

  // ── 包裹级字段:备注/标签/头程物流(2026-09-23 扩展,本机为空时回填)──
  // 头程:文件包裹级字段直填;旧版文件(无 headLogistics)由上面"新 link 的采购单"推导兜底
  const metaSets = [];
  if (pkgImp.note && !pkg.note) metaSets.push(['note = ?', pkgImp.note]);
  if (pkgImp.tags && !pkg.tags) metaSets.push(['tags = ?', pkgImp.tags]);
  const hlImp = pkgImp.headLogistics || {};
  if (hlImp.no && !pkg.head_logistics_no) {
    metaSets.push(['head_logistics_no = ?', hlImp.no]);
    if (hlImp.company && !pkg.head_logistics_company) metaSets.push(['head_logistics_company = ?', hlImp.company]);
    if (hlImp.shippedAt && !pkg.head_shipped_at) metaSets.push(['head_shipped_at = ?', hlImp.shippedAt]);
  }
  if (metaSets.length) {
    db.prepare(`UPDATE op_package SET ${metaSets.map((s) => s[0]).join(', ')}, gmt_modified = ? WHERE id = ?`)
      .run(...metaSets.map((s) => s[1]), nowIso(), pkg.id);
    report.applied.packageMeta++;
  }

  // ── 包裹级字段:称重 / 交运 / 搁置 ──
  // 规则:本机为空 → 回填;两边都有且不同 → 文件更新时间较新才覆盖,否则记冲突
  if (pkgImp.weight != null && Number(pkgImp.weight) !== Number(pkg.weight)) {
    if (pkg.weight == null || exportedNewer) {
      db.prepare(`UPDATE op_package SET weight = ?, gmt_modified = ? WHERE id = ?`).run(
        pkgImp.weight, nowIso(), pkg.id
      );
      report.applied.weights++;
    } else {
      report.conflicts.push({
        type: 'weight_mismatch',
        storeId: pkgImp.storeId,
        postingNumber: pkgImp.postingNumber,
        detail: `重量不同:本机 ${pkg.weight} vs 文件 ${pkgImp.weight}(保留本机)`,
      });
    }
  }
  if (pkgImp.waybillPrintedAt && pkgImp.waybillPrintedAt !== pkg.waybill_printed_at) {
    if (pkg.waybill_printed_at == null || exportedNewer) {
      db.prepare(
        `UPDATE op_package SET waybill_printed_at = ?,
          operate_status = CASE WHEN operate_status IN ('wait_process','wait_ship') THEN 'ship_success' ELSE operate_status END,
          gmt_modified = ?
         WHERE id = ?`
      ).run(pkgImp.waybillPrintedAt, nowIso(), pkg.id);
      report.applied.waybills++;
    } else {
      report.conflicts.push({
        type: 'waybill_mismatch',
        storeId: pkgImp.storeId,
        postingNumber: pkgImp.postingNumber,
        detail: `交运时间不同:本机 ${pkg.waybill_printed_at} vs 文件 ${pkgImp.waybillPrintedAt}(保留本机)`,
      });
    }
  }
  const impIgnored = !!pkgImp.ignored;
  if (impIgnored !== !!pkg.is_ignored) {
    if (exportedNewer) {
      db.prepare(`UPDATE op_package SET is_ignored = ?, gmt_modified = ? WHERE id = ?`).run(
        impIgnored ? 1 : 0, nowIso(), pkg.id
      );
      report.applied.ignores++;
    } else {
      report.conflicts.push({
        type: 'ignore_mismatch',
        storeId: pkgImp.storeId,
        postingNumber: pkgImp.postingNumber,
        detail: `搁置状态不同:本机 ${pkg.is_ignored ? '已搁置' : '未搁置'} vs 文件 ${impIgnored ? '已搁置' : '未搁置'}(保留本机)`,
      });
    }
  }
}

// ── 差异对比(删库前安全检查)──────────────────────────────

const linkKey = (pur, link) =>
  `${pur.platform}\u0000${pur.purchaseSn ?? ''}\u0000${pur.syncUuid ?? ''}\u0000` +
  `${link.sku ?? ''}\u0000${link.offerId ?? ''}`;

/**
 * 对比导出文件与本机数据库:文件里有哪些本机没有(删除文件来源机器前的安全检查)
 * @returns { missingPackages, missingLinks, extraLinks, fieldMismatches, safeToWipe }
 */
export function diffPurchaseSyncAgainstDb(data) {
  const result = {
    file: { exportedAt: data?.exportedAt, machine: data?.machine, packages: data?.packages?.length || 0 },
    missingPackages: [],
    missingLinks: [],
    extraLinks: [],
    fieldMismatches: [],
  };
  if (!data || !Array.isArray(data.packages)) return result;

  for (const pkgImp of data.packages) {
    const order = db
      .prepare(`SELECT id FROM op_ozon_order WHERE store_id = ? AND posting_number = ?`)
      .get(pkgImp.storeId, pkgImp.postingNumber);
    const pkg = order
      ? db.prepare(`SELECT * FROM op_package WHERE ozon_order_id = ?`).get(order.id)
      : null;
    if (!pkg) {
      result.missingPackages.push(`${pkgImp.storeId}/${pkgImp.postingNumber}`);
      continue;
    }

    // 本机该包裹的全部关联(与文件同构的自然键)
    const dbLinks = db
      .prepare(
        `SELECT po.platform, po.purchase_sn, po.sync_uuid, i.sku, i.offer_id
         FROM op_purchase_link pl
         JOIN op_purchase_order po ON po.id = pl.purchase_order_id
         LEFT JOIN op_ozon_order_item i ON i.id = pl.ozon_order_item_id
         WHERE pl.package_id = ?`
      )
      .all(pkg.id)
      .map((l) => ({ platform: l.platform, purchaseSn: l.purchase_sn, syncUuid: l.sync_uuid, sku: l.sku, offerId: l.offer_id }));
    const dbKeys = new Set(dbLinks.map((l) => linkKey(l, l)));

    for (const purImp of pkgImp.purchases || []) {
      for (const linkImp of purImp.links || []) {
        if (!dbKeys.has(linkKey(purImp, linkImp))) {
          result.missingLinks.push(
            `${pkgImp.storeId}/${pkgImp.postingNumber} → ${purImp.platform}/${purImp.purchaseSn || purImp.syncUuid} sku=${linkImp.sku ?? '-'}`
          );
        } else {
          dbKeys.delete(linkKey(purImp, linkImp)); // 剩下的 = 本机有而文件没有
        }
      }
    }
    for (const k of dbKeys) {
      const [platform, sn, uuid, sku] = k.split('\u0000');
      result.extraLinks.push(`${pkgImp.storeId}/${pkgImp.postingNumber} → ${platform}/${sn || uuid} sku=${sku || '-'}`);
    }

    // 字级差异(仅提示,不阻塞)
    if (pkgImp.weight != null && pkg.weight != null && Number(pkgImp.weight) !== Number(pkg.weight)) {
      result.fieldMismatches.push(`${pkgImp.postingNumber} 重量: 本机 ${pkg.weight} vs 文件 ${pkgImp.weight}`);
    }
    if (pkgImp.waybillPrintedAt && pkg.waybill_printed_at && pkgImp.waybillPrintedAt !== pkg.waybill_printed_at) {
      result.fieldMismatches.push(`${pkgImp.postingNumber} 交运时间不同`);
    }
    if (!!pkgImp.ignored !== !!pkg.is_ignored) {
      result.fieldMismatches.push(`${pkgImp.postingNumber} 搁置状态: 本机 ${pkg.is_ignored ? '已搁置' : '未搁置'} vs 文件 ${pkgImp.ignored ? '已搁置' : '未搁置'}`);
    }
    // 2026-09-23:备注/标签/头程物流(本机有值而文件不同/缺失 → 删库会丢,列出提示)
    if (pkg.note && pkg.note !== (pkgImp.note ?? null)) {
      result.fieldMismatches.push(`${pkgImp.postingNumber} 备注: 本机 "${pkg.note}" vs 文件 "${pkgImp.note ?? ''}"`);
    }
    if (pkg.tags && pkg.tags !== (pkgImp.tags ?? null)) {
      result.fieldMismatches.push(`${pkgImp.postingNumber} 标签: 本机 "${pkg.tags}" vs 文件 "${pkgImp.tags ?? ''}"`);
    }
    const hlDiff = pkgImp.headLogistics?.no ?? null;
    if (pkg.head_logistics_no && pkg.head_logistics_no !== hlDiff) {
      result.fieldMismatches.push(`${pkgImp.postingNumber} 头程单号: 本机 ${pkg.head_logistics_no} vs 文件 ${hlDiff ?? '(无)'}`);
    }
  }

  result.safeToWipe = result.missingPackages.length === 0 && result.missingLinks.length === 0;
  return result;
}
