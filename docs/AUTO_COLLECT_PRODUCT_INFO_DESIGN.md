# 自动化采集跟卖产品信息 · 设计文档 V3

> V3 变更:在 V2 八类缓存基础上,(1)去掉搜索页采集,只保留店铺页和详情页;(2)新增中国大陆店铺检测层——进入店铺页/详情页时先提取卖家信息,通过预设规则或人工确认判定是否中国大陆店铺,只对中国大陆店铺的产品触发自动采集。

## 1. 总览

### 1.1 目标

用户浏览 Ozon 店铺页或详情页时,扩展先提取卖家信息并判定是否中国大陆店铺(规则自动 + 人工确认),只对中国大陆店铺的 SKU 自动采集全量跟卖信息(八类缓存:card / detail / composer / entrypoint / search / bundle / marketStats / followSell)到 MongoDB,供后续 ERP 后台对「数据就绪」的 SKU 发起批量上架。

### 1.2 决策摘要

| 円策点 | 选择 | 说明 |
|---|---|---|
| 触发页面 | 店铺页 + 详情页 | **去掉搜索页**(搜索页无法可靠获取店铺信息) |
| 采集深度 | Full | 每 SKU 采全 8 类 |
| 中国大陆店铺过滤 | 规则自动 + 人工确认 | 先规则判定,无法判定时人工确认;分类结果存 MongoDB 跨设备共享 |
| 数据落地 | MongoDB 8 类 collection + store_classification + auto_collect_log | |
| 刷新策略 | 永久存储 + stale 重验(bundle 空属性 6h / marketStats 24h / followSell 4h)+ 强制刷新按钮 | |
| 过滤策略 | 中国大陆店铺 + 仅抓有销量 + 智能筛选(18 字段) | 三层过滤,层层缩减 |
| UI 主控台 | QX采集器浮动面板 | popup 仅作快捷开关 |

### 1.3 角色边界

| 组件 | 职责 | 不负责 |
|---|---|---|
| content scripts | 检测页面类型 + 提取卖家信息 + 写 card/detail/followSell + 筛选 + 发 autoCollect 消息 | 采集编排、限速、落库(除上述三类直写) |
| Service Worker | 店铺分类查询/缓存、采集编排、三层缓存、限速闸门、写 L1+L2+log、内存计数器、写 marketStats | UI、用户交互 |
| ERP Backend | MongoDB 持久层(8 类缓存 + store_classification + auto_collect_log)+ 分类查询接口 + overview 接口 | 采集逻辑 |
| QX采集器面板 | 主控台:总开关/店铺检测/自动翻页/仅抓有销量/智能筛选/状态统计/熔断/强制刷新 | 采集执行 |
| popup | 快捷开关:总开关 + 状态概览 | 详细控制 |

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Content Scripts(改造点)                                        │
│  ┌──────────────┐                    ┌──────────────┐           │
│  │ozon-data-    │                    │ ozon-product │           │
│  │ panel(店铺页)│                    │  (详情页)    │           │
│  └──────┬───────┘                    └──────┬───────┘           │
│         │ IO 触发                          │ extractProductData│
│         ▼                                  ▼                   │
│  ┌─────────────────────────────────────────────────────┐        │
│  │ 店铺信息提取(新增)                                   │        │
│  │  - 店铺页:从 URL 提取 sellerSlug + DOM 提取 sellerName│       │
│  │  - 详情页:从 _product.seller 提取 name + link(已有) │        │
│  │  → sendMessage('checkStoreClassification', {slug,name})│      │
│  │  → 返回 {isMainlandChina: true/false/null, classifiedBy}   │        │
│  └─────────────────────────────────────────────────────┘        │
│         │ (isMainlandChina === true 时继续)                           │
│         ▼                                                       │
│  ┌─────────────────────────────────────────────────────┐        │
│  │ loadPanelData / extractProductData                  │        │
│  │  Step 3: cardCacheSet(无条件写 card 缓存)           │        │
│  │  Step 4: taskQueue 并行加载 panel 数据              │        │
│  │    - getMarketStats → SW 内部写 marketStats 缓存    │        │
│  │    - getProductStats                                │        │
│  │    - variantsQueue.add(searchVariants) → search+bundle│      │
│  │    - followSellQueue.add(jzFetchPublicFollowSell)   │        │
│  │        → 成功后 content 侧写 followSell 缓存        │        │
│  │  Step 5: collectAutoIfMatched(过滤后触发采集)       │        │
│  │    → 中国大陆店铺 ✓ + 仅抓有销量 + 智能筛选             │        │
│  │    → autoCollectOnSkuSeen                           │        │
│  │  (详情页 Step 5 跳过销量/智能筛选,直接 autoCollect) │        │
│  └─────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌─────────────────────────────────────────────────────┐        │
│  │ QX采集器面板(浮动)                                  │        │
│  │  主开关 / 店铺检测状态 / 自动翻页 / 仅抓有销量       │        │
│  │  智能筛选 / 今日统计 / 缓存命中(8 类) / 最近采集    │        │
│  │  熔断倒计时 / 强制刷新当前页 / 查看 ERP              │        │
│  │  店铺分类:未分类时显示 [标记中国大陆] [标记非中国大陆] 按钮  │        │
│  └─────────────────────────────────────────────────────┘        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  Service Worker                                                  │
│  ┌───────────────────────────────────────────────────────┐     │
│  │ 0. 店铺分类查询(新增)                                 │     │
│  │    checkStoreClassification(slug, name)               │     │
│  │    → 查 L1 chrome.storage → L2 MongoDB                │     │
│  │    → 未分类时跑规则引擎                                │     │
│  │    → 仍无法判定返回 null(等待人工确认)               │     │
│  └───────────────────────────────────────────────────────┘     │
│  ┌───────────────────────────────────────────────────────┐     │
│  │ 1. 检查总开关 + 中国大陆店铺 + 冷却期 + 每日上限          │     │
│  │ 2. 查 L1+L2 命中情况(8 类)→ 计算待采类目            │     │
│  │ 3. 按优先级串行编排(每类目间走闸门):                │     │
│  │    a. buyerPageGate → fetchVariantMediaViaBuyerTab    │     │
│  │       (entrypoint + composer + followSell 一次拿)     │     │
│  │    b. sellerPortalGate → searchVariants               │     │
│  │       (内部自动 fetchBundleByVariantId)               │     │
│  │    c. sellerPortalGate → _fetchMarketStatsDirect      │     │
│  │ 4. 写 L1 IndexedDB + 异步写 L2 MongoDB                │     │
│  │ 5. 写 auto_collect_log(状态/耗时/错误)               │     │
│  │ 6. 更新内存计数器 + 环形缓冲(供面板查询)            │     │
│  └───────────────────────────────────────────────────────┘     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  ERP MongoDB(10 个 collection)                                 │
│  ozon_search_cache / ozon_bundle_cache / ozon_card_cache        │
│  ozon_composer_cache / ozon_entrypoint_cache / ozon_detail_cache│
│  ozon_market_stats_cache / ozon_follow_sell_cache               │
│  ozon_store_classification(新) ← 中国大陆店铺分类结果               │
│  + ozon_auto_collect_log                                        │
└─────────────────────────────────────────────────────────────────┘
```

## 3. 数据模型

### 3.1 八类缓存(复用现有 6 类 + 新增 2 类)

| collection | _id | data shape | 写入方 | stale 策略 |
|---|---|---|---|---|
| ozon_card_cache | sku | `{sku,url,name,price,image}` | content(已有,无条件写) | 永久(无 stale) |
| ozon_detail_cache | sku | PDP 全字段 | content(已有,详情页写) | 永久(无 stale) |
| ozon_composer_cache | sku | `{fields,widgetStates}` | SW autoCollect(新) | 永久(无 stale) |
| ozon_entrypoint_cache | sku | `{gallery,richContent,description,hashtags,mp4}` | SW autoCollect(新) | 永久(无 stale) |
| ozon_search_cache | sku | `{items:[normalized sv]}` | SW searchVariants(已有) | 永久(无 stale) |
| ozon_bundle_cache | sku | `{data:item,bundleId,attrsEmptyVerifiedAt?}` | SW fetchBundleByVariantId(已有) | 空属性 6h 重验 |
| **ozon_market_stats_cache** | sku | `{soldCount,gmvSum,avgPrice,...18 字段,category1,category3,brand}` | **SW getMarketStats 内部(新)** | **24h stale** |
| **ozon_follow_sell_cache** | sku | `{count,sellers:[{name,price,sku,link,...}],source}` | **content jzFetchPublicFollowSell 后(新)** | **4h stale** |

### 3.2 新增 ozon_market_stats_cache(详细)

```javascript
{
  _id: "<sku>",
  sku: "<sku>",
  data: {
    // 核心销量/金额
    soldCount, gmvSum, avgPrice, salesDynamics, drr,
    // 日均
    avgOrdersOnAccDays, avgGmvOnAccDays,
    // 促销与推广
    daysInPromo, discount, promoRevenueShare, daysWithTrafarets,
    // 流量与转化
    qtyViewPdp, sessionCount, sessionCountSearch,
    pdpToCartConversion, convToCartPdp, convToCartSearch, convViewToOrder,
    views,
    // 物流与商品
    stock, salesSchema, nullableRedemptionRate, nullableCreateDate,
    // 类目/品牌(data/v3 原始俄文,供数据卡兜底)
    category1, category3, brand,
  },
  fetchedAt: Date,
  l2Synced: boolean,
}
```

**stale 判定**:`Date.now() - fetchedAt > 24 * 60 * 60 * 1000`(24h)

### 3.3 新增 ozon_follow_sell_cache(详细)

```javascript
{
  _id: "<sku>",
  sku: "<sku>",
  data: {
    count: number,
    sellers: Array<{
      name, price, sku, link,
      avatar, rating, reviewsCount,
      region, deliveryText, deliveryRank
    }>,
    source: 'modal' | 'no-sellers' | 'parse-fail',
  },
  fetchedAt: Date,
  l2Synced: boolean,
}
```

**stale 判定**:`Date.now() - fetchedAt > 4 * 60 * 60 * 1000`(4h)

### 3.4 新增 ozon_store_classification(中国大陆店铺分类)

```javascript
{
  _id: "<sellerSlug>",        // 如 "sanfaliye"
  sellerSlug: "<sellerSlug>",
  sellerName: "string",       // 店铺名(首次提取时的快照)
  isMainlandChina: boolean | null,  // true=中国,false=非中国,null=未分类(等待人工确认)
  classifiedBy: string,       // 'rule:cjk-name' | 'rule:known-list' | 'manual'
  classifiedAt: Date,
  companyInfo: {              // 从店铺页 DOM 提取的公司信息(可能为空)
    country: string | null,   // 国家代码 如 'CN'/'RU'
    companyName: string | null,
    legalAddress: string | null,
  } | null,
  lastSeenAt: Date,           // 最后遇到此店铺的时间
  lastSeenUrl: string,        // 最后遇到的 URL
}
```

索引:
- `{ isMainlandChina: 1 }` 查所有中国/非中国大陆店铺
- `{ sellerName: 1 }` 按名搜索

### 3.5 新增 ozon_auto_collect_log

```javascript
{
  _id: "<uuid>",
  sku: "string",
  source: "shop-page" | "pdp",
  sellerSlug: "string",
  storeClassified: "mainland-china" | "non-mainland-china" | "unclassified",
  depth: "Full",
  status: "success" | "partial" | "failed" | "skipped" | "antibot" | "non-mainland-china-store",
  results: [
    { type: "card",        hit: true,  source: "content" },
    { type: "detail",      hit: false, source: "n/a" },
    { type: "composer",    hit: false, source: "buyer-page", duration: 320, error: null },
    { type: "entrypoint",  hit: false, source: "buyer-page", duration: 280, error: null },
    { type: "search",      hit: false, source: "seller-portal", duration: 450, error: null },
    { type: "bundle",      hit: false, source: "seller-portal", duration: 380, error: null },
    { type: "marketStats", hit: false, source: "seller-portal", duration: 420, error: null },
    { type: "followSell",  hit: false, source: "buyer-page", duration: 180, error: null },
  ],
  totalDuration: 2030,
  antibot: false,
  collectedAt: ISODate,
}
```

索引:
- `{ sku: 1, collectedAt: -1 }`
- `{ status: 1, collectedAt: -1 }`
- `{ sellerSlug: 1, collectedAt: -1 }`
- `{ collectedAt: -1 }`

### 3.6 chrome.storage 配置

```javascript
// key: jz-auto-collect-config
{
  enabled: true,
  autoCollectRunning: true,
  depth: "Full",
  paused: false,
  pausedUntil: 0,
  buyerPageMinInterval: 500,
  sellerPortalMinInterval: 200,
  skuInterval: 1000,
  perDayLimit: 2000,
  todayCount: 0,
  todayDate: "2026-07-13",
  marketStatsStaleMs: 86400000,
  followSellStaleMs: 14400000,
  // 中国大陆店铺检测(新增)
  onlyMainlandChinaStores: true,       // 只采集中国大陆店铺(主开关)
  knownMainlandChinaSlugs: [],         // 已知中国大陆店铺 slug 列表(用户手动添加/规则学习)
  knownNonMainlandChinaSlugs: [],      // 已知非中国大陆店铺 slug 列表
}
```

### 3.7 IndexedDB store 结构(升级 v6)

```javascript
const _IDB_NAME = 'ozon-cache';
const _IDB_VERSION = 6;

