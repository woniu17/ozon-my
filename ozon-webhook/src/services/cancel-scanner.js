// Cancel Scanner(取消兜底,方案 C):每 10 分钟扫描已取消货件
// 背景(M0 实测 2026-09-13):cancelled 货件不出现在 unfulfilled list,
//   unfulfilled-poller 无法发现取消事件;本扫描器用 /v4/posting/fbs/list
//   statuses=['cancelled'] + last_changed_status_date 增量过滤兜底(设计文档 §6/§4.4)
// 幂等:DB status=posting_canceled 即去重标记(吸收态),实时取消推送与兜底互不重发
// 游标:内存 lastScanAt,服务重启回退 2h 窗口重扫(DB 幂等保证不重发);
//   tick 全部店铺成功后才推进游标(取 tick 开始时刻,窗口无缝衔接),失败保留旧游标下轮重扫
import { getDb } from '../db/index.js';
import { postingFbsList } from './opi-client.js';
import { listStores } from './store-loader.js';
import { notifyCancelDiscovered } from './feishu-notify.js';
import logger from '../middleware/log.js';

const SCAN_INTERVAL_MS = 10 * 60 * 1000;    // 10 分钟(取消时效性要求低于新订单)
const LOOKBACK_WINDOW_DAYS = 30;            // since 窗口(必填,按 in_process_at)
const STARTUP_FALLBACK_MS = 2 * 60 * 60 * 1000; // 无游标时回退 2h 窗口
const PAGE_LIMIT = 100;                     // /v4 单页上限 100
const MAX_PAGES_PER_STORE = 50;             // 单店单轮最多翻 50 页(防异常风暴)

let timer = null;
let running = false;
let lastScanAt = null; // 上轮扫描起点(ISO),重启后为 null

function iso(date) {
  return date.toISOString();
}

/**
 * 单店翻页拉取取消货件(增量:last_changed_status_date >= scanFrom)
 * 翻页中途失败:返回已拉到的部分数据 + partial 标记(调用方视为该店失败,不推进游标)
 */
async function fetchStoreCancelled(store, scanFrom) {
  const now = new Date();
  const since = iso(new Date(now.getTime() - LOOKBACK_WINDOW_DAYS * 86400_000));
  const to = iso(now);

  const all = [];
  let cursor;
  let pages = 0;
  try {
    do {
      const resp = await postingFbsList(store, {
        since,
        to,
        statuses: ['cancelled'],
        lastChangedFrom: scanFrom,
        lastChangedTo: to,
        cursor,
        limit: PAGE_LIMIT,
      });
      const postings = Array.isArray(resp?.postings) ? resp.postings : [];
      all.push(...postings);
      cursor = resp?.cursor;
      pages++;
      if (pages >= MAX_PAGES_PER_STORE) {
        logger.warn({ storeId: store.id, pages }, 'cancel-scanner: 达到单店最大翻页数,停止翻页');
        break;
      }
    } while (cursor);
  } catch (err) {
    logger.warn(
      { storeId: store.id, pages, got: all.length, err: err.message },
      'cancel-scanner: 拉取失败,保留已拉到的部分数据',
    );
    return { all, partial: true };
  }
  return { all, partial: false };
}

/**
 * 取消详情落库(statuses=['cancelled'] 保证为取消单):
 *   - DB 已 posting_canceled → 跳过(吸收态,幂等)
 *   - DB 非取消 → UPDATE status=posting_canceled + 取消详情(WHERE 带非取消守卫,
 *     防与实时取消推送并发时双重通知)
 *   - DB 无行(NEW_POSTING 也漏推) → INSERT 最小记录(不发新订单通知,单已取消无意义)
 * @returns {{handled: boolean, oldStatus: string|null}} handled=本次由扫描器置为取消(需通知)
 */
