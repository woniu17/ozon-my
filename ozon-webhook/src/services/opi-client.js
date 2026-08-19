// OPI 客户端:回拉订单详情(TYPE_NEW_POSTING 用)
// 封装 /v3/posting/fbs/get
// 多店铺凭据:从 payload.seller_id 路由到对应 store.sync_credentials
// 项目记忆约定:OPI 连接超时使用 { details: { kind: 'connect_timeout' } } 抛 AppError 触发重试
import { request } from 'undici';
import config from '../config/index.js';
import { AppError } from '../middleware/error.js';
import logger from '../middleware/log.js';

const REQUEST_TIMEOUT_MS = 10000; // 10s,OPI 单请求超时
const MAX_RETRY = 2; // 偶发抖动重试 2 次

async function opiRequest(store, path, body) {
  if (!store?.sync_credentials?.clientId || !store?.sync_credentials?.apiKey) {
    throw new AppError({
      status: 500,
      code: 'ERROR_UNKNOWN',
      message: `店铺 ${store?.id ?? 'unknown'} 未配置 sync_credentials`,
      details: { kind: 'no_credentials' },
    });
  }
  const url = `${config.opiBaseUrl}${path}`;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await request(url, {
        method: 'POST',
        headers: {
          'Client-Id': store.sync_credentials.clientId,
          'Api-Key': store.sync_credentials.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (resp.statusCode >= 500) {
        const text = await resp.body.text();
        throw new AppError({
          status: 502,
          code: 'ERROR_UNKNOWN',
          message: `OPI 5xx: ${resp.statusCode}`,
          details: { kind: 'server_fault', body: text.slice(0, 500) },
        });
      }
      if (resp.statusCode >= 400) {
        const data = await resp.body.json().catch(() => null);
        throw new AppError({
          status: 502,
          code: 'ERROR_UNKNOWN',
          message: `OPI ${resp.statusCode}: ${data?.message ?? ''}`,
          details: { kind: 'client_error', opi_status: resp.statusCode },
        });
      }
      return await resp.body.json();
    } catch (err) {
      // 连接超时/中止:按项目记忆用 connect_timeout 标识触发上层重试
      if (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
        lastErr = new AppError({
          status: 504,
          code: 'ERROR_UNKNOWN',
          message: `OPI 连接超时: ${err.message}`,
          details: { kind: 'connect_timeout' },
        });
        logger.warn({ storeId: store.id, path, attempt, err: err.message }, 'OPI 连接超时,重试');
        continue;
      }
      // AppError 直接抛出(让 poller 决定重试)
      if (err instanceof AppError) {
        lastErr = err;
        // 5xx 才重试,4xx 直接放弃
        if (err.status < 500) throw err;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new AppError({ status: 504, code: 'ERROR_UNKNOWN', message: 'OPI 重试上限' });
}

/**
 * 拉取 FBS 订单详情
 * POST /v3/posting/fbs/get
 * @param {object} store 店铺对象(含 sync_credentials)
 * @param {string} postingNumber
 */
export async function getPostingDetail(store, postingNumber) {
  const data = await opiRequest(store, '/v3/posting/fbs/get', {
    posting_number: postingNumber,
    with: { analytics_data: true, financial_data: true },
  });
  return data?.result ?? null;
}
