# Chrome 扩展 0.13.31.1 → 0.13.48.1 升级改动分析

> 分析对象：`c:\root\code\ozon-my\0.13.31.1` 目录（git 暂存区改动即本次升级的全部差异）
> 改动规模：95 个文件，+21683 / -17611 行
> 分析时间：2026-07-09

## 总览

本次升级有两条主线：

1. **功能演进**：下线 Browser Agent 远程派单 → 引入 fleet 服务端取数灰度 + 后台持久化任务队列 + POSTINGS 水位增量同步；快速采集 / 公开页跟卖挂靠 / 跟卖异步化（均灰度门控）；黑绿价 + 货币全链路采集；1688 AI 向导大幅增强；数据卡会员门控 + 采集器 session 化 + XLSX 导出；多处真实事故缺陷修复。
2. **全仓 Prettier 格式统一**：单引号 → 双引号、多行压缩、hex 大写等。这部分占据了 diff 行数的大头，但无任何运行时行为变化，下文不再赘述。

---

## 一、版本与清单 (manifest.json)

- 版本号 `0.13.31.1` → `0.13.48.1`
- 新增 host 权限 `https://*.ozonru.cn/*`
- 商品页 content script 注入列表新增 `lib/followsell-assembly.js`（跟卖组装逻辑下沉模块）
- 1688 以图搜图匹配从 `s.1688.com/www.1688.com` 放宽到 `*.1688.com`，并拆成两个脚本成对注入：
  - `content/1688-image-search-main.js`（`world: MAIN`，页面上下文桥接）
  - `content/1688-image-search.js`（隔离世界，原有文件）

---

## 二、background/ 后台

### 1. service-worker.js（最大改动，3244 行）

#### 下线 Browser Agent 远程派单子系统
- 移除 `importScripts` 中的 `agent/*.js` 四个模块
- 移除 `BROWSER_AGENT_ALARM` 常量、`setupBrowserAgentAlarm`/`handleBrowserAgentAlarm`/`initBrowserAgentContext`、alarm 分发分支、`onInstalled`/`onStartup` 中的 bootstrap 调用
- 移除消息处理 `browserAgentGetState`、`browserAgentCancelCurrent`
- 整套"扩展作为后端派单的远程浏览器执行器"模型废弃，能力被 fleet 服务端取数 + 直接路径取代

#### 新增：持久化后台任务队列
- 新增 `BG_TASK_PREFIX`、`BG_TASK_ALARM='jz-bgtask-drain'`、`drainBgTasks`/`runBgTask`
- 任务持久化到 `chrome.storage.local`，由 1 分钟 alarm 续跑，关页/重启浏览器后可恢复
- 带 attempts 落盘计数、反爬 10min 冷却、线性退避、24h/次数上限静默放弃
- SW 冷启动 5s 后主动 drain 一次积压

#### 新增消息处理（case）
- `enqueueBgTasks`：fast 采集的后台补全任务入队（`anchorSv` 锚 SKU 属性包 / `mediaEnrich` 视频转存+富内容回捞）
- `enqueueFollowSellImport`：跟卖上架异步化（灰度 `ozon_fast_import`），页面组装 jobSpec 交 SW `followSellSubmit` 持久任务按店铺扇出发起 import，per-store 结果落盘供 popup 回显进度
- `getWatermarkTemplates`：并行拉水印设置 + 可见店铺列表
- `openLoginPopup`：页面内"登录极掌"按钮调用 `chrome.action.openPopup()`（Chrome 127+），老版本降级回 badge 闪烁
- `reportSkuDims`：数据卡抓到的重量/尺寸即上报（fire-and-forget 攒批，后端灰度门控）
- `getMarketStatsBatch`：多变体面板销量列合批取数，仅走 fleet 途径，非灰度返 `supported:false` 让 content 走老路
- `importFromPublic`：maozi 公开商详上架（灰度 `ozon_public_import`），从买家商详 page-json 采集精简行，后端解析类目/属性走官方 import
- `followFromPublic`：maozi v2 公开挂靠，逐变体拉公开商详 page-json 补完整行
- `getFleetServersideFlag`：暴露 fleet 服务端取数灰度开关（5min 缓存 + single-flight）
- `getDataCardTuning`：数据卡取数调优参数（并发/间隔），30min 缓存，后台"上架调优"页热改

#### 新增基础设施：Fleet 服务端取数（灰度）
- `isFleetServerSide`、`callFleet`（6 并发闸 FIFO）、`_fleetCacheGet/Set`（本地 memo）、`_marketBatchProbe`、`_fleetMarketBatchDownUntil`（batch 熔断 10min）
- 接入既有 `getMarketStats`、`searchProductBySku`、`pushSourceCollect`（collect 路径）：灰度命中时走俄罗斯 VPS，失败/未命中回落 seller-tab 老路

#### 采集去重增强：fastCollect 模式
- `pushSourceCollect` 支持 `fastCollect:true`：跳过 dedupe 的读和写（永远重采），POST body 带 `mode:'fast'`（后端 PR#409 跳过锚 SKU 同步重活），属性包/视频由后台任务队列补全；普通采集仍写 24h dedupe

#### 同步相关增强
- `jzManualSync` 新增 `postingsSinceDays`/`postingsSince`/`postingsTo` 选项，支持手动指定 POSTINGS 同步时间窗
- 新增 `runManualSyncBounded`（≤3 并发限流，防止"全部同步"UI 连发撞 antibot/429）和 `runningTypes` 在飞守卫

