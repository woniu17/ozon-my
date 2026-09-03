// Ozon 应计项目 DAO(2026-09,财务应计明细)
// 表结构见 schema.sql op_accrual;设计文档: docs/Ozon应计项目同步-功能设计.md
// 关键语义:
//   - replaceAccruals:按 posting 全量替换(DELETE+INSERT,单货件约 3 行)+ 回写 op_package 冗余列
//   - accrual_total NULL = 拉过但 Ozon 尚未生成应计(24h 重试窗口由待拉清单判定)
//   - 类型字典缓存在 app_config(key=ozon_accrual_types),全店一致跨重启复用
import { db } from '../../index.js';

// 常见应计类型中文映射(实测 6 店铺 99.6% 覆盖;其余类型回退英文名)
const ACCRUAL_TYPE_CN = {
  66: '代理佣金',
  67: '国际配送',
  69: '销售佣金',
  74: '星星商品',
  59: '逆向物流',
  93: '错误罚款',
  6: '取消处理',
};

// 常见应计类型中文说明(详情弹窗 tooltip 用)
const ACCRUAL_TYPE_DESC_CN = {
  66: 'Ozon 代理报酬(RfbsGlobalAgentFee)',
  67: '国际配送服务费(RfbsGlobalDelivery)',
  69: '销售佣金(SaleCommission)',
  74: '星星商品忠诚机制(StarsMembership)',
  59: '逆向物流/退货(ReturnFlowLogistic)',
  93: '错误率超标罚款(DefectFineErrors)',
  6: '取消/无人认领处理(Cancellation)',
};

const TYPES_CACHE_KEY = 'ozon_accrual_types';

function nowIso() {
  return new Date().toISOString();
}

