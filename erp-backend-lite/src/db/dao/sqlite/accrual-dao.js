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
 *  条件:已完成/已取消 + 下单 365 天内,且满足以下之一:
 *    1) 从未拉过
 *    2) 拉过但空(accrual_total IS NULL,24h 重试,防 Ozon 滞后生成)
 *    3) 拉到过但缺关键类型(type 66 代理佣金/67 国际配送,不受 24h 限制)
 *       Ozon 应计分批返回,首次可能只返回 SaleCommission,需重拉补全
 *  窗口 365 天(2026-09-16,原 90 天):
 *    历史订单全量回补导入时,老单(如下单 6 个月后才入库)会被 90 天窗口
 *    永久排除在队列外,应计永远拉不到,卡死在"已采购未结算"不进"已成功"。
 *    放宽到 365 天对齐 backfill 上限;已拉且 66/67 齐全的单不会重复进队列,
 *    放宽窗口只影响"从未拉过"的老单,由每 5 分钟定时轮自动消化(每轮 2000/店)。
 *    实测 Ozon /v1/finance/accrual/postings 对数月前的老 posting 照常返回应计。
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
           -- 1) 从未拉过
           p.accrual_synced_at IS NULL
           -- 2) 拉过但空(24h 重试,防 Ozon 滞后生成)
           -- 注意:accrual_synced_at 存 ISO 格式(2026-09-23T00:42:00.000Z),
           -- 而 datetime() 产出空格分隔格式(2026-09-22 00:42:00)。同日字符串比较时
           -- 'T'(84) > ' '(32) 恒成立,导致 < 恒为 false,重试间隔被拉长到 24~48h。
           -- 用 datetime() 包裹 ISO 列统一格式后再比较。
           OR (p.accrual_total IS NULL AND datetime(p.accrual_synced_at) < datetime('now', '-24 hours'))
           -- 3) 拉到过应计但缺关键类型(type 66 代理佣金/67 国际配送)
           --    Ozon 应计分批返回,首次可能只返回 SaleCommission,需重拉补全
           --    不受 24h 限制:只要缺关键类型就重拉,确保应计完整
           OR (
             p.accrual_total IS NOT NULL
             AND p.id NOT IN (SELECT package_id FROM op_accrual WHERE type_id IN (66, 67))
           )
         )
         AND datetime(o.in_process_at) > datetime('now', '-365 days')
       -- 优先级:从未拉过的(IS NULL) → 空应计(24h) → 缺类型;同优先级内按下单时间倒序
       ORDER BY (p.accrual_synced_at IS NULL) DESC,
                (p.accrual_total IS NULL) DESC,
                o.in_process_at DESC
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
         AND datetime(o.in_process_at) > datetime('now', ?)
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

// 包裹应计全量重算(按 package_id 汇总该包裹所有行,含 by-day 挂载的订单级费用;
// 两链路共用,保证 accrual_total 口径一致)
const sumPkgStmt = () =>
  db.prepare(
    `SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS total,
            COALESCE(SUM(CASE WHEN seller_price IS NOT NULL AND quantity IS NOT NULL THEN seller_price * quantity END), 0) AS saleTotal
     FROM op_accrual WHERE package_id = ?`
  );

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
  const sumPkg = sumPkgStmt();
  let pkgCount = 0;
  let rowCount = 0;
  for (const pa of postingAccruals || []) {
    const postingNumber = String(pa?.posting_number || '');
    const packageId = postingMap.get(postingNumber);
    if (!packageId) continue; // 不在待拉清单内,跳过(防脏写)
    const accruals = Array.isArray(pa.accruals) ? pa.accruals : [];

    runInTx(() => {
      // 只删本货件号的行:同包裹可能还挂有 by-day 订单级费用(Acquiring 等,
      // posting_number 为两段式订单号),按 package_id 全删会误删
      db.prepare(`DELETE FROM op_accrual WHERE package_id = ? AND posting_number = ?`).run(packageId, postingNumber);
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
      }
      // 合计按包裹全量重算(含订单级费用行):拉到空但表里有其它行时保留真实合计
      const s = sumPkg.get(packageId);
      db.prepare(
        `UPDATE op_package SET accrual_total = ?, accrual_sale_total = ?, accrual_synced_at = ?, gmt_modified = ? WHERE id = ?`
      ).run(s.c > 0 ? Math.round(s.total * 100) / 100 : null,
            s.c > 0 ? Math.round(s.saleTotal * 100) / 100 : null,
            now, now, packageId);
    });
    pkgCount++;
    rowCount += accruals.length;
  }
  return { packages: pkgCount, accrualRows: rowCount };
}

