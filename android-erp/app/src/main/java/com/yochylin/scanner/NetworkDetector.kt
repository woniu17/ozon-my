package com.yochylin.scanner

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * 内网自动探测：
 * 启动时访问内网后端根路径，若可达则自动切换为内网模式；否则使用公网。
 * 用户手动切换后（manualOverride=true），本次运行不再被自动探测覆盖。
 */
object NetworkDetector {

    const val INTRANET_BASE = "http://192.168.1.212:3001"

    private const val TIMEOUT_MS = 2500L

    @Volatile
    var manualOverride = false

    /** 探测内网后端是否可达（任何 HTTP 响应码都视为服务器可达） */
    suspend fun isIntranetReachable(): Boolean = withContext(Dispatchers.IO) {
        try {
            val client = OkHttpClient.Builder()
                .connectTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .readTimeout(TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build()
            val request = Request.Builder()
                .url("$INTRANET_BASE/")
                .head()
                .build()
            client.newCall(request).execute().use { resp ->
                resp.code in 200..599
            }
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 自动探测并应用：
     * @return true 表示自动切换了模式（仅当未手动覆盖且状态发生变化时）
     */
    suspend fun autoDetectAndApply(): Boolean {
        val reachable = isIntranetReachable()
        if (manualOverride) return false
        val changed = Session.useIntranet != reachable
        Session.useIntranet = reachable
        return changed
    }
}