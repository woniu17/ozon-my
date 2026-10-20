package com.yochylin.scanner

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
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
import kotlinx.coroutines.launch

/** 扫描发货主界面：搜索/扫码/卡片操作/发货记录 */
class MainActivity : ComponentActivity() {

    private lateinit var searchInput: EditText
    private lateinit var bannerText: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var recyclerView: RecyclerView

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
        if (result.resultCode == RESULT_OK) {
            val code = result.data?.getStringExtra("code") ?: ""
            if (code.isNotBlank()) {
                searchInput.setText(code)
                doSearch(code)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Session.init(this)
        if (!Session.isLoggedIn) {
            goLogin()
            return
        }

        setContentView(R.layout.activity_main)

        searchInput = findViewById(R.id.searchInput)
        bannerText = findViewById(R.id.bannerText)
        progressBar = findViewById(R.id.progressBar)
        recyclerView = findViewById(R.id.recyclerView)

        recyclerView.layoutManager = LinearLayoutManager(this)
        recyclerView.adapter = adapter

        findViewById<TextView>(R.id.searchBtn).setOnClickListener {
            doSearch(searchInput.text.toString())
        }
        findViewById<TextView>(R.id.scanBtn).setOnClickListener {
            scanLauncher.launch(Intent(this, ScanActivity::class.java))
        }
        // 消息推送序列表（2026-10-18 通知日志查看入口）
        findViewById<TextView>(R.id.pushLogBtn).setOnClickListener {
            startActivity(Intent(this, PushLogActivity::class.java))
        }
        findViewById<TextView>(R.id.intranetBtn).apply {
            updateIntranetBtn(this)
            setOnClickListener {
                NetworkDetector.manualOverride = true
                Session.useIntranet = !Session.useIntranet
                updateIntranetBtn(this)
                toast(if (Session.useIntranet) "已手动切换内网 192.168.1.212:3001" else "已手动切换公网 yochylin.com:17443")
            }
        }
        findViewById<TextView>(R.id.logoutBtn).setOnClickListener {
            Session.clear()
            goLogin()
        }

        // 底部导航栏
        setupBottomNav(this, "home")

        // 启动时自动探测内网，可达则自动切换为内网模式
        lifecycleScope.launch {
            val changed = NetworkDetector.autoDetectAndApply()
            updateIntranetBtn(findViewById(R.id.intranetBtn))
            if (changed) {
                toast(if (Session.useIntranet) "检测到内网，已自动切换" else "内网不可达，已使用公网")
            }
        }
        searchInput.setOnEditorActionListener { _, _, _ ->
            doSearch(searchInput.text.toString())
            true
        }

        loadRecords()
    }

    // ── 搜索 ──
    private fun doSearch(keyword: String) {
        val kw = keyword.trim()
        if (kw.isEmpty()) {
            toast("请输入搜索内容")
            return
        }
        currentKeyword = kw
        lifecycleScope.launch {
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

    // ── 发货记录 ──
    private fun loadRecords() {
        lifecycleScope.launch {
            try {
                val data = Api.get(
                    "/admin/api/order-process/scan-ship/records",
                    mapOf("day" to currentTab, "page" to 1, "pageSize" to 10)
                )
                val resp = Api.parse<PackageListResponse>(data)
                records = resp.packages
                if (currentTab == "today") countToday = resp.total else countYesterday = resp.total
                refreshList()
            } catch (e: Exception) {
                // 记录加载失败静默，不影响主流程
            }
        }
    }

    private fun refreshList() {
        adapter.setData(results, records, currentTab, countToday, countYesterday)
    }

    // ── 备货 ──
    private fun confirmAndShip(pkg: Pkg) {
        val totalQty = (pkg.items?.sumOf { it.quantity ?: 0.0 } ?: 0.0).toLong()
        if (totalQty > 1) {
            AlertDialog.Builder(this)
                .setTitle("备货确认")
                .setMessage("货件 ${pkg.postingNumber}\n共 $totalQty 件商品,将向 Ozon 确认全部商品为一个货件(不拆分)。")
                .setPositiveButton("备货") { _, _ -> doShipPackage(pkg) }
                .setNegativeButton("取消", null)
                .show()
        } else {
            doShipPackage(pkg)
        }
    }

    private fun doShipPackage(pkg: Pkg) {
        // 备货接口可能耗时较长(2026-10-17):模态提示"正在备货中",结束后自动关闭
        val dlg = showBlockingLoading("正在备货中，请稍候…")
        lifecycleScope.launch {
            try {
                val r = Api.post("/admin/api/order-process/ship", mapOf("packageId" to pkg.id)).asJsonObject
                val title = when {
                    r.optBoolean("alreadyShipped") -> "该包裹已备货过"
                    r.optBoolean("pending") -> "备货指令已提交"
                    else -> "备货成功"
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

    // ── 提交发货 ──
    private fun submitShip(pkg: Pkg, weightG: Int) {
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
                // 提交成功后自动打印面单(后端打印代理);打印失败不阻断交运(无纸化兜底,可卡片补打)
                val printErr = tryPrintPackage(pkg)
                // 标记已打印 → 流转交运
                try {
                    Api.post("/admin/api/order-process/print-label", mapOf("packageId" to pkg.id))
                } catch (_: Exception) {
                    // 打印标记失败不阻断交运
                }
                if (printErr == null) {
                    toast("已交运并打印面单 ${pkg.postingNumber ?: ""}")
                } else {
                    toast("已交运(面单打印失败:$printErr,可在卡片补打)")
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
                handleError(e)
            }
        }
    }

    // ── 打印面单(后端打印代理:拉 PDF → 服务端渲染 PNG → 转发打印组件出纸) ──
    private fun printLabel(pkg: Pkg) {
        lifecycleScope.launch {
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

    // ── 更正重量 ──
    private fun correctWeight(pkg: Pkg, weightG: Int) {
        lifecycleScope.launch {
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
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
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
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    private fun updateIntranetBtn(btn: TextView) {
        btn.text = if (Session.useIntranet) "内网" else "公网"
        if (Session.useIntranet) {
            btn.setTextColor(Color.WHITE)
            btn.setRoundedBg(Color.parseColor("#165dff"), 999f)
        } else {
            btn.setTextColor(Color.parseColor("#165dff"))
            btn.setRoundedBg(Color.parseColor("#eef4ff"), 999f)
        }
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}