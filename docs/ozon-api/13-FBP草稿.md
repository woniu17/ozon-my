# FBP草稿

> Ozon Seller API — FBP草稿
>
> 基础地址：`https://api-seller.ozon.ru`
>
> 认证请求头：`Client-Id`、`Api-Key`、`Content-Type: application/json`

---

## 目录

**使用FBP草稿**（3）

- `POST` `/v1/fbp/warehouse/list` — 获取合作伙伴仓库列表
- `POST` `/v1/fbp/draft/get` — 获取交货草稿信息
- `POST` `/v1/fbp/draft/list` — 交货草稿列表

**处理 FBP direct 交货草稿**（10）

- `POST` `/v1/fbp/draft/direct/seller-dlv/create` — 创建由卖家配送的草稿
- `POST` `/v1/fbp/draft/direct/seller-dlv/edit` — 更新草稿中由卖家配送的信息
- `POST` `/v1/fbp/draft/direct/timeslot/edit` — 编辑草稿中的时间段
- `POST` `/v1/fbp/draft/direct/timeslot/get` — 获取直供的时间段列表
- `POST` `/v1/fbp/draft/direct/create` — 创建不指定配送方法的交货申请草稿
- `POST` `/v1/fbp/draft/direct/delete` — 删除交货申请草稿
- `POST` `/v1/fbp/draft/direct/product/validate` — 检查合作伙伴仓库商品列表
- `POST` `/v1/fbp/draft/direct/registrate` — 将草稿单转为正式交货
- `POST` `/v1/fbp/draft/direct/tpl-dlv/create` — 创建第三方物流公司配送的申请草稿
- `POST` `/v1/fbp/draft/direct/tpl-dlv/edit` — 编辑采用第三方承运商配送方法的交货草稿

**处理 FBP drop-off 交货草稿**（8）

- `POST` `/v1/fbp/draft/drop-off/province/list` — 获取省份列表
- `POST` `/v1/fbp/draft/drop-off/point/list` — 获取省份内接收点列表
- `POST` `/v1/fbp/draft/drop-off/point/timetable` — 获取接收点的营业时间表
- `POST` `/v1/fbp/draft/drop-off/product/validate` — 检查合作伙伴仓库可接收的商品列表
- `POST` `/v1/fbp/draft/drop-off/create` — 创建接收点配送草稿
- `POST` `/v1/fbp/draft/drop-off/delete` — 删除接收点配送草稿
- `POST` `/v1/fbp/draft/drop-off/dlv/edit` — 编辑接收点配送草稿的配送详情
- `POST` `/v1/fbp/draft/drop-off/registrate` — 将草稿转为正式交货

**处理 FBP pick-up 交货草稿**（5）

- `POST` `/v1/fbp/draft/pick-up/create` — 创建 pick-up 交货申请草稿
- `POST` `/v1/fbp/draft/pick-up/delete` — 取消 pick-up 交货申请草稿
- `POST` `/v1/fbp/draft/pick-up/dlv/edit` — 修改 pick-up 交货申请
- `POST` `/v1/fbp/draft/pick-up/product/validate` — 验证用于 pick-up 交货的商品列表
- `POST` `/v1/fbp/draft/pick-up/registrate` — 将草稿单转为正式交货

---

## 使用FBP草稿

### `POST` `/v1/fbp/warehouse/list`

**获取合作伙伴仓库列表**

