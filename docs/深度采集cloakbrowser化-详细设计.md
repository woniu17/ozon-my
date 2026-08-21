# 深度采集 cloakbrowser 化 — 详细设计文档

> 版本：v2.0（重大修订：数据通道 SQLite 直写 → ERP API + 服务 API Key 鉴权）
> 日期：2026-08-21
> 模块：qxqx/deep-collect.js（无头深度采集）
> 前置文档：《深度采集cloakbrowser化-概要设计》v2.0（§3.2 鉴权设计为本版前置）
> 语义基准：qx-ozon/collect/background/collect-tab.js `_doAutoCollect`（编排/门控/缓存写入格式）
> 骨架基准：qxqx/shallow-collect.js（.env/单实例锁/熔断/统计输出；数据通道改为 ERP API）

---

## 1. 文件结构与运行环境

```
qxqx/
├── deep-collect.js        # 新增:本设计主体(单文件,~1100 行)
├── shallow-collect.js     # 既有:浅采(不变)
├── .env.example           # 追加深采配置段(ERP_BASE_URL/ERP_API_KEY/...)
├── .deep-collect.lock     # 运行时单实例锁(自动创建/释放)
└── ../qx-ozon/lib/        # 只读复用:ozon-video-extract.js / follow-sell-content-copy.js
                            # (page.addScriptTag 注入买家页,见 §5.2)
```

- **运行**：`node deep-collect.js`（与浅采一致的启动方式，读 `.env`）
- **Node 侧**：Node ≥ 22 原生 `fetch`（ERP HTTP Client，见 §6）+ cloakbrowser
  `launchPersistentContext`（对齐 shallow-collect.js 现有用法）
- **数据通道**：全部读写走 ERP HTTP API（`ERP_BASE_URL` + `x-api-key` 头），
  不打开 erp.db，无 SQLite 依赖——脚本可跨机部署

---

## 2. 运行时模型

### 2.1 浏览器生命周期

```
启动
 ├─ 1. 加载 .env + 解析配置(§8)
 ├─ 2. 单实例锁(.deep-collect.lock,pid 校验)
 ├─ 3. ERP 连通性探测:GET /health(public 路径) + POST claim 探活(x-api-key 校验)
 │      · key 无效/服务不可达 → 明确报错退出(提示两侧 .env 配置)
 ├─ 4. 预加载内存配置:类目黑名单(GET /admin/api/filtered-categories,启动一次)
 ├─ 5. launchPersistentContext(PROFILE_DIR, headless, viewport)
 ├─ 6. warmup(§2.3):双页就绪 + 登录态探测
 └─ 7. 主循环(§3.1)
退出(SIGINT/Ctrl+C / 队列排空 / TASK_LIMIT 达成 / AUTH 超限)
 ├─ 当前 running 任务 → 回 pending(attempts 保留, createdAt=now 塞队尾,经 ERP API)
 ├─ 关闭 context → 释放锁 → 输出运行统计
```

### 2.2 双页管理

| 页 | 创建时机 | URL 策略 | 存活周期 |
|---|---|---|---|
| `sellerPage` | 启动时 | 常驻 `seller.ozon.ru/app/`（避免 signin 中间页），崩溃/导航异常时重开 | 整个运行期 |
| `buyerPage` | 启动时 | 逐 SKU 导航 `www.ozon.ru/product/<sku>`（对齐插件 `ensureBuyerTab` 语义） | 整个运行期（页面实例复用，只换导航目标） |

- buyerPage 每次 goto：`waitUntil: 'domcontentloaded'` + 固定等待 3s
  （反爬挑战挂载 + widget 渲染，对齐插件 ensureBuyerTab 的 sleep(3000)）
- 导航失败/超时（30s）：按临时性错误走 partial，不熔断

### 2.3 warmup（启动 + 熔断恢复共用）

```
warmup():
  1. buyerPage.goto('https://www.ozon.ru') → domcontentloaded + 3s
     · 命中挑战页(title/内容判定) → 等 CHALLENGE_WAIT_MS(默认 15s)重试一次
  2. sellerPage.goto('https://seller.ozon.ru/app/') → domcontentloaded
     · 页内读 document.cookie,提取 sc_company_id
     · 无 sc_company_id → AUTH_REQUIRED(§7.1 流程)
  3. 返回 { companyId } 缓存于内存
```

运行中每次 Step 3 marketStats 调用前**不重复探测**；company_id 从注入函数内实时读
`document.cookie`（与插件 fetchMarketStatsDirect 同口径，cookie 刷新自动跟随）。

---

## 3. 主循环与编排

### 3.1 主循环伪码

```
mainLoop:
  while true:
    if taskLimitReached: break
    task = erp.claimTask()               # §6.1 POST claim;null → 空转等待(见下)
    if !task:
        连续 CLAIM_EMPTY_WAIT_MS(默认 60s)无任务 → break(队列排空/被其他消费者持有时分流)
        sleep(5000); continue
    if ONLY_MAINLAND_CHINA && !await erp.isMainlandChinaSeller(task.sellerId):
        finalize(task, { status:'skipped', reason:'non-mainland-china-store', results:[] })
        continue
    result = await doAutoCollect(task)    # §3.2
    finalize(task, result)                # §6.2/6.3 + 日志(§6.4),全部经 ERP API
    if result.signal == 'AUTH_REQUIRED':  handleAuthWait()   # §7.2;超限退出
    if result.signal == 'ANTIBOT':        handleAntibotPause()  # §7.2;warmup 后续采
    if taskLimitReached: break
    sleep(random(SKU_INTERVAL_MIN_MS, SKU_INTERVAL_MAX_MS))
```

