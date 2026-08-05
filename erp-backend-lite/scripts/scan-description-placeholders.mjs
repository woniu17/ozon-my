// 一次性只读扫描:检查采集数据中的描述/简介是否含 Ozon「加载失败」占位文案
// 用法: node erp-backend-lite/scripts/scan-description-placeholders.mjs
//
// 扫描范围(覆盖所有描述存储位置):
//   1. ozon_rich_media_cache.data.{description, richContent}        — page-json 抽取
//   2. ozon_attribute_cache.{search_data, bundle_data}.attributes   — seller-portal 4191/11254
//   3. ozon_dom_cache.detail_data                                   — PDP DOM 解析
//   4. product_attributes_cache.{description_data, attributes_data} — OPI /v1 + /v4 缓存
//   5. follow_sell_task_payloads.payload                            — 实际提交 OPI 的 payload
//
// 分类:
//   - placeholder  : 整段是占位/按钮文案(剥完为空或开头命中加载失败关键词)→ 严重,会被原样上架
//   - has_button   : 真描述末尾粘了按钮文案 → 轻微,代码会剥掉
//   - has_fail_kw  : 描述含加载失败关键词但非开头 → 罕见,人工复核
//
// 与 lib/follow-sell-content-copy.js 的 isPlaceholderDescriptionText / stripDescriptionUiChrome 同口径
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'erp.db');

const UI_CHROME_RE = /(читать далее|показать полностью|свернуть описание|развернуть описание)/gi;
const LOAD_FAIL_RE = /(не удалось загрузить|ошибка загрузки|попробуйте (обновить|позже)|failed to load)/i;

