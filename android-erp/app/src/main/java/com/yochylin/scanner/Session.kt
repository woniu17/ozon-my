package com.yochylin.scanner

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences

/** 登录态持久化（token / 手机号），与后端滑动续期配合 */
object Session {
    private const val PREFS = "erp_scan_prefs"
    private const val KEY_TOKEN = "token"
    private const val KEY_PHONE = "phone"
    private const val KEY_INTRANET = "use_intranet"
    private const val KEY_NETWORK_MODE = "network_mode"

    /** 网络模式：自动检测（默认，Home-WiFi 则内网） */
    const val MODE_AUTO = "auto"
    /** 网络模式：手动强制内网 */
    const val MODE_INTRANET = "intranet"
    /** 网络模式：手动强制公网 */
    const val MODE_PUBLIC = "public"
    private const val KEY_LABEL_PRINTER = "label_printer"
    private const val KEY_LAST_WAIT = "last_wait_process_count"
    private const val KEY_LAST_WAIT_SNS = "last_wait_process_sns"
    private const val KEY_LAST_WAIT_INIT = "last_wait_process_init"
    private const val KEY_NOTIFIED_SNS = "notified_push_sns"

    private lateinit var prefs: SharedPreferences
    private lateinit var appContext: Context

    fun init(context: Context) {
        if (!::prefs.isInitialized) {
            appContext = context.applicationContext
            prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        }
    }

    /** 新订单通知：上次记录的"待处理"订单数（服务重启后仍可正确对比增量） */
    var lastWaitProcessCount: Long
        get() = prefs.getLong(KEY_LAST_WAIT, -1L)
        set(value) {
            prefs.edit().putLong(KEY_LAST_WAIT, value).apply()
        }

    /** 新订单通知：上次记录的待处理列表最新货件号集合（用于差集计算真正"新增"的订单） */
    var lastWaitProcessSns: List<String>
        get() = prefs.getString(KEY_LAST_WAIT_SNS, "")?.split('\u0001')?.filter { it.isNotBlank() } ?: emptyList()
        set(value) {
            prefs.edit().putString(KEY_LAST_WAIT_SNS, value.joinToString("\u0001")).apply()
        }

    /** 差集基线是否已初始化。false（首次启动/登出后）时只记录基线不通知，避免存量订单误报 */
    var lastWaitProcessInit: Boolean
        get() = prefs.getBoolean(KEY_LAST_WAIT_INIT, false)
        set(value) {
            prefs.edit().putBoolean(KEY_LAST_WAIT_INIT, value).apply()
        }

    /** 最近已推送过新订单通知的货件号集合（服务端事件与差集兜底共用去重，持久化防重启重复通知） */
    var notifiedPushSns: List<String>
        get() = prefs.getString(KEY_NOTIFIED_SNS, "")?.split('\u0001')?.filter { it.isNotBlank() } ?: emptyList()
        set(value) {
            prefs.edit().putString(KEY_NOTIFIED_SNS, value.joinToString("\u0001")).apply()
        }

    /**
     * 网络模式（三模式，2026-10-23）：auto(默认)/intranet/public。
     * 主界面按钮点击弹窗选择；登录页"内网模式"勾选=强制内网，取消=恢复 auto。
     */
    var networkMode: String
        get() = prefs.getString(KEY_NETWORK_MODE, MODE_AUTO) ?: MODE_AUTO
        set(value) {
            prefs.edit().putString(KEY_NETWORK_MODE, value).apply()
        }

    /** 当前生效的内网模式：为 true 时后端走内网地址，false 走公网（由 networkMode 应用得到） */
    var useIntranet: Boolean
        get() = prefs.getBoolean(KEY_INTRANET, false)
        set(value) {
            prefs.edit().putBoolean(KEY_INTRANET, value).apply()
        }

    /** 标签打印机选择:打印机名,''=服务器打印组件默认(print-package 的 printer 参数) */
    var labelPrinter: String
        get() = prefs.getString(KEY_LABEL_PRINTER, "") ?: ""
        set(value) {
            prefs.edit().putString(KEY_LABEL_PRINTER, value).apply()
        }

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) {
            prefs.edit().putString(KEY_TOKEN, value).apply()
        }

    var phone: String?
        get() = prefs.getString(KEY_PHONE, null)
        set(value) {
            prefs.edit().putString(KEY_PHONE, value).apply()
        }

    val isLoggedIn: Boolean
        get() = !token.isNullOrBlank()

    fun saveLogin(token: String, phone: String) {
        prefs.edit().putString(KEY_TOKEN, token).putString(KEY_PHONE, phone).apply()
    }

    fun clear() {
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_PHONE)
            // 清除新订单监控基线：换账号/重新登录后首次差集只记录不通知
            .remove(KEY_LAST_WAIT)
            .remove(KEY_LAST_WAIT_SNS)
            .remove(KEY_LAST_WAIT_INIT)
            // 同时清除已通知货件号，避免换账号后旧记录导致新订单被跳过（评审 P1）
            .remove(KEY_NOTIFIED_SNS)
            .apply()
        // 统一停止新订单监控服务：所有登出入口共用，避免残留服务用失效 token 轮询（评审 P1）
        if (::appContext.isInitialized) {
            try {
                appContext.stopService(Intent(appContext, NewOrderNotifyService::class.java))
            } catch (_: Exception) {
            }
        }
    }
}