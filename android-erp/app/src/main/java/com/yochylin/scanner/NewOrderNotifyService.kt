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
import androidx.core.graphics.drawable.toBitmap
import coil.ImageLoader
import coil.request.ImageRequest
import coil.request.SuccessResult
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yochylin.scanner.adapter.fmtMoney
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.ApiException
import com.yochylin.scanner.api.optDouble
import com.yochylin.scanner.api.optInt
import com.yochylin.scanner.api.optString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * 新订单通知前台服务（保活）：
 * - 启动后常驻通知栏（方块样式展示今日单量/销售额），App 退出后台/被划掉后仍持续轮询
 * - 通过"待处理列表差集"识别真正新增的订单，通知展示店铺/货件号/销售金额（参考飞书新订单通知）
 */
class NewOrderNotifyService : Service() {

    private val scopeJob = SupervisorJob()
    private val scope = CoroutineScope(scopeJob + Dispatchers.Default)

    // @Volatile：restartMonitoring 可能从主线程（网络回调）和 IO 线程（内网可达性探测）执行，
    // 跨线程读写需保证可见性，避免竞态窗口内读到过期引用（评审加固）
    @Volatile
    private var pushJob: Job? = null
    @Volatile
    private var fallbackJob: Job? = null

    /** 网络模式变化监听：内网/公网切换时重启监控，让 WS/轮询连到正确的后端（onDestroy 移除） */
    private val networkModeListener: (Boolean) -> Unit = { restartMonitoring() }

    /** 最近已通知过新订单的货件号（内存去重，持久化到 Session，防服务重启重复通知） */
    private val notifiedSns = LinkedHashSet<String>()

    /** notifiedSns 访问锁：WebSocket 回调/差集兜底/启动初始化多协程并发访问，需串行化防 ConcurrentModificationException */
    private val notifiedLock = Any()

    /** 一条新订单摘要（店铺/货件号/销售金额/商品数量/机器名/商品首图，对齐飞书通知字段） */
    private data class NewOrderInfo(
        val storeName: String,
        val postingNumber: String,
        val amount: Double,
        val itemCount: Int = 0, // 2026-10-18:通知第二行 xN 用
        val machineName: String = "",
        val productImageUrl: String = "",
        val packageId: String = "", // 2026-10-17:通知点击跳转订单详情用
    )

    companion object {
        const val CHANNEL_MONITOR = "order_monitor"
        const val CHANNEL_NEW_ORDER = "new_order"
        const val CHANNEL_ORDER_ALERT = "order_alert"
        const val CHANNEL_ORDER_STATUS = "order_status"
        const val NOTIFICATION_ONGOING_ID = 1002
        // 动态通知自增起始(2026-10-18 一单一通知:新订单/状态事件共用,递增不互相覆盖)
        const val NOTIFICATION_ORDER_EVENT_BASE = 1100
        const val PUSH_TIMEOUT_MS = 25_000
        const val FALLBACK_INTERVAL_MS = 5 * 60_000L
        const val NOTIFIED_MAX = 50
        const val LIST_SIZE = 10
    }

    /** 状态事件通知自增 ID(多单并发到达不互相覆盖) */
    private val notificationSeq = AtomicInteger(NOTIFICATION_ORDER_EVENT_BASE)

