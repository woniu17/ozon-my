// 采购物流补全轮询器(2026-09-16;2026-09-17 起每 12 小时,降低 1688 API 配额消耗)
// 背景:1688 采购单在"未发货"状态关联入库时拿不到物流信息(API 对未发货单返回空),
//   且弹窗导入(模式A/B)的单不在妙手同步覆盖范围内,物流字段会一直空着。
// 职责:
//   阶段A 补物流单号(1688 官方 API):扫"有单号+无物流+未取消+90天内"的 1688 采购单
//     → getLogisticsInfos 回填单号+公司(未发货单返回空单号,静默跳过,下轮再试)
//   阶段A-PDD 补物流单号(拼多多,浏览器):同条件扫 yangkeduo 采购单 → 按单号
//     精确搜索(order_list_search_v4),发货单自带 tracking_number 回填;
//     单号回填后同轮的阶段C 即可拉到轨迹
//   阶段B 拉完整轨迹(1688 官方 API):扫"有物流单号+未签收+轨迹超1小时未更新"的 1688 采购单
//     → getLogisticsTraceInfo.buyerView 写 trace_json(完整节点)+ last_trace_at/last_trace_desc(与妙手口径一致)
//   阶段C 拉完整轨迹(拼多多,浏览器):同阶段B 扫描条件的 yangkeduo 采购单 → goods_express
//     SSR 数据岛直读(裸 fetch 需 antiContent 会 9990);顺带回填缺失的物流公司
//     (不做签收升级:shippingStatus 枚举不可靠,在途/已签收都可能为 20)
//   妙手同步的采购单轨迹仍由妙手侧更新;本轮询器同字段写入,双路并存最新覆盖。
// 限速:请求间隔 2s,连续失败 3 次中止本轮(防触发反爬/雪崩);单轮每阶段上限 100 单。
// 阶段B-TB(2026-09-22):淘宝拉轨迹(buyertrade transit_step.do,按订单号查,响应自带单号/公司)
import { db } from '../db/index.js';
import config from '../config/index.js';
import { getLogisticsForOrder, getTraceForOrder, hasAliOpenApiToken } from './platform-orders/adapters/ali1688-openapi.js';
import { getPddTrace, searchPddOrder } from './platform-orders/adapters/pdd.js';
import { getTaobaoTrace } from './platform-orders/adapters/taobao.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 12 * 60 * 60 * 1000; // 每 12 小时
const FIRST_SCAN_DELAY_MS = 30 * 1000;
const REQUEST_INTERVAL_MS = 2000; // 对齐补全采购信息的限速节奏
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PER_ROUND = 1000;
const MAX_AGE_DAYS = 90; // 超过 90 天的旧单不再尝试(多半已死单)

let timer = null;
let running = false;

