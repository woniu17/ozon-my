package com.yochylin.scanner

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager

/**
 * 网络模式控制（2026-10-23 升级为三模式）：
 * - auto（默认）：连接 WiFi 且 SSID 为 Home-WiFi 时判定在内网，否则公网
 * - intranet（手动）：强制使用内网
 * - public（手动）：强制使用公网
 */
object NetworkDetector {

    const val INTRANET_BASE = "http://192.168.1.212:3001"

    /** 自动模式下判定内网的 WiFi 名称 */
    const val HOME_WIFI_SSID = "Home-WiFi"

    /**
     * 是否连接了 Home-WiFi。
     * 需要 ACCESS_NETWORK_STATE/ACCESS_WIFI_STATE；Android 8+ 读取 SSID
     * 还需要 ACCESS_FINE_LOCATION（运行时申请），未授权时返回 false 走公网。
     */
    fun isOnHomeWifi(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return false
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return false
        // WifiInfo.getSSID 在 Android 8.1+ 返回带引号的 SSID（如 "Home-WiFi"）
        val ssid = wifi.connectionInfo?.ssid?.trim()?.trim('"') ?: return false
        return ssid == HOME_WIFI_SSID
    }

    /**
     * 按当前网络模式应用后端地址：
     * auto → 根据 Home-WiFi 判断；intranet/public → 强制内网/公网。
     * @return true 表示 useIntranet 发生了变化（后端地址已切换）
     */
    fun applyNetworkMode(context: Context): Boolean {
        val target = when (Session.networkMode) {
            Session.MODE_INTRANET -> true
            Session.MODE_PUBLIC -> false
            else -> isOnHomeWifi(context)
        }
        val changed = Session.useIntranet != target
        Session.useIntranet = target
        return changed
    }
}