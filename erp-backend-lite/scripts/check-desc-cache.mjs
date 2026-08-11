// 临时脚本:查询 SKU 3661324574 的最近采集日志 + 当前 dom detail 缓存写入时间 + 描述内容
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'erp.db');
const sku = '3661324574';

const db = new DatabaseSync(DB_PATH, { readOnly: true });

console.log('当前 UTC 时间:', new Date().toISOString());
console.log('SKU:', sku);

// 1. dom 缓存时间 + 描述内容
const domRow = db.prepare(
  `SELECT detail_data, card_data, detail_fetched_at, card_fetched_at FROM ozon_dom_cache WHERE _id = ?`
).get(sku);
console.log('\n[dom 缓存时间]');
console.log('  detail_fetched_at:', domRow?.detail_fetched_at || '无');
console.log('  card_fetched_at:', domRow?.card_fetched_at || '无');

if (domRow?.detail_data) {
  try {
    const d = JSON.parse(domRow.detail_data);
    const desc = d.description || '';
    console.log('\n[detail_data.description]');
    console.log('  长度:', desc.length);
    console.log('  含 <ul>:', /<ul/i.test(desc));
    console.log('  含 <li>:', /<li/i.test(desc));
    console.log('  含 <br>:', /<br/i.test(desc));
    console.log('  含 <p>:', /<p/i.test(desc));
    console.log('  前 500 字符:\n', desc.slice(0, 500));
    console.log('  ---');
    console.log('  后 300 字符:\n', desc.slice(-300));
  } catch (e) {
    console.log('  解析失败:', e.message);
  }
}

// 2. attribute cache (bundle attr 4191 + richMedia)
const attrRow = db.prepare(
  `SELECT bundle_data, search_data, bundle_fetched_at, search_fetched_at FROM ozon_attribute_cache WHERE _id = ?`
).get(sku);
console.log('\n[attribute 缓存时间]');
console.log('  bundle_fetched_at:', attrRow?.bundle_fetched_at || '无');
console.log('  search_fetched_at:', attrRow?.search_fetched_at || '无');

if (attrRow?.bundle_data) {
  try {
    const b = JSON.parse(attrRow.bundle_data);
    const attrs = b.attributes || [];
    const descAttr = attrs.find((a) => String(a.id) === '4191');
    console.log('\n[bundle attr 4191 (description)]');
    if (descAttr) {
      const v = descAttr.value || '';
      console.log('  长度:', v.length);
      console.log('  含 <ul>:', /<ul/i.test(v));
      console.log('  含 <br>:', /<br/i.test(v));
      console.log('  前 300 字符:', v.slice(0, 300));
    } else {
      console.log('  不存在');
    }

    const richMedia = b.richMedia || {};
    const rmDesc = richMedia.description || '';
    console.log('\n[bundle richMedia.description]');
    console.log('  长度:', rmDesc.length);
    if (rmDesc) {
      console.log('  含 <ul>:', /<ul/i.test(rmDesc));
      console.log('  含 <br>:', /<br/i.test(rmDesc));
      console.log('  前 300 字符:', rmDesc.slice(0, 300));
    }
  } catch (e) {
    console.log('  解析失败:', e.message);
  }
}

// 3. 采集日志(最近 10 条)
console.log('\n[最近采集日志]');
const logs = db.prepare(
  `SELECT _id, sku, source, status, results, collectedAt
   FROM ozon_auto_collect_log
   WHERE sku = ?
   ORDER BY collectedAt DESC
   LIMIT 10`
).all(sku);
if (logs.length === 0) {
  console.log('  无采集日志');
} else {
  for (const l of logs) {
    console.log(`  ${l.collectedAt} | ${l.source || '-'} | ${l.status}`);
    if (l.results) {
      try {
        const r = JSON.parse(l.results);
        for (const item of r) {
          console.log(`    - ${item.type}: ${item.hit ? 'hit' : 'miss'}${item.error ? ' | ' + item.error : ''}`);
        }
      } catch {}
    }
  }
}