function safeText(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function stripUiChrome(value) {
  return safeText(String(value == null ? '' : value).replace(UI_CHROME_RE, ' '));
}

function classify(value) {
  const raw = safeText(value);
  if (!raw) return null;
  const cleaned = stripUiChrome(raw);
  if (!cleaned) return 'placeholder';
  if (LOAD_FAIL_RE.test(cleaned.slice(0, 120))) return 'placeholder';
  if (UI_CHROME_RE.test(raw)) return 'has_button';
  if (LOAD_FAIL_RE.test(cleaned)) return 'has_fail_kw';
  return null;
}

// 从 search_data / bundle_data 提取 attr 4191/11254 的值
function readAttrFromItems(jsonStr, attrKey) {
  if (!jsonStr) return [];
  try {
    const doc = JSON.parse(jsonStr);
    const items = Array.isArray(doc?.items) ? doc.items : Array.isArray(doc?.attributes) ? [doc] : [];
    const out = [];
    for (const item of items) {
      const attrs = Array.isArray(item?.attributes) ? item.attributes : [];
      const hit = attrs.find((a) => String(a?.key ?? a?.id) === String(attrKey));
      const v = hit?.value ?? (Array.isArray(hit?.collection) ? hit.collection.join(' ') : '');
      if (v) out.push({ variantId: item?.variant_id || null, value: String(v) });
    }
    return out;
  } catch {
    return [];
  }
}

function readPayloadDesc(payloadStr) {
  if (!payloadStr) return null;
  try {
    const doc = JSON.parse(payloadStr);
    // stage=raw: items[].attributes[{key, value}]
    // stage=transformed: items[].attributes[{key, value}] (与 raw 同构,经过 transformItemForPortal)
    // stage=opi_request: items[].description(顶层) + items[].attributes[{complex_id, id, values:[{value}]}]
    //   注:opi_request 的 attr 值在 values[].value 里,不是 .value!
    //   例:attributes[13].values[0].value = "Не удалось загрузить статью…"
    const items = Array.isArray(doc?.items) ? doc.items : [];
    const out = [];
    for (const item of items) {
      const desc = item?.description;
      if (desc) out.push({ field: 'description', value: String(desc) });
      const attrs = Array.isArray(item?.attributes) ? item.attributes : [];
      for (const a of attrs) {
        const key = String(a?.key ?? a?.id ?? '');
        if (key !== '4191' && key !== '11254') continue;
        // 兼容两种结构:raw/transformed 用 .value;opi_request 用 .values[].value
        const val = a?.value ?? (Array.isArray(a?.values) ? a.values.map((v) => v?.value).filter(Boolean).join(' ') : '');
        if (val) out.push({ field: `attr_${key}`, value: String(val) });
      }
    }
    return out;
  } catch {
    return null;
  }
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
db.exec('PRAGMA journal_mode = WAL;');

const findings = [];

// ── 1. ozon_rich_media_cache ───────────────────────────────────
{
  const rows = db.prepare(`SELECT _id AS sku, data FROM ozon_rich_media_cache`).all();
  for (const r of rows) {
    let doc;
    try {
      doc = JSON.parse(r.data);
    } catch {
      continue;
    }
    for (const field of ['description', 'richContent']) {
      const v = doc?.[field];
      if (typeof v !== 'string' || !v) continue;
      const cls = classify(v);
      if (cls) findings.push({ table: 'ozon_rich_media_cache', sku: r.sku, field, kind: cls, snippet: safeText(v).slice(0, 200) });
    }
  }
}

// ── 2. ozon_attribute_cache (search_data + bundle_data 的 4191/11254) ──
{
  const rows = db.prepare(`SELECT _id AS sku, search_data, bundle_data FROM ozon_attribute_cache`).all();
  for (const r of rows) {
    for (const [col, val] of [['search', r.search_data], ['bundle', r.bundle_data]]) {
      if (!val) continue;
      for (const attrKey of ['4191', '11254']) {
        const hits = readAttrFromItems(val, attrKey);
        for (const h of hits) {
          const cls = classify(h.value);
          if (cls) {
            findings.push({
              table: 'ozon_attribute_cache',
              sku: r.sku,
              field: `${col}.${attrKey}${h.variantId ? '#' + h.variantId : ''}`,
              kind: cls,
              snippet: safeText(h.value).slice(0, 200),
            });
          }
        }
      }
    }
  }
}

// ── 3. ozon_dom_cache.detail_data ──────────────────────────────
{
  const rows = db.prepare(`SELECT _id AS sku, detail_data FROM ozon_dom_cache WHERE detail_data IS NOT NULL`).all();
  for (const r of rows) {
    let doc;
    try {
      doc = JSON.parse(r.detail_data);
    } catch {
      continue;
    }
    // detail_data 里没有专门的 description 字段(DOM 解析不抽描述),但兜底扫所有 string 字段
    const visit = (node, path) => {
      if (typeof node === 'string') {
        if (node.length < 8 || node.length > 8000) return;
        const cls = classify(node);
        if (cls) findings.push({ table: 'ozon_dom_cache', sku: r.sku, field: `detail_data.${path}`, kind: cls, snippet: safeText(node).slice(0, 200) });
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((v, i) => visit(v, `${path}[${i}]`));
        return;
      }
      if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) visit(node[k], `${path}.${k}`);
      }
    };
    visit(doc, '');
  }
}

// ── 4. product_attributes_cache ────────────────────────────────
{
  const rows = db
    .prepare(`SELECT sku, attributes_data, description_data FROM product_attributes_cache`)
    .all();
  for (const r of rows) {
    // 4a. description_data (/v1/product/info/description 原始 JSON)
    if (r.description_data) {
      try {
        const doc = JSON.parse(r.description_data);
        // description_data 通常是 { description: "...", ... }
        const desc = doc?.description || doc?.data?.description;
        if (desc) {
          const cls = classify(desc);
          if (cls) findings.push({ table: 'product_attributes_cache', sku: r.sku, field: 'description_data.description', kind: cls, snippet: safeText(desc).slice(0, 200) });
        }
      } catch {}
    }
    // 4b. attributes_data (/v4/product/info/attributes,含 4191/11254)
    if (r.attributes_data) {
      const hits = readAttrFromItems(r.attributes_data, '4191');
      for (const h of hits) {
        const cls = classify(h.value);
        if (cls) findings.push({ table: 'product_attributes_cache', sku: r.sku, field: `attributes_data.4191${h.variantId ? '#' + h.variantId : ''}`, kind: cls, snippet: safeText(h.value).slice(0, 200) });
      }
    }
  }
}