#### 1688 以图搜图 tab 整合
- 新增 `collapse1688ImageSearchResultTab` + `chrome.tabs.onCreated`/`onUpdated` 监听，把以图搜图结果 tab 合并回过渡 tab

### 2. sync 模块

| 文件 | 改动 |
|------|------|
| sync-engine.js | POSTINGS 水位增量同步（`POSTINGS_MANUAL_SINCE_DAYS=30`，cron 仍 7 天）、`postingsOptions` 时间窗、`reachedEnd` 防静默部分同步 |
| sync-state.js | 新增 `getPostingsWatermark`/`setPostingsWatermark`，按 storeId 存 `{lastSuccessTo, updatedAt}` |
| backend-client.js | 删除 6 个 browser-agents 端点（与 Agent 下线一致），其余仅格式化 |
| dedupe.smoke.test.js | 新增 `fastCollect` 用例（fast 跳读/写 dedupe，后续普通采集可自愈） |
| diff-index.js / lease-client.js / opi-client.js | 纯格式化 |

### 3. 删除文件（Agent 子系统整体移除）

| 文件 | 原作用 |
|------|--------|
| `background/agent/actions.js` | action 注册表 + 动态能力位 |
| `background/agent/agent-runtime.js` | 设备注册/心跳/claim 任务/执行/上报 1 分钟 tick 循环 |
| `background/agent/collect-actions.js` | `collect.hot_products`、`ozon.collect_variant` 等 tab 内抓取动作 |
| `background/agent/listing-actions.js` | `listing.create_draft`、`listing.publish_draft` |
| `background/__tests__/agent-actions.smoke.test.js` | 注册表冒烟测试 |

**能力去向**：市场数据/变体查询 → 新增的 fleet 服务端取数灰度 + 既有 seller-tab 注入；采集 → `pushSourceCollect` 直接路径 + `fastCollect` + 后台任务队列补全；AI 草稿生成/发布 → 仍由 `backend-client.js` 的 `createAiListingDraft`/`publishAiListingDraft` 从 content/popup 直接调用。

---

## 三、content/ 核心

### 1. ozon-product.js（6294 行，改动最大）

#### 快速采集（灰度 `ozon_fast_collect`）
- 新增 `performFastCollect()`：只吃页面已加载的 state（零变体展开、零逐 SKU 抓 sv、零视频等待），单发 upsert（带 `fastCollect:true`/`mode:'fast'`，SW 跳过 24h 去重读、后端跳过锚 SKU 重活），<1s 给成功反馈
- 重活后移：锚 SKU 完整属性包（`anchorSv`）+ 视频转存/富内容回捞（`mediaEnrich`）通过 `enqueueBgTasks` 入 SW 持久化任务队列，页面关闭/重启也会跑完并 PATCH 回采集记录
- 新增 `jzResolveValidatedPdpProduct()`（同步提取+必填校验，单采与快采共用）、`jzFastCollectSuccessLabel()`（"已采集·详情补全中"/"已采集 N 变体·补全中"）、`jzExtractPageVideoSourceSync()`（纯同步零请求抓视频直链+封面给 mediaEnrich）
- 三个采集入口（action bar 一键采集 / 侧栏数据卡采集 / 编辑采集）统一：flag 开走快路径，关走原 `collectAllVariants` 多阶段路径，行为不变

#### 公开页跟卖 / 公开页挂靠（灰度 `ozon_public_import` / `ozon_public_follow`）
- action bar 新增两个紫色按钮（默认隐藏，flag 开才显示）：
  - 「公开页跟卖」`publicFollowSellBtn`：从公开商详页采精简行 → 后端服务端解析类目/属性 → 官方 import，调 `importFromPublic`
  - 「公开页挂靠」`publicFollowBtn`：枚举整款所有变体 → 官方 import-by-sku 挂靠到已有商品卡（非克隆），调 `followFromPublic`
- 新增 4 个 feature flag 读取函数（5min 缓存，失败默认 false 零风险回退）

#### 跟卖上架异步化（灰度 `ozon_fast_import`）
- 新增评审期预取 `runFollowSellPrefetch`/`maybeStartFollowSellPrefetch`：面板打开后台把匹配（sourceMap）+ 图册（galleryMap）+ 富内容（richContentMap）逐 SKU 拉好缓存到 `panel._fsPrefetch`，提交时直接复用 → 秒回
- 新增 `jzMatchFollowSellSku`、`buildFollowSellJobSpec`（把 items+店铺/flags/仓库偏好/店名快照打包成 job 交 SW `followSellSubmit` 持久任务）

#### 黑绿价（marketing price）采集
- 新增 `buildMarketingPricePayload`（提取 marketingPrice/blackPrice + greenPrice/walletPrice + 币种）、`mergeMarketingPriceIntoVariantData`、`buildPdpBucketRecord`，各采集路径统一带上黑绿价

#### 富内容（图文描述）采集
> 见下文「富内容采集详细分析」专章

#### 数据卡会员门控 + 侧栏卡重构
- `createSidebarDataCard` 新增会员门控：`jzDataCardAllowed`（getMembershipSummary，fail-open）查到 `allowed===false` 时渲染锁定卡，不抽页面数据不发请求
- 移除 `showSellerLoginHint`（下沉到 shared-utils 的 `jzPopulatePanelV2`）；移除 `fetchBackendProductData`/`createPipelineLoadingDialog`/`formatListingDate`

