# FBP订单与配送

> Ozon Seller API — FBP订单与配送
>
> 基础地址：`https://api-seller.ozon.ru`
>
> 认证请求头：`Client-Id`、`Api-Key`、`Content-Type: application/json`

---

## 目录

**处理 FBP direct 请求**（4）

- `POST` `/v1/fbp/order/direct/cancel` — 取消交货
- `POST` `/v1/fbp/order/direct/seller-dlv/edit` — 更新卖家自配送信息
- `POST` `/v1/fbp/order/direct/timeslot/edit` — 编辑交货申请中的时间段
- `POST` `/v1/fbp/order/direct/timeslot/list` — 获取交货时间段列表

**处理 FBP drop-off 请求**（3）

- `POST` `/v1/fbp/order/drop-off/cancel` — 取消 drop-off 交货
- `POST` `/v1/fbp/order/drop-off/dlv/edit` — 编辑收货点的送货信息
- `POST` `/v1/fbp/order/drop-off/timetable` — 获取接收点的营业时间表

**处理 FBP pick-up 请求**（2）

- `POST` `/v1/fbp/order/pick-up/cancel` — 取消上门揽收交货
- `POST` `/v1/fbp/order/pick-up/dlv/edit` — 更改取货地点信息

**FBP配送**（11）

- `POST` `/v1/fbp/act-from/create` — 生成验收证明书
- `POST` `/v1/fbp/act-from/get` — 获取验收证明书生成状态
- `POST` `/v1/fbp/act-to/create` — 生成货物运单
- `POST` `/v1/fbp/act-to/get` — 获取货物运单生成状态
- `POST` `/v1/fbp/archive/get` — 获取已完成交货信息
- `POST` `/v1/fbp/archive/list` — 获取已完成交货列表
- `POST` `/v1/fbp/label/create` — 创建标签生成任务
- `POST` `/v1/fbp/label/get` — 获取标签生成任务状态
- `POST` `/v1/fbp/order/get` — 获取关于特定交货的信息
- `POST` `/v1/fbp/order/list` — 获取交货列表
- `POST` `/v1/posting/fbp/list` — 获取货件列表

---

## 处理 FBP direct 请求

### `POST` `/v1/fbp/order/direct/cancel`

**取消交货**

`operationId: FbpAPI_FbpOrderDirectCancel`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpOrderDirectCancelRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 供货申请标识符。 |

#### 响应（`v1FbpOrderDirectCancelResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误信息。 |
|   error.order_errors | array<string> | 否 | 错误类型： - `ERROR_TYPE_UNSPECIFIED`——未定义； - `DELIVERY_DRIVER_NAME_LENGTH_MAXIMUM_REACHED`——司机姓名长度超限； - `DELIVERY_VEHICLE_GENRE_LENGTH_MAXIMUM_REACHED`——车辆类型长度超限； - `DELIVERY_VEHICLE_REGISTRATION_PLATE_LE... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/order/direct/seller-dlv/edit`

**更新卖家自配送信息**

`operationId: FbpAPI_FbpOrderDirectSellerDlvEdit`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpOrderDirectSellerDlvEditRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| driver_name | string | 是 | 司机姓名。 |
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 供货申请标识符。 |
| vehicle_number | string | 是 | 车牌号。 |
| vehicle_type | string | 是 | 车辆类型。 |

#### 响应（`v1FbpOrderDirectSellerDlvEditResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误信息。 |
|   error.order_errors | array<string> | 否 | 错误类型： - `ERROR_TYPE_UNSPECIFIED`——未定义； - `DELIVERY_DRIVER_NAME_LENGTH_MAXIMUM_REACHED`——司机姓名长度超限； - `DELIVERY_VEHICLE_GENRE_LENGTH_MAXIMUM_REACHED`——车辆类型长度超限； - `DELIVERY_VEHICLE_REGISTRATION_PLATE_LE... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/order/direct/timeslot/edit`

**编辑交货申请中的时间段**

`operationId: FbpAPI_FbpEditTimeslot`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpEditTimeslotRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 供货申请标识符。 |
| timeslot_start | string | 是 | 时间段开始时间。 |