// ── 5. follow_sell_task_payloads ───────────────────────────────
const payloadFindings = []; // 单独收集,后面交叉验证上架结果用
{
  const rows = db
    .prepare(`SELECT id, local_task_id, store_id, stage, payload FROM follow_sell_task_payloads`)
    .all();
  for (const r of rows) {
    const descs = readPayloadDesc(r.payload);
    if (!descs) continue;
    for (const d of descs) {
      const cls = classify(d.value);
      if (cls) {
        const f = {
          table: 'follow_sell_task_payloads',
          sku: `${r.local_task_id}#${r.id}`,
          field: `${r.stage}.${d.field}`,
          kind: cls,
          snippet: safeText(d.value).slice(0, 200),
          _localTaskId: r.local_task_id,
          _stage: r.stage,
          _storeId: r.store_id,
          _rawValue: d.value,
        };
        findings.push(f);
        payloadFindings.push(f);
      }
    }
  }
}

// ── 6. 交叉验证:含占位的 opi_request payload 实际上架结果 ──────
// opi_request 是最终提交 OPI 的请求体;join follow_sell_task_items 看实际 status
const uploadOutcome = { placeholder: { imported: 0, failed: 0, pending: 0, skipped: 0, unknown: 0 }, has_button: { imported: 0, failed: 0, pending: 0, skipped: 0, unknown: 0 } };
{
  // 按 local_task_id 聚合(一个 task 可能有多个 items,但 payload 表按 task+stage 存全量)
  // opi_request 含占位 → 取该 task 下所有 task_items 的 status 分布
  const opiContaminatedTasks = new Map(); // localTaskId -> { kind, storeId }
  for (const f of payloadFindings) {
    if (f._stage !== 'opi_request') continue;
    // 一个 task 可能既被 placeholder 又被 has_button 命中,取更严重的
    const existing = opiContaminatedTasks.get(f._localTaskId);
    if (!existing || (existing.kind === 'has_button' && f.kind === 'placeholder')) {
      opiContaminatedTasks.set(f._localTaskId, { kind: f.kind, storeId: f._storeId });
    }
  }

  for (const [localTaskId, info] of opiContaminatedTasks) {
    const items = db
      .prepare(`SELECT offer_id, status, has_error FROM follow_sell_task_items WHERE local_task_id = ?`)
      .all(localTaskId);
    if (items.length === 0) {
      uploadOutcome[info.kind].unknown++;
      continue;
    }
    for (const item of items) {
      // imported + has_error=1 视为审核拒绝(失败);imported + has_error=0 视为成功上架
      let bucket;
      if (item.status === 'imported' && item.has_error === 1) bucket = 'failed';
      else if (item.status === 'imported') bucket = 'imported';
      else if (item.status === 'failed') bucket = 'failed';
      else if (item.status === 'skipped') bucket = 'skipped';
      else if (item.status === 'pending') bucket = 'pending';
      else bucket = 'unknown';
      uploadOutcome[info.kind][bucket]++;
    }
  }
}

db.close();

// ── 输出报告 ───────────────────────────────────────────────────
const byKind = { placeholder: [], has_button: [], has_fail_kw: [] };
for (const f of findings) byKind[f.kind]?.push(f);

const byTable = {};
for (const f of findings) {
  byTable[f.table] = byTable[f.table] || { placeholder: 0, has_button: 0, has_fail_kw: 0 };
  byTable[f.table][f.kind]++;
}