#### 变体表格自适应密度
- 新增 `jzUpdateMultiVariantDensity`（≥6 行设 `data-variant-density="expanded"`）、`jzFitMultiVariantTableViewport`（按 body/footer/表格实际可视区动态算 `--oh-mv-table-max-height`）、`jzScheduleMultiVariantTableFit`（rAF 节流）
- 多变体表格新增「复制SKU」「复制货号」按钮

### 2. shared-utils.js（2836 行）
- `jzMakeStaggeredQueue` 下沉（唯一实现，带 `setParams` 运行时调参）
- 黑绿价/货币解析套件（`jzParseOzonPriceNumber`/`jzDetectOzonMoneyCurrency`/`jzExtractOzonPriceTags` 等），移除 `×0.084` 兜底汇率
- 标题清洗增强（`jzCleanOzonCardTitle`/`jzIsPromoResidualTitle`/`jzPreferSourceName` 防促销角标污染）
- 数据卡渲染集中化 + 会员门控
- `jzSvWeightG` 重量属性优先 4497 回退 4383，防"0.35g"bug

### 3. ozon-search.js + ozon-data-panel.js（对称改动）
- 采集器 session 化（`collectorRunning` 不再跨页持久化，`collectorEnabled` 默认开）
- 队列提速：followSellQueue 1/500ms → 4/100ms，反攀退避降回；variantsQueue fleet 灰度放宽到 6/0
- 黑绿价/hashtag/priceCurrency 全链路采集 + PDP 兜底
- 推送批量化：`pushSourceCollectBatch`（100 条/批）
- 关键词采集启停完善（`clearKeywordPilotSession`/pilot mode 区分）

### 4. 其它 content 文件
- **jzc-calc.js**：利润率口径从「成本利润率」改为「销售利润率」；未填采购价不展示；重量属性 4497 优先
- **jizhangerp-bridge.js**：`handleSync` 新增 `postingsOptions` 透传
- **ozon-product.css**：变体表格自适应 + 「暂无数据」样式
- ozon-bff-interceptor.js / ozon-seller-bridge.js / ozon-premium-hook.js / sync-auth.js / cn-source-product.js / ozon-bestsellers-hook.js / ozon-search.css：纯格式化

---

## 四、content/1688 与 cn-source

### 1. 1688-ai-wizard.js（1744 行，AI 向导大改）
- **草稿缓存**（断点续传）：`wizardDraftCache` + sessionStorage
- **调试模式**：`debugEnabled()` 读取 `jzc_aiw_debug`
- **包装信息独立管理**：`packageInfoFromRaw()`（cm→mm/kg→g 自动换算）
- **批量改价弹窗**取代 `prompt()`（set/add/multiply 三模式）
- **AI 文案与上架解耦**：`W.generatedContent` + 重写-only / 发布-only 独立按钮
- **类目树按店铺拉取** + 加载/错误态 + 请求序列号防竞态
- **AI 自动匹配 v2**（leaf-topk，取消本地兜底，置信度 0.45–0.75 触发复核）
- **店铺自动选中** + 仓库加载健壮化
- **属性填充分范围**（required/rating/required-and-rating）+ 手动确认徽标 + 无品牌处理
- **定价快照** + 汇率缺失保护（≤0 中止提交）
- **多变体一次性提交** + 直上前置校验

### 2. 1688-image-search.js + 新增 1688-image-search-main.js
- 以图搜图改为 MAIN-world 桥接拿 imageId 直跳结果页，绕过旧"上传→点搜索"流程
- `waitAndClickSearchButton` 大幅加固（精确选择器、可见性判断、800ms 节流重试、20s 超时）

### 3. alibaba-1688.js
- 新增「行业专供」SKU 表解析 `extractIndustryTableVariants`
- 包装信息文本兜底解析 + 单位换算
- SKU 选项选择器扩充（`.sku-filter-button` 等）
- 本地前端地址 `localhost:3000` → `store.localhost:3000`

### 4. 纯格式化
cn-source-scraper.js / cn-source-panel.js（仅本地前端地址同步）/ cn-source-debug-page.js / 1688-page-data-hook.js

---

## 五、content/collector/ 采集器

### 1. db.js（1051 行，重点）
- **记录合并防覆盖**：`putSale`/`putSaleBatch` 先读旧再 `_mergeSaleRecord`，按来源等级保留更优价格
- **动态汇率换算**：`_fxRubPerCny` + `getFxRate` 消息拉实时汇率，取代硬编码 `*0.084`
- **新增黑标价字段** + CSV 新增 `marketingPrice` 列
- **CSV 字段调整**：image 移首列、₽→¥、collectedAt 改本地时间
- **全新 XLSX 导出**（无第三方库，含图片嵌入、PNG 转换、ZIP store + CRC32）
- **IndexedDB schema 未变**
- markPushed SKU 数字/字符串兼容

### 2. panel.js + panel.css
- 导出按钮「CSV」→「Excel」，优先 `exportXlsx`
- 智能筛选新增 `marketingPrice`，动态汇率同步
- 本地收藏 Toast（`showLocalCollectToast`）
- `setRunning` 停止时重置状态修正
- panel.css 新增 Toast 样式

### 3. task-queue.js（关键修复）
- **修复失败任务无法重试 bug**：ERROR/TIMEOUT 旧任务先 delete 再重建 promise
- 新增 `evict(taskId)` 主动淘汰已终结任务
- `resume()` 补发状态通知

