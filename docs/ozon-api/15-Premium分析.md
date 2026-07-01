# Premium分析

> Ozon Seller API — Premium分析
>
> 基础地址：`https://api-seller.ozon.ru`
>
> 认证请求头：`Client-Id`、`Api-Key`、`Content-Type: application/json`

---

## 目录

**Premium**（7）

- `POST` `/v1/analytics/data` — 分析数据
- `POST` `/v1/analytics/product-queries` — 获取商品搜索查询信息
- `POST` `/v1/analytics/product-queries/details` — 有关特定商品查询的信息
- `POST` `/v1/finance/realization/by-day` — 每日商品销售报告
- `POST` `/v1/search-queries/text` — 获取按文本筛选的搜索查询列表
- `POST` `/v1/search-queries/top` — 获取热门搜索查询列表
- `POST` `/v1/product/prices/details` — 获取商品价格的详细信息

**其他方法**（12）

- `POST` `/v1/posting/fbs/split` — 将订单拆分为不带备货的货件
- `POST` `/v1/product/info/warehouse/stocks` — 获取FBS和rFBS仓库库存信息
- `POST` `/v1/product/stairway-discount/by-quantity/set` — 管理按数量折扣
- `POST` `/v1/product/stairway-discount/by-quantity/get` — 获取按数量折扣信息
- `POST` `/v1/finance/balance` — 获取余额报告
- `POST` `/v1/description-category/tips` — 获取用于确定商品类目的提示
- `POST` `/v2/actions/discounts-task/list` — 获取折扣申请列表
- `POST` `/v1/product/visibility/set` — 新增了用于设置商品在Ozon和Ozon Select橱窗可见性的Beta方法。
- `POST` `/v1/finance/accrual/postings` — 获取按货件统计的应计项目
- `POST` `/v1/finance/accrual/types` — 获取应计项目参考信息
- `POST` `/v1/finance/accrual/by-day` — 获取某日应计项目
- `POST` `/v1/product/visibility/info` — 获取商品可见性信息

---

## Premium

### `POST` `/v1/analytics/data`

**分析数据**

`operationId: AnalyticsAPI_AnalyticsGetData`

适用于订阅了 Premium Plus 或 Premium Pro 的卖家。  请指定需要计算的时间段和指标。响应将包含按`dimensions`参数分组的分析。   从一个卖家账号每分钟可以发送1次请求。 与个人中心中的**分析→图表**部分相符。

#### 请求体（`analyticsAnalyticsGetDataRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| date_from | string | 是 | 数据将出现在报告中的日期。  若您没有Premium订阅，请指定过去三个月内的日期。 |
| date_to | string | 是 | 数据将出现在报告中的截止日期。 |
| dimension | array<string> | 是 | 报告中的分组数据。  所有卖家可用的分组方法：   - `unknownDimension` — 未知商品标识符；   - `sku` — 商品标识符；   - `spu` — 商品标识符 — 统一商品卡片；   - `day` — 日；   - `week` — 星期；   - `month` — 月。  只有Premium订阅卖家才能使用的分组方法：   - `year` — 年；   - `... |
| filters | array<object> | 否 | 过滤器。 |
|   filters[].key | string | 否 | 排序参数。 可以传递`dimension` 和 `metric`中的任何属性,  `brand`除外。 |
|   filters[].op |  | 否 |  |
|   filters[].value | string | 否 | 用于对比的值。 |
| limit | integer | 是 | 响应的值个数：  - 最大值 — 1000，  - 最小值 — 1. |
| metrics | array<string> | 是 | 最多指定14个指标。如有更多，您将收到 `InvalidArgument`的错误。  生成报告所依据的指标列表。  所有卖家可用的指标：   - `revenue` — 订购的金额，   - `ordered_units` — 订购的商品。  仅对Premium订阅卖家可用的指标：   - `unknown_metric` — 未知指标。   - `hits_view_search` —  在搜索... |
| offset | integer | 否 | 响应中要跳过的元素数字。例如，如果 `offset = 10`, 那么答案将从找到的第11个元素开始。 |
| sort | array<object> | 否 | 报告排列设置。 |
|   sort[].key | string | 否 | 查询排序结果所依据的指标。 |
|   sort[].order | string | 否 | 分类类型:   - `ASC` — 升序，   - `DESC` — 降序。 |

#### 响应（`analyticsAnalyticsGetDataResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| data | array<object> | 否 | 数据组。 |
|   data[].dimensions | array<object> | 否 | 报告数据分组。 |
|     data[].dimensions[].id | string | 否 | Ozon系统中的商品识别码是SKU。 |
|     data[].dimensions[].name | string | 否 | 命名。 |
|   data[].metrics | array<number> | 否 | 指标值列表。 |
| totals | array<number> | 否 | 指标总计和平均值。 |

---

### `POST` `/v1/analytics/product-queries`

**获取商品搜索查询信息**

`operationId: AnalyticsAPI_AnalyticsProductQueries`

