# Tasks

> V3 变更:在 V2 八类缓存基础上,(1)去掉搜索页接入任务;(2)新增中国大陆店铺检测相关任务(extractSellerInfoFromShopPage、checkStoreClassification、classifyStoreByRules、classifyStore、store-detector.js、store_classification collection+端点);(3)autoCollect action 新增 Gate 0.5;(4)auto_collect_log 增加 sellerSlug/storeClassified 字段;(5)内存计数器新增 byStoreClass。

## P0 · Service Worker 核心编排

- [ ] Task 1: 新增三层限速闸门
  - [ ] SubTask 1.1: 在 `qx-ozon/background/service-worker.js` 新增 `_buyerPageGate()`,参考现有 `_sellerPortalGate` 实现,默认 500ms 最小间隔,从 `jz-auto-collect-config.buyerPageMinInterval` 读取参数;作用域覆盖 entrypoint/composer/followSell 真调
  - [ ] SubTask 1.2: 同文件新增 `_autoCollectGate()`,默认 1000ms,从 `jz-auto-collect-config.skuInterval` 读取参数;作用域为 autoCollect 逐 SKU 间隔
  - [ ] SubTask 1.3: 新增 `_loadAutoCollectConfig()` 函数,从 chrome.storage.local 读取 `jz-auto-collect-config`,带内存缓存(写入时失效);默认值:`{enabled:true, autoCollectRunning:true, depth:'Full', paused:false, pausedUntil:0, buyerPageMinInterval:500, sellerPortalMinInterval:200, skuInterval:1000, perDayLimit:2000, todayCount:0, todayDate:'', marketStatsStaleMs:86400000, followSellStaleMs:14400000, onlyMainlandChinaStores:true, knownMainlandChinaSlugs:[], knownNonMainlandChinaSlugs:[]}`

- [ ] Task 2: IndexedDB v6 升级 + 8 类缓存读写函数
  - [ ] SubTask 2.1: 在 `service-worker.js` 将 `_IDB_VERSION` 从 5 改为 6,新增常量 `_IDB_STORE_MARKET_STATS = 'market_stats_cache'` 和 `_IDB_STORE_FOLLOW_SELL = 'follow_sell_cache'`
  - [ ] SubTask 2.2: 在 `onupgradeneeded` 处理函数中,当 `event.newVersion === 6` 或旧版本 < 6 时,调 `db.createObjectStore(_IDB_STORE_MARKET_STATS, {keyPath:'sku'})` 和 `db.createObjectStore(_IDB_STORE_FOLLOW_SELL, {keyPath:'sku'})`;不删除旧 6 个 store
  - [ ] SubTask 2.3: 新增 `_marketStatsCacheGet(sku)`:查 L1 IndexedDB → L2 MongoDB,返回记录;含 stale 判定(`Date.now() - fetchedAt > marketStatsStaleMs` 视为未命中,但仍返回记录供上层决定)
  - [ ] SubTask 2.4: 新增 `_marketStatsCacheSet(sku, data)`:写 L1(`{sku, data, fetchedAt:Date.now(), l2Synced:false}`) + 异步写 L2(成功后置 `l2Synced:true`)
  - [ ] SubTask 2.5: 新增 `_marketStatsCacheDelete(sku)`:删 L1 + L2
  - [ ] SubTask 2.6: 新增 `_followSellCacheGet(sku)`:同 marketStats 模式,stale 判定用 `followSellStaleMs`(4h)
  - [ ] SubTask 2.7: 新增 `_followSellCacheSet(sku, data)` 和 `_followSellCacheDelete(sku)`,参考 marketStats 模式
  - [ ] SubTask 2.8: 新增消息路由 `case 'marketStatsCacheSet'` / `case 'marketStatsCacheGet'` / `case 'marketStatsCacheDelete'` / `case 'followSellCacheSet'` / `case 'followSellCacheGet'` / `case 'followSellCacheDelete'`,对接 content 调用

- [ ] Task 3: 改造 `fetchVariantMediaViaBuyerTab` 三合一(写 entrypoint + composer + followSell)
  - [ ] SubTask 3.1: 在 `service-worker.js` 的 `fetchVariantMediaViaBuyerTab` 内,借买家 tab 后**一次执行 2 个 fetch**:
    - fetch 1:`entrypoint-api.bx.lv` (entrypoint 数据),保留现有逻辑
    - fetch 2:`composer-api.ozon.ru` 跟卖 modal(composer + followSell 数据)
  - [ ] SubTask 3.2: fetch 1 成功后:除现有 `_entrypointCacheSet`,额外从响应中抽取 `fields(title/sku/price/images/...)` + `widgetStates`,调 `_composerCacheSet(sku, {fields, widgetStates})` 写 L1+L2
  - [ ] SubTask 3.3: fetch 2 成功后:解析跟卖 modal HTML,抽取 `{count, sellers:[{name,price,sku,link,avatar,rating,reviewsCount,region,deliveryText,deliveryRank}], source:'modal'}`,调 `_followSellCacheSet(sku, data)` 写 L1+L2;失败时写 `{count:0, sellers:[], source:'no-sellers'|'parse-fail'}`
  - [ ] SubTask 3.4: 改造时保留原有 entrypoint 缓存写入逻辑不变,只追加 composer + followSell 写入;保留 `endpoint` 字段返回值不变;新增 `composerFields` 和 `followSellData` 字段返回
  - [ ] SubTask 3.5: 验证视频转存链路(transferVariantVideo)不受影响,该路径不读 composer/followSell 缓存

- [ ] Task 4: 新增 `_fetchMarketStatsDirect` + 改造 `getMarketStats` action
  - [ ] SubTask 4.1: 在 `service-worker.js` 新增 `_fetchMarketStatsDirect(sku)`:从现有 `getMarketStats` action 中抽取 seller tab 查找 + 注入 fetch data/v3 + 归一化逻辑为独立函数;**返回类型契约**:`{__needSellerLogin:true,__reason}` / `{__antibot:true}` / `null`(data/v3 无 items) / `NormalizedItem`(成功)
  - [ ] SubTask 4.2: `_fetchMarketStatsDirect` 成功后返回 `normalizeMarketItem(item)` 归一化结果(18 字段 + category1/category3/brand);**不在此函数内写缓存**,由调用方决定是否写
  - [ ] SubTask 4.3: `_fetchMarketStatsDirect` **不走 `proxyMarketData` 代采降级**(autoCollect 有自己的冷却期+每日上限保护);getMarketStats action 保留代采降级
  - [ ] SubTask 4.4: 改造现有 `case 'getMarketStats'` action 为缓存感知:真调前先查 `_marketStatsCacheGet(sku)`,命中且未 stale(24h)直接返回缓存;未命中或 stale 时调 `_fetchMarketStatsDirect(sku)`,成功后调 `_marketStatsCacheSet(sku, data)` 写 L1+L2;若返回 `__needSellerLogin` 走 `proxyMarketData` 代采降级
  - [ ] SubTask 4.5: autoCollect Step 6 直接调 `_fetchMarketStatsDirect(sku)`(不经过 getMarketStats action),成功后调 `_marketStatsCacheSet` 写缓存;失败不熔断,标记 results 中 marketStats 的 error 字段