### 4. 其它
- keyword-pilot.js：新增 `collectorStartedByKeywordPilot` 标志
- auto-scroller.js / anti-ban.js / l1-bridge.js / l1-diff.js / l1-shadow-db.js：纯格式化（schema 未变）

---

## 六、lib/

### 1. follow-sell-content-copy.js（缺陷修复）
- 新增 `stripDescriptionUiChrome`/`isPlaceholderDescriptionText`：防止 Ozon「加载失败」占位文案和「展开按钮」文案被当真描述写进 4191 上架

### 2. followsell-assembly.js（新增 277 行）
- 把跟卖上架 item 组装从 ozon-product.js 抽成纯逻辑模块，为 SW 复用铺路
- 承载类目对齐、视频/PDF 兜底、品牌共享、物理参数优先级链、图片来源链、名称取值链等

### 3. watermark-templates.js
- 新增「边框」模板类型 + 可插拔 `loadData` 加载器（适配 SW 无 fetch 环境）

### 4. 纯格式化（无功能变化）
v3-payload.js、quick-list-parser.js、sku-collect.js、store-picker.js/.css、title-quality.js、sidebar-section-toggle.js、ozon-video-extract.js、cdn-buster.js

---

## 七、popup/ 与 batch-upload/

### 1. popup（下线 AI Agent 面板）
- popup.js/html/css 联动移除 Local Browser Agent 任务监控面板（DOM/状态/函数/样式全清）
- `toggleCollector`/`syncCollectorBadge` 从默认关改为默认开
- 本地开发地址 `localhost:3000` → `store.localhost:3000`
- 删除 `browser-agent-popup.smoke.test.js`

### 2. batch-upload
- **AI 重写计费模式改为「按次扣极点」**（原会员权益制）：余额充足显示单价并默认勾选，不足禁用并提示
- 水印模板加载改用 `getWatermarkTemplates` 消息
- 文案「水印」→「水印/边框」统一更名
- index.html/css 主体为格式化

---

## 八、tests/（新增 16 个，修改 8 个）

### 新增测试覆盖方向
- **1688 图搜**：flow（端到端）+ routing（manifest/MAIN world 断言）
- **AI 向导**（最大增量，~1347 行）：agent1-actions、attr-context、store-category-warehouse —— 覆盖店铺/类目/仓库/属性/评级/重写/发布/批量价/包装/草稿/debug 脱敏
- **采集器**：collector-manual-start（状态机+货币+黑标价+导出）、fleet-collect-attrs-merge、bundle-attrs-cache-guard、keyword-pilot-ownership
- **跟卖组装**：followsell-assembly（15 风险点）、multivariant-table-scroll、mv-title-promo-guard
- **同步**：postings-manual-sync-window、sync-state-watermark
- **其它**：ozon-rich-content-page-json、batch-upload-preview-price-align

### 修改测试
- alibaba-1688-scraper.test.js：新增行业 SKU 表 / filter-button 采集 + packaging 断言
- cn-source-panel.test.js：新增 `priceCurrency` 断言
- follow-sell-content-copy.test.js：新增加载失败占位描述识别回归
- 其余 5 个为纯格式化

### 关键回归点
测试明显围绕真实事故：bundle 空属性缓存（sku 3270906481）、fleet 属性合并丢失、角标标题污染（BR_attribute_advertising/attr 22508）、加载失败占位上架成简介（cfe3a0d0）

---

## 九、删除的文档
`docs/OZON_FOLLOW_SELL_ANALYSIS.md`、`docs/OZON_HTTP_REQUESTS_ANALYSIS.md`、`docs/OZON_MY_0.13.31.1_ANALYSIS.md`（分析文档清理）

---

## 总体主线总结

1. **下线 Browser Agent 远程派单** → 引入 **fleet 服务端取数灰度 + 后台持久化任务队列 + POSTINGS 水位增量同步**
2. **快速采集 / 公开页跟卖挂靠 / 跟卖异步化**（均灰度门控，零风险回退）
3. **黑绿价 + 货币全链路采集** + **富内容采集** + **动态汇率**（取代硬编码 0.084）
4. **1688 AI 向导大幅增强**（草稿续传/类目 v2/属性分范围/多变体提交/批量改价）
5. **数据卡会员门控** + **采集器 session 化** + **XLSX 导出**
6. **缺陷修复**：失败任务无法重试、加载失败占位上架、角标标题污染、重量 0.35g
7. 全仓 Prettier 格式统一（占 diff 行数大头但无功能影响）

---

# 附：富内容采集详细分析

> 富内容（Ozon Rich Content，attribute 11254）是 Ozon 商详页的图文描述模块，由卖家在 seller 后台用棋盘格布局编辑器发布，渲染到买家商详页时以 widget 树形式存在。它是上架跟卖时最值得复制的内容资产之一，但因其结构复杂、分页加载、与普通 widget 混居，采集难度较高。本次升级对富内容采集做了系统化重构。

## 1. 业务背景

### 什么是 Ozon Rich Content
- Ozon 商品详情页的「富内容」是 attribute id `11254`，值是一份 JSON 字符串，结构为 `{content: [{widgetName, ...}, ...], version}`
- `content` 数组里的每个元素是一个 widget 块（文本、图片、棋盘格 chess、showcase、billboard 等），通过 `widgetName` 字段标识类型
- 卖家在 seller 后台用可视化编辑器排版，Ozon 把成品存为 `richAnnotationJson` 字段