使用该方法可以获取您的商品在 Ozon 平台上的搜索查询信息。完整分析仅对订阅 [Premium](https://global-help.ozon.com/zh/promotion/subscriptions/premium/)、[Premium Plus](https://global-help.ozon.com/zh/promotion/subscriptions/premium-plus/) 或 Premium Pro 的用户开放。未订阅的用户可以查看部分指标。该方法类似于个人中心的 **搜索中的商品 → 我的商品的查询** 选项卡。  您可以按指定日期查看查询分析。为此，需在请求中指定 `date_from` 和 `date_to` 参数。最近一个月的数据可按任意区间查看，但不包含当天的数据——相关数据需 1–2 天完成计算后才会更新。一个月之前的数据仅对订阅 [Premium](https://global-help.ozon.com/zh/promotion/subscriptions/premium/)、[Premium Plus](https://global-hel...

#### 请求体（`v1AnalyticsProductQueriesRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| date_from | string | 是 | 分析数据的起始日期。 |
| date_to | string | 否 | 分析数据的结束日期。 |
| page | integer | 否 | 请求返回的页码。 |
| page_size | integer | 是 | 每页包含的商品数量。 |
| skus | array<string> | 是 | SKU 列表，即 Ozon 系统中的商品标识符。根据这些 SKU 返回搜索查询的分析数据。最多可查询 1000 个 SKU。 |
| sort_by | string | 否 | 按具体参数对商品进行排序。可能的取值： - `BY_SEARCHES`— 按搜索次数； - `BY_VIEWS`— 按浏览量； - `BY_POSITION`— 按商品的平均排名； - `BY_CONVERSION`— 按转化率； - `BY_GMV` — 按搜索查询的销售额。 |
| sort_dir | string | 否 | 排序方向： - `DESCENDING`— 降序； - `ASCENDING`— 升序。 |

#### 响应（`v1AnalyticsProductQueriesResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| analytics_period | object | 否 | 数据分析的时间范围。 |
|   analytics_period.date_from | string | 否 | 分析数据的起始日期。 |
|   analytics_period.date_to | string | 否 | 分析数据的结束日期。 |
| items | array<object> | 否 | 商品列表。 |
|   items[].category | string | 否 | 类目名称。 |
|   items[].currency | string | 否 | 货币单位。 |
|   items[].gmv | number | 否 | 搜索查询的销售额。 |
|   items[].name | string | 否 | 商品名称。 |
|   items[].offer_id | string | 否 | 卖家系统中的商品标识符（商品编号）。 |
|   items[].position | number | 否 | 商品的平均排名。仅适用于[Premium](https://seller-edu.ozon.ru/seller-rating/about-rating/premium-program) 或 [Premium Plus](https://seller-edu.ozon.ru/seller-rating/about-rating/subscription-premium-plus) 订阅，否则该字段为... |
|   items[].sku | integer | 否 | Ozon 系统中的商品标识符（SKU）。 |
|   items[].unique_search_users | integer | 否 | 在 Ozon 平台上搜索该商品的买家数量。 |
|   items[].unique_view_users | integer | 否 | 在 Ozon 平台上看到该商品的买家数量。仅适用于[Premium](https://seller-edu.ozon.ru/seller-rating/about-rating/premium-program) 或 [Premium Plus](https://seller-edu.ozon.ru/seller-rating/about-rating/subscription-premium-pl... |
|   items[].view_conversion | number | 否 | 商品的转化率。 仅适用于[Premium](https://seller-edu.ozon.ru/seller-rating/about-rating/premium-program) 或 [Premium Plus](https://seller-edu.ozon.ru/seller-rating/about-rating/subscription-premium-plus) 订阅，否则该字段为... |
| page_count | integer | 否 | 总页数。 |
| total | integer | 否 | 搜索请求的总数。 |

---

### `POST` `/v1/analytics/product-queries/details`

**有关特定商品查询的信息**

`operationId: AnalyticsAPI_AnalyticsProductQueriesDetails`

使用该方法获取特定商品的查询数据。完整分析仅对订阅 [Premium](https://global-help.ozon.com/zh/promotion/subscriptions/premium/)、[Premium Plus](https://global-help.ozon.com/zh/promotion/subscriptions/premium-plus/) 或 Premium Pro 的用户开放。未订阅的用户可以查看部分指标。该方法与在个人中心的 **搜索中的商品 → 我的商品查询** 选项卡查看商品数据类似。  您可以按指定日期查看查询分析。为此，需在请求中指定 `date_from` 和 `date_to` 参数。最近一个月的数据可按任意区间查看，但不包含当天的数据——相关数据需 1–2 天完成计算后才会更新。一个月之前的数据仅对订阅 [Premium](https://global-help.ozon.com/zh/promotion/subscriptions/premium/)、[Premium Plus](https://global-help.ozon.c...

#### 请求体（`v1AnalyticsProductQueriesDetailsRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| date_from | string | 是 | 分析数据的起始日期。 |
| date_to | string | 否 | 分析数据的结束日期。 |
| limit_by_sku | integer | 是 | 单个SKU的查询数量限制。最大值为15次查询。 |
| page | integer | 否 | 请求返回的页码。最小值为0。 |
| page_size | integer | 是 | 每页包含的商品数量。最大值为100。 |
| skus | array<string> | 是 | SKU 列表，即 Ozon 系统中的商品标识符。根据这些 SKU 返回搜索查询的分析数据。最多可查询 1000 个 SKU。 |
| sort_by | string | 否 | 按具体参数对商品进行排序。可能的取值： - `BY_SEARCHES`— 按搜索次数； - `BY_VIEWS`— 按浏览量； - `BY_POSITION`— 按商品的平均排名； - `BY_CONVERSION`— 按转化率； - `BY_GMV` — 按搜索查询的销售额。  只有 [Premium](https://seller-edu.ozon.ru/seller-rating/about... |
| sort_dir | string | 否 | 排序方向： - `DESCENDING`— 降序； - `ASCENDING`— 升序。 |

#### 响应（`v1AnalyticsProductQueriesDetailsResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| analytics_period | object | 否 | 数据分析的时间范围。 |
|   analytics_period.date_from | string | 否 | 分析数据的起始日期。 |
|   analytics_period.date_to | string | 否 | 分析数据的结束日期。 |
| page_count | integer | 否 | 总页数。 |
| queries | array<object> | 否 | 查询列表。 |
|   queries[].currency | string | 否 | 货币单位。 |
|   queries[].gmv | number | 否 | 搜索查询的销售额。 |
|   queries[].order_count | integer | 否 | 根据查询的订单数量。 |
|   queries[].position | number | 否 | 商品的平均排名。仅适用于[Premium](https://seller-edu.ozon.ru/seller-rating/about-rating/premium-program) 或 [Premium Plus](https://seller-edu.ozon.ru/seller-rating/about-rating/subscription-premium-plus) 订阅，否则该字段为... |
|   queries[].query | string | 否 | 请求文本。 |
|   queries[].query_index | integer | 否 | 查询序号。 |
|   queries[].sku | integer | 否 | Ozon 系统中的商品标识符（SKU）。 |
|   queries[].unique_search_users | integer | 否 | 在 Ozon 平台上搜索该商品的买家数量。 |
|   queries[].unique_view_users | integer | 否 | 在 Ozon 平台上看到该商品的买家数量。仅适用于[Premium](https://seller-edu.ozon.ru/seller-rating/about-rating/premium-program) 或 [Premium Plus](https://seller-edu.ozon.ru/seller-rating/about-rating/subscription-premium-pl... |
|   queries[].view_conversion | number | 否 | 商品的转化率。 仅适用于[Premium](https://seller-edu.ozon.ru/seller-rating/about-rating/premium-program) 或 [Premium Plus](https://seller-edu.ozon.ru/seller-rating/about-rating/subscription-premium-plus) 订阅，否则该字段为... |
| total | integer | 否 | 搜索请求的总数。 |

---

### `POST` `/v1/finance/realization/by-day`

**每日商品销售报告**

`operationId: FinanceAPI_GetRealizationByDayReportV1`

该方法返回每日[商品销售报告](#operation/FinanceAPI_GetRealizationReportV2)中的销售金额数据。不包括取消和无人认领的订单。数据仅可获取从当前日期起最多32个自然日之内的记录。此方法仅对 Premium Plus 或 Premium Pro 订阅的用户开放。

#### 请求体（`v1GetRealizationReportByDayRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| day | integer | 是 | 日。 |
| month | integer | 是 | 月。 |
| year | integer | 是 | 年。 |

#### 响应（`GetRealizationReportByDayResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| rows | array<object> | 否 | 报告表格。 |
|   rows[].commission_ratio | number | 否 | 按类目划分的销售佣金比例。 |
|   rows[].delivery_commission | object | 否 | 配送佣金。 |
|     rows[].delivery_commission.amount | number | 否 | 金额。 |
|     rows[].delivery_commission.bonus | number | 否 | 折扣积分。 |
|     rows[].delivery_commission.commission | number | 否 | 将折扣和附加费考虑在内的总佣金。  适用于 2024 年 4 月 30 日之前生成的报告。 |
|     rows[].delivery_commission.compensation | number | 否 | Ozon 负责的补付额。  适用于 2024 年 4 月 30 日之前生成的报告。 |
|     rows[].delivery_commission.price_per_instance | number | 否 | 每件价格。 |
|     rows[].delivery_commission.quantity | integer | 否 | 商品数量。 |
|     rows[].delivery_commission.standard_fee | number | 否 | Ozon基础奖励。 |
|     rows[].delivery_commission.bank_coinvestment | number | 否 | 合作伙伴忠诚机制付款：绿色价格。 |
|     rows[].delivery_commission.stars | number | 否 | 合作伙伴忠诚度机制付款：星星。 |
|     rows[].delivery_commission.total | number | 否 | 应计总额。 |
|   rows[].item | object | 否 | 商品信息。 |
|     rows[].item.barcode | string | 否 | 商品条形码。 |
|     rows[].item.name | string | 否 | 商品名称。 |
|     rows[].item.offer_id | string | 否 | 卖家系统中的商品标识符是商品货号。 |
|     rows[].item.sku | integer | 否 | Ozon系统中的商品识别码是SKU。 |
|   rows[].return_commission | object | 否 | 商品退货佣金。 |
|     rows[].return_commission.amount | number | 否 | 金额。 |
|     rows[].return_commission.bonus | number | 否 | 折扣积分。 |
|     rows[].return_commission.commission | number | 否 | 将折扣和附加费考虑在内的总佣金。  适用于 2024 年 4 月 30 日之前生成的报告。 |
|     rows[].return_commission.compensation | number | 否 | Ozon 负责的补付额。  适用于 2024 年 4 月 30 日之前生成的报告。 |
|     rows[].return_commission.price_per_instance | number | 否 | 每件价格。 |
|     rows[].return_commission.quantity | integer | 否 | 商品数量。 |
|     rows[].return_commission.standard_fee | number | 否 | Ozon基础奖励。 |
|     rows[].return_commission.bank_coinvestment | number | 否 | 合作伙伴忠诚机制付款：绿色价格。 |
|     rows[].return_commission.stars | number | 否 | 合作伙伴忠诚度机制付款：星星。 |
|     rows[].return_commission.total | number | 否 | 应计总额。 |
|   rows[].rowNumber | integer | 否 | 报告中的行号。 |
|   rows[].seller_price_per_instance | number | 否 | 考虑折扣后的卖家价格。 |

---

### `POST` `/v1/search-queries/text`

**获取按文本筛选的搜索查询列表**

`operationId: SearchQueriesAPI_SearchQueriesText`

仅对拥有Premium Pro订阅的卖家开放。

#### 请求体（`v1SearchQueriesTextRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| limit | string | 是 | 每页的结果数量。 |
| offset | string | 是 | 响应中将被跳过的项目数量。 |
| sort_by | string | 否 | 排序搜索查询的参数： - `CLIENT_COUNT`——查询的受欢迎程度； - `ADD_TO_CART`——添加到购物车的次数； - `CONVERSION_TO_CART`——购物车转化率； - `AVG_PRICE`——平均价格。 |
| sort_dir | string | 否 | 排序方向： - `ASC`——升序； - `DESC`——降序。 |
| text | string | 是 | 按文本搜索。 |

#### 响应（`v1SearchQueriesTextResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| offset | string | 否 | К每页显示的搜索查询数量。 |
| search_queries | array<object> | 否 | 搜索查询信息。 |
|   search_queries[].add_to_cart | number | 否 | 将至少 1 件商品添加到购物车的买家数量。 |
|   search_queries[].avg_price | number | 否 | 商品的平均价格（以卢布计）。 |
|   search_queries[].client_count | number | 否 | 通过该,搜索查询 查找商品的买家数量。 |
|   search_queries[].conversion_to_cart | number | 否 | 将至少 1 件商品添加到购物车的买家比例。 |
|   search_queries[].items_views | number | 否 | 商品的浏览次数。 |
|   search_queries[].query | string | 否 | 搜索查询。 |
|   search_queries[].sellers_count | number | 否 | 买家根据该搜索查询查看其商品的平均卖家数量。 |
| total | string | 否 | 搜索查询总数。 |

---

### `POST` `/v1/search-queries/top`

**获取热门搜索查询列表**

`operationId: SearchQueriesAPI_SearchQueriesTop`

仅对拥有Premium Pro订阅的卖家开放。

#### 请求体（`v1SearchQueriesTopRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| limit | string | 是 | 每页的结果数量。 |
| offset | string | 是 | 响应中将被跳过的项目数量。 |

#### 响应（`v1SearchQueriesTopResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| offset | string | 否 | 每页显示的搜索查询数量。 |
| search_queries | array<object> | 否 | 搜索查询信息。 |
|   search_queries[].add_to_cart | number | 否 | 将至少 1 件商品添加到购物车的买家数量。 |
|   search_queries[].avg_price | number | 否 | 商品的平均价格（以卢布计）。 |
|   search_queries[].client_count | number | 否 | 通过该,搜索查询 查找商品的买家数量。 |
|   search_queries[].conversion_to_cart | number | 否 | 将至少 1 件商品添加到购物车的买家比例。 |
|   search_queries[].items_views | number | 否 | 商品的浏览次数。 |
|   search_queries[].query | string | 否 | 搜索查询。 |
|   search_queries[].sellers_count | number | 否 | 买家根据该搜索查询查看其商品的平均卖家数量。 |
| total | string | 否 | 搜索查询总数。 |

---

### `POST` `/v1/product/prices/details`

**获取商品价格的详细信息**

`operationId: ProductPricesDetails`

仅对 Premium Pro 订阅的卖家开放。

#### 请求体（`v1ProductPricesDetailsRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| skus | array<string> | 是 | SKU列表。 |

#### 响应（`v1ProductPricesDetailsResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| prices | array<object> | 否 | 商品价格。 |
|   prices[].customer_price | object | 否 | 网站上的商品价格。 |
|     prices[].customer_price.amount | string | 否 | 金额。 |
|     prices[].customer_price.currency | string | 否 | 货币单位。 |
|   prices[].discount_percent | number | 否 | 由 Ozon 承担的折扣比例。 |
|   prices[].offer_id | string | 否 | 卖家系统中的商品标识符（商品货号）。 |
|   prices[].price | object | 否 | 商品价格（已包含促销活动或推广优惠）。 |
|     prices[].price.amount | string | 否 | 金额。 |
|     prices[].price.currency | string | 否 | 货币单位。 |
|   prices[].price_indexes | array<object> | 否 | 价格指数。 |
|     prices[].price_indexes[].external_index_data | object | 否 | 竞争对手商品价格。 |
|       prices[].price_indexes[].external_index_data.min_price | money.Money | 否 |  |
|       prices[].price_indexes[].external_index_data.price_index | number | 否 | 价格指数。 |
|       prices[].price_indexes[].external_index_data.url | string | 否 | 竞争对手商品链接。 |
|     prices[].price_indexes[].self_index_data | object | 否 | 您的商品价格。 |
|       prices[].price_indexes[].self_index_data.min_price | money.MoneySelf | 否 |  |
|       prices[].price_indexes[].self_index_data.price_index | number | 否 | 价格指数。 |
|       prices[].price_indexes[].self_index_data.url | string | 否 | 您的商品链接。 |
|   prices[].sku | integer | 否 | Ozon 系统中的商品标识符——SKU。 |

---

## 其他方法

### `POST` `/v1/posting/fbs/split`

**将订单拆分为不带备货的货件**

`operationId: FbsSplit`

您可以在 [讨论](https://dev.ozon.ru/community/1068-Razdelenie-otpravleniia-na-neskolko) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 响应（`v1PostingFbsSplitResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| parent_posting | object | 否 | 原始货件的信息。 |
|   parent_posting.posting_number | string | 否 | 原始货件编号。 |
|   parent_posting.products | array<object> | 否 | 货件中的商品列表。 |
|     parent_posting.products[].product_id | integer | 是 | Ozon系统中的商品标识符 — SKU。 |
|     parent_posting.products[].quantity | integer | 是 | 数量。 |
| postings | array<object> | 否 | 订单被拆分后的货件列表。 |
|   postings[].posting_number | string | 否 | 货件编号。 |
|   postings[].products | array<object> | 否 | 货件中的商品列表。 |
|     postings[].products[].product_id | integer | 是 | Ozon系统中的商品标识符 — SKU。 |
|     postings[].products[].quantity | integer | 是 | 数量。 |

---

### `POST` `/v1/product/info/warehouse/stocks`

**获取FBS和rFBS仓库库存信息**

`operationId: ProductInfoWarehouseStocks`

您可以在 [讨论](https://dev.ozon.ru/community/1716-Novyi-metod-dlia-polucheniia-ostatkov-na-sklade-FBS-rFBS/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1ProductInfoWarehouseStocksRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| limit | integer | 是 | 每页显示的数量。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1ProductInfoWarehouseStocksResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 如果该参数为空，则没有更多数据了。 |
| has_next | boolean | 否 | 标记是否返回了所有商品： - `true`——请使用不同的`cursor`值重新请求，以获取剩余的值； - `false`——响应中已包含所有值。 |
| stocks | array<object> | 否 | 商品库存信息。 |
|   stocks[].free_stock | integer | 否 | 仓库中可供下单的商品数量。 |
|   stocks[].offer_id | string | 否 | 卖家系统中的商品标识符——`offer_id`。 |
|   stocks[].present | integer | 否 | 仓库中的商品总数量。 |
|   stocks[].product_id | integer | 否 | Ozon系统中商品的标识符 — `product_id`。 |
|   stocks[].reserved | integer | 否 | 仓库中已预留商品的数量。 |
|   stocks[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|   stocks[].updated_at | string | 否 | 商品的最后更新时间。 |
|   stocks[].warehouse_id | integer | 否 | 仓库标识符。 |

---

### `POST` `/v1/product/stairway-discount/by-quantity/set`

**管理按数量折扣**

`operationId: ProductAPI_SetProductStairwayDiscountByQuantity`

根据订单中商品数量设置或删除商品折扣。  您可以在 [讨论](https://dev.ozon.ru/community/1719-Novye-metody-dlia-raboty-so-skidkoi-ot-kolichestva/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1SetProductStairwayDiscountByQuantityRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| stairways | array<object> | 是 | 多个商品的按数量折扣信息。 |
|   stairways[].enabled | boolean | 是 | `true`，表示启用折扣。 |
|   stairways[].sku | integer | 是 | Ozon系统中的商品标识符——SKU。 |
|   stairways[].stairway | object | 是 | 按数量折扣等级信息。 |
|     stairways[].stairway.steps | array<object> | 是 | 折扣等级信息。等级数量可为1到4。 |
|       stairways[].stairway.steps[].discount | integer | 是 | 折扣百分比。 |
|       stairways[].stairway.steps[].quantity | integer | 是 | 订单中用于应用折扣的商品数量。 |
|       stairways[].stairway.steps[].step | integer | 是 | 折扣等级。 |
| suppress_warnings | boolean | 否 | 传递 `true` 可忽略警告并设置折扣。 |

#### 响应（`v1SetProductStairwayDiscountByQuantityResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| accepted | boolean | 否 | `true`，表示请求已接收。请使用方法[/v1/product/stairway-discount/by-quantity/get](#operation/ProductAPI_GetProductStairwayDiscountByQuantity)来查看折扣修改结果。 |
| errors | array<object> | 否 | 错误描述。 |
|   errors[].data | array<object> | 否 | 错误或警告描述。 |
|     errors[].data[].code | string | 否 | 代码。 |
|     errors[].data[].field | string | 否 | 原因。 |
|     errors[].data[].message | string | 否 | 文字描述。 |
|     errors[].data[].step | integer | 否 | 折扣等级。 |
|     errors[].data[].value | string | 否 | 出现错误字段的值。 |
|   errors[].sku | integer | 否 | Ozon系统中的商品识别符——SKU。 |
| warnings | array<object> | 否 | 警告描述。 |
|   warnings[].data | array<object> | 否 | 错误或警告描述。 |
|     warnings[].data[].code | string | 否 | 代码。 |
|     warnings[].data[].field | string | 否 | 原因。 |
|     warnings[].data[].message | string | 否 | 文字描述。 |
|     warnings[].data[].step | integer | 否 | 折扣等级。 |
|     warnings[].data[].value | string | 否 | 出现错误字段的值。 |
|   warnings[].sku | integer | 否 | Ozon系统中的商品识别符——SKU。 |

---

### `POST` `/v1/product/stairway-discount/by-quantity/get`

**获取按数量折扣信息**

`operationId: ProductAPI_GetProductStairwayDiscountByQuantity`

返回根据订单中商品数量计算的商品折扣信息。  您可以在 [讨论](https://dev.ozon.ru/community/1719-Novye-metody-dlia-raboty-so-skidkoi-ot-kolichestva/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1GetProductStairwayDiscountByQuantityRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| skus | array<string> | 是 | 需要返回内容评级的商品SKU列表。 |

#### 响应（`v1GetProductStairwayDiscountByQuantityResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| stairways | array<object> | 否 | 单个商品的按数量折扣信息。 |
|   stairways[].enabled | boolean | 否 | `true`，表示数量折扣已启用。 |
|   stairways[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|   stairways[].stairway | object | 否 | 按数量折扣等级信息。 |
|     stairways[].stairway.steps | array<object> | 否 | 折扣等级信息。 |
|       stairways[].stairway.steps[].discount | integer | 否 | 折扣百分比。 |
|       stairways[].stairway.steps[].quantity | integer | 否 | 订单中用于应用折扣的商品数量。 |
|       stairways[].stairway.steps[].step | integer | 否 | 折扣等级。 |
|   stairways[].status | string | 否 | 按数量折扣变更状态。可能的取值： - `ERROR`——修改折扣时出错。请再次调用方法 [/v1/product/stairway-discount/by-quantity/set](#operation/ProductAPI_SetProductStairwayDiscountByQuantity)。 - `IN_PROCESS`——修正正在处理中。 - `SUCCESS`——折扣修改已成功应用... |

---

### `POST` `/v1/finance/balance`

**获取余额报告**

`operationId: GetFinanceBalanceV1`

对应卖家个人中心 **财务 → 余额** 模块。  您可以在 [讨论](https://dev.ozon.ru/community/1732-Novyi-metod-polucheniia-dannykh-po-balansu/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1GetFinanceBalanceV1Request`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| date_from | string | 是 | 报告期开始日期，格式为 `YYYY-MM-DD`。 |
| date_to | string | 是 | 报告期结束日期，格式为 `YYYY-MM-DD`。`date_from` 与 `date_to` 之间的最⻓间隔为30 天。 |

#### 响应（`v1GetFinanceBalanceV1Response`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cashflows | object | 否 | 收入和支出信息。 |
|   cashflows.returns | object | 否 | 退货应计金额。 |
|     cashflows.returns.amount | object | 否 | 退货金额。 |
|       cashflows.returns.amount.currency_code | string | 否 | 货币单位。 |
|       cashflows.returns.amount.value | number | 否 | 金额。 |
|     cashflows.returns.amount_details | object | 否 | 退货金额明细。 |
|       cashflows.returns.amount_details.partner_programs | object | 否 | 合作伙伴忠诚度机制的付款。 |
|       cashflows.returns.amount_details.points_for_discounts | string | 否 | 折扣积分。 |
|       cashflows.returns.amount_details.revenue | object | 否 | 买家支付的金额。 |
|     cashflows.returns.fee | object | 否 | Ozon 代理费金额。 |
|       cashflows.returns.fee.currency_code | string | 否 | 货币单位。 |
|       cashflows.returns.fee.value | number | 否 | 金额。 |
|   cashflows.sales | object | 否 | 销售应计金额。 |
|     cashflows.sales.amount | object | 否 | 销售金额。 |
|       cashflows.sales.amount.currency_code | string | 否 | 货币单位。 |
|       cashflows.sales.amount.value | number | 否 | 金额。 |
|     cashflows.sales.amount_details | object | 否 | 销售金额明细。 |
|       cashflows.sales.amount_details.partner_programs | object | 否 | 合作伙伴忠诚度机制的付款。 |
|       cashflows.sales.amount_details.points_for_discounts | string | 否 | 折扣积分。 |
|       cashflows.sales.amount_details.revenue | object | 否 | 买家支付的金额。 |
|     cashflows.sales.fee | object | 否 | Ozon 代理费金额。 |
|       cashflows.sales.fee.currency_code | string | 否 | 货币单位。 |
|       cashflows.sales.fee.value | number | 否 | 金额。 |
|   cashflows.services | array<object> | 否 | 其他服务的应计金额。 |
|     cashflows.services[].amount | object | 否 | 其他服务的应计金额。 |
|       cashflows.services[].amount.currency_code | string | 否 | 货币单位。 |
|       cashflows.services[].amount.value | number | 否 | 金额。 |
|     cashflows.services[].name | string | 否 | 服务的系统名称。 |
| total | object | 否 | 周期内的余额总体数据。 |
|   total.accrued | object | 否 | 周期内已应计金额。 |
|     total.accrued.currency_code | string | 否 | 货币单位。 |
|     total.accrued.value | number | 否 | 金额。 |
|   total.closing_balance | object | 否 | 期末余额。 |
|     total.closing_balance.currency_code | string | 否 | 货币单位。 |
|     total.closing_balance.value | number | 否 | 金额。 |
|   total.opening_balance | object | 否 | 期初余额。 |
|     total.opening_balance.currency_code | string | 否 | 货币单位。 |
|     total.opening_balance.value | number | 否 | 金额。 |
|   total.payments | array<object> | 否 | 周期内的付款。 |
|     total.payments[].currency_code | string | 否 | 货币单位。 |
|     total.payments[].value | number | 否 | 金额。 |

---

### `POST` `/v1/description-category/tips`

**获取用于确定商品类目的提示**

`operationId: DescriptionCategoryTips`

您可以在 [讨论](https://dev.ozon.ru/community/1963-Novyi-metod-dlia-raboty-s-polucheniem-podskazok-v-Dereve-kategorii-i-tipov-tovarov/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1DescriptionCategoryTipsRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| type_id | array<string> | 否 | 商品类型标识符。可通过方法 [/v1/description-category/tree](#operation/DescriptionCategoryAPI_GetTree)获取。 |

#### 响应（`v1DescriptionCategoryTipsResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| images_url | array<string> | 否 | 相似商品图片链接。 |
| info_url | string | 否 | 指向Ozon商品橱窗的链接，其中包含相似商品及其信息。 |
| type_id | integer | 否 | 商品类型标识符。 |

---

### `POST` `/v2/actions/discounts-task/list`

**获取折扣申请列表**

`operationId: GetDiscountTaskListV2`

返回买家希望以折扣价格购买的商品列表。  您可以在 [讨论](https://dev.ozon.ru/community/1856-Novye-metody-dlia-raboty-s-polucheniem-Spiska-zaiavok-na-skidku/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v2GetDiscountTaskListV2Request`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| last_id | integer | 否 | 页面上最后一个值的标识符。首次请求请留空。 |
| limit | integer | 否 | 每页最大申请数量。 |
| status | string | 否 | 折扣申请状态：   - `ALL`——全部状态，   - `NEW`——新建，   - `APPROVED`——已批准，   - `DECLINED`——已拒绝。 |

#### 响应（`v2GetDiscountTaskListV2Response`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| tasks | array<object> | 否 | 申请列表。 |
|   tasks[].approved_discount | number | 否 | 卖家批准的折扣金额（卢布）。如果卖家未批准申请，请传入 `0`。 |
|   tasks[].approved_price | number | 否 | 批准价格。 |
|   tasks[].approved_quantity_max | integer | 否 | 批准的最大商品数量。 |
|   tasks[].auto_moderated_info | object | 否 | 申请自动审核信息。 |
|     tasks[].auto_moderated_info.max_percent | number | 否 | 可批准的最大折扣。 |
|     tasks[].auto_moderated_info.max_price | number | 否 | 申请中的价格。 |
|     tasks[].auto_moderated_info.min_percent | number | 否 | 可批准的最小折扣。 |
|     tasks[].auto_moderated_info.min_price | number | 否 | 可批准的最低价格。 |
|   tasks[].created_at | string | 否 | 申请创建日期。 |
|   tasks[].edited_till | string | 否 | 可修改决定的时间。 |
|   tasks[].edited_till_duration | integer | 否 | 可修改决定的时间（秒）。 |
|   tasks[].email | string | 否 | 处理申请的卖家员工邮箱地址。 |
|   tasks[].end_at | string | 否 | 申请有效期结束时间。 |
|   tasks[].end_at_duration | integer | 否 | 申请有效期结束时间（秒）。 |
|   tasks[].first_name | string | 否 | 处理申请的卖家员工名字。 |
|   tasks[].id | integer | 否 | 申请标识符。 |
|   tasks[].is_auto_moderated | boolean | 否 | `true`，表示审核为自动审核。 |
|   tasks[].last_name | string | 否 | 处理申请的卖家员工姓氏。 |
|   tasks[].min_auto_price | number | 否 | 自动应用折扣与促销后的最低价格值。 |
|   tasks[].moderated_at | string | 否 | 审核日期：查看、批准或拒绝申请的日期。 |
|   tasks[].name | string | 否 | 商品名称。 |
|   tasks[].original_price | number | 否 | 商品在所有折扣前的价格。 |
|   tasks[].patronymic | string | 否 | 处理申请的卖家员工父名（中间名）。 |
|   tasks[].reduction_factor | number | 否 | 创建申请时买家价格与卖家价格之间的差值。 |
|   tasks[].requested_discount | number | 否 | 折扣百分比。 |
|   tasks[].requested_price | number | 否 | 申请价格。 |
|   tasks[].requested_quantity_max | integer | 否 | 请求的最大商品数量。 |
|   tasks[].sku | integer | 否 | Ozon 系统中的商品标识符——SKU。 |
|   tasks[].status | string | 否 | 折扣申请状态：   - `ALL`——全部状态，   - `NEW`——新建，   - `APPROVED`——已批准，   - `DECLINED`——已拒绝。 |

---

### `POST` `/v1/product/visibility/set`

**新增了用于设置商品在Ozon和Ozon Select橱窗可见性的Beta方法。**

`operationId: ProductVisibilitySet`

该方法适用于已开通Ozon Select的卖家。  您可以在 [讨论](https://dev.ozon.ru/community/1951-Novyi-metod-upravleniia-vidimostiu-na-vitrinakh/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`product.v1.ProductVisibilitySetRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| item_placement | array<object> | 是 | 商品可见性信息。 |
|   item_placement[].placement | string | 是 | 商品投放平台：  - `OZON`——仅在Ozon。  - `SELECT`——仅在Select。  [在卖家知识库中了解更多关于Ozon Select的信息](https://seller-edu.ozon.ru/libra/ozon-select)  - `OZON_SELECT`——在Select和Ozon。 |
|   item_placement[].sku | integer | 是 | Ozon系统中的商品标识符——SKU。 |

#### 响应（`product.v1.ProductVisibilitySetResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| items | array<object> | 否 | 商品可见性信息。 |
|   items[].select_permission | string | 否 | 商品在Ozon Select上的销售权限：   - `UNSPECIFIED`——未指定；   - `RESTRICTED`——商品不可销售；   - `ALLOWED`——商品可以销售。 |
|   items[].seller_item_placement | string | 否 | 卖家设置的可见性取值：   - `UNSPECIFIED`——未指定；   - `OZON`——仅在Ozon展示；   - `SELECT`——仅在Select展示；   - `OZON_SELECT`——在Select和Ozon展示。 |
|   items[].seller_item_placement_list | array<string> | 否 | 卖家设置的可见性取值列表： - `UNSPECIFIED`——未指定； - `OZON`——仅在Ozon展示； - `SELECT`——仅在Select展示。 |
|   items[].showcases_visibility | string | 否 | 商品展示在哪些橱窗中：   - `UNSPECIFIED`——未指定；   - `OZON`——仅在Ozon展示；   - `SELECT`——仅在Select展示；   - `OZON_SELECT`——在Select和Ozon展示；   - `NONE`——商品在所有橱窗均隐藏。 |
|   items[].showcases_visibility_list | array<string> | 否 | 商品展示所在的橱窗列表：  - `UNSPECIFIED`——未指定；  - `OZON`——仅在Ozon展示；  - `SELECT`——仅在Select展示。 |
|   items[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|   items[].warnings | array<string> | 否 | 警告。 |
| items_errors | array<object> | 否 | 存在错误的商品。 |
|   items_errors[].code | string | 否 | 错误代码。 |
|   items_errors[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |

---

### `POST` `/v1/finance/accrual/postings`

**获取按货件统计的应计项目**

`operationId: GetFinanceAccrualPostings`

您可以在 [讨论](https://dev.ozon.ru/community/2008-Novye-beta-metody-dlia-polucheniia-nachislenii/)的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`finance.v1.GetFinanceAccrualPostingsRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_numbers | array<string> | 是 | 货件编号。 |

#### 响应（`finance.v1.GetFinanceAccrualPostingsResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_accruals | array<object> | 否 | 按货件统计的应计项目列表。 |
|   posting_accruals[].accruals | array<object> | 否 | 应计项目列表。 |
|     posting_accruals[].accruals[].accrual_date | string | 否 | 应计日期。 |
|     posting_accruals[].accruals[].accrued | object | 否 | 服务应计金额。 |
|       posting_accruals[].accruals[].accrued.amount | string | 否 | 金额。数值可以为负数。 |
|       posting_accruals[].accruals[].accrued.currency | string | 否 | 货币单位。 |
|     posting_accruals[].accruals[].quantity | integer | 否 | 商品数量。 |
|     posting_accruals[].accruals[].seller_price | object | 否 | 单价。 |
|       posting_accruals[].accruals[].seller_price.amount | string | 否 | 金额。如果计入的是销售佣金，数值可以为负数。 |
|       posting_accruals[].accruals[].seller_price.currency | string | 否 | 货币单位。 |
|     posting_accruals[].accruals[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|     posting_accruals[].accruals[].type_id | integer | 否 | 应计类型标识符。可通过方法[/v1/finance/accrual/types](#operation/GetFinanceAccrualTypes)获取。 |
|   posting_accruals[].posting_number | string | 否 | 货件编号。 |

---

### `POST` `/v1/finance/accrual/types`

**获取应计项目参考信息**

`operationId: GetFinanceAccrualTypes`

您可以在 [讨论](https://dev.ozon.ru/community/2008-Novye-beta-metody-dlia-polucheniia-nachislenii/)的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 响应（`finance.v1.GetFinanceAccrualTypesResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| accrual_types | array<object> | 否 | 应计项目相关信息。 |
|   accrual_types[].description | string | 否 | 应计项目说明。 |
|   accrual_types[].id | integer | 否 | 应计项目标识符。 |
|   accrual_types[].name | string | 否 | 应计项目名称。 |

---

### `POST` `/v1/finance/accrual/by-day`

**获取某日应计项目**

`operationId: GetFinanceAccrualByDay`

您可以在 [讨论](https://dev.ozon.ru/community/2008-Novye-beta-metody-dlia-polucheniia-nachislenii/)的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`finance.v1.GetFinanceAccrualByDayRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| date | string | 是 | 应计日期。最早可查询日期为2022年1月1日。 |
| last_id | string | 是 | 页面上最后一个值的标识符。首次请求请留空。  要获取后续值，请指定上一次请求响应中的 `last_id`。 |

#### 响应（`finance.v1.GetFinanceAccrualByDayResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| accruals | array<object> | 否 | 应计项目列表。 |
|   accruals[].accrued_category | string | 否 | 应计类型： - `UNSPECIFIED`——未指定； - `POSTING`——按货件计算的应计项目； - `ITEM`——按商品计算的应计项目； - `NON_ITEM`——不关联商品的卖家层面应计项目。 |
|   accruals[].date | string | 否 | 应计日期。 |
|   accruals[].item_fees | object | 否 | 按商品计算的应计项目。 |
|     accruals[].item_fees.fees | array<object> | 否 | 某一商品的应计项目。 |
|       accruals[].item_fees.fees[].fees | array<finance.v1.GetFinanceAccrualByDayResponse.Accrual.ItemFees.ItemFee.Fee> | 否 | 应计项目。 |
|       accruals[].item_fees.fees[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|   accruals[].non_item_fee | object | 否 | 不关联商品的卖家层面应计项目。 |
|     accruals[].non_item_fee.accrued | object | 否 | 服务应计金额。 |
|       accruals[].non_item_fee.accrued.amount | string | 否 | 金额。数值可以为负数。 |
|       accruals[].non_item_fee.accrued.currency | string | 否 | 货币单位。 |
|     accruals[].non_item_fee.type_id | integer | 否 | 应计类型标识符。可通过方法[/v1/finance/accrual/types](#operation/GetFinanceAccrualTypes)获取。 |
|   accruals[].posting | object | 否 | 按货件计算的应计项目。 |
|     accruals[].posting.delivery_schema | string | 否 | 销售模式。 |
|     accruals[].posting.delivery_speed | integer | 否 | 配送速度。 |
|     accruals[].posting.products | array<object> | 否 | 货件中的商品数据。 |
|       accruals[].posting.products[].commission | finance.v1.GetFinanceAccrualByDayResponse.Accrual.Posting.Product.Commission | 否 |  |
|       accruals[].posting.products[].delivery | finance.v1.GetFinanceAccrualByDayResponse.Accrual.Posting.Product.Delivery | 否 |  |
|       accruals[].posting.products[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|   accruals[].total_amount | object | 否 | 应计总金额。 |
|     accruals[].total_amount.amount | string | 否 | 金额。 |
|     accruals[].total_amount.currency | string | 否 | 货币单位。 |
|   accruals[].accrual_id | integer | 否 | 应计项目标识符。 |
|   accruals[].unit_number | string | 否 | 例如：货件编号或广告合同编号。 |
| last_id | string | 否 | 页面中最后一个值的标识符。 |

---

### `POST` `/v1/product/visibility/info`

**获取商品可见性信息**

`operationId: ProductVisibilityInfo`

您可以在 [讨论](https://dev.ozon.ru/community/1951-Novyi-metod-upravleniia-vidimostiu-na-vitrinakh/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`product.v1.ProductVisibilityInfoRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| skus | array<string> | 否 | Ozon系统中的商品标识符—— SKU。 |

#### 响应（`product.v1.ProductVisibilityInfoResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| items | array<object> | 否 | 商品列表。 |
|   items[].showcases_visibility | string | 否 | 商品展示在哪些橱窗中：  - `UNSPECIFIED`——未指定；  - `OZON`——仅在Ozon展示；  - `SELECT`——仅在Select展示；  - `OZON_SELECT`——在Select和Ozon展示；  - `NONE`——商品在所有橱窗均隐藏。 |
|   items[].sku | integer | 否 | 商品在Ozon系统中的标识符——SKU。 |

---