// ── 手动触发与状态(前端"同步采购物流信息"按钮,2026-09-17) ──────
// 与定时轮共用 running 互斥;状态对象供前端轮询进度(3s 间隔)
const manualStatus = {
  running: false,        // 本轮进行中(定时轮或手动触发)
  startedAt: null,
  finishedAt: null,
  phase: '',             // fill-ali/fill-pdd/trace-ali/trace-pdd
  progress: { done: 0, total: 0 }, // 当前阶段进度
  result: null,          // { phaseA, phaseApdd, phaseB, phaseC }
  error: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 阶段A:补物流单号+公司(未发货单返回空单号自然跳过)
 *  2026-09-21:新增"单号变更检测"——已有单号但与 1688 最新不一致时覆盖,
 *  适用于卖家换快递/改单号的场景。为控制 API 配额,仅对"在途且最近3天未拉轨迹"的单做比对。 */
const NO_DIFF_CHECK_DAYS = 3; // 已有单号的在途单,每 3 天比对一次单号是否变更

async function phaseFillLogistics() {
  // 子阶段A1:补空单号
  const rows = db.prepare(
    `SELECT id, purchase_sn, buyer_account FROM op_purchase_order
     WHERE platform = '1688' AND link_status = 'linked'
       AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
       AND (logistics_no IS NULL OR length(logistics_no) = 0)
       AND status NOT IN ('closed')
       AND (gmt_create IS NULL OR gmt_create >= datetime('now', ?))
     LIMIT ?`
  ).all(`-${MAX_AGE_DAYS} days`, MAX_PER_ROUND);
  manualStatus.progress = { done: 0, total: rows.length };

  let filled = 0, skippedNoAccount = 0, consecutive = 0;
  for (const r of rows) {
    manualStatus.progress.done++;
    if (!hasAliOpenApiToken(r.buyer_account)) { skippedNoAccount++; continue; }
    try {
      const info = await getLogisticsForOrder(r.purchase_sn, r.buyer_account);
      if (info.logisticsNo) {
        db.prepare(
          `UPDATE op_purchase_order
           SET logistics_no = ?, logistics_company = ?,
               status = CASE WHEN status IN ('wait_send', 'wait_pay') THEN 'shipped' ELSE status END,
               gmt_modified = ?
           WHERE id = ?`
        ).run(info.logisticsNo, info.logisticsCompany, new Date().toISOString(), r.id);
        filled++;
        logger.info({ purchaseSn: r.purchase_sn, logisticsNo: info.logisticsNo, company: info.logisticsCompany },
          '[purchase-logistics-poller] 阶段A1:回填物流单号');
      }
      consecutive = 0;
    } catch (e) {
      consecutive++;
      logger.warn({ purchaseSn: r.purchase_sn, err: e.message }, '[purchase-logistics-poller] 阶段A1:单笔查询失败');
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn('[purchase-logistics-poller] 阶段A1:连续失败达阈值,本轮中止');
        break;
      }
    }
    await sleep(REQUEST_INTERVAL_MS);
  }

  // 子阶段A2:检测已有单号是否变更(卖家换快递/改单号场景)
  // 仅对"在途(未签收未关闭)+最近3天没拉过轨迹"的单做比对,控制 API 配额
  const diffRows = db.prepare(
    `SELECT id, purchase_sn, buyer_account, logistics_no AS logisticsNo FROM op_purchase_order
     WHERE platform = '1688' AND link_status = 'linked'
       AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
       AND logistics_no IS NOT NULL AND length(logistics_no) > 0
       AND status IN ('wait_send', 'shipped', 'part_shipped')
       AND (last_trace_at IS NULL OR last_trace_at < datetime('now', ?))
     LIMIT ?`
  ).all(`-${NO_DIFF_CHECK_DAYS} days`, MAX_PER_ROUND);
  let changed = 0;
  if (diffRows.length) {
    manualStatus.progress = { done: 0, total: diffRows.length };
    for (const r of diffRows) {
      manualStatus.progress.done++;
      if (!hasAliOpenApiToken(r.buyer_account)) { skippedNoAccount++; continue; }
      try {
        const info = await getLogisticsForOrder(r.purchase_sn, r.buyer_account);
        if (info.logisticsNo && info.logisticsNo !== r.logisticsNo) {
          // 单号变更:覆盖新单号+公司,重置 last_trace_at 让阶段B 立即拉新轨迹
          db.prepare(
            `UPDATE op_purchase_order
             SET logistics_no = ?, logistics_company = ?,
                 last_trace_at = NULL,
                 gmt_modified = ?
             WHERE id = ?`
          ).run(info.logisticsNo, info.logisticsCompany, new Date().toISOString(), r.id);
          changed++;
          logger.info({ purchaseSn: r.purchase_sn, oldNo: r.logisticsNo, newNo: info.logisticsNo, company: info.logisticsCompany },
            '[purchase-logistics-poller] 阶段A2:检测到单号变更,已覆盖');
        }
        consecutive = 0;
      } catch (e) {
        consecutive++;
        logger.warn({ purchaseSn: r.purchase_sn, err: e.message }, '[purchase-logistics-poller] 阶段A2:单笔查询失败');
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
          logger.warn('[purchase-logistics-poller] 阶段A2:连续失败达阈值,本轮中止');
          break;
        }
      }
      await sleep(REQUEST_INTERVAL_MS);
    }
  }

  return { scanned: rows.length, filled, changed, skippedNoAccount };
}

