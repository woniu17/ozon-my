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
import com.google.gson.JsonArray
import com.yochylin.scanner.adapter.fmtMoney
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optInt
import com.yochylin.scanner.api.optString
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
 * - 通过"待处理列表差集"识别真正新增的订单，通知展示店铺/货件号/销售金额（参考飞书新订单通知）
 */
class NewOrderNotifyService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var pollJob: Job? = null

    /** 一条新订单摘要（店铺/货件号/销售金额，对齐飞书通知字段） */
    private data class NewOrderInfo(
        val storeName: String,
        val postingNumber: String,
        val amount: Double,
    )

    companion object {
        const val CHANNEL_MONITOR = "order_monitor"
        const val CHANNEL_NEW_ORDER = "new_order"
        const val NOTIFICATION_ONGOING_ID = 1002
        const val NOTIFICATION_NEW_ORDER_ID = 1001
        const val POLL_INTERVAL_MS = 30_000L
        const val LIST_SIZE = 10
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
                description = "检测到新的待处理订单时提醒（含店铺/单号/金额）"
            }
        )
    }

    /** 构建方块样式的常驻监控通知：不设标题/正文，直接显示今日单量/销售额两个数据方块 */
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
            // 折叠与展开均直接显示方块数据，无"新订单监控中"文案、无折叠成单行的效果
            .setCustomContentView(views)
            .setCustomBigContentView(views)
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
                    val count = totals?.optInt("validCount", 0) ?: 0
                    val amount = totals?.optDouble("validAmount", 0.0) ?: 0.0
                    updateMonitorNotification(count.toLong(), amount)
                } catch (_: Exception) {
                    // 今日统计失败不影响新订单检测
                }

                // 2) 新订单检测：tabs 计数 + 待处理列表差集，识别真正"新增"的订单
                try {
                    val obj = Api.get("/admin/api/order-process/tabs").asJsonObject
                    val waitCount = obj.optInt("waitProcess", -1).toLong()

                    val current = fetchLatestWaitProcessOrders()
                    val currentSns = current.map { it.postingNumber }.filter { it.isNotBlank() }
                    val lastSns = Session.lastWaitProcessSns
                    val newOrders = currentSns.filter { it !in lastSns }
                        .mapNotNull { sn -> current.find { it.postingNumber == sn } }
                    Session.lastWaitProcessSns = currentSns

                    var addedFallback = 0L
                    if (waitCount >= 0) {
                        val last = Session.lastWaitProcessCount
                        if (last >= 0 && waitCount > last) {
                            addedFallback = waitCount - last
                        }
                        Session.lastWaitProcessCount = waitCount
                    }

                    // 优先用差集（精确），差集为空但计数增加时用最新前 N 条兜底
                    if (newOrders.isNotEmpty()) {
                        sendNewOrderNotification(waitCount, newOrders.size.toLong(), newOrders)
                    } else if (addedFallback > 0) {
                        sendNewOrderNotification(waitCount, addedFallback, current.take(addedFallback.toInt()))
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

    /** 拉取待处理列表最新 N 单（与 App 列表同排序：order desc 最新在前） */
    private suspend fun fetchLatestWaitProcessOrders(): List<NewOrderInfo> {
        val listObj = Api.get(
            "/admin/api/order-process/list",
            mapOf(
                "tab" to "waitProcess",
                "page" to "1",
                "pageSize" to "$LIST_SIZE",
                "sortBy" to "order",
                "sortOrder" to "desc"
            )
        ).asJsonObject
        val arr: JsonArray = if (listObj.has("packages") && !listObj.get("packages").isJsonNull) {
            listObj.getAsJsonArray("packages")
        } else {
            JsonArray()
        }
        val result = mutableListOf<NewOrderInfo>()
        for (i in 0 until arr.size()) {
            val p = arr.get(i).asJsonObject
            result.add(
                NewOrderInfo(
                    storeName = p.optString("storeName"),
                    postingNumber = p.optString("postingNumber"),
                    amount = p.optDouble("orderAmount")
                )
            )
        }
        return result
    }

    /** 发送新订单通知：标题 + 飞书风格明细（店铺/货件号/销售金额） */
    private fun sendNewOrderNotification(total: Long, added: Long, orders: List<NewOrderInfo>) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val nm = getSystemService(NotificationManager::class.java) ?: return

        // 收起时的一行摘要：第一单店铺+单号+金额，多单追加"等 N 单"
        val first = orders.firstOrNull()
        val summary = if (first != null) {
            val one = buildString {
                if (first.storeName.isNotBlank()) append("${first.storeName} ")
                append(first.postingNumber)
                append(" 销售金额 ").append(fmtMoney(first.amount))
            }
            if (orders.size > 1) "$one 等 ${orders.size} 单" else one
        } else {
            "当前待处理订单 $total 个"
        }

        // 展开明细（参考飞书新订单通知格式）
        val bigText = buildString {
            for ((i, o) in orders.withIndex()) {
                if (i > 0) append("\n\n")
                val store = o.storeName.ifBlank { "未知店铺" }
                append("[").append(store).append("] [").append(o.postingNumber.ifBlank { "-" }).append("]")
                append("\n销售金额: ").append(fmtMoney(o.amount)).append(" CNY")
            }
            append("\n\n当前待处理订单 ").append(total).append(" 个，点击查看")
        }

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
            .setContentText(summary)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
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