// Unfulfilled Poller:每 2 分钟轮询 /v4/posting/fbs/unfulfilled/list
// 目的:Ozon webhook 推送可能丢失/延迟,作为兜底机制发现新货件/揽收
// 流程(2026-09-13 扩展为四阶段,设计文档:docs/揽收取消兜底通知-功能设计.md):
//   1. 遍历所有店铺,翻页拉取未妥投货件(cutoff 窗口 [now-14d, now+14d])
//   2. ① 新货件发现:DB 无此 posting_number → 落库(状态取 API 实际状态映射值,
//      运送中则同时置 pickup_at)→ 新订单兜底通知(+揽收兜底通知)
//   3. ②③ 状态同步 + 揽收兜底:对 list 中每条 posting,API status 映射为推送模型状态,
//      rank 只前进不回退;首次达到揽收级且 pickup_at 为空 → 置 pickup_at + 揽收兜底通知
//      (取消类状态不在此处理——M0 实测 cancelled 不出现在 unfulfilled list,由 cancel-scanner 负责)
//   4. 当日汇总:从所有店铺本次返回的 postings 中按 in_process_at 过滤当日,
//      按 seller_id 聚合订单数 + 销售金额,并计算所有店铺总数
import config from '../config/index.js';
import { getDb } from '../db/index.js';
import { postingFbsUnfulfilledList } from './opi-client.js';
import { listStores, getStoreBySellerId } from './store-loader.js';
import { apiToPush, isPickupLevelApi, planAdvance } from './status-map.js';
import {
  notifyNewPostingDiscovered,
  notifyPickupDiscovered,
  extractSaleAmountCny,
  buildTodaySummaryFromDb,
  buildTodaySummaryLines,
  buildTodayPickupSummaryFromDb,
  buildTodayPickupSummaryLines,
} from './feishu-notify.js';
import logger from '../middleware/log.js';

const POLLER_INTERVAL_MS = 2 * 60 * 1000; // 2 分钟
const CUTOFF_WINDOW_DAYS = 14;             // cutoff 窗口 ±14 天
const PAGE_LIMIT = 100;                    // /v4 单页上限 100
const MAX_PAGES_PER_STORE = 50;             // 单店单轮最多翻 50 页(5000 条,防异常风暴)

let timer = null;
let running = false;

/**
 * 取 ISO 字符串(秒级精度即可,去掉毫秒避免某些接口报错)
 */
function iso(date) {
  return date.toISOString();
}

/**
 * 把任意时间(Date 或 ISO 串)按 Asia/Shanghai 时区格式化为 YYYY-MM-DD
 * in_process_at 是 UTC ISO 字符串(如 "2026-09-08T16:14:02Z"),
 * 直接 slice(0,10) 取到的是 UTC 日期,不是北京时间日期
 * (UTC 16:14 = 北京 00:14,应算次日)
 */
function getShDateStr(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${day}`;
}

/**
 * 单店翻页拉取未妥投货件,返回 postings 数组 + 当日子集
 * 翻页中途失败:返回已拉到的部分数据(不丢),仅记录 warn 日志
 */
async function fetchStorePostings(store) {
  const now = new Date();
  const cutoffFrom = iso(new Date(now.getTime() - CUTOFF_WINDOW_DAYS * 86400_000));
  const cutoffTo = iso(new Date(now.getTime() + CUTOFF_WINDOW_DAYS * 86400_000));

  const all = [];
  const todayStr = getShDateStr(new Date());
  const todayPostings = [];
  let cursor;
  let pages = 0;

  try {
    do {
      const resp = await postingFbsUnfulfilledList(store, { cutoffFrom, cutoffTo, cursor, limit: PAGE_LIMIT });
      const postings = Array.isArray(resp?.postings) ? resp.postings : [];
      for (const p of postings) {
        all.push(p);
        // 当日订单判定:in_process_at 是 UTC ISO,需转 Asia/Shanghai 后比对日期
        if (getShDateStr(p?.in_process_at) === todayStr) {
          todayPostings.push(p);
        }
      }
      cursor = resp?.cursor;
      pages++;
      if (pages >= MAX_PAGES_PER_STORE) {
        logger.warn({ storeId: store.id, pages }, 'unfulfilled-poller: 达到单店最大翻页数,停止翻页');
        break;
      }
    } while (cursor);
  } catch (err) {
    // 翻页中途失败:保留已拉到的部分数据(可能是前几页)
    logger.warn(
      { storeId: store.id, pages, got: all.length, todayGot: todayPostings.length, err: err.message },
      'unfulfilled-poller: 翻页中途失败,保留已拉到的部分数据',
    );
    return { all, today: todayPostings, partial: true };
  }
  return { all, today: todayPostings, partial: false };
}

/**
 * 回填当日货件金额到 DB
 * 对每个 posting,如果提取到的金额 > 0,upsert 到 ozon_postings.sale_amount_cny
 * 保证 buildTodaySummaryFromDb 查到的金额是准的(旧记录由兜底 poller 每轮刷新)
 */
function backfillSaleAmount(todayPostings) {
  if (!todayPostings || todayPostings.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE ozon_postings
    SET sale_amount_cny = CASE WHEN ? > 0 THEN ? ELSE sale_amount_cny END
    WHERE posting_number = ? AND (sale_amount_cny = 0 OR sale_amount_cny IS NULL)
  `);
  for (const p of todayPostings) {
    if (!p.posting_number) continue;
    const cny = extractSaleAmountCny(p);
    if (cny > 0) {
      stmt.run(cny, cny, p.posting_number);
    }
  }
}

