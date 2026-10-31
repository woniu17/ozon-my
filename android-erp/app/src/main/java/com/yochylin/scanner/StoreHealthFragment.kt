package com.yochylin.scanner

import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.yochylin.scanner.adapter.StoreHealthErrorAdapter
import com.yochylin.scanner.adapter.fmtMoney
import com.yochylin.scanner.adapter.fmtNum
import com.yochylin.scanner.adapter.fmtTime
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.model.RatingErrorItem
import com.yochylin.scanner.model.RatingErrorsResponse
import com.yochylin.scanner.model.RatingErrorTotals
import com.yochylin.scanner.model.RatingHealthSummaryResponse
import com.yochylin.scanner.model.RatingStoreHealth
import com.yochylin.scanner.model.StoreItem
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/** 店铺健康：Ozon 错误指数概览/趋势/分布/影响货件明细(2026-11-03) */
class StoreHealthFragment : Fragment() {

    companion object {
        private const val COLOR_PRIMARY = "#165dff"
        private const val COLOR_MUTE = "#86909c"
        private const val COLOR_TEXT = "#1f2329"
        private const val COLOR_OK = "#00b42a"
        private const val COLOR_WARN = "#d97706"
        private const val COLOR_ERR = "#f53f3f"
        private const val PAGE_LIMIT = 50

        private data class Preset(val key: String, val label: String)
    }

    private lateinit var presetContainer: LinearLayout
    private lateinit var rangeHint: TextView
    private lateinit var storeBtn: TextView
    private lateinit var overviewContainer: LinearLayout
    private lateinit var trendContainer: LinearLayout
    private lateinit var distContainer: LinearLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var recyclerView: RecyclerView
    private lateinit var loadMoreBtn: TextView
    private lateinit var syncBtn: TextView

    private val adapter = StoreHealthErrorAdapter()

    private var activePreset = "7d"
    private var from = ""
    private var to = ""
    private var errorTotal = 0
    private var isLoadingMore = false
    private var syncing = false

    private var allStores: List<StoreItem> = emptyList()
    private var selectedStoreIds: Set<String> = emptySet() // 空 = 全选

    private val presets = listOf(
        Preset("7d", "近7日"),
        Preset("30d", "近30日"),
        Preset("thisMonth", "本月"),
        Preset("lastMonth", "上月"),
        Preset("custom", "自定义"),
    )

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.activity_store_health, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        if (!Session.isLoggedIn) {
            goLogin()
            return
        }

        // 顶部返回按钮由宿主管理，隐藏
        view.findViewById<View>(R.id.healthBackBtn).visibility = View.GONE

        presetContainer = view.findViewById(R.id.healthPresetContainer)
        rangeHint = view.findViewById(R.id.healthRangeHint)
        storeBtn = view.findViewById(R.id.healthStoreBtn)
        overviewContainer = view.findViewById(R.id.healthOverviewContainer)
        trendContainer = view.findViewById(R.id.healthTrendContainer)
        distContainer = view.findViewById(R.id.healthDistContainer)
        progressBar = view.findViewById(R.id.healthProgress)
        recyclerView = view.findViewById(R.id.healthErrorList)
        loadMoreBtn = view.findViewById(R.id.healthLoadMoreBtn)
        syncBtn = view.findViewById(R.id.healthSyncBtn)

        recyclerView.layoutManager = LinearLayoutManager(requireContext())
        recyclerView.adapter = adapter
        adapter.onItemClick = { copyPostingNumber(it) }

        syncBtn.setOnClickListener { triggerSync() }
        loadMoreBtn.setOnClickListener { loadMoreErrors() }
        storeBtn.setOnClickListener { showStoreDialog() }

