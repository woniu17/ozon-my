// 订单操作日志(2026-11):按订单(package_id/posting_number)记录全部操作,支持时间线展示与问题排查。
// 与 audit_logs(通用审计)区别:本表带 package_id/posting_number 索引,按订单聚合展示操作历史;
// 覆盖入库/打单/称重/采购/打印/发运/搁置/同步/库存修改等订单写接口 + 安卓端扫码事件。
// 写入失败只告警不影响主流程(日志是辅助设施,不能拖垮业务)。
import { db } from '../db/index.js';

const stmtInsert = db.prepare(
  `INSERT INTO op_order_log (package_id, posting_number, store_id, action, action_name, result, message, detail, source, operator, ip, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

/**
 * 写订单操作日志。
 * @param {object} p
 * @param {number|string} [p.packageId]   op_package.id
 * @param {string} [p.postingNumber]      货件号
 * @param {string} [p.storeId]            店铺 id
 * @param {string} p.action               动作英文标识(ship / purchase / camera_start ...)
 * @param {string} [p.actionName]         中文名(默认用 action)
 * @param {'success'|'failed'|'pending'|'warning'} [p.result] 结果(默认 success)
 * @param {string} [p.message]            可读描述 / 失败原因
 * @param {*} [p.detail]                  附加详情(对象自动 JSON 化,截断 2000)
 * @param {string} [p.source]             来源 web / android / system(默认 web)
 * @param {string} [p.operator]           操作人(默认 system)
 * @param {string} [p.ip]
 */
export function logOrderAction(p) {
  try {
    const packageId = p.packageId != null ? Number(p.packageId) : null;
    const detail = p.detail != null
      ? (typeof p.detail === 'string' ? p.detail : JSON.stringify(p.detail)).slice(0, 2000)
      : null;
    stmtInsert.run(
      Number.isInteger(packageId) && packageId > 0 ? packageId : null,
      p.postingNumber || null,
      p.storeId || null,
      String(p.action || 'unknown'),
      p.actionName || p.action || 'unknown',
      p.result || 'success',
      p.message || null,
      detail,
      p.source || 'web',
      p.operator || 'system',
      p.ip || null,
      // UTC ISO(带 Z):安卓端按设备时区(北京)展示,避免 datetime('now') 无时区标记导致差 8 小时
      new Date().toISOString()
    );
  } catch (e) {
    console.warn('[order-log] 写入失败:', e?.message);
  }
}

export default logOrderAction;