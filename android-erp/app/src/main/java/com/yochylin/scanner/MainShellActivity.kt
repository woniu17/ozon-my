package com.yochylin.scanner

import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.yochylin.scanner.api.Api
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 宿主 Activity：承载底部导航四个模块 Fragment（底部栏常驻，切换不重建页面）
 * 同时负责自动检测新版本并下载安装。
 */
class MainShellActivity : FragmentActivity(), TabHost {

    private val fragments = mutableMapOf<String, Fragment>()

    private var pendingDownloadId: Long = -1L

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

        ContextCompat.registerReceiver(
            this,
            downloadReceiver,
            IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            ContextCompat.RECEIVER_EXPORTED
        )
        checkUpdate()
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

    // ============ 自动更新 ============

    private fun checkUpdate() {
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
            if (info == null) return@launch
            val (versionCode, versionName, downloadPath) = info
            if (versionCode > BuildConfig.VERSION_CODE && downloadPath.isNotBlank()) {
                showUpdateDialog(versionName, Api.BASE_URL + "/miniapp/" + downloadPath)
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