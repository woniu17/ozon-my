package com.yochylin.scanner

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import coil.load

/** 将 View 背景设置为圆角色块（替代 setBackgroundColor，统一圆角） */
fun View.setRoundedBg(color: Int, radiusDp: Float = 6f) {
    background = GradientDrawable().apply {
        setColor(color)
        cornerRadius = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, radiusDp, resources.displayMetrics
        )
    }
}

/** 全屏预览商品大图：黑色背景、点击任意位置关闭 */
fun Context.showImagePreview(url: String?) {
    if (url.isNullOrBlank()) return
    val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
    val placeholder = ColorDrawable(Color.parseColor("#f2f3f5"))
    val img = ImageView(this).apply {
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        scaleType = ImageView.ScaleType.FIT_CENTER
        setBackgroundColor(Color.parseColor("#f2f3f5"))
        setOnClickListener { dialog.dismiss() }
        // 与列表完全相同的加载方式，避免自定义 ImageRequest 导致图片加载失败
        load(url) {
            placeholder(placeholder)
            error(placeholder)
            crossfade(true)
        }
    }
    dialog.setContentView(img)
    dialog.window?.setBackgroundDrawable(ColorDrawable(Color.BLACK))
    dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    dialog.setCanceledOnTouchOutside(true)
    dialog.show()
}