`operationId: FbpWarehouseList`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 响应（`v1FbpWarehouseListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| warehouses | array<object> | 否 | 仓库列表。 |
|   warehouses[].address_detailing | object | 否 | 地址详情。 |
|     warehouses[].address_detailing.city | string | 否 | 城市。 |
|     warehouses[].address_detailing.country | string | 否 | 国家。 |
|     warehouses[].address_detailing.house | string | 否 | 门牌号。 |
|     warehouses[].address_detailing.region | string | 否 | 地区。 |
|     warehouses[].address_detailing.street | string | 否 | 街道。 |
|     warehouses[].address_detailing.zipcode | string | 否 | 邮政编码。 |
|   warehouses[].id | integer | 否 | 仓库标识符。 |
|   warehouses[].is_bonded | boolean | 否 | `true`，表示该仓库为保税仓。 |
|   warehouses[].name | string | 否 | 仓库名称。 |
|   warehouses[].partner_name | string | 否 | 合作伙伴名称。 |
|   warehouses[].supply_types | array<integer> | 否 | 交货类型。 |
|   warehouses[].timezone_name | string | 否 | 仓库所在时区。 |

---

### `POST` `/v1/fbp/draft/get`

**获取交货草稿信息**

`operationId: FbpAPI_FbpDraftGet`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftGetRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpDraftGetResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| bundle_id | string | 否 | 验证后商品的列表标识符。 |
| cancellation_state | object | 否 | 取消原因。 |
|   cancellation_state.cancellation_error | object | 否 | 取消错误。 |
|     cancellation_state.cancellation_error.error_code | string | 否 | 取消错误代码： - `CODE_UNSPECIFIED`——未指定； - `NO_RESPONSE_FROM_3PF`——取消申请未确认，未收到第三方响应； - `ACCEPTANCE_ALREADY_STARTED`——取消申请未确认，已开始验收。 |
|     cancellation_state.cancellation_error.message | string | 否 | 错误描述。 |
|   cancellation_state.cancellation_status | string | 否 | 错误状态：   - `STATUS_UNSPECIFIED`——未指定；   - `CONFIRMATION`——等待申请取消确认；   - `CANCELED`——取消已确认；   - `NOT_CANCELED`——未收到取消确认。 |
| created_at | string | 否 | 草稿创建日期。 |
| decline_reason | object | 否 | 拒绝原因。 |
|   decline_reason.failed_sku_ids | array<string> | 否 | 不正确的SKU标识符。 |
|   decline_reason.message | string | 否 | 拒绝文本。 |
| deleted_at | string | 否 | 草稿删除日期。 |
| delivery_details | object | 否 | 配送详细信息。 |
|   delivery_details.direct_details | object | 否 | 卖家配送详情。 |
|     delivery_details.direct_details.by_seller_details | object | 否 | 卖家自配送详情。 |
|       delivery_details.direct_details.by_seller_details.driver_name | string | 否 | 司机姓名。 |
|       delivery_details.direct_details.by_seller_details.vehicle_registration_number | string | 否 | 车牌号码。 |
|       delivery_details.direct_details.by_seller_details.vehicle_type | string | 否 | 运输工具类型。 |
|     delivery_details.direct_details.by_tpl_details | object | 否 | 第三方物流公司配送详情。 |
|       delivery_details.direct_details.by_tpl_details.tracking_number | string | 否 | 货件跟踪号码。 |
|       delivery_details.direct_details.by_tpl_details.transport_company_name | string | 否 | 物流公司名称。 |
|     delivery_details.direct_details.timeslot_details | object | 否 | 交货时间段详情。 |
|       delivery_details.direct_details.timeslot_details.timeslot | object | 否 | 时间段。 |
|       delivery_details.direct_details.timeslot_details.timeslot_reservation_id | string | 否 | 交货时间段预定标识符。 |
|   delivery_details.drop_off_point | object | 否 | 揽收点详情。 |
|     delivery_details.drop_off_point.id | integer | 否 | 揽收点标识符。 |
|     delivery_details.drop_off_point.province_uuid | string | 否 | 区域唯一标识符。 |
|     delivery_details.drop_off_point.timeslot | object | 否 | 时间段。 |
|       delivery_details.drop_off_point.timeslot.timeslot_end | string | 否 | 时间段结束时间（UTC）。 |
|       delivery_details.drop_off_point.timeslot.timeslot_start | string | 否 | 时间段开始时间（UTC）。 |
|   delivery_details.pickup_details | object | 否 | 取货点详情。 |
|     delivery_details.pickup_details.address | string | 否 | 地址。 |
|     delivery_details.pickup_details.comment | string | 否 | 备注。 |
|     delivery_details.pickup_details.date | string | 否 | 送货日期。 |
|     delivery_details.pickup_details.sender_name | string | 否 | 发件人姓名。 |
|     delivery_details.pickup_details.sender_phone | string | 否 | 发件人电话号码。 |
|   delivery_details.supply_type | string | 否 | 交货类型： - `SUPPLY_TYPE_UNSPECIFIED`：未指定； - `DIRECT_BY_SELLER`：卖家自行送货到仓库； - `DIRECT_BY_TPL`：第三方物流公司送货到仓库； - `DROP_OFF`：送货到揽收点； - `PICK_UP`：由快递员从卖家仓库配送。 |
| editable | boolean | 否 | `true`，如果草稿可以修改。 |
| id | integer | 否 | 草稿标识符。 |
| is_cancelable | boolean | 否 | `true`，如果草稿可以取消。 |
| is_deletable | boolean | 否 | `true`，如果草稿可以删除。 |
| is_registration_available | boolean | 否 | `true`，如果可注册。 |
| locked | boolean | 否 | `true`，如果草稿被封锁。 |
| package_units_count | integer | 否 | 货位数量。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |
| status | string | 否 | 草稿状态: - `DRAFT_STATUS_UNSPECIFIED` — 未定义; - `NEW` — 新的; - `SUPPLY_VARIANT_CONFIRMATION` — 等待确认; - `SUPPLY_NOT_CONFIRMED` — 仓库拒收. |
| supply_id | string | 否 | 交货标识符。 |
| warehouse_id | integer | 否 | 仓库标识符。 |

---

### `POST` `/v1/fbp/draft/list`

**交货草稿列表**

`operationId: FbpAPI_FbpDraftList`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| count | integer | 是 | 响应中的商品数量。 |
| last_id | integer | 否 | 页面上最后一个值的ID。运行第一个查询时，将此字段留空。  要检索以下数值，请从上一个查询的响应中指定`last_id`。 |

#### 响应（`v1FbpDraftListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| has_next | boolean | 否 | `true`，如果响应中没有返回所有值。 |
| items | array<object> | 否 | 草稿。 |
|   items[].bundle_id | string | 否 | 验证后商品的列表标识符。 |
|   items[].cancellation_state | object | 否 | 取消原因。 |
|     items[].cancellation_state.cancellation_error | object | 否 | 取消错误。 |
|       items[].cancellation_state.cancellation_error.error_code | CancellationErrorCode | 否 |  |
|       items[].cancellation_state.cancellation_error.message | string | 否 | 错误描述。 |
|     items[].cancellation_state.cancellation_status | string | 否 | 错误状态：   - `STATUS_UNSPECIFIED`——未指定；   - `CONFIRMATION`——等待申请取消确认；   - `CANCELED`——取消已确认；   - `NOT_CANCELED`——未收到取消确认。 |
|   items[].created_at | string | 否 | 草稿创建日期。 |
|   items[].deleted_at | string | 否 | 草稿删除日期。 |
|   items[].delivery_details | object | 否 | 配送详细信息。 |
|     items[].delivery_details.direct_details | object | 否 | 卖家配送详情。 |
|       items[].delivery_details.direct_details.by_seller_details | DirectDetailsBySellerDetails | 否 |  |
|       items[].delivery_details.direct_details.by_tpl_details | DirectDetailsByTplDetails | 否 |  |
|       items[].delivery_details.direct_details.timeslot_details | DirectDetailsTimeslotDetails | 否 |  |
|     items[].delivery_details.drop_off_point | object | 否 | 揽收点详情。 |
|       items[].delivery_details.drop_off_point.id | integer | 否 | 揽收点标识符。 |
|       items[].delivery_details.drop_off_point.province_uuid | string | 否 | 区域唯一标识符。 |
|       items[].delivery_details.drop_off_point.timeslot | v1fbpTimeslot | 否 |  |
|     items[].delivery_details.pickup_details | object | 否 | 取货点详情。 |
|       items[].delivery_details.pickup_details.address | string | 否 | 地址。 |
|       items[].delivery_details.pickup_details.comment | string | 否 | 备注。 |
|       items[].delivery_details.pickup_details.date | string | 否 | 送货日期。 |
|       items[].delivery_details.pickup_details.sender_name | string | 否 | 发件人姓名。 |
|       items[].delivery_details.pickup_details.sender_phone | string | 否 | 发件人电话号码。 |
|     items[].delivery_details.supply_type | string | 否 | 交货类型： - `SUPPLY_TYPE_UNSPECIFIED`：未指定； - `DIRECT_BY_SELLER`：卖家自行送货到仓库； - `DIRECT_BY_TPL`：第三方物流公司送货到仓库； - `DROP_OFF`：送货到揽收点； - `PICK_UP`：由快递员从卖家仓库配送。 |
|   items[].editable | boolean | 否 | `true`，如果草稿可以修改。 |
|   items[].id | integer | 否 | 草稿标识符。 |
|   items[].is_cancelable | boolean | 否 | `true`，如果草稿可以取消。 |
|   items[].is_deletable | boolean | 否 | `true`，如果草稿可以删除。 |
|   items[].locked | boolean | 否 | `true`，如果草稿被封锁。 |
|   items[].package_units_count | integer | 否 | 货位数量。 |
|   items[].status | string | 否 | 草稿状态: - `DRAFT_STATUS_UNSPECIFIED` — 未定义; - `NEW` — 新的; - `SUPPLY_VARIANT_CONFIRMATION` — 等待确认; - `SUPPLY_NOT_CONFIRMED` — 仓库拒收. |
|   items[].supply_id | string | 否 | 交货标识符。 |
|   items[].warehouse_id | integer | 否 | 仓库标识符。 |
| last_id | integer | 否 | 页面上最后一个值的标识符。 |

