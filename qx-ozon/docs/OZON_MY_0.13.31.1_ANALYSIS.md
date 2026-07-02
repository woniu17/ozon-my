# ozon-my-0.13.31.1 框架功能文档

> 本文档基于对 `ozon-my-0.13.31.1/` 全部源码的只读分析整理，覆盖 manifest、background、content、lib、popup、batch-upload、tests 各模块，作为框架功能参考与隐患备忘。

---

## 一、项目定位

**MY 扩展** —— 橘子 ERP（jizhangerp）的 Chrome MV3 卖家助手，主要面向 Ozon 平台的跟卖 / 采集 / 批量上架，并扩展到 1688、JD、PDD、Taobao、Amazon、Wildberries、Temu、MercadoLibre、Yandex、Shein 共 9 个中国 / 海外货源平台。

- `manifest_version: 3`，name / version 均为占位 `MY / 0.13.31.1`，由 build.js 注入品牌（`__JZ_BRAND__`、`__BRAND_WEB_HOST__`、`__BRAND_DISPLAY_NAME__`）
- `update_url: https://api.jizhangerp.com/extension/updates/my/manifest.xml`（自托管更新）
- 权限：`storage / contextMenus / alarms / cookies / scripting / notifications / unlimitedStorage`
- host_permissions 覆盖 Ozon（.ru / .kz）、jizhangerp.com、localhost:3000、1688、各大电商站
- 生产构建后端单一候选 `https://api.jizhangerp.com`；dev 双候选 `['http://localhost:3001', 'https://api.jizhangerp.com']`，用 `GET /health` 探活（刻意避开老版本用过的 `/auth/captcha`，避免装机基数 × SW 醒睡循环造成 11 req/s 洪水）

---

## 二、目录结构

```
ozon-my-0.13.31.1/
├── manifest.json
├── background/
│   ├── service-worker.js          (4103 行，69 action 路由)
│   ├── agent/                     (浏览器 Agent 远程任务执行器)
│   │   ├── actions.js             (handler / dynamicCapability 注册表)
│   │   ├── agent-runtime.js       (tick / claim / 状态机 / 1h 冷却)
│   │   ├── collect-actions.js     (4 action + seller_collect 动态能力)
│   │   └── listing-actions.js     (create_draft / publish_draft)
│   ├── sync/                      (客户端驱动 OPI 同步引擎)
│   │   ├── sync-engine.js         (runRound / 三类同步)
│   │   ├── sync-state.js          (cred / lease 缓存)
│   │   ├── lease-client.js        (租约 acquire / heartbeat / release)
│   │   ├── diff-index.js          (256 分片 contentHash)
│   │   ├── opi-client.js          (api-seller.ozon.ru 直连)
│   │   └── backend-client.js      (jizhangerp 后端 wrapper)
│   └── __tests__/                 (agent-actions / dedupe 冒烟)
├── content/                       (注入各页面的脚本)
│   ├── collector/                 (核心采集器：task-queue / auto-scroller / keyword-pilot / anti-ban / db / l1-shadow-db / l1-bridge / l1-diff / panel)
│   ├── ozon-bff-interceptor.js    (MAIN world fetch / XHR hook)
│   ├── ozon-product.js            (497KB 商品页主入口)
│   ├── ozon-search.js / ozon-data-panel.js / ozon-seller-bridge.js
│   ├── ozon-bestsellers-hook.js / ozon-premium-hook.js  (MAIN world)
│   ├── 1688-*.js / alibaba-1688.js / cn-source-product.js
│   ├── jizhangerp-bridge.js / jzc-calc.js / sync-auth.js
│   └── shared-utils.js            (157KB 全局工具)
├── lib/                           (14 个 IIFE 工具，双导出 window.JZ* + module.exports)
│   ├── cn-source-scraper.js       (9 平台统一采集器 1625 行)
│   ├── sku-collect.js / v3-payload.js / quick-list-parser.js
│   ├── title-quality.js / follow-sell-content-copy.js
│   ├── store-picker.js / watermark-templates.js / ozon-video-extract.js
│   ├── sidebar-section-toggle.js / cdn-buster.js
│   └── cn-source-panel.js / cn-source-debug-page.js
├── popup/                         (主弹窗：login + signals + collector-mon + browser-agent)
├── batch-upload/                  (独立窗口批量上架编排)
└── tests/                         (8 个测试，无框架，node 直跑 + Playwright)
```

---

## 三、三层架构

```
┌─────────────────────────────────────────────────────────────┐
│  popup / batch-upload  (UI 入口)                            │
│   ├─ chrome.runtime.sendMessage({action,...})               │
│   └─ batch-upload: 多店扇出 + 反爬熔断 + AI 增强 + 超时兜底  │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  background/service-worker.js  (MV3 SW)                     │
│   ├─ 69 个 action 路由 (鉴权 / 采集 / 跟卖 / 会员 / AI / 同步 / Agent) │
│   ├─ alarms: update(4h) / follow-sell(5m) / heartbeat(5m)   │
│   │         fx(24h) / client-sync(5 / 30 / 360m) / agent(1m)│
│   ├─ 跨域策略: fetchSellerViaOzonTab(快路) → seller-tab →   │
│   │           bridge fallback，200ms 全局闸门防反爬          │
│   ├─ 代采透明回退: 本机未登 seller → 派单 backend 任务池    │
│   ├─ sync/ : PRODUCTS(diff hash) / POSTINGS / WAREHOUSES    │
│   │         带 lease(三层续期) + 256 分片 diff-index        │
│   └─ agent/ : 远程任务执行器，从 backend claim job 本地跑   │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  content scripts  (MAIN + ISOLATED 双世界)                  │
│   ├─ MAIN world: ozon-bff-interceptor / 1688-page-data-hook │
│   │              / bestsellers-hook / premium-hook          │
│   │              (hook fetch / XHR / JSON.parse / Response.json) │
│   ├─ ISOLATED: collector 全套 + ozon-product / search / ... │
│   │           1688 采集器 / cn-source / jzc-calc / 桥接     │
│   └─ 双向通信: postMessage(跨世界) + sendMessage(→SW)      │
└──────────────────────────────────────────────────────────────┘
```

