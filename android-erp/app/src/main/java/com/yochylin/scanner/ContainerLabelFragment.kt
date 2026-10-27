package com.yochylin.scanner

import android.app.AlertDialog
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Bundle
import android.util.Base64
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
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
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 货运标签(2026-10-26,底部导航第 5 个 Tab):
 * 同时汇总所有店铺的 Ozon 发运清单(methods[].carriages),每个发运 id 即货运标签 ID,
 * 支持菜鸟组件无纸预览 + 服务端直打印,并展示已打印状态。
 */
class ContainerLabelFragment : Fragment() {

    private lateinit var printerBar: TextView
    private lateinit var labelList: LinearLayout
    private lateinit var emptyText: TextView

    private var allStores: List<StoreItem> = emptyList()

    /** 当前展示的标签行(重建卡片用) */
    private val shownLabels = mutableListOf<LabelRow>()
    private val printedStates = mutableMapOf<String, Boolean>()

    private data class LabelRow(
        val id: Long,
        val storeId: String,
        val storeName: String,
        val status: String,
        val methodName: String,
        val departureDate: String,
        val postingsCount: String,
        val quantumCount: String
    )

    // Ozon 发运状态中文文案(未知值原样展示,与 web 端一致)
    private fun statusLabel(status: String): String = when (status) {
        "formed" -> "已形成"
        "created" -> "已创建"
        "awaiting_delivery", "awaiting_delivering" -> "待发运"
        "delivering" -> "运输中"
        "delivered" -> "已送达"
        "cancelled" -> "已取消"
        else -> status.ifBlank { "—" }
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
        view.findViewById<TextView>(R.id.refreshBtn).setOnClickListener { loadAllLabels() }

        printerBar.setOnClickListener { showPrinterPicker() }

        refreshPrinterStatus()
        loadStores()
    }

    // ── 店铺列表(仅用于并行拉取标签) ──
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
                loadAllLabels()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 并行汇总所有店铺的货运标签 ──
    private fun loadAllLabels() {
        if (allStores.isEmpty()) {
            showEmpty("无可用店铺")
            return
        }
        viewLifecycleOwner.lifecycleScope.launch {
            showEmpty("")
            try {
                val rows = coroutineScope {
                    allStores.map { store ->
                        async(Dispatchers.IO) { fetchStoreLabels(store) }
                    }.awaitAll().flatten()
                }
                // 出发日期倒序,同日按 ID 倒序(与 web 端一致)
                rows.sortedWith(
                    compareByDescending<LabelRow> { it.departureDate }
                        .thenByDescending { it.id }
                ).let {
                    shownLabels.clear()
                    shownLabels.addAll(it)
                }
                renderLabels()
                if (shownLabels.isEmpty()) {
                    showEmpty("暂无货运标签")
                } else {
                    checkPrinted(shownLabels)
                }
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    /** 单个店铺拉取(失败不影响其他店铺),返回空列表 */
    private suspend fun fetchStoreLabels(store: StoreItem): List<LabelRow> {
        val storeId = store.id ?: ""
        val storeName = store.name ?: storeId
        if (storeId.isBlank()) return emptyList()
        return try {
            // 注意:Api.post 已解包 envelope 的 data(Ozon 响应体 { cursor, methods, ... }),直接取 methods
            val obj = Api.post(
                "/admin/api/print-agent/container-labels",
                mapOf("storeId" to storeId, "cursor" to "", "limit" to 1000)
            ).asJsonObject
            val methods = obj.optJsonArray("methods") ?: JsonArray()
            val rows = mutableListOf<LabelRow>()
            for (m in methods) {
                val mo = m.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                val methodName = mo.optString("delivery_method_name")
                val departureDate = mo.optString("departure_date")
                val carriages = mo.optJsonArray("carriages") ?: JsonArray()
                for (c in carriages) {
                    val co = c.takeIf { it.isJsonObject }?.asJsonObject ?: continue
                    val id = co.optDouble("id", 0.0).toLong()
                    if (id <= 0) continue
                    rows.add(
                        LabelRow(
                            id = id,
                            storeId = storeId,
                            storeName = storeName,
                            status = co.optString("status"),
                            methodName = methodName,
                            departureDate = departureDate,
                            postingsCount = fmtCount(co, "postings_count"),
                            quantumCount = fmtCount(co, "quantum_count")
                        )
                    )
                }
            }
            rows
        } catch (e: Exception) {
            // 单个店铺加载失败(如 Ozon 接口抖动)时忽略,不影响其他店铺
            emptyList()
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

    private fun renderLabels() {
        labelList.removeAllViews()
        for (row in shownLabels) {
            labelList.addView(buildLabelCard(row))
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

    private fun buildLabelCard(row: LabelRow): View {
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

        // 头部:店铺名标签 + 标签 ID + 已打印状态
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
        val printed = printedStates[row.id.toString()] ?: false
        header.addView(buildStatusTag(printed))
        card.addView(header)

        // 第二行:配送方式 + 出发日期
        val metaRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        metaRow.addView(
            TextView(requireContext()).apply {
                text = row.methodName.ifBlank { "配送方式未知" }
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

        // 明细:状态 · 包裹数 · 量子数
        val detail = TextView(requireContext()).apply {
            text = "${statusLabel(row.status)} · 包裹 ${row.postingsCount} · 量子 ${row.quantumCount}"
            setTextColor(Color.parseColor("#86909c"))
            textSize = 12f
            setPadding(dp(8f), dp(6f), dp(8f), dp(6f))
            setRoundedBg(0xFFF2F3F5.toInt(), 6f)
        }
        card.addView(detail, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8f) })

        // 操作行:预览 + 打印
        val actionRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }
        actionRow.addView(newButton("预览", Color.parseColor("#165dff")) { previewLabel(row) })
        actionRow.addView(newButton("打印", Color.parseColor("#00b42a")) { printLabel(row) })
        card.addView(actionRow, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(10f) })

        return card
    }

    /** 已打印状态小标签 */
    private fun buildStatusTag(printed: Boolean): TextView {
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

    private fun newButton(text: String, color: Int, onClick: () -> Unit): Button {
        return Button(requireContext()).apply {
            this.text = text
            setTextColor(Color.WHITE)
            textSize = 13f
            isAllCaps = false
            setRoundedBg(color, 10f)
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

    // ── 打印状态回填(按店铺分组查询) ──
    private fun checkPrinted(rows: List<LabelRow>) {
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
    private fun printLabel(row: LabelRow) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                Api.post(
                    "/admin/api/print-agent/print-container-label",
                    mapOf(
                        "storeId" to row.storeId,
                        "labelId" to row.id,
                        "printer" to Session.labelPrinter
                    )
                )
                printedStates[row.id.toString()] = true
                renderLabels()
                toast("已发送打印任务 #${row.id}")
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    /** 货运标签预览(2026-10-27):后端拉 PDF → 渲染 PNG(旋转 90°) → 返回每页 base64,对话框支持多页翻页 */
    private fun previewLabel(row: LabelRow) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                // 已解包 data;多页时 images 为每页一张 PNG dataURL,imageDataUrl 兼容旧版单页
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