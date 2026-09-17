// STATE_CHANGED → ERP 订单/包裹联动(2026-09-17 webhook 整合,决策④核心新逻辑)
// 推送事件秒级推进 op_ozon_order.status + op_package.operate_status
// 双写边界(事件 vs 轮询):
//   - 事件只写 status / delivering_date / last_synced_at / gmt_modified 四个增量字段
//   - 轮询 upsertOrder ON CONFLICT 全字段覆盖,是唯一权威(金额/买家/产品行等)
//   - 乱序推送由 rank/吸收态规则吸收;残余不一致由 fast/mid 对账自愈
import { getDb } from '../../db/index.js';
import { orderPackageDao } from '../../db/dao/sqlite/order-daos.js';
import { pushToApi } from './status-map.js';
import { getStoreBySellerId } from './store-map.js';
import logger from '../../middleware/log.js';

// op_ozon_order.status(Seller API 模型)rank 序,用于"只前进"保护
// 0 创建/打包/验收 < 1 待装运 < 2 揽收(在途) < 3 仲裁级 < 4 妥投 < 9 吸收态
// 吸收态 cancelled / not_accepted 一旦进入不退出
const API_RANK = {
  awaiting_verification: 0,
  awaiting_approve: 0,
  awaiting_packaging: 0,
  awaiting_registration: 0,
  acceptance_in_progress: 0,
  awaiting_deliver: 1,
  delivering: 2,
  driver_pickup: 3,
  arbitration: 3,
  client_arbitration: 3,
  delivered: 4,
  cancelled: 9,
  not_accepted: 9,
};

/**
 * STATE_CHANGED 联动 op_ozon_order / op_package
 * 输入:payload{ posting_number, new_state(推送模型), changed_state_date, seller_id }
 * 全程 try/catch:失败只记日志不阻断 handler,留给轮询兜底
 */
export async function linkOzonOrder(payload) {
  try {
    const postingNumber = payload?.posting_number;
    if (!postingNumber) return;

    // ① 推送模型 → Seller API 模型;未知状态直接跳过(防脏写)
    const apiStatus = pushToApi(payload.new_state);
    if (!apiStatus) return;

    // ② 按 seller_id 定位店铺(推送的 seller_id = store.company_id)
    const store = getStoreBySellerId(payload.seller_id);
    if (!store) return;

    const db = getDb();
    const now = new Date().toISOString();

    // ③ 查 erp 业务订单(轮询已建);无行跳过(轮询会建,NEW_POSTING 联动后续版本再补)
    const row = db
      .prepare('SELECT id, status FROM op_ozon_order WHERE store_id = ? AND posting_number = ?')
      .get(store.id, postingNumber);
    if (!row) return;

    // ④ 状态保护后只推进(语义对齐 applyOzonStatus):
    //    - 现状态已是吸收态/妥投 → 跳过(吸收态不可退出,妥投不降级)
    //    - 新状态是吸收态 → 任意现状态均可进入
    //    - 其余:rank 更高才允许更新
    const newRank = API_RANK[apiStatus] ?? -1;
    const curRank = API_RANK[row.status] ?? -1;
    const curAbsorbing = row.status === 'cancelled' || row.status === 'not_accepted';
    const newAbsorbing = apiStatus === 'cancelled' || apiStatus === 'not_accepted';
    const allow = curAbsorbing || row.status === 'delivered'
      ? false
      : newAbsorbing || newRank > curRank;
    if (allow) {
      // delivering_date 仅揽收级(rank2~3)且当前为空时回填(COALESCE 保旧值)
      const pickupLevel = newRank >= 2 && newRank <= 3;
      db.prepare(`
        UPDATE op_ozon_order
        SET status = ?,
            delivering_date = COALESCE(delivering_date, ?),
            last_synced_at = ?,
            gmt_modified = ?
        WHERE id = ?
      `).run(apiStatus, pickupLevel ? (payload.changed_state_date ?? null) : null, now, now, row.id);
      logger.info({ postingNumber, apiStatus, from: row.status }, '[webhook] op_ozon_order 状态联动');
    }

    // ⑤ 找未忽略的包裹联动 operate_status(其内部 rank 保护与本函数一致,双保险)
    const pkg = db
      .prepare('SELECT id FROM op_package WHERE ozon_order_id = ? AND is_ignored = 0')
      .get(row.id);
    if (pkg) {
      orderPackageDao.applyOzonStatus(pkg.id, apiStatus, {
        deliveringDate: payload.changed_state_date ?? null,
      });
    }
  } catch (err) {
    logger.warn(
      { err: err?.message, postingNumber: payload?.posting_number },
      '[webhook] op_ozon_order 联动失败(轮询将兜底)'
    );
  }
}
