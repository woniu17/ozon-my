# 合成请求预览(synthesizedItems) vs 真实一键上架请求体 字段对比

> 作用：核对 `collect_box_v2.synthesized_items_json`（合成跟卖请求预览）与插件实际发送的「一键上架 ozon」请求体字段是否一致，定位差异以便后续补齐预览字段。

## 一、相关代码位置

| 角色 | 文件路径 | 行号 | 说明 |
|------|----------|------|------|
| A. 真实上架 items 构造 | `qx-ozon/content/ozon-product.js` | L9357-9403 | `handleMultiVariantFollowSell` 内 `items.push({...})` |
| B. synthesizedItems 构造 | `qx-ozon/content/ozon-product.js` | L1858-1895 | `pushCollectBoxV2FromCollected` 内 `synthesizedItems = collectedVariants.map(...)` |
| C. collectedVariants 中间结构 | `qx-ozon/content/ozon-product.js` | L1806-1855 | synthesizedItems 数据源 |
| D. 后端转 OPI v3 schema | `erp-backend-lite/src/services/prepare-bundle.js` | L167-498 | `transformItemForPortal` |
| E. 最终发 Ozon /v3/product/import | `erp-backend-lite/src/services/ozon-opi.js` | L63-177 | `productImport` |

## 二、真实上架 items 字段（A，共 30 个）

| # | 字段 | 类型 | 取值来源 |
|---|------|------|----------|
| 1 | `offer_id` | string | UI `.ozon-helper-mv-offerid` ‖ `SKU{sku}-{Date末4位}` |
| 2 | `name` | string | sv[4180] > DOM > v.title（含翻译检测） |
| 3 | `price` | string | UI `.ozon-helper-mv-price`（`.toFixed(2)`） |
| 4 | `old_price` | string | UI `.ozon-helper-mv-oldprice` ‖ `price×1.25` |
| 5 | `min_price` | string | UI `.ozon-helper-mv-minprice`（>0 才发） |
| 6 | `vat` | string | 硬编码 `'0'` |
| 7 | `currency_code` | string | UI `currencyCode`（用户可选） |
| 8 | `images` | `Array<{file_name,default}>` | galleryMap > sv[4194]+[4195] > coverImage，应用 imageOrder |
| 9 | `bundleComplexAttrs` | array ‖ undefined | sv._bundleComplexAttrs ‖ sharedBundleComplex |
| 10 | `videoUrl` | string | sharedVideo.url（条件发） |
| 11 | `videoCover` | string | sharedVideo.cover |
| 12 | `scraped_breadcrumbs` | string[] | extractBreadcrumbs() |
| 13 | `scraped_description` | string | pickFollowSellDescription({customDescription: ts.customDescription,...}) |
| 14 | `_aiHashtags` | string[] | extractKeywords()（length>0 才发） |
| 15 | `scraped_sku` | string | `String(v.sku)` |
| 16 | `scraped_brand` | string | UI `brandChoice`（'no_brand'/'copy'/...） |
| 17 | `scraped_brand_value` | string ‖ undefined | copy 模式且 _sourceBrand 时发 |
| 18 | `scraped_model_name` | string ‖ undefined | UI `mergeModel`（attr 9048） |
| 19 | `_sourceVariant` | object ‖ undefined | sourceMap.get(sku) |
| 20 | `weight` | number ‖ undefined | userWeight ‖ sv[4497] ‖ sv[4383]×1000 |
| 21 | `weight_unit` | `'g'` ‖ undefined | weight!=null 时 |
| 22 | `depth` | number ‖ undefined | userDepth ‖ sv[9454] |
| 23 | `width` | number ‖ undefined | userWidth ‖ sv[9455] |
| 24 | `height` | number ‖ undefined | userHeight ‖ sv[9456] |
| 25 | `dimension_unit` | `'mm'` ‖ undefined | 任一维度!=null 时 |
| 26-29 | `scraped_weight/depth/width/height` | number ‖ undefined | pageScrapedDims（DOM 兜底） |
| 30 | `_stock` | number | UI `.ozon-helper-mv-stock` ‖ 0 |

## 三、synthesizedItems 字段（B，共 25 个）

所有字段被 `sf()` 包装为 `{value, source, sourceDetail?, collectedAt}` 结构。

| # | 字段 | value 取值 | source |
|---|------|-----------|--------|
| 1 | `offer_id` | `SKU${cv.sku.value}` | computed |
| 2 | `name` | cv.name（透传） | 同 cv.name |
| 3 | `price` | `Number(cv.price.value).toFixed(2)` | cv.price |
| 4 | `old_price` | `Number(cv.oldPrice.value ‖ cv.price.value*1.25).toFixed(2)` | cv.oldPrice |
| 5 | `currency_code` | `'CNY'` | computed（硬编码） |
| 6 | `vat` | `'0'` | computed |
| 7 | `images` | cv.images（string[]） | 同 cv.images |
| 8 | `bundleComplexAttrs` | cv.bundleComplexAttrs | 同 |
| 9 | `videoUrl` | cv.videoUrl | 同 |
| 10 | `videoCover` | cv.videoCover | 同 |
| 11 | `scraped_breadcrumbs` | cv.breadcrumbs | 同 |
| 12 | `scraped_description` | pickFollowSellDescription({customDescription:'',...}) | computed |
| 13 | `_aiHashtags` | cv.hashtags（length>0）‖ null | 条件 |
| 14 | `scraped_sku` | cv.sku | 同 |
| 15 | `scraped_brand` | `'copy'` | computed（硬编码） |
| 16 | `scraped_brand_value` | cv.brand | 同 |
| 17 | `_sourceVariant` | cv.sourceVariant | 同 |
| 18-21 | `weight/depth/width/height` | cv.weight/depth/width/height | 同 |
| 22-25 | `scraped_weight/depth/width/height` | cv.scrapedDims（4 字段共用同一对象引用） | 同 |

