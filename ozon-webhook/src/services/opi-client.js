// OPI 客户端:回拉订单详情(TYPE_NEW_POSTING 用)
// 封装 /v3/posting/fbs/get、/v4/posting/fbs/unfulfilled/list
// 多店铺凭据:从 payload.seller_id 路由到对应 store.sync_credentials
// 项目记忆约定:OPI 连接超时使用 { details: { kind: 'connect_timeout' } } 抛 AppError 触发重试
import { request } from 'undici';
import config from '../config/index.js';
import { AppError } from '../middleware/error.js';
import logger from '../middleware/log.js';

// OPI 单请求超时:headers/body 各 30s,覆盖列表接口(/v4/unfulfilled/list)单页 100 条数据传输 + 解析时间
const REQUEST_TIMEOUT_MS = 30000;
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
    try {
      const resp = await request(url, {
        method: 'POST',
        headers: {
          'Client-Id': store.sync_credentials.clientId,
          'Api-Key': store.sync_credentials.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // undici 原生超时:headersTimeout 控制首字节,bodyTimeout 控制整体 body 读取
        // 比 AbortController 更精确,不会误杀慢响应(JSON 解析与分块传输不会计入超时)
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
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
      // undici 超时抛 HeadersTimeoutError / BodyTimeoutError / ConnectTimeoutError
      // 连接超时/中止:按项目记忆用 connect_timeout 标识触发上层重试
      const isTimeoutErr = err.name === 'HeadersTimeoutError'
        || err.name === 'BodyTimeoutError'
        || err.name === 'ConnectTimeoutError'
        || err.name === 'AbortError'
        || err.code === 'ECONNRESET'
        || err.code === 'ETIMEDOUT';
      if (isTimeoutErr) {
        lastErr = new AppError({
          status: 504,
          code: 'ERROR_UNKNOWN',
          message: `OPI 连接超时: ${err.message}`,
          details: { kind: 'connect_timeout' },
        });
        logger.warn({ storeId: store.id, path, attempt, errName: err.name, err: err.message }, 'OPI 连接超时,重试');
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

/**
 * 拉取 FBS 未妥投货件列表(主增量源)
 * POST /v4/posting/fbs/unfulfilled/list
 * @param {object} store 店铺对象
 * @param {object} opts
 * @param {string} [opts.cutoffFrom] ISO 截止备货起始时间
 * @param {string} [opts.cutoffTo]   ISO 截止备货结束时间
 * @param {string} [opts.cursor]     分页游标
 * @param {number} [opts.limit=100]  每页数量(实测上限 100)
 * @returns {Promise<{postings:Array, cursor:string, has_next:boolean, count:number}>}
 */
export async function postingFbsUnfulfilledList(store, { cutoffFrom, cutoffTo, cursor, limit = 100 } = {}) {
  const body = {
    filter: { cutoff_from: cutoffFrom, cutoff_to: cutoffTo },
    limit,
    with: { analytics_data: true, financial_data: true },
  };
  if (cursor) body.cursor = cursor;
  const data = await opiRequest(store, '/v4/posting/fbs/unfulfilled/list', body);
  return data?.result ?? { postings: [], cursor: '', has_next: false, count: 0 };
}