### 跨世界通信链路

```
MAIN world (无 chrome.* API,但可读 window 全局)
  ozon-bff-interceptor.js ──postMessage(JZC_OZON_COMPOSER_RESPONSE)──┐
  1688-page-data-hook.js ────postMessage(JZC_1688_PAGE_DATA)────────┐│
  ozon-bestsellers-hook.js ──postMessage(JZC_BESTSELLERS_REPORT)───┐││
  ozon-premium-hook.js ──────postMessage(JZC_PREMIUM_QUERY/...)────┐│││
                              window.postMessage (双向)            ▼│││
ISOLATED world (有 chrome.runtime / storage / cookies API)
  l1-bridge.js        ◄── 接收 BFF 响应 → 本地写 + batch 转发 SW
  alibaba-1688.js     ◄── 接收 1688 window globals
  ozon-seller-bridge  ◄── 接收 bestsellers / premium
                              │
                              ▼
background service-worker.js (有 chrome.cookies / all_frames)
  onMessage → 后端 API / seller.ozon.ru 门户 / www.ozon.ru 买家页
```

---

## 四、核心能力清单

### 4.1 采集（多源统一）

- **9 平台采集器**（`lib/cn-source-scraper.js`）：`detectPlatform` + `buildPayload`，配置驱动 9 套 `PLATFORM_CONFIGS`，标准化输出 `{productId, title, price, images, mainImages, videoUrl, seller, variants, ...}`
- **Ozon BFF 拦截**（`content/ozon-bff-interceptor.js` MAIN world）：fetch / XHR hook + accessor 自愈（`Object.defineProperty` setter 重 wrap），白名单 7 个 composer-api 端点
- **1688 多策略 fallback**：`pageDataBridge.globals` + `structuredRoots()` + `walkObjects`（depth ≤ 8）
- **采集器子系统**（`content/collector/`）：
  - TaskQueue 拥塞节流（high 12 / low 6 滞回 2s）
  - AutoScroller + KeywordPilot（SPA 跨页 session 复活）
  - AntiBan（403 重开）
  - IndexedDB 双层（L2 主桶 `jzCollector` + L1 影子表 `jzL1Shadow`）
  - L1 / L2 diff 判定 `READY_FOR_PHASE2`
- **去重**（SW `pushSourceCollect`）：24h cache + in-flight 合并 + 指数退避（408 / 429 / 5xx 重试 3 次，4xx 立即失败）

### 4.2 跟卖 / 上架

- **门户上架绕限流**（`viaPortal=true`）：seller.ozon.ru bundle 接口（create-bundle → update-bundle-items → upload-bundle），公司一致性护栏
- **V3 上架**（`lib/v3-payload.js`）：`buildV3Item` 字段优先级 用户填 > distilled 兜底 > fallback 100
- **searchVariants 关键路径**：cookies 取 `sc_company_id` → `/api/v1/search` → `create-bundle-by-variant-id`（24h cache，key=`companyId:variantId`）→ 注入 weight / barcode / complex_attributes
- **AI 增强**：水印 / Gemini 改图 / AI 重写 / 视频转存 四路独立开关
- **批量上架**（`batch-upload/index.js`）：配额预校验 → gateCheck（首 SKU 验证通讯）→ `collectBySkus`（BATCH_SIZE=3，反爬熔断）→ 多店 `Promise.allSettled` → 超时兜底 `reconcileTimedOutSubmit`

### 4.3 数据同步（客户端驱动 OPI）

- **三类定时同步**：PRODUCTS(30min, diff hash) / POSTINGS(5min) / WAREHOUSES(360min)
- **lease 租约**：TTL 按类型（PRODUCTS 45min / POSTINGS 5min / WAREHOUSES 10min），三层续期（timer TTL/3 + 每页 heartbeat + backend 服务端续锁）
- **diff-index**：256 分片 `chrome.storage.local` blob，`sha256(stableStringify(stripVolatile(raw)))`，volatile 黑名单（`*_at` / stocks / prices 等）
- **deviceId**：`crypto.randomUUID()` 持久化，单飞防并发
- **凭据 cache**：5min TTL in-memory，401 / 403 自动 invalidate

### 4.4 Agent 远程任务执行器

- **运行模型**：扩展注册为 online browser executor，backend 派单，本地 allow-listed handler 执行（**绝不执行 server 下发 JS**）
- **7 个静态 action**：`agent.ping` / `collect.hot_products` / `collect.product_detail` / `ozon.collect_variant` / `ozon.market_data` / `listing.create_draft` / `listing.publish_draft`
- **1 个动态能力**：`ozon.seller_collect`（probe `sc_company_id` cookie）
- **状态机**：`IDLE → claim → running → complete/fail`，`capsKey` 漂移触发重注册，4xx 落 1h 冷却（实测从 60 req/h 降到 ~1 req/h）

### 4.5 辅助功能

- **Premium 透视眼**（`content/ozon-premium-hook.js` MAIN world）：4 层 deepPatch（fetch / XHR / JSON.parse / Response.json）伪造 Premium 状态，浮动面板可拖拽
- **1688 AI 上架向导**（`content/1688-ai-wizard.js`）：4 步向导 + 类目 descend + VLM 复核
- **jzc-calc 浮动算价**：CEL / GUOO / XY / ZTO + EUB / EBP 费率（硬编码，注释"义乌仓 122 资费表 2026-04-15"）
- **设备指纹 v3**：FNV-1a + MurmurHash 变种，popup / frontend / SW 三处对齐
- **CDN buster**：`withCdnBuster(url)` 加 `_t=Date.now()`，处理 CDN 历史污染
- **更新校验 fail-closed**：SHA-256 校验 zip，分销商 brand 必须有 sha256

---

## 五、background 模块详解

### 5.1 service-worker.js（4103 行，69 action 路由）

#### 文件头部