    override fun onCreate() {
        super.onCreate()
        Session.init(this)
        createChannels()
        // 监听网络模式变化：内网/公网切换时重启监控，避免 WS 一直连旧后端（评审优化）
        NetworkDetector.addModeChangeListener(networkModeListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!Session.isLoggedIn) {
            stopSelf()
            return START_NOT_STICKY
        }
        // 启动时先按当前网络模式确定后端地址，再开始监控（评审优化）
        NetworkDetector.applyNetworkMode(this)
        // 前台服务常驻通知（先占位，轮询到数据后更新为今日单量/销售额）
        startForeground(NOTIFICATION_ONGOING_ID, buildMonitorNotification("--", "—"))
        startMonitoring()
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
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ORDER_ALERT, "订单预警", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "订单取消/需要入库时提醒（需关注处理）"
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ORDER_STATUS, "订单状态", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "揽收/待取件/签收等状态变更通知"
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

    /**
     * 启动监控：
     * - 主通道：WebSocket 实时推送服务端事件（断线指数退避重连，重连后先差集补漏）
     * - 兜底：每 5 分钟差集 catch-up + 刷新今日统计（补断线期间漏掉的事件）
     */
    private fun startMonitoring() {
        if (pushJob != null || fallbackJob != null) return
        loadNotifiedSns()

        // 主通道：WebSocket 实时推送（第二版，断线指数退避重连，重连成功后先差集补漏）
        pushJob = scope.launch {
            // 重连退避：成功收发后立即复位，避免网络恢复后仍保持 60s 慢轮询（评审 P1）
            val backoffMs = AtomicLong(1_000L)
            val wasDisconnected = AtomicBoolean(false)
            while (isActive) {
                val closed = CompletableDeferred<Unit>()
                val listener = object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        backoffMs.set(1_000L)
                        // 重连成功后先补漏（首次连接 wasDisconnected=false 不补）
                        if (wasDisconnected.getAndSet(false)) {
                            scope.launch { runCatchUpDiff() }
                        }
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        backoffMs.set(1_000L)
                        val events = parsePushEvents(text)
                        if (events.isEmpty()) return
                        scope.launch {
                            if (wasDisconnected.getAndSet(false)) {
                                runCatchUpDiff()
                            }
                            handlePushEvents(events)
                        }
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        // token 无效（服务端 close 4001）时停止监控：先释放连接再停服务，避免协程悬挂
                        if (code == 4001) {
                            if (!closed.isCompleted) closed.complete(Unit)
                            stopSelf()
                            return
                        }
                        if (!closed.isCompleted) closed.complete(Unit)
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        if (response?.code == 401) {
                            if (!closed.isCompleted) closed.complete(Unit)
                            stopSelf()
                            return
                        }
                        if (!closed.isCompleted) closed.complete(Unit)
                    }
                }

                val ws = Api.connectPushWebSocket(listener)
                try {
                    closed.await()
                } catch (e: CancellationException) {
                    ws.cancel()
                    throw e
                }
                ws.cancel()
                wasDisconnected.set(true)
                delay(backoffMs.get())
                backoffMs.set((backoffMs.get() * 2).coerceAtMost(60_000L))
            }
        }

        // 兜底：每 5 分钟差集 catch-up + 刷新今日统计
        fallbackJob = scope.launch {
            while (isActive) {
                delay(FALLBACK_INTERVAL_MS)
                runCatchUpDiff()
                refreshTodayStats()
            }
        }

