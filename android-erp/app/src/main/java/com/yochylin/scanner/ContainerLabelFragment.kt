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
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optString
import com.yochylin.scanner.model.OrderStatsStoresResponse
import com.yochylin.scanner.model.StoreItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 货运标签(2026-10-26,底部导航第 5 个 Tab):
 * 按店铺拉取 Ozon 发运清单(methods[].carriages),每个发运 id 即货运标签 ID,
 * 支持菜鸟组件无纸预览 + 服务端直打印,并展示已打印状态。
 */
class ContainerLabelFragment : Fragment() {

    private lateinit var storeBtn: TextView
    private lateinit var printerBar: TextView
    private lateinit var labelList: LinearLayout
    private lateinit var emptyText: TextView

    private var allStores: List<StoreItem> = emptyList()
    private var selectedStoreId: String = ""
    private var selectedStoreName: String = ""

    /** 当前展示的标签行(重建卡片用) */
    private val shownLabels = mutableListOf<LabelRow>()
    private val printedStates = mutableMapOf<String, Boolean>()

    private data class LabelRow(
        val id: Long,
        val storeId: String,
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
        storeBtn = view.findViewById(R.id.storeBtn)
        printerBar = view.findViewById(R.id.printerBar)
        labelList = view.findViewById(R.id.labelList)
        emptyText = view.findViewById(R.id.emptyText)
        view.findViewById<TextView>(R.id.refreshBtn).setOnClickListener {
            if (selectedStoreId.isBlank()) loadStores() else loadLabels()
        }

        storeBtn.setOnClickListener { showStoreDialog() }
        printerBar.setOnClickListener { showPrinterPicker() }

        refreshPrinterStatus()
        loadStores()
    }

    // ── 店铺选择 ──
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
                val exists = allStores.any { it.id == selectedStoreId }
                if (!exists) {
                    val first = allStores.first()
                    selectedStoreId = first.id ?: ""
                    selectedStoreName = first.name ?: selectedStoreId
                }
                updateStoreBtn()
                loadLabels()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    private fun showStoreDialog() {
        if (allStores.isEmpty()) {
            toast("店铺列表为空")
            return
        }
        val names = allStores.map { it.name ?: it.id ?: "" }.toTypedArray()
        val ids = allStores.map { it.id ?: "" }
        val checked = ids.indexOf(selectedStoreId).coerceAtLeast(0)
        AlertDialog.Builder(requireContext())
            .setTitle("选择店铺")
            .setSingleChoiceItems(names, checked) { dialog, which ->
                selectedStoreId = ids[which]
                selectedStoreName = names[which]
                updateStoreBtn()
                dialog.dismiss()
                loadLabels()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun updateStoreBtn() {
        val name = selectedStoreName.ifBlank { selectedStoreId }
        storeBtn.text = if (name.isBlank()) "选择店铺 ▾" else "$name ▾"
    }

    // ── 标签列表 ──
    private fun loadLabels() {
        if (selectedStoreId.isBlank()) {
            showEmpty("请先选择店铺")
            return
        }
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                showEmpty("")
                val obj = Api.post(
                    "/admin/api/print-agent/container-labels",
                    mapOf("storeId" to selectedStoreId, "cursor" to "", "limit" to 1000)
                ).asJsonObject
                val data = obj.getAsJsonObject("data")
                val methods = data.getAsJsonArray("methods") ?: JsonArray()
                val rows = mutableListOf<LabelRow>()
                for (m in methods) {
                    val mo = m.asJsonObject
                    val methodName = mo.optString("delivery_method_name")
                    val departureDate = mo.optString("departure_date")
                    val carriages = mo.getAsJsonArray("carriages") ?: JsonArray()
                    for (c in carriages) {
                        val co = c.asJsonObject
                        val id = co.optDouble("id", 0.0).toLong()
                        if (id <= 0) continue
                        rows.add(
                            LabelRow(
                                id = id,
                                storeId = selectedStoreId,
                                status = co.optString("status"),
                                methodName = methodName,
                                departureDate = departureDate,
                                postingsCount = fmtCount(co, "postings_count"),
                                quantumCount = fmtCount(co, "quantum_count")
                            )
                        )
                    }
                }
                // 出发日期倒序,同日按 ID 倒序(与 web 端一致)
                rows.sortWith(compareByDescending<LabelRow> { it.departureDate }.thenByDescending { it.id })
                shownLabels.clear()
                shownLabels.addAll(rows)
                renderLabels()
                if (rows.isEmpty()) {
                    showEmpty("该店铺暂无货运标签")
                } else {
                    checkPrinted(rows)
                }
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    /** 数字字段可能是 number/string/null,统一转展示文本 */
    private fun fmtCount(obj: com.google.gson.JsonObject, key: String): String {
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

        // 头部:标签 ID + 已打印状态
        val header = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(
            TextView(requireContext()).apply {
                text = "#${row.id}"
                setTextColor(Color.parseColor("#1d2129"))
                textSize = 16f
                typeface = android.graphics.Typeface.MONOSPACE
                setTypeface(typeface, android.graphics.Typeface.BOLD)
            },
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
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

    // ── 打印状态回填 ──
    private fun checkPrinted(rows: List<LabelRow>) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val ids = rows.map { it.id }.joinToString(",")
                if (ids.isBlank()) return@launch
                val obj = Api.get(
                    "/admin/api/print-agent/container-label-print-status",
                    mapOf("storeId" to selectedStoreId, "labelIds" to ids)
                ).asJsonObject
                val printed = obj.getAsJsonObject("data").getAsJsonObject("printed")
                for ((key, el) in printed.entrySet()) {
                    if (!el.isJsonNull) printedStates[key] = el.asBoolean
                }
                renderLabels()
            } catch (e: Exception) {
                // 打印状态查询失败不影响列表展示,静默
            }
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

    /** 菜鸟组件无纸预览:后端拉 PDF → 渲染 PNG(旋转 90°) → 返回 base64,对话框显示 */
    private fun previewLabel(row: LabelRow) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val obj = Api.post(
                    "/admin/api/print-agent/preview-container-label",
                    mapOf("storeId" to row.storeId, "labelId" to row.id)
                ).asJsonObject
                val data = obj.getAsJsonObject("data")
                val imageDataUrl = data.optString("imageDataUrl")
                if (imageDataUrl.isBlank()) {
                    toast("预览图拉取失败,请检查打印组件后重试")
                    return@launch
                }
                val base64 = imageDataUrl.substringAfter("base64,")
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val bmp = withContext(Dispatchers.IO) {
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }
                if (bmp == null) {
                    toast("预览图解析失败")
                    return@launch
                }
                val imageView = ImageView(requireContext()).apply {
                    setImageBitmap(bmp)
                    adjustViewBounds = true
                    setPadding(dp(12f), dp(12f), dp(12f), dp(12f))
                }
                AlertDialog.Builder(requireContext())
                    .setTitle("货运标签 #${row.id} 预览")
                    .setView(imageView)
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