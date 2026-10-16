package com.yochylin.scanner.adapter

import android.content.Context
import android.graphics.Color
import android.text.SpannableStringBuilder
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.yochylin.scanner.R
import com.yochylin.scanner.model.AccrualType
import com.yochylin.scanner.model.FinanceOrder
import com.yochylin.scanner.model.NonOrderAccrual
import com.yochylin.scanner.setRoundedBg

private const val F_COLOR_OK = "#00b42a"
private const val F_COLOR_ERR = "#f53f3f"
private const val F_COLOR_WARN = "#d97706"
private const val F_COLOR_PRIMARY = "#165dff"
private const val F_COLOR_MUTE = "#86909c"
private const val F_COLOR_TEXT = "#1f2329"

/** 财务统计明细适配器：订单行 + 非订单应计行 */
class FinanceAdapter : RecyclerView.Adapter<FinanceAdapter.VH>() {

    sealed class Item {
        data class OrderItem(val order: FinanceOrder, val group: String) : Item()
        data class NonOrderItem(val item: NonOrderAccrual) : Item()
    }

    private val items = mutableListOf<Item>()
    private val orders = mutableListOf<FinanceOrder>()
    private val nonOrders = mutableListOf<NonOrderAccrual>()
    var currentMode = "settled" // settled | pending | nonorder

    fun setOrders(group: String, list: List<FinanceOrder>) {
        // 只接受与当前模式一致的数据；nonorder 模式下忽略订单数据（评审 P0-3）
        if (currentMode != group) return
        orders.clear()
        orders.addAll(list)
        rebuild()
    }

    fun appendOrders(group: String, list: List<FinanceOrder>) {
        if (currentMode != group) return
        orders.addAll(list)
        rebuild()
    }

    fun setNonOrders(list: List<NonOrderAccrual>) {
        currentMode = "nonorder"
        nonOrders.clear()
        nonOrders.addAll(list)
        rebuild()
    }

    fun appendNonOrders(list: List<NonOrderAccrual>) {
        if (currentMode != "nonorder") return
        nonOrders.addAll(list)
        rebuild()
    }

    fun setMode(mode: String) {
        currentMode = mode
        rebuild()
    }

    private fun rebuild() {
        items.clear()
        when (currentMode) {
            "nonorder" -> for (it in nonOrders) items.add(Item.NonOrderItem(it))
            else -> for (o in orders) items.add(Item.OrderItem(o, currentMode))
        }
        notifyDataSetChanged()
    }

    override fun getItemCount(): Int = items.size

    override fun getItemViewType(position: Int): Int = when (items[position]) {
        is Item.OrderItem -> 0
        is Item.NonOrderItem -> 1
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_finance, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        when (val item = items[position]) {
            is Item.OrderItem -> holder.bindOrder(item.order, item.group)
            is Item.NonOrderItem -> holder.bindNonOrder(item.item)
        }
    }

