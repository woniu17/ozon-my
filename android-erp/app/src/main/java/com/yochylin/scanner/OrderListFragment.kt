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
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
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
import kotlinx.coroutines.launch
import java.util.Locale

/** 订单处理列表：Tab 计数 / 搜索 / 排序 / 分页 */
class OrderListFragment : Fragment() {

    companion object {
        private const val PAGE_SIZE = 20

        private val TABS = listOf(
            "all" to "全部",
            "waitProcess" to "待处理",
            "waitShip" to "待打单发货",
            "shipSuccess" to "交运",
            "waitReceiverConfirm" to "已发货",
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
        )

        private val TAB_SORT_KEYS = mapOf(
            "all" to listOf("order", "delivering"),
            "waitProcess" to listOf("order"),
            "waitShip" to listOf("order"),
            "shipSuccess" to listOf("order"),
            "waitReceiverConfirm" to listOf("order", "delivering"),
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
    })

    private val detailLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
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

        searchInput = view.findViewById(R.id.orderSearchInput)
        tabContainer = view.findViewById(R.id.tabContainer)
        sortText = view.findViewById(R.id.sortText)
        bannerText = view.findViewById(R.id.orderBannerText)
        progressBar = view.findViewById(R.id.orderProgress)
        recyclerView = view.findViewById(R.id.orderRecyclerView)
        loadMoreTip = view.findViewById(R.id.loadMoreTip)

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
            goLogin()
        }
        view.findViewById<TextView>(R.id.orderSearchBtn).setOnClickListener { doSearch() }
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
        viewLifecycleOwner.lifecycleScope.launch {
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

    private fun showBanner(text: String, ok: Boolean) {
        bannerText.text = text
        bannerText.setRoundedBg(if (ok) 0xFFE8FFEA.toInt() else 0xFFFFECE8.toInt(), 8f)
        bannerText.setTextColor(if (ok) 0xFF00B42A.toInt() else 0xFFF53F3F.toInt())
        bannerText.visibility = View.VISIBLE
    }

    private fun goLogin() {
        startActivity(Intent(requireContext(), LoginActivity::class.java))
        requireActivity().finish()
    }

    private fun toast(msg: String) {
        Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
    }
}