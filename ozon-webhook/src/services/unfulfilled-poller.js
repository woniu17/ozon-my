// Unfulfilled Poller:每 2 分钟轮询 /v4/posting/fbs/unfulfilled/list
// 目的:Ozon webhook 推送可能丢失/延迟,作为兜底机制发现新货件
// 流程:
//   1. 遍历所有店铺,翻页拉取未妥投货件(cutoff 窗口 [now-14d, now+14d])
//   2. 与 ozon_postings 表比对 posting_number,识别本次新发现的货件
//   3. 对新货件:落 ozon_postings + 推飞书(带当日各店铺销售汇总)
//   4. 当日汇总:从所有店铺本次返回的 postings 中按 in_process_at 过滤当日,
//      按 seller_id 聚合订单数 + 销售金额,并计算所有店铺总数
import config from '../config/index.js';
import { getDb } from '../db/index.js';
import { postingFbsUnfulfilledList } from './opi-client.js';
import { listStores, getStoreBySellerId } from './store-loader.js';
import { notifyNewPostingDiscovered, extractSaleAmountCny, buildTodaySummaryFromDb, buildTodaySummaryLines } from './feishu-notify.js';
import logger from '../middleware/log.js';

const POLLER_INTERVAL_MS = 2 * 60 * 1000; // 2 分钟
const CUTOFF_WINDOW_DAYS = 14;             // cutoff 窗口 ±14 天
const PAGE_LIMIT = 100;                    // /v4 单页上限 100
const MAX_PAGES_PER_STORE = 50;             // 单店单轮最多翻 50 页(5000 条,防异常风暴)

let timer = null;
let running = false;

// 缓存上一轮各店已知的 posting_number 集合,避免每轮全表扫描 ozon_postings
// key: store.id, value: Set<posting_number>
const knownPostingsByStore = new Map();

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
 * 落库失败仅记日志,不阻塞通知
 */
function persistNewPosting(store, posting) {
  const db = getDb();
  const now = new Date().toISOString();
  const postingNumber = posting.posting_number;
  const productsJson = JSON.stringify(posting.products ?? []);
  const saleAmountCny = extractSaleAmountCny(posting);
  try {
    db.prepare(`
      INSERT INTO ozon_postings
        (posting_number, seller_id, warehouse_id, status, products_json, in_process_at, shipment_date,
         delivery_date_begin, delivery_date_end, tracking_number, is_express, tpl_integration_type,
         first_received_at, last_received_at, raw_count, sale_amount_cny)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(posting_number) DO UPDATE SET
        last_received_at=excluded.last_received_at,
        raw_count=ozon_postings.raw_count + 1,
        sale_amount_cny=CASE WHEN excluded.sale_amount_cny > 0 THEN excluded.sale_amount_cny ELSE ozon_postings.sale_amount_cny END
    `).run(
      postingNumber,
      posting.seller_id ?? store.company_id,
      posting.warehouse_id ?? null,
      'posting_created',
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
    );
  } catch (err) {
    logger.warn({ postingNumber, err: err.message }, 'unfulfilled-poller: 落库失败');
  }
}

/**
 * 单轮扫描:遍历所有店铺,收集新货件 + 当日汇总
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

    for (const store of stores) {
      const { all, today } = await fetchStorePostings(store);
      if (all.length === 0) continue;

      // 每轮从 DB 刷新 known 集合:避免 Ozon 实时推送落库的货件被误判为新货件重复推送
      const known = loadKnownPostingsFromDb(store.company_id);
      knownPostingsByStore.set(store.id, known);

      const newPostings = [];
      for (const p of all) {
        if (!p.posting_number) continue;
        if (!known.has(p.posting_number)) {
          newPostings.push(p);
          known.add(p.posting_number);
        }
      }

      for (const p of newPostings) {
        persistNewPosting(store, p);
        newFindings.push({ store, posting: p });
      }

      // 回填当日货件金额到 DB:旧记录 sale_amount_cny=0 的会被补上
      // 保证 Ozon 实时推送时 buildTodaySummaryFromDb 查到的金额是准的
      backfillSaleAmount(today);

      if (newPostings.length > 0) {
        logger.info(
          { storeId: store.id, storeName: store.name, newCount: newPostings.length, total: all.length, todayCount: today.length },
          'unfulfilled-poller: 发现新货件',
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
    } else {
      const { total } = buildTodaySummaryFromDb();
      logger.info({ todayTotal: total }, 'unfulfilled-poller: 本轮无新货件(汇总仍统计)');
    }
  } catch (err) {
    logger.error({ err }, 'unfulfilled-poller: tick 异常');
  } finally {
    running = false;
  }
}

/**
 * 首次启动时从 ozon_postings 表加载已知 posting_number 集合
 * 避免第一轮把 DB 中已存在的全部视为"新货件"刷屏
 */
function loadKnownPostingsFromDb(sellerId) {
  const db = getDb();
  const set = new Set();
  try {
    const rows = db.prepare('SELECT posting_number FROM ozon_postings WHERE seller_id=?').all(sellerId);
    for (const r of rows) set.add(r.posting_number);
  } catch (err) {
    logger.warn({ sellerId, err: err.message }, 'unfulfilled-poller: 加载已知 posting 失败,视为空集');
  }
  return set;
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