---

## 处理 FBP direct 交货草稿

### `POST` `/v1/fbp/draft/direct/seller-dlv/create`

**创建由卖家配送的草稿**

`operationId: FbpDraftDirectSellerDlvCreate`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectSellerDlvCreateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| bundle_id | string | 是 | 已验证商品清单的标识符。 |
| delivery_details | object | 是 | 配送详情。 |
|   delivery_details.driver_name | string | 是 | 司机姓名。 |
|   delivery_details.timeslot_start | string | 是 | 时间段开始时间。 |
|   delivery_details.vehicle_number | string | 是 | 车牌号。 |
|   delivery_details.vehicle_type | string | 是 | 车辆类型。 |
| package_units_count | integer | 是 | 货位数量。 |
| warehouse_id | integer | 是 | 卖家仓库标识符。 |

#### 响应（`v1FbpDraftDirectSellerDlvCreateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| draft_id | integer | 否 | 草稿标识符。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |
| supply_id | string | 否 | 供货申请标识符。 |

---

### `POST` `/v1/fbp/draft/direct/seller-dlv/edit`

**更新草稿中由卖家配送的信息**

`operationId: FbpDraftDirectSellerDlvEdit`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectSellerDlvEditRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| driver_name | string | 是 | 司机姓名。 |
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 供货申请标识符。 |
| vehicle_number | string | 是 | 车牌号。 |
| vehicle_type | string | 是 | 车辆类型。 |