/** 阶段A-PDD:补拼多多物流单号(order_list_search_v4 按单号精确搜索,发货单自带 tracking_number)
 *  PDD 采购单在关联入库时若尚未发货则无单号,平台发货后靠本阶段回填;
 *  单号回填后同轮的阶段C(trace-pdd)即可拉到轨迹(扫描条件含 logistics_no 非空) */
async function phaseFillPddLogistics() {
  const rows = db.prepare(
    `SELECT id, purchase_sn, buyer_account FROM op_purchase_order
     WHERE platform = 'yangkeduo' AND link_status = 'linked'
       AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
       AND (logistics_no IS NULL OR length(logistics_no) = 0)
       AND status NOT IN ('closed')
       AND (gmt_create IS NULL OR gmt_create >= datetime('now', ?))
     ORDER BY gmt_create DESC
     LIMIT ?`
  ).all(`-${MAX_AGE_DAYS} days`, MAX_PER_ROUND);
  if (!rows.length) return { scanned: 0, filled: 0, skippedNoAccount: 0 };
  manualStatus.progress = { done: 0, total: rows.length };

  const pddAccounts = config.platformAccounts.pdd || [];
  let filled = 0, skippedNoAccount = 0, consecutive = 0;
  for (const r of rows) {
    manualStatus.progress.done++;
    const account = pddAccounts.includes(r.buyer_account) ? r.buyer_account : pddAccounts[0];
    if (!account) { skippedNoAccount++; continue; }
    try {
      const r2 = await searchPddOrder(r.purchase_sn, [account]);
      const order = r2 && r2.result;
      if (order && order.trackingNumber) {
        db.prepare(
          `UPDATE op_purchase_order
           SET logistics_no = ?,
               status = CASE WHEN status IN ('wait_send', 'wait_pay') THEN 'shipped' ELSE status END,
               gmt_modified = ?
           WHERE id = ?`
        ).run(order.trackingNumber, new Date().toISOString(), r.id);
        filled++;
        logger.info({ purchaseSn: r.purchase_sn, logisticsNo: order.trackingNumber },
          '[purchase-logistics-poller] 阶段A-PDD:回填物流单号');
      }
      // 未发货(单里无单号)静默跳过,下轮再试
      consecutive = 0;
    } catch (e) {
      consecutive++;
      logger.warn({ purchaseSn: r.purchase_sn, err: e.message }, '[purchase-logistics-poller] 阶段A-PDD:单笔搜索失败');
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn('[purchase-logistics-poller] 阶段A-PDD:连续失败达阈值,本轮中止');
        break;
      }
    }
    await sleep(REQUEST_INTERVAL_MS);
  }
  return { scanned: rows.length, filled, skippedNoAccount };
}

/** 阶段B:拉完整物流轨迹(有单号+1小时内没拉过的)
 *  2026-09-21:放宽 status 条件,已签收单(last_trace_at IS NULL,即被阶段A2 重置)也会被扫到,
 *  确保单号变更后新轨迹能及时写入。 */
