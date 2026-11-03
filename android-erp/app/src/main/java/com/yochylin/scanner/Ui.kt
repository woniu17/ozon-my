package com.yochylin.scanner

import android.app.Dialog
import android.app.ProgressDialog
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.TransitionDrawable
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import coil.load
import com.yochylin.scanner.adapter.fmtMoney
import com.yochylin.scanner.adapter.fmtNum
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.optString
import com.yochylin.scanner.model.Pkg
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** 模态"正在处理"对话框（2026-10-17 入库耗时提示）：不可取消、防重复提交，结束调用 dismiss() */
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

/** 圆角背景 + 细描边（Ozon 风格浅边框卡片，替代阴影） */
fun View.setRoundedBgStroke(fillColor: Int, strokeColor: Int, radiusDp: Float = 16f, strokeWidthDp: Float = 1f) {
    background = GradientDrawable().apply {
        setColor(fillColor)
        cornerRadius = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, radiusDp, resources.displayMetrics
        )
        setStroke(
            TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, strokeWidthDp, resources.displayMetrics).toInt(),
            strokeColor
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

/** 在 FlowLayout 中渲染「已有标签」可选 chip（对齐 Web tagOptions 选择面板，2026-10-28 美化）
 * 点击 chip 切换该标签是否出现在 tagsInput（逗号分隔）；手动输入的新标签不会被覆盖。
 * @param allTags 已有标签名列表，顺序 = 全局标签顺序（GET /admin/api/order-process/tags） */
fun Context.renderSelectableTagChips(container: FlowLayout, tagsInput: EditText, allTags: List<String>) {
    container.removeAllViews()
    val density = resources.displayMetrics.density
    val hp = (12 * density + 0.5f).toInt()
    val vp = (6 * density + 0.5f).toInt()
    val rightMargin = (8 * density + 0.5f).toInt()
    val topMargin = (6 * density + 0.5f).toInt()

    fun currentTags(): Set<String> =
        tagsInput.text.toString().split(",", "，").map { it.trim() }.filter { it.isNotEmpty() }.toSet()

    fun styleChip(chip: TextView, selected: Boolean) {
        chip.setTextColor(if (selected) Color.WHITE else 0xFF4E5969.toInt())
        chip.setRoundedBg(if (selected) 0xFF165DFF.toInt() else 0xFFF2F3F5.toInt(), 8f)
        chip.setTypeface(null, if (selected) Typeface.BOLD else Typeface.NORMAL)
    }

    val selected = currentTags()
    for (tag in allTags) {
        val chip = TextView(this).apply {
            text = tag
            textSize = 12f
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

/** 带最大高度的 ScrollView（内容超出才滚动，用于编辑对话框内表单区） */
class MaxHeightScrollView(context: Context, private val maxHeight: Int) : ScrollView(context) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val size = MeasureSpec.getSize(heightMeasureSpec)
        if (MeasureSpec.getMode(heightMeasureSpec) != MeasureSpec.EXACTLY && size > maxHeight) {
            super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(maxHeight, MeasureSpec.AT_MOST))
        } else {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        }
    }
}

/** 标签/备注编辑对话框(2026-10-28 美化版)：圆角卡片、分区标签、已有标签可选 chip(对齐 Web tagOptions)
 * @param packageId 包裹 ID(提交时使用)
 * @param postingNumber 货件号(仅展示)
 * @param currentTags 当前标签(逗号分隔的原始列表)
 * @param currentNote 当前备注
 * @param scope 用于拉取已有标签列表的生命周期作用域
 * @param onSave 点击保存回调(note, tags)，由调用方负责提交 */
fun Context.showPackageMetaEditDialog(
    packageId: String,
    postingNumber: String?,
    currentTags: List<String>?,
    currentNote: String?,
    scope: CoroutineScope,
    onSave: (note: String, tags: List<String>) -> Unit
) {
    val density = resources.displayMetrics.density
    fun dp(v: Int) = (v * density + 0.5f).toInt()

    val tagsInput = EditText(this).apply {
        hint = "多个标签用逗号分隔，如：预上网,买2发1"
        textSize = 14f
        setTextColor(0xFF1D2129.toInt())
        setHintTextColor(0xFFC9CDD4.toInt())
        setText(currentTags?.joinToString(","))
        setSingleLine(true)
        setPadding(dp(14), dp(10), dp(14), dp(10))
        background = GradientDrawable().apply {
            setColor(0xFFF7F8FA.toInt())
            cornerRadius = dp(10).toFloat()
            setStroke(dp(1), 0xFFE5E6EB.toInt())
        }
    }
    val noteInput = EditText(this).apply {
        hint = "填写备注(可空)"
        textSize = 14f
        setTextColor(0xFF1D2129.toInt())
        setHintTextColor(0xFFC9CDD4.toInt())
        gravity = Gravity.TOP or Gravity.START
        minLines = 3
        maxLines = 5
        setText(currentNote)
        setPadding(dp(14), dp(10), dp(14), dp(10))
        background = GradientDrawable().apply {
            setColor(0xFFF7F8FA.toInt())
            cornerRadius = dp(10).toFloat()
            setStroke(dp(1), 0xFFE5E6EB.toInt())
        }
    }

    fun label(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 12f
        setTextColor(0xFF86909C.toInt())
    }

    val chipsFlow = FlowLayout(this)
    val tagsLabel = label("已有标签(点击选择)")
    val content = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(label("标签"))
        addView(tagsInput, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) })
        addView(tagsLabel, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(16) })
        addView(chipsFlow, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) })
        addView(label("备注"), LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(16) })
        addView(noteInput, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(8) })
    }

    val contentScroll = MaxHeightScrollView(this, (resources.displayMetrics.heightPixels * 0.6).toInt()).apply {
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        addView(content)
    }

    val header = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(TextView(this@showPackageMetaEditDialog).apply {
            text = "编辑标签 / 备注"
            textSize = 17f
            setTextColor(0xFF1D2129.toInt())
            setTypeface(null, Typeface.BOLD)
        })
        addView(TextView(this@showPackageMetaEditDialog).apply {
            text = "货件 ${postingNumber ?: packageId}"
            textSize = 12f
            setTextColor(0xFF86909C.toInt())
            setMaxLines(1)
            ellipsize = TextUtils.TruncateAt.MIDDLE
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(4) })
    }

    lateinit var dialog: Dialog
    val cancelBtn = TextView(this).apply {
        text = "取消"
        textSize = 14f
        setTextColor(0xFF4E5969.toInt())
        setPadding(dp(22), dp(9), dp(22), dp(9))
        setRoundedBg(0xFFF2F3F5.toInt(), 9f)
        setOnClickListener { dialog.dismiss() }
    }
    val saveBtn = TextView(this).apply {
        text = "保存"
        textSize = 14f
        setTextColor(Color.WHITE)
        setTypeface(null, Typeface.BOLD)
        setPadding(dp(26), dp(9), dp(26), dp(9))
        setRoundedBg(0xFF165DFF.toInt(), 9f)
        setOnClickListener {
            val tags = tagsInput.text.toString()
                .split(",", "，")
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .distinct()
            val note = noteInput.text.toString().trim()
            dialog.dismiss()
            onSave(note, tags)
        }
    }
    val btnRow = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.END
        addView(cancelBtn)
        addView(saveBtn, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { leftMargin = dp(10) })
    }

    val root = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(20), dp(20), dp(20))
        addView(header)
        addView(contentScroll, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(16) })
        addView(btnRow, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(16) })
    }

    dialog = Dialog(this)
    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
    dialog.setContentView(root)
    dialog.setCanceledOnTouchOutside(true)
    dialog.window?.apply {
        setBackgroundDrawable(GradientDrawable().apply {
            setColor(Color.WHITE)
            cornerRadius = dp(16).toFloat()
        })
        setLayout((resources.displayMetrics.widthPixels * 0.90).toInt(), WindowManager.LayoutParams.WRAP_CONTENT)
        setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN
                    or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        )
    }
    dialog.show()

    // 异步拉取已有标签可选列表(对齐 Web tagOptions)，失败/为空时隐藏该区域
    scope.launch {
        try {
            val arr = Api.get("/admin/api/order-process/tags").asJsonArray
            val names = arr.mapNotNull { el ->
                if (el.isJsonObject) el.asJsonObject.optString("name").takeIf { it.isNotBlank() } else null
            }
            if (names.isEmpty()) {
                tagsLabel.visibility = View.GONE
            } else {
                renderSelectableTagChips(chipsFlow, tagsInput, names)
            }
        } catch (e: Exception) {
            tagsLabel.visibility = View.GONE
        }
    }
}

