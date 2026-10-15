package com.yochylin.scanner

import android.content.Context
import android.content.SharedPreferences

/** 登录态持久化（token / 手机号），与后端滑动续期配合 */
object Session {
    private const val PREFS = "erp_scan_prefs"
    private const val KEY_TOKEN = "token"
    private const val KEY_PHONE = "phone"
    private const val KEY_INTRANET = "use_intranet"
    private const val KEY_LAST_WAIT = "last_wait_process_count"
    private const val KEY_LAST_WAIT_SNS = "last_wait_process_sns"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        if (!::prefs.isInitialized) {
            prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
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

    /** 内网模式：为 true 时后端走内网地址，false 走公网 */
    var useIntranet: Boolean
        get() = prefs.getBoolean(KEY_INTRANET, false)
        set(value) {
            prefs.edit().putBoolean(KEY_INTRANET, value).apply()
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
        prefs.edit().remove(KEY_TOKEN).remove(KEY_PHONE).apply()
    }
}