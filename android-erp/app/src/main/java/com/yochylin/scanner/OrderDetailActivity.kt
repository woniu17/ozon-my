package com.yochylin.scanner

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import coil.load
import com.yochylin.scanner.adapter.countdownText
import com.yochylin.scanner.adapter.fmtMoney
import com.yochylin.scanner.adapter.fmtNum
import com.yochylin.scanner.adapter.fmtTime
import com.yochylin.scanner.adapter.platformLabel
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.api.optInt
import com.yochylin.scanner.api.optString
import com.yochylin.scanner.model.OrderDetail
import com.yochylin.scanner.model.Pkg
import com.yochylin.scanner.model.PurchaseLink
import com.yochylin.scanner.model.Trace
import kotlinx.coroutines.launch

/** 订单详情：展示 + 同步/备货/提交发货/面单/同步采购物流 */
class OrderDetailActivity : ComponentActivity() {

    private val COLOR_PRIMARY = "#165dff"
    private val COLOR_WARN = "#d97706"
    private val COLOR_OK = "#00b42a"
    private val COLOR_ERR = "#f53f3f"
    private val COLOR_MUTE = "#86909c"
    private val COLOR_TEXT = "#1f2329"

    private var packageId = ""
    private var pkg: Pkg? = null

    private lateinit var dStore: TextView
    private lateinit var dOpTag: TextView
    private lateinit var dPosting: TextView
    private lateinit var dCopyPosting: TextView
    private lateinit var dSplitBadge: TextView
    private lateinit var dCountdown: TextView
    private lateinit var dTags: TextView
    private lateinit var dProfitStrip: LinearLayout
    private lateinit var dInfoList: LinearLayout
    private lateinit var dMoreToggle: TextView
    private lateinit var dMoreInfo: LinearLayout
    private lateinit var dProdTitle: TextView
    private lateinit var dProdContainer: LinearLayout
    private lateinit var dPoTitle: TextView
    private lateinit var dPoContainer: LinearLayout
    private lateinit var dTraceCard: LinearLayout
    private lateinit var dTraceTitle: TextView
    private lateinit var dTraceContainer: LinearLayout
    private lateinit var dTraceToggle: TextView
    private lateinit var dActionBar: LinearLayout

    private var infoOpen = false
    private var traceOpen = false
    private var traces: List<Trace> = emptyList()
    private var links: List<PurchaseLink> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Session.init(this)
        if (!Session.isLoggedIn) {
            goLogin()
            return
        }

        setContentView(R.layout.activity_order_detail)

        dStore = findViewById(R.id.dStore)
        dOpTag = findViewById(R.id.dOpTag)
        dPosting = findViewById(R.id.dPosting)
        dCopyPosting = findViewById(R.id.dCopyPosting)
        dSplitBadge = findViewById(R.id.dSplitBadge)
        dCountdown = findViewById(R.id.dCountdown)
        dTags = findViewById(R.id.dTags)
        dProfitStrip = findViewById(R.id.dProfitStrip)
        dInfoList = findViewById(R.id.dInfoList)
        dMoreToggle = findViewById(R.id.dMoreToggle)
        dMoreInfo = findViewById(R.id.dMoreInfo)
        dProdTitle = findViewById(R.id.dProdTitle)
        dProdContainer = findViewById(R.id.dProdContainer)
        dPoTitle = findViewById(R.id.dPoTitle)
        dPoContainer = findViewById(R.id.dPoContainer)
        dTraceCard = findViewById(R.id.dTraceCard)
        dTraceTitle = findViewById(R.id.dTraceTitle)
        dTraceContainer = findViewById(R.id.dTraceContainer)
        dTraceToggle = findViewById(R.id.dTraceToggle)
        dActionBar = findViewById(R.id.dActionBar)

        packageId = intent.getStringExtra("packageId") ?: ""
        if (packageId.isBlank()) {
            toast("缺少包裹 ID")
            finish()
            return
        }

        findViewById<TextView>(R.id.detailBackBtn).setOnClickListener { finish() }
        findViewById<TextView>(R.id.detailRefreshBtn).setOnClickListener { loadDetail() }
        dMoreToggle.setOnClickListener {
            infoOpen = !infoOpen
            renderMoreInfo()
        }
        dTraceToggle.setOnClickListener {
            traceOpen = !traceOpen
            renderTraces()
        }