const _IDB_STORE_SEARCH      = 'search_cache';
const _IDB_STORE_BUNDLE      = 'bundle_cache';
const _IDB_STORE_CARD        = 'card_cache';
const _IDB_STORE_COMPOSER    = 'composer_cache';
const _IDB_STORE_ENTRYPOINT  = 'entrypoint_cache';
const _IDB_STORE_DETAIL      = 'detail_cache';
const _IDB_STORE_MARKET_STATS = 'market_stats_cache';
const _IDB_STORE_FOLLOW_SELL  = 'follow_sell_cache';

// 所有 store keyPath = 'sku'
// 店铺分类不存 IndexedDB,只存 chrome.storage(L1) + MongoDB(L2)
```

### 3.8 localStorage 配置(面板用)

| key | 含义 | 默认 |
|---|---|---|
| `jz-c-sales-filter` | 仅抓有销量开关 | `'0'` |
| `jz-c-smart-filter-state` | 智能筛选模板状态 | 默认模板,enabled=false |
| `jz-c-panel-collapsed` | 面板折叠状态 | `'0'` |
| `jz-c-auto-scroll-toggle` | 自动翻页开关 | `'0'` |

## 4. 中国大陆店铺检测

### 4.1 检测时机

| 页面 | 检测时机 | 数据来源 |
|---|---|---|
| 店铺页 `/seller/{slug}/products/` | 页面加载 + IO 触发前 | URL 提取 slug + DOM 提取 sellerName |
| 详情页 `/product/{sku}/` | extractProductData 后 | _product.seller.name + _product.seller.link(含 slug) |

### 4.2.0 架构约束:MAIN World Content Script

**关键发现**:Ozon 页面的 `window.__NUXT__` 对象只在 MAIN world 可见。`ozon-data-panel.js` 在 manifest.json 中默认运行在 ISOLATED world,无法直接访问 `window.__NUXT__`。

```
┌─────────────────────────────────────────────────┐
│  MAIN world (页面 JS)                            │
│  window.__NUXT__ = {...}  ← 只在这里可见         │
│  window.__NUXT__.state.pageInfo                  │
│    .analyticsInfo.sellerId = "3891653"           │
└─────────────────────────────────────────────────┘
            ↕ DOM 共享,JS 变量隔离
┌─────────────────────────────────────────────────┐
│  ISOLATED world (content script 默认)            │
│  window.__NUXT__ = undefined  ← 取不到!          │
│  但能访问 document.querySelector(...)            │
└─────────────────────────────────────────────────┘
```

**解决方案**:新增独立的 MAIN world content script `qx-ozon/content/seller-info-main.js`,manifest.json 中配置 `"world": "MAIN"`,负责读取 `__NUXT__` 并通过 `CustomEvent` 传给 ISOLATED world。

**manifest.json 配置**:
```json
{
  "matches": [
    "https://www.ozon.ru/seller/*",
    "https://www.ozon.ru/product/*"
  ],
  "js": ["content/seller-info-main.js"],
  "world": "MAIN",
  "run_at": "document_idle"
}
```

**通信流程**:
```
1. MAIN world (seller-info-main.js):
   - 读取 window.__NUXT__.state.pageInfo.analyticsInfo.sellerId
   - 读取 div[id^="state-webCurrentSeller-"] 的 data-state 属性
   - 通过 window.dispatchEvent(new CustomEvent('jz-seller-info', { detail: {...} })) 发送

