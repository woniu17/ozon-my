package com.yochylin.scanner.adapter

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.InputType
import android.text.Spannable
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import coil.load
import com.yochylin.scanner.R
import com.yochylin.scanner.model.Pkg
import com.yochylin.scanner.model.PurchaseLink
import com.yochylin.scanner.setRoundedBg
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

private const val COLOR_PRIMARY = "#165dff"
private const val COLOR_WARN = "#d97706"
private const val COLOR_OK = "#00b42a"
private const val COLOR_ERR = "#f53f3f"
private const val COLOR_MUTE = "#86909c"
private const val COLOR_TEXT = "#1f2329"

/** 主列表适配器：订单卡片 + 发货记录区块 */
class PackageAdapter(private val callbacks: Callbacks) :
    RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    interface Callbacks {
        fun onCopy(text: String, label: String)
        fun onShipPackage(pkg: Pkg)
        fun onSubmitShip(pkg: Pkg, weightG: Int)
        fun onOpenLabel(pkg: Pkg)
        fun onCorrectWeight(pkg: Pkg, weightG: Int)
        fun onSwitchRecordTab(tab: String)
    }

    sealed class Item {
        data class PkgItem(val pkg: Pkg) : Item()
        data class RecordHeader(val tab: String, val countToday: Int, val countYesterday: Int) : Item()
        data class RecordRow(val rec: Pkg) : Item()
    }

    companion object {
        private const val TYPE_PKG = 0
        private const val TYPE_REC_HEADER = 1
        private const val TYPE_REC_ROW = 2
    }

    private val items = mutableListOf<Item>()

    fun setData(packages: List<Pkg>, records: List<Pkg>, tab: String, countToday: Int, countYesterday: Int) {
        items.clear()
        for (p in packages) items.add(Item.PkgItem(p))
        items.add(Item.RecordHeader(tab, countToday, countYesterday))
        for (r in records) items.add(Item.RecordRow(r))
        notifyDataSetChanged()
    }

    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (items[position]) {
        is Item.PkgItem -> TYPE_PKG
        is Item.RecordHeader -> TYPE_REC_HEADER
        is Item.RecordRow -> TYPE_REC_ROW
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            TYPE_PKG -> PkgViewHolder(inflater.inflate(R.layout.item_package, parent, false))
            TYPE_REC_HEADER -> RecordHeaderViewHolder(inflater.inflate(R.layout.item_record_header, parent, false))
            else -> RecordRowViewHolder(inflater.inflate(R.layout.item_record, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val item = items[position]) {
            is Item.PkgItem -> (holder as PkgViewHolder).bind(item.pkg)
            is Item.RecordHeader -> (holder as RecordHeaderViewHolder).bind(item)
            is Item.RecordRow -> (holder as RecordRowViewHolder).bind(item.rec)
        }
    }

    // ── 订单卡片 ──
    inner class PkgViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val storeName: TextView = view.findViewById(R.id.storeName)
        private val postingNumber: TextView = view.findViewById(R.id.postingNumber)
        private val opTag: TextView = view.findViewById(R.id.opTag)
        private val copyPosting: TextView = view.findViewById(R.id.copyPosting)
        private val tagsText: TextView = view.findViewById(R.id.tagsText)
        private val noteText: TextView = view.findViewById(R.id.noteText)
        private val timeContainer: LinearLayout = view.findViewById(R.id.timeContainer)
        private val prodContainer: LinearLayout = view.findViewById(R.id.prodContainer)
        private val purchaseTitle: TextView = view.findViewById(R.id.purchaseTitle)
        private val purchaseContainer: LinearLayout = view.findViewById(R.id.purchaseContainer)
        private val profitText: TextView = view.findViewById(R.id.profitText)
        private val formulaText: TextView = view.findViewById(R.id.formulaText)
        private val actionArea: LinearLayout = view.findViewById(R.id.actionArea)

        private val context: Context = view.context
        private val inflater = LayoutInflater.from(context)

        fun bind(pkg: Pkg) {
            // 订单级信息
            storeName.text = pkg.storeName
            storeName.visibility = if (pkg.storeName.isNullOrBlank()) View.GONE else View.VISIBLE

            postingNumber.text = pkg.postingNumber
            postingNumber.visibility = if (pkg.postingNumber.isNullOrBlank()) View.GONE else View.VISIBLE

            bindOpTag(pkg)
            copyPosting.setOnClickListener {
                pkg.postingNumber?.let { callbacks.onCopy(it, "货件号") }
            }

            tagsText.text = pkg.tags?.joinToString(" · ")
            tagsText.visibility = if (pkg.tags.isNullOrEmpty()) View.GONE else View.VISIBLE

            noteText.text = "备注:${pkg.note}"
            noteText.visibility = if (pkg.note.isNullOrBlank()) View.GONE else View.VISIBLE

            bindTimes(pkg)

            // 产品行
            prodContainer.removeAllViews()
            val items = pkg.items
            if (!items.isNullOrEmpty()) {
                for (it in items) {
                    prodContainer.addView(buildProductRow(it.picUrl, it.title, it.sku, it.offerId, it.price, it.quantity))
                }
            } else {
                val empty = TextView(context).apply {
                    text = "—"
                    setTextColor(Color.parseColor(COLOR_MUTE))
                    textSize = 11f
                }
                prodContainer.addView(empty)
            }

            // 采购行
            purchaseContainer.removeAllViews()
            val links = pkg.purchaseLinks
            purchaseTitle.visibility = if (links.isNullOrEmpty()) View.GONE else View.VISIBLE
            if (!links.isNullOrEmpty()) {
                for (l in links) purchaseContainer.addView(buildPurchaseRow(l))
            }

            // 利润
            bindProfit(pkg)

            // 操作区
            bindActions(pkg)
        }

        /** 时间区(2026-10-15 重新排版):下单/最迟发货分行走,剩发单独成行;
         *  剩发 <24小时 或 已超时时整行红色加粗高亮(超时浅红底,紧急浅橙底) */
        private fun bindTimes(pkg: Pkg) {
            timeContainer.removeAllViews()
            addTimeRow(timeContainer, "下单", fmtTimeWithWeekday(pkg.inProcessAt))
            if (!pkg.lastDeliveryAt.isNullOrBlank()) {
                addTimeRow(timeContainer, "最迟发货", fmtTimeWithWeekday(pkg.lastDeliveryAt))
                val remain = remainInfo(pkg.lastDeliveryAt)
                if (remain != null) addRemainRow(timeContainer, remain)
            }
        }

        private fun addTimeRow(container: LinearLayout, key: String, value: CharSequence) {
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val k = TextView(context).apply {
                text = key
                setTextColor(Color.parseColor(COLOR_MUTE))
                textSize = 11f
            }
            val v = TextView(context).apply {
                text = value
                setTextColor(Color.parseColor(COLOR_TEXT))
                textSize = 11f
            }
            row.addView(k, LinearLayout.LayoutParams(88.dp2px(context), ViewGroup.LayoutParams.WRAP_CONTENT))
            row.addView(v, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            container.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        private fun addRemainRow(container: LinearLayout, remain: RemainInfo) {
            val urgentColor = Color.parseColor(if (remain.urgent) COLOR_ERR else COLOR_WARN)
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(10.dp2px(context), 4.dp2px(context), 10.dp2px(context), 4.dp2px(context))
                setRoundedBg(Color.parseColor(if (remain.overdue) "#ffece8" else "#fff7e6"), 6f)
            }
            val k = TextView(context).apply {
                text = if (remain.overdue) "已超时" else "剩发"
                setTextColor(urgentColor)
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
            }
            val v = TextView(context).apply {
                text = remain.text
                setTextColor(urgentColor)
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
            }
            val kLp = LinearLayout.LayoutParams(88.dp2px(context), ViewGroup.LayoutParams.WRAP_CONTENT)
            kLp.topMargin = 4.dp2px(context)
            row.addView(k, kLp)
            val vLp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            vLp.topMargin = 4.dp2px(context)
            row.addView(v, vLp)
            container.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }

        private fun bindOpTag(pkg: Pkg) {
            val label: String
            val color: String
            if (pkg.isReturned) {
                label = "已退货"; color = COLOR_ERR
            } else {
                when (pkg.operateStatus) {
                    "wait_process" -> { label = "待处理"; color = COLOR_WARN }
                    "wait_ship" -> { label = "待打单发货"; color = COLOR_PRIMARY }
                    "ship_success" -> { label = "交运"; color = COLOR_PRIMARY }
                    "wait_receiver_confirm" -> { label = "已发货"; color = COLOR_OK }
                    "cancelled" -> { label = "已取消"; color = COLOR_ERR }
                    else -> { label = pkg.operateStatus ?: "—"; color = COLOR_MUTE }
                }
            }
            opTag.text = label
            opTag.setTextColor(Color.parseColor(color))
            opTag.setRoundedBg(Color.parseColor(softBg(color)))
            opTag.visibility = View.VISIBLE
        }

        private fun bindProfit(pkg: Pkg) {
            val orderAmount = pkg.orderAmount
            val profit = pkg.profit
            val amountStr = orderAmount?.let { fmtMoney(it) } ?: "—"
            if (profit == null) {
                profitText.text = "订单金额 $amountStr · 利润:—(无计算数据)"
                formulaText.text = ""
                return
            }
            val p = profit.profit
            val estimated = profit.estimated != false
            val tag = if (estimated) "(估)" else "(实)"
            profitText.text = "订单金额 $amountStr · 利润$tag ${fmtMoney(p)}"
            formulaText.text = buildString {
                append("利润 = ")
                if (profit.cancelled == true) {
                    append("−采购 ${fmtMoney(pkg.totalPurchaseAmount)}（已取消）")
                } else if (profit.returned == true) {
                    append("−采购 ${fmtMoney(pkg.totalPurchaseAmount)}（已退货）")
                } else if (profit.estimated == false) {
                    append("打款 ${fmtMoney(profit.escrow)} − 采购 ${fmtMoney(pkg.totalPurchaseAmount)}")
                } else {
                    append("订单 ${fmtMoney(orderAmount)} − 佣金 ${fmtMoney(profit.commission)} − 配送 ${fmtMoney(profit.delivery)} − 采购 ${fmtMoney(pkg.totalPurchaseAmount)}")
                }
            }
        }

        private fun bindActions(pkg: Pkg) {
            actionArea.removeAllViews()

            val canShipPkg = pkg.ozonStatus == "awaiting_packaging" && !pkg.isIgnored && pkg.id.isNotEmpty()
            val canShipCard = pkg.operateStatus == "wait_ship" && !pkg.isIgnored
            val canReprint = pkg.operateStatus == "ship_success" || pkg.operateStatus == "wait_receiver_confirm"
            val currentWeight = pkg.weightG?.let { fmtNum(it) }

            // 备货(Ozon 待打包确认货件;未到提交发货状态时显示)
            if (canShipPkg && !canShipCard) {
                actionArea.addView(
                    newButton("备货", Color.parseColor(COLOR_PRIMARY)) {
                        callbacks.onShipPackage(pkg)
                    }
                )
            }

            // 待打单发货:录重量 + 提交发货 + 面单(2026-10-16 修复:行内按钮改 WRAP_CONTENT,输入框不再被挤掉;预填已称重量)
            if (canShipCard) {
                val refs = buildString {
                    append("Ozon后台 ")
                    append(pkg.ozonWeightG?.let { "${fmtNum(it)}g" } ?: "—")
                    append(" · 本系统 ")
                    append(pkg.systemWeightG?.let { "${fmtNum(it)}g" } ?: "—")
                }
                actionArea.addView(newSectionLabel(refs))

                val row = buildWeightRow()
                val weightInput = buildWeightInput("重量(g)", currentWeight)
                row.addView(weightInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                row.addView(newRowButton("提交发货", Color.parseColor(COLOR_PRIMARY)) {
                    val g = validateWeight(weightInput)
                    if (g != null) callbacks.onSubmitShip(pkg, g)
                })
                row.addView(newRowButton("面单", Color.parseColor("#4e5969")) {
                    callbacks.onOpenLabel(pkg)
                })
                actionArea.addView(row)
            }

            // 已交运/已发货:称重 + 更正重量 + 面单
            if (canReprint) {
                val weighed = currentWeight?.let { "称重 ${it}g" } ?: "称重 —"
                actionArea.addView(newSectionLabel(weighed))

                val row = buildWeightRow()
                val weightInput = buildWeightInput("更正重量(g)", currentWeight)
                row.addView(weightInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                row.addView(newRowButton("更正", Color.parseColor("#4e5969")) {
                    val g = validateWeight(weightInput)
                    if (g != null) callbacks.onCorrectWeight(pkg, g)
                })
                row.addView(newRowButton("面单", Color.parseColor("#4e5969")) {
                    callbacks.onOpenLabel(pkg)
                })
                actionArea.addView(row)
            }

            // 仅备货需求的订单:可提前录入发货重量(2026-10-16 新增,保存重量不改变订单状态)
            if (canShipPkg && !canShipCard && !canReprint) {
                actionArea.addView(newSectionLabel("可提前录入发货重量"))
                val row = buildWeightRow()
                val weightInput = buildWeightInput("重量(g)", currentWeight)
                row.addView(weightInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                row.addView(newRowButton("保存重量", Color.parseColor("#4e5969")) {
                    val g = validateWeight(weightInput)
                    if (g != null) callbacks.onCorrectWeight(pkg, g)
                })
                actionArea.addView(row)
            }

            // 无可用操作：显示状态说明
            if (!canShipPkg && !canShipCard && !canReprint) {
                val reason = when {
                    pkg.isIgnored -> "已搁置"
                    pkg.operateStatus == "wait_process" -> "待处理(未采购)"
                    pkg.operateStatus == "cancelled" -> "订单已取消"
                    else -> pkg.operateStatus ?: "—"
                }
                actionArea.addView(newSectionLabel(reason))
            }
        }

        /** 重量输入框(数字,可预填已有重量) */
        private fun buildWeightInput(hint: String, preset: String?): EditText {
            return EditText(context).apply {
                this.hint = hint
                if (!preset.isNullOrBlank()) setText(preset)
                inputType = InputType.TYPE_CLASS_NUMBER
                textSize = 14f
                setPadding(12, 8, 12, 8)
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.parseColor("#f2f3f5"))
                    cornerRadius = 8f
                }
            }
        }

        /** 重量操作行(水平) */
        private fun buildWeightRow(): LinearLayout {
            return LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
        }

        /** 行内按钮(WRAP_CONTENT,避免把输入框挤出屏幕) */
        private fun newRowButton(text: String, color: Int, onClick: () -> Unit): Button {
            return Button(context).apply {
                this.text = text
                setTextColor(Color.WHITE)
                textSize = 13f
                isAllCaps = false
                setRoundedBg(color, 10f)
                val lp = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
                lp.leftMargin = 8
                setPadding(14, 10, 14, 10)
                layoutParams = lp
                setOnClickListener { onClick() }
            }
        }

        /** 校验重量输入:1~50000 正整数,非法时红字提示并返回 null */
        private fun validateWeight(input: EditText): Int? {
            val raw = input.text.toString().trim()
            val g = raw.toIntOrNull()
            if (raw.isEmpty() || g == null || g < 1 || g > 50000) {
                input.error = "重量须为 1~50000 的整数"
                return null
            }
            return g
        }

        private fun buildProductRow(
            picUrl: String?, title: String?, sku: String?, offerId: String?,
            price: Double?, quantity: Double?
        ): View {
            val row = inflater.inflate(R.layout.item_product, prodContainer, false) as LinearLayout
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
            titleTv.text = title ?: "—"
            skuTv.text = "SKU:${sku ?: "—"}"
            offerTv.text = "Offer ID:${offerId ?: "—"}"
            priceTv.text = buildString {
                append("单价 ").append(fmtMoney(price))
                append(" ×").append(fmtNum(quantity))
            }

            // 复制小图标(对齐 H5:SKU / Offer ID)
            copySku.visibility = if (sku.isNullOrBlank()) View.GONE else View.VISIBLE
            copySku.setOnClickListener { sku?.let { callbacks.onCopy(it, "SKU") } }
            copyOffer.visibility = if (offerId.isNullOrBlank()) View.GONE else View.VISIBLE
            copyOffer.setOnClickListener { offerId?.let { callbacks.onCopy(it, "Offer ID") } }

            return row
        }

        private fun buildPurchaseRow(l: PurchaseLink): View {
            val row = inflater.inflate(R.layout.item_purchase, purchaseContainer, false) as LinearLayout
            val platformTv: TextView = row.findViewById(R.id.purchasePlatform)
            val snTv: TextView = row.findViewById(R.id.purchaseSn)
            val copyTv: TextView = row.findViewById(R.id.copyPurchaseSn)
            val copyLogistics: TextView = row.findViewById(R.id.copyLogistics)
            val buyerTv: TextView = row.findViewById(R.id.purchaseBuyer)
            val timeTv: TextView = row.findViewById(R.id.purchaseTime)
            val amountTv: TextView = row.findViewById(R.id.purchaseAmount)
            val logisticsTv: TextView = row.findViewById(R.id.purchaseLogistics)

            platformTv.text = platformLabel(l.platform)
            platformTv.visibility = if (l.platform.isNullOrBlank()) View.GONE else View.VISIBLE
            snTv.text = l.purchaseSn ?: "#${l.id}"
            copyTv.setOnClickListener {
                l.purchaseSn?.let { callbacks.onCopy(it, "采购订单号") }
            }

            val count = l.items?.sumOf {
                (it.number ?: it.num ?: 1.0)
            } ?: 0.0
            buyerTv.text = buildString {
                append("采购买家:")
                append(l.buyerAccount ?: "—")
                if (count > 0) append(" · 数量 ×").append(fmtNum(count))
            }
            buyerTv.visibility = if (l.buyerAccount.isNullOrBlank() && count <= 0) View.GONE else View.VISIBLE

            val poTime = l.poPayAt ?: l.poGmtCreate
            timeTv.text = SpannableStringBuilder()
                .append("采购时间:")
                .append(fmtTimeWithWeekday(poTime))
            timeTv.visibility = if (poTime.isNullOrBlank()) View.GONE else View.VISIBLE

            amountTv.text = "采购金额:${fmtMoney(l.allocatedAmount)}"
            amountTv.visibility = if (l.allocatedAmount == null) View.GONE else View.VISIBLE

            val logistics = if (l.poLogisticsNo.isNullOrBlank()) "—" else "${l.poLogisticsCompany ?: ""} ${l.poLogisticsNo}".trim()
            logisticsTv.text = "物流:$logistics"
            logisticsTv.visibility = if (l.poLogisticsNo.isNullOrBlank()) View.GONE else View.VISIBLE

            // 复制快递单号(对齐 H5)
            copyLogistics.visibility = if (l.poLogisticsNo.isNullOrBlank()) View.GONE else View.VISIBLE
            copyLogistics.setOnClickListener { l.poLogisticsNo?.let { callbacks.onCopy(it, "快递单号") } }

            return row
        }

        private fun newButton(text: String, color: Int, onClick: () -> Unit): Button {
            return Button(context).apply {
                this.text = text
                setTextColor(Color.WHITE)
                textSize = 13f
                setRoundedBg(color, 10f)
                isAllCaps = false
                val lp = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
                lp.topMargin = 8
                setPadding(16, 10, 16, 10)
                layoutParams = lp
                setOnClickListener { onClick() }
            }
        }

        private fun newSectionLabel(text: String): TextView {
            return TextView(context).apply {
                this.text = text
                setTextColor(Color.parseColor(COLOR_MUTE))
                textSize = 11f
                val lp = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
                lp.topMargin = 6
                layoutParams = lp
            }
        }
    }

    // ── 记录区块头 ──
    inner class RecordHeaderViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val tabToday: TextView = view.findViewById(R.id.tabToday)
        private val tabYesterday: TextView = view.findViewById(R.id.tabYesterday)

        fun bind(item: Item.RecordHeader) {
            bindTab(tabToday, "今日", item.countToday, item.tab == "today")
            bindTab(tabYesterday, "昨日", item.countYesterday, item.tab == "yesterday")
            tabToday.setOnClickListener {
                if (item.tab != "today") callbacks.onSwitchRecordTab("today")
            }
            tabYesterday.setOnClickListener {
                if (item.tab != "yesterday") callbacks.onSwitchRecordTab("yesterday")
            }
        }

        private fun bindTab(tv: TextView, label: String, count: Int, active: Boolean) {
            tv.text = if (count >= 0) "$label($count)" else label
            tv.setTextColor(if (active) Color.parseColor(COLOR_PRIMARY) else Color.parseColor(COLOR_MUTE))
            tv.typeface = if (active) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        }
    }

    // ── 记录行 ──
    inner class RecordRowViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val recStore: TextView = view.findViewById(R.id.recStore)
        private val recPosting: TextView = view.findViewById(R.id.recPosting)
        private val recMeta: TextView = view.findViewById(R.id.recMeta)
        private val recordImgs: LinearLayout = view.findViewById(R.id.recordImgs)

        fun bind(rec: Pkg) {
            recStore.text = rec.storeName
            recStore.visibility = if (rec.storeName.isNullOrBlank()) View.GONE else View.VISIBLE
            recPosting.text = rec.postingNumber
            recPosting.visibility = if (rec.postingNumber.isNullOrBlank()) View.GONE else View.VISIBLE
            val meta = SpannableStringBuilder()
            rec.weightG?.let { meta.append(fmtNum(it)).append("g") }
            if (rec.weightG != null && !rec.inProcessAt.isNullOrBlank()) meta.append(" · ")
            if (!rec.inProcessAt.isNullOrBlank()) meta.append(fmtTimeWithWeekday(rec.inProcessAt))
            recMeta.text = meta

            bindRecordImages(rec)
        }

        /** 商品图片缩略图(2026-10-16 新增):按图去重,最多 4 张,超出追加 +N 角标 */
        private fun bindRecordImages(rec: Pkg) {
            recordImgs.removeAllViews()
            val urls = rec.items
                ?.mapNotNull { it.picUrl }
                ?.filter { it.isNotBlank() }
                ?.distinct() ?: emptyList()
            if (urls.isEmpty()) {
                recordImgs.visibility = View.GONE
                return
            }
            recordImgs.visibility = View.VISIBLE
            val MAX = 4
            for (url in urls.take(MAX)) {
                recordImgs.addView(recordThumb(url))
            }
            if (urls.size > MAX) {
                recordImgs.addView(recordMoreBadge(urls.size - MAX))
            }
        }

        private fun recordThumb(url: String): ImageView {
            return ImageView(itemView.context).apply {
                layoutParams = LinearLayout.LayoutParams(40.dp2px(itemView.context), 40.dp2px(itemView.context)).apply {
                    marginEnd = 6.dp2px(itemView.context)
                }
                scaleType = ImageView.ScaleType.CENTER_CROP
                setBackgroundColor(Color.parseColor("#f2f3f5"))
                load(url)
            }
        }

        private fun recordMoreBadge(n: Int): TextView {
            return TextView(itemView.context).apply {
                text = "+$n"
                textSize = 11f
                setTextColor(Color.parseColor(COLOR_MUTE))
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(40.dp2px(itemView.context), 40.dp2px(itemView.context))
                setBackgroundColor(Color.parseColor("#f2f3f5"))
            }
        }
    }
}

