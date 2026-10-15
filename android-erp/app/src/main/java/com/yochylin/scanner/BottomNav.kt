package com.yochylin.scanner

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.view.View
import android.widget.ImageView
import android.widget.TextView

private const val NAV_ACTIVE_COLOR = "#165dff"
private const val NAV_INACTIVE_COLOR = "#86909c"

/**
 * 设置底部导航栏：高亮当前模块，点击其他模块跳转（CLEAR_TOP 清理中间栈）
 */
fun setupBottomNav(activity: Activity, active: String) {
    val items = listOf(
        BottomNavItem(R.id.navHome, R.id.navHomeIcon, R.id.navHomeText, "home", MainActivity::class.java),
        BottomNavItem(R.id.navOrder, R.id.navOrderIcon, R.id.navOrderText, "order", OrderListActivity::class.java),
        BottomNavItem(R.id.navFinance, R.id.navFinanceIcon, R.id.navFinanceText, "finance", FinanceActivity::class.java),
        BottomNavItem(R.id.navStats, R.id.navStatsIcon, R.id.navStatsText, "stats", OrderStatsActivity::class.java)
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
                val intent = Intent(activity, item.cls)
                intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                activity.startActivity(intent)
                // 底部导航切换不做页面转场动画，底部栏视觉常驻，仅高亮颜色变化
                activity.overridePendingTransition(0, 0)
            }
        }
    }
}

private data class BottomNavItem(
    val tabId: Int,
    val iconId: Int,
    val textId: Int,
    val key: String,
    val cls: Class<*>
)