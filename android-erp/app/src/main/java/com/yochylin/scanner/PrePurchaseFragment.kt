package com.yochylin.scanner

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import coil.load
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optInt
import com.yochylin.scanner.api.optLong
import com.yochylin.scanner.api.optString
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 预采购(2026-11-16):提前采购、暂不绑定 Ozon 订单;到货后扫描快递单号签收。
 * 顶部 tab:全部/待收货/签收 + 新增预采购/扫描签收按钮;列表支持单笔签收。
 */
class PrePurchaseFragment : Fragment() {

    private lateinit var tabAll: TextView
    private lateinit var tabPending: TextView
    private lateinit var tabReceived: TextView
    private lateinit var summaryTv: TextView
    private lateinit var listScroll: ScrollView
    private lateinit var listContainer: LinearLayout

    private var currentTab = "all"
    private val rows = mutableListOf<Row>()

    private data class TraceNode(val acceptTime: String, val remark: String)
    private data class Row(
        val id: Long,
        val platform: String,
        val purchaseSn: String,
        val logisticsCompany: String,
        val logisticsNo: String,
        val picUrl: String,
        val paymentAmount: Double,
        val receiveStatus: String,
        val receivedAt: String,
        val itemSummary: String,
        val trace: List<TraceNode>,
        val lastTraceAt: String,
        val lastTraceDesc: String,
    )

