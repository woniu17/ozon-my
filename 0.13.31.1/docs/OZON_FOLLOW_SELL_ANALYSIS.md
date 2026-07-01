# Ozon 跟卖（follow-sell）功能数据采集与流转分析

> 本文档基于对 `ozon-my-0.13.31.1/` 跟卖功能相关全部源码的只读分析，覆盖 content / lib / background 三层，重点说明"采集哪些数据字段 + 每个字段的数据来源 + 数据如何流转到 Ozon 上架"。

---

## 一、整体架构

### 1.1 采集入口与提交入口

| 入口 | 文件 | 触发 | 目的 |
|---|---|---|---|
| PDP 一键采集 | [ozon-product.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-product.js) `performProductCollect` / `collectAllVariants` | 商品页"一键采集"按钮 | 单 / 多变体采集入 backend 采集箱 |
| 搜索页采集 | [ozon-search.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-search.js) `handleCollectOne` | 搜索卡"采集"按钮 | 单 SKU 采集入采集箱 |
| 数据卡采集 | [ozon-data-panel.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-data-panel.js) `handleCollectOne` | 数据卡"采集"按钮 | 单 SKU 采集入采集箱 |
| PDP 跟卖提交 | [ozon-product.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-product.js) `handleMultiVariantFollowSell` | 商品页"模拟手动跟卖"按钮 | 组装 items[] 提交 backend |
| 公开跟卖列表 | [shared-utils.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/shared-utils.js) `jzFetchPublicFollowSell` | 跟卖数 hover / click | 抓 Ozon 公开跟卖卖家列表（仅展示，不进 payload） |
| 批量上架 | [sku-collect.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/lib/sku-collect.js) + [v3-payload.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/lib/v3-payload.js) | 批量上架页 | 多 SKU 走 SW searchVariants + buildV3Item |

> `content/ozon-seller-bridge.js` **不参与跟卖数据采集**，它只是 seller.ozon.ru 上的 fetch 传输中继（监听 `sellerPortalFetch` 消息），所有 seller portal API 请求都通过它或 SW 跨域快路（`fetchSellerViaOzonTab`）发出。

### 1.2 三条独立数据采集通道

| 通道 | API 端点 | 采集字段 | 借助 tab |
|---|---|---|---|
| **通道 1 — seller portal `/api/v1/search`** | `seller.ozon.ru/api/v1/search` | 元数据：名称 / 图 / 品牌 / 类型 / GTIN / 类目 | seller.ozon.ru tab（或 www.ozon.ru tab 跨域快路） |
| **通道 2 — seller portal bundle API** | `seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id` | 物理属性 + 完整 40-63 个后台 attr + 视频 / PDF complex attr | 同上 |
| **通道 3 — buyer tab page json** | `www.ozon.ru/api/entrypoint-api.bx/page/json/v2` 或 `/api/composer-api.bx/page/json/v2` | mp4 视频 + 富内容(11254) + 描述(4191) + 主题标签(23171) | www.ozon.ru tab MAIN world executeScript |

> 重要发现：`lib/cn-source-scraper.js` 中 Ozon **不是**被采集的源平台（其 `PLATFORM_CONFIGS` 仅含 taobao / tmall / amazon / wb / temu / pdd / mercadolibre / yandex / shein / jd）。Ozon 在跟卖链路中既是"源"也是"目标"，但源数据采集走的是 SW 的 seller portal / buyer tab 通道，不经 `cn-source-scraper.js`。

---

## 二、完整数据采集字段清单

### 2.1 标识与基础信息

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| SKU | DOM URL + window global + JSON-LD | URL 正则 `/product/.*-(\d+)` → `webAddToCart.id`（state-webAddToCart）→ `productWidget.sku`（findStateDataByKeys ['name','sku','coverImageUrl']）→ `jsonLd.sku` | 4 级链式 | `collectPayload.sku` / `item.scraped_sku` / `_sourceVariant.variant_id` 解析 |
| variant_id | seller portal API | SW `searchVariants` → `/api/v1/search` 返回的 `variants[].variant_id` | 无（URL SKU 与 variant_id 不同 namespace，必须先转换） | `create-bundle-by-variant-id` 入参；`pickItemForSku` 匹配 |
| URL | DOM | `window.location.href` | 无 | `collectPayload.url` |
| offer_id | 用户输入 | `.ozon-helper-mv-offerid` input → fallback `SKU${sku}-${Date.now().slice(-4)}` | 用户 > 自动生成 | `item.offer_id`（Ozon 唯一商品编码） |

### 2.2 标题 / 名称

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| title (DOM) | window global + DOM + og:meta + JSON-LD | `detailInfo.name`（state-paginator）→ `productWidget.name`（findStateDataByKeys）→ `jsonLd.name` → `extractOgMeta('og:title')` → `h1.textContent` | 5 级链式 | `collectPayload.name`（采集展示） |
| title (源真值) | seller portal API | `sv.attributes[4180]`（经 `jzExtractCatalogFromSv` / `readSourceText(sv,'4180')`） | DOM 翻译污染时强制切 sv | `item.name`（跟卖 payload）/ attr **4180** |
| 名称翻译安全判定 | window global | `jzPreferSourceName(svName, domName)`：DOM 含中文 && sv 不含中文 → 强制用 sv | — | 防止 Chrome 翻译中文名上架到俄罗斯店 |
| 营销词剥离 | DOM 文本 | `jzStripPromo(title)` 剥"Новинка / 0% до N дней / -10% / bestseller"等 | 剥光为空则保留原串 | 防 Ozon 审核打回"属性包含广告表达" |

### 2.3 价格

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| price (黑标基础价) | window global (data-state) | 遍历所有 `[data-state]` JSON 找 `p.price` 字段（避开 `state-webPricePerStars` 同名 promo widget） | `jsonLd.offers.price` → `[data-widget="webPrice"]` textContent | `collectPayload.price` / `item.price`（2 位小数） |
| walletPrice (绿标 Ozon Bank 价) | window global | 同上扫描找 `p.cardPrice`；无 `price` 时 `price = cardPrice` | — | `collectPayload.walletPrice`（仅展示） |
| originalPrice (划线原价) | window global | `webPrice.originalPrice/oldPrice/previousPrice/crossedPrice/strikethroughPrice/basePrice` / `priceData.originalPrice` / `detailInfo.old_price` | 多键名兜底 | `collectPayload.originalPrice` |
| priceCurrency | DOM 推断 | `_detectPageCurrency()`（跨境页默认 CNY，本土页 RUB） | 探测不到留空（后端默认 RUB） | `collectPayload.priceCurrency`（后端据此决定是否 × 汇率） |
| 变体价 (aspect price) | window global (data-state) | `aspects[].variants[].data.price`（带币种符号字符串）→ `_detectCurrencyFromPriceStr` → `normalizePrice` → 仅 RUB 时 `_rubToCny` | — | `variantData.variants[].price` + `priceCurrency` |
| old_price | 用户输入 / lib 计算 | `.ozon-helper-mv-oldprice` → fallback `price * 1.25` | 用户 > 自动 1.25 倍 | `item.old_price` |
| min_price | 用户输入 | `.ozon-helper-mv-minprice`（仅 > 0 才发） | 留空不发 | `item.min_price`（Ozon 自动调价下限） |

