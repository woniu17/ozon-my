// 采购物流补全轮询器(2026-09-16,每小时)
// 背景:1688 采购单在"未发货"状态关联入库时拿不到物流信息(API 对未发货单返回空),
//   且弹窗导入(模式A/B)的单不在妙手同步覆盖范围内,物流字段会一直空着。
// 职责(仅 1688 官方 API 可查的平台,4 个账号 token):
//   阶段A 补物流单号:扫"有单号+无物流+未取消+90天内"的 1688 采购单 → getLogisticsInfos 回填单号+公司
//     (未发货单返回空单号,静默跳过,下轮再试)
//   阶段B 拉完整轨迹:扫"有物流单号+未签收+轨迹超1小时未更新"的 1688 采购单 → getLogisticsTraceInfo.buyerView
//     写 trace_json(完整节点)+ last_trace_at/last_trace_desc(最新节点,与妙手口径一致)
//   妙手同步的采购单轨迹仍由妙手侧更新;本轮询器同字段写入,双路并存最新覆盖。
// 限速:请求间隔 2s,连续失败 3 次中止本轮(防触发反爬/雪崩);单轮每阶段上限 100 单。
import { db } from '../db/index.js';
import { getLogisticsForOrder, getTraceForOrder, hasAliOpenApiToken } from './platform-orders/adapters/ali1688-openapi.js';
import logger from '../middleware/log.js';

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 每小时
const FIRST_SCAN_DELAY_MS = 30 * 1000;
const REQUEST_INTERVAL_MS = 2000; // 对齐补全采购信息的限速节奏
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PER_ROUND = 100;
const MAX_AGE_DAYS = 90; // 超过 90 天的旧单不再尝试(多半已死单)

let timer = null;
let running = false;

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

  let filled = 0, skippedNoAccount = 0, consecutive = 0;
  for (const r of rows) {
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

  let updated = 0, skippedNoAccount = 0, consecutive = 0;
  for (const r of rows) {
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

async function runOnce() {
  const a = await phaseFillLogistics();
  const b = await phaseFetchTrace();
  logger.info({ phaseA: a, phaseB: b }, '[purchase-logistics-poller] 本轮完成');
}

function startPurchaseLogisticsPoller() {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runOnce().catch((e) => logger.error({ err: e.message }, '[purchase-logistics-poller] 轮询异常'))
      .finally(() => { running = false; });
  }, POLL_INTERVAL_MS);
  setTimeout(() => {
    running = true;
    runOnce().catch((e) => logger.error({ err: e.message }, '[purchase-logistics-poller] 首轮异常'))
      .finally(() => { running = false; });
  }, FIRST_SCAN_DELAY_MS);
  logger.info('[purchase-logistics-poller] 启动(每小时:补物流单号+拉完整轨迹)');
}

function stopPurchaseLogisticsPoller() {
  if (timer) { clearInterval(timer); timer = null; }
}

export { startPurchaseLogisticsPoller, stopPurchaseLogisticsPoller };
