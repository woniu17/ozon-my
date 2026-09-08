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
import { notifyNewPostingDiscovered } from './feishu-notify.js';
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
 * 计算"今日 0 点(Asia/Shanghai)"对应的日期串 YYYY-MM-DD
 * 用于与 in_process_at(UTC ISO)转 Asia/Shanghai 后比对
 */
function getTodayShDateStr() {
  return getShDateStr(new Date());
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
 * 从 posting 中提取销售金额(CNY,OPI 返回的金额本身就是人民币)
 * 优先 financial_data.posting_totals.price.amount
 * 兜底 financial_data.products[].payout.amount 之和
 * 再兜底 products[].price.amount 之和
 */
function extractSaleAmountCny(posting) {
  const fd = posting.financial_data || {};
  // 1) posting_totals.price(整单金额)
  const total = fd.posting_totals?.price?.amount;
  if (total != null) return Number(total) || 0;
  // 2) products[].payout 之和
  if (Array.isArray(fd.products)) {
    const sum = fd.products.reduce((s, p) => s + (Number(p?.payout?.amount) || 0), 0);
    if (sum > 0) return sum;
  }
  // 3) products[].price 之和(顶层)
  if (Array.isArray(posting.products)) {
    const sum = posting.products.reduce((s, p) => {
      const price = p?.price;
      const v = typeof price === 'object' ? price?.amount : price;
      return s + (Number(v) || 0);
    }, 0);
    if (sum > 0) return sum;
  }
  return 0;
}

/**
 * 单店翻页拉取未妥投货件,返回 postings 数组
 * 同时返回"当日下单"的 postings 子集,用于销售汇总
 * 翻页中途失败:返回已拉到的部分数据(不丢),仅记录 warn 日志
 */
async function fetchStorePostings(store) {
  const now = new Date();
  const cutoffFrom = iso(new Date(now.getTime() - CUTOFF_WINDOW_DAYS * 86400_000));
  const cutoffTo = iso(new Date(now.getTime() + CUTOFF_WINDOW_DAYS * 86400_000));

  const all = [];
  const todayStr = getTodayShDateStr();
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
    // 翻页中途失败:保留已拉到的部分数据(可能是前几页),今日统计部分可信
    // 不抛出,让上层用部分数据继续聚合
    logger.warn(
      { storeId: store.id, pages, got: all.length, todayGot: todayPostings.length, err: err.message },
      'unfulfilled-poller: 翻页中途失败,保留已拉到的部分数据',
    );
    return { all, today: todayPostings, partial: true };
  }
  return { all, today: todayPostings, partial: false };
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
  try {
    db.prepare(`
      INSERT INTO ozon_postings
        (posting_number, seller_id, warehouse_id, status, products_json, in_process_at, shipment_date,
         delivery_date_begin, delivery_date_end, tracking_number, is_express, tpl_integration_type,
         first_received_at, last_received_at, raw_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(posting_number) DO UPDATE SET
        last_received_at=excluded.last_received_at,
        raw_count=ozon_postings.raw_count + 1
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

    // 跨店聚合:今日订单统计(OPI 返回金额本身就是 CNY)
    // Map<seller_id, { storeName, orderCount, saleCny }>
    const todayBySeller = new Map();
    const todayTotal = { orderCount: 0, saleCny: 0 };
    const newFindings = [];

    for (const store of stores) {
      const { all, today } = await fetchStorePostings(store);
      if (all.length === 0) continue;

      let known = knownPostingsByStore.get(store.id);
      if (!known) {
        known = loadKnownPostingsFromDb(store.company_id);
        knownPostingsByStore.set(store.id, known);
      }
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

      // 聚合今日统计(不论新发现与否,只要 in_process_at 是今天)
      const sellerId = Number(store.company_id);
      let agg = todayBySeller.get(sellerId);
      if (!agg) {
        agg = { storeName: store.name, sellerId, orderCount: 0, saleCny: 0 };
        todayBySeller.set(sellerId, agg);
      }
      for (const p of today) {
        agg.orderCount++;
        agg.saleCny += extractSaleAmountCny(p);
      }
      todayTotal.orderCount += today.length;
      todayTotal.saleCny += today.reduce((s, p) => s + extractSaleAmountCny(p), 0);

      if (newPostings.length > 0) {
        logger.info(
          { storeId: store.id, storeName: store.name, newCount: newPostings.length, total: all.length, todayCount: today.length },
          'unfulfilled-poller: 发现新货件',
        );
      }
    }

    // 推送飞书:每条新货件单独推送,带当日全店汇总
    if (newFindings.length > 0) {
      // 构造当日汇总文本(只算一次,所有新货件通知复用)
      const todayLines = buildTodaySummaryLines(todayBySeller, todayTotal);
      for (const { store, posting } of newFindings) {
        await notifyNewPostingDiscovered(store, posting, todayLines).catch(err =>
          logger.warn({ err: err.message, postingNumber: posting.posting_number }, 'unfulfilled-poller: 飞书通知失败'),
        );
      }
      logger.info({ totalNew: newFindings.length, todayTotal }, 'unfulfilled-poller: 本轮新货件通知已发送');
    } else {
      logger.info(
        { todayTotal, todayBySeller: Array.from(todayBySeller.values()) },
        'unfulfilled-poller: 本轮无新货件(汇总仍统计)',
      );
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

/**
 * 构造"当日各店铺销售汇总"文本块
 * 金额直接显示 CNY(OPI 返回的金额本身就是人民币,无需换算)
 * 订单数前导空格对齐到 2 位,金额整数部分前导空格对齐到 4 位(小数固定 2 位)
 * @param {Map<number, {storeName, sellerId, orderCount, saleCny}>} bySeller
 * @param {{orderCount, saleCny}} total
 * @returns {string}
 */
function buildTodaySummaryLines(bySeller, total) {
  // 订单数最多2位,前导空格对齐:" 1" / "10"
  const padOrder = (n) => String(n).padStart(2, ' ');
  // 金额整数部分最多4位,前导空格对齐,小数固定2位:"  25.00" / "1000.00"
  const padAmount = (cny) => {
    const fixed = Number(cny).toFixed(2);
    const [intPart, decPart] = fixed.split('.');
    return `${intPart.padStart(4, ' ')}.${decPart}`;
  };
  const lines = [];
  lines.push('—— 当日各店铺销售汇总(Asia/Shanghai)——');
  const sorted = Array.from(bySeller.values()).sort((a, b) => a.sellerId - b.sellerId);
  for (const it of sorted) {
    lines.push(`• ${it.storeName}: 订单 ${padOrder(it.orderCount)} 单 / 销售金额 ${padAmount(it.saleCny)} CNY`);
  }
  lines.push(`合计:订单 ${padOrder(total.orderCount)} 单 / 销售金额 ${padAmount(total.saleCny)} CNY`);
  return lines.join('\n');
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