// ── 展示辅助（与 H5 对齐的简化版） ──
private fun softBg(color: String): String = when (color) {
    COLOR_PRIMARY -> "#eef4ff"
    COLOR_WARN -> "#fff7e6"
    COLOR_OK -> "#e8ffea"
    COLOR_ERR -> "#ffece8"
    else -> "#f2f3f5"
}

fun fmtMoney(v: Double?): String {
    if (v == null) return "—"
    return String.format(Locale.US, "¥%.2f", v)
}

/** 数值格式化：整数显示为整数（如 123），小数显示原值（如 123.5） */
fun fmtNum(v: Double?): String {
    if (v == null) return "—"
    return if (v == Math.floor(v) && !v.isInfinite()) {
        v.toLong().toString()
    } else {
        v.toString()
    }
}

/** 时间格式化：YYYY-MM-DD HH:mm（与 H5/Web 展示口径一致）；无效值原样截断返回 */
// SimpleDateFormat 创建开销大且非线程安全：用 ThreadLocal 缓存，避免列表滚动时反复 new（卡顿优化）
private val ISO_UTC_FMT: ThreadLocal<SimpleDateFormat> = object : ThreadLocal<SimpleDateFormat>() {
    override fun initialValue(): SimpleDateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSX", Locale.US)
}
private val ISO_T_FMT: ThreadLocal<SimpleDateFormat> = object : ThreadLocal<SimpleDateFormat>() {
    // Ozon API 常见无毫秒格式:2026-10-20T09:00:00Z / +00:00（H5 用 new Date() 原生解析，Android 需兼容）
    override fun initialValue(): SimpleDateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssX", Locale.US)
}
private val ISO_SEC_FMT: ThreadLocal<SimpleDateFormat> = object : ThreadLocal<SimpleDateFormat>() {
    override fun initialValue(): SimpleDateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
}
private val OUT_FMT: ThreadLocal<SimpleDateFormat> = object : ThreadLocal<SimpleDateFormat>() {
    override fun initialValue(): SimpleDateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
}

