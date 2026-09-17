// 利润预估公式(单点维护,2026-09-18 抽取自 order-process.js computeProfit 预估分支)
// 使用方:订单处理页(订单级口径)+ 价格管理页(单件口径)
// 口径:全 CNY(订单金额/售价/采购价/配送费同币种,实测 Ozon 结算币种为 CNY)
//   佣金 = 金额 × 16%
//   配送 = 3.37 + 0.0281 × weight_g(无重量时回退打包口径,配送隐含在佣金内)
//   回款 escrow = 金额 − 佣金 − 配送;利润 = escrow − 采购
// 教训(project memory):利润口径必须单点维护,禁止两处各自实现漂移

export const DEFAULT_COMMISSION_RATE = 0.16;
export const DELIVERY_BASE_CNY = 3.37;
export const DELIVERY_PER_G_CNY = 0.0281;

const round2 = (n) => Math.round(n * 100) / 100;

/** 配送费估算(CNY);weightG 为空返回 null */
export function estimateDeliveryCny(weightG) {
  const w = Number(weightG);
  if (weightG == null || !Number.isFinite(w) || w <= 0) return null;
  return round2(DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w);
}

/**
 * 预估利润(订单级与单件通用)
 * @param {object} p
 * @param {number} p.amountCny  订单金额(CNY)或单件售价(CNY)
 * @param {number} p.purchaseCny 采购金额(CNY)或单件采购价(CNY)
 * @param {number|null} p.weightG 重量(g);null 走无重量兜底(配送不扣减,保守口径)
 * @returns {{commission,delivery?,escrow,profit,profitRateCost,profitRateSale,estimated,weightG?,weightMissing?}}
 */
export function estimateProfit({ amountCny, purchaseCny, weightG }) {
  const amount = Number(amountCny) || 0;
  const purchase = Number(purchaseCny) || 0;
  const commission = round2(amount * DEFAULT_COMMISSION_RATE);
  const w = weightG != null ? Number(weightG) : null;

  if (w != null && Number.isFinite(w)) {
    const delivery = round2(DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w);
    const escrow = round2(amount - commission - delivery);
    const profit = round2(escrow - purchase);
    return {
      commission,
      delivery,
      escrow,
      profit,
      profitRateCost: purchase > 0 ? Math.round((profit / purchase) * 10000) / 100 : null,
      profitRateSale: amount > 0 ? Math.round((profit / amount) * 10000) / 100 : null,
      estimated: true,
      weightG: w,
    };
  }

  // 兜底:无重量,配送隐含在佣金内(原 16% 打包口径)
  const escrow = round2(amount - commission);
  const profit = round2(escrow - purchase);
  return {
    commission,
    escrow,
    profit,
    profitRateCost: purchase > 0 ? Math.round((profit / purchase) * 10000) / 100 : null,
    profitRateSale: amount > 0 ? Math.round((profit / amount) * 10000) / 100 : null,
    estimated: true,
    weightMissing: true,
  };
}

/**
 * 目标成本利润率反推建议价(CNY)
 * profit = price×(1−佣金率) − 配送 − 采购 = r × 采购
 * → price = (采购×(1+r) + 配送) / (1−佣金率)
 * @param {object} p
 * @param {number} p.purchaseCny 单件采购价(CNY,必填)
 * @param {number} p.weightG 重量(g,必填;无重量无法估算配送)
 * @param {number} p.targetRate 目标成本利润率(如 0.4 = 40%)
 * @param {number} [p.commissionRate]
 * @returns {number|null} 建议价(CNY,保留2位);参数缺失返回 null
 */
export function suggestPrice({ purchaseCny, weightG, targetRate, commissionRate = DEFAULT_COMMISSION_RATE }) {
  const purchase = Number(purchaseCny);
  const w = Number(weightG);
  const r = Number(targetRate);
  if (!Number.isFinite(purchase) || purchase <= 0) return null;
  if (!Number.isFinite(w) || w <= 0) return null;
  if (!Number.isFinite(r)) return null;
  const delivery = DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w;
  return round2((purchase * (1 + r) + delivery) / (1 - commissionRate));
}
