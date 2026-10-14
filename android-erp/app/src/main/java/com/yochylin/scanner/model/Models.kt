package com.yochylin.scanner.model

/** 包裹列表/记录响应（/list 与 /records 均返回 { packages, total, ... }） */
data class PackageListResponse(
    val packages: List<Pkg> = emptyList(),
    val total: Int = 0,
    val rubRate: RubRate? = null,
)

/** 汇率信息（后端 resolveRubCnyRate 返回对象，可能为 null） */
data class RubRate(
    val rate: Double? = null,
    val updatedAt: String? = null,
    val source: String? = null,
)

/** 订单（包裹）卡片数据，字段与后端 order-process/list 返回一致 */
data class Pkg(
    val id: String = "",
    val storeName: String? = null,
    val postingNumber: String? = null,
    val parentId: String? = null,
    val hasChildren: Boolean = false,
    val isIgnored: Boolean = false,
    val isReturned: Boolean = false,
    val operateStatus: String? = null,
    val ozonStatus: String? = null,
    val substatus: String? = null,
    val tags: List<String>? = null,
    val note: String? = null,
    val inProcessAt: String? = null,
    val shipmentDate: String? = null,
    val lastDeliveryAt: String? = null,
    val deliveringDate: String? = null,
    val deliveredAt: String? = null,
    val returnAt: String? = null,
    val arrivedAt: String? = null,
    val purchaseStatus: String? = null,
    val items: List<PkgItem>? = null,
    val purchaseLinks: List<PurchaseLink>? = null,
    val orderAmount: Double? = null,
    val totalPurchaseAmount: Double? = null,
    val profit: Profit? = null,
    val accrual: Accrual? = null,
    val weightG: Double? = null,
    val ozonWeightG: Double? = null,
    val systemWeightG: Double? = null,
    val buyerName: String? = null,
    val deliveryMethod: String? = null,
    val warehouse: String? = null,
    val returnState: String? = null,
    val returnStateName: String? = null,
    val cancelReasonId: Int? = null,
    val cancelReason: String? = null,
)

data class PkgItem(
    val id: String? = null,
    val itemId: String? = null,
    val picUrl: String? = null,
    val title: String? = null,
    val sku: String? = null,
    val offerId: String? = null,
    val price: Double? = null,
    val quantity: Double? = null,
)

data class PurchaseLink(
    val id: String = "",
    val purchaseOrderId: String? = null,
    val platform: String? = null,
    val purchaseSn: String? = null,
    val buyerAccount: String? = null,
    val sellerName: String? = null,
    val poStatus: String? = null,
    val items: List<PurchaseItem>? = null,
    val poPayAt: String? = null,
    val poGmtCreate: String? = null,
    val allocatedAmount: Double? = null,
    val poLogisticsNo: String? = null,
    val poLogisticsCompany: String? = null,
)

data class PurchaseItem(
    val thumbUrl: String? = null,
    val picUrl: String? = null,
    val goodsName: String? = null,
    val title: String? = null,
    val spec: String? = null,
    val price: Double? = null,
    val number: Double? = null,
    val num: Double? = null,
)

data class Profit(
    val profit: Double? = null,
    val estimated: Boolean? = null,
    val cancelled: Boolean? = null,
    val returned: Boolean? = null,
    val commission: Double? = null,
    val delivery: Double? = null,
    val escrow: Double? = null,
    val weightG: Double? = null,
    val profitRateSale: Double? = null,
    val profitRateCost: Double? = null,
)

/** 应计信息（销售佣金/其它费用） */
data class Accrual(
    val saleFee: Double? = null,
    val others: Double? = null,
)

/** 国内物流轨迹 */
data class Trace(
    val traceAt: String? = null,
    val trace_at: String? = null,
    val description: String? = null,
    val company: String? = null,
)

/** 包裹详情响应：{ package, items, purchaseLinks, traces } */
data class OrderDetail(
    val `package`: Pkg? = null,
    val items: List<PkgItem>? = null,
    val purchaseLinks: List<PurchaseLink>? = null,
    val traces: List<Trace>? = null,
)

/** 同步订单返回 */
data class SyncResult(
    val orderSynced: Boolean = false,
    val accrualRows: Int? = null,
    val statusBefore: StatusPair? = null,
    val statusAfter: StatusPair? = null,
)

data class StatusPair(
    val ozon: String? = null,
    val operate: String? = null,
)

/** 同步采购物流返回 */
data class SyncLogisticsResult(
    val results: List<JsonAny>? = null,
)

/** 占位，仅用于类型安全（实际字段按需读取） */
data class JsonAny(
    val id: String? = null,
)

data class LabelResult(
    val url: String? = null,
    val expiresIn: Long? = null,
)