- `globalThis.__JZ_BRAND__` 由 build.js 注入（`my` 分销商版）。Electron 36+ 不实现 `chrome.contextMenus / notifications / cookies`，顶部给缺失 API 注册 no-op fallback
- 生产构建单一候选 `https://api.jizhangerp.com`；dev 双候选探活

#### 关键常量

- `STORAGE_KEYS`：`ozonAuthToken` / `ozonStoreId` / `extensionLatestVersion` / `ozonMachineFingerprintV3` / `usageTrackedDate` / `l1ReportEnabled` 等
- Alarm 名：`extension-update-check`(4h) / `follow-sell-task-check`(5min) / `device-heartbeat`(5min) / `jzc-fx-refresh`(24h) / `jz:client-sync:POSTINGS|PRODUCTS|WAREHOUSES` / `jz:browser-agent`(1min)
- 默认同步间隔（分钟）：`POSTINGS:5 / PRODUCTS:30 / WAREHOUSES:360`（可被 backend `/ozon/sync/client-intervals` 覆盖，24h cache）

#### 关键工具函数

| 函数 | 作用 |
|---|---|
| `getExtensionFingerprint(preferredFingerprint)` | 设备指纹 v3（v2 兼容回退），与 popup / frontend 算法对齐 |
| `detectBackendUrl()` / `getBackendUrl()` | 探测并缓存 backend URL |
| `normalizeSearchVariantToSv(v)` | /api/v1/search 响应归一化为 sv shape（含 attributes 数组） |
| `fetchBundleByVariantId(sku, variantId, companyId, opts)` | 调 `/api/site/seller-prototype/create-bundle-by-variant-id`，24h cache，有副作用 |
| `resolveSellerCompanyId()` | 从 `chrome.cookies.getAll` 取 `sc_company_id` |
| `importViaPortal()` | 门户上架编排：backend `prepare-bundle-items` → 逐 bundle create / update / upload |
| `ensureSellerTab` | 找 / 开 seller.ozon.ru tab，single-flight 包装防并发 |
| `normalizeMarketItem(item)` | data / v3 item 字段大小写归一 |
| `transferVideoToOzon(srcUrl)` | seller tab MAIN world 跨源拉 .mp4 → POST `seller.ozon.ru/api/media-storage/upload-file` |
| `_sellerPortalGate()` | 全局节奏闸门，所有 `fetchSellerPortal` 调用串行，相邻间隔 ≥200ms |
| `fetchSellerViaOzonTab(path, body, opts, preferTabId)` | 跨域快路：在 www.ozon.ru tab 内 MAIN world 直接 POST seller.ozon.ru |
| `fetchSellerPortal(path, body, opts)` | 主门户调用：跨域快路 → seller-tab executeScript → bridge fallback |
| `apiRequest(method, url, body, token, storeId)` | backend 调用统一封装：Bearer + x-ozon-store-id + 401 自动清凭据 + 滑动续期 |
| `proxyCollectVariant` / `proxyMarketData` | 本机未登 seller → 派单到 backend 代采，90s 轮询拿结果 |
| `flushProductStatsBatch` / `queueProductStats` | getProductStats 合批器：debounce 100ms + maxWait 300ms + 满 50 立发 |
| `checkForUpdate()` / `verifyExtensionHash` | 拉更新 + SubtleCrypto SHA-256 校验（fail-closed） |
| `checkFollowSellTasks()` | 5min 拉最近 1h 内 FAILED 跟卖任务，push notifications，去重 |
| `refreshExchangeRate()` | 拉 `https://open.er-api.com/v6/latest/CNY` |

#### chrome 事件监听器

| 事件 | 处理 |
|---|---|
| `chrome.alarms.onAlarm` | 路由到 6 种 alarm |
| `chrome.notifications.onClicked` | `follow-sell-fail-*` 点击 → openPopup + clear |
| `chrome.runtime.onInstalled` | detectBackendUrl + createContextMenus + setupAlarm + initContext + checkForUpdate + refreshExchangeRate + reloadSellerTabs |
| `chrome.runtime.onStartup` | 同上但去掉 detectBackendUrl / createContextMenus / checkForUpdate |
| `chrome.contextMenus.onClicked` | `ozon-image-search-1688` → 打开 1688 以图搜款 |
| `chrome.tabs.onRemoved` | 清理 collectorTabs 心跳记录 |
| `chrome.runtime.onMessage` | 主消息路由（见下） |

#### 消息路由表（69 action）

**鉴权 / 会话（11）**：`getAuth` / `saveAuth` / `logout` / `syncAuthFromWeb` / `tryWebSync` / `openFrontend` / `setMachineFingerprint` / `loginSms` / `loginPassword` / `login` / `flashBadge`

**店铺 / Backend（4）**：`getStores` / `refreshBackend` / `openSellerPortal` / `checkSellerCookies` / `syncSellerCookies`（三方查询 cookies：byName / byUrl / byDomain 合并去重后 PATCH）

**采集（11）**：`collectProduct` / `updateCollectBoxItem` / `pushSourceCollect`（多源统一 ingest + 客户端 dedupe + in-flight 合并 + 指数退避） / `collectBatch` / `pushToCollectBox` / `pushSourceCollectBatch` / `collectorHeartbeat` / `collectorGetState` / `addFavorite` / `getCollectCount` / `getFavCount`

**商品 / 市场数据（7）**：`getProductStats`（合批器） / `getMarketStats` / `fetchBestsellers` / `fetchOzonPublicProduct` / `searchProductBySku` / `searchVariants` / `proxyImageFetch`

**跟卖 / 上架（13）**：`followSell` / `portalImportStatus` / `listFollowSellTasks` / `importBySku` / `importStock` / `getImportStatus` / `getWarehouses` / `getCategoryTree` / `getCategoryAttributes` / `aiOptimizeForRating` / `suggestCategory` / `verifyCategory` / `aiListingDraftCreate / Confirm / Publish` / `uploadFollowSellVideo` / `transferVariantVideo` / `fetchVariantRichContent`