#### 响应（`v1FbpDraftDirectSellerDlvEditResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误信息。 |
|   error.errors | array<string> | 否 | 错误类型：  - `ERROR_TYPE_UNSPECIFIED`——未定义；  - `ORDER_DRAFT_LOCKED`——草稿被锁定；  - `DELIVERY_DRIVER_NAME_LENGTH_MAXIMUM_REACHED`——司机姓名长度超限；  - `DELIVERY_VEHICLE_GENRE_LENGTH_MAXIMUM_REACHED`——车辆类型长度超限；  - `DE... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/draft/direct/timeslot/edit`

**编辑草稿中的时间段**

`operationId: FbpDraftDirectTimeslotEdit`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectTimeslotEditRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 供货申请标识符。 |
| timeslot_start | string | 是 | 时间段开始时间。 |

#### 响应（`v1FbpDraftDirectTimeslotEditResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error_reasons | array<string> | 否 | 错误原因：   - `RESERVE_FAILURE_TYPE_UNSPECIFIED`——未定义；   - `REQUEST_VALIDATION`——请求中填写了过去的预定日期；   - `INVALID_RESERVE`——原始预留未找到、已失效或已包含申请，但尝试覆盖；   - `LOGISTICS_REASON`——物流方错误；   - `SCHEDULE_REASON`——排期方错误；... |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/draft/direct/timeslot/get`

**获取直供的时间段列表**

`operationId: FbpDraftDirectGetTimeslot`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectGetTimeslotRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| bundle_id | string | 是 | 已验证商品清单的标识符。 |
| interval_end | string | 是 | 可用时间段所需区间的结束日期。 |
| interval_start | string | 是 | 可用时间段所需区间的开始日期。 |
| warehouse_id | integer | 是 | 卖家仓库标识符。 |

#### 响应（`v1FbpDraftDirectGetTimeslotResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| reasons | array<string> | 否 | 缺少时间段的原因： - `EMPTY_TIMESLOTS_REASON_UNSPECIFIED`——未定义； - `LOGISTICS_UNKNOWN`——物流方未知错误； - `NO_ROUTE`——没有路线； - `NO_ROUTE_SCHEDULES`——路线上没有排期； - `NO_LOGISTICS_CAPACITY`——路线上可用的时段不足； - `SCHEDULE_UNKNOWN`—... |
| timeslots | array<object> | 否 | 可用时间段列表。 |
|   timeslots[].timeslot_end | string | 否 | 时间段结束日期。 |
|   timeslots[].timeslot_start | string | 否 | 时间段开始日期。 |
| warehouse_timezone_name | string | 否 | 卖家仓库的时区。 |

---

### `POST` `/v1/fbp/draft/direct/create`

**创建不指定配送方法的交货申请草稿**