    private val scanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val code = result.data?.getStringExtra("code") ?: ""
            if (code.isNotBlank()) searchAndReceive(code)
        }
    }

    private val createLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) loadList()
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.fragment_pre_purchase, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        tabAll = view.findViewById(R.id.preTabAll)
        tabPending = view.findViewById(R.id.preTabPending)
        tabReceived = view.findViewById(R.id.preTabReceived)
        summaryTv = view.findViewById(R.id.preSummary)
        listScroll = view.findViewById(R.id.preListScroll)
        listContainer = view.findViewById(R.id.preList)

        tabAll.setOnClickListener { switchTab("all") }
        tabPending.setOnClickListener { switchTab("pending") }
        tabReceived.setOnClickListener { switchTab("received") }
        view.findViewById<TextView>(R.id.preCreateBtn).setOnClickListener { openCreate() }
        view.findViewById<TextView>(R.id.preScanReceiveBtn).setOnClickListener { startScanReceive() }

        updateTabStyle()
        loadList()
    }

    private fun switchTab(tab: String) {
        if (currentTab == tab) return
        currentTab = tab
        updateTabStyle()
        loadList()
    }

    private fun updateTabStyle() {
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density + 0.5f).toInt()
        for ((tv, key) in listOf(tabAll to "all", tabPending to "pending", tabReceived to "received")) {
            val active = currentTab == key
            tv.setTextColor(Color.parseColor(if (active) "#165dff" else "#86909c"))
            tv.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
            tv.setRoundedBg(if (active) Color.parseColor("#e8f3ff") else Color.TRANSPARENT, 8f)
        }
    }

    private fun loadList() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val data = Api.get(
                    "/admin/api/pre-purchase/list",
                    mapOf("tab" to currentTab, "page" to 1, "pageSize" to 100)
                ).asJsonObject
                val obj = data.getAsJsonObject("data") ?: data
                val items = obj.getAsJsonArray("items")
                rows.clear()
                if (items != null) {
                    for (el in items) {
                        val o = el.asJsonObject
                        val goods = o.getAsJsonArray("items")
                        val summary = StringBuilder()
                        var picUrl = ""
                        if (goods != null) {
                            for (g in goods) {
                                val go = g.asJsonObject
                                if (picUrl.isBlank()) {
                                    val u = go.optString("thumbUrl").ifBlank { go.optString("picUrl") }
                                    if (u.isNotBlank()) picUrl = u
                                }
                                val name = go.optString("goodsName").ifBlank { go.optString("title") }
                                val num = go.optDouble("number", go.optDouble("num", 1.0))
                                if (name.isNotBlank()) {
                                    if (summary.isNotEmpty()) summary.append(" / ")
                                    summary.append(name)
                                    if (num > 0) summary.append("×").append(num.toInt())
                                }
                            }
                        }
                        val trace = mutableListOf<TraceNode>()
                        o.getAsJsonArray("trace")?.forEach { tel ->
                            val to = tel.asJsonObject
                            trace.add(TraceNode(to.optString("acceptTime"), to.optString("remark")))
                        }
                        rows.add(
                            Row(
                                id = o.optLong("id"),
                                platform = o.optString("platform"),
                                purchaseSn = o.optString("purchaseSn"),
                                logisticsCompany = o.optString("logisticsCompany"),
                                logisticsNo = o.optString("logisticsNo"),
                                picUrl = picUrl,
                                paymentAmount = o.optDouble("paymentAmount"),
                                receiveStatus = o.optString("receiveStatus"),
                                receivedAt = o.optString("receivedAt"),
                                itemSummary = summary.toString(),
                                trace = trace,
                                lastTraceAt = o.optString("lastTraceAt"),
                                lastTraceDesc = o.optString("lastTraceDesc"),
                            )
                        )
                    }
                }
                val counts = obj.getAsJsonObject("counts")
                val all = counts?.optInt("all") ?: rows.size
                val pending = counts?.optInt("pending") ?: rows.count { it.receiveStatus == "pending" }
                val received = counts?.optInt("received") ?: rows.count { it.receiveStatus == "received" }
                summaryTv.text = "共 $all 笔 · 待收货 $pending · 已签收 $received"
                renderList()
            } catch (e: Exception) {
                rows.clear()
                renderList()
                toast(e.message ?: "加载失败")
            }
        }
    }

    private fun renderList() {
        if (view == null) return
        listContainer.removeAllViews()
        if (rows.isEmpty()) {
            listContainer.addView(TextView(requireContext()).apply {
                text = when (currentTab) {
                    "pending" -> "暂无待收货预采购"
                    "received" -> "暂无已签收预采购"
                    else -> "暂无预采购订单"
                }
                setTextColor(Color.parseColor("#a6abb3"))
                textSize = 13f
                gravity = android.view.Gravity.CENTER
                setPadding(0, dp(30), 0, dp(30))
            })
            return
        }
        for (row in rows) listContainer.addView(buildRow(row))
    }

    private fun buildRow(row: Row): View {
        val ctx = requireContext()
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setRoundedBg(Color.WHITE, 10f)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(8) }
        }
        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        head.addView(TextView(ctx).apply {
            text = platformLabel(row.platform)
            setTextColor(Color.parseColor("#165dff"))
            textSize = 11f
            setRoundedBg(Color.parseColor("#eef4ff"), 4f)
            setPadding(dp(6), dp(2), dp(6), dp(2))
        })
        head.addView(TextView(ctx).apply {
            text = row.purchaseSn.ifBlank { "#${row.id}" }
            setTextColor(Color.parseColor("#1f2329"))
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setPadding(dp(8), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        head.addView(TextView(ctx).apply {
            text = if (row.receiveStatus == "received") "已签收" else "待收货"
            setTextColor(Color.parseColor(if (row.receiveStatus == "received") "#0b7a2d" else "#d97706"))
            textSize = 11f
            setRoundedBg(Color.parseColor(if (row.receiveStatus == "received") "#e8ffea" else "#fff7e6"), 6f)
            setPadding(dp(8), dp(2), dp(8), dp(2))
        })
        card.addView(head)

        if (row.itemSummary.isNotBlank() || row.picUrl.isNotBlank()) {
            val goodsRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(6), 0, 0)
            }
            val img = ImageView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(dp(40), dp(40))
                scaleType = ImageView.ScaleType.CENTER_CROP
                setBackgroundColor(Color.parseColor("#f2f3f5"))
            }
            if (row.picUrl.isNotBlank()) {
                img.load(if (row.picUrl.startsWith("/")) Api.BASE_URL + row.picUrl else row.picUrl)
            }
            goodsRow.addView(img)
            goodsRow.addView(TextView(ctx).apply {
                text = row.itemSummary
                setTextColor(Color.parseColor("#4e5969"))
                textSize = 12f
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(dp(8), 0, 0, 0)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            card.addView(goodsRow)
        }
        val meta = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, dp(4), 0, 0)
        }
        meta.addView(TextView(ctx).apply {
            text = "快递公司:${row.logisticsCompany.ifBlank { "—" }} · 快递单号:${row.logisticsNo.ifBlank { "—" }} · ${fmtMoney(row.paymentAmount)}"
            setTextColor(Color.parseColor("#86909c"))
            textSize = 11f
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        if (row.receiveStatus == "pending") {
            meta.addView(TextView(ctx).apply {
                text = "签收"
                setTextColor(Color.WHITE)
                textSize = 12f
                setRoundedBg(Color.parseColor("#165dff"), 8f)
                setPadding(dp(14), dp(5), dp(14), dp(5))
                setOnClickListener { manualReceive(row) }
            })
        } else if (row.receivedAt.isNotBlank()) {
            meta.addView(TextView(ctx).apply {
                text = fmtTime(row.receivedAt)
                setTextColor(Color.parseColor("#86909c"))
                textSize = 11f
            })
        }
        card.addView(meta)

        // 物流轨迹(2026-11-16):最新一条 + 展开全部
        if (row.lastTraceDesc.isNotBlank()) {
            card.addView(TextView(ctx).apply {
                text = "最新轨迹:${fmtTime(row.lastTraceAt)} ${row.lastTraceDesc}"
                setTextColor(Color.parseColor("#4e5969"))
                textSize = 11f
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(0, dp(4), 0, 0)
            })
        } else {
            card.addView(TextView(ctx).apply {
                text = "暂无轨迹"
                setTextColor(Color.parseColor("#a6abb3"))
                textSize = 11f
                setPadding(0, dp(4), 0, 0)
            })
        }
        if (row.trace.isNotEmpty()) {
            val traceBox = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                visibility = View.GONE
                setPadding(0, dp(4), 0, 0)
            }
            for (t in row.trace.take(30)) {
                traceBox.addView(TextView(ctx).apply {
                    text = "${fmtTime(t.acceptTime)}  ${t.remark}"
                    setTextColor(Color.parseColor("#86909c"))
                    textSize = 11f
                })
            }
            val toggle = TextView(ctx).apply {
                text = "展开轨迹(${row.trace.size})"
                setTextColor(Color.parseColor("#165dff"))
                textSize = 12f
                setPadding(0, dp(4), 0, 0)
                setOnClickListener {
                    val show = traceBox.visibility != View.VISIBLE
                    traceBox.visibility = if (show) View.VISIBLE else View.GONE
                    text = if (show) "收起轨迹" else "展开轨迹(${row.trace.size})"
                }
            }
            card.addView(toggle)
            card.addView(traceBox)
        }
        return card
    }

    private fun openCreate() {
        createLauncher.launch(Intent(requireContext(), PrePurchaseCreateActivity::class.java))
    }

    private fun startScanReceive() {
        scanLauncher.launch(Intent(requireContext(), ScanActivity::class.java))
    }

    /** 扫描后:按快递单号查 pending 预采购 → 二次确认签收 */
    private fun searchAndReceive(code: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val data = Api.post(
                    "/admin/api/pre-purchase/receive-by-code",
                    mapOf("logisticsNo" to code)
                ).asJsonObject
                val arr = data.getAsJsonArray("matches")
                if (arr == null || arr.size() == 0) {
                    toast("未匹配到待收货预采购:$code")
                    return@launch
                }
                val ids = mutableListOf<Long>()
                val desc = StringBuilder()
                for (el in arr) {
                    val o = el.asJsonObject
                    val id = o.optLong("id")
                    ids.add(id)
                    val sn = o.optString("purchaseSn")
                    val name = o.getAsJsonArray("items")?.firstOrNull()?.asJsonObject
                        ?.optString("goodsName") ?: ""
                    if (desc.isNotEmpty()) desc.append("\n")
                    desc.append(platformLabel(o.optString("platform"))).append(" ")
                        .append(sn.ifBlank { "#$id" })
                    if (name.isNotBlank()) desc.append(" · ").append(name)
                }
                AlertDialog.Builder(requireContext())
                    .setTitle("预采购确认签收")
                    .setMessage("发现待收货预采购订单:\n$desc\n\n是否确认签收?")
                    .setPositiveButton("确认签收") { _, _ -> confirmReceive(ids) }
                    .setNegativeButton("取消", null)
                    .show()
            } catch (e: Exception) {
                toast(e.message ?: "查询失败")
            }
        }
    }

    private fun confirmReceive(ids: List<Long>) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                Api.post(
                    "/admin/api/pre-purchase/receive",
                    mapOf("ids" to ids, "by" to "scan")
                )
                toast("已签收 ${ids.size} 笔预采购")
                loadList()
            } catch (e: Exception) {
                toast(e.message ?: "签收失败")
            }
        }
    }

    private fun manualReceive(row: Row) {
        confirmReceive(listOf(row.id))
    }

    // ── 工具 ──
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()
    private fun toast(msg: String) {
        if (isAdded) android.widget.Toast.makeText(requireContext(), msg, android.widget.Toast.LENGTH_SHORT).show()
    }
    private fun platformLabel(p: String?): String = when (p) {
        "pdd", "yangkeduo" -> "拼多多"
        "ali1688", "1688" -> "1688"
        "taobao" -> "淘宝"
        "xianyu" -> "闲鱼"
        "other" -> "手工"
        else -> p ?: "—"
    }
    private fun fmtMoney(v: Double): String = "¥" + String.format(java.util.Locale.US, "%.2f", v)
    private fun fmtTime(t: String?): String {
        if (t.isNullOrBlank()) return "—"
        return try {
            val d = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).parse(t.take(19))
            if (d != null) java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault()).format(d) else t
        } catch (_: Exception) { t }
    }
}
