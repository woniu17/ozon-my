package com.yochylin.scanner.adapter

import android.content.Context
import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.yochylin.scanner.R
import com.yochylin.scanner.model.RatingErrorItem
import com.yochylin.scanner.setRoundedBg
import java.util.Locale

/** 店铺健康：影响错误指数货件明细适配器 */
class StoreHealthErrorAdapter : RecyclerView.Adapter<StoreHealthErrorAdapter.VH>() {

    /** 点击明细行回调(用于复制货件号等) */
    var onItemClick: ((RatingErrorItem) -> Unit)? = null

    private val list = mutableListOf<RatingErrorItem>()

    fun setList(items: List<RatingErrorItem>) {
        list.clear()
        list.addAll(items)
        notifyDataSetChanged()
    }

    fun append(items: List<RatingErrorItem>) {
        val start = list.size
        list.addAll(items)
        notifyItemRangeInserted(start, items.size)
    }

    fun size(): Int = list.size

    override fun getItemCount(): Int = list.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_rating_error, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        holder.bind(list[position])
        holder.itemView.setOnClickListener {
            onItemClick?.invoke(list[position])
        }
    }

    inner class VH(view: View) : RecyclerView.ViewHolder(view) {
        private val context: Context = view.context
        private val postingNumber: TextView = view.findViewById(R.id.rePostingNumber)
        private val schemaTag: TextView = view.findViewById(R.id.reSchemaTag)
        private val typeTag: TextView = view.findViewById(R.id.reTypeTag)
        private val storeName: TextView = view.findViewById(R.id.reStoreName)
        private val errorAt: TextView = view.findViewById(R.id.reErrorAt)
        private val indexView: TextView = view.findViewById(R.id.reIndex)
        private val graceView: TextView = view.findViewById(R.id.reGrace)
        private val chargeView: TextView = view.findViewById(R.id.reCharge)

        fun bind(item: RatingErrorItem) {
            postingNumber.text = item.postingNumber ?: "—"
            storeName.text = item.storeName ?: item.storeId ?: "—"
            errorAt.text = fmtTime(item.errorAt)

            // 配送方案
            val schema = item.deliverySchema ?: ""
            schemaTag.text = schema.ifEmpty { "—" }
            schemaTag.visibility = if (schema.isEmpty()) View.GONE else View.VISIBLE

            // 错误类型标签
            val type = item.postingErrorType ?: ""
            typeTag.text = typeLabel(type)
            typeTag.setRoundedBg(Color.parseColor(typeColor(type)), 4f)

            // 错误指数(Ozon 官方阈值: ≤4% 绿 ≤10% 青 ≤20% 黄 ≤40% 橙 >40% 红)
            val idx = item.index ?: 0.0
            indexView.text = "指数 ${String.format(Locale.US, "%.2f%%", idx * 100)}"
            indexView.setTextColor(Color.parseColor(indexColor(idx)))

            // 宽限状态
            val grace = item.hasGraceStatus == 1
            graceView.text = "宽限中"
            graceView.visibility = if (grace) View.VISIBLE else View.GONE

            // 错误处理费用
            val charge = item.chargePrice
            chargeView.text = if (charge != null && charge > 0) {
                val pct = if (item.chargePercent != null) " · ${fmtNum(item.chargePercent)}%" else ""
                "${fmtMoney(charge)}${pct}"
            } else {
                ""
            }
        }
    }
}

private fun typeLabel(type: String): String = when (type) {
    "SELLER_CANCELLATION" -> "卖家取消"
    "SELLER_DELAY" -> "卖家逾期"
    else -> type.ifEmpty { "—" }
}

private fun typeColor(type: String): String = when (type) {
    "SELLER_CANCELLATION" -> "#f53f3f"
    "SELLER_DELAY" -> "#d97706"
    else -> "#86909c"
}

private fun indexColor(index: Double): String = when {
    index <= 0.04 -> "#00a32e"
    index <= 0.10 -> "#009a9a"
    index <= 0.20 -> "#d99000"
    index <= 0.40 -> "#ee6a00"
    else -> "#e53414"
}