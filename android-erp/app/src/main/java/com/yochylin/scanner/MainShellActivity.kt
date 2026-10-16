package com.yochylin.scanner

import android.Manifest
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
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

/**
 * 宿主 Activity：承载底部导航四个模块 Fragment（底部栏常驻，切换不重建页面）
 * 同时负责自动检测新版本并下载安装。
 */
class MainShellActivity : FragmentActivity(), TabHost {

    private val fragments = mutableMapOf<String, Fragment>()

    private var pendingDownloadId: Long = -1L

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

    /** 下载完成监听：自动拉起系统安装器 */
    private val downloadReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == DownloadManager.ACTION_DOWNLOAD_COMPLETE) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                if (id == pendingDownloadId) {
                    installApk(id)
                }
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

        setContentView(R.layout.activity_main_shell)

        setupBottomNav(this, "home")
        switchTab("home")

        requestNotificationPermissionIfNeeded()
        handleSwitchTabIntent(intent)

        // 启动新订单监控前台服务（保活，App 退出后仍持续检测）
        try {
            ContextCompat.startForegroundService(this, Intent(this, NewOrderNotifyService::class.java))
        } catch (_: Exception) {
            // 服务启动失败（如系统限制）时静默，不影响主流程
        }

        ContextCompat.registerReceiver(
            this,
            downloadReceiver,
            IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED
        )
        checkUpdate()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSwitchTabIntent(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            unregisterReceiver(downloadReceiver)
        } catch (_: Exception) {
        }
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
        try {
            val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle("扫描发货 新版本")
                .setDescription("正在下载更新包…")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(
                    android.os.Environment.DIRECTORY_DOWNLOADS,
                    "scanner-ship.apk"
                )
                .setMimeType("application/vnd.android.package-archive")
            pendingDownloadId = dm.enqueue(request)
            Toast.makeText(this, "开始下载更新包…", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            // 下载管理器不可用时退回浏览器下载
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (_: Exception) {
            }
        }
    }

    private fun installApk(downloadId: Long) {
        try {
            val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
            val query = DownloadManager.Query().setFilterById(downloadId)
            val cursor: Cursor? = dm.query(query)
            if (cursor != null && cursor.moveToFirst()) {
                val uri = cursor.getString(cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI))
                if (!uri.isNullOrBlank()) {
                    // Android 7.0+ 禁止 file:// 暴露给其他应用，file:// 需经 FileProvider 转 content://
                    val apkUri = if (uri.startsWith("file://")) {
                        FileProvider.getUriForFile(
                            this,
                            "${packageName}.fileprovider",
                            File(Uri.parse(uri).path!!)
                        )
                    } else {
                        Uri.parse(uri)
                    }
                    val intent = Intent(Intent.ACTION_VIEW)
                    intent.setDataAndType(apkUri, "application/vnd.android.package-archive")
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    startActivity(intent)
                }
            }
            cursor?.close()
        } catch (e: Exception) {
            Toast.makeText(this, "下载完成，请点击系统通知安装", Toast.LENGTH_LONG).show()
        }
    }
}