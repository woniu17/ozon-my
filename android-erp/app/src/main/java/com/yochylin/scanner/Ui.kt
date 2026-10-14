package com.yochylin.scanner

import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.View

/** 将 View 背景设置为圆角色块（替代 setBackgroundColor，统一圆角） */
fun View.setRoundedBg(color: Int, radiusDp: Float = 6f) {
    background = GradientDrawable().apply {
        setColor(color)
        cornerRadius = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, radiusDp, resources.displayMetrics
        )
    }
}