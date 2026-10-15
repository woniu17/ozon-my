package com.yochylin.scanner

import android.app.AlertDialog
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
import com.yochylin.scanner.adapter.OrderStatsAdapter
import com.yochylin.scanner.adapter.fmtMoney
import com.yochylin.scanner.adapter.fmtNum
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.model.CountAmount
import com.yochylin.scanner.model.OrderStatsStoresResponse
import com.yochylin.scanner.model.OrderStatsSummary
import com.yochylin.scanner.model.StoreItem
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/** 订单统计：跨店铺跨时间窗口的订单量级与金额概览 */
class OrderStatsFragment : Fragment() {

    companion object {
        private const val COLOR_PRIMARY = "#165dff"
        private const val COLOR_MUTE = "#86909c"
        private const val COLOR_TEXT = "#1f2329"
        private const val COLOR_OK = "#00b42a"
        private const val COLOR_ERR = "#f53f3f"
        private const val COLOR_WARN = "#d97706"
        private const val MONTH_PRESET_COUNT = 6

        private data class Preset(val key: String, val label: String)
    }

    private lateinit var presetContainer: LinearLayout
    private lateinit var monthContainer: LinearLayout
    private lateinit var rangeHint: TextView
    private lateinit var tzBtn: TextView
    private lateinit var storeBtn: TextView
    private lateinit var totalContainer: LinearLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var recyclerView: RecyclerView

    private val adapter = OrderStatsAdapter()

    private var tz = "Asia/Shanghai"
    private var tzLabel = "北京时间"
    private var from = ""
    private var to = ""
    private var activePreset = "today"

    private var allStores: List<StoreItem> = emptyList()
    private var selectedStoreIds: Set<String> = emptySet() // 空 = 全选

    private val presets = listOf(
        Preset("today", "今天"),
        Preset("yesterday", "昨天"),
        Preset("7d", "近7日"),
        Preset("14d", "近14日"),
        Preset("30d", "近30日"),
        Preset("thisMonth", "本月"),
        Preset("lastMonth", "上月"),
        Preset("custom", "自定义"),
    )

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.activity_order_stats, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        if (!Session.isLoggedIn) {
            goLogin()
            return
        }

        // 顶部返回按钮由宿主管理，隐藏
        view.findViewById<android.view.View>(R.id.statsBackBtn).visibility = android.view.View.GONE

        presetContainer = view.findViewById(R.id.statsPresetContainer)
        monthContainer = view.findViewById(R.id.statsMonthContainer)
        rangeHint = view.findViewById(R.id.statsRangeHint)
        tzBtn = view.findViewById(R.id.statsTzBtn)
        storeBtn = view.findViewById(R.id.statsStoreBtn)
        totalContainer = view.findViewById(R.id.statsTotalContainer)
        progressBar = view.findViewById(R.id.statsProgress)
        recyclerView = view.findViewById(R.id.statsRecyclerView)

        recyclerView.layoutManager = LinearLayoutManager(requireContext())
        recyclerView.adapter = adapter

        view.findViewById<TextView>(R.id.statsLogoutBtn).setOnClickListener {
            Session.clear()
            goLogin()
        }

        tzBtn.text = "$tzLabel ▾"
        tzBtn.setOnClickListener { showTzDialog() }
        storeBtn.setOnClickListener { showStoreDialog() }

