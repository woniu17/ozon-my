package com.yochylin.scanner

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import coil.load
import com.google.gson.JsonObject
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optString
import kotlinx.coroutines.launch

/**
 * 新增预采购(2026-11-16,对齐 web 采购弹窗):
 * 平台×账号 tabs(1688 多账号) + 订单号搜索 + 商品图片;勾选后逐单提交预采购。
 */
class PrePurchaseCreateActivity : ComponentActivity() {

    private data class PlatformMeta(val key: String, val prefix: String, val label: String)
    private val platforms = listOf(
        PlatformMeta("pdd", "pdd", "拼多多"),
        PlatformMeta("ali1688", "ali", "1688"),
        PlatformMeta("taobao", "taobao", "淘宝"),
        PlatformMeta("xianyu", "xianyu", "闲鱼"),
    )

    private var currentPlatform = "pdd"
    private var currentAccount = ""
    private val accountsByPlatform = HashMap<String, List<String>>()

    private lateinit var platformTabsContainer: LinearLayout
    private lateinit var accountTabsContainer: LinearLayout
    private lateinit var searchInput: EditText
    private lateinit var hintTv: TextView
    private lateinit var listContainer: LinearLayout

    private data class Order(
        val orderSn: String,
        val amount: Double,
        val logisticsNo: String,
        val logisticsCompany: String,
        val sellerName: String,
        val buyerAccount: String,
        val buyerUserId: String,
        val goods: List<JsonObject>,
        var selected: Boolean = false,
        var logisticsEdit: String = "",
    )