- [ ] Task 5: 新增店铺分类查询 + 规则引擎(NEW)
  - [ ] SubTask 5.1: 在 `service-worker.js` 新增 `classifyStoreByRules(slug, name, companyInfo, config)` 规则引擎函数,按优先级执行 4 条规则:
    - Rule 1: `config.knownMainlandChinaSlugs.includes(slug)` → `{isMainlandChina:true, by:'rule:known-list'}`
    - Rule 2: `config.knownNonMainlandChinaSlugs.includes(slug)` → `{isMainlandChina:false, by:'rule:known-list'}`
    - Rule 3: `companyInfo?.country === 'CN'` → `{isMainlandChina:true, by:'rule:company-country'}`
    - Rule 4: `companyInfo?.country && companyInfo.country !== 'CN'` → `{isMainlandChina:false, by:'rule:company-country'}`
    - 无匹配 → `{isMainlandChina:null, by:null}`
  - [ ] SubTask 5.2: 新增 `_erpStoreClassGet(slug)`:调 ERP `GET /ozon/store-classification/:slug`,返回分类记录或 null
  - [ ] SubTask 5.3: 新增 `_erpStoreClassSet(slug, record)`:调 ERP `POST /ozon/store-classification/:slug`,upsert 记录
  - [ ] SubTask 5.4: 新增 `checkStoreClassification(slug, name, companyInfo)` 三层查询函数:
    - L1: `chrome.storage.local.get('jz-store-class-${slug}')`,命中且 isMainlandChina !== null → 返回
    - L2: `_erpStoreClassGet(slug)`,命中且 isMainlandChina !== null → 写 L1 + 返回
    - 规则引擎: `classifyStoreByRules(...)`,isMainlandChina !== null → 写 L1 + L2 + 返回
    - 未分类: 写 L2 记录(isMainlandChina=null,等待人工确认)→ 返回 null
  - [ ] SubTask 5.5: 新增 `case 'checkStoreClassification'` 消息路由,接收 `{slug, name, companyInfo?}`,返回 `{isMainlandChina, classifiedBy} | null`
  - [ ] SubTask 5.6: 新增 `case 'classifyStore'` 消息路由(人工确认),接收 `{slug, name, isMainlandChina}`,构造 record(`classifiedBy:'manual'`, `classifiedAt:new Date()`),写 L1 chrome.storage + L2 MongoDB,返回 `{ok:true}`

- [ ] Task 6: 新增 `autoCollect` action(8 类编排 + Gate 0.5 中国大陆店铺检查)
  - [ ] SubTask 6.1: 在 `service-worker.js` 消息路由新增 `case 'autoCollect'`,接收 `{sku, source, sellerSlug, depth, forceRefresh?}`
  - [ ] SubTask 6.2: Gate 0 检查:autoCollectRunning/paused/冷却期(pausedUntil)/每日上限(todayCount >= perDayLimit)/跨日重置 todayCount;任一不满足返回 `{status:'skipped', reason:'...'}`
  - [ ] SubTask 6.3: **Gate 0.5 中国大陆店铺检查**(NEW):调 `checkStoreClassification(sellerSlug, ...)`,若 `config.onlyMainlandChinaStores === true` 且 `cls?.isMainlandChina !== true`,写 log + 返回 `{status:'skipped', reason: cls?.isMainlandChina === false ? 'non-mainland-china-store' : 'unclassified-store'}`
  - [ ] SubTask 6.4: Step 1 并行查 8 类缓存:
    - card/detail:已有 content 写入,查命中
    - composer/entrypoint:查命中
    - search/bundle:查命中,bundle 空属性查 `attrsEmptyVerifiedAt`(6h 内视为 hit)
    - marketStats:查命中 + stale 判定(24h 内视为 hit)
    - followSell:查命中 + stale 判定(4h 内视为 hit)
    - forceRefresh=true 时跳过命中检查
  - [ ] SubTask 6.5: Step 2 计算 pending 类目,若空则返回 `{status:'skipped', reason:'all-cached'}`
  - [ ] SubTask 6.6: Step 3 `await _autoCollectGate()`(逐 SKU 间隔)
  - [ ] SubTask 6.7: Step 4 若 composer/entrypoint/followSell 未命中:`await _buyerPageGate()` + `fetchVariantMediaViaBuyerTab`,根据返回 `endpoint` 写 entrypoint 缓存,根据 `composerFields` 写 composer 缓存,根据 `followSellData` 写 followSell 缓存;捕获 `ANTIBOT_BLOCKED` 跳 ANTIBOT 分支
  - [ ] SubTask 6.8: Step 5 若 search/bundle 未命中:`await _sellerPortalGate()` + `searchVariants({sku, forceRefresh:false})`(内部自动调 fetchBundleByVariantId);捕获 antibot 跳 ANTIBOT
  - [ ] SubTask 6.9: Step 6 若 marketStats 未命中或 stale:`await _sellerPortalGate()` + `_fetchMarketStatsDirect(sku)`;先检查 `!marketData`(NO_DATA),再检查 `__needSellerLogin`(AUTH_REQUIRED),再检查 `__antibot`(跳 ANTIBOT),否则正常写缓存;失败不熔断(返回 partial)
  - [ ] SubTask 6.10: Step 7 写 auto_collect_log(含 sellerSlug + storeClassified,results 数组 8 项)+ 更新内存计数器(含 byStoreClass),`todayCount++` 并写 chrome.storage,返回 `{status:'success'|'partial', results, totalDuration}`
  - [ ] SubTask 6.11: ANTIBOT 分支:`config.pausedUntil = now + 10*60*1000` 写 chrome.storage,通知 QX面板 + popup(chrome.runtime.sendMessage),写 log `{status:'antibot'}`,返回 `{status:'antibot'}`