### 3.2 `doAutoCollect(task)` 编排（对齐 `_doAutoCollect` 七类结果）

返回结构（与插件 collectResult 同构）：

```js
{
  status: 'success' | 'partial' | 'skipped',
  reason?: string,            // partial/skipped 时的原因码(见 §3.2 各门控)
  error?:  string,            // partial 时的错误描述(如 'AUTH_REQUIRED'/'ANTIBOT')
  signal?: 'AUTH_REQUIRED'|'ANTIBOT',   // 需主循环处理的信号(§7.2);finalize 后触发
  results: [                  // 对齐 ozon_auto_collect_log.results
    { type: 'card'        , hit: true|false },
    { type: 'detail'      , hit: true|false },   // 本方案新增真采
    { type: 'richMedia'   , hit, error? },
    { type: 'search'      , hit, error? },
    { type: 'bundle'      , hit, error? },
    { type: 'marketStats' , hit, error? },
    { type: 'followSell'  , hit, error? },
  ],
  totalDuration: ms,
}
```

> hit 标记统一在 Step 1 按缓存命中初始化（含 search/bundle——门控 B/C 以 hit 判定，
> 缓存命中必须置 true 才不会被误判 no-search-data），真调成功后按需更新。

```
doAutoCollect(task):
  t0 = now(); sku = task.sku
  # ── Step 1:缓存查询(ERP API 并行 GET,命中即跳过) ─────────────
  [domR, attrR, richR, mstatsR, fsR] = await Promise.all([
    erp.getDomCache(sku),            # GET /ozon/cache/dom/:sku
    erp.getAttributeCache(sku),      # GET /ozon/cache/attribute/:sku
    erp.getRichMediaCache(sku),      # GET /ozon/cache/richMedia/:sku
    erp.getMarketStatsCache(sku),    # GET /ozon/cache/marketStats/:sku
    erp.getFollowSellCache(sku),     # GET /ozon/cache/followSell/:sku
  ])
  cached = {
    dom: domR,                        # { card_data, detail_data }
    attrs: attrR,                     # { searchData, bundleData, bundleId, attrsEmptyVerifiedAt, stale }
    rich: richR?.data, mstats: mstatsR?.data, fs: fsR?.data,
  }
  results.card.hit       = !!cached.dom?.card_data
  results.detail.hit     = !!cached.dom?.detail_data
  results.richMedia.hit  = !!cached.rich
  results.followSell.hit = !!cached.fs
  results.marketStats.hit = !!cached.mstats
  results.search.hit     = !!cached.attrs?.searchData
  results.bundle.hit     = bundleUsable(cached.attrs)          # §4.5:空 attrs 6h 重验(用 API 返回的 stale)
  # search/bundle 缓存命中仅决定"是否真调",门控 B/C 以 hit 判定
  # (与插件口径一致:缓存全命中 → all-cached success)

  # ── Step 3:marketStats(门控A,对齐插件 L1944-1966) ─────────────
  if !cached.mstats:
    ms = await portalFetchMarketStats(sku)        # §5.1, sellerPage
    if ms.authRequired: return partial('market-stats-failed', err='AUTH_REQUIRED', signal='AUTH_REQUIRED')
    if ms.antibot:     return partial('market-stats-failed', err='ANTIBOT', signal='ANTIBOT')
    if !ms.ok:         return partial('market-stats-failed', err=ms.reason)   # 临时失败
    await erp.setMarketStatsCache(sku, ms.data)   # POST /ozon/cache/marketStats/:sku(HTTP 200 即写,含 __empty)
    results.marketStats.hit = true
  if marketStatsGateEnabled && isNoData(currentMarketData):
    return skipped('no-market-stats')             # __empty/null 判定见 §4.1

  # ── Step 4:search + bundle(门控B/C,对齐插件 L1970-2185) ────────
  searchVariant = cached.attrs?.searchData?.items?.[0] || null
  if !results.search.hit:
    se = await portalFetchSearch(sku)            # §5.1
    if se.authRequired: return partial('search-failed', err='AUTH_REQUIRED', signal='AUTH_REQUIRED')
    if se.antibot:     return partial('search-failed', err='ANTIBOT', signal='ANTIBOT')
    if !se.ok:         results.search.error = se.reason        # 临时失败,由门控B判定
    elif !se.rawVariants?.length:
        # HTTP 200 但无 variants(永久性):不标 error → 门控B no-search-data
        searchVariant = null
    else:
        searchVariant = se.rawVariants[0]
        await erp.setAttributeCache(sku, 'search', { items: se.rawVariants })   # POST,方案B 原始数组
        results.search.hit = true
  bundleDataRef = bundleUsable(cached.attrs) ? cached.attrs.bundleData : null
  # bundle 补采:search 已获取(hit 或缓存)但 bundle 未获取/不可用 → 单独真调
  # (保证 partial 重试时能只补 bundle,无需重采 search)
  if results.search.hit && !results.bundle.hit:
    variantId = searchVariant?.variant_id
    if variantId:
      bu = await portalFetchBundle(variantId)      # §5.1
      if bu.authRequired: return partial('bundle-failed', err='AUTH_REQUIRED', signal='AUTH_REQUIRED')
      if bu.antibot:     return partial('bundle-failed', err='ANTIBOT', signal='ANTIBOT')
      if !bu.ok:         results.bundle.error = bu.reason      # 临时失败,由门控C判定
      elif bu.item:
          await erp.setAttributeCache(sku, 'bundle', bu.item, bu.bundleId)   # POST,空属性时 DAO 附 attrs_empty_verified_at
          bundleDataRef = bu.item; results.bundle.hit = true
      # bu.item 为 null(HTTP 200 无数据,永久性):不标 error → 门控C non-ultra-light
    # 无 variant_id(数据异常,重试无益):不标 error → 门控C non-ultra-light

  # 门控B:类目过滤
  if categoryFilterGateEnabled:
    if results.search.error: return partial('search-failed')
    if !results.search.hit:  return skipped('no-search-data')
    { descCatId, typeId } = extractCategoryIds(searchVariant, bundleDataRef)   # §3.4
    if isCategoryFiltered(descCatId, typeId, filterMap): return skipped('filtered-category')

  # 门控C:超轻小件
  if ultraLightGateEnabled:
    if results.bundle.error:  return partial('bundle-failed')
    if results.search.error:  return partial('search-failed')   # 仅门控B关闭时可达
    if !isUltraLight(bundleDataRef): return skipped('non-ultra-light')   # §3.4

  # ── Step 5:买家页(richMedia + followSell + detail) ───────────
  if !results.richMedia.hit || !results.detail.hit || !results.followSell.hit:
    await buyerPage.goto(productUrl(sku))        # §2.2 导航语义
    await injectBuyerHelpers()                   # §5.2 addScriptTag 两个 lib
    [mediaRes, fsRes, jsonld] = await Promise.all([
      evalPdpMedia(sku),                         # §5.3
      evalFollowSellModal(sku),                  # §5.4
      evalJsonLd(),                              # §5.5
    ])
    if mediaRes.anyOk: await erp.setRichMediaCache(sku, buildRichMedia(mediaRes, sku))   # §4.3
    if fsRes.ok:      await erp.setFollowSellCache(sku, fsRes.followSellData)           # §4.4
    detail = buildDetailData(mediaRes, jsonld, fsRes, sku)                    # §4.2
    if detail:       await erp.setDomCache(sku, 'detail', detail)
    results.richMedia.hit = results.richMedia.hit || mediaRes.anyOk
    results.followSell.hit = results.followSell.hit || fsRes.ok
    results.detail.hit = results.detail.hit || !!detail
  # Step5 各子项 best-effort 降级:失败不标 error、不阻断 → 照常 success

  # ── Step 6:完成(无本地收尾——缓存已逐条写入,索引聚合由 ERP DAO 自动触发) ──
  return { status: 'success', results, totalDuration: now()-t0 }
```

