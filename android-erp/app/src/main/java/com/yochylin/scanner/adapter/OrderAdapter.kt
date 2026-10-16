package com.yochylin.scanner.adapter

import android.content.Context
import android.graphics.Color
import android.text.InputType
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import coil.load
import com.yochylin.scanner.showImagePreview
import com.yochylin.scanner.R
import com.yochylin.scanner.model.Pkg
import com.yochylin.scanner.setRoundedBg

private const val O_COLOR_PRIMARY = "#165dff"
private const val O_COLOR_WARN = "#d97706"
private const val O_COLOR_OK = "#00b42a"
private const val O_COLOR_ERR = "#f53f3f"
private const val O_COLOR_MUTE = "#86909c"
private const val O_COLOR_TEXT = "#1f2329"

/** 订单处理列表适配器 */
class OrderAdapter(private val callbacks: Callbacks) : RecyclerView.Adapter<OrderAdapter.VH>() {

    interface Callbacks {
        fun onCopy(text: String, label: String)
        fun onOpenDetail(pkg: Pkg)
        fun onSearchSku(sku: String)
        fun onSubmitShip(pkg: Pkg, weightG: Int)
        fun onOpenLabel(pkg: Pkg)
        fun onCorrectWeight(pkg: Pkg, weightG: Int)
    }

    private val list = mutableListOf<Pkg>()

    fun setList(items: List<Pkg>) {
        list.clear()
        list.addAll(items)
        notifyDataSetChanged()
    }

    fun append(items: List<Pkg>) {
        val start = list.size
        list.addAll(items)
        notifyItemRangeInserted(start, items.size)
    }

