globalThis.__JZ_BRAND__ = {
  code: 'my',
  displayName: 'MY',
  productName: 'MY',
  primaryColor: 'rgb(232,77,146)',
  apiHost: 'localhost:3001',
  webHost: 'localhost:3001',
  logoUrl:
    'https://jz-item-image-bucket.oss-cn-beijing.aliyuncs.com/images/2026-05-21/1779387908462_11498a0f1bc945b4.png',
};
// Electron host compatibility shim — Electron 36+ extension system 不实现
// chrome.contextMenus / chrome.cookies / chrome.notifications,SW 顶层调到
// chrome.contextMenus.onClicked.addListener 会抛 TypeError 导致整个 SW 注册失败。
// 这里给缺失 API 注册 no-op fallback;Chrome 里 typeof check 不触发,不污染原生。
// chrome.cookies 在 Electron 完整迁移阶段走 main process session.cookies IPC 桥;
// PoC 阶段用 no-op,让 SW 至少 active,跟卖前置流程会另行处理。
if (typeof chrome !== 'undefined') {
  if (typeof chrome.contextMenus === 'undefined') {
    chrome.contextMenus = {
      removeAll: (cb) => {
        try {
          cb && cb();
        } catch (_) {}
      },
      create: () => {},
      onClicked: { addListener: () => {}, removeListener: () => {} },
    };
  }
  if (typeof chrome.notifications === 'undefined') {
    chrome.notifications = {
      create: (id, opts, cb) => {
        try {
          cb && cb(typeof id === 'string' ? id : '');
        } catch (_) {}
      },
      clear: (id, cb) => {
        try {
          cb && cb(true);
        } catch (_) {}
      },
      onClicked: { addListener: () => {}, removeListener: () => {} },
    };
  }
  if (typeof chrome.cookies === 'undefined') {
    chrome.cookies = {
      getAll: (_query, cb) => {
        const empty = [];
        if (typeof cb === 'function') {
          try {
            cb(empty);
          } catch (_) {}
          return;
        }
        return Promise.resolve(empty);
      },
    };
  }
}

// Client-side sync 模块 — 同步加载到 SW global,挂 globalThis.Jz* 命名空间。
// importScripts 必须在 IIFE 之前(SW 文件顶层)同步调用,否则 SW spec 不允许。
// 这套模块完全隔离在 background/sync/ 子目录,不动现有 IIFE 内部结构。
try {
  importScripts(
    // cdn-buster 必须在 backend-client 之前 — 后者运行时读 globalThis.JzCdnBuster。
    '../lib/cdn-buster.js',
    '../lib/ozon-video-extract.js',
    'sync/opi-client.js',
    'sync/backend-client.js',
    'sync/lease-client.js',
    'sync/diff-index.js',
    'sync/sync-state.js',
    'sync/sync-engine.js',
    'agent/actions.js',
    'agent/collect-actions.js',
    'agent/agent-runtime.js'
  );
} catch (e) {
  // 不要阻断 SW 启动 — 老功能仍需可用。client-sync 失败时 alarm 不会触发。
  console.warn('[SW] client-sync importScripts failed:', e?.message || e);
}