### 为什么需要采集
- 跟卖上架时，源商品的富内容是高质量的描述素材：可直接作为 11254 属性注入目标商品（让目标商品也拥有同款图文描述），也可抽成纯文本写进 4191（普通描述属性）
- 采集箱编辑页会预填 11254 到 textarea，批量导入后端经 `_sourceVariant` 统一下发
- 旧实现的问题：依赖渲染后的 DOM 兜底，反爬/慢渲染场景下经常抽空；分页富内容只采到第一页

## 2. 数据来源

富内容住在 Ozon page-json 接口返回的 `widgetStates` 里，有两种常见形状：

| 形状 | 结构 | 说明 |
|------|------|------|
| ① | 某 widget state 的 `richAnnotationJson` 字段是整份 `{content,version}` JSON 字符串 | 最常见 |
| ② | state 顶层直接就是 `{content:[...widget...],version}` | 少数情况 |

判别依据：`content[].widgetName` 是字符串且非空 —— 避免误命中普通 list/gallery widget。

数据获取端点（同源，相对路径，ozon.ru / ozon.kz 都命中）：
- `/api/entrypoint-api.bx/page/json/v2?url={path}`
- `/api/composer-api.bx/page/json/v2?url={path}`

## 3. 核心函数（content/ozon-product.js）

### 3.1 `jzIsRichContentDoc(doc)` — 富内容文档判别
```js
function jzIsRichContentDoc(doc) {
  return Boolean(
    doc && typeof doc === 'object' && !Array.isArray(doc) &&
    Array.isArray(doc.content) && doc.content.length > 0 &&
    doc.content.some((block) => block && typeof block === 'object' &&
      typeof block.widgetName === 'string' && block.widgetName.trim()),
  );
}
```
作用：判定一个对象是否是富内容文档。要求 `content` 是非空数组，且至少一个块有非空 `widgetName` 字符串。

### 3.2 `jzCollectRichContentStats(doc)` — 富内容质量统计
对富内容文档做结构化统计，输出：
- `widgetCount` / `textWidgetCount` / `layoutWidgetCount` / `chessWidgetCount`
- `imageCount` / `textNodeCount` / `textChars`
- `hasRealText`：`textChars >= 12 || textNodeCount >= 2 || textWidgetCount > 0`

实现要点：
- 跳过 `widgetName`/`src`/`url`/`trackingInfo` 等元数据键，只统计真正的可见文本
- `looksLikeImageUrl` 过滤图片 URL，`/[A-Za-zА-Яа-яЁё]/` 过滤纯数字/符号
- `hasRealText` 是后续「优先选有文字的富内容」的关键判据

### 3.3 `jzExtractRichContentFromStates(states)` — 从 widgetStates 抽取最佳富内容
- 递归遍历 `states`（深度上限 24，WeakSet 防循环引用）
- 对每个节点先 `jzParseMaybeJson`（字符串 try JSON.parse），识别两种形状
- 每个候选富内容文档打分（`jzCollectRichContentStats`），分数公式：
  ```
  score = (hasRealText ? 100000 : 0)
        + chessWidgetCount * 20000
        + textWidgetCount * 12000
        + layoutWidgetCount * 600
        + textChars * 40
        + textNodeCount * 500
        + widgetCount * 80
        + imageCount * 20
        + min(json.length, 20000) / 20000
        - candidates.length / 1000   // 同分时偏好先发现的
  ```
- 按分数降序取第一个，返回 JSON 字符串或 `''`

**设计意图**：一个页面可能有多个富内容片段（如多张 tab），优先选「有真实文字 + 棋盘格多 + 文本 widget 多」的那一份，避免选到纯图片占位富内容。

### 3.4 `jzRichContentHasText(raw)` — 富内容是否有真实文字
```js
function jzRichContentHasText(raw) {
  const doc = jzParseMaybeJson(raw);
  return jzIsRichContentDoc(doc) && jzCollectRichContentStats(doc).hasRealText;
}
```
作用：决定是否继续翻页。若当前富内容只有图片没有文字，应继续 fetch nextPage 找有文字的版本。

### 3.5 分页路径提取 `jzCollectOzonRichContentPagePaths`
富内容可能分页：Ozon 用 `paginator.nextPage` 字段指向下一页的 page-json 路径。本函数从 `states` 里递归收集所有 nextPage 路径，并做严格过滤：

```js
const push = (candidate) => {
  const pagePath = jzNormalizeOzonProductInnerPath(candidate);
  // 必须是 pdpPage2column 布局（商品详情页两栏布局）
  if (!pagePath || !/[?&]layout_container=pdpPage2column(?:&|$)/.test(pagePath)) return;
  const productKey = jzOzonProductPathKey(pagePath);
  const productId = jzOzonProductId(pagePath);
  // 必须是同一个商品（按数字 id 比对，兼容 slugged PDP 与 /product/{sku} 两种路径）
  if (currentProductId && productId && currentProductId !== productId) return;
  if ((!currentProductId || !productId) && currentProductKey && productKey && productKey !== currentProductKey) return;
  if (seenPaths.has(pagePath)) return;
  seenPaths.add(pagePath); out.push(pagePath);
};
```

辅助函数：
- `jzNormalizeOzonProductInnerPath(value)`：URL → `pathname + search`
- `jzOzonProductPathKey(value)`：`pathname`（去掉 query，去尾斜杠）
- `jzOzonProductId(value)`：从路径抽数字商品 id，正则 `/product/(?:[^/?#]*-)?(\d+)$/i`