2. ISOLATED world (ozon-data-panel.js / ozon-product.js):
   - window.addEventListener('jz-seller-info', (e) => { ... })
   - 收到数据后调 sendMessage('checkStoreClassification', ...) 等 SW action
```

**为什么不直接把 ozon-data-panel.js 改为 MAIN world**:
- ozon-data-panel.js 用了 `chrome.storage.local`、`chrome.runtime.sendMessage` 等 chrome.* API,这些在 MAIN world 不可用
- MAIN world 只负责读取页面 JS 变量,数据处理和 SW 通信仍由 ISOLATED world 负责

**seller-info-main.js 职责**(仅读取页面数据,不做业务逻辑):
- 店铺页:读 `__NUXT__.state.pageInfo.analyticsInfo.sellerId` + DOM sellerName + 调 entrypoint-api 获取 companyInfo
- 详情页:读 `div[id^="state-webCurrentSeller-"]` 的 `data-state` 属性 + 解析 trustFactors
- 统一通过 CustomEvent 把 `{slug, name, sellerId, companyInfo, pageType}` 传给 ISOLATED world

### 4.2 卖家信息提取

#### 4.2.1 店铺页 `extractSellerInfoFromShopPage()`

**数据来源**:

| 字段 | 来源 |
|---|---|
| slug | URL pathname `/seller/{slug}` |
| name | DOM `[data-widget="sellerTransparency"] span.tsHeadline600Large` |
| sellerId | `__NUXT__.state.pageInfo.analyticsInfo.sellerId` |
| companyInfo | **方案 A**:fetch 详情页 HTML 的 `state-webCurrentSeller.trustFactors`(完整含 country)<br>**方案 B 退回**:entrypoint-api `/modal/shop-in-shop-info`(仅 companyName) |

**Step 1:从 URL 提取 slug**:
```javascript
// https://www.ozon.ru/seller/youqulin/ → slug = "youqulin"
const slug = location.pathname.match(/\/seller\/([^/]+)/)?.[1];
```

**Step 2:从 DOM 提取 sellerName**:
```javascript
// 实测选择器:[data-widget="sellerTransparency"] span.tsHeadline600Large
// 兜底:h1 → meta og:title(取 "–" 前部分)→ slug
const name =
  document.querySelector('[data-widget="sellerTransparency"] span.tsHeadline600Large')?.textContent?.trim()
  || document.querySelector('h1')?.textContent?.trim()
  || document.querySelector('meta[property="og:title"]')?.content?.split(/[–-]/)[0]?.trim()
  || slug;
```

**Step 3:从 `__NUXT__` 提取 sellerId**:
```javascript
// 实测路径:window.__NUXT__.state.pageInfo.analyticsInfo.sellerId
// 需等待 __NUXT__.state.pageInfo.analyticsInfo.sellerId 出现(15s 超时)
const nuxtState = window.__NUXT__?.state;
const state = typeof nuxtState === 'string' ? JSON.parse(nuxtState) : nuxtState;
const sellerId = String(state?.pageInfo?.analyticsInfo?.sellerId || '');
// 例:youqulin → sellerId = "3891653"
```

**Step 4:获取 companyInfo(方案 A 优先 + 方案 B 退回)**:

**方案 A(优先):fetch 详情页 HTML**
1. 从店铺页 DOM 找第一个 SKU 链接(优先 `[data-widget="searchResultsV2"] a[href*="/product/"]`)
2. fetch 该详情页 URL(带 cookie,同源请求,headers: accept=text/html)
3. DOMParser 解析 HTML
4. 找 `div[id^="state-webCurrentSeller-"]`,读 `data-state` 属性
5. JSON.parse 后从 `trustFactors[0].tooltip.subtitle` 数组提取 companyInfo(companyName/legalAddress/country)
6. 校验:详情页 sellerSlug 与店铺页 slug 一致

**方案 B(退回):entrypoint-api**
触发条件:
- fetch 详情页 HTML 失败(网络错误/403)
- HTML 中不含 `state-webCurrentSeller`(客户端异步渲染未完成)
- data-state 解析失败

退回逻辑:调 entrypoint-api `/modal/shop-in-shop-info?seller_id=${sellerId}`,仅能获取 companyName(无 country/legalAddress),country 需启发式从公司名后缀判断

```javascript
// 实测 API:/api/entrypoint-api.bx/page/json/v2?url=<encoded inner path>
// inner path:/modal/shop-in-shop-info?seller_id=${sellerId}&page_changed=true
// headers:{ 'x-o3-app-name': 'dweb_client', accept: 'application/json' }
// credentials:'include'(带 cookie)
// 在 content script 上下文直接 fetch(不走 SW executeScript)
const innerPath = `/modal/shop-in-shop-info?seller_id=${sellerId}&page_changed=true`;
const apiUrl = `/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(innerPath)}`;
const resp = await fetch(apiUrl, {
  credentials: 'include',
  headers: { 'x-o3-app-name': 'dweb_client', accept: 'application/json' },
});
const data = await resp.json();
const states = data?.widgetStates || {};
```

**Step 5:解析 entrypoint-api 响应提取 companyInfo(方案 B)**:

entrypoint-api 响应的 `widgetStates` 含两个关键 widget:

| Widget key 模式 | widget 来源 | 含义 | 提取字段 |
|---|---|---|---|
| `textBlock-*-default-1` | `marketing.sellerLegalInformation` | 公司法律信息 | `body[].textAtom.text` 数组(filter `type=='textAtom'`) |
| `cellList-*-default-1` | `sis.shopInfo` | 店铺统计 | `cells[].dsCell.centerBlock.title.text` + `dsCell.rightBlock.badge.text` |

```javascript
const companyInfo = { companyName: null, shopStats: null, country: null };
for (const k of Object.keys(states)) {
  let v = states[k];
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { continue; } }
  if (!v || typeof v !== 'object') continue;

  // marketing.sellerLegalInformation widget:body 数组含 textAtom
  if (Array.isArray(v?.body)) {
    const texts = v.body
      .filter((b) => b?.type === 'textAtom' && b?.textAtom?.text)
      .map((b) => b.textAtom.text.trim())
      .filter((t) => t && !/Работает согласно графику Ozon/i.test(t));
    if (texts.length > 0 && !companyInfo.companyName) {
      companyInfo.companyName = texts[0];
      // 启发式:中国外贸公司典型后缀(无 country 字段,需从公司名推断)
      if (/Trading Co\.?,? LTD|Technology Co\.?,? LTD|Import.*Export.*Co\.?,? LTD/i.test(texts[0])) {
        companyInfo.country = 'CN';
      }
    }
  }

  // sis.shopInfo widget:cells 数组含订单数/合作时长/评分/评论数
  if (Array.isArray(v?.cells)) {
    const stats = {};
    for (const cell of v.cells) {
      const title = cell?.dsCell?.centerBlock?.title?.text;
      const value = cell?.dsCell?.rightBlock?.badge?.text;
      if (title && value) stats[title] = value;
    }
    if (Object.keys(stats).length > 0) companyInfo.shopStats = stats;
  }
}
```

**实测数据样例**(youqulin 店铺):
```json
{
  "slug": "youqulin",
  "name": "Территория Покупок",
  "sellerId": "3891653",
  "companyInfo": {
    "companyName": "Xiamen Yaowu Erqi Trading Co., LTD",
    "country": "CN",
    "shopStats": { "Заказы": "87", "С нами": "1 год", "Рейтинг": "4.8", "Отзывы": "4825" }
  }
}
```

**关键限制**:
- entrypoint-api **不返回** country/ИНН/ОГРН/legalAddress 字段,只有 companyName
- country 需从公司名启发式判断(中国外贸公司典型后缀如 "Trading Co., LTD")
- 启发式失败时 country 为 null,走人工确认
- entrypoint-api 可能触发反爬(403 challenge),失败时 companyInfo 整体为 null,不阻断采集流程

**返回值**:
```javascript
return { slug, name, sellerId, companyInfo };
// companyInfo 可能为 null(API 失败时)
```

**为什么优先 fetch 详情页 HTML**:
1. 数据更完整:详情页 trustFactors 含 country/legalAddress,entrypoint-api 只有 companyName
2. 规则引擎 Rule 4/5(country 判定)在方案 A 下可自动判定,方案 B 下需人工确认
3. 反爬风险更低:fetch 详情页是常规浏览行为,entrypoint-api modal 更易触发反爬

**方案 A 失败时的降级**:
- 退回 entrypoint-api,companyInfo 只有 companyName
- country 字段为 null,规则引擎 Rule 4/5 无法判定
- 走人工确认流程(QX面板显示「待确认」状态)

#### 4.2.2 详情页 `extractSellerInfoFromPDP()`

**数据源**:`div[id^="state-webCurrentSeller-"]` 的 `data-state` HTML 属性(**注意:是 attribute,不是 textContent**)

**关键发现**:Ozon 2026 版 DOM 中,`state-webCurrentSeller` widget 的 id 带数字后缀(如 `state-webCurrentSeller-7772769-default-1`),需用 `[id^="state-webCurrentSeller-"]` 选择器。代码中现有的 `extractStateData('state-webCurrentSeller')` 主路径已失效,需适配新选择器。

**提取代码**:
```javascript
// 等待 SPA 渲染(最多 10s)
await waitFor(() => document.querySelector('[id^="state-webCurrentSeller-"]'));

