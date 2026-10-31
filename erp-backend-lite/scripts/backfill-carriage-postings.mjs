#!/usr/bin/env node
// 货件-发运单关联回填(2026-11-02,一次性脚本,幂等可重复执行)
//
// 背景:本地 op_carriage_posting 表上线前的存量发运没有结构化货件关联,
//       本脚本遍历各店铺全部发运(含历史),回填"货件↔发运单"关系:
//   - 活跃发运(status ∈ new/formed/created/awaiting_delivery/delivering):
//       调 /v1/assembly/carriage/posting/list 拉当前货件,removed_at = NULL
//   - 已完成/已归档/已从列表消失的发运:从 op_carriage_history.postings_json 快照解析历史货件,
//       removed_at = COALESCE(archived_at, updated_at),避免与未来新发运的"当前"唯一索引冲突
//
// 运行:node --experimental-sqlite scripts/backfill-carriage-postings.mjs
// 前置:建议先备份(scripts/backup-sqlite-daily.sh 或手动复制 data/erp.db)
import { db } from '../src/db/index.js';
import config from '../src/config/index.js';
import { carriageDeliveryList, carriagePostingList } from '../src/services/ozon-opi.js';
import { syncCarriagePostings, upsertCarriagePostingRow } from '../src/db/dao/sqlite/carriage-posting-dao.js';

const ACTIVE_STATUSES = new Set(['new', 'formed', 'created', 'awaiting_delivery', 'delivering']);

function usableStores() {
  return (config.loadStores() || []).filter((s) => s?.sync_credentials?.clientId);
}

// 从历史快照解析货件并写入(removed_at = 归档/更新时间,视为历史轨迹)
function backfillFromHistory(store, row) {
  if (!row?.postings_json) return 0;
  let postings = [];
  try {
    postings = JSON.parse(row.postings_json);
  } catch {
    return 0;
  }
  const now = new Date().toISOString();
  const removedAt = row.archived_at || row.updated_at || now;
  let count = 0;
  for (const p of Array.isArray(postings) ? postings : []) {
    if (!p?.posting_number) continue;
    upsertCarriagePostingRow({
      storeId: store.id,
      carriageId: row.carriage_id,
      posting: p,
      deliveryMethodId: row.delivery_method_id,
      departureDate: row.departure_date,
      now,
    });
    // 快照回填的行视为历史:置 removed_at(不与活跃发运的部分唯一索引冲突)
    db.prepare(
      `UPDATE op_carriage_posting
       SET removed_at = ?, updated_at = ?
       WHERE store_id = ? AND carriage_id = ? AND posting_number = ?`
    ).run(removedAt, now, String(store.id), Number(row.carriage_id), String(p.posting_number));
    count++;
  }
  return count;
}

async function main() {
  const stores = usableStores();
  const agg = {
    stores: 0,
    activeCarriages: 0,
    activePostings: 0,
    historyCarriages: 0,
    historyPostings: 0,
    errors: 0,
  };

  for (const store of stores) {
    agg.stores++;
    try {
      // ① 活跃发运清单(Ozon 侧当前可见)
      const active = new Map();
      const r = await carriageDeliveryList(store, { limit: 1000 });
      for (const m of r?.methods || []) {
        for (const c of m.carriages || []) {
          if (Number(c.id) > 0) active.set(Number(c.id), c);
        }
      }

      // ② 历史快照表(含已从 Ozon 列表消失的发运)
      const historyRows = db
        .prepare(
          `SELECT carriage_id, status, postings_json, archived_at, updated_at,
                  delivery_method_id, departure_date
           FROM op_carriage_history
           WHERE store_id = ?`
        )
        .all(String(store.id));

      const allCarriageIds = new Set([...active.keys(), ...historyRows.map((r) => Number(r.carriage_id))]);
      console.log(`店铺 ${store.id}(${store.name || ''}) 共 ${allCarriageIds.size} 个发运(活跃 ${active.size} / 历史 ${historyRows.length})...`);

      for (const carriageId of allCarriageIds) {
        const carriage = active.get(carriageId);
        if (carriage && ACTIVE_STATUSES.has(carriage.status)) {
          // 活跃发运:拉当前货件列表,removed_at = NULL
          agg.activeCarriages++;
          const postings = [];
          let cursor = '';
          let guard = 0;
          do {
            const page = await carriagePostingList(store, carriageId, { cursor, limit: 100 });
            for (const p of page?.postings || []) {
              if (p?.posting_number) postings.push(p);
            }
            cursor = page?.cursor || '';
            guard += 1;
            if (guard > 50) break; // 防死循环(单发运最多 5000 条)
          } while (cursor);
          syncCarriagePostings(store.id, carriageId, postings, {
            deliveryMethodId: carriage.delivery_method_id,
            departureDate: carriage.departure_date,
          });
          agg.activePostings += postings.length;
          console.log(`  活跃发运 ${carriageId}(${carriage.status}):${postings.length} 个货件`);
        } else {
          // 历史发运:从快照回填
          const row = historyRows.find((h) => Number(h.carriage_id) === carriageId);
          const n = backfillFromHistory(store, row);
          agg.historyCarriages++;
          agg.historyPostings += n;
          console.log(`  历史发运 ${carriageId}(${row?.status || carriage?.status || '?'}):从快照回填 ${n} 个货件`);
        }
      }
    } catch (e) {
      agg.errors++;
      console.error(`  店铺 ${store.id} 处理失败:${e.message}`);
    }
  }

  console.log('\n回填完成:', JSON.stringify(agg, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});