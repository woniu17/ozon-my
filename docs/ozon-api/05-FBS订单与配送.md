# FBS订单与配送

> Ozon Seller API — FBS订单与配送
>
> 基础地址：`https://api-seller.ozon.ru`
>
> 认证请求头：`Client-Id`、`Api-Key`、`Content-Type: application/json`

---

## 目录

**FBS和rFBS订单处理**（14）

- `POST` `/v3/posting/fbs/unfulfilled/list` — 未处理货件列表
- `POST` `/v4/posting/fbs/unfulfilled/list` — 获取未处理货件列表
- `POST` `/v3/posting/fbs/list` — 货件列表
- `POST` `/v4/posting/fbs/list` — 获取货件列表
- `POST` `/v3/posting/fbs/get` — 按照ID获取货件信息
- `POST` `/v2/posting/fbs/get-by-barcode` — 按条形码获取有关货件的信息
- `POST` `/v2/posting/fbs/product/country/list` — 可用产地名单
- `POST` `/v2/posting/fbs/product/country/set` — 添加商品产地信息
- `POST` `/v2/posting/fbs/package-label` — 打印标签
- `POST` `/v2/posting/fbs/awaiting-delivery` — 货件装运
- `POST` `/v2/posting/fbs/cancel-reason/list` — 货件取消原因
- `POST` `/v1/posting/fbs/cancel-reason` — 货运取消原因
- `POST` `/v2/posting/fbs/cancel` — 取消货运
- `POST` `/v2/posting/fbs/product/cancel` — 取消某些商品发货

**FBS/rFBS标志代码和订单备货管理**（2）

- `POST` `/v4/posting/fbs/ship` — 搜集订单 (第4方案)
- `POST` `/v4/posting/fbs/ship/package` — 货件的部分装配 (第4方案)

**FBS配送**（12）

- `POST` `/v1/carriage/create` — 创建发运
- `POST` `/v1/carriage/approve` — 发运确认
- `POST` `/v1/carriage/get` — 运输信息
- `POST` `/v1/posting/carriage-available/list` — 可供运输的列表
- `POST` `/v1/carriage/set-postings` — 发运组成商品更改
- `POST` `/v1/carriage/cancel` — 发运删除
- `POST` `/v2/posting/fbs/act/get-postings` — 单据中的货件列表
- `POST` `/v2/posting/fbs/act/get-container-labels` — 货位标签
- `POST` `/v1/assembly/carriage/posting/list` — 获取发运中的货件列表
- `POST` `/v1/assembly/carriage/product/list` — 获取发运中的商品列表
- `POST` `/v1/assembly/fbs/posting/list` — 获取货件列表
- `POST` `/v1/assembly/fbs/product/list` — 获取货件中的商品列表

---

## FBS和rFBS订单处理

### `POST` `/v3/posting/fbs/unfulfilled/list`

**未处理货件列表**

`operationId: PostingAPI_GetFbsPostingUnfulfilledList`

该方法将于2026年6月1日停用。请切换到/v4/posting/fbs/unfulfilled/list。  返回指定时间段的未处理货件列表 —— 不应超过一年。  可能的货件运输状态： - `awaiting_registration` — 等待注册， - `acceptance_in_progress` — 正在验收， - `awaiting_approve` — 等待确认， - `awaiting_packaging` — 等待包装， - `awaiting_deliver` — 等待装运， - `arbitration` — 仲裁， - `client_arbitration` — 快递客户仲裁， - `delivering` — 运输中， - `driver_pickup` — 司机处， - `cancelled` — 已取消， - `not_accepted` — 分拣中心未接受。