## P0 · ERP 后端日志接口 + 缓存端点扩展 + 店铺分类

- [ ] Task 7: 新增 `ozon_auto_collect_log` collection 接口
  - [ ] SubTask 7.1: 在 `erp-backend-lite/src/modules/cache.js` 新增 `GET /admin/api/auto-collect/stats`:聚合 `ozon_auto_collect_log`,返回今日/本周的 `{total, success, partial, failed, skipped, antibot, byType:{card,detail,composer,entrypoint,search,bundle,marketStats,followSell}, bySource:{shop-page,pdp}, byStoreClass:{mainland-china,non-mainland-china,unclassified}}`
  - [ ] SubTask 7.2: 新增 `GET /admin/api/auto-collect/logs`:支持 query `sku/status/source/sellerSlug/currentPage/pageSize/startTime/endTime`,按 collectedAt DESC 分页,返回 `{items:[...], total, current, pageSize}`
  - [ ] SubTask 7.3: 新增 `GET /admin/api/auto-collect/logs/:sku`:返回该 SKU 的全部采集历史(按 collectedAt DESC)
  - [ ] SubTask 7.4: 新增 `POST /admin/api/auto-collect/log`(内部接口,SW 调用):写入一条日志,字段含 `sku/source/sellerSlug/storeClassified/depth/status/results/totalDuration/collectedAt`;此接口走 JWT 鉴权(SW 持 token)
  - [ ] SubTask 7.5: 为 `ozon_auto_collect_log` 创建索引:`{sku:1, collectedAt:-1}`、`{status:1, collectedAt:-1}`、`{collectedAt:-1}`、`{sellerSlug:1, collectedAt:-1}`

- [ ] Task 8: ERP 缓存端点扩展为 8 类
  - [ ] SubTask 8.1: 在 `erp-backend-lite/src/db/mongo.js` 的 `cols` 对象新增 `marketStatsCache` 和 `followSellCache` 两个 collection
  - [ ] SubTask 8.2: 在 `erp-backend-lite/src/modules/cache.js` 的 `CACHE_TYPES` 数组追加 `'marketStats'` 和 `'followSell'`;`getColByType` switch 加 2 个 case
  - [ ] SubTask 8.3: 新增 `GET /ozon/cache/marketStats/:sku`:返回记录,projection 含 `data`;map 阶段预计算 `stale` 字段(`Date.now() - fetchedAt > 86400000`)
  - [ ] SubTask 8.4: 新增 `POST /ozon/cache/marketStats/:sku`:upsert `{_id:sku, sku, data, fetchedAt, l2Synced:true}`
  - [ ] SubTask 8.5: 新增 `DELETE /ozon/cache/marketStats/:sku`:删除记录
  - [ ] SubTask 8.6: 新增 `GET/POST/DELETE /ozon/cache/followSell/:sku` 三个端点,参考 marketStats 模式,stale 判定用 4h(14400000ms)
  - [ ] SubTask 8.7: `stats` / `list` / `overview` 接口适配 8 类:遍历 `CACHE_TYPES` 时自动包含 marketStats/followSell,overview 矩阵显示 8 类
  - [ ] SubTask 8.8: `opi-preview` 接口不变(marketStats/followSell 不参与 OPI 合成,仅作筛选/展示用)

- [ ] Task 9: 新增 `ozon_store_classification` collection + 4 个端点(NEW)
  - [ ] SubTask 9.1: 在 `erp-backend-lite/src/db/mongo.js` 的 `cols` 对象新增 `storeClassification: () => getMongo().then((d) => d.collection('ozon_store_classification'))`
  - [ ] SubTask 9.2: 在 `erp-backend-lite/src/modules/cache.js` 新增 `GET /ozon/store-classification/:slug`:按 slug 查询单条分类记录,返回 `{sellerSlug, sellerName, isMainlandChina, classifiedBy, companyInfo, lastSeenAt, lastSeenUrl}` 或 404
  - [ ] SubTask 9.3: 新增 `POST /ozon/store-classification/:slug`:upsert 分类记录,字段含 `sellerSlug/sellerName/isMainlandChina/classifiedBy/classifiedAt/companyInfo/lastSeenAt/lastSeenUrl`;已存在时更新 isMainlandChina/classifiedBy/classifiedAt 并刷新 lastSeenAt
  - [ ] SubTask 9.4: 新增 `GET /ozon/store-classification`:列表查询,支持 query `isMainlandChina=true/false/null` 筛选 + `keyword`(匹配 sellerName/sellerSlug)+ `currentPage/pageSize` 分页,按 lastSeenAt DESC
  - [ ] SubTask 9.5: 新增 `DELETE /ozon/store-classification/:slug`:删除单条分类记录
  - [ ] SubTask 9.6: 为 `ozon_store_classification` 创建索引:`{isMainlandChina:1}`、`{sellerName:1}`、`{lastSeenAt:-1}`

- [ ] Task 10: SW 写日志接口对接
  - [ ] SubTask 10.1: 在 `service-worker.js` 新增 `_writeAutoCollectLog(payload)` 函数,内部调 ERP `POST /admin/api/auto-collect/log`(带 JWT token,复用现有 ERP client 模块),fire-and-forget 不阻塞返回;payload 含 `sku/source/sellerSlug/storeClassified/depth/status/results/totalDuration`
  - [ ] SubTask 10.2: 在 Task 6 的 Step 7、Gate 0.5 跳过分支、ANTIBOT 分支调用 `_writeAutoCollectLog`

- [ ] Task 11: 扩展 `syncL2Batch` 为 8 类
  - [ ] SubTask 11.1: 在 `service-worker.js` 的 `syncL2Batch` 函数中,遍历数组从 6 个 store 扩展为 8 个:新增 `market_stats_cache` 和 `follow_sell_cache`
  - [ ] SubTask 11.2: `_idbScanUnsynced` 函数同步扩展,扫描 8 个 store 的 `l2Synced=false` 记录
  - [ ] SubTask 11.3: `forceAll=true` 模式(手动同步按钮)扫描 8 个 store 的全部记录
  - [ ] SubTask 11.4: popup「同步缓存」按钮触发的 `syncAllCacheToL2` message 处理同步 8 类

## P1 · Content Scripts 接入