**会员 / AI（4）**：`getMembershipSummary` / `getAiQuota`（并行 4 个请求） / `aiOptimize` / `translateKeywords`

**杂项（11）**：`usageTrack`（设备级去重埋点） / `getFxRate` / `getFeatureFlags` / `getProductStatusCounts` / `getRecommendations` / `getCaptcha` / `sendSmsCode` / `getUpdateInfo` / `checkUpdate` / `dismissUpdate` / `browserAgentGetState` / `browserAgentCancelCurrent` / `reportCategoryMapping`

特殊 `message.type`（短路径）：`jzc:refreshFx` / `fetchProductPageState` / `JZC_L1_SAMPLE` / `JZC_L1_REPORT_STATUS` / `jzManualSync`

#### `searchVariants` 关键流程

1. `chrome.cookies.getAll` 取 `sc_company_id`，未登 → 透明回退 `proxyCollectVariant` 派单代采
2. 调 `/api/v1/search`（走 `fetchSellerViaOzonTab` 跨域快路）拿 `variant_id`
3. 调 `fetchBundleByVariantId` 拿完整 item
4. 把 bundle 的 weight / depth / width / height（4497 / 9454 / 9455 / 9456）+ barcode（7822）+ 简单 attributes 注入 items[0]，complex_attributes 单独挂 `_bundleComplexAttrs`
5. `classifyError` 把异常归类：`NOT_IN_OWN_CATALOG` / `NO_SELLER_TAB` / `PERMISSION_DENIED` / `AUTH_REQUIRED` / `ANTIBOT_BLOCKED`（区分结构化 JSON vs HTML 挑战页） / `TIMEOUT` / `NETWORK_ERROR`

#### SW 保活 & 总超时

- `KEEP_ALIVE_ACTIONS`：`followSell` / `importBySku` / `fetchProductPageState` / `searchVariants` / `pushSourceCollect` / `uploadFollowSellVideo` / `transferVariantVideo` —— 每 15s 调 `chrome.runtime.getPlatformInfo()` 续命
- `HANDLER_TOTAL_TIMEOUT_MS`：默认 50s，视频动作 160s，`Promise.race` 包裹

### 5.2 agent/ 子目录

#### 运行模型

"远程任务执行器"模式 —— 扩展把自身注册为一台 online browser executor，backend 把任务派给已登录具备特定 capability 的设备，设备本地执行 allow-listed action，结果回传 backend。

#### 状态机（agent-runtime.js）

```
[tick 触发(alarm 1min)]
   ↓
[ensureContext] → 读 chrome.storage 'jzBrowserAgent:device'
   ↓
有 deviceId + 版本未变 + capsKey 未漂移 ──否──→ [ensureRegistered:4xx 落冷却 1h]
   ↓ 是
[claimNextBrowserAgentJob(deviceId)]
   ↓
无 job ──→ return
有 job ──→ [setState running=true + reportProgress 'running']
   ↓
[JzBrowserAgentActions.run(job, {deviceId, reportProgress, isCancelled, throwIfCancelled})]
   ↓
成功 ──→ [completeBrowserAgentJob]
失败 ──→ [failBrowserAgentJob(code, message, data)]
   ↓
[clearState + running=false]
```

关键设计：
- `capsKey`（能力指纹）= `[...new Set(caps)].sort().join(',')`，登入 / 登出 seller.ozon.ru 致 `ozon.seller_collect` 增减会触发重新心跳
- `REGISTER_COOLDOWN_MS = 1h`：4xx 后落 `registerBlockedUntil`，冷却期内 tick 完全静默
- `requestCancel(jobId)`：设置 `cancelRequested = true`，action 内部通过 `context.throwIfCancelled()` 抛 `USER_CANCELLED`
- 状态持久化：`jzBrowserAgent:device` + `jzBrowserAgent:state`

#### Action 注册机制（actions.js）

- `handlers = new Map()`：type → handler
- `dynamicCapabilities = new Map()`：name → async probe
- `register(type, handler)` / `registerDynamicCapability(name, probe)`
- `capabilities()` 返回静态列表；`capabilitiesAsync()` 返回静态 + probe 为真的动态能力
- `run(job, context)` 查 handler 执行，未注册抛 `UNSUPPORTED_ACTION`

#### 已注册 Action

**`actions.js`**：`agent.ping`

**`collect-actions.js`**（4 action + 1 动态能力）：
- 动态能力 `ozon.seller_collect`：probe `sc_company_id` cookie
- `collect.hot_products`：打开 ozon.ru 搜索页 → `scrapeHotProductCards`（MAIN world 注入）→ 逐条 `enrichVariant` → `collectRaw`。limit 默认 5，上限 20
- `collect.product_detail`：打开 PDP → `scrapeProductDetail` → enrichVariant → collectRaw
- `ozon.collect_variant`：代采核心 —— 在自己浏览器跑 `searchVariants`（带 `noProxy:true` 防递归）
- `ozon.market_data`：代采市场数据，跑 `getMarketStats`

**`listing-actions.js`**（2 action）：
- `listing.create_draft`：调 `JzBackendClient.createAiListingDraft`
- `listing.publish_draft`：调 `JzBackendClient.publishAiListingDraft`

### 5.3 sync/ 子目录

#### 同步流程总览

`chrome.alarms` 按 type 独立触发 → `handleClientSyncAlarm` 守卫（同 type 在跑则 skip）→ `JzSyncEngine.runRound(type)`：

```
[runRound(type)]
   ↓
[getOrCreateDeviceId]  (chrome.storage.local 持久化 UUID, 单飞防并发)
   ↓
[JzBackendClient.getVisibleStores] → GET /auth/ozon-stores
   ↓
for each store (stagger 10s 避限流):
   [runOneType(store, type, deviceId, preJobId?)]
       ↓
   [fetchCredentialsCached]  // GET /ozon/stores/:id/sync-credentials, 5min in-memory cache
       ↓
   [acquireLease(storeId, type, deviceId)]  // 失败 return {skipped:'lease-busy'}
       ↓
   [reportSafe PENDING]
       ↓
   syncProducts / syncPostings / syncWarehouses
       ↓
   [reportSafe SUCCESS / FAILED]
       ↓
   [releaseLeaseSafe]  // 失败靠 backend TTL 兜底
```

