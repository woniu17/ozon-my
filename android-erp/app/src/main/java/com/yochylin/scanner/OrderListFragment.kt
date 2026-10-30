package com.yochylin.scanner

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.widget.doAfterTextChanged
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.yochylin.scanner.adapter.OrderAdapter
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.api.optInt
import com.yochylin.scanner.api.optString
import com.yochylin.scanner.model.PackageListResponse
import com.yochylin.scanner.model.Pkg
import com.yochylin.scanner.setRoundedBg
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.Locale

/** 订单处理列表：Tab 计数 / 搜索 / 排序 / 分页 */
class OrderListFragment : Fragment() {

    companion object {
        private const val PAGE_SIZE = 20
        private const val STATE_ACTIVE_TAB = "state_active_tab"
        private const val STATE_KEYWORD = "state_keyword"
        private const val STATE_GLOBAL_ACTIVE = "state_global_active"
        private const val STATE_GLOBAL_MODE = "state_global_mode"
        private const val STATE_CURRENT_SORT = "state_current_sort"
        private const val STATE_TAB_SORTS = "state_tab_sorts"
        private const val STATE_PURCHASE_UNSHIPPED = "state_purchase_unshipped"
        private const val STATE_LOGISTICS_STALE = "state_logistics_stale"

        /** 各子 Tab 未单独设置排序时的默认值 */
        private const val DEFAULT_SORT = "order_desc"

        private val TABS = listOf(
            "all" to "全部",
            "waitProcess" to "待采购",
            "waitStock" to "待入库",
            "waitStick" to "待打单",
            "waitDispatch" to "待发运",
            "dispatching" to "交运中",
            "delivering" to "已揽收",
            "signed" to "已签收",
            "settled" to "已成功",
            "returned" to "已退货",
            "cancelled" to "已取消",
            "ignored" to "已搁置",
        )

        private data class SortOption(val value: String, val label: String, val key: String)

        private val ALL_SORTS = mapOf(
            "order_desc" to SortOption("order_desc", "下单时间 新→旧", "order"),
            "order_asc" to SortOption("order_asc", "下单时间 旧→新", "order"),
            "delivering_desc" to SortOption("delivering_desc", "揽收时间 新→旧", "delivering"),
            "delivering_asc" to SortOption("delivering_asc", "揽收时间 旧→新", "delivering"),
            "delivered_desc" to SortOption("delivered_desc", "签收时间 新→旧", "delivered"),
            "return_desc" to SortOption("return_desc", "退货时间 新→旧", "return"),
            "shipped_desc" to SortOption("shipped_desc", "交运时间 新→旧", "shipped"),
            "shipped_asc" to SortOption("shipped_asc", "交运时间 旧→新", "shipped"),
        )

        private val TAB_SORT_KEYS = mapOf(
            "all" to listOf("order", "delivering"),
            "waitProcess" to listOf("order"),
            "waitStock" to listOf("order"),
            "waitStick" to listOf("order"),
            "waitDispatch" to listOf("order"),
            "dispatching" to listOf("order", "shipped"),
            "delivering" to listOf("order", "delivering"),
            "signed" to listOf("order", "delivering", "return", "delivered"),
            "settled" to listOf("order", "delivering", "return", "delivered"),
            "returned" to listOf("order", "delivering", "return"),
            "cancelled" to listOf("order", "delivering", "return"),
            "ignored" to listOf("order", "delivering"),
        )
    }

    private lateinit var searchInput: EditText
    private lateinit var tabContainer: LinearLayout
    private lateinit var quickFilterBar: LinearLayout
    private lateinit var quickPurchaseUnshipped: TextView
    private lateinit var quickLogisticsStale: TextView
    private lateinit var sortText: TextView
    private lateinit var bannerText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var recyclerView: RecyclerView
    private lateinit var loadMoreTip: TextView