> 注 1：`finalize(task, result)`（§3.1 主循环）统一负责**所有终态**（success/partial/skipped）
> 的任务状态更新（§6.2/6.3）+ 深度采集日志写入（§6.4）——对齐插件"每个 return 路径
> 都写 ozon_auto_collect_log"的行为（含 partial/skipped 原因码）。finalize 完成后若
> `result.signal` 存在，触发 §7.2 信号处理（AUTH 等待 / ANTIBOT 熔断）。
>
> 注 2：缓存写入采用"即时逐条 POST"。单 SKU 周期内多条写天然串行；异常中断时已写缓存
> 是"部分完成"状态（任务停留 running，由 stale-reset 回 pending），下次重试按缓存命中
> 跳过——与插件行为一致（插件也是逐步写缓存）。
>
> 注 3：ERP API 写入失败（ERP_API_FAILED）按 §7.1 分类矩阵处理：请求级重试 1 次，
> 仍失败时——缓存写入失败视为临时失败（partial 回队重试）；finalize 写终态失败时
> 任务停留 running 由 stale-reset 兜底回收。

### 3.3 全缓存命中短路

Step 1 后若 `card/detail/richMedia/followSell/marketStats/search/bundle` 全部命中：
直接返回 `{ status: 'success', results, reason: 'all-cached', totalDuration: 0 }`
（对齐插件 all-cached 分支），仍写一条 autoCollectLog（reason='all-cached'）。

### 3.4 门控判定细则（原样移植 collect-runner.js）

**`extractCategoryIds(searchVariant, bundleData)`**（L470-507）：

```js
typeId   = Number(searchVariant?.description_type_dict_value) > 0 ? …          // 字段名误用,实际是 type_id
         : Number(bundleData?.type_id) > 0 ? … : 0                             // bundle 兜底(几乎总为空)
descCatId = searchVariant?.categories 中 level===3 的类目 id                    // OPI 字典要求 level_3_id
         || bundleData?.description_category_id                                 // 通常是 level_4,不保证正确
         || searchVariant?.categories 最深层类目 id
```

**`isCategoryFiltered(descCatId, typeId, filterMap)`**（L455-462）：

```js
filterMap = Map<descCatId, Set<typeId>>          // 启动时 GET /admin/api/filtered-categories 构建为内存 Map
命中 = typeSet.has(Number(typeId)) || typeSet.has(0)   // typeId=0 条目 = 单维度(仅类目)过滤
```

**`isUltraLight(bundleData)`**（L513-523，阈值与 index-dao.js buildFilterWhere 一致，
Ozon Extra Small 官方标准）：