    private val orders = mutableListOf<Order>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pre_purchase_create)
        platformTabsContainer = findViewById(R.id.ppcPlatformTabs)
        accountTabsContainer = findViewById(R.id.ppcAccountTabs)
        searchInput = findViewById(R.id.ppcSearchInput)
        hintTv = findViewById(R.id.ppcHint)
        listContainer = findViewById(R.id.ppcList)
        findViewById<TextView>(R.id.ppcRefresh).setOnClickListener { loadOrders() }
        findViewById<TextView>(R.id.ppcCancel).setOnClickListener { finish() }
        findViewById<TextView>(R.id.ppcSubmit).setOnClickListener { submit() }
        findViewById<TextView>(R.id.ppcSearchBtn).setOnClickListener { doSearch() }
        searchInput.setOnEditorActionListener { _, _, _ -> doSearch(); true }
        renderPlatformTabs()
        renderAccountTabs()
        loadStatusThenOrders()
    }

    private fun loadStatusThenOrders() {
        lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/platform-orders/status").asJsonObject
                val platformsObj = data.getAsJsonObject("platforms")
                if (platformsObj != null) {
                    for (p in platforms) {
                        val po = platformsObj.getAsJsonObject(p.key)
                        val accObj = po?.getAsJsonObject("accounts")
                        if (accObj != null && accObj.size() > 0) {
                            accountsByPlatform[p.key] = accObj.keySet().toList()
                        }
                    }
                }
            } catch (_: Exception) { /* 状态拉取失败用默认账号 */ }
            renderAccountTabs()
            loadOrders()
        }
    }

    private fun renderPlatformTabs() {
        platformTabsContainer.removeAllViews()
        for (p in platforms) {
            val active = currentPlatform == p.key
            platformTabsContainer.addView(TextView(this).apply {
                text = p.label
                textSize = 13f
                gravity = Gravity.CENTER
                setPadding(dp(18), dp(8), dp(18), dp(8))
                setTextColor(Color.parseColor(if (active) "#165dff" else "#4e5969"))
                setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
                setRoundedBg(if (active) Color.parseColor("#e8f3ff") else Color.TRANSPARENT, 8f)
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { rightMargin = dp(6) }
                setOnClickListener {
                    if (currentPlatform == p.key) return@setOnClickListener
                    currentPlatform = p.key
                    currentAccount = ""
                    renderPlatformTabs()
                    renderAccountTabs()
                    loadOrders()
                }
            })
        }
    }

    private fun renderAccountTabs() {
        accountTabsContainer.removeAllViews()
        val accounts = accountsByPlatform[currentPlatform].orEmpty()
        if (accounts.isEmpty()) {
            currentAccount = ""
            accountTabsContainer.visibility = android.view.View.GONE
            return
        }
        accountTabsContainer.visibility = android.view.View.VISIBLE
        if (currentAccount.isBlank() || currentAccount !in accounts) currentAccount = accounts[0]
        for (acc in accounts) {
            val active = currentAccount == acc
            accountTabsContainer.addView(TextView(this).apply {
                text = acc
                textSize = 12f
                gravity = Gravity.CENTER
                setPadding(dp(14), dp(5), dp(14), dp(5))
                setTextColor(Color.parseColor(if (active) "#165dff" else "#86909c"))
                setRoundedBg(if (active) Color.parseColor("#eef4ff") else Color.parseColor("#f2f3f5"), 999f)
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { rightMargin = dp(6) }
                setOnClickListener {
                    if (currentAccount == acc) return@setOnClickListener
                    currentAccount = acc
                    renderAccountTabs()
                    loadOrders()
                }
            })
        }
    }

    private fun loadOrders() {
        orders.clear()
        listContainer.removeAllViews()
        hintTv.text = "正在拉取订单…"
        lifecycleScope.launch {
            try {
                val params = mutableMapOf<String, Any?>("tab" to "all", "size" to 30)
                if (currentAccount.isNotBlank()) params["account"] = currentAccount
                val data = Api.get("/admin/api/platform-orders/$currentPlatform", params).asJsonObject
                val arr = data.getAsJsonArray("orders")
                if (arr != null) {
                    for (el in arr) {
                        val goods = mutableListOf<JsonObject>()
                        el.asJsonObject.getAsJsonArray("goods")?.forEach { goods.add(it.asJsonObject) }
                        orders.add(parseOrder(el.asJsonObject, goods))
                    }
                }
                hintTv.text = if (orders.isEmpty()) "该平台/账号暂无可选订单" else "已选 0 / ${orders.size} 笔订单"
                renderList()
            } catch (e: Exception) {
                hintTv.text = e.message ?: "拉取失败"
            }
        }
    }

    private fun doSearch() {
        val sn = searchInput.text.toString().trim()
        if (sn.isBlank()) return
        lifecycleScope.launch {
            try {
                val params = mutableMapOf<String, Any?>("orderSn" to sn)
                if (currentAccount.isNotBlank()) params["account"] = currentAccount
                val data = Api.get("/admin/api/platform-orders/$currentPlatform/search", params).asJsonObject
                val res = data.get("result")
                if (res != null && !res.isJsonNull) {
                    val goods = mutableListOf<JsonObject>()
                    res.asJsonObject.getAsJsonArray("goods")?.forEach { goods.add(it.asJsonObject) }
                    orders.clear()
                    orders.add(parseOrder(res.asJsonObject, goods).also { it.selected = true })
                    hintTv.text = "搜索命中 ${orders.size} 笔"
                    renderList()
                } else {
                    hintTv.text = "未找到订单 $sn(单号不存在或不属于当前账号)"
                }
            } catch (e: Exception) {
                hintTv.text = e.message ?: "搜索失败"
            }
        }
    }

    private fun parseOrder(o: JsonObject, goods: List<JsonObject>): Order = Order(
        orderSn = o.optString("orderSn").ifBlank { o.optString("purchaseSn") },
        amount = o.optDouble("paidAmount", o.optDouble("amount", 0.0)),
        logisticsNo = o.optString("trackingNumber").ifBlank { o.optString("logisticsNo") },
        logisticsCompany = o.optString("logisticsCompany"),
        sellerName = o.optString("sellerName"),
        buyerAccount = o.optString("buyerAccount"),
        buyerUserId = o.optString("buyerUserId"),
        goods = goods,
    )

    private fun renderList() {
        listContainer.removeAllViews()
        for ((idx, o) in orders.withIndex()) {
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                setRoundedBg(Color.WHITE, 10f)
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8) }
            }
            val head = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            head.addView(CheckBox(this).apply {
                isChecked = o.selected
                setOnCheckedChangeListener { _, checked -> o.selected = checked; updateHint() }
            })
            head.addView(TextView(this).apply {
                text = o.orderSn.ifBlank { "#${idx + 1}" }
                setTextColor(Color.parseColor("#1f2329"))
                textSize = 12f
                typeface = Typeface.MONOSPACE
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            head.addView(TextView(this).apply {
                text = "¥" + String.format(java.util.Locale.US, "%.2f", o.amount)
                setTextColor(Color.parseColor("#f53f3f"))
                textSize = 12f
            })
            card.addView(head)

            // 商品(图片 + 名称 + 规格×数量)
            for (g in o.goods.take(3)) {
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(6), 0, 0)
                }
                val img = ImageView(this).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(42), dp(42))
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    setBackgroundColor(Color.parseColor("#f2f3f5"))
                }
                val pic = g.optString("thumbUrl").ifBlank { g.optString("picUrl") }
                if (pic.isNotBlank()) img.load(if (pic.startsWith("/")) Api.BASE_URL + pic else pic)
                row.addView(img)
                val name = g.optString("goodsName").ifBlank { g.optString("title") }
                val spec = g.optString("spec")
                val price = g.optDouble("price", 0.0)
                val num = g.optDouble("number", g.optDouble("num", 1.0))
                row.addView(TextView(this).apply {
                    text = buildString {
                        append(name)
                        if (spec.isNotBlank()) append("\n").append(spec)
                        append("\n¥").append(String.format(java.util.Locale.US, "%.2f", price)).append(" × ").append(num.toInt())
                    }
                    setTextColor(Color.parseColor("#4e5969"))
                    textSize = 11f
                    maxLines = 3
                    setPadding(dp(8), 0, 0, 0)
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                card.addView(row)
            }

            val logisticsInput = EditText(this).apply {
                hint = "快递单号(可改)"
                setText(o.logisticsEdit.ifBlank { o.logisticsNo })
                textSize = 12f
                inputType = InputType.TYPE_CLASS_TEXT
                setPadding(dp(8), dp(6), dp(8), dp(6))
                setBackgroundColor(Color.parseColor("#f7f8fa"))
                addTextChangedListener(object : android.text.TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, a: Int) {}
                    override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) { o.logisticsEdit = s?.toString() ?: "" }
                    override fun afterTextChanged(s: android.text.Editable?) {}
                })
            }
            card.addView(logisticsInput, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) })
            listContainer.addView(card)
        }
    }

    private fun updateHint() {
        hintTv.text = "已选 ${orders.count { it.selected }} / ${orders.size} 笔订单"
    }

    private fun submit() {
        val picked = orders.filter { it.selected }
        if (picked.isEmpty()) {
            toast("请先勾选订单")
            return
        }
        lifecycleScope.launch {
            var ok = 0
            try {
                for (o in picked) {
                    val goodsArr = com.google.gson.JsonArray()
                    o.goods.forEach { goodsArr.add(it) }
                    Api.post(
                        "/admin/api/pre-purchase/create",
                        mapOf(
                            "platform" to currentPlatform,
                            "purchaseSn" to o.orderSn,
                            "buyerAccount" to o.buyerAccount,
                            "buyerUserId" to o.buyerUserId,
                            "sellerName" to o.sellerName,
                            "paymentAmount" to o.amount,
                            "goodsAmount" to o.amount,
                            "logisticsCompany" to o.logisticsCompany,
                            "logisticsNo" to (o.logisticsEdit.ifBlank { o.logisticsNo }).trim(),
                            "poStatus" to "shipped",
                            "items" to goodsArr,
                            "platformGoods" to goodsArr,
                        )
                    )
                    ok++
                }
                toast("已新增 $ok 笔预采购")
                setResult(RESULT_OK)
                finish()
            } catch (e: Exception) {
                toast(e.message ?: "提交失败(已成功 $ok 笔)")
                if (ok > 0) { setResult(RESULT_OK); finish() }
            }
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()
    private fun toast(msg: String) = android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
}
