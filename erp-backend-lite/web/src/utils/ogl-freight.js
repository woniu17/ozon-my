// OGL 分档运费前端共享工具(2026-10-27)
// 镜像后端 services/ogl-freight.js + profit-estimator.js 分流口径,单点维护。
// 使用方:OrderProcess.vue / ScanShip.vue / PriceManage.vue(前端仅做预览,服务端二次校验)。
// 费率组常量与后端 OGL_TARIFF_GROUPS 完全一致,调价时两端同步修改。

export const OGL_TARIFF_GROUPS = [
  { key: 'extra_small', name: 'Extra Small', valueMin: 0.01, valueMax: 135, weightMinG: 1, weightMaxG: 500, fixedFee: 2.9, perGram: 0.0247 },
  { key: 'budget', name: 'Budget', valueMin: 0.01, valueMax: 135, weightMinG: 501, weightMaxG: 35000, fixedFee: 22.25, perGram: 0.0164 },
  { key: 'small', name: 'Small', valueMin: 135.01, valueMax: 635, weightMinG: 1, weightMaxG: 2000, fixedFee: 15.48, perGram: 0.0242 },
  { key: 'big', name: 'Big', valueMin: 135.01, valueMax: 635, weightMinG: 2001, weightMaxG: 35000, fixedFee: 34.82, perGram: 0.0164 },
  { key: 'premium_small', name: 'Premium Small', valueMin: 635.01, valueMax: 22525, weightMinG: 1, weightMaxG: 5000, fixedFee: 21.28, perGram: 0.0242 },
  { key: 'premium_big', name: 'Premium Big', valueMin: 635.01, valueMax: 22525, weightMinG: 5001, weightMaxG: 35000, fixedFee: 59.97, perGram: 0.0222 },
];

// ABT Economy Extra Small 线性公式(非 OGL 配送兜底,镜像后端)
export const ABT_DELIVERY_BASE_CNY = 3.37;
export const ABT_DELIVERY_PER_G_CNY = 0.0281;

const round2 = (n) => Math.round(n * 100) / 100;

/** 是否 OGL 配送(Доставка Ozon курьеру / ozon_outsourced) */
export function isOglDelivery(deliveryMethodName, tplIntegrationType) {
  if (String(tplIntegrationType || '') === 'ozon_outsourced') return true;
  const name = String(deliveryMethodName || '');
  return name.includes('Доставка Ozon курьеру') || name.includes('Ozon курьеру');
}

/** 按申报价值(CNY)+重量(g)匹配评分组 */
export function getOglGroup(valueCny, weightG) {
  const v = Number(valueCny);
  const w = Number(weightG);
  if (!Number.isFinite(v) || !Number.isFinite(w) || w <= 0) return null;
  for (const g of OGL_TARIFF_GROUPS) {
    if (v >= g.valueMin && v <= g.valueMax && w >= g.weightMinG && w <= g.weightMaxG) return g;
  }
  return null;
}

/** OGL 配送费(CNY);超出费率范围返回 null */
export function oglDelivery({ valueCny, weightG }) {
  const group = getOglGroup(valueCny, weightG);
  if (!group) return null;
  return round2(group.fixedFee + group.perGram * Number(weightG));
}

/** ABT 线性公式配送费(CNY) */
export function abtDelivery(weightG) {
  const w = Number(weightG);
  if (!(w > 0)) return null;
  return round2(ABT_DELIVERY_BASE_CNY + ABT_DELIVERY_PER_G_CNY * w);
}

/** 按配送方式分流估算配送费;未命中 OGL 或越界回退 ABT 公式 */
export function estimateDelivery({ valueCny, weightG, deliveryMethodName, tplIntegrationType }) {
  if (isOglDelivery(deliveryMethodName, tplIntegrationType)) {
    return oglDelivery({ valueCny, weightG }) ?? abtDelivery(weightG);
  }
  return abtDelivery(weightG);
}

/**
 * 目标成本利润率反推建议价(CNY,OGL 迭代求解)。
 * OGL 配送费取决于申报价值(=建议价本身),迭代 6 次以内收敛(价值档宽)。
 * @returns {number|null}
 */
export function suggestOglPrice({ purchaseCny, weightG, targetRate, commissionRate }) {
  const purchase = Number(purchaseCny);
  const w = Number(weightG);
  const r = Number(targetRate); // 小数,如 1.0 = 100%
  if (!(purchase > 0) || !(w > 0)) return null;
  const denom = 1 - commissionRate;
  let price = (purchase * (1 + r) + abtDelivery(w)) / denom;
  for (let i = 0; i < 6; i++) {
    const delivery = oglDelivery({ valueCny: price, weightG: w });
    if (delivery == null) break;
    const next = (purchase * (1 + r) + delivery) / denom;
    if (Math.abs(next - price) < 0.005) {
      price = next;
      break;
    }
    price = next;
  }
  return round2(price);
}