function persistCancel(store, posting) {
  const db = getDb();
  const now = new Date().toISOString();
  const postingNumber = posting.posting_number;
  const cancel = posting.cancellation ?? {};

  const row = db.prepare('SELECT status FROM ozon_postings WHERE posting_number=?').get(postingNumber);
  if (row?.status === 'posting_canceled') {
    return { handled: false, oldStatus: row.status };
  }

  if (row) {
    const res = db.prepare(`
      UPDATE ozon_postings SET
        status='posting_canceled',
        cancel_reason_id=?,
        cancel_reason_message=?,
        cancel_initiator=?,
        last_received_at=?
      WHERE posting_number=? AND (status IS NULL OR status != 'posting_canceled')
    `).run(
      cancel.cancel_reason_id ?? null,
      cancel.cancel_reason ?? null,
      cancel.cancellation_initiator ?? null,
      now,
      postingNumber,
    );
    if (res.changes > 0) return { handled: true, oldStatus: row.status };
    // changes=0:并发写已置取消(实时推送先到)→ 不通知
    return { handled: false, oldStatus: 'posting_canceled' };
  }

  // DB 无行:连 NEW_POSTING 都漏推的最小记录(取消单不发新订单通知)
  db.prepare(`
    INSERT INTO ozon_postings
      (posting_number, seller_id, warehouse_id, status, products_json, in_process_at, shipment_date,
       delivery_date_begin, delivery_date_end, tracking_number, is_express, tpl_integration_type,
       cancel_reason_id, cancel_reason_message, cancel_initiator,
       first_received_at, last_received_at, raw_count)
    VALUES (?, ?, ?, 'posting_canceled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(posting_number) DO UPDATE SET
      last_received_at=excluded.last_received_at,
      raw_count=ozon_postings.raw_count + 1
  `).run(
    postingNumber,
    posting.seller_id ?? store.company_id,
    posting.warehouse_id ?? null,
    JSON.stringify(posting.products ?? []),
    posting.in_process_at ?? null,
    posting.shipment_date ?? null,
    posting.delivery_date_begin ?? null,
    posting.delivery_date_end ?? null,
    posting.tracking_number ?? null,
    posting.is_express ? 1 : 0,
    posting.tpl_integration_type ?? null,
    cancel.cancel_reason_id ?? null,
    cancel.cancel_reason ?? null,
    cancel.cancellation_initiator ?? null,
    now,
    now,
  );
  return { handled: true, oldStatus: null };
}

/**
 * 单轮扫描:遍历所有店铺,发现漏推的取消事件 → 落库 + 兜底通知
 */
async function tick() {
  if (running) return;
  running = true;
  const tickStart = new Date();
  // 扫描窗口起点:上轮游标;无游标(启动/重启)回退 2h
  const scanFrom = lastScanAt ?? iso(new Date(tickStart.getTime() - STARTUP_FALLBACK_MS));
  try {
    const stores = listStores();
    if (stores.length === 0) {
      logger.warn('cancel-scanner: 无可用店铺,跳过本轮');
      return;
    }

    const findings = [];
    let allOk = true;

    for (const store of stores) {
      const { all, partial } = await fetchStoreCancelled(store, scanFrom);
      if (partial) allOk = false; // 有店拉取失败:不推进游标,下轮重扫(幂等)

      let count = 0;
      for (const p of all) {
        if (!p.posting_number) continue;
        const r = persistCancel(store, p);
        if (r.handled) {
          findings.push({ store, posting: p, oldStatus: r.oldStatus });
          count++;
        }
      }
      if (count > 0) {
        logger.info(
          { storeId: store.id, storeName: store.name, cancelCount: count, total: all.length, scanFrom },
          'cancel-scanner: 发现漏推取消',
        );
      }
    }

    // 推送飞书:取消兜底通知
    for (const { store, posting, oldStatus } of findings) {
      await notifyCancelDiscovered(store, posting, oldStatus).catch(err =>
        logger.warn({ err: err.message, postingNumber: posting.posting_number }, 'cancel-scanner: 飞书通知失败'),
      );
    }
    if (findings.length > 0) {
      logger.info({ totalCancel: findings.length }, 'cancel-scanner: 本轮取消兜底通知已发送');
    }

    // 全部店铺成功才推进游标(取 tick 开始时刻,窗口无缝;失败下轮从旧游标重扫)
    if (allOk) lastScanAt = iso(tickStart);
  } catch (err) {
    logger.error({ err }, 'cancel-scanner: tick 异常');
  } finally {
    running = false;
  }
}

export function startCancelScanner() {
  if (timer) return;
  logger.info({ intervalMs: SCAN_INTERVAL_MS }, '启动 Cancel Scanner(取消兜底,方案C)');
  // 启动后延迟 30s 跑首轮(避开 unfulfilled-poller 的 5s 首轮)
  setTimeout(() => {
    tick().catch(err => logger.error({ err }, 'cancel-scanner: 首次 tick 失败'));
  }, 30000);
  timer = setInterval(() => {
    tick().catch(err => logger.error({ err }, 'cancel-scanner: tick 失败'));
  }, SCAN_INTERVAL_MS);
}

export function stopCancelScanner() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Cancel Scanner 已停止');
  }
}