```js
weight/depth/width/height 任一缺失、非法或 ≤0 → false(视为非超轻)
weight < 500(g) && (depth + width + height) < 900(mm) → true
```

---

## 4. 数据结构定义

> 本章定义 **API 请求体格式**（与 ERP cache.js 各 POST 端点的 body 契约一致；
> 表内归一化/字段结构与插件写入语义完全对齐，DAO 层落库细节由 ERP 保证）。

### 4.1 marketStats 缓存（POST /ozon/cache/marketStats/:sku）

```js
// body = { data: normalizeMarketItem(item) 归一化对象(移植 collect-tab.js L49-86) }
{
  ...rawItem,
  soldCount, gmvSum, avgPrice, salesDynamics, drr,
  avgOrdersOnAccDays, avgGmvOnAccDays,
  daysInPromo, discount, promoRevenueShare, daysWithTrafarets,
  qtyViewPdp, sessionCount, sessionCountSearch,
  pdpToCartConversion, convToCartPdp, convToCartSearch, convViewToOrder, views,
  stock, salesSchema, nullableRedemptionRate, nullableCreateDate,
}
// 无数据标记:data.__empty = true(response.items 为空时仍写缓存,对齐插件)
// fetchedAt 由 DAO 侧填充;l2Synced = 0
```

### 4.2 detail（POST /ozon/cache/dom/:sku，type='detail'，本方案新增真采）

来源优先级：**page json widgetStates（主）→ jsonLd（兜底）**，零增量请求
（widgetStates 即 Step 5 richMedia 已获取的响应；jsonLd 为页面 DOM `<script type="application/ld+json">`）。

| detail 字段 | 主来源（widgetStates） | jsonLd 兜底 |
|---|---|---|
| title | webProductHeading.title | name |
| images | webGallery.images[] | image[] |
| videos | mediaRes.mp4 → `[mp4]` | — |
| sku | urlSku | sku |
| productId | webGallery.sku / webDetailSKU.sku | — |
| brand | webBrand.title | brand.name |
| category | —（widget 无稳定来源） | category（缺失置空） |
| characteristics | webCharacteristics / webShortCharacteristics(原始透传) | — |
| price | webPrice.cardPrice | offers.price |
| walletPrice | webPrice(OzonCard 价,存在则取) | — |
| originalPrice | webPrice.originalPrice | — |
| seller | webCurrentSeller → `{name, link}` | — |
| statistics | webReviewProductScore(存在则透传) | aggregateRating |
| freeRest | —（无稳定来源,置 null） | — |
| followSellCount | fsRes.followSellData.count | — |
| followSellMinPrice | min(sellers[].price 数值化) | — |
| deliveryMode | —（置空） | — |
| rating | webReviewProductScore.score | aggregateRating.ratingValue |
| reviewCount | webReviewProductScore.reviewCount | aggregateRating.reviewCount |

写入：`POST /ozon/cache/dom/:sku` body `{ type: 'detail', data }`（ERP domDao.upsertDetail
只更新 detail_data/detail_fetched_at，不动 card_data，行不存在时自动建行）。
detail 提取为空（页面加载失败）不视为 partial（best-effort，对齐 richMedia 降级语义）。

### 4.3 richMedia 缓存（POST /ozon/cache/richMedia/:sku）

```js
// body = { data: 以下结构 }(对齐 collect-tab.js L1180-1191 合并写入格式)
{
  mp4, richContent, richContentHasText,
  description, descriptionSource, hashtags,
  gallery: fields.images,           // webGallery 图片数组
  fields: {                         // L1140-1151 fields 提取(原样移植)
    title, sku, productId, price, images, coverImage,
    aspects, seller: {name, link}, brand, shortCharacteristicsRaw
  },
  widgetStates: filteredStates,     // usefulPrefixes 19 前缀过滤(原样移植 L1154-1174)
  hitEndpoints: [...],              // entrypoint/composer 命中端点记录
}
```

### 4.4 followSell 缓存（POST /ozon/cache/followSell/:sku）

```js
// body = { data: 以下结构 }(对齐 fetchFollowSellModal L911-992,仅 HTTP 200 写入)
{
  count: rawSellers.length,
  sellers: [{ /* normSeller 11 字段,原样移植 L956-983 */ }],
  source: 'modal' | 'no-sellers' | 'parse-fail',
}
```

### 4.5 attribute 缓存（POST /ozon/cache/attribute/:sku）

```js
// type='search': body = { type:'search', data: { items: 原始 variants } }
//                (方案B 不转换,读取端按需合成 sv shape)
// type='bundle': body = { type:'bundle', data: create-bundle 原始 item, bundleId }
//                (data 顶层物理字段 weight/depth/width/height + attributes;
//                 空属性时 DAO 附 attrs_empty_verified_at,对齐插件 L1607-1612)
```

**`bundleUsable(cached)`**（对齐插件 `fetchBundleByVariantId` 缓存判定，
直接用 GET /ozon/cache/attribute/:sku 返回的 `stale` 标记）：

```js
bundleData 存在 && (
  attributes 非空                       // 有属性 → 可用
  || stale === false                    // 空属性但 ERP 判定 6h 内已验证 → 可用,不重复真调
)                                       // 空属性且 stale=true → 不可用,重验(bundle 有副作用,限频)
```

### 4.6 任务 result 字段（`collect_queue_tasks.result`）

写精简摘要（非插件 `_buildCollectDoneData` 全量广播数据——那是给 popup 预填用的，
无头场景无消费者；队列管理页仍可展示状态/错误）：

