// TYPE_POSTING_CANCELLED handler
// 更新 ozon_postings 状态为 posting_canceled,记录取消原因 + 推送飞书
import { getDb } from '../../../db/index.js';
import { notifyPostingEvent } from '../feishu-notify.js';
import { getStoreBySellerId } from '../store-map.js';
import { orderPackageDao } from '../../../db/dao/sqlite/order-daos.js';
import logger from '../../../middleware/log.js';

export default async function postingCancelledHandler(payload, ctx) {
  const postingNumber = payload.posting_number;
  if (!postingNumber) throw new Error('POSTING_CANCELLED 缺少 posting_number');

  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE ozon_postings SET
      status=?,
      cancel_reason_id=?,
      cancel_reason_message=?,
      last_received_at=?
    WHERE posting_number=?
  `).run(
    payload.new_state ?? 'posting_canceled',
    payload.reason?.id ?? null,
    payload.reason?.message ?? null,
    now,
    postingNumber,
  );

  // 若行不存在(可能 NEW_POSTING 推送丢失),插入一条最小记录
  if (result.changes === 0) {
    db.prepare(`
      INSERT INTO ozon_postings
        (posting_number, seller_id, warehouse_id, status, cancel_reason_id, cancel_reason_message,
         first_received_at, last_received_at, raw_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      postingNumber,
      payload.seller_id ?? null,
      payload.warehouse_id ?? null,
      payload.new_state ?? 'posting_canceled',
      payload.reason?.id ?? null,
      payload.reason?.message ?? null,
      now,
      now,
    );
  }

  logger.info({ postingNumber, newState: payload.new_state }, 'POSTING_CANCELLED 落库');

  // 推送飞书(失败不影响落库结果)
  // 2026-09-22 通知去重:与 API 轮询兜底(order-sync 取消分支)共用 feishu_cancel_notified_at
  const store = payload.seller_id != null ? getStoreBySellerId(payload.seller_id) : null;
  if (store && orderPackageDao.isFeishuNotified(store.id, postingNumber, 'cancel')) {
    logger.info({ postingNumber, storeId: store.id }, 'POSTING_CANCELLED 通知已由 API 兜底发出,跳过推送');
    return;
  }
  const ok = await notifyPostingEvent('TYPE_POSTING_CANCELLED', payload).catch(err => {
    logger.warn({ err: err.message }, 'POSTING_CANCELLED 飞书通知失败');
    return false;
  });
  if (store && ok) orderPackageDao.markFeishuNotified(store.id, postingNumber, 'cancel');
}
