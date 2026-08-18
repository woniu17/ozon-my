// 批量补全店铺 stats(订单数/评论数/评分/开业时长)
// 用 cloakbrowser launchPersistentContext 启动 stealth 浏览器,导航到每个店铺页,
// 在店铺页完全加载后的上下文里 fetch entrypoint-api(真实用户行为,不触发反爬)
//
// 用法: node backfill-store-stats.js
// 可选环境变量:
//   DB_PATH      - SQLite 路径(默认 ../erp-backend-lite/data/erp.db)
//   INTERVAL_MS  - 限速毫秒(默认 10000)
//   LIMIT        - 只处理前 N 个(测试用)
//   HEADLESS     - 设为 1 无头模式
//
// 示例(bash):
//   HEADLESS=1 LIMIT=10 node backfill-store-stats.js        # 先测 10 个
//   HEADLESS=1 LIMIT=100 node backfill-store-stats.js       # 确认 OK 后跑前 100 个
//   HEADLESS=1 node backfill-store-stats.js                 # 全量(24万,约28天)

import { launchPersistentContext } from 'cloakbrowser';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 配置 ─────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../erp-backend-lite/data/erp.db');
// 复用 persistent.js 的 profile(已有 ozon 登录态,cookie 完整)
const PROFILE_DIR = path.join(__dirname, '.chrome-profile');
const PROGRESS_FILE = path.join(__dirname, 'backfill-progress.json');
const INTERVAL_MS = Number(process.env.INTERVAL_MS) || 10000;
const LIMIT = Number(process.env.LIMIT) || 0; // 0=不限制
const HEADLESS = process.env.HEADLESS === '1';

// ── SQLite ───────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

function loadPendingSellerIds() {
  // 所有缺 stats 的中国店铺(isMainlandChina=1)
  const sql = `
    SELECT sellerId
    FROM ozon_store_classification
    WHERE orders_count IS NULL AND isMainlandChina = 1
    ORDER BY lastSeenAt DESC
  `;
  const rows = db.prepare(sql).all();
  let ids = rows.map((r) => String(r.sellerId));
  if (LIMIT > 0) ids = ids.slice(0, LIMIT);
  return ids;
}

function updateStats(sellerId, stats) {
  db.prepare(
    `UPDATE ozon_store_classification
     SET orders_count = ?, reviews_count = ?, rating = ?, opened_months = ?
     WHERE sellerId = ?`
  ).run(
    stats.ordersCount ?? null,
    stats.reviewsCount ?? null,
    stats.rating ?? null,
    stats.openedMonths ?? null,
    String(sellerId)
  );
}

// ── 断点续传 ─────────────────────────────────────────────────
function loadProgress() {
  if (!existsSync(PROGRESS_FILE)) return { done: [], failed: [], lastRunAt: null };
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf-8'));
  } catch {
    return { done: [], failed: [], lastRunAt: null };
  }
}

