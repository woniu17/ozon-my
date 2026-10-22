package com.yochylin.scanner

import android.app.Application

/**
 * 应用入口：进程启动即注册默认网络回调，保证任何界面/服务都能感知网络切换。
 * （2026-10-23 评审优化：不再依赖 LoginActivity/MainShellActivity 入口注册）
 */
class App : Application() {

    override fun onCreate() {
        super.onCreate()
        Session.init(this)
        NetworkDetector.registerNetworkListener(this)
    }
}