**关键约束**（由测试 `ozon-rich-content-page-json.test.js` 守护）：
- 必须跟随 `paginator.nextPage`，不能只采第一页
- 必须针对 `pdpPage2column` 布局
- 必须按 Ozon 数字 id 过滤，让批量 `/product/{sku}` 路径与 slugged PDP 路径对齐
- 第一个 `richAnnotationJson` 是纯图片时必须继续搜索
- 缓存的富内容无文字时仍要 fetch page-json

### 3.6 `jzCollectPageRichContent()` — 当前页富内容采集主入口
```js
async function jzCollectPageRichContent() {
  try {
    let rc = '';
    // 1. 优先 composer 缓存（ensurePdpState，页面加载即预热，通常零额外请求）
    if (window.ensurePdpState) {
      const states = await window.ensurePdpState().catch(() => null);
      if (states) rc = jzExtractRichContentFromStates(states);
    }
    // 2. 缓存 miss / 不含文字 → 同源再拉一次完整 widgetStates 兜底
    if (!rc || !jzRichContentHasText(rc)) {
      const r = await fetchVariantGallery(window.location.pathname + window.location.search);
      const fetched = r?.richContent || '';
      if (fetched && (!rc || !jzRichContentHasText(rc) || jzRichContentHasText(fetched))) rc = fetched;
    }
    return rc;
  } catch { return ''; }
}
```

**两层策略**：
1. **零请求快路**：`ensurePdpState` 是页面加载时预热的 composer 缓存（SW 白名单含 `webDescription`，富内容 `richAnnotationJson` 就住在这个 state 里），采集时通常零额外请求
2. **fetch 兜底**：缓存 miss 或不含文字时，`fetchVariantGallery` 走 entrypoint-api/composer-api 拉完整 widgetStates

**失败语义**：富内容是增强项，绝不阻塞采集主流程，异常一律返回 `''`。

### 3.7 `fetchVariantGallery(variantLink)` — 变体图册 + 富内容联合抓取
这是逐变体抓取的核心函数，同时返回 images 和 richContent。关键流程：

```
endpointQueue = [entrypoint, composer]  // 初始两个端点
for (url in endpointQueue):
  fetch widgetStates
  // 从 states 抽 nextPage 路径，enqueue 进队列（分页回捞）
  for (nextPage of jzCollectOzonRichContentPagePaths(states, path)):
    enqueuePath(nextPage)  // 每个 nextPage 又产生 entrypoint+composer 两个 url
  // 抽富内容候选，优先选有文字的
  candidateRichContent = jzExtractRichContentFromStates(states)
  if (candidateRichContent && (!richContent || (!richContentHasText && candidateHasText))):
    richContent = candidateRichContent
  // 抽图册（images 数组最长的一个 widget）
  ...
  // 视频 + 富内容都到手且富内容有文字 → 提前结束
  if (bestImages && richContent && (richContentHasText || endpointQueue 末尾)) return
```

**分页回捞机制**：每 fetch 一页 page-json，就从返回的 `widgetStates` 里找 `nextPage`，把新路径 enqueue 进队列，继续 fetch。这样富内容即使跨多页也能完整采到。

### 3.8 `jzInjectRichContentAttr(sv, richContent)` — 幂等注入 11254
```js
function jzInjectRichContentAttr(sv, richContent) {
  if (!richContent) return sv || undefined;
  const base = sv && typeof sv === 'object' ? sv : {};
  const attrs = Array.isArray(base.attributes) ? base.attributes : [];
  if (attrs.some((a) => String(a?.key) === '11254')) return base;  // 幂等
  base.attributes = [...attrs, { key: '11254', value: richContent }];  // 展开新数组，不污染源引用
  return base;
}
```

**设计要点**：
- **幂等**：已有 11254 不重复注入
- **不原地 push**：展开新数组，避免污染共享的源 `attributes` 引用（母体 variantData 是 anchorSv 的浅拷贝）
- **sv 为空兜底**：`sv=null` 且 `richContent` 非空时新建 `{attributes:[…]}`，让 `searchVariants` 失败的单采也能带富内容

下游消费链：
- 采集箱编辑页 collect-adapter 读 `attributes` 的 11254 预填 richContent textarea
- 批量导入后端 collect-box.service 把 variantData 当 `_sourceVariant` 传，`importProducts` 的 `pickSourceRichContent` 统一下发

## 4. 三条采集路径的接入

### 4.1 单采（performProductCollect，[ozon-product.js#L2133](file:///c:/root/code/ozon-my/0.13.31.1/content/ozon-product.js#L2133)）
```js
const collectRichContent = await jzCollectPageRichContent();
let collectVariantData = jzInjectRichContentAttr(variantMatch, collectRichContent);
// 富内容还参与描述选词（pickFollowSellDescription 优先用 richContent 抽纯文本写 4191）
const collectDescription = contentCopy?.pickFollowSellDescription
  ? contentCopy.pickFollowSellDescription({
      customDescription: '', sourceVariant: collectVariantData || variantMatch,
      richContent: collectRichContent, fallbackName: '', max: 4096,
    })
  : '';
```

