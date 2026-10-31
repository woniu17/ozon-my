package com.yochylin.scanner

import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.HorizontalScrollView
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
    }

    private lateinit var rangeHint: TextView
    private lateinit var overviewContainer: LinearLayout
    private lateinit var trendContainer: LinearLayout
    private lateinit var progressBar: ProgressBar
    private lateinit var recyclerView: RecyclerView
    private lateinit var loadMoreBtn: TextView
    private lateinit var syncBtn: TextView

    private val adapter = StoreHealthErrorAdapter()

    private var errorTotal = 0
    private var isLoadingMore = false
    private var syncing = false

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

        rangeHint = view.findViewById(R.id.healthRangeHint)
        overviewContainer = view.findViewById(R.id.healthOverviewContainer)
        trendContainer = view.findViewById(R.id.healthTrendContainer)
        progressBar = view.findViewById(R.id.healthProgress)
        recyclerView = view.findViewById(R.id.healthErrorList)
        loadMoreBtn = view.findViewById(R.id.healthLoadMoreBtn)
        syncBtn = view.findViewById(R.id.healthSyncBtn)

        recyclerView.layoutManager = LinearLayoutManager(requireContext())
        recyclerView.adapter = adapter
        adapter.onItemClick = { copyPostingNumber(it) }

        syncBtn.setOnClickListener { triggerSync() }
        loadMoreBtn.setOnClickListener { loadMoreErrors() }

        loadData()
    }

    // ── 数据加载 ──
    private fun loadData() {
        viewLifecycleOwner.lifecycleScope.launch {
            progressBar.visibility = View.VISIBLE
            try {
                val data = Api.get("/admin/api/rating/health/summary")
                val resp = Api.parse<RatingHealthSummaryResponse>(data)
                val stores = resp.stores ?: emptyList()
                renderRangeHint(resp.stores)
                renderStores(stores)
                renderTrend(stores)

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

    private fun renderRangeHint(stores: List<RatingStoreHealth>?) {
        val s = stores?.firstOrNull()
        val text = if (s != null && !s.periodFrom.isNullOrBlank() && !s.periodTo.isNullOrBlank()) {
            "指数统计时间段:${s.periodFrom} ~ ${shiftDays(s.periodTo, -1)}"
        } else {
            "暂无指数统计时间段"
        }
        rangeHint.text = text
    }

    private fun buildParams(): HashMap<String, Any?> {
        return HashMap<String, Any?>()
    }

    // ── 手动同步 ──
    private fun triggerSync() {
        if (syncing) return
        syncing = true
        syncBtn.text = "同步中…"
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = HashMap<String, Any?>()
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

    // ── 各店铺错误指数卡片(每行最多3个,按店铺编号 YQL01~YQL06 顺序) ──
    private fun renderStores(stores: List<RatingStoreHealth>) {
        overviewContainer.removeAllViews()
        if (stores.isEmpty()) return
        val sorted = stores.sortedBy { it.storeId ?: "" }
        var i = 0
        while (i < sorted.size) {
            val row = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { if (i > 0) topMargin = dp(10).toInt() }
            }
            for (col in 0 until 3) {
                val store = sorted.getOrNull(i + col) ?: break
                val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                if (col > 0) lp.leftMargin = dp(10).toInt()
                row.addView(storeIndexCard(store), lp)
            }
            overviewContainer.addView(row)
            i += 3
        }
    }

    private fun storeIndexCard(store: RatingStoreHealth): LinearLayout {
        val ctx = requireContext()
        val idx = store.index ?: 0.0
        val color = indexColor(idx)
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setRoundedBgStroke(Color.WHITE, Color.parseColor("#E9EDF3"), 14f, 1f)
            setPadding(dp(12).toInt(), dp(10).toInt(), dp(12).toInt(), dp(8).toInt())

            // 店铺名 + 指数%(Ozon 官方阈值着色)
            addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(TextView(ctx).apply {
                    text = store.storeName ?: store.storeId ?: "—"
                    setTextColor(Color.parseColor(COLOR_TEXT))
                    textSize = 13f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                addView(TextView(ctx).apply {
                    text = String.format(Locale.US, "%.2f%%", idx * 100)
                    setTextColor(Color.parseColor(color))
                    textSize = 17f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    gravity = Gravity.END
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        leftMargin = dp(6).toInt()
                    }
                })
            })

            // 五色指数刻度条
            addView(IndexScaleView(ctx).apply {
                this.index = idx
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(8).toInt() }
            })

            // 统计周期 + 罚款
            addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(8).toInt(), 0, 0)
                val period = if (!store.periodFrom.isNullOrBlank() && !store.periodTo.isNullOrBlank()) {
                    "${store.periodFrom} ~ ${shiftDays(store.periodTo, -1)}"
                } else {
                    "—"
                }
                addView(TextView(ctx).apply {
                    text = period
                    setTextColor(Color.parseColor(COLOR_MUTE))
                    textSize = 9f
                    maxLines = 1
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                addView(TextView(ctx).apply {
                    text = "罚款 ${fmtMoney(store.processingCostsSum)}"
                    setTextColor(Color.parseColor(COLOR_MUTE))
                    textSize = 9f
                    gravity = Gravity.END
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        leftMargin = dp(4).toInt()
                    }
                })
            })
        }
    }

    // ── 每日错误指数趋势(全部店铺 × 指数统计周期,分组柱状) ──
    private fun renderTrend(stores: List<RatingStoreHealth>) {
        trendContainer.removeAllViews()
        val active = stores.filter { !it.defects.isNullOrEmpty() }
        if (active.isEmpty()) return
        val dates = active.flatMap { s -> s.defects?.mapNotNull { d -> d.date } ?: emptyList() }
            .toSortedSet()
            .toList()
        if (dates.isEmpty()) return

        val first = active.firstOrNull()
        val periodText = if (first != null && !first.periodFrom.isNullOrBlank() && !first.periodTo.isNullOrBlank()) {
            "${first.periodFrom} ~ ${shiftDays(first.periodTo, -1)}"
        } else {
            ""
        }

        val colors = listOf("#165dff", "#00b42a", "#d97706", "#722ed1", "#eb2f96", "#13c2c2", "#fa8c16")
        val maxIdx = active.flatMap { s -> s.defects?.mapNotNull { d -> d.indexByDate ?: 0.0 } ?: emptyList() }
            .maxOrNull() ?: 0.0
        val scaleMax = maxOf(maxIdx, 0.2)

        val card = cardContainer()
        card.addView(sectionTitle("每日错误指数趋势 · 全部店铺($periodText)"))

        val chart = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.BOTTOM
            setPadding(0, dp(10).toInt(), 0, 0)
        }
        for (date in dates) {
            val col = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(dp(40).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            val barsArea = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.BOTTOM
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(90).toInt())
            }
            active.forEachIndexed { si, store ->
                val d = store.defects?.find { it.date == date } ?: return@forEachIndexed
                val ratio = ((d.indexByDate ?: 0.0) / scaleMax).toFloat().coerceIn(0.02f, 1f)
                val bar = View(requireContext()).apply {
                    setRoundedBg(Color.parseColor(colors[si % colors.size]), 2f)
                    layoutParams = LinearLayout.LayoutParams(dp(9).toInt(), (dp(90f) * ratio).toInt()).apply {
                        if (si > 0) leftMargin = dp(2).toInt()
                    }
                }
                barsArea.addView(bar)
            }
            col.addView(barsArea)
            col.addView(TextView(requireContext()).apply {
                text = shortDate(date)
                textSize = 8f
                setTextColor(Color.parseColor(COLOR_MUTE))
                gravity = Gravity.CENTER
                setPadding(0, dp(3).toInt(), 0, 0)
            })
            chart.addView(col)
        }

        val scroll = HorizontalScrollView(requireContext()).apply {
            isFillViewport = true
            addView(chart)
        }
        card.addView(scroll)

        // 图例
        val legend = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8).toInt(), 0, 0)
        }
        active.forEachIndexed { si, store ->
            legend.addView(LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                addView(View(requireContext()).apply {
                    setRoundedBg(Color.parseColor(colors[si % colors.size]), 2f)
                    layoutParams = LinearLayout.LayoutParams(dp(14).toInt(), dp(6).toInt()).apply {
                        rightMargin = dp(3).toInt()
                    }
                })
                addView(TextView(requireContext()).apply {
                    text = store.storeName ?: store.storeId ?: "—"
                    setTextColor(Color.parseColor(COLOR_MUTE))
                    textSize = 8f
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                })
            })
        }
        card.addView(legend)
        trendContainer.addView(card)
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
            setRoundedBgStroke(Color.WHITE, Color.parseColor("#E9EDF3"), 16f, 1f)
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

    /** Ozon 官方错误指数色带阈值(≤4% 绿 / ≤10% 青 / ≤20% 黄 / ≤40% 橙 / >40% 红) */
    private fun indexColor(index: Double): String = when {
        index <= 0.04 -> "#00a32e"
        index <= 0.10 -> "#009a9a"
        index <= 0.20 -> "#d99000"
        index <= 0.40 -> "#ee6a00"
        else -> "#e53414"
    }

    // ── Ozon 风格指数刻度条：五色区段(绿/青/黄/橙/红)+当前指数填充+阈值标签 ──
    private class IndexScaleView(context: Context) : View(context) {

        private class Zone(val from: Double, val to: Double, val tint: Int, val solid: Int)

        private val zones = listOf(
            Zone(0.00, 0.04, Color.rgb(215, 249, 215), Color.rgb(0, 196, 81)),
            Zone(0.04, 0.10, Color.rgb(215, 246, 245), Color.rgb(0, 190, 190)),
            Zone(0.10, 0.20, Color.rgb(255, 248, 224), Color.rgb(255, 184, 0)),
            Zone(0.20, 0.40, Color.rgb(255, 235, 210), Color.rgb(248, 143, 20)),
            Zone(0.40, 1.01, Color.rgb(255, 233, 227), Color.rgb(245, 60, 20)),
        )
        private val thresholds = listOf("0%", "4%", "10%", "20%", "40%", "100%")

        var index: Double = 0.0
            set(value) {
                field = value.coerceIn(0.0, 1.0)
                invalidate()
            }

        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = sp(9f)
            color = Color.rgb(134, 144, 156)
        }
        private val valuePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = sp(9f)
            typeface = Typeface.DEFAULT_BOLD
        }

        private val gap = dp(3f)
        private val barHeight = dp(22f)
        private val labelHeight = dp(18f)

        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val w = MeasureSpec.getSize(widthMeasureSpec)
            setMeasuredDimension(w, (barHeight + labelHeight).toInt())
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val totalW = width.toFloat()
            if (totalW <= 0) return
            val segW = (totalW - gap * (zones.size - 1)) / zones.size
            val activeIdx = zones.indexOfFirst { index < it.to }

            var left = 0f
            for ((i, z) in zones.withIndex()) {
                val rect = RectF(left, 0f, left + segW, barHeight)
                val isActive = i == activeIdx
                val rLeft = if (i == 0) dp(8f) else dp(2f)
                val rRight = if (i == zones.size - 1) dp(8f) else dp(2f)

                // 浅色区段背景
                paint.color = z.tint
                canvas.drawPath(roundRectPath(rect, rLeft, rRight), paint)

                // 活动区段：实心填充 + 数值标签
                if (isActive) {
                    val frac = ((index - z.from) / (z.to - z.from)).toFloat().coerceIn(0f, 1f)
                    val fillW = segW * frac
                    val label = String.format(Locale.US, "%.2f%%", index * 100)
                    if (fillW > 0.5f) {
                        val fillRect = RectF(left, 0f, left + fillW, barHeight)
                        paint.color = z.solid
                        canvas.drawPath(roundRectPath(fillRect, rLeft, 0f), paint)

                        // 数值标签放填充右端内侧；放不下时用实心色画在浅色底上
                        val textW = valuePaint.measureText(label)
                        valuePaint.color = Color.WHITE
                        val labelX = left + fillW - textW - dp(4f)
                        if (labelX > left + dp(2f)) {
                            canvas.drawText(
                                label, labelX,
                                barHeight / 2 - (valuePaint.ascent() + valuePaint.descent()) / 2,
                                valuePaint
                            )
                        } else {
                            valuePaint.color = z.solid
                            canvas.drawText(
                                label, left + dp(2f),
                                barHeight / 2 - (valuePaint.ascent() + valuePaint.descent()) / 2,
                                valuePaint
                            )
                        }
                    } else {
                        // 填充几乎为 0，仅画标签
                        valuePaint.color = z.solid
                        canvas.drawText(
                            label, left + dp(2f),
                            barHeight / 2 - (valuePaint.ascent() + valuePaint.descent()) / 2,
                            valuePaint
                        )
                    }
                }
                left += segW + gap
            }

            // 阈值标签(0% 贴左、100% 贴右、其余居中于区段边界)
            val labelY = barHeight + labelPaint.textSize + dp(3f)
            canvas.drawText(thresholds.first(), 0f, labelY, labelPaint)
            for (i in 1 until zones.size) {
                val x = i * (segW + gap) - gap / 2 - labelPaint.measureText(thresholds[i]) / 2
                canvas.drawText(thresholds[i], x, labelY, labelPaint)
            }
            canvas.drawText(thresholds.last(), totalW - labelPaint.measureText(thresholds.last()), labelY, labelPaint)
        }

        private fun roundRectPath(rect: RectF, rLeft: Float, rRight: Float): Path =
            Path().apply {
                addRoundRect(
                    rect,
                    floatArrayOf(rLeft, rLeft, rRight, rRight, rRight, rRight, rLeft, rLeft),
                    Path.Direction.CW
                )
            }

        private fun sp(v: Float): Float = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_SP, v, resources.displayMetrics
        )

        private fun dp(v: Float): Float = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics
        )
    }

    // ── 日期工具 ──
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