### 2.4 图片

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| images (页面) | window global + DOM + og:meta + JSON-LD + 全局扫描 | 7 级链：`webGallery.images` → `galleryData.images` → `galleryData.coverImage` / `productWidget.coverImageUrl` → `jsonLd.image` → `extractOgMeta('og:image')` → `[data-widget="webGallery"] img[src]` → `img[src*="ir.ozone.ru/s3/multimedia"]` → `picture source[srcset*="ir.ozone.ru"]` → 全局 `[data-state]` 扫 `ir.ozone.ru/s3/multimedia-*` URL | 7→8 级 | `collectPayload.images` |
| images (变体完整图册) | composer-api BFF | `fetchVariantGallery(variantLink)` → `/api/entrypoint-api.bx/page/json/v2?url=<path>`（fallback `/api/composer-api.bx/...`）→ `widgetStates` 找 `images` 数组最长的一个 | — | `galleryMap[sku]` → `item.images`（跟卖首选源） |
| images (源 sv) | seller portal API | `sv.attributes[4194]`（主图）+ `sv.attributes[4195].collection`（图册），经 `readSourceImages(sv)` / `jzExtractCatalogFromSv` | 当 galleryMap 与 sv 都有时，galleryMap 优先；都空时 fallback `v.coverImage` | attr **4194** + **4195** / `item.images[].file_name`（`default: i===0`） |
| CDN 升级 | URL 改写 | `url.replace(/\/wc\d+\//, '/wc1000/')`（Ozon 要求 ≥200×200） | — | 所有 ir.ozone.ru URL 统一升 wc1000 |
| 去重 | URL 规范化 | `u.split('?')[0].split('#')[0].toLowerCase()` | — | `pushUrl` 函数统一去重 |
| image order | 用户选项 | `image-order` select：`keep` / `shuffle` / `shuffle_keep_first` | — | `item.images` 顺序 |

### 2.5 视频

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| videoUrl (源 .mp4) | window global + DOM | `webGallery.videos` → `findStateDataByKeys(['videos'])` → `JZOzonVideoExtract.extractOzonVideoFromSources(...)` → `extractOzonVideoFromDocument(document)`；过滤仅 `.mp4`（跳 m3u8） | 多源叠加 | 转存前源 URL |
| videoUrl (转存后) | seller portal API | SW `uploadFollowSellVideo` action → `transferVideoToOzon(srcUrl)` → `seller.ozon.ru/api/media-storage/upload-file`，返回 `ir.ozone.ru/s3/...` 自有 URL | 转存失败 → null（不阻断上架） | `collectPayload.videoUrl` / `item.videoUrl`（后端 `injectUserVideoComplexAttribute` 据此建视频 complex） |
| videoCover | window global + DOM | `JZOzonVideoExtract.extractOzonVideoFromSources` 返回的 `cover` 字段 | 无 | `collectPayload.videoCover` / `item.videoCover` |
| bundleComplexAttrs (Ozon 复制 API 视频 / PDF) | seller portal API | SW `searchVariants` 内 `fetchBundleByVariantId` → `create-bundle-by-variant-id` 返回 `item.attributes[]` 中 `complex_id > 0` 的项 | 仅自有商品复制时有，跟卖竞品恒空 | `item.bundleComplexAttrs`（后端 `applyBundleComplexAttributes` 重建 import 的 complex_attributes） |
| 视频（批量上架逐 SKU） | seller portal API | SW `transferVariantVideo(url)` → `fetchVariantMediaViaBuyerTab(productUrl)`：在 buyer tab MAIN world 注入 fetch page json，顺带抽 richContent / description / hashtags；mp4 → `transferVideoToOzon` | 失败 → null | `distilled.videoUrl` → `item.videoUrl` |

### 2.6 描述（4191）

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| description (页面) | window global (composer 缓存) + DOM | `state-webDescription` widget → `extractDescriptionText(state, 4096)`（富 JSON walker + HTML stripper）；DOM `[data-widget="webDescription"]` 等；h1~h6 + div/span/p 中含"Описание / 描述"标题的节点 | 多候选 + 评分（`pickBestVisibleDescriptionText`） | 历史用于 `pageDescription` 兜底 |
| description (源真值) | seller portal API | `sv.attributes[4191]` → `readSourceAttrText(sv, '4191')` → `extractDescriptionText(value, 4096)` | — | attr **4191** |
| pickFollowSellDescription | 综合 | `customDescription` → 源 4191 → `fallbackName`（标题）；**显式不再用 pageDescription 兜底**（注释 L274-278：源商品做富内容时 pageDescription 抓回的是富内容文本，跟卖实测漏点） | 3 级 | `item.scraped_description` |
| description (批量上架) | composer-api BFF | SW `transferVariantVideo` / `fetchVariantRichContent` → `fetchVariantMediaViaBuyerTab` 内 `extractDescription(states)`：扫 widgetStates 中 key 含 `description` 的，复用注入的 `JZFollowSellContentCopy.extractDescriptionText` | 失败 → 空 | `distilled.description` → 经 `mergeSourceDescriptionIntoVariant` 写入 sv attr 4191 |
| 富内容 / HTML 解析 | 库函数 | `JZFollowSellContentCopy.extractDescriptionText`：rich JSON walker（跳过 widgetName / align / color 等噪声键 + 跳过 characteristics / reviews / specifications 等容器键）→ HTML 标签剥离 → 去重 → 截断 4096 | — | 任何 description 候选都过此函数 |

### 2.7 富内容（11254）

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| richContent (PDP) | composer-api BFF | `jzCollectPageRichContent()`：`ensurePdpState()` 缓存（页面加载预热）→ 缓存 miss 时 `fetchVariantGallery(window.location.pathname)` 兜底 | 失败 → ''（增强项，不阻断） | `jzInjectRichContentAttr(sv, rc)` 写入 sv attr **11254** |
| richContent (源识别) | composer-api BFF | `jzExtractRichContentFromStates(states)`：遍历 widgetStates，识别 `richAnnotationJson` 字段（整份 `{content,version}` JSON 字符串）或顶层 `{content:[{widgetName}],version}` | 用 `content[].widgetName` 判别避免误命中普通 list / gallery widget | — |
| richContent (变体级) | composer-api BFF | `fetchVariantGallery(variantLink)` 顺带从同一份 widgetStates 抽 | — | `richContentMap[sku]` → `sv.attributes[11254]`（幂等注入，已有不重复加） |
| richContent (批量) | composer-api BFF | SW `fetchVariantMediaViaBuyerTab` → `extractRich(states)`：与 content 端 `jzExtractRichContentFromStates` 同规则（MAIN world 内联实现） | 失败 → '' | `distilled.richContent` + `sv.attributes[11254]` |

### 2.8 主题标签（23171）

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| hashtags (PDP) | DOM | `extractKeywords()`：`[data-widget="webHashtags"] [title]`（仅 #-prefixed）→ fallback `[data-widget="tagList"] a` textContent（仅 #-prefixed，max 20） | tagList 多是搜索关键词链接，要求 #-开头才认 | `sharedHashtags` / `collectHashtags` |
| hashtags (批量) | composer-api BFF | SW `fetchVariantMediaViaBuyerTab` → `extractHashtags(states)`：扫 key 含 `hashtag / taglist` 的 widgetState，递归 walk 收集 #-前缀串，max 30 | 失败 → [] | `media.hashtags` → `injectSourceText` |
| 标签规范化 | 库函数 | `normalizeSourceHashtags(raw)`：剥前导 # → 空格 / 连字符转下划线 → 删非字母数字 / Cyrillic / CJK 字符 → 截断 29 字（#+body ≤30）→ 去重 → max 30 | — | 写入 sv attr **23171** |
| 品牌清洗 | backend | `product.service.ts filterBrandHashtags`（前端不清洗，避免与后端规则不一致） | — | Ozon BR_hashtag_brand 拒卡防护 |
| 注入 | 库函数 | `mergeSourceHashtagsIntoVariant(sv, tags)`：幂等写入 sv attr 23171（已有值不覆盖） | — | `_sourceVariant.attributes[23171]` / `item._aiHashtags` |