### 4.2 多变体采集（collectAllVariants，[ozon-product.js#L1675](file:///c:/root/code/ozon-my/0.13.31.1/content/ozon-product.js#L1675)）
```js
// 源富内容(11254)listing 级:同视频语义,整组变体共用当前页(母体)的富内容
const collectAllRichContent = await jzCollectPageRichContent();
jzInjectRichContentAttr(variantData, collectAllRichContent);
```
**语义**：多变体是同一商品的不同规格，富内容是商品级的，整组共用母体富内容，不必逐变体走买家 tab 重复拉。

### 4.3 快速采集（performFastCollect，[ozon-product.js#L1799](file:///c:/root/code/ozon-my/0.13.31.1/content/ozon-product.js#L1799)）
```js
// 富内容快路:composer 缓存页面加载即预热,300ms 内命中就同步带上(11254);
// miss 则 needRich=true 交给 mediaEnrich 后台任务回捞
let fastRichContent = '';
try {
  fastRichContent = (await Promise.race([
    jzCollectPageRichContent(),
    new Promise((r) => setTimeout(() => r(''), 300)),
  ])) || '';
} catch { fastRichContent = ''; }
const needRich = !fastRichContent;
// ... 单发 POST 后 ...
// 慢活入队:mediaEnrich 任务带 needRich 标志
const bgTasks = [
  { type: 'anchorSv', itemId, sku: String(payload.sku) },
  { type: 'mediaEnrich', itemId, sku: String(payload.sku),
    productUrl: window.location.href,
    ...(videoClue?.srcMp4 ? { srcUrl: videoClue.srcMp4 } : {}),
    needRich,
  },
];
window.sendMessage('enqueueBgTasks', { tasks: bgTasks }).catch(...);
```

**300ms 竞速**：快采追求 <1s 反馈，富内容若 300ms 内未命中（composer 缓存 miss），不等了，标记 `needRich=true` 交 SW 后台任务回捞，PATCH 回采集记录。

## 5. SW 侧 mediaEnrich 任务回捞（service-worker.js#L2989）

```js
if (task.type === 'mediaEnrich') {
  // 视频转存 + 富内容回捞,全程 best-effort:只在真拿到东西时才 PATCH,
  // 失败一律不回写 null(PR#332 负缓存红线 —— 写了就把空结果钉死)
  let mp4 = task.srcUrl || null;
  let media = null;
  if (!mp4 || task.needRich) media = await fetchVariantMediaViaBuyerTab(task.productUrl);
  if (!mp4) mp4 = media?.mp4 || null;
  // ... 视频转存 ...
  const attrs = [];
  if (task.needRich && media?.richContent) attrs.push({ key: '11254', value: media.richContent });
  if (task.needRich && media?.description) attrs.push({ key: '4191', value: media.description });
  if (task.needRich && Array.isArray(media?.hashtags) && media.hashtags.length > 0) {
    attrs.push({ key: '23171', value: media.hashtags.join(' ') });
  }
  if (attrs.length) vd.attributes = attrs;
  if (Object.keys(vd).length) body.variantData = vd;
  if (Object.keys(body).length) {
    await apiRequest('PATCH', `${backendUrl}/ozon/collect-box/${task.itemId}`, body, ...);
  }
  return;  // 全空 = 正常结束,不重试
}
```

**负缓存红线**：失败绝不回写 null。PR#332 的教训是写了空结果会被缓存/钉死，导致后续永远采不到。只有真拿到东西才 PATCH。

## 6. SW 侧 buyer-tab 批量采集（fetchVariantMediaViaBuyerTab）

