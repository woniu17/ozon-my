// OGL 分档运费费率(2026-10-27)
// 仅适用于配送方式「Доставка Ozon курьеру」(tpl_integration_type = ozon_outsourced)。
// 计费:运费 = 固定费用 + 每克单价 × 重量(克),按 1 克计费。
// 评分组由「申报价值(CNY) × 重量(g)」二维决定:
//   普通档 0.01-135     : Extra Small(≤500g) / Budget(>500g)
//   中档   135.01-635   : Small(≤2000g) / Big(>2000g)
//   高档   635.01-22525 : Premium Small(≤5000g) / Premium Big(>5000g)
// 单件限重 35kg,申报价值上限 22525 CNY,单边长度 ≤200cm(不参与计费)。
// 本模块为全项目 OGL 费率唯一数据源(profit-estimator / price-dao SQL / Web / 安卓共用口径)。

export const OGL_TARIFF_GROUPS = [
  { key: 'extra_small',   name: 'Extra Small',   valueMin: 0.01,   valueMax: 135,    weightMinG: 1,    weightMaxG: 500,    fixedFee: 2.90,  perGram: 0.0247 },
  { key: 'budget',         name: 'Budget',        valueMin: 0.01,   valueMax: 135,    weightMinG: 501,  weightMaxG: 35000, fixedFee: 22.25, perGram: 0.0164 },
  { key: 'small',          name: 'Small',         valueMin: 135.01, valueMax: 635,    weightMinG: 1,    weightMaxG: 2000,  fixedFee: 15.48, perGram: 0.0242 },
  { key: 'big',            name: 'Big',            valueMin: 135.01, valueMax: 635,    weightMinG: 2001, weightMaxG: 35000, fixedFee: 34.82, perGram: 0.0164 },
  { key: 'premium_small',  name: 'Premium Small',  valueMin: 635.01, valueMax: 22525,  weightMinG: 1,    weightMaxG: 5000,  fixedFee: 21.28, perGram: 0.0242 },
  { key: 'premium_big',    name: 'Premium Big',    valueMin: 635.01, valueMax: 22525,  weightMinG: 5001, weightMaxG: 35000, fixedFee: 59.97, perGram: 0.0222 },
];

const round2 = (n) => Math.round(n * 100) / 100;

/** 按申报价值(CNY)+重量(g)匹配评分组;参数非法或越界返回 null */
export function getOglGroup(valueCny, weightG) {
  const v = Number(valueCny);
  const w = Number(weightG);
  if (!Number.isFinite(v) || !Number.isFinite(w) || w <= 0) return null;
  for (const g of OGL_TARIFF_GROUPS) {
    if (v >= g.valueMin && v <= g.valueMax && w >= g.weightMinG && w <= g.weightMaxG) return g;
  }
  return null;
}

/**
 * 估算 OGL 运费(CNY)
 * @param {{valueCny:number, weightG:number}} p
 * @returns {{group: object|null, fixedFee: number|null, variableFee: number|null, deliveryCny: number|null}}
 */
export function estimateOglFreight({ valueCny, weightG }) {
  const w = Number(weightG);
  const group = getOglGroup(valueCny, w);
  if (!group) return { group: null, fixedFee: null, variableFee: null, deliveryCny: null };
  const variableFee = round2(group.perGram * w);
  const deliveryCny = round2(group.fixedFee + variableFee);
  return { group, fixedFee: group.fixedFee, variableFee, deliveryCny };
}

/**
 * 由 OGL 实际配送费(CNY)反推重量(克)。
 * 同一价值档内只有「小/大」两个候选组,分别反解后校验落在本组重量区间,取一致者。
 * @returns {number|null}
 */
export function deriveOglWeight({ valueCny, deliveryCny }) {
  const v = Number(valueCny);
  const d = Number(deliveryCny);
  if (!Number.isFinite(v) || !Number.isFinite(d) || d <= 0) return null;
  const candidates = OGL_TARIFF_GROUPS.filter((g) => v >= g.valueMin && v <= g.valueMax);
  for (const g of candidates) {
    if (d <= g.fixedFee) continue;
    const w = Math.floor((d - g.fixedFee) / g.perGram);
    if (w >= g.weightMinG && w <= g.weightMaxG) return w;
  }
  return null;
}

/**
 * 生成价格管理 SQL 用的 OGL 配送费表达式。
 * 从费率组动态拼装 CASE,保证与 OGL_TARIFF_GROUPS 单点一致;超出费率范围(高价值/超重)回退
 * fallbackBaseExpr + fallbackPerGramExpr × weight(旧 ABT 公式,由调用方传 SQL 命名参数)。
 * @param {string} weightExpr  SQL 重量表达式(如 WEIGHT)
 * @param {string} valueExpr   SQL 申报价值表达式(如 c.price)
 * @param {string} fallbackBaseExpr  SQL 回退固定费表达式(如 '@db')
 * @param {string} fallbackPerGramExpr SQL 回退每克表达式(如 '@dg')
 * @returns {string}
 */
export function buildOglDeliverySql(weightExpr, valueExpr, fallbackBaseExpr = '3.37', fallbackPerGramExpr = '0.0281') {
  const cases = [];
  for (const g of OGL_TARIFF_GROUPS) {
    const cond = `(${valueExpr} >= ${g.valueMin} AND ${valueExpr} <= ${g.valueMax} AND ${weightExpr} >= ${g.weightMinG} AND ${weightExpr} <= ${g.weightMaxG})`;
    cases.push(`WHEN ${cond} THEN ${g.fixedFee} + ${g.perGram} * ${weightExpr}`);
  }
  return `CASE ${cases.join(' ')} ELSE ${fallbackBaseExpr} + ${fallbackPerGramExpr} * ${weightExpr} END`;
}