    override fun getItemCount(): Int = list.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_order, parent, false)
        return VH(view)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        holder.bind(list[position])
    }

    inner class VH(view: View) : RecyclerView.ViewHolder(view) {
        private val context: Context = view.context
        private val inflater = LayoutInflater.from(context)

        private val oStore: TextView = view.findViewById(R.id.oStore)
        private val oPosting: TextView = view.findViewById(R.id.oPosting)
        private val copyOrderPosting: TextView = view.findViewById(R.id.copyOrderPosting)
        private val oSplitBadge: TextView = view.findViewById(R.id.oSplitBadge)
        private val oOpTag: TextView = view.findViewById(R.id.oOpTag)
        private val oTags: TextView = view.findViewById(R.id.oTags)
        private val oProdContainer: LinearLayout = view.findViewById(R.id.oProdContainer)
        private val oPurchaseTag: TextView = view.findViewById(R.id.oPurchaseTag)
        private val oArrivedTag: TextView = view.findViewById(R.id.oArrivedTag)
        private val oFootAmts: TextView = view.findViewById(R.id.oFootAmts)
        private val oActionArea: LinearLayout = view.findViewById(R.id.oActionArea)
        private val oTimeContainer: LinearLayout = view.findViewById(R.id.oTimeContainer)

        fun bind(pkg: Pkg) {
            itemView.setOnClickListener { callbacks.onOpenDetail(pkg) }

            oStore.text = pkg.storeName
            oStore.visibility = if (pkg.storeName.isNullOrBlank()) View.GONE else View.VISIBLE

            oPosting.text = pkg.postingNumber
            oPosting.setTextColor(if (isQcPosting(pkg.postingNumber)) Color.parseColor("#d93026") else Color.parseColor(O_COLOR_TEXT))
            oPosting.visibility = if (pkg.postingNumber.isNullOrBlank()) View.GONE else View.VISIBLE

            // 货件号复制(对齐 H5 订单处理列表)
            copyOrderPosting.visibility = if (pkg.postingNumber.isNullOrBlank()) View.GONE else View.VISIBLE
            if (copyOrderPosting.visibility == View.VISIBLE) {
                copyOrderPosting.textSize = 11f
                copyOrderPosting.setTextColor(Color.parseColor("#165dff"))
                copyOrderPosting.setRoundedBg(Color.parseColor("#eef4ff"), 6f)
                copyOrderPosting.setPadding(12.dp2px(context), 6.dp2px(context), 12.dp2px(context), 6.dp2px(context))
                copyOrderPosting.layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { leftMargin = 8.dp2px(context) }
            }
            copyOrderPosting.setOnClickListener {
                pkg.postingNumber?.let { callbacks.onCopy(it, "货件号") }
            }

            // 子件/母件徽标
            when {
                !pkg.parentId.isNullOrBlank() -> {
                    oSplitBadge.text = "子件(母件 ${pkg.parentId})"
                    oSplitBadge.setTextColor(Color.parseColor("#b45309"))
                    oSplitBadge.setRoundedBg(Color.parseColor("#fff7e6"))
                    oSplitBadge.visibility = View.VISIBLE
                }
                pkg.hasChildren -> {
                    oSplitBadge.text = "母件"
                    oSplitBadge.setTextColor(Color.parseColor("#4338ca"))
                    oSplitBadge.setRoundedBg(Color.parseColor("#eef2ff"))
                    oSplitBadge.visibility = View.VISIBLE
                }
                else -> oSplitBadge.visibility = View.GONE
            }

            // 状态标签（搁置前缀）
            val op = opTagInfo(pkg)
            oOpTag.text = if (pkg.isIgnored) "搁置 · ${op.first}" else op.first
            oOpTag.setTextColor(Color.parseColor(op.second))
            oOpTag.setRoundedBg(Color.parseColor(oSoftBg(op.second)))
            oOpTag.visibility = View.VISIBLE

            oTags.text = pkg.tags?.joinToString(" · ")
            oTags.visibility = if (pkg.tags.isNullOrEmpty()) View.GONE else View.VISIBLE

            // 产品行
            oProdContainer.removeAllViews()
            val items = pkg.items
            if (items.isNullOrEmpty()) {
                oProdContainer.addView(emptyText("—"))
            } else {
                for (it in items) {
                    oProdContainer.addView(buildProductRow(it.picUrl, it.title, it.sku, it.offerId, it.price, it.quantity, it.sku))
                }
            }

            // 采购状态 / 到货
            val purchaseStatus = pkg.purchaseStatus
            if (purchaseStatus == "none") {
                oPurchaseTag.text = "未采购"
                oPurchaseTag.setTextColor(Color.parseColor(O_COLOR_MUTE))
                oPurchaseTag.setRoundedBg(Color.parseColor("#f2f3f5"))
                oPurchaseTag.visibility = View.VISIBLE
            } else {
                oPurchaseTag.text = "已采购"
                oPurchaseTag.setTextColor(Color.parseColor(O_COLOR_OK))
                oPurchaseTag.setRoundedBg(Color.parseColor("#e8ffea"))
                oPurchaseTag.visibility = View.VISIBLE
            }
            if (!pkg.arrivedAt.isNullOrBlank()) {
                oArrivedTag.text = "已到货"
                oArrivedTag.setTextColor(Color.parseColor(O_COLOR_WARN))
                oArrivedTag.setRoundedBg(Color.parseColor("#fff7e6"))
                oArrivedTag.visibility = View.VISIBLE
            } else {
                oArrivedTag.visibility = View.GONE
            }

            oFootAmts.text = buildString {
                append("订单 ").append(fmtMoney(pkg.orderAmount))
                append("  采购 ").append(fmtMoney(pkg.totalPurchaseAmount))
                append("  ").append(pkg.weightG?.let { "${fmtNum(it)}g" } ?: "—")
            }

            // 操作区（重量输入/提交发货/面单）
            bindActions(pkg)

            // 时间行
            buildTimeRows(pkg)
        }

        private fun buildProductRow(
            picUrl: String?, title: String?, sku: String?, offerId: String?,
            price: Double?, quantity: Double?, skuText: String?
        ): View {
            val row = inflater.inflate(R.layout.item_product, oProdContainer, false) as LinearLayout
            val img: ImageView = row.findViewById(R.id.prodImg)
            val titleTv: TextView = row.findViewById(R.id.prodTitle)
            val skuTv: TextView = row.findViewById(R.id.prodSku)
            val offerTv: TextView = row.findViewById(R.id.prodOffer)
            val priceTv: TextView = row.findViewById(R.id.prodPrice)
            val copySku: TextView = row.findViewById(R.id.copySku)
            val copyOffer: TextView = row.findViewById(R.id.copyOffer)

            if (picUrl.isNullOrBlank()) {
                img.setImageDrawable(null)
            } else {
                img.load(picUrl)
            }
            // 点击商品图放大预览
            img.setOnClickListener { row.context.showImagePreview(picUrl) }
            titleTv.text = title ?: "—"
            skuTv.text = "SKU:${sku ?: "—"}"
            skuTv.setTextColor(Color.parseColor("#165dff"))
            skuTv.setOnClickListener {
                skuText?.takeIf { it.isNotBlank() }?.let { callbacks.onSearchSku(it) }
            }
            offerTv.text = "Offer ID:${offerId ?: "—"}"
            priceTv.text = buildString {
                append("单价 ").append(fmtMoney(price))
                append(" ×").append(fmtNum(quantity))
            }

            // 复制小图标(对齐 H5:SKU / Offer ID)
            copySku.visibility = if (sku.isNullOrBlank()) View.GONE else View.VISIBLE
            if (copySku.visibility == View.VISIBLE) {
                copySku.textSize = 11f
                copySku.setTextColor(Color.parseColor("#165dff"))
                copySku.setRoundedBg(Color.parseColor("#eef4ff"), 6f)
                copySku.setPadding(12.dp2px(context), 6.dp2px(context), 12.dp2px(context), 6.dp2px(context))
                copySku.layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { leftMargin = 8.dp2px(context) }
            }
            copySku.setOnClickListener { sku?.let { callbacks.onCopy(it, "SKU") } }
            copyOffer.visibility = if (offerId.isNullOrBlank()) View.GONE else View.VISIBLE
            if (copyOffer.visibility == View.VISIBLE) {
                copyOffer.textSize = 11f
                copyOffer.setTextColor(Color.parseColor("#165dff"))
                copyOffer.setRoundedBg(Color.parseColor("#eef4ff"), 6f)
                copyOffer.setPadding(12.dp2px(context), 6.dp2px(context), 12.dp2px(context), 6.dp2px(context))
                copyOffer.layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { leftMargin = 8.dp2px(context) }
            }
            copyOffer.setOnClickListener { offerId?.let { callbacks.onCopy(it, "Offer ID") } }

            return row
        }

        private fun bindActions(pkg: Pkg) {
            oActionArea.removeAllViews()
            // 列表不再展示提交发货/面单/更正重量等操作，统一到订单详情页处理
        }

        private fun actionButton(text: String, color: String, onClick: () -> Unit): TextView {
            return TextView(context).apply {
                this.text = text
                setTextColor(Color.WHITE)
                textSize = 12f
                setBackgroundColor(Color.parseColor(color))
                setPadding(16, 10, 16, 10)
                val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                lp.leftMargin = 8
                layoutParams = lp
                setOnClickListener { onClick() }
            }
        }

        private fun buildTimeRows(pkg: Pkg) {
            oTimeContainer.removeAllViews()
            val op = pkg.operateStatus
            val countdownStatuses = listOf("wait_process", "wait_ship", "ship_success")
            val shipTimesStatuses = listOf("wait_receiver_confirm", "signed", "settled", "returned")

            when {
                op in countdownStatuses && !pkg.shipmentDate.isNullOrBlank() -> {
                    addTimeRow(oTimeContainer, "下单", fmtTimeWithWeekday(pkg.inProcessAt))
                    addTimeRow(oTimeContainer, "最迟", fmtTimeWithWeekday(pkg.shipmentDate))
                    val cd = countdownText(pkg.shipmentDate)
                    addTimeRow(oTimeContainer, if (cd.first) "已超时" else "剩发", cd.second, cd.first)
                    if (op == "wait_ship" && pkg.profit != null) {
                        addTimeRow(oTimeContainer, "预估利润", fmtMoney(pkg.profit.profit), false, profitColor(pkg.profit.profit))
                    }
                }
                op in shipTimesStatuses -> {
                    addTimeRow(oTimeContainer, "下单", fmtTimeWithWeekday(pkg.inProcessAt))
                    if (!pkg.deliveringDate.isNullOrBlank()) {
                        addTimeRow(oTimeContainer, "揽收", fmtTimeWithWeekday(pkg.deliveringDate))
                    }
                    if (!pkg.deliveredAt.isNullOrBlank()) {
                        addTimeRow(oTimeContainer, "签收", fmtTimeWithWeekday(pkg.deliveredAt))
                    }
                    if (!pkg.returnAt.isNullOrBlank()) {
                        addTimeRow(oTimeContainer, "退货", fmtTimeWithWeekday(pkg.returnAt))
                    }
                    if (pkg.profit != null) {
                        addTimeRow(oTimeContainer, profitLabelOf(pkg), fmtMoney(pkg.profit.profit), false, profitColor(pkg.profit.profit))
                    }
                }
            }
        }

        private fun addTimeRow(container: LinearLayout, key: String, value: CharSequence, overdue: Boolean = false, valueColor: Int = Color.parseColor(O_COLOR_TEXT)) {
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            val k = TextView(context).apply {
                text = key
                setTextColor(if (overdue) Color.parseColor(O_COLOR_ERR) else Color.parseColor(O_COLOR_MUTE))
                textSize = 11f
            }
            val v = TextView(context).apply {
                text = value
                setTextColor(if (overdue) Color.parseColor(O_COLOR_ERR) else valueColor)
                textSize = 11f
            }
            val kLp = LinearLayout.LayoutParams(120.dp2px(context), ViewGroup.LayoutParams.WRAP_CONTENT)
            row.addView(k, kLp)
            row.addView(v, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            container.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        private fun emptyText(text: String): TextView {
            return TextView(context).apply {
                this.text = text
                setTextColor(Color.parseColor(O_COLOR_MUTE))
                textSize = 11f
            }
        }
    }
}

// ── 辅助 ──
private fun opTagInfo(pkg: Pkg): Pair<String, String> {
    if (pkg.isReturned) return "已退货" to O_COLOR_ERR
    return when (pkg.operateStatus) {
        "wait_process" -> "待处理" to O_COLOR_WARN
        "wait_ship" -> "待打单发货" to O_COLOR_PRIMARY
        "ship_success" -> "交运" to O_COLOR_PRIMARY
        "wait_receiver_confirm" -> "已发货" to O_COLOR_OK
        "signed" -> "已签收" to O_COLOR_OK
        "settled" -> "已成功" to O_COLOR_OK
        "returned" -> "已退货" to O_COLOR_ERR
        "cancelled" -> "已取消" to O_COLOR_ERR
        else -> (pkg.operateStatus ?: "—") to O_COLOR_MUTE
    }
}

private fun oSoftBg(color: String): String = when (color) {
    O_COLOR_PRIMARY -> "#eef4ff"
    O_COLOR_WARN -> "#fff7e6"
    O_COLOR_OK -> "#e8ffea"
    O_COLOR_ERR -> "#ffece8"
    else -> "#f2f3f5"
}

private fun isQcPosting(sn: String?): Boolean {
    val s = sn ?: ""
    return s.startsWith("02131") || s.startsWith("024785")
}

private fun profitColor(v: Double?): Int {
    if (v == null) return Color.parseColor(O_COLOR_MUTE)
    return if (v > 0) Color.parseColor(O_COLOR_OK) else if (v < 0) Color.parseColor(O_COLOR_ERR) else Color.parseColor(O_COLOR_MUTE)
}

private fun profitLabelOf(pkg: Pkg): String {
    val p = pkg.profit ?: return "利润"
    if (p.cancelled == true) return "利润"
    return if (p.estimated == false) "利润实" else "预估利润"
}

/** 倒计时：返回 (是否超时, 文本)，精度到分钟 */
fun countdownText(shipmentDate: String?): Pair<Boolean, String> {
    if (shipmentDate.isNullOrBlank()) return false to "—"
    val end = parseIsoTime(shipmentDate) ?: return false to "—"
    val diff = end - System.currentTimeMillis()
    val overdue = diff < 0
    val abs = kotlin.math.abs(diff)
    val days = abs / 86400000L
    val hours = (abs % 86400000L) / 3600000L
    val mins = (abs % 3600000L) / 60000L
    val text = when {
        days > 0 -> "${days}天${hours}小时${mins}分"
        hours > 0 -> "${hours}小时${mins}分"
        else -> "${mins}分"
    }
    return overdue to text
}

private fun Int.dp2px(context: Context): Int {
    return (this * context.resources.displayMetrics.density + 0.5f).toInt()
}