#### 响应（`v1FbpEditTimeslotResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error_reasons | array<string> | 否 | 错误原因： - `RESERVE_FAILURE_TYPE_UNSPECIFIED`——未定义； - `REQUEST_VALIDATION`——请求中填写了过去的预定日期； - `INVALID_RESERVE`——原始预留未找到、已失效或已包含申请，但尝试覆盖； - `LOGISTICS_REASON`——物流方错误； - `SCHEDULE_REASON`——排期方错误； - `NO_CAP... |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/order/direct/timeslot/list`

**获取交货时间段列表**

`operationId: FbpAPI_FbpAvailableTimeslotList`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpAvailableTimeslotListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| interval_end | string | 是 | 可用时间段所需区间的结束日期。 |
| interval_start | string | 是 | 可用时间段所需区间的开始日期。 |
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpAvailableTimeslotListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| reasons | array<string> | 否 | 缺少时间段的原因： - `EMPTY_TIMESLOTS_REASON_UNSPECIFIED`——未定义； - `LOGISTICS_UNKNOWN`——物流方未知错误； - `NO_ROUTE`——没有路线； - `NO_ROUTE_SCHEDULES`——路线上没有排期； - `NO_LOGISTICS_CAPACITY`——路线上可用的时段不足； - `SCHEDULE_UNKNOWN`—... |
| timeslots | array<object> | 否 | 可用时间段列表。 |
|   timeslots[].timeslot_end | string | 否 | 时间段结束日期。 |
|   timeslots[].timeslot_start | string | 否 | 时间段开始日期。 |
| warehouse_timezone_name | string | 否 | 卖家仓库的时区。 |

---

## 处理 FBP drop-off 请求

### `POST` `/v1/fbp/order/drop-off/cancel`

**取消 drop-off 交货**

`operationId: FbpAPI_FbpOrderDropOffCancel`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpOrderDropOffCancelRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpOrderDropOffCancelResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误信息。 |
|   error.order_errors | array<string> | 否 | 错误类型： - `ERROR_TYPE_UNSPECIFIED`——未定义； - `DELIVERY_DRIVER_NAME_LENGTH_MAXIMUM_REACHED`——司机姓名长度超限； - `DELIVERY_VEHICLE_GENRE_LENGTH_MAXIMUM_REACHED`——车辆类型长度超限； - `DELIVERY_VEHICLE_REGISTRATION_PLATE_LE... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/order/drop-off/dlv/edit`

**编辑收货点的送货信息**

`operationId: FbpAPI_FbpOrderDropOffDlvEdit`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpOrderDropOffDlvEditRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| drop_off_date | string | 是 | 交货到揽收点的到达日期。 |
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpOrderDropOffDlvEditResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/order/drop-off/timetable`

**获取接收点的营业时间表**

`operationId: FbpAPI_FbpOrderDropOffTimetable`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpOrderDropOffTimetableRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| drop_off_point_id | integer | 是 | 揽收点标识符。 |
| province_uuid | string | 是 | 省份唯一标识符。 |
| warehouse_id | integer | 是 | 仓库标识符。 |

#### 响应（`v1FbpOrderDropOffTimetableResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| calendar | array<object> | 否 | 接收点的营业时间信息。 |
|   calendar[].calendar_item | object | 否 | 日期信息。 |
|     calendar[].calendar_item.break_hours | object | 否 | 休息时间信息。 |
|       calendar[].calendar_item.break_hours.timeslot_end | string | 否 | 开始时间。 |
|       calendar[].calendar_item.break_hours.timeslot_start | string | 否 | 结束时间。 |
|     calendar[].calendar_item.is_holiday | boolean | 否 | `true`，表示休息日。 |
|     calendar[].calendar_item.opening_hours | object | 否 | 营业时间信息。 |
|       calendar[].calendar_item.opening_hours.timeslot_end | string | 否 | 开始时间。 |
|       calendar[].calendar_item.opening_hours.timeslot_start | string | 否 | 结束时间。 |
|   calendar[].day_of_week | string | 否 | 星期：  - `DAY_OF_WEEK_UNSPECIFIED`——未指定；  - `MONDAY`——星期一；  - `TUESDAY`——星期二；  - `WEDNESDAY`——星期三；  - `THURSDAY`——星期四；  - `FRIDAY`——星期五；  - `SATURDAY`——星期六；  - `SUNDAY`——星期日。 |

---

## 处理 FBP pick-up 请求

### `POST` `/v1/fbp/order/pick-up/cancel`