/** 宽松解析 ISO 时间（依次尝试 带毫秒ISO → 无毫秒ISO → 空格分隔），返回毫秒时间戳；失败返回 null */
fun parseIsoTime(iso: String?): Long? {
    if (iso.isNullOrBlank()) return null
    val candidates = arrayOf<SimpleDateFormat>(ISO_UTC_FMT.get(), ISO_T_FMT.get(), ISO_SEC_FMT.get())
    for (fmt in candidates) {
        try {
            fmt.parse(iso)?.let { return it.time }
        } catch (_: Exception) {
            // 尝试下一种格式
        }
    }
    return null
}

fun fmtTime(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    val t = parseIsoTime(iso) ?: return iso.replace("T", " ").take(16)
    return OUT_FMT.get()!!.format(t) // ThreadLocal 必有初始值
}

/** ISO 时间 → 中文周几（如"周三"）；无效时间返回空串（与 H5 weekdayCN 同口径） */
fun weekdayCN(iso: String?): String {
    val t = parseIsoTime(iso) ?: return ""
    val weekday = Calendar.getInstance().apply { timeInMillis = t }.get(Calendar.DAY_OF_WEEK) - 1
    return "周" + "日一二三四五六"[weekday]
}

/** 时间 + 周几（H5 口径）：如 "2026-10-15 10:30（周四）"，周几部分浅灰色 */
fun fmtTimeWithWeekday(iso: String?): CharSequence {
    val base = fmtTime(iso)
    val wd = weekdayCN(iso)
    if (base == "—" || wd.isEmpty()) return base
    val suffix = "（$wd）"
    return SpannableString(base + suffix).apply {
        setSpan(
            ForegroundColorSpan(Color.parseColor(COLOR_MUTE)),
            base.length,
            base.length + suffix.length,
            Spannable.SPAN_EXCLUSIVE_EXCLUSIVE
        )
    }
}

