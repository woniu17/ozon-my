package com.yochylin.scanner

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.yochylin.scanner.adapter.FinanceAdapter
import com.yochylin.scanner.adapter.fmtMoney
import com.yochylin.scanner.adapter.fmtNum
import com.yochylin.scanner.adapter.fmtTime
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.model.FinanceOrdersResponse
import com.yochylin.scanner.model.FinanceSummary
import com.yochylin.scanner.model.GroupAgg
import com.yochylin.scanner.model.NonOrderAccrualsResponse
import com.yochylin.scanner.model.OrderMonthsResponse
import com.yochylin.scanner.model.OrderStatsStoresResponse
import com.yochylin.scanner.model.StoreItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** 财务统计：时间预设/时区/三组汇总/明细列表 */
class FinanceActivity : ComponentActivity() {

    companion object {
        private const val PAGE_SIZE = 20
        private const val COLOR_PRIMARY = "#165dff"
        private const val COLOR_MUTE = "#86909c"
        private const val COLOR_TEXT = "#1f2329"
        private const val COLOR_OK = "#00b42a"
        private const val COLOR_ERR = "#f53f3f"
        private const val COLOR_WARN = "#d97706"

        private data class Preset(val key: String, val label: String)
    }

    private lateinit var presetContainer: LinearLayout
    private lateinit var rangeHint: TextView
    private lateinit var tzBtn: TextView
    private lateinit var summaryContainer: LinearLayout
    private lateinit var detailTabSettled: TextView
    private lateinit var detailTabPending: TextView
    private lateinit var detailTabNonOrder: TextView
    private lateinit var tabIndicatorSettled: View
    private lateinit var tabIndicatorPending: View
    private lateinit var tabIndicatorNonOrder: View
    private lateinit var financeSearchRow: LinearLayout
    private lateinit var keywordInput: EditText
    private lateinit var progressBar: ProgressBar
    private lateinit var recyclerView: RecyclerView
    private lateinit var loadMoreTip: TextView

    private lateinit var adapter: FinanceAdapter

    private var tz = "Asia/Shanghai"
    private var tzLabel = "北京时间"

    private var from = ""
    private var to = ""
    private var activePreset = "all"
    private var months: List<String> = emptyList()

    private var currentMode = "settled"
    private var keyword = ""
    private var total = 0
    private var page = 1
    private var loading = false
    private var loadingMore = false
    /** 明细列表请求 Job：切换模式/刷新时取消旧请求，防止旧响应覆盖新数据（评审 P0-3） */
    private var loadJob: Job? = null

    // 店铺多选（空集合 = 全选）
    private var allStores: List<StoreItem> = emptyList()
    private var selectedStoreIds: Set<String> = emptySet()
    private lateinit var storeBtn: TextView

    // 明细联动筛选（汇总卡片点击设置）
    private var activeCategory: String? = null
    private var activeTypeId: Int? = null

