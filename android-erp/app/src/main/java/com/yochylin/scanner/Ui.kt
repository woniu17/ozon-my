package com.yochylin.scanner

import android.app.Dialog
import android.app.ProgressDialog
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.TransitionDrawable
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import coil.load
import java.io.File
import java.io.FileOutputStream

/** 模态"正在处理"对话框（2026-10-17 备货耗时提示）：不可取消、防重复提交，结束调用 dismiss() */
fun Context.showBlockingLoading(message: String): ProgressDialog = ProgressDialog(this).apply {
    setMessage(message)
    setCancelable(false)
    setCanceledOnTouchOutside(false)
    show()
}

/** 将 View 背景设置为圆角色块（替代 setBackgroundColor，统一圆角） */
fun View.setRoundedBg(color: Int, radiusDp: Float = 6f) {
    background = GradientDrawable().apply {
        setColor(color)
        cornerRadius = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, radiusDp, resources.displayMetrics
        )
    }
}

/** 简易流式布局：子 View 按行自动换行（标签可选列表 chip 用） */
class FlowLayout(context: Context) : ViewGroup(context) {

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val widthSize = MeasureSpec.getSize(widthMeasureSpec)
        val available = widthSize - paddingLeft - paddingRight
        var x = 0
        var y = 0
        var rowHeight = 0
        var maxX = 0
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            child.measure(
                MeasureSpec.makeMeasureSpec(available, MeasureSpec.AT_MOST),
                MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
            )
            val cw = child.measuredWidth
            val ch = child.measuredHeight
            if (x + cw > available && x > 0) {
                x = 0
                y += rowHeight
                rowHeight = 0
            }
            x += cw
            rowHeight = maxOf(rowHeight, ch)
            maxX = maxOf(maxX, x)
        }
        val totalHeight = y + rowHeight + paddingTop + paddingBottom
        val totalWidth = maxOf(maxX + paddingLeft + paddingRight, suggestedMinimumWidth)
        setMeasuredDimension(
            resolveSize(totalWidth, widthMeasureSpec),
            resolveSize(totalHeight, heightMeasureSpec)
        )
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val available = (r - l) - paddingLeft - paddingRight
        var x = paddingLeft
        var y = paddingTop
        var rowHeight = 0
        for (i in 0 until childCount) {
            val child = getChildAt(i)
            val cw = child.measuredWidth
            val ch = child.measuredHeight
            if (x + cw > available + paddingLeft && x > paddingLeft) {
                x = paddingLeft
                y += rowHeight
                rowHeight = 0
            }
            child.layout(x, y, x + cw, y + ch)
            x += cw
            rowHeight = maxOf(rowHeight, ch)
        }
    }
}

/** 在 FlowLayout 中渲染「已有标签」可选 chip（对齐 Web tagOptions 选择面板，2026-10-27）
 * 点击 chip 切换该标签是否出现在 tagsInput（逗号分隔）；手动输入的新标签不会被覆盖。
 * @param allTags 已有标签名列表，顺序 = 全局标签顺序（GET /admin/api/order-process/tags） */
