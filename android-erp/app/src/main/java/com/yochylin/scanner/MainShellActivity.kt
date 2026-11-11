package com.yochylin.scanner

import android.Manifest
import android.app.AlertDialog
import android.app.ProgressDialog
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
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
import java.io.InputStream
import java.io.OutputStream

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

    // Android 9 及以下写公共 Download 目录需要存储权限（10+ 走 MediaStore 无需权限）
    private var pendingDownloadUrl: String? = null
    private val storagePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        val url = pendingDownloadUrl
        if (granted && url != null) {
            pendingDownloadUrl = null
            doDownload(url)
        } else {
            Toast.makeText(this, "需要存储权限才能下载更新包，可在系统设置中开启后重试", Toast.LENGTH_LONG).show()
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
                "shipPhoto" -> ShipPhotoFragment()
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
        // Android 9 及以下写公共 Download 目录需要存储权限；10+ 用 MediaStore 无需权限
        if (Build.VERSION.SDK_INT <= 28 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingDownloadUrl = url
            storagePermissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            return
        }
        doDownload(url)
    }

    private fun doDownload(url: String) {
        // 2026-11-09:内网模式下系统 DownloadManager 不走 App 自定义 DNS(会解析到公网 IP 导致下载失败),
        // 改用 OkHttp(Api.client 含自定义 DNS)下载到公共 Download/ScannerShip 目录。
        // 2026-11-11:改为下载到公共目录后提示用户手动安装(无"安装未知应用"授权时系统禁止直接安装)。
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
            val apk = try {
                withContext(Dispatchers.IO) {
                    downloadApk(url) { pct ->
                        runOnUiThread { dlg.progress = pct }
                    }
                }
            } catch (e: Exception) {
                null
            }
            dlg.dismiss()
            if (apk != null) {
                onApkDownloaded(apk)
            } else {
                Toast.makeText(this@MainShellActivity, "下载失败，请确认网络后重试", Toast.LENGTH_LONG).show()
            }
        }
    }

    /** 下载结果：file 用于 FileProvider 直接拉起安装；displayPath 用于提示用户手动安装 */
    private data class ApkDownload(val file: File?, val uri: Uri?, val displayPath: String)

    /** 用 OkHttp(含自定义 DNS)下载 APK 到公共 Download/ScannerShip 目录 */
    private fun downloadApk(url: String, onProgress: (Int) -> Unit): ApkDownload {
        val request = okhttp3.Request.Builder().url(url).build()
        return Api.client.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
            val body = resp.body ?: throw IOException("响应体为空")
            val total = body.contentLength()
            if (Build.VERSION.SDK_INT >= 29) {
                saveApkViaMediaStore(body.byteStream(), total, onProgress)
            } else {
                saveApkToPublicDir(body.byteStream(), total, onProgress)
            }
        }
    }

    /** Android 10+：经 MediaStore 写入公共 Download/ScannerShip（无需存储权限） */
    @RequiresApi(29)
    private fun saveApkViaMediaStore(input: InputStream, total: Long, onProgress: (Int) -> Unit): ApkDownload {
        val fileName = "scanner-ship.apk"
        val relativePath = "${Environment.DIRECTORY_DOWNLOADS}/ScannerShip"
        // 先删除旧记录，避免同名文件在媒体库中累积
        contentResolver.delete(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            "${MediaStore.Downloads.DISPLAY_NAME}=? AND ${MediaStore.Downloads.RELATIVE_PATH}=?",
            arrayOf(fileName, relativePath)
        )
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
            put(MediaStore.Downloads.MIME_TYPE, "application/vnd.android.package-archive")
            put(MediaStore.Downloads.RELATIVE_PATH, relativePath)
        }
        val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("无法创建下载文件")
        try {
            contentResolver.openOutputStream(uri)?.use { output ->
                copyStream(input, output, total, onProgress)
            } ?: throw IOException("无法打开下载文件")
        } catch (e: Exception) {
            try { contentResolver.delete(uri, null, null) } catch (_: Exception) {}
            throw e
        }
        val realPath = queryMediaPath(uri)
        return ApkDownload(
            file = realPath?.let { File(it) },
            uri = uri,
            displayPath = realPath ?: "Download/ScannerShip/$fileName"
        )
    }

    /** Android 9 及以下：直接写入公共 Download/ScannerShip */
    private fun saveApkToPublicDir(input: InputStream, total: Long, onProgress: (Int) -> Unit): ApkDownload {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "ScannerShip")
        if (!dir.exists()) dir.mkdirs()
        val target = File(dir, "scanner-ship.apk")
        target.outputStream().use { output ->
            copyStream(input, output, total, onProgress)
        }
        return ApkDownload(file = target, uri = null, displayPath = target.absolutePath)
    }

    /** 流式复制并回调进度 */
    private fun copyStream(input: InputStream, output: OutputStream, total: Long, onProgress: (Int) -> Unit) {
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

    /** 查询 MediaStore 下载文件的实际路径（用于 FileProvider 直接安装） */
    @RequiresApi(29)
    private fun queryMediaPath(uri: Uri): String? {
        return try {
            // _data 是隐藏列名，直接用字符串（MediaStore.Downloads._DATA 对 Kotlin 不可见）
            contentResolver.query(uri, arrayOf("_data"), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
            }
        } catch (e: Exception) {
            null
        }
    }

    /** 下载完成：已有"安装未知应用"授权则直接拉起安装，否则提示用户到文件管理器手动安装 */
    private fun onApkDownloaded(apk: ApkDownload) {
        if (apk.file != null && canInstallUnknownApps()) {
            installApkFile(apk.file)
            return
        }
        val path = apk.displayPath
        val dirName = path.substringBeforeLast('/')
        AlertDialog.Builder(this)
            .setTitle("下载完成")
            .setMessage("更新包已保存到：\n$path\n\n系统未允许本应用直接安装，请打开文件管理器，进入「$dirName」目录点击 scanner-ship.apk 手动安装。")
            .setPositiveButton("打开文件夹") { _, _ -> openDownloadFolder() }
            .setNegativeButton("知道了", null)
            .show()
    }

    /** 是否允许本应用直接安装未知来源应用（Android 8+ 需用户在设置中授权） */
    private fun canInstallUnknownApps(): Boolean {
        return Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()
    }

    /** 打开系统文件管理器定位到 Download/ScannerShip 目录 */
    private fun openDownloadFolder() {
        try {
            val treeUri = Uri.parse("content://com.android.externalstorage.documents/tree/primary")
            val childUri = DocumentsContract.buildChildDocumentsUriUsingTree(
                treeUri, "primary:Download/ScannerShip"
            )
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(childUri, "resource/folder")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(this, "请到系统文件管理器的 Download/ScannerShip 目录点击 APK 安装", Toast.LENGTH_LONG).show()
        }
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