async function phaseFetchTrace() {
  const rows = db.prepare(
    `SELECT id, purchase_sn, buyer_account FROM op_purchase_order
     WHERE platform = '1688' AND link_status = 'linked'
       AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
       AND logistics_no IS NOT NULL AND length(logistics_no) > 0
       AND (
         (status IN ('wait_send', 'shipped', 'part_shipped')
          AND (last_trace_at IS NULL OR last_trace_at < datetime('now', 'localtime', '-1 hour')))
         OR
         (status = 'signed' AND last_trace_at IS NULL)
       )
     ORDER BY (last_trace_at IS NULL) DESC, gmt_modified DESC
     LIMIT ?`
  ).all(MAX_PER_ROUND);
  if (!rows.length) return { scanned: 0, updated: 0, skippedNoAccount: 0 };
  manualStatus.progress = { done: 0, total: rows.length };

  let updated = 0, skippedNoAccount = 0, consecutive = 0;
  for (const r of rows) {
    manualStatus.progress.done++;
    if (!hasAliOpenApiToken(r.buyer_account)) { skippedNoAccount++; continue; }
    try {
      const { steps } = await getTraceForOrder(r.purchase_sn, r.buyer_account);
      if (steps.length) {
        const latest = steps[0];
        db.prepare(
          `UPDATE op_purchase_order
           SET trace_json = ?, last_trace_at = ?, last_trace_desc = ?, gmt_modified = ?
           WHERE id = ?`
        ).run(JSON.stringify(steps), latest.acceptTime || null, String(latest.remark || '').slice(0, 500), new Date().toISOString(), r.id);
        updated++;
      } else {
        // 无轨迹(刚发货未揽收/老单轨迹过期):推进 last_trace_at(空格时间格式,与比较口径一致)避免 hourly 空转
        db.prepare(`UPDATE op_purchase_order SET last_trace_at = datetime('now', 'localtime') WHERE id = ?`).run(r.id);
      }
      consecutive = 0;
    } catch (e) {
      consecutive++;
      logger.warn({ purchaseSn: r.purchase_sn, err: e.message }, '[purchase-logistics-poller] 阶段B:轨迹查询失败');
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn('[purchase-logistics-poller] 阶段B:连续失败达阈值,本轮中止');
        break;
      }
    }
    await sleep(REQUEST_INTERVAL_MS);
  }
  return { scanned: rows.length, updated, skippedNoAccount };
}

/** 阶段C:拼多多拉完整轨迹(浏览器 goods_express SSR;有单号+未签收+1小时内没拉过的)
 *  与阶段B 同口径(trace_json/last_trace_at/last_trace_desc);物流公司缺失时回填 shippingName。
 *  不做签收升级:traceData.shippingStatus 枚举不可靠(实测在途/已签收都可能为 20),
 *  是否签收以轨迹节点文本为准(前端展开可见) */
async function phaseFetchPddTrace() {
  const rows = db.prepare(
    `SELECT id, purchase_sn, logistics_no, buyer_account FROM op_purchase_order
     WHERE platform = 'yangkeduo' AND link_status = 'linked'
       AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
       AND logistics_no IS NOT NULL AND length(logistics_no) > 0
       AND status IN ('wait_send', 'shipped', 'part_shipped')
       AND (last_trace_at IS NULL OR last_trace_at < datetime('now', 'localtime', '-1 hour'))
     ORDER BY (last_trace_at IS NULL) DESC, gmt_modified DESC
     LIMIT ?`
  ).all(MAX_PER_ROUND);
  if (!rows.length) return { scanned: 0, updated: 0, skippedNoAccount: 0 };
  manualStatus.progress = { done: 0, total: rows.length };

  // PDD 账号解析:buyer_account 不在白名单(空/历史脏值)时回落主账号
  const pddAccounts = config.platformAccounts.pdd || [];
  let updated = 0, skippedNoAccount = 0, consecutive = 0;
  for (const r of rows) {
    manualStatus.progress.done++;
    const account = pddAccounts.includes(r.buyer_account) ? r.buyer_account : pddAccounts[0];
    if (!account) { skippedNoAccount++; continue; }
    try {
      const { steps, shippingName } = await getPddTrace(r.purchase_sn, r.logistics_no, account);
      if (steps.length) {
        const latest = steps[0];
        db.prepare(
          `UPDATE op_purchase_order
           SET trace_json = ?, last_trace_at = ?, last_trace_desc = ?,
               logistics_company = CASE WHEN (logistics_company IS NULL OR logistics_company = '') AND ? != ''
                                        THEN ? ELSE logistics_company END,
               gmt_modified = ?
           WHERE id = ?`
        ).run(
          JSON.stringify(steps), latest.acceptTime || null, String(latest.remark || '').slice(0, 500),
          shippingName || '', shippingName || '',
          new Date().toISOString(), r.id
        );
        updated++;
        logger.info({ purchaseSn: r.purchase_sn, steps: steps.length, shippingName },
          '[purchase-logistics-poller] 阶段C:拉取PDD轨迹');
      } else {
        // 无轨迹(刚发货未揽收/老单):推进 last_trace_at 避免空转
        db.prepare(`UPDATE op_purchase_order SET last_trace_at = datetime('now', 'localtime') WHERE id = ?`).run(r.id);
      }
      consecutive = 0;
    } catch (e) {
      consecutive++;
      logger.warn({ purchaseSn: r.purchase_sn, err: e.message }, '[purchase-logistics-poller] 阶段C:轨迹查询失败');
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn('[purchase-logistics-poller] 阶段C:连续失败达阈值,本轮中止');
        break;
      }
    }
    await sleep(REQUEST_INTERVAL_MS);
  }
  return { scanned: rows.length, updated, skippedNoAccount };
}