```js
{ source: 'headless-deep', results, reason?, error?, totalDuration }
```

---

## 5. 注入函数规格（page.evaluate 载荷）

> 铁律：注入函数必须**自包含**（无闭包引用，参数显式传入），
> 与插件 `chrome.scripting.executeScript({func})` 序列化约束同构。

### 5.1 `PORTAL_FETCH_FN`（sellerPage 上下文，门户三调用合一）

```js
/**
 * @param {{ path: string, method?: string, body?: object,
 *           headers?: object, needCompanyId?: boolean, timeoutMs: number }} p
 * @returns {{ ok: boolean, status: number, data?: any,
 *             reason?: 'AUTH_REQUIRED'|'ANTIBOT'|'TIMEOUT'|'NET'|'HTTP_<n>'|'NO_COMPANY_ID' }}
 */
```

- 同源 fetch：`credentials: 'include'`，headers 基础集
  `{ accept: 'application/json', content-type: 'application/json', 'x-o3-app-name': 'seller-ui', 'x-o3-language': 'zh-Hans' }`
- `needCompanyId: true` 时页内读 `document.cookie` 提取 `sc_company_id`：
  - marketStats：作为请求头 `x-o3-company-id`（自定义头跨域不可行，必须 seller 页同源——这是双页模型的根本原因）
  - search / create-bundle：作为 body 字段 `company_id`
- 失败分类：302→signin / 401 → `AUTH_REQUIRED`；403/429 → `ANTIBOT`；
  AbortError → `TIMEOUT`；其余网络异常 → `NET`
- 三个调用点的参数（对齐插件 `_fetchMarketStatsDirect` L1659-1674 / `_doAutoCollect` Step4 L2013-2027 / `fetchBundleByVariantId` L1587-1593）：

| 调用 | path | method | body | needCompanyId |
|---|---|---|---|---|
| marketStats | `/api/site/seller-analytics/what_to_sell/data/v3` | POST | `{ filter: { stock: 'any_stock', period: 'monthly', sku: String(sku) }, sort: { key: 'sum_gmv_desc' }, limit: '1', offset: '0' }` | 头注入 |
| search | `/api/v1/search` | POST | `{ company_id, need_total: true, filter: { children_nodes: { children_nodes: [{ input_leaf: { sku: { values: [String(sku)] } } }], operator: 'AND' } }, pagination: { limit: '50' }, is_copy_allowed: false }` | body 注入 |
| bundle | `/api/site/seller-prototype/create-bundle-by-variant-id` | POST | `{ company_id: String, variant_id: String, source: 'SOURCE_UI_COPY_APPAREL' }` | body 注入 |

**调用点响应处理**（对齐插件口径）：

- marketStats：`data = result?.items?.[0] || result?.data?.[0] || null`；
  有数据 → normalizeMarketItem；无数据 → `{ __empty: true }`（HTTP 200 即成功）
- search：`rawVariants = resp?.variants || resp?.items || resp?.products || []`；
  `searchVariant = rawVariants[0]`；缓存写 `{ items: rawVariants }`（方案 B 原始数组不转换）；
  HTTP 200 但无 variants → 不标 error，门控 B 走 skipped 终态
- bundle：`item = resp?.item || null`；`bundleId = resp.bundle_id || null`；
  item 为 null（HTTP 200 无数据）→ 不标 error，门控 C `isUltraLight(null)` 走
  `non-ultra-light` skipped 终态；`variantId = searchVariant?.variant_id`（无 variant_id
  视为数据异常，同样走门控 C 终态，不重试）
- search/bundle 的 `timeoutMs = 30000`（对齐插件）

### 5.2 买家页 helpers 预注入（`injectBuyerHelpers`）

每次 buyerPage 导航完成后：

```js
await buyerPage.addScriptTag({ content: readFileSync('../qx-ozon/lib/ozon-video-extract.js') });
await buyerPage.addScriptTag({ content: readFileSync('../qx-ozon/lib/follow-sell-content-copy.js') });
```

- 两个 lib 为纯页面 JS（MAIN world 设计，无 chrome API），addScriptTag 直接可用
- 作用：提供 `globalThis.JZOzonVideoExtract`（mp4 提取）与
  `globalThis.JZFollowSellContentCopy.extractDescriptionText`（描述提取）
- 注入失败（极小概率）不阻断：PDP_MEDIA_FN 内部 best-effort 降级（对齐插件 warn 继续）
- lib 源文件随插件仓库演进，采需同步更新——设计上接受此耦合
  （零逻辑漂移 > 代码复制漂移）

### 5.3 `PDP_MEDIA_FN({ sku, timeoutMs })`（buyerPage 详情页上下文）

移植 collect-tab.js `fetchPdpMedia` 内联版（含 nextPage 扩散队列）：

```
1. fetch entrypoint-api.bx/page/json/v2?url=/product/<sku>
   headers: { 'x-o3-app-name': 'dweb_client', 'x-o3-language': 'ru' }
2. 解析 widgetStates;命中 composer-widget 相关结构则按需 fetch
   composer-api.bx/page/json/v2?page=<product>/<sku>&layout...
3. nextPage 扩散:widgetStates 中 webPage 扩散链接(去重)逐个 page json,
   队列上限/总时长受 timeoutMs 约束
4. 提取:
   - mp4     : JZOzonVideoExtract(webGallery/video widget)
   - richContent : 富内容文档(11254)结构谓词 _isRichDoc
   - description : JZFollowSellContentCopy.extractDescriptionText(4191)
   - hashtags    : webHashtags(23171)
5. 返回 { mp4, richContent, richContentHasText, description,
          descriptionSource, hashtags, widgetStates, hitEndpoints, anyOk }
   anyOk = 任一 page json HTTP 200(写缓存判定,对齐插件)
```

