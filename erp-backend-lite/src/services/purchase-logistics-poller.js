// 采购物流补全轮询器(2026-09-16,每小时)
// 背景:1688 采购单在"未发货"状态关联入库时拿不到物流信息(API 对未发货单返回空),
//   且弹窗导入(模式A/B)的单不在妙手同步覆盖范围内,物流字段会一直空着。
// 职责:
//   阶段A 补物流单号(1688 官方 API):扫"有单号+无物流+未取消+90天内"的 1688 采购单
//     → getLogisticsInfos 回填单号+公司(未发货单返回空单号,静默跳过,下轮再试)
//   阶段B 拉完整轨迹(1688 官方 API):扫"有物流单号+未签收+轨迹超1小时未更新"的 1688 采购单
//     → getLogisticsTraceInfo.buyerView 写 trace_json(完整节点)+ last_trace_at/last_trace_desc(与妙手口径一致)
//   阶段C 拉完整轨迹(拼多多,浏览器):同阶段B 扫描条件的 yangkeduo 采购单 → goods_express
//     SSR 数据岛直读(裸 fetch 需 antiContent 会 9990);顺带回填缺失的物流公司,
//     shippingStatus=20(已签收)时升级本地 status='signed'
//   妙手同步的采购单轨迹仍由妙手侧更新;本轮询器同字段写入,双路并存最新覆盖。
// 限速:请求间隔 2s,连续失败 3 次中止本轮(防触发反爬/雪崩);单轮每阶段上限 100 单。
import { db } from '../db/index.js';
import config from '../config/index.js';
import { getLogisticsForOrder, getTraceForOrder, hasAliOpenApiToken } from './platform-orders/adapters/ali1688-openapi.js';
import { getPddTrace } from './platform-orders/adapters/pdd.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 每小时
const FIRST_SCAN_DELAY_MS = 30 * 1000;
const REQUEST_INTERVAL_MS = 2000; // 对齐补全采购信息的限速节奏
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PER_ROUND = 100;
const MAX_AGE_DAYS = 90; // 超过 90 天的旧单不再尝试(多半已死单)

let timer = null;
let running = false;

// ── 手动触发与状态(前端"同步采购物流信息"按钮,2026-09-17) ──────
// 与定时轮共用 running 互斥;状态对象供前端轮询进度(3s 间隔)
const manualStatus = {
  running: false,        // 本轮进行中(定时轮或手动触发)
  startedAt: null,
  finishedAt: null,
  phase: '',             // A=补单号 B=1688轨迹 C=PDD轨迹
  progress: { done: 0, total: 0 }, // 当前阶段进度
  result: null,          // { phaseA, phaseB, phaseC }
  error: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 阶段A:补物流单号+公司(未发货单返回空单号自然跳过) */
async function phaseFillLogistics() {
  const rows = db.prepare(
    `SELECT id, purchase_sn, buyer_account FROM op_purchase_order
     WHERE platform = '1688' AND link_status = 'linked'
       AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
       AND (logistics_no IS NULL OR length(logistics_no) = 0)
       AND status NOT IN ('closed')
       AND (gmt_create IS NULL OR gmt_create >= datetime('now', ?))
     LIMIT ?`
  ).all(`-${MAX_AGE_DAYS} days`, MAX_PER_ROUND);
  if (!rows.length) return { scanned: 0, filled: 0, skippedNoAccount: 0 };
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
          '[purchase-logistics-poller] 阶段A:回填物流单号');
      }
      consecutive = 0;
    } catch (e) {
      consecutive++;
      logger.warn({ purchaseSn: r.purchase_sn, err: e.message }, '[purchase-logistics-poller] 阶段A:单笔查询失败');
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
        logger.warn('[purchase-logistics-poller] 阶段A:连续失败达阈值,本轮中止');
        break;
      }
    }
    await sleep(REQUEST_INTERVAL_MS);
  }
  return { scanned: rows.length, filled, skippedNoAccount };
}