### 2.9 物理参数（4497 / 9454 / 9455 / 9456 / 4383 / 7822）

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| weight (4497 g) | seller portal API + 用户输入 + 页面 DOM | 用户 `.ozon-helper-mv-weight`（严格数字，"1.2kg"→NaN 忽略）> `sv.attributes[4497]`（packaged g）> `sv.attributes[4383]`（kg 浮点，<100 则 ×1000）> `parseScrapedDimensionsFromCharacteristics(extractCharacteristics()).weight` | 链式 + `scraped_weight` 独立透传 | `item.weight` + `weight_unit:'g'` / attr **4497** |
| depth (9454 mm) | seller portal API + 用户输入 + 页面 DOM | 用户 `.ozon-helper-mv-depth` > `sv.attributes[9454]` > `parseScrapedDimensionsFromCharacteristics().depth` | 同上 | `item.depth` + `dimension_unit:'mm'` / attr **9454** |
| width (9455 mm) | 同上 | `sv.attributes[9455]` | 同上 | attr **9455** |
| height (9456 mm) | 同上 | `sv.attributes[9456]` | 同上 | attr **9456** |
| 4383 (kg 浮点) | seller portal API | `sv.attributes[4383]`，`<100` 视为 kg→×1000，`≥100` 视为 g | — | 4497 缺失时兜底 |
| barcode / GTIN (7822) | seller portal API | `bundleItem.barcode`（create-bundle-by-variant-id 返回）→ `sv.attributes[7822]`；fallback `/api/v1/search` 的 `barcodes[0]`（`normalizeSearchVariantToSv`） | — | `item.barcode` / attr **7822** |
| 页面 DOM 维度解析 | DOM + window global | `parseScrapedDimensionsFromCharacteristics`：5 策略 A-E 抽 characteristics（state-keys / widget data-state / widget DOM dt-dd / JSON-LD additionalProperty / 全 widget 扫描）；正则匹配俄文 вес / длина / ширина / высота + 英文 weight / length / width / height / depth / dimensions / size；单位识别 кг / kg / г / g / см / cm / мм / mm / m | **无单位且无 unitHint 时拒绝解析**（避免 99g 误判 99kg） | `scraped_weight / depth / width / height` |
| 物理参数缺失 | — | — | 后端落 100×100×100mm / 100g（Ozon 按最大体积费率算物流费，可能压缩利润） | — |

### 2.10 类目 / 品牌 / 类型

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| breadcrumbs | window global + DOM | `findStateDataByKeys(['breadcrumbs'/'breadCrumbs'])` → `[data-widget="breadCrumbs"]` / `[data-widget="webBreadcrumbs"]` `a` textContent → `nav[aria-label]` li a / span | 翻译态下返空（中文匹配俄文类目树 100% 失败） | `collectPayload.breadcrumbs` / `item.scraped_breadcrumbs` |
| categoryIds | DOM | `extractBreadcrumbCategoryIds()`：`a[href*="/category/"]` 中 `/category/.*-(\d+)/` | — | `getProductStats` catIds 参数（佣金按类目 ID 精确分档） |
| description_category_id | seller portal API | `sv.description_category_id`（来自 `/api/v1/search` 的 `description_type_dict_value`，经 `normalizeSearchVariantToSv`） | — | `_sourceVariant.description_category_id`（后端类目解析） |
| categories[] | seller portal API | `sv.categories[]`（`{id, level, name, title}`）→ `jzExtractCatalogFromSv` 拼 "L1 / 最深" 路径 | categories 无 title 时退 `sv.attributes[8229]` | `_sourceVariant.categories` / 展示 |
| type name (8229) | seller portal API | `sv.attributes[8229]`（Тип） | — | attr **8229**；多变体跟卖时锚点变体的 8229 强制覆盖所有变体（除 independentProducts 模式） |
| brand (85) | window global + JSON-LD + seller portal API | `webBrand`（state-webBrand）→ `jsonLd.brand`（normalizeBrandName）→ `sv.attributes[85]`（jzExtractCatalogFromSv） | — | attr **85** / `pageProduct.brand`（"复制当前品牌"时透传 `item.scraped_brand_value`） |
| brandChoice | 用户选项 | `select[data-field="brand"]`：`no_brand` / `copy` | — | `item.scraped_brand`（后端据此设 attr 31） |
| model_name (9048) | 用户输入 | `mergeModel` input（多变体共享同一值才能归到同一张卡） | 留空不发 | `item.scraped_model_name` / attr **9048** |

### 2.11 卖家信息 / 统计 / 评分（仅采集展示，不进跟卖 payload）

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| seller.name | window global (data-state) | `webCurrentSeller.sellerCell.centerBlock.title.text`（2026 shape）→ 旧 shape `webCurrentSeller.name` → DOM `[data-widget="webCurrentSeller"] a` | 多 shape 兼容 | `collectPayload.sellerName` |
| seller.link | window global | `webCurrentSeller.sellerCell.common.action.link` → `centerBlock.title.link` → 顶层 `.link` → DOM `a.href` | 同上 | `collectPayload.sellerLink` |
| statistics (sold_count / sold_sum / gmv_sum / avg_price / views / session_count / conv_to_cart_pdp / conv_view_to_order / discount / create_date / lunch_date) | window global | `state-paginator.detail_info.*` | 全 null 兜底 | `collectPayload.soldCount / soldSum / views / convViewToOrder / discount / gmvSum` |
| rating | JSON-LD | `jsonLd.aggregateRating.ratingValue` | — | `product.rating` |
| reviewCount | JSON-LD | `jsonLd.aggregateRating.reviewCount` | — | `product.reviewCount` |
| followSellCount | composer-api BFF | `jzFetchPublicFollowSell(sku)` → `/api/composer-api.bx/page/json/v2?url=/modal/otherOffersFromSellers?product_id=<sku>` → `widgetStates['webSellerList-*'].sellers.length` | sessionStorage `jz-fs5:<sku>` TTL 4h（≥1 跟卖）/ 5min（零跟卖） | `product.followSellCount` |
| followSellMinPrice | composer-api BFF | 同上 `webSellerList.sellers[].price` 取 min | 同上 | `product.followSellMinPrice` |
| sellers[] (跟卖卖家详情) | composer-api BFF | 同上 modal endpoint，`_normalizeSeller(item)` 提取 `{name, price, sku, link, avatar, rating, reviewsCount, region, deliveryText, deliveryRank}` | 失败 5 次 / 60s → 60s 退避 | `jzShowFollowSellListModal` 弹窗展示 |
| deliveryMode (FBO / FBS / rFBS) | DOM 全文扫描 | 遍历 `[data-state]` 拼接文本，正则 `\bFBO\b` / `\brFBS\b` / `\bFBS\b` | — | `product.deliveryMode` |