`operationId: FbpDraftDirectCreate`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectCreateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| bundle_id | string | 是 | 已校验商品列表的标识符。要获取，请使用方法[/v1/fbp/draft/direct/product/validate](#operation/FbpDraftDirectProductValidate)。 |
| delivery_details | object | 是 | 配送详细信息。 |
|   delivery_details.timeslot_start | string | 是 | 配送时间段开始。 |
| package_units_count | integer | 是 | 包装单位数量。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpDraftDirectCreateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| draft_id | integer | 否 | 草稿标识符。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |
| supply_id | string | 否 | 交货标识符。 |

---

### `POST` `/v1/fbp/draft/direct/delete`

**删除交货申请草稿**

`operationId: FbpDraftDirectDelete`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectDeleteRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpDraftDirectDeleteResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cancellation_state | object | 否 | 取消原因。 |
|   cancellation_state.cancellation_error | object | 否 | 取消错误。 |
|     cancellation_state.cancellation_error.error_code | string | 否 | 取消错误代码： - `CODE_UNSPECIFIED`——未指定； - `NO_RESPONSE_FROM_3PF`——取消申请未确认，未收到第三方响应； - `ACCEPTANCE_ALREADY_STARTED`——取消申请未确认，已开始验收。 |
|     cancellation_state.cancellation_error.message | string | 否 | 错误描述。 |
|   cancellation_state.cancellation_status | string | 否 | 错误状态：   - `STATUS_UNSPECIFIED`——未指定；   - `CONFIRMATION`——等待申请取消确认；   - `CANCELED`——取消已确认；   - `NOT_CANCELED`——未收到取消确认。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/draft/direct/product/validate`

**检查合作伙伴仓库商品列表**

`operationId: FbpDraftDirectProductValidate`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectProductValidateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| skus | array<object> | 是 | 商品标识符（SKU）列表。 |
|   skus[].count | integer | 是 | 交货商品数量。 |
|   skus[].sku | integer | 是 | 商品标识符（SKU）。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpDraftDirectProductValidateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| approved_items | array<object> | 否 | 已确认商品。 |
|   approved_items[].barcode | string | 否 | 条形码。 |
|   approved_items[].icon_name | string | 否 | 商品图片链接。 |
|   approved_items[].name | string | 否 | 商品名称。 |
|   approved_items[].offer_id | string | 否 | 卖家系统中的商品货号。 |
|   approved_items[].quantity | integer | 否 | 商品数量。 |
|   approved_items[].sku | integer | 否 | 商品标识符（SKU）。 |
|   approved_items[].volume | number | 否 | 商品体积。 |
| bundle_generated | boolean | 否 | `true`，前提是已创建校验商品列表。 |
| bundle_id | string | 否 | 校验商品列表标识符。 |
| rejected_items | array<object> | 否 | 被拒绝的商品。 |
|   rejected_items[].barcode | string | 否 | 条形码。 |
|   rejected_items[].icon_name | string | 否 | 商品图片链接。 |
|   rejected_items[].name | string | 否 | 商品名称。 |
|   rejected_items[].offer_id | string | 否 | 卖家系统中的商品货号。 |
|   rejected_items[].quantity | integer | 否 | 商品数量。 |
|   rejected_items[].rejection_reasons | array<string> | 否 | 拒绝原因：    - `BUNDLE_ITEM_ERROR_UNSPECIFIED`——未指定；    - `OUT_OF_ASSORTMENT`——未找到商品；    - `INVALID`——商品未创建；    - `INCOMPATIBLE_WAREHOUSE`——仓库标识符错误    - `INVALID_BARCODE`——未指定条形码；    - `MULTIPLICITY`——商品数... |
|   rejected_items[].sku | integer | 否 | 商品标识符（SKU）。 |
|   rejected_items[].volume | number | 否 | 商品体积。 |

---

### `POST` `/v1/fbp/draft/direct/registrate`

**将草稿单转为正式交货**

`operationId: FbpDraftDirectRegistrate`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectRegistrateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpDraftDirectRegistrateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误。 |
|   error.bundle_errors | array<object> | 否 | 校验商品列表的错误。 |
|     error.bundle_errors[].errors | array<string> | 否 | 错误：    - `BUNDLE_ITEM_ERROR_UNSPECIFIED`——未指定；    - `OUT_OF_ASSORTMENT`——未找到商品；    - `INVALID`——商品未创建；    - `INCOMPATIBLE_WAREHOUSE`——仓库标识符错误；    - `INVALID_BARCODE`——未指定条形码；    - `MULTIPLICITY`——商品数量... |
|     error.bundle_errors[].sku | integer | 否 | 商品标识符（SKU）。 |
|   error.order_error | string | 否 | 交货注册错误：  - `ORDER_ERROR_TYPE_UNSPECIFIED` — 未知订单错误类型；  - `INVALID_NUMBER_OF_PACKAGE_UNITS` — 申请中货位数量错误；  - `MAXIMUM_NUMBER_OF_UNIQUE_SKU_REACHED` — 申请中唯一SKU数量超限；  - `MAXIMUM_BUNDLE_VOLUME_REACHED` — 达... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/draft/direct/tpl-dlv/create`

**创建第三方物流公司配送的申请草稿**

`operationId: FbpAPI_FbpDraftDirectTplDlvCreate`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectTplDlvCreateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| bundle_id | string | 是 | 套装标识符。 |
| delivery_details | object | 是 | 配送详细信息。 |
|   delivery_details.timeslot_start | string | 是 | 时间段开始本地时间。 |
|   delivery_details.tracking_number | string | 是 | 货件跟踪号码。 |
|   delivery_details.transport_company_name | string | 是 | 物流公司名称。 |
| package_units_count | integer | 是 | 货位数量。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpDraftDirectTplDlvCreateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| draft_id | integer | 否 | 草稿标识符。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |
| supply_id | string | 否 | 交货标识符。 |

---

### `POST` `/v1/fbp/draft/direct/tpl-dlv/edit`

**编辑采用第三方承运商配送方法的交货草稿**

`operationId: FbpAPI_FbpDraftDirectTplDlvEdit`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDirectTplDlvEditRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 交货标识符。 |
| tracking_number | string | 是 | 货件跟踪号码。 |
| transport_company_name | string | 是 | 物流公司名称。 |

#### 响应（`v1FbpDraftDirectTplDlvEditResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误信息。 |
|   error.errors | array<string> | 否 | 错误类型：  - `ERROR_TYPE_UNSPECIFIED`——未定义；  - `ORDER_DRAFT_LOCKED`——草稿被锁定；  - `DELIVERY_DRIVER_NAME_LENGTH_MAXIMUM_REACHED`——司机姓名长度超限；  - `DELIVERY_VEHICLE_GENRE_LENGTH_MAXIMUM_REACHED`——车辆类型长度超限；  - `DE... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

## 处理 FBP drop-off 交货草稿

### `POST` `/v1/fbp/draft/drop-off/province/list`

**获取省份列表**

`operationId: FbpDraftDropOffProvinceList`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDropOffProvinceListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpDraftDropOffProvinceListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| provinces | array<object> | 否 | 省份列表。 |
|   provinces[].name | string | 否 | 省份名称。 |
|   provinces[].points_count | integer | 否 | 地图上接收点数量。 |
|   provinces[].province_uuid | string | 否 | 省份唯一标识符。 |

---

### `POST` `/v1/fbp/draft/drop-off/point/list`

**获取省份内接收点列表**

`operationId: FbpDraftDropOffPointList`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDropOffPointListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| next_page_number | integer | 否 | 下一页页码。 |
| page_size | integer | 是 | 每页包含的商品数量。 |
| province_uuid | string | 是 | 省份唯一标识符。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpDraftDropOffPointListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| drop_off_points | array<object> | 否 | 接收点列表。 |
|   drop_off_points[].city | string | 否 | 城市。 |
|   drop_off_points[].drop_off_point_id | integer | 否 | 揽收点标识符。 |
|   drop_off_points[].nearest_drop_off_date | string | 否 | 最近的发运日期。 |
|   drop_off_points[].point_address | string | 否 | 接收点地址。 |
|   drop_off_points[].province_uuid | string | 否 | 省份唯一标识符。 |

---

### `POST` `/v1/fbp/draft/drop-off/point/timetable`

**获取接收点的营业时间表**

`operationId: FbpDraftDropOffPointTimetable`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDropOffPointTimetableRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| drop_off_point_id | integer | 是 | 揽收点标识符。 |
| province_uuid | string | 是 | 省份唯一标识符。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpDraftDropOffPointTimetableResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| calendar | array<object> | 否 | 接收点的营业时间表。 |
|   calendar[].calendar_item | object | 否 | 营业时间表。 |
|     calendar[].calendar_item.break_hours | object | 否 | 休息时间。 |
|       calendar[].calendar_item.break_hours.timeslot_end | string | 否 | 时间段结束时间。 |
|       calendar[].calendar_item.break_hours.timeslot_start | string | 否 | 时间段开始时间。 |
|     calendar[].calendar_item.is_holiday | boolean | 否 | `true`，表示节假日。 |
|     calendar[].calendar_item.opening_hours | object | 否 | 营业时间。 |
|       calendar[].calendar_item.opening_hours.timeslot_end | string | 否 | 时间段结束时间。 |
|       calendar[].calendar_item.opening_hours.timeslot_start | string | 否 | 时间段开始时间。 |
|   calendar[].day_of_week | string | 否 | 星期：  - `DAY_OF_WEEK_UNSPECIFIED`——未指定；  - `MONDAY`——星期一；  - `TUESDAY`——星期二；  - `WEDNESDAY`——星期三；  - `THURSDAY`——星期四；  - `FRIDAY`——星期五；  - `SATURDAY`——星期六；  - `SUNDAY`——星期日。 |

---

### `POST` `/v1/fbp/draft/drop-off/product/validate`

**检查合作伙伴仓库可接收的商品列表**

`operationId: FbpDraftDropOffProductValidate`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDropOffProductValidateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| skus | array<object> | 是 | Ozon系统中的商品标识符—— SKU。 |
|   skus[].count | integer | 是 | 数量。 |
|   skus[].sku | integer | 是 | Ozon系统中的商品标识符—— SKU。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpDraftDropOffProductValidateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| approved_items | array<object> | 否 | 已接收的商品。 |
|   approved_items[].barcode | string | 否 | 商品条形码。 |
|   approved_items[].icon_name | string | 否 | 商品图片链接。 |
|   approved_items[].name | string | 否 | 商品名称。 |
|   approved_items[].offer_id | string | 否 | 卖家系统中的商品标识符——货号。 |
|   approved_items[].quantity | integer | 否 | 商品数量。 |
|   approved_items[].sku | integer | 否 | Ozon系统中的商品标识符—— SKU。 |
|   approved_items[].volume | number | 否 | 商品体积。 |
| bundle_generated | boolean | 否 | `true`，前提是已创建商品成分信息。 |
| bundle_id | string | 否 | 验证后的商品列表标识符。 |
| rejected_items | array<object> | 否 | 被拒绝的商品。 |
|   rejected_items[].barcode | string | 否 | 商品条形码。 |
|   rejected_items[].icon_name | string | 否 | 商品图片链接。 |
|   rejected_items[].name | string | 否 | 商品名称。 |
|   rejected_items[].offer_id | string | 否 | 卖家系统中的商品标识符——货号。 |
|   rejected_items[].quantity | integer | 否 | 商品数量。 |
|   rejected_items[].rejection_reasons | array<string> | 否 | 拒收原因： - `BUNDLE_ITEM_ERROR_UNSPECIFIED`——未指定； - `OUT_OF_ASSORTMENT`——商品不在交货范围内； - `INVALID`——状态不正确； - `INCOMPATIBLE_WAREHOUSE`——仓库标识符不正确； - `INVALID_BARCODE`——未填写条形码； - `MULTIPLICITY`——商品数量不是包装的整数倍； -... |
|   rejected_items[].sku | integer | 否 | Ozon系统中的商品标识符—— SKU。 |
|   rejected_items[].volume | number | 否 | 商品体积。 |

---

### `POST` `/v1/fbp/draft/drop-off/create`

**创建接收点配送草稿**

`operationId: FbpDraftDropOffCreate`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDropOffCreateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| bundle_id | string | 是 | 验证后的商品列表标识符。 |
| delivery_details | object | 是 | 配送详情。 |
|   delivery_details.drop_off_date | string | 是 | 送货日期。 |
|   delivery_details.drop_off_point_id | integer | 是 | 揽收点标识符。 |
|   delivery_details.drop_off_province_uuid | string | 是 | 省份唯一标识符。 |
| package_units_count | integer | 是 | 货位数量。 |
| warehouse_id | integer | 是 | 卖家仓库标识符。 |

#### 响应（`v1FbpDraftDropOffCreateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| draft_id | integer | 否 | 草稿标识符。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |
| supply_id | string | 否 | 交货申请标识符。 |

---

### `POST` `/v1/fbp/draft/drop-off/delete`

**删除接收点配送草稿**

`operationId: FbpDraftDropOffDelete`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDropOffDeleteRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货申请标识符。 |

#### 响应（`v1FbpDraftDropOffDeleteResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cancellation_state | object | 否 | 取消原因。 |
|   cancellation_state.cancellation_error | object | 否 | 取消错误。 |
|     cancellation_state.cancellation_error.error_code | string | 否 | 取消错误代码： - `CODE_UNSPECIFIED`——未指定； - `NO_RESPONSE_FROM_3PF`——取消申请未确认，未收到第三方响应； - `ACCEPTANCE_ALREADY_STARTED`——取消申请未确认，已开始验收。 |
|     cancellation_state.cancellation_error.message | string | 否 | 错误描述。 |
|   cancellation_state.cancellation_status | string | 否 | 错误状态：   - `STATUS_UNSPECIFIED`——未指定；   - `CONFIRMATION`——等待申请取消确认；   - `CANCELED`——取消已确认；   - `NOT_CANCELED`——未收到取消确认。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/draft/drop-off/dlv/edit`

**编辑接收点配送草稿的配送详情**

`operationId: FbpDraftDropOffDlvEdit`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDropOffDlvEditRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| drop_off_date | string | 是 | 送货日期。 |
| drop_off_point_id | integer | 是 | 揽收点标识符。 |
| drop_off_province_uuid | string | 是 | 省份唯一标识符。 |
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 交货申请标识符。 |

#### 响应（`v1FbpDraftDropOffDlvEditResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/draft/drop-off/registrate`

**将草稿转为正式交货**

`operationId: FbpDraftDropOffRegistrate`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftDropOffRegistrateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 交货申请标识符。 |

#### 响应（`v1FbpDraftDropOffRegistrateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误。 |
|   error.bundle_errors | array<object> | 否 | 商品验证列表错误。 |
|     error.bundle_errors[].errors | array<string> | 否 | 错误： - `BUNDLE_ITEM_ERROR_UNSPECIFIED`——未指定； - `OUT_OF_ASSORTMENT`——商品不在交货品类中； - `INVALID`——状态不正确； - `INCOMPATIBLE_WAREHOUSE`——仓库标识符不正确； - `INVALID_BARCODE`——未填写条形码； - `MULTIPLICITY`——商品数量与包装不成倍数关系； - ... |
|     error.bundle_errors[].sku | integer | 否 | Ozon 系统中的商品标识符（SKU）。 |
|   error.order_error | string | 否 | 交货注册错误：  - `ORDER_ERROR_TYPE_UNSPECIFIED` — 未知订单错误类型；  - `INVALID_NUMBER_OF_PACKAGE_UNITS` — 申请中货位数量错误；  - `MAXIMUM_NUMBER_OF_UNIQUE_SKU_REACHED` — 申请中唯一SKU数量超限；  - `MAXIMUM_BUNDLE_VOLUME_REACHED` — 达... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

## 处理 FBP pick-up 交货草稿

### `POST` `/v1/fbp/draft/pick-up/create`

**创建 pick-up 交货申请草稿**

`operationId: FbpAPI_FbpDraftPickupCreate`

您可以在[讨论](https://dev.ozon.ru/community/1700-FBP-metody/)的评论中对此方法提供反馈在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftPickupCreateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| bundle_id | string | 是 | 已校验商品列表的标识符。 |
| delivery_details | object | 是 | 配送详细信息。 |
|   delivery_details.address | string | 是 | 地址。 |
|   delivery_details.comment | string | 是 | 备注。 |
|   delivery_details.date | string | 是 | 送货日期。 |
|   delivery_details.sender_name | string | 是 | 发件人姓名。 |
|   delivery_details.sender_phone | string | 是 | 发件人电话号码。 |
| package_units_count | integer | 是 | 包装单位数量。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpDraftPickupCreateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| draft_id | integer | 否 | 草稿标识符。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |
| supply_id | string | 否 | 交货标识符。 |

---

### `POST` `/v1/fbp/draft/pick-up/delete`

**取消 pick-up 交货申请草稿**

`operationId: FbpAPI_FbpDraftPickUpDelete`

您可以在[讨论](https://dev.ozon.ru/community/1700-FBP-metody/)的评论中对此方法提供反馈在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftPickUpDeleteRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpDraftPickUpDeleteResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cancellation_state | object | 否 | 取消原因。 |
|   cancellation_state.cancellation_error | object | 否 | 取消错误。 |
|     cancellation_state.cancellation_error.error_code | string | 否 | 取消错误代码： - `CODE_UNSPECIFIED`——未指定； - `NO_RESPONSE_FROM_3PF`——取消申请未确认，未收到第三方响应； - `ACCEPTANCE_ALREADY_STARTED`——取消申请未确认，已开始验收。 |
|     cancellation_state.cancellation_error.message | string | 否 | 错误描述。 |
|   cancellation_state.cancellation_status | string | 否 | 错误状态：   - `STATUS_UNSPECIFIED`——未指定；   - `CONFIRMATION`——等待申请取消确认；   - `CANCELED`——取消已确认；   - `NOT_CANCELED`——未收到取消确认。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/draft/pick-up/dlv/edit`

**修改 pick-up 交货申请**

`operationId: FbpAPI_FbpDraftPickupDlvEdit`

您可以在[讨论](https://dev.ozon.ru/community/1700-FBP-metody/)的评论中对此方法提供反馈在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftPickupDlvEditRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pickup_details | object | 是 | Детали доставки. |
|   pickup_details.address | string | 是 | 地址。 |
|   pickup_details.comment | string | 是 | 备注。 |
|   pickup_details.date | string | 是 | 送货日期。 |
|   pickup_details.sender_name | string | 是 | 发件人姓名。 |
|   pickup_details.sender_phone | string | 是 | 发件人电话号码。 |
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpDraftPickupDlvEditResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/draft/pick-up/product/validate`

**验证用于 pick-up 交货的商品列表**

`operationId: FbpAPI_FbpDraftPickUpProductValidate`

您可以在[讨论](https://dev.ozon.ru/community/1700-FBP-metody/)的评论中对此方法提供反馈在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftPickUpProductValidateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| skus | array<object> | 是 | 商品标识符（SKU）列表。 |
|   skus[].count | integer | 是 | 交货商品数量。 |
|   skus[].sku | integer | 是 | 商品标识符（SKU）。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpDraftPickUpProductValidateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| approved_items | array<object> | 否 | 已确认商品。 |
|   approved_items[].barcode | string | 否 | 条形码。 |
|   approved_items[].icon_name | string | 否 | 商品图片链接。 |
|   approved_items[].name | string | 否 | 商品名称。 |
|   approved_items[].offer_id | string | 否 | 卖家系统中的商品货号。 |
|   approved_items[].quantity | integer | 否 | 商品数量。 |
|   approved_items[].sku | integer | 否 | 商品标识符（SKU）。 |
|   approved_items[].volume | number | 否 | 商品体积。 |
| bundle_generated | boolean | 否 | `true`，前提是已创建校验商品列表。 |
| bundle_id | string | 否 | 校验商品列表标识符。 |
| rejected_items | array<object> | 否 | 被拒绝的商品。 |
|   rejected_items[].barcode | string | 否 | 条形码。 |
|   rejected_items[].icon_name | string | 否 | 商品图片链接。 |
|   rejected_items[].name | string | 否 | 商品名称。 |
|   rejected_items[].offer_id | string | 否 | 卖家系统中的商品货号。 |
|   rejected_items[].quantity | integer | 否 | 商品数量。 |
|   rejected_items[].rejection_reasons | array<string> | 否 | 拒绝原因：    - `BUNDLE_ITEM_ERROR_UNSPECIFIED`——未指定；    - `OUT_OF_ASSORTMENT`——未找到商品；    - `INVALID`——商品未创建；    - `INCOMPATIBLE_WAREHOUSE`——仓库标识符错误    - `INVALID_BARCODE`——未指定条形码；    - `MULTIPLICITY`——商品数... |
|   rejected_items[].sku | integer | 否 | 商品标识符（SKU）。 |
|   rejected_items[].volume | number | 否 | 商品体积。 |

---

### `POST` `/v1/fbp/draft/pick-up/registrate`

**将草稿单转为正式交货**

`operationId: FbpDraftPickUpRegistrate`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpDraftPickUpRegistrateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 交货申请标识符。 |

#### 响应（`v1FbpDraftPickUpRegistrateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误。 |
|   error.bundle_errors | array<object> | 否 | 商品验证列表错误。 |
|     error.bundle_errors[].errors | array<string> | 否 | 错误： - `BUNDLE_ITEM_ERROR_UNSPECIFIED`——未指定； - `OUT_OF_ASSORTMENT`——商品不在交货品类中； - `INVALID`——状态不正确； - `INCOMPATIBLE_WAREHOUSE`——仓库标识符不正确； - `INVALID_BARCODE`——未填写条形码； - `MULTIPLICITY`——商品数量不是包装的整数倍； - `... |
|     error.bundle_errors[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|   error.order_error | string | 否 | 交货注册错误：  - `ORDER_ERROR_TYPE_UNSPECIFIED` — 未知订单错误类型；  - `INVALID_NUMBER_OF_PACKAGE_UNITS` — 申请中货位数量错误；  - `MAXIMUM_NUMBER_OF_UNIQUE_SKU_REACHED` — 申请中唯一SKU数量超限；  - `MAXIMUM_BUNDLE_VOLUME_REACHED` — 达... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

