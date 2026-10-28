package com.yochylin.scanner

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.CopyOnWriteArraySet

/**
 * 网络模式控制（2026-10-23 升级为三模式）：
 * - auto（默认）：连接 WiFi 且 SSID 为 Home-WiFi 时判定在内网，否则公网
 * - intranet（手动）：强制使用内网
 * - public（手动）：强制使用公网
 *
 * 2026-10-23 增强：
 * - 注册默认网络回调，网络切换时自动重新检测，不再依赖页面重建/手动切换
 * - SSID 不可读（定位关闭/权限缺失/Android 10+ 限制）时，用内网端口可达性兜底，
 *   避免自动模式在办公室内静默失效走公网
 * - 模式变化通过监听器通知 UI 与后台服务刷新/重连
 */
object NetworkDetector {

    const val INTRANET_HOST = "192.168.1.212"
    const val INTRANET_PORT = 3001
    const val INTRANET_BASE = "http://192.168.1.212:3001"

    /** 内网端口探测超时（毫秒）：局域网内正常应在百毫秒内返回 */
    private const val PROBE_TIMEOUT_MS = 1_500

    /** 内网可达性探测最小间隔（毫秒）：WiFi 状态回调频繁时避免反复探测（2026-10-28） */
    private const val PROBE_INTERVAL_MS = 30_000L

    /**
     * 自动模式下判定内网的 WiFi 名称集合。
     * 默认为 Home-WiFi；可在运行时更新（如后续支持后端配置下发），无需发版。
     */
    @Volatile
    var homeWifiSsids: Set<String> = setOf("Home-WiFi")

    /** 网络模式变化监听器（参数=当前是否使用内网） */
    private val modeListeners = CopyOnWriteArraySet<(Boolean) -> Unit>()

    /** 内网可达性探测协程作用域（常驻 IO，与调用方生命周期解耦） */
    private val probeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var networkCallbackRegistered = false

    @Volatile
    private var probing = false

    /** 上次发起内网可达性探测的时间（SystemClock.elapsedRealtime），用于节流 */
    @Volatile
    private var lastProbeAt = 0L

    /**
     * 注册默认网络回调：默认网络可用/丢失时重新检测。
     * 幂等，全局只需注册一次（App 主入口/登录页调用）。
     */
    fun registerNetworkListener(context: Context) {
        if (networkCallbackRegistered) return
        val appContext = context.applicationContext
        val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        networkCallbackRegistered = true
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = reapply(appContext)
                override fun onLost(network: Network) = reapply(appContext)
                // WiFi 断开/流量接管过程中，能力变化时尽快重新判定，缩小竞态窗口
                override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) =
                    reapply(appContext)
            })
        } catch (_: Exception) {
            // 注册失败（权限/系统限制）时退化为仅启动时检测
            networkCallbackRegistered = false
        }
    }

    fun addModeChangeListener(listener: (Boolean) -> Unit) {
        modeListeners.add(listener)
    }

    fun removeModeChangeListener(listener: (Boolean) -> Unit) {
        modeListeners.remove(listener)
    }

    /**
     * 读取当前 WiFi 名称。
     * 非 WiFi 网络、或 SSID 不可读（Android 10+ 定位关闭/未授权返回 "unknown"）时返回 null。
     */
    fun currentSsid(context: Context): String? {
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
        val network = cm.activeNetwork ?: return null
        val caps = cm.getNetworkCapabilities(network) ?: return null
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return null
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
        // WifiInfo.getSSID 在 Android 8.1+ 返回带引号的 SSID（如 "Home-WiFi"）
        return wifi.connectionInfo?.ssid?.trim()?.trim('"')
            ?.takeIf { it.isNotBlank() && !it.equals("unknown", true) && !it.equals("<unknown ssid>", true) }
    }

    /** 当前处于 WiFi 但 SSID 不可读（自动检测降级场景，用于 UI 提示） */
    fun isWifiSsidUnavailable(context: Context): Boolean {
        val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && currentSsid(context) == null
    }

    /**
     * 是否连接了 Home-WiFi。
     * 需要 ACCESS_NETWORK_STATE/ACCESS_WIFI_STATE；Android 8+ 读取 SSID
     * 还需要 ACCESS_FINE_LOCATION（运行时申请），未授权时返回 false。
     */
    fun isOnHomeWifi(context: Context): Boolean {
        val ssid = currentSsid(context) ?: return false
        return ssid in homeWifiSsids
    }

    /**
     * 按当前网络模式应用后端地址：
     * auto → 根据 Home-WiFi 判断（SSID 不可读时异步用内网可达性兜底）；
     * intranet/public → 强制内网/公网。
     * @return true 表示 useIntranet 发生了变化（后端地址已切换）
     */
    fun applyNetworkMode(context: Context): Boolean {
        val target = when (Session.networkMode) {
            Session.MODE_INTRANET -> true
            Session.MODE_PUBLIC -> false
            else -> {
                // 已确认在内网（手动切过/自动探测成功过）：保持内网，不再因 SSID 变化切回公网，
                // 避免内网环境 WiFi 名称不同或 SSID 不可读时被反复判定为公网导致连接失败
                if (Session.useIntranet) {
                    true
                } else {
                    val ssid = currentSsid(context)
                    if (ssid in homeWifiSsids) {
                        true
                    } else {
                        // SSID 不可读（Android 10+ 定位未开/权限缺失）或非 Home-WiFi 名称：
                        // 无法可靠判定，用内网可达性兜底探测（办公 WiFi 名称可能不同），
                        // 探测成功会异步切内网并通知；当前维持现状（默认公网）。
                        probeIntranetReachability()
                        false
                    }
                }
            }
        }
        val changed = Session.useIntranet != target
        Session.useIntranet = target
        if (changed) {
            notifyModeChanged(Session.useIntranet)
        }
        return changed
    }

    private fun reapply(context: Context) {
        applyNetworkMode(context)
    }

    /** 内网端口可达性探测：SSID 不可读/非 Home-WiFi 时判断是否在办公室局域网，成功则切内网 */
    private fun probeIntranetReachability() {
        val now = SystemClock.elapsedRealtime()
        if (probing || now - lastProbeAt < PROBE_INTERVAL_MS) return
        probing = true
        probeScope.launch {
            val reachable = runCatching {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(INTRANET_HOST, INTRANET_PORT), PROBE_TIMEOUT_MS)
                }
            }.isSuccess
            probing = false
            lastProbeAt = SystemClock.elapsedRealtime()
            if (reachable && Session.networkMode == Session.MODE_AUTO && !Session.useIntranet) {
                Session.useIntranet = true
                notifyModeChanged(true)
            }
        }
    }

    private fun notifyModeChanged(isIntranet: Boolean) {
        modeListeners.forEach { listener ->
            runCatching { listener(isIntranet) }
        }
    }
}