/**
 * 构建多件商品「入库确认」弹窗(2026-11):商品图片/明细 + OGL 拆单建议。
 * 供扫描入库与扫描打单的多件二次确认共用;返回未 show 的 Dialog,由调用方注册 dismiss 监听并 show。
 * @param pkg 包裹(需含 items 与 splitAnalysis,列表接口均已返回)
 * @param confirmText 确认按钮文案(默认"确认入库")
 * @param onConfirm 点击确认回调(内部先回调再关闭,保证 dismiss 监听里 confirmed 已置位)
 */
fun Context.buildMultiItemConfirmDialog(
    pkg: Pkg,
    confirmText: String = "确认入库",
    onConfirm: () -> Unit,
): Dialog {
    val density = resources.displayMetrics.density
    fun dp(v: Int) = (v * density + 0.5f).toInt()

    val inflater = LayoutInflater.from(this)
    val totalQty = (pkg.items?.sumOf { it.quantity ?: 0.0 } ?: 0.0).toLong()

    // ── 商品明细(复用列表 item_product 行:图片+标题+SKU/Offer+单价×数量) ──
    val prodContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    for (item in pkg.items.orEmpty()) {
        val row = inflater.inflate(R.layout.item_product, prodContainer, false) as LinearLayout
        val img: ImageView = row.findViewById(R.id.prodImg)
        val titleTv: TextView = row.findViewById(R.id.prodTitle)
        val skuTv: TextView = row.findViewById(R.id.prodSku)
        val offerTv: TextView = row.findViewById(R.id.prodOffer)
        val priceTv: TextView = row.findViewById(R.id.prodPrice)

        val picUrl = item.picUrl
        if (picUrl.isNullOrBlank()) {
            img.setImageDrawable(null)
        } else {
            img.load(if (picUrl.startsWith("/")) Api.BASE_URL + picUrl else picUrl)
        }
        titleTv.text = item.title ?: "—"
        skuTv.text = "SKU:${item.sku ?: "—"}"
        offerTv.text = "Offer ID:${item.offerId ?: "—"}"
        priceTv.text = buildString {
            append("单价 ").append(fmtMoney(item.price))
            append(" ×").append(fmtNum(item.quantity))
        }
        prodContainer.addView(row)
    }

    // ── OGL 拆单建议(applicable 才展示;文案口径对齐 H5 orders 列表) ──
    val splitSection = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
    }
    val sa = pkg.splitAnalysis
    if (sa != null && sa.applicable) {
        val eligible = sa.splitEligible
        val saving = sa.saving
        val splitText: String
        val note: String
        val mainColor: Int
        val bgColor: Int
        when {
            !eligible -> {
                splitText = "整件运费 ${fmtMoney(sa.whole?.deliveryCny)}"
                note = when (sa.reason) {
                    "multi_sku" -> "多SKU"
                    "too_many_units" -> "件数过多"
                    else -> "不可拆"
                }
                mainColor = 0xFF165DFF.toInt()
                bgColor = 0xFFEEF4FF.toInt()
            }
            saving -> {
                splitText = "拆${sa.packagesCount}包省 ${fmtMoney(sa.saveCny)}"
                note = if (sa.operable) "可拆包" else "已发货"
                mainColor = 0xFF00B42A.toInt()
                bgColor = 0xFFE8FFEA.toInt()
            }
            else -> {
                splitText = "整件更省 · 拆${sa.packagesCount}包贵 ${fmtMoney(Math.abs(sa.saveCny ?: 0.0))}"
                note = if (sa.operable) "可拆包" else "已发货"
                mainColor = 0xFFD97706.toInt()
                bgColor = 0xFFFFF7E6.toInt()
            }
        }
        val formula = sa.formula ?: sa.whole?.formula

        splitSection.visibility = View.VISIBLE
        splitSection.setRoundedBg(bgColor, 10f)
        splitSection.setPadding(dp(12), dp(10), dp(12), dp(10))
        splitSection.addView(TextView(this).apply {
            text = splitText
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            setTextColor(mainColor)
        })
        splitSection.addView(TextView(this).apply {
            text = note
            textSize = 11f
            setTextColor(0xFF86909C.toInt())
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(4) })
        if (!formula.isNullOrBlank()) {
            splitSection.addView(TextView(this).apply {
                text = formula
                textSize = 11f
                setTextColor(0xFF86909C.toInt())
            }, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(6) })
        }
    }

    // ── 内容区(滚动):商品明细 + 拆单建议 + 确认提示 ──
    val body = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(prodContainer)
        addView(splitSection, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(12) })
        addView(TextView(this@buildMultiItemConfirmDialog).apply {
            text = "将向 Ozon 确认全部商品为一个货件(不拆分)。"
            textSize = 12f
            setTextColor(0xFF86909C.toInt())
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(12) })
    }
    val contentScroll = MaxHeightScrollView(this, (resources.displayMetrics.heightPixels * 0.45).toInt()).apply {
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        addView(body)
    }

    // ── 头部:货件号 + 店铺/总件数 ──
    val header = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(TextView(this@buildMultiItemConfirmDialog).apply {
            text = "货件 ${pkg.postingNumber ?: pkg.id}"
            textSize = 17f
            setTextColor(0xFF1D2129.toInt())
            setTypeface(null, Typeface.BOLD)
            setMaxLines(1)
            ellipsize = TextUtils.TruncateAt.MIDDLE
        })
        addView(LinearLayout(this@buildMultiItemConfirmDialog).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(this@buildMultiItemConfirmDialog).apply {
                text = pkg.storeName ?: ""
                textSize = 12f
                setTextColor(0xFF4E5969.toInt())
                visibility = if (pkg.storeName.isNullOrBlank()) View.GONE else View.VISIBLE
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(TextView(this@buildMultiItemConfirmDialog).apply {
                text = "共 $totalQty 件"
                textSize = 12f
                setTextColor(0xFF1D2129.toInt())
                setTypeface(null, Typeface.BOLD)
            })
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(6) })
    }

    // ── 按钮行 ──
    val cancelBtn = TextView(this).apply {
        text = "取消"
        textSize = 14f
        setTextColor(0xFF4E5969.toInt())
        setPadding(dp(22), dp(9), dp(22), dp(9))
        setRoundedBg(0xFFF2F3F5.toInt(), 9f)
    }
    val confirmBtn = TextView(this).apply {
        text = confirmText
        textSize = 14f
        setTextColor(Color.WHITE)
        setTypeface(null, Typeface.BOLD)
        setPadding(dp(26), dp(9), dp(26), dp(9))
        setRoundedBg(0xFF165DFF.toInt(), 9f)
    }
    val btnRow = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.END
        addView(cancelBtn)
        addView(confirmBtn, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { leftMargin = dp(10) })
    }

    val root = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(16), dp(20), dp(16))
        addView(header)
        addView(contentScroll, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(10) })
        addView(btnRow, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = dp(14) })
    }

    val dialog = Dialog(this)
    dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
    dialog.setContentView(root)
    dialog.setCanceledOnTouchOutside(true)
    dialog.window?.apply {
        setBackgroundDrawable(GradientDrawable().apply {
            setColor(Color.WHITE)
            cornerRadius = dp(16).toFloat()
        })
        setLayout((resources.displayMetrics.widthPixels * 0.92).toInt(), WindowManager.LayoutParams.WRAP_CONTENT)
    }
    cancelBtn.setOnClickListener { dialog.dismiss() }
    confirmBtn.setOnClickListener {
        onConfirm()
        dialog.dismiss()
    }
    return dialog
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