### 2.12 变体（aspects）

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| aspects[] | window global (data-state) | 遍历所有 `[data-state]` 找含 `aspects[]` 的 → `[data-widget="webAspects"]` / `[data-widget="aspects"]` → `extractStateData('state-webAspects')` | 3 级 | `extractAspectVariants()` |
| 单变体行 | window global | `aspect.variants[].data.{title, price, coverImage}` + `variant.link` + `availability` + `active` + `searchableText / textRs`（拼 aspectValues） | — | `variantData.variants[]`（轻量行：sku / name / price / priceCurrency / image / images / aspectValues / link） |
| 多色全量变体（>6 色） | composer-api BFF | `jzFetchAspectsModalVariants(modalLink)`：`aspect.aspectModalInfo.link` 指向 `/modal/aspectsNew?...&from_sku=...` → `/api/entrypoint-api.bx/page/json/v2?url=...`（fallback composer-api） | 失败返 []，不阻断 | 补全 webAspects 内联只带 ~6 个的不足 |
| 变体价币种处理 | 字符串解析 | `_detectCurrencyFromPriceStr(rawPriceStr)` 识别 ₽ / ¥ / ₸ / Br → 仅 RUB 时 `_rubToCny` | 其他币种保持原值 | `priceCurrency: 'CNY'/'RUB'/...` |

### 2.13 库存 / 仓库

| 字段 | 数据来源类型 | 具体来源位置 | Fallback 策略 | 最终用途 |
|---|---|---|---|---|
| freeRest (页面库存) | window global | `findStateDataByKeys(['isInCart','toCart']).firstButton.freeRest` / `.freeRest` | — | `product.freeRest`（仅展示） |
| stock (用户填) | 用户输入 | `.ozon-helper-mv-stock`（整数 0~1,000,000） | 留空 → 0 | `item._stock` |
| warehouse_id | backend API | 优先级：`panel._selectedWarehouseByStore` > UI select `data-field="warehouse-id"` > `ts.warehouseId` > `getWarehouses(SW)` 返第一个 | `getWarehouses` → backend `/ozon/warehouses` | `stocks[].warehouse_id` |

### 2.14 跟卖面板选项（非采集字段，但进 followSell payload）

| 字段 | 来源 | 用途 |
|---|---|---|
| applyWatermark / watermarkTemplateId | checkbox / select | 后端水印处理 |
| applyPoster / posterPrimaryOnly | checkbox | 后端 AI 海报 |
| applyAiRewrite | checkbox | 后端 AI 标题 / 属性重写（覆盖 hashtags） |
| randomColor / enableCopyBanSolution / randomAttributesCount / customDescription / listingType | `panel._templateSettings` | 后端防搬运 / 随机属性等 |
| viaPortal | flag + radio | 走 seller.ozon.ru bundle 接口绕官方 import 限流 |

---

## 三、Ozon attribute_id 映射表

| attribute_id | 含义（俄 / 中） | 数据来源 | 注入位置 |
|---|---|---|---|
| **4180** | Наименование / 商品名 | `/api/v1/search` → `variant_name` | `normalizeSearchVariantToSv` 归一 |
| **4191** | Описание / 描述 | buyer tab page json `webDescription` widget | `mergeSourceDescriptionIntoVariant` / SW `fetchVariantMediaViaBuyerTab` |
| **4194** | Картинка / 主图 | `/api/v1/search` → `main_image` | `normalizeSearchVariantToSv` |
| **4195** | Картинки / 图册 | `/api/v1/search` → `secondary_images[]` | `normalizeSearchVariantToSv` (collection) |
| **8229** | Тип / 类型名 | `/api/v1/search` → `description_type_name` | `normalizeSearchVariantToSv` |
| **85** | Бренд / 品牌 | `/api/v1/search` → `brand_name` | `normalizeSearchVariantToSv` |
| **7822** | GTIN / Штрих-код | `/api/v1/search` → `barcodes[0]` **或** bundle → `item.barcode` | `normalizeSearchVariantToSv` + `fetchBundleByVariantId` 注入 |
| **4497** | Вес с упаковкой, г / 重量(g) | bundle → `item.weight` | `fetchBundleByVariantId` 注入到 `items[0].attributes` |
| **9454** | Глубина, мм / 深(mm) | bundle → `item.depth` | 同上 |
| **9455** | Ширина, мм / 宽(mm) | bundle → `item.width` | 同上 |
| **9456** | Высота, мм / 高(mm) | bundle → `item.height` | 同上 |
| **4383** | Вес с упаковкой, кг / 重量(kg) | bundle → `item.attributes[4383]` | `<100` 视为 kg→×1000，`≥100` 视为 g |
| **11254** | Rich Content / 富内容 JSON | buyer tab page json `richAnnotationJson` | `jzInjectRichContentAttr` / sku-collect `injectRichContent` |
| **23171** | Тематические теги / 主题标签 | buyer tab page json `webHashtags` / `tagList` | `mergeSourceHashtagsIntoVariant`（经 `normalizeSourceHashtags` 清洗） |
| **9024** | Артикул / 卖家货号 | `/api/v1/search` | 仅 `pickItemForSku` 前缀匹配用，不注入 V3 |
| **9048** | Модель / 型号名 | 调用方传入（整批共享） | V3 `scraped_model_name` |
| **31** | brand（最终） | backend 据 `scraped_brand` strategy 设置 | backend 注入 |
| **10096 / 22814** | Цвет / Цветное исполнение（颜色 collection） | `/api/v1/search` | 仅 `pickItemForSku` 评分用 |
| **8219** | Материал / 材料 | `/api/v1/search` | 仅 `pickItemForSku` 评分用 |

---

## 四、数据流转链路

### 4.1 一键采集流转（performProductCollect / collectAllVariants）

```
[PDP page]
  extractProductData()                     # DOM/state/JSON-LD/og:meta 7 级 fallback
  extractBreadcrumbs() / extractCharacteristics() / extractKeywords()
       │
       ├─> [content script] window.sendMessage('searchVariants', { sku })
       │       │
       │       └─> [SW] fetchSellerPortal('/search', {company_id, filter:sku.values})
       │              via content/ozon-seller-bridge.js (seller.ozon.ru tab) OR fetchSellerViaOzonTab (www.ozon.ru tab 跨域快路)
       │              ↓
       │              /api/v1/search resp.variants[] → normalizeSearchVariantToSv
       │              ↓
       │              fetchBundleByVariantId(sku, variant_id, companyId)
       │              → /api/site/seller-prototype/create-bundle-by-variant-id
       │              ↓ bundleItem.weight/depth/width/height/barcode + attributes[complex_id>0]
       │              ↓ 注入 items[0].attributes[4497/9454/9455/9456/7822] + _bundleComplexAttrs
       │              ↓
       │              ← { items: [sv] }
       │
       ├─> [content script] captureAndTransferPageVideoMedia()
       │       │
       │       └─> [SW] window.sendMessage('uploadFollowSellVideo', { srcUrl })
       │              ↓ transferVideoToOzon → seller.ozon.ru /api/media-storage/upload-file
       │              ↓ ← { url: 'ir.ozone.ru/s3/...' }
       │
       ├─> [content script] jzCollectPageRichContent()
       │       │
       │       └─> window.ensurePdpState() (SW composer-api cache 预热)
       │              ↓ miss → fetchVariantGallery(path) (content 同源 fetch composer/entrypoint)
       │              ↓ ← richContent (11254 JSON)
       │
       ├─> jzExtractCatalogFromSv(sv) → svCat {name[4180], mainImage[4194], images[4194+4195], brand[85], categoryPath, weightG[4497], depthMm[9454], widthMm[9455], heightMm[9456], gtin[7822]}
       ├─> jzPreferSourceName(svCat.name, product.title)
       ├─> jzInjectRichContentAttr(sv, rc) → sv.attributes[11254]
       ├─> pickFollowSellDescription({sv, rc, fallbackName}) → desc
       ├─> mergeSourceDescriptionIntoVariant(sv, desc) → sv.attributes[4191]
       ├─> mergeSourceHashtagsIntoVariant(sv, extractKeywords()) → sv.attributes[23171]
       │
       ↓ 组装 collectPayload {sku, url, name, price, priceCurrency, originalPrice, image, images, videoUrl, videoCover, variantData: sv, sellerName, sellerLink, soldCount, ...statistics}
       │
       └─> [SW] window.sendMessage('pushSourceCollect', { sourceId:'ozon', raw:payload, forceResubmit })
              ↓ 24h dedupe (chrome.storage.local 'jz-collect-recent-v1:...')
              ↓ in-flight merge (pendingCollects Map)
              ↓ 指数退避重试 (3 次, 4xx 立即失败)
              ↓
              POST ${backendUrl}/sources/ozon/collect
              ↓ backend provider normalize + upsert 采集箱
              ← { dedupeHit, lastAt, result }
```

