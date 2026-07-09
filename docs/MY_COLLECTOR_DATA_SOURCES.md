# MY 采集器功能框架与数据来源分析

> 落地路径：`c:\root\code\ozon-my\docs\MY_COLLECTOR_DATA_SOURCES.md`
> 子系统路径：`c:\root\code\ozon-my\qx-ozon\content\collector\`
> 集成入口：`c:\root\code\ozon-my\qx-ozon\content\ozon-search.js`
> 后端对接：`c:\root\code\ozon-my\qx-ozon\background\service-worker.js`
> 数据映射：`c:\root\code\ozon-my\qx-ozon\content\shared-utils.js`

---

## 一、功能框架

MY 采集器（极掌采集器）是 Ozon 搜索/类目页上的浮动采集子系统，由 **10 个文件 + 1 个集成入口 + SW 侧 4 个 handler** 组成，实现"自动翻页 → 卡片抓取 → 本地桶 + 后端推送"全链路。

### 1.1 文件职责矩阵

| 文件 | 注入页面 | run_at | 核心职责 |
|------|---------|--------|---------|
| [task-queue.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/task-queue.js) | 搜索页 + 详情页 | document_idle | 通用任务队列，自适应拥塞节流 |
| [db.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/db.js) | 搜索页 + 详情页 | document_idle | IndexedDB 持久化层（jzCollector v2） |
| [l1-shadow-db.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/l1-shadow-db.js) | 仅搜索页 | document_idle | L1 影子表（jzL1Shadow v2） |
| [l1-bridge.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/l1-bridge.js) | 仅搜索页 | document_idle | 跨 world 数据桥（MAIN→ISOLATED→SW） |
| [l1-diff.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/l1-diff.js) | 仅搜索页 | document_idle | L1/L2 对比诊断，Phase 2 决策 |
| [auto-scroller.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/auto-scroller.js) | 搜索页 + 详情页 | document_idle | 自动翻页，订阅 queue congestion |
| [keyword-pilot.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/keyword-pilot.js) | 搜索页 + 详情页 | document_idle | 关键词巡航，跨页复活 |
| [anti-ban.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/anti-ban.js) | 搜索页 + 详情页 | document_idle | 反爬守卫，403 探测 + window.open 绕过 |
| [panel.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/panel.js) | 搜索页 + 详情页 | document_idle | 浮动控制面板 UI + 智能筛选 |
| [panel.css](file:///c:/root/code/ozon-my/qx-ozon/content/collector/panel.css) | 搜索页 + 详情页 | document_idle | 面板样式 |

> 详情页（manifest 第三条）注入精简版，无 L1 三件套（BFF 拦截相关）。

### 1.2 核心数据流（双数据层）

```
┌─────────────────────────────────────────────────────────────┐
│ L1 路径：BFF 拦截（仅供 Phase 2 决策，不直接落桶）            │
│                                                              │
│  MAIN world: ozon-bff-interceptor.js                         │
│     │ window.postMessage({type:'JZC_OZON_COMPOSER_RESPONSE'})│
│     ▼                                                        │
│  ISOLATED: l1-bridge.js                                      │
│     │ 1. 写 l1-shadow-db (samples + sku_samples)             │
│     │ 2. batch 10 条/2s 转发 SW (JZC_L1_SAMPLE)              │
│     ▼                                                        │
│  SW: service-worker.js                                       │
│     └ 灰度上报后端                                           │
│                                                              │
│  l1-diff.js: L1 覆盖率 vs L2 命中次数对比 → Phase 2 verdict   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ L2 路径：DOM 抓取 + API 拉数（真正落桶 + 推后端）             │
│                                                              │
│  ozon-search.js: extractCardInfo(card)                       │
│     │ 从 DOM 抽 url/name/price/image                         │
│     ▼                                                        │
│  loadPanelData → taskQueue.add(stats-${productId})            │
│     │ Promise.allSettled 4 路并行:                            │
│     │   1. getMarketStats  → seller.ozon.ru what_to_sell/v3  │
│     │   2. getProductStats → 后端 /ozon/product-data/:sku    │
│     │   3. searchVariants  → seller.ozon.ru /search + bundle │
│     │   4. jzFetchPublicFollowSell → composer-api modal      │
│     ▼                                                        │
│  jzMergeCardPanelData 合并 4 路结果 → data                    │
│     │                                                        │
│     ├→ panelDataCache.set(productId, data)                   │
│     ├→ jzRenderProductPanelV2(panel, data) 渲染数据卡         │
│     └→ collectSaleIfMatched → db.putSale(record) 本地桶       │
│                                                              │
│  handleCollectOne (单卡主动采集):                              │
│     ├→ searchVariants → jzExtractCatalogFromSv               │
│     ├→ pushSourceCollect → SW → 后端 /sources/ozon/collect   │
│     └→ db.putSale 本地桶兜底                                  │
│                                                              │
│  pushBucketToCollectBox (整桶批量推送):                        │
│     └→ pushSourceCollectBatch → SW → 后端 /collect/batch      │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 三大并发队列（按反爬敏感度分级）

| 队列 | 并发 | stagger | 用途 |
|------|------|---------|------|
| `taskQueue`（JZTaskQueue） | 6 | - | 数据面板请求（4 路 Promise.allSettled） |
| `variantsQueue`（makeStaggeredQueue） | 2 | 300ms | seller-portal searchVariants（反爬指纹敏感） |
| `followSellQueue`（makeStaggeredQueue） | 1 | 500ms | composer-api 跟卖数（heaviest） |

