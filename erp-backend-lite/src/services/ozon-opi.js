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
    throw new ApiError(ErrorCode.AUTH_REQUIRED, `店铺 ${store?.id} 未配置 sync_credentials.clientId/apiKey`);
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
      throw new ApiError(ErrorCode.NETWORK_ERROR, `OPI ${path} 返回 ${res.statusCode}: ${parsed?.message || text}`);
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
    items: items.map(toOpiItem),
  });
}

/**
 * toOpiItem: 把单个 item 转换为 OPI v3 schema 格式(不发送)
 * 从 productImport 抽取,供预览接口(preview-opi)复用
 * 支持两种输入:
 *   1) 已经 transformItemForPortal 转换好的(isPreTransformed),直接透传
 *   2) 原始 message.items 格式(未转换),做兜底转换
 */
export function toOpiItem(it) {
  const sv = it._sourceVariant || null;
  const isPreTransformed =
    it.complex_attributes !== undefined ||
    it.primary_image !== undefined ||
    it.new_description_category_id !== undefined;

  if (isPreTransformed) {
    const opiItem = {
      name: String(it.name || ''),
      offer_id: String(it.offer_id || ''),
      price: it.price ? String(it.price) : '0',
      old_price: it.old_price ? String(it.old_price) : String(it.price || '0'),
      currency_code: it.currency_code || 'RUB',
      vat: it.vat || '0',
      images: Array.isArray(it.images) ? it.images : [],
      attributes: it.attributes || [],
      weight: Number(it.weight) > 0 ? Math.round(Number(it.weight)) : 100,
      weight_unit: it.weight_unit || 'g',
      depth: Number(it.depth) > 0 ? Math.round(Number(it.depth)) : 100,
      width: Number(it.width) > 0 ? Math.round(Number(it.width)) : 100,
      height: Number(it.height) > 0 ? Math.round(Number(it.height)) : 100,
      dimension_unit: it.dimension_unit || 'mm',
    };
    if (it.complex_attributes != null) opiItem.complex_attributes = it.complex_attributes;
    if (it.primary_image) opiItem.primary_image = String(it.primary_image);
    if (it.color_image) opiItem.color_image = String(it.color_image);
    if (Array.isArray(it.images360)) opiItem.images360 = it.images360;
    if (Array.isArray(it.pdf_list)) opiItem.pdf_list = it.pdf_list;
    if (it.type_id != null && Number(it.type_id) > 0) opiItem.type_id = Number(it.type_id);
    if (it.description_category_id != null && Number(it.description_category_id) > 0)
      opiItem.description_category_id = Number(it.description_category_id);
    if (it.new_description_category_id != null)
      opiItem.new_description_category_id = Number(it.new_description_category_id) || 0;
    if (it.barcode) opiItem.barcode = String(it.barcode);
    if (it.video_url) opiItem.video_url = String(it.video_url);
    if (it.video_cover) opiItem.video_cover = String(it.video_cover);
    return opiItem;
  }

  // 兜底:原 message.items 格式(未经过 transformItemForPortal)
  const images = Array.isArray(it.images)
    ? it.images.map((img) => (typeof img === 'string' ? img : img?.file_name || '')).filter(Boolean)
    : [];

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

  const descText = String(it.scraped_description || it.description || '').trim();
  if (descText && !attributes.some((a) => Number(a.id) === 4191)) {
    attributes.push({ complex_id: 0, id: 4191, values: [{ value: descText }] });
  }

  const typeId = Number(sv?.description_category_id) || 0;
  const cats = Array.isArray(sv?.categories) ? sv.categories : [];
  const deepestCat = cats.filter((c) => c.id).sort((a, b) => Number(b.level || 0) - Number(a.level || 0))[0];
  const descriptionCategoryId = Number(deepestCat?.id) || 0;

  const opiItem = {
    name: String(it.name || ''),
    offer_id: String(it.offer_id || ''),
    price: it.price ? String(it.price) : '0',
    old_price: it.old_price ? String(it.old_price) : String(it.price || '0'),
    currency_code: it.currency_code || 'RUB',
    vat: it.vat || '0',
    images,
    attributes,
    weight: Number(it.weight) > 0 ? Math.round(Number(it.weight)) : 100,
    weight_unit: it.weight_unit || 'g',
    depth: Number(it.depth) > 0 ? Math.round(Number(it.depth)) : 100,
    width: Number(it.width) > 0 ? Math.round(Number(it.width)) : 100,
    height: Number(it.height) > 0 ? Math.round(Number(it.height)) : 100,
    dimension_unit: it.dimension_unit || 'mm',
  };
  if (typeId > 0) opiItem.type_id = typeId;
  if (descriptionCategoryId > 0) opiItem.description_category_id = descriptionCategoryId;

  const barcode = sv?._searchMeta?.barcodes?.[0] || it.barcode || '';
  if (barcode) opiItem.barcode = String(barcode);

  return opiItem;
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
  return call(store, '/v3/category/tree', { language }, { method: 'POST' });
}

// /v4/product/info/attributes —— 批量查询商品属性值
// filter 可为 { offer_id: [string] } 或 { product_id: [number] } 或 { sku: [number] }
// 响应: { items: [{product_id, offer_id, attributes:[{attribute_id, complex_id, values:[{value}]}]}] }
export function productInfoAttributes(store, filter) {
  return call(store, '/v4/product/info/attributes', { filter, limit: 100 });
}

// /v1/product/info/description —— 查询单个商品的描述(富文本)
// body 可为 { offer_id: string } 或 { product_id: number },直接透传
// 响应: { description: string }
export function productInfoDescription(store, body) {
  return call(store, '/v1/product/info/description', body);
}

// /v3/product/list —— 获取商品列表(游标分页)
// 用途: 拉取店铺全部商品标识符,通过 last_id 翻页直到返回 last_id 为空字符串
// 请求体: { filter, last_id, limit }
//   - filter: 可选,缺省 { visibility: 'ALL' }
//     · { visibility: 'ALL'|'VISIBLE'|'INVISIBLE'|'EMPTY_STOCK'|'NOT_MODERATED'|'MODERATED'|'DISABLED' }
//     · { offer_id: [string], product_id: [number] } —— 按标识符精确筛选
//   - last_id: 游标,首次传 ''(空字符串),后续取上次响应的 last_id
//   - limit: 每页条数,缺省 1000(最大 1000)
// 响应: { items: [{ product_id, offer_id }], last_id: string, total: number }
export function productList(store, { filter, lastId, limit } = {}) {
  return call(store, '/v3/product/list', {
    filter: filter || { visibility: 'ALL' },
    last_id: lastId || '',
    limit: limit || 1000,
  });
}

// /v3/product/info/list —— 根据标识符批量获取商品完整信息(v3 升级版,支持 sku 过滤)
// 用途: 相比 v2 版本,新增 sku 维度过滤,可按 offer_id / product_id / sku 任意组合查询
// 请求体: 从 offerIds / productIds / skus 中取非 undefined 的字段构造
//   { offer_id: [string], product_id: [number], sku: [number] }(仅写入已提供的字段)
// 响应: { items: [<完整商品信息>], total: number }
export function productInfoListV3(store, { offerIds, productIds, skus } = {}) {
  const body = {};
  if (offerIds) body.offer_id = offerIds;
  if (productIds) body.product_id = productIds;
  if (skus) body.sku = skus;
  return call(store, '/v3/product/info/list', body);
}