/** 阶段B-TB(2026-09-22):淘宝拉完整轨迹(buyertrade transit_step.do)
 *  接口按订单号查询,无需先有快递单号;轨迹响应自带 expressId(快递单号)/expressName(公司),一并回填。
 *  未发货/未揽收返回空轨迹 → 推进 last_trace_at 避免空转。
 *  不做签收升级:是否签收以轨迹节点文本为准(与 PDD 口径一致,前端展开可见) */
async function phaseFetchTaobaoTrace() {
  const rows = db.prepare(
    `SELECT id, purchase_sn, logistics_no, buyer_account FROM op_purchase_order
     WHERE platform = 'taobao' AND link_status = 'linked'
       AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
       AND status IN ('wait_send', 'shipped', 'part_shipped')
       AND (last_trace_at IS NULL OR last_trace_at < datetime('now', 'localtime', '-1 hour'))
     ORDER BY (last_trace_at IS NULL) DESC, gmt_modified DESC
     LIMIT ?`
  ).all(MAX_PER_ROUND);
  if (!rows.length) return { scanned: 0, updated: 0, skippedNoAccount: 0 };
  manualStatus.progress = { done: 0, total: rows.length };

  const taobaoAccounts = config.platformAccounts.taobao || [];
  let updated = 0, skippedNoAccount = 0, consecutive = 0;
  for (const r of rows) {
    manualStatus.progress.done++;
    const account = taobaoAccounts.includes(r.buyer_account) ? r.buyer_account : taobaoAccounts[0];
    if (!account) { skippedNoAccount++; continue; }
    try {
      const { steps, shippingName, expressId } = await getTaobaoTrace(r.purchase_sn, account);
      // 轨迹响应自带快递单号:缺失时回填(顺带 wait_send → shipped)
      if (expressId && !r.logistics_no) {
        writeFilledLogisticsNo(r.id, expressId, shippingName);
      }
      if (steps.length) {
        writeTraceRow(r.id, steps, shippingName);
        updated++;
        logger.info({ purchaseSn: r.purchase_sn, steps: steps.length, shippingName, expressId },
          '[purchase-logistics-poller] 阶段B-TB:拉取淘宝轨迹');
      } else {
        // 无轨迹(未发货/未揽收):推进 last_trace_at 避免空转
        db.prepare(`UPDATE op_purchase_order SET last_trace_at = datetime('now', 'localtime') WHERE id = ?`).run(r.id);
      }
      consecutive = 0;
    } catch (e) {
      consecutive++;
      logger.warn({ purchaseSn: r.purchase_sn, err: e.message }, '[purchase-logistics-poller] 阶段B-TB:轨迹查询失败');
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn('[purchase-logistics-poller] 阶段B-TB:连续失败达阈值,本轮中止');
        break;
      }
    }
    await sleep(REQUEST_INTERVAL_MS);
  }
  return { scanned: rows.length, updated, skippedNoAccount };
}

