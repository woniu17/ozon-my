# Checklist

> V3 变更:在 V2 八类缓存基础上,(1)去掉搜索页采集相关验收项;(2)新增中国店铺检测验收项(规则引擎/人工确认/三层查询/Gate 0.5/非中国店铺跳过/未分类等待/onlyChineseStores 开关);(3)新增 store_classification collection+端点验收项;(4)新增 store-detector.js 验收项;(5)auto_collect_log 增加 sellerSlug/storeClassified 字段验收;(6)内存计数器新增 byStoreClass 验收;(7)ERP overview 新增店铺分类 tab 验收。

## P0 · Service Worker 核心编排

- [ ] service-worker.js 新增 `_buyerPageGate()`(500ms,从 chrome.storage 读参数,作用域 entrypoint/composer/followSell)
- [ ] service-worker.js 新增 `_autoCollectGate()`(1000ms,从 chrome.storage 读参数)
- [ ] service-worker.js `_loadAutoCollectConfig()` 含 `onlyChineseStores`/`knownChineseSlugs`/`knownNonChineseSlugs` 参数(默认 onlyChineseStores=true)
- [ ] service-worker.js `_IDB_VERSION` 从 5 升级为 6
- [ ] service-worker.js 新增常量 `_IDB_STORE_MARKET_STATS` / `_IDB_STORE_FOLLOW_SELL`
- [ ] service-worker.js `onupgradeneeded` v6 分支创建 `market_stats_cache` / `follow_sell_cache` 两个 store(keyPath=sku),不删旧 6 个 store
- [ ] service-worker.js 新增 `_marketStatsCacheGet(sku)`(查 L1 → L2,含 24h stale 判定)
- [ ] service-worker.js 新增 `_marketStatsCacheSet(sku, data)`(写 L1 + 异步写 L2 + l2Synced 标志)
- [ ] service-worker.js 新增 `_marketStatsCacheDelete(sku)`
- [ ] service-worker.js 新增 `_followSellCacheGet(sku)`(查 L1 → L2,含 4h stale 判定)
- [ ] service-worker.js 新增 `_followSellCacheSet(sku, data)` / `_followSellCacheDelete(sku)`
- [ ] service-worker.js 新增 6 个消息路由:`marketStatsCacheSet/Get/Delete` + `followSellCacheSet/Get/Delete`
- [ ] service-worker.js `fetchVariantMediaViaBuyerTab` 改造为三合一:一次借 tab 执行 2 个 fetch(entrypoint-api.bx + composer-api 跟卖 modal)
- [ ] `fetchVariantMediaViaBuyerTab` fetch 1 成功后写 entrypoint + composer 缓存(追加,不破坏原 entrypoint 写入)
- [ ] `fetchVariantMediaViaBuyerTab` fetch 2 成功后写 followSell 缓存(解析 modal HTML 抽取 sellers)
- [ ] `fetchVariantMediaViaBuyerTab` 返回值新增 `composerFields` 和 `followSellData` 字段
- [ ] service-worker.js 新增 `_fetchMarketStatsDirect(sku)`(从 getMarketStats action 抽取 seller tab 查找 + 注入 fetch data/v3 + 归一化逻辑)
- [ ] `_fetchMarketStatsDirect` 返回类型契约清晰:`{__needSellerLogin}` / `{__antibot:true}` / `null` / `NormalizedItem`
- [ ] `_fetchMarketStatsDirect` 不在此函数内写缓存(由调用方决定)
- [ ] `_fetchMarketStatsDirect` 不走 `proxyMarketData` 代采降级
- [ ] service-worker.js 改造 `case 'getMarketStats'` 为缓存感知:真调前先查 `_marketStatsCacheGet` 命中且未 stale 直接返回
- [ ] service-worker.js `getMarketStats` 缓存未命中时调 `_fetchMarketStatsDirect`,成功后调 `_marketStatsCacheSet` 写缓存
- [ ] service-worker.js `getMarketStats` 保留 `proxyMarketData` 代采降级(保障 panel 渲染可用性)
- [ ] autoCollect Step 6 直接调 `_fetchMarketStatsDirect`(不经过 getMarketStats action),成功后调 `_marketStatsCacheSet` 写缓存
- [ ] **service-worker.js 新增 `classifyStoreByRules(slug, name, companyInfo, config)` 规则引擎**(5 条优先级规则)
- [ ] **service-worker.js 新增 `_erpStoreClassGet(slug)` / `_erpStoreClassSet(slug, record)`**(对接 ERP store-classification 端点)
- [ ] **service-worker.js 新增 `checkStoreClassification(slug, name, companyInfo)` 三层查询函数**(L1 chrome.storage → L2 MongoDB → 规则引擎 → 未分类返回 null)
- [ ] **service-worker.js 新增 `case 'checkStoreClassification'` 消息路由**(返回 `{isChinese, classifiedBy} | null`)
- [ ] **service-worker.js 新增 `case 'classifyStore'` 消息路由**(人工确认,写 L1+L2,classifiedBy='manual')
- [ ] service-worker.js 新增 `case 'autoCollect'` 消息路由(接收 `{sku, source, sellerSlug, depth, forceRefresh?}`)
- [ ] autoCollect Gate 0:autoCollectRunning/paused/冷却期/每日上限/跨日重置
- [ ] **autoCollect Gate 0.5 中国店铺检查**:调 `checkStoreClassification`,onlyChineseStores 开启且 isChinese !== true 时跳过(reason=non-chinese-store 或 unclassified-store)
- [ ] autoCollect Step 1:并行查 8 类缓存,bundle 空属性 6h 窗口,marketStats 24h stale,followSell 4h stale
- [ ] autoCollect Step 2:计算 pending,空则返回 all-cached
- [ ] autoCollect Step 3:`await _autoCollectGate()`
- [ ] autoCollect Step 4:买家页采集(composer+entrypoint+followSell),捕获 ANTIBOT
- [ ] autoCollect Step 5:seller portal 采集(search+bundle),捕获 ANTIBOT
- [ ] autoCollect Step 6:seller portal 采集 marketStats(若未命中或 stale),先检查 `!marketData`(NO_DATA)再检查 `__needSellerLogin`(AUTH_REQUIRED)再检查 `__antibot`(跳 ANTIBOT),失败不熔断
- [ ] autoCollect Step 7:写日志(含 sellerSlug + storeClassified,results 数组 8 项)+ 更新内存计数器(含 byStoreClass)+ todayCount++,返回 success/partial
- [ ] autoCollect ANTIBOT 分支:设 pausedUntil + 通知 QX面板+popup + 写 log + 返回 antibot
- [ ] **autoCollect Gate 0.5 跳过分支也调 `_writeAutoCollectLog`**(记录 non-chinese-store/unclassified-store)
- [ ] service-worker.js `syncL2Batch` 扩展为 8 类(遍历 8 个 store)
- [ ] service-worker.js `_idbScanUnsynced` 扩展为 8 类(扫描 8 个 store 的 `l2Synced=false` 记录)
- [ ] `syncAllCacheToL2` message 处理同步 8 类(`forceAll=true` 扫描全部记录)

