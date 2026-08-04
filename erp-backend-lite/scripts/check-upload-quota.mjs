// 一次性脚本: 查询六个店铺的上传配额 + 归档商品数量
// 用法: node erp-backend-lite/scripts/check-upload-quota.mjs
//
// 接口:
//   - /v4/product/info/limit: 账号总数 / 日建 / 日更 配额
//   - /v3/product/list {filter.visibility: 'ARCHIVED'}: 归档商品总数(直接读 result.total,无需翻页)
//
// 注: Ozon /v4 total.usage 包含归档商品,实际可用额度需扣减归档数
import { request } from 'undici';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const storesPath = join(__dirname, '../src/config/stores.json');
const stores = JSON.parse(readFileSync(storesPath, 'utf8'));

const BASE = 'https://api-seller.ozon.ru';
const TIMEOUT_MS = 30_000;

async function callApi(store, path, body) {
  const url = `${BASE}${path}`;
  const res = await request(url, {
    method: 'POST',
    headers: {
      'Client-Id': store.sync_credentials.clientId,
      'Api-Key': store.sync_credentials.apiKey,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : '{}',
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  });
  const text = await res.body.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.statusCode, data: parsed };
}

async function queryStore(store) {
  const out = { store: store.name, quota: null, archived: null, err: null };

  // 1) 上传配额
  try {
    const q = await callApi(store, '/v4/product/info/limit');
    if (q.status >= 400) {
      out.err = `quota HTTP ${q.status}: ${q.data?.message || JSON.stringify(q.data)}`;
    } else {
      out.quota = q.data;
    }
  } catch (e) {
    out.err = `quota 异常: ${e?.message || e}`;
  }

  // 2) 归档商品数(细分: ARCHIVED 全部 + AUTO/MANUAL/SEASONAL 三个子类)
  //    并发调用,失败项留 null
  const visibilities = ['ARCHIVED', 'AUTO_ARCHIVED', 'MANUAL_ARCHIVED', 'SEASONAL_AUTO_ARCHIVED'];
  const entries = await Promise.allSettled(
    visibilities.map((v) =>
      callApi(store, '/v3/product/list', {
        filter: { visibility: v },
        last_id: '',
        limit: 1, // 只关心 total 字段,limit 取最小值减少数据量
      }).then((r) => ({ v, r }))
    )
  );
  const archived = {};
  for (let i = 0; i < visibilities.length; i++) {
    const v = visibilities[i];
    const e = entries[i];
    if (e.status === 'fulfilled') {
      const { r } = e.value;
      if (r.status < 400) {
        archived[v] = r.data?.result?.total ?? null;
      } else {
        archived[v] = `HTTP ${r.status}`;
      }
    } else {
      archived[v] = `err: ${e.reason?.message || e.reason}`;
    }
  }
  out.archived = archived;
  return out;
}

function fmtPct(usage, limit) {
  if (limit === -1) return '无限制';
  if (!limit) return '-';
  return `${((usage / limit) * 100).toFixed(1)}%`;
}

function summarize(r) {
  if (r.err && !r.quota) {
    return `  [${r.store}] 失败: ${r.err}`;
  }
  const d = r.quota || {};
  const dc = d.daily_create || {};
  const du = d.daily_update || {};
  const ol = d.operation_limits || {};
  const t = d.total || {};
  const a = r.archived || {};
  const archivedTotal = typeof a.ARCHIVED === 'number' ? a.ARCHIVED : null;
  const effectiveUsage = archivedTotal !== null && typeof t.usage === 'number' ? t.usage - archivedTotal : t.usage;
  const lines = [
    `  [${r.store}]`,
    `    total(账号总数):     usage=${t.usage ?? '-'} / limit=${t.limit ?? '-'} (${fmtPct(t.usage, t.limit)})` +
      (archivedTotal !== null
        ? `\n      扣除归档后:      usage=${effectiveUsage} - archived=${archivedTotal} = ${effectiveUsage} / limit=${t.limit ?? '-'} (${fmtPct(effectiveUsage, t.limit)})`
        : ''),
    `    archived(归档总数):  ${a.ARCHIVED ?? '-'}` +
      `  (auto=${a.AUTO_ARCHIVED ?? '-'} manual=${a.MANUAL_ARCHIVED ?? '-'} seasonal=${a.SEASONAL_AUTO_ARCHIVED ?? '-'})`,
    `    daily_create(日建):  usage=${dc.usage ?? '-'} / limit=${dc.limit ?? '-'} (${fmtPct(dc.usage, dc.limit)})  reset_at=${dc.reset_at || '-'}`,
    `    daily_update(日更):  usage=${du.usage ?? '-'} / limit=${du.limit ?? '-'} (${fmtPct(du.usage, du.limit)})  reset_at=${du.reset_at || '-'}`,
    `    operation_limits:   limit=${ol.limit ?? '-'}  type=${ol.limit_type ?? '-'}`,
  ];
  if (r.err) lines.push(`    [警告] ${r.err}`);
  return lines.join('\n');
}

console.log(`开始查询 ${stores.length} 个店铺的配额 + 归档数 ...\n`);
const results = await Promise.allSettled(stores.map(queryStore));

for (let i = 0; i < stores.length; i++) {
  const r = results[i];
  if (r.status === 'fulfilled') {
    console.log(summarize(r.value));
  } else {
    console.log(`  [${stores[i].name}] 整体异常: ${r.reason?.message || r.reason}`);
  }
}
console.log('\n查询完成.');