/**
 * 把新发现的货件落库到 ozon_postings(模拟 new-posting.js 流程)
 * 状态取 API 实际状态映射值(不再固定 posting_created);API 状态已是揽收级时同时置 pickup_at
 * 落库失败仅记日志,不阻塞通知
 * @returns {{pickup: boolean}} 是否同时达到揽收级(调用方据此发揽收兜底通知)
 */
function persistNewPosting(store, posting) {
  const db = getDb();
  const now = new Date().toISOString();
  const postingNumber = posting.posting_number;
  const productsJson = JSON.stringify(posting.products ?? []);
  const saleAmountCny = extractSaleAmountCny(posting);
  const mappedStatus = apiToPush(posting.status) ?? 'posting_created';
  const pickup = isPickupLevelApi(posting.status);
  try {
    db.prepare(`
      INSERT INTO ozon_postings
        (posting_number, seller_id, warehouse_id, status, products_json, in_process_at, shipment_date,
         delivery_date_begin, delivery_date_end, tracking_number, is_express, tpl_integration_type,
         first_received_at, last_received_at, raw_count, sale_amount_cny, pickup_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(posting_number) DO UPDATE SET
        last_received_at=excluded.last_received_at,
        raw_count=ozon_postings.raw_count + 1,
        sale_amount_cny=CASE WHEN excluded.sale_amount_cny > 0 THEN excluded.sale_amount_cny ELSE ozon_postings.sale_amount_cny END
    `).run(
      postingNumber,
      posting.seller_id ?? store.company_id,
      posting.warehouse_id ?? null,
      mappedStatus,
      productsJson,
      posting.in_process_at ?? null,
      posting.shipment_date ?? null,
      posting.delivery_date_begin ?? null,
      posting.delivery_date_end ?? null,
      posting.tracking_number ?? null,
      posting.is_express ? 1 : 0,
      posting.tpl_integration_type ?? null,
      now,
      now,
      saleAmountCny,
      pickup ? now : null,
    );
  } catch (err) {
    logger.warn({ postingNumber, err: err.message }, 'unfulfilled-poller: 落库失败');
  }
  return { pickup };
}

/**
 * 存量货件状态推进(阶段②③):rank 只前进,首次到揽收级时补 pickup_at
 */
function syncPostingStatus(postingNumber, pushStatus, setPickup) {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.prepare(`
      UPDATE ozon_postings
      SET status=?, last_received_at=?, pickup_at=COALESCE(pickup_at, ?)
      WHERE posting_number=?
    `).run(pushStatus, now, setPickup ? now : null, postingNumber);
  } catch (err) {
    logger.warn({ postingNumber, pushStatus, err: err.message }, 'unfulfilled-poller: 状态同步失败');
  }
}

/**
 * 单轮扫描:遍历所有店铺,收集新货件/揽收 + 当日汇总
 */