### 5.4 `FOLLOW_SELL_MODAL_FN({ sku, timeoutMs })`（buyerPage 上下文）

原样移植 `fetchFollowSellModal`（L911-992）：composer modal fetch + webSellerList
解析 + normSeller 11 字段。返回 `{ ok, followSellData, errorReason }`。
（HTTP 非 200 不写缓存 → 允许重试；无 webSellerList widget → count 0 也写。）

### 5.5 `JSONLD_EXTRACT_FN()`（buyerPage 上下文）

```
读取 document.querySelectorAll('script[type="application/ld+json"]')
解析 Product 节点 → { name, sku, image[], description, brand, category,
                       offers: { price }, aggregateRating: { ratingValue, reviewCount } }
返回 { ok, data } (无 ld+json 节点 → { ok: false },仅作 detail 兜底,不影响主流程)
```

---

## 6. ERP API Client 与任务状态机

### 6.0 Client 核心（`erpFetch` 封装）

```js
/**
 * 所有 ERP 请求的统一出口
 * - headers: { 'x-api-key': ERP_API_KEY, 'content-type': 'application/json' }
 * - 超时: ERP_TIMEOUT_MS(默认 15s,AbortController)
 * - 请求级重试: 超时/网络错误/HTTP 5xx → 等 2s 重试 1 次(对齐插件 _erpQueueUpdate 模式)
 * - 错误分类:
 *     'ERP_NET'      网络错误/超时(重试后仍失败)
 *     'ERP_HTTP_5xx' 服务端错误(重试后仍失败)
 *     'ERP_AUTH'     401(API Key 未配置/不匹配) → 直接退出报错
 *     'ERP_4xx'      其他 4xx(请求构造 bug,不应出现) → 抛出带响应体
 * - 连续失败熔断: erpFailCount 累计,达 ERP_FAIL_MAX(默认 5)→ 暂停主循环,
 *   每 30s GET /health 探测(public 路径)恢复后清零续采
 */
async function erpFetch(method, path, body)
```

> API Key 校验失败（ERP_AUTH）不做自动恢复：key 是静态配置，运行中失效说明配置被改，
> 快速失败优于静默重试。启动时（§2.1 步骤 3）已用 claim 探活预拦截。

### 6.1 claim（POST /admin/api/collect-queue/claim）

```js
// 返回 { task: doc | null }(ERP collect-queue.js L654-662,插件 SW 同款端点)
// task 字段: sku/sellerSlug/sellerId/domInfo/attempts/lastError/steps/forceRefresh/createdAt
// 原子性由 ERP DAO claimNextPending 保证(UPDATE...RETURNING,attempts<10 才可 claim)
// 与插件 SW 同时在线时天然互斥;claim 返回 null ≠ 队列空(可能被另一消费者持有),
// 按 CLAIM_EMPTY_WAIT_MS 空转窗口判定退出(§3.1)
```

### 6.2 partial（POST /admin/api/collect-queue，upsert 语义）

```js
// 对齐插件 _handlePartialTask → _erpQueueUpdate(collect-queue.js L543-559)
body = {
  sku, status: 'pending',
  attempts: task.attempts,        // claim 时已 +1,保留不重置
  lastError: { type: <错误类型>, message: <原因码>, ts: Date.now() },
  steps: <七类结果数组>,
  createdAt: Date.now(),          // = now,塞队尾(ORDER BY createdAt ASC 避免立即重复 claim)
  startedAt: null, finishedAt: null,
}
// 失败重试:2s 后重试 1 次;仍失败任务停留 running,由 ERP stale-reset(5min)兜底回收
```

### 6.3 terminal（POST /admin/api/collect-queue/:sku/result）

```js
// 对齐插件 _erpQueueResult;body 字段见 collect-queue.js L379-408
body = {
  status: 'success' | 'skipped',
  result: { source: 'headless-deep', results, reason?, error?, totalDuration },   // §4.6
  lastError: status==='skipped' ? { type:'skipped', message:<reason>, ts } : null,
  steps: <七类结果数组>,
  duration: totalDuration,
  finishedAt: new Date().toISOString(),
}
```

### 6.4 日志（POST /admin/api/auto-collect/log）

```js
// 对齐插件日志;body 见 cache.js L1480-1508
body = {
  sku, source: 'headless-deep', sellerSlug: task.sellerSlug, sellerId: task.sellerId,
  storeClassified: <店铺分类结果或 'unclassified'>, depth: 1,
  status, reason, results, totalDuration, collectedAt: new Date().toISOString(),
}
// finalize() 对每个 return 路径(success/partial/skipped/all-cached)都写一条
```

### 6.5 辅助读接口（Client 方法清单）

