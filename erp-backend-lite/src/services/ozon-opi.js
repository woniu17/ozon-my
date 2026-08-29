// Ozon OPI 客户端(api-seller.ozon.ru)
// 用于官方 API 跟卖(viaPortal=false):/v3/product/import、/v1/product/import/info 等
import { request } from 'undici';
import config from '../config/index.js';
import { ApiError, ErrorCode } from '../utils/error-codes.js';
import logger from '../middleware/log.js';
import * as metaDao from '../db/dao/sqlite/meta-dao.js';

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
      throw new ApiError(ErrorCode.NETWORK_ERROR, `OPI ${path} 返回 ${res.statusCode}: ${parsed?.message || text}`, {
        details: { httpStatus: res.statusCode, body: parsed },
      });
    }
    return parsed;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // 连接超时(TCP 握手阶段):请求未到达 Ozon,重试安全
    if (e.name === 'ConnectTimeoutError') {
      throw new ApiError(ErrorCode.TIMEOUT, `OPI ${path} 连接超时`, { details: { kind: 'connect_timeout' } });
    }
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
      weight: Number(it.weight) > 0 ? Math.round(Number(it.weight)) : 100,
      weight_unit: it.weight_unit || 'g',
      depth: Number(it.depth) > 0 ? Math.round(Number(it.depth)) : 100,
      width: Number(it.width) > 0 ? Math.round(Number(it.width)) : 100,
      height: Number(it.height) > 0 ? Math.round(Number(it.height)) : 100,
      dimension_unit: it.dimension_unit || 'mm',
    };
    if (it.primary_image) opiItem.primary_image = String(it.primary_image);
    if (it.color_image) opiItem.color_image = String(it.color_image);
    if (it.type_id != null && Number(it.type_id) > 0) opiItem.type_id = Number(it.type_id);
    if (it.description_category_id != null && Number(it.description_category_id) > 0)
      opiItem.description_category_id = Number(it.description_category_id);
    // if (it.new_description_category_id != null)
    //   opiItem.new_description_category_id = Number(it.new_description_category_id) || 0;
    // if (it.barcode) opiItem.barcode = String(it.barcode);
    if (it.video_url) opiItem.video_url = String(it.video_url);
    if (it.video_cover) opiItem.video_cover = String(it.video_cover);
    // 末尾按约定顺序追加:images → images360 → pdf_list → attributes → complex_attributes
    opiItem.images = Array.isArray(it.images) ? it.images : [];
    // if (Array.isArray(it.images360)) opiItem.images360 = it.images360;
    if (Array.isArray(it.pdf_list)) opiItem.pdf_list = it.pdf_list;
    opiItem.attributes = it.attributes || [];
    if (it.complex_attributes != null) opiItem.complex_attributes = it.complex_attributes;
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
    weight: Number(it.weight) > 0 ? Math.round(Number(it.weight)) : 100,
    weight_unit: it.weight_unit || 'g',
    depth: Number(it.depth) > 0 ? Math.round(Number(it.depth)) : 100,
    width: Number(it.width) > 0 ? Math.round(Number(it.width)) : 100,
    height: Number(it.height) > 0 ? Math.round(Number(it.height)) : 100,
    dimension_unit: it.dimension_unit || 'mm',
  };
  if (typeId > 0) opiItem.type_id = typeId;
  if (descriptionCategoryId > 0) opiItem.description_category_id = descriptionCategoryId;

  // const barcode = sv?._searchMeta?.barcodes?.[0] || it.barcode || '';
  // if (barcode) opiItem.barcode = String(barcode);

  // 末尾按约定顺序追加:images → images360 → pdf_list → attributes → complex_attributes
  opiItem.images = images;
  opiItem.attributes = attributes;

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

