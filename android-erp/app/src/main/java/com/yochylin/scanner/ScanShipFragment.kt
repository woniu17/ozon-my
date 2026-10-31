package com.yochylin.scanner

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
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
import com.yochylin.scanner.adapter.PackageAdapter
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.api.optString
import com.yochylin.scanner.model.PackageListResponse
import com.yochylin.scanner.model.Pkg
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 扫描打单主界面：搜索/扫码/卡片操作/打单记录 */
class ScanShipFragment : Fragment() {

    private lateinit var searchInput: EditText
    private lateinit var bannerText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var recyclerView: RecyclerView
    private lateinit var printerBar: TextView

    private val adapter = PackageAdapter(object : PackageAdapter.Callbacks {
        override fun onCopy(text: String, label: String) {
            copyText(text, label)
        }

        override fun onShipPackage(pkg: Pkg) {
            confirmAndShip(pkg)
        }

        override fun onSubmitShip(pkg: Pkg, weightG: Int) {
            submitShip(pkg, weightG)
        }

        override fun onOpenLabel(pkg: Pkg) {
            openLabel(pkg)
        }

        override fun onPrintLabel(pkg: Pkg) {
            printLabel(pkg)
        }

        override fun onPreviewLabel(pkg: Pkg) {
            previewLabel(pkg)
        }

        override fun onCorrectWeight(pkg: Pkg, weightG: Int) {
            correctWeight(pkg, weightG)
        }

        override fun onSwitchRecordTab(tab: String) {
            currentTab = tab
            loadRecords()
        }

        override fun onRefreshRecords() {
            loadRecords()
        }
    })

    private var currentKeyword = ""
    private var currentTab = "today"
    private var results: List<Pkg> = emptyList()
    private var records: List<Pkg> = emptyList()
    private var countToday = 0
    private var countYesterday = 0

    private val scanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val code = result.data?.getStringExtra("code") ?: ""
            if (code.isNotBlank()) {
                searchInput.setText(code)
                doSearch(code)
            }
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.activity_main, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        if (!Session.isLoggedIn) {
            goLogin()
            return
        }

        searchInput = view.findViewById(R.id.searchInput)
        bannerText = view.findViewById(R.id.bannerText)
        progressBar = view.findViewById(R.id.progressBar)
        recyclerView = view.findViewById(R.id.recyclerView)
        printerBar = view.findViewById(R.id.printerBar)

        recyclerView.layoutManager = LinearLayoutManager(requireContext())
        recyclerView.adapter = adapter

        // 输入框清除图标:有内容时显示 ✕,点击一键清空并回到打单记录(2026-10-23)
        setupClearButton()

        // 打印机状态条:常驻显示在线状态 + 当前打印机,点击选择(2026-10-22)
        printerBar.setOnClickListener { showPrinterPicker() }

        view.findViewById<TextView>(R.id.searchBtn).setOnClickListener {
            doSearch(searchInput.text.toString())
        }
        view.findViewById<TextView>(R.id.scanBtn).setOnClickListener {
            scanLauncher.launch(Intent(requireContext(), ScanActivity::class.java))
        }
        view.findViewById<TextView>(R.id.logoutBtn).setOnClickListener {
            Session.clear()
            goLogin()
        }

        // 启动时按网络模式应用后端地址（auto 检测 Home-WiFi）
        viewLifecycleOwner.lifecycleScope.launch {
            NetworkDetector.applyNetworkMode(requireContext())
            loadRecords()
            refreshPrinterStatus()
        }
        searchInput.setOnEditorActionListener { _, _, _ ->
            doSearch(searchInput.text.toString())
            true
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
    }