| 方法 | 端点 | 用途 |
|---|---|---|
| `erp.getDomCache(sku)` | `GET /ozon/cache/dom/:sku` | Step 1 card/detail 命中 |
| `erp.getAttributeCache(sku)` | `GET /ozon/cache/attribute/:sku` | Step 1 search/bundle 命中 + bundleUsable(stale) |
| `erp.getMarketStatsCache(sku)` | `GET /ozon/cache/marketStats/:sku` | Step 1 marketStats 命中 |
| `erp.getFollowSellCache(sku)` | `GET /ozon/cache/followSell/:sku` | Step 1 followSell 命中 |
| `erp.getRichMediaCache(sku)` | `GET /ozon/cache/richMedia/:sku` | Step 1 richMedia 命中 |
| `erp.setDomCache(sku, type, data)` | `POST /ozon/cache/dom/:sku` | detail 写入(§4.2) |
| `erp.setAttributeCache(sku, type, data, bundleId?)` | `POST /ozon/cache/attribute/:sku` | search/bundle 写入(§4.5) |
| `erp.setMarketStatsCache(sku, data)` | `POST /ozon/cache/marketStats/:sku` | marketStats 写入(§4.1) |
| `erp.setRichMediaCache(sku, data)` | `POST /ozon/cache/richMedia/:sku` | richMedia 写入(§4.3) |
| `erp.setFollowSellCache(sku, data)` | `POST /ozon/cache/followSell/:sku` | followSell 写入(§4.4) |
| `erp.isMainlandChinaSeller(sellerId)` | `GET /admin/api/store-classification/:sellerId` | Gate 0.5 |
| `erp.loadFilteredCategories()` | `GET /admin/api/filtered-categories` | 启动加载 filterMap |
| `erp.claimTask()` | `POST /admin/api/collect-queue/claim` | §6.1 |
| `erp.submitTask(task)` | `POST /admin/api/collect-queue` | §6.2 partial 回队 |
| `erp.submitResult(sku, body)` | `POST /admin/api/collect-queue/:sku/result` | §6.3 终态 |
| `erp.insertAutoCollectLog(body)` | `POST /admin/api/auto-collect/log` | §6.4 日志 |

> 索引聚合（ozon_cache_index + FTS）由 ERP DAO 在缓存 upsert 时自动触发
> （attribute-dao.js L105/127/141 等各 DAO 均挂 `indexDao.syncSku`），
> 脚本无需任何索引维护代码——这是 API 化的最大简化收益。

### 6.6 SIGINT 兜底

- 当前 running 任务：执行 §6.2（回 pending，attempts 保留）
- 已写缓存：保留（partial 重试按缓存命中跳过，天然断点续采）
- ERP 写失败时：任务停留 running，由 ERP stale-reset 兜底回收（不丢任务）

---

## 7. 错误分类与熔断

### 7.1 分类矩阵（注入函数返回 → 编排动作）

| 分类 | 来源判定 | doAutoCollect 动作 | 任务终态 |
|---|---|---|---|
| AUTH_REQUIRED | PORTAL_FETCH_FN: NO_COMPANY_ID / AUTH_REQUIRED | 返回 partial + signal（§3.2） | partial（finalize 后主循环 §7.2 处理信号） |
| ANTIBOT | PORTAL_FETCH_FN: ANTIBOT | 返回 partial + signal（§3.2） | partial（同上） |
| 永久无数据 | marketStats `__empty` / search 无 variants / 门控B/C 命中 | 直接 skipped(reason) | skipped |
| 临时失败 | TIMEOUT / NET / HTTP_5xx / evaluate 异常 / 导航超时 | partial(reason, error)（经门控判定或直接返回） | partial |
| best-effort 降级 | richMedia anyOk=false / fsRes.ok=false / jsonLd 缺失 / detail 提取空 | 不阻断（结果 hit=false） | 照常 success |

### 7.2 主循环信号处理（finalize 后触发）

```
onAuthLost(signal 由 partial 结果携带):
  warn('seller 登录态失效,等待人工处理…', SELLER_AUTH_WAIT_MS)
  等待期间每 60s 重试 warmup(§2.3)
  连续 AUTH_RETRY_MAX 次(默认 3)仍失败 → 退出(exitCode=2,提示登录命令)
  恢复 → 续采(当前任务已在 finalize 中回队,由后续 claim 重试)

onAntibotHit(signal 由 partial 结果携带):
  warn('触发反爬,熔断', ANTIBOT_WAIT_MS)
  暂停结束 → warmup() → 续采(当前任务已在 finalize 中回队)
```

---

## 8. 配置清单（.env.example 追加段）

```bash
# ── deep-collect(深度采集) ─────────────────────────────────
# ERP 连接与鉴权(§6.0;与后端 SERVICE_API_KEY 同值,生成方式见概要设计 §3.2)
ERP_BASE_URL=http://127.0.0.1:3001
ERP_API_KEY=<与后端 SERVICE_API_KEY 同值>
ERP_TIMEOUT_MS=15000                   # ERP 单请求超时(AbortController)
ERP_FAIL_MAX=5                         # ERP 连续失败熔断上限(§6.0)
CLAIM_EMPTY_WAIT_MS=60000              # claim 持续为空的等待窗口,超过退出(§3.1)
PROFILE_DIR=.ozon-profile              # 与浅采共用;共用时跨脚本互斥(§9.1)
HEADLESS=1
TASK_LIMIT=0                           # >0 时本批上限(测试用)
DRY_RUN=0                              # 1=claim 但不写任何数据(观察请求链路)
LOG_SKU=0                              # 1=逐 SKU 明细日志
SKU_INTERVAL_MIN_MS=8000
SKU_INTERVAL_MAX_MS=15000
# 门控(默认对齐插件当前生效值)
ENABLE_MARKET_STATS_GATE=1             # 门控A:市场统计
ENABLE_CATEGORY_FILTER_GATE=1          # 门控B:类目黑名单
ENABLE_ULTRA_LIGHT_GATE=1              # 门控C:超轻小件
ONLY_MAINLAND_CHINA=1                  # Gate 0.5:中国大陆店铺
# 熔断/恢复
ANTIBOT_WAIT_MS=600000
CHALLENGE_WAIT_MS=15000
SELLER_AUTH_WAIT_MS=600000
AUTH_RETRY_MAX=3
# 超时
PORTAL_FETCH_TIMEOUT_MS=20000
PDP_FETCH_TIMEOUT_MS=30000
PAGE_GOTO_TIMEOUT_MS=30000
```