    inner class VH(view: View) : RecyclerView.ViewHolder(view) {
        private val fPosting: TextView = view.findViewById(R.id.fPosting)
        private val fCategory: TextView = view.findViewById(R.id.fCategory)
        private val fProfit: TextView = view.findViewById(R.id.fProfit)
        private val fMeta: TextView = view.findViewById(R.id.fMeta)
        private val fAmounts: TextView = view.findViewById(R.id.fAmounts)
        private val fChips: LinearLayout = view.findViewById(R.id.fChipsContainer)
        private val context: Context = view.context

        fun bindOrder(order: FinanceOrder, group: String) {
            fPosting.text = order.postingNumber ?: "—"
            fPosting.visibility = if (order.postingNumber.isNullOrBlank()) View.GONE else View.VISIBLE

            // 分类徽标
            if (group == "settled") {
                when (order.category) {
                    "success" -> bindBadge(fCategory, "已成功", F_COLOR_OK)
                    "cancelled" -> bindBadge(fCategory, "已取消", F_COLOR_ERR)
                    "returned" -> bindBadge(fCategory, "已退款", F_COLOR_WARN)
                    else -> bindBadge(fCategory, order.category ?: "—", F_COLOR_MUTE)
                }
            } else {
                bindBadge(fCategory, if (order.estimated) "预估" else "在途", F_COLOR_PRIMARY)
            }

            fProfit.text = fmtMoney(order.profit)
            fProfit.setTextColor(profitColor(order.profit))

            val time = fmtTimeWithWeekday(order.inProcessAt)
            fMeta.text = SpannableStringBuilder()
                .also { sb ->
                    if (!order.storeName.isNullOrBlank()) sb.append(order.storeName).append(" · ")
                    if (time.toString() != "—") sb.append(time)
                    if (!order.deliveredAt.isNullOrBlank()) sb.append(" · 妥投 ").append(fmtTimeWithWeekday(order.deliveredAt))
                }
            fMeta.visibility = if (fMeta.text.isNullOrBlank()) View.GONE else View.VISIBLE

            fAmounts.text = buildString {
                append("订单 ").append(fmtMoney(order.orderAmount))
                append(" · 采购 ").append(fmtMoney(order.purchaseAmount))
                append(" · 回款 ").append(fmtMoney(order.payout))
            }

            renderChips(order.accrualTypes)
        }

        fun bindNonOrder(item: NonOrderAccrual) {
            fPosting.text = item.unitNumber ?: "—"
            fPosting.visibility = if (item.unitNumber.isNullOrBlank()) View.GONE else View.VISIBLE

            bindBadge(fCategory, item.nameCn ?: "类型 ${item.typeId}", F_COLOR_WARN)

            fProfit.text = fmtMoney(item.cny ?: item.rub)
            fProfit.setTextColor(Color.parseColor(F_COLOR_ERR))

            fMeta.text = buildString {
                if (!item.storeName.isNullOrBlank()) append(item.storeName).append(" · ")
                if (!item.accrualDate.isNullOrBlank()) append(item.accrualDate)
            }

            fAmounts.text = "RUB ${fmtNum(item.rub)} · 应计 #${item.typeId}"
            fChips.removeAllViews()
        }

        private fun renderChips(types: List<AccrualType>?) {
            fChips.removeAllViews()
            if (types.isNullOrEmpty()) return
            for (t in types.take(6)) {
                fChips.addView(chip("${t.nameCn ?: "类型${t.typeId}"}×${t.count}"))
            }
        }

        private fun chip(text: String): TextView {
            return TextView(context).apply {
                this.text = text
                setTextColor(Color.parseColor("#4e5969"))
                textSize = 10f
                setRoundedBg(Color.parseColor("#f2f3f5"), 10f)
                setPadding(10, 5, 10, 5)
                val lp = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
                lp.rightMargin = dp(8)
                layoutParams = lp
            }
        }

        private fun bindBadge(tv: TextView, text: String, color: String) {
            tv.text = text
            tv.setTextColor(Color.parseColor(color))
            tv.setRoundedBg(Color.parseColor(softBg(color)), 10f)
            tv.visibility = View.VISIBLE
        }

        private fun dp(v: Number): Int {
            return (v.toFloat() * context.resources.displayMetrics.density).toInt()
        }

        private fun profitColor(v: Double?): Int {
            if (v == null) return Color.parseColor(F_COLOR_MUTE)
            return if (v > 0) Color.parseColor(F_COLOR_OK) else if (v < 0) Color.parseColor(F_COLOR_ERR) else Color.parseColor(F_COLOR_MUTE)
        }

        private fun softBg(color: String): String = when (color) {
            F_COLOR_OK -> "#e8ffea"
            F_COLOR_ERR -> "#ffece8"
            F_COLOR_WARN -> "#fff7e6"
            F_COLOR_PRIMARY -> "#eef4ff"
            else -> "#f2f3f5"
        }
    }
}