/** 剩发状态:overdue=已超时, urgent=需醒目展示(超时 或 剩余不足24小时), text=倒计时文本 */
data class RemainInfo(val overdue: Boolean, val urgent: Boolean, val text: String)

private fun remainInfo(lastDeliveryAt: String?): RemainInfo? {
    if (lastDeliveryAt.isNullOrBlank()) return null
    val t = parseIsoTime(lastDeliveryAt) ?: return null
    val diff = t - System.currentTimeMillis()
    val overdue = diff < 0
    val abs = kotlin.math.abs(diff)
    val d = abs / 86400000L
    val h = (abs % 86400000L) / 3600000L
    val m = (abs % 3600000L) / 60000L
    val body = when {
        d > 0 -> "${d}天${h}小时"
        h > 0 -> "${h}小时${m}分"
        else -> "${m}分"
    }
    val text = if (overdue) "已超时$body" else "剩$body"
    return RemainInfo(overdue, overdue || diff < 86400000L, text)
}

private fun Int.dp2px(context: Context): Int {
    return (this * context.resources.displayMetrics.density + 0.5f).toInt()
}

fun platformLabel(p: String?): String = when (p) {
    "1688" -> "1688"
    "ali1688" -> "1688"
    "pdd" -> "拼多多"
    "yangkeduo" -> "拼多多"
    "taobao" -> "淘宝"
    "other" -> "手工(其他)"
    else -> p ?: "—"
}