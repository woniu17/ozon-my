package com.yochylin.scanner

import android.Manifest
import android.app.AlertDialog
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
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
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.optInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 宿主 Activity：承载底部导航四个模块 Fragment（底部栏常驻，切换不重建页面）
 * 同时负责自动检测新版本并下载安装。
 */
class MainShellActivity : FragmentActivity(), TabHost {

    private val fragments = mutableMapOf<String, Fragment>()

    private var pendingDownloadId: Long = -1L

    // ── 新订单通知 ──
    private companion object {
        const val CHANNEL_ID = "new_order"
        const val NOTIFICATION_ID = 1001
        const val EXTRA_SWITCH_TAB = "switchTab"
        const val POLL_INTERVAL_MS = 30_000L
    }

    private var pollJob: Job? = null
    private var lastWaitProcessCount = -1L

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* 用户授权与否均静默处理：未授权则不发送通知 */ }

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

        ContextCompat.registerReceiver(
            this,
            downloadReceiver,
            IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED
        )
        checkUpdate()
    }

    override fun onStart() {
        super.onStart()
        startNewOrderPolling()
    }

    override fun onStop() {
        super.onStop()
        pollJob?.cancel()
        pollJob = null
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

    /** 前台轮询待处理订单数，数量增加时发本地通知 */
    private fun startNewOrderPolling() {
        if (pollJob != null) return
        pollJob = lifecycleScope.launch {
            while (isActive) {
                try {
                    val obj = Api.get("/admin/api/order-process/tabs").asJsonObject
                    val count = obj.optInt("waitProcess", -1).toLong()
                    if (count >= 0) {
                        if (lastWaitProcessCount >= 0 && count > lastWaitProcessCount) {
                            showNewOrderNotification(count, count - lastWaitProcessCount)
                        }
                        lastWaitProcessCount = count
                    }
                } catch (_: Exception) {
                    // 网络/登录异常静默，下一轮再试
                }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    private fun showNewOrderNotification(total: Long, added: Long) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL_ID, "新订单提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "检测到新的待处理订单时提醒"
            }
            nm.createNotificationChannel(channel)
        }
        val intent = Intent(this, MainShellActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_SWITCH_TAB, "order")
        }
        val pi = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_new_order)
            .setContentTitle("新增 $added 个待处理订单")
            .setContentText("当前待处理订单 $total 个，点击查看")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()
        nm.notify(NOTIFICATION_ID, notification)
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
                    val intent = Intent(Intent.ACTION_VIEW)
                    intent.setDataAndType(Uri.parse(uri), "application/vnd.android.package-archive")
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                }
            }
            cursor?.close()
        } catch (e: Exception) {
            Toast.makeText(this, "下载完成，请点击系统通知安装", Toast.LENGTH_LONG).show()
        }
    }
}