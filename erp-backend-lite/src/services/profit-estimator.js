// 利润预估公式(单点维护,2026-09-18 抽取自 order-process.js computeProfit 预估分支)
// 使用方:订单处理页(订单级口径)+ 价格管理页(单件口径)
// 口径:全 CNY(订单金额/售价/采购价/配送费同币种,实测 Ozon 结算币种为 CNY)
//   佣金 = 金额 × 16%
//   配送 = 按配送方式分流(2026-10-27):
//     - Доставка Ozon курьеру(tpl_integration_type=ozon_outsourced)→ OGL 分档费率
//       (value×weight 6 组,见 services/ogl-freight.js)
//     - 其他(ABT/OYX 等 aggregator)→ 旧线性公式 3.37 + 0.0281 × weight_g(ABT Economy Extra Small)
//   回款 escrow = 金额 − 佣金 − 配送;利润 = escrow − 采购
// 教训(project memory):利润口径必须单点维护,禁止两处各自实现漂移
import { estimateOglFreight, getOglGroup } from './ogl-freight.js';

export const DEFAULT_COMMISSION_RATE = 0.16;
// ABT Economy Extra Small 线性公式(legacy,非 OGL 配送兜底)
export const DELIVERY_BASE_CNY = 3.37;
export const DELIVERY_PER_G_CNY = 0.0281;

const round2 = (n) => Math.round(n * 100) / 100;

/** 是否 OGL 配送(Доставка Ozon курьеру / ozon_outsourced) */
export function isOglDelivery(deliveryMethodName, tplIntegrationType) {
  if (String(tplIntegrationType || '') === 'ozon_outsourced') return true;
  const name = String(deliveryMethodName || '');
  return name.includes('Доставка Ozon курьеру') || name.includes('Ozon курьеру');
}

/**
 * 配送费估算(CNY)
 * OGL 走分档费率(valueCny 为申报价值,weightG 为重量);非 OGL 走 ABT 线性公式。
 * 重量缺失返回 null;OGL 超出费率范围(高价值/超重)回退 ABT 公式。
 * @param {{weightG:number, valueCny?:number, deliveryMethodName?:string, tplIntegrationType?:string}} p
 */
export function estimateDeliveryCny({ weightG, valueCny = null, deliveryMethodName, tplIntegrationType }) {
  const w = Number(weightG);
  if (weightG == null || !Number.isFinite(w) || w <= 0) return null;
  if (isOglDelivery(deliveryMethodName, tplIntegrationType)) {
    const { deliveryCny } = estimateOglFreight({ valueCny, weightG: w });
    if (deliveryCny != null) return deliveryCny;
    // 超出 OGL 费率范围(申报价值>22525 或重量>35kg)回退 ABT 公式
    return round2(DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w);
  }
  return round2(DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w);
}

/**
 * 预估利润(订单级与单件通用)
 * @param {object} p
 * @param {number} p.amountCny  订单金额(CNY)或单件售价(CNY)(OGL 时作为申报价值分档)
 * @param {number} p.purchaseCny 采购金额(CNY)或单件采购价(CNY)
 * @param {number|null} p.weightG 重量(g);null 走无重量兜底(配送不扣减,保守口径)
 * @param {string} [p.deliveryMethodName] 配送方式名(OGL 分流)
 * @param {string} [p.tplIntegrationType] tpl 集成类型(ozon_outsourced=OGL)
 * @returns {{commission,delivery?,deliveryGroup?,escrow,profit,profitRateCost,profitRateSale,estimated,weightG?,weightMissing?}}
 */
export function estimateProfit({ amountCny, purchaseCny, weightG, deliveryMethodName, tplIntegrationType }) {
  const amount = Number(amountCny) || 0;
  const purchase = Number(purchaseCny) || 0;
  const commission = round2(amount * DEFAULT_COMMISSION_RATE);
  const w = weightG != null ? Number(weightG) : null;
  const ogl = isOglDelivery(deliveryMethodName, tplIntegrationType);

  if (w != null && Number.isFinite(w)) {
    const delivery = estimateDeliveryCny({ weightG: w, valueCny: amount, deliveryMethodName, tplIntegrationType });
    const group = ogl ? getOglGroup(amount, w) : null;
    const escrow = round2(amount - commission - delivery);
    const profit = round2(escrow - purchase);
    return {
      commission,
      delivery,
      deliveryGroup: group?.name || null,
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
 * OGL 时配送费取决于申报价值(=建议价本身),按价值档迭代求解(带宽,1-2 次收敛,上限 6 次)。
 * @param {object} p
 * @param {number} p.purchaseCny 单件采购价(CNY,必填)
 * @param {number} p.weightG 重量(g,必填;无重量无法估算配送)
 * @param {number} p.targetRate 目标成本利润率(如 0.4 = 40%)
 * @param {number} [p.commissionRate]
 * @param {string} [p.deliveryMethodName]
 * @param {string} [p.tplIntegrationType] 价格管理默认传 'ozon_outsourced' 强制 OGL
 * @returns {number|null} 建议价(CNY,保留2位);参数缺失返回 null
 */
export function suggestPrice({ purchaseCny, weightG, targetRate, commissionRate = DEFAULT_COMMISSION_RATE, deliveryMethodName, tplIntegrationType }) {
  const purchase = Number(purchaseCny);
  const w = Number(weightG);
  const r = Number(targetRate);
  if (!Number.isFinite(purchase) || purchase <= 0) return null;
  if (!Number.isFinite(w) || w <= 0) return null;
  if (!Number.isFinite(r)) return null;
  const denom = 1 - commissionRate;

  if (isOglDelivery(deliveryMethodName, tplIntegrationType)) {
    // 初值用 ABT 公式,再按建议价落档迭代
    let price = (purchase * (1 + r) + (DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w)) / denom;
    for (let i = 0; i < 6; i++) {
      const { deliveryCny } = estimateOglFreight({ valueCny: price, weightG: w });
      if (deliveryCny == null) break;
      const next = (purchase * (1 + r) + deliveryCny) / denom;
      if (Math.abs(next - price) < 0.005) {
        price = next;
        break;
      }
      price = next;
    }
    return round2(price);
  }

  const delivery = DELIVERY_BASE_CNY + DELIVERY_PER_G_CNY * w;
  return round2((purchase * (1 + r) + delivery) / (1 - commissionRate));
}