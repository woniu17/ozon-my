package com.yochylin.scanner

import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import coil.load
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optString
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * 发运详情页(2026-11-02):
 * 展示发运信息、货件列表(含商品图)、快递员联系方式(编辑/保存/设为默认)、
 * 确认/取消发运。历史发运直接渲染本地快照(只读),在线发运实时拉取 Ozon。
 */
class CarriageDetailActivity : ComponentActivity() {

    companion object {
        const val EXTRA_STORE_ID = "storeId"
        const val EXTRA_CARRIAGE_ID = "carriageId"
        const val EXTRA_FROM_HISTORY = "fromHistory"
        const val EXTRA_STORE_NAME = "storeName"
        const val EXTRA_STATUS = "status"
        const val EXTRA_METHOD_NAME = "methodName"
        const val EXTRA_DELIVERY_METHOD_ID = "deliveryMethodId"
        const val EXTRA_DEPARTURE_DATE = "departureDate"
        const val EXTRA_POSTINGS_COUNT = "postingsCount"
        const val EXTRA_WAREHOUSE_NAME = "warehouseName"
        const val EXTRA_WAREHOUSE_CITY = "warehouseCity"
        const val EXTRA_FIRST_MILE_TYPE = "firstMileType"
        const val EXTRA_INTEGRATION_TYPE = "integrationType"
        const val EXTRA_POSTINGS_JSON = "postingsJson"
        const val EXTRA_CONTACT_JSON = "contactJson"
        const val EXTRA_CARRIAGE_JSON = "carriageJson"
    }

    private lateinit var content: LinearLayout
    private lateinit var statusTag: TextView

    private var storeId = ""
    private var carriageId = 0L
    private var fromHistory = false
    private var storeName = ""
    private var status = ""
    private var methodName = ""
    private var deliveryMethodId = ""
    private var departureDate = ""
    private var postingsCount = ""
    private var warehouseName = ""
    private var warehouseCity = ""
    private var firstMileType = ""
    private var integrationType = ""

    private var availableActions: List<String> = emptyList()
    private val postings = mutableListOf<JsonObject>()
    private val contactConfigs = mutableListOf<JsonObject>()

    // 联系方式表单
    private var phone = ""
    private var nick = ""
    private var comment = ""
    private lateinit var phoneEt: EditText
    private lateinit var nickEt: EditText
    private lateinit var commentEt: EditText

    private fun statusLabel(s: String): String = when (s) {
        "new" -> "新建"
        "formed" -> "已形成"
        "created" -> "已创建"
        "awaiting_delivery", "awaiting_delivering" -> "待发运"
        "delivering" -> "运输中"
        "received" -> "已接收"
        "delivered" -> "已送达"
        "cancelled" -> "已取消"
        "archived" -> "已归档"
        else -> s.ifBlank { "—" }
    }