/** 备货提交返回 */
data class ShipResult(
    val ozonStatus: String? = null,
    val operateStatus: String? = null,
    val alreadyShipped: Boolean = false,
    val pending: Boolean = false,
)

/** 提交发货返回 */
data class ScanShipResult(
    val canShip: Boolean = false,
    val message: String? = null,
    val operateStatus: String? = null,
)

// ── 财务统计 ─────────────────────────────────────────────

/** 财务汇总响应：/finance-stats/summary */
data class FinanceSummary(
    val allTime: Boolean = false,
    val from: String? = null,
    val to: String? = null,
    val tz: String? = null,
    val rubRate: RubRate? = null,
    val settled: GroupAgg? = null,
    val pending: GroupAgg? = null,
    val nonOrder: NonOrderAgg? = null,
)

data class GroupAgg(
    val orderCount: Int = 0,
    val totalOrderAmount: Double = 0.0,
    val totalPurchaseAmount: Double = 0.0,
    val totalProfit: Double = 0.0,
    val totalPayout: Double = 0.0,
    val totalCommission: Double = 0.0,
    val totalDelivery: Double = 0.0,
    val estimated: Boolean = false,
    val grossPayout: Double? = null,
    val validPayout: Double? = null,
    val invalidPayout: Double? = null,
    val profitRateSale: Double? = null,
    val profitRateCost: Double? = null,
    val accrualTypes: List<AccrualType>? = null,
    val byCategory: CategoryAgg? = null,
    val byCategoryProfit: CategoryAgg? = null,
    val truncated: Boolean = false,
)

data class CategoryAgg(
    val success: Int = 0,
    val cancelled: Int = 0,
    val returned: Int = 0,
)

data class NonOrderAgg(
    val count: Int = 0,
    val totalRub: Double = 0.0,
    val totalCny: Double? = null,
    val accrualTypes: List<AccrualType>? = null,
)

data class AccrualType(
    val typeId: Int = 0,
    val nameCn: String? = null,
    val count: Int = 0,
    val rub: Double = 0.0,
    val cny: Double? = null,
)

/** 财务订单明细：/finance-stats/orders */
data class FinanceOrder(
    val packageId: String? = null,
    val postingNumber: String? = null,
    val storeId: String? = null,
    val storeName: String? = null,
    val inProcessAt: String? = null,
    val deliveredAt: String? = null,
    val orderAmount: Double = 0.0,
    val purchaseAmount: Double = 0.0,
    val weightG: Double? = null,
    val estimated: Boolean = false,
    val category: String? = null,
    val payout: Double = 0.0,
    val profit: Double = 0.0,
    val profitRateSale: Double? = null,
    val profitRateCost: Double? = null,
    val accrualTypes: List<AccrualType>? = null,
)

data class FinanceOrdersResponse(
    val group: String? = null,
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20,
    val orders: List<FinanceOrder> = emptyList(),
    val rubRate: RubRate? = null,
)

/** 非订单应计明细：/finance-stats/non-order-accruals */
data class NonOrderAccrual(
    val id: String? = null,
    val storeId: String? = null,
    val storeName: String? = null,
    val unitNumber: String? = null,
    val typeId: Int = 0,
    val nameCn: String? = null,
    val typeName: String? = null,
    val rub: Double = 0.0,
    val cny: Double? = null,
    val accrualDate: String? = null,
    val syncedAt: String? = null,
)

data class NonOrderAccrualsResponse(
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20,
    val items: List<NonOrderAccrual> = emptyList(),
    val rubRate: RubRate? = null,
)

/** 有订单月份 */
data class OrderMonthsResponse(
    val months: List<String> = emptyList(),
)

// ── 订单统计 ─────────────────────────────────────────────

/** 订单统计汇总：/order-stats/summary */
data class OrderStatsSummary(
    val totals: OrderStatsTotals? = null,
    val byStore: List<StoreStats>? = null,
)

data class OrderStatsTotals(
    val new: CountAmount? = null,
    val pickup: CountAmount? = null,
    val delivered: CountAmount? = null,
    val returned: CountAmount? = null,
)

data class CountAmount(
    val count: Int = 0,
    val amount: Double = 0.0,
    val validAmount: Double? = null,
)

data class StoreStats(
    val storeId: String? = null,
    val storeName: String? = null,
    val new: CountAmount? = null,
    val pickup: CountAmount? = null,
    val delivered: CountAmount? = null,
    val returned: CountAmount? = null,
)

/** 店铺列表响应：/order-stats/stores */
data class OrderStatsStoresResponse(
    val stores: List<StoreItem>? = null,
)

data class StoreItem(
    val id: String? = null,
    val name: String? = null,
)