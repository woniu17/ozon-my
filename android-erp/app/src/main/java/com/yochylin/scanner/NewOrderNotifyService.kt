package com.yochylin.scanner

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * 新订单通知前台服务（保活）：
 * - 启动后常驻通知栏，App 退出后台/被划掉后仍持续轮询待处理订单数
 * - 检测到 waitProcess 数量增加时发送"新订单提醒"通知
 */
class NewOrderNotifyService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var pollJob: Job? = null

    companion object {
        const val CHANNEL_MONITOR = "order_monitor"
        const val CHANNEL_NEW_ORDER = "new_order"
        const val NOTIFICATION_ONGOING_ID = 1002
        const val NOTIFICATION_NEW_ORDER_ID = 1001
        const val POLL_INTERVAL_MS = 30_000L
    }

    override fun onCreate() {
        super.onCreate()
        Session.init(this)
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!Session.isLoggedIn) {
            stopSelf()
            return START_NOT_STICKY
        }
        // 前台服务常驻通知（用户可见，可点击回 App）
        startForeground(NOTIFICATION_ONGOING_ID, buildMonitorNotification())
        startPolling()
        return START_STICKY
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_MONITOR, "订单监控", NotificationManager.IMPORTANCE_LOW).apply {
                description = "后台监控新订单的常驻通知"
                setShowBadge(false)
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_NEW_ORDER, "新订单提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "检测到新的待处理订单时提醒"
            }
        )
    }

    private fun buildMonitorNotification(): Notification {
        val openIntent = Intent(this, MainShellActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pi = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_MONITOR)
            .setSmallIcon(R.drawable.ic_stat_new_order)
            .setContentTitle("新订单监控中")
            .setContentText("正在实时检测新订单，点击返回 App")
            .setOngoing(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun startPolling() {
        if (pollJob != null) return
        pollJob = scope.launch {
            while (isActive) {
                try {
                    val obj = Api.get("/admin/api/order-process/tabs").asJsonObject
                    val count = obj.optInt("waitProcess", -1).toLong()
                    if (count >= 0) {
                        val last = Session.lastWaitProcessCount
                        if (last >= 0 && count > last) {
                            sendNewOrderNotification(count, count - last)
                        }
                        Session.lastWaitProcessCount = count
                    }
                } catch (e: Exception) {
                    // 登录过期：停止监控（登录页会再次启动）
                    if (e is ApiException && e.code == 401) {
                        stopSelf()
                        return@launch
                    }
                    // 其他网络异常静默，下一轮再试
                }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    private fun sendNewOrderNotification(total: Long, added: Long) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val openIntent = Intent(this, MainShellActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("switchTab", "order")
        }
        val pi = PendingIntent.getActivity(
            this,
            1,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_NEW_ORDER)
            .setSmallIcon(R.drawable.ic_stat_new_order)
            .setContentTitle("新增 $added 个待处理订单")
            .setContentText("当前待处理订单 $total 个，点击查看")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .build()
        nm.notify(NOTIFICATION_NEW_ORDER_ID, notification)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        pollJob?.cancel()
        pollJob = null
        super.onDestroy()
    }
}