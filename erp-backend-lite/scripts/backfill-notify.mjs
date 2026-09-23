// 一次性补发:webhook 停推(9-20 23:41~)期间超 6h 窗口未发的签收/揽收通知
// 幂等:只发 feishu_*_notified_at IS NULL 的单,发送成功即打标,重跑安全
import { db } from '../src/db/index.js';
import { listStores } from '../src/services/webhook/store-map.js';
import { notifyPostingEvent, notifyPostingPickedUp } from '../src/services/webhook/feishu-notify.js';

const stores = listStores();
const storeById = new Map(stores.map((s) => [s.id, s]));
const NOT_CANCEL = "('cancelled','cancelled_from_split_pending','not_accepted')";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 签收:已签收(delivered_at 非空)未通知且非取消
  const recv = db.prepare(`
    SELECT o.store_id, o.posting_number, p.delivered_at
    FROM op_ozon_order o JOIN op_package p ON p.ozon_order_id = o.id
    WHERE p.delivered_at IS NOT NULL
      AND o.feishu_received_notified_at IS NULL
      AND o.status NOT IN ${NOT_CANCEL}
  `).all();
  console.log(`待补发签收: ${recv.length} 单`);
  for (const r of recv) {
    const store = storeById.get(r.store_id);
    const ok = await notifyPostingEvent('TYPE_STATE_CHANGED', {
      posting_number: r.posting_number,
      seller_id: Number(store?.company_id ?? 0),
      changed_state_date: r.delivered_at,
      new_state: 'posting_received',
    }).catch(() => false);
    if (ok) {
      db.prepare(`UPDATE op_ozon_order SET feishu_received_notified_at = ? WHERE store_id = ? AND posting_number = ?`)
        .run(new Date().toISOString(), r.store_id, r.posting_number);
      console.log('  [received]', r.posting_number, 'OK');
    } else {
      console.log('  [received]', r.posting_number, 'FAIL(不打标,可重跑)');
    }
    await sleep(300);
  }

  // 揽收:已揽收(delivering_date 非空)未通知且非取消
  const pickup = db.prepare(`
    SELECT store_id, posting_number, delivering_date
    FROM op_ozon_order
    WHERE delivering_date IS NOT NULL
      AND feishu_pickup_notified_at IS NULL
      AND status NOT IN ${NOT_CANCEL}
  `).all();
  console.log(`待补发揽收: ${pickup.length} 单`);
  for (const r of pickup) {
    const store = storeById.get(r.store_id);
    const ok = await notifyPostingPickedUp({
      posting_number: r.posting_number,
      seller_id: Number(store?.company_id ?? 0),
      changed_state_date: r.delivering_date,
      new_state: 'posting_on_way_to_city',
    }).catch(() => false);
    if (ok) {
      db.prepare(`UPDATE op_ozon_order SET feishu_pickup_notified_at = ? WHERE store_id = ? AND posting_number = ?`)
        .run(new Date().toISOString(), r.store_id, r.posting_number);
      console.log('  [pickup]', r.posting_number, 'OK');
    } else {
      console.log('  [pickup]', r.posting_number, 'FAIL(不打标,可重跑)');
    }
    await sleep(300);
  }
  console.log('补发完成');
}
main();