async function tick() {
  if (running) return;
  running = true;
  try {
    const stores = listStores();
    if (stores.length === 0) {
      logger.warn('unfulfilled-poller: 无可用店铺,跳过本轮');
      return;
    }

    const newFindings = [];
    const pickupFindings = [];

    for (const store of stores) {
      const { all, today } = await fetchStorePostings(store);
      if (all.length === 0) continue;

      // 每轮从 DB 加载该店铺已知货件 {posting_number → {status, pickup_at}}:
      // ① 避免把 Ozon 实时推送已落库的货件误判为新货件重复推送
      // ② 供阶段②③做状态推进/揽收去重对比
      const known = loadKnownPostingsFromDb(store.company_id);

      let newCount = 0;
      let pickupCount = 0;

      for (const p of all) {
        if (!p.posting_number) continue;
        const row = known.get(p.posting_number);
        if (!row) {
          // ① 新货件:落库(状态映射;运送中则同时置 pickup_at)
          const r = persistNewPosting(store, p);
          newFindings.push({ store, posting: p });
          if (r.pickup) {
            pickupFindings.push({ store, posting: p, mappedState: apiToPush(p.status), oldStatus: null });
            pickupCount++;
          }
          newCount++;
          continue;
        }

        // ②③ 状态同步 + 揽收兜底(rank 只前进;取消类由 cancel-scanner 负责)
        const plan = planAdvance(row.status, p.status);
        if (plan.action === 'advance') {
          const setPickup = plan.pickup && !row.pickup_at;
          syncPostingStatus(p.posting_number, plan.push, setPickup);
          if (setPickup) {
            pickupFindings.push({ store, posting: p, mappedState: plan.push, oldStatus: row.status });
            pickupCount++;
          }
        }
      }

      // 回填当日货件金额到 DB:旧记录 sale_amount_cny=0 的会被补上
      // 保证 Ozon 实时推送时 buildTodaySummaryFromDb 查到的金额是准的
      backfillSaleAmount(today);

      if (newCount > 0 || pickupCount > 0) {
        logger.info(
          { storeId: store.id, storeName: store.name, newCount, pickupCount, total: all.length, todayCount: today.length },
          'unfulfilled-poller: 发现新货件/揽收',
        );
      }
    }

    // 推送飞书:每条新货件单独推送,带当日全店汇总(从 DB 查询,含刚落库+回填的新货件)
    if (newFindings.length > 0) {
      const { bySeller, total } = buildTodaySummaryFromDb();
      const todayLines = buildTodaySummaryLines(bySeller, total);
      for (const { store, posting } of newFindings) {
        await notifyNewPostingDiscovered(store, posting, todayLines).catch(err =>
          logger.warn({ err: err.message, postingNumber: posting.posting_number }, 'unfulfilled-poller: 飞书通知失败'),
        );
      }
      logger.info({ totalNew: newFindings.length, todayTotal: total }, 'unfulfilled-poller: 本轮新货件通知已发送');
    }

    // 推送飞书:揽收兜底通知(先完成全部落库再查统计,含本轮全部揽收)
    if (pickupFindings.length > 0) {
      const { bySeller, total } = buildTodayPickupSummaryFromDb();
      const pickupLines = buildTodayPickupSummaryLines(bySeller, total);
      for (const { store, posting, mappedState, oldStatus } of pickupFindings) {
        await notifyPickupDiscovered(store, posting, mappedState, oldStatus, pickupLines).catch(err =>
          logger.warn({ err: err.message, postingNumber: posting.posting_number }, 'unfulfilled-poller: 揽收飞书通知失败'),
        );
      }
      logger.info({ totalPickup: pickupFindings.length, todayPickupTotal: total }, 'unfulfilled-poller: 本轮揽收兜底通知已发送');
    }

    if (newFindings.length === 0 && pickupFindings.length === 0) {
      const { total } = buildTodaySummaryFromDb();
      logger.info({ todayTotal: total }, 'unfulfilled-poller: 本轮无新货件/揽收(汇总仍统计)');
    }
  } catch (err) {
    logger.error({ err }, 'unfulfilled-poller: tick 异常');
  } finally {
    running = false;
  }
}

/**
 * 从 ozon_postings 表加载已知货件 Map(posting_number → {status, pickup_at})
 * 避免第一轮把 DB 中已存在的全部视为"新货件"刷屏;同时供状态推进对比
 */
function loadKnownPostingsFromDb(sellerId) {
  const db = getDb();
  const map = new Map();
  try {
    const rows = db.prepare('SELECT posting_number, status, pickup_at FROM ozon_postings WHERE seller_id=?').all(sellerId);
    for (const r of rows) map.set(r.posting_number, { status: r.status, pickup_at: r.pickup_at });
  } catch (err) {
    logger.warn({ sellerId, err: err.message }, 'unfulfilled-poller: 加载已知 posting 失败,视为空集');
  }
  return map;
}

export function startUnfulfilledPoller() {
  if (timer) return;
  logger.info({ intervalMs: POLLER_INTERVAL_MS }, '启动 Unfulfilled Poller');
  // 启动后延迟 5s 跑首轮,避免与 app 初始化争抢资源
  setTimeout(() => {
    tick().catch(err => logger.error({ err }, 'unfulfilled-poller: 首次 tick 失败'));
  }, 5000);
  timer = setInterval(() => {
    tick().catch(err => logger.error({ err }, 'unfulfilled-poller: tick 失败'));
  }, POLLER_INTERVAL_MS);
}

export function stopUnfulfilledPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Unfulfilled Poller 已停止');
  }
}