const el = document.querySelector('[id^="state-webCurrentSeller-"]');
const raw = el?.getAttribute('data-state');  // HTML attribute,不是 textContent
if (!raw) return null;
const state = JSON.parse(raw);
```

**从 state 提取字段**:

| 字段 | JSON 路径 | 实测值(youqulin) |
|---|---|---|
| sellerId | `badge.subscribed.common.action.params.sellerId` | `"3891653"` |
| sellerName | `sellerCell.centerBlock.title.text` | `"Территория Покупок"` |
| sellerLink | `sellerCell.centerBlock.common.action.link` | `"https://www.ozon.ru/seller/youqulin/"` |
| sellerSlug | 从 sellerLink 正则 `/seller/([^/]+)/` | `"youqulin"` |
| rating | `rating.title.text` | `"4.8"` |

**从 trustFactors 提取 companyInfo**:

`state.trustFactors[0].tooltip.subtitle` 是一个数组,交替含 `{type:"text", content:"..."}` 和 `{type:"newLine"}`:

```javascript
const companyInfo = { companyName: null, legalAddress: null, country: null };
const trustFactor = state?.trustFactors?.[0];
const subtitles = trustFactor?.tooltip?.subtitle;
if (Array.isArray(subtitles)) {
  const texts = subtitles
    .filter((s) => s?.type === 'text' && typeof s.content === 'string')
    .map((s) => s.content.trim());
  // texts[0] → companyName
  // texts[1] → legalAddress
  // texts[2] → "CN, Xiamen" → 取逗号前 → country
  if (texts.length >= 1) companyInfo.companyName = texts[0];
  if (texts.length >= 2) companyInfo.legalAddress = texts[1];
  if (texts.length >= 3) {
    companyInfo.country = texts[2].split(',')[0].trim().toUpperCase();
  }
}
```

**实测数据样例**(youqulin 店铺,详情页):
```json
{
  "slug": "youqulin",
  "name": "Территория Покупок",
  "sellerId": "3891653",
  "companyInfo": {
    "companyName": "Xiamen Yaowu Erqi Trading Co., LTD",
    "legalAddress": "International Stone Center, No. 68, Heshan Sub-district, Huli District, Xiamen City",
    "country": "CN"
  }
}
```

**详情页优势**:相比店铺页,详情页 DOM 直读可拿到完整 companyInfo(含 country + legalAddress),**无需 API 调用**,零反爬风险。

**返回值**:
```javascript
return { slug, name, sellerId, companyInfo };
// companyInfo 始终有值(除非 state-webCurrentSeller DOM 不存在)
```

#### 4.2.3 店铺页 vs 详情页对比

| 维度 | 店铺页 | 详情页 |
|---|---|---|
| sellerSlug | URL 提取 | sellerLink 正则 |
| sellerName | `sellerTransparency` DOM | `sellerCell.centerBlock.title.text` |
| sellerId | `__NUXT__.state.pageInfo.analyticsInfo.sellerId` | `badge.subscribed.common.action.params.sellerId` |
| companyName | entrypoint-api `sellerLegalInformation` widget | `trustFactors[0].tooltip.subtitle[0]` |
| legalAddress | **无**(API 不返回) | `trustFactors[0].tooltip.subtitle[1]` |
| country | **无**(需启发式从公司名推断) | `trustFactors[0].tooltip.subtitle[2]` 取逗号前 |
| API 调用 | 1 次 entrypoint-api(可能触发反爬) | 无(纯 DOM 直读) |
| 规则引擎 Rule 4/5 可用性 | 仅启发式成功时可用 | **完全可用**(country 字段可靠) |

### 4.3 规则引擎(预设规则)

规则按优先级从高到低执行,首个匹配的规则决定结果:

| 优先级 | 规则名 | 判定逻辑 | 结果 |
|---|---|---|---|
| 1 | `known-list` | sellerSlug 在 `knownMainlandChinaSlugs` 列表中 | isMainlandChina=true |
| 2 | `known-list` | sellerSlug 在 `knownNonMainlandChinaSlugs` 列表中 | isMainlandChina=false |
| 3 | `cjk-name` | sellerName 含 CJK 汉字(`[\u4e00-\u9fff]`) | isMainlandChina=true |
| 4 | `company-country` | companyInfo.country === 'CN' | isMainlandChina=true |
| 5 | `company-country` | companyInfo.country 存在且 !== 'CN' | isMainlandChina=false |
| 6 | — | 无规则匹配 | isMainlandChina=null(等待人工确认) |

**规则代码**:
```javascript
function classifyStoreByRules(slug, name, companyInfo, config) {
  // Rule 1-2: known list
  if (config.knownMainlandChinaSlugs?.includes(slug)) return { isMainlandChina: true, by: 'rule:known-list' };
  if (config.knownNonMainlandChinaSlugs?.includes(slug)) return { isMainlandChina: false, by: 'rule:known-list' };
  // Rule 3: CJK characters in name
  if (name && /[\u4e00-\u9fff]/.test(name)) return { isMainlandChina: true, by: 'rule:cjk-name' };
  // Rule 4-5: company country
  if (companyInfo?.country) {
    if (companyInfo.country === 'CN') return { isMainlandChina: true, by: 'rule:company-country' };
    return { isMainlandChina: false, by: 'rule:company-country' };
  }
  // Rule 6: no match
  return { isMainlandChina: null, by: null };
}
```

### 4.4 分类查询流程

```
checkStoreClassification(slug, name, companyInfo?):
  1. 查 L1 chrome.storage.local(key: jz-store-class-{slug})
     → 命中且 isMainlandChina !== null → 返回
  2. 查 L2 MongoDB ozon_store_classification
     → 命中且 isMainlandChina !== null → 写 L1 + 返回
  3. 跑规则引擎 classifyStoreByRules(slug, name, companyInfo, config)
     → isMainlandChina !== null → 写 L1 + L2 + 返回
  4. isMainlandChina === null → 写 L2 记录(isMainlandChina=null,等待人工确认)→ 返回 null
```

### 4.5 人工确认

当 `checkStoreClassification` 返回 `null`(isMainlandChina=null)时:

1. QX面板显示「店铺检测」区块:
   ```
   当前店铺: SANFALIYE (sanfaliye)
   状态: ⚠ 待确认
   [✓ 标记为中国大陆店铺] [✗ 标记为非中国大陆店铺] [跳过]
   ```

2. 用户点击按钮 → `sendMessage('classifyStore', {slug, name, isMainlandChina: true/false})`

3. SW 写 L1 chrome.storage + L2 MongoDB(`classifiedBy: 'manual'`)

4. 如果标记为中国大陆店铺 → 该页所有未采集 SKU 开始 autoCollect

5. 如果标记为非中国大陆店铺 → 该页不采集

### 4.6 与 autoCollect 的衔接

autoCollect action 入口新增 **Gate 0.5: 中国大陆店铺检查**:

```
autoCollect(sku, source, sellerSlug, ...):
  Gate 0: 总开关 + 冷却期 + 每日上限 + 跨日重置
  Gate 0.5: 中国大陆店铺检查
    const cls = await checkStoreClassification(sellerSlug, ...)
    if (config.onlyMainlandChinaStores && cls.isMainlandChina !== true) {
      writeLog({status:'skipped', reason: cls.isMainlandChina === false ? 'non-mainland-china-store' : 'unclassified-store'})
      return {status:'skipped', reason: cls.isMainlandChina === false ? 'non-mainland-china-store' : 'unclassified-store'}
    }
  Step 1-7: ...(同 V2)
