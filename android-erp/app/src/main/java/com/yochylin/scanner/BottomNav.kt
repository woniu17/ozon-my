package com.yochylin.scanner

import android.app.Activity
import android.graphics.Color
import android.view.View
import android.widget.ImageView
import android.widget.TextView

private const val NAV_ACTIVE_COLOR = "#165dff"
private const val NAV_INACTIVE_COLOR = "#86909c"

/** 宿主 Activity 实现该接口，用于底部导航切换 Fragment */
interface TabHost {
    fun switchTab(tab: String)
}

/**
 * 设置底部导航栏：高亮当前模块，点击其他模块由宿主切换 Fragment（底部栏常驻）
 */
fun setupBottomNav(activity: Activity, active: String) {
    val items = listOf(
        BottomNavItem(R.id.navHome, R.id.navHomeIcon, R.id.navHomeText, "home"),
        BottomNavItem(R.id.navOrder, R.id.navOrderIcon, R.id.navOrderText, "order"),
        BottomNavItem(R.id.navFinance, R.id.navFinanceIcon, R.id.navFinanceText, "finance"),
        BottomNavItem(R.id.navStats, R.id.navStatsIcon, R.id.navStatsText, "stats"),
        BottomNavItem(R.id.navStock, R.id.navStockIcon, R.id.navStockText, "stock"),
        BottomNavItem(R.id.navContainer, R.id.navContainerIcon, R.id.navContainerText, "container")
    )
    for (item in items) {
        val tab = activity.findViewById<View>(item.tabId)
        val icon = activity.findViewById<ImageView>(item.iconId)
        val text = activity.findViewById<TextView>(item.textId)
        val isActive = active == item.key
        val color = Color.parseColor(if (isActive) NAV_ACTIVE_COLOR else NAV_INACTIVE_COLOR)
        icon.setColorFilter(color)
        text.setTextColor(color)
        if (!isActive) {
            tab.setOnClickListener {
                (activity as? TabHost)?.switchTab(item.key)
            }
        }
    }
}

private data class BottomNavItem(
    val tabId: Int,
    val iconId: Int,
    val textId: Int,
    val key: String
)