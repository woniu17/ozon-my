// 统计 6 家店铺 2月份至今 FBS 货件的应计项目分布
// 数据源: POST /v4/posting/fbs/list (取货件号) + POST /v1/finance/accrual/postings (取应计)
// 参考: docs/ozon-api/15-Premium分析.md
// 用法: node scripts/fetch-accrual-stats.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api-seller.ozon.ru';
const SINCE = '2026-02-01T00:00:00.000Z';
const TO = '2026-09-03T23:59:59.000Z';
const CHUNK = 200; // 应计接口单批货件数(实测 198 可行)

const stores = JSON.parse(
  readFileSync(join(__dirname, '..', 'ozon-webhook', 'src', 'config', 'stores.json'), 'utf8'),
);

const headers = (store) => ({
  'Client-Id': store.sync_credentials.clientId,
  'Api-Key': store.sync_credentials.apiKey,
  'Content-Type': 'application/json',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(store, path, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await sleep(350); // 全局节流,避免每秒限流(429 code=8)
      const resp = await fetch(BASE + path, {
        method: 'POST',
        headers: headers(store),
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => null);
      if (resp.status === 429 || data?.code === 8) {
        throw Object.assign(new Error('rate_limited'), { rateLimited: true });
      }
      if (!resp.ok || data?.code) {
        throw new Error(`${path} -> ${resp.status} ${JSON.stringify(data).slice(0, 200)}`);
      }
      return data;
    } catch (err) {
      if (err.rateLimited) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (attempt === 4) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

// 1) 拉取店铺 2月至今全部 FBS 货件号
async function listPostings(store) {
  const numbers = [];
  let cursor = '';
  let guard = 0;
  do {
    const body = { filter: { since: SINCE, to: TO }, limit: 100 };
    if (cursor) body.cursor = cursor;
    const r = await api(store, '/v4/posting/fbs/list', body);
    numbers.push(...(r.postings || []).map((p) => p.posting_number));
    cursor = r.cursor || '';
    guard++;
  } while (cursor && guard < 500);
  return numbers;
}

// 2) 分批查应计
async function fetchAccruals(store, numbers) {
  const out = [];
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const r = await api(store, '/v1/finance/accrual/postings', {
      posting_numbers: numbers.slice(i, i + CHUNK),
    });
    out.push(...(r.posting_accruals || []));
  }
  return out;
}

async function main() {
  // 应计类型字典(全店共用)
  const typesResp = await api(stores[0], '/v1/finance/accrual/types', {});
  const typeMap = new Map(
    (typesResp.accrual_types || []).map((t) => [t.id, { name: t.name, description: t.description }]),
  );

  const perStore = {};
  const globalByType = new Map(); // type_id -> { count, postings:Set, amounts: {RUB: n...} }
  let totalPostings = 0;
  let postingsWithAccruals = 0;

  for (const store of stores) {
    const numbers = await listPostings(store);
    const pac = await fetchAccruals(store, numbers);
    const withAcc = pac.filter((p) => p.accruals?.length);

    totalPostings += numbers.length;
    postingsWithAccruals += withAcc.length;

    // 店级统计
    const storeByType = new Map();
    for (const p of pac) {
      for (const ac of p.accruals || []) {
        const amount = Number(ac.accrued?.amount ?? 0);
        const currency = ac.accrued?.currency ?? '???';
        const key = ac.type_id;

        if (!storeByType.has(key)) storeByType.set(key, { count: 0, sum: 0 });
        const s = storeByType.get(key);
        s.count++;
        s.sum += currency === 'RUB' ? amount : 0; // 店级仅按 RUB 汇总

        if (!globalByType.has(key))
          globalByType.set(key, { count: 0, postings: new Set(), amounts: {}, skuSet: new Set() });
        const g = globalByType.get(key);
        g.count++;
        g.postings.add(p.posting_number);
        g.amounts[currency] = (g.amounts[currency] || 0) + amount;
        if (ac.sku) g.skuSet.add(ac.sku);
      }
    }

    perStore[store.name] = {
      postings: numbers.length,
      postingsWithAccruals: withAcc.length,
      byType: Object.fromEntries(
        [...storeByType.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([id, v]) => [id, { ...v, name: typeMap.get(id)?.name ?? '?' }]),
      ),
    };
    console.log(
      `[${store.name}] 货件 ${numbers.length}, 有应计 ${withAcc.length}, 类型 ${[...storeByType.keys()].join(',')}`,
    );
  }

  // 输出
  const result = {
    range: { since: SINCE, to: TO },
    totalPostings,
    postingsWithAccruals,
    types: [...globalByType.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([id, v]) => ({
        type_id: id,
        name: typeMap.get(id)?.name ?? '?',
        description: typeMap.get(id)?.description ?? '',
        accrualCount: v.count,
        postingCount: v.postings.size,
        skuCount: v.skuSet.size,
        amounts: v.amounts,
      })),
    perStore,
  };
  writeFileSync(join(__dirname, 'accrual-stats.json'), JSON.stringify(result, null, 2));

  // 控制台摘要
  console.log('\n=== 应计项目汇总 (2月至今, 6店铺) ===');
  console.log(
    'type_id | name | 出现次数 | 涉及货件 | 涉及SKU | 金额合计(RUB)'.replaceAll('|', ' | '),
  );
  for (const t of result.types) {
    console.log(
      `${t.type_id} | ${t.name} | ${t.accrualCount} | ${t.postingCount} | ${t.skuCount} | ${(
        t.amounts.RUB ?? 0
      ).toFixed(2)}`,
    );
  }
  console.log('\n原始统计已写入 scripts/accrual-stats.json');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