// node:sqlite(DatabaseSync) 无 db.transaction(),用显式事务
// (project memory:使用 db.transaction 会 500)
function runInTx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// app_config 读 JSON
function readConfigJson(key) {
  const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

// app_config 写 JSON(upsert)
function writeConfigJson(key, value, description) {
  db.prepare(
    `INSERT INTO app_config (key, value, scope, description, updated_at)
     VALUES (?, ?, 'erp', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       description = COALESCE(excluded.description, app_config.description),
       updated_at = datetime('now')`
  ).run(key, JSON.stringify(value), description || null);
}

/** 应计类型字典(内存缓存 + app_config 持久化)
 *  返回 Map<typeId, { name, nameCn, descCn }>
 *  fetcher: async () => accrual_types 数组(由调用方注入 OPI financeAccrualTypes,
 *  避免 DAO 直接依赖 services 层;缓存命中时不调用)
 */
let _typesCache = null; // Map<id, {name, nameCn, descCn}>
export async function getAccrualTypes(fetcher) {
  if (_typesCache) return _typesCache;
  const cached = readConfigJson(TYPES_CACHE_KEY);
  if (Array.isArray(cached?.types) && cached.types.length > 0) {
    _typesCache = new Map(cached.types.map((t) => [
      t.id, { name: t.name, nameCn: ACCRUAL_TYPE_CN[t.id] || t.name, descCn: ACCRUAL_TYPE_DESC_CN[t.id] || null },
    ]));
    return _typesCache;
  }
  if (typeof fetcher !== 'function') return new Map();
  const resp = await fetcher();
  const list = resp?.accrual_types || [];
  if (list.length === 0) return new Map();
  writeConfigJson(TYPES_CACHE_KEY, { types: list, fetchedAt: nowIso() }, 'Ozon 应计类型字典(/v1/finance/accrual/types)');
  _typesCache = new Map(list.map((t) => [
    t.id, { name: t.name, nameCn: ACCRUAL_TYPE_CN[t.id] || t.name, descCn: ACCRUAL_TYPE_DESC_CN[t.id] || null },
  ]));
  return _typesCache;
}

/** 待拉应计货件清单(每店铺每轮限量,防单轮过载)
 *  条件:已完成/已取消 + (从未拉过 | 拉过但空且距上次 24h+) + 下单 90 天内
 */
export function findPendingAccrualPostings(storeId, limit = 400) {
  return db
    .prepare(
      `SELECT p.id AS packageId, o.posting_number AS postingNumber
       FROM op_package p
       JOIN op_ozon_order o ON o.id = p.ozon_order_id
       WHERE o.store_id = ?
         AND o.status IN ('delivered', 'cancelled', 'not_accepted')
         AND (
           p.accrual_synced_at IS NULL
           OR (p.accrual_total IS NULL
               AND p.accrual_synced_at < datetime('now', '-24 hours'))
         )
         AND o.in_process_at > datetime('now', '-90 days')
       ORDER BY o.in_process_at DESC
       LIMIT ?`
    )
    .all(storeId, Number(limit) || 400);
}

/** 存量回补清单(手动触发,sinceDays 窗口内全部已完成/已取消货件,含已拉过的) */
export function findBackfillAccrualPostings(storeId, sinceDays, limit = 400) {
  const days = Math.min(Math.max(Number(sinceDays) || 210, 1), 365);
  return db
    .prepare(
      `SELECT p.id AS packageId, o.posting_number AS postingNumber
       FROM op_package p
       JOIN op_ozon_order o ON o.id = p.ozon_order_id
       WHERE o.store_id = ?
         AND o.status IN ('delivered', 'cancelled', 'not_accepted')
         AND o.in_process_at > datetime('now', ?)
       ORDER BY o.in_process_at DESC
       LIMIT ?`
    )
    .all(storeId, `-${days} days`, Number(limit) || 400);
}

/** 按包裹 id 查待拉清单(单包裹刷新;须限定店铺,防止跨店凭据拉他店 posting 后空应计覆盖好数据) */
export function findAccrualPostingsByPackageIds(storeId, packageIds) {
  if (!packageIds.length) return [];
  const ph = packageIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT p.id AS packageId, o.posting_number AS postingNumber
       FROM op_package p
       JOIN op_ozon_order o ON o.id = p.ozon_order_id
       WHERE o.store_id = ? AND p.id IN (${ph})`
    )
    .all(storeId, ...packageIds);
}

/**
 * 批量落库应计(每 posting 事务内全量替换)
 * postingAccruals: [{ posting_number, accruals: [...] }](OPI 原始响应)
 * postingMap: { postingNumber → packageId }(待拉清单映射)
 * typeMap: Map<typeId, {name, nameCn}>(字典)
 * 返回 { packages: 更新包裹数, accrualRows: 明细行数 }
 */
export function replaceAccruals(storeId, postingAccruals, postingMap, typeMap) {
  const now = nowIso();
  const ins = db.prepare(
    `INSERT INTO op_accrual (store_id, posting_number, package_id, type_id, type_name,
      amount, currency, seller_price, sku, quantity, accrual_date, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let pkgCount = 0;
  let rowCount = 0;
  for (const pa of postingAccruals || []) {
    const postingNumber = String(pa?.posting_number || '');
    const packageId = postingMap.get(postingNumber);
    if (!packageId) continue; // 不在待拉清单内,跳过(防脏写)
    const accruals = Array.isArray(pa.accruals) ? pa.accruals : [];

    runInTx(() => {
      db.prepare(`DELETE FROM op_accrual WHERE package_id = ?`).run(packageId);
      let total = 0;
      let saleTotal = 0;
      for (const ac of accruals) {
        const amount = Number(ac?.accrued?.amount ?? 0);
        const sellerPrice = ac?.seller_price ? Number(ac.seller_price.amount) || null : null;
        const qty = Number(ac?.quantity) || null;
        const typeId = Number(ac?.type_id) || 0;
        const t = typeMap?.get(typeId);
        ins.run(
          storeId,
          postingNumber,
          packageId,
          typeId,
          t?.name || null,
          amount,
          ac?.accrued?.currency || 'RUB',
          sellerPrice,
          ac?.sku ? Number(ac.sku) : null,
          qty,
          ac?.accrual_date || null,
          now
        );
        total += amount;
        if (sellerPrice != null && qty) saleTotal += sellerPrice * qty;
      }
      // 空应计:accrual_total 存 NULL(区别于"0 扣款"),24h 后重试
      db.prepare(
        `UPDATE op_package SET accrual_total = ?, accrual_sale_total = ?, accrual_synced_at = ?, gmt_modified = ? WHERE id = ?`
      ).run(accruals.length > 0 ? Math.round(total * 100) / 100 : null,
            accruals.length > 0 ? Math.round(saleTotal * 100) / 100 : null,
            now, now, packageId);
    });
    pkgCount++;
    rowCount += accruals.length;
  }
  return { packages: pkgCount, accrualRows: rowCount };
}

/** 批量取应计按类型分组汇总(列表金额列拆分用:代理佣金66/国际配送67/其它)
 *  返回 [{ packageId, typeId, sum }](RUB)
 */
export function getAccrualTypeSumsByPackageIds(packageIds) {
  if (!packageIds.length) return [];
  const ph = packageIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT package_id AS packageId, type_id AS typeId, SUM(amount) AS sum
       FROM op_accrual
       WHERE package_id IN (${ph})
       GROUP BY package_id, type_id`
    )
    .all(...packageIds)
    .map((r) => ({ packageId: r.packageId, typeId: r.typeId, sum: Number(r.sum) || 0 }));
}

/** 批量取应计明细(按包裹 id 列表,列表/详情用) */
export function getAccrualsByPackageIds(packageIds) {
  if (!packageIds.length) return [];
  const ph = packageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT a.* FROM op_accrual a
       WHERE a.package_id IN (${ph})
       ORDER BY a.package_id, a.type_id`
    )
    .all(...packageIds);
  return rows.map((r) => ({
    id: r.id,
    packageId: r.package_id,
    postingNumber: r.posting_number,
    typeId: r.type_id,
    typeName: r.type_name,
    typeNameCn: ACCRUAL_TYPE_CN[r.type_id] || r.type_name,
    typeDescCn: ACCRUAL_TYPE_DESC_CN[r.type_id] || null,
    amount: r.amount,
    currency: r.currency,
    sellerPrice: r.seller_price,
    sku: r.sku,
    quantity: r.quantity,
    accrualDate: r.accrual_date,
    syncedAt: r.synced_at,
  }));
}

/** RUB→CNY 汇率(app_config.rub_cny_rate 优先,.env RUB_CNY_RATE 由调用方兜底传入) */
export function getRubCnyRate() {
  const v = readConfigJson('rub_cny_rate');
  if (v && Number(v.rate) > 0) {
    return { rate: Number(v.rate), updatedAt: v.updatedAt || null, source: 'config' };
  }
  return null;
}

/** 写 RUB→CNY 汇率 */
export function setRubCnyRate(rate) {
  const r = Number(rate);
  if (!(r > 0)) throw new Error('汇率必须为正数');
  writeConfigJson('rub_cny_rate', { rate: r, updatedAt: nowIso() }, 'RUB→CNY 汇率(应计利润换算)');
  return { rate: r, updatedAt: nowIso() };
}