- [ ] Task 12: shared-utils.js 新增 `autoCollectOnSkuSeen` 统一入口
  - [ ] SubTask 12.1: 在 `qx-ozon/content/shared-utils.js` 新增模块级 `const _autoCollectSeen = new Set()`(页面级去重)
  - [ ] SubTask 12.2: 新增函数 `autoCollectOnSkuSeen(sku, source, sellerSlug)`:若 `!_autoCollectSeen.has(sku)`,加入集合 + `sendMessage('autoCollect', {sku, source, sellerSlug, depth:'Full'})` fire-and-forget;函数挂到 `window.__jzAutoCollectOnSkuSeen` 供强制刷新时清空
  - [ ] SubTask 12.3: 新增 `window.__jzAutoCollectResetSeen()` 函数,清空 `_autoCollectSeen` 集合(供面板/popup「强制刷新当前页」调用)

- [ ] Task 13: shared-utils.js 新增 `collectAutoIfMatched` 筛选入口
  - [ ] SubTask 13.1: 新增 `collectAutoIfMatched(productId, card, info, data, panel, source, sellerSlug)`:检查 `autoCollectRunning` flag → `jzExtractPanelFilterData` → `waitForCollectorFilterData` → `passCollectorFilters` → 通过则调 `autoCollectOnSkuSeen(sku, source, sellerSlug)`
  - [ ] SubTask 13.2: `passCollectorFilters(data, info)` 移植自旧 panel.js:先检查 onlyWithSales(soldCount > 0),再检查 smartFilterState.enabled && smartMatches
  - [ ] SubTask 13.3: `autoCollectRunning` flag 从 chrome.storage.local 读取,面板/popup 可切换;content script 启动时加载初始值 + 监听 storage 变化

- [ ] Task 14: shared-utils.js 改造 `jzFetchPublicFollowSell` 写 followSell 缓存
  - [ ] SubTask 14.1: 在 `jzFetchPublicFollowSell` 真调 composer-api 跟卖 modal 成功后,在写 sessionStorage L0(`jz-fs5:<sku>`)之后,追加 `sendMessage('followSellCacheSet', {sku, data:{count, sellers, source:'modal'}})`
  - [ ] SubTask 14.2: 真调返回 `no-sellers` 或 `parse-fail` 时也写缓存(`source` 字段标记),避免短期重复请求
  - [ ] SubTask 14.3: sessionStorage L0 保留(4h TTL,快速命中);MongoDB L2 作跨设备共享(4h stale)
  - [ ] SubTask 14.4: 验证 panel 渲染时优先读 sessionStorage L0,L0 未命中再读 followSell 缓存,缓存未命中再真调

- [ ] Task 15: 新增 `qx-ozon/content/seller-info-main.js`(MAIN world)实现 `extractSellerInfoFromShopPage` + `extractSellerInfoFromPDP`(NEW)
  - [ ] **架构约束**:此文件在 manifest.json 中配置 `"world": "MAIN"`,能直接访问 `window.__NUXT__`;通过 `CustomEvent('jz-seller-info')` 与 ISOLATED world 通信
  - [ ] SubTask 15.1: 新增 `extractSellerInfoFromShopPage()` 函数,从店铺页 URL 提取 sellerSlug:`location.pathname.match(/\/seller\/([^/]+)/)?.[1]`
  - [ ] SubTask 15.2: 从 DOM 提取 sellerName,优先级:`document.querySelector('[data-widget="sellerTransparency"] span.tsHeadline600Large')?.textContent?.trim()` → `document.querySelector('h1')?.textContent?.trim()` → `document.querySelector('meta[property="og:title"]')?.content?.split(/[–-]/)[0]?.trim()` → slug
  - [ ] SubTask 15.3: 等待 `window.__NUXT__.state.pageInfo.analyticsInfo.sellerId` 出现(15s 超时,每 500ms 检查),提取 sellerId 并 `String()` 转字符串
  - [ ] SubTask 15.4: 店铺页 companyInfo 提取(方案 A 优先):从店铺页 DOM 找第一个 SKU 链接(优先 `[data-widget="searchResultsV2"] a[href*="/product/"]`)→ fetch 详情页 HTML(带 cookie,同源)→ DOMParser 解析 → 找 `div[id^="state-webCurrentSeller-"]` → 读 `data-state` 属性 → JSON.parse → 从 `trustFactors[0].tooltip.subtitle` 数组提取 companyInfo(companyName/legalAddress/country);校验详情页 sellerSlug 与店铺页 slug 一致
  - [ ] SubTask 15.5: 店铺页 companyInfo 退回(方案 B):fetch 失败(网络错误/403)或 HTML 不含 state-webCurrentSeller 或 data-state 解析失败时,退回 entrypoint-api `/modal/shop-in-shop-info?seller_id=${sellerId}`(仅 companyName,无 country/legalAddress)
  - [ ] SubTask 15.6: `extractSellerInfoFromShopPage` 返回 `{slug, name, sellerId, companyInfo, method:'via-pdp'|'via-entrypoint-api'|'failed'}`,companyInfo 含 companyName/legalAddress/country(方案 A)或仅 companyName(方案 B);slug 提取失败时返回 null
  - [ ] SubTask 15.7: 新增 `extractSellerInfoFromPDP()` 函数(详情页专用):等待 `document.querySelector('[id^="state-webCurrentSeller-"]')` 出现(10s 超时)
  - [ ] SubTask 15.8: 读取 `data-state` HTML 属性(**注意:是 attribute,不是 textContent**),JSON.parse 解析;从 `badge.subscribed.common.action.params.sellerId` 或 `badge.unsubscribed.common.action.params.sellerId` 提取 sellerId;从 `sellerCell.centerBlock.title.text` 提取 sellerName;从 `sellerCell.centerBlock.common.action.link` 正则 `/seller/([^/]+)/` 提取 sellerSlug
  - [ ] SubTask 15.9: 从 `trustFactors[0].tooltip.subtitle` 数组提取 companyInfo:filter `type=='text'` 取 `content`,texts[0]=companyName,texts[1]=legalAddress,texts[2] 取逗号前大写为 country(如 "CN, Xiamen" → "CN")
  - [ ] SubTask 15.10: 返回 `{slug, name, sellerId, companyInfo}` 对象;`state-webCurrentSeller` DOM 不存在时返回 null
  - [ ] SubTask 15.11: `seller-info-main.js` 通过 `window.dispatchEvent(new CustomEvent('jz-seller-info', { detail: { pageType, slug, name, sellerId, companyInfo } }))` 发送数据;ISOLATED world 的 ozon-data-panel.js / ozon-product.js 通过 `window.addEventListener('jz-seller-info', ...)` 接收

