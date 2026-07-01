// ERP HTTP 客户端 —— 与 erp-backend-lite 对接的真实客户端。
// 替代 mock-erp.js,封装 fetch 调用,内置:
//   - JWT token 管理(chrome.storage.local)
//   - x-ozon-store-id header(storeGuard 中间件)
//   - X-Refreshed-Token 滑动续期(自动更新存储)
//   - 统一错误处理(对齐后端 {code, message, details} 契约)
//
// 对应 ERP 后端端点(erp-backend-lite/src/modules/*):
//   POST /auth/login-password                 → login
//   GET  /auth/ozon-stores                    → getStores
//   GET  /feature-flags/me                    → getFeatureFlags
//   GET  /membership/usage-summary            → getMembershipSummary
//   GET  /ozon/warehouses                     → getWarehouses (需 store)
//   GET  /jidian/balance + /jidian/pricing    → getAiQuota
//   POST /ozon/products/prepare-bundle-items  → prepareBundleItems (需 store,viaPortal 6a)
//   POST /ozon/products/import                → importProducts (需 store,官方 API)
//   POST /ozon/products/import/status         → getImportStatus (需 store)
//   GET  /ozon/products/import-by-sku/tasks   → listImportTasks (需 store)
//   GET  /health                              → healthCheck (无鉴权)

