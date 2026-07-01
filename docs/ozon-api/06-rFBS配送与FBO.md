# rFBS配送与FBO

> Ozon Seller API — rFBS配送与FBO
>
> 基础地址：`https://api-seller.ozon.ru`
>
> 认证请求头：`Client-Id`、`Api-Key`、`Content-Type: application/json`

---

## 目录

**rFBS配送**（5）

- `POST` `/v2/fbs/posting/delivering` — 将状态改成“运输中”
- `POST` `/v2/fbs/posting/tracking-number/set` — 添加跟踪号
- `POST` `/v2/fbs/posting/last-mile` — 状态改为“最后一英里”
- `POST` `/v2/fbs/posting/delivered` — 将状态改成“已送达”
- `POST` `/v1/posting/cutoff/set` — 确认货件发运日期

**FBO**（1）

- `POST` `/v1/supply-order/bundle` — 交货或交货申请的商品组成

---

## rFBS配送

### `POST` `/v2/fbs/posting/delivering`

**将状态改成“运输中”**

`operationId: PostingAPI_FbsPostingDelivering`

在更改状态前，请使用 /v3/posting/fbs/get 方法检查当前货件状态。状态更改是异步进行的。  如果使用第三方快递服务，请将货运状态改为“运输中”。

#### 请求体（`postingFbsPostingDeliveringRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_number | array<string> | 是 | 货件ID。 |

#### 响应（`postingFbsPostingMoveStatusResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | string | 否 | 处理请求时出错。 |
| posting_number | string | 否 | 发货号。 |
| result | boolean | 否 | 如果执行请求无误 — `true`。 |

---

### `POST` `/v2/fbs/posting/tracking-number/set`

**添加跟踪号**

`operationId: PostingAPI_FbsPostingTrackingNumberSet`

为货件添加跟踪号。每次最多可添加20个跟踪号。

#### 请求体（`postingFbsPostingTrackingNumberSetRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| tracking_numbers | array<object> | 是 | 具有成对货运ID的数据 - 追踪号。 |
|   tracking_numbers[].posting_number | string | 是 | 货件ID。 |
|   tracking_numbers[].tracking_number | string | 是 | 货件追踪号。 |

#### 响应（`postingFbsPostingMoveStatusResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | string | 否 | 处理请求时出错。 |
| posting_number | string | 否 | 发货号。 |
| result | boolean | 否 | 如果执行请求无误 — `true`。 |

---

### `POST` `/v2/fbs/posting/last-mile`

**状态改为“最后一英里”**

`operationId: PostingAPI_FbsPostingLastMile`

在更改状态前，请使用 /v3/posting/fbs/get 方法检查当前货件状态。状态更改是异步进行的。  如果使用第三方快递服务，请将货运状态改为“最后一英里”。

#### 请求体（`postingFbsPostingLastMileRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_number | array<string> | 是 | 货件ID。 |

#### 响应（`postingFbsPostingMoveStatusResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | string | 否 | 处理请求时出错。 |
| posting_number | string | 否 | 发货号。 |
| result | boolean | 否 | 如果执行请求无误 — `true`。 |

---

### `POST` `/v2/fbs/posting/delivered`

**将状态改成“已送达”**

`operationId: PostingAPI_FbsPostingDelivered`

在更改状态前，请使用 /v3/posting/fbs/get 方法检查当前货件状态。状态更改是异步进行的。  如果使用第三方快递服务，请将货运状态改成“已送达”。

#### 请求体（`postingFbsPostingDeliveredRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_number | array<string> | 是 | 货件ID。 |

#### 响应（`postingFbsPostingMoveStatusResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | string | 否 | 处理请求时出错。 |
| posting_number | string | 否 | 发货号。 |
| result | boolean | 否 | 如果执行请求无误 — `true`。 |

---

### `POST` `/v1/posting/cutoff/set`

**确认货件发运日期**

`operationId: PostingAPI_SetPostingCutoff`

用于卖家或非集成运输商配送的货件方法。

#### 请求体（`v1SetPostingCutoffRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| new_cutoff_date | string | 是 | 新发运日期。 |
| posting_number | string | 是 | 货件编号。 |

#### 响应（`v1SetPostingCutoffResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| result | boolean | 否 | `true`表示已设置新日期。 |

---

## FBO

### `POST` `/v1/supply-order/bundle`

**交货或交货申请的商品组成**