- [ ] Task 15.5: manifest.json 新增 seller-info-main.js 注入配置
  - [ ] SubTask 15.5.1: 在 `content_scripts` 数组新增注入块,matches 含 `https://www.ozon.ru/seller/*` 和 `https://www.ozon.ru/product/*`,js 为 `content/seller-info-main.js`,`"world": "MAIN"`,`"run_at": "document_idle"`
  - [ ] SubTask 15.5.2: 验证 `seller-info-main.js` 在 MAIN world 执行(能访问 `window.__NUXT__`)
  - [ ] SubTask 15.5.3: 验证 ISOLATED world 的 content script 能收到 `jz-seller-info` CustomEvent

- [ ] Task 16: ozon-data-panel.js 店铺页接入(含卖家信息提取 + 中国大陆店铺检测)
  - [ ] SubTask 16.1: 在 `qx-ozon/content/ozon-data-panel.js` 页面加载后,先调 `extractSellerInfoFromShopPage()` 获取 `{slug, name, sellerId, companyInfo}`
  - [ ] SubTask 16.2: 调 `sendMessage('checkStoreClassification', {slug, name, companyInfo})`,获取 `{isMainlandChina, classifiedBy} | null`,更新 QX面板店铺检测区块状态
  - [ ] SubTask 16.3: 在 `loadPanelData` 中,panel 数据加载完成后调用 `collectAutoIfMatched(productId, card, info, data, panel, 'shop-page', sellerSlug)`(sellerSlug 来自 Step 16.1)
  - [ ] SubTask 16.4: 移除旧 `collectSaleIfMatched` / `JZCollectorDB.putSale` 调用链
  - [ ] SubTask 16.5: 验证 searchVariants/getMarketStats/jzFetchPublicFollowSell 重复调用场景:panel 渲染的 taskQueue/followSellQueue 与 autoCollect 都会调,SW 三层缓存命中检查会去重,无问题

- [ ] Task 17: ozon-product.js 详情页接入(含 sellerSlug 提取 + 中国大陆店铺检测)
  - [ ] SubTask 17.1: 在 `qx-ozon/content/ozon-product.js` 的 `extractProductData` 内,在现有 `detailCacheSet` + `cardCacheSet` 之后,从 `_product.seller.link` 提取 sellerSlug:`seller.link?.match(/\/seller\/([^/]+)/)?.[1] || ''`
  - [ ] SubTask 17.2: 调 `sendMessage('checkStoreClassification', {slug: sellerSlug, name: _product.seller.name})`,获取分类结果,更新 QX面板店铺检测区块状态
  - [ ] SubTask 17.3: 调用 `autoCollectOnSkuSeen(String(_product.sku), 'pdp', sellerSlug)`(详情页无 panel 数据,不经过销量/智能筛选,但仍检查中国大陆店铺 Gate 0.5)
  - [ ] SubTask 17.4: 验证详情页 detail+card 已在 content 写完,autoCollect 内部查这两类命中即跳过,只采剩 6 类(composer/entrypoint/search/bundle/marketStats/followSell)

## P1.5 · QX采集器面板(从旧 collector 移植)

- [ ] Task 18: 创建 qx-collector 目录结构 + 移植 smart-filter.js
  - [ ] SubTask 18.1: 创建 `qx-ozon/content/qx-collector/` 目录
  - [ ] SubTask 18.2: 从旧 `collector/panel.js` 抽取智能筛选逻辑(smartGetDataField/smartMatches/smartHasBrand/smartMissingFields/SMART_FILTER_FIELD_KEYS/SMART_FILTER_SELECT_KEYS/SMART_FILTER_BRAND_OPTIONS/模板管理)到 `qx-collector/smart-filter.js`,导出为 `window.QXSmartFilter`
  - [ ] SubTask 18.3: smart-filter.js 挂到 window.QXSmartFilter,供 panel.js 和 collectAutoIfMatched 调用
  - [ ] SubTask 18.4: 智能筛选 18 字段中,16 字段从 marketStats 缓存读取(soldCount/gmvSum/avgPrice/salesDynamics/drr/avgOrdersOnAccDays/avgGmvOnAccDays/daysInPromo/discount/promoRevenueShare/daysWithTrafarets/qtyViewPdp/sessionCount/sessionCountSearch/pdpToCartConversion/convToCartPdp),2 字段从 followSell 缓存读取(followerCount=跟卖卖家数/lowestFollowerPrice=跟卖最低价)

- [ ] Task 19: 移植 auto-scroller.js
  - [ ] SubTask 19.1: 复制 `collector/auto-scroller.js` 到 `qx-collector/auto-scroller.js`,类名改为 `QXAutoScroller`,挂到 `window.QXAutoScroller`
  - [ ] SubTask 19.2: 逻辑零改(500ms 滚动 / 5 次空轮 onEmpty / 队列拥塞暂停)

- [ ] Task 20: 创建 qx-collector/store-detector.js(NEW)
  - [ ] SubTask 20.1: 创建 `qx-collector/store-detector.js`,挂到 `window.QXStoreDetector`
  - [ ] SubTask 20.2: 实现 `renderStoreDetectionBlock(container, {slug, name, isMainlandChina, classifiedBy})` 函数,根据 isMainlandChina 渲染不同状态:
    - `true`:显示「✓ 中国大陆店铺 (规则:xxx)」或「(人工确认)」+ [重新分类] 按钮
    - `false`:显示「✗ 非中国大陆店铺 (规则:xxx)」或「(人工确认)」+ [重新分类] 按钮
    - `null`:显示「⚠ 待确认」+ [✓ 标记中国大陆] [✗ 标记非中国大陆] 按钮
    - 未检测:显示「— 等待页面加载 —」
  - [ ] SubTask 20.3: [标记中国大陆] 按钮点击 → `sendMessage('classifyStore', {slug, name, isMainlandChina:true})` → 刷新区块状态 → 通知该页所有未采集 SKU 开始 autoCollect
  - [ ] SubTask 20.4: [标记非中国大陆] 按钮点击 → `sendMessage('classifyStore', {slug, name, isMainlandChina:false})` → 刷新区块状态
  - [ ] SubTask 20.5: [重新分类] 按钮点击 → 区块回到「待确认」状态(不清除 L1/L2 记录,仅 UI 状态变化,用户重新标记后覆盖)

