// 货币稳定性测试:连续采集同一 SKU,观察跟卖报价货币(¥ 人民币 vs ₽ 卢布)
import { fetchFollowSellForSku } from './src/services/price-watch-fetch.js';
import { db } from './src/db/index.js';
import config from './src/config/index.js';

const profileDir = config.ozonFollowSellProfileDir;
const sku = process.argv[2] || '5756081667';
const rounds = Number(process.argv[3] || 3);

const cur = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') {
    return cur(v?.cardPrice?.price) ?? cur(v?.cardPrice?.text) ?? cur(v?.cardPrice) ?? cur(v?.price) ?? cur(v?.originalPrice);
  }
  return String(v);
};

for (let i = 1; i <= rounds; i++) {
  console.log(`\n===== 第 ${i}/${rounds} 次采集 SKU ${sku} =====`);
  const t0 = Date.now();
  const r = await fetchFollowSellForSku(sku, { profileDir });
  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`耗时 ${cost}s, status=${r.status}`);
  if (r.status !== 'ok') {
    console.log('错误:', r.error);
    continue;
  }
  console.log('myPrice(OPI,人民币):', r.snapshot?.myPrice);
  console.log('min/median/avg(原始数字):', r.snapshot?.minPrice, r.snapshot?.medianPrice, r.snapshot?.avgPrice);
  // 从数据库读最新快照的 sellers JSON,提取价格原始文本判断货币
  const snap = db.prepare(`SELECT sellers FROM price_watch_snapshots WHERE sku = ? ORDER BY fetched_at DESC LIMIT 1`).get(sku);
  const sellers = snap ? JSON.parse(snap.sellers || '[]') : [];
  for (let j = 0; j < Math.min(5, sellers.length); j++) {
    console.log(`  seller[${j}] price:`, JSON.stringify(sellers[j]?.price || null));
  }
  if (i < rounds) await new Promise((res) => setTimeout(res, 8000));
}
process.exit(0);