**取消上门揽收交货**

`operationId: FbpAPI_FbpOrderPickUpCancel`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpOrderPickUpCancelRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpOrderPickUpCancelResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误信息。 |
|   error.order_errors | array<string> | 否 | 错误类型： - `ERROR_TYPE_UNSPECIFIED`——未定义； - `DELIVERY_DRIVER_NAME_LENGTH_MAXIMUM_REACHED`——司机姓名长度超限； - `DELIVERY_VEHICLE_GENRE_LENGTH_MAXIMUM_REACHED`——车辆类型长度超限； - `DELIVERY_VEHICLE_REGISTRATION_PLATE_LE... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

### `POST` `/v1/fbp/order/pick-up/dlv/edit`

**更改取货地点信息**

`operationId: FbpAPI_FbpOrderPickUpDlvEdit`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpOrderPickUpDlvEditRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| pickup_details | object | 是 | 发件人详细信息。 |
|   pickup_details.sender_name | string | 是 | 发件人姓名。 |
|   pickup_details.sender_phone | string | 是 | 发件人电话号码。 |
| row_version | integer | 是 | 草稿的当前版本标识符。 |
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpOrderPickUpDlvEditResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | object | 否 | 错误信息。 |
|   error.order_errors | array<string> | 否 | 错误类型： - `ERROR_TYPE_UNSPECIFIED`——未定义； - `DELIVERY_DRIVER_NAME_LENGTH_MAXIMUM_REACHED`——司机姓名长度超限； - `DELIVERY_VEHICLE_GENRE_LENGTH_MAXIMUM_REACHED`——车辆类型长度超限； - `DELIVERY_VEHICLE_REGISTRATION_PLATE_LE... |
| is_error | boolean | 否 | `true`，前提是有错误。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |

---

## FBP配送

### `POST` `/v1/fbp/act-from/create`

**生成验收证明书**

`operationId: FbpAPI_FbpCreateAct`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpCreateActRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpCreateActResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| errors | array<string> | 否 | 错误原因： - `CREATE_ACT_ERROR_REASON_UNSPECIFIED` ——未定义； - `INVALID_ORDER_TYPE` ——无法为指定标识符创建验收证明书。 |
| file_uuid | string | 否 | 验收证明书标识符。 |
| is_success | boolean | 否 | `true`，前提是请求中没有错误。 |

---

### `POST` `/v1/fbp/act-from/get`

**获取验收证明书生成状态**

`operationId: FbpAPI_FbpCheckActState`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpCheckActStateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| file_uuid | string | 是 | 验收证明书标识符。 |

#### 响应（`v1FbpCheckActStateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cdn_url | string | 否 | 验收证明书链接。 |
| error | string | 否 | 生成错误： - `ERROR_REASON_UNSPECIFIED` ——未定义； - `INVALID_COMPANY` ——公司无效； - `FILE_NOT_FOUND` ——文件未找到； - `GENERATE_TIMEOUT_REACHED` ——超出生成时间； - `GENERATION_ERROR` ——生成过程中出错。 |
| status | string | 否 | 生成状态： - `STATUS_UNSPECIFIED` ——未定义； - `NOT_EXIST` ——不存在； - `PROCESSING` ——处理中； - `EXIST` ——已完成； - `ERROR` ——错误。 |

---

### `POST` `/v1/fbp/act-to/create`

**生成货物运单**

`operationId: FbpAPI_FbpCreateConsignmentNote`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpCreateConsignmentNoteRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpCreateConsignmentNoteResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| code | string | 否 | 货物运单标识符。 |

---

### `POST` `/v1/fbp/act-to/get`

**获取货物运单生成状态**

`operationId: FbpAPI_FbpCheckConsignmentNoteState`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpCheckConsignmentNoteStateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| code | string | 是 | 货物运单标识符。 |
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpCheckConsignmentNoteStateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error_message | string | 否 | 错误描述。 |
| label_url | string | 否 | 交货标签链接。 |
| state | string | 否 | 生成状态： - `STATE_TYPE_UNSPECIFIED` ——未定义； - `IN_PROGRESS` ——进行中； - `FINISHED` ——成功完成； - `FAILED` ——错误。 |

---

### `POST` `/v1/fbp/archive/get`

**获取已完成交货信息**