### 4.2 跟卖提交流转（handleMultiVariantFollowSell）

```
[PDP page] 用户点"模拟手动跟卖" → toggleFollowSellPanel
  ├─ extractBreadcrumbs() / extractProductData() / extractKeywords() / extractCharacteristics()
  │
  ├─> prefetchSourceVariantWithItems(firstSku)   # Gate check
  │       └─> [SW] searchVariants → /api/v1/search + create-bundle-by-variant-id
  │              失败 → syncSellerCookies 重试一次
  │              仍空 → searchProductBySku 降级 (/api/v1/search 全平台, 无 bundle 物理 attr)
  │
  ├─> 并发 BATCH_SIZE=3 批次预取剩余变体 sv
  │       └─> [SW] searchVariants per SKU
  │
  ├─> 并发 GALLERY_BATCH=4 抓变体图册 + 富内容
  │       └─> [content] fetchVariantGallery(variantLink) → composer/entrypoint page json
  │              ↓ images + richContent (11254)
  │
  ├─> 类目一致性: 锚点 sv.description_category_id + categories + attributes[8229]
  │              强制覆盖所有变体 (除 independentProducts 模式)
  │
  ├─> captureAndTransferPageVideoMedia() → sharedVideo (listing 级共用)
  │
  ├─> parseScrapedDimensionsFromCharacteristics(extractCharacteristics()) → pageScrapedDims
  │
  ├─> per-variant items[] 组装:
  │       ├─ name = sv.attributes[4180] (翻译安全) > DOM > v.title
  │       ├─ images = galleryMap[sku] > sv[4194]+[4195] > v.coverImage
  │       ├─ description = pickFollowSellDescription({sv, richContent, fallbackName})
  │       ├─ weight/depth/width/height = user > sv[4497/9454-9456] > sv[4383 kg→g] > undefined
  │       ├─ scraped_weight/depth/width/height = pageScrapedDims
  │       ├─ _sourceVariant = sv (含 11254/4191/23171/8229/85/4497/9454-9456/7822 etc.)
  │       ├─ bundleComplexAttrs = sv._bundleComplexAttrs (listing 级兜底)
  │       ├─ videoUrl = sharedVideo.url
  │       ├─ _aiHashtags = sharedHashtags
  │       ├─ scraped_brand = brandChoice ('no_brand'/'copy')
  │       ├─ scraped_brand_value = (copy 时) pageProduct.brand
  │       ├─ scraped_model_name = mergeModel
  │       ├─ scraped_breadcrumbs = breadcrumbs
  │       └─ _stock = stock
  │
  ├─> getWarehouses(SW) per store → resolve warehouse_id
  ├─> usageTrack('follow-sell:submit')
  │
  └─> [SW] window.sendMessage('followSell', { storeId, items, stocks, applyWatermark, ... })
         │
         ├─ viaPortal=true:
         │       POST ${backendUrl}/ozon/products/prepare-bundle-items
         │       ↓ 返回 bundle items
         │       ↓ SW importViaPortal → seller.ozon.ru bundle create→update→upload (3 步同步)
         │       ↓ portalImportStatus 轮询 get-list/get-errors
         │       ← { task_id, viaPortal:true, company_id, task_ids }
         │
         └─ viaPortal=false (默认):
                 POST ${backendUrl}/ozon/products/import (120s timeout)
                 ↓ backend 入队 QUEUED, worker 异步执行 AI/水印/Ozon 调用/库存导入
                 ← { task_id }
```

### 4.3 批量上架流转（lib/sku-collect.js + lib/v3-payload.js）

```
[batch-upload page] JZSkuCollect.collectBySkus(skus, { captureVideo, captureRichContent })
  │
  ├─> gateCheck(firstSku) → fetchOneSku
  │       └─> [SW] searchVariants → /api/v1/search + create-bundle-by-variant-id
  │              ↓ distillSource(sv) → distilled { _sourceVariant, name[4180], description[4191], richContent[11254], images[4194+4195], barcode[7822], weight[4497], depth[9454], width[9455], height[9456], categories, descriptionCategoryId }
  │
  ├─> 批次 BATCH_SIZE=3, 批间 400ms+jitter 节流
  │       per SKU: fetchOneSku → searchVariants (失败降级 searchProductBySku, 无 bundle 物理 attr)
  │       命中 ANTIBOT_BLOCKED → 10min 冷却 + 中止剩余
  │
  ├─> if captureVideo: per SKU 串行 (500ms 间隔)
  │       └─> [SW] transferVariantVideo(url)
  │              ↓ fetchVariantMediaViaBuyerTab(productUrl)
  │                     ↓ ensureBuyerTab → MAIN world executeScript
  │                     ↓ 注入 lib/ozon-video-extract.js + lib/follow-sell-content-copy.js
  │                     ↓ fetch /api/entrypoint-api.bx/page/json/v2?url=<path> (fallback composer-api)
  │                     ↓ extractRich + extractMp4 + extractDescription + extractHashtags
  │              ↓ mp4 → transferVideoToOzon → seller upload-file
  │              ← { url, richContent, description, hashtags }
  │       ↓ injectRichContent(distilled, rc) → distilled.richContent + sv.attributes[11254]
  │       ↓ injectSourceText(distilled, desc, tags)
  │              ↓ contentCopy.mergeSourceDescriptionIntoVariant → sv.attributes[4191]
  │              ↓ contentCopy.mergeSourceHashtagsIntoVariant → sv.attributes[23171]
  │
  ├─> else (captureRichContent !== false): per SKU 串行 (500ms 间隔)
  │       └─> [SW] fetchVariantRichContent(url)
  │              ↓ fetchVariantMediaViaBuyerTab (同上, 无 video upload)
  │              ← { richContent, description, hashtags }
  │
  └─> JZV3Payload.buildV3Item(row, distilled, opts)
          ↓ 用户填 > distilled 兜底
          ↓ item.{offer_id, name, price, old_price, vat, currency_code, images, bundleComplexAttrs, videoUrl, scraped_description, scraped_breadcrumbs, scraped_sku, scraped_model_name, _sourceVariant, weight, depth, width, height, dimension_unit, barcode, complex_attributes, service_type}
          ↓
          POST ${backendUrl}/ozon/products/importOzonProductV3 (via backend)
```

