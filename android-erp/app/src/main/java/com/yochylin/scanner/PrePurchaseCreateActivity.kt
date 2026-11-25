package com.yochylin.scanner

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.google.gson.JsonObject
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optInt
import com.yochylin.scanner.api.optString
import kotlinx.coroutines.launch

/**
 * 新增预采购(2026-11-16):选平台订单 → 勾选 → 填快递单号 → 逐单提交预采购。
 * 仅选平台订单(用户确认),不支持手动录入。
 */
class PrePurchaseCreateActivity : ComponentActivity() {

    private val platforms = listOf(
        "pdd" to "拼多多",
        "ali1688" to "1688",
        "taobao" to "淘宝",
        "xianyu" to "闲鱼",
    )
    private var currentPlatform = "pdd"

    private lateinit var platViews: Map<String, TextView>
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
        platViews = mapOf(
            "pdd" to findViewById(R.id.ppcPlatPdd),
            "ali1688" to findViewById(R.id.ppcPlat1688),
            "taobao" to findViewById(R.id.ppcPlatTaobao),
            "xianyu" to findViewById(R.id.ppcPlatXianyu),
        )
        hintTv = findViewById(R.id.ppcHint)
        listContainer = findViewById(R.id.ppcList)
        findViewById<TextView>(R.id.ppcRefresh).setOnClickListener { loadOrders() }
        findViewById<TextView>(R.id.ppcCancel).setOnClickListener { finish() }
        findViewById<TextView>(R.id.ppcSubmit).setOnClickListener { submit() }
        for ((key, tv) in platViews) tv.setOnClickListener { switchPlatform(key) }
        updatePlatformTabs()
        loadOrders()
    }

    private fun switchPlatform(p: String) {
        if (currentPlatform == p) return
        currentPlatform = p
        updatePlatformTabs()
        loadOrders()
    }

    private fun updatePlatformTabs() {
        for ((key, tv) in platViews) {
            val active = currentPlatform == key
            tv.setTextColor(Color.parseColor(if (active) "#165dff" else "#86909c"))
            tv.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
            tv.setRoundedBg(if (active) Color.parseColor("#e8f3ff") else Color.TRANSPARENT, 8f)
        }
    }

    private fun loadOrders() {
        orders.clear()
        listContainer.removeAllViews()
        hintTv.text = "正在拉取订单…"
        lifecycleScope.launch {
            try {
                val data = Api.get(
                    "/admin/api/platform-orders/$currentPlatform",
                    mapOf("tab" to "all", "size" to "30")
                ).asJsonObject
                val arr = data.getAsJsonArray("orders")
                if (arr != null) {
                    for (el in arr) {
                        val o = el.asJsonObject
                        val goods = mutableListOf<JsonObject>()
                        o.getAsJsonArray("goods")?.forEach { goods.add(it.asJsonObject) }
                        orders.add(
                            Order(
                                orderSn = o.optString("orderSn").ifBlank { o.optString("purchaseSn") },
                                amount = o.optDouble("paidAmount", o.optDouble("amount", 0.0)),
                                logisticsNo = o.optString("trackingNumber").ifBlank { o.optString("logisticsNo") },
                                logisticsCompany = o.optString("logisticsCompany"),
                                sellerName = o.optString("sellerName"),
                                buyerAccount = o.optString("buyerAccount"),
                                buyerUserId = o.optString("buyerUserId"),
                                goods = goods,
                            )
                        )
                    }
                }
                hintTv.text = if (orders.isEmpty()) "该平台暂无可选订单" else "已选 0 / ${orders.size} 笔订单"
                renderList()
            } catch (e: Exception) {
                hintTv.text = e.message ?: "拉取失败"
            }
        }
    }

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
                gravity = android.view.Gravity.CENTER_VERTICAL
            }
            val cb = CheckBox(this).apply {
                isChecked = o.selected
                setOnCheckedChangeListener { _, checked ->
                    o.selected = checked
                    updateHint()
                }
            }
            head.addView(cb)
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

            val goodsDesc = o.goods.take(2).joinToString(" / ") {
                val name = it.optString("goodsName").ifBlank { it.optString("title") }
                val num = it.optDouble("number", it.optDouble("num", 1.0)).toInt()
                if (name.isBlank()) "" else "$name×$num"
            }
            if (goodsDesc.isNotBlank()) {
                card.addView(TextView(this).apply {
                    text = goodsDesc
                    setTextColor(Color.parseColor("#4e5969"))
                    textSize = 11f
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    setPadding(0, dp(4), 0, 0)
                })
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
        val n = orders.count { it.selected }
        hintTv.text = "已选 $n / ${orders.size} 笔订单"
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