async function runOnce() {
  manualStatus.phase = 'fill-ali';
  const a = await phaseFillLogistics();
  manualStatus.phase = 'fill-pdd';
  const ap = await phaseFillPddLogistics();
  manualStatus.phase = 'trace-ali';
  const b = await phaseFetchTrace();
  manualStatus.phase = 'trace-pdd';
  const c = await phaseFetchPddTrace();
  manualStatus.phase = 'trace-tb';
  const tb = await phaseFetchTaobaoTrace();
  const result = { phaseA: a, phaseApdd: ap, phaseB: b, phaseC: c, phaseTb: tb };
  logger.info(result, '[purchase-logistics-poller] 本轮完成');
  return result;
}

// ── 手动触发入口(launchRound/trigger/status,2026-09-17) ──────

/** 启动一轮(定时/手动共用 running 互斥);已在跑返回 false */
function launchRound() {
  if (running) return false;
  running = true;
  writeLastRunAt(new Date()); // 记录执行时刻(定时/手动均记),重启后不足周期不重跑
  manualStatus.running = true;
  manualStatus.startedAt = new Date().toISOString();
  manualStatus.finishedAt = null;
  manualStatus.result = null;
  manualStatus.error = null;
  manualStatus.progress = { done: 0, total: 0 };
  runOnce()
    .then((r) => { manualStatus.result = r; })
    .catch((e) => {
      manualStatus.error = String(e.message || e);
      logger.error({ err: manualStatus.error }, '[purchase-logistics-poller] 轮询异常');
    })
    .finally(() => {
      manualStatus.running = false;
      manualStatus.phase = '';
      manualStatus.finishedAt = new Date().toISOString();
      running = false;
    });
  return true;
}

/** 手动触发一轮(前端按钮);已在跑(定时或手动)返回 started:false */
function triggerPurchaseLogisticsSync() {
  const started = launchRound();
  return { started, status: getPurchaseLogisticsStatus() };
}

/** 轮询进度查询 */
function getPurchaseLogisticsStatus() {
  return { ...manualStatus, progress: { ...manualStatus.progress } };
}

// ── 执行时间持久化(app_config,2026-09-17):记住上次执行时刻,
//    服务重启后不足一个周期不重跑,只等剩余时间,避免 pm2 restart/部署即扫一轮──
const STATE_KEY = 'purchase_logistics_last_run_at';

