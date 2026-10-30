package com.yochylin.scanner

import android.app.AlertDialog
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.util.Base64
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optString
import com.yochylin.scanner.model.OrderStatsStoresResponse
import com.yochylin.scanner.model.StoreItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 发运管理(2026-11-02,由原"货运标签"tab 升级):
 * 对齐 web 端发运管理功能 —— 待处理/已完成清单、创建发运、独立详情页、
 * 快递员联系方式配置、货运标签打印/预览。原"货运标签"打印/预览功能完整保留。
 */
class ContainerLabelFragment : Fragment() {

    private lateinit var printerBar: TextView
    private lateinit var labelList: LinearLayout
    private lateinit var emptyText: TextView
    private lateinit var tabPending: TextView
    private lateinit var tabDone: TextView

    private var allStores: List<StoreItem> = emptyList()
    private var currentStoreId: String = ""

    /** 页面模式:true=待处理,false=已完成 */
    private var isPending = true

    /** 进行中发运(含占位行) */
    private val pendingRows = mutableListOf<CarriageRow>()
    /** 已完成发运(本地历史快照) */
    private val historyRows = mutableListOf<CarriageRow>()
    private val printedStates = mutableMapOf<String, Boolean>()

    /** 快递员联系方式配置(全店铺通用) */
    private val contactConfigs = mutableListOf<ContactConfig>()
    private var contactConfigsLoaded = false

    private data class ContactConfig(
        var id: String,
        var phone: String,
        var wechatNickname: String,
        var comment: String,
        var isDefault: Boolean
    )

    private data class CarriageRow(
        val id: Long,
        val storeId: String,
        val storeName: String,
        val status: String,
        val deliveryMethodId: String,
        val deliveryMethodName: String,
        val departureDate: String,
        val postingsCount: String,
        val quantumCount: String,
        val containersCount: String,
        val warehouseName: String = "",
        val warehouseCity: String = "",
        val firstMileType: String = "",
        val integrationType: String = "",
        val availableActions: List<String> = emptyList(),
        val isPlaceholder: Boolean = false,
        val fromHistory: Boolean = false,
        val printed: Boolean = false,
        val postingsJson: String? = null,
        val contactJson: String? = null,
        val carriageJson: String? = null
    )

    // Ozon 发运状态中文文案(与 web 端一致)
    private fun statusLabel(status: String): String = when (status) {
        "new" -> "新建"
        "formed" -> "已形成"
        "created" -> "已创建"
        "awaiting_delivery", "awaiting_delivering" -> "待发运"
        "delivering" -> "运输中"
        "received" -> "已接收"
        "delivered" -> "已送达"
        "cancelled" -> "已取消"
        "archived" -> "已归档"
        else -> status.ifBlank { "—" }
    }

    private fun hasAction(row: CarriageRow, action: String): Boolean =
        row.availableActions.contains(action)

    /** 发运是否已确认:未确认状态(新建/已形成/已创建)无法生成标签,禁用预览/打印(对齐 web 端) */
    private fun isCarriageConfirmed(row: CarriageRow): Boolean =
        row.status !in UNCONFIRMED_STATUSES