    // ── 搜索 ──
    /** 搜索框右侧清除图标:非空时显示 ✕,点击清空输入并退出搜索回到打单记录(2026-10-23) */
    private fun setupClearButton() {
        val size = (18 * resources.displayMetrics.density).toInt()
        val clearIcon = ContextCompat.getDrawable(requireContext(), R.drawable.ic_clear)?.apply {
            setBounds(0, 0, size, size)
        }
        searchInput.doAfterTextChanged { text ->
            if (text.isNullOrEmpty()) {
                searchInput.setCompoundDrawables(null, null, null, null)
                // 无论点 ✕ 还是键盘删空,都退出搜索态并清除搜索结果,回到发货记录
                if (currentKeyword.isNotBlank()) {
                    currentKeyword = ""
                    results = emptyList()
                    bannerText.visibility = View.GONE
                    refreshList()
                    loadRecords()
                }
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
                    return@setOnTouchListener true
                }
            }
            false
        }
    }

    private fun doSearch(keyword: String) {
        val kw = keyword.trim()
        if (kw.isEmpty()) {
            toast("请输入搜索内容")
            return
        }
        currentKeyword = kw
        viewLifecycleOwner.lifecycleScope.launch {
            progressBar.visibility = View.VISIBLE
            bannerText.visibility = View.GONE
            try {
                val data = Api.get(
                    "/admin/api/order-process/list",
                    mapOf(
                        "tab" to "all",
                        "globalKeyword" to kw,
                        "globalMode" to "ss",
                        "page" to 1,
                        "pageSize" to 50
                    )
                )
                val resp = Api.parse<PackageListResponse>(data)
                results = resp.packages
                refreshList()
                showBanner(
                    if (results.isNotEmpty()) "命中 ${results.size} 个包裹,请在卡片上操作"
                    else "未找到匹配订单「$kw」",
                    ok = results.isNotEmpty()
                )
            } catch (e: Exception) {
                handleError(e)
            } finally {
                progressBar.visibility = View.GONE
            }
        }
    }

    // ── 打单记录 ──
    private fun loadRecords() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                // 同时拉今日/昨日(2026-10-17):原来只拉当前 tab,
                // 未点过的另一个 tab 计数永远为 0
                val todayResp = Api.parse<PackageListResponse>(
                    Api.get(
                        "/admin/api/order-process/scan-ship/records",
                        mapOf("day" to "today", "page" to 1, "pageSize" to 10)
                    )
                )
                val yesterdayResp = Api.parse<PackageListResponse>(
                    Api.get(
                        "/admin/api/order-process/scan-ship/records",
                        mapOf("day" to "yesterday", "page" to 1, "pageSize" to 10)
                    )
                )
                countToday = todayResp.total
                countYesterday = yesterdayResp.total
                records = if (currentTab == "today") todayResp.packages else yesterdayResp.packages
                refreshList()
            } catch (e: Exception) {
                // 记录加载失败静默，不影响主流程
            }
        }
    }

    private fun refreshList() {
        adapter.setData(results, records, currentTab, countToday, countYesterday)
    }

    // ── 入库 ──
    private fun confirmAndShip(pkg: Pkg) {
        val totalQty = (pkg.items?.sumOf { it.quantity ?: 0.0 } ?: 0.0).toLong()
        if (totalQty > 1) {
            AlertDialog.Builder(requireContext())
                .setTitle("入库确认")
                .setMessage("货件 ${pkg.postingNumber}\n共 $totalQty 件商品,将向 Ozon 确认全部商品为一个货件(不拆分)。")
                .setPositiveButton("入库") { _, _ -> doShipPackage(pkg) }
                .setNegativeButton("取消", null)
                .show()
        } else {
            doShipPackage(pkg)
        }
    }

    private fun doShipPackage(pkg: Pkg) {
        // 入库接口可能耗时较长(2026-10-17):模态提示"正在入库中",结束后自动关闭
        val dlg = requireContext().showBlockingLoading("正在入库中，请稍候…")
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = Api.post("/admin/api/order-process/ship", mapOf("packageId" to pkg.id)).asJsonObject
                val title = when {
                    r.optBoolean("alreadyShipped") -> "该包裹已入库过"
                    r.optBoolean("pending") -> "入库指令已提交"
                    else -> "入库成功"
                }
                toast(title)
                doSearch(currentKeyword)
            } catch (e: Exception) {
                handleError(e)
            } finally {
                runCatching { dlg.dismiss() }
            }
        }
    }

    // ── 称重打单 ──
    private fun submitShip(pkg: Pkg, weightG: Int) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = Api.post(
                    "/admin/api/order-process/scan-ship/submit",
                    mapOf("packageId" to pkg.id, "weightG" to weightG)
                ).asJsonObject
                if (!r.optBoolean("canShip")) {
                    toast(r.optString("message", "订单状态不允许打单"))
                    return@launch
                }
                // 提交成功后自动打印面单(后端打印代理);打印失败不阻断打单(无纸化兜底,可卡片补打)
                val printErr = tryPrintPackage(pkg)
                // 标记已打印 → 待打单→待发运
                try {
                    Api.post("/admin/api/order-process/print-label", mapOf("packageId" to pkg.id))
                } catch (_: Exception) {
                    // 打印标记失败不阻断打单
                }
                if (printErr == null) {
                    toast("已打单并打印面单 ${pkg.postingNumber ?: ""},进入待发运")
                } else {
                    toast("已打单(面单打印失败:$printErr,可在卡片补打)")
                }
                if (currentKeyword.isNotBlank()) doSearch(currentKeyword)
                loadRecords()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 面单 ──
    private fun openLabel(pkg: Pkg) {
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
                handleError(e)
            }
        }
    }

    // ── 打印机状态条(顶部常驻) ──
    private fun refreshPrinterStatus() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val data = Api.get("/admin/api/print-agent/status").asJsonObject
                val online = data.optBoolean("online")
                if (online) {
                    val defaultPrinter = data.optString("defaultPrinter")
                    val name = Session.labelPrinter.ifBlank { defaultPrinter.ifBlank { "默认" } }
                    printerBar.text = "🖨 打印机:$name · 在线"
                    printerBar.setTextColor(Color.parseColor("#00b42a"))
                    printerBar.setRoundedBg(0xFFE8FFEA.toInt(), 8f)
                } else {
                    printerBar.text = "🖨 打印机组件离线 · 点击重试"
                    printerBar.setTextColor(Color.parseColor("#86909c"))
                    printerBar.setRoundedBg(0xFFF2F3F5.toInt(), 8f)
                }
            } catch (e: Exception) {
                printerBar.text = "🖨 打印机组件离线 · 点击重试"
                printerBar.setTextColor(Color.parseColor("#86909c"))
                printerBar.setRoundedBg(0xFFF2F3F5.toInt(), 8f)
            }
        }
    }

    /** 点击状态条:拉取打印机列表弹窗单选,选择持久化到 Session */
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

    // ── 打印面单(后端打印代理:拉 PDF → 服务端渲染 PNG → 转发打印组件出纸) ──
    private fun printLabel(pkg: Pkg) {
        viewLifecycleOwner.lifecycleScope.launch {
            progressBar.visibility = View.VISIBLE
            try {
                Api.post(
                    "/admin/api/print-agent/print-package",
                    mapOf("packageId" to pkg.id, "printer" to Session.labelPrinter)
                )
                toast("已发送打印任务 ${pkg.postingNumber ?: ""}")
            } catch (e: Exception) {
                handleError(e)
            } finally {
                progressBar.visibility = View.GONE
            }
        }
    }

    /** 尝试打印面单,成功返回 null,失败返回错误信息(供调用方决定是否阻断交运) */
    private suspend fun tryPrintPackage(pkg: Pkg): String? = try {
        Api.post(
            "/admin/api/print-agent/print-package",
            mapOf("packageId" to pkg.id, "printer" to Session.labelPrinter)
        )
        null
    } catch (e: Exception) {
        e.message ?: "打印失败"
    }

    // ── 无纸预览面单(2026-10-26,与 web 端菜鸟组件预览同链路)──
    // 后端拉 PDF → 渲染 PNG(底部定制区店铺名) → 打印组件无纸预览 → 返回渲染图 base64,对话框显示
    private fun previewLabel(pkg: Pkg) {
        viewLifecycleOwner.lifecycleScope.launch {
            progressBar.visibility = View.VISIBLE
            try {
                // 已解包 data:imageDataUrl/postingNumber 直接位于根对象(2026-10-26 修复)
                val obj = Api.post(
                    "/admin/api/print-agent/preview-package",
                    mapOf("packageId" to pkg.id)
                ).asJsonObject
                val imageDataUrl = obj.optString("imageDataUrl")
                val postingNumber = obj.optString("postingNumber").ifBlank { pkg.postingNumber ?: "" }
                if (imageDataUrl.isBlank()) {
                    toast("预览图拉取失败,请检查打印组件/SSH 隧道后重试")
                    return@launch
                }
                val base64 = imageDataUrl.substringAfter("base64,")
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val bmp = withContext(Dispatchers.IO) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
                if (bmp == null) {
                    toast("预览图解析失败")
                    return@launch
                }
                val density = resources.displayMetrics.density
                val imageView = ImageView(requireContext()).apply {
                    setImageBitmap(bmp)
                    adjustViewBounds = true
                    setPadding((12 * density).toInt(), (12 * density).toInt(), (12 * density).toInt(), (12 * density).toInt())
                }
                AlertDialog.Builder(requireContext())
                    .setTitle("面单预览 $postingNumber")
                    .setView(imageView)
                    .setPositiveButton("关闭", null)
                    .show()
            } catch (e: Exception) {
                handleError(e)
            } finally {
                progressBar.visibility = View.GONE
            }
        }
    }

    // ── 更正重量 ──
    private fun correctWeight(pkg: Pkg, weightG: Int) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                Api.post(
                    "/admin/api/order-process/scan-ship/correct-weight",
                    mapOf("packageId" to pkg.id, "weightG" to weightG)
                )
                toast("重量已更正")
                if (currentKeyword.isNotBlank()) doSearch(currentKeyword)
                loadRecords()
            } catch (e: Exception) {
                handleError(e)
            }
        }
    }

    // ── 辅助 ──
    private fun copyText(text: String, label: String) {
        if (text.isBlank()) return
        val clipboard = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
        toast("$label 已复制")
    }

    private fun showBanner(text: String, ok: Boolean) {
        bannerText.text = text
        bannerText.setRoundedBg(if (ok) 0xFFE8FFEA.toInt() else 0xFFFFECE8.toInt(), 8f)
        bannerText.setTextColor(if (ok) 0xFF00B42A.toInt() else 0xFFF53F3F.toInt())
        bannerText.visibility = View.VISIBLE
    }

    private fun handleError(e: Exception) {
        if (e is ApiException && e.code == 401) {
            toast("登录已过期,请重新登录")
            goLogin()
        } else {
            toast(e.message ?: "请求失败")
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