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
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.yochylin.scanner.adapter.fmtMoney
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * 新订单通知前台服务（保活）：
 * - 启动后常驻通知栏（方块样式展示今日单量/销售额），App 退出后台/被划掉后仍持续轮询
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
        // 前台服务常驻通知（先占位，轮询到数据后更新为今日单量/销售额）
        startForeground(NOTIFICATION_ONGOING_ID, buildMonitorNotification("--", "—"))
        startPolling()
        return START_STICKY
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_MONITOR, "订单监控", NotificationManager.IMPORTANCE_LOW).apply {
                description = "后台监控新订单的常驻通知（今日单量/销售额）"
                setShowBadge(false)
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_NEW_ORDER, "新订单提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "检测到新的待处理订单时提醒"
            }
        )
    }

    /** 构建方块样式的常驻监控通知（自定义 RemoteViews 展示两个数据格） */
    private fun buildMonitorNotification(orderCountText: String, salesText: String): Notification {
        val views = RemoteViews(packageName, R.layout.notification_monitor)
        views.setTextViewText(R.id.monitorOrderCountValue, orderCountText)
        views.setTextViewText(R.id.monitorSalesValue, salesText)

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
            .setContentText("今日单量 $orderCountText · 销售额 $salesText")
            .setCustomContentView(views)
            .setCustomBigContentView(views)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
            .setOngoing(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    /** 用最新今日数据更新常驻通知（不重建前台服务） */
    private fun updateMonitorNotification(orderCount: Long, salesAmount: Double) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val countText = "$orderCount 单"
        val salesText = fmtSales(salesAmount)
        nm.notify(NOTIFICATION_ONGOING_ID, buildMonitorNotification(countText, salesText))
    }

    private fun startPolling() {
        if (pollJob != null) return
        pollJob = scope.launch {
            while (isActive) {
                // 1) 今日单量/销售额 → 更新常驻通知
                try {
                    val today = dateString(0)
                    val tomorrow = dateString(1)
                    val obj = Api.get(
                        "/admin/api/order-stats/summary",
                        mapOf("from" to today, "to" to tomorrow, "tz" to "Asia/Shanghai")
                    ).asJsonObject
                    val totals = obj.getAsJsonObject("totals")?.getAsJsonObject("new")
                    val count = totals?.optInt("count", 0) ?: 0
                    val amount = totals?.optDouble("amount", 0.0) ?: 0.0
                    updateMonitorNotification(count.toLong(), amount)
                } catch (_: Exception) {
                    // 今日统计失败不影响新订单检测
                }

                // 2) 新订单增量检测
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

    /** 销售额紧凑格式：≥1万显示"¥x.xx万"，否则显示完整金额 */
    private fun fmtSales(v: Double): String {
        return if (v >= 10_000) {
            String.format(Locale.US, "¥%.2f万", v / 10_000)
        } else {
            fmtMoney(v)
        }
    }

    /** 北京时间（Asia/Shanghai）相对今天的偏移日期，格式 YYYY-MM-DD（与 H5 统计口径一致） */
    private fun dateString(offsetDays: Int): String {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"))
        cal.add(Calendar.DAY_OF_YEAR, offsetDays)
        return SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.time)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        pollJob?.cancel()
        pollJob = null
        super.onDestroy()
    }
}