#### 请求体（`postingv3GetFbsPostingUnfulfilledListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| dir | string | 否 | 分类方向：   - `asc` — 从小到大，   - `desc` — 从大到小。 |
| filter | object | 是 | 请求过滤。  请按装运时间使用过滤器 — `cutoff`, 或者按照货件交付给快递的时间  — `delivering_date`。 如果一起使用，则会在响应中返回错误。  要按装运时间使用过滤器，请填 `cutoff_from` 和 `cutoff_to`字段。  要按货件交付给快递的时间使用过滤器, 请填 `delivering_date_from` 和 `delivering_date_t... |
|   filter.cutoff_from | string | 是 | 按卖家需要收订单的时间进行筛选。 时间段开始。  格式： YYYY-MM-DDThh:mm:ss.mcsZ. 例子： 2020-03-18T07:34:50.359Z. |
|   filter.cutoff_to | string | 是 | 按卖家需要收订单的时间进行筛选。 时间段结束。  格式： YYYY-MM-DDThh:mm:ss.mcsZ. 例子： 2020-03-18T07:34:50.359Z. |
|   filter.delivering_date_from | string | 否 | 将货件交给物流的最快日期。 |
|   filter.delivering_date_to | string | 否 | 将货件交给物流的最迟日期。 |
|   filter.delivery_method_id | array<integer> | 否 | 快递方式ID。按照运输方式筛选。可以使用方法 [/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
|   filter.last_changed_status_date | object | 否 | 货件状态最后一次发生变更的时间段。 |
|     filter.last_changed_status_date.from | string | 否 | 时间段的开始日期。 |
|     filter.last_changed_status_date.to | string | 否 | 时间段的结束日期。 |
|   filter.fbpFilter | string | 否 | 从合作伙伴仓库（FBP）发货时的货件筛选器：  - `ALL` —  响应中将显示所有符合其他筛选器条件的货件； - `ONLY` —  仅显示FBP货件； - `WITHOUT` —  显示除FBP外的所有货件。  默认值为 `ALL`。 |
|   filter.provider_id | array<integer> | 否 | 快递服务ID。按照运输方式筛选。可以使用方法 [/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
|   filter.status | string | 否 | 货件运输状态： - `acceptance_in_progress` — 正在验收， - `awaiting_approve` — 等待确认， - `awaiting_packaging` — 等待包装， - `awaiting_registration` — 等待注册， - `awaiting_deliver` — 等待装运， - `arbitration` — 仲裁， - `client_ar... |
|   filter.warehouse_id | array<integer> | 否 | 仓库ID。可以使用方法 [/v1/warehouse/list](#operation/WarehouseAPI_WarehouseList)获取。 |
| limit | integer | 是 | 响应中值的数量：   - 最大值 — 1000，   - 最小值 — 1。 |
| offset | integer | 是 | 将在响应中跳过的元素数。 例如，如果“offset=10”，那么响应将从找到的第11个元素开始。 |
| with | object | 否 | 要添加到响应的附加字段。 |
|   with.analytics_data | boolean | 否 | 将分析数据添加到响应中。 |
|   with.barcodes | boolean | 否 | 将货件条形码添加到响应中。 |
|   with.financial_data | boolean | 否 | 将财务数据添加到响应中。 |
|   with.legal_info | boolean | 否 | 将法律信息添加到响应中。 |
|   with.translit | boolean | 否 | 完成返回值的拼写。 |

#### 响应（`postingv3GetFbsPostingUnfulfilledListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| count | integer | 否 | 在响应中的元素计数器。 |
| postings | array<object> | 否 | 货件清单和每个货物的详细信息。 |
|   postings[].addressee | object | 否 | 收件人联系方式。 |
|     postings[].addressee.name | string | 否 | 收件人姓名。 |
|     postings[].addressee.phone | string | 否 | 收件人联系电话。总是返回空字符串 `""`。要获取替代联系电话，请使用方法 [/v3/posting/fbs/get](#operation/PostingAPI_GetFbsPostingV3)。 |
|   postings[].analytics_data | object | 否 | 分析数据。 |
|     postings[].analytics_data.city | string | 否 | 快递城市。仅适用于rFBS货件和独联体卖家。 |
|     postings[].analytics_data.delivery_date_begin | string | 否 | 快递开始日期和时间。 |
|     postings[].analytics_data.delivery_date_end | string | 否 | 快递结束日期和时间。 |
|     postings[].analytics_data.delivery_type | string | 否 | 快递方式。 |
|     postings[].analytics_data.is_legal | boolean | 否 | 收件人是法人的标志：   - `true` — 法人，   - `false` — 自然人。 |
|     postings[].analytics_data.is_premium | boolean | 否 | 有Premium订阅。 |
|     postings[].analytics_data.payment_type_group_name | string | 否 | 付款方法： - `在线银行卡支付`， - `Ozon银行卡`， - `取货时自动从Ozon银行卡收费`， - `收货时从已保存的银行卡收费`， - `快速支付系统`， - `Ozon分期付款`， - `支付至结算账户`， - `SberPay`， - `外部卖家方的预付款`。 |
|     postings[].analytics_data.region | string | 否 | 快递地区。 |
|     postings[].analytics_data.tpl_provider | string | 否 | 快递服务。 |
|     postings[].analytics_data.tpl_provider_id | integer | 否 | 快递服务ID。 |
|     postings[].analytics_data.warehouse | string | 否 | 订单发送仓库名称。 |
|     postings[].analytics_data.warehouse_id | integer | 否 | 仓库ID。 |
|     postings[].analytics_data.client_delivery_date_begin | string | 否 | 向客户开始配送的日期和时间。仅适用于通过Ozon配送创建的货件。 |
|     postings[].analytics_data.client_delivery_date_end | string | 否 | 订单将送达客户的截止日期。仅适用于通过Ozon配送创建的货件。 |
|   postings[].available_actions |  | 否 | 可用的操作和货件信息包括： - `arbitration` — 提出争议； - `awaiting_delivery` — 转为“等待发运”状态； - `can_create_chat` — 与买家开启聊天； - `cancel` — 取消货件； - `click_track_number` — 在个人中心通过追踪号查看状态历史； - `customer_phone_available` — 获取... |
|   postings[].barcodes | object | 否 | 货件条码。 |
|     postings[].barcodes.lower_barcode | string | 否 | 货件标签的下条码。 |
|     postings[].barcodes.upper_barcode | string | 否 | 货件标签的上条码。 |
|   postings[].cancellation | object | 否 | 取消原因。 |
|     postings[].cancellation.affect_cancellation_rating | boolean | 否 | 如果取消影响买家排行 — `true`。 |
|     postings[].cancellation.cancel_reason | string | 否 | 取消原因。 |
|     postings[].cancellation.cancel_reason_id | integer | 否 | 取消货运的原因ID。 |
|     postings[].cancellation.cancellation_initiator | string | 否 | 取消货运的发起者：   - `卖家`,    - `客户` 或`买家`,   - `Ozon`,     - `系统`,    - `配送服务`。 |
|     postings[].cancellation.cancellation_type | string | 否 | 货运取消类型： - `seller` — 卖家取消； - `client` 或 `customer` — 买家取消； - `ozon` — Ozon取消； - `system`— 系统取消； - `delivery` — 配送服务取消。 |
|     postings[].cancellation.cancelled_after_ship | boolean | 否 | 如果订单在装运后取消 — `true`。 |
|   postings[].customer | object | 否 | 买家信息。 |
|     postings[].customer.address | object | 否 | 快递地址信息。 |
|       postings[].customer.address.address_tail | string | 否 | 文本格式的地址。 |
|       postings[].customer.address.city | string | 否 | 快递城市。 |
|       postings[].customer.address.comment | string | 否 | 订单评价。 |
|       postings[].customer.address.country | string | 否 | 快递国家。 |
|       postings[].customer.address.district | string | 否 | 快递地区。 |
|       postings[].customer.address.latitude | number | 否 | 宽。 |
|       postings[].customer.address.longitude | number | 否 | （时间的）长度。 |
|       postings[].customer.address.provider_pvz_code | string | 否 | 3PL提供商的订单提货点的代码。 |
|       postings[].customer.address.pvz_code | integer | 否 | 订单取货点代码。 |
|       postings[].customer.address.region | string | 否 | 快递区域。 |
|       postings[].customer.address.zip_code | string | 否 | 收件人邮编。 |
|     postings[].customer.customer_email | string | 否 | 买家的电子邮箱地址。 |
|     postings[].customer.customer_id | integer | 否 | 买家ID。 |
|     postings[].customer.name | string | 否 | 买家姓名。 |
|     postings[].customer.phone | string | 否 | 买家联系电话。始终返回空字符串 `""`。要获取替代联系电话，请使用方法 [/v3/posting/fbs/get](#operation/PostingAPI_GetFbsPostingV3)。 |
|   postings[].delivering_date | string | 否 | 货件交付物流的时间。 |
|   postings[].delivery_method | object | 否 | 快递方式。 |
|     postings[].delivery_method.id | integer | 否 | 快递方式ID。 |
|     postings[].delivery_method.name | string | 否 | 快递方式名称。 |
|     postings[].delivery_method.tpl_provider | string | 否 | 快递服务。 |
|     postings[].delivery_method.tpl_provider_id | integer | 否 | 快递服务ID。 |
|     postings[].delivery_method.warehouse | string | 否 | 仓库名称。 |
|     postings[].delivery_method.warehouse_id | integer | 否 | 仓库ID。 |
|   postings[].destination_place_id | integer | 否 | 目的仓库的标识符。 |
|   postings[].destination_place_name | string | 否 | 目的仓库的名称。 |
|   postings[].financial_data | object | 否 | 有关商品成本、折扣幅度、付款和佣金的信息。 |
|     postings[].financial_data.cluster_from | string | 否 | 订单发送区域代码。 |
|     postings[].financial_data.cluster_to | string | 否 | 订单接受区域代码。 |
|     postings[].financial_data.products | array<object> | 否 | 订单中的商品列表。 |
|       postings[].financial_data.products[].actions | array<string> | 否 | 活动清单。 |
|       postings[].financial_data.products[].currency_code | string | 否 | 价格货币，其与个人中心中设置的币种相匹配。  可能的值：   - `RUB` — 俄罗斯卢布，   - `BYN` — 白俄罗斯卢布，   - `KZT` — 坚戈，   - `EUR` — 欧元，   - `USD` — 美元，   - `CNY` — 元。 |
|       postings[].financial_data.products[].customer_currency_code | string | 否 | 买家货币代码。 |
|       postings[].financial_data.products[].commission_amount | number | 否 | 商品佣金大小。 |
|       postings[].financial_data.products[].commission_percent | integer | 否 | 佣金百分比。 |
|       postings[].financial_data.products[].commissions_currency_code | string | 否 | 计算佣金的币种代码。 |
|       postings[].financial_data.products[].old_price | number | 否 | 打折前价格。在商品卡片上将被显示划掉。 |
|       postings[].financial_data.products[].payout | number | 否 | 支付给卖方。 |
|       postings[].financial_data.products[].price | number | 否 | 您的价格。包含卖家促销（如有），不含 Ozon 资助的促销。 |
|       postings[].financial_data.products[].customer_price | number | 否 | 包含卖家与 Ozon 折扣的买家价格。 |
|       postings[].financial_data.products[].product_id | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|       postings[].financial_data.products[].quantity | integer | 否 | 运输商品数量。 |
|       postings[].financial_data.products[].total_discount_percent | number | 否 | 折扣百分比。 |
|       postings[].financial_data.products[].total_discount_value | number | 否 | 折扣数量。 |
|   postings[].in_process_at | string | 否 | 开始处理货件的日期和时间。 |
|   postings[].is_express | boolean | 否 | 如果使用快速物流 Ozon Express —— `true`。 |
|   postings[].is_presortable | boolean | 否 | 如果发运是预先分拣的，则为`true`。 |
|   postings[].legal_info | object | 否 | 买方的法律信息。 |
|     postings[].legal_info.company_name | string | 否 | 公司名称。 |
|     postings[].legal_info.inn | string | 否 | 纳税人识别号（INN）。 |
|     postings[].legal_info.kpp | string | 否 | 税务登记原因代码（KPP）。 |
|   postings[].optional | object | 否 | 带有附加特征的商品列表。 |
|     postings[].optional.products_with_possible_mandatory_mark | array<object> | 否 | 带有可能标志的商品列表。 |
|   postings[].order_id | integer | 否 | 货件所属订单的ID。 |
|   postings[].order_number | string | 否 | 货件所属的订单号。 |
|   postings[].parent_posting_number | string | 否 | 快递母件编号，从该母件中拆分出了当前货件。 |
|   postings[].posting_number | string | 否 | 货件号。 |
|   postings[].products | array<object> | 否 | 货运商品列表。 |
|     postings[].products[].name | string | 否 | 商品名称。 |
|     postings[].products[].offer_id | string | 否 | 在卖家系统中的商品ID — 货号。 |
|     postings[].products[].price | string | 否 | 商品价格。 |
|     postings[].products[].quantity | integer | 否 | 运输中的商品数量。 |
|     postings[].products[].sku | integer | 否 | 在Ozon系统中的商品ID — SKU。 |
|     postings[].products[].currency_code | string | 否 | 价格货币，其与个人中心中设置的币种相匹配。  可能的值：   - `RUB` — 俄罗斯卢布，   - `BYN` — 白俄罗斯卢布，   - `KZT` — 坚戈，   - `EUR` — 欧元，   - `USD` — 美元，   - `CNY` — 元。 |
|     postings[].products[].imei | array<string> | 否 | 移动设备的 IMEI 列表。 |
|   postings[].requirements | object | 否 | 需提供制造国、货运报关单号、商品批次登记号、“诚实标志”、其他标识或重量的商品列表，以便将货件状态更新至下一阶段。 |
|     postings[].requirements.products_requiring_change_country | array<string> | 否 | 需要修改生产国家的商品（SKU）编号列表。要修改生产国家，请使用方法 [/v2/posting/fbs/product/country/list](#operation/PostingAPI_ListCountryProductFbsPostingV2) 和 [/v2/posting/fbs/product/country/set](#operation/PostingAPI_SetCountry... |
|     postings[].requirements.products_requiring_gtd | array<string> | 否 | 必须提供货运报关单号（CCD）的商品 ID（SKU）列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供报关单号，或确认无该号码。 |
|     postings[].requirements.products_requiring_country | array<string> | 否 | 需要上传制造国信息的商品ID列表 (SKU)。  要配货，请上传上述商品的制造国信息，通过方法 [/v2/posting/fbs/product/country/set](#operation/PostingAPI_SetCountryProductFbsPostingV2)。 |
|     postings[].requirements.products_requiring_mandatory_mark | array<string> | 否 | 需要提供“诚实标志”标签的商品 ID（SKU）列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供“诚实标志”标签。 |
|     postings[].requirements.products_requiring_jw_uin | array<string> | 否 | 需要提供首饰唯一识别号（UIN）的商品列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供 UIN。 |
|     postings[].requirements.products_requiring_rnpt | array<string> | 否 | 需要提供商品批次注册号（RNPT）的商品 ID（SKU）列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供 RNPT。 |
|     postings[].requirements.products_requiring_imei | array<string> | 否 | 需要提供 IMEI 的商品 ID 列表。 |
|   postings[].shipment_date | string | 否 | 必须收取货件的日期和时间。 超出该时间后将适用新费率，相关信息请查看字段 `tariffication`。 |
|   postings[].shipment_date_without_delay | string | 否 | 不逾期发运日期和时间。 |
|   postings[].status | string | 否 | 货运状态: - `acceptance_in_progress` —— 正在验收， - `arbitration` —— 仲裁， - `awaiting_approve` —— 等待确认， - `awaiting_deliver` —— 等待装运， - `awaiting_packaging` —— 等待包装， - `awaiting_registration` —— 等待注册， - `await... |
|   postings[].substatus | string | 否 | 发货子状态： - `posting_acceptance_in_progress` —— 正在验收， - `posting_in_arbitration` —— 仲裁， - `posting_created` —— 已创建， - `posting_in_carriage` —— 在运输途中， - `posting_not_in_carriage` —— 未在运输中， - `posting_regi... |
|   postings[].tpl_integration_type | string | 否 | 快递服务集成类型：   - `ozon` —— Ozon 快递服务。   - `3pl_tracking` —— 集成服务快递。   - `non_integrated` —— 第三方物流服务。   - `aggregator` —— 通过Ozon合作物流伙伴交付。   - `hybryd`—— 俄罗斯邮政配送方案。 |
|   postings[].tracking_number | string | 否 | 货件跟踪号。 |
|   postings[].tariffication | object | 否 | 发运的计费信息。 |
|     postings[].tariffication.current_tariff_rate | number | 否 | 当前运费的百分比。 |
|     postings[].tariffication.current_tariff_type | string | 否 | 当前的计费类型 — 折扣或附加费。 |
|     postings[].tariffication.current_tariff_charge | string | 否 | 当前的折扣或附加费金额。 |
|     postings[].tariffication.current_tariff_charge_currency_code | string | 否 | 金额的货币单位。 |
|     postings[].tariffication.next_tariff_rate | number | 否 | 在参数 `next_tariff_starts_at` 指定的时间后，将按此百分比进行计费。 |
|     postings[].tariffication.next_tariff_type | string | 否 | 在参数 `next_tariff_starts_at` 指定的时间后，将按此类型计费 — 折扣或附加费。 |
|     postings[].tariffication.next_tariff_charge | string | 否 | 下一步计费中的折扣或附加金额。 |
|     postings[].tariffication.next_tariff_starts_at | string | 否 | 新的费率开始生效的日期和时间。  格式：`YYYY-MM-DDThh:mm:ss.mcsZ`.   示例：`2023-11-13T08:05:57.657Z`. |
|     postings[].tariffication.next_tariff_charge_currency_code | string | 否 | 新费率的货币单位。 |
|   postings[].tariffication_steps | array<object> | 否 | 计费阶段。 |
|     postings[].tariffication_steps[].min_charge | object | 否 | 最低折扣或附加费用。 |
|       postings[].tariffication_steps[].min_charge.amount | string | 否 | 金额。 |
|       postings[].tariffication_steps[].min_charge.currency | string | 否 | 货币单位。 |
|     postings[].tariffication_steps[].tariff_charge | object | 否 | 折扣或附加费用。 |
|       postings[].tariffication_steps[].tariff_charge.amount | string | 否 | 金额。 |
|       postings[].tariffication_steps[].tariff_charge.currency | string | 否 | 货币单位。 |
|     postings[].tariffication_steps[].tariff_deadline_at | string | 否 | 计费阶段结束的日期和时间。该日期后将自动进入下一计费阶段。 |
|     postings[].tariffication_steps[].tariff_rate | number | 否 | 折扣或附加费用百分比。 |
|     postings[].tariffication_steps[].tariff_type | string | 否 | 计费类型。 |

---

### `POST` `/v4/posting/fbs/unfulfilled/list`

**获取未处理货件列表**

`operationId: PostingFbsUnfulfilledList`

返回指定时间段内的货件列表，该时间段不得超过一年。  货件可能的状态： - `awaiting_registration`——等待登记； - `acceptance_in_progress`——接收中； - `awaiting_approve`——等待确认； - `awaiting_packaging`——等待包装； - `awaiting_deliver`——等待发运； - `arbitration`——仲裁； - `client_arbitration`——客户配送仲裁； - `delivering`——运输中； - `driver_pickup`——司机正在送货； - `cancelled`——已取消； - `not_accepted`——在分拣中心尚未接收。  如需获取最新发运日期，请定期更新货件信息，或接入[推送通知](#tag/push_start)。

#### 请求体（`posting.v4.PostingFbsUnfulfilledListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| filter | object | 否 | 请求筛选器。  使用按备货时间的筛选器——`cutoff`，或按货件转移配送的日期筛选——`delivering_date`。 如果同时使用这两个筛选器，响应会返回错误。  要使用按备货时间的筛选器，请填写`cutoff_from`和`cutoff_to`字段。  要使用按货件转移配送日期的筛选器，请填写`delivering_date_from`和`delivering_date_to`字段。 |
|   filter.cutoff_from | string | 否 | 卖家必须完成订单备货的截止时间。时间段开始。 |
|   filter.cutoff_to | string | 否 | 卖家必须完成订单备货的截止时间。时间段结束。 |
|   filter.delivering_date_from | string | 否 | 货件转移配送的最早日期。 |
|   filter.delivering_date_to | string | 否 | 货件转移配送的最晚日期。 |
|   filter.delivery_method_ids | array<string> | 否 | 配送方式标识符。可通过方法[/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
|   filter.last_changed_status_date | object | 否 | 货件状态最后一次发生变更的时间段。 |
|     filter.last_changed_status_date.from | string | 否 | 周期开始日期。 |
|     filter.last_changed_status_date.to | string | 否 | 周期结束日期。 |
|   filter.provider_ids | array<string> | 否 | 配送服务标识符。可通过方法[/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
|   filter.statuses | array<string> | 否 | 货件状态： - `acceptance_in_progress`——接收中； - `awaiting_approve`——等待确认； - `awaiting_packaging`——等待包装； - `awaiting_registration`——等待登记； - `awaiting_deliver`——等待发运； - `arbitration`——仲裁； - `client_arbitration... |
|   filter.warehouse_ids | array<string> | 否 | 仓库标识符。可通过方法[/v1/warehouse/list](#operation/WarehouseAPI_WarehouseList)获取。 |
| limit | integer | 否 | 响应中返回的值数量。 |
| sort_dir | string | 否 | 排序方向： - `ASC`——升序； - `DESC`——降序。 |
| translit | boolean | 否 | 则启用将地址从西里尔字母转写为拉丁字母。 |
| with | object | 否 | 需要添加到响应中的附加字段。 |
|   with.analytics_data | boolean | 否 | 若为`true`，则在响应中添加分析数据。 |
|   with.barcodes | boolean | 否 | `true`，表示要在响应中添加货件条形码。 |
|   with.financial_data | boolean | 否 | 若为`true`，则在响应中添加财务数据。 |
|   with.legal_info | boolean | 否 | 若为`true`，则在响应中添加法务信息。 |

#### 响应（`posting.v4.PostingFbsUnfulfilledListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| count | integer | 否 | 在响应中的元素计数器。 |
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| has_next | boolean | 否 | 若响应中未返回全部货件，则为`true`。 |
| postings |  | 否 | 货件列表。 |

---

### `POST` `/v3/posting/fbs/list`

**货件列表**

`operationId: PostingAPI_GetFbsPostingListV3`

该方法将于2026年6月1日停用。请切换到/v4/posting/fbs/list。  返回指定时间段的货运列表-不应超过一年。  此外，您还可以按货件状态过滤货件。  `has_next = true` 在响应中表示，不是所有的货物数组都被返回。要获取有关剩余货件的信息，请提出新的含 `offset`值的请求。

#### 请求体（`postingv3GetFbsPostingListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| dir | string | 否 | 分类方向：   - `asc` — 从小到大，   - `desc` — 从大到小。 |
| filter | object | 是 | 过滤器。 |
|   filter.delivery_method_id | array<integer> | 否 | 快递方式ID。按照运输方式筛选。可以使用方法 [/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
|   filter.fbpFilter | string | 否 | 从合作伙伴仓库（FBP）发货时的货件筛选器：  - `ALL` —  响应中将显示所有符合其他筛选器条件的货件； - `ONLY` —  仅显示FBP货件； - `WITHOUT` —  显示除FBP外的所有货件。  默认值为 `ALL`。 |
|   filter.order_id | integer | 否 | 订单ID。 |
|   filter.provider_id | array<integer> | 否 | 快递服务ID。按照运输方式筛选。可以使用方法 [/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
|   filter.since | string | 是 | 应收到货件清单时间段的开始日期。  UTC模式: ГГГГ-ММ-ДДTЧЧ:ММ:ССZ.  例子: 2019-08-24T14:15:22Z. |
|   filter.to | string | 是 | 应收到货件清单时间段的结束日期。  UTC模式： ГГГГ-ММ-ДДTЧЧ:ММ:ССZ.  例子： 2019-08-24T14:15:22Z. |
|   filter.status | string | 否 | 货件运输状态： - `awaiting_registration` — 等待注册， - `acceptance_in_progress` — 正在验收， - `awaiting_approve` — 等待确认， - `awaiting_packaging` — 等待包装， - `awaiting_deliver` — 等待装运， - `arbitration` — 仲裁， - `client_ar... |
|   filter.warehouse_id | array<string> | 否 | 仓库ID。可以使用方法 [/v1/warehouse/list](#operation/WarehouseAPI_WarehouseList)获取。 |
|   filter.last_changed_status_date | object | 否 | 货件最后一次更改过状态的时期。 |
|     filter.last_changed_status_date.from | string | 否 | 时期开始日期。 |
|     filter.last_changed_status_date.to | string | 否 | 时期结束日期。 |
| limit | integer | 是 | 响应中值的数量：   - 最大值 — 1000,   - 最小值 — 1。 |
| offset | integer | 是 | 将在响应中跳过的元素数。 例如，如果“offset=10”，那么响应将从找到的第11个元素开始。 |
| with | object | 否 | 要添加到响应的附加字段。 |
|   with.analytics_data | boolean | 否 | 将分析数据添加到响应中。 |
|   with.barcodes | boolean | 否 | 将货件条形码添加到响应中。 |
|   with.financial_data | boolean | 否 | 将财务数据添加到响应中。 |
|   with.legal_info | boolean | 否 | 将法律信息添加到响应中。 |
|   with.translit | boolean | 否 | 完成返回值的拼写。 |

#### 响应（`v3GetFbsPostingListResponseV3`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| has_next | boolean | 否 | 响应中未返回整个货运数组的标志: - `true` — 必须提出含其他值 `offset`的新请求，以获得其他货运信息； - `false` — 响应中返回了在请求中提出的整个用于过滤的货运数组。 |
| postings | array<object> | 否 | 货运信息。 |
|   postings[].addressee | object | 否 | 收件人联系方式。 |
|     postings[].addressee.name | string | 否 | 收件人姓名。 |
|     postings[].addressee.phone | string | 否 | 收件人联系电话。总是返回空字符串 `""`。要获取替代联系电话，请使用方法 [/v3/posting/fbs/get](#operation/PostingAPI_GetFbsPostingV3)。 |
|   postings[].analytics_data | object | 否 | 分析数据。 |
|     postings[].analytics_data.city | string | 否 | 快递城市。仅适用于rFBS货件和独联体卖家。 |
|     postings[].analytics_data.delivery_date_begin | string | 否 | 快递开始日期和时间。 |
|     postings[].analytics_data.delivery_date_end | string | 否 | 快递结束日期和时间。 |
|     postings[].analytics_data.delivery_type | string | 否 | 快递方式。 |
|     postings[].analytics_data.is_legal | boolean | 否 | 收件人是法人的标志：   - `true` — 法人，   - `false` — 自然人。 |
|     postings[].analytics_data.is_premium | boolean | 否 | 有Premium订阅。 |
|     postings[].analytics_data.payment_type_group_name | string | 否 | 付款方法： - `在线银行卡支付`， - `Ozon银行卡`， - `取货时自动从Ozon银行卡收费`， - `收货时从已保存的银行卡收费`， - `快速支付系统`， - `Ozon分期付款`， - `支付至结算账户`， - `SberPay`， - `外部卖家方的预付款`。 |
|     postings[].analytics_data.region | string | 否 | 快递地区。 |
|     postings[].analytics_data.tpl_provider | string | 否 | 快递服务。 |
|     postings[].analytics_data.tpl_provider_id | integer | 否 | 快递服务ID。 |
|     postings[].analytics_data.warehouse | string | 否 | 订单发送仓库名称。 |
|     postings[].analytics_data.warehouse_id | integer | 否 | 仓库ID。 |
|     postings[].analytics_data.client_delivery_date_begin | string | 否 | 向客户开始配送的日期和时间。仅适用于通过Ozon配送创建的货件。 |
|     postings[].analytics_data.client_delivery_date_end | string | 否 | 订单将送达客户的截止日期。仅适用于通过Ozon配送创建的货件。 |
|   postings[].available_actions |  | 否 | 可用的操作和货件信息包括： - `arbitration` — 提出争议； - `awaiting_delivery` — 转为“等待发运”状态； - `can_create_chat` — 与买家开启聊天； - `cancel` — 取消货件； - `click_track_number` — 在个人中心通过追踪号查看状态历史； - `customer_phone_available` — 获取... |
|   postings[].barcodes | object | 否 | 货件条码。 |
|     postings[].barcodes.lower_barcode | string | 否 | 货件标签的下条码。 |
|     postings[].barcodes.upper_barcode | string | 否 | 货件标签的上条码。 |
|   postings[].cancellation | object | 否 | 取消原因。 |
|     postings[].cancellation.affect_cancellation_rating | boolean | 否 | 如果取消影响买家排行 — `true`。 |
|     postings[].cancellation.cancel_reason | string | 否 | 取消原因。 |
|     postings[].cancellation.cancel_reason_id | integer | 否 | 取消货运的原因ID。 |
|     postings[].cancellation.cancellation_initiator | string | 否 | 取消货运的发起者：   - `卖家`,    - `客户` 或`买家`,   - `Ozon`,     - `系统`,    - `配送服务`。 |
|     postings[].cancellation.cancellation_type | string | 否 | 货运取消类型： - `seller` — 卖家取消； - `client` 或 `customer` — 买家取消； - `ozon` — Ozon取消； - `system`— 系统取消； - `delivery` — 配送服务取消。 |
|     postings[].cancellation.cancelled_after_ship | boolean | 否 | 如果订单在装运后取消 — `true`。 |
|   postings[].customer | object | 否 | 买家信息。 |
|     postings[].customer.address | object | 否 | 快递地址信息。 |
|       postings[].customer.address.address_tail | string | 否 | 文本格式的地址。 |
|       postings[].customer.address.city | string | 否 | 快递城市。 |
|       postings[].customer.address.comment | string | 否 | 订单评价。 |
|       postings[].customer.address.country | string | 否 | 快递国家。 |
|       postings[].customer.address.district | string | 否 | 快递地区。 |
|       postings[].customer.address.latitude | number | 否 | 宽。 |
|       postings[].customer.address.longitude | number | 否 | （时间的）长度。 |
|       postings[].customer.address.provider_pvz_code | string | 否 | 3PL提供商的订单提货点的代码。 |
|       postings[].customer.address.pvz_code | integer | 否 | 订单取货点代码。 |
|       postings[].customer.address.region | string | 否 | 快递区域。 |
|       postings[].customer.address.zip_code | string | 否 | 收件人邮编。 |
|     postings[].customer.customer_email | string | 否 | 买家的电子邮箱地址。 |
|     postings[].customer.customer_id | integer | 否 | 买家ID。 |
|     postings[].customer.name | string | 否 | 买家姓名。 |
|     postings[].customer.phone | string | 否 | 买家联系电话。始终返回空字符串 `""`。要获取替代联系电话，请使用方法 [/v3/posting/fbs/get](#operation/PostingAPI_GetFbsPostingV3)。 |
|   postings[].delivering_date | string | 否 | 货件交付物流的时间。 |
|   postings[].delivery_method | object | 否 | 快递方式。 |
|     postings[].delivery_method.id | integer | 否 | 快递方式ID。 |
|     postings[].delivery_method.name | string | 否 | 快递方式名称。 |
|     postings[].delivery_method.tpl_provider | string | 否 | 快递服务。 |
|     postings[].delivery_method.tpl_provider_id | integer | 否 | 快递服务ID。 |
|     postings[].delivery_method.warehouse | string | 否 | 仓库名称。 |
|     postings[].delivery_method.warehouse_id | integer | 否 | 仓库ID。 |
|   postings[].destination_place_id | integer | 否 | 目的仓库的标识符。 |
|   postings[].destination_place_name | string | 否 | 目的仓库的名称。 |
|   postings[].financial_data | object | 否 | 有关商品成本、折扣幅度、付款和佣金的信息。 |
|     postings[].financial_data.cluster_from | string | 否 | 订单发送区域代码。 |
|     postings[].financial_data.cluster_to | string | 否 | 订单接受区域代码。 |
|     postings[].financial_data.products | array<object> | 否 | 订单中的商品列表。 |
|       postings[].financial_data.products[].actions | array<string> | 否 | 活动清单。 |
|       postings[].financial_data.products[].currency_code | string | 否 | 价格货币，其与个人中心中设置的币种相匹配。  可能的值：   - `RUB` — 俄罗斯卢布，   - `BYN` — 白俄罗斯卢布，   - `KZT` — 坚戈，   - `EUR` — 欧元，   - `USD` — 美元，   - `CNY` — 元。 |
|       postings[].financial_data.products[].customer_currency_code | string | 否 | 买家货币代码。 |
|       postings[].financial_data.products[].commission_amount | number | 否 | 商品佣金大小。 |
|       postings[].financial_data.products[].commission_percent | integer | 否 | 佣金百分比。 |
|       postings[].financial_data.products[].commissions_currency_code | string | 否 | 计算佣金的币种代码。 |
|       postings[].financial_data.products[].old_price | number | 否 | 打折前价格。在商品卡片上将被显示划掉。 |
|       postings[].financial_data.products[].payout | number | 否 | 支付给卖方。 |
|       postings[].financial_data.products[].price | number | 否 | 您的价格。包含卖家促销（如有），不含 Ozon 资助的促销。 |
|       postings[].financial_data.products[].customer_price | number | 否 | 包含卖家与 Ozon 折扣的买家价格。 |
|       postings[].financial_data.products[].product_id | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|       postings[].financial_data.products[].quantity | integer | 否 | 运输商品数量。 |
|       postings[].financial_data.products[].total_discount_percent | number | 否 | 折扣百分比。 |
|       postings[].financial_data.products[].total_discount_value | number | 否 | 折扣数量。 |
|   postings[].in_process_at | string | 否 | 开始处理货件的日期和时间。 |
|   postings[].is_express | boolean | 否 | 如果使用快速物流 Ozon Express —— `true`。 |
|   postings[].is_presortable | boolean | 否 | 如果发运是预先分拣的，则为`true`。 |
|   postings[].legal_info | object | 否 | 买方的法律信息。 |
|     postings[].legal_info.company_name | string | 否 | 公司名称。 |
|     postings[].legal_info.inn | string | 否 | 纳税人识别号（INN）。 |
|     postings[].legal_info.kpp | string | 否 | 税务登记原因代码（KPP）。 |
|   postings[].optional | object | 否 | 带有附加特征的商品列表。 |
|     postings[].optional.products_with_possible_mandatory_mark | array<object> | 否 | 带有可能标志的商品列表。 |
|   postings[].order_id | integer | 否 | 货件所属订单的ID。 |
|   postings[].order_number | string | 否 | 货件所属的订单号。 |
|   postings[].parent_posting_number | string | 否 | 快递母件编号，从该母件中拆分出了当前货件。 |
|   postings[].posting_number | string | 否 | 货件号。 |
|   postings[].products | array<object> | 否 | 货运商品列表。 |
|     postings[].products[].name | string | 否 | 商品名称。 |
|     postings[].products[].offer_id | string | 否 | 在卖家系统中的商品ID — 货号。 |
|     postings[].products[].price | string | 否 | 商品价格。 |
|     postings[].products[].quantity | integer | 否 | 运输中的商品数量。 |
|     postings[].products[].sku | integer | 否 | 在Ozon系统中的商品ID — SKU。 |
|     postings[].products[].currency_code | string | 否 | 价格货币，其与个人中心中设置的币种相匹配。  可能的值：   - `RUB` — 俄罗斯卢布，   - `BYN` — 白俄罗斯卢布，   - `KZT` — 坚戈，   - `EUR` — 欧元，   - `USD` — 美元，   - `CNY` — 元。 |
|     postings[].products[].imei | array<string> | 否 | 移动设备的 IMEI 列表。 |
|   postings[].requirements | object | 否 | 需提供制造国、货运报关单号、商品批次登记号、“诚实标志”、其他标识或重量的商品列表，以便将货件状态更新至下一阶段。 |
|     postings[].requirements.products_requiring_change_country | array<string> | 否 | 需要修改生产国家的商品（SKU）编号列表。要修改生产国家，请使用方法 [/v2/posting/fbs/product/country/list](#operation/PostingAPI_ListCountryProductFbsPostingV2) 和 [/v2/posting/fbs/product/country/set](#operation/PostingAPI_SetCountry... |
|     postings[].requirements.products_requiring_gtd | array<string> | 否 | 必须提供货运报关单号（CCD）的商品 ID（SKU）列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供报关单号，或确认无该号码。 |
|     postings[].requirements.products_requiring_country | array<string> | 否 | 需要上传制造国信息的商品ID列表 (SKU)。  要配货，请上传上述商品的制造国信息，通过方法 [/v2/posting/fbs/product/country/set](#operation/PostingAPI_SetCountryProductFbsPostingV2)。 |
|     postings[].requirements.products_requiring_mandatory_mark | array<string> | 否 | 需要提供“诚实标志”标签的商品 ID（SKU）列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供“诚实标志”标签。 |
|     postings[].requirements.products_requiring_jw_uin | array<string> | 否 | 需要提供首饰唯一识别号（UIN）的商品列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供 UIN。 |
|     postings[].requirements.products_requiring_rnpt | array<string> | 否 | 需要提供商品批次注册号（RNPT）的商品 ID（SKU）列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供 RNPT。 |
|     postings[].requirements.products_requiring_imei | array<string> | 否 | 需要提供 IMEI 的商品 ID 列表。 |
|   postings[].shipment_date | string | 否 | 必须收取货件的日期和时间。 超出该时间后将适用新费率，相关信息请查看字段 `tariffication`。 |
|   postings[].shipment_date_without_delay | string | 否 | 不逾期发运日期和时间。 |
|   postings[].status | string | 否 | 货运状态: - `acceptance_in_progress` —— 正在验收， - `arbitration` —— 仲裁， - `awaiting_approve` —— 等待确认， - `awaiting_deliver` —— 等待装运， - `awaiting_packaging` —— 等待包装， - `awaiting_registration` —— 等待注册， - `await... |
|   postings[].substatus | string | 否 | 发货子状态： - `posting_acceptance_in_progress` —— 正在验收， - `posting_in_arbitration` —— 仲裁， - `posting_created` —— 已创建， - `posting_in_carriage` —— 在运输途中， - `posting_not_in_carriage` —— 未在运输中， - `posting_regi... |
|   postings[].tpl_integration_type | string | 否 | 快递服务集成类型：   - `ozon` —— Ozon 快递服务。   - `3pl_tracking` —— 集成服务快递。   - `non_integrated` —— 第三方物流服务。   - `aggregator` —— 通过Ozon合作物流伙伴交付。   - `hybryd`—— 俄罗斯邮政配送方案。 |
|   postings[].tracking_number | string | 否 | 货件跟踪号。 |
|   postings[].tariffication | object | 否 | 发运的计费信息。 |
|     postings[].tariffication.current_tariff_rate | number | 否 | 当前运费的百分比。 |
|     postings[].tariffication.current_tariff_type | string | 否 | 当前的计费类型 — 折扣或附加费。 |
|     postings[].tariffication.current_tariff_charge | string | 否 | 当前的折扣或附加费金额。 |
|     postings[].tariffication.current_tariff_charge_currency_code | string | 否 | 金额的货币单位。 |
|     postings[].tariffication.next_tariff_rate | number | 否 | 在参数 `next_tariff_starts_at` 指定的时间后，将按此百分比进行计费。 |
|     postings[].tariffication.next_tariff_type | string | 否 | 在参数 `next_tariff_starts_at` 指定的时间后，将按此类型计费 — 折扣或附加费。 |
|     postings[].tariffication.next_tariff_charge | string | 否 | 下一步计费中的折扣或附加金额。 |
|     postings[].tariffication.next_tariff_starts_at | string | 否 | 新的费率开始生效的日期和时间。  格式：`YYYY-MM-DDThh:mm:ss.mcsZ`.   示例：`2023-11-13T08:05:57.657Z`. |
|     postings[].tariffication.next_tariff_charge_currency_code | string | 否 | 新费率的货币单位。 |
|   postings[].tariffication_steps | array<object> | 否 | 计费阶段。 |
|     postings[].tariffication_steps[].min_charge | object | 否 | 最低折扣或附加费用。 |
|       postings[].tariffication_steps[].min_charge.amount | string | 否 | 金额。 |
|       postings[].tariffication_steps[].min_charge.currency | string | 否 | 货币单位。 |
|     postings[].tariffication_steps[].tariff_charge | object | 否 | 折扣或附加费用。 |
|       postings[].tariffication_steps[].tariff_charge.amount | string | 否 | 金额。 |
|       postings[].tariffication_steps[].tariff_charge.currency | string | 否 | 货币单位。 |
|     postings[].tariffication_steps[].tariff_deadline_at | string | 否 | 计费阶段结束的日期和时间。该日期后将自动进入下一计费阶段。 |
|     postings[].tariffication_steps[].tariff_rate | number | 否 | 折扣或附加费用百分比。 |
|     postings[].tariffication_steps[].tariff_type | string | 否 | 计费类型。 |

---

### `POST` `/v4/posting/fbs/list`

**获取货件列表**

`operationId: PostingFbsList`

返回指定时间段内的货件列表，该时间段不得超过一年。  如需获取最新发运日期，请定期更新货件信息，或接入[推送通知](#tag/push_start)。

#### 请求体（`posting.v4.PostingFbsListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| filter | object | 是 | 筛选器。 |
|   filter.delivery_method_ids | array<string> | 否 | 配送方式标识符。可通过方法[/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
|   filter.is_blr_traceable | boolean | 否 | `true`，表示商品可追溯。 |
|   filter.last_changed_status_date | object | 否 | 货件状态最后一次发生变更的时间段。 |
|     filter.last_changed_status_date.from | string | 否 | 周期开始日期。 |
|     filter.last_changed_status_date.to | string | 否 | 周期结束日期。 |
|   filter.order_id | integer | 否 | 订单标识符。 |
|   filter.order_numbers | array<string> | 否 | 货件所属订单的订单号。 |
|   filter.provider_ids | array<string> | 否 | 配送服务标识符。可通过方法[/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
|   filter.since | string | 是 | 需要获取货件列表的周期开始日期。 |
|   filter.statuses | array<string> | 否 | 货件状态：  - `awaiting_registration`——等待登记； - `acceptance_in_progress`——接收 中； - `awaiting_approve`——等待 确认； - `awaiting_packaging`——等待 包装； - `awaiting_deliver`——等待 发运； - `arbitration`——仲裁； - `client_arbitr... |
|   filter.to | string | 是 | 需要获取货件列表的周期结束日期。 |
|   filter.warehouse_ids | array<string> | 否 | 仓库标识符。可通过方法[/v1/warehouse/list](#operation/WarehouseAPI_WarehouseList)获取。 |
| limit | integer | 是 | 响应中返回的值数量。 |
| sort_dir | string | 否 | 排序方向： - `ASC`——升序； - `DESC`——降序。 |
| translit | boolean | 否 | 若为`true`，则启用将地址从西里尔字母转写为拉丁字母。 |
| with | object | 否 | 需要添加到响应中的附加字段。 |
|   with.analytics_data | boolean | 否 | 若为`true`，则在响应中添加分析数据。 |
|   with.barcodes | boolean | 否 | `true`，表示要在响应中添加货件条形码。 |
|   with.financial_data | boolean | 否 | 若为`true`，则在响应中添加财务数据。 |
|   with.legal_info | boolean | 否 | 若为`true`，则在响应中添加法务信息。 |

#### 响应（`posting.v4.PostingFbsListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| has_next | boolean | 否 | 若响应中未返回全部货件，则为`true`。 |
| postings |  | 否 | 货件列表。 |

---

### `POST` `/v3/posting/fbs/get`

**按照ID获取货件信息**

`operationId: PostingAPI_GetFbsPostingV3`

#### 请求体（`postingv3GetFbsPostingRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_number | string | 是 | 货件ID。 |
| with | object | 否 | 需要添加到响应中的附加字段。 |
|   with.analytics_data | boolean | 否 | 将分析数据添加到响应中。 |
|   with.barcodes | boolean | 否 | 将货件条形码添加到响应中。 |
|   with.financial_data | boolean | 否 | 将财务数据添加到响应中。 |
|   with.legal_info | boolean | 否 | 将法律信息添加到响应中。 |
|   with.product_exemplars | boolean | 否 | 将有关产品及其份数的数据添加到响应中。 |
|   with.related_postings | boolean | 否 | 将相关货件数量添加到响应中。 相关货件是在组装期间将母快递拆分的快递。 |
|   with.translit | boolean | 否 | 完成返回值的拼写。 |

#### 响应（`v3GetFbsPostingResponseV3`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| additional_data | array<object> | 否 |  |
|   additional_data[].key | string | 否 |  |
|   additional_data[].value | string | 否 |  |
| addressee | object | 否 | 收件人联系方式。 |
|   addressee.name | string | 否 | 买家姓名。 |
|   addressee.phone | string | 否 | 收件人的替代联系电话。 |
| analytics_data | object | 否 | 分析数据。 |
|   analytics_data.city | string | 否 | 快递城市。仅适用于rFBS货件和独联体卖家。 |
|   analytics_data.delivery_date_begin | string | 否 | 快递开始日期和时间。 |
|   analytics_data.delivery_date_end | string | 否 | 快递结束日期和时间。 |
|   analytics_data.delivery_type | string | 否 | 快递方式。 |
|   analytics_data.is_legal | boolean | 否 | 收件人是法人的标志：   - `true` — 法人，   - `false` — 自然人。 |
|   analytics_data.is_premium | boolean | 否 | 有Premium订阅。 |
|   analytics_data.payment_type_group_name | string | 否 | 付款方法： - `在线银行卡支付`， - `Ozon银行卡`， - `取货时自动从Ozon银行卡收费`， - `收货时从已保存的银行卡收费`， - `快速支付系统`， - `Ozon分期付款`， - `支付至结算账户`， - `SberPay`， - `外部卖家方的预付款`。 |
|   analytics_data.region | string | 否 | 快递地区。 |
|   analytics_data.tpl_provider | string | 否 | 快递服务。 |
|   analytics_data.tpl_provider_id | integer | 否 | 快递服务ID。 |
|   analytics_data.warehouse | string | 否 | 订单发送仓库名称。 |
|   analytics_data.warehouse_id | integer | 否 | 仓库ID。 |
|   analytics_data.client_delivery_date_begin | string | 否 | 向客户开始配送的日期和时间。仅适用于通过Ozon配送创建的货件。 |
|   analytics_data.client_delivery_date_end | string | 否 | 订单将送达客户的截止日期。仅适用于通过Ozon配送创建的货件。 |
| available_actions |  | 否 | 可用的操作和货件信息包括： - `arbitration` — 提出争议； - `awaiting_delivery` — 转为“等待发运”状态； - `can_create_chat` — 与买家开启聊天； - `cancel` — 取消货件； - `click_track_number` — 在个人中心通过追踪号查看状态历史； - `customer_phone_available` — 获取... |
| barcodes | object | 否 | 货件条码。 |
|   barcodes.lower_barcode | string | 否 | 货件标签的下条码。 |
|   barcodes.upper_barcode | string | 否 | 货件标签的上条码。 |
| cancellation | object | 否 | 取消原因。 |
|   cancellation.affect_cancellation_rating | boolean | 否 | 如果取消影响买家排行 — `true`。 |
|   cancellation.cancel_reason | string | 否 | 取消原因。 |
|   cancellation.cancel_reason_id | integer | 否 | 取消货运的原因ID。 |
|   cancellation.cancellation_initiator | string | 否 | 取消货运的发起者：   - `卖家`,    - `客户` 或`买家`,   - `Ozon`,     - `系统`,    - `配送服务`。 |
|   cancellation.cancellation_type | string | 否 | 货运取消类型： - `seller` — 卖家取消； - `client` 或 `customer` — 买家取消； - `ozon` — Ozon取消； - `system`— 系统取消； - `delivery` — 配送服务取消。 |
|   cancellation.cancelled_after_ship | boolean | 否 | 如果订单在装运后取消 — `true`。 |
| courier | object | 否 | 快递员信息。 |
|   courier.car_model | string | 否 | 汽车型号。 |
|   courier.car_number | string | 否 | 车牌号。 |
|   courier.name | string | 否 | 快递员全名。 |
|   courier.phone | string | 否 | 快递员电话。  过时的参数，不再使用。并总是返回到空字符串 `""`。 |
| customer | object | 否 | 买家信息。 |
|   customer.address | object | 否 | 快递地址信息。 |
|     customer.address.address_tail | string | 否 | 文本格式的地址。 |
|     customer.address.city | string | 否 | 快递城市。 |
|     customer.address.comment | string | 否 | 订单评价。 |
|     customer.address.country | string | 否 | 快递国家。 |
|     customer.address.district | string | 否 | 快递地区。 |
|     customer.address.latitude | number | 否 | 宽。 |
|     customer.address.longitude | number | 否 | （时间的）长度。 |
|     customer.address.provider_pvz_code | string | 否 | 3PL提供商的订单提货点的代码。 |
|     customer.address.pvz_code | integer | 否 | 订单取货点代码。 |
|     customer.address.region | string | 否 | 快递区域。 |
|     customer.address.zip_code | string | 否 | 收件人邮编。 |
|   customer.customer_id | integer | 否 | 买家ID。 |
|   customer.name | string | 否 | 买家姓名。 |
|   customer.phone | string | 否 | 买家的替代联系电话。 |
| delivering_date | string | 否 | 货件交付物流的时间。 |
| delivery_method | object | 否 | 快递方式。 |
|   delivery_method.id | integer | 否 | 快递方式ID。 |
|   delivery_method.name | string | 否 | 快递方式名称。 |
|   delivery_method.tpl_provider | string | 否 | 快递服务。 |
|   delivery_method.tpl_provider_id | integer | 否 | 快递服务ID。 |
|   delivery_method.warehouse | string | 否 | 仓库名称。 |
|   delivery_method.warehouse_id | integer | 否 | 仓库ID。 |
| delivery_price | string | 否 | 物流价格。 |
| fact_delivery_date | string | 否 | 货件实际转移配送的日期。 |
| financial_data | object | 否 | 有关商品成本、折扣幅度、付款和佣金的信息。 |
|   financial_data.cluster_from | string | 否 | 订单发送区域代码。 |
|   financial_data.cluster_to | string | 否 | 订单接受区域代码。 |
|   financial_data.products | array<object> | 否 | 订单中的商品列表。 |
|     financial_data.products[].actions | array<string> | 否 | 活动清单。 |
|     financial_data.products[].currency_code | string | 否 | 价格货币，其与个人中心中设置的币种相匹配。  可能的值：   - `RUB` — 俄罗斯卢布，   - `BYN` — 白俄罗斯卢布，   - `KZT` — 坚戈，   - `EUR` — 欧元，   - `USD` — 美元，   - `CNY` — 元。 |
|     financial_data.products[].customer_currency_code | string | 否 | 买家货币代码。 |
|     financial_data.products[].commission_amount | number | 否 | 商品佣金大小。 |
|     financial_data.products[].commission_percent | integer | 否 | 佣金百分比。 |
|     financial_data.products[].commissions_currency_code | string | 否 | 计算佣金的币种代码。 |
|     financial_data.products[].old_price | number | 否 | 打折前价格。在商品卡片上将被显示划掉。 |
|     financial_data.products[].payout | number | 否 | 支付给卖方。 |
|     financial_data.products[].price | number | 否 | 您的价格。包含卖家促销（如有），不含 Ozon 资助的促销。 |
|     financial_data.products[].customer_price | number | 否 | 包含卖家与 Ozon 折扣的买家价格。 |
|     financial_data.products[].product_id | integer | 否 | Ozon系统中的商品标识符——SKU。 |
|     financial_data.products[].quantity | integer | 否 | 运输商品数量。 |
|     financial_data.products[].total_discount_percent | number | 否 | 折扣百分比。 |
|     financial_data.products[].total_discount_value | number | 否 | 折扣数量。 |
| in_process_at | string | 否 | 开始处理货件的日期和时间。 |
| is_express | boolean | 否 | 如果使用了快速物流Ozon Express —— `true`。 |
| legal_info | object | 否 | 买方的法律信息。 |
|   legal_info.company_name | string | 否 | 公司名称。 |
|   legal_info.inn | string | 否 | 纳税人识别号（INN）。 |
|   legal_info.kpp | string | 否 | 税务登记原因代码（KPP）。 |
| optional | object | 否 | 带有附加特征的商品列表。 |
|   optional.products_with_possible_mandatory_mark | array<object> | 否 | 带有可能标志的商品列表。 |
| order_id | integer | 否 | 货件所属的订单ID。 |
| order_number | string | 否 | 货件所属的订单号。 |
| parent_posting_number | string | 否 | 母件编号，由该母件拆分出了该货件。 |
| posting_number | string | 否 | 货件号。 |
| product_exemplars | object | 否 | 有关产品及其副本的信息。  响应包含 `product_exemplars`字段, 如果在请求中传递标志 `with.product_exemplars = true`。 |
|   product_exemplars.products | array<object> | 否 |  |
|     product_exemplars.products[].exemplars | array<object> | 否 | 按副本的信息。 |
|       product_exemplars.products[].exemplars[].exemplar_id | integer | 否 | 样件识别码。 |
|       product_exemplars.products[].exemplars[].mandatory_mark | string | 否 | 强制性标记“诚实标记”。 |
|       product_exemplars.products[].exemplars[].gtd | string | 否 | 货运报关单号（Cargo Customs Declaration）。 |
|       product_exemplars.products[].exemplars[].is_gtd_absent | boolean | 否 | 未指出货运报关单号（Cargo Customs Declaration）的标志。 |
|       product_exemplars.products[].exemplars[].rnpt | string | 否 | 商品批次注册号（Product Batch Registration Number）。 |
|       product_exemplars.products[].exemplars[].is_rnpt_absent | boolean | 否 | 未指出商品批次注册号（Product Batch Registration Number）的标志。 |
|       product_exemplars.products[].exemplars[].imei | array<string> | 否 | 移动设备的 IMEI 列表。 |
|     product_exemplars.products[].sku | integer | 否 | 在Ozon系统中的产品ID — SKU。 |
| products | array<object> | 否 | 货物装运的数组。 |
|   products[].dimensions | object | 否 | 商品尺寸。 |
|     products[].dimensions.height | string | 否 | 包装高度。 |
|     products[].dimensions.length | string | 否 | 商品长度。 |
|     products[].dimensions.weight | string | 否 | 商品包装重量。 |
|     products[].dimensions.width | string | 否 | 包装宽度。 |
|   products[].mandatory_mark | array<string> | 否 | 商品强制性标签。 |
|   products[].name | string | 否 | 名称。 |
|   products[].offer_id | string | 否 | 卖家系统中的商品ID — 货号。 |
|   products[].price | string | 否 | 折扣后商品价格 — 该值在商品卡片上显示。 |
|   products[].currency_code | string | 否 | 价格显示的货币，其与个人中心中设置的币种相匹配。     -`RUB` — 俄罗斯卢布，   - `BYN` — 白俄罗斯卢布，   - `KZT` — 坚戈，   - `EUR` — 欧元，   - `USD` — 美元，   - `CNY` — 元。 |
|   products[].quantity | integer | 否 | 商品数量。 |
|   products[].sku | integer | 否 | Ozon 系统中的商品标识符（SKU）。 |
|   products[].has_imei | boolean | 否 | 存在 IMEI。  若存在 IMEI，则为`true`。 |
| provider_status | string | 否 | 快递服务状态。 |
| related_postings | object | 否 | 相关货件。 |
|   related_postings.related_posting_numbers |  | 否 | 相关货件号码列表。 |
| requirements | object | 否 | 需提供制造国、货运报关单号、商品批次登记号、“诚实标志”、其他标识或重量的商品列表，以便将货件状态更新至下一阶段。 |
|   requirements.products_requiring_change_country | array<string> | 否 | 需要修改生产国家的商品（SKU）编号列表。要修改生产国家，请使用方法 [/v2/posting/fbs/product/country/list](#operation/PostingAPI_ListCountryProductFbsPostingV2) 和 [/v2/posting/fbs/product/country/set](#operation/PostingAPI_SetCountry... |
|   requirements.products_requiring_gtd | array<string> | 否 | 必须提供货运报关单号（CCD）的商品 ID（SKU）列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供报关单号，或确认无该号码。 |
|   requirements.products_requiring_country | array<string> | 否 | 需要上传制造国信息的商品ID列表 (SKU)。  要配货，请上传上述商品的制造国信息，通过方法 [/v2/posting/fbs/product/country/set](#operation/PostingAPI_SetCountryProductFbsPostingV2)。 |
|   requirements.products_requiring_mandatory_mark | array<string> | 否 | 需要提供“诚实标志”标签的商品 ID（SKU）列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供“诚实标志”标签。 |
|   requirements.products_requiring_jw_uin | array<string> | 否 | 需要提供首饰唯一识别号（UIN）的商品列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供 UIN。 |
|   requirements.products_requiring_rnpt | array<string> | 否 | 需要提供商品批次注册号（RNPT）的商品 ID（SKU）列表。  在配货之前，请通过方法 [/v6/fbs/posting/product/exemplar/set](#operation/PostingAPI_FbsPostingProductExemplarSetV6) 为上述所有商品提供 RNPT。 |
|   requirements.products_requiring_imei | array<string> | 否 | 需要提供 IMEI 的商品 ID 列表。 |
| shipment_date | string | 否 | 必须收取货件的日期和时间。 超出该时间后将适用新费率，相关信息请查看字段 `tariffication`。 |
| shipment_date_without_delay | string | 否 | 不逾期发运日期和时间。 |
| status | string | 否 | 货运状态: - `acceptance_in_progress` —— 正在验收， - `arbitration` —— 仲裁， - `awaiting_approve` —— 等待确认， - `awaiting_deliver` —— 等待装运， - `awaiting_packaging` —— 等待包装， - `awaiting_registration` —— 等待注册， - `await... |
| substatus | string | 否 | 发货子状态： - `posting_acceptance_in_progress` —— 正在验收， - `posting_in_arbitration` —— 仲裁， - `posting_created` —— 已创建， - `posting_in_carriage` —— 在运输途中， - `posting_not_in_carriage` —— 未在运输中， - `posting_regi... |
| previous_substatus | string | 否 | 货件的前一个子状态。可能的取值：  - `posting_acceptance_in_progress` —— 正在验收，  - `posting_in_arbitration` —— 仲裁，  - `posting_created` —— 已创建，  - `posting_in_carriage` —— 在运输途中，  - `posting_not_in_carriage` —— 未在运输中， ... |
| tpl_integration_type | string | 否 | 快递服务集成类型：   - `ozon` —— 通过Ozon物流的快递。   - `aggregator` —— 外部服务快递，Ozon注册订单。   - `3pl_tracking` —— 外部服务快递，卖家注册订单。   - `non_integrated` —— 卖家自行配送物流。 |
| tracking_number | string | 否 | 货件跟踪号。 |
| tariffication | object | 否 | 发运的计费信息。 |
|   tariffication.current_tariff_rate | number | 否 | 当前运费的百分比。 |
|   tariffication.current_tariff_type | string | 否 | 当前的计费类型 — 折扣或附加费。 |
|   tariffication.current_tariff_charge | string | 否 | 当前的折扣或附加费金额。 |
|   tariffication.current_tariff_charge_currency_code | string | 否 | 金额的货币单位。 |
|   tariffication.next_tariff_rate | number | 否 | 在参数 `next_tariff_starts_at` 指定的时间后，将按此百分比进行计费。 |
|   tariffication.next_tariff_type | string | 否 | 在参数 `next_tariff_starts_at` 指定的时间后，将按此类型计费 — 折扣或附加费。 |
|   tariffication.next_tariff_charge | string | 否 | 下一步计费中的折扣或附加金额。 |
|   tariffication.next_tariff_starts_at | string | 否 | 新的费率开始生效的日期和时间。  格式：`YYYY-MM-DDThh:mm:ss.mcsZ`.   示例：`2023-11-13T08:05:57.657Z`. |
|   tariffication.next_tariff_charge_currency_code | string | 否 | 新费率的货币单位。 |
| tariffication_steps | array<object> | 否 | 计费阶段。 |
|   tariffication_steps[].min_charge | object | 否 | 最低折扣或附加费用。 |
|     tariffication_steps[].min_charge.amount | string | 否 | 金额。 |
|     tariffication_steps[].min_charge.currency | string | 否 | 货币单位。 |
|   tariffication_steps[].tariff_charge | object | 否 | 折扣或附加费用。 |
|     tariffication_steps[].tariff_charge.amount | string | 否 | 金额。 |
|     tariffication_steps[].tariff_charge.currency | string | 否 | 货币单位。 |
|   tariffication_steps[].tariff_deadline_at | string | 否 | 计费阶段结束的日期和时间。该日期后将自动进入下一计费阶段。 |
|   tariffication_steps[].tariff_rate | number | 否 | 折扣或附加费用百分比。 |
|   tariffication_steps[].tariff_type | string | 否 | 计费类型。 |

---

### `POST` `/v2/posting/fbs/get-by-barcode`

**按条形码获取有关货件的信息**

`operationId: PostingAPI_GetFbsPostingByBarcode`

#### 请求体（`postingGetFbsPostingByBarcodeRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| barcode | string | 是 | 货运条形码。可以使用以下方法获取： [/v3/posting/fbs/get](#operation/PostingAPI_GetFbsPostingV3)、[/v3/posting/fbs/list](#operation/PostingAPI_GetFbsPostingListV3) 和 [/v3/posting/fbs/unfulfilled/list](#operation/Posting... |

#### 响应（`v2FbsPostingResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| barcodes | object | 否 | 货件条形码。 |
|   barcodes.lower_barcode | string | 否 | 货件标签的下条形码。 |
|   barcodes.upper_barcode | string | 否 | 货件标签的上条形码。 |
| cancel_reason_id | integer | 否 | 取消装运原因ID。 |
| created_at | string | 否 | 创建装运日期和时间。 |
| in_process_at | string | 否 | 开始处理货件的日期和时间。 |
| order_id | integer | 否 | 货运所属订单ID。 |
| order_number | string | 否 | 货运所属的订单号。 |
| posting_number | string | 否 | 货运号。 |
| products | array<object> | 否 | 货运商品列表。 |
|   products[].name | string | 否 | 商品名称。 |
|   products[].offer_id | string | 否 | 卖家系统中的商品ID — 货号。 |
|   products[].price | string | 否 | 商品价格。 |
|   products[].quantity | integer | 否 | 货运商品数量。 |
|   products[].sku | integer | 否 | Ozon 系统中的商品标识符（SKU）。 |
| shipment_date | string | 否 | 必须收取货件的日期和时间。 如果在此日期之前未完成配货，则货运自动取消。 |
| status | string | 否 | 货运状态。 |

---

### `POST` `/v2/posting/fbs/product/country/list`

**可用产地名单**

`operationId: PostingAPI_ListCountryProductFbsPostingV2`

获取可用产地及其ISO代码列表的方法。

#### 请求体（`v2FbsPostingProductCountryListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name_search | string | 否 | 按行过滤。 |

#### 响应（`v2FbsPostingProductCountryListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 否 | 国家俄语名称 |
| country_iso_code | string | 否 | ISO国家代码。 |

---

### `POST` `/v2/posting/fbs/product/country/set`

**添加商品产地信息**

`operationId: PostingAPI_SetCountryProductFbsPostingV2`

将“产地”商品属性添加到方法中，如果该信息未指定。

#### 请求体（`v2FbsPostingProductCountrySetRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_number | string | 是 | 货运号。 |
| product_id | integer | 是 | 产品ID。 |
| country_iso_code | string | 是 | 根据标准ISO_3166-1添加的国家的两个字母代码   制造国家列表及其ISO代码可以使用该方法获得[/v2/posting/fbs/product/country/list](#operation/PostingAPI_ListCountryProductFbsPostingV2)。 |

#### 响应（`v2FbsPostingProductCountrySetResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| product_id | integer | 否 | 产品ID。 |
| is_gtd_needed | boolean | 否 | 有必要传送产品和货运的货物报关单（Cargo Customs Declaration）编号的标志。 |

---

### `POST` `/v2/posting/fbs/package-label`

**打印标签**

`operationId: PostingAPI_PostingFBSPackageLabel`

如果您使用rFBS或rFBS Express方案发货，请在卖家知识库中查看标签打印流程。  生成带有指定货件标签的PDF文件。 在一个请求中最多可以传递20个ID。 如果至少有一个货件发生错误，则不会为请求中的所有货件准备标签。  我们建议在订单装配后45-60秒内询问标签。  错误 `The next postings aren't ready` 标识，未备好标签，请稍后重试。

#### 请求体（`postingPostingFBSPackageLabelRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_number | array<string> | 是 | 货运ID。 |

---

### `POST` `/v2/posting/fbs/awaiting-delivery`

**货件装运**

`operationId: PostingAPI_MoveFbsPostingToAwaitingDelivery`

将有争议的订单转到装运。货件状态将更改为 `awaiting_deliver`。

#### 请求体（`v2MovePostingToAwaitingDeliveryRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_number | array<string> | 是 | 货运ID。一次请求中的最大数量——100。 |

#### 响应（`postingBooleanResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| result | boolean | 否 | 处理请求的结果。 如果请求执行时无误，则为“true”。 |

---

### `POST` `/v2/posting/fbs/cancel-reason/list`

**货件取消原因**

`operationId: PostingAPI_GetPostingFbsCancelReasonList`

返回所有货件取消原因列表。

#### 响应（`postingCancelReasonListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| id | integer | 否 | 取消原因ID。 |
| is_available_for_cancellation | boolean | 否 | 取消装运结果。 `true`, 如果请求可以取消。 |
| title | string | 否 | 类别名称。 |
| type_id | string | 否 | 取消货件ID： - `buyer` — 买家， - `seller` — 卖家。 |

---

### `POST` `/v1/posting/fbs/cancel-reason`

**货运取消原因**

`operationId: PostingAPI_GetPostingFbsCancelReasonV1`

返回特定货件的取消原因列表。

#### 请求体（`postingCancelReasonRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| related_posting_numbers | array<string> | 是 | 货件号。 |

#### 响应（`postingCancelReasonResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_number | string | 否 | 货运号。 |
| reasons | array<object> | 否 | 取消订单原因。 |
|   reasons[].id | integer | 否 | 取消原因ID： - `352` — 在卖家仓库已无商品。 - `400` — 只剩下残次品。 - `401` — 卖家拒绝了仲裁。 - `402` — 其他（卖家错误）。 - `665` — 买家没有收货。 - `666` — 快递服务退货：在该区域没有快递。 - `667` — 订单被快递弄丢。 |
|   reasons[].title | string | 否 | 描述取消原因。 |
|   reasons[].type_id | string | 否 | 取消货运提出方：   - `buyer` — 买家，   - `seller` — 卖家。 |

---

### `POST` `/v2/posting/fbs/cancel`

**取消货运**

`operationId: PostingAPI_CancelFbsPosting`

将装运状态改为 `cancelled`。  如果您使用 rFBS 模式, 可用以下取消原因ID — `cancel_reason_id`:  - `352` — 商品无库存； - `400` — 只剩下有缺陷的商品。 - `401` — 仲裁取消； - `402` — 其他原因； - `665` — 买家没有收货； - `666` — 在该地区没有快递； - `667` — 订单被快递弄丢。  状态为“运输中”和“快递员派件中”的包裹可使用最后的4个理由。  无法取消可能送达的包裹。

#### 请求体（`postingCancelFbsPostingRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cancel_reason_id | integer | 是 | 取消运输的原因ID。 |
| cancel_reason_message | string | 否 | 关于取消的附加信息。如果`cancel_reason_id = 402`，参数是必须的。 |
| posting_number | string | 是 | 货件ID。 |

#### 响应（`postingBooleanResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| result | boolean | 否 | 处理请求的结果。 如果请求执行时无误，则为“true”。 |

---

### `POST` `/v2/posting/fbs/product/cancel`

**取消某些商品发货**

`operationId: PostingAPI_CancelFbsPostingProduct`

如果您无法从货件中发送部分产品，请使用该方法。  为了在使用FBS或rFBS模式时获取取消原因的标识符`cancel_reason_id`，请使用方法[/v2/posting/fbs/cancel-reason/list](#operation/PostingAPI_GetPostingFbsCancelReasonList)。  无法取消可能送达的包裹。

#### 请求体（`postingPostingProductCancelRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cancel_reason_id | integer | 是 | 货物取消发货原因ID。 |
| cancel_reason_message | string | 是 | 必填字段。关于取消的其他信息。 |
| items | array<object> | 是 | 商品信息。 |
|   items[].quantity | integer | 是 | 货运商品数量。 |
|   items[].sku | integer | 是 | Ozon系统中的商品ID — SKU。 |
| posting_number | string | 是 | 货运ID。 |

#### 响应（`postingPostingProductCancelResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| result | string | 否 | 货运号。 |

---

## FBS/rFBS标志代码和订单备货管理

### `POST` `/v4/posting/fbs/ship`

**搜集订单 (第4方案)**

`operationId: PostingAPI_ShipFbsPostingV4`

状态码为200的响应不代表订单已成功备货。请使用/v3/posting/fbs/get方式来检查，订单是否已完成备货。如果响应中包含result.substatus = ship_failed，请重新为订单备货。  拆分订单，并将状态改为`awaiting_deliver`。  `packages`中的每个元素都可以包含多个`products`和货物。 `products`中的每个元素是包含在这批货物中的商品。  如果出现以下情况，需要拆分订单：   - 商品在一个包装里放不下，   - 商品不可以放在一个包装里。  如需拆分订单，请在`packages`数组中传递多个对象。  不需要拆分订单的请求示例：两个商品将在一个货件中发货。  ``` {   "packages": [     {       "products": [         {           "product_id": 185479045,           "quantity": 2         }       ]     }   ],   "posting_number": "89491381-00...

#### 请求体（`fbsv4FbsPostingShipV4Request`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| packages |  | 是 | 包装清单。 每个包装都包含订单分成的发货清单。 |
| posting_number | string | 是 | 发货号。 |
| with | object | 否 | 附加信息。 |
|   with.additional_data | boolean | 否 | 为获取附加信息，请点击 `true`。 |

#### 响应（`fbsv4FbsPostingShipV4Response`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| additional_data |  | 否 | 与发货有关的附加信息。 |
| result |  | 否 | 货运装配结果。 |

---

### `POST` `/v4/posting/fbs/ship/package`

**货件的部分装配 (第4方案)**

`operationId: PostingAPI_ShipFbsPostingPackage`

状态码为200的响应不代表订单已成功备货。请使用/v3/posting/fbs/get方式来检查，订单是否已完成备货。如果响应中包含result.substatus = ship_failed，请重新为订单备货。    如果在请求中转交货件中的部分商品，那么方式将把最初的货件分为两个部分。在第一个未完成备货的货件中将剩下请求中没有转交的那一部分商品。   默认情况下，创建的货件状态为`awaiting_packaging`（等待备货）。 最初的货件状态将仅在它分成的货件状态发生变化后才发生变化。

#### 请求体（`v4FbsPostingShipPackageV4Request`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| posting_number | string | 是 | 发货号。 |
| products | array<object> | 否 | 商品清单。 |
|   products[].exemplarsIds | array<string> | 否 | 商品外部识别码。 |
|   products[].product_id | integer | 是 | Ozon系统中商品的标识符 — `product_id`。 |
|   products[].quantity | integer | 是 | 样件数量。 |

#### 响应（`v4FbsPostingShipPackageV4Response`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| result | string | 否 | 备货后生成的货件号码。 |

---

## FBS配送

### `POST` `/v1/carriage/create`

**创建发运**

`operationId: CarriageAPI_CarriageCreate`

使用该方法创建第一个FBS发运。所有状态为“已准备发运”的货件都会进入该发运。创建的发运将获得`new`状态。  对于状态为`new`的发运，可以通过方法[/v1/carriage/set-postings](#operation/CarriageAPI_SetPostings)重写货件组成。如果从发运中排除部分货件，它们可能会进入下一次发运。   如需获取发运中的货件列表，请使用方法[/v2/posting/fbs/act/get-postings](#operation/PostingAPI_ActPostingList)。

#### 请求体（`v1CarriageCreateRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| all_blr_traceable | boolean | 否 | `true`，表示需要创建包含可追溯商品的发运。 |
| delivery_method_id | integer | 否 | 配送方式标识符。 |
| departure_date | string | 否 | 发运日期。默认值为当前日期。 |

#### 响应（`v1CarriageCreateResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| carriage_id | integer | 否 | 运输标识符。 |

---

### `POST` `/v1/carriage/approve`

**发运确认**

`operationId: CarriageAPI_CarriageApprove`

使用该方法在创建发运后确认发运。确认后，发运将转为“已生成”状态。

#### 请求体（`v1CarriageApproveRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| carriage_id | integer | 是 | 发运标识符。 |
| containers_count | integer | 否 | 货位数量。  如果您已开通信任验收，并按货位发运订单，请使用该参数。如果您未开通信任验收，请跳过该参数。 |

---

### `POST` `/v1/carriage/get`

**运输信息**

`operationId: CarriageGet`

#### 请求体（`carriageCarriageGetRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| carriage_id | integer | 是 | 运输标识符。 |

#### 响应（`carriageCarriageGetResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| act_type | string | 否 | 交接单类型。针对FBS卖家。 |
| arrival_pass_ids | array<string> | 否 | 为运输生成的通行证标识符列表。 |
| available_actions | array<string> | 否 | 运输的可用操作： - `get_shipping_list`——获取发运清单； - `get_act_of_acceptance`——获取验收证明书； - `get_waybill`——获取 PDF 格式的货单； - `set_arrival_passes`——[创建通行证](#operation/carriagePassCreate)。 |
| cancel_availability | object | 否 | 是否可以取消。 |
|   cancel_availability.is_cancel_available | boolean | 否 | `true`, 如果运输可以取消。 |
|   cancel_availability.reason | string | 否 | 运输无法取消的原因。 |
| carriage_id | integer | 否 | 运输标识符。 |
| company_id | integer | 否 | 卖家标识符。 |
| containers_count | integer | 否 | 货位数量。 |
| created_at | string | 否 | 运输创建日期。 |
| delivery_method_id | integer | 否 | 物流方式标识符。 |
| departure_date | string | 否 | 运输完成日期。 |
| first_mile_type | string | 否 | 头程物流类型。 |
| has_postings_for_next_carriage | boolean | 否 | `true`, 如果有未能进行运输，但需要发运的货件。 |
| integration_type | string | 否 | 运输类型。 |
| is_container_label_printed | boolean | 否 | `true`, 如果您已经打印了货位标签。 |
| is_partial | boolean | 否 | `true`, 如果是部分运输。 |
| partial_num | integer | 否 | 部分运输序列号。 |
| retry_count | integer | 否 | 运输创建重复尝试数量。 |
| status | string | 否 | 运输状态。 |
| tpl_provider_id | integer | 否 | 配送服务商标识符。 |
| updated_at | string | 否 | 运输信息最后一次更新日期。 |
| warehouse_id | integer | 否 | 仓库标识符。 |

---

### `POST` `/v1/posting/carriage-available/list`

**可供运输的列表**

`operationId: PostingAPI_GetCarriageAvailableList`

该方式已过时，并将于2026年3月20日关闭。请切换至 /v2/carriage/delivery/list 新版本。  需要打印验收证明书和运输货单的收货方式。

#### 请求体（`postingv1GetCarriageAvailableListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| delivery_method_id | integer | 是 | 按照运输方式筛选。可以使用方法 [/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
| departure_date | string | 否 | 装运日期。默认 —— 当前日期。 |

#### 响应（`postingv1GetCarriageAvailableListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| result |  | 否 | 方法操作结果。 |

---

### `POST` `/v1/carriage/set-postings`

**发运组成商品更改**

`operationId: CarriageAPI_SetPostings`

该方式暂不向独联体国家的卖家开放。   它完全覆盖发运中的订单列表。仅需转交处于等待发运状态下的订单，您就可以将其发运了。      如要回到订单列表，请通过/v1/carriage/cancel方式将发运删除，并创建新的发运。

#### 请求体（`v1SetPostingsRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| carriage_id | integer | 是 | 发运识别符。 |
| posting_numbers | array<string> | 是 | 最新货件列表。 |

#### 响应（`v1SetPostingsResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| result |  | 否 |  |

---

### `POST` `/v1/carriage/cancel`

**发运删除**

`operationId: CarriageAPI_CarriageCancel`

#### 请求体（`v1CarriageCancelRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| carriage_id | integer | 是 | 发运识别符。 |

#### 响应（`v1CarriageCancelResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | string | 否 | 错误描述。 |
| carriage_status | string | 否 | 发运状态。 |

---

### `POST` `/v2/posting/fbs/act/get-postings`

**单据中的货件列表**

`operationId: PostingAPI_ActPostingList`

根据单据标识符返回单据中的货件列表。

#### 请求体（`v2PostingFBSActGetPostingsRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| id | int | 是 | 单据标识符。请通过方法[/v1/carriage/create](#operation/CarriageAPI_CarriageCreate)获取参数值。 |

#### 响应（`v2PostingFBSActGetPostingsResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| id | integer | 否 | 单据标识符。 |
| multi_box_qty | integer | 否 | 商品包装所用箱数。 |
| posting_number | string | 否 | 货件编号。 |
| status | string | 否 | 货件状态。 |
| seller_error | string | 否 | 错误代码说明。 |
| updated_at | string | 否 | 货件记录的更新日期和时间。 |
| created_at | string | 否 | 货件记录的创建日期和时间。 |
| products | array<object> | 否 | 货件中商品列表。 |
|   products[].name | string | 否 | 商品名称。 |
|   products[].offer_id | string | 否 | 商品在卖家系统中的标识符——货号。 |
|   products[].price | string | 否 | 商品价格。 |
|   products[].quantity | integer | 否 | 货件中的商品数量。 |
|   products[].sku | integer | 否 | 商品在Ozon系统中的标识符——SKU。 |

---

### `POST` `/v2/posting/fbs/act/get-container-labels`

**货位标签**

`operationId: PostingAPI_PostingFBSActGetContainerLabels`

该方法用于创建货位标签。

#### 请求体（`postingPostingFBSActGetContainerLabelsRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| id | integer | 是 | 来自方法[/v1/carriage/create](#operation/CarriageAPI_CarriageCreate)的文件生成任务编号（也是运输标识符）。 |

---

### `POST` `/v1/assembly/carriage/posting/list`

**获取发运中的货件列表**

`operationId: AssemblyCarriagePostingList`

#### 请求体（`v1AssemblyCarriagePostingListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| filter | object | 是 | 筛选器。 |
|   filter.carriage_id | integer | 是 | 运输标识符。 |
|   filter.cutoff_from | string | 否 | 按卖家需完成订单备货的时间进行筛选。时间段开始。  格式： `YYYY-MM-DDThh:mm:ss.mcsZ`。示例：`2020-03-18T07:34:50.359Z`。 |
|   filter.cutoff_to | string | 否 | 按卖家需完成订单备货的时间进行筛选。时间段结束。  格式： `YYYY-MM-DDThh:mm:ss.mcsZ`。示例：`2020-03-18T07:34:50.359Z`。 |
|   filter.delivery_method_id | integer | 否 | 配送方式标识符。可通过方法[/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
| limit | integer | 是 | 每页显示的数量。 |

#### 响应（`v1AssemblyCarriagePostingListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| can_print_mass_label | boolean | 否 | `true`，前提是可以批量打印标签。 |
| cursor | string | 否 | 用于选择下一批数据的指针。如果该参数为空，则没有更多数据了。 |
| postings | array<object> | 否 | 货件列表。 |
|   postings[].assembly_code | string | 否 | 拣货单代码。 |
|   postings[].can_print_label | boolean | 否 | `true`，前提是可以打印标签。 |
|   postings[].posting_number | string | 否 | 货件编号。 |
|   postings[].products | array<object> | 否 | 商品列表。 |
|     postings[].products[].offer_id | string | 否 | 卖家系统中的商品标识符——货号。 |
|     postings[].products[].picture_url | string | 否 | 商品图片链接。 |
|     postings[].products[].product_name | string | 否 | 商品名称。 |
|     postings[].products[].quantity | integer | 否 | 商品数量。 |
|     postings[].products[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |

---

### `POST` `/v1/assembly/carriage/product/list`

**获取发运中的商品列表**

`operationId: AssemblyCarriageProductList`

#### 请求体（`v1AssemblyCarriageProductListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| filter | object | 是 | 筛选器。 |
|   filter.carriage_id | integer | 是 | 运输标识符。 |
|   filter.cutoff_from | string | 否 | 按卖家需完成订单备货的时间进行筛选。时间段开始。  格式： `YYYY-MM-DDThh:mm:ss.mcsZ`。示例：`2020-03-18T07:34:50.359Z`。 |
|   filter.cutoff_to | string | 否 | 按卖家需完成订单备货的时间进行筛选。时间段结束。  格式： `YYYY-MM-DDThh:mm:ss.mcsZ`。示例：`2020-03-18T07:34:50.359Z`。 |
|   filter.delivery_method_id | integer | 否 | 配送方式标识符。可通过方法[/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
| limit | integer | 是 | 每页显示的数量。 |

#### 响应（`v1AssemblyCarriageProductListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。如果该参数为空，则没有更多数据了。 |
| products | array<object> | 否 | 商品列表。 |
|   products[].offer_id | string | 否 | 卖家系统中的商品标识符——货号。 |
|   products[].picture_url | string | 否 | 商品图片链接。 |
|   products[].posting_numbers | array<string> | 否 | 货件编号。 |
|   products[].product_name | string | 否 | 商品名称。 |
|   products[].quantity | integer | 否 | 商品数量。 |
|   products[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |

---

### `POST` `/v1/assembly/fbs/posting/list`

**获取货件列表**

`operationId: AssemblyFbsPostingList`

#### 请求体（`v1AssemblyFbsPostingListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。 |
| filter | object | 是 | 筛选器。 |
|   filter.cutoff_from | string | 是 | 按卖家需完成订单备货的时间进行筛选。时间段开始。  格式： `YYYY-MM-DDThh:mm:ss.mcsZ`。示例：`2020-03-18T07:34:50.359Z`。 |
|   filter.cutoff_to | string | 是 | 按卖家需完成订单备货的时间进行筛选。时间段结束。  格式： `YYYY-MM-DDThh:mm:ss.mcsZ`。示例：`2020-03-18T07:34:50.359Z`。 |
|   filter.delivery_method_id | integer | 否 | 配送方式标识符。可通过方法[/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
| limit | integer | 是 | 每页显示的数量。 |
| sort_dir | string | 是 | 排序方向：  - `ASC`——升序，  - `DESC`——降序。 |

#### 响应（`v1AssemblyFbsPostingListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cursor | string | 否 | 用于选择下一批数据的指针。如果该参数为空，则没有更多数据了。 |
| cutoff | string | 否 | 卖家需在此时间前完成订单备货。 |
| postings | array<object> | 否 | 货件列表。 |
|   postings[].assembly_code | string | 否 | 拣货单代码。 |
|   postings[].posting_number | string | 否 | 货件编号。 |
|   postings[].products | array<object> | 否 | 商品列表。 |
|     postings[].products[].offer_id | string | 否 | 卖家系统中的商品标识符——货号。 |
|     postings[].products[].picture_url | string | 否 | 商品图片链接。 |
|     postings[].products[].product_name | string | 否 | 商品名称。 |
|     postings[].products[].quantity | integer | 否 | 商品数量。 |
|     postings[].products[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |

---

### `POST` `/v1/assembly/fbs/product/list`

**获取货件中的商品列表**

`operationId: AssemblyFbsProductList`

#### 请求体（`v1AssemblyFbsProductListRequest`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| filter | object | 是 | 筛选器。 |
|   filter.cutoff_from | string | 是 | 按卖家需完成订单备货的时间进行筛选。时间段开始。  格式： `YYYY-MM-DDThh:mm:ss.mcsZ`。示例：`2020-03-18T07:34:50.359Z`。 |
|   filter.cutoff_to | string | 是 | 按卖家需完成订单备货的时间进行筛选。时间段结束。  格式： `YYYY-MM-DDThh:mm:ss.mcsZ`。示例：`2020-03-18T07:34:50.359Z`。 |
|   filter.delivery_method_id | integer | 否 | 配送方式标识符。可通过方法[/v1/delivery-method/list](#operation/WarehouseAPI_DeliveryMethodList)获取。 |
| limit | integer | 是 | 每页显示的数量。 |
| offset | integer | 否 | 在响应中将被跳过的项目数量。例如，如果 `offset = 10`，则响应将从第 11 个找到的项目开始。 |
| sort_dir | string | 否 | 排序方向：  - `ASC`——升序，  - `DESC`——降序。 |

#### 响应（`v1AssemblyFbsProductListResponse`）

| 字段名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| has_next | boolean | 否 | 响应中是否包含全部商品：  - `true`——请使用新的 `offset`值重新请求以获取剩余数据； - `false`——响应中已包含所有值。 |
| products | array<object> | 否 | 商品列表。 |
|   products[].offer_id | string | 否 | 卖家系统中的商品标识符——货号。 |
|   products[].picture_url | string | 否 | 商品图片链接。 |
|   products[].postings | array<object> | 否 | 货件列表。 |
|     products[].postings[].posting_number | string | 否 | 货件编号。 |
|     products[].postings[].quantity | integer | 否 | 货件中的商品数量。 |
|   products[].product_name | string | 否 | 商品名称。 |
|   products[].quantity | integer | 否 | 商品数量。 |
|   products[].sku | integer | 否 | Ozon系统中的商品标识符——SKU。 |
| products_count | integer | 否 | 商品数量。 |

---

