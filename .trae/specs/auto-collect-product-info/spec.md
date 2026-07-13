# 自动化采集跟卖产品信息 Spec

> V3 变更:在 V2 八类缓存基础上,(1)去掉搜索页采集,只保留店铺页和详情页;(2)新增中国店铺检测层——进入店铺页/详情页时先提取卖家信息,通过预设规则或人工确认判定是否中国店铺,只对中国店铺的 SKU 触发自动采集。

## Why

当前 qx-ozon 扩展的 6 类缓存(search/bundle/card/composer/entrypoint/detail)都是**按需触发**:只有用户在跟卖面板、批量上架等场景主动调用对应 SW action 时才会写入。这导致:

1. **数据无法复用**:用户浏览过的商品信息没有沉淀,下次跟卖相同 SKU 仍要重采
2. **反爬风险集中**:批量场景短时间内高频请求 seller.ozon.ru,已实测触发限登
3. **批量上架功能要移除**:后续由 ERP 后台对「数据就绪」的 SKU 发起上架,需要前置采集机制
4. **旧 MY采集器只存本地 IndexedDB**:不推 MongoDB,无法跨设备共享,且功能臃肿(本地桶/CSV/推送)
5. **智能筛选 18 字段依赖 data/v3 实时调用**:每次打开 panel 都要等 ~1s,无跨设备共享;跟卖人数/最低价同理依赖 composer-api 实时调用

需要一套**纯被动 + 可选自动翻页**的自动采集机制:用户浏览 Ozon 店铺页/详情页时,扩展先提取卖家信息并判定是否中国店铺(规则自动 + 人工确认),只对中国店铺的 SKU 自动采集全量跟卖信息(八类缓存:原 6 类 + 新增 marketStats/followSell)到 MongoDB,供后续 ERP 后台批量上架时直接命中缓存、零实时请求。同时提供 QX采集器浮动面板作为主控台,移植旧 MY采集器的触发方式、自动翻页、智能筛选、仅抓有销量功能。

**V3 新增动机**:用户只需采集中国店铺的跟卖产品。搜索页无法可靠获取店铺信息,因此去掉搜索页采集,只保留店铺页和详情页——两者都能提取卖家信息(sellerSlug + sellerName + sellerId + companyInfo),据此判定是否中国店铺。判定支持规则自动(已知列表/公司国家)与人工确认两种方式,结果存 MongoDB 跨设备共享。

## What Changes

### Service Worker (qx-ozon/background/service-worker.js)