`operationId: SupplyOrderBundle`

使用该方法可获取交货或交货申请草稿中的商品组成信息。 次方法调用只能获取一份交货或交货申请草稿的组成。

#### 请求体（`v1GetSupplyOrderBundleRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| bundle_ids | array<string> | 是 | 交货商品组成的标识符。可通过方法 [/v3/supply-order/get](#operation/SupplyOrderGet) 获取。 |
| is_asc | boolean | 否 | 传入 `true` 表示按升序排序。 |
| item_tags_calculation | object | 否 | 用于计算产品标签的仓库列表。 |
|   item_tags_calculation.dropoff_warehouse_id | string | 是 | 用于发货的仓库标识符。 |
|   item_tags_calculation.storage_warehouse_ids | array<string> | 是 | 发货仓库标识符列表，不超过 25 个值。 |
| last_id | string | 否 | 当前页面中最后一个 SKU 值的标识符。 |
| limit | integer | 是 | 每页商品数量。 |
| query | string | 否 | 搜索查询，例如按商品名称、货号或 SKU 搜索。 |
| sort_field | string | 否 | 排序参数： - `SKU`——SKU； - `NAME`——按商品名称； - `QUANTITY`——按数量； - `TOTAL_VOLUME_IN_LITRES`——按体积（升）。 |

#### 响应（`v1GetSupplyOrderBundleResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| items | array<object> | 否 | 交货申请中的商品列表。 |
|   items[].icon_path | string | 否 | 商品图片链接。 |
|   items[].sku | integer | 否 | 商品在Ozon系统中的ID（SKU）。 |
|   items[].name | string | 否 | 商品名称。 |
|   items[].offer_id | string | 否 | 商品在卖家系统中的标识符 — 货号。 |
|   items[].quantity | integer | 否 | 商品数量。 |
|   items[].barcode | string | 否 | 商品条形码。 |
|   items[].product_id | integer | 否 | Ozon系统中商品的标识符 — `product_id`。 |
|   items[].quant | integer | 否 | 单个包装中的商品数量。 |
|   items[].is_quant_editable | boolean | 否 | `true`，表示单个包装中的商品数量可修改。 |
|   items[].volume_in_litres | number | 否 | 商品体积（升）。 |
|   items[].total_volume_in_litres | number | 否 | 所有商品总体积（升）。 |
|   items[].contractor_item_code | string | 否 | 卖家系统中的商品标识符——货号。 |
|   items[].sfbo_attribute | string | 否 | 超级产品标签： - `ITEM_SFBO_ATTRIBUTE_NONE`——无标签； - `ITEM_SFBO_ATTRIBUTE_SUPER_FBO`——超级产品； - `ITEM_SFBO_ATTRIBUTE_ANTI_FBO`——滞销产品。 |
|   items[].shipment_type | string | 否 | 包装类型： - `BUNDLE_ITEM_SHIPMENT_TYPE_GENERAL`——常规产品； - `BUNDLE_ITEM_SHIPMENT_TYPE_BOX`——盒装； - `BUNDLE_ITEM_SHIPMENT_TYPE_PALLET`——托盘。 |
|   items[].tags | array<string> | 否 | 交货或交货申请中的商品标签。  可能的取值： - `EVSD_REQUIRED`——需要 Mercury 认证的商品； - `MARKING_REQUIRED`——需要 “诚实标志” 强制标志的商品； - `MARKING_POSSIBLE`——可能需要 “诚实标志” 标记的商品； - `JEWELRY`——含珠宝属性的商品； - `TRACEABLE`——可追溯商品； - `ETTN_REQUI... |
|   items[].placement_zone | string | 否 | 商品存放区域： - `UNSPECIFIED`——未指定； - `CLOSED_ZONE`——封闭区域； - `DANGEROUS_GOODS`——2–4 类危险品； - `PRODUCTS`——食品； - `SORT`——可分拣商品； - `NON_SORT`——不可分拣商品； - `OVERSIZE`——超大货物； - `JEWELRY`——珠宝类商品； - `UNRESOLVED`——未知区... |
| total_count | integer | 否 | 申请中的商品数量。 |
| has_next | boolean | 否 | 响应中是否未返回全部商品： - `true`——请使用不同的 `last_id` 值再次请求，以获取其余数据；       - `false`——响应已包含全部商品数据。 |
| last_id | string | 否 | 当前页面最后一个值的标识符。 |

---

