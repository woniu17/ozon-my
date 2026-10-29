// 卢布→人民币汇率(2026-10-29)
// Ozon 买家页跟卖报价币种不稳定:同 SKU 在不同时间采集可能返回 ₽(卢布)或 ¥(人民币),
// 取决于 Ozon 服务端对 headless 浏览器的指纹/登录态判断(实测 10-28 晚间大量采集返回卢布,
// 凌晨恢复人民币)。而 my_price 来自 OPI 接口恒为人民币(currency_code='CNY'),
// 若跟卖报价为卢布则混算指标全部错误。因此解析价格时识别货币,卢布统一按实时汇率换算成
// 人民币(CNY)后再计算指标/展示,保证与 my_price 同口径。
//
// 汇率来源:open.er-api.com(免费,每日更新),内存缓存 6h,获取失败回退上次成功值,
// 首次启动未拉取到时用默认值 0.0828(约 1 RUB ≈ 0.083 CNY,2026-10-29)。

const RATE_API = 'https://open.er-api.com/v6/latest/RUB';
const CACHE_TTL_MS = 6 * 3600_000;
const DEFAULT_RATE = 0.0828;

let cached = { rate: DEFAULT_RATE, at: 0, fetching: null };

export function getRubCnyRate() {
  if (Date.now() - cached.at >= CACHE_TTL_MS) {
    refreshRubCnyRate().catch(() => {}); // 异步刷新,不阻塞调用方
  }
  return cached.rate;
}

export async function refreshRubCnyRate() {
  if (cached.fetching) return cached.fetching;
  cached.fetching = (async () => {
    try {
      const res = await fetch(RATE_API, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json();
        const r = Number(j?.rates?.CNY);
        if (Number.isFinite(r) && r > 0) {
          cached.rate = r;
          cached.at = Date.now();
        }
      }
    } catch {
      // 网络失败:保留旧值(默认/上次成功),下次调用再试
    } finally {
      cached.fetching = null;
    }
  })();
  return cached.fetching;
}

// 卢布金额 → 人民币金额(四舍五入到分)
export function rubToCny(rub) {
  if (rub == null || !Number.isFinite(Number(rub))) return null;
  return Math.round(Number(rub) * getRubCnyRate() * 100) / 100;
}