---

## 五、关键路径详解

### 5.1 searchVariants 关键路径（SW case 'searchVariants'，行 3419-3601）

1. **cookies 解析**：`chrome.cookies.getAll({url:'https://seller.ozon.ru/', name:'sc_company_id'})` 取 `companyId`
   - 若无 companyId 且 `!message.noProxy` → 调 `proxyCollectVariant` 派给同租户已登录设备代采（后端 `/browser-agents/collection-jobs` 创建 job + 轮询）
   - 代采失败 / 超时 → 返回 `{ok:false, error:'AUTH_REQUIRED'}`

2. **Step 1 — `/api/v1/search`**（最多重试 2 次，间隔 2s）：
   ```
   POST https://seller.ozon.ru/api/v1/search
   body: { company_id, need_total:true,
           filter:{children_nodes:{children_nodes:[{input_leaf:{sku:{values:[sku]}}}], operator:'AND'}},
           pagination:{limit:'50'}, is_copy_allowed:false }
   ```
   - 走 `fetchSellerPortal`（`urlPrefix:'/api/v1'`, `pageType:'products'`, `allowOzonTab:true`, `preferTabId:senderTabId`）
   - `allowOzonTab` 优先在当前 www.ozon.ru tab MAIN world 直发（跨域快路），失败回退 seller-tab executeScript → bridge
   - 响应 `variants[]` 经 `normalizeSearchVariantToSv` 归一为 sv shape（注入 4180 / 4194 / 4195 / 8229 / 85 / 7822 + `_searchMeta`）
   - 空 items → 返回 `{ok:true, data:{items:[]}}`（业务空结果，不重试）

3. **Step 2 — `create-bundle-by-variant-id`**（失败不致命，best-effort）：
   ```
   POST https://seller.ozon.ru/api/site/seller-prototype/create-bundle-by-variant-id
   body: { company_id, variant_id, source:'SOURCE_UI_COPY_APPAREL' }
   ```
   - `fetchBundleByVariantId` 内部 24h chrome.storage.local cache（key=`jz-sw-bundle-v2:${companyId}:${variantId}`），`forceRefresh=true` 跳过
   - 返回 `item` 含 `weight / depth / width / height / barcode / attributes[]`（40-63 个）
   - **字段注入**（仅当原 items[0] 无该 key 时）：
     - `weight>0` → push `{key:'4497', value:String(weight)}`
     - `depth>0` → push `{key:'9454', value:String(depth)}`
     - `width>0` → push `{key:'9455', value:String(width)}`
     - `height>0` → push `{key:'9456', value:String(height)}`
     - `barcode` → push `{key:'7822', value:String(barcode)}`
   - **简单 attr 注入**：`complex_id==0` 的 attr，转成 `{key, value|collection}` push 进 `items[0].attributes`（不覆盖已有 key）
   - **complex attr 收集**：`complex_id>0`（视频 / PDF）单独收集到 `items[0]._bundleComplexAttrs`
   - 完整 bundle item 挂到 `items[0]._bundleItem`

4. **错误分类** `classifyError(e)`：
   - `status===404 && code==='ResourceNotFound'` → `NOT_IN_OWN_CATALOG`
   - msg 含「请先打开 / No seller tab」→ `NO_SELLER_TAB`
   - msg 含「Cannot access contents / permission」→ `PERMISSION_DENIED`
   - `status===401 || code==='AUTH_REDIRECT'` 或 msg 含「登录 / signin / login」→ `AUTH_REQUIRED`
   - `status===403` → 按 body 形状细分：结构化 JSON 权限错 → `AUTH_REQUIRED`；HTML 挑战页 / 裸 403 → `ANTIBOT_BLOCKED`
   - 超时 → `TIMEOUT`；网络错 → `NETWORK_ERROR`
   - 可重试错误（TIMEOUT / NETWORK_ERROR / UNKNOWN_ERROR）重试，其余直接返回

### 5.2 fetchVariantRichContent 富内容独立通道（SW case 'fetchVariantRichContent'，行 3408-3417 + fetchVariantMediaViaBuyerTab 行 878-1027）

**触发场景**：`collectBySkus` 中视频转存关闭或个别 SKU 视频段没抽到富内容时，逐 SKU 借买家 tab 只拉 page json 抽 11254（纯读，无门户写请求，与 seller portal 反爬风险分离）。

**流程**：
1. `ensureBuyerTab()` 获取 / 创建 www.ozon.ru tab
2. 注入两个 helper（MAIN world）：`lib/ozon-video-extract.js` + `lib/follow-sell-content-copy.js`（注入失败仅降级描述抽取，不影响视频 / 富内容 / 标签）
3. `executeScript` 注入 `doFetch(relPath, 15000)`，依次试两个 endpoint：
   - `/api/entrypoint-api.bx/page/json/v2?url=${path}`
   - `/api/composer-api.bx/page/json/v2?url=${path}`
   - 请求头：`x-o3-app-name:'dweb_client'`, `accept:'application/json'`, `credentials:'include'`
4. 解析 `data.widgetStates`：
   - **富内容(11254)** `extractRich(states)`：遍历 states，优先 `richAnnotationJson` 字符串（`isRichDoc` 校验：object + content[] + widgetName）；否则顶层 `{content:[{widgetName}], version}` → 序列化为 `{content, version}`
   - **mp4** `extractMp4(states)`：优先用 `JZOzonVideoExtract.extractOzonMp4FromSources`；否则遍历 `*gallery*` key 的 `videos[].url` 匹配 `\.mp4`
   - **描述(4191)** `extractDescription(states)`：用 `JZFollowSellContentCopy.extractDescriptionText` 处理 `*description*` key 的 state（绝不把原始 JSON 串当描述）
   - **标签(23171)** `extractHashtags(states)`：遍历 `*hashtag* / *taglist*` key，递归 walk（depth≤32）捞 `#` 前缀串，去重 + 上限 30
5. 视频 + 富内容都到手即提前结束；否则继续试下一个 endpoint
6. 返回 `{ok:true, data:{richContent, description, hashtags}}`（无 mp4）；失败返回全空（best-effort，不阻断上架）

**`extractRichContentText` 遍历规则**（`lib/follow-sell-content-copy.js` 行 17-76）：
- `skipKeys` 跳过噪声 key：`widgetName / align / size / color / type / src / img / url / link / gifUrl / videoUrl / previewUrl / backgroundColor / theme / padding / margin / id / reff / fontColor / borderColor` + 语义噪声容器 `characteristics / specifications / reviews / questions / comments / aspects / params / feedbacks / hashtags / tags`
- 仅跳明确容器 key，不跳 `name / value`（后者是合法描述字段）
- `pushText` 规则：`total>=maxChars` 停；`text.length<2` 丢；`/^https?:\/\//` 丢（URL）；`!/\p{L}/u` 丢（纯数字 / 符号）；去重（lowercase）
- `maxChars` 默认 2000，深度上限 64

