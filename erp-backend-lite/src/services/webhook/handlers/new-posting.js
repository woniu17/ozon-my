// TYPE_NEW_POSTING handler
// 推送已含 is_express/tracking_number,但 in_process_at 可能空,需要回拉 OPI 补全
// 多店铺:从 payload.seller_id 路由到对应 store.sync_credentials 调 OPI
// 首批实现:写入 ozon_postings 表,若有缺失字段再调 opi-client 补全
import { getDb } from '../../../db/index.js';
import { getPostingDetail } from '../opi-client.js';
import { getStoreBySellerId } from '../store-map.js';
import { notifyPostingEvent, extractSaleAmountCny } from '../feishu-notify.js';
import { orderPackageDao } from '../../../db/dao/sqlite/order-daos.js';
import logger from '../../../middleware/log.js';

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
  let saleAmountCny = 0;
  let opiDetail = null; // OPI 回拉原始返回(API 完整结构,联动建业务订单用)
  if (!payload.in_process_at || !payload.financial_data) {
    if (!store) {
      logger.warn({ postingNumber, sellerId }, '未匹配到店铺,seller_id 无法回拉 OPI,降级用推送原字段');
    } else {
      try {
        const detail = await getPostingDetail(store, postingNumber);
        opiDetail = detail;
        fullPayload = {
          ...payload,
          in_process_at: detail?.in_process_at ?? payload.in_process_at,
          shipment_date: detail?.shipment_date ?? payload.shipment_date,
          financial_data: detail?.financial_data ?? payload.financial_data,
          products: detail?.products ?? payload.products,
        };
        saleAmountCny = extractSaleAmountCny(detail ?? payload);
      } catch (err) {
        logger.warn({ postingNumber, sellerId, err: err.message }, 'OPI 回拉失败,降级用推送原始字段');
        saleAmountCny = extractSaleAmountCny(payload);
      }
    }
  } else {
    saleAmountCny = extractSaleAmountCny(payload);
  }

  const productsJson = JSON.stringify(fullPayload.products ?? []);
  const stmt = db.prepare(`
    INSERT INTO ozon_postings
      (posting_number, seller_id, warehouse_id, status, products_json, in_process_at, shipment_date,
       delivery_date_begin, delivery_date_end, tracking_number, is_express, tpl_integration_type,
       first_received_at, last_received_at, raw_count, sale_amount_cny)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(posting_number) DO UPDATE SET
      seller_id=excluded.seller_id,
      warehouse_id=excluded.warehouse_id,
      -- 终态保护:同号晚到的 NEW_POSTING(如取消推送先到)不得把已推进/已取消的状态
      -- 回退为 posting_created;仅 DB 状态为空时才写入初始状态
      status=COALESCE(ozon_postings.status, excluded.status),
      products_json=excluded.products_json,
      in_process_at=COALESCE(excluded.in_process_at, ozon_postings.in_process_at),
      shipment_date=COALESCE(excluded.shipment_date, ozon_postings.shipment_date),
      delivery_date_begin=COALESCE(excluded.delivery_date_begin, ozon_postings.delivery_date_begin),
      delivery_date_end=COALESCE(excluded.delivery_date_end, ozon_postings.delivery_date_end),
      tracking_number=excluded.tracking_number,
      is_express=excluded.is_express,
      tpl_integration_type=excluded.tpl_integration_type,
      last_received_at=excluded.last_received_at,
      raw_count=ozon_postings.raw_count + 1,
      sale_amount_cny=CASE WHEN excluded.sale_amount_cny > 0 THEN excluded.sale_amount_cny ELSE ozon_postings.sale_amount_cny END
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
    saleAmountCny,
  );

  logger.info(
    { postingNumber, sellerId, storeMatched: !!store, storeId: store?.id, saleAmountCny },
    'NEW_POSTING 落库',
  );

  // NEW_POSTING 联动建业务订单(2026-09-19):webhook 即时建 op_package,通知到即可见
  // 之前仅落 ozon_postings(通知数据源),op_package 靠 2 分钟 fast 轮询补建,存在可见延迟
  // 仅 OPI 回拉成功时联动(detail 为 /v3/get 完整 API 结构,与轮询 posting 同源);
  // 失败/降级场景跳过,由 fast 轮询兜底;syncPosting 幂等,轮询重复执行无副作用
  if (store && opiDetail) {
    try {
      const r = orderPackageDao.syncPosting(store.id, opiDetail);
      logger.info(
        { postingNumber, storeId: store.id, orderId: r.orderId, packageId: r.packageId },
        'NEW_POSTING 联动建业务订单',
      );
    } catch (err) {
      logger.warn({ postingNumber, err: err?.message }, 'NEW_POSTING 联动建单失败,等待 fast 轮询兜底');
    }
  }

  // 推送飞书(失败不影响落库结果)
  // 2026-09-20 通知去重:与 API 轮询兜底(order-sync)共用 op_ozon_order.feishu_notified_at 标记
  //  - 已打标 → API 兜底已发过(webhook 停推期间的补发),跳过防重复
  //  - 发送成功且订单行存在 → 打标;OPI 回拉失败无订单行时无法打标,
  //    API 侧通过 ozon_postings 存在性检测跳过兜底,同样防重复
  if (store && orderPackageDao.isFeishuNotified(store.id, postingNumber)) {
    logger.info({ postingNumber, storeId: store.id }, 'NEW_POSTING 飞书通知已由 API 兜底发出,跳过推送');
  } else {
    const ok = await notifyPostingEvent('TYPE_NEW_POSTING', fullPayload).catch(err => {
      logger.warn({ err: err.message }, 'NEW_POSTING 飞书通知失败');
      return false;
    });
    if (store && ok) orderPackageDao.markFeishuNotified(store.id, postingNumber);
  }
}