## P0 · ERP 后端日志接口

- [ ] cache.js 新增 `GET /admin/api/auto-collect/stats`(聚合统计,byType 含 8 类,**bySource 含 shop-page/pdp**,**byStoreClass 含 chinese/non-chinese/unclassified**)
- [ ] cache.js 新增 `GET /admin/api/auto-collect/logs`(分页+筛选 sku/status/source/**sellerSlug**)
- [ ] cache.js 新增 `GET /admin/api/auto-collect/logs/:sku`(单 SKU 历史)
- [ ] cache.js 新增 `POST /admin/api/auto-collect/log`(SW 写入,JWT 鉴权,字段含 sellerSlug/storeClassified)
- [ ] MongoDB `ozon_auto_collect_log` 创建 4 个索引(sku+collectedAt / status+collectedAt / collectedAt / **sellerSlug+collectedAt**)

## P0 · ERP 缓存端点扩展为 8 类

- [ ] mongo.js `cols` 对象新增 `marketStatsCache` / `followSellCache` 两个 collection
- [ ] cache.js `CACHE_TYPES` 数组追加 `'marketStats'` / `'followSell'`
- [ ] cache.js `getColByType` switch 加 marketStats / followSell 两个 case
- [ ] cache.js 新增 `GET /ozon/cache/marketStats/:sku`(projection 含 data,map 预计算 stale 字段,24h 阈值)
- [ ] cache.js 新增 `POST /ozon/cache/marketStats/:sku`(upsert)
- [ ] cache.js 新增 `DELETE /ozon/cache/marketStats/:sku`
- [ ] cache.js 新增 `GET/POST/DELETE /ozon/cache/followSell/:sku` 三个端点(4h stale 阈值)
- [ ] cache.js `stats` / `list` / `overview` 接口适配 8 类(自动包含 marketStats/followSell)
- [ ] cache.js `opi-preview` 接口不变(marketStats/followSell 不参与 OPI 合成)

## P0 · ERP 店铺分类接口(NEW)

- [ ] mongo.js `cols` 对象新增 `storeClassification` collection(`ozon_store_classification`)
- [ ] cache.js 新增 `GET /ozon/store-classification/:slug`(按 slug 查询单条分类记录)
- [ ] cache.js 新增 `POST /ozon/store-classification/:slug`(upsert 分类记录,含 isChinese/classifiedBy/companyInfo/lastSeenAt)
- [ ] cache.js 新增 `GET /ozon/store-classification`(列表查询,支持 isChinese 筛选 + keyword 搜索 + 分页)
- [ ] cache.js 新增 `DELETE /ozon/store-classification/:slug`(删除单条分类记录)
- [ ] MongoDB `ozon_store_classification` 创建 3 个索引(isChinese / sellerName / lastSeenAt)

## P0 · SW 写日志接口对接

- [ ] service-worker.js 新增 `_writeAutoCollectLog(payload)`(调 ERP API,fire-and-forget,payload 含 sellerSlug/storeClassified)
- [ ] autoCollect Step 7 调用 `_writeAutoCollectLog`
- [ ] autoCollect ANTIBOT 分支调用 `_writeAutoCollectLog`
- [ ] **autoCollect Gate 0.5 跳过分支调用 `_writeAutoCollectLog`**(记录 non-chinese-store/unclassified-store)

## P1 · Content Scripts 接入

- [ ] **新增 `qx-ozon/content/seller-info-main.js`(MAIN world content script)**
- [ ] `seller-info-main.js` 在 manifest.json 配置 `"world": "MAIN"` + `"run_at": "document_idle"`
- [ ] manifest.json 注入 matches 含 `https://www.ozon.ru/seller/*` 和 `https://www.ozon.ru/product/*`
- [ ] `seller-info-main.js` 能直接访问 `window.__NUXT__`(在 MAIN world)
- [ ] `seller-info-main.js` 店铺页读取 `__NUXT__.state.pageInfo.analyticsInfo.sellerId`
- [ ] `seller-info-main.js` 详情页读取 `div[id^="state-webCurrentSeller-"]` 的 `data-state` 属性
- [ ] `seller-info-main.js` 优先 fetch 店铺页第一个 SKU 的详情页 HTML,从 `state-webCurrentSeller.trustFactors` 提取 companyInfo(含 country)
- [ ] `seller-info-main.js` fetch 失败或 HTML 不含 state-webCurrentSeller 时,退回 entrypoint-api(仅 companyName)
- [ ] `seller-info-main.js` 退回方案返回的 companyInfo.country 为 null(需人工确认)
- [ ] `seller-info-main.js` 通过 `window.dispatchEvent(new CustomEvent('jz-seller-info', { detail: {...} }))` 发送数据
- [ ] `ozon-data-panel.js`(ISOLATED world)通过 `window.addEventListener('jz-seller-info', ...)` 接收数据
- [ ] `ozon-product.js`(ISOLATED world)通过 `window.addEventListener('jz-seller-info', ...)` 接收数据
- [ ] `seller-info-main.js` 读取 `__NUXT__` 失败时重试(每 500ms,最多 15s)
- [ ] `seller-info-main.js` 不调用 `chrome.*` API(MAIN world 限制)
- [ ] `ozon-data-panel.js` / `ozon-product.js` 收到 `jz-seller-info` 后调 `sendMessage('checkStoreClassification', ...)`
- [ ] shared-utils.js 新增 `_autoCollectSeen = new Set()`(页面级去重)
- [ ] shared-utils.js 新增 `autoCollectOnSkuSeen(sku, source, sellerSlug)` 函数(含 sellerSlug 参数)
- [ ] shared-utils.js 新增 `window.__jzAutoCollectResetSeen()`(清空去重集合)
- [ ] shared-utils.js 新增 `collectAutoIfMatched(productId, card, info, data, panel, source, sellerSlug)` 筛选入口(含 sellerSlug 参数)
- [ ] shared-utils.js `passCollectorFilters` 移植(onlyWithSales + smartMatches)
- [ ] shared-utils.js 改造 `jzFetchPublicFollowSell`:真调成功后 `sendMessage('followSellCacheSet', ...)`
- [ ] shared-utils.js `jzFetchPublicFollowSell` 失败时(no-sellers/parse-fail)也写缓存
- [ ] **seller-info-main.js (MAIN world) 新增 extractSellerInfoFromShopPage()**(从 URL 提取 slug + DOM sellerName + __NUXT__ sellerId + **fetch 详情页 HTML 提取 companyInfo**)
- [ ] `extractSellerInfoFromShopPage` sellerName 提取多级兜底(`data-widget="sellerTransparency" span.tsHeadline600Large` → h1 → meta og:title → slug)
- [ ] `extractSellerInfoFromShopPage` 等待 `__NUXT__.state.pageInfo.analyticsInfo.sellerId` 出现(15s 超时)
- [ ] `extractSellerInfoFromShopPage` 调用 entrypoint-api `/modal/shop-in-shop-info?seller_id=${sellerId}` 获取 companyInfo(headers: x-o3-app-name=dweb_client, credentials: include)
- [ ] `extractSellerInfoFromShopPage` 解析 `widgetStates`:`textBlock-*-default-1`(sellerLegalInformation)提取 companyName,`cellList-*-default-1`(shopInfo)提取 shopStats
- [ ] `extractSellerInfoFromShopPage` 启发式判断 country(公司名匹配 `Trading Co., LTD` 等中国外贸公司后缀 → country='CN')
- [ ] `extractSellerInfoFromShopPage` entrypoint-api 失败时 companyInfo 为 null,不阻断
- [ ] `extractSellerInfoFromShopPage` 返回 `{slug, name, sellerId, companyInfo}` 或 null(slug 提取失败时)
- [ ] **seller-info-main.js (MAIN world) 新增 `extractSellerInfoFromPDP()` 函数**(详情页专用,从 `div[id^="state-webCurrentSeller-"]` 的 `data-state` 属性解析)
- [ ] `extractSellerInfoFromPDP` 读取 `data-state` HTML 属性(不是 textContent),JSON.parse 解析
- [ ] `extractSellerInfoFromPDP` 提取 sellerId(`badge.subscribed.common.action.params.sellerId`)
- [ ] `extractSellerInfoFromPDP` 提取 sellerName(`sellerCell.centerBlock.title.text`) + sellerSlug(从 sellerLink 正则)
- [ ] `extractSellerInfoFromPDP` 从 `trustFactors[0].tooltip.subtitle` 数组提取 companyInfo(texts[0]=companyName, texts[1]=legalAddress, texts[2] 取逗号前为 country)
- [ ] `extractSellerInfoFromPDP` 返回 `{slug, name, sellerId, companyInfo}` 或 null(DOM 不存在时)
- [ ] `autoCollectRunning` flag 从 chrome.storage.local 读取 + 监听变化
- [ ] **ozon-search.js `loadPanelData` 不接入 autoCollect**(V3 移除搜索页采集)
- [ ] ozon-data-panel.js 页面加载后调 `extractSellerInfoFromShopPage()` 获取 `{slug, name, sellerId, companyInfo}`
- [ ] ozon-data-panel.js 调 `sendMessage('checkStoreClassification', ...)` 更新面板店铺检测状态
- [ ] ozon-data-panel.js `loadPanelData` panel 数据加载后调 `collectAutoIfMatched(..., 'shop-page', sellerSlug)`
- [ ] ozon-data-panel.js 移除旧 `collectSaleIfMatched` / `JZCollectorDB.putSale` 调用链
- [ ] ozon-product.js `extractProductData` 在 cardCacheSet 后提取 sellerSlug(从 `_product.seller.link`)
- [ ] ozon-product.js 调 `sendMessage('checkStoreClassification', {slug, name})` 更新面板店铺检测状态
- [ ] ozon-product.js 调 `autoCollectOnSkuSeen(sku, 'pdp', sellerSlug)`(详情页不筛选,但仍检查中国店铺 Gate 0.5)
- [ ] autoCollectOnSkuSeen 与原有 panelDataCache/variantsQueue/followSellQueue 逻辑不阻塞

## P1.5 · QX采集器面板(从旧 collector 移植)

- [ ] 创建 `qx-ozon/content/qx-collector/` 目录
- [ ] `qx-collector/smart-filter.js` 抽取智能筛选逻辑(18 字段 + 品牌 + 发货模式 + 模板管理),挂 `window.QXSmartFilter`
- [ ] smart-filter.js 18 字段中 16 字段从 marketStats 缓存读取,2 字段从 followSell 缓存读取
- [ ] `qx-collector/auto-scroller.js` 移植(类名 QXAutoScroller,逻辑零改),挂 `window.QXAutoScroller`
- [ ] **`qx-collector/store-detector.js` 创建**(NEW,挂 `window.QXStoreDetector`)
- [ ] store-detector.js `renderStoreDetectionBlock` 根据 isChinese 渲染 4 种状态(中国/非中国/待确认/未检测)
- [ ] store-detector.js [标记中国] 按钮点击 → `sendMessage('classifyStore', {slug, name, isChinese:true})` + 通知该页未采集 SKU 开始 autoCollect
- [ ] store-detector.js [标记非中国] 按钮点击 → `sendMessage('classifyStore', {slug, name, isChinese:false})`
- [ ] store-detector.js [重新分类] 按钮点击 → 区块回到「待确认」状态
- [ ] `qx-collector/panel.js` 创建(精简:去掉本地桶/CSV/推送/关键词采集,保留主开关/自动翻页/仅抓有销量/智能筛选)
- [ ] **panel.js 新增店铺检测区块**(委托 `QXStoreDetector.renderStoreDetectionBlock` 渲染,位于主开关下方)
- [ ] **panel.js 新增「只采集中国店铺」开关**(读写 `config.onlyChineseStores`)
- [ ] panel.js 新增区块:今日统计/缓存类目命中(8 类,marketStats/followSell stale 标橙色)/最近采集/强制刷新/查看ERP/熔断倒计时
- [ ] panel.js 通过 SW action 获取数据(GetConfig/GetStats/GetRecent,5s 轮询 + 推送)
- [ ] panel.js 新增回调 `onOnlyChineseStoresChange`(切换 onlyChineseStores)
- [ ] `qx-collector/panel.css` 创建,样式前缀 `.qx-c-*`
- [ ] 类名 QXCollectorPanel 挂 `window.QXCollectorPanel`
- [ ] SW `autoCollectGetConfig` 返回含 `marketStatsStaleMs` / `followSellStaleMs` / **`onlyChineseStores` / `knownChineseSlugs` / `knownNonChineseSlugs`**
- [ ] SW `autoCollectSetConfig` 支持设置 `marketStatsStaleMs` / `followSellStaleMs` / **`onlyChineseStores` / `knownChineseSlugs` / `knownNonChineseSlugs`**
- [ ] SW `autoCollectGetStats` 返回 `byType` 含 8 类,**`bySource` 含 shop-page/pdp**(去掉 search-page),**`byStoreClass` 含 chinese/non-chinese/unclassified**
- [ ] SW 内存计数器(今日 success/skipped/failed/antibot)+ 环形缓冲(最近 50 条日志)+ byStoreClass
- [ ] SW 启动时从 MongoDB auto_collect_log 聚合初始化内存计数器(含 byStoreClass)
- [ ] **SW `checkStoreClassification` action 可被面板调用**(Task 5.5 已实现)
- [ ] **SW `classifyStore` action 可被面板调用**(Task 5.6 已实现,人工标记中国后触发该页未采集 SKU autoCollect)
- [ ] ozon-data-panel.js 替换 `JZCollectorPanel` → `QXCollectorPanel`
- [ ] ozon-data-panel.js 实例化 `QXAutoScroller`(仅店铺页)
- [ ] ozon-product.js 详情页新增 QX面板挂载(只显示状态/统计/熔断/强制刷新/查看ERP/**店铺检测**,无自动翻页/筛选)
- [ ] **ozon-search.js 不接入 QX面板**(V3 移除搜索页采集)
- [ ] 删除旧 `content/collector/db.js` / `panel.js` / `panel.css` / `keyword-pilot.js` / `anti-ban.js` / `l1-*.js`
- [ ] 保留 `content/collector/task-queue.js`(通用队列)
- [ ] `manifest.json` 注入路径 `collector/*` → `qx-collector/*`
- [ ] 全局搜索无 `JZCollectorDB` / `JZCollectorPanel` / `JZKeywordPilot` / `JZAutoScroller` 残留引用

## P2 · Popup 控制

- [ ] popup.html 新增「自动采集」简化卡片(总开关/今日计数/状态 dot/熔断简略倒计时)
- [ ] popup.html 「同步缓存」按钮文案更新为「同步缓存(8 类)」
- [ ] popup.html 不暴露深度/限速/自动翻页/筛选/**只采集中国店铺**(这些在 QX面板)
- [ ] popup.js 新增 `loadAutoCollectConfig` / `saveAutoCollectConfig`
- [ ] popup.js 总开关切换 → 保存 autoCollectRunning + 通知 SW
- [ ] popup.js 监听 SW `antibotDetected` / `configChanged` 消息 → 同步状态
- [ ] popup.js chrome.storage.onChanged 监听,跨页保持状态一致
- [ ] popup.js `syncAllCacheToL2` 触发同步 8 类 L1 → L2

## P3 · ERP overview 页

- [ ] web/src/api/cache.js 新增 `getAutoCollectStats` / `getAutoCollectLogs` / `getAutoCollectLogsBySku`
- [ ] web/src/api/cache.js 新增 `getMarketStatsCache` / `getFollowSellCache`(调试用)
- [ ] **web/src/api/cache.js 新增 `getStoreClassificationList` / `getStoreClassification` / `updateStoreClassification` / `deleteStoreClassification`**(NEW)
- [ ] Cache.vue tabs 新增 `{key:'auto-collect', label:'自动采集'}` 和 `{key:'store-classification', label:'店铺分类'}`
- [ ] Cache.vue 自动采集 tab 统计卡片(成功率/各类目命中 8 类/反爬次数/**byStoreClass**)
- [ ] Cache.vue 自动采集 tab 日志列表(sku/status/source/**sellerSlug** 筛选 + 分页,表格列含 8 类命中 + sellerSlug)
- [ ] **Cache.vue 店铺分类 tab 分类列表**(isChinese 筛选 + keyword 搜索 + 分页,支持手动改分类)
- [ ] Cache.vue overview 矩阵显示 8 类缓存(marketStats/followSell stale 标橙色)
- [ ] shared-utils.js 监听 `__jzAutoCollectResetSeen` 消息清空去重集合
- [ ] QX面板「强制刷新当前页」按钮 → 调 SW action → 清空去重 + 重发 forceRefresh
- [ ] 强制刷新后该页 SKU 重新真调写入 8 类

## 验证与收尾

### 中国店铺检测验证(NEW)

- [ ] 店铺页浏览中国店铺 10 SKU → 八类缓存各 10 条(detail 空),log 10 条(storeClassified=chinese)
- [ ] 详情页浏览中国店铺 10 SKU → 八类缓存各 10 条(含 detail)
- [ ] **店铺页浏览非中国店铺 → 不触发 autoCollect,log 记 `non-chinese-store`(storeClassified=non-chinese)**
- [ ] **店铺页浏览未分类店铺 → QX面板显示「待确认」,不触发 autoCollect,log 记 `unclassified-store`(storeClassified=unclassified)**
- [ ] **人工标记未分类店铺为中国店铺 → 该页 SKU 开始采集**
- [ ] **人工标记中国店铺为非中国店铺 → 该页后续 SKU 不采集**
- [ ] **规则自动判定:knownNonChineseSlugs 列表中的 slug → 自动标记为非中国店铺**
- [ ] **规则自动判定:companyInfo.country=CN → 自动标记为中国店铺(classifiedBy=rule:company-country)**
- [ ] **规则自动判定:companyInfo.country 非 CN → 自动标记为非中国店铺**
- [ ] **店铺页方案 A 验证:fetch 详情页 HTML 成功 → companyInfo 含 country(如 "CN")→ 规则引擎 Rule 4/5 自动判定**
- [ ] **店铺页方案 B 验证:fetch 失败退回 entrypoint-api → companyInfo 仅 companyName,country=null → 走人工确认**
- [ ] **三层查询缓存命中:同一店铺第二次访问 → L1 命中,不查 L2 不跑规则引擎**
- [ ] **三层查询 L2 命中:L1 未命中时查 L2,L2 命中写 L1 + 返回**
- [ ] **QX面板「只采集中国店铺」开关关闭 → 非中国店铺也采集**
- [ ] **QX面板店铺检测区块 4 种状态显示正确**(中国/非中国/待确认/未检测)
- [ ] **[重新分类] 按钮 → 区块回到「待确认」状态,用户可重新标记**
- [ ] **store-detector.js 渲染逻辑正确**(isChinese=true/false/null/未检测 4 种状态)
- [ ] **搜索页浏览 SKU → 不触发 autoCollect**(V3 已移除搜索页采集)

### 八类缓存验证

- [ ] 重复浏览同 SKU → log 记 skipped/all-cached,零真调
- [ ] marketStats 缓存 24h stale 验证:改 fetchedAt 为 25h 前 → 重新浏览 → marketStats 重新真调,其他类目跳过
- [ ] followSell 缓存 4h stale 验证:改 fetchedAt 为 5h 前 → 重新浏览 → followSell 重新真调,其他类目跳过
- [ ] bundle 空属性 6h 重验验证:改 attrsEmptyVerifiedAt 为 7h 前 → 重新浏览 → bundle 重新真调
- [ ] QX面板主开关关闭 → 不触发 autoCollect
- [ ] QX面板勾选「仅抓有销量」→ 无销量 SKU 不触发(marketStats 缓存 soldCount=0)(仅店铺页,详情页不受限)
- [ ] QX面板配置智能筛选 → 不符合条件 SKU 不触发(仅店铺页)
- [ ] QX面板勾选「自动翻页」→ AutoScroller 滚动加载更多(仅店铺页)
- [ ] 模拟反爬(改 pausedUntil) → QX面板+popup 显示倒计时,期间不采
- [ ] 模拟每日上限(改 todayCount) → 返回 daily-limit
- [ ] marketStats 真调失败 → 不熔断,返回 partial,其他类目正常采集
- [ ] followSell 真调失败 → 不熔断,返回 partial,其他类目正常采集
- [ ] fetchVariantMediaViaBuyerTab 三合一验证:一次借 tab 写 entrypoint+composer+followSell 三类缓存
- [ ] getMarketStats action 改造验证:panel 重复打开时缓存命中优先,不重复真调
- [ ] jzFetchPublicFollowSell 改造验证:sessionStorage L0 命中优先,L0 未命中读 followSell 缓存,缓存未命中再真调
- [ ] 智能筛选 18 字段数据源验证:16 字段从 marketStats 缓存,2 字段从 followSell 缓存

### ERP overview 验证

- [ ] ERP overview「自动采集」tab 可见统计 + 日志列表(含 sellerSlug 列)
- [ ] **ERP overview「店铺分类」tab 可见分类列表(支持 isChinese 筛选),可手动改分类**
- [ ] ERP overview 缓存矩阵显示 8 类(marketStats/followSell stale 标橙色)
- [ ] popup「同步缓存(8 类)」按钮 → 8 类 L1 全部同步到 L2,统计正确
- [ ] 「强制刷新当前页」→ 该页 SKU 重新真调写入 8 类
- [ ] 内存计数器 byStoreClass 统计正确(chinese/non-chinese/unclassified)

### 代码质量

- [ ] 旧 collector 模块已移除,无残留引用
- [ ] 所有修改的 JS 文件 `node --check` 通过
- [ ] `npm run format:check` 通过
- [ ] 现有 batch-upload 功能不受影响
- [ ] 现有 panel 渲染功能不受影响(getMarketStats/jzFetchPublicFollowSell 改造后缓存命中优先)