**`pickBestVisibleDescriptionText` 评分逻辑**（行 224-254）：
- `letterCount<8` → 负无穷
- 基础分 `min(text.length, 1200)`
- rawLines 含描述标题 +400，含章节标题(Состав / Способ применения) +700
- textLines 含章节标题 +250
- 含数字编号 `\d+\.` +60
- `text.length<30` -300
- 首行是 stop line -500
- UI 噪声（show more / 展开 等）负无穷

### 5.3 视频转存链路（SW case 'transferVariantVideo'，行 3391-3406 + transferVideoToOzon 行 819-869）

**触发场景**：`collectBySkus` 中 `opts.captureVideo=true` 时，逐 SKU 串行（`VIDEO_INTERVAL_MS=500ms` 节流）。

**两步流程**：

**Step 1 — 抓源 mp4**（`fetchVariantMediaViaBuyerTab`）：
- 借 www.ozon.ru tab MAIN world fetch page json，从 `*gallery*` widget 抽 `.mp4` 直链
- 同一次 page json 顺带抽富内容(11254) + 描述(4191) + 标签(23171)，零增量请求

**Step 2 — 转存成卖家自有 Ozon 视频**（`transferVideoToOzon`）：
1. `ensureSellerTab()` 获取 seller.ozon.ru tab
2. 解析 `sc_company_id` cookie，无则返回 `AUTH_REQUIRED`
3. 在 seller tab MAIN world 注入 `doUpload(src, companyId, 90000)`：
   ```
   // 跨源拉源 .mp4
   const dl = await fetch(src, { signal });
   const blob = await dl.blob();
   // multipart 同源 POST(带 cookie)
   POST https://seller.ozon.ru/api/media-storage/upload-file
   headers: { accept:'application/json', x-o3-company-id, x-o3-language:'zh-Hans' }
   body: FormData { file_name, tmp:'true', body: File([blob], fname, {type:'video/mp4'}) }
   ```
4. 响应重定向到 signin / login → 返回 401 AUTH_REDIRECT
5. 成功返回 `{ok:true, url: j.url, size: blob.size}`

**返回给 sku-collect**：`{ok:true, data:{url, richContent, description, hashtags}}`。url 为 null 表示无视频 / 失败（best-effort 降级，不阻断上架）。sku-collect 据此：
- `distilled.videoUrl = url`（buildV3Item 据此下发 `item.videoUrl`，backend `injectUserVideoComplexAttribute` 注入主视频槽）
- `injectRichContent(distilled, richContent)` 写 11254
- `injectSourceText(distilled, description, hashtags)` 写 4191 + 23171

### 5.4 pickFollowSellDescription 优先级与 pageDescription 兜底移除

**优先级链路**（`lib/follow-sell-content-copy.js` 行 272-284）：
```
customDescription > 源 attr 4191(extractDescriptionText) > fallbackName(标题)
```

**为何不再用 pageDescription 兜底**（行 274-278 注释）：源商品把内容做成富内容时，页面可见描述抓回来是一坨富内容文本（手动跟卖实测漏点）。批量上架走 sku-collect 直读源 4191、从不碰实时页面 DOM，本就不漏；去掉 pageDescription 让手动跟卖对齐批量 —— 源无真实 4191 即退标题，而非页面富内容。富内容继续作为独立富内容块下发（`pickSourceRichContent` / `jzInjectRichContentAttr`），正文不回填普通描述。

### 5.5 normalizeSourceHashtags 清洗规则

（`lib/follow-sell-content-copy.js` 行 302-328，与后端 `buildHashtagValues` 对齐）：
- 剥已有 `#` 前缀
- 空格和连字符 → 下划线 `_`
- 删非法字符（点 / 逗号 / 斜杠 / emoji 等），保留 CJK + 俄文 + 数字 + 下划线
- 合并连续 `_`，去首尾 `_`
- `body.length>29` 截断（`#+body ≤ 30`）
- 去重（lowercase），上限 30 个标签
- 写入 attr 23171 时为 `tags.join(' ')`
- **品牌清洗在 backend 注入处做**（`product.service.ts filterBrandHashtags`），源标签裸下发会触发 `BR_hashtag_brand` 拒卡

### 5.6 shouldForceCollectRefresh 触发条件

（行 345-351）：`videoUrl` / `description` / `richContent` 任一非空，或 `normalizeSourceHashtags(hashtags).length>0`。

---

## 六、隐患与风险点

### 6.1 数据源稳定性风险

1. **Ozon DOM 持续剥离**：2026-05 起 Ozon 把跟卖列表（webOtherSellers / Followers / otherSellers）从商品页主响应剥离到独立 modal endpoint `/modal/otherOffersFromSellers`。`extractProductData` 内的 `findStateDataByKeys(['modalLink','count'])` 兜底已失效，仅 `jzFetchPublicFollowSell` 走 modal endpoint 能拿到。后续若 Ozon 继续剥离 webGallery / webPrice 等 widget，7 层 fallback 也兜不住，需依赖 `ensurePdpState` 的 composer-api 缓存预热。

2. **翻译污染**：Chrome 自动翻译会把 DOM 文本中文化。`jzPreferSourceName` 仅在 DOM 含中文 && sv 不含中文时切回 sv 4180；但 sv 也缺失时（searchVariants 失败）会上架中文名到俄罗斯店。`extractBreadcrumbs` 在翻译态下显式返空让后端走 sv 路径，是正确防御。

3. **searchVariants 不返 4191 / 11254 / 23171**：`/api/v1/search` + create-bundle-by-variant-id 都不返描述 / 富内容 / 主题标签，这三样只能从 PDP widget 抓。PDP 一键采集用 `jzCollectPageRichContent` + `extractKeywords` + `pickFollowSellDescription`（sv 4191 兜底）；批量上架需借 buyer tab 拉 page json（`fetchVariantMediaViaBuyerTab`），多一次门户请求 + 反爬风险。

4. **create-bundle 副作用**：`create-bundle-by-variant-id` 每次调用 Ozon 端创建一个新 bundle draft，bundle_id 递增。24h cache 缓解但源商品改类目 / 属性时最多 1 天才刷新（`forceRefresh:true` 可绕）。长期累积可能污染卖家后台 draft 列表。

5. **跨店 bundle 串数据**：v1 cache key 只用 sku，多 ozon 店时 B 店会复用 A 店 bundle item 串数据；v2 已修（`jz-sw-bundle-v2:${companyId}:${variantId}`），SW 启动时一次性清理 v1 缓存。

### 6.2 反爬风险

6. **seller portal 反爬风险评分**：seller.ozon.ru 按"短时请求密度"评分，批量上架 5 并发会触发限制登录。已降到 BATCH_SIZE=3 + 批间 400ms+jitter 节流 + 全局 200ms 闸门（`_sellerPortalGate`）+ ANTIBOT_BLOCKED 10min 冷却。但用户快速浏览叠加采集时仍可能触发。

7. **403 细分**：`classifyError` 区分 HTML 挑战页（真反爬，进冷却）vs 结构化 JSON 权限错（AUTH_REQUIRED，引导重登）。裸 403 仍按反爬处理（保留熔断保护）。但 `looksStructuredApiError` 正则较宽（含 `"code"|"message"|session` 等），混合错误可能误判为 AUTH_REQUIRED 而非 ANTIBOT_BLOCKED，导致不进冷却继续猛打。

