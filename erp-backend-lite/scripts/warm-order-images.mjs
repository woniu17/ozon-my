// 存量图片预热脚本(2026-10,订单图片本地化)
// 把历史订单商品主图(product_data_cache 中订单出现过的 SKU)与采购商品主图
// (op_purchase_order.items_json)一次性下载到本地图床 public/images/cache/,
// 让上线后首访即命中,避免懒下载慢加载。
//
// 用法: node erp-backend-lite/scripts/warm-order-images.mjs [--limit N] [--all]
//   --limit N  只预热前 N 张(调试用,默认 0=全部)
//   --all      预热全部 product_data_cache 主图(默认只预热订单出现过的 SKU)
//
// 幂等:已存在的缓存文件直接跳过;下载失败仅告警,不影响其他图片。
// 注意:只读直连 erp.db(不 import db/index.js,避免启动迁移与生产服务抢锁)。
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureImageCached } from '../src/services/order-image-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'erp.db');
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? Number(process.argv[i + 1]) || 0 : 0;
})();
const WARM_ALL = process.argv.includes('--all');

// 1. 收集 Ozon 商品主图(与 getItemsByOrderIds 同源:primary_image[0] 优先,images[0] 兜底)
//    默认只取订单里出现过的 SKU(约千张);--all 时取整个缓存表
const skuFilter = WARM_ALL ? '' : 'JOIN op_ozon_order_item oi ON CAST(oi.sku AS TEXT) = p.sku';
const ozonRows = db
  .prepare(
    `SELECT DISTINCT
       COALESCE(json_extract(p.data, '$.primary_image[0]'), json_extract(p.data, '$.images[0]')) AS img
     FROM product_data_cache p
     ${skuFilter}
     WHERE COALESCE(json_extract(p.data, '$.primary_image[0]'), json_extract(p.data, '$.images[0]')) IS NOT NULL`
  )
  .all();

// 2. 收集采购商品主图(解析 items_json 的 thumbUrl)
const poRows = db
  .prepare(`SELECT items_json FROM op_purchase_order WHERE items_json IS NOT NULL AND items_json LIKE '%thumbUrl%'`)
  .all();

const seen = new Set();
const urls = [];
function pushImg(u) {
  if (u && typeof u === 'string' && u.trim() && !seen.has(u)) {
    seen.add(u);
    urls.push(u.trim());
  }
}
for (const r of ozonRows) pushImg(r.img);
for (const po of poRows) {
  try {
    const items = JSON.parse(po.items_json) || [];
    for (const it of items) pushImg(it.thumbUrl);
  } catch {
    // 脏数据跳过
  }
}

const target = LIMIT > 0 ? urls.slice(0, LIMIT) : urls;
const TOTAL = target.length;
console.log(`[warm] 收集到去重图片 ${urls.length} 张,本次处理 ${TOTAL} 张`);

// 3. 小并发预热(默认 5,避免对平台 CDN 突发压力)
const CONCURRENCY = 5;
let done = 0;
async function worker() {
  while (target.length > 0) {
    const url = target.pop();
    if (!url) break;
    await ensureImageCached(url);
    done++;
    if (done % 100 === 0 || done === TOTAL) {
      console.log(`[warm] 进度 ${done}/${TOTAL}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log(`[warm] 完成 ${done}/${TOTAL}`);
db.close();
process.exit(0);