- **IndexedDB 升级 v6**:新增 `market_stats_cache` / `follow_sell_cache` 两个 store(keyPath=sku),onupgradeneeded 中创建,不删旧 store
- **新增 8 类缓存读写函数**:`_marketStatsCacheGet/Set/Delete` + `_followSellCacheGet/Set/Delete`(参考 card 模式,加 stale 判定)
- **新增 `_buyerPageGate`**:买家页(www.ozon.ru)请求全局闸门,默认 500ms 最小间隔
- **新增 `_autoCollectGate`**:autoCollect 逐 SKU 间隔闸门,默认 1000ms
- **新增 `autoCollect` action**:接收 `{sku, source, sellerSlug, depth, forceRefresh}`,编排 Gate 0 → Gate 0.5(中国店铺) → 三层缓存检查(8 类)→ 买家页采集 → seller portal 采集 → 写 L1+L2+log
- **新增 Gate 0.5 中国店铺检查**:在 Gate 0 之后、Step 1 之前,调 `checkStoreClassification(sellerSlug, ...)`,若 `onlyChineseStores` 开启且 `isChinese !== true` 则跳过采集(reason=`non-chinese-store` 或 `unclassified-store`)
- **新增 `checkStoreClassification(slug, name, companyInfo)`**:三层查询 L1 chrome.storage → L2 MongoDB → 规则引擎,返回 `{isChinese, classifiedBy}` 或 `null`(未分类)
- **新增 `classifyStoreByRules(slug, name, companyInfo, config)`**:规则引擎,5 条优先级规则(knownChineseSlugs → knownNonChineseSlugs → CJK-name → company-country=CN → company-country≠CN → null)
- **新增 `classifyStore` action**:人工确认,接收 `{slug, name, isChinese}`,写 L1 + L2(`classifiedBy:'manual'`)
- **新增 `_erpStoreClassGet/Set(slug, record)`**:ERP store-classification 接口对接
- **改造 `fetchVariantMediaViaBuyerTab`**:一次借买家 tab 执行 2 个 fetch(entrypoint-api.bx + composer-api 跟卖 modal),写 entrypoint + composer + followSell 三类缓存
- **新增 `_fetchMarketStatsDirect(sku)`**:直接走 seller tab 注入 fetch data/v3(不走代采),供 autoCollect 调用;返回类型契约 `{__needSellerLogin}` / `{__antibot:true}` / `null` / `NormalizedItem`;不在函数内写缓存
- **改造 `getMarketStats` action**:真调 data/v3 成功后,内部调 `_marketStatsCacheSet` 写 marketStats 缓存(panel 渲染触发时也写);保留 `proxyMarketData` 代采降级
- **新增 chrome.storage 配置读写**:`jz-auto-collect-config` key,含 enabled/autoCollectRunning/depth/paused/pausedUntil/限速参数/stale 参数/每日计数/**onlyChineseStores/knownChineseSlugs/knownNonChineseSlugs**
- **新增 7 个 SW action**(供面板调用):`autoCollectGetConfig` / `autoCollectSetConfig` / `autoCollectGetStats` / `autoCollectGetRecent` / `autoCollectForceRefreshPage` + `checkStoreClassification` / `classifyStore`
- **新增内存计数器 + 环形缓冲**:今日 success/skipped/failed/antibot 计数 + 最近 50 条日志,byType 含 8 类,**bySource 只含 shop-page/pdp**(去掉 search-page),**byStoreClass 含 chinese/non-chinese/unclassified**,SW 启动时从 MongoDB 聚合初始化
- **扩展 `syncL2Batch`**:遍历 8 个 store(原 6 + 新 2),补写未同步记录到 L2

### Content Scripts

- **shared-utils.js 新增 `autoCollectOnSkuSeen(sku, source, sellerSlug)`**:统一入口,页面级 `Set<sku>` 去重,fire-and-forget 发 `autoCollect` 消息(含 sellerSlug)
- **shared-utils.js 新增 `collectAutoIfMatched(productId, card, info, data, panel, source, sellerSlug)`**:筛选入口,检查 autoCollectRunning → waitForCollectorFilterData → passCollectorFilters → 通过则调 autoCollectOnSkuSeen
- **shared-utils.js 新增 `passCollectorFilters(data, info)`**:移植自旧 panel.js,先检查 onlyWithSales,再检查 smartFilterState.enabled && smartMatches
- **shared-utils.js 新增 `extractSellerInfoFromShopPage()`**:从店铺页 URL 提取 sellerSlug + DOM 提取 sellerName(sellerTransparency widget)+ `__NUXT__.state.pageInfo.analyticsInfo.sellerId` + **优先 fetch 店铺页第一个 SKU 的详情页 HTML,从 `state-webCurrentSeller.trustFactors` 提取完整 companyInfo(含 country/legalAddress);fetch 失败或 HTML 不含 state-webCurrentSeller 时退回 entrypoint-api(仅 companyName)**(此函数实际由 MAIN world content script seller-info-main.js 执行,通过 CustomEvent 传给 ISOLATED world)
- **shared-utils.js 改造 `jzFetchPublicFollowSell`**:真调 composer-api 跟卖 modal 成功后,调 `sendMessage('followSellCacheSet', {sku, data})` 写 followSell 缓存(sessionStorage L0 保留)
- **ozon-search.js `loadPanelData`**:**V3 不再接入 autoCollect**(搜索页已移除),保留现有 panel 渲染逻辑不改造
- **ozon-data-panel.js `loadPanelData` 改造**:页面加载后先调 `extractSellerInfoFromShopPage()` + `sendMessage('checkStoreClassification', ...)` 更新 QX面板店铺检测状态;Step 5 调用 `collectAutoIfMatched(..., 'shop-page', sellerSlug)`,移除旧 `collectSaleIfMatched` / `JZCollectorDB.putSale`
- **ozon-product.js `extractProductData` 改造**:Step 4 新增 `extractSellerInfoFromPDP()` 从 `div[id^="state-webCurrentSeller-"]` 的 `data-state` 属性解析 sellerId/sellerName/sellerSlug + `trustFactors[0].tooltip.subtitle` 数组提取 companyInfo(companyName/legalAddress/country,详情页可直读 country)+ `sendMessage('checkStoreClassification', {slug, name, companyInfo})` 更新面板;Step 5 直接调 `autoCollectOnSkuSeen(sku, 'pdp', sellerSlug)`(详情页不筛选,但仍检查中国店铺 Gate 0.5)

### QX采集器面板 (qx-ozon/content/qx-collector/)

- **smart-filter.js**:从旧 panel.js 抽取智能筛选逻辑(18 字段 + 品牌 + 发货模式 + 模板管理),挂 `window.QXSmartFilter`
- **auto-scroller.js**:从旧 collector 移植(类名 QXAutoScroller,逻辑零改),挂 `window.QXAutoScroller`
- **store-detector.js**(新):店铺信息提取 UI + 中国店铺检测区块渲染(待确认时显示 [标记中国] [标记非中国] 按钮,已分类时显示分类结果 + [重新分类]),挂 `window.QXStoreDetector`
- **panel.js + panel.css**:QX采集器面板,精简旧 panel.js(去掉本地桶/CSV/推送/关键词采集),保留主开关/自动翻页/仅抓有销量/智能筛选,新增**店铺检测区块**/**只采集中国店铺开关**/今日统计/缓存命中(8 类,marketStats/followSell stale 标橙)/最近采集/熔断倒计时/强制刷新/查看ERP。样式前缀 `.qx-c-*`,类名 `QXCollectorPanel`,挂 `window.QXCollectorPanel`

### ERP Backend (erp-backend-lite)

- **新增 MongoDB collection `ozon_market_stats_cache`**:市场分析数据(data/v3 归一化 18 字段 + category1/3/brand),24h stale
- **新增 MongoDB collection `ozon_follow_sell_cache`**:跟卖列表数据(count + sellers[]),4h stale
- **新增 MongoDB collection `ozon_store_classification`**(新):中国店铺分类结果(_id=sellerSlug,isChinese:boolean|null,classifiedBy,companyInfo),跨设备共享
- **新增 6 个缓存端点**:GET/POST/DELETE `/ozon/cache/marketStats/:sku` + GET/POST/DELETE `/ozon/cache/followSell/:sku`;GET 返回 `stale` 字段
- **新增 4 个店铺分类端点**:GET/POST/DELETE `/ozon/store-classification/:slug` + GET `/ozon/store-classification`(列表,支持 isChinese 筛选 + 分页)
- **新增 MongoDB collection `ozon_auto_collect_log`**:采集日志(8 类 results 数组 + sellerSlug + storeClassified)
- **新增 4 个日志端点**:`GET /admin/api/auto-collect/stats` / `GET /admin/api/auto-collect/logs` / `GET /admin/api/auto-collect/logs/:sku` / `POST /admin/api/auto-collect/log`
- **适配 8 类**:`CACHE_TYPES` 追加 `marketStats`/`followSell`;`getColByType` switch 加 2 个 case;`stats`/`list`/`overview` 接口适配 8 类;`opi-preview` 不变(marketStats/followSell 不参与 OPI 合成)