8. **视频转存独立路径**：`transferVideoToOzon` 的 upload-file 是独立 executeScript 路径，不经全局 200ms 闸门，由 `sku-collect.js` 的 `VIDEO_INTERVAL_MS=500` 单独节流。若用户同时手动跟卖 + 批量上架，两路视频转存请求可能叠加。

### 6.3 数据正确性风险

9. **物理参数无单位拒绝解析**：`parseScrapedDimensionsFromCharacteristics` 在无单位且无 unitHint 时拒绝解析（避免 99g 误判 99kg）。这导致部分页面 DOM 兜底失效，落到后端 100×100×100mm / 100g 默认值（Ozon 按最大体积费率算物流费，可能压缩利润）。前端会挂非阻塞提示条引导手填。

10. **pageDescription 不再兜底**：`pickFollowSellDescription` 显式去掉 pageDescription 兜底。源无真实 4191 即退标题。这是与批量上架对齐的有意设计，但若源商品 4191 空 + 标题质量差，跟卖卡描述会很差。

11. **主题标签品牌清洗**：源标签裸下发触发 Ozon `BR_hashtag_brand` 拒卡。前端只做格式规范化，品牌清洗在 backend `filterBrandHashtags`。若 backend 规则滞后会拒卡。

12. **类目一致性强制对齐**：多变体跟卖时锚点变体的 `desc_cat_id` + `categories` + `attributes[8229]` 强制覆盖所有变体。但「跟卖本页商品卡」（`independentProducts=1`）模式跳过对齐，各 SKU 保留自身源类目。若 UI 误判模式会把无关商品全打到首个商品类目（线上曾出现"全部显示保养套件"）。

13. **bundle complex attrs 共享**：视频 / PDF 是商品级（整个 listing 共用），但 `pickItemForSku` 选了非 items[0] 的兄弟变体时 `_bundleComplexAttrs` 缺失，需从锚点 sv 兜底（`sharedBundleComplex`）。独立商品模式跳过共享，各 SKU 用自己的 `_bundleComplexAttrs`。

14. **变体价币种处理**：`_detectCurrencyFromPriceStr` 识别 ₽ / ¥ / ₸ / Br，仅 RUB 时 `_rubToCny` 换算；其他币种保持原值。若 Ozon 新增币种（如 AMD / GEL）会留空不猜。

### 6.4 流程风险

15. **24h Dedup**：`pushSourceCollect` 24h dedupe；`forceResubmit:true` 才能强制重推。视频 / 简介 / 富内容 / 标签任一存在时 `shouldForceCollectRefresh` 自动 forceResubmit。但纯字段更新（如改价格）不会触发 forceResubmit，24h 内同 SKU 重复采集会静默命中 dedupe。

16. **sc_company_id 依赖**：seller portal 所有请求要带 company_id。未登录 seller.ozon.ru 时 NO_COMPANY_ID 错误，`proxyCollectVariant`（同租户已登录设备代采）是兜底，但需要 backend 支持。

17. **viaPortal 灰度**：门户上架（seller.ozon.ru bundle 接口绕官方 import 限流）需 `ozon_portal_import` flag 开 + 用户选"模拟手动上架"。flag 5min 缓存，失败默认关 → 回退官方 API。多店时 viaPortal 强制单选（门户只认浏览器当前登录的单店）。

18. **Offer_id 唯一性**：`offerId` 默认 `SKU${sku}-${Date.now().slice(-4)}`，4 位随机后缀有碰撞风险（同 SKU 1 秒内多次提交）。批量上架用 `${prefix}-${batchSalt}-${sku}`，`batchSalt` 防同 SKU 多次提交冲突。

### 6.5 维护性风险

19. **俄语关键词正则**：`parseScrapedDimensionsFromCharacteristics` 依赖俄文 label（вес / длина / ширина / высота / масса / габариты / размеры）。若 Ozon 改英文 / 中文 UI 则失效。`extractKeywords` 的 `isDescriptionHeading` 也含俄文 "Описание / Состав / Способ применения"。

20. **Ozon widget 命名漂移**：`findStateDataByKeys` 按 key 存在性匹配，比固定 widget 名稳。但 `webSellerList`、`webHashtags`、`webDescription`、`webGallery`、`webAspects` 等固定 widget 名仍出现在多处。Ozon 改名时需同步修。

21. **bundle endpoint 可被下线**：`create-bundle-by-variant-id` 是 Ozon SPA 内部接口，无官方稳定性保证。2026-05 已经历过一次 `/api/v1/search-variant-model` 下线（全员 404），迁移到 `/api/v1/search` + create-bundle 组合。下一次 Ozon 改版可能再触发。

22. **cn-source-scraper.js 无 Ozon 平台**：Ozon 作为"源"被采集时（跟卖），不走 `cn-source-scraper.js` 的 `buildPayload`，而是走 SW 专用通道。若日后需要把 Ozon 接入跨平台采集面板，需新增 `PLATFORM_CONFIGS.ozon`。

---

## 七、关键文件路径汇总

**核心采集 / 跟卖文件**：
- [content/ozon-product.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-product.js) — PDP 主入口（extractProductData L226, performProductCollect L1666, handleMultiVariantFollowSell L7835, jzInjectRichContentAttr L8773, fetchVariantGallery L8787, jzCollectPageRichContent L8746, extractBreadcrumbs L831, extractCharacteristics L884, parseScrapedDimensionsFromCharacteristics L1150, extractKeywords L9761, extractPageDescription L9788, captureAndTransferPageVideoMedia L1600）
- [content/shared-utils.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/shared-utils.js) — jzFetchPublicFollowSell L2088, jzShowFollowSellListModal L2290, jzBindFollowSellHover L2452, jzExtractCatalogFromSv L1638, jzPreferSourceName L1714, jzStripPromo L1733
- [content/ozon-search.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-search.js) — 搜索页 handleCollectOne L455
- [content/ozon-data-panel.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-data-panel.js) — 数据卡 handleCollectOne L399
- [content/ozon-seller-bridge.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/content/ozon-seller-bridge.js) — seller portal fetch 中继（不采集数据，仅传输）

**库文件**：
- [lib/follow-sell-content-copy.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/lib/follow-sell-content-copy.js) — 描述 / 标签 / 富内容处理（pickFollowSellDescription, mergeSourceDescriptionIntoVariant, normalizeSourceHashtags, mergeSourceHashtagsIntoVariant, extractDescriptionText, extractRichContentText, shouldForceCollectRefresh）
- [lib/v3-payload.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/lib/v3-payload.js) — V3 跟卖 payload 拼装（buildV3Item）
- [lib/sku-collect.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/lib/sku-collect.js) — 批量 SKU 采集（collectBySkus, distillSource, fetchOneSku, gateCheck）
- [lib/ozon-video-extract.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/lib/ozon-video-extract.js) — Ozon 视频 mp4 抽取

**SW action 处理**：
- [background/service-worker.js](file:///c:/root/code/get-shop-product/ozon-my-0.13.31.1/background/service-worker.js) — pushSourceCollect L2738, getProductStats L2938, getMarketStats L2971, followSell L3165, portalImportStatus L3185, searchProductBySku L3330, uploadFollowSellVideo L3378, transferVariantVideo L3391, fetchVariantRichContent L3408, searchVariants L3419, normalizeSearchVariantToSv L372, fetchBundleByVariantId L491, fetchVariantMediaViaBuyerTab L878, fetchSellerViaOzonTab L1063, transferVideoToOzon L819, importViaPortal L607