// payload 按 stage 拆分统计
const payloadByStage = {};
for (const f of payloadFindings) {
  const key = `${f._stage}`;
  payloadByStage[key] = payloadByStage[key] || { placeholder: 0, has_button: 0, has_fail_kw: 0 };
  payloadByStage[key][f.kind]++;
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  描述占位文案扫描报告');
console.log('  数据库: erp-backend-lite/data/erp.db (只读)');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('【按表汇总】(命中条数,同一 SKU 在不同字段命中算多条)');
console.log('表名                                placeholder  has_button  has_fail_kw');
for (const [t, c] of Object.entries(byTable).sort()) {
  console.log(`${t.padEnd(36)}${String(c.placeholder).padStart(11)}${String(c.has_button).padStart(12)}${String(c.has_fail_kw).padEnd(13)}`);
}
console.log('');

console.log('【follow_sell_task_payloads 按 stage 拆分】');
console.log('  raw         = 插件原始 message.items(transform 前)');
console.log('  transformed = transformItemForPortal 输出');
console.log('  opi_request = 最终提交 OPI 的请求体(★ 关键:实际发到 Ozon 的数据)');
console.log('  opi_response= OPI 查询响应');
console.log('stage             placeholder  has_button  has_fail_kw');
for (const [s, c] of Object.entries(payloadByStage).sort()) {
  console.log(`${s.padEnd(18)}${String(c.placeholder).padStart(11)}${String(c.has_button).padStart(12)}${String(c.has_fail_kw).padEnd(13)}`);
}
console.log('');

console.log('【★ 含占位的 opi_request 实际上架结果】(交叉验证 follow_sell_task_items.status)');
console.log('  imported = 成功上架到 Ozon(可能已展示给买家)');
console.log('  failed   = 审核拒绝 / has_error=1');
console.log('  pending/skipped/unknown = 未成功上架');
console.log('─'.repeat(80));
console.log(`  placeholder(整段占位):  imported=${uploadOutcome.placeholder.imported}  failed=${uploadOutcome.placeholder.failed}  pending=${uploadOutcome.placeholder.pending}  skipped=${uploadOutcome.placeholder.skipped}  unknown=${uploadOutcome.placeholder.unknown}`);
console.log(`  has_button(粘按钮文案): imported=${uploadOutcome.has_button.imported}  failed=${uploadOutcome.has_button.failed}  pending=${uploadOutcome.has_button.pending}  skipped=${uploadOutcome.has_button.skipped}  unknown=${uploadOutcome.has_button.unknown}`);
console.log('');

// 仅展示 follow_sell_task_payloads opi_request 的 placeholder 详情(其他表数据量大,只看汇总)
const opiPlaceholder = payloadFindings.filter((f) => f._stage === 'opi_request' && f.kind === 'placeholder');
const opiHasButton = payloadFindings.filter((f) => f._stage === 'opi_request' && f.kind === 'has_button');

console.log(`【opi_request placeholder 详情】${opiPlaceholder.length} 条(仅展示前 50)`);
console.log('─'.repeat(125));
for (const f of opiPlaceholder.slice(0, 50)) {
  console.log(`  task=${f._localTaskId}  store=${f._storeId}`);
  console.log(`    snippet: ${f.snippet}`);
}
if (opiPlaceholder.length > 50) console.log(`  ... 还有 ${opiPlaceholder.length - 50} 条`);
console.log('');

console.log(`【ozon_rich_media_cache placeholder 详情】${byKind.placeholder.filter((f) => f.table === 'ozon_rich_media_cache').length} 条(仅展示前 20,数据量大)`);
console.log('─'.repeat(125));
const rmcPlaceholder = byKind.placeholder.filter((f) => f.table === 'ozon_rich_media_cache');
for (const f of rmcPlaceholder.slice(0, 20)) {
  console.log(`  sku=${f.sku}  field=${f.field}`);
  console.log(`    snippet: ${f.snippet}`);
}
if (rmcPlaceholder.length > 20) console.log(`  ... 还有 ${rmcPlaceholder.length - 20} 条`);
console.log('');

console.log('═══════════════════════════════════════════════════════════════');
console.log(`  合计命中: ${findings.length} 条`);
console.log(`    placeholder  (严重): ${byKind.placeholder.length}`);
console.log(`      └─ opi_request 已提交 OPI: ${opiPlaceholder.length}`);
console.log(`      └─ 其中 imported(已上架): ${uploadOutcome.placeholder.imported}`);
console.log(`    has_button   (轻微): ${byKind.has_button.length}`);
console.log(`      └─ opi_request 已提交 OPI: ${opiHasButton.length}`);
console.log(`      └─ 其中 imported(已上架): ${uploadOutcome.has_button.imported}`);
console.log(`    has_fail_kw  (复核): ${byKind.has_fail_kw.length}`);
console.log('═══════════════════════════════════════════════════════════════');
