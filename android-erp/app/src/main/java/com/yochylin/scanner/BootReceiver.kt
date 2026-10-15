package com.yochylin.scanner

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * 开机自启接收器：手机重启后若已登录，自动恢复新订单监控前台服务。
 * Android 12+ 允许在 BOOT_COMPLETED 后启动前台服务（豁免后台启动限制）。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Session.init(context)
        if (!Session.isLoggedIn) return

        try {
            ContextCompat.startForegroundService(
                context,
                Intent(context, NewOrderNotifyService::class.java)
            )
        } catch (_: Exception) {
            // 系统限制启动时静默，用户打开 App 后 MainShellActivity 会再次拉起
        }
    }
}