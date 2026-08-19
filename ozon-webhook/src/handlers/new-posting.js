// TYPE_NEW_POSTING handler
// 推送已含 is_express/tracking_number,但 in_process_at 可能空,需要回拉 OPI 补全
// 多店铺:从 payload.seller_id 路由到对应 store.sync_credentials 调 OPI
// 首批实现:写入 ozon_postings 表,若有缺失字段再调 opi-client 补全
import { getDb } from '../db/index.js';
import { getPostingDetail } from '../services/opi-client.js';
import { getStoreBySellerId } from '../services/store-loader.js';
import { notifyPostingEvent } from '../services/feishu-notify.js';
import logger from '../middleware/log.js';

export default async function newPostingHandler(payload, ctx) {
  const postingNumber = payload.posting_number;
  if (!postingNumber) throw new Error('NEW_POSTING 缺少 posting_number');

  const sellerId = payload.seller_id;
  const store = sellerId != null ? getStoreBySellerId(sellerId) : null;

  const db = getDb();
  const now = new Date().toISOString();

  // 检查是否已存在(同号多次推送:首次 NEW_POSTING + 后续 STATE_CHANGED 等)
  const existing = db.prepare('SELECT first_received_at, raw_count FROM ozon_postings WHERE posting_number=?').get(postingNumber);

  // 推送已含字段,但 in_process_at 可能空 -> 调 OPI 补全(需匹配到店铺)
  let fullPayload = payload;
  if (!payload.in_process_at) {
    if (!store) {
      logger.warn({ postingNumber, sellerId }, '未匹配到店铺,seller_id 无法回拉 OPI,降级用推送原字段');
    } else {
      try {
        const detail = await getPostingDetail(store, postingNumber);
        fullPayload = {
          ...payload,
          in_process_at: detail?.in_process_at ?? null,
          shipment_date: detail?.shipment_date ?? payload.shipment_date,
        };
      } catch (err) {
        logger.warn({ postingNumber, sellerId, err: err.message }, 'OPI 回拉失败,降级用推送原始字段');
      }
    }
  }

  const productsJson = JSON.stringify(fullPayload.products ?? []);
  const stmt = db.prepare(`
    INSERT INTO ozon_postings
      (posting_number, seller_id, warehouse_id, status, products_json, in_process_at, shipment_date,
       delivery_date_begin, delivery_date_end, tracking_number, is_express, tpl_integration_type,
       first_received_at, last_received_at, raw_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(posting_number) DO UPDATE SET
      seller_id=excluded.seller_id,
      warehouse_id=excluded.warehouse_id,
      status=excluded.status,
      products_json=excluded.products_json,
      in_process_at=COALESCE(excluded.in_process_at, ozon_postings.in_process_at),
      shipment_date=COALESCE(excluded.shipment_date, ozon_postings.shipment_date),
      delivery_date_begin=COALESCE(excluded.delivery_date_begin, ozon_postings.delivery_date_begin),
      delivery_date_end=COALESCE(excluded.delivery_date_end, ozon_postings.delivery_date_end),
      tracking_number=excluded.tracking_number,
      is_express=excluded.is_express,
      tpl_integration_type=excluded.tpl_integration_type,
      last_received_at=excluded.last_received_at,
      raw_count=ozon_postings.raw_count + 1
  `);
  stmt.run(
    postingNumber,
    fullPayload.seller_id ?? null,
    fullPayload.warehouse_id ?? null,
    'posting_created',                    // 初始状态(后续 STATE_CHANGED 会更新)
    productsJson,
    fullPayload.in_process_at ?? null,
    fullPayload.shipment_date ?? null,
    fullPayload.delivery_date_begin ?? null,
    fullPayload.delivery_date_end ?? null,
    fullPayload.tracking_number ?? null,
    fullPayload.is_express ? 1 : 0,
    fullPayload.tpl_integration_type ?? null,
    existing?.first_received_at ?? now,
    now,
  );

  logger.info(
    { postingNumber, sellerId, storeMatched: !!store, storeId: store?.id },
    'NEW_POSTING 落库',
  );

  // 推送飞书(失败不影响落库结果)
  await notifyPostingEvent('TYPE_NEW_POSTING', fullPayload).catch(err =>
    logger.warn({ err: err.message }, 'NEW_POSTING 飞书通知失败'),
  );
}