function readLastRunAt() {
  try {
    const row = db.prepare(`SELECT value FROM app_config WHERE key = ?`).get(STATE_KEY);
    if (!row) return null;
    const at = new Date(JSON.parse(row.value).at);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch { return null; }
}

function writeLastRunAt(d) {
  try {
    db.prepare(
      `INSERT INTO app_config (key, value, scope, description, updated_at)
       VALUES (?, ?, 'erp', '采购物流轮询器上次执行时间(重启后不足周期不重跑)', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = datetime('now')`
    ).run(STATE_KEY, JSON.stringify({ at: d.toISOString() }));
  } catch (e) {
    logger.warn({ err: e.message }, '[purchase-logistics-poller] 记录执行时间失败(不影响本轮)');
  }
}

function startPurchaseLogisticsPoller() {
  if (timer) return;
  const last = readLastRunAt();
  const elapsed = last ? Date.now() - last.getTime() : Infinity;
  const firstDelay = elapsed >= POLL_INTERVAL_MS
    ? FIRST_SCAN_DELAY_MS
    : POLL_INTERVAL_MS - elapsed;
  timer = setInterval(() => { launchRound(); }, POLL_INTERVAL_MS);
  setTimeout(() => { launchRound(); }, firstDelay);
  logger.info(last
    ? { lastRunAt: last.toISOString(), nextRunInMin: Math.round(firstDelay / 60000) }
    : {},
    `[purchase-logistics-poller] 启动(每 12 小时:补物流单号+拉完整轨迹;${last ? '距上次执行不足周期,等待剩余时间' : '无执行记录,30秒后首轮'})`);
}

function stopPurchaseLogisticsPoller() {
  if (timer) { clearInterval(timer); timer = null; }
}

// ── 单包裹同步采购物流(列表行"同步采购物流"按钮,2026-09-17)──────────
// 范围:该包裹全部关联采购单(linked);强制刷新:不受 last_trace_at 1小时窗口/90天年龄限制
// 与定时轮不互斥:浏览器操作经 withPage SerialQueue 天然串行,写入幂等(同字段最新覆盖)

/** 轨迹落库(trace_json/last_trace_at/last_trace_desc;shippingName 非空时回填缺失公司名)
 *  无轨迹节点时仅推进 last_trace_at 避免定时轮空转;返回 toast 友好的结果描述 */
function writeTraceRow(id, steps, shippingName = '') {
  if (!steps.length) {
    db.prepare(`UPDATE op_purchase_order SET last_trace_at = datetime('now', 'localtime') WHERE id = ?`).run(id);
    return '暂无轨迹(未揽收)';
  }
  const latest = steps[0];
  db.prepare(
    `UPDATE op_purchase_order
     SET trace_json = ?, last_trace_at = ?, last_trace_desc = ?,
         logistics_company = CASE WHEN ? != '' AND (logistics_company IS NULL OR logistics_company = '')
                                  THEN ? ELSE logistics_company END,
         gmt_modified = ?
     WHERE id = ?`
  ).run(
    JSON.stringify(steps), latest.acceptTime || null, String(latest.remark || '').slice(0, 500),
    shippingName || '', shippingName || '',
    new Date().toISOString(), id
  );
  return `轨迹${steps.length}条`;
}

/** 补物流单号落库(回填单号/公司,wait_send/wait_pay 升级 shipped);返回是否补到 */
function writeFilledLogisticsNo(id, logisticsNo, logisticsCompany) {
  db.prepare(
    `UPDATE op_purchase_order
     SET logistics_no = ?, logistics_company = ?,
         status = CASE WHEN status IN ('wait_send', 'wait_pay') THEN 'shipped' ELSE status END,
         gmt_modified = ?
     WHERE id = ?`
  ).run(logisticsNo, logisticsCompany || null, new Date().toISOString(), id);
}

/** 单包裹同步采购物流
 *  1688:补单号(缺时 getLogisticsForOrder)→ 拉轨迹(getTraceForOrder)
 *  拼多多:补单号(缺时 searchPddOrder)→ 拉轨迹(getPddTrace,顺带回填缺失公司名)
 *  淘宝(2026-09-22):拉轨迹(getTaobaoTrace,按订单号查,顺带回填缺失单号/公司名)
 *  其他平台/手工单:暂无可用接口,计入 skip
 *  @returns {{ orders: number, results: Array<{purchaseSn, platform, action, detail}> }} */
async function syncPurchaseLogisticsForPackage(packageId) {
  const orders = db.prepare(
    `SELECT po.id, po.purchase_sn AS purchaseSn, po.platform, po.buyer_account AS buyerAccount,
            po.logistics_no AS logisticsNo, po.status
     FROM op_purchase_link pl
     JOIN op_purchase_order po ON po.id = pl.purchase_order_id
     WHERE pl.package_id = ? AND po.link_status = 'linked'
     ORDER BY po.id`
  ).all(packageId);
  if (!orders.length) return { orders: 0, results: [] };

  const pddAccounts = config.platformAccounts.pdd || [];
  const taobaoAccounts = config.platformAccounts.taobao || [];
  const results = [];
  for (const o of orders) {
    if (!o.purchaseSn) {
      results.push({ purchaseSn: '', platform: o.platform, action: 'skip', detail: '手工单无采购单号' });
      continue;
    }
    if (o.status === 'closed') {
      results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'skip', detail: '采购单已取消' });
      continue;
    }
    try {
      let filled = false;
      if (o.platform === '1688') {
        if (!hasAliOpenApiToken(o.buyerAccount)) {
          results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'skip', detail: '买手账号未配置1688开放接口' });
          continue;
        }
        // 手动同步时总是先查 1688 最新单号:无则补,有则比对是否变更(卖家换快递场景)
        const info = await getLogisticsForOrder(o.purchaseSn, o.buyerAccount);
        if (info.logisticsNo) {
          if (!o.logisticsNo) {
            writeFilledLogisticsNo(o.id, info.logisticsNo, info.logisticsCompany);
            o.logisticsNo = info.logisticsNo;
            filled = true;
          } else if (info.logisticsNo !== o.logisticsNo) {
            // 单号变更:覆盖新单号+公司,后续拉新单号的轨迹
            db.prepare(
              `UPDATE op_purchase_order SET logistics_no = ?, logistics_company = ?, gmt_modified = ? WHERE id = ?`
            ).run(info.logisticsNo, info.logisticsCompany, new Date().toISOString(), o.id);
            results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'update',
              detail: `单号变更 ${o.logisticsNo} → ${info.logisticsNo}` });
            o.logisticsNo = info.logisticsNo;
            filled = true;
          }
        }
        if (!o.logisticsNo) {
          results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'fill', detail: '暂无物流单号(可能未发货)' });
        } else {
          const { steps } = await getTraceForOrder(o.purchaseSn, o.buyerAccount);
          results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'trace', detail: (filled ? '已补单号,' : '') + writeTraceRow(o.id, steps) });
        }
      } else if (o.platform === 'yangkeduo') {
        const account = pddAccounts.includes(o.buyerAccount) ? o.buyerAccount : pddAccounts[0];
        if (!account) {
          results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'skip', detail: '未配置拼多多账号' });
          continue;
        }
        if (!o.logisticsNo) {
          const r2 = await searchPddOrder(o.purchaseSn, [account]);
          const order = r2 && r2.result;
          if (order && order.trackingNumber) {
            writeFilledLogisticsNo(o.id, order.trackingNumber, '');
            o.logisticsNo = order.trackingNumber;
            filled = true;
          }
        }
        if (!o.logisticsNo) {
          results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'fill', detail: '暂无物流单号(可能未发货)' });
        } else {
          const { steps, shippingName } = await getPddTrace(o.purchaseSn, o.logisticsNo, account);
          results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'trace', detail: (filled ? '已补单号,' : '') + writeTraceRow(o.id, steps, shippingName) });
        }
      } else if (o.platform === 'taobao') {
        // 淘宝(2026-09-22):transit_step 按订单号查询,无需先有快递单号;
        // 轨迹响应自带 expressId(单号)/expressName(公司),一并回填
        const account = taobaoAccounts.includes(o.buyerAccount) ? o.buyerAccount : taobaoAccounts[0];
        if (!account) {
          results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'skip', detail: '未配置淘宝账号' });
          continue;
        }
        const { steps, shippingName, expressId } = await getTaobaoTrace(o.purchaseSn, account);
        if (expressId && !o.logisticsNo) {
          writeFilledLogisticsNo(o.id, expressId, shippingName);
          o.logisticsNo = expressId;
          filled = true;
        }
        results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'trace', detail: (filled ? '已补单号,' : '') + writeTraceRow(o.id, steps, shippingName) });
      } else {
        results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'skip', detail: '该平台暂不支持物流同步' });
      }
    } catch (e) {
      results.push({ purchaseSn: o.purchaseSn, platform: o.platform, action: 'error', detail: String(e.message || e).slice(0, 60) });
    }
    await sleep(REQUEST_INTERVAL_MS);
  }
  return { orders: orders.length, results };
}

export { startPurchaseLogisticsPoller, stopPurchaseLogisticsPoller, triggerPurchaseLogisticsSync, getPurchaseLogisticsStatus, syncPurchaseLogisticsForPackage };