(() => {
  // 启动版本标识：用户跟卖前看 chrome://extensions 极掌 → service worker → console
  // 必须能看到下面这行才说明新代码已加载（否则说明 sw 没 reload）
  console.log(
    '[SW] booted: searchVariants = /api/v1/search + /api/site/seller-prototype/create-bundle-by-variant-id (sv endpoint 2026-05 下线) + ensureSellerTab + client-sync'
  );

  // Backend 路由策略(迁移至 erp-backend-lite):
  //   - 原先 dev/prod 分别走 localhost:3001 + api.jizhangerp.com,prod 单走
  //     api.jizhangerp.com。erp-lite 迁移后 dev/prod 一律只走本地 erp-lite
  //     (http://localhost:3001),不再 fallback jizhangerp.com。
  //   - __JZ_PROD_BUILD__ 历史上用于 esbuild define 切 prod 候选,迁移后两分支
  //     同址,条件移除但保留上下文注释。
  let BACKEND_URLS;
  BACKEND_URLS = ['http://localhost:3001'];

  // 迁移至 erp-backend-lite:Web 前端即 erp-lite /admin,域 = 后端域
  const BRAND_WEB_HOST = 'localhost:3001';

  // 插件更新检查配置: 走后端 GET /extension/latest?client=extension
  // (URL 在 checkForUpdate 中通过 getBackendUrl() 动态拼接)
  const UPDATE_CHECK_ALARM = 'extension-update-check';
  const UPDATE_CHECK_INTERVAL_MINUTES = 240; // 每4小时检查一次

  // 跟卖任务失败检查配置
  const FOLLOW_SELL_CHECK_ALARM = 'follow-sell-task-check';
  const FOLLOW_SELL_CHECK_INTERVAL_MINUTES = 5; // 每 5 分钟拉一次最近任务
  const FOLLOW_SELL_RECENT_WINDOW_MS = 60 * 60 * 1000; // 只通知最近 1 小时内创建的失败任务

  const STORAGE_KEYS = {
    token: 'ozonAuthToken',
    storeId: 'ozonStoreId',
    latestVersion: 'extensionLatestVersion',
    latestDownloadUrl: 'extensionLatestDownloadUrl',
    latestSha256: 'extensionLatestSha256',
    updateDismissedVersion: 'extensionUpdateDismissedVersion',
    followSellNotifiedIds: 'followSellNotifiedLocalTaskIds',
    deviceFingerprint: 'ozonExtensionFingerprint',
    // v2 (deprecated) → v3 (2026-05-27 起):v2 含 devicePixelRatio + languages 数组
    // 在同台 Edge 不同 profile/zoom 算成两台机器,导致 4 台套餐错占名额。
    // v3 移除这两个不稳维度。读时优先 v3,fallback v2 兼容旧 cache,setStorage 写 v3。
    deviceFingerprintV2: 'ozonMachineFingerprintV2',
    deviceFingerprintV3: 'ozonMachineFingerprintV3',
    // 通用埋点当天去重: { [featureKey]: 'YYYY-MM-DD' }
    usageTrackedDate: 'usageTrackedDate',
    // L1 (composer-api 拦截) 上报开关。默认 false (dry-run) —— 后端 endpoint
    // 就绪前不发任何网络请求,只做本地计数。用 `chrome.storage.local.set({
    // l1ReportEnabled: true })` 启用。详见 .claude/plans/chrome-api-purring-haven.md。
    l1ReportEnabled: 'l1ReportEnabled',
  };

  // L1 SW 端运行时计数器(本进程级,SW 重启会清零;持久化指标走影子表 IndexedDB)
  const l1SwStats = {
    receivedBatches: 0,
    receivedSamples: 0,
    sentSamples: 0,
    droppedNoAuth: 0,
    droppedDisabled: 0,
    httpErrors: 0,
    lastError: null,
    lastSentAt: 0,
  };

  const HEARTBEAT_ALARM = 'device-heartbeat';
  const HEARTBEAT_INTERVAL_MINUTES = 5;

  // 采集器实时大屏：tab → 最近一次 heartbeat 状态（不持久化，sw 休眠后会清空，
  // 但前台每 30s 会重发心跳，恢复也快）
  const COLLECTOR_STALE_MS = 90 * 1000;
  const collectorTabs = new Map(); // tabId → { tabId, stats, currentKeyword, autoScrollerRunning, bucketCount, url, title, ts }

  // ── 极掌算价：CNY→RUB 实时汇率 ──
  // 每日刷新一次写入 chrome.storage.local。content/jzc-calc.js 监听 storage 变化自动重算
  const FX_STORAGE_KEY = 'jz_calc_fx_rate_v1';
  const FX_ALARM = 'jzc-fx-refresh';
  const FX_API_URL = 'https://open.er-api.com/v6/latest/CNY';
  const FX_REFRESH_INTERVAL_MINUTES = 24 * 60;

  // ── client-side sync(扩展端跑同步,取代后端 BullMQ cron)──
  // 三个独立 alarm,各类型独立频率。SW 重启自动 re-create alarm,
  // chrome.alarms 在用户登录浏览器期间持续触发,不依赖 ozon 页面打开。
  const CLIENT_SYNC_ALARM_PREFIX = 'jz:client-sync:';
  const CLIENT_SYNC_TYPES = ['POSTINGS', 'PRODUCTS', 'WAREHOUSES'];
  // 默认间隔(分钟) — 跟 backend SyncSettingsService.getXxxClientIntervalMin 对齐。
  // backend 端点 /ozon/sync/client-intervals 可拉服务端配置,MVP 先硬编码,
  // 之后灰度时再加"启动 + 每 24h 拉一次刷新"逻辑。
  // 2026-06-02:POSTINGS 3→5 对齐后端 OZON_POSTINGS_CLIENT_INTERVAL_MIN 默认值(5)。
  // 之前硬编码 3min 无视后端配置,是高峰 api 最大流量源(lease 三件套 + client-report
  // 逐页上报,~40 req/s)。5min 把这块砍 ~40%,订单新鲜度 3→5min 可接受。
  const CLIENT_SYNC_INTERVALS = {
    POSTINGS: 5,
    PRODUCTS: 30,
    WAREHOUSES: 360,
  };
  const BROWSER_AGENT_ALARM = 'jz:browser-agent';
  const BROWSER_AGENT_INTERVAL_MINUTES = 1;

  /**
   * 登录门户域声明(2026-06-11 串号修复):build.js 给发版包注入
   * globalThis.__JZ_BRAND__(分销商定制版 webHost = 其商户域,平台版 =
   * store.jizhangerp.com)。popup/SW 登录直调 api.* 时后端拿不到分销商域上下文
   * (Origin 是 chrome-extension:// 被跳过),把 webHost 随 body 显式声明,
   * 后端按它解析 distributorId —— 定制版用户从此登进自己分销商的账号,
   * 不再被串进平台直营。dev 源码加载无 brand 注入 → 返回 undefined,后端走
   * 原 host 链路。
   */
  function jzBrandPortalHost() {
    try {
      const h = globalThis.__JZ_BRAND__ && globalThis.__JZ_BRAND__.webHost;
      return typeof h === 'string' && h.trim() ? h.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  async function getExtensionFingerprint(preferredFingerprint) {
    // popup 传上来的 preferredFingerprint 现在是 machine-v3-,兼容 v2 旧 popup
    // (用户没 reload 扩展但 reload 了网页端)期间 v2 fingerprint 也能透传。
    if (preferredFingerprint && /^machine-v[23]-[a-z0-9-]+$/i.test(preferredFingerprint)) {
      await setStorage({ [STORAGE_KEYS.deviceFingerprintV3]: preferredFingerprint });
      return preferredFingerprint;
    }
    const stored = await getStorage([STORAGE_KEYS.deviceFingerprintV3, STORAGE_KEYS.deviceFingerprintV2]);
    // v3 优先;不存在但有 v2 → migrate 一次(同 raw 输入算 v3 hash 不同,直接重算)。
    if (stored[STORAGE_KEYS.deviceFingerprintV3]) return stored[STORAGE_KEYS.deviceFingerprintV3];
    const fp = buildWorkerMachineFingerprint();
    await setStorage({ [STORAGE_KEYS.deviceFingerprintV3]: fp });
    return fp;
  }

  function buildWorkerMachineFingerprint() {
    // v3 (2026-05-27):移除 SW 里没用上的不稳维度,跟 popup.js / frontend
    // device-fingerprint.ts 对齐到 v3。SW 没有 window.screen,本来就比 popup 少
    // 几个维度,这里主要负责 bump 版本号。
    const raw = [
      'jizhang-machine-v3',
      getWorkerOsBucket(),
      'extension-service-worker',
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown-tz',
      navigator.language || 'unknown-lang',
      navigator.hardwareConcurrency || 0,
    ].join('|');
    return `machine-v3-${hashString(raw)}`;
  }

  function getWorkerOsBucket() {
    const platform = `${navigator.userAgentData?.platform || navigator.platform || ''} ${navigator.userAgent || ''}`;
    if (/mac/i.test(platform)) return 'mac';
    if (/win/i.test(platform)) return 'windows';
    if (/android/i.test(platform)) return 'android';
    if (/iphone|ipad|ios/i.test(platform)) return 'ios';
    if (/linux/i.test(platform)) return 'linux';
    return 'unknown-os';
  }

  function hashString(s) {
    let h1 = 0x811c9dc5;
    let h2 = 0x1b873593;
    for (let i = 0; i < s.length; i++) {
      h1 = (h1 ^ s.charCodeAt(i)) >>> 0;
      h1 = Math.imul(h1, 0x01000193);
      h2 = (h2 ^ s.charCodeAt(i)) >>> 0;
      h2 = Math.imul(h2, 0xcc9e2d51);
    }
    return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
  }

  const getStorage = (keys) =>
    new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });

  const setStorage = (values) =>
    new Promise((resolve) => {
      chrome.storage.local.set(values, resolve);
    });

  const removeStorage = (keys) =>
    new Promise((resolve) => {
      chrome.storage.local.remove(keys, resolve);
    });

  // Debounced ozon tab reload — prevents rapid reload storms on auth state changes
  let _reloadTimer = null;
  function reloadOzonTabs() {
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(async () => {
      const tabs = await chrome.tabs.query({ url: ['*://*.ozon.ru/*', '*://*.ozon.kz/*'] });
      for (const tab of tabs) {
        chrome.tabs.reload(tab.id);
      }
    }, 300);
  }

  // 插件登出 → 同步清掉所有已打开的 ERP 网页标签登录态(扩展登出时网页也登出,
  // 防止两边停在不同账号)。executeScript 注入清 localStorage + 跳 /login。
  // 幂等:若标签页本就没 token 直接 return,断开任何来回触发的循环。
  async function clearWebAuthTabs() {
    try {
      // 迁移至 erp-backend-lite:清 erp-lite /admin 标签页(localhost:3001)的登录态。
      // erp-lite admin 用 erp_admin_token / erp_admin_user 作为 localStorage key,
      // 且是 SPA hash 路由(无 /login 路径),清 key 后刷新页面即可触发登录视图。
      const tabs = await chrome.tabs.query({
        url: [`*://${BRAND_WEB_HOST}/*`],
      });
      for (const tab of tabs) {
        if (!tab.id) continue;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              try {
                localStorage.removeItem('erp_admin_token');
                localStorage.removeItem('erp_admin_user');
                localStorage.removeItem('currentOzonStoreId');
                // 刷新页面,admin.js 检测到无 token 自动显示登录视图
                location.reload();
              } catch {}
            },
          });
        } catch {}
      }
    } catch (e) {
      console.warn('[ServiceWorker] clearWebAuthTabs failed:', e?.message);
    }
  }

  let resolvedBackendUrl = null;

  const detectBackendUrl = async () => {
    // 生产构建(__JZ_PROD_BUILD__ DCE 后)只剩一个候选 URL,无需探活,直接定址。
    // 旧实现拿 /auth/captcha 当探针:MV3 SW 空闲 ~30s 即被杀,每次重启都重新探活,
    // 每次探活后端真实生成一张验证码(SVG + Redis 写)—— 是生产 /auth/captcha
    // ~11 req/s 洪水的主源(装机基数 × SW 醒睡循环,24h 不停)。
    if (BACKEND_URLS.length === 1) {
      resolvedBackendUrl = BACKEND_URLS[0];
      return resolvedBackendUrl;
    }
    // dev 双候选(localhost vs api)才需要探活,改打轻量 /health(无鉴权、不碰
    // DB/Redis、不生成验证码;后端同批次新增)。
    for (const url of BACKEND_URLS) {
      try {
        const resp = await fetch(`${url}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          resolvedBackendUrl = url;
          return url;
        }
      } catch {}
    }
    resolvedBackendUrl = BACKEND_URLS[BACKEND_URLS.length - 1];
    return resolvedBackendUrl;
  };

  const getBackendUrl = async () => {
    if (resolvedBackendUrl) return resolvedBackendUrl;
    return detectBackendUrl();
  };

  // 迁移至 erp-backend-lite:popup/content 跳转 ERP 网页时,path → admin hash 路由
  const ACTION_HASHES = {
    dashboard: '#dashboard',
    products: '#products',
    'collect-box': '#collect-box',
    favorites: '#collect-box',
    'import-history': '#listings',
    reshelf: '#listings',
    watermark: '#config',
    stores: '#stores',
    '/ozon/settings/membership': '#config',
    '/ozon/settings/jidian': '#config',
    '/ozon/templates': '#config',
    '/ozon/tools/watermark': '#config',
    '/ozon/products/collect': '#collect-box',
    '/ozon/products/import-history': '#listings',
  };

  // erp-lite 裁剪的功能(sync/agents/AI/L1/bestsellers/usage)通过 feature-flags 门控。
  // 默认 false,只有显式 true 才调用对应端点(避免打不存在的端点产生 404 噪音)。
  let cachedFeatureFlags = null;
  const getFeatureFlagsCached = async () => {
    if (cachedFeatureFlags) return cachedFeatureFlags;
    try {
      const url = await getBackendUrl();
      const stored = await getStorage([STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
      cachedFeatureFlags =
        (await apiRequest(
          'GET',
          `${url}/feature-flags/me`,
          null,
          stored[STORAGE_KEYS.token],
          stored[STORAGE_KEYS.storeId]
        )) || {};
    } catch {
      cachedFeatureFlags = {};
    }
    return cachedFeatureFlags;
  };

  /**
   * Execute fetch in a seller.ozon.ru tab's page context (MAIN world).
   * This produces a same-origin request with correct cookies, Sec-Fetch-Site,
   * and TLS fingerprint — bypassing antibot that blocks cross-site requests
   * from service worker fetch().
   *
   * Uses chrome.scripting.executeScript to inject fetch directly into
   * the seller tab — no dependency on pre-injected content scripts.
   */
  /**
   * 把 /api/v1/search 返回的 variant 转成 sv 兼容 shape，下游 distillSource /
   * resolveViaSearchVariantModel 直接用。
   *
   * /search 真实顶层字段（实测）：
   *   variant_id, variant_name, main_image, secondary_images, description_type_name,
   *   description_type_dict_value, brand_name, brand_id, is_brand_promoted, is_copy_allowed,
   *   is_content_copy_allowed, rating, skus, barcodes, categories[{id, level}]
   *
   * sv 期望：description_category_id (number) + categories[{id, level, title}]
   *   + attributes[{key, value | collection}]
   *
   * sv → /search 字段映射（确保 distillSource readSourceText/readSourceImages 都能命中）：
   *   4180 商品名 ← variant_name  ⭐ 关键，distillSource.name 来自此
   *   4194 主图  ← main_image
   *   4195 图册  ← secondary_images
   *   8229 类型名 ← description_type_name（决定 backend Strategy 1 type-name 匹配）
   *   85   品牌  ← brand_name
   *   7822 GTIN  ← barcodes[0]（路径 2 也能继承 GTIN，影响内容评分）
   *   4191 描述  ← description（/search 不返，留空）
   *   4497 重量 / 9454-9456 尺寸 ← /search 不返
   */
  const normalizeSearchVariantToSv = (v) => {
    if (!v) return null;
    // 已是 sv shape（含 attributes 数组）→ 原样返回
    if (Array.isArray(v.attributes) && v.attributes.length > 0) return v;
    const attributes = [];
    if (v.description_type_name) attributes.push({ key: '8229', value: v.description_type_name });
    if (v.brand_name) attributes.push({ key: '85', value: v.brand_name });
    // /search 商品名实际字段是 variant_name；title/name 兜底（少数 shape 用过）
    const productName = v.variant_name || v.title || v.name;
    if (productName) attributes.push({ key: '4180', value: productName });
    if (v.description) attributes.push({ key: '4191', value: v.description });
    if (v.main_image) attributes.push({ key: '4194', value: v.main_image });
    const secondaries = Array.isArray(v.secondary_images) ? v.secondary_images : [];
    if (secondaries.length > 0) attributes.push({ key: '4195', collection: secondaries });
    // GTIN(7822) — 从 /search 的 barcodes 兜底，后端 mapping 时若目标类目含 7822 会自动 copy 进 item.attributes
    if (Array.isArray(v.barcodes) && v.barcodes.length > 0) {
      const gtin = String(v.barcodes[0] || '').trim();
      if (gtin) attributes.push({ key: '7822', value: gtin });
    }
    return {
      // variant_id 优先 /search 真返的 variant_id，barcode 兜底
      variant_id: v.variant_id || (v.barcodes && v.barcodes[0]) || '',
      description_category_id: Number(v.description_type_dict_value) || 0,
      categories: (v.categories || []).map((c) => ({
        id: Number(c.id),
        level: Number(c.level),
        name: c.name || '',
        title: c.title || c.name || '',
      })),
      // 把 /search 的额外字段也带上，方便上层（如跟卖面板的 is_copy_allowed 检查）使用
      _searchMeta: {
        skus: v.skus || [],
        barcodes: v.barcodes || [],
        brand_id: v.brand_id,
        is_copy_allowed: v.is_copy_allowed,
        is_content_copy_allowed: v.is_content_copy_allowed,
        rating: v.rating,
      },
      attributes,
    };
  };

  /**
   * /api/site/seller-prototype/create-bundle-by-variant-id —— 跟卖源数据完整接口
   *
   * 老 /api/v1/search-variant-model endpoint 2026-05 被 Ozon 下线(全员 404 ResourceNotFound)。
   * 实测 /search 还活但不返物理 attributes(weight/dimensions/description)。
   * Ozon SPA 的 /app/products/copy/list (跟卖列表)用 create-bundle-by-variant-id
   * 这个 endpoint 拿跟卖商品完整后台数据:
   *
   *   item.weight                ← 重量 (grams)
   *   item.depth/width/height    ← 长/宽/高 (mm,Ozon 把"长"叫 depth)
   *   item.barcode               ← GTIN
   *   item.primary_image, images ← 主图 + 图册
   *   item.attributes[]          ← 40-63 个完整后台 attr(品牌/类目/材质/包装/...)
   *
   * 输入 variant_id 必须是 /api/v1/search 返回的真 variant_id(不是 URL 数字 SKU,两者
   * 不同 namespace)。
   *
   * **副作用**: 每次调用 Ozon 端创建一个新 bundle draft,bundle_id 递增。需要 cache
   * 控制 — 同一 SKU 默认 24 小时复用一次。源商品改类目/属性/包装时最多 1 天后刷新;
   * 需要立即刷新可在 sendMessage('searchVariants', { sku, forceRefresh: true })。
   *
   * Headers 实测带 / 不带 x-o3-app-name + x-o3-page-type 都 200 OK,沿用 fetchSellerPortal
   * 默认 headers + urlPrefix='/api/site' 即可。
   */
  const _BUNDLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  // v2 cache key 必须包含 companyId + variantId — 同一 Chrome profile 多 ozon 店时,
  // v1 (只 sku) 会让 B 店复用 A 店的 bundle item,串店导致重量/尺寸/属性串数据。
  // variant_id 在 Ozon 内是 store-scoped(create-bundle-by-variant-id 副作用产物),
  // 加 companyId 是双保险:即使将来 variant_id 复用同 namespace,companyId 也能隔离。
  const _BUNDLE_CACHE_PREFIX = 'jz-sw-bundle-v2:';
  const _bundleCacheKey = (companyId, variantId) => `${_BUNDLE_CACHE_PREFIX}${companyId || 'unknown'}:${variantId}`;

  // SW 启动时清理 v1 缓存 — 它的 key 只用 sku,可能跨店污染过用户数据。
  // 一次性清理,跑完后用户的 v2 缓存重建即可。
  (async () => {
    try {
      const all = await new Promise((r) => chrome.storage.local.get(null, r));
      const stale = Object.keys(all || {}).filter((k) => k.startsWith('jz-sw-bundle:'));
      if (stale.length) {
        await new Promise((r) => chrome.storage.local.remove(stale, r));
        console.log(`[SW] cleared ${stale.length} v1 bundle cache entries (cross-store risk)`);
      }
    } catch {}
  })();

  // SW 启动时清理 24h 过期的采集去重 cache(plan v3 子项 ②)。
  // key 形如 `jz-collect-recent-v1:{host}:{storeId}:{sourceId}:{sku}`,
  // 每次 push 成功都新写,过期项靠定期清理避免 chrome.storage.local 5MB 配额撑爆。
  //
  // codex P2 节流:MV3 SW 会反复唤醒/休眠,每次唤醒都全扫 storage 浪费。
  // 用 `jz-collect-recent-cleaned-at` 记录上次清理时间,12h 内不重复清。
  const _COLLECT_CLEANUP_KEY = 'jz-collect-recent-cleaned-at';
  const _COLLECT_CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
  (async () => {
    try {
      const stamp = await new Promise((r) =>
        chrome.storage.local.get([_COLLECT_CLEANUP_KEY], (d) => r(d?.[_COLLECT_CLEANUP_KEY]))
      );
      const now = Date.now();
      // 防御未来时间(时钟回滚 / 数据损坏):只信任 typeof number && <= now 的 stamp
      const stampAt = stamp && typeof stamp.at === 'number' && stamp.at <= now ? stamp.at : 0;
      if (stampAt > 0 && now - stampAt < _COLLECT_CLEANUP_INTERVAL_MS) {
        return; // 上次清理还在 12h 内,跳过
      }
      const all = await new Promise((r) => chrome.storage.local.get(null, r));
      const expired = Object.keys(all || {}).filter((k) => {
        if (!k.startsWith('jz-collect-recent-v1:')) return false;
        const entry = all[k];
        return entry && now - (entry.at || 0) >= 24 * 60 * 60 * 1000;
      });
      if (expired.length) {
        await new Promise((r) => chrome.storage.local.remove(expired, r));
        console.log(`[SW] cleared ${expired.length} expired collect dedupe entries (>24h)`);
      }
      await new Promise((r) => chrome.storage.local.set({ [_COLLECT_CLEANUP_KEY]: { at: now } }, r));
    } catch {}
  })();

  const fetchBundleByVariantId = async (sku, variantId, companyId, opts = {}) => {
    const cacheKey = _bundleCacheKey(companyId, variantId);
    // L1: chrome.storage.local cache(同 company+variant 24h 复用)
    // forceRefresh=true 跳过 cache 命中,直接调 endpoint 拉新 bundle(用于源商品改了类目/属性时手动刷新)
    if (!opts.forceRefresh) {
      try {
        const cached = await new Promise((resolve) => {
          chrome.storage.local.get([cacheKey], (data) => {
            resolve(data?.[cacheKey] || null);
          });
        });
        if (cached && Date.now() - (cached.at || 0) < _BUNDLE_CACHE_TTL_MS && cached.item) {
          console.log(`[searchVariants][fetchBundleByVariantId] cache hit sku=${sku} variantId=${variantId}`);
          return cached.item;
        }
      } catch {}
    }

    // L2: 真调 endpoint(有副作用)
    const resp = await fetchSellerPortal(
      '/seller-prototype/create-bundle-by-variant-id',
      {
        company_id: String(companyId),
        variant_id: String(variantId),
        source: 'SOURCE_UI_COPY_APPAREL',
      },
      {
        urlPrefix: '/api/site',
        pageType: 'products',
        timeoutMs: 30000,
        allowOzonTab: true,
        preferTabId: opts.preferTabId,
      }
    );
    console.log(`[fetchBundleByVariantId] fetch sku=${sku} variantId=${variantId}`);
    const item = resp?.item || null;
    if (!item) return null;

    // 写 cache(包括 sku + bundle_id 便于 debug,但 item 才是数据本体)
    try {
      chrome.storage.local.set({
        [cacheKey]: { at: Date.now(), item, sku, bundleId: resp.bundle_id || null },
      });
    } catch {}

    return item;
  };

  // ── seller-tree/get-by-company-id —— 完整类目树(以 descriptionCategoryId 为 key 的 map)
  // 用于按 bundleItem.description_category_id 反查 descriptionCategoryName(叶子类目名)。
  //
  // ⚠️ 这是 create-bundle 的 description_category_lvl3_name 的**唯一正确取值来源**:
  //   - description_category_lvl3_name 期望叶子类目名(如 "Набор для подвижных игр" = 户外游戏套装)
  //   - 不能用 attribute 8229 的 value —— 那是 descriptionTypeName(类型名,如 "Дартс детский"),
  //     传类型名会导致 Ozon 报错"您没有指定类型。属性是必填项"
  //   - bundleItem 只有 description_category_id(数字),没有 name 字段,必须查树反查
  //
  // 响应结构:{ result: { "15621031": { descriptionCategoryId, descriptionCategoryName,
  //   descriptionTypeId, descriptionTypeName, nodes: { ... } }, ... } }
  // 叶子节点: descriptionTypeId != "0" 且 nodes 为空;同一叶子类目下可有多个 type。
  const _SELLER_TREE_CACHE_PREFIX = 'jz-seller-tree:';
  const _SELLER_TREE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天,类目树不常变
  const _sellerTreeCacheKey = (companyId) => `${_SELLER_TREE_CACHE_PREFIX}${companyId || 'unknown'}`;

  const fetchSellerTree = async (companyId, opts = {}) => {
    if (!companyId) return null;
    const cacheKey = _sellerTreeCacheKey(companyId);
    if (!opts.forceRefresh) {
      try {
        const cached = await new Promise((r) => {
          chrome.storage.local.get([cacheKey], (d) => r(d?.[cacheKey] || null));
        });
        if (cached && Date.now() - (cached.at || 0) < _SELLER_TREE_TTL_MS && cached.tree) {
          return cached.tree;
        }
      } catch {}
    }
    const resp = await fetchSellerPortal(
      '/seller-tree/get-by-company-id',
      { company_id: String(companyId) },
      {
        urlPrefix: '/api/v1',
        pageType: 'products-other',
        timeoutMs: 30000,
        allowOzonTab: true,
        preferTabId: opts.preferTabId,
      }
    );
    // resp 可能是 { result: {catId: node, ...} } 或直接 {catId: node, ...}
    const tree = resp?.result || resp || null;
    if (!tree || typeof tree !== 'object') return null;
    try {
      chrome.storage.local.set({ [cacheKey]: { at: Date.now(), tree } });
    } catch {}
    return tree;
  };

  // 在类目树中按 descriptionCategoryId 递归 DFS 查找 descriptionCategoryName
  const findCatNameInTree = (tree, catId) => {
    if (!tree || !catId) return null;
    const target = String(catId);
    const walk = (node) => {
      if (!node) return null;
      if (String(node.descriptionCategoryId) === target) {
        return node.descriptionCategoryName || null;
      }
      const nodes = node.nodes || {};
      for (const k of Object.keys(nodes)) {
        const found = walk(nodes[k]);
        if (found) return found;
      }
      return null;
    };
    for (const k of Object.keys(tree)) {
      const found = walk(tree[k]);
      if (found) return found;
    }
    return null;
  };

  // ── 门户上架(seller-prototype bundle 合并卡)── 绕官方 /v3/product/import 限流。
  // 全部复用 fetchSellerPortal(urlPrefix=/api/site, pageType=products, allowOzonTab)
  // 在浏览器里跑,带用户真实 cookie/UA/fingerprint 绕反爬。详见门户接口契约。
  const _bundlePortalOpts = (preferTabId, timeoutMs = 30000) => ({
    urlPrefix: '/api/site',
    pageType: 'products',
    timeoutMs,
    allowOzonTab: true,
    preferTabId,
  });

  // 建空草稿 → { bundle_id }
  // 对齐官方 seller-ui app.js:create-bundle 的 body 应含
  //   { company_id, description_category_lvl3_name, source_item_id }
  // - description_category_lvl3_name: 三级类目名(按名匹配,避免跨店类目 ID 错位)
  // - source_item_id: 复制流程的源商品 ID(新建流程不传)
  const createBundle = async (companyId, preferTabId, opts = {}) => {
    const body = { company_id: String(companyId) };
    if (opts.catName) {
      body.description_category_lvl3_name = String(opts.catName);
    }
    if (opts.sourceItemId) {
      body.source_item_id = String(opts.sourceItemId);
    }
    const resp = await fetchSellerPortal('/seller-prototype/create-bundle', body, _bundlePortalOpts(preferTabId));
    const bundleId = resp?.bundle_id;
    if (!bundleId) throw new Error('create-bundle 未返回 bundle_id');
    return String(bundleId);
  };

  // 写入/保存草稿全部商品数据(可反复调)→ {}
  // 对齐官方 seller-ui app.js:update-bundle-items 的 body 为
  //   { bundle_id, company_id, items, source }
  // ⚠️ 不含 description_category_lvl3_name —— 类目信息已在 create-bundle 时固化到 bundle,
  //    每个 item 自身的类目通过 description_category_id / new_description_category_id 携带。
  // 此函数对每个 item 做字段归一化 + 必填校验,确保提交数据满足 v3 schema。
  const updateBundleItems = async (bundleId, companyId, items, source, preferTabId) => {
    const normalizedItems = (Array.isArray(items) ? items : []).map((item, idx) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`update-bundle-items: items[${idx}] 不是对象`);
      }

      // ── 归一化:确保字段类型对齐 v3 schema ──
      const out = {
        offer_id: String(item.offer_id || ''),
        name: String(item.name || ''),
        price: String(item.price || '0'),
        old_price: String(item.old_price || item.price || '0'),
        vat: String(item.vat || '0'),
        currency_code: String(item.currency_code || 'RUB'),
        weight: Number(item.weight) > 0 ? Math.round(Number(item.weight)) : 100,
        weight_unit: item.weight_unit || 'g',
        depth: Number(item.depth) > 0 ? Math.round(Number(item.depth)) : 100,
        width: Number(item.width) > 0 ? Math.round(Number(item.width)) : 100,
        height: Number(item.height) > 0 ? Math.round(Number(item.height)) : 100,
        dimension_unit: item.dimension_unit || 'mm',
        images: Array.isArray(item.images) ? item.images.map((u) => String(u)).filter(Boolean) : [],
        attributes: _normalizeV3Attributes(item.attributes),
        complex_attributes: _normalizeV3ComplexAttributes(item.complex_attributes),
        primary_image: String(item.primary_image || ''),
        color_image: String(item.color_image || ''),
        images360: Array.isArray(item.images360) ? item.images360.map((u) => String(u)).filter(Boolean) : [],
        pdf_list: Array.isArray(item.pdf_list) ? item.pdf_list : [],
        new_description_category_id: Number(item.new_description_category_id) || 0,
      };

      // type_id / description_category_id: 有值才传,为 0 不传(让 Ozon 走 create-bundle 时的 lvl3_name 按名匹配)
      if (Number(item.type_id) > 0) out.type_id = Number(item.type_id);
      if (Number(item.description_category_id) > 0) {
        out.description_category_id = Number(item.description_category_id);
      }
      if (item.barcode) out.barcode = String(item.barcode);

      // ── 必填字段校验(v3 required) ──
      const missing = [];
      if (!out.offer_id) missing.push('offer_id');
      if (!out.name) missing.push('name');
      if (!out.price || out.price === '0') missing.push('price');
      if (out.images.length === 0) missing.push('images');
      if (out.attributes.length === 0) missing.push('attributes');
      if (out.weight <= 0) missing.push('weight');
      if (out.depth <= 0) missing.push('depth');
      if (out.width <= 0) missing.push('width');
      if (out.height <= 0) missing.push('height');
      if (!out.weight_unit) missing.push('weight_unit');
      if (!out.dimension_unit) missing.push('dimension_unit');
      if (out.vat === '') missing.push('vat');

      if (missing.length > 0) {
        throw new Error(
          `update-bundle-items: items[${idx}] (offer_id=${out.offer_id}) 缺少必填字段: ${missing.join(', ')}`
        );
      }
      return out;
    });

    if (normalizedItems.length === 0) {
      throw new Error('update-bundle-items: items 为空');
    }

    return fetchSellerPortal(
      '/seller-prototype/update-bundle-items',
      {
        bundle_id: String(bundleId),
        company_id: String(companyId),
        source: source || 'SOURCE_MERGED',
        items: normalizedItems,
      },
      _bundlePortalOpts(preferTabId)
    );
  };

  // ── seller-prototype attributes 归一化 ──
  // ⚠️ seller-prototype/update-bundle-items 期望的 attribute 字段名是 `attribute_id`(字符串),
  // 不是 OPI v3 官方 API 的 `id`。传 `id` 会导致 Ozon 后台不识别,所有 attributes 被丢弃,
  // 进而触发"Вы не указали тип. Атрибут является обязательным для заполнения"报错。
  //
  // 官方 create-bundle-by-variant-id 返回的 attribute shape(权威参考):
  //   { attribute_id: "8229", complex_id: "0", values: [{ value, dictionary_value_id, sequence, complex_sequence, is_default }] }
  //
  // 我们输出的 shape(对齐 seller-prototype):
  //   { attribute_id: Number, complex_id: Number, values: [{ value, dictionary_value_id? }] }
  //
  // ⚠️ Ozon 字典类型属性(如 8229 "类型")的 values 可能只有 dictionary_value_id 而 value 为
  // 空字符串。只按 value 非空过滤会丢掉这种必填属性,导致 Ozon 报错:
  //   "Вы не указали тип. Атрибут является обязательным для заполнения"
  //   (您没有指定类型。属性是必填项)
  // 因此 filter 必须同时保留:value 非空 **或** dictionary_value_id>0 的条目。
  const _normalizeV3Attributes = (attrs) => {
    if (!Array.isArray(attrs)) return [];
    return attrs
      .map((a) => {
        if (!a || typeof a !== 'object') return null;
        const id = Number(a.id || a.attribute_id || a.key || 0);
        if (!id) return null;
        const complexId = Number(a.complex_id) || 0;
        const rawVals = Array.isArray(a.values) ? a.values : [];
        const values = rawVals
          .filter(
            (v) =>
              v &&
              ((v.value != null && v.value !== '') ||
                (v.dictionary_value_id != null && Number(v.dictionary_value_id) > 0))
          )
          .map((v) => {
            const val = typeof v === 'object' ? v : { value: String(v) };
            const o = { value: String(val.value ?? '') };
            if (val.dictionary_value_id != null && Number(val.dictionary_value_id) > 0) {
              o.dictionary_value_id = Number(val.dictionary_value_id);
            }
            return o;
          });
        if (values.length === 0) return null;
        return { attribute_id: id, complex_id: complexId, values };
      })
      .filter(Boolean);
  };

  // ── v3 complex_attributes 归一化:[{attributes:[{complex_id, id, values}]}] ──
  const _normalizeV3ComplexAttributes = (cas) => {
    if (!Array.isArray(cas)) return [];
    return cas
      .map((ca) => {
        if (!ca || typeof ca !== 'object') return null;
        const innerAttrs = _normalizeV3Attributes(ca.attributes || ca.complex_attributes);
        if (innerAttrs.length === 0) return null;
        return { attributes: innerAttrs };
      })
      .filter(Boolean);
  };

  // 提交发布:草稿 → 真实商品 → { upload_task_id }
  // 对齐官方 seller-ui app.js:upload-bundle 的 body 为
  //   { bundle_id, company_id, name }
  // - name: 类目名(与 create-bundle 时的 description_category_lvl3_name 同源,再次确认)
  // xy-ozon 扩展:额外传 strict:true 启用严格模式(无效图片/字段直接报错而非静默跳过)。
  const uploadBundle = async (bundleId, companyId, preferTabId, opts = {}) => {
    const body = {
      bundle_id: String(bundleId),
      company_id: String(companyId),
      strict: opts.strict !== undefined ? Boolean(opts.strict) : true,
    };
    if (opts.name) {
      body.name = String(opts.name);
    }
    const resp = await fetchSellerPortal('/seller-prototype/upload-bundle', body, _bundlePortalOpts(preferTabId));
    const taskId = resp?.upload_task_id;
    if (!taskId) throw new Error('upload-bundle 未返回 upload_task_id');
    return String(taskId);
  };

  // 轮询任务进度(processed/failed/warned/status,source=bundle)
  const getUploadTaskList = async (companyId, { limit = 30, page = 1 } = {}, preferTabId) =>
    fetchSellerPortal(
      '/async-upload/v1/task/get-list',
      { company_id: String(companyId), limit, page },
      _bundlePortalOpts(preferTabId)
    );

  // 拉每个 SKU 的失败原因(task_id 必须是数字)
  const getUploadTaskErrors = async (companyId, taskId, { page = 1, page_size = 50 } = {}, preferTabId) =>
    fetchSellerPortal(
      '/async-upload/v1/task/get-errors',
      { company_id: String(companyId), task_id: Number(taskId), page, page_size },
      _bundlePortalOpts(preferTabId)
    );

  // 解析当前登录店铺的 sc_company_id(门户接口都要它)
  const resolveSellerCompanyId = async () => {
    const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
    const companyId = scCookies[0]?.value || '';
    if (!companyId) throw new Error('sc_company_id cookie 未找到,请确保已登录 seller.ozon.ru');
    return companyId;
  };

  /**
   * 门户上架编排(follow-sell viaPortal):
   *   1) 后端 /ozon/products/prepare-bundle-items 同步复用全加工流水线 → 分组好的 bundles
   *   2) 解析 sc_company_id
   *   3) 逐 bundle: create-bundle → update-bundle-items → upload-bundle
   * 返回形状对齐现有 importResult.result.task_id(content 端取 task_id 不变)。
   */
  const importViaPortal = async (message, token, targetStoreId, backendUrl, preferTabId) => {
    const prep = await apiRequest(
      'POST',
      `${backendUrl}/ozon/products/prepare-bundle-items`,
      message,
      token,
      targetStoreId,
      120_000
    );
    const result = prep?.result || {};
    const bundles = Array.isArray(result.bundles) ? result.bundles : [];
    if (bundles.length === 0) {
      throw new Error(result.message || '无可上架商品(源数据不可用或被严格模式跳过)');
    }
    const companyId = await resolveSellerCompanyId();
    // 公司一致性护栏:门户路只能在「浏览器当前登录 seller.ozon.ru 的店铺」建商品。
    // 后端给了目标店铺的 company_id 且与当前登录不一致 → 会建到错误店铺,立即中止并提示切换。
    const storeCompanyId = result.store_company_id ? String(result.store_company_id) : '';
    if (storeCompanyId && storeCompanyId !== String(companyId)) {
      throw new Error(
        `所选店铺与当前 seller.ozon.ru 登录店铺不一致(目标 ${storeCompanyId} / 当前 ${companyId}),门户上架请先在浏览器切换到该店铺登录`
      );
    }
    const taskIds = [];
    const bundleIds = [];
    const bundleErrors = [];
    for (const b of bundles) {
      try {
        // 对齐官方:create-bundle 传类目名(按名匹配)+ 复制流程源商品 ID(可选)
        const catName = b.description_category_lvl3_name || '';
        const bundleId = await createBundle(companyId, preferTabId, {
          catName,
          sourceItemId: b.source_item_id || null,
        });
        // 类目已在 create-bundle 时固化到 bundle,update 不再传 description_category_lvl3_name
        await updateBundleItems(bundleId, companyId, b.items, b.source, preferTabId);
        // upload 传 name(与 create-bundle 时的 catName 同源)+ strict:true(xy-ozon 扩展)
        const taskId = await uploadBundle(bundleId, companyId, preferTabId, { name: catName });
        bundleIds.push(bundleId);
        taskIds.push(taskId);
      } catch (e) {
        const offers = Array.isArray(b.items) ? b.items.map((x) => x.offer_id).filter(Boolean) : [];
        bundleErrors.push({ offers, error: e?.message || String(e) });
        console.warn('[importViaPortal] bundle 失败:', offers.join(','), e?.message || e);
      }
    }
    if (taskIds.length === 0) {
      throw new Error(`门户上架失败: ${bundleErrors.map((x) => x.error).join('; ') || '未知错误'}`);
    }
    return {
      result: {
        viaPortal: true,
        task_id: taskIds[0],
        task_ids: taskIds,
        bundle_ids: bundleIds,
        company_id: companyId,
        strictSkipped: result.strictSkipped || [],
        invalidImage: result.invalidImage || [],
        bundleErrors,
      },
    };
  };

  /**
   * 返回一个 status='complete' 的 seller.ozon.ru tab,优先 /app/* 路径
   * (避免命中 signin/login 中间页)。没有就自动后台打开 pinned tab 并等加载完成,
   * 用户首次跟卖时会看到一个 pinned 短标签,无须手动打开。
   *
   * caller 应直接用返回值,不要自己再 query+find,否则会引入
   * "等到了一个 complete 的,但 query 后却选了另一个 loading 的" 竞态。
   */
  // 内部实现;对外用下方带 single-flight 的 ensureSellerTab 包装。
  const _ensureSellerTabImpl = async (timeoutMs = 20000) => {
    const queryTabs = () => chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
    // 2026-05-30:排除 signin/registration/auth/login 页 —— 它们的 URL 也含 /app/
    // (如 /app/registration/signin),旧 find(url.includes('/app/')) 会误选到登录页,
    // 注入后页面无有效会话 / SPA 拦截 fetch。优先选真业务页,auth 页排最后兜底。
    // (companyId 走域级 cookie 不依赖选哪个 tab,但选业务页注入更稳,也跟
    //  getMarketStats 的 tab 选择口径统一。)
    const isAuthUrl = (u) => /\/(registration|signin|auth|login)/i.test(u || '');
    const pickReadyTab = (list) =>
      list.find((t) => t.status === 'complete' && t.url?.includes('/app/') && !isAuthUrl(t.url)) ||
      list.find((t) => t.status === 'complete' && !isAuthUrl(t.url)) ||
      list.find((t) => t.status === 'complete' && t.url?.includes('/app/')) ||
      list.find((t) => t.status === 'complete') ||
      null;

    let tabs = await queryTabs();
    let ready = pickReadyTab(tabs);
    if (ready) return ready;

    // 有 tab 但都在 loading → 等它们 complete；途中全被关掉就落到下面 create
    if (tabs.length) {
      console.log('[ensureSellerTab] 已有 tab 但都在加载中，等待 complete...');
      const waitDeadline = Date.now() + timeoutMs;
      while (Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 500));
        tabs = await queryTabs();
        ready = pickReadyTab(tabs);
        if (ready) return ready;
        if (tabs.length === 0) break;
      }
      // 等待超时或全被关 → fall through 到 create 一个新 tab
      console.warn('[ensureSellerTab] 等待已有 tab complete 失败，新开一个');
    }

    console.log('[ensureSellerTab] 无可用 seller.ozon.ru tab，后台打开...');
    const created = await chrome.tabs.create({
      url: 'https://seller.ozon.ru/app/products/copy/list',
      active: false,
      pinned: true,
    });

    const createDeadline = Date.now() + timeoutMs;
    while (Date.now() < createDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const t = await chrome.tabs.get(created.id);
        if (t.status === 'complete') {
          console.log(`[ensureSellerTab] tab ${created.id} 加载完成，url=${t.url}`);
          return t;
        }
      } catch {
        throw new Error('自动打开的 seller.ozon.ru tab 已被关闭');
      }
    }
    throw new Error(`seller.ozon.ru tab 加载超时（${timeoutMs / 1000}s）`);
  };

  // single-flight 包装:并发调用(列表页多卡同时要市场数据/变体、或 fast-path 回退叠加)
  // 共享同一次"找或开 seller tab",避免各自 query→见无→create 把 seller tab 开出多个。
  // settle(成功/失败)即清缓存,允许该 tab 被关掉后下次重新开。
  let _ensureSellerTabInflight = null;
  const ensureSellerTab = (timeoutMs = 20000) => {
    if (_ensureSellerTabInflight) return _ensureSellerTabInflight;
    _ensureSellerTabInflight = _ensureSellerTabImpl(timeoutMs).finally(() => {
      _ensureSellerTabInflight = null;
    });
    return _ensureSellerTabInflight;
  };

  // what_to_sell/data/v3 单条 item 字段归一 —— 防 Ozon 改大小写/命名导致「月销量等市场
  // 字段全空但无报错横幅」的静默回归。下游(shared-utils jzPopulatePanelV2 / jzMergeCardPanelData)
  // 只读固定 camelCase(d.soldCount / d.gmvSum / d.salesDynamics ...);后端 ozon-market-data
  // .service.ts:normalizeProductItem 早已对 SoldCount/GmvSum 等 PascalCase 做兜底,扩展这条
  // 直连路一直没做 → 这里对齐后端口径。spread 原 item 保留所有已有字段(零回归),只对会被
  // 下游消费的字段补「camelCase ?? PascalCase ?? snake_case」别名,缺失才回填、绝不覆盖已有值。
  const normalizeMarketItem = (item) => {
    if (!item || typeof item !== 'object') return item;
    const pick = (...keys) => {
      for (const k of keys) if (item[k] != null) return item[k];
      return undefined;
    };
    return {
      ...item,
      // 核心销量/金额
      soldCount: pick('soldCount', 'SoldCount', 'sold_count', 'sales', 'Sales'),
      gmvSum: pick('gmvSum', 'GmvSum', 'gmv_sum', 'revenue', 'Revenue'),
      avgPrice: pick('avgPrice', 'AvgGmv', 'avgGmv', 'avg_price', 'price', 'Price'),
      salesDynamics: pick('salesDynamics', 'SalesDynamics', 'sales_dynamics'),
      drr: pick('drr', 'Drr', 'DRR'),
      // 日均
      avgOrdersOnAccDays: pick('avgOrdersOnAccDays', 'AvgOrdersOnAccDays', 'avg_orders_on_acc_days'),
      avgGmvOnAccDays: pick('avgGmvOnAccDays', 'AvgGmvOnAccDays', 'avg_gmv_on_acc_days'),
      // 促销与推广
      daysInPromo: pick('daysInPromo', 'DaysInPromo', 'days_in_promo'),
      discount: pick('discount', 'Discount'),
      promoRevenueShare: pick('promoRevenueShare', 'PromoRevenueShare'),
      daysWithTrafarets: pick('daysWithTrafarets', 'DaysWithTrafarets'),
      // 流量与转化
      qtyViewPdp: pick('qtyViewPdp', 'QtyViewPdp', 'qty_view_pdp'),
      sessionCount: pick('sessionCount', 'SessionCount', 'session_count'),
      sessionCountSearch: pick('sessionCountSearch', 'SessionCountSearch', 'session_count_search'),
      pdpToCartConversion: pick('pdpToCartConversion', 'PdpToCartConversion'),
      convToCartPdp: pick('convToCartPdp', 'ConvToCartPdp'),
      convToCartSearch: pick('convToCartSearch', 'ConvToCartSearch'),
      convViewToOrder: pick('convViewToOrder', 'ConvViewToOrder'),
      views: pick('views', 'Views'),
      // 物流与商品
      stock: pick('stock', 'Stock', 'balance'),
      salesSchema: pick('salesSchema', 'SalesSchema', 'sales_schema'),
      nullableRedemptionRate: pick('nullableRedemptionRate', 'NullableRedemptionRate', 'redemptionRate'),
      nullableCreateDate: pick('nullableCreateDate', 'NullableCreateDate', 'createDate', 'CreateDate'),
    };
  };

  // 找/开一个 www.ozon.ru 买家 tab，用于在 MAIN world 跑 composer-api 抓 PDP 图册视频
  // （SW 直 fetch composer-api 反爬必死 403，必须借买家 tab 的 cookie/UA/fingerprint）。
  // 用于 batch-upload（扩展页发起、无 ozon.ru content_script sender）逐 SKU 抓竞品视频。
  const ensureBuyerTab = async (timeoutMs = 20000) => {
    const queryTabs = () => chrome.tabs.query({ url: ['https://www.ozon.ru/*', 'https://ozon.ru/*'] });
    const pickReady = (list) =>
      list.find((t) => t.status === 'complete' && /\/(product|category|search)\b/i.test(t.url || '')) ||
      list.find((t) => t.status === 'complete') ||
      null;
    let tabs = await queryTabs();
    let ready = pickReady(tabs);
    if (ready) return ready;
    if (tabs.length) {
      const waitDeadline = Date.now() + timeoutMs;
      while (Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 500));
        tabs = await queryTabs();
        ready = pickReady(tabs);
        if (ready) return ready;
        if (tabs.length === 0) break;
      }
    }
    console.log('[ensureBuyerTab] 无可用 www.ozon.ru tab，后台打开...');
    const created = await chrome.tabs.create({ url: 'https://www.ozon.ru/', active: false, pinned: true });
    const createDeadline = Date.now() + timeoutMs;
    while (Date.now() < createDeadline) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const t = await chrome.tabs.get(created.id);
        if (t.status === 'complete') return t;
      } catch {
        throw new Error('自动打开的 www.ozon.ru tab 已被关闭');
      }
    }
    throw new Error(`www.ozon.ru tab 加载超时（${timeoutMs / 1000}s）`);
  };

  // 把任意 .mp4 直链转存成卖家自有 Ozon 视频(ir.ozone.ru/s3):走 seller-tab MAIN world 会话
  // 上传 /api/media-storage/upload-file。返回 { ok, url } 或 { ok:false, error }。
  // 抽自原 uploadFollowSellVideo case,供「一键跟卖 / 单采 / 纯采集 / 批量上架」共用同一转存实现。
  const transferVideoToOzon = async (srcUrl) => {
    if (!srcUrl || typeof srcUrl !== 'string') return { ok: false, error: 'srcUrl required' };
    const targetTab = await ensureSellerTab();
    const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
    const companyId = scCookies[0]?.value || '';
    if (!companyId) {
      return { ok: false, error: 'AUTH_REQUIRED', message: 'sc_company_id cookie 未找到，请先登录 seller.ozon.ru' };
    }
    // 在 seller.ozon.ru tab 的 MAIN world 跑:跨源拉源 .mp4 → multipart 同源 POST(带 cookie)。
    const doUpload = async (src, xCompanyId, timeout) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const dl = await fetch(src, { signal: controller.signal });
        if (!dl.ok) {
          clearTimeout(timer);
          return { ok: false, error: '源视频下载失败 ' + dl.status };
        }
        const blob = await dl.blob();
        if (!blob || blob.size === 0) {
          clearTimeout(timer);
          return { ok: false, error: '源视频为空' };
        }
        const fname = (src.split('/').pop() || 'video.mp4').split('?')[0].split('#')[0] || 'video.mp4';
        const fd = new FormData();
        fd.append('file_name', fname);
        fd.append('tmp', 'true');
        fd.append('body', new File([blob], fname, { type: blob.type || 'video/mp4' }));
        const resp = await fetch('https://seller.ozon.ru/api/media-storage/upload-file', {
          method: 'POST',
          signal: controller.signal,
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'x-o3-company-id': xCompanyId,
            'x-o3-language': 'zh-Hans',
          },
          body: fd,
        });
        clearTimeout(timer);
        if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
          return { ok: false, status: 401, error: 'Seller portal cookie已过期，请重新登录' };
        }
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          return { ok: false, status: resp.status, error: 'upload-file ' + resp.status + ': ' + t.slice(0, 200) };
        }
        const j = await resp.json().catch(() => null);
        return { ok: true, url: (j && j.url) || null, size: blob.size };
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: e.name === 'AbortError' ? '上传超时' : e.message || String(e) };
      }
    };
    const results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: doUpload,
        args: [srcUrl, companyId, 90000],
        world: 'MAIN',
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), 95000)),
    ]);
    const r = results && results[0] && results[0].result;
    if (!r) return { ok: false, error: 'executeScript 未返回结果' };
    if (!r.ok || !r.url) return { ok: false, error: r.error || '上传未返回 url' };
    console.log(`[transferVideoToOzon] ${srcUrl} → ${r.url} (${r.size}B)`);
    return { ok: true, url: r.url };
  };

  // 借买家 tab 抓某商品 PDP 的 webGallery .mp4 直链 + 源富内容(11254 文档)+ 源描述(4191)
  // + 源主题标签(23171)。给 batch-upload 逐 SKU 用:扩展页无 ozon.ru content_script,只能经
  // ensureBuyerTab 注入 fetch。/api/v1/search 不返 4191/11254/23171,这三样只活在 PDP 的
  // webDescription/富内容/webHashtags widget,故与视频同一次 page json 一并抽,零增量请求 ——
  // 让批量上架继承源店铺描述与标签(与手动跟卖 extractPageDescription/extractKeywords 同语义)。
  // 注:源标签裸下发会触发 Ozon BR_hashtag_brand,品牌清洗在 backend 注入处做(此处只负责抓回)。
  // 返回 { mp4, richContent, description, hashtags };失败返回全空(best-effort 降级)。
  const fetchVariantMediaViaBuyerTab = async (productUrl) => {
    const EMPTY = { mp4: null, richContent: '', description: '', hashtags: [] };
    if (!productUrl || typeof productUrl !== 'string') return EMPTY;
    let path = productUrl;
    try {
      const u = new URL(productUrl, 'https://www.ozon.ru');
      path = u.pathname + u.search;
    } catch {}
    if (!path.startsWith('/')) path = '/' + path;
    let tab;
    try {
      tab = await ensureBuyerTab();
    } catch (e) {
      console.warn('[fetchVariantMedia] ensureBuyerTab 失败:', e?.message || e);
      return EMPTY;
    }
    // MAIN world:相对路径同源命中(www.ozon.ru / ozon.kz),依次试 entrypoint→composer
    // (与 fetchOzonPublicProduct 同口径)。executeScript 序列化注入,不能引用 SW 闭包 ——
    // 富内容抽取逻辑须内联(与 content/ozon-product.js 的 jzExtractRichContentFromStates
    // 同规则:richAnnotationJson 字符串 / state 顶层 {content:[{widgetName}],version})。
    const doFetch = async (relPath, timeout) => {
      const endpoints = [
        `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(relPath)}`,
        `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(relPath)}`,
      ];
      const isRichDoc = (o) =>
        o &&
        typeof o === 'object' &&
        Array.isArray(o.content) &&
        o.content.length > 0 &&
        o.content.some((b) => b && typeof b === 'object' && typeof b.widgetName === 'string');
      const extractRich = (states) => {
        for (const k of Object.keys(states)) {
          let v = states[k];
          if (typeof v === 'string') {
            try {
              v = JSON.parse(v);
            } catch {
              continue;
            }
          }
          if (!v || typeof v !== 'object') continue;
          if (typeof v.richAnnotationJson === 'string' && v.richAnnotationJson.trim()) {
            try {
              if (isRichDoc(JSON.parse(v.richAnnotationJson))) return v.richAnnotationJson.trim();
            } catch {}
          }
          if (isRichDoc(v)) return JSON.stringify({ content: v.content, version: v.version || 0.3 });
        }
        return '';
      };
      const extractMp4 = (states) => {
        const helper = globalThis.JZOzonVideoExtract;
        if (helper && typeof helper.extractOzonMp4FromSources === 'function') {
          const found = helper.extractOzonMp4FromSources(Object.values(states || {}));
          if (found) return found;
        }
        for (const k of Object.keys(states || {})) {
          if (!/gallery/i.test(k)) continue;
          let v = states[k];
          if (typeof v === 'string') {
            try {
              v = JSON.parse(v);
            } catch {
              continue;
            }
          }
          const vids = v && Array.isArray(v.videos) ? v.videos : [];
          for (const it of vids) {
            const raw = typeof it === 'string' ? it : (it && (it.url || it.src)) || '';
            if (raw && /\.mp4(\?|#|$)/i.test(raw)) return raw;
          }
        }
        return null;
      };
      // 源描述(4191):优先 webDescription widget,复用注入的 JZFollowSellContentCopy.extractDescriptionText
      // (与手动跟卖同一套富文本/HTML 解析,绝不把原始 JSON 串当描述)。helper 注入失败则降级空。
      const extractDescription = (states) => {
        const helper = globalThis.JZFollowSellContentCopy;
        if (!helper || typeof helper.extractDescriptionText !== 'function') return '';
        const keys = Object.keys(states || {});
        const descKeys = keys.filter((k) => /description/i.test(k));
        for (const k of descKeys) {
          let v = states[k];
          if (typeof v === 'string') {
            try {
              v = JSON.parse(v);
            } catch {
              /* 当字符串直接抽 */
            }
          }
          const text = helper.extractDescriptionText(v, 4096);
          if (text) return text;
        }
        return '';
      };
      // 源主题标签(23171):从 webHashtags/tagList state 里递归捞 `#` 前缀串。纯内联(无 helper 依赖),
      // 去重 + 上限 30(Ozon 单卡上限)。品牌清洗在 backend 注入处做,这里只负责把源标签原样抓回。
      const extractHashtags = (states) => {
        const out = [];
        const seen = new Set();
        const push = (s) => {
          const t = String(s == null ? '' : s).trim();
          if (!t || t.length < 2 || !t.startsWith('#')) return;
          const key = t.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          if (out.length < 30) out.push(t);
        };
        const walk = (node, depth) => {
          if (out.length >= 30 || depth > 32 || node == null) return;
          if (typeof node === 'string') {
            push(node);
            return;
          }
          if (Array.isArray(node)) {
            for (const it of node) walk(it, depth + 1);
            return;
          }
          if (typeof node === 'object') {
            for (const k of Object.keys(node)) walk(node[k], depth + 1);
          }
        };
        for (const k of Object.keys(states || {})) {
          if (!/hashtag|taglist/i.test(k)) continue;
          let v = states[k];
          if (typeof v === 'string') {
            try {
              v = JSON.parse(v);
            } catch {
              continue;
            }
          }
          walk(v, 0);
        }
        return out;
      };
      let anyOk = false;
      let richContent = '';
      let mp4 = null;
      let description = '';
      let hashtags = [];
      for (const url of endpoints) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const resp = await fetch(url, {
            credentials: 'include',
            headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!resp.ok) continue;
          anyOk = true;
          const data = await resp.json();
          const states = data && data.widgetStates ? data.widgetStates : {};
          if (!richContent) richContent = extractRich(states);
          if (!mp4) mp4 = extractMp4(states);
          if (!description) description = extractDescription(states);
          if (!hashtags.length) hashtags = extractHashtags(states);
          // 视频 + 富内容都到手即可提前结束(描述/标签随当前 states 顺带抽,不单独多跑 endpoint);
          // 否则继续试下一个 endpoint(视频/富内容偶尔只在 composer 而不在 entrypoint)。
          if (mp4 && richContent) break;
        } catch (e) {
          clearTimeout(timer);
          // 单个 endpoint 失败 → 试下一个。
        }
      }
      // 有 200 过则按真实抽取结果返回;全失败则 ok:false。
      return anyOk
        ? { ok: true, mp4, richContent, description, hashtags }
        : { ok: false, error: 'all endpoints failed' };
    };
    try {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/ozon-video-extract.js'],
          world: 'MAIN',
        });
      } catch (e) {
        console.warn('[fetchVariantMedia] video helper inject failed:', e?.message || e);
      }
      try {
        // doFetch 的 extractDescription 复用 JZFollowSellContentCopy.extractDescriptionText;
        // 注入失败仅降级描述抽取(返回空),不影响视频/富内容/标签。
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/follow-sell-content-copy.js'],
          world: 'MAIN',
        });
      } catch (e) {
        console.warn('[fetchVariantMedia] content-copy helper inject failed:', e?.message || e);
      }
      const results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: doFetch,
          args: [path, 15000],
          world: 'MAIN',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), 40000)),
      ]);
      const r = results && results[0] && results[0].result;
      if (!r || !r.ok) {
        console.warn('[fetchVariantMedia] 抓取失败:', r && r.error);
        return EMPTY;
      }
      return {
        mp4: r.mp4 || null,
        richContent: r.richContent || '',
        description: r.description || '',
        hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
      };
    } catch (e) {
      console.warn('[fetchVariantMedia] executeScript 异常:', e?.message || e);
      return EMPTY;
    }
  };

  // ── seller.ozon.ru 门户全局节奏闸门 ──────────────────────────────────────────
  // 所有走 fetchSellerPortal 的门户调用(采集 /search + create-bundle、跟卖预取、
  // 数据面板、bestsellers 等)共用这一把闸门,保证相邻两次门户请求至少间隔
  // SELLER_PORTAL_MIN_INTERVAL_MS。seller portal 按"短时请求密度"做反爬风险评分,
  // 批量上架 / 快速浏览叠加时会瞬时打出大量请求触发验证码 / 限制登录;这里把所有出口的
  // 请求节奏串行摊平,是采集层 BATCH 节流之外的全局兜底(作用域不同,二者互补)。
  // 注:transferVideoToOzon 的 upload-file 是独立 executeScript 路径,不经此闸门,
  // 由 sku-collect.js 的 VIDEO_INTERVAL_MS 单独节流。
  const SELLER_PORTAL_MIN_INTERVAL_MS = 200;
  let _sellerPortalGateChain = Promise.resolve();
  let _sellerPortalLastAt = 0;
  const _sellerPortalGate = () => {
    const wait = _sellerPortalGateChain.then(async () => {
      const delta = Date.now() - _sellerPortalLastAt;
      if (delta < SELLER_PORTAL_MIN_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, SELLER_PORTAL_MIN_INTERVAL_MS - delta));
      }
      _sellerPortalLastAt = Date.now();
    });
    // 串行化:下一个调用排在这次放行之后;.catch 防止异常断链(wait 只 await setTimeout,不会 reject)。
    _sellerPortalGateChain = wait.catch(() => {});
    return wait;
  };

  // ── 跨域快路:在「当前/任意 ozon.ru 标签页」内直发 seller 门户请求 ──────────────
  // 实测(2026-06-14):www.ozon.ru 与 seller.ozon.ru 同属 .ozon.ru,sc_company_id /
  // 登录态 cookie 域级共享;只要满足 CORS「简单请求」(content-type:text/plain、
  // 不带任何 x-o3-* 自定义头、company_id 放进 body),从 www 商品页就能跨域读到
  // seller.ozon.ru/api/v1/search 与 create-bundle-by-variant-id 的响应(type:cors 200)。
  // 好处:用户跟卖时本就在 www 商品页 → 无需另开 / 依赖一个已登录的 seller 专用标签,
  // 根治「请先打开 seller.ozon.ru / executeScript 与 bridge 均不可用」这类失败。
  // 限制:只适用于 company_id 可放 body 的端点(/search、create-bundle);
  // what_to_sell/data/v3 强制 x-o3-company-id 自定义头(必触发预检被 CORS 挡)→ 不走此路。
  // 失败(无 ozon 标签 / 注入失败 / 反爬 / 网络)由 fetchSellerPortal 回退老 seller-tab 路。
  const fetchSellerViaOzonTab = async (path, body, opts = {}, preferTabId = null) => {
    const timeoutMs = opts.timeoutMs || 30000;
    const urlPrefix = opts.urlPrefix !== undefined ? opts.urlPrefix : '/api/v1';

    // 解析目标标签:优先消息来源标签(用户正所在的 www 商品页),否则任意已加载完成的
    // *.ozon.ru 标签(www 或 seller 都行 —— cookie 域级共享、且都有真实浏览器指纹)。
    const isOzonUrl = (u) => /^https?:\/\/([^/]+\.)?ozon\.ru\//i.test(u || '');
    let target = null;
    if (preferTabId) {
      try {
        const t = await chrome.tabs.get(preferTabId);
        if (t && isOzonUrl(t.url)) target = t; // 来源标签是 live 的(它刚发的消息),不强求 complete
      } catch {}
    }
    if (!target) {
      const tabs = await chrome.tabs.query({ url: ['*://*.ozon.ru/*'] });
      target =
        tabs.find((t) => t.status === 'complete' && t.active) || tabs.find((t) => t.status === 'complete') || null;
    }
    if (!target) {
      const e = new Error('无可用 ozon.ru 标签(跨域快路)');
      e.tabUnavailable = true;
      throw e;
    }

    // 注入 MAIN world 的跨域 fetch:严格只用 CORS-safelisted 头(content-type:text/plain),
    // company_id 已在 body 内。任何自定义头都会触发预检 → seller 不放行 → Failed to fetch。
    const doFetchXO = async (apiPath, reqBody, timeout, prefix) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await fetch('https://seller.ozon.ru' + (prefix || '/api/v1') + apiPath, {
          method: 'POST',
          signal: controller.signal,
          credentials: 'include',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify(reqBody),
        });
        clearTimeout(timer);
        if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
          return { ok: false, status: 401, code: 'AUTH_REDIRECT', error: 'Seller portal cookie已过期，请重新登录' };
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          let parsedCode = '';
          try {
            const j = JSON.parse(text);
            parsedCode = (j && (j.code || (j.error && j.error.code))) || '';
          } catch {}
          return {
            ok: false,
            status: resp.status,
            code: parsedCode,
            error: `Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}`,
          };
        }
        return { ok: true, data: await resp.json() };
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') return { ok: false, error: `请求超时 (${timeout}ms)` };
        return { ok: false, error: e.message || String(e) };
      }
    };

    let results;
    try {
      results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: target.id },
          func: doFetchXO,
          args: [path, body, timeoutMs, urlPrefix],
          world: 'MAIN',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), timeoutMs + 5000)),
      ]);
    } catch (e) {
      // 注入层失败(标签正在导航 / 权限 / 超时)→ 标记 tabUnavailable,允许回退 seller-tab 路
      const err = new Error(`ozon-tab 注入失败: ${e.message || e}`);
      err.tabUnavailable = true;
      throw err;
    }
    const r = results?.[0]?.result;
    if (!r) {
      const e = new Error('ozon-tab executeScript 未返回结果');
      e.tabUnavailable = true;
      throw e;
    }
    if (!r.ok) {
      const err = new Error(r.error || 'unknown');
      if (typeof r.status === 'number') err.status = r.status;
      if (typeof r.code === 'string') err.code = r.code;
      throw err; // HTTP 层错误 → 交给 fetchSellerPortal 决定是否回退(404/ResourceNotFound 权威空结果不回退)
    }
    console.log(`[fetchSellerViaOzonTab] ok tab=${target.id} url=${target.url} path=${path}`);
    return r.data;
  };

  const fetchSellerPortal = async (path, body, timeoutMsOrOpts = 30000) => {
    await _sellerPortalGate(); // 全局节奏闸门(见上)——所有门户调用共用,摊平请求密度防反爬
    // 兼容旧调用：第三个参数可以是数字（timeoutMs，默认 page-type=products-other + url=/api/v1+path），
    // 也可以是 opts 对象 { timeoutMs, urlPrefix, pageType }
    const opts = typeof timeoutMsOrOpts === 'number' ? { timeoutMs: timeoutMsOrOpts } : timeoutMsOrOpts || {};
    const timeoutMs = opts.timeoutMs || 30000;
    const urlPrefix = opts.urlPrefix !== undefined ? opts.urlPrefix : '/api/v1';
    const pageType = opts.pageType || 'products-other';

    // 0. 跨域快路:opts.allowOzonTab 的调用(/search、create-bundle —— company_id 在 body、
    // 无需 x-o3-* 自定义头)优先在「当前 ozon.ru 标签页」内直发,免依赖 seller 专用标签。
    // 成功直接返回;404/ResourceNotFound 是权威空结果(SKU 不在目录)也直接抛;
    // 其余失败(无 ozon 标签 / 注入失败 / 反爬 / 网络)静默回退到下面的 seller-tab 老路。
    if (opts.allowOzonTab) {
      try {
        return await fetchSellerViaOzonTab(path, body, opts, opts.preferTabId);
      } catch (e) {
        if (e.status === 404 && e.code === 'ResourceNotFound') throw e;
        console.warn(`[fetchSellerPortal] ozon-tab 快路失败,回退 seller-tab: ${e.message || e}`);
      }
    }

    // 1. Find or auto-open seller.ozon.ru tab —— 直接用 ensureSellerTab 返回的
    // status=complete 的 tab,不再 query+find,避免选到 loading 中的 active tab。
    const targetTab = await ensureSellerTab();

    console.log(`[fetchSellerPortal] tab=${targetTab.id} url=${targetTab.url} path=${path}`);

    // 2. Resolve sc_company_id from chrome.cookies
    const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
    const companyId = scCookies[0]?.value || '';
    if (!companyId) {
      throw new Error('sc_company_id cookie 未找到，请确保已登录 seller.ozon.ru');
    }

    // 3. Try executeScript first (with hard timeout), fallback to bridge
    const doFetch = async (apiPath, reqBody, xCompanyId, timeout, prefix, pageTypeHdr) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await fetch('https://seller.ozon.ru' + (prefix || '/api/v1') + apiPath, {
          method: 'POST',
          signal: controller.signal,
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-o3-app-name': 'seller-ui',
            'x-o3-company-id': xCompanyId,
            'x-o3-language': 'zh-Hans',
            'x-o3-page-type': pageTypeHdr || 'products-other',
          },
          body: JSON.stringify(reqBody),
        });
        clearTimeout(timer);
        if (resp.redirected && (resp.url.includes('/signin') || resp.url.includes('/login'))) {
          return { ok: false, status: 401, code: 'AUTH_REDIRECT', error: 'Seller portal cookie已过期，请重新登录' };
        }
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          // codex review HIGH#7:把 status + response.code 单独抠出来传给上游
          // classifyError。原版只塞进字符串 msg,任何字串里凑巧含 "ResourceNotFound"
          // 都会被当业务空结果吞掉。
          let parsedCode = '';
          try {
            const json = JSON.parse(text);
            parsedCode = (json && (json.code || (json.error && json.error.code))) || '';
          } catch {}
          return {
            ok: false,
            status: resp.status,
            code: parsedCode,
            error: `Seller portal 请求失败 (${resp.status}): ${text.slice(0, 200)}`,
          };
        }
        return { ok: true, data: await resp.json() };
      } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') return { ok: false, error: `请求超时 (${timeout}ms)` };
        return { ok: false, error: e.message || String(e) };
      }
    };

    // Wrap executeScript with a hard timeout to prevent hang
    const tryExecuteScript = () =>
      Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: doFetch,
          args: [path, body, companyId, timeoutMs, urlPrefix, pageType],
          world: 'MAIN',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), timeoutMs + 5000)),
      ]);

    // Bridge fallback (tabs.sendMessage to ozon-seller-bridge.js)
    const tryBridge = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('bridge 超时')), timeoutMs + 5000);
        chrome.tabs.sendMessage(
          targetTab.id,
          {
            type: 'sellerPortalFetch',
            apiPath: path,
            reqBody: body,
            fallbackCompanyId: companyId,
            timeoutMs,
            urlPrefix,
            pageType,
          },
          (resp) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(resp);
          }
        );
      });

    // codex review HIGH#7:把 doFetch 返回的 status / code 透传到 Error 对象上,
    // 让上游 classifyError 直接看 status === 404 && code === 'ResourceNotFound',
    // 不再靠 msg.includes() 字符串 sniffing(会把 "Forbidden ... ResourceNotFound"
    // 之类的混合错误也吞成业务空结果)。
    const makeStructuredError = (r) => {
      const err = new Error(r.error || 'unknown');
      if (typeof r.status === 'number') err.status = r.status;
      if (typeof r.code === 'string') err.code = r.code;
      return err;
    };

    // Strategy: try executeScript → if fail, try bridge → if fail, throw
    const methods = [
      {
        name: 'executeScript',
        fn: async () => {
          const results = await tryExecuteScript();
          const r = results?.[0]?.result;
          if (!r) throw new Error('executeScript 未返回结果');
          if (!r.ok) throw makeStructuredError(r);
          return r.data;
        },
      },
      {
        name: 'bridge',
        fn: async () => {
          const r = await tryBridge();
          if (!r) throw new Error('bridge 返回错误');
          if (!r.ok) throw makeStructuredError(r);
          return r.data;
        },
      },
    ];

    // 收集每个策略的真实错误，最终 throw 时拼进 message —— 保留 "过期/登录/超时/403"
    // 等关键字,让上游 ozon-product.js prefetchSourceVariant 的 errorCode classifier
    // 能命中 AUTH_REQUIRED / TIMEOUT / ANTIBOT_BLOCKED 等具体分类。
    const lastErrors = [];
    for (const m of methods) {
      try {
        console.log(`[fetchSellerPortal] trying ${m.name}...`);
        const data = await m.fn();
        console.log(`[fetchSellerPortal] ${m.name} succeeded`);
        return data;
      } catch (e) {
        const msg = e.message || String(e);
        console.warn(`[fetchSellerPortal] ${m.name} failed: ${msg}`);
        // codex review HIGH#7:status=404 + code=ResourceNotFound 是稳定的业务
        // 空结果(SKU 不在自家目录),不是 strategy 失败 —— 不需要 fallback 到
        // bridge,也不该把它和 strategy 失败混在一起。直接抛 structured error。
        if (e.status === 404 && e.code === 'ResourceNotFound') {
          throw e;
        }
        lastErrors.push({ name: m.name, msg, status: e.status, code: e.code });
      }
    }
    const detail = lastErrors.map((x) => `${x.name}: ${x.msg}`).join(' | ');
    const err = new Error(`Seller portal 请求失败 — ${detail}`);
    // 多个 strategy 都失败,挑第一个非空 status 透传(通常 executeScript 已经拿到
    // 后端的 4xx 状态,bridge 失败可能是 chrome runtime 错)。
    const firstWithStatus = lastErrors.find((x) => typeof x.status === 'number');
    if (firstWithStatus) {
      err.status = firstWithStatus.status;
      if (firstWithStatus.code) err.code = firstWithStatus.code;
    }
    throw err;
  };

  /**
   * 在用户的 www.ozon.ru tab 里执行 fetch — 通过 chrome.scripting.executeScript
   * 注入 MAIN world 跑,带着用户真实的 cookie + UA + fingerprint。SW 直 fetch
   * 会被 Ozon 反爬拦截返回 403(Origin: chrome-extension://... 是死亡标记)。
   *
   * 调用场景:
   *   - fetchProductPageState (composer-api page json)
   *
   * @param {Object} sender chrome.runtime.onMessage 的 sender, 至少要有 tab.id + tab.url
   * @param {string} apiUrl 完整 URL,例: 'https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=...'
   * @param {number} timeoutMs
   * @returns {Promise<{ok:true, data:any}|{ok:false, status?:number, error:string}>}
   */
  const fetchOzonWwwViaTab = async (sender, apiUrl, timeoutMs = 15_000) => {
    const tab = sender?.tab;
    const tabUrl = tab?.url || '';
    const tabId = tab?.id;
    // 仅当 sender 是 ozon.ru 域下的 content_script 时走 MAIN world 注入。
    // 弹窗/options/其他扩展页发起的请求落不到这里(它们也用不到这俩 action)。
    // ozon.kz 同样允许,这俩 endpoint 在哈站点也存在。
    const isOzonTab = /^https?:\/\/(?:www\.|m\.)?ozon\.(?:ru|kz)(?::\d+)?\//i.test(tabUrl);
    if (!tabId || !isOzonTab) {
      // 没 tab 上下文 → 退回 SW 直 fetch(几乎必 403,但留口子万一未来 ozon 不反爬了)。
      try {
        const resp = await fetch(apiUrl, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resp.ok) {
          return { ok: false, status: resp.status, error: `Ozon ${resp.status}` };
        }
        const data = await resp.json();
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: `network: ${e?.message || e}` };
      }
    }
    // executeScript 注入 MAIN world,fetch 跑在 page 上下文,带 www.ozon.ru 完整 cookies。
    const doFetchInPage = async (url, timeout) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const resp = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
          return { ok: false, status: resp.status, error: `Ozon ${resp.status}` };
        }
        return { ok: true, data: await resp.json() };
      } catch (e) {
        clearTimeout(timer);
        if (e?.name === 'AbortError') return { ok: false, error: `请求超时 (${timeout}ms)` };
        return { ok: false, error: e?.message || String(e) };
      }
    };
    try {
      const results = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          func: doFetchInPage,
          args: [apiUrl, timeoutMs],
          world: 'MAIN',
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeScript 超时')), timeoutMs + 5000)),
      ]);
      const r = results?.[0]?.result;
      if (!r) return { ok: false, error: 'executeScript 未返回结果' };
      return r;
    } catch (e) {
      return { ok: false, error: `executeScript: ${e?.message || e}` };
    }
  };

  const apiRequest = async (method, url, body, token, storeId, timeoutMs = 60_000) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (storeId) headers['x-ozon-store-id'] = storeId;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorMsg = '请求失败';
        let errorCode = null;
        // 只读一次 body:先取文本,再尝试 JSON.parse。不能 response.json() 失败后再
        // response.text() —— body 流只能读一次,二次读会抛
        // "Failed to execute 'text' on 'Response': body stream already read",
        // 把真正的后端错误(常是 502/空响应/非 JSON 网关页)掩盖成这条假错误。
        const rawBody = await response.text().catch(() => '');
        try {
          const errorBody = JSON.parse(rawBody);
          errorMsg = errorBody.message || errorBody.error || errorMsg;
          errorCode = errorBody.code || null;
        } catch {
          errorMsg = rawBody || errorMsg;
        }
        // 任何 401（设备被顶 / token 过期 / 签名失败 / 缺 tenant 上下文）
        // 都视为登录失效：清 token + storeId，让前端显示重登提示。
        // 之前只识别 TOKEN_REVOKED，导致 jwt expired 等场景静默失败、
        // 用户继续看到挂死状态。
        if (response.status === 401) {
          await removeStorage([STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
          if (errorCode == null) errorCode = 'AUTH_EXPIRED';
        }
        const err = new Error(`[${response.status}] ${errorMsg}`);
        err.status = response.status;
        err.code = errorCode;
        throw err;
      }

      // 滑动续期:后端在 token 用过半时重签并塞 X-Refreshed-Token,收到就替换本地 token
      // (同 jti、无感),让活跃用户永不掉登录、少弹「请重新登录」。
      const refreshed = response.headers.get('X-Refreshed-Token');
      if (refreshed) {
        try {
          await setStorage({ [STORAGE_KEYS.token]: refreshed });
        } catch {}
      }
      return response.json();
    } catch (e) {
      if (e?.name === 'AbortError' || /signal is aborted/i.test(e?.message || '')) {
        if (timedOut) {
          throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s 无响应）`);
        }
        throw new Error('后台服务被浏览器挂起，请重试');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  // ── 代采(没登卖家端 → 派给同租户已登录设备代采)─────────────────
  // 本机未登录 seller.ozon.ru(无 sc_company_id)时,searchVariants 透明回退到
  // 这里:向后端入队一个 tenant-scope 的 ozon.collect_variant 任务,等同租户内
  // 某台已登录设备(具备 ozon.seller_collect 能力)在它自己的浏览器里跑同一套
  // searchVariants 采集并回传。结果 shape 与本地 searchVariants 完全一致
  // ({ ok:true, data:{ items } }),所以 sku-collect.js 调用方零改动。
  // 返回:成功 → 采集结果对象;无人代采/超时/失败 → null(调用方按未登录处理)。
  const COLLECT_PROXY_POLL_INTERVAL_MS = 1500;
  const COLLECT_PROXY_TIMEOUT_MS = 90_000;
  // 市场数据代采的并发上限:类目/搜索网格一次会对几十个 SKU 调 getMarketStats,未登录用户
  // 若每个都派单会刷爆 job 表 + 拖垮代采设备(代采方串行执行)。这里把同时在途的市场代采
  // 限到 5 个;超出的直接返回 null(那张卡落「需登录」提示),PDP 单品恒能派。批量代采(一个
  // job 带多 SKU)是后续优化项。
  const MD_PROXY_MAX_INFLIGHT = 5;
  let _mdProxyInflight = 0;
  const proxyCollectVariant = async (backendUrl, token, storeId, sku) => {
    if (!token) return null; // 未登录极掌,无法派单
    try {
      const job = await apiRequest(
        'POST',
        `${backendUrl}/browser-agents/collection-jobs`,
        { sku: String(sku), ...(storeId ? { storeId } : {}) },
        token,
        storeId,
        20_000
      );
      const jobId = job?.id;
      if (!jobId) return null;
      // 已经是终态(罕见:同 SKU 在途任务刚好刚完成)直接用。
      if (job.status === 'succeeded' && job.result) {
        return job.result?.data?.items ? job.result : null;
      }
      const deadline = Date.now() + COLLECT_PROXY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, COLLECT_PROXY_POLL_INTERVAL_MS));
        let cur;
        try {
          cur = await apiRequest(
            'GET',
            `${backendUrl}/browser-agents/collection-jobs/${jobId}`,
            null,
            token,
            storeId,
            20_000
          );
        } catch (e) {
          // 轮询单次失败不致命,继续重试到 deadline。
          continue;
        }
        if (cur?.status === 'succeeded') {
          // helper 回传的就是 searchVariants 响应({ ok, data:{ items } })。
          return cur.result?.data?.items ? cur.result : null;
        }
        if (['failed', 'expired', 'cancelled', 'skipped'].includes(cur?.status)) {
          return null; // 无人代采或代采失败 → 回退未登录处理
        }
      }
      return null; // 超时
    } catch (e) {
      console.warn('[collect-proxy] dispatch failed:', e?.message || e);
      return null;
    }
  };

  // 代采「市场数据」:本机没登卖家端时,把按 SKU 取月销量(what_to_sell/data/v3)派给同租户/
  // 池子里已登录 seller 的设备代发(后端服务器 IP 直连会撞反爬,只能借用户浏览器)。
  // 与 proxyCollectVariant 同构。成功返回远端 getMarketStats 的整包 { ok, data }(data 可能
  // 为 null = 该 SKU 确无市场数据);派单失败/超时/无人代采返回 null,由调用方回退到「需登录」提示。
  const proxyMarketData = async (backendUrl, token, storeId, sku, period) => {
    if (!token) return null; // 未登录极掌,无法派单
    if (_mdProxyInflight >= MD_PROXY_MAX_INFLIGHT) return null; // 限流:网格场景别刷爆代采池
    _mdProxyInflight++;
    try {
      const job = await apiRequest(
        'POST',
        `${backendUrl}/browser-agents/market-data-jobs`,
        { sku: String(sku), ...(storeId ? { storeId } : {}), ...(period ? { period } : {}) },
        token,
        storeId,
        20_000
      );
      const jobId = job?.id;
      if (!jobId) return null;
      if (job.status === 'succeeded' && job.result) {
        return job.result; // { ok, data }
      }
      const deadline = Date.now() + COLLECT_PROXY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, COLLECT_PROXY_POLL_INTERVAL_MS));
        let cur;
        try {
          cur = await apiRequest(
            'GET',
            `${backendUrl}/browser-agents/market-data-jobs/${jobId}`,
            null,
            token,
            storeId,
            20_000
          );
        } catch (e) {
          continue; // 轮询单次失败不致命
        }
        if (cur?.status === 'succeeded') {
          return cur.result || null; // 远端 getMarketStats 整包 { ok, data }
        }
        if (['failed', 'expired', 'cancelled', 'skipped'].includes(cur?.status)) {
          return null; // 无人代采或失败 → 回退「需登录」提示
        }
      }
      return null; // 超时
    } catch (e) {
      console.warn('[market-data-proxy] dispatch failed:', e?.message || e);
      return null;
    } finally {
      _mdProxyInflight--;
    }
  };

  // ── product-data 合批器 ──────────────────────────────────────
  // 搜索页每张商品卡发一条 getProductStats,旧实现逐卡 GET /ozon/product-data/:sku
  // (生产实测 ~11.5 req/s,后端最高频接口之一)。这里在 SW 层把短窗口内到达的 SKU
  // 合成一次 POST /ozon/product-data/batch,content script 完全无感知。
  // 到达模式 = 首屏 6 连发(content taskQueue 并发数)+ 队列 trickle,故用
  // debounce(每次到达顺延 100ms)+ 硬上限(首个入队后最多等 300ms)+ 凑满 50 立发。
  // 数据卡片渲染本就等 variantsQueue(300ms+),这点合批延迟完全被遮住。
  const productStatsBatch = {
    pending: new Map(), // sku -> resolve[]
    ctx: null, // { backendUrl, token, storeId }
    debounceTimer: null,
    maxWaitTimer: null,
  };

  const flushProductStatsBatch = async () => {
    const { pending, ctx } = productStatsBatch;
    clearTimeout(productStatsBatch.debounceTimer);
    clearTimeout(productStatsBatch.maxWaitTimer);
    productStatsBatch.pending = new Map();
    productStatsBatch.ctx = null;
    productStatsBatch.debounceTimer = null;
    productStatsBatch.maxWaitTimer = null;
    if (!pending.size || !ctx) return;

    const skus = [...pending.keys()];
    const dataBySku = {};
    try {
      const res = await apiRequest(
        'POST',
        `${ctx.backendUrl}/ozon/product-data/batch`,
        { skus },
        ctx.token,
        ctx.storeId
      );
      Object.assign(dataBySku, res?.data || {});
    } catch {
      // batch 端点不可用(后端未升级 / 瞬时故障)→ 退回逐 SKU GET,行为同旧版
      await Promise.all(
        skus.map(async (sku) => {
          try {
            const r = await apiRequest(
              'GET',
              `${ctx.backendUrl}/ozon/product-data/${sku}?skipMarket=1`,
              null,
              ctx.token,
              ctx.storeId
            );
            dataBySku[sku] = r?.data || null;
          } catch {
            dataBySku[sku] = null;
          }
        })
      );
    }
    for (const [sku, resolvers] of pending) {
      for (const resolve of resolvers) resolve({ ok: true, data: dataBySku[sku] ?? null });
    }
  };

  const queueProductStats = (sku, ctx) =>
    new Promise((resolve) => {
      const cur = productStatsBatch.ctx;
      // 换号/换店/换后端时先冲掉旧批,严禁跨上下文混批
      if (cur && (cur.token !== ctx.token || cur.storeId !== ctx.storeId || cur.backendUrl !== ctx.backendUrl)) {
        flushProductStatsBatch();
      }
      productStatsBatch.ctx = ctx;
      const arr = productStatsBatch.pending.get(sku) || [];
      arr.push(resolve);
      productStatsBatch.pending.set(sku, arr);

      if (productStatsBatch.pending.size >= 50) {
        flushProductStatsBatch();
        return;
      }
      clearTimeout(productStatsBatch.debounceTimer);
      productStatsBatch.debounceTimer = setTimeout(flushProductStatsBatch, 100);
      if (!productStatsBatch.maxWaitTimer) {
        productStatsBatch.maxWaitTimer = setTimeout(flushProductStatsBatch, 300);
      }
    });

  const createContextMenus = () => {
    chrome.contextMenus.removeAll(() => {});
  };

  // ── 插件更新检查 ──
  const getCurrentVersion = () => chrome.runtime.getManifest().version;

  const compareVersions = (v1, v2) => {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const a = parts1[i] || 0;
      const b = parts2[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  };

  /**
   * Compute hex SHA-256 of an ArrayBuffer using SubtleCrypto.
   */
  const sha256Hex = async (buffer) => {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };

  /**
   * Re-download the zip from `downloadUrl` and verify its SHA-256 matches
   * `expectedHex`. Returns true on match, false otherwise (including network
   * failures — fail closed for security).
   */
  const verifyExtensionHash = async (downloadUrl, expectedHex) => {
    if (!expectedHex || !/^[0-9a-f]{64}$/i.test(expectedHex)) return false;
    try {
      const resp = await fetch(downloadUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(60_000),
        cache: 'no-cache',
      });
      if (!resp.ok) {
        console.warn(`[checkForUpdate] zip fetch failed: ${resp.status}`);
        return false;
      }
      const buf = await resp.arrayBuffer();
      const computed = await sha256Hex(buf);
      const match = computed.toLowerCase() === expectedHex.toLowerCase();
      if (!match) {
        console.error(`[checkForUpdate] SHA-256 mismatch: expected=${expectedHex} computed=${computed}`);
      }
      return match;
    } catch (e) {
      console.warn(`[checkForUpdate] hash verify failed: ${e?.message || e}`);
      return false;
    }
  };

  const checkForUpdate = async () => {
    try {
      const backendUrl = await getBackendUrl();
      // 分销商 brand build 时,build.js 把 brand.code 注入到 globalThis.__JZ_BRAND__。
      // 必须带 brand 参数,后端按 brand 路由到对应分销商 zip 的 version/url/sha256 —
      // 不带的话 backend 默认返回主插件元数据,分销商插件会被引导去下主插件 zip。
      const brandCode =
        (typeof globalThis !== 'undefined' &&
          globalThis.__JZ_BRAND__ &&
          typeof globalThis.__JZ_BRAND__.code === 'string' &&
          globalThis.__JZ_BRAND__.code) ||
        '';
      const brandQuery = brandCode && brandCode !== 'platform' ? `&brand=${encodeURIComponent(brandCode)}` : '';
      const updateUrl = `${backendUrl}/extension/latest?client=extension${brandQuery}`;
      const resp = await fetch(updateUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
        cache: 'no-cache',
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.version) return;

      const currentVersion = getCurrentVersion();
      if (compareVersions(data.version, currentVersion) <= 0) {
        // 已是最新版本，清除更新提示
        await removeStorage([
          STORAGE_KEYS.latestVersion,
          STORAGE_KEYS.latestDownloadUrl,
          STORAGE_KEYS.latestSha256,
          STORAGE_KEYS.updateDismissedVersion,
        ]);
        chrome.action.setBadgeText({ text: '' });
        return;
      }

      // 有新版本：先验证 SHA-256 再展示更新角标。后端 v0.9.40+ 返回 sha256；
      // 旧后端无该字段时降级为告警（保留兼容路径，但 console 留痕）。
      const downloadUrl = data.downloadUrl || data.url || '';
      const expectedHash = typeof data.sha256 === 'string' ? data.sha256.trim() : '';
      let verified = false;

      if (!downloadUrl) {
        console.warn('[checkForUpdate] missing downloadUrl, skipping');
        return;
      }

      if (expectedHash) {
        // 同版本号已通过校验则跳过重复下载
        const cached = await getStorage([STORAGE_KEYS.latestVersion, STORAGE_KEYS.latestSha256]);
        if (cached[STORAGE_KEYS.latestVersion] === data.version && cached[STORAGE_KEYS.latestSha256] === expectedHash) {
          verified = true;
        } else {
          verified = await verifyExtensionHash(downloadUrl, expectedHash);
        }
      } else if (brandCode && brandCode !== 'platform') {
        // 分销商 brand 必须有 sha256。空表示该 brand 还未跑过新版 build —
        // 此时 downloadUrl 可能指向某次"旧 build 的 zip",但我们没法在客户端验证
        // 完整性。直接拒装,留个角标提示运营 rebuild。
        console.warn(
          `[checkForUpdate] brand=${brandCode} backend returned no sha256 — refusing install (run /admin/distributor/extension/build to refresh)`
        );
        verified = false;
      } else {
        // 平台主插件:历史上 EXTENSION_DOWNLOAD_SHA256 不一定配置,沿用 legacy
        // 兼容路径(只警告不拒装)。仅适用 brand==='' 或 'platform' 分支。
        console.warn(
          '[checkForUpdate] backend returned no sha256 — running in legacy compatibility mode (no integrity check)'
        );
        verified = true;
      }

      if (!verified) {
        // 校验失败：不写入版本/下载链接，提示用户当前更新不可信
        await removeStorage([STORAGE_KEYS.latestVersion, STORAGE_KEYS.latestDownloadUrl, STORAGE_KEYS.latestSha256]);
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
        try {
          chrome.notifications.create('extension-update-untrusted', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: '插件更新校验失败',
            message: '官方下载文件 SHA-256 不匹配，已阻止本次更新提示。请检查后端配置或联系管理员。',
            priority: 2,
          });
        } catch {}
        return;
      }

      await setStorage({
        [STORAGE_KEYS.latestVersion]: data.version,
        [STORAGE_KEYS.latestDownloadUrl]: downloadUrl,
        [STORAGE_KEYS.latestSha256]: expectedHash,
      });
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#ff4d4f' });
    } catch {
      // 网络失败时静默忽略
    }
  };

  // 注册定时检查 alarm
  const setupUpdateAlarm = () => {
    chrome.alarms.create(UPDATE_CHECK_ALARM, {
      delayInMinutes: 1, // 启动后 1 分钟首次检查
      periodInMinutes: UPDATE_CHECK_INTERVAL_MINUTES,
    });
  };

  // ── 跟卖任务失败检查 ──
  const checkFollowSellTasks = async () => {
    try {
      const data = await getStorage([STORAGE_KEYS.token, STORAGE_KEYS.storeId, STORAGE_KEYS.followSellNotifiedIds]);
      const token = data[STORAGE_KEYS.token];
      const storeId = data[STORAGE_KEYS.storeId];
      if (!token || !storeId) return; // 未登录或未选店铺，跳过

      const backendUrl = await getBackendUrl();
      const resp = await apiRequest(
        'GET',
        `${backendUrl}/ozon/products/import-by-sku/tasks?current=1&pageSize=20`,
        null,
        token,
        storeId,
        15_000
      );
      const items = resp?.items || [];
      if (!Array.isArray(items) || items.length === 0) return;

      const notified = new Set(
        Array.isArray(data[STORAGE_KEYS.followSellNotifiedIds]) ? data[STORAGE_KEYS.followSellNotifiedIds] : []
      );
      const cutoff = Date.now() - FOLLOW_SELL_RECENT_WINDOW_MS;
      const newlyFailed = items.filter((t) => {
        if (t.status !== 'FAILED') return false;
        if (!t.localTaskId) return false;
        if (notified.has(t.localTaskId)) return false;
        const createdAtMs = t.createdAt ? new Date(t.createdAt).getTime() : 0;
        return createdAtMs >= cutoff;
      });

      for (const task of newlyFailed) {
        const firstItem =
          Array.isArray(task.itemsPreview) && task.itemsPreview.length > 0 ? task.itemsPreview[0] : null;
        const itemCount = Array.isArray(task.itemsPreview) ? task.itemsPreview.length : 0;
        const title =
          itemCount > 1
            ? `跟卖失败 (${itemCount} 个商品)`
            : `跟卖失败${firstItem?.name ? `：${String(firstItem.name).slice(0, 30)}` : ''}`;
        const message = task.errorMessage
          ? String(task.errorMessage).slice(0, 180)
          : '跟卖任务后台执行失败，请在插件弹窗「上架记录」中查看。';
        try {
          chrome.notifications.create(`follow-sell-fail-${task.localTaskId}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title,
            message,
            priority: 1,
          });
        } catch (e) {
          // notification 权限缺失时静默
        }
        notified.add(task.localTaskId);
      }

      if (newlyFailed.length > 0) {
        // 保留最近 200 条，防止存储无限增长
        const pruned = Array.from(notified).slice(-200);
        await setStorage({ [STORAGE_KEYS.followSellNotifiedIds]: pruned });
      }
    } catch (e) {
      console.log('[followSell-check] failed:', e?.message || e);
    }
  };

  const setupFollowSellCheckAlarm = () => {
    chrome.alarms.create(FOLLOW_SELL_CHECK_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: FOLLOW_SELL_CHECK_INTERVAL_MINUTES,
    });
  };

  const setupHeartbeatAlarm = () => {
    chrome.alarms.create(HEARTBEAT_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: HEARTBEAT_INTERVAL_MINUTES,
    });
  };

  // ── 极掌算价：拉取 CNY→RUB 实时汇率 ──
  const refreshExchangeRate = async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const r = await fetch(FX_API_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const rate = Number(data?.rates?.RUB);
      if (!isFinite(rate) || rate <= 0) throw new Error('invalid rate');
      await setStorage({
        [FX_STORAGE_KEY]: { rate, ts: Date.now(), source: 'open.er-api.com' },
      });
      return rate;
    } catch (e) {
      console.warn('[jzc-fx] refresh failed:', e?.message || e);
      return null;
    }
  };

  const setupFxAlarm = () => {
    chrome.alarms.create(FX_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: FX_REFRESH_INTERVAL_MINUTES,
    });
  };

  // ── client-side sync 接入 ──
  // 在 IIFE 内拼装 closures 注入到 globalThis.JzBackendClient(它在 importScripts 期间
  // 创建了 setContext stub,等我们调用才有效),保证 backend-client 能复用
  // SW 现有的 getBackendUrl + token storage 路径。
  const initClientSyncContext = () => {
    if (!globalThis.JzBackendClient) return; // importScripts 失败时不可用
    globalThis.JzBackendClient.setContext({
      getBackendUrl: async () => {
        return await getBackendUrl();
      },
      getAuthToken: async () => {
        const s = await getStorage([STORAGE_KEYS.token]);
        return s[STORAGE_KEYS.token] || null;
      },
    });
  };

  const initBrowserAgentContext = () => {
    if (!globalThis.JzBrowserAgentRuntime) return;
    globalThis.JzBrowserAgentRuntime.setContext({
      getDeviceKey: async () => getExtensionFingerprint(),
      getDeviceName: async () => {
        const manifest = chrome.runtime.getManifest() || {};
        return `${manifest.name || '极掌'} / Chrome`;
      },
    });
  };

  const setupBrowserAgentAlarm = () => {
    chrome.alarms.create(BROWSER_AGENT_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: BROWSER_AGENT_INTERVAL_MINUTES,
    });
  };

  // Phase 3 补:启动时尝试从 backend 拉 /ozon/sync/client-intervals,失败用 default。
  // 24h 缓存(JzSyncState),允许后端集中调整 tenant 同步频率而不需要扩展更新。
  const setupClientSyncAlarms = async () => {
    if (!globalThis.JzSyncEngine) return;
    // erp-lite 门控:client_sync 默认 false,未启用时跳过 sync alarm 注册
    const ff = await getFeatureFlagsCached();
    if (ff?.client_sync !== true) return;
    let intervals = { ...CLIENT_SYNC_INTERVALS };
    try {
      const cached = await globalThis.JzSyncState?.getIntervals?.();
      if (cached) {
        intervals = {
          POSTINGS: cached.postingsMin || intervals.POSTINGS,
          PRODUCTS: cached.productsMin || intervals.PRODUCTS,
          WAREHOUSES: cached.warehousesMin || intervals.WAREHOUSES,
        };
      } else {
        // cache miss / TTL 过期 — fetch + 存
        const fresh = await globalThis.JzBackendClient?.getClientIntervals();
        if (fresh) {
          intervals = {
            POSTINGS: fresh.postingsMin || intervals.POSTINGS,
            PRODUCTS: fresh.productsMin || intervals.PRODUCTS,
            WAREHOUSES: fresh.warehousesMin || intervals.WAREHOUSES,
          };
          await globalThis.JzSyncState?.setIntervals?.(fresh);
        }
      }
    } catch (e) {
      // 未登录 / 后端不通 — 静默用 default(灰度期间 OPI 一旦不可用,扩展端也跑不动)
      console.log('[client-sync] interval fetch failed, using defaults:', e?.message || e);
    }
    for (const type of CLIENT_SYNC_TYPES) {
      chrome.alarms.create(`${CLIENT_SYNC_ALARM_PREFIX}${type}`, {
        delayInMinutes: 1,
        periodInMinutes: intervals[type],
      });
    }
  };

  // 手动 sync 并发限流(Codex P1 #2):"全部同步" UI 在 ~100ms 内可连发
  // N×3 条 jzManualSync 消息,直接 fire-and-forget 会瞬间起 15+ 并发 Ozon
  // request,极易撞 antibot / 429。这里限制同时最多 3 个 runOneType,多余排队。
  // 队列长度无上限 — UI 那侧只发 active stores × 3 条,有界。
  const MANUAL_SYNC_MAX_CONCURRENT = 3;
  let manualSyncRunning = 0;
  const manualSyncQueue = [];
  const runManualSyncBounded = async (task) => {
    if (manualSyncRunning >= MANUAL_SYNC_MAX_CONCURRENT) {
      await new Promise((resolve) => manualSyncQueue.push(resolve));
    }
    manualSyncRunning++;
    try {
      await task();
    } finally {
      manualSyncRunning--;
      const next = manualSyncQueue.shift();
      if (next) next();
    }
  };

  // 在飞守卫:同类型一次只能有一个 runRound 在跑。Codex P1 #1。
  //
  // 背景:周期性 alarm 触发 runRound,长跨度同步(POSTINGS 多店 + Ozon 慢)经常
  // 单轮超过 alarm interval (POSTINGS 默认 3min),下一轮 alarm 又 fire,且
  // backend sync-lease 允许同 holderDeviceId 重新 acquire(它把同 holder 重 acquire
  // 当成 heartbeat 续约),结果同店同类型并发跑 → Ozon API 重复 call + 双写 cache。
  //
  // 这里用 SW 进程级 Set 作为最便宜的守卫(每 SW 实例独立,无跨进程同步)。
  // 多店 sync 在 runRound 内部循环,守卫粒度是"type",对齐 alarm/lease 粒度。
  const runningTypes = new Set();

  const handleClientSyncAlarm = async (alarmName) => {
    if (!globalThis.JzSyncEngine) return;
    // erp-lite 门控:client_sync 未启用时跳过(防 alarm 已注册但 flag 后续关闭)
    const ff = await getFeatureFlagsCached();
    if (ff?.client_sync !== true) return;
    const type = alarmName.slice(CLIENT_SYNC_ALARM_PREFIX.length);
    if (!CLIENT_SYNC_TYPES.includes(type)) return;
    // 没登录就跳过(JzBackendClient.getAuthToken 会抛"No backend auth token")
    const s = await getStorage([STORAGE_KEYS.token]);
    if (!s[STORAGE_KEYS.token]) return;
    if (runningTypes.has(type)) {
      console.log(`[client-sync] skip ${type}: previous round still running`);
      return;
    }
    runningTypes.add(type);
    try {
      await globalThis.JzSyncEngine.runRound(type);
    } catch (e) {
      console.warn(`[client-sync] runRound(${type}) crashed:`, e?.message || e);
    } finally {
      runningTypes.delete(type);
    }
  };

  const handleBrowserAgentAlarm = async () => {
    if (!globalThis.JzBrowserAgentRuntime) return;
    // erp-lite 门控:proxy_collect 默认 false,未启用时跳过代采
    const ff = await getFeatureFlagsCached();
    if (ff?.proxy_collect !== true) return;
    const s = await getStorage([STORAGE_KEYS.token]);
    if (!s[STORAGE_KEYS.token]) return;
    await globalThis.JzBrowserAgentRuntime.tick();
  };

  const sendHeartbeat = async () => {
    try {
      const stored = await getStorage([STORAGE_KEYS.token]);
      const token = stored[STORAGE_KEYS.token];
      if (!token) return;
      const backendUrl = await getBackendUrl();
      const fp = await getExtensionFingerprint();
      await apiRequest(
        'PUT',
        `${backendUrl}/auth/device/heartbeat`,
        { deviceFingerprint: fp, platform: 'extension' },
        token,
        null
      );
    } catch (e) {
      // 心跳失败不上报
    }
  };

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === UPDATE_CHECK_ALARM) {
      checkForUpdate();
    } else if (alarm.name === FOLLOW_SELL_CHECK_ALARM) {
      checkFollowSellTasks();
    } else if (alarm.name === HEARTBEAT_ALARM) {
      sendHeartbeat();
    } else if (alarm.name === FX_ALARM) {
      refreshExchangeRate();
    } else if (alarm.name.startsWith(CLIENT_SYNC_ALARM_PREFIX)) {
      handleClientSyncAlarm(alarm.name);
    } else if (alarm.name === BROWSER_AGENT_ALARM) {
      handleBrowserAgentAlarm();
    }
  });

  chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId.startsWith('follow-sell-fail-')) {
      chrome.action.openPopup().catch(() => {});
      chrome.notifications.clear(notificationId);
    }
  });

  /**
   * Reload all seller.ozon.ru tabs so manifest-declared content_scripts get injected.
   * Needed when the extension loads after the tab is already open (e.g. install/update/startup).
   */
  const reloadSellerTabs = async () => {
    const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
    for (const tab of tabs) {
      chrome.tabs.reload(tab.id);
    }
    if (tabs.length) console.log(`[reloadSellerTabs] reloaded ${tabs.length} seller tab(s)`);
  };

  chrome.runtime.onInstalled.addListener(() => {
    detectBackendUrl();
    createContextMenus();
    setupUpdateAlarm();
    setupFollowSellCheckAlarm();
    setupHeartbeatAlarm();
    setupFxAlarm();
    initClientSyncContext();
    initBrowserAgentContext();
    setupClientSyncAlarms();
    setupBrowserAgentAlarm();
    checkForUpdate();
    refreshExchangeRate();
    handleBrowserAgentAlarm();
    reloadSellerTabs();
  });

  chrome.runtime.onStartup.addListener(() => {
    setupFollowSellCheckAlarm();
    setupHeartbeatAlarm();
    setupFxAlarm();
    initClientSyncContext();
    initBrowserAgentContext();
    setupClientSyncAlarms();
    setupBrowserAgentAlarm();
    refreshExchangeRate();
    handleBrowserAgentAlarm();
    reloadSellerTabs();
  });

  // SW 冷启动(install/startup 之外的 import 时)也要 init,
  // 因为 chrome 在 SW 唤醒时不会再触发 onStartup。
  initClientSyncContext();
  initBrowserAgentContext();

  // tab 关闭时清理采集器心跳记录
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (collectorTabs.has(tabId)) collectorTabs.delete(tabId);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 极掌算价：手动重拉汇率（content/jzc-calc.js 走 message.type 路由，
    // 与现有 message.action dispatch 完全独立）
    if (message?.type === 'jzc:refreshFx') {
      refreshExchangeRate().then((rate) => sendResponse({ ok: rate != null, rate }));
      return true;
    }

    // 读取 www.ozon.ru 买家页的 window.__NUXT__.state(用于富内容 11254 抽取的反爬参数
    // sh / start_page_id)。content_script 跑在隔离世界,看不到页面 MAIN world 的
    // __NUXT__ 全局变量,故走 executeScript MAIN world 注入。
    // 协议:request  { action:'getNuxtState' }
    //       response { ok, state?: { pageInfoUrl, requestID, sh, startPageId }, error? }
    if (message?.action === 'getNuxtState') {
      (async () => {
        try {
          const tabId = sender?.tab?.id;
          if (!tabId) {
            sendResponse({ ok: false, error: 'no tab context' });
            return;
          }
          const readNuxt = () => {
            try {
              const s = window.__NUXT__?.state;
              if (!s) return { hasNuxt: false };
              const pageUrl = s.pageInfo?.url || '';
              const shMatch = pageUrl.match(/[?&]sh=([^&]+)/);
              const sh = shMatch?.[1] || '';
              const requestID = s.requestID || '';
              const startPageId = requestID || s.o3Params?.['x-o3-requestid'] || '';
              return {
                hasNuxt: true,
                pageInfoUrl: pageUrl,
                requestID,
                sh,
                startPageId,
              };
            } catch (e) {
              return { hasNuxt: false, error: e?.message || String(e) };
            }
          };
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: readNuxt,
            world: 'MAIN',
          });
          const r = results?.[0]?.result;
          if (!r) {
            sendResponse({ ok: false, error: 'executeScript 未返回结果' });
            return;
          }
          sendResponse({ ok: true, data: r });
        } catch (e) {
          sendResponse({ ok: false, error: `executeScript: ${e?.message || e}` });
        }
      })();
      return true;
    }

    // 商品页采集 fallback:Ozon 2026 起逐步把 PDP state 从 SSR DOM 剥离到纯
    // 客户端 hydrate(web* widget 元素只剩 shell,data-state 全空)。
    // content_script extractProductData 读 DOM 拿不到 title/images/sku/aspects
    // 全部 → 触发"采集失败"页。
    //
    // 这里走 composer-api page json 拉同一份数据(用浏览器 cookie/IP,不打 backend),
    // 解析 widgetStates 返回结构化字段。content_script 收到后注入 panel 替代
    // DOM 解析结果。
    //
    // 协议:request  { action:'fetchProductPageState', url }
    //       response { ok, fields?, raw?, error? }
    //   fields: { title, sku, productId, price, currency, images[], coverImage,
    //             aspects[], seller:{name,link}, brand, category }
    if (message?.action === 'fetchProductPageState') {
      (async () => {
        try {
          const inputUrl = String(message?.url || '').trim();
          if (!inputUrl) {
            sendResponse({ ok: false, error: 'url required' });
            return;
          }
          // 抠 product path (/product/...-SKU/)。url 可能是绝对(用户当前 href)
          // 也可能是相对路径。
          let productPath = inputUrl;
          try {
            const u = new URL(inputUrl, 'https://www.ozon.ru');
            productPath = u.pathname;
          } catch {}
          if (!productPath.startsWith('/product/')) {
            sendResponse({ ok: false, error: 'not a product url' });
            return;
          }
          // composer-api page endpoint。SW 直 fetch 反爬必死 403,走 fetchOzonWwwViaTab
          // 通过 sender 的 ozon.ru tab 注入 MAIN world,带用户真实 cookie + fingerprint。
          // (2026-05-26 修复:fetchProductPageState 在采集面板报 "Ozon 403"。)
          const apiUrl = `https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(productPath)}`;
          const fetchResult = await fetchOzonWwwViaTab(sender, apiUrl, 15_000);
          if (!fetchResult.ok) {
            sendResponse({ ok: false, error: fetchResult.error || `Ozon ${fetchResult.status}` });
            return;
          }
          const data = fetchResult.data;
          const ws = data?.widgetStates || {};
          const keys = Object.keys(ws);
          const find = (prefix) => keys.find((k) => k.startsWith(prefix));
          const parse = (key) => {
            if (!key) return null;
            const raw = ws[key];
            if (typeof raw === 'object' && raw !== null) return raw;
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          };
          const gallery = parse(find('webGallery'));
          const heading = parse(find('webProductHeading'));
          const aspects = parse(find('webAspects'));
          const price = parse(find('webPrice'));
          const seller = parse(find('webCurrentSeller'));
          const shortChars = parse(find('webShortCharacteristics'));
          const detailSku = parse(find('webDetailSKU'));
          const brand = parse(find('webBrand'));
          // sku 优先 gallery.sku,fallback detailSku
          const sku = String(
            gallery?.sku || detailSku?.sku || detailSku?.itemId || productPath.match(/-(\d+)\/?$/)?.[1] || ''
          );
          // images: gallery 通常 {images:[{url,...}, ...], coverImage:{url,...}}
          const images = Array.isArray(gallery?.images)
            ? gallery.images.map((it) => (typeof it === 'string' ? it : it?.url || it?.link || it?.src)).filter(Boolean)
            : [];
          const coverImage =
            typeof gallery?.coverImage === 'string'
              ? gallery.coverImage
              : gallery?.coverImage?.url || gallery?.coverImage?.link || images[0] || '';
          // seller link / name
          let sellerName = '';
          let sellerLink = '';
          try {
            sellerName =
              seller?.header?.title?.text ||
              seller?.sellerCell?.centerBlock?.title?.text ||
              seller?.sellerCell?.name ||
              seller?.name ||
              '';
            sellerLink =
              seller?.header?.title?.link ||
              seller?.sellerCell?.centerBlock?.title?.link ||
              seller?.sellerCell?.link ||
              seller?.link ||
              '';
          } catch {}
          // brand
          let brandName = '';
          try {
            brandName = brand?.title || brand?.name || '';
          } catch {}
          // price
          const priceStr = price?.cardPrice || price?.price || price?.originalPrice || '';
          const fields = {
            title: heading?.title || '',
            sku,
            productId: sku,
            price: priceStr,
            images,
            coverImage,
            aspects: Array.isArray(aspects?.aspects) ? aspects.aspects : [],
            seller: { name: sellerName, link: sellerLink },
            brand: brandName,
            shortCharacteristicsRaw: shortChars || null,
          };
          // 也把 raw widgetStates 回传 — content_script 的 extractStateData
          // fallback 缓存层会把它当作"伪 SSR DOM" 用,让所有走 extractStateData 的
          // 老逻辑透明命中 composer-api 数据,不需要逐个改 caller。
          // 体积控制:不传 webPdpGrid / 容器类(布局 meta),只传业务 widget。
          const usefulPrefixes = [
            'webGallery',
            'webProductHeading',
            'webAspects',
            'webPrice',
            'webAddToCart',
            'webCurrentSeller',
            'webBrand',
            'webDetailSKU',
            'webShortCharacteristics',
            'webCharacteristics',
            'webDescription',
            'webMarketingLabels',
            'webSale',
            'webReviewProductScore',
            'webSingleProductScore',
            'webModelParams',
            'webHashtags',
            'webBestSeller',
            'webProductMainWidget',
          ];
          const widgetStates = {};
          for (const k of keys) {
            if (usefulPrefixes.some((p) => k.startsWith(p))) {
              widgetStates[k] = ws[k];
            }
          }
          // shared-utils.js window.sendMessage 协议:成功必须 { ok:true, data:{...} }
          // 否则 caller 只 resolve(response.data) 会拿到 undefined。
          // 之前平铺 { ok, fields, widgetStates } 导致 ensurePdpState 静默失败
          // (fire-and-forget 没人发现,但下游 findStateDataByKeys 一直命中 stale DOM)。
          sendResponse({ ok: true, data: { fields, widgetStates } });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    // expandModelVariants 不在 SW 实现 — content/ozon-product.js 里直接 fetch SSR HTML
    // (path-only,带 same-origin cookies,200 OK)+ DOMParser 解析。原因:
    //   `/api/composer-api.bx/page/json/v2?url=...` 已被 Ozon antibot 全员 403(2026-05-26
    //   端到端验证;含当前页 fetch 自己也 403),改走 SSR HTML 路径。
    //   SW 无 DOMParser,所以解析必须在 content/page context 完成,本来就不需要绕一圈 SW。

    // L1 (composer-api 拦截) 样本上报。content/collector/l1-bridge.js batch 推送。
    // 默认 dry-run — chrome.storage.local.l1ReportEnabled=true 才真发网络请求。
    // Phase 1 PoC 不要急着开,先用 __jzc.l1Stats() 在 page 端看本地影子表数据。
    if (message?.type === 'JZC_L1_SAMPLE') {
      const samples = Array.isArray(message.samples) ? message.samples : [];
      l1SwStats.receivedBatches += 1;
      l1SwStats.receivedSamples += samples.length;
      // 异步处理,马上回 ack 避免 content script hold 连接
      sendResponse({ ok: true, batchSize: samples.length });
      (async () => {
        try {
          const stored = await getStorage([STORAGE_KEYS.l1ReportEnabled, STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
          if (!stored[STORAGE_KEYS.l1ReportEnabled]) {
            l1SwStats.droppedDisabled += samples.length;
            return;
          }
          // erp-lite 门控:l1_samples 默认 false,未启用时不上报
          const ffL1 = await getFeatureFlagsCached();
          if (ffL1?.l1_samples !== true) {
            l1SwStats.droppedDisabled += samples.length;
            return;
          }
          const token = stored[STORAGE_KEYS.token];
          const storeId = stored[STORAGE_KEYS.storeId];
          if (!token) {
            l1SwStats.droppedNoAuth += samples.length;
            return;
          }
          const backendUrl = await getBackendUrl();
          // 后端 endpoint 占位 — 实际 schema/路径需要后端先开。HTTP 失败静默,不重试。
          await apiRequest(
            'POST',
            `${backendUrl}/extension/l1-samples`,
            { samples, sentAt: Date.now() },
            token,
            storeId,
            15_000
          );
          l1SwStats.sentSamples += samples.length;
          l1SwStats.lastSentAt = Date.now();
        } catch (err) {
          l1SwStats.httpErrors += 1;
          l1SwStats.lastError = err && err.message ? err.message : String(err);
        }
      })();
      return false; // sync response 已发,async 工作 fire-and-forget
    }

    // 前端"立即同步"按钮(my.jizhangerp.com 等)走 postMessage → bridge →
    // chrome.runtime.sendMessage 触发本店本类型一次同步。bridge 是 jizhangerp.com
    // 域内 content_script,这里直接调 JzSyncEngine.runOneType,跳过 backend BullMQ。
    //
    // 协议:request  { type:'jzManualSync', storeId, syncType:'PRODUCTS'|'POSTINGS'|'WAREHOUSES' }
    //       response { ok, jobId?, error? }
    //
    // 设计:
    //  1) 先 GET 一遍 token / sync 模块就绪检查,缺啥就 ok:false 让前端 fallback;
    //  2) SW 端 pre-write PENDING 行(同步 await),保证 frontend poll
    //     /ozon/sync/jobs/:jobId 立刻能命中,不会 404 看起来像扩展挂了;
    //  3) sendResponse({ ok:true, jobId }) 后 fire-and-forget runOneType 入并发限流队列
    //     (Codex P1 #2):"全部同步" UI 在 100ms 内可连发 N×3 条消息,如果直接
    //     fire-and-forget 会瞬间起 15+ 并发 Ozon 请求 → 撞 antibot / 429。
    //     manualSyncSem 限制同时 ≤ 3 个 runOneType,多余排队。lease-busy / crash
    //     的状态上报维持原逻辑(在 runOneType 落地后)。
    if (message?.type === 'jzManualSync') {
      (async () => {
        try {
          const storeId = String(message?.storeId || '').trim();
          const syncType = String(message?.syncType || '').toUpperCase();
          if (!storeId || !['PRODUCTS', 'POSTINGS', 'WAREHOUSES'].includes(syncType)) {
            sendResponse({ ok: false, error: 'invalid storeId/syncType' });
            return;
          }
          // erp-lite 门控:client_sync 默认 false,未启用时拒绝手动同步
          const ffMs = await getFeatureFlagsCached();
          if (ffMs?.client_sync !== true) {
            sendResponse({ ok: false, error: 'sync_disabled' });
            return;
          }
          if (!globalThis.JzSyncEngine || !globalThis.JzSyncState || !globalThis.JzBackendClient) {
            sendResponse({ ok: false, error: 'sync_modules_not_loaded' });
            return;
          }
          const stored = await getStorage([STORAGE_KEYS.token]);
          if (!stored[STORAGE_KEYS.token]) {
            sendResponse({ ok: false, error: 'extension_not_authed' });
            return;
          }
          const deviceId = await globalThis.JzSyncState.getOrCreateDeviceId();
          const jobId = crypto.randomUUID();
          try {
            await globalThis.JzBackendClient.clientReport({
              storeId,
              type: syncType,
              clientJobId: jobId,
              deviceId,
              status: 'PENDING',
            });
          } catch (e) {
            sendResponse({
              ok: false,
              error: `client-report PENDING failed: ${e?.message || e}`,
            });
            return;
          }
          sendResponse({ ok: true, jobId });
          // fire-and-forget,通过 runManualSyncBounded 限流(P1 #2)。runOneType 落地
          // 后照旧根据 lease-busy / crash 上报 FAILED 终态。
          runManualSyncBounded(() =>
            globalThis.JzSyncEngine.runOneType({ id: storeId }, syncType, deviceId, jobId)
              .then(async (res) => {
                if (res?.skipped === 'lease-busy') {
                  await globalThis.JzBackendClient.clientReport({
                    storeId,
                    type: syncType,
                    clientJobId: jobId,
                    deviceId,
                    status: 'FAILED',
                    error: 'lease-busy: 另一台设备正在同步该店铺同类型数据',
                  }).catch(() => {});
                }
              })
              .catch(async (e) => {
                console.warn('[jzManualSync] runOneType crash:', e?.message || e);
                await globalThis.JzBackendClient.clientReport({
                  storeId,
                  type: syncType,
                  clientJobId: jobId,
                  deviceId,
                  status: 'FAILED',
                  error: String(e?.message || e).slice(0, 500),
                }).catch(() => {});
              })
          );
        } catch (e) {
          try {
            sendResponse({ ok: false, error: e?.message || String(e) });
          } catch {}
        }
      })();
      return true;
    }

    if (message?.type === 'JZC_L1_REPORT_STATUS') {
      (async () => {
        const stored = await getStorage([STORAGE_KEYS.l1ReportEnabled, STORAGE_KEYS.token]);
        sendResponse({
          enabled: !!stored[STORAGE_KEYS.l1ReportEnabled],
          authed: !!stored[STORAGE_KEYS.token],
          stats: { ...l1SwStats },
          hint: stored[STORAGE_KEYS.l1ReportEnabled]
            ? 'L1 上报已启用'
            : 'dry-run: 本地影子表写入正常,后端上报关闭。启用: chrome.storage.local.set({ l1ReportEnabled: true })',
        });
      })();
      return true;
    }

    const getSellerPortalCompanyId = async () => {
      const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
      const companyId = scCookies[0]?.value || '';
      if (!companyId) {
        throw new Error('sc_company_id not found, please login seller.ozon.ru first');
      }
      return companyId;
    };

    const handle = async () => {
      const data = await getStorage([STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
      const token = data[STORAGE_KEYS.token];
      const storeId = data[STORAGE_KEYS.storeId];
      const backendUrl = await getBackendUrl();

      switch (message?.action) {
        case 'getAuth': {
          // version 由 manifest 注入,前端用它判断是否需要升级提示
          const manifest = chrome.runtime.getManifest() || {};
          const version = String(manifest.version || '');
          return { ok: true, data: { token, storeId, backendUrl, version } };
        }
        case 'usageTrack': {
          // 通用功能埋点。当天每个 (featureKey, client, version) 组合只发一次到
          // backend — 设备级去重避免高频写,backend 用 (tenantId, featureKey,
          // usageDate, client, version) unique 索引做最终聚合。失败静默,不影响
          // 调用方。client / version 由 sw 自动从 manifest 注入,调用方无需关心。
          try {
            const featureKey = String(message?.featureKey || '').trim();
            if (!featureKey || !/^[a-z0-9][a-z0-9:_\-]{1,63}$/.test(featureKey)) {
              return { ok: false, error: 'invalid featureKey' };
            }
            if (!token) return { ok: false, error: 'no auth' };
            // erp-lite 门控:usage_track 默认 false,未启用时不埋点
            const ffUt = await getFeatureFlagsCached();
            if (ffUt?.usage_track !== true) return { ok: true, deduped: true, gated: true };
            const manifest = chrome.runtime.getManifest() || {};
            // 用 manifest.name 区分主插件 vs lite (lite 名字含 'lite' / '极简')。
            // 不依赖 build 配置,降版/换插件时自动适应。
            const isLite = /lite|极简/i.test(manifest.name || '');
            const client = isLite ? 'lite' : 'main';
            const version = String(manifest.version || 'unknown').slice(0, 16);
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const dedupeKey = `${featureKey}@${client}@${version}`;
            const stored = await getStorage([STORAGE_KEYS.usageTrackedDate]);
            const map = stored[STORAGE_KEYS.usageTrackedDate] || {};
            if (map[dedupeKey] === today) {
              return { ok: true, deduped: true };
            }
            // 先标记再发请求 — 即使网络失败也不重试,防止刷爆。
            map[dedupeKey] = today;
            await setStorage({ [STORAGE_KEYS.usageTrackedDate]: map });
            await apiRequest(
              'POST',
              `${backendUrl}/usage/track`,
              { featureKey, client, version },
              token,
              storeId,
              5000
            );
            return { ok: true };
          } catch (e) {
            // 静默失败,埋点不能影响主功能
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'saveAuth': {
          await setStorage({
            [STORAGE_KEYS.token]: message.token,
            [STORAGE_KEYS.storeId]: message.storeId,
          });
          reloadOzonTabs();
          return { ok: true };
        }
        case 'logout': {
          await removeStorage([STORAGE_KEYS.token, STORAGE_KEYS.storeId]);
          reloadOzonTabs();
          // 扩展登出 → 同步登出已打开的 ERP 网页。await 确保 web 端 token 在本
          // handler 返回前已清,堵住"清扩展→web 端 syncAuthFromWeb 又把旧 token
          // 喂回来"的时间窗。
          await clearWebAuthTabs();
          return { ok: true };
        }
        case 'flashBadge': {
          // Flash the toolbar icon badge to draw user attention
          chrome.action.setBadgeText({ text: '!' });
          chrome.action.setBadgeBackgroundColor({ color: '#005bff' });
          setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
          return { ok: true };
        }
        case 'syncAuthFromWeb': {
          // Source-of-truth policy: popup is the primary login UI for the extension.
          //   - Web empty          → DO NOT clear extension (may just be an un-logged-in Web tab).
          //   - Extension empty    → adopt Web token (first-time login synced from Web).
          //   - Same token on both → allow storeId to update (user switched store on Web).
          //   - Different tokens   → IGNORE Web; extension wins. Prevents stale Web tokens
          //                          from clobbering a fresh popup login.
          if (!message.token) {
            return { ok: true };
          }
          if (!token) {
            await setStorage({
              [STORAGE_KEYS.token]: message.token,
              [STORAGE_KEYS.storeId]: message.storeId || storeId,
            });
            console.log('[ServiceWorker] Auth adopted from web frontend (extension was logged out)');
            reloadOzonTabs();
          } else if (message.token === token) {
            if (message.storeId && message.storeId !== storeId) {
              await setStorage({ [STORAGE_KEYS.storeId]: message.storeId });
              console.log('[ServiceWorker] Store switched from web frontend');
              reloadOzonTabs();
            }
          } else {
            console.log('[ServiceWorker] Ignoring web token — differs from extension token');
          }
          return { ok: true };
        }
        case 'tryWebSync': {
          // Popup requests: try to get token from any open erp-lite admin tab.
          // erp-lite admin 用 erp_admin_token 作为 localStorage key。
          try {
            const tabs = await chrome.tabs.query({
              url: [`*://${BRAND_WEB_HOST}/*`],
            });
            for (const tab of tabs) {
              if (tab.id) {
                const results = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: () => ({
                    token: localStorage.getItem('erp_admin_token') || localStorage.getItem('token'),
                    storeId: localStorage.getItem('currentOzonStoreId'),
                  }),
                });
                const result = results?.[0]?.result;
                if (result?.token) {
                  await setStorage({
                    [STORAGE_KEYS.token]: result.token,
                    [STORAGE_KEYS.storeId]: result.storeId || null,
                  });
                  return { ok: true, data: { synced: true, token: result.token, storeId: result.storeId } };
                }
              }
            }
          } catch (e) {
            console.warn('[ServiceWorker] tryWebSync failed:', e.message);
          }
          return { ok: true, data: { synced: false } };
        }
        case 'openFrontend': {
          // 迁移至 erp-backend-lite:Web 前端 = erp-lite /admin(hash 路由)。
          // 预注入 token 到 localStorage,避免 admin 登录视图闪屏。
          const path = typeof message.path === 'string' ? message.path : '';
          const hash = path.startsWith('#') ? path : ACTION_HASHES[path] || '';
          const url = `${backendUrl}/admin${hash}`;

          const tab = await chrome.tabs.create({ url, active: true });
          const tabId = tab?.id;

          if (tabId && token) {
            const inject = async () => {
              try {
                await chrome.scripting.executeScript({
                  target: { tabId },
                  func: (t, s) => {
                    try {
                      // erp-lite admin 用 erp_admin_token 作为 key
                      if (localStorage.getItem('erp_admin_token') !== t) {
                        localStorage.setItem('erp_admin_token', t);
                      }
                      if (s && localStorage.getItem('currentOzonStoreId') !== s) {
                        localStorage.setItem('currentOzonStoreId', s);
                      }
                    } catch {}
                  },
                  args: [token, storeId || null],
                });
              } catch (e) {
                console.warn('[openFrontend] inject failed:', e.message);
              }
            };

            let settled = false;
            const listener = (updatedId, info) => {
              if (updatedId !== tabId || settled) return;
              if (info.status === 'loading' || info.status === 'complete') {
                settled = true;
                chrome.tabs.onUpdated.removeListener(listener);
                inject();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            // Safety: remove listener after 10s even if status events never fire.
            setTimeout(() => {
              if (!settled) chrome.tabs.onUpdated.removeListener(listener);
            }, 10_000);
          }
          return { ok: true };
        }
        case 'openSellerPortal': {
          // 数据卡片「需登录卖家中心」提示按钮 → 复用已有 seller tab(避免重复开),
          // 没有就新开一个 active tab 让用户登录。content script 无 chrome.tabs,走 SW。
          try {
            const existing = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
            if (existing.length && existing[0].id) {
              await chrome.tabs.update(existing[0].id, { active: true });
              if (existing[0].windowId != null) {
                try {
                  await chrome.windows.update(existing[0].windowId, { focused: true });
                } catch {}
              }
              return { ok: true, data: { reused: true } };
            }
            await chrome.tabs.create({ url: 'https://seller.ozon.ru/app/products', active: true });
            return { ok: true, data: { reused: false } };
          } catch (e) {
            return { ok: false, error: e?.message || 'open seller portal failed' };
          }
        }
        case 'refreshBackend': {
          resolvedBackendUrl = null;
          cachedFeatureFlags = null;
          const url = await detectBackendUrl();
          return { ok: true, backendUrl: url };
        }
        case 'getErpBaseUrl': {
          // 迁移至 erp-backend-lite:供 popup/content 动态获取后端基址拼 /admin URL
          const baseUrl = await getBackendUrl();
          return { ok: true, baseUrl };
        }
        case 'getConfig': {
          // 从 erp-lite 配置中心拉取 extension + pricing 两个 scope 的配置合并返回
          try {
            const [extResp, priceResp] = await Promise.all([
              apiRequest('GET', `${backendUrl}/app-config?scope=extension`, null, token, storeId),
              apiRequest('GET', `${backendUrl}/app-config?scope=pricing`, null, token, storeId),
            ]);
            const extData = extResp?.data || extResp || {};
            const priceData = priceResp?.data || priceResp || {};
            return { ok: true, data: { ...extData, ...priceData } };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'erpApi': {
          // 通用 ERP 后端 API 代理(供 content script 调用后端接口)
          // message: { action:'erpApi', method:'GET'|'POST'|'PUT'|'DELETE', path:'/admin/api/...', body? }
          const { method = 'GET', path, body } = message;
          if (!path) return { ok: false, error: 'path required' };
          try {
            const data = await apiRequest(method, `${backendUrl}${path}`, body, token, storeId);
            return { ok: true, data };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        }
        case 'pushCollectBoxV2': {
          // 全数据源采集推送(PDP 一键采集重构):走新表 collect_box_v2,
          // 存带字段级 source 标记的 variants + rawBySource + synthesizedItems。
          // 与 pushSourceCollect(单条浅采集)并存:pushSourceCollect 走 /sources/:sourceId/collect
          // 写 v2(仅 raw),pushCollectBoxV2 走 /ozon/collect-box/v2 写 v2(全源 + synthesized)。
          const body = message.body || message;
          if (!body.anchorSku) return { ok: false, error: 'anchorSku required' };
          if (!Array.isArray(body.variants) || body.variants.length === 0) {
            return { ok: false, error: 'variants required' };
          }
          try {
            const data = await apiRequest(
              'POST',
              `${backendUrl}/ozon/collect-box/v2`,
              body,
              token,
              message.storeId || storeId
            );
            return { ok: true, data };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        }
        case 'pushSourceCollect': {
          // 单条采集推送:forward 到后端 POST /sources/:sourceId/collect,
          // 后端按 (store_id, sku) upsert 到 collect_box_v2。
          // 旧版的 24h dedupe / in-flight 合并 / 指数退避已移除(后端 upsert 幂等,
          // 重复推送只覆盖不报错)。content script 仍读 resp.dedupeHit,统一返 false。
          const sourceId = message.sourceId || 'ozon';
          const raw = message.raw;
          if (!raw) return { ok: false, error: 'raw required' };
          try {
            const result = await apiRequest(
              'POST',
              `${backendUrl}/sources/${encodeURIComponent(sourceId)}/collect`,
              { raw },
              token,
              message.storeId || storeId
            );
            return { ok: true, data: { dedupeHit: false, lastAt: Date.now(), result } };
          } catch (error) {
            return { ok: false, error: error.message };
          }
        }
        case 'collectorHeartbeat': {
          // content script → bg：上报当前 tab 的采集器状态
          const tabId = sender?.tab?.id;
          if (!tabId) return { ok: false, error: 'no tab id' };
          collectorTabs.set(tabId, {
            tabId,
            url: sender?.tab?.url || message.url || '',
            title: sender?.tab?.title || message.title || '',
            stats: message.stats || null,
            currentKeyword: message.currentKeyword || null,
            autoScrollerRunning: !!message.autoScrollerRunning,
            bucketCount: message.bucketCount ?? null,
            running: !!message.running,
            ts: Date.now(),
          });
          return { ok: true };
        }
        case 'collectorGetState': {
          // popup → bg：拉取所有活跃采集器 tab
          const now = Date.now();
          const tabs = [];
          for (const [tabId, state] of collectorTabs) {
            if (now - state.ts > COLLECTOR_STALE_MS) {
              collectorTabs.delete(tabId);
              continue;
            }
            tabs.push(state);
          }
          // 按最近活跃排序
          tabs.sort((a, b) => b.ts - a.ts);
          return { ok: true, data: { tabs } };
        }
        case 'browserAgentGetState': {
          // erp-lite 门控:proxy_collect 未启用时直接返回 unavailable
          const ffBa = await getFeatureFlagsCached();
          if (ffBa?.proxy_collect !== true || !globalThis.JzBrowserAgentRuntime) {
            return { ok: false, error: 'browser agent runtime unavailable' };
          }
          return {
            ok: true,
            data: await globalThis.JzBrowserAgentRuntime.getState(),
          };
        }
        case 'browserAgentCancelCurrent': {
          const ffBa2 = await getFeatureFlagsCached();
          if (ffBa2?.proxy_collect !== true || !globalThis.JzBrowserAgentRuntime) {
            return { ok: false, error: 'browser agent runtime unavailable' };
          }
          return await globalThis.JzBrowserAgentRuntime.requestCancel(message.jobId || null);
        }
        case 'addFavorite': {
          return {
            ok: true,
            data: await apiRequest('POST', `${backendUrl}/ozon/favorites`, message.product, token, storeId),
          };
        }
        case 'getProductStats': {
          let sku = message.sku;
          if (!sku && message.url) {
            const m = message.url.match(/\/product\/.*-(\d{5,})/);
            sku = m?.[1];
          }
          if (!sku) return { ok: true, data: null };
          // PDP 单卡会带 catIds(从面包屑 URL 抽的买家类目 id)→ 直连 GET 透传给后端,
          // 让佣金按类目 ID 精确分档解析(竞品无类目 id 时后端才退回俄文名兜底)。
          // 合批 body 只带 sku、且单卡无需合批,故带 catIds 时不进合批器;
          // 搜索页卡不带 catIds,照走合批(POST /product-data/batch)。
          const catIds = Array.isArray(message.catIds) ? message.catIds.filter((n) => Number.isFinite(n) && n > 0) : [];
          if (catIds.length) {
            try {
              const r = await apiRequest(
                'GET',
                `${backendUrl}/ozon/product-data/${sku}?skipMarket=1&catIds=${catIds.join(',')}`,
                null,
                token,
                storeId
              );
              return { ok: true, data: r?.data ?? null };
            } catch {
              return { ok: true, data: null };
            }
          }
          // 经合批器走 POST /ozon/product-data/batch(batch 端点恒不取 market data,
          // 语义同原 skipMarket=1 —— 扩展自己用 getMarketStats 经 seller tab 拿)。
          // 批量失败时合批器内部自动退回逐 SKU GET。
          return queueProductStats(String(sku), { backendUrl, token, storeId });
        }
        case 'getMarketStats': {
          // Call seller.ozon.ru internal API for market data (data/v3)
          // Must execute in seller.ozon.ru tab context (cookies + company ID)
          const mSku = message.sku;
          if (!mSku) return { ok: true, data: null };
          // what_to_sell period:'monthly'(月,默认)/ 'weekly'(周)。2026-06 月接口已恢复,
          // 默认回月;尊重调用方传入的 period(数据卡周期开关),非法值兜底 monthly。
          const mPeriod = message.period === 'weekly' ? 'weekly' : 'monthly';
          // 本机没登卖家端 → 透明回退:把取数派给同租户/池子里已登录 seller 的设备代采
          // (后端服务器 IP 直连 data/v3 会撞反爬 307 loop,只能借用户浏览器)。
          // noProxy 防递归 —— 代采执行方本身已登录,直接跑下面的本地路径。
          if (!message.noProxy) {
            const _scLocal = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
            if (!_scLocal[0]?.value) {
              const proxied = await proxyMarketData(backendUrl, token, storeId, mSku, mPeriod);
              if (proxied) return proxied; // 代采成功({ ok, data });失败则落到下面走「需登录」
            }
          }
          try {
            let sellerTabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
            // 没开任何 seller tab。选品库稀疏,多数商品市场数据仍依赖 seller tab 的 what_to_sell;
            // #82 后变体查询走 www 不再顺带开 seller tab → 这里在「已登录 seller」时自己开一个
            // (ensureSellerTab 内含 single-flight,列表页多卡并发只开一个)。未登录则不开无用
            // signin tab,直接走下面的「需登录」提示。
            if (!sellerTabs.length) {
              const _sc = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
              if (_sc[0]?.value) {
                try {
                  await ensureSellerTab();
                } catch (e) {
                  console.log('[getMarketStats] ensureSellerTab 失败:', e?.message || e);
                }
                sellerTabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
              }
            }
            // 仍没有(未登录 / 开 tab 失败)→ 会话信号(不是"该 SKU 无数据")。卡片据此显示
            // 「需登录卖家中心」提示,而非静默"-"。__needSellerLogin 放 data 里 ——
            // sendMessage wrapper 只透传 response.data,放顶层会被吞(envelope 坑)。
            if (!sellerTabs.length) {
              return { ok: true, data: { __needSellerLogin: true, __reason: 'NO_SELLER_TAB' } };
            }

            // 2026-05-30 修:不靠 URL 猜哪个 tab 登录了 —— 用户常同时开多个 seller tab,
            // 其中可能混着 /app/registration/signin(未登录/会话过期被重定向)。旧逻辑
            // `find(url.includes('/app/'))` 会选中 signin 页(它也含 /app/),注入后拿不到
            // sc_company_id → 永远返 null → market 字段全空。
            //
            // 新逻辑:遍历所有 seller tab 逐个注入,注入函数自己判 cookie + fetch,
            // 第一个真拿到 sc_company_id 且 data/v3 成功的就用。URL 会骗人(过期态也可能
            // 停在 /app/products),cookie + fetch 成功才是硬证据。
            //
            // 注入函数返回三态:
            //   { ok: true,  data }  — 成功(可能 data=null,即该 SKU 无市场数据但登录正常)
            //   { ok: false, reason: 'no_company_id' } — 这个 tab 没登录,试下一个
            //   { ok: false, reason: 'http_<status>' } — fetch 被拒(限流/权限),试下一个
            // 排序:把含 signin/registration/auth/login 的 tab 排到最后,优先试业务页,
            // 减少无谓注入(纯优化,不影响正确性 —— 反正都会遍历到能用的那个)。
            const isAuthUrl = (u) => /\/(registration|signin|auth|login)/i.test(u || '');
            const orderedTabs = [...sellerTabs].sort((a, b) => (isAuthUrl(a.url) ? 1 : 0) - (isAuthUrl(b.url) ? 1 : 0));

            const injectFetch = async (sku, period) => {
              try {
                const cookies = document.cookie.split(';').map((c) => c.trim());
                const scCookie = cookies.find((c) => c.startsWith('sc_company_id='));
                const companyId = scCookie ? scCookie.split('=')[1] : '';
                if (!companyId) return { ok: false, reason: 'no_company_id' };
                const resp = await fetch('/api/site/seller-analytics/what_to_sell/data/v3', {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    'x-o3-app-name': 'seller-ui',
                    'x-o3-company-id': companyId,
                    'x-o3-language': 'zh-Hans',
                  },
                  body: JSON.stringify({
                    filter: { stock: 'any_stock', period: period || 'monthly', sku: String(sku) },
                    sort: { key: 'sum_gmv_desc' },
                    limit: '1',
                    offset: '0',
                  }),
                });
                if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
                const result = await resp.json();
                // items 是历史 key;data/v3 偶以 data 返回(后端 ozon-market-data 同样 items??data 兜底)。
                // 字段大小写归一在 SW 侧做(此函数注入页面上下文,够不到 SW 的 normalizeMarketItem)。
                return { ok: true, data: result?.items?.[0] || result?.data?.[0] || null };
              } catch (e) {
                return { ok: false, reason: `exc_${(e && e.message) || 'unknown'}` };
              }
            };

            const reasons = [];
            for (const tab of orderedTabs) {
              if (!tab.id) continue;
              let injected;
              try {
                // 销量列会并发多个 getMarketStats,这条注入 fetch 直打 what_to_sell/data/v3,
                // 不经 fetchSellerPortal → 必须显式过全局节奏闸门,否则绕过 P2-1 的限流摊平。
                await _sellerPortalGate();
                injected = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: injectFetch,
                  args: [mSku, mPeriod],
                });
              } catch (e) {
                // 个别 tab 注入失败(页面 crash / 权限)不致命,继续试下一个
                reasons.push(`tab${tab.id}:inject_err`);
                continue;
              }
              const r = injected?.[0]?.result;
              if (r?.ok) {
                // 找到能用的 tab —— 成功(data 可能 null,表示该 SKU 无市场数据但登录正常)。
                // normalizeMarketItem:把 data/v3 item 归一成下游固定读的 camelCase,
                // 防 Ozon 改大小写导致月销量等市场字段全空却无报错(见 normalizeMarketItem 注释)。
                return { ok: true, data: r.data ? normalizeMarketItem(r.data) : null };
              }
              reasons.push(`tab${tab.id}:${r?.reason || 'no_result'}`);
            }

            // 所有 seller tab 都拿不到。区分两种:
            //   - 全部 no_company_id → 会话过期/未登录 → __needSellerLogin 让卡片提示去登录
            //   - 其余(http_401/AUTH_REDIRECT 也算会话;http_403/限流/网络等 → 仍静默 null)
            // 401/signin 重定向都归为"需登录";其它(权限/限流/网络抖动)不强提示,
            // 避免把临时性 fetch 失败误报成"需登录"骚扰用户。
            console.log('[getMarketStats] no usable seller tab:', reasons.join(', '));
            const sessionLike = reasons.every((r) => /no_company_id|http_401|signin|login|redirect/i.test(r));
            if (sessionLike) {
              return { ok: true, data: { __needSellerLogin: true, __reason: 'AUTH_REQUIRED' } };
            }
            return { ok: true, data: null };
          } catch (e) {
            console.log('[getMarketStats] failed:', e.message);
            return { ok: true, data: null };
          }
        }
        case 'getMembershipSummary': {
          try {
            const summary = await apiRequest('GET', `${backendUrl}/membership/usage-summary`, null, token, storeId);
            return { ok: true, data: summary };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        }
        case 'getAiQuota': {
          // AI 改图：按极点余额 / 单价 计算可用张数，但受会员等级限制（免费版 24h 试用）
          // AI 重写：会员无限使用（会员才能用）
          // 单价从 /jidian/pricing 拉取，超管可在后台调整；拉不到 fallback 到 50
          try {
            const [balanceRes, membershipRes, summaryRes, pricingRes] = await Promise.all([
              apiRequest('GET', `${backendUrl}/jidian/balance`, null, token, storeId).catch(() => ({ balance: 0 })),
              apiRequest('GET', `${backendUrl}/membership/me`, null, token, storeId).catch(() => null),
              apiRequest('GET', `${backendUrl}/membership/usage-summary`, null, token, storeId).catch(() => null),
              apiRequest('GET', `${backendUrl}/jidian/pricing`, null, token, storeId).catch(() => null),
            ]);
            const balance = balanceRes?.balance ?? 0;
            const PRICE_IMAGE =
              typeof pricingRes?.AI_IMAGE === 'number' && pricingRes.AI_IMAGE > 0 ? pricingRes.AI_IMAGE : 50;
            const pointAliasRaw = pricingRes?._meta?.pointAlias;
            const pointLabel =
              typeof pointAliasRaw === 'string' && pointAliasRaw.trim() ? pointAliasRaw.trim() : '极点';
            // 用 tier 判会员,不用 level。V1.1 新模板(Mini/Pro/Max)plan.level=null,
            // /membership/me 把它兜底成 "free",旧的 `level !== 'free'` 会把这三档付费会员
            // 误判为非会员致 AI 重写被禁用。tier 永远返回真实档位(兜底 FREE)。
            const tier = String(membershipRes?.tier || '').toUpperCase();
            const hasActiveMembership = !!membershipRes && tier && tier !== 'FREE' && (membershipRes.daysLeft ?? 0) > 0;
            const aiEditEnabled = summaryRes?.canUse?.AI_EDIT !== false;
            const aiEditTrialExpired = summaryRes?.usage?.aiEditTrialExpired === true;
            return {
              ok: true,
              data: {
                balance,
                pointLabel,
                aiImage: {
                  used: 0,
                  limit: balance,
                  remaining: Math.floor(balance / PRICE_IMAGE),
                  price: PRICE_IMAGE,
                  canUse: aiEditEnabled,
                  trialExpired: aiEditTrialExpired,
                },
                aiRewrite: {
                  hasActiveMembership,
                  planName: membershipRes?.planName,
                },
              },
            };
          } catch (e) {
            console.warn('[getAiQuota] failed:', e.message);
            return { ok: false, error: e.message };
          }
        }
        case 'followSell': {
          const targetStoreId = message.storeId || storeId;
          // 门户上架(灰度):message.viaPortal=true 时不走官方 API,改走 seller.ozon.ru
          // bundle 接口创建商品(绕官方 import 限流/封控)。后端只备 bundle items,
          // create/update/upload 三步在浏览器里跑。preferTabId 用发起页(www.ozon.ru)
          // 标签,走 fetchSellerPortal 的跨域快路免依赖 seller 专用标签。
          if (message.viaPortal) {
            console.log(
              `[followSell] viaPortal: items=${message.items?.length}, url=${backendUrl}/ozon/products/prepare-bundle-items`
            );
            const portalResult = await importViaPortal(message, token, targetStoreId, backendUrl, sender?.tab?.id);
            console.log('[followSell] portal response:', JSON.stringify(portalResult).slice(0, 200));
            return { ok: true, data: portalResult };
          }
          const bodySize = JSON.stringify(message).length;
          // Backend now enqueues and returns within ~1s; AI/watermark run in the worker.
          const importTimeout = 120_000;
          console.log(
            `[followSell] Enqueueing import: items=${message.items?.length}, bodySize=${bodySize}, aiImage=${message.applyAiImage}, watermark=${message.applyWatermark}, url=${backendUrl}/ozon/products/import`
          );
          const followSellResult = await apiRequest(
            'POST',
            `${backendUrl}/ozon/products/import`,
            message,
            token,
            targetStoreId,
            importTimeout
          );
          console.log('[followSell] Enqueue response:', JSON.stringify(followSellResult).slice(0, 200));
          return { ok: true, data: followSellResult };
        }
        case 'portalImportStatus': {
          // 门户上架进度查询:用 async-upload task get-list 找到 upload_task_id 的
          // processed/failed/warned,failed>0 再拉 get-errors 拿逐 SKU 原因。
          // 形状供 content 端跟卖面板「成功 N/失败 N」回显。
          try {
            const taskId = message.taskId;
            if (!taskId) return { ok: false, error: '缺少 taskId' };
            const companyId = message.companyId || (await resolveSellerCompanyId());
            const preferTabId = sender?.tab?.id;
            const list = await getUploadTaskList(companyId, { limit: 30, page: 1 }, preferTabId);
            const task = (list?.tasks || []).find((t) => String(t.id) === String(taskId)) || null;
            let errors = [];
            const failed = Number(task?.failed || 0);
            if (task && failed > 0) {
              try {
                const errResp = await getUploadTaskErrors(companyId, taskId, { page: 1, page_size: 50 }, preferTabId);
                errors = (errResp?.task_item_errors || []).map((e) => ({
                  offer_id: e.offer_id,
                  errors: (e.errors || []).map((x) => ({
                    code: x.code,
                    field: x.field,
                    level: x.level,
                    message: (x.texts && x.texts.description) || x.code,
                  })),
                }));
              } catch (e) {
                console.warn('[portalImportStatus] get-errors 失败:', e?.message || e);
              }
            }
            const size = Number(task?.size || 0);
            const processed = Number(task?.processed || 0);
            const warned = Number(task?.warned || 0);
            // 任务处理完毕:processed 覆盖全部 size(failed 计入 processed)
            const done = !!task && size > 0 && processed >= size;
            return {
              ok: true,
              data: {
                taskId: String(taskId),
                found: !!task,
                status: task?.status || null,
                size,
                processed,
                failed,
                warned,
                done,
                errors,
              },
            };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'listFollowSellTasks': {
          const listStoreId = message.storeId || storeId;
          const current = Math.max(1, parseInt(message.current || 1, 10) || 1);
          const pageSize = Math.max(1, Math.min(50, parseInt(message.pageSize || 10, 10) || 10));
          return {
            ok: true,
            data: await apiRequest(
              'GET',
              `${backendUrl}/ozon/products/import-by-sku/tasks?current=${current}&pageSize=${pageSize}`,
              null,
              token,
              listStoreId
            ),
          };
        }
        case 'importBySku': {
          // items: [{ sku, offer_id, price, vat, currency_code }]
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/ozon/products/import-by-sku`,
              { items: message.items },
              token,
              storeId
            ),
          };
        }
        case 'getWarehouses': {
          // backend `/ozon/warehouses` 已统一做 shape 归一化 + cache fallback
          // (warehouses.service.ts),SW 这里只透传即可。
          const whStoreId = message.storeId || storeId;
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/ozon/warehouses`, null, token, whStoreId) };
        }
        case 'getCategoryTree': {
          const lang = message.language || 'DEFAULT';
          return {
            ok: true,
            data: await apiRequest('GET', `${backendUrl}/ozon/categories/tree?language=${lang}`, null, token, storeId),
          };
        }
        case 'getCategoryAttributes': {
          // 拉某 type(叶子类目)的属性 schema(含 is_required/dictionary_id)。
          // 只要 typeId,后端内部反查 description_category_id。
          const catStoreId = message.storeId || storeId;
          const tid = encodeURIComponent(message.typeId);
          return {
            ok: true,
            data: await apiRequest(
              'GET',
              `${backendUrl}/ozon/description-category/${tid}/attributes`,
              null,
              token,
              catStoreId
            ),
          };
        }
        case 'aiOptimizeForRating': {
          // AI 满分体检/属性填充。1688 向导用 modules:["attrs"](或含 title/description)
          // + currentAttrs:[] 让 AI 填必填属性。后端跑 LLM 候选 + 字典匹配。
          const aiStoreId = message.storeId || storeId;
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/ozon/ai/optimize-for-rating`,
              message.body || {},
              token,
              aiStoreId,
              120_000
            ),
          };
        }
        case 'suggestCategory': {
          // AI 类目建议：把 1688 标题+属性交给 LLM，输出末级类目中文名（向导本地 fuzzyMatch 落叶子）。
          const aiStoreId = message.storeId || storeId;
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/ozon/ai/suggest-category`,
              message.body || {},
              token,
              aiStoreId,
              60_000
            ),
          };
        }
        case 'verifyCategory': {
          // 叶子复核：descent 选到叶子后,让 LLM 确认是否真适合该商品;不适合返回正确一级大类(向导据此重下钻)。
          const aiStoreId = message.storeId || storeId;
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/ozon/ai/verify-category`,
              message.body || {},
              token,
              aiStoreId,
              60_000
            ),
          };
        }
        case 'importStock': {
          // stocks: [{ offer_id, stock, warehouse_id }]
          const stockStoreId = message.storeId || storeId;
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/ozon/stocks/import`,
              { items: message.stocks },
              token,
              stockStoreId
            ),
          };
        }
        case 'getImportStatus': {
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/ozon/products/import/status`,
              { task_id: message.taskId },
              token,
              storeId
            ),
          };
        }
        case 'getFxRate': {
          // CNY→RUB 实时汇率（复用「极掌算价」的 FX 缓存 jz_calc_fx_rate_v1）。
          // 给 1688 AI 采集向导按店铺货币定价用：成本是人民币，需换算成店铺货币。
          // 缓存缺失/过期则即时刷新一次。
          try {
            const cached = await new Promise((r) =>
              chrome.storage.local.get([FX_STORAGE_KEY], (d) => r(d?.[FX_STORAGE_KEY]))
            );
            let rate = cached?.rate;
            const stale = !cached || Date.now() - (cached.ts || 0) > FX_REFRESH_INTERVAL_MINUTES * 60 * 1000;
            if (!rate || stale) {
              const fresh = await refreshExchangeRate();
              if (fresh) rate = fresh;
            }
            return rate
              ? { ok: true, data: { rate, base: 'CNY', quote: 'RUB' } }
              : { ok: false, error: '汇率获取失败' };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'getFeatureFlags': {
          // 当前用户的灰度开关 map { flagKey: bool }。面板/向导按 flag 决定是否显示新功能。
          const ffStoreId = message.storeId || storeId;
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/feature-flags/me`, null, token, ffStoreId) };
        }
        case 'searchProductBySku': {
          // /api/v1/search 是 seller portal 跟卖列表（products/copy/list）用的接口
          // 按 SKU 精确定位 Ozon 全平台商品，返回精准 description_category_id + attributes
          // search-variant-model 只搜自家目录无果时（跟卖陌生 SKU），降级到这个
          // 注意：body 必须带 company_id，否则返 403 PermissionDenied
          const sku = message.sku;
          const senderTabId = sender?.tab?.id || null; // 优先在来源 ozon 标签内跨域直发,免依赖 seller 专用标签
          try {
            const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
            const companyId = scCookies[0]?.value || '';
            if (!companyId) {
              return {
                ok: false,
                error: 'NO_COMPANY_ID',
                message: 'sc_company_id cookie 未找到，请先登录 seller.ozon.ru',
              };
            }
            const resp = await fetchSellerPortal(
              '/search',
              {
                company_id: companyId,
                need_total: true,
                filter: {
                  children_nodes: {
                    children_nodes: [{ input_leaf: { sku: { values: [String(sku)] } } }],
                    operator: 'AND',
                  },
                },
                pagination: { limit: '50' },
                is_copy_allowed: false,
              },
              {
                urlPrefix: '/api/v1',
                pageType: 'products',
                timeoutMs: 30000,
                allowOzonTab: true,
                preferTabId: senderTabId,
              }
            );
            // /api/v1/search 返回字段是 `variants`，且 shape 跟 sv 不同
            // 必须 normalize 成 sv 兼容（含 attributes 数组）才能让下游 distillSource / resolveViaSearchVariantModel 直接用
            const rawVariants = Array.isArray(resp?.variants)
              ? resp.variants
              : Array.isArray(resp?.items)
                ? resp.items
                : Array.isArray(resp?.products)
                  ? resp.products
                  : Array.isArray(resp)
                    ? resp
                    : [];
            const items = rawVariants.map(normalizeSearchVariantToSv);
            console.log(
              `[searchProductBySku] sku=${sku} normalized ${items.length} variants, first.attrs=${items[0]?.attributes?.length || 0}, desc_cat=${items[0]?.description_category_id}`
            );
            if (items.length === 0) {
              console.log(`[searchProductBySku] raw resp:`, JSON.stringify(resp).slice(0, 600));
            }
            return { ok: true, data: { items } };
          } catch (e) {
            console.warn(`[searchProductBySku] failed:`, e.message || e);
            return { ok: false, error: 'SEARCH_FAILED', message: e.message || String(e) };
          }
        }
        case 'uploadFollowSellVideo': {
          // 把竞品 PDP 的 .mp4 转存成「卖家自有」的 Ozon 视频(ir.ozone.ru/s3)。这是唯一能让
          // Ozon 接受跟卖视频的途径 —— 主视频/封面槽只认平台链接或卖家自有 Ozon 视频,不吃任意直链。
          // 失败返回 ok:false,上游降级为不带视频、不阻断上架。调用方已有 .mp4 直链(PDP gallery)。
          try {
            const r = await transferVideoToOzon(message.srcUrl);
            if (!r.ok) return { ok: false, error: r.error, message: r.message };
            // 注意:window.sendMessage 成功时 resolve 的是 response.data,故 url 必须放进 data。
            return { ok: true, data: { url: r.url } };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'transferVariantVideo': {
          // batch-upload 逐 SKU 用:给商品 url/path,借买家 tab 抓 PDP gallery 的 .mp4,再转存成
          // 卖家自有 Ozon 视频。无视频 / 抓取失败 / 转存失败 → ok:true + url:null(best-effort,不阻断上架)。
          // 同一次 page json 顺带抽到的源富内容(11254)+ 描述(4191)+ 主题标签(23171)一并透传 ——
          // 视频开关开着时这三样零增量请求(sku-collect 据此注入 distilled / _sourceVariant)。
          try {
            const media = await fetchVariantMediaViaBuyerTab(message.url);
            const richContent = media.richContent || '';
            const description = media.description || '';
            const hashtags = Array.isArray(media.hashtags) ? media.hashtags : [];
            if (!media.mp4) return { ok: true, data: { url: null, richContent, description, hashtags } };
            const r = await transferVideoToOzon(media.mp4);
            return { ok: true, data: { url: r.ok ? r.url : null, richContent, description, hashtags } };
          } catch (e) {
            return { ok: true, data: { url: null, richContent: '', description: '', hashtags: [] } };
          }
        }
        case 'fetchVariantRichContent': {
          // batch-upload 逐 SKU 用(视频转存关闭时的源内容独立通道):借买家 tab 拉 PDP page
          // json,抽源富内容(11254)+ 描述(4191)+ 主题标签(23171),纯读不写(无 upload-file 门户请求)。
          // 抓不到 / 失败 → ok:true + 空值(best-effort,不阻断上架)。
          try {
            const media = await fetchVariantMediaViaBuyerTab(message.url);
            return {
              ok: true,
              data: {
                richContent: media.richContent || '',
                description: media.description || '',
                hashtags: Array.isArray(media.hashtags) ? media.hashtags : [],
              },
            };
          } catch (e) {
            return { ok: true, data: { richContent: '', description: '', hashtags: [] } };
          }
        }
        case 'searchVariants': {
          const sku = message.sku;
          const forceRefresh = Boolean(message.forceRefresh);
          // 跟卖时用户本就在 www 商品页 → 用来源标签走跨域快路,免依赖 seller 专用标签
          const senderTabId = sender?.tab?.id || null;
          // 2026-05 Ozon 把 /api/v1/search-variant-model endpoint 下线(实测所有
          // SKU/参数都返 404 ResourceNotFound)。新流程是 /api/v1/search 拿元数据
          // + /api/site/seller-prototype/create-bundle-by-variant-id 补完整 attributes:
          //
          // Step 1: /api/v1/search filter sku.values 拿 variants[0].variant_id
          //         (URL 数字 SKU 与 variant_id 不同 namespace,必须先转换)
          // Step 2: /api/site/seller-prototype/create-bundle-by-variant-id 拿 item
          //         含 weight/depth/width/height(物理) + barcode + 40-63 个 attributes
          // Step 3: 把 item.weight/depth/width/height 以 sv attr key 形式
          //         (4497/9454/9455/9456)push 进 items[0].attributes,
          //         让下游 distillSource / resolveViaSearchVariantModel /
          //         jzMergeCardPanelData 等所有 caller 无感升级 — 它们的代码不动
          //
          // 副作用:bundle endpoint 每次创建 draft bundle_id。fetchBundleByVariantId
          // 内部用 chrome.storage.local 24h cache(下调自 30d,牺牲少量 draft 增长换取
          // 源商品改类目/属性时及时刷新);传 message.forceRefresh=true 可绕过 cache 立即重拉。
          //
          // NOT_IN_OWN_CATALOG label 保留以兼容 caller 的 errorCode 检查,语义
          // 现在变成 SKU_NOT_FOUND_ON_PLATFORM(/search 对找不到的 SKU 通常返 200
          // + 空 variants,而不是 404,所以这分支实际很少触发)。
          const classifyError = (e) => {
            const msg = e.message || String(e);
            const status = typeof e.status === 'number' ? e.status : null;
            const code = typeof e.code === 'string' ? e.code : null;
            let errorCode = 'UNKNOWN_ERROR';
            if (status === 404 && code === 'ResourceNotFound') {
              errorCode = 'NOT_IN_OWN_CATALOG';
            } else if (msg.includes('请先打开') || msg.includes('No seller tab')) {
              errorCode = 'NO_SELLER_TAB';
            } else if (msg.includes('Cannot access contents') || msg.includes('permission to access')) {
              errorCode = 'PERMISSION_DENIED';
            } else if (
              status === 401 ||
              code === 'AUTH_REDIRECT' ||
              msg.includes('sc_company_id') ||
              msg.includes('过期') ||
              msg.includes('登录') ||
              msg.includes('signin') ||
              msg.includes('login')
            ) {
              errorCode = 'AUTH_REQUIRED';
            } else if (status === 403 || msg.includes('403')) {
              // 403 细分:Ozon 反爬挑战是 HTML 页;而 company_id 失效 / 会话过期 / 账号无权限的
              // PermissionDenied 是结构化 JSON。早期一律当反爬 → 误冷却 10min + 误导用户"换网络"
              // (实际该重登 / 重选店)。按 body 形状分流:仅当明确是结构化 JSON 权限/会话错时改判
              // AUTH_REQUIRED;HTML 挑战页 / 裸 403 无线索仍按反爬(保留熔断保护,宁可多冷却不要猛打)。
              const blob = `${code || ''} ${msg}`.toLowerCase();
              const looksHtmlChallenge =
                /<html|<!doctype|just a moment|attention required|enable javascript|are you a robot|вы не робот|captcha|challenge|too many requests/.test(
                  blob
                );
              const looksStructuredApiError =
                /"code"|"message"|permission_?denied|company_?id|sc_company|unauthenticated|invalid.?token|session/.test(
                  blob
                );
              errorCode = looksStructuredApiError && !looksHtmlChallenge ? 'AUTH_REQUIRED' : 'ANTIBOT_BLOCKED';
            } else if (
              msg.includes('超时') ||
              msg.includes('timeout') ||
              msg.includes('AbortError') ||
              msg.includes('Timeout')
            ) {
              errorCode = 'TIMEOUT';
            } else if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('network')) {
              errorCode = 'NETWORK_ERROR';
            }
            return { errorCode, msg };
          };

          // /search 必须 body 带 company_id(否则 403 PermissionDenied)
          const scCookies = await chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' });
          const companyId = scCookies[0]?.value || '';
          if (!companyId) {
            // 本机没登卖家端 → 透明回退:派给同租户已登录设备代采。message.noProxy
            // 由代采执行端(agent action)设置,杜绝"代采里再触发代采"的递归。
            if (!message.noProxy) {
              const proxied = await proxyCollectVariant(backendUrl, token, storeId, sku);
              if (proxied) return proxied;
            }
            return {
              ok: false,
              error: 'AUTH_REQUIRED',
              message: 'sc_company_id cookie 未找到，请先登录 seller.ozon.ru',
            };
          }

          const MAX_RETRIES = 2;
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const resp = await fetchSellerPortal(
                '/search',
                {
                  company_id: companyId,
                  need_total: true,
                  filter: {
                    children_nodes: {
                      children_nodes: [{ input_leaf: { sku: { values: [String(sku)] } } }],
                      operator: 'AND',
                    },
                  },
                  pagination: { limit: '50' },
                  is_copy_allowed: false,
                },
                {
                  urlPrefix: '/api/v1',
                  pageType: 'products',
                  timeoutMs: 30000,
                  allowOzonTab: true,
                  preferTabId: senderTabId,
                }
              );
              console.log(`[searchVariants] fetch search sku=${sku}`);
              const rawVariants = Array.isArray(resp?.variants)
                ? resp.variants
                : Array.isArray(resp?.items)
                  ? resp.items
                  : Array.isArray(resp?.products)
                    ? resp.products
                    : Array.isArray(resp)
                      ? resp
                      : [];
              const items = rawVariants.map(normalizeSearchVariantToSv).filter(Boolean);
              if (items.length === 0) {
                if (attempt === 1) {
                  console.log(
                    `[searchVariants] sku=${sku} no variants from /search, raw:`,
                    JSON.stringify(resp).slice(0, 400)
                  );
                }
                return { ok: true, data: { items: [] } };
              }

              // Step 2: bundle 补完整 attributes(物理 + 含 40-63 个完整 attr)
              // 失败不致命 — items 已有基础元数据(品牌/类目/GTIN/图片),caller 仍可用,
              // 只是 4497/9454-9456 物理 attr 缺失 → 数据卡片重量·尺寸退化为公开兜底。
              try {
                const variantId = items[0].variant_id;
                if (variantId) {
                  const bundleItem = await fetchBundleByVariantId(sku, variantId, companyId, {
                    forceRefresh,
                    preferTabId: senderTabId,
                  });
                  if (bundleItem) {
                    const existingKeys = new Set(items[0].attributes.map((a) => String(a.key)));
                    const physicalAttrs = [];
                    if (Number(bundleItem.weight) > 0 && !existingKeys.has('4497')) {
                      physicalAttrs.push({ key: '4497', value: String(bundleItem.weight) });
                    }
                    if (Number(bundleItem.depth) > 0 && !existingKeys.has('9454')) {
                      physicalAttrs.push({ key: '9454', value: String(bundleItem.depth) });
                    }
                    if (Number(bundleItem.width) > 0 && !existingKeys.has('9455')) {
                      physicalAttrs.push({ key: '9455', value: String(bundleItem.width) });
                    }
                    if (Number(bundleItem.height) > 0 && !existingKeys.has('9456')) {
                      physicalAttrs.push({ key: '9456', value: String(bundleItem.height) });
                    }
                    if (bundleItem.barcode && !existingKeys.has('7822')) {
                      physicalAttrs.push({ key: '7822', value: String(bundleItem.barcode) });
                    }
                    // bundle.attributes shape: { attribute_id, values:[{value, dictionary_value_id}], complex_id }
                    // 简单 attr(complex_id=0)转成 sv 兼容 { key, value | collection } 让 backend
                    // resolveViaSearchVariantModel 的 sourceAttrMap 能 hit 到类目业务 attr(刷子类型/季卡/材质/...)。
                    // complex attr(complex_id>0,即视频/PDF)单独收集成 _bundleComplexAttrs,follow-sell
                    // 据此重建 import 的 complex_attributes(带上原 SKU 视频)。bundle 是 Ozon 自家"复制商品"
                    // API,返回的视频 URL 本就给 import 重新消费用,不是页面播放器的 m3u8 临时签名地址。
                    const bundleComplexAttrs = [];
                    if (Array.isArray(bundleItem.attributes)) {
                      for (const ba of bundleItem.attributes) {
                        if (ba.complex_id && String(ba.complex_id) !== '0') {
                          bundleComplexAttrs.push(ba);
                          continue;
                        }
                        const key = String(ba.attribute_id || '');
                        if (!key || existingKeys.has(key)) continue;
                        const vals = Array.isArray(ba.values)
                          ? ba.values.filter((v) => v && v.value != null && v.value !== '')
                          : [];
                        if (vals.length === 0) continue;
                        if (vals.length > 1) {
                          physicalAttrs.push({ key, collection: vals.map((v) => String(v.value)) });
                        } else {
                          physicalAttrs.push({ key, value: String(vals[0].value) });
                        }
                        existingKeys.add(key);
                      }
                    }
                    if (physicalAttrs.length > 0) {
                      items[0] = { ...items[0], attributes: [...items[0].attributes, ...physicalAttrs] };
                    }
                    if (bundleComplexAttrs.length > 0) {
                      items[0]._bundleComplexAttrs = bundleComplexAttrs;
                      console.log(
                        `[searchVariants] bundle complex attrs (视频/PDF): ${bundleComplexAttrs.length} for sku=${sku}`
                      );
                    }
                    // 完整 bundle item 也挂上(供高级 caller — 如 follow-sell 拿全 40-63 个 attr)
                    items[0]._bundleItem = bundleItem;

                    // 用 bundleItem.description_category_id 查 seller-tree 反查叶子类目名,
                    // 作为 description_category_lvl3_name 的权威来源。
                    // ⚠️ 不能用 attribute 8229 的 value —— 那是 descriptionTypeName(类型名,如"Дартс детский"),
                    // 而 create-bundle 的 description_category_lvl3_name 期望叶子类目名
                    // (如"Набор для подвижных игр" = 户外游戏套装)。传错会导致 Ozon 报
                    // "您没有指定类型。属性是必填项"。
                    const catId = Number(bundleItem.description_category_id);
                    if (catId > 0) {
                      try {
                        const tree = await fetchSellerTree(companyId, { preferTabId: senderTabId });
                        const leafName = findCatNameInTree(tree, catId);
                        if (leafName) {
                          items[0].description_category_lvl3_name = leafName;
                          console.log(`[searchVariants] catId=${catId} → leafName="${leafName}" for sku=${sku}`);
                        } else {
                          console.warn(`[searchVariants] catId=${catId} not found in seller-tree for sku=${sku}`);
                        }
                      } catch (e) {
                        console.warn(`[searchVariants] seller-tree lookup failed for sku=${sku}:`, e.message || e);
                      }
                    }
                  }
                }
              } catch (e) {
                console.warn(`[searchVariants] bundle injection failed for sku=${sku}:`, e.message || e);
              }

              return { ok: true, data: { items } };
            } catch (e) {
              const { errorCode, msg } = classifyError(e);
              // 业务空结果(罕见 — /search 通常返 200 + 空 variants):立即降级
              if (errorCode === 'NOT_IN_OWN_CATALOG') {
                console.log(`[searchVariants] sku=${sku} not found on platform (404) — returning empty items`);
                return { ok: true, data: { items: [] } };
              }
              console.warn(`[searchVariants] attempt ${attempt}/${MAX_RETRIES} failed [${errorCode}]:`, msg, e);
              const isRetryable = ['TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_ERROR'].includes(errorCode);
              if (attempt >= MAX_RETRIES || !isRetryable) {
                return { ok: false, error: errorCode, message: msg };
              }
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        }
        case 'fetchBestsellers': {
          // 拉 Ozon 官方 Bestsellers (what_to_sell/data/v3) 并转交给后端入库
          const period = message.period || 'weekly'; // weekly | monthly
          const sortKey = message.sortKey || 'sum_gmv_desc';
          const limit = String(message.limit || 50);
          const offset = String(message.offset || 0);
          const categories = Array.isArray(message.categories) ? message.categories : [];
          try {
            const data = await fetchSellerPortal(
              '/site/seller-analytics/what_to_sell/data/v3',
              {
                limit,
                offset,
                filter: { stock: 'any_stock', period, categories },
                sort: { key: sortKey },
              },
              { urlPrefix: '/api', pageType: 'analytics_platform', timeoutMs: 30000 }
            );
            const items = Array.isArray(data?.items) ? data.items : [];
            // 同步到后端按日存档（前端日常查后端快照）
            // erp-lite 门控:bestsellers_snapshot 默认 false,未启用时跳过后端存档
            const ffBs = await getFeatureFlagsCached();
            if (items.length > 0 && token && storeId && ffBs?.bestsellers_snapshot === true) {
              try {
                await apiRequest(
                  'POST',
                  `${backendUrl}/ozon/selection/bestsellers/snapshot`,
                  { period, items },
                  token,
                  storeId
                );
              } catch (e) {
                console.warn('[fetchBestsellers] backend ingest failed:', e?.message || e);
              }
            }
            return {
              ok: true,
              data: {
                items,
                totals: data?.totals,
                updateDate: data?.updateDate,
                benchmark: data?.benchmark,
              },
            };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'fetchOzonPublicProduct': {
          // 按 SKU 抓 ozon.ru 公开商品页，提炼 pageProduct（name/images/breadcrumbs/brand/weight/dims）。
          // Ozon 反爬会 ban 掉 service-worker 直 fetch（缺浏览器指纹），所以**优先**
          // 在 www.ozon.ru tab 内 executeScript 注入 fetch（同 fetchSellerPortal 套路），
          // 找不到 tab 才 fall back 到 service-worker 直 fetch（大概率被反爬拦）。
          try {
            const sku = String(message.sku || '').trim();
            if (!/^\d{6,16}$/.test(sku)) return { ok: false, error: 'invalid sku' };

            // 在页面上下文跑的 fetch + 解析（大字符串注入 executeScript），返回标准化数据
            // URL 用相对路径,自动适配当前 tab 是 www.ozon.ru 还是 ozon.kz (同 origin)。
            const inPageFetcher = async (sku) => {
              const path = `/product/${sku}`;
              const endpoints = [
                `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
                `/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(path)}`,
              ];
              const upgrade = (u) =>
                typeof u === 'string' && u.includes('ir.ozone.ru') ? u.replace(/\/wc\d+\//, '/wc1000/') : u;
              for (const url of endpoints) {
                try {
                  const resp = await fetch(url, {
                    credentials: 'include',
                    headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
                  });
                  if (!resp.ok) continue;
                  const data = await resp.json();
                  const states = data && data.widgetStates ? data.widgetStates : {};
                  if (Object.keys(states).length === 0) continue;

                  let name = null;
                  let titleFromHeading = null;
                  const allImages = [];
                  const seenImg = new Set();
                  let coverImage = null;
                  let breadcrumbs = [];
                  let brand = null;
                  let weight = null;
                  const dims = {};

                  const pushImg = (raw) => {
                    if (!raw) return;
                    const upgraded = upgrade(raw);
                    if (!upgraded) return;
                    const norm = String(upgraded).split('?')[0].split('#')[0].toLowerCase();
                    if (seenImg.has(norm)) return;
                    seenImg.add(norm);
                    allImages.push(upgraded);
                  };

                  for (const k of Object.keys(states)) {
                    let v = states[k];
                    if (typeof v === 'string') {
                      try {
                        v = JSON.parse(v);
                      } catch {
                        continue;
                      }
                    }
                    if (!v || typeof v !== 'object') continue;
                    const kLower = k.toLowerCase();
                    if (
                      !titleFromHeading &&
                      kLower.indexOf('heading') !== -1 &&
                      typeof v.title === 'string' &&
                      v.title.length > 3
                    ) {
                      titleFromHeading = v.title.trim();
                    }
                    if (!name && typeof v.title === 'string' && v.title.length > 3) name = v.title.trim();
                    if (!name && typeof v.name === 'string' && v.name.length > 3) name = v.name.trim();
                    if (!coverImage && typeof v.coverImage === 'string') coverImage = v.coverImage;
                    if (Array.isArray(v.images)) {
                      for (const img of v.images) {
                        const u = typeof img === 'string' ? img : img && (img.src || img.url || img.image);
                        if (u) pushImg(u);
                      }
                    }
                    if (Array.isArray(v.breadcrumbs) && v.breadcrumbs.length > breadcrumbs.length) {
                      breadcrumbs = v.breadcrumbs
                        .map((b) => (b && (b.text || b.title || b.name)) || '')
                        .filter(Boolean);
                    }
                    if (!brand && typeof v.brand === 'string') brand = v.brand;
                    if (Array.isArray(v.characteristics)) {
                      for (const c of v.characteristics) {
                        const cName = String((c && (c.name || c.title)) || '').toLowerCase();
                        const cValRaw = String((c && (c.value || (c.values && c.values[0] && c.values[0].text))) || '');
                        const m = cValRaw.match(/[\d.]+/);
                        const num = m ? parseFloat(m[0]) : null;
                        if (!num) continue;
                        if (cName.indexOf('вес') !== -1 || cName.indexOf('weight') !== -1) {
                          const isKg =
                            cValRaw.toLowerCase().indexOf('кг') !== -1 || cValRaw.toLowerCase().indexOf('kg') !== -1;
                          weight = weight || (isKg ? Math.round(num * 1000) : Math.round(num));
                        } else if (
                          cName.indexOf('длина') !== -1 ||
                          cName.indexOf('length') !== -1 ||
                          cName.indexOf('depth') !== -1
                        ) {
                          const isCm =
                            cValRaw.toLowerCase().indexOf('см') !== -1 || cValRaw.toLowerCase().indexOf('cm') !== -1;
                          dims.depth = dims.depth || (isCm ? Math.round(num * 10) : Math.round(num));
                        } else if (cName.indexOf('ширина') !== -1 || cName.indexOf('width') !== -1) {
                          const isCm =
                            cValRaw.toLowerCase().indexOf('см') !== -1 || cValRaw.toLowerCase().indexOf('cm') !== -1;
                          dims.width = dims.width || (isCm ? Math.round(num * 10) : Math.round(num));
                        } else if (cName.indexOf('высота') !== -1 || cName.indexOf('height') !== -1) {
                          const isCm =
                            cValRaw.toLowerCase().indexOf('см') !== -1 || cValRaw.toLowerCase().indexOf('cm') !== -1;
                          dims.height = dims.height || (isCm ? Math.round(num * 10) : Math.round(num));
                        }
                      }
                    }
                  }

                  const finalName = titleFromHeading || name;
                  if (coverImage) {
                    const filtered = allImages.filter((u) => u !== coverImage);
                    filtered.unshift(coverImage);
                    allImages.length = 0;
                    Array.prototype.push.apply(allImages, filtered);
                  }
                  if (!finalName && allImages.length === 0) {
                    return { ok: false, error: '页面解析失败：name + images 都为空' };
                  }
                  return {
                    ok: true,
                    data: {
                      sku,
                      name: finalName,
                      images: allImages,
                      breadcrumbs,
                      brand,
                      weight,
                      depth: dims.depth || null,
                      width: dims.width || null,
                      height: dims.height || null,
                    },
                  };
                } catch (e) {
                  // try next endpoint
                }
              }
              return { ok: false, error: '所有公开端点都失败' };
            };

            // 1) 优先：在已打开的 ozon.ru / ozon.kz tab 内 page-context 跑 fetch
            const ozonTabs = await chrome.tabs.query({
              url: ['https://www.ozon.ru/*', 'https://*.ozon.ru/*', 'https://ozon.kz/*', 'https://*.ozon.kz/*'],
            });
            // 排除 seller.* (反爬信任域不是这个;且 seller portal 走另一条路径)
            const target = ozonTabs.find(
              (t) => t.url && /^https:\/\/(www\.ozon\.ru|ozon\.kz|www\.ozon\.kz)\//.test(t.url)
            );
            if (target?.id) {
              try {
                const results = await chrome.scripting.executeScript({
                  target: { tabId: target.id },
                  func: inPageFetcher,
                  args: [sku],
                  world: 'MAIN',
                });
                const r = results?.[0]?.result;
                if (r) return r;
              } catch (e) {
                console.warn('[fetchOzonPublicProduct] in-tab executeScript failed:', e?.message);
              }
            }

            // 2) 没 tab / executeScript 失败 → 引导用户打开 ozon 页面
            if (!target) {
              return {
                ok: false,
                error: 'NO_OZON_TAB',
                message:
                  '请先在浏览器打开任意 ozon.ru 或 ozon.kz 页面（保持后台打开即可），让扩展能借用页面上下文抓数据',
              };
            }

            // 3) Fallback：service-worker 直 fetch（大概率反爬，但作为最后兜底）
            try {
              const r = await inPageFetcher(sku);
              return r;
            } catch (e) {
              return { ok: false, error: e?.message || '反爬拦截' };
            }
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'reportCategoryMapping': {
          // 由 ozon-bestsellers-hook 在 seller.ozon.ru 上学到的 (一级类目名 → leaf IDs[])
          // 转发上报到极掌后端入库。失败仅 console，不阻塞任何用户操作。
          try {
            if (!token || !storeId) return { ok: false, error: 'no auth' };
            // erp-lite 门控:bestsellers_snapshot 默认 false,未启用时不上报类目映射
            const ffCm = await getFeatureFlagsCached();
            if (ffCm?.bestsellers_snapshot !== true) return { ok: true, gated: true };
            const { name, leafIds, source } = message;
            if (!name || !Array.isArray(leafIds) || leafIds.length === 0) {
              return { ok: false, error: 'invalid payload' };
            }
            await apiRequest(
              'POST',
              `${backendUrl}/ozon/selection/category-mapping`,
              { name, leafIds, source: source || null },
              token,
              storeId
            );
            return { ok: true };
          } catch (e) {
            console.warn('[reportCategoryMapping] failed:', e?.message || e);
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'syncSellerCookies': {
          // Three-way query to cover all possible cookie storage locations
          const [byName, byUrl, byDomain] = await Promise.all([
            chrome.cookies.getAll({ name: 'sc_company_id' }),
            chrome.cookies.getAll({ url: 'https://seller.ozon.ru/app/dashboard/main' }),
            chrome.cookies.getAll({ domain: '.ozon.ru' }),
          ]);
          // Deduplicate by name+domain
          const seen = new Set();
          const sellerCookies = [];
          for (const c of [...byUrl, ...byDomain]) {
            const key = `${c.name}@${c.domain}`;
            if (!seen.has(key)) {
              seen.add(key);
              sellerCookies.push(c);
            }
          }

          if (!sellerCookies.length && !byName.length) {
            return { ok: false, error: '未检测到 Ozon 登录状态，请先在浏览器中登录 seller.ozon.ru' };
          }

          // Include byName results in cookie string if not already present
          for (const c of byName) {
            const key = `${c.name}@${c.domain}`;
            if (!seen.has(key)) {
              seen.add(key);
              sellerCookies.push(c);
            }
          }

          const cookieStr = sellerCookies.map((c) => `${c.name}=${c.value}`).join('; ');
          // SECURITY: never log cookie *values* — they're bearer credentials for
          // seller.ozon.ru. Names + counts are enough to debug sync issues.
          console.log('[syncSellerCookies] cookie names:', sellerCookies.map((c) => c.name).join(', '));
          console.log('[syncSellerCookies] cookie count:', sellerCookies.length);
          // Prefer name-based query (most reliable), fallback to merged list
          const companyIdCookie = byName[0] || sellerCookies.find((c) => c.name === 'sc_company_id');
          const scCompanyId = companyIdCookie?.value || null;

          if (!scCompanyId) {
            return { ok: false, error: '未找到 sc_company_id，请确认已登录 Ozon 卖家中心' };
          }

          if (!storeId) {
            return { ok: false, error: '请先选择店铺' };
          }

          await apiRequest(
            'PATCH',
            `${backendUrl}/auth/ozon-stores/${storeId}`,
            {
              cookieAuth: { cookies: cookieStr, sc_company_id: scCompanyId, userAgent: navigator.userAgent },
            },
            token,
            storeId
          );

          return { ok: true, data: { sc_company_id: scCompanyId, cookie_count: sellerCookies.length } };
        }
        case 'checkSellerCookies': {
          const [byName, byUrl, byDomain] = await Promise.all([
            chrome.cookies.getAll({ name: 'sc_company_id' }),
            chrome.cookies.getAll({ url: 'https://seller.ozon.ru/app/dashboard/main' }),
            chrome.cookies.getAll({ domain: '.ozon.ru' }),
          ]);
          const allCookies = [...byUrl, ...byDomain];
          const companyId = byName[0] || allCookies.find((c) => c.name === 'sc_company_id');
          return {
            ok: true,
            data: {
              has_cookies: allCookies.length > 0 || byName.length > 0,
              cookie_count: allCookies.length,
              sc_company_id: companyId?.value || null,
              userAgent: navigator.userAgent,
            },
          };
        }
        case 'translateKeywords': {
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/ozon/extension/translate`,
              { texts: message.texts, from: message.from || 'ru', to: message.to || 'zh' },
              token,
              storeId
            ),
          };
        }
        case 'aiOptimize': {
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/ozon/extension/ai-optimize`,
              {
                title: message.title,
                description: message.description,
                category: message.category,
                keywords: message.keywords,
              },
              token,
              storeId
            ),
          };
        }
        case 'getRecommendations': {
          const type = message.type || 'hot';
          let sortBy = type === 'blue' ? 'views' : 'sold_count';
          const resp = await apiRequest(
            'GET',
            `${backendUrl}/ozon/products/cache?currentPage=1&pageSize=20&sortBy=${sortBy}&sortOrder=desc`,
            null,
            token,
            storeId
          );
          return { ok: true, data: { products: resp.data || [] } };
        }
        case 'getProductStatusCounts': {
          return {
            ok: true,
            data: await apiRequest('GET', `${backendUrl}/ozon/products/cache/status-counts`, null, token, storeId),
          };
        }
        case 'getFavCount': {
          return {
            ok: true,
            data: await apiRequest(
              'GET',
              `${backendUrl}/ozon/favorites?currentPage=1&pageSize=1`,
              null,
              token,
              storeId
            ),
          };
        }
        case 'getStores': {
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/auth/ozon-stores`, null, token, storeId) };
        }
        case 'getCaptcha': {
          return { ok: true, data: await apiRequest('GET', `${backendUrl}/auth/captcha`, null, null, null) };
        }
        case 'sendSmsCode': {
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/auth/send-code`,
              { phoneNumber: message.phoneNumber, captchaId: message.captchaId, captchaCode: message.captchaCode },
              null,
              null
            ),
          };
        }
        case 'setMachineFingerprint': {
          // content script / popup / sync-auth 启动时主动推 v3 fingerprint 给 SW,
          // SW 缓存到 chrome.storage.local。后续 SW 自身的 heartbeat/login 等动作
          // 直接用这份「真·机器级」fingerprint,跟 web/popup 算出来的完全一致,
          // 解决"同台机器算成两台占两个名额"的问题。
          // SW 自己没 DOM,算不出 screen 维度;让任何有 DOM 的入口推过来就够了。
          const fp = String(message.deviceFingerprint || '').trim();
          if (!fp || !/^machine-v[23]-[a-z0-9-]+$/i.test(fp)) {
            return { ok: false, error: 'invalid fingerprint' };
          }
          try {
            await setStorage({ [STORAGE_KEYS.deviceFingerprintV3]: fp });
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message };
          }
        }
        case 'loginSms': {
          const fp = await getExtensionFingerprint(message.deviceFingerprint);
          // /auth/login 旧短信登录已被后端禁用 (auth.controller.ts:82),
          // 新路径 /auth/sms/verify body shape 兼容 (phoneNumber/code/deviceFingerprint/platform)。
          // 返回 shape (auth.service.ts:2784):
          //   单身份:{ accessToken, user }          ← P9 后是 camelCase,不再是 access_token
          //   多身份:{ sessionToken, identities }   ← popup 没有 UI 选择,引导走网页端
          // popup.js 三个字段兜底 (accessToken / access_token / token),保证 backend
          // shape 漂移不会再让登录挂死。
          // portalHost(2026-06-11 串号修复):SW 直调 api.* 时,后端 extractHost 的
          // Origin 是 chrome-extension:// 被跳过 → host 落 api.* → 一律判平台直营,
          // 分销商定制版用户在 popup 登录会被自注册进平台直营空账号(实锤:时渡
          // 17357982110)。把 brand.webHost(定制版=分销商商户域,平台版=
          // store.jizhangerp.com)随 body 显式声明登录门户,后端优先用它解析
          // distributorId。dev 源码加载无 brand 注入 → undefined → 后端走原 host
          // 链路,行为不变。
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/auth/sms/verify`,
              {
                phoneNumber: message.phoneNumber,
                code: message.code,
                deviceFingerprint: fp,
                platform: 'extension',
                portalHost: jzBrandPortalHost(),
              },
              null,
              null
            ),
          };
        }
        case 'loginPassword': {
          const fp = await getExtensionFingerprint(message.deviceFingerprint);
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/auth/login-password`,
              {
                phoneNumber: message.phoneNumber,
                password: message.password,
                captchaId: message.captchaId,
                captchaCode: message.captchaCode,
                deviceFingerprint: fp,
                platform: 'extension',
                portalHost: jzBrandPortalHost(),
              },
              null,
              null
            ),
          };
        }
        case 'login': {
          const fp = await getExtensionFingerprint(message.deviceFingerprint);
          return {
            ok: true,
            data: await apiRequest(
              'POST',
              `${backendUrl}/auth/login-password`,
              {
                phoneNumber: message.phone,
                password: message.password,
                deviceFingerprint: fp,
                platform: 'extension',
                portalHost: jzBrandPortalHost(),
              },
              null,
              null
            ),
          };
        }
        case 'getUpdateInfo': {
          const stored = await getStorage([
            STORAGE_KEYS.latestVersion,
            STORAGE_KEYS.latestDownloadUrl,
            STORAGE_KEYS.updateDismissedVersion,
          ]);
          const latestVersion = stored[STORAGE_KEYS.latestVersion];
          const downloadUrl = stored[STORAGE_KEYS.latestDownloadUrl];
          const dismissedVersion = stored[STORAGE_KEYS.updateDismissedVersion];
          const currentVersion = getCurrentVersion();
          const hasUpdate =
            latestVersion && compareVersions(latestVersion, currentVersion) > 0 && latestVersion !== dismissedVersion;
          return { ok: true, data: { hasUpdate, currentVersion, latestVersion, downloadUrl } };
        }
        case 'checkUpdate': {
          await checkForUpdate();
          const info = await getStorage([STORAGE_KEYS.latestVersion, STORAGE_KEYS.latestDownloadUrl]);
          const curVer = getCurrentVersion();
          const newVer = info[STORAGE_KEYS.latestVersion];
          const dlUrl = info[STORAGE_KEYS.latestDownloadUrl];
          const isNew = newVer && compareVersions(newVer, curVer) > 0;
          return {
            ok: true,
            data: { hasUpdate: isNew, currentVersion: curVer, latestVersion: newVer, downloadUrl: dlUrl },
          };
        }
        case 'dismissUpdate': {
          const verToDismiss = message.version;
          if (verToDismiss) {
            await setStorage({ [STORAGE_KEYS.updateDismissedVersion]: verToDismiss });
            chrome.action.setBadgeText({ text: '' });
          }
          return { ok: true };
        }
        default:
          return { ok: false, error: '未知消息类型' };
      }
    };

    // Keep service worker alive during operations that may exceed Chrome MV3
    // SW idle timeout (~30s). 用 chrome.runtime.getPlatformInfo() 周期 ping 续命。
    //
    // 之前只覆盖 followSell / importBySku — 实测 fetchProductPageState /
    // searchVariants 也可能因为 chrome.scripting.executeScript
    // 注入 MAIN world 卡 30s+(Ozon 2026 page main world race condition),
    // SW 被 unload → handle() promise 中断 → sendResponse 永不调 →
    // content_script 等 60s 超时。把这几个 action 也加进保活列表。
    let keepAliveTimer = null;
    // 注:expandModelVariants 在 2aaa415 之后已不在 SW 实现(改 content-side SSR HTML fetch),
    // fetchSellerSiblings 在 c6f9925 整个 handler 删了,均无需在 KEEP_ALIVE_ACTIONS 列出。
    const KEEP_ALIVE_ACTIONS = new Set([
      'followSell',
      'importBySku',
      'fetchProductPageState',
      'searchVariants',
      // 视频转存:download(跨源 .mp4) + media-storage 上传跑在 seller/buyer tab,executeScript
      // 可达 90s+,必须保活防 SW unload 中断 sendResponse。
      'uploadFollowSellVideo',
      'transferVariantVideo',
    ]);
    if (KEEP_ALIVE_ACTIONS.has(message?.action)) {
      chrome.runtime.getPlatformInfo(() => {});
      keepAliveTimer = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => {});
      }, 15_000);
    }

    // Handler 顶层 race timeout — 防止内部 await 永不返(executeScript hang /
    // promise leak)导致 handle() 永远 pending,sendResponse 永不调,content 等死。
    // 默认 50s(留 10s buffer 给 content wrapper 的 60s)。视频转存例外:download 跨源 .mp4 +
    // media-storage 上传跑在 seller/buyer tab,executeScript 内部就排到 90s+(transferVariantVideo
    // 还叠加买家 tab 抓图册 40s),50s 会把**正常但慢**的转存误杀。给它们 160s 上限,并配合
    // content LONG_ACTIONS 把这俩 action 的 content 侧超时也放宽到 600s。
    const VIDEO_ACTIONS = new Set(['uploadFollowSellVideo', 'transferVariantVideo']);
    const HANDLER_TOTAL_TIMEOUT_MS = VIDEO_ACTIONS.has(message?.action) ? 160_000 : 50_000;
    const handlerPromise = Promise.race([
      handle(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`SW handler ${message?.action} 总超时 (${HANDLER_TOTAL_TIMEOUT_MS / 1000}s)`)),
          HANDLER_TOTAL_TIMEOUT_MS
        )
      ),
    ]);

    handlerPromise
      .then((result) => {
        console.log(`[SW] sendResponse OK for action=${message?.action}`, JSON.stringify(result).slice(0, 150));
        sendResponse(result);
      })
      .catch((error) => {
        console.error(`[SW] sendResponse ERROR for action=${message?.action}`, error.message);
        sendResponse({ ok: false, error: error.message || '请求失败' });
      })
      .finally(() => {
        if (keepAliveTimer) clearInterval(keepAliveTimer);
      });

    return true;
  });
})();
