// TYPE_STATE_CHANGED handler
// 更新 ozon_postings.status(推送模型状态) + 推送飞书
// 揽收路由(2026-09-13 D1 决策):首次达到揽收级(推送模型 rank 2~3)且未发过
// (pickup_at IS NULL)→ 置 pickup_at + 揽收通知(独立机器人+当日统计);
// 其余(含揽收后的重复推送)→ 普通状态变更通知。跳级推送(如直接
// posting_in_courier_service)也按揽收处理,与 unfulfilled-poller 兜底逻辑对齐
import { getDb } from '../../../db/index.js';
import { isPickupLevelPush, pushRankOf } from '../status-map.js';
import { notifyPostingEvent, notifyPostingPickedUp } from '../feishu-notify.js';
import { linkOzonOrder } from '../order-link.js';
import { getStoreBySellerId } from '../store-map.js';
import { orderPackageDao } from '../../../db/dao/sqlite/order-daos.js';
import logger from '../../../middleware/log.js';

export default async function stateChangedHandler(payload, ctx) {
  const postingNumber = payload.posting_number;
  if (!postingNumber) throw new Error('STATE_CHANGED 缺少 posting_number');

  const db = getDb();
  const now = new Date().toISOString();
  const newState = payload.new_state ?? null;

  const existing = db.prepare('SELECT status, pickup_at FROM ozon_postings WHERE posting_number=?').get(postingNumber);
  const existingRank = existing ? pushRankOf(existing.status) : -1;

  // 揽收判定:新状态为揽收级 + 未发过(pickup_at 空) + DB 尚未到揽收级以上
  // (DB 已 delivering+/妥投/取消 时不按揽收处理,防乱序推送产生过时揽收通知)
  const pickupFirst = isPickupLevelPush(newState)
    && !existing?.pickup_at
    && existingRank < 2;

  if (pickupFirst) {
    // 揽收时间优先用推送自带的状态变更时间(统计更准),缺失退化当前时间
    const pickupAt = payload.changed_state_date ?? now;
    if (existing) {
      db.prepare(`
        UPDATE ozon_postings SET status=?, pickup_at=?, last_received_at=? WHERE posting_number=?
      `).run(newState, pickupAt, now, postingNumber);
    } else {
      db.prepare(`
        INSERT INTO ozon_postings
          (posting_number, seller_id, warehouse_id, status, pickup_at, first_received_at, last_received_at, raw_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        postingNumber,
        payload.seller_id ?? null,
        payload.warehouse_id ?? null,
        newState,
        pickupAt,
        now,
        now,
      );
    }
    logger.info({ postingNumber, newState, pickupAt }, 'STATE_CHANGED 揽收落库');

    // ★ERP 联动(2026-09-17 webhook 整合):秒级推进 op_ozon_order/op_package(内部自捕获,不阻断)
    await linkOzonOrder(payload);

    // 推送飞书揽收通知(独立机器人,带当日揽收统计;失败不影响落库)
    // 2026-09-20 通知去重:与 API 轮询兜底(order-sync)共用 feishu_pickup_notified_at 标记
    const store = payload.seller_id != null ? getStoreBySellerId(payload.seller_id) : null;
    if (store && orderPackageDao.isFeishuNotified(store.id, postingNumber, 'pickup')) {
      logger.info({ postingNumber, storeId: store.id }, 'STATE_CHANGED 揽收通知已由 API 兜底发出,跳过推送');
    } else {
      const ok = await notifyPostingPickedUp(payload).catch(err => {
        logger.warn({ err: err.message }, 'STATE_CHANGED 揽收飞书通知失败');
        return false;
      });
      if (store && ok) orderPackageDao.markFeishuNotified(store.id, postingNumber, 'pickup');
    }
    return;
  }

  const result = db.prepare(`
    UPDATE ozon_postings SET status=?, last_received_at=? WHERE posting_number=?
  `).run(newState, now, postingNumber);

  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO ozon_postings
        (posting_number, seller_id, warehouse_id, status, first_received_at, last_received_at, raw_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      postingNumber,
      payload.seller_id ?? null,
      payload.warehouse_id ?? null,
      newState,
      now,
      now,
    );
  }

  logger.info({ postingNumber, newState }, 'STATE_CHANGED 落库');

  // ★ERP 联动(2026-09-17 webhook 整合):秒级推进 op_ozon_order/op_package(内部自捕获,不阻断)
  await linkOzonOrder(payload);

  // 推送飞书(失败不影响落库结果)
  // 2026-09-20 通知去重:取货点/签收与 API 轮询兜底共用 feishu_*_notified_at 标记
  // 2026-09-22 备货(posting_awaiting_registration)加入同模式:与备货动作本地通知
  //   (order-process.js ship 路由)共用 feishu_stocking_notified_at,双链路先发先标记
  const stateKey = newState === 'posting_in_pickup_point' ? 'pickup_point'
    : (newState === 'posting_received' || newState === 'posting_delivered') ? 'received'
      : newState === 'posting_awaiting_registration' ? 'stocking'
        : null;
  const store = payload.seller_id != null ? getStoreBySellerId(payload.seller_id) : null;
  if (stateKey && store && orderPackageDao.isFeishuNotified(store.id, postingNumber, stateKey)) {
    logger.info({ postingNumber, storeId: store.id, stateKey }, 'STATE_CHANGED 通知已由 API 兜底发出,跳过推送');
    return;
  }
  const ok = await notifyPostingEvent('TYPE_STATE_CHANGED', payload).catch(err => {
    logger.warn({ err: err.message }, 'STATE_CHANGED 飞书通知失败');
    return false;
  });
  if (stateKey && store && ok) orderPackageDao.markFeishuNotified(store.id, postingNumber, stateKey);
}