        loadDetail()
    }

    // ── 数据加载 ──
    private fun loadDetail() {
        lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/order-process/detail/$packageId")
                val detail = Api.parse<OrderDetail>(data)
                pkg = detail.`package`
                links = detail.purchaseLinks ?: emptyList()
                traces = detail.traces ?: emptyList()
                render(detail)
            } catch (e: Exception) {
                if (e is ApiException && e.code == 401) {
                    toast("登录已过期,请重新登录")
                    goLogin()
                } else {
                    toast(e.message ?: "加载失败")
                }
            }
        }
    }

    // ── 渲染 ──
    private fun render(detail: OrderDetail) {
        val p = detail.`package` ?: return
        pkg = p

        dStore.text = p.storeName
        dStore.visibility = if (p.storeName.isNullOrBlank()) View.GONE else View.VISIBLE

        val op = opTagInfo(p)
        dOpTag.text = if (p.isIgnored) "搁置 · ${op.first}" else op.first
        dOpTag.setTextColor(Color.parseColor(op.second))
        dOpTag.setRoundedBg(Color.parseColor(softBgOf(op.second)))

        dPosting.text = p.postingNumber
        dPosting.setTextColor(if (isQcPosting(p.postingNumber)) Color.parseColor("#d93026") else Color.parseColor(COLOR_TEXT))

        // 货件号复制(对齐 H5 订单详情)
        dCopyPosting.visibility = if (p.postingNumber.isNullOrBlank()) View.GONE else View.VISIBLE
        dCopyPosting.setOnClickListener {
            p.postingNumber?.let { copyText(it, "货件号") }
        }

        when {
            !p.parentId.isNullOrBlank() -> {
                dSplitBadge.text = "子件(母件 ${p.parentId})"
                dSplitBadge.setTextColor(Color.parseColor("#b45309"))
                dSplitBadge.setRoundedBg(Color.parseColor("#fff7e6"))
                dSplitBadge.visibility = View.VISIBLE
            }
            p.hasChildren -> {
                dSplitBadge.text = "母件"
                dSplitBadge.setTextColor(Color.parseColor("#4338ca"))
                dSplitBadge.setRoundedBg(Color.parseColor("#eef2ff"))
                dSplitBadge.visibility = View.VISIBLE
            }
            else -> dSplitBadge.visibility = View.GONE
        }

        val countdownStatuses = listOf("wait_process", "wait_ship", "ship_success")
        if (p.operateStatus in countdownStatuses && !p.shipmentDate.isNullOrBlank()) {
            val cd = countdownText(p.shipmentDate)
            dCountdown.text = if (cd.first) "已超时 ${cd.second}" else "剩发 ${cd.second}"
            dCountdown.setTextColor(Color.parseColor(if (cd.first) COLOR_ERR else "#b45309"))
            dCountdown.setRoundedBg(Color.parseColor(if (cd.first) "#ffece8" else "#fff7e6"))
            dCountdown.visibility = View.VISIBLE
        } else {
            dCountdown.visibility = View.GONE
        }

        dTags.text = p.tags?.joinToString(" · ")
        dTags.visibility = if (p.tags.isNullOrEmpty()) View.GONE else View.VISIBLE

        renderProfitStrip(p)
        renderInfoList(p)
        renderMoreInfo()
        renderItems(detail.items ?: p.items ?: emptyList())
        renderPurchaseLinks(links)
        renderTraces()
        renderActions(p)
    }

    private fun renderProfitStrip(p: Pkg) {
        val profit = p.profit ?: run {
            dProfitStrip.visibility = View.GONE
            return
        }
        dProfitStrip.visibility = View.VISIBLE
        dProfitStrip.removeAllViews()
        addProfitCell(dProfitStrip, "订单金额", fmtMoney(p.orderAmount), Color.parseColor(COLOR_TEXT))
        addProfitCell(dProfitStrip, "采购合计", fmtMoney(p.totalPurchaseAmount), Color.parseColor(COLOR_TEXT))
        addProfitCell(dProfitStrip, profitLabelOf(p), fmtMoney(profit.profit), profitColorOf(profit.profit))
        if (profit.profitRateCost != null) {
            addProfitCell(dProfitStrip, "成本利润率", formatRate(profit.profitRateCost), profitColorOf(profit.profitRateCost))
        }
    }

    private fun renderInfoList(p: Pkg) {
        dInfoList.removeAllViews()
        addInfoRow(dInfoList, "Ozon状态", ozonStatusText(p))
        addInfoRow(dInfoList, "下单时间", fmtTime(p.inProcessAt))
        addInfoRow(dInfoList, "最晚发货", fmtTime(p.shipmentDate ?: p.lastDeliveryAt))
        addInfoRow(dInfoList, "重量", p.weightG?.let { "${fmtNum(it)}g" } ?: "—")
        addInfoRow(dInfoList, "销售佣金", p.accrual?.saleFee?.let { fmtMoney(it) } ?: "—")
        addInfoRow(dInfoList, "国际配送(估)", p.profit?.delivery?.let { fmtMoney(it) } ?: "—")
    }

    private fun renderMoreInfo() {
        val p = pkg ?: return
        dMoreToggle.text = if (infoOpen) "收起其它信息" else "更多订单信息 ›"
        dMoreInfo.visibility = if (infoOpen) View.VISIBLE else View.GONE
        dMoreInfo.removeAllViews()

        if (p.accrual != null) addInfoRow(dMoreInfo, "其它费用", p.accrual?.others?.let { fmtMoney(it) } ?: "—")
        if (p.profit?.profitRateSale != null) {
            addInfoRow(dMoreInfo, "销售利润率", formatRate(p.profit.profitRateSale!!))
        }
        addInfoRow(dMoreInfo, "买家", p.buyerName ?: "—")
        addInfoRow(dMoreInfo, "配送方式", p.deliveryMethod ?: "—")
        addInfoRow(dMoreInfo, "发货仓库", p.warehouse ?: "—")
        if (p.isReturned) {
            addInfoRow(dMoreInfo, "退货状态", returnStateText(p))
        }
        if (p.operateStatus == "cancelled") {
            addInfoRow(dMoreInfo, "取消原因", cancelReasonText(p))
        }
    }

    private fun renderItems(items: List<com.yochylin.scanner.model.PkgItem>) {
        dProdTitle.text = "商品(${items.size})"
        dProdContainer.removeAllViews()
        if (items.isEmpty()) {
            dProdContainer.addView(mutedText("—"))
            return
        }
        // 采购分摊按 itemId 聚合
        val allocByItem = HashMap<String, Double>()
        for (l in links) {
            for (pi in l.items ?: emptyList()) {
                // 后端采购商品行不一定带 itemId；分摊已汇总在 link.allocatedAmount，此处按商品粗略展示
            }
        }
        // 单件分摊：按链接的商品在包裹商品中的匹配（简化：不逐件拆分，分摊总额展示在链接层）
        for (it in items) {
            dProdContainer.addView(buildProductRow(it, allocByItem))
        }
    }

    private fun buildProductRow(item: com.yochylin.scanner.model.PkgItem, allocByItem: Map<String, Double>): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = 12 }
        }

        val img = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(64, 64)
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.parseColor("#f2f3f5"))
        }
        if (!item.picUrl.isNullOrBlank()) img.load(item.picUrl)
        row.addView(img)

        val right = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }

        val title = TextView(this).apply {
            text = item.title ?: "—"
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 13f
            maxLines = 2
        }
        right.addView(title)

        // SKU 行 + 复制
        val skuRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 4, 0, 0)
        }
        val sku = TextView(this).apply {
            text = "SKU ${item.sku ?: "—"}"
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 11f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        skuRow.addView(sku)
        val copySku = TextView(this).apply {
            text = "复制"
            setTextColor(Color.parseColor(COLOR_PRIMARY))
            textSize = 11f
            setPadding(6, 0, 0, 0)
            setOnClickListener { item.sku?.let { copyText(it, "SKU") } }
        }
        skuRow.addView(copySku)
        right.addView(skuRow)

        // OfferID 行 + 复制
        val offerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val offer = TextView(this).apply {
            text = "OfferID ${item.offerId ?: "—"}"
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 11f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        offerRow.addView(offer)
        val copyOffer = TextView(this).apply {
            text = "复制"
            setTextColor(Color.parseColor(COLOR_PRIMARY))
            textSize = 11f
            setPadding(6, 0, 0, 0)
            setOnClickListener { item.offerId?.let { copyText(it, "Offer ID") } }
        }
        offerRow.addView(copyOffer)
        right.addView(offerRow)

        val unitCost = unitCostOf(item, links)
        val gross = if (unitCost != null && item.price != null) {
            Math.round((item.price!! * 0.84 - unitCost) * 100) / 100.0
        } else null

        val priceLine = TextView(this).apply {
            text = buildString {
                append("单价 ").append(fmtMoney(item.price))
                append("  ×").append(fmtNum(item.quantity))
                if (unitCost != null) append(" · 采购 ").append(fmtMoney(unitCost))
                if (gross != null) append(" · 毛利/件 ").append(fmtMoney(gross))
            }
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 11f
            setPadding(0, 4, 0, 0)
        }
        right.addView(priceLine)

        row.addView(right)
        return row
    }

    private fun renderPurchaseLinks(links: List<PurchaseLink>) {
        dPoContainer.removeAllViews()
        if (links.isEmpty()) {
            dPoContainer.addView(mutedText("未录入采购"))
            return
        }
        for (l in links) {
            dPoContainer.addView(buildPurchaseLinkRow(l))
        }
    }

    private fun buildPurchaseLinkRow(l: PurchaseLink): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#fafafa"))
            setPadding(12, 10, 12, 10)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 8 }
        }

        // 头部：平台 + 单号 + 复制 + 状态
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val platform = TextView(this).apply {
            text = platformLabel(l.platform)
            setTextColor(Color.parseColor("#7d4dd3"))
            textSize = 10f
            setRoundedBg(Color.parseColor("#f5efff"))
            setPadding(6, 2, 6, 2)
        }
        head.addView(platform)

        val sn = TextView(this).apply {
            text = l.purchaseSn ?: "#${l.purchaseOrderId ?: l.id}"
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = 8
            }
        }
        head.addView(sn)

        val copy = TextView(this).apply {
            text = "复制"
            setTextColor(Color.parseColor(COLOR_PRIMARY))
            textSize = 11f
            setPadding(6, 0, 0, 0)
        }
        copy.setOnClickListener {
            if (!l.purchaseSn.isNullOrBlank()) copyText(l.purchaseSn!!, "采购单号")
        }
        head.addView(copy)

        // 打开平台 APP（如已安装）；否则浏览器打开平台搜索页
        val openApp = TextView(this).apply {
            text = "打开APP"
            setTextColor(Color.parseColor("#7d4dd3"))
            textSize = 11f
            setPadding(6, 0, 0, 0)
            visibility = if (l.purchaseSn.isNullOrBlank()) View.GONE else View.VISIBLE
        }
        openApp.setOnClickListener {
            openPlatformApp(l.platform, l.purchaseSn)
        }
        head.addView(openApp)

        val status = TextView(this).apply {
            text = poStatusLabel(l.poStatus)
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 10f
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                leftMargin = 8
            }
        }
        head.addView(status)
        card.addView(head)

        // 分摊 / 卖家 / 买家
        val meta = TextView(this).apply {
            text = buildString {
                append("分摊 ").append(fmtMoney(l.allocatedAmount))
                if (!l.sellerName.isNullOrBlank()) append("  ·  ").append(l.sellerName)
                if (!l.buyerAccount.isNullOrBlank()) append("  ·  买:").append(l.buyerAccount)
            }
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 10f
            setPadding(0, 4, 0, 0)
        }
        card.addView(meta)

        // 采购商品
        for (pi in l.items ?: emptyList()) {
            card.addView(buildPurchaseGoodsRow(pi))
        }

        // 物流
        if (!l.poLogisticsNo.isNullOrBlank()) {
            val logi = TextView(this).apply {
                text = "${l.poLogisticsCompany ?: ""} ${l.poLogisticsNo}".trim()
                setTextColor(Color.parseColor(COLOR_PRIMARY))
                textSize = 10f
                setPadding(0, 4, 0, 0)
            }
            logi.setOnClickListener {
                copyText(l.poLogisticsNo!!, "快递单号")
            }
            card.addView(logi)
        }

        return card
    }

    /** 打开平台 APP（deep link，如已安装）；否则用浏览器打开平台搜索页 */
    private fun openPlatformApp(platform: String?, sn: String?) {
        if (sn.isNullOrBlank()) {
            toast("无采购单号")
            return
        }
        val (scheme, webUrl) = platformDeepLink(platform, sn)
        val appIntent = Intent(Intent.ACTION_VIEW, Uri.parse(scheme)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (packageManager.resolveActivity(appIntent, 0) != null) {
            runCatching {
                startActivity(appIntent)
                return
            }.onFailure { /* 拉起失败，走网页兜底 */ }
        }
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(webUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { toast("未找到可跳转的应用") }
    }

    /** 平台 → (deep link scheme, 网页搜索/订单页 URL)，拼多多/1688 与 H5 订单详情链接一致 */
    private fun platformDeepLink(platform: String?, sn: String): Pair<String, String> {
        val enc = Uri.encode(sn)
        return when (platform?.lowercase()) {
            "pdd", "yangkeduo", "拼多多" ->
                "https://mobile.yangkeduo.com/order.html?order_sn=$enc" to "https://mobile.yangkeduo.com/order.html?order_sn=$enc"
            "1688", "alibaba", "阿里巴巴" ->
                "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?word=$enc" to "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html?word=$enc"
            "taobao", "淘宝" -> "taobao://" to "https://s.taobao.com/search?q=$enc"
            "tmall", "天猫" -> "tmall://" to "https://s.tmall.com/search?q=$enc"
            "douyin", "抖音", "抖音小店" -> "snssdk1128://" to "https://www.douyin.com/search/$enc"
            "amazon", "亚马逊" -> "https://www.amazon.com/gp/your-account/order-details?orderID=$enc" to "https://www.amazon.com/gp/your-account/order-details?orderID=$enc"
            "ozon" -> "https://seller.ozon.ru/app/orders/search?search=$enc" to "https://seller.ozon.ru/app/orders/search?search=$enc"
            else -> "https://www.google.com/search?q=$enc" to "https://www.google.com/search?q=$enc"
        }
    }

    private fun buildPurchaseGoodsRow(pi: com.yochylin.scanner.model.PurchaseItem): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 6 }
        }
        val img = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(44, 44)
            scaleType = ImageView.ScaleType.CENTER_CROP
            setBackgroundColor(Color.parseColor("#f2f3f5"))
        }
        val pic = pi.thumbUrl ?: pi.picUrl
        if (!pic.isNullOrBlank()) img.load(pic)
        row.addView(img)

        val right = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = 8
            }
        }
        val name = TextView(this).apply {
            text = pi.goodsName ?: pi.title ?: "采购商品"
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 11f
            maxLines = 1
        }
        right.addView(name)
        val spec = TextView(this).apply {
            text = buildString {
                if (!pi.spec.isNullOrBlank()) append(pi.spec).append(" · ")
                append("¥").append(pi.price?.let { fmtMoney(it) } ?: "—")
                append(" × ").append(fmtNum(pi.number ?: pi.num ?: 1.0))
            }
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 10f
        }
        right.addView(spec)
        row.addView(right)
        return row
    }

    private fun renderTraces() {
        if (traces.isEmpty()) {
            dTraceCard.visibility = View.GONE
            return
        }
        dTraceCard.visibility = View.VISIBLE
        dTraceTitle.text = "国内物流轨迹(${traces.size})"
        dTraceContainer.removeAllViews()
        val visible = if (traceOpen) traces else traces.take(3)
        for (t in visible) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = 6 }
            }
            val time = TextView(this).apply {
                text = fmtTime(t.traceAt ?: t.trace_at)
                setTextColor(Color.parseColor(COLOR_MUTE))
                textSize = 10f
                layoutParams = LinearLayout.LayoutParams(130, ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            row.addView(time)
            val desc = TextView(this).apply {
                text = t.description ?: t.company ?: ""
                setTextColor(Color.parseColor(COLOR_TEXT))
                textSize = 10f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            row.addView(desc)
            dTraceContainer.addView(row)
        }
        if (traces.size > 3) {
            dTraceToggle.text = if (traceOpen) "收起" else "展开全部 ${traces.size} 条"
            dTraceToggle.visibility = View.VISIBLE
        } else {
            dTraceToggle.visibility = View.GONE
        }
    }

    // ── 操作条 ──
    private fun renderActions(p: Pkg) {
        dActionBar.removeAllViews()

        // 同步订单
        dActionBar.addView(actionButton("同步订单", COLOR_MUTE) { onSync() })

        val canShip = (p.operateStatus == "wait_process" || p.operateStatus == "wait_ship") &&
            p.ozonStatus == "awaiting_packaging" && !p.isIgnored
        if (canShip) {
            dActionBar.addView(actionButton("备货", COLOR_PRIMARY) { onShip(p) })
        }

        if (p.operateStatus == "wait_ship" && !p.isIgnored) {
            dActionBar.addView(actionButton("提交发货", COLOR_PRIMARY) { onSubmitShip(p) })
        }

        if (p.operateStatus in listOf("wait_ship", "ship_success", "wait_receiver_confirm") && !p.isIgnored) {
            dActionBar.addView(actionButton("面单", COLOR_MUTE) { onLabel(p) })
        }

        // 采购（管理入口，后续版本支持）
        dActionBar.addView(actionButton(if (links.isNotEmpty()) "编辑采购" else "采购", COLOR_MUTE) {
            toast("采购管理开发中,请使用电脑端或小程序")
        })

        if (links.isNotEmpty() && p.operateStatus != "wait_process") {
            dActionBar.addView(actionButton("同步采购物流", COLOR_MUTE) { onSyncLogistics() })
        }
    }

    private fun actionButton(text: String, color: String, onClick: () -> Unit): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.WHITE)
            textSize = 12f
            setRoundedBg(Color.parseColor(color), 8f)
            setPadding(20, 12, 20, 12)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.rightMargin = 8
            layoutParams = lp
            setOnClickListener { onClick() }
        }
    }

    // ── 操作实现 ──
    private fun onSync() {
        lifecycleScope.launch {
            try {
                val r = Api.post("/admin/api/order-process/sync-package", mapOf("packageId" to packageId)).asJsonObject
                val parts = mutableListOf<String>()
                parts.add(if (r.optBoolean("orderSynced")) "订单已同步" else "订单未更新")
                val accrualRows = r.optInt("accrualRows", -1)
                if (accrualRows >= 0) parts.add("应计 $accrualRows 行")
                val before = r.get("statusBefore")?.asJsonObject
                val after = r.get("statusAfter")?.asJsonObject
                if (before != null && after != null) {
                    val b = before.optString("ozon") + "/" + before.optString("operate")
                    val a = after.optString("ozon") + "/" + after.optString("operate")
                    if (b != a) parts.add("状态 $b → $a")
                }
                toast("同步完成:" + parts.joinToString(" · "))
                markChanged()
                loadDetail()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    private fun onShip(p: Pkg) {
        val totalQty = (p.items?.sumOf { it.quantity ?: 0.0 } ?: 0.0).toLong()
        val multiQty = (p.items?.any { (it.quantity ?: 0.0) >= 2 } ?: false)
        val doShip = {
            lifecycleScope.launch {
                try {
                    val r = Api.post("/admin/api/order-process/ship", mapOf("packageId" to packageId)).asJsonObject
                    toast(if (r.optBoolean("alreadyShipped")) "该包裹已备货过" else "备货成功")
                    markChanged()
                    loadDetail()
                } catch (e: Exception) {
                    handleError(e)
                }
            }
        }
        if (multiQty) {
            AlertDialog.Builder(this)
                .setTitle("备货确认")
                .setMessage("货件 ${p.postingNumber}\n含数量≥2的商品(共 $totalQty 件),将向 Ozon 确认全部商品为一个货件(不拆分)。")
                .setPositiveButton("备货") { _, _ -> doShip() }
                .setNegativeButton("取消", null)
                .show()
        } else {
            doShip()
        }
    }

    private fun onSubmitShip(p: Pkg) {
        val input = EditText(this).apply {
            hint = "请输入重量(g)"
            inputType = InputType.TYPE_CLASS_NUMBER
        }
        AlertDialog.Builder(this)
            .setTitle("提交发货 - ${p.postingNumber}")
            .setView(input)
            .setPositiveButton("提交发货") { _, _ ->
                val g = input.text.toString().trim().toIntOrNull()
                if (g == null || g < 1 || g > 50000) {
                    toast("重量须为 1~50000 的整数")
                    return@setPositiveButton
                }
                lifecycleScope.launch {
                    try {
                        val r = Api.post(
                            "/admin/api/order-process/scan-ship/submit",
                            mapOf("packageId" to packageId, "weightG" to g)
                        ).asJsonObject
                        if (!r.optBoolean("canShip")) {
                            toast(r.optString("message", "订单状态不允许提交"))
                            return@launch
                        }
                        try {
                            Api.post("/admin/api/order-process/print-label", mapOf("packageId" to packageId))
                        } catch (_: Exception) {
                        }
                        toast("已交运")
                        markChanged()
                        loadDetail()
                    } catch (e: Exception) {
                        handleError(e)
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun onLabel(p: Pkg) {
        lifecycleScope.launch {
            try {
                val r = Api.post(
                    "/admin/api/order-process/package-label",
                    mapOf("packageIds" to listOf(packageId))
                ).asJsonObject
                val url = r.optString("url")
                if (url.isBlank()) {
                    toast("面单链接为空")
                    return@launch
                }
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    private fun onSyncLogistics() {
        lifecycleScope.launch {
            try {
                val r = Api.post(
                    "/admin/api/order-process/sync-package-purchase-logistics",
                    mapOf("packageId" to packageId)
                ).asJsonObject
                val arr = r.get("results")
                val n = if (arr != null && arr.isJsonArray) arr.asJsonArray.size() else 0
                toast("已同步 $n 个采购单物流")
                markChanged()
                loadDetail()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 辅助 ──
    private fun markChanged() {
        setResult(RESULT_OK)
    }

    private fun addInfoRow(container: LinearLayout, key: String, value: String) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = 4 }
        }
        val k = TextView(this).apply {
            text = key
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 11f
            layoutParams = LinearLayout.LayoutParams(110, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        row.addView(k)
        val v = TextView(this).apply {
            text = value
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 11f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        row.addView(v)
        container.addView(row)
    }

    private fun addProfitCell(container: LinearLayout, key: String, value: String, color: Int) {
        val cell = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val k = TextView(this).apply {
            text = key
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 10f
            gravity = Gravity.CENTER
        }
        cell.addView(k)
        val v = TextView(this).apply {
            text = value
            setTextColor(color)
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            gravity = Gravity.CENTER
        }
        cell.addView(v)
        container.addView(cell)
    }

    private fun mutedText(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 11f
            setPadding(0, 6, 0, 0)
        }
    }

    private fun opTagInfo(p: Pkg): Pair<String, String> {
        if (p.isReturned) return "已退货" to COLOR_ERR
        return when (p.operateStatus) {
            "wait_process" -> "待处理" to COLOR_WARN
            "wait_ship" -> "待打单发货" to COLOR_PRIMARY
            "ship_success" -> "交运" to COLOR_PRIMARY
            "wait_receiver_confirm" -> "已发货" to COLOR_OK
            "signed" -> "已签收" to COLOR_OK
            "settled" -> "已成功" to COLOR_OK
            "returned" -> "已退货" to COLOR_ERR
            "cancelled" -> "已取消" to COLOR_ERR
            else -> (p.operateStatus ?: "—") to COLOR_MUTE
        }
    }

    private fun softBgOf(color: String): String = when (color) {
        COLOR_PRIMARY -> "#eef4ff"
        COLOR_WARN -> "#fff7e6"
        COLOR_OK -> "#e8ffea"
        COLOR_ERR -> "#ffece8"
        else -> "#f2f3f5"
    }

    private fun isQcPosting(sn: String?): Boolean {
        val s = sn ?: ""
        return s.startsWith("02131") || s.startsWith("024785")
    }

    private fun ozonStatusText(p: Pkg): String {
        val s = p.ozonStatus
        val label = OZON_LABELS[s] ?: s ?: "—"
        return if (p.substatus.isNullOrBlank()) label else "$label · ${p.substatus}"
    }

    private fun profitLabelOf(p: Pkg): String {
        val pr = p.profit ?: return "利润"
        if (pr.cancelled == true) return "利润"
        return if (pr.estimated == false) "利润实" else "预估利润"
    }

    private fun profitColorOf(v: Double?): Int {
        if (v == null) return Color.parseColor(COLOR_MUTE)
        return if (v > 0) Color.parseColor(COLOR_OK) else if (v < 0) Color.parseColor(COLOR_ERR) else Color.parseColor(COLOR_MUTE)
    }

    private fun formatRate(v: Double): String = "${String.format("%.1f", v * 100)}%"

    private fun returnStateText(p: Pkg): String {
        return RETURN_STATE_LABELS[p.returnState] ?: p.returnStateName ?: p.returnState ?: "退货中"
    }

    private fun cancelReasonText(p: Pkg): String {
        return CANCEL_REASON_LABELS[p.cancelReasonId] ?: p.cancelReason ?: ""
    }

    private fun poStatusLabel(s: String?): String = when (s) {
        "wait_pay" -> "待付款"
        "wait_send" -> "待发货"
        "shipped" -> "已发货"
        "part_shipped" -> "部分发货"
        "signed" -> "已签收"
        "finished" -> "已完成"
        "closed" -> "已关闭"
        else -> s ?: "—"
    }

    private fun unitCostOf(it: com.yochylin.scanner.model.PkgItem, links: List<PurchaseLink>): Double? {
        // 简化：按采购链接商品数均摊总额到该商品（若只有一种商品则全额）
        val alloc = links.sumOf { l -> l.allocatedAmount ?: 0.0 }
        if (alloc <= 0) return null
        val totalQty = links.sumOf { l ->
            (l.items ?: emptyList()).sumOf { it.number ?: it.num ?: 1.0 }
        }
        val qty = it.quantity ?: 0.0
        if (totalQty <= 0 || qty <= 0) return null
        return Math.round((alloc / totalQty) * 100) / 100.0
    }

    private fun copyText(text: String, label: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
        toast("$label 已复制")
    }

    private fun handleError(e: Exception) {
        if (e is ApiException && e.code == 401) {
            toast("登录已过期,请重新登录")
            goLogin()
        } else {
            toast(e.message ?: "操作失败")
        }
    }

    private fun goLogin() {
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    companion object {
        private val OZON_LABELS = mapOf(
            "awaiting_packaging" to "待打包",
            "awaiting_registration" to "待交运",
            "awaiting_deliver" to "运输中",
            "delivering" to "派送中",
            "delivered" to "已送达",
            "cancelled" to "已取消",
            "not_accepted" to "未揽收",
            "returned_to_seller" to "已退回",
            "partial_delivered" to "部分送达",
            "driver_pickup" to "司机已揽收",
            "at_warehouse" to "已到仓",
        )

        private val RETURN_STATE_LABELS = mapOf(
            "Utilized" to "已销毁",
            "UtilizedByOzon" to "Ozon销毁",
            "Utilizing" to "销毁中",
            "ArrivedAtWarehouse" to "已到退货仓",
            "MoneyReturned" to "已退款",
            "MoneyReturning" to "退款中",
            "WaitingShipment" to "待寄回",
            "Shipping" to "退货运输中",
            "ReturnedToSeller" to "已退回卖家",
        )

        private val CANCEL_REASON_LABELS = mapOf(
            992 to "Ozon质检单",
            994 to "Ozon质检单",
            79 to "客户拒收:商品不合适",
            578 to "客户拒收:商品不合适",
            505 to "客户取消:期限不合适",
            506 to "客户取消:发现更便宜",
            504 to "客户取消",
            508 to "客户取消",
            710 to "客户取消",
            502 to "客户取消",
            537 to "客户未取货",
            665 to "客户未取货",
            686 to "卖家未按时发货",
            402 to "卖家取消:其他",
            586 to "客户拒收:错发商品",
            20 to "客户拒收:缺件",
            512 to "无法送达",
        )
    }
}