content script 侧的 `jzCollectPageRichContent`/`jzExtractRichContentFromStates` 逻辑在 SW 侧 **完整内联复制了一份**（[service-worker.js#L937-L1125](file:///c:/root/code/ozon-my/0.13.31.1/background/service-worker.js#L937)），原因是 `chrome.scripting.executeScript` 序列化注入，不能引用 SW 闭包变量。

两侧实现完全同规则：
- `isRichDoc` ↔ `jzIsRichContentDoc`
- `collectRichStats` ↔ `jzCollectRichContentStats`
- `extractRich` ↔ `jzExtractRichContentFromStates`
- `hasRichContentText` ↔ `jzRichContentHasText`
- `collectOzonRichContentPagePaths` ↔ `jzCollectOzonRichContentPagePaths`
- `normalizeOzonProductInnerPath` / `ozonProductPathKey` / `ozonProductId` 同名同实现

SW 侧额外做了：
- 注入 `lib/ozon-video-extract.js`（视频抽取 helper）到 buyer tab 的 MAIN world
- 注入 `lib/follow-sell-content-copy.js`（描述抽取 helper）到 buyer tab 的 MAIN world
- `extractDescription` 复用 `JZFollowSellContentCopy.extractDescriptionText`，绝不把原始 JSON 串当描述
- `extractHashtags` 从 `webHashtags/tagList` state 递归捞 `#` 前缀串，去重 + 上限 30

返回结构：`{ ok, mp4, richContent, description, hashtags }`，视频 + 富内容都到手且富内容有文字即可提前结束，否则继续试下一个 endpoint（视频/富内容偶尔只在 composer 而不在 entrypoint）。

## 7. 测试守护（tests/ozon-rich-content-page-json.test.js）

源码断言测试，守护以下不变量：
1. 当前页采集必须跟随 `paginator.nextPage`
2. buyer-tab 批量采集必须跟随 `paginator.nextPage`
3. 两侧都必须针对 `pdpPage2column` page-json
4. nextPage 过滤必须按 Ozon 数字 id 比对，让批量 `/product/{sku}` 与 slugged PDP 对齐
5. 当前页图册采集不能在拿到 images 后提前 return（必须继续检查完整富内容）
6. 不能依赖渲染 DOM 兜底（`jzWaitForDomRichContent`/`extractOzonRichContentFromDocument` 已删除）
7. 不能从 `copyableDescription` 重建 11254
8. 第一个 `richAnnotationJson` 是纯图片时必须继续搜索（`richContentHasText`）
9. 当前页缓存富内容无文字时仍要 fetch page-json

## 8. 关键设计决策

| 决策 | 原因 |
|------|------|
| 优先 composer 缓存（ensurePdpState） | 页面加载即预热，采集时通常零额外请求，反爬风险最低 |
| 300ms 竞速（快采路径） | 快采追求 <1s 反馈，富内容不是阻塞性字段，miss 交后台任务 |
| 分页回捞（nextPage 队列） | 富内容跨多页，只采第一页会丢内容 |
| 按数字 id 过滤 nextPage | 兼容 slugged PDP 与 `/product/{sku}` 两种路径，避免跨商品串采 |
| 优先选有文字的富内容（hasRealText） | 纯图片富内容价值低，有文字的才是完整描述 |
| 幂等注入 11254 | 避免重复采集时属性数组膨胀 |
| 不污染源 attributes 引用 | 母体 variantData 是 anchorSv 浅拷贝，原地 push 会污染源 |
| 失败返回 ''，绝不回写 null | PR#332 负缓存红线，写空会把结果钉死 |
| SW 侧逻辑内联复制 | executeScript 序列化注入不能引用 SW 闭包 |
| 不依赖渲染 DOM | 反爬/慢渲染场景 DOM 兜底不可靠，page-json 是结构化数据更稳 |
| 不从 copyableDescription 重建 | 那是渲染产物，结构不完整，会有 HTML 残留 |

## 9. 与描述（4191）的协同

富内容（11254）和描述（4191）是两个不同的 Ozon 属性，但在采集时协同处理：

- `pickFollowSellDescription({ sourceVariant, richContent, ... })`：优先从 richContent 抽纯文本作为描述候选
- 若 richContent 无文字，退到 sourceVariant 的 4191 属性
- 再退到标题
- **绝不走页面描述兜底**（避免抓回富内容当成普通描述）

在 mediaEnrich 任务里，11254/4191/23171（主题标签）一起 PATCH 回采集记录，三者来源同一份 page-json，保证一致性。

## 10. 数据流总览

```
┌─ content/ozon-product.js (采集触发) ─────────────────────────────┐
│                                                                   │
│  单采/多变体: jzCollectPageRichContent()                         │
│    ├─ ensurePdpState() → composer 缓存 → jzExtractRichContent    │
│    └─ fetchVariantGallery() → page-json → 分页回捞 → 抽富内容     │
│                                                                   │
│  快采: 300ms 竞速 jzCollectPageRichContent()                     │
│    ├─ 命中 → jzInjectRichContentAttr → 单发 POST                  │
│    └─ miss → needRich=true → enqueueBgTasks(mediaEnrich)         │
│                                                                   │
│  jzInjectRichContentAttr → variantData.attributes[11254]          │
│  → pushSourceCollect → 后端 collect-box                           │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                              │
                              │ (快采 miss 时)
                              ▼
┌─ background/service-worker.js (后台任务) ─────────────────────────┐
│                                                                   │
│  mediaEnrich 任务(持久化,关页/重启可恢复):                         │
│    fetchVariantMediaViaBuyerTab(productUrl)                       │
│      ├─ ensureBuyerTab()                                          │
│      ├─ 注入 ozon-video-extract.js + follow-sell-content-copy.js │
│      ├─ executeScript(doFetch) → MAIN world                       │
│      │   ├─ endpointQueue: entrypoint → composer → nextPage...    │
│      │   ├─ collectOzonRichContentPagePaths → enqueue 分页        │
│      │   ├─ extractRich → 打分选最佳                              │
│      │   ├─ extractMp4 / extractDescription / extractHashtags    │
│      │   └─ return { ok, mp4, richContent, description, hashtags}│
│      └─ PATCH /ozon/collect-box/{itemId} { variantData.attributes }│
│                                                                   │
│  负缓存红线:失败不回写 null,只 PATCH 真拿到的字段                  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## 11. 旧实现的问题与本次修复对照

| 旧实现问题 | 本次修复 |
|------------|----------|
| 依赖渲染 DOM 兜底（`jzWaitForDomRichContent`/`extractOzonRichContentFromDocument`） | 删除 DOM 兜底，只走 page-json 结构化数据 |
| 只采第一页，跨页富内容丢失 | `jzCollectOzonRichContentPagePaths` 跟随 `paginator.nextPage` 分页回捞 |
| 第一个 `richAnnotationJson` 是纯图片就停 | `jzRichContentHasText` 判定，无文字继续搜索 |
| 从 `copyableDescription` 重建 11254（HTML 残留） | 禁止，只用原始 `richAnnotationJson` JSON |
| 快采路径无富内容（怕慢） | 300ms 竞速 + mediaEnrich 后台回捞，兼顾速度与完整 |
| 缓存富内容无文字时不刷新 | 无文字时仍 fetch page-json 兜底 |
| nextPage 跨商品串采 | 按 Ozon 数字 id 严格过滤 |
| 多变体逐个拉富内容（重复请求） | listing 级共用，母体采一次注入整组 |