    private val presets = listOf(
        Preset("all", "全部"),
        Preset("7d", "近7日"),
        Preset("14d", "近14日"),
        Preset("30d", "近30日"),
        Preset("month", "月份▾"),
        Preset("custom", "自定义"),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Session.init(this)
        if (!Session.isLoggedIn) {
            goLogin()
            return
        }

        setContentView(R.layout.activity_finance)

        // 底部导航栏
        setupBottomNav(this, "finance")

        presetContainer = findViewById(R.id.presetContainer)
        rangeHint = findViewById(R.id.rangeHint)
        tzBtn = findViewById(R.id.tzBtn)
        recyclerView = findViewById(R.id.financeRecyclerView)

        // 2026-10-16 重构：汇总/Tab/搜索移入 RecyclerView 页头，从 headerView 获取引用
        adapter = FinanceAdapter(this)
        recyclerView.layoutManager = LinearLayoutManager(this)
        recyclerView.adapter = adapter
        val header = adapter.headerView
        summaryContainer = header.findViewById(R.id.summaryContainer)
        detailTabSettled = header.findViewById(R.id.detailTabSettled)
        detailTabPending = header.findViewById(R.id.detailTabPending)
        detailTabNonOrder = header.findViewById(R.id.detailTabNonOrder)
        tabIndicatorSettled = header.findViewById(R.id.tabIndicatorSettled)
        tabIndicatorPending = header.findViewById(R.id.tabIndicatorPending)
        tabIndicatorNonOrder = header.findViewById(R.id.tabIndicatorNonOrder)
        financeSearchRow = header.findViewById(R.id.financeSearchRow)
        keywordInput = header.findViewById(R.id.financeKeywordInput)
        progressBar = header.findViewById(R.id.financeProgress)
        loadMoreTip = header.findViewById(R.id.financeLoadMoreTip)
        recyclerView.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                val lm = rv.layoutManager as LinearLayoutManager
                val last = lm.findLastVisibleItemPosition()
                if (last >= lm.itemCount - 3 && !loading && !loadingMore && adapter.itemCount < total) {
                    loadMore()
                }
            }
        })

        findViewById<TextView>(R.id.financeBackBtn).setOnClickListener { finish() }
        findViewById<TextView>(R.id.financeLogoutBtn).setOnClickListener {
            Session.clear()
            goLogin()
        }
        findViewById<TextView>(R.id.financeSearchBtn).setOnClickListener { onSearch() }
        keywordInput.setOnEditorActionListener { _, _, _ ->
            onSearch()
            true
        }

        tzBtn.text = "$tzLabel ▾"
        tzBtn.setOnClickListener { showTzDialog() }

        storeBtn = findViewById(R.id.financeStoreBtn)

        detailTabSettled.setOnClickListener { switchMode("settled") }
        detailTabPending.setOnClickListener { switchMode("pending") }
        detailTabNonOrder.setOnClickListener { switchMode("nonorder") }

        buildPresets()
        updateDetailTabs()
        loadStores()
        loadMonths()
        loadSummary()
        loadFirstPage()
    }

    // ── 时间预设 ──
    private fun buildPresets() {
        presetContainer.removeAllViews()
        for ((i, p) in presets.withIndex()) {
            val tv = TextView(this).apply {
                text = p.label
                textSize = 12f
                setPadding(dp(22).toInt(), dp(9).toInt(), dp(22).toInt(), dp(9).toInt())
                gravity = Gravity.CENTER
            }
            updatePresetStyle(tv, p.key == activePreset)
            tv.setOnClickListener { onPresetClick(p.key) }
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.rightMargin = 8
            presetContainer.addView(tv, lp)
        }
    }

    private fun refreshPresetStyles() {
        for (i in 0 until presetContainer.childCount) {
            val child = presetContainer.getChildAt(i)
            if (child is TextView) {
                updatePresetStyle(child, presets[i].key == activePreset)
            }
        }
    }

    private fun updatePresetStyle(tv: TextView, active: Boolean) {
        tv.setTextColor(if (active) Color.WHITE else Color.parseColor("#4e5969"))
        tv.setRoundedBg(
            if (active) Color.parseColor(COLOR_PRIMARY) else Color.parseColor("#f2f3f5"),
            16f
        )
    }

    private fun onPresetClick(key: String) {
        when (key) {
            "all" -> {
                activePreset = key; from = ""; to = ""
                applyRange()
            }
            "7d" -> {
                activePreset = key
                from = shiftDays(-6); to = shiftDays(1)
                applyRange()
            }
            "14d" -> {
                activePreset = key
                from = shiftDays(-13); to = shiftDays(1)
                applyRange()
            }
            "30d" -> {
                activePreset = key
                from = shiftDays(-29); to = shiftDays(1)
                applyRange()
            }
            "month" -> showMonthDialog()
            "custom" -> showCustomDialog()
        }
    }

    private fun showMonthDialog() {
        if (months.isEmpty()) {
            toast("暂无历史月份")
            return
        }
        val labels = months.map { it }
        AlertDialog.Builder(this)
            .setTitle("选择月份")
            .setItems(labels.toTypedArray()) { _, which ->
                val ym = months[which]
                activePreset = "month"
                val parts = ym.split("-")
                val y = parts[0].toInt()
                val m = parts[1].toInt()
                from = "$ym-01"
                to = if (m == 12) "${y + 1}-01-01" else "$y-${String.format("%02d", m + 1)}-01"
                applyRange()
            }
            .show()
    }

    private fun showCustomDialog() {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 0)
        }
        val fromInput = EditText(this).apply {
            hint = "开始日期 YYYY-MM-DD"
            setText(from)
            inputType = android.text.InputType.TYPE_CLASS_DATETIME
        }
        val toInput = EditText(this).apply {
            hint = "结束日期 YYYY-MM-DD(排他)"
            setText(to)
            inputType = android.text.InputType.TYPE_CLASS_DATETIME
        }
        container.addView(fromInput)
        container.addView(toInput)
        AlertDialog.Builder(this)
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
                    applyRange()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun applyRange() {
        refreshPresetStyles()
        updateRangeHint()
        loadMonths()
        loadSummary()
        loadFirstPage()
    }

    private fun updateRangeHint() {
        if (from.isEmpty() && to.isEmpty()) {
            rangeHint.text = "当前统计区间:全部时间(订单按下单时间,非订单应计按应计日期)"
        } else {
            rangeHint.text = "当前统计区间($tzLabel):$from ~ ${shiftDays(-1, to)}(订单按下单时间)"
        }
    }

    // ── 时区 ──
    private fun showTzDialog() {
        val options = arrayOf("北京时间", "莫斯科时间")
        val checked = if (tz == "Asia/Shanghai") 0 else 1
        AlertDialog.Builder(this)
            .setTitle("统计时区")
            .setSingleChoiceItems(options, checked) { dialog, which ->
                tz = if (which == 0) "Asia/Shanghai" else "Europe/Moscow"
                tzLabel = options[which]
                tzBtn.text = "$tzLabel ▾"
                dialog.dismiss()
                updateRangeHint()
                loadMonths()
                loadSummary()
                loadFirstPage()
            }
            .show()
    }

    // ── 数据加载 ──
    private fun baseParams(): Map<String, Any?> {
        val p = HashMap<String, Any?>()
        if (from.isNotEmpty() && to.isNotEmpty()) {
            p["from"] = from
            p["to"] = to
            p["tz"] = tz
        }
        if (selectedStoreIds.isNotEmpty()) {
            p["storeIds"] = selectedStoreIds.joinToString(",")
        }
        return p
    }

    private fun loadMonths() {
        lifecycleScope.launch {
            try {
                val resp = withContext(Dispatchers.IO) {
                    Api.parse<OrderMonthsResponse>(Api.get("/admin/api/finance-stats/order-months", mapOf("tz" to tz)))
                }
                months = resp.months
            } catch (e: Exception) {
                months = emptyList()
            }
        }
    }

    private fun loadStores() {
        lifecycleScope.launch {
            try {
                val resp = withContext(Dispatchers.IO) {
                    Api.parse<OrderStatsStoresResponse>(Api.get("/admin/api/order-stats/stores"))
                }
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
        val dialog = AlertDialog.Builder(this)
            .setTitle("选择店铺(勾选=纳入筛选,全不选=空结果)")
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
                loadSummary()
                loadFirstPage()
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

    private fun loadSummary() {
        lifecycleScope.launch {
            try {
                val resp = withContext(Dispatchers.IO) {
                    Api.parse<FinanceSummary>(Api.get("/admin/api/finance-stats/summary", baseParams()))
                }
                renderSummary(resp)
            } catch (e: Exception) {
                if (e is ApiException && e.code == 401) {
                    toast("登录已过期,请重新登录")
                    goLogin()
                } else {
                    toast(e.message ?: "汇总加载失败")
                }
            }
        }
    }

    // ── 汇总渲染 ──
    private fun renderSummary(s: FinanceSummary) {
        summaryContainer.removeAllViews()
        s.settled?.let { addGroupCard(summaryContainer, "已结算", it, "settled") }
        s.pending?.let { addGroupCard(summaryContainer, "已采购未结算", it, "pending") }
        s.nonOrder?.let { addNonOrderCard(summaryContainer, it) }
        if (summaryContainer.childCount == 0) {
            summaryContainer.addView(mutedText("暂无汇总数据"))
        }
    }

    private fun addGroupCard(container: LinearLayout, title: String, g: GroupAgg, group: String) {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setRoundedBg(Color.WHITE, 16f)
            elevation = dp(2f)
            setPadding(dp(16).toInt(), dp(14).toInt(), dp(16).toInt(), dp(14).toInt())
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(12).toInt() }
            setOnClickListener {
                // 点击卡片整体 → 切到对应明细 tab（清除联动筛选）
                switchMode(if (group == "settled") "settled" else "pending")
            }
        }

        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        // 状态圆点 + 标题（已结算蓝 / 未结算橙）
        head.addView(View(this).apply {
            val dotColor = if (group == "settled") COLOR_PRIMARY else COLOR_WARN
            setRoundedBg(Color.parseColor(dotColor), 4f)
            layoutParams = LinearLayout.LayoutParams(dp(8).toInt(), dp(8).toInt()).apply {
                rightMargin = dp(6).toInt()
            }
        })
        val titleTv = TextView(this).apply {
            text = if (group == "settled" && g.estimated) "$title(含预估)" else title
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 15f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        head.addView(titleTv)
        val countTv = TextView(this).apply {
            text = "${g.orderCount} 单"
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 11f
        }
        head.addView(countTv)
        card.addView(head)

        val profit = TextView(this).apply {
            text = fmtMoney(g.totalProfit)
            setTextColor(profitColor(g.totalProfit))
            textSize = 28f
            typeface = android.graphics.Typeface.MONOSPACE
            setPadding(0, dp(6).toInt(), 0, dp(2).toInt())
        }
        card.addView(profit)

        // 分隔线
        card.addView(divider())

        addLine(card, "订单金额", fmtMoney(g.totalOrderAmount))
        addLine(card, "采购成本", fmtMoney(g.totalPurchaseAmount))
        addLine(card, "回款", fmtMoney(g.totalPayout))
        if (group == "settled") {
            g.validPayout?.let { addLine(card, "有效回款", fmtMoney(it)) }
            g.grossPayout?.let { addLine(card, "总回款", fmtMoney(it)) }
        } else {
            addLine(card, "预估佣金", fmtMoney(g.totalCommission))
            addLine(card, "预估配送", fmtMoney(g.totalDelivery))
        }
        g.profitRateSale?.let { addLine(card, "销售利润率", "${String.format(Locale.US, "%.1f", it)}%") }
        g.profitRateCost?.let { addLine(card, "成本利润率", "${String.format(Locale.US, "%.1f", it)}%") }

        // 分类子计数（已结算，可点击联动）
        if (group == "settled" && g.byCategory != null) {
            card.addView(divider())
            val catRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = 2 }
            }
            catRow.addView(catChip("已成功 ${g.byCategory.success}", "success"))
            catRow.addView(catChip("已取消 ${g.byCategory.cancelled}", "cancelled"))
            catRow.addView(catChip("已退款 ${g.byCategory.returned}", "returned"))
            card.addView(catRow)
        }

        // 应计类型（可点击联动）
        if (!g.accrualTypes.isNullOrEmpty()) {
            card.addView(divider())
            val chips = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = 2 }
            }
            for (t in g.accrualTypes.take(8)) {
                chips.addView(typeChip("${t.nameCn ?: "类型${t.typeId}"}×${t.count}", t.typeId, group))
            }
            card.addView(chips)
        }

        container.addView(card)
    }

    /** 浅灰分隔线 */
    private fun divider(): View {
        return View(this).apply {
            setBackgroundColor(Color.parseColor("#f2f3f5"))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(1).toInt()
            ).apply {
                topMargin = dp(10).toInt()
                bottomMargin = dp(10).toInt()
            }
        }
    }

    /** 分类筛选 chip：点击后联动已结算明细并按分类过滤 */
    private fun catChip(text: String, cat: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor(COLOR_PRIMARY))
            textSize = 10f
            setRoundedBg(Color.parseColor("#eef4ff"), 10f)
            setPadding(12, 6, 12, 6)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.rightMargin = dp(8).toInt()
            layoutParams = lp
            setOnClickListener {
                activeCategory = cat
                activeTypeId = null
                if (currentMode != "settled") {
                    currentMode = "settled"
                    updateDetailTabs()
                }
                adapter.setMode("settled")
                loadFirstPage()
            }
        }
    }

    /** 应计类型 chip：点击后联动对应分组明细并按类型过滤 */
    private fun typeChip(text: String, typeId: Int, group: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor("#4e5969"))
            textSize = 10f
            setRoundedBg(Color.parseColor("#f2f3f5"), 10f)
            setPadding(10, 5, 10, 5)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.rightMargin = dp(8).toInt()
            layoutParams = lp
            setOnClickListener {
                activeTypeId = typeId
                activeCategory = null
                if (currentMode != group) {
                    currentMode = group
                    updateDetailTabs()
                }
                adapter.setMode(group)
                loadFirstPage()
            }
        }
    }

    private fun addNonOrderCard(container: LinearLayout, n: com.yochylin.scanner.model.NonOrderAgg) {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setRoundedBg(Color.WHITE, 16f)
            elevation = dp(2f)
            setPadding(dp(16).toInt(), dp(14).toInt(), dp(16).toInt(), dp(14).toInt())
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(12).toInt() }
            setOnClickListener {
                switchMode("nonorder")
            }
        }
        val head = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(View(this).apply {
            setRoundedBg(Color.parseColor(COLOR_ERR), 4f)
            layoutParams = LinearLayout.LayoutParams(dp(8).toInt(), dp(8).toInt()).apply {
                rightMargin = dp(6).toInt()
            }
        })
        head.addView(TextView(this).apply {
            text = "非订单应计"
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 15f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        head.addView(TextView(this).apply {
            text = "${n.count} 笔"
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 11f
        })
        card.addView(head)
        card.addView(divider())
        addLine(card, "金额(CNY)", n.totalCny?.let { fmtMoney(it) } ?: "—")
        addLine(card, "金额(RUB)", fmtNum(n.totalRub))
        if (!n.accrualTypes.isNullOrEmpty()) {
            card.addView(divider())
            for (t in n.accrualTypes.take(6)) {
                addLine(card, t.nameCn ?: "类型${t.typeId}", "${t.count} 笔 · ${fmtMoney(t.cny ?: t.rub)}")
            }
        }
        container.addView(card)
    }

    private fun addLine(container: LinearLayout, key: String, value: String) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6).toInt() }
        }
        val k = TextView(this).apply {
            text = key
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(dp(100).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        row.addView(k)
        val v = TextView(this).apply {
            text = value
            setTextColor(Color.parseColor(COLOR_TEXT))
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        row.addView(v)
        container.addView(row)
    }

    private fun chip(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor("#4e5969"))
            textSize = 10f
            setRoundedBg(Color.parseColor("#f2f3f5"), 10f)
            setPadding(10, 5, 10, 5)
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.rightMargin = dp(8).toInt()
            layoutParams = lp
        }
    }

    private fun mutedText(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            setTextColor(Color.parseColor(COLOR_MUTE))
            textSize = 12f
            setPadding(0, 20, 0, 20)
            gravity = Gravity.CENTER
        }
    }

    // ── 明细 ──
    private fun switchMode(mode: String, clearFilter: Boolean = true) {
        if (currentMode == mode && clearFilter && activeCategory == null && activeTypeId == null) return
        currentMode = mode
        if (clearFilter) {
            activeCategory = null
            activeTypeId = null
        }
        keyword = ""
        keywordInput.setText("")
        updateDetailTabs()
        adapter.setMode(mode)
        loadFirstPage()
    }

    private fun updateDetailTabs() {
        val active = currentMode
        val settled = active == "settled"
        val pending = active == "pending"
        val nonOrder = active == "nonorder"

        detailTabSettled.setTextColor(if (settled) Color.parseColor(COLOR_PRIMARY) else Color.parseColor(COLOR_MUTE))
        detailTabSettled.typeface = if (settled) android.graphics.Typeface.DEFAULT_BOLD else android.graphics.Typeface.DEFAULT
        detailTabPending.setTextColor(if (pending) Color.parseColor(COLOR_PRIMARY) else Color.parseColor(COLOR_MUTE))
        detailTabPending.typeface = if (pending) android.graphics.Typeface.DEFAULT_BOLD else android.graphics.Typeface.DEFAULT
        detailTabNonOrder.setTextColor(if (nonOrder) Color.parseColor(COLOR_PRIMARY) else Color.parseColor(COLOR_MUTE))
        detailTabNonOrder.typeface = if (nonOrder) android.graphics.Typeface.DEFAULT_BOLD else android.graphics.Typeface.DEFAULT

        tabIndicatorSettled.visibility = if (settled) View.VISIBLE else View.INVISIBLE
        tabIndicatorPending.visibility = if (pending) View.VISIBLE else View.INVISIBLE
        tabIndicatorNonOrder.visibility = if (nonOrder) View.VISIBLE else View.INVISIBLE

        financeSearchRow.visibility = if (active == "nonorder") View.GONE else View.VISIBLE
    }

    private fun onSearch() {
        keyword = keywordInput.text.toString().trim()
        loadFirstPage()
    }

    private fun loadFirstPage() {
        page = 1
        loading = true
        progressBar.visibility = View.VISIBLE
        loadMoreTip.visibility = View.GONE
        // 取消上一次未完成的明细请求，避免旧响应晚到覆盖新模式数据（评审 P0-3）
        loadJob?.cancel()
        loadJob = lifecycleScope.launch {
            try {
                when (currentMode) {
                    "nonorder" -> {
                        val resp = withContext(Dispatchers.IO) {
                            Api.parse<NonOrderAccrualsResponse>(
                                Api.get("/admin/api/finance-stats/non-order-accruals", listParams())
                            )
                        }
                        total = resp.total
                        adapter.setNonOrders(resp.items)
                    }
                    else -> {
                        val resp = withContext(Dispatchers.IO) {
                            Api.parse<FinanceOrdersResponse>(
                                Api.get("/admin/api/finance-stats/orders", listParams())
                            )
                        }
                        total = resp.total
                        adapter.setOrders(currentMode, resp.orders)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                handleError(e)
            } finally {
                loading = false
                progressBar.visibility = View.GONE
            }
        }
    }

    private fun loadMore() {
        page++
        loadingMore = true
        loadMoreTip.visibility = View.VISIBLE
        loadMoreTip.text = "加载中…"
        // 加载更多与刷新互斥：刷新会取消进行中的加载更多（评审 P0-3）
        loadJob?.cancel()
        loadJob = lifecycleScope.launch {
            try {
                when (currentMode) {
                    "nonorder" -> {
                        val resp = withContext(Dispatchers.IO) {
                            Api.parse<NonOrderAccrualsResponse>(
                                Api.get("/admin/api/finance-stats/non-order-accruals", listParams())
                            )
                        }
                        total = resp.total
                        adapter.appendNonOrders(resp.items)
                    }
                    else -> {
                        val resp = withContext(Dispatchers.IO) {
                            Api.parse<FinanceOrdersResponse>(
                                Api.get("/admin/api/finance-stats/orders", listParams())
                            )
                        }
                        total = resp.total
                        adapter.appendOrders(currentMode, resp.orders)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (page > 1) page--
                handleError(e)
            } finally {
                loadingMore = false
                loadMoreTip.visibility = View.GONE
            }
        }
    }

    private fun listParams(): Map<String, Any?> {
        val p = HashMap(baseParams())
        p["page"] = page
        p["pageSize"] = PAGE_SIZE
        if (currentMode != "nonorder") {
            p["group"] = currentMode
            if (keyword.isNotEmpty()) p["keyword"] = keyword
            if (currentMode == "settled" && activeCategory != null) p["category"] = activeCategory
            if (activeTypeId != null) p["typeId"] = activeTypeId
        }
        return p
    }

    // ── 辅助 ──
    private fun shiftDays(n: Int): String {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DATE, n)
        return SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.time)
    }

    private fun shiftDays(n: Int, base: String): String {
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

    private fun profitColor(v: Double?): Int {
        if (v == null) return Color.parseColor(COLOR_MUTE)
        return if (v > 0) Color.parseColor(COLOR_OK) else if (v < 0) Color.parseColor(COLOR_ERR) else Color.parseColor(COLOR_MUTE)
    }

    private fun dp(v: Number): Float = android.util.TypedValue.applyDimension(
        android.util.TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    )

    private fun handleError(e: Exception) {
        if (e is ApiException && e.code == 401) {
            toast("登录已过期,请重新登录")
            goLogin()
        } else {
            toast(e.message ?: "请求失败")
        }
    }

    private fun goLogin() {
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}