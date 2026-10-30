package com.yochylin.scanner

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.yochylin.scanner.adapter.OrderAdapter
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.api.optInt
import com.yochylin.scanner.api.optString
import com.yochylin.scanner.model.PackageListResponse
import com.yochylin.scanner.model.Pkg
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.Locale

/** 订单处理列表：Tab 计数 / 搜索 / 排序 / 分页 */
class OrderListActivity : ComponentActivity() {

    companion object {
        private const val PAGE_SIZE = 20
        private const val STATE_ACTIVE_TAB = "state_active_tab"
        private const val STATE_KEYWORD = "state_keyword"
        private const val STATE_GLOBAL_ACTIVE = "state_global_active"
        private const val STATE_GLOBAL_MODE = "state_global_mode"
        private const val STATE_CURRENT_SORT = "state_current_sort"

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
    private lateinit var sortText: TextView
    private lateinit var bannerText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var recyclerView: RecyclerView
    private lateinit var loadMoreTip: TextView

    private val adapter = OrderAdapter(object : OrderAdapter.Callbacks {
        override fun onCopy(text: String, label: String) {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
            toast("$label 已复制")
        }

        override fun onOpenDetail(pkg: Pkg) {
            detailLauncher.launch(
                Intent(this@OrderListActivity, OrderDetailActivity::class.java)
                    .putExtra("packageId", pkg.id)
            )
        }

        override fun onSearchSku(sku: String) {
            searchInput.setText(sku)
            globalActive = true
            globalMode = "eq"
            reload()
        }

        override fun onSubmitShip(pkg: Pkg, weightG: Int) {
            lifecycleScope.launch {
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
            lifecycleScope.launch {
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
            lifecycleScope.launch {
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
            this@OrderListActivity.showPackageMetaEditDialog(
                packageId = pkg.id,
                postingNumber = pkg.postingNumber,
                currentTags = pkg.tags,
                currentNote = pkg.note,
                scope = lifecycleScope
            ) { note, tags ->
                savePackageMeta(pkg, note, tags)
            }
        }
    })

    private val detailLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            loadTabs()
            reload()
        }
    }

    private var activeTab = "waitProcess"
    private var keyword = ""
    private var globalActive = false
    private var globalMode = "ss"
    private var currentSort = "order_desc"

    private val rows = mutableListOf<Pkg>()
    private var total = 0
    private var page = 1
    private var loading = false
    private var loadingMore = false
    /** 当前列表请求 Job：切换 Tab/搜索/刷新时取消旧请求，防止旧响应覆盖新数据（评审 P0-2） */
    private var loadJob: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Session.init(this)
        if (!Session.isLoggedIn) {
            goLogin()
            return
        }

        setContentView(R.layout.activity_order_list)

        // 搜索框非必要不聚焦(2026-10-18):进入页面不自动弹出输入键盘,用户点击输入时才弹出
        window.setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN or
                WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        )

        // 底部导航栏
        setupBottomNav(this, "order")

        // 进程重建/配置变更后恢复筛选状态（评审 P1：Fragment/Activity 状态恢复）
        if (savedInstanceState != null) {
            activeTab = savedInstanceState.getString(STATE_ACTIVE_TAB, "waitProcess") ?: "waitProcess"
            keyword = savedInstanceState.getString(STATE_KEYWORD, "") ?: ""
            globalActive = savedInstanceState.getBoolean(STATE_GLOBAL_ACTIVE, false)
            globalMode = savedInstanceState.getString(STATE_GLOBAL_MODE, "ss") ?: "ss"
            currentSort = savedInstanceState.getString(STATE_CURRENT_SORT, "order_desc") ?: "order_desc"
        }

        searchInput = findViewById(R.id.orderSearchInput)
        searchInput.setText(keyword)
        tabContainer = findViewById(R.id.tabContainer)
        sortText = findViewById(R.id.sortText)
        bannerText = findViewById(R.id.orderBannerText)
        progressBar = findViewById(R.id.orderProgress)
        recyclerView = findViewById(R.id.orderRecyclerView)
        loadMoreTip = findViewById(R.id.loadMoreTip)

        recyclerView.layoutManager = LinearLayoutManager(this)
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

        findViewById<TextView>(R.id.backBtn).setOnClickListener { finish() }
        findViewById<TextView>(R.id.orderLogoutBtn).setOnClickListener {
            Session.clear()
            goLogin()
        }
        findViewById<TextView>(R.id.orderSearchBtn).setOnClickListener { doSearch() }
        searchInput.setOnEditorActionListener { _, _, _ ->
            doSearch()
            true
        }
        sortText.setOnClickListener { showSortDialog() }

        buildTabs()
        loadTabs()
        reload()
    }

    // ── Tab ──
    private fun buildTabs() {
        tabContainer.removeAllViews()
        for ((index, t) in TABS.withIndex()) {
            val tv = TextView(this).apply {
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
                    refreshTabStyles()
                    loadTabs()
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

    private fun loadTabs() {
        lifecycleScope.launch {
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

    private fun showSortDialog() {
        val keys = TAB_SORT_KEYS[activeTab] ?: listOf("order")
        val opts = ALL_SORTS.values.filter { it.key in keys }
        val labels = opts.map { it.label }.toTypedArray()
        val checked = opts.indexOfFirst { it.value == currentSort }.coerceAtLeast(0)
        AlertDialog.Builder(this)
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
        lifecycleScope.launch {
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
        loadJob = lifecycleScope.launch {
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
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_ACTIVE_TAB, activeTab)
        outState.putString(STATE_KEYWORD, keyword)
        outState.putBoolean(STATE_GLOBAL_ACTIVE, globalActive)
        outState.putString(STATE_GLOBAL_MODE, globalMode)
        outState.putString(STATE_CURRENT_SORT, currentSort)
        super.onSaveInstanceState(outState)
    }

    private fun showBanner(text: String, ok: Boolean) {
        bannerText.text = text
        bannerText.setRoundedBg(if (ok) 0xFFE8FFEA.toInt() else 0xFFFFECE8.toInt(), 8f)
        bannerText.setTextColor(if (ok) 0xFF00B42A.toInt() else 0xFFF53F3F.toInt())
        bannerText.visibility = View.VISIBLE
    }

    private fun goLogin() {
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}