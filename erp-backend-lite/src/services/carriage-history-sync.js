// 发运历史同步(2026-11-01):Ozon 已完成发运会从 carriage 列表消失,
// 本服务定期把各店铺发运快照 upsert 到本地 op_carriage_history,
// 并归档"已从 Ozon 列表消失超过阈值"的进行中记录,支撑"已完成"子 tab。
//
// 数据来源:
//   - 基本字段 + carriage_json:carriage/list 每次拉取时即时 upsert(读路径写回)
//   - postings_json / contact_json:发运详情(carriage/posting-list、courier-contact/get)
//     读路径顺手写回,保证发运完成后历史详情仍有货件/联系方式快照。
import { db } from '../db/index.js';
import { carriageDeliveryList, carriagePostingList, carriageGet, containerLabel } from './ozon-opi.js';
import { attachPostingProductImages } from './posting-image.js';
import { extractOglInboundTrackingNumbers } from './waybill-barcode.js';
import { syncCarriagePostings } from '../db/dao/sqlite/carriage-posting-dao.js';
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { runWithLog } from './task-run-log.js';

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
const STARTUP_DELAY_MS = 60 * 1000; // 启动后 1 分钟做首次同步
const ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 天未出现在 Ozon 列表视为历史

// 活跃发运:仍在 Ozon 列表中、货件可变动,需要持续刷新本地货件关联

// 限并发执行任务(避免对 Ozon 造成突发限流)
async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  async function next() {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

function usableStores() {
  return (config.loadStores() || []).filter((s) => s?.sync_credentials?.clientId);
}

// 幂等 upsert 单个发运基本快照(不覆盖已写回的 postings/contact 快照)
export function upsertCarriageHistory(store, carriage) {
  if (!carriage || !Number(carriage.id)) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO op_carriage_history
       (store_id, carriage_id, status, delivery_method_id, delivery_method_name,
        departure_date, warehouse_name, warehouse_city, first_mile_type, integration_type,
        postings_count, containers_count, carriage_json, postings_json, contact_json,
        last_seen_at, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)
     ON CONFLICT(store_id, carriage_id) DO UPDATE SET
       status = excluded.status,
       delivery_method_id = excluded.delivery_method_id,
       delivery_method_name = excluded.delivery_method_name,
       departure_date = excluded.departure_date,
       -- 2026-11-04:列表接口不含首程/集成方式/仓库名,传入为空时保留已补全的旧值,防止覆盖
       warehouse_name = CASE WHEN excluded.warehouse_name IS NOT NULL THEN excluded.warehouse_name ELSE warehouse_name END,
       warehouse_city = CASE WHEN excluded.warehouse_city IS NOT NULL THEN excluded.warehouse_city ELSE warehouse_city END,
       first_mile_type = CASE WHEN excluded.first_mile_type IS NOT NULL THEN excluded.first_mile_type ELSE first_mile_type END,
       integration_type = CASE WHEN excluded.integration_type IS NOT NULL THEN excluded.integration_type ELSE integration_type END,
       postings_count = excluded.postings_count,
       containers_count = excluded.containers_count,
       carriage_json = excluded.carriage_json,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`
  ).run(
    String(store.id),
    Number(carriage.id),
    String(carriage.status || ''),
    carriage.delivery_method_id != null ? Number(carriage.delivery_method_id) : null,
    carriage.delivery_method_name || null,
    carriage.departure_date || null,
    carriage.warehouse_name || null,
    carriage.warehouse_city || null,
    carriage.first_mile_type || null,
    carriage.integration_type || null,
    Number(carriage.postings_count) || 0,
    carriage.containers_count != null ? String(carriage.containers_count) : null,
    JSON.stringify(carriage),
    now,
    now,
    now
  );
}

// 写回货件/联系方式快照(读路径调用;传 null 的字段保持原值)
export function updateCarriageHistoryJson(storeId, carriageId, { postingsJson, contactJson } = {}) {
  if (!storeId || !Number(carriageId)) return;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE op_carriage_history
     SET postings_json = COALESCE(?, postings_json),
         contact_json = COALESCE(?, contact_json),
         updated_at = ?
     WHERE store_id = ? AND carriage_id = ?`
  ).run(postingsJson ?? null, contactJson ?? null, now, String(storeId), Number(carriageId));
}

