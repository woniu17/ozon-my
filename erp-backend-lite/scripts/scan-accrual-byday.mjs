// 扫描 /v1/finance/accrual/by-day:全店铺 × 日期范围,原始结果落盘(可续跑)
// 用途:与 /v1/finance/accrual/postings 拉取的 op_accrual 对比,找 postings 缺失的应计类型
import config from '../src/config/index.js';
import { request } from 'undici';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BASE = config.ozonOpiBaseUrl;
const OUT = 'data/accrual-byday-raw.json';
const FROM = '2026-04-12'; // 对齐 op_accrual 最早 accrual_date
const TO = new Date().toISOString().slice(0, 10);
const THROTTLE_MS = 1100; // finance 接口秒级限流,1 req/s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(store, body) {
  const res = await request(`${BASE}/v1/finance/accrual/by-day`, {
    method: 'POST',
    headers: {
      'Client-Id': store.sync_credentials.clientId,
      'Api-Key': store.sync_credentials.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    headersTimeout: 60_000,
    bodyTimeout: 60_000,
  });
  const text = await res.body.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.statusCode, body: parsed };
}

async function callWithRetry(store, body) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    const { status, body: parsed } = await call(store, body);
    if (status === 200) return parsed;
    lastErr = new Error(`HTTP ${status}: ${parsed?.message || 'unknown'}`);
    if (status !== 429) throw lastErr;
    await sleep(2000 * (i + 1) + Math.floor(Math.random() * 1000));
  }
  throw lastErr;
}

function load() {
  return existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
}

async function main() {
  const stores = (config.loadStores() || []).filter((s) => s?.sync_credentials?.clientId);
  const dates = [];
  for (let t = Date.parse(FROM); t <= Date.parse(TO) + 86400_000; t += 86400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  const cache = load();
  const total = stores.length * dates.length;
  console.log(`店铺 ${stores.length} 家 × 日期 ${dates.length} 天 = ${total} 次调用(已完成 ${Object.keys(cache).length})`);

  let done = 0;
  let fetched = 0;
  for (const date of dates) {
    for (const store of stores) {
      done++;
      const key = `${store.id}|${date}`;
      if (cache[key]) continue;
      try {
        // 分页:last_id 非空时回传续拉
        let lastId = '';
        const items = [];
        let pages = 0;
        let paginated = true;
        do {
          const body = { date, ...(lastId && paginated ? { last_id: lastId } : {}) };
          let parsed;
          try {
            parsed = await callWithRetry(store, body);
          } catch (e) {
            // last_id 参数不被接受时,退化为不分页
            if (lastId && paginated && /validation/i.test(e.message)) {
              paginated = false;
              parsed = await callWithRetry(store, { date });
            } else throw e;
          }
          items.push(...(parsed.accruals || []));
          lastId = parsed.last_id || '';
          pages++;
        } while (lastId && paginated && pages < 100);
        cache[key] = { count: items.length, pages, accruals: items };
        fetched++;
      } catch (e) {
        cache[key] = { error: e.message };
      }
      if (done % 25 === 0) {
        writeFileSync(OUT, JSON.stringify(cache));
        console.log(`[${done}/${total}] 进度保存,新拉 ${fetched} 天`);
      }
      await sleep(THROTTLE_MS);
    }
  }
  writeFileSync(OUT, JSON.stringify(cache));

  // 摘要
  const errs = Object.entries(cache).filter(([, v]) => v.error);
  const totalCount = Object.values(cache).reduce((s, v) => s + (v.count || 0), 0);
  console.log(`\n完成:总应计条目 ${totalCount},错误 ${errs.length}`);
  if (errs.length) {
    const byErr = {};
    for (const [k, v] of errs) byErr[v.error] = (byErr[v.error] || 0) + 1;
    console.log('错误分布:', byErr);
  }
  console.log(`原始数据已存 ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
