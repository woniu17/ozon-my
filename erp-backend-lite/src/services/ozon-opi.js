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
export function productImport(store, items) {
  return call(store, '/v3/product/import', {
    items: items.map((it) => ({
      name: it.name,
      offer_id: it.offer_id,
      price: it.price ? String(it.price) : undefined,
      old_price: it.old_price ? String(it.old_price) : undefined,
      currency_code: it.currency_code || 'RUB',
      vat: it.vat || '0',
      images: it.images || [],
      description: it.description || it.scraped_description || '',
      attributes: it._sourceVariant?.attributes || [],
      // 其他字段透传
    })),
  });
}

// /v1/product/import/info —— 查询任务进度
export function productImportInfo(store, taskId) {
  return call(store, '/v1/product/import/info', { task_id: Number(taskId) });
}

// /v2/product/info —— 查询商品数据(product-data 用)
export function productInfo(store, sku) {
  return call(store, '/v2/product/info', { sku: String(sku), offer_id: undefined });
}

// /v2/product/info/list —— 批量查询
export function productInfoList(store, skus) {
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