- [ ] Task 21: 创建 qx-collector/panel.js + panel.css(含店铺检测区块 + 只采集中国大陆店铺开关)
  - [ ] SubTask 21.1: 创建 `qx-collector/panel.js`,参考旧 `collector/panel.js` 但精简:去掉本地桶/CSV/推送/关键词采集,保留主开关/自动翻页/仅抓有销量/智能筛选模态框
  - [ ] SubTask 21.2: 新增**店铺检测区块**(委托 `QXStoreDetector.renderStoreDetectionBlock` 渲染),位于主开关下方
  - [ ] SubTask 21.3: 新增**「只采集中国大陆店铺」开关**(checkbox),读写 `config.onlyMainlandChinaStores`
  - [ ] SubTask 21.4: 新增区块:今日统计(成功/跳过/失败/熔断)、缓存类目命中(**8 类**,marketStats/followSell stale 标橙色)、最近采集列表、强制刷新当前页、查看ERP、熔断倒计时条
  - [ ] SubTask 21.5: 面板通过 SW action 获取数据:`autoCollectGetConfig` / `autoCollectGetStats` / `autoCollectGetRecent`,每 5s 轮询 + SW 主动推送(`antibotDetected` / `configChanged`)
  - [ ] SubTask 21.6: 回调:`onToggleRunning`(切换 autoCollectRunning + 联动 AutoScroller)、`onAutoScrollToggle`、`onSalesFilterChange`、`onOnlyMainlandChinaStoresChange`、`onFilterOpen/Save/Reset`、`onForceRefresh`、`onViewErp`
  - [ ] SubTask 21.7: 创建 `qx-collector/panel.css`,样式前缀改为 `.qx-c-*`(避免与旧 `.jz-c-*` 冲突)
  - [ ] SubTask 21.8: 类名 `QXCollectorPanel`,挂到 `window.QXCollectorPanel`,create() 工厂方法与旧版兼容

- [ ] Task 22: SW 新增 autoCollect* + checkStoreClassification/classifyStore action(供面板调用)
  - [ ] SubTask 22.1: `case 'autoCollectGetConfig'` 返回 `{enabled, autoCollectRunning, depth, paused, pausedUntil, todayCount, perDayLimit, todayDate, marketStatsStaleMs, followSellStaleMs, onlyMainlandChinaStores, knownMainlandChinaSlugs, knownNonMainlandChinaSlugs}`
  - [ ] SubTask 22.2: `case 'autoCollectSetConfig'` 接收 `{enabled?, autoCollectRunning?, paused?, depth?, marketStatsStaleMs?, followSellStaleMs?, onlyMainlandChinaStores?, knownMainlandChinaSlugs?, knownNonMainlandChinaSlugs?}`,写 chrome.storage + 推送 `configChanged` 消息
  - [ ] SubTask 22.3: `case 'autoCollectGetStats'` 返回内存计数器 `{today:{success,skipped,failed,antibot,total}, byType(8类), bySource:{shop-page,pdp}, byStoreClass:{mainland-china,non-mainland-china,unclassified}, successRate}`
  - [ ] SubTask 22.4: `case 'autoCollectGetRecent'` 接收 `{limit?:5}`,返回内存环形缓冲最近 N 条 `[{sku,source,status,duration,timestamp}]`
  - [ ] SubTask 22.5: `case 'autoCollectForceRefreshPage'` 向当前 tab 发 `__jzAutoCollectResetSeen` 消息,清空去重集合
  - [ ] SubTask 22.6: `case 'checkStoreClassification'`(Task 5.5 已实现,此处确认面板可调用)
  - [ ] SubTask 22.7: `case 'classifyStore'`(Task 5.6 已实现,此处确认面板可调用);人工标记为中国大陆店铺后,向当前 tab 发消息触发该页未采集 SKU 开始 autoCollect
  - [ ] SubTask 22.8: SW 内存计数器 + 环形缓冲:今日 success/skipped/failed/antibot 计数 + 最近 50 条日志,byType 含 8 类,bySource 含 shop-page/pdp,byStoreClass 含 mainland-china/non-mainland-china/unclassified,SW 启动时从 MongoDB auto_collect_log 聚合初始化

