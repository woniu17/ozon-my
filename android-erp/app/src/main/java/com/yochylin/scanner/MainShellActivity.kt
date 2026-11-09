package com.yochylin.scanner

import android.Manifest
import android.app.AlertDialog
import android.app.ProgressDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.yochylin.scanner.api.Api
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/**
 * 宿主 Activity：承载底部导航四个模块 Fragment（底部栏常驻，切换不重建页面）
 * 同时负责自动检测新版本并下载安装。
 */
class MainShellActivity : FragmentActivity(), TabHost {

    private val fragments = mutableMapOf<String, Fragment>()

    // ── 新订单通知 ──
    private companion object {
        const val EXTRA_SWITCH_TAB = "switchTab"
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        // 拒绝后给出引导：未授权则新订单提醒不会显示
        if (!granted && Build.VERSION.SDK_INT >= 33) {
            Toast.makeText(
                this,
                "通知权限未开启，新订单提醒将无法显示，可在系统设置中开启",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    // 自动检测内网需要读取 WiFi 名称（Android 8+ 需定位权限）
    private val locationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (!granted) {
            Toast.makeText(
                this,
                "定位权限未开启，自动检测内网将不可用，可在系统设置中开启或手动选择网络模式",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Session.init(this)
        if (!Session.isLoggedIn) {
            goLogin()
            return
        }

        // 先确定后端地址（网络模式），再创建界面/发请求，避免首次请求用错 base URL（评审优化）
        NetworkDetector.applyNetworkMode(this)
        // 注册默认网络回调：后续 WiFi/流量切换时自动重新检测（幂等，全局一次）
        NetworkDetector.registerNetworkListener(this)

        setContentView(R.layout.activity_main_shell)

        // 默认首页为「订单处理」(2026-10-26 用户要求);底部导航「首页」仍可切换回扫描打单
        setupBottomNav(this, "order")
        switchTab("order")

        requestNotificationPermissionIfNeeded()
        requestLocationPermissionIfNeeded()
        handleSwitchTabIntent(intent)

        // 启动新订单监控前台服务（保活，App 退出后仍持续检测）
        try {
            ContextCompat.startForegroundService(this, Intent(this, NewOrderNotifyService::class.java))
        } catch (_: Exception) {
            // 服务启动失败（如系统限制）时静默，不影响主流程
        }

        checkUpdate()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSwitchTabIntent(intent)
    }

    /** 回到前台时重新按网络模式计算后端地址（覆盖后台期间 WiFi/流量切换的竞态窗口） */
    override fun onResume() {
        super.onResume()
        NetworkDetector.applyNetworkMode(this)
    }

    override fun onDestroy() {
        super.onDestroy()
    }

    override fun switchTab(tab: String) {
        val fm = supportFragmentManager
        val old = fragments.entries.firstOrNull { it.value.isVisible }?.key
        if (old == tab) return

        val ft = fm.beginTransaction()
        val newFrag = getFragment(tab)
        if (old != null) {
            val oldFrag = fragments[old]
            if (oldFrag != null) ft.hide(oldFrag)
        }
        if (!newFrag.isAdded) {
            ft.add(R.id.shellContainer, newFrag, tab)
        } else {
            ft.show(newFrag)
        }
        ft.commitNow()

        setupBottomNav(this, tab)
    }

    private fun getFragment(tab: String): Fragment {
        return fragments.getOrPut(tab) {
            when (tab) {
                "order" -> OrderListFragment()
                "finance" -> FinanceFragment()
                "stats" -> OrderStatsFragment()
                "health" -> StoreHealthFragment()
                "stock" -> StockScanFragment()
                "container" -> ContainerLabelFragment()
                else -> ScanShipFragment()
            }
        }
    }

    private fun goLogin() {
        startActivity(Intent(this, LoginActivity::class.java))
        finish()
    }

    // ============ 新订单通知 ============

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /** Android 8+ 读取 WiFi 名称需要定位权限（Android 13+ 通知权限同理按需申请） */
    private fun requestLocationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 23 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            locationPermissionLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
        }
    }

    /** 通知点击后切换到目标 Tab（订单处理） */
    private fun handleSwitchTabIntent(intent: Intent?) {
        val tab = intent?.getStringExtra(EXTRA_SWITCH_TAB)
        if (tab != null) {
            switchTab(tab)
        }
    }

    // ============ 自动更新 ============

    /** 检查新版本；manual=true 时（手动点击）无更新会提示已是最新 */
    fun checkUpdate(manual: Boolean = false) {
        lifecycleScope.launch {
            val info = withContext(Dispatchers.IO) {
                try {
                    val obj = Api.get("/miniapp/version.json").asJsonObject
                    val code = obj.get("versionCode")?.asInt ?: 0
                    val name = obj.get("versionName")?.asString ?: ""
                    val path = obj.get("downloadPath")?.asString ?: ""
                    Triple(code, name, path)
                } catch (e: Exception) {
                    null
                }
            }
            if (info == null) {
                if (manual) Toast.makeText(this@MainShellActivity, "检查更新失败，请稍后重试", Toast.LENGTH_SHORT).show()
                return@launch
            }
            val (versionCode, versionName, downloadPath) = info
            if (versionCode > BuildConfig.VERSION_CODE && downloadPath.isNotBlank()) {
                showUpdateDialog(versionName, Api.BASE_URL + "/miniapp/" + downloadPath)
            } else if (manual) {
                Toast.makeText(this@MainShellActivity, "已是最新版本 v${BuildConfig.VERSION_NAME}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showUpdateDialog(versionName: String, url: String) {
        AlertDialog.Builder(this)
            .setTitle("发现新版本 v$versionName")
            .setMessage("检测到新版本，是否立即下载更新？\n当前版本：v${BuildConfig.VERSION_NAME}")
            .setPositiveButton("立即更新") { _, _ -> startDownload(url) }
            .setNegativeButton("稍后", null)
            .show()
    }

    private fun startDownload(url: String) {
        // 2026-11-09:内网模式下系统 DownloadManager 不走 App 自定义 DNS(会解析到公网 IP 导致下载失败),
        // 改用 OkHttp(Api.client 含自定义 DNS)下载到 App 外部目录,完成后直接拉起安装。
        val dlg = ProgressDialog(this).apply {
            setTitle("正在下载更新包")
            setMessage("连接服务器…")
            setProgressStyle(ProgressDialog.STYLE_HORIZONTAL)
            setMax(100)
            setCancelable(true)
            setCanceledOnTouchOutside(false)
        }
        dlg.show()
        lifecycleScope.launch {
            val file = try {
                withContext(Dispatchers.IO) {
                    downloadToFile(url) { pct ->
                        runOnUiThread { dlg.progress = pct }
                    }
                }
            } catch (e: Exception) {
                null
            }
            dlg.dismiss()
            if (file != null) {
                installApkFile(file)
            } else {
                Toast.makeText(this@MainShellActivity, "下载失败，请确认网络后重试", Toast.LENGTH_LONG).show()
            }
        }
    }

    /** 用 OkHttp(含自定义 DNS)下载 APK 到 App 外部目录 */
    private fun downloadToFile(url: String, onProgress: (Int) -> Unit): File {
        val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "update")
        if (!dir.exists()) dir.mkdirs()
        val target = File(dir, "scanner-ship.apk")
        val request = okhttp3.Request.Builder().url(url).build()
        Api.client.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
            val body = resp.body ?: throw IOException("响应体为空")
            val total = body.contentLength()
            body.byteStream().use { input ->
                target.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var lastPct = -1
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        done += n
                        if (total > 0) {
                            val pct = (done * 100 / total).toInt()
                            if (pct != lastPct) {
                                lastPct = pct
                                onProgress(pct)
                            }
                        }
                    }
                }
            }
        }
        return target
    }

    /** 安装已下载的 APK（Android 7.0+ 经 FileProvider 转 content://） */
    private fun installApkFile(file: File) {
        try {
            val apkUri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW)
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive")
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(this, "下载完成，请到文件管理中安装", Toast.LENGTH_LONG).show()
        }
    }
}