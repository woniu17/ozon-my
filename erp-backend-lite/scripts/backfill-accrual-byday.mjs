// 一次性回填:把 scan-accrual-byday.mjs 扫描的原始数据(data/accrual-byday-raw.json)
// 导入 op_accrual(费用侧,含 Acquiring 等 postings 缺失类型)+ op_accrual_income(收入侧)
// 幂等:replaceAccrualsByDay 按 posting_number 先删后插,可重复执行
import { readFileSync, existsSync } from 'node:fs';
import config from '../src/config/index.js';
import { financeAccrualTypes } from '../src/services/ozon-opi.js';
import { getAccrualTypes, replaceAccrualsByDay } from '../src/db/dao/sqlite/accrual-dao.js';

const RAW = 'data/accrual-byday-raw.json';

async function main() {
  if (!existsSync(RAW)) {
    console.error(`未找到 ${RAW},请先运行 node scripts/scan-accrual-byday.mjs`);
    process.exit(1);
  }
  const cache = JSON.parse(readFileSync(RAW, 'utf8'));
  const stores = (config.loadStores() || []).filter((s) => s?.sync_credentials?.clientId);
  const storeIds = new Set(stores.map((s) => s.id));
  const typeMap = await getAccrualTypes(() => financeAccrualTypes(stores[0]));
  console.log(`字典 ${typeMap.size} 种类型,开始导入 ${Object.keys(cache).length} 个(店铺,日期)...`);

  const agg = { days: 0, units: 0, feeRows: 0, incomeRows: 0, packages: 0, skipped: 0, errors: 0 };
  for (const [key, day] of Object.entries(cache)) {
    const [storeId, date] = key.split('|');
    if (!storeIds.has(storeId)) { agg.skipped++; continue; }
    if (day.error) { agg.errors++; continue; }
    try {
      const r = replaceAccrualsByDay(storeId, date, day.accruals || [], typeMap);
      agg.days++;
      agg.units += r.units;
      agg.feeRows += r.feeRows;
      agg.incomeRows += r.incomeRows;
      agg.packages += r.packages;
    } catch (e) {
      agg.errors++;
      console.error(`  失败 ${key}: ${e.message}`);
    }
  }
  console.log('导入完成:', JSON.stringify(agg, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
