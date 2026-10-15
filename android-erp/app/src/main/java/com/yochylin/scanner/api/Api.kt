package com.yochylin.scanner.api

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.yochylin.scanner.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** 业务错误（envelope ok:false 或非 2xx），message 可直接展示给用户 */
class ApiException(val code: Int, message: String) : IOException(message)

// ── Gson JsonObject 兼容 org.json 风格的 opt 读取（缺失/JsonNull/类型不符时返回默认值）──

fun JsonObject.optString(key: String, default: String = ""): String {
    val el = get(key) ?: return default
    if (el.isJsonNull) return default
    return try {
        el.asString
    } catch (e: Exception) {
        default
    }
}

fun JsonObject.optBoolean(key: String, default: Boolean = false): Boolean {
    val el = get(key) ?: return default
    if (el.isJsonNull) return default
    return try {
        el.asBoolean
    } catch (e: Exception) {
        default
    }
}

fun JsonObject.optInt(key: String, default: Int = 0): Int {
    val el = get(key) ?: return default
    if (el.isJsonNull) return default
    return try {
        el.asInt
    } catch (e: Exception) {
        default
    }
}

fun JsonObject.optDouble(key: String, default: Double = 0.0): Double {
    val el = get(key) ?: return default
    if (el.isJsonNull) return default
    return try {
        el.asDouble
    } catch (e: Exception) {
        default
    }
}

object Api {
    /** 内网模式走内网后端，否则走公网 HTTPS */
    val BASE_URL: String
        get() = if (Session.useIntranet) "http://192.168.1.212:3001" else "https://yochylin.com:17443"

    @PublishedApi
    internal val gson = Gson()

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .addInterceptor { chain ->
                val original = chain.request()
                val builder = original.newBuilder()
                val token = Session.token
                if (!token.isNullOrBlank()) {
                    builder.header("Authorization", "Bearer $token")
                }
                val response = chain.proceed(builder.build())
                // 滑动续期：后端剩余有效期不足时通过响应头下发新 token
                val refreshed = response.header("X-Refreshed-Token")
                    ?: response.header("x-refreshed-token")
                if (!refreshed.isNullOrBlank()) {
                    Session.token = refreshed
                }
                response
            }
            .build()
    }

    /** 长轮询专用 client：读超时需大于服务端挂起时长（25s），否则 OkHttp 先超时 */
    private val pushPollClient: OkHttpClient by lazy {
        client.newBuilder()
            .readTimeout(40, TimeUnit.SECONDS)
            .build()
    }

    /** GET 请求，params 拼为 query string（跳过空值） */
    suspend fun get(path: String, params: Map<String, Any?>? = null): JsonElement {
        val url = buildUrl(path, params)
        return callRaw(url, "GET", null)
    }

    /** POST 请求，body 序列化为 JSON */
    suspend fun post(path: String, body: Any? = null): JsonElement {
        return callRaw(BASE_URL + path, "POST", body)
    }

    /**
     * 长轮询服务端推送事件：请求挂起最多 timeoutMs 毫秒，有事件立即返回，超时返回空列表。
     * 服务端路径 /admin/api/push/events（JWT 保护，拦截器自动携带 token）。
     */
    suspend fun longPollPushEvents(timeoutMs: Int = 25_000): List<JsonObject> =
        withContext(Dispatchers.IO) {
            val url = buildUrl("/admin/api/push/events", mapOf("timeout" to timeoutMs))
            val request = Request.Builder().url(url).build()
            pushPollClient.newCall(request).execute().use { response ->
                val text = response.body?.string() ?: ""

                if (response.code == 401) {
                    Session.clear()
                    throw ApiException(401, "登录已过期,请重新登录")
                }
                if (!response.isSuccessful) {
                    throw ApiException(response.code, parseError(text, response.code))
                }

                val root = try {
                    JsonParser.parseString(text).asJsonObject
                } catch (e: Exception) {
                    JsonObject()
                }
                val events: JsonArray = root.getAsJsonArray("events") ?: JsonArray()
                events.mapNotNull { if (it.isJsonObject) it.asJsonObject else null }
            }
        }

    private suspend fun callRaw(url: String, method: String, body: Any?): JsonElement =
        withContext(Dispatchers.IO) {
            val requestBody = body?.let { gson.toJson(it).toRequestBody(jsonMedia) }
            val request = Request.Builder()
                .url(url)
                .method(method.uppercase(), requestBody)
                .build()

            client.newCall(request).execute().use { response ->
                val text = response.body?.string() ?: ""

                if (response.code == 401) {
                    Session.clear()
                    throw ApiException(401, "登录已过期,请重新登录")
                }
                if (!response.isSuccessful) {
                    throw ApiException(response.code, parseError(text, response.code))
                }

                val root = try {
                    JsonParser.parseString(text)
                } catch (e: Exception) {
                    null
                }
                if (root != null && root.isJsonObject) {
                    val obj = root.asJsonObject
                    if (obj.has("ok")) {
                        if (obj.get("ok").asBoolean) {
                            return@withContext obj.get("data")
                        } else {
                            throw ApiException(response.code, obj.optString("message", "请求失败"))
                        }
                    }
                }
                root ?: JsonObject()
            }
        }

    private fun buildUrl(path: String, params: Map<String, Any?>?): String {
        if (params.isNullOrEmpty()) return BASE_URL + path
        val sb = StringBuilder(BASE_URL + path).append('?')
        var first = true
        for ((k, v) in params) {
            if (v == null || v.toString().isEmpty()) continue
            if (!first) sb.append('&')
            first = false
            sb.append(URLEncoder.encode(k, "UTF-8"))
                .append('=')
                .append(URLEncoder.encode(v.toString(), "UTF-8"))
        }
        return sb.toString()
    }

    private fun parseError(text: String, code: Int): String {
        return try {
            val obj = JsonParser.parseString(text).asJsonObject
            obj.optString("message", obj.optString("error", "请求失败 ($code)"))
        } catch (e: Exception) {
            "请求失败 ($code)"
        }
    }

    inline fun <reified T> parse(element: JsonElement): T = gson.fromJson(element, T::class.java)
}