#### Lease（租约）机制

- **TTL 按类型**：PRODUCTS 45min / POSTINGS 5min / WAREHOUSES 10min
- **acquire**：`POST /ozon/sync/lease/acquire` body `{storeId, type, deviceId, ttlSeconds}`
- **自动续期**：`setInterval` 间隔 = `TTL * 1/3`
- **每页显式 heartbeat**：`heartbeatLeaseSafe`，时间节流（`minGap = TTL/3`）
- **release**：主动 + 清 timer，失败靠 backend TTL 兜底
- **本地 cache**：in-memory Map（`storeId:type` → {leaseId, expiresAt}）

#### diff 索引（diff-index.js）

PRODUCTS 专用，`chrome.storage.local` 分片 blob 存储 contentHash：

- **key**：`diff:{storeId}:PRODUCTS:{shard 00..ff}`，256 片
- **shardOf(productId)**：简易 hash（productId 字符串 → byte & 0xff → hex 2 位）
- **volatile 黑名单**：`updated_at` / `created_at` / `synced_at` / `stocks` / `prices` / `price_indexes` / `primary_image` + 任何 `*_at` 后缀字段
- **stableStringify**：对象 key 排序，数组保序，防字段顺序漂移
- **computeHash**：`sha256Hex(stableStringify(stripVolatile(raw)))`
- **GC**：`gcOldEntries` stub（MVP 未实现）

#### 三类同步具体能力

**PRODUCTS**（`syncProducts`）：
1. 两轮 visibility=ALL + visibility=ARCHIVED
2. 每页 1000 调 `/v3/product/list`
3. chunk 1000 调 `/v3/product/info/list`
4. 逐条 `computeHash` + `getHashes` 比对本地索引
5. 命中 → 只发 `{id, contentHash}`；未命中 → 发 `{id, contentHash, raw}`
6. POST `/ozon/cache/import-with-hash`
7. 处理 backend `needRaw` 反向索要
8. 写本地 hash 索引（成功上传后才写）

**POSTINGS**（`syncPostings`）：
- `/v4/posting/fbs/list`，cursor 分页，limit 100，最多 50 页，时间窗口 7 天
- `with: {analytics_data, barcodes, financial_data, translit}` 全开
- POST `/ozon/postings/cache/import`（无 diff，直接整批）

**WAREHOUSES**（`syncWarehouses`）：
- `/v2/warehouse/list`，单次调用
- 6-shape fallback 解析
- POST `/ozon/warehouses/cache/import`

#### 与 backend / OPI 交互

**`opi-client.js`**：BASE_URL `https://api-seller.ozon.ru`，POST + `Client-Id` / `Api-Key` 头，60s 超时

**`backend-client.js`**：通过 `setContext({getBackendUrl, getAuthToken})` 注入 SW 鉴权路径；GET 走 `JzCdnBuster.withCdnBuster`

---

## 六、content 模块详解

### 6.1 文件职责矩阵