---

## 9. 关键设计决策补充

### 9.1 profile 跨脚本互斥

- 默认 `PROFILE_DIR=.ozon-profile` 与浅采共用（同登录态）
- cloakbrowser 同一 userDataDir 不允许双实例（第二个 launch 直接报错）
- 显式优化：锁文件统一放 profile 目录内（`.ozon-profile/browser.lock`），
  浅采/深采启动时均抢占该锁；抢占失败给出明确提示（"另一采集进程占用中"）
- 需要同时运行浅采+深采时：配置独立 `PROFILE_DIR`（各自登录一次）

### 9.2 detail 采用 widgetStates 而非 DOM 解析

- 插件 `extractProductData`（ozon-product.js）依赖 content script 环境
  （`window.findStateDataByKeys` 等注入工具 + 用户交互触发），无法在无头 evaluate 直接复用
- Ozon 2026 SSR DOM 剥离后，插件自身也改为 ensurePdpState 预取 composer page json
  ——widgetStates 是**比 DOM 更稳的真相源**
- detail 所需字段与 richMedia 的 page json 完全同源 → 零增量请求

### 9.3 result 字段精简（不对齐 `_buildCollectDoneData`）

插件 result 全量数据仅服务于 popup preFetched 回填（有头交互场景）。
无头消费者为队列管理页（展示 status/error/duration），精简 result 足够；
若未来需要，补 `_buildCollectDoneData` 移植即可（数据源全部已在缓存表）。

### 9.4 类目黑名单内存化

启动时 `GET /admin/api/filtered-categories` 全量加载（该表人工维护、量级小），
构建内存 Map 后运行期比对 `(description_category_id, type_id)` 不再请求 ERP；
管理页更新黑名单后重启脚本生效（可接受，说明于运维注记）。

---

## 10. 测试计划（小批量 → 全量）

| 阶段 | 配置 | 验证点 |
|---|---|---|
| T1 干跑 | `DRY_RUN=1 TASK_LIMIT=1` | claim 成功、七类采集链路请求发出、零写入、任务回 pending |
| T2 单 SKU 落库 | `TASK_LIMIT=1 LOG_SKU=1` | 缓存 API 写入格式与插件采集的同 SKU 对比 diff；detail 19 字段齐全度 |
| T3 小批量 | `TASK_LIMIT=10` | 门控 A/B/C 各触发场景；partial 重试回队尾；attempts 累积 |
| T4 并存 | 插件 SW 开启 + 脚本同跑 | 无重复消费（同 SKU 双方各处理一次即异常）；节奏观察 |
| T5 熔断恢复 | 人工触发（改 UA/清 cookie） | AUTH_REQUIRED 等待退出；ANTIBOT 熔断恢复后续采 |
| T6 全量 | 默认配置 | 连续运行稳定性、日吞吐（预期 6-8k/日）、ERP 管理页指标正常 |

对齐用户测试习惯：T2/T3 以人工核对 ERP 数据为准（管理页缓存视图 /
`GET /ozon/cache/*/:sku` 响应抽查，与插件采集的同 SKU 对比 diff）。

---

## 11. 实施任务拆解

| # | 任务 | 依赖 | 产出 |
|---|---|---|---|
| 0 | 后端先行：authMiddleware `x-api-key` 分支 + 后端 .env 补 SERVICE_API_KEY（概要设计 §3.2） | — | 服务鉴权可用 |
| 1 | 骨架移植（.env/锁/统计输出/主循环框架）+ erpFetch Client（§6.0 含熔断） | 0 | 启动探测可跑 |
| 2 | claim/finalize/日志 API 封装（§6.1-6.4）+ 状态机 | 1 | T1 可跑 |
| 3 | PORTAL_FETCH_FN + Step 3/4 + 门控 A/B/C + 三类缓存写入 API | 2 | marketStats/search/bundle 落库 |
| 4 | 双页管理 + warmup + 注入 helpers | 1 | buyerPage 导航稳定 |
| 5 | PDP_MEDIA_FN + FOLLOW_SELL_MODAL_FN + JSONLD_EXTRACT_FN 移植 | 4 | richMedia/followSell 落库 |
| 6 | buildDetailData + setDomCache('detail') | 5 | detail 落库 |
| 7 | result 精简写入 + autoCollectLog 全 return 路径接入（§6.4） | 2,3,5,6 | 全链路闭环（索引聚合由 ERP DAO 自动触发） |
| 8 | 熔断/信号处理/DRY_RUN/统计报表 | 7 | T5 可跑 |
| 9 | .env.example 更新 + 文档同步 | 8 | 交付 |
