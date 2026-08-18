// 临时测试脚本：获取单个店铺的 stats
import { launchPersistentContext } from 'cloakbrowser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '.chrome-profile');
const SELLER_ID = process.argv[2] || '2606588';

const EXTRACT_STATS_FN = async (sellerId) => {
  const innerUrl = `/modal/shop-in-shop-info?seller_id=${sellerId}&page_changed=true`;
  const url = `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(innerUrl)}`;
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
  });
  if (!resp.ok) return { error: `HTTP ${resp.status}`, statusText: resp.statusText };
  const json = await resp.json();
  const ws = json.widgetStates;
  if (!ws) return { error: 'no widgetStates', json: JSON.stringify(json).slice(0, 500) };

  let cellList = null;
  for (const key of Object.keys(ws)) {
    if (!key.startsWith('cellList-')) continue;
    try { cellList = JSON.parse(ws[key]); } catch {}
    if (cellList) break;
  }
  if (!cellList || !Array.isArray(cellList.cells)) {
    return { error: 'no cells', widgetKeys: Object.keys(ws).slice(0, 20) };
  }

  // 解析俄语格式数字,兼容 K(тысяча/千)和 M(миллион/百万)后缀
  const parseRussianNumber = (value) => {
    if (!value) return null;
    const cleaned = value.replace(/\s/g, '').replace(/\u00A0/g, '').trim();
    const mK = cleaned.match(/^(-?[\d.,]+)\s*K$/i);
    if (mK) return Math.round(Number(mK[1].replace(',', '.')) * 1000);
    const mM = cleaned.match(/^(-?[\d.,]+)\s*M$/i);
    if (mM) return Math.round(Number(mM[1].replace(',', '.')) * 1000000);
    const plain = cleaned.replace(/[\u00A0\s]/g, '');
    const n = Number(plain);
    return isNaN(n) ? null : n;
  };

  const stats = {
    ordersCount: null, reviewsCount: null, rating: null,
    ratingRaw: '', openedDurationRaw: '', openedMonths: null,
  };
  const debugCells = [];
  for (const cell of cellList.cells) {
    const dsCell = cell?.dsCell;
    if (!dsCell) continue;
    const title = dsCell?.centerBlock?.title?.text;
    const value = dsCell?.rightBlock?.badge?.text;
    debugCells.push({ title, value });
    if (!title || !value) continue;
    switch (title) {
      case 'Заказов':
        stats.ordersCount = parseRussianNumber(value);
        break;
      case 'Работает с Ozon':
        stats.openedDurationRaw = value;
        { const mMonth = value.match(/(\d+)\s+(месяц|месяца|месяцев)/i);
          if (mMonth) { stats.openedMonths = Number(mMonth[1]); break; }
          const mYear = value.match(/(\d+)\s+(год|года|лет)/i);
          if (mYear) { stats.openedMonths = Number(mYear[1]) * 12; break; }
          stats.openedMonths = null;
        }
        break;
      case 'Средняя оценка товаров':
        stats.ratingRaw = value;
        stats.rating = Number(value.replace(',', '.').replace(/\s*из\s*\d+/i, '').trim()) || null;
        break;
      case 'Количество отзывов':
        stats.reviewsCount = parseRussianNumber(value);
        break;
    }
  }
  return { sellerId, stats, debugCells, error: null };
};

console.log(`=== 测试获取店铺 ${SELLER_ID} 的 stats ===`);
console.log(`Profile: ${PROFILE_DIR}`);

const browser = await launchPersistentContext({
  userDataDir: PROFILE_DIR,
  headless: true,
});

const page = await browser.newPage();

// 先访问首页建立 cookie
console.log('\n[1] 访问 ozon.ru 首页...');
await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);
console.log('首页标题:', await page.title());

// 导航到店铺页
console.log(`\n[2] 导航到店铺页 /seller/${SELLER_ID}/ ...`);
await page.goto(`https://www.ozon.ru/seller/${SELLER_ID}/`, {
  waitUntil: 'domcontentloaded',
  timeout: 25000,
});
await page.waitForTimeout(3000);
console.log('店铺页标题:', await page.title());
console.log('店铺页 URL:', page.url());

// fetch entrypoint-api
console.log(`\n[3] 在店铺页上下文 fetch entrypoint-api ...`);
const result = await page.evaluate(EXTRACT_STATS_FN, SELLER_ID);

console.log('\n=== 结果 ===');
console.log(JSON.stringify(result, null, 2));

await browser.close();