```

**注**:Gate 0.5 在 Gate 0 之后、Step 1 之前执行。未分类店铺(null)不会触发采集,需人工确认后才能采集。

## 5. 限速机制

### 5.1 三层闸门

| 层 | 参数 | 默认值 | 作用域 | 说明 |
|---|---|---|---|---|
| 1 | `sellerPortalMinInterval` | 200ms | search+bundle+marketStats 真调 | 复用现有 `_sellerPortalGate` |
| 2 | `buyerPageMinInterval` | 500ms | entrypoint+composer+followSell 真调 | 新增 `_buyerPageGate` |
| 3 | `skuInterval` | 1000ms | autoCollect 逐 SKU 间隔 | 新增 `_autoCollectGate` |

### 5.2 反爬熔断

- 任一 SKU 采到 `ANTIBOT_BLOCKED` → 设 `pausedUntil = now + 10min`
- 冷却期内 `autoCollect` action 直接返回 `{status:'skipped', reason:'cooldown'}`

### 5.3 每日上限

- 每 SKU 成功采集后 `todayCount++`
- `todayCount >= perDayLimit` 时自动暂停,次日 0 点重置

### 5.4 去重与 stale

- `autoCollect` 入口先查 L1+L2 命中情况(8 类)
- 八类全命中(且无 stale) → 写 log `{status:'skipped', reason:'all-cached'}`,不真调
- stale 类目视为未命中,重新真调
- 用户可在 QX面板点「强制刷新当前页」绕过去重

## 6. 店铺页流程(详细)

### 6.1 触发链

```
用户访问 https://www.ozon.ru/seller/{slug}/products/
  ↓
manifest 注入 ozon-data-panel.js(已有)
  ↓
页面加载完成
  ↓
extractSellerInfoFromShopPage() → {slug, name, companyInfo}
  ↓
sendMessage('checkStoreClassification', {slug, name, companyInfo})
  ↓
SW 返回 {isMainlandChina, classifiedBy}
  ↓
QX面板更新店铺检测状态
  ↓
IntersectionObserver 监测商品卡
  ↓
商品卡进入视口
  ↓
loadPanelData(card, panel) 执行
```

### 6.2 loadPanelData 内部流程

```
loadPanelData(card, panel):
  Step 1: extractCardInfo(card) → { url, name, price, image }
  Step 2: extractProductId(info.url) → sku
  Step 3: cardCacheSet(已有,无条件写)
  Step 4: taskQueue 并行加载 panel 数据
          - getMarketStats → SW 内部写 marketStats 缓存
          - getProductStats
          - variantsQueue.add(searchVariants) → 写 search+bundle 缓存
          - followSellQueue.add(jzFetchPublicFollowSell) → 写 followSell 缓存
  Step 5: collectAutoIfMatched(productId, card, info, data, panel, 'shop-page', sellerSlug)
          - 检查 autoCollectRunning flag
          - 检查中国大陆店铺(isMainlandChina === true)
          - waitForCollectorFilterData
          - passCollectorFilters(仅抓有销量 + 智能筛选)
          - 通过 → autoCollectOnSkuSeen(sku, 'shop-page', sellerSlug) → SW autoCollect
```

### 6.3 店铺页 autoCollect 实际采集类目

| 类目 | 是否采 | 说明 |
|---|---|---|
| card | 已采(Step 3) | content 直写,无条件 |
| detail | **不采** | 店铺页无 PDP |
| composer | 采(中国大陆店铺 + 筛选通过时) | buyerPage 真调 |
| entrypoint | 采(同上) | buyerPage 真调(与 composer 同请求) |
| search | 已采(Step 4) | panel 渲染触发,autoCollect 命中跳过 |
| bundle | 已采(Step 4) | panel 渲染触发,autoCollect 命中跳过 |
| marketStats | 已采(Step 4) | panel 渲染触发,autoCollect 命中跳过 |
| followSell | 已采(Step 4) | panel 渲染触发,autoCollect 命中跳过 |

## 7. 详情页流程(详细)

### 7.1 触发链

```
用户访问 https://www.ozon.ru/product/{sku}/
  ↓
manifest 注入 ozon-product.js(已有)
  ↓
页面加载完成,DOM 就绪
  ↓
extractProductData() 执行
  ↓
返回 _product 对象(含 seller.name + seller.link)
  ↓
从 seller.link 提取 sellerSlug
  ↓
sendMessage('checkStoreClassification', {slug, name})
  ↓
SW 返回 {isMainlandChina, classifiedBy}
  ↓
QX面板更新店铺检测状态
```

### 7.2 extractProductData 内部流程

```
extractProductData():
  Step 1: DOM 解析(已有) → _product = { sku, url, title, price, images, seller, ... }
  Step 2: detailCacheSet(已有)
  Step 3: cardCacheSet(已新增)
  Step 4: 提取 sellerSlug(从 _product.seller.link)
          sendMessage('checkStoreClassification', {slug, name})
          → 更新 QX面板店铺检测状态
  Step 5: 【新增】autoCollectOnSkuSeen(sku, 'pdp', sellerSlug)
          详情页不经过销量/智能筛选(用户主动访问 PDP)
          但仍检查中国大陆店铺(Gate 0.5)
          fire-and-forget
```

### 7.3 详情页 autoCollect 实际采集类目

| 类目 | 是否采 | 说明 |
|---|---|---|
| card | 已采(Step 3) | content 直写 |
| detail | 已采(Step 2) | content 直写 |
| composer | 采(中国大陆店铺时) | buyerPage 真调 |
| entrypoint | 采(同上) | buyerPage 真调 |
| search | 采 | sellerPortal 真调(详情页无 panel 渲染) |
| bundle | 采 | sellerPortal 真调 |
| marketStats | 采 | sellerPortal 真调(详情页无 panel 渲染) |
| followSell | 采 | buyerPage 真调(详情页无 followSellQueue,autoCollect 补采) |

### 7.4 详情页的特殊优化

- **detail + card 已在 content 写完**,autoCollect 内部查这两类命中即跳过,只采剩 6 类
- **followSell 兜底**:详情页 hero 跟卖卡 hover 时 `jzShowFollowSellListModal` 会调 `jzFetchPublicFollowSell`,autoCollect 提前写好缓存正好命中

## 8. Service Worker autoCollect action 详细设计

### 8.1 消息协议

```javascript
// content → SW
sendMessage('autoCollect', {
  sku: "123456789",
  source: "shop-page" | "pdp",
  sellerSlug: "sanfaliye",
  depth: "Full",
  forceRefresh: false
})