- [ ] Task 23: ozon-data-panel.js / ozon-product.js 接入 QX面板
  - [ ] SubTask 23.1: ozon-data-panel.js 替换 `JZCollectorPanel.create` 为 `QXCollectorPanel.create`,回调对接 autoCollectRunning/AutoScroller/智能筛选/仅抓有销量/**只采集中国大陆店铺**
  - [ ] SubTask 23.2: ozon-product.js 详情页新增 QX面板挂载(原 MY采集器不在详情页显示,QX采集器需要在详情页也显示)
  - [ ] SubTask 23.3: 详情页面板只展示状态/统计/熔断/强制刷新/查看ERP/**店铺检测**,不展示自动翻页/仅抓有销量/智能筛选(详情页无商品卡列表,无筛选场景)
  - [ ] SubTask 23.4: ozon-data-panel.js 移除 `collectSaleIfMatched` / `JZCollectorDB.putSale` / `pushBucketToCollectBoxV2` 相关代码
  - [ ] SubTask 23.5: AutoScroller 实例化改用 `QXAutoScroller`(仅店铺页)
  - [ ] SubTask 23.6: **ozon-search.js 不接入 QX面板**(V3 移除搜索页采集)

- [ ] Task 24: 移除旧 collector 模块 + manifest 调整
  - [ ] SubTask 24.1: 删除 `content/collector/db.js` / `panel.js` / `panel.css` / `keyword-pilot.js` / `anti-ban.js` / `l1-shadow-db.js` / `l1-bridge.js` / `l1-diff.js`
  - [ ] SubTask 24.2: 保留 `content/collector/task-queue.js`(通用队列,panel 渲染仍用)
  - [ ] SubTask 24.3: `manifest.json` content_scripts 注入路径从 `collector/*` 改为 `qx-collector/*`
  - [ ] SubTask 24.4: 全局搜索 `JZCollectorDB` / `JZCollectorPanel` / `JZKeywordPilot` / `JZAutoScroller` 引用,确保无残留

## P2 · Popup 控制

- [ ] Task 25: popup.html 新增「自动采集」简化区块
  - [ ] SubTask 25.1: 在 `qx-ozon/popup/popup.html` 现有区块之后新增「自动采集」卡片,含:总开关 checkbox、今日已采 span、状态 dot(运行中/暂停/熔断)
  - [ ] SubTask 25.2: 熔断简略提示(默认隐藏):倒计时 span
  - [ ] SubTask 25.3: 复用现有 popup.css 风格,不引入新样式文件;不暴露深度/限速/自动翻页/筛选/只采集中国大陆店铺(这些在 QX面板)
  - [ ] SubTask 25.4: 「同步缓存」按钮文案更新为「同步缓存(8 类)」,触发 `syncAllCacheToL2` 同步 8 类 L1 → L2

- [ ] Task 26: popup.js 配置读写 + 状态展示
  - [ ] SubTask 26.1: 在 `qx-ozon/popup/popup.js` 新增 `loadAutoCollectConfig()` / `saveAutoCollectConfig(cfg)`,读写 chrome.storage.local `jz-auto-collect-config`
  - [ ] SubTask 26.2: popup 加载时调 `loadAutoCollectConfig` 渲染开关/今日计数/状态;总开关切换 → `saveAutoCollectConfig({autoCollectRunning})` + 触发 SW 通知
  - [ ] SubTask 26.3: 监听 SW 推送的 `antibotDetected` / `configChanged` 消息,同步更新状态 dot + 熔断倒计时
  - [ ] SubTask 26.4: 跨页保持状态一致(chrome.storage.onChanged 监听)

## P3 · ERP overview 页

- [ ] Task 27: 前端 API 函数
  - [ ] SubTask 27.1: 在 `erp-backend-lite/web/src/api/cache.js` 新增 `getAutoCollectStats()` / `getAutoCollectLogs(params)` / `getAutoCollectLogsBySku(sku)` 三个函数,调对应后端端点
  - [ ] SubTask 27.2: 新增 `getMarketStatsCache(sku)` / `getFollowSellCache(sku)` 等缓存查询函数(供调试用)
  - [ ] SubTask 27.3: 新增 `getStoreClassificationList(params)` / `getStoreClassification(slug)` / `updateStoreClassification(slug, data)` / `deleteStoreClassification(slug)` 四个店铺分类 API 函数(NEW)

- [ ] Task 28: Cache.vue 新增「自动采集」tab + 「店铺分类」tab + overview 适配 8 类
  - [ ] SubTask 28.1: 在 `erp-backend-lite/web/src/views/Cache.vue` 的 tabs 数组新增 `{key:'auto-collect', label:'自动采集'}` 和 `{key:'store-classification', label:'店铺分类'}`
  - [ ] SubTask 28.2: 自动采集 tab - 新增统计卡片:今日成功率、各类目命中数(8 类)、反爬次数、按店铺分类统计(byStoreClass)
  - [ ] SubTask 28.3: 自动采集 tab - 新增日志列表:支持 sku/status/source/sellerSlug 筛选 + 分页(调 `getAutoCollectLogs`),表格列:SKU/来源/状态/耗时/各类目命中(8 列)/sellerSlug/采集时间
  - [ ] SubTask 28.4: 店铺分类 tab - 新增分类列表:支持 isMainlandChina 筛选 + keyword 搜索 + 分页(调 `getStoreClassificationList`),表格列:sellerSlug/sellerName/isMainlandChina/classifiedBy/companyInfo/lastSeenAt;支持手动改分类(调 `updateStoreClassification`)
  - [ ] SubTask 28.5: 复用现有 AppPager 组件分页,复用现有表格样式
  - [ ] SubTask 28.6: overview 矩阵显示 8 类缓存(含 marketStats/followSell stale 状态,stale 标橙色)

## P3 · 强制刷新当前页按钮接线

- [ ] Task 29: 强制刷新链路
  - [ ] SubTask 29.1: Task 22.5 已实现 SW `autoCollectForceRefreshPage` action;在 shared-utils.js 监听 `__jzAutoCollectResetSeen` 消息清空 `_autoCollectSeen`
  - [ ] SubTask 29.2: QX面板「强制刷新当前页」按钮 → 调 `autoCollectForceRefreshPage` action → SW 向当前 tab 发 `__jzAutoCollectResetSeen` + 重发 autoCollect forceRefresh
  - [ ] SubTask 29.3: 验证强制刷新后,该页所有已见 SKU 重新进 `autoCollect {forceRefresh:true}`,SW Task 6.4 跳过命中检查,重新真调写入 8 类

## 验证与收尾

- [ ] Task 30: 端到端验证
  - [ ] SubTask 30.1: 店铺页浏览中国大陆店铺 10 个 SKU → 查 MongoDB 八类缓存各有 10 条(detail 为空,因详情页未访问),auto_collect_log 有 10 条(storeClassified=mainland-china)
  - [ ] SubTask 30.2: 详情页浏览中国大陆店铺 10 个 SKU → 八类缓存各有 10 条(含 detail)
  - [ ] SubTask 30.3: 店铺页浏览非中国大陆店铺 → 不触发 autoCollect,log 记 `non-mainland-china-store`(storeClassified=non-mainland-china)
  - [ ] SubTask 30.4: 店铺页浏览未分类店铺 → QX面板显示「待确认」,不触发 autoCollect,log 记 `unclassified-store`(storeClassified=unclassified)
  - [ ] SubTask 30.5: 人工标记未分类店铺为中国大陆店铺 → 该页 SKU 开始采集
  - [ ] SubTask 30.6: 人工标记中国大陆店铺为非中国大陆店铺 → 该页后续 SKU 不采集
  - [ ] SubTask 30.7: 规则自动判定:CJK 店名(如「三发力耶」) → 自动标记为中国大陆店铺(classifiedBy=rule:cjk-name)
  - [ ] SubTask 30.8: 规则自动判定:knownNonMainlandChinaSlugs 列表中的 slug → 自动标记为非中国大陆店铺
  - [ ] SubTask 30.9: 三层查询缓存命中:同一店铺第二次访问 → L1 命中,不查 L2 不跑规则引擎
  - [ ] SubTask 30.10: 重复浏览同 SKU(24h 内) → auto_collect_log 记 `status:skipped, reason:all-cached`,零真调
  - [ ] SubTask 30.11: marketStats 缓存 24h stale 验证:手动改 fetchedAt 为 25h 前 → 重新浏览该 SKU → marketStats 重新真调,其他类目跳过
  - [ ] SubTask 30.12: followSell 缓存 4h stale 验证:手动改 fetchedAt 为 5h 前 → 重新浏览该 SKU → followSell 重新真调,其他类目跳过
  - [ ] SubTask 30.13: bundle 空属性 6h 重验验证:手动改 attrsEmptyVerifiedAt 为 7h 前 → 重新浏览 → bundle 重新真调
  - [ ] SubTask 30.14: QX面板主开关关闭 → 不触发 autoCollect
  - [ ] SubTask 30.15: QX面板「只采集中国大陆店铺」开关关闭 → 非中国大陆店铺也采集
  - [ ] SubTask 30.16: QX面板勾选「仅抓有销量」→ 无销量的 SKU 不触发 autoCollect(marketStats 缓存 soldCount=0)(仅店铺页)
  - [ ] SubTask 30.17: QX面板配置智能筛选(如月销量 ≥ 100)→ 不符合条件的 SKU 不触发 autoCollect(仅店铺页)
  - [ ] SubTask 30.18: QX面板勾选「自动翻页」→ AutoScroller 滚动加载更多 SKU(仅店铺页)
  - [ ] SubTask 30.19: 模拟反爬(手动改 pausedUntil 为未来时间) → QX面板 + popup 显示熔断倒计时,期间不采
  - [ ] SubTask 30.20: 手动改 todayCount >= perDayLimit → 返回 daily-limit
  - [ ] SubTask 30.21: ERP overview 页「自动采集」tab 可见统计 + 日志列表(含 sellerSlug 列),8 类缓存矩阵可见
  - [ ] SubTask 30.22: ERP overview 页「店铺分类」tab 可见分类列表(支持 isMainlandChina 筛选),可手动改分类
  - [ ] SubTask 30.23: popup「同步缓存(8 类)」按钮 → 8 类 L1 全部同步到 L2,统计正确
  - [ ] SubTask 30.24: 「强制刷新当前页」按钮 → 该页 SKU 重新真调写入 8 类
  - [ ] SubTask 30.25: marketStats 真调失败 → 不熔断,返回 partial,其他类目正常采集
  - [ ] SubTask 30.26: followSell 真调失败 → 不熔断,返回 partial,其他类目正常采集
  - [ ] SubTask 30.27: fetchVariantMediaViaBuyerTab 三合一验证:一次借 tab 写 entrypoint+composer+followSell 三类缓存
  - [ ] SubTask 30.28: getMarketStats action 改造验证:panel 重复打开时缓存命中优先,不重复真调
  - [ ] SubTask 30.29: jzFetchPublicFollowSell 改造验证:sessionStorage L0 命中优先,L0 未命中读 followSell 缓存,缓存未命中再真调
  - [ ] SubTask 30.30: 智能筛选 18 字段数据源验证:16 字段从 marketStats 缓存,2 字段从 followSell 缓存
  - [ ] SubTask 30.31: 搜索页浏览 SKU → 不触发 autoCollect(V3 已移除搜索页采集)
  - [ ] SubTask 30.32: 旧 collector 模块已移除,无残留引用

- [ ] Task 31: 代码质量
  - [ ] SubTask 31.1: 所有修改的 JS 文件 `node --check` 语法校验通过
  - [ ] SubTask 31.2: `npm run format:check` 通过(qx-ozon + erp-backend-lite/web)
  - [ ] SubTask 31.3: 现有 batch-upload 功能不受影响(本期不移除,留待后续独立 PR)
  - [ ] SubTask 31.4: 现有 panel 渲染功能不受影响(getMarketStats/jzFetchPublicFollowSell 改造后,缓存命中优先,真调降级)

# Task Dependencies

- Task 2(IndexedDB v6 + 8 类缓存函数)无依赖,可独立先做
- Task 3(fetchVariantMediaViaBuyerTab 三合一)依赖 Task 2(需要 _composerCacheSet/_followSellCacheSet)
- Task 4(_fetchMarketStatsDirect + getMarketStats 改造)依赖 Task 2(需要 _marketStatsCacheSet)
- Task 5(店铺分类查询 + 规则引擎)依赖 Task 9(ERP store_classification 端点)的 _erpStoreClassGet/Set 调用
- Task 6(autoCollect action)依赖 Task 1(闸门)、Task 2(8 类缓存函数)、Task 3(fetchVariantMediaViaBuyerTab 改造)、Task 4(_fetchMarketStatsDirect)、Task 5(checkStoreClassification)
- Task 10(SW 写日志)依赖 Task 7(ERP 日志接口)
- Task 6 的 Step 7 调用 Task 10 的 `_writeAutoCollectLog`
- Task 6 的 Gate 0.5 调用 Task 5 的 `checkStoreClassification`
- Task 11(syncL2Batch 扩展)依赖 Task 2(8 类缓存函数)
- Task 13(collectAutoIfMatched)依赖 Task 12(autoCollectOnSkuSeen)
- Task 14(jzFetchPublicFollowSell 改造)依赖 Task 2(需要 followSellCacheSet message 路由)
- Task 15(extractSellerInfoFromShopPage)无依赖,可独立先做
- Task 15.5 依赖 Task 15
- Task 16(店铺页接入)依赖 Task 13(collectAutoIfMatched)、Task 14(jzFetchPublicFollowSell 改造)、Task 15.5(seller-info-main.js 注入配置,ISOLATED world 需监听 MAIN world 的 CustomEvent)和 Task 5(checkStoreClassification)
- Task 16/17 依赖 Task 6(autoCollect action 存在)
- Task 17(详情页接入)依赖 Task 12(autoCollectOnSkuSeen)和 Task 5(checkStoreClassification)
- Task 18(smart-filter.js)无依赖,可独立先做
- Task 19(auto-scroller.js)无依赖,可独立先做
- Task 20(store-detector.js)依赖 Task 5(classifyStore action 存在)
- Task 21(panel.js)依赖 Task 18(smart-filter)、Task 19(auto-scroller)、Task 20(store-detector)、Task 22(SW action)
- Task 22(SW action)依赖 Task 5(checkStoreClassification/classifyStore)和 Task 6(autoCollect action,共享内存计数器)
- Task 23(店铺/详情页接入 QX面板)依赖 Task 21(panel.js)和 Task 13(collectAutoIfMatched)
- Task 24(移除旧 collector)依赖 Task 23(新旧切换完成后再删旧)
- Task 26(popup.js)依赖 Task 25(popup.html)
- Task 28(Cache.vue)依赖 Task 27(API 函数)、Task 7(后端接口)、Task 8(缓存端点)、Task 9(店铺分类端点)
- Task 29 依赖 Task 12 和 Task 22
- Task 30 端到端验证依赖 P0-P3 + P1.5 全部完成
