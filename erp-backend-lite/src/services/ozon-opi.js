// Ozon OPI 客户端(api-seller.ozon.ru)
// 用于官方 API 跟卖(viaPortal=false):/v3/product/import、/v1/product/import/info 等
import { request } from 'undici';
import config from '../config/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import logger from '../middleware/log.js';

const BASE = config.ozonOpiBaseUrl;
const DEFAULT_TIMEOUT_MS = 60_000;

async function call(store, path, body, { method = 'POST', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!store?.sync_credentials?.clientId || !store?.sync_credentials?.apiKey) {
    throw new ApiError(
      ErrorCode.AUTH_REQUIRED,
      `店铺 ${store?.id} 未配置 sync_credentials.clientId/apiKey`
    );
  }
  const url = `${BASE}${path}`;
  try {
    const res = await request(url, {
      method,
      headers: {
        'Client-Id': store.sync_credentials.clientId,
        'Api-Key': store.sync_credentials.apiKey,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const text = await res.body.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    if (res.statusCode >= 400) {
      logger.warn({ url, status: res.statusCode, body: parsed }, 'OPI non-2xx');
      throw new ApiError(
        ErrorCode.NETWORK_ERROR,
        `OPI ${path} 返回 ${res.statusCode}: ${parsed?.message || text}`
      );
    }
    return parsed;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'HeadersTimeoutError' || e.name === 'BodyTimeoutError') {
      throw new ApiError(ErrorCode.TIMEOUT, `OPI ${path} 请求超时`);
    }
    logger.warn({ url, err: e?.message }, 'OPI network error');
    throw new ApiError(ErrorCode.NETWORK_ERROR, `OPI ${path} 网络错: ${e?.message || e}`);
  }
}

// /v3/product/import —— 创建商品(官方 API 跟卖)
// OPI v3 proto 必填字段(参考 docs/ozon-api/01-商品管理.md):
//   - items[].type_id: integer > 0,商品类型 ID(可从 /v1/description-category/tree 获取)
//   - items[].description_category_id: integer > 0,类目 ID
//   - items[].images: string[](URL 数组),不是 [{file_name, default}]
//   - items[].attributes: [{complex_id, id, values:[{value}]}] 不是 sv 的 {key, value/collection}
//   - items[].weight/depth/width/height/weight_unit/dimension_unit 均必填
//   - 不可带 _sourceVariant 等内部字段
//
// 字段来源映射:
//   - sv.description_category_id(归一化时来自 /search 的 description_type_dict_value)
//     实际是 type_id(描述类型的字典值),用作 OPI type_id
//   - 真正的 description_category_id 从 sv.categories[] 最深一级 id 取
export function productImport(store, items) {
  return call(store, '/v3/product/import', {
    items: items.map((it) => {
      const sv = it._sourceVariant || null;

      // 1) images: [{file_name, default}] → ["url1", ...]
      const images = Array.isArray(it.images)
        ? it.images.map((img) => (typeof img === 'string' ? img : img?.file_name || '')).filter(Boolean)
        : [];

      // 2) attributes: sv {key, value/collection} → OPI {complex_id, id, values:[{value}]}
      //    注意:OPI v3 字段名是 `id`(不是 attribute_id),参考文档第 67 行
      const attributes = [];
      const svAttrs = sv?.attributes || it.attributes || [];
      if (Array.isArray(svAttrs)) {
        for (const a of svAttrs) {
          const key = String(a.key || a.attribute_id || a.id || '');
          if (!key) continue;
          const vals = Array.isArray(a.collection)
            ? a.collection.filter((v) => v != null && v !== '').map((v) => String(v))
            : a.value != null && a.value !== ''
              ? [String(a.value)]
              : [];
          if (vals.length === 0) continue;
          attributes.push({
            complex_id: Number(a.complex_id) || 0,
            id: Number(key),
            values: vals.map((v) => ({ value: v })),
          });
        }
      }

      // 3) type_id:从 sv.description_category_id(实际是 description_type_dict_value)取
      //    这是 ozon /search 返回的描述类型字典值,对应 OPI 的 type_id
      const typeId = Number(sv?.description_category_id) || 0;

      // 4) description_category_id:从 sv.categories[] 最深一级 id 取
      //    categories[].id 是真实类目 ID,最深一级是叶子类目
      const cats = Array.isArray(sv?.categories) ? sv.categories : [];
      const deepestCat = cats
        .filter((c) => c.id)
        .sort((a, b) => Number(b.level || 0) - Number(a.level || 0))[0];
      const descriptionCategoryId = Number(deepestCat?.id) || 0;

      // 5) 物理参数(必填,缺省用 100 兜底,对齐 0.13 v3-payload.js:52-55)
      const weight = Number(it.weight) > 0 ? Math.round(Number(it.weight)) : 100;
      const depth = Number(it.depth) > 0 ? Math.round(Number(it.depth)) : 100;
      const width = Number(it.width) > 0 ? Math.round(Number(it.width)) : 100;
      const height = Number(it.height) > 0 ? Math.round(Number(it.height)) : 100;

      const opiItem = {
        name: String(it.name || ''),
        offer_id: String(it.offer_id || ''),
        price: it.price ? String(it.price) : '0',
        old_price: it.old_price ? String(it.old_price) : String(it.price || '0'),
        currency_code: it.currency_code || 'RUB',
        vat: it.vat || '0',
        images,
        description: it.description || it.scraped_description || '',
        attributes,
        // 必填字段:type_id + description_category_id
        type_id: typeId,
        description_category_id: descriptionCategoryId,
        // 必填物理参数
        weight,
        weight_unit: it.weight_unit || 'g',
        depth,
        width,
        height,
        dimension_unit: it.dimension_unit || 'mm',
      };

      // barcode(可选)
      const barcode = sv?._searchMeta?.barcodes?.[0] || it.barcode || '';
      if (barcode) opiItem.barcode = String(barcode);

      return opiItem;
    }),
  });
}

// /v1/product/import/info —— 查询任务进度
// 响应: { items: [{offer_id, product_id, status: 'pending'|'imported'|'failed'|'skipped', errors: []}], total }
export function productImportInfo(store, taskId) {
  return call(store, '/v1/product/import/info', { task_id: Number(taskId) });
}

// /v3/product/info/list —— 根据 offer_id 查询商品最终状态(创建/审核/可售)
// 响应关键字段:
//   items[].statuses.is_created       — 商品是否创建正确
//   items[].statuses.status           — 商品状态(如 active)
//   items[].statuses.moderate_status  — 审核状态
//   items[].statuses.validation_status — 验证状态
//   items[].errors[]                  — 创建/验证错误(空=无错)
//   items[].availabilities[].availability — 可售状态
//   items[].id                        — Ozon product_id
export function productInfoList(store, offerIds) {
  const arr = Array.isArray(offerIds) ? offerIds : [offerIds];
  return call(store, '/v3/product/info/list', { offer_id: arr.filter(Boolean) });
}

// /v2/product/info —— 查询商品数据(product-data 用)
export function productInfo(store, sku) {
  return call(store, '/v2/product/info', { sku: String(sku), offer_id: undefined });
}

// /v2/product/info/list —— 批量查询(按 sku)
export function productInfoListBySku(store, skus) {
  return call(store, '/v2/product/info/list', { skus: skus.map(String) });
}

// /v2/warehouse/list
export function warehouseList(store) {
  return call(store, '/v2/warehouse/list', {});
}

// /v3/category/tree —— 不需要 Api-Key 但需走 OPI 域名
export function categoryTree(store, language = 'DEFAULT') {
  return call(store, '/v3/category/tree', { language, }, { method: 'POST' });
}
