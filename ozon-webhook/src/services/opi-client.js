// OPI 客户端:回拉订单详情(TYPE_NEW_POSTING 用)
// 封装 /v3/posting/fbs/get、/v4/posting/fbs/unfulfilled/list
// 多店铺凭据:从 payload.seller_id 路由到对应 store.sync_credentials
// 项目记忆约定:OPI 连接超时使用 { details: { kind: 'connect_timeout' } } 抛 AppError 触发重试
import { request } from 'undici';
import config from '../config/index.js';
import { AppError } from '../middleware/error.js';
import logger from '../middleware/log.js';

// OPI 单请求超时:headers/body 各 30s,覆盖列表接口(/v4/unfulfilled/list)单页 100 条数据传输 + 解析时间
// undici 的 headersTimeout/bodyTimeout 在"对端半开连接"场景可能不触发,
// 必须用 AbortController 兜底,否则 tick 会无限卡住
const REQUEST_TIMEOUT_MS = 30000;
const ABORT_TIMEOUT_MS = 35000;  // AbortController 兜底,比 headersTimeout 晚 5s 触发,优先让 undici 精确超时
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
    const timer = setTimeout(() => controller.abort(), ABORT_TIMEOUT_MS);
    try {
      const resp = await request(url, {
        method: 'POST',
        headers: {
          'Client-Id': store.sync_credentials.clientId,
          'Api-Key': store.sync_credentials.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // 1) undici 原生超时(精确):headersTimeout 控制首字节,bodyTimeout 控制整体 body 读取
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
        // 2) AbortController 兜底:对端半开连接时,undici 内部超时不触发,
        //    AbortController 在 35s 强制中断整个请求,防止 tick 无限卡住
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
      // undici 超时抛 HeadersTimeoutError / BodyTimeoutError / ConnectTimeoutError
      // AbortController 触发抛 AbortError("This operation was aborted")
      // 连接重置抛 ECONNRESET / ETIMEDOUT
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
  // Ozon /v4/posting/fbs/unfulfilled/list 实测顶层直接是 {postings, cursor, has_next, count},
  // 不带 result 包裹(与 Swagger 文档不一致)
  // 兼容两种:优先取 data.result,否则用 data 自身
  const result = data?.result ?? data;
  return result ?? { postings: [], cursor: '', has_next: false, count: 0 };
}