// /v2/products/stocks —— 批量更新库存
// OPI 限制:单请求 ≤100 组(商品-仓库),每分钟 ≤80 请求,每 30 秒同组只能更新一次
// 商品状态需变 price_sent 后才能设库存,故新 imported 商品可能返回 errors,需重试
// 请求: { stocks: [{ offer_id, product_id, stock, warehouse_id }] }
// 响应: { result: [{ warehouse_id, product_id, offer_id, updated: bool, errors: [] }] }
//  - items: [{ offerId, productId, stock }](warehouse_id 自动取 store.warehouse_id)
export function productStocks(store, items) {
  const wid = Number(store.warehouse_id);
  if (!wid) {
    throw new Error('store.warehouse_id 未配置,无法设置库存');
  }
  return call(store, '/v2/products/stocks', {
    stocks: items.map((it) => ({
      offer_id: it.offerId,
      product_id: Number(it.productId),
      stock: Number(it.stock),
      warehouse_id: wid,
    })),
  });
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

// /v3/product/list —— 按 visibility 查询商品总数(只取 result.total,无需翻页)
// 用途: 配额计算时统计归档商品数等,limit=1 减少数据传输
// visibility 枚举见 docs/ozon-seller-api-swagger-en.json:
//   ARCHIVED / AUTO_ARCHIVED / MANUAL_ARCHIVED / SEASONAL_AUTO_ARCHIVED 等
// 返回: number(失败时抛异常)
export async function productListTotalByVisibility(store, visibility) {
  const r = await call(store, '/v3/product/list', {
    filter: { visibility },
    last_id: '',
    limit: 1,
  });
  return Number(r?.result?.total) || 0;
}

// /v4/product/info/limit —— 获取账号上传配额
// 返回: { daily_create, daily_update, operation_limits, total }
//   - total.usage 含归档商品,实际可用额度需扣减归档数
//   - limit=-1 表示无限制
export function productInfoLimit(store) {
  return call(store, '/v4/product/info/limit');
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

// ── description-category 系列:属性名/类目名/字典值查询 ──
// 这三个端点用于把采集箱中的数字 ID(attribute_id / category_id / type_id /
// dictionary_value_id)翻译成人类可读的名称。
// 三层缓存(2026-07 改造,跨店铺共享):
//   L1: 进程内 Map(5 min,TTL)— 高频访问免查 SQLite
//   L2: SQLite(永久,仅管理员手动刷新失效)— 进程重启不丢失
//   L3: OPI /v1/description-category/* — miss 时拉取并写回 L2+L1
// cacheKey 不含 store.id(类目元数据是平台级数据,所有店铺共享)

const META_CACHE_TTL = 5 * 60 * 1000; // 5 min(L1)
const metaCache = new Map(); // key → { data, expiresAt }

function metaGet(key) {
  const hit = metaCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  metaCache.delete(key);
  return null;
}

function metaSet(key, data) {
  metaCache.set(key, { data, expiresAt: Date.now() + META_CACHE_TTL });
}

// 清空 L1 内存缓存(管理员刷新路由调用,下次访问触发 L2 查询或 OPI 拉取)
export function invalidateMetaCache() {
  metaCache.clear();
}

// /v1/description-category/tree —— 类目树(含 category_name + type_name)
// language: ZH_HANS(中文) / RU(俄语) / EN(英语) / DEFAULT(默认俄语)
// 响应: { result: [{ description_category_id, category_name, children: [..., { type_name, type_id }] }] }
export async function descriptionCategoryTree(store, language = 'ZH_HANS') {
  const cacheKey = `tree:${language}`;
  const cached = metaGet(cacheKey);
  if (cached) return cached;
  // L2: SQLite
  const l2 = metaDao.getCategoryTree(language);
  if (l2) {
    metaSet(cacheKey, l2);
    return l2;
  }
  // L3: OPI
  const r = await call(store, '/v1/description-category/tree', { language });
  const result = r?.result || r || [];
  metaDao.upsertCategoryTree(language, result);
  metaSet(cacheKey, result);
  return result;
}

// /v1/description-category/attribute —— 查类目+类型下所有属性描述(名/描述/类型/字典)
// language: ZH_HANS(中文) / RU(俄语) / EN(英语) / DEFAULT(默认俄语)
// 响应: { result: [{ id, name, description, type, is_required, dictionary_id, ... }] }
export async function descriptionCategoryAttributes(store, { description_category_id, type_id, language = 'ZH_HANS' }) {
  const cacheKey = `attrs:${language}:${description_category_id}:${type_id}`;
  const cached = metaGet(cacheKey);
  if (cached) return cached;
  // L2: SQLite
  const l2 = metaDao.getCategoryAttributes(description_category_id, type_id, language);
  if (l2) {
    metaSet(cacheKey, l2);
    return l2;
  }
  // L3: OPI
  const r = await call(store, '/v1/description-category/attribute', {
    description_category_id,
    type_id,
    language,
  });
  const result = r?.result || r || [];
  metaDao.upsertCategoryAttributes(description_category_id, type_id, language, result);
  metaSet(cacheKey, result);
  return result;
}

// /v1/description-category/attribute/values —— 查字典属性的可选值
// language: ZH_HANS(中文) / RU(俄语) / EN(英语) / DEFAULT(默认俄语)
// 响应: { result: [{ id, value, info, picture }], has_next }
export async function descriptionCategoryAttributeValues(
  store,
  { attribute_id, description_category_id, type_id, language = 'ZH_HANS', limit = 5000 }
) {
  const cacheKey = `values:${language}:${description_category_id}:${type_id}:${attribute_id}`;
  const cached = metaGet(cacheKey);
  if (cached) return cached;
  // L2: SQLite
  const l2 = metaDao.getAttributeValues(description_category_id, type_id, attribute_id, language);
  if (l2) {
    metaSet(cacheKey, l2);
    return l2;
  }
  // L3: OPI
  const r = await call(store, '/v1/description-category/attribute/values', {
    attribute_id,
    description_category_id,
    type_id,
    language,
    limit,
  });
  const result = r?.result || r || [];
  metaDao.upsertAttributeValues(description_category_id, type_id, attribute_id, language, result);
  metaSet(cacheKey, result);
  return result;
}

// ── 商品图片更新(2026-07) ───────────────────────────────────
// /v1/product/pictures/import —— 上传或更新商品图片
// 扁平请求体(对齐 Swagger productv1ProductImportPicturesRequest):
//   { product_id: integer, images: string[], color_image?: string, images360?: string[] }
// 第一张 images 自动为主图(is_primary),无需额外指定
// 响应: { result: { pictures: [{ state, is_primary, ... }] } }
export function productPicturesImport(store, { product_id, images, color_image, images360 }) {
  const body = { product_id: Number(product_id) };
  if (Array.isArray(images)) body.images = images;
  if (color_image) body.color_image = color_image;
  if (Array.isArray(images360)) body.images360 = images360;
  return call(store, '/v1/product/pictures/import', body);
}

// /v2/product/pictures/info —— 查询商品图片状态
// 请求: { product_id: string[] }(最多 1000,Swagger schema items format int64)
// 响应: { items: [{ product_id, primary_photo[], photo[], color_photo[], photo_360[], errors[] }] }
// errors 为空表示图片无问题
export function productPicturesInfo(store, productIds) {
  const arr = (Array.isArray(productIds) ? productIds : [productIds]).map(String);
  return call(store, '/v2/product/pictures/info', { product_id: arr });
}

// ── FBS 订单 posting 系列(2026-08,订单处理)──────────────────
// 实测结构(2026-08-29,详见设计文档附录C):
//   - 响应形如 { result: { postings, cursor, has_next, count } },兼容顶层直接返回
//   - products[].price 为对象 {amount:"35.22",currency:"CNY"}(非 v3 文档的字符串)
//   - financial_data.products[].payout/commission 未妥投时恒为 0,预估佣金需自算
//   - posting_number 为主键(拆单后 -N 序号),customer.customer_id = 单号前缀
//   - unfulfilled 返回"未妥投全集"(含 delivering),不只待处理

// /v4/posting/fbs/unfulfilled/list —— 未妥投货件列表(主增量源)
// cutoff 窗口:按卖家需完成备货的时间过滤;覆盖 awaiting_packaging → delivering 全部未妥投单
// 请求: { filter: { cutoff_from, cutoff_to }, cursor, limit, with }
// 响应: { result: { postings, cursor, has_next, count } }
// 注:v4 实测 limit 上限 100(传 1000 报 Request validation error)
export function postingFbsUnfulfilledList(store, { cutoffFrom, cutoffTo, cursor, limit = 100 } = {}) {
  const body = {
    filter: { cutoff_from: cutoffFrom, cutoff_to: cutoffTo },
    limit,
    with: { analytics_data: true, financial_data: true },
  };
  if (cursor) body.cursor = cursor;
  return call(store, '/v4/posting/fbs/unfulfilled/list', body);
}

// /v4/posting/fbs/list —— 货件列表(历史回补/状态校准,含 delivered/cancelled 终态)
// since/to 按 in_process_at(下单时间)过滤,窗口 ≤1 年
// 请求: { dir, filter: { since, to }, cursor, limit, with }
// 响应: { result: { postings, cursor, has_next } }(无 count)
export function postingFbsList(store, { since, to, cursor, limit = 100 } = {}) {
  const body = {
    dir: 'DESC',
    filter: { since, to },
    limit,
    with: { analytics_data: true, financial_data: true },
  };
  if (cursor) body.cursor = cursor;
  return call(store, '/v4/posting/fbs/list', body);
}

// ── 商品归档任务(2026-08)─────────────────────────────────────
// /v1/product/archive —— 将商品归档(批量)
// OPI 限制:单请求 ≤100 个 product_id
// 请求: { product_id: [number] }
// 响应: { result: boolean }(true=整批成功,false=整批失败,无 item 级状态)
// 注:归档后商品在 Ozon 后台移入归档区,买家不可见,可通过 /v1/product/unarchive 恢复
export function productArchive(store, productIds) {
  const arr = (Array.isArray(productIds) ? productIds : [productIds])
    .map((id) => Number(id))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (arr.length === 0) {
    throw new Error('product_id 不能为空');
  }
  if (arr.length > 100) {
    throw new Error('单次最多归档 100 个 product_id');
  }
  return call(store, '/v1/product/archive', { product_id: arr });
}

// ── 商品信息更新任务(2026-07)─────────────────────────────────
// 统一走 /v3/product/import 全量重传:从 Ozon 实时拉完整商品数据,
// 只替换用户指定字段(FieldUpdater),其他字段保留 Ozon 当前值
// project_memory 硬约束:必须过滤 SKIP_ATTR_IDS,避免重复字段错误

const SKIP_ATTR_IDS = new Set([4194, 4195, 4497, 9454, 9455, 9456, 23536]);

// 从 Ozon 实时拉取完整商品数据,根据 updateFields 替换指定字段,构建 /v3/product/import 的 payload
// 流程:
//   1. /v3/product/info/list 拿 price/old_price/min_price/vat 等顶层字段
//   2. /v4/product/info/attributes 拿 weight/dims/images/attributes/type_id/desc_cat_id
//   3. 转换 attributes:过滤 SKIP_ATTR_IDS,用 {complex_id, id, values:[{value}]} 格式
//   4. 构建 OPI v3 item(保留 Ozon 实时值)
//   5. 根据 updateFields 逐个调用 FieldUpdater 替换字段
//   6. min_price 仅当 < price 时才传(避免"最低价格应低于价格"错误)
// 返回: opiItem(可直接塞进 {items:[opiItem]} 调 productImport)
export async function buildProductUpdatePayload(store, offerId, updateFields, newValues, applyFieldUpdaters) {
  // Step 1: /v3/product/info/list 拿顶层字段
  const pInfoResp = await productInfoList(store, [offerId]);
  const pInfo = pInfoResp?.items?.[0];
  if (!pInfo) {
    throw new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `Ozon 未查到商品 offer_id=${offerId}`);
  }
  const productId = Number(pInfo.id);
  if (!productId) {
    throw new ApiError(ErrorCode.VALIDATION_ERROR, `商品 ${offerId} 无 product_id,可能尚未创建`);
  }

  // Step 2: /v4/product/info/attributes 拿 weight/dims/images/attributes/type_id/desc_cat_id
  const pAttrsResp = await productInfoAttributes(store, { product_id: [productId] });
  const pAttrs = pAttrsResp?.result?.[0];
  if (!pAttrs) {
    throw new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `Ozon 未查到商品属性 product_id=${productId}`);
  }

  // Step 3: 转换 attributes(过滤 SKIP_ATTR_IDS)
  const attributes = [];
  let skippedCount = 0;
  for (const a of pAttrs.attributes || []) {
    const attrId = Number(a.id);
    if (SKIP_ATTR_IDS.has(attrId)) {
      skippedCount++;
      continue;
    }
    const vals = (a.values || [])
      .filter((v) => v.value != null && v.value !== '')
      .map((v) => ({ value: String(v.value) }));
    if (vals.length === 0) continue;
    attributes.push({
      complex_id: Number(a.complex_id) || 0,
      id: attrId,
      values: vals,
    });
  }
  logger.debug(
    { offerId, productId, attrCount: attributes.length, skippedCount },
    'buildProductUpdatePayload: attributes 转换完成'
  );

  // Step 4: 构建 OPI v3 item(保留 Ozon 实时值)
  // 注意:price 必须从顶层取,不是 .price.price(否则会 undefined 触发"价格不能为负数")
  const price = String(pInfo.price || '0');
  const oldPrice = String(pInfo.old_price || pInfo.price || '0');
  const minPrice = pInfo.min_price ? String(pInfo.min_price) : null;

  const opiItem = {
    name: String(pInfo.name || ''),
    offer_id: String(pInfo.offer_id),
    price,
    old_price: oldPrice,
    currency_code: pInfo.currency_code || 'RUB',
    vat: String(pInfo.vat ?? '0'),
    weight: Number(pAttrs.weight) > 0 ? Math.round(Number(pAttrs.weight)) : 100,
    weight_unit: pAttrs.weight_unit || 'g',
    depth: Number(pAttrs.depth) > 0 ? Math.round(Number(pAttrs.depth)) : 100,
    width: Number(pAttrs.width) > 0 ? Math.round(Number(pAttrs.width)) : 100,
    height: Number(pAttrs.height) > 0 ? Math.round(Number(pAttrs.height)) : 100,
    dimension_unit: pAttrs.dimension_unit || 'mm',
    images: (pAttrs.images || []).filter(Boolean),
    attributes,
  };
  if (pAttrs.primary_image) opiItem.primary_image = String(pAttrs.primary_image);
  if (pAttrs.color_image) opiItem.color_image = String(pAttrs.color_image);
  if (Number(pAttrs.type_id) > 0) opiItem.type_id = Number(pAttrs.type_id);
  if (Number(pAttrs.description_category_id) > 0) opiItem.description_category_id = Number(pAttrs.description_category_id);
  if (pInfo.video_url) opiItem.video_url = String(pInfo.video_url);
  if (pInfo.video_cover) opiItem.video_cover = String(pInfo.video_cover);
  // min_price 仅当存在且 < price 时才传(避免"最低价格应低于价格"错误)
  if (minPrice && Number(minPrice) > 0 && Number(minPrice) < Number(price)) {
    opiItem.min_price = minPrice;
  }

  // Step 5: 应用 FieldUpdater 替换用户指定字段
  if (Array.isArray(updateFields) && updateFields.length > 0) {
    if (typeof applyFieldUpdaters !== 'function') {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'applyFieldUpdaters 未提供');
    }
    applyFieldUpdaters(pInfo, pAttrs, opiItem, updateFields, newValues || {});
  }

  return opiItem;
}