    private companion object {
        val UNCONFIRMED_STATUSES = setOf("new", "formed", "created")
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? = inflater.inflate(R.layout.container_label_fragment, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        printerBar = view.findViewById(R.id.printerBar)
        labelList = view.findViewById(R.id.labelList)
        emptyText = view.findViewById(R.id.emptyText)
        tabPending = view.findViewById(R.id.tabPending)
        tabDone = view.findViewById(R.id.tabDone)
        view.findViewById<TextView>(R.id.refreshBtn).setOnClickListener { refreshCurrent() }

        printerBar.setOnClickListener { showPrinterPicker() }
        tabPending.setOnClickListener { setMode(true) }
        tabDone.setOnClickListener { setMode(false) }

        refreshPrinterStatus()
        loadStores()
    }

    // ── 模式切换 ──
    private fun setMode(pending: Boolean) {
        if (isPending == pending) return
        isPending = pending
        updateTabUi()
        if (isPending) loadPending() else loadDone()
    }

    private fun updateTabUi() {
        if (isPending) {
            tabPending.setBackgroundResource(R.drawable.bg_tab_segment_active)
            tabPending.setTextColor(Color.parseColor("#ffffff"))
            tabDone.setBackgroundResource(R.drawable.bg_tab_segment_inactive)
            tabDone.setTextColor(Color.parseColor("#86909c"))
            printerBar.visibility = View.VISIBLE
        } else {
            tabDone.setBackgroundResource(R.drawable.bg_tab_segment_active)
            tabDone.setTextColor(Color.parseColor("#ffffff"))
            tabPending.setBackgroundResource(R.drawable.bg_tab_segment_inactive)
            tabPending.setTextColor(Color.parseColor("#86909c"))
            printerBar.visibility = View.GONE
        }
    }

    private fun refreshCurrent() {
        if (isPending) {
            loadPending()
            if (!contactConfigsLoaded) loadContactConfigs()
        } else {
            loadDone()
        }
    }

    // ── 店铺列表 ──
    private fun loadStores() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val resp = Api.parse<OrderStatsStoresResponse>(
                    Api.get("/admin/api/order-stats/stores")
                )
                allStores = resp.stores ?: emptyList()
                if (allStores.isEmpty()) {
                    showEmpty("无可用店铺")
                    return@launch
                }
                currentStoreId = allStores[0].id ?: ""
                loadPending()
                loadContactConfigs()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 待处理:并行汇总所有店铺进行中发运 ──
    private fun loadPending() {
        if (allStores.isEmpty()) {
            showEmpty("无可用店铺")
            return
        }
        viewLifecycleOwner.lifecycleScope.launch {
            showEmpty("")
            try {
                val rows = coroutineScope {
                    allStores.map { store ->
                        async(Dispatchers.IO) { fetchStoreCarriages(store) }
                    }.awaitAll().flatten()
                }
                // 出发日期倒序,同日按 ID 倒序(占位行排最后)
                val sorted = rows.sortedWith(
                    compareBy<CarriageRow> { it.isPlaceholder }
                        .thenByDescending { it.departureDate }
                        .thenByDescending { it.id }
                )
                pendingRows.clear()
                pendingRows.addAll(sorted)
                renderLabels()
                if (pendingRows.isEmpty()) {
                    showEmpty("暂无进行中的发运")
                } else {
                    checkPrinted(pendingRows.filter { !it.isPlaceholder && !it.fromHistory })
                }
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    /** 单个店铺拉取(失败不影响其他店铺),返回该店铺全部行(含可创建占位行) */
    private suspend fun fetchStoreCarriages(store: StoreItem): List<CarriageRow> {
        val storeId = store.id ?: ""
        val storeName = store.name ?: storeId
        if (storeId.isBlank()) return emptyList()
        return try {
            val obj = Api.post(
                "/admin/api/order-process/carriage/list",
                mapOf("storeId" to storeId, "cursor" to "", "limit" to 1000)
            ).asJsonObject
            val methods = obj.optJsonArray("methods") ?: JsonArray()
            val rows = mutableListOf<CarriageRow>()
            for (m in methods) {
                val mo = m.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                val methodId = mo.optString("delivery_method_id")
                val methodName = mo.optString("delivery_method_name")
                val departureDate = mo.optString("departure_date")
                val warehouseName = mo.optString("warehouse_name")
                val warehouseCity = mo.optString("warehouse_city")
                val carriages = mo.optJsonArray("carriages") ?: JsonArray()
                if (carriages.size() == 0) {
                    // 占位行:该配送方式下无发运,提供创建入口(与 web 端一致)
                    rows.add(
                        CarriageRow(
                            id = 0,
                            storeId = storeId,
                            storeName = storeName,
                            status = "placeholder",
                            deliveryMethodId = methodId,
                            deliveryMethodName = methodName,
                            departureDate = departureDate,
                            postingsCount = "—",
                            quantumCount = "—",
                            containersCount = "—",
                            warehouseName = warehouseName,
                            warehouseCity = warehouseCity,
                            isPlaceholder = true
                        )
                    )
                    continue
                }
                for (c in carriages) {
                    val co = c.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                    val id = co.optDouble("id", 0.0).toLong()
                    if (id <= 0) continue
                    val actions = co.optJsonArray("available_actions")
                        ?.mapNotNull { it.asString }
                        ?: emptyList()
                    rows.add(
                        CarriageRow(
                            id = id,
                            storeId = storeId,
                            storeName = storeName,
                            status = co.optString("status"),
                            deliveryMethodId = methodId,
                            deliveryMethodName = methodName,
                            departureDate = departureDate,
                            postingsCount = fmtCount(co, "postings_count"),
                            quantumCount = fmtCount(co, "quantum_count"),
                            containersCount = fmtCount(co, "containers_count"),
                            warehouseName = warehouseName,
                            warehouseCity = warehouseCity,
                            firstMileType = co.optString("first_mile_type"),
                            integrationType = co.optString("integration_type"),
                            availableActions = actions
                        )
                    )
                }
            }
            // 记录第一个可用店铺(配置接口鉴权用)
            if (currentStoreId.isBlank() || !allStores.any { it.id == currentStoreId }) {
                currentStoreId = storeId
            }
            rows
        } catch (e: Exception) {
            // 该店铺未配置 sync_credentials 或 Ozon 抖动,静默忽略
            emptyList()
        }
    }

    // ── 已完成:本地持久化历史快照 ──
    private fun loadDone() {
        viewLifecycleOwner.lifecycleScope.launch {
            showEmpty("")
            val storeId = currentStoreId.ifBlank { allStores.firstOrNull()?.id ?: "" }
            if (storeId.isBlank()) {
                showEmpty("无可用店铺")
                return@launch
            }
            try {
                val obj = Api.post(
                    "/admin/api/order-process/carriage/history/list",
                    mapOf("storeId" to storeId)
                ).asJsonObject
                val items = obj.optJsonArray("items") ?: JsonArray()
                historyRows.clear()
                for (it in items) {
                    val io = it.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                    val id = io.optDouble("id", 0.0).toLong()
                    if (id <= 0) continue
                    historyRows.add(
                        CarriageRow(
                            id = id,
                            storeId = io.optString("store_id"),
                            storeName = io.optString("store_name"),
                            status = io.optString("status"),
                            deliveryMethodId = io.optString("delivery_method_id"),
                            deliveryMethodName = io.optString("delivery_method_name"),
                            departureDate = io.optString("departure_date"),
                            postingsCount = fmtCount(io, "postings_count"),
                            quantumCount = "—",
                            containersCount = fmtCount(io, "containers_count"),
                            warehouseName = io.optString("warehouse_name"),
                            warehouseCity = io.optString("warehouse_city"),
                            firstMileType = io.optString("first_mile_type"),
                            integrationType = io.optString("integration_type"),
                            fromHistory = true,
                            postingsJson = io.optString("postings_json").ifBlank { null },
                            contactJson = io.optString("contact_json").ifBlank { null },
                            carriageJson = io.optString("carriage_json").ifBlank { null }
                        )
                    )
                }
                renderLabels()
                if (historyRows.isEmpty()) {
                    showEmpty("暂无已完成发运")
                }
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    /** 数字字段可能是 number/string/null,统一转展示文本 */
    private fun fmtCount(obj: JsonObject, key: String): String {
        val el = obj.get(key) ?: return "—"
        if (el.isJsonNull) return "—"
        return try {
            val d = el.asDouble
            if (d == d.toLong().toDouble()) d.toLong().toString() else d.toString()
        } catch (e: Exception) {
            el.asString.ifBlank { "—" }
        }
    }

    // ── 渲染 ──
    private fun renderLabels() {
        labelList.removeAllViews()
        if (isPending) {
            // 联系方式配置卡片置顶(web 端仅在待处理展示)
            labelList.addView(buildContactConfigCard())
            for (row in pendingRows) {
                labelList.addView(buildCarriageCard(row))
            }
        } else {
            for (row in historyRows) {
                labelList.addView(buildCarriageCard(row))
            }
        }
    }

    private fun showEmpty(text: String) {
        if (text.isBlank()) {
            emptyText.visibility = View.GONE
            return
        }
        emptyText.text = text
        emptyText.visibility = View.VISIBLE
    }

    private fun dp(v: Float): Int = (v * resources.displayMetrics.density).toInt()

    // ── 快递员联系方式配置卡片 ──
    private fun buildContactConfigCard(): View {
        val defaultCfg = contactConfigs.find { it.isDefault } ?: contactConfigs.firstOrNull()
        val card = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(dp(14f), dp(12f), dp(14f), dp(12f))
        }
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.bottomMargin = dp(12f)
        card.layoutParams = lp

        // 标题行
        val titleRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        titleRow.addView(
            TextView(requireContext()).apply {
                text = "快递员联系方式配置"
                setTextColor(Color.parseColor("#1d2129"))
                textSize = 14f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        titleRow.addView(
            TextView(requireContext()).apply {
                text = "全店铺通用 · 管理"
                setTextColor(Color.parseColor("#165dff"))
                textSize = 12f
            }
        )
        card.addView(titleRow)

        // 默认配置摘要
        val summary = TextView(requireContext()).apply {
            text = if (defaultCfg != null) {
                "📞 ${defaultCfg.phone.ifBlank { "未填" }} · ${defaultCfg.wechatNickname.ifBlank { "未填下单人" }}\n📍 ${defaultCfg.comment.ifBlank { "未填取件地址" }}"
            } else {
                "尚未配置快递员联系方式,点击添加(OGL 上门取件时提供给快递公司)"
            }
            setTextColor(Color.parseColor("#4e5969"))
            textSize = 12f
            setLineSpacing(dp(2f).toFloat(), 1f)
        }
        card.addView(summary, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8f) })

        card.setOnClickListener { showContactConfigDialog() }
        return card
    }

    // ── 联系方式配置管理对话框 ──
    private fun showContactConfigDialog() {
        val dialogList = contactConfigs.map { it.copy() }.toMutableList()
        // 编辑器引用:用于把输入框内容同步回 dialogList(删除/设默认前先同步,避免输入丢失)
        val boxes = mutableListOf<Pair<ContactConfig, MutableMap<String, EditText>>>()

        fun syncEdits() {
            for ((cfg, edits) in boxes) {
                cfg.phone = edits["phone"]?.text?.toString()?.trim().orEmpty()
                cfg.wechatNickname = edits["nick"]?.text?.toString()?.trim().orEmpty()
                cfg.comment = edits["comment"]?.text?.toString()?.trim().orEmpty()
            }
        }

        // 重建函数:与 buildConfigEditor 相互引用,用变量承载(末尾赋值)
        var rebuild: () -> Unit = {}

        fun buildConfigEditor(cfg: ContactConfig, index: Int, edits: MutableMap<String, EditText>): View {
            val box = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(10f), dp(10f), dp(10f), dp(10f))
                setRoundedBg(0xFFF2F3F5.toInt(), 8f)
            }
            val boxLp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            boxLp.bottomMargin = dp(10f)
            box.layoutParams = boxLp

            // 标题:配置 N + 默认单选 + 删除
            val headRow = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            headRow.addView(
                TextView(requireContext()).apply {
                    text = "配置 ${index + 1}"
                    setTextColor(Color.parseColor("#1d2129"))
                    textSize = 13f
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            )
            val defaultRb = RadioButton(requireContext()).apply {
                text = "默认"
                textSize = 13f
                isChecked = cfg.isDefault
            }
            headRow.addView(defaultRb)
            headRow.addView(
                TextView(requireContext()).apply {
                    text = "删除"
                    setTextColor(Color.parseColor("#f53f3f"))
                    textSize = 13f
                    setPadding(dp(8f), dp(2f), dp(4f), dp(2f))
                    setOnClickListener {
                        syncEdits()
                        dialogList.removeAt(index)
                        rebuild()
                    }
                }
            )
            box.addView(headRow)

            // 电话
            val phoneEt = EditText(requireContext()).apply {
                hint = "快递员电话(必填)"
                setText(cfg.phone)
                inputType = InputType.TYPE_CLASS_PHONE
                textSize = 14f
                setBackgroundResource(R.drawable.bg_edit)
                setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
            }
            box.addView(phoneEt, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6f) })
            edits["phone"] = phoneEt

            // 下单人名称
            val nickEt = EditText(requireContext()).apply {
                hint = "下单人名称(选填)"
                setText(cfg.wechatNickname)
                textSize = 14f
                setBackgroundResource(R.drawable.bg_edit)
                setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
            }
            box.addView(nickEt, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6f) })
            edits["nick"] = nickEt

            // 地址(提供给快递公司)
            val commentEt = EditText(requireContext()).apply {
                hint = "取件地址(必填)"
                setText(cfg.comment)
                textSize = 14f
                gravity = Gravity.TOP
                setMinLines(2)
                setBackgroundResource(R.drawable.bg_edit)
                setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
            }
            box.addView(commentEt, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6f) })
            edits["comment"] = commentEt

            defaultRb.setOnClickListener {
                syncEdits()
                for (c in dialogList) c.isDefault = false
                cfg.isDefault = true
                rebuild()
            }
            return box
        }