`operationId: FbpAPI_FbpArchiveGet`

您可以在[讨论](https://dev.ozon.ru/community/1700-FBP-metody/)的评论中对此方法提供反馈在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpArchiveGetRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpArchiveGetResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| act_file_uuid | string | 否 | 验收证明书标识符。 |
| bundle_id | string | 否 | 已验证商品清单的标识符。 |
| bundle_sku_summary | object | 否 | 交货商品汇总信息。 |
|   bundle_sku_summary.rounded_total_volume_in_litres | number | 否 | 商品总体积（升）。 |
|   bundle_sku_summary.total_items_count | integer | 否 | 交货中的SKU数量。 |
|   bundle_sku_summary.total_quantity | integer | 否 | 交货中的商品数量。 |
| business_flow_type_id | integer | 否 | 交货类型标识符。 |
| created_date | string | 否 | 交货申请创建日期和时间。 |
| decline_reason | object | 否 | 拒绝交货的原因。 |
|   decline_reason.code | string | 否 | 拒绝交货原因代码：  - `DECLINE_REASON_CODE_UNSPECIFIED`：未指定；  - `CANNOT_CREATE_SUPPLY_ON_TPF`：无法在3PF创建交货；  - `DROP_OFF_POINT_CLOSED`：揽收点已关闭；  - `CODE_SUPPLY_LOST`：交货丢失；  - `COURIER_PICK_UP_REJECTED_BY_SELLER`：... |
|   decline_reason.message | string | 否 | 拒绝原因说明。 |
| delivery_details | object | 否 | 配送详情。 |
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
| has_act | boolean | 否 | `true`，前提是已生成交接单。 |
| has_label | boolean | 否 | `true`，前提是已生成标签。 |
| id | integer | 否 | 档案记录编号。 |
| order_draft_id | integer | 否 | 交货草稿标识符。 |
| order_number | string | 否 | 已完成交货标识符。 |
| package_units_count | integer | 否 | 货位数量。 |
| receive_date | string | 否 | 交货接收日期和时间。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |
| status | string | 否 | 已完成的交货状态： - `ARCHIVE_STATUS_UNSPECIFIED`：未指定； - `COMPLETED`：已完成； - `REJECTED_AT_SUPPLY_WAREHOUSE`：被仓库拒绝； - `CANCELLED_BY_SELLER`：卖家取消。 |
| supply_id | string | 否 | 交货标识符。 |
| warehouse_id | integer | 否 | 仓库标识符。 |

---

### `POST` `/v1/fbp/archive/list`

**获取已完成交货列表**

`operationId: FbpAPI_FbpArchiveList`

您可以在[讨论](https://dev.ozon.ru/community/1700-FBP-metody/)的评论中对此方法提供反馈在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpArchiveListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| count | string | 是 | 响应中的元素数量。 |
| last_id | string | 否 | 页面上最后一个值的标识符。首次请求时请留空。  如需获取后续数据，请填写上次响应中的 `last_id`。 |

#### 响应（`v1FbpArchiveListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| has_next | boolean | 否 | `true`，前提是本次响应未返回所有数据。 |
| items | array<object> | 否 | 已完成交货。 |
|   items[].act_file_uuid | string | 否 | 验收证明书标识符。 |
|   items[].bundle_id | string | 否 | 已验证商品清单的标识符。 |
|   items[].bundle_sku_summary | object | 否 | 交货商品汇总信息。 |
|     items[].bundle_sku_summary.rounded_total_volume_in_litres | number | 否 | 商品总体积（升）。 |
|     items[].bundle_sku_summary.total_items_count | integer | 否 | 交货中的SKU数量。 |
|     items[].bundle_sku_summary.total_quantity | integer | 否 | 交货中的商品数量。 |
|   items[].created_date | string | 否 | 交货申请创建日期。 |
|   items[].decline_reason | object | 否 | 拒绝交货的原因。 |
|     items[].decline_reason.code | string | 否 | 拒绝交货原因代码：  - `DECLINE_REASON_CODE_UNSPECIFIED`：未指定；  - `CANNOT_CREATE_SUPPLY_ON_TPF`：无法在3PF创建交货；  - `DROP_OFF_POINT_CLOSED`：揽收点已关闭；  - `CODE_SUPPLY_LOST`：交货丢失；  - `COURIER_PICK_UP_REJECTED_BY_SELLER`：... |
|     items[].decline_reason.message | string | 否 | 拒绝原因说明。 |
|   items[].delivery_details | object | 否 | 配送详情。 |
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
|   items[].external_order_id | string | 否 | 合作仓库自身系统已完成交货的标识符。 |
|   items[].has_act | boolean | 否 | `true`，前提是已生成交接单。 |
|   items[].has_label | boolean | 否 | `true`，前提是已生成标签。 |
|   items[].order_draft_id | integer | 否 | 交货草稿标识符。 |
|   items[].package_units_count | integer | 否 | 货位数量。 |
|   items[].receive_date | string | 否 | 交货接收日期和时间。 |
|   items[].row_version | integer | 否 | 草稿的当前版本标识符。 |
|   items[].status | string | 否 | 已完成的交货状态： - `ARCHIVE_STATUS_UNSPECIFIED`：未指定； - `COMPLETED`：已完成； - `REJECTED_AT_SUPPLY_WAREHOUSE`：被仓库拒绝； - `CANCELLED_BY_SELLER`：卖家取消。 |
|   items[].supply_id | string | 否 | 交货标识符。 |
|   items[].warehouse_id | integer | 否 | 仓库标识符。 |
|   items[].whc_order_id | integer | 否 | 合作仓库已完成交货的标识符。 |
| last_id | integer | 否 | 页面上最后一个值的标识符。 |

---

### `POST` `/v1/fbp/label/create`

**创建标签生成任务**

`operationId: FbpAPI_FbpCreateLabel`

您可以在[讨论](https://dev.ozon.ru/community/1700-FBP-metody/)的评论中对此方法提供反馈在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpCreateLabelRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpCreateLabelResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| code | string | 否 | 标签生成任务标识符。 |

---

### `POST` `/v1/fbp/label/get`

**获取标签生成任务状态**

`operationId: FbpAPI_FbpGetLabel`

您可以在[讨论](https://dev.ozon.ru/community/1700-FBP-metody/)的评论中对此方法提供反馈在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpGetLabelRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| code | string | 是 | 标签生成任务标识符。 |
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpGetLabelResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| label_url | string | 否 | 交货标签链接。 |
| state | string | 否 | 标签生成任务状态： - `UNSPECIFIED`：未指定； - `IN_PROGRESS`：生成中； - `FINISHED`：生成成功； - `FAILED`：生成失败。 |

---

### `POST` `/v1/fbp/order/get`

**获取关于特定交货的信息**

`operationId: FbpAPI_FbpOrderGet`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpOrderGetRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| supply_id | string | 是 | 交货标识符。 |

#### 响应（`v1FbpOrderGetResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| attention_reasons | array<string> | 否 | 警告原因： - `ORDER_ATTENTION_TYPE_UNSPECIFIED`——未指定； - `OLD`——过期申请； - `TIME_SLOT_EXPIRED`——时间段已过期。 |
| bundle_uuid | string | 否 | 组成商品标识符。 |
| can_be_cancelled | boolean | 否 | `true`，如果申请可以取消。 |
| cancellation_state | object | 否 | 取消原因。 |
|   cancellation_state.cancellation_error | object | 否 | 取消错误。 |
|     cancellation_state.cancellation_error.error_code | string | 否 | 取消错误代码： - `CODE_UNSPECIFIED`——未指定； - `NO_RESPONSE_FROM_3PF`——取消申请未确认，未收到第三方响应； - `ACCEPTANCE_ALREADY_STARTED`——取消申请未确认，已开始验收。 |
|     cancellation_state.cancellation_error.message | string | 否 | 错误描述。 |
|   cancellation_state.cancellation_status | string | 否 | 错误状态：   - `STATUS_UNSPECIFIED`——未指定；   - `CONFIRMATION`——等待申请取消确认；   - `CANCELED`——取消已确认；   - `NOT_CANCELED`——未收到取消确认。 |
| created_date | string | 否 | 交货创建日期。 |
| delivery_details | object | 否 | 配送详情。 |
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
| draft_id | integer | 否 | 草稿标识符。 |
| has_consignment_note | boolean | 否 | `true`，如果有已签署的文件。 |
| has_label | boolean | 否 | `true`，如果有标签。 |
| id | integer | 否 | 交货申请标识符。 |
| locked | boolean | 否 | `true`，如果无法编辑交货。 |
| order_number | string | 否 | 交货编号。 |
| package_units_count | integer | 否 | 货位数量。 |
| receive_date | string | 否 | 交货接收日期和时间。 |
| row_version | integer | 否 | 草稿的当前版本标识符。 |
| status | string | 否 | 订单状态：  - `ORDER_STATUS_UNSPECIFIED`——未指定；  - `READY_TO_SUPPLY`——准备发运；  - `FILLING_DELIVERY_DETAILS`——填写交货数据；  - `COURIER_ASSIGNED`——已分配快递员；  - `COURIER_PICKED_UP`——快递员已取件；  - `ACCEPTANCE_AT_DROP_OFF_P... |
| supply_id | string | 否 | 交货申请标识符。 |
| warehouse_id | integer | 否 | 仓库标识符。 |

---

### `POST` `/v1/fbp/order/list`

**获取交货列表**

`operationId: FbpAPI_FbpOrderList`

您可以在 [讨论](https://dev.ozon.ru/community/1700-FBP-metody/) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`v1FbpOrderListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| count | integer | 是 | 响应中的交货数量。 |
| last_id | integer | 否 | 页面上最后一次交货的标识符。首次请求时请将此字段留空。  如需获取后续数据，请填写上一次请求响应中最后一次交货的`id`。 |

#### 响应（`v1FbpOrderListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| has_next | boolean | 否 | `true`，如果响应中未返回所有交货。 |
| items | array<object> | 否 | 交货。 |
|   items[].attention_reasons | array<string> | 否 | 警告原因： - `ORDER_ATTENTION_TYPE_UNSPECIFIED`——未指定； - `OLD`——过期申请； - `TIME_SLOT_EXPIRED`——时间段已过期。 |
|   items[].bundle_summary | object | 否 | 交货商品汇总信息。 |
|     items[].bundle_summary.rounded_total_volume_in_litres | number | 否 | 商品总体积（升）。 |
|     items[].bundle_summary.total_item_count | integer | 否 | 交货中的SKU数量。 |
|     items[].bundle_summary.total_quantity | integer | 否 | 交货中的商品数量。 |
|   items[].can_be_cancelled | boolean | 否 | `true`，如果申请可以取消。 |
|   items[].cancellation_state | object | 否 | 取消原因。 |
|     items[].cancellation_state.cancellation_error | object | 否 | 取消错误。 |
|       items[].cancellation_state.cancellation_error.error_code | CancellationErrorCode | 否 |  |
|       items[].cancellation_state.cancellation_error.message | string | 否 | 错误描述。 |
|     items[].cancellation_state.cancellation_status | string | 否 | 错误状态：   - `STATUS_UNSPECIFIED`——未指定；   - `CONFIRMATION`——等待申请取消确认；   - `CANCELED`——取消已确认；   - `NOT_CANCELED`——未收到取消确认。 |
|   items[].created_date | string | 否 | 交货创建日期。 |
|   items[].delivery_details | object | 否 | 配送详情。 |
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
|   items[].has_consignment_note | boolean | 否 | `true`，如果有已签署的文件。 |
|   items[].has_label | boolean | 否 | `true`，如果有标签。 |
|   items[].id | integer | 否 | 交货申请标识符。 |
|   items[].locked | boolean | 否 | `true`，如果无法编辑交货。 |
|   items[].order_number | string | 否 | 交货编号。 |
|   items[].package_units_count | integer | 否 | 货位数量。 |
|   items[].receive_date | string | 否 | 交货接收日期和时间。 |
|   items[].status | string | 否 | 订单状态：  - `ORDER_STATUS_UNSPECIFIED`——未指定；  - `READY_TO_SUPPLY`——准备发运；  - `FILLING_DELIVERY_DETAILS`——填写交货数据；  - `COURIER_ASSIGNED`——已分配快递员；  - `COURIER_PICKED_UP`——快递员已取件；  - `ACCEPTANCE_AT_DROP_OFF_P... |
|   items[].supply_id | string | 否 | 交货申请标识符。 |
|   items[].warehouse_id | integer | 否 | 仓库标识符。 |
| last_id | integer | 否 | 页面上最后一次交货的标识符。 |

---

### `POST` `/v1/posting/fbp/list`

**获取货件列表**

`operationId: PostingFbpList`

您可以在 [讨论](https://dev.ozon.ru/community/2054-Novyi-beta-metod-dlia-raboty-s-FBP-postingami-v-Seller-API/ ) 的评论中对此方法提供反馈 在 Ozon for dev 开发者社区中。

#### 请求体（`posting.v1.PostingFbpListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| filter | object | 否 | 用于搜索货件的筛选器。 |
|   filter.name | string | 否 | 商品名称。 |
|   filter.offer_id | string | 否 | 卖家系统中的商品标识符，即货号。 |
|   filter.posting_numbers | array<string> | 否 | 货件编号。 |
|   filter.since | string | 否 | 时间段开始。 |
|   filter.statuses | array<string> | 否 | 货件状态。 |
|   filter.to | string | 否 | 时间段结束。 |
| limit | integer | 否 | 响应中返回的值数量。 |
| sort_by | string | 否 | 货件排序参数： - `last_change_status_date`——按最后一次状态变更日期排序； - `in_process_at`——按开始处理日期排序。 |
| sort_dir | string | 否 | 排序方向： - `ASC`——升序； - `DESC`——降序。 |

#### 响应（`posting.v1.PostingFbpListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| postings | array<object> | 否 | 货件列表。 |
|   postings[].financial_data | object | 否 | 财务数据。 |
|     postings[].financial_data.cluster_from | string | 否 | 订单发出地区代码。 |
|     postings[].financial_data.cluster_to | string | 否 | 订单配送地区代码。 |
|     postings[].financial_data.delivery_amount | number | 否 | 配送费用。 |
|     postings[].financial_data.products | array<object> | 否 | 订单中的商品列表。 |
|       postings[].financial_data.products[].actions | array<posting.v1.PostingFbpListResponse.Postings.FinancialData.Products.Actions> | 否 | 促销活动列表。 |
|       postings[].financial_data.products[].commissions_currency_code | string | 否 | 佣金货币代码。 |
|       postings[].financial_data.products[].old_price | number | 否 | 折扣前的价格。商品卡上会以划线价显示。 |
|       postings[].financial_data.products[].price | number | 否 | 计入促销活动后的商品价格，不包括由Ozon承担费用的促销活动。 |
|       postings[].financial_data.products[].product_id | integer | 否 | Ozon系统中的商品标识符，即SKU。 |
|       postings[].financial_data.products[].quantity | integer | 否 | 商品数量。 |
|       postings[].financial_data.products[].total_discount_percent | number | 否 | 折扣百分比。 |
|       postings[].financial_data.products[].total_discount_value | number | 否 | 折扣金额。 |
|   postings[].in_process_at | string | 否 | 货件开始处理的日期和时间。 |
|   postings[].order_date | string | 否 | 订单的创建日期。 |
|   postings[].order_id | integer | 否 | 该货件所属订单的标识符。 |
|   postings[].order_number | string | 否 | 该货件所属订单的编号。 |
|   postings[].posting_number | string | 否 | 货件编号。 |
|   postings[].products | array<object> | 否 | 货件中商品列表。 |
|     postings[].products[].customer_price | object | 否 | 网站上的商品价格。 |
|       postings[].products[].customer_price.amount | string | 否 | 金额。 |
|       postings[].products[].customer_price.currency | string | 否 | 货币单位。 |
|     postings[].products[].name | string | 否 | 订单中的商品名称。 |
|     postings[].products[].offer_id | string | 否 | 卖家系统中的商品标识符，即货号。 |
|     postings[].products[].price | object | 否 | 商品价格。 |
|       postings[].products[].price.amount | string | 否 | 金额。 |
|       postings[].products[].price.currency | string | 否 | 货币单位。 |
|     postings[].products[].quantity | integer | 否 | 货件中的商品数量。 |
|     postings[].products[].seller_price | object | 否 | 计入Ozon折扣后的卖家价格。 |
|       postings[].products[].seller_price.amount | string | 否 | 金额。 |
|       postings[].products[].seller_price.currency | string | 否 | 货币单位。 |
|     postings[].products[].sku | integer | 否 | Ozon系统中的商品标识符，即SKU。 |
|   postings[].provider_id | integer | 否 | 配送服务标识符。 |
|   postings[].status | string | 否 | 货件状态。 |

---