(function () {
  'use strict';

  const STORAGE_KEYS = { token: 'ozonAuthToken', storeId: 'ozonStoreId', baseUrl: 'erpBaseUrl' };
  const DEFAULT_BASE_URL = 'http://localhost:3001';
  const REQUEST_TIMEOUT_MS = 30000;

  // ────────────────────────────────────────────────────────────
  // 配置:Base URL 可通过 chrome.storage.local.erpBaseUrl 覆盖(方便切环境)
  // ────────────────────────────────────────────────────────────
  let cachedBaseUrl = null;

  async function getBaseUrl() {
    if (cachedBaseUrl) return cachedBaseUrl;
    try {
      const r = await chrome.storage.local.get(STORAGE_KEYS.baseUrl);
      cachedBaseUrl = r[STORAGE_KEYS.baseUrl] || DEFAULT_BASE_URL;
    } catch {
      cachedBaseUrl = DEFAULT_BASE_URL;
    }
    return cachedBaseUrl;
  }

  async function getStoredToken() {
    try {
      const r = await chrome.storage.local.get(STORAGE_KEYS.token);
      return r[STORAGE_KEYS.token] || '';
    } catch {
      return '';
    }
  }

  async function setStoredToken(token) {
    if (token) {
      await chrome.storage.local.set({ [STORAGE_KEYS.token]: token });
    } else {
      await chrome.storage.local.remove(STORAGE_KEYS.token);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 核心 request:统一 fetch 封装
  // ────────────────────────────────────────────────────────────
  async function request(method, path, { token, storeId, body, query, timeoutMs } = {}) {
    const baseUrl = await getBaseUrl();
    const url = new URL(path, baseUrl + '/');
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (storeId) headers['x-ozon-store-id'] = storeId;

    const init = { method, headers, credentials: 'omit' };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || REQUEST_TIMEOUT_MS);
    init.signal = controller.signal;

    let resp;
    try {
      resp = await fetch(url.toString(), init);
    } catch (e) {
      const err = new Error(`[erp-client] 网络请求失败: ${e?.message || e}`);
      err.code = e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // 滑动续期:读取 X-Refreshed-Token 响应头(后端 remaining<50% 时重签)
    const refreshed = resp.headers.get('X-Refreshed-Token');
    if (refreshed) {
      await setStoredToken(refreshed);
      console.log('[erp-client] token 已滑动续期');
    }

    const text = await resp.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!resp.ok) {
      const code = parsed?.code || 'NETWORK_ERROR';
      const message = parsed?.message || `HTTP ${resp.status}`;
      const err = new Error(`[erp-client] ${message}`);
      err.code = code;
      err.status = resp.status;
      err.details = parsed?.details;
      // 401/鉴权失败 → 清除本地 token,触发重新登录
      if (resp.status === 401 || code === 'AUTH_EXPIRED' || code === 'AUTH_REQUIRED') {
        await setStoredToken('');
      }
      throw err;
    }

    return parsed;
  }

  // ────────────────────────────────────────────────────────────
  // 公开 API(方法签名对齐原 MockERP,便于 service-worker 平滑替换)
  // ────────────────────────────────────────────────────────────
  const ErpClient = {
    STORAGE_KEYS,
    DEFAULT_BASE_URL,

    // ── 鉴权 ───────────────────────────────────────────────────
    // POST /auth/login-password
    // body: { phoneNumber, password } → { accessToken, user }
    async login(phoneNumber, password) {
      const data = await request('POST', '/auth/login-password', { body: { phoneNumber, password } });
      if (data?.accessToken) await setStoredToken(data.accessToken);
      return data; // { accessToken, user }
    },

    // 退出:清除本地 token + storeId
    async logout() {
      await chrome.storage.local.remove([STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
    },

    // GET /auth/ozon-stores → stores 数组(不含 sync_credentials)
    async getStores(token) {
      const t = token || (await getStoredToken());
      return request('GET', '/auth/ozon-stores', { token: t });
    },

    // ── Phase 1 校验 ───────────────────────────────────────────
    // GET /feature-flags/me → { ozon_portal_import: true, ... }
    async getFeatureFlags(token, storeId) {
      const t = token || (await getStoredToken());
      return request('GET', '/feature-flags/me', { token: t, storeId });
    },

    // GET /membership/usage-summary → { caps, usage, canUse }
    async getMembershipSummary(token, storeId) {
      const t = token || (await getStoredToken());
      return request('GET', '/membership/usage-summary', { token: t, storeId });
    },

    // GET /ozon/warehouses(需 store)→ [{ id, name, store_id, ... }]
    async getWarehouses(token, storeId) {
      const t = token || (await getStoredToken());
      return request('GET', '/ozon/warehouses', { token: t, storeId });
    },

    // GET /jidian/balance + /jidian/pricing → 合并成 { aiImage, aiRewrite }
    // 对齐原 MockERP.getAiQuota 返回形状
    async getAiQuota(token, storeId) {
      const t = token || (await getStoredToken());
      const [balance, pricing] = await Promise.all([
        request('GET', '/jidian/balance', { token: t, storeId }),
        request('GET', '/jidian/pricing', { token: t, storeId }),
      ]);
      return {
        aiImage: { balance: balance?.balance ?? 0, price: pricing?.AI_IMAGE?.price ?? 0 },
        aiRewrite: { unlimited: true },
      };
    },

    // ── viaPortal 6a:备料(需 store) ──────────────────────────
    // POST /ozon/products/prepare-bundle-items
    // body: 同 followSell message → { result: { bundles, store_company_id, strictSkipped, invalidImage } }
    async prepareBundleItems(message, token, storeId) {
      const t = token || (await getStoredToken());
      return request('POST', '/ozon/products/prepare-bundle-items', {
        token: t,
        storeId,
        body: message,
        timeoutMs: 120000,
      });
    },

    // ── 官方 API 路径(viaPortal=false) ───────────────────────
    // POST /ozon/products/import → { result: { task_id, local_task_id } }
    async importProducts(message, token, storeId) {
      const t = token || (await getStoredToken());
      return request('POST', '/ozon/products/import', {
        token: t,
        storeId,
        body: message,
        timeoutMs: 120000,
      });
    },

    // POST /ozon/products/import/status → { status, processed, failed, size, done }
    async getImportStatus(taskId, token, storeId) {
      const t = token || (await getStoredToken());
      return request('POST', '/ozon/products/import/status', {
        token: t,
        storeId,
        body: { task_id: taskId },
      });
    },

    // GET /ozon/products/import-by-sku/tasks → { items, total, current, pageSize }
    async listImportTasks({ current = 1, pageSize = 20 } = {}, token, storeId) {
      const t = token || (await getStoredToken());
      return request('GET', '/ozon/products/import-by-sku/tasks', {
        token: t,
        storeId,
        query: { current, pageSize },
      });
    },

    // ── 健康检查(无鉴权) ─────────────────────────────────────
    async healthCheck() {
      return request('GET', '/health', { timeoutMs: 5000 });
    },
  };

  self.ErpClient = ErpClient;
})();