/** 真实应计口径门槛:终态包裹集合(已签收 delivered_at 非空 / 已取消)
 *  by-day 主源下在途订单早期即产生 Acquiring 等订单级费用,accrual_total 非空但
 *  收入侧(POSTING)尚未生成,payout≈纯负费用 → 利润≈-采购严重失真;
 *  仅终态包裹可走真实口径,在途一律预估口径(对齐 findPendingAccrualPostings 的终态语义)
 */
export function getSettledEligiblePackageIds(packageIds) {
  if (!packageIds || packageIds.length === 0) return new Set();
  const ph = packageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id FROM op_package
       WHERE id IN (${ph}) AND (operate_status = 'cancelled' OR delivered_at IS NOT NULL)`
    )
    .all(...packageIds);
  return new Set(rows.map((r) => r.id));
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

// ════════════════════════════════════════════════════════════════
// by-day 数据源(2026-09-24,/v1/finance/accrual/by-day 定时主源)
// postings 只返回费用侧;by-day 费用类型 ⊇ postings(多 Acquiring 等 8 种)
// 且 POSTING.commission 携带收入侧明细。设计:
//   - 费用行(ITEM fees/NON_ITEM/delivery.services/sale_commission→type 69)
//     写 op_accrual(按 posting_number 先删后插)——结算判定(66/67)、
//     利润口径(accrual_total)、明细弹窗等现有读取方自动获得完整费用数据
//   - 收入行(POSTING.commission)写 op_accrual_income(postings 完全没有)
//   - 有 package 映射的货件回填 op_package.accrual_total/accrual_sale_total
// ════════════════════════════════════════════════════════════════

/** 展平 by-day 一天的 accruals 为 { fees: [...], incomes: [...] }
 *  fees[]:    { typeId, sku, quantity, amount, currency, sellerPrice, accrualDate, accrualId, detail }
 *  incomes[]: { sku, quantity, sellerPrice, salePrice, saleAmount, saleCommission, commission,
 *               coinvestment, bonus, accrualDate, accrualId, detail }
 */
export function flattenByDayAccruals(accruals, date) {
  const fees = [];
  const incomes = [];
  for (const a of accruals || []) {
    const unit = a?.unit_number || null;
    const accrualId = Number(a?.accrual_id) || null;
    const cat = a?.accrued_category;
    const push = (typeId, sku, qty, amount, sellerPrice, detail) => {
      fees.push({
        unit, typeId: Number(typeId) || 0, sku: sku ? Number(sku) : null,
        quantity: qty != null ? Number(qty) : null, amount: Number(amount) || 0,
        currency: 'RUB', sellerPrice: sellerPrice != null ? Number(sellerPrice) : null,
        accrualDate: a?.date || date, accrualId, detail: detail ? JSON.stringify(detail) : null,
      });
    };
    if (cat === 'ITEM') {
      for (const g of a.item_fees?.fees || []) {
        for (const f of g.fees || []) {
          push(f.type_id, g.sku, g.quantity, f.accrued?.amount, null, f);
        }
      }
    } else if (cat === 'NON_ITEM') {
      const nf = a.non_item_fee;
      if (nf) push(nf.type_id, null, null, nf.accrued?.amount, null, nf);
    } else if (cat === 'POSTING') {
      for (const p of a.posting?.products || []) {
        const c = p.commission;
        if (c) {
          // sale_commission 与 postings 的 type 69 SaleCommission 等价,写费用行保持口径连续
          push(69, p.sku, p.quantity, c.sale_commission?.amount ?? 0, c.seller_price?.amount ?? null, null);
          incomes.push({
            unit, sku: p.sku ? Number(p.sku) : null,
            quantity: p.quantity != null ? Number(p.quantity) : null,
            sellerPrice: num(c.seller_price?.amount), salePrice: num(c.sale_price?.amount),
            saleAmount: num(c.sale_amount?.amount), saleCommission: num(c.sale_commission?.amount),
            commission: num(c.commission?.amount), coinvestment: num(c.coinvestment?.amount),
            bonus: num(c.bonus?.amount), accrualDate: a?.date || date, accrualId,
            detail: JSON.stringify(c),
          });
        }
        for (const s of p.delivery?.services || []) {
          push(s.type_id, p.sku, p.quantity, s.accrued?.amount, null, s);
        }
      }
    } else if (a.container_fees) {
      // 未见实例,防御性落库:结构不明时仅 detail 供排查
      const cf = a.container_fees;
      push(cf.type_id ?? 0, null, null, cf.accrued?.amount ?? 0, null, cf);
    }
  }
  return { fees, incomes };
}

function num(v) {
  return v == null ? null : Number(v);
}

/** by-day 一天数据落库(按 store+posting_number+accrual_date 先删后插,双表)
 *  删除范围必须带日期:同一货件的应计可能分布多天(如 05-22 收款 + 05-30 退货负冲),
 *  仅按 posting_number 删会跨日期覆盖丢行;带日期后各天互不干扰,增量安全。
 *  删除范围必须带店铺:同一买家跨店下单时 Ozon 分配同一订单号并拆成不同店铺的货件
 *  (如订单 28633586-0268 → yql02 的 -1 + yql04 的 -3),订单级费用(Acquiring 等,
 *  unit_number 为两段式订单号)两店各返回一笔独立应计,不带 store 会互相覆盖丢明细。
 *  包裹映射:精确匹配货件号;两段式订单号(Acquiring/罚款按买家支付订单收取,不带
 *  -N 后缀)精确匹配不到时按店铺限定前缀匹配该订单下的货件(挂 MIN(package_id))。
 *  包裹冗余列按 package_id 全量重算(含订单级费用行,跨所有日期),保证 accrual_total 完整。
 *  accruals: by-day 响应的 accruals 数组;typeMap: getAccrualTypes() 的 Map
 *  返回 { units, feeRows, incomeRows, packages }
 */
export function replaceAccrualsByDay(storeId, date, accruals, typeMap) {
  const { fees, incomes } = flattenByDayAccruals(accruals, date);
  const units = [...new Set([...fees, ...incomes].map((r) => r.unit).filter(Boolean))];
  if (units.length === 0) return { units: 0, feeRows: 0, incomeRows: 0, packages: 0 };

  // 货件号 → package_id 映射(经订单表关联,logistics_no 可能被人工改动不可靠)
  const ph = units.map(() => '?').join(',');
  const pkgRows = db
    .prepare(
      `SELECT o.posting_number AS pn, MIN(p.id) AS pid
       FROM op_ozon_order o JOIN op_package p ON p.ozon_order_id = o.id
       WHERE o.store_id = ? AND o.posting_number IN (${ph})
       GROUP BY o.posting_number`
    )
    .all(storeId, ...units);
  const pkgMap = new Map(pkgRows.map((r) => [r.pn, r.pid]));
  // 订单级费用兜底:两段式订单号精确匹配不到货件时,前缀匹配该订单在本店的货件
  // (LIKE 无通配符注入风险:unit 为纯数字-数字格式;限定 store 防跨店误挂)
  for (const u of units) {
    if (pkgMap.has(u)) continue;
    const r = db
      .prepare(
        `SELECT MIN(p.id) AS pid
         FROM op_ozon_order o JOIN op_package p ON p.ozon_order_id = o.id
         WHERE o.store_id = ? AND o.posting_number LIKE ? || '-%'`
      )
      .get(storeId, u);
    if (r?.pid != null) pkgMap.set(u, r.pid);
  }

  const now = nowIso();
  const insFee = db.prepare(
    `INSERT INTO op_accrual (store_id, posting_number, package_id, type_id, type_name,
      amount, currency, seller_price, sku, quantity, accrual_date, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insInc = db.prepare(
    `INSERT INTO op_accrual_income (store_id, posting_number, package_id, accrual_date, accrual_id,
      sku, quantity, seller_price, sale_price, sale_amount, sale_commission, commission,
      coinvestment, bonus, detail_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updPkg = db.prepare(
    `UPDATE op_package SET accrual_total = ?, accrual_sale_total = ?, accrual_synced_at = ?, gmt_modified = ? WHERE id = ?`
  );
  const sumPkg = sumPkgStmt();

  let pkgCount = 0;
  runInTx(() => {
    const touched = new Set(); // 本日涉及的包裹,事务末统一重算冗余列
    for (const unit of units) {
      // 仅清本店本日该货件的行(跨日期行由各自日期的写入负责;跨店订单级费用各店独立)
      db.prepare(`DELETE FROM op_accrual WHERE store_id = ? AND posting_number = ? AND accrual_date = ?`).run(storeId, unit, date);
      db.prepare(`DELETE FROM op_accrual_income WHERE store_id = ? AND posting_number = ? AND accrual_date = ?`).run(storeId, unit, date);
      const packageId = pkgMap.get(unit) || null;
      for (const f of fees) {
        if (f.unit !== unit) continue;
        const t = typeMap?.get(f.typeId);
        insFee.run(
          storeId, unit, packageId, f.typeId, t?.name || null, f.amount, f.currency,
          f.sellerPrice, f.sku, f.quantity, f.accrualDate, now
        );
      }
      for (const i of incomes) {
        if (i.unit !== unit) continue;
        insInc.run(
          storeId, unit, packageId, i.accrualDate, i.accrualId, i.sku, i.quantity,
          i.sellerPrice, i.salePrice, i.saleAmount, i.saleCommission, i.commission,
          i.coinvestment, i.bonus, i.detail, now
        );
      }
      if (packageId != null) touched.add(packageId);
    }
    // 包裹冗余列按 package_id 全量重算(含订单级费用行):同一包裹可能被货件级
    // (三段式)与订单级(两段式)多个 unit 触发,统一在事务末重算保证最终一致
    for (const packageId of touched) {
      const s = sumPkg.get(packageId);
      // 空应计语义沿用 postings:0 行明细时 accrual_total 存 NULL
      updPkg.run(
        s.c > 0 ? Math.round(s.total * 100) / 100 : null,
        s.c > 0 ? Math.round(s.saleTotal * 100) / 100 : null,
        now, now, packageId
      );
      pkgCount++;
    }
  });
  return { units: units.length, feeRows: fees.length, incomeRows: incomes.length, packages: pkgCount };
}

/** by-day 覆盖统计(核对/报表用):窗口内费用类型分布 + 收入侧汇总 */
export function getBydayStats({ from, to, storeId } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push('accrual_date >= ?'); args.push(from); }
  if (to) { where.push('accrual_date <= ?'); args.push(to); }
  if (storeId) { where.push('store_id = ?'); args.push(storeId); }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const feeTypes = db
    .prepare(
      `SELECT type_id AS typeId, type_name AS typeName, COUNT(*) AS cnt, ROUND(SUM(amount), 2) AS sum
       FROM op_accrual ${cond} GROUP BY type_id ORDER BY type_id`
    )
    .all(...args);
  const income = db
    .prepare(
      `SELECT COUNT(*) AS rows, COUNT(DISTINCT posting_number) AS postings,
              ROUND(SUM(seller_price * quantity), 2) AS sellerPrice,
              ROUND(SUM(sale_amount * quantity), 2) AS saleAmount,
              ROUND(SUM(sale_commission * quantity), 2) AS saleCommission,
              ROUND(SUM(commission * quantity), 2) AS commission,
              ROUND(SUM(coinvestment * quantity), 2) AS coinvestment,
              ROUND(SUM(bonus * quantity), 2) AS bonus
       FROM op_accrual_income ${cond}`
    )
    .get(...args);
  const dates = db
    .prepare(`SELECT MIN(accrual_date) AS from_, MAX(accrual_date) AS to_ FROM op_accrual ${cond}`)
    .get(...args);
  return { dates: { from: dates.from_, to: dates.to_ }, feeTypes, income };
}
