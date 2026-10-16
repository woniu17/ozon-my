package com.yochylin.scanner

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import coil.load
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.yochylin.scanner.adapter.fmtMoney
import com.yochylin.scanner.adapter.fmtNum
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optInt
import com.yochylin.scanner.api.optString
import com.yochylin.scanner.model.LookupLinkedPackage
import com.yochylin.scanner.model.LookupResult
import com.yochylin.scanner.model.OrderDetail
import com.yochylin.scanner.model.PendingAdd
import com.yochylin.scanner.model.PendingPurchaseOrder
import com.yochylin.scanner.model.Pkg
import com.yochylin.scanner.model.PkgItem
import com.yochylin.scanner.model.PlatformOrder
import com.yochylin.scanner.model.PlatformOrderGoods
import com.yochylin.scanner.model.PlatformPromotion
import com.yochylin.scanner.model.PlatformStore
import com.yochylin.scanner.model.PlatformTab
import com.yochylin.scanner.model.PurchaseItem
import com.yochylin.scanner.model.PurchaseItemArg
import com.yochylin.scanner.model.PurchaseLink
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Locale
import kotlin.coroutines.resume

/** 采购流程：采购管理 → 选平台订单 → 分摊确认（与 H5 purchase/index.vue 同构） */
class PurchaseActivity : ComponentActivity() {

    // ── 颜色（与 colors.xml / 详情页一致） ──
    private val COLOR_PRIMARY = "#165dff"
    private val COLOR_TEXT = "#1d2129"
    private val COLOR_SECONDARY = "#4e5969"
    private val COLOR_MUTE = "#86909c"
    private val COLOR_PLACEHOLDER = "#a6abb3"
    private val COLOR_SUCCESS = "#00b42a"
    private val COLOR_WARN = "#d97706"
    private val COLOR_DANGER = "#f53f3f"
    private val COLOR_DIVIDER = "#eef0f3"
    private val COLOR_CARD = "#ffffff"

    private val LOGI_COMPANY_RANGE = listOf(
        "(不填)", "顺丰速运", "中通快递", "圆通速递", "韵达快递", "申通快递",
        "极兔速递", "邮政快递包裹", "京东物流", "德邦物流", "EMS"
    )

    // ── 视图引用 ──
    private lateinit var purchaseBackBtn: TextView
    private lateinit var purchaseTitle: TextView
    private lateinit var purchaseRefreshBtn: TextView
    private lateinit var purchaseStepBar: LinearLayout
    private lateinit var purchaseContent: LinearLayout
    private lateinit var purchaseActionBar: LinearLayout

    // ── 业务状态 ──
    private var packageId = ""
    private var pkg: Pkg? = null
    private var items: List<PkgItem> = emptyList()
    private var links: List<PurchaseLink> = emptyList()
    private var step = "manage" // manage | select | confirm

    // 暂存变更（统一保存落地）
    private val pendingRemoves = LinkedHashSet<String>()
    private var pendingAdd: PendingAdd? = null

    // Step2 平台订单状态
    private val platTabs = mutableListOf<PlatformTab>()
    private val platLogin = HashMap<String, String>() // "platform:account" -> login
    private val stores = HashMap<String, PlatformStore>()
    private var activeTabKey = ""
    private val promoDetailFetched = HashSet<String>()
    private val amountTexts = HashMap<String, String>() // orderSn -> 手改原始文本

    // Step3
    private var lookupResult: LookupResult? = null
    private var logisticsInput = ""
    private var saving = false

    // ── 单价调整（与 H5 OrderProcess.vue 利润预估/一键调价同构） ──
    private data class SkuPriceInfo(
        val sku: String,
        val inCache: Boolean,
        val price: Double?,
        val hasProductId: Boolean,
        val weightG: Double?
    )

    private val PM_TARGET_RATES = listOf(50, 60, 70, 80, 90, 100, 110, 120, 140, 160, 180, 200)
    private val PM_DEFAULT_RATE = 100
    private val PM_COMMISSION_RATE = 0.16
    private val PM_DELIVERY_BASE_CNY = 3.37
    private val PM_DELIVERY_PER_G_CNY = 0.0281

    private val skuPricing = HashMap<String, SkuPriceInfo>() // sku -> 定价信息
    private val poRateChoice = HashMap<String, Int>()        // sku -> 目标成本利润率(默认100)
    private val poCmpExpanded = HashSet<String>()            // sku -> 单价调整折叠展开
    private var adjustingSku: String? = null                 // 正在调价的 sku

    private lateinit var searchInput: EditText
    private lateinit var orderListBox: LinearLayout

    private data class Group(
        val purchaseOrderId: String,
        val platform: String?,
        val purchaseSn: String?,
        val poStatus: String?,
        val allocated: Double,
        val buyerAccount: String?,
        val sellerName: String?,
        val items: List<PurchaseItem>,
        val poLogisticsNo: String?,
        val poLogisticsCompany: String?,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Session.init(this)
        if (!Session.isLoggedIn) {
            goLogin()
            return
        }
        setContentView(R.layout.activity_purchase)
        purchaseBackBtn = findViewById(R.id.purchaseBackBtn)
        purchaseTitle = findViewById(R.id.purchaseTitle)
        purchaseRefreshBtn = findViewById(R.id.purchaseRefreshBtn)
        purchaseStepBar = findViewById(R.id.purchaseStepBar)
        purchaseContent = findViewById(R.id.purchaseContent)
        purchaseActionBar = findViewById(R.id.purchaseActionBar)

        packageId = intent.getStringExtra("packageId") ?: ""
        if (packageId.isBlank()) {
            toast("缺少包裹 ID")
            finish()
            return
        }

        purchaseBackBtn.setOnClickListener {
            if (step != "manage") showManage() else finish()
        }
        purchaseRefreshBtn.setOnClickListener {
            if (step == "select") loadOrders(activeTabKey) else loadDetail()
        }
        loadDetail()
    }