    private fun hasAction(action: String): Boolean = availableActions.contains(action)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.carriage_detail_activity)
        content = findViewById(R.id.content)
        statusTag = findViewById(R.id.statusTag)
        findViewById<TextView>(R.id.backBtn).setOnClickListener { finish() }

        readIntent()
        setupHeader()
        if (fromHistory) {
            renderHistory()
        } else {
            loadOnline()
        }
    }

    private fun readIntent() {
        storeId = intent.getStringExtra(EXTRA_STORE_ID) ?: ""
        carriageId = intent.getLongExtra(EXTRA_CARRIAGE_ID, 0L)
        fromHistory = intent.getBooleanExtra(EXTRA_FROM_HISTORY, false)
        storeName = intent.getStringExtra(EXTRA_STORE_NAME) ?: ""
        status = intent.getStringExtra(EXTRA_STATUS) ?: ""
        methodName = intent.getStringExtra(EXTRA_METHOD_NAME) ?: ""
        deliveryMethodId = intent.getStringExtra(EXTRA_DELIVERY_METHOD_ID) ?: ""
        departureDate = intent.getStringExtra(EXTRA_DEPARTURE_DATE) ?: ""
        postingsCount = intent.getStringExtra(EXTRA_POSTINGS_COUNT) ?: ""
        warehouseName = intent.getStringExtra(EXTRA_WAREHOUSE_NAME) ?: ""
        warehouseCity = intent.getStringExtra(EXTRA_WAREHOUSE_CITY) ?: ""
        firstMileType = intent.getStringExtra(EXTRA_FIRST_MILE_TYPE) ?: ""
        integrationType = intent.getStringExtra(EXTRA_INTEGRATION_TYPE) ?: ""
    }

    private fun setupHeader() {
        findViewById<TextView>(R.id.titleText).text = "发运详情 #$carriageId"
        statusTag.text = statusLabel(status)
    }

    // ── 历史快照(只读) ──
    private fun renderHistory() {
        val carriage = intent.getStringExtra(EXTRA_CARRIAGE_JSON)
            ?.let { runCatching { JsonParser.parseString(it).asJsonObject }.getOrNull() }
        val postingsJson = intent.getStringExtra(EXTRA_POSTINGS_JSON)
        val contactJson = intent.getStringExtra(EXTRA_CONTACT_JSON)

        if (carriage != null) {
            status = carriage.optString("status").ifBlank { status }
            methodName = carriage.optString("delivery_method_name").ifBlank { methodName }
            departureDate = carriage.optString("departure_date").ifBlank { departureDate }
            firstMileType = carriage.optString("first_mile_type").ifBlank { firstMileType }
            integrationType = carriage.optString("integration_type").ifBlank { integrationType }
            statusTag.text = statusLabel(status)
        }
        renderInfoCard()

        val contactArray = contactJson
            ?.let { runCatching { JsonParser.parseString(it).asJsonArray }.getOrNull() }
        renderContactCard(contactArray)

        val postingArray = postingsJson
            ?.let { runCatching { JsonParser.parseString(it).asJsonArray }.getOrNull() }
        renderPostings(postingArray, editable = false)

        val hint = TextView(this).apply {
            text = "该发运已完成,以下为本地保存的快照信息。"
            textSize = 12f
            setTextColor(Color.parseColor("#86909c"))
            gravity = Gravity.CENTER
            setPadding(dp(8f), dp(12f), dp(8f), dp(4f))
        }
        content.addView(hint, matchWrap().apply { topMargin = dp(4f) })
    }

    // ── 在线加载 ──
    private fun loadOnline() {
        content.removeAllViews()
        content.addView(loadingView())
        lifecycleScope.launch {
            try {
                coroutineScope {
                    listOf(
                        async { fetchCarriage() },
                        async { fetchPostings() },
                        async { fetchContact() },
                        async { fetchContactConfigs() }
                    ).awaitAll()
                }
                renderOnline()
            } catch (e: Exception) {
                content.removeAllViews()
                content.addView(errorView(e.message ?: "加载失败"))
            }
        }
    }

    private suspend fun fetchCarriage() {
        val data = Api.post(
            "/admin/api/order-process/carriage/get",
            mapOf("storeId" to storeId, "carriageId" to carriageId)
        ).asJsonObject
        status = data.optString("status").ifBlank { status }
        methodName = data.optString("delivery_method_name").ifBlank { methodName }
        departureDate = data.optString("departure_date").ifBlank { departureDate }
        firstMileType = data.optString("first_mile_type").ifBlank { firstMileType }
        integrationType = data.optString("integration_type").ifBlank { integrationType }
        warehouseName = data.optString("warehouse_name").ifBlank { warehouseName }
        warehouseCity = data.optString("warehouse_city").ifBlank { warehouseCity }
        availableActions = data.optJsonArray("available_actions")
            ?.mapNotNull { it.asString }
            ?: emptyList()
    }

    private suspend fun fetchPostings() {
        val data = Api.post(
            "/admin/api/order-process/carriage/posting-list",
            mapOf("storeId" to storeId, "carriageId" to carriageId, "limit" to 100)
        ).asJsonObject
        val arr = data.optJsonArray("postings") ?: JsonArray()
        postings.clear()
        for (p in arr) {
            if (p.isJsonObject) postings.add(p.asJsonObject)
        }
    }

    private suspend fun fetchContact() {
        try {
            val data = Api.post(
                "/admin/api/order-process/carriage/courier-contact/get",
                mapOf("storeId" to storeId, "carriageId" to carriageId)
            ).asJsonObject
            val contact = data.optJsonArray("contact") ?: JsonArray()
            val first = contact.firstOrNull { it.isJsonObject }?.asJsonObject
            if (first != null) {
                phone = first.optString("phone")
                nick = first.optString("wechat_nickname")
                comment = first.optString("comment")
            }
        } catch (e: Exception) {
            // 不适用/未配置时静默
        }
    }

    private suspend fun fetchContactConfigs() {
        try {
            val data = Api.post(
                "/admin/api/order-process/carriage/courier-contact/config/list",
                mapOf("storeId" to storeId)
            ).asJsonObject
            val arr = data.optJsonArray("contacts") ?: JsonArray()
            contactConfigs.clear()
            for (c in arr) {
                if (c.isJsonObject) contactConfigs.add(c.asJsonObject)
            }
            if (phone.isBlank()) {
                val def = contactConfigs.firstOrNull { it.optBoolean("isDefault") }
                    ?: contactConfigs.firstOrNull()
                if (def != null) {
                    phone = def.optString("phone")
                    nick = def.optString("wechatNickname")
                    comment = def.optString("comment")
                }
            }
        } catch (e: Exception) {
            // 配置加载失败不影响详情
        }
    }

    private fun renderOnline() {
        content.removeAllViews()
        renderInfoCard()
        renderContactCard(null)
        renderPostings(null, editable = status == "new")
        renderActionBar()
    }

    // ── 信息卡片 ──
    private fun renderInfoCard() {
        val card = sectionCard("发运信息")
        addInfoRow(card, "店铺", storeName.ifBlank { "—" })
        addInfoRow(card, "发运 ID", "#$carriageId", mono = true)
        addInfoRow(card, "状态", statusLabel(status))
        addInfoRow(card, "配送方式", methodName.ifBlank { "—" })
        addInfoRow(card, "发运日期", departureDate.ifBlank { "—" })
        if (firstMileType.isNotBlank()) addInfoRow(card, "首程类型", firstMileType)
        if (integrationType.isNotBlank()) addInfoRow(card, "集成方式", integrationType)
        if (warehouseName.isNotBlank() || warehouseCity.isNotBlank()) {
            addInfoRow(card, "仓库", "${warehouseName}${if (warehouseCity.isNotBlank()) " $warehouseCity" else ""}")
        }
        addInfoRow(card, "货件数", postingsCount.ifBlank { "${postings.size}" })
        content.addView(card)
    }

    private fun addInfoRow(card: LinearLayout, label: String, value: String, mono: Boolean = false) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        row.addView(
            TextView(this).apply {
                text = label
                setTextColor(Color.parseColor("#86909c"))
                textSize = 13f
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 0.35f).apply {
                topMargin = dp(6f)
            }
        )
        row.addView(
            TextView(this).apply {
                text = value
                setTextColor(Color.parseColor("#1d2129"))
                textSize = 13f
                if (mono) typeface = android.graphics.Typeface.MONOSPACE
                gravity = Gravity.END
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 0.65f).apply {
                topMargin = dp(6f)
            }
        )
        card.addView(row)
    }

    // ── 联系方式卡片 ──
    private fun renderContactCard(historyContact: JsonArray?) {
        val card = sectionCard("快递员联系方式")
        if (fromHistory) {
            val first = historyContact?.firstOrNull { it.isJsonObject }?.asJsonObject
            if (first != null) {
                addInfoRow(card, "电话", first.optString("phone").ifBlank { "—" })
                addInfoRow(card, "下单人", first.optString("wechat_nickname").ifBlank { "—" })
                addInfoRow(card, "取件地址", first.optString("comment").ifBlank { "—" })
            } else {
                val tip = TextView(this).apply {
                    text = "该发运未保存快递员联系方式。"
                    setTextColor(Color.parseColor("#86909c"))
                    textSize = 13f
                    setPadding(dp(2f), dp(6f), dp(2f), dp(2f))
                }
                card.addView(tip)
            }
            content.addView(card)
            return
        }

        val contactApplicable = firstMileType == "pickup" && integrationType == "ozon_outsourced"
        if (!contactApplicable) {
            val tip = TextView(this).apply {
                text = "当前发运不适用快递员联系方式(仅 pickup + ozon_outsourced 适用)。"
                setTextColor(Color.parseColor("#86909c"))
                textSize = 13f
                setPadding(dp(2f), dp(6f), dp(2f), dp(2f))
            }
            card.addView(tip)
            content.addView(card)
            return
        }

        phoneEt = EditText(this).apply {
            hint = "快递员电话(必填)"
            setText(phone)
            inputType = InputType.TYPE_CLASS_PHONE
            textSize = 14f
            setBackgroundResource(R.drawable.bg_edit)
            setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
        }
        nickEt = EditText(this).apply {
            hint = "下单人名称(选填)"
            setText(nick)
            textSize = 14f
            setBackgroundResource(R.drawable.bg_edit)
            setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
        }
        commentEt = EditText(this).apply {
            hint = "提供给快递公司的取件地址(必填)"
            setText(comment)
            textSize = 14f
            gravity = Gravity.TOP
            setMinLines(2)
            setBackgroundResource(R.drawable.bg_edit)
            setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
        }
        card.addView(phoneEt, matchWrap().apply { topMargin = dp(8f) })
        card.addView(nickEt, matchWrap().apply { topMargin = dp(6f) })
        card.addView(commentEt, matchWrap().apply { topMargin = dp(6f) })

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        btnRow.addView(ghostButton("设为默认", Color.parseColor("#165dff")) { setAsDefault() })
        btnRow.addView(primaryButton("保存联系方式", Color.parseColor("#165dff")) { saveContact() })
        card.addView(btnRow, matchWrap().apply { topMargin = dp(10f) })
        content.addView(card)
    }

    private fun saveContact() {
        val p = phoneEt.text.toString().trim()
        val c = commentEt.text.toString().trim()
        if (p.isEmpty() || c.isEmpty()) {
            toast("请填写快递员电话和取件地址")
            return
        }
        lifecycleScope.launch {
            try {
                Api.post(
                    "/admin/api/order-process/carriage/courier-contact/set",
                    mapOf(
                        "storeId" to storeId,
                        "carriageId" to carriageId,
                        "phone" to p,
                        "wechatNickname" to nickEt.text.toString().trim(),
                        "comment" to c
                    )
                )
                phone = p
                comment = c
                nick = nickEt.text.toString().trim()
                toast("快递员联系方式已保存")
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    private fun setAsDefault() {
        val p = phoneEt.text.toString().trim()
        val c = commentEt.text.toString().trim()
        if (p.isEmpty() || c.isEmpty()) {
            toast("请先填写快递员电话和取件地址")
            return
        }
        lifecycleScope.launch {
            try {
                val list = contactConfigs.map { cfg ->
                    mapOf(
                        "id" to cfg.optString("id"),
                        "phone" to cfg.optString("phone"),
                        "wechatNickname" to cfg.optString("wechatNickname"),
                        "comment" to cfg.optString("comment"),
                        "isDefault" to false
                    )
                }.toMutableList()
                val idx = list.indexOfFirst { it["phone"] == p }
                if (idx >= 0) {
                    list[idx] = mapOf(
                        "id" to (list[idx]["id"] ?: ""),
                        "phone" to p,
                        "wechatNickname" to nickEt.text.toString().trim(),
                        "comment" to c,
                        "isDefault" to true
                    )
                } else {
                    list.add(
                        mapOf(
                            "id" to "",
                            "phone" to p,
                            "wechatNickname" to nickEt.text.toString().trim(),
                            "comment" to c,
                            "isDefault" to true
                        )
                    )
                }
                val data = Api.post(
                    "/admin/api/order-process/carriage/courier-contact/config/save",
                    mapOf("storeId" to storeId, "contacts" to list)
                ).asJsonObject
                val arr = data.optJsonArray("contacts") ?: JsonArray()
                contactConfigs.clear()
                for (c in arr) {
                    if (c.isJsonObject) contactConfigs.add(c.asJsonObject)
                }
                toast("当前联系方式已设为默认配置")
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 货件列表 ──
    private fun renderPostings(historyPostings: JsonArray?, editable: Boolean) {
        val section = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(
            TextView(this).apply {
                text = "货件列表(${historyPostings?.size() ?: postings.size})"
                setTextColor(Color.parseColor("#1d2129"))
                textSize = 15f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        if (editable) {
            header.addView(
                TextView(this).apply {
                    text = "＋ 添加货件"
                    setTextColor(Color.parseColor("#165dff"))
                    textSize = 13f
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                    setPadding(dp(8f), dp(2f), dp(4f), dp(2f))
                    setOnClickListener { openCandidateDialog() }
                }
            )
        }
        section.addView(header)

        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val items = historyPostings?.map { it.asJsonObject } ?: postings
        if (items.isEmpty()) {
            list.addView(
                TextView(this).apply {
                    text = "暂无货件"
                    setTextColor(Color.parseColor("#86909c"))
                    textSize = 13f
                    gravity = Gravity.CENTER
                    setPadding(dp(4f), dp(16f), dp(4f), dp(16f))
                }
            )
        } else {
            for ((i, p) in items.withIndex()) {
                list.addView(buildPostingCard(p, editable, i))
            }
        }
        section.addView(list, matchWrap().apply { topMargin = dp(8f) })
        content.addView(section, matchWrap().apply { topMargin = dp(16f) })
    }

    private fun buildPostingCard(p: JsonObject, editable: Boolean, index: Int): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10f), dp(10f), dp(10f), dp(10f))
            setRoundedBg(0xFFF7F8FA.toInt(), 8f)
        }
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.bottomMargin = dp(8f)
        card.layoutParams = lp

        card.addView(
            TextView(this).apply {
                text = "${index + 1}"
                setTextColor(Color.parseColor("#86909c"))
                textSize = 12f
                gravity = Gravity.CENTER
                setRoundedBg(0xFFE5E6EB.toInt(), 999f)
                setPadding(dp(6f), dp(2f), dp(6f), dp(2f))
            }
        )

        val img = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(56f), dp(56f)).apply {
                marginStart = dp(10f)
            }
            scaleType = ImageView.ScaleType.CENTER_CROP
            setRoundedBg(0xFFE5E6EB.toInt(), 6f)
        }
        val firstProduct = p.optJsonArray("products")?.firstOrNull { it.isJsonObject }?.asJsonObject
        val imageUrl = firstProduct?.optString("image_url").orEmpty()
        if (imageUrl.isNotBlank()) {
            val absolute = if (imageUrl.startsWith("/")) Api.BASE_URL + imageUrl else imageUrl
            img.load(absolute)
        }
        card.addView(img)

        val mid = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        mid.addView(
            TextView(this).apply {
                text = p.optString("posting_number").ifBlank { "—" }
                setTextColor(Color.parseColor("#1d2129"))
                textSize = 13f
                typeface = android.graphics.Typeface.MONOSPACE
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            }
        )
        mid.addView(
            TextView(this).apply {
                text = productsSummary(p)
                setTextColor(Color.parseColor("#4e5969"))
                textSize = 12f
                setMaxLines(2)
            },
            matchWrap().apply { topMargin = dp(4f) }
        )
        mid.addView(
            TextView(this).apply {
                text = "状态:${p.optString("status").ifBlank { "—" }}"
                setTextColor(Color.parseColor("#86909c"))
                textSize = 11f
            },
            matchWrap().apply { topMargin = dp(4f) }
        )
        card.addView(mid, LinearLayout.LayoutParams(
            0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        ).apply { marginStart = dp(10f) })

        if (editable) {
            card.addView(
                TextView(this).apply {
                    text = "移除"
                    setTextColor(Color.parseColor("#f53f3f"))
                    textSize = 12f
                    setPadding(dp(8f), dp(4f), dp(4f), dp(4f))
                    setOnClickListener { removePosting(p) }
                }
            )
        }
        return card
    }

    private fun productsSummary(p: JsonObject): String {
        val items = p.optJsonArray("products") ?: JsonArray()
        if (items.size() == 0) return "—"
        val parts = mutableListOf<String>()
        for (it in items) {
            val io = it.takeIf { it.isJsonObject }?.asJsonObject ?: continue
            val name = io.optString("name")
            val offerId = io.optString("offer_id")
            val sku = io.optString("sku")
            val qty = fmtNum(io.get("quantity"))
            val label = name.ifBlank { offerId.ifBlank { sku.ifBlank { "商品" } } }
            parts.add("$label ×$qty")
        }
        val shown = parts.take(3).joinToString("、")
        return if (items.size() > 3) "$shown 等${items.size()}项" else shown
    }

    private fun fmtNum(el: JsonElement?): String {
        if (el == null || el.isJsonNull) return "—"
        return try {
            val d = el.asDouble
            if (d == d.toLong().toDouble()) d.toLong().toString() else d.toString()
        } catch (e: Exception) {
            el.asString.ifBlank { "—" }
        }
    }

    private fun removePosting(p: JsonObject) {
        val number = p.optString("posting_number")
        if (postings.size <= 1) {
            toast("发运至少保留 1 个货件,如需清空请取消发运")
            return
        }
        postings.removeAll { it.optString("posting_number") == number }
        savePostings("已移除货件 $number")
    }

    private fun savePostings(successMsg: String) {
        lifecycleScope.launch {
            try {
                Api.post(
                    "/admin/api/order-process/carriage/set-postings",
                    mapOf(
                        "storeId" to storeId,
                        "carriageId" to carriageId,
                        "postingNumbers" to postings.map { it.optString("posting_number") }
                    )
                )
                toast(successMsg)
                renderOnline()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 添加货件候选弹窗 ──
    private fun openCandidateDialog() {
        lifecycleScope.launch {
            val existing = postings.map { it.optString("posting_number") }.toSet()
            val checked = mutableMapOf<String, Boolean>()
            val box = LinearLayout(this@CarriageDetailActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12f), dp(4f), dp(12f), dp(4f))
            }
            try {
                val body = mutableMapOf("storeId" to storeId, "carriageId" to carriageId)
                if (deliveryMethodId.isNotBlank()) body["deliveryMethodId"] = deliveryMethodId.toLongOrNull() ?: 0L
                val data = Api.post(
                    "/admin/api/order-process/carriage/available-postings",
                    body
                ).asJsonObject
                val arr = data.optJsonArray("postings") ?: JsonArray()
                val candidates = arr.filter {
                    it.isJsonObject && !existing.contains(it.asJsonObject.optString("posting_number"))
                }
                if (candidates.isEmpty()) {
                    toast("没有可加入的「已准备发运」货件")
                    return@launch
                }
                val scroll = ScrollView(this@CarriageDetailActivity)
                scroll.addView(box, android.widget.FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ))
                // 候选列表:卡片格式参考详情页货件列表(勾选 + 序号 + 商品图 + 货件号 + 商品摘要 + 状态)
                var index = 0
                for (p in candidates) {
                    val po = p.asJsonObject
                    val number = po.optString("posting_number")
                    val cb = CheckBox(this@CarriageDetailActivity).apply {
                        textSize = 13f
                    }
                    val row = LinearLayout(this@CarriageDetailActivity).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
                        setRoundedBg(0xFFF7F8FA.toInt(), 8f)
                    }
                    val rowLp = matchWrap()
                    rowLp.bottomMargin = dp(8f)
                    row.layoutParams = rowLp

                    row.addView(cb)
                    row.addView(
                        TextView(this@CarriageDetailActivity).apply {
                            text = "${index + 1}"
                            setTextColor(Color.parseColor("#86909c"))
                            textSize = 11f
                            gravity = Gravity.CENTER
                            setRoundedBg(0xFFE5E6EB.toInt(), 999f)
                            setPadding(dp(5f), dp(1f), dp(5f), dp(1f))
                        }
                    )
                    val img = ImageView(this@CarriageDetailActivity).apply {
                        layoutParams = LinearLayout.LayoutParams(dp(48f), dp(48f)).apply {
                            marginStart = dp(8f)
                        }
                        scaleType = ImageView.ScaleType.CENTER_CROP
                        setRoundedBg(0xFFE5E6EB.toInt(), 6f)
                    }
                    val firstProduct = po.optJsonArray("products")
                        ?.firstOrNull { it.isJsonObject }?.asJsonObject
                    val imageUrl = firstProduct?.optString("image_url").orEmpty()
                    if (imageUrl.isNotBlank()) {
                        val absolute = if (imageUrl.startsWith("/")) Api.BASE_URL + imageUrl else imageUrl
                        img.load(absolute)
                    }
                    row.addView(img)

                    val mid = LinearLayout(this@CarriageDetailActivity).apply {
                        orientation = LinearLayout.VERTICAL
                    }
                    mid.addView(
                        TextView(this@CarriageDetailActivity).apply {
                            text = number.ifBlank { "—" }
                            setTextColor(Color.parseColor("#1d2129"))
                            textSize = 12f
                            typeface = android.graphics.Typeface.MONOSPACE
                            setTypeface(typeface, android.graphics.Typeface.BOLD)
                        }
                    )
                    mid.addView(
                        TextView(this@CarriageDetailActivity).apply {
                            text = productsSummary(po)
                            setTextColor(Color.parseColor("#4e5969"))
                            textSize = 11f
                            setMaxLines(2)
                        },
                        matchWrap().apply { topMargin = dp(2f) }
                    )
                    mid.addView(
                        TextView(this@CarriageDetailActivity).apply {
                            text = "状态:${po.optString("status").ifBlank { "—" }}"
                            setTextColor(Color.parseColor("#86909c"))
                            textSize = 10f
                        },
                        matchWrap().apply { topMargin = dp(2f) }
                    )
                    row.addView(mid, LinearLayout.LayoutParams(
                        0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
                    ).apply { marginStart = dp(8f) })

                    row.setOnClickListener { cb.isChecked = !cb.isChecked }
                    cb.setOnCheckedChangeListener { _, isChecked -> checked[number] = isChecked }
                    box.addView(row)
                    index++
                }
                AlertDialog.Builder(this@CarriageDetailActivity)
                    .setTitle("选择要加入的货件")
                    .setView(scroll)
                    .setPositiveButton("加入") { _, _ ->
                        val selected = checked.filterValues { it }.keys
                        val added = selected.filter { !existing.contains(it) }.toList()
                        if (added.isEmpty()) {
                            toast("请先勾选要加入的货件")
                            return@setPositiveButton
                        }
                        for (n in added) {
                            val obj = arr.firstOrNull {
                                it.isJsonObject && it.asJsonObject.optString("posting_number") == n
                            }?.asJsonObject
                            if (obj != null) postings.add(obj)
                        }
                        savePostings("已加入 ${added.size} 个货件")
                    }
                    .setNegativeButton("取消", null)
                    .show()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 确认/取消发运 ──
    private fun renderActionBar() {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        if (hasAction("approve")) {
            bar.addView(primaryButton("确认发运", Color.parseColor("#00b42a")) { showApproveDialog() })
        }
        if (hasAction("cancel")) {
            bar.addView(dangerButton("取消发运", Color.parseColor("#f53f3f")) { showCancelDialog() })
        }
        if (bar.childCount == 0) {
            val tip = TextView(this).apply {
                text = "该发运无可用操作"
                setTextColor(Color.parseColor("#86909c"))
                textSize = 13f
                gravity = Gravity.CENTER
                setPadding(dp(4f), dp(16f), dp(4f), dp(16f))
            }
            content.addView(tip, matchWrap().apply { topMargin = dp(16f) })
            return
        }
        content.addView(bar, matchWrap().apply { topMargin = dp(16f) })
    }

    private fun showApproveDialog() {
        val countEt = EditText(this).apply {
            hint = "容器数(可选)"
            inputType = InputType.TYPE_CLASS_NUMBER
            textSize = 14f
            setBackgroundResource(R.drawable.bg_edit)
            setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
        }
        val tip = TextView(this).apply {
            text = "确认后发运进入「已生成」状态,后续可打印面单/货位标签。"
            textSize = 13f
            setTextColor(Color.parseColor("#4e5969"))
            setPadding(dp(2f), dp(2f), dp(2f), dp(2f))
        }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18f), dp(4f), dp(18f), dp(4f))
            addView(tip)
            addView(countEt, matchWrap().apply { topMargin = dp(8f) })
        }
        AlertDialog.Builder(this)
            .setTitle("确认发运 #$carriageId")
            .setView(box)
            .setPositiveButton("确认发运") { _, _ ->
                doApprove(countEt.text.toString().trim())
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doApprove(containersCount: String) {
        lifecycleScope.launch {
            try {
                val body = mutableMapOf("storeId" to storeId, "carriageId" to carriageId)
                if (containersCount.isNotBlank()) {
                    body["containersCount"] = containersCount.toLongOrNull() ?: 0L
                }
                Api.post("/admin/api/order-process/carriage/approve", body)
                toast("发运 #$carriageId 已确认")
                renderOnline()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    private fun showCancelDialog() {
        AlertDialog.Builder(this)
            .setTitle("取消发运")
            .setMessage("确认取消发运 #$carriageId?\n取消后货件将回到未发运状态,可重新组入下一次发运。")
            .setPositiveButton("取消发运") { _, _ -> doCancel() }
            .setNegativeButton("再想想", null)
            .show()
    }

    private fun doCancel() {
        lifecycleScope.launch {
            try {
                Api.post(
                    "/admin/api/order-process/carriage/cancel",
                    mapOf("storeId" to storeId, "carriageId" to carriageId)
                )
                toast("发运 #$carriageId 已取消")
                finish()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 通用视图构建 ──
    private fun sectionCard(title: String): LinearLayout {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(dp(14f), dp(12f), dp(14f), dp(12f))
        }
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.topMargin = dp(10f)
        card.layoutParams = lp
        card.addView(
            TextView(this).apply {
                text = title
                setTextColor(Color.parseColor("#1d2129"))
                textSize = 15f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            }
        )
        return card
    }

    private fun loadingView(): View {
        val tv = TextView(this).apply {
            text = "加载中…"
            setTextColor(Color.parseColor("#86909c"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(4f), dp(32f), dp(4f), dp(32f))
        }
        tv.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        return tv
    }

    private fun errorView(msg: String): View {
        val tv = TextView(this).apply {
            text = "加载失败:$msg"
            setTextColor(Color.parseColor("#86909c"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(4f), dp(32f), dp(4f), dp(32f))
        }
        tv.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        return tv
    }

    private fun primaryButton(text: String, color: Int, onClick: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            setTextColor(Color.WHITE)
            textSize = 14f
            isAllCaps = false
            setRoundedBg(color, 10f)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.leftMargin = dp(8f)
            lp.rightMargin = dp(8f)
            setPadding(dp(20f), dp(10f), dp(20f), dp(10f))
            layoutParams = lp
            setOnClickListener { onClick() }
        }
    }

    private fun dangerButton(text: String, color: Int, onClick: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            setTextColor(color)
            textSize = 14f
            isAllCaps = false
            setRoundedBg(0xFFFFECE8.toInt(), 10f)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.leftMargin = dp(8f)
            lp.rightMargin = dp(8f)
            setPadding(dp(20f), dp(10f), dp(20f), dp(10f))
            layoutParams = lp
            setOnClickListener { onClick() }
        }
    }

    private fun ghostButton(text: String, color: Int, onClick: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            setTextColor(color)
            textSize = 14f
            isAllCaps = false
            setRoundedBg(0xFFEEF4FF.toInt(), 10f)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.leftMargin = dp(8f)
            setPadding(dp(16f), dp(10f), dp(16f), dp(10f))
            layoutParams = lp
            setOnClickListener { onClick() }
        }
    }

    private fun matchWrap(): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

    private fun dp(v: Float): Int = (v * resources.displayMetrics.density).toInt()

    private fun handleError(e: Exception) {
        if (e is ApiException && e.code == 401) {
            toast("登录已过期,请重新登录")
            finish()
        } else {
            toast(e.message ?: "请求失败")
        }
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}

/** JsonObject 安全取值:键不存在/为 null 时返回 null */
private fun JsonObject.optJsonArray(key: String): JsonArray? =
    get(key)?.takeIf { it.isJsonArray }?.asJsonArray