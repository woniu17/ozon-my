// 状态模型映射与推进规则(unfulfilled-poller 兜底通知核心)
// 背景:DB ozon_postings.status 存"推送模型"状态(posting_on_way_to_city 等,webhook handler 写入),
//      OPI 返回"Seller API 模型"状态(delivering 等),两套词汇不同名,必须映射
// 映射来源:docs/ozon-api/16-推送通知.md 附录"发货状态映射"
// rank 序(推送模型):
//   0 已创建/打包/验收 < 1 待装运 < 2 揽收(发往城市/运输中) < 3 揽收后(快递员/取货点/仲裁)
//   < 4 妥投 < 9 吸收态(取消/集散未收)
// 吸收态:cancelled / not_accepted,一旦进入不退出;取消类状态一律交由 cancel-scanner 处理
// (M0 实测 2026-09-13:cancelled 货件不出现在 unfulfilled list,poller 不写取消状态)

// Seller API 状态 → 推送模型状态
const API_TO_PUSH = {
  awaiting_verification: 'posting_created',
  awaiting_approve: 'posting_created',
  awaiting_packaging: 'posting_created',
  awaiting_registration: 'posting_created',   // swagger 写作 "awaiting registration"(含空格),两种拼写都兼容
  'awaiting registration': 'posting_created',
  acceptance_in_progress: 'posting_acceptance_in_progress',
  awaiting_deliver: 'posting_transferring_to_delivery',
  delivering: 'posting_on_way_to_city',
  arbitration: 'posting_in_arbitration',
  client_arbitration: 'posting_in_client_arbitration',
  driver_pickup: 'posting_driver_pick_up',
  not_accepted: 'posting_not_in_sort_center',
  cancelled: 'posting_canceled',
  cancelled_from_split_pending: 'posting_canceled',
};

// 推送模型状态 → Seller API 状态(2026-09-17 webhook 整合新增反向映射,STATE_CHANGED 联动用)
// 从 API_TO_PUSH 反转,歧义项取保守代表值:
//   rank0-1 的代表值对 applyOzonStatus 无影响(其明确不动 rank<2),
//   posting_created 是 awaiting_verification/approve/packaging/registration 的代表
const PUSH_TO_API = {
  posting_created: 'awaiting_packaging',
  posting_packing: 'awaiting_packaging',
  posting_acceptance_in_progress: 'acceptance_in_progress',
  posting_awaiting_registration: 'awaiting_registration',
  posting_transferring_to_delivery: 'awaiting_deliver',
  posting_not_in_carriage: 'awaiting_deliver',
  posting_in_carriage: 'delivering',
  posting_on_way_to_city: 'delivering',              // 揽收
  posting_driver_pick_up: 'driver_pickup',
  posting_transferred_to_courier_service: 'delivering',
  posting_in_courier_service: 'delivering',
  posting_on_way_to_pickup_point: 'delivering',
  posting_in_pickup_point: 'delivering',
  posting_conditionally_delivered: 'delivering',
  posting_in_arbitration: 'arbitration',
  posting_in_client_arbitration: 'client_arbitration',
  posting_delivered: 'delivered',
  posting_received: 'delivered',
  posting_canceled: 'cancelled',                      // 吸收态
  posting_not_in_sort_center: 'not_accepted',        // 吸收态
};

// 推送模型状态 → rank(未收录返回 -1,视为最低,可被任何已知状态推进)
const PUSH_RANK = {
  posting_created: 0,
  posting_packing: 0,
  posting_acceptance_in_progress: 0,
  posting_awaiting_registration: 0,
  posting_transferring_to_delivery: 1,
  posting_not_in_carriage: 1,
  posting_in_carriage: 2,
  posting_on_way_to_city: 2,                  // 揽收
  posting_driver_pick_up: 3,
  posting_transferred_to_courier_service: 3,
  posting_in_courier_service: 3,
  posting_on_way_to_pickup_point: 3,
  posting_in_pickup_point: 3,
  posting_conditionally_delivered: 3,
  posting_in_arbitration: 3,
  posting_in_client_arbitration: 3,
  posting_delivered: 4,
  posting_received: 4,
  posting_canceled: 9,                        // 吸收态
  posting_not_in_sort_center: 9,              // 吸收态
};

// 吸收态(终态,不可退出)
export const PUSH_ABSORBING = new Set(['posting_canceled', 'posting_not_in_sort_center']);

// 妥投终态(rank 4)
const PUSH_DELIVERED = new Set(['posting_delivered', 'posting_received']);

/**
 * API 状态 → 推送模型状态;未知状态返回 null
 */
export function apiToPush(apiStatus) {
  if (apiStatus == null) return null;
  return API_TO_PUSH[apiStatus] ?? null;
}

/**
 * 推送模型状态 → Seller API 状态;未知状态返回 null(调用方应跳过,防脏写)
 */
export function pushToApi(pushStatus) {
  if (pushStatus == null) return null;
  return PUSH_TO_API[pushStatus] ?? null;
}

/**
 * 推送模型状态 → rank;未知返回 -1
 */
export function pushRankOf(pushStatus) {
  if (pushStatus == null) return -1;
  return PUSH_RANK[pushStatus] ?? -1;
}

/**
 * 是否揽收级推送状态(rank 2~3:已交给物流,在途/快递员/取货点/仲裁)
 * 设计决策 D1:揽收通知触发放宽为"首次达到揽收级",跳级推送(如直接
 * posting_in_courier_service)也按揽收通知,与 pickup_at 置位逻辑对齐
 */
export function isPickupLevelPush(pushStatus) {
  const r = pushRankOf(pushStatus);
  return r >= 2 && r <= 3;
}

/**
 * 是否揽收级 API 状态(delivering / driver_pickup / arbitration / client_arbitration)
 */
export function isPickupLevelApi(apiStatus) {
  return isPickupLevelPush(apiToPush(apiStatus));
}

/**
 * 状态推进决策(unfulfilled-poller 阶段②③用)
 * 规则:
 *   - DB 已吸收态/已妥投 → skip(不回退;取消不退出,妥投后不再降级)
 *   - API 是取消类(吸收态) → skip(取消兜底统一由 cancel-scanner 负责,
 *     此处若静默写取消会导致 scanner 误判"已处理"而丢失通知)
 *   - API 未知状态 → skip(防脏写)
 *   - API rank > DB rank → advance(pickup 字段标记是否同时首次达到揽收级)
 * @returns {{action:'advance',push:string,rank:number,pickup:boolean}|{action:'skip',reason:string}}
 */
export function planAdvance(dbStatus, apiStatus) {
  const push = apiToPush(apiStatus);
  if (push == null) return { action: 'skip', reason: 'unknown_api_status' };
  if (PUSH_ABSORBING.has(dbStatus)) return { action: 'skip', reason: 'db_absorbing' };
  if (PUSH_DELIVERED.has(dbStatus)) return { action: 'skip', reason: 'db_delivered' };
  if (PUSH_ABSORBING.has(push)) return { action: 'skip', reason: 'api_absorbing' };
  const apiRank = PUSH_RANK[push];
  const dbRank = pushRankOf(dbStatus);
  if (apiRank > dbRank) {
    return { action: 'advance', push, rank: apiRank, pickup: apiRank >= 2 && apiRank <= 3 };
  }
  return { action: 'skip', reason: 'rank_not_higher' };
}