        val container = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18f), dp(4f), dp(18f), dp(4f))
        }
        val scroll = ScrollView(requireContext())
        scroll.addView(container, android.widget.FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        val addBtn = Button(requireContext()).apply {
            text = "+ 添加配置"
            setTextColor(Color.parseColor("#165dff"))
            textSize = 14f
            isAllCaps = false
            setBackgroundResource(R.drawable.bg_btn_ghost)
            setOnClickListener {
                syncEdits()
                dialogList.add(ContactConfig(
                    id = "",
                    phone = "",
                    wechatNickname = "",
                    comment = "",
                    isDefault = dialogList.isEmpty()
                ))
                rebuild()
            }
        }

        rebuild = {
            container.removeAllViews()
            boxes.clear()
            for ((i, cfg) in dialogList.withIndex()) {
                val edits = mutableMapOf<String, EditText>()
                boxes.add(cfg to edits)
                container.addView(buildConfigEditor(cfg, i, edits))
            }
            container.addView(addBtn, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4f) })
        }
        rebuild()

        AlertDialog.Builder(requireContext())
            .setTitle("快递员联系方式配置")
            .setView(scroll)
            .setPositiveButton("保存配置") { _, _ ->
                syncEdits()
                var invalid = false
                for (cfg in dialogList) {
                    if (cfg.phone.isEmpty() || cfg.comment.isEmpty()) invalid = true
                }
                if (invalid) {
                    toast("每条配置都需要填写电话和取件地址")
                    return@setPositiveButton
                }
                saveContactConfigs(dialogList)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun saveContactConfigs(list: List<ContactConfig>) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val contacts = list.map { cfg ->
                    mapOf(
                        "id" to cfg.id,
                        "phone" to cfg.phone,
                        "wechatNickname" to cfg.wechatNickname,
                        "comment" to cfg.comment,
                        "isDefault" to cfg.isDefault
                    )
                }
                val obj = Api.post(
                    "/admin/api/order-process/carriage/courier-contact/config/save",
                    mapOf("storeId" to currentStoreId, "contacts" to contacts)
                ).asJsonObject
                val saved = obj.optJsonArray("contacts") ?: JsonArray()
                contactConfigs.clear()
                for (c in saved) {
                    val co = c.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                    contactConfigs.add(ContactConfig(
                        id = co.optString("id"),
                        phone = co.optString("phone"),
                        wechatNickname = co.optString("wechatNickname"),
                        comment = co.optString("comment"),
                        isDefault = co.optBoolean("isDefault")
                    ))
                }
                contactConfigsLoaded = true
                renderLabels()
                toast("联系方式配置已保存")
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    private fun loadContactConfigs() {
        viewLifecycleOwner.lifecycleScope.launch {
            val storeId = currentStoreId.ifBlank { allStores.firstOrNull()?.id ?: "" }
            if (storeId.isBlank()) return@launch
            try {
                val obj = Api.post(
                    "/admin/api/order-process/carriage/courier-contact/config/list",
                    mapOf("storeId" to storeId)
                ).asJsonObject
                val contacts = obj.optJsonArray("contacts") ?: JsonArray()
                contactConfigs.clear()
                for (c in contacts) {
                    val co = c.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                    contactConfigs.add(ContactConfig(
                        id = co.optString("id"),
                        phone = co.optString("phone"),
                        wechatNickname = co.optString("wechatNickname"),
                        comment = co.optString("comment"),
                        isDefault = co.optBoolean("isDefault")
                    ))
                }
                contactConfigsLoaded = true
                renderLabels()
            } catch (e: Exception) {
                // 配置加载失败不影响清单展示
            }
        }
    }

    // ── 创建发运 ──
    private fun onGoCreate(row: CarriageRow) {
        val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.getDefault())
            .format(java.util.Date())
        val dateEt = EditText(requireContext()).apply {
            setText(row.departureDate.ifBlank { today })
            inputType = InputType.TYPE_CLASS_DATETIME or InputType.TYPE_DATETIME_VARIATION_DATE
            textSize = 14f
            setBackgroundResource(R.drawable.bg_edit)
            setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
        }
        val info = "店铺:${row.storeName}\n配送方式:${row.deliveryMethodName}\n发运日期:"
        val tv = TextView(requireContext()).apply {
            text = info
            textSize = 14f
            setTextColor(Color.parseColor("#4e5969"))
            setPadding(dp(2f), dp(2f), dp(2f), dp(2f))
        }
        val box = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18f), dp(4f), dp(18f), dp(4f))
            addView(tv)
            addView(dateEt, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6f) })
        }
        AlertDialog.Builder(requireContext())
            .setTitle("创建发运")
            .setView(box)
            .setPositiveButton("创建") { _, _ ->
                val date = dateEt.text.toString().trim()
                doCreate(row, date)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doCreate(row: CarriageRow, departureDate: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = mutableMapOf(
                    "storeId" to row.storeId,
                    "deliveryMethodId" to (row.deliveryMethodId.toLongOrNull() ?: 0L)
                )
                if (departureDate.isNotBlank()) body["departureDate"] = departureDate
                val obj = Api.post(
                    "/admin/api/order-process/carriage/create",
                    body
                ).asJsonObject
                val cid = obj.optDouble("carriage_id", 0.0).toLong()
                toast("发运创建成功:${if (cid > 0) "#$cid" else ""}")
                loadPending()
                if (cid > 0) {
                    openDetail(CarriageRow(
                        id = cid,
                        storeId = row.storeId,
                        storeName = row.storeName,
                        status = "new",
                        deliveryMethodId = row.deliveryMethodId,
                        deliveryMethodName = row.deliveryMethodName,
                        departureDate = departureDate,
                        postingsCount = "—",
                        quantumCount = "—",
                        containersCount = "—"
                    ))
                }
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 详情页 ──
    private fun openDetail(row: CarriageRow) {
        val intent = Intent(requireContext(), CarriageDetailActivity::class.java).apply {
            putExtra(CarriageDetailActivity.EXTRA_STORE_ID, row.storeId)
            putExtra(CarriageDetailActivity.EXTRA_CARRIAGE_ID, row.id)
            putExtra(CarriageDetailActivity.EXTRA_FROM_HISTORY, row.fromHistory)
            putExtra(CarriageDetailActivity.EXTRA_STORE_NAME, row.storeName)
            putExtra(CarriageDetailActivity.EXTRA_STATUS, row.status)
            putExtra(CarriageDetailActivity.EXTRA_METHOD_NAME, row.deliveryMethodName)
            putExtra(CarriageDetailActivity.EXTRA_DELIVERY_METHOD_ID, row.deliveryMethodId)
            putExtra(CarriageDetailActivity.EXTRA_DEPARTURE_DATE, row.departureDate)
            putExtra(CarriageDetailActivity.EXTRA_POSTINGS_COUNT, row.postingsCount)
            putExtra(CarriageDetailActivity.EXTRA_WAREHOUSE_NAME, row.warehouseName)
            putExtra(CarriageDetailActivity.EXTRA_WAREHOUSE_CITY, row.warehouseCity)
            putExtra(CarriageDetailActivity.EXTRA_FIRST_MILE_TYPE, row.firstMileType)
            putExtra(CarriageDetailActivity.EXTRA_INTEGRATION_TYPE, row.integrationType)
            row.postingsJson?.let { putExtra(CarriageDetailActivity.EXTRA_POSTINGS_JSON, it) }
            row.contactJson?.let { putExtra(CarriageDetailActivity.EXTRA_CONTACT_JSON, it) }
            row.carriageJson?.let { putExtra(CarriageDetailActivity.EXTRA_CARRIAGE_JSON, it) }
        }
        startActivity(intent)
    }

    // ── 卡片渲染 ──
    private fun buildCarriageCard(row: CarriageRow): View {
        if (row.isPlaceholder) return buildPlaceholderCard(row)
        return buildCarriageCardNormal(row)
    }

    /** 占位卡片:点击创建发运 */
    private fun buildPlaceholderCard(row: CarriageRow): View {
        val card = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14f), dp(14f), dp(14f), dp(14f))
            setBackgroundResource(R.drawable.bg_card_dashed)
        }
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.bottomMargin = dp(12f)
        card.layoutParams = lp

        card.addView(
            TextView(requireContext()).apply {
                text = "＋"
                setTextColor(Color.parseColor("#165dff"))
                textSize = 18f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            }
        )
        val textBox = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
        }
        textBox.addView(
            TextView(requireContext()).apply {
                text = "创建发运 · ${row.deliveryMethodName.ifBlank { row.deliveryMethodId }}"
                setTextColor(Color.parseColor("#165dff"))
                textSize = 14f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        textBox.addView(
            TextView(requireContext()).apply {
                text = "${row.storeName} · ${row.departureDate.ifBlank { "日期待定" }}"
                setTextColor(Color.parseColor("#86909c"))
                textSize = 12f
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                topMargin = dp(2f)
            }
        )
        card.addView(textBox, LinearLayout.LayoutParams(
            0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        ).apply { marginStart = dp(10f) })

        // 右侧"可创建"标签(对齐 web 端占位行)
        card.addView(
            TextView(requireContext()).apply {
                text = "可创建"
                setTextColor(Color.parseColor("#165dff"))
                textSize = 11f
                setRoundedBg(0xFFEEF4FF.toInt(), 999f)
                setPadding(dp(8f), dp(3f), dp(8f), dp(3f))
            },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { marginStart = dp(8f) }
        )

        card.setOnClickListener { onGoCreate(row) }
        return card
    }

    /** 普通发运卡片(进行中/历史共用) */
    private fun buildCarriageCardNormal(row: CarriageRow): View {
        val card = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.bg_card)
            setPadding(dp(14f), dp(14f), dp(14f), dp(14f))
        }
        val lp = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        lp.bottomMargin = dp(12f)
        card.layoutParams = lp

        // 头部:店铺名标签 + 发运 ID + 已打印状态
        val header = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(
            TextView(requireContext()).apply {
                text = row.storeName
                setTextColor(Color.parseColor("#165dff"))
                textSize = 11f
                setRoundedBg(0xFFEEF4FF.toInt(), 999f)
                setPadding(dp(8f), dp(3f), dp(8f), dp(3f))
            }
        )
        header.addView(
            TextView(requireContext()).apply {
                text = "#${row.id}"
                setTextColor(Color.parseColor("#1d2129"))
                textSize = 16f
                typeface = android.graphics.Typeface.MONOSPACE
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(8f)
            }
        )
        header.addView(buildStatusTag(row))
        card.addView(header)

        // 第二行:配送方式 + 出发日期
        val metaRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        metaRow.addView(
            TextView(requireContext()).apply {
                text = row.deliveryMethodName.ifBlank { "配送方式未知" }
                setTextColor(Color.parseColor("#4e5969"))
                textSize = 12f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )
        metaRow.addView(
            TextView(requireContext()).apply {
                text = row.departureDate.ifBlank { "" }
                setTextColor(Color.parseColor("#86909c"))
                textSize = 11f
            }
        )
        card.addView(metaRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6f) })

        // 明细:状态 · 包裹数 · 量子数(历史补仓库信息)
        val warehouse = if (row.warehouseName.isNotBlank() || row.warehouseCity.isNotBlank()) {
            " · ${row.warehouseName}${if (row.warehouseCity.isNotBlank()) " ${row.warehouseCity}" else ""}"
        } else ""
        val detail = TextView(requireContext()).apply {
            text = "${statusLabel(row.status)} · 包裹 ${row.postingsCount} · 量子 ${row.quantumCount}$warehouse"
            setTextColor(Color.parseColor("#86909c"))
            textSize = 12f
            setPadding(dp(8f), dp(6f), dp(8f), dp(6f))
            setRoundedBg(0xFFF2F3F5.toInt(), 6f)
        }
        card.addView(detail, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8f) })

        // 操作行:单行等宽按钮,保证 详情/预览/打印1张/打印3张 在同一排
        val actionRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        fun addAction(text: String, color: Int, enabled: Boolean = true, onClick: () -> Unit) {
            val btn = compactActionButton(text, color, enabled, onClick)
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            lp.rightMargin = dp(4f)
            actionRow.addView(btn, lp)
        }
        // 未确认发运无法生成标签:预览/打印置灰(对齐 web 端)
        val confirmed = isCarriageConfirmed(row)
        addAction("详情", Color.parseColor("#165dff")) { openDetail(row) }
        if (!row.fromHistory) {
            addAction("预览", Color.parseColor("#165dff"), confirmed) { previewLabel(row) }
            addAction("打印1张", Color.parseColor("#00b42a"), confirmed) { printLabel(row, 1) }
            addAction("打印3张", Color.parseColor("#00b42a"), confirmed) { printLabel(row, 3) }
        } else {
            addAction("预览", Color.parseColor("#165dff"), confirmed) { previewLabel(row) }
        }
        if (hasAction(row, "approve")) {
            addAction("确认", Color.parseColor("#00b42a")) { openDetail(row) }
        }
        if (hasAction(row, "cancel")) {
            addAction("取消", Color.parseColor("#f53f3f")) { openDetail(row) }
        }
        card.addView(actionRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(10f) })

        return card
    }

    /** 已打印状态小标签 */
    private fun buildStatusTag(row: CarriageRow): TextView {
        val printed = row.printed || (printedStates[row.id.toString()] ?: false)
        return TextView(requireContext()).apply {
            text = if (printed) "已打印" else "未打印"
            textSize = 11f
            setTextColor(if (printed) Color.parseColor("#00b42a") else Color.parseColor("#86909c"))
            setRoundedBg(
                if (printed) 0xFFE8FFEA.toInt() else 0xFFF2F3F5.toInt(),
                999f
            )
            setPadding(dp(10f), dp(3f), dp(10f), dp(3f))
        }
    }

    /** 单行等宽操作按钮:去掉系统默认最小宽高,缩小内边距,让多个按钮一行放下 */
    private fun compactActionButton(
        text: String,
        color: Int,
        enabled: Boolean,
        onClick: () -> Unit
    ): Button {
        return Button(requireContext()).apply {
            this.text = text
            setTextColor(if (enabled) Color.WHITE else Color.parseColor("#B3FFFFFF"))
            textSize = 11f
            isAllCaps = false
            // 未启用时置灰(仍可点击,点击提示原因,对齐 web 端禁用+提示)
            setRoundedBg(if (enabled) color else Color.parseColor("#C9CDD4"), 6f)
            // 关键:清除主题默认最小宽高(否则每个按钮至少 88dp 宽,必然换行)
            minWidth = 0
            minHeight = 0
            setPadding(dp(4f), dp(5f), dp(4f), dp(5f))
            setOnClickListener {
                if (enabled) onClick() else toast("发运确认后生成标签，方可预览/打印")
            }
        }
    }

    // ── 打印状态回填(按店铺分组查询) ──
    private fun checkPrinted(rows: List<CarriageRow>) {
        if (rows.isEmpty()) return
        viewLifecycleOwner.lifecycleScope.launch {
            val byStore = rows.groupBy { it.storeId }
            for ((storeId, storeRows) in byStore) {
                try {
                    val ids = storeRows.map { it.id }.joinToString(",")
                    if (ids.isBlank()) continue
                    // 已解包 data,直接取 printed 映射
                    val obj = Api.get(
                        "/admin/api/print-agent/container-label-print-status",
                        mapOf("storeId" to storeId, "labelIds" to ids)
                    ).asJsonObject
                    val printed = obj.optJsonObject("printed") ?: continue
                    for ((key, el) in printed.entrySet()) {
                        if (!el.isJsonNull) printedStates[key] = el.asBoolean
                    }
                } catch (e: Exception) {
                    // 打印状态查询失败不影响列表展示,静默
                }
            }
            renderLabels()
        }
    }

    // ── 预览/打印 ──
    // copies 为打印份数(1 或 3),后端按份数循环出纸
    private fun printLabel(row: CarriageRow, copies: Int = 1) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                Api.post(
                    "/admin/api/print-agent/print-container-label",
                    mapOf(
                        "storeId" to row.storeId,
                        "labelId" to row.id,
                        "printer" to Session.labelPrinter,
                        "copies" to copies
                    )
                )
                printedStates[row.id.toString()] = true
                renderLabels()
                toast("已发送打印任务 #${row.id} × $copies")
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    /** 货运标签预览:后端拉 PDF → 渲染 PNG(旋转 90°) → 返回每页 base64,对话框支持多页翻页 */
    private fun previewLabel(row: CarriageRow) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val obj = Api.post(
                    "/admin/api/print-agent/preview-container-label",
                    mapOf("storeId" to row.storeId, "labelId" to row.id)
                ).asJsonObject
                val images = mutableListOf<String>()
                obj.getAsJsonArray("images")?.forEach { images.add(it.asString) }
                if (images.isEmpty()) {
                    val single = obj.optString("imageDataUrl")
                    if (single.isNotBlank()) images.add(single)
                }
                if (images.isEmpty()) {
                    toast("预览图拉取失败,请检查打印组件后重试")
                    return@launch
                }
                val bitmaps = withContext(Dispatchers.IO) {
                    images.mapNotNull { img ->
                        val base64 = img.substringAfter("base64,")
                        val bytes = Base64.decode(base64, Base64.DEFAULT)
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    }
                }
                if (bitmaps.isEmpty()) {
                    toast("预览图解析失败")
                    return@launch
                }

                val imageView = ImageView(requireContext()).apply {
                    adjustViewBounds = true
                    setPadding(dp(12f), dp(12f), dp(12f), dp(12f))
                }
                val pageTv = TextView(requireContext()).apply {
                    gravity = Gravity.CENTER
                    textSize = 12f
                    setTextColor(Color.parseColor("#86909c"))
                    setPadding(dp(4f), dp(2f), dp(4f), dp(2f))
                }
                val prevBtn = Button(requireContext()).apply { text = "上一页" }
                val nextBtn = Button(requireContext()).apply { text = "下一页" }
                val btnRow = LinearLayout(requireContext()).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER
                    addView(prevBtn)
                    addView(nextBtn)
                }
                val container = LinearLayout(requireContext()).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(imageView)
                    addView(pageTv)
                    if (bitmaps.size > 1) addView(btnRow)
                }

                var pageIndex = 0
                fun updatePage() {
                    imageView.setImageBitmap(bitmaps[pageIndex])
                    pageTv.text = if (bitmaps.size > 1) "第 ${pageIndex + 1}/${bitmaps.size} 页" else ""
                    prevBtn.isEnabled = pageIndex > 0
                    nextBtn.isEnabled = pageIndex < bitmaps.size - 1
                }
                prevBtn.setOnClickListener {
                    if (pageIndex > 0) { pageIndex--; updatePage() }
                }
                nextBtn.setOnClickListener {
                    if (pageIndex < bitmaps.size - 1) { pageIndex++; updatePage() }
                }
                updatePage()

                AlertDialog.Builder(requireContext())
                    .setTitle("货运标签 #${row.id} 预览(${bitmaps.size}页)")
                    .setView(container)
                    .setPositiveButton("关闭", null)
                    .show()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 打印机(与扫描发货共用 Session.labelPrinter) ──
    private fun refreshPrinterStatus() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/print-agent/status").asJsonObject
                if (data.optBoolean("online")) {
                    val defaultPrinter = data.optString("defaultPrinter")
                    val name = Session.labelPrinter.ifBlank { defaultPrinter.ifBlank { "默认" } }
                    printerBar.text = "🖨 $name · 在线"
                    printerBar.setTextColor(Color.parseColor("#00b42a"))
                    printerBar.setRoundedBg(0xFFE8FFEA.toInt(), 8f)
                } else {
                    printerBar.text = "🖨 组件离线 · 点击重试"
                    printerBar.setTextColor(Color.parseColor("#86909c"))
                    printerBar.setRoundedBg(0xFFF2F3F5.toInt(), 8f)
                }
            } catch (e: Exception) {
                printerBar.text = "🖨 组件离线 · 点击重试"
                printerBar.setTextColor(Color.parseColor("#86909c"))
                printerBar.setRoundedBg(0xFFF2F3F5.toInt(), 8f)
            }
        }
    }

    private fun showPrinterPicker() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/print-agent/status").asJsonObject
                if (!data.optBoolean("online")) {
                    toast("打印组件未连接,请检查 SSH 隧道/打印电脑")
                    refreshPrinterStatus()
                    return@launch
                }
                val options = mutableListOf("默认打印机")
                val printers = data.getAsJsonArray("printers").map { it.asString }
                options.addAll(printers)
                val current = Session.labelPrinter
                val checked = if (current.isBlank()) 0 else options.indexOf(current).coerceAtLeast(0)
                AlertDialog.Builder(requireContext())
                    .setTitle("选择标签打印机")
                    .setSingleChoiceItems(options.toTypedArray(), checked) { dialog, which ->
                        Session.labelPrinter = if (which == 0) "" else options[which]
                        dialog.dismiss()
                        refreshPrinterStatus()
                    }
                    .setNegativeButton("取消", null)
                    .show()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    private fun handleError(e: Exception) {
        if (e is ApiException && e.code == 401) {
            toast("登录已过期,请重新登录")
            startActivity(Intent(requireContext(), LoginActivity::class.java))
            requireActivity().finish()
        } else {
            toast(e.message ?: "请求失败")
        }
    }

    private fun toast(msg: String) {
        Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }
}

/** JsonObject 安全取值:键不存在/为 null 时返回 null,避免 getAsJsonArray 空指针 */
private fun JsonObject.optJsonObject(key: String): JsonObject? =
    get(key)?.takeIf { it.isJsonObject }?.asJsonObject

private fun JsonObject.optJsonArray(key: String): JsonArray? =
    get(key)?.takeIf { it.isJsonArray }?.asJsonArray