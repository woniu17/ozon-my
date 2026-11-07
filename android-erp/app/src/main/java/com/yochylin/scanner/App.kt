package com.yochylin.scanner

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import com.yochylin.scanner.api.Api

/**
 * 应用入口：进程启动即注册默认网络回调，保证任何界面/服务都能感知网络切换。
 * （2026-10-23 评审优化：不再依赖 LoginActivity/MainShellActivity 入口注册）
 *
 * 2026-11-07：实现 ImageLoaderFactory，让所有 Coil 图片加载复用 Api 的 OkHttpClient
 * （含自定义 DNS：内网时把 yochylin.com 解析到内网服务器），保证通知大图/列表图
 * 与接口请求走同一域名解析策略。
 */
class App : Application(), ImageLoaderFactory {

    override fun onCreate() {
        super.onCreate()
        Session.init(this)
        NetworkDetector.registerNetworkListener(this)
    }

    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .okHttpClient(Api.client)
            .build()
}