        // 启动时：立即刷新今日统计 + 初始化差集基线（首次不通知）
        scope.launch {
            refreshTodayStats()
            runCatchUpDiff()
        }
    }

    /** 网络模式切换后重启监控：取消旧 WS/轮询协程，重新按当前 base URL 连接（未在监控时忽略） */
    private fun restartMonitoring() {
        if (pushJob == null && fallbackJob == null) return
        pushJob?.cancel()
        pushJob = null
        fallbackJob?.cancel()
        fallbackJob = null
        startMonitoring()
    }

    /** 解析服务端推送消息 {events:[...]}（WebSocket 与长轮询响应同构） */
    private fun parsePushEvents(text: String): List<JsonObject> {
        return try {
            val root = JsonParser.parseString(text).asJsonObject
            val arr = root.getAsJsonArray("events") ?: JsonArray()
            arr.mapNotNull { if (it.isJsonObject) it.asJsonObject else null }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /**
     * 处理服务端推送的事件列表（2026-10-16 扩展：对齐飞书通知全部类型）。
     * 去重键 = 类型 + 货件号（同一货件不同状态各自通知），与差集兜底共用 tryMarkNotified。
     */
    private fun handlePushEvents(events: List<JsonObject>) {
        var orderAdded = false
        for (ev in events) {
            val type = ev.optString("type")
            val postingNumber = ev.optString("postingNumber")
            if (postingNumber.isBlank()) continue
            val store = ev.optString("storeName").ifBlank { "未知店铺" }
            val amount = ev.optDouble("amount")
            // 机器名(2026-10-16 多机部署):事件来自哪个 ERP 实例
            val machine = ev.optString("machineName")
            when (type) {
                "NEW_ORDER" -> {
                    if (!tryMarkNotified("NEW_ORDER:$postingNumber")) continue
                    val imageUrl = ev.optString("productImageUrl")
                    val info = NewOrderInfo(store, postingNumber, amount, ev.optInt("itemCount"), machine, imageUrl, ev.optString("packageId"))
                    val total = ev.optInt("waitProcessCount", 0).toLong()
                    sendNewOrderNotification(total, 1, listOf(info))
                    orderAdded = true
                }
                "ORDER_CANCELLED" -> {
                    if (!tryMarkNotified("ORDER_CANCELLED:$postingNumber")) continue
                    val cancelReason = ev.optString("cancelReason")
                    sendOrderEventNotification(
                        channelId = CHANNEL_ORDER_ALERT,
                        typeLabel = "取消",
                        storeName = store,
                        postingNumber = postingNumber,
                        itemCount = ev.optInt("itemCount"),
                        amount = amount,
                        tab = "order",
                        machineName = machine,
                        productImageUrl = ev.optString("productImageUrl"),
                        packageId = ev.optString("packageId"),
                        extraLines = buildString {
                            append("订单已取消")
                            cancelReason.takeIf { it.isNotBlank() }?.let {
                                append("\n取消原因: ").append(it)
                            }
                        }
                    )
                }
                "STATE_CHANGED" -> {
                    val subState = ev.optString("subState")
                    // 到达取货点不推送安卓(2026-10-17,用户要求);不消费事件,后续恢复通知无需清理去重集合
                    if (subState == "pickup_point") continue
                    if (!tryMarkNotified("STATE_CHANGED:$subState:$postingNumber")) continue
                    // 2026-10-18 优先用后端精简中文状态(入库/揽收/签收/待取);兜底映射保持同步文案
                    val label = ev.optString("stateLabel").ifBlank {
                        when (subState) {
                            "received" -> "签收"
                            "pickup_point" -> "待取"
                            "stocking" -> "入库"
                            else -> "状态变更: ${ev.optString("newState").ifBlank { "—" }}"
                        }
                    }
                    sendOrderEventNotification(
                        channelId = if (subState == "stocking") CHANNEL_ORDER_ALERT else CHANNEL_ORDER_STATUS,
                        typeLabel = label,
                        storeName = store,
                        postingNumber = postingNumber,
                        itemCount = ev.optInt("itemCount"),
                        amount = amount,
                        tab = "order",
                        machineName = machine,
                        productImageUrl = ev.optString("productImageUrl"),
                        packageId = ev.optString("packageId")
                    )
                }
                "PICKED_UP" -> {
                    if (!tryMarkNotified("PICKED_UP:$postingNumber")) continue
                    sendOrderEventNotification(
                        channelId = CHANNEL_ORDER_STATUS,
                        typeLabel = "已揽收",
                        storeName = store,
                        postingNumber = postingNumber,
                        itemCount = ev.optInt("itemCount"),
                        amount = amount,
                        tab = "order",
                        machineName = machine,
                        productImageUrl = ev.optString("productImageUrl"),
                        packageId = ev.optString("packageId")
                    )
                }
            }
        }
        if (orderAdded) {
            // 新订单影响今日统计，立即刷新常驻通知
            scope.launch { refreshTodayStats() }
        }
    }

    /**
     * 通知点击意图(2026-10-17 通知跳转订单详情):
     * - 带 packageId → 依次启动主界面(order tab) + 订单详情页,返回栈完整
     * - 无 packageId(旧版后端事件) → 退化为打开订单处理 tab
     */
    private fun buildContentIntent(packageId: String, tab: String): PendingIntent {
        val shell = Intent(this, MainShellActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("switchTab", tab)
        }
        val requestCode = notificationSeq.incrementAndGet()
        return if (packageId.isNotBlank()) {
            val detail = Intent(this, OrderDetailActivity::class.java).apply {
                putExtra("packageId", packageId)
            }
            PendingIntent.getActivities(
                this,
                requestCode,
                arrayOf(shell, detail),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        } else {
            PendingIntent.getActivity(
                this,
                requestCode,
                shell,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
    }

    /**
     * 发送订单状态事件通知（取消/入库/揽收/签收等）。
     * 2026-10-18 统一格式：标题=第一行"通知类型 店铺名 货件号"，
     * 摘要=第二行"xN ￥金额 · 通知时间"，展开正文=两行 + 附加信息，点击跳转对应 Tab。
     */
    private fun sendOrderEventNotification(
        channelId: String,
        typeLabel: String,
        storeName: String,
        postingNumber: String,
        itemCount: Int,
        amount: Double,
        tab: String,
        machineName: String = "",
        productImageUrl: String = "",
        packageId: String = "",
        extraLines: String = "",
    ) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val pi = buildContentIntent(packageId, tab)
        // 机器名后缀(2026-10-16 多机部署):摘要尾部 + 展开正文底部各一处
        val suffix = if (machineName.isNotBlank()) " [$machineName]" else ""
        // 通知时间(2026-10-18):对齐新订单通知,在商品图片上方的摘要区显示通知时间
        val timeText = SimpleDateFormat("HH:mm", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("Asia/Shanghai")
        }.format(System.currentTimeMillis())
        // 第一行：通知类型 店铺名 货件号
        val title = buildString {
            append(typeLabel)
            if (storeName.isNotBlank()) append(" ").append(storeName)
            if (postingNumber.isNotBlank()) append(" ").append(postingNumber)
        }
        // 第二行：xN ￥金额
        val secondLine = formatItemAmountLine(itemCount, amount)
        val fullSummary = "$secondLine · $timeText" + suffix
        // 展开正文：两行 + 附加信息 + 引导 + 机器名
        val bigText = buildString {
            append(title)
            append("\n").append(secondLine)
            if (extraLines.isNotBlank()) append("\n").append(extraLines)
            append("\n点击查看订单详情")
            if (machineName.isNotBlank()) append("\n[机器: ").append(machineName).append("]")
        }
        val id = notificationSeq.incrementAndGet()
        val builder = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.drawable.ic_stat_new_order)
            .setContentTitle(title)
            .setContentText(fullSummary)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
        nm.notify(id, builder.build())
        // 商品图(2026-10-16 通知大图):先发文本通知保证时效,图片下载完成后再更新同 id 通知
        attachProductImage(id, productImageUrl, timeText, builder)
    }

    /**
     * 差集 catch-up：对比当前待处理前 N 单与上次基线，识别真正"新增"的订单并通知。
     * 首次启动（基线未初始化）时只记录不通知，避免把存量订单误报为新单。
     */
    private suspend fun runCatchUpDiff() {
        try {
            val obj = Api.get("/admin/api/order-process/tabs").asJsonObject
            val waitCount = obj.optInt("waitProcess", -1).toLong()

            val current = fetchLatestWaitProcessOrders()
            val currentSns = current.map { it.postingNumber }.filter { it.isNotBlank() }

            if (!Session.lastWaitProcessInit) {
                // 首次：只记录基线，不通知
                Session.lastWaitProcessSns = currentSns
                Session.lastWaitProcessInit = true
                return
            }

            val lastSns = Session.lastWaitProcessSns
            // 与 WebSocket 事件共用 tryMarkNotified：差集识别出的新单也立即标记（键 NEW_ORDER:单号），
            // 避免后续 WebSocket 推送同一订单时重复通知（评审 P0-1/P1-2）
            val newOrders = currentSns.filter { it !in lastSns && tryMarkNotified("NEW_ORDER:$it") }
                .mapNotNull { sn -> current.find { it.postingNumber == sn } }
            Session.lastWaitProcessSns = currentSns

            if (newOrders.isNotEmpty()) {
                sendNewOrderNotification(waitCount, newOrders.size.toLong(), newOrders)
            }
        } catch (e: ApiException) {
            if (e.code == 401) stopSelf()
        } catch (_: Exception) {
            // 其他网络异常静默，下一轮再试
        }
    }

    /** 拉取今日单量/销售额并更新常驻通知（失败静默，不影响主流程） */
    private suspend fun refreshTodayStats() {
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
    }

    // ── 已通知货件号去重（服务端事件与差集兜底共用）──

    private fun loadNotifiedSns() = synchronized(notifiedLock) {
        notifiedSns.clear()
        notifiedSns.addAll(Session.notifiedPushSns)
    }

    /**
     * 原子"检查并标记"：已在集合中返回 false（该单已通知过，跳过）；
     * 否则加入集合并持久化，返回 true。全程持锁，保证并发下不重复通知、不并发修改集合。
     */
    private fun tryMarkNotified(sn: String): Boolean = synchronized(notifiedLock) {
        if (sn.isBlank() || sn in notifiedSns) {
            false
        } else {
            notifiedSns.add(sn)
            while (notifiedSns.size > NOTIFIED_MAX) {
                val it = notifiedSns.iterator()
                if (it.hasNext()) {
                    it.next()
                    it.remove()
                }
            }
            Session.notifiedPushSns = notifiedSns.toList()
            true
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
        // 机器名(2026-10-16 多机部署):接口由服务端注入,差集兜底通知也能区分来源
        val machineName = listObj.optString("machineName")
        val result = mutableListOf<NewOrderInfo>()
        for (i in 0 until arr.size()) {
            val p = arr.get(i).asJsonObject
            // 商品首图 + 商品数量(2026-10-16/18 通知大图/第二行 xN):遍历 items 累计 quantity,取第一张非空图
            var imageUrl = ""
            var itemCount = 0
            try {
                val items = p.getAsJsonArray("items")
                if (items != null) {
                    for (j in 0 until items.size()) {
                        val it = items.get(j).asJsonObject
                        itemCount += it.optInt("quantity", 0)
                        if (imageUrl.isBlank()) {
                            val url = it.optString("picUrl")
                            if (url.isNotBlank()) imageUrl = url
                        }
                    }
                }
            } catch (_: Exception) {
                // items 缺失/结构异常:无图通知
            }
            result.add(
                NewOrderInfo(
                    storeName = p.optString("storeName"),
                    postingNumber = p.optString("postingNumber"),
                    amount = p.optDouble("orderAmount"),
                    itemCount = itemCount,
                    machineName = machineName,
                    productImageUrl = imageUrl
                )
            )
        }
        return result
    }

    /**
     * 发送新订单通知（2026-10-18 一个订单一个通知，用户要求）。
     * 每条订单独立通知：标题=第一行"新订单 店铺名 货件号"，
     * 摘要=第二行"xN ￥金额 · 通知时间"，展开正文=两行 + 待处理总数。
     * 独立通知 id（notificationSeq 递增），多单并发到达不互相覆盖。
     */
    private fun sendNewOrderNotification(total: Long, added: Long, orders: List<NewOrderInfo>) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (orders.isEmpty()) return

        for (o in orders) {
            // 机器名后缀(2026-10-16 多机部署):摘要尾部 + 展开正文底部各一处
            val machine = o.machineName
            val suffix = if (machine.isNotBlank()) " [$machine]" else ""
            // 通知时间(2026-10-18):摘要区第二行尾部显示
            val timeText = SimpleDateFormat("HH:mm", Locale.US).apply {
                timeZone = TimeZone.getTimeZone("Asia/Shanghai")
            }.format(System.currentTimeMillis())

            // 第一行：通知类型 店铺名 货件号
            val title = buildString {
                append("新订单")
                if (o.storeName.isNotBlank()) append(" ").append(o.storeName)
                if (o.postingNumber.isNotBlank()) append(" ").append(o.postingNumber)
            }
            // 第二行：xN ￥金额
            val secondLine = formatItemAmountLine(o.itemCount, o.amount)
            val summary = "$secondLine · $timeText" + suffix
            val bigText = buildString {
                append(title)
                append("\n").append(secondLine)
                append("\n当前待处理订单 ").append(total).append(" 个，点击查看")
                if (machine.isNotBlank()) append("\n[机器: ").append(machine).append("]")
            }

            // 2026-10-17:带 packageId → 点击直达订单详情;无 packageId 退化为打开订单列表
            val pi = buildContentIntent(o.packageId, "order")
            val id = notificationSeq.incrementAndGet()
            val builder = NotificationCompat.Builder(this, CHANNEL_NEW_ORDER)
                .setSmallIcon(R.drawable.ic_stat_new_order)
                .setContentTitle(title)
                .setContentText(summary)
                .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
            nm.notify(id, builder.build())
            // 商品图(2026-10-16 通知大图):图片下载完成后更新为 BigPicture
            attachProductImage(id, o.productImageUrl, timeText, builder)
        }
    }

    /**
     * 商品图异步加载并更新通知为 BigPicture 大图(2026-10-16 新增)。
     * 策略:先发文本通知保证时效,图片下载完成后再用同一通知 id 更新;
     * 下载/解码失败或超时静默,保持文本通知不变(不影响主流程)。
     *
     * 2026-10-18:
     * - 推送事件的 productImageUrl 为相对路径(/images/cache/...),拼接 Api.BASE_URL
     *   内网/公网自动适配(修复内网模式下通知图片走公网域名加载失败的问题)
     * - 通知时间统一放在商品图片上方(BigPictureStyle.setBigContentTitle)
     */
    private fun attachProductImage(
        notificationId: Int,
        imageUrl: String?,
        timeText: String,
        builder: NotificationCompat.Builder,
    ) {
        if (imageUrl.isNullOrBlank()) return
        scope.launch(Dispatchers.IO) {
            try {
                val absoluteUrl = if (imageUrl.startsWith("/")) Api.BASE_URL + imageUrl else imageUrl
                val loader = ImageLoader(this@NewOrderNotifyService)
                val request = ImageRequest.Builder(this@NewOrderNotifyService)
                    .data(absoluteUrl)
                    .size(768)
                    .allowHardware(false)
                    .build()
                val result = loader.execute(request)
                if (result is SuccessResult) {
                    val bmp = result.drawable.toBitmap()
                    // 复用同一 Builder：先发文本通知，图片就绪后覆盖同 id 为 BigPicture 大图
                    builder.setStyle(
                        NotificationCompat.BigPictureStyle()
                            .bigPicture(bmp)
                            .setBigContentTitle(timeText)
                    )
                    builder.setLargeIcon(bmp)
                    getSystemService(NotificationManager::class.java)?.notify(notificationId, builder.build())
                }
            } catch (_: Exception) {
                // 图片加载失败:保持纯文本通知
            }
        }
    }

    /** 销售额紧凑格式：≥1万显示"¥x.xx万"，否则显示完整金额 */
    private fun fmtSales(v: Double): String {
        return if (v >= 10_000) {
            String.format(Locale.US, "¥%.2f万", v / 10_000)
        } else {
            fmtMoney(v)
        }
    }

    /**
     * 通知第二行统一格式："xN ￥金额"（2026-10-18 用户要求，如 x1 ￥19.0）。
     * N>0 时显示数量前缀；金额保留一位小数（全角人民币符号）。
     */
    private fun formatItemAmountLine(itemCount: Int, amount: Double): String {
        val countText = if (itemCount > 0) "x$itemCount " else ""
        return "$countText￥${String.format(Locale.US, "%.1f", amount)}"
    }

    /** 北京时间（Asia/Shanghai）相对今天的偏移日期，格式 YYYY-MM-DD（与 H5 统计口径一致） */
    private fun dateString(offsetDays: Int): String {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Shanghai"))
        cal.add(Calendar.DAY_OF_YEAR, offsetDays)
        return SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.time)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        NetworkDetector.removeModeChangeListener(networkModeListener)
        pushJob?.cancel()
        pushJob = null
        fallbackJob?.cancel()
        fallbackJob = null
        // 兜底取消整个 scope：IO 线程触发的 restartMonitoring 可能在 onDestroy 期间
        // 重新启动 WS/轮询协程，只取消字段引用会漏掉这些新协程（评审加固）
        scopeJob.cancel()
        super.onDestroy()
    }
}