// 写回发运单级 OGL 国内集运仓快递单号(YT 开头;传空值保持原值)
export function updateCarriageTrackingNumber(storeId, carriageId, trackingNumber) {
  if (!storeId || !Number(carriageId)) return;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE op_carriage_history
     SET tracking_number = COALESCE(?, tracking_number),
         updated_at = ?
     WHERE store_id = ? AND carriage_id = ?`
  ).run(trackingNumber || null, now, String(storeId), Number(carriageId));
}

// 下载发运单货运标签 PDF,提取 OGL 国内集运仓快递单号(YT 开头)写回发运单表(2026-11-04)
// 背景:get-container-labels 对 OGL 集运(圆通承运)的发运返回国内段圆通面单 PDF,
// 每页一个 YT 单号,属于整个发运单;仅当 tracking_number 为空时拉取,避免每次同步重复下载。
// 非 OGL/圆通承运的发运可能无 YT 单号,返回 null 静默跳过(下次同步不再重复尝试的成本可接受)。
async function syncCarriageTracking(store, carriage) {
  let buffer;
  try {
    const r = await containerLabel(store, carriage.id);
    buffer = r?.buffer;
  } catch (e) {
    logger.debug(
      { err: e?.message, storeId: store.id, carriageId: carriage.id },
      'carriage-history-sync: 货运标签下载失败,跳过快递单号提取'
    );
    return null;
  }
  if (!buffer) return null;
  const numbers = (await extractOglInboundTrackingNumbers(buffer)).filter(Boolean);
  if (!numbers.length) return null;
  const tracking = numbers[0];
  updateCarriageTrackingNumber(store.id, carriage.id, tracking);
  return tracking;
}

// 拉取单个发运的货件列表并刷新本地关联(货件-发运单关联表,2026-11-02)
async function syncCarriagePostingLink(store, carriage) {
  const postings = [];
  let cursor = '';
  let guard = 0;
  do {
    const page = await carriagePostingList(store, carriage.id, { cursor, limit: 100 });
    for (const p of page?.postings || []) {
      if (p?.posting_number) postings.push(p);
    }
    cursor = page?.cursor || '';
    guard += 1;
    if (guard > 50) break; // 防死循环(单发运最多 5000 条)
  } while (cursor);
  // 挂载商品主图(Ozon 接口不返回 image_url,与订单处理页同口径,避免历史详情图片缺失)
  attachPostingProductImages(store.id, postings);
  syncCarriagePostings(store.id, carriage.id, postings, {
    deliveryMethodId: carriage.delivery_method_id,
    departureDate: carriage.departure_date,
  });
  // 写回货件列表快照,支撑历史详情展示(传 '[]' 表示已拉取但确实无货件,避免下次重复拉取)
  updateCarriageHistoryJson(store.id, carriage.id, {
    postingsJson: JSON.stringify(postings),
  });
  return postings.length;
}

// 同步单个店铺发运列表快照
// 扫描天数:列表接口不带 filter 只返回当天发运单,历史发运需按日期逐日扫描(2026-11-04)
const SCAN_DAYS = 7;

async function syncStore(store) {
  let count = 0;
  const postingsNeeded = []; // 需要拉取货件列表的发运单(历史补全也拉)
  const trackingNeeded = []; // 需要提取快递单号的发运单(YT 单号为空)
  const detailNeeded = [];
  const seenIds = new Set();
  const now = new Date();
  for (let i = SCAN_DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let r;
    try {
      r = await carriageDeliveryList(store, { filter: { departure_date: dateStr }, limit: 1000 });
    } catch (e) {
      logger.warn({ err: e?.message, storeId: store.id, date: dateStr }, 'carriage-history-sync: 按日期拉取发运列表失败');
      continue;
    }
    for (const m of r?.methods || []) {
      for (const c of m.carriages || []) {
        // 2026-11-04:列表接口的 carriage 对象只有 {id,status,postings_count,quantum_count},
        // 配送方式/发运日期/仓库在 method 层级,合并后再落库,否则历史详情这几列恒为空。
        const enriched = {
          ...c,
          delivery_method_id: c.delivery_method_id ?? m.delivery_method_id,
          delivery_method_name: c.delivery_method_name ?? m.delivery_method_name,
          departure_date: c.departure_date ?? m.departure_date,
          warehouse_name: c.warehouse_name ?? m.warehouse_name,
          warehouse_city: c.warehouse_city ?? m.warehouse_city,
          // method 层级的首程/集成方式仅作兜底,与 carriageGet 权威值可能不同(如 ozon vs ozon_outsourced)
          first_mile_type: c.first_mile_type ?? m.first_mile_type,
          integration_type: c.integration_type ?? m.integration_type,
        };
        // 跨天去重:同一发运单(含 id=0 占位)只处理一次
        if (seenIds.has(String(enriched.id))) continue;
        seenIds.add(String(enriched.id));
        const existing = db
          .prepare(
            `SELECT first_mile_type, integration_type, warehouse_name, warehouse_city, postings_json, tracking_number
             FROM op_carriage_history WHERE store_id = ? AND carriage_id = ?`
          )
          .get(String(store.id), Number(enriched.id));
        // 首程/集成方式以详情接口为准,首次见到该发运时拉一次补全;已有值则保留(权威值优先)
        // 跳过 id<=0 的"可创建发运"占位行(非真实发运单,详情接口会报参数错)
        if (Number(enriched.id) > 0 && (!existing || !existing.first_mile_type || !existing.integration_type)) {
          detailNeeded.push(enriched);
        } else {
          // existing 可能为 undefined(如 id=0 占位行从未落库),用可选链访问
          upsertCarriageHistory(store, {
            ...enriched,
            first_mile_type: existing?.first_mile_type || enriched.first_mile_type,
            integration_type: existing?.integration_type || enriched.integration_type,
            warehouse_name: existing?.warehouse_name || enriched.warehouse_name,
            warehouse_city: existing?.warehouse_city || enriched.warehouse_city,
          });
        }
        count++;
        // 货件列表兜底:历史补全的发运单(closed/received/cancelled)同样需要货件列表,
        // 只对尚未写回货件快照的真实发运单拉取,避免每次同步重复调用
        if (Number(enriched.id) > 0 && !existing?.postings_json) {
          postingsNeeded.push(enriched);
        }
        // 快递单号兜底:从货运标签 PDF 提取 OGL 国内集运仓快递单号(YT 开头),仅对空值拉取
        if (Number(enriched.id) > 0 && !existing?.tracking_number) {
          trackingNeeded.push(enriched);
        }
      }
    }
  }
  // 补全详情字段(仅当 method 层级和库中都无首程/集成方式时拉取详情接口)
  await runWithConcurrency(detailNeeded, 3, async (c) => {
    try {
      const d = await carriageGet(store, c.id);
      upsertCarriageHistory(store, { ...c, ...(d || {}) });
    } catch (e) {
      logger.warn(
        { err: e?.message, storeId: store.id, carriageId: c.id },
        'carriage-history-sync: 拉取发运详情失败,保留列表字段'
      );
      upsertCarriageHistory(store, c);
    }
  });
  await runWithConcurrency(postingsNeeded, 3, (c) =>
    syncCarriagePostingLink(store, c).catch((e) =>
      logger.warn(
        { err: e?.message, storeId: store.id, carriageId: c.id },
        'carriage-history-sync: 刷新货件-发运单关联失败'
      )
    )
  );
  await runWithConcurrency(trackingNeeded, 3, (c) =>
    syncCarriageTracking(store, c).catch((e) =>
      logger.warn(
        { err: e?.message, storeId: store.id, carriageId: c.id },
        'carriage-history-sync: 同步发运快递单号失败'
      )
    )
  );
  return { storeId: store.id, count, postingsSynced: postingsNeeded.length };
}

// 归档:从 Ozon 列表消失超过阈值的进行中记录标记为历史
export function archiveStaleCarriages() {
  const nowIso = new Date().toISOString();
  const cutoff = new Date(Date.now() - ARCHIVE_AFTER_MS).toISOString();
  const info = db
    .prepare(
      `UPDATE op_carriage_history
       SET archived_at = COALESCE(archived_at, ?)
       WHERE status NOT IN ('received', 'delivered', 'cancelled')
         AND last_seen_at IS NOT NULL AND last_seen_at < ?
         AND archived_at IS NULL`
    )
    .run(nowIso, cutoff);
  return Number(info.changes);
}

async function syncAllStores() {
  const stores = usableStores();
  const results = await Promise.allSettled(stores.map(syncStore));
  const okCount = results.filter((x) => x.status === 'fulfilled').length;
  const postingsSynced = results
    .filter((x) => x.status === 'fulfilled')
    .reduce((sum, x) => sum + (x.value?.postingsSynced || 0), 0);
  // 2026-11-04:记录单店同步失败原因,避免静默失败
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      logger.warn(
        { err: r.reason?.message || String(r.reason), storeId: stores[i]?.id },
        'carriage-history-sync: 单店同步失败'
      );
    }
  }
  const archived = archiveStaleCarriages();
  return { stores: stores.length, ok: okCount, archived, postingsSynced };
}

let startupTimer = null;
let intervalTimer = null;

export function startCarriageHistorySync() {
  if (startupTimer || intervalTimer) return;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runWithLog('carriage-history-sync', syncAllStores, {
      formatDetail: (r) =>
        r?.stores != null
          ? `店铺同步 ${r.ok}/${r.stores},归档 ${r.archived} 条,关联刷新 ${r.postingsSynced ?? 0} 个发运`
          : null,
    })
      .then((r) => logger.info(r, 'carriage-history-sync: 首次同步完成'))
      .catch((e) => logger.warn({ err: e.message }, 'carriage-history-sync 首次同步异常'));
    intervalTimer = setInterval(() => {
      runWithLog('carriage-history-sync', syncAllStores, {
        formatDetail: (r) =>
          r?.stores != null
            ? `店铺同步 ${r.ok}/${r.stores},归档 ${r.archived} 条,关联刷新 ${r.postingsSynced ?? 0} 个发运`
            : null,
      })
        .then((r) => logger.info(r, 'carriage-history-sync: 同步完成'))
        .catch((e) => logger.warn({ err: e.message }, 'carriage-history-sync 同步异常'));
    }, SYNC_INTERVAL_MS);
    intervalTimer.unref();
  }, STARTUP_DELAY_MS);
  startupTimer.unref();
  logger.info(
    { intervalMin: SYNC_INTERVAL_MS / 60000, archiveHours: ARCHIVE_AFTER_MS / 3600000 },
    'carriage-history-sync: 已启动(30分钟同步一次发运历史)'
  );
}

export function stopCarriageHistorySync() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}