## 四、字段差异对比

### 4.1 真实 items 有、预览缺失（5 个）

| 字段 | 说明 | 严重度 |
|------|------|--------|
| `min_price` | Ozon 自动调价下限，用户在跟卖面板可填 | 中 |
| `scraped_model_name` | attr 9048 型号名，多变体合并关键 | 中 |
| `weight_unit` | 后端兜底 'g'（prepare-bundle.js L464） | 低 |
| `dimension_unit` | 后端兜底 'mm'（prepare-bundle.js L468） | 低 |
| `_stock` | 库存走顶层 stocks，非 item 级也算合理 | 低 |

### 4.2 预览有、真实 items 无

**无。** 预览所有字段在真实 items 中均有对应。

### 4.3 字段名一致但取值/格式不一致

| 字段 | 真实 items | 预览 | 差异类型 |
|------|-----------|------|----------|
| `offer_id` | `SKU{sku}-{Date末4位}` | `SKU{sku}` | 取值不一致（预览无时间戳后缀） |
| `old_price` | UI 输入 ‖ price×1.25 | cv.oldPrice（domProduct.originalPrice，常为 0→退 price×1.25） | 取值来源不同 |
| `currency_code` | UI `currencyCode`（用户可选） | 硬编码 `'CNY'` | 取值不一致 |
| `name` | `looksTranslated` 判定选源 | `jzPreferSourceName`（不同函数） | 取值逻辑不同 |
| `images` | `Array<{file_name,default}>` 对象数组，应用 imageOrder | 字符串 URL 数组 | 类型不一致 + 无 imageOrder |
| `scraped_description` | 带 `ts.customDescription`（用户自定义） | `customDescription:''`（恒空） | 取值不一致 |
| `_aiHashtags` | 纯 string[] | sf 包装对象 | 类型不一致 |
| `scraped_brand` | UI `brandChoice` | 硬编码 `'copy'` | 取值不一致 |
| `scraped_brand_value` | 仅 copy 模式发 | 恒带 brand 值 | 取值逻辑不同 |
| `weight/depth/width/height` | 裸 number，含用户输入优先 | sf 对象，仅 seller-portal 源 | 类型不一致 + 无用户输入 |
| `scraped_weight/depth/width/height` | 裸 number，独立值 | sf 对象，**4 字段共用同一对象引用** | 类型不一致 + 共享引用隐患 |
| `bundleComplexAttrs` | sv ‖ sharedBundleComplex（锚点兜底） | 仅 cv.bundleComplexAttrs | 无锚点兜底 |
| `videoUrl/videoCover` | 条件发 | 恒带（value 可为 null） | 恒带性不同 |
| `_sourceVariant/scraped_breadcrumbs/scraped_sku` | 裸值 | sf 包装对象 | 类型不一致 |

### 4.4 OPI v3 最终 schema 由后端重建的 8 个字段（预览无法直接展示）

后端 `transformItemForPortal` 从 `_sourceVariant` 重建：
- `attributes`（sv.attributes + 4191 描述注入）
- `primary_image`（images[].default 提取）
- `color_image`（硬编码 `''`）
- `images360`（硬编码 `[]`）
- `pdf_list`（硬编码 `[]`）
- `new_description_category_id`（硬编码 `0`）
- `type_id`（bundleItem.type_id ‖ sv.description_category_id）
- `description_category_id`（bundleItem ‖ sv.categories 最深 id）
- `barcode`（sv._searchMeta.barcodes[0]）

## 五、关键结论

1. **5 个字段缺失**：min_price、scraped_model_name、weight_unit、dimension_unit、_stock
2. **全部字段多一层 sf() source 包装**（设计差异，非 bug，用于字段级来源展示）
3. **采集阶段无用户输入**，导致 offer_id/currency_code/scraped_brand/scraped_description/old_price/weight/images 取值与真实上架时不一致
4. **images 类型不同**：预览 string[] vs 真实 `{file_name,default}[]`
5. **OPI 最终 schema 有 8+ 字段**由后端从 `_sourceVariant` 重建，预览无法直接展示

## 六、改进建议

若要让预览更准确反映真实上架请求：

1. 补齐 `min_price`、`scraped_model_name`、`weight_unit`、`dimension_unit`、`_stock` 5 个字段
2. 增加 `barcode`（从 cv.gtin 带，collectedVariants L1829 已有 gtin 但未带入 synthesizedItems）
3. `scraped_weight/depth/width/height` 4 字段改为独立值，不共用同一对象引用
4. 可选：增加 `attributes` 预览（从 _sourceVariant 重建，但体积较大）