// SW → content (response)
{
  status: "success" | "partial" | "skipped" | "failed" | "antibot",
  reason: "cooldown" | "all-cached" | "daily-limit" | "disabled"
          | "non-mainland-china-store" | "unclassified-store",
  results: [
    { type: "card",        hit: true,  source: "content" },
    { type: "detail",      hit: false, source: "n/a" },
    { type: "composer",    hit: false, source: "buyer-page", duration: 320 },
    { type: "entrypoint",  hit: false, source: "buyer-page", duration: 280 },
    { type: "search",      hit: false, source: "seller-portal", duration: 450 },
    { type: "bundle",      hit: false, source: "seller-portal", duration: 380 },
    { type: "marketStats", hit: false, source: "seller-portal", duration: 420 },
    { type: "followSell",  hit: false, source: "buyer-page", duration: 180 },
  ],
  totalDuration: 2030
}
```

### 8.2 执行流程

```
autoCollect(sku, source, sellerSlug, depth, forceRefresh):
  Gate 0: 总开关检查
    if (!config.autoCollectRunning) return {status:'skipped', reason:'disabled'}
    if (config.paused || now < config.pausedUntil)
      return {status:'skipped', reason:'cooldown'}
    if (config.todayDate !== today) { config.todayCount=0; config.todayDate=today }
    if (config.todayCount >= config.perDayLimit)
      return {status:'skipped', reason:'daily-limit'}
        ↓
  Gate 0.5: 中国大陆店铺检查(新增)
    const cls = await checkStoreClassification(sellerSlug, ...)
    if (config.onlyMainlandChinaStores && cls?.isMainlandChina !== true) {
      const reason = cls?.isMainlandChina === false ? 'non-mainland-china-store' : 'unclassified-store'
      writeLog({status:'skipped', reason, sellerSlug})
      return {status:'skipped', reason}
    }
        ↓
  Step 1: 三层缓存命中检查(并行查 8 类)
    for type in [card, detail, composer, entrypoint, search, bundle, marketStats, followSell]:
      hit = forceRefresh ? false : await _cacheGet(type, sku)
      // bundle: 空属性查 attrsEmptyVerifiedAt,6h 内视为 hit
      // marketStats: fetchedAt 超 24h 视为 miss(stale)
      // followSell: fetchedAt 超 4h 视为 miss(stale)
      results.push({type, hit})
        ↓
  Step 2: 计算待采类目
    pending = results.filter(r => !r.hit)
    if (pending.length === 0)
      writeLog({status:'skipped', reason:'all-cached'})
      return {status:'skipped', reason:'all-cached'}
        ↓
  Step 3: 进入 _autoCollectQueue(串行)
    await _autoCollectGate()
        ↓
  Step 4: 买家页采集(如 composer/entrypoint/followSell 未命中)
    await _buyerPageGate()
    const r = await fetchVariantMediaViaBuyerTab(
      `https://www.ozon.ru/product/${sku}/`, { includeFollowSell: true })
    if (r.endpoint === 'entrypoint-api') {
      await _entrypointCacheSet(sku, ...)
    }
    if (r.composerFields) {
      await _composerCacheSet(sku, r.composerFields)
    }
    if (r.followSellData) {
      await _followSellCacheSet(sku, r.followSellData)
    }
    if (r.antibot) goto ANTIBOT
        ↓
  Step 5: seller portal 采集(如 search/bundle 未命中)
    await _sellerPortalGate()
    const r = await searchVariants({sku, forceRefresh:false})
    if (r.antibot) goto ANTIBOT
        ↓
  Step 6: seller portal data/v3 采集(如 marketStats 未命中)
    await _sellerPortalGate()
    const marketData = await _fetchMarketStatsDirect(sku)
    if (!marketData) {
      results.find(r => r.type === 'marketStats').error = 'NO_DATA'
    } else if (marketData.__needSellerLogin) {
      results.find(r => r.type === 'marketStats').error = 'AUTH_REQUIRED'
    } else if (marketData.__antibot) {
      goto ANTIBOT
    } else {
      await _marketStatsCacheSet(sku, marketData)
    }
        ↓
  Step 7: 写 auto_collect_log + 更新内存计数器
    await _writeAutoCollectLog({sku, source, sellerSlug, depth, status, results, ...})
    _incrementMemCounter(status)
    config.todayCount++
    await chrome.storage.set(config)
        ↓
  return {status:'success'|'partial', results}

  ANTIBOT:
    config.pausedUntil = now + 10min
    await chrome.storage.set(config)
    chrome.runtime.sendMessage({type:'antibotDetected', pausedUntil})
    writeLog({status:'antibot'})
    return {status:'antibot'}
```

### 8.3 fetchVariantMediaViaBuyerTab 改造点

改造为一次借买家 tab 拿 3 类数据:

```
注入函数内执行 2 个 fetch(都是 www.ozon.ru 同源):
  1. entrypoint-api.bx → 抽 gallery/richContent/description/hashtags/mp4
     + 抽 fields(title/sku/price/images/...) + widgetStates
     → _entrypointCacheSet + _composerCacheSet
  2. /api/composer-api.bx/page/json/v2?url=/modal/otherOffersFromSellers?product_id=<sku>
     (复用 shared-utils.js fetchFollowSellFromModal 的 URL 和解析逻辑)
     → 抽 count + sellers[]
     → _followSellCacheSet
返回 { endpoint, composerFields, followSellData, antibot }
```

**注**:两个 fetch 都在买家 tab 上下文执行,共享 cookie/UA/fingerprint;followSell fetch 失败不影响 entrypoint/composer 写入(各自独立 try/catch)。

### 8.4 _fetchMarketStatsDirect 新增函数

**返回类型契约**:
- `{ __needSellerLogin: true, __reason }`:seller tab 不存在或未登录
- `{ __antibot: true }`:命中反爬
- `null`:data/v3 返回空(无 items)
- `NormalizedItem`(plain object):成功,归一化后的 18 字段 + category1/3/brand

**与 getMarketStats action 的关系**:getMarketStats action 改造为缓存感知,内部调用 _fetchMarketStatsDirect:

```
getMarketStats action (改造后):
  cached = await _marketStatsCacheGet(sku)
  if (cached && !_isStale(cached.fetchedAt, MARKET_STATS_STALE_MS)) return cached
  const data = await _fetchMarketStatsDirect(sku)
  if (data && !data.__needSellerLogin && !data.__antibot) {
    await _marketStatsCacheSet(sku, data)
  }
  if (!data || data.__needSellerLogin) {
    return await proxyMarketData(sku)  // 代采降级,仅 getMarketStats 用
  }
  return data