| 文件 | 注入世界 | run_at | 匹配页面 | 核心职责 |
|---|---|---|---|---|
| `collector/task-queue.js` | ISOLATED | document_idle | 搜索 / 类目 / data-panel | `JZTaskQueue` 类，状态机 + 拥塞节流 |
| `collector/auto-scroller.js` | ISOLATED | document_idle | 同上 | `JZAutoScroller`，滚动 + 空检测 + 拥塞联动 |
| `collector/keyword-pilot.js` | ISOLATED | document_idle | 同上 | `JZKeywordPilot`，关键词遍历 + SPA 跨页复活 |
| `collector/anti-ban.js` | ISOLATED | document_idle | 同上 | `JZAntiBanGuard`，403 探测 + 重开 |
| `collector/db.js` | ISOLATED | document_idle | 全 ozon.ru/* | `JZCollectorDB`，4 store + BroadcastChannel 跨 tab |
| `collector/l1-shadow-db.js` | ISOLATED | document_idle | 搜索 / 类目 / 商品 | `JZL1ShadowDB`，samples + sku_samples 双表 |
| `collector/l1-bridge.js` | ISOLATED | document_idle | 同上 | 接收 MAIN world BFF 响应 → 本地写 + batch 转发 SW |
| `collector/l1-diff.js` | ISOLATED | document_idle | 同上 | L1 / L2 对比 + `READY_FOR_PHASE2` 判定 |
| `collector/panel.js` | ISOLATED | document_idle | 全 ozon.ru/* | `JZCollectorPanel.create()`，5-section 浮动面板 |
| `ozon-bff-interceptor.js` | **MAIN** | **document_start** | 搜索 / 类目 / 商品 | hook fetch / XHR，clone 7 个 BFF 端点响应 |
| `ozon-product.js` | ISOLATED | document_idle | 商品 + 列表 | `extractProductData()` 7 层 fallback + action bar |
| `ozon-search.js` | ISOLATED | document_idle | 搜索 / 类目 / search-by-image | 采集器全套集成入口 |
| `ozon-data-panel.js` | ISOLATED | document_idle | 全 ozon.ru（排除 search / category） | 4 路并发数据卡 |
| `ozon-seller-bridge.js` | ISOLATED | document_idle | seller.ozon.ru/* | 类目上报 + Premium 同步 + sellerPortalFetch 代理 |
| `ozon-bestsellers-hook.js` | **MAIN** | **document_start** | seller.ozon.ru/.../ozon-bestsellers* | hook fetch，提取类目名上报 |
| `ozon-premium-hook.js` | **MAIN** | **document_start** + all_frames | seller.ozon.ru/app/analytics* | 4 层 deepPatch 伪造 Premium 状态 |
| `1688-ai-wizard.js` | ISOLATED | document_idle | detail.1688.com/offer/* | 4 步 AI 上架向导 |
| `1688-image-search.js` | ISOLATED | document_idle | s.1688.com / www.1688.com | Ozon 主图 → 1688 以图搜款 |
| `1688-page-data-hook.js` | **MAIN** | document_idle | detail.1688.com/offer/* | 监听 page-data 请求，推送 window globals |
| `alibaba-1688.js` | ISOLATED | document_idle | detail.1688.com/offer/* | 多策略 fallback 采集 + action bar |
| `cn-source-product.js` | ISOLATED | document_idle | JD / PDD / Taobao / Amazon / WB / Temu / ML / Yandex / Shein | 入口挂载 |
| `jizhangerp-bridge.js` | ISOLATED | **document_start** | my.jizhangerp.com / localhost:3000 | 协议 v1，ping / prefetch / sync |
| `jzc-calc.js` | ISOLATED | document_idle | 商品 + 列表 | 浮动算价面板 |
| `sync-auth.js` | ISOLATED | **document_start** | my.jizhangerp.com / localhost:3000 | 双向 token 桥 + 设备指纹 v3 |
| `shared-utils.js` | ISOLATED | document_idle | 全 ozon.ru/* | 全局工具：`extractStateData` / `sendMessage` / `JZTaskQueue` 等 |

### 6.2 关键消息类型清单

| 消息 action | 发起方 → 接收方 | 用途 |
|---|---|---|
| `JZC_OZON_COMPOSER_RESPONSE` | MAIN bff-interceptor → ISOLATED l1-bridge | BFF 响应样本 |
| `JZC_L1_SAMPLE` | ISOLATED l1-bridge → SW | L1 采样上报 |
| `JZC_1688_PAGE_DATA` / `JZC_1688_REQUEST_PAGE_DATA` | MAIN page-data-hook ↔ ISOLATED alibaba-1688 | 1688 window globals |
| `JZC_BESTSELLERS_REPORT` | MAIN bestsellers-hook → ISOLATED seller-bridge | 类目映射 |
| `JZC_PREMIUM_QUERY / REQUEST_TOGGLE / PANEL_POS` | MAIN premium-hook ↔ ISOLATED seller-bridge | Premium 状态同步 |
| `pushSourceCollect` / `pushSourceCollectBatch` | ozon-product / search / alibaba-1688 → SW | 商品采集入箱 |
| `searchVariants` / `getMarketStats` / `getProductStats` / `getSellerProducts` | 多个 ISOLATED → SW | 商品数据查询 |
| `followSell` | ozon-product → SW | 跟卖提交 |
| `sellerPortalFetch` | ISOLATED seller-bridge → SW | seller.ozon.ru API 代理 |
| `proxyImageFetch` | 1688-image-search → SW | 跨域图片下载 |
| `jzManualSync` | jizhangerp-bridge → SW | ERP 同步触发 |
| `collectorHeartbeat` | ozon-search → SW | 采集器心跳 |

### 6.3 关键设计点

#### TaskQueue 自适应拥塞节流

- 状态机：`pending → running → success | timeout | error`
- 滞回 2s：pending 达 `autoPauseHigh`(12) → `congestion:high`；回落 `autoPauseLow`(6) → `congestion:low`
- AutoScroller 订阅 congestion：high → `autoPause()`，low → `autoResume()`（仅自动暂停可恢复，用户手动 stop 不复活）

#### L1 / L2 双数据层 + Phase 2 决策

- L1（jzL1Shadow）：被动接收 BFF 响应，记录字段存在性，不存原始数据
- L2（jzCollector）：主动采集的 SKU 主桶
- 判定：`ratio = |L1|/|L2| ≥ 1.2x` 且 L1 独占字段（seller / rating）存在 → `READY_FOR_PHASE2`
- 预算上限：`extractSkuDetails` 限制 `WALK_MAX_NODES=5000 / DEPTH=30 / ARRAY_ITEMS=200 / JSON_PARSE=50 / >2MB skip`
- prune：samples 5000 行 / 14 天，sku_samples 50000 行 / 7 天，2% 概率触发 + 60s 节流

#### fetch / XHR hook + accessor 自愈（ozon-bff-interceptor.js）

```js
Object.defineProperty(window, 'fetch', {
  get: () => wrappedFetch,
  set: (newFetch) => { wrappedFetch = wrapFetch(newFetch); }
});
```

- 任何第三方重新赋值 `window.fetch` 都会被 setter 自动 wrap
- `makeNativeLooking` 伪装 `toString / name` 为 native
- `dispatchSafe`：microtask 异步派发，失败静默吞掉，绝不阻塞 Ozon 原生逻辑

#### 跨页 session 复活（keyword-pilot.js）

- 每个关键词开始时 `db.putSession({currentKeywordId, keyword, ...})` 写 `sessions` store（key='current'）
- `init()` 启动时读 session，验证 `currentKeywordId` 与 URL `?text=` 参数匹配，命中则恢复 `COLLECTING` 状态

#### Premium 4 层 deepPatch（ozon-premium-hook.js）

1. `window.fetch` hook
2. `XMLHttpRequest.prototype.open + send` hook
3. `JSON.parse` hook（替换全局函数）
4. `Response.prototype.json` hook（覆盖原型方法）

`buildFakeResponse` 返回 `is_premium: true / status: 'grace_good' / subscription.current: 'PREMIUM_PLUS' / features.*: 'full'`；`deepPatch` 递归 `patchInPlace`，`looksPremiumLike` 按 key 名识别 premium-shape 对象。

#### ERP 桥设计动机（jizhangerp-bridge.js）

避免后端跨境直接打 seller portal 触发 antibot 403：用户在橘子 ERP Web 界面操作 → postMessage 给扩展 → 扩展用用户浏览器 cookie 直接 fetch。单 item 节省 4-5min。

---

## 七、lib / popup / batch-upload 模块详解

### 7.1 lib/ 工具库（14 文件，IIFE + 双导出）

| 文件 | 命名空间 | 核心职责 |
|---|---|---|
| `cdn-buster.js` | `JzCdnBuster` | `withCdnBuster(url)` 拼 `_t=Date.now()`，绕 CDN 历史污染 |
| `cn-source-debug-page.js` | `window.__JZC_CN_SOURCE_DEBUG__` | 主世界调试桥，postMessage 通信（3s 超时），规避淘宝 CSP |
| `cn-source-panel.js` | `JZCnSourcePanel` | 跨境货源页浮动面板：复制图片 / 采集商品 / 手动上架 |
| `cn-source-scraper.js` | `JZCnSourceScraper` | 1625 行核心采集器，9 套 `PLATFORM_CONFIGS`，`detectPlatform` + `buildPayload` |
| `follow-sell-content-copy.js` | `JZFollowSellContentCopy` | 跟卖描述 / 标签归一，`pickFollowSellDescription` 优先级 custom > 源 4191 > fallbackName |
| `ozon-video-extract.js` | `JZOzonVideoExtract` | Ozon 视频抽取，6 个导出函数，`findMediaInObject` 递归（WeakSet 防环，MAX_DEPTH=8） |
| `quick-list-parser.js` | `JZQuickListParser` | 批量上架文本解析，10 种 formatHint，`SKU_RE=/^\d{6,16}$/` |
| `sidebar-section-toggle.js` | `JZSidebarSectionToggle` | sidebar 折叠，`sessionStorage` 持久化 |
| `sku-collect.js` | `JZSkuCollect` | 批量上架 SKU 采集编排，`BATCH_SIZE=3`，`ANTIBOT_COOLDOWN_MS=10*60*1000` |
| `store-picker.js` / `.css` | `JZStorePicker` | 店铺选择器，双层架构 + popover，`mv-store-recent` 存最近 12 家 |
| `title-quality.js` | `JZTitleQuality` | 标题质量预检，`NAME_MAX=200`，检查 empty / cjk / no_cyrillic / too_short / all_caps / keyword_pile / code_like / truncation_risk |
| `v3-payload.js` | `JZV3Payload` | V3 上架 item 构造，`buildV3Item(row, distilled, opts)` |
| `watermark-templates.js` | `JZWatermarkTemplates` | 水印模板下拉，`STORE_BOUND_VALUE="__store_bound__"` |

### 7.2 popup/

- **popup.html**：login-view + main-view，含 store-card + today / signals + collector-mon + browser-agent + nav-section（商品管理 / 工具与分析）
- **popup.js**（1322 行）：品牌占位符兜底、20+ 通信动作、`getMachineFingerprint`、signals 优先级（bad > context > neutral > warn）、5s / 3s 轮询
- **popup.css**：`--accent:rgb(232,77,146)` 粉色（注意：与 batch-upload 蓝色不一致）

### 7.3 batch-upload/

- **index.html**：加载顺序 shared-utils → store-picker → quick-list-parser → sku-collect → follow-sell-content-copy → v3-payload → title-quality → watermark-templates → index.js
- **index.js**（1453 行）编排流程：
  1. 拉 stores → 检测 seller.ozon.ru tab
  2. textarea 输入触发 parse + renderPreview
  3. `onSubmit`：校验 → 配额预校验 → checkSellerTab → gateCheck → `collectBySkus`（反爬熔断后中止但已采部分仍提交）→ 拼 V3 items → 标题质量预检 → 多店 `Promise.allSettled` 调 followSell
  4. `reconcileTimedOutSubmit`：网络错后查 `listFollowSellTasks` 找近 10 分钟匹配任务
  5. 持久化：`batch-upload-listing-config-v1` + `followSellWarehouseByStore`
- **index.css**：主色 `#1677FF` 蓝 + `#722ED1` 紫 accent

---

## 八、测试覆盖

所有测试均为**纯 Node + assert，无测试框架**，通过 `node tests/xxx.test.js` 直接运行。

| 测试文件 | 类型 | 覆盖内容 |
|---|---|---|
| `alibaba-1688-scraper.test.js` | Playwright 端到端 | mock 1688 详情页，验证 skuModel / skuMap 采集、manifest 注入顺序 |
| `cn-source-panel.test.js` | Playwright 端到端（137KB） | 38 个场景 helper + 46 个用例，覆盖 9 平台采集字段、噪声剔除、variants 笛卡尔积、debug bridge CSP |
| `data-card-copy-button.test.js` | 静态字符串检查 | 验证 `jzSafeCopyText` / `jzBindDataCardCopyButtons` 使用与 XSS 隐患修复 |
| `follow-sell-content-copy.test.js` | require lib + assert | `pickFollowSellDescription` 优先级、富内容提取、hashtag 归一 |
| `follow-sell-modal.test.js` | Playwright 端到端 | modal 渲染、hover 不开 modal |
| `ozon-video-extract.test.js` | require lib + assert + manifest 检查 | 6 个抽取函数 + manifest 注入顺序 |
| `sidebar-section-toggle.test.js` | require lib + mock + 静态检查 | 折叠 / 展开状态、CSS 规则顺序 |
| `title-quality.test.js` | require lib + assert | 12 个用例，覆盖各类标题问题 |
| `background/__tests__/agent-actions.smoke.test.js` | 冒烟 | 7 个静态 action 注册 + 动态能力 probe |
| `background/__tests__/dedupe.smoke.test.js` | 冒烟 | `pushSourceCollectRef` 参考实现 + 9 个 dedupe / retry / in-flight case |
| `popup/__tests__/browser-agent-popup.smoke.test.js` | 静态字符串检查 | popup html / js / css + service-worker 含 browser-agent 相关符号 |

---

## 九、关键设计点汇总

1. **跨域快路 + 三策略 fallback**：`fetchSellerPortal` 优先 www.ozon.ru tab 内 MAIN world 直发 seller.ozon.ru（CORS-safelisted 头 + company_id 放 body），失败回退 seller-tab executeScript → bridge，structured error 透传
2. **门户全局节奏闸门**：`_sellerPortalGate` 串行化所有门户调用，相邻 ≥200ms，防反爬风险评分
3. **代采透明回退**：本机未登 seller 时派单 backend tenant-scope 任务池，同租户已登设备领单跑同一套逻辑，`noProxy:true` 防递归，caller 零改动
4. **bundle 缓存防串店**：v2 cache key = `companyId:variantId`，启动时一次性清理 v1 缓存
5. **diff 同步省带宽**：PRODUCTS 算 contentHash，本地命中只发 hash 不发 raw，backend 也能 `needRaw` 反向索要。256 分片避免单 key 50K 扫描慢
6. **lease 三层兜底**：自动 timer（TTL/3）+ 每页显式 heartbeat（节流）+ backend import-with-hash 服务端续锁
7. **agent 注册冷却**：4xx 后 1h 静默，从 60 req/h 降到 ~1 req/h；能力指纹漂移触发重新心跳
8. **MV3 SW 保活**：长 action 每 15s `getPlatformInfo` 续命 + handler 50s / 160s 总超时 race
9. **设备指纹 v3**：移除 devicePixelRatio + languages（同台 Edge 不同 profile / zoom 算成两台机器的 bug），popup / frontend / SW 三处对齐
10. **滑动续期**：token 用过半时 backend 重签塞 `X-Refreshed-Token`，SW 收到替换本地 token，无感续期
11. **CDN 历史污染兜底**：`JzCdnBuster.withCdnBuster` 给所有 GET 请求加 cache-buster
12. **更新校验 fail-closed**：分销商 brand build 必须有 sha256，空则拒装
13. **productStats 合批器**：debounce 100ms + maxWait 300ms + 满 50 立发，失败退回逐 SKU GET
14. **错误分类器**：`classifyError` 区分 HTML 挑战页（反爬）vs 结构化 JSON 权限 / 会话错
15. **IIFE + 双导出**：lib 文件挂 `window.JZ*` 同时 `module.exports` 兼容 Node 测试，无需打包工具
16. **debug bridge 外部脚本注入**：用 `chrome.runtime.getURL` + `<script src>` 而非 inline，规避淘宝 CSP

---

## 十、隐患清单

### 10.1 高危

1. **Premium 透视眼违反 Ozon TOS**：客户端伪造订阅状态，`dataPoints` 是随机数，基于此的报表失真
2. **`syncSellerCookies` 上传 cookie 到 backend**：cookie 通过 HTTP body 上传，backend 侧任何日志中间件误记都是 bearer 泄露
3. **`diff-index.js` GC 未实现**：50K 商品 × 64 char hash ≈ 3.2MB，加 5MB 配额限制大店铺可能撑爆
4. **l1-bridge 转发 SW 可能丢失**：MV3 SW 休眠时 batch 10 条 / 2s 转发的 `JZC_L1_SAMPLE` 会丢
5. **sync-auth 双向同步死循环风险**：多 tab 同时打开橘子 ERP 时 `RESTORE_GUARD_KEY` 兜底不覆盖
6. **`transferVideoToOzon` 跨源拉 .mp4**：`srcUrl` 来源是用户输入，理论可被构造恶意 URL

### 10.2 中危

7. **`service-worker.js` 4103 行单文件**：69 action + 大量工具函数堆在一个 IIFE，难维护
8. **`ozon-product.js` 497KB 单文件**：超 128KB 读取限制，IDE 卡顿
9. **`shared-utils.js` 157KB 全局污染**：`window` 上挂大量 API，与 Ozon 原生代码冲突风险
10. **cn-source-product.js 全站自动入桶**：非 search 页 `keyword` 字段为 ''，主桶混入无关键词上下文 SKU
11. **jzc-calc 物流费率表硬编码**：调价需发版
12. **`antibotCooldownUntil` 模块级变量跨页面失效**：batch-upload 独立页刷新后冷却丢失
13. **dedupe 参考实现与 service-worker 易漂移**：测试文件复制了一份 `pushSourceCollectRef`，注释"改一处要改另一处"
14. **popup.css 粉色 vs batch-upload 蓝色不一致**：同一扩展两个入口视觉割裂
15. **`runningTypes` 进程级 Set 不跨 SW 实例**：SW 重启时 reset，可能并发跑同 type（靠 backend lease 兜底但有窗口期）
16. **`followSell` viaPortal 部分失败处理**：只有"全部失败"才抛错，部分失败时 `taskIds[0]` 仍是成功的 taskId，前端可能误判整体成功

### 10.3 低危

17. **`_mdProxyInflight` 全局 5 上限**：网格场景 100 卡时 95 卡落"需登录"
18. **`SKU_RE=/^\d{6,16}$/`**：可能漏 13+ 位新 SKU
19. **anti-ban 仅检测 403**：未覆盖 429 / 503 / 验证码页
20. **task-queue 拥塞阈值硬编码**：不同网络环境不一定合适
21. **测试无框架**：无 Jest / Mocha，无覆盖率 / watch 模式
22. **`__tests__` 仅 2 个冒烟测试**：diff-index / sync-engine / lease-client 等关键逻辑无回归保护
23. **l1-shadow-db prune 概率触发**：2% 概率，极端情况长时间不触发导致超量
24. **`store-picker.js` `_getRecentStoreIds` 无并发保护**：多 tab 同时操作可能丢失最近店铺记录

---

## 十一、关键文件路径

- 入口：[manifest.json](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/manifest.json)
- SW：[background/service-worker.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/background/service-worker.js)
- Agent：[background/agent/agent-runtime.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/background/agent/agent-runtime.js)
- Sync：[background/sync/sync-engine.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/background/sync/sync-engine.js)
- BFF 拦截：[content/ozon-bff-interceptor.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-bff-interceptor.js)
- 采集器：[content/collector/](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/collector)
- 9 平台采集：[lib/cn-source-scraper.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/lib/cn-source-scraper.js)
- 批量上架：[batch-upload/index.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/batch-upload/index.js)
- Premium hook：[content/ozon-premium-hook.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-premium-hook.js)
- ERP 桥：[content/jizhangerp-bridge.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/jizhangerp-bridge.js)