fun Context.renderSelectableTagChips(container: FlowLayout, tagsInput: EditText, allTags: List<String>) {
    container.removeAllViews()
    val density = resources.displayMetrics.density
    val hp = (10 * density + 0.5f).toInt()
    val vp = (5 * density + 0.5f).toInt()
    val rightMargin = (6 * density + 0.5f).toInt()
    val topMargin = (4 * density + 0.5f).toInt()

    fun currentTags(): Set<String> =
        tagsInput.text.toString().split(",", "，").map { it.trim() }.filter { it.isNotEmpty() }.toSet()

    fun styleChip(chip: TextView, selected: Boolean) {
        chip.setTextColor(if (selected) Color.parseColor("#165dff") else Color.parseColor("#4e5969"))
        chip.setRoundedBg(if (selected) 0xFFE8F0FF.toInt() else 0xFFF2F3F5.toInt(), 8f)
        chip.setTypeface(null, if (selected) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
    }

    val selected = currentTags()
    for (tag in allTags) {
        val chip = TextView(this).apply {
            text = tag
            textSize = 11f
            setPadding(hp, vp, hp, vp)
            setOnClickListener {
                val cur = currentTags().toMutableSet()
                if (!cur.remove(tag)) cur.add(tag)
                tagsInput.setText(cur.joinToString(","))
                tagsInput.setSelection(tagsInput.text.length)
                styleChip(this, tag in cur)
            }
            styleChip(this, tag in selected)
        }
        container.addView(chip, ViewGroup.MarginLayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply {
            this.rightMargin = rightMargin
            this.topMargin = topMargin
        })
    }
}

/** 全屏预览商品大图：黑色背景、点击任意位置关闭、长按保存到相册 */
fun Context.showImagePreview(url: String?) {
    if (url.isNullOrBlank()) return
    val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
    val placeholder = ColorDrawable(Color.parseColor("#f2f3f5"))
    // 加载完成时缓存 Bitmap，长按保存直接用，避免从 CrossfadeDrawable 中提取失败
    var loadedBitmap: Bitmap? = null
    val img = ImageView(this).apply {
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        scaleType = ImageView.ScaleType.FIT_CENTER
        setBackgroundColor(Color.parseColor("#f2f3f5"))
        setOnClickListener { dialog.dismiss() }
        // 长按保存图片到相册
        setOnLongClickListener {
            val bmp = loadedBitmap ?: extractBitmap(drawable)
            if (bmp == null) {
                Toast.makeText(this@showImagePreview, "图片尚未加载完成，请稍候再试", Toast.LENGTH_SHORT).show()
            } else {
                savePreviewImage(this@showImagePreview, bmp)
            }
            true
        }
        // 与列表完全相同的加载方式，避免自定义 ImageRequest 导致图片加载失败
        load(url) {
            placeholder(placeholder)
            error(placeholder)
            crossfade(true)
            listener(
                onSuccess = { _, result ->
                    loadedBitmap = extractBitmap(result.drawable)
                }
            )
        }
    }
    dialog.setContentView(img)
    dialog.window?.setBackgroundDrawable(ColorDrawable(Color.BLACK))
    dialog.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    dialog.setCanceledOnTouchOutside(true)
    dialog.show()
}

/** 保存图片到系统相册（Android 10+ 走 MediaStore，无需权限；旧版本写公共目录） */
private fun savePreviewImage(context: Context, bitmap: Bitmap) {
    val saved = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, "scanner_" + System.currentTimeMillis() + ".jpg")
                put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/ScanShip")
            }
            val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            if (uri != null) {
                context.contentResolver.openOutputStream(uri)?.use { out ->
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 95, out)
                }
                true
            } else false
        } else {
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "ScanShip")
            if (!dir.exists()) dir.mkdirs()
            val file = File(dir, "scanner_" + System.currentTimeMillis() + ".jpg")
            FileOutputStream(file).use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 95, out) }
            context.sendBroadcast(Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(file)))
            true
        }
    } catch (e: Exception) {
        false
    }
    Toast.makeText(context, if (saved) "已保存到相册(ScanShip)" else "保存失败，请检查存储权限", Toast.LENGTH_SHORT).show()
}

/** 从 Drawable 中递归提取 Bitmap（兼容 Coil 的 CrossfadeDrawable 包装） */
private fun extractBitmap(drawable: Drawable?): Bitmap? {
    return when (drawable) {
        is BitmapDrawable -> drawable.bitmap
        is TransitionDrawable -> extractBitmap(drawable.getDrawable(1))
        is android.graphics.drawable.LayerDrawable -> {
            for (i in 0 until drawable.numberOfLayers) {
                extractBitmap(drawable.getDrawable(i))?.let { return it }
            }
            null
        }
        else -> null
    }
}