function saveProgress(progress) {
  progress.lastRunAt = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── 在店铺页上下文内提取 stats(复用 seller-info-main.js 逻辑) ──
// 注入到 page.evaluate,不能用闭包变量
const EXTRACT_STATS_FN = async (sellerId) => {
  const innerUrl = `/modal/shop-in-shop-info?seller_id=${sellerId}&page_changed=true`;
  const url = `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(innerUrl)}`;
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
  });
  if (!resp.ok) return { error: `HTTP ${resp.status}` };
  const json = await resp.json();
  const ws = json.widgetStates;
  if (!ws) return { error: 'no widgetStates' };

  // 找 cellList widget(键名前缀 cellList-,值是 JSON 字符串需二次 parse)
  let cellList = null;
  for (const key of Object.keys(ws)) {
    if (!key.startsWith('cellList-')) continue;
    try { cellList = JSON.parse(ws[key]); } catch {}
    if (cellList) break;
  }
  if (!cellList || !Array.isArray(cellList.cells)) return { error: 'no cells' };

  // 解析俄语格式数字,兼容 K(тысяча/千)和 M(миллион/百万)后缀
  // 例:"455" → 455;"13,2 K" → 13200;"1,5 M" → 1500000
  const parseRussianNumber = (value) => {
    if (!value) return null;
    const cleaned = value.replace(/\s/g, '').replace(/\u00A0/g, '').trim();
    // K(千):"13,2K" → 13.2 × 1000 = 13200
    const mK = cleaned.match(/^(-?[\d.,]+)\s*K$/i);
    if (mK) return Math.round(Number(mK[1].replace(',', '.')) * 1000);
    // M(百万):"1,5M" → 1.5 × 1000000 = 1500000
    const mM = cleaned.match(/^(-?[\d.,]+)\s*M$/i);
    if (mM) return Math.round(Number(mM[1].replace(',', '.')) * 1000000);
    // 普通数字:"4 302" → 4302
    const plain = cleaned.replace(/[\u00A0\s]/g, '');
    const n = Number(plain);
    return isNaN(n) ? null : n;
  };

  const stats = {
    ordersCount: null, reviewsCount: null, rating: null,
    ratingRaw: '', openedDurationRaw: '', openedMonths: null,
  };
  for (const cell of cellList.cells) {
    const dsCell = cell?.dsCell;
    if (!dsCell) continue;
    const title = dsCell?.centerBlock?.title?.text;
    const value = dsCell?.rightBlock?.badge?.text;
    if (!title || !value) continue;
    switch (title) {
      case 'Заказов':
        stats.ordersCount = parseRussianNumber(value);
        break;
      case 'Работает с Ozon':
        stats.openedDurationRaw = value;
        { // 月:"9 месяцев" → 9; 年:"1 год"/"2 года"/"5 лет" → 转 月(×12)
          const mMonth = value.match(/(\d+)\s+(месяц|месяца|месяцев)/i);
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
  return { sellerId, stats, error: null };
};

// ── 主流程 ───────────────────────────────────────────────────
async function main() {
  console.log('=== 店铺 stats 批量补全(launchPersistentContext) ===');
  console.log(`DB:        ${DB_PATH}`);
  console.log(`Profile:   ${PROFILE_DIR}`);
  console.log(`限速:      ${INTERVAL_MS}ms/次`);
  console.log(`无头:      ${HEADLESS}`);

  // 1. 启动 cloakbrowser stealth 浏览器
  console.log('\n[1/4] 启动 stealth 浏览器...');
  const browser = await launchPersistentContext({
    userDataDir: PROFILE_DIR,
    headless: HEADLESS,
  });

  const page = await browser.newPage();

  // 先访问 ozon.ru 首页,让浏览器通过反爬验证 + 建立 cookie
  console.log('[1/4] 访问 ozon.ru 首页(通过反爬 + 建立 cookie)...');
  await page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 等待页面稳定(给 cloakbrowser stealth 时间通过反爬挑战)
  await page.waitForTimeout(5000);
  const title = await page.title();
  console.log(`[1/4] 首页标题: ${title}`);

  // 2. 查询待补全 sellerId
  console.log('\n[2/4] 查询待补全店铺...');
  const allIds = loadPendingSellerIds();
  const progress = loadProgress();
  const doneSet = new Set(progress.done);
  const pending = allIds.filter((id) => !doneSet.has(id));
  const doneInBatch = allIds.length - pending.length;
  console.log(`[2/4] 本批 ${allIds.length} 个(累计已完成 ${doneSet.size} 个),本批已完成 ${doneInBatch} 个,待处理 ${pending.length} 个`);

  if (pending.length === 0) {
    console.log('\n全部完成,无需处理。');
    await browser.close();
    return;
  }

  // 3. 遍历:导航到店铺页 → 等加载 → fetch entrypoint-api → 写 SQLite
  console.log(`\n[3/4] 开始提取(限速 ${INTERVAL_MS}ms/次,预计 ${Math.ceil((pending.length * INTERVAL_MS) / 60000)} 分钟)...`);
  let success = 0, failed = 0, consecutiveFail = 0;
  const startTime = Date.now();

  for (let i = 0; i < pending.length; i++) {
    const sellerId = pending[i];
    const idx = i + 1;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`[${idx}/${pending.length}] sellerId=${sellerId} (${elapsed}s) ... `);

    let result = null;
    let lastError = '';

    try {
      // 导航到店铺页(在店铺页上下文里 fetch 才是真实用户行为)
      await page.goto(`https://www.ozon.ru/seller/${sellerId}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 25000,
      });
      // 等待页面稳定(反爬挑战 + __NUXT__ 挂载)
      await page.waitForTimeout(3000);

      // 在店铺页上下文执行 fetch entrypoint-api
      result = await page.evaluate(EXTRACT_STATS_FN, sellerId);
    } catch (e) {
      lastError = `nav/eval: ${e.message}`;
    }

    if (result && !result.error) {
      updateStats(sellerId, result.stats);
      progress.done.push(sellerId);
      success++;
      consecutiveFail = 0;
      const s = result.stats;
      console.log(
        `OK  orders=${s.ordersCount ?? '-'}, reviews=${s.reviewsCount ?? '-'}, rating=${s.rating ?? '-'}, months=${s.openedMonths ?? '-'}`
      );
    } else {
      progress.failed.push({ sellerId, error: result?.error || lastError });
      failed++;
      consecutiveFail++;
      console.log(`FAIL (${result?.error || lastError})`);
    }

    saveProgress(progress);

    // 3 次连续失败暂停(可能是 cookie 失效/反爬升级)
    if (consecutiveFail >= 3) {
      console.log('\n[警告] 连续 3 次失败,暂停。请检查浏览器是否被反爬拦截。');
      console.log('修复后重新运行本脚本即可断点续传。');
      break;
    }

    // 限速(最后一次不等)
    if (i < pending.length - 1) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }

  // 4. 汇总
  console.log('\n[4/4] 汇总');
  console.log(`  成功: ${success}`);
  console.log(`  失败: ${failed}`);
  console.log(`  耗时: ${Math.round((Date.now() - startTime) / 1000)}s`);
  if (failed > 0) console.log('  失败列表见 backfill-progress.json');

  await browser.close();
  db.close();
}

main().catch((e) => {
  console.error('\n致命错误:', e);
  process.exit(1);
});