    // ══════════════════ 数据加载 ══════════════════
    private fun loadDetail() {
        lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/order-process/detail/$packageId")
                val detail = Api.parse<OrderDetail>(data)
                pkg = detail.`package`
                items = detail.items ?: pkg?.items ?: emptyList()
                links = detail.purchaseLinks ?: emptyList()
                showManage()
                // 加载 SKU 定价信息（单价调整区用），完成后重渲染
                loadSkuPricing()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    private fun showManage() {
        step = "manage"
        renderManage()
    }

    private fun showSelect() {
        step = "select"
        renderSelect()
    }

    private fun showConfirm() {
        step = "confirm"
        renderConfirm()
    }

    // ══════════════════ 基础 UI 辅助 ══════════════════
    private fun dp(v: Number): Int = (v.toFloat() * resources.displayMetrics.density).toInt()

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
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

    private fun platformLabelLocal(p: String?): String = when (p) {
        "yangkeduo", "pdd" -> "拼多多"
        "1688", "ali1688" -> "1688"
        "taobao" -> "淘宝"
        "xianyu" -> "闲鱼"
        "other" -> "手工(其他)"
        else -> p ?: "—"
    }

    /** 白底圆角卡片容器 */
    private fun card(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor(COLOR_CARD))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10) }
        }
    }

    private fun sectionTitle(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 15f
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, 0, 0, dp(8))
        }
    }

    private fun mutedText(text: String, size: Float = 11f): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = size
            setPadding(0, dp(4), 0, 0)
        }
    }

    private fun chip(text: String, bg: String, fg: String, textSize: Float = 10f): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor(fg))
            this.textSize = textSize
            setRoundedBg(Color.parseColor(bg), 6f)
            setPadding(dp(6), dp(2), dp(6), dp(2))
        }
    }

    /** 底部操作按钮（等宽） */
    private fun actionButton(
        text: String,
        bgColor: String,
        textColor: String = "#ffffff",
        enabled: Boolean = true,
        onClick: () -> Unit,
    ): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor(textColor))
            textSize = 15f
            gravity = Gravity.CENTER
            setRoundedBg(Color.parseColor(bgColor), 10f)
            setPadding(dp(16), dp(13), dp(16), dp(13))
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(6)
                rightMargin = dp(6)
            }
            layoutParams = lp
            isEnabled = enabled
            alpha = if (enabled) 1f else 0.5f
            setOnClickListener { if (enabled) onClick() }
        }
    }

    /** 步骤条：已完成可点回退，当前高亮 */
    private fun renderStepBar() {
        purchaseStepBar.removeAllViews()
        val names = listOf("采购管理", "选平台订单", "分摊确认")
        val idx = when (step) {
            "manage" -> 0
            "select" -> 1
            else -> 2
        }
        for (i in names.indices) {
            val dot = TextView(this).apply {
                text = if (idx > i) "✓" else "${i + 1}"
                gravity = Gravity.CENTER
                textSize = 11f
                setTextColor(
                    if (idx == i) Color.WHITE
                    else if (idx > i) Color.parseColor(COLOR_PRIMARY)
                    else Color.parseColor(COLOR_MUTE)
                )
                setRoundedBg(
                    if (idx == i) Color.parseColor(COLOR_PRIMARY)
                    else if (idx > i) Color.parseColor("#e8f3ff")
                    else Color.parseColor("#eef0f4"),
                    50f
                )
            }
            val label = TextView(this).apply {
                text = names[i]
                textSize = 12f
                setTextColor(
                    if (idx >= i) Color.parseColor(COLOR_PRIMARY) else Color.parseColor(COLOR_MUTE)
                )
                if (idx == i) setTypeface(null, android.graphics.Typeface.BOLD)
                setPadding(dp(4), 0, 0, 0)
            }
            val box = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            box.addView(dot, LinearLayout.LayoutParams(dp(26), dp(26)))
            box.addView(label)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { if (i > 0) leftMargin = dp(10) }
            box.setOnClickListener {
                when (i) {
                    0 -> if (idx > 0) showManage()
                    1 -> if (idx == 2) showSelect()
                }
            }
            purchaseStepBar.addView(box, lp)
            if (i < names.size - 1) {
                val line = View(this)
                line.background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(if (idx > i) Color.parseColor(COLOR_PRIMARY) else Color.parseColor("#eef0f4"))
                }
                purchaseStepBar.addView(
                    line,
                    LinearLayout.LayoutParams(0, dp(3), 1f).apply {
                        leftMargin = dp(8)
                        rightMargin = dp(8)
                    }
                )
            }
        }
    }

    private fun renderBottomBar() {
        when (step) {
            "manage" -> renderManageBottom()
            "select" -> renderSelectBottom()
            "confirm" -> renderConfirmBottom()
        }
    }

    // ══════════════════ 采购管理视图 ══════════════════

    /** 行级 link 按 purchaseOrderId 分组成"已有采购单"（与 H5 groups 同构） */
    private fun groups(): List<Group> {
        val byPo = LinkedHashMap<String, MutableList<PurchaseLink>>()
        for (l in links) {
            val key = l.purchaseOrderId ?: l.id
            byPo.getOrPut(key) { mutableListOf() }.add(l)
        }
        return byPo.values.map { ls ->
            val first = ls[0]
            Group(
                purchaseOrderId = first.purchaseOrderId ?: first.id,
                platform = first.platform,
                purchaseSn = first.purchaseSn,
                poStatus = first.poStatus,
                allocated = ls.sumOf { it.allocatedAmount ?: 0.0 },
                buyerAccount = first.buyerAccount,
                sellerName = first.sellerName,
                items = first.items ?: emptyList(),
                poLogisticsNo = first.poLogisticsNo,
                poLogisticsCompany = first.poLogisticsCompany,
            )
        }
    }

    /** 已有采购单的 SN 键集合（平台列表里标记"已关联"并禁止重复勾选） */
    private fun restoredSnKeys(): Set<String> {
        val s = HashSet<String>()
        for (g in groups()) {
            for (part in (g.purchaseSn ?: "").split(",")) {
                val p = part.trim()
                if (p.isNotEmpty()) s.add("${platformValOf(g.platform)}:$p")
            }
        }
        return s
    }

    private fun platformValOf(platform: String?): String = when (platform?.lowercase()) {
        "pdd", "yangkeduo", "拼多多" -> "yangkeduo"
        "1688", "ali1688" -> "1688"
        "taobao", "淘宝" -> "taobao"
        "xianyu" -> "xianyu"
        else -> "other"
    }

    private fun isRestoredLinked(o: PlatformOrder): Boolean {
        return restoredSnKeys().contains("${o.platformVal}:${o.orderSn}")
    }

    /** 未删除已有采购按产品行分摊合计（安卓无 ozonOrderItemId，按商品数量比例近似分摊） */
    private fun keptAllocByItem(): Map<String, Double> {
        val map = HashMap<String, Double>()
        val totalQty = items.sumOf { it.quantity ?: 0.0 }
        if (totalQty <= 0) return map
        for (l in links) {
            if (pendingRemoves.contains(l.purchaseOrderId ?: l.id)) continue
            val amt = l.allocatedAmount ?: 0.0
            for (it in items) {
                val qty = it.quantity ?: 0.0
                if (qty <= 0) continue
                val key = it.id ?: it.itemId ?: continue
                map[key] = (map[key] ?: 0.0) + amt * qty / totalQty
            }
        }
        return map
    }

    /** 管理视图每行分摊口径：有待新增时用"将保存"金额，否则用未删除已有分摊 */
    private fun itemAllocForManage(): Map<String, Double> {
        val kept = keptAllocByItem()
        val add = pendingAdd
        if (add == null) return kept
        val map = HashMap<String, Double>()
        for (arg in add.items) {
            val id = arg.itemId ?: continue
            map[id] = (map[id] ?: 0.0) + arg.amount
        }
        for ((k, v) in kept) if (!map.containsKey(k)) map[k] = v
        return map
    }

    /** 按当前步骤重渲染（单价调整数据异步加载完成后刷新当前页） */
    private fun rerenderCurrent() {
        if (step == "confirm") renderConfirm() else renderManage()
    }

    private fun renderManage() {
        renderStepBar()
        purchaseContent.removeAllViews()
        val p = pkg ?: return

        // 包裹摘要卡
        val summary = card()
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val store = chip(p.storeName ?: "包裹", "#eef4ff", COLOR_PRIMARY, 11f)
        head.addView(store)
        val posting = TextView(this).apply {
            text = p.postingNumber ?: p.id
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 13f
            typeface = android.graphics.Typeface.MONOSPACE
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(8)
            }
        }
        head.addView(posting)
        summary.addView(head)
        val sub = mutedText(
            "${items.size} 个商品行 · 采购合计 ${fmtMoney(p.totalPurchaseAmount)}",
            12f
        )
        summary.addView(sub)
        purchaseContent.addView(summary)

        // 已有采购卡
        val poCard = card()
        poCard.addView(sectionTitle("已有采购(${groups().size})"))
        if (groups().isEmpty() && pendingAdd == null) {
            poCard.addView(mutedText("尚无采购关联,可从平台订单选择新增"))
        } else {
            for (g in groups()) poCard.addView(buildGroupCard(g))
        }
        purchaseContent.addView(poCard)

        // 商品与分摊卡
        val allocCard = card()
        allocCard.addView(sectionTitle("商品与分摊"))
        val allocMap = itemAllocForManage()
        var totalAlloc = 0.0
        var totalProfit = 0.0
        for (it in items) {
            val alloc = allocMap[it.id ?: it.itemId] ?: 0.0
            totalAlloc += alloc
            val qty = it.quantity ?: 0.0
            val unitCost = if (qty > 0) alloc / qty else 0.0
            if (it.price != null && unitCost > 0) {
                totalProfit += (it.price!! * 0.84 - unitCost) * qty
            }
            allocCard.addView(buildAllocRow(it, alloc))
            // 单价调整折叠区（与分摊确认页一致：编辑已有采购时同样可调价）
            allocCard.addView(buildPriceAdjust(it, unitCost))
        }
        val totalLine = TextView(this).apply {
            text = "采购合计 ${fmtMoney(totalAlloc)} · 预估利润 ${fmtMoney(totalProfit)}"
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 12f
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, dp(8), 0, 0)
        }
        allocCard.addView(totalLine)
        purchaseContent.addView(allocCard)

        // 待新增采购卡
        pendingAdd?.let { add ->
            val addCard = card()
            addCard.addView(sectionTitle("待新增采购"))
            for (od in add.orders) {
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(4), 0, 0)
                }
                row.addView(chip(platformLabelLocal(add.platform), "#eef4ff", COLOR_PRIMARY))
                val sn = TextView(this).apply {
                    text = od.purchaseSn
                    setTextColor(Color.parseColor(COLOR_TEXT))
                    textSize = 11f
                    typeface = android.graphics.Typeface.MONOSPACE
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                        leftMargin = dp(8)
                    }
                }
                row.addView(sn)
                val amt = TextView(this).apply {
                    text = fmtMoney(od.paymentAmount)
                    setTextColor(Color.parseColor(COLOR_DANGER))
                    textSize = 11f
                }
                row.addView(amt)
                addCard.addView(row)
            }
            val meta = mutedText(
                if (add.orders.size > 1) "合计 ${fmtMoney(add.paymentAmount)} · 自动 · 按数量分摊" else "自动 · 按数量分摊",
                11f
            )
            addCard.addView(meta)
            val removeBtn = TextView(this).apply {
                text = "移除"
                setTextColor(Color.parseColor(COLOR_DANGER))
                textSize = 12f
                gravity = Gravity.CENTER
                setRoundedBg(Color.parseColor("#ffece8"), 6f)
                setPadding(dp(16), dp(8), dp(16), dp(8))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(8) }
                setOnClickListener {
                    pendingAdd = null
                    renderManage()
                }
            }
            addCard.addView(removeBtn)
            purchaseContent.addView(addCard)
        }

        // 从平台订单选择入口
        val entryCard = card()
        val entry = TextView(this).apply {
            text = "+ 从平台订单选择"
            textSize = 14f
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor(COLOR_PRIMARY))
            setPadding(0, dp(14), 0, dp(14))
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.parseColor("#f0f5ff"))
                cornerRadius = dp(8).toFloat()
                setStroke(dp(1), Color.parseColor("#a8ccff"))
            }
            setOnClickListener { showSelect() }
        }
        entryCard.addView(entry)
        entryCard.addView(
            mutedText("订单金额可手改:勾选订单后直接改金额,各包裹/SKU 分摊仍按数量自动加权。", 10f)
        )
        purchaseContent.addView(entryCard)

        renderBottomBar()
    }

    private fun buildGroupCard(g: Group): View {
        val removing = pendingRemoves.contains(g.purchaseOrderId)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#fafafa"))
            setPadding(dp(10), dp(8), dp(10), dp(8))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
            alpha = if (removing) 0.55f else 1f
        }

        // 头：平台 + 单号 + 状态
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(chip(platformLabelLocal(g.platform), "#f5efff", "#7d4dd3"))
        val sn = TextView(this).apply {
            text = g.purchaseSn ?: "#${g.purchaseOrderId}"
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(8)
            }
        }
        head.addView(sn)
        val status = TextView(this).apply {
            text = poStatusLabel(g.poStatus)
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 10f
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(6) }
        }
        head.addView(status)
        card.addView(head)

        // 分摊 / 买家
        val meta = TextView(this).apply {
            text = buildString {
                append("分摊 ").append(fmtMoney(g.allocated))
                if (!g.sellerName.isNullOrBlank()) append("  ·  ").append(g.sellerName)
                if (!g.buyerAccount.isNullOrBlank()) append("  ·  买:").append(g.buyerAccount)
            }
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 10f
            setPadding(0, dp(4), 0, 0)
        }
        card.addView(meta)

        // 采购商品
        for (pi in g.items) {
            card.addView(buildPurchaseGoodsRow(pi))
        }

        // 物流行
        val logiRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, 0)
        }
        if (!g.poLogisticsNo.isNullOrBlank()) {
            val logi = TextView(this).apply {
                text = "${g.poLogisticsCompany ?: ""} ${g.poLogisticsNo}".trim()
                setTextColor(Color.parseColor(COLOR_TEXT))
                textSize = 10f
                setRoundedBg(Color.parseColor("#f2f3f5"), 6f)
                setPadding(dp(8), dp(5), dp(8), dp(5))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener { copyText(g.poLogisticsNo!!, "快递单号") }
            }
            logiRow.addView(logi)
        } else {
            val empty = TextView(this).apply {
                text = "未录物流单号"
                setTextColor(Color.parseColor(COLOR_PLACEHOLDER))
                textSize = 10f
                setRoundedBg(Color.parseColor("#f2f3f5"), 6f)
                setPadding(dp(8), dp(5), dp(8), dp(5))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            logiRow.addView(empty)
        }
        val logiBtn = miniButton(if (g.poLogisticsNo.isNullOrBlank()) "录入" else "修改", "#eef4ff", COLOR_PRIMARY) {
            showLogiDialog(g)
        }
        logiRow.addView(logiBtn)
        card.addView(logiRow)

        // 删除/恢复
        val actionRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setPadding(0, dp(6), 0, 0)
        }
        actionRow.addView(
            miniButton(if (removing) "恢复" else "删除", if (removing) "#eef4ff" else "#ffece8", if (removing) COLOR_PRIMARY else COLOR_DANGER) {
                if (removing) pendingRemoves.remove(g.purchaseOrderId)
                else pendingRemoves.add(g.purchaseOrderId)
                renderManage()
            }
        )
        card.addView(actionRow)
        return card
    }

    private fun miniButton(text: String, bg: String, fg: String, onClick: () -> Unit): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor(fg))
            textSize = 11f
            gravity = Gravity.CENTER
            setRoundedBg(Color.parseColor(bg), 6f)
            setPadding(dp(12), dp(6), dp(12), dp(6))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(6) }
            setOnClickListener { onClick() }
        }
    }

    private fun buildPurchaseGoodsRow(pi: PurchaseItem): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) }
        }
        val img = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(Color.parseColor("#f2f3f5"))
            }
            clipToOutline = true
        }
        val pic = pi.thumbUrl ?: pi.picUrl
        if (!pic.isNullOrBlank()) img.load(pic)
        img.setOnClickListener { showImagePreview(pic) }
        row.addView(img)

        val right = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(8)
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

    private fun buildAllocRow(it: PkgItem, alloc: Double): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        }
        val img = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(56), dp(56))
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(Color.parseColor("#f2f3f5"))
            }
            clipToOutline = true
        }
        val pic = it.picUrl
        if (!pic.isNullOrBlank()) img.load(pic)
        img.setOnClickListener { showImagePreview(pic) }
        row.addView(img)

        val right = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(8)
            }
        }
        val title = TextView(this).apply {
            text = it.title ?: "—"
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 12f
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        right.addView(title)
        val qty = it.quantity ?: 0.0
        val unitCost = if (qty > 0) alloc / qty else 0.0
        val gross = if (it.price != null && unitCost > 0) it.price!! * 0.84 - unitCost else null
        val line = TextView(this).apply {
            text = buildString {
                append("SKU ").append(it.sku ?: "—")
                append(" · ×").append(fmtNum(qty))
                append("  分摊 ").append(fmtMoney(alloc))
                append("  采购/件 ").append(fmtMoney(unitCost))
                if (gross != null) append("  毛利/件 ").append(fmtMoney(gross))
            }
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 10f
            setPadding(0, dp(4), 0, 0)
        }
        right.addView(line)
        row.addView(right)
        return row
    }

    /** 已有采购单录入/修改国内物流单号（即时生效） */
    private fun showLogiDialog(g: Group) {
        val noInput = EditText(this).apply {
            setText(g.poLogisticsNo ?: "")
            hint = "必填,多个用英文逗号分隔"
            inputType = InputType.TYPE_CLASS_TEXT
            textSize = 14f
        }
        var company = g.poLogisticsCompany ?: ""
        val companyTv = TextView(this).apply {
            text = if (company.isEmpty()) "选填,点击选择" else company
            setTextColor(if (company.isEmpty()) Color.parseColor(COLOR_PLACEHOLDER) else Color.parseColor(COLOR_TEXT))
            textSize = 14f
            setPadding(dp(10), dp(10), dp(10), dp(10))
            setBackgroundColor(Color.parseColor("#f2f3f5"))
            gravity = Gravity.CENTER_VERTICAL
        }
        companyTv.setOnClickListener {
            AlertDialog.Builder(this@PurchaseActivity)
                .setTitle("快递公司")
                .setItems(LOGI_COMPANY_RANGE.toTypedArray()) { _, which ->
                    company = if (which == 0) "" else LOGI_COMPANY_RANGE[which]
                    companyTv.text = if (company.isEmpty()) "选填,点击选择" else company
                    companyTv.setTextColor(
                        if (company.isEmpty()) Color.parseColor(COLOR_PLACEHOLDER) else Color.parseColor(COLOR_TEXT)
                    )
                }
                .show()
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
        }
        container.addView(noInput)
        container.addView(
            companyTv,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
        )
        AlertDialog.Builder(this)
            .setTitle("物流单号 - ${g.purchaseSn ?: "#${g.purchaseOrderId}"}")
            .setView(container)
            .setPositiveButton("保存") { _, _ ->
                saveLogi(g, noInput.text.toString().trim(), company.trim())
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun saveLogi(g: Group, no: String, company: String) {
        if (no.isBlank()) {
            toast("请填写物流单号")
            return
        }
        lifecycleScope.launch {
            try {
                Api.post(
                    "/admin/api/order-process/purchase-logistics",
                    mapOf(
                        "purchaseOrderId" to g.purchaseOrderId,
                        "logisticsNo" to no,
                        "logisticsCompany" to company
                    )
                )
                toast("物流单号已保存")
                loadDetail()
            } catch (e: Exception) {
                handleError(e)
            }
        }
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

    private fun canShipAfterSave(): Boolean {
        val p = pkg ?: return false
        return (p.operateStatus == "wait_process" || p.operateStatus == "wait_ship") &&
            p.ozonStatus == "awaiting_packaging"
    }

    private fun dirty(): Boolean = pendingRemoves.isNotEmpty() || pendingAdd != null

    private fun renderManageBottom() {
        purchaseActionBar.removeAllViews()
        val d = dirty() && !saving
        purchaseActionBar.addView(
            actionButton("保 存", "#f2f3f5", COLOR_TEXT, enabled = d) { doSave(false) }
        )
        purchaseActionBar.addView(
            actionButton("保存并备货", COLOR_PRIMARY, "#ffffff", enabled = d && canShipAfterSave()) { doSave(true) }
        )
    }

    // ══════════════════ 选平台订单视图 ══════════════════

    private fun storeFor(key: String): PlatformStore = stores.getOrPut(key) { PlatformStore() }
    private fun curStore(): PlatformStore = storeFor(activeTabKey)
    private fun curTabDef(): PlatformTab? = platTabs.find { it.key == activeTabKey }

    private fun curPlatLogin(): String {
        val d = curTabDef() ?: return "unknown"
        return platLogin["${d.platform}:${d.account}"] ?: "unknown"
    }

    /** 加载平台账号登录态并构建 tabs（失败时保留默认兜底 tabs） */
    private fun loadPlatformStatus() {
        lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/platform-orders/status").asJsonObject
                val platforms = data.get("platforms")?.asJsonObject ?: return@launch
                val meta = linkedMapOf(
                    "pdd" to ("yangkeduo" to "拼多多"),
                    "ali1688" to ("1688" to "1688"),
                    "taobao" to ("taobao" to "淘宝"),
                    "xianyu" to ("xianyu" to "闲鱼")
                )
                val newTabs = mutableListOf<PlatformTab>()
                for ((platform, m) in meta) {
                    val pObj = platforms.get(platform)?.asJsonObject ?: continue
                    val accountsObj = pObj.get("accounts")?.asJsonObject ?: continue
                    val accounts = accountsObj.keySet().toList()
                    if (accounts.isEmpty()) continue
                    val multi = accounts.size > 1
                    for (acct in accounts) {
                        val prefix = if (platform == "ali1688") "ali" else platform
                        newTabs.add(
                            PlatformTab(
                                key = if (multi) "$prefix:$acct" else prefix,
                                platform = platform,
                                platformVal = m.first,
                                account = acct,
                                label = if (multi) "${m.second}·$acct" else m.second
                            )
                        )
                    }
                }
                if (newTabs.isNotEmpty()) {
                    platTabs.clear()
                    platTabs.addAll(newTabs)
                    if (platTabs.none { it.key == activeTabKey }) activeTabKey = platTabs.first().key
                }
                for (entry in platforms.entrySet()) {
                    val plat = entry.key
                    val info = entry.value
                    val accountsObj = info.asJsonObject.get("accounts")?.asJsonObject ?: continue
                    for (acctEntry in accountsObj.entrySet()) {
                        val acct = acctEntry.key
                        val v = acctEntry.value
                        val login = v.asJsonObject.optString("login", "unknown")
                        platLogin["$plat:$acct"] = login
                    }
                }
                if (step == "select") renderSelect()
            } catch (e: Exception) {
                // 静默:保留默认兜底 tabs
            }
        }
    }

    private fun renderSelectBottom() {
        purchaseActionBar.removeAllViews()
        val n = selCount()
        val total = selectedTotal()
        val info = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(6); rightMargin = dp(6) }
        }
        val nTv = TextView(this).apply {
            text = "已选 $n 单"
            textSize = 12f
            setTextColor(Color.parseColor(COLOR_TEXT))
        }
        val tTv = TextView(this).apply {
            text = "合计 ${fmtMoney(total)}"
            textSize = 12f
            setTextColor(Color.parseColor(COLOR_DANGER))
        }
        info.addView(nTv)
        info.addView(tTv)
        purchaseActionBar.addView(info)
        purchaseActionBar.addView(actionButton("返回", "#f2f3f5", COLOR_TEXT) { showManage() })
        purchaseActionBar.addView(actionButton("下一步", COLOR_PRIMARY, "#ffffff", enabled = n > 0) { goStep3() })
    }

    private fun renderSelect() {
        renderStepBar()
        purchaseContent.removeAllViews()
        if (platTabs.isEmpty()) {
            platTabs.addAll(defaultPlatformTabs())
            activeTabKey = platTabs.first().key
            loadPlatformStatus()
        }
        val st = curStore()
        val def = curTabDef()

        // 平台×账号 tabs
        val hScroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        val tabRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        for (t in platTabs) {
            val selected = t.key == activeTabKey
            val tv = TextView(this).apply {
                text = t.label
                textSize = 13f
                setTextColor(if (selected) Color.parseColor(COLOR_PRIMARY) else Color.parseColor(COLOR_TEXT))
                setTypeface(null, if (selected) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
                setPadding(dp(12), dp(8), dp(12), dp(8))
                setBackgroundColor(Color.parseColor(if (selected) "#e8f3ff" else "#f2f3f5"))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { rightMargin = dp(8) }
            }
            tv.setOnClickListener { switchPlatTab(t.key) }
            tabRow.addView(tv)
        }
        hScroll.addView(tabRow)
        purchaseContent.addView(hScroll)

        // 登录态警示
        if (def != null && curPlatLogin() != "yes") {
            val warn = TextView(this).apply {
                text = if (curPlatLogin() == "no") "⚠ 当前平台账号未登录,只能看到 30 天内本地缓存订单,请先登录对应平台"
                else "⚠ 登录态未知,仅能查看 30 天内本地缓存订单"
                textSize = 11f
                setTextColor(Color.parseColor(COLOR_WARN))
                setPadding(dp(10), dp(8), dp(10), dp(8))
                setBackgroundColor(Color.parseColor("#fff7e6"))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8) }
            }
            purchaseContent.addView(warn)
        }

        // 状态子 tab + 刷新
        val subRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val subTabBox = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        for ((key, label) in subTabs()) {
            val selected = st.tab == key
            val tv = TextView(this).apply {
                text = label
                textSize = 12f
                setTextColor(if (selected) Color.parseColor(COLOR_PRIMARY) else Color.parseColor(COLOR_MUTE))
                setTypeface(null, if (selected) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
                setPadding(dp(4), dp(4), dp(4), dp(4))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { rightMargin = dp(14) }
            }
            tv.setOnClickListener {
                if (st.tab != key) {
                    st.tab = key
                    st.orders.clear() // 清空旧状态订单,触发自动加载新状态列表
                    renderSelect()
                }
            }
            subTabBox.addView(tv)
        }
        subRow.addView(subTabBox, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val refreshTv = TextView(this).apply {
            text = "刷新"
            textSize = 12f
            setTextColor(Color.parseColor(COLOR_PRIMARY))
            setPadding(dp(6), dp(2), dp(6), dp(2))
            setOnClickListener { loadOrders(activeTabKey) }
        }
        subRow.addView(refreshTv)
        purchaseContent.addView(subRow)

        // 搜索框（跨账号精确搜单号）
        val searchRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(2), dp(6), dp(2), dp(6))
        }
        searchInput = EditText(this).apply {
            hint = "按采购单号精确搜索(跨账号)"
            textSize = 13f
            inputType = InputType.TYPE_CLASS_TEXT
            setTextColor(Color.parseColor(COLOR_TEXT))
            setHintTextColor(Color.parseColor(COLOR_PLACEHOLDER))
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                    doSearch()
                    true
                } else false
            }
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.parseColor("#f2f3f5"))
                cornerRadius = dp(8).toFloat()
                setStroke(dp(1), Color.parseColor("#e5e8ed"))
            }
            setPadding(dp(10), dp(8), dp(10), dp(8))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        searchRow.addView(searchInput)
        val clearTv = TextView(this).apply {
            text = "✕"
            textSize = 14f
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor(COLOR_MUTE))
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setOnClickListener { clearSearch() }
        }
        searchRow.addView(clearTv)
        purchaseContent.addView(searchRow)

        // 订单列表容器（仅重建此容器,避免整页重渲染丢滚动/输入焦点）
        orderListBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        purchaseContent.addView(orderListBox)

        renderOrderList()
        renderBottomBar()

        // H5 同口径:进入/切换时立即拉取订单(无数据且未在加载才自动加载,避免重复请求)
        if (st.orders.isEmpty() && !st.loading && st.error.isEmpty()) {
            loadOrders(activeTabKey)
        }
    }

    private fun switchPlatTab(key: String) {
        if (key == activeTabKey) return
        activeTabKey = key
        renderSelect()
    }

    private fun subTabs(): List<Pair<String, String>> {
        val p = curTabDef()?.platform ?: ""
        return when (p) {
            "pdd" -> listOf("all" to "全部", "unreceived" to "待收货")
            "xianyu" -> listOf("all" to "全部")
            else -> listOf("all" to "全部", "unshipped" to "待发货", "unreceived" to "待收货")
        }
    }

    private fun loadOrders(tabKey: String) {
        val def = platTabs.find { it.key == tabKey } ?: return
        val st = storeFor(tabKey)
        st.loading = true
        st.error = ""
        // 立即反馈加载态(H5 同口径:进入即拉取)
        renderOrderList()
        // H5 同口径:刷新时只保留已搜索命中单的选中
        val keepSn = st.searched.map { it.orderSn }.toSet()
        st.selected.retainAll(keepSn)
        lifecycleScope.launch {
            try {
                val data = Api.get(
                    "/admin/api/platform-orders/${def.platform}",
                    mapOf("tab" to st.tab, "size" to "30", "account" to def.account)
                ).asJsonObject
                val arr = data.get("orders")?.asJsonArray
                val list = mutableListOf<PlatformOrder>()
                if (arr != null) {
                    for (el in arr) {
                        list.add(parsePlatformOrder(el.asJsonObject, def.platformVal, def.account, fromSearch = false))
                    }
                }
                st.orders.clear()
                st.orders.addAll(list)
            } catch (e: Exception) {
                st.error = e.message ?: "获取订单失败"
                st.orders.clear()
            } finally {
                st.loading = false
                renderOrderList()
                renderBottomBar()
            }
        }
    }

    private fun doSearch() {
        val kw = searchInput.text.toString().trim()
        if (kw.isBlank()) return
        val def = curTabDef() ?: return
        val st = curStore()
        st.loading = true
        st.error = ""
        renderOrderList()
        lifecycleScope.launch {
            try {
                val data = Api.get(
                    "/admin/api/platform-orders/${def.platform}/search",
                    mapOf("orderSn" to kw, "account" to def.account)
                ).asJsonObject
                val res = data.get("result")
                if (res != null && !res.isJsonNull) {
                    st.searched.clear()
                    st.searched.add(parsePlatformOrder(res.asJsonObject, def.platformVal, def.account, fromSearch = true))
                } else {
                    toast("未找到该采购单号")
                }
            } catch (e: Exception) {
                toast(e.message ?: "搜索失败")
            } finally {
                st.loading = false
                renderOrderList()
            }
        }
    }

    private fun clearSearch() {
        val st = curStore()
        if (st.searched.isNotEmpty()) {
            st.searched.clear()
            renderOrderList()
        }
        searchInput.setText("")
    }

    private fun parsePlatformOrder(obj: JsonObject, platformVal: String, account: String?, fromSearch: Boolean): PlatformOrder {
        val amount = if (fromSearch) obj.optDouble("orderAmount", obj.optDouble("amount", 0.0))
        else obj.optDouble("amount")
        val paidAmount = if (obj.has("paidAmount") && !obj.get("paidAmount").isJsonNull) obj.optDouble("paidAmount") else null
        val discountAmount = if (obj.has("discountAmount") && !obj.get("discountAmount").isJsonNull) obj.optDouble("discountAmount") else null
        val goods = parseGoods(obj.get("goods"))
        val promotions = mutableListOf<PlatformPromotion>()
        val promoEl = obj.get("promotions")
        if (promoEl != null && promoEl.isJsonArray) {
            for (el in promoEl.asJsonArray) {
                val po = el.asJsonObject
                promotions.add(
                    PlatformPromotion(
                        description = po.optString("description"),
                        amount = po.optDouble("amount"),
                        checked = true,
                        lazy = po.optBoolean("lazy")
                    )
                )
            }
        } else if (!fromSearch && (platformVal == "yangkeduo" || platformVal == "1688") && (discountAmount ?: 0.0) > 0) {
            // 列表单后端未回传明细时,用优惠合计构造 lazy 伪条目,勾选后拉官方明细替换
            promotions.add(
                PlatformPromotion(
                    description = "优惠合计",
                    amount = discountAmount ?: 0.0,
                    checked = true,
                    lazy = true
                )
            )
        }
        return PlatformOrder(
            orderSn = obj.optString("orderSn"),
            amount = amount,
            paidAmount = paidAmount,
            discountAmount = discountAmount,
            trackingNumber = obj.optString("trackingNumber"),
            logisticsCompany = obj.optString("logisticsCompany"),
            orderTime = obj.optString("orderTime"),
            mallName = obj.optString("mallName"),
            sellerName = obj.optString("sellerName"),
            buyerUserId = obj.optString("buyerUserId"),
            buyerUsername = obj.optString("buyerUsername"),
            goods = goods,
            promotions = promotions,
            promotionNotes = parseStringArray(obj.get("promotionNotes")),
            account = account,
            platformVal = platformVal,
        )
    }

    private fun parseGoods(el: JsonElement?): List<PlatformOrderGoods> {
        if (el == null || !el.isJsonArray) return emptyList()
        val list = mutableListOf<PlatformOrderGoods>()
        for (g in el.asJsonArray) {
            val o = g.asJsonObject
            list.add(
                PlatformOrderGoods(
                    goodsName = o.optString("goodsName"),
                    goodsId = o.optString("goodsId"),
                    spec = o.optString("spec"),
                    price = if (o.has("price") && !o.get("price").isJsonNull) o.optDouble("price") else null,
                    number = if (o.has("number") && !o.get("number").isJsonNull) o.optDouble("number") else null,
                    thumbUrl = o.optString("thumbUrl")
                )
            )
        }
        return list
    }

    private fun parseStringArray(el: JsonElement?): List<String> {
        if (el == null || !el.isJsonArray) return emptyList()
        return el.asJsonArray.mapNotNull { if (it.isJsonNull) null else it.asString }
    }

    private fun renderOrderList() {
        if (!::orderListBox.isInitialized) return
        orderListBox.removeAllViews()
        val st = curStore()
        if (st.loading) {
            orderListBox.addView(
                TextView(this).apply {
                    text = "加载中..."
                    textSize = 12f
                    setTextColor(Color.parseColor(COLOR_MUTE))
                    gravity = Gravity.CENTER
                    setPadding(0, dp(24), 0, dp(24))
                }
            )
            return
        }
        if (st.error.isNotEmpty()) {
            orderListBox.addView(
                TextView(this).apply {
                    text = st.error
                    textSize = 12f
                    setTextColor(Color.parseColor(COLOR_DANGER))
                    gravity = Gravity.CENTER
                    setPadding(0, dp(24), 0, dp(24))
                }
            )
            return
        }
        val orders = impOrders()
        if (orders.isEmpty()) {
            orderListBox.addView(
                TextView(this).apply {
                    text = "暂无订单"
                    textSize = 12f
                    setTextColor(Color.parseColor(COLOR_MUTE))
                    gravity = Gravity.CENTER
                    setPadding(0, dp(24), 0, dp(24))
                }
            )
            return
        }
        for (o in orders) orderListBox.addView(buildOrderRow(o))
    }

    private fun impOrders(): List<PlatformOrder> {
        val st = curStore()
        return if (st.searched.isNotEmpty()) st.searched else st.orders
    }

    private fun buildOrderRow(o: PlatformOrder): View {
        val st = curStore()
        val selected = st.selected.contains(o.orderSn)
        val restored = isRestoredLinked(o)
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setBackgroundColor(if (selected) Color.parseColor("#f0f7ff") else Color.parseColor(COLOR_CARD))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(6) }
            alpha = if (restored) 0.6f else 1f
        }
        // 勾选
        val cb = TextView(this).apply {
            text = if (selected) "☑" else "☐"
            textSize = 18f
            setTextColor(Color.parseColor(if (selected) COLOR_PRIMARY else "#c0c4cc"))
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(30), ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) }
        }
        row.addView(cb)
        // 商品图
        val img = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(56), dp(56))
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(Color.parseColor("#f2f3f5"))
            }
            clipToOutline = true
        }
        val thumb = o.goods.firstOrNull()?.thumbUrl
        if (!thumb.isNullOrBlank()) img.load(thumb)
        img.setOnClickListener { showImagePreview(thumb) }
        row.addView(img)
        // 右侧
        val right = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(8) }
        }
        val title = TextView(this).apply {
            text = firstGoodsName(o)
            textSize = 12f
            setTextColor(Color.parseColor(COLOR_TEXT))
            maxLines = 1
        }
        right.addView(title)
        // 金额（勾选后可手改）
        val amtRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(2), 0, 0)
        }
        if (selected && !restored) {
            val et = EditText(this).apply {
                setText(amountTexts[o.orderSn] ?: fmtPlain(realtimeOrderAmount(o.platformVal, o.orderSn, o.amount)))
                inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
                textSize = 13f
                setTextColor(Color.parseColor(COLOR_DANGER))
                setSelectAllOnFocus(true)
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.WHITE)
                    cornerRadius = dp(6).toFloat()
                    setStroke(dp(1), Color.parseColor("#d8dce3"))
                }
                setPadding(dp(6), dp(4), dp(6), dp(4))
                layoutParams = LinearLayout.LayoutParams(dp(120), ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            // 先 setText 再注册监听,避免程序设值触发"手改"标记
            et.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    val raw = s?.toString() ?: ""
                    val src = findSourceOrder(o.platformVal, o.orderSn)
                    if (src != null) {
                        src.amount = raw.toDoubleOrNull() ?: 0.0
                        src.amountManual = true
                    }
                    amountTexts[o.orderSn] = raw
                    renderBottomBar()
                }
            })
            amtRow.addView(et)
        } else {
            val amt = TextView(this).apply {
                text = fmtMoney(realtimeOrderAmount(o.platformVal, o.orderSn, o.amount))
                textSize = 13f
                setTextColor(Color.parseColor(COLOR_DANGER))
                setTypeface(null, android.graphics.Typeface.BOLD)
            }
            amtRow.addView(amt)
        }
        val time = TextView(this).apply {
            text = "  ${fmtOrderTime(o)}"
            textSize = 10f
            setTextColor(Color.parseColor(COLOR_MUTE))
        }
        amtRow.addView(time)
        right.addView(amtRow)
        // 单号 + 物流
        val snLine = TextView(this).apply {
            text = buildString {
                append(o.orderSn)
                if (!o.trackingNumber.isNullOrBlank()) append("  📦").append(o.trackingNumber)
            }
            textSize = 10f
            typeface = android.graphics.Typeface.MONOSPACE
            setTextColor(Color.parseColor(COLOR_MUTE))
            setPadding(0, dp(2), 0, 0)
        }
        right.addView(snLine)
        // 优惠明细（勾选后展示,可勾选/取消）
        if (selected && !restored && (o.platformVal == "yangkeduo" || o.platformVal == "1688")) {
            if (o.promoLoading) {
                right.addView(mutedText("优惠明细加载中...", 10f))
            } else if (o.promotions.isNotEmpty()) {
                for ((i, p) in o.promotions.withIndex()) {
                    val promoRow = LinearLayout(this).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(0, dp(2), 0, 0)
                    }
                    val pv = TextView(this).apply {
                        text = "${if (p.checked) "☑" else "☐"} ${p.description}"
                        textSize = 10f
                        setTextColor(if (p.checked) Color.parseColor(COLOR_PRIMARY) else Color.parseColor(COLOR_MUTE))
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    }
                    promoRow.addView(pv)
                    val pav = TextView(this).apply {
                        text = "+${fmtPlain(p.amount)}"
                        textSize = 10f
                        setTextColor(Color.parseColor(COLOR_WARN))
                    }
                    promoRow.addView(pav)
                    promoRow.setOnClickListener { togglePromo(o, i) }
                    right.addView(promoRow)
                }
                if (o.promotionNotes.isNotEmpty()) {
                    right.addView(
                        TextView(this).apply {
                            text = "活动:${o.promotionNotes.joinToString(";")}"
                            textSize = 9f
                            setTextColor(Color.parseColor(COLOR_MUTE))
                            maxLines = 1
                        }
                    )
                }
            }
        }
        if (restored) {
            right.addView(mutedText("已关联本包裹,勿重复添加", 10f))
        }
        row.addView(right)
        if (restored) {
            row.setOnClickListener { toast("该单已关联本包裹") }
        } else {
            row.setOnClickListener { toggleSelect(o) }
        }
        return row
    }

    private fun firstGoodsName(o: PlatformOrder): String {
        val name = o.goods.firstOrNull()?.goodsName
        if (!name.isNullOrBlank()) {
            val more = if (o.goods.size > 1) " 等${fmtNum(o.goods.size.toDouble())}件商品" else ""
            return name + more
        }
        return o.orderSn
    }

    private fun fmtPlain(v: Double): String = String.format("%.2f", v)

    private fun fmtOrderTime(o: PlatformOrder): String {
        val t = o.orderTime
        if (t.isNullOrBlank()) return "—"
        if (o.platformVal == "yangkeduo") {
            val sec = t.toLongOrNull()
            if (sec != null) {
                return try {
                    val d = java.util.Date(sec * 1000)
                    java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.US).format(d) + weekdaySuffix(d)
                } catch (e: Exception) {
                    "—"
                }
            }
        }
        val base = t.replace("T", " ").take(16)
        return base + weekdaySuffix(parseTime(base))
    }

    /** 时间 → "（周X）"；解析失败返回空串（与 H5 weekdayCN 同口径） */
    private fun weekdaySuffix(d: java.util.Date?): String {
        if (d == null) return ""
        val wd = java.util.Calendar.getInstance().apply { time = d }.get(java.util.Calendar.DAY_OF_WEEK) - 1
        return "（周" + "日一二三四五六"[wd] + "）"
    }

    private fun parseTime(base: String): java.util.Date? = try {
        java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US).parse(base)
    } catch (e: Exception) {
        null
    }

    private fun toggleSelect(o: PlatformOrder) {
        if (isRestoredLinked(o)) return
        val st = curStore()
        if (st.selected.contains(o.orderSn)) {
            st.selected.remove(o.orderSn)
        } else {
            st.selected.add(o.orderSn)
            if (o.platformVal == "yangkeduo" || o.platformVal == "1688") {
                ensurePromoDetail(o)
            }
        }
        renderOrderList()
        renderBottomBar()
    }

    /** PDD/1688: 列表单勾选后拉官方优惠明细替换 lazy 伪条目（H5 ensurePromoDetail 同构） */
    private fun ensurePromoDetail(o: PlatformOrder) {
        if (promoDetailFetched.contains(o.orderSn)) return
        if (!o.promotions.any { it.lazy }) return
        promoDetailFetched.add(o.orderSn)
        o.promoLoading = true
        renderOrderList()
        val account = o.account
        lifecycleScope.launch {
            try {
                val path = if (o.platformVal == "1688")
                    "/admin/api/platform-orders/ali1688/promotions"
                else
                    "/admin/api/platform-orders/pdd/promotions"
                val data = Api.get(path, mapOf("orderSn" to o.orderSn, "account" to account)).asJsonObject
                val promos = data.get("promotions")?.asJsonArray
                val items = mutableListOf<PlatformPromotion>()
                if (promos != null) {
                    for (el in promos) {
                        val po = el.asJsonObject
                        items.add(
                            PlatformPromotion(
                                description = po.optString("description"),
                                amount = po.optDouble("amount"),
                                checked = true,
                                lazy = false
                            )
                        )
                    }
                }
                if (items.isNotEmpty()) {
                    val keepOff = o.promotions.any { !it.checked }
                    o.promotions.clear()
                    o.promotions.addAll(items.map { it.copy(checked = !keepOff) })
                    o.promotionNotes = parseStringArray(data.get("promotionNotes"))
                    recalcAmount(o)
                }
            } catch (e: Exception) {
                // 拉取失败保留伪条目
            } finally {
                o.promoLoading = false
                recalcAmount(o)
                renderOrderList()
                renderBottomBar()
            }
        }
    }

    private fun togglePromo(o: PlatformOrder, idx: Int) {
        val p = o.promotions.getOrNull(idx) ?: return
        p.checked = !p.checked
        recalcAmount(o)
        renderOrderList()
        renderBottomBar()
    }

    private fun recalcAmount(src: PlatformOrder) {
        if (src.amountManual) return
        val base = src.paidAmount ?: src.amount
        val add = src.promotions.sumOf { if (it.checked) it.amount else 0.0 }
        src.amount = Math.round((base + add) * 100) / 100.0
    }

    private fun findSourceOrder(platformVal: String, orderSn: String): PlatformOrder? {
        for (t in platTabs) {
            if (t.platformVal != platformVal) continue
            val st = stores[t.key] ?: continue
            val src = (st.orders + st.searched).find { it.orderSn == orderSn }
            if (src != null) return src
        }
        return null
    }

    private fun realtimeOrderAmount(platformVal: String, orderSn: String, fallback: Double): Double {
        return findSourceOrder(platformVal, orderSn)?.amount ?: fallback
    }

    private fun selectedOrders(): List<PlatformOrder> {
        val sel = mutableListOf<PlatformOrder>()
        for (t in platTabs) {
            val st = stores[t.key] ?: continue
            val inList = st.orders.map { it.orderSn }.toSet()
            val merged = st.searched.filter { !inList.contains(it.orderSn) } + st.orders
            for (o in merged) {
                if (st.selected.contains(o.orderSn) && !isRestoredLinked(o)) {
                    sel.add(o.copy(account = o.account ?: t.account, platformVal = t.platformVal))
                }
            }
        }
        return sel
    }

    private fun selectedTotal(): Double = selectedOrders().sumOf { it.amount }

    private fun selCount(): Int = selectedOrders().size

    // ══════════════════ 分摊确认视图（Step3） ══════════════════

    /** 兜底平台 tabs（/status 成功时会被真实账号替换） */
    private fun defaultPlatformTabs(): List<PlatformTab> {
        return listOf(
            PlatformTab("pdd", "pdd", "yangkeduo", "linqx", "拼多多"),
            PlatformTab("ali:linqx", "ali1688", "1688", "linqx", "1688·linqx"),
            PlatformTab("taobao", "taobao", "taobao", "linqx", "淘宝"),
            PlatformTab("xianyu", "xianyu", "xianyu", "linqx", "闲鱼")
        )
    }

    private fun goStep3() {
        if (selCount() == 0) return
        step = "confirm"
        lookupResult = null
        val sel = selectedOrders()
        // 多单时用逗号拼接做 lookup（查不到则忽略）
        val sn = sel.joinToString(",") { it.orderSn }
        val platform = sel.firstOrNull()?.platformVal ?: "other"
        logisticsInput = sel.mapNotNull { it.trackingNumber }.distinct().joinToString(",")
        if (platform != "other" && sn.isNotBlank()) {
            lifecycleScope.launch {
                try {
                    val data = Api.get(
                        "/admin/api/order-process/purchase/lookup",
                        mapOf("platform" to platform, "purchaseSn" to sn)
                    ).asJsonObject
                    if (data.optBoolean("exists")) {
                        lookupResult = parseLookup(data)
                        renderConfirm()
                    }
                } catch (e: Exception) {
                    // 忽略
                }
            }
        }
        // 加载 SKU 定价信息（单价调整区用），完成后重渲染预览
        loadSkuPricing()
        renderConfirm()
    }

    private fun parseLookup(obj: JsonObject): LookupResult {
        val exists = obj.optBoolean("exists")
        val linked = mutableListOf<LookupLinkedPackage>()
        val arr = obj.get("linkedPackages")?.asJsonArray
        if (arr != null) {
            for (el in arr) {
                val o = el.asJsonObject
                linked.add(
                    LookupLinkedPackage(
                        packageNo = o.optString("package_no"),
                        postingNumber = o.optString("posting_number"),
                        quantity = o.optDouble("quantity"),
                        allocModes = o.optString("alloc_modes"),
                        allocatedAmount = o.optDouble("allocated_amount")
                    )
                )
            }
        }
        return LookupResult(exists, linked)
    }

    /** auto 加权预览：每行 = 未删除已有分摊 + 新订单合计按数量加权 */
    private fun autoPreview(): List<Pair<PkgItem, Double>> {
        val payment = selectedTotal()
        val currentQty = items.sumOf { it.quantity ?: 0.0 }
        val existingAutoQty = (lookupResult?.linkedPackages ?: emptyList())
            .filter { (it.allocModes ?: "").contains("auto") }
            .sumOf { it.quantity ?: 0.0 }
        val sumQty = currentQty + existingAutoQty
        val kept = keptAllocByItem()
        return items.map {
            it to (kept[it.id ?: it.itemId] ?: 0.0) + if (sumQty > 0) ((it.quantity ?: 0.0) * payment / sumQty) else 0.0
        }
    }

    private fun renderConfirm() {
        renderStepBar()
        purchaseContent.removeAllViews()
        val sel = selectedOrders()
        val total = selectedTotal()
        val platform = sel.firstOrNull()?.platformVal ?: "other"

        // 已选摘要
        val summary = card()
        summary.addView(sectionTitle("已选摘要"))
        val headLine = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        headLine.addView(chip(platformLabelLocal(platform), "#eef4ff", COLOR_PRIMARY, 11f))
        val cnt = TextView(this).apply {
            text = " 已选 ${sel.size} 单 · 合计 ${fmtMoney(total)}"
            textSize = 12f
            setTextColor(Color.parseColor(COLOR_TEXT))
        }
        headLine.addView(cnt)
        summary.addView(headLine)
        for (o in sel) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(4), 0, 0)
            }
            val snTv = TextView(this).apply {
                text = o.orderSn
                textSize = 10f
                typeface = android.graphics.Typeface.MONOSPACE
                setTextColor(Color.parseColor(COLOR_MUTE))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            row.addView(snTv)
            val amtTv = TextView(this).apply {
                text = fmtMoney(realtimeOrderAmount(o.platformVal, o.orderSn, o.amount))
                textSize = 11f
                setTextColor(Color.parseColor(COLOR_DANGER))
            }
            row.addView(amtTv)
            summary.addView(row)
        }
        lookupResult?.let { lr ->
            if (lr.exists && lr.linkedPackages.isNotEmpty()) {
                val tip = mutedText("拼单提示:该采购单已关联 ${lr.linkedPackages.size} 个包裹,保存后 auto 模式将按数量重新加权分摊。", 10f)
                tip.setPadding(dp(8), dp(6), dp(8), dp(6))
                tip.setBackgroundColor(Color.parseColor("#fff7e6"))
                summary.addView(tip)
            }
        }
        purchaseContent.addView(summary)

        // 自动分摊预览
        val previewCard = card()
        previewCard.addView(sectionTitle("自动分摊预览"))
        val tip = mutedText("各商品行金额 = 已有采购分摊 + 新订单 ${fmtMoney(total)} 按数量加权分摊(未删除已有分摊保持口径不变)", 10f)
        previewCard.addView(tip)
        for ((it, amt) in autoPreview()) {
            previewCard.addView(buildPreviewRow(it, amt))
        }
        val previewTotal = autoPreview().sumOf { it.second }
        previewCard.addView(buildProfitTotalLine(previewTotal))
        purchaseContent.addView(previewCard)

        // 国内快递单号（选填）
        val logiCard = card()
        logiCard.addView(sectionTitle("国内快递单号"))
        val logiHint = mutedText("选填:自动从订单物流号带出,多个用英文逗号分隔。", 10f)
        logiCard.addView(logiHint)
        val et = EditText(this).apply {
            setText(logisticsInput)
            hint = "多个用英文逗号分隔"
            textSize = 14f
            inputType = InputType.TYPE_CLASS_TEXT
        }
        et.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                logisticsInput = s?.toString()?.trim() ?: ""
            }
        })
        logiCard.addView(et)
        purchaseContent.addView(logiCard)

        renderBottomBar()
    }

    private fun buildPreviewRow(it: PkgItem, amt: Double): View {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(8) }
        }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val img = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = android.graphics.drawable.GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(Color.parseColor("#f2f3f5"))
            }
            clipToOutline = true
        }
        if (!it.picUrl.isNullOrBlank()) img.load(it.picUrl)
        row.addView(img)
        val right = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(8)
            }
        }
        right.addView(
            TextView(this).apply {
                text = it.title ?: "—"
                textSize = 11f
                setTextColor(Color.parseColor(COLOR_TEXT))
                maxLines = 1
            }
        )
        val unit = if ((it.quantity ?: 0.0) > 0) amt / it.quantity!! else 0.0
        right.addView(
            TextView(this).apply {
                text = "SKU ${it.sku ?: "—"} · ×${fmtNum(it.quantity ?: 0.0)} · 分摊 ${fmtMoney(amt)} · 采购/件 ${fmtMoney(unit)}"
                textSize = 10f
                setTextColor(Color.parseColor(COLOR_MUTE))
            }
        )
        row.addView(right)
        box.addView(row)
        // 单价调整折叠区（H5 同构：按目标成本利润率一键调价/取整）
        box.addView(buildPriceAdjust(it, unit))
        return box
    }

    /** 单价调整折叠区：默认收起；展开后可选目标率、一键调价/取整，并展示单件利润对比 */
    private fun buildPriceAdjust(it: PkgItem, unitCost: Double): View {
        val sku = it.sku ?: ""
        val info = skuPricing[sku]
        val unitDelivery = info?.let { poUnitDelivery(it.weightG) }
        val rate = poRateChoice[sku] ?: PM_DEFAULT_RATE
        val suggested = if (unitCost > 0 && unitDelivery != null) suggestedPrice(unitCost, rate, unitDelivery) else null
        val canAdjust = sku.isNotBlank() && unitCost > 0 && unitDelivery != null && info != null && info.inCache && info.hasProductId
        val canRoundUp = sku.isNotBlank() && info != null && info.inCache && info.hasProductId && info.price != null
        val missingWhy = when {
            sku.isBlank() -> "订单商品缺 SKU"
            unitCost <= 0 -> "分摊金额为 0"
            unitDelivery == null -> "SKU 未维护重量(价格管理)"
            info == null || !info.inCache -> "不在价格缓存(先在价格管理同步价格)"
            !info.hasProductId -> "商品缺少 product_id"
            else -> ""
        }

        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(4), dp(8), dp(4))
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.parseColor("#f7f9fc"))
                cornerRadius = dp(6).toFloat()
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) }
        }
        val expanded = sku.isNotBlank() && sku in poCmpExpanded

        // 折叠头
        val toggle = TextView(this).apply {
            text = if (expanded) "▾ 单价调整  调整的是该 SKU 上架价,只影响后续新订单"
            else "▸ 单价调整  调整的是该 SKU 上架价,只影响后续新订单"
            textSize = 11f
            setTextColor(Color.parseColor(if (expanded) COLOR_PRIMARY else COLOR_SECONDARY))
            setTypeface(null, if (expanded) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
            setPadding(0, dp(4), 0, dp(4))
        }
        toggle.setOnClickListener {
            if (sku.isNotBlank()) {
                if (expanded) poCmpExpanded.remove(sku) else poCmpExpanded.add(sku)
                rerenderCurrent()
            }
        }
        box.addView(toggle)

        if (expanded) {
            if (info == null) {
                box.addView(TextView(this).apply {
                    text = "定价信息加载中…"
                    textSize = 10f
                    setTextColor(Color.parseColor(COLOR_MUTE))
                    setPadding(0, dp(4), 0, 0)
                })
                return box
            }

            // 操作行：目标率 + 调价 + 取整
            val ops = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(6) }
            }
            val rateBtn = TextView(this).apply {
                text = "目标率 $rate% ▾"
                textSize = 11f
                setTextColor(Color.parseColor(if (canAdjust) COLOR_PRIMARY else COLOR_MUTE))
                setRoundedBg(Color.parseColor("#eef4ff"), 8f)
                setPadding(dp(8), dp(4), dp(8), dp(4))
            }
            rateBtn.setOnClickListener {
                if (!canAdjust) return@setOnClickListener
                val rates = PM_TARGET_RATES.map { "$it%" }.toTypedArray()
                AlertDialog.Builder(this)
                    .setTitle("目标成本利润率")
                    .setSingleChoiceItems(rates, PM_TARGET_RATES.indexOf(rate)) { d, which ->
                        poRateChoice[sku] = PM_TARGET_RATES[which]
                        d.dismiss()
                        rerenderCurrent()
                    }
                    .show()
            }
            ops.addView(rateBtn)
            val adjusting = adjustingSku == sku
            val adjustBtn = TextView(this).apply {
                text = if (adjusting) "调价中…" else "调价"
                textSize = 11f
                setTextColor(Color.parseColor("#ffffff"))
                setRoundedBg(Color.parseColor(if (canAdjust) "#165dff" else "#c0c4cc"), 8f)
                setPadding(dp(10), dp(4), dp(10), dp(4))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { leftMargin = dp(8) }
            }
            adjustBtn.setOnClickListener {
                if (!canAdjust || adjustingSku != null || suggested == null) return@setOnClickListener
                val cur = info.price
                val newPriceText = "¥${fmtPlain(suggested)}"
                val strikeText = "¥${fmtPlain(suggested * 2)}"
                AlertDialog.Builder(this)
                    .setTitle("调整 SKU $sku 的上架价格?")
                    .setMessage(
                        "现价 ${cur?.let { "¥${fmtPlain(it)}" } ?: "无"} → 新价 $newPriceText(目标成本利润率 $rate%,划线价将设为 $strikeText)\n" +
                            "将同步更新该 SKU 成本基准:采购价 ¥${fmtPlain(unitCost)}\n只影响后续新订单,已下单包裹价格不变"
                    )
                    .setPositiveButton("调整价格") { _, _ ->
                        lifecycleScope.launch { adjustSkuPrice(sku, unitCost, info, suggested) }
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
            ops.addView(adjustBtn)
            val roundBtn = TextView(this).apply {
                text = "取整"
                textSize = 11f
                setTextColor(Color.parseColor(COLOR_SECONDARY))
                setRoundedBg(Color.parseColor("#e5e8ed"), 8f)
                setPadding(dp(10), dp(4), dp(10), dp(4))
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { leftMargin = dp(8) }
            }
            roundBtn.setOnClickListener {
                if (!canRoundUp || adjustingSku != null) return@setOnClickListener
                val cur = info.price!!
                val rounded = Math.ceil(cur)
                if (rounded == cur) {
                    toast("当前上架价已是整数 ¥${fmtPlain(cur)},无需取整")
                    return@setOnClickListener
                }
                AlertDialog.Builder(this)
                    .setTitle("将 SKU $sku 的上架价向上取整?")
                    .setMessage(
                        "现价 ¥${fmtPlain(cur)} → 新价 ¥${fmtPlain(rounded)}(划线价将设为 ¥${fmtPlain(rounded * 2)})\n只影响后续新订单,已下单包裹价格不变"
                    )
                    .setPositiveButton("取整改价") { _, _ ->
                        lifecycleScope.launch { roundUpPrice(sku, cur) }
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
            ops.addView(roundBtn)
            box.addView(ops)

            // 单件口径对比表
            val oldPrice = info.price
            val oldCommission = oldPrice?.let { it * PM_COMMISSION_RATE }
            val newCommission = suggested?.let { it * PM_COMMISSION_RATE }
            val oldProfit = if (oldPrice != null && unitDelivery != null) round2(oldPrice * (1 - PM_COMMISSION_RATE) - unitDelivery - unitCost) else null
            val newProfit = if (suggested != null && unitDelivery != null) round2(suggested * (1 - PM_COMMISSION_RATE) - unitDelivery - unitCost) else null
            val oldRateC = if (oldProfit != null && unitCost > 0) oldProfit / unitCost else null
            val newRateC = if (newProfit != null && unitCost > 0) newProfit / unitCost else null
            box.addView(cmpRow("销售单价", oldPrice?.let { fmtPlain(it) } ?: "—", suggested?.let { fmtPlain(it) } ?: "—", suggested != null))
            box.addView(cmpRow("ozon佣金", oldCommission?.let { fmtPlain(it) } ?: "—", newCommission?.let { fmtPlain(it) } ?: "—", newCommission != null))
            box.addView(cmpRow("国际物流费${if (unitDelivery == null) "(未维护重量,未扣)" else ""}", unitDelivery?.let { fmtPlain(it) } ?: "—", "", false))
            box.addView(cmpRow("利润", oldProfit?.let { fmtPlain(it) } ?: "—", newProfit?.let { fmtPlain(it) } ?: "—", newProfit != null))
            box.addView(cmpRow("成本利润率", oldRateC?.let { "${ratePct(it)}%" } ?: "—", newRateC?.let { "${ratePct(it)}%" } ?: "—", newRateC != null))
            if (missingWhy.isNotEmpty()) {
                box.addView(TextView(this).apply {
                    text = missingWhy
                    textSize = 10f
                    setTextColor(Color.parseColor(COLOR_WARN))
                    setPadding(0, dp(4), 0, 0)
                })
            }
        }
        return box
    }

    /** 对比表行：label（左） 旧值（中） → 新值（右） */
    private fun cmpRow(label: String, oldV: String, newV: String, highlightNew: Boolean): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(3) }
        }
        val labelTv = TextView(this).apply {
            text = label
            textSize = 10f
            setTextColor(Color.parseColor(COLOR_MUTE))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        row.addView(labelTv)
        val oldTv = TextView(this).apply {
            text = oldV
            textSize = 10f
            setTextColor(Color.parseColor(COLOR_SECONDARY))
        }
        row.addView(oldTv)
        row.addView(TextView(this).apply {
            text = " → "
            textSize = 10f
            setTextColor(Color.parseColor(COLOR_MUTE))
        })
        val newTv = TextView(this).apply {
            text = newV
            textSize = 10f
            setTextColor(Color.parseColor(if (highlightNew) COLOR_PRIMARY else COLOR_SECONDARY))
            setTypeface(null, if (highlightNew) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
        }
        row.addView(newTv)
        return row
    }

    /** 单价调整合计行（H5 profitTotal 同构） */
    private fun buildProfitTotalLine(previewTotal: Double): View {
        var profit = 0.0
        var allWeighted = true
        for ((it, amt) in autoPreview()) {
            val qty = it.quantity ?: 0.0
            val unitCost = if (qty > 0) amt / qty else 0.0
            val info = it.sku?.let { sku -> skuPricing[sku] }
            val unitDelivery = info?.let { poUnitDelivery(it.weightG) }
            if (unitDelivery == null) allWeighted = false
            val revenue = (it.price ?: 0.0) * qty
            val delivery = unitDelivery?.let { it * qty } ?: 0.0
            profit += revenue * (1 - PM_COMMISSION_RATE) - delivery - amt
        }
        val rateC = if (previewTotal > 0) profit / previewTotal * 100 else null
        return TextView(this).apply {
            text = buildString {
                append("采购合计 ").append(fmtMoney(previewTotal))
                append(" · 预估利润合计 ").append(fmtMoney(profit))
                if (rateC != null) append(" · 成本利润率 ").append(String.format(Locale.US, "%.1f", rateC)).append("%")
                if (!allWeighted) append("(部分行未扣配送)")
            }
            textSize = 12f
            setTextColor(Color.parseColor(COLOR_TEXT))
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, dp(8), 0, 0)
        }
    }

    // ── 单价调整数据/动作（与 H5 adjustSkuPrice/roundUpPrice 同构） ──
    private fun poUnitDelivery(weightG: Double?): Double? {
        val w = weightG ?: return null
        if (w <= 0) return null
        return PM_DELIVERY_BASE_CNY + PM_DELIVERY_PER_G_CNY * w
    }

    private fun suggestedPrice(unitCost: Double, rate: Int, unitDelivery: Double): Double {
        return Math.ceil((unitCost * (1 + rate / 100.0) + unitDelivery) / (1 - PM_COMMISSION_RATE))
    }

    private fun round2(v: Double): Double = Math.round(v * 100) / 100.0

    private fun ratePct(v: Double): String = String.format(Locale.US, "%.1f", v * 100)

    /** 拉取 SKU 定价信息（skus-info），完成后重渲染预览区 */
    private fun loadSkuPricing() {
        val skus = items.mapNotNull { it.sku }.distinct().filter { it.isNotBlank() }
        if (skus.isEmpty()) return
        lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/price-manage/skus-info", mapOf("skus" to skus.joinToString(",")))
                val map = HashMap<String, SkuPriceInfo>()
                for (el in data.asJsonArray) {
                    val o = el.asJsonObject
                    map[o.optString("sku")] = SkuPriceInfo(
                        sku = o.optString("sku"),
                        inCache = o.optBoolean("inCache"),
                        price = if (o.has("price") && !o.get("price").isJsonNull) o.optDouble("price") else null,
                        hasProductId = o.optBoolean("hasProductId"),
                        weightG = if (o.has("weightG") && !o.get("weightG").isJsonNull) o.optDouble("weightG") else null
                    )
                }
                skuPricing.clear()
                skuPricing.putAll(map)
            } catch (e: Exception) {
                // 静默:调价区保持禁用
            } finally {
                // 当前在采购管理(manage)或分摊确认(confirm)时都重渲染,刷新单价调整区
                if (step == "manage" || step == "confirm") rerenderCurrent()
            }
        }
    }

    /** 一键调价：先同步成本基准(本单分摊单价)再按目标率改价（服务端复算校验） */
    private suspend fun adjustSkuPrice(sku: String, unitCost: Double, info: SkuPriceInfo, suggested: Double) {
        if (adjustingSku != null) return
        adjustingSku = sku
        try {
            Api.put("/admin/api/price-manage/sku/$sku", mapOf("purchasePrice" to round2(unitCost)))
            val rate = poRateChoice[sku] ?: PM_DEFAULT_RATE
            Api.post(
                "/admin/api/price-manage/price-update",
                mapOf("sku" to sku, "newPrice" to suggested, "targetRate" to rate / 100.0)
            )
            toast("改价已提交,30秒后自动回读校准")
        } catch (e: Exception) {
            toast(e.message ?: "调价失败")
        } finally {
            adjustingSku = null
            loadSkuPricing()
        }
    }

    /** 取整：将当前上架价向上取整到整数元（手动改价链路） */
    private suspend fun roundUpPrice(sku: String, cur: Double) {
        if (adjustingSku != null) return
        adjustingSku = sku
        try {
            Api.post("/admin/api/price-manage/price-update", mapOf("sku" to sku, "newPrice" to Math.ceil(cur)))
            toast("取整改价已提交,30秒后自动回读校准")
        } catch (e: Exception) {
            toast(e.message ?: "取整失败")
        } finally {
            adjustingSku = null
            loadSkuPricing()
        }
    }

    private fun renderConfirmBottom() {
        purchaseActionBar.removeAllViews()
        purchaseActionBar.addView(actionButton("返回", "#f2f3f5", COLOR_TEXT) { showSelect() })
        purchaseActionBar.addView(actionButton("确认", COLOR_PRIMARY, "#ffffff", enabled = !saving) { collectAdd() })
    }

    // ══════════════════ 保存逻辑 ══════════════════

    private fun collectAdd() {
        val sel = selectedOrders()
        if (sel.isEmpty()) return
        val preview = autoPreview()
        val itemsArg = preview.map { (it, amt) ->
            PurchaseItemArg(
                itemId = it.id ?: it.itemId,
                amount = Math.round(amt * 100) / 100.0,
                quantity = it.quantity ?: 0.0
            )
        }
        val single = sel.size == 1
        val orders = sel.map { o ->
            PendingPurchaseOrder(
                purchaseSn = o.orderSn,
                buyerAccount = o.account ?: o.buyerUsername,
                buyerUserId = o.buyerUserId,
                sellerName = o.mallName ?: o.sellerName,
                paymentAmount = realtimeOrderAmount(o.platformVal, o.orderSn, o.amount),
                logisticsCompany = o.logisticsCompany,
                logisticsNo = if (single) (logisticsInput.ifBlank { o.trackingNumber }) else o.trackingNumber,
                platformGoods = o.goods
            )
        }
        val platform = sel.first().platformVal
        pendingAdd = PendingAdd(
            platform = platform,
            platformVal = platform,
            orders = orders,
            paymentAmount = Math.round(selectedTotal() * 100) / 100.0,
            logisticsNo = logisticsInput.ifBlank { null },
            items = itemsArg,
            lookup = lookupResult
        )
        // 清空已选
        for (t in platTabs) stores[t.key]?.selected?.clear()
        step = "manage"
        renderManage()
        toast(if (orders.size > 1) "已暂存 ${orders.size} 笔采购,请点击保存落地" else "已暂存,请点击保存落地")
    }

    private fun doSave(withShip: Boolean) {
        if (saving) return
        val add = pendingAdd
        if (pendingRemoves.isEmpty() && add == null) return
        saving = true
        lifecycleScope.launch {
            // 本次已成功新增的采购单 id（失败时回滚）
            val createdPoIds = mutableListOf<Int>()
            try {
                // 拼单确认
                if (add != null && add.platform != "other" && add.orders.isNotEmpty()) {
                    var linkedCount = 0
                    for (od in add.orders) {
                        val r = if (add.orders.size == 1 && add.lookup != null) add.lookup
                        else lookupForConfirm(add.platform, od.purchaseSn)
                        if (r != null && r.exists && r.linkedPackages.isNotEmpty()) {
                            linkedCount++
                        }
                    }
                    if (linkedCount > 0) {
                        val ok = showConfirmDialog(
                            "拼单提示",
                            "本次 ${add.orders.size} 笔采购单中有 $linkedCount 笔已关联其他包裹,保存后将追加关联到本包裹(auto 模式:已有分摊按数量重新加权)。是否继续?",
                            "追加关联"
                        )
                        if (!ok) {
                            saving = false
                            return@launch
                        }
                    }
                }
                // 1) 先逐单提交新采购（后端按 platform+purchaseSn upsert，幂等；新增失败时旧数据未被破坏）
                if (add != null && add.orders.isNotEmpty()) {
                    for (od in add.orders) {
                        val r = Api.post(
                            "/admin/api/order-process/purchase",
                            mapOf(
                                "packageId" to packageId,
                                "platform" to add.platform,
                                "purchaseSn" to od.purchaseSn,
                                "buyerAccount" to (od.buyerAccount ?: ""),
                                "buyerUserId" to (od.buyerUserId ?: ""),
                                "sellerName" to (od.sellerName ?: ""),
                                "paymentAmount" to od.paymentAmount,
                                "logisticsCompany" to (od.logisticsCompany ?: ""),
                                "logisticsNo" to (od.logisticsNo ?: ""),
                                "items" to add.items.map {
                                    mapOf(
                                        "itemId" to it.itemId,
                                        "amount" to it.amount,
                                        "quantity" to it.quantity
                                    )
                                },
                                "platformGoods" to od.platformGoods.map {
                                    mapOf(
                                        "goodsName" to (it.goodsName ?: ""),
                                        "spec" to (it.spec ?: ""),
                                        "price" to (it.price ?: 0.0),
                                        "number" to (it.number ?: 0.0),
                                        "thumbUrl" to (it.thumbUrl ?: "")
                                    )
                                },
                                "allocMode" to "auto"
                            )
                        ).asJsonObject
                        val poId = r.optInt("purchaseOrderId", 0)
                        if (poId > 0) createdPoIds.add(poId)
                    }
                }
                // 2) 再删除标记的已有采购（破坏性操作放最后，失败时仅需回滚新增即可恢复原状）
                for (g in groups()) {
                    if (pendingRemoves.contains(g.purchaseOrderId)) {
                        Api.post(
                            "/admin/api/order-process/unlink",
                            mapOf("purchaseOrderId" to g.purchaseOrderId, "packageId" to packageId)
                        )
                    }
                }
                val allRemoved = groups().isNotEmpty() && groups().all { pendingRemoves.contains(it.purchaseOrderId) }
                if (allRemoved && add == null) {
                    Api.post("/admin/api/order-process/purchase/clear", mapOf("packageId" to packageId))
                }
                toast(
                    when {
                        add != null && add.orders.size > 1 -> "已保存 ${add.orders.size} 笔采购"
                        add != null -> "采购已保存"
                        else -> "已保存"
                    }
                )
                if (withShip && canShipAfterSave()) {
                    shipAfterSave()
                } else {
                    setResult(RESULT_OK)
                    finish()
                }
            } catch (e: Exception) {
                // 失败补偿：撤销本次已新增的采购，避免“新增成功但删除失败”留下半成品（评审 P0-4）
                if (createdPoIds.isNotEmpty()) {
                    for (poId in createdPoIds) {
                        try {
                            Api.post(
                                "/admin/api/order-process/unlink",
                                mapOf("purchaseOrderId" to poId, "packageId" to packageId)
                            )
                        } catch (_: Exception) {
                            // 回滚失败静默，用户可根据提示手动核对
                        }
                    }
                    toast("保存失败，已回滚本次新增的采购，请重试")
                }
                handleError(e)
            } finally {
                saving = false
            }
        }
    }

    private suspend fun lookupForConfirm(platform: String, purchaseSn: String): LookupResult? {
        return try {
            val data = Api.get(
                "/admin/api/order-process/purchase/lookup",
                mapOf("platform" to platform, "purchaseSn" to purchaseSn)
            ).asJsonObject
            if (data.optBoolean("exists")) parseLookup(data) else null
        } catch (e: Exception) {
            null
        }
    }

    private suspend fun showConfirmDialog(title: String, msg: String, confirm: String): Boolean {
        return suspendCancellableCoroutine { cont ->
            AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(msg)
                .setPositiveButton(confirm) { _, _ -> cont.resume(true) }
                .setNegativeButton("取消") { _, _ -> cont.resume(false) }
                .setOnCancelListener { cont.resume(false) }
                .show()
        }
    }

    private suspend fun shipAfterSave() {
        val multiQty = items.any { (it.quantity ?: 0.0) >= 2 }
        val qty = items.sumOf { it.quantity ?: 0.0 }.toLong()
        val ok = if (multiQty) {
            showConfirmDialog(
                "备货确认",
                "货件 ${pkg?.postingNumber ?: packageId}\n含数量≥2的商品(共 $qty 件),将向 Ozon 确认全部商品为一个货件(不拆分)。",
                "备货"
            )
        } else true
        if (!ok) {
            setResult(RESULT_OK)
            finish()
            return
        }
        try {
            val r = Api.post("/admin/api/order-process/ship", mapOf("packageId" to packageId)).asJsonObject
            toast(if (r.optBoolean("alreadyShipped")) "该包裹已备货过" else "备货成功")
        } catch (e: Exception) {
            toast(e.message ?: "备货失败")
        }
        setResult(RESULT_OK)
        finish()
    }

    private fun copyText(text: String, label: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText(label, text))
        toast("$label 已复制")
    }
}