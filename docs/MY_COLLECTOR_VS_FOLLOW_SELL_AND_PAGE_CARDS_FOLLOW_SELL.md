# MY 采集器数据 vs 跟卖所需数据对比 + 跟卖本页商品卡功能分析

> 落地路径：`c:\root\code\ozon-my\docs\MY_COLLECTOR_VS_FOLLOW_SELL_AND_PAGE_CARDS_FOLLOW_SELL.md`
> 关联文档：
> - [MY_COLLECTOR_DATA_SOURCES.md](file:///c:/root/code/ozon-my/docs/MY_COLLECTOR_DATA_SOURCES.md)（采集器数据来源）
> - [FOLLOW_SELL_DATA_SOURCES.md](file:///c:/root/code/ozon-my/docs/FOLLOW_SELL_DATA_SOURCES.md)（PDP 多变体跟卖数据来源）

---

# 第一部分：MY 采集器采集到的数据是否足以做一键跟卖

## 一、结论

**部分足够，但不足以直接完成完整跟卖。**

- **最小可行跟卖**（单 SKU，无视频/富内容/多变体）：**可行** —— 采集器的 `sale record.raw.preFetched.variant` 已存了 `searchVariants` 完整 settled 结果，配合用户填价即可。
- **完整跟卖**（带视频/富内容/hashtags/多变体）：**不可行** —— 采集器只在搜索/类目页运行，缺 3 项 PDP-only 数据源，必须跳 PDP 补抓。

现有架构正是这么做的：搜索页卡片"一键跟卖"按钮打开 `info.url + '#jz-follow-sell'`（[ozon-search.js#L458](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-search.js#L458)），在 PDP 上下文里由 `handleMultiVariantFollowSell` 补抓缺失数据。

## 二、采集器已覆盖的跟卖字段（约 40-50%，核心 catalog）

采集器的 `sale record.raw.preFetched.variant` 存了 `searchVariants` 的完整 settled 结果，这正是跟卖最关键的 **`_sourceVariant`**。从中可提取：

| 跟卖字段 | 采集器来源 |
|---------|-----------|
| `_sourceVariant` | `raw.preFetched.variant.value.items[0]`（完整 sv item，含 bundle 注入的物理 attr + complex attr） |
| `name` | sv attr 4180（翻译不污染） |
| `images` | sv attr 4194（主图）+ 4195 collection（图册） |
| `weight` | sv attr 4497（g）/ 4383（kg） |
| `depth` / `width` / `height` | sv attr 9454 / 9455 / 9456 |
| `bundleComplexAttrs` | `sv._bundleComplexAttrs`（视频/PDF complex attr） |
| `scraped_brand_value` | `brandName`（sv attr 85） |
| `sku` / `url` | 直接有 |

## 三、需用户在跟卖面板填写（采集器无法替代）

| 跟卖字段 | 说明 |
|---------|------|
| `price` / `old_price` / `min_price` | 跟卖自己的售价（不是源商品价） |
| `_stock` | 库存 |
| `offer_id` | 可自动生成 `SKU{sku}-{Date末4位}` |
| `brandChoice` / `imageOrder` / `mergeModel` / `applyWatermark` 等 | 上架策略选项 |

## 四、采集器完全缺失（必须额外请求）

采集器只在**搜索/类目页**运行，以下数据需要**跳转 PDP** 或调 **page-json API** 才能拿到：

| 跟卖字段 | 缺失原因 | 补抓方式 |
|---------|---------|---------|
| `scraped_breadcrumbs` | 搜索页无面包屑 | PDP `extractBreadcrumbs()` |
| `sharedHashtags` | 搜索页无 `[data-widget="webHashtags"]` | PDP DOM |
| `sharedVideo` + 转存 | 搜索页无 PDP gallery 视频 | PDP `.mp4` → SW `uploadFollowSellVideo` 转存 |
| `pageScrapedDims` | 采集器的 weight 来自 sv attr，不是 PDP characteristics | PDP `extractCharacteristics` |
| 富内容 11254 | 采集器未调 page-json | `fetchVariantGallery` Phase1/Phase2 |
| 非锚点变体图册 | 采集器只采单卡 | `fetchVariantGallery` |
| `variants` 数组（同 model 其他变体） | 搜索页每卡独立 | PDP `extractAspectVariants` |

## 五、可行性分级

### 最小可行跟卖（单 SKU，无视频/富内容/多变体）

**采集器数据 + 用户填表 → 可行**

- 后端 `resolveViaSearchVariantModel` 能用 `_sourceVariant` 兜底大部分字段
- breadcrumbs 缺失 → 后端 `findCategoryByBreadcrumbs` 失败，但 sv 有 `description_category_id` 可走 seller-tree 反查
- hashtags / 视频 / 富内容缺失不影响 import 成功（只是少主题标签/视频/富文本描述）

### 完整跟卖（带视频/富内容/多变体）

**采集器数据不够，必须跳 PDP 补抓**

需补 3 个 PDP-only 数据源：

1. **page-json API**（`/api/entrypoint-api.bx/page/json/v2`）→ 富内容 11254 + 非锚点变体图册
2. **PDP DOM state**（`webHashtags` / `webCharacteristics` / `breadCrumbs`）→ hashtags / 物理参数兜底 / 类目面包屑
3. **PDP gallery 视频**（`.mp4` 直链）→ 经 SW 转存成卖家自有 Ozon 视频

## 六、关键差距对照表

| 维度 | 采集器（搜索页） | 跟卖所需 | 差距 |
|------|---------------|---------|------|
| `_sourceVariant` | ✅ 有（preFetched.variant） | ✅ 需要 | 无 |
| `name`/`images`/`weight`/物理 | ✅ 有（sv attr） | ✅ 需要 | 无 |
| `price`/`stock`/`offer_id` | ❌ 无（源商品价非跟卖价） | ✅ 需要 | 用户填表 |
| `breadcrumbs` | ❌ 搜索页无 | ✅ 需要 | 跳 PDP |
| `hashtags` | ❌ 搜索页无 | ⚠️ 可选 | 跳 PDP |
| 视频 | ❌ 搜索页无 | ⚠️ 可选 | 跳 PDP + SW 转存 |
| 富内容 11254 | ❌ 未调 page-json | ⚠️ 可选 | 跳 PDP page-json |
| 非锚点变体图册 | ❌ 单卡采集 | ⚠️ 可选 | 跳 PDP page-json |
| 同 model 其他变体 | ❌ 每卡独立 | ⚠️ 多变体需要 | 跳 PDP `extractAspectVariants` |

## 七、建议

如果要做"从采集器桶直接批量跟卖"，建议走**最小可行路径**：用采集器的 `_sourceVariant` + 用户预设的 price/stock 模板，牺牲视频/富内容/hashtags，换取批量自动化。完整跟卖仍需逐个跳 PDP。

---

# 第二部分：跟卖本页商品卡功能分析

## 八、功能定位

「跟卖本页商品卡」是 Ozon **列表页**（搜索/类目/卖家/品牌页）上的批量跟卖入口，位于精简浮窗 `createSlimActionBar`（[ozon-product.js#L2191](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L2191)）。

**与 PDP 多变体跟卖的区别**：

| 维度 | 跟卖本页商品卡（列表页） | PDP 多变体跟卖（详情页） |
|------|----------------------|----------------------|
| 触发位置 | 列表页精简浮窗「跟卖本页商品卡」按钮 | PDP action bar「一键上架至OZON」 |
| 数据源页面 | 列表页（搜索/类目/卖家/品牌） | 商品详情页 |
| 商品关系 | **独立商品**（`independentProducts: true`）| 同一 listing 的兄弟变体 |
| 类目对齐 | 跳过（各 SKU 保留自身源类目） | 强制对齐到锚点 SKU 类目 |
| 视频/PDF complex 共享 | 不共享（各卡片无关） | 共享（listing 级） |
| 页面视频转存 | 跳过（列表页无 PDP 视频） | 执行 |
| 页面级物理参数兜底 | 跳过（列表页 characteristics 不对应单一商品） | 执行 |
| hashtags 共享 | 不共享（列表页无 webHashtags） | 共享 |
| 图册来源 | sv attr 4194/4195 + coverImage + `fetchVariantGallery` | 同左 + pageProduct.images（锚点） |

## 九、功能框架

### 9.1 入口与触发

**入口**：列表页精简浮窗「跟卖本页商品卡」按钮（[ozon-product.js#L2214](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L2214)）

**触发函数**：`followSellCurrentPageCards(btn)`（[ozon-product.js#L2300](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L2300)）

**流程**：
1. `scanListingCards()` 扫描当前列表页所有商品卡 → `[{ sku, name, image, price, priceCny, priceCurrency, priceRub, url }]`
2. 转成跟卖面板的 `variants` 数组（每个卡片 = 一行）
3. `createMultiVariantFollowSellPanel(variants, null, { independentProducts: true })` 打开面板
4. 面板背景异步拉每个 SKU 的源数据填充三维/重量/属性
5. 用户填价后点「一键上架至OZON」→ `handleMultiVariantFollowSell` 提交

### 9.2 文件职责

| 文件 | 职责 |
|------|------|
| [ozon-product.js](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js) | 入口 + 扫描 + 面板 + 数据组装 + 提交 |
| [service-worker.js](file:///c:/root/code/ozon-my/qx-ozon/background/service-worker.js) | `searchVariants` / `searchProductBySku` / `followSell` / `getWarehouses` |
| [shared-utils.js](file:///c:/root/code/ozon-my/qx-ozon/content/shared-utils.js) | `jzExtractCatalogFromSv` / 货币换算辅助 |

### 9.3 核心数据流

```
┌─────────────────────────────────────────────────────────────┐
│ 列表页 (www.ozon.ru/search|category|seller|brand)             │
│                                                              │
│  scanListingCards() 扫描商品卡                                │
│     │ DOM 抽 sku/name/image/price/url                         │
│     │ _detectCurrencyFromPriceStr + _rubToCny 换算            │
│     ▼                                                        │
│  variants[] = [{ sku, title, price, priceCny, coverImage, link, ... }]│
│     │                                                        │
│     ▼ createMultiVariantFollowSellPanel(variants, null, {independentProducts:true})│
│  面板打开,用户勾选卡片 + 填价                                  │
│     │                                                        │
│     ▼ 点「一键上架至OZON」                                      │
│  handleMultiVariantFollowSell(panel)                          │
│     │                                                        │
│     ├─ ① prefetchSourceVariantWithItems 首个 SKU gate check   │
│     │     └→ searchVariants → seller.ozon.ru /search + bundle │
│     │                                                        │
│     ├─ ② 批量预取剩余 SKU (BATCH_SIZE=3 并发)                  │
│     │     ├→ searchVariants (sv 命中)                         │
│     │     └→ searchProductBySku (sv 未命中降级,陌生 SKU)       │
│     │                                                        │
│     ├─ ③ fetchVariantGallery 并行抓每个变体图册 + 富内容        │
│     │     └→ /api/entrypoint-api.bx/page/json/v2              │
│     │     └→ /api/composer-api.bx/page/json/v2                │
│     │                                                        │
│     ├─ ④ independentProducts 跳过:                            │
│     │     - 类目对齐 (各 SKU 保留自身源类目)                   │
│     │     - sharedBundleComplex (不共享视频/PDF)               │
│     │     - sharedVideo (不转存 PDP 视频)                      │
│     │     - pageScrapedDims (不取页面级物理参数)               │
│     │     - sharedHashtags (列表页无 webHashtags)              │
│     │                                                        │
│     ├─ ⑤ 组装 items[] (每个 SKU 一条)                         │
│     │                                                        │
│     └─ ⑥ Promise.allSettled 多店并行提交                      │
│           └→ window.sendMessage('followSell', { storeId, items, stocks })│
│                └→ SW → 后端 worker → Ozon import              │
└─────────────────────────────────────────────────────────────┘
```

### 9.4 independentProducts 模式特殊处理

`independentProducts: true`（[ozon-product.js#L2321](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L2321)）下，与 PDP 多变体跟卖的差异（[ozon-product.js#L8787-L8865](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8787-L8865)）：

| 步骤 | PDP 多变体 | 跟卖本页商品卡 |
|------|-----------|--------------|
| 类目对齐 | 强制对齐到锚点 sv 的 `description_category_id` / `categories` / 8229 | **跳过**，各 SKU 保留自身源类目 |
| `sharedBundleComplex` | 从锚点 sv 取，listing 级共享 | **null**，各 SKU 只用自己的 `_bundleComplexAttrs` |
| `sharedVideo` | `captureAndTransferPageVideoMedia` 转存 PDP `.mp4` | **跳过**，列表页无 PDP 视频 |
| `pageScrapedDims` | `extractCharacteristics` + `parseScrapedDimensionsFromCharacteristics` | **{}**，列表页 characteristics 不对应单一商品 |
| `sharedHashtags` | `extractKeywords()` 从 `[data-widget="webHashtags"]` 抽 | **空**（列表页无此 widget） |
| `breadcrumbs` | `extractBreadcrumbs()` | **空**（列表页无面包屑） |

---

## 十、数据来源逐一分析

「跟卖本页商品卡」每个 item 的字段来自 **4 类数据源**：

| 代号 | 来源类型 | 页面/端点 | 用途 |
|------|---------|----------|------|
| **A. 列表页 DOM** | 商品卡元素 | `www.ozon.ru/search|category|seller|brand` | sku/name/image/price/url |
| **B. Seller Portal API** | seller.ozon.ru 内部接口 | `/api/v1/search` + `/create-bundle-by-variant-id` | _sourceVariant（品牌/类目/属性/物理参数/图册/bundle 视频 PDF） |
| **C. PDP page-json API** | Ozon 公开 BFF | `/api/entrypoint-api.bx/page/json/v2` + `/api/composer-api.bx/page/json/v2` | 非锚点变体图册 + 富内容(11254) |
| **D. UI 表单输入** | 用户在跟卖面板填写 | `.ozon-helper-mv-*` 输入控件 | price/old_price/min_price/stock/offer_id/weight/depth/width/height |

> **注意**：与 PDP 多变体跟卖相比，**缺少 PDP DOM state 数据源**（breadcrumbs / webHashtags / webCharacteristics / webGallery 视频），因为列表页没有这些元素。

---

### 10.1 来源 A：列表页 DOM 元素

**页面**：`https://www.ozon.ru/search/*`、`/category/*`、`/seller/*`、`/brand/*`

**触发函数**：`scanListingCards()`（[ozon-product.js#L2248-L2295](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L2248-L2295)）

#### 10.1.1 卡片选择器

```js
const SELECTORS = [
  '.tile-root',
  '[data-widget="searchResultsV2"] [data-widget="searchResultsItem"]',
  '[data-widget="searchResults"] [data-widget="searchResultsItem"]',
];
```

按 SKU 去重（`seen.has(sku)`）。

#### 10.1.2 抽取的字段

| 字段 | DOM 元素 | 选择器 / 提取方式 | 备注 |
|------|---------|------------------|------|
| `sku` | `<a>` 链接 href | `href.match(/\/product\/[^?#]*?-(\d{5,})/)[1]` | URL 末尾数字段 |
| `name` | `<a aria-label>` / `<img alt>` / `<a> textContent` | 三级优先级，截断 80 字符 | 与采集器 extractCardInfo 同口径 |
| `image` | `<img>` | `img.src` | 主图 |
| `price` | `<span>` 叶子节点 | `Array.from(card.querySelectorAll('span')).find(el => el.children.length === 0 && /\d/.test(text) && /[₽¥₸]/.test(text))` | 取第一个含币种符号且带数字的叶子 span |
| `url` | `<a>` 链接 | `href.startsWith('http') ? href : 'https://' + location.host + href` | 绝对 URL |

#### 10.1.3 货币换算（[ozon-product.js#L2278-L2290](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L2278-L2290)）

跟卖面板「原售价」按 **CNY** 计价（跨境店），与单品跟卖口径一致：

```js
const cur = _detectCurrencyFromPriceStr(price);  // 从 ₽/¥/₸/Br/$/€ 符号识别
const num = window.normalizePrice(price);
const isRub = cur === 'RUB';
priceCny = isRub ? _rubToCny(num) : num;          // RUB → CNY 换算
priceCurrency = isRub ? 'CNY' : cur || 'CNY';
priceRub = isRub ? num : 0;
```

**`_rubToCny`**（[ozon-product.js#L140-L144](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L140-L144)）：`Math.round((rub / _jzFxCnyToRub) * 100) / 100`

**`_detectCurrencyFromPriceStr`**（[ozon-product.js#L157-L165](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L157-L165)）：

| 符号 | 币种 |
|------|------|
| `₽` / `RUB` | RUB |
| `¥` / `CNY` | CNY |
| `₸` / `KZT` | KZT |
| `Br` / `BYN` | BYN |
| `$` / `USD` | USD |
| `€` / `EUR` | EUR |

> CNY 本身 / KZT 等无 FX rate 的币种不强转。

#### 10.1.4 转成 variants 数组（[ozon-product.js#L2307-L2318](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L2307-L2318)）

```js
const variants = cards.map((c) => ({
  sku: c.sku,
  title: c.name || `SKU ${c.sku}`,
  price: c.priceCny || 0,
  priceCurrency: c.priceCurrency || 'CNY',
  priceRub: c.priceRub || 0,
  coverImage: c.image || '',
  link: c.url,
  availability: true,
  active: true,
  aspectValues: {},
}));
```

---

### 10.2 来源 B：Seller Portal API（_sourceVariant —— 跟卖核心数据）

面板打开后，背景异步拉每个 SKU 的源数据。与 PDP 多变体跟卖**完全共用**同一套 `searchVariants` 流程。

#### 10.2.1 prefetchSourceVariantWithItems（首个 SKU gate check）

[ozon-product.js#L8639](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8639)

调 `window.sendMessage('searchVariants', { sku: firstSku })`，SW 侧两步走：

**Step 1**：`POST https://seller.ozon.ru/api/v1/search`

请求体：
```json
{
  "company_id": "<sc_company_id>",
  "need_total": true,
  "filter": { "children_nodes": { "children_nodes": [{ "input_leaf": { "sku": { "values": ["<sku>"] } } }], "operator": "AND" } },
  "pagination": { "limit": "50" },
  "is_copy_allowed": false
}
```

响应：`variants[].variant_id` + 基础元数据，经 `normalizeSearchVariantToSv` 转成 sv item。

**Step 2**：`POST https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id`

请求体含 `variant_id` + `company_id`，24h cache。响应字段注入 sv item：

| 响应字段 | 注入 sv attr key |
|---------|-----------------|
| `bundleItem.weight` | 4497（重量 g） |
| `bundleItem.depth` | 9454（长 mm） |
| `bundleItem.width` | 9455（宽 mm） |
| `bundleItem.height` | 9456（高 mm） |
| `bundleItem.barcode` | 7822（GTIN） |
| `bundleItem.attributes[]`（simple） | 各业务 attr key |
| `bundleItem.attributes[]`（complex） | `_bundleComplexAttrs`（视频/PDF） |

#### 10.2.2 批量预取剩余 SKU（[ozon-product.js#L8670-L8713](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8670-L8713)）

`BATCH_SIZE=3` 并发，每个 SKU：

1. `searchVariants`（sv 命中）→ `pickItemForSku(items, sku)` 选最纯净变体
2. sv 未命中 → `searchProductBySku` 降级（`/api/v1/search` 全平台，无 bundle 补全）
3. 命中入 `sourceMap.set(sku, picked)`，未命中入 `skipped`

**`pickItemForSku`**（[ozon-product.js#L8614-L8635](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8614-L8635)）：
- 按 attr 9024（Артикул）以输入 SKU 为前缀匹配
- 多个匹配时，按可变特性 collection 大小（颜色 10096 / 颜色变体 22814 / 材料 8219）升序，选最「纯净」的单色变体

#### 10.2.3 sv 写入 item 的字段

| item 字段 | sv 来源 |
|-----------|---------|
| `_sourceVariant` | 整个 sv 对象透传给后端 |
| `bundleComplexAttrs` | `sv._bundleComplexAttrs`（视频/PDF complex，独立商品模式不共享） |
| `weight` | `sv.attributes[4497]`（readSourceInt） |
| weight 兜底 | `sv.attributes[4383]`（kg→g，readSourceWeightKgAsG） |
| `depth` / `width` / `height` | `sv.attributes[9454]` / `[9455]` / `[9456]` |
| `images`（兜底 1） | `sv.attributes[4194]`（主图）+ `sv.attributes[4195].collection`（图册） |
| `name`（源真名） | `sv.attributes[4180].value` —— 翻译检测命中时强制走此路 |
| `description` | `pickFollowSellDescription({ sourceVariant: sv, richContent, ... })` |
| `scraped_brand_value` | `sv.attributes[85]`（品牌） |

---

### 10.3 来源 C：PDP page-json API（非锚点变体图册 + 富内容）

#### 10.3.1 fetchVariantGallery（[ozon-product.js#L8751](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8751) → [L9544](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9544)）

并行抓每个变体的完整图册 + 富内容（[ozon-product.js#L8730-L8755](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8730-L8755)）。

**Phase 1**：两个 endpoint 并行试
- `GET /api/entrypoint-api.bx/page/json/v2?url={encodeURIComponent(v.link)}`
- `GET /api/composer-api.bx/page/json/v2?url={encodeURIComponent(v.link)}`

请求头：`x-o3-app-name: dweb_client`, `accept: application/json`，`credentials: 'include'`

响应：`{ widgetStates: { ... } }`
- 扫所有 widgetStates，选 `images` 数组最长的一个作为图册主源
- 同一份 widgetStates 顺带抽富内容（`jzExtractRichContentFromStates`）

**Phase 2**（富内容兜底）：Phase 1 没抽到富内容时
- 通过 `window.sendMessage('getNuxtState')` 拿当前页 `__NUXT__.state` 的 `sh` / `startPageId`
- 拼 innerUrl：`{path}{search}&layout_container=pdpPage2column&layout_page_index=2&sh={sh}&start_page_id={startPageId}`
- `GET /api/entrypoint-api.bx/page/json/v2?url={encodeURIComponent(innerUrl)}`
- 从返回的 widgetStates 抽 `richAnnotationJson`（富内容 JSON 字符串）

#### 10.3.2 写入 item 的字段

| item 字段 | 来源 | 优先级 |
|-----------|------|--------|
| `images`（主路径） | `galleryMap.get(sku)` —— Phase 1 抓到的图册，图片 url 升级 `/wc\d+/` → `/wc1000/` | 主 |
| `images`（兜底 1） | `sv.attributes[4194] + [4195].collection` | sv |
| `images`（兜底 2） | `v.coverImage`（来自 scanListingCards 的 `c.image`） | coverImage |
| 富内容 11254 | `richContentMap.get(sku)` —— 注入 `sv.attributes[11254]`（幂等，已有不重复加） | 主 |

**imageSource 标记**（[ozon-product.js#L8972-L8990](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8972-L8990)）：
- `pageState`：galleryMap 命中
- `sourceVariant`：sv attr 4194/4195 命中
- `coverImage`：仅 coverImage
- `none`：无图

**图片顺序**（`imageOrder` 设置）：
- `keep`：原序
- `shuffle`：全打乱
- `shuffle_keep_first`：首图固定，其余打乱

---

### 10.4 来源 D：UI 表单输入（用户填写）

来源：跟卖面板表格行 `.ozon-helper-mv-*` 输入控件（[ozon-product.js#L8885-L8896](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8885-L8896)）。

| item 字段 | DOM 选择器 | 说明 |
|-----------|------------|------|
| `price` | `.ozon-helper-mv-price` | 售价，经 `window.normalizePrice` |
| `old_price` | `.ozon-helper-mv-oldprice` | 划线价，空则 `price × (panel._erpConfig.old_price_ratio ?? 1.25)` |
| `min_price` | `.ozon-helper-mv-minprice` | Ozon 自动调价下限，留空/≤0 不发 |
| `_stock` | `.ozon-helper-mv-stock` | 库存，`parseInt` |
| `offer_id` | `.ozon-helper-mv-offerid` | 卖家自定义货号，空则 `SKU{sku}-{Date末4位}` |
| `weight` | `.ozon-helper-mv-weight` | 用户输入重量，`parseStrictNumber` 严格只接受纯数字串 |
| `depth` / `width` / `height` | `.ozon-helper-mv-{depth,width,height}` | 用户输入尺寸 |

**物理参数取值优先级**（[ozon-product.js#L8947-L8951](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8947-L8951)）：
```
weight = userWeight || readSourceInt('4497') || readSourceWeightKgAsG() || undefined
depth   = userDepth  || readSourceInt('9454') || undefined
width   = userWidth  || readSourceInt('9455') || undefined
height  = userHeight || readSourceInt('9456') || undefined
```
即 **用户输入 > 源 sv attr > undefined（让后端兜底）**。

**`parseStrictNumber`**（[ozon-product.js#L8917-L8922](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L8917-L8922)）：严格只接受纯数字串（允许俄式逗号 `"0,05"` 转点）。带单位的 `"1.2kg"` / `"10 cm"` 一律返回 NaN，让 backend 走 `_sourceVariant.attributes` 路径自己做单位识别。

#### 10.4.1 面板顶层选项（不进 items，作为 payload 字段与 items 一起发）

| 选项 | DOM 选择器 | 说明 |
|------|------------|------|
| `brandChoice` | `[data-field="brand"]` | 品牌选择：`copy`（复制当前品牌）/ `no_brand` / 指定品牌 |
| `imageOrder` | `[data-field="image-order"]` | 图片顺序：`keep` / `shuffle` / `shuffle_keep_first` |
| `mergeModel` | `[data-field="merge-model"]` | 型号名（留空 = 各自独立成卡） |
| `currencyCode` | `[data-field="currency"]` | 币种 |
| `applyWatermark` / `watermarkTemplateId` / `applyPoster` / `applyAiRewrite` | 对应 checkbox/select | 水印/海报/AI 重写 |
| `customDescription` | `[data-field="custom-description"]` | 自定义描述 |
| `listingType` | 模板配置 | 上架类型 |
| `uploadMode` | `input[name="jz-upload-mode"]:checked` | `api`（官方 import）/ `portal`（模拟手动上架，需 flag 开） |

---

## 十一、items[] 完整字段组装（[ozon-product.js#L9049-L9095](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9049-L9095)）

```js
items.push({
  offer_id,                    // D. UI 输入 / 自动生成
  name: variantName,           // B. sv[4180] > D. DOM > v.title
  price: price.toFixed(2),     // D. UI 输入
  old_price: oldPrice.toFixed(2), // D. UI 输入 / price×1.25
  ...(minPrice != null ? { min_price: minPrice.toFixed(2) } : {}), // D. UI 输入
  vat: '0',
  currency_code: currencyCode, // D. 面板选项
  images: productImages,       // C. galleryMap > B. sv[4194]+[4195] > A. coverImage
  bundleComplexAttrs,          // B. sv._bundleComplexAttrs（独立模式不共享）
  ...(sharedVideo?.url ? { videoUrl: sharedVideo.url } : {}),   // 独立模式恒空
  ...(sharedVideo?.cover ? { videoCover: sharedVideo.cover } : {}), // 独立模式恒空
  scraped_breadcrumbs: breadcrumbs, // 独立模式恒空（列表页无面包屑）
  scraped_description: description, // B. pickFollowSellDescription(sv, richContent)
  ...(sharedHashtags.length > 0 ? { _aiHashtags: sharedHashtags } : {}), // 独立模式恒空
  scraped_sku: String(v.sku),  // A. DOM URL 正则
  scraped_brand: brandChoice,  // D. 面板选项
  scraped_brand_value,         // B. sv[85]（brandChoice==='copy' 时）
  scraped_model_name: mergeModel ? safeText(mergeModel, NAME_MAX) : undefined, // D. 面板选项
  _sourceVariant: sv || undefined, // B. searchVariants 返回的 sv
  weight, weight_unit,         // D. UI > B. sv[4497] > sv[4383]×1000 > undefined
  depth, width, height, dimension_unit, // D. UI > B. sv[9454/9455/9456] > undefined
  scraped_weight/depth/width/height, // 独立模式恒空（列表页无 characteristics）
  _stock,                      // D. UI 输入
});
```

---

## 十二、关键字段 → 数据来源完整映射表

| item 字段 | 一级来源 | 二级兜底 | 三级兜底 | 独立模式特殊 |
|-----------|----------|----------|----------|-------------|
| `offer_id` | D. UI `.ozon-helper-mv-offerid` | `SKU{sku}-{Date末4位}` | — | — |
| `name` | B. `sv.attributes[4180]`（翻译检测命中时强制） | D. DOM `.ozon-helper-mv-variant-title-text` | A. `v.title` | — |
| `price` | D. UI `.ozon-helper-mv-price` | — | — | — |
| `old_price` | D. UI `.ozon-helper-mv-oldprice` | `price × 1.25` | — | — |
| `min_price` | D. UI `.ozon-helper-mv-minprice`（>0 才发） | — | — | — |
| `images` | C. `galleryMap`（page-json Phase1） | B. `sv[4194]+[4195]` | A. `v.coverImage` | — |
| `weight` | D. UI `.ozon-helper-mv-weight` | B. `sv[4497]` | B. `sv[4383]×1000` | — |
| `depth/width/height` | D. UI `.ozon-helper-mv-{depth,width,height}` | B. `sv[9454/9455/9456]` | — | — |
| `scraped_weight/depth/width/height` | — | — | — | **恒空**（列表页无 characteristics） |
| `videoUrl` / `videoCover` | — | — | — | **恒空**（列表页无 PDP 视频） |
| `bundleComplexAttrs` | B. `sv._bundleComplexAttrs` | — | — | **不共享**（各 SKU 自己的） |
| `scraped_breadcrumbs` | — | — | — | **恒空**（列表页无面包屑） |
| `scraped_description` | B. `pickFollowSellDescription(sv, richContent)` | C. richContent 抽纯文本 | 标题 | — |
| `_aiHashtags` | — | — | — | **恒空**（列表页无 webHashtags） |
| `scraped_brand` | D. UI `[data-field="brand"]` | `'no_brand'` | — | — |
| `scraped_brand_value` | B. `sv[85]`（brandChoice==='copy' 时） | — | — | — |
| `scraped_model_name` | D. UI `[data-field="merge-model"]` | — | — | 留空 = 各自独立成卡 |
| `_sourceVariant` | B. `searchVariants` 返回的 sv | B. `searchProductBySku` 降级 | — | — |
| `_stock` | D. UI `.ozon-helper-mv-stock` | — | — | — |
| 富内容 11254 | C. `richContentMap`（page-json Phase1/Phase2） | — | — | 注入 `sv.attributes[11254]` |
| `scraped_sku` | A. DOM URL 正则 | — | — | — |

---

## 十三、提交链路

### 13.1 多店并行提交（[ozon-product.js#L9173-L9230](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9173-L9230)）

```js
const settledResults = await Promise.allSettled(
  selectedStoreIds.map(async (storeId) => {
    // 1. 解析 warehouse_id
    //    优先级: panel._selectedWarehouseByStore > UI 选择(仅当前 store) > ts.warehouseId > 该 store 仓库列表第一个
    // 2. 构造 stocks = [{ offer_id, stock, warehouse_id }]
    // 3. window.sendMessage('followSell', { storeId, items, stocks, ... })
  })
);
```

### 13.2 仓库 ID 解析（[ozon-product.js#L9179-L9212](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9179-L9212)）

优先级：
1. `panel._selectedWarehouseByStore`（已选）
2. 当前 UI 选择（仅当前 store）
3. `ts.warehouseId`（模板）
4. 该 store 仓库列表第一个（`window.sendMessage('getWarehouses', { storeId })`）

仓库 ID 不跨店通用，禁止把前一个店铺的 UI 值套到另一个店铺。

### 13.3 followSell 消息（[ozon-product.js#L9217](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9217)）

```js
const importResult = await window.sendMessage('followSell', {
  storeId,
  items,
  stocks,
  applyWatermark,
  watermarkTemplateId,
  applyPoster,
  applyAiRewrite,
  ...(viaPortal ? { viaPortal: true } : {}),
  ...(ts.listingType ? { listingType: ts.listingType } : {}),
});
```

SW 转发后端 worker 异步执行 Ozon import。

### 13.4 门户上架灰度（[ozon-product.js#L9159-L9171](file:///c:/root/code/ozon-my/qx-ozon/content/ozon-product.js#L9159-L9171)）

- flag `ozon_portal_import` 开 **且** 用户选「模拟手动上架」才走 `seller.ozon.ru` bundle 接口（绕官方 import 限流）
- flag 关 → 永远 API
- 门户只认浏览器当前登录的单店，多店直接拦下不发请求

---

## 十四、关键端点速查表

| 用途 | 方法 | 端点 | 触发方 | 数据来源代号 |
|------|------|------|--------|-------------|
| 搜索变体元数据 | POST | `https://seller.ozon.ru/api/v1/search` | SW（seller tab 注入） | B |
| 完整 attributes + 物理 | POST | `https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id` | SW（seller tab 注入） | B |
| 全平台跟卖列表（降级） | POST | `https://seller.ozon.ru/api/v1/search`（无 bundle） | SW（seller tab 注入） | B |
| 非锚点变体图册 + 富内容 | GET | `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=<variantLink>` | content script（同源 fetch） | C |
| 非锚点变体图册 + 富内容（备用） | GET | `https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=<variantLink>` | content script（同源 fetch） | C |
| 富内容 Phase2 兜底 | GET | `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=<path>&layout_container=pdpPage2column&...` | content script（同源 fetch） | C |
| 仓库列表 | — | `getWarehouses` message → SW → backend | SW | — |
| 跟卖提交 | — | `followSell` message → SW → 后端 worker → Ozon import | SW | — |

---

## 十五、关键设计要点

1. **独立商品模式**：`independentProducts: true` 下各 SKU 保留自身源类目，不强制对齐到锚点，避免把全部错打成首个商品的类目
2. **不共享 listing 级数据**：视频/PDF complex、页面视频、hashtags、breadcrumbs、pageScrapedDims 全部跳过或恒空，因为列表页各卡片是无关商品
3. **货币换算**：列表页价格按 CNY 计价（跨境店），RUB → CNY 换算，KZT 等无 FX rate 的币种不强转
4. **翻译污染防护**：`name` 优先取 `sv.attributes[4180]`（seller portal API JSON，不被 Chrome 翻译影响），翻译检测命中时强制走 sv 4180
5. **物理参数严格解析**：`parseStrictNumber` 只接受纯数字串，带单位的 `"1.2kg"` 返回 NaN，让 backend 走 `_sourceVariant.attributes` 路径自己做单位识别
6. **图片顺序**：`keep` / `shuffle` / `shuffle_keep_first` 三种模式
7. **batchSize=3 并发预取**：剩余 SKU 按 3 个一批并发调 `searchVariants`，平衡速度与反爬压力
8. **AbortController 可取消**：预取 + gallery 循环可被用户「取消」按钮中断
9. **多店并行提交**：`Promise.allSettled` 扇出到多个店铺，各店独立仓库 ID 解析
10. **门户上架灰度**：flag `ozon_portal_import` 开 + 用户选「模拟手动上架」才走 seller bundle 接口，单店限制
11. **非阻塞预检**：标题质量 / 物流参数缺失只挂提示条建议，不阻塞提交
12. **后端兜底链**：`weight/depth/width/height` 为 undefined 时，后端 `resolveViaSearchVariantModel` 沿 `scraped_*` → source attr 链路接续尝试

---

## 十六、与 PDP 多变体跟卖的差异总结

| 字段/步骤 | PDP 多变体跟卖 | 跟卖本页商品卡 |
|-----------|--------------|--------------|
| 触发页面 | 商品详情页 | 列表页（搜索/类目/卖家/品牌） |
| `independentProducts` | false | **true** |
| 类目对齐 | 强制对齐锚点 | **跳过** |
| `sharedBundleComplex` | 锚点 sv 取，共享 | **null** |
| `sharedVideo` | PDP `.mp4` 转存 | **跳过** |
| `pageScrapedDims` | `extractCharacteristics` | **{}** |
| `sharedHashtags` | `[data-widget="webHashtags"]` | **空** |
| `breadcrumbs` | `extractBreadcrumbs()` | **空** |
| `pageProduct` | 当前 PDP 元数据（锚点图册/品牌） | **null**（无当前 PDP） |
| `variants` 来源 | `extractAspectVariants`（PDP aspects） | `scanListingCards`（列表页卡片） |
| `coverImage` | `v.coverImage`（aspect variant） | `c.image`（列表卡 `<img src>`） |
| `price` 初始值 | `v.price`（aspect variant price） | `c.priceCny`（列表卡价格 RUB→CNY 换算） |
