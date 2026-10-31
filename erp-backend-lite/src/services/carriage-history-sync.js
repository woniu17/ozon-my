// 发运历史同步(2026-11-01):Ozon 已完成发运会从 carriage 列表消失,
// 本服务定期把各店铺发运快照 upsert 到本地 op_carriage_history,
// 并归档"已从 Ozon 列表消失超过阈值"的进行中记录,支撑"已完成"子 tab。
//
// 数据来源:
//   - 基本字段 + carriage_json:carriage/list 每次拉取时即时 upsert(读路径写回)
//   - postings_json / contact_json:发运详情(carriage/posting-list、courier-contact/get)
//     读路径顺手写回,保证发运完成后历史详情仍有货件/联系方式快照。
import { db } from '../db/index.js';
import { carriageDeliveryList, carriagePostingList, carriageGet } from './ozon-opi.js';
import { syncCarriagePostings } from '../db/dao/sqlite/carriage-posting-dao.js';
import config from '../config/index.js';
import logger from '../middleware/log.js';
import { runWithLog } from './task-run-log.js';

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
const STARTUP_DELAY_MS = 60 * 1000; // 启动后 1 分钟做首次同步
const ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 天未出现在 Ozon 列表视为历史

// 活跃发运:仍在 Ozon 列表中、货件可变动,需要持续刷新本地货件关联
const ACTIVE_CARRIAGE_STATUSES = new Set(['new', 'formed', 'created', 'awaiting_delivery', 'delivering']);

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
  syncCarriagePostings(store.id, carriage.id, postings, {
    deliveryMethodId: carriage.delivery_method_id,
    departureDate: carriage.departure_date,
  });
  return postings.length;
}

// 同步单个店铺发运列表快照
async function syncStore(store) {
  const r = await carriageDeliveryList(store, { limit: 1000 });
  let count = 0;
  const activeCarriages = [];
  const detailNeeded = [];
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
      const existing = db
        .prepare(
          `SELECT first_mile_type, integration_type, warehouse_name, warehouse_city
           FROM op_carriage_history WHERE store_id = ? AND carriage_id = ?`
        )
        .get(String(store.id), Number(enriched.id));
      // 首程/集成方式以详情接口为准,首次见到该发运时拉一次补全;已有值则保留(权威值优先)
      // 跳过 id<=0 的"可创建发运"占位行(非真实发运单,详情接口会报参数错)
      if (Number(enriched.id) > 0 && (!existing || !existing.first_mile_type || !existing.integration_type)) {
        detailNeeded.push(enriched);
      } else {
        upsertCarriageHistory(store, {
          ...enriched,
          first_mile_type: existing.first_mile_type || enriched.first_mile_type,
          integration_type: existing.integration_type || enriched.integration_type,
          warehouse_name: existing.warehouse_name || enriched.warehouse_name,
          warehouse_city: existing.warehouse_city || enriched.warehouse_city,
        });
      }
      count++;
      // 兜底刷新:活跃发运逐个拉货件列表,维护本地"货件↔发运单"关联
      if (Number(enriched.id) > 0 && ACTIVE_CARRIAGE_STATUSES.has(enriched.status)) {
        activeCarriages.push(enriched);
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
  await runWithConcurrency(activeCarriages, 3, (c) =>
    syncCarriagePostingLink(store, c).catch((e) =>
      logger.warn(
        { err: e?.message, storeId: store.id, carriageId: c.id },
        'carriage-history-sync: 刷新货件-发运单关联失败'
      )
    )
  );
  return { storeId: store.id, count, postingsSynced: activeCarriages.length };
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