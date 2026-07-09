# `await window.sendMessage('followSell', ...)` 跟卖数据来源分析

> 分析对象：`c:\root\code\ozon-my\qx-ozon\content\ozon-product.js` 第 9217 行的多变体跟卖提交
> 触发位置：`handleMultiVariantFollowSell` 函数（多变体跟卖面板的「一键上架至 OZON」按钮）
> 提交载体：`window.sendMessage('followSell', { storeId, items, stocks, ... })`，SW 转发后端 worker

## 总览：items 数组每条 item 的字段来源

每条 item（[ozon-product.js#L9049](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9049)）大致由 4 类数据组装而成：

| 数据类 | 来源性质 | 关键字段 |
|--------|----------|----------|
| A. UI 表单输入 | 用户在多变体面板填写 | price / old_price / min_price / stock / offer_id / weight / depth / width / height |
| B. 当前 Ozon 商品页 DOM/state | 公开 PDP（`https://www.ozon.ru/product/...`）渲染数据 | breadcrumbs / pageProduct.brand / sharedHashtags / pageScrapedDims / sharedVideo / variantGallery(锚点) / variantRichContent |
| C. Seller Portal API | `seller.ozon.ru` 跟卖列表/复制接口 | _sourceVariant（含类目/属性/品牌/物理参数/图册/bundle 视频 PDF） |
| D. PDP page-json API | `www.ozon.ru/api/entrypoint-api.bx` / `composer-api.bx` | 非锚点变体图册 + 富内容(11254) |

下面逐一展开每个字段的具体来源。

---

## 一、UI 表单输入（用户填写）

来源：跟卖面板表格行 `.ozon-helper-mv-*` 输入控件（[ozon-product.js#L8885-L8896](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8885)）。

| item 字段 | DOM 选择器 | 说明 |
|-----------|------------|------|
| `price` | `.ozon-helper-mv-price` | 售价，经 `window.normalizePrice` |
| `old_price` | `.ozon-helper-mv-oldprice` | 划线价，空则 `price × (panel._erpConfig.old_price_ratio ?? 1.25)` |
| `min_price` | `.ozon-helper-mv-minprice` | Ozon 自动调价下限，留空/≤0 不发 |
| `_stock` | `.ozon-helper-mv-stock` | 库存，`parseInt` |
| `offer_id` | `.ozon-helper-mv-offerid` | 卖家自定义货号，空则 `SKU{sku}-{Date末4位}` |
| `weight/depth/width/height` | `.ozon-helper-mv-weight/-depth/-width/-height` | 用户输入物理参数，`parseStrictNumber` 严格只接受纯数字串 |

物理参数的**取值优先级**（[ozon-product.js#L8947-L8951](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8947)）：
```
weight = userWeight || readSourceInt('4497') || readSourceWeightKgAsG() || undefined
depth   = userDepth  || readSourceInt('9454') || undefined
width   = userWidth  || readSourceInt('9455') || undefined
height  = userHeight || readSourceInt('9456') || undefined
```
即 **用户输入 > 源 sv attr > undefined（让后端兜底）**。

面板其它选项（[ozon-product.js#L8450-L8485](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8450)）：
- `brandChoice` ← `[data-field="brand"]` 选择器
- `imageOrder` ← `[data-field="image-order"]`
- `mergeModel` ← `[data-field="merge-model"]`
- `currencyCode` ← `[data-field="currency"]`
- `applyWatermark` / `watermarkTemplateId` / `applyPoster` / `applyAiRewrite` ← 对应 checkbox/select

这些不进 `items`，而是作为顶层 payload 字段与 `items` 一起发。

---

## 二、当前 Ozon 商品页 DOM/state 数据

### 2.1 `breadcrumbs`（类目面包屑）
来源：`extractBreadcrumbs()`（[ozon-product.js#L8574](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8574) → [L850](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L850)）

数据来源优先级：
1. **页面 state JSON**：`window.findStateDataByKeys(['breadcrumbs'])` 或 `['breadCrumbs']` —— 遍历页面所有 `[data-state]` 元素，找含 `breadcrumbs`/`breadCrumbs` 键的 JSON
2. **DOM 兜底**：`[data-widget="breadCrumbs"], [data-widget="webBreadcrumbs"]` 下的 `<a>` 链接文本，过滤掉 "Ozon"/"Главная"
3. 翻译态下直接返 `[]`（避免中文面包屑匹配俄文类目树失败）

写入 `items[].scraped_breadcrumbs`。

### 2.2 `pageProduct`（当前页商品元数据）
来源：`extractProductData()`（[ozon-product.js#L8575](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8575) → [L249](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L249)）

抽取的字段：
- `sku`：URL 正则 `/product/.*-(\d+)/` → `webAddToCart.id` → `productWidget.sku` → `jsonLd.sku`
- `title`：`paginator.detail_info.name` → `productWidget.name` → `jsonLd.name` → `og:title` → `h1`（翻译态跳过 h1）
- `brand`：`state-webBrand` state JSON
- `price`：遍历所有 `[data-state]` JSON 找 `price` / `cardPrice` 字段
- `images`：`state-webGallery.images` → `galleryData.images` → `coverImage` → JSON-LD → `og:image` → DOM gallery → CDN img → srcset → 全 data-state 扫描（7 层 fallback）
- `seller`：`state-webCurrentSeller` state JSON

`pageProduct` 主要用于：
- `pageProduct.sku`：作为锚点 SKU（类目对齐基准），并直接复用其 `images` 作为锚点图册（写入 `galleryMap`）
- `pageProduct.brand`：写入 `_sourceBrand`，传给后端做「复制当前品牌」匹配

### 2.3 `sharedHashtags`（主题标签）
来源：`extractKeywords()`（[ozon-product.js#L8880](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8880) → [L10668](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L10668)）

| 优先级 | DOM 元素 | 抽取方式 |
|--------|----------|----------|
| 1 | `[data-widget="webHashtags"]` | 取 `[title]` 属性，过滤 `#` 开头 |
| 2 | `[data-widget="tagList"]`（兜底） | 取 `<a>` textContent，过滤 `#` 开头 |

写入 `items[]._aiHashtags`（后端写主题标签属性 23171）。

### 2.4 `pageScrapedDims`（页面级物理参数兜底）
来源：`parseScrapedDimensionsFromCharacteristics(extractCharacteristics())`（[ozon-product.js#L8865](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8865)）

`extractCharacteristics()`（[L901](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L901)）4 层策略：
1. **state keys**：`findStateDataByKeys(['characteristics'] / ['shortCharacteristics'] / ['specs'])`
2. **widget data-state**：`[data-widget="webCharacteristics"]` 的 `data-state` JSON，递归找 `{key,value}` 对
3. **widget DOM**：同选择器下的 `dt/dd` 或 `span` 文本
4. **JSON-LD**：`script[type="application/ld+json"]` 的 `additionalProperty`

`parseScrapedDimensionsFromCharacteristics`（[L1186](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L1186)）按俄语/英语 label 正则识别「Вес/Глубина/Ширина/Высота/Размеры」并按单位换算到 g/mm。

写入 `items[].scraped_weight / scraped_depth / scraped_width / scraped_height`（独立于用户输入/source attr 的第三层兜底）。

> 注：独立商品模式（`independentProducts`）跳过此步，避免列表页尺寸串到无关商品。

### 2.5 `sharedVideo`（页面视频转存）
来源：`captureAndTransferPageVideoMedia()`（[ozon-product.js#L8851](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8851) → [L1681](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L1681)）

**页面侧抽取** `.mp4` 直链 + 封面：
1. `window.JZOzonVideoExtract.extractOzonVideoFromSources([...])` 从多个 state 来源抽
2. 兜底：`extractOzonVideoFromDocument(document)` 从 DOM 抽
3. 最终兜底：`state-webGallery.videos` 数组里找 `.mp4` 结尾的 url

**SW 侧转存**（[service-worker.js#L4047](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4047) `uploadFollowSellVideo` → [L1116](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L1116) `transferVideoToOzon`）：
- 在 `seller.ozon.ru` tab 的 MAIN world 注入函数
- 跨源 `fetch(srcUrl)` 下载源 `.mp4` → `blob`
- `multipart POST` 到 `https://seller.ozon.ru/api/media-storage/upload-file`（带 `x-o3-company-id`、cookie）
- 返回 `{ url }` —— 转存后的卖家自有 Ozon 视频 `ir.ozone.ru/s3/...`

写入 `items[].videoUrl` / `videoCover`。

### 2.6 锚点变体图册 + 富内容
锚点 SKU（当前页变体）的图册直接复用 `pageProduct.images`（[L8587](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8587)）。

锚点富内容额外补抓一次（[L8594](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8594)）：
```js
const anchorSrc = await fetchVariantGallery(window.location.pathname);
if (anchorSrc?.richContent) richContentMap.set(String(pageProduct.sku), anchorSrc.richContent);
```

---

## 三、Seller Portal API（_sourceVariant —— 跟卖核心数据）

### 3.1 调用入口
`prefetchSourceVariantWithItems(sku)` （[ozon-product.js#L8639](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8639) → [L9748](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9748)）

通过 `window.sendMessage('searchVariants', { sku })` 调 SW（[L9751](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9751)）。

### 3.2 SW 侧 `searchVariants` 实现（[service-worker.js#L4095](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4095)）

**两步走**（注释 L4100-L4119 说明：`/api/v1/search-variant-model` 2026-05 被 Ozon 下线，新流程如下）：

#### Step 1：`/api/v1/search` 拿 variant_id + 基础元数据
- **请求**：`POST https://seller.ozon.ru/api/v1/search`
  - body：`{ company_id, need_total: true, filter: { children_nodes: { children_nodes: [{ input_leaf: { sku: { values: [sku] } } }], operator: 'AND' } }, pagination: { limit: '50' }, is_copy_allowed: false }`
  - headers：`x-o3-app-name: seller-ui`, `x-o3-company-id: {companyId}`, `x-o3-page-type: products`
  - `company_id` 来自 `chrome.cookies.getAll({ url: 'https://seller.ozon.ru/', name: 'sc_company_id' })`
- **响应字段**：`variants[].variant_id`、品牌、类目 id、GTIN、图片等基础元数据
- 经 `normalizeSearchVariantToSv` 归一化成 sv 兼容 shape（含 `attributes` 数组）
- **跨域快路**：`opts.allowOzonTab: true` 优先在当前 `www.ozon.ru` tab 内 `executeScript` 注入 fetch（免依赖 seller 专用 tab），失败回退 seller-tab 老路

#### Step 2：`/api/site/seller-prototype/create-bundle-by-variant-id` 补完整 attributes
- **请求**：`POST https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id`
  - body：`{ company_id, variant_id, source: 'SOURCE_UI_COPY_APPAREL' }`
  - 实现：`fetchBundleByVariantId`（[service-worker.js#L542](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L542)）
  - **24h cache**：`chrome.storage.local` key `jz-sw-bundle-v2:{companyId}:{variantId}`，避免每次创建 draft bundle_id
- **响应字段**（`item` 对象）：
  - `weight / depth / width / height`：物理参数（g / mm）
  - `barcode`：GTIN
  - `primary_image / images`：主图 + 图册
  - `attributes[]`：40-63 个完整后台 attr（品牌/类目/材质/包装/...），shape `{ attribute_id, values:[{value, dictionary_value_id}], complex_id }`
  - `description_category_id`：叶子类目 id（用于反查 seller-tree 拿 `description_category_lvl3_name`）

#### Step 2 响应处理（注入 items[0]）
[service-worker.js#L4243-L4326](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L4243)：
- 物理 attr 注入：`weight→4497`、`depth→9454`、`width→9455`、`height→9456`、`barcode→7822`（仅在 items[0].attributes 不存在该 key 时）
- 简单 attr（`complex_id=0`）：转成 `{ key, value | collection }` push 进 `attributes`
- complex attr（`complex_id>0`，即视频/PDF）：收集成 `_bundleComplexAttrs`（跟卖时重建 import 的 complex_attributes）
- 完整 bundle item 挂 `_bundleItem`
- `description_category_id` → `fetchSellerTree(companyId)` → `findCatNameInTree(tree, catId)` → `description_category_lvl3_name`

#### Step 3（降级）：`/api/v1/search` 全平台跟卖列表
若 Step 1 自家目录无果（陌生 SKU），`prefetchSourceVariantWithItems` 再调 `window.sendMessage('searchProductBySku', { sku })`（[L9812](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9812)），SW 侧 [L3984](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L3984) 走同一个 `/api/v1/search` endpoint（但无 bundle 补全），返回 `normalizeSearchVariantToSv` 后的 items。

### 3.3 sv（sourceVariant）写入 item 的字段

`sourceMap.get(String(v.sku))` 拿到 sv 后（[L8900](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8900)），写入 item 的字段：

| item 字段 | sv 来源 |
|-----------|---------|
| `_sourceVariant` | 整个 sv 对象透传给后端 |
| `bundleComplexAttrs` | `sv._bundleComplexAttrs`（视频/PDF complex） |
| `weight/depth/width/height` | `sv.attributes[4497]/[9454]/[9455]/[9456]`（readSourceInt） |
| weight 兜底 | `sv.attributes[4383]`（kg→g，readSourceWeightKgAsG） |
| `images`（兜底 1） | `sv.attributes[4194]`（主图）+ `sv.attributes[4195].collection`（图册） |
| `name`（源真名） | `sv.attributes[4180].value` —— **不被浏览器翻译影响**，翻译检测命中时强制走此路 |
| `description` | `pickFollowSellDescription({ sourceVariant: sv, richContent, ... })` —— 优先 richContent 抽纯文本，退 sv 4191，再退标题 |
| `scraped_brand_value` | `_sourceBrand`（来自 `pageProduct.brand`）传给后端匹配目标类目品牌字典 |
| `scraped_model_name` | `mergeModel`（用户填的型号名） |

### 3.4 类目对齐（锚点强制对齐）
[L8780-L8814](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8780)：
- 锚点 SKU = `pageProduct.sku`（优先）或首个匹配的 SKU
- 非独立商品模式下，所有变体的 `description_category_id` / `categories` / 8229 类型属性强制覆盖成锚点的值（浅克隆，不污染原 sv）
- 独立商品模式（`independentProducts`）跳过

### 3.5 `pickItemForSku` —— 从 items 里挑最纯净变体
[L8614-L8635](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8614)：
- 按 attr 9024（Артикул）以输入 SKU 为前缀匹配
- 多个匹配时，按可变特性 collection 大小（颜色 10096 / 颜色变体 22814 / 材料 8219）升序，选最「纯净」的单色变体
- 避免历史 multi-variant 整合 item 把多色塞进单一变体

---

## 四、PDP page-json API（非锚点变体图册 + 富内容）

### 4.1 `fetchVariantGallery(variantLink)`（[L8751](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8751) → [L9544](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9544)）

**Phase 1**：两个 endpoint 并行试
- `GET /api/entrypoint-api.bx/page/json/v2?url={encodeURIComponent(path)}`
- `GET /api/composer-api.bx/page/json/v2?url={encodeURIComponent(path)}`
- 请求头：`x-o3-app-name: dweb_client`, `accept: application/json`，带 `credentials: 'include'`
- 响应：`{ widgetStates: { ... } }`
  - 扫所有 widgetStates，选 `images` 数组最长的一个作为图册主源
  - 同一份 widgetStates 顺带抽富内容（`jzExtractRichContentFromStates`）

**Phase 2**（富内容兜底）：Phase 1 没抽到富内容时
- 通过 `window.sendMessage('getNuxtState')` 拿当前页 `__NUXT__.state` 的 `sh` / `startPageId`（SW 在 sender tab MAIN world 注入读取，[service-worker.js#L2622](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js#L2622)）
- 拼 innerUrl：`{path}{search}&layout_container=pdpPage2column&layout_page_index=2&sh={sh}&start_page_id={startPageId}`
- `GET /api/entrypoint-api.bx/page/json/v2?url={encodeURIComponent(innerUrl)}`
- 从返回的 widgetStates 抽 `richAnnotationJson`（富内容 JSON 字符串）

### 4.2 写入 item 的字段

| item 字段 | 来源 |
|-----------|------|
| `images`（主路径） | `galleryMap.get(sku)` —— Phase 1 抓到的图册，图片 url 升级 `/wc\d+/` → `/wc1000/` |
| `images`（兜底 1） | `sv.attributes[4194] + [4195].collection` |
| `images`（兜底 2） | `v.coverImage`（来自 `extractAspectVariants` 的 `data.coverImage`） |
| `images`（顺序） | `imageOrder` 设置：`keep` / `shuffle` / `shuffle_keep_first` |
| 富内容 11254 | `richContentMap.get(sku)` —— 注入 `sv.attributes[11254]`（幂等，已有不重复加） |

### 4.3 变体列表本身的来源
`variants` 数组来自 `extractAspectVariants()`（[L651](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L651)）：

1. **页面 state JSON**：遍历所有 `[data-state]` 元素，找含 `aspects` 数组的 JSON
2. **widget data-state**：`[data-widget="webAspects"]` 的 `data-state`
3. **composer-api 缓存**：`window.extractStateData('state-webAspects')`（命中 `ensurePdpState` 预热的 composer-api page json 缓存）

每个 aspect 的 `variants[].data` 含 `title / price / coverImage / link`，按 sku 去重成 `variantMap`。

单轴多值场景（如 38 色）额外走 `jzExpandVariantsViaModal`（[L819](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L819)）：
- 拉 `aspectModalInfo.link`（`/modal/aspectsNew?...`）的 page-json
- 同样走 entrypoint-api / composer-api 两个 endpoint
- 与内联变体按 sku 并集

---

## 五、数据流总览图

```
┌─────────────────────────────────────────────────────────────────────┐
│  Ozon 商品页 (www.ozon.ru/product/xxx-1234567)                       │
│                                                                       │
│  ┌─ DOM / data-state ──────────────────────────────────────────┐    │
│  │  state-webGallery    → images / videos                      │    │
│  │  state-webPrice      → price / cardPrice                    │    │
│  │  state-webBrand      → brand                                │    │
│  │  state-webAspects    → variants[] (sku/title/price/link)    │    │
│  │  state-webDescription→ description (4191)                   │    │
│  │  [data-widget="webHashtags"] → #hashtags                    │    │
│  │  [data-widget="breadCrumbs"] → breadcrumbs                  │    │
│  │  [data-widget="webCharacteristics"] → 物理参数兜底          │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─ page-json API (同源 fetch) ────────────────────────────────┐    │
│  │  GET /api/entrypoint-api.bx/page/json/v2?url={path}         │    │
│  │  GET /api/composer-api.bx/page/json/v2?url={path}           │    │
│  │  → widgetStates → 非锚点变体图册 + 富内容(11254)             │    │
│  │                                                              │    │
│  │  Phase2 富内容兜底:                                          │    │
│  │  GET /api/entrypoint-api.bx/page/json/v2                    │    │
│  │    ?url={path}&layout_container=pdpPage2column              │    │
│  │    &layout_page_index=2&sh={sh}&start_page_id={id}          │    │
│  │  (sh/start_page_id 来自 __NUXT__.state,SW MAIN world 注入)  │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ window.sendMessage(...)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Service Worker (background/service-worker.js)                       │
│                                                                       │
│  ┌─ searchVariants ────────────────────────────────────────────┐    │
│  │  Step1: POST seller.ozon.ru/api/v1/search                   │    │
│  │    body: { company_id, filter: { sku }, ... }                │    │
│  │    → variants[0].variant_id + 基础元数据                    │    │
│  │                                                              │    │
│  │  Step2: POST seller.ozon.ru/api/site/                       │    │
│  │    seller-prototype/create-bundle-by-variant-id             │    │
│  │    body: { company_id, variant_id, source: 'SOURCE_UI_...' }│    │
│  │    → item.weight/depth/width/height/barcode                 │    │
│  │    → item.attributes[] (40-63 个完整后台 attr)              │    │
│  │    → item.description_category_id → seller-tree → leafName  │    │
│  │    (24h chrome.storage.local cache)                         │    │
│  │                                                              │    │
│  │  降级: searchProductBySku → 同 /api/v1/search 无 bundle     │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─ uploadFollowSellVideo ─────────────────────────────────────┐    │
│  │  在 seller.ozon.ru tab MAIN world 注入:                     │    │
│  │  fetch(srcUrl) → blob                                       │    │
│  │  POST seller.ozon.ru/api/media-storage/upload-file           │    │
│  │    (multipart, x-o3-company-id, cookie)                     │    │
│  │  → { url } 转存后的卖家自有 Ozon 视频                       │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─ getNuxtState ──────────────────────────────────────────────┐    │
│  │  chrome.scripting.executeScript MAIN world                  │    │
│  │  读 window.__NUXT__.state.pageInfo.url / requestID          │    │
│  │  → { sh, startPageId } 给 Phase2 富内容兜底用               │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ 返回 content script
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  content/ozon-product.js handleMultiVariantFollowSell                │
│                                                                       │
│  items[] 组装:                                                        │
│    offer_id  ← UI .ozon-helper-mv-offerid                            │
│    name      ← sv.attributes[4180] (翻译检测) > DOM > v.title        │
│    price     ← UI .ozon-helper-mv-price                              │
│    old_price ← UI .ozon-helper-mv-oldprice (空则 price×1.25)         │
│    images    ← galleryMap(非锚点) / pageProduct.images(锚点)         │
│              / sv[4194]+[4195] / v.coverImage                        │
│    weight    ← UI > sv[4497] > sv[4383]×1000 > undefined             │
│    depth/width/height ← UI > sv[9454/9455/9456] > undefined          │
│    scraped_* ← pageScrapedDims (extractCharacteristics)              │
│    videoUrl  ← sharedVideo (captureAndTransferPageVideoMedia)        │
│    bundleComplexAttrs ← sv._bundleComplexAttrs / sharedBundleComplex │
│    scraped_breadcrumbs ← extractBreadcrumbs()                        │
│    scraped_description ← pickFollowSellDescription(sv, richContent)  │
│    _aiHashtags ← extractKeywords()                                   │
│    scraped_brand ← UI brandChoice                                     │
│    scraped_brand_value ← pageProduct.brand (复制当前品牌时)          │
│    _sourceVariant ← sv (整个对象透传)                                 │
│    _stock ← UI .ozon-helper-mv-stock                                 │
│                                                                       │
│  顶层 payload:                                                        │
│    storeId / stocks (warehouse_id 解析) / applyWatermark /           │
│    watermarkTemplateId / applyPoster / applyAiRewrite /              │
│    viaPortal / randomColor / customDescription / listingType / ...   │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ window.sendMessage('followSell', { storeId, items, ... })
                              ▼
                       后端 worker 异步执行 import
```

---

## 六、关键字段来源速查表

| item 字段 | 一级来源 | 二级兜底 | 三级兜底 | 后端最终消费 |
|-----------|----------|----------|----------|-------------|
| `offer_id` | UI 输入 | `SKU{sku}-{Date末4位}` | — | Ozon import offer_id |
| `name` | `sv.attributes[4180]`（翻译检测命中时强制） | DOM `.ozon-helper-mv-variant-title-text` | `v.title` | Ozon import name（≤200） |
| `price` | UI `.ozon-helper-mv-price` | — | — | Ozon import price |
| `old_price` | UI `.ozon-helper-mv-oldprice` | `price × 1.25` | — | Ozon import old_price |
| `min_price` | UI `.ozon-helper-mv-minprice`（>0 才发） | — | — | Ozon import min_price |
| `images` | `galleryMap`（page-json Phase1） | `sv[4194]+[4195]` | `v.coverImage` | Ozon import images |
| `weight` | UI `.ozon-helper-mv-weight` | `sv[4497]` | `sv[4383]×1000` | Ozon import weight（g） |
| `depth/width/height` | UI `.ozon-helper-mv-{depth,width,height}` | `sv[9454/9455/9456]` | — | Ozon import dimensions（mm） |
| `scraped_weight/depth/width/height` | `extractCharacteristics` + `parseScrapedDimensionsFromCharacteristics` | — | — | 后端兜底链 |
| `videoUrl` | `captureAndTransferPageVideoMedia`（PDP `.mp4` → SW 转存） | — | — | 后端 `injectUserVideoComplexAttribute` |
| `videoCover` | 同上 | — | — | 视频封面槽 |
| `bundleComplexAttrs` | `sv._bundleComplexAttrs`（bundle API complex attr） | `sharedBundleComplex`（锚点 sv 兜底） | — | 后端重建 complex_attributes |
| `scraped_breadcrumbs` | `extractBreadcrumbs()`（state → DOM） | — | — | 后端 `findCategoryByBreadcrumbs` |
| `scraped_description` | `pickFollowSellDescription(sv, richContent)` | 标题 | — | Ozon import description（4191） |
| `_aiHashtags` | `extractKeywords()`（`[data-widget="webHashtags"]`） | `[data-widget="tagList"]` | — | 后端 `buildHashtagValues` → attr 23171 |
| `scraped_brand` | UI `[data-field="brand"]` | `'no_brand'` | — | 后端品牌匹配 |
| `scraped_brand_value` | `pageProduct.brand`（复制当前品牌时） | — | — | 后端匹配目标类目品牌字典 |
| `scraped_model_name` | UI `[data-field="merge-model"]` | — | — | Ozon attr 9048 型号 |
| `_sourceVariant` | `searchVariants` 返回的 sv（含 bundle 注入的物理 attr + complex attr） | `searchProductBySku` 降级 | — | 后端 `resolveViaSearchVariantModel` 全字段兜底链 |
| `_stock` | UI `.ozon-helper-mv-stock` | — | — | 后端 import stocks（需 warehouse_id） |
| 富内容 11254 | `richContentMap`（page-json Phase1/Phase2） | — | — | 注入 `sv.attributes[11254]` → 后端 `pickSourceRichContent` |

---

## 七、关键设计要点

### 7.1 翻译污染防护
- `name` 优先取 `sv.attributes[4180]`（seller portal API JSON，不被 Chrome 翻译影响）
- 翻译检测：DOM 含中文 && sv 不含中文 → 强制走 sv 4180
- `breadcrumbs` 翻译态直接返空（避免中文匹配俄文类目树失败）
- `extractProductData` 的 h1 兜底在翻译态跳过

### 7.2 类目对齐
- 非独立商品模式：所有变体强制对齐到锚点 sv 的 `description_category_id` / `categories` / 8229 类型属性
- 独立商品模式（「跟卖本页商品卡」）：各 SKU 保留自身源类目，不对齐

### 7.3 物理参数严格解析
- `parseStrictNumber` 只接受纯数字串（允许俄式逗号），带单位的 `"1.2kg"` 返回 NaN
- 让后端 `parseWeightToGrams` / `parseDimToMm` 自己做单位识别
- 避免前端送 `weight=1` 给 `"1.2kg"` 被 backend 当 1g 采纳

### 7.4 图片顺序
- `keep`：原序
- `shuffle`：全打乱
- `shuffle_keep_first`：首图固定，其余打乱

### 7.5 视频两条互补路径
1. `bundleComplexAttrs`：bundle API 返回的视频/PDF complex —— 仅自有商品复制时有，跟卖竞品恒空
2. `videoUrl`：PDP gallery 抓的公开 `.mp4` —— 跟卖竞品时唯一能拿到视频的来源，经 SW 转存成卖家自有 Ozon 视频

### 7.6 仓库 ID 解析
- 优先级：`panel._selectedWarehouseByStore`（已选）> 当前 UI 选择（仅当前 store）> `ts.warehouseId`（模板）> 该 store 仓库列表第一个
- 仓库 ID 不跨店通用，禁止把前一个店铺的 UI 值套到另一个店铺