        buildPresets()
        applyPreset("7d")
        loadStores()
    }

    // ── 时间预设 ──
    private fun buildPresets() {
        presetContainer.removeAllViews()
        for ((i, p) in presets.withIndex()) {
            val tv = TextView(requireContext()).apply {
                text = p.label
                textSize = 12f
                setPadding(dp(22).toInt(), dp(9).toInt(), dp(22).toInt(), dp(9).toInt())
                gravity = Gravity.CENTER
            }
            updateStyle(tv, p.key == activePreset)
            tv.setOnClickListener { onPresetClick(p.key) }
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.rightMargin = 8
            presetContainer.addView(tv, lp)
        }
    }

    private fun refreshPresetStyles() {
        for (i in 0 until presetContainer.childCount) {
            val child = presetContainer.getChildAt(i)
            if (child is TextView) updateStyle(child, presets[i].key == activePreset)
        }
    }

    private fun updateStyle(tv: TextView, active: Boolean) {
        tv.setTextColor(if (active) Color.WHITE else Color.parseColor("#4e5969"))
        tv.setRoundedBg(
            if (active) Color.parseColor(COLOR_PRIMARY) else Color.parseColor("#f2f3f5"),
            16f
        )
    }

    private fun onPresetClick(key: String) {
        when (key) {
            "custom" -> showCustomDialog()
            else -> applyPreset(key)
        }
    }

    private fun applyPreset(key: String) {
        activePreset = key
        val r = presetRange(key)
        if (r != null) {
            from = r.first
            to = r.second
            refreshPresetStyles()
            updateRangeHint()
            loadData()
        }
    }

    private fun presetRange(key: String): Pair<String, String>? = when (key) {
        "7d" -> shiftDays(todayStr(), -6) to todayStr()
        "30d" -> shiftDays(todayStr(), -29) to todayStr()
        "thisMonth" -> {
            val (y, m) = localDate()
            "$y-${pad(m)}-01" to todayStr()
        }
        "lastMonth" -> {
            val (y, m) = localDate()
            val lm = if (m == 1) 12 else m - 1
            val ly = if (m == 1) y - 1 else y
            val first = "$ly-${pad(lm)}-01"
            val last = shiftDays("$y-${pad(m)}-01", -1)
            first to last
        }
        else -> null
    }

    // ── 自定义日期 ──
    private fun showCustomDialog() {
        val container = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 0)
        }
        val fromInput = EditText(requireContext()).apply {
            hint = "开始日期 YYYY-MM-DD"
            setText(from)
        }
        val toInput = EditText(requireContext()).apply {
            hint = "结束日期 YYYY-MM-DD"
            setText(to)
        }
        container.addView(fromInput)
        container.addView(toInput)
        AlertDialog.Builder(requireContext())
            .setTitle("自定义区间")
            .setView(container)
            .setPositiveButton("确定") { _, _ ->
                val f = fromInput.text.toString().trim()
                val t = toInput.text.toString().trim()
                if (f.isEmpty() || t.isEmpty()) {
                    toast("请填写完整日期")
                } else {
                    activePreset = "custom"
                    from = f
                    to = t
                    refreshPresetStyles()
                    updateRangeHint()
                    loadData()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ── 店铺选择 ──
    private fun loadStores() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/order-stats/stores")
                val resp = Api.parse<com.yochylin.scanner.model.OrderStatsStoresResponse>(data)
                allStores = resp.stores ?: emptyList()
            } catch (e: Exception) {
                allStores = emptyList()
            }
        }
    }

    private fun showStoreDialog() {
        if (allStores.isEmpty()) {
            toast("暂无店铺数据")
            return
        }
        val names = allStores.map { it.name ?: it.id ?: "" }.toTypedArray()
        val ids = allStores.map { it.id ?: "" }
        val checked = BooleanArray(ids.size) {
            selectedStoreIds.isEmpty() || selectedStoreIds.contains(ids[it])
        }
        val dialog = AlertDialog.Builder(requireContext())
            .setTitle("选择店铺(勾选=纳入统计)")
            .setMultiChoiceItems(names, checked) { _, which, isChecked ->
                val id = ids[which]
                if (id.isEmpty()) return@setMultiChoiceItems
                val s = HashSet(selectedStoreIds)
                if (isChecked) s.add(id) else s.remove(id)
                selectedStoreIds = s
            }
            .setNeutralButton("全选", null)
            .setNegativeButton("取消", null)
            .setPositiveButton("确定") { _, _ ->
                storeBtn.text = if (selectedStoreIds.isEmpty()) "全部店铺 ▾" else "已选 ${selectedStoreIds.size}/${ids.size} ▾"
                loadData()
            }
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                selectedStoreIds = emptySet()
                for (i in checked.indices) checked[i] = true
                dialog.listView?.let { lv ->
                    for (i in checked.indices) lv.setItemChecked(i, true)
                }
            }
        }
        dialog.show()
    }

    // ── 数据加载 ──
    private fun loadData() {
        if (from.isEmpty() || to.isEmpty()) return
        viewLifecycleOwner.lifecycleScope.launch {
            progressBar.visibility = View.VISIBLE
            try {
                val params = buildParams()
                val data = Api.get("/admin/api/rating/health/summary", params)
                val resp = Api.parse<RatingHealthSummaryResponse>(data)
                renderTotals(resp.totals)
                renderStores(resp.stores ?: emptyList())
                renderTrend(resp.stores ?: emptyList())
                renderDist(resp.totals)

                // 重置明细分页
                errorTotal = 0
                adapter.setList(emptyList())
                loadMoreErrors(reset = true)
            } catch (e: Exception) {
                if (e is ApiException && e.code == 401) {
                    toast("登录已过期,请重新登录")
                    goLogin()
                } else {
                    toast(e.message ?: "加载失败")
                }
            } finally {
                progressBar.visibility = View.GONE
            }
        }
    }

    private fun loadMoreErrors(reset: Boolean = false) {
        if (isLoadingMore) return
        if (!reset && adapter.size() >= errorTotal) {
            loadMoreBtn.visibility = View.GONE
            return
        }
        isLoadingMore = true
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val params = buildParams()
                params["offset"] = if (reset) 0 else adapter.size()
                params["limit"] = PAGE_LIMIT
                val data = Api.get("/admin/api/rating/health/errors", params)
                val resp = Api.parse<RatingErrorsResponse>(data)
                if (reset) {
                    adapter.setList(resp.items ?: emptyList())
                } else {
                    adapter.append(resp.items ?: emptyList())
                }
                errorTotal = resp.total
                updateLoadMore()
            } catch (e: Exception) {
                if (!(e is ApiException && e.code == 401)) {
                    toast(e.message ?: "加载明细失败")
                }
            } finally {
                isLoadingMore = false
            }
        }
    }

    private fun updateLoadMore() {
        loadMoreBtn.visibility = if (adapter.size() < errorTotal) View.VISIBLE else View.GONE
    }

    private fun buildParams(): HashMap<String, Any?> {
        val params = HashMap<String, Any?>()
        params["from"] = from
        params["to"] = to
        if (selectedStoreIds.isNotEmpty()) {
            params["storeIds"] = selectedStoreIds.joinToString(",")
        }
        return params
    }

    // ── 手动同步 ──
    private fun triggerSync() {
        if (syncing) return
        syncing = true
        syncBtn.text = "同步中…"
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = HashMap<String, Any?>()
                if (selectedStoreIds.isNotEmpty()) body["storeIds"] = selectedStoreIds.toList()
                body["from"] = from
                body["to"] = to
                Api.post("/admin/api/rating/health/sync", body)
                for (i in 0 until 60) {
                    delay(1000)
                    val st = Api.get("/admin/api/rating/health/sync-status")
                    val running = st.asJsonObject.get("running")?.asBoolean ?: false
                    if (!running) break
                }
                loadData()
            } catch (e: Exception) {
                if (e is ApiException && e.code == 401) {
                    toast("登录已过期,请重新登录")
                    goLogin()
                } else {
                    toast(e.message ?: "同步失败")
                }
            } finally {
                syncing = false
                syncBtn.text = "同步"
            }
        }
    }

    // ── 概览指标 2x2 ──
    private fun renderTotals(t: RatingErrorTotals?) {
        overviewContainer.removeAllViews()
        val totals = t ?: return
        val defs = listOf(
            Triple("影响货件", totals.errorPostingCount, COLOR_PRIMARY),
            Triple("卖家取消", totals.sellerCancellationCount, COLOR_ERR),
            Triple("卖家逾期", totals.sellerDelayCount, COLOR_WARN),
            Triple("宽限中", totals.graceCount, COLOR_OK),
        )
        for (row in 0 until 2) {
            val rowLay = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(110).toInt()
                ).apply { if (row > 0) topMargin = dp(12).toInt() }
            }
            for (col in 0 until 2) {
                val (title, count, color) = defs[row * 2 + col]
                val card = metricCard(title, count, color)
                val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
                if (col > 0) lp.leftMargin = dp(12).toInt()
                rowLay.addView(card, lp)
            }
            overviewContainer.addView(rowLay)
        }

        // 处理费用横条
        val chargeRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setRoundedBg(Color.WHITE, 16f)
            elevation = dp(2f)
            setPadding(dp(14).toInt(), dp(10).toInt(), dp(14).toInt(), dp(10).toInt())
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(12).toInt() }
        }
        chargeRow.addView(TextView(requireContext()).apply {
            text = "错误处理费用"
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        chargeRow.addView(TextView(requireContext()).apply {
            text = "¥ ${fmtMoney(totals.chargeSum)}"
            setTextColor(Color.parseColor(COLOR_PRIMARY))
            textSize = 15f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        overviewContainer.addView(chargeRow)
    }

    private fun metricCard(title: String, count: Int, dotColor: String): LinearLayout {
        val ctx = requireContext()
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setRoundedBg(Color.WHITE, 16f)
            elevation = dp(2f)
            setPadding(dp(14).toInt(), dp(12).toInt(), dp(14).toInt(), dp(12).toInt())

            addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(View(ctx).apply {
                    setRoundedBg(Color.parseColor(dotColor), 4f)
                    layoutParams = LinearLayout.LayoutParams(dp(8).toInt(), dp(8).toInt()).apply {
                        rightMargin = dp(6).toInt()
                    }
                })
                addView(TextView(ctx).apply {
                    text = title
                    setTextColor(Color.parseColor(COLOR_MUTE))
                    textSize = 12f
                })
            })

            addView(TextView(ctx).apply {
                text = count.toString()
                setTextColor(Color.parseColor(COLOR_TEXT))
                textSize = 26f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                setPadding(0, dp(8).toInt(), 0, 0)
            })

            addView(TextView(ctx).apply {
                text = "单"
                setTextColor(Color.parseColor(COLOR_MUTE))
                textSize = 11f
                setPadding(0, dp(2).toInt(), 0, 0)
            })
        }
    }

    // ── 店铺健康对比(横向条形图) ──
    private fun renderStores(stores: List<RatingStoreHealth>) {
        trendContainer.removeAllViews()
        if (stores.isEmpty()) return
        val card = cardContainer()
        card.addView(sectionTitle("店铺健康对比"))
        for (store in stores) {
            card.addView(storeBarRow(store))
        }
        trendContainer.addView(card)
    }

    private fun storeBarRow(store: RatingStoreHealth): LinearLayout {
        val ctx = requireContext()
        val idx = store.index ?: 0.0
        val fgWeight = ((minOf(idx, 0.5)) / 0.5 * 100).toFloat()
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6).toInt(), 0, dp(6).toInt())

            addView(TextView(ctx).apply {
                text = store.storeName ?: store.storeId ?: "—"
                setTextColor(Color.parseColor(COLOR_TEXT))
                textSize = 11f
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
                layoutParams = LinearLayout.LayoutParams(dp(72).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT)
            })

            // 背景条 + 前景条(weight 比例)
            val barBg = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setRoundedBg(Color.parseColor("#f2f3f5"), 4f)
                layoutParams = LinearLayout.LayoutParams(0, dp(10).toInt(), 1f)
            }
            val fg = View(ctx).apply { setRoundedBg(Color.parseColor(indexColor(idx)), 4f) }
            val spacer = View(ctx)
            barBg.addView(fg, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, fgWeight))
            barBg.addView(spacer, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 100f - fgWeight))
            addView(barBg, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(8).toInt()
                rightMargin = dp(8).toInt()
            })

            addView(TextView(ctx).apply {
                text = fmtNum(idx)
                setTextColor(Color.parseColor(indexColor(idx)))
                textSize = 11f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(dp(48).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT)
            })
        }
    }

    // ── 近7日指数趋势(取指数最高店铺) ──
    private fun renderTrend(stores: List<RatingStoreHealth>) {
        val sorted = stores.sortedByDescending { it.index ?: 0.0 }
        val store = sorted.firstOrNull() ?: return
        val defects = store.defects?.takeLast(7) ?: return
        if (defects.isEmpty()) return

        val card = cardContainer()
        card.addView(sectionTitle("近7日指数趋势 · ${store.storeName}"))

        val maxIdx = maxOf(defects.maxOfOrNull { it.indexByDate ?: 0.0 } ?: 0.0, 0.2)
        val chart = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.BOTTOM
            setPadding(0, dp(10).toInt(), 0, 0)
        }
        for (d in defects) {
            val idx = d.indexByDate ?: 0.0
            val ratio = (idx / maxIdx).toFloat().coerceIn(0.02f, 1f)
            val bar = View(requireContext()).apply {
                setRoundedBg(Color.parseColor(indexColor(idx)), 3f)
                layoutParams = LinearLayout.LayoutParams(
                    dp(18).toInt(),
                    (dp(100f) * ratio).toInt()
                ).apply { gravity = Gravity.CENTER_HORIZONTAL }
            }
            val valTv = TextView(requireContext()).apply {
                text = fmtNum(idx)
                textSize = 9f
                setTextColor(Color.parseColor(indexColor(idx)))
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            val dateTv = TextView(requireContext()).apply {
                text = shortDate(d.date)
                textSize = 9f
                setTextColor(Color.parseColor(COLOR_MUTE))
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            val col = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            col.addView(bar)
            col.addView(valTv)
            col.addView(dateTv)
            chart.addView(col)
        }
        card.addView(chart)
        trendContainer.addView(card)
    }

    // ── 类型/配送方案分布 ──
    private fun renderDist(t: RatingErrorTotals?) {
        distContainer.removeAllViews()
        val totals = t ?: return
        val card = cardContainer()

        // 类型分布
        card.addView(sectionTitle("错误类型分布"))
        val typeRows = listOf(
            "卖家取消" to totals.sellerCancellationCount,
            "卖家逾期" to totals.sellerDelayCount,
        )
        val totalCount = totals.errorPostingCount
        for ((label, n) in typeRows) {
            card.addView(distBarRow(label, n, totalCount, COLOR_PRIMARY))
        }

        // 配送方案分布
        val schemas = totals.schemaCounts?.filter { it.n > 0 } ?: emptyList()
        if (schemas.isNotEmpty()) {
            card.addView(sectionTitle("配送方案分布", topMargin = 10))
            for (s in schemas) {
                card.addView(distBarRow(s.deliverySchema ?: "UNKNOWN", s.n, totalCount, COLOR_WARN))
            }
        }

        if (totalCount == 0 && schemas.isEmpty()) {
            card.addView(TextView(requireContext()).apply {
                text = "该区间无影响错误指数的货件"
                setTextColor(Color.parseColor(COLOR_MUTE))
                textSize = 12f
                setPadding(0, dp(8).toInt(), 0, dp(4).toInt())
            })
        }

        distContainer.addView(card)
    }

    private fun distBarRow(label: String, count: Int, total: Int, color: String): LinearLayout {
        val ctx = requireContext()
        val pct = if (total > 0) count.toFloat() / total else 0f
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(5).toInt(), 0, dp(5).toInt())

            addView(TextView(ctx).apply {
                text = label
                setTextColor(Color.parseColor(COLOR_TEXT))
                textSize = 11f
                layoutParams = LinearLayout.LayoutParams(dp(76).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT)
            })

            val barBg = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setRoundedBg(Color.parseColor("#f2f3f5"), 4f)
                layoutParams = LinearLayout.LayoutParams(0, dp(10).toInt(), 1f)
            }
            val fg = View(ctx).apply { setRoundedBg(Color.parseColor(color), 4f) }
            val spacer = View(ctx)
            barBg.addView(fg, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, pct * 100f))
            barBg.addView(spacer, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, (1f - pct) * 100f))
            addView(barBg, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                leftMargin = dp(8).toInt()
                rightMargin = dp(8).toInt()
            })

            addView(TextView(ctx).apply {
                text = "$count 单 · ${String.format(Locale.US, "%.0f%%", pct * 100)}"
                setTextColor(Color.parseColor(COLOR_MUTE))
                textSize = 10f
                layoutParams = LinearLayout.LayoutParams(dp(84).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT)
            })
        }
    }

    // ── 复制货件号 ──
    private fun copyPostingNumber(item: RatingErrorItem) {
        val number = item.postingNumber ?: return
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        cm?.setText(number)
        toast("已复制货件号 $number")
    }

    // ── 辅助 UI ──
    private fun cardContainer(): LinearLayout {
        return LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setRoundedBg(Color.WHITE, 16f)
            elevation = dp(2f)
            setPadding(dp(14).toInt(), dp(12).toInt(), dp(14).toInt(), dp(12).toInt())
        }
    }

    private fun sectionTitle(text: String, topMargin: Int = 0): TextView {
        return TextView(requireContext()).apply {
            setText(text)
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 13f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setPadding(0, dp(topMargin).toInt(), 0, dp(4).toInt())
        }
    }

    private fun indexColor(index: Double): String = when {
        index <= 0.15 -> COLOR_OK
        index <= 0.35 -> COLOR_WARN
        else -> COLOR_ERR
    }

    // ── 日期工具 ──
    private fun pad(n: Int): String = String.format("%02d", n)

    private fun todayStr(): String {
        val cal = Calendar.getInstance()
        return SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.time)
    }

    private fun localDate(): Pair<Int, Int> {
        val cal = Calendar.getInstance()
        return cal.get(Calendar.YEAR) to (cal.get(Calendar.MONTH) + 1)
    }

    private fun shiftDays(base: String, n: Int): String {
        return try {
            val d = SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(base) ?: return base
            val cal = Calendar.getInstance()
            cal.time = d
            cal.add(Calendar.DATE, n)
            SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.time)
        } catch (e: Exception) {
            base
        }
    }

    private fun shortDate(date: String?): String {
        if (date.isNullOrBlank()) return ""
        return try {
            val d = SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(date) ?: return date
            SimpleDateFormat("MM-dd", Locale.US).format(d)
        } catch (e: Exception) {
            date
        }
    }

    private fun updateRangeHint() {
        rangeHint.text = "统计区间:$from ~ $to"
    }

    private fun goLogin() {
        startActivity(Intent(requireContext(), LoginActivity::class.java))
        requireActivity().finish()
    }

    private fun dp(v: Number): Float = android.util.TypedValue.applyDimension(
        android.util.TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    )

    private fun toast(msg: String) {
        Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }
}