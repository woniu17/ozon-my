// 按货件号批量补充商品主图(2026-10-30)
// Ozon 货运接口(/v1/assembly/carriage/posting/list、/v4/posting/fbs/unfulfilled/list)
// 返回的 products 不含 image_url;本地商品缓存(product_data_cache.primary_image/images)
// 与订单 SKU 一一对应,按 posting_number 批量反查后按 sku/offer_id 挂回 products[].image_url。
// 2026-11-04:从 order-process.js 提取,历史发运同步(读路径写回快照)同样需要挂图。
import { db } from '../db/index.js';
import { imageCacheUrlFor } from './order-image-cache.js';

export function attachPostingProductImages(storeId, postings) {
  if (!Array.isArray(postings) || !postings.length) return postings;
  const numbers = [...new Set(postings.map((p) => p?.posting_number).filter(Boolean))];
  if (!numbers.length) return postings;
  const placeholders = numbers.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT o.posting_number, oi.sku, oi.offer_id, oi.title,
              COALESCE(json_extract(p.data, '$.primary_image[0]'), json_extract(p.data, '$.images[0]')) AS pic_url
       FROM op_ozon_order_item oi
       JOIN op_ozon_order o ON o.id = oi.ozon_order_id
       LEFT JOIN product_data_cache p ON p.sku = CAST(oi.sku AS TEXT)
       WHERE o.store_id = ? AND o.posting_number IN (${placeholders})`
    )
    .all(storeId, ...numbers);
  const byPosting = new Map();
  for (const r of rows) {
    if (!byPosting.has(r.posting_number)) byPosting.set(r.posting_number, []);
    byPosting.get(r.posting_number).push({
      sku: r.sku,
      offerId: r.offer_id,
      title: r.title,
      picUrl: imageCacheUrlFor(r.pic_url),
    });
  }
  for (const p of postings) {
    const imgs = byPosting.get(p?.posting_number) || [];
    for (const prod of p?.products || []) {
      const found =
        imgs.find((i) => i.sku != null && String(i.sku) === String(prod?.sku)) ||
        imgs.find((i) => i.offerId && i.offerId === prod?.offer_id);
      if (found) prod.image_url = found.picUrl;
    }
  }
  return postings;
}