### Popup (qx-ozon/popup)

- **popup.html 新增「自动采集」简化区块**:总开关 + 状态 dot + 今日计数 + 熔断简略提示
- **popup.js 新增配置读写**:加载/保存 `jz-auto-collect-config`,熔断倒计时简略显示
- **popup「同步缓存」按钮适配 8 类**:触发 `syncAllCacheToL2` 同步 8 类 L1 → L2

### ERP overview 页 (erp-backend-lite/web)

- **Cache.vue 新增「自动采集」tab**:今日统计 + 日志列表(含 sellerSlug 列)+ 失败排查
- **Cache.vue 新增「店铺分类」tab**:分类列表(支持 isChinese 筛选)+ 手动改分类
- **Cache.vue overview 适配 8 类**:缓存矩阵显示 8 类(含 marketStats/followSell stale 状态)

### 移除的旧模块

- `content/collector/db.js`(JZCollectorDB)
- `content/collector/panel.js` / `panel.css`
- `content/collector/keyword-pilot.js`
- `content/collector/anti-ban.js`
- `content/collector/l1-shadow-db.js` / `l1-bridge.js` / `l1-diff.js`
- 保留 `content/collector/task-queue.js`(通用队列)

## Impact

- Affected specs: 无(新功能)
- Affected code:
  - [qx-ozon/background/service-worker.js](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js) — IndexedDB v6 + 8 类缓存函数 + 2 个闸门 + autoCollect action(含 Gate 0.5)+ checkStoreClassification/classifyStore/classifyStoreByRules + 7 个面板 action + 内存计数器(byStoreClass)+ 改造 fetchVariantMediaViaBuyerTab + _fetchMarketStatsDirect + 改造 getMarketStats + syncL2Batch 扩展
  - [qx-ozon/content/shared-utils.js](file:///c:/root/code/ozon-my/qx-ozon/content/shared-utils.js) — 新增 autoCollectOnSkuSeen / collectAutoIfMatched / passCollectorFilters / extractSellerInfoFromShopPage + 改造 jzFetchPublicFollowSell 写 followSell 缓存
  - [qx-ozon/content/ozon-search.js](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js) — **V3 不接入 autoCollect**(搜索页已移除)
  - [qx-ozon/content/ozon-data-panel.js](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-data-panel.js) — extractSellerInfoFromShopPage + loadPanelData 接入 Step 5 + QX面板
  - [qx-ozon/content/ozon-product.js](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js) — extractProductData 提取 sellerSlug + checkStoreClassification + 接入 Step 5 + QX面板
  - [qx-ozon/content/qx-collector/](file:///c:/root/code/ozon-my/qx-ozon/content/qx-collector/) — 新建 smart-filter.js / auto-scroller.js / store-detector.js / panel.js / panel.css
  - [qx-ozon/popup/popup.html](file:///c:/root/code/ozon-my/qx-ozon/popup/popup.html) — 新增简化自动采集区块
  - [qx-ozon/popup/popup.js](file:///c:/root/code/ozon-my/qx-ozon/popup/popup.js) — 配置读写 + 熔断倒计时 + 同步 8 类
  - [qx-ozon/manifest.json](file:///c:/root/code/ozon-my/qx-ozon/manifest.json) — 注入路径调整
  - [erp-backend-lite/src/db/mongo.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/db/mongo.js) — 新增 marketStatsCache / followSellCache / storeClassification collection
  - [erp-backend-lite/src/modules/cache.js](file:///c:/root/code/ozon-my/erp-backend-lite/src/modules/cache.js) — 新增 6 个缓存端点 + 4 个店铺分类端点 + 4 个日志端点 + CACHE_TYPES 适配 8 类 + stats/list/overview 适配
  - [erp-backend-lite/web/src/views/Cache.vue](file:///c:/root/code/ozon-my/erp-backend-lite/web/src/views/Cache.vue) — 新增自动采集 tab + 店铺分类 tab + overview 8 类矩阵
  - [erp-backend-lite/web/src/api/cache.js](file:///c:/root/code/ozon-my/erp-backend-lite/web/src/api/cache.js) — 新增 auto-collect + store-classification API 函数

## ADDED Requirements

### Requirement: 纯被动触发

系统 SHALL 在用户浏览 Ozon 店铺页/详情页时,通过现有 IntersectionObserver / extractProductData 钩子,自动对每个遇到的 SKU(经「中国店铺 + 仅抓有销量 + 智能筛选」过滤后)触发 `autoCollect` 消息,无需用户主动操作。**搜索页不触发采集**(V3 移除搜索页接入)。

#### Scenario: 店铺页商品卡进入视口

- **WHEN** 用户在 `https://www.ozon.ru/seller/*/products/*` 滚动,商品卡进入视口
- **THEN** content script 先调 `extractSellerInfoFromShopPage()`(URL 提取 slug + DOM 提取 name + `__NUXT__.state.pageInfo.analyticsInfo.sellerId` 提取 sellerId + entrypoint-api 获取 companyInfo)+ `sendMessage('checkStoreClassification', {slug, name, companyInfo})` 更新面板店铺检测状态;随后调用 `collectAutoIfMatched(sku, ..., 'shop-page', sellerSlug)`,筛选通过后 SW 收到 `autoCollect` 消息(含 sellerSlug)

#### Scenario: 详情页加载完成

- **WHEN** 用户访问 `https://www.ozon.ru/product/{sku}/`,页面 DOM 就绪触发 `extractProductData()`
- **THEN** content script 调 `extractSellerInfoFromPDP()`(从 `div[id^="state-webCurrentSeller-"]` 的 `data-state` 属性解析 sellerId/sellerName/sellerSlug + trustFactors 提取 companyInfo 含 country)+ `sendMessage('checkStoreClassification', {slug, name, companyInfo})` 更新面板;随后直接调用 `autoCollectOnSkuSeen(sku, 'pdp', sellerSlug)`(详情页不筛选,但仍检查中国店铺 Gate 0.5),SW 收到 `autoCollect` 消息

#### Scenario: 页面级去重

- **WHEN** 同一页面会话内,同一 SKU 第二次进入视口或第二次触发 extractProductData
- **THEN** `autoCollectOnSkuSeen` 内部 `Set<sku>` 命中,不重复发 `autoCollect` 消息

#### Scenario: 搜索页不触发

- **WHEN** 用户在 `https://www.ozon.ru/search/*` 或 `https://www.ozon.ru/category/*` 滚动
- **THEN** content script 不调用 `collectAutoIfMatched`,不触发 autoCollect(搜索页无法可靠获取店铺信息)

### Requirement: MAIN World 架构约束

Content script 默认运行在 ISOLATED world,无法访问页面 JS 变量(`window.__NUXT__`、`window.otmState` 等)。店铺信息提取需要读取 `window.__NUXT__.state.pageInfo.analyticsInfo.sellerId`,必须在 MAIN world 执行。

#### Scenario: 扩展加载并注入 MAIN world content script

- **WHEN** 扩展安装并加载到 Ozon 店铺页/详情页
- **THEN** manifest.json 注入 `content/seller-info-main.js`(`"world": "MAIN"`, `"run_at": "document_idle"`)
- **AND** `seller-info-main.js` 能直接访问 `window.__NUXT__`
- **AND** `ozon-data-panel.js` / `ozon-product.js`(ISOLATED world)通过 `CustomEvent` 接收数据

#### Scenario: 店铺页读取到 sellerId

- **WHEN** `seller-info-main.js` 在店铺页读取到 sellerId
- **THEN** 通过 `window.dispatchEvent(new CustomEvent('jz-seller-info', { detail: { pageType:'shop', slug, name, sellerId, companyInfo } }))` 发送
- **AND** ISOLATED world 的 content script 监听 `jz-seller-info` 事件接收数据

#### Scenario: 详情页读取 state-webCurrentSeller DOM

- **WHEN** `seller-info-main.js` 在详情页读取到 `state-webCurrentSeller` DOM
- **THEN** 解析 `data-state` 属性获取 sellerId/sellerName/sellerSlug + trustFactors companyInfo
- **AND** 通过 `CustomEvent` 发送 `{ pageType:'pdp', slug, name, sellerId, companyInfo }`

#### Scenario: 调用 entrypoint-api 获取 companyInfo

- **WHEN** `seller-info-main.js` 调用 entrypoint-api 获取 companyInfo(店铺页)
- **THEN** 在 MAIN world 直接 fetch(带 credentials: 'include',headers: x-o3-app-name=dweb_client)
- **AND** 解析 `widgetStates` 提取 companyName + shopStats
- **AND** 通过 `CustomEvent` 发送 companyInfo

#### Scenario: 读取 __NUXT__ 失败重试

- **WHEN** `seller-info-main.js` 读取 `__NUXT__` 失败(可能 SPA 未初始化)
- **THEN** 重试(每 500ms 一次,最多 15s)
- **AND** 超时后发送 `{ sellerId: null }` 通知 ISOLATED world

#### Scenario: ozon-data-panel.js 收到 jz-seller-info 事件

- **WHEN** `ozon-data-panel.js`(ISOLATED world)收到 `jz-seller-info` 事件
- **THEN** 调 `sendMessage('checkStoreClassification', {slug, name, companyInfo})` 通知 SW
- **AND** 调 `collectAutoIfMatched(..., 'shop-page', sellerSlug)` 触发 autoCollect

#### Scenario: ozon-product.js 收到 jz-seller-info 事件

- **WHEN** `ozon-product.js`(ISOLATED world)收到 `jz-seller-info` 事件
- **THEN** 调 `sendMessage('checkStoreClassification', {slug, name, companyInfo})` 通知 SW
- **AND** 调 `autoCollectOnSkuSeen(sku, 'pdp', sellerSlug)` 触发 autoCollect

#### Scenario: 店铺页 fetch 详情页 HTML 提取 companyInfo

- **WHEN** `seller-info-main.js` 在店铺页读取到 sellerId
- **THEN** 优先 fetch 店铺页第一个 SKU 的详情页 HTML(带 cookie,同源请求)
- **AND** DOMParser 解析 HTML,找 `div[id^="state-webCurrentSeller-"]`
- **AND** 从 `data-state` 属性提取 companyInfo(含 country/legalAddress)
- **AND** fetch 失败或 HTML 不含 state-webCurrentSeller 时,退回 entrypoint-api(仅 companyName)
- **AND** 通过 `CustomEvent` 发送 companyInfo

### Requirement: 中国店铺检测

系统 SHALL 在进入店铺页/详情页时先提取卖家信息(sellerSlug + sellerName + companyInfo),通过三层查询(L1 chrome.storage → L2 MongoDB → 规则引擎)判定是否中国店铺,无法判定时返回 null 等待人工确认。分类结果存 MongoDB `ozon_store_classification` 跨设备共享。autoCollect action 入口新增 Gate 0.5,在 `onlyChineseStores` 开启时,非中国店铺或未分类店铺的 SKU 跳过采集。

#### Scenario: 店铺页提取卖家信息

- **WHEN** 用户访问 `https://www.ozon.ru/seller/{slug}/products/`,页面加载完成
- **THEN** content script 调 `extractSellerInfoFromShopPage()`:从 URL 提取 slug,从 DOM 提取 sellerName(`[data-widget="sellerTransparency"] span.tsHeadline600Large` → h1 → meta og:title → slug),从 `window.__NUXT__.state.pageInfo.analyticsInfo.sellerId` 提取 sellerId,**优先 fetch 店铺页第一个 SKU 的详情页 HTML 提取 companyInfo(含 country/legalAddress),fetch 失败或 HTML 不含 state-webCurrentSeller 时退回 entrypoint-api(仅 companyName)**

#### Scenario: 详情页提取卖家信息

- **WHEN** 用户访问详情页,`extractProductData` 执行
- **THEN** 调 `extractSellerInfoFromPDP()`:从 `div[id^="state-webCurrentSeller-"]` 的 `data-state` HTML 属性解析 JSON,提取 sellerId(`badge.subscribed.common.action.params.sellerId`)、sellerName(`sellerCell.centerBlock.title.text`)、sellerSlug(从 sellerLink 正则);从 `trustFactors[0].tooltip.subtitle` 数组提取 companyInfo(companyName/legalAddress/country,"CN, Xiamen" 格式取逗号前为 country)

#### Scenario: 规则引擎 - 已知中国店铺列表

- **WHEN** sellerSlug 在 `config.knownChineseSlugs` 列表中
- **THEN** 规则引擎返回 `{isChinese:true, classifiedBy:'rule:known-list'}`,写 L1+L2,该店铺 SKU 可触发采集

#### Scenario: 规则引擎 - 已知非中国店铺列表

- **WHEN** sellerSlug 在 `config.knownNonChineseSlugs` 列表中
- **THEN** 规则引擎返回 `{isChinese:false, classifiedBy:'rule:known-list'}`,写 L1+L2,该店铺 SKU 跳过采集

#### Scenario: 规则引擎 - 公司国家为 CN

- **WHEN** companyInfo.country === 'CN'
- **THEN** 规则引擎返回 `{isChinese:true, classifiedBy:'rule:company-country'}`,写 L1+L2

#### Scenario: 规则引擎 - 公司国家非 CN

- **WHEN** companyInfo.country 存在且 !== 'CN'
- **THEN** 规则引擎返回 `{isChinese:false, classifiedBy:'rule:company-country'}`,写 L1+L2

#### Scenario: 规则引擎 - 无法判定

- **WHEN** 无规则匹配(不在已知列表、店名无 CJK、无公司国家信息)
- **THEN** 规则引擎返回 `{isChinese:null, by:null}`,写 L2 记录(isChinese=null),QX面板显示「待确认」+ [标记中国] [标记非中国] 按钮

#### Scenario: 三层查询缓存命中

- **WHEN** `checkStoreClassification(slug, ...)` 查 L1 chrome.storage.local 命中且 isChinese !== null
- **THEN** 直接返回,不查 L2 不跑规则引擎

#### Scenario: 三层查询 L2 命中

- **WHEN** L1 未命中或 isChinese === null,L2 MongoDB 命中且 isChinese !== null
- **THEN** 写 L1 + 返回,不跑规则引擎

#### Scenario: 人工确认标记中国

- **WHEN** QX面板显示「待确认」,用户点击 [✓ 标记中国店铺]
- **THEN** content 调 `sendMessage('classifyStore', {slug, name, isChinese:true})`,SW 写 L1 + L2(`classifiedBy:'manual'`),该页所有未采集 SKU 开始 autoCollect

#### Scenario: 人工确认标记非中国

- **WHEN** 用户点击 [✗ 标记为非中国店铺]
- **THEN** SW 写 L1 + L2(`classifiedBy:'manual', isChinese:false`),该页不采集

#### Scenario: 重新分类

- **WHEN** 已分类店铺用户点击 [重新分类]
- **THEN** QX面板回到「待确认」状态,用户可重新标记

#### Scenario: autoCollect Gate 0.5 - 中国店铺通过

- **WHEN** autoCollect action 收到消息,Gate 0 通过,`checkStoreClassification` 返回 isChinese === true
- **THEN** 继续执行 Step 1(三层缓存命中检查)

#### Scenario: autoCollect Gate 0.5 - 非中国店铺跳过

- **WHEN** `config.onlyChineseStores === true` 且 `checkStoreClassification` 返回 isChinese === false
- **THEN** SW 写 log `{status:'skipped', reason:'non-chinese-store', sellerSlug}`,返回 `{status:'skipped', reason:'non-chinese-store'}`,不真调

#### Scenario: autoCollect Gate 0.5 - 未分类店铺跳过

- **WHEN** `config.onlyChineseStores === true` 且 `checkStoreClassification` 返回 null(isChinese === null)
- **THEN** SW 写 log `{status:'skipped', reason:'unclassified-store', sellerSlug}`,返回 `{status:'skipped', reason:'unclassified-store'}`,不真调,等待人工确认

#### Scenario: onlyChineseStores 关闭

- **WHEN** `config.onlyChineseStores === false`
- **THEN** Gate 0.5 不检查中国店铺,所有 SKU 均可触发采集(仍受 Gate 0 + 三层缓存 + 销量/智能筛选过滤)

### Requirement: 八类缓存命中检查

系统 SHALL 在 `autoCollect` action 通过 Gate 0 + Gate 0.5 后,并行查询 8 类缓存的 L1(IndexedDB)和 L2(MongoDB)命中情况,只有未命中(或 stale)的类目才真调。

#### Scenario: 八类全命中

- **WHEN** 某 SKU 的 8 类缓存全部命中且无 stale(bundle 空属性在 6h `attrsEmptyVerifiedAt` 窗口内、marketStats 在 24h 内、followSell 在 4h 内)
- **THEN** SW 不发任何真调请求,写 `auto_collect_log {status:'skipped', reason:'all-cached'}` 后返回

#### Scenario: stale 类目视为未命中

- **WHEN** marketStats 缓存存在但 `fetchedAt` 超 24h,或 followSell 缓存存在但 `fetchedAt` 超 4h,或 bundle 空属性超 6h
- **THEN** SW 视为未命中,对该类目发起真调,其他命中类目跳过

#### Scenario: 部分命中

- **WHEN** 8 类中有 N 类未命中或 stale
- **THEN** SW 只对这 N 类发起真调,已命中的类目跳过

### Requirement: Full 深度采集

系统 SHALL 对每个未命中的 SKU 按 Full 深度采集,覆盖 card/detail/composer/entrypoint/search/bundle/marketStats/followSell 八类。

#### Scenario: 店铺页 SKU

- **WHEN** source 为 `shop-page`
- **THEN** SW 采集 composer/entrypoint/followSell(经 fetchVariantMediaViaBuyerTab);card 已由 content 直写,detail 不采(无 PDP),search/bundle 已由 panel 渲染写入,marketStats 已由 getMarketStats 内部写入

#### Scenario: 详情页 SKU

- **WHEN** source 为 `pdp`
- **THEN** SW 采集 composer/entrypoint/followSell + search/bundle/marketStats;card 和 detail 已由 content 直写

### Requirement: marketStats 缓存

系统 SHALL 把 data/v3 真调的结果归一化后写入 L1 IndexedDB `market_stats_cache` store 和 L2 MongoDB `ozon_market_stats_cache` collection,24h stale。getMarketStats action 改造为缓存感知(真调前先查缓存),_fetchMarketStatsDirect 是底层真调函数(供 autoCollect 和 getMarketStats 共用,不在函数内写缓存,不走 proxyMarketData 代采降级)。

#### Scenario: getMarketStats action 缓存命中

- **WHEN** panel 渲染调 getMarketStats action,L1 或 L2 命中且 `Date.now() - fetchedAt < 24h`
- **THEN** 直接返回缓存数据,不真调 data/v3

#### Scenario: getMarketStats action 缓存未命中

- **WHEN** panel 渲染调 getMarketStats action,缓存未命中或 stale
- **THEN** 内部调 `_fetchMarketStatsDirect(sku)` 真调 data/v3,成功后调 `_marketStatsCacheSet(sku, normalizedData)` 写 L1+L2;若真调失败(seller 未登录)走 `proxyMarketData` 代采降级

#### Scenario: autoCollect 触发 marketStats 采集

- **WHEN** autoCollect Step 1 查 marketStats 缓存未命中或 stale,Step 6 调 `_fetchMarketStatsDirect(sku)` 真调 data/v3
- **THEN** 成功后调 `_marketStatsCacheSet(sku, data)` 写 L1+L2;不走 `proxyMarketData` 代采(autoCollect 有自己的冷却期+每日上限保护)

#### Scenario: marketStats 缓存命中(autoCollect)

- **WHEN** autoCollect 查 marketStats 缓存,L1 或 L2 命中且 `Date.now() - fetchedAt < 24h`
- **THEN** 视为命中,不真调 data/v3

#### Scenario: marketStats 缓存 stale

- **WHEN** L1 或 L2 命中但 `Date.now() - fetchedAt > 24h`
- **THEN** 视为未命中,重新真调 data/v3 并覆盖缓存

#### Scenario: marketStats 真调失败(seller 未登录)

- **WHEN** autoCollect 调 `_fetchMarketStatsDirect` 返回 `{__needSellerLogin: true}`
- **THEN** 标记 marketStats 为 failed(error='AUTH_REQUIRED'),不熔断,不写缓存,其他类目继续

#### Scenario: marketStats 真调返回空

- **WHEN** autoCollect 调 `_fetchMarketStatsDirect` 返回 `null`(data/v3 无 items)
- **THEN** 标记 marketStats 为 failed(error='NO_DATA'),不熔断,不写缓存

### Requirement: followSell 缓存

系统 SHALL 把 jzFetchPublicFollowSell 真调 composer-api 跟卖 modal 的结果写入 L1 IndexedDB `follow_sell_cache` store 和 L2 MongoDB `ozon_follow_sell_cache` collection,4h stale。sessionStorage `jz-fs5:<sku>` 保留作 L0 快速命中。

#### Scenario: jzFetchPublicFollowSell 真调成功

- **WHEN** panel 渲染或 autoCollect 触发 jzFetchPublicFollowSell,composer-api 真调成功
- **THEN** content 侧调 `sendMessage('followSellCacheSet', {sku, data:{count,sellers,source}})`,SW 写 L1 + 异步写 L2

#### Scenario: followSell 缓存命中

- **WHEN** autoCollect 查 followSell 缓存,L1 或 L2 命中且 `Date.now() - fetchedAt < 4h`
- **THEN** 视为命中,不真调 composer-api

#### Scenario: followSell 缓存 stale

- **WHEN** L1 或 L2 命中但 `Date.now() - fetchedAt > 4h`
- **THEN** 视为未命中,重新真调 composer-api 并覆盖缓存

#### Scenario: autoCollect 通过 fetchVariantMediaViaBuyerTab 补采 followSell

- **WHEN** 详情页 autoCollect 触发,fetchVariantMediaViaBuyerTab 注入函数内顺带 fetch 跟卖 modal
- **THEN** 返回 `followSellData`,SW 调 `_followSellCacheSet` 写 L1+L2

### Requirement: 三层限速闸门

系统 SHALL 通过三层闸门控制采集节奏,防止反爬。

#### Scenario: seller portal 闸门

- **WHEN** autoCollect 调 searchVariants(内含 search + bundle 真调)或 _fetchMarketStatsDirect(data/v3 真调)
- **THEN** 复用现有 `_sellerPortalGate`,全局相邻两次 seller portal 请求至少间隔 200ms

#### Scenario: 买家页闸门

- **WHEN** autoCollect 调 fetchVariantMediaViaBuyerTab(entrypoint + composer + followSell 真调)
- **THEN** 经过新增 `_buyerPageGate`,全局相邻两次买家页请求至少间隔 500ms

#### Scenario: 逐 SKU 间隔

- **WHEN** autoCollect 队列连续处理多个 SKU
- **THEN** 经过新增 `_autoCollectGate`,相邻两个 SKU 的 autoCollect 任务至少间隔 1000ms

### Requirement: 反爬熔断

系统 SHALL 在任一采集步骤返回 `ANTIBOT_BLOCKED` 时,立即中止当前 SKU 剩余步骤,设置 10 分钟冷却期。

#### Scenario: 命中反爬

- **WHEN** searchVariants / fetchVariantMediaViaBuyerTab / _fetchMarketStatsDirect 返回 `ANTIBOT_BLOCKED`
- **THEN** SW 设 `config.pausedUntil = now + 10min` 并写 chrome.storage,写 `auto_collect_log {status:'antibot'}`,通知 QX面板 + popup 显示熔断倒计时

#### Scenario: 冷却期内拒绝

- **WHEN** `now < config.pausedUntil` 时收到新的 `autoCollect` 消息
- **THEN** SW 直接返回 `{status:'skipped', reason:'cooldown'}`,不发任何真调

### Requirement: 每日采集上限

系统 SHALL 维护每日采集计数,达上限自动暂停,次日 0 点重置。

#### Scenario: 达上限

- **WHEN** `config.todayCount >= config.perDayLimit`(默认 2000)
- **THEN** SW 返回 `{status:'skipped', reason:'daily-limit'}`

#### Scenario: 次日重置

- **WHEN** 跨日(配置中 `todayDate` 不等于当前日期)
- **THEN** SW 重置 `todayCount=0`、`todayDate=今日`,继续采集

### Requirement: auto_collect_log 持久化

系统 SHALL 把每次 autoCollect 的结果写入 MongoDB `ozon_auto_collect_log` collection(含 8 类 results 数组 + sellerSlug + storeClassified),供 ERP overview 页查询。

#### Scenario: 成功采集

- **WHEN** 某 SKU 采集完成(全部类目成功或部分成功)
- **THEN** 写入日志 `{sku, source, sellerSlug, storeClassified:'chinese'|'non-chinese'|'unclassified', depth, status:'success'|'partial', results:[8 项], totalDuration, collectedAt}`

#### Scenario: 跳过采集 - 非中国店铺

- **WHEN** 因 `onlyChineseStores` 开启且店铺判定为非中国而跳过
- **THEN** 写入日志 `{sku, source, sellerSlug, storeClassified:'non-chinese', status:'skipped', reason:'non-chinese-store'}`

#### Scenario: 跳过采集 - 未分类店铺

- **WHEN** 因 `onlyChineseStores` 开启且店铺未分类而跳过
- **THEN** 写入日志 `{sku, source, sellerSlug, storeClassified:'unclassified', status:'skipped', reason:'unclassified-store'}`

#### Scenario: 跳过采集 - 其他原因

- **WHEN** 因全命中/冷却/每日上限/总开关关闭而跳过
- **THEN** 写入日志 `{sku, source, status:'skipped', reason:'all-cached'|'cooldown'|'daily-limit'|'disabled'}`

### Requirement: 智能筛选

系统 SHALL 支持基于 18 个 range 字段 + 品牌 + 发货模式的智能筛选,只有通过筛选的 SKU 才触发 autoCollect,未通过的跳过(节省配额)。18 字段中 16 个来自 marketStats 缓存,2 个(followerCount/lowestFollowerPrice)来自 followSell 缓存。

#### Scenario: 筛选字段配置

- **WHEN** 用户点击 QX面板「筛选设置」打开模态框
- **THEN** 可配置:18 个 range 字段(月销量/月销售额/价格/重量/上架天数/月周转动态/广告费占比/促销天数/促销折扣/促销转化率/付费推广天数/浏览量/商品卡加购率/搜索目录浏览量/搜索目录加购率/展示转化率/退货取消率/跟卖人数/跟卖最低价)+ 品牌选项(有品牌/无品牌/不限)+ 发货模式(FBS/FBO/不限);支持多模板,localStorage 存储

#### Scenario: 筛选执行

- **WHEN** loadPanelData 加载 panel 数据后,调用 `collectAutoIfMatched`
- **THEN** 先检查「仅抓有销量」(onlyWithSales && soldCount > 0),再检查智能筛选(若启用则 smartMatches),通过则触发 `autoCollectOnSkuSeen`,不通过则不触发

#### Scenario: 未启用筛选

- **WHEN** smartFilterState.enabled = false
- **THEN** smartMatches 返回 true,所有 SKU 均触发 autoCollect(仍受 onlyWithSales 过滤)

#### Scenario: 详情页不筛选

- **WHEN** source 为 `pdp`
- **THEN** 直接调 `autoCollectOnSkuSeen`,不经过销量/智能筛选(用户主动访问 PDP,意图明确),但仍检查中国店铺 Gate 0.5

### Requirement: 仅抓有销量

系统 SHALL 支持「仅抓有销量」开关,启用后只对 soldCount > 0 的 SKU 触发 autoCollect。

#### Scenario: 启用仅抓有销量

- **WHEN** 用户在 QX面板勾选「仅抓有销量」
- **THEN** localStorage `jz-c-sales-filter = '1'`,后续 `passCollectorFilters` 检查 `data.soldCount > 0`(数据来自 marketStats 缓存),无销量的 SKU 不触发 autoCollect

#### Scenario: 关闭仅抓有销量

- **WHEN** 用户取消勾选
- **THEN** localStorage `jz-c-sales-filter = '0'`,所有 SKU 均触发 autoCollect(仍受智能筛选过滤)

#### Scenario: 详情页不受限

- **WHEN** source 为 `pdp` 且用户已勾选「仅抓有销量」
- **THEN** 详情页直接调 `autoCollectOnSkuSeen`,不检查销量(用户主动访问 PDP)

### Requirement: QX采集器面板

系统 SHALL 提供 Ozon 页面上的浮动控制面板(QX采集器),作为自动采集的主控台,从旧 MY采集器面板移植触发方式、自动翻页、智能筛选、仅抓有销量功能,数据落地改为 MongoDB 8 类缓存。新增店铺检测区块与「只采集中国店铺」开关。

#### Scenario: 面板展示与控制

- **WHEN** 用户在店铺页/详情页打开 QX采集器面板
- **THEN** 面板展示:主开关、店铺检测区块、今日统计(成功/跳过/失败/熔断)、缓存类目命中(8 类,marketStats/followSell stale 标橙色)、最近采集列表、自动翻页开关、仅抓有销量开关、**只采集中国店铺开关**、智能筛选入口、强制刷新按钮、查看ERP按钮

#### Scenario: 店铺检测区块 - 已分类为中国

- **WHEN** 当前店铺 isChinese === true
- **THEN** 区块显示「✓ 中国店铺 (规则:cjk-name)」或「(人工确认)」,提供 [重新分类] 按钮

#### Scenario: 店铺检测区块 - 已分类为非中国

- **WHEN** 当前店铺 isChinese === false
- **THEN** 区块显示「✗ 非中国店铺 (规则:...)」或「(人工确认)」,提供 [重新分类] 按钮

#### Scenario: 店铺检测区块 - 待确认

- **WHEN** 当前店铺 isChinese === null
- **THEN** 区块显示「⚠ 待确认」,提供 [✓ 标记中国] [✗ 标记非中国] 按钮;用户点击后调 `classifyStore` action

#### Scenario: 主开关启停

- **WHEN** 用户点击面板「启动/停止」按钮
- **THEN** 切换 `autoCollectRunning` flag,写 chrome.storage,SW 后续 autoCollect 消息据此决定是否执行;启动时若自动翻页开关已勾选则恢复 AutoScroller,停止时停 AutoScroller

#### Scenario: 只采集中国店铺开关

- **WHEN** 用户切换面板「只采集中国店铺」开关
- **THEN** 写 `config.onlyChineseStores` 到 chrome.storage,SW 后续 Gate 0.5 据此决定是否检查中国店铺;关闭时所有 SKU 均可触发采集

#### Scenario: 自动翻页

- **WHEN** 用户勾选「自动翻页」开关
- **THEN** 启动 AutoScroller(每 500ms 滚动,连续 5 次无新卡片触发 onEmpty),滚动使更多商品卡进入视口,触发 IntersectionObserver → loadPanelData → collectAutoIfMatched;队列拥塞时自动暂停翻页,恢复后继续

#### Scenario: 熔断显示

- **WHEN** SW 推送 `antibotDetected` 消息
- **THEN** 面板状态行替换为熔断条,显示剩余冷却倒计时(每秒更新),提供「立即恢复」按钮

#### Scenario: 强制刷新当前页

- **WHEN** 用户点击「强制刷新当前页」按钮
- **THEN** 面板调 `autoCollectForceRefreshPage` action,SW 向当前 tab 发 `__jzAutoCollectResetSeen` 消息清空去重集合,该页所有已见 SKU 重新发 `autoCollect {forceRefresh:true}`

#### Scenario: 查看 ERP

- **WHEN** 用户点击「查看ERP」按钮
- **THEN** 打开 ERP overview 页「自动采集」tab

### Requirement: popup 快捷控制

系统 SHALL 在 popup 提供简化的「自动采集」区块,允许用户快速开关和查看状态。

#### Scenario: 总开关切换

- **WHEN** 用户在 popup 切换「启用自动采集」开关
- **THEN** chrome.storage `autoCollectRunning` 更新,SW 后续 autoCollect 消息据此决定是否执行

#### Scenario: 状态同步

- **WHEN** SW 推送 `antibotDetected` 或 `configChanged` 消息
- **THEN** popup 同步显示状态 dot(运行中/暂停/熔断)+ 今日计数 + 熔断简略倒计时

#### Scenario: 同步缓存(8 类)

- **WHEN** 用户点击 popup「同步缓存」按钮
- **THEN** 触发 `syncAllCacheToL2` message,SW 调 `syncL2Batch(true)` 扫描 8 个 store(search/bundle/card/composer/entrypoint/detail/marketStats/followSell)的未同步记录,补写到 L2 MongoDB

### Requirement: ERP overview 展示

系统 SHALL 在 ERP overview 页新增「自动采集」tab + 「店铺分类」tab,展示采集统计、日志与店铺分类;并适配 8 类缓存矩阵。

#### Scenario: 查看今日统计

- **WHEN** 用户访问 overview 页「自动采集」tab
- **THEN** 调 `GET /admin/api/auto-collect/stats`,展示今日成功率/各类目命中数(8 类)/反爬次数/按店铺分类统计(byStoreClass)

#### Scenario: 查看日志列表

- **WHEN** 用户在「自动采集」tab 输入 sku/status/source/sellerSlug 筛选并查询
- **THEN** 调 `GET /admin/api/auto-collect/logs?sku=&status=&source=&sellerSlug=&...`,展示日志列表分页表格(含 sellerSlug 列)

#### Scenario: 查看店铺分类列表

- **WHEN** 用户访问 overview 页「店铺分类」tab
- **THEN** 调 `GET /ozon/store-classification?isChinese=`,展示分类列表(sellerSlug/sellerName/isChinese/classifiedBy/companyInfo/lastSeenAt),支持 isChinese 筛选 + 手动改分类

#### Scenario: 查看 8 类缓存矩阵

- **WHEN** 用户访问 overview 页「缓存总览」tab
- **THEN** 调 `GET /admin/api/cache/overview`,展示 8 类缓存 SKU 状态矩阵(含 marketStats/followSell stale 状态,bundle 空属性/stale 状态)
