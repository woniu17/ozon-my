globalThis.__JZ_BRAND__ = {
  code: 'qx',
  displayName: 'QX',
  productName: 'QX',
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
        } catch (_) { }
      },
      create: () => { },
      onClicked: { addListener: () => { }, removeListener: () => { } },
    };
  }
  if (typeof chrome.notifications === 'undefined') {
    chrome.notifications = {
      create: (id, opts, cb) => {
        try {
          cb && cb(typeof id === 'string' ? id : '');
        } catch (_) { }
      },
      clear: (id, cb) => {
        try {
          cb && cb(true);
        } catch (_) { }
      },
      onClicked: { addListener: () => { }, removeListener: () => { } },
    };
  }
  if (typeof chrome.cookies === 'undefined') {
    chrome.cookies = {
      getAll: (_query, cb) => {
        const empty = [];
        if (typeof cb === 'function') {
          try {
            cb(empty);
          } catch (_) { }
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
    '../collect/agent/collect-actions.js',
    'agent/agent-runtime.js',
    '../collect/background/collect-namespace.js',
    '../collect/background/collect-cache.js',
    '../collect/background/collect-config.js',
    '../collect/background/collect-runner.js',
    '../collect/background/collect-queue.js',
    '../collect/background/collect-tab.js'
  );
} catch (e) {
  // 不要阻断 SW 启动 — 老功能仍需可用。client-sync 失败时 alarm 不会触发。
  console.warn('[SW] client-sync importScripts failed:', e?.message || e);
}

(() => {
  // ─── IS_TEST_MODE 检测(SW 无 location,读 chrome.storage.local 标志) ─────
  // 测试模式下 Ozon www 与 seller portal 都由本地 mock server (port 7777) 扮演。
  // 启动时异步读取,几毫秒完成;测试前需先 set storage 再 runtime.reload()。
  // 详见 test/e2e-auto-collect/README.md。
  let IS_TEST_MODE = false;
  let OZON_WWW_ORIGIN = 'https://www.ozon.ru';
  let OZON_SELLER_ORIGIN = 'https://seller.ozon.ru';
  const _testModeReady = chrome.storage.local.get('__IS_TEST_MODE__').then(
    (r) => {
      IS_TEST_MODE = !!r?.__IS_TEST_MODE__;
      OZON_WWW_ORIGIN = IS_TEST_MODE ? 'http://localhost:7777' : 'https://www.ozon.ru';
      OZON_SELLER_ORIGIN = IS_TEST_MODE ? 'http://localhost:7777' : 'https://seller.ozon.ru';
    },
    () => {
      /* 读取失败按生产模式走 */
    }
  );

  // 启动版本标识：用户跟卖前看 chrome://extensions QX → service worker → console
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
    // 专用买家 tab 持久化状态(跨 SW 重启 + 插件重载复用)
    // { tabId, callCount, lastSku }
    dedicatedBuyerTab: 'dedicatedBuyerTab',
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

  // ── QX算价：CNY→RUB 实时汇率 ──
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

  // 注:L1→L2 缓存补写定时任务已废弃(取消 IndexedDB 后所有缓存直接入库 SQLite)
  // 原 CACHE_SYNC_ALARM / CACHE_SYNC_INTERVAL_MINUTES 常量已删除

  // ── 采集队列常量(已迁移到 collect/background/collect-queue.js) ─────────────
  // 常量保留在 IIFE 内(alarm handler / clearFinishedQueueTasks 等引用),
  // collect-queue.js 中也有一份(字符串重复无害)。
  const COLLECT_QUEUE_KEY = 'jz-collect-queue';
  const COLLECT_QUEUE_META_KEY = 'jz-collect-queue-meta';
  const COLLECT_QUEUE_ALARM = 'collect-queue-consume';
  const COLLECT_QUEUE_ALARM_MINUTES = 1;
  const COLLECT_QUEUE_OPS_POLL_MS = 5000;
  const COLLECT_QUEUE_MAX_COMPLETED = 500;
  const COLLECT_QUEUE_STALE_RUNNING_MS = 5 * 60 * 1000;

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
  // 错开 500ms 重载,避免多标签页同时重载 + content script 重新注入导致内存峰值
  // (与 reloadSellerTabs 保持一致的错开策略)。
  let _reloadTimer = null;
  function reloadOzonTabs() {
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(async () => {
      const tabs = await chrome.tabs.query({
        url: IS_TEST_MODE ? ['http://localhost:7777/*'] : ['*://*.ozon.ru/*', '*://*.ozon.kz/*'],
      });
      for (let i = 0; i < tabs.length; i++) {
        setTimeout(() => chrome.tabs.reload(tabs[i].id), i * 500);
      }
      if (tabs.length) {
        console.log(`[reloadOzonTabs] scheduled ${tabs.length} ozon tab(s) reload (staggered 500ms)`);
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
              } catch { }
            },
          });
        } catch { }
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
      } catch { }
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
  // normalizeSearchVariantToSv 已迁移到 collect/background/collect-runner.js
  const normalizeSearchVariantToSv = (v) => __jzCollect.normalizeSearchVariantToSv(v);

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
   * **副作用**: 每次调用 Ozon 端创建一个新 bundle draft,bundle_id 递增。用三层缓存
   * 最大化减少 draft 堆积:
   *   L1 IndexedDB (SW 本地,毫秒级命中)
   *   L2 MongoDB    (ERP 远程,多设备共享,永久存储)
   *   L3 Ozon 真调  (有副作用,创建 draft)
   *
   * 缓存 key 都用 sku(bundle item 是源商品数据,同一 SKU 跨店数据相同)。
   * 空属性(attributes=[])可能是瞬时降级产物,6h 重验一次(移植自 MY 项目)。
   * 需要立即刷新可在 sendMessage('searchVariants', { sku, forceRefresh: true })。
   *
   * Headers 实测带 / 不带 x-o3-app-name + x-o3-page-type 都 200 OK,沿用 fetchSellerPortal
   * 默认 headers + urlPrefix='/api/site' 即可。
   */

  // ── 三层缓存:IndexedDB + MongoDB(ERP) + Ozon 真调 ──────────────────────────
  // SW 启动时清理旧的 chrome.storage.local bundle cache(v1/v2),改为 IndexedDB + ERP。
  // 加 1h 节流,避免 SW 频繁重启时反复全量读 storage 导致内存峰值。
  (async () => {
    try {
      const throttleKey = 'jz-sw-bundle-cleanup-at';
      const now = Date.now();
      const { [throttleKey]: lastAt } = await new Promise((r) => chrome.storage.local.get(throttleKey, r));
      if (lastAt && now - lastAt < 60 * 60 * 1000) return; // 1h 内已清理,跳过
      await new Promise((r) => chrome.storage.local.set({ [throttleKey]: now }, r));
      const all = await new Promise((r) => chrome.storage.local.get(null, r));
      const stale = Object.keys(all || {}).filter((k) => k.startsWith('jz-sw-bundle'));
      if (stale.length) {
        await new Promise((r) => chrome.storage.local.remove(stale, r));
        console.log(`[SW] cleared ${stale.length} legacy bundle cache entries (migrated to IndexedDB+ERP)`);
      }
    } catch { }
  })();

  // ── 采集缓存层(已迁移到 collect/background/collect-cache.js) ──────────────
  // 常量保留在 IIFE 内(其他模块引用 _IDB_STORE_* 等),collect-cache.js 中也有一份(字符串重复无害)
  // v8: card+detail→dom, search+bundle→attribute(详见 collect-cache.js)
  const _IDB_NAME = 'ozon-cache';
  const _IDB_VERSION = 8;
  const _IDB_STORE_DOM = 'dom_cache';
  const _IDB_STORE_ATTRIBUTE = 'attribute_cache';
  const _IDB_STORE_RICH_MEDIA = 'rich_media_cache';
  const _IDB_STORE_MARKET_STATS = 'market_stats_cache';
  const _IDB_STORE_FOLLOW_SELL = 'follow_sell_cache';
  // 旧 store(仅迁移用,保留常量以兼容其他模块引用)
  const _IDB_STORE_SEARCH = 'search_cache';
  const _IDB_STORE_BUNDLE = 'bundle_cache';
  const _IDB_STORE_CARD = 'card_cache';
  const _IDB_STORE_COMPOSER = 'composer_cache';
  const _IDB_STORE_ENTRYPOINT = 'entrypoint_cache';
  const _IDB_STORE_DETAIL = 'detail_cache';
  const _ATTRS_EMPTY_REVERIFY_MS = 6 * 60 * 60 * 1000;

  // 初始化 __jzCollect 命名空间(apiRequest 定义在后面,用箭头函数延迟求值;
  // loadAutoCollectConfig 由 collect-config.js 提供,经 __jzCollect 读取避免 TDZ)
  // IS_TEST_MODE 是 let 变量(异步初始化),用 getter 让 collect-queue.js 读到最新值。
  // maybeStartConsume 留在 SW 编排层(调用 _consumeOne/_processTask → _doAutoCollect),
  // 用箭头函数延迟求值避免 TDZ(定义在后面)。
  __jzCollect.init({
    getBackendUrl,
    getStorage,
    setStorage,
    removeStorage,
    STORAGE_KEYS,
    apiRequest: (m, u, b, t, s, to) => apiRequest(m, u, b, t, s, to),
    loadAutoCollectConfig: () => __jzCollect.loadAutoCollectConfig(),
    get IS_TEST_MODE() {
      return IS_TEST_MODE;
    },
    get OZON_WWW_ORIGIN() {
      return OZON_WWW_ORIGIN;
    },
    get OZON_SELLER_ORIGIN() {
      return OZON_SELLER_ORIGIN;
    },
    get testModeReady() {
      return _testModeReady;
    },
    maybeStartConsume: () => _maybeStartConsume(),
  });

  // 委托包装器:IIFE 内其他模块通过 _xxx 调用,实际委托到 __jzCollect.xxx
  const _bundleUsable = (entry) => __jzCollect.bundleUsable(entry);
  const _erpCacheGet = (type, sku) => __jzCollect.erpCacheGet(type, sku);
  const _erpCacheSet = (type, sku, body) => __jzCollect.erpCacheSet(type, sku, body);
  const _erpCacheDelete = (type, sku) => __jzCollect.erpCacheDelete(type, sku);
  const _writeAutoCollectLog = (payload) => __jzCollect.writeAutoCollectLog(payload);
  const _writeShallowCollectLog = (payload) => __jzCollect.writeShallowCollectLog(payload);
  // v8: card+detail→domCache, search+bundle→attributeCache
  const _domCacheGet = (sku, type) => __jzCollect.domCacheGet(sku, type);
  const _domCacheSet = (sku, type, data) => __jzCollect.domCacheSet(sku, type, data);
  const _domCacheDelete = (sku) => __jzCollect.domCacheDelete(sku);
  const _attributeCacheGet = (sku, type) => __jzCollect.attributeCacheGet(sku, type);
  const _attributeCacheSet = (sku, type, data, extra) => __jzCollect.attributeCacheSet(sku, type, data, extra);
  const _attributeCacheDelete = (sku) => __jzCollect.attributeCacheDelete(sku);
  const _richMediaCacheGet = (sku) => __jzCollect.richMediaCacheGet(sku);
  const _richMediaCacheSet = (sku, data) => __jzCollect.richMediaCacheSet(sku, data);
  const _richMediaCacheDelete = (sku) => __jzCollect.richMediaCacheDelete(sku);
  const _marketStatsCacheGet = (sku) => __jzCollect.marketStatsCacheGet(sku);
  const _marketStatsCacheSet = (sku, data) => __jzCollect.marketStatsCacheSet(sku, data);
  const _marketStatsCacheDelete = (sku) => __jzCollect.marketStatsCacheDelete(sku);
  const _followSellCacheGet = (sku) => __jzCollect.followSellCacheGet(sku);
  const _followSellCacheSet = (sku, data) => __jzCollect.followSellCacheSet(sku, data);
  const _followSellCacheDelete = (sku) => __jzCollect.followSellCacheDelete(sku);
  const _batchCacheStatus = (skus) => __jzCollect.batchCacheStatus(skus);

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
    } catch { }
  })();

  // fetchBundleByVariantId 已迁移到 collect/background/collect-tab.js
  const fetchBundleByVariantId = (sku, variantId, companyId, opts = {}) =>
    __jzCollect.fetchBundleByVariantId(sku, variantId, companyId, opts);

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
      } catch { }
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
    } catch { }
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
    const scCookies = await chrome.cookies.getAll({ url: OZON_SELLER_ORIGIN + '/', name: 'sc_company_id' });
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

  // _ensureSellerTabImpl / ensureSellerTab / normalizeMarketItem / ensureBuyerTab 已迁移到 collect/background/collect-tab.js
  const ensureSellerTab = (timeoutMs = 20000) => __jzCollect.ensureSellerTab(timeoutMs);
  const ensureBuyerTab = (sku, timeoutMs = 20000) => __jzCollect.ensureBuyerTab(sku, timeoutMs);

  // transferVideoToOzon 已迁移到 collect/background/collect-tab.js
  const transferVideoToOzon = (srcUrl) => __jzCollect.transferVideoToOzon(srcUrl);

  // _isRichDoc / _extract*FromStates / fetchPdpBundleViaBuyerTab 已迁移到 collect/background/collect-tab.js
  const fetchPdpBundleViaBuyerTab = (productUrl, options = {}) =>
    __jzCollect.fetchPdpBundleViaBuyerTab(productUrl, options);

  // ── 采集配置层(已迁移到 collect/background/collect-config.js) ──────────────
  // 保留常量与委托包装器:IIFE 内其他模块(checkStoreClassification/_doAutoCollect 等)
  // 通过 _xxx 调用,实际委托到 __jzCollect.xxx。
  const _AUTO_COLLECT_CONFIG_KEY = __jzCollect.AUTO_COLLECT_CONFIG_KEY;
  const _AUTO_COLLECT_CONFIG_DEFAULT = __jzCollect.AUTO_COLLECT_CONFIG_DEFAULT;
  const _loadAutoCollectConfig = () => __jzCollect.loadAutoCollectConfig();
  const _saveAutoCollectConfig = (partial) => __jzCollect.saveAutoCollectConfig(partial);
  const _invalidateAutoCollectConfigCache = () => __jzCollect.invalidateAutoCollectConfigCache();
  const _pushAutoCollectRecent = (sku, status, source, storeClassified, results, startTime, reason) =>
    __jzCollect.pushAutoCollectRecent(sku, status, source, storeClassified, results, startTime, reason);

  // ── 店铺中国身份分类 + ERP CRUD + 人工确认(已迁移到 collect/background/collect-runner.js) ──
  // 委托包装器:IIFE 内 _doAutoCollect 和 onMessage handler 通过 _xxx 调用,实际委托到 __jzCollect.xxx。
  const classifyStoreByRules = (slug, name, companyInfo, config) =>
    __jzCollect.classifyStoreByRules(slug, name, companyInfo, config);
  const _erpStoreClassGet = (slug, sellerId) => __jzCollect._erpStoreClassGet(slug, sellerId);
  const _erpStoreClassSet = (slug, record, sellerId) => __jzCollect._erpStoreClassSet(slug, record, sellerId);
  const _erpStoreSkuReport = (payload) => __jzCollect._erpStoreSkuReport(payload);
  const checkStoreClassification = (slug, name, companyInfo, sellerId) =>
    __jzCollect.checkStoreClassification(slug, name, companyInfo, sellerId);
  const manualClassifyStore = (slug, name, isChinese, sellerId) =>
    __jzCollect.manualClassifyStore(slug, name, isChinese, sellerId);

  // fetchSellerViaOzonTab 已迁移到 collect/background/collect-tab.js
  const fetchSellerViaOzonTab = (path, body, opts = {}, preferTabId = null) =>
    __jzCollect.fetchSellerViaOzonTab(path, body, opts, preferTabId);

  // fetchSellerPortal 已迁移到 collect/background/collect-tab.js
  const fetchSellerPortal = (path, body, timeoutMsOrOpts = 30000) =>
    __jzCollect.fetchSellerPortal(path, body, timeoutMsOrOpts);

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
        } catch { }
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
    if (!token) return null; // 未登录QX,无法派单
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
    if (!token) return null; // 未登录QX,无法派单
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

  // _fetchMarketStatsDirect 已迁移到 collect/background/collect-tab.js
  const _fetchMarketStatsDirect = (sku, period) => __jzCollect._fetchMarketStatsDirect(sku, period);

  // ── autoCollect 配置保存与环形缓冲已迁移到 collect/background/collect-config.js ──
  // IIFE 内通过 _saveAutoCollectConfig / _pushAutoCollectRecent 委托包装器调用(见 L2129-2132)。

  // _handleAntibot 已迁移到 collect/background/collect-runner.js
  const _handleAntibot = (sku, source, sellerSlug, storeClassified, depth, startTime, results, sellerId) =>
    __jzCollect._handleAntibot(sku, source, sellerSlug, storeClassified, depth, startTime, results, sellerId);

  // _doAutoCollect 已迁移到 collect/background/collect-tab.js
  const _doAutoCollect = (sku, source, sellerSlug, depth, forceRefresh, sellerId) =>
    __jzCollect._doAutoCollect(sku, source, sellerSlug, depth, forceRefresh, sellerId);

  // ── 采集队列(已迁移到 collect/background/collect-queue.js) ─────────────────
  // 委托包装器:IIFE 内编排层(_processTask/_consumeOne/_maybeStartConsume)和
  // onMessage handler 通过 _xxx 调用,实际委托到 __jzCollect._xxx。
  // 状态变量(_consuming/_completedTodaySkus/_queueWriteLock/_opsPollTimer)
  // 已迁移到 __jzCollect.state(collect-namespace.js)。
  const _COLLECT_QUEUE_META_DEFAULT = __jzCollect._COLLECT_QUEUE_META_DEFAULT;
  const _withQueueLock = (fn) => __jzCollect._withQueueLock(fn);
  // Phase 2 废弃:以下本地队列 CRUD 函数已不再使用(队列真相源移至 ERP)
  // 保留委托包装器仅为向后兼容,实际调用应使用 _erpQueueClaim/_erpQueueList 等
  const _loadQueue = () => __jzCollect._loadQueue();
  const _loadQueueMeta = () => __jzCollect._loadQueueMeta();
  const _saveQueueMeta = (partial) => __jzCollect._saveQueueMeta(partial);
  const _enqueueTask = (task) => __jzCollect._enqueueTask(task);
  const _updateQueueTask = (sku, updates) => __jzCollect._updateQueueTask(sku, updates);
  const _deleteQueueTask = (sku) => __jzCollect._deleteQueueTask(sku);
  const _clearPendingQueueTasks = (beforeTs) => __jzCollect._clearPendingQueueTasks(beforeTs);
  const _getNextPending = () => __jzCollect._getNextPending();
  const _addCompletedToday = (sku) => __jzCollect._addCompletedToday(sku);
  const _isTaskQueuedOrCompletedToday = (sku) => __jzCollect._isTaskQueuedOrCompletedToday(sku);
  const _initCompletedTodaySet = () => __jzCollect._initCompletedTodaySet();
  const _buildSteps = (results) => __jzCollect._buildSteps(results);
  const _cleanupCompletedTasksLocked = (queue) => __jzCollect._cleanupCompletedTasksLocked(queue);
  const _syncConsumeRateFromConfig = () => __jzCollect._syncConsumeRateFromConfig();
  const _isCircuitBreakerActive = () => __jzCollect._isCircuitBreakerActive();
  const _broadcastRescan = () => __jzCollect._broadcastRescan();
  const _fetchProductDataStats = (sku) => __jzCollect._fetchProductDataStats(sku);
  const _extractBundlePhysicalAttrs = (bundleItem) => __jzCollect._extractBundlePhysicalAttrs(bundleItem);
  const _getBundleItemForBroadcast = (sku) => __jzCollect._getBundleItemForBroadcast(sku);
  const _getSearchVariantForBroadcast = (sku) => __jzCollect._getSearchVariantForBroadcast(sku);
  const _buildCollectDoneData = (sku, collectResult) => __jzCollect._buildCollectDoneData(sku, collectResult);

  // ── 批量查询去重:相同 SKU 的并发查询合并为一次 ──
  // 场景:多个 content_scripts(ozon-data-panel 5s 定时器 + manager 轮询)
  // 同一 tick 内可能对同一 SKU 发起多次查询,inflight Map 合并避免重复 HTTP/缓存查询。
  const _erpQueryInflight = new Map(); // sku → Promise<preFetched>
  const _cacheStatusInflight = new Map(); // sku → Promise<{ results, hitCount, total }>

  // 单 SKU 缓存状态查询(抽出供 queryCacheStatus 和 queryCacheStatusBatch 兜底复用)
  async function _queryCacheStatusOne(qSku) {
    if (!qSku) return null;
    // v8: card/detail → domCache, search/bundle → attributeCache
    // 5 类合并命中位(与采集箱对齐):
    //   dom = card OR detail(任一有采集)
    //   attribute = search AND bundle(都需要)
    //   richMedia / marketStats / followSell 各自独立
    // 优化:dom card/detail 共享一次 _erpCacheGet('dom',sku),attribute search/bundle
    // 共享一次 _erpCacheGet('attribute',sku)。原本 7 路 HTTP → 5 路 HTTP。
    const [dom, attribute, pdp, marketStats, followSell] = await Promise.all([
      _erpCacheGet('dom', qSku).catch(() => null),
      _erpCacheGet('attribute', qSku).catch(() => null),
      _richMediaCacheGet(qSku).catch(() => null),
      _marketStatsCacheGet(qSku).catch(() => null),
      _followSellCacheGet(qSku).catch(() => null),
    ]);
    const hasCard = !!(dom && dom.card);
    const hasDetail = !!(dom && dom.detail);
    const hasSearch = !!(attribute && attribute.searchData);
    const hasBundle = !!(attribute && attribute.bundleData);
    const results = [
      { type: 'dom', hit: hasCard || hasDetail },
      { type: 'attribute', hit: hasSearch && hasBundle },
      { type: 'richMedia', hit: !!pdp },
      { type: 'marketStats', hit: !!(marketStats && marketStats.data) },
      { type: 'followSell', hit: !!(followSell && followSell.data) },
    ];
    const hitCount = results.filter((r) => r.hit).length;
    return { results, hitCount, total: results.length };
  }
  const _erpQueueInsert = (task) => __jzCollect._erpQueueInsert(task);
  const _erpQueueUpdate = (task) => __jzCollect._erpQueueUpdate(task);
  const _erpQueueResult = (sku, result) => __jzCollect._erpQueueResult(sku, result);
  const _erpQueueDelete = (sku) => __jzCollect._erpQueueDelete(sku);
  const _erpGetPendingOps = () => __jzCollect._erpGetPendingOps();
  const _erpMarkOpProcessed = (opId) => __jzCollect._erpMarkOpProcessed(opId);
  // Phase 2: ERP 真相源模式 - 新增 claim/stats/list 等委托
  const _erpQueueClaim = () => __jzCollect._erpQueueClaim();
  const _erpQueueClearTerminal = () => __jzCollect._erpQueueClearTerminal();
  const _erpQueueStats = () => __jzCollect._erpQueueStats();
  const _erpQueueList = (status, page, pageSize, sort) => __jzCollect._erpQueueList(status, page, pageSize, sort);
  const _migrateLocalQueueIfNeeded = () => __jzCollect._migrateLocalQueueIfNeeded();
  const _finalizeTask = (task, status, lastError, steps, startedAt, duration, collectResult) =>
    __jzCollect._finalizeTask(task, status, lastError, steps, startedAt, duration, collectResult);
  const _handlePartialTask = (task, result, steps, startedAt, duration, errorType) =>
    __jzCollect._handlePartialTask(task, result, steps, startedAt, duration, errorType);
  const _handleSkippedTask = (task, result, steps, startedAt, duration) =>
    __jzCollect._handleSkippedTask(task, result, steps, startedAt, duration);
  // 测试专用:重置队列状态(委托到 collect-queue.js)
  self.__jzResetQueueState = () => __jzCollect.resetQueueState();

  const _processTask = async (task) => {
    const startTime = Date.now();
    let result = null;
    let steps = null;
    let isTerminal = false;

    try {
      const config = await _loadAutoCollectConfig();
      const depth = task.depth || config.depth || 'Full';
      result = await _doAutoCollect(task.sku, task.source || 'shop-page', task.sellerSlug, depth, false, task.sellerId);
      const duration = Date.now() - startTime;
      steps = _buildSteps(result?.results);

      if (result?.status === 'success') {
        isTerminal = await _finalizeTask(task, 'success', null, steps, startTime, duration, result);
      } else if (result?.status === 'partial') {
        // 部分/全部失败:回 pending 队尾重试(无限重试,无退避)
        isTerminal = await _handlePartialTask(task, result, steps, startTime, duration, 'partial');
      } else if (result?.status === 'skipped') {
        isTerminal = await _handleSkippedTask(task, result, steps, startTime, duration);
      } else if (result?.status === 'antibot') {
        // 反爬:触发熔断,任务回 pending 队尾等熔断结束后重试
        // 复用 _handleAntibot 返回的 pausedUntil,避免两次 Date.now() 调用导致
        // config.pausedUntil 与 meta.circuitBreakerUntil 之间产生毫秒级漂移
        const _pausedUntil = result?.pausedUntil || Date.now() + 10 * 60 * 1000;
        await _saveQueueMeta({ circuitBreakerUntil: _pausedUntil });
        isTerminal = await _handlePartialTask(task, result, steps, startTime, duration, 'antibot');
      } else {
        // 其他异常(如 _doAutoCollect 内部 catch):回 pending 队尾重试
        isTerminal = await _handlePartialTask(task, result, steps, startTime, duration, 'failed');
      }
    } catch (e) {
      const duration = Date.now() - startTime;
      console.error('[Queue] process task error:', task.sku, e);
      isTerminal = await _handlePartialTask(
        task,
        { error: e?.message || 'internal_error' },
        steps,
        startTime,
        duration,
        'internal'
      );
    }
    return { result, isTerminal };
  };

  // 根据队列 meta 计算下一次消费的间隔(毫秒)
  // 用 [consumeRateMinSec, consumeRateMaxSec] 范围随机(反爬+拟人化);
  // 字段缺失或非法时用默认值 5~15 秒
  const _getNextConsumeIntervalMs = (meta) => {
    let lo = Number(meta?.consumeRateMinSec);
    let hi = Number(meta?.consumeRateMaxSec);
    if (!Number.isFinite(lo) || lo <= 0) lo = 5;
    if (!Number.isFinite(hi) || hi <= 0) hi = 15;
    if (hi < lo) hi = lo;
    const loMs = lo * 1000;
    const hiMs = hi * 1000;
    return loMs + Math.random() * (hiMs - loMs);
  };

  const _consumeOne = async () => {
    if (__jzCollect.state.consuming) return;
    __jzCollect.state.consuming = true;
    __jzCollect.state.consumeStartedAt = Date.now();
    __jzCollect.state.nextConsumeAt = 0; // 开始消费,清空下次预计时间

    let keepAliveTimer = null;
    let scheduleNext = false;
    try {
      keepAliveTimer = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => { });
      }, 15000);

      let meta = await _loadQueueMeta();
      const today = new Date().toLocaleDateString('en-CA');
      if (meta.todayDate !== today) {
        __jzCollect.state.completedTodaySkus.clear();
        meta = await _saveQueueMeta({ todayDate: today, consumePaused: false });
      }

      if (Date.now() < meta.circuitBreakerUntil) {
        console.log('[Queue] circuit breaker active, skip');
        return;
      }

      // Phase 2: peek 用 ERP list(pending),判断是否有待消费任务。
      const peekList = await _erpQueueList('pending', 1, 1);
      const peekTask = peekList?.items?.[0] || null;

      if (meta.consumePaused) {
        console.log('[Queue] paused, skip');
        return;
      }

      const config = await _loadAutoCollectConfig();
      if (!config.autoCollectRunning || (config.paused && Date.now() < config.pausedUntil)) {
        console.log('[Queue] autoCollect config paused/not-running, pause queue');
        await _saveQueueMeta({ consumePaused: true });
        return;
      }

      // Phase 2: 原子抢占任务(ERP 端 UPDATE...RETURNING,多 SW 并发安全)
      // claim 已在 ERP 端改 status=running, attempts+1, startedAt,无需再调 _updateQueueTask
      const task = await _erpQueueClaim();
      if (!task) {
        console.log('[Queue] no pending task (claim returned null), stop loop');
        return;
      }

      const { isTerminal } = await _processTask(task);

      meta = await _loadQueueMeta();
      await _saveQueueMeta({
        lastConsumeAt: Date.now(),
      });

      const rateMs = _getNextConsumeIntervalMs(meta);
      scheduleNext = true;
      __jzCollect.state.nextConsumeAt = Date.now() + rateMs; // 精确下次执行时间
      setTimeout(() => {
        __jzCollect.state.consuming = false;
        __jzCollect.state.consumeStartedAt = 0;
        _consumeOne();
      }, rateMs);
    } catch (e) {
      console.error('[Queue] consume error:', e);
      // Phase 2: ERP 不可用时(claim 失败)暂停消费,避免反复失败。
      // _processTask 内部有 try/catch 不会抛出,此处 catch 主要是 ERP 不可用。
      await _saveQueueMeta({ consumePaused: true }).catch(() => { });
    } finally {
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (!scheduleNext) {
        __jzCollect.state.consuming = false;
        __jzCollect.state.consumeStartedAt = 0;
      }
    }
  };

  // consuming 卡死阈值:单次 _processTask 正常 < 5min(stale-reset 也是 5min),
  // 超过 10min 视为卡死(_doAutoCollect 内某 await 永不返回),强制重置让 alarm 能恢复。
  const _CONSUME_STUCK_MS = 10 * 60 * 1000;

  const _maybeStartConsume = async () => {
    if (__jzCollect.state.consuming) {
      // 卡死检测:consuming=true 且超过阈值,强制重置(防止 _doAutoCollect 内部
      // 某 await 永不返回导致队列永久停摆,alarm 每分钟触发都因 consuming=true 直接 return)。
      const stuckMs = Date.now() - (__jzCollect.state.consumeStartedAt || 0);
      if (stuckMs > _CONSUME_STUCK_MS) {
        console.warn('[Queue] maybeStart: consuming stuck for', Math.round(stuckMs / 1000) + 's, force reset');
        __jzCollect.state.consuming = false;
        __jzCollect.state.consumeStartedAt = 0;
      } else {
        return;
      }
    }
    let meta = await _loadQueueMeta();
    if (Date.now() < meta.circuitBreakerUntil) {
      console.log('[Queue] maybeStart: in circuit breaker, skip');
      return;
    }
    // 自动恢复:跨日或熔断过期时,重置 consumePaused,避免队列永久卡死
    // (跨日重置在 _consumeOne 内部,但 _consumeOne 不会被调用,故在此前置恢复)
    if (meta.consumePaused) {
      const today = new Date().toLocaleDateString('en-CA');
      const crossedDay = meta.todayDate !== today;
      const breakerExpired = Date.now() >= meta.circuitBreakerUntil;
      if (crossedDay) {
        __jzCollect.state.completedTodaySkus.clear();
        meta = await _saveQueueMeta({ todayDate: today, consumePaused: false });
        console.log('[Queue] maybeStart: cross-day reset, resume');
      } else if (breakerExpired) {
        meta = await _saveQueueMeta({ consumePaused: false });
        console.log('[Queue] maybeStart: circuit breaker expired, resume');
      } else {
        console.log('[Queue] maybeStart: paused, skip');
        return;
      }
    }
    // Phase 2: peek 用 ERP list(pending)判断是否有待消费任务。
    const peekList = await _erpQueueList('pending', 1, 1);
    const task = peekList?.items?.[0] || null;
    if (!task) return;

    // 尊重配置间隔:SW 被杀后 alarm 唤醒,若距上次消费不足配置间隔,
    // 则 setTimeout 等待剩余时间,避免实际间隔小于用户配置。
    // 用 _getNextConsumeIntervalMs 计算随机间隔(meta 含 min/max 字段)
    const elapsed = Date.now() - (meta.lastConsumeAt || 0);
    const interval = _getNextConsumeIntervalMs(meta);
    if (elapsed < interval) {
      const wait = interval - elapsed;
      console.log('[Queue] maybeStart: respect interval, wait', wait, 'ms');
      __jzCollect.state.nextConsumeAt = Date.now() + wait; // 精确下次执行时间
      setTimeout(() => {
        _consumeOne();
      }, wait);
      return;
    }
    _consumeOne();
  };

  const _checkStaleRunningTasks = () => __jzCollect._checkStaleRunningTasks();
  const _processQueueOp = (op) => __jzCollect._processQueueOp(op);
  const _pollOpsPending = () => __jzCollect._pollOpsPending();
  const _startOpsPolling = () => __jzCollect._startOpsPolling();
  const _stopOpsPolling = () => __jzCollect._stopOpsPolling();
  // _checkAllCachesHit 已迁移到 collect/background/collect-runner.js
  const _checkAllCachesHit = (sku) => __jzCollect._checkAllCachesHit(sku);
  const _handleSubmitTask = (params) => __jzCollect._handleSubmitTask(params);
  const setupCollectQueueAlarm = () => __jzCollect.setupCollectQueueAlarm();

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
    chrome.contextMenus.removeAll(() => { });
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
        } catch { }
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

  // ── QX算价：拉取 CNY→RUB 实时汇率 ──
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
        return `${manifest.name || 'QX'} / Chrome`;
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
    } else if (alarm.name === COLLECT_QUEUE_ALARM) {
      _maybeStartConsume();
      _checkStaleRunningTasks();
      // SW 被杀后 setInterval 会丢失,alarm 唤醒时重启 ops 轮询并兜底拉取一次。
      _startOpsPolling();
      _pollOpsPending().catch((e) => console.warn('[Queue] alarm ops poll error:', e?.message || e));
    }
  });

  chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId.startsWith('follow-sell-fail-')) {
      chrome.action.openPopup().catch(() => { });
      chrome.notifications.clear(notificationId);
    }
  });

  /**
   * Reload all seller.ozon.ru tabs so manifest-declared content_scripts get injected.
   * Needed when the extension loads after the tab is already open (e.g. install/update/startup).
   * 错开 500ms 重载,避免多标签页同时重载 + content script 重新注入导致内存峰值。
   *
   * 防重复:30 秒内不重复触发(扩展重载时 onInstalled + onStartup + syncAuthFromWeb
   * 可能叠加调用,导致 seller 标签页在极短时间内被双重重载)。
   */
  let _lastSellerReloadAt = 0;
  const SELLER_RELOAD_MIN_INTERVAL_MS = 30_000;
  const reloadSellerTabs = async () => {
    const now = Date.now();
    if (now - _lastSellerReloadAt < SELLER_RELOAD_MIN_INTERVAL_MS) {
      console.log(
        `[reloadSellerTabs] skipped (too recent, ${now - _lastSellerReloadAt}ms ago, min=${SELLER_RELOAD_MIN_INTERVAL_MS}ms)`
      );
      return;
    }
    _lastSellerReloadAt = now;
    const tabs = await chrome.tabs.query({ url: OZON_SELLER_ORIGIN + '/*' });
    for (let i = 0; i < tabs.length; i++) {
      setTimeout(() => chrome.tabs.reload(tabs[i].id), i * 500);
    }
    if (tabs.length) console.log(`[reloadSellerTabs] scheduled ${tabs.length} seller tab(s) reload (staggered 500ms)`);
  };

  chrome.runtime.onInstalled.addListener(() => {
    // 同步初始化:alarm 注册 + 上下文初始化(轻量,无网络请求)
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
    setupCollectQueueAlarm();
    // 异步重负载:错开执行,避免重载瞬间并发风暴导致 OOM
    setTimeout(() => checkForUpdate(), 1_000);
    setTimeout(() => refreshExchangeRate(), 2_000);
    setTimeout(() => handleBrowserAgentAlarm(), 3_000);
    setTimeout(() => reloadSellerTabs(), 4_000);
  });

  chrome.runtime.onStartup.addListener(() => {
    setupFollowSellCheckAlarm();
    setupHeartbeatAlarm();
    setupFxAlarm();
    initClientSyncContext();
    initBrowserAgentContext();
    setupClientSyncAlarms();
    setupBrowserAgentAlarm();
    setupCollectQueueAlarm();
    setTimeout(() => refreshExchangeRate(), 1_000);
    setTimeout(() => handleBrowserAgentAlarm(), 2_000);
    setTimeout(() => reloadSellerTabs(), 3_000);
  });

  // SW 冷启动(install/startup 之外的 import 时)也要 init,
  // 因为 chrome 在 SW 唤醒时不会再触发 onStartup。
  initClientSyncContext();
  initBrowserAgentContext();

  // 采集队列冷启动恢复:迁移本地队列到 ERP、初始化今日完成集合、重置卡死任务、同步速率、启动 ops 轮询。
  (async () => {
    try {
      // Phase 2: 先迁移本地队列到 ERP(如果有残留),再从 ERP 初始化状态
      const migration = await _migrateLocalQueueIfNeeded();
      if (migration?.migrated > 0) {
        console.log('[Queue] migrated local queue to ERP:', migration.migrated);
      }
      await _initCompletedTodaySet();
      await _checkStaleRunningTasks();
      await _syncConsumeRateFromConfig();
      _startOpsPolling();
      _maybeStartConsume();
    } catch (e) {
      console.warn('[Queue] startup init failed:', e?.message || e);
    }
  })();

  // SW 被挂起前清理资源(原 IDB 缓存重置已废弃,取消 L1 后无需清理)
  // lease heartbeat timer 由 SW 终止时隐式清理,无需显式处理。
  chrome.runtime.onSuspend.addListener(() => {
    console.log('[SW] onSuspend');
  });

  // tab 关闭时清理采集器心跳记录
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (collectorTabs.has(tabId)) collectorTabs.delete(tabId);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // QX算价：手动重拉汇率（content/jzc-calc.js 走 message.type 路由，
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
            const u = new URL(inputUrl, OZON_WWW_ORIGIN);
            productPath = u.pathname;
          } catch { }
          if (!productPath.startsWith('/product/')) {
            sendResponse({ ok: false, error: 'not a product url' });
            return;
          }
          // 从 path 提取 sku 用于缓存查询(/product/xxx-<sku>/)
          const urlSku = (productPath.match(/-(\d+)\/?$/) || [])[1] || '';

          // forceRefresh=true 时跳过缓存,清 L1+L2 后走真调
          const forceRefresh = !!message?.forceRefresh;
          if (!forceRefresh && urlSku) {
            const cached = await _richMediaCacheGet(urlSku);
            if (cached && cached.fields && cached.widgetStates) {
              sendResponse({
                ok: true,
                data: { fields: cached.fields, widgetStates: cached.widgetStates },
                cached: true,
              });
              return;
            }
          }
          if (forceRefresh && urlSku) {
            _richMediaCacheDelete(urlSku);
          }

          // composer-api page endpoint。SW 直 fetch 反爬必死 403,走 fetchOzonWwwViaTab
          // 通过 sender 的 ozon.ru tab 注入 MAIN world,带用户真实 cookie + fingerprint。
          // (2026-05-26 修复:fetchProductPageState 在采集面板报 "Ozon 403"。)
          const apiUrl = `${OZON_WWW_ORIGIN}/api/composer-api.bx/page/json/v2?url=${encodeURIComponent(productPath)}`;
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
          const sku = String(gallery?.sku || detailSku?.sku || detailSku?.itemId || urlSku || '');
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
          } catch { }
          // brand
          let brandName = '';
          try {
            brandName = brand?.title || brand?.name || '';
          } catch { }
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
          // 异步写 richMedia 缓存(L1 + L2),不阻塞返回。
          // fetchProductPageState 只负责 fields + widgetStates;media 字段
          // (mp4/richContent/description/hashtags/gallery)留空,由 fetchPdpMedia
          // / fetchPdpBundleViaBuyerTab 在富内容采集时回填。
          if (sku) {
            const richMediaData = {
              mp4: null,
              richContent: '',
              richContentHasText: false,
              description: '',
              hashtags: [],
              gallery: [],
              fields,
              widgetStates,
              hitEndpoints: [],
            };
            _richMediaCacheSet(sku, richMediaData);
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
                  }).catch(() => { });
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
                }).catch(() => { });
              })
          );
        } catch (e) {
          try {
            sendResponse({ ok: false, error: e?.message || String(e) });
          } catch { }
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
        case 'syncAllCacheToL2': {
          // 已废弃:取消 L1 IndexedDB 后,所有缓存直接入库 SQLite,无需手动同步。
          // 保留 case 兼容旧 popup,返回空 stats。
          return {
            ok: true,
            data: {
              dom: 0,
              attribute: 0,
              richMedia: 0,
              marketStats: 0,
              followSell: 0,
              migrated: 0,
            },
          };
        }
        case 'domCacheGet': {
          // 查 dom 缓存(L1→L2),用于全览展示 / OPI 预览 fallback / 详情页 DOM 兜底。
          // 入参: { sku, type: 'card'|'detail' }  返回: { ok, data: fields | null }
          // 兼容旧消息: type 省略时按 'card' 处理(老 caller)
          try {
            const sku = String(message.sku || '');
            if (!sku) return { ok: true, data: null };
            const type = message.type === 'detail' ? 'detail' : 'card';
            const data = await _domCacheGet(sku, type);
            return { ok: true, data };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'domCacheSet': {
          // 异步写 dom 缓存(card 或 detail,由 type 参数区分)。
          // 入参: { sku, type: 'card'|'detail', data }  返回: { ok: true }(异步写,不等 L2)
          try {
            const sku = String(message.sku || '');
            const type = message.type === 'detail' ? 'detail' : 'card';
            const data = message.data;
            if (!sku || !data) return { ok: true };
            _domCacheSet(sku, type, data);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'shallowCollectLog': {
          // 浅度采集日志上报:由 ozon-data-panel.js onCardExtracted 回调触发,
          // 每个发现的 SKU 一条。fire-and-forget,不阻塞 content 端采集流程。
          // 入参: { sku, sellerSlug, sellerId, name, price, ratingCount, imageUrl,
          //   passesFilter, skipReason, source }  返回: { ok: true }
          try {
            const payload = message && typeof message === 'object' ? { ...message } : {};
            delete payload.action;
            if (!payload.sku) return { ok: true };
            _writeShallowCollectLog(payload);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'domCacheDelete': {
          // forceRefresh 时清 dom 缓存(同时清 card + detail)。
          try {
            const sku = String(message.sku || '');
            if (sku) _domCacheDelete(sku);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        // ── 旧消息名兼容(content/*.js 旧 caller 未升级前继续可用) ──
        case 'cardCacheGet':
        case 'cardCacheSet':
        case 'cardCacheDelete':
        case 'detailCacheGet':
        case 'detailCacheSet':
        case 'detailCacheDelete': {
          // 路由到新 domCache* 接口,按消息名推断 type
          try {
            const sku = String(message.sku || '');
            if (!sku) return message.action.endsWith('Get') ? { ok: true, data: null } : { ok: true };
            const type = message.action.startsWith('detail') ? 'detail' : 'card';
            if (message.action.endsWith('Get')) {
              const data = await _domCacheGet(sku, type);
              return { ok: true, data };
            } else if (message.action.endsWith('Set')) {
              const data = message.data;
              if (data) _domCacheSet(sku, type, data);
              return { ok: true };
            } else {
              // Delete
              _domCacheDelete(sku);
              return { ok: true };
            }
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'richMediaCacheGet': {
          // 查 richMedia 缓存(L1→L2),用于 content 端 ensurePdpState 兜底 +
          // fetchVariantGallery / fetchPdpBundleViaBuyerTab 缓存优先。
          try {
            const sku = String(message.sku || '');
            if (!sku) return { ok: true, data: null };
            const data = await _richMediaCacheGet(sku);
            return { ok: true, data };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'richMediaCacheSet': {
          // fetchVariantGallery / fetchPdpBundleViaBuyerTab 真调成功后,异步写 richMedia 缓存。
          // 入参: { sku, data }  返回: { ok: true }(异步写,不等 L2)
          try {
            const sku = String(message.sku || '');
            const data = message.data;
            if (!sku || !data) return { ok: true };
            _richMediaCacheSet(sku, data);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'richMediaCacheDelete': {
          // forceRefresh 时清 richMedia 缓存。
          try {
            const sku = String(message.sku || '');
            if (sku) _richMediaCacheDelete(sku);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'marketStatsCacheGet': {
          // 查 marketStats 缓存(L1→L2),返回 { data, fetchedAt, stale } | null。
          // 入参: { sku }  返回: { ok, data: { data, fetchedAt, stale } | null }
          try {
            const sku = String(message.sku || '');
            if (!sku) return { ok: true, data: null };
            const data = await _marketStatsCacheGet(sku);
            return { ok: true, data };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'marketStatsCacheSet': {
          // getMarketStats 真调成功后,异步写 marketStats 缓存。
          // 入参: { sku, data }  返回: { ok: true }(异步写,不等 L2)
          try {
            const sku = String(message.sku || '');
            const data = message.data;
            if (!sku || !data) return { ok: true };
            _marketStatsCacheSet(sku, data);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'marketStatsCacheDelete': {
          // forceRefresh 时清 marketStats 缓存。
          try {
            const sku = String(message.sku || '');
            if (sku) _marketStatsCacheDelete(sku);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'followSellCacheGet': {
          // 查 followSell 缓存(L1→L2),返回 { data, fetchedAt, stale } | null。
          // 入参: { sku }  返回: { ok, data: { data, fetchedAt, stale } | null }
          try {
            const sku = String(message.sku || '');
            if (!sku) return { ok: true, data: null };
            const data = await _followSellCacheGet(sku);
            return { ok: true, data };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'followSellCacheSet': {
          // followSell 预取成功后,异步写 followSell 缓存。
          // 入参: { sku, data }  返回: { ok: true }(异步写,不等 L2)
          try {
            const sku = String(message.sku || '');
            const data = message.data;
            if (!sku || !data) return { ok: true };
            _followSellCacheSet(sku, data);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'followSellCacheDelete': {
          // forceRefresh 时清 followSell 缓存。
          try {
            const sku = String(message.sku || '');
            if (sku) _followSellCacheDelete(sku);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'checkStoreClass':
        case 'checkStoreClassification': {
          // 三层查询店铺中国身份(L1 chrome.storage → L2 MongoDB → 规则引擎)。
          // 入参: { slug, name, companyInfo?, sellerId? }
          // 返回: { ok, data: { isChinese, classifiedBy, sellerId } | null }
          //   sellerId 用于调用方(如 API 直取启动前)获取稳定卖家主键
          try {
            const slug = String(message.slug || '');
            const name = message.name || '';
            const companyInfo = message.companyInfo || null;
            const sellerId = message.sellerId || '';
            if (!slug) return { ok: true, data: null };
            const data = await checkStoreClassification(slug, name, companyInfo, sellerId);
            return { ok: true, data };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'classifyStore': {
          // 人工确认店铺分类:写 L1 + L2(classifiedBy:'manual')。
          // 入参: { slug, name, isChinese, sellerId? }  返回: { ok: true }
          try {
            const slug = String(message.slug || '');
            const name = message.name || '';
            const isChinese = message.isChinese;
            const sellerId = message.sellerId || '';
            if (!slug || isChinese === undefined || isChinese === null) {
              return { ok: false, error: 'missing slug or isChinese' };
            }
            const data = await manualClassifyStore(slug, name, isChinese, sellerId);
            return { ok: true, data };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'reportStoreSku': {
          // panel 加载时上报"发现"关系到 ozon_store_sku 集合。
          // 入参: { sku, sellerId, sellerSlug, sellerName, lastCollectAt?, lastCollectStatus?, lastCollectResults? }
          // 返回: { ok: true }
          try {
            const payload = {
              sku: String(message.sku || ''),
              sellerId: String(message.sellerId || ''),
              sellerSlug: String(message.sellerSlug || ''),
              sellerName: message.sellerName || '',
            };
            if (message.lastCollectAt) payload.lastCollectAt = message.lastCollectAt;
            if (message.lastCollectStatus) payload.lastCollectStatus = message.lastCollectStatus;
            if (Array.isArray(message.lastCollectResults)) payload.lastCollectResults = message.lastCollectResults;
            if (!payload.sku || !payload.sellerId) {
              return { ok: false, error: 'missing sku or sellerId' };
            }
            // fire-and-forget,不阻塞 panel 渲染
            _erpStoreSkuReport(payload);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
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
                    } catch { }
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
                } catch { }
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
        case 'submitTask': {
          // Phase 1+2:前端提交 SKU 到采集队列,立即返回,SW 按 consumeRateMin/MaxSec 串行消费。
          const { sku, sellerSlug, sellerId, domInfo } = message;
          return _handleSubmitTask({ sku, sellerSlug, sellerId, domInfo });
        }
        case 'autoCollectGetConfig': {
          // Task 22:面板读取 autoCollect 配置(白名单字段)。
          const _acCfg = await _loadAutoCollectConfig();
          return {
            ok: true,
            data: {
              enabled: _acCfg.enabled,
              autoCollectRunning: _acCfg.autoCollectRunning,
              shallowCollectRunning: _acCfg.shallowCollectRunning,
              depth: _acCfg.depth,
              paused: _acCfg.paused,
              pausedUntil: _acCfg.pausedUntil,
              buyerPageMinInterval: _acCfg.buyerPageMinInterval,
              sellerPortalMinInterval: _acCfg.sellerPortalMinInterval,
              skuInterval: _acCfg.skuInterval,
              consumeRateMinSec: _acCfg.consumeRateMinSec,
              consumeRateMaxSec: _acCfg.consumeRateMaxSec,
              onlyChineseStores: _acCfg.onlyChineseStores,
              knownChineseSlugs: _acCfg.knownChineseSlugs,
              knownNonChineseSlugs: _acCfg.knownNonChineseSlugs,
            },
          };
        }
        case 'autoCollectSetConfig': {
          // 面板写入 autoCollect 配置(仅白名单字段,内部状态如
          // todayDate/pausedUntil 不允许面板直改)。限速字段(consumeRateMin/MaxSec)
          // 由 popup 调整,旧字段(buyerPageMinInterval 等)保留兼容。
          const _acUpdates = message.config || message;
          const _acAllowed = [
            'enabled',
            'autoCollectRunning',
            'shallowCollectRunning',
            'paused',
            'depth',
            'buyerPageMinInterval',
            'sellerPortalMinInterval',
            'skuInterval',
            'consumeRateMinSec',
            'consumeRateMaxSec',
            'onlyChineseStores',
            'knownChineseSlugs',
            'knownNonChineseSlugs',
          ];
          const _acFiltered = {};
          for (const _k of _acAllowed) {
            if (_acUpdates[_k] !== undefined) _acFiltered[_k] = _acUpdates[_k];
          }
          await _saveAutoCollectConfig(_acFiltered);
          // 限速字段变更同步到队列 meta(仅 consumeRateMinSec/consumeRateMaxSec)
          if (_acFiltered.consumeRateMinSec != null && _acFiltered.consumeRateMaxSec != null) {
            let _lo = Math.max(5, Math.min(120, Math.round(_acFiltered.consumeRateMinSec)));
            let _hi = Math.max(5, Math.min(120, Math.round(_acFiltered.consumeRateMaxSec)));
            if (_lo > _hi) { const _t = _lo; _lo = _hi; _hi = _t; }
            await _saveQueueMeta({
              consumeRateMinSec: _lo,
              consumeRateMaxSec: _hi,
            });
          }
          // 深度采集开关开启 / 手动解除 paused 时,需重置 consumePaused 并触发消费。
          // 否则队列会卡死:之前因 not-running/paused 被设为 consumePaused=true,
          // _maybeStartConsume 只在跨天/熔断过期时才重置,用户开启开关后队列不会自动恢复。
          const _shouldResume =
            (_acFiltered.autoCollectRunning === true || _acFiltered.paused === false) &&
            !_acFiltered.paused;
          if (_shouldResume) {
            const _resumeMeta = await _loadQueueMeta();
            if (_resumeMeta.consumePaused) {
              await _saveQueueMeta({ consumePaused: false });
              console.log('[Queue] autoCollectSetConfig: consumePaused reset (深度采集开启或 paused 解除)');
            }
            sw.maybeStartConsume();
          }
          // 推送 configChanged 通知面板/popup(fire-and-forget,无监听者不报错)
          chrome.runtime.sendMessage({ type: 'configChanged', config: _acFiltered }).catch(() => { });
          return { ok: true };
        }
        case 'autoCollectGetRecent': {
          // Task 22:面板读取最近 N 条采集记录(环形缓冲,默认 5 条,倒序)。
          const _acLimit = message.limit || 5;
          return { ok: true, data: __jzCollect.getAutoCollectRecent(_acLimit) };
        }
        case 'getQueueStatus': {
          // content script 启动时主动查询队列状态,防止 queuePaused 广播时序竞态
          // (SW 在 content script 注入完成前广播,onMessage listener 未注册导致错过)。
          const _qsMeta = await _loadQueueMeta();
          const _qsCfg = await _loadAutoCollectConfig();
          const _inCircuitBreaker = Date.now() < _qsMeta.circuitBreakerUntil;
          let _qsReason = null;
          // 熔断优先级最高(独立于 consumePaused,熔断期 consumePaused 可能为 false)
          if (_inCircuitBreaker) {
            _qsReason = 'antibot';
          } else if (_qsMeta.consumePaused) {
            if (!_qsCfg.autoCollectRunning) _qsReason = 'not-running';
            else if (_qsCfg.paused && Date.now() < _qsCfg.pausedUntil) _qsReason = 'paused';
            else _qsReason = 'paused';
          }
          return {
            ok: true,
            data: {
              consumePaused: _qsMeta.consumePaused || _inCircuitBreaker,
              reason: _qsReason,
              autoCollectRunning: _qsCfg.autoCollectRunning,
              paused: _qsCfg.paused,
              pausedUntil: _qsCfg.pausedUntil,
              circuitBreakerUntil: _qsMeta.circuitBreakerUntil,
            },
          };
        }
        case 'debugRichMediaCache': {
          const dSku = message.sku || '';
          if (!dSku) return { ok: false, error: 'sku required' };
          let dRm = null;
          try {
            dRm = await _richMediaCacheGet(dSku);
          } catch (e) {
            dRm = { error: e?.message || e };
          }
          return {
            ok: true,
            data: {
              richMedia: dRm
                ? {
                  has: true,
                  keys: Object.keys(dRm),
                  hasFields: !!dRm.fields,
                  hasWidgetStates: !!dRm.widgetStates,
                  widgetStateKeys: dRm.widgetStates ? Object.keys(dRm.widgetStates).slice(0, 10) : [],
                  richContentLen: (dRm.richContent || '').length,
                  descriptionLen: (dRm.description || '').length,
                  hasMp4: !!dRm.mp4,
                  hashtagsCount: Array.isArray(dRm.hashtags) ? dRm.hashtags.length : 0,
                  galleryCount: Array.isArray(dRm.gallery) ? dRm.gallery.length : 0,
                  hitEndpoints: Array.isArray(dRm.hitEndpoints) ? dRm.hitEndpoints : [],
                }
                : { has: false },
              buildVersion: '20260717-rich-media-cache',
            },
          };
        }
        case 'autoCollectForceRefreshPage': {
          // Task 22:面板强制刷新当前页 → 向当前 tab 发 __jzAutoCollectResetSeen
          // 清空 shared-utils 维护的去重集合,让页面已见 SKU 重新触发采集。
          const _acTabId = sender.tab?.id;
          if (_acTabId) {
            chrome.tabs.sendMessage(_acTabId, { type: '__jzAutoCollectResetSeen' }).catch(() => { });
          }
          return { ok: true };
        }
        case 'getMarketStats': {
          // 缓存感知改造:真调前先查 marketStats 缓存(L1→L2),命中且未 stale 直接返回。
          // 未命中 / stale → 调 _fetchMarketStatsDirect(seller tab 注入 data/v3 + 归一化)。
          // __needSellerLogin → proxyMarketData 代采降级(保留原有降级,noProxy 防递归)。
          // __antibot → 返回反爬信号。成功 → 写缓存后返回。null → NO_DATA。
          // 熔断期:只查 cache(接受 stale 兜底),不真调 seller tab
          const mSku = message.sku;
          if (!mSku) return { ok: true, data: null };
          const mPeriod = message.period === 'weekly' ? 'weekly' : 'monthly';
          const cb = await _isCircuitBreakerActive();
          try {
            // ── L1→L2 缓存优先 ──
            const cached = await _marketStatsCacheGet(mSku);
            // 正常路径:未 stale 的缓存直接返回
            if (cached && !cached.stale && cached.data) {
              return { ok: true, data: cached.data };
            }
            // 熔断期:不再真调 seller tab。
            // 有 stale 缓存时返回 stale 数据兜底(优于无数据);否则返 antibot 信号
            if (cb.active) {
              if (cached && cached.data) {
                return { ok: true, data: cached.data };
              }
              return { ok: true, data: { __antibot: true, __reason: 'CIRCUIT_BREAKER', remainingMs: cb.remainingMs } };
            }
            // ── 缓存未命中 / stale → 直调 ──
            const result = await _fetchMarketStatsDirect(mSku, mPeriod);
            if (result?.__needSellerLogin) {
              // 代采降级:noProxy 防递归(代采执行方本身已登录,直接返需登录)
              if (!message.noProxy) {
                const proxied = await proxyMarketData(backendUrl, token, storeId, mSku, mPeriod);
                if (proxied) return proxied; // 代采成功({ ok, data })
              }
              return { ok: true, data: { __needSellerLogin: true, __reason: result.__reason || 'AUTH_REQUIRED' } };
            }
            if (result?.__antibot) {
              // 反爬:有 stale 缓存时返回 stale 数据兜底,否则返 antibot 信号
              if (cached && cached.data) {
                return { ok: true, data: cached.data };
              }
              return { ok: true, data: { __antibot: true } };
            }
            if (result) {
              // HTTP 200 即写缓存(L1+L2)后返回(包括 __empty 空数据)
              _marketStatsCacheSet(mSku, result);
              return { ok: true, data: result };
            }
            // null:临时性失败(注入异常等)
            return { ok: true, data: null };
          } catch (e) {
            console.log('[getMarketStats] failed:', e?.message || e);
            return { ok: true, data: null };
          }
        }
        case 'queryErpProductData': {
          // 队列架构:从 ERP 查询已采集的完整数据(数据卡进视口时兜底)。
          // 改造:ERP 无任务结果时,主动查 SW 缓存(stats/market/variant/followCount)
          // 组装成 preFetched 返回,让面板进入视口时立即显示缓存数据,
          // 不再空骨架等 collectDone 广播(采集未完成也能显示已有缓存)。
          const qSku = message.sku;
          if (!qSku) return { ok: true, data: null };
          try {
            const doc = await apiRequest(
              'GET',
              `${backendUrl}/admin/api/collect-queue/${encodeURIComponent(qSku)}`,
              null,
              token
            );
            // apiRequest 返回 { ok, data },data = MongoDB 任务文档(含 result 字段)
            const taskData = doc?.data || doc;
            if (taskData && taskData.result) {
              // 任务已完成:返回完整快照(与 collectDone 广播的 msg.data 结构一致)
              return { ok: true, data: { preFetched: taskData.result } };
            }
            // 任务未完成 / 不存在:主动查 SW 缓存,组装 preFetched。
            // _buildCollectDoneData 并行查 stats(ERP 后端)/ market(SW 缓存)/
            // variant(IDB+ERP cache)/ followCount(SW 缓存),均为安全查询不开 Ozon tab。
            const preFetched = await _buildCollectDoneData(qSku, null);
            const hasData =
              preFetched.stats?.value ||
              preFetched.market?.value ||
              preFetched.variant?.value ||
              preFetched.followCount?.value;
            // 全 null 时不返回(保持空骨架,等 collectDone 广播回填)
            return { ok: true, data: hasData ? { preFetched } : null };
          } catch (e) {
            return { ok: true, data: null };
          }
        }
        case 'queryCacheStatus': {
          // 查询 7 类缓存命中状态(供数据面板状态条展示,不查采集队列)
          // 返回 { results: [{ type, hit }], hitCount, total }
          // 复用 _queryCacheStatusOne(含 inflight 去重)
          const qSku = message.sku;
          if (!qSku) return { ok: true, data: null };
          try {
            let p = _cacheStatusInflight.get(qSku);
            if (!p) {
              p = _queryCacheStatusOne(qSku).finally(() => _cacheStatusInflight.delete(qSku));
              _cacheStatusInflight.set(qSku, p);
            }
            return { ok: true, data: await p };
          } catch (e) {
            return { ok: true, data: null };
          }
        }
        case 'queryErpProductDataBatch': {
          // 批量查询采集结果(视口内多 SKU 一次性查)
          // 统一走 _buildCollectDoneData 查 SW + ERP 缓存,不再查 collect-queue 集合。
          // 缓存写入是采集流程的副产物,查缓存即查"采集是否完成 + 数据是否就绪"。
          const skus = Array.isArray(message.skus) ? message.skus.filter(Boolean) : [];
          if (!skus.length) return { ok: true, data: {} };
          try {
            const entries = await Promise.all(
              skus.map(async (sku) => {
                try {
                  const inflight = _erpQueryInflight.get(sku);
                  if (inflight) return [sku, await inflight];
                  const p = _buildCollectDoneData(sku, null).finally(() => _erpQueryInflight.delete(sku));
                  _erpQueryInflight.set(sku, p);
                  const preFetched = await p;
                  const hasData =
                    preFetched?.stats?.value ||
                    preFetched?.market?.value ||
                    preFetched?.variant?.value ||
                    preFetched?.followCount?.value;
                  return [sku, hasData ? { preFetched } : null];
                } catch {
                  return [sku, null];
                }
              })
            );
            const result = {};
            for (const [sku, data] of entries) result[sku] = data;
            return { ok: true, data: result };
          } catch {
            const result = {};
            for (const sku of skus) result[sku] = null;
            return { ok: true, data: result };
          }
        }
        case 'queryCacheStatusBatch': {
          // 批量查询 5 类缓存命中状态(视口内多 SKU 一次性查)
          // v1:对每个 SKU 调 _queryCacheStatusOne(7 路 HTTP/SKU,含 dom/attribute 重复),N×7 次 HTTP。
          // v2:走后端 POST /ozon/cache/status-batch,1 次 HTTP 查所有 SKU × 5 类命中位矩阵。
          // 兜底:接口失败 → 退回 v1 单 SKU 调用(保留 inflight 去重)。
          const skus = Array.isArray(message.skus) ? message.skus.filter(Boolean) : [];
          if (!skus.length) return { ok: true, data: {} };
          try {
            const batchResult = await _batchCacheStatus(skus);
            if (batchResult) {
              // 后端返回 { [sku]: { dom, attribute, richMedia, marketStats, followSell } }
              // 转成 _queryCacheStatusOne 一致的 { results, hitCount, total } 形状
              const data = {};
              for (const sku of skus) {
                const r = batchResult[sku];
                if (!r) {
                  data[sku] = null;
                  continue;
                }
                const results = [
                  { type: 'dom', hit: !!r.dom },
                  { type: 'attribute', hit: !!r.attribute },
                  { type: 'richMedia', hit: !!r.richMedia },
                  { type: 'marketStats', hit: !!r.marketStats },
                  { type: 'followSell', hit: !!r.followSell },
                ];
                const hitCount = results.filter((x) => x.hit).length;
                data[sku] = { results, hitCount, total: results.length };
              }
              return { ok: true, data };
            }
            // 兜底:批量接口失败 → 单 SKU 并行查(旧逻辑,保留 inflight 去重)
            console.warn('[sw] cache status-batch failed, fallback to per-sku');
            const entries = await Promise.all(
              skus.map(async (sku) => {
                try {
                  let p = _cacheStatusInflight.get(sku);
                  if (!p) {
                    p = _queryCacheStatusOne(sku).finally(() => _cacheStatusInflight.delete(sku));
                    _cacheStatusInflight.set(sku, p);
                  }
                  return [sku, await p];
                } catch {
                  return [sku, null];
                }
              })
            );
            return { ok: true, data: Object.fromEntries(entries) };
          } catch {
            const result = {};
            for (const sku of skus) result[sku] = null;
            return { ok: true, data: result };
          }
        }
        case 'getCollectManagerState': {
          // 采集队列监控页:查询队列当前状态(running SKU + 进度计数 + 暂停状态 + 每 SKU 详细状态)
          // Phase 2: 从 ERP 读取队列(ERP 是真相源),本地 meta 只提供 consumePaused/circuitBreaker/todayCount
          const _cmsMeta = await _loadQueueMeta();
          const _cmsCfg = await _loadAutoCollectConfig();
          const _cmsStats = await _erpQueueStats();
          const _cmsList = await _erpQueueList(null, 1, 200); // 所有状态,最多 200 条
          const _cmsQueue = _cmsList?.items || [];
          const byStatus = _cmsStats?.byStatus || {};
          // 单独查询 running 状态任务:
          // 统一列表(createdAt DESC)在 pending 任务很多时(>200)会把 running 任务挤到列表外,
          // 导致 runningSkus/runningTasks 永远为空(渲染异常)。
          // running 任务通常很少(<10),单独查一次保证拿到。
          let _runningTasks = _cmsQueue.filter((t) => t.status === 'running');
          if (byStatus.running > 0 && _runningTasks.length === 0) {
            try {
              const _rList = await _erpQueueList('running', 1, 50);
              _runningTasks = (_rList?.items || []).filter((t) => t.status === 'running');
            } catch (_) {
              /* 单独查询失败时回退到统一列表(可能为空) */
            }
          }
          const running = _runningTasks;
          // 合并 running 任务到统一列表(避免 200 条 pending 把 running 挤出导致
          // 监控页"窗口视图"中间槽为空)。去重:已存在则替换,否则前插。
          const runningSkus = new Set(running.map((t) => t.sku));
          const mergedQueue = [...running, ..._cmsQueue.filter((t) => !runningSkus.has(t.sku))];

          // 补充最近完成的任务(供监控页"窗口视图"右侧槽展示):
          // 统一列表(createdAt DESC)在 pending 任务很多时(>200)会把 finished 任务挤到列表外,
          // 或者列表里的 finished 是按 createdAt 排序的(不是 finishedAt),导致右侧显示的不是
          // 最近完成的任务。总是单独查最近的 5 条已完成任务(按 finishedAt DESC)并合并。
          // 注:DAO 的 SORT_ALLOWED 已支持 finishedAt,可直接用 finishedAt:desc 排序。
          let _recentFinished = [];
          try {
            const _fList1 = await _erpQueueList('success', 1, 5, 'finishedAt:desc');
            const _fList2 = await _erpQueueList('skipped', 1, 5, 'finishedAt:desc');
            const _fItems = [...(_fList1?.items || []), ...(_fList2?.items || [])];
            _recentFinished = _fItems
              .sort((a, b) => new Date(b.finishedAt || 0).getTime() - new Date(a.finishedAt || 0).getTime())
              .slice(0, 5);
          } catch (_) {
            /* 查询失败时回退到统一列表 */
          }
          // 合并 finished 任务到 mergedQueue(去重)
          const _existingSkus = new Set(mergedQueue.map((t) => t.sku));
          const _finishedToAdd = _recentFinished.filter((t) => !_existingSkus.has(t.sku));
          let finalQueue = [...mergedQueue, ..._finishedToAdd];

          // 补充最早的 pending 任务(供监控页"窗口视图"左侧槽展示"即将采集"):
          // ERP claim 是 ORDER BY createdAt ASC(最早创建的先采集),但统一列表是
          // createdAt DESC LIMIT 200(最新 200 条)。当 pending > 200 时,最早的 pending
          // (真正下一个要采集的)不在列表里,导致窗口视图左侧显示的是最新创建的 pending
          // 而非即将采集的。
          // 注:不能用 _pendingInList.length < 5 判断,因为 200 条列表里大部分是 pending
          // (pending 占多数),_pendingInList.length ≈ 200 远大于 5,条件永远 false。
          // 正确做法:总是单独查最早的 5 条 pending(createdAt:asc)并合并,确保窗口
          // 视图左侧能拿到真正即将采集的任务。
          try {
            const _earliestPending = await _erpQueueList('pending', 1, 5, 'createdAt:asc');
            const _epItems = (_earliestPending?.items || []).filter(
              (t) => !_existingSkus.has(t.sku)
            );
            finalQueue = [...finalQueue, ..._epItems];
          } catch (_) {
            /* 查询失败时回退到统一列表 */
          }

          // 返回每个 SKU 的详细状态(供表格按 SKU 更新 status/finishedAt)
          // domInfo 由入队时从店铺卡片写入:{title, price, imageUrl, ratingCount}
          const tasks = finalQueue.map((t) => ({
            sku: t.sku,
            status: t.status,
            source: t.source || 'shop-page',
            sellerSlug: t.sellerSlug || '',
            sellerId: t.sellerId || '',
            startedAt: t.startedAt || null,
            finishedAt: t.finishedAt || null,
            createdAt: t.createdAt || null,
            attempts: t.attempts || 0,
            lastError: t.lastError || null,
            domInfo: t.domInfo || null,
          }));
          // 正在采集任务的富信息(供监控页展示商品图片/价格/标题等)
          // domInfo 由入队时从店铺卡片写入:{title, price, imageUrl, ratingCount}
          const runningTasks = running.map((t) => ({
            sku: t.sku,
            sellerSlug: t.sellerSlug || '',
            sellerId: t.sellerId || '',
            startedAt: t.startedAt || null,
            domInfo: t.domInfo || null,
          }));
          return {
            ok: true,
            data: {
              runningSkus: running.map((t) => t.sku),
              runningTasks,
              pendingCount: byStatus.pending || 0,
              // ERP 终态:success/skipped(partial 非终态,回 pending 重试)
              finishedCount:
                (byStatus.success || 0) + (byStatus.skipped || 0),
              totalCount: _cmsStats?.total || _cmsQueue.length,
              consumePaused: _cmsMeta.consumePaused,
              circuitBreakerUntil: _cmsMeta.circuitBreakerUntil,
              autoCollectRunning: _cmsCfg.autoCollectRunning,
              shallowCollectRunning: _cmsCfg.shallowCollectRunning,
              lastConsumeAt: _cmsMeta.lastConsumeAt || 0,
              consumeRateMinSec: _cmsMeta.consumeRateMinSec ?? 5,
              consumeRateMaxSec: _cmsMeta.consumeRateMaxSec ?? 15,
              // 诊断字段:SW 内存消费状态,用于判断队列是否真的在消费
              // consuming=true 且 consumeStartedAt 很久未变 → 卡死;
              // consuming=true 且 consumeStartedAt 近期 → 正在采集;
              // consuming=false 且有 pending → alarm 未触发或间隔等待中
              consuming: __jzCollect.state.consuming,
              consumeStartedAt: __jzCollect.state.consumeStartedAt || 0,
              // SW 内 setTimeout 调度的精确下次执行时间戳(0 = 无调度/SW 刚重启)
              nextConsumeAt: __jzCollect.state.nextConsumeAt || 0,
              tasks,
            },
          };
        }
        case 'removeQueueTask': {
          // 采集队列监控页:删除单个队列任务(按 SKU)
          // Phase 2: 委托 ERP delete 接口(ERP 是真相源)
          try {
            await _erpQueueDelete(String(message.sku));
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'clearFinishedQueueTasks': {
          // 采集队列监控页:清空所有已完成任务
          // Phase 2: 委托 ERP clear-terminal 接口(ERP 是真相源)
          try {
            const removed = await _erpQueueClearTerminal();
            console.log('[Queue] cleared terminal tasks via ERP:', removed);
            return { ok: true, data: { removed } };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
          }
        }
        case 'clearAntibotState': {
          // 采集队列监控页:强制清除反爬熔断状态
          // 重置:circuitBreakerUntil=0, consumePaused=false, config.paused=false/pausedUntil=0
          try {
            await _saveQueueMeta({ circuitBreakerUntil: 0, consumePaused: false });
            await _saveAutoCollectConfig({ paused: false, pausedUntil: 0 });
            console.log('[Queue] antibot state cleared by user');
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e?.message || String(e) };
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
          // CNY→RUB 实时汇率（复用「QX算价」的 FX 缓存 jz_calc_fx_rate_v1）。
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
          // 熔断期:只查 cache(富内容/描述/标签),不真调 buyer tab;无 mp4 则跳过视频转存
          const _cb = await _isCircuitBreakerActive();
          try {
            const media = await fetchPdpBundleViaBuyerTab(message.url, { cacheOnly: _cb.active });
            const richContent = media.richContent || '';
            const description = media.description || '';
            const hashtags = Array.isArray(media.hashtags) ? media.hashtags : [];
            const endpoint = media.endpoint || null;
            if (!media.mp4) return { ok: true, data: { url: null, richContent, description, hashtags, endpoint } };
            // 熔断期不开 seller tab 转存视频,只返回 cache 中的富内容
            if (_cb.active) return { ok: true, data: { url: null, richContent, description, hashtags, endpoint } };
            const r = await transferVideoToOzon(media.mp4);
            return { ok: true, data: { url: r.ok ? r.url : null, richContent, description, hashtags, endpoint } };
          } catch (e) {
            return { ok: true, data: { url: null, richContent: '', description: '', hashtags: [], endpoint: null } };
          }
        }
        case 'fetchVariantRichContent': {
          // batch-upload 逐 SKU 用(视频转存关闭时的源内容独立通道):借买家 tab 拉 PDP page
          // json,抽源富内容(11254)+ 描述(4191)+ 主题标签(23171),纯读不写(无 upload-file 门户请求)。
          // 抓不到 / 失败 → ok:true + 空值(best-effort,不阻断上架)。
          // 熔断期:只查 cache,不真调 buyer tab
          const _cb = await _isCircuitBreakerActive();
          try {
            const media = await fetchPdpBundleViaBuyerTab(message.url, { cacheOnly: _cb.active });
            return {
              ok: true,
              data: {
                richContent: media.richContent || '',
                description: media.description || '',
                hashtags: Array.isArray(media.hashtags) ? media.hashtags : [],
                endpoint: media.endpoint || null,
              },
            };
          } catch (e) {
            return { ok: true, data: { richContent: '', description: '', hashtags: [], endpoint: null } };
          }
        }
        case 'searchVariants': {
          const sku = message.sku;
          const forceRefresh = Boolean(message.forceRefresh);
          // 跟卖时用户本就在 www 商品页 → 用来源标签走跨域快路,免依赖 seller 专用标签
          const senderTabId = sender?.tab?.id || null;
          // 熔断期检查:反爬触发后不再开 seller tab,直接返 antibot 信号
          if ((await _isCircuitBreakerActive()).active) {
            return { ok: false, error: 'ANTIBOT_BLOCKED', message: '反爬熔断中,请稍后再试' };
          }
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
            return {
              ok: false,
              error: 'AUTH_REQUIRED',
              message: 'sc_company_id cookie 未找到，请先登录 seller.ozon.ru',
            };
          }

          const MAX_RETRIES = 2;
          // search 缓存查询(三层:L1 IndexedDB → L2 ERP SQLite → L3 真调)
          // 命中后跳过 /search 真调,直接用缓存 items 进入 Step 2(bundle 有自己的缓存)
          // v8: search/bundle 合并到 attribute_cache,通过 attributeCacheGet('search') 查询
          let searchCacheHit = null; // { items } | null
          if (!forceRefresh) {
            try {
              const cached = await _attributeCacheGet(sku, 'search');
              if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
                console.log(`[searchVariants] search cache hit sku=${sku}`);
                searchCacheHit = cached;
              }
            } catch (e) {
              console.warn(`[searchVariants] search cache get failed:`, e?.message || e);
            }
          } else {
            // forceRefresh → 清整条 attribute 记录(search + bundle 都清,下次都重新拉)
            _attributeCacheDelete(sku);
          }

          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              let items;
              if (searchCacheHit) {
                // 缓存命中 → 跳过 /search 真调
                // 方案B:cache 存的是 Ozon /api/v1/search 原始 variants,读取时调
                // normalizeSearchVariantToSv 合成 sv shape(运行时合成,不写回 cache)
                items = searchCacheHit.items.map(normalizeSearchVariantToSv).filter(Boolean);
              } else {
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
                // 方案B:cache 只存原始 variants,不做 normalize 转换
                if (rawVariants.length === 0) {
                  if (attempt === 1) {
                    console.log(
                      `[searchVariants] sku=${sku} no variants from /search, raw:`,
                      JSON.stringify(resp).slice(0, 400)
                    );
                  }
                  return { ok: true, data: { items: [] } };
                }
                if (attempt === 1) {
                  // v8: 写入 attribute_cache 的 search 字段(原始 variants,不转换)
                  _attributeCacheSet(sku, 'search', { items: rawVariants });
                }
                // 运行时合成 sv shape 给 sender(即时消费,不写回 cache)
                items = rawVariants.map(normalizeSearchVariantToSv).filter(Boolean);
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

              // Step2 bundle merge 完成后不再覆盖写 search_cache(方案B)。
              // search cache 始终保持 Ozon /api/v1/search 原始 variants,读取端按需合成。
              // bundle 数据由 bundle cache 独立存储(见 fetchBundleByVariantId)。
              // 运行时 items(含 merge 后的物理 attrs / _bundleItem / _bundleComplexAttrs)
              // 仅返回给 sender 即时消费,不写回 cache。

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
          // 转发上报到QX后端入库。失败仅 console，不阻塞任何用户操作。
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
      chrome.runtime.getPlatformInfo(() => { });
      keepAliveTimer = setInterval(() => {
        chrome.runtime.getPlatformInfo(() => { });
      }, 15_000);
    }

    // Handler 顶层 race timeout — 防止内部 await 永不返(executeScript hang /
    // promise leak)导致 handle() 永远 pending,sendResponse 永不调,content 等死。
    // 默认 50s(留 10s buffer 给 content wrapper 的 60s)。视频转存例外:download 跨源 .mp4 +
    // media-storage 上传跑在 seller/buyer tab,executeScript 内部就排到 90s+(transferVariantVideo
    // 还叠加买家 tab 抓图册 40s),50s 会把**正常但慢**的转存误杀。给它们 160s 上限,并配合
    // content LONG_ACTIONS 把这俩 action 的 content 侧超时也放宽到 600s。
    // Phase 1+2:旧 autoCollect 改为 submitTask 入队,handler 快速返回,不再需长超时。
    const LONG_HANDLER_ACTIONS = new Set(['uploadFollowSellVideo', 'transferVariantVideo']);
    const HANDLER_TOTAL_TIMEOUT_MS = LONG_HANDLER_ACTIONS.has(message?.action) ? 300_000 : 50_000;
    let raceTimer = null;
    const handlerPromise = Promise.race([
      handle(),
      new Promise((_, reject) => {
        raceTimer = setTimeout(
          () => reject(new Error(`SW handler ${message?.action} 总超时 (${HANDLER_TOTAL_TIMEOUT_MS / 1000}s)`)),
          HANDLER_TOTAL_TIMEOUT_MS
        );
      }),
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
        if (raceTimer) clearTimeout(raceTimer);
      });

    return true;
  });
})();