详见 [ozon-search.js#L49-L107](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L49-L107)。

### 1.4 关键开关三态分离

| 开关 | 默认 | 作用 |
|------|------|------|
| `panelState.enabled` | true | 数据面板自动加载，新用户一进搜索页卡片就自动挂面板 |
| `collectorRunning` | false | 是否把 panel 数据写入 IndexedDB 本地桶 |
| `collectorEnabled` | false | 是否显示采集器浮动面板 |

三者完全解耦：采集器停了 panel 仍照常加载显示。详见 [ozon-search.js#L20-L31](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L20-L31)。

### 1.5 CSV 导出 30 列字段

详见 [db.js#L246-L277](file:///c:/root/code/ozon-my/qx-ozon/content/collector/db.js#L246-L277)：

```
SKU / 商品名 / 当前价(₽) / 月销量 / 月销售额(₽) / 月销售额(¥)
品牌 / 发货模式 / 重量(g) / 上架时间(天) / 月周转动态(%) / 广告费占比(%)
参与促销天数 / 参与促销折扣(%) / 促销活动转化率(%) / 付费推广天数
商品卡浏览量 / 商品卡加购率(%) / 搜索目录浏览量 / 搜索目录加购率(%)
展示转化率(%) / 退货取消率(%) / 跟卖人数 / 跟卖最低价 / 折扣(%)
关键词 / URL / 主图 / 状态 / 采集时间
```

### 1.6 智能筛选 19 维度

详见 [panel.js#L155-L211](file:///c:/root/code/ozon-my/qx-ozon/content/collector/panel.js#L155-L211)：

- 数值字段（19）：月销量 / 月销售额 / 价格 / 重量 / 上架时间 / 月周转动态 / 广告费占比 / 促销天数 / 促销折扣 / 促销转化率 / 付费推广天数 / 商品卡浏览量 / 商品卡加购率 / 搜索目录浏览量 / 搜索目录加购率 / 展示转化率 / 退货取消率 / 跟卖人数 / 跟卖最低价
- 发货模式：FBS / FBO / 不限
- 品牌选项：有品牌 / 无品牌 / 不限

---

## 二、数据来源分类总览

采集器每个 sale record 字段都来自以下 **5 类数据源** 之一或组合：

| 数据源代号 | 来源类型 | 页面/端点 | 用途 |
|-----------|---------|----------|------|
| **A. DOM** | 搜索/类目页卡片元素 | `https://www.ozon.ru/search/*` / `/category/*` | url/name/price/image/salesText/sellerText/ratingText/discount |
| **B. Seller Portal API** | seller.ozon.ru 内部接口 | `https://seller.ozon.ru/api/v1/search` + `/api/site/seller-prototype/create-bundle-by-variant-id` + `/api/site/seller-analytics/what_to_sell/data/v3` | 品牌类目属性/物理参数/月销量月销售额/转化率/广告费 |
| **C. 后端 backend API** | 自家后端 | `${backendUrl}/ozon/product-data/:sku` 或 `/product-data/batch` | 部分统计/价格兜底 |
| **D. composer-api modal** | Ozon 公开 BFF | `https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=/modal/otherOffersFromSellers?product_id=<sku>` | 跟卖卖家列表/跟卖最低价 |
| **E. URL 参数** | 浏览器地址栏 | `window.location.search` 的 `text` 参数 | 关键词（采集时归类用） |

> **L1 BFF 拦截**（`ozon-bff-interceptor.js` 拦截 `/api/composer-api.bx/_action/getCatalog` 等 7 个端点）目前仅供 Phase 2 决策对比，不直接落桶。详见下文第六节。

---

## 三、数据来源逐一分析

### 3.1 来源 A：搜索/类目页 DOM 元素

**页面**：`https://www.ozon.ru/search/*`、`https://www.ozon.ru/category/*`、`https://www.ozon.ru/highlight/*`

**卡片选择器**（[ozon-search.js#L11-L17](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L11-L17)）：

```js
const SELECTORS = [
  '[data-widget="searchResultsV2"] > div > div',
  '[data-widget="searchResults"] > div > div',
  '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
  '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
  '.tile-root',
];
```

#### 3.1.1 extractCardInfo（[ozon-search.js#L131-L169](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L131-L169)）

抽 4 个核心字段：

| 字段 | DOM 元素 | 选择器 / 提取方式 | 备注 |
|------|---------|------------------|------|
| `url` | `<a>` 链接 | `card.querySelector('a[href*="/product/"]')` 的 `href` | URL 形如 `/product/some-name-1234567890/` |
| `name` | `<a aria-label>` / `<img alt>` / `<a> textContent` | 三级优先级，避开 Chrome 翻译污染；用 `jzStripPromo` 剥角标 | 翻译态下留空，让后端 attr 4180 兜底 |
| `price` | 价格节点 | `card.querySelector('[data-widget="searchResultsPrice"]')` 或 `[data-widget="webPrice"]` 的 textContent | 用 `window.normalizePrice` 解析为数字 |
| `image` | `<img>` | `img.getAttribute('src')` 或 `img.getAttribute('data-src')` | 主图 URL |

#### 3.1.2 ensureBadge（[ozon-search.js#L199-L238](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L199-L238)）

抽 5 个角标字段（用于卡片角标显示，不直接落 sale record，但 `extractVisiblePriceText` 也用于 panel 兜底）：

| 字段 | DOM 元素 | 选择器 |
|------|---------|--------|
| `price` | 价格节点 | `[data-widget="searchResultsPrice"]` 或 `[data-widget="webPrice"]` |
| `oldPrice` | 原价节点 | `[data-widget="searchResultsOldPrice"]` 或 `[data-widget="oldPrice"]` |
| `discount` | 计算字段 | `Math.round(((oldPrice - price) / oldPrice) * 100)` |
| `salesText` | 销量文本 | `[data-widget="searchResultsSales"]` 的 textContent |
| `sellerText` | 卖家文本 | `[data-widget="searchResultsSeller"]` 的 textContent |
| `ratingText` | 评分文本 | `[data-widget="searchResultsRating"]` 的 textContent |

#### 3.1.3 extractProductId（[ozon-search.js#L243-L247](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L243-L247)）

从 URL 抽 SKU：

```js
url.match(/\/product\/.*-(\d{5,})/)[1]
```

#### 3.1.4 buildSaleRecord（[ozon-search.js#L264-L282](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L264-L282)）

把 DOM 抽到的 info + 合并后的 data 组装成 sale record：

| 字段 | 来源 |
|------|------|
| `sku` | extractProductId(url) |
| `url` / `name` / `price` / `image` | info（DOM） |
| `soldCount` / `gmvSum` / `views` / `convViewToOrder` / `discount` | data（合并后） |
| `keyword` | URL 参数 `text`（见 3.5） |
| `collectedAt` | `Date.now()` |
| `status` | `'local'` |
| `raw` | 完整 data 对象（CSV 导出时多字段兜底用） |

---

### 3.2 来源 B：Seller Portal API（seller.ozon.ru）

采集器依赖 3 个 seller.ozon.ru 内部接口，全部通过 SW `chrome.scripting.executeScript` 在 seller tab 上下文执行（借登录态 cookie `sc_company_id` + `x-o3-company-id` header）。

#### 3.2.1 searchVariants（[service-worker.js#L4097-L4296](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4097-L4296)）

**两步流程**：

**Step 1**：`POST https://seller.ozon.ru/api/v1/search`

请求体（[L4191-L4212](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4191-L4212)）：

```json
{
  "company_id": "<sc_company_id>",
  "need_total": true,
  "filter": {
    "children_nodes": {
      "children_nodes": [{ "input_leaf": { "sku": { "values": ["<sku>"] } } }],
      "operator": "AND"
    }
  },
  "pagination": { "limit": "50" },
  "is_copy_allowed": false
}
```

响应字段：
- `resp.variants` 或 `resp.items` 或 `resp.products`（多 key 兜底）
- 经 `normalizeSearchVariantToSv` 转成 sv item（含 `variant_id`、基础 attributes）

**Step 2**：`POST https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id`

请求体含 `variant_id`（Step 1 拿到）+ `company_id`。响应字段（[L4234-L4296](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4234-L4296)）：

| 响应字段 | 用途 |
|---------|------|
| `bundleItem.weight` | 推入 sv attr `4497`（重量 g） |
| `bundleItem.depth` | 推入 sv attr `9454`（长 mm） |
| `bundleItem.width` | 推入 sv attr `9455`（宽 mm） |
| `bundleItem.height` | 推入 sv attr `9456`（高 mm） |
| `bundleItem.barcode` | 推入 sv attr `7822`（GTIN） |
| `bundleItem.attributes[]` | 40-63 个完整业务 attr（刷子类型/季卡/材质/...），simple attr 推入 `physicalAttrs`，complex attr（视频/PDF）入 `_bundleComplexAttrs` |

bundle 端点有 24h cache（chrome.storage.local），传 `forceRefresh=true` 可绕过。

**返回给 content script 的最终 sv item 结构**：

```js
{
  variant_id,
  attributes: [
    { key: '85',  value: '品牌名' },       // 品牌
    { key: '4180', value: '商品名' },       // 原始俄/英文名
    { key: '4194', value: '主图 URL' },
    { key: '4195', collection: [...] },     // 图册
    { key: '8229', value: '类目名' },
    { key: '4497', value: '重量 g' },
    { key: '9454', value: '长 mm' },
    { key: '9455', value: '宽 mm' },
    { key: '9456', value: '高 mm' },
    { key: '7822', value: 'GTIN' },
    // ... 其他 40-63 个业务 attr
  ],
  _bundleComplexAttrs: [...],  // 视频/PDF complex attr
}
```

**content script 侧消费**：`jzExtractCatalogFromSv`（[shared-utils.js#L1976](file:///c:/root/code/ozon-my/qx-ozon/content/shared-utils.js#L1976)）把 sv attr 转成统一 catalog 字段：

| catalog 字段 | sv attr key |
|-------------|-------------|
| `name` | 4180 |
| `mainImage` | 4194 |
| `images` | 4195（collection） |
| `brand` | 85 |
| `categoryPath` / `categoryId` | 8229 |
| `weightG` | 4497（g）/ 4383（kg 浮点） |
| `depthMm` | 9454 |
| `widthMm` | 9455 |
| `heightMm` | 9456 |
| `gtin` | 7822 |

#### 3.2.2 getMarketStats（[service-worker.js#L3506-L3594](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3506-L3594)）

**端点**：`POST https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3`

在 seller tab 上下文执行（借 cookie + header），请求体（[L3582-L3588](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3582-L3588)）：

```json
{
  "filter": { "stock": "any_stock", "period": "monthly|weekly", "sku": "<sku>" },
  "sort": { "key": "sum_gmv_desc" },
  "limit": "1",
  "offset": "0"
}
```

Headers：
- `x-o3-app-name: seller-ui`
- `x-o3-company-id: <sc_company_id>`
- `x-o3-language: zh-Hans`

响应：`result.items[0]` 或 `result.data[0]`，字段大小写归一在 SW 侧 `normalizeMarketItem` 完成。

**响应字段 → sale record 字段映射**（经 `jzMergeCardPanelData` 合并，[shared-utils.js#L1881-L1915](file:///c:/root/code/ozon-my/qx-ozon/content/shared-utils.js#L1881-L1915)）：

| 响应字段（归一后） | sale record 字段 | CSV 列 |
|------------------|-----------------|--------|
| `md.soldCount` | `soldCount` | 月销量 |
| `md.gmvSum` | `gmvSum` | 月销售额(₽) |
| `md.avgPrice` | `avgPrice` | （内部用） |
| `md.views` | `views` | 商品卡浏览量 |
| `md.convViewToOrder` | `convViewToOrder` | 展示转化率（CSV displayConversionRate 兜底） |
| `md.salesDynamics` | `salesDynamics` | 月周转动态（CSV monthlyTurnoverDynamic 兜底） |
| `md.drr` | `drr` | 广告费占比（CSV adCostRatio 兜底） |
| `md.discount` | `discount` | 折扣(%) |
| `md.daysInPromo` | `daysInPromo` | 参与促销天数（CSV promoDays 兜底） |
| `md.promoRevenueShare` | `promoRevenueShare` | 促销活动转化率（CSV promoConversionRate 兜底） |
| `md.daysWithTrafarets` | `daysWithTrafarets` | 付费推广天数（CSV paidPromotionDays 兜底） |
| `md.qtyViewPdp` | `qtyViewPdp` | PDP 浏览量（CSV views 二级兜底） |
| `md.sessionCount` | `sessionCount` | 会话数（CSV views 三级兜底） |
| `md.pdpToCartConversion` | `pdpToCartConversion` | PDP 加购率（CSV cardAddToCartRate 二级兜底） |
| `md.convToCartPdp` | `convToCartPdp` | PDP 加购率（CSV cardAddToCartRate 三级兜底） |
| `md.sessionCountSearch` | `sessionCountSearch` | 搜索目录浏览量（CSV searchCatalogViews 二级兜底） |
| `md.convToCartSearch` | `convToCartSearch` | 搜索目录加购率（CSV searchCatalogAddToCartRate 二级兜底） |
| `md.salesSchema` | `salesSchema` | 发货模式（CSV shippingMode 二级兜底） |
| `md.nullableRedemptionRate` | `nullableRedemptionRate` | 兑付率（CSV returnCancelRate = 100 - redemption 兜底） |
| `md.nullableCreateDate` | `createDate` | 上架日期（CSV listedDays 兜底，转天数） |
| `md.avgOrdersOnAccDays` | `dailySales` | 日销量（内部用） |
| `md.avgGmvOnAccDays` | `dailyRevenue` | 日销售额（内部用） |

**未登录 seller 时**：返回 `{ __needSellerLogin: true, __reason: 'NO_SELLER_TAB' }`，content script 侧 panel 显示"请登录卖家中心"红色提示。

**代采机制**：本机没登卖家端时，透明回退派给同租户已登录设备代采（`proxyMarketData`）。

#### 3.2.3 物理 attr key 映射表

完整 attr key 列表（[shared-utils.js#L1973-L1975 注释](file:///c:/root/code/ozon-my/qx-ozon/content/shared-utils.js#L1973-L1975)）：

| attr key | 含义 |
|----------|------|
| 4180 | 商品名（原始俄/英文） |
| 4194 | 主图 |
| 4195 | 图册（collection） |
| 85 | 品牌 |
| 8229 | 类型/类目名 |
| 4497 | 重量 g |
| 4383 | 重量 kg（浮点） |
| 9454 | 长 mm |
| 9455 | 宽 mm |
| 9456 | 高 mm |
| 7822 | GTIN 条形码 |

---

### 3.3 来源 C：后端 backend API

#### 3.3.1 getProductStats（[service-worker.js#L3475-L3505](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3475-L3505)）

**带 catIds 时**（PDP 单卡，从面包屑抽的买家类目 id）：

```
GET ${backendUrl}/ozon/product-data/<sku>?skipMarket=1&catIds=<catId1>,<catId2>
```

**不带 catIds 时**（搜索页卡，走合批器）：

```
POST ${backendUrl}/ozon/product-data/batch
body: { skus: [<sku>] }
```

合批器内部批量失败时自动退回逐 SKU GET。

**响应字段 → sale record 字段**（经 `jzMergeCardPanelData` 合并）：

| 响应字段 | sale record 字段 | 优先级 |
|---------|-----------------|--------|
| `productData.statistics.sold_count` | `soldCount` | md.soldCount 兜底 |
| `productData.statistics.gmv_sum` | `gmvSum` | md.gmvSum 兜底 |
| `productData.statistics.views` | `views` | md.views 兜底 |
| `productData.rating` | `rating` | 独占 |
| `productData.brand` | `brand` | md.brand 兜底 |
| `productData.followSellCount` | `followSellCount` | publicData 兜底 |
| `productData.followSellMinPrice` | `followSellMinPrice` | publicData 兜底 |
| `productData.canFollow` | `canFollow` | 独占 |
| `productData.dailySales` | `dailySales` | md.avgOrdersOnAccDays 兜底 |
| `productData.dailyRevenue` | `dailyRevenue` | md.avgGmvOnAccDays 兜底 |

#### 3.3.2 pushSourceCollect（[service-worker.js#L3253-L3361](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3253-L3361)）

**单卡主动采集**，端点：

```
POST ${backendUrl}/sources/ozon/collect
body: { raw: collectPayload, storeId }
```

**collectPayload 字段**（[ozon-search.js#L504-L518](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L504-L518)）：

| 字段 | 来源 |
|------|------|
| `sku` | extractProductId(url) |
| `url` | info.url（DOM） |
| `name` | svCat.name 优先，info.name 兜底（`jzPreferSourceName` 决策） |
| `price` | info.price（DOM） |
| `image` | svCat.mainImage 优先，info.image 兜底 |
| `images` | svCat.images 优先，[info.image] 兜底 |
| `variantData` | searchVariants 返回的 variantMatch（完整 sv item） |
| `soldCount` / `gmvSum` / `views` / `convViewToOrder` / `discount` | panelDataCache 里的 data（合并后） |

**去重机制**：
- dedupe key = `jz-collect-recent-v1:<host>:<storeId>:<sourceId>:<sku>`，24h TTL（chrome.storage.local）
- in-flight 合并：同 cacheKey 并发请求 await 同一个 Promise
- 网络层失败指数退避：1s → 2s → 放弃（最多 3 次尝试）
- 4xx 业务错误立即失败不重试
- `forceResubmit:true` 跳 dedupe

**响应**：`{ dedupeHit, lastAt, result }`

#### 3.3.3 pushSourceCollectBatch（[service-worker.js#L3397-L3417](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3397-L3417)）

**整桶批量推送**，端点：

```
POST ${backendUrl}/sources/ozon/collect/batch
body: { items: [{ raw: collectPayload }, ...] }
```

每批 100 条（新端点上限 200，带完整 variantData 时 100 条 body ~10MB）。

后端 provider 做：`validatePayload` + `normalize`（prune variantData + RUB→CNY + sourceId='ozon' + sourceExternalId 唯一索引去重）。

**响应**：`{ results: [{ action: 'created'|'updated' }], errors: [{ index, reason }] }`

成功项 `markPushed(skus)` 改 status='pushed'，失败项保留 'local' 等下次重试。

---

### 3.4 来源 D：composer-api modal（跟卖数据）

#### 3.4.1 jzFetchPublicFollowSell（[shared-utils.js#L2467-L2487](file:///c:/root/code/ozon-my/qx-ozon/content/shared-utils.js#L2467-L2487)）

**端点**（[shared-utils.js#L2420-L2423](file:///c:/root/code/ozon-my/qx-ozon/content/shared-utils.js#L2420-L2423)）：

```
GET https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=/modal/otherOffersFromSellers?product_id=<sku>
```

Headers：
- `accept: application/json`
- `x-o3-app-name: dweb_client`
- `x-o3-language: <document.documentElement.lang || 'ru'>`

credentials: include（同源 cookie）

**响应解析**：`widgetStates['webSellerList-...'].sellers` 是 normalized seller 数组，每个 seller 含：

```js
{
  name, price, sku, productLink,
  rating, reviewsCount, region,
  deliveryText, deliveryRank
}
```

零跟卖时 webSellerList widget 不存在（widgetCount=5）。

**缓存**：
- 命中 cache（4h TTL）时 0 网络成本
- 零跟卖 cache 30min（避免重复打 modal endpoint，但首个跟卖出现后能及时刷新）
- miss cache 避免短期重试
- 失败累积触发 `pausedUntil` 退避

**返回给采集器**：`{ count, sellers }`

**→ sale record 字段映射**（经 `jzMergeCardPanelData`，[shared-utils.js#L1855-L1872](file:///c:/root/code/ozon-my/qx-ozon/content/shared-utils.js#L1855-L1872)）：

| 响应字段 | sale record 字段 | CSV 列 |
|---------|-----------------|--------|
| `count` | `followSellCount` | 跟卖人数（followerCount 一级兜底） |
| `sellers[].price` 取 min | `followSellMinPrice` | 跟卖最低价（lowestFollowerPrice 一级兜底） |
| `sellers` | `followSellers` | （内部用，弹窗展示） |

---

### 3.5 来源 E：URL 参数

**字段**：`keyword`

**提取**（[ozon-search.js#L265](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L265)）：

```js
new URLSearchParams(window.location.search).get('text') || ''
```

**适用页面**：
- `/search/?text=<关键词>` → 直接拿到
- `/category/<slug>-<catId>/?text=<关键词>` → 拿到
- `/highlight/<slug>/?text=<关键词>` → 拿到
- 无 text 参数的纯类目浏览 → 空字符串

---

## 四、字段 → 数据来源完整映射表

下表把 CSV 30 列字段逐一对应到数据来源（一级 + 兜底链）：

| CSV 列 | sale record key | 一级来源 | 二级兜底 | 三级兜底 |
|--------|----------------|---------|---------|---------|
| SKU | `sku` | A. DOM URL 正则 | - | - |
| 商品名 | `name` | B. sv attr 4180（jzPreferSourceName 决策） | A. DOM aria-label/alt/text | - |
| 当前价(₽) | `price` | A. DOM `[data-widget="searchResultsPrice"]` | A. DOM `[data-widget="webPrice"]` | A. DOM 正则匹配 ₽ |
| 月销量 | `soldCount` | B. what_to_sell `md.soldCount` | C. backend `statistics.sold_count` | - |
| 月销售额(₽) | `gmvSum` | B. what_to_sell `md.gmvSum` | C. backend `statistics.gmv_sum` | - |
| 月销售额(¥) | `gmvSumCny` | B/C. `raw.gmvSumCny` | B/C. `raw.revenue30dCny` | `_extractCny(raw.revenue30d)` → `gmvSum × 0.084` |
| 品牌 | `brandName` | B. sv attr 85 | B/C. `md.brand` | C. `productData.brand` |
| 发货模式 | `shippingMode` | B. what_to_sell `md.salesSchema` | `md.marketSalesSchema` | `md.deliverySchema` → `md.deliveryType` |
| 重量(g) | `weight` | B. sv attr 4497/4383 | `raw.weight` | `raw.weightG` → `raw.weightGrams` |
| 上架时间(天) | `listedDays` | B. `md.nullableCreateDate`（转天数） | `raw.daysOnline` | `raw.createDate` → `raw.nullableCreateDate` |
| 月周转动态(%) | `monthlyTurnoverDynamic` | B. `md.salesDynamics` | `raw.monthlyTurnoverDynamic` | `raw.turnoverDynamic` |
| 广告费占比(%) | `adCostRatio` | B. `md.drr` | `raw.adCostRatio` | `raw.adCostPercent` |
| 参与促销天数 | `promoDays` | B. `md.daysInPromo` | `raw.promoDays` | - |
| 参与促销折扣(%) | `promoDiscount` | A. DOM 计算的 discount | `raw.promoDiscount` | `raw.discount` |
| 促销活动转化率(%) | `promoConversionRate` | B. `md.promoRevenueShare` | `raw.promoConversionRate` | `raw.promoConvRate` |
| 付费推广天数 | `paidPromotionDays` | B. `md.daysWithTrafarets` | `raw.paidPromotionDays` | `raw.daysWithAds` |
| 商品卡浏览量 | `views` | B. `md.views` | C. `statistics.views` | `raw.qtyViewPdp` → `raw.sessionCount` → `raw.pdpViews` |
| 商品卡加购率(%) | `cardAddToCartRate` | B. `md.pdpToCartConversion` | `raw.cardAddToCartRate` | `raw.convToCartPdp` → `raw.pdpCartRate` |
| 搜索目录浏览量 | `searchCatalogViews` | B. `md.sessionCountSearch` | `raw.searchCatalogViews` | `raw.searchViews` |
| 搜索目录加购率(%) | `searchCatalogAddToCartRate` | B. `md.convToCartSearch` | `raw.searchCatalogAddToCartRate` | `raw.searchCartRate` |
| 展示转化率(%) | `displayConversionRate` | B. `md.convViewToOrder` | `raw.displayConversionRate` | `rec.convViewToOrder` |
| 退货取消率(%) | `returnCancelRate` | B. `md.nullableRedemptionRate`（100 - redemption） | `raw.returnCancelRate` | `raw.returnRate` |
| 跟卖人数 | `followerCount` | D. modal `followSellCount` | `raw.followSellCount` | `raw.heroFollow` |
| 跟卖最低价 | `lowestFollowerPrice` | D. modal sellers[].price 取 min | `raw.lowestFollowerPrice` | `raw.followSellMinPrice` → `raw.followMinPrice` |
| 折扣(%) | `discount` | A. DOM 计算的 discount | B/C. `md.discount` | - |
| 关键词 | `keyword` | E. URL 参数 `text` | - | - |
| URL | `url` | A. DOM `<a href>` | - | - |
| 主图 | `image` | B. sv attr 4194（jzExtractCatalogFromSv.mainImage） | A. DOM `<img src>` | - |
| 状态 | `status` | 本地 `'local'` / 推送后 `'pushed'` | - | - |
| 采集时间 | `collectedAt` | `Date.now()`（落桶时） | - | - |

> 兜底解析见 [db.js#L351-L400 `_resolveCsvValue`](file:///c:/root/code/ozon-my/qx-ozon/content/collector/db.js#L351-L400)。

---

## 五、loadPanelData 全链路时序

**触发**：用户滚动到新卡片 / 缓存未命中时（[ozon-search.js#L302-L413](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L302-L413)）

```
1. extractCardInfo(card)
   └→ 从 DOM 抽 url/name/price/image

2. extractProductId(info.url)
   └→ 从 URL 抽 SKU

3. panelDataCache.has(productId)?
   └→ YES: 直接用 cached data，跳到步骤 8

4. taskQueue.add(`stats-${productId}`, fetchTask)
   fetchTask = Promise.allSettled([
     ① sendMessage('getMarketStats',   { sku, period })    // 来源 B what_to_sell
     ② sendMessage('getProductStats',  { url, period })    // 来源 C backend
     ③ variantsQueue.add(() => sendMessage('searchVariants', { sku }))  // 来源 B /search + bundle
     ④ followSellQueue.add(() => jzFetchPublicFollowSell(productId))    // 来源 D modal
   ])

5. variant 失败兜底：
   └→ jzReadCachedWeightDims(productId) 从 chrome.storage.local 读详情页采集的 cache

6. jzMergeCardPanelData(market, product, variant, followSell, productId, cachedWeightDims)
   └→ 合并 4 路结果 → data（含 30+ 字段）

7. data.preFetched = { stats, market, variant, followCount }
   panelDataCache.set(productId, data)

8. jzRenderProductPanelV2(panel, { sku, initial: data })
   └→ 渲染数据卡 5-section 布局

9. collectSaleIfMatched(productId, card, info, data, panel)
   ├→ 仅 collectorRunning=true 时执行
   ├→ jzExtractPanelFilterData(panel, info, data) 抽筛选字段
   ├→ waitForCollectorFilterData 等 price 就绪
   ├→ passCollectorFilters 检查（仅抓有销量 + 智能筛选）
   └→ db.putSale(buildSaleRecord(productId, info, data))  ← 本地桶
```

---

## 六、L1 BFF 拦截（Phase 2 决策数据源，不直接落桶）

### 6.1 拦截器（[ozon-bff-interceptor.js](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-bff-interceptor.js)）

**注入**：MAIN world / document_start

**端点白名单**（7 个，[L58-L66](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-bff-interceptor.js#L58-L66)）：

| 端点 | 适用页面 | 用途 |
|------|---------|------|
| `/api/composer-api.bx/_action/getCatalog` | 搜索/类目 | 搜索结果 v2 翻页 / 类目卡片 |
| `/api/composer-api.bx/_action/getSimilarSearch` | 搜索/类目 | 搜索相似 / SPA 跳转后 BFF |
| `/api/composer-api.bx/page/json/v2` | 搜索/类目/商品 | 首屏 SSR hydrate |
| `/api/composer-api.bx/_action/widgetStatesV2` | 商品页 | 商品页内部 widget 刷新 |
| `/api/composer-api.bx/_action/getSellerProducts` | 商品页 | 同店其他商品 |
| `/api/composer-api.bx/_action/v2/reviewsList` | 商品页 | 商品评价 |
| `/api/entrypoint-api.bx/page/json/v2` | 通用 | SSR hydrate |

**拦截方式**：
- `window.fetch` 装 getter/setter，Ozon 重置后自动重 wrap
- `XMLHttpRequest.prototype.open/send` 同理
- `toString` 伪装成 native，规避指纹检测
- clone response 后异步 `.json()`，失败静默吞掉
- 通过 `window.postMessage({ type: 'JZC_OZON_COMPOSER_RESPONSE', url, data, source, ts })` 推给 ISOLATED world

### 6.2 l1-bridge.js（[l1-bridge.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/l1-bridge.js)）

接收 MAIN world 的 postMessage：
1. 写本地 `JZL1ShadowDB`（只存 metadata：URL / 响应大小 / 字段命中）
2. batch 10 条/2s 转发 SW（`JZC_L1_SAMPLE` action）
3. debug 入口：`__jzc.l1Stats()` / `l1Clear()` / `l1ReportStatus()`

### 6.3 l1-shadow-db.js（[l1-shadow-db.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/l1-shadow-db.js)）

独立 database `jzL1Shadow` v2，2 个 store：

| store | keyPath | 用途 | 保留策略 |
|-------|---------|------|---------|
| `samples` | 自增 | 响应级 metadata | 5000 行 / 14 天 TTL |
| `sku_samples` | 自增 | SKU 级字段存在性 | 50000 行 / 7 天 TTL |

**遍历预算**：`WALK_MAX_NODES=5000` / `WALK_MAX_DEPTH=30` / `WALK_MAX_ARRAY_ITEMS=200`

**FIELD_PROBES（6 个）**：price / title / image / seller / sales / rating

### 6.4 l1-diff.js（[l1-diff.js](file:///c:/root/code/ozon-my/qx-ozon/content/collector/l1-diff.js)）

L1 vs L2 对比诊断：
- L1 覆盖率 ratio = |L1| / |L2|（验收标准 ≥ 1.2x）
- 字段完整度对比：6 个 probe 在 L1 与 L2 上的命中次数
- `phase2Verdict`：`READY_FOR_PHASE2` / `NO_DATA` / `L1_COVERAGE_INSUFFICIENT` / `FIELD_NO_ADVANTAGE`

**当前状态**：L1 数据不直接落 sale record，仅作为 Phase 2 切换数据源的决策依据。Phase 2 验证 L1 覆盖率达标后，可将 DOM 抓取（L2）切换为 BFF 拦截（L1）以降低 DOM 抓取压力。

---

## 七、关键端点速查表

| 用途 | 方法 | 端点 | 触发方 | 数据来源代号 |
|------|------|------|--------|-------------|
| 搜索变体元数据 | POST | `https://seller.ozon.ru/api/v1/search` | SW（seller tab 注入） | B |
| 完整 attributes + 物理 | POST | `https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id` | SW（seller tab 注入） | B |
| 月销量/销售额/转化率 | POST | `https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3` | SW（seller tab 注入） | B |
| 后端商品统计 | GET | `${backendUrl}/ozon/product-data/<sku>?skipMarket=1&catIds=...` | SW | C |
| 后端商品统计（合批） | POST | `${backendUrl}/ozon/product-data/batch` | SW（合批器） | C |
| 跟卖卖家列表 | GET | `https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=/modal/otherOffersFromSellers?product_id=<sku>` | content script（同源 fetch） | D |
| 单卡采集入库 | POST | `${backendUrl}/sources/ozon/collect` | SW | - |
| 批量采集入库 | POST | `${backendUrl}/sources/ozon/collect/batch` | SW | - |
| BFF 拦截（L1） | GET/POST | 7 个 composer-api / entrypoint-api 端点 | MAIN world 拦截器 | L1 |

---

## 八、跨 tab 同步与 popup 大屏

### 8.1 BroadcastChannel('jz-collector')

[db.js#L69-L104](file:///c:/root/code/ozon-my/qx-ozon/content/collector/db.js#L69-L104) 用 `BroadcastChannel('jz-collector')` 跨 tab 同步 `sale-changed` 事件，多 tab 采集互不干扰，UI 计数实时刷新。

### 8.2 collectorHeartbeat / collectorGetState

- `collectorHeartbeat`（[service-worker.js#L3419](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3419)）：每个活跃采集器 tab 定期上报状态到 SW 的 `collectorTabs` Map
- `collectorGetState`（[service-worker.js#L3436](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3436)）：popup 拉取所有活跃采集器 tab，呈现大屏视图

---

## 九、关键设计要点

1. **三态开关分离**：panel 展示 / 本地落桶 / 面板显示三个开关独立，新用户默认看数据不落桶
2. **L1/L2 双数据层**：BFF 拦截（L1）与 DOM+API 抓取（L2）并行，Phase 2 验证 L1 覆盖率达标后可切换数据源
3. **自适应拥塞节流**：TaskQueue 带滞回的 high/low 阈值（12/6），AutoScroller 订阅 congestion 自动暂停/恢复，避免 403 雪崩
4. **反爬指纹分级**：三个队列按反爬敏感度分级并发 + stagger
5. **跨页复活**：KeywordPilot 用 IndexedDB sessions store（而非 chrome.storage.session — SW 会休眠）
6. **403 绕过**：AntiBanGuard 滑动窗口检测 + `window.open` 重开（绕过反爬指纹）
7. **本地桶兜底**：pushSourceCollect 失败仍有 IndexedDB 本地桶，可后续导出 CSV 或重推
8. **多字段兜底解析**：CSV 导出时每个字段都有 2-4 级兜底，适配后端字段命名变更
9. **流式游标查询**：`getSalesSince` 走 collectedAt 索引游标，避免 getAllSales 把万行桶全量 deserialize
10. **跟卖式 catalog 优先 sv**：name/images 切 sv（search+bundle）优先，DOM 兜底，避免 Chrome 翻译污染
11. **24h dedupe + in-flight 合并**：快速连点 5 次合并为 1 次 POST，24h 内重复采集返 dedupeHit
12. **代采机制**：本机没登 seller 时透明回退派给同租户已登录设备代采
13. **bundle 24h cache**：bundle endpoint 每次创建 draft bundle_id，24h cache 避免无谓 draft 增长，forceRefresh 可绕过

---

## 十、附录：文件清单

| 文件路径 | 行数 | 核心职责 |
|---------|------|---------|
| `qx-ozon/content/collector/task-queue.js` | ~250 | 通用任务队列，自适应拥塞节流 |
| `qx-ozon/content/collector/db.js` | ~500 | IndexedDB 持久化层 + CSV 导出 |
| `qx-ozon/content/collector/l1-shadow-db.js` | ~250 | L1 影子表 |
| `qx-ozon/content/collector/l1-bridge.js` | ~200 | 跨 world 数据桥 |
| `qx-ozon/content/collector/l1-diff.js` | ~200 | L1/L2 对比诊断 |
| `qx-ozon/content/collector/auto-scroller.js` | ~250 | 自动翻页 |
| `qx-ozon/content/collector/keyword-pilot.js` | ~300 | 关键词巡航 |
| `qx-ozon/content/collector/anti-ban.js` | ~200 | 反爬守卫 |
| `qx-ozon/content/collector/panel.js` | ~800 | 浮动控制面板 + 智能筛选 |
| `qx-ozon/content/collector/panel.css` | - | 面板样式 |
| `qx-ozon/content/ozon-search.js` | ~1200 | 集成入口（搜索/类目页） |
| `qx-ozon/content/ozon-bff-interceptor.js` | ~400 | MAIN world BFF 拦截器 |
| `qx-ozon/content/shared-utils.js` | ~3500 | 字段映射 + 跟卖 fetch + panel 渲染 |
| `qx-ozon/background/service-worker.js` | ~4500 | SW 侧 4 个 handler + 合批器 |