/** 阶段B:拉完整物流轨迹(有单号+未签收+1小时内没拉过的) */
async function phaseFetchTrace() {
  const rows = db.prepare(
    `SELECT id, purchase_sn, buyer_account FROM op_purchase_order
     WHERE platform = '1688' AND link_status = 'linked'
       AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
       AND logistics_no IS NOT NULL AND length(logistics_no) > 0
       AND status IN ('wait_send', 'shipped', 'part_shipped')
       AND (last_trace_at IS NULL OR last_trace_at < datetime('now', 'localtime', '-1 hour'))
     ORDER BY (last_trace_at IS NULL) DESC, last_trace_at ASC
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
 *  与阶段B 同口径(trace_json/last_trace_at/last_trace_desc);额外:
 *  物流公司缺失时回填 shippingName,shippingStatus=20 时升级 status='signed'(已签收) */
async function phaseFetchPddTrace() {
  const rows = db.prepare(
    `SELECT id, purchase_sn, logistics_no, buyer_account FROM op_purchase_order
     WHERE platform = 'yangkeduo' AND link_status = 'linked'
       AND purchase_sn IS NOT NULL AND length(purchase_sn) > 0
       AND logistics_no IS NOT NULL AND length(logistics_no) > 0
       AND status IN ('wait_send', 'shipped', 'part_shipped')
       AND (last_trace_at IS NULL OR last_trace_at < datetime('now', 'localtime', '-1 hour'))
     ORDER BY (last_trace_at IS NULL) DESC, last_trace_at ASC
     LIMIT ?`
  ).all(MAX_PER_ROUND);
  if (!rows.length) return { scanned: 0, updated: 0, signed: 0, skippedNoAccount: 0 };
  manualStatus.progress = { done: 0, total: rows.length };

  // PDD 账号解析:buyer_account 不在白名单(空/历史脏值)时回落主账号
  const pddAccounts = config.platformAccounts.pdd || [];
  let updated = 0, signedCount = 0, skippedNoAccount = 0, consecutive = 0;
  for (const r of rows) {
    manualStatus.progress.done++;
    const account = pddAccounts.includes(r.buyer_account) ? r.buyer_account : pddAccounts[0];
    if (!account) { skippedNoAccount++; continue; }
    try {
      const { steps, shippingName, raw } = await getPddTrace(r.purchase_sn, r.logistics_no, account);
      if (steps.length) {
        const latest = steps[0];
        const isSigned = raw && raw.shipping && raw.shipping.shippingStatus === 20;
        db.prepare(
          `UPDATE op_purchase_order
           SET trace_json = ?, last_trace_at = ?, last_trace_desc = ?,
               logistics_company = CASE WHEN (logistics_company IS NULL OR logistics_company = '') AND ? != ''
                                        THEN ? ELSE logistics_company END,
               status = CASE WHEN ? THEN 'signed' ELSE status END,
               gmt_modified = ?
           WHERE id = ?`
        ).run(
          JSON.stringify(steps), latest.acceptTime || null, String(latest.remark || '').slice(0, 500),
          shippingName || '', shippingName || '',
          isSigned ? 1 : 0, new Date().toISOString(), r.id
        );
        updated++;
        if (isSigned) signedCount++;
        logger.info({ purchaseSn: r.purchase_sn, steps: steps.length, shippingName, signed: !!isSigned },
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
  return { scanned: rows.length, updated, signed: signedCount, skippedNoAccount };
}

async function runOnce() {
  manualStatus.phase = 'A';
  const a = await phaseFillLogistics();
  manualStatus.phase = 'B';
  const b = await phaseFetchTrace();
  manualStatus.phase = 'C';
  const c = await phaseFetchPddTrace();
  const result = { phaseA: a, phaseB: b, phaseC: c };
  logger.info(result, '[purchase-logistics-poller] 本轮完成');
  return result;
}

// ── 手动触发入口(launchRound/trigger/status,2026-09-17) ──────

/** 启动一轮(定时/手动共用 running 互斥);已在跑返回 false */
function launchRound() {
  if (running) return false;
  running = true;
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

function startPurchaseLogisticsPoller() {
  if (timer) return;
  timer = setInterval(() => { launchRound(); }, POLL_INTERVAL_MS);
  setTimeout(() => { launchRound(); }, FIRST_SCAN_DELAY_MS);
  logger.info('[purchase-logistics-poller] 启动(每小时:补物流单号+拉完整轨迹)');
}

function stopPurchaseLogisticsPoller() {
  if (timer) { clearInterval(timer); timer = null; }
}

export { startPurchaseLogisticsPoller, stopPurchaseLogisticsPoller, triggerPurchaseLogisticsSync, getPurchaseLogisticsStatus };