        buildPresets()
        buildMonths()
        applyPreset("today")
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
        for (i in 0 until monthContainer.childCount) {
            val child = monthContainer.getChildAt(i)
            if (child is TextView) {
                val key = "month:${months[i]}"
                updateStyle(child, key == activePreset)
            }
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

    private fun presetRange(key: String): Pair<String, String>? {
        return when (key) {
            "today" -> shiftLocalDays(0) to shiftLocalDays(1)
            "yesterday" -> shiftLocalDays(-1) to shiftLocalDays(0)
            "7d" -> shiftLocalDays(-6) to shiftLocalDays(1)
            "14d" -> shiftLocalDays(-13) to shiftLocalDays(1)
            "30d" -> shiftLocalDays(-29) to shiftLocalDays(1)
            "thisMonth" -> {
                val (y, m) = localDate()
                firstOfMonth(y, m) to shiftLocalDays(1)
            }
            "lastMonth" -> {
                val (y, m) = localDate()
                val lm = if (m == 1) 12 else m - 1
                val ly = if (m == 1) y - 1 else y
                firstOfMonth(ly, lm) to firstOfMonth(y, m)
            }
            else -> null
        }
    }

    // ── 自然月快捷 ──
    private var months: List<String> = emptyList()

    private fun buildMonths() {
        monthContainer.removeAllViews()
        val (y, m) = localDate()
        months = buildList {
            for (i in MONTH_PRESET_COUNT - 1 downTo 0) {
                var my = y
                var mm = m - i
                while (mm <= 0) {
                    mm += 12
                    my -= 1
                }
                add("$my-${String.format("%02d", mm)}")
            }
        }
        for ((i, ym) in months.withIndex()) {
            val (y2, m2) = ym.split("-").map { it.toInt() }
            val label = if (y2 == y) "${m2}月" else "${y2}年${m2}月"
            val tv = TextView(requireContext()).apply {
                text = label
                textSize = 11f
                setPadding(dp(18).toInt(), dp(8).toInt(), dp(18).toInt(), dp(8).toInt())
                gravity = Gravity.CENTER
            }
            updateStyle(tv, "month:$ym" == activePreset)
            tv.setOnClickListener {
                activePreset = "month:$ym"
                from = "$ym-01"
                to = if (m2 == 12) "${y2 + 1}-01-01" else "$y2-${String.format("%02d", m2 + 1)}-01"
                refreshPresetStyles()
                updateRangeHint()
                loadData()
            }
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.rightMargin = 6
            monthContainer.addView(tv, lp)
        }
    }

    // ── 自定义 ──
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
            hint = "结束日期 YYYY-MM-DD(排他)"
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

    // ── 时区 ──
    private fun showTzDialog() {
        val options = arrayOf("北京时间", "莫斯科时间")
        val checked = if (tz == "Asia/Shanghai") 0 else 1
        AlertDialog.Builder(requireContext())
            .setTitle("统计时区")
            .setSingleChoiceItems(options, checked) { dialog, which ->
                tz = if (which == 0) "Asia/Shanghai" else "Europe/Moscow"
                tzLabel = options[which]
                tzBtn.text = "$tzLabel ▾"
                dialog.dismiss()
                updateRangeHint()
                // 预设随日界变化需重算
                if (activePreset != "custom" && !activePreset.startsWith("month:")) {
                    applyPreset(activePreset)
                } else {
                    loadData()
                }
            }
            .show()
    }

    // ── 店铺 ──
    private fun loadStores() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/order-stats/stores")
                val resp = Api.parse<OrderStatsStoresResponse>(data)
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
                val params = HashMap<String, Any?>()
                params["from"] = from
                params["to"] = to
                params["tz"] = tz
                if (selectedStoreIds.isNotEmpty()) {
                    params["storeIds"] = selectedStoreIds.joinToString(",")
                }
                val data = Api.get("/admin/api/order-stats/summary", params)
                val resp = Api.parse<OrderStatsSummary>(data)
                renderTotals(resp)
                adapter.setList(resp.byStore ?: emptyList())
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

    private fun renderTotals(s: OrderStatsSummary) {
        totalContainer.removeAllViews()
        val totals = s.totals ?: return
        // 2x2 等高网格：新订单/揽收/签收/退货
        val defs = listOf(
            Triple("新订单", totals.new, true),
            Triple("揽收", totals.pickup, false),
            Triple("签收", totals.delivered, false),
            Triple("退货", totals.returned, false)
        )
        for (row in 0 until 2) {
            val rowLay = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(132).toInt()
                ).apply { if (row > 0) topMargin = dp(12).toInt() }
            }
            for (col in 0 until 2) {
                val (title, ca, showValid) = defs[row * 2 + col]
                val card = totalCard(title, ca, showValid)
                val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
                if (col > 0) lp.leftMargin = dp(12).toInt()
                rowLay.addView(card, lp)
            }
            totalContainer.addView(rowLay)
        }
    }

    /** 统一尺寸汇总方块：状态圆点 + 标题 + 大数字 + 金额 */
    private fun totalCard(title: String, ca: CountAmount?, showValid: Boolean): LinearLayout {
        val dotColor = when (title) {
            "新订单" -> COLOR_PRIMARY
            "揽收" -> COLOR_WARN
            "签收" -> COLOR_OK
            else -> COLOR_ERR
        }
        val ctx = requireContext()
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setRoundedBg(Color.WHITE, 16f)
            elevation = dp(2f)
            setPadding(dp(14).toInt(), dp(12).toInt(), dp(14).toInt(), dp(12).toInt())

            // 标题行：状态圆点 + 标题
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

            // 数量
            addView(TextView(ctx).apply {
                text = "${ca?.count ?: 0} 单"
                setTextColor(Color.parseColor(COLOR_TEXT))
                textSize = 24f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                setPadding(0, dp(8).toInt(), 0, 0)
            })

            // 金额
            addView(TextView(ctx).apply {
                text = "¥ ${fmtMoney(ca?.amount)}"
                setTextColor(Color.parseColor(COLOR_PRIMARY))
                textSize = 13f
                typeface = android.graphics.Typeface.MONOSPACE
                setPadding(0, dp(4).toInt(), 0, 0)
            })

            // 剔除取消（仅新订单）
            if (showValid && ca?.validAmount != null) {
                addView(TextView(ctx).apply {
                    text = "剔除取消 ¥ ${fmtMoney(ca.validAmount)}"
                    setTextColor(Color.parseColor(COLOR_MUTE))
                    textSize = 10f
                    setPadding(0, dp(4).toInt(), 0, 0)
                })
            }
        }
    }

    // ── 辅助 ──
    private fun shiftLocalDays(n: Int): String {
        val cal = Calendar.getInstance()
        cal.add(Calendar.DATE, n)
        return SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.time)
    }

    private fun localDate(): Pair<Int, Int> {
        val cal = Calendar.getInstance()
        return cal.get(Calendar.YEAR) to (cal.get(Calendar.MONTH) + 1)
    }

    private fun firstOfMonth(y: Int, m: Int): String = "$y-${String.format("%02d", m)}-01"

    private fun updateRangeHint() {
        val end = shiftLocalDays(-1, to)
        rangeHint.text = "当前统计区间($tzLabel):$from ~ $end"
    }

    private fun shiftLocalDays(n: Int, base: String): String {
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