    private val adapter = OrderAdapter(object : OrderAdapter.Callbacks {
        override fun onCopy(text: String, label: String) {
            val clipboard = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
            toast("$label 已复制")
        }

        override fun onOpenDetail(pkg: Pkg) {
            detailLauncher.launch(
                Intent(requireContext(), OrderDetailActivity::class.java)
                    .putExtra("packageId", pkg.id)
            )
        }

        override fun onSearchSku(sku: String) {
            searchInput.setText(sku)
            keyword = sku
            globalActive = true
            globalMode = "eq"
            reload()
        }

        override fun onSubmitShip(pkg: Pkg, weightG: Int) {
            viewLifecycleOwner.lifecycleScope.launch {
                try {
                    val r = Api.post(
                        "/admin/api/order-process/scan-ship/submit",
                        mapOf("packageId" to pkg.id, "weightG" to weightG)
                    ).asJsonObject
                    if (!r.optBoolean("canShip")) {
                        toast(r.optString("message", "订单状态不允许提交"))
                        return@launch
                    }
                    try {
                        Api.post("/admin/api/order-process/print-label", mapOf("packageId" to pkg.id))
                    } catch (_: Exception) {
                    }
                    toast("已交运")
                    loadTabs()
                    reload()
                } catch (e: Exception) {
                    if (e is ApiException && e.code == 401) {
                        toast("登录已过期,请重新登录")
                        goLogin()
                    } else {
                        toast(e.message ?: "提交失败")
                    }
                }
            }
        }

        override fun onOpenLabel(pkg: Pkg) {
            viewLifecycleOwner.lifecycleScope.launch {
                try {
                    val r = Api.post(
                        "/admin/api/order-process/package-label",
                        mapOf("packageIds" to listOf(pkg.id))
                    ).asJsonObject
                    val url = r.optString("url")
                    if (url.isBlank()) {
                        toast("面单链接为空")
                        return@launch
                    }
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (e: Exception) {
                    if (e is ApiException && e.code == 401) {
                        toast("登录已过期,请重新登录")
                        goLogin()
                    } else {
                        toast(e.message ?: "面单生成失败")
                    }
                }
            }
        }

        override fun onCorrectWeight(pkg: Pkg, weightG: Int) {
            viewLifecycleOwner.lifecycleScope.launch {
                try {
                    Api.post(
                        "/admin/api/order-process/scan-ship/correct-weight",
                        mapOf("packageId" to pkg.id, "weightG" to weightG)
                    ).asJsonObject
                    toast("重量已更正")
                    loadTabs()
                    reload()
                } catch (e: Exception) {
                    if (e is ApiException && e.code == 401) {
                        toast("登录已过期,请重新登录")
                        goLogin()
                    } else {
                        toast(e.message ?: "更正失败")
                    }
                }
            }
        }

        override fun onEditMeta(pkg: Pkg) {
            requireContext().showPackageMetaEditDialog(
                packageId = pkg.id,
                postingNumber = pkg.postingNumber,
                currentTags = pkg.tags,
                currentNote = pkg.note,
                scope = viewLifecycleOwner.lifecycleScope
            ) { note, tags ->
                savePackageMeta(pkg, note, tags)
            }
        }
    })

    /** 网络模式变化监听：后台自动切换时刷新按钮/数据（onDestroyView 时移除；手动切换走各自流程，避免重复 toast） */
    private val networkModeListener: (Boolean) -> Unit = { _ ->
        view?.let { v ->
            viewLifecycleOwner.lifecycleScope.launch {
                updateIntranetBtn(v.findViewById(R.id.orderIntranetBtn))
                loadTabs()
                reload()
            }
        }
    }

    private val detailLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            loadTabs()
            reload()
        }
    }

    /** 扫码全局搜索：扫码返回后自动填充输入框并执行全局搜索（参考扫描打单） */
    private val scanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val code = result.data?.getStringExtra("code") ?: ""
            if (code.isNotBlank()) {
                searchInput.setText(code)
                keyword = code
                globalActive = true
                globalMode = "ss"
                reload()
            }
        }
    }

    private var activeTab = "waitProcess"
    private var keyword = ""
    private var globalActive = false
    private var globalMode = "ss"
    /** 各子 Tab 独立排序值(key=tab,value=sortValue)：切换子 Tab 互不影响(2026-10-30) */
    private val tabSorts = mutableMapOf<String, String>()
    private var currentSort: String
        get() = tabSorts[activeTab] ?: DEFAULT_SORT
        set(value) { tabSorts[activeTab] = value }
    /** 待入库快速筛选(2026-10-17):>0 表示启用 24h 阈值,与后端 purchaseUnshippedHours/logisticsStaleHours 对应 */
    private var purchaseUnshippedHours = 0
    private var logisticsStaleHours = 0
    /** 快捷筛选各自命中数(2026-10-17):后端 quickCounts 返回,按钮上展示 */
    private var quickPurchaseCount = 0
    private var quickLogisticsCount = 0

    private val rows = mutableListOf<Pkg>()
    private var total = 0
    private var page = 1
    private var loading = false
    private var loadingMore = false
    /** 当前列表请求 Job：切换 Tab/搜索/刷新时取消旧请求，防止旧响应覆盖新数据（评审 P0-2） */
    private var loadJob: Job? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.activity_order_list, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        // 顶部返回按钮由宿主容器管理，这里隐藏
        view.findViewById<android.view.View>(R.id.backBtn).visibility = android.view.View.GONE

        if (!Session.isLoggedIn) {
            goLogin()
            return
        }

        // 进程重建/配置变更后恢复筛选状态（评审 P1：Fragment 状态恢复）
        if (savedInstanceState != null) {
            activeTab = savedInstanceState.getString(STATE_ACTIVE_TAB, "waitProcess")
            keyword = savedInstanceState.getString(STATE_KEYWORD, "") ?: ""
            globalActive = savedInstanceState.getBoolean(STATE_GLOBAL_ACTIVE, false)
            globalMode = savedInstanceState.getString(STATE_GLOBAL_MODE, "ss") ?: "ss"
            // 各子 Tab 排序独立恢复，互不影响
            @Suppress("UNCHECKED_CAST")
            (savedInstanceState.getSerializable(STATE_TAB_SORTS) as? HashMap<String, String>)?.let {
                tabSorts.putAll(it)
            }
            purchaseUnshippedHours = savedInstanceState.getInt(STATE_PURCHASE_UNSHIPPED, 0)
            logisticsStaleHours = savedInstanceState.getInt(STATE_LOGISTICS_STALE, 0)
        }

        searchInput = view.findViewById(R.id.orderSearchInput)
        searchInput.setText(keyword)
        setupClearButton()
        tabContainer = view.findViewById(R.id.tabContainer)
        quickFilterBar = view.findViewById(R.id.quickFilterBar)
        quickPurchaseUnshipped = view.findViewById(R.id.quickPurchaseUnshipped)
        quickLogisticsStale = view.findViewById(R.id.quickLogisticsStale)
        quickPurchaseUnshipped.setOnClickListener { toggleQuickFilter("purchase") }
        quickLogisticsStale.setOnClickListener { toggleQuickFilter("logistics") }
        sortText = view.findViewById(R.id.sortText)
        sortText.text = "排序:${currentSortLabel()} ▾"
        bannerText = view.findViewById(R.id.orderBannerText)
        progressBar = view.findViewById(R.id.orderProgress)
        swipeRefresh = view.findViewById(R.id.orderSwipeRefresh)
        recyclerView = view.findViewById(R.id.orderRecyclerView)
        loadMoreTip = view.findViewById(R.id.loadMoreTip)

        swipeRefresh.setColorSchemeResources(R.color.primary)
        swipeRefresh.setOnRefreshListener {
            loadTabs()
            reload()
        }

        recyclerView.layoutManager = LinearLayoutManager(requireContext())
        recyclerView.adapter = adapter
        recyclerView.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                val lm = rv.layoutManager as LinearLayoutManager
                val last = lm.findLastVisibleItemPosition()
                if (last >= lm.itemCount - 3 && !loading && !loadingMore && rows.size < total) {
                    loadMore()
                }
            }
        })

        view.findViewById<TextView>(R.id.orderLogoutBtn).setOnClickListener {
            Session.clear()
            requireContext().stopService(Intent(requireContext(), NewOrderNotifyService::class.java))
            goLogin()
        }
        // 推送记录 / 网络模式 / 检查更新（2026-10-28 从扫描打单页迁移到订单处理页顶处）
        view.findViewById<TextView>(R.id.orderPushLogBtn).setOnClickListener {
            startActivity(Intent(requireContext(), PushLogActivity::class.java))
        }
        view.findViewById<TextView>(R.id.orderCheckUpdateBtn).setOnClickListener {
            (requireActivity() as? MainShellActivity)?.checkUpdate(manual = true)
        }
        view.findViewById<TextView>(R.id.orderIntranetBtn).apply {
            updateIntranetBtn(this)
            setOnClickListener { showNetworkModeDialog(this) }
        }
        // 注册网络模式变化监听：WiFi/流量切换导致内网公网变动时，自动刷新 UI 和数据
        NetworkDetector.addModeChangeListener(networkModeListener)
        // 启动时按网络模式应用后端地址（auto 检测 Home-WiFi）
        NetworkDetector.applyNetworkMode(requireContext())
        view.findViewById<TextView>(R.id.orderSearchBtn).setOnClickListener { doSearch() }
        view.findViewById<TextView>(R.id.orderScanBtn).setOnClickListener {
            scanLauncher.launch(Intent(requireContext(), ScanActivity::class.java))
        }
        searchInput.setOnEditorActionListener { _, _, _ ->
            doSearch()
            true
        }
        sortText.setOnClickListener { showSortDialog() }

        buildTabs()
        loadTabs()
        updateQuickFilterUi()
        reload()
    }

    override fun onDestroyView() {
        NetworkDetector.removeModeChangeListener(networkModeListener)
        super.onDestroyView()
    }

    // ── Tab ──
    private fun buildTabs() {
        tabContainer.removeAllViews()
        for ((index, t) in TABS.withIndex()) {
            val tv = TextView(requireContext()).apply {
                text = t.second
                textSize = 13f
                setPadding(28, 12, 28, 12)
                gravity = Gravity.CENTER
            }
            updateTabStyle(tv, t.first == activeTab)
            tv.setOnClickListener {
                if (t.first != activeTab) {
                    activeTab = t.first
                    keyword = ""
                    globalActive = false
                    globalMode = "ss"
                    // 快速筛选仅待入库 tab 可用(2026-10-18):切 tab 重置,避免参数串到其它 tab
                    purchaseUnshippedHours = 0
                    logisticsStaleHours = 0
                    refreshTabStyles()
                    // 排序按子 Tab 独立记忆，切换后展示该 Tab 自己的排序
                    sortText.text = "排序:${currentSortLabel()} ▾"
                    loadTabs()
                    updateQuickFilterUi()
                    reload()
                }
            }
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            lp.rightMargin = 8
            tabContainer.addView(tv, lp)
        }
    }

    private fun refreshTabStyles() {
        for (i in 0 until tabContainer.childCount) {
            val child = tabContainer.getChildAt(i)
            if (child is TextView) {
                updateTabStyle(child, TABS[i].first == activeTab)
            }
        }
    }

    private fun updateTabStyle(tv: TextView, active: Boolean) {
        tv.setTextColor(if (active) Color.WHITE else Color.parseColor("#4e5969"))
        tv.setBackgroundResource(if (active) R.drawable.tab_active_bg else R.drawable.tab_normal_bg)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_ACTIVE_TAB, activeTab)
        outState.putString(STATE_KEYWORD, keyword)
        outState.putBoolean(STATE_GLOBAL_ACTIVE, globalActive)
        outState.putString(STATE_GLOBAL_MODE, globalMode)
        outState.putString(STATE_CURRENT_SORT, currentSort)
        outState.putSerializable(STATE_TAB_SORTS, HashMap(tabSorts))
        outState.putInt(STATE_PURCHASE_UNSHIPPED, purchaseUnshippedHours)
        outState.putInt(STATE_LOGISTICS_STALE, logisticsStaleHours)
        super.onSaveInstanceState(outState)
    }

    private fun loadTabs() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val obj = Api.get("/admin/api/order-process/tabs").asJsonObject
                for (i in 0 until tabContainer.childCount) {
                    val child = tabContainer.getChildAt(i) as? TextView ?: continue
                    val key = TABS[i].first
                    val count = obj.optInt(key, -1)
                    val base = TABS[i].second
                    child.text = if (count >= 0) "$base($count)" else base
                }
            } catch (e: Exception) {
                // 计数失败静默
            }
        }
    }

    // ── 搜索 / 排序 ──
    private fun setupClearButton() {
        val size = (18 * resources.displayMetrics.density).toInt()
        val clearIcon = ContextCompat.getDrawable(requireContext(), R.drawable.ic_clear)?.apply {
            setBounds(0, 0, size, size)
        }
        searchInput.doAfterTextChanged { text ->
            if (text.isNullOrEmpty()) {
                searchInput.setCompoundDrawables(null, null, null, null)
            } else {
                searchInput.setCompoundDrawables(null, null, clearIcon, null)
            }
        }
        searchInput.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_UP) {
                val end = searchInput.compoundDrawables[2] ?: return@setOnTouchListener false
                val x = event.x
                if (x >= searchInput.width - searchInput.paddingEnd - end.bounds.width() &&
                    x <= searchInput.width - searchInput.paddingEnd
                ) {
                    searchInput.setText("")
                    doSearch()
                    return@setOnTouchListener true
                }
            }
            false
        }
    }

    private fun doSearch() {
        val kw = searchInput.text.toString().trim()
        if (kw.isEmpty()) {
            if (globalActive) {
                globalActive = false
                globalMode = "ss"
                reload()
            }
            return
        }
        keyword = kw
        globalActive = true
        globalMode = "ss"
        reload()
    }

    /** 当前子 Tab 排序的中文文案（用于排序按钮展示） */
    private fun currentSortLabel(): String =
        ALL_SORTS[currentSort]?.label ?: ALL_SORTS[DEFAULT_SORT]!!.label

    private fun showSortDialog() {
        val keys = TAB_SORT_KEYS[activeTab] ?: listOf("order")
        val opts = ALL_SORTS.values.filter { it.key in keys }
        val labels = opts.map { it.label }.toTypedArray()
        val checked = opts.indexOfFirst { it.value == currentSort }.coerceAtLeast(0)
        AlertDialog.Builder(requireContext())
            .setTitle("排序")
            .setSingleChoiceItems(labels, checked) { dialog, which ->
                currentSort = opts[which].value
                dialog.dismiss()
                sortText.text = "排序:${opts[which].label} ▾"
                reload()
            }
            .show()
    }

    private fun savePackageMeta(pkg: Pkg, note: String, tags: List<String>) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = Api.post(
                    "/admin/api/order-process/package-meta",
                    mapOf("packageId" to pkg.id, "note" to note, "tags" to tags)
                ).asJsonObject
                adapter.updateMeta(
                    pkg.id,
                    r.optString("note"),
                    r.getAsJsonArray("tags")?.mapNotNull { if (it.isJsonNull) null else it.asString }
                )
                toast("标签/备注已保存")
            } catch (e: Exception) {
                if (e is ApiException && e.code == 401) {
                    toast("登录已过期,请重新登录")
                    goLogin()
                } else {
                    toast(e.message ?: "保存失败")
                }
            }
        }
    }

    // ── 待入库快速筛选(2026-10-17)──
    private fun toggleQuickFilter(kind: String) {
        if (kind == "purchase") {
            purchaseUnshippedHours = if (purchaseUnshippedHours > 0) 0 else 24
        } else {
            logisticsStaleHours = if (logisticsStaleHours > 0) 0 else 24
        }
        updateQuickFilterUi()
        reload()
    }

    private fun updateQuickFilterUi() {
        if (!::quickFilterBar.isInitialized) return
        val show = activeTab == "waitStock"
        quickFilterBar.visibility = if (show) View.VISIBLE else View.GONE
        renderQuickChip(quickPurchaseUnshipped, purchaseUnshippedHours > 0, "采购超24h未发货", quickPurchaseCount)
        renderQuickChip(quickLogisticsStale, logisticsStaleHours > 0, "物流超24h未揽收", quickLogisticsCount)
    }

    private fun renderQuickChip(tv: TextView, on: Boolean, base: String, count: Int) {
        tv.text = if (count > 0) "$base($count)" else base
        tv.setTextColor(if (on) Color.parseColor("#165dff") else Color.parseColor("#4e5969"))
        tv.setRoundedBg(if (on) 0xFFE8F0FF.toInt() else 0xFFF2F3F5.toInt(), 12f)
    }

    // ── 列表 ──
    private fun reload() {
        page = 1
        loadList()
    }

    private fun loadMore() {
        page++
        loadingMore = true
        loadMoreTip.visibility = View.VISIBLE
        loadMoreTip.text = "加载中…"
        loadListInternal()
    }

    private fun loadList() {
        loading = true
        progressBar.visibility = View.VISIBLE
        bannerText.visibility = View.GONE
        loadListInternal()
    }

    private fun loadListInternal() {
        // 取消上一次未完成的列表请求，避免旧响应晚到覆盖新查询结果（评审 P0-2）
        loadJob?.cancel()
        loadJob = viewLifecycleOwner.lifecycleScope.launch {
            try {
                val sortParts = currentSort.split("_")
                val sortBy = sortParts[0]
                val sortOrder = sortParts.getOrElse(1) { "desc" }
                val isGlobal = globalActive && keyword.isNotBlank()
                val data = Api.get(
                    "/admin/api/order-process/list",
                    mapOf(
                        "tab" to activeTab,
                        "globalKeyword" to (if (isGlobal) keyword else ""),
                        "globalMode" to globalMode,
                        "sortBy" to sortBy,
                        "sortOrder" to sortOrder,
                        "purchaseUnshippedHours" to (if (purchaseUnshippedHours > 0) 24 else 0),
                        "logisticsStaleHours" to (if (logisticsStaleHours > 0) 24 else 0),
                        "page" to page,
                        "pageSize" to PAGE_SIZE
                    )
                )
                val resp = Api.parse<PackageListResponse>(data)
                if (page == 1) {
                    rows.clear()
                    rows.addAll(resp.packages)
                    adapter.setList(rows)
                    if (isGlobal) {
                        showBanner("全局搜索\"$keyword\" 命中 ${resp.total} 单", ok = true)
                    } else {
                        bannerText.visibility = View.GONE
                    }
                } else {
                    rows.addAll(resp.packages)
                    adapter.append(resp.packages)
                }
                total = resp.total
                // 快捷筛选命中数(2026-10-17):无论筛选是否启用都更新,保证按钮数字与后端一致
                quickPurchaseCount = resp.quickCounts?.purchaseUnshipped ?: 0
                quickLogisticsCount = resp.quickCounts?.logisticsStale ?: 0
                updateQuickFilterUi()
            } catch (e: CancellationException) {
                // 被更新的请求取代：不更新 UI、不弹错误、不修正 page
                throw e
            } catch (e: Exception) {
                if (page > 1) page--
                if (e is ApiException && e.code == 401) {
                    toast("登录已过期,请重新登录")
                    goLogin()
                } else {
                    toast(e.message ?: "加载失败")
                }
            } finally {
                loading = false
                loadingMore = false
                progressBar.visibility = View.GONE
                loadMoreTip.visibility = View.GONE
                if (::swipeRefresh.isInitialized) {
                    swipeRefresh.isRefreshing = false
                }
            }
        }
    }

    private fun showBanner(text: String, ok: Boolean) {
        bannerText.text = text
        bannerText.setRoundedBg(if (ok) 0xFFE8FFEA.toInt() else 0xFFFFECE8.toInt(), 8f)
        bannerText.setTextColor(if (ok) 0xFF00B42A.toInt() else 0xFFF53F3F.toInt())
        bannerText.visibility = View.VISIBLE
    }

    // ── 网络模式（2026-10-28 从扫描打单页迁移） ──

    private fun updateIntranetBtn(btn: TextView) {
        btn.text = when (Session.networkMode) {
            Session.MODE_INTRANET -> "内网"
            Session.MODE_PUBLIC -> "公网"
            // 自动模式也展示当前实际生效的网络，避免"明明走了内网/公网却看不出"的误判
            else -> if (Session.useIntranet) "自动·内网" else "自动·公网"
        }
        when (Session.networkMode) {
            Session.MODE_INTRANET -> {
                btn.setTextColor(Color.WHITE)
                btn.setRoundedBg(Color.parseColor("#165dff"), 999f)
            }
            Session.MODE_PUBLIC -> {
                btn.setTextColor(Color.parseColor("#165dff"))
                btn.setRoundedBg(Color.parseColor("#eef4ff"), 999f)
            }
            else -> {
                // auto：绿色底白字表示自动检测
                btn.setTextColor(Color.WHITE)
                btn.setRoundedBg(Color.parseColor("#00b42a"), 999f)
            }
        }
    }

    /** 网络模式三选一弹窗（自动检测/内网/公网） */
    private fun showNetworkModeDialog(btn: TextView) {
        val modeNames = arrayOf("自动检测", "内网", "公网")
        val current = when (Session.networkMode) {
            Session.MODE_INTRANET -> 1
            Session.MODE_PUBLIC -> 2
            else -> 0
        }
        var selected = current
        AlertDialog.Builder(requireContext())
            .setTitle("网络模式")
            .setSingleChoiceItems(modeNames, current) { _, which -> selected = which }
            .setPositiveButton("确定") { _, _ ->
                Session.networkMode = when (selected) {
                    1 -> Session.MODE_INTRANET
                    2 -> Session.MODE_PUBLIC
                    else -> Session.MODE_AUTO
                }
                applyNetworkMode(btn)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 应用当前网络模式并刷新 UI/数据 */
    private fun applyNetworkMode(btn: TextView) {
        viewLifecycleOwner.lifecycleScope.launch {
            val changed = NetworkDetector.applyNetworkMode(requireContext())
            updateIntranetBtn(btn)
            toast(networkModeToast())
            // 模式实际变化时 networkModeListener 已统一刷新；未变化也刷新一次保证数据最新
            if (!changed) {
                loadTabs()
                reload()
            }
        }
    }

    private fun networkModeToast(): String = when (Session.networkMode) {
        Session.MODE_INTRANET -> "已切换为内网 192.168.1.212:3001"
        Session.MODE_PUBLIC -> "已切换为公网 yochylin.com:17443"
        else -> when {
            Session.useIntranet -> "已连接 Home-WiFi，自动使用内网"
            NetworkDetector.isWifiSsidUnavailable(requireContext()) ->
                "WiFi 名称不可读(定位未开/权限缺失)，已走公网，必要时可手动切内网"
            else -> "未连接 Home-WiFi，使用公网"
        }
    }

    private fun goLogin() {
        startActivity(Intent(requireContext(), LoginActivity::class.java))
        requireActivity().finish()
    }

    private fun toast(msg: String) {
        Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }
}