```

**关键差异**:不走 `proxyMarketData` 代采降级(autoCollect 有自己的冷却期+每日上限保护);getMarketStats action 保留代采降级以保障 panel 渲染可用性。

### 8.5 店铺分类查询与缓存

```javascript
// SW 新增 checkStoreClassification
async function checkStoreClassification(slug, name, companyInfo) {
  if (!slug) return null;
  const config = await _loadAutoCollectConfig();

  // L1: chrome.storage.local
  const l1Key = `jz-store-class-${slug}`;
  const l1 = await chrome.storage.local.get(l1Key);
  if (l1[l1Key]?.isMainlandChina !== undefined && l1[l1Key]?.isMainlandChina !== null) {
    return l1[l1Key];
  }

  // L2: MongoDB
  const l2 = await _erpStoreClassGet(slug);
  if (l2 && l2.isMainlandChina !== null && l2.isMainlandChina !== undefined) {
    await chrome.storage.local.set({ [l1Key]: l2 });
    return l2;
  }

  // Rule engine
  const rule = classifyStoreByRules(slug, name, companyInfo, config);
  if (rule.isMainlandChina !== null) {
    const record = {
      sellerSlug: slug, sellerName: name, isMainlandChina: rule.isMainlandChina,
      classifiedBy: rule.by, classifiedAt: new Date(),
      companyInfo: companyInfo || null, lastSeenAt: new Date(),
      lastSeenUrl: '',
    };
    await chrome.storage.local.set({ [l1Key]: record });
    await _erpStoreClassSet(slug, record);
    return record;
  }

  // Unclassified - save record for manual confirmation
  if (!l2) {
    const record = {
      sellerSlug: slug, sellerName: name, isMainlandChina: null,
      classifiedBy: null, classifiedAt: new Date(),
      companyInfo: companyInfo || null, lastSeenAt: new Date(),
      lastSeenUrl: '',
    };
    await _erpStoreClassSet(slug, record);
  }
  return null;
}
```

### 8.6 SW 内存计数器 + 环形缓冲

```javascript
_memCounter = {
  today: { success:0, skipped:0, failed:0, antibot:0, total:0 },
  byType: { card:0, detail:0, composer:0, entrypoint:0, search:0, bundle:0, marketStats:0, followSell:0 },
  bySource: { 'shop-page':0, 'pdp':0 },
  byStoreClass: { mainland-china:0, 'non-mainland-china':0, unclassified:0 },
  date: '2026-07-13'
}
_recentBuffer = []  // 环形,容量 50
```

### 8.7 syncL2Batch 扩展

```javascript
async function syncL2Batch(forceAll) {
  // 遍历 8 个 store(原 6 + 新 2)
  const stores = [
    { store: _IDB_STORE_SEARCH,       type: 'search' },
    { store: _IDB_STORE_BUNDLE,       type: 'bundle' },
    { store: _IDB_STORE_CARD,         type: 'card' },
    { store: _IDB_STORE_COMPOSER,     type: 'composer' },
    { store: _IDB_STORE_ENTRYPOINT,   type: 'entrypoint' },
    { store: _IDB_STORE_DETAIL,       type: 'detail' },
    { store: _IDB_STORE_MARKET_STATS, type: 'marketStats' },
    { store: _IDB_STORE_FOLLOW_SELL,  type: 'followSell' },
  ];
  // 逐 store 扫描未同步记录,补写 L2
}
```

## 9. QX采集器面板

### 9.1 定位

Ozon 页面上的浮动控制台,作为自动采集的主控台。从旧 MY采集器面板移植核心功能,数据落地改为 MongoDB 8 类缓存。新增店铺检测区块。

### 9.2 面板布局

```
┌─────────────────────────────────────────┐
│ 📦 QX采集器                       [−]   │  ← header
├─────────────────────────────────────────┤
│ ● 运行中              [■ 停止]           │  ← 状态行 + 主开关
│ 深度: Full · 今日: 156 / 2000           │
├─────────────────────────────────────────┤
│ 店铺检测                                 │  ← 新增区块
│ 当前店铺: SANFALIYE (sanfaliye)          │
│ 状态: ✓ 中国大陆店铺 (规则:cjk-name)        │
│ [重新分类]                               │
│ ─ 或 ─                                  │
│ 状态: ⚠ 待确认                          │
│ [✓ 标记中国大陆] [✗ 标记非中国大陆]              │
├─────────────────────────────────────────┤
│ 今日统计                                 │
│ ┌───────┬───────┬───────┬───────┐       │
│ │ 成功  │ 跳过  │ 失败  │ 熔断  │       │
│ │  142  │  12   │   2   │   0   │       │
│ └───────┴───────┴───────┴───────┘       │
│ 成功率: 91%                              │
├─────────────────────────────────────────┤
│ [✓] 自动翻页   [✓] 仅抓有销量           │
│ [✓] 只采集中国大陆店铺                      │  ← 新增开关
├─────────────────────────────────────────┤
│ 智能筛选: 未配置        [筛选设置]       │
├─────────────────────────────────────────┤
│ 缓存类目命中(今日,8 类)                │
│ card ✓ 142      detail ✓ 50             │
│ composer ✓ 142  entrypoint ✓ 142        │
│ search ✓ 142    bundle ✓ 140            │
│ marketStats ✓ 138  followSell ✓ 135     │
│ (stale 标橙色:marketStats 24h/followSell 4h)│
├─────────────────────────────────────────┤
│ 最近采集 (5)                             │
│ ┌─────────────────────────────────┐     │
│ │ SKU 1234... · 店铺页 · 1.2s · ✓ │     │
│ │ SKU 5678... · 详情页 · 0.8s · ✓ │     │
│ │ SKU 9012... · 详情页 · 跳过     │     │
│ └─────────────────────────────────┘     │
├─────────────────────────────────────────┤
│ [强制刷新当前页]  [查看ERP]              │
├─────────────────────────────────────────┤
│ (toast 提示区)                           │
└─────────────────────────────────────────┘
```

### 9.3 店铺检测区块状态

| isMainlandChina | 显示 | 可操作 |
|---|---|---|
| `true` | ✓ 中国大陆店铺 (规则:xxx) 或 (人工确认) | [重新分类] |
| `false` | ✗ 非中国大陆店铺 (规则:xxx) 或 (人工确认) | [重新分类] |
| `null` | ⚠ 待确认 | [✓ 标记中国大陆] [✗ 标记非中国大陆] |
| 未检测 | — 等待页面加载 — | 无 |

### 9.4 数据来源与刷新机制

| 数据 | 来源 | 刷新方式 |
|---|---|---|
| 店铺检测状态 | content script 提取后 sendMessage | 页面加载时拉一次 + 手动分类后更新 |
| 总开关/深度/今日计数/熔断状态 | SW `autoCollectGetConfig` | mount 时 + 5s 轮询 + SW 推送 |
| 今日统计 | SW `autoCollectGetStats` | 5s 轮询 |
| 各类目命中数(8 类) | SW `autoCollectGetStats` | 5s 轮询 |
| 最近采集列表 | SW `autoCollectGetRecent` | 5s 轮询 + SW 推送 |

### 9.5 SW 新增 action

| action | 入参 | 返回 | 说明 |
|---|---|---|---|
| `checkStoreClassification` | `{slug, name, companyInfo?}` | `{isMainlandChina, classifiedBy} \| null` | 查询店铺分类 |
| `classifyStore` | `{slug, name, isMainlandChina}` | `{ok}` | 人工确认分类 |
| `autoCollectGetConfig` | - | `{enabled, autoCollectRunning, depth, paused, pausedUntil, todayCount, perDayLimit, todayDate, onlyMainlandChinaStores, ...}` | 当前配置 |
| `autoCollectSetConfig` | `{enabled?, autoCollectRunning?, paused?, depth?, onlyMainlandChinaStores?, ...}` | `{ok}` | 修改配置 |
| `autoCollectGetStats` | - | `{today, byType(8类), bySource, byStoreClass, successRate}` | 今日统计 |
| `autoCollectGetRecent` | `{limit?:5}` | `[{sku,source,status,duration,timestamp}]` | 最近采集 |
| `autoCollectForceRefreshPage` | - | `{ok}` | 清空去重 + 重发 forceRefresh |

## 10. 智能筛选

### 10.1 筛选字段(18 个 range + 1 个 brand + 1 个 shippingMode)

| 字段 key | 含义 | 缓存支撑 |
|---|---|---|
| soldCount | 月销量 | marketStats |
| gmvSum | 月销售额 | marketStats |
| price | 价格 | card / marketStats |
| weight | 重量 | bundle |
| listedDays | 上架天数 | marketStats |
| monthlyTurnoverDynamic | 月周转动态 | marketStats |
| adCostRatio | 广告费占比 | marketStats |
| promoDays | 促销天数 | marketStats |
| promoDiscount | 促销折扣 | marketStats |
| promoConversionRate | 促销转化率 | marketStats |
| paidPromotionDays | 付费推广天数 | marketStats |
| views | 浏览量 | marketStats |
| cardAddToCartRate | 商品卡加购率 | marketStats |
| searchCatalogViews | 搜索目录浏览量 | marketStats |
| searchCatalogAddToCartRate | 搜索目录加购率 | marketStats |
| displayConversionRate | 展示转化率 | marketStats |
| returnCancelRate | 退货取消率 | marketStats |
| followerCount | 跟卖人数 | followSell |
| lowestFollowerPrice | 跟卖最低价 | followSell |

Select 字段:
- `shippingMode`: FBS / FBO / 不限
- `brandOption`: 有品牌 / 无品牌 / 不限

### 10.2 三层过滤体系

```
collectAutoIfMatched(productId, card, info, data, panel, source, sellerSlug):
  if (!autoCollectRunning) return false
  // Layer 1: 中国大陆店铺(已在 autoCollect Gate 0.5 检查,此处不重复)
  // Layer 2: 仅抓有销量
  if (onlyWithSales && !(data.soldCount > 0)) return false
  // Layer 3: 智能筛选
  if (!smartFilterState.enabled) return true
  return smartMatches(data, info)
```

**注**:详情页跳过 Layer 2/3,但保留 Layer 1(中国大陆店铺检查在 SW Gate 0.5)。

## 11. 文件结构

### 11.1 新增文件

```
qx-ozon/content/qx-collector/
  panel.js           ← QX采集器面板(含店铺检测 + 智能筛选)
  panel.css          ← 面板样式(.qx-c-* 前缀)
  auto-scroller.js   ← 自动翻页
  smart-filter.js    ← 智能筛选逻辑
  store-detector.js  ← 店铺信息提取 + 中国大陆店铺检测 UI(新)
```

### 11.2 移除的旧模块

| 模块 | 处理 |
|---|---|
| `content/collector/db.js` | 移除 |
| `content/collector/panel.js` / `panel.css` | 替换为 qx-collector |
| `content/collector/keyword-pilot.js` | 移除 |
| `content/collector/anti-ban.js` | 移除 |
| `content/collector/l1-*.js` | 移除 |
| `content/collector/task-queue.js` | 保留 |

## 12. ERP 后端接口

### 12.1 新增缓存端点(marketStats / followSell)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ozon/cache/marketStats/:sku` | 查 marketStats 缓存(返回 `stale` 字段) |
| POST | `/ozon/cache/marketStats/:sku` | 写 marketStats 缓存 |
| DELETE | `/ozon/cache/marketStats/:sku` | 删 marketStats 缓存 |
| GET | `/ozon/cache/followSell/:sku` | 查 followSell 缓存(返回 `stale` 字段) |
| POST | `/ozon/cache/followSell/:sku` | 写 followSell 缓存 |
| DELETE | `/ozon/cache/followSell/:sku` | 删 followSell 缓存 |

### 12.2 新增店铺分类端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ozon/store-classification/:slug` | 查店铺分类 |
| POST | `/ozon/store-classification/:slug` | 写/更新店铺分类 |
| GET | `/ozon/store-classification` | 列表(支持 isMainlandChina 筛选 + 分页) |
| DELETE | `/ozon/store-classification/:slug` | 删除分类 |

### 12.3 新增采集日志端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/auto-collect/stats` | 今日/本周统计(含 8 类 byType + byStoreClass) |
| GET | `/admin/api/auto-collect/logs` | 日志列表(支持 sku/status/source/sellerSlug 筛选+分页) |
| GET | `/admin/api/auto-collect/logs/:sku` | 某 SKU 的采集历史 |
| POST | `/admin/api/auto-collect/log` | SW 写入日志(JWT 鉴权) |

### 12.4 MongoDB collection 名

```javascript
export const cols = {
  searchCache:        () => getMongo().then((d) => d.collection('ozon_search_cache')),
  bundleCache:        () => getMongo().then((d) => d.collection('ozon_bundle_cache')),
  cardCache:          () => getMongo().then((d) => d.collection('ozon_card_cache')),
  composerCache:      () => getMongo().then((d) => d.collection('ozon_composer_cache')),
  entrypointCache:    () => getMongo().then((d) => d.collection('ozon_entrypoint_cache')),
  detailCache:        () => getMongo().then((d) => d.collection('ozon_detail_cache')),
  marketStatsCache:   () => getMongo().then((d) => d.collection('ozon_market_stats_cache')),
  followSellCache:    () => getMongo().then((d) => d.collection('ozon_follow_sell_cache')),
  storeClassification:() => getMongo().then((d) => d.collection('ozon_store_classification')),  // 新
  autoCollectLog:     () => getMongo().then((d) => d.collection('ozon_auto_collect_log')),
};
```

## 13. 落地任务拆解

| 阶段 | 任务 | 文件 | 依赖 |
|---|---|---|---|
| **P0** | SW IndexedDB 升级 v6 + 8 类缓存读写函数 | service-worker.js | - |
| P0 | SW 新增三层限速闸门 | service-worker.js | - |
| P0 | SW 改造 fetchVariantMediaViaBuyerTab 三合一 | service-worker.js | P0 缓存函数 |
| P0 | SW 新增 _fetchMarketStatsDirect + 改造 getMarketStats | service-worker.js | P0 缓存函数 |
| P0 | SW 新增店铺分类查询 + 规则引擎 | service-worker.js | - |
| P0 | SW 新增 autoCollect action(含 Gate 0.5 中国大陆店铺检查) | service-worker.js | P0 闸门 + 缓存 + 分类 |
| P0 | ERP 新增 marketStats/followSell 6 个缓存端点 | cache.js + mongo.js | - |
| P0 | ERP 新增 store_classification collection + 4 个端点 | cache.js + mongo.js | - |
| P0 | ERP 新增 auto_collect_log collection + 4 个接口 | cache.js | - |
| P0 | SW syncL2Batch 扩展为 8 类 | service-worker.js | P0 缓存函数 |
| **P1** | shared-utils 新增 autoCollectOnSkuSeen + collectAutoIfMatched | shared-utils.js | P0 |
| P1 | shared-utils 新增 extractSellerInfoFromShopPage | shared-utils.js | - |
| P1 | shared-utils 改造 jzFetchPublicFollowSell 写 followSell 缓存 | shared-utils.js | P0 |
| P1 | ozon-data-panel.js 店铺页接入(提取卖家信息 + Step 5) | ozon-data-panel.js | P1 |
| P1 | ozon-product.js 详情页接入(提取 sellerSlug + Step 5) | ozon-product.js | P1 |
| **P1.5** | qx-collector/store-detector.js 创建 | qx-collector/store-detector.js | - |
| P1.5 | qx-collector/smart-filter.js + auto-scroller.js | qx-collector/ | - |
| P1.5 | qx-collector/panel.js + panel.css(含店铺检测区块) | qx-collector/panel.js | store-detector + smart-filter |
| P1.5 | SW 新增 7 个 action(含 checkStoreClassification/classifyStore) | service-worker.js | P0 |
| P1.5 | ozon-data-panel.js / ozon-product.js 接入 QX面板 | content scripts | P1.5 panel |
| P1.5 | 移除旧 collector 模块 + manifest 调整 | manifest.json | P1.5 接入完成 |
| **P2** | popup 新增自动采集区块 | popup.html + popup.js | P0 |
| **P3** | ERP overview 页新增自动采集 tab + 店铺分类 tab | Cache.vue + api | P0 ERP 接口 |
| P3 | 强制刷新当前页按钮接线 | shared-utils.js | P1.5 |
| **收尾** | 端到端验证 + 代码质量 | - | 全部完成 |

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| seller portal 反爬升级 | 反爬即熔断 10min |
| MongoDB 写入压力(8 类 + 分类) | L2 异步 fire-and-forget |
| 中国大陆店铺规则误判 | 规则只做正向判定(CJK 字符/已知列表),无把握的走人工确认;用户可随时重新分类 |
| 店铺页 DOM 结构变更导致 sellerName 提取失败 | 多级兜底(DOM → h1 → meta → slug);slug 始终可从 URL 提取 |
| seller slug 变更(Ozon 改 URL) | slug 是 Ozon 内部标识,较稳定;若变更,旧分类记录失效但不影响新 slug 重新分类 |
| fetchVariantMediaViaBuyerTab 改造影响视频转存 | 保留原有 entrypoint 写入,只追加 composer + followSell |
| marketStats data/v3 真调失败 | 不熔断,返回 partial |
| IndexedDB v6 升级失败 | onupgradeneeded 只 createObjectStore 不删旧 store |

## 15. 验收标准

- [ ] 店铺页浏览中国大陆店铺 10 SKU → 八类缓存各 10 条(detail 空),log 10 条
- [ ] 详情页浏览中国大陆店铺 10 SKU → 八类缓存各 10 条(含 detail)
- [ ] 店铺页浏览非中国大陆店铺 → 不触发 autoCollect,log 记 `non-mainland-china-store`
- [ ] 店铺页浏览未分类店铺 → QX面板显示「待确认」,不触发 autoCollect
- [ ] 人工标记未分类店铺为中国大陆店铺 → 该页 SKU 开始采集
- [ ] 人工标记中国大陆店铺为非中国大陆店铺 → 该页后续 SKU 不采集
- [ ] 规则自动判定:CJK 店名 → 自动标记为中国大陆店铺
- [ ] 规则自动判定:knownNonMainlandChinaSlugs → 自动标记为非中国大陆店铺
- [ ] 重复浏览同 SKU(24h 内) → log 记 all-cached,零真调
- [ ] marketStats 缓存超 24h → stale,重新真调
- [ ] followSell 缓存超 4h → stale,重新真调
- [ ] QX面板主开关关闭 → 不触发 autoCollect
- [ ] QX面板「只采集中国大陆店铺」开关关闭 → 非中国大陆店铺也采集
- [ ] QX面板勾选「仅抓有销量」→ 无销量 SKU 不触发(仅店铺页,详情页不受限)
- [ ] QX面板配置智能筛选 → 不符合条件 SKU 不触发(仅店铺页)
- [ ] QX面板勾选「自动翻页」→ AutoScroller 滚动加载更多
- [ ] 反爬命中 → 熔断 10min
- [ ] 每日上限达 2000 → 自动暂停
- [ ] QX面板「强制刷新当前页」→ 重新真调写入 8 类
- [ ] QX面板缓存类目命中显示 8 类(marketStats/followSell stale 标橙色)
- [ ] ERP overview 页「自动采集」tab 可见统计 + 日志(含 sellerSlug 列)
- [ ] ERP overview 页「店铺分类」tab 可见分类列表(支持 isMainlandChina 筛选)
- [ ] ERP cache overview 显示 8 类缓存矩阵
- [ ] popup「同步缓存」按钮同步 8 类 L1 → L2
- [ ] 旧 collector 模块已移除,无残留引用
- [ ] 搜索页不触发 autoCollect(已移除搜索页采集)
